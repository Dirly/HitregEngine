import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { auditItemSkills, createSheet, addItem, equip, itemSchema, type CharacterSheet, type Item } from "@hitreg/core";
import { deriveLoadout, DRINKS } from "../../../apps/playground/projects/voxel-demo/scripts/lib/loadout.js";
import { ABILITIES } from "../../../apps/playground/projects/voxel-demo/scripts/lib/abilities.js";
import { GUARD_VERBS, HELD_VERBS, parseLoadout, serializeLoadout } from "../../../apps/playground/projects/voxel-demo/scripts/lib/combat-rules.js";

/**
 * voxel-demo's `deriveLoadout` (lib/loadout.ts), pure: the bar is built from
 * what the character wears (docs/combat-plan.md "The bar"), plus a check that
 * every item file's skills parse, fit their hands and name abilities that
 * exist. The game has no test runner of its own, so it lives here and imports
 * the game lib by path (projects/ is gitignored: on a clone without voxel-demo
 * this file fails to import).
 */

const ITEMS_DIR = fileURLToPath(new URL("../../../apps/playground/projects/voxel-demo/assets/items/", import.meta.url));
const items: Record<string, Item> = Object.fromEntries(
  readdirSync(ITEMS_DIR)
    .filter((f) => f.endsWith(".json"))
    .map((f) => [f.slice(0, -5), itemSchema.parse(JSON.parse(readFileSync(ITEMS_DIR + f, "utf8")))]),
);
const catalog = (id: string): Item | undefined => items[id];
const env = { catalog };

function wearing(...worn: Array<[string, Parameters<typeof equip>[2]]>): CharacterSheet {
  let sheet = createSheet();
  // strong enough for any item's stat requirement (package D3a)
  for (const k of Object.keys(sheet.attributes) as Array<keyof typeof sheet.attributes>) sheet.attributes[k] = 20;
  for (const [id, slot] of worn) {
    const r = addItem(sheet, id, 1, env);
    if (!r.ok) throw new Error(r.error);
    const e = equip(r.sheet, r.uids[0]!, slot, env);
    if (!e.ok) throw new Error(`${id}: ${e.error}`);
    sheet = e.sheet;
  }
  return sheet;
}

describe("item skills data", () => {
  it("parses, fits the hands, and names abilities that exist", () => {
    expect(auditItemSkills(items)).toEqual([]);
    const verbs = new Set<string>([...Object.values(GUARD_VERBS), ...Object.values(HELD_VERBS)]);
    const unknown: string[] = [];
    for (const [id, item] of Object.entries(items)) {
      const s = item.skills;
      if (!s) continue;
      for (const a of [s.primary, s.secondary, ...s.bar]) if (a && !verbs.has(a) && !ABILITIES[a]) unknown.push(`${id}: ${a}`);
      if (s.use && !DRINKS[s.use]) unknown.push(`${id}: use ${s.use}`);
    }
    expect(unknown).toEqual([]);
  });
});

describe("deriveLoadout", () => {
  it("sword and board: the sword's verbs, the shield's block and numbers, one skill from each hand", () => {
    const l = deriveLoadout({ sheet: wearing(["iron-arming-sword", "primary"], ["iron-tower", "offhand"]), catalog, set: 0, trait: "firebolt" });
    expect(l).toMatchObject({ set: 0, lmb: "strike", rmb: "@block", weapon1: "cleave", weapon2: "shieldBash", trait: "firebolt" });
    expect(l.guard).toEqual({ kind: "block", parryWindow: 0.1, blockPower: 0.9 });
  });

  it("a sword alone parries; a buckler and a tower shield differ", () => {
    expect(deriveLoadout({ sheet: wearing(["iron-arming-sword", "primary"]), catalog, set: 0, trait: "" }).guard.kind).toBe("parry");
    const round = deriveLoadout({ sheet: wearing(["iron-arming-sword", "primary"], ["iron-roundshield", "offhand"]), catalog, set: 0, trait: "" }).guard;
    const tower = deriveLoadout({ sheet: wearing(["iron-arming-sword", "primary"], ["iron-tower", "offhand"]), catalog, set: 0, trait: "" }).guard;
    expect(round.parryWindow!).toBeGreaterThan(tower.parryWindow!);
    expect(round.blockPower!).toBeLessThan(tower.blockPower!);
  });

  it("a two-hander gives both skills and ignores the off hand", () => {
    const l = deriveLoadout({ sheet: wearing(["iron-greatsword", "primary"], ["iron-tower", "offhand"]), catalog, set: 0, trait: "" });
    expect(l).toMatchObject({ rmb: "@parry", weapon1: "greatCleave", weapon2: "greatSweep" });
    expect(l.guard.kind).toBe("parry");
  });

  it("staffs: a self ward, an ally ward, each with ONE school and all different; an offensive one with no defence", () => {
    const self = deriveLoadout({ sheet: wearing(["training-staff", "primary"]), catalog, set: 0, trait: "" });
    expect(self.guard).toMatchObject({ kind: "ward", school: "holy", reward: "mana" });
    expect(self.guard.wardAlly).toBeUndefined();
    const ally = deriveLoadout({ sheet: wearing(["warden-staff", "primary"]), catalog, set: 0, trait: "" });
    expect(ally.guard).toMatchObject({ kind: "ward", wardAlly: true, school: "shadow" });
    const hedge = deriveLoadout({ sheet: wearing(["hedge-staff", "primary"]), catalog, set: 0, trait: "" });
    expect(hedge.guard).toMatchObject({ kind: "ward", school: "destruction", reward: "power" });
    const fire = deriveLoadout({ sheet: wearing(["cinder-staff", "primary"]), catalog, set: 0, trait: "" });
    expect(fire).toMatchObject({ rmb: "counterCast", guard: { kind: "none" } });
  });

  it("the secondary set is held alone; trinkets and the belt fill their slots", () => {
    const sheet = wearing(
      ["iron-arming-sword", "primary"],
      ["iron-tower", "offhand"],
      ["iron-greatsword", "secondary"],
      ["lucky-charm", "trinket"],
      ["frost-locket", "trinket2"],
      ["health-potion", "consumable3"],
    );
    const l = deriveLoadout({ sheet, catalog, set: 1, trait: "" });
    expect(l).toMatchObject({ set: 1, lmb: "strike", rmb: "@parry", weapon1: "greatCleave", weapon2: "greatSweep" });
    expect(l).toMatchObject({ trinket1: "radiantSeeker", trinket2: "frostNova", consumables: ["", "", "health-potion"] });
    expect(parseLoadout(serializeLoadout(l))).toMatchObject({ weapon1: "greatCleave", consumables: ["", "", "health-potion"] });
  });

  it("an empty character has an empty bar", () => {
    const l = deriveLoadout({ sheet: undefined, catalog, set: 0, trait: "" });
    expect(l).toMatchObject({ lmb: "", rmb: "", weapon1: "", weapon2: "", consumables: ["", "", ""], guard: { kind: "none" } });
  });
});

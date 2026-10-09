import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { addItem, createSheet, equip, itemSchema, type CharacterSheet, type Item } from "@hitreg/core";
import {
  BRACE,
  DOT,
  DOT_MAX_PER_SECOND,
  NO_FACTS,
  SELF_PAYOFF_KEYS,
  VENOM,
  evaluateSkill,
  payoffKey,
  type Condition,
  type HitFacts,
  type Payoff,
} from "../../../apps/playground/projects/foundation/scripts/lib/skills.js";
import { ABILITIES, auditAbilities, loadoutBindings, type Ability } from "../../../apps/playground/projects/foundation/scripts/lib/abilities.js";
import { EMPTY_LOADOUT, HELD_VERBS, STEADY, STEALTH, TELL_LEAD, guardAnswers, hitClassOf } from "../../../apps/playground/projects/foundation/scripts/lib/combat-rules.js";
import { deriveLoadout } from "../../../apps/playground/projects/foundation/scripts/lib/loadout.js";

/**
 * foundation package D2 (docs/combat-build/D2-stealth-bows-traits.md), pure:
 * the new payoffs (dot, stealth, vanish, brace, envenom), the opener, the
 * bow and crossbow verbs, the birth-trait abilities, the audit's new rules,
 * and the item and creation data. The socket half is d2-skills.test.ts.
 */

const game = path.resolve(__dirname, "../../../apps/playground/projects/foundation");
const facts = (on: Partial<HitFacts> = {}): HitFacts => ({ ...NO_FACTS, ...on });
const a = (id: string): Ability => ABILITIES[id]!;
const readItem = (id: string): Item => itemSchema.parse(JSON.parse(readFileSync(path.join(game, "assets/items", `${id}.json`), "utf8")));

describe("evaluateSkill: the D2 payoffs", () => {
  const one = (p: Payoff) => evaluateSkill({ payoffs: [p] }, facts());
  it("dot keeps the strongest poison; nothing poisons by default", () => {
    expect(evaluateSkill(undefined, facts()).dot).toBe(0);
    expect(evaluateSkill({ payoffs: [{ dot: 2 }, { dot: 5 }] }, facts()).dot).toBe(5);
  });
  it("stealth: none is null, 0 is at will and outlasts any timed one, else the longest", () => {
    expect(evaluateSkill(undefined, facts()).stealth).toBeNull();
    expect(one({ stealth: 5 }).stealth).toBe(5);
    expect(one({ stealth: 0 }).stealth).toBe(0);
    expect(evaluateSkill({ payoffs: [{ stealth: 5 }, { stealth: 15 }] }, facts()).stealth).toBe(15);
    expect(evaluateSkill({ payoffs: [{ stealth: 15 }, { stealth: 0 }] }, facts()).stealth).toBe(0);
  });
  it("vanish, brace and envenom keep the largest", () => {
    expect(evaluateSkill({ payoffs: [{ vanish: 10 }, { vanish: 15 }, { brace: 6 }, { brace: 2 }, { envenom: 12 }] }, facts())).toMatchObject({
      vanish: 15,
      brace: 6,
      envenom: 12,
    });
  });
  it("carried payoffs (an envenomed blade) apply whatever the skill, even with none", () => {
    expect(evaluateSkill(undefined, facts(), VENOM.carried).dot).toBe(3);
    expect(evaluateSkill(a("strike"), facts(), VENOM.carried).dot).toBe(3);
    expect(evaluateSkill(a("strike"), facts()).dot).toBe(0);
  });
  it("payoffKey knows every new key, and 0 seconds of stealth is valid", () => {
    for (const k of ["dot", "stealth", "vanish", "brace", "envenom"]) expect(payoffKey({ [k]: 1 })).toBe(k);
    expect(payoffKey({ stealth: 0 })).toBe("stealth");
    expect(payoffKey({ dot: -1 })).toBeNull();
  });
  it("the self payoffs are exactly the ones that go to the attacker", () => {
    // package D3a added haste (a sprint)
    expect([...SELF_PAYOFF_KEYS].sort()).toEqual(["brace", "envenom", "haste", "heal", "mana", "stamina", "stealth", "vanish"]);
  });
  it("first values", () => {
    expect(DOT).toEqual({ seconds: 6, interval: 1 });
    expect(BRACE.damageTaken).toBe(0.6);
    expect(STEALTH).toEqual({ notice: 0.3, speedMult: 0.6 });
    expect(STEADY).toEqual({ minHold: 1.0, damageMult: 1.6, speedMult: 0.5 });
  });
});

describe("the D2 abilities", () => {
  const ids = ["sneak", "sneakTimed", "hide", "ambush", "bowShot", "crossbowShot", "pinningShot", "markingShot", "heavyBolt", "ironhide", "bullrush", "aimedShot", "venomBlade"];
  it("all exist and the whole table passes the audit", () => {
    for (const id of ids) expect(a(id), id).toBeDefined();
    expect(auditAbilities()).toEqual([]);
  });
  it("stealth skills land on the caster, do no harm, and pay stealth", () => {
    for (const id of ["sneak", "sneakTimed", "hide"]) {
      expect(a(id).onSelf, id).toBe(true);
      expect(a(id).payload, id).toMatchObject({ damage: 0, control: 0 });
    }
    expect(evaluateSkill(a("sneak"), facts()).stealth).toBe(0);
    expect(a("sneak").toggle).toBe(true);
    expect(evaluateSkill(a("sneakTimed"), facts()).stealth).toBe(15);
    expect(a("sneakTimed").toggle).toBeUndefined();
    expect(evaluateSkill(a("hide"), facts())).toMatchObject({ vanish: 15, stealth: 5 });
    expect(a("hide").cooldown).toBeGreaterThan(a("sneakTimed").cooldown);
  });
  it("ambush: an ordinary heavy from the front; x2.5 and a stagger on an unaware target; a crit from behind as well", () => {
    expect(a("ambush")).toMatchObject({ kind: "physical", attackClass: "heavy" });
    expect(a("ambush").timing.windup).toBeGreaterThanOrEqual(TELL_LEAD.heavy);
    expect(evaluateSkill(a("ambush"), facts())).toMatchObject({ damageMult: 1, stagger: 0, crit: false });
    expect(evaluateSkill(a("ambush"), facts({ fromBehind: true }))).toMatchObject({ damageMult: 1, stagger: 0, crit: false });
    expect(evaluateSkill(a("ambush"), facts({ targetUnaware: true }))).toMatchObject({ damageMult: 2.5, stagger: 2.5, crit: false });
    expect(evaluateSkill(a("ambush"), facts({ targetUnaware: true, fromBehind: true }))).toMatchObject({ damageMult: 2.5, stagger: 2.5, crit: true });
  });
  it("every shot is a physical ranged hit: a shield's block answers it, a parry and a ward do not", () => {
    for (const id of ["bowShot", "crossbowShot", "pinningShot", "markingShot", "heavyBolt", "aimedShot"]) {
      const c = hitClassOf(a(id));
      expect(c, id).toEqual({ kind: "physical", attackClass: "ranged" });
      expect(a(id).timing.kind, id).toBe("projectile");
      expect(a(id).timing.windup, id).toBeGreaterThanOrEqual(TELL_LEAD.ranged);
      expect(guardAnswers("block", c.kind, c.attackClass)).toBe(1);
      expect(guardAnswers("parry", c.kind, c.attackClass)).toBe(0);
      expect(guardAnswers("ward", c.kind, c.attackClass)).toBe(0);
    }
    expect(evaluateSkill(a("pinningShot"), facts()).stagger).toBeGreaterThan(0);
    expect(evaluateSkill(a("markingShot"), facts()).mark).toBe(8);
  });
  it("the trait abilities: ironhide braces, bullrush lunges and staggers, aimed shot is slow and strong, venom blade envenoms", () => {
    expect(a("ironhide").onSelf).toBe(true);
    expect(evaluateSkill(a("ironhide"), facts()).brace).toBe(6);
    expect(a("bullrush").lunge?.distance).toBeGreaterThanOrEqual(4);
    expect(evaluateSkill(a("bullrush"), facts()).stagger).toBeGreaterThan(0);
    expect(a("aimedShot").timing.windup).toBeGreaterThan(a("bowShot").timing.windup);
    expect(a("aimedShot").payload.damage).toBeGreaterThan(a("bowShot").payload.damage);
    expect(a("venomBlade").onSelf).toBe(true);
    expect(evaluateSkill(a("venomBlade"), facts()).envenom).toBe(12);
  });
});

describe("auditAbilities: the D2 rules", () => {
  const audit = (x: Partial<Ability>, base = "sneakTimed") => auditAbilities({ x: { ...a(base), id: "x", ...x } }, {}).map((v) => v.rule);
  it("a skill that lands on its caster does no harm, judges no condition and pays only the attacker", () => {
    expect(audit({})).toEqual([]);
    expect(audit({ payload: { damage: 5, control: 0 } })).toContain("self");
    expect(audit({ when: [{ if: "fromBehind", then: [{ stamina: 5 }] }] })).toContain("self");
    expect(audit({ payoffs: [{ stealth: 5 }, { stagger: 1 }] })).toContain("self");
    expect(audit({ payoffs: [{ brace: 5 }, { mana: 5 }] })).toEqual([]);
  });
  it("a stealth skill does no damage, landing on yourself or not", () => {
    expect(audit({ onSelf: undefined, payload: { damage: 8, control: 0 } })).toContain("stealth");
    expect(audit({ onSelf: undefined, payoffs: [{ vanish: 10 }], payload: { damage: 0, control: 4 } })).toContain("stealth");
  });
  it("toggle is only an at-will stealth", () => {
    expect(audit({ toggle: true, payoffs: [{ stealth: 0 }] })).toEqual([]);
    expect(audit({ toggle: true })).toContain("toggle"); // stealth 15 is timed
    expect(audit({ toggle: true, payoffs: [{ brace: 5 }] })).toContain("toggle");
  });
  it("an opener is a heavy with at least the heavy tell", () => {
    expect(audit({}, "ambush")).toEqual([]);
    expect(audit({ attackClass: "light" }, "ambush")).toContain("opener");
    expect(audit({ timing: { ...a("ambush").timing, windup: 0.8 } }, "ambush")).toContain("opener");
    // a clause on an unaware target that pays no extra damage is no opener
    expect(audit({ attackClass: "light", when: [{ if: "targetUnaware" as Condition, then: [{ mark: 4 }] }] }, "ambush")).not.toContain("opener");
  });
  it("a poison is bounded", () => {
    expect(audit({ payoffs: [{ dot: DOT_MAX_PER_SECOND }] }, "strike")).toEqual([]);
    expect(audit({ payoffs: [{ dot: DOT_MAX_PER_SECOND + 1 }] }, "strike")).toContain("dot");
  });
});

describe("bows and crossbows on the bar", () => {
  const catalog = (id: string): Item | undefined => readItem(id);
  const env = { catalog };
  const holding = (id: string): CharacterSheet => {
    // strong enough for any item's stat requirement (package D3a)
    const sheet = createSheet();
    for (const k of Object.keys(sheet.attributes) as Array<keyof typeof sheet.attributes>) sheet.attributes[k] = 20;
    const r = addItem(sheet, id, 1, env);
    if (!r.ok) throw new Error(r.error);
    const e = equip(r.sheet, r.uids[0]!, "primary", env);
    if (!e.ok) throw new Error(e.error);
    return e.sheet;
  };
  it("a bow: shoot on left click, steady aim on right, two skills, and no guard", () => {
    const l = deriveLoadout({ sheet: holding("training-bow"), catalog, set: 0, trait: "" });
    expect(l).toMatchObject({ lmb: "bowShot", rmb: HELD_VERBS.steady, weapon1: "pinningShot", weapon2: "markingShot" });
    expect(l.guard.kind).toBe("none");
  });
  it("a crossbow: its own shot, the heavy bolt and the disengage (package D3a)", () => {
    const l = deriveLoadout({ sheet: holding("training-crossbow"), catalog, set: 0, trait: "" });
    expect(l).toMatchObject({ lmb: "crossbowShot", rmb: HELD_VERBS.steady, weapon1: "heavyBolt", weapon2: "disengage" });
  });
  it("right click binds the steady aim as a HOLD, not a cast or a guard", () => {
    const binds = loadoutBindings({ ...EMPTY_LOADOUT, lmb: "bowShot", rmb: HELD_VERBS.steady });
    expect(binds.find((b) => b.slot === "rmb")?.action).toEqual({ kind: "hold", verb: "steady" });
    expect(binds.find((b) => b.slot === "lmb")?.action).toEqual({ kind: "cast", abilityId: "bowShot", repeat: true });
  });
});

describe("the D2 items and the creation asset", () => {
  it("one greatsword carries the opener, in place of its sweep", () => {
    expect(readItem("steel-greatsword").skills?.bar).toEqual(["greatCleave", "ambush"]);
    // package D3a gave the other greatswords their own second skills
    expect(readItem("iron-greatsword").skills?.bar).toEqual(["greatCleave", "greatSweep"]);
  });
  it("the sneak and hide trinkets, with existing jewelry icons", () => {
    const want: Record<string, string> = { "footpads-cord": "sneakTimed", "smokeglass-ring": "hide" };
    for (const [id, skill] of Object.entries(want)) {
      const item = readItem(id);
      expect(item.skills?.bar, id).toEqual([skill]);
      expect(item.tags, id).toContain("jewelry");
      expect(() => readFileSync(path.join(game, "assets/textures", item.icon!)), id).not.toThrow();
    }
  });
  it("every birth trait names an ability that exists and binds on the trait key; Shadowborn sneaks at will", () => {
    const creation = JSON.parse(readFileSync(path.join(game, "assets/creation/mmo-creation.json"), "utf8")) as { traits: Array<{ id: string; ability: string }> };
    expect(creation.traits.length).toBeGreaterThanOrEqual(9);
    for (const t of creation.traits) {
      expect(ABILITIES[t.ability], `${t.id}: ${t.ability}`).toBeDefined();
      const bound = loadoutBindings({ ...EMPTY_LOADOUT, trait: t.ability }).find((b) => b.slot === "trait");
      expect(bound, t.id).toMatchObject({ code: "Digit7", action: { kind: "cast", abilityId: t.ability } });
    }
    expect(creation.traits.find((t) => t.id === "shadowborn")?.ability).toBe("sneak");
  });
});

import { describe, expect, it } from "vitest";
import {
  characterSheetSchema,
  createSheet,
  currentDurability,
  damagedItems,
  derivedStats,
  dialogueActionSchema,
  dialogueSchema,
  equip,
  addItem,
  isBoundAt,
  itemSchema,
  NetStateStore,
  PERSISTED_PLAYER_NAMESPACES,
  registerCharacterNetState,
  repairAll,
  repairCost,
  repairItem,
  soulBindSchema,
  testCondition,
  vaultDeposit,
  vaultSchema,
  vaultWithdraw,
  wearAmount,
  wearEquipped,
  type CharacterSheet,
  type DialogueFacts,
  type Item,
  type SheetEnv,
} from "../src/index.js";

const items: Record<string, Item> = {
  sword: itemSchema.parse({ name: "Sword", slots: ["primary"], value: 200, durability: 60, modifiers: { strength: 3, maxHp: 10 } }),
  helm: itemSchema.parse({ name: "Helm", slots: ["helm"], value: 100, durability: 45, modifiers: { armor: 4 } }),
  twig: itemSchema.parse({ name: "Twig", slots: ["offhand"], value: 3, durability: 5 }),
  ring: itemSchema.parse({ name: "Ring", slots: ["jewelry"], value: 500, modifiers: { wisdom: 2 } }), // never wears
  bread: itemSchema.parse({ name: "Bread", stack: 10, value: 5, kind: "consumable" }),
};
const env: SheetEnv = { catalog: (id) => items[id] };

/** A sheet wearing each of `worn` and carrying each of `carried`. */
function kitted(worn: string[], carried: string[] = [], coins = 0): CharacterSheet {
  let s: CharacterSheet = { ...createSheet(), coins };
  for (const id of [...worn, ...carried]) {
    const r = addItem(s, id, 1, env);
    if (!r.ok) throw new Error(r.error);
    s = r.sheet;
    if (worn.includes(id)) {
      const e = equip(s, r.uids[0]!, undefined, env);
      if (!e.ok) throw new Error(e.error);
      s = e.sheet;
    }
  }
  return s;
}
const uidOf = (s: CharacterSheet, itemId: string) => Object.entries(s.items).find(([, x]) => x.itemId === itemId)![0];
const setWear = (s: CharacterSheet, itemId: string, d: number): CharacterSheet => {
  const next = structuredClone(s);
  next.items[uidOf(s, itemId)]!.durability = d;
  return next;
};

describe("soul binding", () => {
  it("has a bindSoul action and a bound condition in the dialogue schema", () => {
    expect(dialogueActionSchema.parse({ do: "bindSoul" })).toEqual({ do: "bindSoul" });
    const d = dialogueSchema.parse({
      start: [{ if: { bound: true }, node: "rest" }, { node: "hi" }],
      nodes: { rest: { text: "Your soul already rests with the bell." }, hi: { text: "Bind?", choices: [{ text: "Bind me.", do: [{ do: "bindSoul" }] }] } },
    });
    expect(d.nodes.hi!.choices[0]!.do).toEqual([{ do: "bindSoul" }]);
  });

  it("`bound` holds only when the character's bind sits at THIS npc's bind point", () => {
    const base: DialogueFacts = { npcId: "binder", memory: null, journal: null, sheet: createSheet(), quest: () => undefined, metBefore: false, bindPoint: [10, 2, 10] };
    expect(testCondition({ bound: true }, base)).toBe(false);
    expect(testCondition({ bound: false }, base)).toBe(true);
    const here = { ...base, bind: { at: [10.4, 2, 9.8] as [number, number, number], name: "Brinehold" } };
    expect(testCondition({ bound: true }, here)).toBe(true);
    const elsewhere = { ...base, bind: { at: [300, 2, 10] as [number, number, number], name: "Farhold" } };
    expect(testCondition({ bound: true }, elsewhere)).toBe(false);
    expect(testCondition({ bound: false }, elsewhere)).toBe(true);
    // no bind point known: never "bound here"
    expect(isBoundAt(here.bind, null)).toBe(false);
  });

  it("is a persisted per-character record with a validated shape", () => {
    expect(PERSISTED_PLAYER_NAMESPACES).toContain("bind");
    const store = new NetStateStore();
    registerCharacterNetState(store);
    expect(store.set("bind/p1", { at: [1, 2, 3], name: "Brinehold" })).toBe(true);
    expect(store.set("bind/p1", { at: [1, 2], name: "x" })).toBe(false);
    expect(soulBindSchema.parse({ at: [0, 0, 0] }).name).toBe("");
  });
});

describe("durability: wear on death", () => {
  it("rounds 10% up with a minimum of 1", () => {
    expect(wearAmount(60)).toBe(6);
    expect(wearAmount(45)).toBe(5); // 4.5 -> 5
    expect(wearAmount(5)).toBe(1); // 0.5 -> 1
    expect(wearAmount(3)).toBe(1); // 0.3 -> min 1
    expect(wearAmount(100)).toBe(10);
  });

  it("wears worn items with durability; carried items and never-wearing items are untouched", () => {
    const s = kitted(["sword", "helm", "ring"], ["twig", "bread"]);
    const r = wearEquipped(s, env);
    const d = (id: string) => currentDurability(r.sheet.items[uidOf(r.sheet, id)]!, items[id]);
    expect(d("sword")).toBe(54);
    expect(d("helm")).toBe(40);
    expect(d("twig")).toBe(5); // carried
    expect(d("ring")).toBeNull(); // no durability
    expect(r.sheet.items[uidOf(r.sheet, "ring")]!.durability).toBeUndefined();
    expect(r.sheet.items[uidOf(r.sheet, "bread")]!.durability).toBeUndefined();
    expect(r.worn).toHaveLength(2);
    expect(s.items[uidOf(s, "sword")]!.durability).toBeUndefined(); // pure
  });

  it("breaks at 0 and never goes below it; a broken item stops wearing", () => {
    let s = setWear(kitted(["sword"]), "sword", 4);
    const r = wearEquipped(s, env);
    expect(r.sheet.items[uidOf(s, "sword")]!.durability).toBe(0);
    expect(r.broke).toEqual([uidOf(s, "sword")]);
    s = r.sheet;
    const again = wearEquipped(s, env);
    expect(again.sheet).toBe(s); // nothing left to wear
    expect(again.worn).toEqual([]);
  });

  it("loads old saves (no durability on stacks) as full", () => {
    const old = characterSheetSchema.parse({ items: { i1: { itemId: "sword", qty: 1 } }, equipment: { primary: "i1" } });
    expect(currentDurability(old.items.i1!, items.sword)).toBe(60);
    expect(damagedItems(old, env)).toEqual([]);
  });
});

describe("durability: broken items give no stats", () => {
  it("drops a broken item's modifiers from attributes and derived stats", () => {
    const s = kitted(["sword", "helm"]);
    const whole = derivedStats(s, env);
    const broken = derivedStats(setWear(s, "sword", 0), env);
    expect(whole.attributes.strength - broken.attributes.strength).toBe(3);
    // maxHp loses the flat +10 (and whatever strength fed the formula)
    expect(broken.stats.maxHp).toBeLessThanOrEqual(whole.stats.maxHp - 10);
    expect(broken.stats.armor).toBe(whole.stats.armor); // the helm still counts
    expect(broken.weight).toBe(whole.weight); // still worn, still weighs
    // one point left is still whole enough
    expect(derivedStats(setWear(s, "sword", 1), env).attributes.strength).toBe(whole.attributes.strength);
  });
});

describe("repair", () => {
  it("prices ceil(value × missing/max × rate), at least 1 for any damage", () => {
    expect(repairCost({}, items.sword)).toBe(0);
    expect(repairCost({ durability: 54 }, items.sword)).toBe(5); // 200 × 6/60 × 0.25
    expect(repairCost({ durability: 0 }, items.sword)).toBe(50);
    expect(repairCost({ durability: 0 }, items.sword, 1)).toBe(200);
    expect(repairCost({ durability: 4 }, items.twig)).toBe(1); // 3 × 1/5 × 0.25 = 0.15 -> min 1
    expect(repairCost({ durability: 0 }, items.ring)).toBe(0); // never wears
  });

  it("lists damaged worn and carried items, worn first", () => {
    let s = kitted(["helm"], ["sword"]);
    s = setWear(setWear(s, "sword", 30), "helm", 40);
    const list = damagedItems(s, env);
    expect(list.map((e) => [e.itemId, e.current, e.max, e.cost, e.worn])).toEqual([
      ["helm", 40, 45, 3, true], // 100 × 5/45 × .25 = 2.78 -> 3
      ["sword", 30, 60, 25, false],
    ]);
  });

  it("repairs one item, paying for it", () => {
    const s = setWear(kitted(["sword"], [], 100), "sword", 0);
    const r = repairItem(s, uidOf(s, "sword"), env);
    if (!r.ok) throw new Error(r.error);
    expect(r.cost).toBe(50);
    expect(r.sheet.coins).toBe(50);
    expect(r.sheet.items[uidOf(s, "sword")]!.durability).toBeUndefined();
    expect(repairItem(r.sheet, uidOf(s, "sword"), env)).toMatchObject({ ok: false, error: "Sword needs no repair" });
    expect(repairItem({ ...s, coins: 10 }, uidOf(s, "sword"), env)).toMatchObject({ ok: false });
  });

  it("repairs everything all-or-nothing", () => {
    let s = kitted(["sword", "helm"], [], 0);
    s = setWear(setWear(s, "sword", 0), "helm", 0); // 50 + 25 = 75
    const poor = repairAll({ ...s, coins: 74 }, env);
    expect(poor.ok).toBe(false);
    const r = repairAll({ ...s, coins: 80 }, env);
    if (!r.ok) throw new Error(r.error);
    expect(r.cost).toBe(75);
    expect(r.sheet.coins).toBe(5);
    expect(damagedItems(r.sheet, env)).toEqual([]);
    expect(repairAll(r.sheet, env)).toMatchObject({ ok: false, error: "nothing needs repair" });
    // a custom rate
    expect(repairAll({ ...s, coins: 1000 }, env, 1)).toMatchObject({ ok: true, cost: 300 });
  });

  it("keeps an instance's wear through the vault", () => {
    const s = setWear(kitted([], ["sword"]), "sword", 12);
    const dep = vaultDeposit(s, vaultSchema.parse({}), uidOf(s, "sword"), undefined, env);
    if (!dep.ok) throw new Error(dep.error);
    expect(dep.vault.items[0]).toMatchObject({ itemId: "sword", durability: 12 });
    const back = vaultWithdraw(dep.sheet, dep.vault, 0, undefined, env);
    if (!back.ok) throw new Error(back.error);
    expect(back.sheet.items[uidOf(back.sheet, "sword")]!.durability).toBe(12);
  });
});

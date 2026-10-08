import { describe, expect, it } from "vitest";
import {
  actionSeconds,
  auditItemSkills,
  skillAllowance,
  addItem,
  BELT_SLOTS,
  changesWornGear,
  createSheet,
  equip,
  handStateSchema,
  itemSchema,
  itemsInHand,
  NetStateStore,
  progressionSchema,
  readHand,
  registerCharacterNetState,
  useItem,
  type CharacterSheet,
  type Item,
  type SheetEnv,
} from "../src/index.js";

const items: Record<string, Item> = {
  sword: itemSchema.parse({
    name: "Sword",
    slots: ["primary", "secondary", "offhand"],
    skills: { primary: "strike", secondary: "@parry", bar: ["cleave"], guard: { kind: "parry", parryWindow: 0.25 } },
  }),
  shield: itemSchema.parse({
    name: "Shield",
    slots: ["offhand"],
    equipSeconds: 3,
    skills: { secondary: "@block", guard: { kind: "block", blockPower: 0.8 } },
  }),
  staff: itemSchema.parse({ name: "Staff", slots: ["primary", "secondary"], twoHanded: true, skills: { primary: "firebolt" } }),
  potion: itemSchema.parse({ name: "Potion", kind: "consumable", slots: ["consumable"], stack: 5, skills: { use: "drink" } }),
  bag: itemSchema.parse({ name: "Bag", slots: ["bag"], bag: { cols: 4, rows: 2 } }),
};
const progression = progressionSchema.parse({ inventoryDurations: { transfer: 1, equip: 1.5, unequip: 1.2 } });
const env: SheetEnv = { catalog: (id) => items[id], progression };

function sheetWith(...ids: Array<[string, number?]>): CharacterSheet {
  let sheet = createSheet(progression);
  for (const [id, qty] of ids) {
    const r = addItem(sheet, id, qty ?? 1, env);
    if (!r.ok) throw new Error(r.error);
    sheet = r.sheet;
  }
  return sheet;
}

describe("item skills", () => {
  it("parse optional, and old items without them still parse", () => {
    expect(items.sword!.skills?.guard).toEqual({ kind: "parry", parryWindow: 0.25 });
    expect(itemSchema.parse({ name: "Rock" }).skills).toBeUndefined();
    expect(itemSchema.parse({ name: "Rock" }).equipSeconds).toBeUndefined();
    expect(itemSchema.safeParse({ name: "Bad", skills: { guard: { kind: "dodge" } } }).success).toBe(false);
  });
});

describe("timed gear changes", () => {
  it("uses the item's equipSeconds, the progression otherwise, and the longer of a replacement", () => {
    let sheet = sheetWith(["sword"], ["shield"]);
    expect(actionSeconds(sheet, { kind: "equip", uid: "i1" }, env)).toBe(1.5);
    expect(actionSeconds(sheet, { kind: "equip", uid: "i2", slot: "offhand" }, env)).toBe(3);
    const worn = equip(sheet, "i2", "offhand", env);
    if (!worn.ok) throw new Error(worn.error);
    sheet = worn.sheet;
    // the sword into the shield's slot: max(1.5 on, 3 off)
    expect(actionSeconds(sheet, { kind: "equip", uid: "i1", slot: "offhand" }, env)).toBe(3);
    expect(actionSeconds(sheet, { kind: "unequip", uid: "i2", slot: "offhand" }, env)).toBe(3);
    expect(actionSeconds(sheet, { kind: "move", uid: "i2", to: { container: "pockets", x: 3, y: 1 } }, env)).toBe(3);
    // rearranging a grid is free
    expect(actionSeconds(sheet, { kind: "move", uid: "i1", to: { container: "pockets", x: 3, y: 1 } }, env)).toBe(0);
  });

  it("knows which requests change worn gear (what a combat lock forbids)", () => {
    const worn = equip(sheetWith(["sword"], ["potion", 3]), "i1", "primary", env);
    if (!worn.ok) throw new Error(worn.error);
    const sheet = worn.sheet;
    expect(changesWornGear(sheet, { kind: "equip", uid: "i2" })).toBe(true);
    expect(changesWornGear(sheet, { kind: "unequip", uid: "i1", slot: "primary" })).toBe(true);
    expect(changesWornGear(sheet, { kind: "drop", uid: "i1" })).toBe(true);
    expect(changesWornGear(sheet, { kind: "drop", uid: "i2" })).toBe(false);
    expect(changesWornGear(sheet, { kind: "move", uid: "i2", to: { container: "pockets", x: 3, y: 0 } })).toBe(false);
  });
});

describe("the belt", () => {
  it("has three slots that each take a whole stack", () => {
    expect(BELT_SLOTS).toEqual(["consumable", "consumable2", "consumable3"]);
    const sheet = sheetWith(["potion", 3]);
    const r = equip(sheet, "i1", "consumable3", env);
    expect(r.ok && r.sheet.items.i1!.qty).toBe(3);
  });

  it("uses one at a time on a shared cooldown, and empties the slot with the last", () => {
    let sheet = sheetWith(["potion", 2]);
    const worn = equip(sheet, "i1", "consumable2", env);
    if (!worn.ok) throw new Error(worn.error);
    sheet = worn.sheet;
    const first = useItem(sheet, "consumable2", env, { now: 1000, cooldownMs: 8000 });
    if (!first.ok) throw new Error(first.error);
    expect(first.skill).toBe("drink");
    expect(first.sheet.items.i1!.qty).toBe(1);
    expect(first.sheet.beltReadyAt).toBe(9000);
    const early = useItem(first.sheet, "consumable2", env, { now: 5000, cooldownMs: 8000 });
    expect(early.ok).toBe(false);
    const second = useItem(first.sheet, "consumable2", env, { now: 9000, cooldownMs: 8000 });
    if (!second.ok) throw new Error(second.error);
    expect(second.sheet.equipment.consumable2).toBeUndefined();
    expect(second.sheet.items.i1).toBeUndefined();
    expect(useItem(second.sheet, "consumable2", env, { now: 20000, cooldownMs: 8000 }).ok).toBe(false);
    expect(useItem(sheet, "primary", env, { now: 0, cooldownMs: 0 }).ok).toBe(false);
  });
});

describe("weapon sets", () => {
  it("reads absent or junk hand state as set 0", () => {
    const store = new NetStateStore();
    registerCharacterNetState(store);
    expect(readHand(store, "p")).toEqual({ set: 0 });
    expect(store.set("hand/p", { set: 1, swapTo: 0, swapFrom: 0, swapUntil: 800 })).toBe(true);
    expect(readHand(store, "p").swapTo).toBe(0);
    expect(store.set("hand/p", { set: 2 })).toBe(false);
    expect(handStateSchema.parse({})).toEqual({ set: 0 });
  });

  it("holds primary + offhand in set 0, the secondary alone in set 1, and nothing off-hand under a two-hander", () => {
    let sheet = sheetWith(["sword"], ["shield"], ["staff"]);
    for (const [uid, slot] of [["i1", "primary"], ["i2", "offhand"], ["i3", "secondary"]] as const) {
      const r = equip(sheet, uid, slot, env);
      if (!r.ok) throw new Error(r.error);
      sheet = r.sheet;
    }
    expect(itemsInHand(sheet, 0, env)).toMatchObject({ mainId: "sword", offId: "shield" });
    expect(itemsInHand(sheet, 1, env)).toMatchObject({ mainId: "staff", offId: null });
    const swapped = equip(sheet, "i3", "primary", env);
    if (!swapped.ok) throw new Error(swapped.error);
    expect(itemsInHand(swapped.sheet, 0, env)).toMatchObject({ mainId: "staff", offId: null });
  });
});

describe("skill allowance", () => {
  it("gives a two-hander two bar skills and anything else one, and reports files that declare more", () => {
    const greatsword = itemSchema.parse({ name: "Greatsword", slots: ["primary"], twoHanded: true, skills: { bar: ["a", "b"] } });
    const greedy = itemSchema.parse({ name: "Greedy", slots: ["primary"], skills: { bar: ["a", "b"] } });
    expect(skillAllowance(greatsword)).toBe(2);
    expect(skillAllowance(items.shield!)).toBe(1);
    expect(skillAllowance(items.potion!)).toBe(1);
    expect(auditItemSkills({ greatsword, greedy, sword: items.sword! })).toEqual([{ id: "greedy", declared: 2, allowed: 1 }]);
  });
});

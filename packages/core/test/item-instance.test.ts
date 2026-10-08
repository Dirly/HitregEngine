import { describe, expect, it } from "vitest";
import {
  addItem,
  canMerge,
  characterSheetSchema,
  createSheet,
  equip,
  freshShopState,
  groundItem,
  groundItemSchema,
  instanceOf,
  itemSchema,
  moveItem,
  pickUp,
  placeStack,
  removeItem,
  sameInstance,
  shopBuy,
  shopSchema,
  shopSell,
  shopStateSchema,
  splitStack,
  takeCarried,
  transferStack,
  unequip,
  vaultDeposit,
  vaultMove,
  vaultSchema,
  vaultWithdraw,
  type CharacterSheet,
  type Item,
  type SheetEnv,
} from "../src/index.js";

/**
 * Item instances survive every transfer (voxel-demo docs/combat-build/T-instance-transfer.md):
 * a stack's per-instance data (wear, rolled twists, any future field) travels
 * through every way an item changes hands or place, and only identical
 * instances ever merge.
 */

const items: Record<string, Item> = {
  staff: itemSchema.parse({ name: "Staff", slots: ["primary"], value: 200, kind: "equipment", tags: ["weapon"], durability: 50 }),
  arrow: itemSchema.parse({ name: "Arrow", stack: 20, value: 2, kind: "material", durability: 10 }),
  bread: itemSchema.parse({ name: "Bread", stack: 10, value: 5, kind: "consumable" }),
};
const env: SheetEnv = { catalog: (id) => items[id] };
const TWISTS = ["emberBolt+leech", "chainLightning+executioner"];

/** A sheet holding one twisted, worn staff; returns it and the staff's uid. */
function withStaff(sheet: CharacterSheet = createSheet()): { sheet: CharacterSheet; uid: string } {
  const r = placeStack(sheet, { itemId: "staff", qty: 1, durability: 31, twists: TWISTS }, env);
  if (!r.ok) throw new Error(r.error);
  return { sheet: r.sheet, uid: r.uids[0]! };
}
const full = (s: CharacterSheet): CharacterSheet => {
  let sheet = s;
  for (;;) {
    const r = addItem(sheet, "staff", 1, env);
    if (!r.ok) return sheet;
    sheet = r.sheet;
  }
};

describe("instance data", () => {
  it("is everything but what and where, deep-copied; empty means absent", () => {
    const stack = { itemId: "staff", qty: 1, container: "bag" as const, x: 1, y: 2, durability: 3, twists: ["a"] };
    const inst = instanceOf(stack);
    expect(inst).toEqual({ durability: 3, twists: ["a"] });
    inst.twists!.push("b");
    expect(stack.twists).toEqual(["a"]);
    expect(instanceOf({ itemId: "x", qty: 1, twists: [] })).toEqual({});
    expect(instanceOf(stack, { reset: ["durability"] })).toEqual({ twists: ["a"] });
  });

  it("compares by value, whatever the key order", () => {
    expect(sameInstance({ itemId: "a", qty: 1, durability: 2, twists: ["t"] }, { twists: ["t"], durability: 2, itemId: "a", qty: 9, x: 3 })).toBe(true);
    expect(sameInstance({ itemId: "a", qty: 1, twists: ["t"] }, { itemId: "a", qty: 1 })).toBe(false);
    expect(sameInstance({ itemId: "a", qty: 1, twists: [] }, { itemId: "a", qty: 1 })).toBe(true);
  });

  it("merges only identical instances of a stacking item", () => {
    expect(canMerge({ itemId: "arrow" }, { itemId: "arrow" }, 20)).toBe(true);
    expect(canMerge({ itemId: "arrow", durability: 4 } as never, { itemId: "arrow" }, 20)).toBe(false);
    expect(canMerge({ itemId: "staff" }, { itemId: "staff" }, 1)).toBe(false);
  });
});

describe("stacks: merge and split", () => {
  it("a worn instance never tops up a plain stack, and a plain grant never tops up a worn one", () => {
    let sheet = createSheet();
    const plain = addItem(sheet, "arrow", 5, env);
    if (!plain.ok) throw new Error(plain.error);
    const worn = placeStack(plain.sheet, { itemId: "arrow", qty: 5, durability: 4 }, env);
    if (!worn.ok) throw new Error(worn.error);
    expect(worn.uids[0]).not.toBe(plain.uids[0]);
    const more = addItem(worn.sheet, "arrow", 3, env);
    if (!more.ok) throw new Error(more.error);
    sheet = more.sheet;
    expect(sheet.items[plain.uids[0]!]!.qty).toBe(8);
    expect(sheet.items[worn.uids[0]!]).toMatchObject({ qty: 5, durability: 4 });
    // the same wear does merge
    const same = placeStack(sheet, { itemId: "arrow", qty: 2, durability: 4 }, env);
    if (!same.ok) throw new Error(same.error);
    expect(same.uids).toEqual([worn.uids[0]]);
    expect(same.sheet.items[worn.uids[0]!]!.qty).toBe(7);
  });

  it("dragging one instance onto a different one swaps them instead of merging", () => {
    const a = addItem(createSheet(), "arrow", 5, env);
    if (!a.ok) throw new Error(a.error);
    const b = placeStack(a.sheet, { itemId: "arrow", qty: 5, durability: 4 }, env);
    if (!b.ok) throw new Error(b.error);
    const target = b.sheet.items[a.uids[0]!]!;
    const moved = moveItem(b.sheet, b.uids[0]!, { container: target.container!, x: target.x!, y: target.y! }, env);
    if (!moved.ok) throw new Error(moved.error);
    expect(moved.sheet.items[b.uids[0]!]).toMatchObject({ qty: 5, durability: 4, x: target.x, y: target.y });
    expect(moved.sheet.items[a.uids[0]!]!.qty).toBe(5);
  });

  it("splitting keeps the instance data on both halves", () => {
    const b = placeStack(createSheet(), { itemId: "arrow", qty: 6, durability: 4 }, env);
    if (!b.ok) throw new Error(b.error);
    const s = splitStack(b.sheet, b.uids[0]!, 2, { container: "pockets", x: 3, y: 0 }, env);
    if (!s.ok) throw new Error(s.error);
    expect(s.sheet.items[s.uid]).toMatchObject({ qty: 2, durability: 4 });
    expect(s.sheet.items[b.uids[0]!]).toMatchObject({ qty: 4, durability: 4 });
  });

  it("equip and unequip keep the instance", () => {
    const { sheet, uid } = withStaff();
    const on = equip(sheet, uid, "primary", env);
    if (!on.ok) throw new Error(on.error);
    expect(on.sheet.items[uid]).toMatchObject({ durability: 31, twists: TWISTS });
    const off = unequip(on.sheet, "primary", undefined, env);
    if (!off.ok) throw new Error(off.error);
    expect(off.sheet.items[uid]).toMatchObject({ durability: 31, twists: TWISTS });
  });

  it("a hand-in takes a plain copy before a twisted one", () => {
    const { sheet, uid } = withStaff();
    const plain = addItem(sheet, "staff", 1, env);
    if (!plain.ok) throw new Error(plain.error);
    const r = takeCarried(plain.sheet, "staff", 1, env);
    if (!r.ok) throw new Error(r.error);
    expect(r.sheet.items[uid]).toMatchObject({ twists: TWISTS });
    expect(r.sheet.items[plain.uids[0]!]).toBeUndefined();
  });

  it("removeItem hands back the instance with the stack", () => {
    const { sheet, uid } = withStaff();
    const r = removeItem(sheet, uid, undefined, env);
    if (!r.ok) throw new Error(r.error);
    expect(r.removed).toEqual({ itemId: "staff", qty: 1, durability: 31, twists: TWISTS });
  });

  it("old saved sheets without instance fields still load", () => {
    const old = { version: 1, level: 3, items: { i1: { itemId: "staff", qty: 1, container: "bag", x: 0, y: 0 } } };
    expect(characterSheetSchema.safeParse(old).success).toBe(true);
  });
});

describe("the ground", () => {
  it("a dropped stack lies with its data and comes back the same to whoever picks it up", () => {
    const { sheet, uid } = withStaff();
    const r = removeItem(sheet, uid, undefined, env);
    if (!r.ok) throw new Error(r.error);
    const g = groundItemSchema.parse(groundItem(r.removed, [1, 2, 3], "player:a", 5000));
    expect(g).toMatchObject({ itemId: "staff", durability: 31, twists: TWISTS, at: [1, 2, 3], by: "player:a", until: 5000 });
    const other = pickUp(createSheet(), g, env);
    if (!other.ok) throw new Error(other.error);
    expect(other.left).toBeNull();
    expect(other.sheet.items[other.uids[0]!]).toMatchObject({ itemId: "staff", durability: 31, twists: TWISTS });
  });

  it("what does not fit stays on the ground", () => {
    const g = groundItem({ itemId: "staff", qty: 1, twists: TWISTS }, [0, 0, 0], "x");
    const r = pickUp(full(createSheet()), g, env);
    expect(r.ok).toBe(false);
  });
});

describe("shops: the buy-back shelf", () => {
  const shop = shopSchema.parse({ name: "Stall", buyRate: 0.5, buys: ["weapon"], stock: [{ itemId: "bread" }], resale: 4 });

  it("keeps a sold instance whole and the buyer gets it intact", () => {
    const { sheet, uid } = withStaff({ ...createSheet(), coins: 0 });
    const sold = shopSell(sheet, freshShopState(shop), shop, uid, undefined, env);
    if (!sold.ok) throw new Error(sold.error);
    expect(sold.state.resale).toEqual([{ itemId: "staff", qty: 1, durability: 31, twists: TWISTS }]);
    expect(shopStateSchema.parse(sold.state).resale[0]).toMatchObject({ twists: TWISTS });
    const bought = shopBuy({ ...createSheet(), coins: 1000 }, sold.state, shop, "staff", 1, env);
    if (!bought.ok) throw new Error(bought.error);
    expect(Object.values(bought.sheet.items)[0]).toMatchObject({ itemId: "staff", durability: 31, twists: TWISTS });
    expect(bought.state.resale).toEqual([]);
  });

  it("two different instances are two entries, and `resale` buys the one named", () => {
    let state = freshShopState(shop);
    const one = withStaff({ ...createSheet(), coins: 0 });
    const a = shopSell(one.sheet, state, shop, one.uid, undefined, env);
    if (!a.ok) throw new Error(a.error);
    const plain = addItem(a.sheet, "staff", 1, env);
    if (!plain.ok) throw new Error(plain.error);
    const b = shopSell(plain.sheet, a.state, shop, plain.uids[0]!, undefined, env);
    if (!b.ok) throw new Error(b.error);
    state = b.state;
    expect(state.resale).toHaveLength(2);
    const bought = shopBuy({ ...createSheet(), coins: 1000 }, state, shop, "staff", 1, env, 0);
    if (!bought.ok) throw new Error(bought.error);
    expect(Object.values(bought.sheet.items)[0]).toMatchObject({ twists: TWISTS });
    expect(bought.state.resale).toEqual([{ itemId: "staff", qty: 1 }]);
    expect(shopBuy({ ...createSheet(), coins: 1000 }, state, shop, "bread", 1, env, 0)).toMatchObject({ ok: false });
  });

  it("old shop states (entries without instance data) still load", () => {
    expect(shopStateSchema.safeParse({ stock: {}, resale: [{ itemId: "bread", qty: 2 }] }).success).toBe(true);
  });
});

describe("the vault", () => {
  it("never merges a worn stack into a plain one, either way", () => {
    const plain = addItem(createSheet(), "arrow", 5, env);
    if (!plain.ok) throw new Error(plain.error);
    let vault = vaultSchema.parse({});
    const d1 = vaultDeposit(plain.sheet, vault, plain.uids[0]!, undefined, env);
    if (!d1.ok) throw new Error(d1.error);
    const worn = placeStack(d1.sheet, { itemId: "arrow", qty: 5, durability: 4 }, env);
    if (!worn.ok) throw new Error(worn.error);
    const d2 = vaultDeposit(worn.sheet, d1.vault, worn.uids[0]!, undefined, env);
    if (!d2.ok) throw new Error(d2.error);
    vault = d2.vault;
    expect(vault.items).toEqual([{ itemId: "arrow", qty: 5 }, { itemId: "arrow", qty: 5, durability: 4 }]);
    // drag onto each other: a swap, not a merge
    const m = vaultMove(vault, 1, 0, env);
    if (!m.ok) throw new Error(m.error);
    expect(m.vault.items[0]).toMatchObject({ durability: 4, qty: 5 });
    // withdrawing the worn one beside a plain carried stack keeps them apart
    const back = addItem(d2.sheet, "arrow", 2, env);
    if (!back.ok) throw new Error(back.error);
    const w = vaultWithdraw(back.sheet, vault, 1, undefined, env);
    if (!w.ok) throw new Error(w.error);
    const arrows = Object.values(w.sheet.items).filter((s) => s.itemId === "arrow");
    expect(arrows.map((s) => [s.qty, s.durability])).toEqual([[2, undefined], [5, 4]]);
  });

  it("a twisted, worn staff goes in and comes out the same", () => {
    const { sheet, uid } = withStaff();
    const d = vaultDeposit(sheet, vaultSchema.parse({}), uid, undefined, env);
    if (!d.ok) throw new Error(d.error);
    const w = vaultWithdraw(d.sheet, d.vault, 0, undefined, env);
    if (!w.ok) throw new Error(w.error);
    expect(Object.values(w.sheet.items)[0]).toMatchObject({ itemId: "staff", durability: 31, twists: TWISTS });
  });
});

describe("character to character", () => {
  it("moves a stack with its data, atomically", () => {
    const { sheet, uid } = withStaff();
    const r = transferStack(sheet, createSheet(), uid, undefined, env);
    if (!r.ok) throw new Error(r.error);
    expect(r.from.items[uid]).toBeUndefined();
    expect(r.to.items[r.uids[0]!]).toMatchObject({ itemId: "staff", durability: 31, twists: TWISTS });
    expect(r.moved).toEqual({ itemId: "staff", qty: 1, durability: 31, twists: TWISTS });
  });

  it("refuses when the receiver has no room, and changes neither sheet", () => {
    const { sheet, uid } = withStaff();
    const receiver = full(createSheet());
    const r = transferStack(sheet, receiver, uid, undefined, env);
    expect(r).toEqual({ ok: false, error: "no room in their bags" });
  });

  it("refuses a worn item unless the caller allows it (looting a body)", () => {
    const { sheet, uid } = withStaff();
    const on = equip(sheet, uid, "primary", env);
    if (!on.ok) throw new Error(on.error);
    expect(transferStack(on.sheet, createSheet(), uid, undefined, env)).toEqual({ ok: false, error: "take it off first" });
    const looted = transferStack(on.sheet, createSheet(), uid, undefined, env, { allowWorn: true });
    if (!looted.ok) throw new Error(looted.error);
    expect(looted.from.equipment.primary).toBeUndefined();
    expect(looted.to.items[looted.uids[0]!]).toMatchObject({ twists: TWISTS, durability: 31 });
  });

  it("drops only the fields the game marks resettable", () => {
    const { sheet, uid } = withStaff();
    const r = transferStack(sheet, createSheet(), uid, undefined, env, { reset: ["durability"] });
    if (!r.ok) throw new Error(r.error);
    expect(r.to.items[r.uids[0]!]).toEqual(expect.objectContaining({ twists: TWISTS }));
    expect(r.to.items[r.uids[0]!]!.durability).toBeUndefined();
  });
});

import { describe, expect, it } from "vitest";
import {
  addItem,
  allocate,
  characterSheetSchema,
  createSheet,
  derivedStats,
  DEFAULT_PROGRESSION,
  equip,
  gridOf,
  grantXp,
  itemSchema,
  levelForXp,
  moveItem,
  NetStateStore,
  progressionSchema,
  registerCharacterNetState,
  removeItem,
  slotKind,
  splitStack,
  unequip,
  xpForLevel,
  xpToNext,
  type CharacterSheet,
  type Item,
  type ItemInput,
  type SheetEnv,
} from "../src/index.js";

const ITEMS: Record<string, ItemInput> = {
  helm: { name: "Iron Helm", slots: ["helm"], weight: 2, modifiers: { armor: 5, constitution: 2 } },
  sword: { name: "Sword", slots: ["primary", "secondary"], weight: 3 },
  dagger: { name: "Dagger", slots: ["primary", "secondary"], weight: 1 },
  ring: { name: "Ring", slots: ["jewelry"], weight: 0.1, requires: { level: 3 } },
  charm: { name: "Charm", slots: ["trinket"], weight: 0.1 },
  potion: { name: "Potion", stack: 5, weight: 0.5, kind: "consumable" },
  satchel: { name: "Satchel", slots: ["bag"], weight: 1, bag: { cols: 6, rows: 4 } },
  crate: { name: "Crate", slots: ["bag"], weight: 4, bag: { cols: 3, rows: 3 } },
};
const parsed = Object.fromEntries(Object.entries(ITEMS).map(([id, doc]) => [id, itemSchema.parse(doc)])) as Record<
  string,
  Item
>;
const env: SheetEnv = { catalog: (id) => parsed[id], progression: DEFAULT_PROGRESSION };

function must<T extends { ok: boolean }>(r: T): Extract<T, { ok: true }> {
  if (!r.ok) throw new Error((r as unknown as { error: string }).error);
  return r as Extract<T, { ok: true }>;
}

describe("progression curve", () => {
  it("defaults to 20 levels, 100 xp growing 1.25× per level, one point a level", () => {
    expect(DEFAULT_PROGRESSION.maxLevel).toBe(20);
    expect(DEFAULT_PROGRESSION.pointsPerLevel).toBe(1);
    expect(xpToNext(1)).toBe(100);
    expect(xpToNext(2)).toBe(125);
    expect(xpForLevel(1)).toBe(0);
    expect(xpForLevel(3)).toBe(225);
    expect(levelForXp(99)).toBe(1);
    expect(levelForXp(100)).toBe(2);
    expect(levelForXp(1e9)).toBe(20);
  });

  it("a partial progression file fills in every default (prefault, not default)", () => {
    const p = progressionSchema.parse({ maxLevel: 5, derived: { maxHp: { base: 50 } } });
    expect(p.baseAttributes.strength).toBe(10);
    expect(p.pockets).toEqual({ cols: 4, rows: 2 });
    expect(p.derived.maxHp).toEqual({ base: 50 });
    expect(p.derived.maxMana.intelligence).toBe(8);
  });
});

describe("levels and attributes", () => {
  it("starts at level 1 with base attributes and no points", () => {
    const s = createSheet();
    expect(s.level).toBe(1);
    expect(s.unspent).toBe(0);
    expect(s.attributes).toEqual({ strength: 10, dexterity: 10, constitution: 10, intelligence: 10, wisdom: 10 });
  });

  it("a higher starting level carries its points", () => {
    const s = createSheet(DEFAULT_PROGRESSION, 5);
    expect(s.level).toBe(5);
    expect(s.xp).toBe(xpForLevel(5));
    expect(s.unspent).toBe(4);
  });

  it("xp rolls levels over and grants points; allocation spends them one at a time", () => {
    let s = createSheet();
    const r = must(grantXp(s, 230, env));
    expect(r.levelsGained).toBe(2);
    s = r.sheet;
    expect(s.level).toBe(3);
    expect(s.unspent).toBe(2);
    s = must(allocate(s, "strength", env)).sheet;
    s = must(allocate(s, "wisdom", env)).sheet;
    expect(s.attributes.strength).toBe(11);
    expect(s.attributes.wisdom).toBe(11);
    expect(allocate(s, "strength", env)).toMatchObject({ ok: false, error: /no unspent/ });
    expect(grantXp(s, -5, env).ok).toBe(false);
  });

  it("stops granting at the cap but keeps the xp", () => {
    const s = must(grantXp(createSheet(), 1e9, env)).sheet;
    expect(s.level).toBe(20);
    expect(s.unspent).toBe(19);
    expect(s.xp).toBe(1e9);
  });
});

describe("grid inventory (one cell per stack)", () => {
  it("adds items first-fit into the pockets and stacks consumables", () => {
    let s = createSheet();
    s = must(addItem(s, "dagger", 1, env)).sheet;
    s = must(addItem(s, "potion", 7, env)).sheet;
    const stacks = Object.values(s.items);
    expect(stacks.find((x) => x.itemId === "dagger")).toMatchObject({ container: "pockets", x: 0, y: 0 });
    const potions = stacks.filter((x) => x.itemId === "potion");
    expect(potions.map((x) => x.qty).sort()).toEqual([2, 5]);
    expect(potions.map((x) => `${x.x},${x.y}`).sort()).toEqual(["1,0", "2,0"]);
    // top-ups fill the partial stack before opening a new one
    s = must(addItem(s, "potion", 2, env)).sheet;
    expect(Object.values(s.items).filter((x) => x.itemId === "potion").map((x) => x.qty).sort()).toEqual([4, 5]);
  });

  it("reports partial placement and refuses when nothing fits", () => {
    let s = createSheet(); // 4x2 pockets = 8 cells
    const r = must(addItem(s, "helm", 10, env));
    expect(r.placed).toBe(8);
    s = r.sheet;
    expect(addItem(s, "potion", 1, env)).toMatchObject({ ok: false, error: /no room/ });
  });

  it("moves, merges, swaps and refuses out-of-bounds", () => {
    let s = createSheet();
    s = must(addItem(s, "potion", 5, env)).sheet; // i1 at 0,0
    s = must(addItem(s, "potion", 3, env)).sheet; // i2 at 1,0
    s = must(addItem(s, "dagger", 1, env)).sheet; // i3 at 2,0
    s = must(moveItem(s, "i2", { container: "pockets", x: 3, y: 1 }, env)).sheet;
    expect(s.items["i2"]).toMatchObject({ x: 3, y: 1 });
    expect(moveItem(s, "i2", { container: "pockets", x: 4, y: 0 }, env)).toMatchObject({ ok: false, error: /outside/ });
    expect(moveItem(s, "i2", { container: "bag", x: 0, y: 0 }, env)).toMatchObject({ ok: false, error: /no bag/ });
    // merge: a partial stack dropped on a fuller one moves what fits
    s = must(removeItem(s, "i1", 3, env)).sheet; // i1 = 2
    s = must(moveItem(s, "i2", { container: "pockets", x: 0, y: 0 }, env)).sheet;
    expect(s.items["i1"]!.qty).toBe(5);
    expect(s.items["i2"]).toBeUndefined();
    // swap: potion onto the dagger — they trade cells
    s = must(moveItem(s, "i1", { container: "pockets", x: 2, y: 0 }, env)).sheet;
    expect(s.items["i1"]).toMatchObject({ x: 2, y: 0 });
    expect(s.items["i3"]).toMatchObject({ x: 0, y: 0 });
  });

  it("splits a stack into a free cell and refuses bad amounts", () => {
    let s = createSheet();
    s = must(addItem(s, "potion", 5, env)).sheet;
    const r = must(splitStack(s, "i1", 2, { container: "pockets", x: 3, y: 1 }, env));
    s = r.sheet;
    expect(s.items["i1"]!.qty).toBe(3);
    expect(s.items[r.uid]).toMatchObject({ qty: 2, x: 3, y: 1 });
    expect(splitStack(s, "i1", 3, { container: "pockets", x: 1, y: 0 }, env).ok).toBe(false);
    expect(splitStack(s, "i1", 1, { container: "pockets", x: 3, y: 1 }, env)).toMatchObject({ ok: false, error: /taken/ });
  });
});

describe("equipment", () => {
  it("wears an item, frees its cell, and derived stats pick up the modifiers", () => {
    let s = createSheet();
    s = must(addItem(s, "helm", 1, env)).sheet;
    const before = derivedStats(s, env);
    expect(before.stats.maxHp).toBe(200);
    expect(before.stats.armor).toBe(0);
    s = must(equip(s, "i1", undefined, env)).sheet;
    expect(s.equipment.helm).toBe("i1");
    expect(s.items["i1"]!.container).toBeUndefined();
    const after = derivedStats(s, env);
    expect(after.attributes.constitution).toBe(12);
    expect(after.stats.maxHp).toBe(220);
    expect(after.stats.armor).toBe(5);
    expect(after.weight).toBe(2); // worn items still weigh
    expect(after.stats.capacity).toBe(40);
    expect(after.encumbrance).toBeCloseTo(0.05);
    expect(after.grids.bag).toBeNull();
    // the cell is free again
    s = must(addItem(s, "helm", 1, env)).sheet;
    expect(s.items["i2"]).toMatchObject({ x: 0, y: 0 });
  });

  it("picks the first empty accepting slot, then displaces the occupant back into the grid", () => {
    let s = createSheet();
    s = must(addItem(s, "dagger", 1, env)).sheet; // i1
    s = must(addItem(s, "dagger", 1, env)).sheet; // i2
    s = must(equip(s, "i1", undefined, env)).sheet;
    s = must(equip(s, "i2", undefined, env)).sheet;
    expect(s.equipment.primary).toBe("i1");
    expect(s.equipment.secondary).toBe("i2");
    s = must(addItem(s, "dagger", 1, env)).sheet; // i3
    s = must(equip(s, "i3", undefined, env)).sheet;
    expect(s.equipment.primary).toBe("i3");
    expect(s.items["i1"]).toMatchObject({ container: "pockets", x: 0, y: 0 });
  });

  it("two trinket slots accept the same kind of item", () => {
    expect(slotKind("trinket2")).toBe("trinket");
    let s = createSheet();
    s = must(addItem(s, "charm", 1, env)).sheet;
    s = must(addItem(s, "charm", 1, env)).sheet;
    s = must(equip(s, "i1", undefined, env)).sheet;
    s = must(equip(s, "i2", undefined, env)).sheet;
    expect(s.equipment.trinket).toBe("i1");
    expect(s.equipment.trinket2).toBe("i2");
    expect(equip(s, "i1", "jewelry", env)).toMatchObject({ ok: false, error: /does not go/ });
    // a worn trinket can hop to the other trinket slot, swapping
    s = must(equip(s, "i1", "trinket2", env)).sheet;
    expect(s.equipment.trinket2).toBe("i1");
    expect(s.equipment.trinket).toBe("i2");
  });

  it("a swap puts the displaced item where the new one came from", () => {
    let s = createSheet();
    s = must(addItem(s, "dagger", 1, env)).sheet; // i1 at 0,0
    s = must(equip(s, "i1", "primary", env)).sheet;
    s = must(addItem(s, "dagger", 1, env)).sheet; // i2 at 0,0
    s = must(equip(s, "i2", "primary", env)).sheet;
    expect(s.equipment.primary).toBe("i2");
    expect(s.items["i1"]).toMatchObject({ container: "pockets", x: 0, y: 0 });
    // worn → other slot
    s = must(equip(s, "i2", "secondary", env)).sheet;
    expect(s.equipment.primary).toBeUndefined();
    expect(s.equipment.secondary).toBe("i2");
    expect(equip(s, "i2", "helm", env)).toMatchObject({ ok: false, error: /does not go/ });
  });

  it("enforces requirements and refuses stacks", () => {
    let s = createSheet();
    s = must(addItem(s, "ring", 1, env)).sheet;
    expect(equip(s, "i1", undefined, env)).toMatchObject({ ok: false, error: /needs level 3/ });
    s = must(grantXp(s, 300, env)).sheet;
    expect(equip(s, "i1", undefined, env).ok).toBe(true);
    s = must(addItem(s, "potion", 2, env)).sheet;
    expect(equip(s, "i2", undefined, env)).toMatchObject({ ok: false, error: /cannot be worn/ });
  });

  it("unequips into a chosen cell or the first free one", () => {
    let s = createSheet();
    s = must(addItem(s, "helm", 1, env)).sheet;
    s = must(equip(s, "i1", undefined, env)).sheet;
    expect(unequip(s, "helm", { container: "pockets", x: 4, y: 0 }, env).ok).toBe(false);
    s = must(unequip(s, "helm", { container: "pockets", x: 2, y: 0 }, env)).sheet;
    expect(s.equipment.helm).toBeUndefined();
    expect(s.items["i1"]).toMatchObject({ container: "pockets", x: 2, y: 0 });
    expect(unequip(s, "helm", undefined, env)).toMatchObject({ ok: false, error: /nothing is worn/ });
  });
});

describe("bags", () => {
  function withSatchel(): CharacterSheet {
    let s = createSheet();
    s = must(addItem(s, "satchel", 1, env)).sheet;
    return must(equip(s, "i1", undefined, env)).sheet;
  }

  it("a worn bag opens a grid that fills before the pockets", () => {
    let s = withSatchel();
    expect(gridOf(s, "bag", env)).toEqual({ cols: 6, rows: 4 });
    expect(derivedStats(s, env).grids.bag).toEqual({ cols: 6, rows: 4 });
    s = must(addItem(s, "sword", 1, env)).sheet;
    expect(s.items["i2"]).toMatchObject({ container: "bag", x: 0, y: 0 });
  });

  it("a bag with anything in it cannot be removed, swapped or dropped", () => {
    let s = withSatchel();
    s = must(addItem(s, "potion", 1, env)).sheet; // lands in the bag
    expect(unequip(s, "bag", undefined, env)).toMatchObject({ ok: false, error: /empty the bag/ });
    expect(removeItem(s, "i1", undefined, env)).toMatchObject({ ok: false, error: /empty the bag/ });
    s = must(addItem(s, "crate", 1, env)).sheet; // i3, in the bag too
    expect(equip(s, "i3", undefined, env)).toMatchObject({ ok: false, error: /empty the bag/ });
    // move the potion and the crate to the pockets: now the swap works
    s = must(moveItem(s, "i2", { container: "pockets", x: 0, y: 0 }, env)).sheet;
    s = must(moveItem(s, "i3", { container: "pockets", x: 1, y: 0 }, env)).sheet;
    s = must(equip(s, "i3", undefined, env)).sheet;
    expect(s.equipment.bag).toBe("i3");
    expect(gridOf(s, "bag", env)).toEqual({ cols: 3, rows: 3 });
    // the satchel came off into the pockets — never into the bag that replaced it
    expect(s.items["i1"]).toMatchObject({ container: "pockets" });
  });

  it("taking the bag off leaves the pockets as the only grid", () => {
    let s = withSatchel();
    s = must(unequip(s, "bag", undefined, env)).sheet;
    expect(gridOf(s, "bag", env)).toBeNull();
    expect(s.items["i1"]).toMatchObject({ container: "pockets", x: 0, y: 0 });
    expect(unequip(s, "bag", { container: "bag", x: 0, y: 0 }, env).ok).toBe(false);
  });
});

describe("sheet as a document", () => {
  it("round-trips through JSON and validates in the character netState namespace", () => {
    let s = createSheet();
    s = must(addItem(s, "satchel", 1, env)).sheet;
    s = must(equip(s, "i1", undefined, env)).sheet;
    s = must(addItem(s, "potion", 3, env)).sheet;
    const again = characterSheetSchema.parse(JSON.parse(JSON.stringify(s)));
    expect(again).toEqual(s);
    const store = new NetStateStore();
    registerCharacterNetState(store);
    expect(store.set("character/player", s)).toBe(true);
    expect(store.set("character/player", { level: "nope" })).toBe(false);
    expect(Object.keys(store.jsonSchemas())).toContain("character");
  });

  it("an item file with a size field is simply ignored — every stack is one cell", () => {
    const item = itemSchema.parse({ name: "Old", size: [2, 3] } as ItemInput);
    expect("size" in item).toBe(false);
  });
});

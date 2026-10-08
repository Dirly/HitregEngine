import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  createSheet,
  itemSchema,
  lootBag,
  NetStateStore,
  placeStack,
  registerCharacterNetState,
  roomFor,
  takeFromBag,
  takeBagCoins,
  transferStack,
  instanceOf,
  resolveRoll,
  rollAnswered,
  packSavedBags,
  unpackSavedBags,
  isLootLocked,
  attuneSoulSlots,
  corpseContents,
  derivedStats,
  equip,
  freshShopState,
  isPlundered,
  releaseCorpse,
  shopBuy,
  shopSell,
  shopSchema,
  soulProtected,
  soulStatus,
  takeEntrusted,
  vaultDeposit,
  vaultSchema,
  type CharacterSheet,
  type Item,
  type LootBag,
  type LootRoll,
} from "../src/index.js";

// package L: loot bags (core loot.ts) and owner-only netState
const ITEMS: Record<string, Item> = {
  staff: itemSchema.parse({ name: "Staff", kind: "equipment", slots: ["primary"], stack: 1, durability: 60, value: 400 }),
  potion: itemSchema.parse({ name: "Potion", kind: "consumable", stack: 5, value: 10 }),
  helm: itemSchema.parse({ name: "Helm", kind: "equipment", slots: ["helm"], stack: 1, durability: 40, value: 300, modifiers: { armor: 5 } }),
  cap: itemSchema.parse({ name: "Cap", kind: "equipment", slots: ["helm"], stack: 1, value: 20 }),
  parcel: itemSchema.parse({ name: "Sealed Parcel", kind: "quest", entrusted: true, entrustedQuest: "deliver", value: 50 }),
};
const env = { catalog: (id: string) => ITEMS[id] };
const fill = (sheet: CharacterSheet): CharacterSheet => {
  let s = sheet;
  for (;;) {
    const r = placeStack(s, { itemId: "staff", qty: 1 }, env);
    if (!r.ok) return s;
    s = r.sheet;
  }
};

describe("owner-only netState", () => {
  it("names the owner body of an owner-only key, nobody for a key without one, everyone for the rest", () => {
    const store = new NetStateStore();
    store.define("secret", z.object({ owner: z.string().optional(), n: z.number() }), { audience: "owner" });
    store.define("open", z.number());
    expect(store.hasOwnerOnly).toBe(true);
    expect(store.audienceOf("secret/a", { owner: "body-1", n: 1 })).toBe("body-1");
    expect(store.audienceOf("secret/a", { n: 1 })).toBeNull();
    expect(store.audienceOf("secret/a", undefined)).toBeNull();
    expect(store.audienceOf("open/a", 3)).toBeUndefined();
    expect(store.jsonSchemas()["secret"]).toMatchObject({ "x-audience": "owner" });
    expect(store.jsonSchemas()["open"]).not.toHaveProperty("x-audience");
  });

  it("the character namespaces register loot bags as owner-only", () => {
    const store = new NetStateStore();
    registerCharacterNetState(store);
    expect(store.audienceOf("lootbag/x", lootBag("body-1", [0, 0, 0], []))).toBe("body-1");
    expect(store.audienceOf("character/body-1", createSheet())).toBeUndefined();
  });
});

describe("taking from a loot bag", () => {
  const twisted = { itemId: "staff", qty: 1, durability: 20, twists: ["a+b"] };
  const bag = lootBag("me", [1, 2, 3], [twisted, { itemId: "potion", qty: 3 }], { until: 5000, from: "wolf" });

  it("copies the stacks with their instance data", () => {
    expect(bag.items).toEqual([twisted, { itemId: "potion", qty: 3 }]);
    expect(bag).toMatchObject({ owner: "me", at: [1, 2, 3], until: 5000, from: "wolf" });
  });

  it("one stack comes in with its data; take-all empties the bag", () => {
    const one = takeFromBag(createSheet(), bag, 0, env);
    if (!one.ok) throw new Error(one.error);
    expect(Object.values(one.sheet.items)[0]).toMatchObject(twisted);
    expect(one.bag!.items).toEqual([{ itemId: "potion", qty: 3 }]);
    const all = takeFromBag(createSheet(), bag, undefined, env);
    if (!all.ok) throw new Error(all.error);
    expect(all.bag).toBeNull();
    expect(all.left).toBe(false);
  });

  it("nothing fits: refused, and the bag is untouched", () => {
    const full = fill(createSheet());
    expect(takeFromBag(full, bag, 0, env)).toEqual({ ok: false, error: "no room for Staff" });
    expect(takeFromBag(full, bag, undefined, env)).toEqual({ ok: false, error: "no room in your bags" });
    expect(roomFor(full, bag.items[1]!, env)).toBe(0);
  });

  it("part of a stack takes what fits and leaves the rest", () => {
    const r0 = placeStack(createSheet(), { itemId: "potion", qty: 4 }, env);
    if (!r0.ok) throw new Error(r0.error);
    const almost = fill(r0.sheet);
    expect(roomFor(almost, bag.items[1]!, env)).toBe(1);
    const r = takeFromBag(almost, bag, 1, env);
    if (!r.ok) throw new Error(r.error);
    expect(r.taken).toEqual([{ itemId: "potion", qty: 1 }]);
    expect(r.left).toBe(true);
    expect(r.bag!.items[1]).toEqual({ itemId: "potion", qty: 2 });
  });

  it("a body bag gives nothing by index", () => {
    expect(takeFromBag(createSheet(), { ...lootBag("me", [0, 0, 0], []), body: "them", offer: ["u1"], takes: 1 }, 0, env)).toEqual({ ok: false, error: "choose what to take" });
  });
});

// package L2: copper in bags, soulbound, need/greed/pass, saved bags
describe("L2: copper, soulbound, rolls, saved bags", () => {
  it("take-all brings the copper; coins alone need no room", () => {
    const full = fill(createSheet());
    const bag = lootBag("me", [0, 0, 0], [{ itemId: "potion", qty: 1 }], { coins: 250 });
    const r = takeFromBag(full, bag, undefined, env);
    if (!r.ok) throw new Error(r.error);
    expect(r.sheet.coins).toBe(250);
    expect(r.coins).toBe(250);
    expect(r.bag).toEqual({ ...bag, items: [{ itemId: "potion", qty: 1 }], coins: undefined });
    const c = takeBagCoins(createSheet(), lootBag("me", [0, 0, 0], [], { coins: 7 }));
    if (!c.ok) throw new Error(c.error);
    expect(c.sheet.coins).toBe(7);
    expect(c.bag).toBeNull();
  });

  it("a soulbound SLOT protects only the attuned item while it is worn there; swapped in or carried it moves", () => {
    const placed = placeStack(createSheet(), { itemId: "helm", qty: 1 }, env);
    if (!placed.ok) throw new Error(placed.error);
    const helm = placed.uids[0]!;
    const worn = equip(placed.sheet, helm, undefined, env);
    if (!worn.ok) throw new Error(worn.error);
    const bound = attuneSoulSlots(worn.sheet, ["helm"], { max: 3, price: 5000 });
    if (!bound.ok) throw new Error(bound.error);
    expect(bound.cost).toBe(0); // the first choice is free
    expect(soulProtected(bound.sheet, helm)).toBe(true);
    expect(soulStatus(bound.sheet, helm)).toEqual({ slot: "helm", state: "protected" });
    expect(transferStack(bound.sheet, createSheet(), helm, undefined, env, { allowWorn: true })).toEqual({ ok: false, error: "it is soulbound" });
    // a cap swapped into the head slot in the field: the slot protects nothing until it is attuned again
    const capIn = placeStack(bound.sheet, { itemId: "cap", qty: 1 }, env);
    if (!capIn.ok) throw new Error(capIn.error);
    const cap = capIn.uids[0]!;
    const swapped = equip(capIn.sheet, cap, "helm", env);
    if (!swapped.ok) throw new Error(swapped.error);
    expect(soulProtected(swapped.sheet, cap)).toBe(false);
    expect(soulStatus(swapped.sheet, cap)).toEqual({ slot: "helm", state: "swapped" });
    // the attuned helm, now carried, is not protected either
    expect(soulStatus(swapped.sheet, helm)).toEqual({ slot: "helm", state: "carried" });
    expect(transferStack(swapped.sheet, createSheet(), helm, undefined, env).ok).toBe(true);
    expect(transferStack(swapped.sheet, createSheet(), cap, undefined, env, { allowWorn: true }).ok).toBe(true);
    // no instance data is involved: the protection is the sheet's, never the stack's
    expect(instanceOf(bound.sheet.items[helm]!)).toEqual({});
  });

  it("attuning: re-attuning the same slots is free, changing WHICH slots costs the price, refusals", () => {
    let sheet: CharacterSheet = { ...createSheet(), coins: 6000 };
    for (const id of ["helm", "staff"]) {
      const r = placeStack(sheet, { itemId: id, qty: 1 }, env);
      if (!r.ok) throw new Error(r.error);
      const e = equip(r.sheet, r.uids[0]!, undefined, env);
      if (!e.ok) throw new Error(e.error);
      sheet = e.sheet;
    }
    const first = attuneSoulSlots(sheet, ["helm"], { max: 3, price: 5000 });
    if (!first.ok) throw new Error(first.error);
    expect(first.sheet.coins).toBe(6000);
    // the same slot, attuned again (to whatever is worn there now): free
    const again = attuneSoulSlots(first.sheet, ["helm"], { max: 3, price: 5000 });
    expect(again.ok && again.cost).toBe(0);
    // a different set: the price
    const change = attuneSoulSlots(first.sheet, ["helm", "primary"], { max: 3, price: 5000 });
    if (!change.ok) throw new Error(change.error);
    expect(change.cost).toBe(5000);
    expect(change.sheet.coins).toBe(1000);
    expect(Object.keys(change.sheet.soulslots!).sort()).toEqual(["helm", "primary"]);
    expect(attuneSoulSlots(change.sheet, ["helm"], { max: 3, price: 5000 })).toEqual({ ok: false, error: "you cannot afford to change your soulbound slots" });
    expect(attuneSoulSlots(sheet, ["chest"], { max: 3, price: 0 })).toEqual({ ok: false, error: "you wear nothing in the chest slot" });
    expect(attuneSoulSlots(sheet, ["helm", "primary"], { max: 1, price: 0 })).toEqual({ ok: false, error: "only 1 slots can be soulbound" });
    expect(attuneSoulSlots(sheet, ["bag"], { max: 3, price: 0 }).ok).toBe(false);
  });

  it("an ENTRUSTED item stays with its holder: no transfer, vault, sale, corpse; taken back on its quest's hand-in", () => {
    expect(() => itemSchema.parse({ name: "Ring", slots: ["trinket"], entrusted: true })).toThrow(/cannot be equippable/);
    const r = placeStack({ ...createSheet(), coins: 5 }, { itemId: "parcel", qty: 1 }, env);
    if (!r.ok) throw new Error(r.error);
    const uid = r.uids[0]!;
    expect(transferStack(r.sheet, createSheet(), uid, undefined, env)).toEqual({ ok: false, error: "it is entrusted" });
    expect(vaultDeposit(r.sheet, vaultSchema.parse({}), uid, undefined, env).ok).toBe(false);
    const shop = shopSchema.parse({ name: "Any", buyRate: 0.5 });
    expect(shopSell(r.sheet, freshShopState(shop), shop, uid, undefined, env).ok).toBe(false);
    const dead = corpseContents(r.sheet, env);
    expect(dead.items).toEqual([]);
    expect(dead.sheet.items[uid]).toBeDefined();
    expect(dead.coins).toBe(5);
    expect(takeEntrusted(r.sheet, "other-quest", env).items[uid]).toBeDefined();
    expect(takeEntrusted(r.sheet, "deliver", env).items[uid]).toBeUndefined();
  });

  it("a corpse: the grid and the purse leave, worn gear stays; a claim releases to the dead character, empty = gone", () => {
    const a = placeStack({ ...createSheet(), coins: 321 }, { itemId: "helm", qty: 1 }, env);
    if (!a.ok) throw new Error(a.error);
    const worn = equip(a.sheet, a.uids[0]!, undefined, env);
    if (!worn.ok) throw new Error(worn.error);
    const b = placeStack(worn.sheet, { itemId: "potion", qty: 3 }, env);
    if (!b.ok) throw new Error(b.error);
    const c = corpseContents(b.sheet, env);
    expect(c.items).toEqual([{ itemId: "potion", qty: 3 }]);
    expect(c.coins).toBe(321);
    expect(c.sheet.coins).toBe(0);
    expect(c.sheet.items[a.uids[0]!]).toBeDefined();
    const base = lootBag("killer", [0, 0, 0], c.items, { coins: c.coins, until: 900_000 });
    const claimed: LootBag = { ...base, corpse: "me", claimUntil: 60_000, offer: ["u"], takes: 1, plunder: 900 };
    expect(releaseCorpse(claimed)).toEqual({ ...base, owner: "me", corpse: "me" });
    expect(releaseCorpse({ ...claimed, items: [], coins: undefined })).toBeNull();
    // saved with the DEAD character even while claimed (never with the killer); never evicted by the cap
    const earned: Array<[string, LootBag]> = [0, 1, 2].map((i) => ["e" + i, lootBag("me", [0, 0, 0], [], { made: 10 + i })]);
    const packed = packSavedBags("me", undefined, [["c1", claimed], ...earned], "field", 0, 0, 1);
    expect(packed.bags.map((x) => x.id).sort()).toEqual(["c1", "e2"]);
    expect(packed.bags.find((x) => x.id === "c1")).toMatchObject({ corpse: true, coins: 321 });
    expect(packSavedBags("killer", undefined, [["c1", claimed]], "field", 0, 0).bags).toEqual([]);
    const back = unpackSavedBags(packed, "field", 0, 0);
    expect(back.live.find(([id]) => id === "c1")![1]).toMatchObject({ owner: "me", corpse: "me" });
  });

  it("plundered: no second worn item before the time is up", () => {
    expect(isPlundered({ plunderedUntil: 2000 }, 1999)).toBe(true);
    expect(isPlundered({ plunderedUntil: 2000 }, 2000)).toBe(false);
    expect(isPlundered({}, 0)).toBe(false);
  });

  it("broken gear gives no stats until repaired (and is never destroyed)", () => {
    const r = placeStack(createSheet(), { itemId: "helm", qty: 1 }, env);
    if (!r.ok) throw new Error(r.error);
    const worn = equip(r.sheet, r.uids[0]!, undefined, env);
    if (!worn.ok) throw new Error(worn.error);
    const whole = derivedStats(worn.sheet, env).stats.armor;
    const broken = structuredClone(worn.sheet);
    broken.items[r.uids[0]!]!.durability = 0;
    expect(derivedStats(broken, env).stats.armor).toBe(whole - 5);
    expect(broken.items[r.uids[0]!]).toBeDefined();
  });

  it("a shop's limited stock sells out; a buy past it is refused", () => {
    const shop = shopSchema.parse({ name: "Chandlery", stock: [{ itemId: "potion", qty: 2, price: 40, restockSeconds: 1800 }] });
    let state = freshShopState(shop);
    let sheet: CharacterSheet = { ...createSheet(), coins: 1000 };
    for (let i = 0; i < 2; i++) {
      const r = shopBuy(sheet, state, shop, "potion", 1, env);
      if (!r.ok) throw new Error(r.error);
      sheet = r.sheet;
      state = r.state;
    }
    expect(state.stock["potion"]).toBe(0);
    expect(sheet.coins).toBe(920);
    expect(shopBuy(sheet, state, shop, "potion", 1, env)).toEqual({ ok: false, error: "sold out" });
  });


  const roll = (choices: Record<string, "need" | "greed" | "pass">): LootRoll => ({
    item: { itemId: "staff", qty: 1 },
    at: [0, 0, 0],
    killer: "k",
    eligible: ["a", "b", "c", "k"],
    choices,
    until: 1000,
  });
  const seq = (...n: number[]) => () => n.shift() ?? 1;

  it("any need beats every greed, whatever the dice", () => {
    const out = resolveRoll(roll({ a: "greed", b: "need", c: "greed", k: "pass" }), seq(5));
    expect(out).toMatchObject({ winner: "b", choice: "need", roll: 5 });
    expect(out.rolls.find((r) => r.actorId === "a")).toEqual({ actorId: "a", choice: "greed" });
  });

  it("within a tier the highest 1–100 wins; a tie rolls again among the tied", () => {
    expect(resolveRoll(roll({ a: "greed", b: "greed", c: "pass", k: "greed" }), seq(40, 90, 12))).toMatchObject({ winner: "b", roll: 90 });
    const tie = resolveRoll(roll({ a: "need", b: "need", c: "pass", k: "pass" }), seq(77, 77, 3, 64));
    expect(tie).toMatchObject({ winner: "b", roll: 64 });
  });

  it("all pass (or no answer): the killer's", () => {
    expect(resolveRoll(roll({ a: "pass" }), seq(50))).toMatchObject({ winner: "k", choice: "pass", roll: null });
    expect(rollAnswered(roll({ a: "pass" }))).toBe(false);
  });

  it("saved bags: packed with wall-clock expiry, unpacked into this scene only, expired ones dropped, newest kept past the cap", () => {
    const live: Array<[string, LootBag]> = [
      ["b1", lootBag("me", [1, 2, 3], [{ itemId: "staff", qty: 1, durability: 9, twists: ["x+y"] }], { until: 10_000, coins: 12, made: 100, from: "wolf" })],
      ["body", { ...lootBag("me", [0, 0, 0], []), body: "them", offer: ["u"], takes: 1 }],
      ["other", lootBag("you", [0, 0, 0], [{ itemId: "potion", qty: 1 }])],
    ];
    const packed = packSavedBags("me", { owner: "me", bags: [{ id: "far", scene: "dungeon", at: [0, 0, 0], items: [], made: 50, expires: 9_999_999 }] }, live, "field", 4000, 1_000_000);
    expect(packed.bags.map((b) => b.id)).toEqual(["far", "b1"]);
    expect(packed.bags[1]).toMatchObject({ scene: "field", coins: 12, expires: 1_006_000, from: "wolf", items: [{ itemId: "staff", qty: 1, durability: 9, twists: ["x+y"] }] });
    // a new server: sim time starts again; 2 s of real time later the bag has 4 s left
    const back = unpackSavedBags(packed, "field", 0, 1_002_000);
    expect(back.live).toHaveLength(1);
    expect(back.live[0]![1]).toMatchObject({ owner: "me", until: 4000, coins: 12, items: packed.bags[1]!.items });
    expect(back.dormant!.bags.map((b) => b.id)).toEqual(["far"]);
    // after its time: gone
    expect(unpackSavedBags(packed, "field", 0, 1_006_001).live).toEqual([]);
    // the cap keeps the newest
    const many: Array<[string, LootBag]> = Array.from({ length: 5 }, (_, i) => [`m${i}`, lootBag("me", [0, 0, 0], [], { made: i })]);
    expect(packSavedBags("me", undefined, many, "field", 0, 0, 3).bags.map((b) => b.id)).toEqual(["m2", "m3", "m4"]);
  });

  it("the loot lock holds until its time; saved bags are owner-only", () => {
    const store = new NetStateStore();
    registerCharacterNetState(store);
    expect(store.set("lootlock/v", { until: 500, by: "k", bag: "b" })).toBe(true);
    expect(isLootLocked(store, "v", 499)).toBe(true);
    expect(isLootLocked(store, "v", 500)).toBe(false);
    expect(store.audienceOf("lootbags/me", { owner: "me", bags: [] })).toBe("me");
  });
});

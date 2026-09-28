import { describe, expect, it } from "vitest";
import {
  acceptQuest,
  addItem,
  compassWord,
  fillPlaces,
  literalCompassWords,
  placeTokens,
  placesSchema,
  advanceQuest,
  availableChoices,
  createSheet,
  dialogueSchema,
  formatCoins,
  freshShopState,
  itemSchema,
  questJournalSchema,
  questSchema,
  shopBuy,
  shopBuyPrice,
  shopSchema,
  shopSell,
  shopSellPrice,
  startNode,
  takeCarried,
  testCondition,
  turnInQuest,
  vaultCoins,
  vaultDeposit,
  vaultMove,
  vaultSchema,
  vaultWithdraw,
  type DialogueFacts,
  type Item,
  type SheetEnv,
} from "../src/index.js";

const items: Record<string, Item> = {
  bread: itemSchema.parse({ name: "Bread", stack: 10, value: 5, kind: "consumable" }),
  sword: itemSchema.parse({ name: "Sword", slots: ["primary"], value: 200, kind: "equipment", tags: ["weapon"] }),
  letter: itemSchema.parse({ name: "Letter", kind: "quest", value: 50 }),
};
const env: SheetEnv = { catalog: (id) => items[id] };
const rich = (coins: number) => ({ ...createSheet(), coins });

describe("money", () => {
  it("prints copper as gold, silver and copper", () => {
    expect(formatCoins(0)).toBe("0c");
    expect(formatCoins(105)).toBe("1s 5c");
    expect(formatCoins(12_000)).toBe("1g 20s");
  });
});

describe("shops", () => {
  const shop = shopSchema.parse({ name: "Stall", markup: 1.5, buyRate: 0.5, buys: ["weapon"], stock: [{ itemId: "bread" }, { itemId: "sword", qty: 2 }] });

  it("prices from value, markup and buyRate, and only buys what it deals in", () => {
    expect(shopSellPrice(shop, "bread", env)).toBe(8); // ceil(5 * 1.5)
    expect(shopBuyPrice(shop, "sword", env)).toBe(100);
    expect(shopBuyPrice(shop, "bread", env)).toBeNull(); // not a weapon
    expect(shopBuyPrice(shopSchema.parse({ name: "Any" }), "letter", env)).toBeNull(); // never quest items
  });

  it("sells limited stock for coin, refuses what the purse cannot cover", () => {
    const state = freshShopState(shop);
    expect(shopBuy(rich(100), state, shop, "sword", 1, env)).toMatchObject({ ok: false, error: /you need 3s/ });
    const r = shopBuy(rich(1000), state, shop, "sword", 2, env);
    if (!r.ok) throw new Error(r.error);
    expect(r.sheet.coins).toBe(1000 - 600);
    expect(r.state.stock.sword).toBe(0);
    expect(shopBuy(rich(1000), r.state, shop, "sword", 1, env)).toMatchObject({ ok: false, error: "sold out" });
    // unlimited entries never run out
    const bread = shopBuy(rich(1000), r.state, shop, "bread", 10, env);
    expect(bread.ok && bread.state.stock.bread).toBe(undefined);
  });

  it("buys a carried stack and puts it on the resale shelf", () => {
    const given = addItem(rich(0), "sword", 1, env);
    if (!given.ok) throw new Error(given.error);
    const uid = given.uids[0]!;
    const sold = shopSell(given.sheet, freshShopState(shop), shop, uid, undefined, env);
    if (!sold.ok) throw new Error(sold.error);
    expect(sold.sheet.coins).toBe(100);
    expect(sold.sheet.items[uid]).toBeUndefined();
    expect(sold.state.resale).toEqual([{ itemId: "sword", qty: 1 }]);
    const back = shopBuy(rich(500), sold.state, shop, "sword", 1, env); // own stock first
    expect(back.ok && back.state.stock.sword).toBe(1);
  });
});

describe("vault", () => {
  it("deposits, merges stacks, withdraws and moves coin", () => {
    let sheet = rich(300);
    const g = addItem(sheet, "bread", 7, env);
    if (!g.ok) throw new Error(g.error);
    sheet = g.sheet;
    let vault = vaultSchema.parse({ capacity: 2 });
    const d1 = vaultDeposit(sheet, vault, g.uids[0]!, 3, env);
    if (!d1.ok) throw new Error(d1.error);
    const d2 = vaultDeposit(d1.sheet, d1.vault, g.uids[0]!, undefined, env);
    if (!d2.ok) throw new Error(d2.error);
    expect(d2.vault.items).toEqual([{ itemId: "bread", qty: 7 }]);
    expect(Object.keys(d2.sheet.items)).toHaveLength(0);
    const w = vaultWithdraw(d2.sheet, d2.vault, 0, 2, env);
    if (!w.ok) throw new Error(w.error);
    expect(w.vault.items[0]!.qty).toBe(5);
    vault = w.vault;
    expect(vaultCoins(w.sheet, vault, 400)).toMatchObject({ ok: false });
    const c = vaultCoins(w.sheet, vault, 250);
    expect(c.ok && [c.sheet.coins, c.vault.coins]).toEqual([50, 250]);
  });

  it("refuses a full vault without losing the item", () => {
    const g = addItem(rich(0), "sword", 1, env);
    if (!g.ok) throw new Error(g.error);
    const full = vaultSchema.parse({ capacity: 1, items: [{ itemId: "bread", qty: 1 }] });
    expect(vaultDeposit(g.sheet, full, g.uids[0]!, undefined, env)).toMatchObject({ ok: false, error: "the vault is full" });
  });

  it("keeps stacks in their slots: an emptied slot stays empty, deposits fill the first hole", () => {
    const vault = vaultSchema.parse({ capacity: 4, items: [{ itemId: "bread", qty: 2 }, { itemId: "sword", qty: 1 }, { itemId: "letter", qty: 1 }] });
    const out = vaultWithdraw(rich(0), vault, 1, undefined, env);
    if (!out.ok) throw new Error(out.error);
    expect(out.vault.items).toEqual([{ itemId: "bread", qty: 2 }, null, { itemId: "letter", qty: 1 }]);
    const uid = Object.keys(out.sheet.items)[0]!;
    const back = vaultDeposit(out.sheet, out.vault, uid, undefined, env);
    if (!back.ok) throw new Error(back.error);
    expect(back.vault.items[1]).toEqual({ itemId: "sword", qty: 1 });
    // a withdrawn last slot trims the record
    const last = vaultWithdraw(rich(0), vault, 2, undefined, env);
    expect(last.ok && last.vault.items).toHaveLength(2);
  });

  it("drops into a chosen slot: empty takes it, same item tops up, a different stack swaps into the bag cell", () => {
    const g = addItem(rich(0), "sword", 1, env);
    if (!g.ok) throw new Error(g.error);
    const uid = g.uids[0]!;
    const cell = { container: g.sheet.items[uid]!.container, x: g.sheet.items[uid]!.x, y: g.sheet.items[uid]!.y };
    const vault = vaultSchema.parse({ capacity: 6, items: [{ itemId: "bread", qty: 4 }] });
    const into = vaultDeposit(g.sheet, vault, uid, undefined, env, 5);
    expect(into.ok && into.vault.items[5]).toEqual({ itemId: "sword", qty: 1 });
    const swap = vaultDeposit(g.sheet, vault, uid, undefined, env, 0);
    if (!swap.ok) throw new Error(swap.error);
    expect(swap.vault.items[0]).toEqual({ itemId: "sword", qty: 1 });
    expect(swap.sheet.items[uid]).toMatchObject({ itemId: "bread", qty: 4, ...cell });
    const bread = addItem(rich(0), "bread", 3, env);
    if (!bread.ok) throw new Error(bread.error);
    const top = vaultDeposit(bread.sheet, vault, bread.uids[0]!, undefined, env, 0);
    expect(top.ok && top.vault.items[0]).toEqual({ itemId: "bread", qty: 7 });
    expect(vaultDeposit(g.sheet, vault, uid, undefined, env, 6)).toMatchObject({ ok: false });
  });

  it("withdraws into a chosen bag cell and rearranges slots", () => {
    const vault = vaultSchema.parse({ capacity: 4, items: [{ itemId: "bread", qty: 4 }, { itemId: "sword", qty: 1 }] });
    const w = vaultWithdraw(rich(0), vault, 1, undefined, env, { container: "pockets", x: 1, y: 0 });
    if (!w.ok) throw new Error(w.error);
    expect(Object.values(w.sheet.items)).toEqual([{ itemId: "sword", qty: 1, container: "pockets", x: 1, y: 0 }]);
    const m = vaultMove(vault, 0, 3, env);
    expect(m.ok && m.vault.items).toEqual([null, { itemId: "sword", qty: 1 }, null, { itemId: "bread", qty: 4 }]);
    const s = vaultMove(vault, 0, 1, env);
    expect(s.ok && s.vault.items).toEqual([{ itemId: "sword", qty: 1 }, { itemId: "bread", qty: 4 }]);
    const merged = vaultMove(vaultSchema.parse({ items: [{ itemId: "bread", qty: 8 }, { itemId: "bread", qty: 4 }] }), 1, 0, env);
    expect(merged.ok && merged.vault.items).toEqual([{ itemId: "bread", qty: 10 }, { itemId: "bread", qty: 2 }]);
  });
});

describe("quests with givers", () => {
  const errand = questSchema.parse({ id: "errand", title: "Errand", description: "", turnIn: "warden", objectives: [{ id: "a", label: "Talk", kind: "talk", target: "captain" }] });
  const next = questSchema.parse({ id: "next", title: "Next", description: "", requires: ["errand"], objectives: [{ id: "a", label: "x", kind: "visit" }], area: { label: "Here", center: [0, 0], radius: 50 } });

  it("stops at READY for a hand-in quest, completes only when handed in", () => {
    let { journal } = acceptQuest(null, errand);
    expect(journal.tracked).toBe("errand");
    expect(turnInQuest(journal, errand).error).toBe("objectives not finished");
    journal = advanceQuest(journal, errand, "a", 1);
    expect(journal.quests.errand!.status).toBe("ready");
    const done = turnInQuest(journal, errand);
    expect(done.journal.quests.errand!.status).toBe("complete");
    expect(turnInQuest(done.journal, errand).error).toBe("already handed in");
  });

  it("chains through requires", () => {
    expect(acceptQuest(null, next).error).toMatch(/requires "errand"/);
    const j = questJournalSchema.parse({ quests: { errand: { status: "complete", progress: {} } } });
    expect(acceptQuest(j, next).error).toBeNull();
  });
});

describe("dialogue", () => {
  const raw = {
    start: [{ if: { quest: "errand", status: "ready" }, node: "done" }, { if: { met: false }, node: "hello" }, { node: "again" }],
    nodes: {
      hello: { text: "Hello {name}.", choices: [{ text: "Work?", if: { quest: "errand", status: "available" }, do: [{ do: "acceptQuest", quest: "errand" }] }, { text: "Rich?", if: { coins: 100 } }, { text: "Bye" }] },
      again: { text: ["Again.", "Still here."] },
      done: { text: "Well done." },
    },
  };
  const errand = questSchema.parse({ id: "errand", title: "Errand", description: "", objectives: [{ id: "a", label: "x", kind: "visit" }], area: { label: "Here", center: [0, 0], radius: 50 } });
  const facts = (over: Partial<DialogueFacts> = {}): DialogueFacts => ({
    npcId: "warden",
    memory: { met: {}, flags: {} },
    journal: null,
    sheet: rich(0),
    quest: (id) => (id === "errand" ? errand : undefined),
    metBefore: false,
    ...over,
  });

  it("validates node references", () => {
    expect(dialogueSchema.safeParse(raw).success).toBe(true);
    const broken = dialogueSchema.safeParse({ ...raw, nodes: { ...raw.nodes, hello: { text: "x", choices: [{ text: "y", goto: "nowhere" }] } } });
    expect(broken.success).toBe(false);
  });

  it("opens at the first start whose condition holds, and hides choices whose conditions fail", () => {
    const d = dialogueSchema.parse(raw);
    expect(startNode(d, facts())).toBe("hello");
    expect(startNode(d, facts({ metBefore: true }))).toBe("again");
    expect(startNode(d, facts({ journal: questJournalSchema.parse({ quests: { errand: { status: "ready", progress: {} } } }) }))).toBe("done");
    expect(availableChoices(d, "hello", facts())).toEqual([0, 2]);
    expect(availableChoices(d, "hello", facts({ sheet: rich(150), journal: questJournalSchema.parse({ quests: { errand: { status: "active", progress: {} } } }) }))).toEqual([1, 2]);
  });

  it("tests flags, items and combinators", () => {
    const g = addItem(rich(0), "bread", 3, env);
    if (!g.ok) throw new Error(g.error);
    const f = facts({ sheet: g.sheet, memory: { met: {}, flags: { told: true } } });
    expect(testCondition({ flag: "told" }, f)).toBe(true);
    expect(testCondition({ flag: "told", is: false }, f)).toBe(false);
    expect(testCondition({ item: "bread", qty: 3 }, f)).toBe(true);
    expect(testCondition({ all: [{ item: "bread", qty: 4 }] }, f)).toBe(false);
    expect(testCondition({ any: [{ item: "bread", qty: 4 }, { flag: "told" }] }, f)).toBe(true);
    expect(testCondition({ not: { flag: "told" } }, f)).toBe(false);
    const taken = takeCarried(g.sheet, "bread", 2, env);
    expect(taken.ok && Object.values(taken.sheet.items)[0]!.qty).toBe(1);
  });
});

describe("places: directions come from the world", () => {
  const table = placesSchema.parse({
    origin: [100, 100],
    places: { cove: { at: [100, 0], name: "the cove" }, camp: { at: [100, 400] }, gate: { at: [150, 50] }, far: { at: [100, 20000] } },
  });
  it("north is -Z", () => {
    expect(compassWord([0, 0], [0, -10])).toBe("north");
    expect(compassWord([0, 0], [10, 0])).toBe("east");
    expect(compassWord([0, 0], [-10, 10])).toBe("south-west");
  });
  it("fills place tokens from the table", () => {
    expect(fillPlaces("Search the {dir:cove} cove, {far:cove} away.", table)).toBe("Search the north cove, a stone's throw away.");
    expect(fillPlaces("{Dir:camp}, to the camp; {Place:cove}.", table)).toBe("South, to the camp; The cove.");
    expect(fillPlaces("the {dir:gate} gate", table)).toBe("the north-east gate");
    expect(fillPlaces("{far:far}", table)).toBe("many days away, across the sea");
    expect(fillPlaces("{dir:nowhere}", table)).toBe("somewhere");
  });
  it("finds literal compass words (the lint) but not tokens", () => {
    expect(literalCompassWords("the {dir:cove} cove")).toEqual([]);
    expect(literalCompassWords("the southern cove, north-west of here")).toEqual(["southern", "north", "west"]);
    expect(placeTokens("{dir:cove} and {far:camp}")).toEqual(["cove", "camp"]);
  });
});

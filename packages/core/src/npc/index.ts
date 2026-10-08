import { z } from "zod";
import type { AssetLibrary } from "../assets.js";
import type { NetStateStore } from "../net-state.js";
import type { EventRegistrationOptions } from "../events.js";
import { questOfferProblem, questState, type Quest, type QuestJournal } from "../game-ui.js";
export * from "./places.js";
import { placesSchema } from "./places.js";
import { addItem, cellAt, looseStackSchema, nextUid, placeStack, removeItem, type CharacterSheet, type GridTarget, type ItemStack, type SheetEnv } from "../character/sheet.js";
import { canMerge, hasInstanceData, instanceOf, sameInstance, type InstanceData } from "../character/instance.js";
import { currentDurability, missingDurability } from "../character/durability.js";
import { EQUIPMENT_SLOTS, type Item } from "../character/items.js";
import { DEFAULT_UNBINDABLE_SLOTS, isEntrusted } from "../character/soulbind.js";

/**
 * Town NPCs as data: what they SAY (`dialogue` assets), what they SELL
 * (`shop` assets), and the per-player state the server keeps about them —
 * which NPCs a character has met and what it has been told (`npc/<bodyId>`),
 * what it keeps in the vault (`vault/<bodyId>`), and each shop's live stock
 * (`shop/<shopId>`).
 *
 * Nothing here trusts a client. A player ASKS (`npc.talk`, `npc.choose`,
 * `shop.buy`, `shop.sell`, `vault.*`, all to-authority); the `npc` builtin on
 * the session authority re-checks distance, ownership, the conversation's
 * current node and every condition, runs the reducers below, and writes the
 * replicated state. The conversation itself is replicated too
 * (`dialogue/<bodyId>`), so the client only ever draws what the server decided.
 *
 * Persistence: `npc/`, `vault/`, `bind/` and `quests/` are the per-character records a
 * server commits beside the sheet (PERSISTED_PLAYER_NAMESPACES); `dialogue/` is
 * transient and `shop/` is the world's.
 */

// -- money ----------------------------------------------------------------------------

/** Copper per silver and per gold: prices and purses are integers in copper. */
export const COPPER_PER_SILVER = 100;
export const COPPER_PER_GOLD = 10_000;

/** "1g 20s 5c" — the way every UI prints a copper amount. */
export function formatCoins(copper: number): string {
  const c = Math.max(0, Math.floor(copper));
  const g = Math.floor(c / COPPER_PER_GOLD);
  const s = Math.floor((c % COPPER_PER_GOLD) / COPPER_PER_SILVER);
  const r = c % COPPER_PER_SILVER;
  const parts = [g ? `${g}g` : "", s ? `${s}s` : "", r || (!g && !s) ? `${r}c` : ""].filter(Boolean);
  return parts.join(" ");
}

// -- dialogue -------------------------------------------------------------------------

export * from "./conditions.js";
import { clockHolds, dialogueConditionSchema, weatherHolds, type DialogueCondition, type WorldFacts } from "./conditions.js";

export const dialogueActionSchema = z
  .discriminatedUnion("do", [
    z.object({ do: z.literal("setFlag"), flag: z.string().min(1) }).describe("Remember something about this character (npc/<bodyId>.flags)."),
    z.object({ do: z.literal("clearFlag"), flag: z.string().min(1) }),
    z.object({ do: z.literal("acceptQuest"), quest: z.string().min(1) }).describe("Add the quest to the journal (refused when it is not available)."),
    z.object({ do: z.literal("turnInQuest"), quest: z.string().min(1) }).describe("Hand a READY quest in: it completes and pays rewardXp/rewardCoins/rewardItems."),
    z.object({ do: z.literal("openShop"), shop: z.string().min(1) }).describe("Open the shop window (a `shop` asset id) on top of the conversation."),
    z.object({ do: z.literal("openVault") }).describe("Open the character's vault window."),
    z
      .object({ do: z.literal("bindSoul") })
      .describe(
        "HEARTH bind (the id is kept from when a soul binder did this): the character respawns HERE, at this NPC's " +
          "`bindPoint` (npc param; default the NPC's own position), instead of the nearest sanctuary. Saved with the " +
          "character (netState bind/<bodyId>). Every town's innkeeper offers it; the soul binder offers `openSoulbind`.",
      ),
    z
      .object({
        do: z.literal("openSoulbind"),
        slots: z.number().int().min(1).max(12).default(3).describe("Most equipment slots a character may have soulbound."),
        price: z
          .number()
          .int()
          .min(0)
          .default(5000)
          .describe("Copper charged when the character CHANGES which slots are soulbound (a first choice and re-attuning the same slots are free)."),
        exclude: z
          .array(z.enum(EQUIPMENT_SLOTS))
          .default([...DEFAULT_UNBINDABLE_SLOTS])
          .describe("Slots that cannot be chosen (default the worn bag and the belt, which are never looted anyway)."),
      })
      .describe(
        "Open the SOUL BINDER's window: choose up to `slots` equipment slots and attune each to the item worn there now " +
          "(sheet `soulslots`; request soul.attune). That item cannot be looted from the character while it stays worn there.",
      ),
    z
      .object({
        do: z.literal("openRepair"),
        rate: z
          .number()
          .min(0)
          .max(100)
          .default(0.25)
          .describe("Price factor: mending an item costs ceil(item value × missing/max × rate) copper, at least 1 for any damage."),
      })
      .describe("Open the repair window: every damaged item the character wears or carries, a price each, and Repair all."),
    z.object({ do: z.literal("give"), item: z.string().min(1), qty: z.number().int().min(1).default(1) }).describe("The NPC hands the character items (refused when the bags are full)."),
    z.object({ do: z.literal("take"), item: z.string().min(1), qty: z.number().int().min(1).default(1) }).describe("The character hands items over (refused when it does not carry them)."),
    z.object({ do: z.literal("pay"), coins: z.number().int().min(1) }).describe("The character pays the NPC (refused when it cannot afford it)."),
    z.object({ do: z.literal("reward"), coins: z.number().int().min(0).default(0), xp: z.number().int().min(0).default(0) }).describe("The NPC pays the character coins and/or experience."),
  ])
  .describe("Something a dialogue choice DOES on the server. A choice's actions run all-or-nothing.");
export type DialogueAction = z.infer<typeof dialogueActionSchema>;

export const dialogueChoiceSchema = z.object({
  text: z.string().min(1).describe("What the player says (the button)."),
  if: dialogueConditionSchema.optional().describe("Shown only when this holds."),
  do: z.array(dialogueActionSchema).default([]),
  goto: z.string().default("end").describe('Node id to continue at; "end" closes the conversation.'),
});
export type DialogueChoice = z.infer<typeof dialogueChoiceSchema>;

export const dialogueNodeSchema = z.object({
  text: z
    .union([z.string().min(1), z.array(z.string().min(1)).min(1)])
    .describe("What the NPC says. A list = one line picked per visit (small talk). `{name}` is the character's name, `{npc}` the NPC's."),
  choices: z.array(dialogueChoiceSchema).default([]).describe('Empty = a lone "Farewell."'),
});
export type DialogueNode = z.infer<typeof dialogueNodeSchema>;

export const dialogueSchema = z
  .object({
    start: z
      .array(z.object({ if: dialogueConditionSchema.optional(), node: z.string().min(1) }))
      .min(1)
      .describe("Where a conversation opens: the FIRST entry whose `if` holds (put quest hand-ins and first meetings before the plain greeting)."),
    nodes: z.record(z.string(), dialogueNodeSchema),
  })
  .superRefine((d, ctx) => {
    for (const s of d.start) if (!d.nodes[s.node]) ctx.addIssue({ code: "custom", message: `start names unknown node "${s.node}"` });
    for (const [id, n] of Object.entries(d.nodes)) {
      for (const c of n.choices) {
        if (c.goto !== "end" && !d.nodes[c.goto]) ctx.addIssue({ code: "custom", message: `node "${id}" choice "${c.text}" goes to unknown node "${c.goto}"` });
      }
    }
  })
  .describe(
    "What an NPC says (assets/dialogues/<id>.json): a graph of nodes, each a line and the player's choices; choices can " +
      "test the character (quests, flags, items, coins, hearth bind) and act on the server (quests, shop, vault, repair, hearth bind, soulbound slots, items, coins).",
  );
export type Dialogue = z.infer<typeof dialogueSchema>;

// -- per-character memory ----------------------------------------------------------------

export const npcMemorySchema = z
  .object({
    met: z.record(z.string(), z.number().int().min(0)).default({}).describe("NPC entity id → conversations opened with it."),
    flags: z.record(z.string(), z.boolean()).default({}).describe("What this character has been told or has done (dialogue setFlag)."),
  })
  .describe("What the world remembers about one character, keyed npc/<bodyId>. Authority-written; saved with the character.");
export type NpcMemory = z.infer<typeof npcMemorySchema>;

/** What conditions are tested against. */
export interface DialogueFacts {
  npcId: string;
  memory: NpcMemory | null | undefined;
  journal: QuestJournal | null | undefined;
  sheet: CharacterSheet | null | undefined;
  quest: (id: string) => Quest | undefined;
  /** `met` at the start of THIS conversation (the open itself counts a meeting). */
  metBefore: boolean;
  /** The character's soul bind (netState bind/<bodyId>), for `bound`. */
  bind?: SoulBind | null;
  /** This NPC's bind point (world metres), for `bound`; absent = `bound: true` never holds. */
  bindPoint?: readonly [number, number, number] | null;
  /** World clock, weather and the biome underfoot, for `clock` / `weather`; absent = those never hold. */
  world?: WorldFacts | null;
}

/** Carried (not worn) quantity of an item. */
export function carriedCount(sheet: CharacterSheet | null | undefined, itemId: string): number {
  if (!sheet) return 0;
  let n = 0;
  for (const s of Object.values(sheet.items)) if (s.itemId === itemId && s.container !== undefined) n += s.qty;
  return n;
}

export function testCondition(c: DialogueCondition | undefined, f: DialogueFacts): boolean {
  if (!c) return true;
  if (c.quest !== undefined) {
    const def = f.quest(c.quest);
    const status = questState(f.journal, c.quest)?.status;
    const want = c.status ?? "complete";
    const ok =
      want === "none" ? status === undefined
      : want === "available" ? !!def && questOfferProblem(f.journal, def) === null
      : want === "taken" ? status === "active" || status === "ready"
      : status === want;
    if (!ok) return false;
  }
  if (c.flag !== undefined && (f.memory?.flags[c.flag] ?? false) !== (c.is ?? true)) return false;
  if (c.met !== undefined && f.metBefore !== c.met) return false;
  if (c.level !== undefined && (f.sheet?.level ?? 1) < c.level) return false;
  if (c.item !== undefined && carriedCount(f.sheet, c.item) < (c.qty ?? 1)) return false;
  if (c.coins !== undefined && (f.sheet?.coins ?? 0) < c.coins) return false;
  if (c.bound !== undefined && isBoundAt(f.bind, f.bindPoint) !== c.bound) return false;
  if (c.clock !== undefined && !clockHolds(c.clock, f.world?.hour)) return false;
  if (c.weather !== undefined && !weatherHolds(c.weather, f.world)) return false;
  if (c.all && !c.all.every((x) => testCondition(x, f))) return false;
  if (c.any && !c.any.some((x) => testCondition(x, f))) return false;
  if (c.not && testCondition(c.not, f)) return false;
  return true;
}

/** The node a conversation opens at, or null when no start entry holds. */
export function startNode(d: Dialogue, f: DialogueFacts): string | null {
  for (const s of d.start) if (testCondition(s.if, f)) return s.node;
  return null;
}

/** Indices (into the node's `choices`) the character may pick right now. */
export function availableChoices(d: Dialogue, node: string, f: DialogueFacts): number[] {
  const n = d.nodes[node];
  if (!n) return [];
  const out: number[] = [];
  n.choices.forEach((c, i) => {
    if (testCondition(c.if, f)) out.push(i);
  });
  return out;
}

/** The line a node says on visit `seq` (a list rotates), with {name}/{npc} filled in. */
export function nodeText(n: DialogueNode, seq: number, names: { name: string; npc: string }): string {
  const raw = Array.isArray(n.text) ? n.text[Math.abs(seq) % n.text.length]! : n.text;
  return raw.replaceAll("{name}", names.name).replaceAll("{npc}", names.npc);
}

// -- the replicated conversation -------------------------------------------------------------

export const conversationSchema = z
  .object({
    npc: z.string().min(1).describe("NPC entity id being spoken to."),
    node: z.string().min(1),
    text: z.string().describe("The line, as resolved on the server."),
    choices: z.array(z.object({ index: z.number().int().min(0), text: z.string() })).describe("What the player may say (index into the node's choices)."),
    panel: z
      .union([
        z.object({ kind: z.literal("shop"), shop: z.string().min(1) }),
        z.object({ kind: z.literal("vault") }),
        z.object({ kind: z.literal("repair"), rate: z.number().min(0).describe("The opening action's price factor.") }),
        z.object({
          kind: z.literal("soulbind"),
          slots: z.number().int().min(1).describe("Most slots that may be soulbound."),
          price: z.number().int().min(0).describe("Copper to change WHICH slots are soulbound."),
          exclude: z.array(z.enum(EQUIPMENT_SLOTS)).default([]).describe("Slots that cannot be chosen."),
        }),
      ])
      .nullable()
      .default(null)
      .describe("A service window open on top of the conversation."),
    notice: z.string().default("").describe("Why the last request was refused (\"You cannot afford that.\"), for the UI to show."),
    seq: z.number().int().min(0).default(0).describe("Bumped on every server change, so a UI redraws even when the node repeats."),
  })
  .describe("The conversation a character is in, keyed dialogue/<bodyId>. Authority-written; absent = not talking.");
export type Conversation = z.infer<typeof conversationSchema>;

// -- the hearth bind (respawn point; the action id `bindSoul` is kept) ----------------------------

export const soulBindSchema = z
  .object({
    at: z.tuple([z.number(), z.number(), z.number()]).describe("World point (metres) the character respawns at, scattered a metre or two."),
    name: z.string().default("").describe("Place name the bind is known by (\"Brinehold\")."),
  })
  .describe("Where a character's HEARTH is, keyed bind/<bodyId>: its respawn point. Authority-written (dialogue bindSoul, at an innkeeper); saved with the character.");
export type SoulBind = z.infer<typeof soulBindSchema>;

/** Metres within which a bind counts as "this binder's". */
export const BIND_MATCH_RADIUS = 1;

/** Whether a character's bind sits at `point` (a binder's bind point). */
export function isBoundAt(bind: SoulBind | null | undefined, point: readonly [number, number, number] | null | undefined): boolean {
  if (!bind || !point) return false;
  return Math.hypot(bind.at[0] - point[0], bind.at[1] - point[1], bind.at[2] - point[2]) <= BIND_MATCH_RADIUS;
}

// -- repair ----------------------------------------------------------------------------------

/** Default repair price factor (the `openRepair` action's `rate`). */
export const REPAIR_RATE = 0.25;

/** Copper to mend one instance fully: ceil(value × missing/max × rate), at least 1 when damaged; 0 when undamaged. */
export function repairCost(stack: Pick<ItemStack, "durability">, item: Item | undefined, rate = REPAIR_RATE): number {
  const missing = missingDurability(stack, item);
  if (missing <= 0) return 0;
  return Math.max(1, Math.ceil(item!.value * (missing / item!.durability!) * rate - 1e-9));
}

export interface RepairEntry {
  uid: string;
  itemId: string;
  current: number;
  max: number;
  cost: number;
  worn: boolean;
}

/** Every damaged item the character wears or carries, worn first, with its price. */
export function damagedItems(sheet: CharacterSheet, env: SheetEnv, rate = REPAIR_RATE): RepairEntry[] {
  const out: RepairEntry[] = [];
  for (const [uid, stack] of Object.entries(sheet.items)) {
    const item = env.catalog(stack.itemId);
    const cur = currentDurability(stack, item);
    if (cur === null || cur >= item!.durability!) continue;
    out.push({ uid, itemId: stack.itemId, current: cur, max: item!.durability!, cost: repairCost(stack, item, rate), worn: stack.container === undefined });
  }
  return out.sort((a, b) => Number(b.worn) - Number(a.worn));
}

export type RepairResult = { ok: true; sheet: CharacterSheet; cost: number; repaired: string[] } | { ok: false; error: string };

function mended(sheet: CharacterSheet, uids: readonly string[], cost: number): CharacterSheet {
  const next = structuredClone(sheet);
  for (const uid of uids) delete next.items[uid]!.durability;
  next.coins -= cost;
  return next;
}

/** Mend one damaged instance fully, paying its price. */
export function repairItem(sheet: CharacterSheet, uid: string, env: SheetEnv, rate = REPAIR_RATE): RepairResult {
  const stack = sheet.items[uid];
  if (!stack) return { ok: false, error: "no such item" };
  const item = env.catalog(stack.itemId);
  if (!item) return { ok: false, error: `unknown item "${stack.itemId}"` };
  if (item.durability === undefined) return { ok: false, error: `${item.name} does not wear` };
  const cost = repairCost(stack, item, rate);
  if (cost === 0) return { ok: false, error: `${item.name} needs no repair` };
  if (sheet.coins < cost) return { ok: false, error: `you need ${formatCoins(cost)}` };
  return { ok: true, sheet: mended(sheet, [uid], cost), cost, repaired: [uid] };
}

/** Mend everything damaged, all-or-nothing: refused (nothing mended) unless the purse covers the whole bill. */
export function repairAll(sheet: CharacterSheet, env: SheetEnv, rate = REPAIR_RATE): RepairResult {
  const list = damagedItems(sheet, env, rate);
  if (list.length === 0) return { ok: false, error: "nothing needs repair" };
  const cost = list.reduce((n, e) => n + e.cost, 0);
  if (sheet.coins < cost) return { ok: false, error: `you need ${formatCoins(cost)} to repair everything` };
  const uids = list.map((e) => e.uid);
  return { ok: true, sheet: mended(sheet, uids, cost), cost, repaired: uids };
}

// -- shops --------------------------------------------------------------------------------------

export const shopSchema = z
  .object({
    name: z.string().min(1).describe("Shop sign (\"Harrow & Daughters, Provisioners\")."),
    markup: z.number().min(0).default(1).describe("Selling price = item `value` × markup, rounded up (an entry's `price` overrides it)."),
    buyRate: z.number().min(0).max(1).default(0.25).describe("What the shop pays for an item: `value` × buyRate, rounded down. 0 = buys nothing."),
    buys: z
      .array(z.string())
      .default([])
      .describe("Item tags or kinds (equipment, consumable, material, misc) this shop buys; empty = anything with a value. Quest items are never bought."),
    stock: z
      .array(
        z.object({
          itemId: z.string().min(1),
          qty: z.number().int().min(1).optional().describe("Units on the shelf; absent = never runs out."),
          price: z.number().int().min(0).optional().describe("Price in copper, overriding value × markup."),
          restockSeconds: z.number().positive().default(300).describe("With `qty`: one unit comes back this often until the shelf is full."),
        }),
      )
      .default([])
      .describe("What the shop OWNS: its own goods, in display order."),
    resale: z
      .number()
      .int()
      .min(0)
      .default(12)
      .describe("How many distinct items players sold here it keeps for resale (at the selling price); 0 = sold goods vanish. Oldest go first."),
  })
  .describe("A vendor (assets/shops/<id>.json): what it owns, what it pays, what it charges. Live stock is netState shop/<id>.");
export type Shop = z.infer<typeof shopSchema>;

export const shopStateSchema = z
  .object({
    stock: z.record(z.string(), z.number().int().min(0)).default({}).describe("Units left of each LIMITED stock entry (unlimited ones are absent)."),
    resale: z
      .array(looseStackSchema)
      .default([])
      .describe(
        "Goods players sold here, oldest first: the buy-back shelf. Each entry keeps the sold instance's data (wear, twists), " +
          "and only identical instances share an entry, so whoever buys it gets the same item. Lives while the server runs.",
      ),
  })
  .describe("A shop's live shelf, keyed shop/<shopId>. Authority-written; shared by every player.");
export type ShopState = z.infer<typeof shopStateSchema>;

/** A shop's shelf the first time it opens. */
export function freshShopState(shop: Shop): ShopState {
  const stock: Record<string, number> = {};
  for (const e of shop.stock) if (e.qty !== undefined) stock[e.itemId] = e.qty;
  return { stock, resale: [] };
}

/** Price (copper) the shop charges for one unit, or null when it does not sell it. */
export function shopSellPrice(shop: Shop, itemId: string, env: SheetEnv): number | null {
  const entry = shop.stock.find((e) => e.itemId === itemId);
  const item = env.catalog(itemId);
  if (!item) return null;
  if (entry?.price !== undefined) return entry.price;
  return Math.ceil(item.value * shop.markup);
}

/** What the shop pays for one unit, or null when it will not buy it. */
export function shopBuyPrice(shop: Shop, itemId: string, env: SheetEnv): number | null {
  const item = env.catalog(itemId);
  if (!item || item.kind === "quest" || item.entrusted || item.value <= 0 || shop.buyRate <= 0) return null;
  if (shop.buys.length > 0 && !shop.buys.includes(item.kind) && !item.tags.some((t) => shop.buys.includes(t))) return null;
  const price = Math.floor(item.value * shop.buyRate);
  return price > 0 ? price : null;
}

export type TradeResult = { ok: true; sheet: CharacterSheet; state: ShopState; coins: number } | { ok: false; error: string };

/**
 * The character buys `qty` of an item from the shelf: own stock first, then
 * the buy-back shelf. `resale` names one buy-back entry (its index) — that
 * exact instance, with its wear and twists — instead.
 */
export function shopBuy(sheet: CharacterSheet, state: ShopState, shop: Shop, itemId: string, qty: number, env: SheetEnv, resale?: number): TradeResult {
  if (!Number.isInteger(qty) || qty < 1) return { ok: false, error: "qty must be a positive integer" };
  if (resale !== undefined && state.resale[resale]?.itemId !== itemId) return { ok: false, error: "that is no longer for sale" };
  const entry = resale === undefined ? shop.stock.find((e) => e.itemId === itemId) : undefined;
  const resaleIndex = resale ?? state.resale.findIndex((r) => r.itemId === itemId);
  if (!entry && resaleIndex < 0) return { ok: false, error: "not for sale here" };
  const limited = entry ? entry.qty !== undefined : true;
  const onShelf = entry ? (limited ? (state.stock[itemId] ?? 0) : Infinity) : state.resale[resaleIndex]!.qty;
  if (onShelf < qty) return { ok: false, error: onShelf === 0 ? "sold out" : `only ${onShelf} left` };
  const price = shopSellPrice(shop, itemId, env);
  if (price === null) return { ok: false, error: "not for sale here" };
  const cost = price * qty;
  if (sheet.coins < cost) return { ok: false, error: `you need ${formatCoins(cost)}` };
  // a buy-back hands over the instance that was sold, wear and twists included
  const added = entry ? addItem(sheet, itemId, qty, env) : placeStack(sheet, { ...state.resale[resaleIndex]!, qty }, env, { partial: true });
  if (!added.ok) return added;
  if (added.placed < qty) return { ok: false, error: "not enough room in your bags" };
  const next = { ...added.sheet, coins: sheet.coins - cost };
  const nextState: ShopState = structuredClone(state);
  if (entry) {
    if (limited) nextState.stock[itemId] = onShelf - qty;
  } else {
    const r = nextState.resale[resaleIndex]!;
    r.qty -= qty;
    if (r.qty === 0) nextState.resale.splice(resaleIndex, 1);
  }
  return { ok: true, sheet: next, state: nextState, coins: -cost };
}

/** The character sells `qty` (default all) of a CARRIED stack to the shop. */
export function shopSell(
  sheet: CharacterSheet,
  state: ShopState,
  shop: Shop,
  uid: string,
  qty: number | undefined,
  env: SheetEnv,
): TradeResult {
  const stack = sheet.items[uid];
  if (!stack) return { ok: false, error: "no such item" };
  if (stack.container === undefined) return { ok: false, error: "take it off first" };
  if (isEntrusted(env, stack.itemId)) return { ok: false, error: "that was entrusted to you: it is not yours to sell" };
  const price = shopBuyPrice(shop, stack.itemId, env);
  if (price === null) return { ok: false, error: "the shop will not buy that" };
  const removed = removeItem(sheet, uid, qty, env);
  if (!removed.ok) return removed;
  const n = removed.removed.qty;
  const next = { ...removed.sheet, coins: sheet.coins + price * n };
  const nextState: ShopState = structuredClone(state);
  if (shop.resale > 0) {
    // the shelf keeps the instance as sold; only identical instances share an entry
    const same = nextState.resale.find((r) => r.itemId === stack.itemId && sameInstance(r, removed.removed));
    if (same) same.qty += n;
    else nextState.resale.push(structuredClone(removed.removed));
    while (nextState.resale.length > shop.resale) nextState.resale.shift();
  }
  return { ok: true, sheet: next, state: nextState, coins: price * n };
}

// -- the vault -----------------------------------------------------------------------------------

/** A vault slot: a loose stack, every per-instance field (wear, twists, …) kept while it is stored. */
const vaultStackSchema = looseStackSchema;

/** The per-instance fields of a stack (character/instance.ts), to carry them across a move. */
const wearOf = (s: object): InstanceData => instanceOf(s);

export const vaultSchema = z
  .object({
    capacity: z.number().int().min(1).max(400).default(24).describe("Slots; each holds one stack."),
    coins: z.number().int().min(0).default(0).describe("Copper held at the bank."),
    items: z
      .array(vaultStackSchema.nullable())
      .default([])
      .describe("The vault's slots by index (null = empty). A stack keeps its slot until it is moved, like a bank bag's cells."),
  })
  .describe("A character's bank vault, keyed vault/<bodyId>: the same vault at every banker. Authority-written; saved with the character.");
export type Vault = z.infer<typeof vaultSchema>;
export type VaultStack = z.infer<typeof vaultStackSchema>;

export type VaultResult = { ok: true; sheet: CharacterSheet; vault: Vault } | { ok: false; error: string };

/** Occupied vault slots. */
export function vaultUsed(vault: Vault): number {
  return vault.items.reduce((n, s) => n + (s ? 1 : 0), 0);
}

/** First empty slot index, or -1 when the vault is full. */
function freeSlot(vault: Vault): number {
  for (let i = 0; i < vault.capacity; i++) if (!vault.items[i]) return i;
  return -1;
}

/** Drop trailing empty slots so the saved record stays short. */
function trimmed(vault: Vault): Vault {
  let n = vault.items.length;
  while (n > 0 && !vault.items[n - 1]) n--;
  vault.items.length = n;
  for (let i = 0; i < n; i++) if (vault.items[i] === undefined) vault.items[i] = null;
  return vault;
}

/**
 * Put a carried stack (or `qty` of it) into the vault. With `slot`, it lands in
 * that slot: an empty one takes it, a matching stack tops up, and a different
 * stack swaps into the bag cell the deposit came from (whole stacks only).
 * Without `slot`, matching stacks are topped up first, then the first empty slot.
 */
export function vaultDeposit(sheet: CharacterSheet, vault: Vault, uid: string, qty: number | undefined, env: SheetEnv, slot?: number): VaultResult {
  const stack = sheet.items[uid];
  if (!stack) return { ok: false, error: "no such item" };
  if (stack.container === undefined) return { ok: false, error: "take it off first" };
  const item = env.catalog(stack.itemId);
  if (!item) return { ok: false, error: `unknown item "${stack.itemId}"` };
  if (item.entrusted) return { ok: false, error: "that was entrusted to you: it stays in your keeping" };
  const want = qty ?? stack.qty;
  if (!Number.isInteger(want) || want < 1 || want > stack.qty) return { ok: false, error: `cannot store ${want} of ${stack.qty}` };
  const next: Vault = structuredClone(vault);
  let stored = want;

  if (slot !== undefined) {
    if (!Number.isInteger(slot) || slot < 0 || slot >= next.capacity) return { ok: false, error: "no such vault slot" };
    const there = next.items[slot];
    if (!there) {
      next.items[slot] = { itemId: stack.itemId, qty: want, ...wearOf(stack) };
    } else if (canMerge(there, stack, item.stack)) {
      stored = Math.min(want, item.stack - there.qty);
      if (stored <= 0) return { ok: false, error: `that ${item.name} stack is full` };
      there.qty += stored;
    } else {
      // swap: the vault's stack takes the bag cell this one leaves
      if (want !== stack.qty) return { ok: false, error: "that slot is taken" };
      next.items[slot] = { itemId: stack.itemId, qty: want, ...wearOf(stack) };
      const swapped = structuredClone(sheet);
      swapped.items[uid] = { itemId: there.itemId, qty: there.qty, container: stack.container, x: stack.x, y: stack.y, ...wearOf(there) };
      return { ok: true, sheet: swapped, vault: trimmed(next) };
    }
  } else {
    let left = want;
    if (item.stack > 1) {
      for (const s of next.items) {
        if (left === 0) break;
        if (!s || s.qty >= item.stack || !canMerge(s, stack, item.stack)) continue;
        const take = Math.min(left, item.stack - s.qty);
        s.qty += take;
        left -= take;
      }
    }
    while (left > 0) {
      const i = freeSlot(next);
      if (i < 0) return { ok: false, error: "the vault is full" };
      const take = Math.min(left, item.stack);
      next.items[i] = { itemId: stack.itemId, qty: take, ...wearOf(stack) };
      left -= take;
    }
  }
  const removed = removeItem(sheet, uid, stored, env);
  if (!removed.ok) return removed;
  return { ok: true, sheet: removed.sheet, vault: trimmed(next) };
}

/**
 * Take a vault slot (or `qty` of it) back into the bags. With `to`, it lands in
 * that cell: an empty cell takes it, a matching stack tops up, and a different
 * stack swaps into the vault slot (whole stacks only). Without `to`, the usual
 * top-up-then-first-free placement.
 */
export function vaultWithdraw(sheet: CharacterSheet, vault: Vault, index: number, qty: number | undefined, env: SheetEnv, to?: GridTarget): VaultResult {
  const slot = vault.items[index];
  if (!slot) return { ok: false, error: "that slot is empty" };
  const want = qty ?? slot.qty;
  if (!Number.isInteger(want) || want < 1 || want > slot.qty) return { ok: false, error: `cannot take ${want} of ${slot.qty}` };
  const item = env.catalog(slot.itemId);
  if (!item) return { ok: false, error: `unknown item "${slot.itemId}"` };
  const next: Vault = structuredClone(vault);
  const take = (n: number): void => {
    next.items[index]!.qty -= n;
    if (next.items[index]!.qty === 0) next.items[index] = null;
  };

  if (to) {
    const probe = cellAt(sheet, to.container, to.x, to.y, env);
    if (!probe.ok) return probe;
    const sheetNext = structuredClone(sheet);
    if (probe.occupant === null) {
      sheetNext.items[nextUid(sheetNext)] = { itemId: slot.itemId, qty: want, ...to, ...wearOf(slot) };
      take(want);
      return { ok: true, sheet: sheetNext, vault: trimmed(next) };
    }
    const other = sheetNext.items[probe.occupant]!;
    if (canMerge(other, slot, item.stack)) {
      const n = Math.min(want, item.stack - other.qty);
      if (n <= 0) return { ok: false, error: `that ${item.name} stack is full` };
      other.qty += n;
      take(n);
      return { ok: true, sheet: sheetNext, vault: trimmed(next) };
    }
    if (want !== slot.qty) return { ok: false, error: "that cell is taken" };
    next.items[index] = { itemId: other.itemId, qty: other.qty, ...wearOf(other) };
    sheetNext.items[probe.occupant] = { itemId: slot.itemId, qty: slot.qty, ...to, ...wearOf(slot) };
    return { ok: true, sheet: sheetNext, vault: trimmed(next) };
  }

  // tops up only identical instances, and every new stack keeps the slot's instance data
  const added = placeStack(sheet, { ...slot, qty: want }, env, { partial: true });
  if (!added.ok) return added;
  take(added.placed);
  return { ok: true, sheet: added.sheet, vault: trimmed(next) };
}

/** Rearrange the vault: move slot `from` onto `to` — an empty slot takes it, a matching stack tops up, anything else swaps. */
export function vaultMove(vault: Vault, from: number, to: number, env: SheetEnv): { ok: true; vault: Vault } | { ok: false; error: string } {
  const a = vault.items[from];
  if (!a) return { ok: false, error: "that slot is empty" };
  if (!Number.isInteger(to) || to < 0 || to >= vault.capacity) return { ok: false, error: "no such vault slot" };
  if (from === to) return { ok: true, vault };
  const next: Vault = structuredClone(vault);
  const b = next.items[to];
  const item = env.catalog(a.itemId);
  if (b && item && canMerge(b, a, item.stack) && b.qty < item.stack) {
    const n = Math.min(a.qty, item.stack - b.qty);
    b.qty += n;
    next.items[from] = a.qty - n > 0 ? { ...a, qty: a.qty - n } : null;
  } else {
    next.items[to] = { ...a };
    next.items[from] = b ? { ...b } : null;
  }
  return { ok: true, vault: trimmed(next) };
}

/** Move coins between purse and vault: positive deposits, negative withdraws. */
export function vaultCoins(sheet: CharacterSheet, vault: Vault, amount: number): VaultResult {
  if (!Number.isInteger(amount) || amount === 0) return { ok: false, error: "amount must be a non-zero integer" };
  if (amount > 0 && sheet.coins < amount) return { ok: false, error: "you do not carry that much" };
  if (amount < 0 && vault.coins < -amount) return { ok: false, error: "the vault does not hold that much" };
  return { ok: true, sheet: { ...sheet, coins: sheet.coins - amount }, vault: { ...vault, coins: vault.coins + amount } };
}

/** Take back every carried ENTRUSTED item that belongs to quest `questId` (item `entrustedQuest`): the quest is over. */
export function takeEntrusted(sheet: CharacterSheet, questId: string, env: SheetEnv): CharacterSheet {
  let next = sheet;
  for (const [uid, s] of Object.entries(sheet.items)) {
    const item = env.catalog(s.itemId);
    if (!item?.entrusted || item.entrustedQuest !== questId || s.container === undefined) continue;
    const r = removeItem(next, uid, undefined, env);
    if (r.ok) next = r.sheet;
  }
  return next;
}

/** Take `qty` of an item out of the carried stacks (quest hand-ins, `take` actions), plain instances first. */
export function takeCarried(sheet: CharacterSheet, itemId: string, qty: number, env: SheetEnv): { ok: true; sheet: CharacterSheet } | { ok: false; error: string } {
  if (carriedCount(sheet, itemId) < qty) return { ok: false, error: `you need ${qty} ${env.catalog(itemId)?.name ?? itemId}` };
  let next = sheet;
  let left = qty;
  // plain instances go first: a hand-in never takes a twisted or worn copy while a plain one will do
  const order = Object.entries(sheet.items).sort(([, a], [, b]) => Number(hasInstanceData(a)) - Number(hasInstanceData(b)));
  for (const [uid, s] of order) {
    if (left === 0) break;
    if (s.itemId !== itemId || s.container === undefined) continue;
    const take = Math.min(left, s.qty);
    const r = removeItem(next, uid, take, env);
    if (!r.ok) return r;
    next = r.sheet;
    left -= take;
  }
  return { ok: true, sheet: next };
}

// -- events + registration ----------------------------------------------------------------------------

const actorId = z.string().min(1).describe("Body entity id of the character (its owner must be the sender).");
const npcId = z.string().min(1).describe("Entity id of the NPC.");
const toAuthority: EventRegistrationOptions = { replicate: "to-authority" };

export const NPC_EVENTS = {
  talk: "npc.talk",
  choose: "npc.choose",
  leave: "npc.leave",
  talked: "npc.talked",
  buy: "shop.buy",
  sell: "shop.sell",
  deposit: "vault.deposit",
  withdraw: "vault.withdraw",
  coins: "vault.coins",
  arrange: "vault.move",
  repair: "repair.item",
  repairAll: "repair.all",
  attune: "soul.attune",
} as const;

export const npcEventDecls: ReadonlyArray<{ name: string; schema: z.ZodType; options?: EventRegistrationOptions }> = [
  { name: NPC_EVENTS.talk, schema: z.object({ actorId, npcId }), options: toAuthority },
  { name: NPC_EVENTS.choose, schema: z.object({ actorId, npcId, node: z.string(), index: z.number().int().min(0) }), options: toAuthority },
  { name: NPC_EVENTS.leave, schema: z.object({ actorId, npcId }), options: toAuthority },
  // authority-internal (not replicated): a conversation opened — quest logs count `talk` objectives from it
  { name: NPC_EVENTS.talked, schema: z.object({ actorId, npcId }) },
  {
    name: NPC_EVENTS.buy,
    schema: z.object({
      actorId,
      npcId,
      itemId: z.string().min(1),
      qty: z.number().int().min(1).default(1),
      resale: z
        .number()
        .int()
        .min(0)
        .optional()
        .describe("Index of a buy-back entry (shop/<id>.resale) to buy that exact instance; omitted = own stock first, then the first buy-back entry of the item."),
    }),
    options: toAuthority,
  },
  { name: NPC_EVENTS.sell, schema: z.object({ actorId, npcId, uid: z.string().min(1), qty: z.number().int().min(1).optional() }), options: toAuthority },
  {
    name: NPC_EVENTS.deposit,
    schema: z.object({
      actorId,
      npcId,
      uid: z.string().min(1),
      qty: z.number().int().min(1).optional(),
      slot: z.number().int().min(0).optional().describe("Vault slot to drop into; omitted = top up, then the first empty slot."),
    }),
    options: toAuthority,
  },
  {
    name: NPC_EVENTS.withdraw,
    schema: z.object({
      actorId,
      npcId,
      index: z.number().int().min(0).describe("Vault slot index."),
      qty: z.number().int().min(1).optional(),
      to: z
        .object({ container: z.enum(["pockets", "bag"]), x: z.number().int().min(0), y: z.number().int().min(0) })
        .optional()
        .describe("Bag cell to drop into; omitted = top up, then the first free cell."),
    }),
    options: toAuthority,
  },
  {
    name: NPC_EVENTS.arrange,
    schema: z.object({ actorId, npcId, from: z.number().int().min(0), to: z.number().int().min(0) }).describe("Rearrange the vault: drag slot `from` onto slot `to`."),
    options: toAuthority,
  },
  { name: NPC_EVENTS.coins, schema: z.object({ actorId, npcId, amount: z.number().int() }), options: toAuthority },
  {
    name: NPC_EVENTS.repair,
    schema: z.object({ actorId, npcId, uid: z.string().min(1).describe("Stack uid (worn or carried) to mend.") }).describe("Mend one item at an open repair window."),
    options: toAuthority,
  },
  { name: NPC_EVENTS.repairAll, schema: z.object({ actorId, npcId }).describe("Mend every damaged item at an open repair window (all-or-nothing)."), options: toAuthority },
  {
    name: NPC_EVENTS.attune,
    schema: z
      .object({
        actorId,
        npcId,
        slots: z.array(z.enum(EQUIPMENT_SLOTS)).max(12).describe("The slots to have soulbound, each attuned to what is worn there now; [] clears them."),
      })
      .describe(
        "At an open soul binder window: soulbind these slots (sheet `soulslots`). Re-attuning the same slots is free; a " +
          "different set costs the window's `price` (a first choice is free).",
      ),
    options: toAuthority,
  },
];

/**
 * Per-character netState namespaces a server saves beside the sheet (and restores before the body spawns).
 * `lootbags` holds the loot bags a character owns but are not lying in the current scene; the server packs the
 * live ones in on save and unpacks this scene's on spawn (character/loot.ts `packSavedBags` / `unpackSavedBags`).
 */
export const PERSISTED_PLAYER_NAMESPACES = ["quests", "npc", "vault", "bind", "portal", "lootbags"] as const;

/** `dialogue`, `shop` and `places` data-asset types (assets/dialogues/, assets/shops/; `quest` is a core type already). */
export function registerNpcAssetTypes(assets: AssetLibrary): void {
  assets.defineDataType("dialogue", dialogueSchema);
  assets.defineDataType("shop", shopSchema);
  assets.defineDataType("places", placesSchema);
}

/** Register npc/, vault/, bind/, dialogue/ and shop/ so they validate on write and appear in the spec. Once per store. */
export function registerNpcNetState(store: NetStateStore): void {
  store.define("npc", npcMemorySchema);
  store.define("vault", vaultSchema);
  store.define("bind", soulBindSchema);
  store.define("dialogue", conversationSchema);
  store.define("shop", shopStateSchema);
}

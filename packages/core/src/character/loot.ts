import { z } from "zod";
import { instanceOf } from "./instance.js";
import { looseStackSchema, placeStack, type CharacterSheet, type LooseStack, type SheetEnv } from "./sheet.js";
import { isEntrusted } from "./soulbind.js";

/**
 * Loot bags: ONE container for everything that lies in the world waiting for
 * someone — a creature's drops, an item a player threw away, the chance to
 * take something from a character you killed. A bag has an OWNER (a body id),
 * a point and an expiry; only the owner sees it and only the owner may take
 * from it. Its netState namespace is owner-only (`audience: "owner"`), so a
 * dedicated server never sends a bag to anyone else, and the authority refuses
 * every request that is not the owner's.
 *
 * Bags are TAKE-ONLY: nothing is ever added to a bag once it is made; it only
 * empties. (The paid vault is the one safe long-term storage; a bag is a claim
 * window, not a locker.) An EARNED bag (a creature's drop, a share of a party
 * kill, a roll won) lasts days; a DROPPED bag (`dropped`: an item its owner
 * threw away) lasts minutes, and an owner may have only a few at once.
 *
 * Nothing in a bag is ever lost for want of room: a take that does not fit
 * leaves the stack where it is (a partial stack leaves the rest), until the
 * owner has made room or the bag expires. Money (`coins`) needs no room.
 *
 * A BODY bag holds no items: it names a killed character (`body`) and what of
 * theirs the owner may take — `carried` stacks (as many as fit), `coins`, and
 * a choice of `takes` from `offer` (worn gear: the looter's choice of one) —
 * all decided by the game at the death and fixed for the bag's life. The
 * stacks move with `transferStack`, instance data intact; what a soulbound slot protects never
 * moves. While the bag lasts the victim is LOOT-LOCKED (`lootlock/<body>`):
 * their sheet refuses every request that would move an item or a coin out of
 * reach, and a server keeps their body (and so their sheet) until the lock
 * ends even if they disconnect.
 *
 * PARTY ROLLS (`lootroll/<rollId>`): an item a party shares goes to a
 * need / greed / pass roll among the members in range; the winner gets it in a
 * bag of their own at the corpse. `resolveRoll` is the rule.
 *
 * A CORPSE (`corpse`: a dead character's body id) is an item bag holding
 * what that character carried in their bags and purse when they died
 * (`corpseContents`: every grid stack but the entrusted, all the copper). It
 * may open with a CLAIM: a killer owns it until `claimUntil` (sim ms) and may
 * take any of it plus a choice of `takes` from `offer` (the dead character's
 * worn gear, still on their sheet); then — or at once with no killer — it
 * belongs to the dead character (`releaseCorpse`) until `until`, and is saved
 * with them like any earned bag. While a claim lasts the dead character is
 * loot-locked, exactly as for a body bag.
 *
 * SAVED BAGS (`lootbags/<bodyId>`, a per-character record the server saves
 * beside the sheet): item bags outlive a logout and a restart, for their
 * lifetime in wall-clock time. Only bags of an owner who is online, in the
 * scene they lie in, are live in netState; the rest wait in the record.
 */

/** The replicated, owner-only namespace a bag lies in: `lootbag/<bagId>`. */
export const LOOT_NETSTATE = "lootbag";

const point = z.tuple([z.number(), z.number(), z.number()]);

export const lootBagSchema = z
  .object({
    owner: z.string().min(1).describe("Body id of the only character who sees this bag and may take from it."),
    at: point.describe("World point it lies at (on the ground)."),
    until: z
      .number()
      .min(0)
      .optional()
      .describe("Sim time (ms) it disappears at, with whatever is left in it; absent = until emptied."),
    items: z
      .array(looseStackSchema)
      .max(64)
      .default([])
      .describe("The stacks in it, each with ALL its instance data (wear, twists). Empty on a body bag."),
    coins: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe(
        "Copper. Item bag: money lying in it (a kill's share), taken with take-all or `inventory.loot { coins: true }`. " +
          "Body bag: the killed character's carried copper the owner may take, fixed at the death (at most what they still carry).",
      ),
    body: z
      .string()
      .min(1)
      .optional()
      .describe("A killed character's body id: the bag offers what is THAT character's (`carried`, `coins`, `offer`) instead of holding items."),
    offer: z
      .array(z.string().min(1))
      .max(32)
      .optional()
      .describe(
        "Body bag, or a corpse under a claim: stack uids in the dead character's sheet (`body` / `corpse`) the owner may " +
          "CHOOSE from, `takes` of them (the game decides: worn gear, never what a soulbound slot protects).",
      ),
    takes: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe("Body bag or claimed corpse: stacks the owner may still choose from `offer` (1 = the looter's choice of one; 0 = the choice is used)."),
    carried: z
      .array(z.string().min(1))
      .max(256)
      .optional()
      .describe("Body bag: stack uids in `body`'s sheet the owner may take FREELY, as many as fit (the contents of their bags, never what a soulbound slot protects)."),
    corpse: z
      .string()
      .min(1)
      .optional()
      .describe(
        "A CORPSE: the dead character's body id. `items` / `coins` are what they carried in their bags and purse at the " +
          "death. It is theirs (`owner` = corpse) once any claim is over, until `until`; saved with them like an earned bag.",
      ),
    claimUntil: z
      .number()
      .min(0)
      .optional()
      .describe(
        "Corpse: sim time (ms) a killer's CLAIM ends. Until then `owner` is the killer (they alone see it and may take its " +
          "contents and choose from `offer`); then it passes to `corpse` (core `releaseCorpse`). Absent = no claim.",
      ),
    plunder: z
      .number()
      .min(0)
      .optional()
      .describe(
        "Body bag or claimed corpse: seconds the dead character is PLUNDERED after a worn item is taken from them (sheet " +
          "`plunderedUntil`): no looter may take another worn item from them meanwhile. Absent / 0 = no such rule.",
      ),
    from: z.string().optional().describe("Who or what left it (a creature's id, the dropper, the killed body): for the window title."),
    made: z.number().min(0).optional().describe("Wall-clock ms it was made: the owner's oldest bag goes first past the per-owner cap."),
    dropped: z
      .boolean()
      .optional()
      .describe("A bag of the owner's own DROPPED items: short-lived (character-sheet dropSeconds) and capped per owner (dropCap); absent = earned loot."),
  })
  .describe(
    "A loot bag, keyed lootbag/<bagId>: stacks and copper (or, on a body bag, the right to take from a killed character) " +
      "that only `owner` sees and may take (inventory.loot). Owner-only: a dedicated server sends it to the owner's peer " +
      "alone. Authority-written by the character-sheet builtin. Item bags are saved with their owner (lootbags/<bodyId>).",
  );
export type LootBag = z.infer<typeof lootBagSchema>;

/** An item bag holding `items` (copied with their instance data) and optionally copper. */
export function lootBag(
  owner: string,
  at: readonly [number, number, number],
  items: readonly LooseStack[],
  opts: { until?: number; from?: string; coins?: number; made?: number; dropped?: boolean } = {},
): LootBag {
  return {
    owner,
    at: [at[0], at[1], at[2]],
    items: items.map((s) => ({ itemId: s.itemId, qty: s.qty, ...instanceOf(s) })),
    ...(opts.coins ? { coins: opts.coins } : {}),
    ...(opts.until !== undefined ? { until: opts.until } : {}),
    ...(opts.from ? { from: opts.from } : {}),
    ...(opts.made !== undefined ? { made: opts.made } : {}),
    ...(opts.dropped ? { dropped: true } : {}),
  };
}

/** Whether a body bag has nothing left to give (every choice used, nothing carried, no copper). */
export function bodyBagSpent(bag: LootBag): boolean {
  return (bag.takes ?? 0) <= 0 && (bag.carried?.length ?? 0) === 0 && (bag.coins ?? 0) <= 0;
}

export type BagTakeResult =
  | {
      ok: true;
      sheet: CharacterSheet;
      /** The bag after the take; null when it is empty (delete it). */
      bag: LootBag | null;
      /** What came across, each with its instance data. */
      taken: LooseStack[];
      /** Copper that came across. */
      coins: number;
      /** Something (or part of it) stayed in the bag for want of room. */
      left: boolean;
    }
  | { ok: false; error: string };

/**
 * Take stack `index` from an item bag into a sheet — or, with no index, as
 * much of everything as fits, and the copper. What fits comes in with its
 * instance data; what does not stays in the bag. Refused only when nothing at
 * all came across.
 */
export function takeFromBag(sheet: CharacterSheet, bag: LootBag, index: number | undefined, env: SheetEnv): BagTakeResult {
  if (bag.body !== undefined) return { ok: false, error: "choose what to take" };
  const picks = index === undefined ? bag.items.map((_, i) => i) : [index];
  if (index !== undefined && !bag.items[index]) return { ok: false, error: "it is gone" };
  const coins = index === undefined ? (bag.coins ?? 0) : 0;
  let next: CharacterSheet = coins > 0 ? { ...sheet, coins: sheet.coins + coins } : sheet;
  const items = bag.items.map((s) => ({ ...s }));
  const taken: LooseStack[] = [];
  let left = false;
  let firstError = "";
  for (const i of picks) {
    const stack = items[i]!;
    const r = placeStack(next, stack, env, { partial: true });
    if (!r.ok) {
      left = true;
      firstError ||= r.error;
      continue;
    }
    next = r.sheet;
    taken.push({ ...stack, qty: r.placed });
    stack.qty -= r.placed;
    if (stack.qty > 0) left = true;
  }
  // "no room for <item>" for one stack; for take-all, the bags are the news
  if (taken.length === 0 && coins === 0) return { ok: false, error: index !== undefined && firstError ? firstError : "no room in your bags" };
  const rest = items.filter((s) => s.qty > 0);
  const restCoins = (bag.coins ?? 0) - coins;
  const after: LootBag = { ...bag, items: rest };
  if (restCoins > 0) after.coins = restCoins;
  else delete after.coins;
  return { ok: true, sheet: next, bag: rest.length > 0 || restCoins > 0 ? after : null, taken, coins, left };
}

/** Take only the copper from an item bag (`inventory.loot { coins: true }`). */
export function takeBagCoins(sheet: CharacterSheet, bag: LootBag): BagTakeResult {
  const coins = bag.body === undefined ? (bag.coins ?? 0) : 0;
  if (coins <= 0) return { ok: false, error: "there is no money in it" };
  const after: LootBag = { ...bag };
  delete after.coins;
  return { ok: true, sheet: { ...sheet, coins: sheet.coins + coins }, bag: after.items.length > 0 ? after : null, taken: [], coins, left: false };
}

/**
 * How much of `stack` a sheet has room for right now (0 = none): what a loot
 * window shows before the owner asks, with the same rule the take uses.
 */
export function roomFor(sheet: CharacterSheet, stack: LooseStack, env: SheetEnv): number {
  const r = placeStack(sheet, stack, env, { partial: true });
  return r.ok ? r.placed : 0;
}

// -- the loot lock: a killed character's belongings stay put while they are looted ------------------

/** Shared namespace `lootlock/<bodyId>`: this character is being looted until `until`. */
export const LOOT_LOCK_NETSTATE = "lootlock";

export const lootLockSchema = z
  .object({
    until: z.number().min(0).describe("Sim time (ms) the lock ends at the latest (the body bag's expiry)."),
    by: z.string().min(1).describe("Body id of the looter (the body bag's owner)."),
    bag: z.string().min(1).describe("The body bag (lootbag/<bagId>); the lock ends as soon as it is gone (spent, closed, expired, its owner left)."),
  })
  .describe(
    "A killed character whose belongings are being looted, keyed lootlock/<bodyId>. While it holds, their character sheet " +
      "refuses every request that moves an item or a coin (move, split, equip, unequip, drop, give away, every NPC service), " +
      "and a server keeps their body — and so their sheet — even if they disconnect, so what the looter may take is fixed " +
      "for the whole window. Authority-written by the character-sheet builtin.",
  );
export type LootLock = z.infer<typeof lootLockSchema>;

/** Whether `bodyId` is being looted at sim time `nowMs`. */
export function isLootLocked(store: { get(key: string): unknown }, bodyId: string, nowMs: number): boolean {
  const lock = store.get(`${LOOT_LOCK_NETSTATE}/${bodyId}`) as { until?: unknown } | undefined;
  return typeof lock?.until === "number" && lock.until > nowMs;
}

// -- party rolls: need / greed / pass ----------------------------------------------------------------

/** Shared namespace `lootroll/<rollId>`: one item a party is rolling for. */
export const LOOT_ROLL_NETSTATE = "lootroll";
export const ROLL_CHOICES = ["need", "greed", "pass"] as const;
export type RollChoice = (typeof ROLL_CHOICES)[number];

export const lootRollSchema = z
  .object({
    item: looseStackSchema.describe("The stack rolled for, with all its instance data (twists matter for the choice)."),
    at: point.describe("Where the winner's bag will lie (the corpse)."),
    from: z.string().optional().describe("What dropped it (a creature's id), for the prompt and the result line."),
    killer: z.string().min(1).describe("Body id of the killer: the item is theirs when everyone passes."),
    eligible: z.array(z.string().min(1)).min(1).max(40).describe("Body ids of the party members in range of the kill: each is asked once."),
    choices: z.record(z.string(), z.enum(ROLL_CHOICES)).default({}).describe("Body id → answer so far. No answer by `until` = pass."),
    until: z.number().min(0).describe("Sim time (ms) the roll is settled at, answered or not."),
  })
  .describe(
    "A party loot roll, keyed lootroll/<rollId>: every eligible member answers need, greed or pass (inventory roll event " +
      "loot.roll). Any need beats every greed; within the best tier a server-rolled 1–100 decides (ties roll again); all " +
      "pass = the killer's. The winner gets the item in a loot bag of their own at `at`. Authority-written by the " +
      "character-sheet builtin; the result is announced as loot.rolled.",
  );
export type LootRoll = z.infer<typeof lootRollSchema>;

export interface RollOutcome {
  /** Who gets the item (the killer when everyone passed). */
  winner: string;
  /** The winning tier ("pass" = all passed). */
  choice: RollChoice;
  /** The winner's 1–100, null when everyone passed. */
  roll: number | null;
  /** Every member's answer and, for the winning tier, their final roll. */
  rolls: Array<{ actorId: string; choice: RollChoice; roll?: number }>;
}

/** Whether every eligible member has answered. */
export function rollAnswered(roll: LootRoll): boolean {
  return roll.eligible.every((id) => roll.choices[id] !== undefined);
}

/**
 * Settle a roll: any need beats every greed; within the best tier each member
 * rolls `d100()` (1–100) and the highest wins, the tied rolling again among
 * themselves; no answer counts as pass; all pass = the killer's.
 */
export function resolveRoll(roll: LootRoll, d100: () => number): RollOutcome {
  const answer = (id: string): RollChoice => roll.choices[id] ?? "pass";
  const tier: RollChoice | null = roll.eligible.some((id) => answer(id) === "need")
    ? "need"
    : roll.eligible.some((id) => answer(id) === "greed")
      ? "greed"
      : null;
  const rolls: RollOutcome["rolls"] = roll.eligible.map((id) => ({ actorId: id, choice: answer(id) }));
  if (!tier) return { winner: roll.killer, choice: "pass", roll: null, rolls };
  let contenders = roll.eligible.filter((id) => answer(id) === tier);
  const final = new Map<string, number>();
  for (let round = 0; round < 50; round++) {
    let best = 0;
    for (const id of contenders) {
      const n = Math.max(1, Math.min(100, Math.floor(d100())));
      final.set(id, n);
      best = Math.max(best, n);
    }
    const top = contenders.filter((id) => final.get(id) === best);
    if (top.length === 1) break;
    contenders = top;
  }
  const winner = contenders.reduce((a, b) => ((final.get(b) ?? 0) > (final.get(a) ?? 0) ? b : a));
  for (const r of rolls) if (final.has(r.actorId)) r.roll = final.get(r.actorId)!;
  return { winner, choice: tier, roll: final.get(winner) ?? null, rolls };
}

// -- saved bags: a character's item bags outlive a logout and a restart ------------------------------

/** Per-character namespace `lootbags/<bodyId>` (saved beside the sheet): the owner's bags not live in this scene. */
export const LOOT_SAVE_NETSTATE = "lootbags";
/** Default cap on the bags one character owns, live and saved together; past it the oldest goes. */
export const LOOT_BAG_CAP = 40;

/**
 * The wall clock saved bags expire by (ms since the epoch). Sim time starts
 * again at every server start, so a lifetime of days is kept in real time;
 * tests replace `now` to step days ahead.
 */
export const lootClock = { now: (): number => Date.now() };

const savedBagSchema = z.object({
  id: z.string().min(1).describe("The bag id it is live under (lootbag/<id>)."),
  scene: z.string().min(1).describe("Scene it lies in: it is live only while its owner is online in that scene."),
  at: point,
  items: z.array(looseStackSchema).max(64).default([]),
  coins: z.number().int().min(0).optional(),
  from: z.string().optional(),
  made: z.number().min(0).optional().describe("Wall-clock ms it was made."),
  expires: z.number().min(0).optional().describe("Wall-clock ms it disappears at; absent = until emptied."),
  dropped: z.boolean().optional().describe("A bag of dropped items (short-lived) rather than earned loot."),
  corpse: z.boolean().optional().describe("The owner's own CORPSE (what they carried when they died): never evicted by the cap."),
});
export type SavedBag = z.infer<typeof savedBagSchema>;

export const savedBagsSchema = z
  .object({
    owner: z.string().min(1).describe("Body id of the character these bags belong to (the record is sent to them alone)."),
    bags: z.array(savedBagSchema).max(400).default([]).describe("Bags lying in OTHER scenes than the one the owner is in (packed in on save)."),
  })
  .describe(
    "A character's saved loot bags, keyed lootbags/<bodyId> and saved beside the sheet. A server unpacks the bags of the " +
      "scene the character spawns in into lootbag/<id> (lifetimes converted from wall-clock to sim time) and keeps the rest " +
      "here; on every save it packs the live ones back in. Item bags only: a body bag belongs to one session.",
  );
export type SavedBags = z.infer<typeof savedBagsSchema>;

/**
 * Spawn: the saved bags of `scene` that have not expired become live bags
 * (`until` in this server's sim time); every other scene's stay `dormant`.
 * An expired bag is dropped.
 */
export function unpackSavedBags(
  record: unknown,
  scene: string,
  simNow: number,
  wallNow: number = lootClock.now(),
): { live: Array<[string, LootBag]>; dormant: SavedBags | null } {
  const parsed = savedBagsSchema.safeParse(record);
  if (!parsed.success) return { live: [], dormant: null };
  const live: Array<[string, LootBag]> = [];
  const dormant: SavedBag[] = [];
  for (const bag of parsed.data.bags) {
    if (bag.expires !== undefined && bag.expires <= wallNow) continue;
    if (bag.scene !== scene) {
      dormant.push(bag);
      continue;
    }
    const until = bag.expires !== undefined ? simNow + (bag.expires - wallNow) : undefined;
    const made = lootBag(parsed.data.owner, bag.at, bag.items, { until, from: bag.from, coins: bag.coins, made: bag.made, dropped: bag.dropped });
    live.push([bag.id, bag.corpse ? { ...made, corpse: parsed.data.owner } : made]);
  }
  return { live, dormant: { owner: parsed.data.owner, bags: dormant } };
}

/**
 * Save: the owner's live ITEM bags in `scene` (lifetimes back to wall-clock)
 * plus the dormant ones of other scenes, expired ones dropped, the newest
 * `cap` kept.
 */
export function packSavedBags(
  owner: string,
  dormant: unknown,
  live: ReadonlyArray<readonly [string, LootBag]>,
  scene: string,
  simNow: number,
  wallNow: number = lootClock.now(),
  cap: number = LOOT_BAG_CAP,
): SavedBags {
  const old = savedBagsSchema.safeParse(dormant);
  const bags: SavedBag[] = old.success ? old.data.bags.filter((b) => b.scene !== scene && (b.expires === undefined || b.expires > wallNow)) : [];
  for (const [id, bag] of live) {
    // a corpse is its dead character's even while a killer's claim holds it (saved released: the claim is one session's)
    if (bagKeeper(bag) !== owner || bag.body !== undefined) continue;
    if (bag.until !== undefined && bag.until <= simNow) continue;
    bags.push({
      id,
      scene,
      at: [bag.at[0], bag.at[1], bag.at[2]],
      items: bag.items.map((s) => ({ ...s })),
      ...(bag.coins ? { coins: bag.coins } : {}),
      ...(bag.from ? { from: bag.from } : {}),
      made: bag.made ?? wallNow,
      ...(bag.until !== undefined ? { expires: wallNow + (bag.until - simNow) } : {}),
      ...(bag.dropped ? { dropped: true } : {}),
      ...(bag.corpse ? { corpse: true } : {}),
    });
  }
  bags.sort((a, b) => (a.made ?? 0) - (b.made ?? 0));
  // the cap is on EARNED bags; dropped ones are few (dropCap) and gone in minutes
  const earned = bags.filter((b) => !b.dropped && !b.corpse);
  const keep = new Set(earned.slice(Math.max(0, earned.length - cap)));
  return { owner, bags: bags.filter((b) => b.dropped || b.corpse || keep.has(b)) };
}

// -- corpses: what a dead character carried, waiting for them (or, for a while, their killer) ---------

/** Whose bag it is for saving and clean-up: a corpse is its dead character's, even while a killer's claim holds it. */
export function bagKeeper(bag: Pick<LootBag, "owner" | "corpse">): string {
  return bag.corpse ?? bag.owner;
}

/** Whether a corpse is under a killer's claim (owned by someone other than the dead character). */
export function corpseClaimed(bag: Pick<LootBag, "owner" | "corpse">): boolean {
  return bag.corpse !== undefined && bag.owner !== bag.corpse;
}

/** The dead character a bag lets its owner take worn gear from: a body bag's `body`, a claimed corpse's `corpse`. */
export function bagVictim(bag: Pick<LootBag, "owner" | "corpse" | "body">): string | undefined {
  return bag.body ?? (corpseClaimed(bag) ? bag.corpse : undefined);
}

/**
 * A claim is over: the corpse passes to the dead character, its worn-gear
 * choice gone. Null when nothing is left in it (delete it instead).
 */
export function releaseCorpse(bag: LootBag): LootBag | null {
  if (bag.corpse === undefined) return bag;
  const next: LootBag = { ...bag, owner: bag.corpse, items: bag.items.map((s) => ({ ...s })) };
  delete next.claimUntil;
  delete next.offer;
  delete next.takes;
  delete next.plunder;
  return next.items.length > 0 || (next.coins ?? 0) > 0 ? next : null;
}

/**
 * What leaves a character into their corpse at a death: every stack in their
 * grids (pockets and bag) but the ENTRUSTED, with its instance data, and all
 * their copper. Worn gear stays on them. Returns the emptied sheet.
 */
export function corpseContents(sheet: CharacterSheet, env: Pick<SheetEnv, "catalog">): { sheet: CharacterSheet; items: LooseStack[]; coins: number } {
  const next = structuredClone(sheet);
  const items: LooseStack[] = [];
  for (const [uid, stack] of Object.entries(sheet.items)) {
    if (stack.container === undefined || isEntrusted(env, stack.itemId)) continue;
    items.push({ itemId: stack.itemId, qty: stack.qty, ...instanceOf(stack) });
    delete next.items[uid];
  }
  // a timed move of something that is gone cannot land
  if (next.inventoryAction && !next.items[next.inventoryAction.command.uid]) delete next.inventoryAction;
  const coins = sheet.coins;
  next.coins = 0;
  return { sheet: next, items, coins };
}

/** Whether a character may not lose another worn item right now (sheet `plunderedUntil`, wall clock). */
export function isPlundered(sheet: Pick<CharacterSheet, "plunderedUntil"> | null | undefined, wallNow: number = lootClock.now()): boolean {
  return (sheet?.plunderedUntil ?? 0) > wallNow;
}

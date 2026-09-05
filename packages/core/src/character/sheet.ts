import { z } from "zod";
import {
  ATTRIBUTES,
  DERIVED_STATS,
  EQUIPMENT_SLOTS,
  itemFitsSlot,
  type Attribute,
  type DerivedStat,
  type EquipmentSlot,
  type GridSize,
  type Item,
} from "./items.js";
import {
  DEFAULT_PROGRESSION,
  evaluateFormula,
  levelForXp,
  xpForLevel,
  type Progression,
} from "./progression.js";

/**
 * The character sheet: level, experience, attributes, and every item the
 * character owns — worn or carried — as ONE JSON value.
 *
 * It is a document, not an object graph, because it travels: the authority
 * writes it to netState (`character/<bodyId>`), every peer renders from the
 * replica, and the local player's copy is what playerData persists. Keeping
 * it one value means one schema validates all three.
 *
 * Every mutation is a PURE reducer below: take a sheet, return a new sheet or
 * a plain-English error. Nothing here throws on a bad request — a request is
 * something a client asked for, and "that doesn't fit" is an answer, not an
 * exception. Only the session authority applies these; a client only ever
 * asks (see the `character-sheet` script in @hitreg/scripting).
 *
 * Grid model: two containers of square cells, `pockets` (always present,
 * sized by the progression) and `bag` (present while a bag item is worn,
 * sized by that item). Every stack occupies exactly one cell (x, y).
 */

export const CONTAINERS = ["pockets", "bag"] as const;
export type Container = (typeof CONTAINERS)[number];

export const itemStackSchema = z.object({
  itemId: z.string().min(1),
  qty: z.number().int().min(1).default(1),
  container: z
    .enum(CONTAINERS)
    .optional()
    .describe("Which grid the stack sits in. Absent = worn; find its slot in `equipment`."),
  x: z.number().int().min(0).optional().describe("Column of the stack's cell."),
  y: z.number().int().min(0).optional().describe("Row of the stack's cell."),
});
export type ItemStack = z.infer<typeof itemStackSchema>;

const attributeInts = Object.fromEntries(
  ATTRIBUTES.map((a) => [a, z.number().int().min(0).default(10)]),
) as Record<Attribute, z.ZodDefault<z.ZodNumber>>;

export const characterSheetSchema = z
  .object({
    version: z.literal(1).default(1),
    level: z.number().int().min(1).default(1),
    xp: z
      .number()
      .int()
      .min(0)
      .default(0)
      .describe("Total experience earned. Level is derived from it through the progression curve, never edited directly."),
    unspent: z.number().int().min(0).default(0).describe("Attribute points earned but not yet allocated."),
    attributes: z.object(attributeInts).prefault({}).describe("Base + allocated points, before worn-item modifiers."),
    equipment: z
      .partialRecord(z.enum(EQUIPMENT_SLOTS), z.string())
      .prefault({})
      .describe("Worn items: slot id → stack uid (the stack itself lives in `items` with no container)."),
    items: z
      .record(z.string(), itemStackSchema)
      .prefault({})
      .describe("Every owned stack keyed by uid — worn ones have no container, carried ones name a grid and a cell."),
    seq: z.number().int().min(0).default(0).describe("Uid counter, so stack ids are deterministic on the authority."),
  })
  .describe(
    "A character's whole state — level, xp, attributes, worn and carried items — as one replicated value (netState `character/<bodyId>`).",
  );

export type CharacterSheet = z.infer<typeof characterSheetSchema>;

/** What the reducers need from the outside world: item definitions and the rules. */
export interface SheetEnv {
  /** Item definition by asset id; undefined = unknown item (every reducer refuses it). */
  catalog: (itemId: string) => Item | undefined;
  progression?: Progression;
}

export interface GridTarget {
  container: Container;
  x: number;
  y: number;
}

export type SheetResult<T = object> =
  | ({ ok: true; sheet: CharacterSheet } & T)
  | { ok: false; error: string };

const fail = (error: string): { ok: false; error: string } => ({ ok: false, error });
const rules = (env: SheetEnv): Progression => env.progression ?? DEFAULT_PROGRESSION;

// -- construction ----------------------------------------------------------------

/** A fresh sheet at `level` (default 1) with the progression's base attributes and the points a level implies. */
export function createSheet(progression: Progression = DEFAULT_PROGRESSION, level = 1): CharacterSheet {
  const lvl = Math.max(1, Math.min(progression.maxLevel, Math.floor(level)));
  return characterSheetSchema.parse({
    level: lvl,
    xp: xpForLevel(lvl, progression),
    unspent: (lvl - 1) * progression.pointsPerLevel,
    attributes: { ...progression.baseAttributes },
  });
}

// -- geometry ---------------------------------------------------------------------

/** The grid a container currently has; null when there is no bag worn. */
export function gridOf(sheet: CharacterSheet, container: Container, env: SheetEnv): GridSize | null {
  if (container === "pockets") return rules(env).pockets;
  const bagUid = sheet.equipment.bag;
  if (!bagUid) return null;
  const stack = sheet.items[bagUid];
  const item = stack ? env.catalog(stack.itemId) : undefined;
  return item?.bag ?? null;
}

/**
 * The stack occupying a cell (ignoring `ignore`), or null when it is free.
 * Fails when the cell is outside the grid or the grid does not exist.
 */
export function cellAt(
  sheet: CharacterSheet,
  container: Container,
  x: number,
  y: number,
  env: SheetEnv,
  ignore: ReadonlySet<string> = new Set(),
): { ok: true; occupant: string | null } | { ok: false; error: string } {
  const grid = gridOf(sheet, container, env);
  if (!grid) return fail("no bag is worn");
  if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0 || x >= grid.cols || y >= grid.rows) {
    return fail(`(${x}, ${y}) is outside the ${container} (${grid.cols}x${grid.rows})`);
  }
  for (const [uid, stack] of Object.entries(sheet.items)) {
    if (ignore.has(uid) || stack.container !== container) continue;
    if (stack.x === x && stack.y === y) return { ok: true, occupant: uid };
  }
  return { ok: true, occupant: null };
}

/** First free cell (row-major) in a container, or null. */
export function firstFit(
  sheet: CharacterSheet,
  container: Container,
  env: SheetEnv,
  ignore: ReadonlySet<string> = new Set(),
): { x: number; y: number } | null {
  const grid = gridOf(sheet, container, env);
  if (!grid) return null;
  const taken = new Set<string>();
  for (const [uid, stack] of Object.entries(sheet.items)) {
    if (!ignore.has(uid) && stack.container === container) taken.add(`${stack.x},${stack.y}`);
  }
  for (let y = 0; y < grid.rows; y++) {
    for (let x = 0; x < grid.cols; x++) {
      if (!taken.has(`${x},${y}`)) return { x, y };
    }
  }
  return null;
}

/** First free cell across containers in order (bag first — it is the big one). */
export function autoPlace(
  sheet: CharacterSheet,
  env: SheetEnv,
  containers: readonly Container[] = ["bag", "pockets"],
  ignore: ReadonlySet<string> = new Set(),
): GridTarget | null {
  for (const container of containers) {
    const cell = firstFit(sheet, container, env, ignore);
    if (cell) return { container, ...cell };
  }
  return null;
}

// -- stats -----------------------------------------------------------------------

export interface DerivedSheet {
  level: number;
  /** Base + allocated + worn-item attribute modifiers. */
  attributes: Record<Attribute, number>;
  stats: Record<DerivedStat, number>;
  /** Kilograms of everything owned, worn or carried. */
  weight: number;
  /** `weight / capacity`, unclamped — above 1 the character is overweight. */
  encumbrance: number;
  /** Total experience at which the current level began. */
  levelXp: number;
  /** Total experience needed for the next level, or null at the cap. */
  nextLevelXp: number | null;
  /** The grids this sheet currently has — pockets always, bag while one is worn. */
  grids: { pockets: GridSize; bag: GridSize | null };
}

function wornItems(sheet: CharacterSheet, env: SheetEnv): Item[] {
  const out: Item[] = [];
  for (const uid of Object.values(sheet.equipment)) {
    const stack = uid ? sheet.items[uid] : undefined;
    const item = stack ? env.catalog(stack.itemId) : undefined;
    if (item) out.push(item);
  }
  return out;
}

export function effectiveAttributes(sheet: CharacterSheet, env: SheetEnv): Record<Attribute, number> {
  const out = { ...sheet.attributes } as Record<Attribute, number>;
  for (const item of wornItems(sheet, env)) {
    for (const a of ATTRIBUTES) {
      const m = item.modifiers[a];
      if (typeof m === "number") out[a] += m;
    }
  }
  return out;
}

/** Everything a HUD or a combat script reads off a sheet, computed in one pass. */
export function derivedStats(sheet: CharacterSheet, env: SheetEnv): DerivedSheet {
  const p = rules(env);
  const attributes = effectiveAttributes(sheet, env);
  const worn = wornItems(sheet, env);
  const stats = {} as Record<DerivedStat, number>;
  for (const s of DERIVED_STATS) {
    let v = evaluateFormula(p.derived[s], attributes);
    for (const item of worn) {
      const m = item.modifiers[s];
      if (typeof m === "number") v += m;
    }
    stats[s] = v;
  }
  let weight = 0;
  for (const stack of Object.values(sheet.items)) {
    const item = env.catalog(stack.itemId);
    if (item) weight += item.weight * stack.qty;
  }
  weight = Math.round(weight * 1000) / 1000;
  const capacity = stats.capacity;
  return {
    level: sheet.level,
    attributes,
    stats,
    weight,
    encumbrance: capacity > 0 ? weight / capacity : weight > 0 ? Infinity : 0,
    levelXp: xpForLevel(sheet.level, p),
    nextLevelXp: sheet.level >= p.maxLevel ? null : xpForLevel(sheet.level + 1, p),
    grids: { pockets: p.pockets, bag: gridOf(sheet, "bag", env) },
  };
}

/** Why an item cannot be worn right now, or null when it can. */
export function requirementError(item: Item, sheet: CharacterSheet, env: SheetEnv): string | null {
  const req = item.requires;
  if (req.level !== undefined && sheet.level < req.level) return `${item.name} needs level ${req.level}`;
  const attrs = effectiveAttributes(sheet, env);
  for (const a of ATTRIBUTES) {
    const need = req[a];
    if (need !== undefined && attrs[a] < need) return `${item.name} needs ${need} ${a}`;
  }
  return null;
}

// -- progression reducers -----------------------------------------------------

/** Add experience; levels roll over automatically and each grants `pointsPerLevel`. */
export function grantXp(
  sheet: CharacterSheet,
  amount: number,
  env: SheetEnv,
): SheetResult<{ levelsGained: number }> {
  if (!Number.isFinite(amount) || amount < 0) return fail("xp must be a non-negative number");
  const p = rules(env);
  const next = structuredClone(sheet);
  next.xp += Math.floor(amount);
  const level = levelForXp(next.xp, p);
  const levelsGained = Math.max(0, level - next.level);
  if (levelsGained > 0) {
    next.level = level;
    next.unspent += levelsGained * p.pointsPerLevel;
  }
  return { ok: true, sheet: next, levelsGained };
}

/** Spend one unspent point on an attribute. */
export function allocate(sheet: CharacterSheet, attribute: Attribute, _env: SheetEnv): SheetResult {
  if (!ATTRIBUTES.includes(attribute)) return fail(`unknown attribute "${attribute}"`);
  if (sheet.unspent <= 0) return fail("no unspent points");
  const next = structuredClone(sheet);
  next.unspent -= 1;
  next.attributes[attribute] += 1;
  return { ok: true, sheet: next };
}

// -- inventory reducers ---------------------------------------------------------

function nextUid(sheet: CharacterSheet): string {
  sheet.seq += 1;
  return `i${sheet.seq}`;
}

/** The slot a stack is worn in, or null when it is carried. */
export function slotOf(sheet: CharacterSheet, uid: string): EquipmentSlot | null {
  for (const slot of EQUIPMENT_SLOTS) if (sheet.equipment[slot] === uid) return slot;
  return null;
}

function bagContents(sheet: CharacterSheet, except?: string): string[] {
  return Object.entries(sheet.items)
    .filter(([uid, s]) => s.container === "bag" && uid !== except)
    .map(([uid]) => uid);
}

/**
 * Give `qty` of an item: top up carried stacks first, then open new stacks
 * where cells are free (bag, then pockets). Partial success is reported
 * through `placed` — "no room" is only an error when nothing at all fit.
 */
export function addItem(
  sheet: CharacterSheet,
  itemId: string,
  qty: number,
  env: SheetEnv,
): SheetResult<{ placed: number; uids: string[] }> {
  const item = env.catalog(itemId);
  if (!item) return fail(`unknown item "${itemId}"`);
  if (!Number.isInteger(qty) || qty < 1) return fail("qty must be a positive integer");
  const next = structuredClone(sheet);
  let remaining = qty;
  const uids: string[] = [];
  if (item.stack > 1) {
    for (const [uid, stack] of Object.entries(next.items)) {
      if (remaining === 0) break;
      if (stack.itemId !== itemId || stack.container === undefined || stack.qty >= item.stack) continue;
      const take = Math.min(remaining, item.stack - stack.qty);
      stack.qty += take;
      remaining -= take;
      uids.push(uid);
    }
  }
  while (remaining > 0) {
    const spot = autoPlace(next, env);
    if (!spot) break;
    const take = Math.min(remaining, item.stack);
    const uid = nextUid(next);
    next.items[uid] = { itemId, qty: take, ...spot };
    uids.push(uid);
    remaining -= take;
  }
  const placed = qty - remaining;
  if (placed === 0) return fail(`no room for ${item.name}`);
  return { ok: true, sheet: next, placed, uids };
}

/**
 * Move a carried stack to a cell. Landing on another stack merges (same
 * item, stackable) or swaps the two. A worn item moved to a cell is an
 * unequip.
 */
export function moveItem(sheet: CharacterSheet, uid: string, to: GridTarget, env: SheetEnv): SheetResult {
  const stack = sheet.items[uid];
  if (!stack) return fail(`no stack "${uid}"`);
  const item = env.catalog(stack.itemId);
  if (!item) return fail(`unknown item "${stack.itemId}"`);
  if (!CONTAINERS.includes(to.container)) return fail(`unknown container "${to.container}"`);
  if (stack.container === undefined) {
    const slot = slotOf(sheet, uid);
    return slot ? unequip(sheet, slot, to, env) : fail(`stack "${uid}" is neither worn nor carried`);
  }
  const from: GridTarget = { container: stack.container, x: stack.x ?? 0, y: stack.y ?? 0 };
  const probe = cellAt(sheet, to.container, to.x, to.y, env, new Set([uid]));
  if (!probe.ok) return probe;
  const next = structuredClone(sheet);
  const moving = next.items[uid]!;
  if (probe.occupant === null) {
    Object.assign(moving, to);
    return { ok: true, sheet: next };
  }
  const other = next.items[probe.occupant]!;
  if (other.itemId === moving.itemId && item.stack > 1) {
    const take = Math.min(moving.qty, item.stack - other.qty);
    if (take <= 0) return fail(`${item.name} stack is full`);
    other.qty += take;
    moving.qty -= take;
    if (moving.qty === 0) delete next.items[uid];
    return { ok: true, sheet: next };
  }
  Object.assign(moving, to);
  Object.assign(other, from);
  return { ok: true, sheet: next };
}

/**
 * Wear a carried stack. `slot` defaults to the first accepting empty slot
 * (then the first accepting one). Whatever was worn there goes back where
 * this item came from, or to the first free cell — never lost, or refused.
 */
export function equip(
  sheet: CharacterSheet,
  uid: string,
  slot: EquipmentSlot | undefined,
  env: SheetEnv,
): SheetResult {
  const stack = sheet.items[uid];
  if (!stack) return fail(`no stack "${uid}"`);
  const item = env.catalog(stack.itemId);
  if (!item) return fail(`unknown item "${stack.itemId}"`);
  if (item.slots.length === 0) return fail(`${item.name} cannot be worn`);
  if (slot !== undefined && !EQUIPMENT_SLOTS.includes(slot)) return fail(`unknown slot "${slot}"`);
  if (slot !== undefined && !itemFitsSlot(item, slot)) return fail(`${item.name} does not go in the ${slot} slot`);
  if (stack.qty !== 1) return fail(`split ${item.name} down to one before wearing it`);
  const accepting = EQUIPMENT_SLOTS.filter((s) => itemFitsSlot(item, s));
  const target = slot ?? accepting.find((s) => !sheet.equipment[s]) ?? accepting[0]!;
  const req = requirementError(item, sheet, env);
  if (req) return fail(req);

  const wornSlot = slotOf(sheet, uid);
  const next = structuredClone(sheet);
  const occupantUid = next.equipment[target];
  if (occupantUid === uid) return { ok: true, sheet: next };

  if (wornSlot !== null) {
    // already worn: change slots (sword primary → secondary), swapping if needed
    if (occupantUid) {
      const occupant = env.catalog(next.items[occupantUid]!.itemId);
      if (!occupant || !itemFitsSlot(occupant, wornSlot)) {
        return fail(`${occupant?.name ?? "that item"} cannot move to the ${wornSlot} slot`);
      }
      next.equipment[wornSlot] = occupantUid;
    } else {
      delete next.equipment[wornSlot];
    }
    next.equipment[target] = uid;
    return { ok: true, sheet: next };
  }

  if (target === "bag" && bagContents(next, uid).length > 0) return fail("empty the bag first");

  const from: GridTarget = { container: stack.container!, x: stack.x ?? 0, y: stack.y ?? 0 };
  const moving = next.items[uid]!;
  delete moving.container;
  delete moving.x;
  delete moving.y;
  next.equipment[target] = uid;

  if (occupantUid) {
    const occupant = next.items[occupantUid]!;
    const occupantItem = env.catalog(occupant.itemId);
    if (!occupantItem) return fail(`unknown item "${occupant.itemId}"`);
    // a displaced bag may not go into the bag that replaced it
    const containers: readonly Container[] = target === "bag" ? ["pockets"] : ["bag", "pockets"];
    let spot: GridTarget | null = null;
    if (containers.includes(from.container)) {
      const back = cellAt(next, from.container, from.x, from.y, env);
      if (back.ok && back.occupant === null) spot = from;
    }
    spot ??= autoPlace(next, env, containers);
    if (!spot) return fail(`no room to take off ${occupantItem.name}`);
    Object.assign(occupant, spot);
  }
  return { ok: true, sheet: next };
}

/** Take off a worn item into a cell (`to`) or the first free one. */
export function unequip(
  sheet: CharacterSheet,
  slot: EquipmentSlot,
  to: GridTarget | undefined,
  env: SheetEnv,
): SheetResult {
  if (!EQUIPMENT_SLOTS.includes(slot)) return fail(`unknown slot "${slot}"`);
  const uid = sheet.equipment[slot];
  if (!uid) return fail(`nothing is worn in the ${slot} slot`);
  const stack = sheet.items[uid]!;
  const item = env.catalog(stack.itemId);
  if (!item) return fail(`unknown item "${stack.itemId}"`);
  if (slot === "bag" && bagContents(sheet).length > 0) return fail("empty the bag first");
  if (slot === "bag" && to?.container === "bag") return fail("a bag cannot go inside itself");
  const next = structuredClone(sheet);
  let spot: GridTarget | null;
  if (to) {
    const probe = cellAt(next, to.container, to.x, to.y, env);
    if (!probe.ok) return probe;
    if (probe.occupant !== null) return fail("that cell is taken");
    spot = to;
  } else {
    spot = autoPlace(next, env, slot === "bag" ? ["pockets"] : ["bag", "pockets"]);
    if (!spot) return fail(`no room to take off ${item.name}`);
  }
  delete next.equipment[slot];
  Object.assign(next.items[uid]!, spot);
  return { ok: true, sheet: next };
}

/** Remove `qty` (default: the whole stack) — dropped, consumed, sold. */
export function removeItem(
  sheet: CharacterSheet,
  uid: string,
  qty: number | undefined,
  env: SheetEnv,
): SheetResult<{ removed: { itemId: string; qty: number } }> {
  const stack = sheet.items[uid];
  if (!stack) return fail(`no stack "${uid}"`);
  const take = qty === undefined ? stack.qty : qty;
  if (!Number.isInteger(take) || take < 1 || take > stack.qty) return fail(`cannot remove ${take} of ${stack.qty}`);
  const slot = slotOf(sheet, uid);
  if (slot === "bag" && bagContents(sheet).length > 0) return fail("empty the bag first");
  const next = structuredClone(sheet);
  if (take === stack.qty) {
    delete next.items[uid];
    if (slot) delete next.equipment[slot];
  } else {
    next.items[uid]!.qty -= take;
  }
  return { ok: true, sheet: next, removed: { itemId: stack.itemId, qty: take } };
}

/** Split `qty` off a carried stack into a free cell. */
export function splitStack(
  sheet: CharacterSheet,
  uid: string,
  qty: number,
  to: GridTarget,
  env: SheetEnv,
): SheetResult<{ uid: string }> {
  const stack = sheet.items[uid];
  if (!stack) return fail(`no stack "${uid}"`);
  if (stack.container === undefined) return fail("take it off before splitting it");
  const item = env.catalog(stack.itemId);
  if (!item) return fail(`unknown item "${stack.itemId}"`);
  if (!Number.isInteger(qty) || qty < 1 || qty >= stack.qty) {
    return fail(`cannot split ${qty} off a stack of ${stack.qty}`);
  }
  const probe = cellAt(sheet, to.container, to.x, to.y, env);
  if (!probe.ok) return probe;
  if (probe.occupant !== null) return fail("that cell is taken");
  const next = structuredClone(sheet);
  next.items[uid]!.qty -= qty;
  const newUid = nextUid(next);
  next.items[newUid] = { itemId: stack.itemId, qty, ...to };
  return { ok: true, sheet: next, uid: newUid };
}

import type { ItemStack } from "./sheet.js";

/**
 * Item INSTANCE data: everything a stack carries beyond what it is and where it
 * sits — today its wear (`durability`) and its rolled `twists`, tomorrow any
 * other per-instance field a stack schema grows. The engine treats it as
 * OPAQUE: these helpers never name a field, so a new one travels everywhere
 * the moment it is on the stack schema.
 *
 * One rule, one path: an item that changes hands or place (a drop and a pickup,
 * the vault, a shop's buy-back shelf, a trade, a split) carries its instance
 * data with it. Nothing is ever dropped silently; a game may name fields it
 * wants RESET on a transfer (`reset`), and only those go.
 *
 * Two stacks are the same kind of thing only when their instance data is
 * identical, so a twisted or worn instance never merges into a plain one.
 */

/** The fields that say what a stack IS and WHERE it is; every other field is instance data. */
export const PLACEMENT_FIELDS = ["itemId", "qty", "container", "x", "y"] as const;
export type PlacementField = (typeof PLACEMENT_FIELDS)[number];

/** A stack's per-instance data (durability, twists, …), without what and where. */
export type InstanceData = Omit<ItemStack, PlacementField>;

const placement = new Set<string>(PLACEMENT_FIELDS);

/** Empty arrays and objects mean the same as absent (`twists: []` is the plain item). */
function present(v: unknown): boolean {
  if (v === undefined || v === null) return false;
  if (Array.isArray(v)) return v.length > 0;
  if (typeof v === "object") return Object.keys(v as object).length > 0;
  return true;
}

/**
 * A deep copy of a stack's instance data, absent fields omitted. `reset` names
 * fields the game has marked as resettable on this move; they are left out.
 */
export function instanceOf(stack: object, opts: { reset?: readonly string[] } = {}): InstanceData {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(stack)) {
    if (placement.has(k) || !present(v) || opts.reset?.includes(k)) continue;
    out[k] = typeof v === "object" ? structuredClone(v) : v;
  }
  return out as InstanceData;
}

/** Key-sorted JSON, so two equal values compare equal whatever order their keys were written in. */
function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v && typeof v === "object") {
    const keys = Object.keys(v as object).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`).join(",")}}`;
  }
  return JSON.stringify(v);
}

/** Whether two stacks carry identical instance data (both plain counts). */
export function sameInstance(a: object, b: object): boolean {
  return canonical(instanceOf(a)) === canonical(instanceOf(b));
}

/** Whether instance data is present at all (a worn, twisted, … instance rather than the plain item). */
export function hasInstanceData(stack: object): boolean {
  return Object.keys(instanceOf(stack)).length > 0;
}

/**
 * Whether stack `b` may be topped up from stack `a`: the same item, an item
 * that stacks, and identical instance data. The one merge rule — the bags,
 * the vault, a shop's shelf and the ground all ask it.
 */
export function canMerge(a: { itemId: string }, b: { itemId: string }, stackSize: number): boolean {
  return a.itemId === b.itemId && stackSize > 1 && sameInstance(a, b);
}

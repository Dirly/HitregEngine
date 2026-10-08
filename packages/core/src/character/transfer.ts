import { z } from "zod";
import { instanceOf } from "./instance.js";
import {
  looseStackSchema,
  placeStack,
  removeItem,
  slotOf,
  type CharacterSheet,
  type GridTarget,
  type LooseStack,
  type SheetEnv,
} from "./sheet.js";
import { isEntrusted, soulProtected } from "./soulbind.js";

/**
 * Items changing hands between characters, and through the world: one
 * primitive each, both built on `removeItem` (which hands back the loose
 * stack WITH its instance data) and `placeStack` (which lands it with that
 * data, merging only into identical instances). Nothing here knows what a
 * twist or a wear point is; whatever is on the stack goes with it.
 */

// -- items on the ground ------------------------------------------------------------------------

/** The replicated namespace a dropped item lies in until it is picked up or expires: `ground/<dropId>`. */
export const GROUND_NETSTATE = "ground";

export const groundItemSchema = looseStackSchema
  .extend({
    at: z.tuple([z.number(), z.number(), z.number()]).describe("World point it lies at."),
    by: z.string().min(1).describe("Body id of the character that dropped it."),
    until: z
      .number()
      .min(0)
      .optional()
      .describe("Sim time (ms) it disappears at, unpicked; absent = it lies there until picked up (or the server restarts)."),
  })
  .describe(
    "An item lying in the world, keyed ground/<dropId>: the dropped stack with ALL its instance data (wear, twists), so " +
      "whoever picks it up (inventory.pickup) gets the same item. Authority-written by the character-sheet builtin; not saved.",
  );
export type GroundItem = z.infer<typeof groundItemSchema>;

/** A ground item for a stack that left a sheet (`removeItem().removed`). */
export function groundItem(stack: LooseStack, at: readonly [number, number, number], by: string, until?: number): GroundItem {
  return { itemId: stack.itemId, qty: stack.qty, ...instanceOf(stack), at: [at[0], at[1], at[2]], by, ...(until !== undefined ? { until } : {}) };
}

/**
 * Pick a ground item up into a sheet. What fits comes in with its instance
 * data; what does not stays on the ground (`left`, null when all of it came).
 */
export function pickUp(
  sheet: CharacterSheet,
  ground: GroundItem,
  env: SheetEnv,
): { ok: true; sheet: CharacterSheet; uids: string[]; left: GroundItem | null } | { ok: false; error: string } {
  const r = placeStack(sheet, ground, env, { partial: true });
  if (!r.ok) return r;
  const left = r.placed < ground.qty ? { ...structuredClone(ground), qty: ground.qty - r.placed } : null;
  return { ok: true, sheet: r.sheet, uids: r.uids, left };
}

// -- character to character -----------------------------------------------------------------------

export interface StackTransferOptions {
  /** Cell in the receiver's bags to land in; default the usual top-up then first free cell. */
  to?: GridTarget;
  /** Let a WORN stack be taken (looting a body); a trade only moves carried ones. */
  allowWorn?: boolean;
  /** Instance fields the game has marked resettable on this transfer; everything else always travels. */
  reset?: readonly string[];
}

export type StackTransferResult =
  | { ok: true; from: CharacterSheet; to: CharacterSheet; moved: LooseStack; uids: string[] }
  | { ok: false; error: string };

/**
 * Move `qty` (default all) of stack `uid` from one character's sheet to
 * another's, atomically: both new sheets or neither. The stack keeps its
 * instance data; the receiver must have room for ALL of it (a trade never
 * half-happens). The two sheets may use different catalogs (one each).
 */
export function transferStack(
  from: CharacterSheet,
  to: CharacterSheet,
  uid: string,
  qty: number | undefined,
  env: SheetEnv,
  opts: StackTransferOptions = {},
  envTo: SheetEnv = env,
): StackTransferResult {
  const stack = from.items[uid];
  if (!stack) return { ok: false, error: "no such item" };
  // never changes hands, whatever the caller allows: worn in its soulbound slot, or entrusted to its holder
  if (soulProtected(from, uid)) return { ok: false, error: "it is soulbound" };
  if (isEntrusted(env, stack.itemId)) return { ok: false, error: "it is entrusted" };
  if (!opts.allowWorn && (stack.container === undefined || slotOf(from, uid) !== null)) return { ok: false, error: "take it off first" };
  const removed = removeItem(from, uid, qty, env);
  if (!removed.ok) return removed;
  const moved: LooseStack = { itemId: removed.removed.itemId, qty: removed.removed.qty, ...instanceOf(removed.removed, { reset: opts.reset }) };
  const placed = placeStack(to, moved, envTo, { to: opts.to });
  if (!placed.ok) return { ok: false, error: placed.error.startsWith("no room") || placed.error.startsWith("not enough room") ? "no room in their bags" : placed.error };
  return { ok: true, from: removed.sheet, to: placed.sheet, moved, uids: placed.uids };
}

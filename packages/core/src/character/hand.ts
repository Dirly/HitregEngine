import { z } from "zod";
import type { EquipmentSlot, Item } from "./items.js";
import type { CharacterSheet, SheetEnv } from "./sheet.js";

/**
 * The weapon SET a body has in hand. The doll holds two: set 0 is `primary`
 * plus `offhand`, set 1 is `secondary` alone. Swapping is a timed request
 * (`character.swap`, answered by the `character-sheet` authority) that is
 * allowed in combat — unlike equipping, which is not.
 *
 * Replicated as netState `hand/<bodyId>` so every tab draws the same set
 * (`weapon-stance`, `equipment-look`) and a HUD can show the swap's progress.
 * Absent = set 0, nothing pending: a game that never swaps never sees it.
 */
export const HAND_NETSTATE = "hand";

export function handKey(bodyId: string): string {
  return `${HAND_NETSTATE}/${bodyId}`;
}

const handSet = z.union([z.literal(0), z.literal(1)]);

export const handStateSchema = z
  .object({
    set: handSet.default(0).describe("Set in hand: 0 = primary + offhand, 1 = secondary."),
    swapTo: handSet.optional().describe("The set a swap in progress will land on; absent = no swap pending."),
    swapFrom: z.number().min(0).optional().describe("Sim time (ctx.now() ms) the pending swap began."),
    swapUntil: z.number().min(0).optional().describe("Sim time (ctx.now() ms) the pending swap completes."),
  })
  .describe(
    "A body's weapon set in hand, keyed hand/<bodyId>. Authority-written by the character-sheet script on a " +
      "character.swap request from the body's owner; the stance, the held models and the game's bar follow it.",
  );
export type HandState = z.infer<typeof handStateSchema>;

/** The hand state in a store, tolerant of absence and junk (both read as set 0). */
export function readHand(store: { get(key: string): unknown }, bodyId: string): HandState {
  const parsed = handStateSchema.safeParse(store.get(handKey(bodyId)) ?? {});
  return parsed.success ? parsed.data : { set: 0 };
}

/** The slots a set puts in the hands: set 1 has no off hand. */
export function handSlots(set: 0 | 1): { main: EquipmentSlot; off: EquipmentSlot | null } {
  return set === 1 ? { main: "secondary", off: null } : { main: "primary", off: "offhand" };
}

/**
 * The items actually in hand for a set: a two-handed main item leaves the off
 * hand empty (the off-hand item stays worn, inactive). Broken items still
 * count — they are held, they just add no modifiers.
 */
export function itemsInHand(
  sheet: CharacterSheet | undefined,
  set: 0 | 1,
  env: Pick<SheetEnv, "catalog">,
): { main: Item | null; off: Item | null; mainId: string | null; offId: string | null } {
  const slots = handSlots(set);
  const idIn = (slot: EquipmentSlot | null): string | null => {
    const uid = slot ? sheet?.equipment[slot] : undefined;
    return uid ? sheet?.items[uid]?.itemId ?? null : null;
  };
  const mainId = idIn(slots.main);
  const main = mainId ? env.catalog(mainId) ?? null : null;
  const offId = main?.twoHanded ? null : idIn(slots.off);
  const off = offId ? env.catalog(offId) ?? null : null;
  return { main, off, mainId, offId: off ? offId : null };
}

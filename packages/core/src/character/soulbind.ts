import { BELT_SLOTS, EQUIPMENT_SLOTS, type EquipmentSlot } from "./items.js";
import type { CharacterSheet, SheetEnv } from "./sheet.js";

/**
 * Soulbound SLOTS: a character chooses a few equipment slots at a soul binder
 * (dialogue `openSoulbind`) and attunes each to the item worn there NOW (sheet
 * `soulslots`: slot → stack uid). An item is protected — never looted from its
 * owner, never handed to another character — only while it is WORN in its
 * attuned slot and is the attuned instance. Swap something else into the slot
 * in the field and the slot protects nothing until the next binder visit;
 * carried items are never protected. Re-attuning the same slots to new items
 * is free; changing WHICH slots are enchanted costs the binder's price.
 *
 * And ENTRUSTED items (item `entrusted`): quest items in the character's
 * keeping — never traded, dropped, vaulted, sold or looted, kept on a death.
 */

/** Slots a soul binder never enchants by default: the worn bag and the belt (a game rules what is lootable). */
export const DEFAULT_UNBINDABLE_SLOTS: readonly EquipmentSlot[] = ["bag", ...BELT_SLOTS];

/** Whether stack `uid` is protected by a soulbound slot right now: worn in a slot attuned to exactly it. */
export function soulProtected(sheet: Pick<CharacterSheet, "equipment" | "soulslots">, uid: string): boolean {
  const slots = sheet.soulslots;
  if (!slots) return false;
  for (const slot of EQUIPMENT_SLOTS) if (slots[slot] === uid && sheet.equipment[slot] === uid) return true;
  return false;
}

/** Every stack uid protected right now (worn in its attuned slot). */
export function soulProtectedUids(sheet: Pick<CharacterSheet, "equipment" | "soulslots">): string[] {
  const out: string[] = [];
  for (const slot of EQUIPMENT_SLOTS) {
    const uid = sheet.soulslots?.[slot];
    if (uid && sheet.equipment[slot] === uid) out.push(uid);
  }
  return out;
}

/**
 * What a soulbound slot means for one stack, for a tooltip: `protected` (worn in
 * its attuned slot), `swapped` (worn in an enchanted slot that is attuned to
 * another item: not protected), `carried` (the attuned item, but not worn: not
 * protected), or null when no enchanted slot concerns it.
 */
export function soulStatus(
  sheet: Pick<CharacterSheet, "equipment" | "soulslots">,
  uid: string,
): { slot: EquipmentSlot; state: "protected" | "swapped" | "carried" } | null {
  const slots = sheet.soulslots;
  if (!slots) return null;
  for (const slot of EQUIPMENT_SLOTS) {
    if (sheet.equipment[slot] !== uid || slots[slot] === undefined) continue;
    return { slot, state: slots[slot] === uid ? "protected" : "swapped" };
  }
  for (const slot of EQUIPMENT_SLOTS) if (slots[slot] === uid) return { slot, state: "carried" };
  return null;
}

/** Whether an item definition is entrusted (a quest item that never leaves its holder but through its quest). */
export function isEntrusted(env: Pick<SheetEnv, "catalog">, itemId: string): boolean {
  return env.catalog(itemId)?.entrusted === true;
}

export interface AttuneOptions {
  /** Most slots that may be enchanted (the binder's `slots`). */
  max: number;
  /** Copper charged when the SET of enchanted slots changes (a first choice is free; re-attuning the same slots is free). */
  price: number;
  /** Slots that may not be chosen (default the bag and the belt). */
  exclude?: readonly EquipmentSlot[];
}

export type AttuneResult = { ok: true; sheet: CharacterSheet; cost: number } | { ok: false; error: string };

/**
 * Enchant `slots` and attune each to the item worn there now. Refused when a
 * chosen slot is empty, excluded, repeated, or past `max`, or when a change of
 * slots costs more than the purse. An empty list clears every slot (a change).
 */
export function attuneSoulSlots(sheet: CharacterSheet, slots: readonly EquipmentSlot[], opts: AttuneOptions): AttuneResult {
  const exclude = opts.exclude ?? DEFAULT_UNBINDABLE_SLOTS;
  const chosen = [...new Set(slots)];
  if (chosen.length !== slots.length) return { ok: false, error: "choose each slot once" };
  if (chosen.length > opts.max) return { ok: false, error: `only ${opts.max} slots can be soulbound` };
  for (const slot of chosen) {
    if (!(EQUIPMENT_SLOTS as readonly string[]).includes(slot)) return { ok: false, error: `no slot "${slot}"` };
    if (exclude.includes(slot)) return { ok: false, error: `the ${slot} slot cannot be soulbound` };
    if (!sheet.equipment[slot]) return { ok: false, error: `you wear nothing in the ${slot} slot` };
  }
  const before = Object.keys(sheet.soulslots ?? {}).sort();
  const after = [...chosen].sort();
  const changed = before.length > 0 && (before.length !== after.length || before.some((s, i) => s !== after[i]));
  const cost = changed ? Math.max(0, Math.floor(opts.price)) : 0;
  if (sheet.coins < cost) return { ok: false, error: "you cannot afford to change your soulbound slots" };
  const next: CharacterSheet = { ...sheet, coins: sheet.coins - cost };
  if (chosen.length === 0) delete next.soulslots;
  else next.soulslots = Object.fromEntries(chosen.map((s) => [s, sheet.equipment[s]!])) as CharacterSheet["soulslots"];
  return { ok: true, sheet: next, cost };
}

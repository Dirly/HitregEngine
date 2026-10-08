import type { Item } from "./items.js";
import type { CharacterSheet, ItemStack, SheetEnv } from "./sheet.js";

/**
 * Item wear: an item DEFINITION may declare `durability` (its maximum points);
 * an item INSTANCE (a stack in a sheet) carries its current points in
 * `durability`, absent = full. Items without a maximum never wear (food, ore).
 *
 * The classic MMO rule: every death costs each worn item a tenth of its
 * maximum (rounded up, at least one point). At 0 the item is BROKEN — still
 * worn, still drawn, but its modifiers stop counting (sheet `derivedStats`)
 * until a repairer mends it (npc `repairItem` / `repairAll`).
 */

/** Share of an item's maximum a death costs. */
export const DEATH_WEAR = 0.1;

/** An instance's current durability, or null when its item never wears. */
export function currentDurability(stack: Pick<ItemStack, "durability">, item: Item | undefined): number | null {
  const max = item?.durability;
  if (max === undefined) return null;
  return Math.max(0, Math.min(max, stack.durability ?? max));
}

/** Worn to nothing: its stats no longer apply. */
export function isBroken(stack: Pick<ItemStack, "durability">, item: Item | undefined): boolean {
  return currentDurability(stack, item) === 0;
}

/** Points an instance is missing (0 = undamaged or never wears). */
export function missingDurability(stack: Pick<ItemStack, "durability">, item: Item | undefined): number {
  const cur = currentDurability(stack, item);
  return cur === null ? 0 : item!.durability! - cur;
}

/** Points `fraction` of a maximum costs: rounded up, at least 1. */
export function wearAmount(max: number, fraction = DEATH_WEAR): number {
  return Math.max(1, Math.ceil(max * fraction - 1e-9));
}

/**
 * Wear every WORN item that has durability by `fraction` of its maximum
 * (default 10%: the death penalty). Carried items and items without durability
 * are untouched; nothing drops below 0. Returns the same sheet when nothing wore.
 */
export function wearEquipped(sheet: CharacterSheet, env: SheetEnv, fraction = DEATH_WEAR): { sheet: CharacterSheet; worn: string[]; broke: string[] } {
  const worn: string[] = [];
  const broke: string[] = [];
  let next: CharacterSheet | null = null;
  for (const uid of new Set(Object.values(sheet.equipment))) {
    if (!uid) continue;
    const stack = sheet.items[uid];
    if (!stack || stack.container !== undefined) continue;
    const item = env.catalog(stack.itemId);
    const cur = currentDurability(stack, item);
    if (cur === null || cur === 0) continue;
    const after = Math.max(0, cur - wearAmount(item!.durability!, fraction));
    next ??= structuredClone(sheet);
    next.items[uid]!.durability = after;
    worn.push(uid);
    if (after === 0) broke.push(uid);
  }
  return { sheet: next ?? sheet, worn, broke };
}

import { EQUIPMENT_SLOTS, itemSchema, type EquipmentSlot, type Item, type LookPiece } from "@hitreg/core";
import { assetFileUrl } from "./asset-url.js";

/** Only fetch worn definitions; character selection must not load the world's item library. */
export async function selectionEquipment(
  equipment: Partial<Record<EquipmentSlot, string>>,
  read: (id: string) => Promise<unknown> = async (id) => {
    const response = await fetch(assetFileUrl(`items/${id}.json`));
    if (!response.ok) throw new Error(`Could not load equipped item ${id}`);
    return response.json();
  },
): Promise<LookPiece[]> {
  const items = new Map<string, Item>();
  await Promise.all([...new Set(Object.values(equipment))].map(async (id) => {
    if (!id) return;
    const parsed = itemSchema.parse(await read(id));
    items.set(id, parsed);
  }));
  const primary = equipment.primary ? items.get(equipment.primary) : undefined;
  return EQUIPMENT_SLOTS.flatMap((slot) => {
    // Selection poses the primary set; the spare weapon and blocked offhand are not held.
    if (slot === "secondary" || (slot === "offhand" && primary?.twoHanded)) return [];
    const id = equipment[slot];
    const look = id ? items.get(id)?.appearance : undefined;
    return look ? [{ model: look.model, parts: look.parts, texture: look.texture ?? null }] : [];
  });
}

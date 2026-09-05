import { z } from "zod";
import { hexColor } from "../components/core.js";

/**
 * Items and the vocabulary they share with the character sheet.
 *
 * An item is a data asset (`assets/items/<id>.json`, type "item"): what it is,
 * where it can be worn, how much it weighs, what it adds when worn. It is NOT
 * an instance — a sheet holds `{ itemId, qty }` stacks that point back here,
 * so editing an item file changes every copy in every inventory at once
 * (ScriptableObject semantics). Every stack takes exactly one grid cell.
 */

/**
 * Slot KINDS — what an item declares it fits (`slots: ["trinket"]`). A kind
 * may be present more than once on the doll (two trinket slots); the slot
 * IDS below are what the sheet's `equipment` is keyed by.
 */
export const SLOT_KINDS = [
  "helm",
  "gloves",
  "chest",
  "legs",
  "boots",
  "jewelry",
  "trinket",
  "primary",
  "secondary",
  "offhand",
  "bag",
] as const;
export type SlotKind = (typeof SLOT_KINDS)[number];

/** Equipment slot ids, in the order a paper doll lays them out. */
export const EQUIPMENT_SLOTS = [
  "helm",
  "gloves",
  "chest",
  "legs",
  "boots",
  "jewelry",
  "trinket",
  "trinket2",
  "primary",
  "secondary",
  "offhand",
  "bag",
] as const;
export type EquipmentSlot = (typeof EQUIPMENT_SLOTS)[number];

/** The kind a slot id accepts: `trinket2` → `trinket`. */
export function slotKind(slot: EquipmentSlot): SlotKind {
  return slot.replace(/\d+$/, "") as SlotKind;
}

/** Whether an item may be worn in a given slot id. */
export function itemFitsSlot(item: { slots: readonly SlotKind[] }, slot: EquipmentSlot): boolean {
  return item.slots.includes(slotKind(slot));
}

/** The five allocatable attributes. */
export const ATTRIBUTES = ["strength", "dexterity", "constitution", "intelligence", "wisdom"] as const;
export type Attribute = (typeof ATTRIBUTES)[number];

/**
 * Stats computed from attributes + worn items by the progression formulas.
 * `capacity` is carry weight; everything else is a pool or a flat defence.
 */
export const DERIVED_STATS = ["maxHp", "maxStamina", "maxMana", "armor", "capacity"] as const;
export type DerivedStat = (typeof DERIVED_STATS)[number];

/** Everything an item modifier may add to (flat, additive). */
export const MODIFIER_KEYS = [...ATTRIBUTES, ...DERIVED_STATS] as const;
export type ModifierKey = (typeof MODIFIER_KEYS)[number];

export const RARITIES = ["common", "uncommon", "rare", "epic", "legendary"] as const;
export type Rarity = (typeof RARITIES)[number];

export const gridSizeSchema = z.object({
  cols: z.number().int().min(1).max(16),
  rows: z.number().int().min(1).max(16),
});
export type GridSize = z.infer<typeof gridSizeSchema>;

const attributeRequirements = Object.fromEntries(
  ATTRIBUTES.map((a) => [a, z.number().int().min(0).optional()]),
) as Record<Attribute, z.ZodOptional<z.ZodNumber>>;

export const itemSchema = z
  .object({
    name: z.string().min(1),
    description: z.string().default(""),
    kind: z
      .enum(["equipment", "consumable", "material", "quest", "misc"])
      .default("misc")
      .describe("Broad category for filtering and UI grouping; `slots` decides wearability, not this."),
    slots: z
      .array(z.enum(SLOT_KINDS))
      .default([])
      .describe(
        "Slot kinds this item may be worn in (a one-handed sword: [primary, secondary]; a charm: [trinket] fits either trinket slot). Empty = carry-only.",
      ),
    stack: z
      .number()
      .int()
      .min(1)
      .max(9999)
      .default(1)
      .describe("Maximum quantity per stack (one grid cell). 1 = unique instances (every piece of gear)."),
    weight: z.number().min(0).default(0).describe("Kilograms per unit; carried AND worn items count against capacity."),
    rarity: z.enum(RARITIES).default("common"),
    icon: z
      .string()
      .optional()
      .describe("Texture asset id (assets/textures/…) drawn in the inventory cell; absent = the name's initials."),
    tint: hexColor.optional().describe("Accent colour for the cell/tooltip; defaults to the rarity colour."),
    modifiers: z
      .partialRecord(z.enum(MODIFIER_KEYS), z.number())
      .default({})
      .describe(
        "Flat additions applied while WORN: attributes (strength…) feed the formulas, derived stats (maxHp, armor…) add after them.",
      ),
    requires: z
      .object({ level: z.number().int().min(1).optional(), ...attributeRequirements })
      .default({})
      .describe("Minimums to equip, checked against the character's level and EFFECTIVE attributes (base + allocated + worn)."),
    bag: gridSizeSchema
      .optional()
      .describe("For `bag`-slot items: the grid this bag grants while worn. A bag must be empty to be swapped or removed."),
    tags: z.array(z.string()).default([]),
  })
  .describe(
    "An item definition (assets/items/<id>.json). Inventories hold { itemId, qty } stacks — one cell each — that point here, so editing a file updates every copy.",
  );

export type Item = z.infer<typeof itemSchema>;
export type ItemInput = z.input<typeof itemSchema>;

/** Colour per rarity — the UI's default tint when an item declares none. */
export const RARITY_TINT: Record<Rarity, string> = {
  common: "#b9c0d0",
  uncommon: "#5fd07a",
  rare: "#5b8cff",
  epic: "#b07cff",
  legendary: "#ffb454",
};

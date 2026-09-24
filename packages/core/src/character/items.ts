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
  "consumable",
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
  "consumable",
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

/**
 * Where on an item an effect sits: a part of its model, and a point inside
 * that part's box. Resolved against the model the item is actually drawn on, so
 * "the tip of Blade4" stays the tip when the blade is re-cut.
 */
export const itemAnchorSchema = z
  .object({
    part: z
      .string()
      .min(1)
      .optional()
      .describe("Part NAME of the model (its part table). Omitted = the box of every part the item shows."),
    at: z
      .union([z.enum(["tip", "base", "center"]), z.tuple([z.number(), z.number(), z.number()])])
      .default("center")
      .describe(
        'Point in the part\'s bounding box. "tip"/"base" are the two ends of its LONGEST axis (a blade\'s point and ' +
          'its root; the ends of a guard\'s bar), "center" its middle. Or [x, y, z] fractions of the box in the ' +
          "model's own axes, 0..1 on each — [0.5, 0.9, 0.5] is nine tenths of the way up a blade. This is how an " +
          "emitter is pinpointed.",
      ),
    offset: z
      .tuple([z.number(), z.number(), z.number()])
      .default([0, 0, 0])
      .describe("Nudge after `at`, in METRES along the model's own axes (they turn with the item)."),
  })
  .describe("A point on an item's model.");
export type ItemAnchor = z.infer<typeof itemAnchorSchema>;

export const itemEffectSchema = z
  .object({
    vfx: z
      .string()
      .min(1)
      .describe(
        "vfx data-asset id (assets/vfx/<id>.json) — WHAT plays: which particles, their sprite or texture, size, " +
          "opacity, colour ramp, rate, lifetime, plus rings, shells, beams or a light. The same assets as torches and " +
          "spells. Keep item effects in one folder (e.g. `items/embers`) so every item using one is ONE asset: " +
          "particles are batched by look, so a hundred ember swords draw their embers in one call.",
      ),
    material: z
      .string()
      .optional()
      .describe(
        "Material asset whose colours are the effect's palette (color → primary, emissive → glow, color darkened → " +
          "secondary) — recolour an effect without copying it. Omitted = the effect's own element palette.",
      ),
    anchor: itemAnchorSchema.default({ at: "center", offset: [0, 0, 0] }),
    orient: z
      .enum(["item", "world"])
      .default("item")
      .describe(
        "item = the effect turns with the item: its modules' offsets, emitter volume and `direction` are in the " +
          "MODEL's axes — on the longsword +Y runs up the blade toward the tip, ±Z out of the two edges, ±X off the " +
          "flats — so \"up the blade\" stays up the blade through every swing. world = upright in the world " +
          "(yaw only), like a torch. Gravity is always world-down either way, so drips fall and flames rise.",
      ),
    fit: z
      .union([z.boolean(), z.tuple([z.number().min(0), z.number().min(0), z.number().min(0)])])
      .default(false)
      .describe(
        "Size every particle emitter's volume (box/sphere half-extents) to the anchor part's box, so particles are " +
          "born along the WHOLE blade instead of at one point. [x, y, z] scales each axis — [1, 0.5, 1] is half the " +
          "blade's length (pair it with anchor at [0.5, 0.75, 0.5] for the upper half); 0 on an axis flattens it. " +
          "false = the effect's own shapeSize.",
      ),
    cullDistance: z
      .number()
      .min(0)
      .default(40)
      .describe("Metres from the camera past which the effect stops simulating (fades out, and back in on approach)."),
  })
  .describe("A standing effect an item carries.");
export type ItemEffect = z.infer<typeof itemEffectSchema>;

export const itemGlowSchema = z
  .object({
    color: hexColor.describe("Emissive colour added on top of the item's own texture."),
    intensity: z
      .number()
      .min(0)
      .max(20)
      .default(1)
      .describe("Multiplier on `color`. Above ~1 it reads as light; with bloom on it blooms."),
    parts: z
      .array(z.string().min(1))
      .optional()
      .describe("Part NAMES that glow (a blade, not its grip). Omitted = every part the item shows."),
    pulse: z
      .object({
        speed: z.number().min(0).default(1).describe("Pulses per second."),
        min: z.number().min(0).max(1).default(0.4).describe("Fraction of full glow at the bottom of a pulse."),
      })
      .optional()
      .describe("Breathe the glow instead of holding it steady."),
    noise: z
      .object({
        amount: z
          .number()
          .min(0)
          .max(1)
          .default(0.8)
          .describe("0 = a flat, even glow; 1 = all moving noise (dark gaps between the hot licks). The overlay the fire's ember bed uses."),
        scale: z
          .number()
          .positive()
          .default(128)
          .describe(
            "Noise cells across the WHOLE texture sheet — a blade is a thin strip of it, so this wants to be about the sheet's " +
              "texel count (128 on a 128 px sheet = one cell per texel). Much lower and a blade gets one or two cells.",
          ),
        flow: z
          .number()
          .default(0.3)
          .describe(
            "Sheet-heights per second the noise runs along the part. Positive runs toward the blade's TIP (fire " +
              "climbing), negative toward the guard (poison creeping down); 0 churns in place.",
          ),
        threshold: z
          .number()
          .min(0)
          .max(1)
          .default(0.35)
          .describe("Noise below this adds nothing. High (0.7+) = sparse glints; low = a wash."),
        churn: z
          .number()
          .min(0)
          .max(4)
          .default(1)
          .describe(
            "How fast the pattern EVOLVES in place, on top of `flow`. 1 = the fire overlay's boil; 0.2–0.4 = a slow, " +
              "oily creep (poison); 0 = a frozen pattern that only scrolls.",
          ),
        frameRate: z
          .number()
          .min(1)
          .max(60)
          .default(12)
          .describe("Steps per second the noise advances in (PSX chop). Lower = choppier and slower-looking; 12 matches the fire."),
      })
      .optional()
      .describe(
        "Make the glow MOVE: pixelated noise scrolling over the glowing parts, stepped at 12 fps in 4 bands — the " +
          "PSX look of the fire overlays. Omitted = a steady glow.",
      ),
    fade: z
      .object({
        from: z
          .number()
          .min(0)
          .max(1)
          .default(0.5)
          .describe("Where along the glowing parts' LENGTH (0 = base, 1 = tip) the glow starts from nothing."),
        to: z
          .number()
          .min(0)
          .max(1)
          .default(1)
          .describe("Where it reaches full strength. Set it below `from` to fade toward the tip instead."),
      })
      .optional()
      .describe(
        "Fade the glow along the item's length (model +Y — a blade's base to its point): { from: 0.55, to: 0.85 } " +
          "puts poison on only the last third of the blade, feathered in. With `noise` the edge dissolves through " +
          "the moving heat rather than a straight line. Batched (`moving`) models only.",
      ),
  })
  .describe(
    "Emissive glow on an item. Costs no draw call on a batched (`moving`) model: it is a per-instance value in the " +
      "same batch as every other item of that model.",
  );
export type ItemGlow = z.infer<typeof itemGlowSchema>;

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
    twoHanded: z
      .boolean()
      .default(false)
      .describe(
        "Held in BOTH hands (a greatsword, a greataxe, a staff, a bow). While it is worn in `primary`, the `offhand` item " +
          "stays equipped but INACTIVE: no modifiers, not drawn, no stance (it still counts toward weight). The offhand " +
          "slot shows greyed out. Nothing is unequipped either way.",
      ),
    stance: z
      .array(z.string().regex(/^[A-Za-z][A-Za-z0-9]*$/))
      .max(4)
      .default([])
      .describe(
        "Animation STANCES this item puts its wielder in while held, most specific first — a greataxe: " +
          '["Axe2H", "TwoHanded"] borrows every two-handed clip it has no axe version of. The character then plays ' +
          "`<Stance>_<clip>` wherever its model has one (GreatSword_Run, Staff_Attack1, SwordShield_Death). An " +
          'off-hand item\'s stance COMBINES with the main hand\'s: a Sword with a Shield is "SwordShield", then "Sword". ' +
          "Read by the `weapon-stance` script. Empty = no stance (a ring, a potion).",
      ),
    appearance: z
      .object({
        model: z
          .string()
          .min(1)
          .describe(
            "Model asset id of the UBERMESH this look is cut from (assets/models/…). The entity that shows it must " +
              "already draw this model — a look changes parts and texture, never the model.",
          ),
        parts: z
          .array(z.string().min(1))
          .default([])
          .describe(
            "Part NAMES to show, as the model's own part table spells them (unwrap-weapon writes it into the " +
              "glTF and beside it as <model>-parts.json): one of each family for a weapon — a blade, a guard, a " +
              "collar, a pommel, the grip. Every other part is hidden. Empty = nothing shows.",
          ),
        texture: z
          .string()
          .min(1)
          .optional()
          .describe(
            "Texture asset id of the theme sheet (assets/textures/…) — an atlas registered against this model's " +
              "key. Absent = the sheet baked into the model.",
          ),
        glow: itemGlowSchema.optional(),
        effects: z
          .array(itemEffectSchema)
          .max(8)
          .default([])
          .describe(
            "Standing effects this item carries while it is shown: embers off a blade, frost mist round a guard, " +
              "a light at a staff's head. Each is a `vfx` asset played for as long as the item is equipped, at a " +
              "point ON the item that follows it through every swing.",
          ),
      })
      .optional()
      .describe(
        "How this item LOOKS when worn: a choice of parts from a modular model plus a theme sheet. Presentation " +
          "only — drawn by the `equipment-look` builtin on whatever entity holds the model (a sword in a hand " +
          "socket), and absent for items with no visible form. Two items can share parts and differ by sheet, " +
          "or share a sheet and differ by parts.",
      ),
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

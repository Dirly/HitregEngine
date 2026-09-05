import { z } from "zod";
import { ATTRIBUTES, DERIVED_STATS, gridSizeSchema, type Attribute, type DerivedStat } from "./items.js";

/**
 * Progression rules — the numbers behind levels, points and derived stats,
 * as ONE small data asset (`assets/progression/<id>.json`, type "progression")
 * so a designer or an agent tunes the curve without touching code. A scene
 * that names none gets `DEFAULT_PROGRESSION`.
 *
 * Every derived stat is a linear formula: `base + Σ coefficient × attribute`,
 * plus whatever worn items add flat. Linear on purpose — a human can read
 * "10 HP per point of constitution" off the file, and an agent can explain it.
 */

const attributeInts = Object.fromEntries(
  ATTRIBUTES.map((a) => [a, z.number().int().min(0).max(999).default(10)]),
) as Record<Attribute, z.ZodDefault<z.ZodNumber>>;

const coefficients = Object.fromEntries(
  ATTRIBUTES.map((a) => [a, z.number().optional()]),
) as Record<Attribute, z.ZodOptional<z.ZodNumber>>;

export const statFormulaSchema = z
  .object({ base: z.number().default(0), ...coefficients })
  .describe("base + Σ coefficient × effective attribute; worn-item modifiers add after.");
export type StatFormula = z.infer<typeof statFormulaSchema>;

const DEFAULT_FORMULAS: Record<DerivedStat, z.input<typeof statFormulaSchema>> = {
  maxHp: { base: 100, constitution: 10 },
  maxStamina: { base: 100, dexterity: 4, constitution: 2 },
  maxMana: { base: 50, intelligence: 8, wisdom: 4 },
  armor: { base: 0 },
  capacity: { base: 20, strength: 2 },
};

const derivedFormulas = Object.fromEntries(
  DERIVED_STATS.map((s) => [s, statFormulaSchema.prefault(DEFAULT_FORMULAS[s])]),
) as Record<DerivedStat, z.ZodPrefault<typeof statFormulaSchema>>;

export const progressionSchema = z
  .object({
    maxLevel: z
      .number()
      .int()
      .min(1)
      .max(200)
      .default(20)
      .describe("Level cap. Experience past the cap is kept but grants nothing."),
    pointsPerLevel: z
      .number()
      .int()
      .min(0)
      .max(20)
      .default(1)
      .describe("Attribute points granted per level gained; the player spends them one at a time."),
    baseAttributes: z
      .object(attributeInts)
      .prefault({})
      .describe("Where every attribute starts at level 1, before any points are spent."),
    xp: z
      .object({
        base: z.number().positive().default(100),
        growth: z.number().min(1).max(3).default(1.25),
      })
      .prefault({})
      .describe("Experience to go from level L to L+1 = round(base × growth^(L−1))."),
    pockets: gridSizeSchema
      .default({ cols: 4, rows: 2 })
      .describe("The grid every character always has, bag or no bag."),
    derived: z.object(derivedFormulas).prefault({}),
  })
  .describe(
    "Levelling and stat rules (assets/progression/<id>.json). One per game; a character-sheet script names it by id.",
  );

export type Progression = z.infer<typeof progressionSchema>;
export type ProgressionInput = z.input<typeof progressionSchema>;

export const DEFAULT_PROGRESSION: Progression = progressionSchema.parse({});

/** Experience needed to go from `level` to `level + 1`. */
export function xpToNext(level: number, p: Progression = DEFAULT_PROGRESSION): number {
  return Math.round(p.xp.base * p.xp.growth ** (Math.max(1, level) - 1));
}

/** Total experience at which `level` is reached (level 1 = 0). */
export function xpForLevel(level: number, p: Progression = DEFAULT_PROGRESSION): number {
  let total = 0;
  for (let l = 1; l < level; l++) total += xpToNext(l, p);
  return total;
}

/** The level a total-experience value corresponds to, capped at `maxLevel`. */
export function levelForXp(xp: number, p: Progression = DEFAULT_PROGRESSION): number {
  let level = 1;
  let total = 0;
  while (level < p.maxLevel) {
    const next = xpToNext(level, p);
    if (xp < total + next) break;
    total += next;
    level++;
  }
  return level;
}

/** Evaluate one formula against effective attributes. */
export function evaluateFormula(formula: StatFormula, attributes: Record<Attribute, number>): number {
  let value = formula.base;
  for (const a of ATTRIBUTES) {
    const c = formula[a];
    if (typeof c === "number") value += c * attributes[a];
  }
  return value;
}

import { z } from "zod";

/**
 * The one condition language: a dialogue choice's `if`, a dialogue start's
 * `if`, a quest objective's `when` and an `auto` quest source's `when` are all
 * this shape, tested by `testCondition` (npc/index.ts) against facts the
 * authority gathered. Kept free of other engine imports so the quest schema
 * (game-ui.ts) can use it without a module cycle.
 */

/**
 * Where the authority publishes the world clock (hours, 0–24) and the layer's
 * weather. They must be valid netState keys ("namespace/rest"): the earlier
 * "world.hour" / "world.weather" were refused by every store, so neither ever
 * replicated.
 */
export const WORLD_HOUR_KEY = "world/hour";
export const WORLD_WEATHER_KEY = "world/weather";

/** Hour window on the world clock (netState `world/hour`). */
export interface ClockWindow {
  from: number;
  to: number;
}

/** Weather band (netState `world/weather`), optionally only over some biomes. */
export interface WeatherBand {
  min?: number;
  max?: number;
  storm?: number;
  biomes?: string[];
}

/** A test against the character's state. Every field present must hold. */
export interface DialogueCondition {
  quest?: string;
  status?: "none" | "available" | "active" | "ready" | "complete" | "taken";
  flag?: string;
  is?: boolean;
  met?: boolean;
  level?: number;
  item?: string;
  qty?: number;
  coins?: number;
  bound?: boolean;
  clock?: ClockWindow;
  weather?: WeatherBand;
  all?: DialogueCondition[];
  any?: DialogueCondition[];
  not?: DialogueCondition;
}

export const clockWindowSchema = z
  .object({
    from: z.number().min(0).max(24).describe("First hour of the window (0–24, fractions allowed)."),
    to: z.number().min(0).max(24).describe("Hour the window closes. Smaller than `from` = it wraps midnight (20 → 4 is the night)."),
  })
  .describe(
    "Holds while the world clock (netState world/hour, written by the day-night builtin on the authority) is in [from, to). " +
      "No clock in the scene = never holds.",
  );

export const weatherBandSchema = z
  .object({
    min: z.number().min(0).max(1).optional().describe("Precipitation at least this (0 = clear, 1 = the heaviest this world does)."),
    max: z.number().min(0).max(1).optional().describe("Precipitation at most this (max 0.05 = dry weather)."),
    storm: z.number().min(0).max(1).optional().describe("Storm (wind, gloom, lightning) at least this."),
    biomes: z
      .array(z.string().min(1))
      .optional()
      .describe(
        "Biome rule ids: holds only while the biome under the character (the winning one, ctx.biomeAt) is one of these. " +
          "Weather is one state per layer and what it FALLS as is the biome's: `min` 0.3 over snow biomes means snowing HERE.",
      ),
  })
  .describe("Holds while the layer's weather (netState world/weather) is inside this band. No weather in the scene = never holds.");

export const dialogueConditionSchema: z.ZodType<DialogueCondition> = z.lazy(() =>
  z
    .object({
      quest: z.string().min(1).optional().describe("Quest id tested by `status`."),
      status: z
        .enum(["none", "available", "active", "ready", "complete", "taken"])
        .optional()
        .describe(
          "With `quest`: none = never accepted; available = can be accepted NOW (not taken, its `requires` done); " +
            "active = objectives open; ready = objectives done, not handed in; complete = handed in; taken = active or ready.",
        ),
      flag: z.string().min(1).optional().describe("A per-character memory flag (set by a `setFlag` action)."),
      is: z.boolean().optional().describe("With `flag`: the value it must have (default true)."),
      met: z.boolean().optional().describe("Dialogue only: whether this character had spoken to THIS NPC before the current conversation."),
      level: z.number().int().min(1).optional().describe("Character level at least this."),
      item: z.string().min(1).optional().describe("Carries at least `qty` (default 1) of this item id."),
      qty: z.number().int().min(1).optional(),
      coins: z.number().int().min(0).optional().describe("Carries at least this many copper."),
      bound: z
        .boolean()
        .optional()
        .describe(
          "Dialogue only: whether this character's HEARTH is HERE: its respawn bind (netState bind/<bodyId>) is this NPC's " +
            "`bindPoint` (within 1 m). An innkeeper's \"Your bed by the fire is kept.\"",
        ),
      clock: clockWindowSchema.optional(),
      weather: weatherBandSchema.optional(),
      all: z.array(dialogueConditionSchema).optional().describe("Every one holds."),
      any: z.array(dialogueConditionSchema).optional().describe("At least one holds."),
      not: dialogueConditionSchema.optional().describe("This one does NOT hold."),
    })
    // strict: a mistyped test (`has: { item }`) used to be dropped silently, leaving `{}` = always true, or `not: {}` = never
    .strict()
    .describe("A test against the character (and, for clock/weather, the world it stands in). Every field present must hold; {} is always true."),
);

/** World state a condition may read, gathered on the authority. Absent facts make clock/weather conditions fail. */
export interface WorldFacts {
  /** netState world/hour, or null when no clock runs. */
  hour: number | null;
  /** netState world/weather (precipitation and storm 0..1), or null. */
  weather: { precipitation: number; storm: number } | null;
  /** Winning biome rule id under the character, or null (no voxel world). */
  biome: string | null;
}

export function clockHolds(c: ClockWindow, hour: number | null | undefined): boolean {
  if (typeof hour !== "number" || !Number.isFinite(hour)) return false;
  const h = ((hour % 24) + 24) % 24;
  return c.from <= c.to ? h >= c.from && h < c.to : h >= c.from || h < c.to;
}

export function weatherHolds(c: WeatherBand, world: WorldFacts | null | undefined): boolean {
  const w = world?.weather;
  if (!w) return false;
  if (c.min !== undefined && w.precipitation < c.min) return false;
  if (c.max !== undefined && w.precipitation > c.max) return false;
  if (c.storm !== undefined && w.storm < c.storm) return false;
  if (c.biomes && c.biomes.length > 0 && !(world?.biome && c.biomes.includes(world.biome))) return false;
  return true;
}

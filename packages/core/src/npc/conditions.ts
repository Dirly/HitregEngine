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
/**
 * Whole days the world clock has run (an integer the day-night builtin's authority bumps at each midnight and
 * publishes together with the hour). `day * 24 + hour` is the monotonic world time a quest's `repeat` is measured in.
 */
export const WORLD_DAY_KEY = "world/day";

/** The four tide windows, in the order the tide runs (high water, falling, low water, rising). */
export const TIDE_PHASES = ["high", "ebb", "low", "flood"] as const;
export type TidePhase = (typeof TIDE_PHASES)[number];
/** World-clock hours from one high water to the next (a semi-diurnal tide: it slips ~50 min a day against the clock). */
export const TIDE_PERIOD_HOURS = 12.4;

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
  tide?: TidePhase;
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

export const tideConditionSchema = z
  .enum(TIDE_PHASES)
  .describe(
    "Holds while the tide is in this window. The tide is ONE world function, the same on every coast and for every player: " +
      `a ${TIDE_PERIOD_HOURS} h cycle of the world time (netState world/day * 24 + world/hour, written by the day-night builtin on ` +
      "the authority), high water at world time 0. Each window is a quarter of the cycle: high (around high water), ebb (falling), " +
      "low (around low water), flood (rising). It slips against the hour of day, so `low` falls at a different hour each day. " +
      "No clock in the scene = never holds. Several windows: `any: [{ tide: low }, { tide: flood }]`. The sea surface does not move with it.",
  );

export const dialogueConditionSchema: z.ZodType<DialogueCondition> = z.lazy(() =>
  z
    .object({
      quest: z.string().min(1).optional().describe("Quest id tested by `status`."),
      status: z
        .enum(["none", "available", "active", "ready", "complete", "taken"])
        .optional()
        .describe(
          "With `quest`: none = never accepted; available = can be accepted NOW (not taken, its `requires` done, a `repeat` quest's wait over); " +
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
      tide: tideConditionSchema.optional(),
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
  /** netState world/day (whole days the clock has run); absent = 0. */
  day?: number | null;
  /** netState world/weather (precipitation and storm 0..1), or null. */
  weather: { precipitation: number; storm: number } | null;
  /** Winning biome rule id under the character, or null (no voxel world). */
  biome: string | null;
}

/** World time in hours since the clock started (`day * 24 + hour`), or null when no clock runs. */
export function worldTime(world: Pick<WorldFacts, "hour" | "day"> | null | undefined): number | null {
  const hour = world?.hour;
  if (typeof hour !== "number" || !Number.isFinite(hour)) return null;
  const day = typeof world?.day === "number" && Number.isFinite(world.day) ? world.day : 0;
  return day * 24 + hour;
}

export function clockHolds(c: ClockWindow, hour: number | null | undefined): boolean {
  if (typeof hour !== "number" || !Number.isFinite(hour)) return false;
  const h = ((hour % 24) + 24) % 24;
  return c.from <= c.to ? h >= c.from && h < c.to : h >= c.from || h < c.to;
}

/** The tide window at world time `worldHours` (day * 24 + hour). */
export function tidePhase(worldHours: number): TidePhase {
  const f = (((worldHours % TIDE_PERIOD_HOURS) + TIDE_PERIOD_HOURS) % TIDE_PERIOD_HOURS) / TIDE_PERIOD_HOURS;
  return f < 1 / 8 || f >= 7 / 8 ? "high" : f < 3 / 8 ? "ebb" : f < 5 / 8 ? "low" : "flood";
}

/** Height of the tide at world time `worldHours`: 1 = high water, -1 = low water (for a renderer or a sound; conditions use tidePhase). */
export function tideLevel(worldHours: number): number {
  return Math.cos((2 * Math.PI * worldHours) / TIDE_PERIOD_HOURS);
}

/** Whether the tide is in window `phase` for these world facts; no clock = false. */
export function tideHolds(phase: TidePhase, world: Pick<WorldFacts, "hour" | "day"> | null | undefined): boolean {
  const t = worldTime(world);
  return t !== null && tidePhase(t) === phase;
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

/**
 * Pure helpers quest-play uses to read a dialogue/quest condition (`when`) without the scene: its plain leaves, and
 * the character level it asks for (the body earns that level by character.xp before an `auto` source may offer).
 */
type Condition = Record<string, unknown>;

/** The plain conditions inside a condition: an `all` wrapper is opened (recursively), anything else is one leaf. */
export function conditionLeaves<C extends object>(c: C): C[] {
  const all = (c as { all?: C[] }).all;
  return Array.isArray(all) ? all.flatMap(conditionLeaves) : [c];
}

/**
 * The condition kinds of a gate the tool can drive (`drivable`: e.g. clock, weather, tide), looked up in its leaves —
 * a dry night is `all: [clock, weather]`, whose top-level key is only `all` (the-honest-light never had its night set).
 */
export function drivableParts(c: object | null | undefined, drivable: (kind: string) => boolean): string[] {
  if (!c) return [];
  return [...new Set(conditionLeaves(c).flatMap((leaf) => Object.keys(leaf).filter(drivable)))];
}

/** The highest `level` any leaf of the condition requires (0 when none does). */
export function requiredLevel(c: Condition | null | undefined): number {
  if (!c) return 0;
  return Math.max(0, ...conditionLeaves(c).map((l) => (typeof l["level"] === "number" ? (l["level"] as number) : 0)));
}

export interface WeatherCondition { min?: number; max?: number; storm?: number }
/** Whether a published world/weather state meets a `weather` condition (core npc/conditions.ts semantics). */
export function weatherHolds(c: WeatherCondition, w: { precipitation?: number; storm?: number } | null | undefined): boolean {
  if (!w) return false;
  const p = w.precipitation ?? 0;
  if (c.min !== undefined && p < c.min) return false;
  if (c.max !== undefined && p > c.max) return false;
  if (c.storm !== undefined && (w.storm ?? 0) < c.storm) return false;
  return true;
}
/**
 * The Weather builtin's pinned `/weather <mode>` plateaus (builtin.ts roll(): peak x the plateau envelope 0.88..1, storm
 * full once the rain has broken). quest-play picks the mildest one that makes a condition hold, or the first that breaks it.
 */
export const WEATHER_PLATEAUS = [
  { mode: "clear", lo: 0, hi: 0, storm: 0 },
  { mode: "drizzle", lo: 0.12, hi: 0.12, storm: 0 },
  { mode: "light", lo: 0.44, hi: 0.5, storm: 0.1 },
  { mode: "storm", lo: 0.88, hi: 1, storm: 0.85 },
] as const;
export function weatherModeFor(c: WeatherCondition, hold: boolean): string | null {
  for (const m of WEATHER_PLATEAUS) {
    const ok = weatherHolds(c, { precipitation: m.lo, storm: m.storm }) && weatherHolds(c, { precipitation: m.hi, storm: m.storm });
    const broken = !weatherHolds(c, { precipitation: m.lo, storm: m.storm }) && !weatherHolds(c, { precipitation: m.hi, storm: m.storm });
    if (hold ? ok : broken) return m.mode;
  }
  return null;
}

/**
 * The corpses a dead body left that are its own to take back (netState `lootbag/<id>`): every player death leaves its
 * bags' contents and ALL its money in a corpse at the body (foundation combat-actor -> character-sheet). A run that
 * never walks back to it reads the lost purse as a short quest reward (the-hoist-house: coins -301/28).
 */
export function ownCorpses(bags: Iterable<[string, unknown]>, body: string): string[] {
  const out: string[] = [];
  for (const [key, v] of bags) {
    const b = v as { owner?: string; corpse?: string; claimUntil?: number } | undefined;
    if (b?.corpse === body && b.owner === body) out.push(key);
  }
  return out;
}

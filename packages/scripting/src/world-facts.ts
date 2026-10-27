import { WORLD_DAY_KEY, WORLD_HOUR_KEY, WORLD_WEATHER_KEY, worldTime, type WorldFacts } from "@hitreg/core";
import type { ScriptContext } from "./script.js";

/** The world facts a condition reads, for a character standing at (x, z): clock, weather, biome underfoot. */
export function worldFactsAt(ctx: Pick<ScriptContext, "biomeAt">, store: { get(key: string): unknown }, x: number, z: number): WorldFacts {
  const hour = store.get(WORLD_HOUR_KEY);
  const w = store.get(WORLD_WEATHER_KEY) as { precipitation?: unknown; storm?: unknown } | undefined;
  const weather =
    w && typeof w.precipitation === "number" ? { precipitation: w.precipitation, storm: typeof w.storm === "number" ? w.storm : 0 } : null;
  let biome: string | null = null;
  try {
    biome = ctx.biomeAt?.(x, z)?.id ?? null;
  } catch {
    biome = null;
  }
  const day = store.get(WORLD_DAY_KEY);
  return { hour: typeof hour === "number" ? hour : null, day: typeof day === "number" ? day : null, weather, biome };
}

/** The world time in hours (world/day * 24 + world/hour) a quest `repeat` is measured in; null when no clock runs. */
export function worldTimeOf(store: { get(key: string): unknown }): number | null {
  const hour = store.get(WORLD_HOUR_KEY);
  const day = store.get(WORLD_DAY_KEY);
  return worldTime({ hour: typeof hour === "number" ? hour : null, day: typeof day === "number" ? day : null });
}

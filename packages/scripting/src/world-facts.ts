import { WORLD_HOUR_KEY, WORLD_WEATHER_KEY, type WorldFacts } from "@hitreg/core";
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
  return { hour: typeof hour === "number" ? hour : null, weather, biome };
}

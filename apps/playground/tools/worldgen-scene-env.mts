/**
 * The environment a generated world scene needs before ANY render of it can be judged: a sky driven by the day-night
 * builtin (a clock for `/time`), the weather builtin on the world entity (`/weather`) and an entity running zone-mood
 * (`/mood`, the recipe's regions[].mood). `worldgen init --scene` wrote sun + `sky: { preset: "day" }` only, so the
 * siting far renders (light-shots) had no clock, "! unknown command /weather" and "/mood", and a night-blue sky
 * (redstrand 2026-10-29). With `--from <look>` the look's own scene supplies the components (its tuned sky, postfx,
 * sun and the weather/day-night params); without one, the builtins run on their defaults.
 */
import fs from "node:fs";

export interface SceneEntityJson {
  name: string;
  parent: string | null;
  tags: string[];
  components: Record<string, unknown>;
}

const scriptName = (e: SceneEntityJson | undefined): string => ((e?.components.script as { name?: string } | undefined)?.name ?? "");

/** Adds the environment to a fresh world scene's entities (in place) and returns what it added. */
export function withEnvironment(entities: Record<string, SceneEntityJson>, lookScene?: string): string[] {
  const added: string[] = [];
  let look: Record<string, SceneEntityJson> = {};
  if (lookScene && fs.existsSync(lookScene)) {
    try { look = (JSON.parse(fs.readFileSync(lookScene, "utf8").replace(/^﻿/, "")) as { entities?: Record<string, SceneEntityJson> }).entities ?? {}; } catch { look = {}; }
  }
  const lookAll = Object.values(look);
  const lookSky = lookAll.find((e) => e.components.sky);
  const lookSun = lookAll.find((e) => (e.components.light as { kind?: string } | undefined)?.kind === "directional");
  const lookWeather = lookAll.find((e) => scriptName(e) === "weather");
  const lookMood = lookAll.find((e) => scriptName(e) === "zone-mood");

  const sky = entities.sky;
  if (sky) {
    if (lookSky) {
      for (const k of ["sky", "postfx"]) if (lookSky.components[k]) sky.components[k] = structuredClone(lookSky.components[k]);
    }
    if (scriptName(sky) !== "day-night") {
      sky.components.script = lookSky && scriptName(lookSky) === "day-night" ? structuredClone(lookSky.components.script) : { name: "day-night", params: { startHour: 12 } };
      added.push("day-night");
    }
  }
  const sun = entities.sun;
  if (sun && lookSun?.components.light) sun.components.light = structuredClone(lookSun.components.light);
  const world = entities.world;
  if (world && !Object.values(entities).some((e) => scriptName(e) === "weather")) {
    if (!world.components.script) world.components.script = lookWeather ? structuredClone(lookWeather.components.script) : { name: "weather" };
    else entities.weather = { name: "Weather", parent: null, tags: [], components: { script: lookWeather ? structuredClone(lookWeather.components.script) : { name: "weather" } } };
    added.push("weather");
  }
  if (!Object.values(entities).some((e) => scriptName(e) === "zone-mood")) {
    entities["zone-mood"] = { name: "Zone mood", parent: sky ? "sky" : null, tags: [], components: { script: lookMood ? structuredClone(lookMood.components.script) : { name: "zone-mood", params: { blendSeconds: 6, strength: 1 } } } };
    added.push("zone-mood");
  }
  return added;
}

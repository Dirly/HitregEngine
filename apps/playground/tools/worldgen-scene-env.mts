/**
 * The environment a generated world scene needs before ANY render of it can be judged: a sky driven by the day-night
 * builtin (a clock for `/time`), the weather builtin on the world entity (`/weather`) and an entity running zone-mood
 * (`/mood`, the recipe's regions[].mood). `worldgen init --scene` wrote sun + `sky: { preset: "day" }` only, so the
 * siting far renders (light-shots) had no clock, "! unknown command /weather" and "/mood", and a night-blue sky
 * (redstrand 2026-10-29). With `--from <look>` the look's own scene supplies the components (its tuned sky, postfx,
 * sun and the weather/day-night params); without one, the builtins run on their defaults.
 */
import fs from "node:fs";
import { applyOps, ComponentRegistry, registerChunkComponents, registerCoreComponents, type Op, type SceneDoc } from "@hitreg/core";
import type { WorldField, WorldRecipe } from "@hitreg/core";
import { loadShell, planShell, shellGaps, type PlanOptions } from "./_game-shell.mjs";
import { worldSpawn } from "./_world-spawn.mts";

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

/**
 * The world's spawn as the shell wants it: XZ + facing from the world's data (tools/_world-spawn.mts: the starter
 * town's gate street), the height from `field` when given (surfaceCast + 1.1 m, the body root over its feet), else 0
 * (an XZ-only check). `projectDir` = the world project's folder (the town design path is relative to it).
 */
export function shellSpawn(recipe: WorldRecipe, projectDir: string, field?: WorldField): PlanOptions["spawn"] {
  const ws = worldSpawn(recipe, projectDir);
  if (!ws) return null;
  const ground = field ? (field.surfaceCast(ws.at[0], ws.at[1]) ?? field.height(ws.at[0], ws.at[1])) : -1.1;
  return { position: [ws.at[0], +(ground + 1.1).toFixed(2), ws.at[1]], rotation: ws.rotation, from: ws.from };
}

/**
 * The GAME SHELL (player prefab, camera rig, HUD/UI/fx/audio systems, pooled VFX) the project's closure supplies in
 * `assets/game-shell.json` (tools/_game-shell.mjs; installer tools/game-shell.mts), applied to a fresh world scene as one
 * validated ops batch, the player at the world spawn when one is given. A world without one in its closure (no
 * foundation) keeps the dev capsule. Redstrand 2026-10-31: its scene was born a capsule with no HUD, no combat and no
 * UI, standing at the origin, and nothing flagged it.
 */
export function withGameShell(project: string, doc: SceneDoc, spawn: PlanOptions["spawn"] = null): { doc: SceneDoc; added: string[] } {
  const loaded = project ? loadShell(project) : null;
  if (!loaded) return { doc, added: [] };
  const plan = planShell(loaded, doc, { spawn });
  const registry = new ComponentRegistry();
  registerCoreComponents(registry);
  registerChunkComponents(registry);
  return { doc: applyOps(doc, plan.ops as Op[], registry).doc, added: plan.added };
}

/** worldgen status `game-shell` row: null = the world scene carries the whole shell, its player at the world spawn
 *  (XZ within 4 m), or the closure has no shell. */
export function gameShellStageCheck(project: string, sceneFile: string, recipe?: WorldRecipe, projectDir?: string): string | null {
  const loaded = project ? loadShell(project) : null;
  if (!loaded) return null;
  if (!fs.existsSync(sceneFile)) return `no world scene (${sceneFile.replaceAll("\\", "/").split("/").slice(-1)[0]})`;
  const doc = JSON.parse(fs.readFileSync(sceneFile, "utf8")) as SceneDoc;
  const spawn = recipe && projectDir ? shellSpawn(recipe, projectDir) : null;
  const gaps = shellGaps(loaded, doc, { spawn });
  return gaps.length ? `${gaps.length} gap(s): ${gaps.slice(0, 4).join("; ")}${gaps.length > 4 ? " ..." : ""}` : null;
}

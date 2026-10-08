/**
 * zonegen systems <world> --project <p> [--scene <id>] [--dry]
 *
 * A fresh world's scene (worldgen scene) holds terrain, sky and a player and NOTHING of the game: no HUD, no inventory,
 * no combat effects, no bridge from a mob's attack request to a real hit, no sound. Those are the PROJECT's own
 * entities, so the engine cannot write them. The project declares them once:
 *
 *   authoring/zonegen/scene-systems.json   { "from": "<scene id that has them>", "entities": ["<root entity id>", ...] }
 *
 * An entity no scene of the project holds as a root (e.g. `zone-mood`, a child of the worldgen `sky`) is written inline:
 *
 *   "add": { "<entity id>": <entity doc, its parent an id every world scene has> }
 *
 * and this command copies every listed entity (with its whole subtree) that the world's scene lacks, as ONE applyOps
 * batch with a saved inverse (<worldDir>/systems-inverse.json). An entity already present is left alone. The status row
 * (`systems`) is MISSING while any is absent, so a zone cannot be populated or played in a scene mobs cannot fight in.
 */
import fs from "node:fs";
import path from "node:path";
import { applyOps, ComponentRegistry, registerChunkComponents, registerCoreComponents, type Op, type SceneDoc } from "@hitreg/core";
import { exists, readJson, writeJson, type Ctx } from "../lib.mts";

interface SystemsDoc { from: string; entities: string[]; add?: Record<string, SceneDoc["entities"][string]> }
interface Plan { error: string; from: string; scene: string; sceneFile: string; missing: string[]; subtree: string[]; source: SceneDoc | null; live: SceneDoc | null; inline: Record<string, SceneDoc["entities"][string]> }

const configFile = (ctx: Ctx): string => path.join(ctx.paths.root, "scene-systems.json");
const sceneFile = (ctx: Ctx, id: string): string => path.join(ctx.paths.projectDir, "assets", "scenes", `${id}.scene.json`);

function plan(ctx: Ctx, scene: string): Plan {
  const out: Plan = { error: "", from: "", scene, sceneFile: sceneFile(ctx, scene), missing: [], subtree: [], source: null, live: null, inline: {} };
  if (!exists(configFile(ctx))) return { ...out, error: "authoring/zonegen/scene-systems.json not written (the project's game-system entities and the scene that has them)" };
  const cfg = readJson(configFile(ctx)) as SystemsDoc;
  if (typeof cfg.from !== "string" || !Array.isArray(cfg.entities) || cfg.entities.length === 0) return { ...out, error: "scene-systems.json needs { from, entities: [..] }" };
  out.from = cfg.from;
  if (!exists(sceneFile(ctx, cfg.from))) return { ...out, error: `scene-systems.json names scene "${cfg.from}", which does not exist` };
  if (!exists(out.sceneFile)) return { ...out, error: `no scene ${scene} (npx tsx tools/worldgen.mts scene ${ctx.world} --project ${ctx.project})` };
  const source = readJson(sceneFile(ctx, cfg.from)) as SceneDoc;
  const live = readJson(out.sceneFile) as SceneDoc;
  out.source = source;
  out.live = live;
  const absent = cfg.entities.filter((id) => !source.entities[id]);
  if (absent.length) return { ...out, error: `scene ${cfg.from} has no ${absent.join(", ")} (fix scene-systems.json)` };
  out.missing = cfg.entities.filter((id) => !live.entities[id]);
  // parents before children
  const kids = new Map<string, string[]>();
  for (const [id, e] of Object.entries(source.entities)) if (e.parent) kids.set(e.parent, [...(kids.get(e.parent) ?? []), id]);
  const walk = (id: string): void => { out.subtree.push(id); for (const k of kids.get(id) ?? []) walk(k); };
  for (const id of out.missing) walk(id);
  // inline entities: added when absent, after the copied ones (their parent must already be in the scene)
  for (const [id, e] of Object.entries(cfg.add ?? {})) {
    if (live.entities[id]) continue;
    if (e.parent && !live.entities[e.parent] && !out.subtree.includes(e.parent)) return { ...out, error: `scene-systems.json "add" entity ${id} needs parent ${e.parent}, which scene ${scene} lacks` };
    out.inline[id] = e;
    out.missing.push(id);
    out.subtree.push(id);
  }
  return out;
}

/** The world-level status row. */
export function systemsRow(ctx: Ctx): { state: "ok" | "MISSING" | "FAILED"; why: string; how: string } {
  const how = `npx tsx tools/zonegen.mts systems ${ctx.world} --project ${ctx.project}`;
  const p = plan(ctx, ctx.world);
  if (p.error) return { state: "MISSING", why: p.error, how };
  if (p.missing.length) return { state: "MISSING", why: `scene ${p.scene} lacks ${p.missing.length} game system(s): ${p.missing.join(", ")}`, how };
  return { state: "ok", why: "", how };
}

export async function run(ctx: Ctx): Promise<number> {
  const scene = ctx.opt("scene", ctx.world);
  const p = plan(ctx, scene);
  if (p.error) { console.error(`systems: ${p.error}`); return 1; }
  if (p.missing.length === 0) { console.log(`systems: scene ${scene} already has every declared game system`); return 0; }
  const clash = p.subtree.filter((id) => !p.missing.includes(id) && p.live!.entities[id]);
  if (clash.length) { console.error(`systems: scene ${scene} already has child ids ${clash.slice(0, 6).join(", ")}; refusing to overwrite`); return 1; }
  const ops: Op[] = p.subtree.map((id) => ({ op: "add-entity", id, entity: p.inline[id] ?? p.source!.entities[id]! }) as Op);
  console.log(`systems: ${p.missing.join(", ")} (${ops.length} entities) from scene ${p.from} -> ${scene}`);
  if (ctx.flag("dry")) return 0;
  const reg = new ComponentRegistry();
  registerCoreComponents(reg);
  registerChunkComponents(reg);
  const res = applyOps(p.live!, ops, reg);
  fs.writeFileSync(p.sceneFile, JSON.stringify(res.doc, null, 2) + "\n");
  writeJson(path.join(ctx.paths.worldDir, `systems-inverse-${scene}.json`), res.inverse);
  console.log(`systems: installed; inverse at ${path.relative(ctx.paths.projectDir, path.join(ctx.paths.worldDir, `systems-inverse-${scene}.json`))}`);
  return 0;
}

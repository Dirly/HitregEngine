/**
 * zonegen wire <world> --project <p> --zone <z> [--scene <id>] [--dry]
 *
 * A quest entity that is not a town resident (a readable cabinet, a presence at a strand, an object that talks) gets
 * its words from assets/dialogues/zones/<zone>/<entity id>.json, written by the quest's text task. Nothing else puts
 * that reference on the placed entity, so this does: for every entity of the zone's quest plan that stands in the scene
 * with an `npc` builtin and has such a dialogue file, set the script's `dialogue` (and `places`, from a bound quest
 * that names the entity) when they differ. One applyOps batch, inverse saved in the zone folder. Run it after the
 * text is written and after anything re-places the entities.
 */
import fs from "node:fs";
import path from "node:path";
import { applyOps, ComponentRegistry, registerChunkComponents, registerCoreComponents, type Op, type SceneDoc } from "@hitreg/core";
import { exists, readJson, writeJson, type Ctx } from "../lib.mts";
import { requireZone } from "./_shared.mts";

interface Wire { id: string; dialogue: string; places: string }

/** What should be wired and is not yet. `unplaced` = a dialogue file exists but its entity is not in the scene. */
export function wirePlan(ctx: Ctx, zone: string, sceneId: string): { wires: Wire[]; unplaced: string[]; scene: SceneDoc | null; sceneFile: string } {
  const p = ctx.paths;
  const sceneFile = path.join(p.projectDir, "assets", "scenes", `${sceneId}.scene.json`);
  const out = { wires: [] as Wire[], unplaced: [] as string[], scene: null as SceneDoc | null, sceneFile };
  if (!exists(sceneFile) || !exists(p.quests(zone))) return out;
  const scene = readJson(sceneFile) as SceneDoc;
  out.scene = scene;
  const plan = readJson(p.quests(zone)) as { quests?: { id: string }[]; entities?: { id: string }[] };
  // the places table a bound quest that touches the entity uses
  const placesOf = (entity: string): string => {
    for (const q of plan.quests ?? []) {
      const file = path.join(p.projectDir, "assets", "quests", `${q.id}.json`);
      if (!exists(file)) continue;
      const raw = fs.readFileSync(file, "utf8");
      const doc = JSON.parse(raw) as { places?: string };
      if (doc.places && raw.includes(`"${entity}"`)) return doc.places;
    }
    return "";
  };
  // every dialogue file written for this zone names the entity it belongs to: the plan's quest entities AND the
  // item-source objects a site owner added (a cask, a cart of fleeces, a marked crate), which the plan never lists
  const dir = path.join(p.projectDir, "assets", "dialogues", "zones", zone);
  const ids = new Set<string>((plan.entities ?? []).map((e) => e.id));
  if (exists(dir)) for (const f of fs.readdirSync(dir)) if (f.endsWith(".json")) ids.add(f.slice(0, -5));
  for (const id of ids) {
    const dialogue = `zones/${zone}/${id}`;
    if (!exists(path.join(p.projectDir, "assets", "dialogues", `${dialogue}.json`))) continue;
    const ent = scene.entities[id];
    const script = ent?.components["script"] as { name?: string; params?: Record<string, unknown> } | undefined;
    if (!ent || script?.name !== "npc") { out.unplaced.push(id); continue; }
    const places = placesOf(id) || String(script.params?.["places"] ?? "");
    if (script.params?.["dialogue"] !== dialogue || (places && script.params?.["places"] !== places)) out.wires.push({ id, dialogue, places });
  }
  return out;
}

export async function run(ctx: Ctx): Promise<number> {
  const bad = requireZone(ctx.zone, "wire");
  if (bad !== null) return bad;
  const sceneId = ctx.opt("scene", ctx.world);
  const plan = wirePlan(ctx, ctx.zone, sceneId);
  if (!plan.scene) { console.error(`wire: no scene ${sceneId} or no quest plan`); return 1; }
  for (const id of plan.unplaced) console.log(`  note ${id}: has a dialogue file but is not an npc-builtin entity in ${sceneId}`);
  const ops: Op[] = plan.wires.map((w) => {
    const script = plan.scene!.entities[w.id]!.components["script"] as { name: string; params?: Record<string, unknown> };
    return { op: "set-component", id: w.id, component: "script", data: { ...script, params: { ...(script.params ?? {}), dialogue: w.dialogue, ...(w.places ? { places: w.places } : {}) } } } as Op;
  });
  for (const w of plan.wires) console.log(`  ${ctx.flag("dry") ? "would wire" : "wired"} ${w.id} -> ${w.dialogue}${w.places ? ` (places ${w.places})` : ""}`);

  // A quest with an `auto` source starts by itself when its conditions hold, but only if the PLAYER's quest-log lists
  // it in `autoOffer`. That list is set per scene, as a prefab override on the scene's player, so the shared player
  // prefab (and every other world using it) is untouched. `autoStart` is cleared here too unless the scene set it:
  // the prefab's own start quest belongs to another world.
  const p = ctx.paths;
  const zonePlan = readJson(p.quests(ctx.zone)) as { quests?: { id: string }[] };
  const autos: string[] = [];
  for (const q of zonePlan.quests ?? []) {
    const file = path.join(p.projectDir, "assets", "quests", `${q.id}.json`);
    if (exists(file) && (readJson(file) as { source?: { kind?: string } }).source?.kind === "auto") autos.push(q.id);
  }
  const player = Object.entries(plan.scene.entities).find(([id, e]) => (id === "player" || e.tags.includes("player")) && e.components["prefab"]);
  if (autos.length && player) {
    const [pid, pe] = player;
    const pf = pe.components["prefab"] as { prefabId: string; props?: Record<string, unknown>; overrides?: { path: string; value: unknown }[] };
    const prefabFile = path.join(p.projectDir, "assets", "prefabs", `${pf.prefabId}.json`);
    const prefab = exists(prefabFile) ? (readJson(prefabFile) as { entities: Record<string, { components?: Record<string, unknown> }> }) : null;
    const logId = Object.entries(prefab?.entities ?? {}).find(([, e]) => (e.components?.["script"] as { name?: string } | undefined)?.name === "quest-log")?.[0];
    if (!logId) console.log(`  note: the player prefab ${pf.prefabId} has no quest-log entity; auto quests ${autos.join(", ")} cannot be offered`);
    else {
      const offerPath = `${logId}/components/script/params/autoOffer`;
      const startPath = `${logId}/components/script/params/autoStart`;
      const overrides = [...(pf.overrides ?? [])];
      const have = (overrides.find((o) => o.path === offerPath)?.value as string[] | undefined) ?? [];
      const want = [...new Set([...have, ...autos])];
      const changed = want.length !== have.length || !overrides.some((o) => o.path === startPath);
      if (changed) {
        const next = overrides.filter((o) => o.path !== offerPath);
        next.push({ path: offerPath, value: want });
        if (!next.some((o) => o.path === startPath)) next.push({ path: startPath, value: [] });
        ops.push({ op: "set-component", id: pid, component: "prefab", data: { ...pf, overrides: next } } as Op);
        console.log(`  ${ctx.flag("dry") ? "would set" : "set"} ${pid}'s quest-log autoOffer -> ${want.join(", ")}`);
      }
    }
  }
  if (ops.length === 0) { console.log("wire: every placed quest entity already names its dialogue, and auto quests are offered"); return 0; }
  if (ctx.flag("dry")) return 0;
  const reg = new ComponentRegistry();
  registerCoreComponents(reg);
  registerChunkComponents(reg);
  const res = applyOps(plan.scene, ops, reg);
  fs.writeFileSync(plan.sceneFile, JSON.stringify(res.doc, null, 2) + "\n");
  writeJson(path.join(ctx.paths.zoneDir(ctx.zone), `wire-inverse-${sceneId}.json`), res.inverse);
  console.log(`wire: ${ops.length} change(s) applied to ${sceneId}`);
  return 0;
}

/**
 * zonegen quest-objects <world> --project <p> --zone <z> [--town <t> | --poi <id>] [--scene <id>] [--json]
 *
 * What a dresser must include: per location, the quest objects the zone's quest plan declares (quests.json `entities[]`,
 * kind object|readable), the dressing plan that places each (an item with `quest.entity`) and whether the scene has an
 * entity with that exact id (what `zonegen bind` looks for). Each declared object is one plan item with `quest.entity`
 * (tools/dress.mts header, tools/_dress-quest.mts). Read-only.
 */
import path from "node:path";
import { exists, readJson, type Ctx } from "../lib.mts";
import { requireZone } from "./_shared.mts";
import { questObjectRows } from "../../_dress-quest.mts";

export function questObjectsText(projectDir: string, zone: string, scene: { entities: Record<string, { tags?: string[] }> } | null, location?: string): string {
  const rows = questObjectRows(projectDir, zone, scene, location);
  if (!rows.length) return location ? `(the quest plan declares no objects at ${location})` : "(the quest plan declares no objects)";
  const out: string[] = [];
  let at = "";
  for (const r of rows) {
    if (r.location !== at) { at = r.location; out.push(`${at}:`); }
    out.push(`  ${r.id} (${r.kind}) "${r.what}" — ${r.placed ? "PLACED" : "not placed"}${r.plan ? `, plan ${r.plan}` : ", in no plan"}`);
  }
  return out.join("\n");
}

export async function run(ctx: Ctx): Promise<number> {
  const bad = requireZone(ctx.zone, "quest-objects");
  if (bad !== null) return bad;
  const sceneId = ctx.opt("scene", ctx.world);
  const sceneFile = path.join(ctx.paths.projectDir, "assets", "scenes", `${sceneId}.scene.json`);
  const scene = exists(sceneFile) ? (readJson(sceneFile) as { entities: Record<string, { tags?: string[] }> }) : null;
  if (!scene) console.log(`(no scene ${sceneId}: placement not checked)`);
  const location = ctx.opt("town") || ctx.opt("poi") || undefined;
  if (ctx.flag("json")) { console.log(JSON.stringify(questObjectRows(ctx.paths.projectDir, ctx.zone, scene, location), null, 1)); return 0; }
  console.log(questObjectsText(ctx.paths.projectDir, ctx.zone, scene, location));
  console.log("rule: each declared object is one plan item with `quest.entity` (the prop chosen by name, like any item)");
  return 0;
}

/**
 * Retire placed quest objects whose quest step is gone: the prop stays where it stands as plain dressing, the
 * interactive spot goes (its `npc` script and the `quest-object` / `interactable` tags). ONE ops batch through
 * _scene-write, the inverse saved beside the zone's quests.
 *
 *   npx tsx tools/_quest-object-retire.mts --project <p> --scene <name> --zone <z> --entities a,b,c [--inverse <file>] [--dry]
 *
 * Used after a quest rehash (zones/<z>/quests.json no longer declares the entity) when the dressing plan that placed it
 * has had its `quest` key removed but cannot be re-applied yet; the next `dress apply` of that plan gives the same result.
 */
import fs from "node:fs";
import path from "node:path";
import { applyOps, ComponentRegistry, registerCoreComponents, type Op } from "@hitreg/core";
import { applyOpsToSceneFile } from "./_scene-write.mts";

const arg = (k: string): string => { const i = process.argv.indexOf(`--${k}`); return i >= 0 ? (process.argv[i + 1] ?? "") : ""; };
const project = arg("project"), sceneName = arg("scene"), zone = arg("zone");
const ids = arg("entities").split(",").filter(Boolean);
if (!project || !sceneName || !zone || !ids.length) { console.error("usage: --project <p> --scene <name> --zone <z> --entities a,b,c [--inverse <file>] [--dry]"); process.exit(2); }
const projectDir = path.resolve("projects", project);
const sceneFile = path.join(projectDir, "assets", "scenes", `${sceneName}.scene.json`);
const inverseFile = arg("inverse") || path.join(projectDir, "authoring", "zonegen", sceneName, "zones", zone, "quest-objects-retired.inverse.json");

const reg = new ComponentRegistry();
registerCoreComponents(reg);
const build = (doc: { entities: Record<string, { tags?: string[]; components: Record<string, unknown> }> }): Op[] => {
  const ops: Op[] = [];
  for (const id of ids) {
    const e = doc.entities[id];
    if (!e) { console.log(`  ${id}: not in the scene (skipped)`); continue; }
    if (!(e.tags ?? []).includes("quest-object")) { console.log(`  ${id}: not a quest object (skipped)`); continue; }
    ops.push({ op: "set-tags", id, tags: (e.tags ?? []).filter((t) => t !== "quest-object" && t !== "interactable") });
    if ((e.components.script as { name?: string } | undefined)?.name === "npc") ops.push({ op: "remove-component", id, component: "script" });
  }
  return ops;
};

const preview = build(JSON.parse(fs.readFileSync(sceneFile, "utf8")));
console.log(`${preview.length} op(s) for ${ids.length} entit(ies) in ${path.relative(process.cwd(), sceneFile)}`);
if (process.argv.includes("--dry") || !preview.length) process.exit(0);
let inverse: Op[] = [];
// the batch is rebuilt from the FRESH doc under the scene lock
applyOpsToSceneFile(sceneFile, [], (fresh) => {
  const ops = build(fresh);
  const r = applyOps(fresh, ops, reg);
  inverse = r.inverse;
  return r;
}, { label: "quest-object-retire", indent: 1, trailer: "" });
fs.writeFileSync(inverseFile, JSON.stringify({ scene: path.relative(process.cwd(), sceneFile).replaceAll("\\", "/"), entities: ids, ops: inverse }, null, 1) + "\n");
console.log(`retired; inverse -> ${path.relative(process.cwd(), inverseFile)}`);

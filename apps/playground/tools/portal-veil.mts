/**
 * portal-veil --project <p> --scene <id> [--dry] [--remove]
 *
 * Every walk-through portal (the `portal` builtin in mode "trigger") shows the shared instance boundary: the blue
 * spiral veil, material `hollow-bastion/zone-boundary` (one hue for every dungeon, docs/scene-authoring.md, Portals).
 * This hangs one veil in each such portal of a scene, as a child `<portal id>-veil` of the portal entity, and replaces
 * the one it hung before, so it is safe to run after anything rebuilds the scene.
 *
 * By default the veil stands on the trigger box's centre plane, 25% larger than the box's opening, so the passage walls
 * cut it to the opening (a veil is never sized exactly: a gap at the jamb reads as a hole). A doorway that is not a
 * plain passage states its own veil in <project>/authoring/portal-veils.json:
 *   { "<scene id>": { "<portal id>": { "size": [w, h], "at": [x, y, z], "trigger": { "halfExtents": [..], "offset": [..] } } } }
 * (metres, the portal entity's local space). A stated `trigger` is set on the portal too: tools/portal-cover.mts --fit
 * writes both from the measured opening, and this re-applies them after a rebuild. The veil is a picture only; the box,
 * the fade and the travel are the portal's. Check the result with tools/portal-cover.mts.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { applyOps, ComponentRegistry, registerChunkComponents, registerCoreComponents, type SceneDoc } from "@hitreg/core";
import { portalVeilOps, readStated, statedFileOf } from "./_portal-veil-ops.mts";

const PG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const arg = (n: string) => { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : undefined; };
const flag = (n: string) => process.argv.includes(n);
const project = arg("--project"), sceneId = arg("--scene");
if (!project || !sceneId) { console.error("usage: portal-veil --project <p> --scene <id> [--dry] [--remove]"); process.exit(1); }
const sceneFile = path.join(PG, "projects", project, "assets", "scenes", `${sceneId}.scene.json`);
const stated = readStated(statedFileOf(PG, project));
const doc = JSON.parse(fs.readFileSync(sceneFile, "utf8")) as SceneDoc;

const { ops, lines, hung } = portalVeilOps(doc, sceneId, stated, { remove: flag("--remove") });
for (const l of lines) console.log(l);
if (ops.length === 0) { console.log(`portal-veil: no walk-through portal in ${sceneId}`); process.exit(0); }
const reg = new ComponentRegistry();
registerCoreComponents(reg);
registerChunkComponents(reg);
const res = applyOps(doc, ops, reg);
if (flag("--dry")) { console.log(`[dry] ${hung} veil(s) would be hung in ${sceneId}`); process.exit(0); }
fs.writeFileSync(sceneFile, JSON.stringify(res.doc, null, 2) + "\n");
console.log(`portal-veil: ${flag("--remove") ? "removed" : `${hung} veil(s) hung`} in ${project}/${sceneId}`);

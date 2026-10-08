/**
 * portal-return --project <p> --scene <id> --exit <anchor id> --to <scene> <anchor> [--name <words>] [--dry]
 * portal-return --project <p> --scene <id> --exit <anchor id> --remove [--dry]
 *
 * The way OUT of an instance. An instance scene ends its entry passage with an exit anchor (an entity with a
 * `portalAnchor`, standing a few metres deeper into the dark than the arrival anchor). This turns that anchor into a
 * walk-through RETURN portal: the `portal` builtin, mode "trigger", `back: true` (the traveller goes back to the point
 * recorded when they came in), with `--to <scene> <anchor>` as the destination for a traveller who has no recorded way
 * back. The box stands on the anchor and spans its passage (`portalAnchor.corridor`). Re-runnable: it replaces the
 * portal it wrote before; it refuses an anchor that carries any other script. `--remove` makes the anchor a plain anchor
 * again (a passage that is sealed). Run tools/portal-veil.mts afterwards: it hangs (or takes down) the swirl.
 *
 * Note for a second door: a traveller's way back is ONE recorded point, so a link from one instance into another
 * overwrites it; a dungeon with two doors to two different places needs each door's own return, not `back`.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { applyOps, ComponentRegistry, portalAnchorOf, portalVolumeForCorridor, registerChunkComponents, registerCoreComponents, type Op, type SceneDoc } from "@hitreg/core";

const PG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const argi = (n: string) => process.argv.indexOf(n);
const arg = (n: string) => { const i = argi(n); return i >= 0 ? process.argv[i + 1] : undefined; };
const flag = (n: string) => process.argv.includes(n);
const fail = (why: string): never => { console.error("STOP: " + why); process.exit(1); };
const project = arg("--project"), sceneId = arg("--scene"), exit = arg("--exit");
if (!project || !sceneId || !exit) fail("usage: portal-return --project <p> --scene <id> --exit <anchor id> (--to <scene> <anchor> [--name <words>] | --remove) [--dry]");
const file = path.join(PG, "projects", project!, "assets", "scenes", `${sceneId}.scene.json`);
const doc = JSON.parse(fs.readFileSync(file, "utf8")) as SceneDoc;
const e = doc.entities[exit!];
if (!e) fail(`no entity ${exit} in ${sceneId}`);
const cur = e!.components["script"] as { name?: string } | undefined;
if (cur && cur.name !== "portal") fail(`${exit} carries the ${cur.name} script; a return portal never overwrites another script`);
const ops: Op[] = [];
if (flag("--remove")) {
  if (!cur) { console.log(`${exit} is already a plain anchor`); process.exit(0); }
  ops.push({ op: "set-tags", id: exit!, tags: e!.tags.filter((t) => t !== "portal") }, { op: "remove-component", id: exit!, component: "script" } as Op);
} else {
  const ti = argi("--to");
  const scene = ti >= 0 ? process.argv[ti + 1] : undefined, anchor = ti >= 0 ? process.argv[ti + 2] : undefined;
  if (!scene || !anchor || scene.startsWith("--") || anchor.startsWith("--")) fail("--to needs <scene> <anchor>");
  const vol = portalVolumeForCorridor(portalAnchorOf(doc.entities, exit!).corridor);
  ops.push(
    { op: "set-tags", id: exit!, tags: [...new Set([...e!.tags, "portal"])] },
    { op: "set-component", id: exit!, component: "script", data: { name: "portal", params: { mode: "trigger", back: true, scene, anchor, ...vol, fade: 2.5, arrivalGrace: 2, prompt: "Leave", name: arg("--name") ?? "this place", party: false } } },
  );
}
const reg = new ComponentRegistry();
registerCoreComponents(reg);
registerChunkComponents(reg);
const res = applyOps(doc, ops, reg);
if (flag("--dry")) { console.log(`[dry] ${exit} in ${sceneId}: ${flag("--remove") ? "would become a plain anchor" : "would become a walk-through return portal"}`); process.exit(0); }
fs.writeFileSync(file, JSON.stringify(res.doc, null, 2) + "\n");
console.log(`${exit} in ${project}/${sceneId}: ${flag("--remove") ? "plain anchor (passage sealed)" : "walk-through return portal"}`);

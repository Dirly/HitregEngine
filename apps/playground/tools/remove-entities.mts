/**
 * remove-entities — take named entities out of a scene the lawful way: ONE ops batch through core `applyOps` under the
 * scene lock (tools/_scene-write.mts), the inverse batch saved so the removal can be undone.
 *
 *   npx tsx tools/remove-entities.mts --project <p> --scene <id> --ids <id,id,...> [--inverse <file>] [--dry]
 *
 * Why a tool: the owner rejects a placed thing ("that net frame has to go"), and the fix must not be a hand edit of the
 * scene file. The removal is an ops batch like every other mutation; the dressing plan that placed the thing is edited
 * separately (or the catalogue row marked `exempt: "BLOCKED: ..."`) so a re-apply does not bring it back.
 */
import fs from "node:fs";
import path from "node:path";
import { ComponentRegistry, applyOps, registerCoreComponents, type Op, type SceneDoc } from "@hitreg/core";
import { applyOpsToSceneFile } from "./_scene-write.mts";

const argv = process.argv.slice(2);
const opt = (name: string): string | undefined => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1]!.startsWith("--") ? argv[i + 1] : undefined;
};
const project = opt("project");
const sceneId = opt("scene");
const ids = (opt("ids") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
if (!project || !sceneId || ids.length === 0) {
  console.error("usage: remove-entities --project <p> --scene <id> --ids <id,id,...> [--inverse <file>] [--dry]");
  process.exit(2);
}
const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
const projectDir = path.resolve(here, "..", "projects", project);
const sceneFile = path.join(projectDir, "assets", "scenes", `${sceneId}.scene.json`);
if (!fs.existsSync(sceneFile)) {
  console.error(`no scene ${sceneFile}`);
  process.exit(2);
}
const scene = JSON.parse(fs.readFileSync(sceneFile, "utf8")) as SceneDoc;
const missing = ids.filter((id) => !(scene.entities as Record<string, unknown>)[id]);
for (const id of missing) console.log(`  (not in the scene: ${id})`);
const present = ids.filter((id) => !missing.includes(id));
// children go with their parent: applyOps removes a subtree with its root, so list only roots
const parentOf = (id: string): string | undefined => ((scene.entities as Record<string, { parent?: string }>)[id] ?? {}).parent;
const roots = present.filter((id) => {
  let p = parentOf(id);
  while (p) {
    if (present.includes(p)) return false;
    p = parentOf(p);
  }
  return true;
});
const ops: Op[] = roots.map((id) => ({ op: "remove-entity", id }) as Op);
if (ops.length === 0) {
  console.log("nothing to remove");
  process.exit(0);
}
if (argv.includes("--dry")) {
  for (const id of roots) console.log(`  would remove ${id}`);
  console.log(`--dry: nothing written (${roots.length} root entit${roots.length === 1 ? "y" : "ies"})`);
  process.exit(0);
}
const registry = new ComponentRegistry();
registerCoreComponents(registry);
const res = applyOpsToSceneFile(sceneFile, ops, (d, o) => applyOps(d, o, registry), { label: "remove-entities" });
const inverseFile = opt("inverse") ?? path.join(projectDir, "authoring", "installs", `remove-${sceneId}-${Date.now()}.inverse.json`);
fs.mkdirSync(path.dirname(inverseFile), { recursive: true });
fs.writeFileSync(inverseFile, `${JSON.stringify(res.inverse, null, 1)}\n`);
console.log(`removed ${roots.length}: ${roots.join(", ")}`);
console.log(`inverse: ${path.relative(process.cwd(), inverseFile).replaceAll("\\", "/")} (${(res.inverse as unknown[]).length} ops)`);

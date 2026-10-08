/**
 * town-install — put a town's exported buildings into its scene, as an ops batch.
 *
 *   npx tsx tools/town-install.mts --project voxel-demo --town brinehold [--models towns/brinehold] [--dry]
 *
 * Reads assets/models/<models>/manifest.json (MMO/WFC/wfc/export_town.py: one merged model per district, its anchor
 * in world space) and replaces the town's building entities (tag `town-building:<town>`) with one entity per district:
 * the merged mesh (static, shadowed) plus a trimesh collider from the same geometry. Applied with core `applyOps`
 * (validated, atomic); the batch and its inverse are saved to authoring/towns/<town>-install-ops.json so the install
 * can be undone. Read the scene fresh: other stages (NPCs, landmarks) write it too, each owning its own tag.
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { ComponentRegistry, applyOps, registerCoreComponents, type Op, type SceneDoc } from "@hitreg/core";

const argv = process.argv.slice(2);
const opt = (name: string, fallback: string): string => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1]! : fallback;
};
const projectName = opt("project", "");
const townName = opt("town", "");
if (!projectName || !townName) {
  console.error("usage: town-install --project <p> --town <name> [--models towns/<name>] [--dry]");
  process.exit(2);
}
const projectDir = path.resolve("projects", projectName);
const townDoc = JSON.parse(fs.readFileSync(path.join(projectDir, "authoring/towns", `${townName}.json`), "utf8"));
const models = opt("models", `towns/${townName}`);
const manifest = JSON.parse(fs.readFileSync(path.join(projectDir, "assets/models", models, "manifest.json"), "utf8")) as {
  districts: Record<string, { file: string; anchor: [number, number, number]; buildings: string[]; tris: number; materials: number;
    far?: { file: string; distance: number; sourceSha256: string } }>;
};
const sceneFile = path.join(projectDir, "assets/scenes", `${townDoc.scene}.scene.json`);
const scene = JSON.parse(fs.readFileSync(sceneFile, "utf8")) as SceneDoc;
const registry = new ComponentRegistry();
registerCoreComponents(registry);

const tag = `town-building:${townName}`;
const ops: Op[] = [];
// replace: remove the town's previous building ROOTS (their children go with them)
for (const [id, e] of Object.entries(scene.entities)) if (e.tags.includes(tag) && (e.parent === null || !scene.entities[e.parent]?.tags.includes(tag))) ops.push({ op: "remove-entity", id });
const rootId = `town-${townName}-buildings`;
ops.push({ op: "add-entity", id: rootId, entity: { name: `${townDoc.name} — buildings`, parent: null, tags: [tag], components: { transform: {} } } as never });
for (const [district, d] of Object.entries(manifest.districts)) {
  // Far proxies are derived from a particular source. A building rebuild
  // must not leave an old skyline installed against its new near geometry.
  const far = d.far;
  const farValid = far && fs.existsSync(path.join(projectDir, "assets/models", models, far.file)) &&
    crypto.createHash("sha256").update(fs.readFileSync(path.join(projectDir, "assets/models", models, d.file))).digest("hex") === far.sourceSha256;
  if (far && !farValid) console.warn(`  ${district}: missing/stale far proxy; retaining full-detail rendering. Rebuild/review per docs/town-baking.md.`);
  ops.push({
    op: "add-entity",
    id: `${rootId}-${district}`,
    entity: {
      name: `${townDoc.name} ${district} town (${d.buildings.length} buildings)`,
      parent: rootId,
      tags: [tag, "static"],
      components: {
        transform: { position: d.anchor },
        mesh: { source: { kind: "asset", assetId: `${models}/${d.file}` }, static: true, castShadow: true, receiveShadow: true,
          ...(farValid ? { renderMode: "instanced", lod: true, lodDistance: far!.distance, lodProxy: `${models}/${far!.file}` } : { lod: false }) },
        collider: { shape: "trimesh", friction: 0 },
      },
    } as never,
  });
}
const result = applyOps(scene, ops, registry);
if (argv.includes("--dry")) {
  console.log(`would apply ${ops.length} ops`);
  process.exit(0);
}
fs.writeFileSync(sceneFile, `${JSON.stringify(result.doc, null, 2)}\n`);
fs.writeFileSync(path.join(projectDir, "authoring/towns", `${townName}-install-ops.json`), `${JSON.stringify({ ops, inverse: result.inverse }, null, 1)}\n`);
for (const [district, d] of Object.entries(manifest.districts)) console.log(`  ${district}: ${d.buildings.length} buildings, ${d.tris} tris, ${d.materials} materials at [${d.anchor}]`);
console.log(`installed into ${path.relative(process.cwd(), sceneFile)} (${ops.length} ops; inverse saved)`);

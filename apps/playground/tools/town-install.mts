/**
 * town-install — put a town's exported buildings into its scene, as an ops batch.
 *
 *   npx tsx tools/town-install.mts --project proving --town brinehold [--models towns/brinehold] [--dry] [--allow-moved]
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
import { applyOpsToSceneFile } from "./_scene-write.mts";
import { recordPlaceStage, requirePlaceStage } from "./world-order.mts";

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
// WORLD ORDER (tools/world-order.mts): a town in a staged world installs only after its final review passed
const orderKey = String(townDoc.town ?? townName);
if (!argv.includes("--dry")) {
  const refused = requirePlaceStage(projectDir, orderKey, "final-review", "town-install", townDoc.world);
  if (refused) { console.error(refused); process.exit(3); }
}
const models = opt("models", `towns/${townName}`);
const manifest = JSON.parse(fs.readFileSync(path.join(projectDir, "assets/models", models, "manifest.json"), "utf8")) as {
  districts: Record<string, { file: string; anchor: [number, number, number]; buildings: string[]; tris: number; materials: number; lift?: number;
    far?: { file: string; distance: number; sourceSha256: string } }>;
};
// Floors come from the LAYOUT (town-settle raises them after export, ~0.6 m over the highest ground): a one-building
// district exported at `lift` takes its height from the layout's groundY + lift, so a settle never needs a re-export.
const layoutFile = path.join(projectDir, "authoring/towns", `${townName}-layout.json`);
const floorOf = new Map<string, number>();
const centreOf = new Map<string, [number, number]>();
if (fs.existsSync(layoutFile)) for (const b of (JSON.parse(fs.readFileSync(layoutFile, "utf8")).buildings ?? []) as { id: string; groundY?: number; centre?: [number, number] }[]) {
  if (typeof b.groundY === "number") floorOf.set(b.id, b.groundY);
  if (Array.isArray(b.centre)) centreOf.set(b.id, b.centre);
}
// a re-run of town-layout after the export can move a lot (Saltharrow 2026-10-29: the vault 1.0 m, the Bell Watch 2.0 m):
// the model would then stand off its pad, its footprint and every check drawn from the layout. Refuse; re-export.
const moved = Object.entries(manifest.districts).flatMap(([id, d]) => {
  const c = d.buildings.length === 1 ? centreOf.get(d.buildings[0]!) : undefined;
  const off = c ? Math.hypot(d.anchor[0] - c[0], d.anchor[2] - c[1]) : 0;
  return off > 0.05 ? [`${id} ${off.toFixed(2)} m`] : [];
});
if (moved.length && !argv.includes("--allow-moved")) {
  console.error(`town-install: the layout moved ${moved.length} lot(s) since the export (${moved.join(", ")}): re-export the models from the current layout (export_town.py --layout), then install (--allow-moved installs anyway)`);
  process.exit(1);
}
const anchorOf = (d: { anchor: [number, number, number]; buildings: string[]; lift?: number }): [number, number, number] => {
  const y = d.buildings.length === 1 ? floorOf.get(d.buildings[0]!) : undefined;
  return y === undefined ? d.anchor : [d.anchor[0], +(y + (d.lift ?? 0)).toFixed(3), d.anchor[2]];
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
        transform: { position: anchorOf(d) },
        mesh: { source: { kind: "asset", assetId: `${models}/${d.file}` }, static: true, castShadow: true, receiveShadow: true,
          ...(farValid ? { renderMode: "instanced", lod: true, lodDistance: far!.distance, lodProxy: `${models}/${far!.file}` } : { lod: false }) },
        collider: { shape: "trimesh", friction: 0 },
      },
    } as never,
  });
}
let result = applyOps(scene, ops, registry);
if (argv.includes("--dry")) {
  console.log(`would apply ${ops.length} ops`);
  process.exit(0);
}
result = applyOpsToSceneFile(sceneFile, ops, (d, o) => applyOps(d, o, registry), { label: "town-install" }); // fresh read under the scene lock (tools/_scene-write.mts)
fs.writeFileSync(path.join(projectDir, "authoring/towns", `${townName}-install-ops.json`), `${JSON.stringify({ ops, inverse: result.inverse }, null, 1)}\n`);
for (const [district, d] of Object.entries(manifest.districts)) console.log(`  ${district}: ${d.buildings.length} buildings, ${d.tris} tris, ${d.materials} materials at [${anchorOf(d)}]${anchorOf(d)[1] !== d.anchor[1] ? ` (layout floor; exported at ${d.anchor[1]})` : ""}`);
console.log(`installed into ${path.relative(process.cwd(), sceneFile)} (${ops.length} ops; inverse saved)`);
{
  const r = recordPlaceStage(projectDir, orderKey, "installed", { by: "town-install", evidenceFile: path.join(projectDir, "authoring/towns", `${townName}-install-ops.json`) }, townDoc.world);
  if (r) console.log(`  ${r}`);
}

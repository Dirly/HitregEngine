/**
 * `rock-formations` — generate a fall site's DC rock formations, bake them, place them.
 *
 *   npx tsx tools/rock-formations.mts <project> <world> <siteId> [--scene <scene>] [--dry-run] [--no-bake]
 *                                     [--seed N] [--voxel m] [--margin m] [--spacing m] [--scale k]   (experiments only)
 *
 * 1. Builds the field and runs `rockFormations` (packages/core voxel/rock-formations.ts) with the
 *    site doc's own `formations` options — the same options the scree (`walls`, fall-site-rocks.ts)
 *    reads to rest on the masses and keep out of them, so pass option flags only to experiment:
 *    anything that is to ship belongs in the site doc, or the scree and the rock disagree.
 * 2. Writes the volume doc(s) — the AUTHORING source — to assets/volumes/rock-<siteId>[-N].json.
 * 3. BAKES each: dual-contours it here, drops disconnected slivers (components under
 *    MIN_TRIANGLES or MIN_SIZE m across: plane and trim cuts leave a few), and writes a GLB to
 *    assets/models/rock-formations/rock-<siteId>[-N].glb with POSITION, NORMAL, COLOR_0 (tint)
 *    and _SPLATWEIGHT[2|3] — the terrain-splat material's contract, as the DC dungeon bakes write it.
 *    The browser then only fetches and uploads it: no dual contouring on the main thread at load.
 * 4. With --scene, places each as a static mesh (source kind "asset", the world's terrain material)
 *    + trimesh collider in assets/scenes/<scene>.scene.json through an ops batch; re-running
 *    replaces the same entity ids. --no-bake places the live `csg` volume instead (authoring mode:
 *    edit the doc, see it re-mesh), at the cost of meshing it on every load.
 *
 * Regenerate after any change to the site (tiers, gorge, course) or to its `formations` options.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  applyOps,
  buildVolumeMesh,
  ComponentRegistry,
  createVolume,
  createWorldField,
  registerChunkComponents,
  registerCoreComponents,
  meshDensity,
  rockFormations,
  worldRecipeSchema,
  type Op,
  type VoxelMesh,
} from "@hitreg/core";
// @ts-expect-error plain JS tool module
import { GltfBuilder } from "../../../tools/wfc-3d/gltf.mjs";
import { checkFormationMesh, terrainSolid, type FormationCheck } from "./rock-formations-check.mts";

const MIN_TRIANGLES = 60;
const MIN_SIZE = 2;

const argv = process.argv.slice(2);
const valued = new Set(["--scene", "--seed", "--voxel", "--margin", "--spacing", "--scale"]);
const positional = argv.filter((a, i) => !a.startsWith("--") && !(i > 0 && valued.has(argv[i - 1]!)));
const flag = (name: string): string | undefined => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
};
const has = (name: string) => argv.includes(`--${name}`);
const [project, world, siteId] = positional;
if (!project || !world || !siteId) {
  console.error("usage: rock-formations <project> <world> <siteId> [--scene <scene>] [--dry-run] [--no-bake] [--seed N] [--voxel m] [--margin m] [--spacing m] [--scale k]");
  process.exit(1);
}
const assets = join("projects", project, "assets");
const recipe = worldRecipeSchema.parse(JSON.parse(readFileSync(join(assets, "worlds", `${world}.json`), "utf8")));
const site = (recipe.features.fallSites ?? []).find((s) => s.id === siteId);
if (!site) {
  console.error(`no fall site "${siteId}" in ${world}; have: ${(recipe.features.fallSites ?? []).map((s) => s.id).join(", ")}`);
  process.exit(1);
}
if (!site.formations) console.warn(`note: site "${siteId}" has no \`formations\` block, so its scree does not know about these masses (rests under/inside them). Add "formations": {} to the site doc.`);
const t0 = performance.now();
const field = createWorldField(recipe);
const t1 = performance.now();
const num = (name: string) => (flag(name) !== undefined ? Number(flag(name)) : undefined);
const overrides = Object.fromEntries(
  Object.entries({ seed: num("seed"), voxelSize: num("voxel"), margin: num("margin"), spacing: num("spacing"), scale: num("scale") }).filter(([, v]) => v !== undefined),
);
if (Object.keys(overrides).length) console.warn(`note: ${JSON.stringify(overrides)} overrides the site doc's formations options; the scree still reads the doc's.`);
// the trim is cut from the terrain AS MESHED (a field.height trim ends above the real ground on steep walls: holes)
const around = site.course.length ? site.course : [site.at];
const xs = around.map((p) => p[0]), zs = around.map((p) => p[1]);
const md = meshDensity(field, { x0: Math.min(...xs) - 80, x1: Math.max(...xs) + 80, z0: Math.min(...zs) - 80, z1: Math.max(...zs) + 80, y0: -40, y1: 160 });
const groundAt = (x: number, z: number) => md.down(x, z, field.height(x, z) + 30, field.height(x, z) - 30) ?? field.height(x, z);
const result = rockFormations(field, { id: site.id, course: site.course, at: site.at }, { ...(site.formations ?? {}), ...overrides, groundAt });
const t2 = performance.now();
const kinds = new Map<string, number>();
for (const m of result.masses) kinds.set(m.kind, (kinds.get(m.kind) ?? 0) + 1);
console.log(
  `field ${(t1 - t0).toFixed(0)} ms, generate ${(t2 - t1).toFixed(0)} ms: river ${result.river}, ${result.tiers} tiers, ${result.masses.length} masses (` +
    [...kinds].map(([k, n]) => `${k} ${n}`).join(", ") +
    `), ${result.docs.length} doc(s), ${result.docs.reduce((a, d) => a + d.nodes.length, 0)} nodes`,
);

/** The mesh restricted to the components `keep` accepts (by index in the check's component order). */
function keepComponents(mesh: VoxelMesh, check: FormationCheck, keep: (index: number) => boolean): VoxelMesh {
  const indices: number[] = [];
  for (let t = 0; t < mesh.triangleCount; t++) {
    if (keep(check.vertexComponent[mesh.indices[t * 3]!]!)) indices.push(mesh.indices[t * 3]!, mesh.indices[t * 3 + 1]!, mesh.indices[t * 3 + 2]!);
  }
  const remap = new Int32Array(mesh.vertexCount).fill(-1);
  let n = 0;
  for (const v of indices) if (remap[v] === -1) remap[v] = n++;
  const S = mesh.surfaceCount;
  const positions = new Float32Array(n * 3), normals = new Float32Array(n * 3), tint = new Float32Array(n * 3), splat = new Float32Array(n * S);
  for (let v = 0; v < mesh.vertexCount; v++) {
    const o = remap[v]!;
    if (o < 0) continue;
    positions.set(mesh.positions.subarray(v * 3, v * 3 + 3), o * 3);
    normals.set(mesh.normals.subarray(v * 3, v * 3 + 3), o * 3);
    if (mesh.tint.length) tint.set(mesh.tint.subarray(v * 3, v * 3 + 3), o * 3);
    splat.set(mesh.splat.subarray(v * S, v * S + S), o * S);
  }
  return { ...mesh, positions, normals, tint, splat, indices: Uint32Array.from(indices, (v) => remap[v]!), vertexCount: n, triangleCount: indices.length / 3 };
}

const summary = (c: FormationCheck) => `open edges ${c.openEdges} (exposed ${c.exposedOpenEdges}), components ${c.components.length}, unsupported ${c.unsupported}`;

/** GLB (binary glTF): the loader gets the bytes directly, no base64 string parse on the main thread. */
function writeGlb(mesh: VoxelMesh, file: string): number {
  const b = new GltfBuilder("HitReg rock formations (baked DC volume)");
  const count = mesh.vertexCount;
  const attributes: Record<string, number> = {
    POSITION: b.pushAccessor(mesh.positions, "VEC3", { minMax: true }),
    NORMAL: b.pushAccessor(mesh.normals, "VEC3"),
    COLOR_0: b.pushAccessor(mesh.tint.length === count * 3 ? mesh.tint : new Float32Array(count * 3).fill(1), "VEC3"),
  };
  const S = mesh.surfaceCount;
  for (let k = 0; k * 4 < S; k++) {
    const a = new Float32Array(count * 4);
    for (let i = 0; i < count; i++) for (let j = 0; j < 4; j++) a[i * 4 + j] = k * 4 + j < S ? mesh.splat[i * S + k * 4 + j]! : 0;
    attributes["_SPLATWEIGHT" + (k ? String(k + 1) : "")] = b.pushAccessor(a, "VEC4");
  }
  b.pushNode({ mesh: b.pushMesh({ primitives: [{ attributes, indices: b.pushAccessor(mesh.indices, "SCALAR") }] }) }, true);
  const doc = b.finish();
  const uri: string = doc.buffers[0].uri;
  const bin = Buffer.from(uri.slice(uri.indexOf(",") + 1), "base64");
  const json = Buffer.from(JSON.stringify({ ...doc, buffers: [{ byteLength: bin.byteLength }] }), "utf8");
  const jsonPad = (4 - (json.byteLength % 4)) % 4, binPad = (4 - (bin.byteLength % 4)) % 4;
  const total = 12 + 8 + json.byteLength + jsonPad + 8 + bin.byteLength + binPad;
  const out = Buffer.alloc(total);
  let o = 0;
  out.writeUInt32LE(0x46546c67, o); o += 4;
  out.writeUInt32LE(2, o); o += 4;
  out.writeUInt32LE(total, o); o += 4;
  out.writeUInt32LE(json.byteLength + jsonPad, o); o += 4;
  out.writeUInt32LE(0x4e4f534a, o); o += 4;
  json.copy(out, o); o += json.byteLength;
  out.fill(0x20, o, o + jsonPad); o += jsonPad;
  out.writeUInt32LE(bin.byteLength + binPad, o); o += 4;
  out.writeUInt32LE(0x004e4942, o); o += 4;
  bin.copy(out, o); o += bin.byteLength;
  out.fill(0, o, o + binPad);
  writeFileSync(file, out);
  return total;
}

const ids = result.docs.map((_, i) => `rock-${siteId}${result.docs.length > 1 ? `-${i + 1}` : ""}`);
const bake = !has("no-bake");
const baked: (VoxelMesh | null)[] = [];
for (const [i, doc] of result.docs.entries()) {
  const m0 = performance.now();
  const raw = buildVolumeMesh(createVolume(doc));
  const meshMs = performance.now() - m0;
  // the support checks against the meshed terrain (rock-formations-check.mts): a piece that floats,
  // is not seated on its lowest part, or overhangs the gorge, and slivers under MIN_TRIANGLES /
  // MIN_SIZE, are dropped from the bake. The scree never rests on formations (only avoids them),
  // so a dropped piece leaves nothing hanging.
  const solid = terrainSolid(field, raw);
  const before = checkFormationMesh(raw, solid);
  console.log(`${ids[i]}: meshed ${raw.triangleCount} tris in ${meshMs.toFixed(0)} ms (what a live csg entity costs at load); before: ${summary(before)}`);
  const keep = (k: number) => {
    const c = before.components[k];
    return !!c && c.ok && c.triangles >= MIN_TRIANGLES && Math.max(...c.size) >= MIN_SIZE;
  };
  for (const c of before.components) {
    const kept = keep(c.index);
    if (!kept || process.env.ALL) console.log(`  piece #${c.index} ${String(c.triangles).padStart(5)} tris ${c.size.map((v) => v.toFixed(1)).join("x").padEnd(15)} seated ${(c.seated * 100).toFixed(0).padStart(3)}%  overhang ${c.overhang.toFixed(1)} m  ${kept ? "kept" : `DROPPED (${c.why || "sliver"})`}`);
  }
  const clean = keepComponents(raw, before, keep);
  const after = checkFormationMesh(clean, solid);
  console.log(`  after: ${summary(after)}; ${clean.triangleCount} tris`);
  if (after.exposedOpenEdges || after.unsupported) console.warn("  CHECK FAILED after cleaning (see rock-formations-check.mts)");
  baked.push(clean);
}
if (has("dry-run")) {
  console.log("(dry run: nothing written)");
  process.exit(0);
}
mkdirSync(join(assets, "volumes"), { recursive: true });
mkdirSync(join(assets, "models", "rock-formations"), { recursive: true });
for (const [i, doc] of result.docs.entries()) {
  const file = join(assets, "volumes", `${ids[i]}.json`);
  writeFileSync(file, JSON.stringify(doc, null, 1) + "\n");
  console.log(`wrote ${file}`);
  if (bake) {
    const glb = join(assets, "models", "rock-formations", `${ids[i]}.glb`);
    writeGlb(baked[i]!, glb);
    console.log(`wrote ${glb} (${(statSync(glb).size / 1024).toFixed(0)} KB)`);
  }
}

const sceneName = flag("scene");
if (sceneName) {
  const scenePath = join(assets, "scenes", `${sceneName}.scene.json`);
  if (!existsSync(scenePath)) throw new Error(`no scene ${scenePath}`);
  // re-read right before the write: the editor autosaves
  const doc = JSON.parse(readFileSync(scenePath, "utf8"));
  const registry = new ComponentRegistry();
  registerCoreComponents(registry);
  registerChunkComponents(registry);
  const ops: Op[] = [];
  // drop entities from an earlier run whose volume no longer exists (the split count changed)
  for (const id of Object.keys(doc.entities)) {
    if (id.startsWith(`rock-${siteId}`) && !ids.includes(id)) ops.push({ op: "remove-entity", id });
  }
  for (const id of ids) {
    const source = bake ? { kind: "asset", assetId: `rock-formations/${id}.glb` } : { kind: "csg", volume: id };
    const entity = {
      name: `Rock formations ${id.slice(5)}`,
      parent: null,
      tags: ["rock-formations", siteId],
      components: {
        transform: {},
        mesh: { source, material: recipe.material ?? "terrain/mmo", static: true, castShadow: true, receiveShadow: true },
        collider: { shape: "trimesh" },
      },
    };
    if (doc.entities[id]) ops.push({ op: "remove-entity", id });
    ops.push({ op: "add-entity", id, entity } as Op);
  }
  const next = applyOps(doc, ops, registry).doc;
  writeFileSync(scenePath, JSON.stringify(next, null, 2) + "\n");
  console.log(`placed ${ids.join(", ")} (${bake ? "baked GLB" : "live csg volume"}) in ${scenePath}`);
}

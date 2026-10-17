/**
 * `landmark` — bake a `landmark` operator (the general LANDMARK STAMP, packages/core voxel/landmark-stamp.ts): its
 * solids dual-contoured at the operator's voxel, merged across tiles, buried rock trimmed, decimated, split ONE MESH PER
 * MATERIAL (every `zone` / `zone-stone` / `surface:` role shares the world's terrain-splat material = one draw; each
 * named material asset = one more draw), each with a trimesh collider, in one prefab `landmarks/<opId>-<digest>`.
 *
 *   node node_modules/tsx/dist/cli.mjs tools/landmark.mts <project> <world> <opId> [--recipe <file>] [--into <project>]
 *        [--dry-run] [--force] [--report <file.json>] [--material <id>] [--glb-only <page.html>]
 *   node node_modules/tsx/dist/cli.mjs tools/landmark.mts --spec <spec.json> [--voxel 0.5] [--yaw 0] [--scale 1]
 *        [--check] [--glb-only <page.html>]          (no world: compile + thin-wall gate, or a mesh-only page in seconds)
 *
 * REACH: when the operator declares `targets` or `openings`, the baked collider is walked from the ground around
 * (tools/_collider-reach.mts); every target it cannot reach is a FAULT (exit 1). A landmark is authored geometry: the
 * tool reports, it does not cut repair ramps (fix the spec). A re-run with the same digest writes nothing (--force
 * rewrites); a changed spec names a new bake and old bakes stay (an undo names them again).
 * After a bake: `worldgen float`, `worldgen lips --recipe`, `worldgen op --check`, and see-through.mts on a scene near it.
 */
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
  buildVolumeMesh, compileLandmarkOperator, compileLandmarkSpec, createVolume, createWorldField, landmarkFootprint, landmarkOperatorSchema,
  operatorParams, worldRecipeSchema, zoneWallStone, type CsgNode, type VoxelMesh, type WorldRecipe,
} from "@hitreg/core";
import { colliderReach, type Vec3 } from "./_collider-reach.mts";
import { operatorReader } from "./worldgen-operators.mts";
import { mergeMeshes, openEdges, writeVolumeGlb } from "./_volume-glb.mts";
// @ts-expect-error plain JS tool module
import { decimateRough } from "../../../tools/mesh-dc/decimate.mjs";

const argv = process.argv.slice(2);
const flag = (name: string): string | undefined => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : undefined; };
const has = (name: string) => argv.includes(`--${name}`);
const valued = new Set(["--triplanar-scale", "--recipe", "--into", "--report", "--material", "--glb-only", "--spec", "--voxel", "--yaw", "--scale", "--error"]);
const positional = argv.filter((a, i) => !a.startsWith("--") && !(i > 0 && valued.has(argv[i - 1]!)));
const t0 = performance.now();

type Tile = { min: [number, number, number]; max: [number, number, number] };

/** DC-bake every tile with a palette + surface per node; merged (seams weld on the lattice). */
function bakeTiles(nodes: CsgNode[], tiles: Tile[], voxel: number, palette: string[], tint?: [number, number, number]): { mesh: VoxelMesh; cells: number } {
  const parts: VoxelMesh[] = [];
  let cells = 0;
  for (const tile of tiles) {
    const m = buildVolumeMesh(createVolume({ name: "landmark tile", voxelSize: voxel, bounds: tile, palette, surface: { floor: 0, wall: 0, ceiling: 0 }, nodes, paint: [], ...(tint ? { tint } : {}) }));
    cells += tile.max.map((v, i) => Math.round((v - tile.min[i]!) / voxel)).reduce((a, b) => a * b, 1);
    if (m.triangleCount) parts.push(m);
  }
  return { mesh: mergeMeshes(parts, palette.length), cells };
}

/** Decimate on the used splat channels only (meshopt weighs <= 32 attributes), then widen back. */
function decimate(m: VoxelMesh, error: number): VoxelMesh {
  const S = m.surfaceCount, used: number[] = [];
  for (let k = 0; k < S; k++) for (let i = 0; i < m.vertexCount; i++) if (m.splat[i * S + k]! > 0) { used.push(k); break; }
  const narrow = new Float32Array(m.vertexCount * used.length);
  for (let i = 0; i < m.vertexCount; i++) used.forEach((k, j) => { narrow[i * used.length + j] = m.splat[i * S + k]!; });
  const dec = decimateRough({ ...m, splat: narrow, surfaceCount: used.length }, { error }) as VoxelMesh;
  const wide = new Float32Array(dec.vertexCount * S);
  for (let i = 0; i < dec.vertexCount; i++) used.forEach((k, j) => { wide[i * S + k] = dec.splat[i * used.length + j]!; });
  return { ...dec, splat: wide, surfaceCount: S } as VoxelMesh;
}

/** Keep the triangles `keep(t)` accepts, re-indexed compactly. */
function subMesh(m: VoxelMesh, keep: (t: number) => boolean): VoxelMesh {
  const S = m.surfaceCount, map = new Int32Array(m.vertexCount).fill(-1), idx: number[] = [];
  let n = 0;
  for (let t = 0; t < m.indices.length / 3; t++) if (keep(t)) for (let e = 0; e < 3; e++) { const v = m.indices[t * 3 + e]!; if (map[v]! < 0) map[v] = n++; idx.push(map[v]!); }
  const positions = new Float32Array(n * 3), normals = new Float32Array(n * 3), tint = new Float32Array(n * 3), splat = new Float32Array(n * S);
  const min: [number, number, number] = [Infinity, Infinity, Infinity], max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (let v = 0; v < m.vertexCount; v++) { const o = map[v]!; if (o < 0) continue;
    for (let a = 0; a < 3; a++) { const p = m.positions[v * 3 + a]!; positions[o * 3 + a] = p; normals[o * 3 + a] = m.normals[v * 3 + a]!; tint[o * 3 + a] = m.tint.length ? m.tint[v * 3 + a]! : 1; min[a] = Math.min(min[a]!, p); max[a] = Math.max(max[a]!, p); }
    splat.set(m.splat.subarray(v * S, v * S + S), o * S); }
  return { positions, normals, tint, splat, surfaceCount: S, indices: Uint32Array.from(idx), min, max, vertexCount: n, triangleCount: idx.length / 3 } as VoxelMesh;
}

/** A standalone page that shows just the baked mesh (orbit, per-material colours): shape iteration in seconds. */
function glbOnlyPage(groups: { name: string; mesh: VoxelMesh }[], file: string, title: string): void {
  const pack = groups.map((g) => ({ name: g.name, pos: Array.from(g.mesh.positions, (v) => Math.round(v * 100) / 100), idx: Array.from(g.mesh.indices) }));
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title><style>html,body{margin:0;height:100%;background:#15171a;color:#cfd3d8;font:13px system-ui}#i{position:fixed;left:10px;top:8px}</style></head><body><div id="i">${title} — drag to orbit, wheel to zoom</div>
<script type="importmap">{"imports":{"three":"https://cdn.jsdelivr.net/npm/three@0.169.0/build/three.module.js","three/addons/":"https://cdn.jsdelivr.net/npm/three@0.169.0/examples/jsm/"}}</script>
<script type="module">import * as T from "three";import {OrbitControls} from "three/addons/controls/OrbitControls.js";
const G=${JSON.stringify(pack)};const r=new T.WebGLRenderer({antialias:true});r.setSize(innerWidth,innerHeight);document.body.appendChild(r.domElement);
const s=new T.Scene();s.background=new T.Color(0x15171a);const c=new T.PerspectiveCamera(50,innerWidth/innerHeight,0.1,4000);
s.add(new T.HemisphereLight(0xd8e0ff,0x403020,1.2));const d=new T.DirectionalLight(0xffffff,2);d.position.set(40,80,30);s.add(d);
const cols=[0xa89a86,0x7f8a99,0x9a6f5a,0x6f8f6a];const box=new T.Box3();G.forEach((g,k)=>{const geo=new T.BufferGeometry();geo.setAttribute("position",new T.Float32BufferAttribute(g.pos,3));geo.setIndex(g.idx);geo.computeVertexNormals();const m=new T.Mesh(geo,new T.MeshStandardMaterial({color:cols[k%4],roughness:.95,flatShading:false}));s.add(m);box.expandByObject(m);});
const grid=new T.GridHelper(200,40,0x444444,0x2a2a2a);s.add(grid);const ctr=box.getCenter(new T.Vector3()),sz=box.getSize(new T.Vector3()).length();
c.position.set(ctr.x+sz*.7,ctr.y+sz*.35,ctr.z+sz*.7);const o=new OrbitControls(c,r.domElement);o.target.copy(ctr);o.update();
(function f(){requestAnimationFrame(f);r.render(s,c);})();addEventListener("resize",()=>{c.aspect=innerWidth/innerHeight;c.updateProjectionMatrix();r.setSize(innerWidth,innerHeight);});</script></body></html>`;
  mkdirSync(dirname(resolve(file)), { recursive: true });
  writeFileSync(file, html);
  console.log(`wrote ${file} (${(html.length / 1024).toFixed(0)} KB, ${groups.map((g) => `${g.name} ${g.mesh.triangleCount} tris`).join(", ")})`);
}

// ---------------------------------------------------------------- standalone: --spec <file> [--check] [--glb-only page]
if (flag("spec")) {
  const spec = JSON.parse(readFileSync(flag("spec")!, "utf8"));
  const voxel = Number(flag("voxel") ?? 0.5);
  let c;
  try { c = compileLandmarkSpec(spec, { voxel, yaw: Number(flag("yaw") ?? 0), scale: Number(flag("scale") ?? 1) }); }
  catch (e) { console.error(`REFUSED: ${(e as Error).message}`); process.exit(1); }
  console.log(`spec ok: ${c.nodes.length} nodes, roles [${[...new Set(c.roles)].join(", ")}], extent ${c.min.join(",")} .. ${c.max.join(",")}, ${c.tiles.length} tiles at ${voxel} m, digest ${c.digest}; thin-wall gate ok (${c.thin.samples} exempt/noise samples) ${((performance.now() - t0) / 1000).toFixed(1)} s`);
  if (flag("glb-only")) {
    const roleList = [...new Set(c.roles)];
    const nodes = c.nodes.map((n, i) => ({ ...n, surface: { floor: roleList.indexOf(c.roles[i]!), wall: roleList.indexOf(c.roles[i]!), ceiling: roleList.indexOf(c.roles[i]!) } }));
    const { mesh } = bakeTiles(nodes, c.tiles, voxel, roleList);
    const groups = roleList.map((name, k) => ({ name, mesh: subMesh(mesh, (t) => dominant(mesh, t) === k) })).filter((g) => g.mesh.triangleCount);
    glbOnlyPage(groups, flag("glb-only")!, `landmark ${flag("spec")}`);
    console.log(`bake ${((performance.now() - t0) / 1000).toFixed(1)} s, ${mesh.triangleCount} tris raw`);
  }
  process.exit(0);
}

function dominant(m: VoxelMesh, t: number): number {
  const S = m.surfaceCount; let best = 0, bw = -1;
  for (let k = 0; k < S; k++) { let w = 0; for (let e = 0; e < 3; e++) w += m.splat[m.indices[t * 3 + e]! * S + k]!; if (w > bw) { bw = w; best = k; } }
  return best;
}

// ---------------------------------------------------------------- world mode
const [project, world, opId] = positional;
if (!project || !world || !opId) {
  console.error("usage: landmark <project> <world> <opId> [--recipe f] [--into project] [--dry-run] [--force] [--report f] [--material id] [--glb-only page]\n       landmark --spec <spec.json> [--voxel 0.5] [--check] [--glb-only page]");
  process.exit(1);
}
const recipeFile = flag("recipe") ?? join("projects", project, "assets", "worlds", `${world}.json`);
const recipe: WorldRecipe = worldRecipeSchema.parse(JSON.parse(readFileSync(recipeFile, "utf8")));
const doc = (recipe.features.operators ?? []).find((o) => o.id === opId) as Record<string, unknown> | undefined;
if (!doc || doc.op !== "landmark") throw new Error(`no installed landmark operator "${opId}" in ${recipeFile} (worldgen op --apply first)`);
const params = landmarkOperatorSchema.parse(operatorParams(doc));
const reader = operatorReader(recipe, opId);
const c = compileLandmarkOperator(params, reader, { id: opId });
if (!c) throw new Error(`"${opId}" is a Blender source: run with --resolve first (not built yet in this tool)`);
const piece = (recipe.features.landmarks ?? []).find((l) => l.id === `op:${opId}:landmark`);
if (!piece) throw new Error(`the recipe has no op:${opId}:landmark piece (worldgen op --apply)`);
const prefabId = `landmarks/${opId}-${c.compiled.digest}`;
if (piece.prefab !== prefabId) console.warn(`WARNING: the recipe names ${piece.prefab} but the solids rebuild as ${prefabId}: the operator is stale (worldgen op --check / --apply)`);
const [px, footY, pz] = piece.position;
const t1 = performance.now();
console.log(`solids: ${c.compiled.nodes.length} nodes, roles [${[...new Set(c.compiled.roles)].join(", ")}], ${c.compiled.tiles.length} tiles at ${c.compiled.voxel} m, foot y ${footY}, extent ${c.compiled.min.join(",")} .. ${c.compiled.max.join(",")} (${(t1 - t0).toFixed(0)} ms)`);

// ---- surfaces: the world palette; `zone` = the zone's cliff stone sampled around the foot (faces) + its ground cover (tops)
const names = recipe.surfaces.map((s) => s.name);
const field = createWorldField(recipe);
const count = field.surfaceCount, scratch = new Float32Array(count + 3), wall = new Float64Array(count + 3), top = new Float64Array(count + 3);
let wn = 0;
const ring = landmarkFootprint(c.compiled, c.at).cells.filter((_, i) => i % 7 === 0);
for (const [x, z] of ring.length ? ring : [c.at]) {
  const y = field.height(x, z);
  field.surfaceAt(x, y, z, 0.3, scratch, 0); for (let i = 0; i < count + 3; i++) wall[i]! += scratch[i]!;
  field.surfaceAt(x, y, z, 0.98, scratch, 0); for (let i = 0; i < count + 3; i++) top[i]! += scratch[i]!;
  wn++;
}
const wallAvg = Array.from(wall, (v) => v / Math.max(1, wn)), topAvg = Array.from(top, (v) => v / Math.max(1, wn));
const ranked = (w: number[]) => w.slice(0, count).map((v, i) => [i, v] as const).sort((a, b) => b[1] - a[1]);
const stoneName = zoneWallStone(field, wallAvg, wn) ?? (names.includes("rock") ? "rock" : names[ranked(wallAvg)[0]![0]]!);
const stone = names.indexOf(stoneName);
const stoneLike = (i: number) => i === stone || /rock|cliff|stone|slate/i.test(names[i]!);
const cover = ranked(topAvg).find(([i]) => !stoneLike(i))?.[0] ?? stone;
const tint = [wallAvg[count]!, wallAvg[count + 1]!, wallAvg[count + 2]!].map((v) => Math.round(v * 1000) / 1000) as [number, number, number];
const extras: string[] = []; // material assets, one palette slot (and one draw) each; "auto:<surface>" = a triplanar material of that surface's texture
const surfaceFor = (role: string): { floor: number; wall: number; ceiling: number } => {
  let m = params.materials[role] ?? "zone";
  if (m === "zone-splat") return { floor: cover, wall: stone, ceiling: stone };
  if (m === "zone" || m === "zone-stone") m = `auto:${stoneName}`;
  else if (m.startsWith("surface:")) { if (!names.includes(m.slice(8))) throw new Error(`materials.${role}: no surface "${m.slice(8)}" in the world palette`); m = `auto:${m.slice(8)}`; }
  if (!extras.includes(m)) extras.push(m);
  const i = names.length + extras.indexOf(m);
  return { floor: i, wall: i, ceiling: i };
};
const nodes = c.compiled.nodes.map((n, i) => ({ ...n, surface: surfaceFor(c.compiled.roles[i]!) }));
const palette = [...names, ...extras];
console.log(`surfaces: zone faces ${stoneName} (#${stone}), tops ${names[cover]} (#${cover}), tint ${tint.join(",")}; named materials [${extras.join(", ")}]`);

// ---- bake, trim buried rock (all three corners > 1.5 m under the installed terrain), split per material, decimate
const { mesh: raw, cells } = bakeTiles(nodes, c.compiled.tiles, c.compiled.voxel, palette, tint);
const buried = (v: number) => raw.positions[v * 3 + 1]! + footY < field.height(raw.positions[v * 3]! + px, raw.positions[v * 3 + 2]! + pz) - 1.5;
const visible = subMesh(raw, (t) => !(buried(raw.indices[t * 3]!) && buried(raw.indices[t * 3 + 1]!) && buried(raw.indices[t * 3 + 2]!)));
const error = Number(flag("error") ?? 0.05);
const groups: { key: string; material: string; mesh: VoxelMesh }[] = [];
const splatGroup = subMesh(visible, (t) => dominant(visible, t) < names.length);
if (splatGroup.triangleCount) groups.push({ key: "", material: flag("material") ?? recipe.material ?? "terrain/mmo", mesh: decimate(splatGroup, error) });
extras.forEach((m, j) => { const g = subMesh(visible, (t) => dominant(visible, t) === names.length + j); if (g.triangleCount) groups.push({ key: `.${j + 1}`, material: m, mesh: { ...decimate(g, error), splat: new Float32Array(0), surfaceCount: 0 } as VoxelMesh }); }); // a material group carries no splat weights
const bakeSeconds = (performance.now() - t1) / 1000;
const tris = groups.reduce((a, g) => a + g.mesh.triangleCount, 0), verts = groups.reduce((a, g) => a + g.mesh.vertexCount, 0);
console.log(`bake: ${cells} cells -> ${raw.triangleCount} tris -> ${visible.triangleCount} (buried dropped) -> ${tris} tris, ${verts} verts (error ${error} m) in ${groups.length} draw(s) [${groups.map((g) => `${g.material} ${g.mesh.triangleCount}`).join(", ")}], ${bakeSeconds.toFixed(1)} s; open edges ${groups.map((g) => openEdges(g.mesh)).join("/")}`);

// ---- reach: declared targets + openings, on the baked collider (all groups)
const yawR = (params.yaw * Math.PI) / 180, cy = Math.cos(yawR), sy = Math.sin(yawR);
const toWorld = (l: number[]): [number, number, number] => { const x = l[0]! * params.scale, z = l[2]! * params.scale; return [px + x * cy + z * sy, footY + l[1]! * params.scale, pz - x * sy + z * cy]; };
const targets = [...params.targets.map((t) => ({ name: t.name, w: toWorld(t.at) })), ...params.openings.map((o) => ({ name: `opening ${o.name}`, w: toWorld(o.at) }))];
const faults: string[] = [];
if (targets.length) {
  const all = mergeMeshes(groups.map((g) => g.mesh), palette.length);
  const reach = colliderReach({ positions: all.positions, indices: all.indices, offset: [px, footY, pz] }, {
    center: [px, pz], radius: Math.max(c.compiled.max[0], -c.compiled.min[0], c.compiled.max[2], -c.compiled.min[2]) * params.scale, ground: (x, z) => field.height(x, z),
    anchors: targets.map((t) => [t.w[0], t.w[2], t.w[1]] as Vec3), caves: [],
  });
  targets.forEach((t, k) => { const ok = reach.withCaves[k]; console.log(`reach ${ok ? "ok   " : "FAULT"} ${t.name} at ${t.w.map((v) => v.toFixed(1)).join(",")}`); if (!ok) faults.push(t.name); });
  if (faults.length) process.exitCode = 1;
} else console.log("reach: no targets/openings declared (the reach loop runs only for walkable targets)");

const report = { prefab: prefabId, digest: c.compiled.digest, nodes: c.compiled.nodes.length, tiles: c.compiled.tiles.length, cells, voxel: c.compiled.voxel, triangles: tris, vertices: verts, draws: groups.length, materials: groups.map((g) => g.material), bakeSeconds: Math.round(bakeSeconds * 10) / 10, footY, surfaces: { faces: stoneName, tops: names[cover] }, reachFaults: faults };
if (flag("report")) writeFileSync(flag("report")!, JSON.stringify(report, null, 2) + "\n");
if (flag("glb-only")) glbOnlyPage(groups.map((g) => ({ name: g.material, mesh: g.mesh })), flag("glb-only")!, `landmark ${opId}`);
if (has("dry-run")) { console.log("(dry run: nothing written)"); process.exit(process.exitCode ?? 0); }

const into = join("projects", flag("into") ?? project, "assets");
const name = prefabId.slice("landmarks/".length);
const prefabFile = join(into, "prefabs", "landmarks", `${name}.json`);
if (existsSync(prefabFile) && !has("force")) { console.log(`${prefabFile} exists (same digest): nothing to do (--force rewrites)`); process.exit(process.exitCode ?? 0); }
mkdirSync(join(into, "models", "landmarks"), { recursive: true });
mkdirSync(join(into, "prefabs", "landmarks"), { recursive: true });
/** A triplanar standard material of a world surface's own texture (natural rock: no UVs, world-space, no stretch). */
const materialId = (m: string): string => {
  if (!m.startsWith("auto:")) return m;
  const surf = recipe.surfaces.find((x) => x.name === m.slice(5)) as { name: string; map?: string; color?: string; roughness?: number } | undefined;
  const id = `landmarks/${m.slice(5)}`, file = join(into, "materials", `${id}.json`);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify({ shader: "standard", color: surf?.map ? "#ffffff" : surf?.color ?? "#8a7a6a", ...(surf?.map ? { map: surf.map } : {}), filter: "nearest", roughness: surf?.roughness ?? 0.95, metalness: 0, triplanar: true, triplanarScale: Number(flag("triplanar-scale") ?? 4.5), repeat: [1, 1] }, null, 2) + "\n");
  return id;
};
for (const g of groups) g.material = materialId(g.material);
const entities: Record<string, unknown> = {};
let bytes = 0;
groups.forEach((g, k) => {
  const glb = join(into, "models", "landmarks", `${name}${g.key}.glb`);
  bytes += writeVolumeGlb(g.mesh, glb);
  entities[k === 0 ? "rock" : `part${k}`] = {
    name: k === 0 ? `${opId} landmark` : `${opId} ${g.material}`, parent: k === 0 ? null : "rock", tags: ["landmark", opId],
    components: {
      transform: {},
      mesh: { source: { kind: "asset", assetId: `landmarks/${name}${g.key}.glb` }, material: g.material, static: true, castShadow: true, receiveShadow: true },
      collider: { shape: "trimesh" },
    },
  };
});
writeFileSync(prefabFile, JSON.stringify({ version: 1, name: `${opId} landmark`, root: "rock", entities }, null, 2) + "\n");
console.log(`wrote ${groups.length} GLB(s) (${(bytes / 1024 / 1024).toFixed(1)} MB) and ${prefabFile}; total ${((performance.now() - t0) / 1000).toFixed(1)} s`);
void statSync;

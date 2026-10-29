/**
 * `landmark` — bake a `landmark` operator (the general LANDMARK STAMP, packages/core voxel/landmark-stamp.ts): its
 * solids dual-contoured at the operator's voxel, merged across tiles, buried rock trimmed, decimated, split ONE MESH PER
 * MATERIAL (every `zone` / `zone-stone` / `surface:` role shares the world's terrain-splat material = one draw; each
 * named material asset = one more draw), in one prefab `landmarks/<opId>-<digest>`; the collider is every surface welded
 * and split into one hidden trimesh model per map cell (`<name>.collider.<cx>_<cz>.glb`, streamed by every cell the
 * landmark covers: core voxel/ledge-landmark.ts `landmarkColliderTileId`).
 *
 *   node node_modules/tsx/dist/cli.mjs tools/landmark.mts <project> <world> <opId> [--recipe <file>] [--into <project>]
 *        [--dry-run] [--force] [--report <file.json>] [--material <id>] [--glb-only <page.html>]
 *   node node_modules/tsx/dist/cli.mjs tools/landmark.mts <project> <world> <opId> --retile [--into <project>]
 *        (re-split the recipe-named bake's collider tiles by the current cell rule; no re-bake, digest unchanged)
 *   node node_modules/tsx/dist/cli.mjs tools/landmark.mts --spec <spec.json> [--voxel 0.5] [--yaw 0] [--scale 1]
 *        [--check] [--glb-only <page.html>]          (no world: compile + thin-wall gate, or a mesh-only page in seconds)
 *
 * REACH: when the operator declares `targets` or `openings`, the baked collider is walked from the ground around
 * (tools/_collider-reach.mts); every target it cannot reach is a FAULT (exit 1). A landmark is authored geometry: the
 * tool reports, it does not cut repair ramps (fix the spec). A re-run with the same digest writes nothing (--force
 * rewrites); a changed spec names a new bake and this op's superseded bakes are removed (no iteration files; after an
 * undo, re-run the bake: the same doc rebuilds the same digest).
 * After a bake: `worldgen float`, `worldgen lips --recipe`, `worldgen op --check`, and see-through.mts on a scene near it.
 */
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
  buildLandmarkMesh, buildVolumeMesh, wallLandmarkParams, wallParamsSchema, WALL_SCALE, compileLandmarkOperator, compileLandmarkSpec, createVolume, createWorldField, isNaturalRole, landmarkFootprint, landmarkOperatorSchema,
  operatorParams, worldRecipeSchema, zoneWallStone, type BuiltGroup, type CsgNode, type VoxelMesh, type WorldRecipe,
} from "@hitreg/core";
import { colliderReach, type Vec3 } from "./_collider-reach.mts";
import { operatorReader } from "./worldgen-operators.mts";
import { mergeMeshes, openEdges, writeBuiltGlb, writeVolumeGlb } from "./_volume-glb.mts";
import { neighbourColliders, pruneSupersededBakes, retileColliderTiles, writeColliderTiles } from "./_landmark-colliders.mts";
import { readdirSync } from "node:fs";
import { landmarkTriplanarScale } from "./_art-check.mts";

/** TOWN TEXEL STANDARD for built roles: metres per repeat = texture pixels / 40. */
const TEXELS_PER_M = 40;
/** A material asset (any project) and its map's pixel size; null when not found or triplanar. */
function materialInfo(id: string, prefer: string[]): { triplanar: boolean; px?: [number, number]; file?: string } | null {
  const projects = [...prefer, ...readdirSync("projects").filter((p) => !prefer.includes(p))];
  for (const p of projects) {
    const f = join("projects", p, "assets", "materials", `${id}.json`);
    if (!existsSync(f)) continue;
    const m = JSON.parse(readFileSync(f, "utf8")) as { map?: string; triplanar?: boolean };
    if (!m.map) return { triplanar: !!m.triplanar, file: f };
    for (const q of [p, ...projects]) {
      const t = join("projects", q, "assets", "textures", m.map);
      if (!existsSync(t)) continue;
      const b = readFileSync(t);
      return { triplanar: !!m.triplanar, px: [b.readUInt32BE(16), b.readUInt32BE(20)], file: f };
    }
    return { triplanar: !!m.triplanar, file: f };
  }
  return null;
}

/** Built groups sharing one material concatenated (one draw per material). */
function mergeBuilt(gs: BuiltGroup[]): BuiltGroup {
  if (gs.length === 1) return gs[0]!;
  const V = gs.reduce((a, g) => a + g.vertexCount, 0), I = gs.reduce((a, g) => a + g.indices.length, 0);
  const positions = new Float32Array(V * 3), normals = new Float32Array(V * 3), uvs = new Float32Array(V * 2), indices = new Uint32Array(I);
  let v = 0, i = 0;
  for (const g of gs) { positions.set(g.positions, v * 3); normals.set(g.normals, v * 3); uvs.set(g.uvs, v * 2); for (let k = 0; k < g.indices.length; k++) indices[i + k] = g.indices[k]! + v; v += g.vertexCount; i += g.indices.length; }
  const min = [0, 1, 2].map((a) => Math.min(...gs.map((g) => g.min[a]!))) as [number, number, number], max = [0, 1, 2].map((a) => Math.max(...gs.map((g) => g.max[a]!))) as [number, number, number];
  return { role: gs.map((g) => g.role).join("+"), positions, normals, uvs, indices, vertexCount: V, triangleCount: I / 3, min, max };
}

/** Keep the triangles `keep(t)` accepts of a built group (buried trim). */
function subBuilt(g: BuiltGroup, keep: (t: number) => boolean): BuiltGroup {
  const idx: number[] = [];
  for (let t = 0; t < g.indices.length / 3; t++) if (keep(t)) idx.push(g.indices[t * 3]!, g.indices[t * 3 + 1]!, g.indices[t * 3 + 2]!);
  return { ...g, indices: Uint32Array.from(idx), triangleCount: idx.length / 3 };
}
import { visibleGround } from "./_landmark-ground.mts";
import { dropTwinFaces } from "./_built-twins.mts";
// @ts-expect-error plain JS tool module
import { decimateRough } from "../../../tools/mesh-dc/decimate.mjs";

const argv = process.argv.slice(2);
const flag = (name: string): string | undefined => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : undefined; };
const has = (name: string) => argv.includes(`--${name}`);
const valued = new Set(["--triplanar-scale", "--recipe", "--into", "--report", "--material", "--glb-only", "--spec", "--voxel", "--yaw", "--scale", "--error", "--kind"]);
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
  try { c = compileLandmarkSpec(spec, { voxel, yaw: Number(flag("yaw") ?? 0), scale: Number(flag("scale") ?? 1), skipThin: flag("kind") === "built" }); }
  catch (e) { console.error(`REFUSED: ${(e as Error).message}`); process.exit(1); }
  console.log(`spec ok: ${c.nodes.length} nodes, roles [${[...new Set(c.roles)].join(", ")}], extent ${c.min.join(",")} .. ${c.max.join(",")}, ${c.tiles.length} tiles at ${voxel} m, digest ${c.digest}; thin-wall gate ok (${c.thin.samples} exempt/noise samples) ${((performance.now() - t0) / 1000).toFixed(1)} s`);
  if (flag("kind") === "built") {
    let b;
    try { b = buildLandmarkMesh(c); } catch (e) { console.error(`REFUSED (built): ${(e as Error).message}`); process.exit(1); }
    console.log(`built: ${b.triangles} tris in ${b.groups.length} role group(s) [${b.groups.map((g) => `${g.role} ${g.triangleCount}`).join(", ")}], ${b.natural} natural part(s) left to the DC stamp${b.revealSkipped.length ? `, NO REVEAL for cuts through non-convex parts: ${b.revealSkipped.join(", ")}` : ""} (${((performance.now() - t0) / 1000).toFixed(1)} s)`);
    if (flag("glb-only")) glbOnlyPage(b.groups.map((g) => ({ name: g.role, mesh: g as unknown as VoxelMesh })), flag("glb-only")!, `built landmark ${flag("spec")}`);
    process.exit(0);
  }
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
if (!doc || (doc.op !== "landmark" && doc.op !== "wall")) throw new Error(`no installed landmark or wall operator "${opId}" in ${recipeFile} (worldgen op --apply first)`);
const reader = operatorReader(recipe, opId);
// a `wall` is a built landmark whose solids come from the `wall` generator (its params -> the landmark's)
const params = doc.op === "wall" ? wallLandmarkParams(operatorParams(doc), reader, { id: opId }) : landmarkOperatorSchema.parse(operatorParams(doc));
const c = compileLandmarkOperator(params, reader, { id: opId });
if (!c) throw new Error(`"${opId}" is a Blender source: run with --resolve first (not built yet in this tool)`);
const piece = (recipe.features.landmarks ?? []).find((l) => l.id === `op:${opId}:landmark`);
if (!piece) throw new Error(`the recipe has no op:${opId}:landmark piece (worldgen op --apply)`);
if (has("retile")) {
  const intoDir = join("projects", flag("into") ?? project, "assets");
  const r = retileColliderTiles(intoDir, piece.prefab, { position: piece.position, radius: piece.radius }, recipe.cellSize);
  console.log(`retile ${piece.prefab}: ${r.before} tile triangles -> ${r.triangles} in ${r.cells.length} cell tile(s) [${r.cells.join(" ")}]`);
  process.exit(0);
}
const prefabId = `landmarks/${opId}-${c.compiled.digest}`;
if (piece.prefab !== prefabId) console.warn(`WARNING: the recipe names ${piece.prefab} but the solids rebuild as ${prefabId}: the operator is stale (worldgen op --check / --apply)`);
const [px, footY, pz] = piece.position;
const t1 = performance.now();
console.log(`solids: ${c.compiled.nodes.length} nodes, roles [${[...new Set(c.compiled.roles)].join(", ")}], ${c.compiled.tiles.length} tiles at ${c.compiled.voxel} m, foot y ${footY}, extent ${c.compiled.min.join(",")} .. ${c.compiled.max.join(",")} (${(t1 - t0).toFixed(0)} ms)`);

// ---- surfaces: the world palette; `zone` = the zone's cliff stone sampled around the foot (faces) + its ground cover (tops)
const names = recipe.surfaces.map((s) => s.name);
const field = createWorldField(recipe);
// the buried trim follows carves (passages, wall-ramp cuts): parts seated on a carved floor are not "buried" (_landmark-ground.mts)
const ground = visibleGround(field);
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
const built = params.kind === "built";
// built: man-made roles are meshed directly; the DC stamp keeps the natural roles (+ every sub, which carves both)
const dcKeep = (i: number) => !built || c.compiled.nodes[i]!.op === "sub" || isNaturalRole(c.compiled.roles[i]!);
const nodes = c.compiled.nodes.map((n, i) => ({ ...n, surface: dcKeep(i) ? surfaceFor(c.compiled.roles[i]!) : { floor: 0, wall: 0, ceiling: 0 } })).filter((_, i) => dcKeep(i));
const hasDc = nodes.some((n) => n.op !== "sub");
const palette = [...names, ...extras];
console.log(`surfaces: zone faces ${stoneName} (#${stone}), tops ${names[cover]} (#${cover}), tint ${tint.join(",")}; named materials [${extras.join(", ")}]`);

// ---- bake, trim buried rock (all three corners > 1.5 m under the installed terrain), split per material, decimate
const { mesh: raw, cells } = hasDc ? bakeTiles(nodes, c.compiled.tiles, c.compiled.voxel, palette, tint) : { mesh: mergeMeshes([], palette.length), cells: 0 };
const buried = (v: number) => raw.positions[v * 3 + 1]! + footY < ground(raw.positions[v * 3]! + px, raw.positions[v * 3 + 2]! + pz) - 1.5;
const visible = subMesh(raw, (t) => !(buried(raw.indices[t * 3]!) && buried(raw.indices[t * 3 + 1]!) && buried(raw.indices[t * 3 + 2]!)));
const error = Number(flag("error") ?? 0.05);
const groups: { key: string; material: string; mesh: VoxelMesh }[] = [];
const splatGroup = subMesh(visible, (t) => dominant(visible, t) < names.length);
if (splatGroup.triangleCount) groups.push({ key: "", material: flag("material") ?? recipe.material ?? "terrain/mmo", mesh: decimate(splatGroup, error) });
extras.forEach((m, j) => { const g = subMesh(visible, (t) => dominant(visible, t) === names.length + j); if (g.triangleCount) groups.push({ key: `.${j + 1}`, material: m, mesh: { ...decimate(g, error), splat: new Float32Array(0), surfaceCount: 0 } as VoxelMesh }); }); // a material group carries no splat weights
// ---- built roles: meshed directly, real UVs at the role tile (texture px / 40 texels per m), one draw per material
const builtGroups: { key: string; material: string; mesh: BuiltGroup }[] = [];
if (built) {
  const prefer = [flag("into") ?? project, project];
  const matOf = (role: string) => { const m = params.materials[role] ?? "zone"; return m === "zone" || m === "zone-stone" || m === "zone-splat" ? `auto:${stoneName}` : m.startsWith("surface:") ? `auto:${m.slice(8)}` : m; };
  const tileOf = (role: string): [number, number] | undefined => {
    if (c.compiled.roleTiles[role]) return c.compiled.roleTiles[role];
    const m = matOf(role); if (m.startsWith("auto:")) return undefined;
    const info = materialInfo(m, prefer);
    if (!info) throw new Error(`materials.${role}: no material asset "${m}" in any project`);
    return info.px ? [info.px[0] / TEXELS_PER_M, info.px[1] / TEXELS_PER_M] : undefined;
  };
  const b = buildLandmarkMesh(c.compiled, { tile: tileOf });
  if (doc.op === "wall") { // course scale: giant work wants giant blocks (the face texture tile at 40 texels/m)
    const wp = wallParamsSchema.parse(operatorParams(doc)), need = WALL_SCALE[wp.scale].minFaceTile, t = tileOf("face");
    if (t && Math.max(t[0], t[1]) < need) console.warn(`WARNING course scale: a ${wp.scale} wall wants a face texture tile >= ${need} m (${Math.round(need * TEXELS_PER_M)} px at ${TEXELS_PER_M} texels/m); "${matOf("face")}" tiles ${t.map((v) => v.toFixed(2)).join("x")} m: its courses read finer than ${wp.scale} work`);
  }
  const buriedB = (g: BuiltGroup, v: number) => g.positions[v * 3 + 1]! + footY < ground(g.positions[v * 3]! + px, g.positions[v * 3 + 2]! + pz) - 1.5;
  const byMat = new Map<string, BuiltGroup[]>();
  // coincident end caps (mitred wall segments, butted blocks) are interior to the union: dropped from render AND collider (_built-twins.mts)
  const twins = dropTwinFaces(b.groups);
  if (twins.dropped) console.log(`twin faces: ${twins.dropped} back-to-back triangles dropped (coincident end caps)`);
  for (const g of twins.groups) { const t = subBuilt(g, (k) => !(buriedB(g, g.indices[k * 3]!) && buriedB(g, g.indices[k * 3 + 1]!) && buriedB(g, g.indices[k * 3 + 2]!))); if (t.triangleCount) { const m = matOf(g.role); byMat.set(m, [...(byMat.get(m) ?? []), t]); } }
  [...byMat.entries()].forEach(([m, gs], j) => builtGroups.push({ key: `.b${j + 1}`, material: m, mesh: mergeBuilt(gs) }));
  console.log(`built: ${b.triangles} tris in ${builtGroups.length} draw(s) [${builtGroups.map((g) => `${g.material} (${g.mesh.role}, tile ${(tileOf(g.mesh.role.split("+")[0]!) ?? ["triplanar"]).map((v) => (typeof v === "number" ? v.toFixed(2) : v)).join("x")} m) ${g.mesh.triangleCount}`).join(", ")}]${b.revealSkipped.length ? `; NO REVEAL (cut through a non-convex part): ${b.revealSkipped.join(", ")}` : ""}; DC natural parts: ${hasDc ? b.natural : 0}`);
}
const bakeSeconds = (performance.now() - t1) / 1000;
const tris = groups.reduce((a, g) => a + g.mesh.triangleCount, 0) + builtGroups.reduce((a, g) => a + g.mesh.triangleCount, 0), verts = groups.reduce((a, g) => a + g.mesh.vertexCount, 0) + builtGroups.reduce((a, g) => a + g.mesh.vertexCount, 0);
console.log(`bake: ${cells} cells -> ${raw.triangleCount} tris -> ${visible.triangleCount} (buried dropped) -> ${tris} tris, ${verts} verts (error ${error} m) in ${groups.length + builtGroups.length} draw(s) [${groups.map((g) => `${g.material} ${g.mesh.triangleCount}`).join(", ")}], ${bakeSeconds.toFixed(1)} s; open edges ${groups.map((g) => openEdges(g.mesh)).join("/")}`);

// ---- reach: declared targets + openings, on the baked collider (all groups)
const yawR = (params.yaw * Math.PI) / 180, cy = Math.cos(yawR), sy = Math.sin(yawR);
const toWorld = (l: number[]): [number, number, number] => { const x = l[0]! * params.scale, z = l[2]! * params.scale; return [px + x * cy + z * sy, footY + l[1]! * params.scale, pz - x * sy + z * cy]; };
// an OPENING must be cut: reached on its own spot with headroom there (collider-reach `exact`), never from the floor beside it
const targets = [...params.targets.map((t) => ({ name: t.name, w: toWorld(t.at), opening: false })), ...params.openings.map((o) => ({ name: `opening ${o.name}`, w: toWorld(o.at), opening: true }))];
const faults: string[] = [];
if (targets.length) {
  const dcAll = mergeMeshes(groups.map((g) => g.mesh), palette.length);
  const bAll = builtGroups.length ? mergeBuilt(builtGroups.map((g) => g.mesh)) : null;
  const own = bAll ? { positions: Float32Array.from([...dcAll.positions, ...bAll.positions]), indices: Uint32Array.from([...dcAll.indices, ...Array.from(bAll.indices, (v) => v + dcAll.vertexCount)]) } : dcAll;
  // the OTHER landmarks' baked colliders in the walk area too: a joint between two landmarks (a ramp head onto a
  // shelf) is walked as the body meets it, from this project and what it depends on (never a lab's copy of a bake)
  const reachR = Math.max(c.compiled.max[0], -c.compiled.min[0], c.compiled.max[2], -c.compiled.min[2]) * params.scale + 26;
  const manifest = join("projects", project, "project.json");
  const deps = existsSync(manifest) ? ((JSON.parse(readFileSync(manifest, "utf8")) as { dependsOn?: string[] }).dependsOn ?? []) : [];
  const nb = neighbourColliders(recipe.features.landmarks ?? [], piece.id, [px, pz], reachR, [...new Set([flag("into") ?? project, project, ...deps])]);
  if (nb.used.length || nb.missing.length) console.log(`reach: walking with neighbour landmark colliders [${nb.used.join(", ")}]${nb.missing.length ? `; NOT BAKED (skipped): [${nb.missing.join(", ")}]` : ""}`);
  const nv = own.positions.length / 3;
  const all = nb.indices.length
    ? { positions: Float32Array.from([...own.positions, ...nb.positions.map((v, i) => v - (i % 3 === 0 ? px : i % 3 === 1 ? footY : pz))]), indices: Uint32Array.from([...own.indices, ...nb.indices.map((v) => v + nv)]) }
    : own;
  const reach = colliderReach({ positions: all.positions, indices: all.indices, offset: [px, footY, pz] }, {
    center: [px, pz], radius: Math.max(c.compiled.max[0], -c.compiled.min[0], c.compiled.max[2], -c.compiled.min[2]) * params.scale, ground: (x, z) => field.height(x, z),
    anchors: targets.map((t) => [t.w[0], t.w[2], t.w[1]] as Vec3), caves: [], exact: targets.map((t) => t.opening),
  });
  // L (Wristgate 2026-10-28: three bakes to find why a target was unreached): a FAULT names what it can see — the ground
  // over the target (a collider surface under the terrain is never walked) and a solid in the 1.8 m above it (no headroom)
  const why = (w: [number, number, number]): string => {
    const out: string[] = [], g = field.height(w[0], w[2]);
    if (g > w[1] + 0.3) out.push(`buried: ground ${g.toFixed(2)} over the target (cut the ground there)`);
    const P = all.positions, I = all.indices, ox = w[0] - px, oy = w[1] - footY, oz = w[2] - pz;
    let hit = Infinity;
    for (let t = 0; t < I.length; t += 3) { // vertical ray up: barycentric test in XZ, height at the hit
      const a = I[t]! * 3, b = I[t + 1]! * 3, c = I[t + 2]! * 3;
      const x1 = P[a]!, z1 = P[a + 2]!, x2 = P[b]!, z2 = P[b + 2]!, x3 = P[c]!, z3 = P[c + 2]!;
      const d = (z2 - z3) * (x1 - x3) + (x3 - x2) * (z1 - z3); if (Math.abs(d) < 1e-9) continue;
      const l1 = ((z2 - z3) * (ox - x3) + (x3 - x2) * (oz - z3)) / d, l2 = ((z3 - z1) * (ox - x3) + (x1 - x3) * (oz - z3)) / d, l3 = 1 - l1 - l2;
      if (l1 < 0 || l2 < 0 || l3 < 0) continue;
      const y = l1 * P[a + 1]! + l2 * P[b + 1]! + l3 * P[c + 1]!;
      if (y > oy + 0.15 && y < hit) hit = y;
    }
    if (hit - oy < 1.8) out.push(`no headroom: a surface ${(hit - oy).toFixed(2)} m above the target`);
    return out.length ? ` — ${out.join("; ")}` : " — not buried, headroom clear: the way to it has a step > 0.4 m or a too-steep slope (--reach-map)";
  };
  targets.forEach((t, k) => { const ok = reach.withCaves[k]; console.log(`reach ${ok ? "ok   " : "FAULT"} ${t.name} at ${t.w.map((v) => v.toFixed(1)).join(",")}${ok ? "" : why(t.w)}`); if (!ok) faults.push(t.name); });
  if (faults.length) process.exitCode = 1;
  // --reach-map: print the reach level map round the targets (1 m; letter = level, UPPER = reached, * = target)
  if (argv.includes("--reach-map")) {
    const xs = targets.map((t) => t.w[0]), zs = targets.map((t) => t.w[2]);
    for (const row of reach.map(Math.min(...xs) - 12, Math.max(...xs) + 12, Math.min(...zs) - 12, Math.max(...zs) + 12)) console.log(`  ${row}`);
  }
} else console.log("reach: no targets/openings declared (the reach loop runs only for walkable targets)");

const report = { prefab: prefabId, digest: c.compiled.digest, nodes: c.compiled.nodes.length, tiles: c.compiled.tiles.length, cells, voxel: c.compiled.voxel, triangles: tris, vertices: verts, kind: params.kind, draws: groups.length + builtGroups.length, materials: [...groups.map((g) => g.material), ...builtGroups.map((g) => g.material)], bakeSeconds: Math.round(bakeSeconds * 10) / 10, footY, surfaces: { faces: stoneName, tops: names[cover] }, reachFaults: faults };
if (flag("report")) writeFileSync(flag("report")!, JSON.stringify(report, null, 2) + "\n");
if (flag("glb-only")) glbOnlyPage([...groups.map((g) => ({ name: g.material, mesh: g.mesh })), ...builtGroups.map((g) => ({ name: g.material, mesh: g.mesh as unknown as VoxelMesh }))], flag("glb-only")!, `landmark ${opId}`);
if (has("dry-run")) { console.log("(dry run: nothing written)"); process.exit(process.exitCode ?? 0); }

const into = join("projects", flag("into") ?? project, "assets");
const name = prefabId.slice("landmarks/".length);
const prefabFile = join(into, "prefabs", "landmarks", `${name}.json`);
if (existsSync(prefabFile) && !has("force")) { console.log(`${prefabFile} exists (same digest): nothing to do (--force rewrites)`); process.exit(process.exitCode ?? 0); }
mkdirSync(join(into, "models", "landmarks"), { recursive: true });
mkdirSync(join(into, "prefabs", "landmarks"), { recursive: true });
/**
 * A triplanar standard material of a world surface's own texture (natural rock: no UVs, world-space, no stretch), at
 * the surface's OWN uvScale (metres per repeat) so the rock matches the terrain drawing the same texture beside it
 * (QA-C: a hard-coded 4.5 m drew the 20 m Drownmere cliff 4.4x denser). --triplanar-scale <m> overrides.
 */
const materialId = (m: string): string => {
  if (!m.startsWith("auto:")) return m;
  const surf = recipe.surfaces.find((x) => x.name === m.slice(5)) as { name: string; map?: string; color?: string; roughness?: number; uvScale?: number } | undefined;
  const id = `landmarks/${m.slice(5)}`, file = join(into, "materials", `${id}.json`);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify({ shader: "standard", color: surf?.map ? "#ffffff" : surf?.color ?? "#8a7a6a", ...(surf?.map ? { map: surf.map } : {}), filter: "nearest", roughness: surf?.roughness ?? 0.95, metalness: 0, triplanar: true, triplanarScale: landmarkTriplanarScale(surf, flag("triplanar-scale")), repeat: [1, 1] }, null, 2) + "\n");
  return id;
};
for (const g of groups) g.material = materialId(g.material);
for (const g of builtGroups) g.material = materialId(g.material);
const entities: Record<string, unknown> = {};
let bytes = 0;
groups.forEach((g, k) => {
  const glb = join(into, "models", "landmarks", `${name}${g.key}.glb`);
  bytes += writeVolumeGlb(g.mesh, glb);
  entities[k === 0 ? "rock" : `part${k}`] = { // DC group (its collider is in the cell tiles below)
    name: k === 0 ? `${opId} landmark` : `${opId} ${g.material}`, parent: k === 0 ? null : "rock", tags: ["landmark", opId],
    components: {
      transform: {},
      mesh: { source: { kind: "asset", assetId: `landmarks/${name}${g.key}.glb` }, material: g.material, static: true, castShadow: true, receiveShadow: true },
    },
  };
});
builtGroups.forEach((g, j) => {
  const glb = join(into, "models", "landmarks", `${name}${g.key}.glb`);
  bytes += writeBuiltGlb(g.mesh, glb);
  const root = Object.keys(entities).length === 0;
  entities[root ? "rock" : `built${j + 1}`] = {
    name: root ? `${opId} landmark` : `${opId} ${g.material}`, parent: root ? null : "rock", tags: ["landmark", "built", opId],
    components: {
      transform: {},
      mesh: { source: { kind: "asset", assetId: `landmarks/${name}${g.key}.glb` }, material: g.material, static: true, castShadow: true, receiveShadow: true },
    },
  };
});
// collider: every surface (DC groups + built groups) WELDED by position (the render groups split vertices at every
// crease for flat normals/UVs; an unwelded trimesh snags a walking body on its internal edges) and split into one
// hidden trimesh per MAP CELL (tools/_landmark-colliders.mts): every cell the landmark covers streams its own piece,
// so a body far from the origin cell still stands on it (physics holds only the simulation ring around a body)
const colliderTiles = writeColliderTiles(into, prefabId, [...groups.map((g) => g.mesh), ...builtGroups.map((g) => g.mesh)], { position: piece.position, radius: piece.radius }, recipe.cellSize);
bytes += colliderTiles.bytes;
console.log(`collider: ${colliderTiles.triangles} tris in ${colliderTiles.cells.length} cell tile(s) [${colliderTiles.cells.join(" ")}]`);
writeFileSync(prefabFile, JSON.stringify({ version: 1, name: `${opId} landmark`, root: "rock", entities }, null, 2) + "\n");
console.log(`wrote ${groups.length + builtGroups.length} GLB(s) (${(bytes / 1024 / 1024).toFixed(1)} MB) and ${prefabFile}; total ${((performance.now() - t0) / 1000).toFixed(1)} s`);
// no iteration files: this op's older bakes go (never another op's, never the prefab the recipe names)
const pruned = pruneSupersededBakes(into, opId, [prefabId, piece.prefab]);
if (pruned.length) console.log(`removed ${pruned.length} superseded bake file(s) of ${opId}`);
void statSync;

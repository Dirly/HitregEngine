/**
 * BACKFACES — every face a player can see from BEHIND, from where the player actually stands.
 *
 *   npx tsx tools/backfaces.mts <project> [--scene <id>] [--route <walk.json>] [--eyes <points.json>] [--dirs 160] [--reach 60] [--out f.json] [--min 1] [--allow 0]
 *
 * A one-sided face seen from its back is either a wrong winding (an inverted normal: the face is culled and the player
 * looks through it) or a missing closing face. Eyes: the dungeon's walk route (reports/walk.json legs: from, end, and every
 * 2 m between, at 1.6 m eye height); from each eye `--dirs` rays on a sphere; the FIRST surface each ray hits is judged by
 * its winding (glTF front = counter-clockwise). Rays that first hit a face from behind are counted per prefab and per
 * local triangle (the piece's own frame), so a fix goes to the builder that wrote the face, once, not per instance.
 * Skips materials drawn double-sided on purpose (alpha cards, water, fx) by name, glTF doubleSided or a project material with side "double". Exit 1 when any piece has >= --min
 * back-seen triangles (or the total back-hit rays exceed --allow). Born 2026-11-01 (Derek on the Weeping Sun Tombs: "a lot of normals that need inverting").
 */
import fs from "node:fs";
import path from "node:path";
import { sceneGeometry } from "./_prop-geometry.mts";
import { PROJECTS } from "./_closure.mjs";

const argv = process.argv.slice(2);
const opt = (k: string): string | undefined => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : undefined; };
const project = argv.find((a) => !a.startsWith("--") && argv[argv.indexOf(a) - 1]?.startsWith("--") !== true);
if (!project) { console.error("usage: backfaces.mts <project> [--scene id] [--route walk.json] [--dirs 160] [--reach 60] [--out f] [--min 1]"); process.exit(2); }
const root = path.join(PROJECTS, project);
const sceneId = opt("scene") ?? project;
const sceneFile = path.join(root, "assets/scenes", `${sceneId}.scene.json`);
const doc = JSON.parse(fs.readFileSync(sceneFile, "utf8"));
const routeFile = opt("route") ?? path.join(root, "reports/walk.json");
const NDIR = Number(opt("dirs") ?? 160), REACH = Number(opt("reach") ?? 60), MIN = Number(opt("min") ?? 1);
const SKIP_MAT = /water|banner|fx|fire|smoke|mist|haze|shaft|ray-soft|daylight|glint|veil|throat|sky|decal/i;

// materials drawn double-sided (glTF doubleSided) are never culled: a face of one seen from behind still draws. Their names,
// from every model under the scene's projects (glTF JSON or a GLB's JSON chunk)
const twoSided = new Set<string>();
const walkModels = (dir: string): void => { if (!fs.existsSync(dir)) return; for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
  const q = path.join(dir, f.name); if (f.isDirectory()) { walkModels(q); continue; }
  try {
    let j: any = null;
    if (f.name.endsWith(".gltf")) j = JSON.parse(fs.readFileSync(q, "utf8"));
    else if (f.name.endsWith(".glb")) { const b = fs.readFileSync(q); const len = b.readUInt32LE(12); j = JSON.parse(b.subarray(20, 20 + len).toString("utf8")); }
    for (const m of j?.materials ?? []) if (m.doubleSided && m.name) twoSided.add(m.name);
  } catch { /* unreadable model: judged as one-sided */ }
} };
for (const proj of fs.readdirSync(PROJECTS)) walkModels(path.join(PROJECTS, proj, "assets/models"));
// project materials with side "double" (a prefab's mesh.material, e.g. a skinned statue's single-layer robes): the draw is
// named by the material id
const walkMaterials = (dir: string, base: string): void => { if (!fs.existsSync(dir)) return; for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
  const q = path.join(dir, f.name); if (f.isDirectory()) { walkMaterials(q, base); continue; }
  if (!f.name.endsWith(".json")) continue;
  try { if (JSON.parse(fs.readFileSync(q, "utf8"))?.side === "double") twoSided.add(path.relative(base, q).replace(/\\/g, "/").replace(/\.json$/, "")); } catch { /* unreadable: one-sided */ }
} };
for (const proj of fs.readdirSync(PROJECTS)) { const d = path.join(PROJECTS, proj, "assets/materials"); walkMaterials(d, d); }
const isTwoSided = (draw: string | undefined): boolean => !!draw && twoSided.has(draw.replace(/@[^@]*$/, ""));
// water bodies (surface y + plan bounds): a face under a water surface, seen from above it, is behind the water (dungeon pools
// are near-opaque) and not judged
const waters: Array<{ y: number; x0: number; z0: number; x1: number; z1: number }> = [];
for (const e of Object.values(doc.entities) as any[]) {
  if (!e?.components?.water || !e.components.transform) continue;
  const [ox, oy, oz] = e.components.transform.position; const src = e.components.mesh?.source;
  let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
  if (src?.positions) for (let i = 0; i < src.positions.length; i += 3) { x0 = Math.min(x0, src.positions[i] + ox); x1 = Math.max(x1, src.positions[i] + ox); z0 = Math.min(z0, src.positions[i + 2] + oz); z1 = Math.max(z1, src.positions[i + 2] + oz); }
  else if (src?.size) { x0 = ox - src.size[0] / 2; x1 = ox + src.size[0] / 2; z0 = oz - src.size[2] / 2; z1 = oz + src.size[2] / 2; }
  waters.push({ y: oy, x0, z0, x1, z1 });
}
const underWater = (eye: number[], at: number[]): boolean => waters.some((w) => eye[1]! > w.y && at[1]! < w.y - 0.02 && at[0]! >= w.x0 && at[0]! <= w.x1 && at[2]! >= w.z0 && at[2]! <= w.z1);
// ---- geometry: one soup, bucketed on a uniform grid ----
const geo = sceneGeometry(path.join(root, "assets"), doc, (id, e) => !!(e?.components?.water || e?.tags?.includes?.("water") || e?.tags?.includes?.("npc") || e?.tags?.includes?.("player") || /veil/i.test(id) || (!!e?.components?.collider && !e?.components?.prefab && !e?.components?.mesh)));
const T: number[] = []; const owner: number[] = []; const local: number[] = [];
for (let gi = 0; gi < geo.length; gi++) {
  const g = geo[gi]!;
  for (let t = 0; t < g.world.length / 9; t++) {
    if (SKIP_MAT.test(g.draws[t] ?? "") || isTwoSided(g.draws[t])) continue;
    for (let k = 0; k < 9; k++) T.push(g.world[t * 9 + k]!);
    owner.push(gi); local.push(t);
  }
}
const NT = owner.length, CELL = 2;
const grid = new Map<string, number[]>();
for (let t = 0; t < NT; t++) {
  const o = t * 9; const lo = [0, 1, 2].map((k) => Math.min(T[o + k]!, T[o + 3 + k]!, T[o + 6 + k]!)), hi = [0, 1, 2].map((k) => Math.max(T[o + k]!, T[o + 3 + k]!, T[o + 6 + k]!));
  for (let x = Math.floor(lo[0]! / CELL); x <= Math.floor(hi[0]! / CELL); x++) for (let y = Math.floor(lo[1]! / CELL); y <= Math.floor(hi[1]! / CELL); y++) for (let z = Math.floor(lo[2]! / CELL); z <= Math.floor(hi[2]! / CELL); z++) {
    const key = `${x},${y},${z}`; const b = grid.get(key); if (b) b.push(t); else grid.set(key, [t]);
  }
}
// Möller–Trumbore, two-sided: returns distance or -1
function hitTri(t: number, ox: number, oy: number, oz: number, dx: number, dy: number, dz: number): number {
  const o = t * 9;
  const e1x = T[o + 3]! - T[o]!, e1y = T[o + 4]! - T[o + 1]!, e1z = T[o + 5]! - T[o + 2]!, e2x = T[o + 6]! - T[o]!, e2y = T[o + 7]! - T[o + 1]!, e2z = T[o + 8]! - T[o + 2]!;
  const px = dy * e2z - dz * e2y, py = dz * e2x - dx * e2z, pz = dx * e2y - dy * e2x;
  const det = e1x * px + e1y * py + e1z * pz; if (Math.abs(det) < 1e-12) return -1;
  const inv = 1 / det, sx = ox - T[o]!, sy = oy - T[o + 1]!, sz = oz - T[o + 2]!;
  const u = (sx * px + sy * py + sz * pz) * inv; if (u < 0 || u > 1) return -1;
  const qx = sy * e1z - sz * e1y, qy = sz * e1x - sx * e1z, qz = sx * e1y - sy * e1x;
  const v = (dx * qx + dy * qy + dz * qz) * inv; if (v < 0 || u + v > 1) return -1;
  const d = (e2x * qx + e2y * qy + e2z * qz) * inv; return d > 1e-4 ? d : -1;
}
/** first triangle along the ray (3D DDA over the grid) */
function cast(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number): [number, number] | null {
  let x = Math.floor(ox / CELL), y = Math.floor(oy / CELL), z = Math.floor(oz / CELL);
  const sx = Math.sign(dx), sy = Math.sign(dy), sz = Math.sign(dz);
  const nb = (c: number, s: number) => (s > 0 ? (c + 1) * CELL : c * CELL);
  let tx = dx ? (nb(x, sx) - ox) / dx : Infinity, ty = dy ? (nb(y, sy) - oy) / dy : Infinity, tz = dz ? (nb(z, sz) - oz) / dz : Infinity;
  const ddx = dx ? CELL / Math.abs(dx) : Infinity, ddy = dy ? CELL / Math.abs(dy) : Infinity, ddz = dz ? CELL / Math.abs(dz) : Infinity;
  let best = Infinity, bt = -1, tcur = 0;
  const front = (t: number) => { const o = t * 9; const ax = T[o + 3]! - T[o]!, ay = T[o + 4]! - T[o + 1]!, az = T[o + 5]! - T[o + 2]!, bx = T[o + 6]! - T[o]!, by = T[o + 7]! - T[o + 1]!, bz = T[o + 8]! - T[o + 2]!; return (ay * bz - az * by) * dx + (az * bx - ax * bz) * dy + (ax * by - ay * bx) * dz <= 0; };
  while (tcur <= REACH) {
    // a double-sided surface (both windings at one place) is front from either side: on a tie the front face wins
    for (const t of grid.get(`${x},${y},${z}`) ?? []) { const d = hitTri(t, ox, oy, oz, dx, dy, dz); if (d > 0 && (d < best - 2e-3 || (d < best + 2e-3 && front(t) && !front(bt)))) { best = d; bt = t; } }
    const tn = Math.min(tx, ty, tz);
    if (bt >= 0 && best <= tn) return [bt, best];
    tcur = tn;
    if (tx === tn) { x += sx; tx += ddx; } else if (ty === tn) { y += sy; ty += ddy; } else { z += sz; tz += ddz; }
  }
  return bt >= 0 && best <= REACH ? [bt, best] : null;
}

// ---- eyes: the walk route, plus --eyes <file> (a JSON list of [x, y, z] eye points: a project's floor grid) ----
const walk = JSON.parse(fs.readFileSync(routeFile, "utf8"));
const eyes: number[][] = opt("eyes") ? JSON.parse(fs.readFileSync(opt("eyes")!, "utf8")) : [];
for (const l of walk.legDetail ?? []) {
  const a = l.from as number[], b = (l.end ?? l.to) as number[]; if (!a || !b || b.length < 3) continue;
  const n = Math.max(1, Math.ceil(Math.hypot(b[0]! - a[0]!, b[2]! - a[2]!) / 2));
  for (let k = 0; k <= n; k++) { const s = k / n; eyes.push([a[0]! + (b[0]! - a[0]!) * s, a[1]! + (b[1]! - a[1]!) * s + 0.7, a[2]! + (b[2]! - a[2]!) * s]); } // walk y = body centre (0.9 over the floor): +0.7 = eye
}
const dirs: number[][] = []; const ga = Math.PI * (3 - Math.sqrt(5));
for (let i = 0; i < NDIR; i++) { const y = 1 - (2 * (i + 0.5)) / NDIR, r = Math.sqrt(1 - y * y), th = ga * i; dirs.push([Math.cos(th) * r, y, Math.sin(th) * r]); }

// ---- judge ----
type Rec = { prefab: string; tris: Map<number, { n: number; at: number[]; local: number[][]; normal: number[]; eye?: number[] }>; entities: Set<string>; rays: number };
const by = new Map<string, Rec>(); let rays = 0, back = 0;
const inv = (m: number[]) => { // column-major affine inverse (rotation*scale + translation)
  const a = m; const det = a[0]! * (a[5]! * a[10]! - a[6]! * a[9]!) - a[4]! * (a[1]! * a[10]! - a[2]! * a[9]!) + a[8]! * (a[1]! * a[6]! - a[2]! * a[5]!);
  const r = [(a[5]! * a[10]! - a[6]! * a[9]!) / det, -(a[1]! * a[10]! - a[2]! * a[9]!) / det, (a[1]! * a[6]! - a[2]! * a[5]!) / det, -(a[4]! * a[10]! - a[6]! * a[8]!) / det, (a[0]! * a[10]! - a[2]! * a[8]!) / det, -(a[0]! * a[6]! - a[2]! * a[4]!) / det, (a[4]! * a[9]! - a[5]! * a[8]!) / det, -(a[0]! * a[9]! - a[1]! * a[8]!) / det, (a[0]! * a[5]! - a[1]! * a[4]!) / det];
  return (p: number[]) => { const q = [p[0]! - a[12]!, p[1]! - a[13]!, p[2]! - a[14]!]; return [r[0]! * q[0]! + r[3]! * q[1]! + r[6]! * q[2]!, r[1]! * q[0]! + r[4]! * q[1]! + r[7]! * q[2]!, r[2]! * q[0]! + r[5]! * q[1]! + r[8]! * q[2]!].map((v) => Math.round(v * 100) / 100); };
};
// an eye INSIDE a solid (a grid point in a plinth or a pier) sees that solid's every face from behind: an eye whose rays
// meet back faces more than a quarter of the time is inside something and is dropped
let dropped = 0;
for (const e of eyes) {
  const hits: Array<[number, number, number[]]> = []; let backs = 0, near = Infinity;
  for (const d of dirs) {
    const h = cast(e[0]!, e[1]!, e[2]!, d[0]!, d[1]!, d[2]!); if (!h) continue;
    near = Math.min(near, h[1]);
    const o = h[0] * 9;
    const nx = (T[o + 4]! - T[o + 1]!) * (T[o + 8]! - T[o + 2]!) - (T[o + 5]! - T[o + 2]!) * (T[o + 7]! - T[o + 1]!);
    const ny = (T[o + 5]! - T[o + 2]!) * (T[o + 6]! - T[o]!) - (T[o + 3]! - T[o]!) * (T[o + 8]! - T[o + 2]!);
    const nz = (T[o + 3]! - T[o]!) * (T[o + 7]! - T[o + 1]!) - (T[o + 4]! - T[o + 1]!) * (T[o + 6]! - T[o]!);
    if (nx * d[0]! + ny * d[1]! + nz * d[2]! > 0) { backs++; if (!underWater(e, [e[0]! + d[0]! * h[1], e[1]! + d[1]! * h[1], e[2]! + d[2]! * h[1]])) hits.push([h[0], h[1], d]); }
  }
  // ... and so is an eye pressed against a surface (< 0.3 m): a body cannot stand there, and half its rays start in the solid
  if (backs > dirs.length / 4 || near < 0.3) { dropped++; continue; }
  for (const [ht, hd, d] of hits) judge(e, d, [ht, hd]);
}
function judge(e: number[], d: number[], h: [number, number]) {
  rays++;
  const t = h[0], o = t * 9;
  const nx = (T[o + 4]! - T[o + 1]!) * (T[o + 8]! - T[o + 2]!) - (T[o + 5]! - T[o + 2]!) * (T[o + 7]! - T[o + 1]!);
  const ny = (T[o + 5]! - T[o + 2]!) * (T[o + 6]! - T[o]!) - (T[o + 3]! - T[o]!) * (T[o + 8]! - T[o + 2]!);
  const nz = (T[o + 3]! - T[o]!) * (T[o + 7]! - T[o + 1]!) - (T[o + 4]! - T[o + 1]!) * (T[o + 6]! - T[o]!);
  back++;
  const g = geo[owner[t]!]!; const key = g.prefabId ?? g.id;
  const rec = by.get(key) ?? { prefab: key, tris: new Map(), entities: new Set(), rays: 0 }; by.set(key, rec);
  rec.rays++; rec.entities.add(g.id);
  const lt = local[t]!; const cur = rec.tris.get(lt);
  if (cur) cur.n++; else { const f = inv(g.m); const nl = Math.hypot(nx, ny, nz); rec.tris.set(lt, { n: 1, at: [e[0]! + d[0]! * h[1], e[1]! + d[1]! * h[1], e[2]! + d[2]! * h[1]].map((v) => Math.round(v * 100) / 100), local: [f([T[o]!, T[o + 1]!, T[o + 2]!]), f([T[o + 3]!, T[o + 4]!, T[o + 5]!]), f([T[o + 6]!, T[o + 7]!, T[o + 8]!])], normal: [nx / nl, ny / nl, nz / nl].map((v) => Math.round(v * 100) / 100), eye: e.map((v) => Math.round(v * 100) / 100) }); } // eye: where the first back-seen ray came from (to find the gap it looked through)
}
console.log(`(${dropped} eye(s) inside a solid dropped)`);
const rows = [...by.values()].filter((r) => r.tris.size >= MIN).sort((a, b) => b.rays - a.rays);
const ALLOW = Number(opt("allow") ?? 0); // --allow <rays>: a documented residue (a 6 cm slit over a pool), never a whole face
const report = { tool: "backfaces", scene: path.relative(root, sceneFile), at: new Date().toISOString(), eyes: eyes.length, rays, backHits: back, allow: ALLOW, passed: rows.length === 0 || back <= ALLOW,
  pieces: rows.map((r) => ({ prefab: r.prefab, rays: r.rays, triangles: r.tris.size, instances: r.entities.size, worst: [...r.tris.entries()].sort((a, b) => b[1].n - a[1].n).slice(0, 6).map(([lt, v]) => ({ tri: lt, rays: v.n, at: v.at, normal: v.normal, local: v.local, eye: v.eye })) })) };
const out = opt("out") ?? path.join(root, "reports/backfaces.json");
fs.writeFileSync(out, JSON.stringify(report, null, 1) + "\n");
console.log(`backfaces ${project}: ${eyes.length} eyes x ${NDIR} rays, ${back} rays met a face from behind; ${rows.length} piece(s) -> ${path.relative(process.cwd(), out)}`);
for (const r of report.pieces.slice(0, 40)) console.log(`  ${String(r.rays).padStart(6)} rays  ${String(r.triangles).padStart(4)} tris  x${r.instances}  ${r.prefab}   e.g. local ${JSON.stringify(r.worst[0]?.local)} n ${JSON.stringify(r.worst[0]?.normal)}`);
process.exit(report.passed ? 0 : 1);

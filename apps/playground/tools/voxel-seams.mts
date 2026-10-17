/**
 * voxel-seams — chunk-seam and fidelity checker for the voxel meshers (mc / dc / nets). Read-only.
 *
 *   tsx tools/voxel-seams.mts <recipe.json> --at x,z[;x,z...] [--cells 3]
 *       [--meshers mc,dc,dc-own,nets,mc|dc] [--lods 1:1,1:4,4:8] [--res 48] [--gate deg] [--steps n] [--json out.json]
 *
 * For every shared face between the cells of an N x N block around each `--at` point, meshes the
 * two cells (A at the first LOD of a pair, B at the second; both orientations) and reports:
 *   gap      open border edges of A u B (skirts excluded) near the seam, and how far each is from
 *            the other cell's surface — max / p95 metres, and the crack length over 1 cm;
 *   holes    of those crack edges, how many a probe ray sees THROUGH after skirts are added
 *            (the visible crack count — what a player would see);
 *   zfight   triangles of A and B that coincide (coplanar, < 2 mm apart): double-emitted faces;
 *   normals  shading discontinuity across the seam: angle between A's and B's vertex normals at
 *            shared positions (or at B's closest point across an LOD step), max / p95 degrees.
 * Plus per mesher at LOD 1: fidelity (vertex distance to the true field surface, mean / p95 / max
 * metres), crease share (interior edges with a dihedral over 30 degrees — kept sharp features),
 * triangles per cell and ms per cell.
 *
 * Meshers: "auto" is the per-cell choice voxelWorld.mesher "auto" makes (DC where planar cliffs reach a cell,
 * MC elsewhere); its seams are also reported split into same-mesher and MC|DC borders ("mixed").
 * "dc" is the dual mesher as the engine ships it (clipped to the cell + skirts),
 * "dc-own" the original face-ownership seams (no skirts) for an A/B. `--res` overrides the
 * recipe resolution (48 on a 48 m cell = 1 m voxels) for the cost/fidelity curve.
 * Exit code 1 when an equal-LOD seam has a gap, a z-fight or a visible hole.
 */
import fs from "node:fs";
import { buildVoxelMesh, createWorldField, dualMeshExperiment, resolveCellMesher, worldRecipeSchema, type VoxelMesh } from "@hitreg/core";

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith("--") && a.endsWith(".json") && args[args.indexOf(a) - 1] !== "--json");
const opt = (name: string): string | undefined => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
if (!file || !opt("at")) {
  console.error("usage: voxel-seams <recipe.json> --at x,z[;x,z] [--cells 3] [--meshers mc,dc,dc-own,nets] [--lods 1:1,1:4] [--res 48] [--json out]");
  process.exit(2);
}
const raw = JSON.parse(fs.readFileSync(file, "utf8"));
if (opt("res")) raw.resolution = Number(opt("res"));
const recipe = worldRecipeSchema.parse(raw);
const field = createWorldField(recipe);
const C = recipe.cellSize;
const N = Number(opt("cells") ?? 3);
const meshers = (opt("meshers") ?? "mc,dc,dc-own,nets").split(",");
const lodPairs = (opt("lods") ?? "1:1,1:4").split(",").map((p) => p.split(":").map(Number) as [number, number]);
if (opt("gate")) dualMeshExperiment.hermiteGate = Math.cos((Number(opt("gate")) * Math.PI) / 180);
if (opt("steps")) dualMeshExperiment.hermiteSteps = Number(opt("steps"));
if (opt("skirt")) dualMeshExperiment.skirtMin = Number(opt("skirt"));
const centres = opt("at")!.split(";").map((p) => p.split(",").map(Number) as [number, number]);

type Tri = { a: number[]; b: number[]; c: number[]; n: number[]; na: number[]; nb: number[]; nc: number[]; skirt: boolean };
interface CellMesh { tris: Tri[]; mesh: VoxelMesh; ms: number }
const cache = new Map<string, CellMesh>();
function cellMesh(variant: string, cx: number, cz: number, lod: number): CellMesh {
  const key = `${variant}:${cx}:${cz}:${lod}`;
  const hit = cache.get(key);
  if (hit) return hit;
  dualMeshExperiment.seams = variant === "dc-own" ? "own" : "clip";
  const mesher = variant === "dc-own" ? "dc" : variant;
  const t0 = performance.now();
  const mesh = buildVoxelMesh(field, { kind: "voxel", world: "seams", cell: [cx, cz], lodStep: lod, mesher } as never);
  const ms = performance.now() - t0;
  dualMeshExperiment.seams = "clip";
  const P = mesh.positions, Nn = mesh.normals, I = mesh.indices, ox = cx * C, oz = cz * C;
  const v = (i: number): number[] => [P[i * 3]! + ox, P[i * 3 + 1]!, P[i * 3 + 2]! + oz];
  const nv = (i: number): number[] => [Nn[i * 3]!, Nn[i * 3 + 1]!, Nn[i * 3 + 2]!];
  const onPlane = (i: number, axis: 0 | 2, at: number): boolean => Math.abs(P[i * 3 + axis]! - at) < 1e-4;
  const tris: Tri[] = [];
  for (let t = 0; t < mesh.triangleCount; t++) {
    const i0 = I[t * 3]!, i1 = I[t * 3 + 1]!, i2 = I[t * 3 + 2]!;
    const a = v(i0), b = v(i1), c = v(i2);
    const n = cross(sub(b, a), sub(c, a)), l = Math.hypot(n[0]!, n[1]!, n[2]!) || 1;
    // skirt: all three corners on one of the cell's side planes (a surface triangle lying exactly in one is vanishingly rare)
    let skirt = false;
    for (const [axis, at] of [[0, 0], [0, C], [2, 0], [2, C]] as const) if (onPlane(i0, axis, at) && onPlane(i1, axis, at) && onPlane(i2, axis, at)) skirt = true;
    tris.push({ a, b, c, n: [n[0]! / l, n[1]! / l, n[2]! / l], na: nv(i0), nb: nv(i1), nc: nv(i2), skirt });
  }
  const out = { tris, mesh, ms };
  cache.set(key, out);
  return out;
}

// ---------------------------------------------------------------- geometry
function sub(a: number[], b: number[]): number[] { return [a[0]! - b[0]!, a[1]! - b[1]!, a[2]! - b[2]!]; }
function cross(a: number[], b: number[]): number[] { return [a[1]! * b[2]! - a[2]! * b[1]!, a[2]! * b[0]! - a[0]! * b[2]!, a[0]! * b[1]! - a[1]! * b[0]!]; }
function dot(a: number[], b: number[]): number { return a[0]! * b[0]! + a[1]! * b[1]! + a[2]! * b[2]!; }
/** Closest point on triangle (Ericson) -> [distance, barycentric u, v, w]. */
function closest(p: number[], t: Tri): [number, number, number, number] {
  const { a, b, c } = t;
  const ab = sub(b, a), ac = sub(c, a), ap = sub(p, a);
  const d1 = dot(ab, ap), d2 = dot(ac, ap);
  const res = (u: number, v: number, w: number): [number, number, number, number] => {
    const q = [a[0]! * u + b[0]! * v + c[0]! * w, a[1]! * u + b[1]! * v + c[1]! * w, a[2]! * u + b[2]! * v + c[2]! * w];
    return [Math.hypot(p[0]! - q[0]!, p[1]! - q[1]!, p[2]! - q[2]!), u, v, w];
  };
  if (d1 <= 0 && d2 <= 0) return res(1, 0, 0);
  const bp = sub(p, b), d3 = dot(ab, bp), d4 = dot(ac, bp);
  if (d3 >= 0 && d4 <= d3) return res(0, 1, 0);
  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) { const v = d1 / (d1 - d3); return res(1 - v, v, 0); }
  const cp = sub(p, c), d5 = dot(ab, cp), d6 = dot(ac, cp);
  if (d6 >= 0 && d5 <= d6) return res(0, 0, 1);
  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) { const w = d2 / (d2 - d6); return res(1 - w, 0, w); }
  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) { const w = (d4 - d3) / (d4 - d3 + (d5 - d6)); return res(0, 1 - w, w); }
  const den = 1 / (va + vb + vc), v = vb * den, w = vc * den;
  return res(1 - v - w, v, w);
}
/** Möller–Trumbore, both faces: hit distance or -1. */
function ray(o: number[], d: number[], t: Tri, maxT: number): number {
  const e1 = sub(t.b, t.a), e2 = sub(t.c, t.a), p = cross(d, e2), det = dot(e1, p);
  if (Math.abs(det) < 1e-12) return -1;
  const inv = 1 / det, s = sub(o, t.a), u = dot(s, p) * inv;
  if (u < -1e-7 || u > 1 + 1e-7) return -1;
  const q = cross(s, e1), v = dot(d, q) * inv;
  if (v < -1e-7 || u + v > 1 + 1e-7) return -1;
  const tt = dot(e2, q) * inv;
  return tt >= 0 && tt <= maxT ? tt : -1;
}
/** Uniform-grid bucket of triangles by AABB, for neighbourhood queries. */
class TriGrid {
  private cells = new Map<string, Tri[]>();
  constructor(readonly tris: Tri[], readonly size = 2) {
    for (const t of tris) {
      const lo = [0, 1, 2].map((k) => Math.floor(Math.min(t.a[k]!, t.b[k]!, t.c[k]!) / size)), hi = [0, 1, 2].map((k) => Math.floor(Math.max(t.a[k]!, t.b[k]!, t.c[k]!) / size));
      for (let x = lo[0]!; x <= hi[0]!; x++) for (let y = lo[1]!; y <= hi[1]!; y++) for (let z = lo[2]!; z <= hi[2]!; z++) {
        const k = `${x},${y},${z}`;
        let l = this.cells.get(k);
        if (!l) this.cells.set(k, (l = []));
        l.push(t);
      }
    }
  }
  near(p: number[], r: number): Set<Tri> {
    const out = new Set<Tri>(), s = this.size;
    for (let x = Math.floor((p[0]! - r) / s); x <= Math.floor((p[0]! + r) / s); x++)
      for (let y = Math.floor((p[1]! - r) / s); y <= Math.floor((p[1]! + r) / s); y++)
        for (let z = Math.floor((p[2]! - r) / s); z <= Math.floor((p[2]! + r) / s); z++) for (const t of this.cells.get(`${x},${y},${z}`) ?? []) out.add(t);
    return out;
  }
}
const pct = (a: number[], q: number): number => { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(q * s.length))]!; };
const r3 = (x: number): number => +x.toFixed(3);

// ---------------------------------------------------------------- one seam
interface SeamResult { openEdges: number; crackEdges: number; crackLength: number; maxGap: number; p95Gap: number; holes: number; holes1m: number; holes3m: number; zfight: number; normalMax: number; normalP95: number }
function seam(variant: string, a: [number, number], b: [number, number], la: number, lb: number): SeamResult {
  // "mc|dc": A meshed by the first, B by the second — the seam between a MC chunk and a DC chunk
  const [va, vb] = variant.includes("|") ? variant.split("|") as [string, string] : [variant, variant];
  const A = cellMesh(va, a[0], a[1], la), B = cellMesh(vb, b[0], b[1], lb);
  const axis = a[0] !== b[0] ? 0 : 2, other = axis === 0 ? 2 : 0;
  const plane = Math.max(a[axis === 0 ? 0 : 1], b[axis === 0 ? 0 : 1]) * C;
  const lo = (axis === 0 ? a[1] : a[0]) * C, hi = lo + C;
  const stepMax = (C / recipe.resolution) * Math.max(la, lb);
  const w = stepMax * 4;
  const near = (t: Tri): boolean => [t.a, t.b, t.c].some((p) => Math.abs(p[axis]! - plane) < w && p[other]! > lo - w && p[other]! < hi + w);
  const As = A.tris.filter((t) => !t.skirt && near(t)), Bs = B.tris.filter((t) => !t.skirt && near(t));
  const Ask = A.tris.filter((t) => t.skirt && near(t)), Bsk = B.tris.filter((t) => t.skirt && near(t));
  const gA = new TriGrid(As), gB = new TriGrid(Bs), gAll = new TriGrid([...As, ...Bs, ...Ask, ...Bsk]);
  // weld A u B by exact position and find open edges
  const key = (p: number[]): string => `${p[0]},${p[1]},${p[2]}`;
  const edges = new Map<string, { n: number; p: number[]; q: number[]; t: Tri; from: "A" | "B" }>();
  for (const [list, from] of [[As, "A"], [Bs, "B"]] as const) for (const t of list) for (const [p, q] of [[t.a, t.b], [t.b, t.c], [t.c, t.a]]) {
    const kp = key(p!), kq = key(q!), k = kp < kq ? `${kp}|${kq}` : `${kq}|${kp}`;
    const e = edges.get(k);
    if (e) e.n++;
    else edges.set(k, { n: 1, p: p!, q: q!, t, from });
  }
  const gaps: number[] = [];
  let openEdges = 0, crackEdges = 0, crackLength = 0, holes = 0, holes1m = 0, holes3m = 0;
  for (const e of edges.values()) {
    if (e.n !== 1) continue;
    if (Math.abs(e.p[axis]! - plane) > stepMax + 0.01 || Math.abs(e.q[axis]! - plane) > stepMax + 0.01) continue;
    const m = [(e.p[0]! + e.q[0]!) / 2, (e.p[1]! + e.q[1]!) / 2, (e.p[2]! + e.q[2]!) / 2];
    if (m[other]! < lo + stepMax || m[other]! > hi - stepMax) continue; // the seam's two ends meet other seams
    openEdges++;
    const otherGrid = e.from === "A" ? gB : gA;
    let gap = Infinity, qb: number[] | null = null;
    for (const t of otherGrid.near(m, stepMax * 2)) {
      const r = closest(m, t);
      if (r[0] < gap) { gap = r[0]; qb = [0, 1, 2].map((k) => t.a[k]! * r[1] + t.b[k]! * r[2] + t.c[k]! * r[3]); }
    }
    if (!Number.isFinite(gap)) gap = stepMax * 2;
    gaps.push(gap);
    if (gap <= 0.01) continue;
    crackEdges++;
    const len = Math.hypot(e.q[0]! - e.p[0]!, e.q[1]! - e.p[1]!, e.q[2]! - e.p[2]!);
    crackLength += len;
    // The missing patch spans the border edge and the gap to the other cell's surface. Probe its middle,
    // along its own normal (edge x gap; for a clipped seam that is the seam plane's axis): a skirt or
    // either surface must be there, or the player sees through.
    const t = e.t;
    const along = sub(e.q, e.p), al = Math.hypot(along[0]!, along[1]!, along[2]!) || 1, u = along.map((x) => x / al);
    const g = qb ? sub(qb, m) : [0, 0, 0];
    let pn = cross(u, g), pnl = Math.hypot(pn[0]!, pn[1]!, pn[2]!);
    if (pnl < 1e-6) { pn = axis === 0 ? [1, 0, 0] : [0, 0, 1]; pnl = 1; }
    pn = pn.map((x) => x / pnl);
    const p = [m[0]! + g[0]! * 0.5, m[1]! + g[1]! * 0.5, m[2]! + g[2]! * 0.5];
    const o = [p[0]! - pn[0]! * 1, p[1]! - pn[1]! * 1, p[2]! - pn[2]! * 1];
    let hit = false;
    for (const tri of gAll.near(p, 2)) if (ray(o, pn, tri, 2) >= 0) { hit = true; break; }
    if (!hit) { holes++; if (gap > 1) holes1m++; if (gap > 3) holes3m++; if (process.env.SEAMS_DEBUG && holes <= 3) console.log("hole", variant, la, lb, m.map((x) => +x.toFixed(2)).join(","), "n", t.n.map((x) => +x.toFixed(2)).join(","), "gap", gap.toFixed(2)); }
  }
  // z-fight: a triangle of A whose centroid lies on a parallel triangle of B
  let zfight = 0;
  for (const t of As) {
    const c = [(t.a[0]! + t.b[0]! + t.c[0]!) / 3, (t.a[1]! + t.b[1]! + t.c[1]!) / 3, (t.a[2]! + t.b[2]! + t.c[2]!) / 3];
    // inside B's triangle, not merely next to it: two pieces of one clipped triangle are coplanar neighbours, not a z-fight
    for (const u of gB.near(c, 0.05)) { if (Math.abs(dot(t.n, u.n)) <= 0.999) continue; const r = closest(c, u); if (r[0] < 0.002 && Math.min(r[1], r[2], r[3]) > 0.02) { zfight++; break; } }
  }
  // shading: vertex normal of A at its seam-side vertices vs B's interpolated normal at its closest point
  const angles: number[] = [];
  const corner = (t: Tri, p: number[]): number[] => (p === t.a ? t.na : p === t.b ? t.nb : t.nc);
  const ang = (u: number[], v: number[]): number => (Math.acos(Math.max(-1, Math.min(1, dot(u, v)))) * 180) / Math.PI;
  if (la === lb) {
    // equal LOD: every edge the two cells SHARE (one triangle each side) — the shading seam is the
    // difference between the two triangles' corner normals at that edge's ends
    const ea = new Map<string, [Tri, number[], number[]]>();
    const ek = (p: number[], q: number[]): string => { const kp = key(p), kq = key(q); return kp < kq ? kp + "|" + kq : kq + "|" + kp; };
    for (const t of As) for (const [p, q] of [[t.a, t.b], [t.b, t.c], [t.c, t.a]]) ea.set(ek(p!, q!), [t, p!, q!]);
    for (const u of Bs) for (const [p, q] of [[u.a, u.b], [u.b, u.c], [u.c, u.a]]) {
      const hitA = ea.get(ek(p!, q!));
      if (!hitA) continue;
      const [t, pa, qa] = hitA;
      for (const [x, y] of [[pa, p!], [qa, q!]]) {
        const yb = key(x) === key(p!) ? p! : q!;
        angles.push(ang(corner(t, x), corner(u, yb)));
      }
    }
  }
  if (la !== lb) for (const t of As) for (const [p, np] of [[t.a, t.na], [t.b, t.nb], [t.c, t.nc]] as const) {
    if (Math.abs(p[axis]! - plane) > stepMax + 0.01) continue;
    // closest point on B; among ties (a shared vertex touches several triangles) the facet that matches A's,
    // so a crease-split vertex is compared with its own side of the crease
    let best: [number, number, number, number] | null = null, bt: Tri | null = null;
    for (const u of gB.near(p, 0.5)) {
      const r = closest(p, u);
      if (!best || r[0] < best[0] - 1e-5 || (r[0] < best[0] + 1e-5 && dot(u.n, t.n) > dot(bt!.n, t.n))) { best = r; bt = u; }
    }
    // equal LOD: only positions B really shares; across a step, B's surface near the border
    if (!best || !bt || best[0] > (la === lb ? 1e-4 : Math.max(0.05, stepMax * 0.5))) continue;
    const nb = [0, 1, 2].map((k) => bt!.na[k]! * best![1] + bt!.nb[k]! * best![2] + bt!.nc[k]! * best![3]);
    const l = Math.hypot(nb[0]!, nb[1]!, nb[2]!) || 1;
    angles.push((Math.acos(Math.max(-1, Math.min(1, dot(np, nb.map((x) => x / l))))) * 180) / Math.PI);
  }
  return { openEdges, crackEdges, crackLength: r3(crackLength), maxGap: r3(gaps.length ? Math.max(...gaps) : 0), p95Gap: r3(pct(gaps, 0.95)), holes, holes1m, holes3m, zfight, normalMax: +(angles.length ? Math.max(...angles) : 0).toFixed(1), normalP95: +pct(angles, 0.95).toFixed(1) };
}

// ---------------------------------------------------------------- fidelity
function fidelity(variant: string, cells: [number, number][]): Record<string, number> {
  const dists: number[] = [], back: number[] = [];
  let interior = 0, creased = 0, tris = 0, ms = 0;
  for (const [cx, cz] of cells) {
    const m = cellMesh(variant, cx, cz, 1);
    tris += m.mesh.triangleCount;
    ms += m.ms;
    const surf = m.tris.filter((t) => !t.skirt);
    // vertex -> surface distance, first order: |rho| / |grad rho|
    for (let i = 0; i < surf.length; i += 7) {
      const p = surf[i]!.a, e = 0.05;
      const r = field.density(p[0]!, p[1]!, p[2]!);
      const g = [field.density(p[0]! + e, p[1]!, p[2]!) - field.density(p[0]! - e, p[1]!, p[2]!), field.density(p[0]!, p[1]! + e, p[2]!) - field.density(p[0]!, p[1]! - e, p[2]!), field.density(p[0]!, p[1]!, p[2]! + e) - field.density(p[0]!, p[1]!, p[2]! - e)].map((x) => x / (2 * e));
      const gl = Math.hypot(g[0]!, g[1]!, g[2]!);
      if (gl > 1e-6) dists.push(Math.abs(r) / gl);
    }
    // surface -> mesh: points ON the true surface (rays marched through the field), distance to
    // the mesh. Mesh -> surface (above) cannot see a rounded corner; this is the one that does.
    const grid = new TriGrid(surf);
    const ox = cx * C, oz = cz * C, margin = 3;
    let seedR = (cx * 73856093) ^ (cz * 19349663);
    const rnd = (): number => ((seedR = (Math.imul(seedR, 1103515245) + 12345) | 0) >>> 0) / 4294967296;
    const hit = (o: number[], d: number[], len: number): number[] | null => {
      const stepR = 0.2;
      if (field.density(o[0]!, o[1]!, o[2]!) < 0) return null;
      for (let t = stepR; t <= len; t += stepR) {
        if (field.density(o[0]! + d[0]! * t, o[1]! + d[1]! * t, o[2]! + d[2]! * t) < 0) {
          let a = t - stepR, b = t;
          for (let k = 0; k < 12; k++) { const mid = (a + b) / 2; if (field.density(o[0]! + d[0]! * mid, o[1]! + d[1]! * mid, o[2]! + d[2]! * mid) < 0) b = mid; else a = mid; }
          const tt = (a + b) / 2;
          return [o[0]! + d[0]! * tt, o[1]! + d[1]! * tt, o[2]! + d[2]! * tt];
        }
      }
      return null;
    };
    let yLo = Infinity, yHi = -Infinity;
    for (const t of surf) for (const q of [t.a, t.b, t.c]) { if (q[1]! < yLo) yLo = q[1]!; if (q[1]! > yHi) yHi = q[1]!; }
    for (let r = 0; r < 48; r++) {
      const x = ox + margin + rnd() * (C - 2 * margin), z = oz + margin + rnd() * (C - 2 * margin);
      // alternate: straight down from above, and level rays from outside the point (cliff faces)
      let pt: number[] | null;
      if (r % 2 === 0) pt = hit([x, yHi + 2, z], [0, -1, 0], yHi - yLo + 4);
      else {
        const a = rnd() * Math.PI * 2, y = yLo + rnd() * (yHi - yLo), d = [Math.cos(a), 0, Math.sin(a)];
        pt = hit([x - d[0]! * 20, y, z - d[2]! * 20], d, 40);
      }
      if (!pt || pt[0]! < ox + 1 || pt[0]! > ox + C - 1 || pt[2]! < oz + 1 || pt[2]! > oz + C - 1) continue;
      let dm = Infinity;
      for (const t of grid.near(pt, 3)) dm = Math.min(dm, closest(pt, t)[0]);
      if (Number.isFinite(dm)) back.push(dm);
    }
    // dihedral share over interior edges (positions welded exactly)
    const key = (p: number[]): string => `${p[0]},${p[1]},${p[2]}`;
    const e2t = new Map<string, number[][]>();
    for (const t of surf) for (const [p, q] of [[t.a, t.b], [t.b, t.c], [t.c, t.a]]) {
      const kp = key(p!), kq = key(q!), k = kp < kq ? `${kp}|${kq}` : `${kq}|${kp}`;
      const l = e2t.get(k) ?? [];
      l.push(t.n);
      e2t.set(k, l);
    }
    for (const l of e2t.values()) if (l.length === 2) { interior++; if (dot(l[0]!, l[1]!) < Math.cos((30 * Math.PI) / 180)) creased++; }
  }
  const mean = dists.reduce((s, x) => s + x, 0) / (dists.length || 1);
  return { trisPerCell: Math.round(tris / cells.length), msPerCell: +(ms / cells.length).toFixed(1), fidelityMean: r3(mean), fidelityP95: r3(pct(dists, 0.95)), fidelityMax: r3(dists.length ? Math.max(...dists) : 0), surfToMeshMean: r3(back.reduce((s2, x) => s2 + x, 0) / (back.length || 1)), surfToMeshP95: r3(pct(back, 0.95)), surfToMeshMax: r3(back.length ? Math.max(...back) : 0), creasePct: +((100 * creased) / (interior || 1)).toFixed(2) };
}

// ---------------------------------------------------------------- run
const report: Record<string, unknown> = { recipe: file, resolution: recipe.resolution, voxel: C / recipe.resolution, centres: {} };
let failed = false;
for (const [x, z] of centres) {
  const c0x = Math.floor(x / C) - Math.floor(N / 2), c0z = Math.floor(z / C) - Math.floor(N / 2);
  const cells: [number, number][] = [];
  for (let dz = 0; dz < N; dz++) for (let dx = 0; dx < N; dx++) cells.push([c0x + dx, c0z + dz]);
  const pairs: [[number, number], [number, number]][] = [];
  for (const [cx, cz] of cells) {
    if (cx + 1 < c0x + N) pairs.push([[cx, cz], [cx + 1, cz]]);
    if (cz + 1 < c0z + N) pairs.push([[cx, cz], [cx, cz + 1]]);
  }
  const out: Record<string, unknown> = {};
  for (const variant of meshers) {
    const per: Record<string, unknown> = variant.includes("|") ? {} : { lod1: fidelity(variant, cells) };
    if (variant === "auto") per.dcCells = cells.filter(([cx, cz]) => resolveCellMesher(field, cx, cz, "auto") === "dc").length + "/" + cells.length;
    for (const [la, lb] of lodPairs) {
      const rs: SeamResult[] = [], mixed: SeamResult[] = [];
      const isMixed = (a: [number, number], b: [number, number]): boolean => variant === "auto" && resolveCellMesher(field, a[0], a[1], "auto") !== resolveCellMesher(field, b[0], b[1], "auto");
      for (const [a, b] of pairs) {
        const r1 = seam(variant, a, b, la, lb); rs.push(r1); if (isMixed(a, b)) mixed.push(r1);
        if (la !== lb) { const r2 = seam(variant, b, a, la, lb); rs.push(r2); if (isMixed(a, b)) mixed.push(r2); }
      }
      if (variant === "auto") per[`${la}:${lb}:mixed`] = { seams: mixed.length, maxGap: r3(Math.max(0, ...mixed.map((r) => r.maxGap))), p95Gap: r3(pct(mixed.map((r) => r.p95Gap), 0.95)), visibleHoles: mixed.reduce((s, r) => s + r.holes, 0), zfight: mixed.reduce((s, r) => s + r.zfight, 0) };
      const agg = {
        seams: rs.length,
        openEdges: rs.reduce((s, r) => s + r.openEdges, 0),
        crackEdges: rs.reduce((s, r) => s + r.crackEdges, 0),
        crackLength: r3(rs.reduce((s, r) => s + r.crackLength, 0)),
        maxGap: r3(Math.max(...rs.map((r) => r.maxGap))),
        p95Gap: r3(pct(rs.map((r) => r.p95Gap), 0.95)),
        visibleHoles: rs.reduce((s, r) => s + r.holes, 0),
        // the same holes by the size of the gap they look through: a sliver under 1 m at an HLOD join (144 m+ away) is a pixel
        holesOver1m: rs.reduce((s, r) => s + r.holes1m, 0),
        holesOver3m: rs.reduce((s, r) => s + r.holes3m, 0),
        zfight: rs.reduce((s, r) => s + r.zfight, 0),
        normalMaxDeg: Math.max(...rs.map((r) => r.normalMax)),
        normalP95Deg: +pct(rs.map((r) => r.normalP95), 0.95).toFixed(1),
      };
      // an MC|DC border never welds exactly (the two meshers put vertices in different places): auto fails on what a
      // player sees — a hole or a z-fight — not on the sub-skirt gap
      if (la === lb && ((variant !== "auto" && agg.maxGap > 0.01) || agg.zfight > 0 || agg.visibleHoles > 0)) failed = true;
      per[`${la}:${lb}`] = agg;
    }
    out[variant] = per;
    console.log(`[${x},${z}] ${variant}`, JSON.stringify(per));
  }
  (report.centres as Record<string, unknown>)[`${x},${z}`] = out;
  cache.clear();
}
if (opt("json")) fs.writeFileSync(opt("json")!, JSON.stringify(report, null, 1));
process.exit(failed ? 1 : 0);

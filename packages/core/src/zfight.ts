/**
 * Z-FIGHT and DECAL PLACEMENT — pure geometry checks over plain triangle soups (no DOM, no three).
 *
 * `findZFights`: two separately drawn surfaces on the same plane flicker at close range (the DC shell under a kit
 * floor, a built pad on terrain, two kit pieces overlapping, a prop sunk flush into a floor). A depth buffer cannot
 * order them, so the only fix is that ONE mesh owns each plane. The check finds pairs of triangles from different
 * draws (different mesh, or the same mesh's different materials/primitives) that face the same way (normal dot >
 * cos maxAngleDeg), lie within `maxGap` of each other and overlap in-plane, then joins neighbouring overlaps of the
 * same draw pair into clusters a builder can go to (centre, normal, area, the two draws).
 *
 * `decalCoverage`: where a projected decal actually lands. The projector box mirrors packages/render/src/decals.ts
 * (`decalFrame`), a grid of rays runs from the box's front plane along the projection; each sample is ON the
 * surface the renderer paints (the facing surface nearest the entity's plane), BLOCKED by geometry in front of it
 * (beam, pier, prop), or EMPTY (nothing facing inside the box: the decal hangs in air or past an edge).
 */
import { quatMultiply, vecApplyQuat, type Quat, type Vec3 } from "./math.js";

// ------------------------------------------------------------------ z-fight

export interface ZFightMesh {
  /** What the builder recognises: an entity id, `entity/prefab-part`, a chunk key. */
  id: string;
  /** World-space triangles, nine numbers each. */
  positions: ArrayLike<number>;
  /** Per-triangle index into `materials` (all 0 when absent). Different materials of one mesh are separate draws. */
  triMaterial?: ArrayLike<number>;
  materials?: string[];
}

export interface ZFightOptions {
  /** Same-facing when the normals are within this many degrees (default 3). */
  maxAngleDeg?: number;
  /** Plane distance in metres under which two surfaces fight (default 0.02). */
  maxGap?: number;
  /** A cluster is reported when its overlap area reaches this many m² (default 0.01). */
  minArea?: number;
  /** One triangle pair counts from this overlap area in m² (default 1e-4: kills float slivers along shared edges). */
  minPairArea?: number;
  /** An overlap thinner than this (area / perimeter, m) is a seam sliver, not a fight (default 0.002). */
  minThickness?: number;
  /** Spatial hash scale in metres: the finest level is a quarter of it, each next level 4x (default 1). */
  cell?: number;
  /** Overlaps of one draw pair within this distance join one cluster (default 1). */
  clusterRadius?: number;
}

export interface ZFightDraw { mesh: string; material: string }
export interface ZFightCluster {
  a: ZFightDraw;
  b: ZFightDraw;
  /** Area-weighted centre of the overlap, world space. */
  centre: Vec3;
  /** Area-weighted normal (the surfaces both face this way). */
  normal: Vec3;
  /** Overlap area in m². */
  area: number;
  /** Largest plane distance among its overlaps (m). */
  gap: number;
  /** Triangle pairs in it. */
  pairs: number;
  min: Vec3;
  max: Vec3;
}
export interface ZFightPairSummary { a: string; b: string; area: number; clusters: number; materials: string[] }
export interface ZFightReport {
  triangles: number;
  /** Triangle pairs geometrically tested (same-facing, near, different draws). */
  tested: number;
  /** Triangle pairs that overlap. */
  overlaps: number;
  /** Clusters at or over `minArea`, largest first. */
  clusters: ZFightCluster[];
  /** The clusters grouped by mesh pair, largest total area first. */
  byMeshPair: ZFightPairSummary[];
  ms: number;
}

/** Two unit tangents of a unit normal. */
function tangents(nx: number, ny: number, nz: number): [Vec3, Vec3] {
  const h: Vec3 = Math.abs(nx) < 0.9 ? [1, 0, 0] : [0, 1, 0];
  let t1: Vec3 = [ny * h[2] - nz * h[1], nz * h[0] - nx * h[2], nx * h[1] - ny * h[0]];
  const l = Math.hypot(t1[0], t1[1], t1[2]);
  t1 = [t1[0] / l, t1[1] / l, t1[2] / l];
  const t2: Vec3 = [ny * t1[2] - nz * t1[1], nz * t1[0] - nx * t1[2], nx * t1[1] - ny * t1[0]];
  return [t1, t2];
}

/** Clip a convex polygon (flat u,v pairs) to the left side of edge p->q. */
function clipEdge(poly: number[], px: number, py: number, qx: number, qy: number): number[] {
  const out: number[] = [];
  const n = poly.length / 2;
  const side = (x: number, y: number) => (qx - px) * (y - py) - (qy - py) * (x - px);
  for (let i = 0; i < n; i++) {
    const ax = poly[i * 2]!, ay = poly[i * 2 + 1]!;
    const j = (i + 1) % n;
    const bx = poly[j * 2]!, by = poly[j * 2 + 1]!;
    const sa = side(ax, ay), sb = side(bx, by);
    if (sa >= 0) out.push(ax, ay);
    if ((sa >= 0) !== (sb >= 0)) {
      const t = sa / (sa - sb);
      out.push(ax + (bx - ax) * t, ay + (by - ay) * t);
    }
  }
  return out;
}

export function findZFights(meshes: ZFightMesh[], options: ZFightOptions = {}): ZFightReport {
  const t0 = Date.now();
  const cosTol = Math.cos(((options.maxAngleDeg ?? 3) * Math.PI) / 180);
  const maxGap = options.maxGap ?? 0.02;
  const minArea = options.minArea ?? 0.01;
  const minPairArea = options.minPairArea ?? 1e-4;
  const minThick = options.minThickness ?? 0.002;
  const cell = options.cell ?? 1;
  const radius = options.clusterRadius ?? 1;

  // flatten: positions, normals, plane offsets, draw groups
  let N = 0;
  for (const m of meshes) N += Math.floor(m.positions.length / 9);
  const P = new Float64Array(N * 9);
  const NX = new Float64Array(N), NY = new Float64Array(N), NZ = new Float64Array(N), D = new Float64Array(N);
  const G = new Int32Array(N);
  const draws: ZFightDraw[] = [];
  const drawIndex = new Map<string, number>();
  let t = 0;
  meshes.forEach((m, mi) => {
    const n = Math.floor(m.positions.length / 9);
    for (let k = 0; k < n; k++, t++) {
      for (let c = 0; c < 9; c++) P[t * 9 + c] = m.positions[k * 9 + c]!;
      const matIdx = m.triMaterial ? m.triMaterial[k]! : 0;
      const key = `${mi}|${matIdx}`;
      let g = drawIndex.get(key);
      if (g === undefined) { g = draws.length; drawIndex.set(key, g); draws.push({ mesh: m.id, material: m.materials?.[matIdx] ?? String(matIdx) }); }
      G[t] = g;
      const o = t * 9;
      const ux = P[o + 3]! - P[o]!, uy = P[o + 4]! - P[o + 1]!, uz = P[o + 5]! - P[o + 2]!;
      const vx = P[o + 6]! - P[o]!, vy = P[o + 7]! - P[o + 1]!, vz = P[o + 8]! - P[o + 2]!;
      const cx = uy * vz - uz * vy, cy = uz * vx - ux * vz, cz = ux * vy - uy * vx;
      const len = Math.hypot(cx, cy, cz);
      if (len < 1e-9) { G[t] = -1; continue; } // degenerate: draws nothing
      NX[t] = cx / len; NY[t] = cy / len; NZ[t] = cz / len;
      D[t] = NX[t]! * P[o]! + NY[t]! * P[o + 1]! + NZ[t]! * P[o + 2]!;
    }
  });

  // spatial hash, several levels: a triangle lives in the level whose cell fits its (gap-expanded) box, so a
  // floor of small triangles and one merged 20 m triangle are both a few entries. Each pair is tested exactly once:
  // in the cell (of the larger triangle's level) holding the low corner of the two boxes' overlap.
  const LO = new Float64Array(N * 3), HI = new Float64Array(N * 3);
  const LV = new Int8Array(N);
  // facing classes (major axis and sign) a normal can reach within the angle tolerance, as a 6-bit mask: buckets
  // are per class, so floors never meet walls and a rough DC surface splits six ways
  const CLS = new Uint8Array(N);
  const reach = 2 * Math.sin(Math.acos(cosTol)) + 1e-6;
  const CL = 2 ** 48;
  const levels: number[] = [];
  for (let c = cell / 4; levels.length < 8; c *= 4) levels.push(c);
  const grids: Map<number, number[]>[] = levels.map(() => new Map());
  const OFF = 32768;
  const ci = (v: number, c: number) => Math.max(-OFF, Math.min(OFF - 1, Math.floor(v / c)));
  const ckey = (x: number, y: number, z: number) => ((x + OFF) * 65536 + (y + OFF)) * 65536 + (z + OFF);
  const lowBit = (m: number) => 31 - Math.clz32(m & -m);
  for (let i = 0; i < N; i++) {
    if (G[i]! < 0) continue;
    const o = i * 9;
    let ext = 0;
    for (let c = 0; c < 3; c++) {
      LO[i * 3 + c] = Math.min(P[o + c]!, P[o + 3 + c]!, P[o + 6 + c]!) - maxGap;
      HI[i * 3 + c] = Math.max(P[o + c]!, P[o + 3 + c]!, P[o + 6 + c]!) + maxGap;
      ext = Math.max(ext, HI[i * 3 + c]! - LO[i * 3 + c]!);
    }
    let l = 0;
    while (l < levels.length - 1 && ext > levels[l]!) l++;
    LV[i] = l;
    const nv = [NX[i]!, NY[i]!, NZ[i]!], top = Math.max(Math.abs(nv[0]!), Math.abs(nv[1]!), Math.abs(nv[2]!));
    let mask = 0;
    for (let a = 0; a < 3; a++) { if (nv[a]! >= top - reach) mask |= 1 << (a * 2); if (-nv[a]! >= top - reach) mask |= 1 << (a * 2 + 1); }
    CLS[i] = mask;
    const c = levels[l]!, g = grids[l]!;
    for (let x = ci(LO[i * 3]!, c); x <= ci(HI[i * 3]!, c); x++)
      for (let y = ci(LO[i * 3 + 1]!, c); y <= ci(HI[i * 3 + 1]!, c); y++)
        for (let z = ci(LO[i * 3 + 2]!, c); z <= ci(HI[i * 3 + 2]!, c); z++) {
          const k0 = ckey(x, y, z);
          for (let b = 0; b < 6; b++) {
            if (!(mask & (1 << b))) continue;
            const k = k0 + b * CL;
            let list = g.get(k);
            if (!list) g.set(k, (list = []));
            list.push(i);
          }
        }
  }

  // pair tests
  interface Pair { ga: number; gb: number; area: number; cx: number; cy: number; cz: number; nx: number; ny: number; nz: number; gap: number }
  const pairs: Pair[] = [];
  let testedCount = 0;
  const vertDist = (j: number, i: number, k: number) => NX[i]! * P[j * 9 + k * 3]! + NY[i]! * P[j * 9 + k * 3 + 1]! + NZ[i]! * P[j * 9 + k * 3 + 2]! - D[i]!;
  /** Test i0/j0 if this cell (x,y,z at size c) is the one that owns the pair. */
  const consider = (i0: number, j0: number, c: number, x: number, y: number, z: number, cls: number): void => {
    if (G[i0] === G[j0]) return;
    const common = CLS[i0]! & CLS[j0]!;
    if (!common || lowBit(common) !== cls) return;
    // boxes overlap, and this cell holds the overlap's low corner
    const lx = Math.max(LO[i0 * 3]!, LO[j0 * 3]!), ly = Math.max(LO[i0 * 3 + 1]!, LO[j0 * 3 + 1]!), lz = Math.max(LO[i0 * 3 + 2]!, LO[j0 * 3 + 2]!);
    if (lx > Math.min(HI[i0 * 3]!, HI[j0 * 3]!) || ly > Math.min(HI[i0 * 3 + 1]!, HI[j0 * 3 + 1]!) || lz > Math.min(HI[i0 * 3 + 2]!, HI[j0 * 3 + 2]!)) return;
    if (ci(lx, c) !== x || ci(ly, c) !== y || ci(lz, c) !== z) return;
    if (NX[i0]! * NX[j0]! + NY[i0]! * NY[j0]! + NZ[i0]! * NZ[j0]! < cosTol) return;
    const i = i0 < j0 ? i0 : j0, j = i0 < j0 ? j0 : i0;
    // B's distance to A's plane is linear over B: all three vertices beyond the gap on one side -> apart
    const d0 = vertDist(j, i, 0), d1 = vertDist(j, i, 1), d2 = vertDist(j, i, 2);
    if (Math.min(d0, d1, d2) > maxGap || Math.max(d0, d1, d2) < -maxGap) return;
    testedCount++;
    // A's plane frame
    const nx = NX[i]!, ny = NY[i]!, nz = NZ[i]!;
    const [e1, e2] = tangents(nx, ny, nz);
    const ox = P[i * 9]!, oy = P[i * 9 + 1]!, oz = P[i * 9 + 2]!;
    const U = (T: number, k: number) => (P[T * 9 + k * 3]! - ox) * e1[0] + (P[T * 9 + k * 3 + 1]! - oy) * e1[1] + (P[T * 9 + k * 3 + 2]! - oz) * e1[2];
    const V = (T: number, k: number) => (P[T * 9 + k * 3]! - ox) * e2[0] + (P[T * 9 + k * 3 + 1]! - oy) * e2[1] + (P[T * 9 + k * 3 + 2]! - oz) * e2[2];
    const a = [U(i, 0), V(i, 0), U(i, 1), V(i, 1), U(i, 2), V(i, 2)];
    // A is counter-clockwise in its own frame (e1 x e2 = n); keep its winding explicit for safety
    const ccw = (a[2]! - a[0]!) * (a[5]! - a[1]!) - (a[3]! - a[1]!) * (a[4]! - a[0]!) >= 0;
    const order = ccw ? [0, 1, 2] : [0, 2, 1];
    let poly = [U(j, 0), V(j, 0), U(j, 1), V(j, 1), U(j, 2), V(j, 2)];
    for (let e = 0; e < 3 && poly.length >= 6; e++) {
      const s = order[e]!, f = order[(e + 1) % 3]!;
      poly = clipEdge(poly, a[s * 2]!, a[s * 2 + 1]!, a[f * 2]!, a[f * 2 + 1]!);
    }
    if (poly.length < 6) return;
    let area2 = 0, per = 0, cu = 0, cv = 0;
    const n = poly.length / 2;
    for (let k = 0; k < n; k++) {
      const x0 = poly[k * 2]!, y0 = poly[k * 2 + 1]!, x1 = poly[((k + 1) % n) * 2]!, y1 = poly[((k + 1) % n) * 2 + 1]!;
      const cr = x0 * y1 - x1 * y0;
      area2 += cr; cu += (x0 + x1) * cr; cv += (y0 + y1) * cr;
      per += Math.hypot(x1 - x0, y1 - y0);
    }
    const area = Math.abs(area2) / 2;
    if (area < minPairArea || area / (per || 1) < minThick) return;
    cu /= 3 * area2; cv /= 3 * area2;
    const qx = ox + cu * e1[0] + cv * e2[0], qy = oy + cu * e1[1] + cv * e2[1], qz = oz + cu * e1[2] + cv * e2[2];
    const nn = NX[j]! * nx + NY[j]! * ny + NZ[j]! * nz;
    const h = (D[j]! - (NX[j]! * qx + NY[j]! * qy + NZ[j]! * qz)) / nn;
    if (Math.abs(h) > maxGap) return;
    const ga = Math.min(G[i]!, G[j]!), gb = Math.max(G[i]!, G[j]!);
    pairs.push({ ga, gb, area, cx: qx + (h / 2) * nx, cy: qy + (h / 2) * ny, cz: qz + (h / 2) * nz, nx, ny, nz, gap: Math.abs(h) });
  };
  const decode = (k: number): [number, number, number, number] => {
    const cls = Math.floor(k / CL), q = k - cls * CL;
    const z = (q % 65536) - OFF, r = Math.floor(q / 65536);
    return [Math.floor(r / 65536) - OFF, (r % 65536) - OFF, z, cls];
  };
  // same level: within each cell
  grids.forEach((g, l) => {
    const c = levels[l]!;
    for (const [k, list] of g) {
      if (list.length < 2) continue;
      const [x, y, z, cls] = decode(k);
      for (let p = 0; p < list.length; p++) for (let q = p + 1; q < list.length; q++) consider(list[p]!, list[q]!, c, x, y, z, cls);
    }
  });
  // across levels: a triangle looks up the coarser levels' cells its box touches
  for (let i = 0; i < N; i++) {
    if (G[i]! < 0) continue;
    for (let l = LV[i]! + 1; l < levels.length; l++) {
      const g = grids[l]!;
      if (!g.size) continue;
      const c = levels[l]!;
      for (let x = ci(LO[i * 3]!, c); x <= ci(HI[i * 3]!, c); x++)
        for (let y = ci(LO[i * 3 + 1]!, c); y <= ci(HI[i * 3 + 1]!, c); y++)
          for (let z = ci(LO[i * 3 + 2]!, c); z <= ci(HI[i * 3 + 2]!, c); z++) {
            const k0 = ckey(x, y, z);
            for (let b = 0; b < 6; b++) {
              if (!(CLS[i]! & (1 << b))) continue;
              const list = g.get(k0 + b * CL);
              if (list) for (const j of list) consider(i, j, c, x, y, z, b);
            }
          }
    }
  }

  // clusters: overlaps of one draw pair facing the same major direction, per cell of `radius`; touching cells join
  const parent = pairs.map((_, k) => k);
  const find = (k: number): number => { while (parent[k] !== k) { parent[k] = parent[parent[k]!]!; k = parent[k]!; } return k; };
  const faceOf = (p: Pair) => {
    const ax = Math.abs(p.nx), ay = Math.abs(p.ny), az = Math.abs(p.nz);
    return ax >= ay && ax >= az ? (p.nx > 0 ? 0 : 1) : ay >= az ? (p.ny > 0 ? 2 : 3) : p.nz > 0 ? 4 : 5;
  };
  const cellRep = new Map<string, number>();
  const cellKey = (p: Pair, f: number, x: number, y: number, z: number) => `${p.ga},${p.gb},${f},${x},${y},${z}`;
  const pcell = pairs.map((p) => [faceOf(p), Math.floor(p.cx / radius), Math.floor(p.cy / radius), Math.floor(p.cz / radius)] as const);
  pairs.forEach((p, k) => {
    const [f, x, y, z] = pcell[k]!;
    const key = cellKey(p, f, x, y, z);
    const r = cellRep.get(key);
    if (r === undefined) cellRep.set(key, k);
    else { const ra = find(k), rb = find(r); if (ra !== rb) parent[ra] = rb; }
  });
  for (const k of cellRep.values()) {
    const p = pairs[k]!, [f, x, y, z] = pcell[k]!;
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) {
      if (!dx && !dy && !dz) continue;
      const o = cellRep.get(cellKey(p, f, x + dx, y + dy, z + dz));
      if (o === undefined) continue;
      const ra = find(k), rb = find(o);
      if (ra !== rb) parent[ra] = rb;
    }
  }
  const acc = new Map<number, { ga: number; gb: number; area: number; c: Vec3; n: Vec3; gap: number; pairs: number; min: Vec3; max: Vec3 }>();
  pairs.forEach((p, k) => {
    const r = find(k);
    let c = acc.get(r);
    if (!c) acc.set(r, (c = { ga: p.ga, gb: p.gb, area: 0, c: [0, 0, 0], n: [0, 0, 0], gap: 0, pairs: 0, min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] }));
    c.area += p.area; c.pairs++; c.gap = Math.max(c.gap, p.gap);
    const pc: Vec3 = [p.cx, p.cy, p.cz];
    for (let a = 0; a < 3; a++) { c.c[a]! += pc[a]! * p.area; c.min[a] = Math.min(c.min[a]!, pc[a]!); c.max[a] = Math.max(c.max[a]!, pc[a]!); }
    c.n[0] += p.nx * p.area; c.n[1] += p.ny * p.area; c.n[2] += p.nz * p.area;
  });
  const r4 = (v: number) => Math.round(v * 1e4) / 1e4;
  const r3 = (v: number) => Math.round(v * 1e3) / 1e3;
  const clusters: ZFightCluster[] = [];
  for (const c of acc.values()) {
    if (c.area < minArea) continue;
    const nl = Math.hypot(...c.n) || 1;
    clusters.push({
      a: draws[c.ga]!, b: draws[c.gb]!,
      centre: c.c.map((v) => r3(v / c.area)) as Vec3,
      normal: c.n.map((v) => r3(v / nl)) as Vec3,
      area: r4(c.area), gap: r4(c.gap), pairs: c.pairs,
      min: c.min.map(r3) as Vec3, max: c.max.map(r3) as Vec3,
    });
  }
  clusters.sort((x, y) => y.area - x.area);
  const bp = new Map<string, ZFightPairSummary>();
  for (const c of clusters) {
    const [a, b] = c.a.mesh <= c.b.mesh ? [c.a, c.b] : [c.b, c.a];
    const key = `${a.mesh}\u0000${b.mesh}`;
    let s = bp.get(key);
    if (!s) bp.set(key, (s = { a: a.mesh, b: b.mesh, area: 0, clusters: 0, materials: [] }));
    s.area = r4(s.area + c.area); s.clusters++;
    const mk = `${a.material} | ${b.material}`;
    if (!s.materials.includes(mk) && s.materials.length < 6) s.materials.push(mk);
  }
  const byMeshPair = [...bp.values()].sort((x, y) => y.area - x.area);
  return { triangles: N, tested: testedCount, overlaps: pairs.length, clusters, byMeshPair, ms: Date.now() - t0 };
}

// ------------------------------------------------------------------ decal placement

export interface DecalProjectorInput {
  /** Entity world position and rotation (scale does not size a decal). */
  position: Vec3;
  rotation: Quat;
  size: [number, number];
  depth: number;
  /** LOCAL projection direction (default [0,0,-1]). */
  direction?: Vec3;
  /** Spin around the projection axis, degrees. */
  rotationDeg?: number;
}
export interface DecalFrame {
  origin: Vec3;
  /** Projector axes in world space; the projection runs along -z. */
  x: Vec3;
  y: Vec3;
  z: Vec3;
  /** Half extents of the box along x, y, z. */
  half: Vec3;
}

/** The projector box exactly as packages/render/src/decals.ts builds it. */
export function decalFrame(d: DecalProjectorInput): DecalFrame {
  let dir = d.direction ?? [0, 0, -1];
  let dl = Math.hypot(dir[0], dir[1], dir[2]);
  if (dl < 1e-5) { dir = [0, 0, -1]; dl = 1; }
  const to: Vec3 = [dir[0] / dl, dir[1] / dl, dir[2] / dl];
  // THREE.Quaternion.setFromUnitVectors((0,0,-1), to)
  const from: Vec3 = [0, 0, -1];
  const r = from[0] * to[0] + from[1] * to[1] + from[2] * to[2] + 1;
  let q: Quat;
  if (r < 1e-8) q = Math.abs(from[0]) > Math.abs(from[2]) ? [-from[1], from[0], 0, 0] : [0, -from[2], from[1], 0];
  else q = [from[1] * to[2] - from[2] * to[1], from[2] * to[0] - from[0] * to[2], from[0] * to[1] - from[1] * to[0], r];
  const ql = Math.hypot(...q);
  q = [q[0] / ql, q[1] / ql, q[2] / ql, q[3] / ql];
  const a = (((d.rotationDeg ?? 0) * Math.PI) / 180) / 2;
  const spin: Quat = [0, 0, Math.sin(a), Math.cos(a)];
  const wl = Math.hypot(...d.rotation) || 1;
  const w: Quat = [d.rotation[0] / wl, d.rotation[1] / wl, d.rotation[2] / wl, d.rotation[3] / wl];
  const full = quatMultiply(quatMultiply(w, q), spin);
  return {
    origin: [...d.position] as Vec3,
    x: vecApplyQuat([1, 0, 0], full),
    y: vecApplyQuat([0, 1, 0], full),
    z: vecApplyQuat([0, 0, 1], full),
    half: [Math.max(d.size[0], 0.01) / 2, Math.max(d.size[1], 0.01) / 2, Math.max(d.depth, 0.01) / 2],
  };
}

/** World-space axis-aligned bounds of a projector box. */
export function decalFrameBounds(f: DecalFrame): { min: Vec3; max: Vec3 } {
  const min: Vec3 = [0, 0, 0], max: Vec3 = [0, 0, 0];
  for (let k = 0; k < 3; k++) {
    const e = Math.abs(f.x[k]!) * f.half[0] + Math.abs(f.y[k]!) * f.half[1] + Math.abs(f.z[k]!) * f.half[2];
    min[k] = f.origin[k]! - e; max[k] = f.origin[k]! + e;
  }
  return { min, max };
}

export interface DecalCoverageOptions {
  /** Samples per side (default 12). */
  grid?: number;
  /** A first hit this close (m) in front of the painted surface is on it (default 0.12, the renderer's layer). */
  layerTol?: number;
  /** Faces turned further than this from the projection axis are not painted (default 60, decal.maxAngle). */
  maxAngle?: number;
  /** Only these triangle indices (a pre-filter); every triangle when absent. */
  candidates?: ArrayLike<number>;
}
export interface DecalCoverage {
  samples: number;
  on: number;
  blocked: number;
  empty: number;
  /** Shares 0..1. */
  onShare: number;
  blockedShare: number;
  emptyShare: number;
  /** Blocking owner -> samples it blocked. */
  blockers: Map<number, number>;
}

/**
 * Classify a grid of rays across a decal's box. `soup`: world triangles (nine numbers each); `owners[t]`: who owns
 * triangle t (reported as the blocker). Per sample the painted surface is the facing face whose depth is nearest
 * the entity's plane (keepNearestSurface); the first hit is the front-facing face nearest the box's front plane.
 */
export function decalCoverage(soup: ArrayLike<number>, owners: ArrayLike<number>, frame: DecalFrame, opts: DecalCoverageOptions = {}): DecalCoverage {
  const G = opts.grid ?? 12;
  const tol = opts.layerTol ?? 0.12;
  const minFacing = Math.cos(((opts.maxAngle ?? 60) * Math.PI) / 180);
  const [hx, hy, hz] = frame.half;
  const first = new Float64Array(G * G).fill(-Infinity);
  const firstOwner = new Int32Array(G * G).fill(-1);
  const near = new Float64Array(G * G).fill(Infinity);
  const { origin: o, x: X, y: Y, z: Z } = frame;
  const loc = new Float64Array(9);
  const visit = (t: number) => {
    for (let k = 0; k < 3; k++) {
      const px = soup[t * 9 + k * 3]! - o[0], py = soup[t * 9 + k * 3 + 1]! - o[1], pz = soup[t * 9 + k * 3 + 2]! - o[2];
      loc[k * 3] = px * X[0] + py * X[1] + pz * X[2];
      loc[k * 3 + 1] = px * Y[0] + py * Y[1] + pz * Y[2];
      loc[k * 3 + 2] = px * Z[0] + py * Z[1] + pz * Z[2];
    }
    const ax = loc[0]!, ay = loc[1]!, az = loc[2]!, bx = loc[3]!, by = loc[4]!, bz = loc[5]!, cx = loc[6]!, cy = loc[7]!, cz = loc[8]!;
    if (Math.max(ax, bx, cx) < -hx || Math.min(ax, bx, cx) > hx || Math.max(ay, by, cy) < -hy || Math.min(ay, by, cy) > hy) return;
    if (Math.max(az, bz, cz) < -hz || Math.min(az, bz, cz) > hz) return;
    const ux = bx - ax, uy = by - ay, uz = bz - az, vx = cx - ax, vy = cy - ay, vz = cz - az;
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const nl = Math.hypot(nx, ny, nz);
    if (nl < 1e-12 || nz <= 1e-9 * nl) return; // a back face or edge-on: a ray down -z does not stop on it from the front
    const facing = nz / nl >= minFacing;
    const det = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy);
    if (Math.abs(det) < 1e-14) return;
    const cell = (v: number, h: number) => Math.min(G - 1, Math.max(0, Math.floor(((v / h + 1) / 2) * G)));
    const i0 = cell(Math.min(ax, bx, cx), hx), i1 = cell(Math.max(ax, bx, cx), hx);
    const j0 = cell(Math.min(ay, by, cy), hy), j1 = cell(Math.max(ay, by, cy), hy);
    for (let j = j0; j <= j1; j++) {
      const py = ((j + 0.5) / G * 2 - 1) * hy;
      for (let i = i0; i <= i1; i++) {
        const px = ((i + 0.5) / G * 2 - 1) * hx;
        const w0 = ((by - cy) * (px - cx) + (cx - bx) * (py - cy)) / det;
        const w1 = ((cy - ay) * (px - cx) + (ax - cx) * (py - cy)) / det;
        const w2 = 1 - w0 - w1;
        if (w0 < 0 || w1 < 0 || w2 < 0) continue;
        const z = w0 * az + w1 * bz + w2 * cz;
        if (z < -hz || z > hz) continue;
        const s = i + j * G;
        if (z > first[s]!) { first[s] = z; firstOwner[s] = owners[t]!; }
        if (facing && Math.abs(z) < Math.abs(near[s]!)) near[s] = z;
      }
    }
  };
  if (opts.candidates) for (let k = 0; k < opts.candidates.length; k++) visit(opts.candidates[k]!);
  else for (let t = 0; t < soup.length / 9; t++) visit(t);
  let on = 0, blocked = 0, empty = 0;
  const blockers = new Map<number, number>();
  for (let s = 0; s < G * G; s++) {
    if (near[s] === Infinity) { empty++; continue; }
    if (first[s]! - near[s]! <= tol) { on++; continue; }
    blocked++;
    blockers.set(firstOwner[s]!, (blockers.get(firstOwner[s]!) ?? 0) + 1);
  }
  const S = G * G;
  return { samples: S, on, blocked, empty, onShare: on / S, blockedShare: blocked / S, emptyShare: empty / S, blockers };
}

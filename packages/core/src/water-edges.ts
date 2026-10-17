/**
 * WATER EDGES — no water may end in the air.
 *
 * Every body of water (a dungeon pool, a placed pond, a plunge pool, a river's
 * curtain) is judged by its OUTLINE: each edge point must either be buried in
 * solid (under a wall, a rock lip, a shore that rises out of it — by a margin)
 * or stand at a deliberate FINISH the body declares (`water.finishes`):
 *
 * - `drain`    — the water goes down into dark (a sump, a grate);
 * - `lip-fall` — a small curtain over an edge;
 * - `dark`     — the channel goes on into darkness (a black card / fog where it leaves the light);
 * - `built`    — flush under a built edge (a kerb, a quay, a hull).
 *
 * An edge that is neither is OPEN — a straight line of water hanging in the
 * open, the defect players read as "the water just stops". Three questions
 * make up the gate and the fix, all over a {@link SolidProbe} (the voxel
 * field's density, DC dungeon meshes, decks: whatever is solid):
 *
 * - {@link classifyWaterEdge} / {@link classifyOutline}: buried / finished / open (and why: a drop, a shelf, a run-on);
 * - {@link clipWaterToSolid}: the default fix — the sheet filled to the walls at its level (like the terrain-clipped
 *   rivers), with a buried rim, so most edges are buried by construction and only real openings stay open;
 * - {@link curtainFit}: a falling-water curtain's top against the river surface, and its hug of the face.
 *
 * Pure functions; core, headless.
 */
import type { SolidProbe } from "./voxel/seat.js";

export const WATER_FINISH_KINDS = ["drain", "lip-fall", "dark", "built"] as const;
export type WaterFinishKind = (typeof WATER_FINISH_KINDS)[number];

/** A finish over a stretch of a water body's outline, world XZ. */
export interface WaterFinish {
  kind: WaterFinishKind;
  /** The stretch of edge it finishes, world [x, z] to [x, z]. */
  from: [number, number];
  to: [number, number];
  /** The entity that draws it (a dark card, a curtain, a kerb), when one does. */
  entity?: string;
}

/**
 * `horizon`: the sea running on to the world's edge (an ocean plane past the world boundary). Not a fault and not a
 * finish anyone draws: the open sea has no edge a player can reach.
 */
export type WaterEdgeClass = "buried" | "finished" | "open" | "horizon";
/** Why an open edge is open: water over a drop (a hole, a ledge), a sheet stopping over its own bed, or a flood that ran out of room. */
export type WaterOpenWhy = "drop" | "shelf" | "run-on";

export interface WaterEdgeSample {
  x: number;
  z: number;
  /** Outward unit normal of the outline here, XZ. */
  out: [number, number];
  cls: WaterEdgeClass;
  why?: WaterOpenWhy;
  finish?: WaterFinishKind;
}

export interface WaterEdgeOptions {
  /** Outward distance within which solid buries the edge (m). Default 0.35. */
  margin?: number;
  /** Distance from a finish's stretch within which an edge counts as finished (m). Default 0.75. */
  finishReach?: number;
  /** Depth under the surface a bed may be at before the outside is a drop (m). Default 12. */
  bedDepth?: number;
  /**
   * Where the water runs on to the world's edge (the open sea past the world boundary): an edge point here is
   * `horizon`, not open. Give it only for a sea-level body (see the world gate); placed water never has one.
   */
  horizon?: (x: number, z: number) => boolean;
}

const DIP = 0.03;

/** Is (x, y, z) inside solid? */
export function solidAt(probe: SolidProbe, x: number, y: number, z: number): boolean {
  const top = probe.floor(x, z, y, y - 0.02);
  return top !== null && top >= y - 1e-6;
}

function segDistance(x: number, z: number, a: [number, number], b: [number, number]): number {
  const dx = b[0] - a[0];
  const dz = b[1] - a[1];
  const len2 = dx * dx + dz * dz;
  const t = len2 < 1e-12 ? 0 : Math.max(0, Math.min(1, ((x - a[0]) * dx + (z - a[1]) * dz) / len2));
  return Math.hypot(x - (a[0] + dx * t), z - (a[1] + dz * t));
}

/** The class of one edge point of a surface at `y`, looking outward along `out`. */
export function classifyWaterEdge(
  probe: SolidProbe,
  x: number,
  z: number,
  y: number,
  out: [number, number],
  finishes: readonly WaterFinish[] = [],
  options: WaterEdgeOptions = {},
): WaterEdgeSample {
  const margin = options.margin ?? 0.35;
  const reach = options.finishReach ?? 0.75;
  const bedDepth = options.bedDepth ?? 12;
  const sample: WaterEdgeSample = { x, z, out, cls: "open" };
  if (options.horizon?.(x, z)) {
    sample.cls = "horizon";
    return sample;
  }
  for (let d = -0.05; d <= margin + 1e-9; d += 0.1) {
    if (solidAt(probe, x + out[0] * d, y - DIP, z + out[1] * d)) {
      sample.cls = "buried";
      return sample;
    }
  }
  const wall = probe.wall?.(x - out[0] * 0.05, y - DIP, z - out[1] * 0.05, out[0], out[1], margin + 0.05);
  if (wall !== null && wall !== undefined) {
    sample.cls = "buried";
    return sample;
  }
  for (const f of finishes) {
    if (segDistance(x, z, f.from, f.to) <= reach) {
      sample.cls = "finished";
      sample.finish = f.kind;
      return sample;
    }
  }
  const ox = x + out[0] * 0.5;
  const oz = z + out[1] * 0.5;
  const bed = probe.floor(ox, oz, y - DIP, y - bedDepth);
  sample.why = bed === null ? "drop" : "shelf";
  return sample;
}

export interface OutlineReport {
  samples: WaterEdgeSample[];
  open: number;
  buried: number;
  finished: number;
  /** Points on the open sea at the world's edge ({@link WaterEdgeOptions.horizon}). */
  horizon: number;
  /** Open stretches: consecutive open samples, with their length (m) and the worst reason. */
  runs: { from: [number, number]; to: [number, number]; length: number; why: WaterOpenWhy; mid: [number, number]; out: [number, number] }[];
  /** Open stretches shorter than `minRun` (a sliver at a wall corner): counted, not faults. */
  slivers: number;
}

/** One straight piece of a water outline, world XZ, with its outward unit normal. */
export interface WaterEdgeSegment {
  a: [number, number];
  b: [number, number];
  out: [number, number];
}

/** A closed ring (either winding, world XZ) as segments with outward normals. */
export function ringSegments(outline: readonly [number, number][]): WaterEdgeSegment[] {
  let area = 0;
  for (let i = 0; i < outline.length; i++) {
    const a = outline[i]!;
    const b = outline[(i + 1) % outline.length]!;
    area += a[0] * b[1] - b[0] * a[1];
  }
  const sign = area >= 0 ? 1 : -1;
  const segs: WaterEdgeSegment[] = [];
  for (let i = 0; i < outline.length; i++) {
    const a = outline[i]!;
    const b = outline[(i + 1) % outline.length]!;
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (len < 1e-9) continue;
    segs.push({ a: [a[0], a[1]], b: [b[0], b[1]], out: [((b[1] - a[1]) / len) * sign, (-(b[0] - a[0]) / len) * sign] });
  }
  return segs;
}

/**
 * The outline of a flat sheet mesh: the parts of its triangle edges covered by ONE triangle (T-junctions — a long
 * edge beside two short ones — are split by coverage along each line, so merged quads read right), world XZ
 * (positions + `origin`), outward = away from the owning triangle's third corner.
 */
export function meshOutline(positions: ArrayLike<number>, indices: ArrayLike<number>, origin: [number, number, number] = [0, 0, 0]): WaterEdgeSegment[] {
  interface Piece { ax: number; az: number; bx: number; bz: number; ox: number; oz: number }
  const lines = new Map<string, { dx: number; dz: number; pieces: Piece[] }>();
  const P = (v: number): [number, number] => [positions[v * 3]! + origin[0], positions[v * 3 + 2]! + origin[2]];
  for (let t = 0; t + 2 < indices.length; t += 3) {
    const tri = [P(indices[t]!), P(indices[t + 1]!), P(indices[t + 2]!)];
    for (let e = 0; e < 3; e++) {
      let a = tri[e]!, b = tri[(e + 1) % 3]!;
      const c = tri[(e + 2) % 3]!;
      const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
      if (len < 1e-9) continue;
      let dx = (b[0] - a[0]) / len, dz = (b[1] - a[1]) / len;
      // canonical direction per line
      if (dx < -1e-9 || (Math.abs(dx) <= 1e-9 && dz < 0)) { dx = -dx; dz = -dz; [a, b] = [b, a]; }
      let ox = dz, oz = -dx;
      if ((c[0] - a[0]) * ox + (c[1] - a[1]) * oz > 0) { ox = -ox; oz = -oz; }
      const off = -dz * a[0] + dx * a[1];
      const key = `${Math.round(dx * 1e4)},${Math.round(dz * 1e4)},${Math.round(off * 1e3)}`;
      let line = lines.get(key);
      if (!line) lines.set(key, (line = { dx, dz, pieces: [] }));
      line.pieces.push({ ax: a[0], az: a[1], bx: b[0], bz: b[1], ox, oz });
    }
  }
  const segs: WaterEdgeSegment[] = [];
  for (const { dx, dz, pieces } of lines.values()) {
    const along = (x: number, z: number): number => x * dx + z * dz;
    // sweep: +1 at a piece's start, -1 at its end; boundary where coverage is exactly 1
    const events: { t: number; d: number; piece: Piece }[] = [];
    for (const pc of pieces) {
      events.push({ t: along(pc.ax, pc.az), d: 1, piece: pc }, { t: along(pc.bx, pc.bz), d: -1, piece: pc });
    }
    events.sort((a, b) => a.t - b.t || a.d - b.d);
    const open = new Set<Piece>();
    for (let k = 0; k < events.length; k++) {
      const ev = events[k]!;
      if (ev.d > 0) open.add(ev.piece); else open.delete(ev.piece);
      const next = events[k + 1];
      if (!next || next.t - ev.t < 1e-6 || open.size !== 1) continue;
      const pc = [...open][0]!;
      const t0 = ev.t, t1 = next.t;
      const base = along(pc.ax, pc.az);
      const at = (t: number): [number, number] => [pc.ax + dx * (t - base), pc.az + dz * (t - base)];
      segs.push({ a: at(t0), b: at(t1), out: [pc.ox, pc.oz] });
    }
  }
  return segs;
}

/**
 * Walk outline segments every `step` metres and classify each point. Open
 * points within 1.5 steps of each other become one run (a stretch to finish).
 */
export function classifyEdges(
  probe: SolidProbe,
  segments: readonly WaterEdgeSegment[],
  y: number,
  finishes: readonly WaterFinish[] = [],
  options: WaterEdgeOptions & { step?: number; minRun?: number } = {},
): OutlineReport {
  const step = options.step ?? 0.5;
  const samples: WaterEdgeSample[] = [];
  for (const seg of segments) {
    const len = Math.hypot(seg.b[0] - seg.a[0], seg.b[1] - seg.a[1]);
    const n = Math.max(1, Math.round(len / step));
    for (let k = 0; k < n; k++) {
      const t = (k + 0.5) / n;
      samples.push(classifyWaterEdge(probe, seg.a[0] + (seg.b[0] - seg.a[0]) * t, seg.a[1] + (seg.b[1] - seg.a[1]) * t, y, seg.out, finishes, options));
    }
  }
  const rep: OutlineReport = { samples, open: 0, buried: 0, finished: 0, horizon: 0, runs: [], slivers: 0 };
  for (const s of samples) rep[s.cls]++;
  const minRun = options.minRun ?? 1;
  const rank: Record<WaterOpenWhy, number> = { shelf: 0, "run-on": 1, drop: 2 };
  const open = samples.filter((s) => s.cls === "open");
  const seen = new Uint8Array(open.length);
  // open points within 1.5 steps join one stretch: a grid of that size, neighbours from the 3x3 cells around
  const link = step * 1.5;
  const grid = new Map<string, number[]>();
  const cellOf = (s: WaterEdgeSample): [number, number] => [Math.floor(s.x / link), Math.floor(s.z / link)];
  open.forEach((s, i) => {
    const [gx, gz] = cellOf(s);
    const key = `${gx},${gz}`;
    const b = grid.get(key);
    if (b) b.push(i);
    else grid.set(key, [i]);
  });
  for (let i = 0; i < open.length; i++) {
    if (seen[i]) continue;
    seen[i] = 1;
    const group = [open[i]!];
    for (let g = 0; g < group.length; g++) {
      const [gx, gz] = cellOf(group[g]!);
      for (let ox = -1; ox <= 1; ox++)
        for (let oz = -1; oz <= 1; oz++)
          for (const j of grid.get(`${gx + ox},${gz + oz}`) ?? []) {
            if (seen[j]) continue;
            if (Math.hypot(open[j]!.x - group[g]!.x, open[j]!.z - group[g]!.z) <= link) { seen[j] = 1; group.push(open[j]!); }
          }
    }
    // the stretch's ends: the point farthest from its first, then the point farthest from that (exact on a line or
    // an arc, which is what an open stretch of outline is; all-pairs was quadratic)
    const farthest = (p: WaterEdgeSample): WaterEdgeSample => {
      let best = p, far = -1;
      for (const q of group) { const d = Math.hypot(p.x - q.x, p.z - q.z); if (d > far) { far = d; best = q; } }
      return best;
    };
    const from = farthest(group[0]!);
    const to = farthest(from);
    const why = group.reduce<WaterOpenWhy>((w, s) => (s.why && rank[s.why] > rank[w] ? s.why : w), "shelf");
    const mid = group[Math.floor(group.length / 2)]!;
    if (group.length * step < minRun) { rep.slivers++; continue; }
    let ox = 0, oz = 0;
    for (const g of group) { ox += g.out[0]; oz += g.out[1]; }
    // a stretch round a corner (a sliver wrapping a wall end) can average its normals to nothing: take the middle one
    const ol = Math.hypot(ox, oz);
    const out: [number, number] = ol > group.length * 0.5 ? [ox / ol, oz / ol] : mid.out;
    rep.runs.push({ from: [from.x, from.z], to: [to.x, to.z], length: group.length * step, why, mid: [mid.x, mid.z], out });
  }
  rep.runs.sort((a, b) => b.length - a.length);
  return rep;
}

/** {@link classifyEdges} over a closed ring (either winding, world XZ). */
export function classifyOutline(
  probe: SolidProbe,
  outline: readonly [number, number][],
  y: number,
  finishes: readonly WaterFinish[] = [],
  options: WaterEdgeOptions & { step?: number; minRun?: number } = {},
): OutlineReport {
  return classifyEdges(probe, ringSegments(outline), y, finishes, options);
}

// ------------------------------------------------------------------ clip to the walls

export interface WaterClipOptions {
  /** Raster cell (m). Default 0.5. */
  cell?: number;
  /** How far past the seed the water may spread to reach its walls (m). Default 8. */
  grow?: number;
  /** Swimmable depth (the `water` component's). Default 3. */
  depth?: number;
  /** A cell holds water when a bed lies within this far under the surface (or depth + 1 m); none: a drop. Default 12. */
  bedSearch?: number;
}

export interface WaterClip {
  /** World-space quads as a surface mesh: positions relative to (`origin`), y = 0 at the surface. */
  positions: number[];
  indices: number[];
  origin: [number, number, number];
  /** Wet cells (held water) and rim cells (buried margin under the wall or shore). */
  wet: number;
  rim: number;
  /** Footprint of the clipped sheet (world XZ). */
  bounds: { x0: number; z0: number; x1: number; z1: number };
  /** Cell sides where the water meets neither solid nor a bed: what still needs a finish, world XZ segments with outward normals. */
  open: { a: [number, number]; b: [number, number]; out: [number, number]; why: WaterOpenWhy }[];
}

/**
 * The water filled to its walls at `surfaceY`: from the seed footprint (a
 * rectangle), flood every cell whose surface point is air with a bed under it
 * (within `depth` + 1 m), up to `grow` metres out; then a one-cell RIM of the
 * solid around it (walls, a shore rising out of the water) so the sheet's edge
 * is buried by a margin. Cells that are neither (no bed: a drop; the grow
 * limit: the channel goes on) are open sides — what a finish must cover.
 * Rows of cells merge into quads.
 */
export function clipWaterToSolid(
  probe: SolidProbe,
  seed: { x0: number; z0: number; x1: number; z1: number },
  surfaceY: number,
  options: WaterClipOptions = {},
): WaterClip {
  const cell = options.cell ?? 0.5;
  const grow = options.grow ?? 8;
  const depth = options.depth ?? 3;
  const bedSearch = options.bedSearch ?? 12;
  const bx0 = Math.floor((seed.x0 - grow) / cell) * cell;
  const bz0 = Math.floor((seed.z0 - grow) / cell) * cell;
  const nx = Math.ceil((seed.x1 + grow - bx0) / cell);
  const nz = Math.ceil((seed.z1 + grow - bz0) / cell);
  const cx = (i: number): number => bx0 + (i + 0.5) * cell;
  const cz = (j: number): number => bz0 + (j + 0.5) * cell;
  // 0 unknown, 1 wet, 2 solid at the surface (wall / shore), 3 air with no bed (drop)
  const kind = new Uint8Array(nx * nz);
  const classify = (i: number, j: number): number => {
    const k = j * nx + i;
    if (kind[k]) return kind[k]!;
    const x = cx(i);
    const z = cz(j);
    if (solidAt(probe, x, surfaceY - DIP, z)) return (kind[k] = 2);
    return (kind[k] = probe.floor(x, z, surfaceY - DIP, surfaceY - Math.max(depth + 1, bedSearch)) === null ? 3 : 1);
  };
  const wet = new Uint8Array(nx * nz);
  const queue: number[] = [];
  for (let j = 0; j < nz; j++) {
    for (let i = 0; i < nx; i++) {
      const x = cx(i);
      const z = cz(j);
      if (x < seed.x0 || x > seed.x1 || z < seed.z0 || z > seed.z1) continue;
      if (classify(i, j) === 1) {
        wet[j * nx + i] = 1;
        queue.push(j * nx + i);
      }
    }
  }
  const open: WaterClip["open"] = [];
  const rimSet = new Set<number>();
  const N: [number, number][] = [[1, 0], [-1, 0], [0, 1], [0, -1]];
  while (queue.length) {
    const k = queue.pop()!;
    const i = k % nx;
    const j = Math.floor(k / nx);
    for (const [di, dj] of N) {
      const ii = i + di;
      const jj = j + dj;
      const side = (why: WaterOpenWhy): void => {
        const hx = cx(i) + (di * cell) / 2;
        const hz = cz(j) + (dj * cell) / 2;
        const a: [number, number] = [hx - (dj * cell) / 2, hz - (di * cell) / 2];
        const b: [number, number] = [hx + (dj * cell) / 2, hz + (di * cell) / 2];
        open.push({ a, b, out: [di, dj], why });
      };
      if (ii < 0 || jj < 0 || ii >= nx || jj >= nz) { side("run-on"); continue; }
      const kk = jj * nx + ii;
      if (wet[kk]) continue;
      const c = classify(ii, jj);
      if (c === 1) { wet[kk] = 1; queue.push(kk); }
      else if (c === 2) rimSet.add(kk);
      else side("drop");
    }
  }
  // quads: runs of (wet | rim) cells along each row
  const positions: number[] = [];
  const indices: number[] = [];
  let wetCount = 0;
  let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity;
  const ox = (seed.x0 + seed.x1) / 2;
  const oz = (seed.z0 + seed.z1) / 2;
  const r = (v: number): number => Math.round(v * 1000) / 1000;
  for (let j = 0; j < nz; j++) {
    let i = 0;
    while (i < nx) {
      const k = j * nx + i;
      if (!wet[k] && !rimSet.has(k)) { i++; continue; }
      let e = i;
      while (e < nx && (wet[j * nx + e] || rimSet.has(j * nx + e))) { if (wet[j * nx + e]) wetCount++; e++; }
      const x0 = bx0 + i * cell, x1 = bx0 + e * cell, z0 = bz0 + j * cell, z1 = z0 + cell;
      minX = Math.min(minX, x0); maxX = Math.max(maxX, x1); minZ = Math.min(minZ, z0); maxZ = Math.max(maxZ, z1);
      const base = positions.length / 3;
      positions.push(r(x0 - ox), 0, r(z0 - oz), r(x0 - ox), 0, r(z1 - oz), r(x1 - ox), 0, r(z1 - oz), r(x1 - ox), 0, r(z0 - oz));
      // counter-clockwise seen from above
      indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
      i = e;
    }
  }
  if (!Number.isFinite(minX)) { minX = seed.x0; maxX = seed.x1; minZ = seed.z0; maxZ = seed.z1; }
  return {
    positions,
    indices,
    origin: [ox, surfaceY, oz],
    wet: wetCount,
    rim: rimSet.size,
    bounds: { x0: minX, z0: minZ, x1: maxX, z1: maxZ },
    open,
  };
}

/** Join a clip's open cell sides into straight stretches (same outward normal, touching) — one finish each. */
export function openStretches(open: WaterClip["open"]): { from: [number, number]; to: [number, number]; out: [number, number]; length: number; why: WaterOpenWhy }[] {
  const key = (o: WaterClip["open"][number]): string => `${o.out[0]},${o.out[1]}`;
  const groups = new Map<string, WaterClip["open"]>();
  for (const o of open) {
    const k = key(o);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k)!.push(o);
  }
  const out: ReturnType<typeof openStretches> = [];
  for (const list of groups.values()) {
    const horizontal = list[0]!.out[1] !== 0; // side runs along x
    const line = (o: WaterClip["open"][number]): number => Math.round((horizontal ? o.a[1] : o.a[0]) * 1000);
    const along = (p: [number, number]): number => (horizontal ? p[0] : p[1]);
    const byLine = new Map<number, WaterClip["open"]>();
    for (const o of list) {
      if (!byLine.has(line(o))) byLine.set(line(o), []);
      byLine.get(line(o))!.push(o);
    }
    for (const segs of byLine.values()) {
      segs.sort((a, b) => Math.min(along(a.a), along(a.b)) - Math.min(along(b.a), along(b.b)));
      let cur: { lo: number; hi: number; why: WaterOpenWhy; fixed: number; out: [number, number] } | null = null;
      const emit = (): void => {
        if (!cur) return;
        const p = (v: number): [number, number] => (horizontal ? [v, cur!.fixed] : [cur!.fixed, v]);
        out.push({ from: p(cur.lo), to: p(cur.hi), out: cur.out, length: cur.hi - cur.lo, why: cur.why });
      };
      for (const s of segs) {
        const lo = Math.min(along(s.a), along(s.b));
        const hi = Math.max(along(s.a), along(s.b));
        const fixed = horizontal ? s.a[1] : s.a[0];
        if (cur && lo <= cur.hi + 1e-6) { cur.hi = Math.max(cur.hi, hi); if (s.why === "drop") cur.why = "drop"; }
        else { emit(); cur = { lo, hi, why: s.why, fixed, out: s.out }; }
      }
      emit();
    }
  }
  return out.sort((a, b) => b.length - a.length);
}

// ------------------------------------------------------------------ curtains

export interface CurtainFitOptions {
  /** A curtain point may stand this far off the face it hugs (m). Default 0.5. */
  maxFaceGap?: number;
  /** The curtain's top may stand this far from the upper water (m): under one 2 m water-lattice square. Default 1.25. */
  maxTopGap?: number;
  /** How far behind a curtain point the face is looked for (m); none within it: the point falls free. Default 6. */
  faceReach?: number;
  /**
   * Vertices per row. A curtain's brink holds the river level for a hand before rolling over, so its first TWO rows
   * share one height: counting the level run as one row doubled the column count, halved the rows, dropped the last
   * row (the one under the pool) and reported every curtain as "landing on a ledge" 1.6-3.2 m over its pool. Pass it
   * from the mesh ({@link curtainColumns} on its uv1s); without it the rows are found by geometry.
   */
  cols?: number;
}

/**
 * Vertices per row of a curtain mesh from its second uv set (fallCurtain writes uv1.x = across the span, 0 at the
 * first column rising to 1 at the last, row after row): the index where it first falls back. 0 if unreadable.
 */
export function curtainColumns(uv1s: ArrayLike<number> | undefined): number {
  if (!uv1s || uv1s.length < 4) return 0;
  for (let v = 1; v < uv1s.length / 2; v++) if (uv1s[v * 2]! < uv1s[(v - 1) * 2]! - 1e-6) return v;
  return 0;
}

/**
 * Vertices per row by geometry: the level run at the top, split where a vertex comes back to within a column step of
 * the first one (the second level row starts beside the first, 0.25 m downstream; columns are >= 2 cm apart and each
 * row runs the whole span away from its first vertex).
 */
function rowLength(positions: ArrayLike<number>): number {
  const count = positions.length / 3;
  let level = 0;
  while (level < count && Math.abs(positions[level * 3 + 1]! - positions[1]!) < 1e-6) level++;
  if (level < 4) return level;
  const d = (v: number): number => Math.hypot(positions[v * 3]! - positions[0]!, positions[v * 3 + 2]! - positions[2]!);
  // a row's far end is the span away; the next row's first vertex is back by its first column
  for (let k = 2; k <= level / 2; k++) {
    if (level % k !== 0) continue;
    if (d(k) < d(k - 1) * 0.5 && count % k === 0) return k;
  }
  return level;
}

export interface CurtainFit {
  /** Horizontal distance from the curtain's top row to the nearest upper-water vertex (the worst middle point), m. */
  topGap: number;
  /** The worst gap between a falling point and the face it should hug (envelope-aware: an overhang above allows it), m. */
  faceGap: number;
  /** Where that worst gap is (world). */
  worstAt: [number, number, number] | null;
  /** Falling points with no rock at all within `faceReach` behind them (the curtain floats free). */
  free: number;
  /** Falling points inside rock by more than 10 cm, and the highest such point's height above the pool. */
  inRock: number;
  landsAbovePool: number;
  /** Columns whose water ends on rock more than 1.5 m above the pool (a ledge or a slot floor between lip and pool). */
  landed: number;
  rows: number;
  faults: string[];
}

/**
 * Judge one curtain mesh (world positions, rows top to bottom with equal
 * column counts, as fallCurtain writes them): its top row against the upper
 * water (vertices of the river sheet at the top level, world), and every
 * falling point against the rock face behind it. The face gap is measured
 * against the ENVELOPE — the running furthest-out face above in the same column
 * — so a curtain bulging over an overhang is not a fault, one standing metres
 * out from its cliff is.
 */
export function curtainFit(
  probe: SolidProbe,
  positions: ArrayLike<number>,
  fall: { top: number; bottom: number; dirX: number; dirZ: number },
  upperWater: ArrayLike<number>,
  options: CurtainFitOptions = {},
): CurtainFit {
  const maxFaceGap = options.maxFaceGap ?? 0.5;
  const maxTopGap = options.maxTopGap ?? 1.25;
  const reach = options.faceReach ?? 6;
  const count = positions.length / 3;
  // the top row is level (every column at the river's surface): its length is the column count; rows follow in order
  const cols = options.cols && options.cols > 0 && count % options.cols === 0 ? options.cols : rowLength(positions);
  const rowsY: number[] = [];
  for (let r = 0; cols > 0 && r < Math.floor(count / cols); r++) rowsY.push(positions[r * cols * 3 + 1]!);
  const at = (row: number, col: number): [number, number, number] => {
    const v = row * cols + col;
    return [positions[v * 3]!, positions[v * 3 + 1]!, positions[v * 3 + 2]!];
  };
  const faults: string[] = [];
  // top gap
  let topGap = 0;
  if (cols > 0) {
    const lo = Math.floor(cols * 0.1);
    const hi = Math.max(lo + 1, Math.ceil(cols * 0.9));
    for (let c = lo; c < hi; c++) {
      const [x, y, z] = at(0, c);
      let best = Infinity;
      for (let w = 0; w < upperWater.length / 3; w++) {
        const wy = upperWater[w * 3 + 1]!;
        if (Math.abs(wy - y) > 0.25) continue;
        best = Math.min(best, Math.hypot(upperWater[w * 3]! - x, upperWater[w * 3 + 2]! - z));
      }
      topGap = Math.max(topGap, best);
    }
  }
  if (topGap > maxTopGap) faults.push(`top gap ${Number.isFinite(topGap) ? topGap.toFixed(2) : "no upper water"} m to the river surface`);
  // face hug
  let faceGap = 0;
  let worstAt: [number, number, number] | null = null;
  let free = 0;
  let inRock = 0;
  let landsAbovePool = 0;
  let landed = 0;
  let overAir = 0;
  for (let c = 0; c < cols; c++) {
    let envelope = -Infinity;
    // judged from a metre under the bed at the lip down: above that the curtain is still the river's own depth
    const [tx, , tz] = at(0, c);
    let bed = probe.floor(tx - fall.dirX * 1, tz - fall.dirZ * 1, fall.top, fall.top - 40) ?? fall.bottom;
    // no river bed under the curtain's top (it starts out over the drop): judged from 3 m down, and counted
    if (bed < fall.bottom + 1) { overAir++; bed = fall.top - 3; }
    // points over the bed before the face begins (the water's own depth at the brink) have nothing behind them by
    // nature; a column with no rock behind it ANYWHERE is the floating curtain
    let freeAbove = 0;
    for (let r = 0; r < rowsY.length; r++) {
      const [x, y, z] = at(r, c);
      const drop = fall.top - y;
      if (drop < 1 || y > bed - 1 || y < fall.bottom + 0.5) continue; // the brink rows, the river's depth, the part in the pool
      if (solidAt(probe, x - fall.dirX * 0.1, y, z - fall.dirZ * 0.1) && solidAt(probe, x + fall.dirX * 0.1, y, z + fall.dirZ * 0.1)) {
        inRock++;
        landsAbovePool = Math.max(landsAbovePool, y - fall.bottom);
        continue;
      }
      const back = probe.wall?.(x, y, z, -fall.dirX, -fall.dirZ, reach) ?? null;
      if (back === null) {
        if (envelope === -Infinity) freeAbove++;
        else free++;
        continue;
      }
      const s = (x * fall.dirX + z * fall.dirZ);
      const face = s - back;
      envelope = Math.max(envelope, face);
      const gap = s - envelope;
      if (gap > faceGap) { faceGap = gap; worstAt = [x, y, z]; }
    }
    if (envelope === -Infinity) free += freeAbove;
    // where this column's water ends: a sheet lying on a ledge far above the pool lands on rock, not in the pool
    let lowest = Infinity;
    for (let r = 0; r < rowsY.length; r++) lowest = Math.min(lowest, at(r, c)[1]);
    if (lowest > fall.bottom + 1.5) { landed++; landsAbovePool = Math.max(landsAbovePool, lowest - fall.bottom); }
  }
  if (faceGap > maxFaceGap) faults.push(`face gap ${faceGap.toFixed(2)} m (curtain off its cliff)`);
  if (free > 0) faults.push(`${free} curtain point(s) with no rock within ${reach} m behind (floating)`);
  if (overAir > Math.max(1, cols * 0.2)) faults.push(`${overAir} column(s) start out over the drop with no river bed under the curtain's top`);
  if (inRock > 0) faults.push(`${inRock} curtain point(s) inside rock`);
  if (landed > 0) faults.push(`terrain: ledge in the drop — ${landed} column(s) land on rock up to ${landsAbovePool.toFixed(1)} m above the pool (fix the ground between lip and pool: fill the slot or cut the ledge; the curtain follows by itself)`);
  return { topGap, faceGap, worstAt, free, inRock, landsAbovePool, landed, rows: rowsY.length, faults };
}

// ------------------------------------------------------------------ shore foam on banks

/**
 * The water material's shore-foam gate by bed steepness (`shoreFoam.steep`, the up-component of the bed normal under
 * the water): foam is full on a bed flatter than the second value and gone on one steeper than the first. The render
 * (scene-builder buildWaterMaterial) gates its shoreline band with these thresholds; `worldgen water-edges` judges a
 * material by them. A band that lines steep banks draws flat pale strips a metre wide along every river bank and round
 * every rock (Skelmorrow's ochreburn pool, 2026-10-13).
 */
export const SHORE_FOAM_STEEP_DEFAULT: [number, number] = [0.55, 0.75];

/** Share of the shore foam a bank with this bed up-component (|normal.y|, 1 flat, 0 a wall) keeps. */
export function shoreFoamOnBank(bedUp: number, steep: readonly [number, number] = SHORE_FOAM_STEEP_DEFAULT): number {
  const lo = Math.min(steep[0], steep[1]), hi = Math.max(steep[1], steep[0] + 1e-3);
  const t = Math.min(1, Math.max(0, (bedUp - lo) / (hi - lo)));
  return t * t * (3 - 2 * t);
}

/**
 * Judge a water material's shore band against the banks it meets: `banks` are bed up-components sampled along the
 * water's outline (one per metre of shore). Returns the metres of steep bank (up-component under 0.6: steeper than
 * ~53 degrees) the band would line at half strength or more — the pale-strip fault. 0 for a material that gives steep
 * banks a wet line instead.
 */
export function foamLinedBank(water: { foamWidth?: number; shoreFoam?: { steep?: [number, number] } }, banks: readonly number[]): number {
  if ((water.foamWidth ?? 0.5) <= 0.001) return 0;
  const steep = water.shoreFoam?.steep ?? SHORE_FOAM_STEEP_DEFAULT;
  let lined = 0;
  for (const up of banks) if (up < 0.6 && shoreFoamOnBank(up, steep) >= 0.5) lined++;
  return lined;
}

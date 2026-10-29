/**
 * `worldgen coast <world>` — the coast PLAN (after continents, before rivers).
 *
 * Trace every landmass's shoreline (the field's shore distance 0) as a closed loop at ~24 m spacing, cut it into
 * segments at headland/bay inflections and where the exposure flips, give each segment ONE coast type from the zone's
 * `regions[].coast` rules (or the defaults) — sheer-cliff on exposed, steep-backed headlands; beaches and coves in
 * sheltered bays; mudflat only where a river mouth or a marsh meets the sea; rocky-shore and shingle in between — and
 * write the recipe so the EXISTING field solves it: a `terrain.seaCliffs` stretch (`coast-*`, with `endFade`) per run
 * of cliff segments, and `features.coastSegments` for everything (core coast-plan.ts: ruggedness, beach window,
 * mud paint, a pure function of (x, z)). No voxel is hand-edited and the coastline never moves.
 *
 *   --check               the gate only (no write): share per type within the zone's tolerance, no run of one type
 *                         longer than maxRun, beaches only on sheltered segments, at least one sheer-cliff and one
 *                         beach per coastal zone, every cliff segment has a stretch and no stretch is an orphan;
 *                         exit 1 with the failing rule named. Also the `coast` row of `worldgen status`.
 *   --step 8              sample grid of the shoreline trace (m)      --spacing 24   shoreline point spacing (m)
 *   --min-segment 120     shortest segment (m)                        --max-segment 420  longest (m)
 *   --wind <rad>          wind frame (default terrain.dunes.angle: where the wind blows TO)
 *   --fetch 1500          metres of open sea that make a segment exposed       --json  print the plan
 *
 * `worldgen map` draws the plan (one colour per type, numbered segments, a legend). `worldgen continents` drops it.
 */
import {
  COAST_DEFAULT_SHARES,
  COAST_TYPES,
  coastSegmentSchema,
  createWorldField,
  mulberry32,
  regionAt,
  regionCoastSchema,
  seaCliffSchema,
  type CoastSegmentDoc,
  type CoastType,
  type SeaCliffDoc,
  type WorldField,
  type WorldRecipe,
} from "@hitreg/core";
import { simplifyOpen } from "./worldgen-hydrology.mts";

// ------------------------------------------------------------------ shoreline

/**
 * Islets (w2-shape, 2026-10-29: `worldgen continents` lays 2-4 stacks / skerries off the capes): a loop shorter than
 * this that is not the largest is judged WITH the largest loop's group — a 400 m stack is all cliff and cannot carry its
 * own beach and share targets — and is exempt from the whole-loop max-run rule.
 */
export const ISLET_LOOP_M = 1500;

/** loop index -> the loop whose group it joins (islets join the largest loop; every other loop is its own). */
export function loopGroupOf(lengths: ReadonlyMap<number, number>): Map<number, number> {
  let main = -1, best = -1;
  for (const [i, m] of lengths) if (m > best) { best = m; main = i; }
  const out = new Map<number, number>();
  for (const [i, m] of lengths) out.set(i, i !== main && m < ISLET_LOOP_M ? main : i);
  return out;
}

export interface ShoreLoop {
  points: [number, number][];
  length: number;
}

/** Marching-squares cell cases: which two edges (T=0 top, R=1 right, B=2 bottom, L=3 left) each contour piece joins. */
const CASES: Record<number, [number, number][]> = {
  1: [[0, 3]], 2: [[0, 1]], 3: [[3, 1]], 4: [[1, 2]], 6: [[0, 2]], 7: [[3, 2]], 8: [[3, 2]],
  9: [[0, 2]], 11: [[1, 2]], 12: [[3, 1]], 13: [[0, 1]], 14: [[0, 3]],
};

/**
 * The 0-contour of `shore` (signed metres inland: > 0 land) over the square [-extent, extent] sampled every `step`
 * metres, as closed loops resampled to `spacing`. Cells past `skipRadius` from the origin are ignored (the world
 * limit is itself an inverted coast: a ring of "shore" round the edge of the world that is not a landmass).
 */
export function traceShorelines(shore: (x: number, z: number) => number, extent: number, step: number, spacing: number, skipRadius = Infinity): ShoreLoop[] {
  const n = Math.max(4, Math.round((extent * 2) / step) + 1);
  const s = new Float32Array(n * n);
  const skip2 = skipRadius * skipRadius;
  for (let iz = 0; iz < n; iz++) {
    const z = -extent + iz * step;
    for (let ix = 0; ix < n; ix++) {
      const x = -extent + ix * step;
      s[ix + iz * n] = x * x + z * z > skip2 ? NaN : shore(x, z);
    }
  }
  // edge ids: 2 * node + 0 = the horizontal edge from node (ix, iz) to (ix+1, iz); + 1 = the vertical one to (ix, iz+1)
  const edgeId = (ix: number, iz: number, side: number): number => {
    if (side === 0) return 2 * (ix + iz * n);
    if (side === 2) return 2 * (ix + (iz + 1) * n);
    if (side === 3) return 2 * (ix + iz * n) + 1;
    return 2 * (ix + 1 + iz * n) + 1;
  };
  const links = new Map<number, number[]>();
  const link = (a: number, b: number): void => {
    (links.get(a) ?? links.set(a, []).get(a)!).push(b);
    (links.get(b) ?? links.set(b, []).get(b)!).push(a);
  };
  for (let iz = 0; iz + 1 < n; iz++) {
    for (let ix = 0; ix + 1 < n; ix++) {
      const a = s[ix + iz * n]!, b = s[ix + 1 + iz * n]!, c = s[ix + 1 + (iz + 1) * n]!, d = s[ix + (iz + 1) * n]!;
      if (Number.isNaN(a) || Number.isNaN(b) || Number.isNaN(c) || Number.isNaN(d)) continue;
      const code = (a > 0 ? 1 : 0) | (b > 0 ? 2 : 0) | (c > 0 ? 4 : 0) | (d > 0 ? 8 : 0);
      if (code === 0 || code === 15) continue;
      let pairs: [number, number][];
      if (code === 5 || code === 10) {
        // saddle: the centre decides whether the two land corners connect
        const centreLand = (a + b + c + d) * 0.25 > 0;
        const landCorners = code === 5 ? [[0, 3], [1, 2]] : [[0, 1], [3, 2]];
        const seaCorners = code === 5 ? [[0, 1], [3, 2]] : [[0, 3], [1, 2]];
        pairs = (centreLand ? seaCorners : landCorners) as [number, number][];
      } else pairs = CASES[code]!;
      for (const [e0, e1] of pairs) link(edgeId(ix, iz, e0), edgeId(ix, iz, e1));
    }
  }
  const pointOf = (id: number): [number, number] => {
    const node = id >> 1, ix = node % n, iz = (node - ix) / n;
    const sa = s[node]!;
    if ((id & 1) === 0) {
      const sb = s[node + 1]!;
      const t = sa / (sa - sb);
      return [-extent + (ix + t) * step, -extent + iz * step];
    }
    const sb = s[node + n]!;
    const t = sa / (sa - sb);
    return [-extent + ix * step, -extent + (iz + t) * step];
  };
  const visited = new Set<number>();
  const loops: ShoreLoop[] = [];
  for (const start of links.keys()) {
    if (visited.has(start)) continue;
    const chain: [number, number][] = [];
    let prev = -1, cur = start, closed = false;
    for (;;) {
      visited.add(cur);
      chain.push(pointOf(cur));
      const next = (links.get(cur) ?? []).find((e) => e !== prev && !visited.has(e));
      if (next === undefined) {
        closed = (links.get(cur) ?? []).includes(start) && chain.length > 2;
        break;
      }
      prev = cur;
      cur = next;
    }
    if (!closed || chain.length < 8) continue;
    loops.push(resampleLoop(chain, spacing));
  }
  return loops.sort((p, q) => q.length - p.length);
}

/** A closed polyline resampled to about `spacing` metres between points (first point not repeated). */
export function resampleLoop(chain: readonly (readonly [number, number])[], spacing: number): ShoreLoop {
  const n = chain.length;
  const along = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) {
    const a = chain[i]!, b = chain[(i + 1) % n]!;
    along[i + 1] = along[i]! + Math.hypot(b[0] - a[0], b[1] - a[1]);
  }
  const length = along[n]!;
  const m = Math.max(6, Math.round(length / spacing));
  const points: [number, number][] = [];
  let i = 0;
  for (let k = 0; k < m; k++) {
    const t = (k * length) / m;
    while (i + 1 < n && along[i + 1]! < t) i++;
    const a = chain[i]!, b = chain[(i + 1) % n]!;
    const span = along[i + 1]! - along[i]!;
    const f = span > 1e-9 ? (t - along[i]!) / span : 0;
    points.push([a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f]);
  }
  return { points, length };
}

// ------------------------------------------------------------------ analysis

export interface ShorePoint {
  x: number;
  z: number;
  /** Outward (seaward) unit normal. */
  nx: number;
  nz: number;
  /** Metres the smoothed coast's chord midpoint lies seaward of the point: > 0 in a bay, < 0 on a headland. */
  bay: number;
  exposed: boolean;
  fetch: number;
  facing: number;
  slope: number;
  mud: boolean;
}

export interface ShoreContext {
  /** Signed metres inland of the coastline (the field's shore distance). */
  shore(x: number, z: number): number;
  /** The natural ground height. */
  height(x: number, z: number): number;
  /** Radians: where the wind blows TO (`terrain.dunes.angle`). */
  windTo: number;
  /** Metres of open sea along the normal that make a segment exposed. */
  fetchOpen: number;
  /** Beyond this radius from the origin the sea is open (the world limit's falloff starts). */
  outerRadius: number;
  /** A river mouth or marsh meets the sea near (x, z). */
  mud?(x: number, z: number): boolean;
}

const FETCH_MAX = 3000;
const FACING_COS = 0.5; // +-60 degrees

export function analyseLoop(loop: ShoreLoop, ctx: ShoreContext): ShorePoint[] {
  const pts = loop.points;
  const n = pts.length;
  const fromX = -Math.cos(ctx.windTo), fromZ = -Math.sin(ctx.windTo);
  // Gaussian-smoothed copy for the curvature sign (sigma 4 samples ~ 100 m at 24 m spacing)
  const sm: [number, number][] = [];
  const K = 10, sigma = 4;
  const kern: number[] = [];
  for (let k = -K; k <= K; k++) kern.push(Math.exp(-(k * k) / (2 * sigma * sigma)));
  const kSum = kern.reduce((a, b) => a + b, 0);
  for (let i = 0; i < n; i++) {
    let x = 0, z = 0;
    for (let k = -K; k <= K; k++) {
      const p = pts[(i + k + n * 4) % n]!;
      x += p[0] * kern[k + K]!;
      z += p[1] * kern[k + K]!;
    }
    sm.push([x / kSum, z / kSum]);
  }
  const out: ShorePoint[] = [];
  const e = 6;
  for (let i = 0; i < n; i++) {
    const [x, z] = pts[i]!;
    const gx = ctx.shore(x + e, z) - ctx.shore(x - e, z);
    const gz = ctx.shore(x, z + e) - ctx.shore(x, z - e);
    const g = Math.hypot(gx, gz);
    let nx: number, nz: number;
    if (g >= 1e-6) { nx = -gx / g; nz = -gz / g; }
    else {
      // flat: the loop's own normal, on the side where the shore distance is lower
      const a = pts[(i + n - 1) % n]!, b = pts[(i + 1) % n]!;
      const tx = b[0] - a[0], tz = b[1] - a[1], tl = Math.hypot(tx, tz) || 1;
      nx = -tz / tl; nz = tx / tl;
      if (ctx.shore(x + nx * e, z + nz * e) > ctx.shore(x - nx * e, z - nz * e)) { nx = -nx; nz = -nz; }
    }
    const C = 6;
    const pa = sm[(i + n - C) % n]!, pb = sm[(i + C) % n]!, pm = sm[i]!;
    const bay = nx * ((pa[0] + pb[0]) * 0.5 - pm[0]) + nz * ((pa[1] + pb[1]) * 0.5 - pm[1]);
    // fetch: open sea along the normal until land or the world's edge
    let fetch = FETCH_MAX;
    for (let t = 10; t <= FETCH_MAX; t += 25) {
      const px = x + nx * t, pz = z + nz * t;
      if (px * px + pz * pz > ctx.outerRadius * ctx.outerRadius) break;
      if (ctx.shore(px, pz) > 0) { fetch = t; break; }
    }
    const facing = nx * fromX + nz * fromZ;
    // slope behind: the ground 40..120 m inland
    let slope = 0;
    let prevH = ctx.height(x - nx * 40, z - nz * 40);
    for (let d = 60; d <= 120; d += 20) {
      const h = ctx.height(x - nx * d, z - nz * d);
      slope += Math.abs(h - prevH) / 20;
      prevH = h;
    }
    slope /= 4;
    out.push({ x, z, nx, nz, bay, exposed: facing >= FACING_COS && fetch >= ctx.fetchOpen, fetch, facing, slope, mud: ctx.mud?.(x - nx * 30, z - nz * 30) ?? false });
  }
  // smooth the bay measure a little (box +-3) so a single kink does not cut a segment
  const bays = out.map((p) => p.bay);
  for (let i = 0; i < n; i++) {
    let sum = 0;
    for (let k = -3; k <= 3; k++) sum += bays[(i + k + n) % n]!;
    out[i]!.bay = sum / 7;
  }
  return out;
}

export interface SegmentCut {
  start: number;
  count: number;
}

/**
 * Cut a loop at the inflections of the smoothed curvature (headland <-> bay) and wherever the exposure flips; merge
 * pieces shorter than `minLength` into a neighbour; split pieces longer than `maxLength` into equal parts.
 */
export function cutSegments(points: ShorePoint[], spacing: number, minLength: number, maxLength: number): SegmentCut[] {
  const n = points.length;
  if (n === 0) return [];
  const exposed = points.map((_, i) => {
    let c = 0;
    for (let k = -3; k <= 3; k++) if (points[(i + k + n) % n]!.exposed) c++;
    return c >= 4;
  });
  const BAY_HYST = 3;
  const bayLabel: number[] = new Array(n).fill(0);
  let last = 0;
  for (let i = 0; i < n; i++) { const b = points[i]!.bay; if (Math.abs(b) >= BAY_HYST) last = Math.sign(b); }
  for (let i = 0; i < n; i++) {
    const b = points[i]!.bay;
    if (Math.abs(b) >= BAY_HYST) last = Math.sign(b);
    bayLabel[i] = last;
  }
  const label = (i: number): number => bayLabel[i]! * 2 + (exposed[i] ? 1 : 0);
  const boundaries: number[] = [];
  for (let i = 0; i < n; i++) if (label(i) !== label((i + n - 1) % n)) boundaries.push(i);
  if (boundaries.length === 0) boundaries.push(0);
  let cuts: SegmentCut[] = boundaries.map((b, k) => {
    const next = boundaries[(k + 1) % boundaries.length]!;
    const count = k + 1 < boundaries.length ? next - b : n - b + next;
    return { start: b, count };
  });
  const len = (c: SegmentCut): number => c.count * spacing;
  // merge short pieces into the shorter neighbour (wrapping)
  for (let guard = 0; guard < n && cuts.length > 1; guard++) {
    let k = -1, shortest = Infinity;
    cuts.forEach((c, i) => { if (len(c) < minLength && len(c) < shortest) { shortest = len(c); k = i; } });
    if (k < 0) break;
    const m = cuts.length;
    const prev = (k + m - 1) % m, next = (k + 1) % m;
    const into = len(cuts[prev]!) <= len(cuts[next]!) ? prev : next;
    if (into === prev) cuts[prev]!.count += cuts[k]!.count;
    else { cuts[next]!.start = cuts[k]!.start; cuts[next]!.count += cuts[k]!.count; }
    cuts.splice(k, 1);
  }
  // split long pieces
  const split: SegmentCut[] = [];
  for (const c of cuts) {
    const parts = Math.max(1, Math.ceil(len(c) / maxLength));
    let at = c.start, left = c.count;
    for (let p = 0; p < parts; p++) {
      const count = Math.round(left / (parts - p));
      split.push({ start: at % n, count });
      at += count;
      left -= count;
    }
  }
  // in loop order from the smallest start
  const first = split.reduce((b, c, i) => (c.start < split[b]!.start ? i : b), 0);
  cuts = [...split.slice(first), ...split.slice(0, first)];
  return cuts.filter((c) => c.count > 0);
}

export interface SegmentInfo {
  loop: number;
  index: number;
  points: [number, number][];
  length: number;
  exposure: "exposed" | "sheltered";
  fetch: number;
  facing: number;
  slopeBehind: number;
  concave: boolean;
  mud: boolean;
  /** Strongest climate anchor BEHIND_M inland (majority over the segment's points), when the recipe has zones. */
  behind?: string;
}

/** Metres inland of the shoreline the biome behind a segment is read. */
export const BEHIND_M = 80;
/** Metres inland of the lip the cliff TOP's biome is read for the cliff-rock rule. */
export const TOP_M = 20;

export function describeSegments(loop: number, points: ShorePoint[], cuts: SegmentCut[], spacing: number, zoneAt?: (x: number, z: number) => string): SegmentInfo[] {
  const n = points.length;
  return cuts.map((c, index) => {
    const pts: [number, number][] = [];
    let exposed = 0, fetch = 0, facing = 0, slope = 0, bay = 0, mud = false;
    const behindVotes = new Map<string, number>();
    for (let k = 0; k <= c.count; k++) {
      const p = points[(c.start + k) % n]!;
      pts.push([round(p.x), round(p.z)]);
      if (k === c.count) break;
      if (zoneAt) {
        const id = zoneAt(p.x - p.nx * BEHIND_M, p.z - p.nz * BEHIND_M);
        if (id) behindVotes.set(id, (behindVotes.get(id) ?? 0) + 1);
      }
      if (p.exposed) exposed++;
      fetch += p.fetch; facing += p.facing; slope += p.slope; bay += p.bay;
      mud ||= p.mud;
    }
    const m = c.count;
    return {
      loop,
      index,
      points: pts,
      length: round(c.count * spacing),
      exposure: exposed * 2 >= m ? "exposed" : "sheltered",
      fetch: round(fetch / m),
      facing: round(facing / m, 3),
      slopeBehind: round(slope / m, 3),
      concave: bay / m > 0,
      mud,
      ...(behindVotes.size ? { behind: [...behindVotes.entries()].sort((a, b) => b[1] - a[1])[0]![0] } : {}),
    };
  });
}

// ------------------------------------------------------------------ assignment

export interface CoastRules {
  allowed: CoastType[];
  shares: Partial<Record<CoastType, number>>;
  tolerance: number;
  maxRun: number;
}
export const DEFAULT_COAST_RULES: CoastRules = regionCoastSchema.parse({});

/** Slope behind the shore (rise/run) from which a sheltered segment may still be a cliff. */
export const CLIFF_SLOPE = 0.15;
/** Longest segment that can be a cove. */
export const COVE_MAX_LENGTH = 320;

type SegLike = Pick<SegmentInfo, "exposure" | "slopeBehind" | "concave" | "mud" | "length">;

/** Could this segment be that type at all? The hard rules of the plan (the gate checks them on the written plan). */
export function eligible(seg: SegLike, type: CoastType): boolean {
  switch (type) {
    case "sheer-cliff": return seg.exposure === "exposed" || seg.slopeBehind >= CLIFF_SLOPE;
    case "sand-beach": return seg.exposure === "sheltered";
    case "cove": return seg.exposure === "sheltered" && seg.concave && seg.length <= COVE_MAX_LENGTH;
    case "mudflat": return seg.mud;
    default: return true;
  }
}

/**
 * Target share per type for a group of segments: the rules' shares (defaults filled in, 0 when not allowed),
 * capped at the eligible length share of each type and renormalised to 1 over the types that have any eligible
 * segment. Shared by the assignment and the gate so they agree.
 */
export function targetShares(segs: readonly SegLike[], rules: CoastRules): Record<CoastType, number> {
  const total = segs.reduce((a, s) => a + s.length, 0) || 1;
  const raw: Record<CoastType, number> = { ...COAST_DEFAULT_SHARES };
  for (const t of COAST_TYPES) {
    if (!rules.allowed.includes(t)) raw[t] = 0;
    else if (rules.shares[t] !== undefined) raw[t] = rules.shares[t]!;
    const elig = segs.filter((s) => eligible(s, t)).reduce((a, s) => a + s.length, 0) / total;
    raw[t] = Math.min(raw[t], elig);
  }
  const sum = COAST_TYPES.reduce((a, t) => a + raw[t], 0);
  if (sum <= 0) return raw;
  for (const t of COAST_TYPES) raw[t] = raw[t] / sum;
  return raw;
}

function score(seg: SegmentInfo, type: CoastType): number {
  const s = seg.slopeBehind, ex = seg.exposure === "exposed", cc = seg.concave;
  switch (type) {
    case "sheer-cliff": return (ex ? 0.55 : 0.1) + Math.min(0.45, s * 2) + (cc ? -0.15 : 0.15);
    case "rocky-shore": return 0.35 + (ex ? 0.2 : 0) + Math.min(0.25, s) + (cc ? -0.05 : 0.05);
    case "shingle": return 0.35 + (ex ? 0 : 0.1) + (0.2 - Math.min(0.2, s));
    case "sand-beach": return 0.4 + (cc ? 0.25 : 0) + (0.25 - Math.min(0.25, s * 1.5));
    case "cove": return 0.45 + 0.2 * (1 - seg.length / COVE_MAX_LENGTH) + (0.2 - Math.min(0.2, s));
    case "mudflat": return 0.9;
  }
}

export interface AssignGroup {
  key: string;
  rules: CoastRules;
  segs: SegmentInfo[];
}

/**
 * One type per segment. Greedy by (score x how far the type is under its target), seeded jitter, never a run of one
 * type over the rules' maxRun along the loop; then a repair pass (every group gets a cliff and a beach when it can)
 * and a balance pass (flip segments from over-target types to under-target ones while a flip helps).
 */
export function assignCoastTypes(groups: AssignGroup[], loops: SegmentInfo[][], seed: number): Map<SegmentInfo, { type: CoastType; reason: string }> {
  const random = mulberry32(seed);
  const jitter = new Map<SegmentInfo, Record<CoastType, number>>();
  const out = new Map<SegmentInfo, { type: CoastType; reason: string }>();
  for (const g of groups) for (const s of g.segs) {
    const j = {} as Record<CoastType, number>;
    for (const t of COAST_TYPES) j[t] = (random() - 0.5) * 0.24;
    jitter.set(s, j);
  }
  const groupOf = new Map<SegmentInfo, AssignGroup>();
  for (const g of groups) for (const s of g.segs) groupOf.set(s, g);
  const typeOf = (s: SegmentInfo): CoastType | undefined => out.get(s)?.type;
  /** Metres of `type` that would run through `seg` if it took the type (its own length plus same-typed neighbours). */
  const runWith = (seg: SegmentInfo, type: CoastType): number => {
    const loop = loops[seg.loop]!;
    const n = loop.length;
    let run = seg.length;
    for (let k = 1; k < n; k++) { const o = loop[(seg.index + k) % n]!; if (typeOf(o) !== type) break; run += o.length; }
    for (let k = 1; k < n; k++) { const o = loop[(seg.index - k + n) % n]!; if (typeOf(o) !== type) break; run += o.length; }
    return run;
  };
  const shareOf = (g: AssignGroup, type: CoastType): number => {
    const total = g.segs.reduce((a, s) => a + s.length, 0) || 1;
    return g.segs.filter((s) => typeOf(s) === type).reduce((a, s) => a + s.length, 0) / total;
  };
  const targets = new Map(groups.map((g) => [g, targetShares(g.segs, g.rules)] as const));
  const fits = (s: SegmentInfo, t: CoastType, g: AssignGroup): boolean => g.rules.allowed.includes(t) && targets.get(g)![t] > 0 && eligible(s, t) && runWith(s, t) <= g.rules.maxRun;
  /** Would taking `s` away from its type empty the group's cliffs or its beaches (sand-beach + cove) without `t` keeping the class? */
  const lastOfKind = (g: AssignGroup, s: SegmentInfo, t: CoastType): boolean => {
    const cur = typeOf(s)!;
    const cls = (x: CoastType): "cliff" | "beach" | null => (x === "sheer-cliff" ? "cliff" : x === "sand-beach" || x === "cove" ? "beach" : null);
    const c = cls(cur);
    if (c === null || cls(t) === c) return false;
    return g.segs.filter((o) => cls(typeOf(o) ?? "rocky-shore") === c).length === 1;
  };
  // greedy
  for (;;) {
    let best: { s: SegmentInfo; t: CoastType; v: number } | null = null;
    for (const g of groups) {
      const target = targets.get(g)!;
      for (const s of g.segs) {
        if (out.has(s)) continue;
        for (const t of COAST_TYPES) {
          if (!fits(s, t, g)) continue;
          const need = target[t] <= 0 ? 0.02 : Math.max(0.05, (target[t] - shareOf(g, t)) / target[t]);
          const v = (score(s, t) + jitter.get(s)![t]) * need;
          if (!best || v > best.v) best = { s, t, v };
        }
      }
    }
    if (!best) break;
    out.set(best.s, { type: best.t, reason: reasonFor(best.s, best.t) });
  }
  // anything left (every type blocked by maxRun): the allowed type with the shortest resulting run
  for (const g of groups) for (const s of g.segs) {
    if (out.has(s)) continue;
    const t = [...COAST_TYPES].filter((x) => g.rules.allowed.includes(x) && eligible(s, x)).sort((a, b) => runWith(s, a) - runWith(s, b))[0] ?? "rocky-shore";
    out.set(s, { type: t, reason: `${reasonFor(s, t)}; every type over maxRun here, shortest run taken` });
  }
  // repair: a cliff and a beach per group
  for (const g of groups) {
    for (const want of [["sheer-cliff"], ["sand-beach", "cove"]] as CoastType[][]) {
      if (g.segs.some((s) => want.includes(typeOf(s)!))) continue;
      let best: { s: SegmentInfo; t: CoastType; v: number } | null = null;
      for (const s of g.segs) for (const t of want) {
        if (!g.rules.allowed.includes(t) || !eligible(s, t) || runWith(s, t) > g.rules.maxRun || lastOfKind(g, s, t)) continue;
        const v = score(s, t) + jitter.get(s)![t];
        if (!best || v > best.v) best = { s, t, v };
      }
      if (best) out.set(best.s, { type: best.t, reason: `${reasonFor(best.s, best.t)}; the zone needed one` });
    }
  }
  // balance toward the targets
  for (let round = 0; round < 40; round++) {
    let flipped = false;
    for (const g of groups) {
      const target = targets.get(g)!;
      const over = COAST_TYPES.filter((t) => shareOf(g, t) > target[t] + g.rules.tolerance * 0.5);
      const under = COAST_TYPES.filter((t) => shareOf(g, t) < target[t] - g.rules.tolerance * 0.5);
      if (!over.length || !under.length) continue;
      let best: { s: SegmentInfo; t: CoastType; v: number } | null = null;
      for (const s of g.segs) {
        const cur = typeOf(s)!;
        if (!over.includes(cur)) continue;
        for (const t of under) {
          if (!fits(s, t, g)) continue;
          // the flip must not overshoot the target or empty a required type
          if (shareOf(g, t) + s.length / (g.segs.reduce((a, o) => a + o.length, 0) || 1) > target[t] + g.rules.tolerance * 0.5) continue;
          if (lastOfKind(g, s, t)) continue;
          const v = score(s, t) + jitter.get(s)![t] - score(s, cur);
          if (!best || v > best.v) best = { s, t, v };
        }
      }
      if (best) { out.set(best.s, { type: best.t, reason: `${reasonFor(best.s, best.t)}; balanced toward the target shares` }); flipped = true; }
    }
    if (!flipped) break;
  }
  return out;
}

function reasonFor(s: SegmentInfo, t: CoastType): string {
  const where = `${s.exposure}, fetch ${s.fetch} m, slope behind ${s.slopeBehind}, ${s.concave ? "bay" : "headland"}`;
  switch (t) {
    case "sheer-cliff": return `cliff: ${where}`;
    case "cove": return `cove: short sheltered bay (${s.length} m), ${where}`;
    case "sand-beach": return `beach: sheltered${s.concave ? " bay" : ""}, ${where}`;
    case "mudflat": return `mudflat: a river mouth or marsh meets the sea, ${where}`;
    default: return `${t}: ${where}`;
  }
}

// ------------------------------------------------------------------ the plan -> recipe

export interface CoastPlanOptions {
  step: number;
  spacing: number;
  minSegment: number;
  maxSegment: number;
  windTo?: number;
  fetchOpen: number;
}
export const DEFAULT_PLAN_OPTIONS: CoastPlanOptions = { step: 8, spacing: 24, minSegment: 120, maxSegment: 420, fetchOpen: 1500 };

/** The stage's own outputs stripped: what it plans ON. */
export function withoutCoastPlan(recipe: WorldRecipe): WorldRecipe {
  const terrain = { ...recipe.terrain, seaCliffs: (recipe.terrain.seaCliffs ?? []).filter((s) => !(s.id ?? "").startsWith("coast-")) };
  if (terrain.seaCliffs.length === 0) delete (terrain as { seaCliffs?: unknown }).seaCliffs;
  const features = { ...recipe.features };
  delete features.coastSegments;
  return { ...recipe, terrain, features };
}

export function rulesFor(recipe: WorldRecipe, x: number, z: number): { key: string; region?: string; rules: CoastRules } {
  const r = regionAt(recipe.regions, x, z);
  const region = r && !r.within ? r : r?.within ? recipe.regions.find((g) => g.id === r.within) ?? r : null;
  if (!region) return { key: "", rules: DEFAULT_COAST_RULES };
  return { key: region.id, region: region.id, rules: region.coast ?? DEFAULT_COAST_RULES };
}

export interface CoastPlanResult {
  segments: CoastSegmentDoc[];
  stretches: SeaCliffDoc[];
  loops: ShoreLoop[];
  log: string[];
}

/** Plan the coast of `recipe` (its own plan stripped first) and return the docs to write. */
export function planCoast(recipe: WorldRecipe, opts: CoastPlanOptions = DEFAULT_PLAN_OPTIONS): CoastPlanResult {
  // level tops asked for by `coast-top` survive a re-run by segment id (the trace is deterministic for the same shore)
  const previousTops = new Map((recipe.features.coastSegments ?? []).filter((s) => s.topEdge).map((s) => [s.id, s.topEdge!]));
  const natural = withoutCoastPlan(recipe);
  const field: WorldField = createWorldField(natural);
  const limit = recipe.bounds?.limit ?? Infinity;
  const limitFalloff = recipe.bounds?.limitFalloff ?? 600;
  const extent = limit === Infinity ? 3000 : limit;
  const skipRadius = limit === Infinity ? Infinity : limit - limitFalloff - 100;
  const log: string[] = [];
  const t0 = Date.now();
  const loops = traceShorelines((x, z) => field.shoreDistance(x, z), extent, opts.step, opts.spacing, skipRadius);
  log.push(`shoreline: ${loops.length} loop(s) ${loops.map((l) => `${(l.length / 1000).toFixed(2)} km`).join(", ")} (${opts.step} m grid, ${opts.spacing} m spacing, ${((Date.now() - t0) / 1000).toFixed(1)} s)`);
  const windTo = opts.windTo ?? recipe.terrain.dunes.angle;
  const mouths = recipe.features.rivers.map((r) => r.points[r.points.length - 1]!);
  const ctx: ShoreContext = {
    shore: (x, z) => field.shoreDistance(x, z),
    height: (x, z) => field.height(x, z),
    windTo,
    fetchOpen: opts.fetchOpen,
    outerRadius: skipRadius,
    mud: (x, z) => field.marshTable(x, z) !== null || mouths.some((m) => Math.hypot(m[0] - x, m[1] - z) < 150),
  };
  const segments: CoastSegmentDoc[] = [];
  const stretches: SeaCliffDoc[] = [];
  const infos: SegmentInfo[][] = [];
  loops.forEach((loop, li) => {
    const pts = analyseLoop(loop, ctx);
    const cuts = cutSegments(pts, opts.spacing, opts.minSegment, opts.maxSegment);
    infos.push(describeSegments(li, pts, cuts, opts.spacing, recipe.climate.zones ? (x, z) => field.zone(x, z).id : undefined));
  });
  // groups by zone rules (the region under the segment's midpoint; no regions yet = one group per loop)
  const groups = new Map<string, AssignGroup>();
  const regionOf = new Map<SegmentInfo, string | undefined>();
  const loopGroup = loopGroupOf(new Map(loops.map((l, i) => [i, l.length] as const)));
  for (const loop of infos) for (const s of loop) {
    const mid = s.points[Math.floor(s.points.length / 2)]!;
    const r = rulesFor(recipe, mid[0], mid[1]);
    const key = r.key || `loop-${loopGroup.get(s.loop) ?? s.loop}`;
    regionOf.set(s, r.region);
    (groups.get(key) ?? groups.set(key, { key, rules: r.rules, segs: [] }).get(key)!).segs.push(s);
  }
  const assigned = assignCoastTypes([...groups.values()], infos, recipe.seed ^ 0xc0a57);
  const exposedShare = infos.flat().filter((s) => s.exposure === "exposed").reduce((a, s) => a + s.length, 0) / (infos.flat().reduce((a, s) => a + s.length, 0) || 1);
  log.push(`wind to ${windTo.toFixed(2)} rad (from ${((((windTo + Math.PI) * 180) / Math.PI) % 360).toFixed(0)} deg of +x); ${Math.round(exposedShare * 100)} % of the shore exposed (fetch >= ${opts.fetchOpen} m, facing within 60 deg)`);
  infos.forEach((loop, li) => {
    // one stretch per run of cliff segments (wrapping), so neighbouring stretches never fade into each other
    const n = loop.length;
    const typeAt = (i: number): CoastType => assigned.get(loop[(i + n) % n]!)!.type;
    let first = 0;
    while (first < n && typeAt(first) === "sheer-cliff" && typeAt(first - 1) === "sheer-cliff") first++;
    if (first === n) first = 0; // the whole loop is cliff
    const stretchOf = new Map<SegmentInfo, string>();
    let runNo = 0;
    for (let k = 0; k < n; ) {
      const i = (first + k) % n;
      if (typeAt(i) !== "sheer-cliff") { k++; continue; }
      const run: SegmentInfo[] = [];
      while (k < n && typeAt((first + k) % n) === "sheer-cliff") { run.push(loop[(first + k) % n]!); k++; }
      const id = `coast-${li}-${runNo++}`;
      const along: [number, number][] = [];
      for (const s of run) for (const p of s.points) if (!along.length || Math.hypot(p[0] - along[along.length - 1]![0], p[1] - along[along.length - 1]![1]) > 1) along.push(p);
      const runLength = run.reduce((a, s) => a + s.length, 0);
      const slope = run.reduce((a, s) => a + s.slopeBehind * s.length, 0) / runLength;
      const exposed = run.some((s) => s.exposure === "exposed");
      const lo = Math.round(Math.min(90, Math.max(35, 35 + slope * 250)));
      const hi = Math.round(Math.min(140, Math.max(lo + 15, lo * 1.5)));
      const topEdge = Math.max(0, ...run.map((s) => previousTops.get(`cs-${li}-${s.index}`) ?? 0));
      // reach covers the top's inland join (edge + inland) and the stacks offshore ACROSS the polyline; endFade ends
      // the wall where the run ends, so the beach next door is not held under a cliff
      stretches.push(seaCliffSchema.parse({
        id,
        along: simplifyOpen(along, 6),
        reach: 300,
        fade: 100,
        endFade: Math.round(Math.min(90, Math.max(30, runLength * 0.2))),
        height: [lo, hi],
        heightScale: 600,
        edge: topEdge > 0 ? topEdge : 30,
        ...(topEdge > 0 ? { undulation: LEVEL_TOP_UNDULATION } : {}),
        inland: Math.round(Math.min(240, Math.max(120, runLength * 0.5))),
        stacks: { density: exposed ? 0.3 : 0.15, offshore: [20, 120] },
        seed: li * 100 + runNo,
      }));
      for (const s of run) stretchOf.set(s, id);
    }
    for (const s of loop) {
      const a = assigned.get(s)!;
      segments.push(coastSegmentSchema.parse({
        id: `cs-${li}-${s.index}`,
        type: a.type,
        points: s.points,
        loop: li,
        exposure: s.exposure,
        fetch: s.fetch,
        facing: s.facing,
        slopeBehind: s.slopeBehind,
        concave: s.concave,
        mud: s.mud,
        length: s.length,
        ...(regionOf.get(s) ? { region: regionOf.get(s) } : {}),
        ...(stretchOf.has(s) ? { stretch: stretchOf.get(s) } : {}),
        ...(s.behind ? { behind: s.behind } : {}),
        reach: 140,
        ...(previousTops.has(`cs-${li}-${s.index}`) && a.type === "sheer-cliff" ? { topEdge: previousTops.get(`cs-${li}-${s.index}`) } : {}),
        reason: a.reason,
      }));
    }
  });
  return { segments, stretches, loops, log };
}

// ------------------------------------------------------------------ level tops (coast-top)

/** Metres of gentle relief left on a level top asked for by `coast-top` (the default 1.6 breaks a 120 m square). */
export const LEVEL_TOP_UNDULATION = 0.5;

export interface FlatTop {
  /** Side of the largest square of ground with slope < 0.3 and height within 10 m of its centre (m). */
  side: number;
  at: [number, number];
  top: number;
}

/**
 * The largest flat square on the cliff top behind a segment: centres 20 m to `depth` m inland of every other shoreline
 * point, a square grown 20 m at a time while every 10 m sample stays above the sea, within 10 m of the centre's height
 * and under slope 0.3 (17 degrees; a POI pad patch levels the rest).
 */
export function measureFlatTop(field: WorldField, seg: CoastSegmentDoc, depth: number, seaLevel: number): FlatTop {
  const square = (x0: number, z0: number): number => {
    const hc = field.ground(x0, z0);
    let half = 10;
    while (half <= 200) {
      let ok = true;
      for (let x = x0 - half; x <= x0 + half && ok; x += 10) for (let z = z0 - half; z <= z0 + half; z += 10) {
        const h = field.ground(x, z);
        if (h < seaLevel + 2 || Math.abs(h - hc) > 10 || field.slope(x, z) > 0.3) { ok = false; break; }
      }
      if (!ok) break;
      half += 10;
    }
    return (half - 10) * 2;
  };
  let best: FlatTop = { side: 0, at: [seg.points[0]![0], seg.points[0]![1]], top: 0 };
  for (let i = 0; i < seg.points.length; i += 2) {
    const [px, pz] = seg.points[i]!;
    const e = 6;
    const gx = field.shoreDistance(px + e, pz) - field.shoreDistance(px - e, pz), gz = field.shoreDistance(px, pz + e) - field.shoreDistance(px, pz - e);
    const g = Math.hypot(gx, gz) || 1;
    for (let d = 20; d <= depth; d += 20) {
      const x = px + (gx / g) * d, z = pz + (gz / g) * d;
      const side = square(x, z);
      if (side > best.side) best = { side, at: [Math.round(x), Math.round(z)], top: Math.round(field.ground(x, z) * 10) / 10 };
    }
  }
  return best;
}

/**
 * `worldgen coast-top <world> --segment <cs-id> --edge <m> [--undulation 0.5] [--measure]`: a LEVEL cliff top for a
 * landmark. The stretch that builds the segment's wall keeps its level top `edge` metres inland of the lip (default 30)
 * with `undulation` metres of relief; the segment records `topEdge` so a re-run of `coast` keeps it. The flat square is
 * measured on the field before and after (`--measure` only reports). Its own late stamp (`coast-top`): the coastline and
 * nothing upstream moves, so rivers, towns and zones stay as they are.
 */
export function commandCoastTop(host: CoastHost): void {
  const { argv } = host;
  const opt = (name: string): string | undefined => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : undefined; };
  const { recipe, file } = host.loadRecipe();
  const id = opt("segment");
  const seg = (recipe.features.coastSegments ?? []).find((s) => s.id === id);
  if (!seg) host.fail(`--segment <id>: ${id ?? "none given"}; the plan has ${(recipe.features.coastSegments ?? []).map((s) => s.id).join(", ") || "no segments (run worldgen coast)"}`);
  if (seg.type !== "sheer-cliff" || !seg.stretch) host.fail(`${seg.id} is ${seg.type}: a level top belongs to a sheer-cliff segment and its stretch`);
  const stretch = (recipe.terrain.seaCliffs ?? []).find((s) => s.id === seg.stretch);
  if (!stretch) host.fail(`${seg.id} names stretch ${seg.stretch} which is not in terrain.seaCliffs (worldgen coast --check)`);
  const before = measureFlatTop(createWorldField(recipe), seg, Math.max(stretch.edge, 160), recipe.seaLevel);
  console.log(`  ${seg.id} (${stretch.id}, edge ${stretch.edge} m, undulation ${stretch.undulation} m): flat square ${before.side} m at [${before.at.join(", ")}], top ${before.top} m`);
  if (argv.includes("--measure")) return;
  const edge = Number(opt("edge"));
  if (!Number.isFinite(edge) || edge < 16) host.fail("--edge <metres> (>= 16): how far the level top runs inland of the lip");
  const undulation = Number(opt("undulation") ?? LEVEL_TOP_UNDULATION);
  stretch.edge = edge;
  stretch.undulation = undulation;
  // the stretch must hold the whole top: reach covers edge + the back-slope
  if (stretch.reach < edge + stretch.inland * 0.5) stretch.reach = Math.round(edge + stretch.inland * 0.5);
  seg.topEdge = edge;
  const after = measureFlatTop(createWorldField(recipe), seg, Math.max(edge, 160), recipe.seaLevel);
  console.log(`  -> edge ${edge} m, undulation ${undulation} m: flat square ${after.side} m at [${after.at.join(", ")}], top ${after.top} m`);
  host.writeRecipe(recipe, file);
}

// ------------------------------------------------------------------ the gate

export interface CoastGateReport {
  ok: boolean;
  findings: { rule: string; detail: string }[];
  /** Per group (zone or loop): share by type, its target and tolerance. */
  shares: Record<string, { share: Record<CoastType, number>; target: Record<CoastType, number>; tolerance: number; metres: number }>;
  longestRun: { type: CoastType; metres: number; from: string } | null;
  segments: number;
  /** Level tops asked for by `coast-top`, measured on the field (only when the gate builds the field). */
  flatTops: { segment: string; side: number; at: [number, number]; top: number }[];
}

export function checkCoastPlan(recipe: WorldRecipe, opts: { measureTops?: boolean } = {}): CoastGateReport {
  const docs = recipe.features.coastSegments ?? [];
  const findings: CoastGateReport["findings"] = [];
  const shares: CoastGateReport["shares"] = {};
  const flatTops: CoastGateReport["flatTops"] = [];
  if (docs.length === 0) return { ok: false, findings: [{ rule: "no-plan", detail: "no coast plan: run worldgen coast" }], shares, longestRun: null, segments: 0, flatTops };
  const groups = new Map<string, { rules: CoastRules; segs: CoastSegmentDoc[] }>();
  const loopMetres = new Map<number, number>();
  for (const s of docs) loopMetres.set(s.loop, (loopMetres.get(s.loop) ?? 0) + s.length);
  const groupLoop = loopGroupOf(loopMetres);
  for (const s of docs) {
    const region = s.region ? recipe.regions.find((r) => r.id === s.region) : null;
    const key = s.region ?? `loop-${groupLoop.get(s.loop) ?? s.loop}`;
    const rules = region?.coast ?? DEFAULT_COAST_RULES;
    (groups.get(key) ?? groups.set(key, { rules, segs: [] }).get(key)!).segs.push(s);
  }
  for (const [key, g] of groups) {
    const total = g.segs.reduce((a, s) => a + s.length, 0) || 1;
    const target = targetShares(g.segs, g.rules);
    const share = {} as Record<CoastType, number>;
    for (const t of COAST_TYPES) share[t] = g.segs.filter((s) => s.type === t).reduce((a, s) => a + s.length, 0) / total;
    shares[key] = { share, target, tolerance: g.rules.tolerance, metres: Math.round(total) };
    for (const t of COAST_TYPES) {
      if (!g.rules.allowed.includes(t) && share[t] > 0) findings.push({ rule: "type-not-allowed", detail: `${key}: ${t} is not in the zone's allowed list but covers ${pct(share[t])}` });
      else if (Math.abs(share[t] - target[t]) > g.rules.tolerance + 1e-9) findings.push({ rule: "share", detail: `${key}: ${t} ${pct(share[t])} of the shore, target ${pct(target[t])} +- ${pct(g.rules.tolerance)}` });
    }
    if (!g.segs.some((s) => s.type === "sheer-cliff")) findings.push({ rule: "zone-needs-cliff", detail: `${key}: no sheer-cliff segment${g.segs.some((s) => eligible(s, "sheer-cliff")) ? "" : " (no exposed or steep-backed segment to put one on)"}` });
    if (!g.segs.some((s) => s.type === "sand-beach" || s.type === "cove")) findings.push({ rule: "zone-needs-beach", detail: `${key}: no sand-beach or cove segment${g.segs.some((s) => eligible(s, "sand-beach")) ? "" : " (no sheltered segment to put one on)"}` });
  }
  for (const s of docs) {
    if ((s.type === "sand-beach" || s.type === "cove") && s.exposure !== "sheltered") findings.push({ rule: "beach-exposed", detail: `${s.id}: ${s.type} on an exposed segment (fetch ${s.fetch} m, facing ${s.facing})` });
    if (s.type === "cove" && !(s.concave && s.length <= COVE_MAX_LENGTH)) findings.push({ rule: "beach-exposed", detail: `${s.id}: cove on a ${s.concave ? "" : "headland "}segment of ${s.length} m (a cove is a concave segment <= ${COVE_MAX_LENGTH} m)` });
    if (s.type === "mudflat" && !s.mud) findings.push({ rule: "mudflat-dry", detail: `${s.id}: mudflat with no river mouth or marsh meeting the sea` });
  }
  // runs along each loop (wrapping)
  let longestRun: CoastGateReport["longestRun"] = null;
  const byLoop = new Map<number, CoastSegmentDoc[]>();
  for (const s of docs) (byLoop.get(s.loop) ?? byLoop.set(s.loop, []).get(s.loop)!).push(s);
  for (const [li, loop] of byLoop) {
    const n = loop.length;
    if (loop.every((s) => s.type === loop[0]!.type)) {
      const metres = loop.reduce((a, s) => a + s.length, 0);
      if (groupLoop.get(li) !== li) continue; // an islet: one cliff ring is what it is
      const maxRun = maxRunFor(recipe, loop[0]!);
      if (metres > maxRun) findings.push({ rule: "max-run", detail: `the whole loop (${Math.round(metres)} m) is ${loop[0]!.type} (max run ${maxRun} m)` });
      if (!longestRun || metres > longestRun.metres) longestRun = { type: loop[0]!.type, metres: Math.round(metres), from: loop[0]!.id };
      continue;
    }
    let first = 0;
    while (loop[first]!.type === loop[(first + n - 1) % n]!.type) first++;
    for (let k = 0; k < n; ) {
      const s0 = loop[(first + k) % n]!;
      let metres = 0;
      const from = s0;
      while (k < n && loop[(first + k) % n]!.type === s0.type) { metres += loop[(first + k) % n]!.length; k++; }
      const maxRun = maxRunFor(recipe, from);
      if (metres > maxRun) findings.push({ rule: "max-run", detail: `${from.id}: a ${Math.round(metres)} m run of ${from.type} (max run ${maxRun} m)` });
      if (!longestRun || metres > longestRun.metres) longestRun = { type: from.type, metres: Math.round(metres), from: from.id };
    }
  }
  // stretches
  const stretchIds = new Set((recipe.terrain.seaCliffs ?? []).map((s) => s.id ?? "").filter((id) => id.startsWith("coast-")));
  const referenced = new Set<string>();
  for (const s of docs) {
    if (s.type === "sheer-cliff") {
      if (!s.stretch || !stretchIds.has(s.stretch)) findings.push({ rule: "cliff-no-stretch", detail: `${s.id}: sheer-cliff with no terrain.seaCliffs stretch${s.stretch ? ` (${s.stretch} is not in the recipe)` : ""}` });
      else referenced.add(s.stretch);
    } else if (s.stretch) findings.push({ rule: "cliff-no-stretch", detail: `${s.id}: a ${s.type} segment names stretch ${s.stretch}` });
  }
  for (const id of stretchIds) if (!referenced.has(id)) findings.push({ rule: "orphan-stretch", detail: `${id}: a coast-* stretch no sheer-cliff segment belongs to` });
  // cliff rock: the wall of a sheer-cliff segment wears the cliff splat of the biome BEHIND it (2026-10-28: "badlands red
  // rock then dry hinterland, grey rock against pines" — the biome decides, never a hand value). Measured on the field: the
  // wall's steep splat at the segment's midpoint against the dominant cliff surface of the biome on the cliff TOP
  // (TOP_M inland of the lip, on the higher side). Not BEHIND_M: a 100 m wall's top is the highland's even where the
  // anchor 80 m inland is a swamp at 48 m (seed 1438) — the field paints the wall from the top (`paintY`).
  if (opts.measureTops !== false) {
    let cliffField: WorldField | null = null;
    const out = new Float32Array(recipe.surfaces.length);
    for (const s of docs) {
      if (s.type !== "sheer-cliff" || !s.behind || !s.stretch || !stretchIds.has(s.stretch)) continue;
      cliffField ??= createWorldField(recipe);
      const mid = s.points[Math.floor(s.points.length / 2)]!;
      const a = s.points[0]!, b = s.points[s.points.length - 1]!;
      const len = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
      const px = -(b[1] - a[1]) / len, pz = (b[0] - a[0]) / len;
      const side = cliffField.height(mid[0] + px * BEHIND_M, mid[1] + pz * BEHIND_M) >= cliffField.height(mid[0] - px * BEHIND_M, mid[1] - pz * BEHIND_M) ? 1 : -1;
      const bx = mid[0] + px * TOP_M * side, bz = mid[1] + pz * TOP_M * side;
      // the biome the field paints the wall with: the wall column's own climate at the TOP's altitude (`paintY`) — read at
      // the top 20 m inland instead, a climate-site border running along the lip failed a wall painted correctly (test continent)
      const biome = recipe.biomes.find((o) => o.id === cliffField!.biome(mid[0], mid[1], cliffField!.height(bx, bz)).id);
      if (!biome) continue;
      // what the land behind paints a vertical face with — the biome's cliff AFTER the field's own remaps (zone ground,
      // rock roles), measured: the raw `biome.cliff` array failed a wall that wears exactly what the inland crags wear
      cliffField.splatAt(bx, cliffField.height(bx, bz), bz, 0, out, 0);
      const want = Array.from(out);
      const wantIdx = want.indexOf(Math.max(...want));
      cliffField.splatAt(mid[0], recipe.seaLevel + 3, mid[1], 0, out, 0);
      let gotIdx = 0;
      for (let i = 1; i < out.length; i++) if (out[i]! > out[gotIdx]!) gotIdx = i;
      const have = out[wantIdx] ?? 0;
      if (gotIdx !== wantIdx && have < 0.3) {
        const name = (i: number) => (recipe.surfaces[i] as { id?: string } | undefined)?.id ?? String(i);
        findings.push({ rule: "cliff-rock", detail: `${s.id}: the wall wears ${name(gotIdx)} (${Math.round((out[gotIdx] ?? 0) * 100)} %) but the ${biome.id} behind it (${s.behind}) wears ${name(wantIdx)} on its cliffs (${Math.round(have * 100)} % here)` });
      }
    }
  }
  // level tops asked for (coast-top): measured on the field, the square must reach 3/4 of the asked edge (or 120 m)
  const tops = docs.filter((s) => s.topEdge);
  for (const s of tops) {
    const stretch = (recipe.terrain.seaCliffs ?? []).find((c) => c.id === s.stretch);
    if (stretch && stretch.edge < s.topEdge!) findings.push({ rule: "flat-top", detail: `${s.id}: asks a ${s.topEdge} m level top but its stretch ${stretch.id} has edge ${stretch.edge} m (re-run worldgen coast-top)` });
  }
  if (tops.length > 0 && opts.measureTops !== false) {
    const field = createWorldField(recipe);
    for (const s of tops) {
      const m = measureFlatTop(field, s, Math.max(s.topEdge!, 160), recipe.seaLevel);
      const want = Math.min(120, Math.round(s.topEdge! * 0.75));
      if (m.side < want) findings.push({ rule: "flat-top", detail: `${s.id}: the largest flat square on its top is ${m.side} m at [${m.at.join(", ")}] (asked ${s.topEdge} m: at least ${want} m)` });
      else flatTops.push({ segment: s.id, side: m.side, at: m.at, top: m.top });
    }
  }
  return { ok: findings.length === 0, findings, shares, longestRun, segments: docs.length, flatTops };
}

function maxRunFor(recipe: WorldRecipe, s: CoastSegmentDoc): number {
  const region = s.region ? recipe.regions.find((r) => r.id === s.region) : null;
  return (region?.coast ?? DEFAULT_COAST_RULES).maxRun;
}

/** The `coast` row of `worldgen status`: null = ok. */
export function coastStageCheck(recipe: WorldRecipe): string | null {
  if (!recipe.bounds?.continents?.length) return "no landmasses to plan a coast for";
  if (!(recipe.features.coastSegments ?? []).length) return "no coast plan: the shore is noise only";
  const rep = checkCoastPlan(recipe);
  if (rep.ok) return null;
  const f = rep.findings[0]!;
  return `gate ${f.rule}: ${f.detail}${rep.findings.length > 1 ? ` (+${rep.findings.length - 1} more; worldgen coast --check)` : ""}`;
}

const pct = (v: number): string => `${Math.round(v * 100)} %`;
function round(v: number, places = 1): number {
  const f = 10 ** places;
  return Math.round(v * f) / f;
}

/** One colour per type for `worldgen map`. */
export const COAST_COLOURS: Record<CoastType, [number, number, number]> = {
  "sheer-cliff": [190, 30, 30],
  "rocky-shore": [130, 130, 140],
  shingle: [200, 165, 110],
  "sand-beach": [250, 230, 110],
  cove: [255, 120, 220],
  mudflat: [120, 85, 45],
};

// ------------------------------------------------------------------ the command

export interface CoastHost {
  argv: string[];
  loadRecipe(): { recipe: WorldRecipe; file: string };
  writeRecipe(recipe: WorldRecipe, file: string): void;
  fail(message: string): never;
}

export function commandCoast(host: CoastHost): void {
  const { argv } = host;
  const num = (name: string, fallback: number): number => {
    const i = argv.indexOf(`--${name}`);
    const v = i >= 0 ? Number(argv[i + 1]) : NaN;
    return Number.isFinite(v) ? v : fallback;
  };
  const { recipe, file } = host.loadRecipe();
  if (!recipe.bounds?.continents?.length) host.fail("no landmasses: run worldgen continents first");
  if (argv.includes("--check")) {
    const rep = checkCoastPlan(recipe);
    printReport(rep);
    if (!rep.ok) process.exitCode = 1;
    return;
  }
  const opts: CoastPlanOptions = {
    step: num("step", DEFAULT_PLAN_OPTIONS.step),
    spacing: num("spacing", DEFAULT_PLAN_OPTIONS.spacing),
    minSegment: num("min-segment", DEFAULT_PLAN_OPTIONS.minSegment),
    maxSegment: num("max-segment", DEFAULT_PLAN_OPTIONS.maxSegment),
    fetchOpen: num("fetch", DEFAULT_PLAN_OPTIONS.fetchOpen),
    ...(argv.includes("--wind") ? { windTo: num("wind", recipe.terrain.dunes.angle) } : {}),
  };
  const plan = planCoast(recipe, opts);
  for (const line of plan.log) console.log(`  ${line}`);
  if (plan.segments.length === 0) host.fail("no shoreline found: is there land above the sea inside the world limit?");
  const kept = (recipe.terrain.seaCliffs ?? []).filter((s) => !(s.id ?? "").startsWith("coast-"));
  recipe.terrain.seaCliffs = [...kept, ...plan.stretches];
  if (recipe.terrain.seaCliffs.length === 0) delete recipe.terrain.seaCliffs;
  recipe.features.coastSegments = plan.segments;
  const rep = checkCoastPlan(recipe);
  if (argv.includes("--json")) console.log(JSON.stringify({ segments: plan.segments, stretches: plan.stretches, report: rep }, null, 1));
  else {
    console.log(`  ${plan.segments.length} segment(s), ${plan.stretches.length} cliff stretch(es)${kept.length ? `, ${kept.length} hand-written stretch(es) kept` : ""}:`);
    for (const s of plan.segments) console.log(`    ${s.id.padEnd(9)} ${s.type.padEnd(12)} ${String(s.length).padStart(5)} m  ${s.exposure.padEnd(9)} fetch ${String(s.fetch).padStart(4)}  slope ${s.slopeBehind.toFixed(2)}  behind ${(s.behind ?? "-").padEnd(10)} ${s.concave ? "bay     " : "headland"}${s.mud ? "  mud" : ""}${s.stretch ? `  -> ${s.stretch}` : ""}`);
  }
  printReport(rep);
  host.writeRecipe(recipe, file);
  if (!rep.ok) {
    console.error("worldgen coast: the plan was written but the gate FAILS (see above); adjust regions[].coast or the wind and re-run");
    process.exitCode = 1;
  }
}

function printReport(rep: CoastGateReport): void {
  for (const [key, g] of Object.entries(rep.shares)) {
    console.log(`  ${key || "world"}: ${g.metres} m of shore — ${COAST_TYPES.map((t) => `${t} ${pct(g.share[t])}/${pct(g.target[t])}`).join(", ")} (share/target, +-${pct(g.tolerance)})`);
  }
  if (rep.longestRun) console.log(`  longest run: ${rep.longestRun.metres} m of ${rep.longestRun.type} from ${rep.longestRun.from}`);
  for (const t of rep.flatTops) console.log(`  level top ${t.segment}: flat square ${t.side} m at [${t.at.join(", ")}], top ${t.top} m`);
  if (rep.ok) console.log(`  coast gate: ok (${rep.segments} segments)`);
  else {
    console.log(`  coast gate: FAIL — ${rep.findings.length} finding(s)`);
    for (const f of rep.findings) console.log(`    ${f.rule}: ${f.detail}`);
  }
}

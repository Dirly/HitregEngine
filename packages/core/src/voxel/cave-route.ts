/**
 * CAVE ROUTES — the rock-cover estimate and the bore/mouth pieces shared by the `cave` operator and the `ledges`
 * operator's cave links (a short cave that climbs inside the rock between two shelves no ramp can join).
 *
 * Cover = rock between the bore wall and the nearest air, looking UP and SIDEWAYS (air below a floor is the floor's
 * problem, not the roof's). With a volume reader (`density`) it ray-marches 17 directions; without one it uses
 * heightfield columns (`sqrt(dxz^2 + max(0, h - y)^2)`), which cannot see overhangs or other caves.
 *
 * Pieces: one `tunnels` bore (capsule chain, radius >= 3 = the 6 m rule), one flared `tunnels` mouth per open end
 * (1.5 r -> r) and 2-3 jittered remove `blobs` around each mouth so it never reads as a drilled circle, plus an optional
 * chamber blob. Everything deterministic in (params, ground, seed).
 */
import type { OperatorFieldReader, OperatorPiece } from "./operator-registry.js";

export type V3 = [number, number, number];

/** Deterministic hash in [0, 1). */
export function hash01(seed: number, ...k: number[]): number {
  let h = seed | 0;
  for (const v of k) {
    h = Math.imul(h ^ Math.round(v * 1000), 2654435761);
    h ^= h >>> 15;
  }
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

const DIRS: V3[] = (() => {
  const out: V3[] = [[0, 1, 0]];
  for (let k = 0; k < 8; k++) {
    const a = (k / 8) * Math.PI * 2;
    out.push([Math.cos(a), 0, Math.sin(a)]);
    out.push([Math.cos(a) * Math.SQRT1_2, Math.SQRT1_2, Math.sin(a) * Math.SQRT1_2]);
  }
  return out;
})();

export interface CoverSource {
  /** Ground surface (heightfield fallback / the planned surface for ledges). */
  surface(x: number, z: number): number;
  density?(x: number, y: number, z: number): number;
  /** Heightfield column spacing, metres. */
  step: number;
}

/**
 * Rock cover, metres, outside a bore of radius `r` centred at `p`: distance from the centre to the nearest air up or
 * sideways, minus r. Capped at `cap` (the search stops there). Negative = the bore breaks out.
 */
export function rockCover(src: CoverSource, p: V3, r: number, cap: number): number {
  const reach = r + cap;
  if (src.density) {
    let best = reach;
    for (const d of DIRS) {
      for (let t = 0; t < best; t += 1) {
        if (src.density(p[0] + d[0] * t, p[1] + d[1] * t, p[2] + d[2] * t) >= 0) { best = t; break; }
      }
    }
    return best - r;
  }
  let best = Math.max(0, src.surface(p[0], p[2]) - p[1]);
  const s = src.step, n = Math.ceil(reach / s);
  for (let i = -n; i <= n; i++) for (let j = -n; j <= n; j++) {
    const dxz = Math.hypot(i * s, j * s);
    if (dxz >= best || (i === 0 && j === 0)) continue;
    const up = Math.max(0, src.surface(p[0] + i * s, p[2] + j * s) - p[1]);
    const d = Math.hypot(dxz, up);
    if (d < best) best = d;
  }
  return Math.min(best, reach) - r;
}

/** Points every ~`every` metres along a polyline (xz + y), ends included. */
export function resample(pts: V3[], every: number): { p: V3; s: number }[] {
  const out: { p: V3; s: number }[] = [{ p: pts[0]!, s: 0 }];
  let acc = 0;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1]!, b = pts[i]!;
    const len = Math.hypot(b[0] - a[0], b[2] - a[2]);
    const k = Math.max(1, Math.ceil(len / every));
    for (let j = 1; j <= k; j++) {
      const t = j / k;
      out.push({ p: [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t], s: acc + len * t });
    }
    acc += len;
  }
  return out;
}

export interface RouteCover {
  /** Smallest cover over the interior (outside the mouth stretches), capped. */
  min: number;
  sum: number;
  /** Interior samples (0 = the route is all mouth: a trench, not a cave). */
  interior: number;
  /** Where the smallest cover is. */
  at: V3;
}

/**
 * Cover along a FLOOR polyline (bore centre = floor + r), ignoring `mouthA` metres from the start and `mouthB` metres
 * from the end (open mouths; 0 for a closed end). `extra` adds closed-end points (a chamber) with their own radius.
 */
export function routeCover(src: CoverSource, floor: V3[], r: number, cap: number, mouthA: number, mouthB: number, extra: { p: V3; r: number }[] = []): RouteCover {
  const samples = resample(floor, 3);
  const total = samples[samples.length - 1]!.s;
  let min = cap, sum = 0, interior = 0, at: V3 = floor[0]!;
  for (const { p, s } of samples) {
    if (s < mouthA || s > total - mouthB) continue;
    const c = rockCover(src, [p[0], p[1] + r, p[2]], r, cap);
    interior++;
    sum += c;
    if (c < min) { min = c; at = [p[0], p[1] + r, p[2]]; }
  }
  for (const e of extra) {
    const c = rockCover(src, e.p, e.r, cap);
    interior++;
    sum += c;
    if (c < min) { min = c; at = e.p; }
  }
  return { min, sum, interior, at };
}

const r2 = (v: number) => Math.round(v * 100) / 100;
const p3 = (p: V3): V3 => [r2(p[0]), r2(p[1]), r2(p[2])];

/**
 * A flared natural mouth at `floor0` opening along `out` (unit xz, pointing OUT of the rock): a flare tube 1.6 r -> r
 * and 3-4 remove blobs (radius >= 3) jittered around the opening — two cheeks and a brow, so the opening reads from a
 * distance as a dark hole ~4-5 r wide in the face. Ids `<tag>-flare`, `<tag>-notch-<k>`.
 * `path` = the bore FLOOR polyline from `floor0` inward: the flare's inner end and every notch then sit on the floor
 * the bore really has at that depth (a climbing bore), never on a flat pit at mouth level that leaves a step up into
 * the bore. Without it the floor inward is taken as level (a level entry).
 */
export function mouthPieces(tag: string, floor0: V3, out: [number, number], r: number, seed: number, outsideY = floor0[1], path?: V3[]): { tunnels: OperatorPiece[]; blobs: OperatorPiece[] } {
  const [ox, oz] = out, side: [number, number] = [-oz, ox];
  const fr = 1.6 * r;
  // the floor `d` metres in from the mouth along the bore
  const floorIn = (d: number): V3 => {
    if (!path || path.length < 2) return [floor0[0] - ox * d, floor0[1], floor0[2] - oz * d];
    let left = d;
    for (let i = 1; i < path.length; i++) {
      const a = path[i - 1]!, b = path[i]!, l = Math.hypot(b[0] - a[0], b[2] - a[2]);
      if (left <= l || i === path.length - 1) { const u = l > 0 ? Math.min(1, left / l) : 0; return [a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u, a[2] + (b[2] - a[2]) * u]; }
      left -= l;
    }
    return path[path.length - 1]!;
  };
  const inner = floorIn(2.5 * r);
  const flare: OperatorPiece = {
    id: `${tag}-flare`,
    points: [
      // the outer end sits on the open ground outside (never a sill up into the cave), the inner end on the bore floor
      p3([floor0[0] + ox * r, Math.min(floor0[1], outsideY) + fr * 0.9, floor0[2] + oz * r]),
      p3([inner[0], inner[1] + r, inner[2]]),
    ],
    radius: r2(fr),
    endRadius: r2(r),
  };
  const blobs: OperatorPiece[] = [];
  const count = 3 + Math.floor(hash01(seed, 1) * 2);
  for (let k = 0; k < count; k++) {
    const h = (q: number) => hash01(seed, 10 + k, q);
    // k 0/1 = the two cheeks, k 2 = the brow over the opening, k 3 = a second cheek
    const brow = k === 2;
    const lat = brow ? (h(1) - 0.5) * r : (k % 2 === 0 ? 1 : -1) * (0.9 + 0.6 * h(1)) * r;
    const rad = Math.max(3, r * (brow ? 1.1 + 0.3 * h(4) : 0.9 + 0.35 * h(4)));
    const inward = (brow ? 0.1 + 0.5 * h(3) : 0.2 + 1.0 * h(3)) * r;
    const at = floorIn(inward);
    // never below the floor there: a notch carves the cheeks and the brow, never a pit in the way
    const up = brow ? 1.6 * r + 0.4 * r * h(2) : Math.max(rad * 0.95, (0.9 + 0.6 * h(2)) * r);
    blobs.push({
      id: `${tag}-notch-${k}`,
      center: p3([at[0] + side[0] * lat, Math.max(at[1], floor0[1]) + up, at[2] + side[1] * lat]),
      radius: r2(rad),
      op: "remove",
      falloff: 2,
      scaleX: r2(1 + 0.4 * h(5)),
      scaleZ: r2(1 + 0.4 * h(6)),
    });
  }
  return { tunnels: [flare], blobs };
}

/** The bore: floor polyline -> one tunnel with its centre r above the floor. */
export function borePiece(tag: string, floor: V3[], r: number): OperatorPiece {
  return { id: `${tag}-bore`, points: floor.map((p) => p3([p[0], p[1] + r, p[2]])), radius: r2(r) };
}

/** A cover source over an operator reader (density when the reader has it). */
export function readerCover(reader: OperatorFieldReader): CoverSource {
  return {
    surface: (x, z) => reader.height(x, z),
    density: reader.density ? (x, y, z) => reader.density!(x, y, z) : undefined,
    step: reader.voxelSize,
  };
}

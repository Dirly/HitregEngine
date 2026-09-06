import { polygonEdgeDistance } from "../scatter.js";
import type { RegionDoc } from "./regions.js";

/**
 * Zone borders as geometry — the pure half of `worldgen barriers` and the
 * quantitative `worldgen regions` audit (docs/world-editing/barriers.md).
 *
 * A zone border is a server line: past the band a player is handed to a
 * copy of the zone they walked into, and that is invisible only where
 * nobody can see across. This module walks every border two zones share,
 * samples it, and — given a `classify(x, z)` callback that knows the world
 * (water, canyon, steep, coast, ridge, town) — finds the OPEN runs, plans
 * the PASSES where paths cross them, and cuts the ridge pieces between the
 * passes. Nothing here reads a world field: the classifier is injected, so
 * the tool supplies the real one and tests supply a fake.
 */

export type BorderClass = "water" | "canyon" | "steep" | "coast" | "ridge" | "town" | "pass" | "open";

export const BORDER_CLASSES: readonly BorderClass[] = ["water", "canyon", "steep", "coast", "ridge", "town", "pass", "open"];

export interface BorderSample {
  x: number;
  z: number;
  /** Metres from the start of this chain. */
  along: number;
  /** Unit direction of the border at the sample (for the perpendicular the classifier measures across). */
  dx: number;
  dz: number;
}

export interface ClassifiedSample extends BorderSample {
  cls: BorderClass;
}

/** One connected piece of border two regions share, sampled every `step` metres. */
export interface BorderChain {
  a: string;
  b: string;
  samples: BorderSample[];
  /** Metres of border in this chain. */
  length: number;
}

/**
 * Sample the border region `a` shares with region `b`: walk every edge of
 * `a`'s polygon every `step` metres and keep the samples that lie within
 * `tolerance` of `b`'s outline. Consecutive kept samples form a chain; a
 * gap (a stretch of `a`'s border that faces someone else) starts a new one.
 * Proximity, not identity: a draft's simplified outlines share vertices
 * but not always segments, and a hand-edited pair traces the same river
 * with the same points only where the author was careful.
 */
export function sharedBorderChains(a: RegionDoc, b: RegionDoc, step = 15, tolerance = 2): BorderChain[] {
  const chains: BorderChain[] = [];
  let current: BorderSample[] = [];
  let along = 0;
  const flush = (): void => {
    if (current.length >= 2) chains.push({ a: a.id, b: b.id, samples: current, length: current[current.length - 1]!.along - current[0]!.along });
    current = [];
  };
  const poly = a.polygon;
  const n = poly.length;
  for (let i = 0; i < n; i++) {
    const p = poly[i]!;
    const q = poly[(i + 1) % n]!;
    const len = Math.hypot(q[0] - p[0], q[1] - p[1]);
    if (len < 1e-6) continue;
    const dx = (q[0] - p[0]) / len;
    const dz = (q[1] - p[1]) / len;
    const count = Math.max(1, Math.round(len / step));
    for (let k = 0; k < count; k++) {
      const t = k / count;
      const x = p[0] + (q[0] - p[0]) * t;
      const z = p[1] + (q[1] - p[1]) * t;
      const d = polygonEdgeDistance(x, z, b.polygon);
      if (d <= tolerance) current.push({ x, z, along: along + t * len, dx, dz });
      else flush();
    }
    along += len;
  }
  // the polygon is a loop: a chain that ends at the last vertex may continue at the first
  if (current.length > 0 && chains.length > 0 && chains[0]!.samples[0]!.along === 0) {
    const first = chains.shift()!;
    const offset = current[0]!.along;
    // re-base: the wrapped chain starts where `current` starts
    const merged = [...current, ...first.samples.map((s) => ({ ...s, along: s.along + along }))];
    for (const s of merged) s.along -= offset;
    chains.push({ a: a.id, b: b.id, samples: merged, length: merged[merged.length - 1]!.along - merged[0]!.along });
    current = [];
  } else flush();
  return chains;
}

/**
 * The whole outline of a cut-out region as one chain against its parent:
 * a town zone's border is its own polygon (the parent's outline runs
 * elsewhere), so proximity to the parent means nothing there.
 */
export function outlineChain(inner: RegionDoc, parent: RegionDoc, step = 15): BorderChain {
  const samples: BorderSample[] = [];
  let along = 0;
  const poly = inner.polygon;
  const n = poly.length;
  for (let i = 0; i < n; i++) {
    const p = poly[i]!;
    const q = poly[(i + 1) % n]!;
    const len = Math.hypot(q[0] - p[0], q[1] - p[1]);
    if (len < 1e-6) continue;
    const dx = (q[0] - p[0]) / len;
    const dz = (q[1] - p[1]) / len;
    const count = Math.max(1, Math.round(len / step));
    for (let k = 0; k < count; k++) {
      const t = k / count;
      samples.push({ x: p[0] + (q[0] - p[0]) * t, z: p[1] + (q[1] - p[1]) * t, along: along + t * len, dx, dz });
    }
    along += len;
  }
  return { a: parent.id, b: inner.id, samples, length: along };
}

/**
 * Every pair of regions that share border geometry, with their chains. A
 * cut-out (`within`) pairs only with its parent, and that pair's chain is
 * the cut-out's whole outline.
 */
export function allSharedBorders(regions: readonly RegionDoc[], step = 15, tolerance = 2): BorderChain[] {
  const out: BorderChain[] = [];
  for (let i = 0; i < regions.length; i++) {
    for (let j = i + 1; j < regions.length; j++) {
      const a = regions[i]!;
      const b = regions[j]!;
      if (a.within === b.id || b.within === a.id) {
        const [inner, parent] = a.within === b.id ? [a, b] : [b, a];
        out.push(outlineChain(inner, parent, step));
        continue;
      }
      // a cut-out borders nothing else on land; two wilderness zones share edges
      if (a.within !== undefined || b.within !== undefined) continue;
      if (!boundsTouch(a.polygon, b.polygon, tolerance)) continue;
      out.push(...sharedBorderChains(a, b, step, tolerance));
    }
  }
  return out;
}

function boundsTouch(a: readonly (readonly [number, number])[], b: readonly (readonly [number, number])[], pad: number): boolean {
  let ax0 = Infinity, az0 = Infinity, ax1 = -Infinity, az1 = -Infinity;
  for (const [x, z] of a) {
    if (x < ax0) ax0 = x;
    if (x > ax1) ax1 = x;
    if (z < az0) az0 = z;
    if (z > az1) az1 = z;
  }
  let bx0 = Infinity, bz0 = Infinity, bx1 = -Infinity, bz1 = -Infinity;
  for (const [x, z] of b) {
    if (x < bx0) bx0 = x;
    if (x > bx1) bx1 = x;
    if (z < bz0) bz0 = z;
    if (z > bz1) bz1 = z;
  }
  return ax0 - pad <= bx1 && bx0 - pad <= ax1 && az0 - pad <= bz1 && bz0 - pad <= az1;
}

/** Classify every sample of a chain. `classify` sees the border direction so it can measure across it. */
export function classifyChain(chain: BorderChain, classify: (s: BorderSample) => BorderClass): ClassifiedSample[] {
  return chain.samples.map((s) => ({ ...s, cls: classify(s) }));
}

/** Metres of border per class (each sample stands for `step` metres). */
export function classBreakdown(samples: readonly ClassifiedSample[], step: number): Record<BorderClass, number> {
  const out = { water: 0, canyon: 0, steep: 0, coast: 0, ridge: 0, town: 0, pass: 0, open: 0 };
  for (const s of samples) out[s.cls] += step;
  return out;
}

/** A stretch of consecutive open samples on a chain. */
export interface OpenRun {
  /** Index range into the classified chain, inclusive. */
  start: number;
  end: number;
  /** Metres of border the run covers. */
  length: number;
  samples: ClassifiedSample[];
}

/**
 * The open runs of a classified chain: consecutive `open` samples, keeping
 * runs of at least `minRun` metres. A single non-open sample inside a run
 * is bridged — a puddle does not end a wall — but two in a row do.
 */
export function openRuns(samples: readonly ClassifiedSample[], step: number, minRun = 60): OpenRun[] {
  const runs: OpenRun[] = [];
  let start = -1;
  let lastOpen = -1;
  const close = (): void => {
    if (start < 0) return;
    const end = lastOpen;
    const length = (end - start + 1) * step;
    if (length >= minRun) runs.push({ start, end, length, samples: samples.slice(start, end + 1).map((s) => ({ ...s, cls: "open" as const })) });
    start = -1;
    lastOpen = -1;
  };
  for (let i = 0; i < samples.length; i++) {
    if (samples[i]!.cls === "open") {
      if (start < 0) start = i;
      lastOpen = i;
      continue;
    }
    // bridge one non-open sample between two open ones
    if (start >= 0 && i + 1 < samples.length && samples[i + 1]!.cls === "open" && lastOpen === i - 1) continue;
    close();
  }
  close();
  return runs;
}

export interface PathLike {
  id: string;
  points: readonly (readonly [number, number])[];
}

export interface PassPlan {
  x: number;
  z: number;
  /** Metres from the start of the run's chain. */
  along: number;
  /** Gap left in the ridge, metres along the border. */
  width: number;
  /** Direction the pass is walked (the path's heading, or across the border for a guaranteed pass). */
  dx: number;
  dz: number;
  source: "path" | "guaranteed";
  paths: string[];
}

/** Nearest point on a path to (x, z): the distance, and the path's heading there. */
function nearestOnPath(path: PathLike, x: number, z: number): { d: number; dx: number; dz: number } {
  let best = { d: Infinity, dx: 0, dz: 1 };
  const pts = path.points;
  for (let i = 0; i + 1 < pts.length; i++) {
    const a = pts[i]!;
    const b = pts[i + 1]!;
    const ex = b[0] - a[0];
    const ez = b[1] - a[1];
    const l2 = ex * ex + ez * ez;
    const t = l2 < 1e-9 ? 0 : Math.max(0, Math.min(1, ((x - a[0]) * ex + (z - a[1]) * ez) / l2));
    const d = Math.hypot(x - (a[0] + ex * t), z - (a[1] + ez * t));
    if (d < best.d) {
      const l = Math.sqrt(l2) || 1;
      best = { d, dx: ex / l, dz: ez / l };
    }
  }
  return best;
}

/**
 * Where paths cross an open run: every path within `passWidth / 2` of a run
 * sample gets a pass centred on the nearest such sample (the stage does not
 * distinguish "crossing" from "near" — a path running alongside then across
 * still needs its ground untouched); passes closer than one pass width
 * merge into one at their mean.
 */
export function passesOnRun(run: OpenRun, paths: readonly PathLike[], passWidth: number): PassPlan[] {
  const found: PassPlan[] = [];
  for (const path of paths) {
    let best: { i: number; d: number; dx: number; dz: number } | null = null;
    for (let i = 0; i < run.samples.length; i++) {
      const s = run.samples[i]!;
      const near = nearestOnPath(path, s.x, s.z);
      if (near.d <= passWidth / 2 && (!best || near.d < best.d)) best = { i, d: near.d, dx: near.dx, dz: near.dz };
    }
    if (!best) continue;
    const s = run.samples[best.i]!;
    found.push({ x: s.x, z: s.z, along: s.along, width: passWidth, dx: best.dx, dz: best.dz, source: "path", paths: [path.id] });
  }
  found.sort((p, q) => p.along - q.along);
  const merged: PassPlan[] = [];
  for (const p of found) {
    const last = merged[merged.length - 1];
    if (last && p.along - last.along < passWidth) {
      const n = last.paths.length;
      last.x = (last.x * n + p.x) / (n + 1);
      last.z = (last.z * n + p.z) / (n + 1);
      last.along = (last.along * n + p.along) / (n + 1);
      last.paths.push(...p.paths);
      continue;
    }
    merged.push({ ...p, paths: [...p.paths] });
  }
  return merged;
}

/** A pass at the midpoint of a run, walked across the border — for a pair no path crosses. */
export function guaranteedPass(run: OpenRun, passWidth: number): PassPlan {
  const mid = run.samples[Math.floor(run.samples.length / 2)]!;
  return { x: mid.x, z: mid.z, along: mid.along, width: passWidth, dx: -mid.dz, dz: mid.dx, source: "guaranteed", paths: [] };
}

/**
 * The run minus its passes, as polylines of samples: what becomes the ridge
 * pieces. A piece shorter than `minPiece` metres (a bump between two passes)
 * is dropped, and a pass wider than the run leaves nothing.
 */
export function ridgePieces(run: OpenRun, passes: readonly PassPlan[], step: number, minPiece = 60): ClassifiedSample[][] {
  const pieces: ClassifiedSample[][] = [];
  let current: ClassifiedSample[] = [];
  const flush = (): void => {
    if (current.length >= 2 && (current.length - 1) * step >= minPiece) pieces.push(current);
    current = [];
  };
  for (const s of run.samples) {
    const inPass = passes.some((p) => Math.abs(s.along - p.along) <= p.width / 2);
    if (inPass) flush();
    else current.push(s);
  }
  flush();
  return pieces;
}

/** Douglas–Peucker on an open polyline, keeping both ends. */
export function simplifyPolyline(points: readonly (readonly [number, number])[], tolerance: number): [number, number][] {
  if (points.length <= 2) return points.map((p) => [p[0], p[1]]);
  const keep = new Uint8Array(points.length);
  keep[0] = 1;
  keep[points.length - 1] = 1;
  const stack: [number, number][] = [[0, points.length - 1]];
  while (stack.length > 0) {
    const [s, e] = stack.pop()!;
    const a = points[s]!;
    const b = points[e]!;
    const ex = b[0] - a[0];
    const ez = b[1] - a[1];
    const l2 = ex * ex + ez * ez;
    let worst = -1;
    let worstD = tolerance;
    for (let i = s + 1; i < e; i++) {
      const p = points[i]!;
      const t = l2 < 1e-9 ? 0 : Math.max(0, Math.min(1, ((p[0] - a[0]) * ex + (p[1] - a[1]) * ez) / l2));
      const d = Math.hypot(p[0] - (a[0] + ex * t), p[1] - (a[1] + ez * t));
      if (d > worstD) {
        worstD = d;
        worst = i;
      }
    }
    if (worst >= 0) {
      keep[worst] = 1;
      stack.push([s, worst], [worst, e]);
    }
  }
  const out: [number, number][] = [];
  for (let i = 0; i < points.length; i++) if (keep[i]) out.push([points[i]![0], points[i]![1]]);
  return out;
}

/** The gap a ridge must leave for a path: crest + both flanks + the tread + both shoulders. */
export function passWidthFor(ridge: { width: number; falloff: number }, path: { width: number; shoulder: number }): number {
  return ridge.width + 2 * ridge.falloff + path.width + 2 * path.shoulder;
}

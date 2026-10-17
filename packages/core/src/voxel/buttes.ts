/**
 * Buttes and mesas, "Monument Valley" style (opt-in, `terrain.buttes`).
 *
 * A field is a broad, flat, dry plain (the ground within `radius` pulled to
 * `level`) with a few big, far-apart monuments on it: long MESAS with notched,
 * bitten edges, blocky BUTTES, and thin SPIRE fins (a butte sometimes keeps a
 * spire beside it: the "mittens"). Every one has the same anatomy:
 *
 * - a PLAN of straight segments: a rectangle with its corners chamfered at
 *   random, stretched along a long axis, with rectangular notches bitten into
 *   its edges (re-entrant corners). Its distance is a max/min of half-planes,
 *   so walls are flat faces meeting at edges, never a circle;
 * - a sheer upper WALL (the cap rock): a thick cap band with a weathered,
 *   slightly overhanging lip, a recess under it, a few thin ledges lower down;
 *   spires taper and some lean;
 * - a wide concave TALUS apron, rising to about half the monument's height at
 *   the wall and flaring out to 1.5-3x the wall's width before it meets the
 *   plain: the narrow tower on a big apron.
 *
 * The heightfield carries the plain, caps and aprons (marching cubes draws
 * them); with `terrain.planarCliffs` (profile 'terrace') the planar path
 * evaluates {@link Buttes.density}: exactly vertical walls with the bands,
 * the overhang and the lean. Continuous, seed-stable, a pure function of
 * position. A world without `terrain.buttes` never constructs any of this.
 */

import { z } from "zod";
import { fbm2, hash3i, smoothstep, type FbmSpec } from "./noise.js";

const pair = (d: string) => z.tuple([z.number(), z.number()]).describe(d);
const kind = (len: [number, number], wid: [number, number], h: [number, number], w: number, d: string) =>
  z
    .object({
      weight: z.number().min(0).default(w).describe("Share of monuments of this kind (normalised across the three)."),
      length: pair("[min, max] metres along the long axis of the wall's plan (at the cap).").default(len),
      width: pair("[min, max] metres across it.").default(wid),
      height: pair("[min, max] metres of the cap over the plain (apron included).").default(h),
    })
    .prefault({})
    .describe(d);

export const butteFieldSchema = z
  .object({
    id: z.string().optional().describe("Name of this field (tools and logs)."),
    center: z.tuple([z.number(), z.number()]).describe("[x, z] centre of the plain."),
    radius: z.number().positive().default(800).describe("Metres of flat plain round the centre (monuments stand inside it, clear of its edge)."),
    fade: z.number().positive().default(250).describe("Metres over which the plain hands back to the natural ground."),
    level: z.number().describe("Height (y) of the plain."),
    relief: z.number().min(0).default(1.2).describe("Metres of gentle relief left on the plain."),
    cell: z.number().positive().default(320).describe("Metres per monument site (a jittered grid): monuments stand far apart with long sightlines between."),
    density: z.number().min(0).max(1).default(0.7).describe("Share of sites holding a monument."),
    mesa: kind([300, 700], [110, 220], [80, 130], 0.3, "Long, wide tables with notched, bitten edges."),
    butte: kind([80, 200], [60, 120], [110, 190], 0.45, "Blocky rectangles and lozenges, taller than the apron is wide."),
    spire: kind([22, 50], [7, 14], [90, 170], 0.25, "Thin fins, flat in one direction; they taper and some lean."),
    mittens: z.number().min(0).max(1).default(0.5).describe("Share of buttes that keep a spire standing just beside them."),
    notches: pair("[min, max] notches bitten into a mesa's edges (buttes get up to one).").default([2, 4]),
    apron: pair("[min, max] talus apron height as a fraction of the monument's height. The wall above it is the cap rock.").default([0.42, 0.55]),
    flare: pair("[min, max] how far the apron reaches out from the wall, as a fraction of the wall's width (1 = the apron's foot is twice the wall's width overall).").default([0.6, 1.1]),
    lean: z.number().min(0).max(0.1).default(0.05).describe("Most a spire leans (metres sideways per metre up); some stand straight."),
    cap: pair("[min, max] cap band thickness as a fraction of the sheer wall.").default([0.25, 0.4]),
    clearance: pair("Metres from a town, road, river or lake over which the plain fades in; monuments stand only where it is full. (POIs are not avoided: a site picked on the old ground is re-picked on the plain.)").default([30, 80]),
    seed: z.number().int().default(0),
  })
  .describe("One field of buttes and mesas on a flat plain.");

export const buttesSchema = z
  .array(butteFieldSchema)
  .describe(
    "OPT-IN 'Monument Valley': fields of a few big, far-apart mesas, buttes and spire fins on a broad flat plain — plans of " +
      "straight segments with notches, a sheer cap-rock wall (thick cap band, overhanging lip, a few thin ledges) over a wide " +
      "concave talus apron. The heightfield carries them (marching cubes draws them); with `terrain.planarCliffs` (profile " +
      "'terrace') the walls are exactly vertical. Fields must not overlap. Absent = unchanged, byte for byte.",
  );
export type ButteFieldDoc = z.infer<typeof butteFieldSchema>;

export interface ButteContext {
  seed: number;
  obstacles: readonly { points: readonly (readonly [number, number])[]; radius: number; closed?: boolean }[];
}

/** One monument, resolved. Plan in its own frame (u along the long axis, v across). */
interface Monument {
  x: number; z: number; c: number; s: number;
  kind: 0 | 1 | 2;
  /** Plan half-planes: nu, nv, offset (outward). */
  edges: number[];
  /** Notches: centre u, v, frame cos, sin, half-length, half-depth. */
  notches: number[];
  top: number; plain: number; taper: number; leanX: number; leanZ: number;
  apronH: number; apronW: number;
  /** Strata push breakpoints [y, out] (piecewise linear in y). */
  bands: number[];
  half: number;
}

export interface ButteColumn {
  /** Plain weight (0 = not in a field) and the plain's closed-form level here. */
  w: number;
  plain: number;
  /** Monuments near the column (up to 4) and their plan distance at the plain (where the apron reads it). */
  n: number;
  mons: Monument[];
  base: Float64Array;
  /** min over them of (base distance - apron reach): how far outside every apron the column is. */
  out: number;
  k: number;
}

export interface ButteMonument { x: number; z: number; kind: "mesa" | "butte" | "spire"; radius: number; top: number }

export interface Buttes {
  readonly bbox: readonly [number, number, number, number];
  height(x: number, z: number, h: number): number;
  newColumn(): ButteColumn;
  column(x: number, z: number, out: ButteColumn): number;
  density(x: number, y: number, z: number, hb: number, col: ButteColumn): number;
  weight(col: ButteColumn): number;
  mask(col: ButteColumn): number;
  monumentsIn(x0: number, z0: number, x1: number, z1: number): ButteMonument[];
}

const U32 = 4294967296;

function distToPolyline(points: readonly (readonly [number, number])[], x: number, z: number, closed = false): number {
  let best = Infinity;
  const n = points.length;
  if (n === 1) return Math.hypot(x - points[0]![0], z - points[0]![1]);
  for (let i = 0; i < (closed ? n : n - 1); i++) {
    const a = points[i]!, b = points[(i + 1) % n]!;
    const dx = b[0] - a[0], dz = b[1] - a[1], len = dx * dx + dz * dz;
    const t = len < 1e-9 ? 0 : Math.max(0, Math.min(1, ((x - a[0]) * dx + (z - a[1]) * dz) / len));
    best = Math.min(best, Math.hypot(x - (a[0] + dx * t), z - (a[1] + dz * t)));
  }
  return best;
}
function insidePolygon(poly: readonly (readonly [number, number])[], x: number, z: number): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i]!, b = poly[j]!;
    if (a[1] > z !== b[1] > z && x < ((b[0] - a[0]) * (z - a[1])) / (b[1] - a[1] || 1e-12) + a[0]) inside = !inside;
  }
  return inside;
}

/**
 * A plan of straight segments in its own frame (u along the long axis, v across): half-planes `edges` (nu, nv,
 * outward offset) and rectangular `notches` bitten out of them (centre u, v, frame cos, sin, half-length,
 * half-depth). Shared by butte monuments and shaped sea stacks (`terrain.seaCliffs[].stacks.shape`).
 */
export interface SegmentPlan { edges: number[]; notches: number[] }

/** Signed distance of a {@link SegmentPlan} at plan coordinates (u, v), metres (negative inside). */
export function segmentPlanDistance(p: SegmentPlan, u: number, v: number): number {
  const e = p.edges;
  let d = -Infinity;
  for (let i = 0; i < e.length; i += 3) { const t = u * e[i]! + v * e[i + 1]! - e[i + 2]!; if (t > d) d = t; }
  const nt = p.notches;
  for (let i = 0; i < nt.length; i += 6) {
    const pu = u - nt[i]!, pv = v - nt[i + 1]!, a = pu * nt[i + 2]! + pv * nt[i + 3]!, b = -pu * nt[i + 3]! + pv * nt[i + 2]!;
    const box = Math.max(Math.abs(a) - nt[i + 4]!, Math.abs(b) - nt[i + 5]!);
    if (-box > d) d = -box; // bite the notch out
  }
  return d;
}

/**
 * A rectangle (half-axes A along u, B across) with each corner chamfered by its own amount, a slight skew and
 * `notches` rectangular bites in its long edges: straight segments, never a circle. `r(ch)` is the seeded
 * uniform 0..1 for channel `ch` (23-27, 30-33, and 41+q .. 80+q per notch). `chamferScale` scales every chamfer
 * (thin fins keep their ends square-ish); a notch is lerp(0.06, 0.18) x A + `notchMin` metres wide.
 */
export function chamferedPlan(A: number, B: number, r: (ch: number) => number, chamferScale: number, notches: number, notchMin: number): SegmentPlan {
  const edges: number[] = [];
  const sk = (r(23) - 0.5) * 0.25;
  const add = (nu: number, nv: number, off: number) => { const l = Math.hypot(nu, nv); edges.push(nu / l, nv / l, off / l); };
  add(1, sk, A); add(-1, -sk * 0.5, A); add(sk * 0.3, 1, B); add(-sk * 0.6, -1, B);
  for (let q = 0; q < 4; q++) {
    const su = q & 1 ? -1 : 1, sv = q & 2 ? -1 : 1, ch = (0.08 + (0.45 - 0.08) * r(24 + q)) * Math.min(A, B) * chamferScale;
    // the corner's chamfer plane, at an angle of its own
    const a = 0.35 + 0.3 * r(30 + q);
    add(su * Math.cos(a * Math.PI / 2 + 0.2), sv * Math.sin(a * Math.PI / 2 + 0.2), (A * Math.cos(a * Math.PI / 2 + 0.2) + B * Math.sin(a * Math.PI / 2 + 0.2)) - ch);
  }
  const nt: number[] = [];
  for (let q = 0; q < notches; q++) {
    const side = r(41 + q) < 0.5 ? -1 : 1;
    const along = (r(50 + q) * 1.6 - 0.8) * A;
    const depth = (0.2 + (0.45 - 0.2) * r(60 + q)) * B, wid = (0.06 + (0.18 - 0.06) * r(70 + q)) * A + notchMin;
    const ang = (r(80 + q) - 0.5) * 0.5;
    nt.push(along, side * B, Math.cos(ang), Math.sin(ang), wid / 2, depth);
  }
  return { edges, notches: nt };
}

/**
 * Cap-rock bands as push breakpoints [y, out, ...] (piecewise linear in y, read by {@link bandPushAt}): flush up to
 * the first thin ledge, each ledge 0.7 m out over 2.2 m, a 0.9 m recess under the cap band, the cap band `capOut`
 * out from `capLo` with a further 0.6 m weathered lip over its top 2 m. Ledges (sorted y) too close to each other or
 * to the cap are dropped. `r` is the ramp (near the voxel size).
 */
export function capRockBands(wallLo: number, top: number, capLo: number, capOut: number, ledgeYs: number[], r = 1.2, recess = 0.9): number[] {
  const bands: number[] = [wallLo - 10, 0];
  let last = wallLo - 10;
  for (const y0 of ledgeYs) {
    if (y0 - r < last + 0.5 || y0 + 2.2 + r > capLo - 5) continue;
    bands.push(y0 - r, 0, y0, 0.7, y0 + 2.2, 0.7, y0 + 2.2 + r, 0);
    last = y0 + 2.2 + r;
  }
  bands.push(capLo - 2.5 - r, 0, capLo - 2.5, -recess, capLo - r * 0.5, -recess, capLo + r * 0.5, capOut, top - 3.4, capOut, top - 1.4, capOut + 0.6, top + 5, capOut + 0.6);
  return bands;
}

/** The outward push of {@link capRockBands} breakpoints at height y. */
export function bandPushAt(b: readonly number[], y: number): number {
  if (y <= b[0]!) return b[1]!;
  for (let i = 2; i < b.length; i += 2) if (y <= b[i]!) { const t = (y - b[i - 2]!) / (b[i]! - b[i - 2]! || 1); return b[i - 1]! + (b[i + 1]! - b[i - 1]!) * t; }
  return b[b.length - 1]!;
}

/** Signed plan distance of a monument at (x, z), metres (negative inside). */
function planDistance(m: Monument, x: number, z: number): number {
  const dx = x - m.x, dz = z - m.z, u = dx * m.c + dz * m.s, v = -dx * m.s + dz * m.c;
  return segmentPlanDistance(m, u, v);
}
/** The bands' outward push at height y (piecewise linear between breakpoints). */
function bandPush(m: Monument, y: number): number {
  return bandPushAt(m.bands, y);
}

interface Field {
  doc: ButteFieldDoc;
  bbox: [number, number, number, number];
  obstacles: ButteContext["obstacles"];
  reliefSpec: FbmSpec;
  seed: number;
}

export function createButtes(docs: readonly ButteFieldDoc[], ctx: ButteContext): Buttes {
  const fields: Field[] = docs.map((doc, i) => {
    const pad = doc.radius + doc.fade + 8;
    const bbox: [number, number, number, number] = [doc.center[0] - pad, doc.center[1] - pad, doc.center[0] + pad, doc.center[1] + pad];
    const near = ctx.obstacles.filter((o) => o.points.some(([px, pz]) => px > bbox[0] - o.radius - doc.clearance[1] && px < bbox[2] + o.radius + doc.clearance[1] && pz > bbox[1] - o.radius - doc.clearance[1] && pz < bbox[3] + o.radius + doc.clearance[1]));
    return {
      doc, bbox, obstacles: near,
      reliefSpec: { frequency: 1 / 180, amplitude: 1, octaves: 2, lacunarity: 2, gain: 0.5, ridged: false, seed: 4211 + doc.seed },
      seed: (ctx.seed + doc.seed * 7919 + i * 104729 + 977) | 0,
    };
  });
  let bx0 = Infinity, bz0 = Infinity, bx1 = -Infinity, bz1 = -Infinity;
  for (const f of fields) { bx0 = Math.min(bx0, f.bbox[0]); bz0 = Math.min(bz0, f.bbox[1]); bx1 = Math.max(bx1, f.bbox[2]); bz1 = Math.max(bz1, f.bbox[3]); }

  // ---- plain weight on a 16 m lattice (disc fade x obstacle clearance), cached then bilinear
  const L = 16;
  const nodes = new Map<number, Float32Array>();
  const nodeW = (I: number, K: number): Float32Array => {
    const key = (I + 1048576) * 2097152 + (K + 1048576);
    let n = nodes.get(key);
    if (n) return n;
    if (nodes.size > 200000) nodes.clear();
    n = new Float32Array(fields.length);
    const x = I * L, z = K * L;
    fields.forEach((f, k) => {
      const d = f.doc;
      let w = 1 - smoothstep(d.radius, d.radius + d.fade, Math.hypot(x - d.center[0], z - d.center[1]));
      if (w > 0) {
        let clear = Infinity;
        for (const o of f.obstacles) {
          if (o.closed && o.points.length > 2 && insidePolygon(o.points, x, z)) { clear = -1; break; }
          clear = Math.min(clear, distToPolyline(o.points, x, z, o.closed) - o.radius);
        }
        w *= smoothstep(d.clearance[0], Math.max(d.clearance[0] + 1, d.clearance[1]), clear);
      }
      n![k] = w;
    });
    nodes.set(key, n);
    return n;
  };
  let lastW = 0;
  const fieldAt = (x: number, z: number): number => {
    lastW = 0;
    if (x < bx0 || x > bx1 || z < bz0 || z > bz1) return -1;
    const fx = x / L, fz = z / L, I = Math.floor(fx), K = Math.floor(fz), tx = fx - I, tz = fz - K;
    const a = nodeW(I, K), b = nodeW(I + 1, K), c = nodeW(I, K + 1), e = nodeW(I + 1, K + 1);
    let best = -1;
    for (let k = 0; k < fields.length; k++) {
      const w = (a[k]! * (1 - tx) + b[k]! * tx) * (1 - tz) + (c[k]! * (1 - tx) + e[k]! * tx) * tz;
      if (w > lastW) { lastW = w; best = k; }
    }
    return best;
  };
  const plainAt = (f: Field, x: number, z: number): number => f.doc.level + f.doc.relief * fbm2(f.reliefSpec, x, z, f.seed);

  // ---- monuments
  const hu = (I: number, K: number, ch: number, s: number): number => hash3i(I, K, ch, s) / U32;
  const lerp = (r: readonly [number, number], t: number): number => r[0] + (r[1] - r[0]) * t;
  /** Build one monument (no placement checks). */
  const build = (f: Field, I: number, K: number, salt: number, kindIx: 0 | 1 | 2, x: number, z: number, rot: number, scale = 1): Monument => {
    const d = f.doc, ss = (f.seed + salt * 131) | 0, kd = kindIx === 0 ? d.mesa : kindIx === 1 ? d.butte : d.spire;
    const A = (lerp(kd.length, hu(I, K, 20, ss)) / 2) * scale, B = (lerp(kd.width, hu(I, K, 21, ss)) / 2) * scale;
    const h = lerp(kd.height, hu(I, K, 22, ss)) * (kindIx === 2 ? Math.min(1, scale + 0.15) : 1);
    // plan: a rectangle with each corner chamfered by its own amount (straight segments, no circle), a slight skew
    // and notches bitten into the long edges (re-entrant corners)
    const nN = kindIx === 0 ? Math.round(lerp([d.notches[0], d.notches[1]], hu(I, K, 40, ss))) : kindIx === 1 ? (hu(I, K, 40, ss) < 0.5 ? 1 : 0) : 0;
    const { edges, notches } = chamferedPlan(A, B, (ch) => hu(I, K, ch, ss), kindIx === 2 ? 0.4 : 1, nN, 12);
    const plain = plainAt(f, x, z), top = plain + h;
    const apronH = h * lerp(d.apron, hu(I, K, 90, ss)) * (kindIx === 2 ? 0.85 : 1);
    const apronW = Math.max(2 * B * lerp(d.flare, hu(I, K, 91, ss)), apronH * 1.15);
    // lean: spires (and the odd butte) lean a little, capped at 6 m over the wall's height
    let leanX = 0, leanZ = 0;
    if (kindIx === 2 || hu(I, K, 92, ss) < 0.2) {
      const l = Math.min(d.lean * hu(I, K, 93, ss) * (kindIx === 2 ? 1 : 0.4), 6 / Math.max(1, h - apronH)), a = hu(I, K, 94, ss) * Math.PI * 2;
      leanX = Math.cos(a) * l; leanZ = Math.sin(a) * l;
    }
    // strata: a thick cap band standing out with a weathered overhanging lip, a recess under it, a few thin ledges
    const wallLo = plain + apronH * 0.6, wall = top - wallLo, capH = wall * lerp(d.cap, hu(I, K, 95, ss));
    const capOut = 0.8 + 0.8 * hu(I, K, 96, ss), r = 1.2;
    const ledges = 2 + Math.floor(hu(I, K, 97, ss) * 2);
    const lows: number[] = [];
    for (let q = 0; q < ledges; q++) lows.push(wallLo + (0.12 + 0.6 * hu(I, K, 100 + q, ss)) * (wall - capH));
    lows.sort((p, q2) => p - q2);
    const bands = capRockBands(wallLo, top, top - capH, capOut, lows, r);
    return {
      x, z, c: Math.cos(rot), s: Math.sin(rot), kind: kindIx, edges, notches, top, plain,
      taper: kindIx === 2 ? 0.035 : kindIx === 1 ? 0.01 : 0.004, leanX, leanZ, apronH, apronW, bands,
      half: A + apronW + 10,
    };
  };
  /** A site's raw candidate (no checks), or null. */
  const candidate = (k: number, I: number, K: number): { m: Monument; prio: number } | null => {
    const f = fields[k]!, d = f.doc, ss = f.seed;
    if (d.density <= 0 || hu(I, K, 7, ss) >= d.density) return null;
    const x = (I + 0.25 + 0.5 * hu(I, K, 8, ss)) * d.cell, z = (K + 0.25 + 0.5 * hu(I, K, 9, ss)) * d.cell;
    const tw = d.mesa.weight + d.butte.weight + d.spire.weight || 1, u = hu(I, K, 10, ss) * tw;
    const kindIx = (u < d.mesa.weight ? 0 : u < d.mesa.weight + d.butte.weight ? 1 : 2) as 0 | 1 | 2;
    return { m: build(f, I, K, 0, kindIx, x, z, hu(I, K, 14, ss) * Math.PI), prio: hash3i(I, K, 16, ss) };
  };
  const sites = new Map<number, Monument[]>();
  const siteList = (k: number, I: number, K: number): Monument[] => {
    const key = ((I + 32768) * 65536 + (K + 32768)) * 8 + k;
    const known = sites.get(key);
    if (known) return known;
    if (sites.size > 20000) sites.clear();
    const f = fields[k]!, d = f.doc, out: Monument[] = [];
    const c = candidate(k, I, K);
    if (c) {
      const m = c.m;
      // the whole plan and apron on full plain, clear of the edge and of every obstacle (sampled round the plan)...
      let ok = Math.hypot(m.x - d.center[0], m.z - d.center[1]) < d.radius;
      for (let a = 0; a < 16 && ok; a++) {
        const ca = Math.cos(a * 0.3927), sa = Math.sin(a * 0.3927);
        let r = 4; while (r < m.half && planDistance(m, m.x + ca * r, m.z + sa * r) < m.apronW + 16) r += 4;
        fieldAt(m.x + ca * r, m.z + sa * r);
        if (lastW < 0.95) ok = false;
      }
      // ...and clear of a neighbouring site's monument that outranks it
      for (let dk = -1; dk <= 1 && ok; dk++) for (let di = -1; di <= 1 && ok; di++) {
        if (!di && !dk) continue;
        const o = candidate(k, I + di, K + dk);
        if (o && o.prio > c.prio && Math.hypot(o.m.x - m.x, o.m.z - m.z) < (o.m.half + m.half) * 0.75) ok = false;
      }
      if (ok) {
        out.push(m);
        if (m.kind === 1 && hu(I, K, 15, f.seed) < d.mittens) {
          // the mitten: a spire fin a little way off the butte's long side, roughly parallel to it
          const side = hu(I, K, 17, f.seed) < 0.5 ? -1 : 1;
          const B = (m.edges[8] ?? 40), gap = B + 18 + d.spire.width[1];
          const sx = m.x - m.s * side * gap, sz = m.z + m.c * side * gap;
          out.push(build(f, I, K, 1, 2, sx, sz, Math.atan2(m.s, m.c) + (hu(I, K, 18, f.seed) - 0.5) * 0.6, 0.9));
        }
      }
    }
    sites.set(key, out);
    return out;
  };

  const near: Monument[] = [];
  let nI = NaN, nK = NaN, nk = -1;
  const blank = (): ButteColumn => ({ w: 0, plain: 0, n: 0, mons: [], base: new Float64Array(4), out: Infinity, k: -1 });
  function evalColumn(x: number, z: number, out: ButteColumn): number {
    const k = fieldAt(x, z);
    out.w = k < 0 ? 0 : lastW; out.k = k; out.n = 0; out.out = Infinity;
    if (out.w <= 0) return 0;
    const f = fields[k]!, d = f.doc;
    out.plain = plainAt(f, x, z);
    const I = Math.floor(x / d.cell), K = Math.floor(z / d.cell);
    if (I !== nI || K !== nK || k !== nk) {
      nI = I; nK = K; nk = k; near.length = 0;
      for (let dk = -1; dk <= 1; dk++) for (let di = -1; di <= 1; di++) for (const m of siteList(k, I + di, K + dk)) near.push(m);
    }
    for (const m of near) {
      // the plan at the plain: tapered wider by the wall's height
      const base = planDistance(m, x, z) - m.taper * (m.top - m.plain);
      if (base - m.apronW > 40 || out.n >= 4) continue;
      const i = out.n++;
      out.mons[i] = m; out.base[i] = base;
      out.out = Math.min(out.out, base - m.apronW);
    }
    return out.w;
  }
  /** The highest apron over the plain at the column (concave: steep at the wall, flattening to the plain). */
  const apronAt = (col: ButteColumn): number => {
    let best = 0;
    for (let i = 0; i < col.n; i++) {
      const m = col.mons[i]!, b = col.base[i]!;
      if (b >= m.apronW) continue;
      const t = 1 - Math.max(0, b) / m.apronW;
      best = Math.max(best, m.apronH * t * t);
    }
    return best;
  };
  const scratch = blank();
  return {
    bbox: [bx0, bz0, bx1, bz1],
    height(x, z, h) {
      if (x < bx0 || x > bx1 || z < bz0 || z > bz1) return h;
      const col = scratch;
      if (evalColumn(x, z, col) <= 0) return h;
      let hc = h + (col.plain - h) * col.w;
      if (col.out < 0) {
        const skirt = col.plain + apronAt(col);
        hc = Math.max(hc, skirt);
        for (let i = 0; i < col.n; i++) if (col.base[i]! < 1) hc = Math.max(hc, skirt + (col.mons[i]!.top - skirt) * smoothstep(1, -1, col.base[i]!));
      }
      return hc;
    },
    newColumn: blank,
    column: (x, z, out) => evalColumn(x, z, out),
    density(x, y, z, hb, col) {
      // the plain in closed form round a monument (the lattice height there is its cap or its apron), the lattice beyond
      const plainZ = col.plain + (hb - col.plain) * smoothstep(4, 14, col.out);
      let d = y - plainZ;
      if (col.out < 16) {
        for (let i = 0; i < col.n; i++) {
          const m = col.mons[i]!, up = y - m.plain;
          // the wall: the plan slid by the lean and tapered with depth, pushed out by the bands
          const pd = planDistance(m, x - m.leanX * up, z - m.leanZ * up) - m.taper * Math.max(0, m.top - y) - bandPush(m, y);
          d = Math.min(d, Math.max(y - m.top, pd));
        }
        d = Math.min(d, (y - (col.plain + apronAt(col))) * 0.8);
      }
      return d;
    },
    weight(col) {
      if (col.w <= 0) return 0;
      return col.w >= 0.95 ? 1 - smoothstep(14, 22, col.out) : 0;
    },
    mask(col) {
      if (col.w < 0.95) return 0;
      return 1 - smoothstep(18, 28, col.out);
    },
    monumentsIn(x0, z0, x1, z1) {
      const out: ButteMonument[] = [];
      fields.forEach((f, k) => {
        const C = f.doc.cell;
        for (let K = Math.floor(z0 / C); K <= Math.floor(z1 / C); K++) for (let I = Math.floor(x0 / C); I <= Math.floor(x1 / C); I++)
          for (const m of siteList(k, I, K)) if (m.x >= x0 && m.x < x1 && m.z >= z0 && m.z < z1) out.push({ x: m.x, z: m.z, kind: m.kind === 0 ? "mesa" : m.kind === 1 ? "butte" : "spire", radius: m.half - m.apronW - 10, top: m.top });
      });
      return out;
    },
  };
}

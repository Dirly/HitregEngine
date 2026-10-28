/**
 * The coast PLAN (`features.coastSegments`, written by `worldgen coast`).
 *
 * The shore used to be decided by three things that never spoke to each other: `terrain.coast` noise ruggedness
 * (~17 % steep, wherever the fBm said so), opt-in `terrain.seaCliffs` stretches drawn by hand, and the beach biome's
 * height window. Nothing decided PER STRETCH OF SHORE what kind of coast it is, and nothing checked the mix, so a
 * coast read all cliff or all beach. The plan is that decision, as data: the shoreline cut into segments at headland
 * and bay inflections and by exposure to the wind, each given ONE type —
 *
 *   sheer-cliff   the Moher wall: a `terrain.seaCliffs` stretch (`coast-*`) builds it; this doc only names the stretch
 *   rocky-shore   the ordinary coast with `terrain.coast` ruggedness forced ON (steep rock meets the water, no sand)
 *   shingle       ruggedness held at half: a steep-ish shore with a narrow strip of beach
 *   sand-beach    ruggedness forced OFF and the beach window widened: a wide, gentle beach
 *   cove          as sand-beach in a small sheltered bay (the harbour-able kind)
 *   mudflat       ruggedness off, a wet shelf: the `ground` role (mud) painted at the waterline instead of sand
 *
 * The field reads the segments as a pure function of (x, z): within `reach` of a segment's polyline its parameters
 * hold, blended with its neighbours by distance (a 1/(d+6)^2 kernel over the segments in reach), on an 8 m lattice
 * cached and bilinear between nodes. The remap it feeds (`coastAt`) is the same monotonic `dh -> dh * k` as before,
 * so the plan never moves the coastline (docs/voxel-worlds.md section 23); the beach scale only moves the biome's
 * height window; the mud paint is splat only. A recipe without segments is byte-for-byte what it was.
 */

import { z } from "zod";
import { smoothstep } from "./noise.js";

export const COAST_TYPES = ["sheer-cliff", "rocky-shore", "shingle", "sand-beach", "cove", "mudflat"] as const;
export type CoastType = (typeof COAST_TYPES)[number];

/** What the field does per type: `rugged` = the `terrain.coast` ruggedness held there (null = the noise, the wall is the stretch's), `beach` = the coastal biomes' height window scale, `mud` = paint the ground role at the waterline. */
export const COAST_TYPE_FIELD: Record<CoastType, { rugged: number | null; beach: number; mud: number }> = {
  "sheer-cliff": { rugged: null, beach: 0.5, mud: 0 },
  "rocky-shore": { rugged: 1, beach: 0.35, mud: 0 },
  shingle: { rugged: 0.5, beach: 0.7, mud: 0 },
  "sand-beach": { rugged: 0, beach: 1.8, mud: 0 },
  cove: { rugged: 0, beach: 1.5, mud: 0 },
  mudflat: { rugged: 0, beach: 1.2, mud: 1 },
};

/** Default target share of shoreline length per type (`regions[].coast.shares` overrides per zone). */
export const COAST_DEFAULT_SHARES: Record<CoastType, number> = { "sheer-cliff": 0.25, "rocky-shore": 0.2, shingle: 0.15, "sand-beach": 0.2, cove: 0.1, mudflat: 0.1 };

export const coastTypeSchema = z
  .enum(COAST_TYPES)
  .describe(
    "Kind of coast on one shoreline segment. sheer-cliff: a `terrain.seaCliffs` stretch (`coast-*`) builds the wall. " +
      "rocky-shore: `terrain.coast` ruggedness forced to 1 (steep rock to the water), the coastal biomes' height window x0.35. " +
      "shingle: ruggedness 0.5, window x0.7. sand-beach: ruggedness 0, window x1.8 (a wide gentle beach). cove: ruggedness 0, " +
      "window x1.5, in a small sheltered bay. mudflat: ruggedness 0, window x1.2 and the palette's `ground` role (mud) painted at the " +
      "waterline in place of sand. The ruggedness remap stays monotonic, so no type moves the coastline.",
  );

export const regionCoastSchema = z
  .object({
    allowed: z
      .array(coastTypeSchema)
      .min(1)
      .default([...COAST_TYPES])
      .describe("Coast types `worldgen coast` may give this zone's shoreline segments. Default: every type."),
    shares: z
      .partialRecord(coastTypeSchema, z.number().min(0).max(1))
      .default({})
      .describe(
        "Target share of the zone's shoreline LENGTH per type; a type left out takes the default (sheer-cliff 0.25, rocky-shore 0.2, " +
          "shingle 0.15, sand-beach 0.2, cove 0.1, mudflat 0.1), one not in `allowed` is 0. Targets are renormalised over the types " +
          "that have an eligible segment (beaches and coves need a sheltered segment, a cove a short concave one, a mudflat a river " +
          "mouth or marsh, a cliff an exposed or steep-backed one) and capped at the eligible length, so a zone with no sheltered " +
          "shore is not failed for having no beach it could have had.",
      ),
    tolerance: z.number().min(0).max(1).default(0.12).describe("The gate passes a type whose share is within this of its target."),
    maxRun: z.number().positive().default(600).describe("Metres: the gate fails a run of consecutive segments of one type longer than this."),
  })
  .describe("How `worldgen coast` types this zone's shoreline and what its `coast` gate checks. Absent = the defaults.");
export type RegionCoastDoc = z.infer<typeof regionCoastSchema>;

export const coastSegmentSchema = z
  .object({
    id: z.string().min(1).describe("`cs-<loop>-<n>`: stable within a run of the stage; the map prints the number."),
    type: coastTypeSchema,
    points: z
      .array(z.tuple([z.number(), z.number()]))
      .min(2)
      .describe("[x, z] shoreline polyline of the segment (the field's shore distance 0, ~24 m apart), in loop order."),
    loop: z.number().int().min(0).default(0).describe("Which shoreline loop (landmass) it belongs to; a loop's segments are listed in order and wrap."),
    exposure: z
      .enum(["exposed", "sheltered"])
      .describe("exposed: the outward normal faces within 60 degrees of where the wind comes from (`terrain.dunes.angle` is where it blows to) AND the fetch is over 1.5 km of open sea; sheltered otherwise."),
    fetch: z.number().min(0).describe("Metres of open sea along the outward normal before land or the world limit, capped at 3000."),
    facing: z.number().min(-1).max(1).describe("Cosine between the outward normal and the direction the wind comes from (1 = straight into it)."),
    slopeBehind: z.number().min(0).describe("Mean ground gradient (rise over run) 40-120 m inland of the shoreline, on the natural ground."),
    concave: z.boolean().describe("True in a bay (the shoreline bends round the sea here), false on a headland."),
    mud: z.boolean().default(false).describe("A river mouth or a marsh water table meets the sea on this segment (mudflat eligibility)."),
    length: z.number().positive().describe("Metres of shoreline."),
    region: z.string().optional().describe("recipe.regions id whose `coast` rules typed it (absent = the defaults; zones are drawn later)."),
    stretch: z.string().optional().describe("sheer-cliff only: id of the `terrain.seaCliffs` stretch (`coast-*`) that builds its wall; one stretch per run of cliff segments."),
    reach: z.number().positive().default(140).describe("Metres either side of `points` the segment's field parameters hold (blended with its neighbours by distance)."),
    topEdge: z
      .number()
      .min(16)
      .optional()
      .describe(
        "sheer-cliff only, set by `worldgen coast-top`: metres the stretch's LEVEL top runs inland from the lip (its `edge`) so a " +
          "landmark can stand on it; the stage keeps it across re-runs by segment id and `coast --check` measures the flat square there.",
      ),
    reason: z.string().default("").describe("Why the stage chose the type (log text; the field does not read it)."),
  })
  .describe("One shoreline segment of the coast plan.");
export type CoastSegmentDoc = z.infer<typeof coastSegmentSchema>;

export const coastSegmentsSchema = z
  .array(coastSegmentSchema)
  .describe(
    "THE COAST PLAN, written by `worldgen coast` (after continents, before rivers): the shoreline of every landmass cut into " +
      "segments at headland/bay inflections and by exposure, each given one coast type. The field reads it as a pure function of " +
      "(x, z): per-segment `terrain.coast` ruggedness, the coastal biomes' height window scale and the mudflat paint (coast-plan.ts); " +
      "sheer-cliff segments are built by `terrain.seaCliffs` stretches with ids `coast-*` that the stage writes beside them. " +
      "Absent = the shore is the noise alone, byte for byte. `worldgen coast --check` is the gate; `worldgen continents` drops it.",
  );

export interface CoastSample {
  /** Hold of the plan at this column, 0..1 (0 = the ordinary coast, nothing else is meaningful). */
  w: number;
  /** Share of the hold carried by segments that set a ruggedness (sheer-cliff segments leave the noise alone). */
  ruggedHold: number;
  /** The planned `terrain.coast` ruggedness, 0..1, where `ruggedHold` > 0. */
  rugged: number;
  /** Scale on the coastal biomes' height window (1 = unchanged). */
  beach: number;
  /** Mudflat paint 0..1. */
  mud: number;
}

export interface CoastPlan {
  /** Union bounding box of every segment's reach (x0, z0, x1, z1): outside it nothing changes. */
  readonly bbox: readonly [number, number, number, number];
  readonly segments: readonly CoastSegmentDoc[];
  /** True when some segment is a mudflat (the paint hook is worth running). */
  readonly anyMud: boolean;
  /** The plan at a column, written into `out`; returns `out.w`. */
  sample(x: number, z: number, out: CoastSample): number;
  newSample(): CoastSample;
  /** The nearest segment within its reach of (x, z): its index and plan distance, or null. For tools. */
  nearest(x: number, z: number): { k: number; d: number } | null;
}

function distToPolyline(points: readonly (readonly [number, number])[], x: number, z: number): number {
  let best = Infinity;
  const n = points.length;
  if (n === 1) return Math.hypot(x - points[0]![0], z - points[0]![1]);
  for (let i = 0; i + 1 < n; i++) {
    const a = points[i]!, b = points[i + 1]!;
    const dx = b[0] - a[0], dz = b[1] - a[1], len = dx * dx + dz * dz;
    const t = len < 1e-9 ? 0 : Math.max(0, Math.min(1, ((x - a[0]) * dx + (z - a[1]) * dz) / len));
    const d = Math.hypot(x - (a[0] + dx * t), z - (a[1] + dz * t));
    if (d < best) best = d;
  }
  return best;
}

/** Lattice spacing of the cached plan (metres). */
const L = 8;
/** Metres added to a segment's distance in the blend kernel: two segments meeting at a junction hand over across about this. */
const KERNEL_SOFT = 6;
/** Channels per lattice node. */
const CH = 5;

export function createCoastPlan(docs: readonly CoastSegmentDoc[]): CoastPlan {
  const segs = docs.map((doc) => {
    let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
    for (const [px, pz] of doc.points) { x0 = Math.min(x0, px); z0 = Math.min(z0, pz); x1 = Math.max(x1, px); z1 = Math.max(z1, pz); }
    const pad = doc.reach + L;
    const f = COAST_TYPE_FIELD[doc.type];
    return { doc, bbox: [x0 - pad, z0 - pad, x1 + pad, z1 + pad] as const, rugged: f.rugged, beach: f.beach, mud: f.mud };
  });
  let bx0 = Infinity, bz0 = Infinity, bx1 = -Infinity, bz1 = -Infinity;
  for (const s of segs) { bx0 = Math.min(bx0, s.bbox[0]); bz0 = Math.min(bz0, s.bbox[1]); bx1 = Math.max(bx1, s.bbox[2]); bz1 = Math.max(bz1, s.bbox[3]); }
  const bbox = segs.length ? ([bx0, bz0, bx1, bz1] as const) : ([0, 0, -1, -1] as const);
  const anyMud = segs.some((s) => s.mud > 0);

  const nodes = new Map<number, Float32Array>();
  const EMPTY = new Float32Array(CH);
  const nodeAt = (I: number, K: number): Float32Array => {
    const key = (I + 1048576) * 2097152 + (K + 1048576);
    let n = nodes.get(key);
    if (n) return n;
    if (nodes.size > 400000) nodes.clear();
    const x = I * L, z = K * L;
    let w = 0, sumK = 0, sumR = 0, sumRk = 0, sumB = 0, sumM = 0;
    for (const s of segs) {
      if (x < s.bbox[0] || x > s.bbox[2] || z < s.bbox[1] || z > s.bbox[3]) continue;
      const d = distToPolyline(s.doc.points, x, z);
      const reach = s.doc.reach;
      if (d >= reach) continue;
      const hold = 1 - smoothstep(reach * 0.75, reach, d);
      if (hold <= 0) continue;
      const k = hold / ((d + KERNEL_SOFT) * (d + KERNEL_SOFT));
      w = Math.max(w, hold);
      sumK += k;
      if (s.rugged !== null) { sumRk += k; sumR += k * s.rugged; }
      sumB += k * s.beach;
      sumM += k * s.mud;
    }
    n = w > 0 ? Float32Array.of(w, sumRk / sumK, sumRk > 0 ? sumR / sumRk : 0, sumB / sumK, sumM / sumK) : EMPTY;
    nodes.set(key, n);
    return n;
  };

  return {
    bbox,
    segments: docs,
    anyMud,
    newSample: () => ({ w: 0, ruggedHold: 0, rugged: 0, beach: 1, mud: 0 }),
    sample(x, z, out) {
      out.w = 0; out.ruggedHold = 0; out.rugged = 0; out.beach = 1; out.mud = 0;
      if (x < bx0 || x > bx1 || z < bz0 || z > bz1) return 0;
      const fx = x / L, fz = z / L, I = Math.floor(fx), K = Math.floor(fz), tx = fx - I, tz = fz - K;
      const a = nodeAt(I, K), b = nodeAt(I + 1, K), c = nodeAt(I, K + 1), e = nodeAt(I + 1, K + 1);
      const wa = (1 - tx) * (1 - tz), wb = tx * (1 - tz), wc = (1 - tx) * tz, we = tx * tz;
      const w = a[0]! * wa + b[0]! * wb + c[0]! * wc + e[0]! * we;
      if (w <= 1e-4) return 0;
      // the parameter channels are blended weighted by each node's hold, so an empty node beside a held one does not
      // pull the beach scale toward "1" or the ruggedness toward 0 across the reach edge
      const ha = a[0]! * wa, hb = b[0]! * wb, hc = c[0]! * wc, he = e[0]! * we, hs = ha + hb + hc + he;
      const inv = 1 / hs;
      out.w = w;
      out.ruggedHold = (a[1]! * ha + b[1]! * hb + c[1]! * hc + e[1]! * he) * inv;
      const rh = a[1]! * ha + b[1]! * hb + c[1]! * hc + e[1]! * he;
      out.rugged = rh > 1e-9 ? (a[2]! * a[1]! * ha + b[2]! * b[1]! * hb + c[2]! * c[1]! * hc + e[2]! * e[1]! * he) / rh : 0;
      out.beach = (a[3]! * ha + b[3]! * hb + c[3]! * hc + e[3]! * he) * inv;
      out.mud = (a[4]! * ha + b[4]! * hb + c[4]! * hc + e[4]! * he) * inv;
      return w;
    },
    nearest(x, z) {
      let best: { k: number; d: number } | null = null;
      segs.forEach((s, k) => {
        if (x < s.bbox[0] || x > s.bbox[2] || z < s.bbox[1] || z > s.bbox[3]) return;
        const d = distToPolyline(s.doc.points, x, z);
        if (d < s.doc.reach && (!best || d < best.d)) best = { k, d };
      });
      return best;
    },
  };
}

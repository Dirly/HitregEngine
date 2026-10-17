/**
 * Sea cliffs, "Cliffs of Moher" style (opt-in, `terrain.seaCliffs`).
 *
 * A stretch of coast is rebuilt as ONE sheer wall from a flat grassy top
 * straight into the sea. The ordinary coast (`boundAt` + `coastAt`) compresses
 * relief toward the waterline, so a coast is a lowland meeting the water; here
 * the land within a stretch is replaced, near the shoreline, by a profile:
 *
 * - the TOP: flat at a cliff-top height that wanders along the coast (60-200 m),
 *   running right to the edge, then joining the natural land inland over a long
 *   gentle back-slope;
 * - the WALL: where the PLAN function `q` crosses 0. `q` is the shoreline
 *   distance (field `shoreAt`, metres inland) plus a headland-and-bay noise and
 *   piecewise-planar jogs (one plane per Voronoi cell), so the wall follows the
 *   coast in headlands and bays made of flat faces;
 * - the FOOT: a narrow wave-cut platform just awash, or deep water, chosen by a
 *   slow noise; no beach;
 * - offshore STACKS (prisms with planar sides) and the odd ARCH (a stack joined to
 *   the wall by a fin with an opening through it).
 *
 * The heightfield carries the profile (the wall is a near-step over a metre or
 * two), so marching cubes, the map, placement and the water read it as before.
 * With `terrain.planarCliffs` (profile 'terrace') the planar path additionally
 * evaluates {@link SeaCliffs.density}: the wall exactly vertical at `q = 0`,
 * pushed out by HORIZONTAL strata (each band its own offset, a crisp lip on its
 * top), a crisp lip at the cliff top, planar stack faces and the arch opening.
 *
 * Every term is continuous, seed-stable and a pure function of (x, z) (or
 * (x, y, z)), so the client, the server and every chunk agree. A world without
 * `terrain.seaCliffs` never constructs any of this.
 */

import { z } from "zod";
import { fbm2, hash3i, smoothstep, type FbmSpec } from "./noise.js";
import { createPlanarCliffs, planarCliffsSchema, type PlanarCliffs } from "./planar-cliffs.js";
import { bandPushAt, capRockBands, chamferedPlan, segmentPlanDistance, type SegmentPlan } from "./buttes.js";

const pair = (d: string) => z.tuple([z.number(), z.number()]).describe(d);

export const seaStackShapeSchema = z
  .object({
    plan: z
      .enum(["chamfer", "fin", "mixed"])
      .default("chamfer")
      .describe(
        "Plan of every stack: 'chamfer' = a rectangle with each corner chamfered by its own amount and notches bitten in " +
          "(Moher), 'fin' = a thin blade, long and narrow (Pyke spires), 'mixed' = a share `fins` of fins. Straight segments, never a circle.",
      ),
    fins: z.number().min(0).max(1).default(0.35).describe("With plan 'mixed': share of stacks that are fins."),
    elongation: pair("[min, max] long-axis / short-axis ratio of a chamfered plan (area kept: half-axes radius x sqrt(e) and radius / sqrt(e)).").default([1.1, 1.7]),
    finElongation: pair("[min, max] the same ratio for a fin.").default([2.2, 3.2]),
    notches: pair("[min, max] notches bitten into a chamfered plan's long edges (fins get none).").default([0, 2]),
    tiers: pair("[min, max] set-backs up the wall: the stack narrows in steps going up, each a shelf (girth variation). 0 = one straight wall.").default([0, 2]),
    girth: pair("[min, max] metres each set-back steps in.").default([1.2, 3]),
    ledges: pair("[min, max] thin ledges (0.7 m out, 2.2 m thick) on the wall between the foot and the cap band, at uneven heights.").default([2, 3]),
    strata: z.number().min(0).max(1).default(0.25).describe("Share of the stretch's even strata push kept on the stacks (1 = the wall's stripes in full: they read as stacked crates)."),
    cap: pair("[min, max] cap band thickness as a fraction of the stack's height over the sea.").default([0.1, 0.18]),
    lip: pair("[min, max] metres the cap band stands out over the wall under it (the overhanging lip; a further 0.6 m weathered edge on its top 2 m).").default([0.8, 1.6]),
    recess: z.number().min(0).max(3).default(0.9).describe("Metres the band just under the cap is cut in (the recess that makes the lip read)."),
    waveNotch: z
      .object({
        depth: pair("[min, max] metres the wave-cut notch bites into the foot of the wall.").default([1.2, 2.4]),
        height: pair("[min, max] metres tall the notch is.").default([2.2, 4]),
      })
      .prefault({})
      .describe("The wave-cut notch at the waterline, just over the boulder apron."),
    apron: z
      .object({
        reach: pair("[min, max] metres the boulder apron reaches out from the foot of the wall.").default([6, 14]),
        height: pair("[min, max] metres over the sea the apron stands at the wall (concave, down to the sea floor at its reach).").default([1.5, 3.5]),
        boulders: z.number().min(0).max(3).default(1.1).describe("Metres of blocky boulder relief on the apron."),
      })
      .prefault({})
      .describe("Boulder/talus apron round the foot. reach [0, 0] = none."),
  })
  .describe(
    "OPT-IN stack shape language (absent = the plain faceted prism, byte for byte): chamfered/notched or fin plans, set-backs, " +
      "thin ledges, a cap band with an overhanging lip and a recess, a wave-cut notch and a boulder apron. Seed-stable per stack; " +
      "every stack keeps its site, radius and top. The top stays flat (walkable: rope-bridge anchors).",
  );
export type SeaStackShapeDoc = z.infer<typeof seaStackShapeSchema>;

export const seaCliffSchema = z
  .object({
    id: z.string().optional().describe("Name of this stretch (tools and logs)."),
    region: z
      .string()
      .optional()
      .describe(
        "recipe.regions id: the stretch is that zone's coast, plus `reach` metres outside its polygon so the foot, " +
          "platform and stacks offshore are included. Set this or `along` (both = their overlap).",
      ),
    along: z
      .array(z.tuple([z.number(), z.number()]))
      .min(2)
      .optional()
      .describe("[x, z] polyline drawn along the coast: the stretch is everything within `reach` metres of it. The usual way to pick one stretch of a zone's coast."),
    reach: z.number().positive().default(340).describe("Metres from `along` (or outside the region) the profile holds in full. Cover the top's inland join (`edge` + `inland`) and the stacks offshore."),
    fade: z.number().positive().default(220).describe("Metres over which the stretch hands back to the ordinary coast: along the coast the wall lowers to a bluff over this run and ends."),
    height: pair("[min, max] metres of the cliff top over sea level, wandering along the coast (the Cliffs of Moher run 120-214 m).").default([70, 150]),
    heightScale: z.number().positive().default(800).describe("Metres per cycle of the cliff-top height wander."),
    edge: z.number().min(16).default(36).describe("Metres the flat top runs inland from the lip before it starts to join the natural land."),
    inland: z.number().positive().default(260).describe("Metres over which the top joins the natural ground inland: a long, gentle back-slope."),
    undulation: z.number().min(0).default(1.6).describe("Metres of gentle relief on the cliff top (0 = a level table)."),
    plan: z
      .object({
        amplitude: z.number().min(0).default(34).describe("Metres the wall line moves off the natural coastline: where the noise is positive a headland is built out to sea, where negative a bay is cut in. Keep amplitude / scale under ~0.1, or the line folds back on itself into thin spits."),
        scale: z.number().positive().default(420).describe("Metres per headland-and-bay cycle."),
        cell: z.number().positive().default(44).describe("Metres per flat plane of wall (one Voronoi cell); neighbouring planes meet at a joint."),
        jog: z.number().min(0).default(4).describe("Metres a wall plane may stand off the smooth line (keep it <= 5: the heightfield and the planar wall must stay within a few metres)."),
        seed: z.number().int().default(557),
      })
      .prefault({})
      .describe("The wall's plan: headlands and bays, built of flat planes."),
    strata: z
      .object({
        thickness: z.number().positive().default(6).describe("Metres per horizontal band (shale/sandstone layers). At least ~4 voxels."),
        offset: z.number().min(0).default(2.2).describe("Metres a band can stand out of the wall: neighbouring bands make ledges and set-backs."),
        lip: z.number().min(0).default(0.9).describe("Extra metres the top of each band juts out (a ledge with a planar underside)."),
        lipHeight: z.number().min(0).max(0.5).default(0.25).describe("Fraction of a band the lip occupies."),
        ramp: z.number().positive().default(1.2).describe("Metres over which one band hands over to the next (near the voxel size)."),
        dip: z.number().min(0).max(0.3).default(0.02).describe("Radians the bands tilt (0 = dead level)."),
        azimuth: z.number().default(0.6).describe("Radians: dip direction."),
        seed: z.number().int().default(37),
      })
      .prefault({})
      .describe("Horizontal strata in the wall (planar path only: marching cubes rounds them away)."),
    platform: z
      .object({
        share: z.number().min(0).max(1).default(0.6).describe("Share of the stretch with a wave-cut platform at the foot; the rest drops straight into deep water."),
        width: pair("[min, max] metres of platform out from the wall.").default([6, 16]),
        level: pair("[min, max] metres of the platform over sea level: a little under it is awash (foam, breakers), a little over is a dry boulder shelf.").default([-0.7, 0.25]),
        scale: z.number().positive().default(280).describe("Metres per cycle of the platform/deep-water noise."),
      })
      .prefault({})
      .describe("The wall's foot: a narrow wave-cut platform, or deep water."),
    depth: z.number().positive().default(14).describe("Metres of water at the wall's foot where there is no platform."),
    stacks: z
      .object({
        cell: z.number().positive().default(80).describe("Metres per stack site (a jittered grid)."),
        density: z.number().min(0).max(1).default(0.3).describe("Share of sites holding a stack (only sites in the `offshore` band count)."),
        offshore: pair("[min, max] metres off the wall a stack may stand.").default([20, 120]),
        radius: pair("[min, max] metres from a stack's centre to its faces at the top.").default([8, 18]),
        height: pair("[min, max] stack top as a fraction of the cliff top's height over the sea.").default([0.4, 0.92]),
        sides: pair("[min, max] planar faces per stack.").default([4, 7]),
        taper: z.number().min(0).max(0.15).default(0.04).describe("Metres of radius a stack gains per metre down from its top (a sea stack is broader at the waterline)."),
        irregular: z.number().min(0).max(0.5).default(0.3).describe("How far each face stands in or out of the regular prism, as a fraction of the radius."),
        arch: z.number().min(0).max(1).default(0.35).describe("Share of stacks near the wall (18-70 m off it) joined to it by a fin with an arch through it."),
        shape: seaStackShapeSchema.optional(),
        seed: z.number().int().default(911),
      })
      .prefault({})
      .describe("Sea stacks and arches offshore. density 0 = none."),
    turf: z
      .object({
        zone: z
          .string()
          .optional()
          .describe("recipe.regions id whose ground roles (regions[].ground: grass, ground, cliff...) paint the whole stretch, stacks offshore included. Default: the stretch's `region`."),
        surface: z
          .string()
          .optional()
          .describe("A palette surface (e.g. the zone's `rockCap.layer` turf) laid over the flat tops of the cliff and the stacks."),
        amount: z.number().min(0).max(1).default(1).describe("How much of the zone's ground (and `surface`) the stretch takes."),
      })
      .optional()
      .describe(
        "OPT-IN: the stretch's tops take the zone's turf. Stacks stand offshore, outside the zone polygon, so without this their " +
          "tops (and the lip band, where zone ground fades over its border band) fall back to the base palette's dry grass and dirt.",
      ),
    clearance: pair("Metres from a town, road, river, lake or big fill over which the profile fades in (none inside the first, full past the second): coastal paths and towns keep their ground. POIs and height patches are NOT cleared: a patch levels its own footprint over the finished wall and stacks.").default([40, 90]),
    seed: z.number().int().default(0),
  })
  .describe("One stretch of sea cliffs.");

export const seaCliffsSchema = z
  .array(seaCliffSchema)
  .describe(
    "OPT-IN sea cliffs ('Cliffs of Moher'): stretches of coast rebuilt as sheer 60-200 m walls straight into the sea — a flat " +
      "top running to a crisp lip, the wall plan following the coast in headlands and bays, a narrow wave-cut platform or deep " +
      "water at the foot, no beach, stacks and arches offshore. Needs `bounds` with a shore profile (landFloor > 0). The " +
      "heightfield carries the profile (marching cubes draws it); with `terrain.planarCliffs` (profile 'terrace') the wall is " +
      "exactly vertical with horizontal strata ledges and planar stacks. Stretches must not overlap. Absent = unchanged, byte for byte.",
  );

export type SeaCliffDoc = z.infer<typeof seaCliffSchema>;

/** What the field supplies. */
export interface SeaCliffContext {
  seaLevel: number;
  seed: number;
  /** Signed metres inland of the natural coastline (the field's shore distance; 0 on the shoreline). */
  shore: (x: number, z: number) => number;
  /** A region's polygon, or null. */
  region: (id: string) => readonly (readonly [number, number])[] | null;
  /** Things the profile keeps clear of: polylines (or single points) with a radius. Recipe data, not solved data. */
  obstacles: readonly { points: readonly (readonly [number, number])[]; radius: number; closed?: boolean }[];
}

/** One evaluation of the plan at a column: what the density and the paint read. */
export interface SeaColumn {
  /** Stretch weight 0..1 (0 = this column is the ordinary coast). */
  w: number;
  /** The profile's hold on the ground (smoothstep of `w`). */
  b: number;
  /** Plan distance: metres inland of the wall (negative = seaward). */
  q: number;
  /** Cliff-top level and the foot level just off the wall (closed form). */
  top: number;
  foot: number;
  /** Nearest stack's signed planar distance at its top (metres, negative inside), its top and taper; Infinity = none near. */
  stack: number;
  stackTop: number;
  stackTaper: number;
  /** ...and at the waterline, where the stack is widest (what the heightfield and the masks use). */
  stackBase: number;
  /** Metres outside the stack's apron (stackBase minus the apron's reach; = stackBase for an unshaped stack). */
  stackOut: number;
  /** The nearest stack's shape (`stacks.shape`), or null for the plain prism. Internal. */
  stackShape: StackShape | null;
  /** Fin (arch) signed distance and its top; Infinity = none near. */
  fin: number;
  finTop: number;
  /** The arch opening across the fin: the column's metres along the fin, the vault's middle, half-length, height and springing level (holeA 0 = none). */
  holeAlong: number;
  holeMid: number;
  holeA: number;
  holeB: number;
  holeY: number;
  /** Which stretch (internal). */
  k: number;
}

export interface SeaCliffs {
  /** Union bounding box of every stretch (x0, z0, x1, z1): outside it nothing changes. */
  readonly bbox: readonly [number, number, number, number];
  /** The profile over the natural height `h` at (x, z). */
  height(x: number, z: number, h: number): number;
  /** The column's plan values; returns `out.b` (0 = not in a stretch). */
  column(x: number, z: number, out: SeaColumn): number;
  /**
   * The planar density near the wall and the stacks (metric; negative = rock), given the lattice height `hb` at
   * the point (the heightfield the profile built). Only meaningful where {@link weight} > 0.
   */
  density(x: number, y: number, z: number, hb: number, col: SeaColumn): number;
  /** Weight of {@link density} at a point (0..1): near the wall, seaward of it, and round the stacks. */
  weight(col: SeaColumn): number;
  /** Column mask for the planar path (a little wider than {@link weight}'s support). */
  mask(col: SeaColumn): number;
  /** Rock paint 0..1 at a surface point: the platform, the wall's foot and the stack bases (no beach). */
  rock(x: number, y: number, z: number): number;
  /** Highest rock (y) the profile can put at or near (x, z) — the planar band's top. */
  ceiling(col: SeaColumn): number;
  /** A fresh column record for {@link column}. */
  newColumn(): SeaColumn;
  /** The stacks (and arches) whose centres fall in the rectangle: for tools, cameras and surf. */
  stacksIn(x0: number, z0: number, x1: number, z1: number): SeaStack[];
  /**
   * Points along the foot of the wall (and round the stacks) where rock rises straight out of the water, about
   * `spacing` metres apart, with the seaward normal: where surf breaks. `height` is the field's heightfield.
   */
  surfIn(x0: number, z0: number, x1: number, z1: number, spacing: number, height: (x: number, z: number) => number): SeaSurfPoint[];
  /**
   * `turf`: how much (0..1, `turf.amount` x the stretch's hold) of the stretch whose turf reaches (x, z) — its index in
   * `out.k` (-1 = none). Always 0 for a stretch without `turf`.
   */
  turf(x: number, z: number, out: { k: number; w: number }): number;
  /** True when some stretch has `stacks.shape` (shaped stacks, boulder aprons). */
  readonly shaped: boolean;
  /** True on a shaped stack's boulder apron (outside its foot, inside the apron's reach): bare rock, nothing grows. */
  apron(x: number, z: number): boolean;
}

export interface SeaStack {
  x: number; z: number; radius: number; top: number; arch: boolean;
  /** Shaped stacks: metres from the centre the top's plan reaches, and the whole footprint's (foot, set-backs, apron). */
  extent?: number;
  footprint?: number;
}

/** A shaped stack, resolved (`stacks.shape`). Plan in its own frame (rotation c, s). */
export interface StackShape extends SegmentPlan {
  c: number; s: number;
  /** Push breakpoints [y, out, ...] (set-backs, ledges, recess, cap band, wave notch), read by bandPushAt. */
  bands: number[];
  /** Metres the widest band and the taper reach out past the top's plan: the foot = plan distance - this. */
  out: number;
  apronR: number; apronH: number; boulders: number;
  strata: number;
  /** Plan reach from the centre at the top (max corner distance), and of everything the stack changes (foot, apron). */
  extent: number;
  footprint: number;
}
export interface SeaSurfPoint { x: number; z: number; nx: number; nz: number; height: number }

const U32 = 4294967296;

function distToPolyline(points: readonly (readonly [number, number])[], x: number, z: number, closed = false): number {
  let best = Infinity;
  const n = points.length;
  if (n === 1) return Math.hypot(x - points[0]![0], z - points[0]![1]);
  for (let i = 0; i < (closed ? n : n - 1); i++) {
    const a = points[i]!, b = points[(i + 1) % n]!;
    const dx = b[0] - a[0], dz = b[1] - a[1], len = dx * dx + dz * dz;
    const t = len < 1e-9 ? 0 : Math.max(0, Math.min(1, ((x - a[0]) * dx + (z - a[1]) * dz) / len));
    const d = Math.hypot(x - (a[0] + dx * t), z - (a[1] + dz * t));
    if (d < best) best = d;
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

interface Stretch {
  doc: SeaCliffDoc;
  bbox: [number, number, number, number];
  region: readonly (readonly [number, number])[] | null;
  obstacles: SeaCliffContext["obstacles"];
  planSpec: FbmSpec;
  topSpec: FbmSpec;
  undulSpec: FbmSpec;
  platSpec: FbmSpec;
  platWSpec: FbmSpec;
  pc: PlanarCliffs;
  seed: number;
}

export function createSeaCliffs(docs: readonly SeaCliffDoc[], ctx: SeaCliffContext): SeaCliffs {
  const sea = ctx.seaLevel;
  const stretches: Stretch[] = docs.map((doc, i) => {
    const region = doc.region ? ctx.region(doc.region) : null;
    const pts = doc.along ?? region ?? [];
    let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
    for (const [px, pz] of pts) { x0 = Math.min(x0, px); z0 = Math.min(z0, pz); x1 = Math.max(x1, px); z1 = Math.max(z1, pz); }
    const pad = doc.reach + doc.fade + 8;
    const bbox: [number, number, number, number] = pts.length ? [x0 - pad, z0 - pad, x1 + pad, z1 + pad] : [0, 0, -1, -1];
    const seed = (ctx.seed + doc.seed * 7919 + i * 104729) | 0;
    const near = ctx.obstacles.filter((o) => o.points.some(([px, pz]) => px > bbox[0] - o.radius - doc.clearance[1] && px < bbox[2] + o.radius + doc.clearance[1] && pz > bbox[1] - o.radius - doc.clearance[1] && pz < bbox[3] + o.radius + doc.clearance[1]));
    const strata = planarCliffsSchema.parse({ strata: { ...doc.strata, seed: doc.strata.seed + doc.seed }, facets: { depth: 0 }, profile: "warp" });
    return {
      doc,
      bbox,
      region,
      obstacles: near,
      // two octaves: the line's gradient must stay under the shore distance's (~1 per metre), or the wall folds back
      // on itself into knife-thin spits
      planSpec: { frequency: 1 / doc.plan.scale, amplitude: 1, octaves: 2, lacunarity: 2, gain: 0.4, ridged: false, seed: doc.plan.seed },
      topSpec: { frequency: 1 / doc.heightScale, amplitude: 1, octaves: 2, lacunarity: 2, gain: 0.5, ridged: false, seed: doc.plan.seed + 17 },
      undulSpec: { frequency: 1 / 110, amplitude: 1, octaves: 2, lacunarity: 2, gain: 0.5, ridged: false, seed: doc.plan.seed + 29 },
      platSpec: { frequency: 1 / doc.platform.scale, amplitude: 1, octaves: 2, lacunarity: 2, gain: 0.5, ridged: false, seed: doc.plan.seed + 41 },
      platWSpec: { frequency: 1 / 90, amplitude: 1, octaves: 2, lacunarity: 2, gain: 0.5, ridged: false, seed: doc.plan.seed + 53 },
      pc: createPlanarCliffs(strata, seed),
      seed,
    };
  });
  let bx0 = Infinity, bz0 = Infinity, bx1 = -Infinity, bz1 = -Infinity;
  for (const s of stretches) { bx0 = Math.min(bx0, s.bbox[0]); bz0 = Math.min(bz0, s.bbox[1]); bx1 = Math.max(bx1, s.bbox[2]); bz1 = Math.max(bz1, s.bbox[3]); }
  const bbox = [bx0, bz0, bx1, bz1] as const;
  const anyTurf = stretches.some((s) => s.doc.turf !== undefined);

  // ---- stretch weight on a 16 m lattice (cached, then bilinear): a pure function of (x, z)
  const L = 16;
  const nodes = new Map<number, Float32Array>();
  const nodeW = (I: number, K: number): Float32Array => {
    const key = (I + 1048576) * 2097152 + (K + 1048576);
    let n = nodes.get(key);
    if (n) return n;
    if (nodes.size > 200000) nodes.clear();
    n = new Float32Array(stretches.length);
    const x = I * L, z = K * L;
    stretches.forEach((s, k) => {
      const d = s.doc;
      if (x < s.bbox[0] || x > s.bbox[2] || z < s.bbox[1] || z > s.bbox[3]) return;
      let w = 1;
      if (d.along) w *= 1 - smoothstep(d.reach, d.reach + d.fade, distToPolyline(d.along, x, z));
      if (s.region && w > 0) {
        const sd = (insidePolygon(s.region, x, z) ? 1 : -1) * distToPolyline(s.region, x, z, true);
        w *= smoothstep(-(d.reach + d.fade), -d.reach, sd);
      }
      if (w > 0) {
        let clear = Infinity;
        for (const o of s.obstacles) {
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
  const wScratch = new Float32Array(Math.max(1, stretches.length));
  /** Index of the stretch holding (x, z) (the heaviest), weight in wScratch[0]; -1 = none. */
  const stretchAt = (x: number, z: number): number => {
    if (x < bx0 || x > bx1 || z < bz0 || z > bz1) return -1;
    const fx = x / L, fz = z / L, I = Math.floor(fx), K = Math.floor(fz), tx = fx - I, tz = fz - K;
    const a = nodeW(I, K), b = nodeW(I + 1, K), c = nodeW(I, K + 1), e = nodeW(I + 1, K + 1);
    let best = -1, bw = 0;
    for (let k = 0; k < stretches.length; k++) {
      const w = (a[k]! * (1 - tx) + b[k]! * tx) * (1 - tz) + (c[k]! * (1 - tx) + e[k]! * tx) * tz;
      if (w > bw) { bw = w; best = k; }
    }
    wScratch[0] = bw;
    return best;
  };

  // ---- the smooth terms (shore distance, headland noise, cliff-top height, platform) on a 2 m lattice, cached and
  // bilinear between nodes: the shore distance alone is six fBm evaluations, and dual contouring's Hermite
  // refinement reads a fresh column at nearly every evaluation. One pure function of (x, z) for the heightfield,
  // the block and the point query alike.
  const SL = 2, SN = 7, NSLOT = 1 << 17, NMASK = NSLOT - 1;
  // a direct-mapped cache (a miss recomputes the same pure value)
  const slotI = new Int32Array(NSLOT).fill(-2147483648), slotK = new Int32Array(NSLOT), slotS = new Int32Array(NSLOT), slotV = new Float64Array(NSLOT * SN);
  /** Index into slotV of node (I, K) of stretch k. */
  const smoothNode = (k: number, I: number, K: number): number => {
    const h = (Math.imul(I, 73856093) ^ Math.imul(K, 19349663) ^ Math.imul(k + 1, 83492791)) & NMASK;
    if (slotI[h] === I && slotK[h] === K && slotS[h] === k) return h * SN;
    const s = stretches[k]!, x = I * SL, z = K * SL, p = s.doc.platform;
    const [h0, h1] = s.doc.height;
    const pn = fbm2(s.platSpec, x, z, s.seed) * 0.5 + 0.5, pv = fbm2(s.platWSpec, x, z, s.seed) * 0.5 + 0.5;
    const pw = 1 - smoothstep(p.share - 0.06, p.share + 0.06, pn);
    const o = h * SN;
    slotV[o] = ctx.shore(x, z);
    slotV[o + 1] = s.doc.plan.amplitude * fbm2(s.planSpec, x, z, s.seed);
    slotV[o + 2] = h0 + (h1 - h0) * smoothstep(0.15, 0.85, fbm2(s.topSpec, x, z, s.seed) * 0.5 + 0.5);
    slotV[o + 3] = s.doc.undulation * fbm2(s.undulSpec, x, z, s.seed);
    slotV[o + 4] = pw;
    slotV[o + 5] = (p.width[0] + (p.width[1] - p.width[0]) * pv) * pw;
    slotV[o + 6] = p.level[0] + (p.level[1] - p.level[0]) * (1 - pv);
    slotI[h] = I; slotK[h] = K; slotS[h] = k;
    return o;
  };

  const sm = new Float64Array(SN);
  /** The smooth terms at (x, z) into `sm`: [shore, plan noise, full top, undulation, platform, width, level]. */
  const smoothAt = (k: number, x: number, z: number): Float64Array => {
    const fx = x / SL, fz = z / SL, I = Math.floor(fx), K = Math.floor(fz), tx = fx - I, tz = fz - K;
    const w00 = (1 - tx) * (1 - tz), w10 = tx * (1 - tz), w01 = (1 - tx) * tz, w11 = tx * tz;
    // each corner is read as soon as it is fetched (a later corner may land in the same slot)
    let o = smoothNode(k, I, K);
    for (let i = 0; i < SN; i++) sm[i] = slotV[o + i]! * w00;
    o = smoothNode(k, I + 1, K);
    for (let i = 0; i < SN; i++) sm[i] = sm[i]! + slotV[o + i]! * w10;
    o = smoothNode(k, I, K + 1);
    for (let i = 0; i < SN; i++) sm[i] = sm[i]! + slotV[o + i]! * w01;
    o = smoothNode(k, I + 1, K + 1);
    for (let i = 0; i < SN; i++) sm[i] = sm[i]! + slotV[o + i]! * w11;
    return sm;
  };
  const smoothPlan = (s: Stretch, x: number, z: number): number => { const v = smoothAt(stretches.indexOf(s), x, z); return v[0]! + v[1]!; };
  const planSites = new Map<number, Float64Array>();
  const planSite = (s: Stretch, k: number, I: number, K: number): Float64Array => {
    const key = ((I + 32768) * 65536 + (K + 32768)) * 8 + k;
    let p = planSites.get(key);
    if (p) return p;
    if (planSites.size > 100000) planSites.clear();
    const F = s.doc.plan.cell;
    const sx = (I + 0.5 + (hash3i(I, K, 1, s.seed) / U32 - 0.5) * 0.85) * F;
    const sz = (K + 0.5 + (hash3i(I, K, 2, s.seed) / U32 - 0.5) * 0.85) * F;
    const e = 3;
    const v = smoothPlan(s, sx, sz);
    const gx = (smoothPlan(s, sx + e, sz) - smoothPlan(s, sx - e, sz)) / (2 * e);
    const gz = (smoothPlan(s, sx, sz + e) - smoothPlan(s, sx, sz - e)) / (2 * e);
    p = Float64Array.of(sx, sz, v, gx, gz, (hash3i(I, K, 3, s.seed) / U32 - 0.5) * 2);
    planSites.set(key, p);
    return p;
  };
  const d2 = new Float64Array(9);
  const near = new Array<Float64Array>(9);
  let nearI = NaN, nearK = NaN, nearS = -1;
  /** The wall planes' offset from the smooth line at a lattice node (the exact Voronoi function). */
  const jogExact = (k: number, x: number, z: number): number => {
    const s = stretches[k]!;
    const smooth = smoothPlan(s, x, z);
    let q = smooth;
    const jog = s.doc.plan.jog;
    {
      const F = s.doc.plan.cell, px = x / F, pz = z / F, I = Math.floor(px), K = Math.floor(pz);
      let bi = 0, n = 0;
      const same = I === nearI && K === nearK && k === nearS;
      nearI = I; nearK = K; nearS = k;
      for (let dk = -1; dk <= 1; dk++) for (let di = -1; di <= 1; di++, n++) {
        const st = same ? near[n]! : planSite(s, k, I + di, K + dk);
        near[n] = st;
        const ex = st[0]! / F - px, ez = st[1]! / F - pz;
        d2[n] = ex * ex + ez * ez;
        if (d2[n]! < d2[bi]!) bi = n;
      }
      const st = near[bi]!;
      let border = Infinity;
      for (let j = 0; j < 9; j++) {
        if (j === bi) continue;
        const o = near[j]!, ux = (o[0]! - st[0]!) / F, uz = (o[1]! - st[1]!) / F, l = Math.hypot(ux, uz);
        if (l < 1e-9) continue;
        const dd = (d2[j]! - d2[bi]!) / (2 * l);
        if (dd < border) border = dd;
      }
      const borderM = Math.max(0, border) * F;
      // the cell's plane of the smooth line, held within `jog`, plus a per-cell set-back; faded to the smooth line
      // towards the joint so neighbouring planes meet continuously
      // (the hand-over runs over 3 x jog: a shorter one turns the line faster than it advances and folds it into a fin)
      const plane = st[2]! + st[3]! * (x - st[0]!) + st[4]! * (z - st[1]!) + st[5]! * jog * 0.5;
      q = smooth + Math.max(-jog, Math.min(jog, plane - smooth)) * Math.min(1, borderM / Math.max(6, 3 * jog));
    }
    return q - smooth;
  };
  // ...cached on the same 2 m lattice (its own table: the planes read the smooth terms, never the other way round)
  const jI = new Int32Array(NSLOT).fill(-2147483648), jK = new Int32Array(NSLOT), jS = new Int32Array(NSLOT), jV = new Float64Array(NSLOT);
  const jogNode = (k: number, I: number, K: number): number => {
    const h = (Math.imul(I, 19349663) ^ Math.imul(K, 73856093) ^ Math.imul(k + 3, 83492791)) & NMASK;
    if (jI[h] === I && jK[h] === K && jS[h] === k) return jV[h]!;
    const v = jogExact(k, I * SL, K * SL);
    jI[h] = I; jK[h] = K; jS[h] = k; jV[h] = v;
    return v;
  };
  /** The plan distance at (x, z) for stretch k with weight w: shore distance + w x (headland noise + wall planes). */
  const planQ = (k: number, x: number, z: number, w: number, v: Float64Array = smoothAt(k, x, z)): number => {
    const sh = v[0]!, noise = v[1]!;
    let jog = 0;
    if (stretches[k]!.doc.plan.jog > 0) {
      const fx = x / SL, fz = z / SL, I = Math.floor(fx), K = Math.floor(fz), tx = fx - I, tz = fz - K;
      jog = (jogNode(k, I, K) * (1 - tx) + jogNode(k, I + 1, K) * tx) * (1 - tz) + (jogNode(k, I, K + 1) * (1 - tx) + jogNode(k, I + 1, K + 1) * tx) * tz;
    }
    return sh + (noise + jog) * w;
  };

  const topAt = (k: number, x: number, z: number, tS: number): number => {
    const v = smoothAt(k, x, z);
    return sea + 6 + (v[2]! - 6) * tS + v[3]! * tS;
  };
  /** The foot u metres seaward of the wall (closed form: what the planar path reads near the wall). */
  const footAt = (s: Stretch, pw: number, width: number, level: number, u: number, tS: number): number => {
    const deep = sea - s.doc.depth * (0.3 + 0.7 * tS);
    const top = deep + (sea + level - deep) * pw;
    if (u <= width) return top - 0.03 * u;
    const e = top - 0.03 * width;
    return e + (Math.min(deep, e) - e) * smoothstep(0, 4, u - width);
  };

  // ---- stacks: a jittered grid of sites, each a prism with planar sides (and maybe an arch fin to the wall)
  const stackSites = new Map<number, Float64Array | null>();
  /** [cx, cz, apothem, sides, rot, top, q at site, fin dir x, fin dir z, fin length (0 = none), fin half-width, then (cos, sin, set-out) per face] */
  const stackSite = (k: number, I: number, K: number): Float64Array | null => {
    const key = ((I + 32768) * 65536 + (K + 32768)) * 8 + k;
    const known = stackSites.get(key);
    if (known !== undefined) return known;
    if (stackSites.size > 50000) stackSites.clear();
    const s = stretches[k]!, st = s.doc.stacks;
    let out: Float64Array | null = null;
    const ss = (s.seed + st.seed * 31) | 0;
    if (st.density > 0 && hash3i(I, K, 7, ss) / U32 < st.density) {
      const cx = (I + 0.2 + 0.6 * (hash3i(I, K, 8, ss) / U32)) * st.cell;
      const cz = (K + 0.2 + 0.6 * (hash3i(I, K, 9, ss) / U32)) * st.cell;
      const w = (stretchAt(cx, cz), wScratch[0]!);
      if (w > 0.6) {
        const q = planQ(k, cx, cz, w);
        const r = st.radius[0] + (st.radius[1] - st.radius[0]) * (hash3i(I, K, 10, ss) / U32);
        if (-q >= st.offshore[0] + r && -q <= st.offshore[1]) {
          const sides = Math.round(st.sides[0] + (st.sides[1] - st.sides[0]) * (hash3i(I, K, 11, ss) / U32));
          const rot = (hash3i(I, K, 12, ss) / U32) * Math.PI * 2;
          const tS = smoothstep(0.1, 1, w);
          const frac = st.height[0] + (st.height[1] - st.height[0]) * (hash3i(I, K, 13, ss) / U32);
          const top = sea + (topAt(k, cx, cz, tS) - sea) * frac;
          const nS = Math.max(3, sides);
          out = new Float64Array(11 + 3 * nS);
          out.set([cx, cz, r, nS, rot, top, q, 0, 0, 0, 0]);
          for (let i = 0; i < nS; i++) {
            // each face turned and stood in or out a little: an eroded block, not a machined prism
            const a = rot + ((i + (hash3i(I, K, 20 + i, ss) / U32 - 0.5) * 0.5) / nS) * Math.PI * 2;
            out[11 + 3 * i] = Math.cos(a); out[12 + 3 * i] = Math.sin(a);
            out[13 + 3 * i] = r * st.irregular * ((hash3i(I, K, 40 + i, ss) / U32) * 2 - 1);
          }
          // an arch: a stack close to the wall, joined to it by a fin with an opening under it
          if (-q <= 70 && -q - r >= 12 && hash3i(I, K, 14, ss) / U32 < st.arch) {
            const e = 3;
            const gx = planQ(k, cx + e, cz, w) - planQ(k, cx - e, cz, w);
            const gz = planQ(k, cx, cz + e, w) - planQ(k, cx, cz - e, w);
            const l = Math.hypot(gx, gz);
            if (l > 1e-6) {
              out[7] = gx / l; out[8] = gz / l;
              out[9] = -q + 10; // past the wall into the headland
              out[10] = r * 0.6;
            }
          }
        }
      }
    }
    if (out && st.shape) shapes.set(out, buildShape(s, I, K, ss, out));
    stackSites.set(key, out);
    return out;
  };
  /** Planar prism distance (metres, negative inside). */
  const prism = (st: Float64Array, x: number, z: number): number => {
    const dx = x - st[0]!, dz = z - st[1]!, n = st[3]!;
    let d = -Infinity;
    for (let i = 0; i < n; i++) { const v = dx * st[11 + 3 * i]! + dz * st[12 + 3 * i]! - st[13 + 3 * i]!; if (v > d) d = v; }
    return d - st[2]!;
  };

  // ---- shaped stacks (`stacks.shape`): the site, radius and top above are untouched; the shape is built from
  // channels of its own (200+), so a world without `shape` reads exactly the prism it always did
  const shapes = new WeakMap<Float64Array, StackShape>();
  const buildShape = (s: Stretch, I: number, K: number, ss: number, st: Float64Array): StackShape => {
    const sh = s.doc.stacks.shape!;
    const r = (ch: number): number => hash3i(I, K, 200 + ch, ss) / U32;
    const lerp = (p: readonly [number, number], t: number): number => p[0] + (p[1] - p[0]) * t;
    const rad = st[2]!, top = st[5]!, rot = st[4]!, H = Math.max(4, top - sea);
    const fin = sh.plan === "fin" || (sh.plan === "mixed" && r(1) < sh.fins);
    // area kept: the plan's half-axes are radius x sqrt(e) and radius / sqrt(e)
    const e = Math.max(1, lerp(fin ? sh.finElongation : sh.elongation, r(2)));
    const A = rad * Math.sqrt(e), B = rad / Math.sqrt(e);
    const plan = chamferedPlan(A, B, r, fin ? 0.4 : 1, fin ? 0 : Math.round(lerp(sh.notches, r(3))), 2.5);
    /** The furthest point from the centre (360 rays, +0.5 m for the corners between them) where the plan distance is under `level` (a max of half-planes
     * reaches further at the corners than the plan offset by `level`: the mitre). */
    const reachOf = (level: number): number => {
      let best = 0;
      for (let q = 0; q < 360; q++) {
        const du = Math.cos((q * Math.PI) / 180), dv = Math.sin((q * Math.PI) / 180);
        let hi = Math.hypot(A, B) * 1.2 + level * 3 + 2;
        while (hi > 0 && segmentPlanDistance(plan, du * hi, dv * hi) >= level) hi -= 0.5;
        let lo = hi; hi += 0.5;
        for (let i = 0; i < 16; i++) { const m = (lo + hi) / 2; if (segmentPlanDistance(plan, du * m, dv * m) < level) lo = m; else hi = m; }
        best = Math.max(best, hi);
      }
      return best + 0.5;
    };
    const extent = reachOf(0);
    // the apron at the foot, the wave-cut notch just over it
    const apronR = lerp(sh.apron.reach, r(4)), apronH = apronR > 0 ? lerp(sh.apron.height, r(5)) : 0;
    const nLo = sea + apronH * 0.8, nHi = nLo + lerp(sh.waveNotch.height, r(6)), nD = lerp(sh.waveNotch.depth, r(7));
    // the cap band (thick, with the overhanging lip and the recess under it) and a few thin ledges below it
    const capLo = top - H * lerp(sh.cap, r(8)), capOut = lerp(sh.lip, r(9));
    const wallLo = nHi + 2;
    const nL = Math.round(lerp(sh.ledges, r(17)));
    const ledgeYs: number[] = [];
    for (let q = 0; q < nL; q++) ledgeYs.push(wallLo + (0.1 + 0.75 * r(100 + q)) * Math.max(0, capLo - wallLo));
    ledgeYs.sort((a, b) => a - b);
    const caps = capRockBands(wallLo, top, capLo, capOut, ledgeYs, 1.2, sh.recess);
    // set-backs: below each the stack stands `girth` metres wider (a shelf at each)
    const nT = Math.round(lerp(sh.tiers, r(10)));
    const tiers: number[] = [];
    for (let j = 0; j < nT; j++) tiers.push(nHi + 4 + (0.12 + 0.6 * r(11 + j)) * Math.max(0, capLo - nHi - 10), lerp(sh.girth, r(14 + j)));
    const tierPush = (y: number): number => {
      let p = 0;
      for (let j = 0; j < tiers.length; j += 2) p += tiers[j + 1]! * (1 - Math.min(1, Math.max(0, (y - tiers[j]! + 0.6) / 1.2)));
      return p;
    };
    const notchPush = (y: number): number => {
      if (nD <= 0) return 0;
      const up = Math.min(1, Math.max(0, (y - nLo + 0.8) / 0.8)), down = Math.min(1, Math.max(0, (nHi + 1.2 - y) / 1.2));
      return -nD * Math.min(up, down);
    };
    // one piecewise-linear profile: every breakpoint of the three, summed there
    const ys = new Set<number>();
    for (let i = 0; i < caps.length; i += 2) ys.add(caps[i]!);
    for (let j = 0; j < tiers.length; j += 2) { ys.add(tiers[j]! - 0.6); ys.add(tiers[j]! + 0.6); }
    if (nD > 0) for (const y of [nLo - 0.8, nLo, nHi, nHi + 1.2]) ys.add(y);
    const sorted = [...ys].sort((a, b) => a - b);
    const bands: number[] = [];
    let out = 0;
    for (const y of sorted) {
      const p = bandPushAt(caps, y) + tierPush(y) + notchPush(y);
      bands.push(y, p);
      if (y <= top) out = Math.max(out, p + s.doc.stacks.taper * Math.max(0, top - Math.max(y, sea - s.doc.depth)));
    }
    out = Math.max(out, bands[1]! + s.doc.stacks.taper * (top - sea + s.doc.depth));
    out += sh.strata * s.pc.maxPush;
    return { ...plan, c: Math.cos(rot), s: Math.sin(rot), bands, out, apronR, apronH, boulders: sh.apron.boulders, strata: sh.strata, extent, footprint: reachOf(out + apronR * 1.6) };
  };
  /** Plan distance of a shaped stack at its top (metres, negative inside). */
  const shapeDist = (sh: StackShape, st: Float64Array, x: number, z: number): number => {
    const dx = x - st[0]!, dz = z - st[1]!;
    return segmentPlanDistance(sh, dx * sh.c + dz * sh.s, -dx * sh.s + dz * sh.c);
  };
  /** Boulders: rounded blocks on a jittered 3.6 m grid, the highest over the column (0..amp). */
  const BC = 3.6;
  const boulders = (x: number, z: number, amp: number): number => {
    const I = Math.floor(x / BC), K = Math.floor(z / BC);
    let h = 0;
    for (let dk = -1; dk <= 1; dk++) for (let di = -1; di <= 1; di++) {
      const a = I + di, b = K + dk;
      const cx = (a + 0.15 + 0.7 * (hash3i(a, b, 1, 6151) / U32)) * BC, cz = (b + 0.15 + 0.7 * (hash3i(a, b, 2, 6151) / U32)) * BC;
      const rr = BC * (0.45 + 0.4 * (hash3i(a, b, 3, 6151) / U32));
      const d2 = ((x - cx) * (x - cx) + (z - cz) * (z - cz)) / (rr * rr);
      if (d2 < 1) h = Math.max(h, amp * (0.45 + 0.55 * (hash3i(a, b, 4, 6151) / U32)) * Math.sqrt(1 - d2));
    }
    return h;
  };
  /** The boulder apron's surface at a column (closed form; -Infinity = past it). */
  const apronY = (col: SeaColumn, x: number, z: number, floor: number): number => {
    const sh = col.stackShape;
    if (!sh || sh.apronR <= 0) return -Infinity;
    const u = Math.max(0, col.stackBase) / sh.apronR;
    if (u >= 1.6) return -Infinity;
    // a concave talus from `apronH` at the wall to a metre under the sea at the reach, boulders strewn on it, then a
    // steep underwater talus down to `floor` (the ground the apron rests on, met at 1.6 x reach)
    if (u <= 1) { const t = 1 - u; return sea - 1 + (sh.apronH + 1) * t * t + (sh.boulders > 0 ? boulders(x, z, sh.boulders) * Math.min(1, t * 2.5) : 0); }
    return sea - 1 + (Math.min(floor, sea - 1) - sea + 1) * smoothstep(1, 1.6, u);
  };

  const colScratch: SeaColumn = { w: 0, b: 0, q: 0, top: 0, foot: 0, stack: Infinity, stackTop: 0, stackTaper: 0, stackBase: Infinity, stackOut: Infinity, stackShape: null, fin: Infinity, finTop: 0, holeAlong: 0, holeMid: 0, holeA: 0, holeB: 0, holeY: 0, k: -1 };
  let cWidth = 0;
  const stackNear: Float64Array[] = [];
  let snI = NaN, snK = NaN, snS = -1, snN = 0;
  /** Fill `out` for (x, z) (memoised on the exact column). */
  function evalColumn(x: number, z: number, out: SeaColumn): number {
    const k = stretchAt(x, z);
    const w = k < 0 ? 0 : wScratch[0]!;
    out.w = w;
    out.b = w > 0 ? smoothstep(0, 0.4, w) : 0;
    out.stack = Infinity; out.stackBase = Infinity; out.stackOut = Infinity; out.stackShape = null; out.fin = Infinity; out.holeA = 0; out.k = k;
    if (out.b <= 0) return 0;
    const s = stretches[k]!;
    const tS = smoothstep(0.1, 1, w);
    const v = smoothAt(k, x, z), pw = v[4]!, width = v[5]!, level = v[6]!;
    out.top = sea + 6 + (v[2]! - 6) * tS + v[3]! * tS;
    out.q = planQ(k, x, z, w, v);
    out.foot = footAt(s, pw, width, level, Math.max(0, -out.q), tS);
    cWidth = width;
    // stacks within reach of this column (3x3 sites)
    const C = s.doc.stacks.cell;
    if (s.doc.stacks.density > 0 && out.q < 10) {
      const I = Math.floor(x / C), K = Math.floor(z / C);
      if (I !== snI || K !== snK || k !== snS) {
        snI = I; snK = K; snS = k; snN = 0;
        for (let dk = -1; dk <= 1; dk++) for (let di = -1; di <= 1; di++) { const st = stackSite(k, I + di, K + dk); if (st) stackNear[snN++] = st; }
      }
      for (let j = 0; j < snN; j++) {
        const st = stackNear[j]!;
        const sh = shapes.get(st);
        const taper = s.doc.stacks.taper;
        let pd: number, base: number;
        if (sh) { pd = shapeDist(sh, st, x, z); base = pd - sh.out; } else { pd = prism(st, x, z); base = pd - taper * (st[5]! - sea); }
        if (base < out.stackBase) {
          out.stack = pd; out.stackTop = st[5]!; out.stackTaper = taper; out.stackBase = base;
          out.stackShape = sh ?? null; out.stackOut = sh ? base - sh.apronR * 1.6 : base;
        }
        if (st[9]! > 0) {
          const ax = x - st[0]!, az = z - st[1]!;
          const a = ax * st[7]! + az * st[8]!, c = -ax * st[8]! + az * st[7]!;
          const fd = Math.max(Math.abs(c) - st[10]!, -a, a - st[9]!);
          if (fd < out.fin) {
            out.fin = fd;
            out.finTop = Math.min(st[5]!, out.top) - 2;
            // the opening: an elliptic vault across the fin, between the stack's face and the wall
            const a0 = st[2]! + 2, a1 = -st[6]! - 2, A = (a1 - a0) / 2;
            if (A > 3) {
              const am = (a0 + a1) / 2, B = Math.min(0.62 * (out.finTop - sea), 1.3 * A + 4), yb = sea - 2;
              // stored as the vault's centre-line data; the y term is applied in density()
              out.holeMid = am; out.holeA = A; out.holeB = B; out.holeY = yb; out.holeAlong = a;
            } else out.holeA = 0;
          }
        }
      }
    }
    return out.b;
  }

  return {
    bbox,
    height(x, z, h) {
      if (x < bx0 || x > bx1 || z < bz0 || z > bz1) return h;
      const col = colScratch;
      if (evalColumn(x, z, col) <= 0) return h;
      const s = stretches[col.k]!;
      const q = col.q;
      let top = col.top;
      if (q > s.doc.edge) top += (h - top) * smoothstep(s.doc.edge, s.doc.edge + s.doc.inland, q);
      let foot = col.foot;
      if (q < 0) {
        const u = -q;
        foot += (Math.min(h, foot) - foot) * smoothstep(cWidth + 6, cWidth + 60, u);
      }
      // the wall: a step over 1.8 m of plan (the planar path makes it exactly vertical)
      let hc = foot + (top - foot) * smoothstep(-0.9, 0.9, q);
      if (col.stackShape && col.stackOut < 0) hc = Math.max(hc, apronY(col, x, z, hc));
      if (col.stackBase < 1) hc = Math.max(hc, hc + (col.stackTop - hc) * smoothstep(1, -1, col.stackBase));
      if (col.fin < 1) hc = Math.max(hc, hc + (col.finTop - hc) * smoothstep(1, -1, col.fin));
      return h + (hc - h) * col.b;
    },
    column(x, z, out) {
      return evalColumn(x, z, out);
    },
    density(x, y, z, hb, col) {
      const s = stretches[Math.max(0, col.k)]!;
      const q = col.q;
      const push = s.pc.strataPush(x, y, z);
      // the top and foot in closed form at the wall, handing over to the lattice heightfield away from it
      const topZ = col.top + (hb - col.top) * smoothstep(6, 14, q);
      // (round a stack or a fin the lattice height is ITS top, not the sea floor: keep the closed-form floor there,
      // or the arch is filled in from the heightfield)
      const near = Math.min(col.stackBase, col.fin), keep = near < 8 ? smoothstep(2, 8, near) : 1;
      const footZ = col.foot + (hb - col.foot) * smoothstep(6, 14, -q) * keep;
      let d = Math.min(Math.max(y - topZ, -(q + push)), y - footZ);
      const sh = col.stackShape;
      if (sh) {
        if (col.stackOut < 16) {
          // the shaped stack: plan distance tapered with depth, pushed by its own profile (set-backs, ledges, recess,
          // cap band, wave notch) and a share of the stretch's strata; the boulder apron round its foot
          const wall = col.stack - col.stackTaper * Math.max(0, col.stackTop - y) - bandPushAt(sh.bands, y) - sh.strata * push;
          d = Math.min(d, Math.max(y - col.stackTop, wall));
          const ay = apronY(col, x, z, footZ);
          if (ay > -Infinity) d = Math.min(d, (y - ay) * 0.7);
        }
      } else if (col.stackBase < 16) d = Math.min(d, Math.max(y - col.stackTop, col.stack - col.stackTaper * Math.max(0, col.stackTop - y) - push));
      if (col.fin < 16) {
        let fin = Math.max(y - col.finTop, col.fin - push * 0.5);
        if (col.holeA > 0 && y > col.holeY - 6) {
          const e = Math.hypot((col.holeAlong - col.holeMid) / col.holeA, (y - col.holeY) / col.holeB) - 1;
          fin = Math.max(fin, -e * Math.min(col.holeA, col.holeB));
        }
        d = Math.min(d, fin);
      }
      // the planar value blends back to the plain field as the stretch fades (its heightfield does the same)
      return d;
    },
    weight(col) {
      if (col.b <= 0) return 0;
      return col.b * (1 - smoothstep(14, 20, col.q));
    },
    mask(col) {
      if (col.b <= 0) return 0;
      let m = 1 - smoothstep(18, 24, Math.abs(col.q));
      if (col.stackOut < 16) m = Math.max(m, 1 - smoothstep(10, 16, col.stackOut));
      if (col.fin < 16) m = Math.max(m, 1 - smoothstep(10, 16, col.fin));
      return col.b * m;
    },
    rock(x, y, z) {
      if (x < bx0 || x > bx1 || z < bz0 || z > bz1) return 0;
      const col = colScratch;
      if (evalColumn(x, z, col) <= 0) return 0;
      const low = 1 - smoothstep(sea + 2.5, sea + 7, y);
      if (low <= 0) return 0;
      let r = 1 - smoothstep(-1.5, 2.5, col.q);
      if (col.stackOut < 4) r = Math.max(r, 1 - smoothstep(-1, 3, col.stackOut));
      if (col.fin < 4) r = Math.max(r, 1 - smoothstep(-1, 3, col.fin));
      return col.b * low * r;
    },
    ceiling(col) {
      let c = col.top;
      if (col.stackOut < 16) c = Math.max(c, col.stackTop);
      return c + 3;
    },
    turf(x, z, out) {
      out.k = -1; out.w = 0;
      if (!anyTurf || x < bx0 || x > bx1 || z < bz0 || z > bz1) return 0;
      const col = colScratch;
      if (evalColumn(x, z, col) <= 0) return 0;
      const d = stretches[col.k]!.doc, t = d.turf;
      if (!t) return 0;
      // the cliff top, the wall and everything offshore; inland it hands back to the zones over the top's join
      out.k = col.k;
      out.w = col.b * t.amount * (1 - smoothstep(d.edge, d.edge + d.inland, col.q));
      return out.w;
    },
    shaped: stretches.some((s) => s.doc.stacks.shape !== undefined && s.doc.stacks.density > 0),
    apron(x, z) {
      if (x < bx0 || x > bx1 || z < bz0 || z > bz1) return false;
      const col = colScratch;
      if (evalColumn(x, z, col) <= 0 || !col.stackShape) return false;
      // past the top's plan and its lip (shelves and ledges count as bare too), inside the apron's reach
      return col.stack > 2.5 && col.stackOut < 0;
    },
    newColumn: () => ({ ...colScratch }),
    stacksIn(x0, z0, x1, z1) {
      const out: SeaStack[] = [];
      if (x1 < bx0 || x0 > bx1 || z1 < bz0 || z0 > bz1) return out;
      stretches.forEach((s, k) => {
        const C = s.doc.stacks.cell;
        if (s.doc.stacks.density <= 0) return;
        for (let K = Math.floor(Math.max(z0, s.bbox[1]) / C); K <= Math.floor(Math.min(z1, s.bbox[3]) / C); K++)
          for (let I = Math.floor(Math.max(x0, s.bbox[0]) / C); I <= Math.floor(Math.min(x1, s.bbox[2]) / C); I++) {
            const st = stackSite(k, I, K);
            if (!st || st[0]! < x0 || st[0]! >= x1 || st[1]! < z0 || st[1]! >= z1) continue;
            const sh = shapes.get(st);
            out.push(sh
              ? { x: st[0]!, z: st[1]!, radius: st[2]!, top: st[5]!, arch: st[9]! > 0, extent: sh.extent, footprint: sh.footprint }
              : { x: st[0]!, z: st[1]!, radius: st[2]!, top: st[5]!, arch: st[9]! > 0 });
          }
      });
      return out;
    },
    surfIn(x0, z0, x1, z1, spacing, height) {
      const out: SeaSurfPoint[] = [];
      if (x1 < bx0 || x0 > bx1 || z1 < bz0 || z0 > bz1) return out;
      const step = 2, col: SeaColumn = { ...colScratch };
      // a lattice edge from water (under the sea, or awash) to rock standing 6 m over it, inside a stretch
      for (let z = Math.ceil(z0 / step) * step; z < z1; z += step) for (let x = Math.ceil(x0 / step) * step; x < x1; x += step) {
        const h = height(x, z);
        if (h > sea + 0.3) continue;
        for (const [dx, dz] of [[step, 0], [-step, 0], [0, step], [0, -step]] as const) {
          const hn = height(x + dx, z + dz);
          if (hn < sea + 6) continue;
          if (evalColumn(x, z, col) < 0.6) break;
          if (out.some((p) => (p.x - x) ** 2 + (p.z - z) ** 2 < spacing * spacing)) break;
          const l = Math.hypot(dx, dz);
          out.push({ x, z, nx: -dx / l, nz: -dz / l, height: hn - sea });
          break;
        }
      }
      return out;
    },
  };
}

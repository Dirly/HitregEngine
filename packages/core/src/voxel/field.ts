/**
 * The world field: a {@link WorldRecipe} turned into functions you can sample.
 *
 * Everything downstream — the marching-cubes mesher, the physics collider, the
 * tree scatter, the worldgen CLI that carves rivers and sites towns — asks
 * this one object. That is deliberate: the single most expensive class of bug
 * in a procedural world is two subsystems disagreeing about where the ground
 * is, and the only durable fix is that there is exactly one answer.
 *
 * Sign convention (see marching-cubes.ts): **density < 0 is solid.** The base
 * field is literally `y - groundHeight(x, z)`, then perturbed in 3D for
 * overhangs and cut by caves.
 *
 * Height is assembled in a fixed order, and the order is the design:
 *
 * ```text
 * zone (which kind of place, and its landform multipliers)
 *   -> noise bands (continent, hills, mountains x relief, mesas, dunes, detail)
 *   -> ceiling (soft max height)
 *   -> bounds (continent shore profile, land floor, world limit)
 *   -> coast cliffs (steepen the shoreline where rugged)
 *   -> features: canyons -> ridges -> lakes -> rivers -> towns -> roads
 * ```
 *
 * so a road entering a town lands on the town's pad, a river meeting a lake
 * meets its surface, and nothing inland ever sits below the sea.
 */

import type { Vec3 } from "../math.js";
import { clamp, fbm2, fbm3, hashUnit, smoothstep, type FbmSpec } from "./noise.js";
import { PolygonIndex, type OutlineSpec } from "./polygon-index.js";
import {
  type BiomeDoc,
  type BlobDoc,
  type CanyonDoc,
  type RidgeDoc,
  type LakeDoc,
  type PatchDoc,
  type RiverDoc,
  type FillDoc,
  type RoadDoc,
  type TownDoc,
  type WorldRecipe,
  type ZoneAnchorDoc,
} from "./recipe.js";
import { applyFallSites, fallSiteGorge, fallSiteLedge, type SolvedFallSite } from "./fall-sites.js";

// ------------------------------------------------------------------ geometry

/** Closest point on a polyline: squared distance, segment index, and its parameter. */
export interface PolylineHit {
  distance: number;
  segment: number;
  t: number;
}

function nearestOnPolyline(
  points: readonly (readonly [number, number])[],
  x: number,
  z: number,
  closed = false,
): PolylineHit {
  let best = Infinity;
  let bestSeg = 0;
  let bestT = 0;
  const n = points.length;
  const count = closed ? n : n - 1;
  for (let i = 0; i < count; i++) {
    const a = points[i]!;
    const b = points[(i + 1) % n]!;
    const dx = b[0] - a[0];
    const dz = b[1] - a[1];
    const lenSq = dx * dx + dz * dz;
    const t = lenSq < 1e-12 ? 0 : clamp(((x - a[0]) * dx + (z - a[1]) * dz) / lenSq, 0, 1);
    const px = a[0] + dx * t;
    const pz = a[1] + dz * t;
    const d = Math.sqrt((x - px) * (x - px) + (z - pz) * (z - pz));
    if (d < best) {
      best = d;
      bestSeg = i;
      bestT = t;
    }
  }
  return { distance: best, segment: bestSeg, t: bestT };
}

/** Even-odd point-in-polygon. */
function insidePolygon(points: readonly (readonly [number, number])[], x: number, z: number): boolean {
  let inside = false;
  const n = points.length;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const a = points[i]!;
    const b = points[j]!;
    if (a[1] > z !== b[1] > z && x < ((b[0] - a[0]) * (z - a[1])) / (b[1] - a[1]) + a[0]) inside = !inside;
  }
  return inside;
}

// ------------------------------------------------------- feature broad phase
//
// A finished world can hold thousands of river/road segments and dozens of
// towns, and `height()` is called millions of times per chunk. Testing every
// feature per sample is the difference between a chunk in 8ms and a chunk in
// 3 seconds, so features are bucketed into a uniform XZ grid by their
// influence footprint and only the local bucket is ever consulted.
//
// Polylines are bucketed as SEGMENTS, never as whole features. A river traced
// by the hydrology stage has hundreds of control points, and testing all of
// them for every column inside its bounding box — most of which are nowhere
// near it — was the single largest cost in meshing a cell with a river in it.

const BUCKET = 96;

/** The most a river may RAISE the ground under its channel to reach its bed (field.ts applyFeatures). */
export const RIVER_MAX_BUILD = 10;

/**
 * Most the ground BESIDE water is ever built up (m): a river's levee, a lake's
 * or river's rim. Water sits IN the land. A rim that had to stand metres over
 * the ground to hold a level was a wall — a grassy ridge between a lake and
 * the meadow behind it — and it was built inside the water's own reach, so
 * the water ended short of it. Where more than this would be needed the shore
 * is simply lower. (The bed inside a channel may still be built up by
 * RIVER_MAX_BUILD: that is under the water, sediment in a hollow.)
 */
export const SHORE_MAX_BUILD = 1.2;

/** How near a fall's foot (m) the blade filter looks, the neighbour distance, and the height that makes a blade. */
const BLADE_RADIUS = 70;
const BLADE_STEP = 4;
const BLADE_HEIGHT = 3;
const BLADE_AXES: readonly (readonly [number, number])[] = [[1, 0], [0, 1], [Math.SQRT1_2, Math.SQRT1_2], [Math.SQRT1_2, -Math.SQRT1_2]];

/**
 * Steepness (sin of the slope angle) over which lake, river and road paint
 * gives way to the ground's own surface: full paint below 40 degrees, none
 * above 53 — inside the default cliff rule (cliffStart 0.57 / cliffEnd 0.82),
 * so a steep face is always the biome's cliff rock, never bed gravel.
 */
export const PAINT_STEEP_START = 0.64;
export const PAINT_STEEP_END = 0.8;

/**
 * Spacing (m) every river is resampled to when the field is created, along a
 * centripetal Catmull-Rom through its control points. The carve, the water
 * surface and the paint all read the SAME resampled polyline — the old water
 * ribbon splined through the points while the carve ran straight between
 * them, so on every bend the water swung onto the bank. It is also the
 * length of a rapid between two pools.
 */
export const RIVER_SAMPLE = 8;

/**
 * The last reach to the sea: where a river's natural surface is within this
 * of the sea it runs straight down to it, so no fall stands at the mouth.
 */
export const POOL_STEP = 1.2;

/**
 * Steepest a river RUNS (rise over run). Where the land falls more gently the
 * water follows it, level on the flat and sloping a little where the valley
 * does; where it falls faster the river cannot keep up and drops over a
 * waterfall instead. A lowland river is well under this; 3 % already reads as
 * a quick stream.
 */
export const RIVER_RUN_GRADE = 0.03;

/**
 * A river's ONE waterfall. Each river keeps at most one fall, at the sharpest
 * drop along it (the most height lost within `RIVER_FALL_WINDOW` metres), and
 * only when that drop is at least `RIVER_FALL_MIN` metres. Everywhere else
 * the water runs, and the channel is cut down into the land as far as that
 * takes. A fall every fifty metres was a staircase; one per river is a place.
 */
export const RIVER_FALL_MIN = 6;
const RIVER_FALL_WINDOW = 60;

/**
 * How far into its taper a river's head carries water (0..1 of the taper's
 * growth). The taper narrows a head into a stream; it used to also leave the
 * first half of it DRY, which read as a carved trench with the water missing.
 */
const HEAD_WET = 0.02;

/** How far (m) an outlet's descent from its lake may stand over the bank cap before it gives way. */
const OUTLET_RAMP = 6;

/** How far (m) above and below a fall's lip the water is held to the bed's width. */
const FALL_NARROW = 1.5;
/** How far (m) above the lip and past it the cliffs beside a fall stand. */
const FALL_WALL_UP = 10;
/**
 * Wall steepness (rise over run) of the slot gorge under a fall. 1.6 is
 * about 58°: steep enough to read as a gorge, shallow enough that a 2 m
 * lattice draws it as a face and not a blade. At 3 (six metres of rise per
 * voxel) two gorge walls, or a gorge wall and the sea cliff, met in knife
 * ridges one voxel thick (measured: 34x the natural count around falls).
 */
const FALL_GORGE_RISE = 1.6;

/** Steepest a river bank may be cut (rise over run) when the land is too high to reach at the normal slope. */
const BANK_MAX_RISE = 1.6;

/** Most the rock beside a fall may stand over the ground it is built on (m): a shoulder, never a tower. */
const FALL_WALL_RAISE = 4;

/** How long the lip of a fall is (m): the bed and the water drop over this, a cliff, not a ramp — but wider than a lattice square, or a fall running diagonally across the lattice snaps to a zigzag of teeth. */
const RIVER_FALL_LIP = 3;

/**
 * Least water over a river bed, in voxels. A channel under about 1.5 voxels
 * deep cannot survive marching cubes: the bed pokes through the water in one
 * place and leaves a gap under the edge in the next (measured: the traced
 * channels held 1.4 voxels of depth and ~1 of water).
 */
export const MIN_WATER_VOXELS = 1.5;

/**
 * How far a river's water stands BELOW the lower of its two banks (m). The
 * level is capped by the ground beside the channel (sampled without any
 * river carved), so every river runs in a cut with a visible bank above the
 * water instead of brimming at the top of a levee, and a traced bed that
 * rides over a hollow is cut down through the ground beyond it instead of
 * hanging above the hollow.
 */
export const RIVER_FREEBOARD = 1.5;

/**
 * How far past the bed's edge a river's water may reach, in banks. The field
 * builds the bank up to the levee (a hand over the pool) by 0.63 of a bank
 * and holds it there to 0.7; the water stops inside that, so wherever the
 * ground beyond the levee falls away the water cannot follow it out.
 */
export const RIVER_WATER_REACH = 0.68;

/** A river's waterfall, as solved: where it lands, how far it drops, which way the water goes. */
export interface RiverFall {
  river: string;
  /** The foot of the fall (the plunge pool), world XZ. */
  x: number;
  z: number;
  /** Water level at the lip and in the pool below. */
  top: number;
  bottom: number;
  /** Unit direction the water travels, world XZ. */
  dirX: number;
  dirZ: number;
  /** Channel width at the fall. */
  width: number;
  /** How far across the channel (from its centreline) the lip line governs: water, carve and banks. */
  reach: number;
}

/** What `WorldField.waterSurface` reports for one point. */
export interface SurfaceSample {
  /** Water surface height. */
  y: number;
  /** Current in m/s along world X and Z (0 for a lake). */
  flowX: number;
  flowZ: number;
  /** "lake" inside a lake's sheet, "river" in a channel. */
  kind: "lake" | "river";
  /** A lake's own material, when it names one. */
  material?: string;
  /** The river bed (or lake shore level) under this point: how deep the water may reach before it is a pit, not a channel. */
  floor: number;
}

interface FeatureBuckets<T> {
  size: number;
  map: Map<number, T[]>;
  all: T[];
}

function bucketKey(bx: number, bz: number): number {
  // pack two signed 16-bit cell coords into one number key
  return ((bx & 0xffff) << 16) | (bz & 0xffff);
}

function makeBuckets<T>(items: readonly T[], bounds: (item: T) => [number, number, number, number]): FeatureBuckets<T> {
  const map = new Map<number, T[]>();
  for (const item of items) {
    const [minX, minZ, maxX, maxZ] = bounds(item);
    const bx0 = Math.floor(minX / BUCKET);
    const bz0 = Math.floor(minZ / BUCKET);
    const bx1 = Math.floor(maxX / BUCKET);
    const bz1 = Math.floor(maxZ / BUCKET);
    // a feature spanning an absurd area would blow the index up; fall back to
    // the "always considered" list rather than inserting tens of thousands of
    // bucket entries for one polyline
    if ((bx1 - bx0 + 1) * (bz1 - bz0 + 1) > 4096) continue;
    for (let bz = bz0; bz <= bz1; bz++) {
      for (let bx = bx0; bx <= bx1; bx++) {
        const key = bucketKey(bx, bz);
        const list = map.get(key);
        if (list) list.push(item);
        else map.set(key, [item]);
      }
    }
  }
  return { size: BUCKET, map, all: [] };
}

function bucketAt<T>(buckets: FeatureBuckets<T>, x: number, z: number): readonly T[] {
  const list = buckets.map.get(bucketKey(Math.floor(x / BUCKET), Math.floor(z / BUCKET)));
  if (!list) return buckets.all.length ? buckets.all : EMPTY_LIST;
  return buckets.all.length ? [...list, ...buckets.all] : list;
}

const EMPTY_LIST: readonly never[] = [];

/** One segment of a 2D polyline feature, carrying the per-point value at each end. */
interface PolySegment {
  /** Index into the owning feature list. */
  owner: number;
  ax: number;
  az: number;
  bx: number;
  bz: number;
  /** Per-point value (bed/surface/floor height) at each end, or NaN when the feature has none. */
  va: number;
  vb: number;
  /** Distance along the polyline from its first point, at each end. */
  ta: number;
  tb: number;
  /** Per-point side values (a road's embankment edge heights) at each end, NaN when the feature has none. */
  la: number;
  lb: number;
  ra: number;
  rb: number;
  /** Per-point width at each end (a river that varies along its length), NaN when the feature has one width. */
  wa: number;
  wb: number;
}

/** Nearest-point result for one owner, reused across queries. */
interface OwnerHit {
  owner: number;
  distance: number;
  value: number;
  /** Distance along the feature from its head, at the nearest point. */
  along: number;
  /** Side value interpolated at the nearest point for the side the query is on (NaN when the feature has none). */
  side: number;
  /** Per-point width interpolated at the nearest point (NaN when the feature has a single width). */
  width: number;
  /** Runner-up segment of the same owner, for the seam blend: its distance and the values it would give. */
  distance2: number;
  value2: number;
  along2: number;
  side2: number;
  width2: number;
}

function segmentsOf<T extends { points: readonly (readonly [number, number])[] }>(
  features: readonly T[],
  values: (feature: T) => readonly number[] | undefined,
  sides?: (feature: T) => [readonly number[] | undefined, readonly number[] | undefined],
  widths?: (feature: T) => readonly number[] | undefined,
): PolySegment[] {
  const out: PolySegment[] = [];
  const at = (arr: readonly number[] | undefined, i: number): number =>
    arr && arr.length > 0 ? arr[Math.min(i, arr.length - 1)]! : NaN;
  features.forEach((feature, owner) => {
    const v = values(feature);
    const [l, r] = sides ? sides(feature) : [undefined, undefined];
    const w = widths ? widths(feature) : undefined;
    const pts = feature.points;
    let along = 0;
    for (let i = 0; i + 1 < pts.length; i++) {
      const a = pts[i]!;
      const b = pts[i + 1]!;
      const len = Math.sqrt((b[0] - a[0]) ** 2 + (b[1] - a[1]) ** 2);
      out.push({
        owner,
        ax: a[0],
        az: a[1],
        bx: b[0],
        bz: b[1],
        va: at(v, i),
        vb: at(v, i + 1),
        ta: along,
        tb: along + len,
        la: at(l, i),
        lb: at(l, i + 1),
        ra: at(r, i),
        rb: at(r, i + 1),
        wa: at(w, i),
        wb: at(w, i + 1),
      });
      along += len;
    }
  });
  return out;
}

/** Blend two per-segment samples across a seam; a NaN on either side yields the other. */
function seamMix(primary: number, secondary: number, f: number): number {
  if (Number.isNaN(secondary)) return primary;
  if (Number.isNaN(primary)) return secondary;
  return secondary + (primary - secondary) * f;
}

function segmentBuckets(segments: readonly PolySegment[], reach: (owner: number) => number): FeatureBuckets<PolySegment> {
  return makeBuckets(segments, (s) => {
    const pad = reach(s.owner) + 2;
    return [Math.min(s.ax, s.bx) - pad, Math.min(s.az, s.bz) - pad, Math.max(s.ax, s.bx) + pad, Math.max(s.az, s.bz) + pad];
  });
}

/**
 * Nearest point per OWNER among the segments near (x, z). Two rivers may both
 * be within reach of one column and each carves independently, so the answer
 * is a small list, one entry per feature found — never allocated in the hot
 * path (the hits array is reused and `count` says how much of it is live).
 *
 * **The seam blend.** A polyline's per-point values (a road's surface and
 * embankment heights, a river's bed) are interpolated along whichever
 * segment is nearest, and on the INSIDE of every bend two segments are
 * equally near along the bisector. Their projections sit on different parts
 * of the line, so their interpolated values differ — by roughly
 * `2·d·sin(θ/2)·grade` at distance `d` from a bend of θ — and the hard
 * switch from one to the other was a vertical crack in the ground growing
 * with distance from the road: a row of triangular fins along every climbing
 * trail, and a wall down the middle of every switchback where the two legs'
 * embankments met. Each owner therefore keeps its runner-up segment too, and
 * where the two are within a span of each other the values are blended
 * toward their mean, the span widening with distance (the crack grows with
 * it) and with the size of the disagreement (so the blended slope stays
 * walkable). On a straight run the runner-up is far behind and nothing
 * changes.
 */
function nearestPerOwner(
  buckets: FeatureBuckets<PolySegment>,
  x: number,
  z: number,
  hits: OwnerHit[],
): number {
  const near = bucketAt(buckets, x, z);
  let count = 0;
  for (let i = 0; i < near.length; i++) {
    const s = near[i]!;
    const dx = s.bx - s.ax;
    const dz = s.bz - s.az;
    const lenSq = dx * dx + dz * dz;
    const t = lenSq < 1e-12 ? 0 : clamp(((x - s.ax) * dx + (z - s.az) * dz) / lenSq, 0, 1);
    const px = x - (s.ax + dx * t);
    const pz = z - (s.az + dz * t);
    const d = Math.sqrt(px * px + pz * pz);
    let slot = -1;
    for (let k = 0; k < count; k++) {
      if (hits[k]!.owner === s.owner) {
        slot = k;
        break;
      }
    }
    if (slot < 0) {
      slot = count++;
      if (!hits[slot]) {
        hits[slot] = {
          owner: s.owner,
          distance: Infinity,
          value: NaN,
          along: 0,
          side: NaN,
          width: NaN,
          distance2: Infinity,
          value2: NaN,
          along2: 0,
          side2: NaN,
          width2: NaN,
        };
      }
      const h = hits[slot]!;
      h.owner = s.owner;
      h.distance = Infinity;
      h.value = NaN;
      h.along = 0;
      h.side = NaN;
      h.width = NaN;
      h.distance2 = Infinity;
      h.value2 = NaN;
      h.along2 = 0;
      h.side2 = NaN;
      h.width2 = NaN;
    }
    const hit = hits[slot]!;
    if (d >= hit.distance2) continue;
    const value = Number.isNaN(s.va) ? NaN : s.va + (s.vb - s.va) * t;
    const along = s.ta + (s.tb - s.ta) * t;
    const width = Number.isNaN(s.wa) ? NaN : s.wa + (s.wb - s.wa) * t;
    let side = NaN;
    if (!Number.isNaN(s.la)) {
      // which side of the segment the query is on: the sign of the cross
      // product of the travel direction with the offset from the centreline.
      // Positive is "left" — the same convention the generator samples with.
      const left = dx * pz - dz * px >= 0;
      side = left ? s.la + (s.lb - s.la) * t : s.ra + (s.rb - s.ra) * t;
    }
    if (d < hit.distance) {
      hit.distance2 = hit.distance;
      hit.value2 = hit.value;
      hit.along2 = hit.along;
      hit.side2 = hit.side;
      hit.width2 = hit.width;
      hit.distance = d;
      hit.value = value;
      hit.along = along;
      hit.side = side;
      hit.width = width;
    } else {
      hit.distance2 = d;
      hit.value2 = value;
      hit.along2 = along;
      hit.side2 = side;
      hit.width2 = width;
    }
  }
  for (let k = 0; k < count; k++) {
    const hit = hits[k]!;
    if (hit.distance2 === Infinity) continue;
    const gap = hit.distance2 - hit.distance;
    const disagreement = Number.isNaN(hit.value2) || Number.isNaN(hit.value) ? 0 : Math.abs(hit.value2 - hit.value);
    const sideGap = Number.isNaN(hit.side2) || Number.isNaN(hit.side) ? 0 : Math.abs(hit.side2 - hit.side);
    // The disagreement term is CAPPED: it was meant to widen the blend a
    // little where a seam would otherwise be a step, but on a path climbing
    // at 150 % two adjacent segments disagree by thirty metres at any point
    // between them, and the span grew until a segment twelve metres further
    // away than the nearest was mixed in. On the locus where the two
    // neighbours are equidistant the runner-up flips between them, and the
    // bank flipped with it by three metres every half metre — the teeth
    // along every steep climb. A runner-up that is not within a few metres
    // of being the nearest is simply not the feature here.
    const span = 1 + 0.35 * hit.distance + 0.5 * Math.min(4, Math.max(disagreement, sideGap));
    if (gap >= span) continue;
    // f runs from 0.5 on the bisector (the mean) to 1 a span away (the nearest alone)
    const f = 0.5 + 0.5 * smoothstep(0, span, gap);
    hit.value = seamMix(hit.value, hit.value2, f);
    hit.along = seamMix(hit.along, hit.along2, f);
    hit.side = seamMix(hit.side, hit.side2, f);
    hit.width = seamMix(hit.width, hit.width2, f);
  }
  return count;
}

/** One cave passage segment, flattened from a tunnel polyline. */
interface TunnelSegment {
  ax: number; ay: number; az: number;
  bx: number; by: number; bz: number;
  /** Radius at each end; a passage may open out into a chamber. */
  ra: number; rb: number;
}

/** Distance from (x, z) to a polyline — a single point is just that point. */
function distanceToPolyline(points: readonly (readonly [number, number])[], x: number, z: number): number {
  let best = Infinity;
  if (points.length === 1) {
    const p = points[0]!;
    return Math.sqrt((x - p[0]) ** 2 + (z - p[1]) ** 2);
  }
  for (let i = 0; i + 1 < points.length; i++) {
    const a = points[i]!;
    const b = points[i + 1]!;
    const dx = b[0] - a[0];
    const dz = b[1] - a[1];
    const len = dx * dx + dz * dz;
    const t = len < 1e-9 ? 0 : Math.max(0, Math.min(1, ((x - a[0]) * dx + (z - a[1]) * dz) / len));
    const d = Math.sqrt((x - (a[0] + dx * t)) ** 2 + (z - (a[1] + dz * t)) ** 2);
    if (d < best) best = d;
  }
  return best;
}

function polylineBounds(
  points: readonly (readonly [number, number])[],
  pad: number,
): [number, number, number, number] {
  let minX = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxZ = -Infinity;
  for (const [x, z] of points) {
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (z < minZ) minZ = z;
    if (z > maxZ) maxZ = z;
  }
  return [minX - pad, minZ - pad, maxX + pad, maxZ + pad];
}

function lakeBounds(lake: LakeDoc): [number, number, number, number] {
  if (lake.polygon) return polylineBounds(lake.polygon, lake.bank + 2);
  const r = lake.radius + lake.bank + 2;
  return [lake.center[0] - r, lake.center[1] - r, lake.center[0] + r, lake.center[1] + r];
}

/**
 * A river's bank reach at a point where its channel is `width` wide (NaN
 * when the doc carries one width): the doc's `bank` is the reach at its
 * WIDEST, and a stream three metres wide does not get the banks of the river
 * it becomes. The same rule sizes the carve, the waterline and the ribbon
 * (chunk.ts), so the three agree about where the shore is.
 */
export function riverBank(river: RiverDoc, width: number): number {
  return Number.isNaN(width) ? river.bank : Math.min(river.bank, 0.7 * width + 3);
}

/** The outline an index rasterises for a lake: its polygon (band = the bowl blend, two banks) or its disc. */
function lakeOutlineSpec(lake: LakeDoc): OutlineSpec {
  return lake.polygon
    ? { kind: "polygon", points: lake.polygon, band: lake.bank * 2 + 2 }
    : { kind: "disc", center: lake.center, radius: lake.radius };
}

// -------------------------------------------------------------------- biomes

/** What the world looks like at one point: which biomes, and the splat mix. */
export interface BiomeSample {
  /** Strongest-matching biome id — the label scatter rules and tools filter on. */
  id: string;
  /** Strongest zone anchor id here, or "" when the recipe has no zones. */
  zone: string;
  /** Per-biome membership, same order as `recipe.biomes`, normalized to sum 1. */
  weights: Float32Array;
  /** Splat weights over `recipe.surfaces` (exactly `surfaces.length` long), summing to 1. */
  surface: Float32Array;
  temperature: number;
  moisture: number;
  slope: number;
}

/** Which kind of place (x, z) is, and how much of each kind where zones meet. */
export interface ZoneSample {
  /** Strongest anchor id, or "" without zones. */
  id: string;
  /** Blended weight per anchor, same order as `climate.zones.anchors`; sums to 1. */
  weights: Float32Array;
}

/** Smooth membership of `v` in `[min, max]` with `blend` soft edges. */
function window(v: number, range: readonly [number, number] | undefined, blend: number): number {
  if (!range) return 1;
  const b = Math.max(blend, 1e-6);
  const lo = smoothstep(range[0] - b, range[0] + b, v);
  const hi = 1 - smoothstep(range[1] - b, range[1] + b, v);
  return lo * hi;
}

/** Soft `max(v, 0)`: continuous first derivative, so a clamped floor never creases the ground. */
function softPositive(v: number, k: number): number {
  if (v >= k) return v;
  if (v <= -k) return 0;
  const t = (v + k) / (2 * k);
  return t * t * k;
}

// ------------------------------------------------------------------- the field

export interface SampleBlockRequest {
  /** World position of lattice sample (0,0,0) — one `step` outside the emitted cells. */
  origin: Vec3;
  /** Sample counts per axis INCLUDING the one-sample padding ring on each side. */
  nx: number;
  ny: number;
  nz: number;
  step: number;
}

export interface WorldField {
  readonly recipe: WorldRecipe;
  /** cellSize / resolution — the world units between voxel lattice samples. */
  readonly voxelSize: number;
  /**
   * `recipe.surfaces.length`. Every splat buffer in the system is exactly this
   * wide — not MAX_SURFACES — so a small palette costs a small vertex.
   */
  readonly surfaceCount: number;
  /**
   * The recipe's rivers with every bed SOLVED. A river written by hand — an
   * agent dropping `{ points, width }` into `features.rivers` — carries no
   * `bedY`; the field solves one from the ground it crosses when it is
   * created (see `solveRiverBeds`), and this is the list every consumer that
   * needs a bed (the water ribbons, the audit) must read instead of the doc.
   */
  readonly rivers: readonly RiverDoc[];
  /** Every waterfall the rivers were solved with (at most one per river): what the mist, the map and the audit read. */
  readonly falls: readonly RiverFall[];
  /** Ground height at (x, z) with every 2D feature applied. */
  height(x: number, z: number): number;
  /** Ground height from the noise bands ALONE — what the land would be with no rivers/roads/towns. */
  naturalHeight(x: number, z: number): number;
  /** Signed density; negative is solid. */
  density(x: number, y: number, z: number): number;
  /** Steepness at (x, z): 0 flat, 1 vertical. */
  slope(x: number, z: number): number;
  climate(x: number, z: number): { temperature: number; moisture: number };
  /** Zone membership at (x, z). Every weight is 0 and `id` is "" for a recipe without zones. */
  zone(x: number, z: number): ZoneSample;
  /** Full biome/splat evaluation. `slope` defaults to a measured slope at (x,z). */
  biome(x: number, z: number, groundY?: number, slope?: number): BiomeSample;
  /** Splat weights into `out[offset..offset+surfaceCount-1]`, from a mesh vertex's own position + normal. */
  splatAt(x: number, y: number, z: number, ny: number, out: Float32Array, offset: number): void;
  /** Blended biome tint into `out[offset..offset+2]` as linear-ish RGB 0..1. */
  tintAt(x: number, y: number, z: number, ny: number, out: Float32Array, offset: number): void;
  /** Splat weights at `offset..` AND tint in the three floats after them, from ONE biome evaluation. */
  surfaceAt(x: number, y: number, z: number, ny: number, out: Float32Array, offset: number): void;
  /** Sample a padded block for the mesher, honouring the column optimisation. */
  sampleBlock(request: SampleBlockRequest): Float32Array;
  /** Ground height range over an XZ rectangle, sampled on a coarse lattice. */
  heightRange(x0: number, z0: number, x1: number, z1: number, samples?: number): { min: number; max: number };
  /** Topmost solid surface at (x, z) accounting for overhangs/caves, or null if none in range. */
  surfaceCast(x: number, z: number, fromY?: number, toY?: number): number | null;
  /** Distance to the nearest river/road/town/lake edge — what `scatter.clearance` tests. */
  featureClearance(x: number, z: number): number;
  /**
   * Height of the water surface over (x, z), or null on dry land: the sea
   * where the ground is below seaLevel, a lake inside its outline, a river
   * within its channel. Scatter uses it to keep props out of every kind of
   * water, not just the ocean.
   */
  waterY(x: number, z: number): number | null;
  /**
   * The water SURFACE over (x, z) — lake or river, not the sea — written into
   * `out`; false where no lake sheet or river channel reaches. Unlike
   * `waterY` it does not look at the ground: the caller clips the surface
   * against the terrain, which is what makes the water fill the bed exactly
   * (chunk.ts builds each cell's water mesh this way).
   */
  waterSurface(x: number, z: number, out: SurfaceSample): boolean;
  /** Could any lake or wet river reach into this XZ rectangle? A cheap bucket test to skip dry cells. */
  waterNear(x0: number, z0: number, x1: number, z1: number): boolean;
  /**
   * Signed distance to the nearest coastline in metres, positive inland, or
   * +Infinity for a recipe without `bounds`. Where the shore profile is on
   * this is exact; tools use it to keep towns off the beach and to know how
   * far out the world goes.
   */
  shoreDistance(x: number, z: number): number;
  /** `bounds.limit`, or Infinity: how far from the origin anything can exist. */
  readonly worldLimit: number;
}

function toFbm(spec: WorldRecipe["terrain"]["continent"]): FbmSpec {
  return spec as FbmSpec;
}

/** Parse `#rrggbb` into 0..1 RGB. */
function hexToRgb(hex: string): [number, number, number] {
  const v = parseInt(hex.replace("#", ""), 16);
  return [((v >> 16) & 255) / 255, ((v >> 8) & 255) / 255, (v & 255) / 255];
}

export function createWorldField(recipe: WorldRecipe): WorldField {
  const seed = recipe.seed;
  const t = recipe.terrain;
  const voxelSize = recipe.cellSize / recipe.resolution;

  const continent = toFbm(t.continent);
  const hills = toFbm(t.hills);
  const mountains = toFbm(t.mountains);
  const maskSpec = toFbm(t.mountainMask.spec);
  const detail = toFbm(t.detail);
  const tempSpec = toFbm(recipe.climate.temperature);
  const moistSpec = toFbm(recipe.climate.moisture);
  const warpA: FbmSpec = { frequency: t.warp.frequency, amplitude: t.warp.strength, octaves: 2, lacunarity: 2, gain: 0.5, ridged: false, seed: 613 };
  const warpB: FbmSpec = { ...warpA, seed: 811 };
  const overhangSpec: FbmSpec = { frequency: t.overhang.frequency, amplitude: 1, octaves: 3, lacunarity: 2.1, gain: 0.5, ridged: false, seed: 907 };
  /**
   * How far from the ground the 3D overhang perturbation is still applied.
   *
   * The perturbation is bounded by `strength`, so past this the SIGN of the
   * density cannot change and the isosurface is unaffected — which is why the
   * mesher skips it out there. But "the surface is unaffected" is not the same
   * as "the field is the same", and the two paths must be the same: this is
   * ONE constant used by the bulk sampler and the point query alike, because
   * the moment they differ the mesh, the cooked collider and the placement
   * solver stop agreeing about where the ground is. Found by the invariant
   * test the day sea cliffs made ground steep enough for the overhang mask to
   * open on the coast — 2.4 world units of disagreement, latent until then.
   */
  const overhangReach = t.overhang.strength * 1.35 + voxelSize;
  const caveA: FbmSpec = { frequency: t.caves.frequency, amplitude: 1, octaves: 2, lacunarity: 2.1, gain: 0.5, ridged: false, seed: t.caves.seed };
  const caveB: FbmSpec = { ...caveA, seed: t.caves.seed + 4001 };

  // ------------------------------------------------------------- continents
  //
  // Absent (the default) the world is the endless noise field it has always
  // been, so adding this to the schema changes no existing world.
  const continents = recipe.bounds?.continents ?? [];
  const hasBounds = continents.length > 0;
  const oceanFloor = recipe.bounds?.oceanFloor ?? -45;
  const landFloor = recipe.bounds?.landFloor ?? 0;
  const shelf = recipe.bounds?.shelf ?? 0.58;
  const hasShoreProfile = hasBounds && landFloor > 0;
  const worldLimit = recipe.bounds?.limit ?? Infinity;
  const limitFalloff = recipe.bounds?.limitFalloff ?? 600;
  /** One warp per landmass, separately seeded so two coasts aren't the same shape. */
  const coastWarpSpecs: FbmSpec[] = continents.map((c, i) => ({
    frequency: 1 / c.warpScale,
    amplitude: 1,
    octaves: 4,
    lacunarity: 2.1,
    gain: 0.5,
    ridged: false,
    seed: (seed ^ (0xc0a57 + i * 7919)) >>> 0,
  }));
  /**
   * A second, LARGER warp per landmass at the scale of the landmass itself.
   * The lobe warp above frays the coast into headlands and bays; this one
   * bends the whole outline, so a continent is oblong and lopsided instead
   * of a disc with a ragged edge — the difference between a coastline and a
   * circle drawn with a shaky hand.
   */
  const coastShapeSpecs: FbmSpec[] = continents.map((c, i) => ({
    frequency: 1 / (c.radius * 1.6),
    amplitude: 1,
    octaves: 2,
    lacunarity: 2,
    gain: 0.5,
    ridged: false,
    seed: (seed ^ (0x5ad0e + i * 3571)) >>> 0,
  }));
  /** Falloff variation per landmass: which stretches of coast are steep. */
  const coastVarSpecs: FbmSpec[] = continents.map((c, i) => ({
    frequency: 1 / c.coastVariationScale,
    amplitude: 1,
    octaves: 2,
    lacunarity: 2,
    gain: 0.5,
    ridged: false,
    seed: (seed ^ (0x5ea51de + i * 4099)) >>> 0,
  }));
  /** Beach grade at the waterline, rise per metre. 0.1 is a walkable strand. */
  const BEACH_GRADE = 0.1;
  const floorY = recipe.seaLevel + landFloor;

  // ------------------------------------------------------------------ zones
  const zones = recipe.climate.zones;
  const hasZones = !!zones && zones.anchors.length > 0;
  const anchors: readonly ZoneAnchorDoc[] = zones?.anchors ?? [];
  const anchorCount = anchors.length;
  const anchorIndex = new Map<string, number>();
  anchors.forEach((a, i) => anchorIndex.set(a.id, i));
  const zoneWarpA: FbmSpec = { frequency: zones?.warpFrequency ?? 0.0009, amplitude: zones?.warp ?? 0, octaves: 2, lacunarity: 2, gain: 0.5, ridged: false, seed: 2203 };
  const zoneWarpB: FbmSpec = { ...zoneWarpA, seed: 2417 };
  const zoneSize = zones?.size ?? 1;
  const zoneJitter = zones?.jitter ?? 0;
  const zoneBorder = zones?.border ?? 1;
  const zoneSeed = ((seed + (zones?.seed ?? 0)) ^ 0x20e5) | 0;
  const latitude = zones?.latitude;
  const anchorWeightSum = anchors.reduce((s, a) => s + a.weight, 0);
  /** Which anchor a zone site picks — cached, since every column near a site asks. */
  const siteAnchorCache = new Map<number, number>();

  /**
   * Latitude 0..1 of a point along the recipe's cold-to-hot axis. Sites are
   * sorted by it, so tundra collects toward one pole and jungle toward the
   * other instead of both being sprinkled across the whole map.
   */
  function latitudeAt(x: number, z: number): number {
    if (!latitude) return 0.5;
    const along = latitude.axis === "x" ? x : z;
    const u = 0.5 + along / latitude.scale;
    return clamp(latitude.flip ? 1 - u : u, 0, 1);
  }

  function siteAnchor(cx: number, cz: number, sx: number, sz: number): number {
    const key = ((cx & 0xffff) << 16) | (cz & 0xffff);
    const cached = siteAnchorCache.get(key);
    if (cached !== undefined) return cached;
    const lat = latitudeAt(sx, sz);
    const strength = latitude?.strength ?? 0;
    let total = 0;
    const weights = new Float64Array(anchorCount);
    for (let i = 0; i < anchorCount; i++) {
      const a = anchors[i]!;
      let w = a.weight;
      if (a.latitude !== undefined && strength > 0) {
        const d = (a.latitude - lat) / 0.22;
        w *= 1 - strength + strength * Math.exp(-d * d);
      }
      weights[i] = w;
      total += w;
    }
    let pick = hashUnit(cx, cz, 7, zoneSeed) * (total > 0 ? total : anchorWeightSum);
    let chosen = anchorCount - 1;
    for (let i = 0; i < anchorCount; i++) {
      pick -= total > 0 ? weights[i]! : anchors[i]!.weight;
      if (pick <= 0) {
        chosen = i;
        break;
      }
    }
    siteAnchorCache.set(key, chosen);
    return chosen;
  }

  /** Per-anchor blended weights at the last `zoneAt` call, plus the landform multipliers it implies. */
  const zoneScratch = new Float32Array(Math.max(anchorCount, 1));
  const zoneForm = { relief: 1, hills: 1, dunes: -1, mesas: 0, flatten: 0, temperature: 0.5, moisture: 0.5, best: -1 };

  /**
   * Zone membership at (x, z): jittered Voronoi over a `size` grid, borders
   * domain-warped, every site within `border` of the nearest one contributing
   * a fading weight. Fading ALL near sites (not just the runner-up) is what
   * keeps a three-way junction continuous — the runner-up switches identity
   * there, and a two-site blend would jump with it.
   */
  function zoneAt(x: number, z: number): void {
    zoneScratch.fill(0);
    if (!hasZones) return;
    let sx = x;
    let sz = z;
    if (zoneWarpA.amplitude > 0) {
      sx = x + fbm2(zoneWarpA, x, z, seed);
      sz = z + fbm2(zoneWarpB, x + 311.5, z - 517.25, seed);
    }
    const cx = Math.floor(sx / zoneSize);
    const cz = Math.floor(sz / zoneSize);
    // pass 1: nearest site distance
    let d1 = Infinity;
    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        const gx = cx + dx;
        const gz = cz + dz;
        const px = (gx + 0.5 + (hashUnit(gx, gz, 1, zoneSeed) - 0.5) * zoneJitter) * zoneSize;
        const pz = (gz + 0.5 + (hashUnit(gx, gz, 2, zoneSeed) - 0.5) * zoneJitter) * zoneSize;
        const d = Math.sqrt((sx - px) * (sx - px) + (sz - pz) * (sz - pz));
        if (d < d1) d1 = d;
      }
    }
    // pass 2: every site within `border` of the nearest fades in by how close it is
    let total = 0;
    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        const gx = cx + dx;
        const gz = cz + dz;
        const px = (gx + 0.5 + (hashUnit(gx, gz, 1, zoneSeed) - 0.5) * zoneJitter) * zoneSize;
        const pz = (gz + 0.5 + (hashUnit(gx, gz, 2, zoneSeed) - 0.5) * zoneJitter) * zoneSize;
        const d = Math.sqrt((sx - px) * (sx - px) + (sz - pz) * (sz - pz));
        const w = 1 - smoothstep(0, zoneBorder, d - d1);
        if (w <= 0) continue;
        const a = siteAnchor(gx, gz, px, pz);
        zoneScratch[a] = zoneScratch[a]! + w;
        total += w;
      }
    }
    let relief = 0;
    let hillsMul = 0;
    let dunes = 0;
    let mesas = 0;
    let flatten = 0;
    let temperature = 0;
    let moisture = 0;
    let best = 0;
    for (let i = 0; i < anchorCount; i++) {
      const w = zoneScratch[i]! / total;
      zoneScratch[i] = w;
      if (w <= 0) continue;
      const a = anchors[i]!;
      relief += a.relief * w;
      hillsMul += a.hills * w;
      dunes += a.dunes * w;
      mesas += a.mesas * w;
      flatten += a.flatten * w;
      temperature += a.temperature * w;
      moisture += a.moisture * w;
      if (w > zoneScratch[best]!) best = i;
    }
    zoneForm.relief = relief;
    zoneForm.hills = hillsMul;
    zoneForm.dunes = dunes;
    zoneForm.mesas = mesas;
    zoneForm.flatten = flatten;
    zoneForm.temperature = temperature;
    zoneForm.moisture = moisture;
    zoneForm.best = best;
  }

  /**
   * Zone lookup through the climate edge warp — the ONE way every consumer
   * asks. The landform, the biome rules and the public `zone()` must agree
   * about where a border is, or a tool reads "meadow" where the ground is
   * being shaped and textured as marsh.
   */
  function zoneAtWarped(x: number, z: number): void {
    if (!hasZones) return;
    let sx = x;
    let sz = z;
    if (hasEdgeWarp) {
      sx = x + fbm2(edgeWarpA, x, z, seed);
      sz = z + fbm2(edgeWarpB, x + 421.5, z - 733.25, seed);
    }
    zoneAt(sx, sz);
  }

  // --------------------------------------------------------------- features
  /** Rebound below once hand-written rivers have their beds solved. */
  let riverDocs: readonly RiverDoc[] = recipe.features.rivers;
  const roadDocs = recipe.features.roads;
  const canyonDocs = recipe.features.canyons;
  const lakeDocs = recipe.features.lakes;
  /** Water surface per point: the solved pools, or (before they are solved) most of the depth over the bed. */
  function surfaceOf(r: RiverDoc): readonly number[] | undefined {
    if (r.surfaceY && r.surfaceY.length === r.points.length) return r.surfaceY;
    if (!r.bedY || r.bedY.length !== r.points.length) return undefined;
    const n = r.points.length;
    return r.bedY.map((b, i) => b + Math.max(0.4, (r.depths && r.depths.length === n ? r.depths[i]! : r.depth) * 0.7));
  }
  /** A river's widest point: the reach must cover the whole channel wherever its width varies. */
  const riverWidest = (r: RiverDoc): number => (r.widths && r.widths.length > 0 ? Math.max(r.width, ...r.widths) : r.width);
  // three banks: the cut band widens to that on a tall cut (applyFeatures)
  const riverReach = (r: RiverDoc): number => riverWidest(r) / 2 + r.bank * 3;
  /** The embankment band is only real when the doc carries both edge profiles; otherwise the shoulder is the reach. */
  const roadSmooth = (r: RoadDoc): number => (r.smooth > 0 && r.leftY && r.rightY ? r.smooth : 0);
  const roadReach = (i: number): number =>
    roadDocs[i]!.width / 2 + Math.max(roadDocs[i]!.shoulder + roadSmooth(roadDocs[i]!), roadDocs[i]!.surfaceEdge + 2);
  const canyonReach = (i: number): number => canyonDocs[i]!.width / 2 + canyonDocs[i]!.rim;
  const ridgeDocs: readonly RidgeDoc[] = recipe.features.ridges;
  const ridgeReach = (i: number): number => ridgeDocs[i]!.width / 2 + ridgeDocs[i]!.falloff;
  const buildRiverSegs = (docs: readonly RiverDoc[]): FeatureBuckets<PolySegment> =>
    segmentBuckets(
      segmentsOf(
        docs,
        (r) => r.bedY,
        // the per-point WATER SURFACE rides the side channel, the same on both
        // sides: the pools are solved once (refineRivers) and every consumer —
        // carve, levee, waterY, the water mesh — reads the one level
        (r) => {
          const surface = surfaceOf(r);
          return surface ? [surface, surface] : [undefined, undefined];
        },
        (r) => (r.widths && r.widths.length === r.points.length ? r.widths : undefined),
      ),
      (i) => riverReach(docs[i]!),
    );
  let riverSegs = buildRiverSegs(riverDocs);
  const roadSegs = segmentBuckets(
    segmentsOf(
      roadDocs,
      (r) => r.surfaceY,
      (r) => (roadSmooth(r) > 0 ? [r.leftY, r.rightY] : [undefined, undefined]),
    ),
    roadReach,
  );
  // The same segments bucketed wider for `featureClearance`: a scatter rule
  // asks "how far to the nearest path" from up to a dozen metres out, and a
  // bucket sized for the carve would answer "no path here" from 9 m away —
  // which is how a boulder with a 9 m clearance lands 8 m from a trail.
  // Separate buckets so the carve pays nothing for it.
  const CLEARANCE_REACH = 16;
  const roadClearSegs = segmentBuckets(
    segmentsOf(roadDocs, (r) => r.surfaceY),
    (i) => roadReach(i) + CLEARANCE_REACH,
  );
  const canyonSegs = segmentBuckets(segmentsOf(canyonDocs, (c) => c.floorY), canyonReach);
  // per-point crest heights ride the value channel; NaN falls back to the doc's height
  const ridgeSegs = segmentBuckets(
    segmentsOf(ridgeDocs, (r) => (r.heights && r.heights.length === r.points.length ? r.heights : undefined)),
    ridgeReach,
  );
  const towns = makeBuckets<TownDoc>(recipe.features.towns, (tw) => {
    // a terrace may hang off the pad's edge — a shelf cut into the slope
    // below it — so the bucket has to hold the town AND its shelves
    let minX = tw.center[0] - tw.radius - tw.falloff;
    let minZ = tw.center[1] - tw.radius - tw.falloff;
    let maxX = tw.center[0] + tw.radius + tw.falloff;
    let maxZ = tw.center[1] + tw.radius + tw.falloff;
    for (const terrace of tw.terraces) {
      const [tminX, tminZ, tmaxX, tmaxZ] = polylineBounds(terrace.points, terrace.radius + terrace.falloff);
      if (tminX < minX) minX = tminX;
      if (tminZ < minZ) minZ = tminZ;
      if (tmaxX > maxX) maxX = tmaxX;
      if (tmaxZ > maxZ) maxZ = tmaxZ;
    }
    return [minX, minZ, maxX, maxZ];
  });
  const lakes = makeBuckets<LakeDoc>(lakeDocs, lakeBounds);
  const fillDocs = recipe.features.fills;
  const fills = makeBuckets<FillDoc>(fillDocs, (f) => polylineBounds(f.polygon, f.bank + 2));
  // Outlines are rasterised once (polygon-index.ts): a column deep inside a
  // lake or far from its shore answers in one lookup, and only the band
  // along the shore pays for exact segment distances. Testing all 160
  // vertices of a traced outline per column, twice, was the biggest cost
  // left in a cell near water.
  const lakeIndex = new PolygonIndex(lakeDocs.map(lakeOutlineSpec));
  const lakeNo = new Map<LakeDoc, number>(lakeDocs.map((l, i) => [l, i]));
  /** Signed distance to a lake's shoreline: negative inside the water (±1e6 well away from the shore). */
  const lakeDistance = (lake: LakeDoc, x: number, z: number): number => lakeIndex.signedDistance(lakeNo.get(lake)!, x, z);
  const fillIndex = new PolygonIndex(fillDocs.map((f) => ({ kind: "polygon", points: f.polygon, band: f.bank + 2 }) as OutlineSpec));
  const fillNo = new Map<FillDoc, number>(fillDocs.map((f, i) => [f, i]));
  /** Widest the blob ever gets — a taper may widen upward as well as narrow. */
  const blobReach = (b: BlobDoc): number => Math.max(b.radius, b.topRadius ?? b.radius);
  const blobs = makeBuckets<BlobDoc>(recipe.features.blobs, (b) => [
    b.center[0] - blobReach(b) * b.scaleX - b.falloff,
    b.center[2] - blobReach(b) * b.scaleZ - b.falloff,
    b.center[0] + blobReach(b) * b.scaleX + b.falloff,
    b.center[2] + blobReach(b) * b.scaleZ + b.falloff,
  ]);
  const hasFeatures =
    riverDocs.length + canyonDocs.length + ridgeDocs.length + roadDocs.length + recipe.features.towns.length + lakeDocs.length + fillDocs.length > 0;
  const hasBlobs = recipe.features.blobs.length > 0;
  const hits: OwnerHit[] = [];
  /** While solving a hand-written river's bed: applyFeatures stops after the water stage (no towns, no roads). */
  let waterStageOnly = false;
  /** Signed shore distance per nearby lake for the column being evaluated (applyFeatures scratch). */
  const lakeSd: number[] = [];

  // Tunnels are stored as polylines but sampled as SEGMENTS: flattening them
  // once here means the hot path never walks a polyline, only the handful of
  // segments whose footprint covers this column.
  const segments: TunnelSegment[] = [];
  for (const tunnel of recipe.features.tunnels) {
    const last = tunnel.points.length - 1;
    for (let i = 0; i < last; i++) {
      const a = tunnel.points[i]!;
      const b = tunnel.points[i + 1]!;
      const ra = tunnel.endRadius === undefined ? tunnel.radius : tunnel.radius + (tunnel.endRadius - tunnel.radius) * (i / last);
      const rb = tunnel.endRadius === undefined ? tunnel.radius : tunnel.radius + (tunnel.endRadius - tunnel.radius) * ((i + 1) / last);
      segments.push({ ax: a[0], ay: a[1], az: a[2], bx: b[0], by: b[1], bz: b[2], ra, rb });
    }
  }
  const tunnelSegments = makeBuckets<TunnelSegment>(segments, (s) => {
    const pad = Math.max(s.ra, s.rb) + 1;
    return [
      Math.min(s.ax, s.bx) - pad,
      Math.min(s.az, s.bz) - pad,
      Math.max(s.ax, s.bx) + pad,
      Math.max(s.az, s.bz) + pad,
    ];
  });
  const hasTunnels = segments.length > 0;

  // ------------------------------------------------------------ border noise
  //
  // Two scales of raggedness applied to every biome border (recipe.climate.edge).
  // The warp is one octave on purpose: a domain warp does not need detail, it
  // needs displacement, and this runs per VERTEX.
  const edge = recipe.climate.edge;
  const edgeWarpA: FbmSpec = { frequency: edge.warpFrequency, amplitude: edge.warp, octaves: 1, lacunarity: 2, gain: 0.5, ridged: false, seed: edge.seed };
  const edgeWarpB: FbmSpec = { ...edgeWarpA, seed: edge.seed + 977 };
  // amplitude 1: the two consumers (climate jitter and height jitter) scale it
  // themselves, so one noise field serves both instead of two costing double
  const edgeUnitA: FbmSpec = { frequency: edge.frequency, amplitude: 1, octaves: edge.octaves, lacunarity: 2.1, gain: 0.5, ridged: false, seed: edge.seed + 131 };
  const edgeUnitB: FbmSpec = { ...edgeUnitA, seed: edge.seed + 263 };
  const hasEdgeWarp = edge.warp > 0;
  const hasEdgeNoise = edge.strength > 0 || edge.heightJitter > 0;
  /**
   * Inside a zone the climate is the anchor's, plus a little of the classic
   * noise so a big region still drifts from one end to the other. Small on
   * purpose: the whole point of zones is that a region is one kind of place.
   */
  const ZONE_CLIMATE_DRIFT = 0.06;

  // ------------------------------------------------------------------ dunes
  const dunes = t.dunes;
  const hasDunes = dunes.amplitude > 0;
  const duneSpec: FbmSpec = { frequency: dunes.frequency, amplitude: dunes.amplitude, octaves: dunes.octaves, lacunarity: 2.05, gain: 0.55, ridged: true, seed: dunes.seed };
  // the dune MASK only needs to know roughly where the desert is; two octaves
  // of a 0.0006-frequency field differ from three by far less than the window's
  // own blend width, and this runs per column
  const duneTempSpec: FbmSpec = { ...tempSpec, octaves: Math.min(2, tempSpec.octaves) };
  const duneMoistSpec: FbmSpec = { ...moistSpec, octaves: Math.min(2, moistSpec.octaves) };
  const duneCos = Math.cos(dunes.angle);
  const duneSin = Math.sin(dunes.angle);

  // ------------------------------------------------------------------ mesas
  const mesas = t.mesas;
  const hasMesas = mesas.amplitude > 0 && hasZones;
  const mesaSpec: FbmSpec = { frequency: mesas.frequency, amplitude: 1, octaves: mesas.octaves, lacunarity: 2.1, gain: 0.5, ridged: false, seed: mesas.seed };

  // ---------------------------------------------------------------- ceiling
  const ceiling = t.ceiling;
  const hasCeiling = !!ceiling && ceiling.height > 0;

  // ------------------------------------------------------------------ coast
  const coast = t.coast;
  const hasCoastCliffs = coast.cliff > 0 && coast.band > 0;
  const coastSpec: FbmSpec = { frequency: coast.frequency, amplitude: 1, octaves: 3, lacunarity: 2.1, gain: 0.5, ridged: false, seed: coast.seed };
  const cliffs = t.cliffs;
  const hasCliffs = cliffs.enabled && cliffs.sharpness > 0 && cliffs.strength > 0 && t.mountains.amplitude !== 0;
  const cliffMaskSpec: FbmSpec = {
    frequency: cliffs.mask.frequency,
    amplitude: 1,
    octaves: cliffs.mask.octaves,
    lacunarity: 2,
    gain: 0.5,
    ridged: false,
    seed: cliffs.mask.seed,
  };
  const cliffJitterSpec: FbmSpec = {
    frequency: cliffs.jitterFrequency,
    amplitude: cliffs.jitter,
    octaves: 2,
    lacunarity: 2,
    gain: 0.5,
    ridged: false,
    seed: cliffs.seed,
  };

  const surfaceCount = recipe.surfaces.length;
  const biomeCount = recipe.biomes.length;
  // rules allowed to answer "which biome is this"; a world of nothing but
  // cover rules still has to name somewhere, so fall back to all of them
  const labelled = recipe.biomes.map((b, i) => (b.label ? i : -1)).filter((i) => i >= 0);
  const labelIndices = labelled.length > 0 ? labelled : recipe.biomes.map((_, i) => i);
  /** Anchor indices each biome rule is gated to, or null for an ungated rule. */
  const biomeZones: (number[] | null)[] = recipe.biomes.map((b) => {
    if (!b.zones || b.zones.length === 0 || !hasZones) return null;
    const list = b.zones.map((id) => anchorIndex.get(id)).filter((i): i is number => i !== undefined);
    // a rule gated to zones that do not exist would silently vanish; keep it
    // ungated and let its own windows decide, which at least renders
    return list.length > 0 ? list : null;
  });

  /** Palette index for a surface name, or -1. Names are the recipe's public handle on a layer. */
  function surfaceIndex(name: string): number {
    const wanted = name.trim().toLowerCase();
    if (!wanted) return -1;
    return recipe.surfaces.findIndex((s) => s.name.toLowerCase() === wanted);
  }

  // --------------------------------------------------------------- patches
  interface PatchRuntime {
    spec: FbmSpec;
    surface: number;
    biomes: number[];
    threshold: number;
    blend: number;
    strength: number;
    slope: readonly [number, number] | undefined;
  }
  // A patch naming a surface or a biome that does not exist is DROPPED rather
  // than throwing: a recipe legitimately names things before they are added,
  // and losing a blotch pattern must never cost you the whole world.
  const patches: PatchRuntime[] = [];
  for (const patch of recipe.patches as readonly PatchDoc[]) {
    const surface = surfaceIndex(patch.surface);
    if (surface < 0 || patch.strength <= 0) continue;
    const biomes = patch.biomes
      .map((id) => recipe.biomes.findIndex((b) => b.id === id))
      .filter((i) => i >= 0);
    if (patch.biomes.length > 0 && biomes.length === 0) continue;
    patches.push({
      spec: { frequency: patch.frequency, amplitude: 1, octaves: patch.octaves, lacunarity: 2.1, gain: 0.5, ridged: false, seed: patch.seed + 3001 },
      surface,
      biomes,
      threshold: patch.threshold,
      blend: Math.max(patch.blend, 1e-4),
      strength: patch.strength,
      slope: patch.slope,
    });
  }
  const hasPatches = patches.length > 0;

  // ---------------------------------------------------------- road painting
  //
  // A graded road is invisible from any distance: grass mown flat is still
  // grass. What reads as a road is the SURFACE changing along it.
  interface RoadSegment {
    ax: number;
    az: number;
    bx: number;
    bz: number;
    half: number;
    verge: number;
    target: number;
    /** Per-biome override of `target` (index into the palette, -1 = none), or null when the road has one surface everywhere. */
    targets: Int16Array | null;
  }
  const paintSegments: RoadSegment[] = [];
  for (const road of recipe.features.roads) {
    const target = surfaceIndex(road.surface);
    if (target < 0) continue;
    // a footpath is gravel across the snowline and dirt below it: the swap
    // is keyed by biome id and blended by membership at paint time
    let targets: Int16Array | null = null;
    if (road.surfaceByBiome) {
      for (let b = 0; b < biomeCount; b++) {
        const name = road.surfaceByBiome[recipe.biomes[b]!.id];
        if (!name) continue;
        const index = surfaceIndex(name);
        if (index < 0 || index === target) continue;
        targets ??= new Int16Array(biomeCount).fill(-1);
        targets[b] = index;
      }
    }
    for (let i = 0; i + 1 < road.points.length; i++) {
      const a = road.points[i]!;
      const b = road.points[i + 1]!;
      paintSegments.push({ ax: a[0], az: a[1], bx: b[0], bz: b[1], half: road.width / 2, verge: road.surfaceEdge, target, targets });
    }
  }
  // rivers paint their beds and banks the same way, so cover that gates on the
  // grass surface (the grass billboards) stops at the water. Rebuilt once the
  // rivers are resampled (refineRivers), so the paint follows the carve.
  const buildPaint = (): FeatureBuckets<RoadSegment> => {
    const all = paintSegments.slice();
    for (const river of riverDocs) {
      const target = surfaceIndex(river.surface);
      if (target < 0) continue;
      for (let i = 0; i + 1 < river.points.length; i++) {
        const a = river.points[i]!;
        const b = river.points[i + 1]!;
        all.push({ ax: a[0], az: a[1], bx: b[0], bz: b[1], half: river.width / 2 + river.bank * 0.45, verge: river.surfaceEdge, target, targets: null });
      }
    }
    return makeBuckets<RoadSegment>(all, (s) => {
      const pad = s.half + s.verge + 2;
      return [Math.min(s.ax, s.bx) - pad, Math.min(s.az, s.bz) - pad, Math.max(s.ax, s.bx) + pad, Math.max(s.az, s.bz) + pad];
    });
  };
  let roadPaint = buildPaint();
  let hasRoadPaint = roadPaint.map.size > 0;
  // fine noise on the verge, so the dirt does not end on a mathematically
  // perfect stripe — the single tell that a road was generated rather than worn
  const vergeSpec: FbmSpec = { frequency: 0.075, amplitude: 1, octaves: 2, lacunarity: 2.2, gain: 0.5, ridged: false, seed: 1471 };
  const biomeTints = recipe.biomes.map((b) => (b.tint ? hexToRgb(b.tint) : null));
  // pre-widen every rule to the FULL palette so the hot loop never branches
  const groundWeights = recipe.biomes.map((b) => padToPalette(b.surface));
  const cliffWeights = recipe.biomes.map((b) => padToPalette(b.cliff ?? b.surface));

  /** A rule's weights widened to the full palette and normalized to sum 1. */
  function padToPalette(values: readonly number[]): Float32Array {
    const out = new Float32Array(surfaceCount);
    let sum = 0;
    for (let i = 0; i < values.length && i < surfaceCount; i++) {
      out[i] = Math.max(0, values[i]!);
      sum += out[i]!;
    }
    if (sum > 0) for (let i = 0; i < surfaceCount; i++) out[i] = out[i]! / sum;
    else out[0] = 1;
    return out;
  }

  /** The level a `flatten`ed zone sinks toward: just above the land floor, so a swamp is dry land that is barely so. */
  const swampLevel = floorY + 2.5;

  function naturalHeight(x: number, z: number): number {
    let relief = 1;
    let hillsMul = 1;
    let dunesMul = -1;
    let mesasMul = 0;
    let flatten = 0;
    if (hasZones) {
      zoneAtWarped(x, z);
      relief = zoneForm.relief;
      hillsMul = zoneForm.hills;
      dunesMul = zoneForm.dunes;
      mesasMul = zoneForm.mesas;
      flatten = zoneForm.flatten;
    }
    const wx = x + (t.warp.strength > 0 ? fbm2(warpA, x, z, seed) : 0);
    const wz = z + (t.warp.strength > 0 ? fbm2(warpB, x + 137.5, z - 91.25, seed) : 0);
    let h = t.base + fbm2(continent, wx, wz, seed);
    // a flattened zone (swamp, marsh) is pulled down toward the waterline and
    // loses most of its hills, but never its detail: it is level, not smooth
    if (flatten > 0) {
      h += (swampLevel - h) * flatten;
      hillsMul *= 1 - flatten * 0.8;
    }
    if (hillsMul > 0) h += fbm2(hills, wx, wz, seed) * hillsMul;
    if (t.mountains.amplitude !== 0 && relief > 0) {
      // the mask is what keeps ridged noise from putting a peak in every field
      const raw = fbm2(maskSpec, wx, wz, seed) * 0.5 + 0.5;
      const mask = smoothstep(t.mountainMask.start, t.mountainMask.end, raw) * Math.min(relief, 1.5);
      if (mask > 0) {
        let mrelief = fbm2(mountains, wx, wz, seed) * mask;
        if (hasCliffs) mrelief = terraceAt(mrelief, wx, wz, mask);
        h += mrelief;
      }
    }
    if (hasMesas && mesasMul > 0) h += mesaAt(wx, wz) * mesasMul;
    h += fbm2(detail, wx, wz, seed);
    if (hasDunes) h += duneAt(x, z, dunesMul);
    if (hasCeiling) h = ceilingAt(h);
    // Bounds govern every band above: a mountain that strays past the coast is
    // pulled under with everything else rather than standing offshore.
    if (hasBounds) h = boundAt(x, z, h);
    // Coast cliffs LAST: they steepen whatever profile crosses sea level, and
    // with a shore profile that profile is the one bounds just built.
    if (hasCoastCliffs) h = coastAt(x, z, h);
    return h;
  }

  /**
   * Soft ceiling: everything above `height - softness` is compressed toward
   * `height` on an exponential, so the map is monotonic (no fold, no flat cap)
   * and every peak in the world approaches one common summit line. This is
   * what lets the mountain band have a big amplitude for tall steep flanks
   * without a single summit being sliced flat at `maxY`.
   */
  function ceilingAt(h: number): number {
    const top = ceiling!.height;
    const c0 = top - ceiling!.softness;
    if (h <= c0) return h;
    const room = top - c0;
    return c0 + room * (1 - Math.exp(-(h - c0) / room));
  }

  /**
   * Signed distance to the coast, positive inland, plus the local coast band
   * width. `max` over the continents so two landmasses that overlap merge into
   * one coast instead of building a ridge of doubled height between them; the
   * world limit is an inverted continent — a shore that faces inward.
   *
   * The distance to a landmass is DISPLACED by noise before it is compared to
   * the radius, rather than the height being blended with noise afterwards.
   * That distinction is the whole look: displacing the distance moves the
   * coastline itself, giving headlands and bays that the terrain then drapes
   * over; blending afterwards would just make a fuzzy circular beach.
   */
  /** Smooth maximum: the union of two inland distances without a crease where they meet. */
  function smoothMax(a: number, b: number, k: number): number {
    if (k <= 0) return Math.max(a, b);
    const h = clamp(0.5 + (0.5 * (a - b)) / k, 0, 1);
    return b + (a - b) * h + k * h * (1 - h);
  }

  const shoreScratch = { distance: -Infinity, band: 1 };
  function shoreAt(x: number, z: number): typeof shoreScratch {
    let best = -Infinity;
    let band = 1;
    for (let i = 0; i < continents.length; i++) {
      const c = continents[i]!;
      const dx = x - c.center[0];
      const dz = z - c.center[1];
      // inland distance to the main disc, unioned with each lobe: a lobe is
      // the same disc-with-radius, so `radius - d` is comparable across them
      let inland = c.radius - Math.sqrt(dx * dx + dz * dz);
      for (const lobe of c.lobes) {
        const lx = dx - lobe[0];
        const lz = dz - lobe[1];
        inland = smoothMax(inland, lobe[2] - Math.sqrt(lx * lx + lz * lz), c.lobeBlend);
      }
      let d = c.radius - inland;
      if (c.warp > 0) {
        d += fbm2(coastWarpSpecs[i]!, x, z, seed) * c.falloff * c.warp;
        d += fbm2(coastShapeSpecs[i]!, x, z, seed) * c.radius * 0.3 * c.warp;
      }
      let falloff = c.falloff;
      if (c.coastVariation > 0) falloff *= 1 + fbm2(coastVarSpecs[i]!, x, z, seed) * c.coastVariation;
      // the shoreline sits `shelf` of the way through the band, counted from the sea
      const s = c.radius + falloff * (1 - shelf) - d;
      if (s > best) {
        best = s;
        band = falloff;
      }
    }
    if (worldLimit !== Infinity) {
      const s = worldLimit - limitFalloff * 0.5 - Math.sqrt(x * x + z * z);
      if (s < best) {
        best = s;
        band = limitFalloff;
      }
    }
    shoreScratch.distance = best;
    shoreScratch.band = band;
    return shoreScratch;
  }

  /** Legacy continent mask (landFloor = 0): 1 well inland, 0 in open ocean. */
  function continentMask(x: number, z: number): number {
    const shore = shoreAt(x, z);
    // the legacy blend spans the whole band: 1 at `radius`, 0 at `radius + falloff`
    const inland = shore.distance + shore.band * (1 - shelf); // metres past the outer edge of the band
    return smoothstep(0, shore.band, inland);
  }

  /**
   * Shore profile: the ground the coast band would be with NO relief at all.
   * Rises from the ocean floor to the land floor through the waterline at a
   * beach grade, continuous in slope across the shoreline so the beach simply
   * continues under water. Beyond `band` out to sea it is flat ocean floor.
   */
  function shoreProfile(s: number, band: number): number {
    if (s >= 0) {
      const l = Math.max(4, landFloor / BEACH_GRADE);
      return recipe.seaLevel + landFloor * (1 - Math.exp(-s / l));
    }
    const u = -s;
    const oceanDepth = recipe.seaLevel - oceanFloor;
    const w = Math.max(60, band * 0.9);
    const depth = BEACH_GRADE * u + (oceanDepth - BEACH_GRADE * u) * smoothstep(0, w, u);
    return recipe.seaLevel - Math.min(oceanDepth, Math.max(0, depth));
  }

  function boundAt(x: number, z: number, h: number): number {
    if (!hasShoreProfile) {
      const m = continentMask(x, z);
      if (m >= 1) return h;
      if (m <= 0) return oceanFloor;
      return oceanFloor + (h - oceanFloor) * m;
    }
    const shore = shoreAt(x, z);
    const s = shore.distance;
    const base = shoreProfile(s, shore.band);
    // relief above the land floor fades in over the inland part of the band,
    // so mountains caught in it are compressed into lowlands rather than
    // meeting the water — except where the coast is steep, when the band is
    // narrow and the fade is short: that is where the sea cliffs are
    const reliefBand = Math.max(40, shore.band * (1 - shelf));
    const r = smoothstep(0, reliefBand, s);
    if (r <= 0) return base;
    return base + softPositive(h - floorY, 3) * r;
  }

  /**
   * Cliff terracing: spend most of each altitude band on a short riser and
   * flatten the rest into a tread.
   *
   * `relief` is the MOUNTAIN band's contribution, already masked — not the
   * finished height. Two things fall out of that and both are the point:
   *
   * - It self-gates. The mask is zero over meadows, so `relief` is zero there
   *   and the remap has nothing to act on. No slope test is needed, which is
   *   what makes this affordable: `slope()` is defined as a difference of
   *   `height()`, so a slope gate inside `height()` would either recurse or
   *   cost four more evaluations of the most-called function in the generator.
   * - The treads are not level. Continent and hills are added afterwards, so
   *   every ledge rides the larger landform. Perfectly level treads read as a
   *   contour map; tilted ones read as strata.
   *
   * The shaping is a linear stretch of each band's fractional part about its
   * midpoint, clamped — monotonic by construction, so the surface stays a
   * function and no fold or self-intersection can appear. `jitter` displaces
   * the band boundaries per place so the whole world does not share one set of
   * altitudes to step at.
   */
  function terraceAt(relief: number, wx: number, wz: number, mountain: number): number {
    // THREE gates, and each one is here because of a distinct way this went
    // wrong on a real world:
    //
    // 1. the noise mask — WHERE. Terracing every mountain uniformly gives a
    //    range of ziggurats; a real range is mostly smooth flank with cliff
    //    bands breaking out of it here and there.
    // 2. the mountain mask — terracing must FADE IN with the mountains it
    //    belongs to. Without this the band's own edge, where the mask is barely
    //    above zero, still gets full-strength terracing: a hillock with one
    //    band's worth of relief becomes a single enormous step, which reads far
    //    harsher than the mountain does because there is no mountain around it
    //    to explain it.
    // 3. the relief fade — below a couple of bands there is not enough height
    //    to carry a terrace at all. `step` metres of riser on `step` metres of
    //    hill is a cliff on a hillock, and it is visible from a long way off.
    const raw = fbm2(cliffMaskSpec, wx, wz, seed) * 0.5 + 0.5;
    const gates =
      smoothstep(cliffs.mask.start, cliffs.mask.end, raw) *
      Math.min(1, mountain) *
      smoothstep(cliffs.step * cliffs.minBands, cliffs.step * (cliffs.minBands + 1.4), relief);
    // SHARPENED, not used raw. Three gates multiplied together spend most of
    // their range around a half, and a half-applied terrace is worse than
    // either end: it flattens the treads without ever steepening the risers to
    // vertical, so the net effect measured over a world is LESS sheer ground
    // than no terracing at all. The blend wants to be mostly 0 or mostly 1,
    // with the transition narrow enough that little ground sits inside it.
    const m = smoothstep(0.22, 0.55, gates) * cliffs.strength;
    if (m <= 0.002) return relief;
    const step = cliffs.step;
    const offset = cliffs.jitter > 0 ? fbm2(cliffJitterSpec, wx, wz, seed) : 0;
    const t = (relief + offset) / step;
    const band = Math.floor(t);
    const shaped = softClamp((t - band - 0.5) / (1 - cliffs.sharpness) + 0.5, cliffs.rounding);
    const terraced = (band + shaped) * step - offset;
    return relief + (terraced - relief) * m;
  }

  /**
   * clamp(u, 0, 1) with the two corners rounded off over `r` of the range at
   * each end: a quadratic that leaves 0 with zero slope and joins the linear
   * middle with slope one, mirrored at the top. C1 and monotonic, so the
   * terrace stays a function; and r = 0 is exactly the hard clamp.
   *
   * The hard clamp is what made every cliff top a crease. A riser meeting its
   * tread at a corner is a slope discontinuity along the whole length of the
   * band edge, and marching cubes turns that into a knife edge that catches
   * the eye from far off and snags a trail crossing it. The rounded version
   * arrives at the tread on a curve — the same difference as between a
   * quarry face and a weathered crag.
   */
  function softClamp(u: number, r: number): number {
    if (r <= 0) return clamp(u, 0, 1);
    if (u <= -r) return 0;
    if (u < r) return ((u + r) * (u + r)) / (4 * r);
    if (u <= 1 - r) return u;
    if (u < 1 + r) return 1 - ((1 + r - u) * (1 + r - u)) / (4 * r);
    return 1;
  }

  /**
   * Sea cliffs: steepen the shoreline PROFILE in place, rather than adding a
   * cliff-shaped bump to it.
   *
   * The land near sea level is remapped `dh -> dh * k` with k > 1 at the
   * waterline, tapering back to 1 by `band`. Because the remap is monotonic
   * and continuous, the coastline stays exactly where the noise put it and the
   * terrain stays a function — it just crosses the last twenty metres of
   * altitude in two metres of ground instead of forty.
   *
   * Everything else follows for free: the beach biome's height window is
   * traversed in a couple of metres so sand survives only in the gentle bays,
   * the `crag` rule paints the steep face bare rock, and the sea floor drops
   * away below a headland instead of shelving.
   */
  function coastAt(x: number, z: number, h: number): number {
    const dh = h - recipe.seaLevel;
    const a = Math.abs(dh);
    if (a >= coast.band) return h;
    const rugged = smoothstep(coast.start, coast.end, fbm2(coastSpec, x, z, seed) * 0.5 + 0.5);
    if (rugged <= 0.001) return h;
    const k = 1 + coast.cliff * rugged * (1 - smoothstep(0, coast.band, a));
    return recipe.seaLevel + dh * k;
  }

  /**
   * The desert's own landform: ridged, stretched crests. Masked by the ZONE
   * when the recipe has zones (`mul` >= 0), else by the same climate window
   * the desert BIOME uses so the sand and the dunes arrive together.
   */
  function duneAt(x: number, z: number, mul: number): number {
    let mask: number;
    if (mul >= 0) mask = Math.min(mul, 1.5);
    else {
      const temp = spread(fbm2(duneTempSpec, x, z, seed) * 0.5 + 0.5);
      const moist = spread(fbm2(duneMoistSpec, x, z, seed) * 0.5 + 0.5);
      mask = window(temp, dunes.temperature, dunes.blend) * window(moist, dunes.moisture, dunes.blend);
    }
    if (mask <= 0.002) return 0;
    // rotate into the wind frame, then compress ACROSS it: the noise is
    // traversed slowly along the ridge axis and quickly across it, which is
    // the whole difference between dunes and lumps
    const rx = (x * duneCos - z * duneSin) / dunes.stretch;
    const rz = x * duneSin + z * duneCos;
    return fbm2(duneSpec, rx, rz, seed) * mask;
  }

  /**
   * Badlands: a plateau band quantized into strata. Tables where the noise is
   * high, buttes where a high spot is small, and every wall a stack of risers
   * and treads — the silhouette that reads as badland from any distance.
   */
  function mesaAt(wx: number, wz: number): number {
    const n = fbm2(mesaSpec, wx, wz, seed) * 0.5 + 0.5;
    return terrace(clamp(n, 0, 1), mesas.steps, mesas.sharpness) * mesas.amplitude;
  }

  /**
   * Terraced wall profile: 0 at the canyon floor, 1 at the rim.
   *
   * A straight ramp gives a smooth chute; quantizing it into `steps` and
   * easing each riser gives bedded rock. `sharpness` slides continuously
   * between the two, and at either extreme the function is still continuous
   * and still exactly 0 and 1 at its ends — which matters, because any
   * discontinuity here is a vertical crack in the terrain.
   */
  function terrace(t01: number, steps: number, sharpness: number): number {
    if (steps <= 1) return t01;
    const k = t01 * steps;
    const i = Math.min(steps - 1, Math.floor(k));
    const f = k - i;
    const half = sharpness * 0.5;
    const eased = smoothstep(0.5 - half - 1e-4, 0.5 + half + 1e-4, f);
    return (i + eased) / steps;
  }

  function applyFeatures(h: number, x: number, z: number): number {
    if (!hasFeatures) return h;
    let out = h;

    // Canyons first: they are the biggest cut in the world, and a river or a
    // road that meets one should land on its floor rather than fight it.
    let count = nearestPerOwner(canyonSegs, x, z, hits);
    for (let k = 0; k < count; k++) {
      const hit = hits[k]!;
      const canyon = canyonDocs[hit.owner]!;
      const half = canyon.width / 2;
      if (hit.distance > half + canyon.rim) continue;
      const floor = Number.isNaN(hit.value) ? out - canyon.depth : hit.value;
      const t01 = canyon.rim <= 0 ? 1 : clamp((hit.distance - half) / canyon.rim, 0, 1);
      const carved = floor + (out - floor) * terrace(t01, canyon.steps, canyon.stepSharpness);
      // a canyon only ever cuts down; it must not build a wall where the
      // surrounding land already sits below its floor
      if (carved < out) out = carved;
    }

    // Ridges after canyons, before water: a barrier RAISED along a zone
    // border that had none (docs/world-editing/barriers.md). Flat crest
    // `width` wide, flanks easing to natural ground over `falloff`, round
    // caps at the ends (the segment distance already gives those) — so a gap
    // between two pieces is a saddle, a PASS, not a doorway. Raise only: a
    // ridge never digs, and the river cut below runs after it, so a ridge
    // across a channel stays out of the water.
    if (ridgeDocs.length > 0) {
      count = nearestPerOwner(ridgeSegs, x, z, hits);
      for (let k = 0; k < count; k++) {
        const hit = hits[k]!;
        const ridge = ridgeDocs[hit.owner]!;
        const half = ridge.width / 2;
        if (hit.distance > half + ridge.falloff) continue;
        const crest = Number.isNaN(hit.value) ? ridge.height : hit.value;
        const profile = hit.distance <= half ? 1 : 1 - smoothstep(0, ridge.falloff, hit.distance - half);
        const raised = out + crest * profile;
        if (raised > out) out = raised;
      }
    }

    // How much of this column is under standing or flowing water, 0..1 —
    // 1 inside a lake outline or a river's waterline, fading to 0 a little
    // way up the bank. The features that come AFTER water (towns, roads)
    // yield to it: a road's embankment that reached into a lake raised the
    // lake bed above its surface, and one that ran beside a river regraded
    // the channel into a beach. Water is the one thing later features must
    // not build over.
    let wet = 0;

    // the lakes near this column, their signed shore distances measured
    // once: the fills need to know where the water is, then the lakes carve
    const nearLakes = bucketAt(lakes, x, z) as readonly LakeDoc[];
    for (let k = 0; k < nearLakes.length; k++) lakeSd[k] = lakeDistance(nearLakes[k]!, x, z);

    // Sediment before water: a hollow the drainage crossed but that is not
    // a lake is raised to its spill level, so the river below cuts through
    // a valley floor instead of a chain of ponds. Raise only, never lower —
    // and never under a lake's sheet: two basins' shallows can overlap, and
    // a fill raised there stood out of the neighbouring lake as a grey
    // sliver of ground in the water.
    const nearFills = bucketAt(fills, x, z) as readonly FillDoc[];
    if (nearFills.length > 0) {
      let underLake = false;
      for (let k = 0; k < nearLakes.length; k++) if (lakeSd[k]! <= nearLakes[k]!.bank * 0.5) underLake = true;
      if (!underLake) {
        for (const fill of nearFills) {
          if (out >= fill.y) continue;
          const sd = fillIndex.signedDistance(fillNo.get(fill)!, x, z);
          if (sd > fill.bank) continue;
          const w = sd <= 0 ? 1 : 1 - smoothstep(0, fill.bank, sd);
          out = out + (fill.y - out) * w;
        }
      }
    }

    // Lakes before rivers: a river that ends in a lake ends AT its surface,
    // and its last bed points sit under the lake's own basin.
    //
    // A lake is water standing in a bowl the TERRAIN already has — the
    // hydrology found the basin in this very heightfield — so the carve
    // trusts the ground and only deepens it. The polygon is an outline
    // traced on a 16 m grid and simplified; it is right to within a cell or
    // two, and the first version carved FROM it: everything inside was dug
    // to `depth` and a band outside was pulled down to the waterline. Where
    // the outline overshot onto a hillside that made a crater with a
    // vertical wall at the polygon edge, and outside it a terrace at water
    // level — "the geometry around lakes looks strange". Now:
    //   - inside, ground that is at or under the surface is deepened toward
    //     `depth`, blended over two banks from the shore so the bed is a bowl
    //     and never a step; ground standing more than a metre or so above the
    //     surface is an island or an overshoot and is left alone (the sheet
    //     is buried in it, which is the shoreline for free);
    //   - outside, nothing is carved. The sheet is drawn half a bank past the
    //     outline (chunk.ts) and hides under any ground above the surface.
    // A hand-placed lake (`carve: true`, the default) still digs its basin
    // outright: an author who drops a lake on a plateau means a lake there.
    for (let k = 0; k < nearLakes.length; k++) {
      const lake = nearLakes[k]!;
      const sd = lakeSd[k]!;
      if (sd > lake.bank) continue;
      const shoreY = lake.waterY - 0.6;
      if (lake.carve) {
        if (sd <= 0) {
          const bed = shoreY - lake.depth * smoothstep(0, lake.bank, -sd);
          if (bed < out) out = bed;
          wet = 1;
        } else {
          const w = 1 - smoothstep(0, lake.bank, sd);
          const eased = out + (shoreY - out) * w;
          if (eased < out) out = eased;
          wet = Math.max(wet, 1 - smoothstep(0, lake.bank * 0.5, sd));
        }
        continue;
      }
      // how much this column belongs to the water: 1 at or under the
      // surface, 0 a metre and a half above it
      const under = 1 - smoothstep(lake.waterY - 0.5, lake.waterY + 1.5, out);
      if (sd <= 0) {
        const bed = shoreY - lake.depth * smoothstep(0, lake.bank * 2, -sd);
        if (bed < out) out = out + (bed - out) * under;
        wet = Math.max(wet, under);
      } else {
        wet = Math.max(wet, (1 - smoothstep(0, lake.bank * 0.75, sd)) * under);
        // the berm: the outline was refined onto this terrain's waterline,
        // but a later carve (an inlet's banks, a road cut) can leave ground
        // just outside it under the water, and the sheet — drawn most of a
        // bank past the outline — then ends in mid-air over it. Ground in
        // the outer part of the band is held a hand above the water; a river
        // entering the lake cuts its channel through this afterwards.
        // Only a SMALL lift: ground metres under the water outside the outline
        // is a shelf the sheet should simply cover, and a berm that tall would
        // be a wall round the lake.
        // (The berm that stood here — ground in 0.3–0.7 of a bank lifted to
        // the surface + 0.4 — was a ring of ground INSIDE the sheet's reach:
        // a ridge standing in the lake with the water ending short of it.
        // containWater holds the shore now, outside the sheet only.)
      }
    }

    // How much of this column is under a LAKE, before the rivers have their
    // say: a river builds its floor everywhere except through standing water.
    // a crafted cascade's pools stand on a rock ledge the rivers then cut into
    if (solvedSites.length > 0) out = fallSiteLedge(solvedSites, x, z, out, RIVER_FALL_LIP);
    const lakeWet = wet;
    count = nearestPerOwner(riverSegs, x, z, hits);
    // The river's floor: the lowest bed of every channel whose band covers
    // this column, and how strongly the nearest of them covers it. A river
    // used to only ever CUT ("a river cuts, it does not build"), so wherever
    // its bed ran above the ground — across a hollow the drainage fill had
    // raised, along the foot of a slope its meander swung it onto — the
    // ribbon floated over a pit with dry ground under the water line. Real
    // rivers fill their own hollows with sediment: within the channel and
    // its banks the ground is now pulled UP to the bed as well as down to
    // it, so the valley floor is the river's. Taking the lowest bed among
    // overlapping channels keeps a tributary from building a sill across
    // the river it joins.
    let floor = Infinity;
    let floorW = 0;
    /** How far the floor may build up here: the bed a lot (sediment), the banks a hand. */
    let floorCap = RIVER_MAX_BUILD;
    for (let k = 0; k < count; k++) {
      const hit = hits[k]!;
      const river = riverDocs[hit.owner]!;
      // the head grows from a trickle: narrower, shallower banks, a bed that
      // is barely below the ground, until `taper` metres downstream
      const grow = river.taper > 0 ? smoothstep(0, river.taper, hit.along) : 1;
      const width = Number.isNaN(hit.width) ? river.width : hit.width;
      const half = (width / 2) * (0.2 + 0.8 * grow);
      // the bank follows the LOCAL width where the channel carries one: a
      // stream three metres wide does not get the banks of the river it
      // becomes twenty kilometres on (`bank` on the doc is the widest reach)
      const bankFull = riverBank(river, hit.width);
      const bank = bankFull * (0.35 + 0.65 * grow);
      let surface = hit.side;
      const full = Number.isNaN(hit.value) ? out - river.depth : hit.value;
      // a wet head is cut to its solved bed: the taper narrows it, it does not
      // make it shallower (the water is solved from that bed, and a shallow
      // head left the ground metres over its own water — a dry trench)
      let bed = river.water && !Number.isNaN(hit.value) ? full : out + (full - out) * (0.15 + 0.85 * grow);
      // At a fall the LIP LINE picks the level, not the nearest segment: the
      // lip segment interpolates between the two, so the lower gorge's bank
      // slope used to eat back into the upper level beside the lip.
      const lipNow = river.water ? lipAt(x, z) : null;
      if (lipNow && lipNow.lip!.owner === hit.owner && hit.along >= lipNow.lip!.along - 0.5 && hit.along <= lipNow.lip!.along + RIVER_FALL_LIP + 30) {
        if (lipNow.rel < 0) {
          bed = lipNow.lip!.bedTop;
          surface = lipNow.lip!.top;
        } else if (hit.along <= lipNow.lip!.along + RIVER_FALL_LIP + 0.5) {
          bed = lipNow.lip!.bedBottom;
          surface = lipNow.lip!.bottom;
        }
      }
      // The cut eases at a SLOPE LIMIT, not over one bank width: a channel
      // cut six metres into a hillside used to climb back to the ground
      // over the same 17 m as a channel cut one metre into a meadow — a
      // canal with a cliff for a bank. The band widens to 2.5× the cut
      // height (capped at three banks, which is the bucket reach), so a deep
      // cut is a valley side at about 22°, not a wall.
      const cutHeight = Math.max(0, out - bed);
      /** How strongly the cut holds here — what a dry gully's floor build follows. */
      let w = 0;
      if (river.water && grow >= HEAD_WET && !Number.isNaN(surface) && surface > bed) {
        // A wet channel is CUT as a channel: the flat bed, then one bank
        // slope that passes the waterline about 0.45 of a bank out and keeps
        // rising until it meets the land. The old blend pulled the whole
        // band toward the bed, so three-quarters of a bank out the land
        // stood half a metre over the water (measured, mmo) — a brimming
        // ditch, not a river in its banks. The slope is steep enough to show
        // a bank (the freeboard above the water) and never steeper than a
        // voxel can draw.
        let rise = Math.max(0.35, Math.min(0.9, (surface - bed) / Math.max(1, bank * 0.45)));
        // Below a fall the channel is a SLOT: walls near vertical for a stretch
        // as long as the drop, easing back to ordinary banks. With the ordinary
        // bank slope the gorge under a 25 m fall was a V seventy metres wide,
        // cut back into the cliff top on both sides of the lip.
        if (lipNow && lipNow.rel >= 0 && lipNow.lip!.owner === hit.owner) {
          const drop = lipNow.lip!.top - lipNow.lip!.bottom;
          rise += (FALL_GORGE_RISE - rise) * (1 - smoothstep(drop * 0.5, drop + 20, lipNow.rel));
        }
        // A cut too deep to meet the land at this slope within the carve's
        // reach (three banks) is steepened until it does, up to BANK_MAX_RISE,
        // instead of stopping in a wall: the old reach faded the cut out over
        // two metres, which stood the land back up as a one-voxel cliff at the
        // edge of every deep cut.
        const maxReach = bank * 3;
        if (cutHeight / rise + 2 > maxReach) rise = Math.min(Math.max(rise, BANK_MAX_RISE), Math.max(rise, cutHeight / Math.max(1, maxReach - 2)));
        const reach = Math.min(maxReach, cutHeight / rise + 2);
        const target = bed + Math.max(0, hit.distance - half) * rise;
        if (hit.distance > half + reach) continue;
        // a smooth minimum, so the bank rolls over into the land instead of creasing
        const k = 1.2;
        const h = Math.max(0, Math.min(1, 0.5 + (0.5 * (target - out)) / k));
        const cut = target + (out - target) * h - k * h * (1 - h);
        // and faded out over the last metres of the reach, where a cut too
        // deep to meet the land (a gorge wider than three banks) must stop
        // (over at least three voxels, so what remains is a slope the lattice can draw)
        const fadeSpan = Math.min(reach * 0.5, Math.max(2, voxelSize * 3));
        const fade = 1 - smoothstep(half + reach - fadeSpan, half + reach, hit.distance);
        w = fade;
        if (cut < out) out = out + (cut - out) * fade;
      } else {
        const cutBand = Math.max(bank, Math.min(bank * 3, cutHeight * 2.5));
        if (hit.distance > half + cutBand) continue;
        w = 1 - smoothstep(half, half + cutBand, hit.distance);
        if (w <= 0) continue;
        out = out + (Math.min(bed, out) - out) * w;
      }
      // The floor AND the banks. A channel on a side slope had its downhill
      // bank below its own water surface — the carve only ever cut — so the
      // sheet's outer edge hung in the air over dry ground. The build target
      // is the channel's cross-section: the bed inside the half-width, rising
      // to a natural levee (the water surface plus a hand) by the waterline
      // and holding it to the edge of the band, where the ribbon has already
      // ended. Only built above the sea (a mouth's bed is under the ocean
      // plane) and only under wet reaches — a dry gully just gets its floor.
      if (!Number.isNaN(hit.value) && bed > recipe.seaLevel) {
        const wetReach = river.water && grow >= HEAD_WET;
        // the levee stands a hand over the POOL, which holds level while the
        // ground falls away under it: without a bank above the pool's
        // downstream end the water would run out over the meadow
        const levee = (Number.isNaN(surface) ? bed + Math.max(0.4, river.depth * 0.7) : surface) + 0.5;
        const profile = wetReach ? bed + (levee - bed) * smoothstep(half, half + bank * 0.63, hit.distance) : bed;
        const hold = wetReach ? 1 - smoothstep(half + bank * 0.7, half + bank, hit.distance) : w;
        if (profile < floor) floorCap = hit.distance <= half + 0.5 ? RIVER_MAX_BUILD : SHORE_MAX_BUILD;
        floor = Math.min(floor, profile);
        floorW = Math.max(floorW, hold);
      }
      // the waterline sits about two thirds of the way up the bank profile
      // (see chunk.ts, where the ribbon is cut to the same rule)
      if (grow >= HEAD_WET && river.water) wet = Math.max(wet, 1 - smoothstep(half + bank * 0.45, half + bank * 0.8, hit.distance));
    }
    // bounded: a bed metres above the ground is sediment filling a hollow;
    // a bed a hundred metres above it is bad data, and no river builds a dam
    if (floorW > 0 && floor > out) out = out + (Math.min(floor, out + floorCap) - out) * floorW * (1 - lakeWet);
    // a crafted cascade's site-scale gorge: bowls, amphitheatre headwalls, stepped walls
    if (siteGorges.length > 0) out = siteGorgeAt(x, z, out);
    if (waterStageOnly) return out;

    for (const town of bucketAt(towns, x, z) as readonly TownDoc[]) {
      const d = Math.sqrt((x - town.center[0]) ** 2 + (z - town.center[1]) ** 2);
      if (d <= town.radius + town.falloff) {
        const w = (1 - smoothstep(town.radius, town.radius + town.falloff, d)) * town.flatten * (1 - wet);
        if (w > 0) {
          const pad = town.groundY ?? out;
          out = out + (pad - out) * w;
        }
      }
      // The shelves come AFTER the pad and in order, so a terraced town whose
      // `flatten` is 0 keeps its hill and only the shelves are level, and two
      // shelves that overlap resolve to the later one rather than to a ridge
      // between them.
      for (const terrace of town.terraces) {
        const td = distanceToPolyline(terrace.points, x, z);
        if (td > terrace.radius + terrace.falloff) continue;
        const w = (1 - smoothstep(terrace.radius, terrace.radius + terrace.falloff, td)) * terrace.flatten * (1 - wet);
        if (w <= 0) continue;
        out = out + (terrace.groundY - out) * w;
      }
    }

    count = nearestPerOwner(roadSegs, x, z, hits);
    for (let k = 0; k < count; k++) {
      const hit = hits[k]!;
      const road = roadDocs[hit.owner]!;
      const half = road.width / 2;
      if (Number.isNaN(hit.value)) continue; // an ungraded road has no height to impose
      // The roadway and its shoulder are kept even in water — that is a ford,
      // and the generator pins a crossing's surface just under the water — but
      // the embankment band beyond the shoulder never enters it.
      const dry = wet > 0 && hit.distance > half + road.shoulder ? 1 - wet : 1;
      if (dry <= 0) continue;
      if (Number.isNaN(hit.side)) {
        // no embankment profile: the shoulder simply blends the road height
        // into whatever ground is there
        if (hit.distance > half + road.shoulder) continue;
        const w = (1 - smoothstep(half, half + road.shoulder, hit.distance)) * road.flatten * dry;
        if (w > 0) out = out + (hit.value - out) * w;
        continue;
      }
      // The graded embankment. Between the road edge and the outer edge of
      // the band the ground is a clean S-curve from the road surface to the
      // side height the generator sampled there — a cut slope uphill, a fill
      // slope downhill — and the natural crinkle is only let back in over the
      // outer part of the band, where it blends between two heights that
      // already nearly agree. Blending the road height straight into rough
      // ground, the old way, left the roughness intact right up to the
      // shoulder, and a road on noisy ground read as a notch in jagged terrain.
      const outer = half + road.shoulder + road.smooth;
      if (hit.distance > outer) continue;
      // The face the band may hold: a cut no steeper than 1:1, a fill at
      // the angle of repose. The generator samples the side height at the
      // outer edge, and where a path skirts a cliff that height is twenty
      // metres up — an S-curve to it is a wall. Clamped, the bank stops at
      // what a bench cut looks like and the cliff above stays a cliff.
      const band = outer - half;
      const side = Math.min(hit.value + band * 1.0, Math.max(hit.value - band * 0.8, hit.side));
      const embankment = hit.value + (side - hit.value) * smoothstep(half, outer, hit.distance);
      const w = (1 - smoothstep(half + road.shoulder + road.smooth * 0.5, outer, hit.distance)) * road.flatten * dry;
      if (w <= 0) continue;
      out = out + (embankment - out) * w;
    }

    return containWater(x, z, out);
  }

  /**
   * The last word on every column near water: at the edge of a river's or a
   * lake's reach the ground stands a hand above that water, whatever the
   * features before it did. The water mesh (chunk.ts) is clipped against the
   * ground, so this is what keeps a pool inside its banks: without it, every
   * place the levee was not built — a bed below sea level, a road cut, the
   * build cap, a lake's inlet — let the water run out to the edge of its
   * reach and stop there in mid-air (measured: 14 % of shore vertices).
   * Never inside the water of any other lake or river, so a tributary's bank
   * cannot dam the trunk it joins.
   */
  /**
   * Rock beside every waterfall. From a little above the lip to just past its
   * foot, the ground beside the channel (off the bed, out to about a bank)
   * stands over the UPPER water, so the fall pours through a notch between
   * two cliffs instead of over a slope the water has to drape across. Built
   * up to 30 m (a coastal plunge), never inside a lake.
   */
  function fallWalls(x: number, z: number): { target: number; weight: number } {
    let target = -Infinity;
    let weight = 0;
    const count = nearestPerOwner(riverSegs, x, z, hits);
    // the bed of ANY wet channel is never walled: a branch splitting off to
    // fall beside the main one runs through the main fall's shoulder
    for (let k = 0; k < count; k++) {
      const hit = hits[k]!;
      const river = riverDocs[hit.owner]!;
      if (!river.water) continue;
      const half = (Number.isNaN(hit.width) ? river.width : hit.width) / 2;
      if (hit.distance < half + 1) return { target, weight: 0 };
    }
    for (let k = 0; k < count; k++) {
      const hit = hits[k]!;
      const river = riverDocs[hit.owner]!;
      const g = riverGeom[hit.owner];
      if (!river.water || !g || g.falls.length === 0) continue;
      const half = (Number.isNaN(hit.width) ? river.width : hit.width) / 2;
      const bank = riverBank(river, hit.width);
      const inside = hit.distance - half;
      if (inside < 0 || inside > bank * 2.2 + voxelSize * 3) continue;
      const lipNow = lipAt(x, z);
      for (const f of g.falls) {
        if (!lipNow || lipNow.lip!.owner !== hit.owner || Math.abs(lipNow.lip!.along - f.along) > 0.5) continue;
        // UPSTREAM of the lip line only: the banks that keep the upper water
        // in its channel up to the edge. Past the line the water is the
        // curtain and the pool below, and walls there stood out over the cliff
        // face as towers of dirt at the lake's level.
        const rel = lipNow.rel;
        if (rel < -FALL_WALL_UP - 3 || rel > 0.5) continue;
        // eased over at least three voxels at every edge (upstream start, the
        // rise off the channel): over a metre or two the 4 m lift stood as a
        // blade the lattice drew as a knife ridge beside every lip
        const ease = voxelSize * 3;
        const alongW = smoothstep(-FALL_WALL_UP - ease, -FALL_WALL_UP, rel) * (1 - smoothstep(-0.5, 0.5, rel));
        const sideW = smoothstep(0.2, 0.2 + ease, inside) * (1 - smoothstep(bank * 0.8, bank * 2.2 + ease, inside));
        const w = alongW * sideW;
        if (w <= 0) continue;
        weight = Math.max(weight, w);
        // sloping back from the channel, a shoulder of rock rather than a mesa
        target = Math.max(target, f.top + 1 - Math.max(0, inside - 2) * 0.55);
      }
    }
    if (weight > 0) {
      for (const lake of bucketAt(lakes, x, z) as readonly LakeDoc[]) if (lakeDistance(lake, x, z) <= lake.bank * 0.75) return { target, weight: 0 };
    }
    return { target, weight };
  }

  function containWater(x: number, z: number, out: number): number {
    const wall = fallWalls(x, z);
    const held = containWaterEdges(x, z, out);
    const walled = wall.weight <= 0 || wall.target <= held ? held : held + (Math.min(wall.target, held + FALL_WALL_RAISE) - held) * wall.weight;
    return unblade(x, z, walled);
  }

  /** Re-entry guard: unblade samples its neighbours through height(), which ends here again. */
  let inBlade = false;
  const bladeWater: SurfaceSample = { y: 0, flowX: 0, flowZ: 0, kind: "lake", floor: 0 };
  /**
   * No blades near a waterfall. Around a fall several cuts meet — the gorge,
   * the channel below it, a lake's shore, the sea scarp — and where two of
   * them passed each other a strip of the old ground a metre or two wide was
   * left standing between them, several metres over both (111 such columns
   * within 90 m of the mmo world's falls). Within BLADE_RADIUS of a fall's
   * foot a column standing more than BLADE_HEIGHT over BOTH its neighbours
   * BLADE_STEP away on any axis is cut down to a little over the higher of
   * them. Never below the water beside it plus a hand: a strip holding back
   * a lake or a river is lowered, never breached.
   */
  function unblade(x: number, z: number, out: number): number {
    if (inBlade || riverFalls.length === 0) return out;
    let near = false;
    for (const f of riverFalls) {
      if ((f.x - x) ** 2 + (f.z - z) ** 2 < BLADE_RADIUS * BLADE_RADIUS) {
        near = true;
        break;
      }
    }
    if (!near) return out;
    // and only beside a channel (within its cut band): blades are left
    // between cuts, and the open hillside around a fall has none to check
    let banked = false;
    const count = nearestPerOwner(riverSegs, x, z, hits);
    for (let k = 0; k < count && !banked; k++) {
      const hit = hits[k]!;
      const river = riverDocs[hit.owner]!;
      const half = (Number.isNaN(hit.width) ? river.width : hit.width) / 2;
      if (hit.distance < half + riverBank(river, hit.width) * 3 + BLADE_STEP) banked = true;
    }
    if (!banked) return out;
    inBlade = true;
    try {
      let cap = Infinity;
      for (const [ax, az] of BLADE_AXES) {
        const lx = x + ax * BLADE_STEP;
        const lz = z + az * BLADE_STEP;
        const rx = x - ax * BLADE_STEP;
        const rz = z - az * BLADE_STEP;
        const l = height(lx, lz);
        if (out - l <= BLADE_HEIGHT) continue;
        const r = height(rx, rz);
        if (out - r <= BLADE_HEIGHT) continue;
        let floor = Math.max(l, r) + 1;
        if (waterSurface(lx, lz, bladeWater)) floor = Math.max(floor, bladeWater.y + SHORE_MAX_BUILD);
        if (waterSurface(rx, rz, bladeWater)) floor = Math.max(floor, bladeWater.y + SHORE_MAX_BUILD);
        cap = Math.min(cap, floor);
      }
      return Math.min(out, cap);
    } finally {
      inBlade = false;
    }
  }

  function containWaterEdges(x: number, z: number, out: number): number {
    let target = -Infinity;
    let weight = 0;
    const lipNow = lipAt(x, z);
    for (const lake of bucketAt(lakes, x, z) as readonly LakeDoc[]) {
      // a lake spilling over a fall ends at the lip line: no rim past it
      if (lipNow && lipNow.rel > 0 && lake.waterY >= lipNow.lip!.top - 0.5) continue;
      const sd = lakeDistance(lake, x, z);
      if (sd <= lake.bank * 0.6) return out;
      if (sd >= lake.bank * 1.1) continue;
      // only where the sheet ENDS (0.75 of a bank): nothing inside the
      // water is ever lifted, and the lift is a hand at most
      weight = Math.max(weight, smoothstep(lake.bank * 0.64, lake.bank * 0.74, sd) * (1 - smoothstep(lake.bank * 0.85, lake.bank * 1.1, sd)));
      target = Math.max(target, lake.waterY + 0.3);
    }
    const count = nearestPerOwner(riverSegs, x, z, hits);
    for (let k = 0; k < count; k++) {
      const hit = hits[k]!;
      const river = riverDocs[hit.owner]!;
      const g = riverGeom[hit.owner];
      if (!river.water || Number.isNaN(hit.side) || !g) continue;
      const grow = river.taper > 0 ? smoothstep(0, river.taper, hit.along) : 1;
      if (grow < HEAD_WET) continue;
      // beyond an END only when the end is the nearest point of the river: a
      // plane across the mouth tested on its own also cut away every stretch
      // upstream that the river curled back past
      const total = g.along[g.along.length - 1]!;
      if (g.capEnd && hit.along >= total - 0.05 && (x - g.ex) * g.edx + (z - g.ez) * g.edz > 0) continue;
      if (g.capStart && hit.along <= 0.05 && (x - g.sx) * g.sdx + (z - g.sz) * g.sdz > 0) continue;
      let half = ((Number.isNaN(hit.width) ? river.width : hit.width) / 2) * (0.2 + 0.8 * grow);
      const bank = riverBank(river, hit.width) * (0.35 + 0.65 * grow);
      // in a crafted plunge pool the rim moves out with the water: the pool
      // is a channel whose waterline is the bowl's (sitePoolReach)
      if (siteGorges.length > 0 && hit.distance - half > bank * 0.56) {
        const pool = sitePoolReach(x, z, hit.owner);
        if (pool - bank * RIVER_WATER_REACH > half) half = pool - bank * RIVER_WATER_REACH;
      }
      const inside = hit.distance - half;
      if (inside <= bank * 0.56) return out;
      if (inside >= bank) continue;
      // at a fall the rim holds the level of the side of the lip line it is on
      let level = hit.side;
      if (lipNow && lipNow.lip!.owner === hit.owner && hit.along >= lipNow.lip!.along - 0.5 && hit.along <= lipNow.lip!.along + RIVER_FALL_LIP + 30) {
        level = lipNow.rel < 0 ? lipNow.lip!.top : Math.min(level, lipNow.lip!.bottom);
      }
      weight = Math.max(weight, smoothstep(bank * 0.58, bank * 0.68, inside) * (1 - smoothstep(bank * 0.76, bank, inside)));
      target = Math.max(target, level + 0.3);
    }
    if (weight <= 0 || target <= out) return out;
    return out + (Math.min(target, out + SHORE_MAX_BUILD) - out) * weight;
  }

  function height(x: number, z: number): number {
    return applyFeatures(naturalHeight(x, z), x, z);
  }

  function slopeFromHeights(hx0: number, hx1: number, hz0: number, hz1: number, e: number): number {
    const dx = (hx1 - hx0) / (2 * e);
    const dz = (hz1 - hz0) / (2 * e);
    const g = Math.sqrt(dx * dx + dz * dz);
    return g / Math.sqrt(1 + g * g); // sin(angle): 0 flat, ->1 vertical
  }

  /**
   * Steepness from a mesh vertex's own normal, in the SAME units `slope()`
   * reports: sin(angle), 0 flat, 1 vertical.
   *
   * This used to be `1 - |ny|`, which is 1 - cos(angle) — a different curve
   * entirely, and it under-reported every slope in the world:
   *
   * | angle | 1 - cos | sin  |
   * | ----- | ------- | ---- |
   * | 30°   | 0.13    | 0.50 |
   * | 45°   | 0.29    | 0.71 |
   * | 60°   | 0.50    | 0.87 |
   *
   * Since `cliffStart`/`cliffEnd` and the crag rule's slope window are
   * authored against `slope()`'s units, a 50° cliff face reported 0.36 and
   * never reached a `cliffStart` of 0.55 — so it textured as whatever the
   * biome puts on FLAT ground. Cliffs came out grass and sand, which is
   * exactly what you see, and no amount of tuning the biome weights would
   * have fixed it because the number being compared was the wrong number.
   *
   * For a unit normal, ny = cos(angle), so this is just sin from cos.
   */
  function steepnessFromNormalY(normalY: number): number {
    const ny = Math.min(1, Math.abs(normalY));
    return Math.sqrt(Math.max(0, 1 - ny * ny));
  }

  function slope(x: number, z: number): number {
    const e = Math.max(voxelSize, 0.5);
    return slopeFromHeights(height(x - e, z), height(x + e, z), height(x, z - e), height(x, z + e), e);
  }

  /**
   * Spread a raw 0..1 noise value across the full range.
   *
   * Without this the documented 0..1 semantics are a lie: raw fBm clusters
   * hard around the middle (measured 0.23..0.65 for temperature on a real
   * world), so a biome window written in honest terms — a desert below 0.3
   * moisture, say — never fires anywhere, and the biome silently does not
   * exist. That failure is invisible: nothing errors, the world just quietly
   * has no deserts in it.
   */
  function spread(v: number): number {
    return clamp(0.5 + (v - 0.5) * recipe.climate.contrast, 0, 1);
  }

  /**
   * Reused, never escaping: `climateAt` is called once per mesh VERTEX, and a
   * fresh object per vertex is a garbage-collection pause you will see in the
   * profiler as off-loop time (docs/performance-lessons.md). The one public
   * caller copies it out.
   */
  const climateScratch = { temperature: 0, moisture: 0, heightOffset: 0 };

  /**
   * Climate at a point, with the border raggedness already folded in.
   *
   * With zones, temperature and moisture are the blended anchors' plus a
   * little of the classic noise for drift; without them they are the classic
   * noise alone. Either way `zoneScratch` is left holding this point's zone
   * weights, which `memberships` reads next — that ordering is the contract.
   *
   * The raggedness is the whole reason biome edges read as natural. Two
   * scales do the work: a domain WARP that bends the border on the scale of a
   * hundred metres (so a blighted region reaches a tongue into the meadow
   * instead of ending on a smooth arc), and a fine JITTER on the climate
   * values themselves that dissolves the last few metres into speckle. The
   * jitter is applied AFTER `spread`, so `edge.strength` means what it says in
   * final 0..1 climate units rather than being multiplied by `contrast`.
   *
   * `heightOffset` rides along because height-driven borders — the snowline,
   * the beach — need exactly the same treatment and the noise is already paid
   * for. It reuses the moisture jitter field so it costs nothing extra and is
   * uncorrelated with the temperature that decides the snow.
   */
  function climateAt(x: number, z: number, groundY: number): typeof climateScratch {
    let sx = x;
    let sz = z;
    if (hasEdgeWarp) {
      sx = x + fbm2(edgeWarpA, x, z, seed);
      sz = z + fbm2(edgeWarpB, x + 421.5, z - 733.25, seed);
    }
    let temperature: number;
    let moisture: number;
    if (hasZones) {
      zoneAt(sx, sz); // sx/sz already carry the edge warp: identical to zoneAtWarped(x, z)
      temperature = zoneForm.temperature + fbm2(tempSpec, sx, sz, seed) * ZONE_CLIMATE_DRIFT;
      moisture = zoneForm.moisture + fbm2(moistSpec, sx, sz, seed) * ZONE_CLIMATE_DRIFT;
    } else {
      temperature = spread(fbm2(tempSpec, sx, sz, seed) * 0.5 + 0.5);
      moisture = spread(fbm2(moistSpec, sx, sz, seed) * 0.5 + 0.5);
    }
    let heightOffset = 0;
    if (hasEdgeNoise) {
      const a = fbm2(edgeUnitA, x, z, seed);
      const b = fbm2(edgeUnitB, x, z, seed);
      temperature += a * edge.strength;
      moisture += b * edge.strength;
      heightOffset = b * edge.heightJitter;
    }
    const altitude = Math.max(0, groundY - recipe.seaLevel);
    climateScratch.temperature = clamp(temperature - altitude * recipe.climate.lapseRate, 0, 1);
    climateScratch.moisture = clamp(moisture, 0, 1);
    climateScratch.heightOffset = heightOffset;
    return climateScratch;
  }

  /** Membership of every biome rule at a point. Shared by `biome` and `splatAt`. Reads `zoneScratch`. */
  function memberships(
    groundY: number,
    temperature: number,
    moisture: number,
    steep: number,
    out: Float32Array,
  ): number {
    let total = 0;
    for (let i = 0; i < biomeCount; i++) {
      const rule: BiomeDoc = recipe.biomes[i]!;
      let m = rule.weight;
      const gate = biomeZones[i];
      if (gate) {
        let zw = 0;
        for (let k = 0; k < gate.length; k++) zw += zoneScratch[gate[k]!]!;
        m *= zw;
      }
      if (m > 0 && rule.height) m *= window(groundY, rule.height, rule.heightBlend);
      if (m > 0 && rule.temperature) m *= window(temperature, rule.temperature, rule.blend);
      if (m > 0 && rule.moisture) m *= window(moisture, rule.moisture, rule.blend);
      if (m > 0 && rule.slope) m *= window(steep, rule.slope, rule.blend);
      out[i] = m;
      total += m;
    }
    if (total <= 1e-9) {
      // nothing matched (a gap in the rule set): fall back to the heaviest rule
      // rather than rendering untextured ground, and keep it deterministic
      let bestIndex = 0;
      let best = -Infinity;
      for (let i = 0; i < biomeCount; i++) {
        if (recipe.biomes[i]!.weight > best) {
          best = recipe.biomes[i]!.weight;
          bestIndex = i;
        }
      }
      out.fill(0, 0, biomeCount);
      out[bestIndex] = 1;
      return 1;
    }
    for (let i = 0; i < biomeCount; i++) out[i] = out[i]! / total;
    return total;
  }

  const scratchMembership = new Float32Array(Math.max(biomeCount, 1));

  const blendScratch = new Float32Array(surfaceCount);

  function blendSurface(
    membership: Float32Array,
    steep: number,
    out: Float32Array,
    offset: number,
  ): void {
    blendScratch.fill(0);
    for (let i = 0; i < biomeCount; i++) {
      const m = membership[i]!;
      if (m <= 1e-6) continue;
      const rule = recipe.biomes[i]!;
      const cliffT = smoothstep(rule.cliffStart, rule.cliffEnd, steep);
      const g = groundWeights[i]!;
      const c = cliffWeights[i]!;
      for (let s = 0; s < surfaceCount; s++) {
        blendScratch[s] = blendScratch[s]! + m * (g[s]! + (c[s]! - g[s]!) * cliffT);
      }
    }
    let sum = 0;
    for (let s = 0; s < surfaceCount; s++) sum += blendScratch[s]!;
    const inv = sum > 1e-9 ? 1 / sum : 0;
    for (let s = 0; s < surfaceCount; s++) out[offset + s] = blendScratch[s]! * inv;
    // a point that matched nothing still has to render as SOMETHING
    if (sum <= 1e-9) out[offset] = 1;
  }

  /**
   * Blotches of one surface laid over the biome's answer (recipe.patches).
   *
   * Each patch is a lerp between two already-normalized weight vectors, so the
   * sum stays 1 by construction however many are stacked — no renormalisation
   * pass, and no way for a patch to quietly unbalance the splat.
   *
   * The biome gate is checked BEFORE the noise, which is what makes this
   * affordable: a patch confined to the blight evaluates no noise at all
   * across the other 99% of the world.
   */
  function applyPatches(
    x: number,
    z: number,
    steep: number,
    membership: Float32Array,
    out: Float32Array,
    offset: number,
  ): void {
    for (let p = 0; p < patches.length; p++) {
      const patch = patches[p]!;
      let gate = 1;
      if (patch.biomes.length > 0) {
        gate = 0;
        for (let i = 0; i < patch.biomes.length; i++) gate += membership[patch.biomes[i]!]!;
        if (gate <= 0.02) continue;
        if (gate > 1) gate = 1;
      }
      if (patch.slope) {
        gate *= window(steep, patch.slope, 0.08);
        if (gate <= 0.02) continue;
      }
      const n = fbm2(patch.spec, x, z, seed);
      const mask = smoothstep(patch.threshold, patch.threshold + patch.blend, n) * patch.strength * gate;
      if (mask <= 0.002) continue;
      const target = patch.surface;
      for (let s = 0; s < surfaceCount; s++) {
        const w = out[offset + s]!;
        out[offset + s] = w + ((s === target ? 1 : 0) - w) * mask;
      }
    }
  }

  /**
   * Paint the roadway's own surface over whatever the biome put there.
   *
   * Height and surface are carried by different mechanisms on purpose: a road
   * through a town square should be graded but not painted, and a desert track
   * is painted without being graded at all.
   */
  function paintRoads(x: number, z: number, membership: Float32Array, out: Float32Array, offset: number, flat = 1): void {
    if (flat <= 0) return;
    const near = bucketAt(roadPaint, x, z);
    if (near.length === 0) return;
    // nearest point on the nearest segment, and the verge that segment carries
    let best = Infinity;
    let target = -1;
    let targets: Int16Array | null = null;
    let half = 0;
    let verge = 0;
    for (let i = 0; i < near.length; i++) {
      const s = near[i]!;
      const dx = s.bx - s.ax;
      const dz = s.bz - s.az;
      const lenSq = dx * dx + dz * dz;
      const t = lenSq < 1e-12 ? 0 : clamp(((x - s.ax) * dx + (z - s.az) * dz) / lenSq, 0, 1);
      const px = x - (s.ax + dx * t);
      const pz = z - (s.az + dz * t);
      const d = Math.sqrt(px * px + pz * pz);
      if (d < best) {
        best = d;
        target = s.target;
        targets = s.targets;
        half = s.half;
        verge = s.verge;
      }
    }
    if (target < 0 || best > half + verge + 2) return;
    // ragged verge: without this the dirt ends on a perfect offset curve,
    // which is the single clearest tell that a road was generated
    const d = best + fbm2(vergeSpec, x, z, seed) * Math.min(1.5, verge * 0.6 + 0.4);
    const w = (1 - smoothstep(half - verge * 0.2, half + verge, d)) * flat;
    if (w <= 0.002) return;
    if (targets === null) {
      for (let s = 0; s < surfaceCount; s++) {
        const cur = out[offset + s]!;
        out[offset + s] = cur + ((s === target ? 1 : 0) - cur) * w;
      }
      return;
    }
    // the goal is the base surface, with each biome that overrides it
    // pulling its own share (membership sums to 1) towards its surface
    let base = 1;
    for (let s = 0; s < surfaceCount; s++) roadGoal[s] = 0;
    for (let b = 0; b < biomeCount; b++) {
      const t = targets[b]!;
      const m = membership[b]!;
      if (t < 0 || m <= 0) continue;
      roadGoal[t] = roadGoal[t]! + m;
      base -= m;
    }
    roadGoal[target] = roadGoal[target]! + Math.max(0, base);
    for (let s = 0; s < surfaceCount; s++) {
      const cur = out[offset + s]!;
      out[offset + s] = cur + (roadGoal[s]! - cur) * w;
    }
  }
  /** Scratch for a per-biome path surface; one per field, never per vertex. */
  const roadGoal = new Float32Array(surfaceCount);

  /** Paint a lake's bed and a ragged shore band with its `surface`, the same way a road paints its verge. */
  const lakePaintTargets = lakeDocs.map((l) => (l.surface ? surfaceIndex(l.surface) : -1));
  const hasLakePaint = lakePaintTargets.some((t) => t >= 0);
  function paintLakes(x: number, z: number, out: Float32Array, offset: number, flat = 1): void {
    if (flat <= 0) return;
    const near = bucketAt(lakes, x, z) as readonly LakeDoc[];
    for (let i = 0; i < near.length; i++) {
      const lake = near[i]!;
      const target = lakePaintTargets[lakeDocs.indexOf(lake)]!;
      if (target < 0) continue;
      const sd = lakeDistance(lake, x, z);
      if (sd > lake.shore + 2) continue;
      const d = sd + fbm2(vergeSpec, x, z, seed) * Math.min(2, lake.shore * 0.4 + 0.4);
      const w = (1 - smoothstep(lake.shore * 0.35, lake.shore, d)) * flat;
      if (w <= 0.002) continue;
      for (let s = 0; s < surfaceCount; s++) {
        const cur = out[offset + s]!;
        out[offset + s] = cur + ((s === target ? 1 : 0) - cur) * w;
      }
    }
  }

  // Rock masses an agent built at a crafted site ("add" blobs whose id starts
  // with a fall site's id) are STONE, whatever their slope: a buttress with a
  // gentle top painted grass and dirt read as a dirt mound (judge: "bare
  // dirt"), which is the opposite of what it was built for.
  const siteIds = (recipe.features.fallSites ?? []).map((site) => site.id);
  const siteRockBlobs = recipe.features.blobs.filter((b) => b.op === "add" && siteIds.some((id) => b.id.startsWith(id)));
  // the cliff surface first: Derek prefers the cliff texture along rivers
  // and gorges over the grey rock one
  const siteRockTarget = surfaceIndex("cliff") >= 0 ? surfaceIndex("cliff") : surfaceIndex("rock");
  const siteRocks = makeBuckets(siteRockBlobs, (b) => {
    const r = Math.max(b.radius, b.topRadius ?? b.radius) * Math.max(b.scaleX, b.scaleZ) + b.falloff + 3;
    return [b.center[0] - r, b.center[2] - r, b.center[0] + r, b.center[2] + r];
  });
  const craftedSites = recipe.features.fallSites ?? [];
  function paintSiteRocks(x: number, z: number, steep: number, out: Float32Array, offset: number): void {
    if (siteRockTarget < 0) return;
    let w = 0;
    // and every steep face of a crafted site's gorge is the same stone: the
    // rock masses are small beside a 50 m gorge whose walls are the biome's
    // cliff, and the judge saw only those walls
    for (const site of craftedSites) {
      const d = Math.hypot(x - site.at[0], z - site.at[1]);
      if (d > 100) continue;
      w = Math.max(w, (1 - smoothstep(70, 100, d)) * smoothstep(0.35, 0.6, steep));
    }
    for (const b of bucketAt(siteRocks, x, z) as readonly BlobDoc[]) {
      const d = Math.hypot((x - b.center[0]) / b.scaleX, (z - b.center[2]) / b.scaleZ);
      const r = Math.max(b.radius, b.topRadius ?? b.radius);
      w = Math.max(w, 1 - smoothstep(r * 0.8, r + b.falloff + 1.5, d + fbm2(vergeSpec, x, z, seed) * 1.2));
    }
    if (w <= 0.002) return;
    for (let k = 0; k < surfaceCount; k++) {
      const cur = out[offset + k]!;
      out[offset + k] = cur + ((k === siteRockTarget ? 1 : 0) - cur) * w;
    }
  }

  /** Everything that decorates the biome result, in order. Shared by every splat path. */
  function decorate(
    x: number,
    z: number,
    steep: number,
    membership: Float32Array,
    out: Float32Array,
    offset: number,
  ): void {
    if (hasPatches) applyPatches(x, z, steep, membership, out, offset);
    // Feature paint (lake shores, river beds and banks, road treads) is for
    // GROUND: it fades out between PAINT_STEEP_START and PAINT_STEEP_END so a
    // near-vertical face keeps the biome's cliff rock. It used to paint by
    // plan distance alone, so every fall wall, gorge side and cut bank inside
    // a river's paint band came out gravel or sand (measured on mmo: 69 % of
    // the >55 degree faces near water).
    const flat = 1 - smoothstep(PAINT_STEEP_START, PAINT_STEEP_END, steep);
    if (hasLakePaint) paintLakes(x, z, out, offset, flat);
    // roads last: a track worn through the ground wins over the mottling it
    // was worn through
    if (hasRoadPaint) paintRoads(x, z, membership, out, offset, flat);
    if (siteRockBlobs.length > 0 || craftedSites.length > 0) paintSiteRocks(x, z, steep, out, offset);
  }

  function zoneName(): string {
    if (!hasZones || zoneForm.best < 0) return "";
    return anchors[zoneForm.best]!.id;
  }

  function biome(x: number, z: number, groundY?: number, steepness?: number): BiomeSample {
    const g = groundY ?? height(x, z);
    const steep = steepness ?? slope(x, z);
    const { temperature, moisture, heightOffset } = climateAt(x, z, g);
    const zone = zoneName();
    const weights = new Float32Array(biomeCount);
    memberships(g + heightOffset, temperature, moisture, steep, weights);
    // the strongest LABELLING rule, not the strongest rule: a cover-only rule
    // such as `crag` paints bare rock on steep ground in every biome, and if it
    // were allowed to answer "which biome is this" it would rename every slope
    // in the world — silently switching off every biome-filtered scatter rule
    // exactly where the hills are
    let bestIndex = labelIndices[0]!;
    for (let k = 1; k < labelIndices.length; k++) {
      const i = labelIndices[k]!;
      if (weights[i]! > weights[bestIndex]!) bestIndex = i;
    }
    // ...unless NO labelling rule matched here at all (a gap in the rule set,
    // or ground so steep only the cover rule applies). Reporting the first
    // labelled rule then would be a lie with consequences — "seabed" on a
    // clifftop, and every scatter rule filtered to it firing there. Name the
    // rule that actually won instead.
    if (weights[bestIndex]! <= 1e-6) {
      for (let i = 0; i < biomeCount; i++) if (weights[i]! > weights[bestIndex]!) bestIndex = i;
    }
    const surface = new Float32Array(surfaceCount);
    blendSurface(weights, steep, surface, 0);
    decorate(x, z, steep, weights, surface, 0);
    return { id: recipe.biomes[bestIndex]!.id, zone, weights, surface, temperature, moisture, slope: steep };
  }

  /**
   * The per-vertex path. Uses the vertex's OWN y and normal instead of
   * re-deriving ground height and slope — four extra `height()` calls per
   * vertex would dominate meshing, and on the surface they agree anyway.
   * Overhang undersides then correctly read as cliff, which is what you want.
   */
  function splatAt(x: number, y: number, z: number, normalY: number, out: Float32Array, offset: number): void {
    const steep = steepnessFromNormalY(normalY);
    const { temperature, moisture, heightOffset } = climateAt(x, z, y);
    memberships(y + heightOffset, temperature, moisture, steep, scratchMembership);
    blendSurface(scratchMembership, steep, out, offset);
    decorate(x, z, steep, scratchMembership, out, offset);
  }

  /** Blend the biome tints already resolved into `scratchMembership`. */
  function blendTint(out: Float32Array, offset: number): void {
    let r = 0;
    let g = 0;
    let b = 0;
    let tinted = 0;
    for (let i = 0; i < biomeCount; i++) {
      const m = scratchMembership[i]!;
      if (m <= 1e-6) continue;
      const tint = biomeTints[i];
      // an untinted biome contributes neutral white, so mixing a tinted and an
      // untinted biome fades the tint out rather than darkening the boundary
      r += (tint ? tint[0] : 1) * m;
      g += (tint ? tint[1] : 1) * m;
      b += (tint ? tint[2] : 1) * m;
      tinted += m;
    }
    const inv = tinted > 1e-9 ? 1 / tinted : 1;
    out[offset] = r * inv;
    out[offset + 1] = g * inv;
    out[offset + 2] = b * inv;
  }

  function tintAt(x: number, y: number, z: number, normalY: number, out: Float32Array, offset: number): void {
    const steep = steepnessFromNormalY(normalY);
    const { temperature, moisture, heightOffset } = climateAt(x, z, y);
    memberships(y + heightOffset, temperature, moisture, steep, scratchMembership);
    blendTint(out, offset);
  }

  /**
   * Splat weights AND tint for one vertex from a single biome evaluation.
   *
   * The mesher wants both at every vertex, and computing them separately meant
   * resolving climate noise and every biome rule's membership twice for the
   * same point — pure duplicated work in the second-hottest loop in the
   * system. Callers that only need one still have `splatAt`/`tintAt`.
   */
  function surfaceAt(
    x: number,
    y: number,
    z: number,
    normalY: number,
    out: Float32Array,
    offset: number,
  ): void {
    const steep = steepnessFromNormalY(normalY);
    const { temperature, moisture, heightOffset } = climateAt(x, z, y);
    memberships(y + heightOffset, temperature, moisture, steep, scratchMembership);
    blendSurface(scratchMembership, steep, out, offset);
    decorate(x, z, steep, scratchMembership, out, offset);
    blendTint(out, offset + surfaceCount);
  }

  // --------------------------------------------------------------- density

  function overhangAt(x: number, y: number, z: number, steep: number): number {
    if (t.overhang.strength <= 0) return 0;
    const mask = smoothstep(t.overhang.slopeStart, t.overhang.slopeEnd, steep);
    if (mask <= 0) return 0;
    return fbm3(overhangSpec, x, y, z, seed) * t.overhang.strength * mask;
  }

  // -- caves ---------------------------------------------------------------
  //
  // Cave noise was measured at ~75% of the entire cost of sampling a cell: it
  // is evaluated for every voxel of rock below the surface, which is most of a
  // cell's volume, and almost all of it is solid. Two things fix that without
  // changing what the caves ARE:
  //
  // 1. An early-out. `carve` needs BOTH noise bands under the threshold, so
  //    the first alone rejects the overwhelming majority before the second is
  //    touched.
  // 2. A coarser lattice. Tunnels are tens of metres across, so resolving them
  //    at the voxel step is wasted precision. The raw value is evaluated on a
  //    GLOBAL lattice of `sampleStep` world units and smoothly interpolated
  //    between — global being the load-bearing word, since two chunks must
  //    land on the same lattice points or their caves would not meet.
  //
  // The interpolation is smoothstep-weighted rather than linear on purpose:
  // plain trilinear is only C0, so its gradient jumps at every lattice cell
  // boundary and cave walls come out visibly faceted under gradient normals.

  const caveStep = Math.max(t.caves.sampleStep, 1e-3);

  /** Raw tunnel strength at an exact point; 0 outside a tunnel. */
  function caveNoise(x: number, y: number, z: number): number {
    const a = Math.abs(fbm3(caveA, x, y * 1.6, z, seed));
    if (a >= t.caves.threshold) return 0;
    const b = Math.abs(fbm3(caveB, x, y * 1.6, z, seed));
    const carve = t.caves.threshold - Math.max(a, b);
    return carve > 0 ? carve : 0;
  }

  /** Smooth interpolation of `corner` over the global cave lattice. */
  function caveLerp(
    corner: (gx: number, gy: number, gz: number) => number,
    x: number,
    y: number,
    z: number,
  ): number {
    const fx = x / caveStep;
    const fy = y / caveStep;
    const fz = z / caveStep;
    const gx = Math.floor(fx);
    const gy = Math.floor(fy);
    const gz = Math.floor(fz);
    const tx = smoothstep(0, 1, fx - gx);
    const ty = smoothstep(0, 1, fy - gy);
    const tz = smoothstep(0, 1, fz - gz);
    const c000 = corner(gx, gy, gz);
    const c100 = corner(gx + 1, gy, gz);
    const c010 = corner(gx, gy + 1, gz);
    const c110 = corner(gx + 1, gy + 1, gz);
    const c001 = corner(gx, gy, gz + 1);
    const c101 = corner(gx + 1, gy, gz + 1);
    const c011 = corner(gx, gy + 1, gz + 1);
    const c111 = corner(gx + 1, gy + 1, gz + 1);
    const x00 = c000 + (c100 - c000) * tx;
    const x10 = c010 + (c110 - c010) * tx;
    const x01 = c001 + (c101 - c001) * tx;
    const x11 = c011 + (c111 - c011) * tx;
    const y0 = x00 + (x10 - x00) * ty;
    const y1 = x01 + (x11 - x01) * ty;
    return y0 + (y1 - y0) * tz;
  }

  const caveCornerDirect = (gx: number, gy: number, gz: number): number =>
    caveNoise(gx * caveStep, gy * caveStep, gz * caveStep);

  /**
   * How far below the surface a tunnel must stay, here.
   *
   * Flat ground keeps the full `minDepth`, so no tunnel ever opens a pit in a
   * meadow. Steep ground relaxes it — to a NEGATIVE depth by default, meaning
   * the tunnel is allowed to push out past the surface, which is what actually
   * cuts a mouth rather than leaving a tunnel that merely comes close. The
   * result is that cave systems open onto cliff faces and mountainsides, which
   * is where an entrance both belongs and reads as deliberate.
   */
  function caveMinDepth(steep: number): number {
    const e = t.caves.entrances;
    if (!e.enabled) return t.caves.minDepth;
    const open = smoothstep(e.slopeStart, e.slopeEnd, steep);
    return t.caves.minDepth + (e.minDepth - t.caves.minDepth) * open;
  }

  /** Depth/floor fades: a tunnel must never open a hole in a meadow or a bottomless shaft. */
  function caveShape(carve: number, y: number, groundY: number, minDepth: number): number {
    if (carve <= 0) return -1;
    // the fade band narrows with the depth requirement, so a mouth stays open
    // instead of being faded away exactly where it breaks the surface
    const band = Math.max(1.5, Math.min(6, minDepth));
    const depthFade = smoothstep(0, band, groundY - minDepth - y);
    const floorFade = smoothstep(0, 8, y - t.caves.floorY);
    return carve * 24 * depthFade * floorFade;
  }

  /** Positive inside a tunnel. Air is carved by taking max(density, this). */
  function caveAt(x: number, y: number, z: number, groundY: number, steep: number): number {
    if (!t.caves.enabled) return -1;
    const minDepth = caveMinDepth(steep);
    if (y > groundY - minDepth) return -1;
    if (y < t.caves.floorY) return -1;
    return caveShape(caveLerp(caveCornerDirect, x, y, z), y, groundY, minDepth);
  }

  /**
   * Air carved by cave passages. Positive inside a tunnel.
   *
   * Segments are bucketed by their XZ footprint, so a column with no tunnel
   * near it costs one failed map lookup — which is the whole reason tunnels
   * replaced noise caves as the default. Noise had to be evaluated for every
   * voxel of rock in the world on the chance a passage ran through it.
   */
  function tunnelAt(x: number, y: number, z: number): number {
    let best = -1;
    for (const seg of bucketAt(tunnelSegments, x, z) as readonly TunnelSegment[]) {
      const dx = seg.bx - seg.ax;
      const dy = seg.by - seg.ay;
      const dz = seg.bz - seg.az;
      const lenSq = dx * dx + dy * dy + dz * dz;
      const t =
        lenSq < 1e-9
          ? 0
          : clamp(((x - seg.ax) * dx + (y - seg.ay) * dy + (z - seg.az) * dz) / lenSq, 0, 1);
      const px = seg.ax + dx * t;
      const py = seg.ay + dy * t;
      const pz = seg.az + dz * t;
      const dist = Math.sqrt((x - px) ** 2 + (y - py) ** 2 + (z - pz) ** 2);
      const radius = seg.ra + (seg.rb - seg.ra) * t;
      const air = radius - dist;
      if (air > best) best = air;
    }
    return best;
  }

  function blobsAt(x: number, y: number, z: number, d: number): number {
    let out = d;
    for (const blob of bucketAt(blobs, x, z) as readonly BlobDoc[]) {
      const dx = (x - blob.center[0]) / blob.scaleX;
      const dz = (z - blob.center[2]) / blob.scaleZ;
      // a `height` above 0 turns the sphere into a vertical capsule: clamp the
      // query onto the axis segment and the sphere distance does the rest.
      // This is what a monolith is — one blob, not a stack of them.
      const ay = blob.height > 0 ? clamp(y, blob.center[1], blob.center[1] + blob.height) : blob.center[1];
      const dy = y - ay;
      const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
      // taper along the axis: radius at the clamped point, not at the query,
      // so the rounded cap keeps the radius the shaft ended on
      const radius =
        blob.topRadius === undefined || blob.height <= 0
          ? blob.radius
          : blob.radius + (blob.topRadius - blob.radius) * ((ay - blob.center[1]) / blob.height);
      const sdf = dist - radius;
      if (sdf > blob.falloff) continue;
      if (blob.op === "add") out = Math.min(out, sdf);
      else out = Math.max(out, -sdf);
    }
    return out;
  }

  /**
   * Density given a column's already-resolved ground height and steepness.
   *
   * Splitting this out is what makes a vertical query affordable: `height` and
   * `slope` are constant down a column, but `slope` alone is four ~20-octave
   * `height` evaluations, so re-deriving them per sample made a single
   * `surfaceCast` cost roughly a hundred of them.
   */
  function densityAt(x: number, y: number, z: number, h: number, steep: number): number {
    if (y <= recipe.minY) return -1;
    if (y >= recipe.maxY) return 1;
    let d = y - h;
    if (t.overhang.strength > 0 && Math.abs(d) < overhangReach) d += overhangAt(x, y, z, steep);
    const cave = caveAt(x, y, z, h, steep);
    if (cave > 0) d = Math.max(d, cave);
    if (hasTunnels) {
      const tunnel = tunnelAt(x, y, z);
      if (tunnel > 0) d = Math.max(d, tunnel);
    }
    if (hasBlobs) d = blobsAt(x, y, z, d);
    // hard floor last so nothing — not caves, not blobs — can open the world's underside
    if (y < recipe.minY + 2) d = Math.min(d, y - (recipe.minY + 2));
    return d;
  }

  function density(x: number, y: number, z: number): number {
    return densityAt(x, y, z, height(x, z), t.overhang.strength > 0 ? slope(x, z) : 0);
  }

  /**
   * The mesher's bulk path. Column height/slope are evaluated ONCE per (x, z)
   * and reused down the whole column, and the expensive 3D bands are skipped
   * outside the band where they can possibly matter. On a 27x27 lattice that
   * is ~700 height evaluations instead of ~40,000.
   */
  function sampleBlock(request: SampleBlockRequest): Float32Array {
    const { origin, nx, ny, nz, step } = request;
    const values = new Float32Array(nx * ny * nz);
    const columns = nx * nz;
    const columnHeight = new Float32Array(columns);
    const columnSlope = new Float32Array(columns);
    // cave MOUTHS are slope-driven too, so the column slope is needed whenever
    // either feature is on — not just for overhangs
    const needColumnSlope = t.overhang.strength > 0 || (t.caves.enabled && t.caves.entrances.enabled);

    // Heights on a lattice ONE RING WIDER than the block, so slope can come
    // from central differences over neighbours we already paid for instead of
    // four fresh `height()` calls per column — and `height()` is ~20 octaves
    // of noise, so that is a 5x cut in the dominant cost of meshing a cell.
    //
    // The extra ring is not just an optimisation detail: taking the difference
    // against a CLAMPED edge neighbour instead of the true one would make two
    // neighbouring chunks compute different slopes for the same shared column,
    // hence different overhang masks, hence a visible seam. The ring buys the
    // true neighbour everywhere the block needs one.
    const ex = nx + 2;
    const ez = nz + 2;
    const extended = new Float32Array(ex * ez);
    for (let k = 0; k < ez; k++) {
      const wz = origin[2] + (k - 1) * step;
      for (let i = 0; i < ex; i++) {
        extended[i + k * ex] = height(origin[0] + (i - 1) * step, wz);
      }
    }
    const inv2Step = 1 / (2 * step);
    for (let k = 0; k < nz; k++) {
      const ek = k + 1;
      for (let i = 0; i < nx; i++) {
        const ei = i + 1;
        const c = i + k * nx;
        columnHeight[c] = extended[ei + ek * ex]!;
        if (needColumnSlope) {
          const dx = (extended[ei + 1 + ek * ex]! - extended[ei - 1 + ek * ex]!) * inv2Step;
          const dz = (extended[ei + (ek + 1) * ex]! - extended[ei + (ek - 1) * ex]!) * inv2Step;
          const g = Math.sqrt(dx * dx + dz * dz);
          columnSlope[c] = g / Math.sqrt(1 + g * g);
        }
      }
    }

    // Precompute the cave lattice covering only the band any column can
    // actually use. Same global lattice and same interpolation as `caveAt`, so
    // a point query and the mesher agree exactly — they must, or a prop
    // dropped by the placement solver sinks into a cave the mesh doesn't have.
    let caveCorner: ((gx: number, gy: number, gz: number) => number) | null = null;
    if (t.caves.enabled) {
      let maxHeight = -Infinity;
      for (let c = 0; c < columns; c++) if (columnHeight[c]! > maxHeight) maxHeight = columnHeight[c]!;
      const bandTop = Math.min(origin[1] + (ny - 1) * step, maxHeight - t.caves.minDepth);
      const bandBottom = Math.max(origin[1], t.caves.floorY);
      if (bandTop > bandBottom) {
        const gx0 = Math.floor(origin[0] / caveStep);
        const gy0 = Math.floor(bandBottom / caveStep);
        const gz0 = Math.floor(origin[2] / caveStep);
        const gnx = Math.floor((origin[0] + (nx - 1) * step) / caveStep) - gx0 + 2;
        const gny = Math.floor(bandTop / caveStep) - gy0 + 2;
        const gnz = Math.floor((origin[2] + (nz - 1) * step) / caveStep) - gz0 + 2;
        const grid = new Float32Array(gnx * gny * gnz);
        for (let gz = 0; gz < gnz; gz++) {
          for (let gy = 0; gy < gny; gy++) {
            for (let gx = 0; gx < gnx; gx++) {
              grid[gx + gy * gnx + gz * gnx * gny] = caveNoise(
                (gx0 + gx) * caveStep,
                (gy0 + gy) * caveStep,
                (gz0 + gz) * caveStep,
              );
            }
          }
        }
        caveCorner = (gx, gy, gz): number => {
          const ix = gx - gx0;
          const iy = gy - gy0;
          const iz = gz - gz0;
          // outside the precomputed band there is, by construction, no cave
          if (ix < 0 || iy < 0 || iz < 0 || ix >= gnx || iy >= gny || iz >= gnz) return 0;
          return grid[ix + iy * gnx + iz * gnx * gny]!;
        };
      }
    }

    const strideZ = nx * ny;
    for (let k = 0; k < nz; k++) {
      const wz = origin[2] + k * step;
      for (let i = 0; i < nx; i++) {
        const wx = origin[0] + i * step;
        const c = i + k * nx;
        const h = columnHeight[c]!;
        const steep = columnSlope[c]!;
        const overhangMask =
          t.overhang.strength > 0 ? smoothstep(t.overhang.slopeStart, t.overhang.slopeEnd, steep) : 0;
        const caveMin = caveMinDepth(steep);
        const caveTop = h - caveMin;
        for (let j = 0; j < ny; j++) {
          const wy = origin[1] + j * step;
          let d: number;
          if (wy <= recipe.minY) d = -1;
          else if (wy >= recipe.maxY) d = 1;
          else {
            d = wy - h;
            if (overhangMask > 0 && Math.abs(d) < overhangReach) {
              d += fbm3(overhangSpec, wx, wy, wz, seed) * t.overhang.strength * overhangMask;
            }
            if (caveCorner && wy < caveTop && wy > t.caves.floorY) {
              const cave = caveShape(caveLerp(caveCorner, wx, wy, wz), wy, h, caveMin);
              if (cave > 0) d = Math.max(d, cave);
            }
            if (hasTunnels) {
              const tunnel = tunnelAt(wx, wy, wz);
              if (tunnel > 0) d = Math.max(d, tunnel);
            }
            if (hasBlobs) d = blobsAt(wx, wy, wz, d);
            if (wy < recipe.minY + 2) d = Math.min(d, wy - (recipe.minY + 2));
          }
          values[i + j * nx + k * strideZ] = d;
        }
      }
    }
    return values;
  }

  function heightRange(x0: number, z0: number, x1: number, z1: number, samples = 9): { min: number; max: number } {
    let min = Infinity;
    let max = -Infinity;
    const n = Math.max(2, samples);
    for (let k = 0; k < n; k++) {
      const z = z0 + ((z1 - z0) * k) / (n - 1);
      for (let i = 0; i < n; i++) {
        const x = x0 + ((x1 - x0) * i) / (n - 1);
        const h = height(x, z);
        if (h < min) min = h;
        if (h > max) max = h;
      }
    }
    // Additive blobs stand ABOVE the heightfield, and this range is what the
    // mesher turns into the vertical band it polygonizes. Miss them and a
    // 30 m monolith is flat-capped at the terrain's own headroom — it renders
    // as a mesa with a hole in the top, because the band ends mid-rock.
    if (hasBlobs) {
      for (const blob of recipe.features.blobs) {
        if (blob.op !== "add") continue;
        const reach = blobReach(blob);
        const rx = reach * blob.scaleX + blob.falloff;
        const rz = reach * blob.scaleZ + blob.falloff;
        if (blob.center[0] + rx < x0 || blob.center[0] - rx > x1) continue;
        if (blob.center[2] + rz < z0 || blob.center[2] - rz > z1) continue;
        const top = blob.center[1] + blob.height + reach + blob.falloff;
        const bottom = blob.center[1] - blob.radius - blob.falloff;
        if (top > max) max = top;
        if (bottom < min) min = bottom;
      }
    }
    return { min, max };
  }

  function surfaceCast(x: number, z: number, fromY?: number, toY?: number): number | null {
    const h = height(x, z);
    // A pure heightfield column has its answer already — no reason to march it
    if (t.overhang.strength <= 0 && fromY === undefined && toY === undefined) return h;
    const steep = t.overhang.strength > 0 ? slope(x, z) : 0;
    const top = fromY ?? h + t.overhang.strength * 1.5 + 2;
    const bottom = toY ?? h - t.overhang.strength * 1.5 - 2;
    const step = Math.max(voxelSize * 0.5, 0.25);
    let prevY = top;
    let prev = densityAt(x, top, z, h, steep);
    if (prev < 0) return top; // already inside rock at the top of the search
    for (let y = top - step; y >= bottom; y -= step) {
      const d = densityAt(x, y, z, h, steep);
      if (d < 0) {
        const tt = prev / (prev - d); // linear crossing between prevY and y
        return prevY + (y - prevY) * tt;
      }
      prevY = y;
      prev = d;
    }
    return null;
  }

  function featureClearance(x: number, z: number): number {
    let best = Infinity;
    let count = nearestPerOwner(riverSegs, x, z, hits);
    // from the bank's foot, not the bed's edge: a tree on the bank slope reads
    // as a tree cut into the river
    for (let k = 0; k < count; k++) {
      const river = riverDocs[hits[k]!.owner]!;
      const width = Number.isNaN(hits[k]!.width) ? river.width : hits[k]!.width;
      best = Math.min(best, hits[k]!.distance - (width / 2 + riverBank(river, hits[k]!.width) * 0.5));
    }
    count = nearestPerOwner(canyonSegs, x, z, hits);
    for (let k = 0; k < count; k++) best = Math.min(best, hits[k]!.distance - canyonDocs[hits[k]!.owner]!.width / 2);
    // a ridge crest is a knife-edge like a canyon rim: nothing stands on it
    count = nearestPerOwner(ridgeSegs, x, z, hits);
    for (let k = 0; k < count; k++) best = Math.min(best, hits[k]!.distance - ridgeDocs[hits[k]!.owner]!.width / 2);
    // from the SHOULDER's edge, not the roadway's: the shoulder is regraded
    // flat and painted, so it reads as the path — a mushroom a metre off
    // the tread of a footpath is a mushroom on the path
    count = nearestPerOwner(roadClearSegs, x, z, hits);
    for (let k = 0; k < count; k++) {
      const road = roadDocs[hits[k]!.owner]!;
      best = Math.min(best, hits[k]!.distance - (road.width / 2 + road.shoulder));
    }
    for (const lake of bucketAt(lakes, x, z) as readonly LakeDoc[]) best = Math.min(best, lakeDistance(lake, x, z));
    // Additive blobs stand ABOVE the heightfield, and scatter stands props on
    // the heightfield — so without this a monolith gets a ring of boulders and
    // shrubs buried inside it, and any prop under it is entombed.
    for (const blob of bucketAt(blobs, x, z) as readonly BlobDoc[]) {
      if (blob.op !== "add") continue;
      const reach = blobReach(blob) * Math.max(blob.scaleX, blob.scaleZ) + blob.falloff;
      best = Math.min(best, Math.sqrt((x - blob.center[0]) ** 2 + (z - blob.center[2]) ** 2) - reach);
    }
    for (const town of bucketAt(towns, x, z) as readonly TownDoc[]) {
      if (town.excludeScatter === false) continue;
      best = Math.min(best, Math.sqrt((x - town.center[0]) ** 2 + (z - town.center[1]) ** 2) - town.radius);
      // a shelf cut below the pad's edge is still the town's ground, and a
      // tree standing on it is a tree in the street
      for (const terrace of town.terraces) best = Math.min(best, distanceToPolyline(terrace.points, x, z) - terrace.radius);
    }
    return best;
  }

  /** Surface height of a river's water over its bed: most of the LOCAL channel depth, never above the banks. */
  function riverSurface(river: RiverDoc, bed: number, surface: number): number {
    return Number.isNaN(surface) ? bed + Math.max(0.4, river.depth * 0.7) : surface;
  }

  /** The highest river water surface over (x, z), or null when no wet channel reaches it. */
  function riverWaterY(x: number, z: number): number | null {
    let best: number | null = null;
    const count = nearestPerOwner(riverSegs, x, z, hits);
    for (let k = 0; k < count; k++) {
      const hit = hits[k]!;
      const river = riverDocs[hit.owner]!;
      if (!river.water) continue; // a dry gully: carved, no sheet
      const grow = river.taper > 0 ? smoothstep(0, river.taper, hit.along) : 1;
      const width = Number.isNaN(hit.width) ? river.width : hit.width;
      // out to the waterline, not just the flat bed: the bank profile crosses
      // the surface about two thirds of the way out (the ribbon uses the same rule)
      let reach = (width / 2) * (0.2 + 0.8 * grow) + riverBank(river, hit.width) * (0.35 + 0.65 * grow) * RIVER_WATER_REACH;
      if (siteGorges.length > 0 && hit.distance > reach) {
        const pool = sitePoolReach(x, z, hit.owner);
        if (pool > reach) reach = pool;
      }
      if (Number.isNaN(hit.value) || hit.distance > reach || grow < HEAD_WET) continue;
      const y = riverSurface(river, hit.value, hit.side);
      if (best === null || y > best) best = y;
    }
    return best;
  }

  function waterY(x: number, z: number): number | null {
    let best: number | null = null;
    for (const lake of bucketAt(lakes, x, z) as readonly LakeDoc[]) {
      // half a bank beyond the outline too: the outline is traced on the
      // hydrology grid and the water sheet is drawn that much wider (chunk.ts),
      // so ground under the surface just outside the polygon counts as wet.
      // Callers compare the ground against this, which is what makes it right
      // on the dry part of the same band.
      if (lakeDistance(lake, x, z) <= lake.bank * 0.75 && (best === null || lake.waterY > best)) best = lake.waterY;
    }
    const river = riverWaterY(x, z);
    if (river !== null && (best === null || river > best)) best = river;
    if (best === null && height(x, z) < recipe.seaLevel) best = recipe.seaLevel;
    return best;
  }

  /**
   * Beds for the rivers written BY HAND. An agent (or a person) adds a
   * river to the recipe as points and a width and nothing else — the way a
   * river is drawn, not the way one is solved — and the field makes it
   * valid here, when it is created, so the world answers to the edit live
   * with no generator run in between. The rules are the ones `worldgen
   * rivers` applies to a drawn path:
   *
   *   - the bed is the ground the river crosses (canyons, fills, lakes and
   *     every river already solved applied; towns and roads NOT — a river
   *     cuts a road, the road does not lift the river) less the local depth;
   *   - from the first point under a lake onward it is capped at that
   *     lake's flush level: water leaving a lake cannot stand above it, and
   *     inside the lake the bed is held AT that level, not dropped to the
   *     lake floor;
   *   - running MIN from the head: a drawn river is a decision, it cuts
   *     through a ridge in its way rather than climbing it (the field builds
   *     the floor up through hollows, bounded by RIVER_MAX_BUILD);
   *   - the mouth is a hair under the sea where the ground there is below
   *     sea level, or flush with the surface of the river it ends on (rivers
   *     are solved in list order, so a tributary listed after its trunk
   *     finds the trunk).
   *
   * Beds only descend, by construction. A doc that already carries a
   * `bedY` of the right length is left exactly as written.
   */
  function solveRiverBeds(): void {
    const hasBed = (r: RiverDoc): boolean => !!r.bedY && r.bedY.length === r.points.length;
    if (riverDocs.every(hasBed)) return;
    // a hand-written river is a few dozen points; the carve is straight
    // between them, so it is resampled along a centripetal Catmull-Rom
    // spline first (the curve the water ribbon draws through the same
    // points), a few metres apart, per-point widths and depths riding along
    const solved: RiverDoc[] = riverDocs.map((r) => (hasBed(r) ? r : splineRiver(r)));
    riverDocs = solved.filter(hasBed);
    riverSegs = buildRiverSegs(riverDocs);
    waterStageOnly = true;
    const SURFACE = 0.7;
    for (let index = 0; index < solved.length; index++) {
      const river = solved[index]!;
      if (hasBed(river)) continue;
      const n = river.points.length;
      const depthAt = (i: number): number => (river.depths && river.depths.length === n ? river.depths[i]! : river.depth);
      const target: number[] = [];
      /** The lake flush level at each point under or beside a lake, NaN elsewhere. */
      const flushAt: number[] = [];
      let cap = Infinity;
      for (let i = 0; i < n; i++) {
        const [x, z] = river.points[i]!;
        const d = depthAt(i);
        let lakeY: number | null = null;
        for (const lake of bucketAt(lakes, x, z) as readonly LakeDoc[]) {
          if (lakeDistance(lake, x, z) <= lake.bank && (lakeY === null || lake.waterY > lakeY)) lakeY = lake.waterY;
        }
        const ground = height(x, z);
        // under the sea the bed sits a hair under the ocean plane, however
        // deep the seabed is there: a point placed offshore is where the
        // ribbon slips beneath the surface, not a reason to cut the whole
        // river down to a seabed twenty metres under
        let t = ground < recipe.seaLevel ? recipe.seaLevel - SURFACE * d - 0.3 : ground - d;
        let flush = NaN;
        if (lakeY !== null) {
          flush = lakeY - SURFACE * d - 0.15;
          cap = Math.min(cap, flush);
          t = Math.max(t, flush);
        }
        // on a river already solved (a confluence, or a reach shared with
        // the trunk) the bed is flush with THAT surface, not a channel depth
        // under the trunk's bottom: a tributary arrives at its river's level
        const parentSurface = riverWaterY(x, z);
        if (parentSurface !== null) t = Math.max(t, parentSurface - SURFACE * d - 0.15);
        flushAt.push(flush);
        target.push(Math.min(t, cap));
      }
      const last = n - 1;
      const [mx, mz] = river.points[last]!;
      let mouthBed = target[last]!;
      if (height(mx, mz) < recipe.seaLevel) {
        mouthBed = recipe.seaLevel - SURFACE * depthAt(last) - 0.3;
      } else {
        const parentSurface = riverWaterY(mx, mz);
        if (parentSurface !== null) mouthBed = parentSurface - SURFACE * depthAt(last) - 0.15;
      }
      const bed = new Array<number>(n);
      bed[0] = target[0]!;
      for (let i = 1; i <= last; i++) bed[i] = Math.min(target[i]!, bed[i - 1]!);
      bed[last] = Math.min(bed[last]!, mouthBed);
      for (let i = last - 1; i >= 0; i--) bed[i] = Math.max(bed[i]!, bed[i + 1]!);
      // the grade limit, mouth up: wherever the bed would drop faster than
      // `maxGrade` the reach ABOVE is cut down to it — a scarp becomes a
      // gorge, not a slide. Never under a lake: an outlet stays flush with
      // its lake and cascades from the shore.
      if (river.maxGrade > 0) {
        for (let i = last - 1; i >= 0; i--) {
          const a = river.points[i]!;
          const b = river.points[i + 1]!;
          const limit = bed[i + 1]! + river.maxGrade * Math.hypot(b[0] - a[0], b[1] - a[1]);
          if (bed[i]! > limit) bed[i] = Number.isNaN(flushAt[i]!) ? limit : Math.max(limit, flushAt[i]!);
        }
      }
      solved[index] = { ...river, bedY: bed.map((v) => Math.round(v * 100) / 100) };
      riverDocs = solved.filter(hasBed);
      riverSegs = buildRiverSegs(riverDocs);
    }
    waterStageOnly = false;
    riverDocs = solved;
    riverSegs = buildRiverSegs(riverDocs);
  }

  /** The doc with its points resampled along a centripetal Catmull-Rom spline through them. */
  function splineRiver(river: RiverDoc, spacing = Math.max(6, river.width * 0.5)): RiverDoc {
    const pts = river.points;
    const n = pts.length;
    if (n < 3) return river;
    const widths = river.widths && river.widths.length === n ? river.widths : null;
    const depths = river.depths && river.depths.length === n ? river.depths : null;
    const beds = river.bedY && river.bedY.length === n ? river.bedY : null;
    const outPts: [number, number][] = [];
    const outW: number[] = [];
    const outD: number[] = [];
    const outB: number[] = [];
    const at = (i: number): readonly [number, number] => pts[Math.max(0, Math.min(n - 1, i))]!;
    const lerp = (arr: readonly number[], i: number, t: number): number => arr[i]! + (arr[Math.min(n - 1, i + 1)]! - arr[i]!) * t;
    for (let i = 0; i + 1 < n; i++) {
      const p0 = at(i - 1);
      const p1 = at(i);
      const p2 = at(i + 1);
      const p3 = at(i + 2);
      // centripetal knots: no cusps or loops however uneven the spacing
      const knot = (a: readonly [number, number], b: readonly [number, number]): number => Math.sqrt(Math.hypot(b[0] - a[0], b[1] - a[1]));
      const t0 = 0;
      const t1 = t0 + knot(p0, p1);
      const t2 = t1 + knot(p1, p2);
      const t3 = t2 + knot(p2, p3);
      const steps = Math.max(1, Math.ceil(Math.hypot(p2[0] - p1[0], p2[1] - p1[1]) / spacing));
      for (let s = 0; s < steps; s++) {
        const u = s / steps;
        const t = t1 + (t2 - t1) * u;
        const point: [number, number] = [0, 0];
        for (let axis = 0; axis < 2; axis++) {
          const a1 = t1 - t0 > 1e-9 ? ((t1 - t) / (t1 - t0)) * p0[axis]! + ((t - t0) / (t1 - t0)) * p1[axis]! : p1[axis]!;
          const a2 = t2 - t1 > 1e-9 ? ((t2 - t) / (t2 - t1)) * p1[axis]! + ((t - t1) / (t2 - t1)) * p2[axis]! : p1[axis]!;
          const a3 = t3 - t2 > 1e-9 ? ((t3 - t) / (t3 - t2)) * p2[axis]! + ((t - t2) / (t3 - t2)) * p3[axis]! : p2[axis]!;
          const b1 = t2 - t0 > 1e-9 ? ((t2 - t) / (t2 - t0)) * a1 + ((t - t0) / (t2 - t0)) * a2 : a1;
          const b2 = t3 - t1 > 1e-9 ? ((t3 - t) / (t3 - t1)) * a2 + ((t - t1) / (t3 - t1)) * a3 : a2;
          point[axis] = t2 - t1 > 1e-9 ? ((t2 - t) / (t2 - t1)) * b1 + ((t - t1) / (t2 - t1)) * b2 : b1;
        }
        outPts.push([Math.round(point[0] * 100) / 100, Math.round(point[1] * 100) / 100]);
        if (widths) outW.push(lerp(widths, i, u));
        if (depths) outD.push(lerp(depths, i, u));
        // linear, not splined: a bed that only descends must stay that way
        if (beds) outB.push(lerp(beds, i, u));
      }
    }
    outPts.push([pts[n - 1]![0], pts[n - 1]![1]]);
    if (widths) outW.push(widths[n - 1]!);
    if (depths) outD.push(depths[n - 1]!);
    if (beds) outB.push(beds[n - 1]!);
    return {
      ...river,
      points: outPts,
      ...(widths ? { widths: outW } : {}),
      ...(depths ? { depths: outD } : {}),
      ...(beds ? { bedY: outB } : {}),
    };
  }

  /** A two-point river with its midpoint added, so the spline has something to resample. */
  function withMidpoint(river: RiverDoc): RiverDoc {
    if (river.points.length !== 2) return river;
    const a = river.points[0]!;
    const b = river.points[1]!;
    const mid = <T extends readonly number[] | undefined>(arr: T): number[] | undefined =>
      arr && arr.length === 2 ? [arr[0]!, (arr[0]! + arr[1]!) / 2, arr[1]!] : undefined;
    const widths = mid(river.widths);
    const depths = mid(river.depths);
    const bedY = mid(river.bedY);
    return {
      ...river,
      points: [[a[0], a[1]], [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2], [b[0], b[1]]],
      ...(widths ? { widths } : {}),
      ...(depths ? { depths } : {}),
      ...(bedY ? { bedY } : {}),
    };
  }

  // ------------------------------------------------------------------ pools
  /** Per river (index into riverDocs): cumulative length at each point, and both ends with their outward directions. */
  let riverFalls: RiverFall[] = [];
  /** Agent-crafted fall sites as solved (fall-sites.ts): the pools their ledges hold up. */
  let solvedSites: SolvedFallSite[] = [];
  /** Every crafted cascade's site-scale gorge (siteGorgeAt), built once the lips are known. */
  let siteGorges: SiteGorge[] = [];
  interface SiteGorgeTier {
    lx: number;
    lz: number;
    dx: number;
    dz: number;
    /** Length of the lip segment (the drop happens over it). */
    len: number;
    top: number;
    bottom: number;
    half: number;
    /** Widest half-width of this tier's pool bowl: its waterline, where the carved ground comes back up to the pool. */
    bowlHalf: number;
    /** Metres from this lip to the next one (the last: to the end of its bowl). */
    poolLen: number;
  }
  interface SiteGorge {
    /** The river (index into riverDocs) the site's lips are on: its water fills the bowls. */
    owner: number;
    minX: number;
    minZ: number;
    maxX: number;
    maxZ: number;
    /** The river's centreline through the site, with arc length. */
    px: Float64Array;
    pz: Float64Array;
    ps: Float64Array;
    tiers: SiteGorgeTier[];
    cfg: ReturnType<typeof fallSiteGorge>;
    seed: number;
  }
  /** Rise over run of a tier's headwall face (the curved cliff the fall pours off). */
  const SITE_HEADWALL_RISE = 3;
  /** Width (m) of the bowl's apron: from the waterline at the bowl edge up to the rim. */
  const SITE_BOWL_APRON = 2.5;
  /** Over how many metres (at the site's reach and past its last bowl) the shape eases out to the land. */
  const SITE_GORGE_FADE = 15;

  /**
   * The site-scale shape of each crafted cascade, from its solved tiers: the
   * lip lines on the river the site's path runs down, the channel width at
   * each, and the river's centreline through the span.
   */
  function buildSiteGorges(): SiteGorge[] {
    const out: SiteGorge[] = [];
    for (const site of solvedSites) {
      const doc = (recipe.features.fallSites ?? []).find((s) => s.id === site.id);
      if (!doc || doc.template !== "cascade") continue;
      const cfg = fallSiteGorge(doc);
      if (!cfg.enabled || site.path.length < 2) continue;
      const topLevel = site.path[0]!.level;
      const lowLevel = site.path[site.path.length - 1]!.level;
      const pathPts = site.path.map((p) => [p.x, p.z] as [number, number]);
      const lips = lipList.filter((lip) => lip.top <= topLevel + 0.5 && lip.bottom >= lowLevel - 0.5 && distanceToPolyline(pathPts, lip.lx, lip.lz) <= 8);
      if (lips.length === 0) continue;
      // the river the site's lips are on: the owner of most of them
      const tally = new Map<number, number>();
      for (const lip of lips) tally.set(lip.owner, (tally.get(lip.owner) ?? 0) + 1);
      const owner = [...tally.entries()].sort((a, b) => b[1] - a[1])[0]![0];
      const own = lips.filter((lip) => lip.owner === owner).sort((a, b) => a.along - b.along);
      const d = riverDocs[owner]!;
      const along = riverGeom[owner]!.along;
      const tiers: SiteGorgeTier[] = own.map((lip, i) => {
        let k = 0;
        while (k < along.length - 1 && along[k]! < lip.along - 1e-6) k++;
        const len = k + 1 < along.length ? along[k + 1]! - along[k]! : RIVER_FALL_LIP;
        const bank = (lip.reach - lip.half) / 2.5;
        const next = own[i + 1];
        return {
          lx: lip.lx,
          lz: lip.lz,
          dx: lip.dx,
          dz: lip.dz,
          len,
          top: lip.top,
          bottom: lip.bottom,
          half: lip.half,
          // the channel with its bed widened `bowl` times: the bed out to
          // bowl x half, then the channel's own bank reach to the waterline
          // (bowl 1 is exactly the channel's water). The river's water follows
          // the bowl out (sitePoolReach), so the pool fills it; bounded so the
          // water, the apron and the containWater ring past it stay inside the
          // river's segment index (half + 3 banks) and the lip's reach
          bowlHalf: Math.max(lip.half, Math.min(cfg.bowl * lip.half + bank * RIVER_WATER_REACH, lip.half + bank * 2 - SITE_BOWL_APRON)),
          poolLen: next ? next.along - lip.along : len + FALL_NARROW + 1 + cfg.lastPool,
        };
      });
      const last = tiers[tiers.length - 1]!;
      const a0 = own[0]!.along - 20;
      const a1 = own[own.length - 1]!.along + last.poolLen + 2 * SITE_GORGE_FADE + 10;
      const xs: number[] = [];
      const zs: number[] = [];
      const ss: number[] = [];
      for (let k = 0; k < d.points.length; k++) {
        const inRange = along[k]! >= a0 && along[k]! <= a1;
        const edge = (k + 1 < d.points.length && along[k + 1]! >= a0 && along[k]! < a0) || (k > 0 && along[k - 1]! <= a1 && along[k]! > a1);
        if (!inRange && !edge) continue;
        xs.push(d.points[k]![0]);
        zs.push(d.points[k]![1]);
        ss.push(along[k]!);
      }
      if (xs.length < 2) continue;
      let minX = Infinity;
      let minZ = Infinity;
      let maxX = -Infinity;
      let maxZ = -Infinity;
      for (let k = 0; k < xs.length; k++) {
        minX = Math.min(minX, xs[k]! - cfg.reach);
        maxX = Math.max(maxX, xs[k]! + cfg.reach);
        minZ = Math.min(minZ, zs[k]! - cfg.reach);
        maxZ = Math.max(maxZ, zs[k]! + cfg.reach);
      }
      let seedHash = seed | 0;
      for (let i = 0; i < site.id.length; i++) seedHash = Math.imul(seedHash ^ site.id.charCodeAt(i), 0x01000193);
      out.push({ owner, minX, minZ, maxX, maxZ, px: Float64Array.from(xs), pz: Float64Array.from(zs), ps: Float64Array.from(ss), tiers, cfg, seed: seedHash });
    }
    return out;
  }

  /**
   * How open tier `t`'s bowl is at `rel` metres past its lip line, 0..1: 0
   * at both necks (the water held to the channel at every lip, FALL_NARROW),
   * 1 at the widest, a third of the way down. The ONE bowl shape: the carve
   * (siteGorgeAt) and the pool's water (sitePoolReach) both read it. The far
   * neck is measured from the NEXT lip's own line, not as poolLen down this
   * one's: on a bend the two lines are not parallel, and a bowl measured
   * from this lip alone stood open (and full) right up the next lip line
   * beside the channel, widening that fall's curtain.
   */
  function siteBowlShape(g: SiteGorge, t: number, rel: number, x: number, z: number): number {
    const tier = g.tiers[t]!;
    const u0 = tier.len + FALL_NARROW + 1;
    const next = g.tiers[t + 1];
    let p: number;
    if (next) {
      // between the two lines: metres past this one's neck over the span
      // to the next one's (on a straight channel exactly rel over the pool)
      const fromTop = rel - u0;
      const toNext = -((x - next.lx) * next.dx + (z - next.lz) * next.dz) - FALL_NARROW - 1;
      p = fromTop > 0 && toNext > 0 ? fromTop / (fromTop + toNext) : -1;
    } else p = tier.poolLen > u0 ? (rel - u0) / (tier.poolLen - u0) : -1;
    return p > 0 && p < 1 ? Math.sin(Math.PI * Math.pow(p, 0.7)) : 0;
  }

  /**
   * How far from the centreline a crafted pool's water reaches at (x, z) on
   * river `owner`, or NaN where no crafted bowl is open. The pool is the last
   * tier whose lip line the point is past (as in siteGorgeAt); its water runs
   * out past the bowl's waterline over the apron, where the carve has already
   * stood the ground `rim` over the pool, so the shore is where the bowl's
   * ground rises out of it and the usual clip, foam and freeboard apply. Zero
   * at the necks: at every lip the water is the channel's again.
   */
  function sitePoolReach(x: number, z: number, owner: number): number {
    for (const g of siteGorges) {
      if (g.owner !== owner || x < g.minX || x > g.maxX || z < g.minZ || z > g.maxZ) continue;
      let t = -1;
      let rel = 0;
      for (let i = 0; i < g.tiers.length; i++) {
        const tier = g.tiers[i]!;
        const r = (x - tier.lx) * tier.dx + (z - tier.lz) * tier.dz;
        if (r > 0) {
          t = i;
          rel = r;
        }
      }
      if (t < 0) continue;
      const shape = siteBowlShape(g, t, rel, x, z);
      if (shape <= 0) continue;
      const tier = g.tiers[t]!;
      return tier.half + (tier.bowlHalf - tier.half) * shape + SITE_BOWL_APRON;
    }
    return NaN;
  }

  /** Smooth 1D value noise in [0, 1] along the channel (integer-hashed lattice, so every engine agrees). */
  function siteNoise(s: number, channel: number, gorgeSeed: number): number {
    const i = Math.floor(s);
    const f = s - i;
    const a = hashUnit(i, channel, 0, gorgeSeed);
    const b = hashUnit(i + 1, channel, 0, gorgeSeed);
    return a + (b - a) * f * f * (3 - 2 * f);
  }

  /**
   * A crafted cascade's gorge, SITE-scale. The river carve alone makes a
   * straight smooth slot under every fall; the shape here is built from the
   * site's tiers instead and only ever cuts (a smooth minimum with the ground
   * so far):
   *
   * - under each pool a rounded bowl, up to `bowl` x the channel wide, oval
   *   and widest a third of the way down (a plunge pool), necked back to the
   *   channel's own width wherever the water is held to it (FALL_NARROW);
   *   its edge is the waterline, an apron then climbs to `rim` over the pool
   *   so the banks hold it;
   * - side walls that start a wandering distance out from the bowl (value
   *   noise per side, `wavelength`) and step back in benches `step` high whose
   *   levels are world heights, so they run on as strata from tier to tier;
   * - at each lip the upper tier's shape carries on past the lip line and
   *   falls away at SITE_HEADWALL_RISE from a curved line (`curve`·d² further
   *   downstream at d across): a concave amphitheatre round the pool, not a
   *   straight cut. Upstream of the first lip nothing changes.
   *
   * Everything eases out to the land over the last SITE_GORGE_FADE metres of
   * `reach` and past the last bowl, and a bounding box keeps every other
   * column to four comparisons.
   */
  function siteGorgeAt(x: number, z: number, out: number): number {
    for (const g of siteGorges) {
      if (x < g.minX || x > g.maxX || z < g.minZ || z > g.maxZ) continue;
      const cfg = g.cfg;
      // nearest point of the centreline: arc length, distance, side
      let best = Infinity;
      let s = 0;
      let side = 1;
      for (let k = 0; k + 1 < g.px.length; k++) {
        const ax = g.px[k]!;
        const az = g.pz[k]!;
        const sx = g.px[k + 1]! - ax;
        const sz = g.pz[k + 1]! - az;
        const len2 = sx * sx + sz * sz;
        const t = len2 < 1e-9 ? 0 : Math.max(0, Math.min(1, ((x - ax) * sx + (z - az) * sz) / len2));
        const ex = x - (ax + sx * t);
        const ez = z - (az + sz * t);
        const d2 = ex * ex + ez * ez;
        if (d2 >= best) continue;
        best = d2;
        s = g.ps[k]! + (g.ps[k + 1]! - g.ps[k]!) * t;
        side = sx * ez - sz * ex >= 0 ? 1 : -1;
      }
      const dist = Math.sqrt(best);
      if (dist >= cfg.reach) continue;
      const last = g.tiers[g.tiers.length - 1]!;
      const relLast = (x - last.lx) * last.dx + (z - last.lz) * last.dz;
      // Past the last bowl the walls steepen back to the gorge slope the
      // river carve makes and stop wandering, so the shape has already met
      // the channel downstream by the time it is faded out: fading the
      // HEIGHT of a wide terraced gorge closed it off in a pocket.
      const exit = smoothstep(last.poolLen, last.poolLen + 2 * SITE_GORGE_FADE, relLast);
      const w = (1 - smoothstep(cfg.reach - SITE_GORGE_FADE, cfg.reach, dist)) * (1 - smoothstep(last.poolLen + SITE_GORGE_FADE, last.poolLen + 2 * SITE_GORGE_FADE, relLast));
      if (w <= 0) continue;
      // per-side wander of the walls' foot, their mean slope, and a slow
      // tilt of the bench levels: all low-frequency along the channel
      const ch = side > 0 ? 1 : 2;
      const lam = cfg.wavelength;
      const wander = (1 - exit) * cfg.wander * (0.65 * siteNoise(s / lam, ch, g.seed) + 0.35 * siteNoise(s / (lam * 0.6), ch + 4, g.seed));
      const slope = cfg.slope * (0.9 + 0.2 * siteNoise(s / (lam * 1.3), ch + 8, g.seed)) * (1 - exit) + FALL_GORGE_RISE * exit;
      const tilt = cfg.step * 0.6 * siteNoise(s / (lam * 2), 12, g.seed);
      let ground = out;
      for (let t = 0; t < g.tiers.length; t++) {
        const tier = g.tiers[t]!;
        const rel = (x - tier.lx) * tier.dx + (z - tier.lz) * tier.dz;
        if (rel <= 0) continue;
        // this tier's pool shape at (rel, dist)
        const level = tier.bottom;
        const shape = siteBowlShape(g, t, rel, x, z);
        const bowl = tier.half + (tier.bowlHalf - tier.half) * shape;
        const apron = bowl + SITE_BOWL_APRON;
        const rimY = level + cfg.rim;
        let pool: number;
        if (dist < bowl) pool = level - cfg.depth * shape * (1 - (dist / bowl) ** 4);
        else if (dist < apron) pool = level + cfg.rim * smoothstep(bowl, apron, dist);
        else if (dist < apron + wander) pool = rimY;
        else {
          // benches: a smooth staircase in world height, flat treads and
          // risers about 2.1x the mean slope
          const q = (rimY + slope * (dist - apron - wander) + tilt) / cfg.step;
          const n = Math.floor(q);
          const stepped = (n + smoothstep(0.3, 1, q - n)) * cfg.step - tilt;
          pool = Math.max(rimY, stepped + (q * cfg.step - tilt - stepped) * exit);
        }
        // the upper tier's shape carries on past the lip and falls away as
        // a curved headwall
        // (over the distance to the curved face line, not along the lip: the
        // curve bends the face out sideways, and it must stay this steep, no more)
        const bend = 2 * cfg.curve * dist;
        const ramp = (SITE_HEADWALL_RISE * Math.max(0, rel - cfg.curve * dist * dist)) / Math.sqrt(1 + bend * bend);
        // a smooth maximum: where the face crosses the benches the edge is
        // rounded over two metres, never a knife ridge
        const upper = ground - ramp;
        const hm = Math.max(0, Math.min(1, 0.5 + (0.5 * (upper - pool)) / 2));
        const next = pool + (upper - pool) * hm + 2 * hm * (1 - hm);
        ground += (next - ground) * smoothstep(0, 1.5, rel);
      }
      const depth = out - ground;
      if (depth <= 0) continue;
      // eased in over the first metre of depth, so the shape rolls into the
      // land instead of creasing (C1, and exactly nothing where it does not
      // cut: a symmetric smooth minimum dipped every untouched column)
      const k = 1;
      const cut = depth > k ? depth - k / 2 : (depth * depth) / (2 * k);
      out -= cut * w;
    }
    return out;
  }
  /**
   * Every fall's LIP LINE: the line across the channel at the lip point, the
   * one place the upper water ends and the lower begins. Upstream of it within
   * `reach` of the channel everything belongs to the upper level — the carve,
   * the water, the banks — and downstream of it everything to the lower. The
   * old rules asked "which segment is nearest", and a point beside the lip was
   * nearest the lip SEGMENT, which interpolates between the two levels: the
   * lower gorge's V ate back into the upper bank, the upper lake's reach hung
   * out over the cliff, and walls and rims were built up to fight both.
   */
  interface Lip {
    owner: number;
    along: number;
    lx: number;
    lz: number;
    dx: number;
    dz: number;
    top: number;
    bottom: number;
    bedTop: number;
    bedBottom: number;
    half: number;
    reach: number;
  }
  let lipList: Lip[] = [];
  let lipBuckets = makeBuckets<Lip>([], () => [0, 0, 0, 0]);
  const lipHit = { lip: null as Lip | null, rel: 0, across: 0 };
  /** The lip whose band (x, z) is in: `rel` metres past its line (negative upstream), `across` from the centreline. */
  function lipAt(x: number, z: number): typeof lipHit | null {
    if (lipList.length === 0) return null;
    let found: Lip | null = null;
    let bestAcross = Infinity;
    let rel = 0;
    for (const lip of bucketAt(lipBuckets, x, z) as readonly Lip[]) {
      const px = x - lip.lx;
      const pz = z - lip.lz;
      const along = px * lip.dx + pz * lip.dz;
      const across = Math.abs(-px * lip.dz + pz * lip.dx);
      if (across > lip.reach || along < -(FALL_WALL_UP + 3) || along > lip.top - lip.bottom + 30) continue;
      if (across < bestAcross) {
        bestAcross = across;
        found = lip;
        rel = along;
      }
    }
    if (!found) return null;
    lipHit.lip = found;
    lipHit.rel = rel;
    lipHit.across = bestAcross;
    return lipHit;
  }
  let riverGeom: {
    along: Float64Array;
    sx: number;
    sz: number;
    sdx: number;
    sdz: number;
    ex: number;
    ez: number;
    edx: number;
    edz: number;
    /** Does the water stop at this end? Only at a head and at a mouth that runs out on land. */
    capStart: boolean;
    capEnd: boolean;
    /** This river's falls: arc length at the lip's top, and the water above and below. */
    falls: { along: number; top: number; bottom: number }[];
  }[] = [];

  /**
   * Every river resampled to RIVER_SAMPLE and its water solved as POOLS.
   *
   * A river is a chain of docs (a traced river is written as wet and dry
   * pieces end to end); each chain is walked from its head carrying a level.
   * At each point the "natural" surface is the old rule, most of the depth
   * over the bed. The level holds while that falls less than POOL_STEP below
   * it and then drops to it: level water stepping down in short rapids.
   * Where a point lies in a lake's sheet the level IS the lake; where a
   * chain ends in another river it takes that river's level, so chains are
   * solved trunk before tributary. The bed is then cut to MIN_WATER_VOXELS
   * under the level (never raised), so the carve and the water are one
   * decision and cannot disagree.
   */
  /**
   * A crafted site's `course` spliced into the river it sits on: the river's
   * points from the one nearest the course's first point to the one nearest
   * its last are replaced by the course, bed/width/depth interpolated by arc
   * length between the kept ends. Before the resample, so the new bend is
   * splined, carved and solved like any other reach.
   */
  function spliceCourses(river: RiverDoc): RiverDoc {
    let out = river;
    for (const site of recipe.features.fallSites ?? []) {
      const course = site.course ?? [];
      if (course.length < 2) continue;
      const pts = out.points;
      const nearest = (q: readonly [number, number]): { k: number; d: number } => {
        let best = { k: -1, d: Infinity };
        pts.forEach((p, k) => {
          const d = Math.hypot(p[0] - q[0], p[1] - q[1]);
          if (d < best.d) best = { k, d };
        });
        return best;
      };
      const a = nearest(course[0]!);
      const b = nearest(course[course.length - 1]!);
      const reach = out.width * 1.5 + 10;
      if (a.d > reach || b.d > reach || b.k <= a.k) continue;
      const n = pts.length;
      const lerpAt = (arr: readonly number[] | undefined, t: number): number | undefined =>
        arr && arr.length === n ? arr[a.k]! + (arr[b.k]! - arr[a.k]!) * t : undefined;
      let total = 0;
      for (let i = 1; i < course.length; i++) total += Math.hypot(course[i]![0] - course[i - 1]![0], course[i]![1] - course[i - 1]![1]);
      const mid: { p: [number, number]; t: number }[] = [];
      let run = 0;
      course.forEach((q, i) => {
        if (i > 0) run += Math.hypot(q[0] - course[i - 1]![0], q[1] - course[i - 1]![1]);
        mid.push({ p: [q[0], q[1]], t: total > 0 ? run / total : 0 });
      });
      const pick = <T,>(arr: readonly T[] | undefined, fill: (t: number) => T | undefined): T[] | undefined => {
        if (!arr || arr.length !== n) return undefined;
        const middle = mid.map((m) => fill(m.t)!);
        return [...arr.slice(0, a.k), ...middle, ...arr.slice(b.k + 1)];
      };
      const points = [...pts.slice(0, a.k), ...mid.map((m) => m.p), ...pts.slice(b.k + 1)];
      out = {
        ...out,
        points,
        ...(pick(out.bedY, (t) => lerpAt(out.bedY, t)) ? { bedY: pick(out.bedY, (t) => lerpAt(out.bedY, t)) } : {}),
        ...(pick(out.widths, (t) => lerpAt(out.widths, t)) ? { widths: pick(out.widths, (t) => lerpAt(out.widths, t)) } : {}),
        ...(pick(out.depths, (t) => lerpAt(out.depths, t)) ? { depths: pick(out.depths, (t) => lerpAt(out.depths, t)) } : {}),
      };
    }
    return out;
  }

  function refineRivers(): void {
    if (riverDocs.length === 0) return;
    const hasBed = (r: RiverDoc): boolean => !!r.bedY && r.bedY.length === r.points.length;
    // a doc that already carries its levels is taken as written
    const open = (r: RiverDoc): boolean => hasBed(r) && !(r.surfaceY && r.surfaceY.length === r.points.length);
    const docs: RiverDoc[] = riverDocs.map((r) => (open(r) ? splineRiver(withMidpoint(spliceCourses(r)), RIVER_SAMPLE) : r));
    const minWater = MIN_WATER_VOXELS * voxelSize;
    const lakeLevel = (x: number, z: number): number => {
      let best = NaN;
      for (const lake of bucketAt(lakes, x, z) as readonly LakeDoc[]) {
        if (lakeDistance(lake, x, z) <= lake.bank * 0.75 && !(lake.waterY <= best)) best = lake.waterY;
      }
      return best;
    };
    // chains: a doc whose head sits on another's mouth continues it
    const linkChains = () => {
      const count = docs.length;
      const key = (q: readonly [number, number]): string => `${Math.round(q[0])},${Math.round(q[1])}`;
      const byHead = new Map<string, number>();
      docs.forEach((d, i) => {
        if (open(d)) byHead.set(key(d.points[0]!), i);
      });
      const next = new Array<number>(count).fill(-1);
      const hasPrev = new Array<boolean>(count).fill(false);
      docs.forEach((d, i) => {
        if (!open(d)) return;
        const j = byHead.get(key(d.points[d.points.length - 1]!));
        if (j !== undefined && j !== i && !hasPrev[j]) {
          next[i] = j;
          hasPrev[j] = true;
        }
      });
      const chains: number[][] = [];
      docs.forEach((d, i) => {
        if (!open(d) || hasPrev[i]) return;
        const chain: number[] = [];
        for (let k = i; k >= 0 && !chain.includes(k); k = next[k]!) chain.push(k);
        chains.push(chain);
      });
      const chainOf = new Array<number>(count).fill(-1);
      chains.forEach((c, ci) => c.forEach((i) => (chainOf[i] = ci)));
      return { next, hasPrev, chains, chainOf };
    };

    // Capture. A course that CROSSES another river's channel (a traced
    // meander swung into its neighbour, a hand-drawn line drawn over one)
    // cannot pass it: two channels at different levels meeting at an angle
    // are a hole in one and a wall in the other. The river with the higher
    // bed at the crossing is captured: it ends there, joined to the other,
    // and the rest of its course is dropped. A tributary's own join at its
    // mouth and an outlet's start are not crossings.
    {
      const first = linkChains();
      interface Seg { chain: number; i: number; k: number; ax: number; az: number; bx: number; bz: number }
      const CELL = 64;
      const grid = new Map<number, Seg[]>();
      const segsOf: Seg[][] = first.chains.map(() => []);
      first.chains.forEach((chain, ci) => {
        for (const i of chain) {
          const d = docs[i]!;
          if (!d.water) continue;
          for (let k = 0; k + 1 < d.points.length; k++) {
            const a = d.points[k]!;
            const b = d.points[k + 1]!;
            const seg: Seg = { chain: ci, i, k, ax: a[0], az: a[1], bx: b[0], bz: b[1] };
            segsOf[ci]!.push(seg);
            for (let gz = Math.floor(Math.min(a[1], b[1]) / CELL); gz <= Math.floor(Math.max(a[1], b[1]) / CELL); gz++) {
              for (let gx = Math.floor(Math.min(a[0], b[0]) / CELL); gx <= Math.floor(Math.max(a[0], b[0]) / CELL); gx++) {
                const g = bucketKey(gx, gz);
                const list = grid.get(g);
                if (list) list.push(seg);
                else grid.set(g, [seg]);
              }
            }
          }
        }
      });
      const cross = (p: Seg, q: Seg): number => {
        const rx = p.bx - p.ax;
        const rz = p.bz - p.az;
        const sx = q.bx - q.ax;
        const sz = q.bz - q.az;
        const den = rx * sz - rz * sx;
        if (Math.abs(den) < 1e-9) return -1;
        const t = ((q.ax - p.ax) * sz - (q.az - p.az) * sx) / den;
        const u = ((q.ax - p.ax) * rz - (q.az - p.az) * rx) / den;
        return t >= 0 && t <= 1 && u >= 0 && u <= 1 ? t : -1;
      };
      const bedAt = (seg: Seg, t: number): number => {
        const bed = docs[seg.i]!.bedY!;
        return bed[seg.k]! + (bed[seg.k + 1]! - bed[seg.k]!) * t;
      };
      /** Is this segment within the first or last two of its chain — the head leaving, or the mouth joining? */
      const atEnd = (seg: Seg): boolean => {
        const list = segsOf[seg.chain]!;
        const idx = list.indexOf(seg);
        return idx < 2 || idx >= list.length - 2;
      };
      const cutAt = new Map<number, { seg: Seg; t: number }>();
      segsOf.forEach((list) => {
        for (const seg of list) {
          if (atEnd(seg)) continue;
          const near = new Set<Seg>();
          for (let gz = Math.floor(Math.min(seg.az, seg.bz) / CELL); gz <= Math.floor(Math.max(seg.az, seg.bz) / CELL); gz++) {
            for (let gx = Math.floor(Math.min(seg.ax, seg.bx) / CELL); gx <= Math.floor(Math.max(seg.ax, seg.bx) / CELL); gx++) {
              for (const o of grid.get(bucketKey(gx, gz)) ?? []) near.add(o);
            }
          }
          for (const other of near) {
            if (other.chain === seg.chain || atEnd(other)) continue;
            const t = cross(seg, other);
            if (t < 0) continue;
            const u = cross(other, seg);
            // the higher bed is captured by the lower
            const loser = bedAt(seg, t) >= bedAt(other, u) ? { seg, t } : { seg: other, t: u };
            const known = cutAt.get(loser.seg.chain);
            const order = (x: { seg: Seg; t: number }): number => segsOf[x.seg.chain]!.indexOf(x.seg) + x.t;
            if (!known || order(loser) < order(known)) cutAt.set(loser.seg.chain, loser);
          }
        }
      });
      if (cutAt.size > 0) {
        const drop = new Set<number>();
        for (const [ci, { seg, t }] of cutAt) {
          const chain = first.chains[ci]!;
          const d = docs[seg.i]!;
          const m = d.points.length;
          const lerp = (arr: readonly number[] | undefined): number[] | undefined =>
            arr && arr.length === m ? [...arr.slice(0, seg.k + 1), arr[seg.k]! + (arr[seg.k + 1]! - arr[seg.k]!) * t] : undefined;
          const points = [...d.points.slice(0, seg.k + 1), [seg.ax + (seg.bx - seg.ax) * t, seg.az + (seg.bz - seg.az) * t] as [number, number]];
          const widths = lerp(d.widths);
          const depths = lerp(d.depths);
          docs[seg.i] = { ...d, points, bedY: lerp(d.bedY)!, ...(widths ? { widths } : {}), ...(depths ? { depths } : {}) };
          for (const i of chain.slice(chain.indexOf(seg.i) + 1)) drop.add(i);
        }
        const kept = docs.filter((_, i) => !drop.has(i));
        docs.length = 0;
        docs.push(...kept);
      }
    }
    const { next, hasPrev, chains, chainOf } = linkChains();
    const n = docs.length;
    const halfAt = (d: RiverDoc, k: number): number => (d.widths && d.widths.length === d.points.length ? d.widths[k]! : d.width) / 2;
    /** The nearest point of ANOTHER chain's wet river whose bed and half a bank reach (x, z). */
    const parentHit = (x: number, z: number, self: number): { i: number; k: number } | null => {
      let best: { i: number; k: number } | null = null;
      let bestD = Infinity;
      for (let i = 0; i < n; i++) {
        const d = docs[i]!;
        if (chainOf[i] === self || chainOf[i]! < 0 || !d.water) continue;
        const reach = riverBank(d, NaN) * 0.5;
        for (let k = 0; k < d.points.length; k++) {
          const q = d.points[k]!;
          const dist = Math.hypot(q[0] - x, q[1] - z) - halfAt(d, k);
          if (dist > reach || dist >= bestD) continue;
          bestD = dist;
          best = { i, k };
        }
      }
      return best;
    };
    const parentOf = chains.map((c, ci) => {
      const last = docs[c[c.length - 1]!]!;
      const [mx, mz] = last.points[last.points.length - 1]!;
      const hit = parentHit(mx, mz, ci);
      return hit ? chainOf[hit.i]! : -1;
    });
    // The bank each point may not brim over: the lower side's ground (the
    // world with no river carved, so a levee never lifts its own cap), less
    // the freeboard. A side standing in a lake does not count — that water
    // is the lake's.
    const savedDocs = riverDocs;
    const savedSegs = riverSegs;
    riverDocs = [];
    riverSegs = buildRiverSegs([]);
    waterStageOnly = true;
    const bankCap: (Float64Array | null)[] = docs.map((d) => {
      if (!open(d) || !d.water) return null;
      const m = d.points.length;
      const out = new Float64Array(m);
      for (let k = 0; k < m; k++) {
        const a = d.points[Math.max(0, k - 1)]!;
        const b = d.points[Math.min(m - 1, k + 1)]!;
        const len = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
        const nx = -(b[1] - a[1]) / len;
        const nz = (b[0] - a[0]) / len;
        const width = d.widths && d.widths.length === m ? d.widths[k]! : d.width;
        const reach = width / 2 + riverBank(d, d.widths && d.widths.length === m ? width : NaN) * 0.7;
        const [x, z] = d.points[k]!;
        const side = (sign: number): number => {
          let low = Infinity;
          for (const o of [reach, reach + 4]) {
            const sx = x + nx * o * sign;
            const sz = z + nz * o * sign;
            if (!Number.isNaN(lakeLevel(sx, sz))) return Infinity;
            low = Math.min(low, height(sx, sz));
          }
          return low;
        };
        // the ground UNDER the channel too: a traced course that rides along a
        // canyon floor has its banks on the rim, and only the middle sees it
        const under = Number.isNaN(lakeLevel(x, z)) ? height(x, z) : Infinity;
        out[k] = Math.min(side(1), side(-1), under) - RIVER_FREEBOARD;
      }
      // Smoothed along the river (a mean over seven samples, never more than
      // half a metre over the true bank): the pools follow the lie of the
      // land, not every lump in the bank, which cut them into tiny steps.
      const smooth = new Float64Array(m);
      for (let k = 0; k < m; k++) {
        let sum = 0;
        let count = 0;
        for (let j = Math.max(0, k - 3); j <= Math.min(m - 1, k + 3); j++) {
          if (!Number.isFinite(out[j]!)) continue;
          sum += out[j]!;
          count++;
        }
        smooth[k] = count > 0 ? Math.min(sum / count, out[k]! + 0.5) : out[k]!;
      }
      return smooth;
    });
    riverDocs = savedDocs;
    riverSegs = savedSegs;
    waterStageOnly = false;
    // Every chain as one run of (doc, point) references, head to mouth.
    const refs = chains.map((c) => c.flatMap((i) => docs[i]!.points.map((_, k) => [i, k] as [number, number])));
    const levels = docs.map((d) => new Float64Array(d.points.length).fill(NaN));
    const inLake = docs.map((d) => new Uint8Array(d.points.length));
    const depthOf = (d: RiverDoc, k: number): number => (d.depths && d.depths.length === d.points.length ? d.depths[k]! : d.depth);

    // Pass 1 — the ENVELOPE: the highest each point's water may stand. It is
    // the old natural surface (most of the depth over the traced bed) or the
    // bank cap, whichever is lower, and it never rises downstream. A lake is
    // its level; the last reach to the sea runs down to it.
    const gapOf = (run: [number, number][], idx: number): number => {
      if (idx === 0) return 0;
      const [pi, pk] = run[idx - 1]!;
      const [i, k] = run[idx]!;
      const a = docs[pi]!.points[pk]!;
      const b = docs[i]!.points[k]!;
      return Math.hypot(b[0] - a[0], b[1] - a[1]);
    };
    refs.forEach((run) => {
      let level = Infinity;
      for (const [i, k] of run) {
        const d = docs[i]!;
        const natural = d.bedY![k]! + Math.max(0.4, depthOf(d, k) * 0.7);
        const [x, z] = d.points[k]!;
        const lake = lakeLevel(x, z);
        if (!Number.isNaN(lake)) {
          level = lake;
          inLake[i]![k] = 1;
        } else if (natural <= recipe.seaLevel + POOL_STEP) {
          level = Math.min(level, natural);
        } else {
          const cap = bankCap[i] ? bankCap[i]![k]! : Infinity;
          level = Math.min(level, natural, cap);
        }
        levels[i]![k] = level;
      }
    });

    // Where each tributary enters its trunk: the first of its points inside
    // the trunk's channel, and the trunk point there.
    const where = new Map<string, number>();
    refs.forEach((run) => run.forEach(([i, k], idx) => where.set(`${i}:${k}`, idx)));
    const joins = chains.map((_, ci) => {
      if (parentOf[ci]! < 0) return null;
      const run = refs[ci]!;
      let from = run.length;
      let trunk: { i: number; k: number } | null = null;
      for (let idx = run.length - 1; idx >= 0; idx--) {
        const [i, k] = run[idx]!;
        const hit = parentHit(docs[i]!.points[k]![0], docs[i]!.points[k]![1], ci);
        if (!hit || chainOf[hit.i] !== parentOf[ci]) break;
        from = idx;
        trunk = hit;
      }
      if (!trunk) {
        const [i, k] = run[run.length - 1]!;
        trunk = parentHit(docs[i]!.points[k]![0], docs[i]!.points[k]![1], ci);
      }
      return trunk ? { from, trunk: where.get(`${trunk.i}:${trunk.k}`)!, chain: chainOf[trunk.i]! } : null;
    });

    // Pass 2 — the network. A tributary runs INTO its trunk, so the trunk
    // may not stand higher at the confluence than the tributary arriving
    // there; where it does (a trunk perched on its traced bed, a tributary
    // cut down under its banks) the trunk is lowered from the confluence to
    // its mouth, never through a lake. That can lower the trunk's own
    // arrival at ITS trunk, so repeat until nothing moves.
    for (let pass = 0; pass < 32; pass++) {
      let moved = false;
      joins.forEach((join, ci) => {
        if (!join || join.from === 0) return;
        const [ai, ak] = refs[ci]![join.from - 1]!;
        const arriving = levels[ai]![ak]!;
        const trunk = refs[join.chain]!;
        const [ti, tk] = trunk[join.trunk]!;
        if (!(levels[ti]![tk]! > arriving + 0.01)) return;
        // from a little UPSTREAM of the confluence: the trunk's drop is then a
        // rapid on the trunk itself, not a step where the two channels overlap
        const [ax, az] = docs[ai]!.points[ak]!;
        const near = halfAt(docs[ti]!, tk) + halfAt(docs[ai]!, ak) + riverBank(docs[ai]!, NaN) + RIVER_SAMPLE;
        let start = join.trunk;
        while (start > 0) {
          const [pi, pk] = trunk[start - 1]!;
          const q = docs[pi]!.points[pk]!;
          if (inLake[pi]![pk] || Math.hypot(q[0] - ax, q[1] - az) > near) break;
          start--;
        }
        for (let idx = start; idx < trunk.length; idx++) {
          const [i, k] = trunk[idx]!;
          if (inLake[i]![k]) break;
          if (levels[i]![k]! > arriving) levels[i]![k] = arriving;
        }
        moved = true;
      });
      if (!moved) break;
    }
    // Pass 3 — the water, trunk before tributary. A tributary's last points
    // (inside its trunk's channel) ARE the trunk's water, and lakes are their
    // level. Then, from the mouth up, the water may rise no faster than the
    // run grade — except across the river's one fall, at the sharpest drop of
    // its envelope. Wherever the envelope falls faster the water stays under
    // it, so the channel is cut down: a gorge above a scarp, not a stair.
    const order: number[] = [];
    const placed = new Array<boolean>(chains.length).fill(false);
    // a river whose HEAD is inside another's channel (a branch splitting off
    // above a fall) takes that river's level there, so it is solved after it
    const headParent = chains.map((c, ci) => {
      const [hx, hz] = docs[c[0]!]!.points[0]!;
      const hit = parentHit(hx, hz, ci);
      return hit ? chainOf[hit.i]! : -1;
    });
    const visit = (ci: number, depth: number): void => {
      if (placed[ci] || depth > chains.length) return;
      const parent = joins[ci]?.chain ?? -1;
      if (parent >= 0) visit(parent, depth + 1);
      if (headParent[ci]! >= 0) visit(headParent[ci]!, depth + 1);
      if (!placed[ci]) {
        placed[ci] = true;
        order.push(ci);
      }
    };
    chains.forEach((_, ci) => visit(ci, 0));
    for (const ci of order) {
      const run = refs[ci]!;
      const n = run.length;
      const join = joins[ci];
      const env = run.map(([i, k]) => levels[i]![k]!);
      const rampFrom = new Uint8Array(run.length);
      const fixed = new Array<number>(n).fill(NaN);
      run.forEach(([i, k], idx) => {
        if (inLake[i]![k]) fixed[idx] = levels[i]![k]!;
      });
      if (join) {
        for (let idx = join.from; idx < n; idx++) {
          const [i, k] = run[idx]!;
          const hit = parentHit(docs[i]!.points[k]![0], docs[i]!.points[k]![1], ci);
          if (hit) fixed[idx] = levels[hit.i]![hit.k]!;
        }
      }
      if (headParent[ci]! >= 0) {
        for (let idx = 0; idx < n; idx++) {
          if (!Number.isNaN(fixed[idx]!)) break;
          const [i, k] = run[idx]!;
          const hit = parentHit(docs[i]!.points[k]![0], docs[i]!.points[k]![1], ci);
          if (!hit) break;
          fixed[idx] = levels[hit.i]![hit.k]!;
        }
      }
      for (let idx = 0; idx < n; idx++) if (!Number.isNaN(fixed[idx]!)) env[idx] = fixed[idx]!;
      const gaps = run.map((_, idx) => gapOf(run, idx));
      // Leaving a lake the water may not step down at the shore: the bank cap
      // beside an outlet is under the lake's level, and the water dropped a
      // metre or two right at the shoreline — a small step with no lip, a
      // hard seam between the still sheet and the river. It descends from the
      // lake's level at the run grade instead (up to OUTLET_RAMP over the
      // cap; the levee pass holds banks up to it).
      for (let idx = 1; idx < n; idx++) {
        if (!Number.isNaN(fixed[idx]!)) continue;
        const [pi, pk] = run[idx - 1]!;
        const fromLake = inLake[pi]![pk] === 1 || rampFrom[idx - 1] === 1;
        if (!fromLake) continue;
        const want = env[idx - 1]! - RIVER_RUN_GRADE * gaps[idx]!;
        if (want <= env[idx]!) continue;
        if (want - env[idx]! > OUTLET_RAMP) break;
        env[idx] = want;
        rampFrom[idx] = 1;
      }
      // the fall: the most the envelope loses inside the window, never inside a lake
      let fallAt = -1;
      let best = RIVER_FALL_MIN;
      for (let a = 0; a + 1 < n; a++) {
        if (!Number.isNaN(fixed[a]!) && !Number.isNaN(fixed[a + 1]!)) continue;
        // never within a few samples of a lake: a lake spilling straight over a
        // cliff made the calm sheet and the falling one meet at a hard seam
        let byLake = false;
        for (let j = Math.max(0, a - 3); j <= Math.min(n - 1, a + 3); j++) {
          const [ji, jk] = run[j]!;
          if (inLake[ji]![jk]) byLake = true;
        }
        if (byLake) continue;
        let reach = 0;
        for (let b = a + 1; b < n; b++) {
          reach += gaps[b]!;
          if (reach > RIVER_FALL_WINDOW) break;
          if (env[a]! - env[b]! > best) {
            best = env[a]! - env[b]!;
            fallAt = a;
          }
        }
      }
      const water = new Array<number>(n);
      water[n - 1] = env[n - 1]!;
      for (let idx = n - 2; idx >= 0; idx--) {
        if (!Number.isNaN(fixed[idx]!)) {
          water[idx] = fixed[idx]!;
          continue;
        }
        const limit = idx === fallAt ? Infinity : water[idx + 1]! + RIVER_RUN_GRADE * gaps[idx + 1]!;
        water[idx] = Math.min(env[idx]!, limit);
      }
      run.forEach(([i, k], idx) => {
        levels[i]![k] = water[idx]!;
      });
    }
    // Agent-crafted fall sites re-shape their falls' levels (fall-sites.ts):
    // the points they raise take their bed up with the water.
    const crafted = applyFallSites(
      recipe.features.fallSites ?? [],
      docs,
      refs,
      levels,
      (run, idx) => gapOf(run as [number, number][], idx),
      (d, k) => (d.widths && d.widths.length === d.points.length ? d.widths[k]! : d.width) / 2 + riverBank(d, NaN) * 0.7,
    );
    solvedSites = crafted.solved;
    // The bed is cut the minimum water depth under the level, never raised.
    // Every drop worth a cliff gets a point RIVER_FALL_LIP above the next
    // sample: the water and the bed hold their level to the lip and fall
    // over it, instead of ramping down the whole sample — and the foot is
    // cut into a plunge pool, deeper the higher the fall.
    const round = (v: number): number => Math.round(v * 100) / 100;
    chains.forEach((c) =>
      c.forEach((i) => {
        const d = docs[i]!;
        const m = d.points.length;
        const lv = levels[i]!;
        const underOf = (level: number, k: number): number => level - Math.max(minWater, depthOf(d, k) * 0.7);
        const points: [number, number][] = [];
        const bedY: number[] = [];
        const surfaceY: number[] = [];
        const widths: number[] = [];
        const depths: number[] = [];
        const hasW = !!d.widths && d.widths.length === m;
        const hasD = !!d.depths && d.depths.length === m;
        for (let k = 0; k < m; k++) {
          const q = d.points[k]!;
          const drop = k > 0 ? lv[k - 1]! - lv[k]! : 0;
          if (d.water && k > 0 && drop >= 1) {
            const a = d.points[k - 1]!;
            const len = Math.hypot(q[0] - a[0], q[1] - a[1]);
            // every drop gets its lip when its step is longer than one: a
            // 54 m drop over a 5.5 m step once slipped between the old
            // threshold (twice the lip) and findFalls, and had no curtain
            if (len > RIVER_FALL_LIP + 0.5) {
              const t = (len - RIVER_FALL_LIP) / len;
              points.push([round(a[0] + (q[0] - a[0]) * t), round(a[1] + (q[1] - a[1]) * t)]);
              // the lip holds the level above it: the fall walls (fallWalls) stand
              // over it either side. Clamping it to the bank beside the lip — which
              // at a cliff edge falls away — put a sloped step before every fall.
              const lip = lv[k - 1]!;
              surfaceY.push(round(lip));
              const b0 = d.bedY![k - 1]! + (d.bedY![k]! - d.bedY![k - 1]!) * t;
              bedY.push(round(Math.min(b0, underOf(lip, k))));
              if (hasW) widths.push(d.widths![k - 1]! + (d.widths![k]! - d.widths![k - 1]!) * t);
              if (hasD) depths.push(d.depths![k - 1]! + (d.depths![k]! - d.depths![k - 1]!) * t);
            }
          }
          points.push([q[0], q[1]]);
          surfaceY.push(round(lv[k]!));
          const plunge = drop >= 1 ? Math.min(2.5, drop * 0.25) : 0;
          const lifted = crafted.raised.has(`${i}:${k}`);
          bedY.push(d.water ? round(lifted ? underOf(lv[k]!, k) - plunge : Math.min(d.bedY![k]!, underOf(lv[k]!, k) - plunge)) : d.bedY![k]!);
          if (hasW) widths.push(d.widths![k]!);
          if (hasD) depths.push(d.depths![k]!);
        }
        docs[i] = { ...d, points, bedY, surfaceY, ...(hasW ? { widths } : {}), ...(hasD ? { depths } : {}) };
      }),
    );
    // Where the water stops: a plane across the end of the polyline. Only at
    // a chain's head and at a mouth with nothing to take it (no lake, no
    // river, above the sea). Between two pieces of one river the planes of
    // both ends would leave a wedge dry on the outside of the bend, and at a
    // lake, a trunk or the sea the receiving water covers the end anyway.
    const capStart = docs.map((_, i) => !hasPrev[i]);
    const capEnd = docs.map((d, i) => {
      if (!open(d)) return true;
      if (next[i]! >= 0) return false;
      const [mx, mz] = d.points[d.points.length - 1]!;
      if (!Number.isNaN(lakeLevel(mx, mz))) return false;
      if (d.surfaceY && d.surfaceY[d.surfaceY.length - 1]! <= recipe.seaLevel + POOL_STEP) return false;
      return parentOf[chainOf[i]!]! < 0;
    });
    riverDocs = docs;
    riverSegs = buildRiverSegs(riverDocs);
    riverGeom = riverDocs.map((d, index) => {
      const pts = d.points;
      const m = pts.length;
      const along = new Float64Array(m);
      for (let k = 1; k < m; k++) along[k] = along[k - 1]! + Math.hypot(pts[k]![0] - pts[k - 1]![0], pts[k]![1] - pts[k - 1]![1]);
      const unit = (a: readonly [number, number], b: readonly [number, number]): [number, number] => {
        const l = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
        return [(b[0] - a[0]) / l, (b[1] - a[1]) / l];
      };
      const [sdx, sdz] = m > 1 ? unit(pts[1]!, pts[0]!) : [0, 0];
      const [edx, edz] = m > 1 ? unit(pts[m - 2]!, pts[m - 1]!) : [0, 0];
      const falls: { along: number; top: number; bottom: number }[] = [];
      if (d.water && d.surfaceY && d.surfaceY.length === m) {
        for (let k = 1; k < m; k++) {
          const drop = d.surfaceY[k - 1]! - d.surfaceY[k]!;
          if (drop >= 2 && along[k]! - along[k - 1]! <= RIVER_FALL_LIP + 0.5) falls.push({ along: along[k - 1]!, top: d.surfaceY[k - 1]!, bottom: d.surfaceY[k]! });
        }
      }
      return { along, sx: pts[0]![0], sz: pts[0]![1], sdx, sdz, ex: pts[m - 1]![0], ez: pts[m - 1]![1], edx, edz, capStart: capStart[index]!, capEnd: capEnd[index]!, falls };
    });
    lipList = [];
    riverDocs.forEach((d, owner) => {
      if (!d.water || !d.surfaceY || d.surfaceY.length !== d.points.length || !d.bedY) return;
      const m = d.points.length;
      for (let k = 1; k < m; k++) {
        const a = d.points[k - 1]!;
        const b = d.points[k]!;
        const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
        if (len > RIVER_FALL_LIP + 0.5 || d.surfaceY[k - 1]! - d.surfaceY[k]! < 2) continue;
        const width = d.widths && d.widths.length === m ? d.widths[k - 1]! : d.width;
        lipList.push({
          owner,
          along: riverGeom[owner]!.along[k - 1]!,
          lx: a[0],
          lz: a[1],
          dx: (b[0] - a[0]) / (len || 1),
          dz: (b[1] - a[1]) / (len || 1),
          top: d.surfaceY[k - 1]!,
          bottom: d.surfaceY[k]!,
          bedTop: d.bedY[k - 1]!,
          bedBottom: d.bedY[k]!,
          half: width / 2,
          reach: width / 2 + riverBank(d, d.widths && d.widths.length === m ? width : NaN) * 2.5,
        });
      }
    });
    lipBuckets = makeBuckets<Lip>(lipList, (lip) => {
      const r = lip.reach + lip.top - lip.bottom + 32;
      return [lip.lx - r, lip.lz - r, lip.lx + r, lip.lz + r];
    });
    siteGorges = buildSiteGorges();
  }

  /** The falls in the solved rivers: a drop of at least a metre over a lip (a short segment). */
  function findFalls(): RiverFall[] {
    const out: RiverFall[] = [];
    for (const d of riverDocs) {
      if (!d.water || !d.surfaceY || d.surfaceY.length !== d.points.length) continue;
      for (let k = 1; k < d.points.length; k++) {
        const a = d.points[k - 1]!;
        const b = d.points[k]!;
        const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
        const drop = d.surfaceY[k - 1]! - d.surfaceY[k]!;
        if (len > RIVER_FALL_LIP + 0.5 || drop < 2) continue;
        out.push({
          river: d.id,
          x: b[0],
          z: b[1],
          top: d.surfaceY[k - 1]!,
          bottom: d.surfaceY[k]!,
          dirX: (b[0] - a[0]) / (len || 1),
          dirZ: (b[1] - a[1]) / (len || 1),
          width: d.widths && d.widths.length === d.points.length ? d.widths[k]! : d.width,
          reach:
            (d.widths && d.widths.length === d.points.length ? d.widths[k - 1]! : d.width) / 2 +
            riverBank(d, d.widths && d.widths.length === d.points.length ? d.widths[k - 1]! : NaN) * 2.5,
        });
      }
    }
    return out;
  }

  /** Index k of the segment [k, k+1] of river `owner` that holds arc length `s`. */
  function segmentAt(owner: number, s: number): number {
    const along = riverGeom[owner]!.along;
    let lo = 0;
    let hi = along.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (along[mid]! <= s) lo = mid;
      else hi = mid;
    }
    return lo;
  }

  // ------------------------------------------------------------ lake floods
  /**
   * The water a lake really covers, beyond its traced outline. The outline is
   * traced on a 16 m grid and simplified, and in places it runs far inside
   * the basin (measured: 18 m under the lake's level at the outline, the
   * ground only rising out of the water 28 m further on). A fixed reach past
   * the outline then stopped the sheet in the middle of the lake bed — a
   * strip of exposed bed, a water edge standing over nothing. Instead each
   * lake is FLOODED on a 4 m raster from its reach outward, through every cell
   * whose ground is under its level, to at most LAKE_FLOOD_BANKS banks; never
   * past a waterfall's lip line, nor into a river channel running lower than
   * the lake (the outlet belongs to the river). The flood stops where the
   * ground rises out of the water: the true shore. Built lazily per lake,
   * dilated one cell (a sheet over dry ground is hidden under it), and read by
   * waterSurface; the mesh still clips against the ground.
   */
  interface LakeFlood {
    x0: number;
    z0: number;
    nx: number;
    nz: number;
    wet: Uint8Array;
  }
  const LAKE_FLOOD_CELL = 4;
  const LAKE_FLOOD_BANKS = 2;
  /**
   * How far under the lake a river beside it may run before the lake cedes
   * it the ground. It was 0.3 m: an outlet ramping down off the lake stays
   * within that for its first ~10 m, and the flood ran on beside it — at the
   * river-15 cascade an arm of the lake 20 m down the outlet valley, its end
   * standing 0.4–1.1 m over the dry slope beyond, and a 0.3 m step face
   * where the lake's sheet met the river's (6 hanging edges, 25 step
   * triangles in the mesh; with this 0: none and 12, all under 0.25 m).
   */
  const LAKE_OUTLET_TOL = 0.02;
  const lakeFloods = new Map<LakeDoc, LakeFlood>();
  function lakeFlood(lake: LakeDoc): LakeFlood {
    const known = lakeFloods.get(lake);
    if (known) return known;
    const band = lake.bank * LAKE_FLOOD_BANKS;
    let minX = lake.center[0] - lake.radius;
    let minZ = lake.center[1] - lake.radius;
    let maxX = lake.center[0] + lake.radius;
    let maxZ = lake.center[1] + lake.radius;
    for (const q of lake.polygon ?? []) {
      minX = Math.min(minX, q[0]);
      minZ = Math.min(minZ, q[1]);
      maxX = Math.max(maxX, q[0]);
      maxZ = Math.max(maxZ, q[1]);
    }
    const x0 = minX - band - LAKE_FLOOD_CELL;
    const z0 = minZ - band - LAKE_FLOOD_CELL;
    const nx = Math.ceil((maxX + band + LAKE_FLOOD_CELL - x0) / LAKE_FLOOD_CELL) + 1;
    const nz = Math.ceil((maxZ + band + LAKE_FLOOD_CELL - z0) / LAKE_FLOOD_CELL) + 1;
    const wet = new Uint8Array(nx * nz);
    const flood: LakeFlood = { x0, z0, nx, nz, wet };
    // set before filling: height() may ask waterSurface-free questions only,
    // but a re-entrant call must see an (empty) flood, not recurse
    lakeFloods.set(lake, flood);
    const queue: number[] = [];
    const cx = (i: number): number => x0 + (i % nx) * LAKE_FLOOD_CELL;
    const cz = (i: number): number => z0 + Math.floor(i / nx) * LAKE_FLOOD_CELL;
    const blocked = (x: number, z: number, tol = LAKE_OUTLET_TOL, margin = LAKE_FLOOD_CELL * 2): boolean => {
      const lip = lipAt(x, z);
      if (lip && lip.rel > 0 && lake.waterY >= lip.lip!.top - 0.5) return true;
      const count = nearestPerOwner(riverSegs, x, z, hits);
      for (let k = 0; k < count; k++) {
        const hit = hits[k]!;
        const river = riverDocs[hit.owner]!;
        if (!river.water || Number.isNaN(hit.side)) continue;
        const half = (Number.isNaN(hit.width) ? river.width : hit.width) / 2;
        // not into a lower river's water, nor within two cells of it: the
        // bank beside an outlet river is under the lake's level all the way
        // down its valley, and the flood ran on beside the river to 14 m
        // from the fall's lip, the lake's sheet standing up to 0.9 m over
        // the river's beside it (a sloped step face along the whole reach).
        // A river even a little lower (LAKE_OUTLET_TOL) is an outlet leaving
        // the lake: past the reach the lake stops before it
        const reach = half + riverBank(river, hit.width) * RIVER_WATER_REACH + margin;
        if (hit.distance <= reach && hit.side < lake.waterY - tol) return true;
      }
      return false;
    };
    for (let i = 0; i < nx * nz; i++) {
      const sd = lakeDistance(lake, cx(i), cz(i));
      // the reach past the traced outline obeys the same stops as the flood:
      // the outline often runs beside an outlet river, and the reach alone
      // stood the lake's sheet over the river's lower water there. Inside
      // the reach only a river well under the lake (0.3 m) clears the two
      // cells beside it; one only a little under takes just what its own
      // water covers — cleared wider, the lake's bed stood dry beside the
      // outlet of lakes whose river ramps off them gently
      if (sd <= lake.bank * 0.75 && (sd <= 0 || !(blocked(cx(i), cz(i), 0.3) || blocked(cx(i), cz(i), LAKE_OUTLET_TOL, 0)))) {
        wet[i] = 1;
        // only the rim of the reach grows; the inside needs no neighbours
        if (sd > lake.bank * 0.75 - LAKE_FLOOD_CELL * 1.5) queue.push(i);
      }
    }
    while (queue.length > 0) {
      const i = queue.pop()!;
      const ix = i % nx;
      const iz = Math.floor(i / nx);
      for (const [ox, oz] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
        const jx = ix + ox;
        const jz = iz + oz;
        if (jx < 0 || jz < 0 || jx >= nx || jz >= nz) continue;
        const j = jz * nx + jx;
        if (wet[j]) continue;
        const x = cx(j);
        const z = cz(j);
        if (lakeDistance(lake, x, z) > band) continue;
        if (height(x, z) >= lake.waterY - 0.05) continue;
        if (blocked(x, z)) continue;
        wet[j] = 1;
        queue.push(j);
      }
    }
    // dilate one cell, marked 2 so the dilation itself does not grow
    for (let i = 0; i < nx * nz; i++) {
      if (wet[i] !== 1) continue;
      const ix = i % nx;
      const iz = Math.floor(i / nx);
      for (const [ox, oz] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1], [1, -1], [-1, 1]] as const) {
        const jx = ix + ox;
        const jz = iz + oz;
        if (jx < 0 || jz < 0 || jx >= nx || jz >= nz) continue;
        const j = jz * nx + jx;
        if (!wet[j] && !blocked(cx(j), cz(j))) wet[j] = 2;
      }
    }
    return flood;
  }
  /** Is (x, z) under this lake's flooded water? Nearest raster cell. */
  function inLakeFlood(lake: LakeDoc, x: number, z: number): boolean {
    const f = lakeFlood(lake);
    const ix = Math.round((x - f.x0) / LAKE_FLOOD_CELL);
    const iz = Math.round((z - f.z0) / LAKE_FLOOD_CELL);
    if (ix < 0 || iz < 0 || ix >= f.nx || iz >= f.nz) return false;
    return f.wet[iz * f.nx + ix]! > 0;
  }

  const flowA: [number, number] = [0, 0];
  const flowB: [number, number] = [0, 0];
  /** Unit tangent of a polyline at point i: the mean of the segment directions meeting there. */
  function cornerTangent(points: readonly (readonly [number, number])[], i: number, out: [number, number]): void {
    const last = points.length - 1;
    const p = points[i]!;
    const prev = points[Math.max(0, i - 1)]!;
    const next = points[Math.min(last, i + 1)]!;
    const l0 = Math.hypot(p[0] - prev[0], p[1] - prev[1]);
    const l1 = Math.hypot(next[0] - p[0], next[1] - p[1]);
    let tx = (l0 > 1e-6 ? (p[0] - prev[0]) / l0 : 0) + (l1 > 1e-6 ? (next[0] - p[0]) / l1 : 0);
    let tz = (l0 > 1e-6 ? (p[1] - prev[1]) / l0 : 0) + (l1 > 1e-6 ? (next[1] - p[1]) / l1 : 0);
    const l = Math.hypot(tx, tz);
    if (l > 1e-6) {
      tx /= l;
      tz /= l;
    }
    out[0] = tx;
    out[1] = tz;
  }

  function waterSurface(x: number, z: number, out: SurfaceSample): boolean {
    let lakeY = -Infinity;
    let lakeMaterial: string | undefined;
    let lakeOutside = false;
    for (const lake of bucketAt(lakes, x, z) as readonly LakeDoc[]) {
      const sd = lakeDistance(lake, x, z);
      // inside the traced outline always; past it only where the flood (its
      // reach included, dilated a cell) says the lake's water is
      if (lake.waterY > lakeY && (sd <= 0 || (sd <= lake.bank * LAKE_FLOOD_BANKS + LAKE_FLOOD_CELL && inLakeFlood(lake, x, z)))) {
        lakeOutside = sd > 0;
        lakeY = lake.waterY;
        lakeMaterial = lake.material;
      }
    }
    // a lake spilling over a fall ends exactly at the lip line
    const lipW = lakeY > -Infinity ? lipAt(x, z) : null;
    // (only its reach PAST the traced outline: the lake itself may curve on
    // beside the lip, and cutting it made a straight gash across open water)
    if (lipW && lipW.rel > 0 && lakeOutside && lakeY >= lipW.lip!.top - 0.5) lakeY = -Infinity;
    if (lakeY > -Infinity) {
      // a river through a lake is flush with it: the lake is the surface
      out.y = lakeY;
      out.material = lakeMaterial;
      out.flowX = 0;
      out.flowZ = 0;
      out.kind = "lake";
      out.floor = -Infinity;
      return true;
    }
    const count = nearestPerOwner(riverSegs, x, z, hits);
    let best = -1;
    let bestInside = Infinity;
    /** The upper level a point held beside a lip stands at (NaN: the channel's own). */
    let bestHeld = NaN;
    // the LOWEST bed of every channel reaching here: at a confluence the
    // tributary's bed stands over the trunk's, and the trunk is still water
    let floor = Infinity;
    for (let k = 0; k < count; k++) {
      const hit = hits[k]!;
      const river = riverDocs[hit.owner]!;
      const g = riverGeom[hit.owner];
      if (!river.water || Number.isNaN(hit.side) || !g) continue;
      const grow = river.taper > 0 ? smoothstep(0, river.taper, hit.along) : 1;
      if (grow < HEAD_WET) continue;
      const width = Number.isNaN(hit.width) ? river.width : hit.width;
      const half = (width / 2) * (0.2 + 0.8 * grow);
      let reach = half + riverBank(river, hit.width) * (0.35 + 0.65 * grow) * RIVER_WATER_REACH;
      // a crafted plunge pool fills its bowl (the carve and this read one shape)
      if (siteGorges.length > 0 && hit.distance > reach) {
        const pool = sitePoolReach(x, z, hit.owner);
        if (pool > reach) reach = pool;
      }
      if (hit.distance > reach) continue;
      // At a fall the water is the channel bed's width and no wider: the bank
      // reach there drapes the upper pool over whatever the ground beside the
      // lip does (on a scarp, falls away under it) in sloping sheets.
      // Either side of the lip line the water still stands where the ground
      // HOLDS it (no lower than that side's bed): a pool carved wider than
      // its channel (a crafted site's ledge, a plunge pool) was cut back to
      // the channel for 1.5 m before the lip and 4.5 m after it, and its sheet
      // ended in the air a metre or more over its own bed on both steps.
      // (THIS fall's lip, not lipAt's: the fall above's band reaches down
      // over this one and can be the nearer line across.) Such a point stands
      // at its side's level whichever segment is nearest (beside a bend the
      // lip segment itself is, and its level slopes).
      const narrowAt = g.falls.find((f) => hit.along > f.along - FALL_NARROW && hit.along < f.along + RIVER_FALL_LIP + FALL_NARROW);
      let held = NaN;
      if (hit.distance > half + 0.5 && narrowAt) {
        const lip = lipList.find((l) => l.owner === hit.owner && Math.abs(l.along - narrowAt.along) < 1e-6);
        if (!lip) continue;
        const upper = (x - lip.lx) * lip.dx + (z - lip.lz) * lip.dz < 0;
        if (height(x, z) < (upper ? lip.bedTop : lip.bedBottom) - 0.5) continue;
        held = upper ? lip.top : lip.bottom;
      }
      // past either END of the polyline is not this river's water: the next
      // piece, the lake, the sea or the parent river takes over there, and a
      // round cap at pool level would hang out over the drop beyond the end
      // beyond an END only when the end is the nearest point of the river: a
      // plane across the mouth tested on its own also cut away every stretch
      // upstream that the river curled back past
      const total = g.along[g.along.length - 1]!;
      if (g.capEnd && hit.along >= total - 0.05 && (x - g.ex) * g.edx + (z - g.ez) * g.edz > 0) continue;
      if (g.capStart && hit.along <= 0.05 && (x - g.sx) * g.sdx + (z - g.sz) * g.sdz > 0) continue;
      const inside = hit.distance - half;
      if (!Number.isNaN(hit.value) && hit.value < floor) floor = hit.value;
      if (inside < bestInside) {
        bestInside = inside;
        best = k;
        bestHeld = held;
      }
    }
    if (best < 0) return false;
    const hit = hits[best]!;
    const river = riverDocs[hit.owner]!;
    const seg = segmentAt(hit.owner, hit.along);
    const last = river.points.length - 1;
    const a = river.points[seg]!;
    const b = river.points[Math.min(seg + 1, last)]!;
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
    const surf = river.surfaceY!;
    const drop = Math.max(0, surf[seg]! - surf[Math.min(seg + 1, last)]!);
    // a still pool drifts, a rapid runs: speed from the local fall of the surface
    let speed = Math.min(3.5, 0.45 + 18 * (drop / len));
    // still off a lake, gathering pace over the first 40 m of the river: the
    // shader fades the still texture into the flowing one by this speed
    for (const lake of bucketAt(lakes, x, z) as readonly LakeDoc[]) {
      const d = lakeDistance(lake, x, z) - lake.bank * 0.75;
      speed *= smoothstep(0, 40, d);
    }
    // and quickening toward a fall's lip, so the water runs into the drop
    for (const f of riverGeom[hit.owner]!.falls) {
      const ahead = f.along - hit.along;
      if (ahead >= 0 && ahead < 30) speed = Math.max(speed, 0.6 + 2.6 * (1 - ahead / 30));
      // ...but not the last metre and a half: over 1.2 m/s the water material
      // froths (rapids), and that froth seen edge-on was a pale line along the
      // top of every curtain
      if (ahead >= 0 && ahead < 1.5) speed = Math.min(speed, 1.1);
    }
    // and CHURNING at the foot: the plunge pool runs white around where the
    // curtain lands (its foot is ~3 m past the lip line, the curtain's throw)
    // and for ~3 m on, broken up by the material's rapids froth, so the
    // dissolving sheet ends in whitewater instead of clear water
    for (const f of riverGeom[hit.owner]!.falls) {
      const past = hit.along - f.along;
      if (past > 0 && past < 3 + RIVER_FALL_LIP + 3.5) speed = Math.max(speed, 3.4 * (1 - smoothstep(RIVER_FALL_LIP + 3.5, RIVER_FALL_LIP + 7, past)));
    }
    out.y = hit.side;
    // a step at the lip line, not a slope across the lip segment — the line
    // of the lip this point is nearest along its OWN river: lipAt answers
    // the nearest line across, and on a cascade the band of the fall above
    // reaches down over this one, so the step failed there and the sloped
    // level of the lip segment hung a sheet metres over the plunge pool
    const stepAt = riverGeom[hit.owner]!.falls.find((f) => hit.along >= f.along - 0.5 && hit.along <= f.along + RIVER_FALL_LIP + 0.5);
    const lipS = stepAt ? lipList.find((l) => l.owner === hit.owner && Math.abs(l.along - stepAt.along) < 1e-6) : undefined;
    if (lipS) out.y = (x - lipS.lx) * lipS.dx + (z - lipS.lz) * lipS.dz < 0 ? lipS.top : lipS.bottom;
    if (!Number.isNaN(bestHeld)) out.y = bestHeld;
    // the heading turns smoothly through a bend: each segment's own direction
    // jumped 10-15 degrees at every sample point, and the water material's
    // scroll drew that as a hard diagonal seam down the river (a pale wedge
    // off the river-15 lake). Blend the corner tangents across the segment.
    const along = riverGeom[hit.owner]!.along;
    const span = seg + 1 <= last ? along[seg + 1]! - along[seg]! : 0;
    const t = span > 1e-6 ? Math.min(1, Math.max(0, (hit.along - along[seg]!) / span)) : 0;
    cornerTangent(river.points, seg, flowA);
    cornerTangent(river.points, Math.min(seg + 1, last), flowB);
    let hx = flowA[0] + (flowB[0] - flowA[0]) * t;
    let hz = flowA[1] + (flowB[1] - flowA[1]) * t;
    const hl = Math.hypot(hx, hz);
    if (hl > 1e-6) {
      hx /= hl;
      hz /= hl;
    } else {
      hx = (b[0] - a[0]) / len;
      hz = (b[1] - a[1]) / len;
    }
    out.flowX = hx * speed;
    out.flowZ = hz * speed;
    out.kind = "river";
    out.material = undefined;
    out.floor = floor === Infinity ? -Infinity : floor;
    return true;
  }

  function waterNear(x0: number, z0: number, x1: number, z1: number): boolean {
    if (lakes.all.length > 0 || riverSegs.all.length > 0) return true;
    for (let bz = Math.floor(z0 / BUCKET); bz <= Math.floor(z1 / BUCKET); bz++) {
      for (let bx = Math.floor(x0 / BUCKET); bx <= Math.floor(x1 / BUCKET); bx++) {
        const k = bucketKey(bx, bz);
        if (lakes.map.has(k)) return true;
        const segs = riverSegs.map.get(k);
        if (segs && segs.some((sg) => riverDocs[sg.owner]!.water)) return true;
      }
    }
    return false;
  }

  solveRiverBeds();
  refineRivers();
  riverFalls = findFalls();
  roadPaint = buildPaint();
  hasRoadPaint = roadPaint.map.size > 0;

  return {
    recipe,
    rivers: riverDocs,
    falls: riverFalls,
    voxelSize,
    surfaceCount,
    worldLimit,
    height,
    naturalHeight,
    density,
    slope,
    // copied out: climateAt returns a shared scratch object
    climate: (x, z) => {
      const c = climateAt(x, z, height(x, z));
      return { temperature: c.temperature, moisture: c.moisture };
    },
    zone: (x, z) => {
      zoneAtWarped(x, z);
      return { id: zoneName(), weights: Float32Array.from(zoneScratch) };
    },
    biome,
    splatAt,
    tintAt,
    surfaceAt,
    sampleBlock,
    heightRange,
    surfaceCast,
    featureClearance,
    waterY,
    waterSurface,
    waterNear,
    shoreDistance: (x, z) => (hasBounds ? shoreAt(x, z).distance : Infinity),
  };
}

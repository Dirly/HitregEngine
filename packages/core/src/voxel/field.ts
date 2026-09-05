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
 *   -> features: canyons -> lakes -> rivers -> towns -> roads
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
  type LakeDoc,
  type PatchDoc,
  type RiverDoc,
  type FillDoc,
  type RoadDoc,
  type TownDoc,
  type WorldRecipe,
  type ZoneAnchorDoc,
} from "./recipe.js";

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
  /** A river's widest point: the reach must cover the whole channel wherever its width varies. */
  const riverWidest = (r: RiverDoc): number => (r.widths && r.widths.length > 0 ? Math.max(r.width, ...r.widths) : r.width);
  // three banks: the cut band widens to that on a tall cut (applyFeatures)
  const riverReach = (r: RiverDoc): number => riverWidest(r) / 2 + r.bank * 3;
  /** The embankment band is only real when the doc carries both edge profiles; otherwise the shoulder is the reach. */
  const roadSmooth = (r: RoadDoc): number => (r.smooth > 0 && r.leftY && r.rightY ? r.smooth : 0);
  const roadReach = (i: number): number =>
    roadDocs[i]!.width / 2 + Math.max(roadDocs[i]!.shoulder + roadSmooth(roadDocs[i]!), roadDocs[i]!.surfaceEdge + 2);
  const canyonReach = (i: number): number => canyonDocs[i]!.width / 2 + canyonDocs[i]!.rim;
  const buildRiverSegs = (docs: readonly RiverDoc[]): FeatureBuckets<PolySegment> =>
    segmentBuckets(
      segmentsOf(
        docs,
        (r) => r.bedY,
        // per-point depths ride the side channel, the same on both sides
        (r) => (r.depths && r.depths.length === r.points.length ? [r.depths, r.depths] : [undefined, undefined]),
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
  const towns = makeBuckets<TownDoc>(recipe.features.towns, (tw) => [
    tw.center[0] - tw.radius - tw.falloff,
    tw.center[1] - tw.radius - tw.falloff,
    tw.center[0] + tw.radius + tw.falloff,
    tw.center[1] + tw.radius + tw.falloff,
  ]);
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
    riverDocs.length + canyonDocs.length + roadDocs.length + recipe.features.towns.length + lakeDocs.length + fillDocs.length > 0;
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
  // grass surface (the grass billboards) stops at the water
  for (const river of riverDocs) {
    const target = surfaceIndex(river.surface);
    if (target < 0) continue;
    for (let i = 0; i + 1 < river.points.length; i++) {
      const a = river.points[i]!;
      const b = river.points[i + 1]!;
      paintSegments.push({ ax: a[0], az: a[1], bx: b[0], bz: b[1], half: river.width / 2 + river.bank * 0.45, verge: river.surfaceEdge, target, targets: null });
    }
  }
  const roadPaint = makeBuckets<RoadSegment>(paintSegments, (s) => {
    const pad = s.half + s.verge + 2;
    return [Math.min(s.ax, s.bx) - pad, Math.min(s.az, s.bz) - pad, Math.max(s.ax, s.bx) + pad, Math.max(s.az, s.bz) + pad];
  });
  const hasRoadPaint = paintSegments.length > 0;
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
        const berm = lake.waterY + 0.4;
        if (out < berm && berm - out < 3) {
          const hold = smoothstep(lake.bank * 0.3, lake.bank * 0.6, sd) * (1 - smoothstep(lake.bank * 0.7, lake.bank, sd));
          out = out + (berm - out) * hold;
        }
      }
    }

    // How much of this column is under a LAKE, before the rivers have their
    // say: a river builds its floor everywhere except through standing water.
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
      const depth = Number.isNaN(hit.side) ? river.depth : hit.side;
      const full = Number.isNaN(hit.value) ? out - depth : hit.value;
      const bed = out + (full - out) * (0.15 + 0.85 * grow);
      // The cut eases at a SLOPE LIMIT, not over one bank width: a channel
      // cut six metres into a hillside used to climb back to the ground
      // over the same 17 m as a channel cut one metre into a meadow — a
      // canal with a cliff for a bank. The band widens to 2.5× the cut
      // height (capped at three banks, which is the bucket reach), so a deep
      // cut is a valley side at about 22°, not a wall.
      const cutHeight = Math.max(0, out - bed);
      const cutBand = Math.max(bank, Math.min(bank * 3, cutHeight * 2.5));
      if (hit.distance > half + cutBand) continue;
      const w = 1 - smoothstep(half, half + cutBand, hit.distance);
      if (w <= 0) continue;
      out = out + (Math.min(bed, out) - out) * w;
      // The floor AND the banks. A channel on a side slope had its downhill
      // bank below its own water surface — the carve only ever cut — so the
      // sheet's outer edge hung in the air over dry ground. The build target
      // is the channel's cross-section: the bed inside the half-width, rising
      // to a natural levee (the water surface plus a hand) by the waterline
      // and holding it to the edge of the band, where the ribbon has already
      // ended. Only built above the sea (a mouth's bed is under the ocean
      // plane) and only under wet reaches — a dry gully just gets its floor.
      if (!Number.isNaN(hit.value) && bed > recipe.seaLevel) {
        const wetReach = river.water && grow >= 0.5;
        const levee = bed + Math.max(0.4, depth * 0.7) + 0.4;
        const profile = wetReach ? bed + (levee - bed) * smoothstep(half, half + bank * 0.63, hit.distance) : bed;
        const hold = wetReach ? 1 - smoothstep(half + bank * 0.7, half + bank, hit.distance) : w;
        floor = Math.min(floor, profile);
        floorW = Math.max(floorW, hold);
      }
      // the waterline sits about two thirds of the way up the bank profile
      // (see chunk.ts, where the ribbon is cut to the same rule)
      if (grow >= 0.5 && river.water) wet = Math.max(wet, 1 - smoothstep(half + bank * 0.45, half + bank * 0.8, hit.distance));
    }
    // bounded: a bed metres above the ground is sediment filling a hollow;
    // a bed a hundred metres above it is bad data, and no river builds a dam
    if (floorW > 0 && floor > out) out = out + (Math.min(floor, out + RIVER_MAX_BUILD) - out) * floorW * (1 - lakeWet);
    if (waterStageOnly) return out;

    for (const town of bucketAt(towns, x, z) as readonly TownDoc[]) {
      const d = Math.sqrt((x - town.center[0]) ** 2 + (z - town.center[1]) ** 2);
      if (d > town.radius + town.falloff) continue;
      const w = (1 - smoothstep(town.radius, town.radius + town.falloff, d)) * town.flatten * (1 - wet);
      if (w <= 0) continue;
      const pad = town.groundY ?? out;
      out = out + (pad - out) * w;
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

    return out;
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
  function paintRoads(x: number, z: number, membership: Float32Array, out: Float32Array, offset: number): void {
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
    const w = 1 - smoothstep(half - verge * 0.2, half + verge, d);
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
  function paintLakes(x: number, z: number, out: Float32Array, offset: number): void {
    const near = bucketAt(lakes, x, z) as readonly LakeDoc[];
    for (let i = 0; i < near.length; i++) {
      const lake = near[i]!;
      const target = lakePaintTargets[lakeDocs.indexOf(lake)]!;
      if (target < 0) continue;
      const sd = lakeDistance(lake, x, z);
      if (sd > lake.shore + 2) continue;
      const d = sd + fbm2(vergeSpec, x, z, seed) * Math.min(2, lake.shore * 0.4 + 0.4);
      const w = 1 - smoothstep(lake.shore * 0.35, lake.shore, d);
      if (w <= 0.002) continue;
      for (let s = 0; s < surfaceCount; s++) {
        const cur = out[offset + s]!;
        out[offset + s] = cur + ((s === target ? 1 : 0) - cur) * w;
      }
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
    if (hasLakePaint) paintLakes(x, z, out, offset);
    // roads last: a track worn through the ground wins over the mottling it
    // was worn through
    if (hasRoadPaint) paintRoads(x, z, membership, out, offset);
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
      best = Math.min(best, Math.sqrt((x - town.center[0]) ** 2 + (z - town.center[1]) ** 2) - town.radius);
    }
    return best;
  }

  /** Surface height of a river's water over its bed: most of the LOCAL channel depth, never above the banks. */
  function riverSurface(river: RiverDoc, bed: number, depth: number): number {
    return bed + Math.max(0.4, (Number.isNaN(depth) ? river.depth : depth) * 0.7);
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
      const reach = (width / 2) * (0.2 + 0.8 * grow) + riverBank(river, hit.width) * (0.35 + 0.65 * grow) * 0.63;
      if (Number.isNaN(hit.value) || hit.distance > reach || grow < 0.5) continue;
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
  solveRiverBeds();

  /** The doc with its points resampled along a centripetal Catmull-Rom spline through them. */
  function splineRiver(river: RiverDoc): RiverDoc {
    const pts = river.points;
    const n = pts.length;
    if (n < 3) return river;
    const spacing = Math.max(6, river.width * 0.5);
    const widths = river.widths && river.widths.length === n ? river.widths : null;
    const depths = river.depths && river.depths.length === n ? river.depths : null;
    const outPts: [number, number][] = [];
    const outW: number[] = [];
    const outD: number[] = [];
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
      }
    }
    outPts.push([pts[n - 1]![0], pts[n - 1]![1]]);
    if (widths) outW.push(widths[n - 1]!);
    if (depths) outD.push(depths[n - 1]!);
    return { ...river, points: outPts, ...(widths ? { widths: outW } : {}), ...(depths ? { depths: outD } : {}) };
  }

  return {
    recipe,
    rivers: riverDocs,
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
    shoreDistance: (x, z) => (hasBounds ? shoreAt(x, z).distance : Infinity),
  };
}

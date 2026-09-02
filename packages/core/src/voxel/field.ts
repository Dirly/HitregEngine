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
 * Feature order is fixed and matters:
 *   natural noise -> rivers carve -> towns flatten -> roads grade
 * so a road entering a town lands on the town's pad, and a town sited on a
 * river fills the river rather than being cut in half by it.
 */

import type { Vec3 } from "../math.js";
import { clamp, fbm2, fbm3, smoothstep, type FbmSpec } from "./noise.js";
import {
  type BiomeDoc,
  type BlobDoc,
  type CanyonDoc,
  type PatchDoc,
  type RiverDoc,
  type RoadDoc,
  type TownDoc,
  type WorldRecipe,
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
): PolylineHit {
  let best = Infinity;
  let bestSeg = 0;
  let bestT = 0;
  for (let i = 0; i + 1 < points.length; i++) {
    const a = points[i]!;
    const b = points[i + 1]!;
    const dx = b[0] - a[0];
    const dz = b[1] - a[1];
    const lenSq = dx * dx + dz * dz;
    const t = lenSq < 1e-12 ? 0 : clamp(((x - a[0]) * dx + (z - a[1]) * dz) / lenSq, 0, 1);
    const px = a[0] + dx * t;
    const pz = a[1] + dz * t;
    const d = Math.hypot(x - px, z - pz);
    if (d < best) {
      best = d;
      bestSeg = i;
      bestT = t;
    }
  }
  return { distance: best, segment: bestSeg, t: bestT };
}

/** Value sampled along a polyline's per-point array at a {@link PolylineHit}. */
function alongPolyline(values: readonly number[] | undefined, hit: PolylineHit): number | null {
  if (!values || values.length === 0) return null;
  const a = values[Math.min(hit.segment, values.length - 1)]!;
  const b = values[Math.min(hit.segment + 1, values.length - 1)]!;
  return a + (b - a) * hit.t;
}

// ------------------------------------------------------- feature broad phase
//
// A finished world can hold hundreds of river/road segments and dozens of
// towns, and `height()` is called millions of times per chunk. Testing every
// feature per sample is the difference between a chunk in 8ms and a chunk in
// 3 seconds, so features are bucketed into a uniform XZ grid by their
// influence footprint and only the local bucket is ever consulted.

const BUCKET = 96;

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

// -------------------------------------------------------------------- biomes

/** What the world looks like at one point: which biomes, and the splat mix. */
export interface BiomeSample {
  /** Strongest-matching biome id — the label scatter rules and tools filter on. */
  id: string;
  /** Per-biome membership, same order as `recipe.biomes`, normalized to sum 1. */
  weights: Float32Array;
  /** Splat weights over `recipe.surfaces` (exactly `surfaces.length` long), summing to 1. */
  surface: Float32Array;
  temperature: number;
  moisture: number;
  slope: number;
}

/** Smooth membership of `v` in `[min, max]` with `blend` soft edges. */
function window(v: number, range: readonly [number, number] | undefined, blend: number): number {
  if (!range) return 1;
  const b = Math.max(blend, 1e-6);
  const lo = smoothstep(range[0] - b, range[0] + b, v);
  const hi = 1 - smoothstep(range[1] - b, range[1] + b, v);
  return lo * hi;
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
  /** Ground height at (x, z) with every 2D feature applied. */
  height(x: number, z: number): number;
  /** Ground height from the noise bands ALONE — what the land would be with no rivers/roads/towns. */
  naturalHeight(x: number, z: number): number;
  /** Signed density; negative is solid. */
  density(x: number, y: number, z: number): number;
  /** Steepness at (x, z): 0 flat, 1 vertical. */
  slope(x: number, z: number): number;
  climate(x: number, z: number): { temperature: number; moisture: number };
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
  /** Distance to the nearest river/road/town edge — what `scatter.clearance` tests. */
  featureClearance(x: number, z: number): number;
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

  // Continents. Absent (the default) the world is the endless noise field it
  // has always been, so adding this to the schema changes no existing world.
  const continents = recipe.bounds?.continents ?? [];
  const hasBounds = continents.length > 0;
  const oceanFloor = recipe.bounds?.oceanFloor ?? -45;
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

  const rivers = makeBuckets<RiverDoc>(recipe.features.rivers, (r) => polylineBounds(r.points, r.width / 2 + r.bank + 2));
  const canyons = makeBuckets<CanyonDoc>(recipe.features.canyons, (c) => polylineBounds(c.points, c.width / 2 + c.rim + 2));
  // the road's footprint is the WIDER of its grading shoulder and its painted
  // verge — a road that paints further than it grades must still be found here
  const roads = makeBuckets<RoadDoc>(recipe.features.roads, (r) =>
    polylineBounds(r.points, r.width / 2 + Math.max(r.shoulder, r.surfaceEdge + 2) + 2),
  );
  const towns = makeBuckets<TownDoc>(recipe.features.towns, (tw) => [
    tw.center[0] - tw.radius - tw.falloff,
    tw.center[1] - tw.radius - tw.falloff,
    tw.center[0] + tw.radius + tw.falloff,
    tw.center[1] + tw.radius + tw.falloff,
  ]);
  /** Widest the blob ever gets — a taper may widen upward as well as narrow. */
  const blobReach = (b: BlobDoc): number => Math.max(b.radius, b.topRadius ?? b.radius);
  const blobs = makeBuckets<BlobDoc>(recipe.features.blobs, (b) => [
    b.center[0] - blobReach(b) * b.scaleX - b.falloff,
    b.center[2] - blobReach(b) * b.scaleZ - b.falloff,
    b.center[0] + blobReach(b) * b.scaleX + b.falloff,
    b.center[2] + blobReach(b) * b.scaleZ + b.falloff,
  ]);
  const hasFeatures =
    recipe.features.rivers.length +
      recipe.features.canyons.length +
      recipe.features.roads.length +
      recipe.features.towns.length >
    0;
  const hasBlobs = recipe.features.blobs.length > 0;

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
  // Bucketed as SEGMENTS, not as whole roads — the same lesson the tunnels
  // taught. `nearestOnPolyline` walks every control point of a road, which is
  // affordable once per column in `applyFeatures` and ruinous once per mesh
  // VERTEX: a 200-point road crossing a cell costs 200 distance tests per
  // vertex to discover that 198 of them were nowhere near.
  interface RoadSegment {
    ax: number;
    az: number;
    bx: number;
    bz: number;
    half: number;
    verge: number;
    target: number;
  }
  const paintSegments: RoadSegment[] = [];
  for (const road of recipe.features.roads) {
    const target = surfaceIndex(road.surface);
    if (target < 0) continue;
    for (let i = 0; i + 1 < road.points.length; i++) {
      const a = road.points[i]!;
      const b = road.points[i + 1]!;
      paintSegments.push({ ax: a[0], az: a[1], bx: b[0], bz: b[1], half: road.width / 2, verge: road.surfaceEdge, target });
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

  function naturalHeight(x: number, z: number): number {
    const wx = x + (t.warp.strength > 0 ? fbm2(warpA, x, z, seed) : 0);
    const wz = z + (t.warp.strength > 0 ? fbm2(warpB, x + 137.5, z - 91.25, seed) : 0);
    let h = t.base;
    h += fbm2(continent, wx, wz, seed);
    h += fbm2(hills, wx, wz, seed);
    if (t.mountains.amplitude !== 0) {
      // the mask is what keeps ridged noise from putting a peak in every field
      const raw = fbm2(maskSpec, wx, wz, seed) * 0.5 + 0.5;
      const mask = smoothstep(t.mountainMask.start, t.mountainMask.end, raw);
      if (mask > 0) {
        let relief = fbm2(mountains, wx, wz, seed) * mask;
        if (hasCliffs) relief = terraceAt(relief, wx, wz, mask);
        h += relief;
      }
    }
    h += fbm2(detail, wx, wz, seed);
    if (hasDunes) h += duneAt(x, z);
    if (hasCoastCliffs) h = coastAt(x, z, h);
    // LAST, so it governs every band above it: a mountain that strays past the
    // coast is pulled under with everything else rather than standing offshore.
    if (hasBounds) h = boundAt(x, z, h);
    return h;
  }

  /**
   * Continent mask: 1 well inland, 0 in open ocean, with the coast somewhere
   * in the falloff band.
   *
   * The distance to a landmass is DISPLACED by noise before it is compared to
   * the radius, rather than the height being blended with noise afterwards.
   * That distinction is the whole look: displacing the distance moves the
   * coastline itself, giving headlands and bays that the terrain then drapes
   * over; blending afterwards would just make a fuzzy circular beach.
   *
   * `max` over the continents (not a sum) so two landmasses that overlap merge
   * into one coast instead of building a ridge of doubled height between them.
   */
  function continentMask(x: number, z: number): number {
    let best = 0;
    for (let i = 0; i < continents.length; i++) {
      const c = continents[i]!;
      const dx = x - c.center[0];
      const dz = z - c.center[1];
      let d = Math.hypot(dx, dz);
      if (c.warp > 0) d += fbm2(coastWarpSpecs[i]!, x, z, seed) * c.falloff * c.warp;
      // 1 inside `radius`, 0 by `radius + falloff`
      const m = smoothstep(c.radius + c.falloff, c.radius, d);
      if (m > best) best = m;
      if (best >= 1) break;
    }
    return best;
  }

  function boundAt(x: number, z: number, h: number): number {
    const m = continentMask(x, z);
    if (m >= 1) return h;
    if (m <= 0) return oceanFloor;
    return oceanFloor + (h - oceanFloor) * m;
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
      mountain *
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
    const shaped = clamp((t - band - 0.5) / (1 - cliffs.sharpness) + 0.5, 0, 1);
    const terraced = (band + shaped) * step - offset;
    return relief + (terraced - relief) * m;
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
   * The desert's own landform: ridged, stretched crests, masked to the same
   * climate window the desert BIOME uses so the sand and the dunes arrive
   * together rather than sliding past each other.
   *
   * Read from the UNWARPED coordinates, like the climate is, and without the
   * lapse-rate correction — which is unavailable here by construction, since
   * the whole point is that this runs before the height it would need. That
   * only matters on high ground, and the height window on the desert rule is
   * what keeps dunes off the mountains anyway.
   */
  function duneAt(x: number, z: number): number {
    const temp = spread(fbm2(duneTempSpec, x, z, seed) * 0.5 + 0.5);
    const moist = spread(fbm2(duneMoistSpec, x, z, seed) * 0.5 + 0.5);
    const mask = window(temp, dunes.temperature, dunes.blend) * window(moist, dunes.moisture, dunes.blend);
    if (mask <= 0.002) return 0;
    // rotate into the wind frame, then compress ACROSS it: the noise is
    // traversed slowly along the ridge axis and quickly across it, which is
    // the whole difference between dunes and lumps
    const rx = (x * duneCos - z * duneSin) / dunes.stretch;
    const rz = x * duneSin + z * duneCos;
    return fbm2(duneSpec, rx, rz, seed) * mask;
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
    for (const canyon of bucketAt(canyons, x, z) as readonly CanyonDoc[]) {
      const half = canyon.width / 2;
      const hit = nearestOnPolyline(canyon.points, x, z);
      if (hit.distance > half + canyon.rim) continue;
      const floorY = alongPolyline(canyon.floorY, hit);
      const floor = floorY === null ? out - canyon.depth : floorY;
      const t01 = canyon.rim <= 0 ? 1 : clamp((hit.distance - half) / canyon.rim, 0, 1);
      const carved = floor + (out - floor) * terrace(t01, canyon.steps, canyon.stepSharpness);
      // a canyon only ever cuts down; it must not build a wall where the
      // surrounding land already sits below its floor
      if (carved < out) out = carved;
    }

    for (const river of bucketAt(rivers, x, z) as readonly RiverDoc[]) {
      const half = river.width / 2;
      const hit = nearestOnPolyline(river.points, x, z);
      if (hit.distance > half + river.bank) continue;
      const w = 1 - smoothstep(half, half + river.bank, hit.distance);
      if (w <= 0) continue;
      const bedY = alongPolyline(river.bedY, hit);
      const bed = bedY === null ? out - river.depth : bedY;
      // never RAISE land to meet a bed: a river cuts, it does not build
      out = out + (Math.min(bed, out) - out) * w;
    }

    for (const town of bucketAt(towns, x, z) as readonly TownDoc[]) {
      const d = Math.hypot(x - town.center[0], z - town.center[1]);
      if (d > town.radius + town.falloff) continue;
      const w = (1 - smoothstep(town.radius, town.radius + town.falloff, d)) * town.flatten;
      if (w <= 0) continue;
      const pad = town.groundY ?? out;
      out = out + (pad - out) * w;
    }

    for (const road of bucketAt(roads, x, z) as readonly RoadDoc[]) {
      const half = road.width / 2;
      const hit = nearestOnPolyline(road.points, x, z);
      if (hit.distance > half + road.shoulder) continue;
      const w = (1 - smoothstep(half, half + road.shoulder, hit.distance)) * road.flatten;
      if (w <= 0) continue;
      const surfaceY = alongPolyline(road.surfaceY, hit);
      if (surfaceY === null) continue; // an ungraded road has no height to impose
      out = out + (surfaceY - out) * w;
    }

    return out;
  }

  function height(x: number, z: number): number {
    return applyFeatures(naturalHeight(x, z), x, z);
  }

  function slopeFromHeights(hx0: number, hx1: number, hz0: number, hz1: number, e: number): number {
    const dx = (hx1 - hx0) / (2 * e);
    const dz = (hz1 - hz0) / (2 * e);
    const g = Math.hypot(dx, dz);
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
    let temperature = spread(fbm2(tempSpec, sx, sz, seed) * 0.5 + 0.5);
    let moisture = spread(fbm2(moistSpec, sx, sz, seed) * 0.5 + 0.5);
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

  /** Membership of every biome rule at a point. Shared by `biome` and `splatAt`. */
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
  function paintRoads(x: number, z: number, out: Float32Array, offset: number): void {
    const near = bucketAt(roadPaint, x, z);
    if (near.length === 0) return;
    // nearest point on the nearest segment, and the verge that segment carries
    let best = Infinity;
    let target = -1;
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
    for (let s = 0; s < surfaceCount; s++) {
      const cur = out[offset + s]!;
      out[offset + s] = cur + ((s === target ? 1 : 0) - cur) * w;
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
    // roads last: a track worn through the ground wins over the mottling it
    // was worn through
    if (hasRoadPaint) paintRoads(x, z, out, offset);
  }

  function biome(x: number, z: number, groundY?: number, steepness?: number): BiomeSample {
    const g = groundY ?? height(x, z);
    const steep = steepness ?? slope(x, z);
    const { temperature, moisture, heightOffset } = climateAt(x, z, g);
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
    return { id: recipe.biomes[bestIndex]!.id, weights, surface, temperature, moisture, slope: steep };
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
          const g = Math.hypot(dx, dz);
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
    for (const river of bucketAt(rivers, x, z) as readonly RiverDoc[]) {
      best = Math.min(best, nearestOnPolyline(river.points, x, z).distance - river.width / 2);
    }
    for (const canyon of bucketAt(canyons, x, z) as readonly CanyonDoc[]) {
      best = Math.min(best, nearestOnPolyline(canyon.points, x, z).distance - canyon.width / 2);
    }
    for (const road of bucketAt(roads, x, z) as readonly RoadDoc[]) {
      best = Math.min(best, nearestOnPolyline(road.points, x, z).distance - road.width / 2);
    }
    // Additive blobs stand ABOVE the heightfield, and scatter stands props on
    // the heightfield — so without this a monolith gets a ring of boulders and
    // shrubs buried inside it, and any prop under it is entombed.
    for (const blob of bucketAt(blobs, x, z) as readonly BlobDoc[]) {
      if (blob.op !== "add") continue;
      const reach = blobReach(blob) * Math.max(blob.scaleX, blob.scaleZ) + blob.falloff;
      best = Math.min(best, Math.hypot(x - blob.center[0], z - blob.center[2]) - reach);
    }
    for (const town of bucketAt(towns, x, z) as readonly TownDoc[]) {
      best = Math.min(best, Math.hypot(x - town.center[0], z - town.center[1]) - town.radius);
    }
    return best;
  }

  return {
    recipe,
    voxelSize,
    surfaceCount,
    height,
    naturalHeight,
    density,
    slope,
    // copied out: climateAt returns a shared scratch object
    climate: (x, z) => {
      const c = climateAt(x, z, height(x, z));
      return { temperature: c.temperature, moisture: c.moisture };
    },
    biome,
    splatAt,
    tintAt,
    surfaceAt,
    sampleBlock,
    heightRange,
    surfaceCast,
    featureClearance,
  };
}

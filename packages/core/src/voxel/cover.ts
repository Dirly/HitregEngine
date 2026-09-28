/**
 * Ground-cover gates that need the WORLD to answer: patches, water and the
 * per-instance keep hash. The render package places cover and cannot know
 * what a biome or a lake is; every host that grows cover on a generated world
 * (the editor, the published runtime, the `worldgen cover` audit) asks these,
 * so a layer grows in the same places wherever it is looked at.
 *
 * Order matters for cost, and every host follows it: the clump mask is one
 * fBm lookup and runs FIRST, before anything that evaluates the height field
 * (the same lesson as scatter's clump — a patched layer authors a higher
 * peak density, so a late mask makes every rejected candidate cost more than
 * the blade it did not place).
 */
import type { GrassComponentData } from "../components/core.js";
import { fbm2, smoothstep, type FbmSpec } from "./noise.js";
import type { SurfaceSample, WorldField } from "./field.js";

type CoverClump = NonNullable<GrassComponentData["clump"]>;
type CoverWater = NonNullable<GrassComponentData["water"]>;

/** The parts of a cover layer these gates read. */
export interface CoverGateLayer {
  clump?: CoverClump;
  water?: CoverWater;
  biomes?: readonly string[];
  /** Card height and size jitter: a `bed` layer must fit UNDER the water. */
  bladeHeight?: number;
  scaleRange?: readonly [number, number];
}

const clumpSpecs = new WeakMap<CoverClump, FbmSpec>();

/**
 * Fraction of the layer's density that survives at (x, z): 1 with no clump,
 * `floor` between patches, rising to 1 inside one.
 */
export function coverClumpKeep(clump: CoverClump | undefined, worldSeed: number, x: number, z: number): number {
  if (!clump) return 1;
  let spec = clumpSpecs.get(clump);
  if (!spec) {
    spec = {
      frequency: clump.frequency,
      amplitude: 1,
      octaves: clump.octaves,
      lacunarity: 2,
      gain: 0.5,
      ridged: false,
      // offset from scatter's clump seeds so a cover patch and a tree grove
      // with the same numbers are not the same shape
      seed: clump.seed + 7331,
    };
    clumpSpecs.set(clump, spec);
  }
  const mask = smoothstep(clump.threshold, clump.threshold + Math.max(1e-4, clump.blend), fbm2(spec, x, z, worldSeed));
  return clump.floor + (1 - clump.floor) * mask;
}

/**
 * Deterministic [0, 1) from a world position — the survivor pick for a
 * thinned layer. Cover positions are jittered lattice points, unique per
 * cell, so hashing the position is hashing the cell.
 */
export function coverKeepHash(x: number, z: number, salt: number): number {
  let h = Math.imul(Math.round(x * 64) | 0, 0x27d4eb2d) ^ Math.imul(Math.round(z * 64) | 0, 0x165667b1) ^ Math.imul(salt | 0, 0x9e3779b1);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

/** True when the clump mask drops the candidate at (x, z). */
export function coverClumpRejects(layer: CoverGateLayer, worldSeed: number, x: number, z: number): boolean {
  if (!layer.clump) return false;
  const keep = coverClumpKeep(layer.clump, worldSeed, x, z);
  return keep < 1 && coverKeepHash(x, z, 0x51ed + layer.clump.seed) >= keep;
}

/** Reusable scratch for the water gates — one per host, not one per query. */
export function coverScratch(): SurfaceSample {
  return { y: 0, flowX: 0, flowZ: 0, kind: "lake", floor: 0 };
}

/** Ring offsets a shore search samples, as fractions of `reach`. */
const SHORE_RING: readonly (readonly [number, number])[] = (() => {
  const out: [number, number][] = [[0, 0]];
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2;
    out.push([Math.cos(a), Math.sin(a)]);
  }
  for (let i = 0; i < 4; i++) {
    const a = ((i + 0.5) / 4) * Math.PI * 2;
    out.push([Math.cos(a) * 0.5, Math.sin(a) * 0.5]);
  }
  return out;
})();

/**
 * Height of the highest water of the allowed kinds within `reach` of (x, z),
 * or NaN when there is none. A shore layer compares the ground to this.
 *
 * Lakes and rivers are found by sampling `waterSurface` on a ring — after a
 * bucket test (`waterNear`) that rejects dry country for the price of a map
 * lookup, which is almost every candidate. The sea is `shoreDistance`, exact
 * and only asked when the layer allows the sea.
 */
export function coverWaterLevel(
  field: WorldField,
  x: number,
  z: number,
  reach: number,
  kinds: readonly string[],
  scratch: SurfaceSample,
): number {
  let level = Number.NaN;
  const lakes = kinds.includes("lake");
  const rivers = kinds.includes("river");
  if ((lakes || rivers) && field.waterNear(x - reach, z - reach, x + reach, z + reach)) {
    for (const [ox, oz] of SHORE_RING) {
      if (!field.waterSurface(x + ox * reach, z + oz * reach, scratch)) continue;
      if (scratch.kind === "lake" ? !lakes : !rivers) continue;
      if (Number.isNaN(level) || scratch.y > level) level = scratch.y;
    }
  }
  if (kinds.includes("sea") && field.shoreDistance(x, z) <= reach) {
    const sea = field.recipe.seaLevel;
    if (Number.isNaN(level) || sea > level) level = sea;
  }
  return level;
}

/**
 * The water rule for one candidate: where to put it (a height), or null.
 *
 * - No `water` on the layer: cover never grows in the sea, a lake or a river.
 * - `shore`: ground must sit inside `level` of the nearest allowed water.
 * - `surface`: the candidate floats on the water, which must be `depth` deep
 *   and, for a river, slower than `maxFlow`.
 *
 * `ground` is the height the host already resolved for the blade (sink
 * included); `bed` is the terrain height itself, for the depth test.
 * `shoreLevel`, when given, is the `shore` water line the host already
 * found (NaN = none) — see the probe cache in the playground's sampler;
 * without it the ring is sampled here.
 */
export function coverWaterGate(
  field: WorldField,
  layer: CoverGateLayer,
  x: number,
  z: number,
  ground: number,
  bed: number,
  scratch: SurfaceSample,
  shoreLevel?: number,
): number | null {
  const water = layer.water;
  const sea = field.recipe.seaLevel;
  if (!water) {
    if (bed <= sea) return null; // nothing grows in the sea
    // nor in a river or a lake. NOT `waterY`: that re-evaluates the ground
    // height (6 us, as much as the rest of the gate put together) to answer a
    // sea question the bed above already answered. The bucket test rejects
    // dry country for 0.15 us, and only a candidate near water asks the sheet.
    if (field.waterNear(x - 0.5, z - 0.5, x + 0.5, z + 0.5) && field.waterSurface(x, z, scratch) && bed < scratch.y + 0.25) {
      return null;
    }
    return ground;
  }
  if (water.mode === "bed") {
    // under the water: the sheet must cover this point, deep enough to be
    // under it and shallow enough to see; a torrent grows nothing
    if (!field.waterSurface(x, z, scratch)) return null;
    const allowed = scratch.kind === "lake" ? water.kinds.includes("lake") : water.kinds.includes("river");
    if (!allowed || Math.hypot(scratch.flowX, scratch.flowZ) > water.maxFlow) return null;
    const depth = scratch.y - bed;
    // the tallest card this layer can draw must stay under the sheet, or the
    // weed tips poke out of the shallows like reeds
    const top = (layer.bladeHeight ?? 0) * (layer.scaleRange?.[1] ?? 1.3) + 0.15;
    if (depth < Math.max(water.depth[0], top) || depth > water.depth[1]) return null;
    return ground;
  }
  if (water.mode === "surface") {
    let surface = Number.NaN;
    if (field.waterSurface(x, z, scratch)) {
      const allowed = scratch.kind === "lake" ? water.kinds.includes("lake") : water.kinds.includes("river");
      const flow = Math.hypot(scratch.flowX, scratch.flowZ);
      if (allowed && flow <= water.maxFlow) surface = scratch.y;
    } else if (water.kinds.includes("sea") && bed < sea) {
      surface = sea;
    }
    if (Number.isNaN(surface)) return null;
    const depth = surface - bed;
    if (depth < water.depth[0] || depth > water.depth[1]) return null;
    // a hand's breadth above the sheet, so the water's own ripple and wake
    // displacement do not poke through the pads
    return surface + 0.04;
  }
  const level = shoreLevel ?? coverWaterLevel(field, x, z, water.reach, water.kinds, scratch);
  if (Number.isNaN(level)) return null;
  const rel = bed - level;
  if (rel < water.level[0] || rel > water.level[1]) return null;
  return ground;
}

const edgeSpec: FbmSpec = { frequency: 0.22, amplitude: 1, octaves: 2, lacunarity: 2.3, gain: 0.5, ridged: false, seed: 4409 };

/**
 * The clearance a cover blade needs from a path, town or bank edge, with a
 * RAGGED edge: `base` plus up to `band` metres from smooth noise (a ~4.5 m
 * wavelength) and a little per-blade jitter. A single threshold on the
 * feature distance cut every layer along the exact offset curve of the road
 * — a hard, sharp-cornered line of grass that read as a stencil, not a verge.
 */
export function coverEdgeClearance(worldSeed: number, x: number, z: number, base: number, band = 1.8): number {
  const n = fbm2(edgeSpec, x, z, worldSeed) * 0.5 + 0.5; // ~0..1
  const jitter = coverKeepHash(x, z, 0x7e57);
  return base + band * Math.min(1, Math.max(0, n * 0.8 + jitter * 0.35 - 0.05));
}

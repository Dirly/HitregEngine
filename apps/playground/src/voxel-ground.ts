import type * as THREE from "three/webgpu";
import {
  coverClumpKeep,
  coverEdgeClearance,
  coverScratch,
  coverWaterGate,
  coverVegetationRejects,
  coverWaterLevel,
  editedGround,
  surfaceAliases,
  type CoverLayerDoc,
  type WorldField,
} from "@hitreg/core";
import type {
  CoverRegionTest,
  FoliageSampler,
  GrassData,
  GrassSystem,
  GrassTextureResolver,
  GroundSampler,
} from "@hitreg/render";

/**
 * Ground probes for a PROCEDURAL (voxel) world — the one cover sampler both
 * hosts use (the editor for its voxel half, the published runtime for all of
 * it), so a layer grows in the same places wherever it is looked at.
 *
 * `GrassSystem` scatters ground cover by asking two questions per candidate
 * point — "how high is the ground here?" and "may this layer grow here?" — and
 * the render package deliberately cannot answer either: it has no idea what a
 * biome, a lake or a splat weight is.
 *
 * Scope, stated plainly so nobody is surprised later: cover on an authored
 * `heightmap` mesh gets no blades from here — those tiles need the terrain
 * -splat blend weight the editor computes itself.
 */

/**
 * Terrain properties for the cover gate, on a COARSE lattice.
 *
 * The gate asks the world field three questions per blade: `slope`, `height`
 * and `splatAt`. Measured on the MMO world that is 25.4us a blade, and
 * `slope` alone is 18 of them because it is FOUR height evaluations around
 * the point. A grass layer at density 2.8 over a 42 m disc is ~20,000 of
 * those, so one full re-place was 386ms of sampling amortised at 2ms a frame.
 *
 * Slope and the surface mix come from noise bands and patch blotches tens of
 * metres across, and the terrain itself is a 2 m voxel isosurface, so there
 * is nothing under 2 m for them to resolve. Sampling them on a 2 m lattice
 * and bilinearly interpolating gives the same answer a hundred times cheaper
 * — bilinear rather than nearest so the gate's edge around a dirt patch is
 * still a curve, not a 2 m staircase.
 *
 * HEIGHT comes off the same lattice. The ground that is DRAWN is the 2 m
 * lattice interpolated (marching cubes), so the exact field height is the one
 * that floats: measured against the terrain collider, exact height is 3.3 cm
 * off the rendered ground on average and 107 cm at worst; bilinear on the
 * 2 m lattice is 1.1 cm and 28.8 cm.
 *
 * The BIOME is sampled per probe too, lazily (only once a layer names
 * biomes), and read from the nearest probe: a biome is a place hundreds of
 * metres across, and its edge is a blend anyway.
 */
const FOLIAGE_PROBE = 2;
/**
 * Fixed-size probe cache: ~9 discs' worth at the radii cover is authored
 * with, in flat buffers rather than an object per probe. Small allocations at
 * this rate show up in a profile as `off-loop` time — exactly the instrument
 * that would not explain why.
 */
const FOLIAGE_PROBE_LIMIT = 16384;
/** Biome slot not evaluated yet. */
const BIOME_UNKNOWN = -2;
/**
 * Spacing of the coarse biome lattice the region test reads. Biomes are
 * hundreds of metres across and blend over tens, so a 32 m lattice reading
 * membership WEIGHTS (not the winning id) still sees a biome's fringe.
 */
const REGION_PROBE = 32;
/** Membership weight of a layer's biomes at which a region may grow it. */
const REGION_MIN_WEIGHT = 0.02;
/**
 * Lattice for the region test's CLUMP check. A layer whose clumps leave bare
 * ground between them (`floor: 0`) and has no clump anywhere in the disc
 * grows nothing there, however right the biome is — measured: a wheat layer
 * walked 50,000 cells per recenter in grassland to place none. Clumps are
 * tens to hundreds of metres across; 16 m sees any worth drawing.
 */
const REGION_CLUMP_PROBE = 16;

export interface VoxelGroundProbes {
  /** World (x, z) -> ground height, or null when there is no world. */
  sampleGround: GroundSampler;
  /** Where one cover LAYER may grow, in world units, or null for "not here". */
  sampleCover: FoliageSampler;
  /** Drop every cached probe — the ground under them is not the ground any more. */
  invalidate(): void;
  /** Could a layer grow anywhere in a rectangle? Give it to `GrassSystem.regionTest`. */
  regionTest: CoverRegionTest;
}

/**
 * How far to sink a cover instance below the ground height at its centre.
 *
 * A billboard is a VERTICAL card standing on one sampled point, but it has
 * width: on a gradient its downhill edge lifts off the terrain and the tuft
 * appears to hover — the classic tell of scattered foliage. Sinking it by the
 * drop across its own half-width (`halfWidth * tan(angle)`) buries the uphill
 * edge instead, which nobody can see. The half-width uses the LARGEST scale
 * the layer jitters to, since the sampler is not told which instance is
 * asking: over-sinking a small tuft costs a centimetre of its base, while
 * under-sinking a large one floats it, and only one of those is visible.
 *
 * `steep` is sin(angle), so tan is sin/sqrt(1-sin^2) — clamped, because it
 * runs away toward vertical and no cover grows there anyway.
 */
export function foliageSink(data: GrassData, steep: number): number {
  const halfWidth = (data.bladeWidth / 2) * (data.scaleRange?.[1] ?? 1.3);
  const tan = Math.min(2, steep / Math.sqrt(Math.max(1e-4, 1 - steep * steep)));
  // plus a small constant bite so the base is always in the ground, not on it
  return halfWidth * tan + data.bladeHeight * 0.04;
}

/**
 * Build both probes against a world field.
 *
 * `field` is read through a getter rather than captured, so a caller that
 * re-registers the recipe (or switches scenes) gets the new field without
 * rebuilding the samplers; the probe cache notices the new field object and
 * drops itself.
 */
export function voxelGroundProbes(field: () => WorldField | null): VoxelGroundProbes {
  const probeSlot = new Map<number, number>();
  const probeKey = new Float64Array(FOLIAGE_PROBE_LIMIT).fill(NaN);
  const probeSlope = new Float32Array(FOLIAGE_PROBE_LIMIT);
  /** ground height per slot (Float64: world heights need the precision) */
  const probeHeight = new Float64Array(FOLIAGE_PROBE_LIMIT);
  /** 1 when the ground at that probe is above the sea and its splat mix is meaningful */
  const probeDry = new Uint8Array(FOLIAGE_PROBE_LIMIT);
  /**
   * 1 when a 3D carve (passage, tunnel, subtracting blob) changed the ground
   * at this probe or left it a lintel: the heightfield `bed` is not
   * the surface there, so no blade in the four lattice squares around it grows
   * (`editedGround` in core, the rule scatter props use too). Always 0 where
   * no carve reaches, which is what keeps unedited cover identical.
   */
  const probeCarved = new Uint8Array(FOLIAGE_PROBE_LIMIT);
  /** index into recipe.biomes, or BIOME_UNKNOWN */
  const probeBiome = new Int16Array(FOLIAGE_PROBE_LIMIT).fill(BIOME_UNKNOWN);
  let probeSplat = new Float32Array(0);
  let probeStride = 0;
  let probeNext = 0;
  let probeField: WorldField | null = null;
  /** Surface names resolved to palette indices ONCE per layer, not per blade. */
  const surfaceIndex = new WeakMap<GrassData, Int32Array>();
  /** Biome ids resolved to a membership mask over recipe.biomes, per layer. */
  const biomeMask = new WeakMap<GrassData, Uint8Array>();
  let biomeIndex = new Map<string, number>();
  const scratch = coverScratch();

  /**
   * Field height per lattice point, shared between neighbouring probes. A
   * probe's slope is a central difference over its four lattice neighbours,
   * so without this every height was evaluated five times over.
   */
  const latticeHeights = new Map<number, number>();
  function latticeHeight(f: WorldField, gx: number, gz: number): number {
    const key = gx * 4294967296 + (gz >>> 0);
    let y = latticeHeights.get(key);
    if (y === undefined) {
      if (latticeHeights.size >= 65536) latticeHeights.clear();
      y = f.height(gx * FOLIAGE_PROBE, gz * FOLIAGE_PROBE);
      latticeHeights.set(key, y);
    }
    return y;
  }

  /**
   * Shore water line per probe slot, per (reach, kinds) — NaN = not asked
   * yet, -Infinity = no water in reach. A shore layer's gate samples a ring
   * of 13 water queries; per BLADE that was 3 us and, beside a lake the
   * reeds never reach, 40,000 blades per recenter placing none. Per 2 m
   * probe, read from the nearest one with the reach widened by the probe's
   * half-diagonal so no blade the exact test would accept is lost.
   */
  const shoreLevels = new Map<string, Float64Array>();
  function shoreLevelAt(f: WorldField, slot: number, gx: number, gz: number, reach: number, kinds: readonly string[]): number {
    const key = `${reach}|${kinds.join(",")}`;
    let levels = shoreLevels.get(key);
    if (!levels) shoreLevels.set(key, (levels = new Float64Array(FOLIAGE_PROBE_LIMIT).fill(NaN)));
    let level = levels[slot]!;
    if (Number.isNaN(level)) {
      const found = coverWaterLevel(f, gx * FOLIAGE_PROBE, gz * FOLIAGE_PROBE, reach + FOLIAGE_PROBE * 0.71, kinds, scratch);
      level = Number.isNaN(found) ? -Infinity : found;
      levels[slot] = level;
    }
    return level === -Infinity ? NaN : level;
  }
  /** Biome membership weights on the coarse region lattice, by lattice key. */
  const regionWeights = new Map<number, Float32Array>();
  function invalidate(): void {
    regionWeights.clear();
    for (const levels of shoreLevels.values()) levels.fill(NaN);
    latticeHeights.clear();
    probeSlot.clear();
    probeKey.fill(NaN);
    probeBiome.fill(BIOME_UNKNOWN);
    probeNext = 0;
  }

  /** Slot holding the probe at lattice point (gx, gz), sampling it if absent. */
  function probeAt(f: WorldField, gx: number, gz: number): number {
    const key = gx * 4294967296 + (gz >>> 0);
    const found = probeSlot.get(key);
    if (found !== undefined) return found;
    // FIFO over the slots: the working set is the disc around the camera, so
    // the oldest slot is the ground furthest behind it, and a miss only costs
    // a resample
    const slot = probeNext;
    probeNext = (probeNext + 1) % FOLIAGE_PROBE_LIMIT;
    const evicted = probeKey[slot]!;
    if (!Number.isNaN(evicted)) probeSlot.delete(evicted);
    const x = gx * FOLIAGE_PROBE;
    const z = gz * FOLIAGE_PROBE;
    let steep: number;
    let y: number;
    if (Math.max(f.voxelSize, 0.5) === FOLIAGE_PROBE) {
      // exactly field.slope(x, z): the same four heights, the same formula
      y = latticeHeight(f, gx, gz);
      const dx = (latticeHeight(f, gx + 1, gz) - latticeHeight(f, gx - 1, gz)) / (2 * FOLIAGE_PROBE);
      const dz = (latticeHeight(f, gx, gz + 1) - latticeHeight(f, gx, gz - 1)) / (2 * FOLIAGE_PROBE);
      const g = Math.sqrt(dx * dx + dz * dz);
      steep = g / Math.sqrt(1 + g * g);
    } else {
      steep = f.slope(x, z);
      y = f.height(x, z);
    }
    probeSlope[slot] = steep;
    probeHeight[slot] = y;
    probeCarved[slot] = 0;
    if (f.carveSpan(x - FOLIAGE_PROBE, z - FOLIAGE_PROBE, x + FOLIAGE_PROBE, z + FOLIAGE_PROBE)) {
      // compared with `height`, because that is the bed a blade is given:
      // NOT with the ordinary `surfaceCast`, which sees a carve within its
      // few-metre window too and so agrees with the carved floor
      // a 1 m footing ring per probe: with radius 0 a blade beside a tunnel
      // mouth still hung 0.4 m over the mesh the 2 m lattice rounds into the
      // opening. Cost, measured over the Undercut: 185 us per probe whose
      // carve reaches the surface (58 without the ring), paid once per probe —
      // the probe cache keeps the answer — and nothing anywhere else.
      const real = editedGround(f, x, z, 1);
      probeCarved[slot] = real === null || (real !== undefined && Math.abs(real - y) > 0.3) ? 1 : 0;
    }
    probeBiome[slot] = BIOME_UNKNOWN;
    for (const levels of shoreLevels.values()) levels[slot] = NaN;
    const dry = y > f.recipe.seaLevel;
    probeDry[slot] = dry ? 1 : 0;
    if (dry) {
      // the vertex path's own normal convention, so the gate sees exactly the
      // weights the terrain shader is blending at that point
      f.splatAt(x, y, z, Math.sqrt(Math.max(0, 1 - steep * steep)), probeSplat, slot * probeStride);
    }
    probeKey[slot] = key;
    probeSlot.set(key, slot);
    return slot;
  }

  /** The biome at one probe, evaluated the first time a layer asks. */
  function probeBiomeAt(f: WorldField, slot: number, gx: number, gz: number): number {
    let b = probeBiome[slot]!;
    if (b === BIOME_UNKNOWN) {
      const id = f.biome(gx * FOLIAGE_PROBE, gz * FOLIAGE_PROBE, probeHeight[slot], probeSlope[slot]).id;
      b = biomeIndex.get(id) ?? -1;
      probeBiome[slot] = b;
    }
    return b;
  }

  /** How much of one layer's named surfaces this probe's ground is, in [0, 1]. */
  function probeWeight(slot: number, index: Int32Array): number {
    if (probeDry[slot] === 0) return 0; // under the sea: no cover, and the mix means nothing
    const base = slot * probeStride;
    let weight = 0;
    for (let i = 0; i < index.length; i++) {
      const s = index[i]!;
      if (s >= 0) weight += probeSplat[base + s] ?? 0;
    }
    return weight;
  }

  const sampleGround: GroundSampler = (x, z) => {
    const f = field();
    if (!f) return null;
    // surfaceCast is the honest answer (it walks the same isosurface the mesh
    // was polygonized from); `height` is the cheap analytic fallback for
    // columns the cast misses, e.g. under an overhang.
    return f.surfaceCast(x, z) ?? f.height(x, z);
  };

  /**
   * The gate, cheapest question first: the clump mask (one fBm lookup), the
   * biome (a cached probe), slope, water, clearance, and last the surface
   * mix. Gating on the SURFACE as well as the biome is what makes cover agree
   * with what you can see: a worn dirt patch inside a meadow grows no grass,
   * because the ground there is not grass, and no rule had to say so.
   */
  /** Adopt a (possibly new) field: drop everything cached about the old one. */
  function adopt(f: WorldField): void {
    if (f !== probeField) {
      // a recipe edit builds a new field object under the same id: every
      // cached probe is about terrain that no longer exists
      probeField = f;
      invalidate();
      biomeIndex = new Map(f.recipe.biomes.map((b, i) => [b.id, i]));
    }
    if (probeStride !== f.surfaceCount) {
      // stride FIRST: a cached slot indexes a buffer laid out for the palette
      // it was sampled with, so a world with a different one invalidates it
      probeStride = f.surfaceCount;
      probeSplat = new Float32Array(FOLIAGE_PROBE_LIMIT * probeStride);
      invalidate();
    }
  }

  /** The layer's biome ids as a membership mask over recipe.biomes. */
  function maskFor(f: WorldField, data: GrassData): Uint8Array {
    let mask = biomeMask.get(data);
    if (!mask || mask.length !== f.recipe.biomes.length) {
      mask = Uint8Array.from(f.recipe.biomes, (b) => (data.biomes!.includes(b.id) ? 1 : 0));
      biomeMask.set(data, mask);
    }
    return mask;
  }

  /** Does any clump of this layer reach into the rectangle? */
  function clumpInRegion(
    f: WorldField,
    clump: NonNullable<CoverGateData["clump"]>,
    x0: number,
    z0: number,
    x1: number,
    z1: number,
  ): boolean {
    for (let z = Math.floor(z0 / REGION_CLUMP_PROBE); z <= Math.ceil(z1 / REGION_CLUMP_PROBE); z++) {
      for (let x = Math.floor(x0 / REGION_CLUMP_PROBE); x <= Math.ceil(x1 / REGION_CLUMP_PROBE); x++) {
        if (coverClumpKeep(clump, f.recipe.seed, x * REGION_CLUMP_PROBE, z * REGION_CLUMP_PROBE) > 0.001) return true;
      }
    }
    return false;
  }

  const regionTest: CoverRegionTest = (x0, z0, x1, z1, data) => {
    const f = field();
    if (!f) return false;
    adopt(f);
    const water = (data as CoverGateData).water;
    if (water) {
      const reach = water.mode === "shore" ? water.reach : 0;
      const inland =
        (water.kinds.includes("lake") || water.kinds.includes("river")) &&
        f.waterNear(x0 - reach, z0 - reach, x1 + reach, z1 + reach);
      const half = Math.hypot(x1 - x0, z1 - z0) / 2 + reach;
      const sea = water.kinds.includes("sea") && f.shoreDistance((x0 + x1) / 2, (z0 + z1) / 2) < half;
      if (!inland && !sea) return false;
    }
    const clump = (data as CoverGateData).clump;
    if (clump && clump.floor === 0 && !clumpInRegion(f, clump, x0, z0, x1, z1)) return false;
    if (!data.biomes || data.biomes.length === 0) return true;
    const mask = maskFor(f, data);
    const gx0 = Math.floor(x0 / REGION_PROBE);
    const gx1 = Math.ceil(x1 / REGION_PROBE);
    const gz0 = Math.floor(z0 / REGION_PROBE);
    const gz1 = Math.ceil(z1 / REGION_PROBE);
    for (let gz = gz0; gz <= gz1; gz++) {
      for (let gx = gx0; gx <= gx1; gx++) {
        const key = gx * 4294967296 + (gz >>> 0);
        let weights = regionWeights.get(key);
        if (!weights) {
          if (regionWeights.size >= 16384) regionWeights.clear();
          weights = Float32Array.from(f.biome(gx * REGION_PROBE, gz * REGION_PROBE).weights);
          regionWeights.set(key, weights);
        }
        let w = 0;
        for (let i = 0; i < mask.length; i++) if (mask[i]) w += weights[i] ?? 0;
        if (w >= REGION_MIN_WEIGHT) return true;
      }
    }
    return false;
  };

  const sampleCover: FoliageSampler = (x, z, data) => {
    const f = field();
    if (!f) return null;
    adopt(f);
    // the layer's clump mask, region vegetation (a zone's or place's species and
    // density) and clearings: one gate, shared with every audit (core vegetation.ts)
    if (coverVegetationRejects(f.recipe, data as CoverGateData, x, z)) return null;
    const px = x / FOLIAGE_PROBE;
    const pz = z / FOLIAGE_PROBE;
    const gx = Math.floor(px);
    const gz = Math.floor(pz);
    const fx = px - gx;
    const fz = pz - gz;
    const s00 = probeAt(f, gx, gz);
    const s10 = probeAt(f, gx + 1, gz);
    const s01 = probeAt(f, gx, gz + 1);
    const s11 = probeAt(f, gx + 1, gz + 1);
    // a carve opened or moved the ground in this lattice square: the bed below
    // would be the heightfield's, standing in the air over it
    if (probeCarved[s00]! | probeCarved[s10]! | probeCarved[s01]! | probeCarved[s11]!) return null;
    if (data.biomes && data.biomes.length > 0) {
      const mask = maskFor(f, data);
      const nx = fx < 0.5 ? 0 : 1;
      const nz = fz < 0.5 ? 0 : 1;
      const slot = nx === 0 ? (nz === 0 ? s00 : s01) : nz === 0 ? s10 : s11;
      const b = probeBiomeAt(f, slot, gx + nx, gz + nz);
      if (b < 0 || mask[b] === 0) return null;
    }
    const w00 = (1 - fx) * (1 - fz);
    const w10 = fx * (1 - fz);
    const w01 = (1 - fx) * fz;
    const w11 = fx * fz;
    const water = (data as CoverGateData).water;
    const floating = water?.mode === "surface";
    const steep = probeSlope[s00]! * w00 + probeSlope[s10]! * w10 + probeSlope[s01]! * w01 + probeSlope[s11]! * w11;
    // a floating layer lies on the water, whatever the bed under it does
    if (!floating && steep > data.slopeMax) return null;
    const bed = probeHeight[s00]! * w00 + probeHeight[s10]! * w10 + probeHeight[s01]! * w01 + probeHeight[s11]! * w11;
    let shoreLevel: number | undefined;
    if (water?.mode === "shore") {
      const nx = fx < 0.5 ? 0 : 1;
      const nz = fz < 0.5 ? 0 : 1;
      const slot = nx === 0 ? (nz === 0 ? s00 : s01) : nz === 0 ? s10 : s11;
      shoreLevel = shoreLevelAt(f, slot, gx + nx, gz + nz, water.reach, water.kinds);
    }
    const placed = coverWaterGate(f, data as CoverGateData, x, z, bed - foliageSink(data, steep), bed, scratch, shoreLevel);
    if (placed === null) return null;
    // Cover respects the same town/road clearance as chunk scatter, including
    // the widest randomized card so its edge cannot enter a foundation — plus
    // a ragged band of noise, so the verge along a path meanders instead of
    // following the road's offset curve like a stencil. Water layers skip it:
    // a lake edge IS a feature edge, and they live there.
    if (!water) {
      const clear = f.featureClearance(x, z);
      const base = Math.max(0.5, data.bladeWidth * 0.65);
      // far from any feature (the common case) the noise is never evaluated
      if (clear < base + 1.8 && clear < coverEdgeClearance(f.recipe.seed, x, z, base)) return null;
    }
    if (floating || water?.mode === "bed" || data.surfaces.length === 0) return placed;
    let index = surfaceIndex.get(data);
    if (!index) {
      // a name also covers every zone surface that restyles it (a zone's own
      // grass still grows the grass layer), so this is a flat list of ids
      index = Int32Array.from(data.surfaces.flatMap((name) => surfaceAliases(f.recipe, name)));
      surfaceIndex.set(data, index);
    }
    const weight =
      probeWeight(s00, index) * w00 + probeWeight(s10, index) * w10 + probeWeight(s01, index) * w01 + probeWeight(s11, index) * w11;
    return weight >= data.minSurface ? placed : null;
  };

  return { sampleGround, sampleCover, invalidate, regionTest };
}

/** GrassData as the host sees it: the gates the renderer passes through opaquely. */
type CoverGateData = GrassData & Pick<CoverLayerDoc, "clump" | "water">;

/**
 * Keep a GrassSystem's WORLD cover in step with the active world's recipe.
 *
 * A generated world carries its own cover (`recipe.cover`); each layer is
 * registered as `cover:<id>` under `parent` (an identity-transform group in
 * the scene). Call it whenever the active field may have changed — a recipe
 * live-edit builds a new field object, which is what re-registers the
 * layers with their new data. Returns the field it synced to.
 */
export function syncWorldCover(
  grass: GrassSystem,
  parent: THREE.Object3D,
  f: WorldField | null,
  registered: Set<string>,
  resolveTexture: GrassTextureResolver,
): void {
  for (const id of registered) grass.unregister(id);
  registered.clear();
  if (!f) return;
  for (const layer of f.recipe.cover ?? []) {
    const id = `cover:${layer.id}`;
    grass.register(id, parent, layer as GrassData, resolveTexture);
    registered.add(id);
  }
}

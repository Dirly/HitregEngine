import type { WorldField } from "@hitreg/core";
import type { FoliageSampler, GrassData, GroundSampler } from "@hitreg/render";

/**
 * Ground probes for a PROCEDURAL (voxel) world, for the published runtime.
 *
 * `GrassSystem` scatters ground cover by asking two questions per candidate
 * point — "how high is the ground here?" and "may this layer grow here?" — and
 * the render package deliberately cannot answer either: it has no idea what a
 * biome or a splat weight is. The editor host answers them for both terrain
 * kinds (authored heightmap tiles AND generated worlds); a published game
 * whose terrain is generated only ever needs the second half, so that is all
 * this module implements.
 *
 * Scope, stated plainly so nobody is surprised later: cover on an authored
 * `heightmap` mesh gets no blades from here — those tiles need the terrain
 * -splat blend weight the editor computes. A scene that mixes a voxel world
 * with heightmap tiles will grow cover on the voxel half only.
 */

/**
 * How far to sink a cover instance below the ground height at its centre.
 *
 * A billboard is a VERTICAL card standing on one sampled point, but it has
 * width: on a gradient its downhill edge lifts off the terrain and the tuft
 * appears to hover — the classic tell of scattered foliage. Sinking it by the
 * drop across its own half-width (`halfWidth * tan(angle)`) buries the uphill
 * edge instead, which nobody can see. The half-width uses the LARGEST scale
 * the system jitters to (1.3), since the sampler is not told which instance is
 * asking: over-sinking a small tuft costs a centimetre of its base, while
 * under-sinking a large one floats it, and only one of those is visible.
 *
 * `steep` is sin(angle), so tan is sin/sqrt(1-sin^2) — clamped, because it
 * runs away toward vertical and no cover grows there anyway.
 */
function foliageSink(data: GrassData, steep: number): number {
  const halfWidth = (data.bladeWidth / 2) * 1.3;
  const tan = Math.min(2, steep / Math.sqrt(Math.max(1e-4, 1 - steep * steep)));
  // plus a small constant bite so the base is always in the ground, not on it
  return halfWidth * tan + data.bladeHeight * 0.04;
}

export interface VoxelGroundProbes {
  /** World (x, z) -> ground height, or null when there is no world. */
  sampleGround: GroundSampler;
  /** Where one cover LAYER may grow, in world units, or null for "not here". */
  sampleCover: FoliageSampler;
}

/**
 * Build both probes against a world field.
 *
 * `field` is read through a getter rather than captured, so a future caller
 * that re-registers the recipe (or switches scenes) gets the new field without
 * rebuilding the samplers.
 */
export function voxelGroundProbes(field: () => WorldField | null): VoxelGroundProbes {
  /** Splat scratch for the cover gate — one buffer, not one per query. */
  let splat = new Float32Array(0);

  const sampleGround: GroundSampler = (x, z) => {
    const f = field();
    if (!f) return null;
    // surfaceCast is the honest answer (it walks the same isosurface the mesh
    // was polygonized from); `height` is the cheap analytic fallback for
    // columns the cast misses, e.g. under an overhang.
    return f.surfaceCast(x, z) ?? f.height(x, z);
  };

  /**
   * Gating on the SURFACE rather than on the biome is what makes cover agree
   * with what you can see: a worn dirt patch inside a meadow grows no grass,
   * because the ground there is not grass, and no rule had to say so.
   */
  const sampleCover: FoliageSampler = (x, z, data) => {
    const f = field();
    if (!f) return null;
    const steep = f.slope(x, z);
    if (steep > data.slopeMax) return null;
    const ground = f.height(x, z) - foliageSink(data, steep);
    if (ground <= f.recipe.seaLevel) return null; // nothing grows in the sea
    if (data.surfaces.length === 0) return ground;
    if (splat.length < f.surfaceCount) splat = new Float32Array(f.surfaceCount);
    // the vertex path's own normal convention, so the gate sees exactly the
    // weights the terrain shader is blending at that point
    f.splatAt(x, ground, z, Math.sqrt(Math.max(0, 1 - steep * steep)), splat, 0);
    let weight = 0;
    for (const name of data.surfaces) {
      const index = f.recipe.surfaces.findIndex((s) => s.name.toLowerCase() === name.toLowerCase());
      if (index >= 0) weight += splat[index] ?? 0;
    }
    return weight >= data.minSurface ? ground : null;
  };

  return { sampleGround, sampleCover };
}

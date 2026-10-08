import { describe, expect, it } from "vitest";
import { buildVoxelMesh, createWorldField, defaultWorldRecipe, worldRecipeSchema, MAX_SURFACES } from "../src/index.js";

/**
 * A palette of 14+ surfaces makes the mesher's interleaved per-vertex stream
 * (`surfaceCount` splat weights + 3 tint) wider than 16 floats. The meshers
 * once computed it into a fixed 16-float scratch, so the tint fell off the end
 * of the typed array, came back NaN, and the terrain-splat material (which
 * multiplies by the tint) rendered the whole ground black — silently.
 */
function widePaletteRecipe() {
  const base = defaultWorldRecipe();
  const surfaces = [...base.surfaces];
  for (let i = surfaces.length; i < MAX_SURFACES; i++) {
    surfaces.push({ name: `extra${i}`, color: "#808080", roughness: 0.9, uvScale: 4 } as (typeof surfaces)[number]);
  }
  const last = surfaces.length - 1;
  const biomes = base.biomes.map((biome) => {
    const pad = (weights: number[] | undefined) => {
      if (!weights) return weights;
      const out = [...weights];
      while (out.length < surfaces.length) out.push(0);
      return out;
    };
    const surface = pad(biome.surface)!;
    // put real weight on the LAST surface, so a dropped tail would show up
    surface[last] = 1;
    return { ...biome, surface, cliff: pad(biome.cliff), tint: "#c08040" };
  });
  return worldRecipeSchema.parse({ ...base, cellSize: 32, resolution: 16, surfaces, biomes });
}

describe("voxel meshing with a 16-surface palette", () => {
  const field = createWorldField(widePaletteRecipe());

  for (const mesher of ["mc", "dc"] as const) {
    it(`${mesher}: every vertex keeps a finite tint and intact splat weights`, () => {
      expect(field.recipe.surfaces.length).toBe(16);
      const mesh = buildVoxelMesh(field, { kind: "voxel", world: "w", cell: [3, -2], mesher });
      expect(mesh.triangleCount).toBeGreaterThan(0);
      expect(mesh.surfaceCount).toBe(16);
      expect(mesh.tint.length).toBe(mesh.vertexCount * 3);
      expect(mesh.splat.length).toBe(mesh.vertexCount * 16);
      let lastLayer = 0;
      for (let i = 0; i < mesh.vertexCount; i++) {
        for (let c = 0; c < 3; c++) {
          const v = mesh.tint[i * 3 + c]!;
          expect(Number.isFinite(v)).toBe(true);
          expect(v).toBeGreaterThan(0);
        }
        let sum = 0;
        for (let s = 0; s < 16; s++) {
          const w = mesh.splat[i * 16 + s]!;
          expect(Number.isFinite(w)).toBe(true);
          sum += w;
        }
        expect(sum).toBeCloseTo(1, 4);
        lastLayer += mesh.splat[i * 16 + 15]!;
      }
      expect(lastLayer).toBeGreaterThan(0);
    });
  }
});

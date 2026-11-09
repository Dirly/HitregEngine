import { describe, expect, it } from "vitest";
import { defaultWorldRecipe, recipeSplatIndexed, terrainMaterialDoc, terrainPaletteFaults, worldRecipeSchema } from "../src/index.js";

// e-paving (2026-11-02): Bell Strand's pale flagstone was palette #26 on a material derived when the palette had 26
// surfaces. The renderer clamps a palette id past the material's layers to the LAST layer, so the town drew the old
// red flag while every field-side gate read pale flagstone.
function palette(n: number) {
  const base = defaultWorldRecipe();
  return worldRecipeSchema.parse({
    ...base,
    splat: "indexed",
    surfaces: Array.from({ length: n }, (_, i) => ({
      name: `s${i}`,
      color: "#806040",
      roughness: 0.9,
      uvScale: 3.2,
      ...(i % 3 === 0 ? {} : { map: `built/tile-${i}.png` }),
    })),
  });
}

describe("terrain material derived from the palette", () => {
  it("has one layer per surface in palette order, past the old 16 and 26 widths", () => {
    const recipe = palette(27);
    const doc = terrainMaterialDoc(recipe) as { splat: { source: string; layers: { map?: string; color: string }[] } };
    expect(recipeSplatIndexed(recipe)).toBe(true);
    expect(doc.splat.source).toBe("indexed");
    expect(doc.splat.layers).toHaveLength(27);
    // the surface past the old width draws its OWN texture (white tint), not the last layer's
    expect(doc.splat.layers[26]).toMatchObject({ map: "built/tile-26.png", color: "#ffffff" });
    expect(doc.splat.layers[25]).toMatchObject({ map: "built/tile-25.png" });
    expect(doc.splat.layers[24]).toMatchObject({ color: "#806040" });
    expect(doc.splat.layers[24]!.map).toBeUndefined();
    expect(terrainPaletteFaults(recipe, doc)).toEqual([]);
  });

  it("names a surface the material has no layer for, and what it draws as instead", () => {
    const recipe = palette(27);
    const stale = terrainMaterialDoc(palette(26));
    const faults = terrainPaletteFaults(recipe, stale);
    expect(faults).toHaveLength(1);
    expect(faults[0]).toMatchObject({ surface: 26, name: "s26" });
    expect(faults[0]!.why).toMatch(/past the material's 26 layers: it draws as layer #25 \(built\/tile-25\.png\)/);
  });

  it("flags a swapped texture, a wrong source, a missing material and extra layers", () => {
    const recipe = palette(20);
    const doc = terrainMaterialDoc(recipe) as { splat: { source: string; layers: { map?: string }[] } };
    const swapped = structuredClone(doc);
    swapped.splat.layers[5]!.map = "built/other.png";
    expect(terrainPaletteFaults(recipe, swapped).map((f) => f.surface)).toEqual([5]);
    const vertex = structuredClone(doc);
    vertex.splat.source = "vertex";
    expect(terrainPaletteFaults(recipe, vertex)[0]!.why).toMatch(/source "vertex"/);
    expect(terrainPaletteFaults(recipe, null)[0]!.why).toMatch(/no terrain material/);
    expect(terrainPaletteFaults(palette(19), doc).some((f) => /20 layers for a 19-surface palette/.test(f.why))).toBe(true);
  });
});

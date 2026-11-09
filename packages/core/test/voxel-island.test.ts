import { describe, expect, it } from "vitest";
import {
  applyOperator,
  applyRecipeEdits,
  checkOperators,
  compileOperator,
  defaultWorldRecipe,
  operatorSpecs,
  prepareHeightPatch,
  removeOperator,
  worldRecipeSchema,
  type HeightPatchDoc,
  type OperatorFieldReader,
} from "../src/index.js";

const WATER = 55.8;
/** A lake: a flat bed 6.8 m under the water out to 120 m from the origin, a shore rising to dry land past 160 m. */
const lake: OperatorFieldReader = {
  height: (x, z) => {
    const d = Math.hypot(x, z);
    return 49 + Math.max(0, Math.min(1, (d - 120) / 40)) * 12;
  },
  voxelSize: 2,
  seaLevel: 0,
  seed: 7,
  surfaces: ["sand", "redrock", "grass"],
};
const island = { id: "isle", op: "island", center: [0, 0], waterY: WATER, radius: 18, stretch: 1.4, yaw: 90, rise: 3.5, slope: 0.4 };

/** The finished ground: the reader's bed with every compiled height patch laid over it (as the field does). */
function ground(doc: Record<string, unknown>, reader = lake) {
  const { pieces } = compileOperator(doc, reader);
  const patches = pieces.filter((p) => p.kind === "heightPatches").map((p) => p.feature as unknown as HeightPatchDoc);
  const prepared: ReturnType<typeof prepareHeightPatch>[] = [];
  const at = (x: number, z: number, n = prepared.length): number => {
    let y = reader.height(x, z);
    for (let k = 0; k < n; k++) {
      const d = patches[k]!;
      if (x <= d.origin[0] || z <= d.origin[1] || x >= d.origin[0] + d.size[0] || z >= d.origin[1] + d.size[1]) continue;
      y = prepared[k]!.apply(x, z, y);
    }
    return y;
  };
  for (let k = 0; k < patches.length; k++) prepared.push(prepareHeightPatch(patches[k]!, 2, (x, z) => at(x, z, k)));
  return { pieces, at };
}
const refusal = (doc: Record<string, unknown>, reader = lake) => {
  try { compileOperator(doc, reader); } catch (e) { return (e as Error).message; }
  return "";
};

describe("island operator", () => {
  it("raises a walkable island seated in the bed, with a sand beach at the waterline", () => {
    const { pieces, at } = ground(island);
    const ids = pieces.map((p) => `${p.kind}/${p.feature.id}`);
    expect(ids).toEqual(["groundPaints/op:isle:shore", "heightPatches/op:isle:ground"]);
    const patch = pieces.find((p) => p.kind === "heightPatches")!.feature as any;
    expect(patch.raiseOnly).toBe(true);
    // the top stands `rise` over the water (swell +-0.4), the long axis runs north-south (yaw 90)
    expect(at(0, 0)).toBeGreaterThan(WATER + 3);
    expect(at(0, 0)).toBeLessThan(WATER + 4);
    expect(at(0, 20)).toBeGreaterThan(WATER); // 20 m along the 25.2 m long axis: dry
    expect(at(23, 0)).toBeLessThan(WATER); // 23 m across the 18 m short axis: water
    // seated: far out the bed is untouched, and nothing is ever lowered
    expect(at(0, 60)).toBeCloseTo(49, 5);
    for (let x = -60; x <= 60; x += 6) for (let z = -60; z <= 60; z += 6) expect(at(x, z)).toBeGreaterThanOrEqual(lake.height(x, z) - 1e-9);
    // walkable: no dry sample steeper than 0.6 between 2 m lattice steps
    let steep = 0;
    for (let x = -30; x <= 30; x += 2) for (let z = -30; z <= 30; z += 2) {
      if (at(x, z) <= WATER) continue;
      if (Math.abs(at(x + 2, z) - at(x, z)) / 2 > 0.6 || Math.abs(at(x, z + 2) - at(x, z)) / 2 > 0.6) steep++;
    }
    expect(steep).toBe(0);
    // the beach paint covers the waterline band, under and just over the water
    const shore = pieces.find((p) => p.feature.id === "op:isle:shore")!.feature as any;
    expect(shore.surface).toBe("sand");
    expect(shore.height[0]).toBeLessThan(WATER);
    expect(shore.height[1]).toBeGreaterThan(WATER);
  });

  it("a rock knoll at the core: higher, steeper, painted as rock on its faces", () => {
    const knolled = { ...island, core: { at: [0, -6], radius: 11, rise: 6 }, coreSurface: "redrock" };
    const { pieces, at } = ground(knolled);
    expect(at(0, -6)).toBeGreaterThan(WATER + 4 + 5);
    const core = pieces.find((p) => p.feature.id === "op:isle:core")!.feature as any;
    expect(core.surface).toBe("redrock");
    expect(core.faces).toBe(true);
    const { output } = compileOperator(knolled, lake);
    expect((output.report.knoll as any).topY).toBeCloseTo(WATER + 9.5, 5);
  });

  it("a submerged shoal toward the shore: under the water all the way, wading depth on its crest", () => {
    const doc = { ...island, shoal: { to: [0, 140], width: 8, depth: 0.7 } };
    const { pieces, at } = ground(doc);
    expect(pieces.some((p) => p.feature.id === "op:isle:shoal")).toBe(true);
    for (const z of [40, 60, 80, 100]) {
      expect(at(0, z)).toBeLessThan(WATER);
      expect(at(0, z)).toBeGreaterThan(WATER - 1.2);
    }
    expect(at(20, 70)).toBeCloseTo(49, 5); // off the shoal, the bed
  });

  it("refuses dry land, a waterline on the shore, an unknown surface and a sub-6 m shoal", () => {
    expect(refusal({ ...island, center: [200, 0] })).toMatch(/under the water|needs >= 1.5 m of water/);
    expect(refusal({ ...island, center: [125, 0], radius: 20 })).toMatch(/peninsula/);
    expect(refusal({ ...island, shoreSurface: "beach-gold" })).toMatch(/not in this world's palette/);
    expect(refusal({ ...island, shoal: { to: [0, 140], width: 4 } })).toMatch(/width/);
  });

  it("is deterministic, installs as one batch with an exact inverse, and is in the engine spec", () => {
    expect(JSON.stringify(compileOperator(island, lake).pieces)).toBe(JSON.stringify(compileOperator(island, lake).pieces));
    const base = defaultWorldRecipe({ cellSize: 48 });
    const first = applyOperator(base, island, lake);
    expect(first.recipe.features.heightPatches.map((p) => p.id)).toEqual(["op:isle:ground"]);
    expect(worldRecipeSchema.safeParse(first.recipe).success).toBe(true);
    expect(checkOperators(first.recipe, () => lake).map((s) => s.state)).toEqual(["ok"]);
    const again = applyOperator(first.recipe, { ...island, rise: 3 }, lake);
    expect(again.recipe.features.heightPatches.map((p) => p.id)).toEqual(["op:isle:ground"]);
    expect(JSON.stringify(applyRecipeEdits(again.recipe, again.inverse).recipe)).toBe(JSON.stringify(first.recipe));
    expect(JSON.stringify(applyRecipeEdits(first.recipe, first.inverse).recipe)).toBe(JSON.stringify(base));
    const gone = removeOperator(again.recipe, "isle");
    expect(gone.recipe.features.heightPatches).toEqual([]);
    expect(operatorSpecs().island?.description).toMatch(/island/);
  });
});

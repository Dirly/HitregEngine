import { describe, expect, it } from "vitest";
import { voxelRecipeAssetRefs, type WorldRecipe } from "../src/index.js";

describe("voxelRecipeAssetRefs", () => {
  it("lists every asset the chunk generator asks assetExists about", () => {
    const recipe = {
      scatter: [
        { id: "pine", model: "trees/pine.glb" },
        { id: "camp", prefab: "camps/fire", model: "ignored.glb" },
        { id: "rock", model: "rock-kit/boulder-1.glb", modelVariants: [{ model: "rock-kit/boulder-2.glb" }], formation: { memberVariants: [{ model: "rock-kit/slab-1.glb" }] } },
      ],
      features: {
        pois: [{ id: "tower", prefab: "pois/tower" }, { id: "bare" }],
        terraceWalls: [{ id: "t", solved: { pieces: [{ prefab: "retaining-wall/straight-4" }, { prefab: "retaining-wall/straight-4" }, { prefab: "retaining-wall/end-l" }] } }],
      },
    } as unknown as WorldRecipe;
    const refs = voxelRecipeAssetRefs(recipe).map((r) => `${r.kind}:${r.id}`).sort();
    expect(refs).toEqual([
      "model:rock-kit/boulder-1.glb",
      "model:rock-kit/boulder-2.glb",
      "model:rock-kit/slab-1.glb",
      "model:trees/pine.glb",
      "prefab:camps/fire",
      "prefab:pois/tower",
      "prefab:retaining-wall/end-l",
      "prefab:retaining-wall/straight-4",
    ]);
  });
});

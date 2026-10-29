import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createWorldField, defaultWorldRecipe, worldRecipeSchema } from "@hitreg/core";
import { FILL_WALL_MAX_M, fillWalls } from "../tools/worldgen-fill-walls.mts";

// 2026-10-29 redstrand w5-ground: a settled-away lake basin's fill stood 36 m over the ground beside it (its sea-cliff rim
// cleared). A hollow fill reads as ground only when the ground round it stands at or over its level.
const base = defaultWorldRecipe();
function world(fillY: (ground: number) => number, tags = ["hollow"]) {
  const plain = worldRecipeSchema.parse({
    ...base,
    bounds: { continents: [{ center: [0, 0], radius: 900, falloff: 250, warp: 0 }], oceanFloor: -45, landFloor: 4 },
    terrain: { ...base.terrain, caves: { ...base.terrain.caves, enabled: false } },
  });
  const ground = createWorldField(plain).height(0, 0);
  const recipe = worldRecipeSchema.parse({
    ...plain,
    features: { fills: [{ id: "fill-1", polygon: [[-100, -100], [100, -100], [100, 100], [-100, 100]], y: fillY(ground), bank: 12, tags }] },
  });
  return { recipe, field: createWorldField(recipe) };
}

describe("fillWalls", () => {
  it("a fill standing far over the ground round it is on a wall", () => {
    const { recipe, field } = world((g) => g + 30);
    const walls = fillWalls(recipe, field);
    assert.equal(walls.length, 1);
    assert.ok(walls[0]!.metres > FILL_WALL_MAX_M);
    assert.ok(walls[0]!.worstDrop > 20);
  });
  it("a fill at or under the ground round it (a hollow's floor) is clean", () => {
    const { recipe, field } = world((g) => g - 1);
    assert.deepEqual(fillWalls(recipe, field), []);
  });
  it("a landform fill (not a hydrology hollow) is not judged", () => {
    const r = world((g) => g + 30, []);
    r.recipe.features.fills[0]!.id = "landform-mesa";
    assert.deepEqual(fillWalls(r.recipe, r.field), []);
  });
});

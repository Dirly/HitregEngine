import { describe, expect, it } from "vitest";
import {
  applyRecipeEdits,
  cellsForEdits,
  cellsForFootprints,
  defaultWorldRecipe,
  featureFootprint,
  RecipeEditError,
  recipeEditSchema,
  type RecipeEdit,
} from "../src/index.js";

const recipe = () => defaultWorldRecipe({ cellSize: 48 });

const blob = (center: [number, number, number], radius = 10) => ({
  edit: "add-feature" as const,
  kind: "blobs" as const,
  feature: { center, radius, op: "remove" },
});

describe("applyRecipeEdits — add", () => {
  it("appends a validated feature and reports its id", () => {
    const result = applyRecipeEdits(recipe(), [blob([0, 0, 0])]);
    expect(result.recipe.features.blobs).toHaveLength(1);
    expect(result.added).toEqual(["blob"]);
    // Schema defaults are applied on the way in.
    expect(result.recipe.features.blobs[0]!.falloff).toBe(4);
  });

  it("never mutates the input recipe", () => {
    const input = recipe();
    applyRecipeEdits(input, [blob([0, 0, 0])]);
    expect(input.features.blobs).toHaveLength(0);
  });

  it("uniques colliding ids deterministically", () => {
    const result = applyRecipeEdits(recipe(), [
      blob([0, 0, 0]),
      blob([100, 0, 0]),
      blob([200, 0, 0]),
    ]);
    expect(result.added).toEqual(["blob", "blob-2", "blob-3"]);
  });

  it("rejects an invalid feature and reports which edit failed", () => {
    expect(() =>
      applyRecipeEdits(recipe(), [
        blob([0, 0, 0]),
        { edit: "add-feature", kind: "blobs", feature: { center: [0, 0, 0], radius: -5 } },
      ]),
    ).toThrow(RecipeEditError);
  });

  it("inserts at an explicit index", () => {
    const seeded = applyRecipeEdits(recipe(), [blob([0, 0, 0]), blob([50, 0, 0])]).recipe;
    const result = applyRecipeEdits(seeded, [
      { edit: "add-feature", kind: "blobs", feature: { id: "wedged", center: [9, 0, 9], radius: 3 }, index: 1 },
    ]);
    expect(result.recipe.features.blobs.map((b) => b.id)).toEqual(["blob", "wedged", "blob-2"]);
  });
});

describe("applyRecipeEdits — inverse", () => {
  it("undoes an add", () => {
    const input = recipe();
    const forward = applyRecipeEdits(input, [blob([12, -3, 40])]);
    const back = applyRecipeEdits(forward.recipe, forward.inverse);
    expect(back.recipe.features.blobs).toEqual(input.features.blobs);
  });

  it("undoes a remove, restoring array position", () => {
    const seeded = applyRecipeEdits(recipe(), [
      blob([0, 0, 0]),
      blob([100, 0, 0]),
      blob([200, 0, 0]),
    ]).recipe;
    const forward = applyRecipeEdits(seeded, [{ edit: "remove-feature", kind: "blobs", id: "blob-2" }]);
    expect(forward.recipe.features.blobs.map((b) => b.id)).toEqual(["blob", "blob-3"]);

    const back = applyRecipeEdits(forward.recipe, forward.inverse);
    // Order is evaluation order, so a restored feature must land where it was.
    expect(back.recipe.features.blobs.map((b) => b.id)).toEqual(["blob", "blob-2", "blob-3"]);
    expect(back.recipe.features.blobs).toEqual(seeded.features.blobs);
  });

  it("undoes an update", () => {
    const seeded = applyRecipeEdits(recipe(), [blob([0, 0, 0], 10)]).recipe;
    const forward = applyRecipeEdits(seeded, [
      { edit: "update-feature", kind: "blobs", id: "blob", feature: { center: [500, 0, 500], radius: 40 } },
    ]);
    expect(forward.recipe.features.blobs[0]!.radius).toBe(40);

    const back = applyRecipeEdits(forward.recipe, forward.inverse);
    expect(back.recipe.features.blobs).toEqual(seeded.features.blobs);
  });

  it("undoes a mixed batch in one go", () => {
    const seeded = applyRecipeEdits(recipe(), [blob([0, 0, 0]), blob([100, 0, 0])]).recipe;
    const forward = applyRecipeEdits(seeded, [
      { edit: "remove-feature", kind: "blobs", id: "blob" },
      { edit: "add-feature", kind: "tunnels", feature: { points: [[0, 0, 0], [40, -10, 0]], radius: 4 } },
      { edit: "update-feature", kind: "blobs", id: "blob-2", feature: { center: [1, 2, 3], radius: 7 } },
    ]);
    const back = applyRecipeEdits(forward.recipe, forward.inverse);
    expect(back.recipe.features).toEqual(seeded.features);
  });

  it("an update keeps the id even if the replacement names another", () => {
    const seeded = applyRecipeEdits(recipe(), [blob([0, 0, 0])]).recipe;
    const forward = applyRecipeEdits(seeded, [
      { edit: "update-feature", kind: "blobs", id: "blob", feature: { id: "renamed", center: [0, 0, 0], radius: 5 } },
    ]);
    expect(forward.recipe.features.blobs[0]!.id).toBe("blob");
  });

  it("throws on an unknown id and leaves the caller's recipe alone", () => {
    const input = applyRecipeEdits(recipe(), [blob([0, 0, 0])]).recipe;
    expect(() => applyRecipeEdits(input, [{ edit: "remove-feature", kind: "blobs", id: "nope" }])).toThrow(
      /no blobs feature with id/,
    );
    expect(input.features.blobs).toHaveLength(1);
  });
});

describe("featureFootprint", () => {
  it("includes a town's falloff, not just its radius", () => {
    const fp = featureFootprint("towns", { id: "t", center: [0, 0], radius: 45, falloff: 35 })!;
    // 45 + 35 — invalidating only the radius would leave a stale ring.
    expect(fp.x0).toBe(-80);
    expect(fp.x1).toBe(80);
  });

  it("includes a river's bank and half its width", () => {
    const fp = featureFootprint("rivers", { id: "r", points: [[0, 0], [100, 0]], width: 8, bank: 14 })!;
    expect(fp.z0).toBe(-18);
    expect(fp.z1).toBe(18);
    expect(fp.x0).toBe(-18);
    expect(fp.x1).toBe(118);
  });

  it("scales a blob's reach by scaleX/scaleZ and its falloff", () => {
    const fp = featureFootprint("blobs", {
      id: "b",
      center: [0, 0, 0],
      radius: 10,
      falloff: 4,
      scaleX: 2,
      scaleZ: 1,
    })!;
    expect(fp.x0).toBe(-24);
    expect(fp.z0).toBe(-14);
  });

  it("takes a tapered capsule's widest end", () => {
    const fp = featureFootprint("blobs", { id: "b", center: [0, 0, 0], radius: 4, topRadius: 12, falloff: 0 })!;
    expect(fp.x1).toBe(12);
  });

  it("reads a tunnel's 3D points as XZ", () => {
    const fp = featureFootprint("tunnels", {
      id: "t",
      points: [[0, -20, 0], [60, -40, 30]],
      radius: 3,
    })!;
    expect(fp.x0).toBe(-3);
    expect(fp.x1).toBe(63);
    expect(fp.z0).toBe(-3);
    expect(fp.z1).toBe(33);
  });

  it("reports no footprint for a POI, which moves no ground", () => {
    expect(featureFootprint("pois", { id: "p", position: [0, 0, 0] })).toBeNull();
  });
});

describe("cells to re-mesh", () => {
  it("covers only the cells the edit reaches", () => {
    const result = applyRecipeEdits(recipe(), [blob([0, 0, 0], 10)]);
    const cells = cellsForEdits(recipe(), result);
    // A 14m reach around the origin cannot touch a 48m world beyond its
    // immediate neighbours — this is the difference between re-meshing a
    // handful of cells and re-meshing the resident world.
    expect(cells.length).toBeLessThanOrEqual(4);
    expect(cells).toContainEqual([0, 0]);
  });

  it("grows with the feature", () => {
    const small = cellsForFootprints(48, [featureFootprint("blobs", { center: [0, 0, 0], radius: 5, falloff: 0 })!]);
    const large = cellsForFootprints(48, [featureFootprint("blobs", { center: [0, 0, 0], radius: 300, falloff: 0 })!]);
    expect(large.length).toBeGreaterThan(small.length);
  });

  it("deduplicates overlapping footprints", () => {
    const fp = featureFootprint("blobs", { center: [0, 0, 0], radius: 20, falloff: 0 })!;
    const once = cellsForFootprints(48, [fp]);
    const twice = cellsForFootprints(48, [fp, fp]);
    expect(twice).toEqual(once);
  });

  it("reports both the old and the new ground when a feature moves", () => {
    const seeded = applyRecipeEdits(recipe(), [blob([0, 0, 0], 10)]).recipe;
    const moved = applyRecipeEdits(seeded, [
      { edit: "update-feature", kind: "blobs", id: "blob", feature: { center: [4000, 0, 4000], radius: 10 } },
    ]);
    const cells = cellsForEdits(seeded, moved);
    expect(cells).toContainEqual([0, 0]);
    // The ground it left is stale too, not just the ground it arrived on.
    expect(cells.some(([cx]) => cx > 50)).toBe(true);
  });
});

describe("recipeEditSchema", () => {
  it("accepts each edit in the vocabulary", () => {
    const edits: RecipeEdit[] = [
      { edit: "add-feature", kind: "blobs", feature: {} },
      { edit: "update-feature", kind: "towns", id: "t", feature: {} },
      { edit: "remove-feature", kind: "roads", id: "r" },
    ];
    for (const edit of edits) expect(recipeEditSchema.safeParse(edit).success).toBe(true);
  });

  it("rejects an unknown feature kind", () => {
    expect(recipeEditSchema.safeParse({ edit: "remove-feature", kind: "mountains", id: "m" }).success).toBe(false);
  });
});

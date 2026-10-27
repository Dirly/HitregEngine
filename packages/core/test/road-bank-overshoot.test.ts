import { describe, expect, it } from "vitest";
import { createWorldField, defaultWorldRecipe, measureTerrainLips, worldRecipeSchema, type WorldRecipe } from "../src/index.js";
import { ROAD_BANK_OVERSHOOT } from "../src/voxel/field.js";

// A road's embankment band aims at a side height read linearly between the generator's samples. Where that reading
// stands well off the real ground (a concave apron between sparse points, a pinned end far above), the band used to
// rise to it and then fade back down to the ground over its outer half: a one-sample rim beside the road
// (measured 0.87 m on the Old Kings approach). The band is now held between the road and the ground under it.
describe("road embankment band never stands off both the road and the ground", () => {
  const base = defaultWorldRecipe();
  const plain = createWorldField(worldRecipeSchema.parse({ ...base, features: { ...base.features, roads: [] } }));
  const ax = 0, az = 0, bz = 60;
  const g0 = plain.height(ax, az), g1 = plain.height(ax, bz);
  // the road rides the ground; the LEFT side profile claims a bank 8 m above the ground the whole way
  const recipe: WorldRecipe = worldRecipeSchema.parse({
    ...base,
    features: {
      ...base.features,
      roads: [{
        id: "road-bank",
        points: [[ax, az], [ax, bz]],
        width: 6, shoulder: 4, smooth: 8,
        surfaceY: [g0, g1],
        leftY: [g0 + 8, g1 + 8],
        rightY: [g0 - 8, g1 - 8],
      }],
    },
  });
  const field = createWorldField(recipe);

  it("the band holds within a hand of the road or the ground on both sides", () => {
    let worst = 0;
    for (let z = 10; z <= 50; z += 2) {
      const road = g0 + ((g1 - g0) * z) / bz;
      for (let x = -16; x <= 16; x += 1) {
        if (Math.abs(x) < 3) continue;
        const y = field.height(x, z), ground = plain.height(x, z);
        worst = Math.max(worst, y - Math.max(road, ground), Math.min(road, ground) - y);
      }
    }
    // the hold is a smooth min/max of width the overshoot: it may round over by a quarter of that
    expect(worst).toBeLessThanOrEqual(ROAD_BANK_OVERSHOOT * 1.25 + 1e-6);
  });
  it("roads sharing a stretch hold against the ground under them all, never ratchet", () => {
    // a path and a trail on the same line (measured: four docs on one stretch dug a 0.78 m slot)
    const twice = createWorldField({ ...recipe, features: { ...recipe.features, roads: [...recipe.features.roads, { ...recipe.features.roads[0]!, id: "road-bank-2" }] } });
    let worst = 0;
    // inside the full-weight band (roadway + shoulder + inner half of smooth: 11 m) a second copy changes nothing
    for (let z = 10; z <= 50; z += 2) for (let x = -11; x <= 11; x += 1) worst = Math.max(worst, Math.abs(twice.height(x, z) - field.height(x, z)));
    expect(worst).toBeLessThan(0.01);
  });
  it("no lip beside the road", () => {
    const rep = measureTerrainLips(field, plain, { x0: -20, z0: 6, x1: -2, z1: 54 });
    expect(rep.faults.filter((f) => f.kind === "lip")).toEqual([]);
  });
});

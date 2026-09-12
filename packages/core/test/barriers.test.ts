import { describe, expect, it } from "vitest";
import {
  createWorldField,
  defaultWorldRecipe,
  featureFootprint,
  worldRecipeSchema,
  sanctuaryAt,
  nearestSanctuary,
  inSanctuary,
  sanctuariesFromPois,
  ridgeSchema,
  poiSchema,
  applyRecipeEdits,
  type WorldRecipe,
} from "../src/index.js";

/**
 * Barriers — ridges raised on zone borders that had none, passes between
 * their pieces, sanctuaries at the passes (docs/world-editing/barriers.md).
 */

function recipe(overrides: Record<string, unknown> = {}): WorldRecipe {
  return worldRecipeSchema.parse({ ...defaultWorldRecipe(), cellSize: 48, resolution: 24, ...overrides });
}

function noFeatures(): WorldRecipe["features"] {
  return { rivers: [], canyons: [], ridges: [], roads: [], towns: [], lakes: [], bridges: [], fills: [], riverPaths: [], tunnels: [], blobs: [], pois: [], camps: [] };
}

describe("ridges", () => {
  const flat = { ...defaultWorldRecipe().terrain, base: 40 };
  const bare = createWorldField(recipe({ terrain: flat }));
  // one ridge along the x axis from -400 to 400: crest 35 m, 24 m wide, flanks over 60 m
  const one = createWorldField(
    recipe({
      terrain: flat,
      features: { ...noFeatures(), ridges: [{ id: "r", points: [[-400, 0], [400, 0]], height: 35, width: 24, falloff: 60 }] },
    }),
  );

  it("parses with defaults and lands in features.ridges", () => {
    const r = ridgeSchema.parse({ points: [[0, 0], [10, 0]] });
    expect(r).toMatchObject({ id: "ridge", height: 35, width: 24, falloff: 60, tags: [] });
    expect(recipe().features.ridges).toEqual([]);
  });

  it("raises the crest by `height` and leaves the ground `width/2 + falloff` away unchanged", () => {
    expect(one.height(0, 0) - bare.height(0, 0)).toBeCloseTo(35, 5);
    expect(one.height(0, 11) - bare.height(0, 11)).toBeCloseTo(35, 5); // still on the flat top
    const mid = one.height(0, 12 + 30) - bare.height(0, 42);
    expect(mid).toBeGreaterThan(5);
    expect(mid).toBeLessThan(30); // on the flank
    expect(one.height(0, 72)).toBeCloseTo(bare.height(0, 72), 5); // width/2 + falloff out: natural ground
    expect(one.height(0, -72)).toBeCloseTo(bare.height(0, -72), 5);
    // round caps: the crest carries on past the last point as a cap of width/2 + falloff
    expect(one.height(400 + 5, 0) - bare.height(405, 0)).toBeCloseTo(35, 5);
    expect(one.height(400 + 80, 0)).toBeCloseTo(bare.height(480, 0), 5);
  });

  it("never digs: the ground under a ridge is always at least natural", () => {
    for (let z = -100; z <= 100; z += 7) expect(one.height(50, z)).toBeGreaterThanOrEqual(bare.height(50, z) - 1e-6);
  });

  it("per-point heights ride along the crest", () => {
    const f = createWorldField(
      recipe({
        terrain: flat,
        features: { ...noFeatures(), ridges: [{ id: "r", points: [[-400, 0], [400, 0]], height: 35, heights: [20, 60], width: 24, falloff: 60 }] },
      }),
    );
    expect(f.height(-400, 0) - bare.height(-400, 0)).toBeCloseTo(20, 4);
    expect(f.height(400, 0) - bare.height(400, 0)).toBeCloseTo(60, 4);
    expect(f.height(0, 0) - bare.height(0, 0)).toBeCloseTo(40, 4);
  });

  it("a gap between two pieces leaves the ground of a path through it unchanged", () => {
    // two pieces with a pass-wide gap centred on x=0; a 2.4 m path with 8 m shoulders runs through it along z
    const gap = 24 + 2 * 60 + 2.4 + 2 * 8; // width + 2·falloff + path + 2·shoulder
    const f = createWorldField(
      recipe({
        terrain: flat,
        features: {
          ...noFeatures(),
          ridges: [
            { id: "a", points: [[-600, 0], [-gap / 2, 0]], height: 35, width: 24, falloff: 60 },
            { id: "b", points: [[gap / 2, 0], [600, 0]], height: 35, width: 24, falloff: 60 },
          ],
        },
      }),
    );
    for (const x of [-9.2, -5, 0, 5, 9.2]) expect(f.height(x, 0)).toBeCloseTo(bare.height(x, 0), 5);
    // and the flanks taper INTO the gap from both sides — a col, not a doorway
    expect(f.height(-gap / 2 - 20, 0)).toBeGreaterThan(bare.height(-gap / 2 - 20, 0) + 30);
    expect(f.height(-gap / 2 + 40, 0)).toBeGreaterThan(bare.height(-gap / 2 + 40, 0) + 1);
    expect(f.height(-gap / 2 + 40, 0)).toBeLessThan(bare.height(-gap / 2 + 40, 0) + 20);
  });

  it("keeps scatter off the crest (featureClearance) like a canyon rim", () => {
    expect(one.featureClearance(0, 0)).toBeLessThan(0);
    expect(one.featureClearance(0, 30)).toBeCloseTo(18, 3); // 30 m off the centreline, 12 m past the crest edge
  });

  it("does not dig into a lake: the raise happens before the water stage", () => {
    const lake = createWorldField(
      recipe({
        terrain: flat,
        features: {
          ...noFeatures(),
          lakes: [{ id: "tarn", center: [0, 200], radius: 80, waterY: 35, depth: 8, bank: 20, tags: [] }],
          ridges: [{ id: "r", points: [[-400, 200], [400, 200]], height: 35, width: 24, falloff: 60 }],
        },
      }),
    );
    // the ridge runs straight through the lake: the basin is still water (cut after the raise)
    expect(lake.waterY(0, 200)).toBe(35);
    expect(lake.height(0, 200)).toBeLessThanOrEqual(35 - 0.6 + 1e-6);
  });

  it("has a terraform footprint of points ± width/2 + falloff, and is an editable feature kind", () => {
    const fp = featureFootprint("ridges", { id: "r", points: [[0, 0], [100, 50]], width: 24, falloff: 60 })!;
    expect(fp).toEqual({ x0: -72, z0: -72, x1: 172, z1: 122 });
    const defaults = featureFootprint("ridges", { id: "r", points: [[0, 0], [100, 0]] })!;
    expect(defaults.x0).toBe(-72);
    const edited = applyRecipeEdits(recipe(), [{ edit: "add-feature", kind: "ridges", feature: { points: [[0, 0], [100, 0]] } }]);
    expect(edited.recipe.features.ridges).toHaveLength(1);
    expect(edited.touched[0]).toEqual(defaults);
    expect(edited.inverse[0]).toMatchObject({ edit: "remove-feature", kind: "ridges" });
  });
});

describe("sanctuaries", () => {
  const pois = [
    poiSchema.parse({ id: "pass-a-b-1", kind: "waystation", position: [100, 20, 200], radius: 35, tags: ["pass", "safe", "zone:a", "zone:b"] }),
    poiSchema.parse({ id: "pass-a-b-2", kind: "waystation", position: [900, 20, 900], radius: 35, tags: ["pass", "zone:a", "zone:b"] }), // --no-safe
    poiSchema.parse({ id: "peak-1", kind: "peak", position: [500, 300, 500], tags: ["safe"] }), // safe but no radius: not a circle
  ];

  it("a poi may carry a radius", () => {
    expect(pois[0]!.radius).toBe(35);
    expect(poiSchema.parse({ id: "p", position: [0, 0, 0] }).radius).toBeUndefined();
    expect(() => poiSchema.parse({ id: "p", position: [0, 0, 0], radius: 0 })).toThrow();
  });

  it("lists every safe poi with a radius as [x, z, r]", () => {
    expect(sanctuariesFromPois(pois)).toEqual([[100, 200, 35, 20]]);
  });

  it("sanctuaryAt finds the circle under a point, tolerating junk", () => {
    const list = sanctuariesFromPois(pois);
    expect(sanctuaryAt(list, 100, 200)).toBe(0);
    expect(sanctuaryAt(list, 100 + 34, 200)).toBe(0);
    expect(sanctuaryAt(list, 100 + 36, 200)).toBe(-1);
    expect(inSanctuary(list, 120, 220)).toBe(true);
    expect(inSanctuary(list, 900, 900)).toBe(false);
    expect(sanctuaryAt(undefined, 0, 0)).toBe(-1);
    expect(sanctuaryAt([[1, 2], "x", null], 1, 2)).toBe(-1);
    expect(nearestSanctuary([[0, 0, 10, 5], [100, 100, 10, 7]], 90, 90)).toBe(1);
    expect(nearestSanctuary([], 0, 0)).toBe(-1);
  });
});

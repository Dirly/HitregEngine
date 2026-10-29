import { describe, expect, it } from "vitest";
import { createWorldField, defaultWorldRecipe, worldRecipeSchema } from "../src/index.js";

/**
 * Continent `capes` / `inlets` (2026-10-29 redstrand w2-shape: ten seeds of disc + lobes were ten rounded blobs — a disc
 * union cannot make a headland or a sound). A cape is a tapered capsule UNIONED with the land, an inlet one CUT from
 * it, both in shoreline terms: the half-width given is the land's (the water's) at the waterline.
 */
function world(shape: { capes?: number[][]; inlets?: number[][] }) {
  const base = defaultWorldRecipe();
  return createWorldField(
    worldRecipeSchema.parse({
      ...base,
      terrain: { ...base.terrain, base: 40 },
      bounds: {
        continents: [{ center: [0, 0], radius: 1200, falloff: 500, warp: 0, coastVariation: 0, ...shape }],
        oceanFloor: -40,
        landFloor: 4,
        shelf: 0.58,
        limit: 4000,
        limitFalloff: 500,
      },
    }),
  );
}

describe("coast shape: capes and inlets", () => {
  const plain = world({});
  // shore of the plain disc: radius + falloff x (1 - shelf) = 1200 + 210
  const cape = world({ capes: [[1000, 0, 2200, 0, 300, 120]] });
  const inlet = world({ inlets: [[1700, 0, 900, 0, 200, 90]] });

  it("a cape is land out to its tip, at its own width, where the disc was sea", () => {
    expect(plain.shoreDistance(1900, 0)).toBeLessThan(0);
    expect(cape.shoreDistance(1900, 0)).toBeGreaterThan(0);
    // tip at 2200 with a 120 m half-width: land to ~2320, sea past it
    expect(cape.shoreDistance(2250, 0)).toBeGreaterThan(0);
    expect(cape.shoreDistance(2400, 0)).toBeLessThan(0);
    // across the arm at x = 1800 (half-width ~ 300 + (120 - 300) x 2/3 = 180): land at 150, sea at 260
    expect(cape.shoreDistance(1800, 150)).toBeGreaterThan(0);
    expect(cape.shoreDistance(1800, 260)).toBeLessThan(0);
  });

  it("an inlet is sea cut into the land to its head, and the land either side stays", () => {
    expect(plain.shoreDistance(1000, 0)).toBeGreaterThan(0);
    expect(inlet.shoreDistance(1000, 0)).toBeLessThan(0);
    expect(inlet.height(1100, 0)).toBeLessThan(0);
    // head at 900 with a 90 m half-width: land again by ~780
    expect(inlet.shoreDistance(700, 0)).toBeGreaterThan(0);
    // the shoulders 400 m off the axis are land as before
    expect(inlet.shoreDistance(1000, 400)).toBeGreaterThan(0);
    expect(inlet.shoreDistance(1000, -400)).toBeGreaterThan(0);
  });

  it("changes nothing away from the capsules", () => {
    for (const [x, z] of [[-1000, 0], [0, -1000], [0, 900], [-1450, 300]] as const) {
      expect(cape.height(x, z)).toBeCloseTo(plain.height(x, z), 6);
      expect(inlet.height(x, z)).toBeCloseTo(plain.height(x, z), 6);
    }
  });
});

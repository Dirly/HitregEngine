import { describe, expect, it } from "vitest";
import { createWorldField, defaultWorldRecipe, worldRecipeSchema, type WorldRecipe } from "../src/index.js";

/**
 * `climate.zones.riparian` (2026-10-29 redstrand: "a river-valley oasis inside the dry land" could not be drawn — climate
 * cells are regions, never a ribbon): along a wet river the drier anchors' weight hands over to the riparian anchor,
 * for paint and biome only. The terrain shape and `field.zone()` stay as they were.
 */
const ZONES = {
  size: 1200,
  jitter: 0.8,
  warp: 0,
  border: 150,
  latitude: { strength: 0, scale: 6000, axis: "z", flip: false },
  // the oasis anchor is never drawn for a cell (weight ~0): only the ribbon brings it
  anchors: [
    { id: "scrub", temperature: 0.8, moisture: 0.2, weight: 1, relief: 0, hills: 0.2 },
    { id: "oasis", temperature: 0.6, moisture: 0.75, weight: 1e-9, relief: 0, hills: 0.2 },
  ],
};
const BIOMES = [
  { id: "scrubland", zones: ["scrub"], surface: [1] },
  { id: "green", zones: ["oasis"], surface: [1] },
];

function world(riparian: unknown, rivers: unknown[] = []): WorldRecipe {
  const base = defaultWorldRecipe();
  return worldRecipeSchema.parse({
    ...base,
    cellSize: 48,
    resolution: 24,
    biomes: BIOMES,
    patches: [],
    climate: { ...base.climate, zones: { ...ZONES, ...(riparian ? { riparian } : {}) } },
    features: { ...base.features, rivers },
  });
}

describe("riparian oasis ribbon", () => {
  // a straight river along z = 0, its bed laid 2 m under the river-less ground
  const plain = createWorldField(world(null));
  const xs = Array.from({ length: 21 }, (_, i) => -1000 + i * 100);
  const bedY = xs.map((x) => plain.height(x, 0) - 2);
  const river = { points: xs.map((x) => [x, 0]), width: 12, depth: 2, bedY, surfaceY: bedY.map((b) => b + 1.4), water: true };
  const without = createWorldField(world(null, [river]));
  const withRib = createWorldField(world({ anchor: "oasis", reach: 140, rise: 14 }, [river]));

  it("greens the river's banks and leaves the land 400 m off it dry", () => {
    let near = 0, nearGreen = 0;
    for (let x = -800; x <= 800; x += 50) {
      for (const z of [-15, 15]) {
        const g = withRib.height(x, z);
        const water = bedY[Math.round((x + 1000) / 100)]! + 1.4;
        if (g - water > 6) continue; // a bank standing well over the water is not the valley floor
        near++;
        if (withRib.biome(x, z).id === "green") nearGreen++;
        expect(without.biome(x, z).id).toBe("scrubland");
      }
      expect(withRib.biome(x, 400).id).toBe("scrubland");
    }
    expect(near).toBeGreaterThan(20);
    expect(nearGreen / near).toBeGreaterThan(0.9);
  });

  it("raises the moisture there and never moves the ground or the zone", () => {
    for (let x = -600; x <= 600; x += 150) {
      expect(withRib.height(x, 20)).toBeCloseTo(without.height(x, 20), 6);
      expect(withRib.zone(x, 20).id).toBe("scrub");
      if (withRib.height(x, 20) - (bedY[Math.round((x + 1000) / 100)]! + 1.4) < 6) expect(withRib.climate(x, 20).moisture).toBeGreaterThan(without.climate(x, 20).moisture + 0.2);
    }
  });

  it("fades out with height over the water: a cliff top over the river stays dry", () => {
    const high = createWorldField(world({ anchor: "oasis", reach: 140, rise: 14 }, [{ ...river, bedY: bedY.map((b) => b - 40), surfaceY: bedY.map((b) => b - 38.6) }]));
    // ground 40 m over the water at 100 m off the channel (outside the carve's reach): no ribbon
    for (let x = -600; x <= 600; x += 150) expect(high.biome(x, 100).id).toBe("scrubland");
  });
});

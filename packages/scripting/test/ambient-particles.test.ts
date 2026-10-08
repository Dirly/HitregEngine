import { describe, expect, it } from "vitest";
import { layerStrength, normalizeLayer, timeWeight, type AmbientSample } from "../src/ambient-particles.js";

const sample = (over: Partial<AmbientSample>): AmbientSample => ({
  biomes: {},
  region: null,
  daylight: 1,
  water: 0,
  storm: 0,
  ...over,
});

const fireflies = normalizeLayer({ id: "fireflies", biomes: "forest,fen", when: "night", town: "never", waterBoost: 1.5 });
const ash = normalizeLayer({ id: "ash", biomes: "blight", zones: "zone-2", match: "any" });
const moths = normalizeLayer({ id: "moths", when: "night", zones: "town", town: "only" });
const spray = normalizeLayer({ id: "spray", biomes: "beach", needWater: true });

describe("ambient-particles layer rules", () => {
  it("eases day and night across dusk", () => {
    expect(timeWeight("night", 1)).toBe(0);
    expect(timeWeight("night", 0)).toBe(1);
    expect(timeWeight("day", 0.45)).toBeGreaterThan(0.3);
    expect(timeWeight("day", 0.45)).toBeLessThan(0.7);
    expect(timeWeight("always", 0)).toBe(1);
  });

  it("fireflies: forest at night, more near water, none by day or in town", () => {
    const night = sample({ biomes: { forest: 1 }, daylight: 0 });
    expect(layerStrength(fireflies, night)).toBe(1);
    expect(layerStrength(fireflies, { ...night, water: 1 })).toBeCloseTo(2.5);
    expect(layerStrength(fireflies, { ...night, daylight: 1 })).toBe(0);
    expect(layerStrength(fireflies, { ...night, region: { id: "t", name: "T", tags: ["town"] } })).toBe(0);
    // a 10% sliver of forest earns nothing
    expect(layerStrength(fireflies, sample({ biomes: { forest: 0.1, desert: 0.9 }, daylight: 0 }))).toBe(0);
  });

  it("match any: ash in its zone whatever the biome, or in blight anywhere", () => {
    expect(layerStrength(ash, sample({ biomes: { grassland: 1 }, region: { id: "zone-2", name: "Anvil Isle", tags: [] } }))).toBe(1);
    expect(layerStrength(ash, sample({ biomes: { blight: 1 } }))).toBe(1);
    expect(layerStrength(ash, sample({ biomes: { grassland: 1 }, region: { id: "zone-1", name: "x", tags: [] } }))).toBe(0);
  });

  it("zones match ids, names and tags; town only", () => {
    const town = { id: "town-1-zone", name: "Gullhaven", tags: ["town", "safe"] };
    expect(layerStrength(moths, sample({ region: town, daylight: 0 }))).toBe(1);
    expect(layerStrength(moths, sample({ daylight: 0 }))).toBe(0);
    const byName = normalizeLayer({ id: "x", zones: "anvil isle" });
    expect(layerStrength(byName, sample({ region: { id: "zone-2", name: "Anvil Isle", tags: [] } }))).toBe(1);
  });

  it("needWater gates, storm scales", () => {
    expect(layerStrength(spray, sample({ biomes: { beach: 1 } }))).toBe(0);
    expect(layerStrength(spray, sample({ biomes: { beach: 1 }, water: 0.5 }))).toBe(1);
    const leaves = normalizeLayer({ id: "leaves", biomes: "forest", storm: 2 });
    expect(layerStrength(leaves, sample({ biomes: { forest: 1 }, storm: 1 }))).toBe(3);
    const calm = normalizeLayer({ id: "f", storm: -1 });
    expect(layerStrength(calm, sample({ storm: 1 }))).toBe(0);
  });
});

import { describe, expect, it } from "vitest";
import { auditRegions, defaultWorldRecipe, regionAt, regionSchema, worldRecipeSchema, type RegionDoc } from "../src/index.js";

const vale: RegionDoc = regionSchema.parse({
  id: "hollow-vale",
  name: "The Hollow Vale",
  polygon: [
    [0, 0],
    [4000, 0],
    [4000, 3000],
    [0, 3000],
  ],
  hub: [1000, 1000],
  landmarks: ["town-1", "river-a"],
});
const rim: RegionDoc = regionSchema.parse({
  id: "ash-rim",
  name: "Ashfall Rim",
  polygon: [
    [4000, 0],
    [8000, 0],
    [8000, 3000],
    [4000, 3000],
  ],
  hub: [9000, 1000], // deliberately outside
});

describe("regions (agent-drawn zones)", () => {
  it("is optional in a recipe and defaults to none", () => {
    const recipe = worldRecipeSchema.parse(defaultWorldRecipe());
    expect(recipe.regions).toEqual([]);
    const withOne = worldRecipeSchema.parse({ ...defaultWorldRecipe(), regions: [vale] });
    expect(withOne.regions[0]!.id).toBe("hollow-vale");
    expect(withOne.regions[0]!.story).toBe("");
    expect(() => regionSchema.parse({ ...vale, id: "Hollow Vale" })).toThrow();
    expect(() => regionSchema.parse({ ...vale, polygon: [[0, 0], [1, 1]] })).toThrow();
  });

  it("finds the region under a point, first in file order wins", () => {
    expect(regionAt([vale, rim], 1000, 1000)?.id).toBe("hollow-vale");
    expect(regionAt([vale, rim], 6000, 1000)?.id).toBe("ash-rim");
    expect(regionAt([vale, rim], 1000, 9000)).toBeNull();
  });

  it("audits size, hubs, towns and overlaps", () => {
    const features = {
      towns: [
        { id: "town-1", center: [1000, 1000] as const },
        { id: "town-2", center: [6000, 2000] as const },
        { id: "town-lost", center: [-500, -500] as const },
      ],
      pois: [{ id: "peak-1", position: [2000, 300, 2000] as const }],
    };
    const report = auditRegions([vale, rim], features);
    expect(report.regions[0]).toMatchObject({ id: "hollow-vale", areaKm2: 12, towns: ["town-1"], pois: 1, hubInside: true, overlaps: [] });
    expect(report.regions[1]).toMatchObject({ id: "ash-rim", hubInside: false, towns: ["town-2"] });
    expect(report.unclaimedTowns).toEqual(["town-lost"]);
    expect(report.findings.join("\n")).toMatch(/hub is outside/);
    expect(report.findings.join("\n")).toMatch(/town-lost/);
    // sharing an edge is being neighbours; taking real ground (a corner 1 km deep) is an overlap, reported both ways
    expect(report.regions[0]!.overlaps).toEqual([]);
    const shifted: RegionDoc = { ...rim, id: "overlap", polygon: [[3000, 500], [7000, 500], [7000, 2500], [3000, 2500]] };
    const clash = auditRegions([vale, shifted], features);
    expect(clash.regions[0]!.overlaps).toEqual(["overlap"]);
    expect(clash.regions[1]!.overlaps).toEqual(["hollow-vale"]);
    // a border wobbling 100 m into the neighbour is within tolerance
    const wobble: RegionDoc = { ...rim, id: "wobble", polygon: [[3900, 0], [8000, 0], [8000, 3000], [3900, 3000]] };
    expect(auditRegions([vale, wobble], features).regions[0]!.overlaps).toEqual([]);
  });
});

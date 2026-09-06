import { describe, expect, it } from "vitest";
import { auditRegions, defaultWorldRecipe, polygonEnclosesCircle, regionAt, regionSchema, townRegionOf, worldRecipeSchema, type RegionDoc } from "../src/index.js";

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

describe("town zones (a town is a zone of its own)", () => {
  const towns = [
    { id: "town-1", center: [1000, 1000] as const, radius: 45, falloff: 35 },
    { id: "town-2", center: [6000, 2000] as const, radius: 45, falloff: 35 },
  ];
  const circle = (cx: number, cz: number, r: number): [number, number][] =>
    Array.from({ length: 12 }, (_, i) => [Math.round(cx + Math.cos((i / 12) * Math.PI * 2) * r), Math.round(cz + Math.sin((i / 12) * Math.PI * 2) * r)]);
  const town1: RegionDoc = regionSchema.parse({ id: "town-1-zone", name: "Stonebrook", polygon: circle(1000, 1000, 120), hub: [1000, 1000], landmarks: ["town-1"], within: "hollow-vale", cap: 120, tags: ["town", "safe"] });
  const town2: RegionDoc = regionSchema.parse({ id: "town-2-zone", name: "Ashfall", polygon: circle(6000, 2000, 120), hub: [6000, 2000], landmarks: ["town-2"], within: "ash-rim", tags: ["town", "safe"] });

  it("regionAt prefers the cut-out over its parent, wherever it sits in the file", () => {
    expect(regionAt([vale, rim, town1], 1000, 1000)?.id).toBe("town-1-zone");
    expect(regionAt([town1, vale, rim], 1000, 1000)?.id).toBe("town-1-zone");
    expect(regionAt([vale, rim, town1], 1000, 1200)?.id).toBe("hollow-vale"); // 200 m out: the vale again
    expect(townRegionOf([vale, town1], "town-1")?.id).toBe("town-1-zone");
    expect(townRegionOf([vale, town1], "town-2")).toBeNull();
  });

  it("the audit treats a cut-out as a neighbour, not an overlap, and still credits the parent with the town", () => {
    const report = auditRegions([vale, rim, town1, town2], { towns, pois: [] });
    expect(report.findings.filter((f) => f.includes("overlaps"))).toEqual([]);
    expect(report.regions[0]!.towns).toEqual(["town-1"]); // the vale holds town-1 through its town zone
    expect(report.regions[2]).toMatchObject({ id: "town-1-zone", within: "hollow-vale", towns: ["town-1"] });
    expect(report.findings.filter((f) => f.includes("no town inside"))).toEqual([]);
    expect(report.findings.filter((f) => f.includes("km²"))).toEqual([]); // a town zone is small by design
    expect(report.unclaimedTowns).toEqual([]);
  });

  it("flags a town without a zone of its own once the world has town zones, and a zone that does not enclose its town", () => {
    const missing = auditRegions([vale, rim, town1], { towns, pois: [] });
    expect(missing.findings.join("\n")).toMatch(/town "town-2" has no zone of its own/);
    // a world with no town zones at all is not held to the rule (older recipes, plain tests)
    expect(auditRegions([vale, rim], { towns, pois: [] }).findings.join("\n")).not.toMatch(/zone of its own/);
    const tight: RegionDoc = { ...town1, polygon: circle(1000, 1000, 60) }; // radius + falloff is 80 m
    expect(auditRegions([vale, rim, tight, town2], { towns, pois: [] }).findings.join("\n")).toMatch(/does not enclose the town/);
    expect(polygonEnclosesCircle(town1.polygon, 1000, 1000, 80)).toBe(true);
    expect(polygonEnclosesCircle(tight.polygon, 1000, 1000, 80)).toBe(false);
  });

  it("flags a cut-out whose parent is missing or that leaks outside it", () => {
    const orphan: RegionDoc = { ...town1, within: "nowhere" };
    expect(auditRegions([vale, orphan], { towns: [towns[0]!], pois: [] }).findings.join("\n")).toMatch(/does not exist/);
    const leaking: RegionDoc = { ...town1, polygon: circle(50, 50, 120) };
    expect(auditRegions([vale, leaking], { towns: [towns[0]!], pois: [] }).findings.join("\n")).toMatch(/not wholly inside/);
  });
});

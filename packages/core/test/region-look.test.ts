import { describe, expect, it } from "vitest";
import { coverKindAllowed, coverWantsInland, regionLookAt, regionSchema, type RegionInput } from "../src/index.js";

const square = (x0: number, z0: number, x1: number, z1: number): [number, number][] => [
  [x0, z0],
  [x1, z0],
  [x1, z1],
  [x0, z1],
];

const regions = (
  [
    {
      id: "bog",
      name: "The Bog",
      polygon: square(0, 0, 1000, 1000),
      mood: { haze: "#66705a", mistTop: 3 },
      sound: { bed: { "*": "ambience/biome/swamp-{band}.ogg" }, spots: { day: "spot/frog-croak" }, music: { "*": "music/zone/bog-{daynight}.ogg" }, stillWater: "ambience/water/swamp-water.ogg" },
      ambient: [{ id: "spores", rate: 4 }],
    },
    { id: "bog-town", name: "Mirehold", polygon: square(100, 100, 200, 200), within: "bog", tags: ["town", "safe"] },
    {
      id: "drowned-chapel",
      name: "The Drowned Chapel",
      polygon: square(500, 500, 600, 600),
      within: "bog",
      tags: ["place"],
      sound: { music: { "*": "music/place/chapel.ogg" } },
      ambient: [{ id: "spores", rate: 9 }, { id: "fireflies", when: "night" }],
    },
  ] satisfies RegionInput[]
).map((r) => regionSchema.parse(r));

describe("regionLookAt: the zone signature resolved over place -> zone -> parent", () => {
  it("a zone's own look, sound and ambient", () => {
    const look = regionLookAt(regions, 800, 100)!;
    expect(look.region.id).toBe("bog");
    expect(look.place).toBeNull();
    expect(look.mood?.mistTop).toBe(3);
    expect(look.sound?.bed?.["*"]).toContain("swamp");
    expect(look.sound?.stillWater).toBe("ambience/water/swamp-water.ogg");
    expect(look.ambient?.map((a) => a.id)).toEqual(["spores"]);
  });

  it("a town zone inherits its parent's bed, still water, mood and ambient but not its music or spots", () => {
    const look = regionLookAt(regions, 150, 150)!;
    expect(look.region.id).toBe("bog-town");
    expect(look.mood?.haze).toBe("#66705a");
    expect(look.sound?.bed).toBeDefined();
    expect(look.sound?.stillWater).toBeDefined();
    expect(look.sound?.music).toBeUndefined();
    expect(look.sound?.spots).toBeUndefined();
    expect(look.ambient?.[0]?.id).toBe("spores");
  });

  it("a place's own fields win; the rest come from its zone; same-id ambient layers take the nearest", () => {
    const look = regionLookAt(regions, 550, 550)!;
    expect(look.region.id).toBe("bog");
    expect(look.place?.id).toBe("drowned-chapel");
    expect(look.sound?.music?.["*"]).toBe("music/place/chapel.ogg");
    expect(look.sound?.bed?.["*"]).toContain("swamp");
    expect(look.ambient?.find((a) => a.id === "spores")?.rate).toBe(9);
    expect(look.ambient?.map((a) => a.id).sort()).toEqual(["fireflies", "spores"]);
  });

  it("outside every zone: null", () => {
    expect(regionLookAt(regions, -50, -50)).toBeNull();
  });
});

describe("cover water kinds", () => {
  it("`lake` accepts every still-water kind; rivers and the sea only by name", () => {
    expect(coverKindAllowed(["lake"], "lake")).toBe(true);
    expect(coverKindAllowed(["lake"], "marsh")).toBe(true);
    expect(coverKindAllowed(["lake"], "river")).toBe(false);
    expect(coverKindAllowed(["river"], "marsh")).toBe(false);
    expect(coverKindAllowed(["river"], "river")).toBe(true);
    expect(coverWantsInland(["sea"])).toBe(false);
    expect(coverWantsInland(["sea", "lake"])).toBe(true);
  });
});

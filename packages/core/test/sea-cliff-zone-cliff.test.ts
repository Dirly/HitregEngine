import { describe, expect, it } from "vitest";
import { createWorldField, defaultWorldRecipe, worldRecipeSchema, type WorldField } from "../src/index.js";

// A sea-cliff wall stands on the coastline, which is where a zone polygon ends: the zone's membership fades over
// zoneGround.band there, so the wall drew a share of the base palette's cliff (redstrand 2026-10-29: the Weeping Sun's
// face). `turf.cliff` gives the wall and the stacks' sides the zone's cliff tile in full.
const base = defaultWorldRecipe();
function recipe(turf?: Record<string, unknown>) {
  const surfaces = [
    ...base.surfaces.map((s) => (s.name === "grass" ? { ...s, role: "grass" } : s.name === "rock" ? { ...s, role: "cliff" } : s)),
    { name: "zrock", color: "#a04030", roughness: 0.9, uvScale: 20 },
  ];
  const width = surfaces.length;
  const weights = (one: number) => Array.from({ length: width }, (_, i) => (i === one ? 1 : 0));
  const rock = surfaces.findIndex((s) => s.name === "rock");
  return worldRecipeSchema.parse({
    ...base,
    surfaces,
    patches: [],
    biomes: [{ id: "meadow", surface: weights(0), cliff: weights(rock) }],
    bounds: { continents: [{ center: [0, 0], radius: 700, falloff: 250, warp: 0 }], oceanFloor: -45, landFloor: 4 },
    terrain: {
      ...base.terrain,
      base: 20,
      caves: { ...base.terrain.caves, enabled: false },
      seaCliffs: [{ id: "east", along: [[640, -500], [700, 0], [640, 500]], reach: 300, fade: 120, height: [80, 100], stacks: { density: 0 }, ...(turf ? { turf } : {}) }],
    },
    // the zone polygon ends at the coastline, as a drawn zone does
    regions: [{ id: "isle", name: "Isle", polygon: [[-800, -800], [660, -800], [660, 800], [-800, 800]], ground: { cliff: "zrock" } }],
  });
}

/** Metres along +x at row z where the ground first drops under the sea (the wall's foot). */
function wallX(field: WorldField, z: number): number {
  for (let x = 400; x < 1100; x += 0.5) if (field.height(x, z) < base.seaLevel + 2) return x;
  return NaN;
}

/** The zone cliff's share of the face, sampled facing sideways at mid-height along the wall. */
function zoneCliffShare(field: WorldField): number {
  const zi = field.recipe.surfaces.findIndex((s) => s.name === "zrock");
  const out = new Float32Array(field.surfaceCount + 3);
  let least = 1;
  for (const z of [-200, -100, 0, 100, 200]) {
    const wx = wallX(field, z);
    const y = field.height(wx - 3, z) * 0.5;
    field.surfaceAt(wx - 1, y, z, 0, out, 0);
    let total = 0;
    for (let i = 0; i < field.surfaceCount; i++) total += out[i]!;
    least = Math.min(least, out[zi]! / total);
  }
  return least;
}

describe("sea cliffs take the zone's cliff (turf.cliff)", () => {
  it("without it the wall on the zone's edge draws the base cliff in part; with it, the zone's cliff", () => {
    const plain = zoneCliffShare(createWorldField(recipe()));
    const tops = zoneCliffShare(createWorldField(recipe({ zone: "isle" })));
    const full = zoneCliffShare(createWorldField(recipe({ zone: "isle", cliff: true })));
    expect(plain).toBeLessThan(0.9);
    // turf alone leaves the cliff role to the border band
    expect(tops).toBeCloseTo(plain, 3);
    expect(full).toBeGreaterThan(0.95);
  });
});

describe("a region nested in the turf's zone keeps its own cliff on the wall", () => {
  it("the cape (within the isle) draws its cliff, not the isle's", () => {
    const r = recipe({ zone: "isle", cliff: true });
    const surfaces = [...r.surfaces, { name: "zcape", color: "#605040", roughness: 0.9, uvScale: 20 }];
    const biomes = r.biomes.map((b) => ({ ...b, surface: [...b.surface, 0], cliff: [...b.cliff!, 0] }));
    const regions = [...r.regions, { id: "cape", name: "Cape", within: "isle", polygon: [[300, -150], [1000, -150], [1000, 150], [300, 150]], ground: { cliff: "zcape" } }];
    const field = createWorldField(worldRecipeSchema.parse({ ...r, surfaces, biomes, regions }));
    const ci = surfaces.findIndex((s) => s.name === "zcape");
    const out = new Float32Array(field.surfaceCount + 3);
    const wx = wallX(field, 0);
    field.surfaceAt(wx - 1, field.height(wx - 3, 0) * 0.5, 0, 0, out, 0);
    let total = 0;
    for (let i = 0; i < field.surfaceCount; i++) total += out[i]!;
    expect(out[ci]! / total).toBeGreaterThan(0.9);
  });
});

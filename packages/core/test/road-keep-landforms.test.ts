import { describe, expect, it } from "vitest";
import { createWorldField, defaultWorldRecipe, worldRecipeSchema, type WorldRecipe } from "../src/index.js";

// A road onto a butte monument (the approach to a landmark): a plain road is an obstacle to the butte field and drops
// the monument it reaches; `keepLandforms` leaves the field as it was and only grades its own band.
describe("roads[].keepLandforms", () => {
  const base = defaultWorldRecipe();
  const recipe = (roads: unknown[]): WorldRecipe =>
    worldRecipeSchema.parse({
      ...base,
      terrain: { ...base.terrain, buttes: [{ id: "b", center: [0, 0], radius: 500, fade: 150, level: 20, cell: 260, seed: 3 }] },
      features: { ...base.features, roads },
    });
  const none = createWorldField(recipe([]));
  // the tallest column of the field: a monument
  let top = { x: 0, z: 0, y: -Infinity };
  for (let x = -400; x <= 400; x += 16) for (let z = -400; z <= 400; z += 16) {
    const y = none.height(x, z);
    if (y > top.y) top = { x, z, y };
  }
  const road = (keep: boolean) => ({
    id: "road-approach",
    points: [[top.x - 60, top.z], [top.x, top.z]],
    width: 6,
    shoulder: 4,
    smooth: 8,
    surfaceY: [none.height(top.x - 60, top.z), none.height(top.x - 60, top.z) + 10],
    leftY: [none.height(top.x - 60, top.z), none.height(top.x - 60, top.z) + 10],
    rightY: [none.height(top.x - 60, top.z), none.height(top.x - 60, top.z) + 10],
    ...(keep ? { keepLandforms: true } : {}),
  });
  // columns well clear of the road's band, over the monument and round it
  const probes: [number, number][] = [];
  for (let dx = -120; dx <= 120; dx += 20) for (let dz = -120; dz <= 120; dz += 20) if (Math.abs(dz) > 30 || dx > 20) probes.push([top.x + dx, top.z + dz]);
  const moved = (f: ReturnType<typeof createWorldField>): number => Math.max(...probes.map(([x, z]) => Math.abs(f.height(x, z) - none.height(x, z))));

  it("the test world has a monument", () => {
    expect(top.y).toBeGreaterThan(60);
  });
  it("a plain road into the butte field re-sites the monuments", () => {
    expect(moved(createWorldField(recipe([road(false)])))).toBeGreaterThan(5);
  });
  it("a keepLandforms road leaves the field alone outside its own band", () => {
    expect(moved(createWorldField(recipe([road(true)])))).toBeLessThan(0.01);
  });
});

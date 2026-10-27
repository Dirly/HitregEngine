import { describe, expect, it } from "vitest";
import { SOLID_WORLD } from "@hitreg/physics";
import { physicsGroundWithin, pickSpreadPoint, SPREAD_GROUND_REACH } from "../src/spawn-areas.js";

/**
 * A pack's spread clips to the walkable floor: a spot with no ground within 2 m of the area's height is re-rolled and
 * never used (tipped-kirk: creatures spawned off a tipped floor fell to y -85).
 */
describe("spawn spread on the floor", () => {
  // a floor at y 10 only for x < 0 (a broken / tipped floor edge at x = 0), nothing beyond
  const floor = (x: number) => (x < 0 ? 10 : null);
  const raycast = (from: [number, number, number], _dir: [number, number, number], len: number, opts: { layers: number }) => {
    expect(opts.layers).toBe(SOLID_WORLD);
    const g = floor(from[0]);
    return g !== null && from[1] >= g && from[1] - len <= g ? { point: [from[0], g, from[2]], normal: [0, 1, 0] } : null;
  };

  it("physics ground answers only within the reach of the area's height", () => {
    expect(physicsGroundWithin(raycast, -1, 10.5, 0)).toBe(10);
    expect(physicsGroundWithin(raycast, 1, 10.5, 0)).toBeNull();                     // off the edge
    expect(physicsGroundWithin(raycast, -1, 10 + SPREAD_GROUND_REACH + 0.5, 0)).toBeNull(); // floor 2.5 m below
    const wall = () => ({ point: [0, 10, 0], normal: [1, 0, 0] });
    expect(physicsGroundWithin(wall, 0, 10, 0)).toBeNull();                          // a wall face is not a floor
  });

  it("every spread point lands on ground; no ground at all gives null (caller uses the centre)", () => {
    let s = 7;
    const rand = () => ((s = (s * 16807) % 2147483647) / 2147483647);
    const ground = (x: number, z: number, y: number) => physicsGroundWithin(raycast, x, y, z);
    for (let i = 0; i < 200; i++) {
      const p = pickSpreadPoint([0, 10.5, 0], 6, ground, rand);
      if (p) { expect(p[0]).toBeLessThan(0); expect(p[1]).toBe(10); }
    }
    expect(pickSpreadPoint([50, 10.5, 0], 6, () => null, rand)).toBeNull();
  });
});

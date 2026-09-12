import { expect, it } from "vitest";
import { advanceGrassReach } from "../src/grass.js";

it("reveals the extra coverage after a patch swap gradually at different frame rates", () => {
  const simulate = (dt: number) => {
    let reach = 20;
    for (let time = 0; time < 900; time += dt) reach = advanceGrassReach(reach, 42, dt);
    return reach;
  };
  expect(advanceGrassReach(20, 42, 16)).toBeLessThan(22);
  expect(simulate(15)).toBeCloseTo(simulate(30), 6);
  expect(simulate(30)).toBeGreaterThan(40);
  expect(simulate(30)).toBeLessThan(42);
});

it("never fades beyond available blades or jumps outward after a stall", () => {
  expect(advanceGrassReach(42, 20, 16)).toBe(20);
  expect(advanceGrassReach(20, 42, 5000)).toBe(advanceGrassReach(20, 42, 50));
  expect(advanceGrassReach(20, 42, 0)).toBe(20);
});

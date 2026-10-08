import { describe, expect, it } from "vitest";
import { nearestOnRoute, MobBrain } from "../src/index.js";

describe("patrol routes", () => {
  const route: Array<[number, number, number]> = [[0, 0, 0], [10, 2, 0], [10, 4, 20]];

  it("measures from the nearest point of the route, y interpolated", () => {
    expect(nearestOnRoute(route, [5, 0, 3])).toEqual([5, 1, 0]);
    expect(nearestOnRoute(route, [14, 0, 10])).toEqual([10, 3, 10]);
    expect(nearestOnRoute(route, [-4, 0, -4])).toEqual([0, 0, 0]);
  });

  it("is a described mob-brain param (lands in the spec)", () => {
    const spec = (MobBrain as unknown as { params: Record<string, { description?: string; default?: unknown }> }).params["patrol"];
    expect(spec?.description).toMatch(/ping-pong/);
    expect(spec?.default).toEqual([]);
  });
});

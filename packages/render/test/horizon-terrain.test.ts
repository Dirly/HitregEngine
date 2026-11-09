import { describe, expect, it } from "vitest";
import { horizonDrop } from "../src/horizon-terrain.js";
import { fogCeilingAt, fogFactor } from "../src/atmosphere.js";

describe("horizon terrain", () => {
  it("sits a little low past the ring and far below the ground well inside it", () => {
    expect(horizonDrop(2000, 1000, 32)).toBe(6);
    expect(horizonDrop(1000, 1000, 32)).toBe(6);
    expect(horizonDrop(900, 1000, 32)).toBe(400);
    expect(horizonDrop(0, 1000, 32)).toBe(400);
    const edge = horizonDrop(970, 1000, 32);
    expect(edge).toBeGreaterThan(6);
    expect(edge).toBeLessThan(400);
  });
});

describe("fog ceiling", () => {
  const fog = { color: "#000000", mode: "exponential" as const, near: 0, far: 0, density: 0.0024, heightFalloff: 0, baseHeight: 0 };
  it("leaves near air alone and stops far land vanishing", () => {
    const capped = { ...fog, maxOpacity: 0.8 };
    expect(fogFactor(capped, 100)).toBeCloseTo(fogFactor(fog, 100));
    expect(fogFactor(fog, 3000)).toBeGreaterThan(0.99);
    expect(fogFactor(capped, 3000)).toBeCloseTo(0.8);
  });
  it("lifts past the land so the sea's far edge still dissolves", () => {
    expect(fogCeilingAt(0.8, 1000)).toBeCloseTo(0.8);
    expect(fogCeilingAt(0.8, 6000)).toBe(1);
  });
  it("defaults to no ceiling", () => {
    expect(fogFactor(fog, 100000)).toBeCloseTo(1);
  });
});

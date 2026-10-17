import { describe, expect, it } from "vitest";
import { wallsDensity, seaCliffsSchema, buttesSchema, planarFallsSchema } from "../src/index.js";

describe("planar water features: wallsDensity", () => {
  // ground at h with slope g; one wall of 4 m over a foot at F = 10.5 (water at 10)
  const ground = (h: number, F: number, S: number, K: number): number => {
    // walk down the column to the first rock
    for (let y = 60; y > -10; y -= 0.01) if (wallsDensity(y, h, 1, F, S, K, 0, 0) < 0) return y;
    return NaN;
  };
  it("never touches ground below the foot (the waterline stays where the carve put it)", () => {
    for (const h of [-5, 0, 5, 10, 10.4]) expect(ground(h, 10.5, 4, 0)).toBeCloseTo(h, 1);
  });
  it("cuts, never builds, without fill", () => {
    for (let h = 10.5; h < 40; h += 0.7) expect(ground(h, 10.5, 4, 2)).toBeLessThanOrEqual(h + 0.02);
  });
  it("steps the ground to the bench levels between the foot and the natural top", () => {
    expect(ground(12, 10.5, 4, 2)).toBeCloseTo(10.5, 1);
    expect(ground(16, 10.5, 4, 2)).toBeCloseTo(14.5, 1);
    expect(ground(30, 10.5, 4, 2)).toBeCloseTo(30, 1);
  });
  it("is continuous across a wall's contour", () => {
    let prev = wallsDensity(13, 14.4, 1, 10.5, 4, 1, 0, 0);
    for (let h = 14.4; h <= 14.6; h += 0.001) {
      const d = wallsDensity(13, h, 1, 10.5, 4, 1, 0, 0);
      expect(Math.abs(d - prev)).toBeLessThan(0.01);
      prev = d;
    }
  });
});

describe("opt-in feature schemas", () => {
  it("parse with defaults", () => {
    expect(planarFallsSchema.parse({}).bowl).toBe(2);
    expect(seaCliffsSchema.parse([{ along: [[0, 0], [100, 0]] }])[0]!.height).toEqual([70, 150]);
    expect(buttesSchema.parse([{ center: [0, 0], level: 10 }])[0]!.mesa.length).toEqual([300, 700]);
  });
});

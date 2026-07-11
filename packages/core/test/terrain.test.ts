import { describe, expect, it } from "vitest";
import { sampleHeightmap } from "../src/terrain.js";
import { terrainHeightfieldSchema } from "../src/assets.js";

describe("heightmap terrain", () => {
  it("validates file-backed heightfields and samples them bilinearly", () => {
    const data = terrainHeightfieldSchema.parse({
      version: 1,
      size: [8, 8],
      resolution: 8,
      heights: Array.from({ length: 81 }, (_, i) => Math.floor(i / 9)),
    });
    expect(sampleHeightmap({
      ...data,
      amplitude: 0,
      frequency: 1,
      seed: 1,
      flatRadius: 0,
      flatFalloff: 1,
    }, 0, 0)).toBeCloseTo(4);
  });
  it("is continuous at the boundary of adjacent offset chunks", () => {
    const shared = {
      size: [160, 160] as [number, number],
      amplitude: 2,
      frequency: 0.05,
      seed: 42,
      resolution: 64,
      flatRadius: 0,
      flatFalloff: 8,
    };
    const west = sampleHeightmap({ ...shared, offset: [0, 0] }, 80, 17.5);
    const east = sampleHeightmap({ ...shared, offset: [160, 0] }, -80, 17.5);
    expect(east).toBeCloseTo(west, 10);
  });

  it("carves a river bed in world space", () => {
    const terrain = {
      size: [160, 160] as [number, number], amplitude: 0, frequency: 0.05, seed: 1,
      resolution: 64, flatRadius: 0, flatFalloff: 8, offset: [160, 0] as [number, number],
      river: { centerX: 160, width: 12, depth: 3 },
    };
    expect(sampleHeightmap(terrain, 0, 0)).toBeCloseTo(-3, 10);
    expect(sampleHeightmap(terrain, 12, 0)).toBeCloseTo(0, 10);
  });
});

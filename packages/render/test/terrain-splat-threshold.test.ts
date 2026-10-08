import { describe, expect, it } from "vitest";
import { SPLAT_ARRAY_THRESHOLD, shouldPackSplatLayers } from "../src/terrain-splat.js";

describe("terrain-splat array packing threshold", () => {
  it("keeps an eleven-map palette (the live world) on the per-map path", () => {
    expect(shouldPackSplatLayers(11, false)).toBe(false);
  });

  it("packs a twelve-map palette: twelve separate maps exceed WebGPU's 16 sampled textures per stage", () => {
    expect(SPLAT_ARRAY_THRESHOLD).toBe(11);
    expect(shouldPackSplatLayers(12, false)).toBe(true);
    expect(shouldPackSplatLayers(16, false)).toBe(true);
  });

  it("never packs a palette carrying normal maps", () => {
    expect(shouldPackSplatLayers(12, true)).toBe(false);
  });
});

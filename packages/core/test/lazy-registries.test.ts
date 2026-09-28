import { describe, expect, it, vi } from "vitest";
import {
  csgMesh,
  defaultWorldRecipe,
  getVolume,
  getVoxelWorld,
  isVolumeInUse,
  isVoxelWorldInUse,
  registerVolumeDoc,
  registerVoxelRecipe,
  volumeIds,
  voxelWorldIds,
} from "../src/index.js";

// A project registers every recipe and volume it ships; a session uses one or
// two. Building them all at load held hundreds of MB in the MMO tab.
describe("lazy world + volume registries", () => {
  it("builds a registered world only when something asks for it, once", () => {
    const recipe = registerVoxelRecipe("lazy-world-test", defaultWorldRecipe());
    expect(voxelWorldIds()).toContain("lazy-world-test");
    expect(isVoxelWorldInUse("lazy-world-test")).toBe(false);
    const field = getVoxelWorld("lazy-world-test");
    expect(field?.recipe).toBe(recipe);
    expect(isVoxelWorldInUse("lazy-world-test")).toBe(true);
    expect(getVoxelWorld("lazy-world-test")).toBe(field);
  });

  it("rejects a recipe that does not parse at registration", () => {
    expect(() => registerVoxelRecipe("lazy-world-bad", { cellSize: "big" })).toThrow();
    expect(getVoxelWorld("lazy-world-bad")).toBeNull();
  });

  it("compiles a volume on first use and resolves a broken one to null with a warning", () => {
    registerVolumeDoc("lazy-volume-test", { voxelSize: 0.5, palette: ["rock"], nodes: [{ id: "rock", shape: "box", size: [4, 4, 4] }] });
    expect(volumeIds()).toContain("lazy-volume-test");
    expect(isVolumeInUse("lazy-volume-test")).toBe(false);
    expect(csgMesh({ kind: "csg", volume: "lazy-volume-test" }).vertexCount).toBeGreaterThan(0);
    expect(isVolumeInUse("lazy-volume-test")).toBe(true);

    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    registerVolumeDoc("lazy-volume-bad", { nodes: "nope" });
    expect(getVolume("lazy-volume-bad")).toBeNull();
    expect(getVolume("lazy-volume-bad")).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(isVolumeInUse("lazy-volume-bad")).toBe(true);
    warn.mockRestore();
  });
});

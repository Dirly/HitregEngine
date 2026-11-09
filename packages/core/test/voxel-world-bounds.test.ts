import { describe, expect, it } from "vitest";
import { voxelCellInBounds, voxelWorldSchema } from "../src/index.js";

describe("voxelWorld streaming bounds", () => {
  it("is unbounded by default", () => {
    const data = voxelWorldSchema.parse({ world: "w" });
    expect(data.bounds).toBeUndefined();
    expect(voxelCellInBounds(data.bounds, 48, 1e5, -1e5)).toBe(true);
  });

  it("keeps exactly the cells that overlap the box", () => {
    const { bounds } = voxelWorldSchema.parse({ world: "w", bounds: { min: [-50, 100], max: [100, 200] } });
    // cellSize 48: x cells -2..2 (-96..144 overlaps -50..100), z cells 2..4 (96..240 overlaps 100..200)
    const kept: string[] = [];
    for (let cz = -2; cz <= 6; cz++) for (let cx = -4; cx <= 4; cx++) if (voxelCellInBounds(bounds, 48, cx, cz)) kept.push(`${cx},${cz}`);
    const want: string[] = [];
    for (let cz = 2; cz <= 4; cz++) for (let cx = -2; cx <= 2; cx++) want.push(`${cx},${cz}`);
    expect(kept).toEqual(want);
  });

  it("an edge that only touches a cell boundary does not pull that cell in", () => {
    const b = { min: [0, 0] as [number, number], max: [48, 48] as [number, number] };
    expect(voxelCellInBounds(b, 48, 0, 0)).toBe(true);
    expect(voxelCellInBounds(b, 48, 1, 0)).toBe(false);
    expect(voxelCellInBounds(b, 48, -1, 0)).toBe(false);
    expect(voxelCellInBounds(b, 48, 0, 1)).toBe(false);
  });

  it("rejects an inverted or empty box", () => {
    expect(voxelWorldSchema.safeParse({ world: "w", bounds: { min: [10, 0], max: [0, 10] } }).success).toBe(false);
    expect(voxelWorldSchema.safeParse({ world: "w", bounds: { min: [0, 0], max: [10, 0] } }).success).toBe(false);
  });
});

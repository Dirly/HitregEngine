import { describe, expect, it } from "vitest";
import { mergeVoxelMeshes } from "../src/voxel/merge.js";
import type { VoxelMesh } from "../src/voxel/mesh.js";

/** One triangle, with distinguishable splat/tint so interleaving is detectable. */
function tri(offset: number, surfaceCount = 2): VoxelMesh {
  return {
    positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
    normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
    indices: new Uint32Array([0, 1, 2]),
    splat: new Float32Array(
      Array.from({ length: 3 * surfaceCount }, (_, i) => offset + i / 100),
    ),
    surfaceCount,
    tint: new Float32Array([offset, 0, 0, offset, 0, 0, offset, 0, 0]),
    min: [0, 0, 0],
    max: [1, 1, 0],
    vertexCount: 3,
    triangleCount: 1,
  };
}

/** Column-major translation, matching THREE.Matrix4.elements. */
function translation(x: number, y: number, z: number): number[] {
  return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1];
}

describe("mergeVoxelMeshes", () => {
  it("returns null when nothing has geometry", () => {
    expect(mergeVoxelMeshes([])).toBeNull();
    const empty = { ...tri(0), triangleCount: 0 };
    expect(mergeVoxelMeshes([{ mesh: empty, matrix: translation(0, 0, 0) }])).toBeNull();
  });

  it("bakes each cell's translation into its vertices", () => {
    const merged = mergeVoxelMeshes([
      { mesh: tri(1), matrix: translation(10, 0, 0) },
      { mesh: tri(2), matrix: translation(0, 5, 0) },
    ])!;
    expect(merged.vertexCount).toBe(6);
    expect(merged.triangleCount).toBe(2);
    // first cell shifted +10 x, second +5 y
    expect(Array.from(merged.positions.subarray(0, 3))).toEqual([10, 0, 0]);
    expect(Array.from(merged.positions.subarray(9, 12))).toEqual([0, 5, 0]);
  });

  it("offsets the second cell's indices so they address its own vertices", () => {
    const merged = mergeVoxelMeshes([
      { mesh: tri(1), matrix: translation(0, 0, 0) },
      { mesh: tri(2), matrix: translation(3, 0, 0) },
    ])!;
    expect(Array.from(merged.indices)).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it("keeps splat weights aligned to their own vertices", () => {
    const a = tri(1);
    const b = tri(2);
    const merged = mergeVoxelMeshes([
      { mesh: a, matrix: translation(0, 0, 0) },
      { mesh: b, matrix: translation(0, 0, 0) },
    ])!;
    expect(merged.surfaceCount).toBe(2);
    expect(merged.splat.length).toBe(6 * 2);
    expect(Array.from(merged.splat.subarray(0, 6))).toEqual(Array.from(a.splat));
    expect(Array.from(merged.splat.subarray(6, 12))).toEqual(Array.from(b.splat));
  });

  it("tracks the merged bounds in world space", () => {
    const merged = mergeVoxelMeshes([
      { mesh: tri(1), matrix: translation(0, 0, 0) },
      { mesh: tri(2), matrix: translation(10, 2, 0) },
    ])!;
    expect(merged.min).toEqual([0, 0, 0]);
    expect(merged.max).toEqual([11, 3, 0]);
  });

  it("rotates normals with the cell and keeps them unit length", () => {
    // 90 degrees about X: +Z normal becomes -Y
    const rotX90 = [1, 0, 0, 0, 0, 0, 1, 0, 0, -1, 0, 0, 0, 0, 0, 1];
    const merged = mergeVoxelMeshes([{ mesh: tri(1), matrix: rotX90 }])!;
    const [nx, ny, nz] = Array.from(merged.normals.subarray(0, 3));
    expect(nx!).toBeCloseTo(0, 5);
    expect(ny!).toBeCloseTo(-1, 5);
    expect(nz!).toBeCloseTo(0, 5);
    expect(Math.hypot(nx!, ny!, nz!)).toBeCloseTo(1, 5);
  });

  it("skips empty cells without disturbing the ones that have geometry", () => {
    const empty = { ...tri(9), triangleCount: 0, vertexCount: 0 };
    const merged = mergeVoxelMeshes([
      { mesh: empty, matrix: translation(0, 0, 0) },
      { mesh: tri(1), matrix: translation(7, 0, 0) },
    ])!;
    expect(merged.vertexCount).toBe(3);
    expect(Array.from(merged.positions.subarray(0, 3))).toEqual([7, 0, 0]);
  });
});

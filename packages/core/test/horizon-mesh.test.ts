import { describe, expect, it } from "vitest";
import { buildHorizonMesh } from "../src/voxel/index.js";

/** A round island: land inside radius 300 of the origin. */
function field() {
  const surfaces = [{}, {}];
  return {
    recipe: { bounds: { limit: 512 }, seaLevel: 0, surfaces } as never,
    height: (x: number, z: number) => 40 - Math.hypot(x, z) * (40 / 300),
    surfaceAt: (_x: number, _y: number, _z: number, _ny: number, out: Float32Array, offset: number) => {
      out[offset] = 1; out[offset + 1] = 0; out[offset + 2] = 0.5; out[offset + 3] = 0.6; out[offset + 4] = 0.7;
    },
  } as never;
}

describe("horizon mesh", () => {
  it("covers the land, leaves out the open sea, and faces up", () => {
    const mesh = buildHorizonMesh(field(), 32);
    expect(mesh.triangleCount).toBeGreaterThan(100);
    expect(mesh.indices.length).toBe(mesh.triangleCount * 3);
    let far = 0;
    for (let i = 0; i < mesh.vertexCount; i++) {
      far = Math.max(far, Math.hypot(mesh.positions[i * 3]!, mesh.positions[i * 3 + 2]!));
      expect(mesh.normals[i * 3 + 1]!).toBeGreaterThan(0);
    }
    expect(far).toBeGreaterThan(280); // reaches the shore
    expect(far).toBeLessThan(380); // and stops near it
    expect(mesh.tint[1]).toBeCloseTo(0.6);
    // first triangle winds upward
    const [a, b, c] = [mesh.indices[0]!, mesh.indices[1]!, mesh.indices[2]!];
    const p = (i: number) => [mesh.positions[i * 3]!, mesh.positions[i * 3 + 1]!, mesh.positions[i * 3 + 2]!] as const;
    const [A, B, C] = [p(a), p(b), p(c)];
    const ux = B[0] - A[0], uz = B[2] - A[2], vx = C[0] - A[0], vz = C[2] - A[2];
    expect(uz * vx - ux * vz).toBeGreaterThan(0);
  });
});

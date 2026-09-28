import { describe, expect, it } from "vitest";
import { buildVolumeMesh, createVolume } from "../src/index.js";

// Many small nodes: the case the per-sub-cell sampler lists and the owner grid exist for.
function manyNodes() {
  const nodes: unknown[] = [];
  for (let i = 0; i < 40; i++) {
    const x = (i % 8) * 3 - 12, z = Math.floor(i / 8) * 3 - 6;
    nodes.push({ id: `b${i}`, op: "add", shape: "ellipsoid", position: [x, 0, z], size: [2.6, 2 + (i % 3), 2.4], blend: 0.4, noise: { amount: 0.2, scale: 1.5, seed: i } });
    nodes.push({ id: `c${i}`, op: "sub", shape: "box", position: [x + 1.2, 0.8, z], rotation: [0, 0.3, 0.2], size: [1.5, 1.5, 3] });
  }
  return { voxelSize: 0.5, palette: ["a", "b"], nodes };
}

describe("csg sampler sub-cells", () => {
  it("agrees with the full field everywhere", () => {
    const volume = createVolume(manyNodes());
    const lo: [number, number, number] = [-14, -3, -8];
    const hi: [number, number, number] = [10, 3, 8];
    const sample = volume.sampler(lo, hi);
    for (let i = 0; i < 4000; i++) {
      const x = lo[0] - 1 + Math.random() * (hi[0] - lo[0] + 2);
      const y = lo[1] - 1 + Math.random() * (hi[1] - lo[1] + 2);
      const z = lo[2] - 1 + Math.random() * (hi[2] - lo[2] + 2);
      expect(sample(x, y, z)).toBeCloseTo(volume.density(x, y, z), 9);
    }
  });

  it("reports air where no add node reaches", () => {
    const volume = createVolume(manyNodes());
    expect(volume.solidMayReach?.([40, 40, 40], [50, 50, 50])).toBe(false);
    expect(volume.solidMayReach?.([-1, -1, -1], [1, 1, 1])).toBe(true);
  });
});

describe("volume tint", () => {
  it("multiplies by the document tint and blends a stroke's tint with its coverage", () => {
    const doc = {
      voxelSize: 0.5,
      palette: ["rock", "grass"],
      tint: [0.8, 0.7, 0.6],
      nodes: [{ id: "box", op: "add", shape: "box", size: [4, 2, 4] }],
      paint: [{ id: "top", center: [0, 1, 0], radius: 1.5, strength: 1, layer: 1, normal: [0, 1, 0], maxAngle: 30, fill: true, tint: [0.2, 0.4, 0.1] }],
    };
    const mesh = buildVolumeMesh(createVolume(doc));
    let painted = 0, plain = 0;
    for (let i = 0; i < mesh.vertexCount; i++) {
      const [r, g, b] = [mesh.tint[i * 3]!, mesh.tint[i * 3 + 1]!, mesh.tint[i * 3 + 2]!];
      const grass = mesh.splat[i * 2 + 1]!;
      if (grass > 0.99) {
        painted++;
        expect([r, g, b].map((v) => +v.toFixed(3))).toEqual([0.2, 0.4, 0.1]);
      } else if (grass < 1e-6) {
        plain++;
        expect([r, g, b].map((v) => +v.toFixed(3))).toEqual([0.8, 0.7, 0.6]);
      }
    }
    expect(painted).toBeGreaterThan(0);
    expect(plain).toBeGreaterThan(0);
  });
});

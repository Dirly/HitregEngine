import { describe, expect, it } from "vitest";
import { createVolume, buildVolumeMesh, VOLUME_MESH_BLOCK } from "../src/index.js";

/**
 * `buildVolumeMesh(volume, 1, { blocks })`: a volume baked in chunks of whole blocks. The chunks must weld into
 * exactly the mesh of the whole (same triangles, every boundary edge shared), so a carved dungeon too big for one
 * mesh shows no seam and has no hole at a chunk border.
 */
describe("buildVolumeMesh block ranges", () => {
  // a block of rock with a noised cave carved out of it, crossing several block borders
  const v = 0.25, span = VOLUME_MESH_BLOCK * v; // one block = 6 m
  const volume = createVolume({
    voxelSize: v,
    bounds: { min: [-1, -1, -1], max: [2 * span + 1, 6, 2 * span + 1] },
    nodes: [
      { id: "rock", op: "add", shape: "box", position: [span, 2.5, span], size: [2 * span + 1, 6, 2 * span + 1] },
      { id: "cave", op: "sub", shape: "box", position: [span, 2.5, span], size: [span * 1.4, 3, span * 1.2], noise: { amount: 0.3, scale: 1.5 } },
    ],
  });
  const key = (P: Float32Array, i: number) => `${P[i * 3]},${P[i * 3 + 1]},${P[i * 3 + 2]}`;
  const edges = (meshes: ReturnType<typeof buildVolumeMesh>[]) => {
    const uses = new Map<string, number>();
    for (const m of meshes) for (let t = 0; t < m.indices.length; t += 3) for (let e = 0; e < 3; e++) {
      const a = key(m.positions, m.indices[t + e]!), b = key(m.positions, m.indices[t + ((e + 1) % 3)]!), k = a < b ? `${a}|${b}` : `${b}|${a}`;
      uses.set(k, (uses.get(k) ?? 0) + 1);
    }
    return uses;
  };

  it("four chunks weld into the whole mesh: same triangle count, no open edge", () => {
    const whole = buildVolumeMesh(volume);
    const R = [[0, 1], [1, 3]] as const; // the lattice is 2+ blocks wide: the second range takes the partial last block
    const parts = R.flatMap((x) => R.map((z) => buildVolumeMesh(volume, 1, { blocks: { x, z } })));
    expect(parts.reduce((n, m) => n + m.triangleCount, 0)).toBe(whole.triangleCount);
    expect(parts.every((m) => m.triangleCount > 0)).toBe(true);
    const open = [...edges(parts).values()].filter((c) => c !== 2).length;
    expect(open).toBe(0);
    expect([...edges([whole]).values()].filter((c) => c !== 2).length).toBe(0);
  });

  it("a chunk alone is open only along its borders", () => {
    const part = buildVolumeMesh(volume, 1, { blocks: { x: [0, 1], z: [0, 1] } });
    const open = [...edges([part])].filter(([, c]) => c === 1).length;
    expect(open).toBeGreaterThan(0);
  });
});

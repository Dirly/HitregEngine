import { it, expect, describe } from "vitest";
import { createVolume, buildVolumeMesh, volumeDocSchema, perlin3 } from "../src/index.js";

/** A closed box as an indexed triangle solid (outward winding). */
function boxMesh(min: number[], max: number[]) {
  const [x0, y0, z0] = min, [x1, y1, z1] = max;
  const positions = [x0, y0, z0, x1, y0, z0, x1, y1, z0, x0, y1, z0, x0, y0, z1, x1, y0, z1, x1, y1, z1, x0, y1, z1];
  const quads = [[0, 3, 2, 1], [4, 5, 6, 7], [0, 1, 5, 4], [1, 2, 6, 5], [2, 3, 7, 6], [3, 0, 4, 7]];
  const indices = quads.flatMap(([a, b, c, d]) => [a, b, c, a, c, d]);
  return { positions, indices };
}

// A 0.4 m thick wall slab 6 x 3 m: thinner than 2 x the amount used below.
const wall = { id: "wall", op: "add", shape: "mesh", mesh: boxMesh([-3, 0, -0.2], [3, 3, 0.2]) };
const bounds = { min: [-4, -1, -1.6], max: [4, 4, 1.6] };

describe("csg role noise", () => {
  it("keeps the original two-octave formula when only amount/scale/seed are given", () => {
    const n = { amount: 0.3, scale: 2, seed: 9 };
    const plain = createVolume(volumeDocSchema.parse({ voxelSize: 0.25, nodes: [{ id: "s", shape: "sphere", radius: 2 }] }));
    const noisy = createVolume(volumeDocSchema.parse({ voxelSize: 0.25, nodes: [{ id: "s", shape: "sphere", radius: 2, noise: n }] }));
    for (let i = 0; i < 25; i++) {
      const x = i * 0.12 - 1.5, y = 0.4, z = 1.1;
      const s = n.scale;
      const raw = 0.75 * perlin3(x / s, y / s, z / s, n.seed) + 0.25 * perlin3((x / s) * 2.7, (y / s) * 2.7, (z / s) * 2.7, n.seed + 17);
      expect(noisy.density(x, y, z)).toBeCloseTo(plain.density(x, y, z) + n.amount * Math.max(-1, Math.min(1, raw)), 9);
    }
  });

  it("grow only ever adds solid, and is bounded by amount", () => {
    const base = createVolume(volumeDocSchema.parse({ voxelSize: 0.1, bounds, nodes: [wall] }));
    const grown = createVolume(volumeDocSchema.parse({ voxelSize: 0.1, bounds, nodes: [{ ...wall, noise: { amount: 0.4, scale: 1.5, seed: 3, octaves: 3, grow: true } }] }));
    let moved = 0;
    for (let i = 0; i < 400; i++) {
      const x = (i % 20) * 0.3 - 3, y = Math.floor(i / 20) * 0.15, z = ((i * 7) % 11) * 0.05 - 0.27;
      const a = base.density(x, y, z), b = grown.density(x, y, z);
      expect(b).toBeLessThanOrEqual(a + 1e-12);
      expect(a - b).toBeLessThanOrEqual(0.4 + 1e-12);
      moved += a - b;
    }
    expect(moved).toBeGreaterThan(1);
    // A grow-noised thin wall never opens a hole: every point of the original slab stays solid.
    for (let x = -2.9; x < 3; x += 0.25) for (let y = 0.1; y < 3; y += 0.25) expect(grown.density(x, y, 0)).toBeLessThan(0);
  });

  it("protect capsules and boxes fade the noise to zero", () => {
    const protect = [{ a: [0, 1, 0.2], b: [0, 2, 0.2], radius: 0.5, fade: 0.5 }, { min: [2, 0, -1], max: [3, 3, 1], fade: 0.3 }];
    const base = createVolume(volumeDocSchema.parse({ voxelSize: 0.1, bounds, nodes: [wall] }));
    const prot = createVolume(volumeDocSchema.parse({ voxelSize: 0.1, bounds, nodes: [{ ...wall, noise: { amount: 0.4, scale: 1.2, seed: 5, protect } }] }));
    for (const [x, y, z] of [[0, 1.5, 0.3], [0.3, 1.2, 0.2], [2.5, 1, 0.25], [2.1, 2.9, -0.2]]) expect(prot.density(x!, y!, z!)).toBe(base.density(x!, y!, z!));
    let away = 0;
    for (let x = -2.8; x < -0.5; x += 0.2) away += Math.abs(prot.density(x, 1.4, 0.25) - base.density(x, 1.4, 0.25));
    expect(away).toBeGreaterThan(0.05);
  });

  it("a floor band keeps wall feet crisp over the floor and leaves the noise above it", () => {
    // floor at y = 0 everywhere on a 0.5 m grid covering the wall
    const columns = 20, rows = 8;
    const floors = { origin: [-5, -2] as [number, number], cell: 0.5, columns, rows, spans: Array.from({ length: columns * rows }, () => [0, 0]) };
    const band = { floors, above: 0.6, below: 0.2, fade: 0.4 };
    const noise = { amount: 0.4, scale: 1.2, seed: 5, octaves: 3, grow: true };
    const base = createVolume(volumeDocSchema.parse({ voxelSize: 0.1, bounds, nodes: [wall] }));
    const banded = createVolume(volumeDocSchema.parse({ voxelSize: 0.1, bounds, nodes: [{ ...wall, noise: { ...noise, protect: [band] } }] }));
    const free = createVolume(volumeDocSchema.parse({ voxelSize: 0.1, bounds, nodes: [{ ...wall, noise }] }));
    let inBand = 0, above = 0;
    for (let x = -2.8; x < 2.8; x += 0.1) {
      for (const y of [0.05, 0.3, 0.6]) inBand += Math.abs(banded.density(x, y, 0.3) - base.density(x, y, 0.3));
      above += Math.abs(banded.density(x, 1.8, 0.3) - free.density(x, 1.8, 0.3));
    }
    expect(inBand).toBe(0);
    expect(above).toBe(0); // y 1.8 is past 0.6 + 0.4: full noise
    // between: ramps (never more than the free noise)
    let ramp = 0;
    for (let x = -2.8; x < 2.8; x += 0.1) { const d = Math.abs(banded.density(x, 0.8, 0.3) - base.density(x, 0.8, 0.3)); expect(d).toBeLessThanOrEqual(Math.abs(free.density(x, 0.8, 0.3) - base.density(x, 0.8, 0.3)) + 1e-12); ramp += d; }
    expect(ramp).toBeGreaterThan(0);
    // outside the grid the band does nothing
    const off = createVolume(volumeDocSchema.parse({ voxelSize: 0.1, bounds, nodes: [{ ...wall, noise: { ...noise, protect: [{ ...band, floors: { ...floors, origin: [40, 40] } }] } }] }));
    for (let x = -2.8; x < 2.8; x += 0.4) expect(off.density(x, 0.3, 0.3)).toBe(free.density(x, 0.3, 0.3));
    expect(() => volumeDocSchema.parse({ voxelSize: 0.1, nodes: [{ ...wall, noise: { amount: 0.2, scale: 1, protect: [{ floors: { ...floors, columns: 0 } }] } }] })).toThrow();
  });

  it("block culling on noised mesh nodes yields exactly the unculled mesh", () => {
    const noised = { ...wall, noise: { amount: 0.35, scale: 1.4, seed: 11, grow: true } };
    const roof = { id: "roof", op: "add", shape: "mesh", mesh: boxMesh([-3, 2.8, -1.2], [3, 3.2, 1.2]) };
    const culled = buildVolumeMesh(createVolume(volumeDocSchema.parse({ voxelSize: 0.1, bounds, nodes: [noised, roof] })));
    // A sub box far outside the bounds changes nothing but is not a mesh node, so culling is off.
    const far = { id: "far", op: "sub", shape: "box", position: [50, 50, 50], size: [1, 1, 1] };
    const full = buildVolumeMesh(createVolume(volumeDocSchema.parse({ voxelSize: 0.1, bounds, nodes: [noised, roof, far] })));
    expect(culled.triangleCount).toBeGreaterThan(1000);
    expect(culled.triangleCount).toBe(full.triangleCount);
    expect(Array.from(culled.positions)).toEqual(Array.from(full.positions));
  });

  it("skipping far hard-union mesh nodes is exact (split field = min of the parts)", () => {
    const a = { ...wall, noise: { amount: 0.3, scale: 1.3, seed: 2, grow: true } };
    const b = { id: "b", op: "add", shape: "mesh", mesh: boxMesh([5, 0, -1], [7, 3, 1]) };
    const both = createVolume(volumeDocSchema.parse({ voxelSize: 0.1, nodes: [b, a] }));
    const va = createVolume(volumeDocSchema.parse({ voxelSize: 0.1, nodes: [a] }));
    const vb = createVolume(volumeDocSchema.parse({ voxelSize: 0.1, nodes: [b] }));
    for (let i = 0; i < 300; i++) {
      const x = (i % 30) * 0.4 - 4, y = Math.floor(i / 30) * 0.4 - 0.5, z = ((i * 13) % 17) * 0.2 - 1.6;
      expect(both.density(x, y, z)).toBe(Math.min(va.density(x, y, z), vb.density(x, y, z)));
    }
  });

  it("rejects malformed noise specs", () => {
    expect(() => volumeDocSchema.parse({ voxelSize: 0.1, nodes: [{ ...wall, noise: { amount: 0.2, scale: 1, octaves: 9 } }] })).toThrow();
    expect(() => volumeDocSchema.parse({ voxelSize: 0.1, nodes: [{ ...wall, noise: { amount: 0.2, scale: 1, protect: [{ a: [0, 0, 0], min: [0, 0, 0] }] } }] })).toThrow();
  });
});

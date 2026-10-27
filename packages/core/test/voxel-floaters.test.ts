import { describe, expect, it } from "vitest";
import { bladeClearCells, createWorldField, defaultWorldRecipe, findFloaters, floaterClearKey, floaterClearSet, type SampleBlockRequest } from "../src/index.js";

/** A synthetic 1 m lattice: ground solid below y=0, plus solid boxes given in cells. */
function synthetic(boxes: [number, number, number, number, number, number][]) {
  const solid = (gx: number, gy: number, gz: number): boolean =>
    gy < 0 || boxes.some(([x0, y0, z0, x1, y1, z1]) => gx >= x0 && gx <= x1 && gy >= y0 && gy <= y1 && gz >= z0 && gz <= z1);
  return {
    voxelSize: 1,
    heightRange: () => ({ min: 0, max: 0 }),
    sampleBlock: ({ origin, nx, ny, nz }: SampleBlockRequest) => {
      const out = new Float32Array(nx * ny * nz);
      for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++)
        out[i + j * nx + k * nx * ny] = solid(origin[0] + i, origin[1] + j, origin[2] + k) ? -1 : 1;
      return out;
    },
  };
}

describe("floating voxels", () => {
  it("finds small pieces cut off from the ground, keeps attached and big ones; a corner-only contact floats (as MC draws it)", () => {
    const field = synthetic([
      [10, 5, 10, 11, 6, 11], // floating 2x2x2 = 8 voxels
      [20, 0, 20, 20, 3, 20], // a pillar standing on the ground
      [30, 0, 30, 30, 0, 30], [31, 1, 31, 31, 1, 31], // a piece touching the pillar only across a corner
      [5, 10, 25, 9, 14, 29], // floating 5x5x5 = 125 voxels (>= keep)
    ]);
    const scan = findFloaters(field as never, { x0: 0, z0: 0, x1: 40, z1: 40 }, { keepVoxels: 64, yLo: -3, yHi: 20 });
    expect(scan.floaters.map((f) => f.size).sort()).toEqual([1, 8]);
    expect(scan.floaters.find((f) => f.size === 8)!.centre).toEqual([10.5, 5.5, 10.5]);
    expect(scan.floaters.find((f) => f.size === 1)!.centre).toEqual([31, 1, 31]);
    expect(scan.bigFloating).toBe(1);
    const loose = findFloaters(field as never, { x0: 0, z0: 0, x1: 40, z1: 40 }, { keepVoxels: 64, yLo: -3, yHi: 20, connect: 26 });
    expect(loose.floaters.map((f) => f.size)).toEqual([8]);
  });

  it("a piece crossing the box edge is judged with its margin and owned by one box only", () => {
    const field = synthetic([[39, 5, 5, 41, 5, 5]]); // 3 voxels across x = 40
    const a = findFloaters(field as never, { x0: 0, z0: 0, x1: 40, z1: 40 }, { yLo: -3, yHi: 20 });
    const b = findFloaters(field as never, { x0: 40, z0: 0, x1: 80, z1: 40 }, { yLo: -3, yHi: 20 });
    expect(a.floaters.length + b.floaters.length).toBe(1);
    expect([...a.floaters, ...b.floaters][0]!.size).toBe(3);
  });

  it("the field forces cleared lattice cells to air, point query and mesher alike", () => {
    const recipe = defaultWorldRecipe();
    const plain = createWorldField(recipe);
    const v = plain.voxelSize;
    const gx = 3, gz = -2;
    const gy = Math.floor((plain.height(gx * v, gz * v) - 6) / v); // a cell well under the ground
    expect(plain.density(gx * v, gy * v, gz * v)).toBeLessThan(0);
    const cleared = createWorldField({ ...recipe, features: { ...recipe.features, floaterClears: [{ id: "t", cells: [gx, gy, gz] }] } });
    expect(cleared.density(gx * v, gy * v, gz * v)).toBeGreaterThan(0);
    const block = cleared.sampleBlock({ origin: [gx * v, gy * v, gz * v], nx: 2, ny: 2, nz: 2, step: v });
    expect(block[0]).toBeGreaterThan(0);
    expect(block[1]).toBeLessThan(0); // the neighbour is untouched
    expect(floaterClearSet([{ cells: [gx, gy, gz] }]).has(floaterClearKey(gx, gy, gz))).toBe(true);
  });

  it("blade cells: a one-sample fin beside an air vertex is cleared, the ground under it never", () => {
    // ground below y = 0; a fin one cell thick in x standing on it (x 10, y 0..4, z 8..12)
    const solid = (gx: number, gy: number, gz: number) => gy < 0 || (gx === 10 && gy >= 0 && gy <= 4 && gz >= 8 && gz <= 12);
    const field = { voxelSize: 1, density: (x: number, y: number, z: number) => (solid(Math.round(x), Math.round(y), Math.round(z)) ? -1 : 1) };
    const cells = bladeClearCells(field, [[10.4, 3.5, 10.2]]);
    const got = new Set<string>();
    for (let i = 0; i < cells.length; i += 3) got.add(cells.slice(i, i + 3).join(","));
    expect(got.has("10,3,10")).toBe(true);
    expect(got.has("10,4,11")).toBe(true);
    for (const k of got) expect(Number(k.split(",")[1])).toBeGreaterThanOrEqual(0); // the ground mass is never cleared
    // a vertex over flat ground (no fin) clears nothing
    expect(bladeClearCells(field, [[30.5, 0.4, 30.5]])).toEqual([]);
  });
});

import { afterEach, describe, expect, it } from "vitest";
import { buildVoxelMesh, createWorldField, defaultWorldRecipe, wallFootSnap, worldRecipeSchema, type VoxelMesh, type WorldField } from "../src/index.js";

// e-paving (2026-11-02): marching cubes drew the concave corner where a wall's face cut meets its floor as one chamfer
// across the lattice cell, a ~1 m dirt fillet in front of every retaining wall, while the field itself is sharp.
// mesh.ts `squareWallFeet` squares it; nothing away from a wall foot may move.
const base = defaultWorldRecipe();
const plain = worldRecipeSchema.parse({
  ...base, cellSize: 48, resolution: 24, minY: -100,
  bounds: { continents: [{ center: [0, 0], radius: 400, falloff: 60, warp: 0 }], oceanFloor: -45, landFloor: 4 },
  terrain: { ...base.terrain, caves: { ...base.terrain.caves, enabled: false } },
  features: {},
});
const probe = createWorldField(plain);
// a wall at ~33 deg to the lattice across cell (0, 0), the low side (to the right of dir) cut 8 m wide so the far
// side of the trench keeps its own corner away from the samples
const dir: [number, number] = [Math.cos(0.58), Math.sin(0.58)];
const origin: [number, number] = [8, 6];
const L = 30;
let low = Infinity;
for (let s = -2; s <= L + 2; s += 1) for (let n = -4; n <= 10; n += 1) {
  low = Math.min(low, probe.height(origin[0] + dir[0] * s - dir[1] * n, origin[1] + dir[1] * s + dir[0] * n));
}
const y0 = Math.floor(low) - 3.3; // the foot, well below the ground and off the lattice
const recipe = worldRecipeSchema.parse({
  ...plain,
  features: { kitWalls: [{ id: "op:test:wall-1", style: "stone", pieces: [], cuts: [{ kind: "face", origin, dir, s: [0, L], n: [-0.15, 8], y: [y0, y0 + 9] }] }] },
});
const field = createWorldField(recipe);
const n = (x: number, z: number) => -(x - origin[0]) * dir[1] + (z - origin[1]) * dir[0];
const at = (s: number, d: number): [number, number] => [origin[0] + dir[0] * s - dir[1] * d, origin[1] + dir[1] * s + dir[0] * d];

function mesh(f: WorldField, snap: boolean): VoxelMesh {
  wallFootSnap.enabled = snap;
  return buildVoxelMesh(f, { kind: "voxel", world: "t", cell: [0, 0], mesher: "mc" });
}
/** Highest mesh surface at world (x, z) under `ceil`. */
function surface(m: VoxelMesh, x: number, z: number, ceil: number): number {
  let best = -Infinity;
  for (let t = 0; t < m.indices.length; t += 3) {
    const [a, b, c] = [m.indices[t]! * 3, m.indices[t + 1]! * 3, m.indices[t + 2]! * 3];
    const p = m.positions;
    const det = (p[b + 2]! - p[c + 2]!) * (p[a]! - p[c]!) + (p[c]! - p[b]!) * (p[a + 2]! - p[c + 2]!);
    if (Math.abs(det) < 1e-12) continue;
    const w0 = ((p[b + 2]! - p[c + 2]!) * (x - p[c]!) + (p[c]! - p[b]!) * (z - p[c + 2]!)) / det;
    const w1 = ((p[c + 2]! - p[a + 2]!) * (x - p[c]!) + (p[a]! - p[c]!) * (z - p[c + 2]!)) / det;
    const w2 = 1 - w0 - w1;
    if (w0 < -1e-6 || w1 < -1e-6 || w2 < -1e-6) continue;
    const y = w0 * p[a + 1]! + w1 * p[b + 1]! + w2 * p[c + 1]!;
    if (y <= ceil && y > best) best = y;
  }
  return best;
}
const fillets = (m: VoxelMesh, d: number): number[] => {
  const out: number[] = [];
  for (let s = 2; s <= L - 2; s += 1) {
    const [x, z] = at(s, d);
    if (x < 0.5 || z < 0.5 || x > 47.5 || z > 47.5) continue;
    out.push(surface(m, x, z, y0 + 2.5) - y0);
  }
  return out;
};

afterEach(() => { wallFootSnap.enabled = true; });

describe("wall foot (marching cubes)", () => {
  it("the old mesh shows the fillet; the squared one stands flat to the face", () => {
    const off = mesh(field, false), on = mesh(field, true);
    const offAt = fillets(off, 0.25), onAt = fillets(on, 0.25), on1 = fillets(on, 1);
    expect(offAt.length).toBeGreaterThan(10);
    expect(Math.max(...offAt)).toBeGreaterThan(0.4); // the fault this fixes is real on this lattice
    expect(Math.max(...onAt)).toBeLessThan(0.05);
    expect(Math.max(...on1)).toBeLessThan(0.05);
    expect(on.vertexCount).toBe(off.vertexCount);
  });

  it("moves nothing outside the foot band, and puts the floor vertices on the foot", () => {
    const off = mesh(field, false), on = mesh(field, true);
    const step = field.voxelSize;
    let moved = 0;
    for (let i = 0; i < off.positions.length; i += 3) {
      const dx = on.positions[i]! - off.positions[i]!, dy = on.positions[i + 1]! - off.positions[i + 1]!, dz = on.positions[i + 2]! - off.positions[i + 2]!;
      if (Math.hypot(dx, dy, dz) < 1e-6) continue;
      moved++;
      const x = off.positions[i]!, y = off.positions[i + 1]!, z = off.positions[i + 2]!;
      const onPlane = Math.abs(x) < 1e-4 || Math.abs(x - 48) < 1e-4 || Math.abs(z) < 1e-4 || Math.abs(z - 48) < 1e-4;
      const d = n(x, z) + 0.15;
      expect(d).toBeGreaterThan(0);
      expect(d).toBeLessThanOrEqual(step * Math.SQRT2 * 1.001);
      if (!onPlane) expect(y).toBeLessThanOrEqual(y0 + step * 1.001);
      // it lands on the back plane
      expect(Math.abs(n(on.positions[i]!, on.positions[i + 2]!) + 0.15)).toBeLessThan(1e-3);
    }
    expect(moved).toBeGreaterThan(10);
  });

  it("is a no-op on a cell no wall face reaches", () => {
    wallFootSnap.enabled = false;
    const a = buildVoxelMesh(field, { kind: "voxel", world: "t", cell: [3, 3], mesher: "mc" });
    wallFootSnap.enabled = true;
    const b = buildVoxelMesh(field, { kind: "voxel", world: "t", cell: [3, 3], mesher: "mc" });
    expect(Array.from(b.positions)).toEqual(Array.from(a.positions));
  });
});

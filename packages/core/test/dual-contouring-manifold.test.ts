import { expect, it } from "vitest";
import { CORNER_OFFSETS, dualContour } from "../src/index.js";

it("gives distinct indexed edges to separate face arcs in every corner configuration", () => {
  for (let mask = 1; mask < 255; mask++) {
    // Unequal magnitudes isolate indexed connectivity from coincident QEF
    // positions in perfectly symmetric saddle fields. Collapsed geometry is
    // covered separately by the imported vault/contact regressions.
    const n = 11, values = Float32Array.from({ length: n ** 3 }, (_, i) => 1 + ((i * 37) % 101) * 0.002);
    for (let corner = 0; corner < 8; corner++) if (mask & (1 << corner)) {
      const o = CORNER_OFFSETS[corner]!;
      values[4 + o[0] + (4 + o[1]) * n + (4 + o[2]) * n * n] = -1 - (corner + 1) * 0.2;
    }
    const mesh = dualContour({ values, nx: n, ny: n, nz: n, origin: [-2, -2, -2], step: 1 });
    const edges = new Map<string, number[]>();
    for (let i = 0; i < mesh.indices.length; i += 3) for (let e = 0; e < 3; e++) {
      const a = mesh.indices[i + e]!, b = mesh.indices[i + (e + 1) % 3]!, key = a < b ? `${a}:${b}` : `${b}:${a}`, signs = edges.get(key) ?? [];
      signs.push(a < b ? 1 : -1); edges.set(key, signs);
    }
    expect([...edges.values()].every((signs) => signs.length === 2 && signs[0]! + signs[1]! === 0), `corner mask ${mask}`).toBe(true);
  }
});

it.each([[3, 3, 3], [3, 2, 3]])("keeps separate solids apart when the second centre is (%s, %s, %s)", (sx, sy, sz) => {
  // The second case has diagonal inside corners on a shared face whose
  // centre is AIR. Static face pairing incorrectly joins the two spheres.
  const value = (x: number, y: number, z: number): number => Math.min(Math.hypot(x - 2, y - 2, z - 2), Math.hypot(x - sx, y - sy, z - sz)) - 0.4;
  const n = 13, values = new Float32Array(n ** 3);
  for (let k = 0; k < n; k++) for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) values[i + j * n + k * n * n] = value(i - 2, j - 2, k - 2);
  const mesh = dualContour({ values, nx: n, ny: n, nz: n, origin: [-2, -2, -2], step: 1 }, { pad: 2, hermite: {
    value,
    gradient: (x, y, z, out) => {
      const first = Math.hypot(x - 2, y - 2, z - 2) < Math.hypot(x - sx, y - sy, z - sz);
      out[0] = x - (first ? 2 : sx); out[1] = y - (first ? 2 : sy); out[2] = z - (first ? 2 : sz);
    },
  } });
  const parent = Array.from({ length: mesh.vertexCount }, (_, i) => i), used = new Set<number>(), edges = new Map<string, number[]>();
  const root = (i: number): number => { while (parent[i] !== i) i = parent[i]!; return i; };
  for (let i = 0; i < mesh.indices.length; i += 3) for (let e = 0; e < 3; e++) {
    const a = mesh.indices[i + e]!, b = mesh.indices[i + (e + 1) % 3]!;
    used.add(a); used.add(b); parent[root(a)] = root(b);
    const key = a < b ? `${a}:${b}` : `${b}:${a}`, signs = edges.get(key) ?? [];
    signs.push(a < b ? 1 : -1); edges.set(key, signs);
  }
  expect(new Set([...used].map(root)).size).toBe(2);
  expect([...edges.values()].every((signs) => signs.length === 2 && signs[0]! + signs[1]! === 0)).toBe(true);
  expect(mesh.triangleCount).toBe(24);
});

import { describe, expect, it } from "vitest";
import { buildVolumeMesh, compileTriangleMesh, createVolume, csgTriangleMeshSchema, dualContour, volumeDocSchema, type CsgTriangleMesh, type VoxelMesh } from "../src/index.js";

function cube(min = [-1, -1, -1], max = [1, 1, 1]): CsgTriangleMesh {
  return {
    positions: [min[0]!, min[1]!, min[2]!, max[0]!, min[1]!, min[2]!, max[0]!, max[1]!, min[2]!, min[0]!, max[1]!, min[2]!, min[0]!, min[1]!, max[2]!, max[0]!, min[1]!, max[2]!, max[0]!, max[1]!, max[2]!, min[0]!, max[1]!, max[2]!],
    indices: [0, 3, 2, 0, 2, 1, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 3, 7, 6, 3, 6, 2, 0, 4, 7, 0, 7, 3, 1, 2, 6, 1, 6, 5],
  };
}

function combine(...parts: CsgTriangleMesh[]): CsgTriangleMesh {
  const positions: number[] = [], indices: number[] = [], solidTriangleCounts: number[] = [];
  for (const part of parts) {
    const base = positions.length / 3;
    positions.push(...part.positions); indices.push(...part.indices.map((i) => i + base)); solidTriangleCounts.push(part.indices.length / 3);
  }
  return { positions, indices, solidTriangleCounts };
}

function convexExtrusion(outline: number[][], z0: number, z1: number): CsgTriangleMesh {
  const n = outline.length, positions = [z0, z1].flatMap((z) => outline.flatMap(([x, y]) => [x!, y!, z])), indices: number[] = [];
  for (let i = 1; i + 1 < n; i++) indices.push(0, i + 1, i, n, n + i, n + i + 1);
  for (let i = 0; i < n; i++) { const j = (i + 1) % n; indices.push(i, j, n + j, i, n + j, n + i); }
  return { positions, indices };
}

/** One concave closed solid, with a real through-passage under its lintel. */
function arch(): CsgTriangleMesh {
  const polygon = [[-3, 0], [-1, 0], [-1, 3], [1, 3], [1, 0], [3, 0], [3, 5], [-3, 5]];
  const n = polygon.length, positions = [-1, 1].flatMap((z) => polygon.flatMap(([x, y]) => [x!, y!, z]));
  // Cap triangles tile the U polygon; this is the source geometry, not CSG boxes.
  const cap = [[0, 1, 2], [0, 2, 7], [2, 3, 7], [3, 6, 7], [3, 4, 5], [3, 5, 6]];
  const indices = cap.flatMap(([a, b, c]) => [a!, c!, b!, a! + n, b! + n, c! + n]);
  for (let i = 0; i < n; i++) { const j = (i + 1) % n; indices.push(i, j, j + n, i, j + n, i + n); }
  return { positions, indices };
}

/** Weld block copies by exact coordinates, then require every edge twice with opposite winding. */
function expectClosed(mesh: VoxelMesh): void {
  const keys: string[] = [], edges = new Map<string, number[]>();
  for (let i = 0; i < mesh.positions.length; i += 3) keys.push(`${mesh.positions[i]},${mesh.positions[i + 1]},${mesh.positions[i + 2]}`);
  for (let i = 0; i < mesh.indices.length; i += 3) for (let k = 0; k < 3; k++) {
    const a = keys[mesh.indices[i + k]!]!, b = keys[mesh.indices[i + (k + 1) % 3]!]!;
    if (a === b) continue;
    const key = a < b ? `${a}|${b}` : `${b}|${a}`, signs = edges.get(key) ?? [];
    signs.push(a < b ? 1 : -1); edges.set(key, signs);
  }
  expect([...edges.values()].filter((v) => v.length !== 2 || v[0]! + v[1]! !== 0)).toEqual([]);
  for (let i = 0; i < mesh.indices.length; i += 3) {
    const a = mesh.indices[i]! * 3, b = mesh.indices[i + 1]! * 3, c = mesh.indices[i + 2]! * 3, p = mesh.positions;
    const ux = p[b]! - p[a]!, uy = p[b + 1]! - p[a + 1]!, uz = p[b + 2]! - p[a + 2]!;
    const vx = p[c]! - p[a]!, vy = p[c + 1]! - p[a + 1]!, vz = p[c + 2]! - p[a + 2]!;
    expect(Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx)).toBeGreaterThan(1e-10);
  }
}

describe("closed triangle CSG solids", () => {
  it("round-trips JSON, samples exact cube distances, and accepts reversed winding", () => {
    const mesh = cube(), reversed = { ...mesh, indices: mesh.indices.map((_, i, a) => a[Math.floor(i / 3) * 3 + 2 - i % 3]!) };
    const parsed = csgTriangleMeshSchema.parse(JSON.parse(JSON.stringify(mesh)));
    expect(parsed).toEqual(mesh);
    const a = compileTriangleMesh(parsed), b = compileTriangleMesh(reversed);
    for (const point of [[0, 0, 0], [0.4, -0.7, 0.2], [2, 2, 2], [0, 0, 1], [4, 0, 0]]) expect(a.distance(...point as [number, number, number])).toBeCloseTo(b.distance(...point as [number, number, number]), 10);
    expect(a.distance(0, 0, 0)).toBeCloseTo(-1, 10);
    expect(a.distance(2, 2, 2)).toBeCloseTo(Math.sqrt(3), 10);
    expect(a.distance(1, 0, 0)).toBeLessThan(0);
  });

  it("transforms off-origin mesh bounds and agrees between block/global samplers", () => {
    const volume = createVolume({ voxelSize: 0.25, nodes: [{ shape: "mesh", mesh: cube([2, 0, -1], [4, 2, 1]), position: [10, 3, -2], rotation: [0, Math.PI / 2, 0] }] });
    expect(volume.density(10, 4, -5)).toBeCloseTo(-1, 9);
    expect(volume.min).toEqual([8.25, 2.25, -6.75]);
    expect(volume.max[0]).toBeCloseTo(11.75, 9);
    expect(volume.max[2]).toBeCloseTo(-3.25, 9);
    const sample = volume.sampler([8, 2, -8], [12, 6, -1]);
    for (let x = 8; x <= 12; x += 0.3) for (let z = -8; z <= -1; z += 0.4) expect(sample(x, 4, z)).toBe(volume.density(x, 4, z));
    const distant = volume.sampler([100, 100, 100], [101, 101, 101]);
    expect(distant(100.5, 100.5, 100.5)).toBe(volume.density(100.5, 100.5, 100.5));
  });

  it("unions overlapping solids even when the nearest face belongs to an outside solid", () => {
    const mesh = combine(cube([-2, -2, -2], [2, 2, 2]), cube([0, -1, -1], [3, 1, 1]));
    const field = compileTriangleMesh(mesh);
    expect(field.distance(0.1, 0, 0)).toBeCloseTo(-1.9, 9);
    expect(field.distance(-0.1, 0, 0)).toBeCloseTo(-1.9, 9);
    expect(field.distance(2.5, 0, 0)).toBeCloseTo(-0.5, 9);
    expect(field.distance(2.5, 1.5, 0)).toBeCloseTo(0.5, 9);
  });

  it("preserves a nonconvex arch and a sealed cavity without relying on face winding", () => {
    const field = compileTriangleMesh(arch());
    expect(field.distance(0, 1.5, 0)).toBeGreaterThan(0);
    expect(field.distance(2, 1.5, 0)).toBeLessThan(0);
    expect(field.distance(0, 4, 0)).toBeLessThan(0);
    expect(field.distance(0, 1.5, 3)).toBeGreaterThan(0);
    const hollow = combine(cube([-3, -3, -3], [3, 3, 3]), cube());
    delete hollow.solidTriangleCounts;
    const cavity = compileTriangleMesh(hollow);
    expect(cavity.distance(0, 0, 0)).toBeCloseTo(1, 9);
    expect(cavity.distance(2, 0, 0)).toBeCloseTo(-1, 9);
    const normal = new Float64Array(3);
    cavity.normalAt(1, 0, 0, normal); expect(normal[0]).toBe(-1); expect(Math.hypot(normal[1]!, normal[2]!)).toBe(0);
    cavity.normalAt(3, 0, 0, normal); expect(normal[0]).toBe(1); expect(Math.hypot(normal[1]!, normal[2]!)).toBe(0);
  });

  it("classifies contact-aligned closed surfaces as solid without filling a real gap", () => {
    const touching = combine(cube([-2, -1, -1], [0, 1, 1]), cube([0, -1, -1], [2, 1, 1]));
    expect(compileTriangleMesh(touching).distance(0, 0, 0)).toBeLessThan(0);
    const gap = combine(cube([-2, -1, -1], [-0.000001, 1, 1]), cube([0.000001, -1, -1], [2, 1, 1]));
    expect(compileTriangleMesh(gap).distance(0, 0, 0)).toBeGreaterThan(0);
    const mesh = buildVolumeMesh(createVolume({ voxelSize: 0.25, nodes: [{ shape: "mesh", mesh: touching }] }));
    expectClosed(mesh);
    for (let i = 0; i < mesh.positions.length; i += 3) {
      const [x, y, z] = Array.from(mesh.positions.slice(i, i + 3));
      expect(Math.max(Math.abs(x!) / 2, Math.abs(y!), Math.abs(z!))).toBeGreaterThan(0.98);
    }
  });

  it("carves and intersects imported stamps, preserving source palette and subsequent paint", () => {
    const mesh = cube(); mesh.triangleMaterials = new Array(12).fill(1);
    const volume = createVolume({ palette: ["rock", "imported", "paint"], nodes: [{ shape: "box", size: [6, 6, 6] }, { shape: "mesh", op: "sub", mesh }], paint: [{ id: "repaint", center: [1, 0, 0], radius: 0.5, layer: 2, strength: 1, fill: true }] });
    expect(volume.density(0, 0, 0)).toBeGreaterThan(0);
    expect(volume.density(2, 0, 0)).toBeLessThan(0);
    const weights = new Float32Array(6);
    volume.surfaceAt(-1, 0, 0, 0, weights, 0, 1, 0); expect(Array.from(weights.slice(0, 3))).toEqual([0, 1, 0]);
    volume.surfaceAt(1, 0, 0, 0, weights, 0, -1, 0); expect(Array.from(weights.slice(0, 3))).toEqual([0, 0, 1]);
    const clipped = createVolume({ palette: ["rock", "imported"], nodes: [{ shape: "box", size: [8, 8, 8] }, { shape: "mesh", op: "intersect", mesh }] });
    expect(clipped.density(0, 0, 0)).toBeLessThan(0); expect(clipped.density(2, 0, 0)).toBeGreaterThan(0);
    expect(volumeDocSchema.parse(JSON.parse(JSON.stringify(volume.doc)))).toEqual(volume.doc);
  });

  it("extracts the arch with its opening, closed topology, and measured extents", () => {
    const volume = createVolume({ voxelSize: 0.25, nodes: [{ shape: "mesh", mesh: arch() }] });
    const mesh = buildVolumeMesh(volume);
    expect(mesh.triangleCount).toBeGreaterThan(500);
    expect([...mesh.positions, ...mesh.normals].every(Number.isFinite)).toBe(true);
    expectClosed(mesh);
    expect(mesh.min[0]).toBeCloseTo(-3, 2); expect(mesh.max[0]).toBeCloseTo(3, 2); expect(mesh.max[1]).toBeCloseTo(5, 2);
    // No extracted face may span the open passage's middle.
    for (let i = 0; i < mesh.positions.length; i += 3) {
      const x = mesh.positions[i]!, y = mesh.positions[i + 1]!, z = mesh.positions[i + 2]!;
      expect(Math.abs(x) < 0.9 && y > 0.1 && y < 2.9 && Math.abs(z) < 0.9).toBe(false);
    }
  });

  it("keeps touching curved and rectangular solids conforming on a contact-aligned lattice", () => {
    const bottom = Math.fround(1.2), z0 = -0.5, z1 = 0.5;
    const outline: number[][] = [[-3, bottom], [3, bottom]];
    for (let i = 1; i < 12; i++) outline.push([3 * Math.cos(i * Math.PI / 12), bottom + 1.2 * Math.sin(i * Math.PI / 12)]);
    const n = outline.length, positions = [z0, z1].flatMap((z) => outline.flatMap(([x, y]) => [x!, y!, z])), indices: number[] = [];
    for (let i = 1; i + 1 < n; i++) indices.push(0, i + 1, i, n, n + i, n + i + 1);
    for (let i = 0; i < n; i++) { const j = (i + 1) % n; indices.push(i, j, n + j, i, n + j, n + i); }
    const mesh = combine({ positions, indices }, cube([-0.8, -0.8, z0], [0, bottom, z1]), cube([0, -0.8, z0], [0.8, bottom, z1]));
    const volume = createVolume({ voxelSize: 0.12, bounds: { min: [-3.48, -1.2, -0.96], max: [3.48, 3, 0.96] }, nodes: [{ shape: "mesh", mesh }] });
    expectClosed(buildVolumeMesh(volume));
  });

  it("does not manufacture opposite triangles when a vault quad's opposite corners coincide", () => {
    const f32 = (n: number): number => Number(Math.fround(n).toFixed(9));
    const cap = [[-12.5, f32(7.2)], [12.5, f32(7.2)]];
    for (let i = 1; i < 24; i++) cap.push([f32(12.5 * Math.cos(i * Math.PI / 24)), f32(7.2 + 2.8 * Math.sin(i * Math.PI / 24))]);
    const source = combine(
      convexExtrusion([[6.25, 9.624871254], [6.525000095, 10.304775238], [4.994018555, 10.475444794], [4.78354311, 9.786862373]], -40.5, -23.5),
      convexExtrusion([[4.78354311, 9.786862373], [4.994018555, 10.475444794], [3.377588511, 10.599481583], [3.235238075, 9.904592514]], -40.5, -23.5),
      convexExtrusion(cap, -24.5, -23.5),
    );
    // Sample only the small problem patch, on the same lattice phase. Open
    // edges on its crop boundary are expected; four incident facets are not.
    const mesh = buildVolumeMesh(createVolume({ voxelSize: 0.12, bounds: { min: [4.56, 9.48, -23.76], max: [5.16, 10.2, -23.28] }, nodes: [{ shape: "mesh", mesh: source }] }));
    const keys: string[] = [], edges = new Map<string, number>();
    for (let i = 0; i < mesh.positions.length; i += 3) keys.push(`${mesh.positions[i]},${mesh.positions[i + 1]},${mesh.positions[i + 2]}`);
    for (let i = 0; i < mesh.indices.length; i += 3) for (let e = 0; e < 3; e++) {
      const a = keys[mesh.indices[i + e]!]!, b = keys[mesh.indices[i + (e + 1) % 3]!]!, key = a < b ? `${a}|${b}` : `${b}|${a}`;
      edges.set(key, (edges.get(key) ?? 0) + 1);
    }
    expect(mesh.triangleCount).toBeGreaterThan(20);
    expect([...edges.values()].filter((count) => count > 2)).toEqual([]);
  });

  it("computes identical ridge vertices and normals in adjacent blocks at a 0.12 metre step", () => {
    const mesh = combine(
      convexExtrusion([[1.370525002, 7.976045609], [1.442314386, 8.674762726], [0, 8.699999809], [0, 8]], -96.5, -79.5),
      convexExtrusion([[0, 8], [0, 8.699999809], [-1.442314386, 8.674762726], [-1.370525002, 7.976045609]], -96.5, -79.5),
    );
    const volume = createVolume({ nodes: [{ shape: "mesh", mesh }] }), step = 0.12, n = 29;
    const latticeOrigin: [number, number, number] = [-11.52, -3.24, -97.08];
    const blocks = [72, 96].map((bx) => {
      const offset: [number, number, number] = [bx - 2, 70, -2];
      const origin = offset.map((o, a) => latticeOrigin[a]! + o * step) as [number, number, number], values = new Float32Array(n ** 3);
      for (let k = 0; k < n; k++) for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
        values[i + j * n + k * n * n] = volume.density(latticeOrigin[0] + (offset[0] + i) * step, latticeOrigin[1] + (offset[1] + j) * step, latticeOrigin[2] + (offset[2] + k) * step);
      }
      const result = dualContour({ values, nx: n, ny: n, nz: n, origin, step }, { lattice: { origin: latticeOrigin, offset }, hermite: {
        value: volume.density, gradient: (x, y, z, out) => { volume.surfaceNormalAt!(x, y, z, out); },
      } });
      const shared: string[] = [];
      for (let i = 0; i < result.positions.length; i += 3) if (result.positions[i]! > 0 && result.positions[i]! < 0.12 && result.positions[i + 1]! > 7.9) {
        shared.push(`${Array.from(result.positions.slice(i, i + 3))}|${Array.from(result.normals.slice(i, i + 3))}`);
      }
      return shared.sort();
    });
    expect(blocks[0]!.length).toBeGreaterThan(10);
    expect(blocks[0]).toEqual(blocks[1]);
  });

  it("does not infer a distance bound from an adapter's empty node metadata", () => {
    const base = createVolume({ voxelSize: 0.25, nodes: [{ shape: "sphere", radius: 1, position: [1.5, 0, 0] }] });
    const density = (x: number, y: number, z: number): number => 100 * (Math.hypot(x - 1.5, y, z) - 1);
    const adapter = { ...base, doc: { ...base.doc, nodes: [] }, min: [-3, -3, -3] as [number, number, number], max: [3, 3, 3] as [number, number, number], approximate: true, density, sampler: () => density };
    expect(buildVolumeMesh(adapter).triangleCount).toBeGreaterThan(100);
  });

  it.each([
    ["missing mesh", { shape: "mesh" }],
    ["nonfinite", { shape: "mesh", mesh: { ...cube(), positions: [NaN, ...cube().positions.slice(1)] } }],
    ["invalid index", { shape: "mesh", mesh: { ...cube(), indices: [99, ...cube().indices.slice(1)] } }],
    ["fractional index", { shape: "mesh", mesh: { ...cube(), indices: [0.5, ...cube().indices.slice(1)] } }],
    ["count mismatch", { shape: "mesh", mesh: { ...cube(), solidTriangleCounts: [8] } }],
    ["material mismatch", { shape: "mesh", mesh: { ...cube(), triangleMaterials: [0] } }],
    ["palette index", { shape: "mesh", mesh: { ...cube(), triangleMaterials: new Array(12).fill(2) } }],
    ["open surface", { shape: "mesh", mesh: { ...cube(), indices: cube().indices.slice(3) } }],
    ["zero-area face", { shape: "mesh", mesh: { ...cube(), indices: [0, 0, 0, ...cube().indices.slice(3)] } }],
    ["inconsistent winding", { shape: "mesh", mesh: { ...cube(), indices: [0, 2, 3, ...cube().indices.slice(3)] } }],
    ["nonmanifold edge", { shape: "mesh", mesh: { ...cube(), indices: [...cube().indices, 0, 3, 2] } }],
  ])("rejects %s", (_name, node) => expect(() => volumeDocSchema.parse({ nodes: [node] })).toThrow());

  it("rejects intersecting boundary shells within a single solid", () => {
    const mesh = combine(cube(), cube([0, 0, 0], [2, 2, 2])); delete mesh.solidTriangleCounts;
    expect(() => csgTriangleMeshSchema.parse(mesh)).toThrow(/self-intersects/);
  });
});

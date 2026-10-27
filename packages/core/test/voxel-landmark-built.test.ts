import { describe, expect, it } from "vitest";
import { buildLandmarkMesh, compileLandmarkSpec, compileOperator, type BuiltGroup } from "../src/index.js";

const compile = (parts: unknown[], roles: Record<string, unknown> = {}) => compileLandmarkSpec({ version: 1, roles, parts }, { voxel: 0.5, skipThin: true });

/** Signed volume by the divergence theorem (exact for a closed outward mesh, T-junctions included). */
function volume(groups: BuiltGroup[]): number {
  let v = 0;
  for (const g of groups) for (let t = 0; t < g.indices.length; t += 3) {
    const p = [0, 1, 2].map((e) => { const i = g.indices[t + e]! * 3; return [g.positions[i]!, g.positions[i + 1]!, g.positions[i + 2]!]; });
    const [a, b, c] = p as [number[], number[], number[]];
    v += a[0]! * (b[1]! * c[2]! - b[2]! * c[1]!) - a[1]! * (b[0]! * c[2]! - b[2]! * c[0]!) + a[2]! * (b[0]! * c[1]! - b[1]! * c[0]!);
  }
  return v / 6;
}
const area = (groups: BuiltGroup[]) => { let s = 0; for (const g of groups) for (let t = 0; t < g.indices.length; t += 3) {
  const p = [0, 1, 2].map((e) => Array.from(g.positions.subarray(g.indices[t + e]! * 3, g.indices[t + e]! * 3 + 3)));
  const u = p[1]!.map((x, k) => x - p[0]![k]!), w = p[2]!.map((x, k) => x - p[0]![k]!);
  s += Math.hypot(u[1]! * w[2]! - u[2]! * w[1]!, u[2]! * w[0]! - u[0]! * w[2]!, u[0]! * w[1]! - u[1]! * w[0]!) / 2;
} return s; };

describe("built landmark mesh (kind: built)", () => {
  it("is deterministic and closed (box, lathe, cylinder, extrude, arch: outward winding)", () => {
    const c = compile([
      { name: "b", shape: "box", size: [4, 3, 2], at: [0, 1.5, 0], role: "masonry" },
      { name: "l", shape: "lathe", segments: 8, profile: [[2, 0], [1, 4]], at: [20, 0, 0], role: "masonry" },
      { name: "c", shape: "cylinder", r: 1, h: 2, at: [-20, 0, 0], role: "masonry" },
      { name: "e", shape: "extrude", polygon: [[0, 0], [3, 0], [3, 3], [1.5, 1.5], [0, 3]], h: 2, at: [0, 0, 20], role: "masonry" },
      { name: "a", shape: "arch", span: 4, rise: 2, legs: 2, thickness: 1, depth: 2, at: [0, 0, -20], role: "trim" },
    ]);
    const a = buildLandmarkMesh(c), b = buildLandmarkMesh(c);
    expect(Array.from(a.groups[0]!.positions)).toEqual(Array.from(b.groups[0]!.positions));
    expect(Array.from(a.groups[0]!.uvs)).toEqual(Array.from(b.groups[0]!.uvs));
    const one = (part: unknown) => volume(buildLandmarkMesh(compile([part])).groups);
    expect(one({ shape: "box", size: [4, 3, 2], role: "m" })).toBeCloseTo(24, 4);
    expect(one({ shape: "extrude", polygon: [[0, 0], [3, 0], [3, 3], [1.5, 1.5], [0, 3]], h: 2, role: "m" })).toBeCloseTo((9 - 2.25) * 2, 3);
    expect(one({ shape: "cylinder", r: 1, h: 2, segments: 8, role: "m" })).toBeCloseTo(2 * Math.SQRT2 * 2, 3); // octagon area 2*sqrt2 r^2
    expect(one({ shape: "arch", span: 4, rise: 2, legs: 0, thickness: 1, depth: 2, segments: 16, role: "m" })).toBeGreaterThan(0);
  });

  it("maps UVs in metres at the role tile: a 128 px texture over 3.2 m = 40 texels/m, v up, u to the viewer's right", () => {
    const c = compile([{ name: "w", shape: "box", size: [8, 6, 2], at: [0, 3, 0], role: "masonry" }]);
    const g = buildLandmarkMesh(c, { tile: () => [128 / 40, 128 / 40] }).groups[0]!;
    // front (+z) face vertices: du/dx and dv/dy in texture repeats per metre, x 128 px = texels per metre
    const front: number[] = [];
    for (let i = 0; i < g.vertexCount; i++) if (g.normals[i * 3 + 2]! > 0.99) front.push(i);
    const lo = front.reduce((a, i) => (g.positions[i * 3]! + g.positions[i * 3 + 1]! < g.positions[a * 3]! + g.positions[a * 3 + 1]! ? i : a));
    const hi = front.reduce((a, i) => (g.positions[i * 3]! + g.positions[i * 3 + 1]! > g.positions[a * 3]! + g.positions[a * 3 + 1]! ? i : a));
    const dx = g.positions[hi * 3]! - g.positions[lo * 3]!, dy = g.positions[hi * 3 + 1]! - g.positions[lo * 3 + 1]!;
    expect(((g.uvs[hi * 2]! - g.uvs[lo * 2]!) / dx) * 128).toBeCloseTo(40, 6);
    expect(((g.uvs[hi * 2 + 1]! - g.uvs[lo * 2 + 1]!) / dy) * 128).toBeCloseTo(40, 6);
    // the role tile in the spec is the fallback
    const c2 = compile([{ name: "w", shape: "box", size: [8, 6, 2], role: "masonry" }], { masonry: { tile: [2, 2] } });
    const g2 = buildLandmarkMesh(c2).groups[0]!;
    expect(Math.max(...g2.uvs) - Math.min(...g2.uvs)).toBeCloseTo(4, 6); // 8 m / 2 m
  });

  it("groups by role (one draw per material) and drops faces hidden inside other solids", () => {
    const c = compile([
      { name: "wall", shape: "box", size: [10, 4, 2], at: [0, 2, 0], role: "masonry" },
      { name: "band", shape: "box", size: [10.4, 1, 2.4], at: [0, 2, 0], role: "trim" },
      { name: "cap", shape: "box", size: [10, 1, 2], at: [0, 4.5, 0], role: "masonry" },
    ]);
    const m = buildLandmarkMesh(c);
    expect(m.groups.map((g) => g.role)).toEqual(["masonry", "trim"]);
    // union volume: wall 80 + band overhang (10.4*2.4 - 10*2) * 1 + cap 20
    expect(volume(m.groups)).toBeCloseTo(80 + (10.4 * 2.4 - 20) + 20, 3);
    // no internal faces: the wall/cap interface is gone (surface area = the union's)
    const union = 160 + 20.8 + 4.8 + 9.92 - 24;
    expect(area(m.groups)).toBeCloseTo(union, 3);
  });

  it("cuts an opening with a convex sub and builds its reveal in the wall's material", () => {
    const c = compile([
      { name: "wall", shape: "box", size: [10, 8, 2], at: [0, 4, 0], role: "masonry" },
      { name: "door", op: "sub", shape: "box", size: [3, 5, 4], at: [0, 2.5, 0], role: "masonry" },
    ]);
    const m = buildLandmarkMesh(c);
    expect(volume(m.groups)).toBeCloseTo(160 - 3 * 5 * 2, 3);
    const g = m.groups[0]!;
    let jamb = 0, soffit = 0;
    for (let i = 0; i < g.vertexCount; i++) {
      const x = g.positions[i * 3]!, nx = g.normals[i * 3]!, ny = g.normals[i * 3 + 1]!;
      if (Math.abs(Math.abs(x) - 1.5) < 1e-4 && Math.abs(nx) > 0.99 && Math.sign(nx) === -Math.sign(x)) jamb++;
      if (ny < -0.99 && Math.abs(g.positions[i * 3 + 1]! - 5) < 1e-4) soffit++;
    }
    expect(jamb).toBeGreaterThan(0);
    expect(soffit).toBeGreaterThan(0);
    expect(() => buildLandmarkMesh(compile([{ shape: "box", size: [4, 4, 4], role: "m" }, { op: "sub", shape: "lathe", profile: [[2, 0], [1, 1], [2, 2]], role: "m" }]))).toThrow(/not convex/);
  });

  it("maps a uvRegion face once, upright and not mirrored (the flat-art flipY rule)", () => {
    const c = compile([{ name: "relief", shape: "box", size: [2, 4, 0.3], at: [0, 2, 0], role: "relief", uvRegion: { rect: [0, 0, 1, 1], face: "+z" } }]);
    const g = buildLandmarkMesh(c).groups[0]!;
    for (let i = 0; i < g.vertexCount; i++) if (g.normals[i * 3 + 2]! > 0.99) {
      const x = g.positions[i * 3]!, y = g.positions[i * 3 + 1]!;
      expect(g.uvs[i * 2]!).toBeCloseTo((x + 1) / 2, 6); // u rises to the viewer's right
      expect(g.uvs[i * 2 + 1]!).toBeCloseTo(y / 4, 6); // v = 1 - row: the image top at the top
    }
  });

  it("the operator takes kind: built (own digest, no thin-wall refusal)", () => {
    const flat = { height: () => 100, voxelSize: 2, seaLevel: 0, seed: 7 };
    const doc = (kind: string, t = 0.3) => ({ id: "gate", op: "landmark", kind, at: [0, 0], blend: { mode: "none" }, source: { csg: { version: 1, parts: [{ shape: "box", size: [6, 6, t], at: [0, 3, 0], role: "masonry" }] } } });
    const prefab = (o: ReturnType<typeof compileOperator>) => (o.pieces.find((p) => p.kind === "landmarks")!.feature as { prefab: string }).prefab;
    const built = prefab(compileOperator(doc("built"), flat));
    expect(built).toMatch(/^landmarks\/gate-/);
    expect(prefab(compileOperator(doc("built", 2), flat))).not.toBe(prefab(compileOperator(doc("stamp", 2), flat))); // kind is part of the bake
  });
});

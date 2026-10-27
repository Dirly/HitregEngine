import { describe, expect, it } from "vitest";
import { buildLandmarkMesh, compileLandmarkSpec, type BuiltGroup } from "../src/index.js";

const compile = (parts: unknown[], roles: Record<string, unknown> = {}) => compileLandmarkSpec({ version: 1, roles, parts }, { voxel: 0.5, skipThin: true });
function volume(groups: BuiltGroup[]): number {
  let v = 0;
  for (const g of groups) for (let t = 0; t < g.indices.length; t += 3) {
    const [a, b, c] = [0, 1, 2].map((e) => { const i = g.indices[t + e]! * 3; return [g.positions[i]!, g.positions[i + 1]!, g.positions[i + 2]!]; }) as [number[], number[], number[]];
    v += a[0]! * (b[1]! * c[2]! - b[2]! * c[1]!) - a[1]! * (b[0]! * c[2]! - b[2]! * c[0]!) + a[2]! * (b[0]! * c[1]! - b[1]! * c[0]!);
  }
  return v / 6;
}
const tris = (groups: BuiltGroup[]) => groups.reduce((a, g) => a + g.triangleCount, 0);

describe("built landmark bevel (chamfered boxes)", () => {
  it("chamfers every edge: 26 faces, closed, a little less volume than the box", () => {
    const X = 4, Y = 3, Z = 2, b = 0.25;
    const plain = buildLandmarkMesh(compile([{ shape: "box", size: [X, Y, Z], role: "m" }]));
    const bev = buildLandmarkMesh(compile([{ shape: "box", size: [X, Y, Z], role: "m", bevel: b }]));
    expect(tris(plain.groups)).toBe(12);
    expect(tris(bev.groups)).toBe(6 * 2 + 12 * 2 + 8); // faces + edge strips (quads) + corner triangles
    const v = volume(bev.groups), edges = 4 * (X + Y + Z);
    expect(v).toBeLessThan(X * Y * Z - (b * b / 2) * (edges - 24 * b) + 1e-6);
    expect(v).toBeGreaterThan(X * Y * Z - (b * b / 2) * edges - 8 * b ** 3);
    // closed and outward: the divergence volume does not move with the part
    const moved = buildLandmarkMesh(compile([{ shape: "box", size: [X, Y, Z], role: "m", bevel: b, at: [30, 10, -5], rot: [0, 37, 0] }]));
    expect(volume(moved.groups)).toBeCloseTo(v, 4);
  });

  it("takes the role default, a part's own bevel wins, and it is clamped below half the smallest side", () => {
    const role = buildLandmarkMesh(compile([{ shape: "box", size: [2, 2, 2], role: "m" }], { m: { bevel: 0.2 } }));
    expect(tris(role.groups)).toBe(44);
    const off = buildLandmarkMesh(compile([{ shape: "box", size: [2, 2, 2], role: "m", bevel: 0 }], { m: { bevel: 0.2 } }));
    expect(tris(off.groups)).toBe(12);
    const huge = buildLandmarkMesh(compile([{ shape: "box", size: [1, 1, 1], role: "m", bevel: 3 }]));
    expect(volume(huge.groups)).toBeGreaterThan(0.2);
  });

  it("enters the digest only when set, and leaves the DC nodes alone", () => {
    const a = compile([{ shape: "box", size: [4, 3, 2], role: "m" }]), b = compile([{ shape: "box", size: [4, 3, 2], role: "m", bevel: 0.2 }]);
    expect(a.digest).not.toBe(b.digest);
    expect(b.nodes).toEqual(a.nodes);
    expect(compile([{ shape: "box", size: [4, 3, 2], role: "m" }]).digest).toBe(a.digest);
  });

  it("a bevelled block stays convex: a doorway cut through it still gets its reveal", () => {
    const c = compile([
      { shape: "box", size: [6, 4, 2], at: [0, 2, 0], role: "m", bevel: 0.2 },
      { op: "sub", shape: "box", size: [1.5, 2.5, 3], at: [0, 1.75, 0] }, // clear of the chamfers (a window)
    ]);
    const m = buildLandmarkMesh(c);
    expect(m.revealSkipped).toEqual([]);
    expect(volume(m.groups)).toBeCloseTo(volume(buildLandmarkMesh(compile([{ shape: "box", size: [6, 4, 2], at: [0, 2, 0], role: "m", bevel: 0.2 }])).groups) - 1.5 * 2.5 * 2, 3);
  });
});

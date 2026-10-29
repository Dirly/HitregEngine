import { describe, expect, it } from "vitest";
import { decalCoverage, decalFrame, findZFights, type ZFightMesh } from "../src/index.js";

/** A horizontal quad (two triangles, facing +y, or -y when `down`) at height y over [x0,x1] x [z0,z1]. */
function quadY(y: number, x0: number, x1: number, z0: number, z1: number, down = false): number[] {
  const a = [x0, y, z0], b = [x1, y, z0], c = [x1, y, z1], d = [x0, y, z1];
  // counter-clockwise seen from +y: a, d, c / a, c, b
  const up = [...a, ...d, ...c, ...a, ...c, ...b];
  const dn = [...a, ...c, ...d, ...a, ...b, ...c];
  return down ? dn : up;
}
/** A vertical quad facing +z at depth z over [x0,x1] x [y0,y1]. */
function quadZ(z: number, x0: number, x1: number, y0: number, y1: number): number[] {
  const a = [x0, y0, z], b = [x1, y0, z], c = [x1, y1, z], d = [x0, y1, z];
  return [...a, ...b, ...c, ...a, ...c, ...d];
}
const mesh = (id: string, positions: number[], extra: Partial<ZFightMesh> = {}): ZFightMesh => ({ id, positions: new Float32Array(positions), ...extra });

describe("findZFights", () => {
  it("finds two stacked quads from different meshes", () => {
    const r = findZFights([mesh("shell", quadY(0, 0, 2, 0, 2)), mesh("floor", quadY(0.005, 1, 3, 0, 2))]);
    expect(r.clusters).toHaveLength(1);
    const c = r.clusters[0]!;
    expect(c.area).toBeCloseTo(2, 2);
    expect(new Set([c.a.mesh, c.b.mesh])).toEqual(new Set(["shell", "floor"]));
    expect(c.normal[1]).toBeCloseTo(1, 3);
    expect(c.centre[0]).toBeCloseTo(1.5, 2);
    expect(r.byMeshPair[0]!.area).toBeCloseTo(2, 2);
  });
  it("ignores quads 3 cm apart", () => {
    expect(findZFights([mesh("a", quadY(0, 0, 2, 0, 2)), mesh("b", quadY(0.03, 0, 2, 0, 2))]).clusters).toHaveLength(0);
  });
  it("ignores opposite-facing coincident quads", () => {
    expect(findZFights([mesh("a", quadY(0, 0, 2, 0, 2)), mesh("b", quadY(0, 0, 2, 0, 2, true))]).clusters).toHaveLength(0);
  });
  it("ignores quads that only share an edge", () => {
    expect(findZFights([mesh("a", quadY(0, 0, 1, 0, 2)), mesh("b", quadY(0, 1, 2, 0, 2))]).clusters).toHaveLength(0);
  });
  it("ignores the same mesh and material, flags the same mesh with two materials", () => {
    const both = [...quadY(0, 0, 2, 0, 2), ...quadY(0.01, 0, 2, 0, 2)];
    expect(findZFights([mesh("m", both)]).clusters).toHaveLength(0);
    const r = findZFights([mesh("m", both, { triMaterial: [0, 0, 1, 1], materials: ["stone", "moss"] })]);
    expect(r.clusters).toHaveLength(1);
    expect(new Set([r.clusters[0]!.a.material, r.clusters[0]!.b.material])).toEqual(new Set(["stone", "moss"]));
  });
  it("splits far-apart overlaps into separate clusters", () => {
    const r = findZFights([mesh("a", [...quadY(0, 0, 1, 0, 1), ...quadY(0, 10, 11, 0, 1)]), mesh("b", [...quadY(0, 0, 1, 0, 1), ...quadY(0, 10, 11, 0, 1)])]);
    expect(r.clusters).toHaveLength(2);
  });
  it("runs a large soup quickly", () => {
    // 200 x 200 grid of small quads (80k tris) over a coincident second grid shifted by half a cell
    const g = (off: number) => { const out: number[] = []; for (let i = 0; i < 200; i++) for (let j = 0; j < 200; j++) out.push(...quadY(0, i * 0.1 + off, i * 0.1 + 0.1 + off, j * 0.1, j * 0.1 + 0.1)); return out; };
    const r = findZFights([mesh("a", g(0)), mesh("b", g(0.05))]);
    expect(r.triangles).toBe(160000);
    expect(r.clusters).toHaveLength(1);
    expect(r.clusters[0]!.area).toBeGreaterThan(390);
    expect(r.ms).toBeLessThan(15000);
  }, 20_000); // its own budget is r.ms < 15 s; the 5 s runner default cut it short under a parallel suite
});

describe("decalCoverage", () => {
  // a wall facing +z at z=0 (owner 0), a 0.5 m wide beam front face at z=0.3 across the middle (owner 1)
  const wall = quadZ(0, -2, 2, -2, 2);
  const beam = quadZ(0.3, -0.25, 0.25, -2, 2);
  const soup = [...wall, ...beam];
  const owners = [0, 0, 1, 1];
  const frame = decalFrame({ position: [0, 0, 0.05], rotation: [0, 0, 0, 1], size: [2, 2], depth: 0.8 });
  it("builds the projector box like the renderer (projects down -z by default)", () => {
    expect(frame.z[2]).toBeCloseTo(1, 6);
    expect(frame.half).toEqual([1, 1, 0.4]);
    const down = decalFrame({ position: [0, 0, 0], rotation: [0, 0, 0, 1], size: [1, 1], depth: 1, direction: [0, -1, 0] });
    expect(down.z[1]).toBeCloseTo(1, 6); // projection along -z = world -y
  });
  it("a beam in front of the wall blocks its width", () => {
    const c = decalCoverage(soup, owners, frame, { grid: 40 });
    expect(c.blockedShare).toBeCloseTo(0.25, 1);
    expect(c.emptyShare).toBe(0);
    expect([...c.blockers.keys()]).toEqual([1]);
  });
  it("past the wall's edge is empty", () => {
    const off = decalFrame({ position: [1.5, 0, 0.05], rotation: [0, 0, 0, 1], size: [2, 2], depth: 0.4 });
    const c = decalCoverage(wall, [0, 0], off, { grid: 40 });
    expect(c.emptyShare).toBeCloseTo(0.25, 1);
    expect(c.blockedShare).toBe(0);
  });
});

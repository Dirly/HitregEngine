import { describe, expect, it } from "vitest";
import { buildShoreGrid, formationMembers, nearestShore, outerBend, refineShore } from "../src/voxel/formations.js";
import type { WorldField } from "../src/voxel/field.js";
import { defaultWorldRecipe, worldRecipeSchema } from "../src/index.js";
import { scatterFormationSchema } from "../src/voxel/recipe.js";

/** A stub field: a lake at level 0 over a bank rising 0.2 m per metre east (ground = 0.2 x), so the waterline is x = 0. */
function bankField(ground = (x: number, _z: number) => 0.2 * x): WorldField {
  return {
    recipe: { seaLevel: -100 },
    voxelSize: 1,
    height: ground,
    slope: () => 0.2,
    waterSurface: (x: number, _z: number, out: { y: number; kind: string; flowX: number; flowZ: number; floor: number }) => {
      if (x > 30) return false;
      out.y = 0; out.kind = "lake"; out.flowX = 0; out.flowZ = 0; out.floor = -Infinity;
      return true;
    },
    rivers: [],
  } as unknown as WorldField;
}

describe("shore grid (water snap)", () => {
  it("finds the waterline crossing, its into-the-water direction and how far the water wraps round", () => {
    const field = bankField();
    const grid = buildShoreGrid(field, -40, -40, 40, 40, 8, false);
    const p = nearestShore(grid, 3, 5, 6, 1, 6)!;
    expect(p).not.toBeNull();
    expect(Math.abs(p.x)).toBeLessThan(1e-6);
    expect(p.inX).toBeCloseTo(-1);
    expect(p.level).toBe(0);
    expect(p.kind).toBe(1);
    // a straight bank: under half the (coarse) ring is water; a spit with water on three sides reads far more
    expect(p.wet).toBeGreaterThan(0.1);
    expect(p.wet).toBeLessThan(0.6);
    const spit = bankField((x, z) => (Math.abs(z) < 6 && x < 10 ? 1 - 0.1 * Math.abs(z) : 0.2 * x - 3));
    const tip = nearestShore(buildShoreGrid(spit, -40, -40, 40, 40, 8, false), -2, 0, 12, 1, 8);
    expect(tip).not.toBeNull();
    expect(tip!.wet).toBeGreaterThan(p.wet);
    // out of reach, and the wrong kind of water, answer null
    expect(nearestShore(grid, 20, 5, 6, 1, 6)).toBeNull();
    expect(nearestShore(grid, 3, 5, 6, 2, 6)).toBeNull();
  });

  it("refines a coarse crossing onto the real waterline of a curved bank", () => {
    // a V bank: flat bed 2 m deep, then a steep wall: the 8 m grid's linear crossing misses the edge by metres
    const ground = (x: number) => (x < -2 ? -2 : x < 2 ? x : 2 + (x - 2) * 0.1);
    const field = bankField(ground);
    const grid = buildShoreGrid(field, -40, -40, 40, 40, 8, false);
    const p = nearestShore(grid, 1, 0, 8, 1, 6)!;
    refineShore(field, p, 8);
    expect(Math.abs(ground(p.x))).toBeLessThan(0.1);
  });
});

describe("stepping stones (formation steps)", () => {
  it("runs evenly ACROSS the current", () => {
    const field = bankField(() => 0);
    const rule = worldRecipeSchema.parse({ ...defaultWorldRecipe(), scatter: [{ id: "s", model: "m.glb", colliderSize: [0.8, 0.5, 0.8], scale: [1, 1] }] }).scatter[0]!;
    const f = scatterFormationSchema.parse({ kinds: [{ kind: "steps" }], members: [7, 7], gap: [0.6, 0.6], contour: false, fillers: 0 });
    const members = formationMembers(field, rule, f, 0, 0, 0, 1, 0, 3, 4, 1, () => 0, [1, 0]);
    expect(members.length).toBe(7);
    expect(members.filter((m) => m.anchor).length).toBe(1);
    // current along +x: the run strikes along z, a hand off the line at most
    for (const m of members) expect(Math.abs(m.x)).toBeLessThan(0.35);
    const zs = members.map((m) => m.z).sort((a, b) => a - b);
    for (let i = 1; i < zs.length; i++) expect(zs[i]! - zs[i - 1]!).toBeGreaterThan(0.8);
    // a refused stone leaves a gap; the run carries on past it
    const gapped = formationMembers(field, rule, f, 0, 0, 0, 1, 0, 3, 4, 1, (_x, z) => (Math.abs(z) > 1 && Math.abs(z) < 3 ? null : 0), [1, 0]);
    expect(gapped.length).toBeLessThan(7);
    expect(gapped.some((m) => Math.abs(m.z) > 3)).toBe(true);
  });
});

describe("river bends (water bend)", () => {
  it("is the turn on the OUTER bank and 0 on the inner one", () => {
    // east 0..100, then north: a left turn (in x/z, +z is the turn side) at (100, 0)
    const points: [number, number][] = [];
    for (let x = 0; x <= 100; x += 5) points.push([x, 0]);
    for (let z = 5; z <= 100; z += 5) points.push([100, z]);
    const field = { rivers: [{ id: "r", points, width: 10 }] } as unknown as WorldField;
    const outer = outerBend(field, 104, -4);
    const inner = outerBend(field, 96, 4);
    expect(outer).toBeGreaterThan(0.5);
    expect(inner).toBe(0);
    // far from any river: no bend
    expect(outerBend(field, 300, 300)).toBe(0);
  });
});

import { describe, expect, it } from "vitest";
import {
  applyRecipeEdits,
  createWorldField,
  defaultWorldRecipe,
  latticeHeight,
  measureTerrainLips,
  prepareHeightPatch,
  seatReport,
  tentFilterRaster,
  worldRecipeSchema,
  type HeightPatchDoc,
} from "../src/index.js";

/** A flat world at y=10 everywhere (one big level patch), then the patch under test on top. */
function flatWorld(extra: unknown[]): ReturnType<typeof createWorldField> {
  const raw = defaultWorldRecipe();
  raw.terrain.overhang.strength = 0;
  raw.terrain.caves.enabled = false;
  const base = worldRecipeSchema.parse(raw);
  const level = { id: "level", origin: [-400, -400], size: [800, 800], columns: 2, rows: 2, heights: [10, 10, 10, 10], blend: 1, feather: 1, filter: 0 };
  const edits = [level, ...extra].map((feature) => ({ edit: "add-feature" as const, kind: "heightPatches" as const, feature }));
  return createWorldField(applyRecipeEdits(base, edits).recipe);
}

/** A 1 m raster pad 6 m above the ground whose edge is a DIAGONAL line (the sawtooth case). */
function diagonalPad(extra: Partial<HeightPatchDoc> = {}): HeightPatchDoc {
  const n = 61, heights: number[] = [];
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) heights.push(c + r < 60 ? 16 : 10);
  return { id: "pad", origin: [0, 0], size: [60, 60], columns: n, rows: n, heights, blend: 1.5, ...extra };
}

describe("height-patch edges", () => {
  it("feathers an edge that is far from the ground wide enough to draw, and leaves a level edge at the lattice minimum", () => {
    const doc: HeightPatchDoc = { id: "p", origin: [0, 0], size: [40, 40], columns: 2, rows: 2, heights: [16, 16, 16, 16], blend: 1.5 };
    const p = prepareHeightPatch(doc, 2, () => 10);
    // 6 m above the ground, 45 deg max blend slope: 1.5 * 6 / 1 = 9 m
    for (const f of p.feather) expect(f).toBeCloseTo(9, 6);
    const level = prepareHeightPatch({ ...doc, heights: [10, 10, 10, 10] }, 2, () => 10);
    for (const f of level.feather) expect(f).toBe(4);
    // an explicit feather is honoured (but never below blend)
    expect(prepareHeightPatch({ ...doc, feather: 3 }, 2, () => 10).feather[0]).toBe(3);
    // capped at half the extent
    expect(prepareHeightPatch({ ...doc, heights: [60, 60, 60, 60] }, 2, () => 10).feather[0]).toBe(20);
  });

  it("returns exactly to the ground outside and on the boundary, with a zero-slope join", () => {
    const field = flatWorld([diagonalPad()]);
    expect(field.height(-1, 30)).toBe(10);
    expect(field.height(0, 30)).toBe(10);
    expect(field.height(30, 0)).toBe(10);
    const e = 0.001;
    expect(Math.abs(field.height(e, 5) - 10) / e).toBeLessThan(0.01);
    // well inside the high part the pad holds its height
    expect(field.height(15, 15)).toBeCloseTo(16, 6);
  });

  it("does not stair-step a diagonal raster cliff: the gate fails the raw patch, the default prefilter cuts it, maxSlope clears it", () => {
    const reference = flatWorld([]);
    const box = { x0: 2, z0: 2, x1: 58, z1: 58 };
    const raw = measureTerrainLips(flatWorld([diagonalPad({ filter: 0, feather: 1.5 })]), reference, box);
    const filtered = measureTerrainLips(flatWorld([diagonalPad()]), reference, box);
    const limited = measureTerrainLips(flatWorld([diagonalPad({ maxSlope: 1.2 })]), reference, box);
    expect(raw.counts.alias + raw.counts.step).toBeGreaterThan(0);
    expect(filtered.counts.alias).toBeLessThan(raw.counts.alias);
    expect(filtered.worst.alias).toBeLessThan(raw.worst.alias);
    expect(limited.counts.alias + limited.counts.step).toBeLessThanOrEqual(1);
    expect(limited.faults.length * 20).toBeLessThan(raw.faults.length);
    expect(limited.counts.lip).toBeLessThanOrEqual(1);
  });

  it("road maxCut keeps a trail within that depth of the ground it crosses", () => {
    const raw = defaultWorldRecipe();
    raw.terrain.overhang.strength = 0;
    raw.terrain.caves.enabled = false;
    const base = worldRecipeSchema.parse(raw);
    const road = { id: "trail", points: [[0, 0], [60, 0]], width: 3, shoulder: 3, surfaceY: [-30, -30], flatten: 1 };
    const deep = createWorldField(applyRecipeEdits(base, [{ edit: "add-feature", kind: "roads", feature: road }]).recipe);
    const kept = createWorldField(applyRecipeEdits(base, [{ edit: "add-feature", kind: "roads", feature: { ...road, maxCut: 0.5 } }]).recipe);
    const ground = createWorldField(base);
    expect(ground.height(30, 0) - deep.height(30, 0)).toBeGreaterThan(5);
    expect(ground.height(30, 0) - kept.height(30, 0)).toBeLessThanOrEqual(0.5 + 1e-9);
  });

  it("reports nothing on untouched ground", () => {
    const a = flatWorld([]);
    const rep = measureTerrainLips(a, a, { x0: -50, z0: -50, x1: 50, z1: 50 });
    expect(rep.touchedCells).toBe(0);
    expect(rep.faults).toHaveLength(0);
  });

  it("tent filter keeps a plane a plane and softens a step", () => {
    const plane = tentFilterRaster([0, 1, 2, 3, 4, 5, 6], 7, 1, 2, 0);
    expect(plane[3]).toBeCloseTo(3, 9);
    const step = tentFilterRaster([0, 0, 0, 6, 6, 6], 6, 1, 2, 0);
    expect(step[2]).toBeGreaterThan(0);
    expect(step[3]).toBeLessThan(6);
  });

  it("seat check: a slab level with the ground is seated, one hung over a drop shows the gap", () => {
    const field = flatWorld([]);
    expect(latticeHeight(field, 3.3, 7.1)).toBeCloseTo(10, 9);
    const ok = seatReport(field, { x: 0, z: 0, halfX: 3, halfZ: 1, baseY: 10 });
    expect(ok.gap).toBe(0);
    expect(ok.clip).toBe(0);
    const hung = seatReport(field, { x: 0, z: 0, halfX: 3, halfZ: 1, yaw: 0.7, baseY: 11 });
    expect(hung.gap).toBe(1);
    const sunk = seatReport(field, { x: 0, z: 0, halfX: 3, halfZ: 1, baseY: 9.5 });
    expect(sunk.clip).toBe(0.5);
  });
});

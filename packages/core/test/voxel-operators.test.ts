import { describe, expect, it } from "vitest";
import {
  applyOperator,
  applyRecipeEdits,
  checkOperators,
  compileOperator,
  defaultWorldRecipe,
  fineCarves,
  FINE_REMEDY,
  operatorSpecs,
  registerOperator,
  removeOperator,
  worldRecipeSchema,
  type OperatorFieldReader,
  type WorldRecipe,
} from "../src/index.js";
import { z } from "zod";

/** A plain 0.35-grade slope rising toward +x: the hillside a town is cut into. */
const slope: OperatorFieldReader = { height: (x) => 100 + 0.35 * x, voxelSize: 2, seaLevel: 0, seed: 7 };
const flat: OperatorFieldReader = { height: () => 40, voxelSize: 2, seaLevel: 0, seed: 7 };
const recipe = (): WorldRecipe => defaultWorldRecipe({ cellSize: 48 });
const terrace = { id: "hill", op: "terrace", center: [0, 0], radius: 60 };

describe("landform operator schema", () => {
  it("validates params through the registered operator", () => {
    const base = recipe();
    const ok = worldRecipeSchema.safeParse({ ...base, features: { ...base.features, operators: [terrace] } });
    expect(ok.success).toBe(true);
    const bad = worldRecipeSchema.safeParse({ ...base, features: { ...base.features, operators: [{ ...terrace, rampWidth: 4 }] } });
    expect(bad.success).toBe(false);
    const unknown = worldRecipeSchema.safeParse({ ...base, features: { ...base.features, operators: [{ id: "x", op: "volcano" }] } });
    expect(unknown.success).toBe(false);
    expect(unknown.error?.issues.map((i) => i.message).join(" ")).toMatch(/unknown landform operator "volcano"/);
    const both = worldRecipeSchema.safeParse({ ...base, features: { ...base.features, operators: [{ ...terrace, polygon: [[0, 0], [9, 0], [0, 9]] }] } });
    expect(both.success).toBe(false);
  });

  it("is self-describing in the engine spec", () => {
    const spec = operatorSpecs();
    expect(spec.terrace?.description).toMatch(/shelves/);
    expect(JSON.stringify(spec.terrace?.schema)).toMatch(/rampWidth/);
  });
});

type ShelfReport = {
  bandHeight: number; levels: number[]; shelves: { level: number; area: number }[]; ramps: { from: number; to: number }[];
  unlinked: unknown[]; groups: number; tallRiserCells: number; maxCut: number; maxFill: number; meanCutFill: number;
  walls: { runs: number; modules: number; maxHeight: number; kitMax: number };
};
type Wall = { id: string; pieces: { prefab: string; role: string; position: number[] }[]; cuts: { y: number[] }[] };

describe("terrace compile (shelving core)", () => {
  it("is deterministic", () => {
    const a = compileOperator(terrace, slope);
    const b = compileOperator(structuredClone(terrace), slope);
    expect(JSON.stringify(a.pieces)).toBe(JSON.stringify(b.pieces));
    expect(a.pieces.map((p) => p.feature.id)).toContain("op:hill:ground");
    expect(a.pieces.some((p) => p.kind === "kitWalls" && /^op:hill:wall-[0-9]+$/.test(String(p.feature.id)))).toBe(true);
  });

  it("cuts unclamped contour bands at stepHeight spacing, each cell within about half a band", () => {
    const { output } = compileOperator(terrace, slope);
    const r = output.report as ShelfReport;
    expect(r.bandHeight).toBeGreaterThanOrEqual(3);
    for (let k = 1; k < r.levels.length; k++) expect(((r.levels[k]! - r.levels[0]!) / r.bandHeight + 1e-6) % 1).toBeLessThan(1e-3);
    // a 0.35 slope over ~120 m rises ~42 m: many bands, not a clamped four
    expect(r.levels.length).toBeGreaterThanOrEqual(6);
    expect(r.meanCutFill).toBeLessThan(2.5);
  });

  it("links every shelf (spanning-tree ramps)", () => {
    const r = compileOperator(terrace, slope).output.report as ShelfReport;
    expect(r.unlinked).toEqual([]);
    expect(r.groups).toBe(1);
    expect(r.ramps.length).toBe(r.shelves.length - 1);
  });

  it("fades through a noisy edge, not a drawn circle", () => {
    const { output } = compileOperator(terrace, slope);
    const p = output.features.heightPatches![0]! as unknown as { origin: number[]; columns: number; weights: number[] };
    const full: number[] = [];
    for (let a = 0; a < 32; a++) {
      const dx = Math.cos((a / 32) * Math.PI * 2), dz = Math.sin((a / 32) * Math.PI * 2);
      let r = 0;
      for (let d = 0; d < 120; d += 1) {
        const c = Math.round((dx * d - p.origin[0]!) / 2), q = Math.round((dz * d - p.origin[1]!) / 2);
        if (p.weights[q * p.columns + c]! < 0.999) break;
        r = d;
      }
      full.push(r);
    }
    expect(Math.max(...full) - Math.min(...full)).toBeGreaterThan(6);
  });

  it("walls risers with kit pieces no taller than the kit, in runs of at least 6 m", () => {
    const steep: OperatorFieldReader = { ...slope, height: (x) => 100 + 0.8 * x };
    for (const reader of [slope, steep]) {
      const { output, pieces } = compileOperator(terrace, reader);
      const r = output.report as ShelfReport;
      expect(r.walls.maxHeight).toBeLessThanOrEqual(r.walls.kitMax);
      const walls = pieces.filter((p) => p.kind === "kitWalls").map((p) => p.feature as unknown as Wall);
      expect(walls.length).toBeGreaterThan(0);
      for (const w of walls) {
        expect(w.cuts.length * 2).toBeGreaterThanOrEqual(6);
        for (const pc of w.pieces) if (pc.role === "straight-2") expect(Number(/-h([0-9]+)-/.exec(pc.prefab)![1]) / 100).toBeLessThanOrEqual(6.4);
      }
    }
  });

  it("merges a shelf too shallow to use, but never past the tallest kit wall", () => {
    const steep: OperatorFieldReader = { ...slope, height: (x) => 100 + 0.6 * x };
    const r = compileOperator({ ...terrace, minShelf: 30 }, steep).output.report as ShelfReport;
    const loose = compileOperator({ ...terrace, minShelf: 6 }, steep).output.report as ShelfReport;
    expect(r.shelves.length).toBeLessThan(loose.shelves.length);
    expect(r.tallRiserCells).toBe(0);
  });
});

describe("install / re-install / remove", () => {
  it("re-applying replaces exactly its own output, and the inverse restores the recipe", () => {
    const base = recipe();
    base.features.heightPatches.push({ id: "town-pad", origin: [500, 500], size: [20, 20], columns: 2, rows: 2, heights: [1, 1, 1, 1], blend: 4 });
    const first = applyOperator(base, terrace, slope);
    expect(first.recipe.features.heightPatches.map((p) => p.id)).toEqual(["town-pad", "op:hill:ground"]);
    expect(first.recipe.features.operators?.[0]?.compiled?.pieces).toContain("heightPatches/op:hill:ground");
    expect(first.recipe.features.kitWalls?.length).toBeGreaterThan(0);

    const second = applyOperator(first.recipe, { ...terrace, stepHeight: 2.4 }, slope);
    expect(second.recipe.features.heightPatches.map((p) => p.id)).toEqual(["town-pad", "op:hill:ground"]);
    expect(second.recipe.features.operators).toHaveLength(1);
    // undo the re-apply: exactly the first install
    expect(JSON.stringify(applyRecipeEdits(second.recipe, second.inverse).recipe)).toBe(JSON.stringify(first.recipe));
    // undo the first install: the original recipe, with no `operators: []` left behind
    const back = applyRecipeEdits(first.recipe, first.inverse).recipe;
    expect(back.features.operators).toBeUndefined();
    expect(JSON.stringify(back)).toBe(JSON.stringify(base));

    const gone = removeOperator(second.recipe, "hill");
    expect(gone.recipe.features.heightPatches.map((p) => p.id)).toEqual(["town-pad"]);
    expect(gone.recipe.features.kitWalls).toBeUndefined();
    expect(JSON.stringify(applyRecipeEdits(gone.recipe, gone.inverse).recipe)).toBe(JSON.stringify(second.recipe));
  });

  it("checks: ok, EDITED by hand, STALE ground", () => {
    const { recipe: r } = applyOperator(recipe(), terrace, slope);
    expect(checkOperators(r, () => slope).map((s) => s.state)).toEqual(["ok"]);
    expect(checkOperators(r, () => flat).map((s) => s.state)).toEqual(["STALE"]);
    const edited = structuredClone(r);
    edited.features.heightPatches[0]!.heights[0]! += 1;
    expect(checkOperators(edited).map((s) => s.state)).toEqual(["EDITED"]);
  });
});

describe("the 6 m rule", () => {
  it("fails a narrow hand carve, passes legacy ids and exempt derived pieces", () => {
    const r = recipe();
    r.features.passages.push(
      { id: "kings-step-1", start: [0, 10, 0], axis: "z", direction: 1, footprint: "box", length: 3, width: 2.5, height: 4, wallNoise: 0, noiseDetail: 0, roofRise: 0, roofNoise: 0, noiseScale: 6, seed: 1, falloff: 4, connectionBand: 4 },
      { id: "old-step", start: [0, 10, 40], axis: "z", direction: 1, footprint: "box", length: 3, width: 2, height: 3, wallNoise: 0, noiseDetail: 0, roofRise: 0, roofNoise: 0, noiseScale: 6, seed: 1, falloff: 4, connectionBand: 4 },
      { id: "tw-wall-cut-1", start: [0, 10, 80], axis: "z", direction: 1, footprint: "box", length: 3, width: 1, height: 3, wallNoise: 0, noiseDetail: 0, roofRise: 0, roofNoise: 0, noiseScale: 6, seed: 1, falloff: 4, connectionBand: 4 },
      { id: "hall", start: [0, 10, 120], axis: "z", direction: 1, footprint: "box", length: 20, width: 12, height: 8, wallNoise: 0, noiseDetail: 0, roofRise: 0, roofNoise: 0, noiseScale: 6, seed: 1, falloff: 4, connectionBand: 4 },
    );
    r.features.blobs.push({ id: "pebble", center: [0, 0, 0], radius: 2, op: "remove", falloff: 2, height: 0, scaleX: 1, scaleZ: 1 });
    r.features.heightPatches.push({ id: "kerb", origin: [0, 0], size: [40, 4], columns: 2, rows: 2, heights: [1, 1, 1, 1], blend: 1 });
    const rep = fineCarves(r, { legacy: ["passages/old-step"] });
    expect(rep.ok).toBe(false);
    expect(rep.faults.map((f) => f.id).sort()).toEqual(["kerb", "kings-step-1", "pebble"]);
    expect(rep.legacy.map((f) => f.id)).toEqual(["old-step"]);
    expect(rep.exempt).toBe(1);
    expect(fineCarves(r, { legacy: ["kings-step-1", "pebble", "kerb", "old-step"] }).ok).toBe(true);
    expect(FINE_REMEDY).toMatch(/kit\/hero piece or an operator/);
  });

  it("binds operators by construction", () => {
    registerOperator({
      op: "test-kerb",
      description: "emits a kerb (must be refused)",
      schema: z.object({}),
      bounds: () => ({ x0: 0, z0: 0, x1: 10, z1: 10 }),
      compile: () => ({ features: { heightPatches: [{ id: "k", origin: [0, 0], size: [20, 3], columns: 2, rows: 2, heights: [0, 0, 0, 0], blend: 1 }] }, report: {} }),
    });
    expect(() => compileOperator({ id: "bad", op: "test-kerb" }, flat)).toThrow(/too fine for terrain/);
  });
});

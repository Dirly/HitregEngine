import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  applyOperator,
  checkOperators,
  compileOperator,
  createWorldField,
  defaultWorldRecipe,
  featureFootprint,
  operatorSpecs,
  registerOperator,
  VegetationIndex,
  withoutOperatorPieces,
  worldRecipeSchema,
  type OperatorFieldReader,
  type WorldRecipe,
} from "../src/index.js";

/** A shelf at y 100 (x < 0), a 60 m cliff face (x 0..20), then a gentle slope falling to +x: a quarry lip over a trail. */
const cliffH = (x: number) => (x < 0 ? 100 : x < 20 ? 100 - 3 * x : 40 - 0.12 * (x - 20));
const cliff: OperatorFieldReader = {
  height: (x) => cliffH(x), voxelSize: 2, seaLevel: 0, seed: 7,
  surfaces: ["grass", "rock", "scree-pale"], scatterRules: ["rock-small", "rock-medium", "rock-big"],
};
const fan = { id: "f", op: "scree", from: [0, 0], widthTop: 10, widthToe: 40 };

type FanReport = { length: number; steepestDeg: number; maxFill: number; boulders: number; drop: number };
type Patch = { origin: number[]; size: number[]; columns: number; rows: number; heights: number[]; weights: number[] };
type Rocks = { rocks: { rule: string; at: [number, number]; scale: number }[] };

describe("scree operator", () => {
  const a = compileOperator(fan, cliff);
  const report = a.output.report as unknown as FanReport;
  const patch = a.pieces.find((p) => p.kind === "heightPatches")!.feature as unknown as Patch;

  it("compiles to a fan patch, a scree paint and boulders", () => {
    expect(a.pieces.map((p) => `${p.kind}/${p.feature.id}`).sort()).toEqual(["groundPaints/op:f:paint", "heightPatches/op:f:fan", "rockSets/op:f:rocks"]);
    expect(JSON.stringify(compileOperator(structuredClone(fan), cliff).pieces)).toBe(JSON.stringify(a.pieces)); // deterministic
  });

  it("only adds rock, lies at the angle of repose and ends at a natural toe", () => {
    let below = 0;
    for (let j = 0; j < patch.rows; j++) for (let i = 0; i < patch.columns; i++) {
      const k = j * patch.columns + i;
      const x = patch.origin[0]! + (i * patch.size[0]!) / (patch.columns - 1);
      if (patch.weights[k]! > 0 && patch.heights[k]! < cliffH(x) - 0.02) below++;
    }
    expect(below).toBe(0);
    expect(report.steepestDeg).toBeLessThanOrEqual(45); // the walk limit is 50
    expect(report.steepestDeg).toBeGreaterThan(25);
    expect(report.maxFill).toBeGreaterThan(5); // heaped against the face
    expect(report.length).toBeGreaterThan(40); // ran past the cliff foot onto the slope
    expect(report.length).toBeLessThan(400);
  });

  it("grades its boulders coarser toward the toe", () => {
    const rocks = (a.pieces.find((p) => p.kind === "rockSets")!.feature as unknown as Rocks).rocks;
    expect(rocks.length).toBeGreaterThan(5);
    const head = rocks.filter((r) => r.at[0] < report.length * 0.35), toe = rocks.filter((r) => r.at[0] > report.length * 0.65);
    const mean = (l: Rocks["rocks"]) => l.reduce((s, r) => s + r.scale, 0) / Math.max(1, l.length);
    expect(mean(toe)).toBeGreaterThan(mean(head));
    expect(toe.some((r) => r.rule === "rock-big")).toBe(true);
    expect(head.every((r) => r.rule !== "rock-big")).toBe(true);
  });

  it("refuses a surface or a boulder rule the world does not have", () => {
    expect(() => compileOperator({ ...fan, surface: "lava" }, cliff)).toThrow(/not in this world's palette/);
    expect(() => compileOperator({ ...fan, boulders: { rules: ["a", "b", "c"] } }, cliff)).toThrow(/not a scatter rule/);
    expect(() => compileOperator({ ...fan, from: [-50, 0], apexDrop: 30 }, cliff)).toThrow(/never stands proud/);
  });

  it("is self-describing", () => {
    expect(JSON.stringify(operatorSpecs().scree?.schema)).toMatch(/widthToe/);
    expect(JSON.stringify(operatorSpecs().paint?.schema)).toMatch(/height/);
  });
});

describe("ground paint", () => {
  const base = (): WorldRecipe => worldRecipeSchema.parse({ ...defaultWorldRecipe(), cellSize: 48, resolution: 24, terrain: { ...defaultWorldRecipe().terrain, base: 40 } });

  it("paints its surface inside, fades over the feather, leaves the rest alone", () => {
    const r0 = base();
    const target = r0.surfaces.findIndex((s) => s.name === "snow");
    const r = { ...r0, features: { ...r0.features, groundPaints: [{ id: "p", surface: "snow", center: [0, 0], radius: 20, feather: 6, edgeNoise: 0, strength: 1, breakup: 0, faces: false }] } } as WorldRecipe;
    const f = createWorldField(worldRecipeSchema.parse(r)), plain = createWorldField(r0);
    expect(f.biome(0, 0).surface[target]).toBeGreaterThan(0.99);
    const mid = f.biome(23, 0).surface[target]!;
    expect(mid).toBeGreaterThan(0.05);
    expect(mid).toBeLessThan(0.95);
    expect(Array.from(f.biome(60, 0).surface)).toEqual(Array.from(plain.biome(60, 0).surface));
  });

  it("honours a height band", () => {
    const r0 = base();
    const target = r0.surfaces.findIndex((s) => s.name === "snow");
    const g = createWorldField(r0).height(0, 0);
    const paint = (lo: number, hi: number) => createWorldField(worldRecipeSchema.parse({ ...r0, features: { ...r0.features, groundPaints: [{ id: "p", surface: "snow", center: [0, 0], radius: 20, height: [lo, hi] }] } })).biome(0, 0).surface[target]!;
    expect(paint(g - 2, g + 2)).toBeGreaterThan(0.99);
    expect(paint(g + 10, g + 20)).toBeLessThan(0.01);
  });

  it("the paint operator compiles one paint, its footprint invalidates cells, and `clear` makes a clearing", () => {
    const c = compileOperator({ id: "floor", op: "paint", surface: "rock", polygon: [[0, 0], [30, 0], [30, 20], [0, 20]], clear: true }, cliff);
    expect(c.pieces.map((p) => `${p.kind}/${p.feature.id}`)).toEqual(["groundPaints/op:floor:paint"]);
    const fp = featureFootprint("groundPaints", c.pieces[0]!.feature)!;
    expect(fp.x0).toBeLessThan(0);
    expect(fp.x1).toBeGreaterThan(30);
    const veg = new VegetationIndex({ scatter: [{ id: "tree" }], features: { groundPaints: [c.pieces[0]!.feature as never] } });
    expect(veg.clearingKeep(15, 10, 0)).toBe(0);
    expect(veg.clearingKeep(80, 10, 0)).toBe(1);
  });
});

describe("operators compose in recipe order (op --check converges)", () => {
  // `raise`: a 40 m height patch lifting whatever ground it reads by `by` metres (a stand-in for a landmark ground
  // blend and a path grade that overlap)
  registerOperator<{ at: [number, number]; by: number }>({
    op: "test-raise",
    description: "test",
    schema: z.object({ at: z.tuple([z.number(), z.number()]), by: z.number() }) as never,
    compile: (p, reader) => {
      const heights: number[] = [];
      for (let j = 0; j < 5; j++) for (let i = 0; i < 5; i++) heights.push(Math.round((reader.height(p.at[0] - 20 + i * 10, p.at[1] - 20 + j * 10) + p.by) * 100) / 100);
      return { features: { heightPatches: [{ id: "g", origin: [p.at[0] - 20, p.at[1] - 20], size: [40, 40], columns: 5, rows: 5, heights, blend: 4 }] }, report: {} };
    },
    bounds: (p) => ({ x0: p.at[0] - 20, z0: p.at[1] - 20, x1: p.at[0] + 20, z1: p.at[1] + 20 }),
  });
  const readerOf = (r: WorldRecipe, id: string): OperatorFieldReader => {
    const f = createWorldField(withoutOperatorPieces(r, id));
    return { height: (x, z) => f.height(x, z), voxelSize: 2, seaLevel: 0, seed: r.seed };
  };

  it("two overlapping operators both check ok after one pass in recipe order, and re-applying the first is a fixed point", () => {
    let r: WorldRecipe = worldRecipeSchema.parse({ ...defaultWorldRecipe(), cellSize: 48, resolution: 24 });
    const A = { id: "blend", op: "test-raise", at: [0, 0], by: 3 }, B = { id: "ribbon", op: "test-raise", at: [10, 5], by: 1 };
    r = applyOperator(r, A, readerOf(r, "blend")).recipe;
    r = applyOperator(r, B, readerOf(r, "ribbon")).recipe;
    expect(checkOperators(r, (id) => readerOf(r, id)).map((s) => s.state)).toEqual(["ok", "ok"]);
    // re-applying A reads the ground WITHOUT B (B is later): nothing moves, both stay ok
    r = applyOperator(r, A, readerOf(r, "blend")).recipe;
    expect(checkOperators(r, (id) => readerOf(r, id)).map((s) => s.state)).toEqual(["ok", "ok"]);
    // changing A really moves B's ground: B is STALE and names what it was composed on
    r = applyOperator(r, { ...A, by: 6 }, readerOf(r, "blend")).recipe;
    const rows = checkOperators(r, (id) => readerOf(r, id));
    expect(rows.map((s) => s.state)).toEqual(["ok", "STALE"]);
    expect(rows[1]!.why).toMatch(/composed on blend/);
  });
});

describe("rock sets (operator boulders)", () => {
  it("stand on the ground as instances of the named scatter rule; unknown rules are skipped", async () => {
    const { rockSetInstances } = await import("../src/index.js");
    const base = defaultWorldRecipe();
    const r = worldRecipeSchema.parse({
      ...base, cellSize: 48, resolution: 24, terrain: { ...base.terrain, base: 40 },
      scatter: [{ id: "rock-small", model: "rock-kit/boulder-s-1.glb", density: 0, collider: "box", colliderSize: [1, 0.8, 1] }],
    });
    const f = createWorldField(r);
    const set = { id: "op:f:rocks", rocks: [{ rule: "rock-small", at: [3, 4] as [number, number], yaw: 0.5, scale: 1.2 }, { rule: "nope", at: [9, 9] as [number, number], yaw: 0, scale: 1 }] };
    const out = rockSetInstances(f, set);
    expect(out.length).toBe(1);
    expect(out[0]!.rule).toBe("rock-small");
    expect(Math.abs(out[0]!.position[1] - f.height(3, 4))).toBeLessThan(1.5);
    expect(out[0]!.id).not.toMatch(/:/);
  });
});

describe("ground paint: a `faces` paint re-skins walls (facesOnly pass)", () => {
  it("the facesOnly pass repaints only `faces` paints and only on the steep part", async () => {
    const { createGroundPainter, groundPaintSchema } = await import("../src/index.js");
    const sq = [[-10, -10], [10, -10], [10, 10], [-10, 10]] as [number, number][];
    const docs = [groundPaintSchema.parse({ id: "walls", surface: "b", polygon: sq, feather: 0, edgeNoise: 0, faces: true }), groundPaintSchema.parse({ id: "floor", surface: "c", polygon: sq, feather: 0, edgeNoise: 0 })];
    const p = createGroundPainter(docs, (n) => ["a", "b", "c"].indexOf(n), 1)!;
    const at = (flat: number, facesOnly: boolean) => { const out = new Float32Array([1, 0, 0]); p.paint(0, 0, 0, 1 - flat, flat, out, 0, 3, facesOnly); return [...out].map((v) => Math.round(v * 100) / 100); };
    expect(at(0, true)).toEqual([0, 1, 0]); // a wall: the faces paint wins again (a later blanket face paint undone)
    expect(at(1, true)).toEqual([1, 0, 0]); // flat ground: the pass leaves it alone (water and trail keep their win)
    expect(at(1, false)).toEqual([0, 0, 1]); // the normal pass still paints both, the floor paint last
  });
});

describe("ground paint: a `fringe` fades out in splotches (a creep), not a smooth ring", () => {
  it("is solid inside the fringe, gone past the feather, and patchy (islands) between", async () => {
    const { createGroundPainter, groundPaintSchema, fringeWeight } = await import("../src/index.js");
    expect(fringeWeight(-20, 12, 6, 0.02)).toBeGreaterThan(0.99); // the core: solid even where the noise is lowest
    expect(fringeWeight(6.1, 12, 6, 0.98)).toBeLessThan(0.01); // past the feather: nothing even where it is highest
    const docs = [groundPaintSchema.parse({ id: "creep", surface: "b", center: [0, 0], radius: 30, feather: 6, edgeNoise: 0, fringe: 14, blotch: 6 })];
    const p = createGroundPainter(docs, (n) => ["a", "b"].indexOf(n), 3)!;
    const at = (x: number, z: number) => { const out = new Float32Array([1, 0]); p.paint(x, 0, z, 0, 1, out, 0, 2); return out[1]!; };
    // a ring in the fringe (r 24): some samples fully painted, some bare: islands, never one even grey
    const ring = Array.from({ length: 180 }, (_, i) => at(24 * Math.cos(i / 28.6), 24 * Math.sin(i / 28.6)));
    expect(ring.filter((w) => w > 0.9).length).toBeGreaterThan(10);
    expect(ring.filter((w) => w < 0.1).length).toBeGreaterThan(10);
    // coverage falls with distance: the inner fringe is mostly painted, the outer mostly bare
    const share = (r: number) => Array.from({ length: 360 }, (_, i) => at(r * Math.cos(i / 57.3), r * Math.sin(i / 57.3))).reduce((s, w) => s + w, 0) / 360;
    expect(share(10)).toBeGreaterThan(0.97);
    expect(share(19)).toBeGreaterThan(share(27));
    expect(share(27)).toBeGreaterThan(share(34));
    expect(share(37)).toBeLessThan(0.01);
  });
});

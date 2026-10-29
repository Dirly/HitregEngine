import { test } from "node:test";
import assert from "node:assert/strict";
import { continentalWorldRecipe, createWorldField, worldRecipeSchema, type WorldRecipe } from "@hitreg/core";
import { lakeSettleLevels, waterLogic } from "../tools/worldgen-water-logic.mts";

/** The marsh world of core's voxel-river-weir.test.ts: a river across a marsh (table +2) to the sea along z -2000. */
function fenWorld(weirs?: unknown[]): WorldRecipe {
  const raw = continentalWorldRecipe();
  const marshy = new Set(["swamp", "fen", "grassland", "forest", "savanna"]);
  const anchors = raw.climate.zones!.anchors.map((a) => (marshy.has(a.id) ? { ...a, relief: 0, hills: 0.25, flatten: 1, waterTable: 2, hummocks: 1 } : a));
  const river = {
    id: "fenrun",
    points: [[1600, -2000], [1800, -2005], [2000, -1995], [2200, -2000], [2380, -2000], [2500, -2000]],
    width: 12, depth: 3, bank: 12, maxGrade: 0, surface: "",
    ...(weirs ? { weirs } : {}),
  };
  return worldRecipeSchema.parse({ ...raw, climate: { ...raw.climate, zones: { ...raw.climate.zones!, anchors } }, marshMaterial: "terrain/test-marsh", features: { ...raw.features, rivers: [river] } });
}
const AREA: [number, number, number, number] = [1550, -2150, 2550, -1850];

test("water-logic: a river under its fen with no weir is a finding, with coordinates", () => {
  const rep = waterLogic(fenWorld(), { rect: AREA });
  const under = rep.findings.filter((f) => f.kind === "river-under-fen").sort((a, b) => b.extent - a.extent);
  assert.equal(under.length >= 1, true, JSON.stringify(rep.counts));
  assert.equal(under[0]!.id, "fenrun");
  assert.equal(under[0]!.extent > 200, true);
  assert.equal(Number.isFinite(under[0]!.x) && Number.isFinite(under[0]!.toX!), true);
  assert.equal(rep.ok, false);
});

test("water-logic: the same river held by a weir at the fen's outlet is clean", () => {
  const recipe = fenWorld([{ id: "outlet", at: [2380, -2000] }]);
  const rep = waterLogic(recipe, { rect: AREA, field: createWorldField(recipe) });
  assert.deepEqual(rep.findings.filter((f) => f.kind === "river-under-fen"), []);
  assert.deepEqual(rep.findings.filter((f) => f.kind === "perched-sheet" && f.id === "marsh"), [], JSON.stringify(rep.findings.slice(0, 5)));
});

test("water-logic: a lake a river runs into with nothing running out should drain", () => {
  const raw = worldRecipeSchema.parse(fenWorld());
  const recipe = worldRecipeSchema.parse({
    ...raw,
    features: {
      ...raw.features,
      rivers: [],
      lakes: [{ id: "closed", center: [0, 0], radius: 50, waterY: 1000, bank: 10 }],
    },
  });
  // a field that reports one river ending at the lake (the check reads the field's solved rivers)
  const field = createWorldField(recipe);
  const fake = Object.create(field) as typeof field;
  Object.defineProperty(fake, "rivers", { value: [{ id: "in", water: true, points: [[-300, 0], [-40, 0]], surfaceY: [1010, 1000], width: 6, bank: 6 }] });
  const rep = waterLogic(recipe, { near: [0, 0, 400], field: fake, step: 64 });
  const f = rep.findings.find((x) => x.kind === "lake-no-outlet");
  assert.ok(f, JSON.stringify(rep.counts));
  assert.equal(f!.id, "closed");
});

/**
 * A strip world along x (2026-10-29 w3-hydro): lake water at 10 over ground 5 for x < 2; then either an outlet river
 * (water 8.6, 1.4 m under the lake: the rivers stage's hair) over ground 6 for 2 <= x < 10 and its dry far bank at 9.4,
 * or (no river) dry ground at `dry` straight off the lake's edge.
 */
function stripField(recipe: WorldRecipe, opts: { river: boolean; dry: number }): ReturnType<typeof createWorldField> {
  const field = createWorldField(recipe);
  const fake = Object.create(field) as typeof field;
  const ground = (x: number): number => (x < 2 ? 5 : opts.river && x < 10 ? 6 : opts.river ? 9.4 : opts.dry);
  Object.defineProperty(fake, "rivers", { value: [], writable: true });
  Object.defineProperty(fake, "falls", { value: [] });
  Object.defineProperty(fake, "marshTable", { value: () => null });
  Object.defineProperty(fake, "height", { value: (x: number) => ground(x) });
  Object.defineProperty(fake, "waterSurface", {
    value: (x: number, _z: number, out: { y: number; kind: string; flowX: number; flowZ: number; floor: number }) => {
      if (x < 2) Object.assign(out, { y: 10, kind: "lake", flowX: 0, flowZ: 0, floor: -Infinity });
      else if (opts.river && x < 10) Object.assign(out, { y: 8.6, kind: "river", flowX: 1, flowZ: 0, floor: 6 });
      else return false;
      return true;
    },
  });
  return fake;
}
function stripRecipe(): WorldRecipe {
  const raw = worldRecipeSchema.parse(continentalWorldRecipe());
  return worldRecipeSchema.parse({
    ...raw,
    features: { ...raw.features, rivers: [], lakes: [{ id: "tarn", center: [-100, 0], radius: 100, waterY: 10, bank: 10, carve: false, polygon: [[-200, -100], [2, -100], [2, 100], [-200, 100]] }] },
  });
}
const STRIP: [number, number, number, number] = [-64, -32, 64, 32];

test("water-logic: a lake ending at its outlet river is not perched over the river's dry far bank", () => {
  // before 2026-10-29 the bank (9.4, over the river's 8.6 but under the lake's 10 - 0.5) read as "sheet 10 over dry
  // ground 9.4": redstrand dogfood 2130 lake-1/lake-2 and 2332 lake-2 failed water-logic on it
  const recipe = stripRecipe();
  const rep = waterLogic(recipe, { rect: STRIP, field: stripField(recipe, { river: true, dry: 0 }) });
  assert.deepEqual(rep.findings.filter((f) => f.kind === "perched-sheet"), []);
});

test("water-logic: a lake edge over lower dry ground is perched, and lakeSettleLevels lowers it to hold", () => {
  const recipe = stripRecipe();
  const field = stripField(recipe, { river: false, dry: 8 });
  const rep = waterLogic(recipe, { rect: STRIP, field });
  const f = rep.findings.find((x) => x.kind === "perched-sheet");
  assert.ok(f, JSON.stringify(rep.counts));
  assert.equal(f!.level, 10);
  assert.equal(f!.lower, 8);
  const settle = lakeSettleLevels(recipe, new Map([["tarn", 3]]), field);
  assert.equal(settle.length, 1);
  assert.equal(settle[0]!.lake.id, "tarn");
  assert.equal(settle[0]!.basin, 3);
  assert.ok(Math.abs(settle[0]!.level - 8.3) < 1e-9, String(settle[0]!.level));
  // a lake with no hydrology basin (hand-placed) is the author's: never settled
  assert.deepEqual(lakeSettleLevels(recipe, new Map(), field), []);
});

test("lakeSettleLevels: a river whose water climbs into a lake brings the lake down to its arrival (2026-10-29 w3-hydro)", () => {
  // redstrand dogfood 3443: river-1 arrived at 54.25 and its water climbed 3.2 m into lake-2 (57.42) — the rivers
  // audit's uphill step; the lake's grid spill level stood over the ground the river found
  const recipe = stripRecipe();
  const field = stripField(recipe, { river: false, dry: 9.6 });
  (field as unknown as { rivers: unknown[] }).rivers = [{ id: "in", water: true, points: [[-400, 0], [-210, 0], [-150, 0]], surfaceY: [9, 7.5, 10], bedY: [8, 6.5, 9], width: 6, bank: 6 }];
  const settle = lakeSettleLevels(recipe, new Map([["tarn", 2]]), field);
  assert.equal(settle.length, 1);
  assert.ok(Math.abs(settle[0]!.level - 8.5) < 1e-9, String(settle[0]!.level));
  // a step within the hair is the river's mouth by design: nothing to settle
  (field as unknown as { rivers: unknown[] }).rivers = [{ id: "in", water: true, points: [[-400, 0], [-210, 0], [-150, 0]], surfaceY: [9, 8.6, 10], bedY: [8, 7.6, 9], width: 6, bank: 6 }];
  assert.deepEqual(lakeSettleLevels(recipe, new Map([["tarn", 2]]), field), []);
});

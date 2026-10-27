import { test } from "node:test";
import assert from "node:assert/strict";
import { continentalWorldRecipe, createWorldField, worldRecipeSchema, type WorldRecipe } from "@hitreg/core";
import { waterLogic } from "../tools/worldgen-water-logic.mts";

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

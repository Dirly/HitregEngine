import { test } from "node:test";
import assert from "node:assert/strict";
import { createWorldField, defaultWorldRecipe, worldRecipeSchema, type WorldRecipe } from "@hitreg/core";
import { LAKE_FOOTPRINT_TOLL, LAKE_SHORE_TOLL, lakeToll } from "../tools/worldgen-routing.mts";
import { dryDetour, roadLakeFills } from "../tools/worldgen-road.mts";
import { cellMaker } from "../tools/worldgen-lips.mts";

// Derek 2026-10-30: the path by Rustgut's Trough ran through the top of lake-1, filling a causeway where it could have
// gone round. The routers toll a lake's footprint and low shore; `worldgen road-water` flags a filled stretch a short
// dry detour avoids.
const lake = { id: "lake-t", polygon: [[0, 0], [20, 0], [20, 20], [0, 20]] as [number, number][], center: [10, 10] as [number, number], radius: 10, waterY: 10, shore: 8 };

test("lakeToll: the footprint is dear, the low shore dearer than ground, high ground free", () => {
  const toll = lakeToll([lake]);
  assert.equal(toll(10, 10, 10.2), LAKE_FOOTPRINT_TOLL); // a marshy lobe a hand over the water is still the lake
  assert.equal(toll(24, 10, 10.5), LAKE_SHORE_TOLL);
  assert.equal(toll(24, 10, 12), 1); // a held rim / bank over the water is not the shore
  assert.equal(toll(60, 10, 10), 1);
});

test("dryDetour finds the way round and refuses past its limit", () => {
  const blocked = (x: number, z: number) => x > -4 && x < 24 && z > -4 && z < 24;
  const d = dryDetour([-10, 10], [30, 10], 120, blocked);
  assert.ok(d !== null && d > 40 && d < 80, `detour ${d}`);
  assert.equal(dryDetour([-10, 10], [30, 10], 30, blocked), null);
});

test("roadLakeFills flags a fill across a lake's edge with a short way round, not a lakeside road on its own ground", () => {
  const recipe = { features: { lakes: [lake], roads: [{ id: "path-x", points: [[-20, 16], [40, 16]] }, { id: "path-y", points: [[-20, -6], [40, -6]] }] } } as unknown as WorldRecipe;
  const ground = () => 10.2;
  const wet = () => false;
  // path-x crosses the lake's top, filled 1 m; path-y skims the shore on its own ground
  const surface = (x: number, z: number) => (Math.abs(z - 16) < 2 && x > -8 && x < 28 ? 11.2 : 10.2);
  const found = roadLakeFills(recipe, ground, wet, () => surface);
  assert.equal(found.length, 1);
  assert.equal(found[0]!.road, "path-x");
  assert.ok(found[0]!.detour <= found[0]!.length * 2);
  // a lake too long to go round within 2x is a crossing question, not this fault
  const wide = { ...lake, polygon: [[0, -400], [20, -400], [20, 400], [0, 400]] as [number, number][] };
  assert.equal(roadLakeFills({ features: { lakes: [wide], roads: recipe.features.roads } } as unknown as WorldRecipe, ground, wet, () => surface).length, 0);
});

test("cellMaker: a cell is charged to the edit whose removal moves it, not to the patch whose raster covers it", () => {
  const base = defaultWorldRecipe();
  // a raise-only patch far below the ground (it edits nothing) under a road that cuts 2 m
  const n = 21, heights = new Array(n * n).fill(-500);
  const recipe = worldRecipeSchema.parse({
    ...base,
    features: {
      ...base.features,
      heightPatches: [{ id: "need-t", origin: [-100, -100], size: [200, 200], columns: n, rows: n, heights, raiseOnly: true, blend: 4 }],
      roads: [{ id: "road-t", points: [[-60, 0], [60, 0]], width: 6, shoulder: 4, surfaceY: [-50, -50], maxCut: 2 }],
    },
  });
  const field = createWorldField(recipe);
  const maker = cellMaker(recipe, field);
  const m = maker(1, 1, [{ kind: "patch", id: "need-t" }, { kind: "road", id: "road-t" }]);
  assert.equal(m.made, "road:road-t");
  assert.ok(!m.moved.includes("patch:need-t"));
  // far from the road nothing moves the cell: the caller falls back to the nearest band
  assert.equal(maker(1, 60, [{ kind: "patch", id: "need-t" }, { kind: "road", id: "road-t" }]).made, undefined);
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { defaultWorldRecipe, worldRecipeSchema } from "@hitreg/core";
import { handmadeFaults } from "../tools/handmade-check.mts";

const base = worldRecipeSchema.parse(defaultWorldRecipe());
const riser = (o: object) => ({ id: "r", points: [[200, 216], [260, 216]], top: 3, foot: -3, back: 8, ...o });
const world = (features: object, surfaces = base.surfaces) => worldRecipeSchema.parse({ ...base, surfaces, features: { ...base.features, ...features } });
const tiles = [...base.surfaces, { name: "riser-rubble", color: "#777777" }, { name: "riser-rubble-damp", color: "#444444" }, { name: "riser-rubble-top", color: "#aaaaaa" }];
const painted = { face: "riser-rubble", foot: "riser-rubble-damp", top: "riser-rubble-top" };

test("a DC riser with a machine crest fails flat-top; the default hand-made crest passes", () => {
  const flat = handmadeFaults(world({ dcRisers: [riser({ surfaces: painted, rough: { stepShare: 0, dropShare: 0 } })] }, tiles));
  assert.deepEqual(flat.map((f) => f.kind), ["flat-top"]);
  assert.deepEqual(handmadeFaults(world({ dcRisers: [riser({ surfaces: painted })] }, tiles)), []);
});

test("a DC riser painted with one tile (or the zone splat alone) fails one-tile", () => {
  assert.deepEqual(handmadeFaults(world({ dcRisers: [riser({})] })).map((f) => f.kind), ["one-tile"]);
  assert.deepEqual(handmadeFaults(world({ dcRisers: [riser({ surfaces: { face: "riser-rubble", foot: "riser-rubble", top: "riser-rubble" } })] }, tiles)).map((f) => f.kind), ["one-tile"]);
});

test("a town wall without the hand-made top, in one material, fails both", () => {
  const ops = [{ id: "w", op: "wall", points: [[0, 0], [40, 0]] }];
  assert.deepEqual(handmadeFaults(world({ operators: ops })).map((f) => f.kind).sort(), ["flat-top", "one-tile"]);
  const good = [{ id: "w", op: "wall", points: [[0, 0], [40, 0]], handmade: {}, materials: { face: "surface:rubble", cap: "surface:ashlar" } }];
  assert.deepEqual(handmadeFaults(world({ operators: good })), []);
});

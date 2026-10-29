import { test } from "node:test";
import assert from "node:assert/strict";
import { createWorldField, defaultWorldRecipe, worldRecipeSchema } from "@hitreg/core";
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

test("terrace-place --check judges the selection's risers and town walls hand-made: a fault fails the check", async () => {
  const { terraceCheck } = await import("../tools/worldgen-terrace-walls.mts");
  const town = { id: "ash", center: [230, 220], radius: 60 };
  const townWorld = (dcRisers: object[], operators: object[]) => {
    const w = world({ dcRisers, operators }, tiles) as any;
    return worldRecipeSchema.parse({ ...w, features: { ...w.features, towns: [...w.features.towns, town] } });
  };
  // the crest is sampled on the riser's field; the wall ops do not touch it (and would only slow the field down)
  const check = (dc: object[], ops: object[], opts: { all?: boolean; ids?: string[] }) => terraceCheck(townWorld(dc, ops), { ...opts, field: createWorldField(townWorld(dc, [])) });
  const good = riser({ id: "ash-riser-1", owner: "ash", surfaces: painted });
  const flat = riser({ id: "ash-riser-1", owner: "ash", surfaces: painted, rough: { stepShare: 0, dropShare: 0 } });
  const mats = { face: "surface:rubble", footing: "surface:ashlar" };
  const handWall = { id: "ash-wall-1", op: "wall", points: [[200, 260], [260, 260]], handmade: {}, materials: mats };
  const machineWall = { id: "ash-wall-1", op: "wall", points: [[200, 260], [260, 260]], materials: mats };
  // a place's low skirt wall far from any town is neither a riser nor a town wall: never judged here
  const skirt = { id: "pb-camp-skirt", op: "wall", points: [[-400, -400], [-380, -400]], height: 0.5 };
  assert.equal(check([good], [handWall, skirt], { all: true }).bad, 0);
  const r = check([flat], [machineWall, skirt], { all: true });
  assert.deepEqual(r.handmade.map((f) => `${f.kind} ${f.wall}`).sort(), ["flat-top dcRisers/ash-riser-1", "flat-top operators/ash-wall-1"]);
  assert.equal(r.bad, 2);
  // --id <owner>: that town's risers and walls; a selection that names neither judges neither
  assert.equal(check([flat], [machineWall], { ids: ["ash"] }).bad, 2);
  assert.equal(check([flat], [machineWall], { ids: ["elsewhere"] }).bad, 0);
});

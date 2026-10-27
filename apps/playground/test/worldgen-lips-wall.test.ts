import { test } from "node:test";
import assert from "node:assert/strict";
import { defaultWorldRecipe, worldRecipeSchema } from "@hitreg/core";
import { openCutBand, terraceRiserBand, wallOperatorFaces } from "../tools/worldgen-lips.mts";

// a retaining `wall` operator's bank is the wall's job: the cells of its body (face foot to back + backfill) are risers
const base = worldRecipeSchema.parse({ ...defaultWorldRecipe(), cellSize: 48, resolution: 24 });
const withOps = (ops: Record<string, unknown>[]) => ({ ...base, features: { ...base.features, operators: ops } }) as typeof base;
// travel +x, face right: the exposed side is +z (right of travel, the [-dz, dx] normal as for ribbons)
const wall = { id: "qw", op: "wall", variant: "retaining", face: "right", points: [[0, 0], [100, 0]], thickness: 6, height: 30, batter: 0.08, scale: "giant" };

test("wallOperatorFaces: retaining/quay faces and ramp bodies, one band per plan leg", () => {
  assert.equal(wallOperatorFaces(withOps([{ ...wall, variant: "free" }, { ...wall, op: "landmark" }])).length, 0);
  // a causeway ramp hides the ground under its body: both sides out to the deck edge + parapet + 2.2 m, not beyond
  const ramp = terraceRiserBand(withOps([{ id: "r", op: "wall", variant: "ramp", points: [[0, 0], [100, 0]], thickness: 6, parapet: { thickness: 0.8 } }]));
  assert.equal(ramp(50, 0), true, "under the deck");
  assert.equal(ramp(50, 5.5) && ramp(50, -5.5), true, "the ground beside its faces");
  assert.equal(ramp(50, 7) || ramp(50, -7), false, "the ground clear of it");
  const [f] = wallOperatorFaces(withOps([wall]));
  assert.ok(f);
  // face line: t/2 + batter*h + giant footing projection = 3 + 2.4 + 0.8 = 6.2 m on the face side (+z)
  assert.ok(Math.abs(f.a[1]! - 6.2) < 1e-9 && Math.abs(f.b[0]! - 114) < 1e-9, "a terrain end runs on 2t+2 = 14 m");
  const [g] = wallOperatorFaces(withOps([{ ...wall, ends: { start: "none", end: "terrain", tie: 5 } }]));
  assert.ok(Math.abs(g!.a[0]!) < 1e-9 && Math.abs(g!.b[0]! - 105) < 1e-9, "a plain start stays put, the tie sets the run-on");
  assert.deepEqual(f.normal.map((v) => Math.round(v) + 0), [0, -1], "the band runs from the face INTO the wall");
});

test("terraceRiserBand: the wall body is exempt, the open floor in front and the hill well behind are not", () => {
  const band = terraceRiserBand(withOps([wall]));
  assert.equal(band(50, 7), true, "at the face foot");
  assert.equal(band(50, 0), true, "under the body");
  assert.equal(band(50, -5), true, "the earth just behind");
  assert.equal(band(50, 20), false, "the quarry floor in front");
  assert.equal(band(50, -30), false, "the hill behind (no backfill)");
  assert.equal(band(110, 0), true, "its terrain end's run-on into the hill");
  assert.equal(band(125, 0), false, "past the run-on");
  assert.equal(terraceRiserBand(withOps([{ ...wall, backfill: { width: 30, feather: 12 } }]))(50, -30), true, "inside its backfill");
  assert.equal(terraceRiserBand(withOps([{ ...wall, face: "left" }]))(50, 7), false, "face left: +z is the earth side, past the back");
});

test("openCutBand: an open box passage owns the cells it carves; a tunnel under the ground and the land beside do not", () => {
  const cutRecipe = { ...base, features: { ...base.features, passages: [
    { id: "court", start: [0, 100, 0], axis: "z", direction: 1, length: 20, width: 10, height: 30, wallNoise: 0, roofRise: 0 },
    { id: "tunnel", start: [100, 100, 0], axis: "x", direction: -1, length: 20, width: 6, height: 5, wallNoise: 0, roofRise: 0 },
  ] } } as unknown as typeof base;
  const ground = () => 110; // 10 m of hill over both floors
  const band = openCutBand(cutRecipe, ground);
  assert.equal(band(0, 10), true, "inside the court: the drawn surface is the passage floor");
  assert.equal(band(6, 10), true, "its wall band (half width + one lattice step)");
  assert.equal(band(9, 10), false, "the hill beside it");
  assert.equal(band(0, 25), false, "past its far end");
  assert.equal(band(90, 0), false, "a tunnel whose roof is under the ground opens nothing");
  assert.equal(openCutBand(cutRecipe, () => 100)(0, 10), false, "ground at the floor: nothing carved, the patch answers for it");
});

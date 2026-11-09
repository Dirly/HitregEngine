/**
 * THE GROUND (tools/_ground.mts): one answer to "where is the ground under (x, z)" for every placer and gate
 * (t-ground 2026-10-31, Derek: "Why is shit floating if we have code assist for placement?").
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { createWorldField, defaultWorldRecipe, worldRecipeSchema } from "@hitreg/core";
import { HOLE_DEPTH_M, walkField, walkGround, walkGroundFrom, walkGroundOf } from "../tools/_ground.mts";
import { holeAwareHeight } from "../tools/_place-quality.mts";
import { visibleGround } from "../tools/_landmark-ground.mts";

// density: negative = solid
const flat = (top: (x: number) => number) => (x: number, y: number) => (y > top(x) ? 1 : -1);

test("walkGroundOf: solid ground reads the drawn height exactly", () => {
  assert.equal(walkGroundOf(() => 100, flat(() => 100))(3, 4), 100);
});
test("walkGroundOf: the height map over a carved HOLE reads the hole's floor (to ~1 cm)", () => {
  const H = walkGroundOf(() => 100, flat((x) => (x > 0 ? 94.37 : 100)));
  assert.equal(H(-1, 0), 100);
  assert.ok(Math.abs(H(1, 0) - 94.37) < 0.01, `hole floor ${H(1, 0)}`);
});
test("walkGroundOf: a raised solid over the drawn height (a tread, a fill) reads its top; solid all the way up keeps the height", () => {
  assert.ok(Math.abs(walkGroundOf(() => 100, flat(() => 101.3))(0, 0) - 101.3) < 0.01);
  assert.equal(walkGroundOf(() => 100, () => -1)(0, 0), 100);
});
test("walkGroundOf: a bottomless shaft reads HOLE_DEPTH_M down (the piece is over a void)", () => {
  assert.equal(walkGroundOf(() => 100, () => 1)(0, 0), 100 - HOLE_DEPTH_M);
});
test("walkGroundFrom: a hall floor under a rock roof is read from the given height, never the cliff top (o-sunwine3 2026-10-31)", () => {
  // rock from y 30 up (the cliff over the hall), air 5..30 (the hall), solid under 5 (its floor)
  const density = (_x: number, y: number) => (y < 5 || y > 30 ? -1 : 1);
  assert.equal(walkGroundOf(() => 60, density)(0, 0), 60, "walkGround keeps the cliff top");
  assert.ok(Math.abs(walkGroundFrom({ density: (x, y, z) => density(x, y) }, 6)(0, 0) - 5) < 0.01);
});
test("holeAwareHeight and the landmark trim ground are the walked ground (one source)", () => {
  const h = () => 100, d = flat((x) => (x > 0 ? 94 : 100));
  assert.equal(holeAwareHeight(h, d)(1, 0), walkGroundOf(h, d)(1, 0));
  assert.ok(Math.abs(visibleGround({ height: h, density: d })(1, 0) - walkGroundOf(h, d)(1, 0)) < 1e-9);
});
test("walkField: height IS the walked ground, every other member untouched", () => {
  const f = { height: (_x: number, _z: number) => 100, density: flat((x) => (x > 0 ? 95 : 100)), waterY: () => null as number | null };
  const w = walkField(f);
  assert.ok(Math.abs(w.height(1, 0) - 95) < 0.01);
  assert.equal(w.waterY(), null);
  assert.equal(f.height(1, 0), 100);
});
test("walkGround on a real world field: a carved pit (blob remove) reads its floor, the height map does not", () => {
  const base = worldRecipeSchema.parse({ ...defaultWorldRecipe(), cellSize: 48, resolution: 24 });
  const h0 = createWorldField(base).height(10, 10);
  const pit = worldRecipeSchema.parse({ ...base, features: { ...base.features, blobs: [{ id: "pit", center: [10, h0, 10], radius: 4, op: "remove", falloff: 0 }] } });
  const f = createWorldField(pit), G = walkGround(f);
  assert.ok(f.height(10, 10) - G(10, 10) > 2, `height ${f.height(10, 10)} vs walked ${G(10, 10)}: the pit is invisible to the height map only`);
  assert.ok(f.density(10, G(10, 10) - 0.05, 10) < 0 && f.density(10, G(10, 10) + 0.05, 10) > 0, "the walked ground is the solid's surface");
  // away from the pit: within the lattice's reach of the drawn height, on the solid's surface
  assert.ok(Math.abs(G(40, 40) - f.height(40, 40)) < 0.5, `away from the pit ${G(40, 40)} vs ${f.height(40, 40)}`);
  assert.ok(f.density(40, G(40, 40) - 0.05, 40) < 0 && f.density(40, G(40, 40) + 0.05, 40) > 0);
});

import { seatedCounts, seatedExclusion } from "../tools/_place-quality.mts";
test("seated NO SILENT SKIPS: only pieces another gate judges are excluded (by name); everything else is measured or a fault", () => {
  assert.equal(seatedExclusion(["slot:set-piece"]), null);
  assert.equal(seatedExclusion([]), null, "a piece with no slot tag is measured (it used to be skipped)");
  assert.match(seatedExclusion(["slot:set-piece", "on:plinth"])!, /stands on plinth/);
  assert.match(seatedExclusion(["slot:fire"])!, /float/);
  assert.match(seatedExclusion(["slot:dwelling"], "wall")!, /wall-mounted/);
  const c = seatedCounts([{ ok: true }, { excluded: "x" }, { fault: "no base outline" }, { ok: false }]);
  assert.deepEqual(c, { pieces: 4, judged: 3, excluded: 1, faults: 2 });
});

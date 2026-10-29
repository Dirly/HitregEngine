import { test } from "node:test";
import assert from "node:assert/strict";
import { overlapFindings, placeBox, wallBox, type Face } from "../tools/town-kit-check.mts";

const face = (cx: number, cy: number, cz: number, img = "Stone"): Face => ({ i: 0, cx, cy, cz, nx: 1, nz: 0, ytop: cy + 1, img, mat: `m|${img}.png`, dressing: false, exterior: true });

test("wall box: wall-role faces above the grade band only (entry steps and roofs are not walls)", () => {
  const b = wallBox([face(-8, 2, -5), face(8, 2, 5), face(0, 0.4, -7, "ExteriorBottom"), face(20, 6, 0, "Roofing")]);
  assert.deepEqual(b, [-8, 8, -5, 5]);
  assert.equal(wallBox([face(0, 2, 0, "WoodGrain")]), null);
});

test("placeBox turns by the layout yaw (three.js about +Y) and moves to the centre", () => {
  assert.deepEqual(placeBox([-8, 8, -5, 7], 0, [10, 20]), [2, 18, 15, 27]);
  const r = placeBox([-8, 8, -5, 7], 180, [10, 20]).map((v) => Math.round(v * 1000) / 1000);
  assert.deepEqual(r, [2, 18, 13, 25]);
});

test("the Thirstgate fault: a request-sized lot whose wing builds into the neighbour fails both ways", () => {
  // tithe-vault and dry-cup: lots 2.5 m apart by their request outlines, built walls 4.1 m into each other
  const f = overlapFindings([
    { id: "tithe-vault", walls: [11.9, 37.9, 3.8, 22.4], ground: [[15.3, 4], [34.5, 4], [34.5, 20], [15.3, 20]] },
    { id: "dry-cup", walls: [33.8, 62.6, 4, 22], ground: [[37, 4], [59.4, 4], [59.4, 20], [37, 20]] },
  ]);
  assert.ok(f.some((x) => /tithe-vault and dry-cup: built walls intersect by 4\.1 x/.test(x)));
  assert.ok(f.some((x) => /^tithe-vault: built walls stand 3\.4 m outside/.test(x)));
});

test("lots spaced by their built walls pass; touching within 5 cm and eaves are fine", () => {
  assert.deepEqual(overlapFindings([
    { id: "a", walls: [0, 16, 4, 16], ground: [[0, 4], [16, 4], [16, 16], [0, 16]] },
    { id: "b", walls: [15.97, 30, 4, 14], ground: [[15.97, 4], [30, 4], [30, 14], [15.97, 14]] },
  ]), []);
});

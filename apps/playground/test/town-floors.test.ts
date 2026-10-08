import { test } from "node:test";
import assert from "node:assert/strict";
import { floorCheck, lattice } from "../tools/town-settle.mts";

type P = [number, number];
const sq = (x0: number, z0: number, x1: number, z1: number): P[] => [[x0, z0], [x1, z0], [x1, z1], [x0, z1]];

test("the lattice covers a quad at about 1 m", () => {
  const pts = lattice(sq(0, 0, 4, 2));
  assert.equal(pts.length, 15);
});

test("ground under the FULL footprint, not only the lot outline, is checked against the floor", () => {
  // a knoll at x > 5 that the lot outline (0..5) misses but the model's porch (to x = 7) stands on
  const top = (x: number): number => (x > 5 ? 10.6 : 10);
  const b = { id: "house", groundY: 10.15, ground: sq(0, 0, 5, 5), full: sq(0, 0, 7, 5) };
  const { failures, rows } = floorCheck([b], top);
  assert.equal(rows[0]!.footprint, "full");
  assert.equal(failures.length, 1);
  assert.match(failures[0]!, /terrain-through-floor house/);
  // a layout without `full` falls back to the lot outline (and here passes)
  assert.equal(floorCheck([{ ...b, full: undefined }], top).failures.length, 0);
});

// The placement solver's tool-side rules, from the Red Dial build 7 regressions (coordinator 2026-10-30).
import { test } from "node:test";
import assert from "node:assert/strict";
import { spreadSpots, SPREAD_CELL_M } from "../tools/_place-solve.mts";
import { seatStructure, solverRaise, solverSeats, type BaseOutline } from "../tools/_place-quality.mts";

test("a pushed prop never puts 3 of a plan's props in one 5 m cell (site-spread: heap-a, heap-c, spill-b in cell 5,2)", () => {
  // the Red Dial case: a heap with two neighbours 3 m to its east; moving east would make three in one cell
  const others: [number, number][] = [[3, 0], [3.5, 1]];
  const spots = spreadSpots([0, 0], others, 1.5);
  for (const [dx, dz] of spots) {
    const crowd = others.filter((o) => Math.abs(o[0] - dx) < SPREAD_CELL_M && Math.abs(o[1] - dz) < SPREAD_CELL_M).length;
    assert.ok(crowd < 2, `spot ${dx},${dz} would share a cell with ${crowd} others`);
  }
  // already in a crowd on every side within reach: no spot, the prop is dropped instead of crammed in
  assert.equal(spreadSpots([0, 0], [[1, 0], [-1, 0]], 1.5).length, 0);
  // alone: every spot is fine, nearest first
  assert.ok(spreadSpots([0, 0], [[20, 20]], 1.5).length > 0);
});

test("an open base the legacy seat levels or sinks stays with the legacy seat (walk reach: a slab left 1.38 m over the route)", () => {
  assert.equal(solverSeats({ level: true }), false);
  assert.equal(solverSeats({ level: false, sunk: true }), false); // an open yard sunk to its lowest ground keeps the route's height
  assert.equal(solverSeats({ level: false }), true);
  assert.equal(solverSeats(null), true);
});

test("a solver-founded base the walk meets gets a raise pad at the solver's height (tower-compounds yard: STUCK at a 1.6 m skirt)", () => {
  // the tower-compound yard: a closed 10 x 10 m base on a 1.6 m fall (ground rises toward +x)
  const cells: [number, number, number][] = [], perimeter: [number, number, number][] = [];
  for (let x = -5; x <= 5; x += 0.5) for (let z = -5; z <= 5; z += 0.5) { cells.push([x, z, 0]); if (Math.abs(x) === 5 || Math.abs(z) === 5) perimeter.push([x, z, 0]); }
  const base = { cells, perimeter, fill: 0.9, extent: [10, 10] } as unknown as BaseOutline;
  const ground = (x: number) => 70 + 0.16 * (x + 5); // 70 .. 71.6
  const legacy = seatStructure(base, [0, 0], 0, ground, { sinkMax: 0.3 });
  assert.ok(legacy.raise, "the legacy seat raised the ground to this base");
  // an open yard seated by the solver flush on its high side (71.57): the pad comes up over its base, as legacy's did
  const yard = solverRaise(legacy, 71.57, 0)!;
  assert.ok(yard.y > 71.57 && yard.y <= 71.57 + 0.15, `yard pad ${yard.y}`);
  assert.ok(yard.feather >= 4, "the feather is the ramp: never a cliff onto the pad");
  // a house (grade 0.3, floor at 71.87): the pad stays under the slab (the slab is the floor face), never in it
  const house = solverRaise(legacy, 71.87, 0.3, [0, -0.3])!;
  assert.ok(Math.abs(house.y - (71.87 - 0.35)) < 1e-6, `house pad ${house.y}`);
  // its own flats: a pad never lies within 3 cm of one
  const near = solverRaise(legacy, 71.57, 0, [legacy.raise!.y - legacy.y])!;
  assert.ok(Math.abs(near.y - (71.57 + legacy.raise!.y - legacy.y)) >= 0.03);
  // no raise when the legacy seat would not raise (a sunk or level base keeps the legacy path)
  assert.equal(solverRaise({ ...legacy, raise: null }, 71.57, 0), null);
});

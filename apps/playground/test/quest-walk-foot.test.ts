import { test } from "node:test";
import assert from "node:assert/strict";
import { cellFoot, edgeCost, finishAt, type WalkDeps } from "../tools/_quest-walk.mts";

test("cellFoot: open ground keeps the down-ray foot", () => {
  assert.equal(cellFoot(104, null, null), 104);
});
test("cellFoot: a stair tread over a dropped bottom face is stood on, not walked under", () => {
  // the 3 m ray started inside the stair: the first face above the terrain IS the tread top the sky ray hits
  assert.equal(cellFoot(104, 109.5, 109.5), 109.5);
});
test("cellFoot: a lintel or roof keeps the floor under it", () => {
  // up hits the soffit (134), the sky ray the lintel top (146): different faces, the floor stays
  assert.equal(cellFoot(120, 134, 146), 120);
});
test("cellFoot: a foot inside a built solid stands on its top, even under a roof", () => {
  // the terrain pokes up inside a gate's door platform (its bottom face just under the foot): the platform top (134.4), not the arch (168.4)
  assert.equal(cellFoot(130.4, 134.4, 168.4, true), 134.4);
  assert.equal(cellFoot(130.4, 134.4, 168.4, false), 130.4);
});
test("edgeCost: a built stair's risers are not an edge; a kerb and a terrain step are", () => {
  assert.equal(edgeCost(0.75, true), 0); // three 0.25 m risers across a cell diagonal
  assert.equal(edgeCost(1.0, true), 4); // a 1 m cheek wall
  assert.equal(edgeCost(0.75, false), 4); // the same rise on terrain stays an edge
});

/** A body on flat ground that moves at its intent (60 Hz); x >= wallX is a wall it cannot enter. */
const fakeBody = (start: [number, number], wallX = Infinity): { deps: WalkDeps; at: () => [number, number] } => {
  const pos = [start[0], 0, start[1]];
  const world = { fixedDt: 1 / 60, positionOf: () => pos } as unknown as WalkDeps["world"];
  const deps = { world, runSpeed: 6, stepWith: (v: [number, number]) => { pos[0] = Math.min(wallX - 0.4, pos[0]! + v[0] / 60); pos[2] = pos[2]! + v[1] / 60; }, tick: () => {} } as unknown as WalkDeps;
  return { deps, at: () => [pos[0]!, pos[2]!] };
};
test("finishAt: walks the last metres the planner stops short of (3 m off becomes < 1 m)", () => {
  const b = fakeBody([0, 0]);
  const left = finishAt(b.deps, [3, 0.5]);
  assert.ok(left < 1, `left ${left}`);
});
test("finishAt: a goal behind a wall stays a miss (no progress -> it stops, never teleports)", () => {
  const b = fakeBody([0, 0], 2);
  const left = finishAt(b.deps, [3.1, 0]);
  assert.ok(left > 1.4, `left ${left}`);
});

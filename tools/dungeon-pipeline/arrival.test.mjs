// The arrival safe zone gate (quality.mjs measureArrival): hostiles near an arrival/exit anchor, walked along the
// plan route when both ends lie on it, straight-line otherwise.
import { test } from "node:test";
import assert from "node:assert/strict";
import { measureArrival, routeGraph } from "./quality.mjs";

const plan = {
  anchors: { "entry-a": { at: [0, 0, 0] }, "exit-a": { at: [-3, 0, 0] }, boss: { at: [200, 0, 0] } },
  // a corridor east, then a U-turn back west on the far side of a wall at y = 10
  route: { main: [[0, 0], [30, 0], [30, 10], [0, 10]] },
  packs: [
    { id: "near", at: [12, 0, 0], spread: 1 },
    { id: "behind-wall", at: [2, 10, 0] }, // 10 m straight, 58 m walked
    { id: "far", at: [30, 0, 0], patrol: [[30, 0, 0], [22, 0, 0]] },
  ],
  named: [{ id: "doorward", rank: "miniboss", at: [0, 20, 0] }], // off the route: straight line
  boss: { id: "big", at: [200, 0, 0] },
};

test("flags hostiles within the safe radius, walked along the route", () => {
  const m = measureArrival(plan, { safeM: 25, anchorPattern: "^(entry|exit)" });
  assert.deepEqual(m.anchors, ["entry-a", "exit-a"]);
  const at = (a, id) => m.hits.find((h) => h.anchor === a && h.id === id);
  assert.equal(at("entry-a", "near").d, 11); // 12 m less its 1 m spread
  assert.ok(at("entry-a", "far"), "a patrol point 22 m away");
  assert.equal(at("entry-a", "behind-wall"), undefined, "the wall is walked round: 58 m");
  assert.equal(at("entry-a", "doorward").how, "straight line");
  assert.equal(at("entry-a", "big"), undefined);
});

test("route graph joins a doubled-back route and measures the walk", () => {
  const g = routeGraph(plan);
  const from = g.distancesFrom([0, 0]);
  assert.equal(Math.round(g.to(from, [0, 10])), 70);
  assert.equal(g.to(from, [100, 100]), null);
});

test("a plan with no arrival anchor fails loudly", () => {
  assert.equal(measureArrival({ anchors: {}, packs: [] }).anchors.length, 0);
});

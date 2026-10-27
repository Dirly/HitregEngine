import { test } from "node:test";
import assert from "node:assert/strict";
import { plannedRouteGap } from "../tools/zonegen/commands/reserve.mts";

// A road along z = 0 from x 0..100; a reservation of radius 50 at (500, 0): 350 m past the road's end.
const road = (px: number, pz: number, pr: number) => Math.hypot(Math.max(0, px - 100), pz) - pr;

test("reserve: no planned route keeps the direct gap", () => {
  assert.equal(plannedRouteGap(350, [], 500, 0, 50, road), 350);
});
test("reserve: a planned route anchored on its `from` is measured along the route", () => {
  assert.ok(plannedRouteGap(350, [[90, 0], [300, 0], [470, 0]], 500, 0, 50, road) < 0);
});
test("reserve: a route that never comes near its `from` does not count", () => {
  assert.equal(plannedRouteGap(350, [[400, 300], [480, 0]], 500, 0, 50, road), 350);
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { portalApproaches, type P3 } from "../tools/_quest-walk.mts";

const centre: P3 = [-11.3, 19.2, -203.2];
const half = [2.49, 1.79, 0.75] as const;
const front: P3 = [-11.3, 19.2, -199.2];
const back: P3 = [-11.3, 19.2, -207.2];

test("portalApproaches: an arrival 200 m from the exit is dropped; the walk starts at the portal's facing", () => {
  const r = portalApproaches(centre, half, [[0, 0.9, -3]], [front, back]);
  assert.deepEqual(r.map((x) => x.at), [front, back]);
  assert.ok(r.every((x) => !x.known));
});
test("portalApproaches: a nearby landed floor is tried first, as known floor", () => {
  const landed: P3 = [-9, 18.4, -196];
  const r = portalApproaches(centre, half, [landed, null], [front]);
  assert.deepEqual(r[0], { at: landed, known: true });
  assert.equal(r.length, 2);
});
test("portalApproaches: a nearby point on another floor (10 m+ above or below) is dropped", () => {
  assert.equal(portalApproaches(centre, half, [[-11, 5, -200]], [front]).length, 1);
});

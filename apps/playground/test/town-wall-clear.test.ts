import { test } from "node:test";
import assert from "node:assert/strict";
import { boxDistance, judgeTown, planBox, wallReach, yawOf, type Seg } from "../tools/_town-wall-clear.mts";

// a 10 x 20 m model whose local box is centred 2 m off its origin along z, placed at (100, 50, -200) turned 90 deg
const lo: [number, number, number] = [-5, -0.5, -8], hi: [number, number, number] = [5, 9, 12];

test("planBox turns the model box with the entity: the local +z long axis lies along world -x after a +90 deg yaw", () => {
  const b = planBox("hall", [100, 50, -200], Math.PI / 2, lo, hi);
  assert.equal(b.hx, 5); assert.equal(b.hz, 10);
  // local box centre (0, 2) -> world: x = cx + c*ox + s*oz = 100 + 0 + 1*2 = 102, z = cz - s*ox + c*oz = -200
  assert.ok(Math.abs(b.cx - 102) < 1e-9 && Math.abs(b.cz + 200) < 1e-9);
  // a point 9 m along local +z from the centre (inside, 1 m from the far end) is at world x = cx + 9 (c*0 + s*9)
  assert.ok(Math.abs(boxDistance(b, 102 + 9, -200) + 1) < 1e-6, "inside by 1 m along the long axis");
  // 1 m past the end: clearance 1
  assert.ok(Math.abs(boxDistance(b, 102 + 11, -200) - 1) < 1e-6);
  // beside the box across the short axis: local x is world z here
  assert.ok(Math.abs(boxDistance(b, 102, -200 + 7) - 2) < 1e-6);
  assert.equal(b.y0, 49.5); assert.equal(b.y1, 59);
});

test("wallReach: a wall edge running through a building reports the deepest reach; one beside it the clearance; one above or under the box is ignored", () => {
  const b = planBox("hall", [0, 10, 0], 0, [-5, 0, -5], [5, 8, 5]);
  const through: Seg[] = [{ a: [-20, 12, 2], b: [20, 12, 2] }];        // crosses the box at z = 2: deepest 3 m from the z = 5 side
  const beside: Seg[] = [{ a: [-20, 12, 6.5], b: [20, 12, 6.5] }];     // 1.5 m outside
  const above: Seg[] = [{ a: [-20, 30, 0], b: [20, 30, 0] }];          // over the roof: not judged
  const under: Seg[] = [{ a: [-20, 9, 0], b: [20, 9, 0] }];            // under the foot (10 + 0.3 slack): not judged
  const r1 = wallReach(b, through, "ring");
  assert.equal(r1.reach, 3); assert.equal(r1.wall, "ring");
  const r2 = wallReach(b, beside, "ring");
  assert.equal(r2.reach, 0); assert.equal(r2.clearance, 1.5);
  assert.equal(wallReach(b, above, "ring").samples, 0);
  assert.equal(wallReach(b, under, "ring").samples, 0);
});

test("judgeTown: a building a wall reaches into fails, one within the clearance fails, one clear passes; rows worst first", () => {
  const boxes = [planBox("a", [0, 0, 0], 0, [-5, 0, -5], [5, 6, 5]), planBox("b", [40, 0, 0], 0, [-5, 0, -5], [5, 6, 5]), planBox("c", [80, 0, 0], 0, [-5, 0, -5], [5, 6, 5])];
  const walls = [{ id: "ring", segs: [{ a: [-10, 2, 3], b: [10, 2, 3] }, { a: [30, 2, 5.3], b: [50, 2, 5.3] }, { a: [70, 2, 9], b: [90, 2, 9] }] as Seg[] }];
  const j = judgeTown(boxes, walls, 0.5);
  assert.deepEqual(j.rows.map((r) => `${r.id}:${r.ok ? "ok" : "FAIL"}`), ["a:FAIL", "b:FAIL", "c:ok"]);
  assert.equal(j.rows[0]!.reach, 2); assert.equal(j.rows[1]!.clearance, 0.3); assert.equal(j.rows[2]!.clearance, 4);
  assert.equal(j.bad, 2);
});

test("yawOf reads a y-axis quaternion", () => {
  const q = [0, Math.sin(0.66), 0, Math.cos(0.66)];
  assert.ok(Math.abs(yawOf(q) - 1.32) < 1e-9);
  assert.equal(yawOf(undefined), 0);
});

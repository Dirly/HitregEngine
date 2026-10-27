import { test } from "node:test";
import assert from "node:assert/strict";
import { snapRoadToGates, snapStreetToGates } from "../tools/_town-ground.mts";

type P = [number, number];
// Cindermoot's east gate: the wall runs north-south at x -575.5, the gate faces out east-north-east
const east = { at: [-575.55, -281.78] as P, facing: [0.788, 0.616] as P };
// the key-traced street started 2.4 m OUTSIDE the wall face, then ran west into the town
const street: P[] = [[-573.6, -280.4], [-576.31, -281.66], [-579.2, -282.3], [-582.1, -283], [-600, -285], [-633.4, -288]];

test("a street that stops beside a gate ends on the gate centre, the points past the mouth dropped", () => {
  const s = snapStreetToGates(street, [east]);
  assert.deepEqual(s.points[0], east.at);
  assert.ok(s.start && !s.end);
  // nothing left on the outward side of the gate
  for (const p of s.points.slice(1)) assert.ok((p[0] - east.at[0]) * east.facing[0] + (p[1] - east.at[1]) * east.facing[1] <= 0);
  // nor crowding it: the next point is a real street point >= 1.5 m in
  assert.ok(Math.hypot(s.points[1]![0] - east.at[0], s.points[1]![1] - east.at[1]) >= 1.5);
  // the far end, nowhere near a gate, is untouched
  assert.deepEqual(s.points.at(-1), street.at(-1));
});

test("either end snaps; a street far from every gate is left alone", () => {
  const north = { at: [-671.47, -335.74] as P, facing: [-0.567, -0.824] as P };
  const reversed = [...street].reverse();
  const s = snapStreetToGates(reversed, [east, north]);
  assert.deepEqual(s.points.at(-1), east.at);
  assert.ok(!s.start && s.end);
  const inner: P[] = [[-640, -290], [-630, -290]];
  const t = snapStreetToGates(inner, [east, north]);
  assert.deepEqual(t.points, inner);
  assert.ok(!t.start && !t.end);
});

test("a road doc keeps its per-point arrays in step with its points", () => {
  const road = { id: "town-2-street-street-2", points: street, surfaceY: [127, 127.1, 127.2, 127.3, 127.4, 128], width: 6.8 };
  const out = snapRoadToGates(road, [east], () => 126.9);
  assert.equal(out.surfaceY.length, out.points.length);
  assert.equal(out.surfaceY[0], 126.9);
  assert.equal(out.surfaceY.at(-1), 128);
  // a road already arriving at its gate is returned as is (a re-run writes nothing)
  assert.equal(snapRoadToGates(out, [east], () => 0), out);
  const inner = { id: "x", points: [[-640, -290], [-630, -290]] as P[], surfaceY: [1, 2] };
  assert.equal(snapRoadToGates(inner, [east], () => 0), inner);
});

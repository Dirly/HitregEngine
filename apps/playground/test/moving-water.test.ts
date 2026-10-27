import { test } from "node:test";
import assert from "node:assert/strict";
import { downhillRibbon, maxRise, uphillRibbonRows } from "../tools/_moving-water.mts";

test("downhillRibbon drops the spike a ceiling-high face put into a cascade", () => {
  const pts: [number, number, number][] = [[0, 14.5, 0], [0, 14.2, 1], [0, 13.9, 2], [0, 28.1, 3], [0, 12.9, 4], [0, 12.5, 5]];
  const r = downhillRibbon(pts, [6, 6, 6, 6, 6, 6]);
  assert.equal(r.dropped, 1);
  assert.deepEqual(r.points.map((p) => p[1]), [14.5, 14.2, 13.9, 12.9, 12.5]);
  assert.equal(r.widths!.length, 5);
});

test("maxRise measures water climbing after a low point; level and falling runs are 0", () => {
  assert.equal(maxRise([[0, 5, 0], [0, 4, 0], [0, 3, 0]]).rise, 0);
  assert.ok(Math.abs(maxRise([[0, 5, 0], [0, 3, 0], [0, 4.5, 0], [0, 2, 0]]).rise - 1.5) < 1e-9);
});

test("uphillRibbonRows reports only moving ribbons that climb", () => {
  const doc = { entities: {
    up: { name: "bad", components: { mesh: { source: { kind: "path", flowSpeed: 3, points: [[0, 14, 0], [0, 28, 1], [0, 12, 2]] } } } },
    ok: { name: "good", components: { mesh: { source: { kind: "path", flowSpeed: 3, points: [[0, 14, 0], [0, 12, 1]] } } } },
    road: { components: { mesh: { source: { kind: "path", points: [[0, 0, 0], [0, 9, 1]] } } } },
  } };
  const rows = uphillRibbonRows(doc);
  assert.deepEqual(rows.map((r) => r.id), ["up"]);
  assert.equal(rows[0]!.rise, 14);
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { riverSurfaceAt } from "../tools/worldgen-audit.mts";

test("the audit reads a river's solved level, not bed + 0.7 x depth (a tarn outlet held to the tarn)", () => {
  // skelmorrow's weepwater: level held at the tarn's 85.2 m, bed 3 m under it, depth 3.1 m
  const r = { points: [[0, 0], [10, 0]], bedY: [82.2, 81], surfaceY: [85.2, 84], depths: [3.1, 3.2], depth: 3.8 };
  assert.equal(riverSurfaceAt(r, 0), 85.2);
});

test("an unsolved river falls back to most of its depth over the bed", () => {
  const r = { points: [[0, 0], [10, 0]], bedY: [80, 79], depths: [3, 3], depth: 4 };
  assert.ok(Math.abs(riverSurfaceAt(r, 0) - 82.1) < 1e-9);
  assert.equal(riverSurfaceAt({ points: [[0, 0]], bedY: [10], depth: 0.2 }, 0), 10.4);
});

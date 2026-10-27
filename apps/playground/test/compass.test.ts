import { test } from "node:test";
import assert from "node:assert/strict";
import { bearingDir, compassBearing, facesDir, facesWord, facesYaw } from "../tools/_compass.mts";
import { placeFacing } from "../tools/_place-archetype.mts";
import { bearing } from "../tools/zonegen/commands/_site-finder.mts";

// The one compass: north = -Z, east = +X; a brief's faces text names where the FRONT looks.
test("compass words map to world directions and yaws (N = -Z)", () => {
  assert.deepEqual(facesDir("N"), [0, -1]);
  assert.deepEqual(facesDir("E to the sea"), [1, 0]);
  assert.deepEqual(facesDir("S over the fen trail (trail-peak-6.3) and W toward Sallow Force"), [0, 1]);
  assert.equal(facesWord("NE: the canyon mouth"), "NE");
  assert.equal(facesWord("Northern cliffs"), null);           // a word, not a compass point
  assert.equal(facesDir(undefined), null);
  assert.ok(Math.abs(facesYaw("E")! - Math.PI / 2) < 1e-12);
  assert.ok(Math.abs(Math.abs(facesYaw("N")!) - Math.PI) < 1e-12);
  // agrees with site-finder's bearing (0 = north = -Z, clockwise) for every point
  for (const w of ["N", "NE", "E", "SE", "S", "SW", "W", "NW"]) { const d = bearingDir(compassBearing(w)!); assert.ok(Math.abs(bearing(d[0], d[1]) - compassBearing(w)!) < 1e-9, w); }
});

test("place-build's place frame reads the brief through the compass", () => {
  assert.deepEqual(placeFacing([0, 0], "NW up the fen", []), facesDir("NW"));
  assert.deepEqual(placeFacing([0, 0], undefined, [[[0, 100]]]), [0, 1]);   // no faces: toward the approach
});

// The lighting stage's fill tone (lighting.mts dominantTone): the bucket most plan spaces use, toned by plan.lights
// (warm / cold -> bucket) or, for a bucket that map does not name, by lighting.json tones.byBucket.
import { test } from "node:test";
import assert from "node:assert/strict";
import { chooseTone, dominantTone } from "./lighting.mts";

const byBucket = { tomb: "warm", rime: "cold" };
const spaces = (b: string, n: number) => Array.from({ length: n }, () => ({ lights: b }));

test("plan.lights warm/cold map tones the spaces", () => {
  assert.equal(dominantTone({ lights: { warm: "camp", cold: "rime" }, spaces: [...spaces("rime", 3), ...spaces("camp", 1)] }, [], byBucket), "cold");
});
test("a plan.lights map naming only its bucket falls back to byBucket", () => {
  assert.equal(dominantTone({ lights: { bucket: "tomb" }, spaces: spaces("tomb", 4) }, [], byBucket), "warm");
});
test("no map: the dressing plans' buckets decide", () => {
  assert.equal(dominantTone(null, ["rime", "rime", "tomb"], byBucket), "cold");
  assert.equal(dominantTone(null, [], byBucket), "neutral");
});
test("a project lighting.json tone overrides the counted tone", () => {
  assert.equal(chooseTone({ tone: "cold" }, () => "warm"), "cold");
  assert.equal(chooseTone({ tone: "bogus" }, () => "warm"), "warm");
  assert.equal(chooseTone(null, () => "neutral"), "neutral");
});

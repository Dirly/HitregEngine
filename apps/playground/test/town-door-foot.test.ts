import { test } from "node:test";
import assert from "node:assert/strict";
import { DOOR_FOOT_SINK, KIT_STEP_DROP, doorFootY } from "../tools/_town-ground.mts";

test("a door path starts at the last tread when the ground at the door has fallen away", () => {
  // ore-house: floor 126.43, ground at the step foot 125.12 -> path raised to 125.75 (the bottom tread)
  assert.equal(+doorFootY(125.12, 126.43).toFixed(2), +(126.43 - KIT_STEP_DROP - DOOR_FOOT_SINK).toFixed(2));
  // never coplanar with the bottom tread (zfight): ground right at the tread goes just under it
  assert.ok(doorFootY(126.43 - KIT_STEP_DROP, 126.43) < 126.43 - KIT_STEP_DROP - 0.03);
  // ground already at/above the tread: left alone
  assert.equal(doorFootY(126.0, 126.43), 126.0);
  // no floor known: terrain
  assert.equal(doorFootY(125.12, undefined), 125.12);
});

test("a door path is burnt into the town patch: level inside the band, untouched beyond the shoulder", async () => {
  const { burnPathIntoPatch } = await import("../tools/_town-ground.mts");
  const patch = { origin: [0, 0], size: [10, 10], columns: 11, rows: 11, heights: new Array(121).fill(100) };
  const n = burnPathIntoPatch(patch, [[5, 0], [5, 10]], [101, 101], 1, 1);
  assert.ok(n > 0);
  assert.equal(patch.heights[5 * 11 + 5], 101); // on the path
  assert.equal(patch.heights[5 * 11 + 6], 101); // inside the half width
  assert.equal(patch.heights[5 * 11 + 8], 100); // beyond the shoulder
  assert.equal(burnPathIntoPatch(patch, [[5, 0], [5, 10]], [101, 101], 1, 1), 0); // idempotent
});

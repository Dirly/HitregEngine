import { test } from "node:test";
import assert from "node:assert/strict";
import { stageStamp } from "../tools/_stage-stamp.mts";

const now = new Date("2026-10-11T12:00:00.000Z");

test("a stage that changed something is stamped now", () => {
  assert.deepEqual(stageStamp("2026-10-11T10:00:00.000Z", [], false, now), { stamp: now.toISOString(), moved: false });
});

test("an unchanged stage whose inputs are older keeps its stamp", () => {
  assert.deepEqual(stageStamp("2026-10-11T10:00:00.000Z", ["2026-10-11T09:00:00.000Z", undefined], true, now), { stamp: "2026-10-11T10:00:00.000Z", moved: false });
});

test("an unchanged stage moves just past an input re-run after it (pinned towns after rivers)", () => {
  const r = stageStamp("2026-10-11T10:00:00.000Z", ["2026-10-11T11:00:00.000Z", "2026-10-11T09:00:00.000Z"], true, now);
  assert.equal(r.moved, true);
  assert.equal(r.stamp, "2026-10-11T11:00:00.001Z");
  assert.ok(Date.parse(r.stamp) < now.getTime());
});

test("a first run is stamped now", () => {
  assert.equal(stageStamp(undefined, ["2026-10-11T11:00:00.000Z"], true, now).stamp, now.toISOString());
});

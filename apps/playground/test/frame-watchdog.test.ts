import { test } from "node:test";
import assert from "node:assert/strict";
import { frameWatchdog } from "../tools/_frame-watchdog.mts";

const MIN = 60_000;

test("no frame within 10 min of the start is a hang", () => {
  let t = 0;
  const w = frameWatchdog({ now: () => t });
  t = 9 * MIN; assert.equal(w.check(), null);
  t = 10 * MIN + 1; assert.match(w.check()!, /0 frames/);
});

test("frames keep the run alive; a stall between spots is a hang", () => {
  let t = 0;
  const w = frameWatchdog({ now: () => t });
  t = 5 * MIN; w.spot("a"); t = 6 * MIN; w.frame();
  t = 15 * MIN; assert.equal(w.check(), null);
  t = 16 * MIN; w.spot("b");
  t = 25 * MIN; assert.equal(w.check(), null);
  t = 26 * MIN + 1; assert.match(w.check()!, /spot b/);
  assert.equal(w.frames, 1);
});

test("the limit is configurable", () => {
  let t = 0;
  const w = frameWatchdog({ now: () => t, limitMs: 1000 });
  t = 1001; assert.ok(w.check());
});

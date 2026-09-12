import { test } from "node:test";
import assert from "node:assert/strict";
import { startFramePump } from "../src/frame-pump.ts";

test("a throwing frame remains observable and does not permanently stop subsequent frames", () => {
  const queue: Array<(time: number) => void> = [];
  let ticks = 0, starts = 0, ends = 0;
  const error = new Error("render failed");
  startFramePump((callback) => queue.push(callback), () => {
    if (++ticks === 1) throw error;
  }, { beginFrame() { starts++; }, endFrame() { ends++; } });
  assert.throws(() => queue.shift()!(10), (e) => e === error);
  assert.equal(ends, 1);
  assert.equal(queue.length, 1);
  queue.shift()!(20);
  assert.equal(ticks, 2);
  assert.equal(starts, 2);
  assert.equal(ends, 2);
  assert.equal(queue.length, 1);
});

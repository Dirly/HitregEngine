import { describe, expect, it } from "vitest";
import { InterpolationClock, TransformInterpolator } from "../src/index.js";

const p = (x: number, y = 0, z = 0): [number, number, number] => [x, y, z];

describe("TransformInterpolator", () => {
  it("interpolates position linearly between bracketing snapshots", () => {
    const interp = new TransformInterpolator();
    interp.push(10, { a: { p: p(0) } });
    interp.push(20, { a: { p: p(10) } });
    expect(interp.sample(15).get("a")!.p).toEqual(p(5));
    expect(interp.sample(12.5).get("a")!.p).toEqual(p(2.5));
  });

  it("clamps before an entity's first sample; absence carries forward", () => {
    const interp = new TransformInterpolator();
    interp.push(10, { a: { p: p(0) }, sparse: { p: p(99) } });
    interp.push(20, { a: { p: p(10) } }); // "sparse" skipped this snapshot
    expect(interp.sample(5).get("a")!.p).toEqual(p(0));
    // sparse entities (sendEvery cadence) hold their last state, never vanish
    expect(interp.sample(15).get("sparse")!.p).toEqual(p(99));
  });

  it("despawn is explicit: remove(id) drops the stream", () => {
    const interp = new TransformInterpolator();
    interp.push(10, { a: { p: p(0) }, gone: { p: p(99) } });
    expect(interp.sample(10).has("gone")).toBe(true);
    interp.remove("gone");
    expect(interp.sample(10).has("gone")).toBe(false);
    expect(interp.ids()).toEqual(["a"]);
  });

  it("interpolates across an entity's own gaps (per-id streams)", () => {
    const interp = new TransformInterpolator();
    interp.push(10, { a: { p: p(0) }, slow: { p: p(0) } });
    interp.push(20, { a: { p: p(10) } }); // slow not due this tick
    interp.push(30, { a: { p: p(20) }, slow: { p: p(20) } });
    // slow interpolates its own 10→30 bracket, unaffected by tick 20
    expect(interp.sample(20).get("slow")!.p).toEqual(p(10));
    expect(interp.sample(20).get("a")!.p).toEqual(p(10));
  });

  it("ids appearing mid-stream pop in at their first known state", () => {
    const interp = new TransformInterpolator();
    interp.push(10, { a: { p: p(0) } });
    interp.push(20, { a: { p: p(10) }, fresh: { p: p(7) } });
    expect(interp.sample(15).get("fresh")!.p).toEqual(p(7));
  });

  it("extrapolates past the newest snapshot, capped, rotation held", () => {
    const interp = new TransformInterpolator({ maxExtrapolationTicks: 3 });
    interp.push(10, { a: { p: p(0), q: [0, 0, 0, 1] } });
    interp.push(20, { a: { p: p(10), q: [0, 1, 0, 0] } });
    // velocity = 1 unit/tick; 2 ticks past newest = 12
    expect(interp.sample(22).get("a")!.p).toEqual(p(12));
    expect(interp.sample(22).get("a")!.q).toEqual([0, 1, 0, 0]); // held, not spun
    // beyond the cap it holds at +3 ticks
    expect(interp.sample(60).get("a")!.p).toEqual(p(13));
  });

  it("interpolates yaw along the shortest arc (across the ±π seam)", () => {
    const interp = new TransformInterpolator();
    interp.push(0, { a: { p: p(0), yaw: Math.PI - 0.1 } });
    interp.push(10, { a: { p: p(0), yaw: -Math.PI + 0.1 } });
    const yaw = interp.sample(5).get("a")!.yaw!;
    // halfway across the seam, NOT through zero
    expect(Math.abs(Math.abs(yaw) - Math.PI)).toBeLessThan(1e-9);
  });

  it("nlerps quaternions along the shortest path, normalized", () => {
    const interp = new TransformInterpolator();
    interp.push(0, { a: { p: p(0), q: [0, 0, 0, 1] } });
    interp.push(10, { a: { p: p(0), q: [0, 0, 0, -1] } }); // same rotation, opposite sign
    const q = interp.sample(5).get("a")!.q!;
    expect(Math.hypot(...q)).toBeCloseTo(1, 9);
    expect(Math.abs(q[3])).toBeCloseTo(1, 9); // did not swing through zero
  });

  it("carries opaque data from the newer snapshot", () => {
    const interp = new TransformInterpolator();
    interp.push(0, { a: { p: p(0), data: { anim: "Idle" } } });
    interp.push(10, { a: { p: p(1), data: { anim: "Walk" } } });
    expect(interp.sample(5).get("a")!.data).toEqual({ anim: "Walk" });
  });

  it("handles out-of-order and duplicate pushes", () => {
    const interp = new TransformInterpolator();
    interp.push(20, { a: { p: p(10) } });
    interp.push(10, { a: { p: p(0) } }); // late arrival sorts in
    expect(interp.sample(15).get("a")!.p).toEqual(p(5));
    interp.push(20, { a: { p: p(20) } }); // duplicate tick replaces
    expect(interp.sample(15).get("a")!.p).toEqual(p(10));
  });

  it("evicts beyond maxSamples", () => {
    const interp = new TransformInterpolator({ maxSamples: 2 });
    interp.push(10, { a: { p: p(0) } });
    interp.push(20, { a: { p: p(1) } });
    interp.push(30, { a: { p: p(2) } });
    expect(interp.sample(10).get("a")!.p).toEqual(p(1)); // 10 evicted, clamps to 20
  });
});

describe("InterpolationClock", () => {
  it("starts at newest − delay, then advances by frame time minus servo pull", () => {
    const clock = new InterpolationClock({ hz: 20, delayTicks: 2 });
    expect(clock.advance(0.05)).toBeNull(); // no snapshots yet
    clock.onSnapshot(100);
    expect(clock.advance(0.05)).toBe(98);
    // +1 tick of frame time, then pulled back toward the (static) target
    expect(clock.advance(0.05)).toBeCloseTo(98.9, 5);
  });

  it("servos toward the target as snapshots arrive", () => {
    const clock = new InterpolationClock({ hz: 20, delayTicks: 2 });
    clock.onSnapshot(100);
    clock.advance(0.05); // 98
    clock.onSnapshot(101);
    clock.onSnapshot(102);
    // keep advancing 1 tick per frame; target is 100 — render approaches it
    let tick = 0;
    for (let i = 0; i < 40; i++) {
      clock.onSnapshot(102 + i);
      tick = clock.advance(0.05)!;
    }
    const target = 102 + 39 - 2;
    expect(Math.abs(tick - target)).toBeLessThan(1);
  });

  it("snaps when drift exceeds the threshold", () => {
    const clock = new InterpolationClock({ hz: 20, delayTicks: 2, snapThresholdTicks: 8 });
    clock.onSnapshot(100);
    clock.advance(0.05); // 98
    clock.onSnapshot(200); // huge gap (tab was backgrounded)
    expect(clock.advance(0.05)).toBeCloseTo(198, 0);
  });

  it("never runs unbounded past the newest snapshot", () => {
    const clock = new InterpolationClock({ hz: 20, delayTicks: 2 });
    clock.onSnapshot(100);
    clock.advance(0.05);
    // snapshots stop; 2 seconds of frames pass
    let tick = 0;
    for (let i = 0; i < 40; i++) tick = clock.advance(0.05)!;
    // servo pulls back toward target 98 even as frame time pushes forward
    expect(tick).toBeLessThan(100.5);
  });
});

import { describe, expect, it } from "vitest";
import { footfallsCrossed, FootfallTracker } from "../src/footfalls.js";

const WALK = [0.48, 0.98];
const RUN = [0, 0.5];

describe("footfallsCrossed", () => {
  it("fires a contact the playhead moves past", () => {
    expect(footfallsCrossed(0.4, 0.5, WALK)).toEqual([0]);
    expect(footfallsCrossed(0.5, 0.9, WALK)).toEqual([]);
  });

  it("is half-open, so a contact landed on exactly never fires twice", () => {
    expect(footfallsCrossed(0.4, 0.48, WALK)).toEqual([0]);
    expect(footfallsCrossed(0.48, 0.6, WALK)).toEqual([]);
  });

  it("handles the wrap from the end of the clip back to the start", () => {
    expect(footfallsCrossed(0.95, 0.05, WALK)).toEqual([1]);
    // a contact AT 0 belongs to the wrap
    expect(footfallsCrossed(0.97, 0.02, RUN)).toEqual([0]);
    expect(footfallsCrossed(0, 0.1, RUN)).toEqual([]);
  });

  it("reports several contacts in one tick in stride order", () => {
    // a high playback rate carries the playhead past both feet
    expect(footfallsCrossed(0.4, 0.99, WALK)).toEqual([0, 1]);
    expect(footfallsCrossed(0.9, 0.6, WALK)).toEqual([1, 0]);
  });

  it("adds whole extra loops the caller knows about", () => {
    expect(footfallsCrossed(0.4, 0.5, WALK, 1)).toEqual([0, 1, 0]);
  });

  it("does nothing when the playhead has not moved", () => {
    expect(footfallsCrossed(0.3, 0.3, WALK)).toEqual([]);
  });
});

describe("FootfallTracker", () => {
  it("anchors on its first read without firing", () => {
    const t = new FootfallTracker();
    expect(t.step("Walk", 0.47, WALK).count).toBe(0);
    expect(t.step("Walk", 0.5, WALK)).toEqual({ count: 1, foot: 0 });
  });

  it("alternates feet round a full cycle and never double-fires", () => {
    const t = new FootfallTracker();
    const fired: number[] = [];
    // ~2.5 cycles in 60 uneven steps
    let p = 0.1;
    t.step("Walk", p, WALK);
    for (let i = 0; i < 60; i++) {
      p = (p + 0.03 + (i % 3) * 0.02) % 1;
      const hit = t.step("Walk", p, WALK);
      for (let k = 0; k < hit.count; k++) fired.push(hit.foot);
    }
    expect(fired.length).toBeGreaterThanOrEqual(5);
    for (let i = 1; i < fired.length; i++) expect(fired[i]).not.toBe(fired[i - 1]);
  });

  it("counts multiple crossings in one tick at a high rate", () => {
    const t = new FootfallTracker();
    t.step("Run", 0.45, RUN);
    // rate x duration says 1.3 cycles went by, the playhead shows 0.3
    const hit = t.step("Run", 0.75, RUN, 1.3);
    expect(hit.count).toBe(3);
  });

  it("counts a phase-synced gait change against the new clip", () => {
    const t = new FootfallTracker();
    t.step("Walk", 0.45, WALK);
    expect(t.step("Run", 0.52, RUN)).toEqual({ count: 1, foot: 1 });
  });

  it("re-anchors silently when a clip change jumps the phase", () => {
    const t = new FootfallTracker();
    t.step("Walk", 0.6, WALK);
    // restarted at frame 0: 0.4 of a cycle 'moved', which is not stride progress
    expect(t.step("Run", 0.0, RUN).count).toBe(0);
    expect(t.step("Run", 0.1, RUN).count).toBe(0);
    expect(t.step("Run", 0.55, RUN).count).toBe(1);
  });

  it("fires nothing after a reset until it has anchored again", () => {
    const t = new FootfallTracker();
    t.step("Walk", 0.4, WALK);
    t.reset();
    expect(t.step("Walk", 0.5, WALK).count).toBe(0);
  });
});

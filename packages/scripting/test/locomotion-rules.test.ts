import { describe, expect, it } from "vitest";
import {
  actionIsLayered,
  fallThreshold,
  fitAction,
  gaitFor,
  GaitTracker,
  groundFollowVy,
  risingByGround,
  playbackRate,
  type GaitTuning,
} from "../src/index.js";

/**
 * The arithmetic both the local controller and the dedicated server run. It
 * lives in one module precisely so a body cannot walk on one screen and run on
 * another, so these are the rules stated once, in the open.
 */
const tuning: GaitTuning = { walkSpeed: 2, runSpeed: 6, sprintSpeed: 10 };

describe("gait thresholds", () => {
  it("picks a tier from speed", () => {
    expect(gaitFor(0, tuning)).toBe("idle");
    expect(gaitFor(2, tuning)).toBe("walk");
    expect(gaitFor(6, tuning)).toBe("run");
    expect(gaitFor(10, tuning)).toBe("sprint");
  });

  it("holds the tier it is in through the band around a threshold", () => {
    // the walk/run threshold is 4: just under it, a runner keeps running and a
    // walker keeps walking, which is the whole point
    expect(gaitFor(3.8, tuning, "run")).toBe("run");
    expect(gaitFor(4.2, tuning, "walk")).toBe("walk");
    // and far enough past it, both agree
    expect(gaitFor(5.5, tuning, "walk")).toBe("run");
    expect(gaitFor(2.5, tuning, "run")).toBe("walk");
  });
});

describe("gait dwell", () => {
  it("speeds up at once but will not drop back inside the window", () => {
    const t = new GaitTracker();
    expect(t.step(2, tuning, 0, 0.2)).toBe("walk");
    expect(t.step(6, tuning, 0.05, 0.2)).toBe("run"); // a speed-up is instant
    expect(t.step(1, tuning, 0.1, 0.2)).toBe("run"); // a reversal waits
    expect(t.step(1, tuning, 0.4, 0.2)).toBe("walk"); // …and then happens
  });
});

describe("the fall threshold", () => {
  it("grows with travel speed, because a slope takes you down as fast as you go along it", () => {
    // standing still, only a real drop counts
    expect(fallThreshold(0, 2, 0.8)).toBeCloseTo(2, 3);
    // running at 6 m/s, descending 6 m/s is a 39° slope, not a fall
    expect(fallThreshold(6, 2, 0.8)).toBeCloseTo(6.8, 3);
  });
});

describe("playback rate", () => {
  it("is travel over the speed the clip was authored at", () => {
    expect(playbackRate(3, 3)).toBeCloseTo(1, 3);
    expect(playbackRate(4.5, 3)).toBeCloseTo(1.5, 3);
  });

  it("clamps, so a badly matched pair reads as fast or slow, never as broken", () => {
    expect(playbackRate(0.1, 6)).toBeCloseTo(0.6, 3);
    expect(playbackRate(40, 6)).toBeCloseTo(2.5, 3);
  });
});

describe("fitting an action to its window", () => {
  it("stretches a short clip over a long cast instead of repeating it", () => {
    const fit = fitAction(1.2, 3);
    expect(fit.loop).toBe(false);
    expect(fit.rate).toBeCloseTo(0.4, 3);
  });

  it("speeds a long clip up to land on time", () => {
    const fit = fitAction(1.5, 0.75);
    expect(fit.loop).toBe(false);
    expect(fit.rate).toBeCloseTo(2, 3);
  });

  it("loops when the window is longer than the slowest playback covers", () => {
    const fit = fitAction(1, 60);
    expect(fit.loop).toBe(true);
    expect(fit.rate).toBeCloseTo(0.35, 3);
  });

  it("leaves an unmeasurable clip alone", () => {
    expect(fitAction(null, 3)).toEqual({ rate: 1, loop: true });
    expect(fitAction(1, 0)).toEqual({ rate: 1, loop: true });
  });
});

describe("where an action sits on the body", () => {
  it("layers over a moving body and takes the whole of a standing one", () => {
    expect(actionIsLayered(5, tuning)).toBe(true);
    expect(actionIsLayered(0, tuning)).toBe(false);
  });

  it("honours the caller's override either way", () => {
    expect(actionIsLayered(0, tuning, { blend: "layer" })).toBe(true);
    expect(actionIsLayered(5, tuning, { fullBody: true })).toBe(false);
  });
});

describe("following the ground", () => {
  const opts = { stick: 0.5, slopeTolerance: 0.8, dt: 1 / 60, ours: false };
  const down25: [number, number, number] = [0, Math.cos(0.4363), -Math.sin(0.4363)];

  it("returns the rate that keeps a body on the surface", () => {
    // 6 m/s toward -Z down a 25° slope: 2.8 m/s of descent
    expect(groundFollowVy(0, -6, 0, down25, 0, opts)).toBeCloseTo(-6 * Math.tan(0.4363), 3);
  });

  it("declines when the ground is out of reach, or too steep to walk", () => {
    expect(groundFollowVy(0, -6, 0, down25, 1.2, opts)).toBeNull();
    expect(groundFollowVy(0, -6, 0, [0, 0.3, -0.95], 0, opts)).toBeNull();
  });

  it("declines while somebody else is lifting the body, and not when we are", () => {
    expect(groundFollowVy(0, -6, 8, down25, 0, opts)).toBeNull(); // a jump
    expect(groundFollowVy(0, -6, 3, down25, 0, { ...opts, ours: true })).not.toBeNull();
  });

  it("leaves a body standing still to contact resolution", () => {
    expect(groundFollowVy(0, 0, 0, down25, 0, opts)).toBeNull();
  });

  it("closes a gap the last break opened", () => {
    const flat: [number, number, number] = [0, 1, 0];
    const v = groundFollowVy(0, -6, 0, flat, 0.3, opts)!;
    expect(v).toBeLessThan(0); // pulled down toward the surface
    expect(v).toBeGreaterThanOrEqual(-6 * 0.8); // but never faster than the cap
  });

  it("knows its own rise from anybody else's", () => {
    expect(risingByGround(3.0, 3.03)).toBe(true);
    expect(risingByGround(8.0, 3.03)).toBe(false);
    expect(risingByGround(3.0, null)).toBe(false);
  });
});

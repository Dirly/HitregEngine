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
  swimAim,
  swimStateFor,
  swimVy,
  swimming,
  type GaitTuning,
  type SwimTuning,
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

  it("takes back a collision pop off a step lip, but only when asked to", () => {
    const flat: [number, number, number] = [0, 1, 0];
    // an 18 cm threshold at a run leaves the solver with ~3.9 m/s of rise
    expect(groundFollowVy(0, -6.5, 3.9, flat, 0.05, opts)).toBeNull(); // old rule: a 0.78 m hop
    const guarded = { ...opts, popCap: 2 };
    expect(groundFollowVy(0, -6.5, 3.9, flat, 0.05, guarded)!).toBeLessThanOrEqual(0); // back on the floor
    expect(groundFollowVy(0, -6.5, 1.5, flat, 0.05, guarded)).toBeNull(); // a lift rising gently: untouched
    expect(groundFollowVy(0, -6.5, 3.9, flat, 1.2, guarded)).toBeNull(); // already well clear: a real launch
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

describe("swimming", () => {
  const swim: SwimTuning = {
    enterDepth: 1.35,
    exitDepth: 1,
    floatDepth: 0.1,
    buoyancy: 3.5,
    climbSpeed: 2.6,
  };

  it("starts swimming chest-deep and keeps swimming past that", () => {
    // (feet depth, water depth): standing on the bottom the two agree, which
    // is the case every one of these describes except where noted
    expect(swimStateFor(-0.5, 3, "dry", swim)).toBe("dry"); // in the air over the surface
    expect(swimStateFor(0.4, 0.4, "dry", swim)).toBe("wading"); // knee deep
    expect(swimStateFor(1.4, 1.4, "wading", swim)).toBe("swimming");
    // the hysteresis band: a swimmer holds on between exit and enter, while a
    // wader in the same water does not start
    expect(swimStateFor(1.2, 1.2, "swimming", swim)).toBe("swimming");
    expect(swimStateFor(1.2, 1.2, "wading", swim)).toBe("wading");
    expect(swimStateFor(0.9, 0.9, "swimming", swim)).toBe("wading"); // feet find the bottom
  });

  it("asks the BED whether a swimmer can stand, not its own float line", () => {
    // A floating body's feet hang at its float line, so in six metres of water
    // a swimmer reads a hand's depth over its feet. Judging
    // that against the exit threshold beached every swimmer the moment it
    // started stroking — the bug this pair of arguments exists to prevent.
    expect(swimStateFor(swim.floatDepth, 6, "swimming", swim)).toBe("swimming");
    // …and shallow water still ends it, however the body happens to be floating
    expect(swimStateFor(swim.floatDepth, 0.8, "swimming", swim)).toBe("wading");
  });

  it("floats to the waterline from either side without overshooting", () => {
    // too deep: rises. Riding higher than its line: settles back down.
    expect(swimVy(3, 0, swim)).toBeGreaterThan(0);
    expect(swimVy(swim.floatDepth - 0.08, 0, swim)).toBeLessThan(0);
    // and never faster than the climb speed, however far off the line it is
    expect(swimVy(50, 0, swim)).toBeLessThanOrEqual(swim.climbSpeed + 1e-9);

    // let it run: it settles at the float line rather than bobbing
    let depth = 3;
    let vy = 0;
    for (let i = 0; i < 600; i++) {
      vy = swimVy(depth, 0, swim);
      depth -= vy / 60; // rising reduces how much water is over the feet
    }
    expect(depth).toBeCloseTo(swim.floatDepth, 1);
  });

  it("swims at the speed it was asked for, and cannot launch itself out of the water", () => {
    // the request is a SPEED now — what the swimmer's aim works out to
    expect(swimVy(2, -2.6, swim)).toBeCloseTo(-2.6, 5);
    expect(swimVy(3, 1.4, swim)).toBeCloseTo(1.4, 5);
    // …except rising at the surface, which is cut to nothing rather than
    // launching the body clear of the water like a cork
    expect(swimVy(swim.floatDepth - 0.5, 2.6, swim)).toBeCloseTo(0, 5);
    // a request of nothing hands the body back to buoyancy
    expect(swimVy(3, null, swim)).toBeGreaterThan(0);
  });

  it("settles on its float line from either side, whatever it is doing", () => {
    const settle = (from: number): number => {
      let depth = from;
      let vy = 0;
      for (let i = 0; i < 900; i++) {
        vy = swimVy(depth, 0, swim);
        depth -= vy / 60;
      }
      return depth;
    };
    expect(settle(6)).toBeCloseTo(swim.floatDepth, 1); // rising from a dive
    expect(settle(-0.5)).toBeCloseTo(swim.floatDepth, 1); // dropping in from the air
  });

  it("strokes when it is going somewhere, treads when it is not", () => {
    expect(swimming(0, 0, 3.2)).toBe("tread");
    expect(swimming(2.5, 0, 3.2)).toBe("stroke");
    expect(swimming(0, -1, 3.2)).toBe("stroke"); // asking to dive
  });

  it("aims a swimmer where the camera looks, and lies the body along it", () => {
    const flat = [0, 0, -1] as const;
    const down45 = [0, -Math.SQRT1_2, -Math.SQRT1_2] as const;
    const cap = Math.PI / 3; // 60°

    // level, forward: all of the speed is horizontal and the body stays flat
    const level = swimAim(flat, 1, 0, 3.2, 0, cap);
    expect(level.velocity[1]).toBeCloseTo(0, 5);
    expect(Math.hypot(level.velocity[0], level.velocity[2])).toBeCloseTo(3.2, 5);
    expect(level.pitch).toBeCloseTo(0, 5);

    // looking 45° down with forward held: half the speed goes downward, and
    // the body pitches to match — nose-down is POSITIVE
    const dive = swimAim(down45, 1, 0, 3.2, 0, cap);
    expect(dive.velocity[1]).toBeCloseTo(-3.2 * Math.SQRT1_2, 4);
    expect(dive.pitch).toBeCloseTo(Math.PI / 4, 3);

    // the cap holds, however steep the look
    const straightDown = swimAim([0, -1, 0], 1, 0, 3.2, 0, cap);
    expect(straightDown.pitch).toBeCloseTo(cap, 5);

    // strafing stays horizontal: you do not roll to swim sideways
    const strafe = swimAim(down45, 0, 1, 3.2, 0, cap);
    expect(strafe.velocity[1]).toBeCloseTo(0, 5);
    expect(strafe.pitch).toBeCloseTo(0, 5);

    // a dive key with no movement still tips the nose down and descends
    const keyOnly = swimAim(flat, 0, 0, 3.2, -2.6, cap);
    expect(keyOnly.vertical).toBeCloseTo(-2.6, 5);
    expect(keyOnly.pitch).toBeCloseTo(cap, 5);
  });

  it("reads INTENT, not the body's own velocity", () => {
    // The pose picks the CLIP, and a clip chosen from `vy` flickers every time
    // the body settles onto its float line — a swimmer bobbing between the
    // stroke and the tread while doing nothing. Intent comes from outside that
    // loop: no input, no stroke, however fast the water is moving the body.
    expect(swimming(0, 0, 3.2)).toBe("tread");
    expect(swimming(0, -1, 3.2)).toBe("stroke");
  });
});

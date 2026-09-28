import { describe, expect, it } from "vitest";
import {
  airGravityScale,
  airSteer,
  extraGravityDv,
  groundFollowVy,
  jumpArc,
  probeLeaving,
  readGround,
  type GroundCast,
} from "../src/index.js";

/**
 * The jump and the ground reading, as pure arithmetic: the rules the
 * third-person controller and the dedicated server's player driver both run.
 */
const DEFAULTS = { jump: 6.2, riseGravity: 1.6, fallGravity: 2.2, cutGravity: 3 };

describe("the jump arc", () => {
  it("is an action-RPG jump at the defaults: ~1.2 m apex, ~0.73 s in the air", () => {
    const arc = jumpArc(DEFAULTS);
    expect(arc.apex).toBeGreaterThan(1.1);
    expect(arc.apex).toBeLessThan(1.3);
    expect(arc.airtime).toBeGreaterThan(0.7);
    expect(arc.airtime).toBeLessThan(0.8);
  });

  it("was a 2 m, 1.3 s float at plain gravity (the old tuning)", () => {
    const arc = jumpArc({ jump: 6.5, riseGravity: 1, fallGravity: 1, cutGravity: 1 });
    expect(arc.apex).toBeGreaterThan(2);
    expect(arc.airtime).toBeGreaterThan(1.3);
  });

  it("falls faster than it rises", () => {
    const up = DEFAULTS.jump / (9.81 * DEFAULTS.riseGravity);
    const arc = jumpArc(DEFAULTS);
    expect(arc.airtime - up).toBeLessThan(up); // the way down is the shorter half
  });

  it("a tap is a short hop", () => {
    const tap = jumpArc(DEFAULTS, { holdFor: 0.05 });
    const full = jumpArc(DEFAULTS);
    expect(tap.apex).toBeLessThan(full.apex * 0.7);
    expect(tap.apex).toBeGreaterThan(0.6); // still clears a knee-high rock
  });

  it("shapes only this body's own rise; every fall is heavy", () => {
    expect(airGravityScale(4, true, true, DEFAULTS)).toBe(1.6);
    expect(airGravityScale(4, true, false, DEFAULTS)).toBe(3);
    expect(airGravityScale(4, false, false, DEFAULTS)).toBe(1); // a launch pad keeps its arc
    expect(airGravityScale(-1, false, false, DEFAULTS)).toBe(2.2);
    expect(extraGravityDv(1, 1 / 60)).toBeCloseTo(0, 9);
    expect(extraGravityDv(2, 1 / 60)).toBeCloseTo(-9.81 / 60, 6);
  });
});

describe("air control", () => {
  it("keeps momentum with no input, at any airControl", () => {
    expect(airSteer(0, -6, 0, 0, false, 1, 1 / 60)).toEqual([0, -6]);
  });

  it("blends toward the input rather than overwriting", () => {
    const [, vz] = airSteer(0, -6, 0, 4, true, 0.3, 1 / 60);
    expect(vz).toBeGreaterThan(-6);
    expect(vz).toBeLessThan(-5);
    expect(airSteer(0, -6, 0, 4, true, 0, 1 / 60)).toEqual([0, -6]);
  });
});

describe("ground-following while climbing", () => {
  const flat: [number, number, number] = [0, 1, 0];
  const opts = { stick: 0.5, slopeTolerance: 0.8, dt: 1 / 60, ours: false, popCap: 2 };

  it("does not pull a body climbing a lip back down into it", () => {
    // axis still over the lower cell (0.25 m gap), contact lifting at 0.6 m/s
    const v = groundFollowVy(0, -6.5, 0.6, flat, 0.25, opts)!;
    expect(v).toBeGreaterThanOrEqual(0.6);
  });

  it("counts a rise past what it wrote as contact climbing, even when it looks like ours", () => {
    const v = groundFollowVy(0, -6.5, 0.6, flat, 0.25, { ...opts, ours: true, wrote: 0 })!;
    expect(v).toBeGreaterThanOrEqual(0.6);
    // and its own write, decaying under gravity, is still pulled onto the floor
    const settled = groundFollowVy(0, -6.5, -0.16, flat, 0.25, { ...opts, ours: true, wrote: 0 })!;
    expect(settled).toBeLessThan(0);
  });

  it("climbs steep marching-cubes faces at the rate the ground asks for", () => {
    // a 50° face: 6.5 m/s along it rises 7.7 m/s, which the old 0.8 ratio capped at 5.2
    const up50: [number, number, number] = [0, Math.cos(0.8727), Math.sin(0.8727)];
    const v = groundFollowVy(0, -6.5, 0, up50, 0.1, opts)!;
    expect(v).toBeCloseTo(6.5 * Math.tan(0.8727), 2);
  });

  it("still caps DOWNHILL by slopeTolerance", () => {
    const down50: [number, number, number] = [0, Math.cos(0.8727), -Math.sin(0.8727)];
    expect(groundFollowVy(0, -6.5, 0, down50, 0, opts)!).toBeCloseTo(-6.5 * 0.8, 5);
  });

  it("steps up a lip seen ahead, proportionally and capped", () => {
    const v = groundFollowVy(0, -6.5, 0, flat, 0, { ...opts, step: 0.3, stepReach: 0.6 })!;
    expect(v).toBe(5); // 2 x 0.3 x 6.5 / 0.6 = 6.5, capped
    const small = groundFollowVy(0, -2, 0, flat, 0, { ...opts, step: 0.1, stepReach: 0.6 })!;
    expect(small).toBeCloseTo((2 * 0.1 * 2) / 0.6, 5);
  });
});

describe("reading the ground under a capsule", () => {
  const up: [number, number, number] = [0, 1, 0];
  const base = { rest: 0.9, radius: 0.4, dirX: 0, dirZ: -1, stepHeight: 0.35, slack: 0.3 };

  it("takes the nearest footing when the centre hangs over a lower cell", () => {
    // the body runs toward -Z; the lip's top begins 0.2 m ahead of its axis
    const lip = (_dx: number, dz: number): GroundCast => ({ distance: dz < -0.2 ? 0.9 : 1.25, normal: up });
    const r = readGround(lip, base);
    expect(r.centre).toBeCloseTo(1.25, 5);
    expect(r.dist).toBeCloseTo(0.9, 5); // the forward ring point stands on the lip
    expect(probeLeaving({ dist: r.dist, rest: 0.9, slack: 0.3, stick: 0.5, vy: 1, launched: false })).toBe(false);
    // the single centre ray said airborne
    expect(probeLeaving({ dist: r.centre, rest: 0.9, slack: 0.3, stick: 0, vy: 0, launched: false })).toBe(true);
  });

  it("casts one ray when the centre is on the ground (plus the step ray)", () => {
    let casts = 0;
    readGround(() => {
      casts++;
      return { distance: 0.9, normal: up };
    }, base);
    expect(casts).toBe(2);
  });

  it("measures a lip ahead as a step, and ignores one too tall to step", () => {
    const low = readGround((_dx, dz) => ({ distance: dz < -0.5 ? 0.6 : 0.9, normal: up }), base);
    expect(low.step).toBeCloseTo(0.3, 5);
    expect(low.reach).toBeCloseTo(0.6, 5);
    const wall = readGround((_dx, dz) => ({ distance: dz < -0.5 ? 0.3 : 0.9, normal: up }), base);
    expect(wall.step).toBe(0);
  });

  it("does not mistake a smooth uphill slope for a step", () => {
    const n: [number, number, number] = [0, Math.cos(0.5), Math.sin(0.5)]; // ~29° up toward -Z
    const plane = (dx: number, dz: number): GroundCast => ({
      distance: 0.9 + (n[0] * dx + n[2] * dz) / n[1],
      normal: n,
    });
    expect(readGround(plane, base).step).toBeCloseTo(0, 5);
  });
});

describe("the probe's airborne decision", () => {
  const p = { rest: 0.9, slack: 0.3, stick: 0.5 };

  it("a launched rise is airborne however near the ground", () => {
    expect(probeLeaving({ ...p, dist: 0.9, vy: 5, launched: true })).toBe(true);
  });

  it("an unlaunched rise inside the stick distance is a climb", () => {
    expect(probeLeaving({ ...p, dist: 1.3, vy: 2, launched: false })).toBe(false);
    expect(probeLeaving({ ...p, dist: 1.5, vy: 2, launched: false })).toBe(true);
  });

  it("level or falling uses the contact slack", () => {
    expect(probeLeaving({ ...p, dist: 1.19, vy: 0, launched: false })).toBe(false);
    expect(probeLeaving({ ...p, dist: 1.3, vy: -1, launched: false })).toBe(true);
  });
});

import { describe, expect, it } from "vitest";
import { FixedTimestepLoop } from "../src/index.js";

describe("FixedTimestepLoop", () => {
  it("runs fixedHz steps per simulated second regardless of frame cadence", () => {
    let steps = 0;
    const loop = new FixedTimestepLoop({
      fixedHz: 60,
      maxSubSteps: 10,
      fixedUpdate: () => steps++,
    });
    // irregular frame times: 16ms, 33ms, 8ms... over exactly 1 second
    let t = 0;
    loop.tick(t);
    const frames = [16, 33, 8, 40, 16, 16, 33, 8, 40, 16];
    let total = 0;
    for (let i = 0; total < 1000; i++) {
      const dt = frames[i % frames.length]!;
      total = Math.min(1000, total + dt);
      t = total;
      loop.tick(t);
    }
    expect(steps).toBe(60);
  });

  it("clamps substeps instead of spiraling after a long stall", () => {
    let steps = 0;
    const loop = new FixedTimestepLoop({
      fixedHz: 60,
      maxSubSteps: 5,
      fixedUpdate: () => steps++,
    });
    loop.tick(0);
    loop.tick(5000); // 5s stall would be 300 steps unclamped
    expect(steps).toBe(5);
  });

  it("reports interpolation alpha in [0, 1)", () => {
    const alphas: number[] = [];
    const loop = new FixedTimestepLoop({
      fixedHz: 60,
      fixedUpdate: () => {},
      update: (_dt, alpha) => alphas.push(alpha),
    });
    loop.tick(0);
    for (let t = 7; t < 200; t += 7) loop.tick(t);
    expect(alphas.length).toBeGreaterThan(0);
    for (const a of alphas) {
      expect(a).toBeGreaterThanOrEqual(0);
      expect(a).toBeLessThan(1);
    }
  });
});

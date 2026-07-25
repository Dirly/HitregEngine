import { describe, expect, it } from "vitest";
import {
  approach,
  approachAngle,
  Easings,
  easingByName,
  lerp,
  lerpVec3,
  loopProgress,
  pingPongProgress,
} from "../src/easing.js";

describe("Easings", () => {
  it("every curve starts at 0 and ends at 1", () => {
    for (const [name, fn] of Object.entries(Easings)) {
      expect(fn(0), `${name}(0)`).toBeCloseTo(0, 5);
      expect(fn(1), `${name}(1)`).toBeCloseTo(1, 5);
    }
  });

  it("linear is the identity", () => {
    expect(Easings.linear(0.37)).toBe(0.37);
  });

  it("easeInQuad starts slow, easeOutQuad starts fast", () => {
    expect(Easings.easeInQuad(0.5)).toBeLessThan(0.5);
    expect(Easings.easeOutQuad(0.5)).toBeGreaterThan(0.5);
  });
});

describe("easingByName", () => {
  it("resolves a known name", () => {
    expect(easingByName("easeOutCubic")).toBe(Easings.easeOutCubic);
  });

  it("falls back to linear for an unknown name", () => {
    expect(easingByName("not-a-real-curve")(0.6)).toBe(0.6);
  });
});

describe("loopProgress", () => {
  it("once clamps at 1", () => {
    expect(loopProgress(0, 2, "once")).toBe(0);
    expect(loopProgress(1, 2, "once")).toBe(0.5);
    expect(loopProgress(2, 2, "once")).toBe(1);
    expect(loopProgress(5, 2, "once")).toBe(1);
  });

  it("loop repeats 0->1", () => {
    expect(loopProgress(0, 2, "loop")).toBe(0);
    expect(loopProgress(1, 2, "loop")).toBe(0.5);
    expect(loopProgress(2, 2, "loop")).toBeCloseTo(0, 10);
    expect(loopProgress(3, 2, "loop")).toBe(0.5);
  });

  it("pingpong triangles 0->1->0", () => {
    expect(loopProgress(0, 2, "pingpong")).toBe(0);
    expect(loopProgress(1, 2, "pingpong")).toBe(0.5);
    expect(loopProgress(2, 2, "pingpong")).toBe(1);
    expect(loopProgress(3, 2, "pingpong")).toBe(0.5);
    expect(loopProgress(4, 2, "pingpong")).toBeCloseTo(0, 10);
  });

  it("treats a non-positive duration as already-arrived", () => {
    expect(loopProgress(5, 0, "loop")).toBe(1);
  });
});

describe("pingPongProgress", () => {
  it("dwells at each end before traveling", () => {
    // travel=2s, dwell=1s -> cycle 6s
    expect(pingPongProgress(0, 2, 1)).toBe(0);
    expect(pingPongProgress(1, 2, 1)).toBe(0); // dwell just ended
    expect(pingPongProgress(2, 2, 1)).toBeCloseTo(0.5, 10); // 1s into A->B
    expect(pingPongProgress(3, 2, 1)).toBe(1); // reached B
    expect(pingPongProgress(4, 2, 1)).toBe(1); // dwelling at B
    expect(pingPongProgress(5, 2, 1)).toBeCloseTo(0.5, 10); // 1s into B->A
  });

  it("returns 0 for a degenerate (zero-length) leg", () => {
    expect(pingPongProgress(3, 0, 1)).toBe(0);
  });
});

describe("lerp / lerpVec3", () => {
  it("interpolates a scalar", () => {
    expect(lerp(0, 10, 0.5)).toBe(5);
  });

  it("interpolates a vec3 component-wise", () => {
    expect(lerpVec3([0, 0, 0], [10, -4, 2], 0.5)).toEqual([5, -2, 1]);
  });
});

describe("approach", () => {
  it("steps toward the target and clamps exactly at it", () => {
    expect(approach(0, 1, 0.3)).toBeCloseTo(0.3, 10);
    expect(approach(0.9, 1, 0.3)).toBe(1);
    expect(approach(1, 0, 0.3)).toBeCloseTo(0.7, 10);
  });

  it("is a no-op once at the target", () => {
    expect(approach(1, 1, 0.5)).toBe(1);
  });
});

describe("approachAngle", () => {
  it("takes the shortest arc across the +/-pi wrap", () => {
    const almostPi = Math.PI - 0.05;
    const result = approachAngle(-almostPi, almostPi, 0.2);
    // shortest arc goes the "short way" through +/-pi, moving further negative
    expect(result).toBeLessThan(-almostPi);
  });

  it("clamps to the target when within maxDelta", () => {
    expect(approachAngle(0, 0.1, 1)).toBeCloseTo(0.1, 10);
  });
});

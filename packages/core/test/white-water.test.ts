import { describe, expect, it } from "vitest";
import { RAPIDS_FOAM_SPEED, RIVER_LEDGE_CHURN, RIVER_MAX_SPEED, RIVER_STILL_SPEED, isLedge, ledgeChurnSpeed, rapidsFoam, riverFlowSpeed } from "../src/index.js";

/** White water by flow speed: surface gradient -> current -> froth, one mapping for the field and the water material. */
describe("white water by flow speed", () => {
  it("a still pool drifts and paints no froth", () => {
    expect(riverFlowSpeed(0, 8)).toBe(RIVER_STILL_SPEED);
    expect(rapidsFoam(riverFlowSpeed(0, 8))).toBe(0);
  });
  it("a 3 % run moves but stays dark; a 10 % rapid froths; a ledge step is white", () => {
    expect(rapidsFoam(riverFlowSpeed(0.24, 8))).toBe(0); // 3 %: ~0.98 m/s
    expect(rapidsFoam(riverFlowSpeed(0.8, 8))).toBeGreaterThan(0.25); // 10 %
    expect(rapidsFoam(riverFlowSpeed(1.5, 3.25))).toBe(1); // a 1.5 m ledge over its 3 m lip
  });
  it("speed rises monotonically with the gradient and is capped", () => {
    let last = 0;
    for (let g = 0; g <= 1; g += 0.02) {
      const s = riverFlowSpeed(g * 10, 10);
      expect(s).toBeGreaterThanOrEqual(last);
      last = s;
    }
    expect(riverFlowSpeed(50, 1)).toBeLessThanOrEqual(RIVER_MAX_SPEED);
    expect(RIVER_MAX_SPEED).toBeLessThan(3.15); // the plunge churn band starts there (scene-builder)
  });
  it("a ledge churns white below its lip and calms within the churn length", () => {
    expect(ledgeChurnSpeed(-1)).toBe(0);
    expect(ledgeChurnSpeed(0)).toBe(0); // eases in: no hard line at the lip
    expect(rapidsFoam(ledgeChurnSpeed(2, 1.5))).toBeGreaterThan(0.9);
    // a low riffle froths, a tall ledge boils
    expect(rapidsFoam(ledgeChurnSpeed(3, 0.6))).toBeLessThan(rapidsFoam(ledgeChurnSpeed(3, 1.5)));
    expect(rapidsFoam(ledgeChurnSpeed(3, 0.6))).toBeGreaterThan(0.2);
    expect(rapidsFoam(ledgeChurnSpeed(RIVER_LEDGE_CHURN * 0.5))).toBeGreaterThan(0.3);
    expect(ledgeChurnSpeed(RIVER_LEDGE_CHURN + 0.1)).toBe(0);
  });
  it("ledges are short steps under a fall's height", () => {
    expect(isLedge(1.5, 3, 3)).toBe(true);
    expect(isLedge(2.5, 3, 3)).toBe(false); // a fall: its own curtain
    expect(isLedge(0.2, 3, 3)).toBe(false); // a ripple
    expect(isLedge(1.5, 8, 3)).toBe(false); // a run, not a step
  });
  it("the froth band is the material's", () => {
    expect(rapidsFoam(RAPIDS_FOAM_SPEED[0])).toBe(0);
    expect(rapidsFoam(RAPIDS_FOAM_SPEED[1])).toBe(1);
  });
});

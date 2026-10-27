import { describe, expect, it } from "vitest";
import { DryWaterMemo, WATER_DRY_MARGIN, WATER_RESAMPLE_M, WATER_RESAMPLE_STEPS } from "../src/index.js";

/** A sea at y = 0 everywhere, counting how often it is asked. */
function sea() {
  const q = { calls: 0, fn: (_x: number, y: number) => (q.calls++, { surfaceY: 0, depth: -y }) };
  return q;
}

describe("DryWaterMemo", () => {
  it("reuses a clearly-dry reading while the feet barely move, with the depth kept exact", () => {
    const q = sea();
    const memo = new DryWaterMemo();
    expect(memo.sample(0, 5, 0, q.fn)!.depth).toBe(-5);
    const again = memo.sample(0.1, 5.2, 0, q.fn)!;
    expect(q.calls).toBe(1);
    expect(again.depth).toBeCloseTo(-5.2, 9);
  });

  it("asks again after moving WATER_RESAMPLE_M, or after WATER_RESAMPLE_STEPS reuses", () => {
    const q = sea();
    const memo = new DryWaterMemo();
    memo.sample(0, 5, 0, q.fn);
    memo.sample(WATER_RESAMPLE_M + 0.01, 5, 0, q.fn);
    expect(q.calls).toBe(2);
    for (let i = 0; i < WATER_RESAMPLE_STEPS; i++) memo.sample(WATER_RESAMPLE_M + 0.01, 5, 0, q.fn);
    expect(q.calls).toBe(2);
    memo.sample(WATER_RESAMPLE_M + 0.01, 5, 0, q.fn);
    expect(q.calls).toBe(3);
  });

  it("never reuses a wet or nearly-wet reading", () => {
    const q = sea();
    const memo = new DryWaterMemo();
    memo.sample(0, WATER_DRY_MARGIN * 0.5, 0, q.fn); // feet half a margin over the surface
    memo.sample(0, WATER_DRY_MARGIN * 0.5, 0, q.fn);
    memo.sample(0, -1, 0, q.fn); // in it
    memo.sample(0, -1, 0, q.fn);
    expect(q.calls).toBe(4);
  });

  it("reuses 'no water at all' too", () => {
    let calls = 0;
    const memo = new DryWaterMemo();
    memo.sample(0, 0, 0, () => (calls++, null));
    expect(memo.sample(0.2, 0, 0, () => (calls++, null))).toBeNull();
    expect(calls).toBe(1);
  });
});

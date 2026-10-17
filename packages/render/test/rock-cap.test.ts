import { describe, expect, it } from "vitest";
import { encodeRockCap, instanceTintOf, rockCapAsInstanceTint, wetCode } from "../src/rock-cap.js";
import { encodeVegetationTint } from "../src/vegetation-tint.js";

describe("rock-cap per-instance slot", () => {
  it("encodes [1 - amount, layer, -1 - base, tint] so an untouched slot is a bare base-0 rock", () => {
    expect(encodeRockCap({ layer: 3, amount: 0.7, base: 1, tint: [0.9, 1, 0.8] })).toEqual([1 - 0.7, 3, -2, 0.9, 1, 0.8]);
    expect(encodeRockCap(undefined)).toEqual([1, 1, 1, 1, 1, 1]);
    // the rock marker (negative third float) never collides with a tint, which is never below zero
    expect(encodeRockCap({ layer: 0, amount: 0, base: 0 })[2]).toBeLessThan(0);
    expect(encodeVegetationTint({ bark: [0, 0, 0], leaves: [0, 0, 0] })[2]).toBeGreaterThanOrEqual(0);
  });

  it("rides in the vegetation-tint shaped record, a vegetation tint winning", () => {
    const cap = { layer: 2, amount: 0.5, base: 0, tint: [1, 1, 1] as [number, number, number] };
    expect(encodeVegetationTint(rockCapAsInstanceTint(cap))).toEqual(encodeRockCap(cap));
    const tint = { bark: [0.5, 0.5, 0.5] as [number, number, number], leaves: [1, 1, 1] as [number, number, number] };
    expect(instanceTintOf({ vegetationTint: tint, rockCap: cap })).toBe(tint);
    expect(instanceTintOf({})).toBeUndefined();
  });

  it("packs the waterline into the base float without disturbing the base", () => {
    const wet = encodeRockCap({ layer: 1, amount: 0.3, base: 1, wet: 0.42 })[2]!;
    const code = Math.round(-1 - wet);
    expect(code % 8).toBe(1); // the base, as the shader decodes it
    expect(Math.floor(code / 8)).toBe(1 + 84); // 1 + the line in 1/200ths
    expect(Number.isInteger(wet)).toBe(true);
    expect(Math.abs(wet)).toBeLessThan(2048); // exact in a half float
    expect(wetCode(undefined)).toBe(0);
    expect(wetCode(0)).toBe(0);
    expect(encodeRockCap({ layer: 0, amount: 0, base: 1 })[2]).toBe(-2); // dry rocks unchanged
  });
});

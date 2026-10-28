import { describe, expect, it } from "vitest";
import { softenCoverage } from "../src/cloud-shadow.js";

/** A 1-bit cloud: the left half covered, the right half clear (tiling, so there are two edges). */
function hardEdge(size: number): Float32Array {
  const f = new Float32Array(size * size);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) f[y * size + x] = x < size / 2 ? 1 : 0;
  return f;
}

describe("cloud shadow mask softening", () => {
  it("turns a 1-bit edge into a monotone ramp wider than the art's blocks", () => {
    const size = 64;
    const f = softenCoverage(hardEdge(size), size, size);
    const row = Array.from(f.subarray(0, size));
    // inside the cloud and in the clear the field is still (nearly) 1 and 0
    expect(row[16]).toBeGreaterThan(0.99);
    expect(row[48]).toBeLessThan(0.01);
    // the edge at x=32 is a ramp, not a step: 0.9..0.1 spans more than 8 texels (two of the art's 4-texel blocks)
    const first = row.findIndex((v, i) => i >= 16 && v < 0.9);
    const last = row.findIndex((v, i) => i >= 16 && v < 0.1);
    expect(last - first).toBeGreaterThan(8);
    for (let x = first; x < last; x++) expect(row[x + 1]!).toBeLessThanOrEqual(row[x]! + 1e-6);
  });

  it("conserves coverage and wraps at the tile edge", () => {
    const size = 32;
    const before = hardEdge(size);
    const sum0 = before.reduce((a, b) => a + b, 0);
    const f = softenCoverage(before.slice(), size, size);
    const sum1 = f.reduce((a, b) => a + b, 0);
    expect(sum1).toBeCloseTo(sum0, 3);
    // the cloud's left edge is at x=0 wrapping from x=31: both sides of the seam are mid-ramp, not a hard step
    expect(f[0]!).toBeLessThan(0.99);
    expect(f[size - 1]!).toBeGreaterThan(0.01);
    // every row identical (the blur is separable and the field is x-only)
    for (let y = 1; y < size; y++) expect(f[y * size + 5]).toBeCloseTo(f[5]!, 6);
  });

  it("is a no-op with no radius or no passes", () => {
    const size = 8;
    const f = hardEdge(size);
    expect(Array.from(softenCoverage(f.slice(), size, size, 0, 3))).toEqual(Array.from(f));
    expect(Array.from(softenCoverage(f.slice(), size, size, 2, 0))).toEqual(Array.from(f));
  });
});

import { describe, expect, it } from "vitest";
import { createWorldField, defaultWorldRecipe, worldRecipeSchema, type RoadDoc, type WorldRecipe } from "../src/index.js";

// redstrand 2026-10-30 (w13): beside a SHORT segment the two segments either side of it are about equally far and swap
// places as the runner-up of the seam blend along their bisector, so the embankment band took one neighbour's grade on
// one side of that line and the other's on the other: a 1.2 m step 11 m off road-moon. `seam: "pooled"` mixes every
// segment near the nearest with continuous weights. And a tread held at its maxCut under the ground kept that depth
// across its band and lifted back to the ground in the last 4 m (a 1 m rim): `capBand: "taper"` eases it back.
const base = defaultWorldRecipe();
const plain = createWorldField(worldRecipeSchema.parse({ ...base, features: { ...base.features, roads: [] } }));
const road = (extra: Partial<RoadDoc>, pts: [number, number][], ys: number[], left: number[], right: number[]): WorldRecipe =>
  worldRecipeSchema.parse({
    ...base,
    features: { ...base.features, roads: [{ id: "road-t", points: pts, width: 6, shoulder: 4, smooth: 8, surfaceY: ys, leftY: left, rightY: right, ...extra }] },
  });
// a climbing line with a 15 m middle segment between two longer ones (road-moon points 16-19)
const P: [number, number][] = [[0, 0], [6, 7], [9, 13], [12, 28], [15, 34]];
const g = P.map(([x, z]) => plain.height(x, z));
const Y = [g[0]! + 1, g[1]! + 2.2, g[2]! + 1, g[3]! - 1.8, g[4]! - 3];
const maxJump = (f: { height(x: number, z: number): number }) => {
  // along the line 11 m west of the short segment, across where the runner-up swaps
  let worst = 0, prev = NaN;
  for (let t = 0; t <= 400; t++) {
    const x = -3 + (t / 400) * 6, z = 21, h = f.height(x, z);
    if (!Number.isNaN(prev)) worst = Math.max(worst, Math.abs(h - prev));
    prev = h;
  }
  return worst;
};

describe("road seam: pooled", () => {
  it("leaves no step in the band beside a short segment", () => {
    const pooled = createWorldField(road({ seam: "pooled" }, P, Y, Y.map((y) => y + 4), Y.map((y) => y - 4)));
    // 1.5 cm sampling: a smooth band moves well under 10 cm per step; a swap moved over a metre at once
    expect(maxJump(pooled)).toBeLessThan(0.1);
  });
  it("is opt-in: an unflagged road keeps the runner-up blend", () => {
    const a = createWorldField(road({}, P, Y, Y.map((y) => y + 4), Y.map((y) => y - 4)));
    const b = createWorldField(road({ seam: "runner-up" }, P, Y, Y.map((y) => y + 4), Y.map((y) => y - 4)));
    for (const [x, z] of [[0, 21], [10, 10], [20, 30]] as const) expect(a.height(x, z)).toBe(b.height(x, z));
  });
});

describe("road capBand: taper", () => {
  // a straight road graded 10 m under the ground, its tread held at maxCut 3; the side samples claim a bank far below
  const S: [number, number][] = [[0, 0], [0, 80]];
  const sg = S.map(([x, z]) => plain.height(x, z));
  const ys = sg.map((y) => y - 10);
  const make = (extra: Partial<RoadDoc>) => createWorldField(road({ maxCut: 3, ...extra }, S, ys, ys.map((y) => y - 6), ys.map((y) => y - 6)));
  it("eases the band back to the ground across its width (never deeper than the tapered cap)", () => {
    const f = make({ capBand: "taper" });
    for (const d of [4, 6, 8, 10, 12, 14]) {
      const keep = 1 - (() => { const t = Math.min(1, Math.max(0, (d - 3) / 12)); return t * t * (3 - 2 * t); })();
      const depth = plain.height(d, 40) - f.height(d, 40);
      expect(depth).toBeLessThanOrEqual(3 * keep + 0.4 * keep + 0.02);
    }
    // the tread itself still sits at its cap
    expect(plain.height(0, 40) - f.height(0, 40)).toBeCloseTo(3, 1);
  });
  it("without it the band holds the tread's depth out to its fade (the rim the taper removes)", () => {
    const f = make({});
    expect(plain.height(10, 40) - f.height(10, 40)).toBeGreaterThan(2.5);
  });
});

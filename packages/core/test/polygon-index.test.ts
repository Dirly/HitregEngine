import { describe, expect, it } from "vitest";
import { FAR_INSIDE, FAR_OUTSIDE, PolygonIndex } from "../src/voxel/polygon-index.js";

/** Exact signed distance the slow way: nearest edge + even-odd inside test. */
function exact(poly: readonly (readonly [number, number])[], x: number, z: number): number {
  let best = Infinity;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i]!;
    const b = poly[(i + 1) % poly.length]!;
    const dx = b[0] - a[0];
    const dz = b[1] - a[1];
    const l = dx * dx + dz * dz;
    const t = l < 1e-12 ? 0 : Math.max(0, Math.min(1, ((x - a[0]) * dx + (z - a[1]) * dz) / l));
    best = Math.min(best, Math.hypot(x - (a[0] + dx * t), z - (a[1] + dz * t)));
  }
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i]!;
    const b = poly[j]!;
    if (a[1] > z !== b[1] > z && x < ((b[0] - a[0]) * (z - a[1])) / (b[1] - a[1]) + a[0]) inside = !inside;
  }
  return inside ? -best : best;
}

// a concave lake: a C shape with a bay, clockwise as traced (the index must normalise it)
const lake: [number, number][] = [
  [0, 0], [300, 0], [300, 80], [120, 80], [120, 160], [300, 160], [300, 240], [0, 240], [0, 180], [60, 120], [0, 60],
];

describe("PolygonIndex", () => {
  const index = new PolygonIndex([{ kind: "polygon", points: lake, band: 40 }]);

  it("matches the exact signed distance everywhere within the band", () => {
    let seed = 7;
    const rand = (): number => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
    let checked = 0;
    for (let k = 0; k < 4000; k++) {
      const x = -80 + rand() * 460;
      const z = -80 + rand() * 400;
      const truth = exact(lake, x, z);
      const got = index.signedDistance(0, x, z);
      if (Math.abs(truth) <= 36) {
        // well inside the band: exact to the metre-millimetre
        expect(got).toBeCloseTo(truth, 3);
        checked++;
      } else if (truth > 0) {
        // outside: either exact or the far sentinel, never a negative
        expect(got === FAR_OUTSIDE || Math.abs(got - truth) < 1e-3).toBe(true);
      } else {
        expect(got === FAR_INSIDE || Math.abs(got - truth) < 1e-3).toBe(true);
      }
    }
    expect(checked).toBeGreaterThan(500);
  });

  it("gets the sign right at the concave corners", () => {
    // just inside the bay's inner corner (120, 80): inside the bay = OUTSIDE the water
    expect(index.signedDistance(0, 122, 82)).toBeGreaterThan(0);
    // just outside the inner corner on the water side
    expect(index.signedDistance(0, 118, 78)).toBeLessThan(0);
    // the re-entrant notch at (60, 120): water on the right of it
    expect(index.signedDistance(0, 64, 120)).toBeLessThan(0);
    expect(index.signedDistance(0, 56, 120)).toBeGreaterThan(0);
  });

  it("keeps a disc analytic", () => {
    const disc = new PolygonIndex([{ kind: "disc", center: [10, -20], radius: 50 }]);
    expect(disc.signedDistance(0, 10, -20)).toBeCloseTo(-50, 9);
    expect(disc.signedDistance(0, 70, -20)).toBeCloseTo(10, 9);
  });
});

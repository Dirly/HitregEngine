import { describe, expect, it } from "vitest";
import { pathGeometry } from "../src/path-mesh.js";
import { pathScatterPlacements, type PathScatterData } from "../src/path-scatter.js";

const straightLine: Array<[number, number, number]> = [
  [0, 0, 0],
  [10, 0, 0],
  [20, 0, 0],
];

describe("pathGeometry", () => {
  it("builds a ribbon with two verts per sample and a valid triangle index buffer", () => {
    const geometry = pathGeometry({
      points: straightLine,
      closed: false,
      crossSection: "ribbon",
      width: 4,
      radius: 0.15,
      radialSegments: 6,
      segmentsPerSpan: 4,
    });
    const position = geometry.getAttribute("position");
    // 2 spans * 4 segments/span + 1 = 9 samples, 2 verts each (left/right edge)
    expect(position.count).toBe(18);
    const index = geometry.getIndex();
    expect(index).not.toBeNull();
    expect(index!.count % 3).toBe(0);
    for (let i = 0; i < index!.count; i++) {
      expect(index!.getX(i)).toBeLessThan(position.count);
    }
  });

  it("centers a width-4 ribbon on the curve (edges 2 units either side)", () => {
    const geometry = pathGeometry({
      points: straightLine,
      closed: false,
      crossSection: "ribbon",
      width: 4,
      radius: 0.15,
      radialSegments: 6,
      segmentsPerSpan: 1,
    });
    const position = geometry.getAttribute("position");
    // first sample sits at the first control point [0,0,0]; a straight line
    // along +X gives a side vector along +/-Z, so edges land at z = +/-2
    const leftZ = position.getZ(0);
    const rightZ = position.getZ(1);
    expect(Math.abs(leftZ)).toBeCloseTo(2, 5);
    expect(Math.abs(rightZ)).toBeCloseTo(2, 5);
    expect(leftZ).toBeCloseTo(-rightZ, 5);
  });

  it("builds a tube with a nonzero, indexed geometry", () => {
    const geometry = pathGeometry({
      points: straightLine,
      closed: false,
      crossSection: "tube",
      width: 4,
      radius: 0.2,
      radialSegments: 8,
      segmentsPerSpan: 4,
    });
    expect(geometry.getAttribute("position").count).toBeGreaterThan(0);
    expect(geometry.getIndex()).not.toBeNull();
  });
});

const baseScatter: PathScatterData = {
  points: straightLine,
  closed: false,
  prop: { kind: "primitive", shape: "box", size: [1, 1, 1] },
  spacing: 5,
  offset: 0,
  alignToTangent: true,
  heightOffset: 0,
  sideOffset: 0,
  scaleJitter: 0,
  rotationJitter: 0,
  seed: 1,
  castShadow: true,
  receiveShadow: true,
};

describe("pathScatterPlacements", () => {
  it("places instances at even world-space spacing along a straight curve", () => {
    const placements = pathScatterPlacements(baseScatter);
    // 20-unit line, spacing 5 -> placements at 0, 5, 10, 15, 20 (5 total)
    expect(placements.length).toBe(5);
    expect(placements[0]!.position.x).toBeCloseTo(0, 3);
    expect(placements[1]!.position.x).toBeCloseTo(5, 3);
    expect(placements[4]!.position.x).toBeCloseTo(20, 3);
  });

  it("is deterministic for the same seed and varies with a different seed", () => {
    const jittered: PathScatterData = { ...baseScatter, rotationJitter: 1, scaleJitter: 1 };
    const a = pathScatterPlacements(jittered);
    const b = pathScatterPlacements(jittered);
    expect(a.map((p) => p.scale)).toEqual(b.map((p) => p.scale));
    const differentSeed = pathScatterPlacements({ ...jittered, seed: 2 });
    expect(differentSeed.map((p) => p.scale)).not.toEqual(a.map((p) => p.scale));
  });

  it("returns nothing for fewer than 2 points", () => {
    expect(pathScatterPlacements({ ...baseScatter, points: [[0, 0, 0]] })).toEqual([]);
  });

  it("offsets sideways with sideOffset, perpendicular to a straight +X curve", () => {
    const shifted = pathScatterPlacements({ ...baseScatter, sideOffset: 3 });
    expect(Math.abs(shifted[0]!.position.z)).toBeCloseTo(3, 3);
    expect(shifted[0]!.position.x).toBeCloseTo(0, 3);
  });
});

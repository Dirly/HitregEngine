import * as THREE from "three/webgpu";
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

  const ribbon = (extra: Partial<Parameters<typeof pathGeometry>[0]> = {}) =>
    pathGeometry({
      points: straightLine,
      closed: false,
      crossSection: "ribbon",
      width: 4,
      radius: 0.15,
      radialSegments: 6,
      segmentsPerSpan: 2,
      ...extra,
    });

  /** Geometric normal of every indexed triangle, from its winding. */
  const faceNormals = (geometry: THREE.BufferGeometry): THREE.Vector3[] => {
    const pos = geometry.getAttribute("position");
    const index = geometry.getIndex()!;
    const out: THREE.Vector3[] = [];
    const a = new THREE.Vector3();
    const b = new THREE.Vector3();
    const c = new THREE.Vector3();
    for (let i = 0; i < index.count; i += 3) {
      a.fromBufferAttribute(pos, index.getX(i));
      b.fromBufferAttribute(pos, index.getX(i + 1));
      c.fromBufferAttribute(pos, index.getX(i + 2));
      out.push(new THREE.Vector3().crossVectors(b.sub(a), c.sub(a)).normalize());
    }
    return out;
  };

  it("winds a flat ribbon so every face normal points UP (+Y), not down", () => {
    const geometry = ribbon();
    for (const n of faceNormals(geometry)) expect(n.y).toBeCloseTo(1, 5);
    const normal = geometry.getAttribute("normal");
    for (let i = 0; i < normal.count; i++) expect(normal.getY(i)).toBeCloseTo(1, 5);
  });

  it("doubleSided adds a reverse-wound copy of the faces and keeps +Y vertex normals", () => {
    const single = ribbon();
    const double = ribbon({ doubleSided: true });
    expect(double.getAttribute("position").count).toBe(single.getAttribute("position").count);
    expect(double.getIndex()!.count).toBe(single.getIndex()!.count * 2);
    const normals = faceNormals(double);
    expect(normals.filter((n) => n.y > 0.999).length).toBe(normals.length / 2);
    expect(normals.filter((n) => n.y < -0.999).length).toBe(normals.length / 2);
    const normal = double.getAttribute("normal");
    for (let i = 0; i < normal.count; i++) expect(normal.getY(i)).toBeCloseTo(1, 5);
  });

  it("thickness raises a closed slab: bottom on the curve, top `thickness` above, outward faces", () => {
    const geometry = ribbon({ thickness: 0.5 });
    const pos = geometry.getAttribute("position");
    let minY = Infinity;
    let maxY = -Infinity;
    for (let i = 0; i < pos.count; i++) {
      minY = Math.min(minY, pos.getY(i));
      maxY = Math.max(maxY, pos.getY(i));
    }
    expect(minY).toBeCloseTo(0, 5);
    expect(maxY).toBeCloseTo(0.5, 5);

    // every face normal must point away from the slab's centroid
    const index = geometry.getIndex()!;
    const centroid = new THREE.Vector3(10, 0.25, 0);
    const normals = faceNormals(geometry);
    const tri = new THREE.Vector3();
    normals.forEach((n, f) => {
      tri.set(0, 0, 0);
      for (let k = 0; k < 3; k++) {
        tri.add(new THREE.Vector3().fromBufferAttribute(pos, index.getX(f * 3 + k)));
      }
      tri.divideScalar(3).sub(centroid);
      expect(n.dot(tri)).toBeGreaterThan(0);
    });
    // top, bottom, 2 walls, 2 end caps
    const up = normals.filter((n) => n.y > 0.999).length;
    const down = normals.filter((n) => n.y < -0.999).length;
    expect(up).toBe(down);
    expect(normals.filter((n) => Math.abs(n.x) > 0.999).length).toBe(4); // caps
    expect(normals.filter((n) => Math.abs(n.z) > 0.999).length).toBe(up * 2); // walls
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

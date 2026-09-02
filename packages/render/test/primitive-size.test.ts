import { describe, it, expect } from "vitest";
import * as THREE from "three/webgpu";
import { geometryFor } from "../src/scene-builder.js";

/** Actual world extent of the built geometry, per axis. */
function extent(geometry: THREE.BufferGeometry): [number, number, number] {
  geometry.computeBoundingBox();
  const b = geometry.boundingBox!;
  return [b.max.x - b.min.x, b.max.y - b.min.y, b.max.z - b.min.z];
}

const near = (a: number, b: number, tol = 0.02) => Math.abs(a - b) <= tol;

describe("primitive size honours all three axes", () => {
  it("builds a sphere as the ellipsoid it was authored as", () => {
    // The regression: size[1]/size[2] were discarded, so this rendered as a
    // 1.7m BALL — three times too tall — with nothing logged. It is the real
    // shape behind a prefab's 0.55m dome.
    const [w, h, d] = extent(geometryFor("sphere", [1.7, 0.55, 1.5], [24, 12]));
    expect(near(w, 1.7)).toBe(true);
    expect(near(h, 0.55)).toBe(true);
    expect(near(d, 1.5)).toBe(true);
  });

  it("leaves a real sphere byte-for-byte alone", () => {
    const authored = geometryFor("sphere", [2, 2, 2], [16, 8]);
    const [w, h, d] = extent(authored);
    expect(near(w, 2)).toBe(true);
    expect(near(h, 2)).toBe(true);
    expect(near(d, 2)).toBe(true);
    // Equal axes must skip the scale matrix entirely: the result has to be
    // byte-identical to three's own geometry, not merely close to it. (Checking
    // "max radius === 1" instead would fail on three's OWN float error —
    // SphereGeometry(1) produces 1.0000000334679837 — and prove nothing.)
    const reference = new THREE.SphereGeometry(1, 16, 8);
    const mine = authored.getAttribute("position") as THREE.BufferAttribute;
    const theirs = reference.getAttribute("position") as THREE.BufferAttribute;
    expect(mine.count).toBe(theirs.count);
    for (let i = 0; i < mine.count; i++) {
      expect(mine.getX(i)).toBe(theirs.getX(i));
      expect(mine.getY(i)).toBe(theirs.getY(i));
      expect(mine.getZ(i)).toBe(theirs.getZ(i));
    }
  });

  it("gives a cylinder an oval cross-section when x !== z", () => {
    const [w, h, d] = extent(geometryFor("cylinder", [2, 5, 4], [24, 1]));
    expect(near(w, 2)).toBe(true);
    expect(near(h, 5)).toBe(true);
    expect(near(d, 4)).toBe(true);
  });

  it("keeps a round cylinder round", () => {
    const [w, h, d] = extent(geometryFor("cylinder", [3, 7, 3], [24, 1]));
    expect(near(w, 3)).toBe(true);
    expect(near(h, 7)).toBe(true);
    expect(near(d, 3)).toBe(true);
  });

  it("applies depth to cone and capsule without disturbing their height", () => {
    const [cw, ch, cd] = extent(geometryFor("cone", [2, 6, 3], [20, 1]));
    expect(near(cw, 2)).toBe(true);
    expect(near(ch, 6)).toBe(true);
    expect(near(cd, 3)).toBe(true);

    // a capsule's height is radius-coupled (length = y - x), so assert it stays
    // exactly what it was before this change rather than what x/z do
    const [pw, ph, pd] = extent(geometryFor("capsule", [1, 4, 2], [12, 6]));
    expect(near(pw, 1)).toBe(true);
    expect(near(ph, 4)).toBe(true);
    expect(near(pd, 2)).toBe(true);
  });

  it("normals survive the squash — a flattened dome is not lit as a ball", () => {
    const geometry = geometryFor("sphere", [4, 1, 4], [32, 16]);
    const normal = geometry.getAttribute("normal") as THREE.BufferAttribute;
    const position = geometry.getAttribute("position") as THREE.BufferAttribute;
    // At the top pole the surface is horizontal, so the normal must be +Y
    // whatever the squash. A ball's normals carried over unchanged would still
    // point +Y here, so also check a flank, where they must have tilted UP
    // toward vertical as the dome flattened.
    let topIndex = 0;
    for (let i = 1; i < position.count; i++) {
      if (position.getY(i) > position.getY(topIndex)) topIndex = i;
    }
    expect(near(normal.getY(topIndex), 1, 0.02)).toBe(true);

    let flank = -1;
    for (let i = 0; i < position.count; i++) {
      const r = Math.hypot(position.getX(i), position.getZ(i));
      if (r > 1.6 && r < 1.9 && position.getY(i) > 0.15) {
        flank = i;
        break;
      }
    }
    expect(flank).toBeGreaterThanOrEqual(0);
    // on the unsquashed ball this vertex's normal would be ~45 deg; flattening
    // 4:1 must drive it steeper
    expect(normal.getY(flank)).toBeGreaterThan(0.75);
    for (let i = 0; i < normal.count; i++) {
      const len = Math.hypot(normal.getX(i), normal.getY(i), normal.getZ(i));
      expect(near(len, 1, 1e-3)).toBe(true);
    }
  });

  it("ignores a zero or negative axis rather than collapsing the mesh", () => {
    const [w, h, d] = extent(geometryFor("sphere", [2, 0, 2], [16, 8]));
    expect(w).toBeGreaterThan(0);
    expect(h).toBeGreaterThan(0);
    expect(d).toBeGreaterThan(0);
  });

  it("box and plane are unaffected", () => {
    const [w, h, d] = extent(geometryFor("box", [3, 5, 7]));
    expect(near(w, 3)).toBe(true);
    expect(near(h, 5)).toBe(true);
    expect(near(d, 7)).toBe(true);
  });
});

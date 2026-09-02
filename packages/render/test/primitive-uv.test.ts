import { describe, it, expect } from "vitest";
import * as THREE from "three/webgpu";
import { geometryFor } from "../src/scene-builder.js";
import { applyWorldUv } from "../src/primitive-uv.js";

/** Largest and smallest uv extent across a geometry, per axis. */
function uvSpan(geometry: THREE.BufferGeometry): { u: number; v: number } {
  const uv = geometry.getAttribute("uv") as THREE.BufferAttribute;
  let minU = Infinity, maxU = -Infinity, minV = Infinity, maxV = -Infinity;
  for (let i = 0; i < uv.count; i++) {
    minU = Math.min(minU, uv.getX(i));
    maxU = Math.max(maxU, uv.getX(i));
    minV = Math.min(minV, uv.getY(i));
    maxV = Math.max(maxV, uv.getY(i));
  }
  return { u: maxU - minU, v: maxV - minV };
}

/**
 * Texture density on the widest face of a box: uv units per metre. The whole
 * point of world UVs is that this number does NOT change with the box's size.
 */
function densityOfLongestFace(width: number, scale: [number, number]): number {
  const geometry = geometryFor("box", [width, 3, 1], undefined, undefined, {
    mode: "world",
    scale,
  });
  const uv = geometry.getAttribute("uv") as THREE.BufferAttribute;
  const position = geometry.getAttribute("position") as THREE.BufferAttribute;
  const normal = geometry.getAttribute("normal") as THREE.BufferAttribute;
  // +Z face: its u axis runs along world X, so u-span / width is the density.
  let minU = Infinity, maxU = -Infinity, minX = Infinity, maxX = -Infinity;
  for (let i = 0; i < uv.count; i++) {
    if (normal.getZ(i) < 0.9) continue;
    minU = Math.min(minU, uv.getX(i));
    maxU = Math.max(maxU, uv.getX(i));
    minX = Math.min(minX, position.getX(i));
    maxX = Math.max(maxX, position.getX(i));
  }
  return (maxU - minU) / (maxX - minX);
}

describe("world-space primitive UVs", () => {
  it("leaves geometry untouched when the uv option is absent", () => {
    const stretched = geometryFor("box", [8, 3, 1]);
    // three's own mapping: one tile per face regardless of size.
    expect(uvSpan(stretched).u).toBeCloseTo(1, 6);
  });

  it("keeps texture density constant as a box is resized — the squish fix", () => {
    const short = densityOfLongestFace(2, [1, 1]);
    const long = densityOfLongestFace(40, [1, 1]);
    expect(long).toBeCloseTo(short, 6);
    // and it is the authored density: 1 tile per metre
    expect(long).toBeCloseTo(1, 6);
  });

  it("scale is metres per tile", () => {
    expect(densityOfLongestFace(10, [2, 2])).toBeCloseTo(0.5, 6);
    expect(densityOfLongestFace(10, [0.5, 0.5])).toBeCloseTo(2, 6);
  });

  it("gives a 20m x 4m wall 20 x 4 tiles at 1m scale", () => {
    const geometry = geometryFor("box", [20, 4, 1], undefined, undefined, {
      mode: "world",
      scale: [1, 1],
    });
    const span = uvSpan(geometry);
    expect(span.u).toBeCloseTo(20, 5);
    expect(span.v).toBeCloseTo(4, 5);
  });

  it("tiles two different-length walls at the same density, so they line up", () => {
    const a = densityOfLongestFace(7, [2, 2]);
    const b = densityOfLongestFace(13.5, [2, 2]);
    expect(a).toBeCloseTo(b, 6);
  });

  it("keeps the metre scale exact on a wedge's slope, not compressed by its tilt", () => {
    // A 45deg slope projected onto the floor plane would read 1/cos(45) too
    // tight; the tangent-basis projection must not do that.
    const geometry = geometryFor("wedge", [4, 4, 4], undefined, undefined, {
      mode: "world",
      scale: [1, 1],
    });
    const uv = geometry.getAttribute("uv") as THREE.BufferAttribute;
    const position = geometry.getAttribute("position") as THREE.BufferAttribute;
    const index = geometry.getIndex();
    const count = index ? index.count : position.count;
    let checked = 0;
    for (let t = 0; t < count; t += 3) {
      const ids = [0, 1, 2].map((k) => (index ? index.getX(t + k) : t + k));
      for (let e = 0; e < 3; e++) {
        const i = ids[e]!, j = ids[(e + 1) % 3]!;
        const world = new THREE.Vector3()
          .fromBufferAttribute(position, i)
          .sub(new THREE.Vector3().fromBufferAttribute(position, j))
          .length();
        const inUv = Math.hypot(uv.getX(i) - uv.getX(j), uv.getY(i) - uv.getY(j));
        if (world < 1e-4) continue;
        // every edge: one uv unit per metre, on every face including the slope
        expect(inUv / world).toBeCloseTo(1, 4);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(10);
  });

  it("scales a cylinder's side by its real circumference and height", () => {
    const geometry = geometryFor("cylinder", [4, 10, 4], [24, 1], undefined, {
      mode: "world",
      scale: [1, 1],
    });
    const uv = geometry.getAttribute("uv") as THREE.BufferAttribute;
    const normal = geometry.getAttribute("normal") as THREE.BufferAttribute;
    let maxU = -Infinity, minU = Infinity, spanV = 0;
    for (let i = 0; i < uv.count; i++) {
      // side vertices only — a cap's RIM shares the side's radius, so radius
      // cannot tell them apart; the normal can.
      if (Math.abs(normal.getY(i)) > 0.5) continue;
      maxU = Math.max(maxU, uv.getX(i));
      minU = Math.min(minU, uv.getX(i));
      spanV = Math.max(spanV, Math.abs(uv.getY(i)));
    }
    expect(maxU - minU).toBeCloseTo(Math.PI * 4, 4); // circumference in tiles
    expect(spanV).toBeCloseTo(10, 4); // height in tiles (v runs 0..1 -> 0..10)
  });

  it("does not double-scale a cylinder's shared cap vertices", () => {
    const geometry = geometryFor("cylinder", [4, 10, 4], [8, 1], undefined, {
      mode: "world",
      scale: [1, 1],
    });
    const uv = geometry.getAttribute("uv") as THREE.BufferAttribute;
    const normal = geometry.getAttribute("normal") as THREE.BufferAttribute;
    for (let i = 0; i < uv.count; i++) {
      if (Math.abs(normal.getY(i)) < 0.5) continue; // keep cap vertices only
      // a 4m disc at 1m/tile spans 4 uv units, i.e. +-2 about the 0.5 centre
      expect(Math.abs(uv.getX(i) - 0.5)).toBeLessThanOrEqual(2.001);
      expect(Math.abs(uv.getY(i) - 0.5)).toBeLessThanOrEqual(2.001);
    }
  });

  it("survives the flat-shading split (uvs are generated before un-indexing)", () => {
    const flat = geometryFor("box", [20, 4, 1], undefined, "flat", {
      mode: "world",
      scale: [1, 1],
    });
    expect(flat.getIndex()).toBeNull();
    expect(uvSpan(flat).u).toBeCloseTo(20, 5);
  });

  it("is a no-op for a geometry with no uv attribute", () => {
    const bare = new THREE.BufferGeometry();
    expect(() => applyWorldUv(bare, "box", [1, 1, 1], [1, 1])).not.toThrow();
  });

  it("gives every shape finite uvs", () => {
    for (const shape of ["box", "sphere", "plane", "cylinder", "capsule", "cone", "torus", "wedge"]) {
      const geometry = geometryFor(shape, [3, 5, 2], undefined, undefined, {
        mode: "world",
        scale: [1.5, 1.5],
      });
      const uv = geometry.getAttribute("uv") as THREE.BufferAttribute | undefined;
      if (!uv) continue;
      for (let i = 0; i < uv.count; i++) {
        expect(Number.isFinite(uv.getX(i)), `${shape} u[${i}]`).toBe(true);
        expect(Number.isFinite(uv.getY(i)), `${shape} v[${i}]`).toBe(true);
      }
    }
  });
});

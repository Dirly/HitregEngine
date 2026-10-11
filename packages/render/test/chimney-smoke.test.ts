import * as THREE from "three/webgpu";
import { describe, expect, it } from "vitest";
import { findChimneys } from "../src/chimney-smoke.js";

function box(w: number, h: number, d: number, x: number, y: number, z: number): THREE.Mesh {
  const g = new THREE.BoxGeometry(w, h, d);
  g.translate(x, y + h / 2, z);
  return new THREE.Mesh(g, new THREE.MeshBasicMaterial());
}

describe("findChimneys", () => {
  it("finds a stack standing out of a roof, not battlements, posts under a roof or the roof itself", () => {
    const house = new THREE.Group();
    house.add(box(10, 5, 10, 0, 0, 0)); // walls + flat roof at y = 5
    house.add(box(0.7, 1.6, 0.7, 3, 5, 3)); // the chimney, top at 6.6
    for (let i = 0; i < 4; i++) house.add(box(0.5, 0.6, 0.5, -4 + i * 1.2, 5, -4.6)); // a row of merlons
    house.add(box(0.4, 1, 0.4, -3, 5, 2)); // a post…
    house.add(box(2, 0.1, 2, -3, 6.2, 2)); // …under a canopy
    const tops = findChimneys(house);
    expect(tops).toHaveLength(1);
    expect(tops[0]!.x).toBeCloseTo(3);
    expect(tops[0]!.y).toBeCloseTo(6.6);
    expect(tops[0]!.z).toBeCloseTo(3);
  });
});

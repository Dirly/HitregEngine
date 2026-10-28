import * as THREE from "three/webgpu";
import { describe, expect, it } from "vitest";
import { findChimneys } from "../src/chimney-smoke.js";

function box(w: number, h: number, d: number, x: number, y: number, z: number): THREE.Mesh {
  const g = new THREE.BoxGeometry(w, h, d);
  g.translate(x, y + h / 2, z);
  return new THREE.Mesh(g, new THREE.MeshBasicMaterial());
}

describe("findChimneys", () => {
  it("finds a stack standing out of a roof, not battlements, posts under a roof, a keystone on a wall or the roof itself", () => {
    const house = new THREE.Group();
    house.add(box(10, 8, 10, 0, 0, 0)); // walls (two storeys) + flat roof at y = 8
    house.add(box(0.7, 1.6, 0.7, 3, 8, 3)); // the chimney, top at 9.6
    for (let i = 0; i < 4; i++) house.add(box(0.5, 0.6, 0.5, -4 + i * 1.2, 8, -4.6)); // a row of merlons
    house.add(box(0.4, 1, 0.4, -3, 8, 2)); // a post…
    house.add(box(2, 0.1, 2, -3, 9.2, 2)); // …under a canopy
    // a grand door's keystone: a squarish block proud of the front wall (z = 5) at 6.2 m, the sky above it and the
    // street dropping away in front, the wall rising behind it — the bank's false stack of 2026-10-28 (one side
    // dropping away was enough then)
    house.add(box(0.5, 0.5, 0.4, 0, 5.7, 5.2));
    const tops = findChimneys(house);
    expect(tops).toHaveLength(1);
    expect(tops[0]!.x).toBeCloseTo(3);
    expect(tops[0]!.y).toBeCloseTo(9.6);
    expect(tops[0]!.z).toBeCloseTo(3);
  });
});

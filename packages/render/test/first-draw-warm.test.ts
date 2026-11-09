import { describe, expect, it } from "vitest";
import * as THREE from "three/webgpu";
import { FIRST_DRAW_TRICKLE_FRAMES, FIRST_DRAWS_PER_FRAME, FirstDrawWarm } from "../src/first-draw-warm.js";

describe("FirstDrawWarm", () => {
  const meshes = (n: number): { scene: THREE.Group; list: THREE.Mesh[] } => {
    const scene = new THREE.Group();
    const list = Array.from({ length: n }, () => new THREE.Mesh());
    scene.add(...list);
    return { scene, list };
  };
  const lent = (list: THREE.Mesh[]): number => list.filter((m) => !m.frustumCulled).length;

  it("lends a batch a frame behind the cover, each mesh once, and returns them", () => {
    const { scene, list } = meshes(FIRST_DRAWS_PER_FRAME + 1);
    const warm = new FirstDrawWarm();
    warm.step(scene, true);
    expect(lent(list)).toBe(FIRST_DRAWS_PER_FRAME);
    warm.step(scene, true);
    expect(lent(list)).toBe(1);
    warm.step(scene, true);
    expect(lent(list)).toBe(0);
    expect(warm.busy).toBe(false);
  });

  it("lends one mesh every few frames once play is showing", () => {
    const { scene, list } = meshes(3);
    const warm = new FirstDrawWarm();
    for (let f = 0; f < FIRST_DRAW_TRICKLE_FRAMES * 2; f++) {
      warm.step(scene, false);
      expect(lent(list)).toBeLessThanOrEqual(1);
    }
    expect(warm.stats.meshes).toBe(2);
    warm.returnLent();
    expect(lent(list)).toBe(0);
  });

  it("leaves hidden branches and meshes that never cull alone", () => {
    const { scene, list } = meshes(2);
    list[0]!.visible = false;
    list[1]!.frustumCulled = false;
    const warm = new FirstDrawWarm();
    warm.step(scene, true);
    warm.returnLent();
    expect(list[0]!.frustumCulled).toBe(true);
    expect(list[1]!.frustumCulled).toBe(false);
  });
});

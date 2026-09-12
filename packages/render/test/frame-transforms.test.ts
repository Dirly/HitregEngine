import { describe, expect, it, vi } from "vitest";
import * as THREE from "three/webgpu";
import { EngineRenderer } from "../src/renderer.js";

// Exercise the host render boundary without a GPU. The fake backend follows
// Three's actual policy for the main pass and nested shadow passes.
function rendererWith(draw: (scene: THREE.Scene, camera: THREE.Camera) => void): EngineRenderer {
  const renderer = Object.create(EngineRenderer.prototype) as EngineRenderer;
  Object.assign(renderer, { renderer: { render: draw }, plan: [], volumetric: null });
  return renderer;
}

describe("frame transform reuse", () => {
  it("shares one current pose across passes, and updates moving bones on the next frame", () => {
    const scene = new THREE.Scene();
    const root = new THREE.Group();
    const bone = new THREE.Bone();
    scene.add(root);
    root.add(bone);
    const update = vi.spyOn(bone, "updateMatrixWorld");
    const positions: number[] = [];
    const renderer = rendererWith((s) => {
      for (let pass = 0; pass < 4; pass++) {
        if (s.matrixWorldAutoUpdate) s.updateMatrixWorld();
        positions.push(bone.matrixWorld.elements[12]!);
      }
    });
    root.position.x = 10;
    bone.position.x = 2;
    renderer.render(scene, new THREE.PerspectiveCamera());
    expect(positions).toEqual([12, 12, 12, 12]);
    expect(update).toHaveBeenCalledTimes(1);
    expect(scene.matrixWorldAutoUpdate).toBe(true);
    bone.position.x = 3;
    renderer.render(scene, new THREE.PerspectiveCamera());
    expect(positions.slice(4)).toEqual([13, 13, 13, 13]);
    expect(update).toHaveBeenCalledTimes(2);
  });

  it("respects manually updated scenes", () => {
    const scene = new THREE.Scene();
    scene.matrixWorldAutoUpdate = false;
    const update = vi.spyOn(scene, "updateMatrixWorld");
    rendererWith(() => {}).render(scene, new THREE.PerspectiveCamera());
    expect(update).not.toHaveBeenCalled();
    expect(scene.matrixWorldAutoUpdate).toBe(false);
  });

  it("restores the update policy when a render fails", () => {
    const scene = new THREE.Scene();
    const renderer = rendererWith(() => { throw new Error("draw failed"); });
    expect(() => renderer.render(scene, new THREE.PerspectiveCamera())).toThrow("draw failed");
    expect(scene.matrixWorldAutoUpdate).toBe(true);
  });
});

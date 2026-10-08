import { describe, expect, it } from "vitest";
import * as THREE from "three/webgpu";
import { trackRenderObjects } from "../src/render-object-sweep.js";

/**
 * Like three: one render object per (object, scene's lights) — a rebuilt scene
 * brings new lights, so an object that MOVES into it gets a new render object,
 * and the old one keeps a reference to the scene it was made for.
 */
function fakeRenderer() {
  const disposed: Array<{ object: THREE.Object3D; scene: THREE.Object3D }> = [];
  const cache = new Map<string, unknown>();
  const renderer = {
    _objects: {
      createRenderObject(object: THREE.Object3D, scene: THREE.Object3D) {
        const key = `${object.uuid}|${scene.uuid}`;
        const renderObject = {
          object,
          scene,
          onDispose: () => {
            disposed.push({ object, scene });
            cache.delete(key);
          },
          dispose() {
            this.onDispose();
          },
        };
        cache.set(key, renderObject);
        return renderObject;
      },
    },
    render(scene: THREE.Object3D, _camera: THREE.Camera) {
      scene.traverse((o) => {
        if ((o as THREE.Mesh).isMesh && !cache.has(`${o.uuid}|${scene.uuid}`)) {
          (renderer._objects.createRenderObject as (o: THREE.Object3D, s: THREE.Object3D) => unknown)(o, scene);
        }
      });
    },
  };
  return { renderer: renderer as unknown as THREE.WebGPURenderer, disposed };
}

describe("render object sweep across a scene rebuild", () => {
  it("releases the old scene's render objects of content that moved into the new scene", () => {
    const camera = new THREE.PerspectiveCamera();
    const { renderer, disposed } = fakeRenderer();
    const sweep = trackRenderObjects(renderer)!;
    const oldScene = new THREE.Scene();
    const chunk = new THREE.Mesh();
    oldScene.add(chunk);
    renderer.render(oldScene, camera);
    expect(sweep.sweep()).toBe(0);

    // rebuild: a new scene, the streamed chunk moves across and keeps drawing
    const newScene = new THREE.Scene();
    newScene.add(chunk);
    renderer.render(newScene, camera);
    expect(sweep.sweep()).toBe(0); // the old one is only marked
    renderer.render(newScene, camera);
    expect(sweep.sweep()).toBe(1);
    expect(disposed).toEqual([{ object: chunk, scene: oldScene }]);
    expect(sweep.stats.live).toBe(1); // the new scene's render object stays
  });
});

import { describe, expect, it } from "vitest";
import * as THREE from "three/webgpu";
import { trackRenderObjects } from "../src/render-object-sweep.js";

/** The slice of WebGPURenderer the sweep hooks, with three's own onDispose shape. */
function fakeRenderer() {
  const disposed: THREE.Object3D[] = [];
  // three's chain map: one render object per object until it is disposed
  const cache = new Map<THREE.Object3D, unknown>();
  const renderer = {
    _objects: {
      createRenderObject(object: THREE.Object3D) {
        const renderObject = {
          object,
          onDispose: () => {
            disposed.push(object);
            cache.delete(object);
          },
          dispose() {
            this.onDispose();
          },
        };
        return renderObject;
      },
    },
    render(scene: THREE.Object3D, _camera: THREE.Camera) {
      scene.traverse((o) => {
        if ((o as THREE.Mesh).isMesh && !cache.has(o)) {
          cache.set(o, (renderer._objects.createRenderObject as (o: THREE.Object3D) => unknown)(o));
        }
      });
    },
  };
  return { renderer: renderer as unknown as THREE.WebGPURenderer, disposed };
}

describe("render object sweep", () => {
  const camera = new THREE.PerspectiveCamera();

  it("frees an unloaded group's render objects after the grace sweep, never a drawn one", () => {
    const { renderer, disposed } = fakeRenderer();
    const sweep = trackRenderObjects(renderer)!;
    const scene = new THREE.Scene();
    const chunk = new THREE.Group();
    const inChunk = new THREE.Mesh();
    chunk.add(inChunk);
    const culled = new THREE.Mesh();
    scene.add(chunk, culled);
    renderer.render(scene, camera);
    expect(sweep.sweep()).toBe(0);

    chunk.removeFromParent(); // unloaded; the scene keeps drawing
    renderer.render(new THREE.Scene(), camera); // unrelated draws don't keep it
    (renderer as unknown as { render: (s: THREE.Object3D, c: THREE.Camera) => void }).render(scene, camera);
    expect(sweep.sweep()).toBe(0); // marked, not freed
    renderer.render(scene, camera);
    expect(sweep.sweep()).toBe(1);
    expect(disposed).toEqual([inChunk]);
    expect(sweep.stats.live).toBe(1); // `culled` stays: its root is still drawn
  });

  it("keeps a group that is re-attached within the grace window", () => {
    const { renderer, disposed } = fakeRenderer();
    const sweep = trackRenderObjects(renderer)!;
    const scene = new THREE.Scene();
    const prop = new THREE.Mesh();
    scene.add(prop);
    renderer.render(scene, camera);
    prop.removeFromParent();
    renderer.render(scene, camera);
    sweep.sweep(); // marked
    scene.add(prop); // pool handed it back out
    renderer.render(scene, camera);
    sweep.sweep();
    renderer.render(scene, camera);
    sweep.sweep();
    expect(disposed).toEqual([]);
  });

  it("stands down when three's private surface is missing", () => {
    expect(trackRenderObjects({ render() {} } as unknown as THREE.WebGPURenderer)).toBeNull();
  });
});

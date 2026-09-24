/**
 * Free three's per-draw state for objects that have left every drawn scene.
 *
 * WebGPURenderer keeps one `RenderObject` per (object, material, context,
 * lights) it has drawn, holding the object's bind groups — including an
 * object-scope uniform buffer on the GPU. It is released on exactly one
 * event: the MATERIAL's `dispose` (RenderObject listens on it). Removing the
 * object, or disposing its geometry, frees nothing. And this engine never
 * disposes materials: scene-builder caches them by asset id and shares them
 * across every chunk that ever builds the same content (see
 * ChunkManager.disposeGroup). So every streamed chunk, HLOD proxy and editor
 * rebuild that ever drew stayed alive — the material's listener array held
 * the render object, which held the mesh, whose `parent` held the whole
 * unloaded group. Measured on the MMO scene: +1,050 Object3Ds, +300
 * geometries and +280 GPU uniform buffers per out-and-back camera sweep,
 * retained forever, until a long editor session froze.
 *
 * The sweep is the missing release. Every render object three creates is
 * recorded; every `SWEEP_FRAMES` frames, one whose object's ROOT (walk
 * `.parent` to the top) was not passed to `renderer.render()` since the
 * previous sweep is marked, and one still marked at the next sweep is
 * disposed — the same `dispose()` three runs for a disposed material. Two
 * sweeps of grace so a prop the pool parks for a moment, or a group
 * re-parented into a rebuilt scene, keeps its state. A culled object inside a
 * drawn scene is never touched: its root is the scene.
 *
 * Disposing one render object is safe with a shared material: shared bind
 * groups, node-builder states and pipelines are reference-counted in three
 * and only freed with their last user.
 */
import type * as THREE from "three/webgpu";

/** Frames between sweeps; an orphan is freed after 1–2 of these. */
export const SWEEP_FRAMES = 120;

interface SweptRenderObject {
  object: THREE.Object3D;
  onDispose: () => void;
  dispose(): void;
}

interface SweepInternals {
  _objects?: { createRenderObject?: (...args: unknown[]) => SweptRenderObject };
  render: (scene: THREE.Object3D, camera: THREE.Camera) => unknown;
}

export interface RenderObjectSweep {
  /** Call once per frame; runs a sweep every SWEEP_FRAMES calls. */
  tick(): void;
  /** Run a sweep now (tests, probes). Returns how many render objects it freed. */
  sweep(): number;
  stats: { live: number; freed: number };
}

function rootOf(object: THREE.Object3D): THREE.Object3D {
  let root = object;
  while (root.parent) root = root.parent;
  return root;
}

/**
 * Start tracking `renderer`'s render objects. Returns null when three's
 * private surface is not what this expects (a future three rename) — the
 * renderer then works exactly as before, leak included.
 */
export function trackRenderObjects(renderer: THREE.WebGPURenderer): RenderObjectSweep | null {
  const internals = renderer as unknown as SweepInternals;
  const objects = internals._objects;
  const create = objects?.createRenderObject;
  if (!objects || typeof create !== "function") return null;

  const live = new Set<SweptRenderObject>();
  const marked = new Set<SweptRenderObject>();
  // roots drawn since the last sweep: a strong set, cleared every sweep, so a
  // one-off scene is let go within one interval
  let drawn = new Set<THREE.Object3D>();
  const stats = { live: 0, freed: 0 };

  objects.createRenderObject = function (this: unknown, ...args: unknown[]) {
    const renderObject = create.apply(this, args);
    live.add(renderObject);
    const onDispose = renderObject.onDispose;
    renderObject.onDispose = () => {
      live.delete(renderObject);
      marked.delete(renderObject);
      onDispose.call(renderObject);
    };
    return renderObject;
  };

  // every draw — main pass, shadow cascades, post quads, bakes — goes
  // through the instance's render(), so this sees every root in use
  const render = internals.render;
  internals.render = function (this: unknown, scene: THREE.Object3D, camera: THREE.Camera) {
    drawn.add(scene);
    return render.call(this, scene, camera);
  };

  let frames = 0;
  const sweep = (): number => {
    let freed = 0;
    for (const renderObject of [...live]) {
      if (drawn.has(rootOf(renderObject.object))) {
        marked.delete(renderObject);
      } else if (marked.has(renderObject)) {
        renderObject.dispose(); // onDispose above drops it from both sets
        freed += 1;
      } else {
        marked.add(renderObject);
      }
    }
    drawn = new Set();
    stats.live = live.size;
    stats.freed += freed;
    return freed;
  };

  return {
    tick() {
      if (++frames % SWEEP_FRAMES === 0) sweep();
    },
    sweep,
    stats,
  };
}

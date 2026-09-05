import * as THREE from "three/webgpu";

/**
 * Stop the renderer from recomputing world matrices for content that never
 * moves.
 *
 * `WebGPURenderer.render()` calls `scene.updateMatrixWorld()` once per frame,
 * which recurses the WHOLE graph and, for every object with
 * `matrixAutoUpdate`, recomposes its local matrix from position/quaternion/
 * scale and multiplies it by its parent's — whether or not anything changed.
 * In a chunk-streamed world almost every object in the graph is streamed
 * terrain, a scattered tree or a merged HLOD proxy: none of it has moved since
 * the frame it was built, and all of it was paying that cost. Profiling the
 * voxel demo put `updateMatrixWorld` at 12.7% of all main-thread self time —
 * the single largest entry, ahead of every part of the actual draw.
 *
 * The lever is `matrixWorldAutoUpdate` on the SUBTREE ROOT, not
 * `matrixAutoUpdate` on each descendant. Three's traversal skips a child whose
 * `matrixWorldAutoUpdate` is false (unless an ancestor forced the update), so
 * clearing it on one group prunes that entire branch from the walk in O(1)
 * rather than leaving a per-node test in it.
 *
 * THE CONTRACT THIS CREATES: a frozen subtree's world matrices are correct as
 * of the moment it was frozen and are never recomputed again. So any later
 * change to the subtree — moving the root, adding a part to an HLOD supercell,
 * a script nudging a prop inside a streamed cell — must be followed by
 * `refreshStaticSubtree()`, or the change renders in the wrong place (or, for
 * a newly added child, at the origin). When in doubt, thaw: an unfrozen
 * subtree is merely slower, a stale frozen one is a visible bug.
 */
export function freezeStaticSubtree(root: THREE.Object3D): void {
  // compute once, with force, so every descendant is correct before the
  // renderer stops visiting them
  root.matrixWorldAutoUpdate = false;
  recomputeFrozen(root);
  // three r185 dropped the child-level `matrixWorldAutoUpdate` test from
  // `updateMatrixWorld` — the walk now recurses into EVERY child regardless
  // (and recomposes every `matrixAutoUpdate` local matrix on the way). So the
  // flag above only stops the root's own matrix from being rewritten; the
  // subtree was still being visited every frame. Measured on the voxel demo
  // at 2,345 objects: 2,352 `updateMatrixWorld` calls per frame, 14% of all
  // main-thread self time, with 194 frozen roots that pruned nothing. An own
  // `updateMatrixWorld` on the root short-circuits the per-frame walk.
  //
  // It cannot simply honour `force`: every object with `matrixAutoUpdate`
  // (the default — the Scene included) calls `updateMatrix()` on the way
  // down, which sets its own `matrixWorldNeedsUpdate`, which turns `force`
  // on for all of its children. So the renderer's walk arrives at every
  // frozen root with `force === true` on every frame. What actually matters
  // is whether the PARENT moved, and that is answerable directly: keep the
  // parent's world matrix as of the last recompute and compare.
  Object.defineProperty(root, "updateMatrixWorld", {
    value: frozenUpdateMatrixWorld,
    configurable: true,
    writable: true,
    enumerable: false,
  });
}

/** Parent world matrix each frozen root was last laid out under. */
const frozenUnder = new WeakMap<THREE.Object3D, THREE.Matrix4>();
const IDENTITY = new THREE.Matrix4();

function rememberParent(root: THREE.Object3D): void {
  const under = frozenUnder.get(root) ?? new THREE.Matrix4();
  under.copy(root.parent ? root.parent.matrixWorld : IDENTITY);
  frozenUnder.set(root, under);
}

function frozenUpdateMatrixWorld(this: THREE.Object3D): void {
  const under = frozenUnder.get(this);
  const parentWorld = this.parent ? this.parent.matrixWorld : IDENTITY;
  if (under && under.equals(parentWorld)) return; // nothing above moved, nothing below can have
  recomputeFrozen(this);
}

/**
 * The forced walk over a frozen root, root included: the prototype skips a
 * root whose `matrixWorldAutoUpdate` is off, so that flag is lifted for the
 * duration — it is the marker that the subtree is frozen, not a request to
 * leave the root itself stale.
 */
function recomputeFrozen(root: THREE.Object3D): void {
  const marker = root.matrixWorldAutoUpdate;
  root.matrixWorldAutoUpdate = true;
  THREE.Object3D.prototype.updateMatrixWorld.call(root, true);
  root.matrixWorldAutoUpdate = marker;
  rememberParent(root);
}

/** Whether `freezeStaticSubtree` has pruned this root from the per-frame walk. */
export function isFrozenStaticSubtree(root: THREE.Object3D): boolean {
  return Object.prototype.hasOwnProperty.call(root, "updateMatrixWorld");
}

/**
 * Recompute a frozen subtree's world matrices after it changed, keeping it
 * frozen. Call after re-positioning the root or adding/removing children.
 */
export function refreshStaticSubtree(root: THREE.Object3D): void {
  // the prototype's walk, not the frozen root's own: the parent may not have
  // moved at all — it is the subtree that changed — so the short-circuit
  // must not get a say
  recomputeFrozen(root);
}

/**
 * Return a subtree to per-frame updates, for content that has become dynamic
 * (a streamed cell crossing into the simulated ring and gaining physics and
 * scripts that can move its entities).
 */
export function thawStaticSubtree(root: THREE.Object3D): void {
  // back to the prototype's walk, so the renderer visits the subtree again
  delete (root as unknown as { updateMatrixWorld?: unknown }).updateMatrixWorld;
  root.matrixWorldAutoUpdate = true;
  root.updateMatrixWorld(true);
}

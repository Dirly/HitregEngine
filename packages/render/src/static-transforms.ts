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
  root.updateMatrixWorld(true);
  root.matrixWorldAutoUpdate = false;
}

/**
 * Recompute a frozen subtree's world matrices after it changed, keeping it
 * frozen. Call after re-positioning the root or adding/removing children.
 */
export function refreshStaticSubtree(root: THREE.Object3D): void {
  // a direct call forces the walk regardless of `matrixWorldAutoUpdate`, which
  // is exactly why freezing does not make a subtree unupdatable
  root.updateMatrixWorld(true);
}

/**
 * Return a subtree to per-frame updates, for content that has become dynamic
 * (a streamed cell crossing into the simulated ring and gaining physics and
 * scripts that can move its entities).
 */
export function thawStaticSubtree(root: THREE.Object3D): void {
  root.matrixWorldAutoUpdate = true;
  root.updateMatrixWorld(true);
}

import * as THREE from "three/webgpu";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { freezeStaticSubtree } from "./static-transforms.js";
import { ATLAS_RECT_ATTRIBUTE } from "./town-atlas.js";

/**
 * Static draw-call batching.
 *
 * A scene built from modular pieces — a dungeon of walls, floors, columns and
 * sconces, most of them prefab instances — issues one draw call per piece. A
 * 252-entity dungeon measured **908 draw calls for 109k triangles**: ~120
 * triangles per call, which is CPU-bound on binding, not on geometry. The frame
 * cost is the *count*, not the content, so the fix is to stop asking the GPU 908
 * times and start asking it once per material.
 *
 * What makes this safe to do in an EDITOR, rather than only in a shipped build,
 * is that the merge keeps a face→entity table. Merged geometry has no per-entity
 * object left to hit-test, so without that table clicking a wall would select
 * nothing and the editor would appear broken. `ownerOfFace()` maps a raycast
 * `faceIndex` back to the entity id that contributed those triangles, which is
 * what lets selection keep working through a batch.
 *
 * Batching is deliberately NOT permanent: `dispose()` restores every source
 * mesh. The host re-batches after each rebuild/reconcile, so an edited entity is
 * always drawn from its own live mesh on the next pass rather than from a stale
 * copy baked into a merge.
 */

/** Marks a mesh as eligible. Set by the scene builder from `mesh.static`. */
export const STATIC_BATCH_FLAG = "staticBatch";
/** Present on a merged mesh; carries the face→entity table. */
export const BATCH_OWNERS = "batchOwners";

/** Called after a non-animated model is assembled and attached to its entity.
 * Freeze the MODEL, not the entity: moving its parent still updates its bounds
 * and matrices, while fixed exported node hierarchies cost one check per frame.
 */
export function prepareStaticModel(root: THREE.Object3D): void {
  let deforming = false;
  root.traverse((node) => {
    const mesh = node as THREE.Mesh;
    if ((node as THREE.SkinnedMesh).isSkinnedMesh ||
        (mesh.isMesh && Object.keys(mesh.geometry.morphAttributes).length > 0)) deforming = true;
  });
  if (deforming) return;
  root.traverse((node) => {
    if ((node as THREE.Mesh).isMesh) node.userData[STATIC_BATCH_FLAG] = true;
  });
  root.updateWorldMatrix(true, true);
  freezeStaticSubtree(root);
}

export interface BatchOwners {
  /** Triangle index at which each source's faces begin, ascending. */
  starts: Uint32Array;
  /** Entity id per source, parallel to `starts`. */
  ids: string[];
}

export interface StaticBatchStats {
  /** Merged meshes produced (one per material bucket). */
  batches: number;
  /** Source meshes folded into them. */
  merged: number;
  /** Draw calls removed: merged - batches. */
  drawCallsSaved: number;
  /** Eligible-looking meshes that could not be merged, with why. */
  skipped: number;
}

export interface StaticBatchHandle {
  group: THREE.Group;
  stats: StaticBatchStats;
  /**
   * With `groupOf`: the merged meshes of each group, under their own child
   * of `group` — what a culling unit hides alongside its entity subtree.
   */
  groups: Map<string, THREE.Group>;
  /** Restore every source mesh and drop the merged copies. */
  dispose(): void;
}

interface Candidate {
  mesh: THREE.Mesh;
  entityId: string;
  material: THREE.Material;
}

/**
 * Resolve which entity contributed a hit face on a merged mesh. Returns null
 * for a mesh that is not a batch. Callers pass `intersection.faceIndex`.
 */
export function ownerOfFace(object: THREE.Object3D, faceIndex: number | undefined): string | null {
  const owners = object.userData[BATCH_OWNERS] as BatchOwners | undefined;
  if (!owners || faceIndex === undefined) return null;
  const { starts, ids } = owners;
  // Upper-bound binary search: the last source whose start is <= faceIndex.
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid]! <= faceIndex) lo = mid;
    else hi = mid - 1;
  }
  return ids[lo] ?? null;
}

/**
 * Normalize a geometry so a bucket of them can merge: non-indexed, carrying
 * exactly position/normal/uv. `mergeGeometries` rejects mismatched attribute
 * sets, and a uv-less primitive sitting next to a uv-bearing one is the common
 * case that trips it.
 */
/**
 * Vertex streams a merge carries through. Beyond position/normal/uv only the
 * town atlas tile rect: it is per-vertex data a world-space merge does not
 * change, and dropping it would sample the whole page.
 */
const MERGED_ATTRIBUTES = new Set(["position", "normal", "uv", ATLAS_RECT_ATTRIBUTE]);

function prepForMerge(geometry: THREE.BufferGeometry): THREE.BufferGeometry {
  const g = (geometry.index ? geometry.toNonIndexed() : geometry.clone()) as THREE.BufferGeometry;
  if (!g.getAttribute("normal")) g.computeVertexNormals();
  if (!g.getAttribute("uv")) {
    const count = g.getAttribute("position").count;
    g.setAttribute("uv", new THREE.BufferAttribute(new Float32Array(count * 2), 2));
  }
  for (const name of Object.keys(g.attributes)) {
    if (!MERGED_ATTRIBUTES.has(name)) g.deleteAttribute(name);
  }
  return g;
}

/** Does this geometry carry vertex data a merge would have to throw away? */
function hasCustomAttributes(geometry: THREE.BufferGeometry): boolean {
  for (const name of Object.keys(geometry.attributes)) {
    if (!MERGED_ATTRIBUTES.has(name)) return true;
  }
  return false;
}

/**
 * A bucket key. Anything that changes how the GPU is set up has to be part of
 * it, or merging would silently change appearance: two meshes sharing a
 * material but differing in shadow flags are NOT interchangeable.
 */
function bucketKey(mesh: THREE.Mesh, material: THREE.Material): string {
  return [
    material.uuid,
    mesh.castShadow ? 1 : 0,
    mesh.receiveShadow ? 1 : 0,
    mesh.renderOrder,
    mesh.layers.mask,
  ].join("|");
}

export function batchStaticMeshes(
  root: THREE.Object3D,
  options: {
    minBatch?: number;
    /**
     * Keep meshes of different groups (culling units — a POI inside a cell)
     * out of each other's merges, so each can be hidden on its own. Undefined
     * = the ungrouped rest.
     */
    groupOf?: (mesh: THREE.Mesh) => string | undefined;
    /**
     * May this structural ancestor (an entity group above merged models) be
     * hidden when everything under it is drawn by the batch? The host answers
     * yes only for content nothing will add to or move — a static entity
     * subtree. Unset = only complete model hierarchies are hidden.
     */
    prunable?: (node: THREE.Object3D) => boolean;
  } = {},
): StaticBatchHandle | null {
  const minBatch = options.minBatch ?? 2;
  const buckets = new Map<string, Candidate[]>();
  const bucketGroup = new Map<string, string>();
  let skipped = 0;

  root.updateMatrixWorld(true);
  root.traverseVisible((node) => {
    if (!(node as THREE.Mesh).isMesh) return;
    const mesh = node as THREE.Mesh;
    if (!mesh.userData[STATIC_BATCH_FLAG]) return;
    // A batch is one geometry with one material; a multi-material mesh would
    // need draw groups, which defeats the point.
    if (Array.isArray(mesh.material)) return void skipped++;
    // Skinned and instanced meshes carry per-vertex or per-instance state that
    // a world-space merge would flatten away.
    if ((mesh as unknown as { isSkinnedMesh?: boolean }).isSkinnedMesh) return void skipped++;
    if ((mesh as unknown as { isInstancedMesh?: boolean }).isInstancedMesh) return void skipped++;
    if ((mesh as unknown as { isInstancedProps?: boolean }).isInstancedProps) return void skipped++;
    if (!mesh.geometry?.getAttribute("position")) return void skipped++;
    // A geometry carrying attributes beyond position/normal/uv is carrying
    // them for a reason — voxel terrain's per-vertex splat weights and biome
    // tint are what its material reads to decide whether a fragment is grass
    // or snow. `prepForMerge` has to strip extras (mergeGeometries rejects
    // mismatched sets), so batching such a mesh would silently delete the data
    // its shader depends on and render it as a single flat layer. Skip it: the
    // draw call saved is never worth losing what the mesh looks like.
    if (hasCustomAttributes(mesh.geometry)) return void skipped++;
    // World-baking changes the local coordinates read by wind/displacement.
    const material = mesh.material as THREE.Material & { positionNode?: unknown; displacementMap?: unknown };
    if (material.positionNode || material.displacementMap ||
        Object.keys(mesh.geometry.morphAttributes).length > 0) return void skipped++;
    const entityId = mesh.userData["entityId"] as string | undefined;
    if (!entityId) return void skipped++;
    const unit = options.groupOf?.(mesh);
    const key = unit === undefined ? bucketKey(mesh, mesh.material) : `${bucketKey(mesh, mesh.material)}|${unit}`;
    const list = buckets.get(key);
    if (list) list.push({ mesh, entityId, material: mesh.material });
    else {
      buckets.set(key, [{ mesh, entityId, material: mesh.material }]);
      if (unit !== undefined) bucketGroup.set(key, unit);
    }
  });

  const group = new THREE.Group();
  group.name = "static-batch";
  group.userData["editorOverlay"] = false;
  const hidden = new Map<THREE.Mesh, boolean>();
  const stats: StaticBatchStats = { batches: 0, merged: 0, drawCallsSaved: 0, skipped };
  const groups = new Map<string, THREE.Group>();

  for (const [bucket, list] of buckets) {
    if (list.length < minBatch) continue;

    const geoms: THREE.BufferGeometry[] = [];
    const starts: number[] = [];
    const ids: string[] = [];
    let triangles = 0;

    for (const c of list) {
      const g = prepForMerge(c.mesh.geometry);
      // Bake the world transform in: the merged mesh sits at the origin, so
      // every source's placement has to live in its vertices.
      g.applyMatrix4(c.mesh.matrixWorld);
      starts.push(triangles);
      ids.push(c.entityId);
      triangles += g.getAttribute("position").count / 3;
      geoms.push(g);
    }

    let merged: THREE.BufferGeometry | null = null;
    try {
      merged = mergeGeometries(geoms, false);
    } catch {
      merged = null;
    }
    for (const g of geoms) g.dispose();
    if (!merged) {
      stats.skipped += list.length;
      continue;
    }

    const first = list[0]!;
    const mesh = new THREE.Mesh(merged, first.material);
    mesh.castShadow = first.mesh.castShadow;
    mesh.receiveShadow = first.mesh.receiveShadow;
    mesh.renderOrder = first.mesh.renderOrder;
    mesh.layers.mask = first.mesh.layers.mask;
    mesh.name = `batch:${list.length}`;
    mesh.userData[BATCH_OWNERS] = { starts: Uint32Array.from(starts), ids } satisfies BatchOwners;
    // No `entityId` on purpose: this mesh represents many. Pickers resolve it
    // through ownerOfFace() instead of by walking up for an id.
    const unit = bucketGroup.get(bucket);
    if (unit === undefined) group.add(mesh);
    else {
      let sub = groups.get(unit);
      if (!sub) {
        sub = new THREE.Group();
        sub.name = `static-batch:${unit}`;
        groups.set(unit, sub);
        group.add(sub);
      }
      sub.add(mesh);
    }

    for (const c of list) {
      c.mesh.visible = false;
      // Hiding removes it from the render list (`_projectObject` returns early
      // on an invisible object) but NOT from the matrix pass: three's
      // `updateMatrixWorld` recurses regardless of visibility, so a batched
      // scene still pays to re-derive a world matrix, every frame, for every
      // source mesh it just merged away. On a 2000-entity dungeon that pass was
      // measured at 27% of frame time — the largest single cost left after the
      // light-budget recompile bug. A batched source cannot move (any edit
      // disposes the batch and restores it), so its world matrix is already
      // final and recomputing it is pure waste.
      hidden.set(c.mesh, c.mesh.matrixWorldAutoUpdate);
      c.mesh.matrixWorldAutoUpdate = false;
    }
    stats.batches++;
    stats.merged += list.length;
  }

  if (stats.batches === 0) return null;
  stats.drawCallsSaved = stats.merged - stats.batches;
  root.add(group);
  // merged meshes sit at the origin with their placement baked in: nothing
  // moves them (culling only flips visibility), so keep them out of the
  // per-frame matrix walk too
  freezeStaticSubtree(group);

  // The meshes are gone from the render list, but their exported groups still
  // get projected once per pass. Prune only complete model hierarchies whose
  // renderables are ALL represented by the batch. Never hide attached lights,
  // particles, an unbatched part, or a containing gameplay entity.
  const modelRoots = new Set<THREE.Object3D>();
  for (const mesh of hidden.keys()) {
    for (let node: THREE.Object3D | null = mesh; node && node !== root; node = node.parent) {
      if (node.userData["modelRoot"]) { modelRoots.add(node); break; }
    }
  }
  const hiddenRoots = new Map<THREE.Object3D, boolean>();
  for (const model of modelRoots) {
    let complete = true;
    model.traverse((node) => {
      if (hidden.has(node as THREE.Mesh)) return;
      // An empty Group/Object3D is structural; all other object types may
      // contribute to rendering or drive it and must remain traversable.
      if (node.type !== "Group" && node.type !== "Object3D") complete = false;
    });
    if (complete) { hiddenRoots.set(model, model.visible); model.visible = false; }
  }

  // Then the entity groups above them. A town of merged houses otherwise
  // leaves thousands of visible-but-empty groups that every pass (and the
  // per-frame empty-branch scan) walks to find nothing. Bottom-up, highest
  // fully drawn ancestor wins; stops at anything that still renders on its own.
  if (options.prunable) {
    const drawnByBatch = new Map<THREE.Object3D, boolean>();
    const covered = (node: THREE.Object3D): boolean => {
      const known = drawnByBatch.get(node);
      if (known !== undefined) return known;
      let result: boolean;
      // only what THIS batch hid counts: something hidden for another reason
      // (a culled interior, an authored-invisible part) can be shown again later
      if (hidden.has(node as THREE.Mesh) || hiddenRoots.has(node)) result = true;
      else if (!node.visible) result = false;
      else if (node.type !== "Group" && node.type !== "Object3D") result = false;
      else result = node.children.every(covered);
      drawnByBatch.set(node, result);
      return result;
    };
    const candidates = new Set<THREE.Object3D>();
    for (const model of hiddenRoots.keys()) {
      let top: THREE.Object3D | null = null;
      for (let node = model.parent; node && node !== root && node !== group; node = node.parent) {
        if (!options.prunable(node) || !covered(node)) break;
        top = node;
      }
      if (top) candidates.add(top);
    }
    for (const node of candidates) {
      // a candidate under another candidate is already covered by it
      let nested = false;
      for (let up = node.parent; up && up !== root; up = up.parent) if (candidates.has(up)) { nested = true; break; }
      if (nested) continue;
      hiddenRoots.set(node, true);
      node.visible = false;
    }
  }

  return {
    group,
    stats,
    groups,
    dispose(): void {
      for (const [model, visible] of hiddenRoots) model.visible = visible;
      for (const [mesh, matrixWorldAutoUpdate] of hidden) {
        mesh.visible = true;
        // hand the matrix pass back: the caller restores these precisely
        // because something is about to move or re-read them
        mesh.matrixWorldAutoUpdate = matrixWorldAutoUpdate;
        mesh.updateMatrixWorld(true);
      }
      group.traverse((child) => {
        const m = child as THREE.Mesh;
        if (m.isMesh) m.geometry?.dispose();
      });
      group.clear();
      group.parent?.remove(group);
    },
  };
}

/**
 * Merge a loaded model's same-material submeshes into one mesh each.
 *
 * How a glTF splits into submeshes is an artifact of how it was exported, not
 * an authoring decision: a kit-built house arrives as 89 separate meshes
 * averaging eight triangles apiece, all sharing one material. The renderer
 * pays a draw call for every one of them in the main pass AND in every shadow
 * cascade, so with three cascades that single prop cost 356 of the voxel
 * demo's 732 draw calls — half the frame's submission budget for 726
 * triangles of geometry.
 *
 * This is deliberately NOT `batchStaticMeshes`. That one merges across
 * ENTITIES and only for entities flagged static, keyed by entity so the editor
 * can still pick one out of a batch. This merges WITHIN a single loaded model
 * instance, where there are no separate entities to keep pickable — every
 * submesh already belongs to the same entity id.
 *
 * WHAT IT REFUSES TO TOUCH, and why each would be a bug:
 *  - skinned meshes: their vertices are driven by a skeleton, and baking them
 *    into a parent's space freezes them at the bind pose;
 *  - anything under a model with animation clips: a clip addresses nodes by
 *    name, and a merged mesh no longer has the node it animated;
 *  - geometry with attributes beyond position/normal/uv, for the reason
 *    `hasCustomAttributes` exists — the merge would silently delete the data
 *    the material reads;
 *  - multi-material meshes, which would need draw groups and so save nothing.
 *
 * Geometry is NOT disposed on the originals: `skeletonClone` shares buffers
 * with the cached glTF scene, so disposing here would corrupt every other
 * instance of the same model. The originals are only detached.
 */
export function mergeModelSubmeshes(root: THREE.Object3D): number {
  let skinned = false;
  root.traverse((n) => {
    if ((n as THREE.SkinnedMesh).isSkinnedMesh) skinned = true;
  });
  if (skinned) return 0;

  root.updateMatrixWorld(true);
  const toRootLocal = root.matrixWorld.clone().invert();
  const buckets = new Map<string, THREE.Mesh[]>();
  root.traverse((node) => {
    const mesh = node as THREE.Mesh;
    if (!mesh.isMesh) return;
    if ((mesh as unknown as { isInstancedMesh?: boolean }).isInstancedMesh) return;
    if ((mesh as unknown as { isInstancedProps?: boolean }).isInstancedProps) return;
    if (Array.isArray(mesh.material)) return;
    if (!mesh.geometry?.getAttribute("position")) return;
    if (hasCustomAttributes(mesh.geometry)) return;
    const key = bucketKey(mesh, mesh.material);
    const list = buckets.get(key);
    if (list) list.push(mesh);
    else buckets.set(key, [mesh]);
  });

  let removed = 0;
  for (const list of buckets.values()) {
    if (list.length < 2) continue;
    const geoms: THREE.BufferGeometry[] = [];
    for (const mesh of list) {
      const g = prepForMerge(mesh.geometry);
      // into the model root's local space, so the merged mesh can sit on the
      // root with an identity transform and still land where the parts did
      g.applyMatrix4(toRootLocal.clone().multiply(mesh.matrixWorld));
      geoms.push(g);
    }
    const merged = mergeGeometries(geoms, false);
    if (!merged) continue; // attribute mismatch survived prep — leave the parts alone
    const first = list[0]!;
    const mesh = new THREE.Mesh(merged, first.material);
    mesh.name = `${first.name || "submeshes"}#merged`;
    mesh.castShadow = first.castShadow;
    mesh.receiveShadow = first.receiveShadow;
    mesh.renderOrder = first.renderOrder;
    mesh.layers.mask = first.layers.mask;
    mesh.userData["entityId"] = first.userData["entityId"];
    for (const old of list) {
      old.parent?.remove(old);
      removed += 1;
    }
    root.add(mesh);
    removed -= 1; // the replacement is still a mesh
  }
  return removed;
}

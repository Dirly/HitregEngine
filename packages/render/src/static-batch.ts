import * as THREE from "three/webgpu";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";

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
function prepForMerge(geometry: THREE.BufferGeometry): THREE.BufferGeometry {
  const g = (geometry.index ? geometry.toNonIndexed() : geometry.clone()) as THREE.BufferGeometry;
  if (!g.getAttribute("normal")) g.computeVertexNormals();
  if (!g.getAttribute("uv")) {
    const count = g.getAttribute("position").count;
    g.setAttribute("uv", new THREE.BufferAttribute(new Float32Array(count * 2), 2));
  }
  for (const name of Object.keys(g.attributes)) {
    if (name !== "position" && name !== "normal" && name !== "uv") g.deleteAttribute(name);
  }
  return g;
}

/** Does this geometry carry vertex data a merge would have to throw away? */
function hasCustomAttributes(geometry: THREE.BufferGeometry): boolean {
  for (const name of Object.keys(geometry.attributes)) {
    if (name !== "position" && name !== "normal" && name !== "uv") return true;
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
  options: { minBatch?: number } = {},
): StaticBatchHandle | null {
  const minBatch = options.minBatch ?? 2;
  const buckets = new Map<string, Candidate[]>();
  let skipped = 0;

  root.updateMatrixWorld(true);
  root.traverse((node) => {
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
    const entityId = mesh.userData["entityId"] as string | undefined;
    if (!entityId) return void skipped++;
    const key = bucketKey(mesh, mesh.material);
    const list = buckets.get(key);
    if (list) list.push({ mesh, entityId, material: mesh.material });
    else buckets.set(key, [{ mesh, entityId, material: mesh.material }]);
  });

  const group = new THREE.Group();
  group.name = "static-batch";
  group.userData["editorOverlay"] = false;
  const hidden: THREE.Mesh[] = [];
  const stats: StaticBatchStats = { batches: 0, merged: 0, drawCallsSaved: 0, skipped };

  for (const list of buckets.values()) {
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
    group.add(mesh);

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
      c.mesh.matrixWorldAutoUpdate = false;
      hidden.push(c.mesh);
    }
    stats.batches++;
    stats.merged += list.length;
  }

  if (stats.batches === 0) return null;
  stats.drawCallsSaved = stats.merged - stats.batches;
  root.add(group);

  return {
    group,
    stats,
    dispose(): void {
      for (const mesh of hidden) {
        mesh.visible = true;
        // hand the matrix pass back: the caller restores these precisely
        // because something is about to move or re-read them
        mesh.matrixWorldAutoUpdate = true;
        mesh.updateMatrixWorld(true);
      }
      for (const child of [...group.children]) {
        const m = child as THREE.Mesh;
        m.geometry?.dispose();
        group.remove(child);
      }
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

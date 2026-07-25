import { duplicateSubtree, type Op, type SceneDoc, type SceneStore } from "@hitreg/core";

/**
 * Group operations shared by the viewport (keyboard shortcuts, drag-drop),
 * the context menu, and the hierarchy panel, so each doesn't reimplement its
 * own subtree-pruning / batching logic.
 */

/** Drop any id that is a descendant of another id already in the set. */
export function pruneToRoots(doc: SceneDoc, ids: string[]): string[] {
  const set = new Set(ids);
  return ids.filter((id) => {
    let cursor = doc.entities[id]?.parent ?? null;
    while (cursor) {
      if (set.has(cursor)) return false;
      cursor = doc.entities[cursor]?.parent ?? null;
    }
    return true;
  });
}

/** Duplicates every (pruned) root's subtree in one batch. Returns the new root ids, in order. */
export function duplicateMany(store: SceneStore, doc: SceneDoc, ids: string[]): string[] {
  const roots = pruneToRoots(doc, ids);
  const ops: Op[] = [];
  const newRoots: string[] = [];
  for (const id of roots) {
    const subtreeOps = duplicateSubtree(doc, id);
    if (subtreeOps.length === 0) continue;
    ops.push(...subtreeOps);
    newRoots.push((subtreeOps[0] as { id: string }).id);
  }
  if (ops.length > 0) store.apply(ops);
  return newRoots;
}

/** Removes every (pruned) root's subtree in one batch. */
export function deleteMany(store: SceneStore, doc: SceneDoc, ids: string[]): void {
  const roots = pruneToRoots(doc, ids);
  if (roots.length === 0) return;
  store.apply(roots.map((id) => ({ op: "remove-entity", id }) satisfies Op));
}

/**
 * True if `id` or any of its ancestors is locked. Used only by viewport
 * picking/gizmo-attach (see viewport.ts) — locking does not gate Hierarchy
 * selection, rename, delete, duplicate, or reparent, which stay available as
 * deliberate panel actions.
 */
export function isLockedCascading(doc: SceneDoc, id: string): boolean {
  let cursor: string | null = id;
  const max = Object.keys(doc.entities).length;
  let hops = 0;
  while (cursor && hops++ <= max) {
    const entity: SceneDoc["entities"][string] | undefined = doc.entities[cursor];
    if (!entity) return false;
    if (entity.locked === true) return true;
    cursor = entity.parent;
  }
  return false;
}

/** Assigns `materialId` to every id in the set that already has a `mesh` component. */
export function applyMaterialToMany(
  store: SceneStore,
  doc: SceneDoc,
  ids: string[],
  materialId: string,
): void {
  const ops: Op[] = [];
  for (const id of ids) {
    const mesh = doc.entities[id]?.components["mesh"] as Record<string, unknown> | undefined;
    if (!mesh) continue;
    ops.push({ op: "set-component", id, component: "mesh", data: { ...mesh, material: materialId } });
  }
  if (ops.length > 0) store.apply(ops);
}

/** Mixed-state toggle: if any id is unlocked, lock all of them; else unlock all. */
export function toggleLockMany(store: SceneStore, doc: SceneDoc, ids: string[]): void {
  if (ids.length === 0) return;
  const shouldLock = ids.some((id) => doc.entities[id]?.locked !== true);
  store.apply(ids.map((id) => ({ op: "set-locked", id, locked: shouldLock }) satisfies Op));
}

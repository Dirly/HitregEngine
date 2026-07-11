import type { EntityId } from "./ids.js";
import type { EntityDoc, SceneDoc } from "./scene.js";

/**
 * Derived lookup structures over a scene document. Purely disposable — the
 * JSON doc stays the single source of truth; an index can be rebuilt from it
 * at any time. Enables O(1) child/tag/component queries without scanning all
 * entities (the doc-scanning `childrenOf`/`subtreeOf` in scene.ts remain for
 * callers that don't hold an index).
 *
 * Invariants (buildSceneIndex produces them; incremental maintainers must
 * preserve them so indexes stay deep-equal to a fresh build):
 * - `childrenByParent` arrays follow the doc's entity insertion order and
 *   only contain entries for parents that actually have children.
 * - Set-valued maps never hold empty sets.
 */
export interface SceneIndex {
  /** parent id (null = scene roots) -> child ids, insertion-ordered. */
  childrenByParent: Map<EntityId | null, EntityId[]>;
  entitiesByTag: Map<string, Set<EntityId>>;
  /** component name -> ids of entities carrying it. */
  entitiesByComponent: Map<string, Set<EntityId>>;
  /** prefabId -> ids of instance entities (entities with a `prefab` component). */
  prefabInstances: Map<string, Set<EntityId>>;
}

/** The prefabId an entity's `prefab` component points at, if it is an instance. */
function prefabIdOf(entity: EntityDoc): string | null {
  const data = entity.components["prefab"];
  if (typeof data !== "object" || data === null) return null;
  const prefabId = (data as { prefabId?: unknown }).prefabId;
  return typeof prefabId === "string" ? prefabId : null;
}

function addToSetMap<K>(map: Map<K, Set<EntityId>>, key: K, id: EntityId): void {
  let set = map.get(key);
  if (!set) {
    set = new Set();
    map.set(key, set);
  }
  set.add(id);
}

function removeFromSetMap<K>(
  map: Map<K, Set<EntityId>>,
  key: K,
  id: EntityId,
): void {
  const set = map.get(key);
  if (!set) return;
  set.delete(id);
  if (set.size === 0) map.delete(key);
}

/** Index one entity into every map. Order of calls defines children order. */
function indexEntity(index: SceneIndex, id: EntityId, entity: EntityDoc): void {
  let siblings = index.childrenByParent.get(entity.parent);
  if (!siblings) {
    siblings = [];
    index.childrenByParent.set(entity.parent, siblings);
  }
  siblings.push(id);
  for (const tag of entity.tags) addToSetMap(index.entitiesByTag, tag, id);
  for (const name of Object.keys(entity.components)) {
    addToSetMap(index.entitiesByComponent, name, id);
  }
  const prefabId = prefabIdOf(entity);
  if (prefabId !== null) addToSetMap(index.prefabInstances, prefabId, id);
}

/** Remove one entity from every map, given its (old) doc entry. */
function unindexEntity(index: SceneIndex, id: EntityId, entity: EntityDoc): void {
  const siblings = index.childrenByParent.get(entity.parent);
  if (siblings) {
    const at = siblings.indexOf(id);
    if (at !== -1) siblings.splice(at, 1);
    if (siblings.length === 0) index.childrenByParent.delete(entity.parent);
  }
  for (const tag of entity.tags) removeFromSetMap(index.entitiesByTag, tag, id);
  for (const name of Object.keys(entity.components)) {
    removeFromSetMap(index.entitiesByComponent, name, id);
  }
  const prefabId = prefabIdOf(entity);
  if (prefabId !== null) removeFromSetMap(index.prefabInstances, prefabId, id);
}

/** Build a complete index from scratch. Cheap even for 10k-entity docs. */
export function buildSceneIndex(doc: SceneDoc): SceneIndex {
  const index: SceneIndex = {
    childrenByParent: new Map(),
    entitiesByTag: new Map(),
    entitiesByComponent: new Map(),
    prefabInstances: new Map(),
  };
  for (const [id, entity] of Object.entries(doc.entities)) {
    indexEntity(index, id, entity);
  }
  return index;
}

/** Children of `id` (null = scene roots) without scanning the doc. */
export function indexChildrenOf(
  index: SceneIndex,
  id: EntityId | null,
): EntityId[] {
  return index.childrenByParent.get(id) ?? [];
}

/**
 * Entity ids of the subtree rooted at `id` (inclusive), parents before
 * children — same contract as scene.ts's `subtreeOf`, but O(subtree) via the
 * index instead of O(entities) per level.
 */
export function indexSubtreeOf(
  index: SceneIndex,
  doc: SceneDoc,
  id: EntityId,
): EntityId[] {
  if (!(id in doc.entities)) return [];
  const out: EntityId[] = [];
  const queue: EntityId[] = [id];
  while (queue.length > 0) {
    const current = queue.shift()!;
    out.push(current);
    queue.push(...indexChildrenOf(index, current));
  }
  return out;
}

/**
 * Incrementally fold one applyOps result into an existing index, using the
 * previous and next docs plus the batch's affected sets. Only valid for
 * NON-STRUCTURAL batches: nothing removed and no parent changed. Structural
 * batches must fall back to buildSceneIndex — sibling insertion order after
 * removals/reparents is doc-key order, which an in-place splice cannot cheaply
 * reproduce, and correctness beats cleverness.
 *
 * Returns true when the index was updated in place; returns false — before
 * touching the index at all — when the batch is structural and the caller
 * must rebuild.
 */
export function updateSceneIndex(
  index: SceneIndex,
  prev: SceneDoc,
  next: SceneDoc,
  affected: {
    changedEntities: Set<string>;
    addedEntities: Set<string>;
    removedEntities: Set<string>;
  },
): boolean {
  if (affected.removedEntities.size > 0) return false;
  for (const id of affected.changedEntities) {
    const before = prev.entities[id];
    const after = next.entities[id];
    if (!before || !after || before.parent !== after.parent) return false;
  }

  // changed, same parent: swap tag/component/prefab entries; children untouched
  for (const id of affected.changedEntities) {
    const before = prev.entities[id]!;
    const after = next.entities[id]!;
    for (const tag of before.tags) removeFromSetMap(index.entitiesByTag, tag, id);
    for (const tag of after.tags) addToSetMap(index.entitiesByTag, tag, id);
    for (const name of Object.keys(before.components)) {
      removeFromSetMap(index.entitiesByComponent, name, id);
    }
    for (const name of Object.keys(after.components)) {
      addToSetMap(index.entitiesByComponent, name, id);
    }
    const prevPrefab = prefabIdOf(before);
    const nextPrefab = prefabIdOf(after);
    if (prevPrefab !== nextPrefab) {
      if (prevPrefab !== null) removeFromSetMap(index.prefabInstances, prevPrefab, id);
      if (nextPrefab !== null) addToSetMap(index.prefabInstances, nextPrefab, id);
    }
  }

  // added: new doc keys are appended, so plain pushes match rebuild order
  for (const id of affected.addedEntities) {
    indexEntity(index, id, next.entities[id]!);
  }

  return true;
}

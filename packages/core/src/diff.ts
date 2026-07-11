import type { Op } from "./ops.js";
import type { SceneDoc } from "./scene.js";

/**
 * Compute the ops batch that turns `current` into `incoming`.
 *
 * This is the bridge from "a whole scene file changed on disk" back into the
 * ops protocol: instead of replacing the document (which nukes undo/redo and
 * makes concurrent agent-vs-human edits last-writer-wins), the external file
 * becomes one atomic, undo-able transaction against the live doc.
 *
 * Guarantee: `applyOps(current, diffSceneDocs(current, incoming), registry)`
 * yields a doc whose entities deep-equal `incoming`'s. Entity KEY ORDER in the
 * `entities` record may differ — object key order is not semantic in a
 * SceneDoc, so this is not a divergence.
 *
 * Op ordering (so the batch validates op-by-op):
 *  (a) `add-entity` for new ids, parents before children when the parent is
 *      also new (existing parents are always present at add time).
 *  (b) For surviving ids: `reparent` where the parent differs — ordered by
 *      incoming-tree depth, shallowest first, so no transient parent cycle can
 *      form (e.g. swapping A<->B) — then `rename`, `set-tags` (order-sensitive
 *      compare), `set-component` per component whose JSON differs, and
 *      `remove-component` per component gone.
 *  (c) `remove-entity` LAST, and only for the ROOTS of vanished subtrees —
 *      remove-entity cascades, so descendants need no op of their own. A
 *      surviving entity whose old parent vanished necessarily differs in
 *      parent, so phase (b) reparents it out of the doomed subtree before the
 *      cascade runs.
 *
 * Component equality is compared via JSON.stringify of both sides; key-order
 * false positives just emit a redundant (harmless) set-component. Pure
 * function — no registry needed; both docs are assumed schema-valid.
 */
export function diffSceneDocs(current: SceneDoc, incoming: SceneDoc): Op[] {
  const ops: Op[] = [];
  const cur = current.entities;
  const inc = incoming.entities;

  // -- (a) additions, parents first ------------------------------------------
  const newIds = Object.keys(inc).filter((id) => !(id in cur));
  const isNew = new Set(newIds);
  const emitted = new Set<string>();
  const emitAdd = (id: string): void => {
    if (emitted.has(id)) return;
    emitted.add(id);
    const entity = inc[id]!;
    if (entity.parent !== null && isNew.has(entity.parent)) emitAdd(entity.parent);
    ops.push({ op: "add-entity", id, entity: structuredClone(entity) });
  };
  for (const id of newIds) emitAdd(id);

  // -- (b) surviving entities -------------------------------------------------
  const survivors = Object.keys(inc).filter((id) => id in cur);

  // reparents first, shallowest incoming depth first: when an entity is
  // reparented, every incoming ancestor of its new parent has already been
  // placed (added with its final parent, or reparented at a smaller depth),
  // so the new parent's ancestor chain already matches `incoming` and cannot
  // contain the entity being moved — no transient cycle.
  const depthCache = new Map<string, number>();
  const incomingDepth = (id: string): number => {
    const cached = depthCache.get(id);
    if (cached !== undefined) return cached;
    const parent = inc[id]!.parent;
    const depth = parent === null ? 0 : incomingDepth(parent) + 1;
    depthCache.set(id, depth);
    return depth;
  };
  survivors
    .filter((id) => cur[id]!.parent !== inc[id]!.parent)
    .sort((a, b) => incomingDepth(a) - incomingDepth(b))
    .forEach((id) => ops.push({ op: "reparent", id, parent: inc[id]!.parent }));

  for (const id of survivors) {
    const before = cur[id]!;
    const after = inc[id]!;
    if (before.name !== after.name) {
      ops.push({ op: "rename", id, name: after.name });
    }
    if (JSON.stringify(before.tags) !== JSON.stringify(after.tags)) {
      ops.push({ op: "set-tags", id, tags: [...after.tags] });
    }
    for (const [component, data] of Object.entries(after.components)) {
      const prev = before.components[component];
      if (
        !(component in before.components) ||
        JSON.stringify(prev) !== JSON.stringify(data)
      ) {
        ops.push({
          op: "set-component",
          id,
          component,
          data: structuredClone(data),
        });
      }
    }
    for (const component of Object.keys(before.components)) {
      if (!(component in after.components)) {
        ops.push({ op: "remove-component", id, component });
      }
    }
  }

  // -- (c) removals last, vanished-subtree roots only --------------------------
  for (const id of Object.keys(cur)) {
    if (id in inc) continue;
    const parent = cur[id]!.parent;
    const parentAlsoVanished =
      parent !== null && parent in cur && !(parent in inc);
    if (!parentAlsoVanished) ops.push({ op: "remove-entity", id });
  }

  return ops;
}

import { newId, type EntityId } from "./ids.js";
import type { Op } from "./ops.js";
import { subtreeOf, type SceneDoc } from "./scene.js";

/**
 * Ops that duplicate an entity and its whole subtree with fresh ids.
 * The copy lands under the same parent; the root copy is renamed "<name> Copy".
 */
export function duplicateSubtree(
  doc: SceneDoc,
  id: EntityId,
  genId: () => EntityId = newId,
): Op[] {
  const ids = subtreeOf(doc, id);
  if (ids.length === 0) return [];
  const remap = new Map<EntityId, EntityId>(ids.map((old) => [old, genId()]));
  return ids.map((old) => {
    const source = doc.entities[old]!;
    const entity = structuredClone(source);
    if (old === id) {
      entity.name = `${source.name} Copy`;
    } else {
      entity.parent = remap.get(source.parent!)!;
    }
    return { op: "add-entity", id: remap.get(old)!, entity };
  });
}

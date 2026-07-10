import { z } from "zod";
import type { EntityId } from "./ids.js";
import type { ComponentRegistry } from "./components/registry.js";

export const entityDocSchema = z.object({
  name: z.string().min(1),
  parent: z.string().nullable().default(null),
  tags: z.array(z.string()).default([]),
  components: z.record(z.string(), z.unknown()).default({}),
});

export const sceneDocSchema = z.object({
  version: z.literal(1),
  name: z.string().min(1),
  entities: z.record(z.string(), entityDocSchema),
});

export type EntityDoc = z.infer<typeof entityDocSchema>;
export type SceneDoc = z.infer<typeof sceneDocSchema>;

export function createScene(name: string): SceneDoc {
  return { version: 1, name, entities: {} };
}

export function childrenOf(doc: SceneDoc, id: EntityId | null): EntityId[] {
  return Object.keys(doc.entities).filter(
    (eid) => doc.entities[eid]!.parent === id,
  );
}

/** Entity ids of the subtree rooted at `id` (inclusive), parents before children. */
export function subtreeOf(doc: SceneDoc, id: EntityId): EntityId[] {
  const out: EntityId[] = [];
  const queue: EntityId[] = [id];
  while (queue.length > 0) {
    const current = queue.shift()!;
    if (!(current in doc.entities)) continue;
    out.push(current);
    queue.push(...childrenOf(doc, current));
  }
  return out;
}

export interface SceneIssue {
  entity: EntityId;
  message: string;
}

/**
 * Structural + component validation of a whole document. Returns issues rather
 * than throwing so tooling (and AI) can report everything at once.
 */
export function validateScene(
  doc: SceneDoc,
  registry: ComponentRegistry,
): SceneIssue[] {
  const issues: SceneIssue[] = [];
  for (const [id, entity] of Object.entries(doc.entities)) {
    if (entity.parent !== null && !(entity.parent in doc.entities)) {
      issues.push({ entity: id, message: `parent ${entity.parent} does not exist` });
    }
    // cycle check: walk up, bounded by entity count
    let cursor = entity.parent;
    let hops = 0;
    const max = Object.keys(doc.entities).length;
    while (cursor !== null && hops <= max) {
      if (cursor === id) {
        issues.push({ entity: id, message: "parent chain forms a cycle" });
        break;
      }
      cursor = doc.entities[cursor]?.parent ?? null;
      hops++;
    }
    for (const [name, data] of Object.entries(entity.components)) {
      const result = registry.validate(name, data);
      if (!result.ok) {
        issues.push({ entity: id, message: `component ${name}: ${result.error}` });
      }
    }
  }
  return issues;
}

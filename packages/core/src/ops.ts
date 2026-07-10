import type { EntityId } from "./ids.js";
import { entityDocSchema, subtreeOf, type EntityDoc, type SceneDoc } from "./scene.js";
import type { ComponentRegistry } from "./components/registry.js";

/**
 * The ops protocol: every mutation of a scene document — editor gizmo drags,
 * inspector edits, AI tool calls, undo/redo — is one of these. Never a whole
 * file rewrite.
 */
export type Op =
  | { op: "add-entity"; id: EntityId; entity: EntityDoc }
  | { op: "remove-entity"; id: EntityId }
  | { op: "reparent"; id: EntityId; parent: EntityId | null }
  | { op: "rename"; id: EntityId; name: string }
  | { op: "set-tags"; id: EntityId; tags: string[] }
  | { op: "set-component"; id: EntityId; component: string; data: unknown }
  | { op: "remove-component"; id: EntityId; component: string };

export class OpError extends Error {
  constructor(
    message: string,
    readonly opIndex: number,
  ) {
    super(`op[${opIndex}]: ${message}`);
    this.name = "OpError";
  }
}

export interface ApplyResult {
  doc: SceneDoc;
  /** Applying these (in order) to `doc` restores the input document. */
  inverse: Op[];
}

/**
 * Apply a batch of ops atomically: either every op validates and applies, or
 * an OpError is thrown and the input document is untouched. The input is never
 * mutated; a new document is returned along with the inverse batch (undo).
 */
export function applyOps(
  input: SceneDoc,
  ops: Op[],
  registry: ComponentRegistry,
): ApplyResult {
  const doc = structuredClone(input);
  const inverse: Op[] = [];

  ops.forEach((op, i) => {
    const undo = applyOne(doc, op, registry, i);
    // inverse batch runs in reverse op order
    inverse.unshift(...undo);
  });

  return { doc, inverse };
}

function requireEntity(doc: SceneDoc, id: EntityId, i: number): EntityDoc {
  const entity = doc.entities[id];
  if (!entity) throw new OpError(`entity ${id} does not exist`, i);
  return entity;
}

function validateComponents(
  entity: EntityDoc,
  registry: ComponentRegistry,
  i: number,
): void {
  for (const [name, data] of Object.entries(entity.components)) {
    const result = registry.validate(name, data);
    if (!result.ok) throw new OpError(result.error, i);
    entity.components[name] = result.data;
  }
}

function applyOne(
  doc: SceneDoc,
  op: Op,
  registry: ComponentRegistry,
  i: number,
): Op[] {
  switch (op.op) {
    case "add-entity": {
      if (op.id in doc.entities) {
        throw new OpError(`entity ${op.id} already exists`, i);
      }
      const parsed = entityDocSchema.safeParse(op.entity);
      if (!parsed.success) throw new OpError(parsed.error.message, i);
      const entity = parsed.data;
      if (entity.parent !== null && !(entity.parent in doc.entities)) {
        throw new OpError(`parent ${entity.parent} does not exist`, i);
      }
      validateComponents(entity, registry, i);
      doc.entities[op.id] = entity;
      return [{ op: "remove-entity", id: op.id }];
    }

    case "remove-entity": {
      requireEntity(doc, op.id, i);
      // removing a node removes its subtree (editor semantics)
      const removed = subtreeOf(doc, op.id);
      const restores: Op[] = removed.map((id) => ({
        op: "add-entity",
        id,
        entity: structuredClone(doc.entities[id]!),
      }));
      for (const id of removed) delete doc.entities[id];
      // restores are already parent-first, so they replay in given order
      return restores;
    }

    case "reparent": {
      const entity = requireEntity(doc, op.id, i);
      if (op.parent !== null) {
        if (!(op.parent in doc.entities)) {
          throw new OpError(`parent ${op.parent} does not exist`, i);
        }
        if (subtreeOf(doc, op.id).includes(op.parent)) {
          throw new OpError(
            `cannot reparent ${op.id} under its own descendant ${op.parent}`,
            i,
          );
        }
      }
      const prev = entity.parent;
      entity.parent = op.parent;
      return [{ op: "reparent", id: op.id, parent: prev }];
    }

    case "rename": {
      const entity = requireEntity(doc, op.id, i);
      if (op.name.length === 0) throw new OpError("name must be non-empty", i);
      const prev = entity.name;
      entity.name = op.name;
      return [{ op: "rename", id: op.id, name: prev }];
    }

    case "set-tags": {
      const entity = requireEntity(doc, op.id, i);
      const prev = entity.tags;
      entity.tags = [...op.tags];
      return [{ op: "set-tags", id: op.id, tags: prev }];
    }

    case "set-component": {
      const entity = requireEntity(doc, op.id, i);
      const result = registry.validate(op.component, op.data);
      if (!result.ok) throw new OpError(result.error, i);
      const had = op.component in entity.components;
      const prev = had ? structuredClone(entity.components[op.component]) : null;
      entity.components[op.component] = result.data;
      return had
        ? [{ op: "set-component", id: op.id, component: op.component, data: prev }]
        : [{ op: "remove-component", id: op.id, component: op.component }];
    }

    case "remove-component": {
      const entity = requireEntity(doc, op.id, i);
      if (!(op.component in entity.components)) {
        throw new OpError(
          `entity ${op.id} has no component "${op.component}"`,
          i,
        );
      }
      const prev = structuredClone(entity.components[op.component]);
      delete entity.components[op.component];
      return [
        { op: "set-component", id: op.id, component: op.component, data: prev },
      ];
    }
  }
}

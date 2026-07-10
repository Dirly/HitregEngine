import { z } from "zod";
import {
  createScene,
  entityDocSchema,
  subtreeOf,
  validateScene,
  type EntityDoc,
  type SceneDoc,
} from "./scene.js";
import type { ComponentRegistry } from "./components/registry.js";
import type { AssetLibrary } from "./assets.js";
import type { Op } from "./ops.js";

/**
 * A prefab is a React-style component definition: an entity subtree plus
 * declared props bound to fields inside it. Scene documents store instances
 * collapsed (one entity with a `prefab` component); expansion into full
 * entities happens at compile time, never in the source doc.
 */
export const prefabDocSchema = z.object({
  version: z.literal(1),
  name: z.string().min(1),
  /** Local id of the root entity. Instances take the root's place in the scene. */
  root: z.string().min(1),
  entities: z.record(z.string(), entityDocSchema),
  props: z
    .record(
      z.string(),
      z.object({
        default: z.unknown(),
        /** Paths like "lamp/components/light/color" — first segment is a local entity id. */
        bindings: z.array(z.string().min(1)).default([]),
        description: z.string().optional(),
      }),
    )
    .default({}),
});

export type PrefabDoc = z.infer<typeof prefabDocSchema>;

/** The `prefab` component carried by an instance entity in a scene doc. */
export const prefabInstanceSchema = z.object({
  prefabId: z.string().min(1),
  props: z.record(z.string(), z.unknown()).default({}),
  overrides: z
    .array(z.object({ path: z.string().min(1), value: z.unknown() }))
    .default([]),
});

export type PrefabInstance = z.infer<typeof prefabInstanceSchema>;

export class PrefabError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PrefabError";
  }
}

/** Validate prefab structure beyond the schema: root exists, tree is local + acyclic. */
export function validatePrefab(prefab: PrefabDoc): void {
  const root = prefab.entities[prefab.root];
  if (!root) throw new PrefabError(`prefab "${prefab.name}": root "${prefab.root}" not found`);
  if (root.parent !== null) {
    throw new PrefabError(`prefab "${prefab.name}": root must have parent null`);
  }
  for (const [localId, entity] of Object.entries(prefab.entities)) {
    if (localId === prefab.root) continue;
    if (entity.parent === null || !(entity.parent in prefab.entities)) {
      throw new PrefabError(
        `prefab "${prefab.name}": entity "${localId}" parent must be a local entity`,
      );
    }
  }
  // reachability doubles as cycle check: unreachable nodes include any cycle members
  const reachable = new Set([prefab.root]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const [localId, entity] of Object.entries(prefab.entities)) {
      if (!reachable.has(localId) && entity.parent !== null && reachable.has(entity.parent)) {
        reachable.add(localId);
        grew = true;
      }
    }
  }
  for (const localId of Object.keys(prefab.entities)) {
    if (!reachable.has(localId)) {
      throw new PrefabError(
        `prefab "${prefab.name}": entity "${localId}" is not reachable from the root (cycle or orphan)`,
      );
    }
  }
}

/**
 * Unity's "create prefab from selection": turn an entity subtree into a
 * PrefabDoc (existing ids become the prefab's local ids) plus the ops that
 * replace the original subtree with an instance of it. Register the returned
 * prefab in the AssetLibrary BEFORE applying replaceOps.
 */
export function prefabFromSubtree(
  doc: SceneDoc,
  rootId: string,
  prefabId: string,
  name?: string,
): { prefab: PrefabDoc; replaceOps: Op[] } {
  const source = doc.entities[rootId];
  if (!source) throw new PrefabError(`entity ${rootId} does not exist`);
  if ("prefab" in source.components) {
    throw new PrefabError("selection is already a prefab instance");
  }

  const ids = subtreeOf(doc, rootId);
  const entities: Record<string, EntityDoc> = {};
  for (const id of ids) {
    const entity = structuredClone(doc.entities[id]!);
    if (id === rootId) entity.parent = null;
    entities[id] = entity;
  }
  const prefab: PrefabDoc = {
    version: 1,
    name: name ?? source.name,
    root: rootId,
    entities,
    props: {},
  };
  validatePrefab(prefab);

  const instanceComponents: Record<string, unknown> = {
    prefab: { prefabId, props: {}, overrides: [] },
  };
  if (source.components["transform"]) {
    instanceComponents["transform"] = structuredClone(source.components["transform"]);
  }
  const replaceOps: Op[] = [
    { op: "remove-entity", id: rootId },
    {
      op: "add-entity",
      id: rootId,
      entity: {
        name: source.name,
        parent: source.parent,
        tags: [...source.tags],
        components: instanceComponents,
      },
    },
  ];
  return { prefab, replaceOps };
}

function setPath(
  entities: Record<string, EntityDoc>,
  path: string,
  value: unknown,
  context: string,
): void {
  const segments = path.split("/");
  const localId = segments[0];
  if (segments.length < 2 || !localId || !(localId in entities)) {
    throw new PrefabError(`${context}: path "${path}" must start with a local entity id`);
  }
  let target: Record<string, unknown> = entities[localId] as unknown as Record<string, unknown>;
  for (let s = 1; s < segments.length - 1; s++) {
    const key = segments[s]!;
    const next = target[key];
    if (typeof next !== "object" || next === null || Array.isArray(next)) {
      throw new PrefabError(`${context}: path "${path}" has no object at "${key}"`);
    }
    target = next as Record<string, unknown>;
  }
  target[segments[segments.length - 1]!] = structuredClone(value);
}

/**
 * Expand every prefab instance in a scene into concrete entities. Child entity
 * ids are namespaced "<instanceId>:<localId>"; the instance entity itself
 * becomes the prefab root (keeping its id, name, parent, and any components it
 * declares, which replace the root's per-component). Pure: input is untouched.
 */
export function expandScene(
  input: SceneDoc,
  assets: AssetLibrary,
  registry: ComponentRegistry,
): SceneDoc {
  const out = createScene(input.name);

  for (const [id, entity] of Object.entries(input.entities)) {
    if ("prefab" in entity.components) {
      expandInstance(id, structuredClone(entity), out, assets, registry, []);
    } else {
      out.entities[id] = normalizeEntity(id, structuredClone(entity), registry);
    }
  }

  const issues = validateScene(out, registry);
  if (issues.length > 0) {
    throw new PrefabError(
      `expanded scene is invalid:\n` +
        issues.map((issue) => `  ${issue.entity}: ${issue.message}`).join("\n"),
    );
  }
  return out;
}

function normalizeEntity(
  id: string,
  entity: EntityDoc,
  registry: ComponentRegistry,
): EntityDoc {
  for (const [name, data] of Object.entries(entity.components)) {
    const result = registry.validate(name, data);
    if (!result.ok) throw new PrefabError(`entity ${id}, component ${name}: ${result.error}`);
    entity.components[name] = result.data;
  }
  return entity;
}

function expandInstance(
  instanceId: string,
  instanceEntity: EntityDoc,
  out: SceneDoc,
  assets: AssetLibrary,
  registry: ComponentRegistry,
  stack: string[],
): void {
  const parsedInstance = prefabInstanceSchema.safeParse(instanceEntity.components["prefab"]);
  if (!parsedInstance.success) {
    throw new PrefabError(`entity ${instanceId}: invalid prefab component: ${parsedInstance.error.message}`);
  }
  const instance = parsedInstance.data;

  if (stack.includes(instance.prefabId)) {
    throw new PrefabError(
      `prefab cycle: ${[...stack, instance.prefabId].join(" -> ")}`,
    );
  }
  const prefab = assets.getPrefab(instance.prefabId);
  if (!prefab) {
    throw new PrefabError(`entity ${instanceId}: prefab ${instance.prefabId} not found`);
  }

  const local = structuredClone(prefab.entities);
  const context = `prefab "${prefab.name}" (instance ${instanceId})`;

  if ("prefab" in local[prefab.root]!.components) {
    throw new PrefabError(
      `${context}: root may not itself be a prefab instance (variants are not supported yet)`,
    );
  }

  // props: instance value, else declared default, written to every binding
  for (const name of Object.keys(instance.props)) {
    if (!(name in prefab.props)) {
      throw new PrefabError(`${context}: unknown prop "${name}"`);
    }
  }
  for (const [name, spec] of Object.entries(prefab.props)) {
    const value = name in instance.props ? instance.props[name] : spec.default;
    for (const binding of spec.bindings) {
      setPath(local, binding, value, `${context}, prop "${name}"`);
    }
  }

  // per-instance overrides apply after props
  for (const override of instance.overrides) {
    setPath(local, override.path, override.value, `${context}, override`);
  }

  for (const [localId, localEntity] of Object.entries(local)) {
    const isRoot = localId === prefab.root;
    const outId = isRoot ? instanceId : `${instanceId}:${localId}`;

    const entity: EntityDoc = isRoot
      ? {
          name: instanceEntity.name,
          parent: instanceEntity.parent,
          tags: [...new Set([...localEntity.tags, ...instanceEntity.tags])],
          components: { ...localEntity.components },
        }
      : {
          ...localEntity,
          parent:
            localEntity.parent === prefab.root
              ? instanceId
              : `${instanceId}:${localEntity.parent}`,
        };

    if (isRoot) {
      // instance-declared components replace the root's, per component
      for (const [name, data] of Object.entries(instanceEntity.components)) {
        if (name !== "prefab") entity.components[name] = structuredClone(data);
      }
    }

    // nested prefab instances expand recursively
    if ("prefab" in entity.components) {
      expandInstance(outId, entity, out, assets, registry, [
        ...stack,
        instance.prefabId,
      ]);
      continue;
    }

    out.entities[outId] = normalizeEntity(outId, entity, registry);
  }
}

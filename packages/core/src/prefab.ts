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
/**
 * The control kinds an editor knows how to render for a prefab prop. Omitting
 * `kind` infers it from the prop's `default` — declare it only to force a
 * control the value shape can't imply (a `number` that is really an `enum`,
 * a `string` that is really an `asset` id).
 */
export const PROP_KINDS = [
  "number",
  "boolean",
  "string",
  "color",
  "vec3",
  "enum",
  "asset",
  "json",
] as const;

export type PropKind = (typeof PROP_KINDS)[number];

/**
 * A prop declaration — the *knob*, not just the value. This is the contract
 * that makes AI-generated content human-tweakable: whatever generated a
 * prefab also declares which of its numbers are meant to be turned, in what
 * range, in what unit, and under what human-readable label. The editor renders
 * the control from this (no hand-written inspector), and the same declaration
 * rides into the engine spec so an agent asked to "make the rifle kick harder"
 * knows `recoil` exists, that it runs 0..1, and that it is grouped under
 * "Handling" — instead of guessing at raw component paths.
 *
 * Every metadata field is optional: an untyped `{ default, bindings }` prop
 * (the original shape) still validates and still infers a sensible control.
 */
export const propSpecSchema = z.object({
  default: z.unknown().describe("Value used when an instance does not set this prop."),
  /** Paths like "lamp/components/light/color" — first segment is a local entity id. */
  bindings: z
    .array(z.string().min(1))
    .default([])
    .describe(
      'Where the value is written on expand: "<localEntityId>/components/<component>/<field>".',
    ),
  description: z
    .string()
    .optional()
    .describe("What this knob does, in one line — shown as inspector help and read by agents."),
  kind: z
    .enum(PROP_KINDS)
    .optional()
    .describe("Control type. Omit to infer from `default` (and from `options`, which implies enum)."),
  label: z.string().optional().describe("Human-facing name. Omit to use the prop key."),
  group: z
    .string()
    .optional()
    .describe('Inspector section, e.g. "Handling" or "Damage". Ungrouped knobs come first.'),
  order: z.number().optional().describe("Sort order within a group (ascending)."),
  min: z.number().optional().describe("Inclusive lower bound — with max, renders a slider."),
  max: z.number().optional().describe("Inclusive upper bound — with min, renders a slider."),
  step: z.number().positive().optional().describe("Slider/number increment."),
  unit: z
    .string()
    .optional()
    .describe('Unit suffix shown beside the value: "m", "m/s", "deg", "rpm", "%".'),
  options: z
    .array(z.union([z.string(), z.number()]))
    .nonempty()
    .optional()
    .describe("Allowed values — presence implies an enum dropdown."),
  assetKind: z
    .string()
    .optional()
    .describe('For kind "asset": which library to pick from ("material", "model", "prefab", …).'),
  advanced: z
    .boolean()
    .optional()
    .describe("Hide behind the inspector's “advanced” disclosure; agents still see it."),
});

export type PropSpec = z.infer<typeof propSpecSchema>;

const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;

/** The control kind implied by a prop declaration when it doesn't state one. */
export function inferPropKind(spec: Pick<PropSpec, "default" | "kind" | "options" | "assetKind">): PropKind {
  if (spec.kind) return spec.kind;
  if (spec.options) return "enum";
  if (spec.assetKind) return "asset";
  const value = spec.default;
  if (typeof value === "boolean") return "boolean";
  if (typeof value === "number") return "number";
  if (typeof value === "string") return HEX_COLOR.test(value) ? "color" : "string";
  if (Array.isArray(value) && value.length === 3 && value.every((v) => typeof v === "number")) {
    return "vec3";
  }
  return "json";
}

export const prefabDocSchema = z.object({
  version: z.literal(1),
  name: z.string().min(1),
  /** Local id of the root entity. Instances take the root's place in the scene. */
  root: z.string().min(1),
  entities: z.record(z.string(), entityDocSchema),
  props: z.record(z.string(), propSpecSchema).default({}),
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
  validateProps(prefab);
}

/**
 * Knob declarations are part of the authoring contract, so a malformed one is
 * a validation error, not a silently-ignored hint. Catching it here means a
 * generator that emits a bad range fails at write time — with a message naming
 * the prop — instead of producing an inspector control nobody can use.
 */
function validateProps(prefab: PrefabDoc): void {
  for (const [name, spec] of Object.entries(prefab.props)) {
    const where = `prefab "${prefab.name}", prop "${name}"`;
    const kind = inferPropKind(spec);

    if (spec.min !== undefined && spec.max !== undefined && spec.min > spec.max) {
      throw new PrefabError(`${where}: min (${spec.min}) is above max (${spec.max})`);
    }
    if (kind === "enum") {
      if (!spec.options) throw new PrefabError(`${where}: kind "enum" requires options`);
      if (spec.default !== undefined && !spec.options.includes(spec.default as string | number)) {
        throw new PrefabError(
          `${where}: default ${JSON.stringify(spec.default)} is not one of options ` +
            JSON.stringify(spec.options),
        );
      }
    }
    if (kind === "number" && typeof spec.default === "number") {
      if (spec.min !== undefined && spec.default < spec.min) {
        throw new PrefabError(`${where}: default ${spec.default} is below min ${spec.min}`);
      }
      if (spec.max !== undefined && spec.default > spec.max) {
        throw new PrefabError(`${where}: default ${spec.default} is above max ${spec.max}`);
      }
    }
    for (const binding of spec.bindings) {
      const localId = binding.split("/")[0];
      if (!localId || !(localId in prefab.entities)) {
        throw new PrefabError(
          `${where}: binding "${binding}" does not start with a local entity id`,
        );
      }
    }
  }
}

/** One knob, with its metadata resolved (kind inferred, label defaulted). */
export interface PrefabPropSpec extends Omit<PropSpec, "kind"> {
  name: string;
  kind: PropKind;
  label: string;
}

/** One entity of a prefab definition, flattened for readers. */
export interface PrefabPartSpec {
  id: string;
  name: string;
  parent: string | null;
  depth: number;
  tags: string[];
  components: string[];
}

/**
 * A prefab's public surface: what it is made of (`parts`) and what may be
 * turned without opening it up (`props`). This is the "break it down" view —
 * the thing an agent reads to answer "what can I change about this rifle?"
 * and the thing the editor reads to draw the instance's knob panel. Both
 * consumers derive from one declaration, so they can never disagree.
 */
export interface PrefabSpec {
  name: string;
  root: string;
  parts: PrefabPartSpec[];
  props: PrefabPropSpec[];
  /** Groups in declaration order, for stable inspector section ordering. */
  groups: string[];
}

/** Resolve a prefab definition into its readable/tweakable surface (pure). */
export function describePrefab(prefab: PrefabDoc): PrefabSpec {
  const parts: PrefabPartSpec[] = [];
  const walk = (parent: string | null, depth: number): void => {
    for (const [id, entity] of Object.entries(prefab.entities)) {
      if (entity.parent !== parent) continue;
      parts.push({
        id,
        name: entity.name,
        parent,
        depth,
        tags: [...entity.tags],
        components: Object.keys(entity.components),
      });
      walk(id, depth + 1);
    }
  };
  walk(null, 0);

  const props = Object.entries(prefab.props).map(([name, spec], index) => ({
    ...spec,
    name,
    kind: inferPropKind(spec),
    label: spec.label ?? name,
    order: spec.order ?? index,
  }));
  props.sort((a, b) => (a.group ?? "").localeCompare(b.group ?? "") || a.order - b.order);

  const groups: string[] = [];
  for (const prop of props) {
    const group = prop.group ?? "";
    if (!groups.includes(group)) groups.push(group);
  }

  return { name: prefab.name, root: prefab.root, parts, props, groups };
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

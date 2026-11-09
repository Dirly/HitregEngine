/**
 * Places stream by distance on a client (docs/culling.md "Places stream"). Pure planning half: which parentless
 * places and explicitly opted-in nested rooms of an EXPANDED scene doc stream, what belongs to each (its subtree
 * minus nested boundaries and resident `landmark` subtrees), where its footprint is, and whether a focus wants it
 * built. The host builds the
 * base doc (`base`) at load and each place's `placeDoc` when `placeWanted` says so.
 *
 * The scene doc is untouched: streaming is a runtime decision of the client. A server or headless tool never calls
 * this, so gameplay authority (colliders, anchors, spawns) sees every place.
 */
import { placeStreamSchema, type PlaceStreamData } from "./components/place-stream.js";
import { worldTransforms } from "./math.js";
import type { EntityDoc, SceneDoc } from "./scene.js";

export interface PlaceSpec {
  /** The place root's entity id. */
  id: string;
  /** Every entity that streams with it (root first), resident landmark subtrees excluded. */
  ids: string[];
  /** Entities kept in the base build (landmark subtrees), so the far view keeps the place's silhouette. */
  resident: string[];
  /** Footprint centre (x, z) and radius: owned subtree origins (not the root's own when it has children), padded by footprintPadding. */
  center: [number, number];
  radius: number;
  distance: number;
  keepPadding: number;
}

export interface PlacePlan {
  places: PlaceSpec[];
  /** Full render hierarchy, with nested boundaries and resident landmark roots detached at world TRS. Same object as doc when nothing detaches. */
  render: SceneDoc;
  /** The doc the host builds at load: everything but the streamed entities, resident landmarks re-rooted. */
  base: SceneDoc;
  /** Entity id -> the place it streams with (streamed entities only). */
  placeOf: Map<string, string>;
}

/** Default metres added to a footprint's origin extent; placeStream.footprintPadding can override it. */
export const FOOTPRINT_PAD = 16;

/** Root tags that never stream (moving or per-player things placed at the root). */
const NEVER_STREAM_TAGS = new Set(["player", "spawn", "npc", "world", "water"]);
/** Root components that make an entity scene infrastructure, not a place. */
const NEVER_STREAM_COMPONENTS = ["voxelWorld", "chunkStreamer", "subscene", "sky", "postfx", "camera", "netObject"];

/** Explicit proximity roots may nest; tags alone opt in only parentless roots. Always inherits its enclosing place. */
export function placeStreamOf(entity: EntityDoc): PlaceStreamData | null {
  const tags = entity.tags ?? [];
  if (tags.some((t) => NEVER_STREAM_TAGS.has(t))) return null;
  if (NEVER_STREAM_COMPONENTS.some((c) => c in entity.components)) return null;
  const own = entity.components["placeStream"];
  if (entity.parent !== null && own === undefined) return null;
  const tagged = tags.some((t) => t === "poi" || t.startsWith("poi:") || t.startsWith("town:"));
  if (own === undefined && !tagged) return null;
  const parsed = placeStreamSchema.safeParse(own ?? {});
  const data = parsed.success ? parsed.data : placeStreamSchema.parse({});
  return data.mode === "always" ? null : data;
}

/** Plan an expanded doc's place streaming without mutating it. No streaming preserves both base and render identity. */
export function planPlaceStreaming(doc: SceneDoc): PlacePlan {
  const children = new Map<string, string[]>();
  for (const [id, entity] of Object.entries(doc.entities)) {
    if (entity.parent === null) continue;
    const list = children.get(entity.parent);
    if (list) list.push(id);
    else children.set(entity.parent, [id]);
  }
  const roots: Array<[string, PlaceStreamData]> = [];
  for (const [id, entity] of Object.entries(doc.entities)) {
    const settings = placeStreamOf(entity);
    if (settings) roots.push([id, settings]);
  }
  if (roots.length === 0) return { places: [], render: doc, base: doc, placeOf: new Map() };
  const worlds = worldTransforms(doc);
  const rootIds = new Set(roots.map(([id]) => id));
  let render = doc;
  const detached = (id: string): EntityDoc => {
    const entity = doc.entities[id]!;
    const w = worlds.get(id)!;
    const transform = { ...(entity.components["transform"] as object | undefined), position: [...w.position], rotation: [...w.rotation], scale: [...w.scale] };
    const components: EntityDoc["components"] = { ...entity.components, transform };
    // Re-rooting must not reveal a subtree hidden by any authored ancestor.
    for (let at: string | null = id; at; at = doc.entities[at]!.parent) {
      if ((doc.entities[at]!.components["visibility"] as { visible?: boolean } | undefined)?.visible === false) {
        components["visibility"] = { ...(entity.components["visibility"] as object | undefined), visible: false };
        break;
      }
    }
    return { ...entity, parent: null, components };
  };
  for (const [id] of roots) {
    if (doc.entities[id]!.parent === null) continue;
    if (render === doc) render = { ...doc, entities: { ...doc.entities } };
    render.entities[id] = detached(id);
  }
  const places: PlaceSpec[] = [];
  const placeOf = new Map<string, string>();
  const residentRoots = new Set<string>();
  for (const [rootId, settings] of roots) {
    const ids: string[] = [];
    const resident: string[] = [];
    let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity;
    const walk = (id: string, keep: boolean): void => {
      // Boundary ownership wins over landmark residency, including deeper rooms
      // beneath an always-resident shell. Each entity belongs to at most one place.
      if (id !== rootId && rootIds.has(id)) return;
      const entity = doc.entities[id]!;
      // a landmark subtree stays built: the far view keeps the place's hero silhouette (and any portal under it)
      const isLandmark = !keep && id !== rootId && "landmark" in entity.components;
      if (isLandmark) residentRoots.add(id);
      const residentHere = keep || isLandmark;
      (residentHere ? resident : ids).push(id);
      // the root's own origin is not footprint when it has children (a dressing root sits at the world origin)
      const p = id === rootId && children.has(id) ? undefined : worlds.get(id)?.position;
      if (p) {
        minX = Math.min(minX, p[0]); maxX = Math.max(maxX, p[0]);
        minZ = Math.min(minZ, p[2]); maxZ = Math.max(maxZ, p[2]);
      }
      for (const child of children.get(id) ?? []) walk(child, residentHere);
    };
    walk(rootId, false);
    if (minX === Infinity) {
      const p = worlds.get(rootId)?.position ?? [0, 0, 0];
      minX = maxX = p[0]; minZ = maxZ = p[2];
    }
    const cx = (minX + maxX) / 2, cz = (minZ + maxZ) / 2;
    const radius = Math.hypot(maxX - minX, maxZ - minZ) / 2 + settings.footprintPadding;
    for (const id of ids) placeOf.set(id, rootId);
    places.push({ id: rootId, ids, resident, center: [cx, cz], radius, distance: settings.distance, keepPadding: settings.keepPadding });
  }
  // Reconciliation must see the same world-rooted landmarks as the base build,
  // otherwise an authored parent move would restore their old local transform.
  for (const id of residentRoots) {
    if (render === doc) render = { ...doc, entities: { ...doc.entities } };
    render.entities[id] = detached(id);
  }
  const entities: SceneDoc["entities"] = {};
  for (const [id, entity] of Object.entries(render.entities)) {
    if (placeOf.has(id)) continue;
    entities[id] = entity;
  }
  return { places, render, base: { ...render, entities }, placeOf };
}

/** Build from plan.render: streamed entities only, ids unchanged, nested roots already detached at world TRS. */
export function placeDoc(doc: SceneDoc, spec: PlaceSpec): SceneDoc {
  const entities: SceneDoc["entities"] = {};
  for (const id of spec.ids) {
    const entity = doc.entities[id];
    if (entity) entities[id] = entity;
  }
  return { ...doc, entities };
}

/** Distance from (fx, fz) to the place's footprint edge (0 inside it). */
export function placeEdgeDistance(spec: PlaceSpec, fx: number, fz: number): number {
  return Math.max(0, Math.hypot(fx - spec.center[0], fz - spec.center[1]) - spec.radius);
}

/** Should the place be built for this focus? `loaded` applies the hysteresis (free only past distance + keepPadding). */
export function placeWanted(spec: PlaceSpec, loaded: boolean, fx: number, fz: number): boolean {
  const d = placeEdgeDistance(spec, fx, fz);
  return loaded ? d <= spec.distance + spec.keepPadding : d <= spec.distance;
}

/** The hide-distance buckets placed props merge into (one culling unit per bucket per batch cell). */
export const PROP_HIDE_BUCKETS = [30, 60, 100, 160] as const;
/** Props larger than this (max extent, metres) never hide by distance: they carry the place's silhouette. */
export const PROP_HIDE_MAX_SIZE = 3.5;
const CATEGORY_HIDE_FACTOR: Record<string, number> = { tableware: 0.7, document: 0.7, tool: 0.8, decor: 0.9, sacred: 1.4, street: 1.3 };

/**
 * How far from a placed copy of a catalogued prop the client still draws it (docs/culling.md "Props hide by size"),
 * from its `dressing` data: an explicit `hideDistance` wins; else ~45 m per metre of its largest extent, scaled by
 * category, snapped UP to a bucket. Null = never hides (big props, "never", or no size).
 */
export function propHideDistance(dressing: { size?: readonly number[]; category?: string; hideDistance?: number | "never" } | undefined): number | null {
  if (!dressing) return null;
  if (dressing.hideDistance === "never") return null;
  if (typeof dressing.hideDistance === "number") return dressing.hideDistance;
  const extent = Math.max(0, ...(dressing.size ?? []));
  if (!(extent > 0) || extent > PROP_HIDE_MAX_SIZE) return null;
  const want = extent * 45 * (CATEGORY_HIDE_FACTOR[dressing.category ?? ""] ?? 1);
  return PROP_HIDE_BUCKETS.find((b) => b >= want) ?? null;
}

/**
 * Entity id -> hide distance for every entity under a catalogued prop root (its nearest `dressing` ancestor), in an
 * expanded doc. Overrides: a `culling` component on the prop (or inside it) replaces the auto hide there; anything
 * under a `landmark` never auto-hides. A dressing room's own `culling` (above the prop) does not stop it.
 */
export function propHideIndex(doc: SceneDoc): Map<string, number> {
  const memo = new Map<string, number | null>();
  const of = (id: string): number | null => {
    const known = memo.get(id);
    if (known !== undefined) return known;
    const entity = doc.entities[id];
    let value: number | null = null;
    if (entity && !("culling" in entity.components) && !("landmark" in entity.components)) {
      const dressing = entity.components["dressing"] as Parameters<typeof propHideDistance>[0];
      value = dressing ? propHideDistance(dressing) : entity.parent ? of(entity.parent) : null;
      // a prop inside a hiding prop keeps the nearer hide only if the ancestor allows hiding at all
      if (dressing && value !== null && entity.parent && blocked(entity.parent)) value = null;
    }
    memo.set(id, value);
    return value;
  };
  const blocked = (id: string): boolean => {
    for (let at: string | null | undefined = id; at; at = doc.entities[at]?.parent) {
      if (doc.entities[at] && "landmark" in doc.entities[at]!.components) return true;
    }
    return false;
  };
  const out = new Map<string, number>();
  for (const id of Object.keys(doc.entities)) {
    const v = of(id);
    if (v !== null) out.set(id, v);
  }
  return out;
}

/** No prop out of doors appears nearer than this: a porch's stool popped in at 30 m in plain view. Rooms hide theirs behind walls. */
export const OUTDOOR_PROP_MIN_REVEAL = 100;

/**
 * Entity id -> the distance a prop is actually drawn out to: propHideIndex, raised to OUTDOOR_PROP_MIN_REVEAL out of doors.
 * A prop's SIZE still decides its shadow (shadowlessEntities reads propHideIndex), so a cup on a porch stays shadowless.
 * An explicit `hideDistance` is an author's call and stands.
 */
export function propRevealIndex(doc: SceneDoc, hide: ReadonlyMap<string, number> = propHideIndex(doc)): Map<string, number> {
  const indoors = new Map<string, boolean>();
  const inside = (id: string | null | undefined): boolean => {
    if (!id) return false;
    const known = indoors.get(id);
    if (known !== undefined) return known;
    const entity = doc.entities[id];
    const culling = entity?.components["culling"] as { interior?: boolean } | undefined;
    const value = !!entity && (culling?.interior === true || inside(entity.parent));
    indoors.set(id, value);
    return value;
  };
  const authored = (id: string): boolean => {
    for (let at: string | null | undefined = id; at; at = doc.entities[at]?.parent) {
      const dressing = doc.entities[at]?.components["dressing"] as { hideDistance?: unknown } | undefined;
      if (dressing) return typeof dressing.hideDistance === "number";
    }
    return false;
  };
  const out = new Map<string, number>();
  for (const [id, reveal] of hide) out.set(id, inside(id) || authored(id) ? reveal : Math.max(reveal, OUTDOOR_PROP_MIN_REVEAL));
  return out;
}

/** Props that hide at or nearer than this (the 30 m bucket: tableware, small pots) cast no shadow. */
export const PROP_SHADOW_MIN_HIDE = 30;

/**
 * Entities whose meshes need not cast shadows (docs/culling.md "Shadow casters"). Every caster is drawn again in
 * each shadow cascade it falls in, so a town's clutter cost ~3x its main-pass draws in shadows alone:
 * - furnishings under a `culling.interior` unit: the house shell already shades its interior from the sun.
 *   Skipped in an interior scene (a `cullingProfile`, a dungeon): there the room lights are all there is.
 * - small props (hide distance <= PROP_SHADOW_MIN_HIDE): a cup's shadow is a few texels.
 * A `mesh.castShadow` the author left on is otherwise kept.
 */
export function shadowlessEntities(doc: SceneDoc, hide: ReadonlyMap<string, number> = propHideIndex(doc)): Set<string> {
  const out = new Set<string>();
  for (const [id, reveal] of hide) if (reveal <= PROP_SHADOW_MIN_HIDE) out.add(id);
  const interiorScene = Object.values(doc.entities).some((e) => "cullingProfile" in e.components);
  if (interiorScene) return out;
  const memo = new Map<string, boolean>();
  const inside = (id: string | null | undefined): boolean => {
    if (!id) return false;
    const known = memo.get(id);
    if (known !== undefined) return known;
    const entity = doc.entities[id];
    const culling = entity?.components["culling"] as { interior?: boolean } | undefined;
    const value = !!entity && (culling?.interior === true || inside(entity.parent));
    memo.set(id, value);
    return value;
  };
  for (const id of Object.keys(doc.entities)) if (inside(id)) out.add(id);
  return out;
}

/** A room's light: the structure enclosing it and the `culling.interior` room it stands in. */
export interface InteriorEnclosure {
  structure: string;
  room: string;
}

/**
 * Light entity id -> the structure enclosing it (the parent of its nearest `culling.interior` root: a dressed room's
 * house) and that room. The renderer holds such a light to the structure's box above the room's floor, so a room's
 * lamp lights nothing outside the building it stands in (render light-confine.ts: a point light without a shadow map
 * otherwise lights the street through the wall). Skipped in an interior scene (a `cullingProfile`, a dungeon): there
 * the rooms are the whole world.
 */
export function interiorEnclosures(doc: SceneDoc): Map<string, InteriorEnclosure> {
  const out = new Map<string, InteriorEnclosure>();
  if (Object.values(doc.entities).some((e) => "cullingProfile" in e.components)) return out;
  const memo = new Map<string, InteriorEnclosure | null>();
  const enclosure = (id: string | null | undefined): InteriorEnclosure | null => {
    if (!id) return null;
    const known = memo.get(id);
    if (known !== undefined) return known;
    const entity = doc.entities[id];
    const culling = entity?.components["culling"] as { interior?: boolean } | undefined;
    let value: InteriorEnclosure | null = null;
    if (entity && culling?.interior === true) value = entity.parent && doc.entities[entity.parent] ? { structure: entity.parent, room: id } : null;
    else if (entity) value = enclosure(entity.parent);
    memo.set(id, value);
    return value;
  };
  for (const [id, entity] of Object.entries(doc.entities)) {
    if (!("light" in entity.components)) continue;
    const found = enclosure(id);
    if (found) out.set(id, found);
  }
  return out;
}

import { z } from "zod";
import { entityDocSchema, type SceneDoc } from "./scene.js";
import type { ComponentRegistry } from "./components/registry.js";
import type { Quat, Vec3 } from "./math.js";

/**
 * Chunk streaming: large worlds split into grid-cell files that load and
 * unload by distance to a focus point (the player in play mode, the editor
 * camera in edit mode).
 *
 * Chunks are DATA, not scene state: each chunk is a JSON file of entities in
 * the same format scene docs use (`assets/chunks/<world>/<cx>_<cz>.chunk.json`,
 * grid coords in the filename). Loaded chunk content is injected into the
 * RUNTIME only — the authored scene document never contains chunk entities,
 * so autosave, undo, and diffs stay clean. Editing a chunk file while it is
 * loaded hot-swaps that chunk in place (same live-sync path as scenes).
 */

/** A chunk file: entities keyed by id, positions LOCAL to the chunk origin. */
export const chunkDocSchema = z.object({
  version: z.literal(1),
  entities: z.record(z.string(), entityDocSchema),
});

export type ChunkDoc = z.infer<typeof chunkDocSchema>;

/**
 * Scene component that opts into streaming a chunk world. Lives on any entity
 * (conventionally a root "world" entity); one per scene (first wins).
 */
export const chunkStreamerSchema = z.object({
  /** World folder under assets/chunks/ that holds the *.chunk.json cells. */
  source: z.string().min(1),
  /** World-units width of one square chunk cell. */
  cellSize: z.number().positive().default(16),
  /** Load every cell whose center is within this many cells of the focus. */
  radius: z.number().min(1).max(16).default(2),
  /** Extra cells beyond radius to keep alive before unloading (hysteresis). */
  keepPadding: z.number().min(0).max(8).default(1),
  /**
   * Distance-based level-of-detail rings, in CELLS from the focus (see §4 of
   * docs/open-world-streaming-plan.md). Each cell renders at the highest-detail
   * ring it falls inside: within `simulation` it is fully simulated; out to
   * `fullRender` it renders without physics/scripts; out to `hlod` it is a
   * merged low-detail proxy; out to `farTerrain` a coarse far proxy; beyond
   * that, unloaded. Omit to keep the legacy binary behavior (load within
   * `radius`, else unloaded). Values need not be ordered — they are clamped
   * non-decreasing at resolve time.
   */
  rings: z
    .object({
      simulation: z.number().min(0).default(2),
      fullRender: z.number().min(0).default(3),
      hlod: z.number().min(0).default(10),
      farTerrain: z.number().min(0).default(32),
    })
    .optional(),
});

export type ChunkStreamerData = z.infer<typeof chunkStreamerSchema>;

export function registerChunkComponents(registry: ComponentRegistry): void {
  registry.register("chunkStreamer", chunkStreamerSchema);
  registry.register("subscene", subsceneSchema);
}

/** Grid coords encoded in a chunk filename: "3_-2.chunk.json" -> [3, -2]. */
export function parseChunkCoords(file: string): [number, number] | null {
  const m = /(-?\d+)_(-?\d+)\.chunk\.json$/.exec(file);
  if (!m) return null;
  return [Number(m[1]), Number(m[2])];
}

export function chunkFileName(cx: number, cz: number): string {
  return `${cx}_${cz}.chunk.json`;
}

/**
 * A loaded chunk becomes a SceneDoc fragment whose entities are prefixed with
 * the chunk key (collision-proof across chunks and against scene entities) and
 * re-rooted onto a synthetic chunk-origin entity placed at the cell's world
 * position. The result feeds the same expand/build/physics pipeline as scenes.
 */
export function chunkToSceneDoc(
  world: string,
  cx: number,
  cz: number,
  cellSize: number,
  chunk: ChunkDoc,
): { doc: SceneDoc; rootId: string } {
  const key = `__chunk:${world}:${cx}_${cz}`;
  const entities: SceneDoc["entities"] = {
    [key]: {
      name: key,
      parent: null,
      tags: ["chunk"],
      components: {
        transform: { position: [cx * cellSize, 0, cz * cellSize] },
      },
    },
  };
  for (const [id, entity] of Object.entries(chunk.entities)) {
    entities[`${key}/${id}`] = {
      ...entity,
      parent: entity.parent === null ? key : `${key}/${entity.parent}`,
    };
  }
  return { doc: { version: 1, name: key, entities }, rootId: key };
}

// -- chunk-local <-> world transforms + cross-cell moves ---------------------
//
// A chunk cell's synthetic origin sits at [cx*cellSize, 0, cz*cellSize] with no
// rotation or scale (see chunkToSceneDoc), so a top-level chunk entity's world
// position is simply its local position plus that origin. That makes moving an
// entity between cells a pure translation of its local coordinates — no matrix
// math — which is exactly the atomic multi-document edit the streaming plan's
// virtual world hierarchy needs (remove from one chunk file, add to another,
// convert the transform to the destination cell's local space).

/** World-space position of a chunk cell's origin. Cells only translate. */
export function chunkOrigin(cx: number, cz: number, cellSize: number): Vec3 {
  return [cx * cellSize, 0, cz * cellSize];
}

/** A position local to cell (cx,cz) expressed in world space. */
export function chunkLocalToWorld(local: Vec3, cx: number, cz: number, cellSize: number): Vec3 {
  const o = chunkOrigin(cx, cz, cellSize);
  return [local[0] + o[0], local[1] + o[1], local[2] + o[2]];
}

/** A world-space position expressed local to cell (cx,cz). */
export function worldToChunkLocal(world: Vec3, cx: number, cz: number, cellSize: number): Vec3 {
  const o = chunkOrigin(cx, cz, cellSize);
  return [world[0] - o[0], world[1] - o[1], world[2] - o[2]];
}

/** One chunk cell: its grid coords and its (source) document. */
export interface ChunkCell {
  cx: number;
  cz: number;
  doc: ChunkDoc;
}

export interface ChunkMoveResult {
  /** The source chunk with the moved entity + its subtree removed. */
  source: ChunkDoc;
  /** The destination chunk with the entity added, root re-localized. */
  dest: ChunkDoc;
  /** Ids that moved (the entity and every descendant), in the order removed. */
  moved: string[];
}

type ChunkEntities = ChunkDoc["entities"];

/** The entity and every transitive descendant within one chunk. */
function collectSubtree(entities: ChunkEntities, rootId: string): string[] {
  const out = [rootId];
  for (let i = 0; i < out.length; i++) {
    const parent = out[i]!;
    for (const [id, e] of Object.entries(entities)) {
      if (e.parent === parent && !out.includes(id)) out.push(id);
    }
  }
  return out;
}

/** A chunk entity's local position, defaulting to origin when unset. */
function localPosition(entity: ChunkEntities[string]): Vec3 {
  const p = (entity.components["transform"] as { position?: Vec3 } | undefined)?.position;
  return Array.isArray(p) && p.length === 3 ? [p[0], p[1], p[2]] : [0, 0, 0];
}

/**
 * Move a top-level chunk entity (and its whole subtree) from one cell file to
 * another, converting the root's transform to the destination cell's local
 * space so its WORLD position is preserved. Ids are stable across the move.
 *
 * Pure and atomic: it never mutates the inputs and returns `{ error }` — with
 * both source documents left untouched — for anything it can't do safely
 * (unknown id, a NESTED entity whose world transform would need its parent
 * chain baked, an id already present in the destination, or output that fails
 * validation). Callers write both files only on success, so an invalid move
 * writes nothing.
 */
export function moveEntityAcrossChunks(
  entityId: string,
  source: ChunkCell,
  dest: ChunkCell,
  cellSize: number,
): ChunkMoveResult | { error: string } {
  const srcEntities = source.doc.entities;
  const entity = srcEntities[entityId];
  if (!entity) {
    return { error: `entity "${entityId}" is not in source chunk ${source.cx}_${source.cz}` };
  }
  if (entity.parent != null) {
    return {
      error: `entity "${entityId}" is nested under "${entity.parent}"; only top-level chunk entities move across cells (unpack or reparent to the chunk root first)`,
    };
  }
  const subtree = collectSubtree(srcEntities, entityId);
  for (const id of subtree) {
    if (dest.doc.entities[id]) {
      return { error: `id "${id}" already exists in dest chunk ${dest.cx}_${dest.cz}` };
    }
  }

  // build both documents on copies — inputs stay pristine on any later failure
  const nextSource: ChunkDoc = { version: 1, entities: {} };
  for (const [id, e] of Object.entries(srcEntities)) {
    if (!subtree.includes(id)) nextSource.entities[id] = structuredClone(e);
  }
  const nextDest: ChunkDoc = { version: 1, entities: structuredClone(dest.doc.entities) };
  for (const id of subtree) nextDest.entities[id] = structuredClone(entity && srcEntities[id]!);

  // re-localize the moved ROOT: same world position, destination-local coords
  const world = chunkLocalToWorld(localPosition(entity), source.cx, source.cz, cellSize);
  const newLocal = worldToChunkLocal(world, dest.cx, dest.cz, cellSize);
  const root = nextDest.entities[entityId]!;
  root.components = {
    ...root.components,
    transform: { ...(root.components["transform"] as object), position: newLocal },
  };

  const a = chunkDocSchema.safeParse(nextSource);
  const b = chunkDocSchema.safeParse(nextDest);
  if (!a.success || !b.success) return { error: "resulting chunk document failed validation" };
  return { source: a.data, dest: b.data, moved: subtree };
}

// -- distance-based representation state machine (LOD rings) ------------------
//
// The runtime keeps each cell at a representation matched to its distance from
// the focus, upgrading detail as you approach and shedding it as you leave —
// the streaming plan's `unloaded -> far -> hlod -> fullRender -> simulation`
// ladder (§4). This is the pure decision core: given the focus and the last
// states, it returns each cell's new state. Hysteresis (a dead-band of
// `keepPadding` cells on the way OUT) keeps a cell hovering on a ring boundary
// from thrashing between two representations. The renderer/streamer consumes
// the diff of two results to know what to build, demote, or drop.

/** A cell's representation, most detail to least; absent from the map = unloaded. */
export type ChunkRep = "simulation" | "fullRender" | "hlod" | "far";

const REP_LEVEL: Record<ChunkRep, number> = { far: 1, hlod: 2, fullRender: 3, simulation: 4 };
const LEVEL_REP: readonly (ChunkRep | null)[] = [null, "far", "hlod", "fullRender", "simulation"];

interface ResolvedRings {
  simulation: number;
  fullRender: number;
  hlod: number;
  farTerrain: number;
  padding: number;
}

/**
 * Concrete ring radii (cells) for a streamer. With `rings` set they are used
 * as-is but clamped non-decreasing (simulation <= fullRender <= hlod <=
 * farTerrain); without it, every ring collapses to `radius`, reproducing the
 * legacy binary "loaded within radius, else unloaded" behavior exactly.
 */
export function resolveChunkRings(config: ChunkStreamerData): ResolvedRings {
  const padding = config.keepPadding;
  if (config.rings) {
    const simulation = config.rings.simulation;
    const fullRender = Math.max(config.rings.fullRender, simulation);
    const hlod = Math.max(config.rings.hlod, fullRender);
    const farTerrain = Math.max(config.rings.farTerrain, hlod);
    return { simulation, fullRender, hlod, farTerrain, padding };
  }
  const r = config.radius;
  return { simulation: r, fullRender: r, hlod: r, farTerrain: r, padding };
}

/** Detail level (0=unloaded..4=simulation) for a cell `d` cells away, with `extra` slack on every ring. */
function levelByDistance(d: number, rings: ResolvedRings, extra: number): number {
  if (d <= rings.simulation + extra) return 4;
  if (d <= rings.fullRender + extra) return 3;
  if (d <= rings.hlod + extra) return 2;
  if (d <= rings.farTerrain + extra) return 1;
  return 0;
}

/**
 * Every cell's representation for a focus at world (x,z), given its previous
 * states (pass an empty map on the first call). Only non-unloaded cells appear
 * in the result — a key present in `prev` but absent here has unloaded.
 *
 * Upgrades apply immediately at a ring boundary; downgrades wait until the cell
 * is `keepPadding` cells beyond the boundary, so a cell parked on a ring holds
 * its representation instead of flickering.
 */
export function computeChunkStates(
  focus: { x: number; z: number },
  config: ChunkStreamerData,
  prev: ReadonlyMap<string, ChunkRep>,
): Map<string, ChunkRep> {
  const rings = resolveChunkRings(config);
  const fcx = Math.round(focus.x / config.cellSize);
  const fcz = Math.round(focus.z / config.cellSize);
  const reach = Math.ceil(rings.farTerrain + rings.padding);

  const candidates = new Set<string>(prev.keys());
  for (let dz = -reach; dz <= reach; dz++) {
    for (let dx = -reach; dx <= reach; dx++) candidates.add(chunkKey(fcx + dx, fcz + dz));
  }

  const out = new Map<string, ChunkRep>();
  for (const key of candidates) {
    const coords = parseChunkKey(key);
    if (!coords) continue;
    const d = Math.hypot(coords[0] - fcx, coords[1] - fcz);
    const prevLevel = REP_LEVEL[prev.get(key) as ChunkRep] ?? 0;
    const rising = levelByDistance(d, rings, 0);
    // rising/steady snaps up immediately; falling holds until beyond the pad
    const level =
      rising >= prevLevel ? rising : Math.min(prevLevel, levelByDistance(d, rings, rings.padding));
    const rep = LEVEL_REP[level];
    if (rep) out.set(key, rep);
  }
  return out;
}

/** Grid key for a cell, matching the `<cx>_<cz>` filename convention. */
export function chunkKey(cx: number, cz: number): string {
  return `${cx}_${cz}`;
}

// -- partitioning a flat scene into chunk cells ------------------------------
//
// The inverse of streaming: take a scene authored in one file and split its
// SPATIAL content into per-cell chunk documents (streaming plan §5's "Partition
// Scene"), leaving global/non-spatial entities — cameras, sky, postfx, session
// managers, the streamer itself — in the scene. Each spatial top-level entity
// (with its whole subtree) is routed to the cell containing its world origin
// and its root transform rebased to that cell's local space, so nothing visibly
// moves and world positions round-trip. Pure: callers write the files only
// after inspecting the result. Cross-entity references by GUID (e.g. a joint
// target) are left as-is — resolving them across cells needs a deferred-
// resolution component, per §3 of the plan.

/** Components that keep a top-level entity in the scene (not chunked). */
export const DEFAULT_GLOBAL_COMPONENTS = [
  "camera",
  "sky",
  "postfx",
  "chunkStreamer",
  "subscene",
] as const;

export interface PartitionOptions {
  /** Cell size (world units) — must match the streamer that will load the chunks. */
  cellSize: number;
  /**
   * Classify a TOP-LEVEL entity as global (kept in the scene) vs spatial (moved
   * into a chunk). Default: global if it has no `transform`, or carries any of
   * DEFAULT_GLOBAL_COMPONENTS.
   */
  isGlobal?: (id: string, entity: SceneDoc["entities"][string]) => boolean;
}

export interface PartitionResult {
  /** The residual scene: global/non-spatial entities and their subtrees. */
  scene: SceneDoc;
  /** Spatial content keyed by cell ("cx_cz"), root transforms rebased to cell-local. */
  chunks: Map<string, ChunkDoc>;
  /** Non-fatal notes (e.g. a spatial entity with no position → cell 0,0). */
  warnings: string[];
}

function isGlobalByDefault(entity: SceneDoc["entities"][string]): boolean {
  if (!("transform" in entity.components)) return true;
  return DEFAULT_GLOBAL_COMPONENTS.some((c) => c in entity.components);
}

/** Split a scene's spatial entities into chunk cells; keep globals in the scene. */
export function partitionScene(scene: SceneDoc, options: PartitionOptions): PartitionResult {
  const classify = options.isGlobal ?? ((_id, e) => isGlobalByDefault(e));
  const entities = scene.entities;
  const warnings: string[] = [];
  const sceneEntities: SceneDoc["entities"] = {};
  const chunks = new Map<string, ChunkDoc>();

  for (const [id, entity] of Object.entries(entities)) {
    if (entity.parent != null) continue; // a subtree travels with its top-level root
    const subtree = collectSubtree(entities, id);

    if (classify(id, entity)) {
      for (const sid of subtree) sceneEntities[sid] = structuredClone(entities[sid]!);
      continue;
    }

    const transform = entity.components["transform"] as { position?: Vec3 } | undefined;
    if (!Array.isArray(transform?.position)) {
      warnings.push(`spatial entity "${id}" has no transform position; routed to cell 0_0`);
    }
    const pos = localPosition(entity);
    const cx = Math.round(pos[0] / options.cellSize);
    const cz = Math.round(pos[2] / options.cellSize);
    const key = chunkKey(cx, cz);

    let chunk = chunks.get(key);
    if (!chunk) {
      chunk = { version: 1, entities: {} };
      chunks.set(key, chunk);
    }
    for (const sid of subtree) chunk.entities[sid] = structuredClone(entities[sid]!);
    // rebase only the ROOT to cell-local; descendants stay local to their parent
    const root = chunk.entities[id]!;
    root.components = {
      ...root.components,
      transform: {
        ...(root.components["transform"] as object),
        position: worldToChunkLocal(pos, cx, cz, options.cellSize),
      },
    };
  }

  return {
    scene: { version: scene.version, name: scene.name, entities: sceneEntities },
    chunks,
    warnings,
  };
}

/** Inverse of chunkKey; null for anything not two integers around one underscore. */
export function parseChunkKey(key: string): [number, number] | null {
  const m = /^(-?\d+)_(-?\d+)$/.exec(key);
  return m ? [Number(m[1]), Number(m[2])] : null;
}

/**
 * Subscenes: whole scene FILES as additive, streamable modules (micro-scenes).
 * A world scene places named scenes — villages, dungeons, UI layers — as
 * one-line entities; the runtime loads/unloads them like chunks. The scene
 * file stays a normal scene: open it from the picker and press play to test
 * it in isolation. Same runtime-only rules as chunks: composed content never
 * enters the world doc, and editing the subscene file hot-swaps every loaded
 * instance.
 */
export const subsceneSchema = z.object({
  /** Scene name (assets/scenes/<scene>.scene.json), sans extension. */
  scene: z.string().min(1),
  /** always = resident while the world is open; proximity = streamed by distance. */
  mode: z.enum(["always", "proximity"]).default("proximity"),
  /** proximity mode: load when the focus is within this world-unit radius. */
  radius: z.number().positive().default(75),
  /** Extra distance beyond radius before unloading (hysteresis). */
  keepPadding: z.number().min(0).default(15),
});

export type SubsceneData = z.infer<typeof subsceneSchema>;

/**
 * Components that only make sense when a scene runs standalone (its authoring
 * preview environment) — stripped when it loads as a subscene so the world's
 * own sky/postfx aren't fought over. Nested `subscene` is stripped too (no
 * recursive streaming in v1).
 */
const SUBSCENE_STRIPPED_COMPONENTS = ["sky", "postfx", "subscene"] as const;

/**
 * A loaded subscene becomes a SceneDoc fragment: ids prefixed with the
 * placing entity's id (so one scene can be placed many times), re-rooted onto
 * a synthetic origin carrying the instance's WORLD transform.
 */
export function subsceneToSceneDoc(
  instanceId: string,
  world: { position: Vec3; rotation: Quat; scale: Vec3 },
  scene: SceneDoc,
): { doc: SceneDoc; rootId: string; stripped: string[] } {
  const key = `__sub:${instanceId}`;
  const stripped: string[] = [];
  const entities: SceneDoc["entities"] = {
    [key]: {
      name: key,
      parent: null,
      tags: ["subscene"],
      components: {
        transform: {
          position: [...world.position],
          rotation: [...world.rotation],
          scale: [...world.scale],
        },
      },
    },
  };
  for (const [id, entity] of Object.entries(scene.entities)) {
    const components = { ...entity.components };
    for (const name of SUBSCENE_STRIPPED_COMPONENTS) {
      if (name in components) {
        delete components[name];
        stripped.push(`${id}.${name}`);
      }
    }
    entities[`${key}/${id}`] = {
      ...entity,
      components,
      parent: entity.parent === null ? key : `${key}/${entity.parent}`,
    };
  }
  return { doc: { version: 1, name: key, entities }, rootId: key, stripped };
}

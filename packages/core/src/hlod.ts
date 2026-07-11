import type { SceneDoc, EntityDoc } from "./scene.js";
import type { ComponentRegistry } from "./components/registry.js";
import type { AssetLibrary } from "./assets.js";
import type { Vec3, WorldTransform } from "./math.js";
import { worldTransforms } from "./math.js";
import { expandScene } from "./prefab.js";
import { chunkToSceneDoc, chunkKey, type ChunkCell } from "./chunks.js";

/**
 * Static HLOD generation (open-world-streaming-plan §7 / Phase E), headless core.
 *
 * The `hlod` and `far` rings render distant chunks CHEAPLY: their many static
 * entities collapse into a handful of merged "supercell" meshes with no
 * scripts, physics, or authoritative state. This module is the pure, headless
 * half of that bake — everything that can run in Node with no Three.js:
 *
 *   1. Group authoring cells into HLOD supercells (a supercell spans an
 *      NxN block of cells — §7 "sixteen 160m cells -> one 640m supercell").
 *   2. Assemble a "build document": expand prefabs, pick only eligible STATIC
 *      render entities, and flatten each to a parentless entity carrying its
 *      full world transform rebased to supercell-local space (§7 steps 1-4).
 *   3. Collect the dependency chain (prefabs -> models -> materials -> textures,
 *      §6) and a coarse bounds (§7 step 8).
 *   4. Derive a content-hash cache key over every input that can change the
 *      bake (§8 / §13 "dependency hashes change for every relevant input").
 *
 * The geometry ops that need real meshes — grouping by material, instancing,
 * merging, simplification (§7 steps 3/5/6/7) — consume this build doc in the
 * render layer, where Three.js lives. Keeping this half headless makes it unit
 * testable and lets the eventual bake worker share it.
 */

// -- supercell geometry ------------------------------------------------------

/** The authoring cell (cx,cz) belongs to this supercell, given `factor` cells/edge. */
export function supercellForCell(cx: number, cz: number, factor: number): [number, number] {
  return [Math.floor(cx / factor), Math.floor(cz / factor)];
}

/**
 * World-space origin of a supercell: the origin of its minimum-corner authoring
 * cell. Baked geometry is expressed relative to this point so supercell-local
 * coordinates stay small.
 */
export function supercellOrigin(
  scx: number,
  scz: number,
  cellSize: number,
  factor: number,
): Vec3 {
  return [scx * factor * cellSize, 0, scz * factor * cellSize];
}

/** Group cells by the supercell that owns them (key "scx_scz"). */
export function groupCellsBySupercell(
  cells: readonly ChunkCell[],
  factor: number,
): Map<string, ChunkCell[]> {
  const out = new Map<string, ChunkCell[]>();
  for (const cell of cells) {
    const [scx, scz] = supercellForCell(cell.cx, cell.cz, factor);
    const key = chunkKey(scx, scz);
    const bucket = out.get(key);
    if (bucket) bucket.push(cell);
    else out.set(key, [cell]);
  }
  return out;
}

// -- static-render eligibility -----------------------------------------------

/**
 * Components whose presence means an entity can MOVE or change at runtime, so
 * neither it nor anything parented under it can be baked into a static mesh.
 * (A `rigidbody` is dynamic unless its kind is "static" — checked separately.)
 */
const DYNAMIC_MARKERS = ["script", "netObject", "animator"] as const;

/** True if `entity` (or a static-baked ancestor) can move/animate at runtime. */
function isDynamic(entity: EntityDoc): boolean {
  for (const marker of DYNAMIC_MARKERS) {
    if (marker in entity.components) return true;
  }
  const rb = entity.components["rigidbody"] as { kind?: string } | undefined;
  return rb != null && rb.kind !== "static";
}

/**
 * Whether an entity is an eligible static render entity for HLOD merge: it has
 * renderable geometry (a `mesh` that is not terrain — heightmaps belong to the
 * terrain LOD pyramid, §7) and it is not itself dynamic. Ancestor dynamism is
 * checked during assembly, where the full tree is available.
 */
export function isStaticRenderEntity(entity: EntityDoc): boolean {
  const mesh = entity.components["mesh"] as { source?: { kind?: string } } | undefined;
  if (!mesh) return false;
  if (mesh.source?.kind === "heightmap") return false;
  return !isDynamic(entity);
}

/** Walk parent chain in a doc; true if any ancestor is dynamic. */
function hasDynamicAncestor(doc: SceneDoc, id: string): boolean {
  let parent = doc.entities[id]?.parent ?? null;
  const seen = new Set<string>();
  while (parent !== null && !seen.has(parent)) {
    seen.add(parent);
    const entity = doc.entities[parent];
    if (!entity) break;
    if (isDynamic(entity)) return true;
    parent = entity.parent;
  }
  return false;
}

// -- build-doc assembly ------------------------------------------------------

/** The dependency chain a supercell bake reads (§6), sorted & de-duplicated. */
export interface HlodDependencies {
  prefabs: string[];
  models: string[];
  materials: string[];
  textures: string[];
}

export interface HlodBuildResult {
  scx: number;
  scz: number;
  /** World-space origin baked geometry is relative to. */
  origin: Vec3;
  /**
   * Flattened static entities in supercell-local space. Each is parentless and
   * carries its full world transform (rebased to `origin`) plus its `mesh`
   * component — ready for the render layer to group and merge.
   */
  doc: SceneDoc;
  /** Coarse AABB over baked entity origins, supercell-local. Null if empty. */
  bounds: { min: Vec3; max: Vec3 } | null;
  deps: HlodDependencies;
  /** Non-fatal notes (skipped-because-dynamic, unparsable cell, etc.). */
  warnings: string[];
}

export interface AssembleHlodOptions {
  /** World-units per authoring cell edge — must match the streamer. */
  cellSize: number;
  /** Authoring cells per supercell edge (e.g. 4 -> a 4x4=16-cell supercell). */
  factor: number;
  /** World folder name, used to key the synthetic chunk roots. */
  world: string;
  assets: AssetLibrary;
  registry: ComponentRegistry;
}

/**
 * Assemble the static HLOD build document for one supercell from the authoring
 * cells that fall inside it. Prefabs are expanded, dynamic entities (and static
 * geometry parented under something dynamic) dropped, and every survivor
 * flattened to supercell-local space. Pure: inputs are never mutated. An
 * unparsable / un-expandable cell is skipped with a warning rather than
 * failing the whole supercell.
 */
export function assembleHlodBuildDoc(
  scx: number,
  scz: number,
  cells: readonly ChunkCell[],
  opts: AssembleHlodOptions,
): HlodBuildResult {
  const origin = supercellOrigin(scx, scz, opts.cellSize, opts.factor);
  // chunkToSceneDoc namespaces every entity id with this; strip it so build-doc
  // ids read as "<cx>_<cz>/<localId>" instead of the synthetic chunk-root key.
  const idPrefix = `__chunk:${opts.world}:`;
  const entities: SceneDoc["entities"] = {};
  const warnings: string[] = [];
  const models = new Set<string>();
  const materials = new Set<string>();
  let min: Vec3 | null = null;
  let max: Vec3 | null = null;

  for (const cell of cells) {
    let world: Map<string, WorldTransform>;
    let expanded: SceneDoc;
    try {
      const { doc } = chunkToSceneDoc(opts.world, cell.cx, cell.cz, opts.cellSize, cell.doc);
      expanded = expandScene(doc, opts.assets, opts.registry);
      world = worldTransforms(expanded);
    } catch (error) {
      warnings.push(`cell ${cell.cx}_${cell.cz} skipped: ${(error as Error).message}`);
      continue;
    }

    for (const [id, entity] of Object.entries(expanded.entities)) {
      if (!isStaticRenderEntity(entity)) continue;
      if (hasDynamicAncestor(expanded, id)) {
        warnings.push(`entity ${id} (cell ${cell.cx}_${cell.cz}) skipped: dynamic ancestor`);
        continue;
      }
      const wt = world.get(id);
      if (!wt) continue;
      const localPos: Vec3 = [
        wt.position[0] - origin[0],
        wt.position[1] - origin[1],
        wt.position[2] - origin[2],
      ];
      const mesh = structuredClone(entity.components["mesh"]) as Record<string, unknown>;
      const outId = id.startsWith(idPrefix) ? id.slice(idPrefix.length) : id;
      entities[outId] = {
        name: entity.name,
        parent: null,
        tags: ["hlod"],
        components: {
          transform: {
            position: localPos,
            rotation: [...wt.rotation],
            scale: [...wt.scale],
          },
          mesh,
        },
      };

      // dependency chain: mesh -> model asset + material asset
      const source = mesh["source"] as { kind?: string; assetId?: string } | undefined;
      if (source?.kind === "asset" && source.assetId) models.add(source.assetId);
      const materialId = mesh["material"] as string | undefined;
      if (materialId) materials.add(materialId);

      // coarse bounds over baked origins
      if (!min || !max) {
        min = [...localPos];
        max = [...localPos];
      } else {
        for (let i = 0; i < 3; i++) {
          if (localPos[i]! < min[i]!) min[i] = localPos[i]!;
          if (localPos[i]! > max[i]!) max[i] = localPos[i]!;
        }
      }
    }
  }

  const prefabs = collectPrefabDeps(cells, opts.assets);
  const textures = collectTextureDeps(materials, opts.assets);

  return {
    scx,
    scz,
    origin,
    doc: { version: 1, name: `__hlod:${opts.world}:${scx}_${scz}`, entities },
    bounds: min && max ? { min, max } : null,
    deps: {
      prefabs,
      models: [...models].sort(),
      materials: [...materials].sort(),
      textures,
    },
    warnings,
  };
}

/**
 * Every prefab definition reachable from the source cells, transitively (a
 * prefab instance may nest more prefabs). Returned sorted; ids with no
 * registered definition are still included so a later-added definition changes
 * the cache key.
 */
function collectPrefabDeps(cells: readonly ChunkCell[], assets: AssetLibrary): string[] {
  const found = new Set<string>();
  const queue: string[] = [];
  const enqueue = (entities: Record<string, EntityDoc>) => {
    for (const entity of Object.values(entities)) {
      const instance = entity.components["prefab"] as { prefabId?: string } | undefined;
      if (instance?.prefabId) queue.push(instance.prefabId);
    }
  };
  for (const cell of cells) enqueue(cell.doc.entities as Record<string, EntityDoc>);
  while (queue.length > 0) {
    const id = queue.pop()!;
    if (found.has(id)) continue;
    found.add(id);
    const prefab = assets.getPrefab(id);
    if (prefab) enqueue(prefab.entities);
  }
  return [...found].sort();
}

/** Texture asset ids referenced (as color maps) by the given material ids. */
function collectTextureDeps(materials: ReadonlySet<string>, assets: AssetLibrary): string[] {
  const textures = new Set<string>();
  for (const id of materials) {
    const asset = assets.getDataAsset(id);
    const map = (asset?.data as { map?: string } | undefined)?.map;
    if (map) textures.add(map);
  }
  return [...textures].sort();
}

// -- content-hash cache key --------------------------------------------------

/**
 * Bump when the HLOD bake algorithm changes in a way that invalidates cached
 * output regardless of source. Part of every cache key (§8).
 */
export const HLOD_GENERATOR_VERSION = "hlod-core-1";

export interface HlodCacheKeyInput {
  /** Defaults to HLOD_GENERATOR_VERSION; override to force-bust a range. */
  generatorVersion?: string;
  /** Bake settings (supercell factor, simplify options, quality profile...). */
  settings: unknown;
  scx: number;
  scz: number;
  /** The raw source cells whose CONTENT feeds the bake. */
  cells: readonly ChunkCell[];
  /** Dependency ids resolved by `assembleHlodBuildDoc`. */
  deps: HlodDependencies;
  /** Resolves the prefab/model/material/texture DEFINITIONS behind those ids. */
  assets: AssetLibrary;
}

/**
 * A stable content hash over everything that can change a supercell's baked
 * output: the generator version, bake settings, supercell coords, the source
 * cell documents, and the resolved definitions of every referenced prefab,
 * model, material, and texture (§8). Editing any of those — including swapping
 * a texture a material points at, three hops down the chain — changes the key;
 * reordering object fields does not. Missing definitions hash as null, so
 * adding one later still busts the key. Cache filenames key off this string.
 */
export function hlodCacheKey(input: HlodCacheKeyInput): string {
  const cellsById = [...input.cells]
    .map((c) => ({ key: chunkKey(c.cx, c.cz), doc: c.doc }))
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));

  const payload = {
    v: input.generatorVersion ?? HLOD_GENERATOR_VERSION,
    settings: input.settings ?? null,
    supercell: [input.scx, input.scz],
    cells: cellsById,
    prefabs: input.deps.prefabs.map((id) => ({ id, def: input.assets.getPrefab(id) ?? null })),
    models: input.deps.models.map((id) => ({ id, def: input.assets.getModel(id) ?? null })),
    materials: input.deps.materials.map((id) => ({
      id,
      def: input.assets.getDataAsset(id)?.data ?? null,
    })),
    textures: input.deps.textures.map((id) => ({ id, def: input.assets.getTexture(id) ?? null })),
  };

  return `hlod1-${fnv1a64(canonicalStringify(payload))}`;
}

/** Deterministic JSON with recursively sorted object keys; undefined dropped. */
function canonicalStringify(value: unknown): string {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalStringify).join(",")}]`;
  const obj = value as Record<string, unknown>;
  const parts: string[] = [];
  for (const key of Object.keys(obj).sort()) {
    if (obj[key] === undefined) continue;
    parts.push(`${JSON.stringify(key)}:${canonicalStringify(obj[key])}`);
  }
  return `{${parts.join(",")}}`;
}

/** FNV-1a 64-bit over UTF-16 code units (both bytes folded in), lowercase hex. */
function fnv1a64(str: string): string {
  const mask = 0xffffffffffffffffn;
  const prime = 0x100000001b3n;
  let hash = 0xcbf29ce484222325n;
  for (let i = 0; i < str.length; i++) {
    const code = str.charCodeAt(i);
    hash = ((hash ^ BigInt(code & 0xff)) * prime) & mask;
    hash = ((hash ^ BigInt((code >> 8) & 0xff)) * prime) & mask;
  }
  return hash.toString(16).padStart(16, "0");
}

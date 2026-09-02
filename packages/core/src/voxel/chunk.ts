/**
 * Cell -> `ChunkDoc`: what makes a generated world stream through exactly the
 * same machinery as an authored one.
 *
 * A procedural cell is turned into an ordinary chunk document — a terrain
 * entity whose mesh source is `{ kind: "voxel", world, cell }` plus one
 * collapsed prefab instance per scattered prop — and handed to the existing
 * `ChunkManager`. That buys the LOD rings, the HLOD supercell merge, the
 * physics attach/detach, the instanced-batch bookkeeping and the "chunk
 * content never enters the scene doc" rule for free, all of it already
 * debugged against a real game (docs/performance-lessons.md).
 *
 * The document stays tiny and legible: the terrain is four lines regardless of
 * how many triangles it becomes, and props are one line each, exactly as
 * ARCHITECTURE.md's collapsed-document rule requires.
 */

import type { ChunkDoc } from "../chunks.js";
import type { EntityDoc } from "../scene.js";
import type { VoxelWorldData } from "../components/voxel.js";
import type { WorldField } from "./field.js";
import { scatterCell, type ScatterCellOptions } from "./scatter.js";
import type { ScatterDoc } from "./recipe.js";

export interface VoxelChunkOptions extends ScatterCellOptions {
  /** Include scatter props (trees/rocks). Off for a bare-terrain preview. */
  scatter?: boolean;
  /**
   * Does this prefab/model asset exist? Scatter rules and POIs naming assets
   * that don't are dropped, with everything else in the cell kept.
   *
   * This is not defensiveness for its own sake: prefab expansion THROWS on an
   * unknown prefab, and a chunk load that throws loads nothing — so without
   * this one absent tree asset silently deletes the terrain, the collider and
   * every other prop in the cell, and you fall through the floor of a world
   * that looks empty. A recipe naturally names assets before they are made
   * (the whole point of authoring the world first), so this is the normal
   * case, not an edge case.
   *
   * Omit it — as the CLI does — to trust every reference.
   */
  assetExists?: (assetId: string, kind: "prefab" | "model") => boolean;
  /** Include a cooked trimesh collider on the terrain entity. */
  collision?: boolean;
  colliderLodStep?: number;
  /** Terrain material asset id; falls back to the recipe's own `material`. */
  material?: string;
  terrainCastShadow?: boolean;
  /** Mesh at a coarser lattice (HLOD/preview). 1 = full detail. */
  lodStep?: number;
}

/** The terrain entity's id inside every generated chunk — stable, so edits/diagnostics can name it. */
export const VOXEL_TERRAIN_ID = "terrain";

/** Can this scatter rule actually be built with the assets the host has? */
function scatterUsable(rule: ScatterDoc, exists: VoxelChunkOptions["assetExists"]): boolean {
  if (!rule.prefab && !rule.model) return false;
  if (!exists) return true;
  if (rule.prefab) return exists(rule.prefab, "prefab");
  return exists(rule.model!, "model");
}

function propEntity(rule: ScatterDoc, instance: ReturnType<typeof scatterCell>[number]): EntityDoc {
  const components: Record<string, unknown> = {
    transform: {
      position: instance.position,
      rotation: instance.rotation,
      scale: [instance.scale, instance.scale, instance.scale],
    },
  };
  if (rule.prefab) {
    components["prefab"] = { prefabId: rule.prefab, props: {}, overrides: [] };
  } else if (rule.model) {
    components["mesh"] = {
      source: {
        kind: "asset",
        assetId: rule.model,
        ...(rule.foliageNormals === undefined ? {} : { foliageNormals: rule.foliageNormals }),
        ...(rule.foliageUp === undefined ? {} : { foliageUp: rule.foliageUp }),
        ...(rule.brightness === undefined ? {} : { brightness: rule.brightness }),
        ...(rule.wind === undefined ? {} : { wind: rule.wind }),
        ...(rule.cameraFade === undefined ? {} : { cameraFade: rule.cameraFade }),
      },
      ...(rule.material ? { material: rule.material } : {}),
      // instanced is not an optimisation here, it is the difference between a
      // forest and a slideshow: one InstancedMesh per model per supercell
      renderMode: "instanced",
      lod: rule.lod,
      static: rule.static,
      castShadow: rule.castShadow,
      receiveShadow: true,
    };
  }
  if (rule.collider !== "none") {
    components["collider"] = {
      shape: rule.collider,
      size: [
        rule.colliderSize[0] * instance.scale,
        rule.colliderSize[1] * instance.scale,
        rule.colliderSize[2] * instance.scale,
      ],
      offset: [0, (rule.colliderSize[1] * instance.scale) / 2, 0],
    };
  }
  return { name: instance.id, parent: null, tags: ["scatter", rule.id], components };
}

/**
 * Build the chunk document for one cell of a generated world.
 *
 * Pure and deterministic: same field + same cell = the same document, every
 * time, in Node and in the browser. That is what lets the worldgen CLI reason
 * about a cell the player is standing in without the two ever exchanging data.
 */
export function voxelChunkDoc(
  field: WorldField,
  world: string,
  cx: number,
  cz: number,
  options: VoxelChunkOptions = {},
): ChunkDoc {
  const recipe = field.recipe;
  const entities: ChunkDoc["entities"] = {};

  const terrainComponents: Record<string, unknown> = {
    transform: { position: [0, 0, 0] },
    mesh: {
      source: {
        kind: "voxel",
        world,
        cell: [cx, cz],
        ...(options.lodStep && options.lodStep > 1 ? { lodStep: options.lodStep } : {}),
      },
      ...(options.material ?? recipe.material ? { material: options.material ?? recipe.material } : {}),
      // NOT `static: true`, which would opt the cell into static draw-call
      // batching. That exists to collapse hundreds of small props into one
      // call; a terrain cell is already one call, and merging cells together
      // would only cost per-cell frustum culling. HLOD is unaffected — the
      // supercell assembler decides by what an entity IS, not by this flag.
      static: false,
      castShadow: options.terrainCastShadow ?? false,
      receiveShadow: true,
    },
  };
  if (options.collision !== false) {
    terrainComponents["collider"] = { shape: "trimesh" };
  }
  entities[VOXEL_TERRAIN_ID] = {
    name: `terrain ${cx}_${cz}`,
    parent: null,
    tags: ["terrain", "voxel"],
    components: terrainComponents,
  };

  if (options.scatter !== false && recipe.scatter.length > 0) {
    const usable = recipe.scatter.map((rule) => scatterUsable(rule, options.assetExists));
    // nothing usable at all? skip the scatter solve entirely rather than
    // running the (not free) lattice sweep to throw every result away
    if (usable.some(Boolean)) {
      for (const instance of scatterCell(field, cx, cz, options)) {
        if (!usable[instance.ruleIndex]) continue;
        const rule = recipe.scatter[instance.ruleIndex];
        if (!rule) continue;
        entities[instance.id] = propEntity(rule, instance);
      }
    }
  }

  // POIs are authored points, not scattered ones — they belong to whichever
  // cell contains them and carry their own prefab and yaw.
  for (const poi of recipe.features.pois) {
    const pcx = Math.floor(poi.position[0] / recipe.cellSize);
    const pcz = Math.floor(poi.position[2] / recipe.cellSize);
    if (pcx !== cx || pcz !== cz || !poi.prefab) continue;
    if (options.assetExists && !options.assetExists(poi.prefab, "prefab")) continue;
    const half = poi.rotationY / 2;
    entities[`poi_${poi.id}`] = {
      name: poi.id,
      parent: null,
      tags: ["poi", poi.kind, ...poi.tags],
      components: {
        transform: {
          position: [
            poi.position[0] - cx * recipe.cellSize,
            poi.position[1],
            poi.position[2] - cz * recipe.cellSize,
          ],
          rotation: [0, Math.sin(half), 0, Math.cos(half)],
        },
        prefab: { prefabId: poi.prefab, props: {}, overrides: [] },
      },
    };
  }

  return { version: 1, entities };
}

/** Chunk options straight from a scene's `voxelWorld` component. */
export function voxelChunkOptionsFrom(data: VoxelWorldData): VoxelChunkOptions {
  return {
    scatter: data.scatter,
    collision: data.collision,
    colliderLodStep: data.colliderLodStep,
    material: data.material,
    terrainCastShadow: data.terrainCastShadow,
  };
}

/** Cell coordinates covering a world-space XZ rectangle, for CLI/preview sweeps. */
export function cellsInRect(
  cellSize: number,
  x0: number,
  z0: number,
  x1: number,
  z1: number,
): [number, number][] {
  const out: [number, number][] = [];
  for (let cz = Math.floor(z0 / cellSize); cz <= Math.floor(z1 / cellSize); cz++) {
    for (let cx = Math.floor(x0 / cellSize); cx <= Math.floor(x1 / cellSize); cx++) {
      out.push([cx, cz]);
    }
  }
  return out;
}

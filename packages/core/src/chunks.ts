import { z } from "zod";
import { entityDocSchema, type SceneDoc } from "./scene.js";
import type { ComponentRegistry } from "./components/registry.js";

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
});

export type ChunkStreamerData = z.infer<typeof chunkStreamerSchema>;

export function registerChunkComponents(registry: ComponentRegistry): void {
  registry.register("chunkStreamer", chunkStreamerSchema);
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

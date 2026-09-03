/**
 * Voxel cell generation on a worker thread — the server counterpart of the
 * playground's `voxel-worker.ts`.
 *
 * A cell costs ~40 ms on the mmo world: ~20 ms to sample the field and
 * scatter props into a cell doc, ~20 ms to march it into a collider mesh.
 * Both are pure functions of the recipe, so a worker holding its own
 * `WorldField` produces byte-identical results; the main thread is left with
 * ~4 ms of expand + attach per cell. Only the recipe crosses on init (and
 * again on terraform), one cell doc + one mesh cross back per request.
 *
 * Loaded through `voxel-worker-boot.mjs`, which registers the tsx loader so
 * `@hitreg/core`'s `.js`-suffixed TypeScript imports resolve inside the thread.
 */

import { parentPort } from "node:worker_threads";
import {
  buildVoxelMesh,
  createWorldField,
  voxelChunkDoc,
  type ChunkDoc,
  type VoxelChunkOptions,
  type VoxelMesh,
  type VoxelMeshSource,
  type WorldField,
  type WorldRecipe,
} from "@hitreg/core";

export interface VoxelWorkerInit {
  kind: "init";
  /** Bumped on every re-init; results carry it so stale ones can be dropped. */
  generation: number;
  recipe: WorldRecipe;
  world: string;
  options: Omit<VoxelChunkOptions, "assetExists">;
  /** `assetExists` cannot be cloned — the answers travel instead. */
  presentAssets: string[];
}

export interface VoxelWorkerCell {
  kind: "cell";
  id: number;
  cx: number;
  cz: number;
}

export type VoxelWorkerRequest = VoxelWorkerInit | VoxelWorkerCell;

export interface VoxelWorkerCellResult {
  kind: "cell";
  id: number;
  generation: number;
  doc: ChunkDoc;
  /** The terrain entity's mesh source and its marched mesh, or null for an empty cell. */
  source: VoxelMeshSource | null;
  mesh: VoxelMesh | null;
}

export type VoxelWorkerResponse = { kind: "ready" } | VoxelWorkerCellResult | { kind: "error"; id: number; error: string };

let field: WorldField | null = null;
let world = "";
let generation = 0;
let options: VoxelChunkOptions = {};

function handle(message: VoxelWorkerRequest): VoxelWorkerResponse | null {
  if (message.kind === "init") {
    field = createWorldField(message.recipe);
    world = message.world;
    generation = message.generation;
    const present = new Set(message.presentAssets);
    options = { ...message.options, assetExists: (id) => present.has(id) };
    return { kind: "ready" };
  }
  if (message.kind === "cell") {
    if (!field) return { kind: "error", id: message.id, error: "worker not initialised" };
    const doc = voxelChunkDoc(field, world, message.cx, message.cz, options);
    const terrain = doc.entities["terrain"];
    const source = (terrain?.components["mesh"] as { source?: VoxelMeshSource } | undefined)?.source ?? null;
    const mesh = source ? buildVoxelMesh(field, source) : null;
    return { kind: "cell", id: message.id, generation, doc, source, mesh };
  }
  return null;
}

if (parentPort) {
  parentPort.on("message", (message: VoxelWorkerRequest) => {
    let response: VoxelWorkerResponse | null;
    try {
      response = handle(message);
    } catch (error) {
      response = {
        kind: "error",
        id: message.kind === "cell" ? message.id : -1,
        error: error instanceof Error ? error.message : String(error),
      };
    }
    if (!response) return;
    if (response.kind === "cell" && response.mesh) {
      const m = response.mesh;
      parentPort!.postMessage(response, [m.positions.buffer, m.normals.buffer, m.indices.buffer, m.splat.buffer, m.tint.buffer] as ArrayBuffer[]);
    } else {
      parentPort!.postMessage(response);
    }
  });
}

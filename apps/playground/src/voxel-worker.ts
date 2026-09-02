/// <reference lib="webworker" />
import {
  buildVoxelMesh,
  createWorldField,
  mergeVoxelMeshes,
  voxelChunkDoc,
  type ChunkDoc,
  type VoxelChunkOptions,
  type VoxelMesh,
  type VoxelMeshSource,
  type WorldField,
  type WorldRecipe,
} from "@hitreg/core";

/**
 * Generates voxel cells off the main thread.
 *
 * docs/voxel-worlds.md § 8 named this as the fix and why it is a clean one:
 * "the field is pure and the recipe is small". A CDP profile of a 1200-unit
 * flight across the demo world put `fbm2` alone at 14.5% of all main-thread
 * self time, with `nearestOnPolyline`, `hash3i`, `marchingCubes` and
 * `naturalHeight` behind it — roughly 6.5 seconds of a 30 second flight spent
 * generating terrain, in synchronous bursts that showed up as 400-1000ms
 * `long-task` stalls and a 2003ms worst frame. The doc's "~6ms per cell"
 * estimate holds per cell; what it does not account for is that an HLOD
 * supercell bake calls `readCell` for up to 16 member cells, so a single bake
 * could generate sixteen cells inside one task.
 *
 * The worker owns a `WorldField` rebuilt from the recipe. That is the whole
 * reason this is cheap to do: the field is a pure function of recipe + seed,
 * so the worker's copy is identical to the main thread's without any state
 * having to be shipped or kept in sync. Only the recipe crosses on init, and
 * one plain-JSON `ChunkDoc` crosses back per cell.
 */

interface InitMessage {
  kind: "init";
  recipe: WorldRecipe;
  world: string;
  options: Omit<VoxelChunkOptions, "assetExists">;
  /** `assetExists` is a function and cannot be cloned — the main thread sends the answers instead. */
  presentAssets: string[];
}

interface CellMessage {
  kind: "cell";
  id: number;
  cx: number;
  cz: number;
}

/**
 * Mesh one cell for an HLOD proxy.
 *
 * This is the other half of the streaming cost and it is NOT the same work as
 * a `cell` request: a supercell re-meshes each member cell on a COARSER
 * lattice (`lodStep`), which is a separate marching-cubes run against the same
 * field. It was still happening on the main thread after cell generation moved
 * here, which is why the hitch shrank but did not disappear.
 */
interface MeshMessage {
  kind: "mesh";
  id: number;
  source: VoxelMeshSource;
}

/**
 * Mesh AND merge a whole supercell's terrain, one bucket per material.
 *
 * Meshing alone was not enough: with the marching cubes moved here the merge
 * — transforming every cell's vertices into supercell space and concatenating
 * them — became the largest main-thread cost left, ~3.9s of a 30s flight. It
 * is pure typed-array work, so it belongs on this side of the boundary, and
 * doing it here also means ONE transfer per material instead of one per cell.
 */
interface SupercellMessage {
  kind: "supercell";
  id: number;
  buckets: Array<{
    key: string;
    cells: Array<{ source: VoxelMeshSource; matrix: number[] }>;
  }>;
}

export type VoxelWorkerRequest = InitMessage | CellMessage | MeshMessage | SupercellMessage;

export type VoxelWorkerResponse =
  | { kind: "ready" }
  | { kind: "cell"; id: number; doc: ChunkDoc }
  | { kind: "cell"; id: number; error: string }
  | { kind: "mesh"; id: number; mesh: VoxelMesh | null }
  | { kind: "mesh"; id: number; error: string }
  | { kind: "supercell"; id: number; buckets: Array<{ key: string; mesh: VoxelMesh }> }
  | { kind: "supercell"; id: number; error: string };

let field: WorldField | null = null;
let world = "";
let options: VoxelChunkOptions = {};

const ctx = self as unknown as DedicatedWorkerGlobalScope;

ctx.onmessage = (event: MessageEvent<VoxelWorkerRequest>) => {
  const message = event.data;
  if (message.kind === "init") {
    field = createWorldField(message.recipe);
    world = message.world;
    const present = new Set(message.presentAssets);
    // Same contract as the main thread's: a rule naming an asset that does not
    // exist is dropped rather than throwing, because prefab expansion throws on
    // an unknown prefab and that would take the terrain and collider with it.
    options = { ...message.options, assetExists: (id) => present.has(id) };
    ctx.postMessage({ kind: "ready" } satisfies VoxelWorkerResponse);
    return;
  }
  if (!field) return; // asked for before init: the pool never does this
  if (message.kind === "supercell") {
    try {
      const out: Array<{ key: string; mesh: VoxelMesh }> = [];
      const transfer: Transferable[] = [];
      for (const bucket of message.buckets) {
        const meshes = bucket.cells.map((cell) => ({
          mesh: buildVoxelMesh(field!, cell.source),
          matrix: cell.matrix,
        }));
        const merged = mergeVoxelMeshes(meshes);
        if (!merged) continue;
        out.push({ key: bucket.key, mesh: merged });
        transfer.push(
          merged.positions.buffer as ArrayBuffer,
          merged.normals.buffer as ArrayBuffer,
          merged.indices.buffer as ArrayBuffer,
          merged.splat.buffer as ArrayBuffer,
          merged.tint.buffer as ArrayBuffer,
        );
      }
      ctx.postMessage({ kind: "supercell", id: message.id, buckets: out } satisfies VoxelWorkerResponse, transfer);
    } catch (error) {
      ctx.postMessage({
        kind: "supercell",
        id: message.id,
        error: error instanceof Error ? error.message : String(error),
      } satisfies VoxelWorkerResponse);
    }
    return;
  }
  if (message.kind === "mesh") {
    try {
      // `buildVoxelMesh` deliberately bypasses core's mesh cache, which is what
      // makes the result safe to TRANSFER: nothing in this worker keeps a
      // reference to the buffers we are about to neuter.
      const mesh = buildVoxelMesh(field, message.source);
      const empty = mesh.triangleCount === 0;
      ctx.postMessage(
        { kind: "mesh", id: message.id, mesh: empty ? null : mesh } satisfies VoxelWorkerResponse,
        empty
          ? []
          : ([
              mesh.positions.buffer,
              mesh.normals.buffer,
              mesh.indices.buffer,
              mesh.splat.buffer,
              mesh.tint.buffer,
            ] as Transferable[]),
      );
    } catch (error) {
      ctx.postMessage({
        kind: "mesh",
        id: message.id,
        error: error instanceof Error ? error.message : String(error),
      } satisfies VoxelWorkerResponse);
    }
    return;
  }
  try {
    const doc = voxelChunkDoc(field, world, message.cx, message.cz, options);
    ctx.postMessage({ kind: "cell", id: message.id, doc } satisfies VoxelWorkerResponse);
  } catch (error) {
    ctx.postMessage({
      kind: "cell",
      id: message.id,
      error: error instanceof Error ? error.message : String(error),
    } satisfies VoxelWorkerResponse);
  }
};

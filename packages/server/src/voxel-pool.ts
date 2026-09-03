/**
 * VoxelPool — a round-robin set of cell-generation worker threads.
 *
 * Owned by a TerrainStreamer. `init` (and `reinit` after a terraform) ships
 * the recipe; `cell` returns the generated doc plus the marched collider
 * mesh, which the streamer primes into core's mesh cache before attaching
 * the cell so the physics cook finds it already built.
 */

import os from "node:os";
import { Worker } from "node:worker_threads";
import { fileURLToPath } from "node:url";
import type { ChunkDoc, VoxelChunkOptions, VoxelMesh, VoxelMeshSource, WorldRecipe } from "@hitreg/core";
import type { VoxelWorkerRequest, VoxelWorkerResponse } from "./voxel-worker.js";

export interface VoxelPoolOptions {
  /** Threads (default: min(4, cpus - 1), at least 1). */
  workers?: number;
}

export interface GeneratedCell {
  doc: ChunkDoc;
  source: VoxelMeshSource | null;
  mesh: VoxelMesh | null;
  generation: number;
}

interface Pending {
  resolve: (cell: GeneratedCell) => void;
  reject: (error: Error) => void;
}

export function defaultWorkerCount(): number {
  return Math.max(1, Math.min(4, os.cpus().length - 1));
}

export class VoxelPool {
  private readonly workers: Worker[] = [];
  private readonly pending = new Map<number, Pending>();
  private nextId = 1;
  private next = 0;
  private generation = 0;
  private disposed = false;
  /** Rejected with the reason when a worker dies; the streamer falls back to inline generation. */
  private failure: Error | null = null;

  constructor(opts: VoxelPoolOptions = {}) {
    const count = Math.max(1, opts.workers ?? defaultWorkerCount());
    const entry = fileURLToPath(new URL("./voxel-worker-boot.mjs", import.meta.url));
    for (let i = 0; i < count; i++) {
      const worker = new Worker(entry);
      worker.on("message", (message: VoxelWorkerResponse) => {
        if (message.kind === "ready") return;
        const entry = this.pending.get(message.id);
        if (!entry) return;
        this.pending.delete(message.id);
        if (message.kind === "error") entry.reject(new Error(message.error));
        else entry.resolve({ doc: message.doc, source: message.source, mesh: message.mesh, generation: message.generation });
      });
      worker.on("error", (error) => {
        this.failure = error instanceof Error ? error : new Error(String(error));
        console.warn("[server:voxel-pool] worker failed:", this.failure.message);
        for (const [id, p] of this.pending) {
          this.pending.delete(id);
          p.reject(this.failure);
        }
      });
      this.workers.push(worker);
    }
  }

  get size(): number {
    return this.workers.length;
  }

  /** Null while healthy; the error once a worker has died. */
  get broken(): Error | null {
    return this.failure;
  }

  get currentGeneration(): number {
    return this.generation;
  }

  /** Ship (or re-ship) the recipe. Returns the generation results must carry to count. */
  init(recipe: WorldRecipe, world: string, options: VoxelChunkOptions, presentAssets: string[]): number {
    this.generation += 1;
    const { assetExists: _drop, ...plain } = options;
    const message: VoxelWorkerRequest = { kind: "init", generation: this.generation, recipe, world, options: plain, presentAssets };
    for (const worker of this.workers) worker.postMessage(message);
    return this.generation;
  }

  cell(cx: number, cz: number): Promise<GeneratedCell> {
    if (this.disposed) return Promise.reject(new Error("voxel pool disposed"));
    if (this.failure) return Promise.reject(this.failure);
    const worker = this.workers[this.next++ % this.workers.length]!;
    const id = this.nextId++;
    return new Promise<GeneratedCell>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      worker.postMessage({ kind: "cell", id, cx, cz } satisfies VoxelWorkerRequest);
    });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const worker of this.workers) void worker.terminate();
    this.workers.length = 0;
    const orphaned = [...this.pending.values()];
    this.pending.clear();
    for (const p of orphaned) p.reject(new Error("voxel pool disposed"));
  }
}

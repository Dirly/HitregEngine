/**
 * VoxelPool — an elastic set of cell-generation worker threads.
 *
 * Owned by a TerrainStreamer. `init` (and `reinit` after a terraform) ships
 * the recipe; `cell` returns the generated doc plus the marched collider
 * mesh, which the streamer primes into core's mesh cache before attaching
 * the cell so the physics cook finds it already built.
 *
 * Each thread is a whole engine isolate with its own copy of the world field
 * (~150 MB measured on the `mmo` world), and cells are only generated while
 * something walks into new ground. So threads start on demand (a cell asked
 * for while every live thread is busy starts another, up to `workers`) and a
 * thread with nothing to do for `idleSeconds` exits, down to `minWorkers`.
 * A new thread is sent the current recipe before its first cell.
 */

import os from "node:os";
import { Worker } from "node:worker_threads";
import { fileURLToPath } from "node:url";
import type { ChunkDoc, VoxelChunkOptions, VoxelMesh, VoxelMeshSource, WorldRecipe } from "@hitreg/core";
import type { VoxelWorkerRequest, VoxelWorkerResponse } from "./voxel-worker.js";

export interface VoxelPoolOptions {
  /** Most threads at once (default: min(4, cpus - 1), at least 1). */
  workers?: number;
  /** Threads kept alive while idle (default 0). */
  minWorkers?: number;
  /** Seconds a thread may sit with nothing to do before it exits (default 30). */
  idleSeconds?: number;
}

interface Thread {
  worker: Worker;
  /** Cells asked of it and not yet answered. */
  busy: number;
  /** performance.now() of its last answer (or its start). */
  lastUsed: number;
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
  private readonly threads: Thread[] = [];
  private readonly pending = new Map<number, Pending & { thread: Thread }>();
  private nextId = 1;
  private generation = 0;
  private readonly max: number;
  private readonly min: number;
  private readonly idleMs: number;
  /** The last recipe shipped, replayed to every thread that starts later. */
  private initMessage: VoxelWorkerRequest | null = null;
  private readonly reaper: ReturnType<typeof setInterval>;
  private disposed = false;
  /** Rejected with the reason when a worker dies; the streamer falls back to inline generation. */
  private failure: Error | null = null;

  constructor(opts: VoxelPoolOptions = {}) {
    this.max = Math.max(1, opts.workers ?? defaultWorkerCount());
    this.min = Math.max(0, Math.min(this.max, opts.minWorkers ?? 0));
    this.idleMs = Math.max(1, opts.idleSeconds ?? 30) * 1000;
    for (let i = 0; i < this.min; i++) this.spawn();
    this.reaper = setInterval(() => this.reap(), Math.min(5000, this.idleMs));
    this.reaper.unref?.();
  }

  private spawn(): Thread {
    const entry = fileURLToPath(new URL("./voxel-worker-boot.mjs", import.meta.url));
    const worker = new Worker(entry);
    const thread: Thread = { worker, busy: 0, lastUsed: performance.now() };
    worker.on("message", (message: VoxelWorkerResponse) => {
      if (message.kind === "ready") return;
      const entry = this.pending.get(message.id);
      if (!entry) return;
      this.pending.delete(message.id);
      thread.busy = Math.max(0, thread.busy - 1);
      thread.lastUsed = performance.now();
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
    // queued on the port until the thread's module listens: the recipe arrives first
    if (this.initMessage) worker.postMessage(this.initMessage);
    this.threads.push(thread);
    return thread;
  }

  /** Threads idle past idleSeconds exit, down to minWorkers. */
  private reap(): void {
    if (this.disposed) return;
    const now = performance.now();
    for (let i = this.threads.length - 1; i >= 0 && this.threads.length > this.min; i--) {
      const t = this.threads[i]!;
      if (t.busy > 0 || now - t.lastUsed < this.idleMs) continue;
      this.threads.splice(i, 1);
      void t.worker.terminate();
    }
  }

  /** Most threads the pool will run (live ones: `live`). */
  get size(): number {
    return this.max;
  }

  /** Threads running right now. */
  get live(): number {
    return this.threads.length;
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
    // serialised once, here (boot, terraform), into shared memory; every thread that starts later gets a reference
    const bytes = new TextEncoder().encode(JSON.stringify(recipe));
    const recipeJson = new Uint8Array(new SharedArrayBuffer(bytes.length));
    recipeJson.set(bytes);
    const message: VoxelWorkerRequest = { kind: "init", generation: this.generation, recipeJson, world, options: plain, presentAssets };
    this.initMessage = message;
    for (const t of this.threads) t.worker.postMessage(message);
    return this.generation;
  }

  cell(cx: number, cz: number): Promise<GeneratedCell> {
    if (this.disposed) return Promise.reject(new Error("voxel pool disposed"));
    if (this.failure) return Promise.reject(this.failure);
    // the least busy live thread; a new one when every live thread is working
    let thread: Thread | undefined;
    for (const t of this.threads) if (!thread || t.busy < thread.busy) thread = t;
    if (!thread || (thread.busy > 0 && this.threads.length < this.max)) thread = this.spawn();
    thread.busy++;
    const id = this.nextId++;
    const chosen = thread;
    return new Promise<GeneratedCell>((resolve, reject) => {
      this.pending.set(id, { resolve, reject, thread: chosen });
      chosen.worker.postMessage({ kind: "cell", id, cx, cz } satisfies VoxelWorkerRequest);
    });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    clearInterval(this.reaper);
    for (const t of this.threads) void t.worker.terminate();
    this.threads.length = 0;
    const orphaned = [...this.pending.values()];
    this.pending.clear();
    for (const p of orphaned) p.reject(new Error("voxel pool disposed"));
  }
}

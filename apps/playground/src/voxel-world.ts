import {
  createWorldField,
  getVoxelWorld,
  invalidateVoxelWorld,
  registerVoxelWorld,
  registerVolume,
  getVolume,
  invalidateVolume,
  voxelChunkDoc,
  voxelChunkOptionsFrom,
  worldRecipeSchema,
  type AssetLibrary,
  type ChunkDoc,
  type ChunkStreamerData,
  type SceneDoc,
  type VoxelChunkOptions,
  type VoxelMesh,
  type VoxelMeshSource,
  type VoxelWorldData,
  type WorldField,
} from "@hitreg/core";
import type { ChunkProvider } from "./chunk-manager.js";
import type { VoxelWorkerRequest, VoxelWorkerResponse } from "./voxel-worker.js";

/**
 * Wiring for procedural (marching-cubes) worlds.
 *
 * A scene opts in with a `voxelWorld` component naming a recipe under
 * `assets/worlds/`. From there the world streams through the ORDINARY chunk
 * streamer: this module's only jobs are to translate the component into the
 * `ChunkStreamerData` the streamer already understands, and to hand it a
 * {@link ChunkProvider} that generates a cell's document instead of reading a
 * file. Everything downstream — residency rings, hysteresis, HLOD supercells,
 * physics attach on the simulation boundary, instanced-batch disposal — is the
 * code path an authored chunk world already uses.
 *
 * The recipe is a data asset, so editing `assets/worlds/<id>.json` while the
 * dev server runs live-syncs like any other asset: the recipe re-registers,
 * every cached cell mesh is dropped, and resident cells re-stream. Terrain you
 * can tune by editing JSON and watching it change is the whole point.
 */

/** The scene component + the resolved recipe field it names. */
export interface ResolvedVoxelWorld {
  data: VoxelWorldData;
  field: WorldField;
  /** The streamer config the ChunkManager consumes — cell size comes from the RECIPE. */
  streamer: ChunkStreamerData;
}

/**
 * Find the scene's `voxelWorld` component (first wins, like `chunkStreamer`)
 * and resolve it against the registered recipes. Returns null when the scene
 * has none, or names a recipe that failed to load — in which case it warns
 * once rather than streaming an empty world in silence.
 */
export function resolveVoxelWorld(doc: SceneDoc): ResolvedVoxelWorld | null {
  for (const entity of Object.values(doc.entities)) {
    const data = entity.components["voxelWorld"] as VoxelWorldData | undefined;
    if (!data) continue;
    const field = getVoxelWorld(data.world);
    if (!field) {
      warnOnce(data.world, `[voxel] no world recipe "${data.world}" (assets/worlds/${data.world}.json)`);
      return null;
    }
    return { data, field, streamer: streamerFor(data, field) };
  }
  return null;
}

const warned = new Set<string>();
function warnOnce(key: string, message: string): void {
  if (warned.has(key)) return;
  warned.add(key);
  console.warn(message);
}

/**
 * The `voxelWorld` component expressed as `chunkStreamerData`.
 *
 * `cellSize` is deliberately NOT a field on the component: it comes from the
 * recipe, because the recipe's `resolution` is defined relative to it. Letting
 * a scene override it would silently change the voxel size of the world and
 * the meaning of every distance in the recipe.
 */
export function streamerFor(data: VoxelWorldData, field: WorldField): ChunkStreamerData {
  return {
    source: data.world,
    cellSize: field.recipe.cellSize,
    radius: Math.max(1, Math.ceil(data.rings.simulation)),
    keepPadding: data.keepPadding,
    rings: data.rings,
    hlodSupercellFactor: data.hlodSupercellFactor,
  };
}

/**
 * A provider generating cells for one world.
 *
 * Generation is synchronous and, for a 24-voxel cell, costs single-digit
 * milliseconds — but it is called from the streamer's async load path, so it
 * lands between frames alongside the (much larger) mesh build, exactly where
 * an authored chunk's fetch would have. Cells are bounded by `maxCells` so a
 * runaway focus (a script teleporting the player to 1e9) can't ask for a
 * coordinate whose lattice arithmetic loses precision.
 */
export function voxelChunkProvider(
  world: ResolvedVoxelWorld,
  assets: AssetLibrary,
  maxCells = 1_000_000,
): ChunkProvider {
  const options: VoxelChunkOptions = {
    ...voxelChunkOptionsFrom(world.data),
    assetExists: (id, kind) => (kind === "prefab" ? assets.getPrefab(id) : assets.getModel(id)) !== undefined,
  };
  reportMissingScatterAssets(world, options);
  // A provider is rebuilt on every scene rebuild — every edit, every asset
  // live-sync, every scene switch — but the CELLS it generates only change
  // when the world field or the generation options do. `registerVoxelWorld`
  // replaces the field object on a recipe edit and nothing else does, so the
  // pair below is exactly "these two providers would generate the same world".
  //
  // Two things hang off getting that right. The pool: rebuilding it per edit
  // meant tearing down and restarting a set of worker threads, and rejecting
  // every cell and HLOD bake in flight, on every keystroke's worth of live
  // sync. And the streamed world itself — `ChunkManager.setProvider` reads
  // this identity to decide whether to keep it (see ChunkProvider.key).
  const optionsKey = cellOptionsKey(world, options);
  if (!activeIdentity || activeIdentity.field !== world.field || activeIdentity.optionsKey !== optionsKey) {
    activePool?.dispose();
    activePool = createVoxelWorkerPool(world, options);
    activeIdentity = { field: world.field, optionsKey };
  }
  const pool = activePool;
  const identity = activeIdentity;
  // the world limit, in cells, with the coast band and a ring of sea floor
  // beyond it: cells past this are pure ocean floor and never worth building
  const limit = world.field.worldLimit;
  const limitCells =
    limit === Infinity ? Infinity : (limit + (world.field.recipe.bounds?.limitFalloff ?? 600)) / world.field.recipe.cellSize + 2;
  return {
    key: identity,
    has: (cx, cz) =>
      Number.isFinite(cx) &&
      Number.isFinite(cz) &&
      Math.abs(cx) < maxCells &&
      Math.abs(cz) < maxCells &&
      Math.hypot(cx + 0.5, cz + 0.5) <= limitCells,
    // `ChunkProvider.get` has always allowed a Promise; this is what finally
    // uses it. Falls back to generating inline when no worker could start.
    // An urgent (simulation-ring) cell is generated inline: it is about to
    // carry a collider somebody stands on, and a worker round-trip is long
    // enough that the player spawns before the ground does and falls through
    // the world. Everything else — the render-only rings and the HLOD bakes
    // that read up to 16 cells in one go — is where the off-thread win is.
    get: (cx, cz, urgency = "near"): ChunkDoc | Promise<ChunkDoc> =>
      (urgency === "inline" ? null : pool?.cell(cx, cz, urgency === "bulk" ? PRIORITY_BULK : PRIORITY_NEAR)) ??
      voxelChunkDoc(world.field, world.data.world, cx, cz, options),
  };
}

/**
 * How many cells can be generating at once.
 *
 * Latency, not throughput, is what the player feels: a cell that arrives late
 * is a hole in the world ahead of them. With three workers a busy flight
 * queued cells behind each other and `chunk.load` wall-clock reached 1.4s, so
 * this scales with the machine while leaving cores for the render thread and
 * the browser's own work.
 */
const VOXEL_WORKERS = Math.max(2, Math.min(6, (navigator.hardwareConcurrency || 4) - 2));

/**
 * Job priority in the generation pool.
 *
 * There are two kinds of caller and they want opposite things. The residency
 * rings want ONE cell as soon as possible, because a late cell is ground
 * missing in front of the player. An HLOD bake wants SIXTY-FOUR cells and
 * does not care when any individual one lands, because it cannot publish
 * until it has them all. Run them at the same priority and the bake wins by
 * sheer volume: measured, a 64-cell far block held the pool for 3.6 seconds
 * while the near ring waited behind it.
 */
const PRIORITY_NEAR = 10;
const PRIORITY_BULK = 0;

interface VoxelWorkerPool {
  cell(cx: number, cz: number, priority?: number): Promise<ChunkDoc>;
  mesh(source: VoxelMeshSource): Promise<VoxelMesh | null>;
  supercell(
    buckets: Array<{ key: string; cells: Array<{ source: VoxelMeshSource; matrix: number[] }> }>,
  ): Promise<Array<{ key: string; mesh: VoxelMesh }>>;
  /** Terminate the threads and fail anything still in flight. */
  dispose(): void;
}

/**
 * The pool for the world currently streaming, so the HLOD proxy builder can
 * reach it through a plain `BuildOptions` hook instead of packages/render
 * having to know what a Worker is.
 */
let activePool: VoxelWorkerPool | null = null;

/**
 * What that pool — and every cell already streamed from it — was built for.
 *
 * The object itself is the token: it is replaced only when the world field or
 * the generation options change, so `Object.is` on it answers "would a fresh
 * provider generate a different world?" for both the pool above and
 * `ChunkManager.setProvider`. See voxelChunkProvider.
 */
let activeIdentity: { field: WorldField; optionsKey: string } | null = null;

/**
 * The generation inputs that decide a cell's CONTENT, as a comparable string.
 *
 * `assetExists` is a closure — never equal across rebuilds, and not the answer
 * anyway. Its ANSWERS are: a scatter rule whose model has not loaded yet is
 * skipped, so the same recipe generates different cells before and after that
 * model arrives, and the key has to move with it. Everything else is plain
 * data off the `voxelWorld` component.
 */
function cellOptionsKey(world: ResolvedVoxelWorld, options: VoxelChunkOptions): string {
  const { assetExists: _drop, ...plain } = options;
  const resolvable: string[] = [];
  for (const rule of world.field.recipe.scatter) {
    const id = rule.prefab ?? rule.model;
    if (id && options.assetExists?.(id, rule.prefab ? "prefab" : "model")) resolvable.push(id);
  }
  return `${JSON.stringify(plain)}|${resolvable.sort().join(",")}`;
}

/**
 * `BuildOptions.voxelMeshAsync` — coarse HLOD cell meshing, off-thread.
 * Returns null when there is no pool (headless tooling, tests), and the
 * caller falls back to meshing inline.
 */
export function voxelMeshViaWorker(source: VoxelMeshSource): Promise<VoxelMesh | null> | null {
  return activePool?.mesh(source) ?? null;
}

/**
 * `BuildOptions.voxelSupercellAsync` — mesh AND merge a supercell's terrain
 * buckets off-thread, one transfer per material instead of one per cell.
 */
export function voxelSupercellViaWorker(
  buckets: Array<{ key: string; cells: Array<{ source: VoxelMeshSource; matrix: number[] }> }>,
): Promise<Array<{ key: string; mesh: VoxelMesh }>> | null {
  return activePool?.supercell(buckets) ?? null;
}

/**
 * Priority-queued pool of {@link VoxelWorkerRequest} workers.
 *
 * Returns null — and the provider stays synchronous — if Worker construction
 * throws. That is not paranoia: this module is also imported by the headless
 * tooling and by tests, where `Worker` and `import.meta.url` module workers do
 * not exist, and a world that generates slowly is enormously better than one
 * that does not generate at all.
 */
function createVoxelWorkerPool(
  world: ResolvedVoxelWorld,
  options: VoxelChunkOptions,
): VoxelWorkerPool | null {
  if (typeof Worker === "undefined") return null;
  const workers: Worker[] = [];
  const pending = new Map<
    number,
    { resolve: (value: never) => void; reject: (e: Error) => void }
  >();
  let nextId = 1;
  /** Which worker slot is running each in-flight request id — see the queue below. */
  const slotOf = new Map<number, number>();
  /** …and the reverse, so a worker that ERRORS can have its job failed and its slot freed. */
  const jobOf = new Map<number, number>();

  // `assetExists` is a closure and cannot be structured-cloned, so the answers
  // travel instead of the question: every scatter/POI asset the recipe names
  // that actually resolves today.
  const present: string[] = [];
  for (const rule of world.field.recipe.scatter) {
    const id = rule.prefab ?? rule.model;
    if (id && options.assetExists?.(id, rule.prefab ? "prefab" : "model")) present.push(id);
  }
  const { assetExists: _drop, ...plain } = options;

  /**
   * Jobs waiting for a worker, highest priority first.
   *
   * There was no queue here: every request was posted straight to the next
   * worker round-robin, so a worker's own message queue WAS the queue — FIFO,
   * per worker, and unjumpable. That is fine while nothing asks for many cells
   * at once and fatal the moment something does. An HLOD supercell bake reads
   * up to 64 cells, and the near ring's cells — the ground the player is
   * walking onto — would land behind a tenth of that block on whichever
   * worker they happened to be dealt.
   *
   * So: one queue, ordered by priority, and at most one job outstanding per
   * worker. Cap of one is deliberate. Two would hide a little dispatch
   * latency and cost a near cell a whole extra bake's wait, and the thing
   * being protected here IS that wait.
   */
  interface Job {
    priority: number;
    seq: number;
    request: (id: number) => VoxelWorkerRequest;
    resolve: (value: never) => void;
    reject: (e: Error) => void;
  }
  const queue: Job[] = [];
  const busy = new Set<number>();
  let seq = 0;

  const pump = (): void => {
    for (let i = 0; i < workers.length && queue.length > 0; i++) {
      if (busy.has(i)) continue;
      // highest priority, oldest first within a priority
      let bestAt = 0;
      for (let j = 1; j < queue.length; j++) {
        const a = queue[j]!;
        const b = queue[bestAt]!;
        if (a.priority > b.priority || (a.priority === b.priority && a.seq < b.seq)) bestAt = j;
      }
      const job = queue.splice(bestAt, 1)[0]!;
      const id = nextId++;
      busy.add(i);
      slotOf.set(id, i);
      jobOf.set(i, id);
      pending.set(id, { resolve: job.resolve, reject: job.reject });
      workers[i]!.postMessage(job.request(id));
    }
  };

  const submit = <T>(build: (id: number) => VoxelWorkerRequest, priority = PRIORITY_NEAR): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      queue.push({
        priority,
        seq: seq++,
        request: build,
        resolve: resolve as (value: never) => void,
        reject,
      });
      pump();
    });

  try {
    for (let i = 0; i < VOXEL_WORKERS; i++) {
      const worker = new Worker(new URL("./voxel-worker.js", import.meta.url), { type: "module" });
      worker.onmessage = (event: MessageEvent<VoxelWorkerResponse>) => {
        const message = event.data;
        if (message.kind === "ready") return;
        const entry = pending.get(message.id);
        const slot = slotOf.get(message.id);
        if (slot !== undefined) {
          busy.delete(slot);
          slotOf.delete(message.id);
          jobOf.delete(slot);
        }
        if (!entry) {
          pump();
          return;
        }
        pending.delete(message.id);
        if ("error" in message) entry.reject(new Error(message.error));
        else
          entry.resolve(
            (message.kind === "cell"
              ? message.doc
              : message.kind === "mesh"
                ? message.mesh
                : message.buckets) as never,
          );
        pump(); // a worker just freed up
      };
      worker.onerror = (event) => {
        console.warn("[voxel] generation worker failed:", event.message);
        // Free the slot and fail its job. Without this the queue below would
        // hand out one fewer worker after every error and eventually stall
        // outright — a stalled generation pool is a world that stops loading,
        // which is a far worse failure than one lost cell.
        const slot = workers.indexOf(worker);
        const id = slot >= 0 ? jobOf.get(slot) : undefined;
        if (id !== undefined) {
          const entry = pending.get(id);
          pending.delete(id);
          slotOf.delete(id);
          jobOf.delete(slot);
          entry?.reject(new Error(event.message || "voxel worker error"));
        }
        if (slot >= 0) busy.delete(slot);
        pump();
      };
      worker.postMessage({
        kind: "init",
        recipe: world.field.recipe,
        world: world.data.world,
        options: plain,
        presentAssets: present,
      } satisfies VoxelWorkerRequest);
      workers.push(worker);
    }
  } catch (error) {
    console.warn("[voxel] no generation workers, falling back to the main thread:", error);
    for (const worker of workers) worker.terminate();
    return null;
  }


  return {
    cell: (cx, cz, priority) => submit<ChunkDoc>((id) => ({ kind: "cell", id, cx, cz }), priority),
    mesh: (source) => submit<VoxelMesh | null>((id) => ({ kind: "mesh", id, source }), PRIORITY_BULK),
    supercell: (buckets) =>
      submit<Array<{ key: string; mesh: VoxelMesh }>>((id) => ({ kind: "supercell", id, buckets }), PRIORITY_BULK),
    dispose() {
      for (const worker of workers) worker.terminate();
      workers.length = 0;
      // Anything still awaiting a terminated worker would hang forever, and a
      // hung `readCell` holds a slot in the load queue for the rest of the
      // session. Reject instead: ChunkManager already treats a failed cell as
      // "load nothing" and warns.
      const orphaned = [...pending.values(), ...queue];
      pending.clear();
      queue.length = 0;
      slotOf.clear();
      jobOf.clear();
      busy.clear();
      for (const entry of orphaned) entry.reject(new Error("voxel worker pool disposed"));
    },
  };
}

/**
 * Say once, at configure time, which scatter rules are inert for want of an
 * asset. Skipping them silently would make "my forest never appeared" a
 * mystery; saying it per cell would print it hundreds of times a minute.
 */
function reportMissingScatterAssets(world: ResolvedVoxelWorld, options: VoxelChunkOptions): void {
  const missing = world.field.recipe.scatter
    .filter((rule) => {
      const id = rule.prefab ?? rule.model;
      if (!id) return true;
      return !options.assetExists?.(id, rule.prefab ? "prefab" : "model");
    })
    .map((rule) => `${rule.id} -> ${rule.prefab ?? rule.model ?? "(nothing)"}`);
  if (missing.length === 0) return;
  console.warn(
    `[voxel] "${world.data.world}": ${missing.length} scatter rule(s) have no asset yet and place nothing — ` +
      `${missing.join(", ")}. The terrain still streams; add the prefabs and they populate.`,
  );
}

/**
 * Register every `assets/worlds/*.json` recipe found in the asset index.
 * Invalid recipes are reported and skipped — the scene then falls back to
 * "no voxel world" rather than half-generating something.
 */
export async function loadWorldRecipes(
  index: Record<string, string[]>,
  readJson: (kind: string, file: string) => Promise<unknown>,
): Promise<string[]> {
  const files = (index["worlds"] ?? []).filter((f) => f.endsWith(".json"));
  const loaded: string[] = [];
  await Promise.all(
    files.map(async (file) => {
      const id = file.replace(/\.json$/, "");
      try {
        const field = registerVoxelWorld(id, await readJson("worlds", file));
        // remember what it was built from, so the first watcher event for an
        // unchanged file is recognised as the no-op it is
        registeredRecipes.set(id, JSON.stringify(field.recipe));
        loaded.push(id);
      } catch (error) {
        console.warn(`[voxel] world recipe "${id}" is invalid:`, error);
      }
    }),
  );
  return loaded;
}

/**
 * Live-sync a recipe edit. Returns true when the running world changed and the
 * caller must re-stream, false when the file was irrelevant or invalid (in
 * which case the previous, working world stays up — the same "bad edits change
 * nothing" rule the scene/asset watchers follow).
 */
export function applyWorldRecipeEdit(id: string, content: string | null): boolean {
  if (content === null) {
    invalidateVoxelWorld(id);
    registeredRecipes.delete(id);
    return getVoxelWorld(id) !== null;
  }
  try {
    const recipe = worldRecipeSchema.parse(JSON.parse(content));
    // A recipe governs EVERY generated cell, so acting on this edit re-streams
    // the whole world — thousands of cells, minutes of work on a busy machine.
    // Which is right for a real change and pure damage for a rewrite that says
    // the same thing: a `worldgen` re-run that only touched formatting, a save
    // that round-trips the file, an editor writing back what it read. Compare
    // the PARSED recipe, so key order and whitespace are not a world reload.
    const canonical = JSON.stringify(recipe);
    if (registeredRecipes.get(id) === canonical) return false;
    // parse first, then swap: a half-valid recipe must never replace a good one
    createWorldField(recipe);
    registerVoxelWorld(id, recipe);
    registeredRecipes.set(id, canonical);
    return true;
  } catch (error) {
    console.warn(`[voxel] rejected edit to world recipe "${id}":`, error);
    return false;
  }
}

/**
 * The recipe each world is CURRENTLY built from, canonicalised — see the
 * no-op guard above. Written wherever a recipe is registered, so the first
 * file-watch event after boot can tell "unchanged" from "not seen yet".
 */
const registeredRecipes = new Map<string, string>();

/**
 * Register every `assets/volumes/*.json` CSG document found in the asset
 * index, alongside the world recipes above and for the same reason: a
 * `mesh.source` of kind `csg` names its volume by id, and render, physics and
 * placement each resolve it from this registry rather than from the asset
 * library. An invalid document is reported and skipped — the entity then
 * draws nothing, rather than the scene failing to build.
 */
export async function loadVolumes(
  index: Record<string, string[]>,
  readJson: (kind: string, file: string) => Promise<unknown>,
): Promise<string[]> {
  const files = (index["volumes"] ?? []).filter((f) => f.endsWith(".json"));
  const loaded: string[] = [];
  await Promise.all(
    files.map(async (file) => {
      const id = file.replace(/\.json$/, "");
      try {
        registerVolume(id, await readJson("volumes", file));
        loaded.push(id);
      } catch (error) {
        console.warn(`[csg] volume "${id}" is invalid:`, error);
      }
    }),
  );
  return loaded;
}

/**
 * Live-sync a volume edit. Returns true when a registered volume changed and
 * the caller must rebuild the scene. Same "bad edits change nothing" rule as
 * the recipe watcher: a document that fails to parse leaves the previous,
 * working one in place.
 */
export function applyVolumeEdit(id: string, content: string | null): boolean {
  if (content === null) {
    const had = getVolume(id) !== null;
    invalidateVolume(id);
    return had;
  }
  try {
    registerVolume(id, JSON.parse(content));
    return true;
  } catch (error) {
    console.warn(`[csg] rejected edit to volume "${id}":`, error);
    return false;
  }
}

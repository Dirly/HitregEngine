import {
  createWorldField,
  getVoxelWorld,
  invalidateVoxelWorld,
  registerVoxelWorld,
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
  // A provider is rebuilt on every scene rebuild — every edit, every recipe
  // change, every scene switch — so the previous pool's threads have to go
  // with it. Without this each edit leaked a whole set of workers, which is
  // exactly the live-editing loop this engine is built around.
  activePool?.dispose();
  const pool = createVoxelWorkerPool(world, options);
  activePool = pool;
  // the world limit, in cells, with the coast band and a ring of sea floor
  // beyond it: cells past this are pure ocean floor and never worth building
  const limit = world.field.worldLimit;
  const limitCells =
    limit === Infinity ? Infinity : (limit + (world.field.recipe.bounds?.limitFalloff ?? 600)) / world.field.recipe.cellSize + 2;
  return {
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
    get: (cx, cz, urgent): ChunkDoc | Promise<ChunkDoc> =>
      (urgent ? null : pool?.cell(cx, cz)) ??
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

interface VoxelWorkerPool {
  cell(cx: number, cz: number): Promise<ChunkDoc>;
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
 * Round-robin pool of {@link VoxelWorkerRequest} workers.
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
  let next = 0;

  // `assetExists` is a closure and cannot be structured-cloned, so the answers
  // travel instead of the question: every scatter/POI asset the recipe names
  // that actually resolves today.
  const present: string[] = [];
  for (const rule of world.field.recipe.scatter) {
    const id = rule.prefab ?? rule.model;
    if (id && options.assetExists?.(id, rule.prefab ? "prefab" : "model")) present.push(id);
  }
  const { assetExists: _drop, ...plain } = options;

  try {
    for (let i = 0; i < VOXEL_WORKERS; i++) {
      const worker = new Worker(new URL("./voxel-worker.js", import.meta.url), { type: "module" });
      worker.onmessage = (event: MessageEvent<VoxelWorkerResponse>) => {
        const message = event.data;
        if (message.kind === "ready") return;
        const entry = pending.get(message.id);
        if (!entry) return;
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
      };
      worker.onerror = (event) => {
        console.warn("[voxel] generation worker failed:", event.message);
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

  const submit = <T>(build: (id: number) => VoxelWorkerRequest): Promise<T> => {
    const worker = workers[next++ % workers.length]!;
    const id = nextId++;
    return new Promise<T>((resolve, reject) => {
      pending.set(id, { resolve: resolve as (value: never) => void, reject });
      worker.postMessage(build(id));
    });
  };

  return {
    cell: (cx, cz) => submit<ChunkDoc>((id) => ({ kind: "cell", id, cx, cz })),
    mesh: (source) => submit<VoxelMesh | null>((id) => ({ kind: "mesh", id, source })),
    supercell: (buckets) =>
      submit<Array<{ key: string; mesh: VoxelMesh }>>((id) => ({ kind: "supercell", id, buckets })),
    dispose() {
      for (const worker of workers) worker.terminate();
      workers.length = 0;
      // Anything still awaiting a terminated worker would hang forever, and a
      // hung `readCell` holds a slot in the load queue for the rest of the
      // session. Reject instead: ChunkManager already treats a failed cell as
      // "load nothing" and warns.
      const orphaned = [...pending.values()];
      pending.clear();
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
        registerVoxelWorld(id, await readJson("worlds", file));
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
    return getVoxelWorld(id) !== null;
  }
  try {
    const recipe = worldRecipeSchema.parse(JSON.parse(content));
    // parse first, then swap: a half-valid recipe must never replace a good one
    createWorldField(recipe);
    registerVoxelWorld(id, recipe);
    return true;
  } catch (error) {
    console.warn(`[voxel] rejected edit to world recipe "${id}":`, error);
    return false;
  }
}

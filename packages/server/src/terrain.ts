/**
 * TerrainStreamer — voxel-world colliders around every player, headless.
 *
 * The browser streams a generated world through its ChunkManager: recipe →
 * `voxelChunkDoc` → `chunkToSceneDoc` → `expandScene` → build + `sim.addEntities`.
 * The server walks the identical path up to the build step and skips it: a
 * cell here is a terrain trimesh plus the scatter props' primitive colliders,
 * nothing else. Same recipe, same cell docs, same collision — which is what
 * lets the client predict against ground the server agrees with.
 *
 * Residency is the SIMULATION ring only (no render rings exist here), taken
 * around every focus point and unioned, with the same leave-side hysteresis
 * `computeChunkStates` gives the browser. Loads are budgeted per tick so a
 * player sprinting into fresh terrain costs a few cells a step, not a stall.
 */

import {
  applyRecipeEdits,
  cellsForEdits,
  chunkKey,
  chunkToSceneDoc,
  computeChunkStates,
  expandScene,
  getVoxelWorld,
  parseChunkKey,
  primeVoxelMesh,
  registerVoxelWorld,
  voxelChunkDoc,
  voxelChunkOptionsFrom,
  type ChunkDoc,
  type ChunkRep,
  type RecipeEdit,
  type RecipeEditResult,
  type ChunkStreamerData,
  type SceneDoc,
  type VoxelChunkOptions,
  type VoxelMesh,
  type VoxelMeshSource,
  type VoxelWorldData,
  type WorldField,
  type WorldRecipe,
} from "@hitreg/core";
import type { HeadlessWorld } from "./world.js";
import { VoxelPool, type VoxelPoolOptions } from "./voxel-pool.js";

export interface TerrainStreamerOptions {
  /** Cells around each focus to keep simulated (default: the component's `rings.simulation`, min 1). */
  radiusCells?: number;
  /** Cells loaded per step at most (default 2). */
  loadsPerStep?: number;
  /**
   * Milliseconds of cell generation allowed per update (default 6). A cell is
   * cooked synchronously — sampling the field, marching it, building the
   * trimesh — and the second cell in a step only starts if the first left
   * room in the budget. Keeps a sprint into fresh terrain from stalling a tick.
   */
  loadBudgetMs?: number;
  /** Cells unloaded per step at most (default 4). */
  unloadsPerStep?: number;
  /**
   * Generate cells on worker threads (default on: min(4, cpus-1) threads;
   * `{ workers: 0 }` keeps everything inline). Off-thread, a cell costs the
   * tick ~4 ms (expand + attach) instead of ~40; the budget above still
   * bounds how many land per update. Spawn-time `ensure*` loads stay inline
   * — ground has to exist before the body does.
   */
  pool?: VoxelPoolOptions & { workers?: number } | false;
}

export interface ResolvedServerWorld {
  data: VoxelWorldData;
  field: WorldField;
  streamer: ChunkStreamerData;
}

/** Find the scene's `voxelWorld` component and resolve its recipe (null = none / unregistered). */
export function resolveServerVoxelWorld(doc: SceneDoc, radiusCells?: number): ResolvedServerWorld | null {
  for (const entity of Object.values(doc.entities)) {
    const data = entity.components["voxelWorld"] as VoxelWorldData | undefined;
    if (!data) continue;
    const field = getVoxelWorld(data.world);
    if (!field) {
      console.warn(`[server:terrain] no world recipe "${data.world}" registered`);
      return null;
    }
    const sim = Math.max(1, radiusCells ?? Math.ceil(data.rings.simulation));
    const streamer: ChunkStreamerData = {
      source: data.world,
      cellSize: field.recipe.cellSize,
      radius: sim,
      keepPadding: data.keepPadding,
      // every ring collapses onto the simulation ring: the server has nothing
      // to render, so "loaded" and "simulated" are the same thing here
      rings: { simulation: sim, fullRender: sim, hlod: sim, farTerrain: sim },
      hlodSupercellFactor: data.hlodSupercellFactor,
    };
    return { data, field, streamer };
  }
  return null;
}

export class TerrainStreamer {
  readonly world: HeadlessWorld;
  /** Replaced wholesale by {@link applyEdits} — the field is a pure function of the recipe. */
  resolved: ResolvedServerWorld;
  private readonly options: VoxelChunkOptions;
  private readonly loadsPerStep: number;
  private readonly unloadsPerStep: number;
  private readonly loadBudgetMs: number;
  /** Cost of the last cell load, for diagnostics. */
  lastLoadMs = 0;
  /**
   * Running totals (diagnostics; a host diffs them per tick): cells generated INLINE on this thread (spawn
   * ensures, the no-worker fallback — the expensive kind) and cells integrated (doc → scene → physics, every
   * cell pays it), with the milliseconds each took.
   */
  readonly counters = { inlineLoads: 0, inlineMs: 0, integrated: 0, integrateMs: 0, uncovered: 0 };
  private pool: VoxelPool | null = null;
  /** Cells requested from the pool and not yet landed. */
  private readonly inflight = new Set<string>();
  /** Results that arrived between updates, integrated on the next one (bounded by the budget). */
  private readonly arrived: Array<{ key: string; cell: ChunkDoc; source: VoxelMeshSource | null; mesh: VoxelMesh | null }> = [];
  /** Resident cells: key -> entity ids the cell added. */
  private readonly loaded = new Map<string, string[]>();
  /** Per-cell representation from the last residency pass (hysteresis input). */
  private prev = new Map<string, ChunkRep>();
  /** Prefetched cells and when their hold ends (performance.now ms). */
  private readonly pins = new Map<string, number>();
  private limitCells: number;

  constructor(world: HeadlessWorld, resolved: ResolvedServerWorld, opts: TerrainStreamerOptions = {}) {
    this.world = world;
    this.resolved = resolved;
    this.loadsPerStep = opts.loadsPerStep ?? 2;
    this.unloadsPerStep = opts.unloadsPerStep ?? 4;
    this.loadBudgetMs = opts.loadBudgetMs ?? 6;
    this.options = {
      ...voxelChunkOptionsFrom(resolved.data),
      collision: true,
      assetExists: (id, kind) =>
        (kind === "prefab" ? world.assets.getPrefab(id) : world.assets.getModel(id)) !== undefined,
    };
    const limit = resolved.field.worldLimit;
    this.limitCells =
      limit === Infinity
        ? Infinity
        : (limit + (resolved.field.recipe.bounds?.limitFalloff ?? 600)) / resolved.field.recipe.cellSize + 2;
    const poolOpts = opts.pool === false ? null : (opts.pool ?? {});
    if (poolOpts && (poolOpts.workers ?? 1) > 0) {
      try {
        this.pool = new VoxelPool(poolOpts);
        this.initPool();
      } catch (error) {
        console.warn("[server:terrain] no generation workers, generating inline:", error);
        this.pool = null;
      }
    }
  }

  /** Threads generating cells (0 = inline). */
  get workers(): number {
    return this.pool?.size ?? 0;
  }

  /** Generation threads running right now (they start on demand and exit when idle). */
  get liveWorkers(): number {
    return this.pool?.live ?? 0;
  }

  private initPool(): void {
    if (!this.pool) return;
    const present: string[] = [];
    for (const rule of this.resolved.field.recipe.scatter) {
      const id = rule.prefab ?? rule.model;
      if (id && this.options.assetExists?.(id, rule.prefab ? "prefab" : "model")) present.push(id);
    }
    for (const poi of this.resolved.field.recipe.features.pois) {
      if (poi.prefab && this.options.assetExists?.(poi.prefab, "prefab")) present.push(poi.prefab);
    }
    this.pool.init(this.resolved.field.recipe, this.resolved.data.world, this.options, present);
  }

  dispose(): void {
    this.pool?.dispose();
    this.pool = null;
  }

  /** Resident cell keys. */
  cells(): string[] {
    return [...this.loaded.keys()];
  }

  has(cx: number, cz: number): boolean {
    return this.loaded.has(chunkKey(cx, cz));
  }

  /** Is this cell inside the world (past the limit is open sea floor nobody stands on)? */
  private inWorld(cx: number, cz: number): boolean {
    return Number.isFinite(cx) && Number.isFinite(cz) && Math.hypot(cx + 0.5, cz + 0.5) <= this.limitCells;
  }

  /**
   * Re-evaluate residency for these focus points and apply a bounded number
   * of loads/unloads. Call once per step (or every few) with every player's
   * position. With no foci, everything unloads over the following steps.
   */
  update(foci: ReadonlyArray<readonly [number, number, number]>): void {
    const s = this.resolved.streamer;
    const next = new Map<string, ChunkRep>();
    // computeChunkStates reads only the focus's ROUNDED cell, so foci sharing one are one computation (a crowd
    // in a town is a handful); and only previous states inside a focus's reach square can come out resident for
    // it, so each call is handed just those — it walked (and parsed) every resident cell once per focus
    const reach = this.reachCells();
    const centres = new Set<string>();
    const prevNear = new Map<string, ChunkRep>();
    for (const [x, , z] of foci) {
      const fcx = Math.round(x / s.cellSize);
      const fcz = Math.round(z / s.cellSize);
      const centre = chunkKey(fcx, fcz);
      if (centres.has(centre)) continue;
      centres.add(centre);
      prevNear.clear();
      for (let dz = -reach; dz <= reach; dz++) {
        for (let dx = -reach; dx <= reach; dx++) {
          const key = chunkKey(fcx + dx, fcz + dz);
          const rep = this.prev.get(key);
          if (rep) prevNear.set(key, rep);
        }
      }
      for (const [key, rep] of computeChunkStates({ x, z }, s, prevNear)) {
        if (!next.has(key)) next.set(key, rep);
      }
    }
    this.prev = next;
    // a focus standing in a cell that is not resident has no ground under it on this side (`uncovered`:
    // counted per focus per update — the evidence for "did the player run off the loaded world")
    for (const [x, , z] of foci) {
      const cx = Math.floor(x / s.cellSize);
      const cz = Math.floor(z / s.cellSize);
      if (this.inWorld(cx, cz) && !this.loaded.has(chunkKey(cx, cz))) this.counters.uncovered++;
    }
    // prefetched cells stay wanted until their hold runs out, whoever stands there (see prefetch)
    const now = performance.now();
    for (const [key, until] of this.pins) {
      if (until < now) this.pins.delete(key);
      else if (!next.has(key)) next.set(key, "simulation");
    }
    // loads: nearest to any focus first
    const wanted: Array<{ key: string; d: number }> = [];
    for (const key of next.keys()) {
      if (this.loaded.has(key)) continue;
      const coords = parseChunkKey(key);
      if (!coords || !this.inWorld(coords[0], coords[1])) continue;
      let d = Infinity;
      for (const [x, , z] of foci) {
        d = Math.min(d, Math.hypot(coords[0] + 0.5 - x / s.cellSize, coords[1] + 0.5 - z / s.cellSize));
      }
      wanted.push({ key, d });
    }
    wanted.sort((a, b) => a.d - b.d);
    const started = performance.now();
    // cells that came back from the workers land first — they are the cheap ones
    while (this.arrived.length > 0 && performance.now() - started <= this.loadBudgetMs) {
      const { key, cell, source, mesh } = this.arrived.shift()!;
      if (this.loaded.has(key) || !next.has(key)) continue; // unloaded (or ensured inline) while in flight
      if (source && mesh) primeVoxelMesh(source, mesh);
      this.integrate(key, cell);
    }
    for (const { key } of wanted) {
      if (this.pool && !this.pool.broken) {
        if (this.inflight.size >= this.loadsPerStep * 2) break;
        this.request(key);
        continue;
      }
      if (performance.now() - started > this.loadBudgetMs) break; // the rest next update
      this.load(key);
    }
    // unloads
    let unloaded = 0;
    for (const key of [...this.loaded.keys()]) {
      if (next.has(key)) continue;
      this.unload(key);
      if (++unloaded >= this.unloadsPerStep) break;
    }
  }

  /**
   * Ask for the ground within `metres` of a point AHEAD of need, on the worker threads: nothing is generated on
   * this thread. The cells are held resident for `holdSeconds` (from the last ask) whoever stands there, so
   * whoever is about to put weight on the spot — a pack about to wake, a joiner about to land — finds them.
   * True when every cell is resident now (then its props and buildings are ensured too). Without workers
   * this generates inline, as {@link ensureAround} does, and answers true.
   *
   * The pattern: `if (!terrain.prefetch(x, z)) return; // try again next pass` before spawning or resuming
   * a body — so the tick never waits ~60 ms per cell for generation and marching on its own thread.
   */
  prefetch(x: number, z: number, metres = this.resolved.streamer.cellSize, holdSeconds = 10): boolean {
    const size = this.resolved.streamer.cellSize;
    const until = performance.now() + holdSeconds * 1000;
    const async = !!this.pool && !this.pool.broken;
    let ready = true;
    for (let cz = Math.floor((z - metres) / size); cz <= Math.floor((z + metres) / size); cz++) {
      for (let cx = Math.floor((x - metres) / size); cx <= Math.floor((x + metres) / size); cx++) {
        if (!this.inWorld(cx, cz)) continue;
        const key = chunkKey(cx, cz);
        this.pins.set(key, Math.max(until, this.pins.get(key) ?? 0));
        if (this.loaded.has(key)) continue;
        if (async) {
          ready = false;
          this.request(key);
        } else this.load(key);
      }
    }
    if (ready) this.world.sim.ensureStaticsAround(x, z);
    return ready;
  }

  /** Cells held by {@link prefetch} right now (diagnostics). */
  get pinned(): number {
    return this.pins.size;
  }

  /** Force-load a cell now (spawn points want ground before a body lands). */
  ensure(cx: number, cz: number): void {
    const key = chunkKey(cx, cz);
    if (!this.loaded.has(key) && this.inWorld(cx, cz)) this.load(key);
  }

  /** Load every cell within `radius` cells of a world point, synchronously. */
  ensureAround(x: number, z: number, radius = 1): void {
    const size = this.resolved.streamer.cellSize;
    const cx = Math.floor(x / size);
    const cz = Math.floor(z / size);
    for (let dz = -radius; dz <= radius; dz++) {
      for (let dx = -radius; dx <= radius; dx++) this.ensure(cx + dx, cz + dz);
    }
    // the props and buildings standing on it too (when they stream, see HeadlessWorldOptions.streamStatics)
    this.world.sim.ensureStaticsAround(x, z);
  }

  /** Cells from a focus's cell that computeChunkStates can mark resident (its own square: far ring + padding). */
  private reachCells(): number {
    const s = this.resolved.streamer;
    const far = Math.max(s.radius, s.rings?.simulation ?? 0, s.rings?.fullRender ?? 0, s.rings?.hlod ?? 0, s.rings?.farTerrain ?? 0);
    return Math.ceil(far + (s.keepPadding ?? 0)) + 1;
  }

  /** Ask a worker for the cell; the result lands on a later update. */
  private request(key: string): void {
    if (this.inflight.has(key) || this.loaded.has(key) || !this.pool) return;
    const coords = parseChunkKey(key);
    if (!coords) return;
    this.inflight.add(key);
    const generation = this.pool.currentGeneration;
    this.pool
      .cell(coords[0], coords[1])
      .then((cell) => {
        this.inflight.delete(key);
        if (cell.generation !== generation || cell.generation !== this.pool?.currentGeneration) return; // recipe changed under it
        this.arrived.push({ key, cell: cell.doc, source: cell.source, mesh: cell.mesh });
      })
      .catch((error: unknown) => {
        this.inflight.delete(key);
        // a dead pool falls back to inline generation on the next update
        if (!(error instanceof Error && /disposed/.test(error.message))) {
          console.warn(`[server:terrain] worker could not generate ${key}:`, error);
        }
      });
  }

  /** Inline generation — spawn-time ensures and the no-worker fallback. */
  private load(key: string): void {
    const coords = parseChunkKey(key);
    if (!coords) return;
    const [cx, cz] = coords;
    const { field, data } = this.resolved;
    const started = performance.now();
    try {
      const cell = voxelChunkDoc(field, data.world, cx, cz, this.options);
      this.integrate(key, cell);
      this.lastLoadMs = performance.now() - started;
      this.counters.inlineLoads++;
      this.counters.inlineMs += this.lastLoadMs;
    } catch (error) {
      console.warn(`[server:terrain] cell ${key} failed to load:`, error);
      this.loaded.set(key, []); // don't retry every step
    }
  }

  /** doc → scene → sim: the part that has to happen on this thread. */
  private integrate(key: string, cell: ChunkDoc): void {
    const coords = parseChunkKey(key);
    if (!coords) return;
    const { streamer } = this.resolved;
    const started = performance.now();
    try {
      const { doc } = chunkToSceneDoc(streamer.source, coords[0], coords[1], streamer.cellSize, cell);
      const expanded = expandScene(doc, this.world.assets, this.world.registry);
      this.world.addEntities(expanded, { silent: true });
      this.loaded.set(key, Object.keys(expanded.entities));
    } catch (error) {
      console.warn(`[server:terrain] cell ${key} failed to integrate:`, error);
      this.loaded.set(key, []);
    }
    this.counters.integrated++;
    this.counters.integrateMs += performance.now() - started;
  }

  private unload(key: string): void {
    const ids = this.loaded.get(key);
    if (!ids) return;
    this.loaded.delete(key);
    this.world.removeEntities(ids, { silent: true });
  }

  /**
   * Ground height at (x, z) from the recipe field (not the collider) — for
   * spawn placement. `surfaceCast` marches the real density (blobs, tunnels,
   * caves included); `height` is the 2D landform and is the fallback where
   * the cast finds no surface.
   */
  groundHeight(x: number, z: number): number {
    const field = this.resolved.field;
    return field.surfaceCast(x, z) ?? field.height(x, z);
  }

  /**
   * Ground under a point that may be UNDERGROUND (a cave floor under a mountain). Where the open-air surface is within
   * 4 m above `y` this is `groundHeight`; where it is well above, the floor is found by casting down from the air just
   * over `y`. null = the column is solid rock around `y` (a spot past the cave wall): the caller picks another spot.
   */
  groundNear(x: number, z: number, y: number): number | null {
    const top = this.groundHeight(x, z);
    if (top - y <= 4) return top;
    const field = this.resolved.field;
    for (const up of [2, 1, 3, 0.5]) {
      const hit = field.surfaceCast(x, z, y + up, y - 6);
      if (hit !== null && hit < y + up - 0.01) return hit; // a cast that starts inside rock returns its own start
    }
    return null;
  }

  /**
   * TERRAFORM: apply a validated, invertible edit batch to the recipe, swap
   * the field, and re-cook only the resident cells the batch touched. The
   * recipe IS the world save, so the returned recipe is what to persist and
   * what to hand clients; `result.inverse` is the undo.
   *
   * Atomic: an invalid edit throws before anything changes.
   */
  applyEdits(edits: readonly RecipeEdit[]): { result: RecipeEditResult; reloaded: string[]; touchedCells: [number, number][] } {
    const before = this.resolved.field.recipe;
    const result = applyRecipeEdits(before, edits);
    const field = registerVoxelWorld(this.resolved.data.world, result.recipe);
    this.resolved = { ...this.resolved, field };
    // workers hold their own field: re-ship the recipe, and anything they
    // were generating against the old one is dropped by generation
    this.initPool();
    this.arrived.length = 0;
    const limit = field.worldLimit;
    this.limitCells =
      limit === Infinity ? Infinity : (limit + (field.recipe.bounds?.limitFalloff ?? 600)) / field.recipe.cellSize + 2;
    const touchedCells = cellsForEdits(result.recipe, result);
    const reloaded: string[] = [];
    for (const [cx, cz] of touchedCells) {
      const key = chunkKey(cx, cz);
      if (!this.loaded.has(key)) continue;
      this.unload(key);
      this.load(key);
      reloaded.push(key);
    }
    return { result, reloaded, touchedCells };
  }

  /**
   * Take a whole new recipe (another layer terraformed, or the agent's
   * weekly edit arrived from main) and re-cook every resident cell. The
   * coarse path — `applyEdits` is the precise one — used when the diff is
   * not known here.
   */
  replaceRecipe(recipe: WorldRecipe): string[] {
    const field = registerVoxelWorld(this.resolved.data.world, recipe);
    this.resolved = { ...this.resolved, field };
    this.initPool();
    this.arrived.length = 0;
    const limit = field.worldLimit;
    this.limitCells =
      limit === Infinity ? Infinity : (limit + (field.recipe.bounds?.limitFalloff ?? 600)) / field.recipe.cellSize + 2;
    const reloaded: string[] = [];
    for (const key of [...this.loaded.keys()]) {
      this.unload(key);
      this.load(key);
      reloaded.push(key);
    }
    return reloaded;
  }
}

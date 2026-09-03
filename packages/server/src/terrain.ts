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
  chunkKey,
  chunkToSceneDoc,
  computeChunkStates,
  expandScene,
  getVoxelWorld,
  parseChunkKey,
  voxelChunkDoc,
  voxelChunkOptionsFrom,
  type ChunkRep,
  type ChunkStreamerData,
  type SceneDoc,
  type VoxelChunkOptions,
  type VoxelWorldData,
  type WorldField,
} from "@hitreg/core";
import type { HeadlessWorld } from "./world.js";

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
  readonly resolved: ResolvedServerWorld;
  private readonly options: VoxelChunkOptions;
  private readonly loadsPerStep: number;
  private readonly unloadsPerStep: number;
  private readonly loadBudgetMs: number;
  /** Cost of the last cell load, for diagnostics. */
  lastLoadMs = 0;
  /** Resident cells: key -> entity ids the cell added. */
  private readonly loaded = new Map<string, string[]>();
  /** Per-cell representation from the last residency pass (hysteresis input). */
  private prev = new Map<string, ChunkRep>();
  private readonly limitCells: number;

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
    for (const [x, , z] of foci) {
      for (const [key, rep] of computeChunkStates({ x, z }, s, this.prev)) {
        if (!next.has(key)) next.set(key, rep);
      }
    }
    this.prev = next;
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
    for (const { key } of wanted.slice(0, this.loadsPerStep)) {
      this.load(key);
      if (performance.now() - started > this.loadBudgetMs) break; // the rest next update
    }
    // unloads
    let unloaded = 0;
    for (const key of [...this.loaded.keys()]) {
      if (next.has(key)) continue;
      this.unload(key);
      if (++unloaded >= this.unloadsPerStep) break;
    }
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
  }

  private load(key: string): void {
    const coords = parseChunkKey(key);
    if (!coords) return;
    const [cx, cz] = coords;
    const { field, data, streamer } = this.resolved;
    const started = performance.now();
    try {
      const cell = voxelChunkDoc(field, data.world, cx, cz, this.options);
      const { doc } = chunkToSceneDoc(streamer.source, cx, cz, streamer.cellSize, cell);
      const expanded = expandScene(doc, this.world.assets, this.world.registry);
      this.world.addEntities(expanded, { silent: true });
      this.loaded.set(key, Object.keys(expanded.entities));
      this.lastLoadMs = performance.now() - started;
    } catch (error) {
      console.warn(`[server:terrain] cell ${key} failed to load:`, error);
      this.loaded.set(key, []); // don't retry every step
    }
  }

  private unload(key: string): void {
    const ids = this.loaded.get(key);
    if (!ids) return;
    this.loaded.delete(key);
    this.world.removeEntities(ids, { silent: true });
  }

  /** Ground height at (x, z) from the recipe field (not the collider) — for spawn placement. */
  groundHeight(x: number, z: number): number {
    return this.resolved.field.height(x, z);
  }
}

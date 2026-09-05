import * as THREE from "three/webgpu";
import {
  assembleHlodBuildDoc,
  chunkDocSchema,
  chunkToSceneDoc,
  computeChunkStates,
  expandScene,
  parseChunkCoords,
  parseChunkKey,
  supercellForCell,
  validateScene,
  type AssetLibrary,
  type ChunkCell,
  type ChunkDoc,
  type ChunkRep,
  type ChunkStreamerData,
  type ComponentRegistry,
  type ProfilerLike,
  type SceneDoc,
} from "@hitreg/core";
import {
  batchStaticMeshes,
  buildScene,
  buildHlodProxy,
  freezeStaticSubtree,
  refreshStaticSubtree,
  thawStaticSubtree,
  type BuildOptions,
  type InstancedPropBatch,
  type StaticBatchHandle,
} from "@hitreg/render";
import type { PhysicsSim } from "@hitreg/physics";

/** simulation/fullRender cells only — hlod/far live in LoadedSupercell instead. */
interface LoadedChunk {
  group: THREE.Object3D;
  /** Expanded doc — physics bodies re-attach from this on every play session. */
  expanded: SceneDoc;
  /** Cached Object.keys(expanded.entities).length — see the stats getter. */
  entityCount: number;
  objects: Map<string, THREE.Object3D>;
  /** Current LOD representation from the ring state machine. */
  rep: ChunkRep;
  /** rep === "simulation": carries physics + scripts. Otherwise render-only. */
  simulated: boolean;
  /** Static draw-call merge for this cell’s props; disposed with the cell. */
  batch: StaticBatchHandle | null;
  /** This cell's instances in the world prop pool (BuildOptions.instancePool), released with the cell. */
  poolOwner: object;
}

/**
 * A merged HLOD proxy baked from MULTIPLE cells at once (hlodSupercellFactor),
 * not one cell. Cells at the hlod/far rings never get their own LoadedChunk —
 * per-cell proxies would re-fragment one asset's instanced batch into one
 * InstancedMesh per cell, which is exactly what regressed the last time this
 * engine's chunking was tightened (see ChunkStreamerData.hlodSupercellFactor).
 */
interface LoadedSupercell {
  group: THREE.Object3D;
  /**
   * The merged bakes this proxy is currently assembled from. A supercell is
   * NOT one bake: the far ring reaches a 4x4 block a couple of cells at a
   * time, so the block is built up in parts and each part is baked once. See
   * MAX_SUPERCELL_PARTS for why the list stays short.
   */
  parts: SupercellPart[];
  /** Union of every part's cells — "is this cell already proxied?" */
  cellKeys: Set<string>;
  /** Approximate, for the diagnostics HUD only (no per-entity objects exist). */
  entityCount: number;
  /** Baked at the far ring's coarseness (FAR_VOXEL_COARSEN); a rebuild after an edit keeps it. */
  far: boolean;
}

/**
 * A cell whose source document has ARRIVED (worker round-trip done) but whose
 * synchronous publish into the scene is still waiting for frame budget.
 *
 * Holding a document costs nothing but memory — no GPU resources exist yet, no
 * group has been created, so dropping one is free and instant. That is what
 * makes deferring this stage safe where deferring `scene.add` of an
 * already-built cell would not be: see integrateCell.
 */
interface PendingCell {
  key: string;
  cx: number;
  cz: number;
  cell: ChunkDoc;
  /** The streamer this was read for — a reconfigure invalidates it. */
  streamer: ChunkStreamerData;
  /** performance.now() at arrival, so the wait shows up in the build span. */
  arrivedAt: number;
}

/** One merged bake inside a supercell — the unit that is added and dropped. */
interface SupercellPart {
  /** Baked at the far ring's coarseness. */
  far: boolean;
  group: THREE.Object3D;
  cellKeys: Set<string>;
  entityCount: number;
}

/**
 * How many merged bakes one supercell may be assembled from before the next
 * growth consolidates it back into a single bake instead.
 *
 * The trade this number sets: parts cost draw calls (each is its own merged
 * mesh per material), a re-bake costs a main-thread stall proportional to the
 * WHOLE supercell. A play-mode profile caught the all-or-nothing end of that
 * trade: supercell `1_-4` was re-baked seven times as the far ring reached it
 * (2, 4, 6, 10, 14, 15 then 16 cells) — 67 cells of meshing to end up with 16,
 * and three of those re-bakes alone cost 719ms of stall to add two cells of
 * distant terrain. Growing by parts pays only for the two cells; the cap keeps
 * the draw-call side of the trade bounded.
 */
const MAX_SUPERCELL_PARTS = 4;

/**
 * "replace" bakes the given cells as a supercell's only part (a first build,
 * or a consolidation). "append" bakes them as one MORE part of a proxy that
 * already exists.
 */
type SupercellBakeMode = "replace" | "append";

/**
 * Lattice coarsening for supercells that lie wholly in the far ring (the
 * hlod ring keeps the builder's 4): 12 m voxels on a 48 m cell, a silhouette
 * and a splat and nothing else, which is all a kilometre away needs.
 */
const FAR_VOXEL_COARSEN = 6;

/**
 * Far-ring supercells are this many times wider than hlod-ring ones, per
 * axis — 8x8 cells for the default factor of 4. The far ring is where the
 * OBJECT count lives: with one grid for both rings a 28-cell far ring was 164
 * supercells of ~2.5 meshes each, and every one of them is visited by the
 * renderer's per-pass walk, frustum-tested and (when in view) a draw call. At
 * this coarseness a block's content is a handful of impostor batches over a
 * 6x-coarsened terrain mesh, so a 4x bigger block is not a 4x bigger bake.
 *
 * The two rings therefore keep separate key spaces (`f<scx>_<scz>` for far),
 * and a cell moving between them moves between blocks: a far block never
 * bakes a cell an hlod block currently holds, and re-bakes (replace, not
 * drop — no hole at 300 m) once an hlod block has taken one of its cells.
 */
const FAR_SUPERCELL_MULTIPLIER = 2;
const FAR_KEY_PREFIX = "f";

function supercellKeyFor(scx: number, scz: number, far: boolean): string {
  return far ? `${FAR_KEY_PREFIX}${scx}_${scz}` : `${scx}_${scz}`;
}

function isFarSupercellKey(key: string): boolean {
  return key.startsWith(FAR_KEY_PREFIX);
}

function parseSupercellKey(key: string): { scx: number; scz: number; far: boolean } | null {
  const far = isFarSupercellKey(key);
  const coords = parseChunkKey(far ? key.slice(FAR_KEY_PREFIX.length) : key);
  return coords ? { scx: coords[0], scz: coords[1], far } : null;
}

/** Cells per supercell axis for one ring's key space. */
function supercellFactor(base: number, far: boolean): number {
  return far ? base * FAR_SUPERCELL_MULTIPLIER : base;
}

/**
 * How many HLOD supercells may bake at once.
 *
 * Each bake is real synchronous work — meshing every member cell, merging the
 * result — spread across promise continuations. Left unbounded, crossing cells
 * while flying queued dozens of them, and because they interleave on the one
 * main thread, none finished promptly while all of them competed: a profile
 * caught 35 bakes in flight and a 2.6-second frame. A small cap makes each
 * bake finish quickly and the rest wait their turn, which is both faster
 * overall and far smoother.
 */
const MAX_CONCURRENT_SUPERCELL_BAKES = 2;

/**
 * How many cells may be AWAITING their source document at once.
 *
 * This used to be 3, justified on the grounds that "a load is mostly
 * synchronous main-thread work, so concurrency buys nothing here". That
 * reasoning is stale: cell generation moved to a Web Worker pool
 * (ChunkProvider.get -> voxel-world.ts's pool, sized
 * clamp(hardwareConcurrency - 2, 2, 6)), so a non-urgent cell now spends
 * nearly all of its `chunk.load` span — measured up to 1.4s under load —
 * simply waiting for a worker round-trip. Waiting costs the main thread
 * nothing, so capping it at 3 left ~6 workers half idle and throttled
 * streaming throughput at exactly the moment the player moves.
 *
 * The frame-evenness concern the old cap was really protecting is now handled
 * where it belongs: by CELL_INTEGRATION_BUDGET_MS below, which bounds the
 * SYNCHRONOUS part per frame regardless of how many results land at once.
 *
 * Matched to the worker count on purpose — more in flight than there are
 * workers just lengthens each cell's queue wait without producing cells any
 * faster. Recomputed lazily because this module is also imported by headless
 * tooling and tests, where `navigator` may not exist.
 */
let maxCellLoadsInFlight = 0;
function maxCellLoadsInFlightValue(): number {
  if (maxCellLoadsInFlight === 0) {
    const cores =
      typeof navigator !== "undefined" && navigator.hardwareConcurrency
        ? navigator.hardwareConcurrency
        : 4;
    maxCellLoadsInFlight = Math.max(2, Math.min(6, cores - 2));
  }
  return maxCellLoadsInFlight;
}

/**
 * How much main-thread time one frame may spend publishing arrived cells into
 * the scene (expandScene + buildScene + batchStaticMeshes + the add).
 *
 * A single cell's synchronous part measures ~6-18ms. With the in-flight cap
 * raised to the worker count, several results routinely land in the same tick,
 * and nothing used to stop all of them integrating back-to-back inside one
 * frame — which is precisely the "standing still is fine, moving kills it"
 * symptom. Draining against a budget spreads that burst over as many frames as
 * it takes, so frame time stays flat no matter how deep the arrival queue is.
 *
 * At least one cell is always integrated per drain: a cell that costs more
 * than the whole budget must still make progress, or a slow cell starves the
 * queue forever. So this is a floor on throughput, not a hard ceiling on the
 * frame — one over-budget cell can still overshoot, by design.
 */
export const CELL_INTEGRATION_BUDGET_MS = 2.5;

/**
 * How many arrived-but-not-yet-integrated cells may pile up before the
 * streamer stops starting new loads.
 *
 * Backpressure, not a performance knob: if cells are arriving faster than the
 * budget can publish them, generating still more of them buys nothing and just
 * holds their documents in memory. It also keeps the nearest-first scan over
 * the pending set trivially cheap.
 */
const MAX_PENDING_INTEGRATIONS = 16;

/** Monotonic ms. Falls back to Date.now where `performance` is absent (tests). */
function now(): number {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}

/** simulation cells render full meshes AND run physics + scripts. */
function isSimulated(rep: ChunkRep): boolean {
  return rep === "simulation";
}

/** hlod/far cells render as a cheap merged proxy (no physics/scripts/picking). */
function isProxy(rep: ChunkRep): boolean {
  return rep === "hlod" || rep === "far";
}

/**
 * Where a world's cells come from when they are not files on disk.
 *
 * A procedural (voxel) world plugs in here and gets the whole streaming stack
 * unchanged: residency rings, hysteresis, HLOD supercell merging, physics
 * attach/detach on the simulation boundary, instanced-batch disposal — all of
 * it already debugged against a real shipped game
 * (docs/performance-lessons.md). The alternative, a parallel streamer for
 * generated content, would mean re-finding every one of those bugs.
 */
export interface ChunkProvider {
  /** Does this world have a cell here? A procedural world says yes everywhere in its bounds. */
  has(cx: number, cz: number): boolean;
  /**
   * The cell's source document — generated, not read. May be async.
   *
   * `urgent` marks a cell the SIMULATION ring wants: something is about to
   * stand on it, so its collider has to exist now rather than a few frames
   * from now. A provider that generates off-thread should generate an urgent
   * cell inline instead — the player spawning into a world whose ground has
   * not arrived yet falls through it, and no amount of streaming smoothness is
   * worth that. Urgent cells are a handful near the focus; the bulk of the
   * work (render-only rings, and HLOD bakes that read up to 16 cells at once)
   * is not urgent and is where moving off-thread actually pays.
   */
  get(cx: number, cz: number, urgent?: boolean): ChunkDoc | null | Promise<ChunkDoc | null>;
}

export interface ChunkLifecycle {
  /**
   * A chunk entered the runtime. `simulated` is false for render-only LOD
   * rings (fullRender/hlod/far) — the caller renders them but must NOT start
   * scripts or gameplay for them.
   */
  onLoaded?: (doc: SceneDoc, objects: Map<string, THREE.Object3D>, simulated: boolean) => void;
  /**
   * A chunk cell's group was re-parented into a freshly rebuilt scene (every
   * `rebuild()` replaces `THREE.Scene`/`BuiltScene`) — the cell itself is
   * unchanged, already-loaded content, NOT a new load. The app must redo
   * per-rebuild bookkeeping keyed off the new `BuiltScene` (e.g. re-index
   * `built.objects`) but must NOT redo genuine "just loaded" side effects
   * like script (re-)registration — see onLoaded. Without this distinction,
   * every scene edit re-fires the full onLoaded lifecycle (including a
   * `scripts.addEntities` pass and `entity.spawned` events) for every
   * currently-streamed entity, which is ruinous for a large loaded chunk.
   */
  onReattached?: (doc: SceneDoc, objects: Map<string, THREE.Object3D>, simulated: boolean) => void;
  onUnloaded?: (ids: Iterable<string>) => void;
  /**
   * A group was just added to the scene: compile its shader pipelines now,
   * in the BACKGROUND, so the first frame that happens to look at it does not
   * compile them synchronously inside render(). Never awaited by the caller —
   * see EngineRenderer.precompileGroup for why gating the add is not an option.
   */
  precompile?: (group: THREE.Object3D) => void;
  /** A `renderMode: "instanced"` batch's chunk unloaded — unregister it from
   * whatever FoliageLodSystem tracks it before its meshes get disposed. */
  onDisposeInstancedBatch?: (batch: InstancedPropBatch) => void;
  /**
   * A cell crossed the simulation/fullRender boundary WITHOUT a mesh rebuild
   * (see ChunkManager.retier) — attach scripts to the already-built objects.
   * Physics attach is handled by ChunkManager itself (setSim owns `sim`).
   */
  onSimulationGained?: (doc: SceneDoc, objects: Map<string, THREE.Object3D>) => void;
  /** Counterpart to onSimulationGained: detach scripts, meshes stay put. */
  onSimulationLost?: (ids: Iterable<string>) => void;
}

/**
 * Streams chunk files (assets/chunks/<world>/<cx>_<cz>.chunk.json) in and out
 * around a focus point. Chunk content is RUNTIME-ONLY: it renders and collides
 * but never enters the scene document, so autosave/undo/diff stay clean.
 * Chunk JSON is validated with the same component schemas as scenes — invalid
 * files are rejected with a warning and load nothing.
 *
 * Residency is distance-based LOD (streaming plan §4): each cell's state comes
 * from `computeChunkStates` — `simulation` cells render + simulate, the outer
 * `fullRender`/`hlod`/`far` rings render only (no physics/scripts). With no
 * `rings` configured every cell resolves to `simulation`, i.e. the original
 * binary load-within-radius behavior, unchanged.
 */
export class ChunkManager {
  private streamer: ChunkStreamerData | null = null;
  /** "cx_cz" -> chunk file name, from the assets index. */
  private available = new Map<string, string>();
  /** Procedural cell source; when set, `available` is unused (see setProvider). */
  private provider: ChunkProvider | null = null;
  private loaded = new Map<string, LoadedChunk>();
  /** hlod/far ring cells, grouped and baked by supercell — see LoadedSupercell. */
  private loadedSupercells = new Map<string, LoadedSupercell>();
  /** Cells awaiting their source document (worker/fetch) — the ASYNC cap. */
  private inFlight = new Set<string>();
  /** Cells whose document arrived, awaiting frame budget — the SYNC cap. */
  private pending = new Map<string, PendingCell>();
  /**
   * Baked supercells waiting to be shown, drained under the same frame budget
   * as cells.
   *
   * Publishing a supercell is NOT free just because the meshing happened in a
   * worker: it builds THREE geometry from the transferred buffers, parents it,
   * refreshes the frozen subtree's matrices and — on a `replace` — disposes
   * the stale parts, which for a 15-cell block is a lot of GPU objects at once.
   * That ran in a promise continuation, i.e. BETWEEN frames, where no scope
   * timer sees it: a profile with 20.5ms of JS and 13.7ms of GPU still showed
   * 62ms/frame off-loop, with `hlod.supercell` spans of 428-520ms.
   *
   * Deferring these is safe in a way deferring a CELL is not: an HLOD proxy is
   * far-field visuals only and carries no collider, so nothing can fall through
   * a supercell that shows up two frames later.
   */
  private pendingSupercells: Array<() => void> = [];
  private inFlightSupercells = new Set<string>();
  /** Pending cell loads, newest-first; drained by pumpCellQueue. */
  private cellQueue: string[] = [];
  /** The residency the CURRENT focus wants, keyed by cell — the queue reads it at pump time. */
  private desiredCells = new Map<string, ChunkRep>();
  /** Pending supercell bakes, newest-first; drained by pumpSupercellQueue. */
  private supercellQueue: Array<{ key: string; members: Set<string>; mode: SupercellBakeMode; far: boolean }> = [];
  /** Supercell keys the CURRENT focus wants — used to drop stale queue entries. */
  private desiredSupercells = new Set<string>();
  /** Bumped on every unload/reload of a given supercell key so an in-flight
   * loadSupercell() whose async glTF-merge work outlives that change can tell
   * its result is stale and must be discarded instead of published. */
  private supercellEpoch = new Map<string, number>();
  private scene: THREE.Scene | null = null;
  private sim: PhysicsSim | null = null;
  private lastFocus: [number, number] | null = null;
  /**
   * Desired-but-unbaked supercells at the last queue refill, so a refill only
   * happens while it is making progress (a supercell whose cells all fail
   * would otherwise re-queue forever).
   */
  private lastRefillMissing = Infinity;
  /** "cx_cz" cells force-unloaded regardless of proximity — currently open for
   * isolation editing (main.ts's editChunkCell), which renders its own
   * editable copy in place of the normal streamed one. */
  private suppressed = new Set<string>();
  /**
   * Optional frame profiler. Chunk loads are async, so their cost lands in
   * promise continuations BETWEEN frames — invisible to any scope timed
   * inside the frame callback. They are recorded as spans instead, which is
   * what makes "that 120ms stall was cell 4_-7 expanding and building" a
   * readable line on the profiler's marker timeline rather than an
   * unexplained gap in the frame graph.
   */
  profiler: ProfilerLike | undefined;


  constructor(
    private readonly assets: AssetLibrary,
    private readonly registry: ComponentRegistry,
    private readonly buildOptions: BuildOptions,
    private readonly lifecycle: ChunkLifecycle = {},
  ) {}

  /**
   * Chunk/entity counts split by residency, for diagnostics.
   *
   * Reads `chunk.entityCount` rather than `Object.keys(...).length`: this is
   * polled every frame by the profiler's counter sampler, and materialising a
   * key array per loaded cell made it O(total streamed entities) per read —
   * 4,700 string allocations a frame on a fully-resident island, which showed
   * up as 2% of total CPU in a real profile. An instrument must not be
   * expensive enough to appear in its own measurements.
   */
  get stats(): { chunks: number; entities: number; simulated: number; proxied: number; loading: number } {
    let entities = 0;
    let simulated = 0;
    for (const chunk of this.loaded.values()) {
      entities += chunk.entityCount;
      if (chunk.simulated) simulated += 1;
    }
    let proxiedCells = 0;
    for (const sc of this.loadedSupercells.values()) {
      entities += sc.entityCount;
      proxiedCells += sc.cellKeys.size;
    }
    return {
      chunks: this.loaded.size + proxiedCells,
      entities,
      simulated,
      proxied: proxiedCells,
      loading: this.inFlight.size + this.pending.size + this.inFlightSupercells.size,
    };
  }

  /** Visit currently SIMULATED chunks when a play-session runtime starts. */
  forEachLoaded(fn: (doc: SceneDoc, objects: Map<string, THREE.Object3D>) => void): void {
    for (const chunk of this.loaded.values()) {
      if (chunk.simulated) fn(chunk.expanded, chunk.objects);
    }
  }

  /** Called from rebuild(): the streamer component (or null) and the new scene. */
  async configure(streamer: ChunkStreamerData | null, scene: THREE.Scene): Promise<void> {
    this.scene = scene;
    const worldChanged = streamer?.source !== this.streamer?.source;
    this.streamer = streamer;
    if (!streamer || worldChanged) this.unloadAll();
    if (!streamer) return;
    // re-parent surviving groups into the rebuilt scene — NOT a fresh load
    for (const chunk of this.loaded.values()) {
      scene.add(chunk.group);
      this.lifecycle.onReattached?.(chunk.expanded, chunk.objects, chunk.simulated);
    }
    for (const sc of this.loadedSupercells.values()) scene.add(sc.group);
    // the world prop pool's pages live outside any cell's group
    if (this.buildOptions.instancePool) scene.add(this.buildOptions.instancePool.group);
    await this.refreshIndex();
    this.lastFocus = null; // force a re-evaluation on the next update
  }

  /**
   * Install (or clear) a procedural cell source. With a provider set, cells
   * are generated on demand and the on-disk chunk index is not consulted at
   * all — a generated world has no files and no bounded cell list.
   */
  setProvider(provider: ChunkProvider | null): void {
    if (this.provider === provider) return;
    this.provider = provider;
    this.unloadAll();
    this.lastFocus = null;
  }

  /** True when this world can supply the cell — file index, or provider. */
  private hasCell(key: string): boolean {
    if (this.provider) {
      const coords = parseChunkKey(key);
      return coords !== null && this.provider.has(coords[0], coords[1]);
    }
    return this.available.has(key);
  }

  /**
   * Drop and re-stream every resident cell. The procedural counterpart of
   * `onFileChanged`: when a world RECIPE is edited, every generated cell in
   * the world is stale at once, so there is nothing finer to invalidate.
   */
  reloadAll(): void {
    this.pending.clear();
    this.pendingSupercells.length = 0; // every arrived doc was generated from the stale recipe
    for (const [key, chunk] of [...this.loaded]) this.unload(key, chunk);
    for (const scKey of [...this.loadedSupercells.keys()]) this.unloadSupercell(scKey);
    this.lastFocus = null;
  }

  /** Re-read which chunk files exist (startup + when chunk files are added). */
  async refreshIndex(): Promise<void> {
    if (!this.streamer) return;
    if (this.provider) return; // generated worlds have no file index to read
    try {
      const index = (await fetch("/__hitreg/assets-index").then((r) => r.json())) as {
        chunks?: string[];
      };
      this.available.clear();
      const prefix = `${this.streamer.source}/`;
      for (const file of index.chunks ?? []) {
        if (!file.startsWith(prefix)) continue;
        const coords = parseChunkCoords(file);
        if (coords) this.available.set(`${coords[0]}_${coords[1]}`, file);
      }
    } catch {
      /* prod build: no bridge, no streaming */
    }
  }

  /** Physics attach/detach: play sessions come and go, chunks persist. */
  setSim(sim: PhysicsSim | null): void {
    this.sim = sim;
    if (!sim) return;
    for (const chunk of this.loaded.values()) {
      if (chunk.simulated) sim.addEntities(chunk.expanded);
    }
  }

  /** Currently-loaded cells, for a "chunk sections" UI list — reflects proximity
   * automatically, since `loaded` only ever holds cells within the streaming rings. */
  loadedCells(): Array<{ world: string; cx: number; cz: number; count: number }> {
    const world = this.streamer?.source;
    if (!world) return [];
    const out: Array<{ world: string; cx: number; cz: number; count: number }> = [];
    for (const [key, chunk] of this.loaded) {
      const coords = parseChunkKey(key);
      if (!coords) continue;
      out.push({ world, cx: coords[0], cz: coords[1], count: Object.keys(chunk.expanded.entities).length });
    }
    return out;
  }

  /** Force-unload a cell and keep it from streaming back in until unsuppressed —
   * isolation-editing it (main.ts's editChunkCell) shows an editable copy instead. */
  suppressCell(cx: number, cz: number): void {
    const key = `${cx}_${cz}`;
    this.suppressed.add(key);
    // drop it before it can publish; the drain skips suppressed keys anyway,
    // but an inline (simulation) integration would already have gone through
    this.pending.delete(key);
    const chunk = this.loaded.get(key);
    if (chunk) this.unload(key, chunk);
    // it may instead be baked into a proxy supercell — tear the whole thing down;
    // the next residency pass rebuilds it without this (now-suppressed) member
    for (const [scKey, sc] of [...this.loadedSupercells]) {
      if (sc.cellKeys.has(key)) this.unloadSupercell(scKey);
    }
  }

  /** Resume normal streamed residency for a cell suppressed via suppressCell. */
  unsuppressCell(cx: number, cz: number): void {
    this.suppressed.delete(`${cx}_${cz}`);
    this.lastFocus = null; // force a re-evaluation so it can reload if still in range
  }

  /**
   * Drive residency from the focus position, and publish whatever cells have
   * arrived since the last frame. Called EVERY frame by the app.
   *
   * The residency pass below is cheap unless the focus changed cells, but the
   * integration drain runs unconditionally and before that early return — it
   * is the only per-frame hook ChunkManager has, and cells finish generating
   * on worker timing, not on cell crossings.
   */
  update(fx: number, fz: number): void {
    const s = this.streamer;
    if (!s || !this.scene) return;
    this.drainPendingSupercells();
    this.drainPendingCells(fx, fz);
    const cx = Math.round(fx / s.cellSize);
    const cz = Math.round(fz / s.cellSize);
    if (this.lastFocus && this.lastFocus[0] === cx && this.lastFocus[1] === cz) return;
    if (!this.lastFocus || this.lastFocus[0] !== cx || this.lastFocus[1] !== cz) this.lastRefillMissing = Infinity;
    this.lastFocus = [cx, cz];

    // feed current reps back in so the ring hysteresis holds cells on a boundary.
    // Supercell-covered cells don't carry an exact rep (hlod vs far collapses to
    // one representation either way) — "hlod" is a fine stand-in for hysteresis.
    const prev = new Map<string, ChunkRep>();
    for (const [key, chunk] of this.loaded) prev.set(key, chunk.rep);
    for (const sc of this.loadedSupercells.values()) {
      for (const key of sc.cellKeys) if (!prev.has(key)) prev.set(key, "hlod");
    }
    const target = computeChunkStates({ x: fx, z: fz }, s, prev);

    // Everything below runs only on a cell crossing, so it never shows up in
    // an average — but a crossing is exactly when the world hitches, and the
    // dispose pass inside the per-cell loop is real synchronous GPU-resource
    // work. Scoped separately from the supercell pass because they fail
    // differently: cells stall on dispose, supercells on merge/rebake.
    this.profiler?.begin("cells");

    // -- simulation/fullRender cells: per-cell load/unload, unchanged --
    for (const [key, rep] of target) {
      if (isProxy(rep)) continue; // handled by the supercell pass below
      if (this.suppressed.has(key)) continue; // isolation-editing owns this cell right now
      if (!this.hasCell(key)) continue; // this world has no cell here
      const chunk = this.loaded.get(key);
      if (!chunk) {
        // `pending` counts as in-flight: its document is already here and is
        // about to be published, so re-queueing would build the cell twice.
        if (!this.inFlight.has(key) && !this.pending.has(key)) this.queueCell(key);
      } else if (chunk.simulated !== isSimulated(rep)) {
        // crossed the simulation/fullRender boundary: both tiers render the
        // SAME full-detail meshes (the only difference is physics+scripts),
        // so retier in place instead of a full dispose+rebuild. A blanket
        // unload+load here was measured (CDP profile) costing 250ms+ of
        // main-thread stall per crossing — WebGPU pipeline/shader rebuild
        // for materials the renderer treats as brand new — on every ~2-4s of
        // continuous flight at normal speed. Nothing about this transition
        // needs new geometry, so don't pay for it.
        this.retier(chunk, rep);
      } else {
        chunk.rep = rep; // detail label shifted but render/sim behavior is the same
      }
    }
    // per-cell chunks that fell out of every ring, or now belong at a proxy
    // ring instead, unload (the proxy pass below reloads the latter as part
    // of a supercell)
    for (const [key, chunk] of this.loaded) {
      const rep = target.get(key);
      if (!rep || isProxy(rep)) this.unload(key, chunk);
    }
    // `target` is the authority on what a queued load should become — and on
    // whether it is still wanted at all by the time its turn arrives
    this.desiredCells = target;
    this.pumpCellQueue();
    this.profiler?.end();
    this.profiler?.begin("supercells");

    // -- hlod/far cells: group into supercells, one merged proxy per group --
    const factor = Math.max(1, Math.floor(s.hlodSupercellFactor));
    // Two key spaces: hlod-ring cells group on the base grid, far-ring cells
    // on a FAR_SUPERCELL_MULTIPLIER-wider one (and are meshed coarser still,
    // FAR_VOXEL_COARSEN, which is what lets the ring reach a kilometre for the
    // same bake and triangle budget).
    const desired = new Map<string, Set<string>>(); // supercell key -> member "cx_cz" keys
    for (const [key, rep] of target) {
      if (!isProxy(rep)) continue;
      if (this.suppressed.has(key)) continue;
      if (!this.hasCell(key)) continue;
      const coords = parseChunkKey(key);
      if (!coords) continue;
      const far = rep === "far";
      const [scx, scz] = supercellForCell(coords[0], coords[1], supercellFactor(factor, far));
      const scKey = supercellKeyFor(scx, scz, far);
      let members = desired.get(scKey);
      if (!members) {
        members = new Set();
        desired.set(scKey, members);
      }
      members.add(key);
    }
    // A cell an hlod block currently holds is never wanted by a far block:
    // the hlod block keeps drawing it (finer, and kept on purpose — see
    // SHRANK below) until it unloads, at which point the far block finds the
    // cell missing and appends it. Without this, moving away double-drew
    // every cell along the hlod/far boundary.
    const hlodHeld = new Set<string>();
    for (const [scKey, sc] of this.loadedSupercells) {
      if (isFarSupercellKey(scKey)) continue;
      for (const key of sc.cellKeys) hlodHeld.add(key);
    }
    for (const [scKey, members] of desired) {
      if (!isFarSupercellKey(scKey)) continue;
      for (const key of hlodHeld) members.delete(key);
      if (members.size === 0) desired.delete(scKey);
    }
    // Merged geometry cannot be edited in place, so every membership change
    // is a bake of SOMETHING. Which something is the whole cost, and the three
    // ways a supercell's membership moves each want a different answer:
    //
    //   GREW (the far ring reached more of the block) -> bake ONLY the new
    //        cells, as an extra part under the same group. Re-baking the whole
    //        block here is what a play-mode profile caught costing 719ms of
    //        stall to add two cells; see MAX_SUPERCELL_PARTS.
    //   SHRANK, cells simply out of range -> KEEP IT. The extra cells are
    //        distant scenery that costs a little memory and draws in the same
    //        merged call. Rebuilding to remove them buys nothing you can see.
    //   SHRANK, cells PROMOTED to a near ring -> must drop the parts holding
    //        them. Those cells are about to load again at full detail as their
    //        own chunks, and a proxy that still contains them draws the same
    //        terrain and props twice, z-fighting. This is not an optimisation:
    //        keeping them is a correctness bug (see below).
    //
    // Flying forward shrinks every trailing supercell and grows the leading
    // ones. Treating both as "changed" meant re-baking most of the far ring on
    // every cell crossing — dozens of concurrent bakes, each up to 2.5s.
    this.desiredSupercells = new Set(desired.keys());
    // Cells the near rings own THIS pass. `desired` above only tells us which
    // cells want proxying; it cannot distinguish "left the world" from "got
    // promoted", and only the second one double-draws.
    //
    // ACTUALLY loaded, not merely desired. `target` is what each cell WANTS to
    // be; a promoted cell still has to clear the load queue, a worker
    // round-trip (measured at over a second under load) and the frame budget
    // before it exists. Dropping its proxy on intent alone left nothing drawn
    // at that spot for the whole interval — a hole in the terrain with the
    // ocean visible through it, exactly at the moment a cell "goes to higher
    // resolution". Waiting for `loaded` costs a brief overlap where the coarse
    // proxy and the fine cell both draw, which is far cheaper to look at than
    // a hole, and it self-corrects on the next pass.
    const nearOwned = new Set<string>();
    for (const [key, rep] of target) if (!isProxy(rep) && this.loaded.has(key)) nearOwned.add(key);
    for (const [scKey, sc] of [...this.loadedSupercells]) {
      const members = desired.get(scKey);
      if (!members) {
        this.unloadSupercell(scKey);
        continue;
      }
      // correctness first: a part holding a now-near cell has to go. Its other
      // cells go with it (a part is one merged mesh) and come back on the
      // growth pass below, in the same refresh, as a fresh part.
      const promoted = [...sc.cellKeys].filter((key) => nearOwned.has(key));
      if (promoted.length > 0) this.dropSupercellParts(scKey, sc, promoted);
      if (!this.loadedSupercells.has(scKey)) continue; // dropped its last part
      if (this.inFlightSupercells.has(scKey)) continue; // a bake is already catching up
      // the far/hlod boundary moved through this far block: an hlod block now
      // holds some of its cells, so it draws them twice (coarser, underneath).
      // Re-bake it without them. A replace, not a drop: the old parts stay
      // until the new bake lands, so the horizon never opens a hole.
      if (sc.far) {
        let overlapped = false;
        for (const key of sc.cellKeys) {
          if (hlodHeld.has(key)) {
            overlapped = true;
            break;
          }
        }
        if (overlapped) {
          this.queueSupercell(scKey, members, "replace", true);
          continue;
        }
      }
      const missing = new Set([...members].filter((key) => !sc.cellKeys.has(key)));
      if (missing.size === 0) continue;
      if (sc.parts.length >= MAX_SUPERCELL_PARTS) {
        // consolidate: one bake of the whole block instead of a fifth part.
        // Queued, NOT unloaded first — loadSupercell swaps the merged block in
        // before freeing the parts it replaces, so the far ring never shows a
        // hole for the ~200ms the bake takes.
        this.queueSupercell(scKey, members, "replace", isFarSupercellKey(scKey));
      } else {
        this.queueSupercell(scKey, missing, "append", isFarSupercellKey(scKey));
      }
    }
    for (const [scKey, members] of desired) {
      if (this.loadedSupercells.has(scKey) || this.inFlightSupercells.has(scKey)) continue;
      this.queueSupercell(scKey, members, "replace", isFarSupercellKey(scKey));
    }
    this.pumpSupercellQueue();
    this.profiler?.end();
  }

  /**
   * Remove every part of a supercell that contains any of `keys`, freeing its
   * GPU resources. Parts are merged meshes, so a part is all-or-nothing: cells
   * that merely shared a part with a promoted one are dropped too and re-bake
   * on the next growth pass, which is cheap and self-healing.
   */
  private dropSupercellParts(scKey: string, sc: LoadedSupercell, keys: readonly string[]): void {
    const doomed = new Set(keys);
    const kept: SupercellPart[] = [];
    for (const part of sc.parts) {
      let hit = false;
      for (const key of part.cellKeys) {
        if (doomed.has(key)) {
          hit = true;
          break;
        }
      }
      if (!hit) {
        kept.push(part);
        continue;
      }
      this.disposeGroup(part.group);
      sc.entityCount -= part.entityCount;
      for (const key of part.cellKeys) sc.cellKeys.delete(key);
    }
    sc.parts = kept;
    sc.entityCount = Math.max(0, sc.entityCount);
    if (kept.length === 0) this.unloadSupercell(scKey);
  }

  /** Live-sync: a chunk file changed on disk — hot-swap it if relevant. */
  async onFileChanged(file: string, content: string | null): Promise<void> {
    const s = this.streamer;
    if (!s || !file.startsWith(`${s.source}/`)) return;
    const coords = parseChunkCoords(file);
    if (!coords) return;
    const key = `${coords[0]}_${coords[1]}`;
    // whatever is queued for this key was read before the edit — stale either
    // way, and the branches below either re-read it or drop it entirely
    this.pending.delete(key);
    if (content === null) {
      this.available.delete(key);
      const chunk = this.loaded.get(key);
      if (chunk) this.unload(key, chunk);
      for (const [scKey, sc] of [...this.loadedSupercells]) {
        if (sc.cellKeys.has(key)) this.unloadSupercell(scKey);
      }
      return;
    }
    this.available.set(key, file);
    const chunk = this.loaded.get(key);
    if (chunk) {
      const rep = chunk.rep; // hot-swap keeps its current residency
      this.unload(key, chunk);
      await this.load(key, rep, content);
      return;
    }
    // it may instead be part of a loaded proxy supercell — rebuild that whole
    // group so the edit shows up (merged geometry can't be patched in place)
    for (const [scKey, sc] of [...this.loadedSupercells]) {
      if (sc.cellKeys.has(key)) {
        const members = new Set(sc.cellKeys);
        this.unloadSupercell(scKey);
        this.queueSupercell(scKey, members, "replace", sc.far);
        this.pumpSupercellQueue();
        return;
      }
    }
    this.lastFocus = null; // new file may be in range — re-evaluate
  }

  /**
   * One cell's source document, from wherever this world's cells come from:
   * a `.chunk.json` file on disk, or a {@link ChunkProvider} generating it.
   * Returns null (with a warning where a warning is warranted) rather than
   * throwing — one bad cell must never take the streamer down with it.
   */
  private async readCell(
    key: string,
    cx: number,
    cz: number,
    rawContent?: string,
    urgent = false,
  ): Promise<ChunkDoc | null> {
    if (this.provider && rawContent === undefined) {
      try {
        return await this.provider.get(cx, cz, urgent);
      } catch (error) {
        console.warn(`[chunks] provider failed for ${key}:`, error);
        return null;
      }
    }
    const file = this.available.get(key);
    if (!file) return null;
    const content: string =
      rawContent ??
      (await fetch(`/__hitreg/asset-file?file=${encodeURIComponent(`chunks/${file}`)}`).then(
        (r) => r.text(),
      ));
    const parsed = chunkDocSchema.safeParse(JSON.parse(content));
    if (!parsed.success) {
      console.warn(`[chunks] ${file} failed validation:`, parsed.error.message.slice(0, 300));
      return null;
    }
    return parsed.data;
  }

  /**
   * ASYNC half of a cell load: get the source document and hand it to the
   * integration queue. simulation/fullRender only — hlod/far reps never reach
   * here, see loadSupercell.
   *
   * Nothing here touches the scene, so this is the stage the in-flight cap
   * bounds and the stage that may run many-at-once: it is a worker round-trip
   * (or a fetch) plus a `then`.
   *
   * SIMULATION cells skip the queue entirely and integrate inline. Their
   * colliders are cooked from the built objects, so a simulation cell that
   * waits for frame budget is ground the player can fall through — the same
   * reason `readCell` passes them the provider's `urgent` flag. They are a
   * handful of cells around the focus; the bulk of the streaming work is the
   * render-only rings, which is where the budget actually applies.
   */
  private async load(key: string, rep: ChunkRep, rawContent?: string): Promise<void> {
    const s = this.streamer;
    const coords = parseChunkKey(key);
    if (!s || !coords || !this.scene || !this.hasCell(key)) return;
    this.inFlight.add(key);
    // Measures ACQUISITION only now (generate/fetch), not the publish — the
    // synchronous half is `chunk.build`, in integrateCell, which reports the
    // queue wait it incurred here.
    const endLoad = this.profiler?.span("chunk.load", `${key} (${rep})`);
    let arrived: ChunkDoc | null = null;
    try {
      arrived = await this.readCell(key, coords[0], coords[1], rawContent, isSimulated(rep));
    } catch (error) {
      console.warn(`[chunks] failed to load cell ${key}:`, error);
    } finally {
      this.inFlight.delete(key);
      endLoad?.();
    }
    if (!arrived) return;
    // streamer may have been reconfigured while we fetched
    if (this.streamer !== s || !this.scene) return;
    const entry: PendingCell = {
      key,
      cx: coords[0],
      cz: coords[1],
      cell: arrived,
      streamer: s,
      arrivedAt: now(),
    };
    // A hot-swap (onFileChanged) is also inline: the point of a live edit is
    // that it shows up now, and exactly one cell is involved.
    if (isSimulated(rep) || rawContent !== undefined) {
      this.integrateCell(entry, rep);
      return;
    }
    this.pending.set(key, entry);
  }

  /**
   * Publish arrived cells into the scene until the frame budget runs out,
   * nearest-first. Called once per frame from `update`.
   *
   * Nearest-first mirrors `queueCell`'s policy one stage later: by the time a
   * cell's document arrives the focus has usually moved, and the cell the
   * player is about to see is not necessarily the one that finished first.
   */
  /**
   * Show at most one baked supercell per frame.
   *
   * One is enough: a supercell covers a 4x4 block of cells, so even one per
   * frame keeps the far ring well ahead of the player, and publishing several
   * together is exactly the burst that was landing off-loop. Unlike cells this
   * needs no distance ordering — the far ring has no gameplay urgency — and no
   * inline bypass, because an HLOD proxy carries no collider.
   */
  private drainPendingSupercells(): void {
    const publish = this.pendingSupercells.shift();
    if (publish) publish();
  }

  private drainPendingCells(fx: number, fz: number): void {
    if (this.pending.size === 0) return;
    const s = this.streamer;
    if (!s) return;
    const started = now();
    let integrated = 0;
    while (this.pending.size > 0) {
      // Always let the first cell through: one cell costing more than the
      // whole budget must still make progress or the queue never drains.
      if (integrated > 0 && now() - started >= CELL_INTEGRATION_BUDGET_MS) break;
      let best: PendingCell | null = null;
      let bestDist = Infinity;
      for (const entry of this.pending.values()) {
        // Drop, for free, anything that stopped being wanted while it waited —
        // no group, no GPU resources, nothing to dispose.
        if (
          entry.streamer !== s ||
          this.loaded.has(entry.key) ||
          this.suppressed.has(entry.key) ||
          !this.hasCell(entry.key)
        ) {
          this.pending.delete(entry.key);
          continue;
        }
        const rep = this.desiredCells.get(entry.key);
        if (!rep || isProxy(rep)) {
          this.pending.delete(entry.key);
          continue;
        }
        const dx = entry.cx * s.cellSize - fx;
        const dz = entry.cz * s.cellSize - fz;
        const dist = dx * dx + dz * dz;
        if (dist < bestDist) {
          bestDist = dist;
          best = entry;
        }
      }
      if (!best) break;
      this.pending.delete(best.key);
      // `desiredCells` is the authority on what a cell should become by the
      // time it publishes, exactly as in pumpCellQueue — re-read rather than
      // trusting the rep it was requested with.
      this.integrateCell(best, this.desiredCells.get(best.key) ?? "fullRender");
      integrated += 1;
    }
    // integrating freed integration slots — the backpressure gate may have
    // been holding queued loads back
    if (this.cellQueue.length > 0) this.pumpCellQueue();
  }

  /**
   * SYNCHRONOUS half of a cell load: doc -> scene. This is the part that drops
   * a frame, and the part `CELL_INTEGRATION_BUDGET_MS` bounds.
   *
   * Once this runs it runs to completion. It must NOT be split further or made
   * async: the add of an already-built group is what the ground under the
   * player depends on (see the comment on `this.scene.add` below).
   */
  private integrateCell(entry: PendingCell, rep: ChunkRep): void {
    const { key, cell } = entry;
    const s = entry.streamer;
    if (this.streamer !== s || !this.scene) return;
    try {
      const { doc } = chunkToSceneDoc(s.source, entry.cx, entry.cz, s.cellSize, cell);
      const issues = validateScene(doc, this.registry);
      if (issues.length > 0) {
        console.warn(`[chunks] cell ${key} has invalid components:`, issues);
        return;
      }
      // Everything from here down is SYNCHRONOUS main-thread work — prefab
      // expansion, geometry/material construction, collider creation. This
      // is the part that actually drops a frame, so it gets its own span
      // separate from the fetch it followed. `waited` is the time it spent in
      // the integration queue: a large one means the budget is the
      // bottleneck, not generation.
      const waited = Math.round(now() - entry.arrivedAt);
      const expanded = expandScene(doc, this.assets, this.registry);
      const endBuild = this.profiler?.span(
        "chunk.build",
        `${key} · ${Object.keys(expanded.entities).length} entities · waited ${waited}ms`,
      );
      const group = new THREE.Group();
      group.name = `chunk:${key}`;
      // a fresh token per load: the cell's instanced props land in the world
      // pool under it (possibly after this cell has already unloaded — the
      // model load is async — which is why the pool wants a token and not
      // the cell key)
      const poolOwner = {};
      const built = buildScene(
        expanded,
        this.buildOptions.instancePool ? { ...this.buildOptions, instancePoolOwner: poolOwner } : this.buildOptions,
      );
      group.add(built.scene);
      // Merge this cell's static props into one draw call per material.
      //
      // The scene's own `rebuildStaticBatch` only ever ran over the base
      // document, so streamed content — which in a generated world is
      // essentially ALL the content — was never batched: a cell of 200
      // scattered props issued 200+ draw calls. Batching per cell (rather than
      // globally) keeps it incremental and keeps per-cell frustum culling,
      // since a cell is small enough to cull as a unit.
      //
      // Terrain is excluded by construction: it is not flagged static, and
      // `batchStaticMeshes` refuses geometry carrying custom attributes (the
      // splat weights) anyway.
      const batch = batchStaticMeshes(built.scene);
      const simulated = isSimulated(rep);
      // Add FIRST — the collider for streamed terrain is cooked from these
      // built objects, so anything that delays this delays the ground under
      // the player — then compile the shaders in the background, so the frame
      // that first looks at this cell is not the frame that compiles it.
      this.scene.add(group);
      this.lifecycle.precompile?.(group);
      // A render-only cell is, by definition, content nothing is allowed to
      // move: it carries no physics bodies and no scripts. Freezing its world
      // matrices takes the whole cell out of the renderer's per-frame matrix
      // walk — the largest single main-thread cost in a streamed world — and
      // `retier()` thaws it again the moment it gains simulation.
      if (!simulated) freezeStaticSubtree(group);
      const chunk: LoadedChunk = {
        group,
        expanded,
        entityCount: Object.keys(expanded.entities).length,
        objects: built.objects,
        rep,
        simulated,
        batch,
        poolOwner,
      };
      this.loaded.set(key, chunk);
      if (simulated) this.sim?.addEntities(expanded); // render-only rings never collide
      this.lifecycle.onLoaded?.(expanded, built.objects, simulated);
      endBuild?.();
    } catch (error) {
      console.warn(`[chunks] failed to integrate cell ${key}:`, error);
    }
  }

  /**
   * Queue a cell load, newest-first — the cells nearest the front of the
   * flight path are the ones about to be visible.
   */
  private queueCell(key: string): void {
    const existing = this.cellQueue.indexOf(key);
    if (existing >= 0) this.cellQueue.splice(existing, 1);
    this.cellQueue.unshift(key);
    if (this.cellQueue.length > 256) this.cellQueue.length = 256;
  }

  /**
   * Start cell ACQUISITIONS up to the in-flight cap.
   *
   * The old version of this comment argued that concurrency "buys nothing"
   * because a load is mostly synchronous main-thread work. That was true when
   * generation ran inline; it is not true now that `ChunkProvider.get` hands
   * non-urgent cells to a worker pool. What runs concurrently here is waiting,
   * and waiting is free — so this cap is sized to the worker count, and the
   * synchronous half is bounded separately by the per-frame integration budget
   * (see CELL_INTEGRATION_BUDGET_MS and drainPendingCells).
   *
   * The second gate is backpressure, not a stall: if arrived cells are already
   * backed up waiting for frame budget, generating more of them only grows the
   * backlog. drainPendingCells re-pumps as it clears them.
   */
  private pumpCellQueue(): void {
    while (
      this.inFlight.size < maxCellLoadsInFlightValue() &&
      this.pending.size < MAX_PENDING_INTEGRATIONS &&
      this.cellQueue.length > 0
    ) {
      const key = this.cellQueue.shift()!;
      if (
        this.loaded.has(key) ||
        this.inFlight.has(key) ||
        this.pending.has(key) ||
        this.suppressed.has(key)
      )
        continue;
      const rep = this.desiredCells.get(key);
      if (!rep || isProxy(rep)) continue; // left the ring, or belongs to a supercell now
      void this.load(key, rep).finally(() => this.pumpCellQueue());
    }
  }

  /**
   * Queue a supercell bake, newest-first.
   *
   * Newest-first matters while moving: the queue is a list of things the
   * player is flying toward, and by the time an older entry runs the focus has
   * usually left it behind. A stale entry is dropped at pump time rather than
   * baked and thrown away.
   */
  private queueSupercell(
    scKey: string,
    members: ReadonlySet<string>,
    mode: SupercellBakeMode,
    far: boolean,
  ): void {
    const existing = this.supercellQueue.findIndex((item) => item.key === scKey);
    // A queued append is a delta against a proxy that may since have been
    // dropped or replaced, so a later entry for the same key always wins —
    // and merging two appends would lose one of their cell sets. Re-deriving
    // the delta on the next residency pass is both cheaper and always right.
    if (existing >= 0) this.supercellQueue.splice(existing, 1);
    this.supercellQueue.unshift({ key: scKey, members: new Set(members), mode, far });
    // bound the backlog: a long flight can enqueue the whole far ring, and
    // anything that far down the list is guaranteed stale by the time it runs
    if (this.supercellQueue.length > 64) this.supercellQueue.length = 64;
  }

  /** Start bakes up to the concurrency cap, skipping entries that went stale. */
  private pumpSupercellQueue(): void {
    while (
      this.inFlightSupercells.size < MAX_CONCURRENT_SUPERCELL_BAKES &&
      this.supercellQueue.length > 0
    ) {
      const next = this.supercellQueue.shift()!;
      if (this.inFlightSupercells.has(next.key)) continue;
      // "append" is a DELTA against a specific proxy: if that proxy is gone
      // (unloaded, or every part dropped), the delta means nothing and the
      // residency pass owns the key again. "replace" needs no such check — it
      // is self-sufficient either way, a first build or a consolidation.
      if (next.mode === "append" && !this.loadedSupercells.has(next.key)) continue;
      if (!this.desiredSupercells.has(next.key)) continue; // moved on since it was queued
      void this.loadSupercell(next.key, next.members, next.mode, next.far).finally(() =>
        this.pumpSupercellQueue(),
      );
    }
    // The queue is capped (see queueSupercell) and only a residency pass
    // refills it — and that pass runs only when the focus crosses a cell. A
    // far ring wider than the cap left the rest of it desired but never baked
    // while the camera stood still: from a peak, 109 of 175 supercells
    // simply missing. When the queue drains with desired supercells still
    // unbaked, force the next update() to re-run residency, as long as each
    // refill made progress.
    if (this.supercellQueue.length === 0 && this.inFlightSupercells.size === 0) {
      let missing = 0;
      for (const key of this.desiredSupercells) if (!this.loadedSupercells.has(key)) missing++;
      if (missing > 0 && missing < this.lastRefillMissing) {
        this.lastRefillMissing = missing;
        this.lastFocus = null;
      }
    }
  }

  /**
   * Fetch every member cell and bake ONE merged HLOD proxy for the whole
   * group — the fix for hlod-supercell fragmentation (see LoadedSupercell).
   * A cell that fails to fetch/parse is skipped with a warning rather than
   * failing the whole supercell, matching the per-cell load()'s tolerance.
   */
  private async loadSupercell(
    scKey: string,
    memberKeys: ReadonlySet<string>,
    mode: SupercellBakeMode,
    far = false,
  ): Promise<void> {
    const s = this.streamer;
    if (!s || !this.scene) return;
    const parsed = parseSupercellKey(scKey);
    if (!parsed) return;
    const { scx, scz } = parsed;
    this.inFlightSupercells.add(scKey);
    const endLoad = this.profiler?.span(
      "hlod.supercell",
      `${scKey} · ${memberKeys.size} cells (${mode})`,
    );
    const epoch = (this.supercellEpoch.get(scKey) ?? 0) + 1;
    this.supercellEpoch.set(scKey, epoch);
    try {
      const cells: ChunkCell[] = [];
      for (const key of memberKeys) {
        const cellCoords = parseChunkKey(key);
        if (!cellCoords || !this.hasCell(key)) continue;
        try {
          const doc = await this.readCell(key, cellCoords[0], cellCoords[1]);
          if (doc) cells.push({ cx: cellCoords[0], cz: cellCoords[1], doc });
        } catch (error) {
          console.warn(`[chunks] failed to load ${key}:`, error);
        }
      }
      // streamer may have been reconfigured while we fetched, or this
      // supercell's desired membership may have already moved on
      if (this.streamer !== s || !this.scene || cells.length === 0) return;
      const factor = supercellFactor(Math.max(1, Math.floor(s.hlodSupercellFactor)), parsed.far);
      const build = assembleHlodBuildDoc(scx, scz, cells, {
        cellSize: s.cellSize,
        factor,
        world: s.source,
        assets: this.assets,
        registry: this.registry,
      });
      const built = await buildHlodProxy(
        build.doc,
        far ? { ...this.buildOptions, hlodVoxelCoarsen: FAR_VOXEL_COARSEN } : this.buildOptions,
      );
      // buildHlodProxy now loads/merges glTFs (slower than the plain-JSON
      // fetches above), widening the window for this supercell to have been
      // unloaded or reloaded (onFileChanged's unload+reload, or a membership
      // change in refresh()) while we were still building — recheck the
      // epoch before publishing, and dispose rather than leaking the GPU
      // resources we just built into a scene/map entry nothing points at.
      if (this.streamer !== s || !this.scene || this.supercellEpoch.get(scKey) !== epoch) {
        this.disposeGroup(built.group);
        return;
      }
      const entityCount = cells.reduce((n, c) => n + Object.keys(c.doc.entities).length, 0);
      // The origin is a function of the supercell key alone, never of which
      // cells went into this bake — which is exactly what lets a part cover a
      // subset of the block and still land in the right place.
      built.group.position.set(build.origin[0], build.origin[1], build.origin[2]);
      const part: SupercellPart = {
        group: built.group,
        cellKeys: new Set(cells.map((c) => `${c.cx}_${c.cz}`)),
        entityCount,
        far,
      };
      // queue the publish; `update()` drains it under the frame budget
      this.pendingSupercells.push(() => this.publishSupercell(scKey, part, mode, epoch));
      return;
    } catch (error) {
      console.warn(`[chunks] failed to bake supercell ${scKey}:`, error);
      return;
    } finally {
      this.inFlightSupercells.delete(scKey);
      endLoad?.();
    }
  }

  /** The synchronous half of a supercell bake. Runs under the frame budget. */
  private publishSupercell(
    scKey: string,
    part: SupercellPart,
    mode: SupercellBakeMode,
    epoch: number,
  ): void {
    // the bake may have been superseded while this sat in the queue
    if (!this.scene || this.supercellEpoch.get(scKey) !== epoch) {
      this.disposeGroup(part.group);
      return;
    }
    // an hlod block landing on cells a far block still draws: residency runs
    // only on a cell crossing, so ask for one — it re-bakes that far block
    // without the overlap (see the far/hlod boundary note in refresh)
    if (!part.far) {
      for (const [otherKey, other] of this.loadedSupercells) {
        if (!isFarSupercellKey(otherKey)) continue;
        let overlap = false;
        for (const key of part.cellKeys) {
          if (other.cellKeys.has(key)) {
            overlap = true;
            break;
          }
        }
        if (overlap) {
          this.lastFocus = null;
          break;
        }
      }
    }
    const entityCount = part.entityCount;
    {
      const existing = this.loadedSupercells.get(scKey);
      if (existing && mode === "append") {
        existing.group.add(part.group);
        // the supercell root is frozen, so a newly added part would otherwise
        // keep the identity world matrix it was built with
        refreshStaticSubtree(existing.group);
        existing.parts.push(part);
        for (const key of part.cellKeys) existing.cellKeys.add(key);
        existing.entityCount += entityCount;
        return;
      }
      if (existing) {
        // consolidation. Add before disposing so there is no frame in which
        // this supercell is missing from the scene.
        existing.group.add(part.group);
        refreshStaticSubtree(existing.group);
        for (const stale of existing.parts) this.disposeGroup(stale.group);
        existing.parts = [part];
        existing.cellKeys = new Set(part.cellKeys);
        existing.entityCount = entityCount;
        return;
      }
      const group = new THREE.Group();
      group.name = `hlod-supercell:${scKey}`;
      group.add(part.group);
      this.scene.add(group);
      this.lifecycle.precompile?.(group);
      // a far-field HLOD proxy is merged, baked geometry — it can never move
      freezeStaticSubtree(group);
      this.loadedSupercells.set(scKey, {
        group,
        parts: [part],
        cellKeys: new Set(part.cellKeys),
        entityCount,
        far: part.far,
      });
    }
  }

  private unloadSupercell(scKey: string): void {
    // bump unconditionally, even with nothing published yet — this is what
    // tells an in-flight loadSupercell() for this key (still awaiting its
    // glTF merge) that it's been superseded and must discard its result.
    this.supercellEpoch.set(scKey, (this.supercellEpoch.get(scKey) ?? 0) + 1);
    const sc = this.loadedSupercells.get(scKey);
    if (!sc) return;
    this.disposeGroup(sc.group);
    this.loadedSupercells.delete(scKey);
  }

  /**
   * Cross the simulation/fullRender boundary without touching `chunk.group`'s
   * meshes — see the call site's comment. Only physics + scripts (de)attach.
   */
  private retier(chunk: LoadedChunk, rep: ChunkRep): void {
    const nowSimulated = isSimulated(rep);
    if (nowSimulated) {
      // scripts and rigid bodies are about to be attached, so this cell's
      // transforms are live again — see freezeStaticSubtree's contract
      thawStaticSubtree(chunk.group);
      this.sim?.addEntities(chunk.expanded);
      this.lifecycle.onSimulationGained?.(chunk.expanded, chunk.objects);
    } else {
      this.sim?.removeEntities(Object.keys(chunk.expanded.entities));
      this.lifecycle.onSimulationLost?.(Object.keys(chunk.expanded.entities));
      freezeStaticSubtree(chunk.group);
    }
    chunk.simulated = nowSimulated;
    chunk.rep = rep;
  }

  private unload(key: string, chunk: LoadedChunk): void {
    // restore the source meshes first: dispose() puts them back so disposeGroup
    // frees the real geometries rather than only the merged copies
    chunk.batch?.dispose();
    this.buildOptions.instancePool?.release(chunk.poolOwner);
    this.disposeGroup(chunk.group);
    if (chunk.simulated) this.sim?.removeEntities(Object.keys(chunk.expanded.entities));
    this.lifecycle.onUnloaded?.(Object.keys(chunk.expanded.entities));
    this.loaded.delete(key);
  }

  /** Detach + free GPU resources for a chunk or supercell proxy group. */
  private disposeGroup(group: THREE.Object3D): void {
    group.removeFromParent();
    group.traverse((node) => {
      const mesh = node as THREE.Mesh;
      if (mesh.isMesh) {
        // Materials are never disposed here: scene-builder.ts caches them by
        // asset id (or, for instanced props, by assetId+node+submesh) SHARED
        // across every chunk that ever builds the same content — disposing
        // one chunk's reference would break every other chunk still using
        // the exact same Material object and its compiled WebGPU pipeline.
        // Confirmed via CPU profiling that recompiling shaders per chunk
        // load was ~40-53% of frame-time spikes during sustained flight;
        // the tradeoff is a small, bounded set of never-freed compiled
        // materials (bounded by unique material COUNT, not entity count),
        // which is a clear win over paying a fresh compile per chunk forever.
        if (!mesh.userData["sharedGeometry"]) mesh.geometry?.dispose();
        // A THREE.InstancedMesh owns its instance-matrix GPU buffer
        // separately from `geometry` — without this it leaks one buffer per
        // unload. (Prop batches are InstancedProps now, whose instance buffer
        // lives IN the geometry and went with the dispose above.)
        if ((mesh as THREE.InstancedMesh).isInstancedMesh) (mesh as THREE.InstancedMesh).dispose();
        const batch = mesh.userData["foliageLodBatch"] as InstancedPropBatch | undefined;
        if (batch) this.lifecycle.onDisposeInstancedBatch?.(batch);
      }
    });
  }

  private unloadAll(): void {
    this.cellQueue.length = 0;
    // arrived-but-unpublished docs own no GPU resources — dropping them is free
    this.pending.clear();
    this.pendingSupercells.length = 0;
    this.desiredCells.clear();
    this.supercellQueue.length = 0;
    this.desiredSupercells.clear();
    for (const [key, chunk] of [...this.loaded]) this.unload(key, chunk);
    for (const scKey of [...this.loadedSupercells.keys()]) this.unloadSupercell(scKey);
  }
}

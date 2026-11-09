import { assetFileUrl, assetIndexUrl } from "./asset-url.js";
import * as THREE from "three/webgpu";
import {
  assembleHlodBuildDoc,
  chunkDocSchema,
  chunkToSceneDoc,
  cellLoadPriority,
  computeLeadChunkStates,
  expandScene,
  FocusVelocity,
  streamLeadPoint,
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
  cullRootIndex,
  cullRootsOf,
  registerCullRoots,
  type CullingSystem,
  type CullRoot,
  type CullUnit,
  freezeStaticSubtree,
  refreshStaticSubtree,
  thawStaticSubtree,
  type BuildOptions,
  type InstancedPropBatch,
  type StaticBatchHandle,
  STATIC_BATCH_FLAG,
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
  /** Culling roots (POIs, `culling` entities) of `expanded`, parents first. */
  cullRoots: CullRoot[];
  /** Registered culling units: the cell's own (render-only cells) first, then its roots'. */
  cullUnits: CullUnit[];
  /** The built scene root the batch merged (re-merged when models land after the build). */
  root: THREE.Object3D;
  /** Static models of this cell still loading when it was batched (async glTF); 0 = the batch saw every one. */
  lateModels: number;
}

/** A re-merge waits this long after a cell's last late model, so a cell whose models land together merges once. */
export const CHUNK_REBATCH_DELAY_MS = 250;
/** Cells re-merged per update at most: each is a synchronous merge of one cell. */
export const CHUNK_REBATCH_PER_UPDATE = 2;

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
  /** Its horizon-culling unit, once published. */
  cullUnit?: CullUnit;
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
 * Extra bake slots reserved for URGENT supercell bakes: the re-bake of a block whose cell was just promoted to full
 * detail. Until it lands the block's impostors and coarse terrain keep drawing over the real cell, which is the "LOD"
 * a player runs up to and sees not swap. The far ring keeps both normal slots busy for minutes at a time (40-60 bakes
 * queued, measured on Redstrand), so an urgent bake waiting for a free normal slot waited for the far ring to finish.
 */
const URGENT_SUPERCELL_BAKES = 1;

/**
 * How many of an HLOD bake's member cells may be in flight at once.
 *
 * The bake used to `await` them one at a time — up to 64 sequential worker
 * round-trips, measured at 3,576ms for one far block, with five of six
 * workers idle throughout. They are independent, so ask for them together.
 * The cap is not about the pool (its own priority queue bounds that); it is
 * about not handing that queue several hundred low-priority jobs from a
 * couple of concurrent bakes, since each one costs a linear scan to skip.
 */
const SUPERCELL_FETCH_CONCURRENCY = 8;

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
 * The integration budget while the focus moves fast (a sprint, a mount, a
 * fly-cam): a 9.5 m/s sprint crosses a 48 m cell every five seconds and every
 * crossing brings a new row of full-detail cells, so 2.5 ms a frame fell
 * behind and the player ran into cells still waiting to be published
 * (owner report 2026-10-22). Raised only while the frames themselves are
 * cheap (see FAST_BUDGET_MAX_FRAME_MS) — the budget may not create the stall
 * it is avoiding.
 */
export const CELL_INTEGRATION_BUDGET_FAST_MS = 6;
/**
 * The integration budget while nobody is looking: the host's load screen or boot curtain is up, or the world is
 * streaming in for the first time. One cell costs 6-18 ms, so the 2.5 ms budget admits ONE cell a frame and a
 * ~1100-cell world took as many frames to appear — 90-160 s at load-time frame rates, with the terrain cache
 * warm (measured 2026-10-27). Behind a curtain there is no frame to keep flat; the only thing that matters is
 * how soon the curtain can drop.
 */
export const CELL_INTEGRATION_BUDGET_BURST_MS = 40;
/** Supercell (HLOD) publishes per frame while bursting; otherwise one. */
const SUPERCELL_PUBLISHES_BURST = 4;
/** Speed (units/s) above which the fast budget applies. */
const FAST_BUDGET_SPEED = 4;
/** Smoothed frame interval above which the fast budget is withheld. */
const FAST_BUDGET_MAX_FRAME_MS = 25;

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
 * How badly a cell is wanted — the provider's scheduling hint.
 *
 * - `inline`: the SIMULATION ring. Something is about to stand on it, so its
 *   collider has to exist now rather than a few frames from now; a provider
 *   that generates off-thread should generate this one on the calling thread
 *   instead. A player spawning into a world whose ground has not arrived
 *   falls through it, and no amount of streaming smoothness is worth that.
 * - `near`: a render ring the player can see. Off-thread, but FIRST.
 * - `bulk`: one of the up-to-64 member cells of an HLOD supercell bake. The
 *   bake cannot publish until it has all of them, so no single one is urgent —
 *   and there are enough of them to bury the near ring if they are not marked.
 */
export type ChunkUrgency = "inline" | "near" | "bulk";

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
   * See {@link ChunkUrgency} for what the hint means and why ignoring it
   * costs the player ground under their feet.
   */
  get(cx: number, cz: number, urgency?: ChunkUrgency): ChunkDoc | null | Promise<ChunkDoc | null>;
  /**
   * Identity of the CELLS this provider produces — not of the provider object.
   *
   * A provider is rebuilt from scratch on every scene rebuild, and a scene
   * rebuild happens on every non-reconcilable edit and every asset live-sync.
   * Comparing the objects therefore said "new world" every time, and
   * `setProvider` answered by unloading the whole streamed world: a profiler
   * snapshot of the MMO caught the chunk counter going from 2,693 to 1 while
   * the player was simply standing in a town, with the ground then taking
   * minutes to come back at 4s a cell. The scene-doc content stayed (it is
   * rebuilt, not streamed), so what it looks like from inside the game is the
   * terrain vanishing from under the buildings.
   *
   * So providers say when they are equivalent instead. Any value compared with
   * `Object.is` — for a generated world the object identity of the world FIELD
   * plus its options, which is precisely "the same recipe would produce the
   * same cells". Undefined means "assume different", the old behaviour.
   *
   * The trade-off this accepts: an edit to a MODEL or MATERIAL that streamed
   * cells use no longer re-renders them, because the cells are kept. That is
   * what `refreshChunks()` is for, and it is a far smaller surprise than
   * losing the world.
   */
  readonly key?: unknown;
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
   * (Hiding the group until the compile settled was tried on 2026-10-27 and
   * reverted: the load's synchronous builds were REBUILDS of already-drawn
   * materials, not first draws — see docs/performance-lessons.md.)
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
  private supercellQueue: Array<{ key: string; members: Set<string>; mode: SupercellBakeMode; far: boolean; urgent: boolean }> = [];
  /** Keys of the in-flight bakes that were started as urgent (a subset of inFlightSupercells). */
  private inFlightUrgent = new Set<string>();
  /**
   * Runtime A/B switch: promotion re-bakes jump the supercell queue and get their own bake slot. Off = the old
   * single newest-first queue, where every residency pass re-queued the still-missing far ring AHEAD of them, so a
   * moving player (who triggers a pass on every crossing) starved them until they stopped.
   */
  urgentPromotions = true;
  /** Supercell keys the CURRENT focus wants — used to drop stale queue entries. */
  private desiredSupercells = new Set<string>();
  /** Bumped on every unload/reload of a given supercell key so an in-flight
   * loadSupercell() whose async glTF-merge work outlives that change can tell
   * its result is stale and must be discarded instead of published. */
  private supercellEpoch = new Map<string, number>();
  private scene: THREE.Scene | null = null;
  private sim: PhysicsSim | null = null;
  private lastFocus: [number, number] | null = null;
  /** The focus position update() was last fed (world units). */
  private focusX = 0;
  private focusZ = 0;
  /**
   * Velocity-led streaming (packages/core stream-lead.ts): the focus velocity,
   * estimated from the positions update() is fed, and the LEAD point it
   * projects. Residency takes every cell either the focus or the lead point
   * wants, and loads go nearest-the-lead first, so a sprinting player's ring
   * runs ahead of them instead of trailing behind. Standing still, lead =
   * focus and nothing changes.
   */
  private readonly focusVelocity = new FocusVelocity();
  /**
   * Runtime A/B switch for everything velocity-led (lead residency, lead-first
   * queue order, the fast integration budget, worker generation for lead-ahead
   * simulation cells). Off = the previous focus-centred behaviour exactly.
   * tools/sprint-probe.mts --ab flips it inside one page session.
   */
  leadStreaming = true;
  /**
   * Set by the host while its load screen / boot curtain is up or the world is streaming in for the first time:
   * cells and supercells publish under CELL_INTEGRATION_BUDGET_BURST_MS instead of the per-frame pacing budgets.
   */
  integrationBurst = false;
  private lead = { x: 0, z: 0 };
  private lastLeadCell: [number, number] | null = null;
  /** Smoothed interval between update() calls (≈ the frame time), for the fast budget's cap. */
  private frameMs = 16.7;
  private lastUpdateAt = -1;
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
  /**
   * Culling (packages/render/src/culling.ts): every published cell and HLOD
   * part stamps its terrain into the horizon and registers as a unit.
   */
  private culling: CullingSystem | null = null;


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

  /**
   * Attach the culling system. Cells already resident are registered now,
   * so attaching late (or re-attaching after a rebuild) misses nothing.
   */
  setCulling(culling: CullingSystem | null): void {
    if (this.culling === culling) return;
    for (const chunk of this.loaded.values()) this.unregisterCulling(chunk);
    for (const sc of this.loadedSupercells.values()) for (const part of sc.parts) this.unregisterPart(part);
    this.culling = culling;
    if (!culling) return;
    for (const [key, chunk] of this.loaded) {
      this.stampCell(key, chunk.group);
      this.registerCulling(chunk);
    }
    for (const sc of this.loadedSupercells.values()) for (const part of sc.parts) this.registerPart(part);
  }

  /**
   * A cell's drawn terrain becomes the horizon's occluder there. Replaces
   * whatever the cell's previous representation stamped.
   */
  private stampCell(key: string, group: THREE.Object3D): void {
    const culling = this.culling;
    const s = this.streamer;
    const coords = this.cellCoords(key);
    if (!culling || !s || !coords) return;
    const size = s.cellSize;
    const rect = { minX: coords[0] * size, minZ: coords[1] * size, maxX: (coords[0] + 1) * size, maxZ: (coords[1] + 1) * size };
    culling.occluders.clearRect(rect.minX, rect.minZ, rect.maxX, rect.maxZ);
    group.updateWorldMatrix(true, true);
    group.traverse((node) => {
      const mesh = node as THREE.Mesh;
      if (mesh.isMesh && mesh.userData["voxelSource"]) culling.occluders.stampGeometry(mesh.geometry, mesh.matrixWorld, rect);
    });
  }

  /** The cell unit (render-only cells: simulated ones hold moving things) and its roots' units. */
  private registerCulling(chunk: LoadedChunk): void {
    const culling = this.culling;
    if (!culling || chunk.cullUnits.length > 0) return;
    const pool = this.buildOptions.instancePool;
    const cell = chunk.simulated
      ? undefined
      : culling.register({
          name: chunk.group.name,
          objects: [chunk.group],
          ...(pool ? { pool: { pool, owner: chunk.poolOwner, ids: null } } : {}),
        });
    const roots = registerCullRoots(culling, chunk.cullRoots, chunk.objects, chunk.batch, {
      ...(cell ? { parent: cell } : {}),
      ...(pool ? { pool: { pool, owner: chunk.poolOwner } } : {}),
    });
    chunk.cullUnits = cell ? [cell, ...roots] : roots;
  }

  private unregisterCulling(chunk: LoadedChunk): void {
    // nothing registered without a culling system (and hand-built test chunks carry none)
    if (!this.culling || !chunk.cullUnits) return;
    for (const unit of chunk.cullUnits) this.culling.unregister(unit);
    chunk.cullUnits = [];
  }

  /** A published HLOD part: stamp its coarse terrain for its cells, and cull it whole. */
  private registerPart(part: SupercellPart): void {
    const culling = this.culling;
    const s = this.streamer;
    if (!culling || !s || part.cullUnit) return;
    const size = s.cellSize;
    const cells = new Set<number>();
    let minX = Infinity;
    let minZ = Infinity;
    let maxX = -Infinity;
    let maxZ = -Infinity;
    for (const key of part.cellKeys) {
      const coords = this.cellCoords(key);
      if (!coords) continue;
      cells.add((coords[0] + 32768) * 65536 + (coords[1] + 32768));
      culling.occluders.clearRect(coords[0] * size, coords[1] * size, (coords[0] + 1) * size, (coords[1] + 1) * size);
      minX = Math.min(minX, coords[0] * size);
      minZ = Math.min(minZ, coords[1] * size);
      maxX = Math.max(maxX, (coords[0] + 1) * size);
      maxZ = Math.max(maxZ, (coords[1] + 1) * size);
    }
    if (cells.size > 0) {
      const square = culling.occluders.square;
      const allow = (sx: number, sz: number): boolean =>
        cells.has((Math.floor((sx * square) / size) + 32768) * 65536 + (Math.floor((sz * square) / size) + 32768));
      part.group.updateWorldMatrix(true, true);
      part.group.traverse((node) => {
        const mesh = node as THREE.Mesh;
        if (mesh.isMesh && mesh.userData["terrainProxy"]) {
          culling.occluders.stampGeometry(mesh.geometry, mesh.matrixWorld, { minX, minZ, maxX, maxZ }, allow);
        }
      });
    }
    part.cullUnit = culling.register({ name: `hlod-part:${[...part.cellKeys][0] ?? ""}`, objects: [part.group] });
  }

  private unregisterPart(part: SupercellPart): void {
    if (part.cullUnit) this.culling?.unregister(part.cullUnit);
    delete part.cullUnit;
  }

  /** Called from rebuild(): the streamer component (or null) and the new scene. */
  async configure(streamer: ChunkStreamerData | null, scene: THREE.Scene): Promise<void> {
    this.scene = scene;
    const worldChanged = streamer?.source !== this.streamer?.source;
    this.streamer = streamer;
    this.groundEpoch++; // cell size or world may differ: re-judge ground once
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
   * Resize the rings of the running world (the player's draw distance). Same cells, same scene: the next `update` keeps
   * what is still in reach, loads what is newly in reach and drops the rest through the usual path. A load in flight sees
   * a new streamer and is dropped, exactly as for a reconfigure, and is asked for again if it is still wanted.
   */
  setRings(rings: NonNullable<ChunkStreamerData["rings"]>): void {
    const s = this.streamer;
    if (!s?.rings) return;
    this.streamer = { ...s, rings };
    this.lastFocus = null;
  }

  /**
   * Install (or clear) a procedural cell source. With a provider set, cells
   * are generated on demand and the on-disk chunk index is not consulted at
   * all — a generated world has no files and no bounded cell list.
   */
  setProvider(provider: ChunkProvider | null): void {
    if (this.provider === provider) return;
    // Same cells, new object: swap the provider (its worker pool is the live
    // one now) and KEEP the streamed world. `configure()` re-parents the
    // surviving groups into the rebuilt scene a moment later, exactly as it
    // already does for an authored chunk world whose source did not change.
    // See ChunkProvider.key for what this cost before.
    const sameCells =
      provider !== null &&
      this.provider !== null &&
      provider.key !== undefined &&
      Object.is(provider.key, this.provider.key);
    this.provider = provider;
    this.hasCellMemo.clear();
    this.groundEpoch++; // which cells exist may differ
    if (sameCells) return;
    this.unloadAll();
    this.lastFocus = null;
  }

  /** True when this world can supply the cell — file index, or provider. */
  /**
   * A provider's answer for a key, remembered: `update` asks for every cell in
   * reach several times on each cell crossing, and parsing each key back into
   * coordinates was steady garbage while streaming. A provider's cell set is
   * fixed for its lifetime, so the memo only resets when the provider does
   * (and when it has grown large, since a long flight visits many keys).
   */
  private readonly hasCellMemo = new Map<string, boolean>();

  /**
   * `parseChunkKey`, remembered. The supercell pass maps every proxy cell in
   * reach to its block on each crossing; the tuples are shared and read-only.
   */
  private readonly coordsMemo = new Map<string, readonly [number, number] | null>();

  private cellCoords(key: string): readonly [number, number] | null {
    let coords = this.coordsMemo.get(key);
    if (coords === undefined) {
      if (this.coordsMemo.size >= 65536) this.coordsMemo.clear();
      coords = parseChunkKey(key);
      this.coordsMemo.set(key, coords);
    }
    return coords;
  }

  /** Is cell (cx, cz) within reach of the body itself — the focus's own cell or one touching it? */
  private nearFocus(cx: number, cz: number, size: number): boolean {
    const ex = Math.max(cx * size - this.focusX, 0, this.focusX - (cx + 1) * size);
    const ez = Math.max(cz * size - this.focusZ, 0, this.focusZ - (cz + 1) * size);
    return Math.hypot(ex, ez) <= size;
  }

  private hasCell(key: string): boolean {
    if (this.provider) {
      let has = this.hasCellMemo.get(key);
      if (has === undefined) {
        if (this.hasCellMemo.size >= 65536) this.hasCellMemo.clear();
        const coords = parseChunkKey(key);
        has = coords !== null && this.provider.has(coords[0], coords[1]);
        this.hasCellMemo.set(key, has);
      }
      return has;
    }
    return this.available.has(key);
  }

  /** Bumped whenever the set of cells with DRAWN ground changes (a cell or HLOD part published or dropped). */
  private groundEpoch = 0;
  private groundMemo: Set<string> | null = null;
  private groundMemoEpoch = -1;

  /**
   * Version of {@link coversGround}'s answer: it changes only when a cell or an HLOD part is published or dropped,
   * so a consumer (the culling system's ground gate) re-judges on chunk events, never by scanning every frame.
   */
  get groundVersion(): number {
    return this.groundEpoch;
  }

  /**
   * Is terrain drawn under (x, z)? True when the cell there is resident at any tier (a full cell, or a cell an HLOD /
   * far proxy holds), when there is no cell to stream there (outside the world, no streamer), or when the cell is
   * suppressed for isolation editing (its editable copy stands in). False = its ground has not streamed in: anything
   * placed there would hang over the void (docs/culling.md, "Over unloaded ground").
   */
  coversGround(x: number, z: number): boolean {
    const s = this.streamer;
    if (!s) return true;
    const key = `${Math.floor(x / s.cellSize)}_${Math.floor(z / s.cellSize)}`;
    if (!this.hasCell(key) || this.suppressed.has(key)) return true;
    if (this.groundMemoEpoch !== this.groundEpoch || !this.groundMemo) {
      const memo = new Set<string>(this.loaded.keys());
      for (const sc of this.loadedSupercells.values()) for (const k of sc.cellKeys) memo.add(k);
      this.groundMemo = memo;
      this.groundMemoEpoch = this.groundEpoch;
    }
    return this.groundMemo.has(key);
  }

  /** Whether the cell under (x, z) — the one a body standing there is in — is loaded (true where there is no cell to load). */
  isCellLoaded(x: number, z: number): boolean {
    const s = this.streamer;
    if (!s) return true;
    const key = `${Math.floor(x / s.cellSize)}_${Math.floor(z / s.cellSize)}`;
    return !this.hasCell(key) || this.loaded.has(key);
  }

  /** Is the ground at (x, z) in the physics sim — a simulation-tier cell (collider resident), or no streamed cell at all? */
  isCellSimulated(x: number, z: number): boolean {
    const s = this.streamer;
    if (!s) return true;
    const key = `${Math.floor(x / s.cellSize)}_${Math.floor(z / s.cellSize)}`;
    if (!this.hasCell(key)) return true;
    const chunk = this.loaded.get(key);
    return !!chunk && chunk.simulated;
  }

  /** Local landing coverage, not queue emptiness (queued work is not ground). */
  isLandingReady(x: number, z: number): boolean {
    const s = this.streamer;
    if (!s) return true;
    const cx = Math.round(x / s.cellSize);
    const cz = Math.round(z / s.cellSize);
    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        const key = `${cx + dx}_${cz + dz}`;
        // Small/legacy streamers may not request all nine neighbours.
        // The centre always matters; elsewhere wait only on near-tier cells.
        const rep = this.desiredCells.get(key);
        if ((dx === 0 && dz === 0 || rep && !isProxy(rep)) && this.hasCell(key) && !this.loaded.has(key)) return false;
      }
    }
    return true;
  }

  /** The playable neighbourhood is ready; distant HLOD/far scenery may keep streaming. */
  isArrivalReady(x: number, z: number): boolean {
    if (!this.streamer) return true;
    if (!this.lastFocus || this.lastFocus[0] !== Math.round(x / this.streamer.cellSize) ||
      this.lastFocus[1] !== Math.round(z / this.streamer.cellSize) || !this.isLandingReady(x, z)) return false;
    // The simulation ring includes the ground a player can reach next. Waiting
    // for every desired far cell held a ready landing for minutes.
    for (const [key, rep] of this.desiredCells) {
      if (rep !== "simulation" || this.suppressed.has(key)) continue;
      if (this.hasCell(key) && !this.loaded.has(key)) return false;
    }
    return true;
  }

  /** Complete visible coverage, including distant scenery; stronger than playable arrival. */
  isViewReady(): boolean {
    if (!this.streamer) return true;
    if (!this.lastFocus) return false;
    const covered = new Set(this.loaded.keys());
    for (const sc of this.loadedSupercells.values()) for (const key of sc.cellKeys) covered.add(key);
    for (const key of this.desiredCells.keys()) {
      if (!this.suppressed.has(key) && this.hasCell(key) && !covered.has(key)) return false;
    }
    return true;
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
      const index = (await fetch(assetIndexUrl()).then((r) => r.json())) as {
        chunks?: string[];
      };
      this.available.clear();
      const prefix = `${this.streamer.source}/`;
      for (const file of index.chunks ?? []) {
        if (!file.startsWith(prefix)) continue;
        const coords = parseChunkCoords(file);
        if (coords) this.available.set(`${coords[0]}_${coords[1]}`, file);
      }
      this.groundEpoch++;
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
    this.groundEpoch++;
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
    this.groundEpoch++;
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
    const t = now();
    if (this.lastUpdateAt >= 0) this.frameMs += (Math.min(t - this.lastUpdateAt, 250) - this.frameMs) * 0.1;
    this.lastUpdateAt = t;
    this.focusVelocity.sample(fx, fz, t);
    this.focusX = fx;
    this.focusZ = fz;
    const lead = this.leadStreaming ? streamLeadPoint(fx, fz, this.focusVelocity.vx, this.focusVelocity.vz) : { x: fx, z: fz };
    this.lead = lead;
    this.drainPendingSupercells();
    this.drainPendingCells(lead.x, lead.z);
    this.pumpRebatches();
    const cx = Math.round(fx / s.cellSize);
    const cz = Math.round(fz / s.cellSize);
    const lcx = Math.round(lead.x / s.cellSize);
    const lcz = Math.round(lead.z / s.cellSize);
    const leadMoved = !this.lastLeadCell || this.lastLeadCell[0] !== lcx || this.lastLeadCell[1] !== lcz;
    if (this.lastFocus && this.lastFocus[0] === cx && this.lastFocus[1] === cz && !leadMoved) return;
    if (!this.lastFocus || this.lastFocus[0] !== cx || this.lastFocus[1] !== cz) this.lastRefillMissing = Infinity;
    this.lastFocus = [cx, cz];
    this.lastLeadCell = [lcx, lcz];

    // feed current reps back in so the ring hysteresis holds cells on a boundary.
    // Supercell-covered cells don't carry an exact rep (hlod vs far collapses to
    // one representation either way) — "hlod" is a fine stand-in for hysteresis.
    const prev = new Map<string, ChunkRep>();
    this.loaded.forEach((chunk, key) => prev.set(key, chunk.rep));
    for (const sc of this.loadedSupercells.values()) {
      for (const key of sc.cellKeys) if (!prev.has(key)) prev.set(key, "hlod");
    }
    // the lead point's rings OR the focus's own, whichever wants more detail:
    // the cells ahead are promoted before the body reaches them and nothing
    // behind is dropped early (stream-lead.ts)
    const target = computeLeadChunkStates({ x: fx, z: fz }, lead, s, prev);

    // Everything below runs only on a cell crossing, so it never shows up in
    // an average — but a crossing is exactly when the world hitches, and the
    // dispose pass inside the per-cell loop is real synchronous GPU-resource
    // work. Scoped separately from the supercell pass because they fail
    // differently: cells stall on dispose, supercells on merge/rebake.
    this.profiler?.begin("cells");

    // -- simulation/fullRender cells: per-cell load/unload, unchanged --
    // forEach, not for-of over entries: these walks cover every cell in reach
    // on each crossing, and an entries walk allocates a [key, value] per cell
    target.forEach((rep, key) => {
      if (isProxy(rep)) return; // handled by the supercell pass below
      if (this.suppressed.has(key)) return; // isolation-editing owns this cell right now
      if (!this.hasCell(key)) return; // this world has no cell here
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
    });
    // Out-of-range cells can leave immediately. Demotions remain render-only
    // fallbacks until a published proxy actually covers them.
    this.loaded.forEach((chunk, key) => {
      const rep = target.get(key);
      if (!rep || (isProxy(rep) && this.hasProxyCoverage(key))) this.unload(key, chunk);
      else if (isProxy(rep) && chunk.simulated) this.retier(chunk, "fullRender");
    });
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
    target.forEach((rep, key) => {
      if (!isProxy(rep)) return;
      if (this.suppressed.has(key)) return;
      if (!this.hasCell(key)) return;
      const coords = this.cellCoords(key);
      if (!coords) return;
      const far = rep === "far";
      const [scx, scz] = supercellForCell(coords[0], coords[1], supercellFactor(factor, far));
      const scKey = supercellKeyFor(scx, scz, far);
      let members = desired.get(scKey);
      if (!members) {
        members = new Set();
        desired.set(scKey, members);
      }
      members.add(key);
    });
    // A cell an hlod block currently holds is never wanted by a far block:
    // the hlod block keeps drawing it (finer, and kept on purpose — see
    // SHRANK below) until it unloads, at which point the far block finds the
    // cell missing and appends it. Without this, moving away double-drew
    // every cell along the hlod/far boundary.
    const hlodHeld = new Set<string>();
    this.loadedSupercells.forEach((sc, scKey) => {
      if (isFarSupercellKey(scKey) || !desired.has(scKey)) return;
      for (const key of sc.cellKeys) hlodHeld.add(key);
    });
    // each member checked against the held set — not the whole held set
    // walked once per far block, which was quadratic in the far ring
    desired.forEach((members, scKey) => {
      if (!isFarSupercellKey(scKey)) return;
      members.forEach((key) => {
        if (hlodHeld.has(key)) members.delete(key);
      });
      if (members.size === 0) desired.delete(scKey);
    });
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
    //   SHRANK, cells PROMOTED to a near ring -> replace the merged block,
    //        preserving its neighbours until publication. Temporary overlap
    //        is preferable to missing terrain while the replacement bakes.
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
    target.forEach((rep, key) => {
      if (!isProxy(rep) && this.loaded.has(key)) nearOwned.add(key);
    });
    for (const [scKey, sc] of [...this.loadedSupercells]) {
      const members = desired.get(scKey);
      if (!members) {
        // An entire block can move between tiers at once. Intent is not
        // coverage: keep it until every still-wanted cell has a successor.
        if (this.canRetire(sc.cellKeys, target, scKey)) this.unloadSupercell(scKey);
        continue;
      }
      // Replace atomically. Removing a merged part for ONE promoted cell
      // also removed its neighbours for the entire asynchronous bake.
      if (this.inFlightSupercells.has(scKey)) continue; // a bake is already catching up
      let promoted = false;
      for (const key of sc.cellKeys) {
        if (nearOwned.has(key)) {
          promoted = true;
          break;
        }
      }
      if (promoted) {
        const replacement = new Set(members);
        for (const key of sc.cellKeys) {
          if (target.has(key) && !nearOwned.has(key) && !this.hasProxyCoverage(key, scKey)) replacement.add(key);
        }
        this.queueSupercell(scKey, replacement, "replace", sc.far, true);
        continue;
      }
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
      let missing: Set<string> | null = null;
      for (const key of members) if (!sc.cellKeys.has(key)) (missing ??= new Set()).add(key);
      if (missing === null) continue;
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

  private hasProxyCoverage(key: string, except?: string): boolean {
    // keys, not entries: this runs per loaded cell per crossing, and an
    // entries walk allocates a [key, value] pair for every supercell visited
    for (const scKey of this.loadedSupercells.keys()) {
      if (scKey !== except && this.loadedSupercells.get(scKey)!.cellKeys.has(key)) return true;
    }
    return false;
  }

  private canRetire(keys: ReadonlySet<string>, target: ReadonlyMap<string, ChunkRep>, except: string, replacement?: ReadonlySet<string>): boolean {
    for (const key of keys) {
      if (!target.has(key) || this.suppressed.has(key) || replacement?.has(key)) continue;
      if (!this.loaded.has(key) && !this.hasProxyCoverage(key, except)) return false;
    }
    return true;
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
    urgency: ChunkUrgency = "near",
  ): Promise<ChunkDoc | null> {
    if (this.provider && rawContent === undefined) {
      try {
        return await this.provider.get(cx, cz, urgency);
      } catch (error) {
        console.warn(`[chunks] provider failed for ${key}:`, error);
        return null;
      }
    }
    const file = this.available.get(key);
    if (!file) return null;
    const content: string =
      rawContent ??
      (await fetch(assetFileUrl(`chunks/${file}`)).then(
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
      // Inline (main-thread) generation is for ground the body can reach NOW. A
      // simulation cell the LEAD ring asked for ahead of a moving player is
      // generated on a worker at near priority like any visible cell; it still
      // integrates (collider included) the moment it arrives.
      const urgent = isSimulated(rep) && (!this.leadStreaming || this.nearFocus(coords[0], coords[1], s.cellSize));
      arrived = await this.readCell(key, coords[0], coords[1], rawContent, urgent ? "inline" : "near");
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
    const n = this.integrationBurst ? SUPERCELL_PUBLISHES_BURST : 1;
    for (let i = 0; i < n; i++) {
      const publish = this.pendingSupercells.shift();
      if (!publish) return;
      publish();
    }
  }

  private drainPendingCells(fx: number, fz: number): void {
    if (this.pending.size === 0) return;
    const s = this.streamer;
    if (!s) return;
    const started = now();
    let integrated = 0;
    // a fast-moving focus gets the larger budget, unless frames are already long
    const budget = this.integrationBurst ? CELL_INTEGRATION_BUDGET_BURST_MS
      : this.leadStreaming && this.focusVelocity.speed > FAST_BUDGET_SPEED && this.frameMs < FAST_BUDGET_MAX_FRAME_MS
        ? CELL_INTEGRATION_BUDGET_FAST_MS
        : CELL_INTEGRATION_BUDGET_MS;
    while (this.pending.size > 0) {
      // Always let the first cell through: one cell costing more than the
      // whole budget must still make progress or the queue never drains.
      // A cell the rings now want SIMULATED (the lead ring reached it while it
      // waited) is ground the body is about to stand on: it never waits for
      // budget, exactly like a simulation cell that arrives directly.
      const overBudget = integrated > 0 && now() - started >= budget;
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
        if (overBudget && (rep !== "simulation" || !this.leadStreaming)) continue;
        const dx = (entry.cx + 0.5) * s.cellSize - fx;
        const dz = (entry.cz + 0.5) * s.cellSize - fz;
        // simulation-wanted cells first, then nearest the (lead) point
        const dist = dx * dx + dz * dz + (rep === "simulation" || !this.leadStreaming ? 0 : 1e12);
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
      // A cell is merged right after it is built, but a model the cache has not seen yet (every bridge segment, a
      // prop's first use) lands asynchronously AFTER that merge and stayed one draw per pass — main pass and every
      // shadow cascade — for as long as the cell was loaded. Count the static ones that land late and re-merge the
      // cell once they stop arriving (pumpRebatches).
      const late = { chunk: null as LoadedChunk | null };
      const onModelLoaded = this.buildOptions.onModelLoaded;
      const built = buildScene(expanded, {
        ...this.buildOptions,
        ...(this.buildOptions.instancePool ? { instancePoolOwner: poolOwner } : {}),
        onModelLoaded: (entityId, root, clips) => {
          onModelLoaded?.(entityId, root, clips);
          // a cached model lands synchronously, inside buildScene, and the merge below sees it
          if (!late.chunk) return;
          const chunk = late.chunk;
          // the builder flags a model static (prepareStaticModel) right AFTER this callback, in the same task
          queueMicrotask(() => {
            if (this.loaded.get(key) !== chunk) return; // unloaded (or reloaded) since
            let staticMesh = false;
            root.traverse((o) => {
              if ((o as THREE.Mesh).isMesh && o.userData[STATIC_BATCH_FLAG]) staticMesh = true;
            });
            if (!staticMesh) return;
            chunk.lateModels += 1;
            this.rebatchAt.set(key, now() + CHUNK_REBATCH_DELAY_MS);
          });
        },
      });
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
      // POIs and `culling` entities batch apart from the rest of the cell, so
      // each can be hidden on its own (see registerCulling)
      const cullRoots = cullRootsOf(expanded);
      const rootOf = cullRootIndex(cullRoots);
      const batch = batchStaticMeshes(
        built.scene,
        rootOf.size > 0 ? { groupOf: (mesh) => rootOf.get(mesh.userData["entityId"] as string) } : {},
      );
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
        cullRoots,
        cullUnits: [],
        root: built.scene,
        lateModels: 0,
      };
      late.chunk = chunk;
      this.loaded.set(key, chunk);
      this.groundEpoch++;
      this.stampCell(key, group);
      this.registerCulling(chunk);
      if (simulated) this.sim?.addEntities(expanded); // render-only rings never collide
      this.lifecycle.onLoaded?.(expanded, built.objects, simulated);
      this.lastFocus = null; // retire covered proxies even when standing still
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
    // Order by what the player is running into: simulation cells first, then
    // nearest the lead point. queueCell's newest-first unshift inherited the
    // ring walk's RASTER order, so within one crossing the loads went from the
    // +z/+x corner backwards — fine sprinting one way, last-in-line the other.
    const s = this.streamer;
    if (s && this.leadStreaming && this.cellQueue.length > 1) {
      const lead = this.lead;
      const prio = new Map<string, number>();
      for (const key of this.cellQueue) {
        const c = this.cellCoords(key);
        prio.set(key, c ? cellLoadPriority(c[0], c[1], this.desiredCells.get(key), lead, s.cellSize) : Infinity);
      }
      this.cellQueue.sort((a, b) => prio.get(a)! - prio.get(b)!);
    }
    while (this.cellQueue.length > 0) {
      // A simulation cell is generated inline (no worker) and integrates on
      // arrival, so neither the worker cap nor the integration backlog
      // applies to it: ground under the body never waits behind scenery.
      const headSim = this.leadStreaming && this.desiredCells.get(this.cellQueue[0]!) === "simulation";
      if (!headSim && (this.inFlight.size >= maxCellLoadsInFlightValue() || this.pending.size >= MAX_PENDING_INTEGRATIONS)) break;
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
    /**
     * A block drawing over cells that are already full detail (a promotion): it goes before every non-urgent entry.
     * Plain newest-first put it BEHIND them, because the residency pass queues promotions first and the still-missing
     * far ring after, and a moving player runs a pass on every cell crossing.
     */
    urgent = false,
  ): void {
    urgent &&= this.urgentPromotions;
    const existing = this.supercellQueue.findIndex((item) => item.key === scKey);
    // A queued append is a delta against a proxy that may since have been
    // dropped or replaced, so a later entry for the same key always wins —
    // and merging two appends would lose one of their cell sets. Re-deriving
    // the delta on the next residency pass is both cheaper and always right.
    if (existing >= 0) this.supercellQueue.splice(existing, 1);
    const entry = { key: scKey, members: new Set(members), mode, far, urgent };
    if (urgent) this.supercellQueue.unshift(entry);
    else {
      // newest-first among the non-urgent, behind every urgent entry
      let at = 0;
      while (at < this.supercellQueue.length && this.supercellQueue[at]!.urgent) at++;
      this.supercellQueue.splice(at, 0, entry);
    }
    // bound the backlog: a long flight can enqueue the whole far ring, and
    // anything that far down the list is guaranteed stale by the time it runs
    if (this.supercellQueue.length > 64) this.supercellQueue.length = 64;
  }

  /** Start bakes up to the concurrency cap, skipping entries that went stale. */
  private pumpSupercellQueue(): void {
    while (this.supercellQueue.length > 0) {
      // urgent entries sit at the front and may use the reserved slot; a normal entry needs a normal one
      const urgent = this.supercellQueue[0]!.urgent;
      const normalFree = this.inFlightSupercells.size - this.inFlightUrgent.size < MAX_CONCURRENT_SUPERCELL_BAKES;
      if (!normalFree && !(urgent && this.inFlightUrgent.size < URGENT_SUPERCELL_BAKES)) break;
      const next = this.supercellQueue.shift()!;
      if (this.inFlightSupercells.has(next.key)) continue;
      // "append" is a DELTA against a specific proxy: if that proxy is gone
      // (unloaded, or every part dropped), the delta means nothing and the
      // residency pass owns the key again. "replace" needs no such check — it
      // is self-sufficient either way, a first build or a consolidation.
      if (next.mode === "append" && !this.loadedSupercells.has(next.key)) continue;
      if (!this.desiredSupercells.has(next.key)) continue; // moved on since it was queued
      // an urgent bake takes a normal slot when one is free and the reserved one only when none is
      if (urgent && !normalFree) this.inFlightUrgent.add(next.key);
      void this.loadSupercell(next.key, next.members, next.mode, next.far, urgent).finally(() => {
        this.inFlightUrgent.delete(next.key);
        this.pumpSupercellQueue();
      });
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
    urgent = false,
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
      // Member cells CONCURRENTLY, at bulk priority.
      //
      // This used to `await` them one at a time. They are independent, so all
      // that bought was 64 sequential worker round-trips on a pool of six:
      // measured 3,576ms for one far block, with five workers idle throughout,
      // and the near ring queued behind every one of those round-trips. The
      // pool's priority queue is what makes running them together safe — see
      // ChunkUrgency.
      const cells: ChunkCell[] = [];
      const keys = [...memberKeys].filter((key) => parseChunkKey(key) !== null && this.hasCell(key));
      let cursor = 0;
      const fetchWorker = async (): Promise<void> => {
        for (;;) {
          const at = cursor++;
          if (at >= keys.length) return;
          const key = keys[at]!;
          const cellCoords = parseChunkKey(key)!;
          try {
            // an urgent re-bake's cells are near ones the player is looking at: do not queue them behind the far ring
            const doc = await this.readCell(key, cellCoords[0], cellCoords[1], undefined, urgent ? "near" : "bulk");
            if (doc) cells.push({ cx: cellCoords[0], cz: cellCoords[1], doc });
          } catch (error) {
            console.warn(`[chunks] failed to load ${key}:`, error);
          }
        }
      };
      await Promise.all(
        Array.from({ length: Math.min(SUPERCELL_FETCH_CONCURRENCY, keys.length) }, fetchWorker),
      );
      // order is now arrival order, and the bake's origin must not depend on
      // it — sort back to the deterministic member order
      cells.sort((a, b) => a.cx - b.cx || a.cz - b.cz);
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
    const previous = this.loadedSupercells.get(scKey);
    if (mode === "replace" && previous && !this.canRetire(previous.cellKeys, this.desiredCells, scKey, part.cellKeys)) {
      // A fetch failed or residency changed during the bake. Never publish
      // a partial replacement over the last good terrain coverage.
      this.disposeGroup(part.group);
      this.lastFocus = null;
      return;
    }
    this.lastFocus = null; // retire full-detail fallbacks after publication
    this.groundEpoch++; // every branch below publishes this part's cells
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
        this.registerPart(part);
        for (const key of part.cellKeys) existing.cellKeys.add(key);
        existing.entityCount += entityCount;
        // an appended part is new content: compile it in the background like a first bake (the group-level
        // precompile below ran once, for the first part only)
        this.lifecycle.precompile?.(part.group);
        return;
      }
      if (existing) {
        // consolidation. Add before disposing so there is no frame in which
        // this supercell is missing from the scene.
        existing.group.add(part.group);
        refreshStaticSubtree(existing.group);
        for (const stale of existing.parts) {
          this.unregisterPart(stale);
          this.disposeGroup(stale.group);
        }
        existing.parts = [part];
        this.registerPart(part);
        existing.cellKeys = new Set(part.cellKeys);
        existing.entityCount = entityCount;
        this.lifecycle.precompile?.(part.group);
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
      this.registerPart(part);
    }
  }

  private unloadSupercell(scKey: string): void {
    // bump unconditionally, even with nothing published yet — this is what
    // tells an in-flight loadSupercell() for this key (still awaiting its
    // glTF merge) that it's been superseded and must discard its result.
    this.supercellEpoch.set(scKey, (this.supercellEpoch.get(scKey) ?? 0) + 1);
    const sc = this.loadedSupercells.get(scKey);
    if (!sc) return;
    for (const part of sc.parts) this.unregisterPart(part);
    this.disposeGroup(sc.group);
    this.loadedSupercells.delete(scKey);
    this.groundEpoch++;
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
    // the cell's own unit exists only while it is render-only
    this.unregisterCulling(chunk);
    this.registerCulling(chunk);
  }

  /** When each cell with late-landing static models is due its re-merge (CHUNK_REBATCH_DELAY_MS after the last). */
  private readonly rebatchAt = new Map<string, number>();

  /**
   * Re-merge cells whose static models landed after their first merge: restore the sources, merge again with the
   * same grouping, re-freeze, re-register culling, and precompile the new merged meshes. Bounded per update.
   */
  pumpRebatches(at: number = now()): number {
    let done = 0;
    for (const [key, due] of this.rebatchAt) {
      if (done >= CHUNK_REBATCH_PER_UPDATE) break;
      if (due > at) continue;
      this.rebatchAt.delete(key);
      const chunk = this.loaded.get(key);
      if (!chunk || chunk.lateModels === 0) continue;
      chunk.lateModels = 0;
      this.unregisterCulling(chunk);
      chunk.batch?.dispose();
      const rootOf = cullRootIndex(chunk.cullRoots);
      chunk.batch = batchStaticMeshes(chunk.root, rootOf.size > 0 ? { groupOf: (mesh) => rootOf.get(mesh.userData["entityId"] as string) } : {});
      // the merged meshes are new children of a frozen cell: lay them out (and any late model) before it draws
      if (!chunk.simulated) refreshStaticSubtree(chunk.group);
      this.registerCulling(chunk);
      if (chunk.batch) this.lifecycle.precompile?.(chunk.batch.group);
      done += 1;
    }
    return done;
  }

  private unload(key: string, chunk: LoadedChunk): void {
    this.rebatchAt.delete(key);
    // restore the source meshes first: dispose() puts them back so disposeGroup
    // frees the real geometries rather than only the merged copies
    this.unregisterCulling(chunk);
    chunk.batch?.dispose();
    this.buildOptions.instancePool?.release(chunk.poolOwner);
    this.disposeGroup(chunk.group);
    if (chunk.simulated) this.sim?.removeEntities(Object.keys(chunk.expanded.entities));
    this.lifecycle.onUnloaded?.(Object.keys(chunk.expanded.entities));
    this.loaded.delete(key);
    this.groundEpoch++;
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
    // a different world (or none): its terrain must not hide anything
    this.culling?.occluders.clear();
  }
}

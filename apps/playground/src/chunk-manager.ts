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
}

/** One merged bake inside a supercell — the unit that is added and dropped. */
interface SupercellPart {
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
 * How many cells may load at once. See pumpCellQueue: a load is mostly
 * synchronous main-thread work, so concurrency buys nothing here and costs
 * frame evenness.
 */
const MAX_CONCURRENT_CELL_LOADS = 3;

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
  private inFlight = new Set<string>();
  private inFlightSupercells = new Set<string>();
  /** Pending cell loads, newest-first; drained by pumpCellQueue. */
  private cellQueue: string[] = [];
  /** The residency the CURRENT focus wants, keyed by cell — the queue reads it at pump time. */
  private desiredCells = new Map<string, ChunkRep>();
  /** Pending supercell bakes, newest-first; drained by pumpSupercellQueue. */
  private supercellQueue: Array<{ key: string; members: Set<string>; mode: SupercellBakeMode }> = [];
  /** Supercell keys the CURRENT focus wants — used to drop stale queue entries. */
  private desiredSupercells = new Set<string>();
  /** Bumped on every unload/reload of a given supercell key so an in-flight
   * loadSupercell() whose async glTF-merge work outlives that change can tell
   * its result is stale and must be discarded instead of published. */
  private supercellEpoch = new Map<string, number>();
  private scene: THREE.Scene | null = null;
  private sim: PhysicsSim | null = null;
  private lastFocus: [number, number] | null = null;
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
      loading: this.inFlight.size + this.inFlightSupercells.size,
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

  /** Drive residency from the focus position. Cheap unless the focus changed cells. */
  update(fx: number, fz: number): void {
    const s = this.streamer;
    if (!s || !this.scene) return;
    const cx = Math.round(fx / s.cellSize);
    const cz = Math.round(fz / s.cellSize);
    if (this.lastFocus && this.lastFocus[0] === cx && this.lastFocus[1] === cz) return;
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
        if (!this.inFlight.has(key)) this.queueCell(key);
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
    const desired = new Map<string, Set<string>>(); // "scx_scz" -> member "cx_cz" keys
    for (const [key, rep] of target) {
      if (!isProxy(rep)) continue;
      if (this.suppressed.has(key)) continue;
      if (!this.hasCell(key)) continue;
      const coords = parseChunkKey(key);
      if (!coords) continue;
      const [scx, scz] = supercellForCell(coords[0], coords[1], factor);
      const scKey = `${scx}_${scz}`;
      let members = desired.get(scKey);
      if (!members) {
        members = new Set();
        desired.set(scKey, members);
      }
      members.add(key);
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
    const nearOwned = new Set<string>();
    for (const [key, rep] of target) if (!isProxy(rep)) nearOwned.add(key);
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
      const missing = new Set([...members].filter((key) => !sc.cellKeys.has(key)));
      if (missing.size === 0) continue;
      if (sc.parts.length >= MAX_SUPERCELL_PARTS) {
        // consolidate: one bake of the whole block instead of a fifth part.
        // Queued, NOT unloaded first — loadSupercell swaps the merged block in
        // before freeing the parts it replaces, so the far ring never shows a
        // hole for the ~200ms the bake takes.
        this.queueSupercell(scKey, members, "replace");
      } else {
        this.queueSupercell(scKey, missing, "append");
      }
    }
    for (const [scKey, members] of desired) {
      if (this.loadedSupercells.has(scKey) || this.inFlightSupercells.has(scKey)) continue;
      this.queueSupercell(scKey, members, "replace");
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
        this.queueSupercell(scKey, members, "replace");
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

  /** simulation/fullRender only — hlod/far reps never reach here, see loadSupercell. */
  private async load(key: string, rep: ChunkRep, rawContent?: string): Promise<void> {
    const s = this.streamer;
    const coords = parseChunkKey(key);
    if (!s || !coords || !this.scene || !this.hasCell(key)) return;
    this.inFlight.add(key);
    const endLoad = this.profiler?.span("chunk.load", `${key} (${rep})`);
    try {
      const cell = await this.readCell(key, coords[0], coords[1], rawContent, isSimulated(rep));
      if (!cell) return;
      const { doc } = chunkToSceneDoc(s.source, coords[0], coords[1], s.cellSize, cell);
      const issues = validateScene(doc, this.registry);
      if (issues.length > 0) {
        console.warn(`[chunks] cell ${key} has invalid components:`, issues);
        return;
      }
      const expanded = expandScene(doc, this.assets, this.registry);
      // streamer may have been reconfigured while we fetched
      if (this.streamer !== s || !this.scene) return;
      // Everything from here down is SYNCHRONOUS main-thread work — prefab
      // expansion, geometry/material construction, collider creation. This
      // is the part that actually drops a frame, so it gets its own span
      // separate from the fetch it followed.
      const endBuild = this.profiler?.span(
        "chunk.build",
        `${key} · ${Object.keys(expanded.entities).length} entities`,
      );
      const group = new THREE.Group();
      group.name = `chunk:${key}`;
      const built = buildScene(expanded, this.buildOptions);
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
      // A cell's shaders are compiled by the first frame that draws it, which
      // measures as 760-1320ms inside a single `render/draw` while streaming.
      // Precompiling before add() is the obvious fix and does NOT work here:
      // the collider for streamed terrain is cooked from the BUILT objects, so
      // it does not exist until this group is in the scene, and anything that
      // delays add() delays the ground out from under the player. See
      // docs/performance-lessons.md; the prerequisite is decoupling the
      // collider from the scene graph.
      this.scene.add(group);
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
      };
      this.loaded.set(key, chunk);
      if (simulated) this.sim?.addEntities(expanded); // render-only rings never collide
      this.lifecycle.onLoaded?.(expanded, built.objects, simulated);
      endBuild?.();
    } catch (error) {
      console.warn(`[chunks] failed to load cell ${key}:`, error);
    } finally {
      this.inFlight.delete(key);
      endLoad?.();
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
   * Start cell loads up to the concurrency cap.
   *
   * Loading a cell is mostly SYNCHRONOUS main-thread work — generating or
   * parsing the document, expanding prefabs, building geometry and materials,
   * merging the static batch. Running eighteen of those interleaved (which is
   * what an unbounded fly-through produced) does not make any of them finish
   * sooner; it just spreads one long stall across every frame in the burst.
   * Bounding it keeps each load short and the frame rate even, at the cost of
   * distant cells arriving a little later — which is the right trade, because
   * the near ones are queued first.
   */
  private pumpCellQueue(): void {
    while (this.inFlight.size < MAX_CONCURRENT_CELL_LOADS && this.cellQueue.length > 0) {
      const key = this.cellQueue.shift()!;
      if (this.loaded.has(key) || this.inFlight.has(key) || this.suppressed.has(key)) continue;
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
  ): void {
    const existing = this.supercellQueue.findIndex((item) => item.key === scKey);
    // A queued append is a delta against a proxy that may since have been
    // dropped or replaced, so a later entry for the same key always wins —
    // and merging two appends would lose one of their cell sets. Re-deriving
    // the delta on the next residency pass is both cheaper and always right.
    if (existing >= 0) this.supercellQueue.splice(existing, 1);
    this.supercellQueue.unshift({ key: scKey, members: new Set(members), mode });
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
      void this.loadSupercell(next.key, next.members, next.mode).finally(() =>
        this.pumpSupercellQueue(),
      );
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
  ): Promise<void> {
    const s = this.streamer;
    if (!s || !this.scene) return;
    const coords = parseChunkKey(scKey);
    if (!coords) return;
    const [scx, scz] = coords;
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
      const factor = Math.max(1, Math.floor(s.hlodSupercellFactor));
      const build = assembleHlodBuildDoc(scx, scz, cells, {
        cellSize: s.cellSize,
        factor,
        world: s.source,
        assets: this.assets,
        registry: this.registry,
      });
      const built = await buildHlodProxy(build.doc, this.buildOptions);
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
      };
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
      // a far-field HLOD proxy is merged, baked geometry — it can never move
      freezeStaticSubtree(group);
      this.loadedSupercells.set(scKey, {
        group,
        parts: [part],
        cellKeys: new Set(part.cellKeys),
        entityCount,
      });
    } finally {
      this.inFlightSupercells.delete(scKey);
      endLoad?.();
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
        // InstancedMesh (renderMode: "instanced" props) owns its own
        // instance-matrix GPU buffer separately from `geometry` — without
        // this it leaks one buffer per unload, worse the longer a session
        // streams chunks in and out.
        if ((mesh as THREE.InstancedMesh).isInstancedMesh) (mesh as THREE.InstancedMesh).dispose();
        const batch = mesh.userData["foliageLodBatch"] as InstancedPropBatch | undefined;
        if (batch) this.lifecycle.onDisposeInstancedBatch?.(batch);
      }
    });
  }

  private unloadAll(): void {
    this.cellQueue.length = 0;
    this.desiredCells.clear();
    this.supercellQueue.length = 0;
    this.desiredSupercells.clear();
    for (const [key, chunk] of [...this.loaded]) this.unload(key, chunk);
    for (const scKey of [...this.loadedSupercells.keys()]) this.unloadSupercell(scKey);
  }
}

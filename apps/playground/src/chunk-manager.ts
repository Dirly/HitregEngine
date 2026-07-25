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
  type ChunkRep,
  type ChunkStreamerData,
  type ComponentRegistry,
  type SceneDoc,
} from "@hitreg/core";
import { buildScene, buildHlodProxy, type BuildOptions, type InstancedPropBatch } from "@hitreg/render";
import type { PhysicsSim } from "@hitreg/physics";

/** simulation/fullRender cells only — hlod/far live in LoadedSupercell instead. */
interface LoadedChunk {
  group: THREE.Object3D;
  /** Expanded doc — physics bodies re-attach from this on every play session. */
  expanded: SceneDoc;
  objects: Map<string, THREE.Object3D>;
  /** Current LOD representation from the ring state machine. */
  rep: ChunkRep;
  /** rep === "simulation": carries physics + scripts. Otherwise render-only. */
  simulated: boolean;
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
  /** "cx_cz" member cells baked into this proxy — the rebuild-trigger key. */
  cellKeys: Set<string>;
  /** Approximate, for the diagnostics HUD only (no per-entity objects exist). */
  entityCount: number;
}

function setsEqual(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  if (a.size !== b.size) return false;
  for (const v of a) if (!b.has(v)) return false;
  return true;
}

/** simulation cells render full meshes AND run physics + scripts. */
function isSimulated(rep: ChunkRep): boolean {
  return rep === "simulation";
}

/** hlod/far cells render as a cheap merged proxy (no physics/scripts/picking). */
function isProxy(rep: ChunkRep): boolean {
  return rep === "hlod" || rep === "far";
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
  private loaded = new Map<string, LoadedChunk>();
  /** hlod/far ring cells, grouped and baked by supercell — see LoadedSupercell. */
  private loadedSupercells = new Map<string, LoadedSupercell>();
  private inFlight = new Set<string>();
  private inFlightSupercells = new Set<string>();
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

  constructor(
    private readonly assets: AssetLibrary,
    private readonly registry: ComponentRegistry,
    private readonly buildOptions: BuildOptions,
    private readonly lifecycle: ChunkLifecycle = {},
  ) {}

  /** Chunk/entity counts split by residency, for diagnostics. */
  get stats(): { chunks: number; entities: number; simulated: number; proxied: number; loading: number } {
    let entities = 0;
    let simulated = 0;
    for (const chunk of this.loaded.values()) {
      entities += Object.keys(chunk.expanded.entities).length;
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

  /** Re-read which chunk files exist (startup + when chunk files are added). */
  async refreshIndex(): Promise<void> {
    if (!this.streamer) return;
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

    // -- simulation/fullRender cells: per-cell load/unload, unchanged --
    for (const [key, rep] of target) {
      if (isProxy(rep)) continue; // handled by the supercell pass below
      if (this.suppressed.has(key)) continue; // isolation-editing owns this cell right now
      if (!this.available.has(key)) continue; // no file for this cell
      const chunk = this.loaded.get(key);
      if (!chunk) {
        if (!this.inFlight.has(key)) void this.load(key, rep);
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

    // -- hlod/far cells: group into supercells, one merged proxy per group --
    const factor = Math.max(1, Math.floor(s.hlodSupercellFactor));
    const desired = new Map<string, Set<string>>(); // "scx_scz" -> member "cx_cz" keys
    for (const [key, rep] of target) {
      if (!isProxy(rep)) continue;
      if (this.suppressed.has(key)) continue;
      if (!this.available.has(key)) continue;
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
    // unload supercells whose membership changed (or vanished) — a partial
    // membership change forces a full rebuild since the geometry is merged
    for (const [scKey, sc] of [...this.loadedSupercells]) {
      const members = desired.get(scKey);
      if (!members || !setsEqual(members, sc.cellKeys)) this.unloadSupercell(scKey);
    }
    for (const [scKey, members] of desired) {
      if (this.loadedSupercells.has(scKey) || this.inFlightSupercells.has(scKey)) continue;
      void this.loadSupercell(scKey, members);
    }
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
        void this.loadSupercell(scKey, members);
        return;
      }
    }
    this.lastFocus = null; // new file may be in range — re-evaluate
  }

  /** simulation/fullRender only — hlod/far reps never reach here, see loadSupercell. */
  private async load(key: string, rep: ChunkRep, rawContent?: string): Promise<void> {
    const s = this.streamer;
    const file = this.available.get(key);
    if (!s || !file || !this.scene) return;
    this.inFlight.add(key);
    try {
      const content: string =
        rawContent ??
        (await fetch(`/__hitreg/asset-file?file=${encodeURIComponent(`chunks/${file}`)}`).then(
          (r) => r.text(),
        ));
      const parsed = chunkDocSchema.safeParse(JSON.parse(content));
      if (!parsed.success) {
        console.warn(`[chunks] ${file} failed validation:`, parsed.error.message.slice(0, 300));
        return;
      }
      const coords = parseChunkCoords(file)!;
      const { doc } = chunkToSceneDoc(s.source, coords[0], coords[1], s.cellSize, parsed.data);
      const issues = validateScene(doc, this.registry);
      if (issues.length > 0) {
        console.warn(`[chunks] ${file} has invalid components:`, issues);
        return;
      }
      const expanded = expandScene(doc, this.assets, this.registry);
      // streamer may have been reconfigured while we fetched
      if (this.streamer !== s || !this.scene) return;
      const group = new THREE.Group();
      group.name = `chunk:${key}`;
      const built = buildScene(expanded, this.buildOptions);
      group.add(built.scene);
      this.scene.add(group);
      const simulated = isSimulated(rep);
      const chunk: LoadedChunk = { group, expanded, objects: built.objects, rep, simulated };
      this.loaded.set(key, chunk);
      if (simulated) this.sim?.addEntities(expanded); // render-only rings never collide
      this.lifecycle.onLoaded?.(expanded, built.objects, simulated);
    } catch (error) {
      console.warn(`[chunks] failed to load ${file}:`, error);
    } finally {
      this.inFlight.delete(key);
    }
  }

  /**
   * Fetch every member cell and bake ONE merged HLOD proxy for the whole
   * group — the fix for hlod-supercell fragmentation (see LoadedSupercell).
   * A cell that fails to fetch/parse is skipped with a warning rather than
   * failing the whole supercell, matching the per-cell load()'s tolerance.
   */
  private async loadSupercell(scKey: string, memberKeys: ReadonlySet<string>): Promise<void> {
    const s = this.streamer;
    if (!s || !this.scene) return;
    const coords = parseChunkKey(scKey);
    if (!coords) return;
    const [scx, scz] = coords;
    this.inFlightSupercells.add(scKey);
    const epoch = (this.supercellEpoch.get(scKey) ?? 0) + 1;
    this.supercellEpoch.set(scKey, epoch);
    try {
      const cells: ChunkCell[] = [];
      for (const key of memberKeys) {
        const cellCoords = parseChunkKey(key);
        const file = cellCoords ? this.available.get(key) : undefined;
        if (!cellCoords || !file) continue;
        try {
          const content = await fetch(
            `/__hitreg/asset-file?file=${encodeURIComponent(`chunks/${file}`)}`,
          ).then((r) => r.text());
          const parsed = chunkDocSchema.safeParse(JSON.parse(content));
          if (!parsed.success) {
            console.warn(`[chunks] ${file} failed validation:`, parsed.error.message.slice(0, 300));
            continue;
          }
          cells.push({ cx: cellCoords[0], cz: cellCoords[1], doc: parsed.data });
        } catch (error) {
          console.warn(`[chunks] failed to load ${file}:`, error);
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
      const group = new THREE.Group();
      group.name = `hlod-supercell:${scKey}`;
      built.group.position.set(build.origin[0], build.origin[1], build.origin[2]);
      group.add(built.group);
      this.scene.add(group);
      const entityCount = cells.reduce((n, c) => n + Object.keys(c.doc.entities).length, 0);
      this.loadedSupercells.set(scKey, {
        group,
        cellKeys: new Set(cells.map((c) => `${c.cx}_${c.cz}`)),
        entityCount,
      });
    } finally {
      this.inFlightSupercells.delete(scKey);
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
      this.sim?.addEntities(chunk.expanded);
      this.lifecycle.onSimulationGained?.(chunk.expanded, chunk.objects);
    } else {
      this.sim?.removeEntities(Object.keys(chunk.expanded.entities));
      this.lifecycle.onSimulationLost?.(Object.keys(chunk.expanded.entities));
    }
    chunk.simulated = nowSimulated;
    chunk.rep = rep;
  }

  private unload(key: string, chunk: LoadedChunk): void {
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
    for (const [key, chunk] of [...this.loaded]) this.unload(key, chunk);
    for (const scKey of [...this.loadedSupercells.keys()]) this.unloadSupercell(scKey);
  }
}

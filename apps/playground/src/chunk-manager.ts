import * as THREE from "three/webgpu";
import {
  assembleHlodBuildDoc,
  chunkDocSchema,
  chunkToSceneDoc,
  computeChunkStates,
  expandScene,
  parseChunkCoords,
  validateScene,
  type AssetLibrary,
  type ChunkRep,
  type ChunkStreamerData,
  type ComponentRegistry,
  type SceneDoc,
} from "@hitreg/core";
import { buildScene, buildHlodProxy, type BuildOptions, type InstancedPropBatch } from "@hitreg/render";
import type { PhysicsSim } from "@hitreg/physics";

interface LoadedChunk {
  group: THREE.Object3D;
  /** Expanded doc — physics bodies re-attach from this on every play session. */
  expanded: SceneDoc;
  objects: Map<string, THREE.Object3D>;
  /** Current LOD representation from the ring state machine. */
  rep: ChunkRep;
  /** rep === "simulation": carries physics + scripts. Otherwise render-only. */
  simulated: boolean;
  /** rep is "hlod"/"far": rendered as a merged proxy, not full per-entity meshes. */
  proxy: boolean;
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
  onUnloaded?: (ids: Iterable<string>) => void;
  /** A `renderMode: "instanced"` batch's chunk unloaded — unregister it from
   * whatever FoliageLodSystem tracks it before its meshes get disposed. */
  onDisposeInstancedBatch?: (batch: InstancedPropBatch) => void;
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
  private inFlight = new Set<string>();
  private scene: THREE.Scene | null = null;
  private sim: PhysicsSim | null = null;
  private lastFocus: [number, number] | null = null;

  constructor(
    private readonly assets: AssetLibrary,
    private readonly registry: ComponentRegistry,
    private readonly buildOptions: BuildOptions,
    private readonly lifecycle: ChunkLifecycle = {},
  ) {}

  /** Chunk/entity counts split by residency, for diagnostics. */
  get stats(): { chunks: number; entities: number; simulated: number; proxied: number } {
    let entities = 0;
    let simulated = 0;
    let proxied = 0;
    for (const chunk of this.loaded.values()) {
      entities += Object.keys(chunk.expanded.entities).length;
      if (chunk.simulated) simulated += 1;
      if (chunk.proxy) proxied += 1;
    }
    return { chunks: this.loaded.size, entities, simulated, proxied };
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
    // re-parent surviving groups into the rebuilt scene
    for (const chunk of this.loaded.values()) {
      scene.add(chunk.group);
      this.lifecycle.onLoaded?.(chunk.expanded, chunk.objects, chunk.simulated);
    }
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

  /** Drive residency from the focus position. Cheap unless the focus changed cells. */
  update(fx: number, fz: number): void {
    const s = this.streamer;
    if (!s || !this.scene) return;
    const cx = Math.round(fx / s.cellSize);
    const cz = Math.round(fz / s.cellSize);
    if (this.lastFocus && this.lastFocus[0] === cx && this.lastFocus[1] === cz) return;
    this.lastFocus = [cx, cz];

    // feed current reps back in so the ring hysteresis holds cells on a boundary
    const prev = new Map<string, ChunkRep>();
    for (const [key, chunk] of this.loaded) prev.set(key, chunk.rep);
    const target = computeChunkStates({ x: fx, z: fz }, s, prev);

    for (const [key, rep] of target) {
      if (!this.available.has(key)) continue; // no file for this cell
      const chunk = this.loaded.get(key);
      if (!chunk) {
        if (!this.inFlight.has(key)) void this.load(key, rep);
      } else if (chunk.simulated !== isSimulated(rep) || chunk.proxy !== isProxy(rep)) {
        // crossed a boundary that changes physics (simulation) or how it renders
        // (full meshes <-> merged proxy) — reload at the new residency
        this.unload(key, chunk);
        void this.load(key, rep);
      } else {
        chunk.rep = rep; // detail label shifted but render/sim behavior is the same
      }
    }
    // cells that fell out of every ring unload
    for (const [key, chunk] of this.loaded) {
      if (!target.has(key)) this.unload(key, chunk);
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
      return;
    }
    this.available.set(key, file);
    const chunk = this.loaded.get(key);
    if (chunk) {
      const rep = chunk.rep; // hot-swap keeps its current residency
      this.unload(key, chunk);
      await this.load(key, rep, content);
    } else {
      this.lastFocus = null; // new file may be in range — re-evaluate
    }
  }

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
      const proxy = isProxy(rep);
      let objects: Map<string, THREE.Object3D>;
      if (proxy) {
        // hlod/far: render one merged proxy per material instead of full meshes.
        // factor 1 => this single cell IS its own supercell (positions rebased
        // to the cell origin); no physics, no scripts, no per-entity picking.
        const build = assembleHlodBuildDoc(
          coords[0],
          coords[1],
          [{ cx: coords[0], cz: coords[1], doc: parsed.data }],
          { cellSize: s.cellSize, factor: 1, world: s.source, assets: this.assets, registry: this.registry },
        );
        const built = buildHlodProxy(build.doc, this.buildOptions);
        built.group.position.set(build.origin[0], build.origin[1], build.origin[2]);
        group.add(built.group);
        objects = new Map(); // merged geometry has no per-entity objects
      } else {
        const built = buildScene(expanded, this.buildOptions);
        group.add(built.scene);
        objects = built.objects;
      }
      this.scene.add(group);
      const simulated = isSimulated(rep);
      const chunk: LoadedChunk = { group, expanded, objects, rep, simulated, proxy };
      this.loaded.set(key, chunk);
      if (simulated) this.sim?.addEntities(expanded); // render-only rings never collide
      this.lifecycle.onLoaded?.(expanded, objects, simulated);
    } catch (error) {
      console.warn(`[chunks] failed to load ${file}:`, error);
    } finally {
      this.inFlight.delete(key);
    }
  }

  private unload(key: string, chunk: LoadedChunk): void {
    chunk.group.removeFromParent();
    chunk.group.traverse((node) => {
      const mesh = node as THREE.Mesh;
      if (mesh.isMesh) {
        mesh.geometry?.dispose();
        const material = mesh.material as THREE.Material | THREE.Material[];
        if (Array.isArray(material)) material.forEach((m) => m.dispose());
        else material?.dispose();
        // InstancedMesh (renderMode: "instanced" props) owns its own
        // instance-matrix GPU buffer separately from `geometry` — without
        // this it leaks one buffer per unload, worse the longer a session
        // streams chunks in and out.
        if ((mesh as THREE.InstancedMesh).isInstancedMesh) (mesh as THREE.InstancedMesh).dispose();
        const batch = mesh.userData["foliageLodBatch"] as InstancedPropBatch | undefined;
        if (batch) this.lifecycle.onDisposeInstancedBatch?.(batch);
      }
    });
    if (chunk.simulated) this.sim?.removeEntities(Object.keys(chunk.expanded.entities));
    this.lifecycle.onUnloaded?.(Object.keys(chunk.expanded.entities));
    this.loaded.delete(key);
  }

  private unloadAll(): void {
    for (const [key, chunk] of [...this.loaded]) this.unload(key, chunk);
  }
}

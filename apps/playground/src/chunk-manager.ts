import * as THREE from "three/webgpu";
import {
  chunkDocSchema,
  chunkToSceneDoc,
  expandScene,
  parseChunkCoords,
  validateScene,
  type AssetLibrary,
  type ChunkStreamerData,
  type ComponentRegistry,
  type SceneDoc,
} from "@hitreg/core";
import { buildScene, type BuildOptions } from "@hitreg/render";
import type { PhysicsSim } from "@hitreg/physics";

interface LoadedChunk {
  group: THREE.Object3D;
  /** Expanded doc — physics bodies re-attach from this on every play session. */
  expanded: SceneDoc;
  objects: Map<string, THREE.Object3D>;
}

export interface ChunkLifecycle {
  onLoaded?: (doc: SceneDoc, objects: Map<string, THREE.Object3D>) => void;
  onUnloaded?: (ids: Iterable<string>) => void;
}

/**
 * Streams chunk files (assets/chunks/<world>/<cx>_<cz>.chunk.json) in and out
 * around a focus point. Chunk content is RUNTIME-ONLY: it renders and collides
 * but never enters the scene document, so autosave/undo/diff stay clean.
 * Chunk JSON is validated with the same component schemas as scenes — invalid
 * files are rejected with a warning and load nothing.
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

  /** Entity count of loaded chunks (HUD/diagnostics). */
  get stats(): { chunks: number; entities: number } {
    let entities = 0;
    for (const chunk of this.loaded.values()) entities += Object.keys(chunk.expanded.entities).length;
    return { chunks: this.loaded.size, entities };
  }

  /** Visit currently resident chunks when a play-session runtime starts. */
  forEachLoaded(fn: (doc: SceneDoc, objects: Map<string, THREE.Object3D>) => void): void {
    for (const chunk of this.loaded.values()) fn(chunk.expanded, chunk.objects);
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
      this.lifecycle.onLoaded?.(chunk.expanded, chunk.objects);
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
    for (const chunk of this.loaded.values()) sim.addEntities(chunk.expanded);
  }

  /** Drive loading from the focus position. Cheap unless the focus changed cells. */
  update(fx: number, fz: number): void {
    const s = this.streamer;
    if (!s || !this.scene) return;
    const cx = Math.round(fx / s.cellSize);
    const cz = Math.round(fz / s.cellSize);
    if (this.lastFocus && this.lastFocus[0] === cx && this.lastFocus[1] === cz) return;
    this.lastFocus = [cx, cz];

    const wanted = new Set<string>();
    const r = Math.ceil(s.radius);
    for (let x = cx - r; x <= cx + r; x++) {
      for (let z = cz - r; z <= cz + r; z++) {
        if (Math.hypot(x - cx, z - cz) <= s.radius) wanted.add(`${x}_${z}`);
      }
    }
    for (const key of wanted) {
      if (this.available.has(key) && !this.loaded.has(key) && !this.inFlight.has(key)) {
        void this.load(key);
      }
    }
    const keep = s.radius + s.keepPadding;
    for (const [key, chunk] of this.loaded) {
      const [x, z] = key.split("_").map(Number) as [number, number];
      if (Math.hypot(x - cx, z - cz) > keep) this.unload(key, chunk);
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
      this.unload(key, chunk);
      await this.load(key, content);
    } else {
      this.lastFocus = null; // new file may be in range — re-evaluate
    }
  }

  private async load(key: string, rawContent?: string): Promise<void> {
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
      const built = buildScene(expanded, this.buildOptions);
      const group = new THREE.Group();
      group.name = `chunk:${key}`;
      group.add(built.scene);
      this.scene.add(group);
      const chunk: LoadedChunk = { group, expanded, objects: built.objects };
      this.loaded.set(key, chunk);
      this.sim?.addEntities(expanded);
      this.lifecycle.onLoaded?.(expanded, built.objects);
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
      }
    });
    this.sim?.removeEntities(Object.keys(chunk.expanded.entities));
    this.lifecycle.onUnloaded?.(Object.keys(chunk.expanded.entities));
    this.loaded.delete(key);
  }

  private unloadAll(): void {
    for (const [key, chunk] of [...this.loaded]) this.unload(key, chunk);
  }
}

import * as THREE from "three/webgpu";
import {
  expandScene,
  sceneDocSchema,
  subsceneToSceneDoc,
  validateScene,
  type AssetLibrary,
  type ComponentRegistry,
  type SceneDoc,
  type SubsceneData,
  type WorldTransform,
} from "@hitreg/core";
import { buildScene, type BuildOptions, type InstancedPropBatch } from "@hitreg/render";
import type { PhysicsSim } from "@hitreg/physics";

/** A `subscene` component instance found in the expanded world doc. */
export interface SubsceneInstance {
  id: string;
  world: WorldTransform;
  data: SubsceneData;
}

interface LoadedSubscene {
  sceneName: string;
  group: THREE.Object3D;
  expanded: SceneDoc;
  objects: Map<string, THREE.Object3D>;
}

export interface SubsceneLifecycle {
  onLoaded?: (doc: SceneDoc, objects: Map<string, THREE.Object3D>) => void;
  onUnloaded?: (ids: Iterable<string>) => void;
  /** A `renderMode: "instanced"` batch's subscene unloaded — unregister it
   * from whatever FoliageLodSystem tracks it before its meshes get disposed. */
  onDisposeInstancedBatch?: (batch: InstancedPropBatch) => void;
}

/**
 * Additive scene modules ("micro-scenes"): a world scene places whole scene
 * FILES as one-line `subscene` entities; this manager loads/unloads them —
 * `always` instances while the world is open, `proximity` instances by
 * distance to the focus. Same rules as chunk streaming: loaded content is
 * runtime-only (never enters the world doc), collides via sim.addEntities,
 * and hot-swaps when its scene file changes. Ids are namespaced per placing
 * entity, so one scene can be placed many times.
 */
export class SubsceneManager {
  private instances: SubsceneInstance[] = [];
  private readonly loaded = new Map<string, LoadedSubscene>();
  private readonly inFlight = new Set<string>();
  private scene: THREE.Scene | null = null;
  private sim: PhysicsSim | null = null;
  /** The world scene's own name — a scene must never subscene itself. */
  private worldName = "";
  private lastFocus: [number, number] | null = null;

  constructor(
    private readonly assets: AssetLibrary,
    private readonly registry: ComponentRegistry,
    private readonly buildOptions: BuildOptions,
    private readonly lifecycle: SubsceneLifecycle = {},
  ) {}

  get stats(): { loaded: number; entities: number } {
    let entities = 0;
    for (const sub of this.loaded.values()) entities += Object.keys(sub.expanded.entities).length;
    return { loaded: this.loaded.size, entities };
  }

  /** Called from rebuild() with the world's current subscene instances. */
  configure(worldName: string, instances: SubsceneInstance[], scene: THREE.Scene): void {
    this.scene = scene;
    this.worldName = worldName;
    this.instances = instances.filter((inst) => {
      if (inst.data.scene === worldName) {
        console.warn(`[subscene] ${inst.id}: a scene cannot subscene itself — skipped`);
        return false;
      }
      return true;
    });
    // drop instances that no longer exist; re-parent survivors into the new scene
    const alive = new Set(this.instances.map((i) => i.id));
    for (const [id, sub] of [...this.loaded]) {
      if (!alive.has(id)) this.unload(id, sub);
      else {
        scene.add(sub.group);
        this.lifecycle.onLoaded?.(sub.expanded, sub.objects);
      }
    }
    this.lastFocus = null;
    this.evaluate(); // `always` instances load immediately, focus or not
  }

  /** Visit currently loaded subscenes when a play-session runtime starts. */
  forEachLoaded(fn: (doc: SceneDoc, objects: Map<string, THREE.Object3D>) => void): void {
    for (const sub of this.loaded.values()) fn(sub.expanded, sub.objects);
  }

  setSim(sim: PhysicsSim | null): void {
    this.sim = sim;
    if (!sim) return;
    for (const sub of this.loaded.values()) sim.addEntities(sub.expanded);
  }

  update(fx: number, fz: number): void {
    if (!this.scene || this.instances.length === 0) return;
    if (this.lastFocus && Math.hypot(fx - this.lastFocus[0], fz - this.lastFocus[1]) < 4) return;
    this.lastFocus = [fx, fz];
    this.evaluate(fx, fz);
  }

  /** Live-sync: a scene file changed — hot-swap every loaded instance of it. */
  onSceneFileChanged(sceneName: string, content: string | null): void {
    for (const [id, sub] of [...this.loaded]) {
      if (sub.sceneName !== sceneName) continue;
      const instance = this.instances.find((i) => i.id === id);
      this.unload(id, sub);
      if (instance && content !== null) void this.load(instance, content);
    }
  }

  private evaluate(fx?: number, fz?: number): void {
    for (const inst of this.instances) {
      const isLoaded = this.loaded.has(inst.id);
      let wanted: boolean;
      if (inst.data.mode === "always") {
        wanted = true;
      } else if (fx === undefined || fz === undefined) {
        wanted = isLoaded; // no focus yet — leave proximity instances as they are
      } else {
        const dist = Math.hypot(inst.world.position[0] - fx, inst.world.position[2] - fz);
        wanted = isLoaded ? dist <= inst.data.radius + inst.data.keepPadding : dist <= inst.data.radius;
      }
      if (wanted && !isLoaded && !this.inFlight.has(inst.id)) void this.load(inst);
      else if (!wanted && isLoaded) this.unload(inst.id, this.loaded.get(inst.id)!);
    }
  }

  private async load(inst: SubsceneInstance, rawContent?: string): Promise<void> {
    if (!this.scene) return;
    this.inFlight.add(inst.id);
    try {
      const content: string =
        rawContent ??
        (await fetch(
          `/__hitreg/asset-file?file=${encodeURIComponent(`scenes/${inst.data.scene}.scene.json`)}`,
        ).then((r) => {
          if (!r.ok) throw new Error(`scene "${inst.data.scene}" not found`);
          return r.text();
        }));
      const parsed = sceneDocSchema.safeParse(JSON.parse(content));
      if (!parsed.success) {
        console.warn(`[subscene] ${inst.data.scene} failed validation:`, parsed.error.message.slice(0, 300));
        return;
      }
      const { doc, stripped } = subsceneToSceneDoc(inst.id, inst.world, parsed.data);
      if (stripped.length > 0) {
        console.info(`[subscene] ${inst.data.scene}: stripped standalone-only components (${stripped.join(", ")})`);
      }
      const issues = validateScene(doc, this.registry);
      if (issues.length > 0) {
        console.warn(`[subscene] ${inst.data.scene} has invalid components:`, issues);
        return;
      }
      const expanded = expandScene(doc, this.assets, this.registry);
      // world may have been reconfigured while we fetched
      if (!this.scene || !this.instances.some((i) => i.id === inst.id)) return;
      const built = buildScene(expanded, this.buildOptions);
      const group = new THREE.Group();
      group.name = `subscene:${inst.data.scene}@${inst.id}`;
      group.add(built.scene);
      this.scene.add(group);
      const sub: LoadedSubscene = {
        sceneName: inst.data.scene,
        group,
        expanded,
        objects: built.objects,
      };
      this.loaded.set(inst.id, sub);
      this.sim?.addEntities(expanded);
      this.lifecycle.onLoaded?.(expanded, built.objects);
    } catch (error) {
      console.warn(`[subscene] failed to load ${inst.data.scene}:`, error);
    } finally {
      this.inFlight.delete(inst.id);
    }
  }

  private unload(id: string, sub: LoadedSubscene): void {
    sub.group.removeFromParent();
    sub.group.traverse((node) => {
      const mesh = node as THREE.Mesh;
      if (mesh.isMesh) {
        mesh.geometry?.dispose();
        const material = mesh.material as THREE.Material | THREE.Material[];
        if (Array.isArray(material)) material.forEach((m) => m.dispose());
        else material?.dispose();
        if ((mesh as THREE.InstancedMesh).isInstancedMesh) (mesh as THREE.InstancedMesh).dispose();
        const batch = mesh.userData["foliageLodBatch"] as InstancedPropBatch | undefined;
        if (batch) this.lifecycle.onDisposeInstancedBatch?.(batch);
      }
    });
    this.sim?.removeEntities(Object.keys(sub.expanded.entities));
    this.lifecycle.onUnloaded?.(Object.keys(sub.expanded.entities));
    this.loaded.delete(id);
  }
}

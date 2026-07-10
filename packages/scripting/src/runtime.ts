import type * as THREE from "three";
import type { PlayerDataService, SceneDoc } from "@hitreg/core";
import type { InputLike, Script, ScriptContext, SimLike } from "./script.js";
import type { ScriptRegistry } from "./registry.js";

export interface RuntimeOptions {
  /** EXPANDED scene doc (prefabs resolved) — matches the runtime object map. */
  doc: SceneDoc;
  objects: Map<string, THREE.Object3D>;
  sim: SimLike | null;
  registry: ScriptRegistry;
  input: InputLike;
  /** Horizontal camera forward [x, z] — enables camera-relative controls. */
  viewForward?: () => [number, number];
  /** Host animation hook: crossfade an entity's animator to a clip. */
  setAnimation?: (entityId: string, clip: string, fadeSeconds?: number) => void;
  /** Host audio hook: play an entity's audio component or a sound asset id. */
  playSound?: (entityId: string, soundId?: string) => void;
  /** Experience-scoped persistence for the local player (ARCHITECTURE §3c). */
  playerData?: PlayerDataService;
}

interface ScriptComponentData {
  name: string;
  params: Record<string, unknown>;
}

/**
 * Play-mode script host: instantiates a Script per entity carrying a `script`
 * component, dispatches collisions, and steps onFixedUpdate. Lives and dies
 * with a play session — the document is never touched.
 */
export class ScriptRuntime {
  private readonly instances = new Map<string, Script>();
  private readonly entities: Map<string, SceneDoc["entities"][string]>;
  private readonly objects: Map<string, THREE.Object3D>;
  private timeMs = 0;
  private started = false;
  private activeCameraId: string | null = null;

  constructor(private readonly opts: RuntimeOptions) {
    this.entities = new Map(Object.entries(opts.doc.entities));
    this.objects = opts.objects;
  }

  /** Camera-entity id a script switched to, or null for the scene default. */
  getActiveCameraId(): string | null {
    return this.activeCameraId;
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    for (const [id, entity] of this.entities) this.startEntity(id, entity);
  }

  /** Attach runtime-only entities such as a streamed chunk. */
  addEntities(doc: SceneDoc, objects: Map<string, THREE.Object3D>): void {
    for (const [id, entity] of Object.entries(doc.entities)) {
      this.entities.set(id, entity);
      const object = objects.get(id);
      if (object) this.objects.set(id, object);
      if (this.started) this.startEntity(id, entity);
    }
  }

  /** Dispose scripts and forget entities removed with an unloaded chunk. */
  removeEntities(ids: Iterable<string>): void {
    for (const id of ids) {
      const script = this.instances.get(id);
      if (script) {
        try {
          script.onDispose?.();
        } catch (error) {
          console.warn(`[scripts] ${id} onDispose failed:`, error);
        }
        this.instances.delete(id);
      }
      this.entities.delete(id);
      this.objects.delete(id);
    }
  }

  private startEntity(id: string, entity: SceneDoc["entities"][string]): void {
      if (this.instances.has(id)) return;
      const comp = entity.components["script"] as ScriptComponentData | undefined;
      if (!comp) return;
      const cls = this.opts.registry.get(comp.name);
      if (!cls) {
        console.warn(`[scripts] entity ${id}: unknown script "${comp.name}"`);
        return;
      }
      const object = this.objects.get(id);
      if (!object) return;

      const context: ScriptContext = {
        entityId: id,
        object,
        params: { ...this.opts.registry.defaultParams(comp.name), ...comp.params },
        input: this.opts.input,
        sim: this.opts.sim,
        getEntity: (eid) => this.entities.get(eid),
        getObject: (eid) => this.objects.get(eid),
        findByTag: (tag) =>
          [...this.entities]
            .filter(([, e]) => e.tags.includes(tag))
            .map(([eid]) => eid),
        now: () => this.timeMs,
        ...(this.opts.viewForward ? { viewForward: this.opts.viewForward } : {}),
        setActiveCamera: (cameraId) => {
          this.activeCameraId = cameraId;
        },
        ...(this.opts.setAnimation
          ? { setAnimation: (clip: string, fade?: number) => this.opts.setAnimation!(id, clip, fade) }
          : {}),
        ...(this.opts.playSound
          ? { playSound: (soundId?: string) => this.opts.playSound!(id, soundId) }
          : {}),
        ...(this.opts.playerData ? { playerData: this.opts.playerData } : {}),
      };
      const script = new cls();
      script.ctx = context;
      this.instances.set(id, script);
      try {
        script.onStart?.();
      } catch (error) {
        console.warn(`[scripts] ${comp.name}@${id} onStart failed:`, error);
      }
  }

  fixedUpdate(dt: number): void {
    this.timeMs += dt * 1000;
    const collisions = this.opts.sim?.takeCollisions?.() ?? [];
    for (const [a, b] of collisions) {
      this.instances.get(a)?.onCollision?.(b);
      this.instances.get(b)?.onCollision?.(a);
    }
    for (const [id, script] of this.instances) {
      try {
        script.onFixedUpdate?.(dt);
      } catch (error) {
        console.warn(`[scripts] ${id} onFixedUpdate failed:`, error);
      }
    }
  }

  dispose(): void {
    for (const [id, script] of this.instances) {
      try {
        script.onDispose?.();
      } catch (error) {
        console.warn(`[scripts] ${id} onDispose failed:`, error);
      }
    }
    this.instances.clear();
  }
}

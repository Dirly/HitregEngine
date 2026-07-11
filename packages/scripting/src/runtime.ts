import type * as THREE from "three";
import type { PlayerDataService, SceneDoc } from "@hitreg/core";
import type { InputLike, Script, ScriptContext, SimLike } from "./script.js";
import type { ScriptRegistry } from "./registry.js";
import type { EventBus } from "./events.js";

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
  /** Host billboard hook: mutate an entity's billboard (fill/text/visible). */
  setBillboard?: (
    entityId: string,
    opts: { fill?: number; text?: string; visible?: boolean },
  ) => void;
  /** Experience-scoped persistence for the local player (ARCHITECTURE §3c). */
  playerData?: PlayerDataService;
  /**
   * Session event bus. The runtime emits the built-in engine events on it
   * (entity.spawned/destroyed, collision, trigger.enter/exit), exposes it to
   * scripts as ctx.events (subscriptions auto-unsubscribe on script dispose),
   * and drains it once per fixedUpdate after the script loop.
   */
  events?: EventBus;
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
  /** Per-script event unsubscribers — cleared when the script disposes. */
  private readonly subscriptions = new Map<string, Set<() => void>>();
  private timeMs = 0;
  private tickCount = 0;
  private started = false;
  private activeCameraId: string | null = null;

  constructor(private readonly opts: RuntimeOptions) {
    this.entities = new Map(Object.entries(opts.doc.entities));
    // COPY, never alias: the runtime deletes from this map when entities are
    // removed/suspended — aliasing the caller's render-object map would
    // silently destroy renderer/net entries too (a suspended NPC's ghost
    // must still find its object to write interpolated transforms to).
    this.objects = new Map(opts.objects);
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

  /**
   * Attach runtime-only entities such as a streamed chunk. `silent` skips
   * the entity.spawned events — for net ghost resume, where the entity was
   * never gone from the world, only from local simulation.
   */
  addEntities(
    doc: SceneDoc,
    objects: Map<string, THREE.Object3D>,
    opts?: { silent?: boolean },
  ): void {
    for (const [id, entity] of Object.entries(doc.entities)) {
      this.entities.set(id, entity);
      const object = objects.get(id);
      if (object) this.objects.set(id, object);
      if (this.started) {
        this.startEntity(id, entity);
        // spawned = appeared AFTER session start; play start is not spawning
        if (!opts?.silent) this.opts.events?.emit("entity.spawned", { entityId: id });
      }
    }
  }

  /**
   * Dispose scripts and forget entities removed with an unloaded chunk.
   * `silent` skips the entity.destroyed events — for net ghost suspension,
   * where the entity still exists but the host now simulates it.
   */
  removeEntities(ids: Iterable<string>, opts?: { silent?: boolean }): void {
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
      this.dropSubscriptions(id);
      const known = this.entities.delete(id);
      this.objects.delete(id);
      if (known && this.started && !opts?.silent) {
        this.opts.events?.emit("entity.destroyed", { entityId: id });
      }
    }
  }

  /** Unhook every event subscription a script's ctx.events made. */
  private dropSubscriptions(id: string): void {
    const subs = this.subscriptions.get(id);
    if (!subs) return;
    this.subscriptions.delete(id);
    for (const off of subs) off();
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
        ...(this.opts.setBillboard
          ? {
              setBillboard: (opts: { fill?: number; text?: string; visible?: boolean }) =>
                this.opts.setBillboard!(id, opts),
            }
          : {}),
        ...(this.opts.playerData ? { playerData: this.opts.playerData } : {}),
        ...(this.opts.events ? { events: this.scopedEvents(id, this.opts.events) } : {}),
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

  /**
   * ctx.events for one script: emits pass straight through; every subscription
   * is tracked so it auto-unsubscribes when the script disposes.
   */
  private scopedEvents(id: string, bus: EventBus): NonNullable<ScriptContext["events"]> {
    const track = (off: () => void): (() => void) => {
      let subs = this.subscriptions.get(id);
      if (!subs) {
        subs = new Set();
        this.subscriptions.set(id, subs);
      }
      const tracked = (): void => {
        off();
        this.subscriptions.get(id)?.delete(tracked);
      };
      subs.add(tracked);
      return tracked;
    };
    return {
      emit: (name, payload) => bus.emit(name, payload),
      on: (name, cb) => track(bus.on(name, cb)),
      once: (name, cb) => track(bus.once(name, cb)),
    };
  }

  fixedUpdate(dt: number): void {
    this.timeMs += dt * 1000;
    this.tickCount++;
    const collisions = this.opts.sim?.takeCollisions?.() ?? [];
    for (const [a, b] of collisions) {
      this.instances.get(a)?.onCollision?.(b);
      this.instances.get(b)?.onCollision?.(a);
    }
    // parallel event surface: the onCollision hook above stays untouched
    const bus = this.opts.events;
    if (bus) {
      const sim = this.opts.sim;
      for (const [a, b] of collisions) {
        const aTrigger = sim?.isTrigger?.(a) ?? false;
        const bTrigger = sim?.isTrigger?.(b) ?? false;
        if (aTrigger) bus.emit("trigger.enter", { trigger: a, other: b });
        if (bTrigger) bus.emit("trigger.enter", { trigger: b, other: a });
        if (!aTrigger && !bTrigger) bus.emit("collision", { a, b });
      }
      for (const [a, b] of sim?.takeCollisionEnds?.() ?? []) {
        const aTrigger = sim?.isTrigger?.(a) ?? false;
        const bTrigger = sim?.isTrigger?.(b) ?? false;
        if (aTrigger) bus.emit("trigger.exit", { trigger: a, other: b });
        if (bTrigger) bus.emit("trigger.exit", { trigger: b, other: a });
      }
    }
    for (const [id, script] of this.instances) {
      try {
        script.onFixedUpdate?.(dt);
      } catch (error) {
        console.warn(`[scripts] ${id} onFixedUpdate failed:`, error);
      }
    }
    // fixed drain point: everything emitted up to here delivers this tick, FIFO
    bus?.drain(this.tickCount);
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
    for (const id of [...this.subscriptions.keys()]) this.dropSubscriptions(id);
  }
}

import type * as THREE from "three";
import type { NetStateStore, PlayerDataService, SceneDoc } from "@hitreg/core";
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
  /** Host animation hook: crossfade an entity's animator to a clip (loop:false = one-shot). */
  setAnimation?: (entityId: string, clip: string, fadeSeconds?: number, opts?: { loop?: boolean }) => void;
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
  /**
   * Replicated session state, exposed to scripts as ctx.netState
   * (onChange subscriptions auto-unsubscribe on script dispose).
   */
  netState?: NetStateStore;
}

interface ScriptComponentData {
  name: string;
  params: Record<string, unknown>;
}

/** A sim-stepped timer (ctx.after / ctx.every). Times are in accumulated ms. */
interface Timer {
  dueAtMs: number;
  /** null = one-shot; otherwise the repeat period in ms. */
  intervalMs: number | null;
  cb: () => void;
  /** Cleared when fired-and-done or cancelled — makes stale handles no-ops. */
  live: boolean;
  /** Idempotent teardown: drops the timer from the run set and its script scope. */
  dispose: () => void;
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
  /** Live sim-stepped timers, insertion-ordered (deterministic fire order). */
  private readonly timers = new Set<Timer>();
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
   * Net suspension: the session authority simulates these entities now.
   * Their scripts stop (disposed, subscriptions dropped) but the entities
   * and objects STAY registered — other scripts still target them
   * (findByTag/getObject) and the net layer drives their ghost objects.
   */
  suspendEntities(ids: Iterable<string>): void {
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
    }
  }

  /** Ids of entities carrying a tag — the same lookup scripts get via ctx. */
  findByTag(tag: string): string[] {
    return [...this.entities].filter(([, e]) => e.tags.includes(tag)).map(([eid]) => eid);
  }

  /** Restart scripts suspended earlier (the authority handed them back). */
  resumeEntities(ids: Iterable<string>): void {
    if (!this.started) return;
    for (const id of ids) {
      const entity = this.entities.get(id);
      if (entity) this.startEntity(id, entity);
    }
  }

  /**
   * Dispose scripts and forget entities removed with an unloaded chunk.
   * `silent` skips the entity.destroyed events — for runtime plumbing
   * (net proxies), where nothing gameplay-visible was destroyed.
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
        findByTag: (tag) => this.findByTag(tag),
        now: () => this.timeMs,
        after: (seconds, cb) => this.scheduleTimer(id, seconds, cb, false),
        every: (seconds, cb) => this.scheduleTimer(id, seconds, cb, true),
        ...(this.opts.viewForward ? { viewForward: this.opts.viewForward } : {}),
        setActiveCamera: (cameraId) => {
          this.activeCameraId = cameraId;
        },
        ...(this.opts.setAnimation
          ? {
              setAnimation: (clip: string, fade?: number, opts?: { loop?: boolean }) =>
                this.opts.setAnimation!(id, clip, fade, opts),
            }
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
        ...(this.opts.netState ? { netState: this.scopedNetState(id, this.opts.netState) } : {}),
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

  /** ctx.netState for one script: onChange subscriptions auto-unsubscribe. */
  private scopedNetState(id: string, store: NetStateStore): NonNullable<ScriptContext["netState"]> {
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
      isAuthority: () => store.isAuthority(),
      get: (key) => store.get(key),
      keys: (prefix) => store.keys(prefix),
      set: (key, value) => store.set(key, value),
      increment: (key, delta) => store.increment(key, delta),
      delete: (key) => store.delete(key),
      onChange: (cb) => track(store.onChange(cb)),
    };
  }

  /**
   * Register a sim-stepped timer scoped to entity `id`. The returned cancel is
   * also tracked in the script's subscription set, so suspend/dispose/remove
   * cancels any timers the script left running (like ctx.events subscriptions).
   */
  private scheduleTimer(
    id: string,
    seconds: number,
    cb: () => void,
    repeating: boolean,
  ): () => void {
    const delayMs = Math.max(seconds, 0) * 1000;
    const timer: Timer = {
      dueAtMs: this.timeMs + delayMs,
      intervalMs: repeating ? delayMs : null,
      cb,
      live: true,
      dispose: () => {},
    };
    let subs = this.subscriptions.get(id);
    if (!subs) {
      subs = new Set();
      this.subscriptions.set(id, subs);
    }
    const dispose = (): void => {
      timer.live = false;
      this.timers.delete(timer);
      this.subscriptions.get(id)?.delete(dispose);
    };
    timer.dispose = dispose;
    this.timers.add(timer);
    subs.add(dispose);
    return dispose;
  }

  /**
   * Fire every timer due at the current sim time. A repeating timer fires at
   * most once per tick — sub-tick periods collapse to one-per-tick and a
   * long-stalled timer never bursts a backlog (both would be non-determinism
   * hazards). snapshot the set first: a callback may schedule or cancel timers.
   */
  private stepTimers(dt: number): void {
    if (this.timers.size === 0) return;
    const minIncMs = dt * 1000;
    for (const timer of [...this.timers]) {
      if (!timer.live || timer.dueAtMs > this.timeMs) continue;
      try {
        timer.cb();
      } catch (error) {
        console.warn(`[scripts] timer callback failed:`, error);
      }
      if (!timer.live) continue; // the callback cancelled it
      if (timer.intervalMs === null) {
        timer.dispose();
        continue;
      }
      // reschedule strictly past now: on-cadence normally, once/tick if sub-tick
      timer.dueAtMs = Math.max(timer.dueAtMs + timer.intervalMs, this.timeMs + minIncMs);
    }
  }

  fixedUpdate(dt: number): void {
    this.timeMs += dt * 1000;
    this.tickCount++;
    // timers first: their callbacks emit onto the bus, which drains this tick
    this.stepTimers(dt);
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
    this.timers.clear();
  }
}

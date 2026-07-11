import type * as THREE from "three";
import type { EntityDoc, PlayerDataService } from "@hitreg/core";

/** Declared tuning value — drives inspector fields and the AI-facing spec. */
export interface ScriptParamSpec {
  default: unknown;
  min?: number;
  max?: number;
  description?: string;
}

/** What scripts may touch. Deliberately narrow; grows with the engine. */
export interface ScriptContext {
  entityId: string;
  /** The entity's runtime object (play-mode state — never the document). */
  object: THREE.Object3D;
  /** Declared defaults merged with the entity's script.params. */
  params: Record<string, unknown>;
  input: InputLike;
  sim: SimLike | null;
  getEntity(id: string): EntityDoc | undefined;
  /** Runtime object of ANY entity (world queries: positions, visibility). */
  getObject(id: string): THREE.Object3D | undefined;
  /** Entity ids carrying a tag (expanded scene). */
  findByTag(tag: string): string[];
  /** Milliseconds of simulated time (fixed-step accumulated, replay-safe). */
  now(): number;
  /** Horizontal camera forward [x, z], normalized — for camera-relative movement. */
  viewForward?(): [number, number];
  /** Switch the render camera to another camera-component entity (runtime-only). */
  setActiveCamera?(entityId: string | null): void;
  /** Crossfade this entity's animator to a clip (Unity-style blending). */
  setAnimation?(clip: string, fadeSeconds?: number): void;
  /** Play this entity's audio component, or any sound asset id, at this entity. */
  playSound?(soundId?: string): void;
  /** Mutate this entity's billboard at runtime (HP bar fill, label text) — never the document. */
  setBillboard?(opts: { fill?: number; text?: string; visible?: boolean }): void;
  /**
   * Typed gameplay events (deterministic pub/sub). `emit` queues — nothing
   * dispatches synchronously; the runtime drains the queue in FIFO order at a
   * fixed point each tick, so emit from onFixedUpdate stays replay/multiplayer
   * safe. Subscriptions made here are auto-unsubscribed when this script is
   * disposed. Registered event payloads are schema-validated on emit.
   */
  events?: ScriptEvents;
  /**
   * Replicated session state — facts every tab agrees on (enemy HP, chest
   * opened, score). Reads everywhere; writes on the authority only. Dies
   * with the room; commit durable results into ctx.playerData.
   */
  netState?: ScriptNetState;
  /**
   * Experience-scoped persistence for the local player (async — use from
   * onStart or fire-and-forget; never block onFixedUpdate on it):
   * `ctx.playerData?.set("primary", "wood", 42)`. Quotas, rate limits, and
   * atomic revisions are enforced by the service; category-1 platform data
   * (currency, cosmetics, entitlements) is NOT reachable from here by design.
   */
  playerData?: PlayerDataService;
}

export interface InputLike {
  isDown(code: string): boolean;
}

/**
 * The event surface handed to scripts (a scoped wrapper over the session
 * EventBus). `meta.from` identifies the requesting peer when a handler runs
 * on the authority for a "to-authority" event.
 */
export interface ScriptEvents {
  emit(name: string, payload: unknown): void;
  on(name: string, cb: (payload: unknown, meta?: { from?: string }) => void): () => void;
  once(name: string, cb: (payload: unknown, meta?: { from?: string }) => void): () => void;
}

/**
 * Replicated session state (the NetworkVariables analog): facts every tab
 * must agree on — enemy HP, "chest opened", round score. Keys are
 * "namespace/rest". Reads work everywhere; writes only apply on the
 * session authority (peers get a warning no-op — request the change
 * through a to-authority event instead). Everything here dies with the
 * room: commit durable results into ctx.playerData explicitly.
 */
export interface ScriptNetState {
  /** True when this session may write (host or single-player). */
  isAuthority(): boolean;
  get(key: string): unknown;
  keys(prefix?: string): string[];
  /** Authority only. Returns false when refused (peer / invalid). */
  set(key: string, value: unknown): boolean;
  /** Authority only. Returns the new value, or null when refused. */
  increment(key: string, delta?: number): number | null;
  /** Authority only. */
  delete(key: string): boolean;
  /** Fires on every change, local or replicated. Auto-unsubscribed on dispose. */
  onChange(cb: (key: string, value: unknown) => void): () => void;
}

/** The physics surface scripts may use (implemented by @hitreg/physics.PhysicsSim). */
export interface SimLike {
  getLinvel(id: string): [number, number, number] | null;
  setLinvel(id: string, v: [number, number, number]): void;
  applyImpulse(id: string, v: [number, number, number]): void;
  /** Teleport (respawns): position set, velocities zeroed. */
  setPosition?(id: string, p: [number, number, number]): void;
  takeCollisions?(): Array<[string, string]>;
  /** Collision-ended pairs since the last call (drives "trigger.exit"). */
  takeCollisionEnds?(): Array<[string, string]>;
  /** Whether the entity's collider is a sensor (isTrigger). */
  isTrigger?(id: string): boolean;
}

/**
 * Base class for behaviors. Gameplay state may only change in onFixedUpdate
 * (multiplayer invariant). Params are declared statically so the inspector
 * and AI can read them without instantiating anything.
 */
export abstract class Script {
  static scriptName = "";
  static params: Record<string, ScriptParamSpec> = {};

  ctx!: ScriptContext;

  get object(): THREE.Object3D {
    return this.ctx.object;
  }

  get entityId(): string {
    return this.ctx.entityId;
  }

  param<T>(key: string): T {
    return this.ctx.params[key] as T;
  }

  onStart?(): void;
  onFixedUpdate?(dt: number): void;
  onCollision?(otherId: string): void;
  /** Play session ended (stop pressed) — clean up anything external (DOM, timers). */
  onDispose?(): void;
}

export type ScriptClass = (new () => Script) & {
  scriptName: string;
  params?: Record<string, ScriptParamSpec>;
};

/**
 * HeadlessWorld — the SAME play session the playground runs, minus rendering.
 *
 * What a play session is, on either side (ARCHITECTURE §3: "the engine core
 * runs headless in Node — no renderer, same sim code"):
 *
 *   expanded scene doc  →  runtime objects (a scene graph)  →  PhysicsSim
 *                                                            →  ScriptRuntime + EventBus + NetStateStore
 *
 * The runtime objects here are plain `three` `Object3D`s: scripts read
 * `ctx.object.position`, `matrixWorld`, `userData` and so on, and three's
 * scene-graph math has no DOM dependency. Nothing here draws.
 *
 * Runtime entities (streamed terrain cells, joined players, spawned NPCs) go
 * through `addEntities` / `removeEntities`, which keep the three maps the
 * playground's ChunkManager keeps — objects, sim bodies, scripts — in step.
 */

import * as THREE from "three";
import {
  ComponentRegistry,
  registerCoreComponents,
  registerChunkComponents,
  EventRegistry,
  registerCoreEvents,
  AssetLibrary,
  expandScene,
  NetStateStore,
  type SceneDoc,
  type EntityDoc,
} from "@hitreg/core";
import {
  ScriptRegistry,
  registerBuiltinScripts,
  ScriptRuntime,
  EventBus,
  type InputLike,
} from "@hitreg/scripting";
import { PhysicsSim, initPhysics, type BodyState, type MeshGeometryData } from "@hitreg/physics";
import { isClientOnlyScript } from "./scripts.js";

/** A keyboard nobody is pressing — the server has no local player. */
export const NULL_INPUT: InputLike = { isDown: () => false, mouseDelta: () => [0, 0] };

export interface HeadlessWorldOptions {
  /** Authored (unexpanded) scene document. */
  doc: SceneDoc;
  assets: AssetLibrary;
  /** Component registry; a fresh one with core + chunk components by default. */
  registry?: ComponentRegistry;
  /** Event registry; a fresh one with the core events by default. */
  events?: EventRegistry;
  /** Script registry; a fresh one with the builtins by default. */
  scripts?: ScriptRegistry;
  /** Sim rate. Default 60, the engine default. */
  fixedHz?: number;
  /**
   * Collision geometry for asset-mesh colliders. The server has no GLB
   * loader today; omit and trimesh/convex asset colliders fall back to boxes.
   */
  meshGeometry?: (assetId: string, node?: string) => MeshGeometryData | Promise<MeshGeometryData | null> | null | undefined;
  /** Entities to leave out of the world at boot (by predicate) — e.g. the scene doc's own player. */
  exclude?: (id: string, entity: EntityDoc) => boolean;
}

export interface AddEntitiesOptions {
  /** Attach physics bodies (default true). */
  simulate?: boolean;
  /** Suppress entity.spawned events (default false). */
  silent?: boolean;
}

export class HeadlessWorld {
  readonly registry: ComponentRegistry;
  readonly eventRegistry: EventRegistry;
  readonly scriptRegistry: ScriptRegistry;
  readonly assets: AssetLibrary;
  /** The expanded base scene (prefabs resolved) as booted — excluded entities removed. */
  readonly base: SceneDoc;
  /** The full expansion, before `exclude` — where a player template is read from. */
  readonly expanded: SceneDoc;
  /** Every live entity's doc, base + runtime, keyed by id. */
  readonly entities = new Map<string, EntityDoc>();
  /** Runtime scene graph. */
  readonly scene = new THREE.Scene();
  readonly objects = new Map<string, THREE.Object3D>();
  readonly sim: PhysicsSim;
  readonly eventBus: EventBus;
  readonly netState = new NetStateStore();
  readonly scripts: ScriptRuntime;
  readonly fixedDt: number;
  /** Current animation clip per entity, as scripts requested it (the `anim` replica field). */
  readonly anims = new Map<string, string>();
  /** Runs at the top of every fixed step, before physics (movement drivers live here). */
  readonly beforeStep = new Set<(dt: number) => void>();
  /** Runs after scripts each fixed step (replication, bookkeeping). */
  readonly afterStep = new Set<(dt: number) => void>();
  private _tick = 0;
  private disposed = false;

  private constructor(opts: HeadlessWorldOptions, base: SceneDoc, expanded: SceneDoc) {
    this.registry = opts.registry!;
    this.expanded = expanded;
    this.eventRegistry = opts.events!;
    this.scriptRegistry = opts.scripts!;
    this.assets = opts.assets;
    this.base = base;
    this.fixedDt = 1 / (opts.fixedHz ?? 60);
    this.scene.name = "server";
    this.sim = new PhysicsSim({ ...base, entities: {} }, undefined, {
      meshGeometry: opts.meshGeometry ?? (() => null),
    });
    this.eventBus = new EventBus(this.eventRegistry);
    this.eventBus.setNetRole("authority");
    this.netState.setAuthority(true);
    this.scripts = new ScriptRuntime({
      doc: { ...base, entities: {} },
      objects: new Map(),
      sim: this.sim,
      registry: this.scriptRegistry,
      input: NULL_INPUT,
      events: this.eventBus,
      netState: this.netState,
      setAnimation: (id, clip) => {
        this.anims.set(id, clip);
      },
      animationClips: () => [],
      setAnimationSpeed: () => undefined,
      setBillboard: () => undefined,
      setParticles: () => undefined,
      setLight: () => undefined,
      playSound: () => undefined,
    });
    this.scripts.start();
  }

  /**
   * Boot a world from an authored scene. Physics WASM initialises on first
   * use; the base scene's entities are added exactly like runtime ones so
   * there is one code path for "an entity exists on the server".
   */
  static async create(opts: HeadlessWorldOptions): Promise<HeadlessWorld> {
    await initPhysics();
    const registry = opts.registry ?? defaultRegistry();
    const events = opts.events ?? defaultEvents();
    const scripts = opts.scripts ?? defaultScripts();
    const full = expandScene(opts.doc, opts.assets, registry);
    const expanded: SceneDoc = { ...full, entities: { ...full.entities } };
    if (opts.exclude) {
      const drop = new Set<string>();
      for (const [id, entity] of Object.entries(expanded.entities)) {
        if (opts.exclude(id, entity)) drop.add(id);
      }
      // cascade to descendants: an excluded body takes its children with it
      let grew = true;
      while (grew) {
        grew = false;
        for (const [id, entity] of Object.entries(expanded.entities)) {
          if (!drop.has(id) && entity.parent !== null && drop.has(entity.parent)) {
            drop.add(id);
            grew = true;
          }
        }
      }
      for (const id of drop) delete expanded.entities[id];
    }
    const world = new HeadlessWorld({ ...opts, registry, events, scripts }, expanded, full);
    world.addEntities(expanded, { silent: true });
    return world;
  }

  get tick(): number {
    return this._tick;
  }

  /** Simulated milliseconds (what scripts see as ctx.now()). */
  get timeMs(): number {
    return this._tick * this.fixedDt * 1000;
  }

  /**
   * Add entities from an EXPANDED doc. Objects are parented per the doc (to
   * an entity in this batch or one already live; otherwise the scene root),
   * bodies attach, scripts start — client-only scripts are stripped first.
   */
  addEntities(doc: SceneDoc, opts: AddEntitiesOptions = {}): void {
    if (this.disposed) return;
    const pending = new Map(Object.entries(doc.entities));
    const objects = new Map<string, THREE.Object3D>();
    // parents first: loop until every entity found its parent (or gave up)
    let progress = true;
    while (pending.size > 0 && progress) {
      progress = false;
      for (const [id, entity] of pending) {
        const parentId = entity.parent;
        const parent =
          parentId === null
            ? this.scene
            : (objects.get(parentId) ?? this.objects.get(parentId) ?? null);
        if (parent === null && parentId !== null && (pending.has(parentId) || !doc.entities[parentId])) {
          if (pending.has(parentId)) continue; // wait for the parent
        }
        const object = makeObject(id, entity);
        (parent ?? this.scene).add(object);
        objects.set(id, object);
        this.objects.set(id, object);
        this.entities.set(id, entity);
        pending.delete(id);
        progress = true;
      }
    }
    for (const [id, entity] of pending) {
      // unreachable parent — attach at the root rather than lose the entity
      const object = makeObject(id, entity);
      this.scene.add(object);
      objects.set(id, object);
      this.objects.set(id, object);
      this.entities.set(id, entity);
    }
    this.scene.updateMatrixWorld(true);
    if (opts.simulate !== false) this.sim.addEntities(doc);
    // scripts: strip the client-only ones so the runtime never instantiates them
    const forScripts: SceneDoc = { ...doc, entities: {} };
    for (const [id, entity] of Object.entries(doc.entities)) {
      const script = entity.components["script"] as { name?: string } | undefined;
      if (script?.name && isClientOnlyScript(this.scriptRegistry, script.name)) {
        const { script: _dropped, ...rest } = entity.components;
        forScripts.entities[id] = { ...entity, components: rest };
      } else {
        forScripts.entities[id] = entity;
      }
    }
    this.scripts.addEntities(forScripts, objects, { silent: opts.silent ?? false });
  }

  /** Remove entities (and nothing else — pass descendants explicitly, see {@link subtree}). */
  removeEntities(ids: Iterable<string>, opts: { silent?: boolean } = {}): void {
    const list = [...ids];
    if (list.length === 0) return;
    this.sim.removeEntities(list);
    this.scripts.removeEntities(list, { silent: opts.silent ?? false });
    for (const id of list) {
      const object = this.objects.get(id);
      object?.parent?.remove(object);
      this.objects.delete(id);
      this.entities.delete(id);
      this.anims.delete(id);
    }
  }

  /** An entity id plus every live descendant, parents before children. */
  subtree(rootId: string): string[] {
    const out = [rootId];
    for (let i = 0; i < out.length; i++) {
      for (const [id, entity] of this.entities) {
        if (entity.parent === out[i] && !out.includes(id)) out.push(id);
      }
    }
    return out;
  }

  /** Ids carrying a tag, base and runtime alike. */
  findByTag(tag: string): string[] {
    const out: string[] = [];
    for (const [id, entity] of this.entities) if (entity.tags.includes(tag)) out.push(id);
    return out;
  }

  /** World position of a live entity, or null. */
  positionOf(id: string): [number, number, number] | null {
    const object = this.objects.get(id);
    if (!object) return null;
    const p = object.getWorldPosition(scratchPos);
    return [p.x, p.y, p.z];
  }

  /** World quaternion of a live entity, or null. */
  quaternionOf(id: string): [number, number, number, number] | null {
    const object = this.objects.get(id);
    if (!object) return null;
    const q = object.getWorldQuaternion(scratchQuat);
    return [q.x, q.y, q.z, q.w];
  }

  /**
   * One fixed step: drivers → physics → body readback → scripts (which drain
   * the event bus) → after-hooks. Identical order to the playground's loop.
   */
  step(): void {
    if (this.disposed) return;
    const dt = this.fixedDt;
    for (const hook of this.beforeStep) hook(dt);
    this.sim.step(dt);
    for (const [id, state] of this.sim.states()) {
      const object = this.objects.get(id);
      if (object) applyBodyState(object, state);
    }
    this.scene.updateMatrixWorld(true);
    this.scripts.fixedUpdate(dt);
    this.scene.updateMatrixWorld(true); // scripts move things too (yaw, teleports)
    this._tick += 1;
    for (const hook of this.afterStep) hook(dt);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.scripts.dispose();
    this.sim.free();
  }
}

const scratchPos = new THREE.Vector3();
const scratchQuat = new THREE.Quaternion();
const bodyWorldPos = new THREE.Vector3();
const parentQuat = new THREE.Quaternion();
const bodyQuat = new THREE.Quaternion();

/** Write a body's world pose into an object that may have a transformed parent. */
export function applyBodyState(object: THREE.Object3D, state: BodyState): void {
  const parent = object.parent;
  if (!parent) return;
  parent.updateWorldMatrix(true, false);
  object.position.copy(
    parent.worldToLocal(bodyWorldPos.set(state.position[0], state.position[1], state.position[2])),
  );
  parent.getWorldQuaternion(parentQuat).invert();
  object.quaternion.copy(
    parentQuat.multiply(bodyQuat.set(state.rotation[0], state.rotation[1], state.rotation[2], state.rotation[3])),
  );
}

function makeObject(id: string, entity: EntityDoc): THREE.Object3D {
  const object = new THREE.Object3D();
  object.name = id;
  const t = entity.components["transform"] as
    | { position?: number[]; rotation?: number[]; scale?: number[] }
    | undefined;
  if (t?.position) object.position.fromArray(t.position);
  if (t?.rotation) object.quaternion.fromArray(t.rotation);
  if (t?.scale) object.scale.fromArray(t.scale);
  return object;
}

export function defaultRegistry(): ComponentRegistry {
  const registry = new ComponentRegistry();
  registerCoreComponents(registry);
  registerChunkComponents(registry);
  return registry;
}

export function defaultEvents(): EventRegistry {
  const events = new EventRegistry();
  registerCoreEvents(events);
  return events;
}

export function defaultScripts(): ScriptRegistry {
  const scripts = new ScriptRegistry();
  registerBuiltinScripts(scripts);
  return scripts;
}

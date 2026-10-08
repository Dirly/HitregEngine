import { z } from "zod";
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
  registerCharacterNetState,
  registerTransferLockNetState,
  registerLandingNetState,
  registerNoticeNetState,
  registerSanctuariesNetState,
  getVoxelWorld,
  type ProfilerLike,
  type SceneDoc,
  type EntityDoc,
} from "@hitreg/core";
import {
  ScriptRegistry,
  registerBuiltinScripts,
  ScriptRuntime,
  EventBus,
  type BiomeAt,
  type InputLike,
} from "@hitreg/scripting";

/**
 * ctx.biomeAt on the server: the scene's voxel world (looked up per call — a
 * recipe edit swaps the field) answers what biome a point is, so authority
 * scripts (a quest's `weather` condition) judge the ground the way the client's
 * weather does. No voxel world = null.
 */
function serverBiomeAt(doc: SceneDoc): (x: number, z: number) => BiomeAt | null {
  let worldId: string | null | undefined;
  return (x, z) => {
    if (worldId === undefined) {
      worldId = null;
      for (const e of Object.values(doc.entities)) {
        const v = e.components["voxelWorld"] as { world?: string } | undefined;
        if (v?.world) {
          worldId = v.world;
          break;
        }
      }
    }
    const field = worldId ? getVoxelWorld(worldId) : null;
    if (!field) return null;
    if (field.worldLimit !== Infinity && Math.hypot(x, z) > field.worldLimit) return null;
    const s = field.biome(x, z);
    const weights: Record<string, number> = {};
    field.recipe.biomes.forEach((rule, i) => {
      const w = s.weights[i] ?? 0;
      if (w > 1e-4) weights[rule.id] = w;
    });
    return { id: s.id, zone: s.zone, weights, ground: field.height(x, z), temperature: s.temperature, moisture: s.moisture, slope: s.slope };
  };
}
import { PhysicsSim, initPhysics, type BodyState, type MeshGeometryData, type StaticStreamingOptions } from "@hitreg/physics";
import { registerCommsEvents } from "@hitreg/comms";
import { isClientOnlyScript } from "./scripts.js";
import { fileMeshGeometry } from "./mesh-geometry.js";

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
   * Collision geometry for asset-mesh colliders. Default: read each model's
   * file (its asset url is a path on disk here) and extract the same triangles
   * the browser cooks — without it a trimesh/convex asset collider falls back
   * to a `collider.size` box at the entity origin and the authority's world
   * disagrees with every client's.
   */
  meshGeometry?: (assetId: string, node?: string) => MeshGeometryData | Promise<MeshGeometryData | null> | null | undefined;
  /**
   * Build static prop/building mesh colliders only near foci (PhysicsSim
   * `streamStatics`). Whoever owns the world must then call
   * `sim.updateStatics(foci)`: GameServer does, with the terrain foci.
   */
  streamStatics?: StaticStreamingOptions;
  /** Entities to leave out of the world at boot (by predicate; descendants go with them) — e.g. the scene doc's own player, or what lies outside the zones a copy hosts. `entities` is the whole expanded scene. */
  exclude?: (id: string, entity: EntityDoc, entities: Readonly<Record<string, EntityDoc>>) => boolean;
  /**
   * Tick profiler (`serve --profile`): `physics`, `scripts` and `matrices`
   * scopes per step, and the runtime's own per-script-name scopes in `scripts`.
   */
  profiler?: ProfilerLike;
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
  /** Layer clip per entity (the masked clip riding over `anims`) — the `animL` replica field. */
  readonly animLayers = new Map<string, string>();
  /**
   * Playback rate per entity — the `animR` replica field. A clip name alone
   * makes every remote body play its walk cycle at the authored speed whatever
   * pace it is actually travelling at, which is foot-skate by construction.
   */
  readonly animRates = new Map<string, number>();
  /** Runs at the top of every fixed step, before physics (movement drivers live here). */
  readonly beforeStep = new Set<(dt: number) => void>();
  /** Runs after the physics readback, before scripts (what the readback overwrote and scripts must see: a player's yaw). */
  readonly afterPhysics = new Set<(dt: number) => void>();
  /** Runs after scripts each fixed step (replication, bookkeeping). */
  readonly afterStep = new Set<(dt: number) => void>();
  private readonly profiler: ProfilerLike | undefined;
  /** Static mesh colliders stream around foci (HeadlessWorldOptions.streamStatics). */
  readonly streamsStatics: boolean;
  private _tick = 0;
  /** Moves whenever entities are added or removed (a cache keyed on the entity set can tell it is stale). */
  entityVersion = 0;
  private disposed = false;

  private constructor(opts: HeadlessWorldOptions, base: SceneDoc, expanded: SceneDoc) {
    this.registry = opts.registry!;
    this.expanded = expanded;
    this.eventRegistry = opts.events!;
    this.scriptRegistry = opts.scripts!;
    this.assets = opts.assets;
    this.base = base;
    this.fixedDt = 1 / (opts.fixedHz ?? 60);
    this.profiler = opts.profiler;
    this.streamsStatics = opts.streamStatics !== undefined;
    this.scene.name = "server";
    // the root never moves: composing it every step would make `updateMatrixWorld(false)` force every child
    // anyway (see classifyMatrices: static subtrees are skipped only when nothing above them forces)
    this.scene.matrixAutoUpdate = false;
    this.sim = new PhysicsSim({ ...base, entities: {} }, undefined, {
      meshGeometry: opts.meshGeometry ?? fileMeshGeometry((id) => opts.assets.getModel(id)?.url),
      ...(opts.streamStatics ? { streamStatics: opts.streamStatics } : {}),
    });
    this.eventBus = new EventBus(this.eventRegistry);
    this.eventBus.setNetRole("authority");
    this.netState.setAuthority(true);
    registerCharacterNetState(this.netState); // character/<bodyId> sheets validate + appear in the spec
    registerTransferLockNetState(this.netState); // transferLock/<bodyId> — combat scripts hold a body on this server
    registerLandingNetState(this.netState); // landing/<bodyId> — a body that just arrived; brains leave it alone
    registerNoticeNetState(this.netState); // notice/<bodyId> — how far brains notice a body (a game's stealth)
    registerSanctuariesNetState(this.netState); // sanctuaries/list — no player-on-player damage inside (serve.ts publishes it)
    this.netState.define("name", z.string().max(64).describe("Display name of a player body (name/<bodyId>), written by the server on spawn — what a party frame or a nameplate shows."));
    this.scripts = new ScriptRuntime({
      doc: { ...base, entities: {} },
      objects: new Map(),
      sim: this.sim,
      registry: this.scriptRegistry,
      input: NULL_INPUT,
      events: this.eventBus,
      netState: this.netState,
      // ctx.getDataAsset: the character sheet's item catalog, its progression and creation rules live here —
      // without it every sheet on the server knew no items and ignored every build
      ...(opts.assets ? { assets: opts.assets } : {}),
      biomeAt: serverBiomeAt(base),
      setAnimation: (id, clip) => {
        this.anims.set(id, clip);
      },
      setAnimationLayer: (id, clip) => {
        this.animLayers.set(id, clip);
      },
      clearAnimationLayer: (id) => {
        this.animLayers.delete(id);
      },
      animationClips: () => [],
      // no mixer here, but the rate a script asks for still replicates: it is
      // the only thing that keeps an NPC's feet planted on the clients
      setAnimationSpeed: (id, multiplier) => {
        this.animRates.set(id, multiplier);
      },
      setBillboard: () => undefined,
      setParticles: () => undefined,
      setLight: () => undefined,
      playSound: () => undefined,
      ...(opts.profiler ? { profiler: opts.profiler } : {}),
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
    const scripts = opts.scripts ?? defaultScripts(events, opts.assets);
    const full = expandScene(opts.doc, opts.assets, registry);
    const expanded: SceneDoc = { ...full, entities: { ...full.entities } };
    if (opts.exclude) {
      const drop = new Set<string>();
      for (const [id, entity] of Object.entries(expanded.entities)) {
        if (opts.exclude(id, entity, full.entities)) drop.add(id);
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
    this.entityVersion++;
    const shown = this.presentationOnly(doc);
    if (shown.size > 0) {
      this.strippedCount += shown.size;
      const entities: SceneDoc["entities"] = {};
      for (const [id, entity] of Object.entries(doc.entities)) if (!shown.has(id)) entities[id] = entity;
      doc = { ...doc, entities };
    }
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
    // world matrices for THIS batch only, from parents already current (a whole-scene pass here cost a
    // terrain cell ~3 ms of walking thousands of objects that did not change)
    for (const object of objects.values()) {
      if (!object.parent || !objects.has(object.parent.name)) object.updateMatrixWorld(true);
    }
    // (with streamStatics, the sim builds the statics around any body added here itself)
    if (opts.simulate !== false) this.sim.addEntities(doc);
    // scripts: strip the client-only ones so the runtime never instantiates them
    const forScripts: SceneDoc = { ...doc, entities: {} };
    const liveRoots = new Set<string>();
    const touchedRoots = new Set<string>();
    for (const [id, entity] of Object.entries(doc.entities)) {
      const script = entity.components["script"] as { name?: string } | undefined;
      const serverScript = !!script?.name && !isClientOnlyScript(this.scriptRegistry, script.name);
      if (script?.name && !serverScript) {
        const { script: _dropped, ...rest } = entity.components;
        forScripts.entities[id] = { ...entity, components: rest };
      } else {
        forScripts.entities[id] = entity;
      }
      const root = this.rootOf(id);
      touchedRoots.add(root);
      if (serverScript || entity.components["netObject"] !== undefined || movingBody(entity)) liveRoots.add(root);
    }
    this.classifyMatrices(touchedRoots, liveRoots, objects);
    this.scripts.addEntities(forScripts, objects, { silent: opts.silent ?? false });
  }

  /** Entities left out of this world because they only draw (see {@link presentationOnly}); diagnostics. */
  strippedCount = 0;

  /**
   * The entities of a batch that exist only to be SEEN — every component a drawing one (a mesh, particles, an
   * animator, a light, a decal …), any script client-only, no tags, and every child in the batch the same — so
   * the server does not build them: no objects, no matrices each step, no scripts. A player body is 61 entities
   * of which ~45 are weapons on bones, worn looks and weather emitters. Clients still receive the whole doc
   * (players and spawned NPCs send their own client docs). A mesh with a collider, anything tagged, anything
   * with a server script stays.
   */
  private presentationOnly(doc: SceneDoc): Set<string> {
    const children = new Map<string, string[]>();
    for (const [id, entity] of Object.entries(doc.entities)) {
      if (entity.parent === null) continue;
      const list = children.get(entity.parent);
      if (list) list.push(id);
      else children.set(entity.parent, [id]);
    }
    const out = new Set<string>();
    const visit = (id: string): boolean => {
      const entity = doc.entities[id]!;
      let all = true;
      for (const child of children.get(id) ?? []) if (!visit(child)) all = false;
      if (!all || entity.tags.length > 0) return false;
      for (const key of Object.keys(entity.components)) {
        if (DRAWING_COMPONENTS.has(key)) continue;
        if (key === "script") {
          const name = (entity.components["script"] as { name?: string } | undefined)?.name;
          if (name && isClientOnlyScript(this.scriptRegistry, name)) continue;
        }
        return false;
      }
      out.add(id);
      return true;
    };
    for (const [id, entity] of Object.entries(doc.entities)) {
      // roots of the batch: entities whose parent is not in it (a body's own children are visited from it)
      if (entity.parent === null || !doc.entities[entity.parent]) visit(id);
    }
    if (out.size === 0) return out;
    // a script that stays and names one of them by id (a param) gets it, and its ancestors, after all
    for (const [id, entity] of Object.entries(doc.entities)) {
      if (out.has(id)) continue;
      const params = (entity.components["script"] as { params?: unknown } | undefined)?.params;
      if (!params) continue;
      JSON.stringify(params, (_k, v: unknown) => {
        for (let named = typeof v === "string" && out.has(v) ? v : null; named !== null && out.delete(named); ) {
          const parent: string | null = doc.entities[named]?.parent ?? null;
          named = parent !== null && out.has(parent) ? parent : null;
        }
        return v;
      });
    }
    return out;
  }

  /**
   * Root subtrees nothing can move — no server script, no dynamic/kinematic body, no `netObject` anywhere in
   * them (terrain cells, props, buildings: almost every object of a streamed world) — keep the matrices they
   * were built with: `matrixAutoUpdate` off, so the per-step `updateMatrixWorld(false)` passes skip their
   * compose and multiply. A subtree that gains something live later is switched back on whole. A script that
   * moves an object in a static subtree it does not belong to must call `world.markLive(id)` first.
   */
  private readonly staticRoots = new Set<string>();

  private classifyMatrices(touched: Set<string>, live: Set<string>, added: Map<string, THREE.Object3D>): void {
    for (const root of touched) {
      if (live.has(root)) {
        if (this.staticRoots.delete(root)) this.objects.get(root)?.traverse((o) => (o.matrixAutoUpdate = true));
        continue;
      }
      const rootObject = this.objects.get(root);
      if (!rootObject) continue;
      if (added.has(root)) this.staticRoots.add(root);
      if (!this.staticRoots.has(root)) continue; // a static entity under a live root moves with it
      for (const [id, object] of added) if (this.rootOf(id) === root) object.matrixAutoUpdate = false;
    }
  }

  /** Make an entity's root subtree follow per-step matrix updates again (see {@link classifyMatrices}). */
  markLive(id: string): void {
    const root = this.rootOf(id);
    if (this.staticRoots.delete(root)) this.objects.get(root)?.traverse((o) => (o.matrixAutoUpdate = true));
  }

  /** Stop updating a root subtree's matrices until {@link markLive} (a paused body: nothing moves it). */
  freeze(id: string): void {
    const root = this.rootOf(id);
    const object = this.objects.get(root);
    if (!object || this.staticRoots.has(root)) return;
    object.updateMatrixWorld(true);
    object.traverse((o) => (o.matrixAutoUpdate = false));
    this.staticRoots.add(root);
  }

  /** Root subtrees frozen as static vs updated every step, and how many objects the per-step passes walk (diagnostics). */
  matrixStats(): { staticRoots: number; liveRoots: number; liveObjects: number; liveByScript: Record<string, number> } {
    let liveRoots = 0;
    let liveObjects = 0;
    const liveByScript: Record<string, number> = {};
    for (const root of this.scene.children) {
      if (this.staticRoots.has(root.name)) continue;
      liveRoots++;
      root.traverse((o) => {
        liveObjects++;
        const script = (this.entities.get(o.name)?.components["script"] as { name?: string } | undefined)?.name;
        if (script) liveByScript[script] = (liveByScript[script] ?? 0) + 1;
      });
    }
    return { staticRoots: this.staticRoots.size, liveRoots, liveObjects, liveByScript };
  }

  private rootOf(id: string): string {
    let root = id;
    for (let guard = 0; guard < 256; guard++) {
      const parent = this.entities.get(root)?.parent;
      if (!parent || !this.entities.has(parent)) return root;
      root = parent;
    }
    return root;
  }

  /** Remove entities (and nothing else — pass descendants explicitly, see {@link subtree}). */
  removeEntities(ids: Iterable<string>, opts: { silent?: boolean } = {}): void {
    const list = [...ids];
    if (list.length === 0) return;
    this.entityVersion++;
    this.sim.removeEntities(list);
    this.scripts.removeEntities(list, { silent: opts.silent ?? false });
    for (const id of list) {
      const object = this.objects.get(id);
      object?.parent?.remove(object);
      this.staticRoots.delete(id);
      this.objects.delete(id);
      this.entities.delete(id);
      this.anims.delete(id);
      this.animRates.delete(id);
      this.animLayers.delete(id);
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
   * One fixed step: drivers → physics → body readback → after-physics hooks → scripts (which drain
   * the event bus) → after-hooks. Identical order to the playground's loop.
   */
  step(): void {
    if (this.disposed) return;
    const dt = this.fixedDt;
    const profiler = this.profiler?.enabled ? this.profiler : undefined;
    profiler?.begin("physics");
    profiler?.begin("drivers");
    for (const hook of this.beforeStep) hook(dt);
    profiler?.end();
    profiler?.begin("step");
    this.sim.step(dt);
    profiler?.end();
    profiler?.begin("readback");
    for (const [id, state] of this.sim.states()) {
      const object = this.objects.get(id);
      if (object) applyBodyState(object, state);
    }
    for (const hook of this.afterPhysics) hook(dt);
    profiler?.end();
    profiler?.begin("matrices");
    this.updateLiveMatrices();
    profiler?.end();
    profiler?.end();
    profiler?.begin("scripts");
    this.scripts.fixedUpdate(dt);
    profiler?.end();
    // No second matrix pass after the scripts: what they moved (a yaw, a teleport) is read next through
    // positionOf/getWorldPosition, which update the object's own chain, or by the next step's pass above —
    // which runs before any script reads again. It was half the per-step matrix cost.
    this._tick += 1;
    for (const hook of this.afterStep) hook(dt);
  }

  /**
   * World matrices of every root subtree that can move; static ones (see {@link classifyMatrices}) are not
   * even walked — a streamed world is thousands of them, and walking them alone cost ~1 ms a pass.
   */
  updateLiveMatrices(): void {
    const roots = this.scene.children;
    for (let i = 0; i < roots.length; i++) {
      const root = roots[i]!;
      if (!this.staticRoots.has(root.name)) updateChanged(root, false);
    }
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

/** Components that only draw or sound: an entity made of nothing else (and client-only scripts) is not built here. */
const DRAWING_COMPONENTS = new Set(["transform", "mesh", "particles", "animator", "audio", "billboard", "clothSway", "decal", "grass", "light", "vfx", "visibility", "culling", "camera", "postfx", "sky"]);

/** The position/quaternion/scale an object's matrix was last composed from (updateChanged). */
const COMPOSED = Symbol("composed");
type Composed = THREE.Object3D & { [COMPOSED]?: Float64Array };

/**
 * three's `updateMatrixWorld`, minus the work that changes nothing: an object's local matrix is recomposed
 * only when its position, quaternion or scale differ from what it was last composed from, and its world
 * matrix is recomputed only when it or an ancestor changed (or three flagged it). The same matrices as the
 * full pass — a town resident's twenty props and looks, a player's dozen children, stand still relative to
 * their root, and recomposing them every step was most of the per-step matrix cost.
 */
export function updateChanged(object: THREE.Object3D, parentChanged: boolean): void {
  const o = object as Composed;
  let changed = parentChanged;
  if (o.matrixAutoUpdate) {
    const p = o.position;
    const q = o.quaternion;
    const s = o.scale;
    let c = o[COMPOSED];
    if (!c || c[0] !== p.x || c[1] !== p.y || c[2] !== p.z || c[3] !== q.x || c[4] !== q.y || c[5] !== q.z || c[6] !== q.w || c[7] !== s.x || c[8] !== s.y || c[9] !== s.z) {
      o.matrix.compose(p, q, s);
      c ??= o[COMPOSED] = new Float64Array(10);
      c[0] = p.x;
      c[1] = p.y;
      c[2] = p.z;
      c[3] = q.x;
      c[4] = q.y;
      c[5] = q.z;
      c[6] = q.w;
      c[7] = s.x;
      c[8] = s.y;
      c[9] = s.z;
      changed = true;
    }
  }
  if (changed || o.matrixWorldNeedsUpdate) {
    if (o.parent === null) o.matrixWorld.copy(o.matrix);
    else o.matrixWorld.multiplyMatrices(o.parent.matrixWorld, o.matrix);
    o.matrixWorldNeedsUpdate = false;
    changed = true;
  }
  const children = o.children;
  for (let i = 0; i < children.length; i++) updateChanged(children[i]!, changed);
}

/** A body that moves on its own or is moved (dynamic, kinematic). */
function movingBody(entity: EntityDoc): boolean {
  const kind = (entity.components["rigidbody"] as { kind?: string } | undefined)?.kind;
  return kind === "dynamic" || kind === "kinematic";
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
  registerCommsEvents(events); // "chat.message" — the layer routes chat (see chat.ts)
  return events;
}

/** Builtins with their event contracts registered into `events` (so to-authority requests route). */
export function defaultScripts(events?: EventRegistry, assets?: AssetLibrary): ScriptRegistry {
  const scripts = new ScriptRegistry();
  registerBuiltinScripts(scripts, events, assets);
  return scripts;
}

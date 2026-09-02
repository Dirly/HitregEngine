import RAPIER from "@dimforge/rapier3d-compat";
import {
  heightmapMesh,
  polyMeshCollision,
  voxelMesh,
  worldTransforms,
  type HeightmapParams,
  type PolyMeshSource,
  type Quat,
  type VoxelMeshSource,
  type SceneDoc,
  type Vec3,
} from "@hitreg/core";
import { Layers, interactionGroups, queryGroups, type LayerMask } from "./layers.js";
import {
  DEFAULT_CHARACTER,
  compareHits,
  type CharacterMove,
  type CharacterOptions,
  type OverlapOptions,
  type QueryShape,
  type RayHit,
  type RaycastAllOptions,
  type RaycastOptions,
  type ShapeHit,
  type ShapecastOptions,
} from "./queries.js";

interface RigidbodyData {
  kind: "dynamic" | "kinematic" | "static";
  mass: number;
  linearDamping: number;
  angularDamping: number;
  gravityScale: number;
  ccd: boolean;
  lockRotations: boolean;
}

interface ColliderData {
  shape: "box" | "sphere" | "capsule" | "cylinder" | "heightmap" | "trimesh" | "convex";
  size: Vec3;
  offset: Vec3;
  friction: number;
  restitution: number;
  density: number;
  isTrigger: boolean;
  /**
   * Optional authored collision layers. NOT in `colliderSchema` yet, so a
   * validated doc never carries it today (zod strips unknown keys) — it is read
   * here so that the day `packages/core` adds the field, authored layers work
   * with no change in this package. Until then layers come from
   * {@link defaultMembership} plus runtime {@link PhysicsSim.setLayers}.
   */
  layers?: { membership?: LayerMask; collidesWith?: LayerMask };
}

interface MeshComponentData {
  source:
    | ({ kind: "heightmap" } & Partial<HeightmapParams>)
    | VoxelMeshSource
    | { kind: "asset"; assetId: string; node?: string }
    | { kind: "primitive"; shape: string; size?: Vec3 }
    | PolyMeshSource
    | { kind: string };
}

/** Cooked collision geometry: flat xyz triples + triangle indices. */
export interface MeshGeometryData {
  positions: Float32Array;
  indices: Uint32Array;
}

export interface PhysicsSimOptions {
  /**
   * Resolves an asset mesh (GLB model) to collision geometry for trimesh/
   * convex colliders. The sim is headless — geometry lives renderer-side, so
   * the host injects it (@hitreg/render exports extractCollisionGeometry /
   * makeMeshGeometryProvider). A Promise result attaches the collider to the
   * already-created body when it resolves; null falls back to a box.
   */
  meshGeometry?: (
    assetId: string,
    node?: string,
  ) => MeshGeometryData | Promise<MeshGeometryData | null> | null | undefined;
}

interface JointData {
  kind: "fixed" | "hinge" | "slider" | "ball";
  target: string;
  anchorA: Vec3;
  anchorB: Vec3;
  axis: Vec3;
  limits?: { min: number; max: number };
  motor?: { targetVelocity: number; maxForce: number };
  contactsEnabled: boolean;
}

export interface BodyState {
  position: Vec3;
  rotation: Quat;
}

let initialized = false;

/** One-time WASM init. Idempotent; must complete before any PhysicsSim is built. */
export async function initPhysics(): Promise<void> {
  if (initialized) return;
  await RAPIER.init();
  initialized = true;
}

/**
 * A Rapier world built from an EXPANDED scene doc. Runs identically in the
 * browser and headless Node (the netcode server story). The sim never writes
 * back to the document — play-mode state is runtime-only.
 */
export class PhysicsSim {
  private readonly world: RAPIER.World;
  /** Every body by entity id (removal, chunk streaming). */
  private readonly bodies = new Map<string, RAPIER.RigidBody>();
  /** Only bodies that can move (dynamic/kinematic) — statics never report state. */
  private readonly moving = new Map<string, RAPIER.RigidBody>();
  private readonly events = new RAPIER.EventQueue(true);
  private readonly colliderToEntity = new Map<number, string>();
  private pendingCollisions: Array<[string, string]> = [];
  private pendingCollisionEnds: Array<[string, string]> = [];
  /** Entity ids whose collider was created as a sensor (isTrigger). */
  private readonly sensors = new Set<string>();
  private readonly options: PhysicsSimOptions;
  private disposed = false;
  private readonly warned = new Set<string>();

  // ---- scene-query scratch -------------------------------------------------
  // Every one of these exists so a query issued per entity per frame (a ground
  // probe on 60 actors, an AI line-of-sight sweep, a camera boom) allocates
  // NOTHING on the way in. Rapier's JS bindings copy these across the wasm
  // boundary immediately, so mutating and reusing them is safe; the only rule
  // is that a query may not be issued from inside another query's callback.
  private readonly qRay = new RAPIER.Ray({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 1 });
  private readonly qPos = { x: 0, y: 0, z: 0 };
  private readonly qVel = { x: 0, y: 0, z: 0 };
  private readonly qRot = { x: 0, y: 0, z: 0, w: 1 };
  private readonly qBall = new RAPIER.Ball(0.5);
  private readonly qCapsule = new RAPIER.Capsule(0.5, 0.5);
  private readonly qCuboid = new RAPIER.Cuboid(0.5, 0.5, 0.5);
  /** Collider handles the in-flight query must ignore (multi-entity exclude). */
  private readonly excluded = new Set<number>();
  /** Single-body exclude fast path — Rapier drops it inside its own broad phase. */
  private excludeBody: RAPIER.RigidBody | undefined;
  // bound once: a fresh closure per query would defeat the point of the rest
  private readonly excludeFilter = (c: RAPIER.Collider): boolean => !this.excluded.has(c.handle);
  private readonly rayCollect = (hit: RAPIER.RayColliderIntersection): boolean => {
    const id = this.colliderToEntity.get(hit.collider.handle);
    if (id !== undefined) {
      const t = hit.timeOfImpact;
      const o = this.qRay.origin;
      const d = this.qRay.dir;
      // multi-hit results DO allocate one object per hit, deliberately: pooling
      // them would hand the caller references this sim overwrites on its next
      // query, and "the array I saved last frame silently changed" is a far
      // worse bug than a short-lived object. The ARRAY is poolable (opts.out).
      this.rayAccum.push({
        entityId: id,
        point: [o.x + d.x * t, o.y + d.y * t, o.z + d.z * t],
        normal: [hit.normal.x, hit.normal.y, hit.normal.z],
        distance: t,
      });
    }
    return true; // keep going — raycastAll wants every hit, not the first
  };
  private readonly overlapCollect = (collider: RAPIER.Collider): boolean => {
    const id = this.colliderToEntity.get(collider.handle);
    if (id !== undefined) this.overlapAccum.push(id);
    return true;
  };
  private rayAccum: RayHit[] = [];
  private overlapAccum: string[] = [];
  private readonly characters = new Map<string, CharacterEntry>();
  private charCollision: RAPIER.CharacterCollision | null = null;
  /** Colliders have changed since the last step — see {@link syncQueries}. */
  private queriesDirty = true;

  constructor(doc: SceneDoc, gravity: Vec3 = [0, -9.81, 0], options: PhysicsSimOptions = {}) {
    if (!initialized) {
      throw new Error("call initPhysics() before constructing a PhysicsSim");
    }
    this.options = options;
    this.world = new RAPIER.World({ x: gravity[0], y: gravity[1], z: gravity[2] });
    this.addEntities(doc);
  }

  /**
   * Build bodies/colliders/joints for a doc's entities into the live world.
   * The constructor path and runtime injection (chunk streaming) share this;
   * ids must be unique across the whole sim.
   */
  addEntities(doc: SceneDoc): void {
    const transforms = worldTransforms(doc);
    const bodies = this.bodies;

    // pass 1: bodies + colliders
    for (const [id, entity] of Object.entries(doc.entities)) {
      const rb = entity.components["rigidbody"] as RigidbodyData | undefined;
      const col = entity.components["collider"] as ColliderData | undefined;
      if (!rb && !col) continue;

      const world = transforms.get(id)!;
      const kind = rb?.kind ?? "static";
      const bodyDesc =
        kind === "dynamic"
          ? RAPIER.RigidBodyDesc.dynamic()
          : kind === "kinematic"
            ? RAPIER.RigidBodyDesc.kinematicPositionBased()
            : RAPIER.RigidBodyDesc.fixed();
      bodyDesc
        .setTranslation(...world.position)
        .setRotation({
          x: world.rotation[0],
          y: world.rotation[1],
          z: world.rotation[2],
          w: world.rotation[3],
        });
      if (rb) {
        bodyDesc
          .setLinearDamping(rb.linearDamping)
          .setAngularDamping(rb.angularDamping)
          .setGravityScale(rb.gravityScale)
          .setCcdEnabled(rb.ccd);
        if (rb.mass > 0) bodyDesc.setAdditionalMass(rb.mass);
        if (rb.lockRotations) bodyDesc.lockRotations();
      }
      const body = this.world.createRigidBody(bodyDesc);
      bodies.set(id, body);
      if (kind !== "static") this.moving.set(id, body);

      if (col) {
        // file-authored scenes may omit fields the zod schema would default —
        // never trust a component doc to be fully populated
        const size = col.size ?? [1, 1, 1];
        const offset = col.offset ?? [0, 0, 0];
        const sx = Math.abs(world.scale[0]);
        const sy = Math.abs(world.scale[1]);
        const sz = Math.abs(world.scale[2]);
        const [w, h, d] = [size[0] * sx, size[1] * sy, size[2] * sz];
        const scaledOffset: Vec3 = [offset[0] * sx, offset[1] * sy, offset[2] * sz];
        const boxFallback = (): RAPIER.ColliderDesc =>
          RAPIER.ColliderDesc.cuboid(w / 2, h / 2, d / 2);
        // null = skipped, or deferred (async geometry attaches to the body later)
        let shape: RAPIER.ColliderDesc | null;
        switch (col.shape) {
          case "heightmap": {
            // cook a static trimesh from the SAME grid the renderer draws
            // (core/terrain.ts) — visual ground and physical ground can't drift
            const mesh = entity.components["mesh"] as MeshComponentData | undefined;
            if (mesh?.source.kind !== "heightmap") {
              console.warn(`[physics] ${id}: heightmap collider needs a heightmap mesh component`);
              continue;
            }
            const grid = heightmapMesh(mesh.source as unknown as HeightmapParams);
            shape = RAPIER.ColliderDesc.trimesh(grid.positions, grid.indices);
            break;
          }
          case "trimesh":
          case "convex":
            shape = this.meshColliderDesc(
              id,
              entity.components,
              col.shape,
              [sx, sy, sz],
              body,
              col,
              scaledOffset,
              boxFallback,
            );
            break;
          case "sphere":
            shape = RAPIER.ColliderDesc.ball(w / 2);
            break;
          case "capsule":
            shape = RAPIER.ColliderDesc.capsule(Math.max(0, h - w) / 2, w / 2);
            break;
          case "cylinder":
            shape = RAPIER.ColliderDesc.cylinder(h / 2, w / 2);
            break;
          case "box":
          default:
            shape = boxFallback();
        }
        if (!shape) continue;
        this.finishCollider(shape, body, col, scaledOffset, id);
      }
    }

    // pass 2: joints
    for (const [id, entity] of Object.entries(doc.entities)) {
      const joint = entity.components["joint"] as JointData | undefined;
      if (!joint) continue;
      const bodyA = bodies.get(id);
      const bodyB = bodies.get(joint.target);
      if (!bodyA || !bodyB) {
        console.warn(`[physics] joint on ${id}: missing body (target ${joint.target})`);
        continue;
      }
      const a = { x: joint.anchorA[0], y: joint.anchorA[1], z: joint.anchorA[2] };
      const b = { x: joint.anchorB[0], y: joint.anchorB[1], z: joint.anchorB[2] };
      const axis = { x: joint.axis[0], y: joint.axis[1], z: joint.axis[2] };

      let data: RAPIER.JointData;
      switch (joint.kind) {
        case "fixed":
          data = RAPIER.JointData.fixed(a, { x: 0, y: 0, z: 0, w: 1 }, b, { x: 0, y: 0, z: 0, w: 1 });
          break;
        case "hinge":
          data = RAPIER.JointData.revolute(a, b, axis);
          break;
        case "slider":
          data = RAPIER.JointData.prismatic(a, b, axis);
          break;
        case "ball":
          data = RAPIER.JointData.spherical(a, b);
          break;
      }
      if (joint.limits && (joint.kind === "hinge" || joint.kind === "slider")) {
        data.limitsEnabled = true;
        data.limits = [joint.limits.min, joint.limits.max];
      }
      const created = this.world.createImpulseJoint(data, bodyA, bodyB, true);
      created.setContactsEnabled(joint.contactsEnabled ?? false);
      if (joint.motor && (joint.kind === "hinge" || joint.kind === "slider")) {
        (created as RAPIER.RevoluteImpulseJoint).configureMotorVelocity(
          joint.motor.targetVelocity,
          joint.motor.maxForce,
        );
      }
    }
  }

  /** Remove entities (and their colliders/joints) from the live world. */
  removeEntities(ids: Iterable<string>): void {
    for (const id of ids) {
      const body = this.bodies.get(id);
      if (!body) continue;
      for (let i = 0; i < body.numColliders(); i++) {
        this.colliderToEntity.delete(body.collider(i).handle);
      }
      this.world.removeRigidBody(body); // attached colliders/joints go with it
      this.bodies.delete(id);
      this.moving.delete(id);
      this.sensors.delete(id);
      this.queriesDirty = true;
      // a controller outlives its body otherwise — chunk streaming unloads and
      // reloads the same entity id, and a stale controller holds wasm memory
      this.removeCharacter(id);
    }
  }

  /** Apply the shared collider settings and register it on the body. */
  private finishCollider(
    shape: RAPIER.ColliderDesc,
    body: RAPIER.RigidBody,
    col: ColliderData,
    scaledOffset: Vec3,
    id: string,
  ): void {
    shape
      .setTranslation(scaledOffset[0], scaledOffset[1], scaledOffset[2])
      .setFriction(col.friction ?? 0.5)
      .setRestitution(col.restitution ?? 0)
      .setDensity(col.density ?? 1)
      .setSensor(col.isTrigger ?? false)
      .setActiveEvents(RAPIER.ActiveEvents.COLLISION_EVENTS);
    // Layers. The FILTER half defaults to ALL, which is why turning layers on
    // changed no existing scene's behaviour: a collider that accepts every
    // layer collides with exactly what it collided with before. Membership is
    // what queries select on, so it is the half worth inferring well.
    shape.setCollisionGroups(
      interactionGroups(
        col.layers?.membership ?? defaultMembership(body, col),
        col.layers?.collidesWith ?? Layers.ALL,
      ),
    );
    const created = this.world.createCollider(shape, body);
    this.colliderToEntity.set(created.handle, id);
    this.queriesDirty = true;
    if (col.isTrigger ?? false) this.sensors.add(id);
  }

  /**
   * trimesh/convex colliders cook from the SAME entity's mesh component.
   * Heightmap and box primitives cook synchronously from analytic geometry;
   * asset meshes go through the injected meshGeometry provider (sync data,
   * a Promise, or absent). Returns null when the collider is deferred — an
   * async provider attaches it to the already-created body on resolve.
   */
  private meshColliderDesc(
    id: string,
    components: Record<string, unknown>,
    kind: "trimesh" | "convex",
    scale: Vec3,
    body: RAPIER.RigidBody,
    col: ColliderData,
    scaledOffset: Vec3,
    boxFallback: () => RAPIER.ColliderDesc,
  ): RAPIER.ColliderDesc | null {
    const source = (components["mesh"] as MeshComponentData | undefined)?.source;

    if (source?.kind === "heightmap") {
      const grid = heightmapMesh(source as unknown as HeightmapParams);
      return (
        this.cookShape(id, kind, scaleVertices(grid.positions, scale), grid.indices) ??
        boxFallback()
      );
    }

    if (source?.kind === "voxel") {
      // the SAME cached cell the renderer drew (core/voxel/mesh.ts), so the
      // collider IS the visible surface rather than an approximation of it —
      // and because the cell is cached, cooking costs no extra meshing work.
      // A cell with no surface (pure sky or solid interior) yields nothing to
      // collide with, which is not a failure: falling back to a box here would
      // drop an invisible cube in the middle of the world.
      const mesh = voxelMesh(source as unknown as VoxelMeshSource);
      if (mesh.triangleCount === 0) return null;
      return (
        this.cookShape(id, kind, scaleVertices(mesh.positions, scale), mesh.indices) ??
        boxFallback()
      );
    }

    if (source?.kind === "asset") {
      const asset = source as { kind: "asset"; assetId: string; node?: string };
      const provider = this.options.meshGeometry;
      const result = provider ? provider(asset.assetId, asset.node) : undefined;
      if (!result) {
        this.warnOnce(
          id,
          provider
            ? `no collision geometry for asset "${asset.assetId}" — using box`
            : `${kind} collider on an asset mesh needs a meshGeometry provider — using box`,
        );
        return boxFallback();
      }
      if (result instanceof Promise) {
        // the body exists now; the collider joins it once geometry arrives
        result
          .then((data) => {
            if (this.disposed || this.bodies.get(id) !== body) return; // freed or unloaded
            if (!data) {
              this.warnOnce(id, `no collision geometry for asset "${asset.assetId}" — using box`);
            }
            const desc =
              (data &&
                this.cookShape(id, kind, scaleVertices(data.positions, scale), data.indices)) ||
              boxFallback();
            this.finishCollider(desc, body, col, scaledOffset, id);
          })
          .catch((error) => console.warn(`[physics] ${id}: collision geometry failed`, error));
        return null;
      }
      return (
        this.cookShape(id, kind, scaleVertices(result.positions, scale), result.indices) ??
        boxFallback()
      );
    }

    if (source?.kind === "poly") {
      // editable meshes cook from the SAME faces the renderer triangulates
      const geom = polyMeshCollision(source as PolyMeshSource);
      return (
        this.cookShape(id, kind, scaleVertices(geom.positions, scale), geom.indices) ?? boxFallback()
      );
    }

    if (source?.kind === "primitive") {
      const prim = source as { kind: "primitive"; shape: string; size?: Vec3 };
      if (prim.shape === "box") {
        const geom = boxMeshGeometry(prim.size ?? [1, 1, 1], scale);
        return this.cookShape(id, kind, geom.positions, geom.indices) ?? boxFallback();
      }
      // curved primitives already have exact analytic colliders — a cooked
      // mesh would only be worse; point authors at those instead
      this.warnOnce(id, `${kind} collider not cooked for primitive "${prim.shape}" — using box`);
      return boxFallback();
    }

    this.warnOnce(id, `${kind} collider needs a mesh component — using box`);
    return boxFallback();
  }

  private cookShape(
    id: string,
    kind: "trimesh" | "convex",
    positions: Float32Array,
    indices: Uint32Array,
  ): RAPIER.ColliderDesc | null {
    if (kind === "trimesh") return RAPIER.ColliderDesc.trimesh(positions, indices);
    const hull = RAPIER.ColliderDesc.convexHull(positions);
    if (!hull) this.warnOnce(id, "convex hull cooking failed — using box");
    return hull;
  }

  private warnOnce(id: string, message: string): void {
    const key = `${id}:${message}`;
    if (this.warned.has(key)) return;
    this.warned.add(key);
    console.warn(`[physics] ${id}: ${message}`);
  }

  step(dt: number): void {
    this.world.timestep = dt;
    this.world.step(this.events);
    this.drainEvents();
    this.queriesDirty = false;
  }

  private drainEvents(): void {
    this.events.drainCollisionEvents((h1, h2, started) => {
      const a = this.colliderToEntity.get(h1);
      const b = this.colliderToEntity.get(h2);
      if (!a || !b) return;
      if (started) this.pendingCollisions.push([a, b]);
      else this.pendingCollisionEnds.push([a, b]);
    });
  }

  /**
   * Make colliders created since the last step visible to scene queries.
   *
   * Rapier 0.19 refreshes its query acceleration structure ONLY inside
   * `step()`. A collider created after the last step is invisible to every
   * ray, sweep and overlap — so a freshly streamed chunk is not there yet, and
   * a query issued before the world's very first step finds an empty universe
   * and cheerfully returns null. That failure is silent and reads exactly like
   * "the raycast is broken", which is why this is handled here instead of
   * documented as a caller's problem.
   *
   * The refresh is a zero-timestep step: verified to integrate nothing (no
   * body moves, no velocity changes) while still rebuilding the broad phase.
   * Collision events it produces are drained into the same pending lists a
   * real step feeds, so a body spawned already inside a trigger still reports
   * its `trigger.enter`.
   *
   * The one side effect a zero-dt step DOES have is consuming a kinematic
   * body's pending `setNextKinematicTranslation` — it applies immediately and
   * the body then reaches the real step with no motion left to describe, which
   * is the jitter bug documented on {@link setKinematicTarget}. That is why
   * `setKinematicTarget` and `moveCharacter` flush this first: after either of
   * them the world is clean, so a later lazy sync can never fire while a
   * kinematic target is outstanding.
   */
  private syncQueries(): void {
    if (!this.queriesDirty) return;
    this.queriesDirty = false;
    const dt = this.world.timestep;
    this.world.timestep = 0;
    this.world.step(this.events);
    this.world.timestep = dt;
    this.drainEvents();
  }

  /** Collision-started pairs since the last call (entity ids, expanded scene). */
  takeCollisions(): Array<[string, string]> {
    const out = this.pendingCollisions;
    this.pendingCollisions = [];
    return out;
  }

  /** Collision-ended pairs since the last call (entity ids, expanded scene). */
  takeCollisionEnds(): Array<[string, string]> {
    const out = this.pendingCollisionEnds;
    this.pendingCollisionEnds = [];
    return out;
  }

  /** Whether the entity's collider was created as a sensor (isTrigger). */
  isTrigger(id: string): boolean {
    return this.sensors.has(id);
  }

  getLinvel(id: string): Vec3 | null {
    const body = this.moving.get(id);
    if (!body) return null;
    const v = body.linvel();
    return [v.x, v.y, v.z];
  }

  setLinvel(id: string, v: Vec3): void {
    this.moving.get(id)?.setLinvel({ x: v[0], y: v[1], z: v[2] }, true);
  }

  applyImpulse(id: string, v: Vec3): void {
    this.moving.get(id)?.applyImpulse({ x: v[0], y: v[1], z: v[2] }, true);
  }

  /** Move a body WITHOUT touching velocities (net soft corrections). */
  setTranslation(id: string, p: Vec3): void {
    this.moving.get(id)?.setTranslation({ x: p[0], y: p[1], z: p[2] }, true);
  }

  /**
   * Drive a KINEMATIC body's position for the next step. Unlike setTranslation
   * (an immediate hard reposition with no notion of "how did it get here"),
   * this is what Rapier uses to estimate the body's velocity for that step —
   * the only way a kinematic body transmits believable motion into anything
   * jointed to it. Calling setTranslation every tick on a kinematic body
   * (e.g. driving a joint anchor from a script) skips that estimate entirely,
   * so attached dynamic bodies see it as discontinuously teleporting instead
   * of moving — the joint solver reacts every tick as if to a fresh
   * dislocation, which reads as violent jitter on anything hanging off it.
   */
  setKinematicTarget(id: string, p: Vec3): void {
    // flush any pending query refresh BEFORE arming the target: a lazy sync
    // fired later would consume it (see syncQueries)
    this.syncQueries();
    this.moving.get(id)?.setNextKinematicTranslation({ x: p[0], y: p[1], z: p[2] });
  }

  /** Teleport a body (respawns): position set, velocities zeroed. */
  setPosition(id: string, p: Vec3): void {
    const body = this.moving.get(id);
    if (!body) return;
    body.setTranslation({ x: p[0], y: p[1], z: p[2] }, true);
    body.setLinvel({ x: 0, y: 0, z: 0 }, true);
    body.setAngvel({ x: 0, y: 0, z: 0 }, true);
  }

  // =========================================================================
  // Collision layers
  // =========================================================================

  /**
   * Retag an entity's colliders at runtime.
   *
   * Needed because the scene document cannot express layers yet, and because
   * the useful distinctions are runtime ones anyway: a body becomes an ACTOR
   * when a character script attaches to it, a dropped weapon moves from ACTOR
   * to PROP, a fired arrow leaves PROJECTILE the moment it sticks in a wall.
   *
   * Cost: O(colliders on the entity). Not a per-frame call — changing groups
   * invalidates the pair cache for that collider in Rapier's broad phase.
   */
  setLayers(id: string, membership: LayerMask, collidesWith: LayerMask = Layers.ALL): void {
    const body = this.bodies.get(id);
    if (!body) return;
    const groups = interactionGroups(membership, collidesWith);
    for (let i = 0; i < body.numColliders(); i++) body.collider(i).setCollisionGroups(groups);
  }

  /** Current layers of an entity's first collider, or null if it has none. */
  layersOf(id: string): { membership: LayerMask; collidesWith: LayerMask } | null {
    const body = this.bodies.get(id);
    if (!body || body.numColliders() === 0) return null;
    const groups = body.collider(0).collisionGroups();
    return { membership: (groups >>> 16) & 0xffff, collidesWith: groups & 0xffff };
  }

  // =========================================================================
  // Scene queries
  //
  // All of these are IMMEDIATE-mode reads of the current world state. They are
  // safe from `fixedUpdate` (that is the point — gameplay queries must run on
  // the authority's fixed step or two peers disagree), and meaningless from a
  // render-rate update, where they sample a world mid-interpolation.
  // =========================================================================

  /**
   * Nearest hit along a ray, or null.
   *
   * Cost: one broad-phase traversal + a narrow-phase ray test per candidate.
   * Cheap enough to run **per entity per frame** — a ground probe on every
   * actor, an AI line-of-sight check per agent per AI tick — PROVIDED the
   * `layers` mask is narrow. `docs/performance-lessons.md` records a profile
   * where unfiltered camera-collision raycasts against full-resolution terrain
   * were 70% of frame time; the mask is what keeps that from happening here.
   * With `opts.out` supplied the call allocates nothing at all.
   *
   * `dir` need not be normalized; `maxDistance` and the returned `distance`
   * are always metres regardless.
   */
  raycast(origin: Vec3, dir: Vec3, maxDistance: number, opts: RaycastOptions = {}): RayHit | null {
    this.syncQueries();
    const len = Math.hypot(dir[0], dir[1], dir[2]);
    if (!(len > 0) || !(maxDistance > 0)) return null;
    const ray = this.qRay;
    ray.origin.x = origin[0];
    ray.origin.y = origin[1];
    ray.origin.z = origin[2];
    ray.dir.x = dir[0] / len;
    ray.dir.y = dir[1] / len;
    ray.dir.z = dir[2] / len;
    const predicate = this.beginFilter(opts.exclude);
    const hit = this.world.castRayAndGetNormal(
      ray,
      maxDistance,
      opts.solid ?? true,
      sensorFlags(opts.includeSensors),
      queryGroups(opts.layers ?? Layers.ALL),
      undefined,
      this.excludeBody,
      predicate,
    );
    if (!hit) return null;
    const id = this.colliderToEntity.get(hit.collider.handle);
    if (id === undefined) return null; // collider not owned by an entity — ignore
    const t = hit.timeOfImpact;
    return writeHit(
      opts.out,
      id,
      ray.origin.x + ray.dir.x * t,
      ray.origin.y + ray.dir.y * t,
      ray.origin.z + ray.dir.z * t,
      hit.normal.x,
      hit.normal.y,
      hit.normal.z,
      t,
    );
  }

  /**
   * Every hit along a ray, nearest first (see {@link compareHits} for why the
   * sort is a multiplayer correctness fix and not cosmetics).
   *
   * An entity with several colliders can appear more than once — that is
   * honest, not a bug: a pierce rule counting "bodies hit" should dedupe on
   * `entityId` itself rather than have this call guess.
   *
   * Cost: strictly more than {@link raycast} — it cannot stop at the first hit,
   * and it allocates one small object per hit. Fine for a piercing arrow;
   * not something to run per entity per frame.
   */
  raycastAll(
    origin: Vec3,
    dir: Vec3,
    maxDistance: number,
    opts: RaycastAllOptions = {},
  ): RayHit[] {
    this.syncQueries();
    const out = opts.out ?? [];
    out.length = 0;
    const len = Math.hypot(dir[0], dir[1], dir[2]);
    if (!(len > 0) || !(maxDistance > 0)) return out;
    const ray = this.qRay;
    ray.origin.x = origin[0];
    ray.origin.y = origin[1];
    ray.origin.z = origin[2];
    ray.dir.x = dir[0] / len;
    ray.dir.y = dir[1] / len;
    ray.dir.z = dir[2] / len;
    const predicate = this.beginFilter(opts.exclude);
    this.rayAccum = out;
    this.world.intersectionsWithRay(
      ray,
      maxDistance,
      opts.solid ?? true,
      this.rayCollect,
      sensorFlags(opts.includeSensors),
      queryGroups(opts.layers ?? Layers.ALL),
      undefined,
      this.excludeBody,
      predicate,
    );
    this.rayAccum = [];
    out.sort(compareHits);
    return out;
  }

  /**
   * Sweep a convex shape from `from` to `to` and report the first thing it
   * touches, or null.
   *
   * **This is the query a weapon arc actually needs.** A greatsword swing is a
   * swept capsule, not a sphere at the hilt: testing a point or a ball at each
   * fixed step leaves gaps a target can stand in (at 60 Hz a 0.12 s light
   * attack gets ~7 steps to cover 120°, i.e. ~17° of unchecked arc per step),
   * and it cannot tell you that the blade clipped a pillar on the way. Sweep
   * the blade's capsule along the segment it covered SINCE THE LAST STEP and
   * both problems go away.
   *
   * Cost: a swept-convex test is several times a raycast — call it once per
   * swing step during an active attack window, not once per frame per entity.
   * Sweeping against `Layers.WORLD` and against actors as two narrow queries is
   * usually cheaper than one wide one, and lets a wall stop the swing.
   */
  shapecast(shape: QueryShape, from: Vec3, to: Vec3, opts: ShapecastOptions = {}): ShapeHit | null {
    this.syncQueries();
    const dx = to[0] - from[0];
    const dy = to[1] - from[1];
    const dz = to[2] - from[2];
    const len = Math.hypot(dx, dy, dz);
    // a zero-length sweep is an overlap test; say so rather than silently
    // returning null and having the caller believe the blade missed
    if (!(len > 0)) return null;
    this.qPos.x = from[0];
    this.qPos.y = from[1];
    this.qPos.z = from[2];
    this.qVel.x = dx / len;
    this.qVel.y = dy / len;
    this.qVel.z = dz / len;
    this.setRotation(opts.rotation);
    const predicate = this.beginFilter(opts.exclude);
    const hit = this.world.castShape(
      this.qPos,
      this.qRot,
      this.qVel,
      this.resolveShape(shape),
      0,
      len,
      opts.stopAtPenetration ?? true,
      sensorFlags(opts.includeSensors),
      queryGroups(opts.layers ?? Layers.ALL),
      undefined,
      this.excludeBody,
      predicate,
    );
    if (!hit) return null;
    const id = this.colliderToEntity.get(hit.collider.handle);
    if (id === undefined) return null;
    // Verified against Rapier 0.19 rather than assumed (packages/physics/test/
    // queries.test.ts pins it): for a WORLD-space cast, `witness1` comes back
    // as the world-space contact point and `normal1` as the world-space normal
    // of the hit collider facing back down the sweep — i.e. the same convention
    // castRayAndGetNormal uses, despite the "local-space" wording in the
    // upstream typings. Reading witness2/normal2 instead gives shape-local
    // values and a hit point that looks plausible but is metres wrong.
    return writeHit(
      opts.out,
      id,
      hit.witness1.x,
      hit.witness1.y,
      hit.witness1.z,
      hit.normal1.x,
      hit.normal1.y,
      hit.normal1.z,
      hit.time_of_impact,
    );
  }

  /** Sphere sweep — {@link shapecast} with a ball. Same cost. */
  spherecast(radius: number, from: Vec3, to: Vec3, opts: ShapecastOptions = {}): ShapeHit | null {
    return this.shapecast({ kind: "ball", radius }, from, to, opts);
  }

  /**
   * Capsule sweep — {@link shapecast} with a vertical capsule. `halfHeight` is
   * the core half-length excluding the caps, so a 1.8 m character is
   * `radius 0.35, halfHeight 0.55`.
   */
  capsulecast(
    radius: number,
    halfHeight: number,
    from: Vec3,
    to: Vec3,
    opts: ShapecastOptions = {},
  ): ShapeHit | null {
    return this.shapecast({ kind: "capsule", halfHeight, radius }, from, to, opts);
  }

  /**
   * Entity ids whose colliders intersect a shape placed at `position`, sorted
   * and deduplicated.
   *
   * For AoE damage, "who is standing on the extraction lift", "what did the
   * explosion reach". Sorted for the same determinism reason the ray results
   * are — an AoE that damages in broad-phase order kills a different enemy
   * first on each peer when the damage is enough to be lethal to some of them.
   *
   * Cost: proportional to how many colliders the shape's AABB overlaps, times
   * a narrow-phase intersection test each. Keep the shape tight and the
   * `layers` mask narrow; a 40 m sphere against `Layers.ALL` in a dense mine
   * touches everything streamed in.
   */
  overlapShape(shape: QueryShape, position: Vec3, opts: OverlapOptions = {}): string[] {
    this.syncQueries();
    const out = opts.out ?? [];
    out.length = 0;
    this.qPos.x = position[0];
    this.qPos.y = position[1];
    this.qPos.z = position[2];
    this.setRotation(opts.rotation);
    const predicate = this.beginFilter(opts.exclude);
    this.overlapAccum = out;
    this.world.intersectionsWithShape(
      this.qPos,
      this.qRot,
      this.resolveShape(shape),
      this.overlapCollect,
      sensorFlags(opts.includeSensors),
      queryGroups(opts.layers ?? Layers.ALL),
      undefined,
      this.excludeBody,
      predicate,
    );
    this.overlapAccum = [];
    out.sort();
    // one entity, several colliders → one answer. Unlike raycastAll (where a
    // second hit on the same body is a distinct fact with its own distance),
    // "is this entity inside the volume" has exactly one truthful answer.
    let write = 0;
    for (let read = 0; read < out.length; read++) {
      if (read === 0 || out[read] !== out[read - 1]) out[write++] = out[read]!;
    }
    out.length = write;
    return out;
  }

  /** Sphere overlap — {@link overlapShape} with a ball. Same cost. */
  overlapSphere(center: Vec3, radius: number, opts: OverlapOptions = {}): string[] {
    return this.overlapShape({ kind: "ball", radius }, center, opts);
  }

  // =========================================================================
  // Kinematic character controller
  // =========================================================================

  /**
   * Create or reconfigure this entity's character controller.
   *
   * A Souls-like does NOT want its player moved by the dynamics solver: a
   * dynamic capsule bounces off stair nosings, accumulates momentum into
   * corners, and is at the mercy of whatever restitution the level author left
   * on a wall. A kinematic controller computes an exact slid/stepped/snapped
   * translation instead, which is why every game with precise ground movement
   * uses one. The body should be `rigidbody.kind: "kinematic"` with a capsule
   * collider; other kinds work but get repositioned hard (see
   * {@link moveCharacter}).
   *
   * Idempotent — calling it again on the same entity retunes the existing
   * controller rather than leaking a second one.
   */
  configureCharacter(id: string, opts: CharacterOptions = {}): void {
    const existing = this.characters.get(id);
    const offset = opts.offset ?? DEFAULT_CHARACTER.offset;
    // Rapier bakes the skin width in at construction, so a changed offset means
    // a new controller; everything else is settable on the live one.
    let ctrl = existing?.ctrl;
    if (!ctrl || existing!.offset !== offset) {
      existing?.ctrl.free();
      ctrl = this.world.createCharacterController(offset);
    }

    const up = opts.up ?? [0, 1, 0];
    const upLen = Math.hypot(up[0], up[1], up[2]) || 1;
    const climb = opts.maxSlopeClimbAngle ?? DEFAULT_CHARACTER.maxSlopeClimbAngle;
    ctrl.setUp({ x: up[0] / upLen, y: up[1] / upLen, z: up[2] / upLen });
    ctrl.setSlideEnabled(opts.slide ?? DEFAULT_CHARACTER.slide);
    ctrl.setMaxSlopeClimbAngle(climb);
    ctrl.setMinSlopeSlideAngle(opts.minSlopeSlideAngle ?? DEFAULT_CHARACTER.minSlopeSlideAngle);

    const autostep = opts.autostep === undefined ? DEFAULT_CHARACTER.autostep : opts.autostep;
    if (autostep) {
      ctrl.enableAutostep(
        autostep.maxHeight,
        autostep.minWidth,
        autostep.includeDynamicBodies ?? false,
      );
    } else {
      ctrl.disableAutostep();
    }

    const snap = opts.snapToGround === undefined ? DEFAULT_CHARACTER.snapToGround : opts.snapToGround;
    if (snap !== null && snap > 0) ctrl.enableSnapToGround(snap);
    else ctrl.disableSnapToGround();

    ctrl.setApplyImpulsesToDynamicBodies(opts.pushDynamicBodies ?? DEFAULT_CHARACTER.pushDynamicBodies);
    if (opts.mass !== undefined) ctrl.setCharacterMass(opts.mass);

    // self is always in the exclude list: `computeColliderMovement` takes no
    // exclude-collider argument (unlike the ray/shape queries), so the only way
    // to keep the character's own capsule out of its obstacle set is the
    // predicate — and a capsule stopped by itself never moves at all.
    const exclude = [id, ...(opts.exclude ?? []).filter((e) => e !== id)];
    this.characters.set(id, {
      ctrl,
      offset,
      exclude,
      layers: opts.layers ?? DEFAULT_CHARACTER.layers,
      climbCos: Math.cos(climb),
      up: [up[0] / upLen, up[1] / upLen, up[2] / upLen],
    });
  }

  /** Whether this entity has a character controller attached. */
  hasCharacter(id: string): boolean {
    return this.characters.has(id);
  }

  /** Drop an entity's controller and free its wasm memory. */
  removeCharacter(id: string): void {
    const entry = this.characters.get(id);
    if (!entry) return;
    entry.ctrl.free();
    this.characters.delete(id);
  }

  /**
   * Move a character by `desired`, sliding along walls, stepping up stairs and
   * snapping to ground, and report what actually happened.
   *
   * The returned `translation` is the APPLIED movement, which is almost never
   * the desired one. Integrate velocity against the applied value: a character
   * that keeps accumulating speed into a wall because it integrated the desired
   * value shoots sideways the instant it clears the corner.
   *
   * Auto-configures with {@link DEFAULT_CHARACTER} on first use so a graybox
   * actor moves sensibly without ceremony.
   *
   * Cost: internally a shape cast plus up to two more for autostep and
   * snap-to-ground. This IS a per-entity-per-frame call — that is what it is
   * for — but it is the most expensive one in this file, so it belongs on
   * characters, not on every crate. Supply `out` to make it allocation-free.
   */
  moveCharacter(id: string, desired: Vec3, out?: CharacterMove): CharacterMove {
    const result = out ?? {
      translation: [0, 0, 0],
      grounded: false,
      hitWall: false,
      hitCeiling: false,
      collisions: [],
    };
    result.translation[0] = 0;
    result.translation[1] = 0;
    result.translation[2] = 0;
    result.grounded = false;
    result.hitWall = false;
    result.hitCeiling = false;
    result.collisions.length = 0;

    // freshly streamed floor must exist before the character is asked to walk
    // on it, and this also guarantees no lazy sync eats the target set below
    this.syncQueries();
    const body = this.bodies.get(id);
    if (!body || body.numColliders() === 0) return result;
    if (!this.characters.has(id)) this.configureCharacter(id);
    const entry = this.characters.get(id)!;

    this.qVel.x = desired[0];
    this.qVel.y = desired[1];
    this.qVel.z = desired[2];
    entry.ctrl.computeColliderMovement(
      body.collider(0),
      this.qVel,
      sensorFlags(false), // a trigger volume must never stop a character
      queryGroups(entry.layers),
      this.beginFilterAll(entry.exclude),
    );

    const mv = entry.ctrl.computedMovement();
    result.translation[0] = mv.x;
    result.translation[1] = mv.y;
    result.translation[2] = mv.z;
    result.grounded = entry.ctrl.computedGrounded();

    const collisions = entry.ctrl.numComputedCollisions();
    if (collisions > 0) {
      const scratch = (this.charCollision ??= new RAPIER.CharacterCollision());
      const [ux, uy, uz] = entry.up;
      // "was I actually stopped?" — the horizontal distance asked for versus
      // the horizontal distance achieved, measured in the plane perpendicular
      // to `up`. This gate exists because Rapier reports a DEPENETRATION
      // contact (toi 0) on any frame the capsule starts flush with or slightly
      // inside a surface, and that contact's normal is a deepest-penetration
      // artifact, not a surface: standing still on flat ground produces
      // normals like (-0.62, 0.48, -0.62), which the slope test below reads as
      // a wall. Classifying on the normal alone therefore reports "hitWall" on
      // every frame a character settles onto the floor — a flag that is true
      // when nothing is in the way is worse than no flag.
      const dh = horizontalLength(desired[0], desired[1], desired[2], ux, uy, uz);
      const ah = horizontalLength(mv.x, mv.y, mv.z, ux, uy, uz);
      const blocked = dh > 1e-6 && ah < dh - 1e-4;
      for (let i = 0; i < collisions; i++) {
        const c = entry.ctrl.computedCollision(i, scratch);
        if (!c) continue;
        if (c.collider) {
          const other = this.colliderToEntity.get(c.collider.handle);
          if (other !== undefined && !result.collisions.includes(other)) {
            result.collisions.push(other);
          }
        }
        // normal1 is the obstacle's outward world normal. Pointing WITH up =
        // floor; against it = ceiling; anything the controller refused to climb
        // is a wall — reusing the real slope limit here rather than a magic
        // 0.7 keeps "hitWall" and "would not climb it" the same statement.
        const d = c.normal1.x * ux + c.normal1.y * uy + c.normal1.z * uz;
        if (d <= -0.5) result.hitCeiling = true;
        else if (blocked && d < entry.climbCos) result.hitWall = true;
      }
      result.collisions.sort(); // deterministic across peers — see compareHits
    }

    const t = body.translation();
    const nx = t.x + mv.x;
    const ny = t.y + mv.y;
    const nz = t.z + mv.z;
    if (body.bodyType() === RAPIER.RigidBodyType.KinematicPositionBased) {
      // the jitter rule from setKinematicTarget applies here too: a kinematic
      // character driven with setTranslation transmits no velocity estimate,
      // so anything jointed to it (a carried artifact, a cloak) convulses
      body.setNextKinematicTranslation({ x: nx, y: ny, z: nz });
    } else {
      body.setTranslation({ x: nx, y: ny, z: nz }, true);
    }
    return result;
  }

  // ---- query plumbing ------------------------------------------------------

  /**
   * Arm the exclusion filter for one query and return the predicate to pass to
   * Rapier (or undefined when the fast path covers it). Must be called once per
   * query, immediately before it.
   */
  private beginFilter(exclude?: readonly string[]): ((c: RAPIER.Collider) => boolean) | undefined {
    this.excludeBody = undefined;
    this.excluded.clear();
    if (!exclude || exclude.length === 0) return undefined;
    if (exclude.length === 1) {
      // one entity — usually "ignore myself", by far the common case. Rapier
      // drops a whole rigid body inside its broad phase, so this costs nothing
      // per candidate, where the predicate below costs a JS call each.
      this.excludeBody = this.bodies.get(exclude[0]!);
      return undefined;
    }
    return this.beginFilterAll(exclude);
  }

  /** Exclusion via predicate only — for queries with no exclude-body argument. */
  private beginFilterAll(
    exclude: readonly string[],
  ): ((c: RAPIER.Collider) => boolean) | undefined {
    this.excludeBody = undefined;
    this.excluded.clear();
    for (const id of exclude) {
      const body = this.bodies.get(id);
      if (!body) continue;
      for (let i = 0; i < body.numColliders(); i++) this.excluded.add(body.collider(i).handle);
    }
    return this.excluded.size > 0 ? this.excludeFilter : undefined;
  }

  /** Pooled Rapier shape for a query descriptor — one instance per shape kind. */
  private resolveShape(shape: QueryShape): RAPIER.Shape {
    switch (shape.kind) {
      case "ball":
        this.qBall.radius = shape.radius;
        return this.qBall;
      case "capsule":
        this.qCapsule.radius = shape.radius;
        this.qCapsule.halfHeight = shape.halfHeight;
        return this.qCapsule;
      case "cuboid":
        this.qCuboid.halfExtents.x = shape.halfExtents[0];
        this.qCuboid.halfExtents.y = shape.halfExtents[1];
        this.qCuboid.halfExtents.z = shape.halfExtents[2];
        return this.qCuboid;
    }
  }

  private setRotation(q: Quat | undefined): void {
    this.qRot.x = q ? q[0] : 0;
    this.qRot.y = q ? q[1] : 0;
    this.qRot.z = q ? q[2] : 0;
    this.qRot.w = q ? q[3] : 1;
  }

  /** World-space states of every moving body, keyed by (expanded) entity id. */
  states(): Map<string, BodyState> {
    const out = new Map<string, BodyState>();
    for (const [id, body] of this.moving) {
      const t = body.translation();
      const r = body.rotation();
      out.set(id, {
        position: [t.x, t.y, t.z],
        rotation: [r.x, r.y, r.z, r.w],
      });
    }
    return out;
  }

  free(): void {
    this.disposed = true;
    // controllers hold their own wasm allocation and are NOT owned by the
    // world — dropping the world alone leaks one per character
    for (const entry of this.characters.values()) entry.ctrl.free();
    this.characters.clear();
    this.world.free();
  }
}

/** Per-entity character-controller state (see PhysicsSim.configureCharacter). */
interface CharacterEntry {
  ctrl: RAPIER.KinematicCharacterController;
  /** Skin width the controller was CONSTRUCTED with — changing it rebuilds it. */
  offset: number;
  exclude: string[];
  layers: LayerMask;
  /** cos(maxSlopeClimbAngle), precomputed for the per-collision wall test. */
  climbCos: number;
  up: Vec3;
}

/**
 * Sensors are excluded from queries unless asked for: a trigger volume is not
 * geometry, and one that blocks a sword swing or an enemy's line of sight is
 * always a bug. Rapier defaults the other way.
 */
function sensorFlags(includeSensors: boolean | undefined): RAPIER.QueryFilterFlags | undefined {
  return includeSensors ? undefined : RAPIER.QueryFilterFlags.EXCLUDE_SENSORS;
}

/** Length of a vector's component perpendicular to `up` (a unit vector). */
function horizontalLength(
  x: number,
  y: number,
  z: number,
  ux: number,
  uy: number,
  uz: number,
): number {
  const along = x * ux + y * uy + z * uz;
  return Math.hypot(x - along * ux, y - along * uy, z - along * uz);
}

/** Fill a caller-supplied hit, or allocate one. Never allocates when `out` is given. */
function writeHit(
  out: RayHit | undefined,
  entityId: string,
  px: number,
  py: number,
  pz: number,
  nx: number,
  ny: number,
  nz: number,
  distance: number,
): RayHit {
  if (!out) {
    return { entityId, point: [px, py, pz], normal: [nx, ny, nz], distance };
  }
  out.entityId = entityId;
  out.point[0] = px;
  out.point[1] = py;
  out.point[2] = pz;
  out.normal[0] = nx;
  out.normal[1] = ny;
  out.normal[2] = nz;
  out.distance = distance;
  return out;
}

/**
 * Layer membership inferred from what the collider IS, since the scene document
 * cannot say yet. Deliberately conservative: everything lands on a layer a
 * query would actually ask for, and nothing is guessed as ACTOR (a body being
 * dynamic says nothing about it being alive — that is a runtime fact, so a
 * character script calls {@link PhysicsSim.setLayers} to claim it).
 */
function defaultMembership(body: RAPIER.RigidBody, col: ColliderData): LayerMask {
  if (col.isTrigger ?? false) return Layers.TRIGGER;
  if (col.shape === "heightmap") return Layers.TERRAIN;
  return body.isFixed() ? Layers.WORLD : Layers.PROP;
}

/**
 * Rapier colliders don't scale with their body — bake the entity's world
 * scale into the vertices before cooking. Provider data may be cached and
 * shared, so never mutate it in place.
 */
function scaleVertices(positions: Float32Array, scale: Vec3): Float32Array {
  const [sx, sy, sz] = scale;
  if (sx === 1 && sy === 1 && sz === 1) return positions;
  const out = new Float32Array(positions.length);
  for (let i = 0; i < positions.length; i += 3) {
    out[i] = positions[i]! * sx;
    out[i + 1] = positions[i + 1]! * sy;
    out[i + 2] = positions[i + 2]! * sz;
  }
  return out;
}

/** Analytic 8-corner/12-triangle mesh for a box primitive (CCW outward). */
function boxMeshGeometry(size: Vec3, scale: Vec3): MeshGeometryData {
  const hx = (size[0] * scale[0]) / 2;
  const hy = (size[1] * scale[1]) / 2;
  const hz = (size[2] * scale[2]) / 2;
  const positions = new Float32Array(24);
  for (let k = 0; k < 8; k++) {
    positions[k * 3] = k & 1 ? hx : -hx;
    positions[k * 3 + 1] = k & 2 ? hy : -hy;
    positions[k * 3 + 2] = k & 4 ? hz : -hz;
  }
  // prettier-ignore
  const indices = new Uint32Array([
    4, 5, 7,  4, 7, 6, // +z
    1, 0, 2,  1, 2, 3, // -z
    5, 1, 3,  5, 3, 7, // +x
    0, 4, 6,  0, 6, 2, // -x
    2, 6, 7,  2, 7, 3, // +y
    0, 1, 5,  0, 5, 4, // -y
  ]);
  return { positions, indices };
}

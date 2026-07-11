import RAPIER from "@dimforge/rapier3d-compat";
import {
  heightmapMesh,
  worldTransforms,
  type HeightmapParams,
  type Quat,
  type SceneDoc,
  type Vec3,
} from "@hitreg/core";

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
}

interface MeshComponentData {
  source:
    | ({ kind: "heightmap" } & Partial<HeightmapParams>)
    | { kind: "asset"; assetId: string; node?: string }
    | { kind: "primitive"; shape: string; size?: Vec3 }
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
    const created = this.world.createCollider(shape, body);
    this.colliderToEntity.set(created.handle, id);
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
    this.events.drainCollisionEvents((h1, h2, started) => {
      const a = this.colliderToEntity.get(h1);
      const b = this.colliderToEntity.get(h2);
      if (!a || !b) return;
      if (started) this.pendingCollisions.push([a, b]);
      else this.pendingCollisionEnds.push([a, b]);
    });
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

  /** Teleport a body (respawns): position set, velocities zeroed. */
  setPosition(id: string, p: Vec3): void {
    const body = this.moving.get(id);
    if (!body) return;
    body.setTranslation({ x: p[0], y: p[1], z: p[2] }, true);
    body.setLinvel({ x: 0, y: 0, z: 0 }, true);
    body.setAngvel({ x: 0, y: 0, z: 0 }, true);
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
    this.world.free();
  }
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

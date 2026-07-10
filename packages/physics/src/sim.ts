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
  shape: "box" | "sphere" | "capsule" | "cylinder" | "heightmap";
  size: Vec3;
  offset: Vec3;
  friction: number;
  restitution: number;
  density: number;
  isTrigger: boolean;
}

interface HeightmapMeshData {
  source: { kind: string } & Partial<HeightmapParams>;
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
  /** Only bodies that can move (dynamic/kinematic) — statics never report state. */
  private readonly moving = new Map<string, RAPIER.RigidBody>();
  private readonly events = new RAPIER.EventQueue(true);
  private readonly colliderToEntity = new Map<number, string>();
  private pendingCollisions: Array<[string, string]> = [];

  constructor(doc: SceneDoc, gravity: Vec3 = [0, -9.81, 0]) {
    if (!initialized) {
      throw new Error("call initPhysics() before constructing a PhysicsSim");
    }
    this.world = new RAPIER.World({ x: gravity[0], y: gravity[1], z: gravity[2] });

    const transforms = worldTransforms(doc);
    const bodies = new Map<string, RAPIER.RigidBody>();

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
        const sx = Math.abs(world.scale[0]);
        const sy = Math.abs(world.scale[1]);
        const [w, h, d] = [col.size[0] * sx, col.size[1] * sy, col.size[2] * Math.abs(world.scale[2])];
        let shape: RAPIER.ColliderDesc;
        switch (col.shape) {
          case "heightmap": {
            // cook a static trimesh from the SAME grid the renderer draws
            // (core/terrain.ts) — visual ground and physical ground can't drift
            const mesh = entity.components["mesh"] as HeightmapMeshData | undefined;
            if (mesh?.source.kind !== "heightmap") {
              console.warn(`[physics] ${id}: heightmap collider needs a heightmap mesh component`);
              continue;
            }
            const grid = heightmapMesh(mesh.source as HeightmapParams);
            shape = RAPIER.ColliderDesc.trimesh(grid.positions, grid.indices);
            break;
          }
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
            shape = RAPIER.ColliderDesc.cuboid(w / 2, h / 2, d / 2);
        }
        shape
          .setTranslation(col.offset[0] * sx, col.offset[1] * sy, col.offset[2] * Math.abs(world.scale[2]))
          .setFriction(col.friction)
          .setRestitution(col.restitution)
          .setDensity(col.density)
          .setSensor(col.isTrigger)
          .setActiveEvents(RAPIER.ActiveEvents.COLLISION_EVENTS);
        const created = this.world.createCollider(shape, body);
        this.colliderToEntity.set(created.handle, id);
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

  step(dt: number): void {
    this.world.timestep = dt;
    this.world.step(this.events);
    this.events.drainCollisionEvents((h1, h2, started) => {
      if (!started) return;
      const a = this.colliderToEntity.get(h1);
      const b = this.colliderToEntity.get(h2);
      if (a && b) this.pendingCollisions.push([a, b]);
    });
  }

  /** Collision-started pairs since the last call (entity ids, expanded scene). */
  takeCollisions(): Array<[string, string]> {
    const out = this.pendingCollisions;
    this.pendingCollisions = [];
    return out;
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
    this.world.free();
  }
}

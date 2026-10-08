import RAPIER from "@dimforge/rapier3d-compat";
import type { Quat, Vec3 } from "@hitreg/core";
import { Layers, interactionGroups, type LayerMask } from "./layers.js";

/**
 * Cosmetic ragdolls: a chain of capsule bodies joined by limited, motored ball
 * joints, simulated in the same Rapier world as everything else so they land
 * on the real ground, but on the DEBRIS layer so nothing else can touch them.
 *
 * What this module does NOT know is skeletons. The plan (which bone gets a
 * body, how big, which joints) is made on the side that has the skeleton
 * (`planRagdoll` in @hitreg/scripting); this side only builds what it is told
 * and reports poses back. The two speak through plain data
 * ({@link RagdollSpec}), restated structurally in scripting's `SimLike` the same
 * way the query types are.
 *
 * ## Why every body starts with the SAME rotation
 *
 * Rapier 0.19's spherical joint ignores the joint frames a descriptor carries
 * (verified: `frame1` comes back as identity), so its angular limits and
 * motors are centred on "both bodies have the same orientation". A body's
 * rotation is therefore not the bone's: every body spawns at identity (or one
 * shared rotation) and the capsule's own orientation lives on the COLLIDER.
 * The relative rotation across every joint is then zero at spawn, which makes
 * the spawn pose — the animated pose at the moment of death — the joint's rest
 * pose: limits are "this far from how it was falling", and the motors pull
 * back toward it (a stiff, heavy fall rather than a noodle).
 *
 * ## Cost model
 *
 * One dynamic body + one capsule per segment and one joint per link. Never
 * any collision with actors. With `selfCollide` the capsules also meet each
 * other (a hand cannot sink through its own chest) and other self-colliding
 * ragdolls (two corpses pile instead of merging); jointed pairs never touch,
 * and pairs that already overlap at spawn (a thigh in the waist capsule) are
 * excluded by a contacts-off joint with no locked axes, so nothing pops apart.
 * Bodies are not in the sim's moving set, so they never show up in
 * `states()` readback, and they are removed outright when the caller freezes
 * the pose — a settled ragdoll costs nothing afterwards.
 *
 * ## Per-axis limits
 *
 * A joint's `limit` may be one angle or [x, y, z] — about the axes of the
 * shared spawn rotation (the module note above), not the bone's. A caller that
 * spawns every body in the creature's own frame (x = its right, y = up,
 * z = its forward) can therefore say "a quadruped's spine bends a little up
 * and sideways but hardly rolls" as [0.25, 0.2, 0.06].
 */

/** Floats per body in {@link RagdollSet.poses}: x y z, qx qy qz qw. */
export const RAGDOLL_POSE_STRIDE = 7;

export interface RagdollBodySpec {
  /** World position of the body's origin (the bone's head). */
  position: Vec3;
  /**
   * World rotation at spawn. Leave it out: every body of one ragdoll must
   * share it (see the module note), and identity is the one everyone agrees on.
   */
  rotation?: Quat;
  /** The capsule, in the body's local frame: along its local Y once `rotation` is applied. */
  collider: { center: Vec3; rotation: Quat; halfHeight: number; radius: number };
  /** Initial velocity (m/s) — the animated motion at the handover plus the killing blow. */
  linvel?: Vec3;
  angvel?: Vec3;
  /** Collider density (default 1); only ratios between bodies matter to the joints. */
  density?: number;
}

export interface RagdollJointSpec {
  parent: number;
  child: number;
  /** World-space joint point at spawn (normally the child's origin). */
  anchor: Vec3;
  /**
   * How far (radians) the child may turn from its spawn pose: one angle for
   * every axis, or [x, y, z] about the axes of the bodies' shared spawn rotation.
   */
  limit: number | Vec3;
}

export interface RagdollSpec {
  bodies: RagdollBodySpec[];
  joints: RagdollJointSpec[];
  /**
   * Joint motor stiffness pulling each joint back to its spawn pose
   * (acceleration-based, so independent of mass). 0 = limp within the limits.
   */
  stiffness?: number;
  /** Joint motor damping. Default: critical-ish, 2·sqrt(stiffness). */
  damping?: number;
  /**
   * Seconds over which the motors fade to nothing (0 = they hold for good):
   * stiff at the blow, slack by the time it lands, so a body can lie still
   * instead of being held off the ground by its own joints.
   */
  relax?: number;
  linearDamping?: number;
  angularDamping?: number;
  friction?: number;
  /**
   * Bodies collide with each other (not across a joint, not where they overlap
   * at spawn) and with other self-colliding ragdolls. Adds DEBRIS to the filter.
   */
  selfCollide?: boolean;
  /**
   * Late damping: from `after` seconds, every body's damping steps up to these
   * over half a second, then keeps growing (x2 per half second, to 6x) — the
   * creep of a tail or a hoof, and the slow roll of a capsule body down a
   * slope, stop, so the pose can freeze instead of running to the caller's cap.
   */
  settle?: { after: number; linearDamping: number; angularDamping: number };
  /**
   * Keep a four-legged body off its back: once the root body's up (the shared
   * spawn rotation's +Y, carried by body 0) has rolled below this world height
   * (-1..1; -0.3 is a little past lying on its side), the whole body is turned
   * back toward that side about the root's own forward (the spawn rotation's
   * +Z), harder the further over it is. Leave out for bipeds: lying on the back
   * is how they land.
   */
  rollGuard?: number;
  /** Default: member of DEBRIS, collides with WORLD | TERRAIN only (plus DEBRIS with selfCollide). */
  layers?: { membership: LayerMask; collidesWith: LayerMask };
}

export interface RagdollStats {
  /** Ragdolls currently simulating. */
  active: number;
  bodies: number;
  joints: number;
  /** Ragdolls ever created / removed by this sim. */
  created: number;
  removed: number;
}

interface Live {
  bodies: RAPIER.RigidBody[];
  joints: RAPIER.ImpulseJoint[];
  /** Motor stiffness/damping at spawn, and the seconds over which they fade out (0 = never). */
  k: number;
  d: number;
  relax: number;
  age: number;
  /** Fraction of the motor strength last written (rewritten in 10% steps, not every tick). */
  written: number;
  /** Late damping target, and how far toward it the bodies are (0..1, in quarter steps). */
  settle: { after: number; lin0: number; ang0: number; lin: number; ang: number } | null;
  damped: number;
  /** rollGuard threshold, and the spawn rotation's inverse (root up/forward are spawn +Y/+Z). */
  guard: number | null;
  frameInv: Quat;
}

const ANG_AXES = [3, 4, 5]; // RawJointAxis.AngX/Y/Z
/** Late damping keeps growing to this multiple of RagdollSpec.settle (see tick). */
const SETTLE_MAX = 6;

export class RagdollSet {
  private readonly live = new Map<number, Live>();
  private serial = 0;
  private created = 0;
  private removed = 0;

  constructor(private readonly world: RAPIER.World) {}

  add(spec: RagdollSpec): number {
    const groups = interactionGroups(
      spec.layers?.membership ?? Layers.DEBRIS,
      spec.layers?.collidesWith ?? (Layers.WORLD | Layers.TERRAIN | (spec.selfCollide ? Layers.DEBRIS : 0)),
    );
    const bodies: RAPIER.RigidBody[] = [];
    for (const b of spec.bodies) {
      const r = b.rotation ?? [0, 0, 0, 1];
      const desc = RAPIER.RigidBodyDesc.dynamic()
        .setTranslation(b.position[0], b.position[1], b.position[2])
        .setRotation({ x: r[0], y: r[1], z: r[2], w: r[3] })
        .setLinearDamping(spec.linearDamping ?? 0.2)
        .setAngularDamping(spec.angularDamping ?? 2);
      if (b.linvel) desc.setLinvel(b.linvel[0], b.linvel[1], b.linvel[2]);
      if (b.angvel) desc.setAngvel({ x: b.angvel[0], y: b.angvel[1], z: b.angvel[2] });
      const body = this.world.createRigidBody(desc);
      const c = b.collider;
      const col = RAPIER.ColliderDesc.capsule(Math.max(0, c.halfHeight), Math.max(0.005, c.radius))
        .setTranslation(c.center[0], c.center[1], c.center[2])
        .setRotation({ x: c.rotation[0], y: c.rotation[1], z: c.rotation[2], w: c.rotation[3] })
        .setDensity(b.density ?? 1)
        .setFriction(spec.friction ?? 0.9)
        .setRestitution(0)
        .setCollisionGroups(groups);
      this.world.createCollider(col, body);
      bodies.push(body);
    }
    const raw = this.world.impulseJoints.raw;
    const k = Math.max(0, spec.stiffness ?? 0);
    const d = spec.damping ?? 2 * Math.sqrt(k);
    const joints: RAPIER.ImpulseJoint[] = [];
    for (const j of spec.joints) {
      const a = bodies[j.parent];
      const b = bodies[j.child];
      if (!a || !b || a === b) continue;
      const pa = a.translation();
      const pb = b.translation();
      // bodies share one rotation at spawn: local = world offset rotated by its inverse
      const qa = a.rotation();
      const la = rotateInv(qa, j.anchor[0] - pa.x, j.anchor[1] - pa.y, j.anchor[2] - pa.z);
      const lb = rotateInv(qa, j.anchor[0] - pb.x, j.anchor[1] - pb.y, j.anchor[2] - pb.z);
      const data = RAPIER.JointData.spherical(la, lb);
      const joint = this.world.createImpulseJoint(data, a, b, true);
      joint.setContactsEnabled(false);
      for (let k = 0; k < 3; k++) {
        const axis = ANG_AXES[k]!;
        const lim = Math.max(0, typeof j.limit === "number" ? j.limit : j.limit[k]!);
        raw.jointSetLimits(joint.handle, axis, -lim, lim);
        if (k > 0) raw.jointConfigureMotorPosition(joint.handle, axis, 0, k, d);
      }
      joints.push(joint);
    }
    if (spec.selfCollide) this.excludeSpawnOverlaps(spec, bodies);
    const handle = ++this.serial;
    const st = spec.settle;
    this.live.set(handle, {
      bodies,
      joints,
      k,
      d,
      relax: Math.max(0, spec.relax ?? 0),
      age: 0,
      written: 1,
      settle: st
        ? { after: Math.max(0, st.after), lin0: spec.linearDamping ?? 0.2, ang0: spec.angularDamping ?? 2, lin: st.linearDamping, ang: st.angularDamping }
        : null,
      damped: 0,
      guard: spec.rollGuard ?? null,
      frameInv: inverse(spec.bodies[0]?.rotation ?? [0, 0, 0, 1]),
    });
    this.created++;
    return handle;
  }

  /**
   * Self-collision exclusions: every unjointed pair whose capsules already
   * overlap at spawn gets a joint with no locked axes and contacts off — the
   * one per-pair contact switch Rapier has without a JS contact hook. Only a
   * handful per ragdoll (thigh/waist, upper arm/neck), and they cost the
   * solver nothing to keep.
   */
  private excludeSpawnOverlaps(spec: RagdollSpec, bodies: RAPIER.RigidBody[]): void {
    const n = spec.bodies.length;
    const jointed = new Set<number>();
    for (const j of spec.joints) jointed.add(Math.min(j.parent, j.child) * n + Math.max(j.parent, j.child));
    const segs = spec.bodies.map((b) => capsuleWorld(b));
    const zero = { x: 0, y: 0, z: 0 };
    for (let a = 0; a < n; a++) {
      for (let b = a + 1; b < n; b++) {
        if (jointed.has(a * n + b)) continue;
        const A = segs[a]!;
        const B = segs[b]!;
        // a small margin: touching at spawn counts, or the first contact pops them apart
        if (segmentDistance(A, B) > A.r + B.r + 0.02) continue;
        const free = this.world.createImpulseJoint(
          RAPIER.JointData.generic(zero, zero, { x: 1, y: 0, z: 0 }, 0 as RAPIER.JointAxesMask),
          bodies[a]!,
          bodies[b]!,
          true,
        );
        free.setContactsEnabled(false);
      }
    }
  }

  /** Advance motor fades and late damping (called once per physics step). */
  tick(dt: number): void {
    if (this.live.size === 0) return;
    const raw = this.world.impulseJoints.raw;
    for (const r of this.live.values()) {
      r.age += dt;
      const s = r.settle;
      if (s && r.damped < SETTLE_MAX && r.age > s.after) {
        // the ramp: in quarter steps up to the settle values over half a second, then
        // x2 every half second up to SETTLE_MAX x them — a capsule body rolls down a
        // grass slope forever at any FIXED damping (it is round), so lying still has
        // to get steadily stickier. Steps, because a damping write per body per tick
        // is wasted wasm calls.
        const since = r.age - s.after;
        const q = since < 0.5 ? Math.floor((since / 0.5) * 4) / 4 : Math.min(SETTLE_MAX, 2 ** Math.floor(since / 0.5 - 1 + 1e-9));
        if (q > r.damped) {
          r.damped = q;
          const lin = q <= 1 ? s.lin0 + (s.lin - s.lin0) * q : s.lin * q;
          const ang = q <= 1 ? s.ang0 + (s.ang - s.ang0) * q : s.ang * q;
          for (const b of r.bodies) {
            b.setLinearDamping(lin);
            b.setAngularDamping(ang);
          }
        }
      }
      if (r.guard !== null) this.guardRoll(r);
      if (r.relax <= 0 || r.k <= 0 || r.written === 0) continue;
      const f = Math.max(0, 1 - r.age / r.relax);
      // rewrite only in 10% steps: a motor reconfigure per joint per tick is wasted wasm calls
      if (r.written - f < 0.1 && f > 0) continue;
      r.written = f;
      const k = r.k * f;
      const d = r.d * Math.sqrt(f);
      for (const j of r.joints) for (const axis of ANG_AXES) raw.jointConfigureMotorPosition(j.handle, axis, 0, k, d);
    }
  }

  /**
   * The roll guard (RagdollSpec.rollGuard): read the root's up; past the
   * threshold, turn the whole body back about its own spine toward the side it
   * came from (a body on its back with four stiff legs in the air is the one
   * pose a dead quadruped never holds). One wasm read per step while it lies
   * on its side or better.
   */
  private guardRoll(r: Live): void {
    const root = r.bodies[0];
    if (!root) return;
    const q = root.rotation();
    const qr: Quat = mul([q.x, q.y, q.z, q.w], r.frameInv);
    const up = rotate(qr, 0, 1, 0);
    if (up[1] >= r.guard!) return;
    const fwd = rotate(qr, 0, 0, 1);
    // d(up.y)/dt for a spin w about fwd = w * (fwd x up).y: a spin with the sign of
    // `lever` turns the back up again
    const lever = fwd[2] * up[0] - fwd[0] * up[2];
    if (Math.abs(lever) < 1e-3) return;
    // the root's roll now, and the roll that would bring it back (faster the further over)
    const w0 = root.angvel();
    const along = w0.x * fwd[0] + w0.y * fwd[1] + w0.z * fwd[2];
    const want = Math.sign(lever) * Math.min(3, 6 * (r.guard! - up[1]));
    if ((want - along) * lever <= 0) return; // already turning back at least that fast
    // ease a quarter of the way there per step, as ONE rigid turn of the whole
    // body about the root (each body's spin AND the swing of its centre), so the
    // joints carry nothing extra
    const dw = (want - along) * 0.25;
    const c = root.translation();
    for (const body of r.bodies) {
      const w = body.angvel();
      body.setAngvel({ x: w.x + fwd[0] * dw, y: w.y + fwd[1] * dw, z: w.z + fwd[2] * dw }, true);
      const t = body.translation();
      const rx = t.x - c.x, ry = t.y - c.y, rz = t.z - c.z;
      const v = body.linvel();
      body.setLinvel({ x: v.x + (fwd[1] * rz - fwd[2] * ry) * dw, y: v.y + (fwd[2] * rx - fwd[0] * rz) * dw, z: v.z + (fwd[0] * ry - fwd[1] * rx) * dw }, true);
    }
  }

  /** Write each body's world pose (stride {@link RAGDOLL_POSE_STRIDE}); returns the body count, 0 if gone. */
  poses(handle: number, out: Float32Array | number[]): number {
    const r = this.live.get(handle);
    if (!r) return 0;
    for (let i = 0; i < r.bodies.length; i++) {
      const b = r.bodies[i]!;
      const t = b.translation();
      const q = b.rotation();
      const o = i * RAGDOLL_POSE_STRIDE;
      out[o] = t.x;
      out[o + 1] = t.y;
      out[o + 2] = t.z;
      out[o + 3] = q.x;
      out[o + 4] = q.y;
      out[o + 5] = q.z;
      out[o + 6] = q.w;
    }
    return r.bodies.length;
  }

  /**
   * True when every body is asleep or moving slower than the tolerances
   * (m/s, rad/s). The angular one is loose on purpose: a thin limb rolling a
   * centimetre a second on the ground already spins at ~1 rad/s. The caller
   * decides how long "settled" has to last.
   */
  settled(handle: number, linear = 0.2, angular = 2): boolean {
    const r = this.live.get(handle);
    if (!r) return true;
    const l2 = linear * linear;
    const a2 = angular * angular;
    for (const b of r.bodies) {
      if (b.isSleeping()) continue;
      const v = b.linvel();
      const w = b.angvel();
      if (v.x * v.x + v.y * v.y + v.z * v.z > l2 || w.x * w.x + w.y * w.y + w.z * w.z > a2) return false;
    }
    return true;
  }

  /** Add a velocity change to every body (a late hit on a falling body). */
  kick(handle: number, dv: Vec3): void {
    const r = this.live.get(handle);
    if (!r) return;
    for (const b of r.bodies) {
      const v = b.linvel();
      b.setLinvel({ x: v.x + dv[0], y: v.y + dv[1], z: v.z + dv[2] }, true);
    }
  }

  remove(handle: number): void {
    const r = this.live.get(handle);
    if (!r) return;
    this.live.delete(handle);
    // removing a body takes its colliders and joints with it
    for (const b of r.bodies) this.world.removeRigidBody(b);
    this.removed++;
  }

  has(handle: number): boolean {
    return this.live.has(handle);
  }

  stats(): RagdollStats {
    let bodies = 0;
    let joints = 0;
    for (const r of this.live.values()) {
      bodies += r.bodies.length;
      joints += r.joints.length;
    }
    return { active: this.live.size, bodies, joints, created: this.created, removed: this.removed };
  }
}

/** A capsule as a world segment and a radius. */
export interface CapsuleSegment {
  ax: number;
  ay: number;
  az: number;
  bx: number;
  by: number;
  bz: number;
  r: number;
}

/** A body's capsule as a world segment + radius, at its spawn pose. */
function capsuleWorld(b: RagdollBodySpec): CapsuleSegment {
  const br = b.rotation ?? [0, 0, 0, 1];
  const c = b.collider;
  const center = rotate(br, c.center[0], c.center[1], c.center[2]);
  const local = rotate(c.rotation, 0, c.halfHeight, 0);
  const axis = rotate(br, local[0], local[1], local[2]);
  const cx = b.position[0] + center[0];
  const cy = b.position[1] + center[1];
  const cz = b.position[2] + center[2];
  return { ax: cx - axis[0], ay: cy - axis[1], az: cz - axis[2], bx: cx + axis[0], by: cy + axis[1], bz: cz + axis[2], r: c.radius };
}

function inverse(q: Quat): Quat {
  return [-q[0], -q[1], -q[2], q[3]];
}

function mul(a: Quat, b: Quat): Quat {
  return [
    a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
    a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
    a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
    a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
  ];
}

function rotate(q: Quat, x: number, y: number, z: number): [number, number, number] {
  const [qx, qy, qz, qw] = q;
  const ix = qw * x + qy * z - qz * y;
  const iy = qw * y + qz * x - qx * z;
  const iz = qw * z + qx * y - qy * x;
  const iw = -qx * x - qy * y - qz * z;
  return [ix * qw + iw * -qx + iy * -qz - iz * -qy, iy * qw + iw * -qy + iz * -qx - ix * -qz, iz * qw + iw * -qz + ix * -qy - iy * -qx];
}

/** Closest distance between two segments (Ericson, Real-Time Collision Detection 5.1.9). */
export function segmentDistance(A: CapsuleSegment, B: CapsuleSegment): number {
  const d1x = A.bx - A.ax, d1y = A.by - A.ay, d1z = A.bz - A.az;
  const d2x = B.bx - B.ax, d2y = B.by - B.ay, d2z = B.bz - B.az;
  const rx = A.ax - B.ax, ry = A.ay - B.ay, rz = A.az - B.az;
  const a = d1x * d1x + d1y * d1y + d1z * d1z;
  const e = d2x * d2x + d2y * d2y + d2z * d2z;
  const f = d2x * rx + d2y * ry + d2z * rz;
  const clamp = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);
  let s = 0;
  let t = 0;
  if (a <= 1e-12) {
    t = e <= 1e-12 ? 0 : clamp(f / e);
  } else {
    const c = d1x * rx + d1y * ry + d1z * rz;
    if (e <= 1e-12) s = clamp(-c / a);
    else {
      const b = d1x * d2x + d1y * d2y + d1z * d2z;
      const den = a * e - b * b;
      s = den > 1e-12 ? clamp((b * f - c * e) / den) : 0;
      t = (b * s + f) / e;
      if (t < 0) {
        t = 0;
        s = clamp(-c / a);
      } else if (t > 1) {
        t = 1;
        s = clamp((b - c) / a);
      }
    }
  }
  return Math.hypot(A.ax + d1x * s - (B.ax + d2x * t), A.ay + d1y * s - (B.ay + d2y * t), A.az + d1z * s - (B.az + d2z * t));
}

function rotateInv(q: RAPIER.Rotation, x: number, y: number, z: number): RAPIER.Vector {
  // v' = conj(q) * v * q
  const qx = -q.x, qy = -q.y, qz = -q.z, qw = q.w;
  const ix = qw * x + qy * z - qz * y;
  const iy = qw * y + qz * x - qx * z;
  const iz = qw * z + qx * y - qy * x;
  const iw = -qx * x - qy * y - qz * z;
  return {
    x: ix * qw + iw * -qx + iy * -qz - iz * -qy,
    y: iy * qw + iw * -qy + iz * -qx - ix * -qz,
    z: iz * qw + iw * -qz + ix * -qy - iy * -qx,
  };
}

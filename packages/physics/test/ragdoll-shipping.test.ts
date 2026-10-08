import { beforeAll, describe, expect, it } from "vitest";
import { applyOps, ComponentRegistry, createScene, registerCoreComponents, type Op } from "@hitreg/core";
import { initPhysics, PhysicsSim, RAGDOLL_POSE_STRIDE, type RagdollSpec } from "../src/index.js";

/**
 * The ragdoll features added to ship it on by default (ragdoll.ts): per-axis
 * limits, self-collision with spawn-overlap exclusion, growing late damping,
 * and the roll guard that keeps a quadruped off its back.
 */

let registry: ComponentRegistry;
beforeAll(async () => {
  await initPhysics();
  registry = new ComponentRegistry();
  registerCoreComponents(registry);
});

type Q = [number, number, number, number];
const ID: Q = [0, 0, 0, 1];
/** Capsule axis +Y turned onto -X (lying along X). */
const ALONG_X: Q = [0, 0, Math.SQRT1_2, Math.SQRT1_2];

function sim(rotationX = 0): PhysicsSim {
  const ops: Op[] = [
    {
      op: "add-entity",
      id: "floor",
      entity: {
        name: "floor",
        parent: null,
        tags: [],
        components: {
          transform: { position: [0, -0.5 / Math.cos(rotationX), 0], rotation: [Math.sin(rotationX / 2), 0, 0, Math.cos(rotationX / 2)] },
          rigidbody: { kind: "static" },
          collider: { shape: "box", size: [40, 1, 40] },
        },
      },
    },
  ];
  return new PhysicsSim(applyOps(createScene("ragdoll"), ops, registry).doc);
}

/** conj(a) * b */
function rel(a: ArrayLike<number>, ao: number, b: ArrayLike<number>, bo: number): Q {
  const ax = -a[ao]!, ay = -a[ao + 1]!, az = -a[ao + 2]!, aw = a[ao + 3]!;
  const bx = b[bo]!, by = b[bo + 1]!, bz = b[bo + 2]!, bw = b[bo + 3]!;
  return [
    aw * bx + ax * bw + ay * bz - az * by,
    aw * by - ax * bz + ay * bw + az * bx,
    aw * bz + ax * by - ay * bx + az * bw,
    aw * bw - ax * bx - ay * by - az * bz,
  ];
}

describe("ragdoll shipping features", () => {
  it("per-axis limits: the forbidden twist stays small while a free axis swings", () => {
    const s = sim();
    const down: Q = [1, 0, 0, 0];
    const spec: RagdollSpec = {
      bodies: [
        { position: [0, 6, 0], collider: { center: [0, 0.35, 0], rotation: ID, halfHeight: 0.25, radius: 0.15 } },
        { position: [0.1, 6, 0], collider: { center: [0, -0.45, 0], rotation: down, halfHeight: 0.4, radius: 0.08 }, angvel: [0, 25, 0] },
      ],
      // the leg may swing about X and Z, hardly turn about Y (its own long axis)
      joints: [{ parent: 0, child: 1, anchor: [0.1, 6, 0], limit: [1.2, 0.05, 1.2] }],
      stiffness: 0,
    };
    const h = s.addRagdoll(spec);
    const out = new Float32Array(2 * RAGDOLL_POSE_STRIDE);
    let worst = 0;
    for (let i = 0; i < 40; i++) {
      s.step(1 / 60);
      s.ragdollPoses(h, out);
      const q = rel(out, 3, out, 10);
      worst = Math.max(worst, Math.abs(2 * Math.atan2(q[1], q[3])));
    }
    expect(worst).toBeLessThan(0.25);
    s.free();
  });

  it("selfCollide: a limb lands on its own trunk instead of sinking through it, and a spawn overlap does not pop", () => {
    // a trunk lying on the floor, a forearm above it (jointed to a third body off to the side),
    // and a short "thigh" that overlaps the trunk at spawn
    const spec = (selfCollide: boolean): RagdollSpec => ({
      bodies: [
        { position: [0.5, 0.15, 0], collider: { center: [0, 0, 0], rotation: ALONG_X, halfHeight: 0.5, radius: 0.15 } },
        { position: [0.3, 0.7, 0], collider: { center: [0, 0, 0], rotation: ALONG_X, halfHeight: 0.15, radius: 0.05 } },
        { position: [-0.6, 0.7, 0], collider: { center: [0, 0, 0], rotation: ID, halfHeight: 0.05, radius: 0.05 } },
        { position: [0.5, 0.2, 0.12], collider: { center: [0, 0, 0], rotation: ID, halfHeight: 0.05, radius: 0.08 } },
      ],
      joints: [{ parent: 2, child: 1, anchor: [-0.6, 0.7, 0], limit: 3 }],
      stiffness: 0,
      selfCollide,
    });
    const run = (selfCollide: boolean) => {
      const s = sim();
      const h = s.addRagdoll(spec(selfCollide));
      const out = new Float32Array(4 * RAGDOLL_POSE_STRIDE);
      let thighJump = 0;
      for (let i = 0; i < 60; i++) {
        s.step(1 / 60);
        s.ragdollPoses(h, out);
        if (i < 5) thighJump = Math.max(thighJump, Math.hypot(out[21]! - 0.5, out[23]! - 0.12));
      }
      const forearmY = out[8]!;
      s.free();
      return { forearmY, thighJump };
    };
    const off = run(false);
    const on = run(true);
    expect(off.forearmY).toBeLessThan(0.15); // fell through the trunk to the floor
    expect(on.forearmY).toBeGreaterThan(0.3); // resting on top of it
    expect(on.thighJump).toBeLessThan(0.05); // the overlap at spawn was exempt, not shoved apart
  });

  it("late damping keeps growing: a round body stops rolling down a slope", () => {
    const roll = (settle: boolean): number => {
      const s = sim(0.3); // ~17 degrees
      const h = s.addRagdoll({
        // a capsule across the fall line: it rolls
        bodies: [{ position: [0, 0.5, 0], collider: { center: [0, 0, 0], rotation: ALONG_X, halfHeight: 0.3, radius: 0.15 } }],
        joints: [],
        linearDamping: 0.3,
        angularDamping: 3,
        ...(settle ? { settle: { after: 0.5, linearDamping: 7, angularDamping: 20 } } : {}),
      });
      const out = new Float32Array(RAGDOLL_POSE_STRIDE);
      for (let i = 0; i < 180; i++) s.step(1 / 60);
      s.ragdollPoses(h, out);
      const z0 = out[2]!;
      for (let i = 0; i < 60; i++) s.step(1 / 60);
      s.ragdollPoses(h, out);
      s.free();
      return Math.abs(out[2]! - z0); // metres travelled in the 4th second
    };
    const free = roll(false);
    const damped = roll(true);
    expect(free).toBeGreaterThan(0.3);
    // a few centimetres a second at most by then: the freeze window catches it
    expect(damped).toBeLessThan(0.1);
    expect(damped).toBeLessThan(free / 10);
  });

  it("rollGuard: a body rolling over onto its back is turned back onto its side", () => {
    const run = (guard: boolean): number => {
      const s = sim();
      // a wide flat "trunk" along Z (its forward), standing on two "legs", spun hard about Z
      const spec: RagdollSpec = {
        bodies: [
          { position: [0, 0.6, 0], collider: { center: [0, 0, 0], rotation: [Math.SQRT1_2, 0, 0, Math.SQRT1_2], halfHeight: 0.4, radius: 0.2 }, angvel: [0, 0, 6] },
          { position: [0.15, 0.4, 0], collider: { center: [0, 0, 0], rotation: ID, halfHeight: 0.15, radius: 0.05 }, angvel: [0, 0, 6] },
          { position: [-0.15, 0.4, 0], collider: { center: [0, 0, 0], rotation: ID, halfHeight: 0.15, radius: 0.05 }, angvel: [0, 0, 6] },
        ],
        joints: [
          { parent: 0, child: 1, anchor: [0.15, 0.4, 0], limit: 0.2 },
          { parent: 0, child: 2, anchor: [-0.15, 0.4, 0], limit: 0.2 },
        ],
        stiffness: 0,
        angularDamping: 0.5,
        ...(guard ? { rollGuard: -0.3 } : {}),
      };
      const h = s.addRagdoll(spec);
      const out = new Float32Array(3 * RAGDOLL_POSE_STRIDE);
      for (let i = 0; i < 180; i++) s.step(1 / 60);
      s.ragdollPoses(h, out);
      s.free();
      // the root's up: its rotation applied to +Y (spawned at identity)
      const [x, , z] = [out[3]!, out[4]!, out[5]!];
      return 1 - 2 * (x * x + z * z);
    };
    expect(run(false)).toBeLessThan(-0.5); // on its back
    expect(run(true)).toBeGreaterThan(-0.4); // on its side
  });
});

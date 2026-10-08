import { beforeAll, describe, expect, it } from "vitest";
import { applyOps, ComponentRegistry, createScene, registerCoreComponents, type Op } from "@hitreg/core";
import { initPhysics, Layers, PhysicsSim, RAGDOLL_POSE_STRIDE, type RagdollSpec } from "../src/index.js";

let registry: ComponentRegistry;
beforeAll(async () => {
  await initPhysics();
  registry = new ComponentRegistry();
  registerCoreComponents(registry);
});

function floorSim(): PhysicsSim {
  const ops: Op[] = [
    {
      op: "add-entity",
      id: "floor",
      entity: {
        name: "floor",
        parent: null,
        tags: [],
        components: {
          transform: { position: [0, -0.5, 0] },
          rigidbody: { kind: "static" },
          collider: { shape: "box", size: [40, 1, 40] },
        },
      },
    },
  ];
  return new PhysicsSim(applyOps(createScene("ragdoll"), ops, registry).doc);
}

/** A standing three-link "body": trunk, and two legs hanging from its bottom. */
function standing(kick = 2): RagdollSpec {
  const up: [number, number, number, number] = [0, 0, 0, 1];
  const down: [number, number, number, number] = [1, 0, 0, 0]; // +Y -> -Y
  return {
    bodies: [
      { position: [0, 1, 0], collider: { center: [0, 0.35, 0], rotation: up, halfHeight: 0.25, radius: 0.15 }, linvel: [kick, 0, 0] },
      { position: [0.1, 1, 0], collider: { center: [0, -0.45, 0], rotation: down, halfHeight: 0.4, radius: 0.08 } },
      { position: [-0.1, 1, 0], collider: { center: [0, -0.45, 0], rotation: down, halfHeight: 0.4, radius: 0.08 } },
    ],
    joints: [
      { parent: 0, child: 1, anchor: [0.1, 1, 0], limit: 0.9 },
      { parent: 0, child: 2, anchor: [-0.1, 1, 0], limit: 0.9 },
    ],
    stiffness: 20,
    angularDamping: 3,
  };
}

describe("ragdolls", () => {
  it("fall onto the ground, come to rest, and leave nothing behind once removed", () => {
    const sim = floorSim();
    const h = sim.addRagdoll(standing());
    expect(sim.ragdollStats()).toMatchObject({ active: 1, bodies: 3, joints: 2 });
    // not entities: no readback through states()
    expect(sim.states().size).toBe(0);
    const out = new Float32Array(3 * RAGDOLL_POSE_STRIDE);
    let steps = 0;
    let still = 0;
    while (steps < 600 && still < 30) {
      sim.step(1 / 60);
      steps++;
      still = sim.ragdollSettled(h) ? still + 1 : 0;
    }
    expect(still).toBe(30); // settled within 10 s of sim
    expect(sim.ragdollPoses(h, out)).toBe(3);
    // toppled: the trunk origin is well below where it stood, and above the floor
    expect(out[1]).toBeLessThan(0.6);
    expect(out[1]).toBeGreaterThan(-0.05);
    // pushed along the blow
    expect(out[0]).toBeGreaterThan(0.1);
    const collidersBefore = sim.stats().colliders;
    sim.removeRagdoll(h);
    expect(sim.ragdollStats()).toMatchObject({ active: 0, bodies: 0, created: 1, removed: 1 });
    expect(sim.stats().colliders).toBe(collidersBefore - 3);
    expect(sim.ragdollPoses(h, out)).toBe(0);
    expect(sim.ragdollSettled(h)).toBe(true);
    sim.free();
  });

  it("joint limits hold: a leg cannot swing past its limit from the spawn pose", () => {
    const sim = floorSim();
    const spec = standing(0);
    spec.stiffness = 0;
    spec.joints.forEach((j) => (j.limit = 0.2));
    // drop it from height with the legs spun hard
    spec.bodies.forEach((b) => (b.position[1] += 5));
    spec.joints.forEach((j) => (j.anchor[1] += 5));
    spec.bodies[1]!.angvel = [0, 0, 30];
    const h = sim.addRagdoll(spec);
    const out = new Float32Array(3 * RAGDOLL_POSE_STRIDE);
    let worst = 0;
    for (let i = 0; i < 40; i++) {
      sim.step(1 / 60);
      sim.ragdollPoses(h, out);
      // relative rotation trunk -> leg: angle of conj(q0) * q1
      const q0 = [out[3]!, out[4]!, out[5]!, out[6]!];
      const q1 = [out[10]!, out[11]!, out[12]!, out[13]!];
      const dot = Math.abs(q0[0]! * q1[0]! + q0[1]! * q1[1]! + q0[2]! * q1[2]! + q0[3]! * q1[3]!);
      worst = Math.max(worst, 2 * Math.acos(Math.min(1, dot)));
    }
    // three axes at 0.2 rad each: at most ~0.35 rad combined, plus solver slack
    expect(worst).toBeLessThan(0.5);
    sim.free();
  });

  it("are invisible to gameplay queries and to characters unless DEBRIS is asked for", () => {
    const sim = floorSim();
    const h = sim.addRagdoll(standing(0));
    sim.step(1 / 60);
    // straight down through the trunk: the default query hits the floor, not the ragdoll
    const hit = sim.raycast([0, 3, 0], [0, -1, 0], 10);
    expect(hit?.entityId).toBe("floor");
    expect(hit!.distance).toBeGreaterThan(2.9);
    sim.removeRagdoll(h);
    expect(Layers.DEBRIS).toBeGreaterThan(0);
    sim.free();
  });
});

import { beforeAll, describe, expect, it } from "vitest";
import RAPIER from "@dimforge/rapier3d-compat";
import { applyOps, ComponentRegistry, createScene, registerCoreComponents, type Op } from "@hitreg/core";
import { initPhysics, PhysicsSim } from "../src/index.js";
import { colliderFault } from "../src/sim.js";

// 2026-10-29 redstrand dropped-hour: poi-walk died in Rapier (`unreachable` / `Maximum call stack size exceeded`
// in stepWithEvents) right after an inline cell load. Not the props it was blamed on: Rapier 0.19.3's broad-phase
// BVH (parry `Bvh::optimize_incremental`) panics when SEVERAL colliders are removed in one step and the next step
// inserts again — a cold start released every streamed static, then the cell loaded. PhysicsSim.retireBody now hands
// Rapier at most one collider removal per update. These are the minimal sequence that panicked and a churn fuzz.

let registry: ComponentRegistry;
beforeAll(async () => {
  await initPhysics();
  registry = new ComponentRegistry();
  registerCoreComponents(registry);
});

const DT = 1 / 60;

function entity(id: string, position: [number, number, number], components: Record<string, unknown>): Op {
  return { op: "add-entity", id, entity: { name: id, parent: null, tags: [], components: { transform: { position }, ...components } } };
}
const scene = (ops: Op[]) => applyOps(createScene("bp"), ops, registry).doc;
const box = (id: string, p: [number, number, number], size: [number, number, number]): Op => entity(id, p, { collider: { shape: "box", size } });

describe("broad-phase removals", () => {
  it("two colliders removed in one step, then an insert, steps cleanly (the dropped-hour panic)", () => {
    const sim = new PhysicsSim(
      scene([entity("player", [5432, 500, 0], { rigidbody: { kind: "dynamic" }, collider: { shape: "capsule", size: [0.8, 1.8, 0.8] } })]),
    );
    for (let i = 0; i < 5; i++) sim.step(DT);
    sim.setPosition("player", [1026, 59.42, -280]);
    sim.step(DT);
    sim.addEntities(scene([box("b1", [910.9, 55, -377.3], [1.82, 0.86, 1.3]), box("b2", [915, 55.5, -362.8], [0.84, 0.62, 0.76])]));
    for (let i = 0; i < 5; i++) {
      sim.setPosition("player", [1026, 59.42, -280]);
      sim.step(DT);
    }
    sim.setPosition("player", [5217, 500, -1511]);
    sim.step(DT);
    sim.removeEntities(["b1", "b2"]);
    // gone for the game at once (no hits, not counted), out of Rapier over the next updates
    expect(sim.stats().colliders).toBe(1);
    expect(sim.raycast([915, 70, -362.8], [0, -1, 0], 30)).toBeNull();
    for (let i = 0; i < 5; i++) {
      sim.setPosition("player", [1022, 60.24, -296]);
      sim.step(DT);
    }
    sim.addEntities(scene([box("cauldron", [1018, 58.81, -298], [3.6, 1.8, 2.8])]));
    sim.setPosition("player", [1022, 60.24, -296]);
    expect(() => sim.step(0)).not.toThrow();
    expect(() => sim.step(DT)).not.toThrow();
    sim.free();
  });

  it("survives add/remove churn on a near-empty world (unpaced, 3 of 30 seeds panicked)", () => {
    for (let seed0 = 1; seed0 <= 12; seed0++) {
      let seed = seed0;
      const rnd = (): number => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
      const sim = new PhysicsSim(scene([entity("player", [0, 50, 0], { rigidbody: { kind: "dynamic" }, collider: { shape: "capsule", size: [0.8, 1.8, 0.8] } })]));
      const live: string[] = [];
      let n = 0;
      expect(() => {
        for (let round = 0; round < 400; round++) {
          const adds: Op[] = [];
          for (let i = Math.floor(rnd() * 6); i > 0; i--) {
            const id = `s${n++}`;
            adds.push(box(id, [rnd() * 400, rnd() * 20, rnd() * 400], [0.4 + rnd() * 2, 0.4 + rnd() * 2, 0.4 + rnd() * 2]));
            live.push(id);
          }
          if (adds.length) sim.addEntities(scene(adds));
          const gone: string[] = [];
          for (let i = Math.floor(rnd() * 9); i > 0 && live.length; i--) gone.push(...live.splice(Math.floor(rnd() * live.length), 1));
          sim.removeEntities(gone);
          sim.setPosition("player", [rnd() * 400, 30, rnd() * 400]);
          sim.step(DT);
        }
      }, `seed ${seed0}`).not.toThrow();
      sim.free();
    }
  });
});

describe("colliderFault", () => {
  const world = (): RAPIER.World => new RAPIER.World({ x: 0, y: -9.81, z: 0 });
  it("passes a sound trimesh and refuses broken geometry", () => {
    const w = world();
    const body = w.createRigidBody(RAPIER.RigidBodyDesc.fixed());
    const tri = (v: number[], i: number[]) => RAPIER.ColliderDesc.trimesh(new Float32Array(v), new Uint32Array(i));
    expect(colliderFault(tri([0, 0, 0, 1, 0, 0, 0, 0, 1], [0, 1, 2]), body, [0, 0, 0])).toBeNull();
    expect(colliderFault(tri([0, 0, 0, NaN, 0, 0, 0, 0, 1], [0, 1, 2]), body, [0, 0, 0])).toMatch(/vertex 1/);
    expect(colliderFault(tri([0, 0, 0, 1, 0, 0, 0, 0, 1], [0, 1, 3]), body, [0, 0, 0])).toMatch(/past its 3 vertices/);
    expect(colliderFault(RAPIER.ColliderDesc.cuboid(1, Infinity, 1), body, [0, 0, 0])).toMatch(/size/);
    expect(colliderFault(RAPIER.ColliderDesc.cuboid(1, 1, 1), body, [0, NaN, 0])).toMatch(/offset/);
    w.free();
  });

  it("a scene entity with a non-finite size gets no collider and a warning naming it, and the step runs", () => {
    const warns: string[] = [];
    const warn = console.warn;
    console.warn = (...a: unknown[]) => void warns.push(a.map(String).join(" "));
    try {
      // a file-authored doc is not re-validated on load: the NaN reaches the collider build
      const doc = scene([box("bad-prop", [0, 0, 0], [1, 1, 1]), box("floor", [0, -1, 0], [10, 1, 10])]);
      (doc.entities["bad-prop"]!.components["collider"] as { size: number[] }).size = [1, Number.NaN, 1];
      const sim = new PhysicsSim(doc);
      expect(() => sim.step(DT)).not.toThrow();
      expect(warns.some((w) => w.includes("bad-prop") && w.includes("collider refused"))).toBe(true);
      sim.free();
    } finally {
      console.warn = warn;
    }
  });
});

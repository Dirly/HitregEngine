import { beforeAll, describe, expect, it } from "vitest";
import { applyOps, ComponentRegistry, createScene, registerCoreComponents, type Op, type SceneDoc } from "@hitreg/core";
import { initPhysics, PhysicsSim } from "../src/index.js";

let registry: ComponentRegistry;

beforeAll(async () => {
  await initPhysics();
  registry = new ComponentRegistry();
  registerCoreComponents(registry);
});

function scene(ops: Op[]): SceneDoc {
  return applyOps(createScene("hold-test"), ops, registry).doc;
}

const ground: Op = {
  op: "add-entity",
  id: "ground",
  entity: {
    name: "Ground",
    parent: null,
    tags: [],
    components: { transform: {}, collider: { shape: "box", size: [40, 0.2, 40], offset: [0, -0.1, 0] } },
  },
};

function crate(id: string, position: [number, number, number]): Op {
  return {
    op: "add-entity",
    id,
    entity: {
      name: id,
      parent: null,
      tags: [],
      components: { transform: { position }, rigidbody: {}, collider: { shape: "box", size: [1, 1, 1] } },
    },
  };
}

/** Steps with the hold applied after each one, as a host does. */
function run(sim: PhysicsSim, seconds: number, simulated: (x: number, z: number) => boolean): void {
  for (let i = 0; i < seconds * 60; i++) {
    sim.step(1 / 60);
    sim.holdUngrounded(simulated);
  }
}

describe("PhysicsSim.holdUngrounded", () => {
  it("a body standing where no ground is simulated stays where it is instead of falling", () => {
    // the crate hangs at y=5 over nothing (no ground entity at all): the cell under it is "not simulated"
    const sim = new PhysicsSim(scene([crate("far", [100, 5, 100])]));
    run(sim, 2, () => false);
    const p = sim.getPosition("far")!;
    expect(p[1]).toBeCloseTo(5, 1);
    expect(sim.holdUngrounded(() => false)).toBe(1);
    sim.free();
  });

  it("a script waking the body each step cannot make it sink; the hold restores its height", () => {
    const sim = new PhysicsSim(scene([crate("far", [100, 5, 100])]));
    for (let i = 0; i < 120; i++) {
      sim.setLinvel("far", [1, 0, 0]); // a mid-band controller walking it east (wakes the body)
      sim.step(1 / 60);
      sim.holdUngrounded(() => false);
    }
    const p = sim.getPosition("far")!;
    expect(p[1]).toBeCloseTo(5, 1);
    expect(p[0]).toBeGreaterThan(101); // it still walked
    sim.free();
  });

  it("the hold ends when the ground becomes simulated: the body wakes and falls onto it", () => {
    const sim = new PhysicsSim(scene([ground, crate("near", [0, 5, 0])]));
    run(sim, 1, () => false);
    expect(sim.getPosition("near")![1]).toBeCloseTo(5, 1);
    run(sim, 3, () => true);
    const y = sim.getPosition("near")![1];
    expect(y).toBeGreaterThan(0.3);
    expect(y).toBeLessThan(0.7);
    expect(sim.holdUngrounded(() => true)).toBe(0);
    sim.free();
  });

  it("a respawn above the held height raises the hold", () => {
    const sim = new PhysicsSim(scene([crate("far", [100, 5, 100])]));
    run(sim, 1, () => false);
    sim.setPosition("far", [100, 20, 100]);
    run(sim, 1, () => false);
    expect(sim.getPosition("far")![1]).toBeCloseTo(20, 1);
    sim.free();
  });

  it("releaseUngrounded lets held bodies fall again", () => {
    const sim = new PhysicsSim(scene([crate("far", [100, 5, 100])]));
    run(sim, 1, () => false);
    sim.releaseUngrounded();
    for (let i = 0; i < 60; i++) sim.step(1 / 60);
    expect(sim.getPosition("far")![1]).toBeLessThan(2);
    sim.free();
  });
});

describe("PhysicsSim.states(true) — the readback set", () => {
  it("reports a resting body twice after it sleeps, then skips it until it moves", () => {
    const sim = new PhysicsSim(scene([ground, crate("c", [0, 2, 0])]));
    for (let i = 0; i < 60 * 4; i++) sim.step(1 / 60);
    // the crate is asleep on the ground by now
    expect(sim.states().has("c")).toBe(true); // the complete map always has it
    const a = sim.states(true).has("c"), b = sim.states(true).has("c"), c = sim.states(true).has("c");
    expect([a, b, c]).toEqual([true, true, false]);
    // moved in its sleep (a held body put back, or a teleport): reported again
    sim.setPosition("c", [3, 2, 0]);
    sim.step(1 / 60);
    expect(sim.states(true).has("c")).toBe(true);
    sim.free();
  });

  it("a sleeping body teleported into a cell with no ground is reported at its new place (t-batch2 fast travel)", () => {
    // asleep on the ground, its two asleep reports spent; then fast-travelled far off where nothing is simulated yet:
    // the hold sleeps it again before the readback, and the readback must still carry the move (the host's streaming
    // focus follows the scene object; an unreported move never loads the ground that would release the hold)
    const sim = new PhysicsSim(scene([ground, crate("p", [0, 2, 0])]));
    for (let i = 0; i < 60 * 4; i++) { sim.step(1 / 60); sim.holdUngrounded(() => true); }
    sim.states(true); sim.states(true);
    expect(sim.states(true).has("p")).toBe(false);
    const far = (x: number) => x < 50;
    let seen: number[] | null = null;
    for (let i = 0; i < 30; i++) {
      sim.setPosition("p", [300, 40, -200]); // the travel hold re-asserts the target every frame
      sim.step(1 / 60);
      sim.holdUngrounded(far);
      const s = sim.states(true).get("p");
      if (s) seen = s.position;
    }
    expect(seen).not.toBeNull();
    expect(seen![0]).toBeCloseTo(300, 1);
    expect(seen![2]).toBeCloseTo(-200, 1);
    sim.free();
  });

  it("a held ungrounded body is reported while it is put back, then skipped", () => {
    const sim = new PhysicsSim(scene([crate("far", [100, 5, 100])]));
    let reported = 0;
    for (let i = 0; i < 120; i++) {
      sim.step(1 / 60);
      sim.holdUngrounded(() => false);
      if (sim.states(true).has("far")) reported++;
    }
    expect(reported).toBeLessThan(10);
    expect(reported).toBeGreaterThan(0);
    sim.free();
  });
});

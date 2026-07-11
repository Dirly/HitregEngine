import { beforeAll, describe, expect, it } from "vitest";
import {
  applyOps,
  ComponentRegistry,
  createScene,
  registerCoreComponents,
  type Op,
  type SceneDoc,
} from "@hitreg/core";
import { initPhysics, PhysicsSim } from "../src/index.js";

let registry: ComponentRegistry;

beforeAll(async () => {
  await initPhysics();
  registry = new ComponentRegistry();
  registerCoreComponents(registry);
});

function scene(ops: Op[]): SceneDoc {
  return applyOps(createScene("events-test"), ops, registry).doc;
}

/** A static sensor box at the origin and a dynamic gravity-free ball inside it. */
function overlappingPair(): SceneDoc {
  return scene([
    {
      op: "add-entity",
      id: "zone",
      entity: {
        name: "Zone",
        parent: null,
        tags: [],
        components: {
          transform: {},
          collider: { shape: "box", size: [4, 4, 4], isTrigger: true },
        },
      },
    },
    {
      op: "add-entity",
      id: "ball",
      entity: {
        name: "Ball",
        parent: null,
        tags: [],
        components: {
          transform: {},
          rigidbody: { kind: "dynamic", gravityScale: 0 },
          collider: { shape: "sphere", size: [1, 1, 1] },
        },
      },
    },
  ]);
}

describe("collision start/end events + sensor tracking", () => {
  it("reports which entities are sensors", () => {
    const sim = new PhysicsSim(overlappingPair());
    expect(sim.isTrigger("zone")).toBe(true);
    expect(sim.isTrigger("ball")).toBe(false);
    expect(sim.isTrigger("no-such-entity")).toBe(false);
    sim.free();
  });

  it("overlap produces a started pair; moving apart produces an ended pair", () => {
    const sim = new PhysicsSim(overlappingPair());
    sim.step(1 / 60);
    const started = sim.takeCollisions();
    expect(started).toContainEqual(expect.arrayContaining(["zone", "ball"]));
    expect(sim.takeCollisionEnds()).toEqual([]); // still overlapping

    // teleport the ball far away — the overlap ends
    sim.setPosition("ball", [100, 0, 0]);
    for (let i = 0; i < 5; i++) sim.step(1 / 60);
    const ended = sim.takeCollisionEnds();
    expect(ended).toContainEqual(expect.arrayContaining(["zone", "ball"]));
    // takeCollisionEnds drains: a second call is empty
    expect(sim.takeCollisionEnds()).toEqual([]);
    sim.free();
  });
});

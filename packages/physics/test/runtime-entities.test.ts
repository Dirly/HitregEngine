import { beforeAll, describe, expect, it } from "vitest";
import {
  applyOps,
  chunkDocSchema,
  chunkToSceneDoc,
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
  return applyOps(createScene("runtime-test"), ops, registry).doc;
}

const ball: Op = {
  op: "add-entity",
  id: "ball",
  entity: {
    name: "Ball",
    parent: null,
    tags: [],
    components: {
      transform: { position: [0, 3, 0] },
      rigidbody: { kind: "dynamic" },
      collider: { shape: "sphere", size: [1, 1, 1] },
    },
  },
};

function simulateSeconds(sim: PhysicsSim, seconds: number): void {
  const dt = 1 / 60;
  for (let i = 0; i < seconds * 60; i++) sim.step(dt);
}

describe("runtime entity injection (chunk streaming)", () => {
  it("addEntities builds colliders a dynamic body can rest on", () => {
    const sim = new PhysicsSim(scene([ball]));
    // a chunk arrives under the falling ball
    const chunk = chunkDocSchema.parse({
      version: 1,
      entities: {
        ground: {
          name: "Ground",
          components: {
            transform: { position: [0, -0.5, 0] },
            collider: { shape: "box", size: [16, 1, 16] },
          },
        },
      },
    });
    const { doc } = chunkToSceneDoc("demo", 0, 0, 16, chunk);
    sim.addEntities(doc);
    simulateSeconds(sim, 2);
    const y = sim.states().get("ball")!.position[1];
    expect(y).toBeGreaterThan(0.3); // resting on the chunk slab, not fallen through
    sim.free();
  });

  it("removeEntities drops the chunk's colliders", () => {
    const sim = new PhysicsSim(scene([ball]));
    const chunk = chunkDocSchema.parse({
      version: 1,
      entities: {
        ground: {
          name: "Ground",
          components: {
            transform: { position: [0, -0.5, 0] },
            collider: { shape: "box", size: [16, 1, 16] },
          },
        },
      },
    });
    const { doc } = chunkToSceneDoc("demo", 0, 0, 16, chunk);
    sim.addEntities(doc);
    simulateSeconds(sim, 2);
    expect(sim.states().get("ball")!.position[1]).toBeGreaterThan(0.3);
    sim.removeEntities(Object.keys(doc.entities));
    simulateSeconds(sim, 1);
    expect(sim.states().get("ball")!.position[1]).toBeLessThan(-1); // now falling
    sim.free();
  });

  it("chunk world offset positions colliders at the cell origin", () => {
    // chunk at cell (2, 0) with cellSize 16 -> slab centered at x=32; a ball
    // dropped at x=0 must NOT land on it
    const sim = new PhysicsSim(scene([ball]));
    const chunk = chunkDocSchema.parse({
      version: 1,
      entities: {
        ground: {
          name: "Ground",
          components: {
            transform: { position: [0, -0.5, 0] },
            collider: { shape: "box", size: [16, 1, 16] },
          },
        },
      },
    });
    const { doc } = chunkToSceneDoc("demo", 2, 0, 16, chunk);
    sim.addEntities(doc);
    simulateSeconds(sim, 2);
    expect(sim.states().get("ball")!.position[1]).toBeLessThan(-1);
    sim.free();
  });
});

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
  return applyOps(createScene("physics-test"), ops, registry).doc;
}

const ground: Op = {
  op: "add-entity",
  id: "ground",
  entity: {
    name: "Ground",
    parent: null,
    tags: [],
    components: {
      transform: {},
      collider: { shape: "box", size: [40, 0.2, 40], offset: [0, -0.1, 0] },
    },
  },
};

function simulateSeconds(sim: PhysicsSim, seconds: number): void {
  const dt = 1 / 60;
  for (let i = 0; i < seconds * 60; i++) sim.step(dt);
}

describe("PhysicsSim (headless Node — the server story)", () => {
  it("a dynamic crate falls and rests on static ground", () => {
    const doc = scene([
      ground,
      {
        op: "add-entity",
        id: "crate",
        entity: {
          name: "Crate",
          parent: null,
          tags: [],
          components: {
            transform: { position: [0, 5, 0] },
            rigidbody: {},
            collider: { shape: "box", size: [1, 1, 1] },
          },
        },
      },
    ]);
    const sim = new PhysicsSim(doc);
    simulateSeconds(sim, 3);
    const state = sim.states().get("crate")!;
    // rests with center ~half-height above ground surface (y=0)
    expect(state.position[1]).toBeGreaterThan(0.3);
    expect(state.position[1]).toBeLessThan(0.7);
    sim.free();
  });

  it("statics never move and never report state", () => {
    const doc = scene([ground]);
    const sim = new PhysicsSim(doc);
    simulateSeconds(sim, 1);
    expect(sim.states().size).toBe(0);
    sim.free();
  });

  it("a hinge joint holds a door panel against gravity", () => {
    const doc = scene([
      {
        op: "add-entity",
        id: "frame",
        entity: {
          name: "Frame",
          parent: null,
          tags: [],
          components: {
            transform: { position: [0, 2, 0] },
            collider: { shape: "cylinder", size: [0.2, 4, 0.2] },
          },
        },
      },
      {
        op: "add-entity",
        id: "panel",
        entity: {
          name: "Panel",
          parent: null,
          tags: [],
          components: {
            transform: { position: [0.7, 2, 0] },
            rigidbody: {},
            collider: { shape: "box", size: [1.2, 2, 0.1], density: 0.5 },
            joint: {
              kind: "hinge",
              target: "frame",
              anchorA: [-0.7, 0, 0],
              anchorB: [0, 0, 0],
              axis: [0, 1, 0],
            },
          },
        },
      },
    ]);
    const sim = new PhysicsSim(doc);
    simulateSeconds(sim, 3);
    const panel = sim.states().get("panel")!;
    // without the joint it would free-fall far below; hinged it stays at frame height
    expect(panel.position[1]).toBeGreaterThan(1.5);
    // and remains within arm's reach of the hinge axis
    const dx = panel.position[0];
    const dz = panel.position[2];
    expect(Math.sqrt(dx * dx + dz * dz)).toBeLessThan(1.0);
    sim.free();
  });

  it("a hinge motor swings the door", () => {
    const doc = scene([
      {
        op: "add-entity",
        id: "frame",
        entity: {
          name: "Frame",
          parent: null,
          tags: [],
          components: { transform: { position: [0, 2, 0] }, collider: { shape: "cylinder", size: [0.2, 4, 0.2] } },
        },
      },
      {
        op: "add-entity",
        id: "panel",
        entity: {
          name: "Panel",
          parent: null,
          tags: [],
          components: {
            transform: { position: [0.7, 2, 0] },
            rigidbody: { gravityScale: 0 },
            collider: { shape: "box", size: [1.2, 2, 0.1], density: 0.5 },
            joint: {
              kind: "hinge",
              target: "frame",
              anchorA: [-0.7, 0, 0],
              anchorB: [0, 0, 0],
              axis: [0, 1, 0],
              motor: { targetVelocity: 2, maxForce: 100 },
            },
          },
        },
      },
    ]);
    const sim = new PhysicsSim(doc);
    const before = sim.states().get("panel")!.position;
    simulateSeconds(sim, 1);
    const after = sim.states().get("panel")!.position;
    // motor rotates the panel around the frame: x/z must have moved
    const moved = Math.abs(after[0] - before[0]) + Math.abs(after[2] - before[2]);
    expect(moved).toBeGreaterThan(0.2);
    sim.free();
  });

  it('a ball rests ON a heightmap terrain, not inside it', async () => {
    const { sampleHeightmap } = await import('@hitreg/core');
    const params = {
      size: [40, 40] as [number, number], amplitude: 2, frequency: 0.1, seed: 3,
      resolution: 48, flatRadius: 0, flatFalloff: 8,
    };
    const doc = scene([
      {
        op: 'add-entity',
        id: 'terrain',
        entity: {
          name: 'Terrain', parent: null, tags: [],
          components: {
            transform: {},
            mesh: { source: { kind: 'heightmap', ...params } },
            collider: { shape: 'heightmap' },
          },
        },
      },
      {
        op: 'add-entity',
        id: 'ball',
        entity: {
          name: 'Ball', parent: null, tags: [],
          components: {
            transform: { position: [5, 8, 5] },
            rigidbody: {},
            collider: { shape: 'sphere', size: [1, 1, 1] },
          },
        },
      },
    ]);
    const sim = new PhysicsSim(doc);
    simulateSeconds(sim, 3);
    const pos = sim.states().get('ball')!.position;
    // resting height = terrain height under the ball + radius (0.5), roughly
    const groundY = sampleHeightmap(params, pos[0], pos[2]);
    expect(pos[1]).toBeGreaterThan(groundY - 0.1);
    expect(pos[1]).toBeLessThan(groundY + 1.5);
    sim.free();
  });
});

import { beforeAll, describe, expect, it, vi } from "vitest";
import {
  applyOps,
  colliderSchema,
  ComponentRegistry,
  createScene,
  registerCoreComponents,
  type Op,
  type SceneDoc,
} from "@hitreg/core";
import { initPhysics, PhysicsSim, type MeshGeometryData } from "../src/index.js";

let registry: ComponentRegistry;

beforeAll(async () => {
  await initPhysics();
  registry = new ComponentRegistry();
  registerCoreComponents(registry);
});

function scene(ops: Op[]): SceneDoc {
  return applyOps(createScene("mesh-collider-test"), ops, registry).doc;
}

function simulateSeconds(sim: PhysicsSim, seconds: number): void {
  const dt = 1 / 60;
  for (let i = 0; i < seconds * 60; i++) sim.step(dt);
}

/** Flat two-triangle quad at y=0 spanning ±half on x/z. */
function quadGeometry(half: number): MeshGeometryData {
  // prettier-ignore
  const positions = new Float32Array([
    -half, 0, -half,
     half, 0, -half,
    -half, 0,  half,
     half, 0,  half,
  ]);
  return { positions, indices: new Uint32Array([0, 2, 1, 1, 2, 3]) };
}

/** 8 corner points of a box (hull input; indices unused by convex cooking). */
function boxPoints(hx: number, hy: number, hz: number): MeshGeometryData {
  const positions = new Float32Array(24);
  for (let k = 0; k < 8; k++) {
    positions[k * 3] = k & 1 ? hx : -hx;
    positions[k * 3 + 1] = k & 2 ? hy : -hy;
    positions[k * 3 + 2] = k & 4 ? hz : -hz;
  }
  return { positions, indices: new Uint32Array(0) };
}

function floorEntity(
  shape: "trimesh" | "convex",
  extra: { scale?: [number, number, number] } = {},
): Op {
  return {
    op: "add-entity",
    id: "floor",
    entity: {
      name: "Floor",
      parent: null,
      tags: [],
      components: {
        transform: extra.scale ? { scale: extra.scale } : {},
        mesh: { source: { kind: "asset", assetId: "model.glb" } },
        collider: { shape },
      },
    },
  };
}

const crate: Op = {
  op: "add-entity",
  id: "crate",
  entity: {
    name: "Crate",
    parent: null,
    tags: [],
    components: {
      transform: { position: [0, 3, 0] },
      rigidbody: {},
      collider: { shape: "box", size: [1, 1, 1] },
    },
  },
};

describe("collider schema", () => {
  it("accepts trimesh and convex shapes", () => {
    expect(colliderSchema.parse({ shape: "trimesh" }).shape).toBe("trimesh");
    expect(colliderSchema.parse({ shape: "convex" }).shape).toBe("convex");
  });
});

describe("trimesh/convex colliders", () => {
  it("builds a trimesh collider from a sync geometry provider", () => {
    const doc = scene([floorEntity("trimesh"), crate]);
    const meshGeometry = vi.fn(() => quadGeometry(10));
    const sim = new PhysicsSim(doc, undefined, { meshGeometry });
    expect(meshGeometry).toHaveBeenCalledWith("model.glb", undefined);
    simulateSeconds(sim, 2);
    const pos = sim.states().get("crate")!.position;
    // crate rests half its height above the quad at y=0
    expect(pos[1]).toBeGreaterThan(0.3);
    expect(pos[1]).toBeLessThan(0.7);
    sim.free();
  });

  it("bakes the entity's world scale into the cooked vertices", () => {
    // quad spans ±2 unscaled; the floor's [5,1,5] scale stretches it to ±10
    const doc = scene([
      floorEntity("trimesh", { scale: [5, 1, 5] }),
      {
        op: "add-entity",
        id: "crate",
        entity: {
          name: "Crate",
          parent: null,
          tags: [],
          components: {
            transform: { position: [6, 3, 0] },
            rigidbody: {},
            collider: { shape: "box", size: [1, 1, 1] },
          },
        },
      },
    ]);
    const sim = new PhysicsSim(doc, undefined, { meshGeometry: () => quadGeometry(2) });
    simulateSeconds(sim, 2);
    const pos = sim.states().get("crate")!.position;
    // without scaling the crate at x=6 would miss the ±2 quad and free-fall
    expect(pos[1]).toBeGreaterThan(0.3);
    expect(pos[1]).toBeLessThan(0.7);
    sim.free();
  });

  it("builds a convex hull collider from point-cloud geometry", () => {
    const doc = scene([floorEntity("convex"), crate]);
    const sim = new PhysicsSim(doc, undefined, {
      meshGeometry: () => boxPoints(10, 0.5, 10),
    });
    simulateSeconds(sim, 2);
    const pos = sim.states().get("crate")!.position;
    // hull top at y=0.5, crate center rests ~0.5 above it
    expect(pos[1]).toBeGreaterThan(0.8);
    expect(pos[1]).toBeLessThan(1.2);
    sim.free();
  });

  it("attaches the collider later when the provider is async", async () => {
    const doc = scene([floorEntity("trimesh"), crate]);
    const sim = new PhysicsSim(doc, undefined, {
      meshGeometry: () => Promise.resolve(quadGeometry(10)),
    });
    // before the geometry resolves, the floor has no collider at all
    await new Promise((resolve) => setTimeout(resolve, 0));
    simulateSeconds(sim, 2);
    const pos = sim.states().get("crate")!.position;
    expect(pos[1]).toBeGreaterThan(0.3);
    expect(pos[1]).toBeLessThan(0.7);
    sim.free();
  });

  it("a freed sim ignores late-resolving geometry instead of crashing", async () => {
    const doc = scene([floorEntity("trimesh")]);
    const sim = new PhysicsSim(doc, undefined, {
      meshGeometry: () => Promise.resolve(quadGeometry(10)),
    });
    sim.free();
    // the resolved geometry must hit the disposed guard, not the freed world
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  it("falls back to a box (default size) when no provider is given", () => {
    const doc = scene([
      floorEntity("trimesh"),
      {
        op: "add-entity",
        id: "ball",
        entity: {
          name: "Ball",
          parent: null,
          tags: [],
          components: {
            transform: { position: [0, 3, 0] },
            rigidbody: {},
            collider: { shape: "sphere", size: [1, 1, 1] },
          },
        },
      },
    ]);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const sim = new PhysicsSim(doc); // no meshGeometry provider
    simulateSeconds(sim, 2);
    const pos = sim.states().get("ball")!.position;
    // fallback = 1m cube at the floor origin: ball rests on its top face (y=0.5)
    expect(pos[1]).toBeGreaterThan(0.8);
    expect(pos[1]).toBeLessThan(1.2);
    expect(warn).toHaveBeenCalledOnce();
    warn.mockRestore();
    sim.free();
  });

  it("cooks a box primitive mesh analytically (no provider needed)", () => {
    const doc = scene([
      {
        op: "add-entity",
        id: "floor",
        entity: {
          name: "Floor",
          parent: null,
          tags: [],
          components: {
            transform: {},
            mesh: { source: { kind: "primitive", shape: "box", size: [20, 1, 20] } },
            collider: { shape: "trimesh" },
          },
        },
      },
      crate,
    ]);
    const sim = new PhysicsSim(doc);
    simulateSeconds(sim, 2);
    const pos = sim.states().get("crate")!.position;
    // box mesh top at y=0.5, crate rests ~0.5 above it
    expect(pos[1]).toBeGreaterThan(0.8);
    expect(pos[1]).toBeLessThan(1.2);
    sim.free();
  });
});

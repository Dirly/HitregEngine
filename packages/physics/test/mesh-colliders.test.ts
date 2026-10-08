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

describe("streamed static colliders (streamStatics)", () => {
  /** A static trimesh "building" at x, its geometry a ±half quad offset in the model. */
  function building(id: string, x: number, assetId = "model.glb"): Op {
    return {
      op: "add-entity",
      id,
      entity: {
        name: id,
        parent: null,
        tags: [],
        components: {
          transform: { position: [x, 0, 0] },
          mesh: { source: { kind: "asset", assetId } },
          collider: { shape: "trimesh" },
        },
      },
    };
  }
  const down = (sim: PhysicsSim, x: number) => sim.raycast([x, 5, 1.5], [0, -1, 0], 10);

  it("defers static mesh colliders until a focus comes near, and releases them after it leaves", () => {
    const doc = scene([building("near", 0), building("far", 500)]);
    const sim = new PhysicsSim(doc, undefined, {
      meshGeometry: () => quadGeometry(2),
      streamStatics: { radius: 50, hysteresis: 10 },
    });
    expect(sim.stats()).toMatchObject({ statics: 2, staticsBuilt: 0 });
    expect(down(sim, 0)).toBeNull(); // nothing built yet
    sim.updateStatics([[0, 0, 0]]);
    expect(sim.stats().staticsBuilt).toBe(1);
    expect(down(sim, 0)?.entityId).toBe("near");
    expect(down(sim, 500)).toBeNull();
    // inside the hysteresis band: kept
    sim.updateStatics([[55, 0, 0]]);
    expect(down(sim, 0)?.entityId).toBe("near");
    // well past it: released, still registered
    sim.updateStatics([[200, 0, 0]]);
    expect(sim.stats()).toMatchObject({ statics: 2, staticsBuilt: 0, staticsReleasedTotal: 1 });
    expect(down(sim, 0)).toBeNull();
    // come back: built again
    sim.updateStatics([[0, 0, 0], [480, 0, 0]]);
    expect(down(sim, 0)?.entityId).toBe("near");
    expect(down(sim, 500)?.entityId).toBe("far");
    sim.free();
  });

  it("cooks a big trimesh in pieces across updates, to the same surface", () => {
    // a 100 x 100 quad grid over ±20 m: 20000 triangles, cooked in 40 pieces of at most 500
    const n = 100;
    const positions = new Float32Array((n + 1) * (n + 1) * 3);
    for (let j = 0; j <= n; j++) {
      for (let i = 0; i <= n; i++) positions.set([-20 + i * 0.4, 0, -20 + j * 0.4], (j * (n + 1) + i) * 3);
    }
    const indices: number[] = [];
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        const a = j * (n + 1) + i;
        indices.push(a, a + n + 1, a + 1, a + 1, a + n + 1, a + n + 2);
      }
    }
    const grid: MeshGeometryData = { positions, indices: new Uint32Array(indices) };
    const sim = new PhysicsSim(scene([building("quay", 0)]), undefined, {
      meshGeometry: () => grid,
      // a small budget: each update cooks a few pieces while the focus is not close (> radius / 4)
      streamStatics: { radius: 50, budgetMs: 0.5, pieceTriangles: 500 },
    });
    sim.updateStatics([[60, 0, 0]]);
    expect(sim.stats().staticsBuilt).toBe(0); // some pieces on, the rest to come
    expect(sim.stats().colliders).toBeGreaterThan(0);
    expect(sim.stats().colliders).toBeLessThan(40);
    for (let i = 0; i < 100 && sim.stats().staticsBuilt === 0; i++) sim.updateStatics([[60, 0, 0]]);
    expect(sim.stats()).toMatchObject({ staticsBuilt: 1, staticsBuiltTotal: 1, colliders: 40 });
    for (const [x, z] of [[-19.5, -19.5], [0.2, 0.3], [19.5, 19.5], [-19.5, 19.5], [7.7, -12.1]]) {
      const hit = sim.raycast([x!, 5, z!], [0, -1, 0], 10);
      expect(hit?.entityId).toBe("quay");
      expect(hit?.distance).toBeCloseTo(5, 4);
    }
    // a half-cooked one is released like a built one
    sim.updateStatics([[500, 0, 0]]);
    sim.updateStatics([[60, 0, 0]]);
    sim.updateStatics([[500, 0, 0]]);
    expect(sim.stats()).toMatchObject({ staticsBuilt: 0, colliders: 0 });
    // close enough that it must exist: all pieces at once
    sim.updateStatics([[0, 0, 0]]);
    expect(sim.stats()).toMatchObject({ staticsBuilt: 1, colliders: 40 });
    sim.free();
  });

  it("uses the collider's real bounds, not the entity origin (world-space baked geometry)", () => {
    // origin at 0 but the vertices sit around x=300 (a baked formation)
    const shifted: MeshGeometryData = {
      positions: new Float32Array([298, 0, -2, 302, 0, -2, 298, 0, 2, 302, 0, 2]),
      indices: new Uint32Array([0, 2, 1, 1, 2, 3]),
    };
    const sim = new PhysicsSim(scene([building("rock", 0)]), undefined, {
      meshGeometry: () => shifted,
      streamStatics: { radius: 40 },
    });
    sim.updateStatics([[0, 0, 0]]);
    expect(sim.stats().staticsBuilt).toBe(0);
    sim.updateStatics([[290, 0, 0]]);
    expect(down(sim, 300)?.entityId).toBe("rock");
    sim.free();
  });

  it("ensureStaticsAround builds at once, and removed entities leave the registry", () => {
    const sim = new PhysicsSim(scene([building("a", 0), building("b", 1000)]), undefined, {
      meshGeometry: () => quadGeometry(2),
      streamStatics: { radius: 30 },
    });
    sim.ensureStaticsAround(1000, 0);
    expect(down(sim, 1000)?.entityId).toBe("b");
    sim.removeEntities(["b", "a"]);
    expect(sim.stats()).toMatchObject({ statics: 0, staticsBuilt: 0 });
    expect(down(sim, 1000)).toBeNull();
    sim.free();
  });

  it("a moving body added later finds the statics around it already built", () => {
    const sim = new PhysicsSim(scene([building("a", 0), building("b", 1000)]), undefined, {
      meshGeometry: () => quadGeometry(2),
      streamStatics: { radius: 30 },
    });
    expect(sim.stats().staticsBuilt).toBe(0);
    sim.addEntities(scene([crate]));
    expect(sim.stats().staticsBuilt).toBe(1);
    expect(down(sim, 0)?.entityId).toBe("a");
    sim.free();
  });

  it("places async-geometry statics once their geometry arrives; dynamic bodies are never deferred", async () => {
    const sim = new PhysicsSim(scene([building("near", 0), crate]), undefined, {
      meshGeometry: () => Promise.resolve(quadGeometry(10)),
      streamStatics: { radius: 50 },
    });
    expect(sim.states().has("crate")).toBe(true);
    await Promise.resolve();
    await new Promise((r) => setTimeout(r, 0));
    sim.updateStatics([[0, 0, 0]]);
    await new Promise((r) => setTimeout(r, 0)); // the collider attaches when the provider resolves
    simulateSeconds(sim, 2);
    const pos = sim.states().get("crate")!.position;
    expect(pos[1]).toBeGreaterThan(0.3);
    expect(pos[1]).toBeLessThan(0.7);
    sim.free();
  });
});

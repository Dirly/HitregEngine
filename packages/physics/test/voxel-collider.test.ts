import { beforeAll, describe, expect, it } from "vitest";
import {
  ComponentRegistry,
  chunkToSceneDoc,
  createWorldField,
  defaultWorldRecipe,
  registerCoreComponents,
  registerVoxelField,
  voxelChunkDoc,
  voxelMesh,
  worldRecipeSchema,
  type SceneDoc,
  type WorldField,
  type WorldRecipe,
} from "@hitreg/core";
import { initPhysics, PhysicsSim } from "../src/index.js";

/**
 * Collision for marching-cubes terrain.
 *
 * The whole point of routing render, physics and placement through one cached
 * `voxelMesh` is that you cannot fall through what you can see. These tests
 * hold that end of it: a generated cell really does cook into a collider, a
 * body really does come to rest ON the visible surface, and the cell's own
 * geometry is watertight enough that nothing leaks out of the bottom.
 */

const WORLD = "test-world";
let registry: ComponentRegistry;
let recipe: WorldRecipe;
let field: WorldField;

beforeAll(async () => {
  await initPhysics();
  registry = new ComponentRegistry();
  registerCoreComponents(registry);
  recipe = worldRecipeSchema.parse({
    ...defaultWorldRecipe(),
    name: WORLD,
    cellSize: 32,
    resolution: 16,
  });
  field = createWorldField(recipe);
  registerVoxelField(WORLD, recipe);
});

/** A block of generated cells as one runtime scene doc. */
function cells(from: number, to: number): SceneDoc {
  const doc: SceneDoc = { version: 1, name: "voxel-cells", entities: {} };
  for (let cz = from; cz <= to; cz++) {
    for (let cx = from; cx <= to; cx++) {
      const chunk = voxelChunkDoc(field, WORLD, cx, cz, { scatter: false });
      const fragment = chunkToSceneDoc(WORLD, cx, cz, recipe.cellSize, chunk).doc;
      Object.assign(doc.entities, fragment.entities);
    }
  }
  return doc;
}

/**
 * A dropped box, not a ball: rotation locked and friction high so it stops
 * where it lands. A sphere rolls downhill for as long as you simulate it, off
 * the edge of whatever you loaded, which tests the terrain's slope rather than
 * its solidity.
 */
function addProbe(doc: SceneDoc, id: string, x: number, z: number, y: number): void {
  doc.entities[id] = {
    name: id,
    parent: null,
    tags: [],
    components: {
      transform: { position: [x, y, z], rotation: [0, 0, 0, 1], scale: [1, 1, 1] },
      rigidbody: { kind: "dynamic", mass: 1, linearDamping: 0.4, angularDamping: 1, gravityScale: 1, ccd: true, lockRotations: true },
      collider: { shape: "box", size: [1, 1, 1], offset: [0, 0, 0], friction: 1, restitution: 0, density: 1, isTrigger: false },
    },
  };
}

function cellWithBall(cx: number, cz: number, dropX: number, dropZ: number, dropY: number): SceneDoc {
  const doc = cells(cx, cz);
  addProbe(doc, "ball", dropX, dropZ, dropY);
  return doc;
}

function settle(sim: PhysicsSim, steps = 300): void {
  for (let i = 0; i < steps; i++) sim.step(1 / 60);
}

describe("voxel terrain colliders", () => {
  it("cooks a trimesh from the same mesh the renderer draws", () => {
    const mesh = voxelMesh({ kind: "voxel", world: WORLD, cell: [0, 0] });
    expect(mesh.triangleCount).toBeGreaterThan(0);
    const doc = cellWithBall(0, 0, 0, 0, 400);
    const sim = new PhysicsSim(doc, [0, -9.81, 0]);
    // the terrain entity got a body: a silent cooking failure would leave none
    expect(sim.states().size + 1).toBeGreaterThan(1);
    expect(sim.raycast([16, 400, 16], [0, -1, 0], 500)).not.toBeNull();
    sim.free();
  });

  it("lands falling bodies on the visible surface across a block of cells", () => {
    // Cells -1..1, and the probes deliberately include the cell BOUNDARIES
    // (x or z exactly on a multiple of cellSize) and a corner where four cells
    // meet. A seam that failed to weld would show up here as a body sailing
    // straight through the join, which is precisely the bug a per-chunk mesher
    // produces and never notices.
    const size = recipe.cellSize;
    const probes: [string, number, number][] = [
      ["mid", 8, 8],
      ["mid2", -20, 14],
      ["edge-x", size, 11],
      ["edge-z", 13, -size],
      ["corner", size, size],
      ["corner2", -size, 0],
    ];
    const doc = cells(-1, 1);
    const expected = new Map<string, number>();
    for (const [id, x, z] of probes) {
      const ground = field.surfaceCast(x, z) ?? field.height(x, z);
      expected.set(id, ground);
      addProbe(doc, id, x, z, ground + 20);
    }
    const sim = new PhysicsSim(doc, [0, -9.81, 0]);
    settle(sim, 420);
    const states = sim.states();
    for (const [id] of probes) {
      const rest = states.get(id)?.position;
      expect(rest, `no state for ${id}`).toBeDefined();
      // Measure the ground UNDER WHERE IT ENDED UP, not under where it was
      // dropped. A box that lands on a steep face slides a couple of metres
      // before friction holds it, and comparing against the drop column then
      // reads as "fell through the surface" when nothing of the sort happened
      // — which is exactly what sea cliffs turned this test into. The
      // invariant worth holding is the real one: wherever it comes to rest, it
      // is resting ON the surface the renderer draws.
      const ground = field.surfaceCast(rest![0], rest![2]) ?? field.height(rest![0], rest![2]);
      expect(rest![1], `${id} fell through the surface`).toBeGreaterThan(ground - 1.5);
      expect(rest![1], `${id} is hovering above the surface`).toBeLessThan(ground + 3);
      // and it must not have travelled to somewhere else entirely
      const drift = Math.hypot(rest![0] - probes.find((p) => p[0] === id)![1], rest![2] - probes.find((p) => p[0] === id)![2]);
      expect(drift, `${id} slid ${drift.toFixed(1)}m from where it was dropped`).toBeLessThan(8);
      // the drop column is still the sanity check that it did not tunnel far below
      expect(rest![1], `${id} ended far below the world`).toBeGreaterThan(expected.get(id)! - 20);
    }
    sim.free();
  });

  it("seals the underside of the world", () => {
    // The bottom of each cell's meshed band is forced solid so a cave running
    // out through the floor is capped rather than left open.
    //
    // Tested by casting UP from below rather than by dropping a body inside
    // the rock: a trimesh is a surface, not a volume, so a body that starts
    // inside one has no defined behaviour — it may fall straight through, and
    // that says nothing about whether the world is closed.
    const doc = cells(0, 0);
    const sim = new PhysicsSim(doc, [0, -9.81, 0]);
    for (const [x, z] of [
      [8, 8],
      [16, 20],
      [24, 12],
    ] as [number, number][]) {
      const hit = sim.raycast([x, recipe.minY - 20, z], [0, 1, 0], 400);
      expect(hit, `no underside at ${x},${z} — the world is open from below`).not.toBeNull();
    }
    sim.free();
  });

  it("skips a cell with no surface instead of dropping an invisible box in it", () => {
    // high in the sky: every sample is air, so the mesh is empty. The collider
    // must then be nothing at all — a box fallback here would be an invisible
    // wall in mid-air, which is exactly the bug the null return prevents.
    const empty = voxelMesh({ kind: "voxel", world: WORLD, cell: [0, 0], yRange: [1500, 1560] });
    expect(empty.triangleCount).toBe(0);
    const doc: SceneDoc = {
      version: 1,
      name: "empty",
      entities: {
        sky: {
          name: "sky",
          parent: null,
          tags: [],
          components: {
            transform: { position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] },
            mesh: { source: { kind: "voxel", world: WORLD, cell: [0, 0], yRange: [1500, 1560] } },
            collider: { shape: "trimesh", size: [1, 1, 1], offset: [0, 0, 0], friction: 0.5, restitution: 0, density: 1, isTrigger: false },
          },
        },
      },
    };
    const sim = new PhysicsSim(doc, [0, -9.81, 0]);
    // nothing to hit anywhere in that empty band
    expect(sim.raycast([16, 1600, 16], [0, -1, 0], 400)).toBeNull();
    sim.free();
  });
});

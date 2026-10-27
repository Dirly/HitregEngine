import assert from "node:assert/strict";
import { before, describe, it } from "node:test";
import {
  AssetLibrary,
  ComponentRegistry,
  chunkToSceneDoc,
  expandScene,
  landmarkColliderTileId,
  landmarkEntities,
  registerChunkComponents,
  registerCoreAssetTypes,
  registerCoreComponents,
  type ChunkDoc,
  type SceneDoc,
} from "@hitreg/core";
import { initPhysics, PhysicsSim, type MeshGeometryData } from "@hitreg/physics";
import { splitColliderByCell } from "../tools/_landmark-colliders.mts";
// @ts-expect-error plain JS tool module
import { boxesMesh, gltfTriangles, partColliderBoxes } from "../../../tools/wfc-3d/collider.mjs";
// @ts-expect-error plain JS tool module
import { readGltf } from "../../../tools/wfc-3d/gltf.mjs";
import { existsSync } from "node:fs";

// A REAL BODY (the kinematic character controller, 0.4 m autostep) on the colliders the tools write: the landmark
// collider streamed per map cell, and a WFC doorway part's collider from its geometry.

let registry: ComponentRegistry;
before(async () => {
  await initPhysics();
  registry = new ComponentRegistry();
  registerCoreComponents(registry);
  registerChunkComponents(registry);
});

const hero = (at: [number, number, number]): SceneDoc => ({
  version: 1,
  name: "hero",
  entities: {
    hero: { name: "hero", parent: null, tags: [], components: { transform: { position: at }, rigidbody: { kind: "kinematic", lockRotations: true }, collider: { shape: "capsule", size: [0.7, 1.8, 0.7] } } },
  },
} as SceneDoc);

function walk(sim: PhysicsSim, steps: number, desired: [number, number, number]): [number, number, number] {
  for (let i = 0; i < steps; i++) { sim.moveCharacter("hero", desired); sim.step(1 / 60); }
  return sim.states().get("hero")!.position as [number, number, number];
}

describe("a long landmark's collider streams with the body, not its origin cell", () => {
  // a 256 m ramp (landmark-local x -128..128, 6 m wide, rising 0..20 m) over NOTHING: lose the collider and you fall
  const CELL = 48, origin: [number, number, number] = [120, 50, 20], prefab = "landmarks/ramp-test";
  const positions: number[] = [], indices: number[] = [];
  for (let k = 0; k <= 128; k++) { const x = -128 + k * 2, y = ((x + 128) / 256) * 20; positions.push(x, y, -3, x, y, 3); }
  for (let k = 0; k < 128; k++) { const a = k * 2; indices.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); }
  const tiles = splitColliderByCell([{ positions, indices }], origin, CELL);
  const geometry = new Map<string, MeshGeometryData>();
  for (const t of tiles.values()) geometry.set(landmarkColliderTileId(prefab, t.cx, t.cz), { positions: Float32Array.from(t.positions), indices: Uint32Array.from(t.indices) });
  const lm = { id: "op:ramp-test:landmark", prefab, position: origin, radius: 131, digest: "t" };

  /** The cells a host holds around a body at world x (simulation ring 2), as the expanded scene physics gets. */
  function ring(x: number, z: number, exists: (id: string, kind: "prefab" | "model") => boolean): SceneDoc[] {
    const assets = new AssetLibrary();
    registerCoreAssetTypes(assets);
    assets.addPrefab(prefab, { version: 1, name: "ramp", root: "rock", entities: { rock: { name: "rock", parent: null, tags: [], components: { transform: {} } } } } as never);
    const out: SceneDoc[] = [];
    const fx = Math.floor(x / CELL), fz = Math.floor(z / CELL);
    for (let cz = fz - 2; cz <= fz + 2; cz++) for (let cx = fx - 2; cx <= fx + 2; cx++) {
      const entities: ChunkDoc["entities"] = {};
      landmarkEntities([lm], CELL, cx, cz, entities, exists);
      if (!Object.keys(entities).length) continue;
      out.push(expandScene(chunkToSceneDoc("w", cx, cz, CELL, { version: 1, entities } as ChunkDoc).doc, assets, registry));
    }
    return out;
  }

  it("the triangles are split by cell: each in its centroid's cell, a few copied over the seams only", () => {
    let n = 0;
    for (const t of tiles.values()) n += t.indices.length / 3;
    assert.ok(n >= indices.length / 3 && n <= (indices.length / 3) * 1.2, `${n} triangles in the tiles for ${indices.length / 3}`);
    assert.equal(splitColliderByCell([{ positions, indices }], origin, CELL, { margin: -1 }).size, tiles.size);
    let once = 0;
    for (const t of splitColliderByCell([{ positions, indices }], origin, CELL, { margin: -1 }).values()) once += t.indices.length / 3;
    assert.equal(once, indices.length / 3);
    assert.ok(tiles.size >= 6, `${tiles.size} tiles`);
  });

  it("a cell's own tile holds every surface over it, up to the cell line (no seam)", () => {
    // one big triangle whose centroid is in cell 0 but which covers the line x = 0 into cell -1
    const tri = { positions: [-6, 5, 0, 30, 5, -10, 30, 5, 10], indices: [0, 1, 2] };
    const t = splitColliderByCell([tri], [0, 0, 0], CELL);
    assert.ok(t.has("0_0") && t.has("-1_0") && t.has("0_-1"), [...t.keys()].join(" "));
    // the bounds keep a copy out of a cell the landmark never streams
    const kept = splitColliderByCell([tri], [0, 0, 0], CELL, { bounds: { cx0: 0, cx1: 0, cz0: -1, cz1: 0 } });
    assert.ok(!kept.has("-1_0") && kept.has("0_0"));
  });

  for (const end of [-1, 1]) {
    it(`a body at the ${end < 0 ? "foot" : "head"}, 2+ cells from the origin cell, stands on it`, () => {
      const lx = end * 124, wx = origin[0] + lx, y = origin[1] + ((lx + 128) / 256) * 20;
      assert.ok(Math.abs(Math.floor(wx / CELL) - Math.floor(origin[0] / CELL)) > 2, "the origin cell is outside the ring");
      const sim = new PhysicsSim(hero([wx, y + 1.0, origin[2]]), [0, -9.81, 0], { meshGeometry: (id) => geometry.get(id) ?? null });
      sim.configureCharacter("hero");
      for (const doc of ring(wx, origin[2], (id, kind) => kind === "prefab" || geometry.has(id))) sim.addEntities(doc);
      const p = walk(sim, 90, [0, -0.1, 0]);
      assert.ok(p[1] > y + 0.5 && p[1] < y + 1.3, `stood on the ramp: y ${p[1].toFixed(2)} vs surface ${y.toFixed(2)}`);
      sim.free();
    });
  }

  it("before tiles (the collider only in the origin cell) the same body falls through", () => {
    const lx = 124, wx = origin[0] + lx, y = origin[1] + ((lx + 128) / 256) * 20;
    const sim = new PhysicsSim(hero([wx, y + 1.0, origin[2]]), [0, -9.81, 0], { meshGeometry: (id) => geometry.get(id) ?? null });
    sim.configureCharacter("hero");
    for (const doc of ring(wx, origin[2], (_id, kind) => kind === "prefab")) sim.addEntities(doc);
    const p = walk(sim, 90, [0, -0.1, 0]);
    assert.ok(p[1] < y - 0.5, `fell: y ${p[1].toFixed(2)}`);
    sim.free();
  });
});

describe("a WFC doorway part's collider leaves its door open", () => {
  // a reed doorway on the cell's +Z edge (jambs, lintel over a 1.6 x 2.5 m opening, 0.28 m thick) on a 4 m deck slab
  const box = (min: number[], max: number[]): number[][] => {
    const c = (i: number) => [i & 1 ? max[0]! : min[0]!, i & 2 ? max[1]! : min[1]!, i & 4 ? max[2]! : min[2]!];
    const q = [[0, 1, 3, 2], [4, 6, 7, 5], [0, 4, 5, 1], [2, 3, 7, 6], [0, 2, 6, 4], [1, 5, 7, 3]];
    return q.flatMap(([a, b, cc, d]) => [[...c(a!), ...c(b!), ...c(cc!)], [...c(a!), ...c(cc!), ...c(d!)]]);
  };
  const doorTris = [...box([-2, 0, 1.71], [-0.8, 2.75, 1.99]), ...box([0.8, 0, 1.71], [2, 2.75, 1.99]), ...box([-0.8, 2.5, 1.71], [0.8, 2.75, 1.99])];
  const deckTris = box([-2, -0.12, -2], [2, 0, 6]);

  function scene(door: MeshGeometryData | "bounds"): PhysicsSim {
    const deck = boxesMesh(partColliderBoxes(deckTris)) as MeshGeometryData;
    const geometry = new Map<string, MeshGeometryData>([["deck", deck]]);
    const entities: SceneDoc["entities"] = {
      deck: { name: "deck", parent: null, tags: [], components: { transform: {}, mesh: { source: { kind: "asset", assetId: "deck" }, static: true }, collider: { shape: "trimesh" } } },
      ...hero([0, 0.95, 0]).entities,
    };
    if (door === "bounds") entities["door"] = { name: "door", parent: null, tags: [], components: { transform: {}, collider: { shape: "box", size: [3.98, 2.75, 0.28], offset: [0, 1.375, 1.85] } } };
    else {
      geometry.set("door", door);
      entities["door"] = { name: "door", parent: null, tags: [], components: { transform: {}, mesh: { source: { kind: "asset", assetId: "door" }, static: true }, collider: { shape: "trimesh" } } };
    }
    const sim = new PhysicsSim({ version: 1, name: "door", entities } as SceneDoc, [0, -9.81, 0], { meshGeometry: (id) => geometry.get(id) ?? null });
    sim.configureCharacter("hero");
    return sim;
  }

  it("a body walks through the doorway (part collider from geometry)", () => {
    const sim = scene(boxesMesh(partColliderBoxes(doorTris)) as MeshGeometryData);
    const p = walk(sim, 75, [0, -0.05, 0.06]);
    assert.ok(p[2] > 3.2, `through the door: z ${p[2].toFixed(2)}`);
    assert.ok(p[1] > 0.6 && p[1] < 1.3, `on the deck: y ${p[1].toFixed(2)}`);
    sim.free();
  });

  // the shipped stilt-village doorway (world-kit is its own repo: skipped where it is not checked out)
  const real = "projects/world-kit/authoring/stilt-village-kit/doorway-reed.glb";
  it("a body walks through the stilt-village doorway-reed part", { skip: !existsSync(real) }, () => {
    const sim = scene(boxesMesh(partColliderBoxes(gltfTriangles(readGltf(real)))) as MeshGeometryData);
    const p = walk(sim, 75, [0, -0.05, 0.06]);
    assert.ok(p[2] > 3.2, `through the door: z ${p[2].toFixed(2)}`);
    sim.free();
  });

  it("the old bounding-box collider stops it at the threshold", () => {
    const sim = scene("bounds");
    const p = walk(sim, 75, [0, -0.05, 0.06]);
    assert.ok(p[2] < 1.5, `stopped: z ${p[2].toFixed(2)}`);
    sim.free();
  });
});

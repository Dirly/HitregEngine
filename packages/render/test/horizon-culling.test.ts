import { describe, expect, it } from "vitest";
import * as THREE from "three/webgpu";
import { HorizonCuller, HorizonOccluderMap, OCCLUDED_LAYER } from "../src/horizon.js";
import { CullingSystem, cullRootsOf, cullRootIndex, registerCullRoots } from "../src/culling.js";
import { FoliageLodSystem, type InstancedPropBatch } from "../src/foliage-lod.js";
import { InstancedProps } from "../src/instancing.js";
import { batchStaticMeshes, STATIC_BATCH_FLAG } from "../src/static-batch.js";
import type { SceneDoc } from "@hitreg/core";

/**
 * A heightfield as a triangle grid over [x0, x0 + n*step] x [z0, z0 + n*step],
 * split the same way `groundAt` interpolates, so the two agree exactly.
 */
function gridMesh(height: (x: number, z: number) => number, x0: number, z0: number, n: number, step: number): THREE.BufferGeometry {
  const positions: number[] = [];
  const indices: number[] = [];
  for (let j = 0; j <= n; j++) {
    for (let i = 0; i <= n; i++) {
      const x = x0 + i * step;
      const z = z0 + j * step;
      positions.push(x, height(x, z), z);
    }
  }
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const a = j * (n + 1) + i;
      const b = a + 1;
      const c = a + (n + 1);
      const d = c + 1;
      indices.push(a, c, b, b, c, d);
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.setIndex(indices);
  return geometry;
}

/** Height of the triangulated grid at (x, z) — the surface the mesh draws. */
function groundAt(height: (x: number, z: number) => number, x: number, z: number, step: number): number {
  const i = Math.floor(x / step);
  const j = Math.floor(z / step);
  const u = x / step - i;
  const v = z / step - j;
  const h00 = height(i * step, j * step);
  const h10 = height((i + 1) * step, j * step);
  const h01 = height(i * step, (j + 1) * step);
  const h11 = height((i + 1) * step, (j + 1) * step);
  // triangles (a, c, b) and (b, c, d): the diagonal runs from b (u=1,v=0) to c (u=0,v=1)
  return u + v <= 1 ? h00 + (h10 - h00) * u + (h01 - h00) * v : h11 + (h01 - h11) * (1 - u) + (h10 - h11) * (1 - v);
}

function stampWorld(map: HorizonOccluderMap, height: (x: number, z: number) => number, size: number, cell: number, step: number): void {
  for (let cz = 0; cz < size / cell; cz++) {
    for (let cx = 0; cx < size / cell; cx++) {
      const geometry = gridMesh(height, cx * cell, cz * cell, cell / step, step);
      map.stampGeometry(geometry, new THREE.Matrix4(), {
        minX: cx * cell,
        minZ: cz * cell,
        maxX: (cx + 1) * cell,
        maxZ: (cz + 1) * cell,
      });
    }
  }
}

describe("HorizonOccluderMap", () => {
  it("keeps the lowest height under each square and forgets cleared ones", () => {
    const map = new HorizonOccluderMap(16);
    stampWorld(map, (x) => x / 10, 96, 48, 4);
    // the square [16, 32) holds ground from 1.6 to 3.2
    expect(map.lowestAt(20, 20)).toBeCloseTo(1.6, 5);
    map.clearRect(0, 0, 48, 48);
    expect(map.lowestAt(20, 20)).toBe(-Infinity);
    expect(map.lowestAt(60, 20)).toBeCloseTo(4.8, 5);
  });

  it("dilation is unknown next to an unknown square", () => {
    const map = new HorizonOccluderMap(16);
    stampWorld(map, () => 5, 48, 48, 4);
    expect(map.lowestAround(24, 24)).toBe(5);
    // (40, 24) is in the last square; its neighbour at x >= 48 is unknown
    expect(map.lowestAround(40, 24)).toBe(-Infinity);
  });

  it("does not stamp outside the rect a spilling triangle reaches", () => {
    const map = new HorizonOccluderMap(16);
    const geometry = gridMesh(() => 9, 0, 0, 1, 64); // one 64 m quad
    map.stampGeometry(geometry, new THREE.Matrix4(), { minX: 0, minZ: 0, maxX: 32, maxZ: 32 });
    expect(map.lowestAt(8, 8)).toBe(9);
    expect(map.lowestAt(40, 8)).toBe(-Infinity);
  });
});

describe("HorizonCuller", () => {
  const size = 1536;
  const ridge = (x: number): number => (x > 400 && x < 480 ? 60 : 0);

  it("hides what is behind a ridge and shows what rises above it", () => {
    const map = new HorizonOccluderMap(16);
    stampWorld(map, (x) => ridge(x), size, 48, 8);
    const horizon = new HorizonCuller(map);
    horizon.setEye(100, 2, 700);
    // a hut beyond the ridge, low: hidden
    expect(horizon.isOccluded(700, 690, 720, 10, 710)).toBe(true);
    // a tower beyond it, taller than the ridge line from here: seen
    expect(horizon.isOccluded(700, 690, 720, 200, 710)).toBe(false);
    // the same hut in front of the ridge: seen
    expect(horizon.isOccluded(300, 690, 320, 10, 710)).toBe(false);
  });

  it("never hides anything over flat ground, and nothing at all with no terrain", () => {
    const map = new HorizonOccluderMap(16);
    const empty = new HorizonCuller(map);
    empty.setEye(10, 2, 10);
    expect(empty.isOccluded(600, 600, 620, -50, 620)).toBe(false);
    stampWorld(map, () => 0, size, 48, 8);
    const flat = new HorizonCuller(map);
    flat.setEye(100, 2, 100);
    expect(flat.isOccluded(900, 900, 920, 0.5, 920)).toBe(false);
  });

  it("is conservative: every box it hides is hidden from every point on it", () => {
    // rolling hills with sharp ridges — the case a coarse horizon gets wrong
    const height = (x: number, z: number): number =>
      30 * Math.sin(x / 90) * Math.cos(z / 70) + 45 * Math.max(0, Math.sin(x / 160 + z / 230)) ** 3 + 8 * Math.sin((x + z) / 23);
    const step = 8;
    const map = new HorizonOccluderMap(16);
    stampWorld(map, height, size, 48, step);
    const horizon = new HorizonCuller(map);
    let seed = 12345;
    const random = (): number => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    let hidden = 0;
    for (let trial = 0; trial < 30; trial++) {
      const ex = 300 + random() * 900;
      const ez = 300 + random() * 900;
      const ey = groundAt(height, ex, ez, step) + 1.8 + random() * 6;
      horizon.setEye(ex, ey, ez);
      for (let b = 0; b < 60; b++) {
        const cx = 20 + random() * (size - 40);
        const cz = 20 + random() * (size - 40);
        const half = 2 + random() * 12;
        const base = groundAt(height, cx, cz, step);
        const top = base + 1 + random() * 20;
        if (!horizon.isOccluded(cx - half, cz - half, cx + half, top, cz + half)) continue;
        hidden++;
        // every sample point of the box must be blocked by the drawn ground
        for (let sx = -1; sx <= 1; sx += 0.5) {
          for (let sz = -1; sz <= 1; sz += 0.5) {
            const px = cx + sx * half;
            const pz = cz + sz * half;
            const dx = px - ex;
            const dz = pz - ez;
            const dist = Math.hypot(dx, dz);
            let blocked = false;
            for (let t = 0.5; t < dist && !blocked; t += 0.5) {
              const f = t / dist;
              const rayY = ey + (top - ey) * f;
              if (groundAt(height, ex + dx * f, ez + dz * f, step) > rayY) blocked = true;
            }
            expect(blocked, `box at ${cx.toFixed(0)},${cz.toFixed(0)} top ${top.toFixed(1)} seen from ${ex.toFixed(0)},${ez.toFixed(0)}`).toBe(true);
          }
        }
      }
    }
    // and it is not vacuous: a good share of boxes in this country are hidden
    expect(hidden).toBeGreaterThan(150);
  }, 60_000);
});

function box(name: string, x: number, y: number, z: number, h = 4): THREE.Mesh {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(4, h, 4), new THREE.MeshBasicMaterial());
  mesh.name = name;
  mesh.position.set(x, y + h / 2, z);
  return mesh;
}

function perspective(x: number, y: number, z: number, lookX: number, lookZ: number, lookY = y): THREE.PerspectiveCamera {
  const camera = new THREE.PerspectiveCamera(60, 16 / 9, 0.1, 5000);
  camera.position.set(x, y, z);
  camera.lookAt(lookX, lookY, lookZ);
  camera.updateMatrixWorld();
  return camera;
}

describe("CullingSystem", () => {
  function ridgeWorld(culling: CullingSystem): void {
    stampWorld(culling.occluders, (x) => (x > 400 && x < 480 ? 60 : 0), 1536, 48, 8);
  }

  it("moves a unit behind terrain to the occluded layer, and back", () => {
    const culling = new CullingSystem();
    ridgeWorld(culling);
    const hut = box("hut", 700, 0, 700);
    culling.register({ name: "hut", objects: [hut] });
    culling.update(perspective(100, 2, 700, 700, 700), 480);
    expect(hut.layers.mask).toBe(1 << OCCLUDED_LAYER);
    expect(culling.stats().occluded).toBe(1);
    // climb above the ridge: seen again
    culling.update(perspective(100, 400, 700, 700, 700, 0), 480);
    expect(hut.layers.mask).toBe(1);
  });

  it("keeps what is off screen as it was, and judges it again when it comes into view", () => {
    const culling = new CullingSystem();
    ridgeWorld(culling);
    const hut = box("hut", 700, 0, 700);
    culling.register({ name: "hut", objects: [hut] });
    culling.update(perspective(100, 2, 700, -500, 700), 480); // looking away
    expect(hut.layers.mask).toBe(1);
    culling.update(perspective(100, 2, 700, 700, 700), 480);
    expect(hut.layers.mask).toBe(1 << OCCLUDED_LAYER);
  });

  it("drops a unit too small on screen from every pass", () => {
    const culling = new CullingSystem();
    const crate = box("crate", 0, 0, 300, 1);
    culling.register({ name: "crate", objects: [crate], minScreenPx: 20 });
    culling.update(perspective(0, 2, 0, 0, 300), 480);
    expect(crate.layers.mask).toBe(0);
    culling.update(perspective(0, 2, 280, 0, 300), 480);
    expect(crate.layers.mask).toBe(1);
  });

  it("shows an interior only within reveal of it, and hides nested units with their parent", () => {
    const culling = new CullingSystem();
    ridgeWorld(culling);
    const shell = new THREE.Group();
    const wall = box("wall", 700, 0, 700, 8);
    const inside = new THREE.Group();
    const table = box("table", 700, 0, 700, 1);
    inside.add(table);
    shell.add(wall, inside);
    const outer = culling.register({ name: "house", objects: [shell] });
    culling.register({ name: "rooms", objects: [inside], interior: true, reveal: 10, parent: outer });
    // far from the house, on its side of the ridge: shell seen, rooms not
    culling.update(perspective(600, 2, 700, 700, 700), 480);
    expect(wall.layers.mask).toBe(1);
    expect(table.layers.mask).toBe(0);
    // at the door
    culling.update(perspective(700, 2, 690, 700, 700), 480);
    expect(table.layers.mask).toBe(1);
    // behind the ridge: both hidden, the rooms by their parent
    culling.update(perspective(100, 2, 700, 700, 700), 480);
    expect(wall.layers.mask).toBe(1 << OCCLUDED_LAYER);
    expect(table.layers.mask).not.toBe(1);
  });

  it("adopts meshes that arrive after registration (an async model load)", () => {
    const culling = new CullingSystem();
    ridgeWorld(culling);
    const hut = new THREE.Group();
    hut.add(box("floor", 700, 0, 700, 1));
    culling.register({ name: "hut", objects: [hut] });
    const camera = perspective(100, 2, 700, 700, 700);
    culling.update(camera, 480);
    const roof = box("roof", 700, 1, 700, 3);
    hut.add(roof);
    for (let n = 0; n < 3; n++) culling.update(camera, 480);
    expect(roof.layers.mask).toBe(1 << OCCLUDED_LAYER);
  });

  it("restores every layer when a unit is unregistered or culling is switched off", () => {
    const culling = new CullingSystem();
    ridgeWorld(culling);
    const hut = box("hut", 700, 0, 700);
    const unit = culling.register({ name: "hut", objects: [hut] });
    const camera = perspective(100, 2, 700, 700, 700);
    culling.update(camera, 480);
    culling.enabled = false;
    culling.update(camera, 480);
    expect(hut.layers.mask).toBe(1);
    culling.enabled = true;
    culling.update(camera, 480);
    culling.unregister(unit);
    expect(hut.layers.mask).toBe(1);
  });
});

describe("culling roots from a document", () => {
  const doc = {
    version: 1,
    name: "t",
    entities: {
      poi_camp: { name: "camp", parent: null, tags: ["poi"], components: {} },
      tent: { name: "tent", parent: "poi_camp", components: {} },
      clutter: { name: "clutter", parent: "poi_camp", components: { culling: { minScreenPx: 6 } } },
      crate: { name: "crate", parent: "clutter", components: {} },
      tree: { name: "tree", parent: null, components: {} },
    },
  } as unknown as SceneDoc;

  it("finds POI roots and culling entities, innermost first-claim", () => {
    const roots = cullRootsOf(doc);
    expect(roots.map((r) => r.id)).toEqual(["poi_camp", "clutter"]);
    expect([...roots[0]!.members].sort()).toEqual(["poi_camp", "tent"]);
    expect([...roots[1]!.members].sort()).toEqual(["clutter", "crate"]);
    expect(roots[1]!.parent).toBe("poi_camp");
    expect(roots[1]!.settings.minScreenPx).toBe(6);
    const index = cullRootIndex(roots);
    expect(index.get("crate")).toBe("clutter");
    expect(index.has("tree")).toBe(false);
  });

  it("batches each root apart and hides its merged meshes with it", () => {
    const root = new THREE.Group();
    const objects = new Map<string, THREE.Object3D>();
    for (const [id, x] of [["poi_camp", 0], ["tent", 0], ["clutter", 0], ["crate", 0], ["tree", 50]] as const) {
      const group = new THREE.Group();
      group.position.set(x, 0, 300);
      objects.set(id, group);
    }
    objects.get("poi_camp")!.add(objects.get("tent")!, objects.get("clutter")!);
    objects.get("clutter")!.add(objects.get("crate")!);
    root.add(objects.get("poi_camp")!, objects.get("tree")!);
    const material = new THREE.MeshBasicMaterial();
    for (const id of ["tent", "crate", "tree"]) {
      for (let k = 0; k < 2; k++) {
        const mesh = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.5, 0.5), material);
        mesh.userData["entityId"] = id;
        mesh.userData[STATIC_BATCH_FLAG] = true;
        objects.get(id)!.add(mesh);
      }
    }
    const roots = cullRootsOf(doc);
    const index = cullRootIndex(roots);
    const batch = batchStaticMeshes(root, { groupOf: (mesh) => index.get(mesh.userData["entityId"] as string) })!;
    expect([...batch.groups.keys()].sort()).toEqual(["clutter", "poi_camp"]);
    const culling = new CullingSystem();
    registerCullRoots(culling, roots, objects, batch);
    culling.update(perspective(0, 2, 0, 0, 300), 480);
    const clutterMerged = batch.groups.get("clutter")!.children[0]!;
    const campMerged = batch.groups.get("poi_camp")!.children[0]!;
    expect(clutterMerged.layers.mask).toBe(0); // a 6 px minimum at 300 m
    expect(campMerged.layers.mask).toBe(1);
  });
});

describe("FoliageLodSystem culling", () => {
  function batchAt(xs: number[], radius: number): InstancedPropBatch {
    const geometry = new THREE.BoxGeometry(1, 1, 1);
    const material = new THREE.MeshBasicMaterial();
    const near = new InstancedProps(geometry, material, xs.length);
    const far = new InstancedProps(geometry, material, xs.length);
    const positions = xs.map((x) => new THREE.Vector3(x, 0, 0));
    const matrices = positions.map((p) => new THREE.Matrix4().makeTranslation(p.x, p.y, p.z));
    return { near: [near], far, positions, matrices, radius };
  }

  it("draws an instance smaller than minScreenPx in no tier", () => {
    const system = new FoliageLodSystem(20, 0.85, 40, 2, 4);
    system.setProjection(480, 50);
    const batch = batchAt([10, 60, 400], 0.5);
    system.register(batch);
    // 0.5 m radius at 480 px, fov 50: 4 px at ~129 m
    expect(system.cullDistanceFor(batch)).toBeCloseTo((0.5 * 480) / (Math.tan((50 * Math.PI) / 360) * 4), 5);
    system.update(new THREE.Vector3(0, 0, 0));
    expect(system.tierCounts()).toEqual({ near: 1, mid: 0, far: 1, culled: 1 });
  });

  it("hides and reveals an instance immediately, counting nested hides", () => {
    const system = new FoliageLodSystem(20, 0.85, 40);
    const batch = batchAt([10, 60], 1);
    system.register(batch);
    system.update(new THREE.Vector3(0, 0, 0));
    system.setInstanceHidden(batch, 0, 1);
    system.setInstanceHidden(batch, 0, 1);
    expect(batch.near[0]!.instanceCount).toBe(0);
    system.setInstanceHidden(batch, 0, -1);
    expect(batch.near[0]!.instanceCount).toBe(0);
    system.setInstanceHidden(batch, 0, -1);
    expect(batch.near[0]!.instanceCount).toBe(1);
  });
});

import { afterEach, expect, it, vi } from "vitest";
import * as THREE from "three/webgpu";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { buildScene } from "../src/scene-builder.js";
import { FoliageLodSystem, type InstancedPropBatch } from "../src/foliage-lod.js";
import { InstancedPropPool } from "../src/prop-pool.js";

afterEach(() => vi.restoreAllMocks());

it("loads authored 3D far geometry, applies its local transform, and returns to the original on approach", async () => {
  const source = new THREE.Group(), proxy = new THREE.Group();
  source.add(new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial()));
  const proxyMesh = new THREE.Mesh(new THREE.BoxGeometry(4, 2, 2), new THREE.MeshBasicMaterial());
  proxyMesh.position.y = 6; proxy.add(proxyMesh);
  vi.spyOn(GLTFLoader.prototype, "loadAsync").mockImplementation(async url => ({ scene: String(url).endsWith("far") ? proxy : source, animations: [] }) as never);
  const batches: InstancedPropBatch[] = [], lod = new FoliageLodSystem(20);
  buildScene({ version: 1, name: "solid", entities: { town: { name: "town", parent: null, tags: [], components: {
    mesh: { source: { kind: "asset", assetId: "solid-near" }, renderMode: "instanced", lod: true, lodDistance: 450, lodProxy: "solid-far" },
  } } } }, { resolveModel: id => `test:${id}`, onInstancedBatch: b => { batches.push(b); lod.register(b); } });
  await vi.waitFor(() => expect(batches).toHaveLength(1));
  const batch = batches[0]!;
  expect(batch.impostor).toBeUndefined();
  expect(batch.far.geometry.getAttribute("position").getY(0)).toBeGreaterThanOrEqual(5);
  expect(batch.near[0]!.geometry.getAttribute("position").getY(0)).toBeLessThan(1);
  lod.update(new THREE.Vector3(500, 0, 0));
  expect(batch.far.instanceCount).toBe(1); expect(batch.near[0]!.instanceCount).toBe(0);
  lod.update(new THREE.Vector3(100, 0, 0));
  expect(batch.far.instanceCount).toBe(0); expect(batch.near[0]!.instanceCount).toBe(1);
});

it("keeps source geometry if an authored proxy fails to load", async () => {
  const source = new THREE.Group();
  source.add(new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial()));
  vi.spyOn(GLTFLoader.prototype, "loadAsync").mockImplementation(async url => {
    if (String(url).endsWith("missing")) throw Error("missing proxy");
    return { scene: source, animations: [] } as never;
  });
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {}), batches: InstancedPropBatch[] = [];
  const built = buildScene({ version: 1, name: "fallback", entities: { town: { name: "town", parent: null, tags: [], components: {
    mesh: { source: { kind: "asset", assetId: "fallback-near" }, renderMode: "instanced", lod: true, lodProxy: "fallback-missing" },
  } } } }, { resolveModel: id => `test:${id}`, onInstancedBatch: b => batches.push(b) });
  await vi.waitFor(() => expect(warn).toHaveBeenCalled());
  expect(batches).toHaveLength(0); // no proxy tier can replace the source
  const meshes: THREE.Object3D[] = [];
  built.scene.traverse(o => { if ((o as { isInstancedProps?: boolean }).isInstancedProps) meshes.push(o); });
  expect(meshes).toHaveLength(1);
  expect((meshes[0] as { instanceCount?: number }).instanceCount).toBe(1);
});

it("does not install a delayed authored proxy after its streamed owner unloads", async () => {
  const source = new THREE.Group();
  source.add(new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial()));
  let finish!: (value: unknown) => void;
  const delayed = new Promise(resolve => { finish = resolve; });
  let requested = false;
  vi.spyOn(GLTFLoader.prototype, "loadAsync").mockImplementation(async url => {
    if (String(url).endsWith("far")) { requested = true; return await delayed as never; }
    return { scene: source, animations: [] } as never;
  });
  const pool = new InstancedPropPool(new FoliageLodSystem()), owner = {}, batches: InstancedPropBatch[] = [];
  const built = buildScene({ version: 1, name: "unload", entities: { town: { name: "town", parent: null, tags: [], components: {
    mesh: { source: { kind: "asset", assetId: "delayed-near" }, renderMode: "instanced", lod: true, lodProxy: "delayed-far" },
  } } } }, { resolveModel: id => `test:${id}`, instancePool: pool, instancePoolOwner: owner, onInstancedBatch: b => batches.push(b) });
  await vi.waitFor(() => expect(requested).toBe(true));
  pool.release(owner); finish({ scene: source, animations: [] });
  await delayed; await new Promise(resolve => setTimeout(resolve, 0));
  expect(batches).toHaveLength(0);
  expect(pool.stats().instances).toBe(0);
  let meshCount = 0; built.scene.traverse(o => { if ((o as THREE.Mesh).isMesh) meshCount++; });
  expect(meshCount).toBe(0); pool.dispose();
});

it.each([false, true])("separates the same model's different LOD policies (pooled=%s)", async pooled => {
  const source = new THREE.Group();
  source.add(new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial()));
  vi.spyOn(GLTFLoader.prototype, "loadAsync").mockResolvedValue({ scene: source, animations: [] } as never);
  const lod = new FoliageLodSystem(20), batches: InstancedPropBatch[] = [];
  const pool = new InstancedPropPool(lod);
  const owner = {};
  const built = buildScene({ version: 1, name: "policy", entities: Object.fromEntries([20, 300].map((distance, i) => [String(i), {
    name: String(i), parent: null, tags: [], components: {
      transform: { position: [100, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] },
      mesh: { source: { kind: "asset", assetId: `policy-${pooled}` }, renderMode: "instanced", lod: true, lodDistance: distance },
    },
  }])) }, {
    resolveModel: () => `test:lod-policy-${pooled}`,
    ...(pooled ? { instancePool: pool, instancePoolOwner: owner } : {}),
    onInstancedBatch: batch => { batches.push(batch); lod.register(batch); },
  });
  await vi.waitFor(() => expect(pooled ? pool.stats().instances : batches.length).toBe(2));
  for (let i = 0; i < 11; i++) lod.update(new THREE.Vector3());
  expect(lod.tierCounts()).toMatchObject({ near: 1, far: 1 });
  if (pooled) expect(pool.stats().groups).toBe(2);
  else expect(batches.map(b => b.lodDistance).sort((a, b) => a! - b!)).toEqual([20, 300]);
  pool.dispose();
  built.scene.clear();
});

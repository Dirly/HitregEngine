import { afterEach, describe, expect, it, vi } from "vitest";
import * as THREE from "three/webgpu";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { buildScene } from "../src/scene-builder.js";
import { batchStaticMeshes, ownerOfFace, prepareStaticModel, STATIC_BATCH_FLAG } from "../src/static-batch.js";
import { isFrozenStaticSubtree } from "../src/static-transforms.js";

afterEach(() => vi.restoreAllMocks());

function prop(material: THREE.Material, id: string) {
  const entity = new THREE.Group(), model = new THREE.Group(), nested = new THREE.Group();
  model.userData["modelRoot"] = true;
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(), material);
  mesh.userData["entityId"] = id;
  nested.add(mesh); model.add(nested); entity.add(model);
  return { entity, model, mesh };
}

describe("static imported props", () => {
  it("batches late glTF arrivals, keeps source ownership, and follows edited parents after rebatching", async () => {
    const source = new THREE.Group();
    const material = new THREE.MeshBasicMaterial();
    source.add(new THREE.Mesh(new THREE.BoxGeometry(), material));
    vi.spyOn(GLTFLoader.prototype, "loadAsync").mockResolvedValue({ scene: source, animations: [] } as never);
    let done!: () => void;
    const loaded = new Promise<void>(resolve => { done = resolve; });
    const roots: THREE.Object3D[] = [];
    const built = buildScene({ version: 1, name: "static", entities: Object.fromEntries(["a", "b"].map(id => [id, {
      name: id, parent: null, tags: [], components: { mesh: { source: { kind: "asset", assetId: "box" }, static: true } },
    }])) }, { resolveModel: () => "test:static-late-arrival", onModelLoaded: (_id, root) => { roots.push(root); if (roots.length === 2) done(); } });
    expect(batchStaticMeshes(built.scene)).toBeNull(); // first build precedes load
    await loaded;
    expect(roots.every(isFrozenStaticSubtree)).toBe(true);
    const batch = batchStaticMeshes(built.scene)!;
    expect(batch.stats.merged).toBe(2);
    expect(roots.every(root => !root.visible)).toBe(true);
    const mesh = batch.group.children[0] as THREE.Mesh;
    expect(ownerOfFace(mesh, 0)).toBe("a");
    expect(ownerOfFace(mesh, 12)).toBe("b");
    batch.dispose();
    expect(roots.every(root => root.visible)).toBe(true);
    built.objects.get("a")!.position.x = 20;
    const rebuilt = batchStaticMeshes(built.scene)!;
    const bounds = new THREE.Box3().setFromObject(rebuilt.group);
    expect(bounds.max.x).toBeCloseTo(20.5);
    expect(bounds.min.x).toBeCloseTo(-0.5);
    rebuilt.dispose();
  });

  it("skips fixed descendants' matrix walks but updates them when their entity moves", () => {
    const root = new THREE.Group(), p = prop(new THREE.MeshBasicMaterial(), "p");
    root.add(p.entity); prepareStaticModel(p.model);
    const visit = vi.spyOn(p.mesh, "updateMatrixWorld");
    root.updateMatrixWorld(true); root.updateMatrixWorld(true);
    expect(visit).not.toHaveBeenCalled();
    p.entity.position.y = 7; root.updateMatrixWorld(true);
    expect(p.mesh.matrixWorld.elements[13]).toBe(7);
    expect(visit).toHaveBeenCalledTimes(1);
  });

  it("keeps model roots containing lights or unbatched parts visible and preserves hidden parts", () => {
    const root = new THREE.Group(), mat = new THREE.MeshBasicMaterial();
    const a = prop(mat, "a"), b = prop(mat, "b"); root.add(a.entity, b.entity);
    a.model.add(new THREE.PointLight());
    const hidden = new THREE.Mesh(new THREE.BoxGeometry(), mat); hidden.visible = false;
    hidden.userData["entityId"] = "hidden"; b.model.add(hidden);
    prepareStaticModel(a.model); prepareStaticModel(b.model);
    const batch = batchStaticMeshes(root)!;
    expect(batch.stats.merged).toBe(2);
    expect(a.model.visible).toBe(true); expect(b.model.visible).toBe(true);
    batch.dispose(); expect(hidden.visible).toBe(false);
  });

  it("does not flatten vertex deformation or freeze skinned model hierarchies", () => {
    const root = new THREE.Group(), mat = new THREE.MeshBasicNodeMaterial();
    Object.assign(mat, { positionNode: {} });
    for (const id of ["a", "b"]) { const p = prop(mat, id); root.add(p.entity); prepareStaticModel(p.model); }
    expect(batchStaticMeshes(root)).toBeNull();
    const skinned = new THREE.Group(); skinned.add(new THREE.SkinnedMesh(new THREE.BoxGeometry(), mat));
    prepareStaticModel(skinned);
    expect(isFrozenStaticSubtree(skinned)).toBe(false);
    expect(skinned.children[0]!.userData[STATIC_BATCH_FLAG]).toBeUndefined();
  });
});

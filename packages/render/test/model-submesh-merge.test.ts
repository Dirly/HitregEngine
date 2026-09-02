import { describe, expect, it } from "vitest";
import * as THREE from "three/webgpu";
import { mergeModelSubmeshes } from "../src/static-batch.js";

/**
 * The SET of world-space vertex positions in a subtree.
 *
 * A set, not a list: `prepForMerge` de-indexes before merging (mergeGeometries
 * cannot mix indexed and non-indexed inputs), so a merged box legitimately
 * carries 36 vertices where the indexed original carried 24. What must not
 * change is WHERE the geometry is, and that is what the distinct corners say.
 */
function worldPositions(root: THREE.Object3D): string[] {
  root.updateMatrixWorld(true);
  const out: string[] = [];
  const v = new THREE.Vector3();
  root.traverse((node) => {
    const mesh = node as THREE.Mesh;
    if (!mesh.isMesh) return;
    const pos = mesh.geometry.getAttribute("position");
    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i).applyMatrix4(mesh.matrixWorld);
      out.push(`${v.x.toFixed(3)},${v.y.toFixed(3)},${v.z.toFixed(3)}`);
    }
  });
  return [...new Set(out)].sort();
}

function countMeshes(root: THREE.Object3D): number {
  let n = 0;
  root.traverse((o) => {
    if ((o as THREE.Mesh).isMesh) n += 1;
  });
  return n;
}

describe("mergeModelSubmeshes", () => {
  it("collapses same-material submeshes without moving a single vertex", () => {
    const material = new THREE.MeshStandardMaterial();
    const root = new THREE.Group();
    // three parts at different offsets, the shape a kit-exported prop arrives in
    for (const [x, y, z] of [
      [0, 0, 0],
      [5, 1, -2],
      [-3, 0, 4],
    ]) {
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), material);
      mesh.position.set(x, y, z);
      root.add(mesh);
    }
    // a non-identity root transform is the case that catches a missing
    // world->root-local conversion
    root.position.set(10, 2, -6);
    root.scale.setScalar(2);
    root.rotation.y = Math.PI / 3;

    const before = worldPositions(root);
    expect(countMeshes(root)).toBe(3);

    mergeModelSubmeshes(root);

    expect(countMeshes(root)).toBe(1);
    const after = worldPositions(root);
    expect(after.length).toBe(before.length);

    for (let i = 0; i < after.length; i++) {
      const [ax, ay, az] = after[i]!.split(",").map(Number);
      const [bx, by, bz] = before[i]!.split(",").map(Number);
      expect(ax).toBeCloseTo(bx, 2);
      expect(ay).toBeCloseTo(by, 2);
      expect(az).toBeCloseTo(bz, 2);
    }
  });

  it("keeps different materials in separate draw calls", () => {
    const root = new THREE.Group();
    const a = new THREE.MeshStandardMaterial();
    const b = new THREE.MeshStandardMaterial();
    for (const mat of [a, a, b, b]) root.add(new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), mat));
    mergeModelSubmeshes(root);
    expect(countMeshes(root)).toBe(2);
  });

  it("refuses to merge anything when the model is skinned", () => {
    const root = new THREE.Group();
    const material = new THREE.MeshStandardMaterial();
    root.add(new THREE.Mesh(new THREE.BoxGeometry(), material));
    root.add(new THREE.Mesh(new THREE.BoxGeometry(), material));
    const skinned = new THREE.SkinnedMesh(new THREE.BoxGeometry(), material);
    root.add(skinned);
    expect(mergeModelSubmeshes(root)).toBe(0);
    expect(countMeshes(root)).toBe(3);
  });

  it("leaves a lone submesh alone rather than rebuilding it", () => {
    const root = new THREE.Group();
    const only = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial());
    root.add(only);
    mergeModelSubmeshes(root);
    expect(root.children[0]).toBe(only);
  });

  it("does not dispose the originals' geometry — it is shared with the glTF cache", () => {
    const material = new THREE.MeshStandardMaterial();
    const shared = new THREE.BoxGeometry(1, 1, 1);
    const root = new THREE.Group();
    root.add(new THREE.Mesh(shared, material));
    root.add(new THREE.Mesh(shared, material));
    mergeModelSubmeshes(root);
    // still usable by every other instance of the same model
    expect(shared.getAttribute("position")).toBeTruthy();
  });

  it("preserves shadow flags and the owning entity id", () => {
    const material = new THREE.MeshStandardMaterial();
    const root = new THREE.Group();
    for (let i = 0; i < 2; i++) {
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(), material);
      mesh.castShadow = false;
      mesh.receiveShadow = true;
      mesh.userData["entityId"] = "house";
      root.add(mesh);
    }
    mergeModelSubmeshes(root);
    const merged = root.children.find((c) => (c as THREE.Mesh).isMesh) as THREE.Mesh;
    expect(merged.castShadow).toBe(false);
    expect(merged.receiveShadow).toBe(true);
    expect(merged.userData["entityId"]).toBe("house");
  });

  it("does not merge across differing shadow flags", () => {
    const material = new THREE.MeshStandardMaterial();
    const root = new THREE.Group();
    const caster = new THREE.Mesh(new THREE.BoxGeometry(), material);
    caster.castShadow = true;
    const nonCaster = new THREE.Mesh(new THREE.BoxGeometry(), material);
    nonCaster.castShadow = false;
    root.add(caster, nonCaster);
    mergeModelSubmeshes(root);
    expect(countMeshes(root)).toBe(2);
  });
});

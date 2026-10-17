import { describe, expect, it } from "vitest";
import * as THREE from "three/webgpu";
import { batchStaticMeshes, STATIC_BATCH_FLAG } from "../src/static-batch.js";

/** A static mesh entity the batcher accepts: an entity-tagged mesh under a model root. */
function piece(root: THREE.Object3D, material: THREE.Material, id: string, x: number, ao?: number) {
  const g = new THREE.BoxGeometry();
  if (ao !== undefined) g.setAttribute("color", new THREE.BufferAttribute(new Float32Array(g.getAttribute("position").count * 3).fill(ao), 3));
  const model = new THREE.Group();
  model.userData["modelRoot"] = true;
  const mesh = new THREE.Mesh(g, material);
  mesh.userData["entityId"] = id;
  mesh.userData[STATIC_BATCH_FLAG] = true;
  model.add(mesh);
  model.position.x = x;
  root.add(model);
  return mesh;
}

describe("static batch and vertex colours (baked AO on kit pieces)", () => {
  it("merges AO-coloured pieces and keeps their colours when the material reads them", () => {
    const root = new THREE.Group();
    const material = new THREE.MeshStandardMaterial({ vertexColors: true });
    piece(root, material, "a", 0, 0.5);
    piece(root, material, "b", 3, 0.25);
    piece(root, material, "c", 6); // no colour stream: drawn white, as before
    const batch = batchStaticMeshes(root)!;
    expect(batch.stats.merged).toBe(3);
    const merged = batch.group.children[0] as THREE.Mesh;
    const color = merged.geometry.getAttribute("color");
    expect(color.itemSize).toBe(3);
    const values = new Set(Array.from(color.array as Float32Array).map((v) => +v.toFixed(2)));
    expect([...values].sort()).toEqual([0.25, 0.5, 1]);
    batch.dispose();
  });

  it("leaves a colour stream alone under a material that does not declare vertexColors (terrain tint read by its own node)", () => {
    const root = new THREE.Group();
    const material = new THREE.MeshStandardMaterial();
    piece(root, material, "a", 0, 0.5);
    piece(root, material, "b", 3, 0.5);
    expect(batchStaticMeshes(root)).toBeNull();
  });
});

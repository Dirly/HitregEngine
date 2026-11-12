import { describe, expect, it } from "vitest";
import * as THREE from "three/webgpu";
import { batchStaticMeshes, STATIC_BATCH_FLAG } from "../src/static-batch.js";

function prop(material: THREE.Material, x: number, id: string): THREE.Mesh {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), material);
  mesh.position.x = x;
  mesh.userData[STATIC_BATCH_FLAG] = true;
  mesh.userData["entityId"] = id;
  return mesh;
}

describe("keepLive (the editor's selection)", () => {
  it("leaves a kept mesh visible and moving with its node while the rest merge", () => {
    const root = new THREE.Group();
    const material = new THREE.MeshStandardMaterial();
    const kept = prop(material, 0, "bridge");
    root.add(kept, prop(material, 2, "a"), prop(material, 4, "b"));
    const batch = batchStaticMeshes(root, { keepLive: (mesh) => mesh.userData["entityId"] === "bridge" })!;
    expect(batch.stats.merged).toBe(2);
    expect(kept.visible).toBe(true);
    expect(kept.matrixWorldAutoUpdate).toBe(true); // a gizmo drag re-derives its world matrix each frame
    const owners = batch.group.children.flatMap((c) => (c.userData["batchOwners"]?.ids as string[] | undefined) ?? []);
    expect(owners).not.toContain("bridge");
    batch.dispose();
  });
});

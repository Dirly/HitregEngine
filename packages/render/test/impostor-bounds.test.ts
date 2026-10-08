import { describe, expect, it } from "vitest";
import * as THREE from "three/webgpu";
import { impostorPageBatchFor } from "../src/scene-builder.js";
import { CullingSystem } from "../src/culling.js";

describe("distant impostor bounds", () => {
  it.each([1, 2, 3])("includes every placed canopy in a %i-tree page", count => {
    const geometry = new THREE.BoxGeometry(4, 20, 4).translate(0, 10, 0);
    const source = new THREE.Group();
    const material = new THREE.MeshBasicMaterial();
    source.add(new THREE.Mesh(geometry, material));
    const matrices = Array.from({ length: count }, (_, i) =>
      new THREE.Matrix4().compose(new THREE.Vector3(500 + i * 120, 15 + i * 5, -200),
        new THREE.Quaternion(), new THREE.Vector3(2, 2, 2)));
    const result = impostorPageBatchFor([{
      assetId: `bounds-tree-${count}`, node: undefined,
      gltf: { scene: source } as never,
      submeshes: [{ geometry, material, localMatrix: new THREE.Matrix4() }], matrices,
    }], { bakeImpostor: () => ({ albedo: new THREE.Texture(), normal: new THREE.Texture(),
      grid: 6, region: { u: 0, v: 0, scale: 0.25 } }) });
    const batch = result.batches[0]!;
    const region = batch.geometry.getAttribute("impostorRegion") as THREE.InterleavedBufferAttribute;
    expect(region.isInterleavedBufferAttribute).toBe(true);
    expect(region.data).toBeInstanceOf(THREE.InstancedInterleavedBuffer);
    for (const name of ["impostorRotation", "impostorScale", "impostorRadius", "impostorCenter"]) {
      expect((batch.geometry.getAttribute(name) as THREE.InterleavedBufferAttribute).data).toBe(region.data);
    }
    // Degenerate shader vertices must not make the culler test the origin.
    expect(batch.geometry.getAttribute("position").getX(0)).toBe(0);
    const group = new THREE.Group(); group.position.set(1000, 0, 2000); group.add(batch);
    const culling = new CullingSystem();
    const unit = culling.register({ name: "trees", objects: [group] });
    for (let i = 0; i < count; i++) {
      const top = new THREE.Vector3(500 + i * 120, 55 + i * 5, -200);
      expect(batch.boundingSphere!.containsPoint(top)).toBe(true);
      top.add(group.position);
      expect(unit.box.containsPoint(top)).toBe(true);
    }
    expect(unit.box.containsPoint(new THREE.Vector3())).toBe(false);
  });
});

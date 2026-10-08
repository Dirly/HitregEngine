import { describe, expect, it } from "vitest";
import * as THREE from "three/webgpu";
import type { GLTF } from "three/addons/loaders/GLTFLoader.js";
import { FoliageLodSystem, type InstancedPropBatch } from "../src/foliage-lod.js";
import { InstancedPropPool } from "../src/prop-pool.js";
import { InstancedProps } from "../src/instancing.js";
import { impostorPageGeometry, writeImpostorSlot } from "../src/impostor.js";
import { VEGETATION_TINT_ATTRIBUTES, vegetationMaterialRole } from "../src/vegetation-tint.js";

const tintA = { bark: [0.8, 0.9, 1] as [number, number, number], leaves: [1, 0.8, 0.7] as [number, number, number] };
const tintB = { bark: [1, 0.7, 0.6] as [number, number, number], leaves: [0.7, 1, 0.8] as [number, number, number] };
function readTint(mesh: InstancedProps, slot: number): number[] {
  return VEGETATION_TINT_ATTRIBUTES.flatMap(name => {
    const attr = mesh.geometry.getAttribute(name);
    return [attr.getX(slot), attr.getY(slot), attr.getZ(slot)].map(v => +v.toFixed(4));
  });
}

describe("vegetation tint batching", () => {
  it("recognizes original unnamed materials by texture role, not cutout alpha", () => {
    const material = new THREE.MeshStandardMaterial({ alphaTest: 0.05 });
    material.map = new THREE.Texture(); material.map.name = "Bark";
    expect(vegetationMaterialRole(material)).toBe("bark");
    material.map.name = "Leaves";
    expect(vegetationMaterialRole(material)).toBe("leaves");
    material.map.name = "Stone";
    expect(vegetationMaterialRole(material)).toBeUndefined();
  });

  it("pools different bark/leaf colours together and keeps them through LOD swaps and slot reuse", () => {
    const lod = new FoliageLodSystem(20), pool = new InstancedPropPool(lod);
    lod.update(new THREE.Vector3());
    const bark = new THREE.MeshStandardMaterial(); bark.name = "Bark";
    const leaf = new THREE.MeshStandardMaterial(); leaf.name = "Leaves";
    const geometry = new THREE.BoxGeometry();
    const submeshes = [bark, leaf].map(material => ({ geometry, material, localMatrix: new THREE.Matrix4() }));
    const gltf = { scene: new THREE.Group(), animations: [] } as unknown as GLTF;
    const flags = { castShadow: true, receiveShadow: true, lod: true };
    const ownerA = {}, ownerB = {};
    pool.add("tint-test", undefined, gltf, submeshes, flags,
      [{ id: "a", matrix: new THREE.Matrix4(), vegetationTint: tintA }], ownerA, {});
    pool.add("tint-test", undefined, gltf, submeshes, flags,
      [{ id: "b", matrix: new THREE.Matrix4().makeTranslation(100, 0, 0), vegetationTint: tintB }], ownerB, {});
    expect(pool.stats()).toEqual({ groups: 1, pages: 1, instances: 2 });
    const batch = pool.group.children[0]!.userData["foliageLodBatch"] as InstancedPropBatch;
    expect(readTint(batch.near[0]!, 0)).toEqual([...tintA.bark, ...tintA.leaves]);
    expect(readTint(batch.far, 0)).toEqual([...tintB.bark, ...tintB.leaves]);
    lod.update(new THREE.Vector3(100, 0, 0));
    expect(readTint(batch.near[0]!, 0)).toEqual([...tintB.bark, ...tintB.leaves]);
    expect(readTint(batch.far, 0)).toEqual([...tintA.bark, ...tintA.leaves]);
    pool.release(ownerB);
    pool.add("tint-test", undefined, gltf, submeshes, flags,
      [{ id: "neutral", matrix: new THREE.Matrix4().makeTranslation(100, 0, 0) }], {}, {});
    expect(pool.stats()).toEqual({ groups: 1, pages: 1, instances: 2 });
    expect(readTint(batch.near[0]!, 0)).toEqual([1, 1, 1, 1, 1, 1]);
    expect(bark.userData["instanceVegetationTint"]).toBeUndefined();
    pool.dispose();
  });

  it("interleaves page metadata so role tints do not exceed the vertex buffer budget", () => {
    const geometry = impostorPageGeometry(2);
    writeImpostorSlot({ geometry }, { rotations: new Float32Array([0, 0, 0, 1]), scales: new Float32Array([2]),
      regions: new Float32Array([0.2, 0.3, 0.4]), radii: new Float32Array([5]), centers: new Float32Array([1, 2, 3]) }, 1, 0);
    const attrs = ["impostorRotation", "impostorScale", "impostorRegion", "impostorRadius", "impostorCenter"]
      .map(name => geometry.getAttribute(name) as THREE.InterleavedBufferAttribute);
    expect(new Set(attrs.map(a => a.data)).size).toBe(1);
    expect(attrs[0]!.getW(1)).toBe(1);
    expect(attrs[1]!.getX(1)).toBe(2);
    expect(attrs[2]!.getY(1)).toBeCloseTo(0.3);
    expect(attrs[3]!.getX(1)).toBe(5);
    expect(attrs[4]!.getZ(1)).toBe(3);
  });
});

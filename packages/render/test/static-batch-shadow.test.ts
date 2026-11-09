import { describe, expect, it } from "vitest";
import * as THREE from "three/webgpu";
import { batchStaticMeshes, shadowMerge, STATIC_BATCH_FLAG } from "../src/static-batch.js";
import { OCCLUDED_LAYER, SHADOW_CAMERA_LAYERS } from "../src/horizon.js";

function caster(material: THREE.Material, x: number, id: string): THREE.Mesh {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), material);
  mesh.position.x = x;
  mesh.castShadow = true;
  mesh.userData[STATIC_BATCH_FLAG] = true;
  mesh.userData["entityId"] = id;
  return mesh;
}

function meshes(root: THREE.Object3D): THREE.Mesh[] {
  const out: THREE.Mesh[] = [];
  root.traverse((o) => {
    if ((o as THREE.Mesh).isMesh) out.push(o as THREE.Mesh);
  });
  return out;
}

describe("merged shadow casters", () => {
  it("draws a unit's plain casters as one shadow-only mesh, whatever their materials", () => {
    const root = new THREE.Group();
    const a = new THREE.MeshStandardMaterial({ color: "red" });
    const b = new THREE.MeshStandardMaterial({ color: "blue" });
    for (let i = 0; i < 4; i++) root.add(caster(i % 2 ? a : b, i * 2, `e${i}`));
    const batch = batchStaticMeshes(root)!;
    const drawn = meshes(batch.group);
    const shadow = drawn.filter((m) => m.castShadow);
    expect(shadow).toHaveLength(1);
    expect(shadow[0]!.layers.mask).toBe(1 << OCCLUDED_LAYER);
    expect(shadow[0]!.layers.mask & 1).toBe(0); // the main camera never sees it
    expect(shadow[0]!.layers.mask & SHADOW_CAMERA_LAYERS).not.toBe(0);
    expect(shadow[0]!.geometry.getAttribute("position").count).toBe(4 * 36);
    expect(drawn.filter((m) => !m.castShadow)).toHaveLength(2); // the colour batches stop casting
    batch.dispose();
  });

  it("keeps cutouts and two-sided casters apart, and each culling unit its own", () => {
    const root = new THREE.Group();
    const plain = new THREE.MeshStandardMaterial();
    const plain2 = new THREE.MeshStandardMaterial();
    const cutout = new THREE.MeshStandardMaterial({ alphaTest: 0.5 });
    for (let i = 0; i < 2; i++) {
      root.add(caster(plain, i, `p${i}`));
      root.add(caster(plain2, i, `q${i}`));
      root.add(caster(cutout, i, `c${i}`));
    }
    const batch = batchStaticMeshes(root, { groupOf: (m) => ((m.userData["entityId"] as string).endsWith("0") ? "unit-a" : "unit-b") });
    // one member per bucket in each unit: nothing merges, so nothing changes
    expect(batch).toBeNull();

    const split = new THREE.Group();
    for (let i = 0; i < 4; i++) {
      split.add(caster(plain, i, `p${i}`));
      split.add(caster(plain2, i, `q${i}`));
      split.add(caster(cutout, i, `c${i}`));
    }
    const units = batchStaticMeshes(split, { groupOf: (m) => (Number((m.userData["entityId"] as string).slice(1)) < 2 ? "a" : "b") })!;
    for (const unit of units.groups.values()) {
      const shadow = meshes(unit).filter((m) => m.castShadow);
      expect(shadow).toHaveLength(2); // the merged plain shadow, and the cutout's own
      expect(shadow.some((m) => m.material === cutout)).toBe(true);
    }
    units.dispose();
  });

  it("takes in a unit's loose static meshes, and hands them back on dispose", () => {
    const root = new THREE.Group();
    const a = new THREE.MeshStandardMaterial();
    const b = new THREE.MeshStandardMaterial();
    const lone = caster(new THREE.MeshStandardMaterial(), 9, "lone");
    root.add(lone);
    for (let i = 0; i < 4; i++) root.add(caster(i % 2 ? a : b, i, `e${i}`));
    const batch = batchStaticMeshes(root)!;
    const shadow = meshes(batch.group).filter((m) => m.castShadow);
    expect(shadow).toHaveLength(1);
    expect(shadow[0]!.geometry.getAttribute("position").count).toBe(5 * 36);
    expect(lone.castShadow).toBe(false);
    // its world position came with it
    shadow[0]!.geometry.computeBoundingBox();
    expect(shadow[0]!.geometry.boundingBox!.max.x).toBeCloseTo(9.5);
    expect(lone.visible).toBe(true); // still drawn on its own in the main pass
    batch.dispose();
    expect(lone.castShadow).toBe(true);
  });

  it("can be switched off", () => {
    shadowMerge.enabled = false;
    const root = new THREE.Group();
    const a = new THREE.MeshStandardMaterial();
    const b = new THREE.MeshStandardMaterial();
    for (let i = 0; i < 4; i++) root.add(caster(i % 2 ? a : b, i, `e${i}`));
    const batch = batchStaticMeshes(root)!;
    expect(meshes(batch.group).filter((m) => m.castShadow)).toHaveLength(2);
    batch.dispose();
    shadowMerge.enabled = true;
  });
});

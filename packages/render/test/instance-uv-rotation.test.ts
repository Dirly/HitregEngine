import { describe, expect, it } from "vitest";
import * as THREE from "three/webgpu";
import {
  INSTANCE_UV_ROTATION_ATTRIBUTE,
  InstancedProps,
  applyInstanceUvRotation,
  applyInstancedProps,
  isInstanceUvRotationMaterial,
} from "../src/instancing.js";
import { FoliageLodSystem, type InstancedPropBatch } from "../src/foliage-lod.js";
import { SHARED_TEXTURE_PREFIX, shareNamedTextures } from "../src/scene-builder.js";

/**
 * Per-instance texture rotation for WFC kit floors: the angle is a side
 * attribute on the batch (so one shader serves every rotation), the material
 * wraps its stock map nodes instead of rebuilding them, LOD compaction moves
 * the angle with its instance, and identical atlases embedded in many module
 * files collapse to one texture.
 */
describe("InstancedProps uv rotation", () => {
  const base = new THREE.BoxGeometry(1, 1, 1);
  const material = new THREE.MeshStandardNodeMaterial();

  it("is absent until enabled, then a one-float instanced attribute over the capacity", () => {
    const mesh = new InstancedProps(base, material, 3);
    expect(mesh.hasUvRotation).toBe(false);
    expect(mesh.geometry.getAttribute(INSTANCE_UV_ROTATION_ATTRIBUTE)).toBeUndefined();
    mesh.enableUvRotation();
    const attr = mesh.geometry.getAttribute(INSTANCE_UV_ROTATION_ATTRIBUTE) as THREE.InstancedBufferAttribute;
    expect(attr.isInstancedBufferAttribute).toBe(true);
    expect(attr.itemSize).toBe(1);
    expect(attr.count).toBe(3);
    mesh.enableUvRotation(); // idempotent
    expect(mesh.geometry.getAttribute(INSTANCE_UV_ROTATION_ATTRIBUTE)).toBe(attr);
  });

  it("writes radians per slot and flags the upload", () => {
    const mesh = new InstancedProps(base, material, 2);
    mesh.enableUvRotation();
    const attr = mesh.geometry.getAttribute(INSTANCE_UV_ROTATION_ATTRIBUTE) as THREE.InstancedBufferAttribute;
    attr.needsUpdate = false;
    mesh.setUvRotationAt(1, Math.PI / 2);
    expect(mesh.getUvRotationAt(1)).toBeCloseTo(Math.PI / 2, 6);
    expect(mesh.getUvRotationAt(0)).toBe(0);
    expect(attr.version).toBeGreaterThan(0);
  });

  it("ignores a write before enabling instead of throwing", () => {
    const mesh = new InstancedProps(base, material, 2);
    expect(() => mesh.setUvRotationAt(0, 1)).not.toThrow();
    expect(mesh.getUvRotationAt(0)).toBe(0);
  });
});

describe("applyInstanceUvRotation", () => {
  it("wraps only the map slots the material has, once", () => {
    const m = new THREE.MeshStandardNodeMaterial();
    m.map = new THREE.Texture();
    m.normalMap = new THREE.Texture();
    applyInstancedProps(m);
    applyInstanceUvRotation(m);
    expect(isInstanceUvRotationMaterial(m)).toBe(true);
    expect(m.colorNode).not.toBeNull();
    expect(m.normalNode).not.toBeNull();
    // no such maps → those slots stay stock
    expect(m.emissiveNode).toBeNull();
    expect(m.roughnessNode).toBeNull();
    expect(m.opacityNode).toBeNull();
    const color = m.colorNode;
    applyInstanceUvRotation(m);
    expect(m.colorNode).toBe(color);
  });

  it("keeps an existing custom node by wrapping it rather than replacing it", () => {
    const m = new THREE.MeshStandardNodeMaterial();
    m.map = new THREE.Texture();
    const custom = new THREE.Node("vec4");
    m.colorNode = custom;
    applyInstanceUvRotation(m);
    expect(m.colorNode).not.toBe(custom);
    // the wrapper is a context node over the custom node
    const wrapper = m.colorNode as unknown as { node?: THREE.Node; isContextNode?: boolean };
    expect(wrapper.isContextNode).toBe(true);
    expect(wrapper.node).toBe(custom);
  });

  it("does nothing on a non-node material", () => {
    const m = new THREE.MeshStandardMaterial({ map: new THREE.Texture() });
    applyInstanceUvRotation(m);
    expect(isInstanceUvRotationMaterial(m)).toBe(false);
  });
});

describe("FoliageLodSystem keeps uv rotations with their instances", () => {
  function makeBatch(): InstancedPropBatch {
    const geometry = new THREE.BoxGeometry(1, 1, 1);
    const material = new THREE.MeshBasicNodeMaterial();
    const count = 3;
    const near = new InstancedProps(geometry, material, count);
    near.enableUvRotation();
    const far = new InstancedProps(geometry, material, count);
    const positions = [0, 50, 100].map((x) => new THREE.Vector3(x, 0, 0));
    const matrices = positions.map((p) => new THREE.Matrix4().makeTranslation(p.x, p.y, p.z));
    // instance i carries angle i (radians) so a slot's value names its instance
    return { near: [near], far, positions, matrices, uvRotations: Float32Array.from([0, 1, 2]) };
  }

  it("moves the angle through swap-compaction on the near tier", () => {
    const system = new FoliageLodSystem(20, 0.85, 40);
    const batch = makeBatch();
    system.register(batch);
    system.update(new THREE.Vector3(0, 0, 0)); // instance 0 near
    expect(batch.near[0]!.instanceCount).toBe(1);
    expect(batch.near[0]!.getUvRotationAt(0)).toBe(0);

    system.update(new THREE.Vector3(100, 0, 0)); // instance 2 near, 0 goes far
    expect(batch.near[0]!.instanceCount).toBe(1);
    // slot 0 of the near buffer now belongs to instance 2 — angle 2, not stale 0
    expect(batch.near[0]!.getUvRotationAt(0)).toBe(2);
  });
});

describe("shareNamedTextures", () => {
  const shared = (name: string) => {
    const t = new THREE.Texture();
    t.name = name;
    return t;
  };
  const model = (map: THREE.Texture, other?: THREE.Texture) => {
    const root = new THREE.Group();
    root.add(new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial({ map, emissiveMap: other ?? null })));
    return root;
  };

  it("keeps the first texture under a shared name and re-points later copies to it", () => {
    const name = `${SHARED_TEXTURE_PREFIX}test-${Math.random()}`;
    const first = shared(name);
    const a = model(first);
    expect(shareNamedTextures(a)).toBe(0);

    const second = shared(name);
    let disposed = false;
    second.addEventListener("dispose", () => (disposed = true));
    const b = model(second, second);
    expect(shareNamedTextures(b)).toBe(2);
    const material = (b.children[0] as THREE.Mesh).material as THREE.MeshStandardMaterial;
    expect(material.map).toBe(first);
    expect(material.emissiveMap).toBe(first);
    expect(disposed).toBe(true);
  });

  it("leaves unprefixed textures alone even when names collide", () => {
    const plainA = shared("atlas.png");
    const plainB = shared("atlas.png");
    shareNamedTextures(model(plainA));
    const b = model(plainB);
    expect(shareNamedTextures(b)).toBe(0);
    expect(((b.children[0] as THREE.Mesh).material as THREE.MeshStandardMaterial).map).toBe(plainB);
  });
});

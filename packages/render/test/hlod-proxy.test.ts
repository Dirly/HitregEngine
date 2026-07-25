import { describe, expect, it, vi } from "vitest";
import * as THREE from "three/webgpu";
import type { SceneDoc } from "@hitreg/core";
import type { BuildOptions } from "../src/scene-builder.js";

// A fake loaded glTF: one box submesh, used to exercise the merge path
// without a real GLTFLoader/fetch round-trip. loadGltf is the only piece of
// scene-builder.ts that touches the network, so it's the only export mocked
// here — everything else (extractGltfSubmeshes, cachedInstancedMaterial,
// materialForId, ...) runs for real.
const fakeGltfScene = new THREE.Group();
const fakeMesh = new THREE.Mesh(
  new THREE.BoxGeometry(2, 2, 2),
  new THREE.MeshStandardMaterial({ color: 0x00ff00 }),
);
fakeGltfScene.add(fakeMesh);

vi.mock("../src/scene-builder.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/scene-builder.js")>();
  return { ...actual, loadGltf: vi.fn(async () => ({ scene: fakeGltfScene }) as any) };
});

const { buildHlodProxy } = await import("../src/hlod-proxy.js");

const IDENTITY = {
  rotation: [0, 0, 0, 1] as [number, number, number, number],
  scale: [1, 1, 1] as [number, number, number],
};

function box(position: [number, number, number], material?: string): SceneDoc["entities"][string] {
  return {
    name: "Box",
    parent: null,
    tags: ["hlod"],
    components: {
      transform: { position, ...IDENTITY },
      mesh: { source: { kind: "primitive", shape: "box", size: [2, 2, 2] }, ...(material ? { material } : {}) },
    },
  };
}

function tree(position: [number, number, number], assetId = "tree"): SceneDoc["entities"][string] {
  return {
    name: "Tree",
    parent: null,
    tags: ["hlod"],
    components: {
      transform: { position, ...IDENTITY },
      mesh: { source: { kind: "asset", assetId }, castShadow: true, receiveShadow: true },
    },
  };
}

function doc(entities: SceneDoc["entities"]): SceneDoc {
  return { version: 1, name: "hlod", entities };
}

const materials: BuildOptions = {
  resolveMaterial: (id) =>
    id === "red"
      ? { shader: "standard", color: "#ff0000", repeat: [1, 1], roughness: 0.8, metalness: 0, emissive: "#000000", emissiveIntensity: 1, opacity: 1, transparent: false }
      : { shader: "standard", color: "#00ff00", repeat: [1, 1], roughness: 0.8, metalness: 0, emissive: "#000000", emissiveIntensity: 1, opacity: 1, transparent: false },
};

describe("HLOD proxy merge", () => {
  it("merges same-material meshes into one draw call", async () => {
    const proxy = await buildHlodProxy(doc({ a: box([0, 0, 0], "red"), b: box([10, 0, 0], "red") }), materials);
    expect(proxy.stats).toEqual({ mergedDrawCalls: 1, mergedSources: 2, deferred: 0 });
    const meshes = proxy.group.children.filter((c) => (c as THREE.Mesh).isMesh);
    expect(meshes.length).toBe(1);
    // two non-indexed boxes = 36 + 36 vertices
    const merged = meshes[0] as THREE.Mesh;
    expect(merged.geometry.getAttribute("position").count).toBe(72);
  });

  it("keeps distinct materials as separate draw calls", async () => {
    const proxy = await buildHlodProxy(doc({ a: box([0, 0, 0], "red"), b: box([4, 0, 0], "green") }), materials);
    expect(proxy.stats.mergedDrawCalls).toBe(2);
    expect(proxy.stats.mergedSources).toBe(2);
  });

  it("bakes entity transforms into the merged geometry", async () => {
    const proxy = await buildHlodProxy(doc({ a: box([20, 0, 0], "red") }), materials);
    const merged = proxy.group.children.find((c) => (c as THREE.Mesh).isMesh) as THREE.Mesh;
    merged.geometry.computeBoundingBox();
    const center = new THREE.Vector3();
    merged.geometry.boundingBox!.getCenter(center);
    // a size-2 box centered at x=20 -> geometry spans [19,21]
    expect(center.x).toBeCloseTo(20, 5);
    expect(merged.geometry.boundingBox!.min.x).toBeCloseTo(19, 5);
    expect(merged.geometry.boundingBox!.max.x).toBeCloseTo(21, 5);
  });

  it("defers asset (glTF) meshes with no resolvable model URL", async () => {
    const withAsset = doc({ a: box([0, 0, 0], "red"), t: tree([5, 0, 0]) });
    // no resolveModel in `materials` -> the deferred build warns but still produces a group
    const proxy = await buildHlodProxy(withAsset, materials);
    expect(proxy.stats.mergedDrawCalls).toBe(1); // the box
    expect(proxy.stats.mergedSources).toBe(1);
    expect(proxy.stats.deferred).toBe(1); // the tree
    // group holds the merged box mesh + the deferred sub-scene group
    expect(proxy.group.children.some((c) => c.type === "Scene")).toBe(true);
  });

  it("merges glTF submeshes into a real draw call when a model resolves", async () => {
    const withAsset = doc({ a: tree([0, 0, 0]), b: tree([10, 0, 0]) });
    const proxy = await buildHlodProxy(withAsset, { ...materials, resolveModel: () => "fake://tree.glb" });
    expect(proxy.stats.deferred).toBe(0);
    expect(proxy.stats.mergedDrawCalls).toBe(1); // one submesh bucket, two placements
    expect(proxy.stats.mergedSources).toBe(2);
    const merged = proxy.group.children.find((c) => (c as THREE.Mesh).isMesh) as THREE.Mesh;
    // two non-indexed boxes (the fake glTF's single box submesh) = 36 + 36 vertices
    expect(merged.geometry.getAttribute("position").count).toBe(72);
  });

  it("merges primitives with and without uvs (wedge next to box) without crashing", async () => {
    const mixed = doc({
      b: box([0, 0, 0], "red"),
      w: {
        name: "Wedge",
        parent: null,
        tags: ["hlod"],
        components: {
          transform: { position: [3, 0, 0], ...IDENTITY },
          mesh: { source: { kind: "primitive", shape: "wedge", size: [2, 2, 2] }, material: "red" },
        },
      },
    });
    const proxy = await buildHlodProxy(mixed, materials);
    expect(proxy.stats.mergedDrawCalls).toBe(1);
    expect(proxy.stats.mergedSources).toBe(2);
  });
});

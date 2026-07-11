import { describe, expect, it } from "vitest";
import * as THREE from "three/webgpu";
import type { SceneDoc } from "@hitreg/core";
import { buildHlodProxy } from "../src/hlod-proxy.js";
import type { BuildOptions } from "../src/scene-builder.js";

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
  it("merges same-material meshes into one draw call", () => {
    const proxy = buildHlodProxy(doc({ a: box([0, 0, 0], "red"), b: box([10, 0, 0], "red") }), materials);
    expect(proxy.stats).toEqual({ mergedDrawCalls: 1, mergedSources: 2, deferred: 0 });
    const meshes = proxy.group.children.filter((c) => (c as THREE.Mesh).isMesh);
    expect(meshes.length).toBe(1);
    // two non-indexed boxes = 36 + 36 vertices
    const merged = meshes[0] as THREE.Mesh;
    expect(merged.geometry.getAttribute("position").count).toBe(72);
  });

  it("keeps distinct materials as separate draw calls", () => {
    const proxy = buildHlodProxy(doc({ a: box([0, 0, 0], "red"), b: box([4, 0, 0], "green") }), materials);
    expect(proxy.stats.mergedDrawCalls).toBe(2);
    expect(proxy.stats.mergedSources).toBe(2);
  });

  it("bakes entity transforms into the merged geometry", () => {
    const proxy = buildHlodProxy(doc({ a: box([20, 0, 0], "red") }), materials);
    const merged = proxy.group.children.find((c) => (c as THREE.Mesh).isMesh) as THREE.Mesh;
    merged.geometry.computeBoundingBox();
    const center = new THREE.Vector3();
    merged.geometry.boundingBox!.getCenter(center);
    // a size-2 box centered at x=20 -> geometry spans [19,21]
    expect(center.x).toBeCloseTo(20, 5);
    expect(merged.geometry.boundingBox!.min.x).toBeCloseTo(19, 5);
    expect(merged.geometry.boundingBox!.max.x).toBeCloseTo(21, 5);
  });

  it("defers asset (glTF) meshes to the normal build path instead of merging", () => {
    const withAsset = doc({
      a: box([0, 0, 0], "red"),
      tree: {
        name: "Tree",
        parent: null,
        tags: ["hlod"],
        components: {
          transform: { position: [5, 0, 0], ...IDENTITY },
          mesh: { source: { kind: "asset", assetId: "tree" }, castShadow: true, receiveShadow: true },
        },
      },
    });
    // resolveModel returns undefined -> the deferred build warns but still produces a group
    const proxy = buildHlodProxy(withAsset, materials);
    expect(proxy.stats.mergedDrawCalls).toBe(1); // the box
    expect(proxy.stats.mergedSources).toBe(1);
    expect(proxy.stats.deferred).toBe(1); // the tree
    // group holds the merged box mesh + the deferred sub-scene group
    expect(proxy.group.children.some((c) => c.type === "Scene")).toBe(true);
  });

  it("merges primitives with and without uvs (wedge next to box) without crashing", () => {
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
    const proxy = buildHlodProxy(mixed, materials);
    expect(proxy.stats.mergedDrawCalls).toBe(1);
    expect(proxy.stats.mergedSources).toBe(2);
  });
});

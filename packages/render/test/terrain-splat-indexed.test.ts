import { describe, expect, it } from "vitest";
import * as THREE from "three/webgpu";
import type { VoxelMesh } from "@hitreg/core";
import { voxelGeometryFromMesh } from "../src/voxel-geometry.js";
import { buildTerrainSplatMaterial, SPLAT_ATTRIBUTES, SPLAT_INDEX_ATTRIBUTE, SPLAT_TOP_ATTRIBUTE } from "../src/terrain-splat.js";
import type { MaterialData } from "../src/scene-builder.js";

function mesh(indexed: boolean): VoxelMesh {
  return {
    positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 0, 1]),
    normals: new Float32Array([0, 1, 0, 0, 1, 0, 0, 1, 0]),
    indices: new Uint32Array([0, 1, 2]),
    splat: new Float32Array(3 * 20).map((_, i) => (i % 20 === 17 ? 1 : 0)),
    surfaceCount: 20,
    tint: new Float32Array(9).fill(1),
    min: [0, 0, 0],
    max: [1, 0, 1],
    vertexCount: 3,
    triangleCount: 1,
    ...(indexed
      ? {
          layerIndex: Uint8Array.from([17, 255, 255, 255, 17, 255, 255, 255, 17, 255, 255, 255]),
          layerWeight: Uint8Array.from([255, 0, 0, 0, 255, 0, 0, 0, 255, 0, 0, 0]),
        }
      : {}),
  };
}

describe("indexed terrain splat", () => {
  it("an indexed mesh carries two unorm8 vec4 attributes and no dense weights", () => {
    const geometry = voxelGeometryFromMesh(mesh(true))!;
    const ids = geometry.getAttribute(SPLAT_INDEX_ATTRIBUTE) as THREE.BufferAttribute;
    const top = geometry.getAttribute(SPLAT_TOP_ATTRIBUTE) as THREE.BufferAttribute;
    expect(ids.itemSize).toBe(4);
    expect(ids.normalized).toBe(true);
    expect(ids.array).toBeInstanceOf(Uint8Array);
    // what the shader recovers: round(unorm * 255) is the id
    expect(Math.round(ids.getX(0) * 255)).toBe(17);
    expect(top.normalized).toBe(true);
    for (const name of SPLAT_ATTRIBUTES) expect(geometry.getAttribute(name)).toBeUndefined();
  });

  it("a dense mesh keeps its vec4 weights (unchanged path)", () => {
    const geometry = voxelGeometryFromMesh(mesh(false))!;
    expect(geometry.getAttribute(SPLAT_INDEX_ATTRIBUTE)).toBeUndefined();
    expect(geometry.getAttribute(SPLAT_ATTRIBUTES[0])).toBeDefined();
    expect(geometry.getAttribute(SPLAT_ATTRIBUTES[3])).toBeDefined();
  });

  it("builds an indexed material graph for a 20-layer palette", () => {
    const layers = Array.from({ length: 20 }, (_, i) => ({
      color: i % 2 ? "#ffffff" : "#80a060",
      roughness: 0.9,
      heightStart: 0,
      heightEnd: 1,
      uvScale: 2 + i,
    }));
    const data = {
      shader: "terrain-splat",
      color: "#ffffff",
      roughness: 0.9,
      opacity: 1,
      transparent: false,
      splat: { source: "indexed", tintByVertexColor: true, layers },
    } as unknown as MaterialData;
    const material = buildTerrainSplatMaterial(data);
    expect(material.colorNode).toBeTruthy();
    expect(material.roughnessNode).toBeTruthy();
    expect(material.normalNode ?? null).toBeNull();
  });
});

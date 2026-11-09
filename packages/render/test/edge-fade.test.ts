import { describe, expect, it } from "vitest";
import * as THREE from "three/webgpu";
import { materialSchema } from "@hitreg/core";
import { edgeFadeCoverage } from "../src/edge-fade.js";
import { makeMaterial, patchMaterial, type MaterialData } from "../src/scene-builder.js";
import { materialUniformsOf, wireMaterialMaps } from "../src/material-maps.js";
import { batchStaticMeshes, mergeModelSubmeshes, prepareStaticModel } from "../src/static-batch.js";

const data = (extra: Record<string, unknown> = {}): MaterialData => materialSchema.parse(extra);

describe("whole-sheet perimeter fade", () => {
  it("leaves legacy materials and depth behavior unchanged", () => {
    const parsed = materialSchema.parse({});
    expect(parsed).not.toHaveProperty("edgeFade");
    expect(parsed).not.toHaveProperty("depthWrite");
    const material = makeMaterial(parsed) as THREE.MeshStandardNodeMaterial;
    expect(material.depthWrite).toBe(true);
    expect(material.opacityNode).toBeNull();
  });

  it("describes and validates separate coverage coordinates", () => {
    expect(materialSchema.parse({ edgeFade: {} }).edgeFade).toEqual({
      shape: "quad", width: [0.08, 0.15], noise: 0.25, noiseScale: 8, power: 1.2, uvChannel: 1,
    });
    for (const edgeFade of [{ width: [0, 0.1] }, { width: [0.1, -1] }, { uvChannel: 2 }, { power: 0 }, { noise: 2 }]) {
      expect(materialSchema.safeParse({ edgeFade }).success).toBe(false);
    }
  });

  it("fades the outer rectangle without a seam on the internal triangle diagonal", () => {
    for (const point of [[0, 0.5], [1, 0.5], [0.5, 0], [0.5, 1]] as const) {
      expect(edgeFadeCoverage(point)).toBe(0);
    }
    expect(edgeFadeCoverage([0.35, 0.65])).toBe(1);
    expect(edgeFadeCoverage([0.5, 0.5])).toBe(1);
    expect(edgeFadeCoverage([0.02, 0.5], { noise: 0 })).toBeGreaterThan(0);
    expect(edgeFadeCoverage([0.02, 0.5], { noise: 0 })).toBeLessThan(1);
    expect(edgeFadeCoverage([0.02, 0.02], { noise: 0 })).toBeLessThan(edgeFadeCoverage([0.02, 0.5], { noise: 0 }));
  });

  it("also fades all three outer edges of a triangular sheet", () => {
    const options = { shape: "triangle" as const };
    expect(edgeFadeCoverage([0, 0.4], options)).toBe(0);
    expect(edgeFadeCoverage([0.4, 0], options)).toBe(0);
    expect(edgeFadeCoverage([0.5, 0.5], options)).toBe(0);
    expect(edgeFadeCoverage([0.25, 0.25], options)).toBe(1);
    expect(edgeFadeCoverage([0.8, 0.8], options)).toBe(0);
  });

  it("patches tiled-map transforms, transparency and fade uniforms without rebuilding the shader", () => {
    const initial = data({ map: "silk.png", transparent: true, opacity: 0.35, depthWrite: false, edgeFade: {} });
    const material = makeMaterial(initial) as THREE.MeshStandardNodeMaterial;
    const graph = material.opacityNode, version = material.version;
    expect(graph).toBeTruthy();
    expect(material.depthWrite).toBe(false);
    expect(patchMaterial(material, data({ ...initial, repeat: [8, 3], opacity: 0.25,
      edgeFade: { width: [0.12, 0.22], noise: 0.6, noiseScale: 5, power: 2 } }))).toBe(true);
    expect(material.opacityNode).toBe(graph);
    expect(material.version).toBe(version);
    const uniforms = materialUniformsOf(material)!;
    expect(uniforms.uvTransform.value.toArray()).toEqual([8, 3, 0, 0]);
    expect(uniforms.edgeFadeSettings.value.toArray()).toEqual([0.12, 0.22, 0.6, 5]);
    expect(uniforms.edgeFadePower.value).toBe(2);
    expect(uniforms.opacity.value).toBe(0.25);
    expect(patchMaterial(material, data({ ...initial, edgeFade: { shape: "triangle" } }))).toBe(false);
    expect(patchMaterial(material, data({ ...initial, edgeFade: { uvChannel: 0 } }))).toBe(false);
    expect(patchMaterial(material, data({ ...initial, edgeFade: undefined }))).toBe(false);
  });

  it("retains fade composition when RGBA and greyscale opacity maps arrive", () => {
    const settings = data({ map: "silk.png", alphaMap: "mask.png", edgeFade: {}, opacity: 0.3, transparent: true, depthWrite: false });
    const material = makeMaterial(settings) as THREE.MeshStandardNodeMaterial;
    const before = material.opacityNode;
    const map = new THREE.DataTexture(new Uint8Array([140, 140, 130, 100]), 1, 1);
    const alphaMap = new THREE.DataTexture(new Uint8Array([128, 128, 128, 255]), 1, 1);
    wireMaterialMaps(material, settings, { map, alphaMap });
    expect(material.colorNode).toBeTruthy();
    expect(material.opacityNode).toBeTruthy();
    expect(material.opacityNode).not.toBe(before);
    const wired = material.opacityNode;
    expect(patchMaterial(material, data({ ...settings, opacity: 0.2 }))).toBe(true);
    expect(material.opacityNode).toBe(wired);
    expect(materialUniformsOf(material)!.opacity.value).toBe(0.2);
    expect(material.depthWrite).toBe(false);
  });

  it("keeps coverage UVs through model loading and static batching by excluding custom streams", () => {
    const root = new THREE.Group(), silk = makeMaterial(data({ edgeFade: {}, opacity: 0.3, depthWrite: false }));
    const meshes: THREE.Mesh[] = [];
    for (let i = 0; i < 2; i++) {
      const geometry = new THREE.PlaneGeometry(10, 4, 4, 2);
      geometry.setAttribute("uv1", geometry.getAttribute("uv").clone());
      const mesh = new THREE.Mesh(geometry, silk);
      mesh.userData.entityId = "silk-" + i;
      meshes.push(mesh); root.add(mesh);
    }
    const coverage = meshes[0]!.geometry.getAttribute("uv1");
    expect(mergeModelSubmeshes(root)).toBe(0);
    prepareStaticModel(root);
    expect(batchStaticMeshes(root)).toBeNull();
    expect(meshes.every(mesh => mesh.visible)).toBe(true);
    expect(meshes[0]!.geometry.getAttribute("uv1")).toBe(coverage);
    expect(coverage.count).toBe(meshes[0]!.geometry.getAttribute("position").count);
  });
});

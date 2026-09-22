import { describe, expect, it } from "vitest";
import type * as THREE from "three/webgpu";
import { makeMaterial, patchMaterial, type MaterialData } from "../src/scene-builder.js";
import { materialMapKey, materialUniformsOf } from "../src/material-maps.js";

const OVERLAY: NonNullable<MaterialData["overlay"]> = {
  color: "#ff8a1e",
  opacity: 0.8,
  scale: 3,
  speed: [0.04, 0.1],
  threshold: 0.3,
  mask: "map",
  maskStrength: 0.5,
  maskCutoff: 0.4,
  pixel: 64,
  steps: 4,
  frameRate: 12,
};

function data(over: Partial<MaterialData> = {}): MaterialData {
  return {
    shader: "unlit",
    color: "#ffffff",
    repeat: [1, 1],
    roughness: 0.85,
    metalness: 0.05,
    emissive: "#000000",
    emissiveIntensity: 1,
    opacity: 1,
    transparent: false,
    ...over,
  };
}

const emissiveOf = (m: THREE.Material): unknown => (m as { emissiveNode?: unknown }).emissiveNode;

describe("material overlay", () => {
  it("puts its numbers in uniforms and its presence and mask in the structural key", () => {
    const material = makeMaterial(data({ overlay: OVERLAY }));
    expect(emissiveOf(material)).toBeTruthy();
    const u = materialUniformsOf(material)!;
    expect(u.overlayA.value.toArray()).toEqual([0.8, 3, 0.3, 64]);
    expect(u.overlayB.value.toArray()).toEqual([0.04, 0.1, 12, 4]);
    expect(u.overlayMask.value).toBe(0.5);
    expect(u.overlayCutoff.value).toBe(0.4);
    expect(materialMapKey(data())).not.toBe(materialMapKey(data({ overlay: OVERLAY })));
    expect(materialMapKey(data({ overlay: OVERLAY }))).not.toBe(materialMapKey(data({ overlay: { ...OVERLAY, mask: "none" } })));
  });

  it("patches a live tweak in place, and rebuilds when the overlay goes away", () => {
    const material = makeMaterial(data({ overlay: OVERLAY }));
    expect(patchMaterial(material, data({ overlay: { ...OVERLAY, opacity: 2, speed: [0, 0.3] } }))).toBe(true);
    expect(materialUniformsOf(material)!.overlayA.value.x).toBe(2);
    expect(materialUniformsOf(material)!.overlayB.value.y).toBe(0.3);
    expect(patchMaterial(material, data())).toBe(false);
  });

  it("works on lit shaders too, and leaves materials without one alone", () => {
    expect(emissiveOf(makeMaterial(data({ shader: "standard", overlay: OVERLAY })))).toBeTruthy();
    expect(emissiveOf(makeMaterial(data({ shader: "toon", overlay: OVERLAY })))).toBeTruthy();
    expect(emissiveOf(makeMaterial(data({ shader: "standard" })))).toBeFalsy();
  });
});

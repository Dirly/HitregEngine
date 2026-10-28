import { describe, expect, it } from "vitest";
import * as THREE from "three/webgpu";
import type { SceneDoc } from "@hitreg/core";
import { fogFactor, type FogSettings } from "../src/atmosphere.js";
import { CullingSystem, cullRootsOf, registerCullRoots } from "../src/culling.js";
import { applyAdditiveFog } from "../src/additive-fog.js";
import {
  LANDMARK_MIN_FOG_SHARE,
  applyLandmarkFog,
  landmarkFogFactor,
  landmarkFogMaterial,
  landmarkFogSource,
  landmarkFogTone,
  landmarkFogVariantCount,
} from "../src/landmark-fog.js";

/** Drownmere-like: dense height fog that hides the ground by ~200 m. */
const DROWNMERE: FogSettings = { color: "#5a605e", mode: "height", near: 40, far: 180, density: 0.016, heightFalloff: 0.004, baseHeight: 0 };
const LANDMARK = { fogReach: 600, silhouette: 0.6 };

describe("landmark fog curve", () => {
  it("reads far past the zone fog: hidden ground at 250 m, a landmark well short of opaque", () => {
    const ground = fogFactor(DROWNMERE, 250, 10, 10);
    expect(ground).toBeGreaterThan(0.97);
    const lm = landmarkFogFactor(ground, 250, LANDMARK);
    expect(lm.factor).toBeLessThan(0.8);
    expect(lm.factor).toBeGreaterThan(0.5); // still IN the atmosphere
  });

  it("never more fog than the ground, never less than the minimum share of it", () => {
    for (const d of [5, 40, 120, 300, 450]) {
      for (const density of [0.0005, 0.004, 0.016, 0.05]) {
        const base = fogFactor({ ...DROWNMERE, density }, d, 10, 10);
        const { factor } = landmarkFogFactor(base, d, LANDMARK);
        if (d < LANDMARK.fogReach * 0.8) expect(factor).toBeLessThanOrEqual(base + 1e-9);
        const tauBase = -Math.log(Math.max(1e-4, 1 - base));
        const tauL = -Math.log(1 - factor);
        expect(tauL).toBeGreaterThanOrEqual(LANDMARK_MIN_FOG_SHARE * tauBase - 1e-9);
      }
    }
  });

  it("thin air: the landmark fogs exactly like the ground", () => {
    const base = fogFactor({ ...DROWNMERE, density: 0.0005, heightFalloff: 0 }, 100);
    expect(landmarkFogFactor(base, 100, LANDMARK).factor).toBeCloseTo(base, 9);
  });

  it("is gone at fogReach and monotone on the way", () => {
    let last = 0;
    for (let d = 0; d <= 700; d += 10) {
      const { factor } = landmarkFogFactor(fogFactor(DROWNMERE, d, 10, 10), d, LANDMARK);
      expect(factor).toBeGreaterThanOrEqual(last - 1e-9);
      last = factor;
    }
    expect(landmarkFogFactor(1, 600, LANDMARK).factor).toBeCloseTo(1, 6);
  });

  it("silhouette darkens the tone mid-range and dissolves into the fog colour at the reach", () => {
    const fog = new THREE.Color("#5a605e");
    const mid = landmarkFogFactor(0.99, 300, LANDMARK).tone;
    expect(mid).toBeCloseTo(0.6, 6);
    // silhouette 0.6 of the 40 % maximum darkening: 24 % under the fog colour (a darker shape, never a cutout)
    expect(landmarkFogTone(fog, mid).r).toBeCloseTo(fog.r * 0.76, 5);
    expect(landmarkFogFactor(0.99, 600, LANDMARK).tone).toBe(0);
    expect(landmarkFogFactor(0.99, 300, { fogReach: 600, silhouette: 0 }).tone).toBe(0);
  });
});

describe("landmark fog variants", () => {
  it("one cached variant per material and quantised settings; round-trips to the source", () => {
    const source = new THREE.MeshStandardNodeMaterial({ color: 0x888888 });
    const before = landmarkFogVariantCount();
    const a = landmarkFogMaterial(source, LANDMARK);
    expect(a).not.toBe(source);
    expect(landmarkFogMaterial(source, { fogReach: 610, silhouette: 0.61 })).toBe(a); // same 25 m / 0.05 bucket
    expect(landmarkFogMaterial(a, LANDMARK)).toBe(a); // a variant of a variant is the variant
    expect(landmarkFogVariantCount()).toBe(before + 1);
    expect(landmarkFogSource(a)).toBe(source);
    expect(a.customProgramCacheKey()).not.toBe(source.customProgramCacheKey());
    const off = new THREE.MeshBasicNodeMaterial();
    off.fog = false;
    expect(landmarkFogMaterial(off, LANDMARK)).toBe(off);
    const glow = new THREE.MeshBasicNodeMaterial({ blending: THREE.AdditiveBlending, transparent: true });
    applyAdditiveFog(glow);
    // A window card on a landmark must retain extinction-only fog, rather
    // than gaining the landmark's darker fog-colour sheet over its rectangle.
    expect(landmarkFogMaterial(glow, LANDMARK)).toBe(glow);
  });

  it("swaps a mesh's material reference only (arrays too) and restores it", () => {
    const m1 = new THREE.MeshStandardNodeMaterial();
    const m2 = new THREE.MeshStandardNodeMaterial();
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(), [m1, m2]);
    applyLandmarkFog(mesh, LANDMARK);
    const swapped = mesh.material as THREE.Material[];
    expect(swapped[0]).toBe(landmarkFogMaterial(m1, LANDMARK));
    expect(swapped[1]).toBe(landmarkFogMaterial(m2, LANDMARK));
    applyLandmarkFog(mesh, null);
    expect(mesh.material).toEqual([m1, m2]);
  });
});

describe("landmark culling units", () => {
  const doc: SceneDoc = {
    name: "t",
    version: 1,
    entities: {
      poi: { name: "poi", parent: null, tags: ["poi"], components: {} },
      gate: { name: "gate", parent: "poi", tags: [], components: { landmark: { fogReach: 800 }, culling: { minScreenPx: 20 } } },
      arch: { name: "arch", parent: "gate", tags: [], components: {} },
      clutter: { name: "clutter", parent: "gate", tags: [], components: { culling: { minScreenPx: 6 } } },
      crate: { name: "crate", parent: "poi", tags: [], components: {} },
    },
  };

  it("a landmark is its own unit, never culled by size, and its nested roots inherit its fog", () => {
    const roots = cullRootsOf(doc);
    const gate = roots.find((r) => r.id === "gate")!;
    expect(gate.settings.minScreenPx).toBe(0);
    expect(gate.landmark).toEqual({ fogReach: 800, silhouette: 0.6 });
    expect(gate.members.has("arch")).toBe(true);
    expect(roots.find((r) => r.id === "clutter")!.landmark).toEqual(gate.landmark);
    expect(roots.find((r) => r.id === "poi")!.landmark).toBeUndefined();
  });

  it("registering draws the landmark's meshes with the variant; unregistering restores them", () => {
    const material = new THREE.MeshStandardNodeMaterial();
    const objects = new Map<string, THREE.Object3D>();
    const root = new THREE.Group();
    for (const id of Object.keys(doc.entities)) objects.set(id, new THREE.Group());
    root.add(objects.get("poi")!);
    objects.get("poi")!.add(objects.get("gate")!, objects.get("crate")!);
    objects.get("gate")!.add(objects.get("arch")!, objects.get("clutter")!);
    const archMesh = new THREE.Mesh(new THREE.BoxGeometry(), material);
    const crateMesh = new THREE.Mesh(new THREE.BoxGeometry(), material);
    objects.get("arch")!.add(archMesh);
    objects.get("crate")!.add(crateMesh);
    const system = new CullingSystem();
    const units = registerCullRoots(system, cullRootsOf(doc), objects, null);
    expect(archMesh.material).toBe(landmarkFogMaterial(material, { fogReach: 800, silhouette: 0.6 }));
    expect(crateMesh.material).toBe(material);
    // a mesh that loads after registration is adopted on a rescan
    const late = new THREE.Mesh(new THREE.BoxGeometry(), material);
    objects.get("arch")!.add(late);
    const camera = new THREE.PerspectiveCamera();
    for (let i = 0; i < units.length + 2; i++) system.update(camera, 480);
    expect(late.material).toBe(landmarkFogMaterial(material, { fogReach: 800, silhouette: 0.6 }));
    for (const unit of units) system.unregister(unit);
    expect(archMesh.material).toBe(material);
  });
});

describe("landmark fog variant of a material whose maps are still loading", () => {
  it("picks the texture up when the source's maps are wired (no white slabs)", async () => {
    const { applyMaterialMaps } = await import("../src/material-maps.js");
    const { vi } = await import("vitest");
    const tex = new THREE.DataTexture(new Uint8Array([128, 128, 128, 255]), 1, 1);
    const spy = vi.spyOn(THREE.TextureLoader.prototype, "loadAsync").mockResolvedValue(tex);
    try {
      const source = new THREE.MeshStandardNodeMaterial();
      applyMaterialMaps(source, { shader: "standard", map: "late/stone.png" } as never, { resolveTexture: (id) => `/t/${id}` });
      const variant = landmarkFogMaterial(source, { fogReach: 575, silhouette: 0.35 });
      expect((variant as THREE.MeshStandardNodeMaterial).colorNode ?? null).toBe((source as THREE.MeshStandardNodeMaterial).colorNode ?? null);
      for (let i = 0; i < 10; i++) await Promise.resolve();
      await new Promise((r) => setTimeout(r, 0));
      expect((source as THREE.MeshStandardNodeMaterial).colorNode).toBeTruthy();
      expect((variant as THREE.MeshStandardNodeMaterial).colorNode).toBe((source as THREE.MeshStandardNodeMaterial).colorNode);
      expect(landmarkFogSource(variant)).toBe(source);
      expect(variant.customProgramCacheKey()).toContain("landmark-fog");
      expect((variant as unknown as { setupFog: unknown }).setupFog).not.toBe((source as unknown as { setupFog: unknown }).setupFog);
    } finally {
      spy.mockRestore();
    }
  });
});

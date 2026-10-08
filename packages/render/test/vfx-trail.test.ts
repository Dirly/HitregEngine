import { describe, expect, it } from "vitest";
import * as THREE from "three/webgpu";
import { completeModule, type VfxEffect } from "@hitreg/core";
import { VfxSystem, type VfxFrame } from "../src/vfx/index.js";

/**
 * Trails are one batch: every live trail writes its strip into the system's
 * TrailBatch (one draw per blend mode), and an `edge` trail samples two points
 * on the anchor object (a weapon) so the ribbon is the surface the edge swept.
 */

function effect(modules: Parameters<typeof completeModule>[0][]): VfxEffect {
  return { name: "t", tags: { feel: [] }, modules: modules.map((m) => completeModule(m)) };
}

function trailMeshes(sys: VfxSystem): THREE.Mesh[] {
  const out: THREE.Mesh[] = [];
  sys.root.traverse((o) => {
    if ((o as THREE.Mesh).isMesh && /^vfx-trails/.test(o.name)) out.push(o as THREE.Mesh);
  });
  return out;
}

describe("trail batch", () => {
  it("draws every trail in view through one mesh per blend mode", () => {
    const sys = new VfxSystem();
    const scene = new THREE.Scene();
    sys.attach(scene);
    const cam = new THREE.PerspectiveCamera();
    cam.position.set(0, 2, 8);
    const swords: THREE.Object3D[] = [];
    for (let i = 0; i < 6; i++) {
      const sword = new THREE.Object3D();
      sword.position.set(i * 2, 1, 0);
      scene.add(sword);
      swords.push(sword);
      const frame: VfxFrame = { origin: [i * 2, 1, 0], direction: [0, 0, -1], caster: sword, palette: { primary: "#ffffff", secondary: "#8899aa", glow: "#ffffff" } };
      sys.play(effect([{ kind: "trail", anchor: { at: "caster", follow: true }, duration: 1, length: 0.3, edge: { from: [0, 0.2, 0], to: [0, 1, 0] } }]), frame);
    }
    for (let f = 0; f < 10; f++) {
      // swing each sword round its grip
      for (const s of swords) s.rotation.z = -f * 0.25;
      sys.update(1 / 60, cam, scene);
    }
    const meshes = trailMeshes(sys);
    expect(meshes.length).toBe(2); // additive + normal, whatever the trail count
    const additive = meshes.find((m) => m.name === "vfx-trails")!;
    expect(additive.visible).toBe(true);
    expect(sys.trails.stats().additive).toBeGreaterThan(6 * 2 * 4); // six strips, several samples each
    // the strip spans the edge: its points lie between 0.2 and 1 m from a grip
    const pos = additive.geometry.getAttribute("position") as THREE.BufferAttribute;
    const p = new THREE.Vector3().fromBufferAttribute(pos, 1);
    const near = Math.min(...swords.map((s) => p.distanceTo(s.position)));
    expect(near).toBeGreaterThan(0.5);
    expect(near).toBeLessThan(1.05);
    sys.dispose();
  });

  it("fades the slow part of a motion with minSpeed and hides when nothing is live", () => {
    const sys = new VfxSystem();
    const scene = new THREE.Scene();
    sys.attach(scene);
    const cam = new THREE.PerspectiveCamera();
    const blade = new THREE.Object3D();
    scene.add(blade);
    const frame: VfxFrame = { origin: [0, 0, 0], direction: [0, 0, -1], caster: blade, palette: { primary: "#ffffff", secondary: "#888888", glow: "#ffffff" } };
    sys.play(effect([{ kind: "trail", anchor: { at: "caster", follow: true }, duration: 0.3, length: 0.2, edge: { from: [0, 0, 0], to: [0, 1, 0], minSpeed: 50 } }]), frame);
    for (let f = 0; f < 8; f++) {
      blade.rotation.z = -f * 0.05; // ~3 m/s at the tip: far under 50
      sys.update(1 / 60, cam, scene);
    }
    const additive = trailMeshes(sys).find((m) => m.name === "vfx-trails")!;
    const data = additive.geometry.getAttribute("aTrail") as THREE.BufferAttribute;
    let maxAlpha = 0;
    for (let i = 0; i < sys.trails.stats().additive; i++) maxAlpha = Math.max(maxAlpha, data.getY(i));
    expect(maxAlpha).toBeLessThan(0.2);
    sys.update(1, cam, scene);
    sys.update(0.1, cam, scene);
    expect(additive.visible).toBe(false);
    sys.dispose();
  });

  it("a core trail carries its hot colour, its falloff and which side is the edge, per vertex, still in one mesh", () => {
    const sys = new VfxSystem();
    const scene = new THREE.Scene();
    sys.attach(scene);
    const cam = new THREE.PerspectiveCamera();
    cam.position.set(0, 2, 8);
    const sword = new THREE.Object3D();
    scene.add(sword);
    const frame: VfxFrame = { origin: [0, 1, 0], direction: [0, 0, -1], caster: sword, palette: { primary: "#ffffff", secondary: "#8899aa", glow: "#ffffff" } };
    sys.play(effect([{ kind: "trail", anchor: { at: "caster", follow: true }, duration: 1, length: 0.3, falloff: 3, coreColor: "#ff0000", edge: { from: [0, 0.2, 0], to: [0, 1, 0] } }]), frame);
    for (let f = 0; f < 8; f++) {
      sword.rotation.z = -f * 0.3;
      sys.update(1 / 60, cam, scene);
    }
    const mesh = trailMeshes(sys).find((m) => m.name === "vfx-trails")!;
    const core = mesh.geometry.getAttribute("aCore") as THREE.BufferAttribute;
    const edge = mesh.geometry.getAttribute("aEdge") as THREE.BufferAttribute;
    expect(core.getX(0)).toBeCloseTo(1, 3); // red core
    expect(core.getW(0)).toBe(1); // has a core
    expect(edge.getX(0)).toBe(0); // inner side
    expect(edge.getX(1)).toBe(1); // outer side: the blade's edge
    expect(edge.getY(0)).toBe(3); // falloff
    sys.dispose();
  });
});

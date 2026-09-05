import { describe, expect, it } from "vitest";
import * as THREE from "three/webgpu";
import { completeModule, generateSpell, spellTimeline, type VfxEffect } from "@hitreg/core";
import { VfxSystem, type VfxFrame } from "../src/vfx/index.js";

const frame = (): VfxFrame => ({
  origin: [4, 0, -3],
  direction: [0, 0, -1],
  target: [4, 1, -3],
  palette: { primary: "#ff8800", secondary: "#552200", glow: "#ffffff" },
  ground: () => 0,
});

function effect(modules: Parameters<typeof completeModule>[0][]): VfxEffect {
  return { name: "t", tags: { feel: [] }, modules: modules.map((m) => completeModule(m)) };
}

describe("VfxSystem", () => {
  it("expands a repeat into stepped copies that each play whole", () => {
    const sys = new VfxSystem();
    const scene = new THREE.Scene();
    sys.attach(scene);
    const cam = new THREE.PerspectiveCamera();
    const handle = sys.play(effect([{ kind: "mesh", size: 1, duration: 1, repeat: { count: 4, every: 0.1, step: [0, 0, 1.5] } }]), frame());
    sys.update(0.05, cam, scene);
    expect(sys.stats().live).toBe(1); // only the first copy is up
    sys.update(0.3, cam, scene); // t = 0.35: copies at 0, .1, .2, .3
    expect(sys.stats().live).toBe(4);
    // the last copy sits 4.5 m further along the spell direction (-Z here)
    const meshes: THREE.Vector3[] = [];
    scene.traverse((o) => {
      if ((o as THREE.Mesh).isMesh && o.visible && o.parent?.visible && o.parent.parent?.visible) meshes.push(o.getWorldPosition(new THREE.Vector3()));
    });
    const zs = meshes.map((p) => Math.round(p.z * 10) / 10);
    expect(Math.min(...zs)).toBeCloseTo(-3 - 4.5, 0);
    sys.update(1.2, cam, scene);
    expect(handle.done).toBe(true);
    sys.dispose();
  });

  it("plays a slash and a symbol sprite without a texture resolver", () => {
    const sys = new VfxSystem();
    const scene = new THREE.Scene();
    sys.attach(scene);
    const cam = new THREE.PerspectiveCamera();
    const handle = sys.play(effect([{ kind: "slash", radius: 2, duration: 0.3, tilt: 45 }, { kind: "sprite", sheet: "none", cell: [1, 0], duration: 0.3 }]), frame());
    sys.update(0.1, cam, scene);
    expect(sys.stats().live).toBe(2);
    sys.update(0.5, cam, scene);
    expect(handle.done).toBe(true);
    sys.dispose();
  });

  it("starts modules after their delay and retires them at the end of life", () => {
    const sys = new VfxSystem();
    const scene = new THREE.Scene();
    sys.attach(scene);
    const cam = new THREE.PerspectiveCamera();
    const handle = sys.play(
      effect([
        { kind: "ring", radius: 2, duration: 0.5 },
        { kind: "shell", radius: 1, duration: 0.5, delay: 0.4 },
      ]),
      frame(),
    );
    sys.update(0.1, cam, scene);
    expect(sys.stats().live).toBe(1);
    sys.update(0.35, cam, scene); // t = 0.45: shell has started
    expect(sys.stats().live).toBe(2);
    sys.update(0.2, cam, scene); // t = 0.65: ring over
    expect(sys.stats().live).toBe(1);
    sys.update(0.4, cam, scene); // shell over
    expect(handle.done).toBe(true);
    expect(sys.stats().pooled).toBe(2);
    sys.dispose();
  });

  it("reuses pooled instances instead of building new ones", () => {
    const sys = new VfxSystem();
    const scene = new THREE.Scene();
    const cam = new THREE.PerspectiveCamera();
    const fx = effect([{ kind: "column", radius: 1, height: 3, duration: 0.2 }]);
    sys.play(fx, frame());
    sys.update(0.3, cam, scene);
    const meshes = scene.children[0]!.children.length;
    sys.play(fx, frame());
    sys.update(0.05, cam, scene);
    expect(scene.children[0]!.children.length).toBe(meshes);
    sys.dispose();
  });

  it("keeps a fixed light set and hands slots to light modules", () => {
    const sys = new VfxSystem({}, { maxLights: 2 });
    const scene = new THREE.Scene();
    const cam = new THREE.PerspectiveCamera();
    sys.attach(scene);
    const lights = scene.children[0]!.children.filter((c) => (c as THREE.Light).isLight);
    expect(lights.length).toBe(2);
    sys.play(effect([{ kind: "light", intensity: 50, duration: 0.5 }, { kind: "light", intensity: 20, duration: 0.5 }, { kind: "light", intensity: 90, duration: 0.5 }]), frame());
    sys.update(0.05, cam, scene);
    expect(sys.stats().lightsInUse).toBe(2);
    expect(scene.children[0]!.children.filter((c) => (c as THREE.Light).isLight).length).toBe(2);
    sys.update(0.6, cam, scene);
    expect(sys.stats().lightsInUse).toBe(0);
    for (const l of lights) expect((l as THREE.PointLight).intensity).toBe(0);
    sys.dispose();
  });

  it("sequences a spell's phases on its timeline and drives the projectile path", () => {
    const sys = new VfxSystem();
    const scene = new THREE.Scene();
    const cam = new THREE.PerspectiveCamera();
    const spell = generateSpell({
      seed: 3,
      element: "fire",
      archetype: { kind: "projectile", range: 10, speed: 10, windup: 0.3, radius: 1.5 },
      catalog: {},
    });
    const t = spellTimeline(spell.archetype);
    expect(t.impact?.at).toBeCloseTo(1.3);
    const caster = new THREE.Object3D();
    caster.position.set(0, 1, 0);
    scene.add(caster);
    const f: VfxFrame = { ...frame(), origin: [0, 0, -10], caster };
    const handle = sys.playSpell(spell, f);
    sys.update(0.1, cam, scene); // charge running
    const chargeLive = sys.stats().live;
    expect(chargeLive).toBeGreaterThan(0);
    sys.update(0.7, cam, scene); // t = 0.8: travelling
    expect(handle.time).toBeCloseTo(0.8);
    // path is between the launch point and the origin
    const trail = spell.phases.travel!.modules.find((m) => m.anchor.at === "path");
    expect(trail).toBeTruthy();
    sys.update(0.6, cam, scene); // t = 1.4: impact fired
    expect(sys.stats().live).toBeGreaterThan(0);
    for (let i = 0; i < 40; i++) sys.update(0.1, cam, scene);
    expect(handle.done).toBe(true);
    sys.dispose();
  });

  it("stop() fades live modules and drops pending ones", () => {
    const sys = new VfxSystem();
    const scene = new THREE.Scene();
    const cam = new THREE.PerspectiveCamera();
    const h = sys.play(effect([{ kind: "shell", radius: 1, duration: 5 }, { kind: "ring", radius: 1, delay: 2, duration: 1 }]), frame());
    sys.update(0.1, cam, scene);
    h.stop(0.2);
    sys.update(0.1, cam, scene);
    expect(sys.stats().live).toBe(1);
    sys.update(0.2, cam, scene);
    expect(h.done).toBe(true);
    sys.dispose();
  });

  it("camera shake offsets the camera for the render and restores it", () => {
    const sys = new VfxSystem();
    const scene = new THREE.Scene();
    const cam = new THREE.PerspectiveCamera();
    cam.position.set(1, 2, 3);
    sys.play(effect([{ kind: "shake", strength: 0.3, duration: 0.5 }]), frame());
    sys.update(0.05, cam, scene);
    sys.applyShake(cam);
    const moved = cam.position.distanceTo(new THREE.Vector3(1, 2, 3));
    expect(moved).toBeGreaterThan(0);
    sys.restoreShake(cam);
    expect(cam.position.distanceTo(new THREE.Vector3(1, 2, 3))).toBe(0);
    sys.dispose();
  });

  it("drapes a ground ring and a telegraph over the host's ground probe", () => {
    const sys = new VfxSystem();
    const scene = new THREE.Scene();
    const cam = new THREE.PerspectiveCamera();
    const f: VfxFrame = { ...frame(), ground: (x) => x * 0.2 };
    sys.play(effect([{ kind: "telegraph", radius: 3, windup: 0.5 }, { kind: "ring", radius: 2, duration: 1 }]), f);
    sys.update(0.05, cam, scene);
    const root = scene.children[0]!;
    const meshes: THREE.Mesh[] = [];
    root.traverse((o) => {
      if ((o as THREE.Mesh).isMesh && o.visible) meshes.push(o as THREE.Mesh);
    });
    expect(meshes.length).toBeGreaterThanOrEqual(3);
    const tele = meshes.find((m) => (m.geometry.attributes["color"] as THREE.BufferAttribute | undefined) !== undefined)!;
    const pos = tele.geometry.attributes["position"] as THREE.BufferAttribute;
    let spread = 0;
    for (let i = 0; i < pos.count; i++) spread = Math.max(spread, Math.abs(pos.getY(i)));
    expect(spread).toBeGreaterThan(0.1);
    sys.dispose();
  });
});

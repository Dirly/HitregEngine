import { describe, expect, it } from "vitest";
import * as THREE from "three/webgpu";
import { AmbientVfx, VfxSystem } from "../src/vfx/index.js";

const TORCH = {
  name: "torch",
  modules: [
    { kind: "particles", stream: true, color: "glow", colorEnd: "primary", emitter: { rate: 20, max: 40, lifetime: [0.3, 0.5] } },
    { kind: "light", intensity: 10, range: 8, flicker: 0.3, color: "primary", intensityCurve: [[0, 1], [1, 1]] },
  ],
};

function tick(ambient: AmbientVfx, sys: VfxSystem, cam: THREE.Camera, scene: THREE.Scene, frames = 1, dt = 0.1): void {
  for (let i = 0; i < frames; i++) {
    ambient.update(cam, scene);
    sys.update(dt, cam, scene);
  }
}

describe("AmbientVfx", () => {
  it("keeps a standing effect burning, with its own budgeted light, and sleeps it out of range", () => {
    const sys = new VfxSystem();
    const scene = new THREE.Scene();
    sys.attach(scene);
    const cam = new THREE.PerspectiveCamera();
    const lights: THREE.PointLight[] = [];
    const ambient = new AmbientVfx(sys, {
      resolveEffect: (id) => (id === "env/torch" ? TORCH : undefined),
      resolveMaterial: (id) => (id === "fx/blue" ? { color: "#3080ff", emissive: "#d0e8ff" } : undefined),
      onLight: (light) => lights.push(light),
    });
    const torch = new THREE.Group();
    torch.position.set(2, 1, 0);
    scene.add(torch);
    ambient.register("torch", torch, { effect: "env/torch", material: "fx/blue", playing: true, cullDistance: 20 });

    tick(ambient, sys, cam, scene, 600); // a minute: a spell's modules would long be over
    expect(ambient.stats().playing).toBe(1);
    expect(lights).toHaveLength(1);
    const light = lights[0]!;
    expect(light.parent).toBe(sys.root);
    expect(light.visible).toBe(false); // data for the budget, never in the light set itself
    expect(light.color.equals(new THREE.Color("#3080ff"))).toBe(true); // the material's colour
    expect(light.intensity).toBeGreaterThan(0);
    expect(light.position.x).toBeCloseTo(2);

    // it follows the entity
    torch.position.set(5, 1, 0);
    tick(ambient, sys, cam, scene);
    expect(light.position.x).toBeCloseTo(5);

    // out of range: fades, releases, and its light leaves the scene
    cam.position.set(200, 0, 0);
    tick(ambient, sys, cam, scene, 10);
    expect(ambient.stats().playing).toBe(0);
    expect(light.parent).toBeNull();

    // back in range: burning again with a fresh light
    cam.position.set(0, 0, 0);
    tick(ambient, sys, cam, scene);
    expect(ambient.stats().playing).toBe(1);
    expect(lights).toHaveLength(2);

    // the entity leaves the scene (a streamed cell unloads): the entry goes with it
    torch.removeFromParent();
    tick(ambient, sys, cam, scene, 5);
    expect(ambient.stats().registered).toBe(0);
    expect(lights[1]!.parent).toBeNull();
    sys.dispose();
  });

  it("does not play a parked or hidden effect, and warns once about a missing asset", () => {
    const sys = new VfxSystem();
    const scene = new THREE.Scene();
    sys.attach(scene);
    const cam = new THREE.PerspectiveCamera();
    let lookups = 0;
    const ambient = new AmbientVfx(sys, {
      resolveEffect: (id) => {
        lookups++;
        return id === "env/torch" ? TORCH : undefined;
      },
    });
    const parked = new THREE.Group();
    const hidden = new THREE.Group();
    const missing = new THREE.Group();
    hidden.visible = false;
    scene.add(parked, hidden, missing);
    ambient.register("parked", parked, { effect: "env/torch", playing: false, cullDistance: 0 });
    ambient.register("hidden", hidden, { effect: "env/torch", playing: true, cullDistance: 0 });
    ambient.register("missing", missing, { effect: "env/nope", playing: true, cullDistance: 0 });
    tick(ambient, sys, cam, scene, 30);
    expect(ambient.stats().playing).toBe(0);
    expect(lookups).toBe(1); // the missing asset is cached, not re-resolved every frame
    hidden.visible = true;
    tick(ambient, sys, cam, scene);
    expect(ambient.stats().playing).toBe(1);
    sys.dispose();
  });
});

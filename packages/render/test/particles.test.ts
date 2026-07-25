import { describe, expect, it } from "vitest";
import * as THREE from "three/webgpu";
import { ParticleSystem, type ParticlesData } from "../src/particles.js";

const data: ParticlesData = {
  emitting: true,
  rate: 100,
  max: 16,
  lifetime: [1, 1],
  shape: "point",
  shapeSize: [0, 0, 0],
  coneAngle: 0,
  direction: [0, 1, 0],
  speed: [0, 0],
  gravity: 0,
  drag: 0,
  sizeStart: 1,
  sizeEnd: 1,
  spin: 0,
  colorStart: "#ffffff",
  colorEnd: "#ffffff",
  opacityStart: 1,
  opacityEnd: 1,
  blending: "normal",
  space: "world",
};

describe("ParticleSystem runtime control", () => {
  it("sleeps authored-hidden emitters and supports a bounded one-shot burst", () => {
    const particles = new ParticleSystem();
    const scene = new THREE.Scene();
    const group = new THREE.Group();
    group.visible = false;
    scene.add(group);
    particles.register("fx", group, data);
    const mesh = group.children[0] as THREE.InstancedMesh;
    const camera = new THREE.PerspectiveCamera();

    particles.update(1, camera);
    expect(mesh.count).toBe(0);

    group.visible = true;
    particles.setValue("fx", { emitting: false, visible: true, restart: true, burst: 100 });
    particles.update(0.1, camera);
    expect(mesh.count).toBe(16);

    group.visible = false;
    particles.update(0.1, camera);
    expect(mesh.count).toBe(0);
  });
});

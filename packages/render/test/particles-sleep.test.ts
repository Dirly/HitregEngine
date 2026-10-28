import { describe, expect, it } from "vitest";
import * as THREE from "three/webgpu";
import { ParticleSystem, PARTICLE_SLEEP_DISTANCE, type ParticlesData } from "../src/particles.js";

/** A steady fire: 20 births a second, each living two seconds. */
const fire: ParticlesData = {
  emitting: true,
  rate: 20,
  max: 64,
  lifetime: [2, 2],
  shape: "point",
  shapeSize: [0, 0, 0],
  coneAngle: 0,
  spread: 0,
  turbulence: 0,
  turbulenceSpeed: 1,
  fadeIn: 0,
  direction: [0, 1, 0],
  speed: [1, 1],
  gravity: 0,
  drag: 0,
  sizeStart: 1,
  sizeEnd: 1,
  spin: 0,
  colorStart: "#ffffff",
  colorEnd: "#ffffff",
  opacityStart: 1,
  opacityEnd: 1,
  blending: "additive",
  softFade: 0,
  stretch: 0,
  space: "world",
};

function setup(distance: number) {
  const scene = new THREE.Scene();
  const group = new THREE.Group();
  group.position.set(distance, 0, 0);
  scene.add(group);
  scene.updateMatrixWorld(true);
  const camera = new THREE.PerspectiveCamera();
  scene.add(camera);
  return { scene, group, camera };
}

describe("particle distance sleep", () => {
  it("an emitter beyond the sleep distance simulates nothing; one inside it burns", () => {
    const particles = new ParticleSystem();
    const far = setup(PARTICLE_SLEEP_DISTANCE + 50);
    particles.register("far", far.group, fire);
    for (let i = 0; i < 30; i++) particles.update(0.1, far.camera);
    expect(particles.stats()).toMatchObject({ emitters: 1, asleep: 1, particles: 0 });

    const near = new ParticleSystem();
    const close = setup(50);
    near.register("near", close.group, fire);
    for (let i = 0; i < 30; i++) near.update(0.1, close.camera);
    const s = near.stats();
    expect(s.asleep).toBe(0);
    expect(s.particles).toBeGreaterThan(20);
  });

  it("coming back inside the distance primes the cloud instead of restarting it empty", () => {
    const particles = new ParticleSystem();
    const { group, camera } = setup(PARTICLE_SLEEP_DISTANCE + 50);
    particles.register("fire", group, fire);
    particles.update(0.1, camera);
    expect(particles.stats().particles).toBe(0);
    // the camera walks up to it
    camera.position.set(PARTICLE_SLEEP_DISTANCE + 40, 0, 0);
    camera.updateMatrixWorld(true);
    particles.update(0.1, camera);
    // steady state is rate x lifetime = 40 particles; a cold start would have 2 after one 0.1 s tick
    expect(particles.stats().particles).toBeGreaterThan(30);
  });

  it("sleepDistance 0 never sleeps by distance", () => {
    const particles = new ParticleSystem({ sleepDistance: 0 });
    const { group, camera } = setup(5000);
    particles.register("fire", group, fire);
    for (let i = 0; i < 10; i++) particles.update(0.1, camera);
    expect(particles.stats().asleep).toBe(0);
    expect(particles.stats().particles).toBeGreaterThan(0);
  });
});

import { describe, expect, it } from "vitest";
import * as THREE from "three/webgpu";
import { ParticleSystem, PARTICLE_SLEEP_DISTANCE, farGrowScale, type ParticlesData } from "../src/particles.js";
import { CullingSystem } from "../src/culling.js";

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
  it("sleeps within particle range when the source room is culled, and wakes on approach", () => {
    const { group, camera } = setup(30);
    group.add(new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial()));
    const culling = new CullingSystem();
    culling.register({ objects: [group], interior: true, reveal: 5, occlusion: false });
    const particles = new ParticleSystem();
    particles.register("fire", group, fire);
    culling.update(camera, 720);
    particles.update(0.1, camera);
    expect(particles.stats()).toMatchObject({ asleep: 1, particles: 0 });
    camera.position.x = 30;
    culling.update(camera, 720);
    for (let i = 0; i < 10; i++) particles.update(0.1, camera);
    expect(particles.stats().asleep).toBe(0);
    expect(particles.stats().particles).toBeGreaterThan(0);
    culling.clear();
  });
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

  it("an emitter's own sleepDistance (vfx.farDraw) keeps it awake past 220 m; the default still sleeps", () => {
    const particles = new ParticleSystem();
    const beacon = setup(330);
    particles.register("beacon", beacon.group, { ...fire, sleepDistance: 1320 });
    const torch = setup(330);
    particles.register("torch", torch.group, fire);
    for (let i = 0; i < 30; i++) particles.update(0.1, beacon.camera);
    const s = particles.stats();
    expect(s.emitters).toBe(2);
    expect(s.asleep).toBe(1);
    expect(s.particles).toBeGreaterThan(20);
    // past its own distance the beacon sleeps too
    const gone = new ParticleSystem();
    const far = setup(2000);
    gone.register("beacon", far.group, { ...fire, sleepDistance: 1320 });
    for (let i = 0; i < 10; i++) gone.update(0.1, far.camera);
    expect(gone.stats().asleep).toBe(1);
  });
});

describe("farGrow (a beacon's flame keeps its screen size far off)", () => {
  it("is 1 inside farGrow or when unset, and distance / farGrow past it", () => {
    expect(farGrowScale(undefined, 300, 0, 0)).toBe(1);
    expect(farGrowScale(0, 300, 0, 0)).toBe(1);
    expect(farGrowScale(150, 100, 0, 0)).toBe(1);
    expect(farGrowScale(150, 0, 0, 300)).toBeCloseTo(2);
    expect(farGrowScale(150, 180, 0, 240)).toBeCloseTo(2); // 300 m off
  });
});

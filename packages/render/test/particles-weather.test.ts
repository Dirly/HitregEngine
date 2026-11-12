import { afterEach, describe, expect, it } from "vitest";
import * as THREE from "three/webgpu";
import { ParticleSystem, setWeatherParticleScale, setWeatherViewCull, type ParticlesData } from "../src/particles.js";

/** A box of rain around the origin: 600 drops a second, each falling for a second. */
const rain: ParticlesData = {
  emitting: true,
  rate: 600,
  max: 4000,
  lifetime: [1, 1],
  shape: "box",
  shapeSize: [30, 1, 30],
  coneAngle: 0,
  spread: 0,
  turbulence: 0,
  turbulenceSpeed: 1,
  fadeIn: 0,
  direction: [0, -1, 0],
  speed: [20, 20],
  gravity: 0,
  drag: 0,
  sizeStart: 0.05,
  sizeEnd: 0.05,
  spin: 0,
  colorStart: "#ffffff",
  colorEnd: "#ffffff",
  opacityStart: 1,
  opacityEnd: 1,
  blending: "normal",
  softFade: 0,
  stretch: 0.01,
  orient: "velocity",
  space: "world",
  sprite: "streak",
  ground: { mode: "kill", hold: 0, fade: 0, offset: 0.05, splashChance: 1 },
};

function setup(groundAt?: (x: number, y: number, z: number) => number | null) {
  const scene = new THREE.Scene();
  const group = new THREE.Group();
  group.position.set(0, 18, 0);
  scene.add(group);
  const camera = new THREE.PerspectiveCamera(60, 16 / 9, 0.1, 500);
  camera.position.set(0, 2, 0);
  camera.lookAt(0, 2, -10); // down -Z
  scene.add(camera);
  scene.updateMatrixWorld(true);
  const particles = new ParticleSystem(groundAt ? { groundAt } : {});
  particles.register("rain", group, { ...rain });
  return { particles, camera, group, scene };
}

function run(particles: ParticleSystem, camera: THREE.Camera, seconds: number): void {
  for (let t = 0; t < seconds; t += 1 / 30) particles.update(1 / 30, camera);
}

afterEach(() => {
  setWeatherViewCull(true);
  setWeatherParticleScale(1);
});

describe("weather particles", () => {
  it("are born and drawn only toward the view; a scene emitter is untouched", () => {
    const plain = setup();
    run(plain.particles, plain.camera, 1.5);
    const all = plain.particles.stats().particles;

    const limited = setup();
    limited.particles.setValue("rain", { weather: true });
    run(limited.particles, limited.camera, 1.5);
    const seen = limited.particles.stats().particles;
    expect(all).toBeGreaterThan(450);
    expect(seen).toBeGreaterThan(0);
    expect(seen).toBeLessThan(all * 0.45);
  });

  it("thin with the graphics setting, and stop at zero", () => {
    setWeatherViewCull(false);
    const full = setup();
    full.particles.setValue("rain", { weather: true });
    run(full.particles, full.camera, 1.5);
    const all = full.particles.stats().particles;

    setWeatherParticleScale(0.5);
    const half = setup();
    half.particles.setValue("rain", { weather: true });
    run(half.particles, half.camera, 1.5);
    expect(half.particles.stats().particles).toBeGreaterThan(all * 0.35);
    expect(half.particles.stats().particles).toBeLessThan(all * 0.65);

    setWeatherParticleScale(0);
    run(half.particles, half.camera, 1.5);
    expect(half.particles.stats().particles).toBe(0);
  });

  it("ask the ground once per column, not once per drop", () => {
    let queries = 0;
    const ground = () => {
      queries++;
      return 0;
    };
    const { particles, camera } = setup(ground);
    particles.setValue("rain", { weather: true, direction: [0.3, -1, 0] });
    run(particles, camera, 6);
    const cached = queries;

    queries = 0;
    setWeatherViewCull(false);
    const direct = setup(ground);
    direct.particles.setValue("rain", { direction: [0.3, -1, 0] });
    run(direct.particles, direct.camera, 6);
    expect(queries).toBeGreaterThan(1500);
    expect(cached).toBeLessThan(queries / 2);
  });

  it("keeps weather dry beneath a roof, including an emitter born below it", () => {
    // Previously, rain born below a remembered roof deliberately re-queried
    // the indoor floor. A camera-following weather box must not do that.
    let underRoof = 0;
    const ground = (_x: number, y: number) => {
      if (y < 10) underRoof++;
      return y >= 10 ? 10 : 0;
    };
    const { particles, camera, group, scene } = setup(ground);
    particles.setValue("rain", { weather: true });
    run(particles, camera, 0.5);
    expect(underRoof).toBe(0);
    group.position.y = 5;
    scene.updateMatrixWorld(true);
    run(particles, camera, 1.5);
    expect(underRoof).toBe(0);
    expect(particles.stats().particles).toBe(0);
  });

  it("finds a tall roof above the weather box with view culling disabled", () => {
    setWeatherViewCull(false);
    const { particles, camera } = setup((_x,y)=>y>=26?26:0);
    particles.setValue('rain',{weather:true});
    run(particles,camera,1);
    expect(particles.stats().particles).toBe(0);
  });

  it("does not turn sheltered scene effects into weather", () => {
    const {particles,camera}=setup((_x,y)=>y>=26?26:0);
    run(particles,camera,.5);
    expect(particles.stats().particles).toBeGreaterThan(0);
  });

  it("retires a windblown drop as it enters cover before its old ground trigger", () => {
    setWeatherViewCull(false);
    const {particles,camera,group,scene}=setup((x,y)=>x>=1.5&&y>=20?20:0);
    // One drop begins outdoors at18m, then drifts beneath a20m roof.
    group.position.set(0,18,0);camera.position.set(0,18,10);camera.lookAt(0,18,0);scene.updateMatrixWorld(true);
    particles.register('rain',group,{...rain,emitting:false,shapeSize:[0,0,0],direction:[1,-.3,0]});
    particles.update(0,camera);
    particles.setValue('rain',{weather:true,burst:1});
    particles.update(.001,camera);
    expect(particles.stats().particles).toBe(1);
    run(particles,camera,.2);
    expect(particles.stats().particles).toBe(0);
  });
});

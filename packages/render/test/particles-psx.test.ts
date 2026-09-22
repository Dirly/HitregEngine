import { describe, expect, it } from "vitest";
import * as THREE from "three/webgpu";
import { ParticleSystem, type ParticlesData } from "../src/particles.js";

const base: ParticlesData = {
  emitting: false,
  rate: 0,
  max: 4,
  lifetime: [1, 1],
  shape: "point",
  shapeSize: [0, 0, 0],
  coneAngle: 0,
  spread: 0,
  turbulence: 0,
  turbulenceSpeed: 1,
  fadeIn: 0,
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
  blending: "additive",
  softFade: 0,
  stretch: 0,
  space: "world",
};

function oneParticle(overrides: Partial<ParticlesData>) {
  const particles = new ParticleSystem();
  const scene = new THREE.Scene();
  const group = new THREE.Group();
  scene.add(group);
  particles.register("fx", group, { ...base, ...overrides });
  const mesh = particles.drawOf("fx")!.mesh as unknown as THREE.InstancedMesh;
  const camera = new THREE.PerspectiveCamera();
  particles.setValue("fx", { burst: 1 });
  return { particles, mesh, camera };
}

const yOf = (mesh: THREE.InstancedMesh): number => (mesh.instanceMatrix.array as Float32Array)[13]!;
const scaleOf = (mesh: THREE.InstancedMesh): number => {
  const m = mesh.instanceMatrix.array as Float32Array;
  return Math.hypot(m[0]!, m[1]!, m[2]!);
};
const redOf = (mesh: THREE.InstancedMesh): number => (mesh.geometry.getAttribute("aColor").array as Float32Array)[0]!;

describe("particles: PSX controls", () => {
  it("frameRate advances the simulation in whole ticks, so a particle holds and then jumps", () => {
    const { particles, mesh, camera } = oneParticle({ speed: [1, 1], frameRate: 10 });
    particles.update(0.06, camera); // under one 0.1 s tick: nothing moves
    expect(yOf(mesh)).toBeCloseTo(0, 5);
    particles.update(0.06, camera); // 0.12 s owed: exactly one tick is spent
    expect(yOf(mesh)).toBeCloseTo(0.1, 5);
  });

  it("snap puts positions on the world grid and sizes in whole cells, never below one", () => {
    const { particles, mesh, camera } = oneParticle({ lifetime: [10, 10], speed: [0.37, 0.37], snap: 0.25, sizeStart: 0.3, sizeEnd: 0.3 });
    particles.update(0.5, camera); // raw y = 0.185 → the 0.25 cell
    expect(yOf(mesh)).toBeCloseTo(0.25, 5);
    expect(scaleOf(mesh)).toBeCloseTo(0.25, 5); // 0.3 → one 0.25 cell

    const tiny = oneParticle({ snap: 0.25, sizeStart: 0.05, sizeEnd: 0.05 });
    tiny.particles.update(0.1, tiny.camera);
    expect(scaleOf(tiny.mesh)).toBeCloseTo(0.25, 5);
  });

  it("steps band the colour ramp into hard jumps sampled mid-step", () => {
    const { particles, mesh, camera } = oneParticle({ colorStart: "#000000", colorEnd: "#ffffff", steps: 2 });
    particles.update(0.3, camera); // first half of life → the value at t = 0.25
    expect(redOf(mesh)).toBeCloseTo(0.25, 3);
    particles.update(0.1, camera); // still the first half: no glide
    expect(redOf(mesh)).toBeCloseTo(0.25, 3);
    particles.update(0.2, camera); // t = 0.6 → the value at t = 0.75
    expect(redOf(mesh)).toBeCloseTo(0.75, 3);
  });
});

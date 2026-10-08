import { describe, expect, it } from "vitest";
import * as THREE from "three/webgpu";
import { ParticleSystem, type ParticlesData } from "../src/particles.js";

const base: ParticlesData = {
  emitting: false,
  rate: 0,
  max: 64,
  lifetime: [10, 10],
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
  blending: "normal",
  softFade: 0,
  stretch: 0,
  space: "world",
};

const frames = (mesh: THREE.Object3D, count: number): number[] => {
  const shader = (mesh as THREE.Mesh).geometry.getAttribute("aParticle").array as Float32Array;
  return Array.from({ length: count }, (_, i) => shader[i * 4 + 1]!);
};

describe("particles: one shared sheet carved into row strips", () => {
  it("row mode keeps every particle inside its emitter's rows, and emitters on one sheet share one batch", () => {
    const particles = new ParticleSystem();
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera();
    const a = new THREE.Group();
    const b = new THREE.Group();
    scene.add(a, b);
    const sheet = { cols: 4, rows: 9, mode: "row" as const, fps: 7 };
    particles.register("leaves", a, { ...base, subUV: { ...sheet, firstRow: 0, rowCount: 3 } });
    particles.register("moths", b, { ...base, subUV: { ...sheet, firstRow: 3, rowCount: 1 } });
    expect(particles.stats().batches).toBe(1);
    particles.setValue("leaves", { burst: 40 });
    particles.setValue("moths", { burst: 20 });
    particles.update(0.37, camera);
    const all = frames(particles.drawOf("leaves")!.mesh, 60);
    const leaves = all.slice(particles.drawOf("leaves")!.offset, particles.drawOf("leaves")!.offset + 40);
    const moths = all.slice(particles.drawOf("moths")!.offset, particles.drawOf("moths")!.offset + 20);
    for (const f of leaves) expect(f).toBeGreaterThanOrEqual(0), expect(f).toBeLessThan(12);
    for (const f of moths) expect(f).toBeGreaterThanOrEqual(12), expect(f).toBeLessThan(16);
    expect(new Set(leaves.map((f) => Math.floor(f / 4))).size).toBeGreaterThan(1); // variants differ
  });

  it("an idle emitter (rate 0, nothing alive) draws nothing", () => {
    const particles = new ParticleSystem();
    const scene = new THREE.Scene();
    const group = new THREE.Group();
    scene.add(group);
    particles.register("idle", group, { ...base, emitting: true, rate: 0 });
    particles.update(0.1, new THREE.PerspectiveCamera());
    expect(particles.stats().particles).toBe(0);
    particles.setValue("idle", { rate: 50 });
    particles.update(0.1, new THREE.PerspectiveCamera());
    expect(particles.stats().particles).toBe(5);
  });
});

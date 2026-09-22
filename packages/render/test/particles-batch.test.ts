import { describe, expect, it } from "vitest";
import * as THREE from "three/webgpu";
import { ParticleSystem, type ParticlesData } from "../src/particles.js";

const base: ParticlesData = {
  emitting: false,
  rate: 0,
  max: 16,
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
  blending: "additive",
  softFade: 0,
  stretch: 0,
  space: "world",
};

function world(n: number): { scene: THREE.Scene; groups: THREE.Group[] } {
  const scene = new THREE.Scene();
  const groups = Array.from({ length: n }, (_, i) => {
    const g = new THREE.Group();
    g.position.set(i * 10, 0, 0);
    scene.add(g);
    return g;
  });
  return { scene, groups };
}

describe("particle batching", () => {
  it("draws every emitter of one look through one single-pass mesh in the scene", () => {
    const particles = new ParticleSystem();
    const { scene, groups } = world(3);
    const camera = new THREE.PerspectiveCamera();
    particles.register("a", groups[0]!, base);
    particles.register("b", groups[1]!, base);
    particles.register("smoke", groups[2]!, { ...base, blending: "normal" });
    particles.setValue("a", { burst: 3 });
    particles.setValue("b", { burst: 2 });
    particles.setValue("smoke", { burst: 1 });
    particles.update(0.1, camera);

    const a = particles.drawOf("a")!;
    const b = particles.drawOf("b")!;
    const smoke = particles.drawOf("smoke")!;
    expect(b.mesh).toBe(a.mesh);
    expect(smoke.mesh).not.toBe(a.mesh);
    expect(a.mesh.instanceCount).toBe(5);
    expect([a.offset, a.count, b.offset, b.count]).toEqual([0, 3, 3, 2]);
    expect(particles.stats()).toEqual({ emitters: 3, batches: 2, particles: 6 });
    expect(a.mesh.parent).toBe(scene);
    expect((a.mesh.material as THREE.Material).forceSinglePass).toBe(true);

    // b's particles really are b's: its slots hold its own world position
    const m = a.mesh.instanceMatrix.array as Float32Array;
    expect(m[b.offset * 16 + 12]).toBeCloseTo(10);

    particles.unregister("smoke");
    expect(particles.stats().batches).toBe(1);
    expect(smoke.mesh.parent).toBeNull();
  });

  it("grows a batch as emitters join, keeping it in the scene", () => {
    const particles = new ParticleSystem();
    const { scene, groups } = world(4);
    const camera = new THREE.PerspectiveCamera();
    groups.forEach((g, i) => particles.register(`e${i}`, g, base));
    groups.forEach((_, i) => particles.setValue(`e${i}`, { burst: 16 }));
    particles.update(0.1, camera);
    const draw = particles.drawOf("e0")!;
    expect(draw.mesh.capacity).toBeGreaterThanOrEqual(64);
    expect(draw.mesh.instanceCount).toBe(64);
    expect(draw.mesh.parent).toBe(scene);
    expect(scene.children.filter((c) => c.name === "particles")).toHaveLength(1);
  });

  it("a hidden emitter contributes nothing while its batch-mates keep drawing", () => {
    const particles = new ParticleSystem();
    const { groups } = world(2);
    const camera = new THREE.PerspectiveCamera();
    particles.register("a", groups[0]!, { ...base, emitting: true, rate: 100 });
    particles.register("b", groups[1]!, { ...base, emitting: true, rate: 100 });
    groups[1]!.visible = false;
    particles.update(0.1, camera);
    expect(particles.drawOf("b")!.count).toBe(0);
    expect(particles.drawOf("a")!.mesh.instanceCount).toBe(particles.drawOf("a")!.count);
    expect(particles.drawOf("a")!.count).toBeGreaterThan(0);
  });

  it("parents batches under a host when given one", () => {
    const host = new THREE.Group();
    const particles = new ParticleSystem({ host });
    const { groups } = world(1);
    particles.register("a", groups[0]!, base);
    particles.update(0.1, new THREE.PerspectiveCamera());
    expect(particles.drawOf("a")!.mesh.parent).toBe(host);
  });
});

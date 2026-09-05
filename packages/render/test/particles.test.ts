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

/** Per-particle (opacity, frame, seed, _) written for the shader. */
function shaderAt(mesh: THREE.InstancedMesh, i: number): [number, number, number] {
  const attr = mesh.geometry.getAttribute("aParticle");
  const a = attr.array as Float32Array;
  return [a[i * 4]!, a[i * 4 + 1]!, a[i * 4 + 2]!];
}

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
    expect(mesh.instanceCount).toBe(0);

    group.visible = true;
    particles.setValue("fx", { emitting: false, visible: true, restart: true, burst: 100 });
    particles.update(0.1, camera);
    expect(mesh.instanceCount).toBe(16);

    group.visible = false;
    particles.update(0.1, camera);
    expect(mesh.instanceCount).toBe(0);
  });

  it("retints the ramp at runtime, live particles included", () => {
    const particles = new ParticleSystem();
    const group = new THREE.Group();
    new THREE.Scene().add(group);
    particles.register("fx", group, data);
    const mesh = group.children[0] as THREE.InstancedMesh;
    const camera = new THREE.PerspectiveCamera();

    // born white, under the document's ramp
    particles.setValue("fx", { emitting: false, burst: 4 });
    particles.update(0.1, camera);
    const colors = mesh.geometry.getAttribute("aColor").array as Float32Array;
    expect(colors[0]).toBeCloseTo(1);
    expect(colors[2]).toBeCloseTo(1);

    // the SAME particles pick the new ramp up, because colour is evaluated
    // per frame from age rather than baked at spawn
    particles.setValue("fx", { colorStart: "#ff0000", colorEnd: "#ff0000" });
    particles.update(0.1, camera);
    expect(colors[0]).toBeCloseTo(1);
    expect(colors[1]).toBeCloseTo(0);
    expect(colors[2]).toBeCloseTo(0);
  });

  /** Spawn `count` particles into a fresh emitter and return their positions
   * one step later — where they went is the only readable proof of the
   * velocities they were given. */
  function positionsAfterStep(overrides: Partial<ParticlesData>, count: number): number[][] {
    const particles = new ParticleSystem();
    const group = new THREE.Group();
    new THREE.Scene().add(group);
    particles.register("fx", group, { ...data, ...overrides });
    const mesh = group.children[0] as THREE.InstancedMesh;
    particles.setValue("fx", { emitting: false, burst: count });
    particles.update(0.25, new THREE.PerspectiveCamera());
    const m = mesh.instanceMatrix.array as Float32Array;
    return Array.from({ length: mesh.instanceCount }, (_, i) => [m[i * 16 + 12]!, m[i * 16 + 14]!]);
  }

  it("spreads launch direction on non-cone shapes, so a volume drifts instead of falling in parallel", () => {
    const parallel = positionsAfterStep({ speed: [1, 1], max: 8 }, 8);
    // spread 0: one direction for everybody — every particle is at the SAME
    // place a step later, which on screen is falling snow
    for (const [x, z] of parallel) {
      expect(x).toBeCloseTo(parallel[0]![0]!);
      expect(z).toBeCloseTo(parallel[0]![1]!);
    }

    const scattered = positionsAfterStep({ speed: [1, 1], max: 8, spread: 180 }, 8);
    const spanX = Math.max(...scattered.map((p) => p[0]!)) - Math.min(...scattered.map((p) => p[0]!));
    const spanZ = Math.max(...scattered.map((p) => p[1]!)) - Math.min(...scattered.map((p) => p[1]!));
    expect(spanX).toBeGreaterThan(0.05);
    expect(spanZ).toBeGreaterThan(0.05);
  });

  it("carries per-particle opacity in its own attribute, so alpha can fade without shrinking", () => {
    const particles = new ParticleSystem();
    const group = new THREE.Group();
    new THREE.Scene().add(group);
    particles.register("fx", group, { ...data, lifetime: [10, 10], fadeIn: 0.5 });
    const mesh = group.children[0] as THREE.InstancedMesh;
    const camera = new THREE.PerspectiveCamera();
    particles.setValue("fx", { emitting: false, burst: 1 });

    const scaleAt = (): number => {
      const m = new THREE.Matrix4().fromArray(mesh.instanceMatrix.array as Float32Array, 0);
      return new THREE.Vector3().setFromMatrixScale(m).x;
    };

    particles.update(0.1, camera); // 1% of life, deep inside the fade-in
    const bornOpacity = shaderAt(mesh, 0)[0];
    const bornScale = scaleAt();
    expect(bornOpacity).toBeLessThan(0.1);

    particles.update(4.9, camera); // 50% of life: fade-in complete
    expect(shaderAt(mesh, 0)[0]).toBeGreaterThan(bornOpacity * 10);
    // The point of the attribute: weight is carried by ALPHA, so the quad is
    // the same size faded in as faded out. Encoding opacity as scale was the
    // reason alpha-blended smoke could never simply thin out.
    expect(scaleAt()).toBeCloseTo(bornScale);
  });

  it("plays a sub-UV sheet across a particle's life", () => {
    const particles = new ParticleSystem();
    const group = new THREE.Group();
    new THREE.Scene().add(group);
    particles.register("fx", group, {
      ...data,
      lifetime: [10, 10],
      subUV: { cols: 4, rows: 2, mode: "life", fps: 24 },
    });
    const mesh = group.children[0] as THREE.InstancedMesh;
    const camera = new THREE.PerspectiveCamera();
    particles.setValue("fx", { emitting: false, burst: 1 });

    particles.update(0.1, camera);
    expect(shaderAt(mesh, 0)[1]).toBe(0);
    particles.update(5, camera); // half way through life -> half way through the sheet
    expect(shaderAt(mesh, 0)[1]).toBe(4);
    particles.update(4.5, camera); // last frame, and never past it
    expect(shaderAt(mesh, 0)[1]).toBe(7);
  });

  it("holds one random frame per particle when asked, so identical quads differ", () => {
    const particles = new ParticleSystem();
    const group = new THREE.Group();
    new THREE.Scene().add(group);
    particles.register("fx", group, {
      ...data,
      max: 32,
      lifetime: [10, 10],
      subUV: { cols: 4, rows: 2, mode: "random", fps: 24 },
    });
    const mesh = group.children[0] as THREE.InstancedMesh;
    const camera = new THREE.PerspectiveCamera();
    particles.setValue("fx", { emitting: false, burst: 24 });
    particles.update(0.1, camera);

    const frames = new Set<number>();
    for (let i = 0; i < mesh.instanceCount; i++) frames.add(shaderAt(mesh, i)[1]);
    expect(frames.size).toBeGreaterThan(1);
    for (const f of frames) expect(f).toBeLessThan(8);
  });

  it("samples size and opacity curves instead of a two-point lerp", () => {
    const particles = new ParticleSystem();
    const group = new THREE.Group();
    new THREE.Scene().add(group);
    particles.register("fx", group, {
      ...data,
      lifetime: [10, 10],
      // a flash: spike early, long dim tail — what a lerp cannot describe
      sizeCurve: [
        [0, 0.2],
        [0.2, 2],
        [1, 0.4],
      ],
      opacityCurve: [
        [0, 1],
        [1, 0],
      ],
    });
    const mesh = group.children[0] as THREE.InstancedMesh;
    const camera = new THREE.PerspectiveCamera();
    particles.setValue("fx", { emitting: false, burst: 1 });
    const scaleAt = (): number => {
      const m = new THREE.Matrix4().fromArray(mesh.instanceMatrix.array as Float32Array, 0);
      return new THREE.Vector3().setFromMatrixScale(m).x;
    };

    particles.update(2, camera); // t=0.2 — the peak of the spike
    expect(scaleAt()).toBeCloseTo(2, 1);
    particles.update(4, camera); // t=0.6 — well down the tail
    expect(scaleAt()).toBeLessThan(1.4);
    expect(shaderAt(mesh, 0)[0]).toBeCloseTo(0.4, 1);
  });

  it("stretches a particle along its own velocity", () => {
    const particles = new ParticleSystem();
    const group = new THREE.Group();
    new THREE.Scene().add(group);
    particles.register("fx", group, {
      ...data,
      lifetime: [10, 10],
      speed: [10, 10],
      stretch: 0.1,
    });
    const mesh = group.children[0] as THREE.InstancedMesh;
    const camera = new THREE.PerspectiveCamera();
    particles.setValue("fx", { emitting: false, burst: 1 });
    particles.update(0.1, camera);

    const m = new THREE.Matrix4().fromArray(mesh.instanceMatrix.array as Float32Array, 0);
    const scale = new THREE.Vector3().setFromMatrixScale(m);
    // A spark that is not longer than it is wide reads as a dot.
    expect(scale.y).toBeGreaterThan(scale.x * 1.5);
  });
});

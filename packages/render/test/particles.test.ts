import { describe, expect, it } from "vitest";
import * as THREE from "three/webgpu";
import { ParticleSystem, valueNoise2D, type ParticlesData } from "../src/particles.js";

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
    const mesh = particles.drawOf("fx")!.mesh as unknown as THREE.InstancedMesh;
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
    const mesh = particles.drawOf("fx")!.mesh as unknown as THREE.InstancedMesh;
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
    const mesh = particles.drawOf("fx")!.mesh as unknown as THREE.InstancedMesh;
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
    const mesh = particles.drawOf("fx")!.mesh as unknown as THREE.InstancedMesh;
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
    const mesh = particles.drawOf("fx")!.mesh as unknown as THREE.InstancedMesh;
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
    const mesh = particles.drawOf("fx")!.mesh as unknown as THREE.InstancedMesh;
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
    const mesh = particles.drawOf("fx")!.mesh as unknown as THREE.InstancedMesh;
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
    const mesh = particles.drawOf("fx")!.mesh as unknown as THREE.InstancedMesh;
    const camera = new THREE.PerspectiveCamera();
    particles.setValue("fx", { emitting: false, burst: 1 });
    particles.update(0.1, camera);

    const m = new THREE.Matrix4().fromArray(mesh.instanceMatrix.array as Float32Array, 0);
    const scale = new THREE.Vector3().setFromMatrixScale(m);
    // A spark that is not longer than it is wide reads as a dot.
    expect(scale.y).toBeGreaterThan(scale.x * 1.5);
  });
it("aims a velocity-oriented quad along the WORLD velocity, whatever the camera is doing", () => {
    const particles = new ParticleSystem();
    const group = new THREE.Group();
    new THREE.Scene().add(group);
    // falling, and blown hard toward +X: the streak must lean that way
    particles.register("fx", group, {
      ...data,
      lifetime: [10, 10],
      direction: [1, -1, 0],
      speed: [10, 10],
      stretch: 0.2,
      orient: "velocity",
    });
    const mesh = particles.drawOf("fx")!.mesh as unknown as THREE.InstancedMesh;
    const camera = new THREE.PerspectiveCamera();
    camera.position.set(0, 0, 12);
    camera.updateMatrixWorld(true);
    particles.setValue("fx", { emitting: false, burst: 1 });
    particles.update(0.01, camera);

    const longAxis = (): THREE.Vector3 => {
      // decompose, not setFromRotationMatrix: a stretched quad's matrix carries
      // a non-uniform scale, which that one would fold into the rotation
      const m = new THREE.Matrix4().fromArray(mesh.instanceMatrix.array as Float32Array, 0);
      const q = new THREE.Quaternion();
      m.decompose(new THREE.Vector3(), q, new THREE.Vector3());
      return new THREE.Vector3(0, 1, 0).applyQuaternion(q);
    };
    const expected = new THREE.Vector3(1, -1, 0).normalize();
    expect(Math.abs(longAxis().dot(expected))).toBeCloseTo(1, 5);

    // and it stays there when the viewer walks round it — the old camera-roll
    // stretch swung with the camera, which is what made rain look tilted
    camera.position.set(12, 0, 0);
    camera.updateMatrixWorld(true);
    particles.update(0.01, camera);
    expect(Math.abs(longAxis().dot(expected))).toBeCloseTo(1, 5);
  });

  it("lays a ground-oriented quad flat, facing up", () => {
    const particles = new ParticleSystem();
    const group = new THREE.Group();
    new THREE.Scene().add(group);
    particles.register("fx", group, { ...data, lifetime: [10, 10], orient: "ground" });
    const mesh = particles.drawOf("fx")!.mesh as unknown as THREE.InstancedMesh;
    const camera = new THREE.PerspectiveCamera();
    camera.position.set(3, 4, 5);
    camera.lookAt(0, 0, 0);
    camera.updateMatrixWorld(true);
    particles.setValue("fx", { emitting: false, burst: 1 });
    particles.update(0.01, camera);

    const m = new THREE.Matrix4().fromArray(mesh.instanceMatrix.array as Float32Array, 0);
    const q = new THREE.Quaternion().setFromRotationMatrix(m);
    // PlaneGeometry's normal is +Z; laid flat it must point at the sky.
    const normal = new THREE.Vector3(0, 0, 1).applyQuaternion(q);
    expect(normal.y).toBeCloseTo(1, 5);
  });

  it("keeps an upright quad vertical however far up the camera looks", () => {
    const particles = new ParticleSystem();
    const group = new THREE.Group();
    new THREE.Scene().add(group);
    particles.register("fx", group, { ...data, lifetime: [10, 10], orient: "upright" });
    const mesh = particles.drawOf("fx")!.mesh as unknown as THREE.InstancedMesh;
    const camera = new THREE.PerspectiveCamera();
    camera.position.set(0, 9, 4); // steeply above, looking down
    camera.lookAt(0, 0, 0);
    camera.updateMatrixWorld(true);
    particles.setValue("fx", { emitting: false, burst: 1 });
    particles.update(0.01, camera);

    const m = new THREE.Matrix4().fromArray(mesh.instanceMatrix.array as Float32Array, 0);
    const q = new THREE.Quaternion().setFromRotationMatrix(m);
    const up = new THREE.Vector3(0, 1, 0).applyQuaternion(q);
    expect(up.y).toBeCloseTo(1, 5); // a camera-facing quad would have tipped
    const normal = new THREE.Vector3(0, 0, 1).applyQuaternion(q);
    expect(normal.z).toBeCloseTo(1, 5); // and still turned toward the viewer
  });

  it("fires every emitter in a splash list, with its own count, at the contact point", () => {
    const particles = new ParticleSystem({ groundAt: () => 0 });
    const scene = new THREE.Scene();
    const sky = new THREE.Group();
    const ring = new THREE.Group();
    const drops = new THREE.Group();
    scene.add(sky, ring, drops);
    sky.position.set(0, 5, 0);
    particles.register("ring", ring, { ...data, emitting: false, rate: 0, max: 64, lifetime: [10, 10] });
    particles.register("drops", drops, { ...data, emitting: false, rate: 0, max: 64, lifetime: [10, 10] });
    particles.register("rain", sky, {
      ...data,
      emitting: false,
      rate: 0,
      max: 8,
      lifetime: [10, 10],
      direction: [0, -1, 0],
      speed: [10, 10],
      ground: { mode: "kill", hold: 0, fade: 0, offset: 0, splash: "ring,drops*3" },
    });
    const camera = new THREE.PerspectiveCamera();
    particles.setValue("rain", { burst: 2 });
    particles.update(1, camera); // 10 m/s for a second: both drops reach the ground

    expect(particles.drawOf("rain")!.count).toBe(0); // killed on contact
    expect(particles.drawOf("ring")!.count).toBe(2); // one ring each
    expect(particles.drawOf("drops")!.count).toBe(6); // three droplets each
    const m = new THREE.Matrix4().fromArray(particles.drawOf("ring")!.mesh.instanceMatrix.array as Float32Array, 0);
    expect(new THREE.Vector3().setFromMatrixPosition(m).y).toBeCloseTo(0, 5); // where it landed
  });

  it("splashes only a fraction of landings when asked", () => {
    const particles = new ParticleSystem({ groundAt: () => 0 });
    const scene = new THREE.Scene();
    const sky = new THREE.Group();
    const ring = new THREE.Group();
    scene.add(sky, ring);
    sky.position.set(0, 5, 0);
    particles.register("ring", ring, { ...data, emitting: false, rate: 0, max: 4000, lifetime: [10, 10] });
    particles.register("rain", sky, {
      ...data,
      emitting: false,
      rate: 0,
      max: 2000,
      lifetime: [10, 10],
      direction: [0, -1, 0],
      speed: [10, 10],
      ground: { mode: "kill", hold: 0, fade: 0, offset: 0, splash: "ring", splashChance: 0.1 },
    });
    const camera = new THREE.PerspectiveCamera();
    particles.setValue("rain", { burst: 2000 });
    particles.update(1, camera);

    const splashed = particles.drawOf("ring")!.count;
    expect(splashed).toBeGreaterThan(50); // ~200 of 2000, with room for the dice
    expect(splashed).toBeLessThan(450);
  });

  it("re-aims and re-speeds an emitter live, for the particles it spawns next", () => {
    const particles = new ParticleSystem();
    const group = new THREE.Group();
    new THREE.Scene().add(group);
    particles.register("fx", group, { ...data, emitting: false, rate: 0, lifetime: [10, 10], speed: [1, 1] });
    const mesh = particles.drawOf("fx")!.mesh as unknown as THREE.InstancedMesh;
    const camera = new THREE.PerspectiveCamera();
    // wind: sideways and fast
    particles.setValue("fx", { direction: [1, 0, 0], speed: [20, 20], burst: 1 });
    particles.update(0.5, camera);

    const m = new THREE.Matrix4().fromArray(mesh.instanceMatrix.array as Float32Array, 0);
    const p = new THREE.Vector3().setFromMatrixPosition(m);
    expect(p.x).toBeCloseTo(10, 3);
    expect(p.y).toBeCloseTo(0, 5);
  });
  it("scales the whole ramp live, which is how an unlit effect answers the hour", () => {
    const particles = new ParticleSystem();
    const group = new THREE.Group();
    new THREE.Scene().add(group);
    particles.register("fx", group, { ...data, lifetime: [10, 10], colorStart: "#ffffff", colorEnd: "#ffffff" });
    const mesh = particles.drawOf("fx")!.mesh as unknown as THREE.InstancedMesh;
    const camera = new THREE.PerspectiveCamera();
    particles.setValue("fx", { emitting: false, burst: 1 });
    particles.update(0.1, camera);
    const red = (): number => (mesh.geometry.getAttribute("aColor").array as Float32Array)[0]!;
    expect(red()).toBeCloseTo(1, 5);

    // night: the drop is the same colour, there is just no light on it
    particles.setValue("fx", { colorScale: 0.2 });
    particles.update(0.1, camera);
    expect(red()).toBeCloseTo(0.2, 5);
  });

  it("has a noise field with real variation in it, which is what makes a torn puff", () => {
    // A bank of SMOOTH blobs is one grey shape however many you draw; the
    // noise sprite exists to put edges inside each quad.
    const values: number[] = [];
    for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) values.push(valueNoise2D(x * 0.7, y * 0.7));
    expect(Math.max(...values) - Math.min(...values)).toBeGreaterThan(0.3);
    // ...and it is a FIELD, not a hash: neighbours are related
    expect(Math.abs(valueNoise2D(3, 3) - valueNoise2D(3.02, 3))).toBeLessThan(0.05);
  });
  it("lands a WIND-BLOWN particle on the ground it drifted to, not the one it was born over", () => {
    // The bug: the ground is sampled straight down from the birth point, so a
    // drop carried sideways by a gale splashed in mid-air over rising ground
    // (or under the surface over falling ground). Derek saw both.
    //  hill: ground climbs 1 m per metre of +x
    const groundAt = (x: number) => Math.max(0, x);
    const particles = new ParticleSystem({ groundAt: (x) => groundAt(x) });
    const scene = new THREE.Scene();
    const sky = new THREE.Group();
    const ring = new THREE.Group();
    scene.add(sky, ring);
    sky.position.set(0, 10, 0); // born over flat ground at y=0
    particles.register("ring", ring, { ...data, emitting: false, rate: 0, max: 64, lifetime: [10, 10] });
    particles.register("rain", sky, {
      ...data,
      emitting: false,
      rate: 0,
      max: 8,
      lifetime: [10, 10],
      // falling and blown hard toward +x, where the ground is higher
      direction: [1, -1, 0],
      speed: [Math.SQRT2 * 5, Math.SQRT2 * 5],
      ground: { mode: "kill", hold: 0, fade: 0, offset: 0, splash: "ring" },
    });
    const camera = new THREE.PerspectiveCamera();
    particles.setValue("rain", { burst: 1 });
    for (let i = 0; i < 90; i++) particles.update(1 / 30, camera); // 3s: long enough to fall 10 m

    expect(particles.drawOf("ring")!.count).toBe(1);
    const m = new THREE.Matrix4().fromArray(particles.drawOf("ring")!.mesh.instanceMatrix.array as Float32Array, 0);
    const at = new THREE.Vector3().setFromMatrixPosition(m);
    // the splash must sit ON the hill under it, not at the y=0 it was born over
    expect(at.x).toBeGreaterThan(1);
    expect(at.y).toBeCloseTo(groundAt(at.x), 1);
  });
});

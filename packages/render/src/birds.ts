import * as THREE from "three/webgpu";
import { abs, attribute, cos, float, mix, positionLocal, sin, smoothstep, step, time, uniform, uv, vec3 } from "three/tsl";
import { worldDaylight } from "./daylight.js";

/* eslint-disable @typescript-eslint/no-explicit-any */
type N = any;

/**
 * Birds wheeling overhead by day — dark crow silhouettes, a few flocks in the
 * cells around the camera, ONE instanced draw of tiny camera-facing quads.
 * Each bird's whole flight (circle, bob, wing beat) is a function of time in
 * the vertex shader; the CPU only rewrites the flock list when the camera
 * crosses into a new cell. They thin out at dusk and in rain and are gone at
 * night.
 */
const CELL = 220;
/** Share of cells with a flock. */
const FLOCK_CHANCE = 0.4;
const BIRDS_PER_FLOCK = 9;
const STRIDE = 4;

const cameraRight = uniform(new THREE.Vector3(1, 0, 0));
const cameraUp = uniform(new THREE.Vector3(0, 1, 0));
/** Flock altitude follows the camera's (smoothed): the world has no single ground height here. */
const baseHeight = uniform(0);
const visible = uniform(1);

let sharedMaterial: THREE.MeshBasicNodeMaterial | null = null;

export function birdMaterial(): THREE.MeshBasicNodeMaterial {
  if (sharedMaterial) return sharedMaterial;
  const m = new THREE.MeshBasicNodeMaterial({ transparent: false, alphaTest: 0.5, side: THREE.DoubleSide, fog: true });
  m.name = "birds";
  const b: N = attribute("aBird", "vec4"); // flock centre x, z; seed; flock altitude offset
  const seed: N = b.z;
  const speed: N = seed.mul(0.25).add(0.25).mul(step(0.5, seed).mul(2).sub(1)); // either way round
  const angle: N = time.mul(speed).add(seed.mul(40));
  const radius: N = seed.mul(18).add(10);
  const bob: N = sin(time.mul(0.6).add(seed.mul(13))).mul(2.5);
  const centre: N = vec3(
    b.x.add(cos(angle).mul(radius)),
    baseHeight.add(b.w).add(bob).add(seed.mul(6)),
    b.y.add(sin(angle).mul(radius)),
  );
  const size: N = float(1.3).mul(visible);
  const corner: N = positionLocal.xy.mul(size);
  m.positionNode = centre.add(cameraRight.mul(corner.x)).add(cameraUp.mul(corner.y));
  // a V of two wings that beat: |y - k|x|| thin, the k swinging with the stroke
  const p: N = uv().sub(0.5).mul(2);
  const beat: N = sin(time.mul(seed.mul(3).add(7)).add(seed.mul(9)));
  const k: N = beat.mul(0.55).add(0.15);
  const wing: N = smoothstep(0.16, 0.07, abs(p.y.sub(abs(p.x).mul(k))));
  const span: N = step(abs(p.x), float(0.95));
  const body: N = smoothstep(0.2, 0.1, p.length());
  m.opacityNode = wing.mul(span).add(body);
  m.colorNode = mix(vec3(0.03, 0.03, 0.035), vec3(0.08, 0.08, 0.09), seed);
  sharedMaterial = m;
  return m;
}

export class Birds {
  private readonly geometry = new THREE.InstancedBufferGeometry();
  private readonly mesh: THREE.Mesh;
  private readonly data = new Float32Array(9 * BIRDS_PER_FLOCK * STRIDE);
  private cellX = Number.NaN;
  private cellZ = Number.NaN;
  private host: THREE.Scene | null = null;
  private readonly cam = new THREE.Vector3();
  private height = Number.NaN;
  /** 0..1 how many birds the weather allows (rain grounds them). */
  private weather = 1;

  constructor() {
    const quad = new THREE.PlaneGeometry(1, 1);
    this.geometry.index = quad.index;
    this.geometry.setAttribute("position", quad.getAttribute("position"));
    this.geometry.setAttribute("uv", quad.getAttribute("uv"));
    this.geometry.setAttribute("aBird", new THREE.InstancedBufferAttribute(this.data, STRIDE));
    this.geometry.instanceCount = 0;
    this.mesh = new THREE.Mesh(this.geometry, birdMaterial());
    this.mesh.name = "__birds";
    this.mesh.frustumCulled = false;
    this.mesh.matrixAutoUpdate = false;
    this.mesh.castShadow = false;
    this.mesh.raycast = () => {};
  }

  /** How wet the weather is (0..1): birds take cover in rain. */
  setWeather(wet: number): void {
    this.weather = 1 - Math.min(1, Math.max(0, wet) * 1.5);
  }

  update(scene: THREE.Scene, camera: THREE.Camera, dt: number): void {
    if (this.host !== scene) {
      this.mesh.removeFromParent();
      scene.add(this.mesh);
      this.host = scene;
      this.cellX = Number.NaN;
    }
    camera.getWorldPosition(this.cam);
    this.height = Number.isNaN(this.height) ? this.cam.y : this.height + (this.cam.y - this.height) * Math.min(1, dt * 0.3);
    baseHeight.value = this.height + 22;
    const day = THREE.MathUtils.smoothstep(worldDaylight.value, 0.35, 0.7);
    visible.value = day * this.weather;
    this.mesh.visible = visible.value > 0.02;
    const e = camera.matrixWorld.elements;
    cameraRight.value.set(e[0]!, e[1]!, e[2]!).normalize();
    cameraUp.value.set(e[4]!, e[5]!, e[6]!).normalize();
    const cx = Math.floor(this.cam.x / CELL), cz = Math.floor(this.cam.z / CELL);
    if (cx === this.cellX && cz === this.cellZ) return;
    this.cellX = cx;
    this.cellZ = cz;
    let o = 0;
    for (let dx = -1; dx <= 1; dx++) {
      for (let dz = -1; dz <= 1; dz++) {
        const gx = cx + dx, gz = cz + dz;
        const h = hash(gx, gz);
        if (h > FLOCK_CHANCE) continue;
        const fx = (gx + 0.2 + 0.6 * hash(gz, gx)) * CELL;
        const fz = (gz + 0.2 + 0.6 * hash(gx + 7, gz - 3)) * CELL;
        const altitude = 6 + 18 * hash(gx - 5, gz + 11);
        for (let i = 0; i < BIRDS_PER_FLOCK; i++) {
          this.data[o++] = fx;
          this.data[o++] = fz;
          this.data[o++] = hash(gx * 31 + i, gz * 17 - i);
          this.data[o++] = altitude;
        }
      }
    }
    this.geometry.instanceCount = o / STRIDE;
    (this.geometry.getAttribute("aBird") as THREE.InstancedBufferAttribute).needsUpdate = true;
  }

  dispose(): void {
    this.mesh.removeFromParent();
    this.host = null;
  }
}

function hash(x: number, z: number): number {
  const h = Math.sin(x * 127.1 + z * 311.7) * 43758.5453;
  return h - Math.floor(h);
}

export const birds = new Birds();

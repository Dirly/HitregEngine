import * as THREE from "three/webgpu";
import {
  attribute,
  float,
  fract,
  length,
  mix,
  positionLocal,
  pow,
  saturate,
  sin,
  smoothstep,
  time,
  uniform,
  uv,
  vec3,
} from "three/tsl";
import { foliageWindScale } from "./foliage-wind.js";
import { worldDaylight } from "./daylight.js";

/* eslint-disable @typescript-eslint/no-explicit-any */
type N = any;

/**
 * Smoke from town chimneys — found in the building models themselves, drawn
 * as ONE instanced batch for every chimney in the world, and animated
 * entirely on the GPU (no per-frame CPU work beyond a uniform or two).
 *
 * Detection ({@link findChimneys}) runs once per loaded building model: a
 * chimney top is a small, roughly square, flat upward face high on the model
 * with nothing above it and at least one side dropping away below it. That
 * rules out pillar tops under a roof, ridge caps (long and thin) and
 * battlements or post rows (they come in rows of equal caps). The tops are stored on the
 * cached model; every placed copy registers them with {@link ChimneySmoke}.
 *
 * Each chimney is PUFFS quads cycling through one rise: born small at the
 * cap, swelling, leaning downwind and thinning out. About one in seven of the
 * chimneys are cold (a hash of their position), more draw at night.
 */
export const CHIMNEYS_KEY = "hitregChimneys";

const PUFFS = 10;
/** Seconds for one puff to rise and fade. */
const PERIOD = 7;
const RISE = 10;
const INITIAL_CAPACITY = 32 * PUFFS;

const cameraRight = uniform(new THREE.Vector3(1, 0, 0));
const cameraUp = uniform(new THREE.Vector3(0, 1, 0));
/** Downwind direction on the ground (unit xz) — the weather's wind. */
export const smokeWind = uniform(new THREE.Vector2(0.8, 0.6));
const daylight = uniform(1);

/** Point the smoke downwind (radians about +Y, the weather's `windAngle`). */
export function setSmokeWindAngle(angle: number): void {
  // the weather builtin's convention: (sin, cos) on (x, z)
  smokeWind.value.set(Math.sin(angle), Math.cos(angle));
}

/* ---------- detection ---------- */

/** Chimney tops of a static model, in `root` space. */
export function findChimneys(root: THREE.Object3D, skip?: (material: THREE.Material) => boolean): THREE.Vector3[] {
  root.updateMatrixWorld(true);
  const toRoot = new THREE.Matrix4().copy(root.matrixWorld).invert();
  const tris: number[] = []; // 9 floats per triangle, root space
  const ups: { y: number; ax: number; az: number; bx: number; bz: number; cx: number; cz: number; area: number }[] = [];
  const m = new THREE.Matrix4();
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3(), n = new THREE.Vector3();
  root.traverse((node) => {
    const mesh = node as THREE.Mesh;
    if (!mesh.isMesh || !mesh.geometry?.getAttribute("position")) return;
    if (skip && !Array.isArray(mesh.material) && skip(mesh.material)) return;
    m.multiplyMatrices(toRoot, mesh.matrixWorld);
    const pos = mesh.geometry.getAttribute("position");
    const index = mesh.geometry.index;
    const count = index ? index.count : pos.count;
    for (let i = 0; i + 2 < count; i += 3) {
      const ia = index ? index.getX(i) : i, ib = index ? index.getX(i + 1) : i + 1, ic = index ? index.getX(i + 2) : i + 2;
      a.fromBufferAttribute(pos, ia).applyMatrix4(m);
      b.fromBufferAttribute(pos, ib).applyMatrix4(m);
      c.fromBufferAttribute(pos, ic).applyMatrix4(m);
      tris.push(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z);
      n.subVectors(b, a).cross(c.clone().sub(a));
      const len = n.length();
      if (len > 1e-9 && n.y / len > 0.95) ups.push({ y: (a.y + b.y + c.y) / 3, ax: a.x, az: a.z, bx: b.x, bz: b.z, cx: c.x, cz: c.z, area: len / 2 });
    }
  });
  if (tris.length === 0) return [];
  let minY = Infinity, maxY = -Infinity;
  for (let i = 1; i < tris.length; i += 3) {
    minY = Math.min(minY, tris[i]!);
    maxY = Math.max(maxY, tris[i]!);
  }
  const height = maxY - minY;

  // up-facing triangles → flat patches (same height, overlapping/adjacent)
  type Patch = { y: number; x0: number; x1: number; z0: number; z1: number; area: number };
  const patches: Patch[] = [];
  for (const t of ups) {
    const x0 = Math.min(t.ax, t.bx, t.cx), x1 = Math.max(t.ax, t.bx, t.cx);
    const z0 = Math.min(t.az, t.bz, t.cz), z1 = Math.max(t.az, t.bz, t.cz);
    const hit = patches.find((p) => Math.abs(p.y - t.y) < 0.03 && x0 <= p.x1 + 0.02 && x1 >= p.x0 - 0.02 && z0 <= p.z1 + 0.02 && z1 >= p.z0 - 0.02);
    if (hit) {
      hit.x0 = Math.min(hit.x0, x0); hit.x1 = Math.max(hit.x1, x1);
      hit.z0 = Math.min(hit.z0, z0); hit.z1 = Math.max(hit.z1, z1);
      hit.area += t.area;
    } else patches.push({ y: t.y, x0, x1, z0, z1, area: t.area });
  }

  // highest surface over (x, z), or -Infinity: a vertical ray against every triangle
  const highestAt = (x: number, z: number, above = -Infinity): number => {
    let best = -Infinity;
    for (let i = 0; i < tris.length; i += 9) {
      const x1 = tris[i]!, z1 = tris[i + 2]!, x2 = tris[i + 3]!, z2 = tris[i + 5]!, x3 = tris[i + 6]!, z3 = tris[i + 8]!;
      const d = (z2 - z3) * (x1 - x3) + (x3 - x2) * (z1 - z3);
      if (Math.abs(d) < 1e-12) continue;
      const w1 = ((z2 - z3) * (x - x3) + (x3 - x2) * (z - z3)) / d;
      const w2 = ((z3 - z1) * (x - x3) + (x1 - x3) * (z - z3)) / d;
      const w3 = 1 - w1 - w2;
      if (w1 < 0 || w2 < 0 || w3 < 0) continue;
      const y = w1 * tris[i + 1]! + w2 * tris[i + 4]! + w3 * tris[i + 7]!;
      if (y > above && y > best) best = y;
    }
    return best;
  };

  // candidates: small, squarish, high, flat tops with nothing above them
  const candidates = patches.filter((p) => {
    const w = p.x1 - p.x0, d = p.z1 - p.z0;
    if (p.y < minY + height * 0.45) return false;
    if (p.area < 0.08 || p.area > 2.6 || w < 0.25 || d < 0.25) return false;
    if (Math.max(w, d) / Math.min(w, d) > 2.5) return false;
    // nothing above it (a post under a roof is not a chimney)
    return highestAt((p.x0 + p.x1) / 2, (p.z0 + p.z1) / 2, p.y + 0.05) === -Infinity;
  });
  const found: THREE.Vector3[] = [];
  for (const p of candidates) {
    const x = (p.x0 + p.x1) / 2, z = (p.z0 + p.z1) / 2;
    // battlements and post rows come in rows of equal caps; a chimney stands alone
    const row = candidates.some((q) => q !== p && Math.abs(q.y - p.y) < 0.3 &&
      Math.hypot((q.x0 + q.x1) / 2 - x, (q.z0 + q.z1) / 2 - z) < 2.5 && Math.hypot((q.x0 + q.x1) / 2 - x, (q.z0 + q.z1) / 2 - z) > 0.6);
    if (row) continue;
    // and it stands out of something: at least one side drops away below it
    const reach = Math.max(p.x1 - p.x0, p.z1 - p.z0) / 2 + 0.4;
    let drops = false;
    for (const [dx, dz] of [[reach, 0], [-reach, 0], [0, reach], [0, -reach]] as const) {
      if (highestAt(x + dx, z + dz) < p.y - 0.3) drops = true;
    }
    if (!drops) continue;
    // a stack seen twice (a cap and its rim): keep the higher
    const twin = found.find((f) => Math.hypot(f.x - x, f.z - z) < 1.2);
    if (twin) {
      if (p.y > twin.y) twin.set(x, p.y, z);
      continue;
    }
    found.push(new THREE.Vector3(x, p.y, z));
  }
  return found.slice(0, 6);
}

/* ---------- drawing ---------- */

let sharedMaterial: THREE.MeshBasicNodeMaterial | null = null;

export function smokeMaterial(): THREE.MeshBasicNodeMaterial {
  if (sharedMaterial) return sharedMaterial;
  const m = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, fog: true });
  m.name = "chimney-smoke";
  const puff: N = attribute("aSmoke", "vec4"); // chimney xyz, phase (0..1) + 10 * strength
  const strength: N = puff.w.div(10).floor().div(10);
  const phase: N = fract(puff.w);
  const age: N = fract(time.div(PERIOD).add(phase));
  const wind: N = foliageWindScale.mul(0.6).add(0.4);
  const lean: N = vec3(smokeWind.x, 0, smokeWind.y).mul(age.mul(age).mul(wind).mul(4.5));
  const wobble: N = vec3(sin(time.mul(0.7).add(phase.mul(40))), 0, sin(time.mul(0.5).add(phase.mul(23)))).mul(age.mul(0.6));
  const centre: N = puff.xyz.add(vec3(0, age.mul(RISE), 0)).add(lean).add(wobble);
  const size: N = age.mul(2.0).add(0.4);
  const corner: N = positionLocal.xy.mul(size);
  m.positionNode = centre.add(cameraRight.mul(corner.x)).add(cameraUp.mul(corner.y));
  // a soft, slightly lumpy puff: radial falloff broken by the phase
  const p: N = uv().sub(0.5).mul(2);
  const lump: N = sin(p.x.mul(5).add(phase.mul(30))).mul(sin(p.y.mul(4).add(phase.mul(17)))).mul(0.12);
  const body: N = saturate(float(1).sub(length(p).add(lump)));
  const life: N = smoothstep(0, 0.08, age).mul(pow(float(1).sub(age), float(1.6)));
  m.opacityNode = body.mul(life).mul(strength).mul(0.6);
  // grey by day, cold blue-grey by moonlight, barely warm at the root
  // a shade darker than the cloud deck, so it reads against a grey sky
  // at night a moonlit grey a touch lighter than the night sky (dark smoke
  // read as a black hole in it); by day a shade under the cloud deck
  const day: N = mix(vec3(0.16, 0.17, 0.21), vec3(0.36, 0.35, 0.34), daylight);
  m.colorNode = mix(day.add(vec3(0.06, 0.03, 0.0).mul(float(1).sub(daylight))), day, smoothstep(0, 0.25, age));
  sharedMaterial = m;
  return m;
}

interface Owner {
  root: THREE.Object3D;
  local: THREE.Vector3[];
}

/** Every chimney in the scene, one draw. Hosts call {@link update} once a frame. */
export class ChimneySmoke {
  private readonly owners = new Set<Owner>();
  private readonly geometry = new THREE.InstancedBufferGeometry();
  private readonly mesh: THREE.Mesh;
  private data = new Float32Array(INITIAL_CAPACITY * 4);
  private dirty = false;
  private frame = 0;
  private host: THREE.Scene | null = null;

  constructor() {
    const quad = new THREE.PlaneGeometry(1, 1);
    this.geometry.index = quad.index;
    this.geometry.setAttribute("position", quad.getAttribute("position"));
    this.geometry.setAttribute("uv", quad.getAttribute("uv"));
    this.setBuffer(INITIAL_CAPACITY);
    this.geometry.instanceCount = 0;
    this.mesh = new THREE.Mesh(this.geometry, smokeMaterial());
    this.mesh.name = "__chimneySmoke";
    this.mesh.frustumCulled = false;
    this.mesh.matrixAutoUpdate = false;
    this.mesh.castShadow = false;
    this.mesh.receiveShadow = false;
    this.mesh.renderOrder = 8;
    this.mesh.raycast = () => {};
    this.mesh.visible = false;
  }

  private setBuffer(capacity: number): void {
    this.data = new Float32Array(capacity * 4);
    const attr = new THREE.InstancedBufferAttribute(this.data, 4);
    attr.name = "chimney-smoke";
    this.geometry.setAttribute("aSmoke", attr);
  }

  /** A placed building: its model root carries `userData[CHIMNEYS_KEY]` (root-space tops). */
  register(root: THREE.Object3D): void {
    const tops = root.userData[CHIMNEYS_KEY] as [number, number, number][] | undefined;
    if (!tops || tops.length === 0) return;
    this.owners.add({ root, local: tops.map((t) => new THREE.Vector3(t[0], t[1], t[2])) });
    this.dirty = true;
  }

  update(scene: THREE.Scene, camera: THREE.Camera): void {
    if (this.host !== scene) {
      this.mesh.removeFromParent();
      scene.add(this.mesh);
      this.host = scene;
      this.dirty = true;
    }
    // unloaded buildings drop out (a chunk streamed away, a rebuild)
    if (++this.frame % 60 === 0) {
      for (const owner of this.owners) {
        if (!inScene(owner.root, scene)) {
          this.owners.delete(owner);
          this.dirty = true;
        }
      }
    }
    if (this.dirty) this.rebuild();
    camera.updateMatrixWorld();
    const e = camera.matrixWorld.elements;
    cameraRight.value.set(e[0]!, e[1]!, e[2]!).normalize();
    cameraUp.value.set(e[4]!, e[5]!, e[6]!).normalize();
    // more fires lit after dark; the hearths never quite go out by day
    daylight.value = worldDaylight.value;
  }

  private rebuild(): void {
    this.dirty = false;
    let count = 0;
    for (const owner of this.owners) count += owner.local.length * PUFFS;
    if (count * 4 > this.data.length) this.setBuffer(Math.max(count, this.data.length / 2) * 2);
    const d = this.data;
    const world = new THREE.Vector3();
    let o = 0;
    for (const owner of this.owners) {
      owner.root.updateWorldMatrix(true, false);
      for (const top of owner.local) {
        world.copy(top).applyMatrix4(owner.root.matrixWorld);
        // cold chimneys and how thick a lit one draws, from where it stands
        const h = Math.abs(Math.sin(world.x * 12.9898 + world.z * 78.233) * 43758.5453) % 1;
        const strength = h < 0.15 ? 0 : 0.6 + 0.4 * ((h * 7.31) % 1);
        if (strength === 0) continue;
        for (let i = 0; i < PUFFS; i++) {
          d[o++] = world.x;
          d[o++] = world.y + 0.1;
          d[o++] = world.z;
          // integer part: strength in tenths ×10; fraction: phase
          d[o++] = Math.round(strength * 10) * 10 + ((i / PUFFS + h * 0.37) % 1) * 0.999;
        }
      }
    }
    const instances = o / 4;
    this.geometry.instanceCount = instances;
    (this.geometry.getAttribute("aSmoke") as THREE.InstancedBufferAttribute).needsUpdate = true;
    this.mesh.visible = instances > 0;
  }

  stats(): { chimneys: number; puffs: number } {
    let chimneys = 0;
    for (const owner of this.owners) chimneys += owner.local.length;
    return { chimneys, puffs: this.geometry.instanceCount };
  }

  dispose(): void {
    this.mesh.removeFromParent();
    this.owners.clear();
    this.host = null;
  }
}

function inScene(object: THREE.Object3D, scene: THREE.Scene): boolean {
  let current: THREE.Object3D | null = object;
  while (current?.parent) current = current.parent;
  return current === scene;
}

/** The one smoke batch the scene builder registers buildings with. */
export const chimneySmoke = new ChimneySmoke();

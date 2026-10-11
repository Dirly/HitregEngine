import * as THREE from "three/webgpu";
import {
  attribute,
  cameraPosition,
  distance,
  dot,
  float,
  length,
  max,
  normalize,
  positionLocal,
  pow,
  saturate,
  smoothstep,
  uniform,
  uv,
  vec3,
} from "three/tsl";
import { windowLight } from "./window-lights.js";

/* eslint-disable @typescript-eslint/no-explicit-any */
type N = any;

/**
 * Lit windows seen from far away: a town across the bay at night is a
 * scatter of warm specks, but a real window shrinks below a pixel by a few
 * hundred metres and its light card fades out at 240 m. So every placed
 * building registers its windows (found at load, window-lights.ts) here,
 * and ONE instanced draw puts a tiny camera-facing dot on each — never
 * smaller than a pixel or two, fading in as the close-up cards fade out,
 * lit or dark by the same per-window seed the glass uses so the two never
 * disagree. Faces turned away from the camera stay dark.
 */
export const WINDOWS_KEY = "hitregWindows";
/** Floats per window in the model's userData: centre xyz, seed, normal x, normal z. */
export const WINDOW_STRIDE = 6;

const NEAR_FADE: [number, number] = [150, 260];
const FAR_FADE: [number, number] = [2600, 3400];
/** Angular size floor: radius ≥ this × distance (≈ 1.5 px at 1080p, 60° fov). */
const MIN_ANGULAR = 0.0016;

const cameraRight = uniform(new THREE.Vector3(1, 0, 0));
const cameraUp = uniform(new THREE.Vector3(0, 1, 0));

let sharedMaterial: THREE.MeshBasicNodeMaterial | null = null;

export function distantWindowMaterial(): THREE.MeshBasicNodeMaterial {
  if (sharedMaterial) return sharedMaterial;
  const m = new THREE.MeshBasicNodeMaterial({
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    fog: false,
  });
  m.name = "distant-windows";
  const a: N = attribute("aWin", "vec4"); // centre xyz, seed
  const n: N = attribute("aWinN", "vec2"); // outward normal x, z
  const centre: N = a.xyz;
  const d: N = distance(cameraPosition, centre);
  const radius: N = max(float(0.7), d.mul(MIN_ANGULAR));
  const toCam: N = normalize(cameraPosition.sub(centre));
  const corner: N = positionLocal.xy.mul(radius.mul(2));
  // nudged toward the camera so the wall it sits on does not hide it
  m.positionNode = centre.add(cameraRight.mul(corner.x)).add(cameraUp.mul(corner.y)).add(toCam.mul(1.2));
  const facing: N = saturate(dot(vec3(n.x, 0, n.y), toCam).mul(3));
  const fade: N = smoothstep(NEAR_FADE[0], NEAR_FADE[1], d).mul(float(1).sub(smoothstep(FAR_FADE[0], FAR_FADE[1], d)));
  const r: N = length(uv().sub(0.5)).mul(2);
  const dot_: N = pow(saturate(float(1).sub(r)), float(1.5));
  m.colorNode = windowLight(a.w).mul(dot_).mul(facing).mul(fade).mul(1.6);
  sharedMaterial = m;
  return m;
}

interface Owner {
  root: THREE.Object3D;
  data: number[];
}

export class DistantWindows {
  private readonly owners = new Set<Owner>();
  private readonly geometry = new THREE.InstancedBufferGeometry();
  private readonly mesh: THREE.Mesh;
  private dirty = false;
  private frame = 0;
  private host: THREE.Scene | null = null;

  constructor() {
    const quad = new THREE.PlaneGeometry(1, 1);
    this.geometry.index = quad.index;
    this.geometry.setAttribute("position", quad.getAttribute("position"));
    this.geometry.setAttribute("uv", quad.getAttribute("uv"));
    this.setBuffers(256);
    this.geometry.instanceCount = 0;
    this.mesh = new THREE.Mesh(this.geometry, distantWindowMaterial());
    this.mesh.name = "__distantWindows";
    this.mesh.frustumCulled = false;
    this.mesh.matrixAutoUpdate = false;
    this.mesh.castShadow = false;
    this.mesh.renderOrder = 9;
    this.mesh.raycast = () => {};
    this.mesh.visible = false;
  }

  private setBuffers(capacity: number): void {
    this.geometry.setAttribute("aWin", new THREE.InstancedBufferAttribute(new Float32Array(capacity * 4), 4));
    this.geometry.setAttribute("aWinN", new THREE.InstancedBufferAttribute(new Float32Array(capacity * 2), 2));
  }

  /** A placed building: its model root carries `userData[WINDOWS_KEY]`. */
  register(root: THREE.Object3D): void {
    const data = root.userData[WINDOWS_KEY] as number[] | undefined;
    if (!data || data.length === 0) return;
    this.owners.add({ root, data });
    this.dirty = true;
  }

  update(scene: THREE.Scene, camera: THREE.Camera): void {
    if (this.host !== scene) {
      this.mesh.removeFromParent();
      scene.add(this.mesh);
      this.host = scene;
      this.dirty = true;
    }
    if (++this.frame % 60 === 0) {
      for (const owner of this.owners) {
        if (!inScene(owner.root, scene)) {
          this.owners.delete(owner);
          this.dirty = true;
        }
      }
    }
    if (this.dirty) this.rebuild();
    const e = camera.matrixWorld.elements;
    cameraRight.value.set(e[0]!, e[1]!, e[2]!).normalize();
    cameraUp.value.set(e[4]!, e[5]!, e[6]!).normalize();
  }

  private rebuild(): void {
    this.dirty = false;
    let count = 0;
    for (const owner of this.owners) count += owner.data.length / WINDOW_STRIDE;
    let win = this.geometry.getAttribute("aWin") as THREE.InstancedBufferAttribute;
    if (win.count < count) {
      this.setBuffers(Math.max(count, win.count * 2));
      win = this.geometry.getAttribute("aWin") as THREE.InstancedBufferAttribute;
    }
    const nrm = this.geometry.getAttribute("aWinN") as THREE.InstancedBufferAttribute;
    const w = win.array as Float32Array, nn = nrm.array as Float32Array;
    const p = new THREE.Vector3(), q = new THREE.Vector3();
    let i = 0;
    for (const owner of this.owners) {
      owner.root.updateWorldMatrix(true, false);
      const m = owner.root.matrixWorld;
      for (let k = 0; k < owner.data.length; k += WINDOW_STRIDE) {
        const d = owner.data;
        p.set(d[k]!, d[k + 1]!, d[k + 2]!).applyMatrix4(m);
        q.set(d[k + 4]!, 0, d[k + 5]!).transformDirection(m);
        w[i * 4] = p.x; w[i * 4 + 1] = p.y; w[i * 4 + 2] = p.z; w[i * 4 + 3] = d[k + 3]!;
        nn[i * 2] = q.x; nn[i * 2 + 1] = q.z;
        i++;
      }
    }
    this.geometry.instanceCount = i;
    win.needsUpdate = true;
    nrm.needsUpdate = true;
    this.mesh.visible = i > 0;
  }

  stats(): number {
    return this.geometry.instanceCount;
  }
}

function inScene(object: THREE.Object3D, scene: THREE.Scene): boolean {
  let current: THREE.Object3D | null = object;
  while (current?.parent) current = current.parent;
  return current === scene;
}

/** The one batch the scene builder registers buildings with. */
export const distantWindows = new DistantWindows();

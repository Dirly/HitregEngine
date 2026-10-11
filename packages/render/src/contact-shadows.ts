import * as THREE from "three/webgpu";
import {
  attribute,
  cameraProjectionMatrixInverse,
  cameraWorldMatrix,
  float,
  getViewPosition,
  positionLocal,
  saturate,
  screenUV,
  smoothstep,
  vec2,
  vec3,
  vec4,
  viewportDepthTexture,
} from "three/tsl";
import { readWorldPosition } from "./static-transforms.js";
import { setGrassPushers } from "./grass-push.js";

/* eslint-disable @typescript-eslint/no-explicit-any */
type N = any;

/**
 * A soft dark patch on the ground under every nearby character — what keeps
 * a figure standing ON the cobbles rather than hovering, at any sun angle,
 * at night, and past the range the sun's shadow maps reach. Drawn like the
 * light pools: a box per character, back faces, no depth test, reading the
 * opaque scene's depth to find the surface, so it lies on slopes and steps
 * and never on the character itself (only surfaces at or below the feet).
 * Multiplied into what is already there. One instanced draw.
 */
const MAX = 32;
const RANGE = 70;
const RADIUS = 0.75;
const STRIDE = 4;

let sharedMaterial: THREE.MeshBasicNodeMaterial | null = null;

export function shadowMaterial(): THREE.MeshBasicNodeMaterial {
  if (sharedMaterial) return sharedMaterial;
  const m = new THREE.MeshBasicNodeMaterial({
    transparent: true,
    depthWrite: false,
    depthTest: false,
    side: THREE.BackSide,
    fog: false,
    blending: THREE.CustomBlending,
    blendEquation: THREE.AddEquation,
    blendSrc: THREE.ZeroFactor,
    blendDst: THREE.SrcColorFactor,
  });
  m.name = "contact-shadows";
  const a: N = attribute("aContact", "vec4"); // feet xyz, strength
  m.positionNode = positionLocal.mul(vec3(RADIUS * 2, 1.6, RADIUS * 2)).add(a.xyz);
  const surfaceView: N = getViewPosition(screenUV, viewportDepthTexture(), cameraProjectionMatrixInverse);
  const surface: N = cameraWorldMatrix.mul(vec4(surfaceView, 1)).xyz;
  const r: N = vec2(surface.x.sub(a.x), surface.z.sub(a.z)).length().div(RADIUS);
  const dy: N = surface.y.sub(a.y);
  // ground at the feet: from a little below them to just above the soles
  const ground: N = smoothstep(0.25, 0.05, dy).mul(smoothstep(-0.7, -0.3, dy));
  const dark: N = saturate(float(1).sub(r)).mul(saturate(float(1).sub(r))).mul(ground).mul(a.w).mul(0.45);
  m.colorNode = vec3(float(1).sub(dark));
  sharedMaterial = m;
  return m;
}

class ContactShadows {
  private readonly data = new Float32Array(MAX * STRIDE);
  private readonly geometry = new THREE.InstancedBufferGeometry();
  private readonly mesh: THREE.Mesh;
  private host: THREE.Scene | null = null;
  private readonly cam = new THREE.Vector3();
  private readonly pos = new THREE.Vector3();
  private readonly near: { x: number; y: number; z: number; d: number }[] = [];

  constructor() {
    const box = new THREE.BoxGeometry(1, 1, 1);
    this.geometry.index = box.index;
    this.geometry.setAttribute("position", box.getAttribute("position"));
    const attr = new THREE.InstancedBufferAttribute(this.data, STRIDE);
    attr.setUsage(THREE.DynamicDrawUsage);
    this.geometry.setAttribute("aContact", attr);
    this.geometry.instanceCount = 0;
    this.mesh = new THREE.Mesh(this.geometry, shadowMaterial());
    this.mesh.name = "__contactShadows";
    this.mesh.frustumCulled = false;
    this.mesh.matrixAutoUpdate = false;
    this.mesh.castShadow = false;
    this.mesh.renderOrder = 4;
    this.mesh.raycast = () => {};
  }

  update(roots: Iterable<THREE.Object3D>, scene: THREE.Scene, camera: THREE.Camera): void {
    if (this.host !== scene) {
      this.mesh.removeFromParent();
      scene.add(this.mesh);
      this.host = scene;
    }
    camera.getWorldPosition(this.cam);
    let n = 0;
    for (const root of roots) {
      if (!root.parent || !root.visible) continue;
      readWorldPosition(root, this.pos);
      const d = this.pos.distanceTo(this.cam);
      if (d > RANGE) continue;
      const e = (this.near[n] ??= { x: 0, y: 0, z: 0, d: 0 });
      e.x = this.pos.x; e.y = this.pos.y; e.z = this.pos.z; e.d = d;
      n++;
    }
    const live = this.near.slice(0, n).sort((p, q) => p.d - q.d);
    let o = 0;
    for (let i = 0; i < Math.min(MAX, live.length); i++) {
      const e = live[i]!;
      this.data[o++] = e.x;
      this.data[o++] = e.y;
      this.data[o++] = e.z;
      this.data[o++] = 1 - THREE.MathUtils.smoothstep(e.d, RANGE * 0.75, RANGE);
    }
    this.geometry.instanceCount = o / STRIDE;
    this.mesh.visible = o > 0;
    const attr = this.geometry.getAttribute("aContact") as THREE.InstancedBufferAttribute;
    attr.addUpdateRange(0, o);
    attr.needsUpdate = true;
  }
}

const contactShadows = new ContactShadows();

/**
 * Everything that follows the characters each frame: grass parting around
 * them and the soft contact patch under their feet. `roots` = every animated
 * character (AnimationSystem.roots()).
 */
export function updateCharacterGrounding(roots: Iterable<THREE.Object3D>, scene: THREE.Scene, camera: THREE.Camera): void {
  // one walk of the iterator, into a reused array (this runs every frame)
  rootList.length = 0;
  for (const root of roots) rootList.push(root);
  setGrassPushers(rootList, camera);
  contactShadows.update(rootList, scene, camera);
}
const rootList: THREE.Object3D[] = [];

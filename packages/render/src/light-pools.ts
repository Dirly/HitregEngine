import * as THREE from "three/webgpu";
import {
  attribute,
  cameraProjectionMatrixInverse,
  cameraViewMatrix,
  cameraWorldMatrix,
  cross,
  dFdx,
  dFdy,
  dot,
  float,
  getViewPosition,
  max,
  normalize,
  pow,
  positionLocal,
  saturate,
  screenUV,
  vec3,
  vec4,
  viewportDepthTexture,
} from "three/tsl";
import { confineMask, packConfine, type LightConfine } from "./light-confine.js";

/* eslint-disable @typescript-eslint/no-explicit-any */
type N = any;

/** Pools never draw past this camera distance (metres), fading over the last fifth. */
const POOL_FAR = 160;
/** At most this many pools a frame (nearest first, after the budgeted lights). */
export const MAX_POOLS = 96;
/** Floats per pool: centre xyz + range, colour rgb + fade, then the confine (light-confine.ts): centre xyz + cos, half xyz + sin. */
const STRIDE = 16;
/** Assumed albedo of whatever the pool lands on (it cannot read the surface's own). */
const ALBEDO = 0.35;

let sharedMaterial: THREE.MeshBasicNodeMaterial | null = null;

/**
 * Screen-space light volumes for the point lights the forward budget did NOT
 * pick — a distant lantern still lays a warm pool on the cobbles and the wall
 * behind it, without taking a light slot or touching any material.
 *
 * Each pool is a box around the light's range drawn back faces only, no depth
 * test: for every pixel it covers it reads the opaque scene's depth, rebuilds
 * that surface's position (and a facet normal from its screen derivatives) and
 * adds the light's Lambert term with three's own range falloff, onto an assumed
 * mid-dark albedo. Surfaces outside the range get exactly zero, so walls in
 * front of a light hide its pool for free. One instanced draw for all of them.
 */
export function poolMaterial(): THREE.MeshBasicNodeMaterial {
  if (sharedMaterial) return sharedMaterial;
  const m = new THREE.MeshBasicNodeMaterial({
    transparent: true,
    depthWrite: false,
    depthTest: false,
    side: THREE.BackSide,
    blending: THREE.AdditiveBlending,
    fog: false,
  });
  m.name = "light-pools";
  const a: N = attribute("aPool", "vec4"); // centre xyz, range
  const tint: N = attribute("aPoolColor", "vec4"); // colour * intensity, rgb; camera fade, a
  const confineA: N = attribute("aPoolConfineA", "vec4");
  const confineB: N = attribute("aPoolConfineB", "vec4");
  m.positionNode = positionLocal.mul(a.w.mul(2)).add(a.xyz);

  const depth: N = viewportDepthTexture();
  const surface: N = getViewPosition(screenUV, depth, cameraProjectionMatrixInverse);
  const light: N = cameraViewMatrix.mul(vec4(a.xyz, 1)).xyz;
  const toLight: N = light.sub(surface);
  const d2: N = max(dot(toLight, toLight), 0.04);
  const d: N = d2.sqrt();
  // three's physical point light: 1/d² windowed to zero at `range`
  const window: N = pow(saturate(float(1).sub(pow(d.div(a.w), 4))), 2);
  const n: N = normalize((cross as N)(dFdx(surface), dFdy(surface)));
  // facet normals flip with screen orientation: face the camera
  const facing: N = dot(n, surface).greaterThan(0).select(n.negate(), n);
  const lambert: N = saturate(dot(facing, toLight.div(d)).mul(0.8).add(0.2));
  const irradiance: N = window.div(d2).mul(lambert).mul(ALBEDO / Math.PI);
  // a room's lamp lays no pool outside its building (the street past the wall it stands behind)
  const world: N = cameraWorldMatrix.mul(vec4(surface, 1)).xyz;
  m.colorNode = vec3(tint.rgb).mul(irradiance).mul(tint.a).mul(confineMask(world, confineA, confineB));
  sharedMaterial = m;
  return m;
}

export class LightPools {
  private data = new Float32Array(MAX_POOLS * STRIDE);
  private readonly buffer: THREE.InstancedInterleavedBuffer;
  private readonly geometry = new THREE.InstancedBufferGeometry();
  private readonly mesh: THREE.Mesh;
  private count = 0;
  private host: THREE.Scene | null = null;

  constructor() {
    const box = new THREE.BoxGeometry(1, 1, 1);
    this.geometry.index = box.index;
    this.geometry.setAttribute("position", box.getAttribute("position"));
    this.buffer = new THREE.InstancedInterleavedBuffer(this.data, STRIDE, 1);
    this.buffer.setUsage(THREE.DynamicDrawUsage);
    Object.assign(this.buffer, { name: "light-pools" });
    this.geometry.setAttribute("aPool", new THREE.InterleavedBufferAttribute(this.buffer, 4, 0));
    this.geometry.setAttribute("aPoolColor", new THREE.InterleavedBufferAttribute(this.buffer, 4, 4));
    this.geometry.setAttribute("aPoolConfineA", new THREE.InterleavedBufferAttribute(this.buffer, 4, 8));
    this.geometry.setAttribute("aPoolConfineB", new THREE.InterleavedBufferAttribute(this.buffer, 4, 12));
    this.mesh = new THREE.Mesh(this.geometry, poolMaterial());
    this.mesh.name = "__lightPools";
    this.mesh.frustumCulled = false;
    this.mesh.matrixAutoUpdate = false;
    this.mesh.castShadow = false;
    this.mesh.receiveShadow = false;
    // after the opaque scene (it reads its depth), before the halos
    this.mesh.renderOrder = 5;
    this.mesh.raycast = () => {};
  }

  begin(): void {
    this.count = 0;
  }

  /** Queue one pool; `scale` is the light's on-ness (time of day), `confine` the box it may light. False when full. */
  add(light: THREE.PointLight, position: THREE.Vector3, cameraDistance: number, scale: number, confine: LightConfine | null = null): boolean {
    if (this.count >= MAX_POOLS) return false;
    const range = light.distance;
    if (!(range > 0) || scale <= 0.01 || light.intensity <= 0) return true;
    const fade = 1 - THREE.MathUtils.smoothstep(cameraDistance, POOL_FAR * 0.8, POOL_FAR);
    if (fade <= 0) return true;
    const o = this.count * STRIDE;
    const d = this.data;
    const k = light.intensity * scale;
    d[o] = position.x;
    d[o + 1] = position.y;
    d[o + 2] = position.z;
    d[o + 3] = range;
    d[o + 4] = light.color.r * k;
    d[o + 5] = light.color.g * k;
    d[o + 6] = light.color.b * k;
    d[o + 7] = fade;
    packConfine(confine, _a, _b);
    d[o + 8] = _a.x;
    d[o + 9] = _a.y;
    d[o + 10] = _a.z;
    d[o + 11] = _a.w;
    d[o + 12] = _b.x;
    d[o + 13] = _b.y;
    d[o + 14] = _b.z;
    d[o + 15] = _b.w;
    this.count++;
    return true;
  }

  end(scene: THREE.Scene): void {
    if (this.host !== scene) {
      this.mesh.removeFromParent();
      scene.add(this.mesh);
      this.host = scene;
    }
    this.geometry.instanceCount = this.count;
    this.mesh.visible = this.count > 0;
    if (this.count > 0) {
      this.buffer.addUpdateRange(0, this.count * STRIDE);
      this.buffer.needsUpdate = true;
    }
  }

  dispose(): void {
    this.mesh.removeFromParent();
    this.host = null;
    this.count = 0;
  }

  stats(): number {
    return this.count;
  }
}

const _a = new THREE.Vector4();
const _b = new THREE.Vector4();

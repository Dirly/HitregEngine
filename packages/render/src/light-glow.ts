import * as THREE from "three/webgpu";
import { attribute, cameraPosition, float, length, max, normalize, positionLocal, pow, saturate, uniform, uv, vec3 } from "three/tsl";
import { applyAdditiveFog } from "./additive-fog.js";

/* eslint-disable @typescript-eslint/no-explicit-any */
type N = any;

/** `light.glow` default when a light carries none (see the schema). */
export const DEFAULT_LIGHT_GLOW = 1;

/** Halos fade out between these camera distances (metres). */
const FADE_NEAR = 90;
const FADE_FAR = 140;
/** …and in over the first metre or so, so a lantern held to the face does not flood the screen. */
const CLOSE_FADE = 1.2;
/** `light.glow` above this draws as this: a halo is a modest glow round a flame, never the read itself. */
export const MAX_HALO_GLOW = 1.5;
/** Under full open daylight (worldDaylight.sunlit 1) a halo draws at this share of its strength and size. */
export const DAY_HALO_STRENGTH = 0.2;
export const DAY_HALO_SIZE = 0.5;
/** A far beacon's halo radius never shrinks under this angle (radians: ~3 px at 720p, vfov 60). */
export const FAR_HALO_ANGLE = 0.005;
/**
 * Fog transmission power for halos: a halo stands for a flame far brighter than the screen can hold, so it shows through
 * thick air as a small bright point where an LDR card would vanish (Red Dial 2026-10-30: the 450 m beacons in the zone
 * haze read only through 10 m halos; with the halo held to ~3 px they faded out). 1 = like a surface.
 */
export const HALO_FOG_THROUGH = 0.35;
const INITIAL_CAPACITY = 64;
/** Floats per halo: centre xyz + radius, colour rgb + nudge share (toward the camera). */
const STRIDE = 8;

const cameraRight = uniform(new THREE.Vector3(1, 0, 0));
const cameraUp = uniform(new THREE.Vector3(0, 1, 0));

let sharedMaterial: THREE.MeshBasicNodeMaterial | null = null;

/**
 * One additive material for every halo: a camera-facing quad grown from the
 * instance centre, nudged toward the camera by most of its radius so a
 * lantern's own glass or a sconce's bracket does not cut it in half. The
 * falloff is procedural (a wide soft skirt plus a tight core), so there is no
 * texture fetch at all.
 */
export function haloMaterial(): THREE.MeshBasicNodeMaterial {
  if (sharedMaterial) return sharedMaterial;
  const m = new THREE.MeshBasicNodeMaterial({
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    toneMapped: true,
  });
  applyAdditiveFog(m, HALO_FOG_THROUGH);
  m.name = "light-glow";
  const a: N = attribute("aHalo", "vec4");
  const tint: N = attribute("aHaloColor", "vec4");
  const centre: N = a.xyz;
  const radius: N = a.w;
  const toCamera: N = normalize(cameraPosition.sub(centre));
  const corner: N = positionLocal.xy.mul(radius.mul(2));
  m.positionNode = centre
    .add(cameraRight.mul(corner.x))
    .add(cameraUp.mul(corner.y))
    // tint.w: the nudge share (0 for a room's lamp seen from outside its building: light-confine.ts)
    .add(toCamera.mul(radius.mul(0.6).mul(tint.w)));
  const d: N = saturate(length(uv().sub(0.5)).mul(2));
  const skirt: N = pow(float(1).sub(d), float(2.6));
  const core: N = pow(max(float(1).sub(d.mul(2.2)), 0), float(2)).mul(0.5);
  m.colorNode = vec3(tint.rgb).mul(skirt.add(core));
  sharedMaterial = m;
  return m;
}

/**
 * Glow sprites around point lights — one instanced draw for every lamp,
 * torch, brazier and lit window light in view, with no light slot and no
 * texture. Fed by {@link LightBudgetSystem}, which already walks every point
 * light each frame: a lantern past the dynamic-light budget still shows its
 * halo, so a distant street reads lit even though only the nearest few
 * lights actually shade anything.
 */
export class LightGlows {
  private data = new Float32Array(INITIAL_CAPACITY * STRIDE);
  private buffer: THREE.InstancedInterleavedBuffer;
  private readonly geometry = new THREE.InstancedBufferGeometry();
  private readonly mesh: THREE.Mesh;
  private count = 0;
  private host: THREE.Scene | null = null;

  constructor() {
    const quad = new THREE.PlaneGeometry(1, 1);
    this.geometry.index = quad.index;
    this.geometry.setAttribute("position", quad.getAttribute("position"));
    this.geometry.setAttribute("uv", quad.getAttribute("uv"));
    this.buffer = this.allocate(INITIAL_CAPACITY);
    this.mesh = new THREE.Mesh(this.geometry, haloMaterial());
    this.mesh.name = "__lightGlows";
    this.mesh.frustumCulled = false;
    this.mesh.matrixAutoUpdate = false;
    this.mesh.castShadow = false;
    this.mesh.receiveShadow = false;
    this.mesh.renderOrder = 10;
    this.mesh.raycast = () => {};
  }

  private allocate(capacity: number): THREE.InstancedInterleavedBuffer {
    this.data = new Float32Array(capacity * STRIDE);
    const buffer = new THREE.InstancedInterleavedBuffer(this.data, STRIDE, 1);
    buffer.setUsage(THREE.DynamicDrawUsage);
    Object.assign(buffer, { name: "light-glows" });
    this.geometry.setAttribute("aHalo", new THREE.InterleavedBufferAttribute(buffer, 4, 0));
    this.geometry.setAttribute("aHaloColor", new THREE.InterleavedBufferAttribute(buffer, 4, 4));
    return buffer;
  }

  begin(): void {
    this.count = 0;
  }

  /**
   * Queue one halo. `glow` is the light's authored strength (0 = none),
   * `scale` its current on-ness (time of day; a fire's flicker is already in
   * `light.intensity`).
   */
  add(light: THREE.PointLight, position: THREE.Vector3, cameraDistance: number, glow: number, scale: number, reach?: number, sunlit = 0, nudge = 1): void {
    if (glow <= 0 || scale <= 0.01) return;
    // L (Red Dial 2026-10-30, Derek: "so washed out from how bright that lighting is"): glow 4 beacons with glowReach
    // 800 drew halos ~5 m in radius, growing with distance, at full strength at noon — 45-73 % of a street frame
    // brightened by 20+ luma. The halo is now capped (MAX_HALO_GLOW), small by day (open daylight: DAY_HALO_*), and a
    // far beacon holds a few pixels (FAR_HALO_ANGLE) instead of growing: a fire reads at distance by its FLAME.
    const g = Math.min(glow, MAX_HALO_GLOW);
    const night = 1 - THREE.MathUtils.clamp(sunlit, 0, 1);
    // a far beacon (`light.glowReach`) fades over the last third of its reach instead of 90-140 m
    const beacon = reach !== undefined && reach > FADE_FAR;
    const far = beacon
      ? 1 - THREE.MathUtils.smoothstep(cameraDistance, reach * 0.67, reach)
      : 1 - THREE.MathUtils.smoothstep(cameraDistance, FADE_NEAR, FADE_FAR);
    const near = THREE.MathUtils.smoothstep(cameraDistance, 0.3, CLOSE_FADE);
    // brightness follows intensity gently (a torch at 8 and a brazier at 15
    // should not differ by 2x in halo), size follows the room it lights
    const day = DAY_HALO_STRENGTH + (1 - DAY_HALO_STRENGTH) * night;
    const strength = g * scale * far * near * day * THREE.MathUtils.clamp(Math.sqrt(light.intensity / 8), 0.25, 1.6) * 0.3;
    if (strength <= 0.002) return;
    const size = DAY_HALO_SIZE + (1 - DAY_HALO_SIZE) * night;
    let radius = g * THREE.MathUtils.clamp(0.3 + light.distance * 0.04, 0.3, 1.3) * size;
    // past the distance where it would shrink under ~3 px, a beacon's halo keeps that angular size (no bigger)
    if (beacon) radius = Math.max(radius, cameraDistance * FAR_HALO_ANGLE);
    if (this.count * STRIDE >= this.data.length) {
      const old = this.data;
      this.buffer = this.allocate((old.length / STRIDE) * 2);
      this.data.set(old);
    }
    const o = this.count * STRIDE;
    const d = this.data;
    d[o] = position.x;
    d[o + 1] = position.y;
    d[o + 2] = position.z;
    d[o + 3] = radius;
    d[o + 4] = light.color.r * strength;
    d[o + 5] = light.color.g * strength;
    d[o + 6] = light.color.b * strength;
    d[o + 7] = nudge;
    this.count++;
  }

  /** Upload this frame's halos and face them at `camera`. */
  end(scene: THREE.Scene, camera: THREE.Camera): void {
    if (this.host !== scene) {
      this.mesh.removeFromParent();
      scene.add(this.mesh);
      this.host = scene;
    }
    camera.updateMatrixWorld();
    const e = camera.matrixWorld.elements;
    cameraRight.value.set(e[0]!, e[1]!, e[2]!).normalize();
    cameraUp.value.set(e[4]!, e[5]!, e[6]!).normalize();
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

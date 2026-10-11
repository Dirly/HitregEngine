import * as THREE from "three/webgpu";
import { attribute, cameraPosition, float, length, max, normalize, positionLocal, pow, saturate, uniform, uv, vec3 } from "three/tsl";

/* eslint-disable @typescript-eslint/no-explicit-any */
type N = any;

/** `light.glow` default when a light carries none (see the schema). */
export const DEFAULT_LIGHT_GLOW = 1;

/** Halos fade out between these camera distances (metres). */
const FADE_NEAR = 90;
const FADE_FAR = 140;
/** …and in over the first metre or so, so a lantern held to the face does not flood the screen. */
const CLOSE_FADE = 1.2;
const INITIAL_CAPACITY = 64;
/** Floats per halo: centre xyz + radius, colour rgb + unused. */
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
    fog: false,
    toneMapped: true,
  });
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
    .add(toCamera.mul(radius.mul(0.6)));
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
  add(light: THREE.PointLight, position: THREE.Vector3, cameraDistance: number, glow: number, scale: number): void {
    if (glow <= 0 || scale <= 0.01) return;
    const far = 1 - THREE.MathUtils.smoothstep(cameraDistance, FADE_NEAR, FADE_FAR);
    const near = THREE.MathUtils.smoothstep(cameraDistance, 0.3, CLOSE_FADE);
    // brightness follows intensity gently (a torch at 8 and a brazier at 15
    // should not differ by 2x in halo), size follows the room it lights
    const strength = glow * scale * far * near * THREE.MathUtils.clamp(Math.sqrt(light.intensity / 8), 0.25, 1.6) * 0.3;
    if (strength <= 0.002) return;
    const radius = glow * THREE.MathUtils.clamp(0.3 + light.distance * 0.04, 0.3, 1.3);
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

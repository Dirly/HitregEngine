import * as THREE from "three/webgpu";
import {
  positionLocal,
  positionGeometry,
  positionWorld,
  cameraPosition,
  time,
  color as tslColor,
  float,
  mix,
  smoothstep,
  add,
  sub,
  mul,
  sin,
  length,
  vec3,
  hash,
  instanceIndex,
  uniform,
} from "three/tsl";

/** Validated `grass` component data (schema lives in @hitreg/core). */
export interface GrassData {
  bladeColor: string;
  tipColor: string;
  bladeWidth: number;
  bladeHeight: number;
  density: number;
  radius: number;
  windStrength: number;
  windSpeed: number;
  heightFadeStart: number;
  heightFadeEnd: number;
}

/** World (x, z) -> ground height, or null when nothing is loaded there. */
export type GroundSampler = (x: number, z: number) => number | null;

const MAX_BLADES = 65000;
// re-center only after the camera crosses this fraction of the patch radius,
// so terrain resampling is a rare event, not a per-frame cost — the
// "sliding window" that keeps grass around the camera without regenerating
// the whole world's worth of blades. CPU-profiled during sustained flight:
// regenerate()'s full ~63k-instance relayout was a real, if smaller
// (3.7-6.2% of self-time), spike source, firing every ~16 world units at the
// old 0.35 fraction — under a second of flight at typical speed. Widened so
// it fires roughly half as often; still frequent enough that the field
// visibly follows the camera.
const RECENTER_FRACTION = 0.6;

/** Cheap deterministic JS-side hash, mirrors the TSL `hash()` node used for
 * per-blade wind phase — same idea, just for CPU-side placement. */
function hash01(n: number): number {
  const s = Math.sin(n * 12.9898) * 43758.5453123;
  return s - Math.floor(s);
}

/**
 * One grass field: an InstancedMesh of single-triangle blades, camera-relative
 * and re-centered in a coarse grid as the camera moves (the technique from
 * "Making Grass With Triangles In GLSL Using Three.js"). Positions are baked
 * per-instance in WORLD space and the mesh's own local matrix is pinned to
 * the inverse of its parent's world matrix every frame — same trick the
 * particle system's "world space" mode uses — so the field renders correctly
 * regardless of which entity's transform it's attached to.
 */
class GrassPatch {
  readonly mesh: THREE.InstancedMesh;
  private readonly material: THREE.MeshStandardNodeMaterial;
  private readonly count: number;
  private readonly heightFadeUniform;
  private center = new THREE.Vector2(Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY);

  private readonly tmpMat = new THREE.Matrix4();
  private readonly tmpPos = new THREE.Vector3();
  private readonly tmpQuat = new THREE.Quaternion();
  private readonly tmpScale = new THREE.Vector3();
  private readonly tmpCamPos = new THREE.Vector3();
  private readonly Y_AXIS = new THREE.Vector3(0, 1, 0);

  constructor(
    private readonly group: THREE.Object3D,
    private readonly data: GrassData,
  ) {
    this.count = Math.min(
      MAX_BLADES,
      Math.max(1, Math.floor(Math.PI * data.radius * data.radius * data.density)),
    );

    const w = data.bladeWidth / 2;
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute(
      "position",
      new THREE.BufferAttribute(new Float32Array([-w, 0, 0, w, 0, 0, 0, data.bladeHeight, 0]), 3),
    );
    geometry.setIndex([0, 1, 2]);

    // MeshStandardNodeMaterial, not MeshBasicNodeMaterial: grass sits right
    // next to lit, shadowed terrain/trees — an unlit blade stays at full
    // brightness in a shadow and reads as a different, disconnected shade of
    // green from the ground around it. Standard + receiveShadow lets the same
    // sun/shadow map that darkens the terrain darken the grass too.
    this.material = new THREE.MeshStandardNodeMaterial({
      side: THREE.DoubleSide,
      transparent: true,
      depthWrite: true,
      roughness: 0.95,
      metalness: 0,
    });

    // bend factor: 0 at the base, 1 at the tip — eased so the base stays put.
    // Must read positionGeometry (the raw, untransformed vertex position), NOT
    // positionLocal — the instancing pass reassigns positionLocal in place to
    // the post-instance-matrix (world-scale) position before this node runs,
    // which would blow the [0,1] fraction up to the blade's actual world
    // height and send both the wind sway and the color mix wildly out of range.
    const instanceSeed = float(instanceIndex);
    const bend = positionGeometry.y.div(float(Math.max(0.001, data.bladeHeight)));
    const bendEased = mul(bend, bend);
    const phase = mul(float(hash(instanceSeed)), float(Math.PI * 2));
    const sway = mul(sin(add(mul(time, float(data.windSpeed)), phase)), float(data.windStrength));
    this.material.positionNode = add(
      positionLocal,
      vec3(mul(sway, bendEased), 0, mul(mul(sway, bendEased), float(0.3))),
    );
    // fake "mostly up" normal (no real geometry normal — a thin blade's true
    // face normal points sideways, not up) — reads as soft, ground-matching
    // diffuse shading regardless of the blade's random yaw, the standard trick
    // for cheap foliage lighting; no instance-rotation transform needed since
    // there's no geometry "normal" attribute for the instancing pass to touch.
    this.material.normalNode = vec3(0, 1, 0);

    const tint = add(float(0.85), mul(float(hash(add(instanceSeed, float(0.37)))), float(0.3)));
    this.material.colorNode = mul(mix(tslColor(data.bladeColor), tslColor(data.tipColor), bend), tint);

    this.heightFadeUniform = uniform(1, "float");
    const camDist = length(sub(cameraPosition, positionWorld));
    const edgeFade = sub(
      float(1),
      smoothstep(float(data.radius * 0.7), float(data.radius), camDist),
    );
    this.material.opacityNode = mul(edgeFade, float(this.heightFadeUniform));

    this.mesh = new THREE.InstancedMesh(geometry, this.material, this.count);
    this.mesh.count = 0; // populated on the first recenter, once ground heights are known
    this.mesh.frustumCulled = false;
    this.mesh.matrixAutoUpdate = false; // world-space instances; see class doc
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.receiveShadow = true;
    this.mesh.raycast = () => {}; // blades are never click-selectable
    group.add(this.mesh);
  }

  /** `sampleGrassy` returns null both for unloaded ground AND for ground that
   * isn't the terrain's grassy band — either way, no blade there. */
  private regenerate(sampleGrassy: GroundSampler): void {
    let visible = 0;
    for (let i = 0; i < this.count; i++) {
      const u1 = hash01(i * 2.13 + 0.5);
      const u2 = hash01(i * 2.13 + 1.7);
      const r = this.data.radius * Math.sqrt(u1); // uniform area density — see MAX_BLADES/RECENTER_FRACTION doc
      const theta = u2 * Math.PI * 2;
      const worldX = this.center.x + r * Math.cos(theta);
      const worldZ = this.center.y + r * Math.sin(theta);
      const ground = sampleGrassy(worldX, worldZ);
      if (ground == null) continue;
      const scale = 0.7 + 0.6 * hash01(i * 2.13 + 2.9);
      const rotY = hash01(i * 2.13 + 4.1) * Math.PI * 2;
      this.tmpPos.set(worldX, ground, worldZ);
      this.tmpQuat.setFromAxisAngle(this.Y_AXIS, rotY);
      this.tmpScale.set(scale, scale, scale);
      this.tmpMat.compose(this.tmpPos, this.tmpQuat, this.tmpScale);
      this.mesh.setMatrixAt(visible++, this.tmpMat);
    }
    this.mesh.count = visible;
    this.mesh.instanceMatrix.needsUpdate = true;
  }

  /** `sampleGround` = plain terrain height (any ground, for the camera
   * height-above-ground fade). `sampleGrassy` = terrain height gated to the
   * grassy band only (for blade placement) — see regenerate(). */
  update(camera: THREE.Camera, sampleGround: GroundSampler, sampleGrassy: GroundSampler): void {
    this.group.updateWorldMatrix(true, false);
    this.mesh.matrix.copy(this.group.matrixWorld).invert();

    camera.getWorldPosition(this.tmpCamPos);
    const cell = Math.max(1, this.data.radius * RECENTER_FRACTION);
    const snappedX = Math.round(this.tmpCamPos.x / cell) * cell;
    const snappedZ = Math.round(this.tmpCamPos.z / cell) * cell;
    if (snappedX !== this.center.x || snappedZ !== this.center.y) {
      this.center.set(snappedX, snappedZ);
      this.regenerate(sampleGrassy);
    }

    const ground = sampleGround(this.tmpCamPos.x, this.tmpCamPos.z);
    const camHeight = ground == null ? this.data.heightFadeEnd : this.tmpCamPos.y - ground;
    const span = Math.max(0.001, this.data.heightFadeEnd - this.data.heightFadeStart);
    const t = Math.min(1, Math.max(0, (camHeight - this.data.heightFadeStart) / span));
    this.heightFadeUniform.value = 1 - t;
  }

  dispose(): void {
    this.mesh.removeFromParent();
    this.mesh.dispose();
    this.material.dispose();
  }
}

/**
 * Data-driven grass host, shaped like ParticleSystem: entities register during
 * buildScene (via BuildOptions.onGrass), the app ticks update() once per frame
 * before renderer.render, passing the camera the frame will be drawn with and
 * a ground-height sampler over whatever terrain is currently loaded.
 */
export class GrassSystem {
  private readonly patches = new Map<string, GrassPatch>();

  register(entityId: string, group: THREE.Object3D, data: GrassData): void {
    this.patches.get(entityId)?.dispose();
    this.patches.set(entityId, new GrassPatch(group, data));
  }

  update(camera: THREE.Camera, sampleGround: GroundSampler, sampleGrassy: GroundSampler): void {
    if (this.patches.size === 0) return;
    for (const patch of this.patches.values()) patch.update(camera, sampleGround, sampleGrassy);
  }

  unregister(entityId: string): void {
    this.patches.get(entityId)?.dispose();
    this.patches.delete(entityId);
  }

  clear(): void {
    for (const patch of this.patches.values()) patch.dispose();
    this.patches.clear();
  }
}

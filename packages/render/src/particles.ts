import * as THREE from "three/webgpu";

/** Validated `particles` component data (schema lives in @hitreg/core). */
export interface ParticlesData {
  emitting: boolean;
  rate: number;
  max: number;
  lifetime: [number, number];
  shape: "point" | "sphere" | "box" | "cone";
  shapeSize: [number, number, number];
  coneAngle: number;
  direction: [number, number, number];
  speed: [number, number];
  gravity: number;
  drag: number;
  sizeStart: number;
  sizeEnd: number;
  spin: number;
  colorStart: string;
  colorEnd: string;
  opacityStart: number;
  opacityEnd: number;
  blending: "normal" | "additive";
  texture?: string;
  space: "local" | "world";
}

/** Renderer-side safety net on top of the schema's own cap. */
const HARD_MAX = 2000;
const MIN_LIFE = 0.01;

// one quad shared by every emitter; PlaneGeometry faces +Z, which the
// camera-quaternion billboard rotates toward the viewer
let sharedQuad: THREE.PlaneGeometry | null = null;

// procedural soft round sprite (radial falloff) used when no texture asset is
// given — generated once, shared by all emitters
let softSprite: THREE.Texture | null = null;
function softSpriteTexture(): THREE.Texture | null {
  if (softSprite) return softSprite;
  if (typeof document === "undefined") return null; // headless: untextured quads
  const size = 64;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d")!;
  const gradient = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  gradient.addColorStop(0, "rgba(255,255,255,1)");
  gradient.addColorStop(0.35, "rgba(255,255,255,0.85)");
  gradient.addColorStop(0.75, "rgba(255,255,255,0.25)");
  gradient.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, size, size);
  softSprite = new THREE.CanvasTexture(canvas);
  softSprite.colorSpace = THREE.SRGBColorSpace;
  return softSprite;
}

// pooled temps — the update loop never allocates
const tmpMat = new THREE.Matrix4();
const tmpPos = new THREE.Vector3();
const tmpScale = new THREE.Vector3();
const tmpQuat = new THREE.Quaternion();
const tmpSpin = new THREE.Quaternion();
const tmpDir = new THREE.Vector3();
const tmpAxis = new THREE.Vector3();
const worldQuat = new THREE.Quaternion();
const camQuat = new THREE.Quaternion();
const Z_AXIS = new THREE.Vector3(0, 0, 1);

function randRange(min: number, max: number): number {
  return min + Math.random() * (max - min);
}

/**
 * One emitter: an InstancedMesh of billboarded quads + a CPU simulation over
 * preallocated typed-array pools (swap-remove keeps the live range dense).
 *
 * The InstancedMesh stays parented to the entity group (so rebuilds discard it
 * with the scene), but its local matrix is pinned each frame to the INVERSE of
 * the group's world matrix — its effective world transform is identity, and
 * instance matrices are written directly in world space. That makes billboards
 * exact regardless of emitter rotation/scale, and makes "world" space trivial:
 * world-space particle positions simply stay put while the emitter moves.
 */
class Emitter {
  readonly mesh: THREE.InstancedMesh;
  private readonly material: THREE.MeshBasicNodeMaterial;
  private readonly capacity: number;
  private alive = 0;
  private spawnDebt = 0;
  // struct-of-arrays pools, sized once at registration
  private readonly pos: Float32Array;
  private readonly vel: Float32Array;
  private readonly age: Float32Array;
  private readonly life: Float32Array;
  private readonly rot: Float32Array;
  private readonly colorStart = new THREE.Color();
  private readonly colorEnd = new THREE.Color();
  private readonly color = new THREE.Color();

  constructor(
    private readonly group: THREE.Object3D,
    private readonly data: ParticlesData,
    resolveTexture?: (assetId: string) => string | undefined,
  ) {
    this.capacity = Math.min(Math.max(1, Math.floor(data.max)), HARD_MAX);
    this.pos = new Float32Array(this.capacity * 3);
    this.vel = new Float32Array(this.capacity * 3);
    this.age = new Float32Array(this.capacity);
    this.life = new Float32Array(this.capacity);
    this.rot = new Float32Array(this.capacity);
    this.colorStart.set(data.colorStart);
    this.colorEnd.set(data.colorEnd);

    // MeshBasicNodeMaterial (not ShaderMaterial) so the same emitter renders
    // on the WebGPU backend and its WebGL fallback.
    this.material = new THREE.MeshBasicNodeMaterial({
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      blending: data.blending === "additive" ? THREE.AdditiveBlending : THREE.NormalBlending,
    });
    const sprite = softSpriteTexture();
    if (sprite) this.material.map = sprite;
    const textureUrl = data.texture ? resolveTexture?.(data.texture) : undefined;
    if (textureUrl) {
      // swap in async — WebGPU crashes on textures whose image is still null
      new THREE.TextureLoader().load(
        textureUrl,
        (texture) => {
          texture.colorSpace = THREE.SRGBColorSpace;
          this.material.map = texture;
          this.material.needsUpdate = true;
        },
        undefined,
        (error) => console.warn(`[particles] texture failed to load: ${textureUrl}`, error),
      );
    }

    sharedQuad ??= new THREE.PlaneGeometry(1, 1);
    this.mesh = new THREE.InstancedMesh(sharedQuad, this.material, this.capacity);
    this.mesh.count = 0;
    this.mesh.frustumCulled = false;
    this.mesh.matrixAutoUpdate = false; // we write mesh.matrix by hand
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.instanceColor = new THREE.InstancedBufferAttribute(
      new Float32Array(this.capacity * 3),
      3,
    );
    this.mesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
    this.mesh.raycast = () => {}; // particles are never click-selectable
    group.add(this.mesh);
  }

  /** Direction of a new particle, in emitter-local space, written to tmpDir. */
  private sampleDirection(): void {
    const [dx, dy, dz] = this.data.direction;
    tmpDir.set(dx, dy, dz);
    if (tmpDir.lengthSq() < 1e-8) tmpDir.set(0, 1, 0);
    tmpDir.normalize();
    if (this.data.shape === "cone") {
      const cosA = Math.cos((this.data.coneAngle * Math.PI) / 180);
      const z = 1 - Math.random() * (1 - cosA);
      const r = Math.sqrt(Math.max(0, 1 - z * z));
      const phi = Math.random() * Math.PI * 2;
      tmpAxis.set(r * Math.cos(phi), r * Math.sin(phi), z);
      tmpQuat.setFromUnitVectors(Z_AXIS, tmpDir);
      tmpAxis.applyQuaternion(tmpQuat);
      tmpDir.copy(tmpAxis);
    }
  }

  /** Spawn offset within the emitter shape, in emitter-local space → tmpPos. */
  private sampleOffset(): void {
    const [sx, sy, sz] = this.data.shapeSize;
    switch (this.data.shape) {
      case "sphere": {
        // rejection-sample the unit ball, then stretch by the per-axis radii
        let x = 0;
        let y = 0;
        let z = 0;
        do {
          x = Math.random() * 2 - 1;
          y = Math.random() * 2 - 1;
          z = Math.random() * 2 - 1;
        } while (x * x + y * y + z * z > 1);
        tmpPos.set(x * sx, y * sy, z * sz);
        break;
      }
      case "box":
        tmpPos.set(
          (Math.random() * 2 - 1) * sx,
          (Math.random() * 2 - 1) * sy,
          (Math.random() * 2 - 1) * sz,
        );
        break;
      case "point":
      case "cone":
      default:
        tmpPos.set(0, 0, 0);
    }
  }

  private spawn(count: number): void {
    const world = this.data.space === "world";
    if (world) this.group.getWorldQuaternion(worldQuat);
    for (let n = 0; n < count && this.alive < this.capacity; n++) {
      const i = this.alive++;
      this.sampleOffset();
      // world space: bake the emitter's CURRENT transform into the particle,
      // then never touch it again — that is what makes trails
      if (world) tmpPos.applyMatrix4(this.group.matrixWorld);
      this.pos[i * 3] = tmpPos.x;
      this.pos[i * 3 + 1] = tmpPos.y;
      this.pos[i * 3 + 2] = tmpPos.z;
      this.sampleDirection();
      if (world) tmpDir.applyQuaternion(worldQuat);
      const speed = randRange(this.data.speed[0], this.data.speed[1]);
      this.vel[i * 3] = tmpDir.x * speed;
      this.vel[i * 3 + 1] = tmpDir.y * speed;
      this.vel[i * 3 + 2] = tmpDir.z * speed;
      this.age[i] = 0;
      this.life[i] = Math.max(MIN_LIFE, randRange(this.data.lifetime[0], this.data.lifetime[1]));
      this.rot[i] = this.data.spin === 0 ? 0 : Math.random() * Math.PI * 2;
    }
  }

  update(dt: number): void {
    const d = this.data;
    this.group.updateWorldMatrix(true, false);

    // integrate + retire (swap-remove keeps [0, alive) dense — no compaction)
    const { pos, vel, age, life, rot } = this;
    const damp = d.drag > 0 ? Math.max(0, 1 - d.drag * dt) : 1;
    for (let i = 0; i < this.alive; i++) {
      age[i] = age[i]! + dt;
      if (age[i]! >= life[i]!) {
        const last = --this.alive;
        if (i !== last) {
          pos[i * 3] = pos[last * 3]!;
          pos[i * 3 + 1] = pos[last * 3 + 1]!;
          pos[i * 3 + 2] = pos[last * 3 + 2]!;
          vel[i * 3] = vel[last * 3]!;
          vel[i * 3 + 1] = vel[last * 3 + 1]!;
          vel[i * 3 + 2] = vel[last * 3 + 2]!;
          age[i] = age[last]!;
          life[i] = life[last]!;
          rot[i] = rot[last]!;
        }
        i--;
        continue;
      }
      // gravity pulls along world -Y (in local space: emitter-local -Y)
      vel[i * 3 + 1] = vel[i * 3 + 1]! - d.gravity * dt;
      if (damp !== 1) {
        vel[i * 3] = vel[i * 3]! * damp;
        vel[i * 3 + 1] = vel[i * 3 + 1]! * damp;
        vel[i * 3 + 2] = vel[i * 3 + 2]! * damp;
      }
      pos[i * 3] = pos[i * 3]! + vel[i * 3]! * dt;
      pos[i * 3 + 1] = pos[i * 3 + 1]! + vel[i * 3 + 1]! * dt;
      pos[i * 3 + 2] = pos[i * 3 + 2]! + vel[i * 3 + 2]! * dt;
      if (d.spin !== 0) rot[i] = rot[i]! + d.spin * dt;
    }

    if (d.emitting && d.rate > 0) {
      this.spawnDebt += d.rate * dt;
      const births = Math.floor(this.spawnDebt);
      if (births > 0) {
        this.spawnDebt -= births;
        this.spawn(births);
      }
    }

    // pin the mesh's world transform to identity: instance matrices below are
    // WORLD matrices (see class doc)
    this.mesh.matrix.copy(this.group.matrixWorld).invert();

    const local = d.space === "local";
    const colors = this.mesh.instanceColor!;
    const colorArray = colors.array as Float32Array;
    for (let i = 0; i < this.alive; i++) {
      const t = age[i]! / life[i]!;
      const opacity = d.opacityStart + (d.opacityEnd - d.opacityStart) * t;
      let size = d.sizeStart + (d.sizeEnd - d.sizeStart) * t;
      // Per-instance opacity with node materials is awkward, so it is encoded
      // instead (documented trade-off): additive → fade the instance color
      // toward black (black adds nothing); normal → scale the quad toward
      // zero (a vanishing sprite reads as a fade-out).
      this.color.lerpColors(this.colorStart, this.colorEnd, t);
      if (d.blending === "additive") this.color.multiplyScalar(opacity);
      else size *= opacity;
      colorArray[i * 3] = this.color.r;
      colorArray[i * 3 + 1] = this.color.g;
      colorArray[i * 3 + 2] = this.color.b;

      tmpPos.set(pos[i * 3]!, pos[i * 3 + 1]!, pos[i * 3 + 2]!);
      if (local) tmpPos.applyMatrix4(this.group.matrixWorld); // local sim → world
      // billboard toward the camera, plus spin around the view axis
      if (rot[i] !== 0) {
        tmpSpin.setFromAxisAngle(Z_AXIS, rot[i]!);
        tmpQuat.copy(camQuat).multiply(tmpSpin);
      } else {
        tmpQuat.copy(camQuat);
      }
      tmpMat.compose(tmpPos, tmpQuat, tmpScale.set(size, size, size));
      this.mesh.setMatrixAt(i, tmpMat);
    }
    this.mesh.count = this.alive;
    this.mesh.instanceMatrix.needsUpdate = true;
    colors.needsUpdate = true;
  }

  dispose(): void {
    this.mesh.removeFromParent();
    this.mesh.dispose(); // releases instance buffers; quad geometry is shared
    this.material.dispose(); // per-emitter (blending differs); sprite is shared
  }
}

/**
 * Data-driven particle host, shaped like AnimationSystem: entities register
 * during buildScene (via BuildOptions.onParticles), the app ticks update()
 * once per frame BEFORE renderer.render, passing the camera the frame will be
 * drawn with. Particles run in edit mode too — authoring an effect without
 * seeing it would be miserable — so there is no setRunning().
 *
 * Custom instanced system rather than three.quarks: quarks is WebGL
 * ShaderMaterial-based and does not run on THREE.WebGPURenderer (WebGPU is on
 * its roadmap). The JSON schema is engine-owned, so the backend can swap
 * later without breaking scenes (ARCHITECTURE.md §1 amendment).
 */
export class ParticleSystem {
  private readonly emitters = new Map<string, Emitter>();

  register(
    entityId: string,
    group: THREE.Object3D,
    data: ParticlesData,
    resolveTexture?: (assetId: string) => string | undefined,
  ): void {
    this.emitters.get(entityId)?.dispose();
    this.emitters.set(entityId, new Emitter(group, data, resolveTexture));
  }

  /** Tick every emitter. `camera` = the camera this frame renders with. */
  update(dt: number, camera: THREE.Camera): void {
    if (this.emitters.size === 0) return;
    camera.getWorldQuaternion(camQuat);
    for (const emitter of this.emitters.values()) emitter.update(dt);
  }

  clear(): void {
    for (const emitter of this.emitters.values()) emitter.dispose();
    this.emitters.clear();
  }
}

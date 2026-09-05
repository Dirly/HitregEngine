import * as THREE from "three/webgpu";
import { InstancedProps, applyInstancedProps } from "./instancing.js";
import {
  attribute,
  cameraFar,
  cameraNear,
  float,
  max as tslMax,
  mul,
  perspectiveDepthToViewZ,
  positionView,
  saturate,
  sub,
  texture as tslTexture,
  uv,
  vec2,
  viewportDepthTexture,
} from "three/tsl";

/** TSL nodes are structurally dynamic (swizzles, operators); the same escape
 * hatch grass.ts uses so node graphs stay readable instead of cast-riddled. */
type N = any;

/** Validated `particles` component data (schema lives in @hitreg/core). */
export interface ParticlesData {
  emitting: boolean;
  rate: number;
  max: number;
  lifetime: [number, number];
  shape: "point" | "sphere" | "box" | "cone";
  shapeSize: [number, number, number];
  coneAngle: number;
  spread: number;
  turbulence: number;
  turbulenceSpeed: number;
  fadeIn: number;
  direction: [number, number, number];
  /** Aim along the spawn offset: out = explode, in = converge on the centre. */
  radial?: "none" | "out" | "in";
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
  /** Procedural sprite when no texture: soft radial, hard square, or a chunky pixel blob. */
  sprite?: "soft" | "square" | "pixel";
  subUV?: { cols: number; rows: number; mode: "life" | "loop" | "random"; fps: number };
  softFade: number;
  stretch: number;
  sizeCurve?: Array<[number, number]>;
  opacityCurve?: Array<[number, number]>;
  colorGradient?: Array<[number, string]>;
  space: "local" | "world";
  /** Terrain contact — see the schema. */
  ground?: { mode: "kill" | "settle"; hold: number; fade: number; offset: number; splash?: string } | undefined;
}

/** Sample a [[t, value], …] curve at normalized life `t`. Stops are ordered. */
function sampleCurve(curve: Array<[number, number]>, t: number): number {
  if (curve.length === 0) return 0;
  if (t <= curve[0]![0]) return curve[0]![1];
  for (let i = 1; i < curve.length; i++) {
    const [ct, cv] = curve[i]!;
    if (t <= ct) {
      const [pt, pv] = curve[i - 1]!;
      const span = ct - pt;
      return span <= 0 ? cv : pv + (cv - pv) * ((t - pt) / span);
    }
  }
  return curve[curve.length - 1]![1];
}

export interface ParticleValue {
  emitting?: boolean;
  visible?: boolean;
  /** Clear all live particles and accumulated fractional spawn debt. */
  restart?: boolean;
  /** Spawn this many particles immediately, bounded by the emitter pool. */
  burst?: number;
  /** Spawn rate per second, live — a weather script dials rain up and down with this. */
  rate?: number;
  /**
   * Retint the ramp at runtime without touching the document — one emitter
   * that takes the colour of what it is describing (dust the colour of the
   * ground under a runner, sparks the colour of the metal being cut) instead
   * of one authored emitter per case. Applies to every particle, live ones
   * included, since the ramp is evaluated per frame from age.
   */
  colorStart?: string;
  colorEnd?: string;
}

/** Renderer-side safety net on top of the schema's own cap. */
const HARD_MAX = 8000;
const MIN_LIFE = 0.01;

// one quad shared by every emitter; PlaneGeometry faces +Z, which the
// camera-quaternion billboard rotates toward the viewer
let sharedQuad: THREE.PlaneGeometry | null = null;

// procedural soft round sprite (radial falloff) used when no texture asset is
// given — generated once, shared by all emitters
let softSprite: THREE.Texture | null = null;
const spriteVariants = new Map<string, THREE.Texture>();

/**
 * PSX-flavoured procedural sprites: a hard square with a one-texel fade, or a
 * 6x6 blob with stepped alpha. Nearest-filtered so the blockiness survives
 * scaling — the whole point.
 */
function variantSpriteTexture(kind: "square" | "pixel"): THREE.Texture | null {
  const cached = spriteVariants.get(kind);
  if (cached) return cached;
  if (typeof document === "undefined") return null;
  const size = kind === "square" ? 8 : 6;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d")!;
  const img = ctx.createImageData(size, size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      let a = 1;
      if (kind === "square") {
        const edge = x === 0 || y === 0 || x === size - 1 || y === size - 1;
        a = edge ? 0.45 : 1;
      } else {
        const dx = x + 0.5 - size / 2;
        const dy = y + 0.5 - size / 2;
        const d = Math.hypot(dx, dy) / (size / 2);
        a = d > 1 ? 0 : d > 0.75 ? 0.35 : d > 0.45 ? 0.7 : 1;
      }
      img.data[i] = 255;
      img.data[i + 1] = 255;
      img.data[i + 2] = 255;
      img.data[i + 3] = Math.round(a * 255);
    }
  }
  ctx.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.magFilter = THREE.NearestFilter;
  tex.minFilter = THREE.NearestFilter;
  spriteVariants.set(kind, tex);
  return tex;
}

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
const tmpInverse = new THREE.Matrix4();
const tmpScale = new THREE.Vector3();
const tmpQuat = new THREE.Quaternion();
const tmpSpin = new THREE.Quaternion();
const tmpDir = new THREE.Vector3();
const tmpAxis = new THREE.Vector3();
const worldQuat = new THREE.Quaternion();
const camQuat = new THREE.Quaternion();
/** Inverse of the camera rotation — velocity stretch needs it per particle,
 * so it is derived once per frame rather than cloned in the inner loop. */
const invCamQuat = new THREE.Quaternion();
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
  readonly mesh: InstancedProps;
  /** Per-particle tint, an instanced attribute the shader reads as `aColor`. */
  private readonly colorAttr: THREE.InstancedBufferAttribute;
  private readonly material: THREE.MeshBasicNodeMaterial;
  private readonly capacity: number;
  private alive = 0;
  private spawnDebt = 0;
  private emitting: boolean;
  private runtimeVisible = true;
  // struct-of-arrays pools, sized once at registration
  private readonly pos: Float32Array;
  private readonly vel: Float32Array;
  private readonly age: Float32Array;
  private readonly life: Float32Array;
  private readonly rot: Float32Array;
  /** Per-particle turbulence phase, so motes wander independently rather than
   * swaying in lockstep. */
  private readonly phase: Float32Array;
  /** Emitter-local clock driving the turbulence field. */
  private elapsed = 0;
  private readonly colorStart = new THREE.Color();
  private readonly colorEnd = new THREE.Color();
  private readonly color = new THREE.Color();
  /** Parsed `colorGradient` stops, or null when the simple two-colour ramp is used. */
  private readonly gradient: Array<[number, THREE.Color]> | null;
  /**
   * Per-particle shader data: (opacity, subUV frame, seed, unused).
   *
   * This is what buys REAL per-particle alpha. The previous encoding faded
   * additive particles toward black and SHRANK alpha-blended ones, because a
   * quad had no way to carry its own opacity — which is why smoke could never
   * simply thin out. A vec4 instanced attribute read by the node material
   * fixes that and leaves room for the next two things that need it.
   */
  private readonly shaderData: Float32Array;
  private readonly shaderAttr: THREE.InstancedBufferAttribute;
  /** Per-particle sub-UV frame offset, so identical quads stop looking identical. */
  private readonly seed: Float32Array;
  /** Ground height under each particle at birth (world Y), NaN when unknown. */
  private readonly groundY: Float32Array;
  /** 1 once a `settle` particle has landed: physics stops, the fade clock starts. */
  private readonly landed: Uint8Array;
  /** The normalized age a landed particle froze at (its size/colour stay there) and the age it landed. */
  private readonly landT: Float32Array;
  private readonly landAge: Float32Array;
  private readonly subFrames: number;

  constructor(
    private readonly group: THREE.Object3D,
    private readonly data: ParticlesData,
    resolveTexture?: (assetId: string) => string | undefined,
    /** Height of whatever is below world (x, y, z) — terrain, or a roof when the host asks its physics — or null when nothing is. */
    private readonly groundAt?: (x: number, y: number, z: number) => number | null,
    /** A particle met the ground at this world point (`ground.splash` fires through it). */
    private readonly onLand?: (x: number, y: number, z: number) => void,
  ) {
    this.emitting = data.emitting;
    this.capacity = Math.min(Math.max(1, Math.floor(data.max)), HARD_MAX);
    this.pos = new Float32Array(this.capacity * 3);
    this.vel = new Float32Array(this.capacity * 3);
    this.age = new Float32Array(this.capacity);
    this.life = new Float32Array(this.capacity);
    this.rot = new Float32Array(this.capacity);
    this.phase = new Float32Array(this.capacity);
    this.seed = new Float32Array(this.capacity);
    this.groundY = new Float32Array(this.capacity).fill(NaN);
    this.landed = new Uint8Array(this.capacity);
    this.landT = new Float32Array(this.capacity);
    this.landAge = new Float32Array(this.capacity);
    this.shaderData = new Float32Array(this.capacity * 4);
    this.shaderAttr = new THREE.InstancedBufferAttribute(this.shaderData, 4);
    this.shaderAttr.setUsage(THREE.DynamicDrawUsage);
    this.subFrames = data.subUV ? Math.max(1, data.subUV.cols * data.subUV.rows) : 1;
    this.gradient =
      data.colorGradient && data.colorGradient.length > 0
        ? data.colorGradient.map(([t, hex]) => [t, new THREE.Color(hex)] as [number, THREE.Color])
        : null;
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
    const sprite = data.sprite && data.sprite !== "soft" ? variantSpriteTexture(data.sprite) : softSpriteTexture();
    if (sprite) this.material.map = sprite;
    const textureUrl = data.texture ? resolveTexture?.(data.texture) : undefined;
    if (textureUrl) {
      // swap in async — WebGPU crashes on textures whose image is still null
      new THREE.TextureLoader().load(
        textureUrl,
        (texture) => {
          texture.colorSpace = THREE.SRGBColorSpace;
          this.applyTexture(texture);
        },
        undefined,
        (error) => console.warn(`[particles] texture failed to load: ${textureUrl}`, error),
      );
    }

    // Per-emitter geometry, not the shared quad: instanced attributes live on
    // the geometry, so emitters that share one would overwrite each other's
    // per-particle data.
    //
    // An `InstancedProps` (instance matrices as geometry attributes), NOT an
    // InstancedMesh: three's InstancedMesh path bakes a uniform buffer named
    // after the node's id (`NodeBuffer_<id>`) and the capacity into the WGSL,
    // so every emitter — even two with identical settings — compiled its own
    // shader and pipeline (measured 2026-09-03: +2 pipelines per emitter on
    // every first cast of a spell, ~30 ms each). With attributes the program
    // is keyed by material + layout and shared by every emitter of a look.
    sharedQuad ??= new THREE.PlaneGeometry(1, 1);
    this.mesh = new InstancedProps(sharedQuad, this.material, this.capacity);
    this.mesh.geometry.setAttribute("aParticle", this.shaderAttr);
    this.colorAttr = new THREE.InstancedBufferAttribute(new Float32Array(this.capacity * 3), 3);
    this.colorAttr.setUsage(THREE.DynamicDrawUsage);
    this.mesh.geometry.setAttribute("aColor", this.colorAttr);
    this.mesh.instanceCount = 0;
    this.mesh.frustumCulled = false;
    this.mesh.matrixAutoUpdate = false; // we write mesh.matrix by hand
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.raycast = () => {}; // particles are never click-selectable
    this.buildShader();
    applyInstancedProps(this.material);
    group.add(this.mesh);
  }

  /**
   * Build the node graph: sub-UV frame selection, real per-particle alpha, and
   * an optional soft depth fade.
   *
   * All three are TSL nodes hung on the MeshBasicNodeMaterial the emitter
   * already used — no second renderer, no ShaderMaterial, and the WebGL
   * fallback keeps working. `viewportDepthTexture` is the same scene-depth
   * read the water surface uses for its shoreline foam, so soft particles need
   * no renderer changes either.
   */
  private buildShader(): void {
    const d = this.data;
    // (opacity, frame, seed, unused)
    const per: N = attribute("aParticle", "vec4");

    // Sub-UV: slide the quad's UVs onto one cell of the sheet. The frame index
    // is chosen on the CPU (it already walks every particle), so the shader
    // only has to turn a number into an offset.
    let sampleUv: N = uv();
    if (d.subUV) {
      const cols = Math.max(1, d.subUV.cols);
      const rows = Math.max(1, d.subUV.rows);
      const frame = per.y;
      const col = frame.mod(float(cols)).floor();
      // v is flipped: texture row 0 is the TOP of the sheet.
      const row = float(rows - 1).sub(frame.div(float(cols)).floor());
      sampleUv = uv()
        .mul(vec2(1 / cols, 1 / rows))
        .add(vec2(col.mul(1 / cols), row.mul(1 / rows)));
    }

    // Per-particle colour is an instanced attribute (see the constructor),
    // read here explicitly — a plain Mesh has no `instanceColor` of its own.
    const tint: N = attribute("aColor", "vec3");
    const map = this.material.map;
    if (map) {
      const sampled: N = tslTexture(map, sampleUv);
      // Instance colour still tints; the sheet supplies shape and detail.
      this.material.colorNode = sampled.rgb.mul(tint);
      this.material.opacityNode = mul(sampled.a, per.x);
    } else {
      this.material.colorNode = tint;
      this.material.opacityNode = per.x;
    }

    // Soft particles: fade as the quad approaches whatever is behind it. A
    // hard intersection line where a particle cuts into the ground is the
    // single clearest tell that an effect is cheap.
    if (d.softFade > 0) {
      const sceneViewZ = perspectiveDepthToViewZ(viewportDepthTexture(), cameraNear, cameraFar);
      const behind: N = tslMax(sub(positionView.z, sceneViewZ), float(0));
      const fade: N = saturate(behind.div(float(d.softFade)));
      this.material.opacityNode = mul((this.material.opacityNode ?? float(1)) as N, fade);
    }
    this.material.needsUpdate = true;
  }

  /** Swap the sheet in once it loads, then rebuild the graph around it. */
  private applyTexture(texture: THREE.Texture): void {
    this.material.map = texture;
    this.buildShader();
  }

  setValue(value: ParticleValue): void {
    if (value.restart) {
      this.alive = 0;
      this.spawnDebt = 0;
      this.mesh.instanceCount = 0;
    }
    if (value.emitting !== undefined) this.emitting = value.emitting;
    if (value.rate !== undefined) this.data.rate = Math.max(0, value.rate);
    if (value.colorStart !== undefined) this.colorStart.set(value.colorStart);
    if (value.colorEnd !== undefined) this.colorEnd.set(value.colorEnd);
    if (value.visible !== undefined) {
      this.runtimeVisible = value.visible;
      this.mesh.visible = value.visible;
    }
    if (value.burst && value.burst > 0 && this.runtimeVisible && this.isHierarchyVisible()) {
      this.group.updateWorldMatrix(true, false);
      this.spawn(Math.floor(value.burst));
    }
  }

  private isHierarchyVisible(): boolean {
    let current: THREE.Object3D | null = this.group;
    while (current) {
      if (!current.visible) return false;
      current = current.parent;
    }
    return true;
  }

  /**
   * Direction of a new particle, in emitter-local space, written to tmpDir.
   * Reads tmpPos (the spawn offset, already sampled) for the radial modes.
   */
  private sampleDirection(): void {
    const [dx, dy, dz] = this.data.direction;
    const radial = this.data.radial ?? "none";
    if (radial !== "none" && tmpPos.lengthSq() > 1e-8) {
      // Along the line centre → spawn point: outward is an explosion, inward
      // is energy gathering — the charge-up look, which no fixed `direction`
      // can produce because every particle needs its own.
      tmpDir.copy(tmpPos).normalize();
      if (radial === "in") tmpDir.negate();
    } else {
      tmpDir.set(dx, dy, dz);
      if (tmpDir.lengthSq() < 1e-8) tmpDir.set(0, 1, 0);
      tmpDir.normalize();
    }
    // A cone's own half-angle, and `spread` on top of ANY shape. The second is
    // what a hanging volume of motes needs: without it a box emitter hands
    // every particle the identical velocity vector, and a thousand specks all
    // travelling in exact parallel read as falling snow rather than as dust.
    const angle = Math.max(this.data.shape === "cone" ? this.data.coneAngle : 0, this.data.spread);
    if (angle <= 0) return;
    // uniform direction within `angle` of tmpDir (angle 180 = the full sphere)
    const cosA = Math.cos((angle * Math.PI) / 180);
    const z = 1 - Math.random() * (1 - cosA);
    const r = Math.sqrt(Math.max(0, 1 - z * z));
    const phi = Math.random() * Math.PI * 2;
    tmpAxis.set(r * Math.cos(phi), r * Math.sin(phi), z);
    tmpQuat.setFromUnitVectors(Z_AXIS, tmpDir);
    tmpAxis.applyQuaternion(tmpQuat);
    tmpDir.copy(tmpAxis);
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
      // direction first, while tmpPos is still the LOCAL offset (the radial
      // modes aim along it)
      this.sampleDirection();
      // world space: bake the emitter's CURRENT transform into the particle,
      // then never touch it again — that is what makes trails
      if (world) tmpPos.applyMatrix4(this.group.matrixWorld);
      this.pos[i * 3] = tmpPos.x;
      this.pos[i * 3 + 1] = tmpPos.y;
      this.pos[i * 3 + 2] = tmpPos.z;
      if (world) tmpDir.applyQuaternion(worldQuat);
      const speed = randRange(this.data.speed[0], this.data.speed[1]);
      this.vel[i * 3] = tmpDir.x * speed;
      this.vel[i * 3 + 1] = tmpDir.y * speed;
      this.vel[i * 3 + 2] = tmpDir.z * speed;
      this.age[i] = 0;
      this.life[i] = Math.max(MIN_LIFE, randRange(this.data.lifetime[0], this.data.lifetime[1]));
      this.rot[i] = this.data.spin === 0 ? 0 : Math.random() * Math.PI * 2;
      this.phase[i] = Math.random() * Math.PI * 2;
      this.seed[i] = Math.random();
      this.landed[i] = 0;
      this.groundY[i] = this.data.ground && this.groundAt && world ? (this.groundAt(tmpPos.x, tmpPos.y, tmpPos.z) ?? NaN) : NaN;
    }
  }

  /**
   * Spawn `count` particles AT a world point instead of on the emitter's own
   * shape — how a raindrop's splash lands exactly where the drop did. Velocity
   * still comes from the emitter's direction/speed, so a splash emitter is
   * authored like any other, just with rate 0.
   */
  spawnAt(x: number, y: number, z: number, count: number): void {
    if (!this.runtimeVisible) return;
    const world = this.data.space === "world";
    if (world) this.group.getWorldQuaternion(worldQuat);
    for (let n = 0; n < count && this.alive < this.capacity; n++) {
      const i = this.alive++;
      tmpPos.set(x, y, z);
      if (!world) tmpPos.applyMatrix4(tmpInverse.copy(this.group.matrixWorld).invert());
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
      this.phase[i] = Math.random() * Math.PI * 2;
      this.seed[i] = Math.random();
      this.landed[i] = 0;
      this.groundY[i] = NaN;
    }
  }

  /** Swap-remove particle `i`; the caller re-examines index `i`. */
  private retire(i: number): void {
    const { pos, vel, age, life, rot, phase, seed, groundY, landed, landT, landAge } = this;
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
      phase[i] = phase[last]!;
      seed[i] = seed[last]!;
      groundY[i] = groundY[last]!;
      landed[i] = landed[last]!;
      landT[i] = landT[last]!;
      landAge[i] = landAge[last]!;
    }
  }

  update(dt: number): void {
    const d = this.data;
    // Authored-hidden and runtime-hidden effects are genuinely asleep: no
    // births, integration, instance uploads, or invisible steady-state cloud.
    if (!this.runtimeVisible || !this.isHierarchyVisible()) {
      this.alive = 0;
      this.spawnDebt = 0;
      this.mesh.instanceCount = 0;
      return;
    }
    this.group.updateWorldMatrix(true, false);

    // integrate + retire (swap-remove keeps [0, alive) dense — no compaction)
    const { pos, vel, age, life, rot, phase, seed } = this;
    const damp = d.drag > 0 ? Math.max(0, 1 - d.drag * dt) : 1;
    this.elapsed += dt;
    const swirl = d.turbulence > 0 ? d.turbulence * dt : 0;
    const clock = this.elapsed * d.turbulenceSpeed;
    const ground = d.ground;
    const { groundY, landed, landT, landAge } = this;
    for (let i = 0; i < this.alive; i++) {
      age[i] = age[i]! + dt;
      if (age[i]! >= life[i]!) {
        this.retire(i);
        i--;
        continue;
      }
      if (landed[i]) continue; // resting on the ground: no physics, only the fade clock above
      // gravity pulls along world -Y (in local space: emitter-local -Y)
      vel[i * 3 + 1] = vel[i * 3 + 1]! - d.gravity * dt;
      // Turbulence: a smooth, cheap wander field. Three decorrelated sine
      // rates per particle, offset by its own phase, so specks drift and
      // curl past each other instead of marching. This — not the spawn
      // velocity — is what separates airborne dust from falling snow.
      if (swirl !== 0) {
        const p = phase[i]!;
        vel[i * 3] = vel[i * 3]! + Math.sin(clock + p) * swirl;
        vel[i * 3 + 1] = vel[i * 3 + 1]! + Math.sin(clock * 0.73 + p * 2.1) * swirl;
        vel[i * 3 + 2] = vel[i * 3 + 2]! + Math.sin(clock * 1.31 + p * 3.7) * swirl;
      }
      if (damp !== 1) {
        vel[i * 3] = vel[i * 3]! * damp;
        vel[i * 3 + 1] = vel[i * 3 + 1]! * damp;
        vel[i * 3 + 2] = vel[i * 3 + 2]! * damp;
      }
      pos[i * 3] = pos[i * 3]! + vel[i * 3]! * dt;
      pos[i * 3 + 1] = pos[i * 3 + 1]! + vel[i * 3 + 1]! * dt;
      pos[i * 3 + 2] = pos[i * 3 + 2]! + vel[i * 3 + 2]! * dt;
      if (d.spin !== 0) rot[i] = rot[i]! + d.spin * dt;
      // terrain contact (world-space emitters only; groundY is NaN otherwise)
      if (ground) {
        const g = groundY[i]!;
        const floor = g + ground.offset;
        if (g === g && pos[i * 3 + 1]! <= floor) {
          if (ground.splash) this.onLand?.(pos[i * 3]!, floor, pos[i * 3 + 2]!);
          if (ground.mode === "kill") {
            this.retire(i);
            i--;
            continue;
          }
          // settle: freeze where it is, keep its current look, fade out after the hold
          pos[i * 3 + 1] = floor;
          vel[i * 3] = 0;
          vel[i * 3 + 1] = 0;
          vel[i * 3 + 2] = 0;
          landed[i] = 1;
          landT[i] = age[i]! / life[i]!;
          landAge[i] = age[i]!;
          life[i] = age[i]! + ground.hold + ground.fade;
        }
      }
    }

    if (this.emitting && d.rate > 0) {
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
    const colors = this.colorAttr;
    const colorArray = colors.array as Float32Array;
    const shader = this.shaderData;
    const stretch = d.stretch;
    for (let i = 0; i < this.alive; i++) {
      const rest = landed[i] === 1;
      const t = rest ? landT[i]! : age[i]! / life[i]!;

      // Opacity: a curve when one is authored, otherwise the two-point ramp.
      // `fadeIn` ramps up from nothing over the first slice of life, so a
      // particle arrives instead of appearing. Without it every birth is a
      // pop — the giveaway that a "hanging" effect is being spawned at you.
      let opacity = d.opacityCurve
        ? sampleCurve(d.opacityCurve, t)
        : d.fadeIn > 0 && t < d.fadeIn
          ? d.opacityStart * (t / d.fadeIn)
          : d.opacityStart +
            (d.opacityEnd - d.opacityStart) *
              (d.fadeIn > 0 ? (t - d.fadeIn) / (1 - d.fadeIn) : t);
      if (rest && ground) {
        const since = age[i]! - landAge[i]! - ground.hold;
        if (since > 0) opacity *= ground.fade > 0 ? Math.max(0, 1 - since / ground.fade) : 0;
      }
      const size = d.sizeCurve
        ? sampleCurve(d.sizeCurve, t)
        : d.sizeStart + (d.sizeEnd - d.sizeStart) * t;

      // Colour: a multi-stop gradient when authored, else the two-colour ramp.
      if (this.gradient) {
        const g = this.gradient;
        let lo = g[0]!;
        let hi = g[g.length - 1]!;
        for (let k = 1; k < g.length; k++) {
          if (t <= g[k]![0]) {
            lo = g[k - 1]!;
            hi = g[k]!;
            break;
          }
        }
        const span = hi[0] - lo[0];
        this.color.lerpColors(lo[1], hi[1], span <= 0 ? 0 : (t - lo[0]) / span);
      } else {
        this.color.lerpColors(this.colorStart, this.colorEnd, t);
      }
      colorArray[i * 3] = this.color.r;
      colorArray[i * 3 + 1] = this.color.g;
      colorArray[i * 3 + 2] = this.color.b;

      // Opacity now rides its own attribute (see `shaderData`) instead of
      // being faked by darkening the colour or shrinking the quad, so
      // alpha-blended smoke can finally just thin out where it stands.
      shader[i * 4] = opacity;
      shader[i * 4 + 1] = this.frameAt(t, age[i]!, seed[i]!);
      shader[i * 4 + 2] = seed[i]!;

      tmpPos.set(pos[i * 3]!, pos[i * 3 + 1]!, pos[i * 3 + 2]!);
      if (local) tmpPos.applyMatrix4(this.group.matrixWorld); // local sim → world

      // Orientation: velocity-stretched when asked for, else camera-facing. A
      // spark that is not stretched along its own motion reads as a dot, and
      // no amount of texture work fixes that.
      let stretched = false;
      if (stretch > 0) {
        tmpDir.set(vel[i * 3]!, vel[i * 3 + 1]!, vel[i * 3 + 2]!);
        const speed = tmpDir.length();
        if (speed > 1e-3) {
          // Roll the camera-facing quad so its +Y lies along the velocity as
          // the camera sees it, then lengthen it by distance travelled.
          tmpAxis.copy(tmpDir).divideScalar(speed).applyQuaternion(invCamQuat);
          tmpSpin.setFromAxisAngle(Z_AXIS, Math.atan2(tmpAxis.x, tmpAxis.y));
          tmpQuat.copy(camQuat).multiply(tmpSpin);
          tmpScale.set(size, size + speed * stretch, size);
          stretched = true;
        }
      }
      if (!stretched) {
        if (rot[i] !== 0) {
          tmpSpin.setFromAxisAngle(Z_AXIS, rot[i]!);
          tmpQuat.copy(camQuat).multiply(tmpSpin);
        } else {
          tmpQuat.copy(camQuat);
        }
        tmpScale.set(size, size, size);
      }
      tmpMat.compose(tmpPos, tmpQuat, tmpScale);
      this.mesh.setMatrixAt(i, tmpMat);
    }
    this.mesh.instanceCount = this.alive;
    this.mesh.instanceMatrix.needsUpdate = true;
    this.shaderAttr.needsUpdate = true;
    colors.needsUpdate = true;
  }

  /**
   * Which sheet cell this particle shows.
   *
   * `life` plays the sheet once across the particle's lifetime — the right
   * default, because a puff of smoke should billow and dissipate exactly once.
   * `loop` runs it at a fixed rate for sustained things, and `random` holds
   * one per-particle frame, the cheapest way to stop a hundred identical quads
   * reading as a hundred identical quads.
   */
  private frameAt(t: number, age: number, seed: number): number {
    const sub = this.data.subUV;
    if (!sub) return 0;
    const frames = this.subFrames;
    if (sub.mode === "random") return Math.floor(seed * frames) % frames;
    if (sub.mode === "loop") return Math.floor(age * sub.fps) % frames;
    return Math.min(frames - 1, Math.floor(t * frames));
  }

  dispose(): void {
    this.mesh.removeFromParent();
    this.mesh.geometry.dispose(); // per-emitter instanced geometry (its own instance buffers), see the constructor
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
export interface ParticleSystemOptions {
  /** What is below world (x, y, z): the terrain height, or — when the host can ask its physics — the first
   * collider under the point, roofs included. Null when nothing is. Enables `particles.ground`. */
  groundAt?: (x: number, y: number, z: number) => number | null;
  /** Resolve an entity TAG to an entity id, for `ground.splash` references by tag. */
  entityByTag?: (tag: string) => string | undefined;
}

export class ParticleSystem {
  private readonly emitters = new Map<string, Emitter>();
  constructor(private readonly options: ParticleSystemOptions = {}) {}

  register(
    entityId: string,
    group: THREE.Object3D,
    data: ParticlesData,
    resolveTexture?: (assetId: string) => string | undefined,
  ): void {
    this.emitters.get(entityId)?.dispose();
    const splash = data.ground?.splash;
    const onLand = splash
      ? (x: number, y: number, z: number) => {
          const target = this.emitters.get(splash) ?? this.emitters.get(this.options.entityByTag?.(splash) ?? "");
          target?.spawnAt(x, y, z, 1);
        }
      : undefined;
    this.emitters.set(entityId, new Emitter(group, data, resolveTexture, this.options.groundAt, onLand));
  }

  /** Tick every emitter. `camera` = the camera this frame renders with. */
  update(dt: number, camera: THREE.Camera): void {
    if (this.emitters.size === 0) return;
    camera.getWorldQuaternion(camQuat);
    invCamQuat.copy(camQuat).invert();
    for (const emitter of this.emitters.values()) emitter.update(dt);
  }

  /** Dispose one entity's emitter (its visuals were rebuilt or removed). */
  unregister(entityId: string): void {
    this.emitters.get(entityId)?.dispose();
    this.emitters.delete(entityId);
  }

  /** Runtime-only control; the authoring document remains untouched. */
  setValue(entityId: string, value: ParticleValue): void {
    this.emitters.get(entityId)?.setValue(value);
  }

  clear(): void {
    for (const emitter of this.emitters.values()) emitter.dispose();
    this.emitters.clear();
  }
}

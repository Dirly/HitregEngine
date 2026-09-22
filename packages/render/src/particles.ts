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
  /** Procedural sprite when no texture: soft radial, hard square, a chunky pixel blob, a flame, a splash ring or a rain streak. */
  sprite?: "soft" | "square" | "pixel" | "flame" | "ring" | "streak" | "noise";
  /** Magnification of a `texture` sheet: nearest keeps pixel art hard. */
  filter?: "linear" | "nearest";
  /** PSX banding: colour/size/opacity in this many hard jumps over life (0 = smooth). */
  steps?: number;
  /** PSX grid snap in metres for rendered positions and quad sizes (0 = off). */
  snap?: number;
  /** PSX stepping: simulation ticks per second (0 = every frame). */
  frameRate?: number;
  subUV?: { cols: number; rows: number; mode: "life" | "loop" | "random"; fps: number };
  softFade: number;
  stretch: number;
  /** What the quad points at — see the schema. Default "camera". */
  orient?: "camera" | "velocity" | "ground" | "upright";
  sizeCurve?: Array<[number, number]>;
  opacityCurve?: Array<[number, number]>;
  colorGradient?: Array<[number, string]>;
  space: "local" | "world";
  /** Terrain contact — see the schema. */
  ground?: { mode: "kill" | "settle"; hold: number; fade: number; offset: number; splash?: string; splashChance?: number } | undefined;
}

/** `"ring,drops*3"` → the emitters a landing fires, and how many each gets. */
function parseSplashList(spec: string | undefined): Array<{ ref: string; count: number }> | undefined {
  if (!spec) return undefined;
  const out: Array<{ ref: string; count: number }> = [];
  for (const part of spec.split(",")) {
    const [ref, times] = part.split("*");
    const id = (ref ?? "").trim();
    if (!id) continue;
    out.push({ ref: id, count: Math.max(1, Math.min(16, Math.floor(Number(times) || 1))) });
  }
  return out.length > 0 ? out : undefined;
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
  /**
   * Re-aim and re-speed the emitter live, for newly born particles. This is
   * WIND: one rain emitter blown by whatever the weather is doing, rather
   * than an authored emitter per direction. Applies at birth only — drops
   * already in the air keep the velocity they were launched with, which is
   * also what real gusts look like.
   */
  direction?: [number, number, number];
  speed?: [number, number];
  /**
   * Multiply the whole ramp, live. THE NIGHT KNOB.
   *
   * Particles are unlit — a billboard batch draws with a basic material, so a
   * raindrop is exactly as white at midnight as it is at noon, and a storm at
   * night comes out as bright white scratches over a black world. Nothing in
   * the ramp can fix that, because the ramp is the authored colour of the
   * drop; what changes is how much light is falling on it. A weather script
   * drives this from the hour.
   */
  colorScale?: number;
}

/** Renderer-side safety net on top of the schema's own cap. */
const HARD_MAX = 8000;
/** A batch never grows past this many instances, however many emitters share it. */
const BATCH_MAX = 1 << 17;
const MIN_LIFE = 0.01;

// one quad shared by every batch; PlaneGeometry faces +Z, which the
// camera-quaternion billboard rotates toward the viewer
let sharedQuad: THREE.PlaneGeometry | null = null;

// procedural soft round sprite (radial falloff) used when no texture asset is
// given — generated once, shared by all batches
let softSprite: THREE.Texture | null = null;
const spriteVariants = new Map<string, THREE.Texture>();

/**
 * The `flame` sprite, drawn as pixel art: '#' solid, '+' half alpha. Top row is
 * the top of the quad, so the tongue points up the screen. Leans a texel to
 * one side on purpose — a symmetric flame reads as a teardrop icon.
 */
const FLAME_SPRITE = [
  "   +    ",
  "   ++   ",
  "  +#+   ",
  "  +##+  ",
  " +###+  ",
  " +####+ ",
  " +####+ ",
  "  ++++  ",
];

/**
 * PSX-flavoured procedural sprites: a hard square with a one-texel fade, or a
 * 6x6 blob with stepped alpha. Nearest-filtered so the blockiness survives
 * scaling — the whole point.
 */
function variantSpriteTexture(kind: "square" | "pixel" | "flame" | "ring" | "streak" | "noise"): THREE.Texture | null {
  const cached = spriteVariants.get(kind);
  if (cached) return cached;
  if (typeof document === "undefined") return null;
  // `noise` is the odd one out: every other variant is a few texels meant to
  // stay hard at any size, but this one is stretched across a five-metre quad,
  // where 32 texels is a visible chequerboard. It gets real resolution and
  // smooth filtering below.
  const size = kind === "pixel" ? 6 : kind === "noise" ? 128 : kind === "ring" || kind === "streak" ? 16 : 8;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d")!;
  const img = ctx.createImageData(size, size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      let a = 1;
      if (kind === "flame") {
        const texel = FLAME_SPRITE[y]![x];
        a = texel === "#" ? 1 : texel === "+" ? 0.5 : 0;
      } else if (kind === "ring") {
        // A hollow annulus: solid at the rim, hollow inside, gone outside.
        // A splash is a RING expanding on the ground — a filled blob there is
        // the "puff of smoke at your feet" look, whatever its colour.
        const dx = x + 0.5 - size / 2;
        const dy = y + 0.5 - size / 2;
        const d = Math.hypot(dx, dy) / (size / 2);
        a = d > 1 ? 0 : d > 0.86 ? 0.55 : d > 0.64 ? 1 : d > 0.5 ? 0.45 : 0;
      } else if (kind === "noise") {
        // A TORN puff: value noise at two octaves, faded to nothing at the rim.
        // A smooth radial blob is why a bank of big quads reads as fog however
        // it is tinted — there is no structure in it to see moving, so a
        // hundred of them are one grey shape. This one has edges inside it,
        // and with a little spin you can watch them turn.
        const nx = (x + 0.5) / size;
        const ny = (y + 0.5) / size;
        // four octaves, because this is seen BIG: two gave a lumpy blob whose
        // structure was all at one scale, which still reads as a smooth cloud
        // once it is ten metres across.
        const detail =
          valueNoise2D(nx * 3, ny * 3) * 0.5 +
          valueNoise2D(nx * 6.3 + 3.1, ny * 6.3 + 7.7) * 0.26 +
          valueNoise2D(nx * 13.7 + 11.2, ny * 13.7 + 2.4) * 0.15 +
          valueNoise2D(nx * 27.1 + 5.5, ny * 27.1 + 19.3) * 0.09;
        const dx = x + 0.5 - size / 2;
        const dy = y + 0.5 - size / 2;
        const d = Math.hypot(dx, dy) / (size / 2);
        const rim = d >= 1 ? 0 : Math.min(1, (1 - d) * 2.2);
        a = Math.max(0, Math.min(1, (detail - 0.32) / 0.5)) * rim * rim;
      } else if (kind === "streak") {
        // A vertical line with a soft core and tapered ends: what a falling
        // drop looks like when it is moving faster than the eye resolves.
        const nx = Math.abs(x + 0.5 - size / 2) / (size / 2);
        const ny = Math.abs(y + 0.5 - size / 2) / (size / 2);
        const core = nx > 0.42 ? 0 : nx > 0.2 ? 0.4 : 1;
        const taper = ny > 0.95 ? 0 : ny > 0.72 ? 0.45 : 1;
        a = core * taper;
      } else if (kind === "square") {
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
  if (kind === "noise") {
    // Smooth and mipmapped: a dust bank is soft matter seen close up, and
    // nearest-filtering it just shows the texel grid.
    tex.magFilter = THREE.LinearFilter;
    tex.minFilter = THREE.LinearMipmapLinearFilter;
    tex.generateMipmaps = true;
  } else {
    tex.magFilter = THREE.NearestFilter;
    tex.minFilter = THREE.NearestFilter;
  }
  spriteVariants.set(kind, tex);
  return tex;
}

/**
 * Tiny value noise for the procedural sprites — a hash on the lattice with a
 * smooth interpolation. Baked into a canvas once, so it costs nothing per
 * frame and needs no texture asset to ship with the engine.
 */
export function valueNoise2D(x: number, y: number): number {
  const hash = (i: number, j: number): number => {
    const n = Math.sin(i * 127.1 + j * 311.7) * 43758.5453;
    return n - Math.floor(n);
  };
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const xf = x - xi;
  const yf = y - yi;
  const u = xf * xf * (3 - 2 * xf);
  const v = yf * yf * (3 - 2 * yf);
  const a = hash(xi, yi);
  const b = hash(xi + 1, yi);
  const c = hash(xi, yi + 1);
  const d = hash(xi + 1, yi + 1);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
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
/** Camera world position — the velocity/upright billboards need the vector TO
 * the viewer per particle, which a rotation alone cannot give. */
const camPos = new THREE.Vector3();
const tmpBasis = new THREE.Matrix4();
const tmpRight = new THREE.Vector3();
const tmpUp = new THREE.Vector3();
const tmpFwd = new THREE.Vector3();
/** Inverse of the camera rotation — velocity stretch needs it per particle,
 * so it is derived once per frame rather than cloned in the inner loop. */
const invCamQuat = new THREE.Quaternion();
const Z_AXIS = new THREE.Vector3(0, 0, 1);
const X_AXIS = new THREE.Vector3(1, 0, 0);
const Y_AXIS = new THREE.Vector3(0, 1, 0);
/** PlaneGeometry's normal is +Z; this lies it flat in the XZ plane, facing up. */
const FLAT = new THREE.Quaternion().setFromAxisAngle(X_AXIS, -Math.PI / 2);

function randRange(min: number, max: number): number {
  return min + Math.random() * (max - min);
}

/**
 * Everything that decides the compiled shader and its textures — emitters
 * with the same key draw through one batch. The softFade DISTANCE is baked
 * into the graph as a constant, so it is part of the key, not just its sign.
 */
function batchKey(d: ParticlesData): string {
  const look = d.texture ? `tex:${d.texture}` : `sprite:${d.sprite ?? "soft"}`;
  const sheet = d.subUV ? `${Math.max(1, d.subUV.cols)}x${Math.max(1, d.subUV.rows)}` : "-";
  return [d.blending, look, sheet, d.softFade > 0 ? `soft:${d.softFade}` : "-", d.filter ?? "linear"].join("|");
}

/**
 * One emitter: a CPU simulation over preallocated typed-array pools
 * (swap-remove keeps the live range dense). It owns NO GPU object — every
 * frame its batch asks it to `write` its live particles, as world-space
 * instance matrices, into the batch's shared buffers.
 */
class Emitter {
  readonly capacity: number;
  /** Where this emitter's particles start in its batch, and how many it wrote, this frame. */
  offset = 0;
  drawn = 0;
  private alive = 0;
  private spawnDebt = 0;
  private emitting: boolean;
  private runtimeVisible = true;
  /** Hidden (by the document or at runtime) this frame: no simulation, nothing drawn. */
  private asleep = false;
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
  /** Frame time not yet spent on a whole `frameRate` tick. */
  private stepDebt = 0;
  private readonly colorStart = new THREE.Color();
  private readonly colorEnd = new THREE.Color();
  private readonly color = new THREE.Color();
  /** Live brightness multiplier on the whole ramp — see ParticleValue.colorScale. */
  private colorScale = 1;
  /** Parsed `colorGradient` stops, or null when the simple two-colour ramp is used. */
  private readonly gradient: Array<[number, THREE.Color]> | null;
  /** Per-particle sub-UV frame offset, so identical quads stop looking identical. */
  private readonly seed: Float32Array;
  /** Ground height under each particle at birth (world Y), NaN when unknown. */
  private readonly groundY: Float32Array;
  /** 1 once a `settle` particle has landed: physics stops, the fade clock starts. */
  private readonly landed: Uint8Array;
  /** 1 once the ground under a particle has been re-checked where it actually fell. */
  private readonly rechecked: Uint8Array;
  /** The normalized age a landed particle froze at (its size/colour stay there) and the age it landed. */
  private readonly landT: Float32Array;
  private readonly landAge: Float32Array;
  private readonly subFrames: number;

  constructor(
    readonly group: THREE.Object3D,
    private readonly data: ParticlesData,
    readonly batch: ParticleBatch,
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
    this.rechecked = new Uint8Array(this.capacity);
    this.landT = new Float32Array(this.capacity);
    this.landAge = new Float32Array(this.capacity);
    this.subFrames = data.subUV ? Math.max(1, data.subUV.cols * data.subUV.rows) : 1;
    this.gradient =
      data.colorGradient && data.colorGradient.length > 0
        ? data.colorGradient.map(([t, hex]) => [t, new THREE.Color(hex)] as [number, THREE.Color])
        : null;
    this.colorStart.set(data.colorStart);
    this.colorEnd.set(data.colorEnd);
  }

  setValue(value: ParticleValue): void {
    if (value.restart) {
      this.alive = 0;
      this.spawnDebt = 0;
    }
    if (value.emitting !== undefined) this.emitting = value.emitting;
    if (value.rate !== undefined) this.data.rate = Math.max(0, value.rate);
    // Wind. Written into the authored tuples in place — this runs every tick
    // on every weather emitter, so it must not allocate.
    if (value.direction) {
      this.data.direction[0] = value.direction[0];
      this.data.direction[1] = value.direction[1];
      this.data.direction[2] = value.direction[2];
    }
    if (value.speed) {
      this.data.speed[0] = value.speed[0];
      this.data.speed[1] = value.speed[1];
    }
    if (value.colorStart !== undefined) this.colorStart.set(value.colorStart);
    if (value.colorEnd !== undefined) this.colorEnd.set(value.colorEnd);
    if (value.colorScale !== undefined) this.colorScale = Math.max(0, value.colorScale);
    if (value.visible !== undefined) this.runtimeVisible = value.visible;
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

  /** The Scene this emitter's entity lives in, or null while it is detached. */
  sceneRoot(): THREE.Object3D | null {
    let current: THREE.Object3D = this.group;
    while (current.parent) current = current.parent;
    return (current as THREE.Scene).isScene ? current : null;
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
      this.rechecked[i] = 0;
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
      this.rechecked[i] = 0;
      this.groundY[i] = NaN;
    }
  }

  /** Swap-remove particle `i`; the caller re-examines index `i`. */
  private retire(i: number): void {
    const { pos, vel, age, life, rot, phase, seed, groundY, landed, landT, landAge, rechecked } = this;
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
      rechecked[i] = rechecked[last]!;
      landT[i] = landT[last]!;
      landAge[i] = landAge[last]!;
    }
  }

  /** Advance the simulation one frame. Draws nothing — see `write`. */
  simulate(frameDt: number): void {
    const d = this.data;
    // Authored-hidden and runtime-hidden effects are genuinely asleep: no
    // births, integration, instance writes, or invisible steady-state cloud.
    this.asleep = !this.runtimeVisible || !this.isHierarchyVisible();
    if (this.asleep) {
      this.alive = 0;
      this.spawnDebt = 0;
      return;
    }
    this.group.updateWorldMatrix(true, false);
    // simulation time this frame: the whole frame, or whole PSX ticks (often 0)
    const dt = this.stepped(frameDt);

    // integrate + retire (swap-remove keeps [0, alive) dense — no compaction)
    const { pos, vel, age, life, rot, phase } = this;
    const damp = d.drag > 0 ? Math.max(0, 1 - d.drag * dt) : 1;
    this.elapsed += dt;
    const swirl = d.turbulence > 0 ? d.turbulence * dt : 0;
    const clock = this.elapsed * d.turbulenceSpeed;
    const ground = d.ground;
    const { groundY, landed, landT, landAge, rechecked } = this;
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
        let g = groundY[i]!;
        /**
         * The ground was sampled straight down from where this particle was
         * BORN. Wind then carried it: a drop falling for half a second in a
         * 13 m/s gale lands seven metres downwind, over ground that is not
         * the height we measured. Uphill it splashes in mid-air, downhill it
         * splashes underneath the surface — and both were visible in the MMO
         * scene the moment rain had any lean to it.
         *
         * So the first contact is only a TRIGGER: re-sample where the drop
         * actually is, once, and land on that. Bounded to two queries per
         * particle, and skipped entirely when there is no sideways motion to
         * drift with (a dead-calm drizzle re-samples nothing).
         */
        if (
          g === g &&
          rechecked[i] === 0 &&
          this.groundAt &&
          // Two metres EARLY, not at the stale floor itself: by the time a
          // drop reaches the height we measured it may already be inside a
          // rise, and correcting then only moves the splash, it cannot un-sink
          // it. The lead gives the corrected floor room to arrive first.
          pos[i * 3 + 1]! <= g + ground.offset + 2 &&
          vel[i * 3]! * vel[i * 3]! + vel[i * 3 + 2]! * vel[i * 3 + 2]! > 0.0625
        ) {
          rechecked[i] = 1;
          const again = this.groundAt(pos[i * 3]!, pos[i * 3 + 1]!, pos[i * 3 + 2]!);
          if (again !== null) {
            groundY[i] = again;
            g = again;
          }
        }
        const floor = g + ground.offset;
        if (g === g && pos[i * 3 + 1]! <= floor) {
          // Not every drop splashes: a downpour lands a thousand a second and
          // a ring for each is a sheet of white, which is not what rain looks
          // like (and is a fill-rate bill besides).
          if (ground.splash && (ground.splashChance === undefined || ground.splashChance >= 1 || Math.random() < ground.splashChance)) {
            this.onLand?.(pos[i * 3]!, floor, pos[i * 3 + 2]!);
          }
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
  }

  /**
   * Write this emitter's live particles into a batch's buffers starting at
   * instance `offset`: WORLD-space matrices (the batch mesh sits at the world
   * origin, so billboards are exact whatever the emitter's own rotation or
   * scale), colour, and (opacity, frame, seed). Returns the count written.
   * Runs every frame even when the simulation stepped 0 — billboards must keep
   * facing a camera that turned.
   */
  write(matrices: Float32Array, shader: Float32Array, colors: Float32Array, offset: number): number {
    this.offset = offset;
    if (this.asleep) return (this.drawn = 0);
    const d = this.data;
    const { pos, vel, age, life, rot, seed, landed, landT, landAge } = this;
    const ground = d.ground;
    const local = d.space === "local";
    const stretch = d.stretch;
    const orient = d.orient ?? "camera";
    const steps = d.steps ?? 0;
    const snap = d.snap ?? 0;
    const scale = this.colorScale;
    for (let i = 0; i < this.alive; i++) {
      const o = offset + i;
      const rest = landed[i] === 1;
      const lifeT = rest ? landT[i]! : age[i]! / life[i]!;
      // PSX banding: the look is sampled at the middle of the step the particle
      // is in, so it jumps between `steps` values and no step is invisible
      const t = steps > 0 ? Math.min(1, (Math.floor(lifeT * steps) + 0.5) / steps) : lifeT;

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
      const rawSize = d.sizeCurve
        ? sampleCurve(d.sizeCurve, t)
        : d.sizeStart + (d.sizeEnd - d.sizeStart) * t;
      // snapped to whole grid cells, but never below one: a living particle
      // must not vanish because it is smaller than the grid
      const size = snap > 0 && rawSize > 0 ? Math.max(snap, Math.round(rawSize / snap) * snap) : rawSize;

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
      colors[o * 3] = this.color.r * scale;
      colors[o * 3 + 1] = this.color.g * scale;
      colors[o * 3 + 2] = this.color.b * scale;

      // Opacity rides its own attribute instead of being faked by darkening the
      // colour or shrinking the quad, so alpha-blended smoke can just thin out.
      shader[o * 4] = opacity;
      shader[o * 4 + 1] = this.frameAt(lifeT, age[i]!, seed[i]!);
      shader[o * 4 + 2] = seed[i]!;

      tmpPos.set(pos[i * 3]!, pos[i * 3 + 1]!, pos[i * 3 + 2]!);
      if (local) tmpPos.applyMatrix4(this.group.matrixWorld); // local sim → world
      if (snap > 0) {
        // PSX precision: positions land on a world grid, so a drifting mote
        // hops cell to cell instead of gliding
        tmpPos.set(Math.round(tmpPos.x / snap) * snap, Math.round(tmpPos.y / snap) * snap, Math.round(tmpPos.z / snap) * snap);
      }

      // Orientation. Four cases; the schema's `orient` says why the velocity
      // one has to exist at all.
      let oriented = false;
      if (orient === "ground") {
        // Flat in the XZ plane, facing up — a ring ON the ground rather than a
        // billboard standing in it. Here `rot` is a yaw, not a roll.
        if (rot[i] !== 0) {
          tmpSpin.setFromAxisAngle(Y_AXIS, rot[i]!);
          tmpQuat.copy(tmpSpin).multiply(FLAT);
        } else {
          tmpQuat.copy(FLAT);
        }
        tmpScale.set(size, size, size);
        oriented = true;
      } else if (orient === "velocity" || (orient === "camera" && stretch > 0)) {
        tmpDir.set(vel[i * 3]!, vel[i * 3 + 1]!, vel[i * 3 + 2]!);
        const speed = tmpDir.length();
        if (speed > 1e-3) {
          if (orient === "velocity") {
            // The quad's long axis IS the world velocity; it spins about that
            // axis to face the viewer. So a streak points where the drop is
            // actually going — down, or downwind — and foreshortens honestly
            // when you look along it. The camera-roll branch beside it can only
            // lay the streak along the velocity as PROJECTED on screen, which
            // swings the whole rainfall about as you turn your head and never
            // shortens: the "tilted lines" look.
            tmpUp.copy(tmpDir).divideScalar(speed);
            tmpFwd.copy(camPos).sub(tmpPos);
            tmpRight.crossVectors(tmpUp, tmpFwd);
            if (tmpRight.lengthSq() < 1e-10) {
              // looking straight down the velocity: any perpendicular will do
              tmpRight.crossVectors(tmpUp, Math.abs(tmpUp.y) > 0.9 ? X_AXIS : Y_AXIS);
            }
            tmpRight.normalize();
            tmpFwd.crossVectors(tmpRight, tmpUp).normalize();
            tmpBasis.makeBasis(tmpRight, tmpUp, tmpFwd);
            tmpQuat.setFromRotationMatrix(tmpBasis);
          } else {
            // Roll the camera-facing quad so its +Y lies along the velocity as
            // the camera sees it, then lengthen it by distance travelled.
            tmpAxis.copy(tmpDir).divideScalar(speed).applyQuaternion(invCamQuat);
            tmpSpin.setFromAxisAngle(Z_AXIS, Math.atan2(tmpAxis.x, tmpAxis.y));
            tmpQuat.copy(camQuat).multiply(tmpSpin);
          }
          tmpScale.set(size, size + speed * stretch, size);
          oriented = true;
        }
      } else if (orient === "upright") {
        // Turns about Y only: a tall quad stays vertical however far up you
        // look, which is what a bank of dust standing on the ground must do.
        tmpQuat.setFromAxisAngle(Y_AXIS, Math.atan2(camPos.x - tmpPos.x, camPos.z - tmpPos.z));
        // ...and it still ROLLS in its own plane. This branch used to drop
        // `rot` on the floor, so `spin` on an upright emitter did nothing at
        // all: a dust bank churning at half a radian a second sat there
        // perfectly still, which is most of why a bank of them read as fog.
        if (rot[i] !== 0) {
          tmpSpin.setFromAxisAngle(Z_AXIS, rot[i]!);
          tmpQuat.multiply(tmpSpin);
        }
        tmpScale.set(size, size, size);
        oriented = true;
      }
      if (!oriented) {
        if (rot[i] !== 0) {
          tmpSpin.setFromAxisAngle(Z_AXIS, rot[i]!);
          tmpQuat.copy(camQuat).multiply(tmpSpin);
        } else {
          tmpQuat.copy(camQuat);
        }
        tmpScale.set(size, size, size);
      }
      tmpMat.compose(tmpPos, tmpQuat, tmpScale);
      tmpMat.toArray(matrices, o * 16);
    }
    return (this.drawn = this.alive);
  }

  /**
   * Simulation seconds for this frame. With `frameRate` set the simulation
   * advances only in whole ticks of 1/frameRate — most frames get 0 and the
   * particles hold still, then jump — which is the PSX motion. Rendering still
   * runs every frame, so billboards keep facing a camera that turns between
   * ticks. Capped so a stalled tab does not integrate one enormous step.
   */
  private stepped(frameDt: number): number {
    const rate = this.data.frameRate ?? 0;
    if (!(rate > 0)) return frameDt;
    const tick = 1 / rate;
    this.stepDebt += frameDt;
    if (this.stepDebt < tick) return 0;
    const ticks = Math.floor(this.stepDebt / tick);
    this.stepDebt -= ticks * tick;
    return Math.min(ticks * tick, 0.25);
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
}

/**
 * Every emitter of one LOOK (see `batchKey`) drawn as ONE instanced mesh.
 *
 * Measured 2026-09-13 on a fire test scene of seven fires: 33 emitters cost 66
 * draw calls — one mesh each, and each drawn twice, because three renders a
 * transparent double-sided material as a back-face pass then a front-face
 * pass. Particles are camera-facing quads, so one pass is all they need
 * (`forceSinglePass`), and emitters that share a shader have no reason to be
 * separate meshes at all: they write into this batch's buffers back to back
 * each frame, and a fire layer costs one draw however many torches there are.
 *
 * Sorting is per batch, not per emitter — invisible for additive layers, and
 * the trade for normal-blended smoke is worth a draw per plume.
 */
class ParticleBatch {
  mesh: InstancedProps;
  private readonly material: THREE.MeshBasicNodeMaterial;
  private shaderAttr!: THREE.InstancedBufferAttribute;
  private colorAttr!: THREE.InstancedBufferAttribute;
  private capacity = 0;
  readonly emitters = new Set<Emitter>();
  private disposed = false;

  constructor(
    private readonly data: ParticlesData,
    resolveTexture: ((assetId: string) => string | undefined) | undefined,
    private readonly host: THREE.Object3D | undefined,
  ) {
    // MeshBasicNodeMaterial (not ShaderMaterial) so the same batch renders on
    // the WebGPU backend and its WebGL fallback.
    this.material = new THREE.MeshBasicNodeMaterial({
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      blending: data.blending === "additive" ? THREE.AdditiveBlending : THREE.NormalBlending,
    });
    this.material.forceSinglePass = true;
    const sprite = data.sprite && data.sprite !== "soft" ? variantSpriteTexture(data.sprite) : softSpriteTexture();
    if (sprite) this.material.map = sprite;
    const textureUrl = data.texture ? resolveTexture?.(data.texture) : undefined;
    if (textureUrl) {
      // swap in async — WebGPU crashes on textures whose image is still null
      new THREE.TextureLoader().load(
        textureUrl,
        (texture) => {
          if (this.disposed) {
            texture.dispose();
            return;
          }
          texture.colorSpace = THREE.SRGBColorSpace;
          if (data.filter === "nearest") {
            texture.magFilter = THREE.NearestFilter;
            texture.minFilter = THREE.NearestFilter;
            texture.generateMipmaps = false;
          }
          this.material.map = texture;
          this.buildShader();
        },
        undefined,
        (error) => console.warn(`[particles] texture failed to load: ${textureUrl}`, error),
      );
    }
    this.mesh = this.allocate(16);
    this.buildShader();
    applyInstancedProps(this.material);
  }

  /**
   * A mesh with room for `capacity` particles. An `InstancedProps` (instance
   * matrices as geometry attributes), NOT an InstancedMesh: three's
   * InstancedMesh path bakes a uniform buffer named after the node's id and
   * the capacity into the WGSL, so every mesh compiled its own pipeline
   * (measured 2026-09-03: +2 pipelines per emitter on every first cast). With
   * attributes the program is keyed by material + layout, so a batch that
   * grows into a new mesh compiles nothing.
   */
  private allocate(capacity: number): InstancedProps {
    sharedQuad ??= new THREE.PlaneGeometry(1, 1);
    const mesh = new InstancedProps(sharedQuad, this.material, capacity);
    this.shaderAttr = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 4), 4);
    this.shaderAttr.setUsage(THREE.StreamDrawUsage);
    this.shaderAttr.name = "particle-shader";
    mesh.geometry.setAttribute("aParticle", this.shaderAttr);
    this.colorAttr = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 3), 3);
    this.colorAttr.setUsage(THREE.StreamDrawUsage);
    this.colorAttr.name = "particle-colors";
    mesh.geometry.setAttribute("aColor", this.colorAttr);
    mesh.instanceCount = 0;
    mesh.frustumCulled = false;
    mesh.matrixAutoUpdate = false; // identity: instance matrices are world space
    mesh.instanceMatrix.setUsage(THREE.StreamDrawUsage);
    Object.assign(mesh.instanceMatrix, { name: "particle-matrices" });
    mesh.name = "particles";
    mesh.raycast = () => {}; // particles are never click-selectable
    this.capacity = capacity;
    return mesh;
  }

  add(emitter: Emitter): void {
    this.emitters.add(emitter);
    let need = 0;
    for (const e of this.emitters) need += e.capacity;
    if (need <= this.capacity) return;
    // grow (never shrink — a streamed world's torches come and go) to the next
    // power of two, so a dungeon's worth of registrations reallocates a few
    // times rather than once per torch
    let next = this.capacity;
    while (next < need && next < BATCH_MAX) next *= 2;
    const old = this.mesh;
    this.mesh = this.allocate(Math.min(next, BATCH_MAX));
    old.parent?.add(this.mesh);
    old.removeFromParent();
    old.geometry.dispose();
  }

  remove(emitter: Emitter): void {
    this.emitters.delete(emitter);
  }

  /** Graph: sub-UV frame selection, real per-particle alpha, optional soft depth fade. */
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

    // Per-particle colour is an instanced attribute, read explicitly — a
    // plain Mesh has no `instanceColor` of its own.
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

  /** Collect every member's particles into the shared buffers and upload once. */
  flush(): void {
    const mesh = this.mesh;
    const matrices = mesh.instanceMatrix.array as Float32Array;
    const shader = this.shaderAttr.array as Float32Array;
    const colors = this.colorAttr.array as Float32Array;
    let count = 0;
    let root: THREE.Object3D | null = null;
    for (const emitter of this.emitters) {
      count += emitter.write(matrices, shader, colors, count);
      root ??= emitter.sceneRoot();
    }
    mesh.instanceCount = count;
    // The batch lives in the scene its emitters do (or under the host's own
    // root — the VFX system keeps its batches beside its other modules).
    const parent = this.host ?? root;
    if (parent && mesh.parent !== parent) parent.add(mesh);
    if (count === 0) return;
    mesh.instanceMatrix.clearUpdateRanges();
    mesh.instanceMatrix.addUpdateRange(0, count * 16);
    mesh.instanceMatrix.needsUpdate = true;
    this.shaderAttr.clearUpdateRanges();
    this.shaderAttr.addUpdateRange(0, count * 4);
    this.shaderAttr.needsUpdate = true;
    this.colorAttr.clearUpdateRanges();
    this.colorAttr.addUpdateRange(0, count * 3);
    this.colorAttr.needsUpdate = true;
  }

  dispose(): void {
    this.disposed = true;
    this.mesh.removeFromParent();
    this.mesh.geometry.dispose(); // the batch's own instance buffers
    this.material.dispose(); // per batch; procedural sprites are shared
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
  /**
   * Parent for the batch meshes. Default: the Scene the emitters live in. The
   * VFX system passes its own root so its batches travel (and precompile) with
   * its other modules.
   */
  host?: THREE.Object3D;
}

export class ParticleSystem {
  private readonly emitters = new Map<string, Emitter>();
  private readonly batches = new Map<string, ParticleBatch>();
  constructor(private readonly options: ParticleSystemOptions = {}) {}

  register(
    entityId: string,
    group: THREE.Object3D,
    data: ParticlesData,
    resolveTexture?: (assetId: string) => string | undefined,
  ): void {
    this.unregister(entityId);
    const key = batchKey(data);
    let batch = this.batches.get(key);
    if (!batch) {
      batch = new ParticleBatch(data, resolveTexture, this.options.host);
      this.batches.set(key, batch);
    }
    // A splash is usually two effects at once — a ring spreading on the
    // ground and a few drops thrown back up — and one emitter cannot be both,
    // so `ground.splash` is a list.
    const splashes = parseSplashList(data.ground?.splash);
    const onLand = splashes
      ? (x: number, y: number, z: number) => {
          for (const { ref, count } of splashes) {
            const target = this.emitters.get(ref) ?? this.emitters.get(this.options.entityByTag?.(ref) ?? "");
            target?.spawnAt(x, y, z, count);
          }
        }
      : undefined;
    const emitter = new Emitter(group, data, batch, this.options.groundAt, onLand);
    batch.add(emitter);
    this.emitters.set(entityId, emitter);
  }

  /** Tick every emitter, then upload each batch once. `camera` = the camera this frame renders with. */
  update(dt: number, camera: THREE.Camera): void {
    if (this.emitters.size === 0) return;
    camera.getWorldQuaternion(camQuat);
    camera.getWorldPosition(camPos);
    invCamQuat.copy(camQuat).invert();
    for (const emitter of this.emitters.values()) emitter.simulate(dt);
    for (const batch of this.batches.values()) batch.flush();
  }

  /** Drop one entity's emitter (its visuals were rebuilt or removed); an emptied batch goes with it. */
  unregister(entityId: string): void {
    const emitter = this.emitters.get(entityId);
    if (!emitter) return;
    this.emitters.delete(entityId);
    const batch = emitter.batch;
    batch.remove(emitter);
    if (batch.emitters.size === 0) {
      batch.dispose();
      for (const [key, b] of this.batches) if (b === batch) this.batches.delete(key);
    }
  }

  /** Runtime-only control; the authoring document remains untouched. */
  setValue(entityId: string, value: ParticleValue): void {
    this.emitters.get(entityId)?.setValue(value);
  }

  /** The mesh an emitter draws through and its slot range as of the last update — probes and tests. */
  drawOf(entityId: string): { mesh: InstancedProps; offset: number; count: number } | undefined {
    const emitter = this.emitters.get(entityId);
    return emitter ? { mesh: emitter.batch.mesh, offset: emitter.offset, count: emitter.drawn } : undefined;
  }

  /** Emitters, batches (= draw calls), and particles drawn as of the last update. */
  stats(): { emitters: number; batches: number; particles: number } {
    let particles = 0;
    for (const batch of this.batches.values()) particles += batch.mesh.instanceCount;
    return { emitters: this.emitters.size, batches: this.batches.size, particles };
  }

  clear(): void {
    for (const batch of this.batches.values()) batch.dispose();
    this.batches.clear();
    this.emitters.clear();
  }
}

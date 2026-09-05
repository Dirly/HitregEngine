import * as THREE from "three/webgpu";
import { dot, fract, sin, vec3 } from "three/tsl";
import type { Anchor, Palette, SpritesheetDoc, VfxModule, VfxModuleKind } from "@hitreg/core";
import { resolveColor } from "@hitreg/core";
import type { N } from "./shaders.js";

/**
 * Shared runtime contract for VFX modules.
 *
 * A module's DATA lives in @hitreg/core (the schema); this is the half that
 * has a three.js object behind it. Every kind implements `LiveModule` and is
 * pooled by the system: `begin` binds a fresh module document to a recycled
 * instance, `update` advances it, `end` returns it to the pool with its GPU
 * resources intact. Materials and geometry are built once per instance and
 * reused across plays — a spell fired fifty times compiles nothing new after
 * the first.
 */

/** What the host resolves for the system: textures, sheets, models, sounds. */
export interface VfxResolvers {
  texture?(assetId: string): string | undefined;
  sheet?(assetId: string): SpritesheetDoc | undefined;
  /** Async model load; the module shows a procedural body until it lands. */
  loadModel?(assetId: string): Promise<THREE.Object3D | null>;
  playSound?(assetId: string, position: [number, number, number], volume: number): void;
}

/**
 * Where a play happens. Everything world-space a module needs, supplied by
 * the caller once per play; objects (not ids) so the renderer stays ignorant
 * of the scene document.
 */
export interface VfxFrame {
  /** Where the spell resolves — the volume centre, the impact point. */
  origin: [number, number, number];
  /** Unit horizontal facing of the spell (caster → origin). */
  direction: [number, number, number];
  /** The targeted point, when the spell has one (beams, bolts, debuffs). */
  target?: [number, number, number];
  caster?: THREE.Object3D | null;
  targetObject?: THREE.Object3D | null;
  /** Bone attach points under a body: "rightHand" | "leftHand" | "chest" | "head" | "feet". */
  socket?(body: "caster" | "target", name: string): THREE.Object3D | null;
  /** Terrain height under (x, z), probing from `nearY`; null = unknown. */
  ground?(x: number, z: number, nearY: number): number | null;
  palette: Palette;
}

/** Per-play state shared by every module of one phase. */
export interface PlayContext {
  frame: VfxFrame;
  /** Seconds the phase lasts, for modules with `duration: 0` that sustain. */
  phaseLength: number;
  /** The projectile, for `path` anchors — driven by the sequencer or the host. */
  path: { pos: THREE.Vector3; vel: THREE.Vector3; active: boolean };
}

// ---------------------------------------------------------------------------
// anchors
// ---------------------------------------------------------------------------

const UP = new THREE.Vector3(0, 1, 0);
const Z = new THREE.Vector3(0, 0, 1);
const tmpFwd = new THREE.Vector3();
const tmpRight = new THREE.Vector3();
const tmpVec = new THREE.Vector3();

/** Resolved anchor: a world position, a facing, and (for path) a velocity. */
export class AnchorPose {
  readonly position = new THREE.Vector3();
  readonly facing = new THREE.Quaternion();
  readonly forward = new THREE.Vector3(0, 0, -1);
  readonly velocity = new THREE.Vector3();
}

/**
 * Resolve `anchor` against the frame into `out`. Offsets are in the spell's
 * own frame — x right, y up, z forward along the spell direction — so a
 * "0.5 m in front of the caster" offset means the same thing whichever way
 * the caster is facing.
 */
export function resolveAnchor(anchor: Anchor, ctx: PlayContext, out: AnchorPose): void {
  const f = ctx.frame;
  tmpFwd.set(f.direction[0], 0, f.direction[2]);
  if (tmpFwd.lengthSq() < 1e-6) tmpFwd.set(0, 0, -1);
  tmpFwd.normalize();
  out.velocity.set(0, 0, 0);

  switch (anchor.at) {
    case "origin":
      out.position.set(f.origin[0], f.origin[1], f.origin[2]);
      break;
    case "ground": {
      const y = f.ground?.(f.origin[0], f.origin[2], f.origin[1] + 1) ?? f.origin[1];
      out.position.set(f.origin[0], y, f.origin[2]);
      break;
    }
    case "caster":
    case "target": {
      const body = anchor.at === "caster" ? f.caster : f.targetObject;
      const socket = anchor.socket ? f.socket?.(anchor.at, anchor.socket) : null;
      if (socket) {
        socket.updateWorldMatrix(true, false);
        out.position.setFromMatrixPosition(socket.matrixWorld);
      } else if (body) {
        body.updateWorldMatrix(true, false);
        out.position.setFromMatrixPosition(body.matrixWorld);
        // A body's origin is its centre (capsule middle); sockets already
        // carry their own height, so only the bare body gets lifted to the
        // chest line the offsets are written against.
      } else if (anchor.at === "target" && f.target) {
        out.position.set(f.target[0], f.target[1], f.target[2]);
      } else {
        out.position.set(f.origin[0], f.origin[1], f.origin[2]);
      }
      break;
    }
    case "path":
      out.position.copy(ctx.path.pos);
      out.velocity.copy(ctx.path.vel);
      if (ctx.path.vel.lengthSq() > 1e-4) tmpFwd.copy(ctx.path.vel).normalize();
      break;
  }

  // offset in the spell frame
  const [ox, oy, oz] = anchor.offset;
  if (ox !== 0 || oy !== 0 || oz !== 0) {
    tmpRight.crossVectors(UP, tmpFwd).normalize();
    out.position.addScaledVector(tmpRight, ox).addScaledVector(UP, oy).addScaledVector(tmpFwd, oz);
  }
  out.forward.copy(tmpFwd);
  // facing: +Z of the object points along the spell direction
  tmpVec.copy(tmpFwd);
  out.facing.setFromUnitVectors(Z, tmpVec);
}

// ---------------------------------------------------------------------------
// curves + colour
// ---------------------------------------------------------------------------

/** Sample a [[t, value], …] curve (stops ordered) at normalized `t`. */
export function sampleCurve(curve: ReadonlyArray<readonly [number, number]>, t: number): number {
  if (curve.length === 0) return 1;
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

export function easeOut(t: number): number {
  return 1 - (1 - t) * (1 - t);
}
export function easeIn(t: number): number {
  return t * t;
}

export function moduleColor(color: string, palette: Palette, out: THREE.Color): THREE.Color {
  return out.set(resolveColor(color, palette));
}

// ---------------------------------------------------------------------------
// the live module contract
// ---------------------------------------------------------------------------

export interface LiveModuleHost {
  /** Scene root the module's objects hang under. */
  readonly root: THREE.Object3D;
  readonly resolvers: VfxResolvers;
  /** Borrow one of the fixed slot lights (null when all are busy). */
  takeLight(): THREE.PointLight | null;
  giveLight(light: THREE.PointLight): void;
  /** Camera shake request; the host sums and decays them. */
  addShake(strength: number, duration: number, frequency: number): void;
  /** Particle emitters live in the host's ParticleSystem, keyed by id. */
  particles: {
    register(id: string, group: THREE.Object3D, data: unknown): void;
    setValue(id: string, value: { emitting?: boolean; visible?: boolean; restart?: boolean; burst?: number; colorStart?: string; colorEnd?: string }): void;
    unregister(id: string): void;
  };
}

/**
 * One pooled instance of a module kind. Subclasses own their three objects
 * for their whole lifetime; `begin`/`end` only bind and unbind documents.
 */
export abstract class LiveModule<M extends VfxModule = VfxModule> {
  abstract readonly kind: VfxModuleKind;
  protected module!: M;
  protected ctx!: PlayContext;
  protected readonly pose = new AnchorPose();
  /** Play-clock seconds this instance started at (after its delay). */
  protected startedAt = 0;
  /** Seconds it lives; Infinity for "until stopped". */
  protected life = 1;
  /** Fade-out requested by an early stop: [from, until] on the play clock. */
  private fadeFrom = -1;
  private fadeUntil = -1;
  private ended = false;
  protected readonly color = new THREE.Color();
  protected readonly colorEnd = new THREE.Color();

  constructor(protected readonly host: LiveModuleHost) {}

  /** Bind a document and show. `now` is the play clock at which it starts. */
  begin(module: M, ctx: PlayContext, now: number): void {
    this.module = module;
    this.ctx = ctx;
    this.startedAt = now;
    this.fadeFrom = -1;
    this.fadeUntil = -1;
    this.ended = false;
    moduleColor(module.color, ctx.frame.palette, this.color);
    moduleColor(module.colorEnd, ctx.frame.palette, this.colorEnd);
    this.life = module.duration > 0 ? module.duration : this.naturalLife();
    resolveAnchor(module.anchor, ctx, this.pose);
    this.onBegin();
  }

  /** Seconds the module lives when `duration` is 0. */
  protected naturalLife(): number {
    return this.ctx.phaseLength > 0 ? this.ctx.phaseLength : 0.6;
  }

  protected abstract onBegin(): void;
  /** Advance; `t` is normalized life (may exceed 1 during a tail). */
  protected abstract onUpdate(t: number, dt: number, camera: THREE.Camera): void;
  /** Hide and release resources for the next play. */
  protected abstract onEnd(): void;

  /**
   * Extra seconds the module stays alive past `life` (particles dying, a
   * light's last frames). Subclasses override when they need a tail.
   */
  protected tail(): number {
    return 0;
  }

  /** Multiplier applied to opacity: the module's own curve × any fade-out. */
  protected opacityAt(t: number, now: number): number {
    const m = this.module;
    let o = m.opacity;
    if (m.opacityCurve) o *= sampleCurve(m.opacityCurve, Math.min(1, t));
    if (this.fadeFrom >= 0) {
      const k = (now - this.fadeFrom) / Math.max(1e-3, this.fadeUntil - this.fadeFrom);
      o *= Math.max(0, 1 - k);
    }
    return o;
  }

  protected sizeAt(t: number): number {
    const m = this.module;
    return m.sizeCurve ? sampleCurve(m.sizeCurve, Math.min(1, t)) : 1;
  }

  /** Re-resolve the anchor when following; harmless otherwise. */
  protected track(): void {
    if (this.module.anchor.follow) resolveAnchor(this.module.anchor, this.ctx, this.pose);
  }

  /** Called by the system each frame; returns false once the module is over. */
  step(now: number, dt: number, camera: THREE.Camera): boolean {
    if (this.ended) return false;
    const age = now - this.startedAt;
    const over = this.fadeUntil >= 0 ? now >= this.fadeUntil : age >= this.life + this.tail();
    if (over) {
      this.finish();
      return false;
    }
    this.track();
    this.onUpdate(this.life > 0 ? age / this.life : 1, dt, camera);
    return true;
  }

  /** Ask the module to wind down over `seconds` (a channel interrupted). */
  fadeOut(now: number, seconds: number): void {
    if (this.fadeFrom >= 0) return;
    this.fadeFrom = now;
    this.fadeUntil = now + Math.max(0.01, seconds);
  }

  finish(): void {
    if (this.ended) return;
    this.ended = true;
    this.onEnd();
  }

  get isEnded(): boolean {
    return this.ended;
  }

  /** Free GPU resources for good (system teardown). */
  abstract dispose(): void;
}

// ---------------------------------------------------------------------------
// small shared helpers for the three side
// ---------------------------------------------------------------------------

export function unlitMaterial(additive: boolean): THREE.MeshBasicNodeMaterial {
  const m = new THREE.MeshBasicNodeMaterial({
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
  });
  m.toneMapped = false;
  return m;
}

/** Mark an object as pure presentation: no picking, no shadows. */
export function presentationOnly(obj: THREE.Object3D): void {
  obj.raycast = () => {};
  obj.castShadow = false;
  obj.receiveShadow = false;
  obj.frustumCulled = false;
  obj.userData["vfx"] = true;
}

const texCache = new Map<string, THREE.Texture>();
const texPending = new Map<string, Array<(t: THREE.Texture) => void>>();

/**
 * Load-once texture cache; `onLoad` fires immediately when cached. `nearest`
 * asks for the pixel-art copy (no bilinear, no mips) — a second GPU texture
 * of the same image, cached under its own key, because a symbol sheet is
 * both a flipbook source and a set of hard-edged sigils.
 */
export function loadTexture(url: string, onLoad: (t: THREE.Texture) => void, nearest = false): void {
  const key = nearest ? `${url}#nearest` : url;
  const cached = texCache.get(key);
  if (cached) {
    onLoad(cached);
    return;
  }
  const waiting = texPending.get(key);
  if (waiting) {
    waiting.push(onLoad);
    return;
  }
  texPending.set(key, [onLoad]);
  new THREE.TextureLoader().load(
    url,
    (t) => {
      t.colorSpace = THREE.SRGBColorSpace;
      if (nearest) {
        t.magFilter = THREE.NearestFilter;
        t.minFilter = THREE.NearestFilter;
        t.generateMipmaps = false;
      } else {
        t.magFilter = THREE.LinearFilter;
      }
      t.needsUpdate = true;
      texCache.set(key, t);
      const list = texPending.get(key) ?? [];
      texPending.delete(key);
      for (const cb of list) cb(t);
    },
    undefined,
    (error) => {
      texPending.delete(key);
      console.warn(`[vfx] texture failed to load: ${url}`, error);
    },
  );
}

/** World-grid hash 0..1 for pixel dithers — the same function every PSX module uses. */
export function hashCell(cell: N): N {
  return fract(sin(dot(cell, vec3(12.9898, 78.233, 37.719))).mul(43758.5453));
}

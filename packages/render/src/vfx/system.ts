import * as THREE from "three/webgpu";
import {
  expandRepeat,
  isHoming,
  shotCount,
  shotJitter,
  shotSpread,
  wiggleLift,
  wiggleOffset,
  spellPalette,
  spellTimeline,
  vfxEffectSchema,
  type Phase,
  type SpellDoc,
  type VfxEffect,
  type VfxModule,
  type VfxModuleKind,
} from "@hitreg/core";
import { ParticleSystem, type ParticlesData } from "../particles.js";
import { LiveModule, loadTexture, type LiveModuleHost, type PlayContext, type VfxFrame, type VfxResolvers } from "./base.js";
import { ShakeLive, SoundLive } from "./modules/extras.js";
import { BoltLive } from "./modules/bolt.js";
import { LightLive } from "./modules/light.js";
import { MeshLive } from "./modules/mesh.js";
import { ParticlesLive } from "./modules/particles.js";
import { RingLive } from "./modules/ring.js";
import { DecalLive } from "./modules/decal.js";
import { ShellLive } from "./modules/shell.js";
import { SlashLive } from "./modules/slash.js";
import { SpriteLive } from "./modules/sprite.js";
import { TelegraphLive } from "./modules/telegraph.js";
import { TrailLive } from "./modules/trail.js";
import { TrailBatch } from "./modules/trail-batch.js";
import { BeamLive, ColumnLive } from "./modules/tube.js";

/**
 * The VFX runtime: plays effects (module lists) and whole spells (timed
 * phases) against a frame, pools every module kind, owns the slot lights and
 * the camera shake, and ticks once per frame before the render.
 *
 * WHY THE LIGHTS ARE A FIXED POOL. Three's WebGPU backend hashes the SET of
 * visible lights into every lit material's cache key, so a light that appears
 * for an impact and disappears a second later recompiles every lit shader in
 * the scene — twice. (light-budget.ts measured this at 2296 ms/frame.) So the
 * system creates `maxLights` point lights once, keeps them in the scene at
 * zero intensity, and modules borrow them. The renderer's light set never
 * changes; a flash is a uniform write.
 */
export interface VfxHandle {
  /** Wind every live module down over `fade` seconds and cancel the rest. */
  stop(fade?: number): void;
  readonly done: boolean;
  /** The frame the play reads — mutate to move a following effect. */
  readonly frame: VfxFrame;
}

export interface SpellPlayOptions {
  /**
   * Phases the HOST will trigger by hand (`trigger`) instead of the timeline
   * — a real projectile decides when its impact happens, an authority
   * decides when a tick lands. Everything else plays on the timeline.
   */
  manual?: Phase[];
  /** Play-clock offset: start `at` seconds into the spell (a late joiner). */
  at?: number;
}

export interface SpellHandle extends VfxHandle {
  /** Seconds since the cast started. */
  readonly time: number;
  /** Fire a phase now, optionally at a point (impact/tick/end/linger). */
  trigger(phase: Phase, at?: [number, number, number]): void;
  /** Drive the projectile from outside (world position; velocity optional). */
  setPath(position: [number, number, number], velocity?: [number, number, number]): void;
  /**
   * One SHOT of a projectile spell, driven from outside: it plays the travel
   * phase on its own path until `impact` (plays the impact phase there) or
   * `end` (a miss: the travel fades). A volley is one launch per shot; a
   * host drives each along its authority's path (steering included).
   */
  launch(position: [number, number, number], velocity: [number, number, number]): ShotHandle;
}

export interface ShotHandle {
  setPath(position: [number, number, number], velocity?: [number, number, number]): void;
  impact(at?: [number, number, number]): void;
  end(fade?: number): void;
}

/** One projectile in flight inside a spell play. */
interface Shot {
  path: { pos: THREE.Vector3; vel: THREE.Vector3; active: boolean };
  /** internal flight: horizontal heading (unit), where it started, metres flown */
  dir: THREE.Vector3;
  from: THREE.Vector3;
  travelled: number;
  travel: EffectPlay | null;
  ended: boolean;
  /** driven by the host (launch) rather than simulated here */
  external: boolean;
  /** simulated: the line the shot flies (straight or steered); pos is this plus its wiggle */
  base: THREE.Vector3;
  /** which shot of the burst: seeds its wiggle phase */
  index: number;
}

/** A small deterministic hash → [0, 1): the same spell scatters the same way every play. */
function hash01(seed: number, i: number): number {
  let h = (seed ^ Math.imul(i + 1, 0x9e3779b1)) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35) >>> 0;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

const upAxis = new THREE.Vector3(0, 1, 0);
const aimTo = new THREE.Vector3();

interface Scheduled {
  module: VfxModule;
  at: number;
}

class EffectPlay implements VfxHandle {
  readonly ctx: PlayContext;
  readonly live: LiveModule[] = [];
  private readonly pending: Scheduled[] = [];
  private stopped = false;

  constructor(
    private readonly system: VfxSystem,
    effect: VfxEffect,
    ctx: PlayContext,
    readonly startedAt: number,
  ) {
    this.ctx = ctx;
    // `repeat` expands here, once per play: copy i is its own scheduled
    // module with its own delay and offset, so the stepping costs the
    // sequencer nothing and every copy pools like any other module.
    for (const module of effect.modules) {
      for (const copy of expandRepeat(module)) this.pending.push({ module: copy, at: startedAt + copy.delay });
    }
    this.pending.sort((a, b) => a.at - b.at);
  }

  get frame(): VfxFrame {
    return this.ctx.frame;
  }

  get done(): boolean {
    return this.pending.length === 0 && this.live.length === 0;
  }

  step(now: number, dt: number, camera: THREE.Camera): void {
    while (this.pending.length > 0 && this.pending[0]!.at <= now) {
      const { module, at } = this.pending.shift()!;
      if (this.stopped) continue;
      const inst = this.system.acquire(module);
      if (!inst) continue;
      try {
        inst.begin(module as never, this.ctx, at);
      } catch (error) {
        console.warn(`[vfx] ${module.kind} failed to start`, error);
        this.system.release(inst);
        continue;
      }
      this.live.push(inst);
    }
    for (let i = this.live.length - 1; i >= 0; i--) {
      const inst = this.live[i]!;
      let alive = false;
      try {
        alive = inst.step(now, dt, camera);
      } catch (error) {
        console.warn(`[vfx] ${inst.kind} failed to update`, error);
        inst.finish();
      }
      if (!alive) {
        this.live.splice(i, 1);
        this.system.release(inst);
      }
    }
  }

  stop(fade = 0.25): void {
    this.stopped = true;
    this.pending.length = 0;
    const now = this.system.now;
    for (const inst of this.live) inst.fadeOut(now, fade);
  }

  /** Immediate teardown (system dispose). */
  kill(): void {
    this.pending.length = 0;
    for (const inst of this.live) {
      inst.finish();
      this.system.release(inst);
    }
    this.live.length = 0;
  }
}

interface PhaseEvent {
  at: number;
  phase: Phase;
  /** Override the play's phase length (linger holds for the duration). */
  length?: number;
}

class SpellPlay implements SpellHandle {
  readonly frame: VfxFrame;
  private readonly plays: EffectPlay[] = [];
  private readonly events: PhaseEvent[] = [];
  private readonly manual: Set<Phase>;
  private stopped = false;
  private readonly timeline;
  private readonly path = { pos: new THREE.Vector3(), vel: new THREE.Vector3(), active: false };
  private pathExternal = false;
  private readonly pathFrom = new THREE.Vector3();
  private readonly pathTo = new THREE.Vector3();
  private travelAt = -1;
  private travelFor = 0;
  private lastTime = 0;
  /** Per-shot flight: volleys and homing shots each fly and land on their own. */
  private readonly shots: Shot[] = [];
  /** Play-time seconds the simulated shots leave, still to launch. */
  private readonly shotTimes: number[] = [];
  private shotIndex = 0;

  constructor(
    private readonly system: VfxSystem,
    readonly spell: SpellDoc,
    frame: VfxFrame,
    readonly startedAt: number,
    opts: SpellPlayOptions,
  ) {
    this.frame = { ...frame, palette: frame.palette ?? spellPalette(spell) };
    this.manual = new Set(opts.manual ?? []);
    const t = spellTimeline(spell.archetype);
    this.timeline = t;
    const add = (phase: Phase, at: number, length?: number): void => {
      if (!spell.phases[phase] || this.manual.has(phase)) return;
      this.events.push({ at, phase, length });
    };
    if (t.telegraph) add("telegraph", t.telegraph.at, t.telegraph.windup + t.telegraph.hold);
    if (t.charge) add("charge", t.charge.at, t.charge.duration);
    if (t.cast) add("cast", t.cast.at);
    // A volley or a seeker flies SHOTS: each plays travel on its own path and
    // impact where it lands (simulated here, or launched by the host).
    const perShot = spell.archetype.kind === "projectile" && (shotCount(spell.archetype) > 1 || isHoming(spell.archetype));
    if (perShot) {
      if (t.travel && !this.manual.has("travel")) {
        for (let i = 0; i < t.shots; i++) this.shotTimes.push(t.travel.at + i * t.shotInterval);
      }
    } else {
      if (t.travel) add("travel", t.travel.at, t.travel.duration);
      if (t.impact) add("impact", t.impact.at);
    }
    for (const tick of t.ticks) add("tick", tick);
    if (t.linger) add("linger", t.linger.at, t.linger.duration);
    if (t.end) add("end", t.end.at);
    this.events.sort((a, b) => a.at - b.at);
    if (t.travel && spell.archetype.kind === "projectile") {
      this.travelAt = t.travel.at;
      this.travelFor = Math.max(0.05, t.travel.duration);
    }
  }

  get time(): number {
    return this.lastTime;
  }

  get done(): boolean {
    return this.events.length === 0 && this.shotTimes.length === 0 && this.shots.every((s) => s.ended) && this.plays.every((p) => p.done);
  }

  private playPhase(phase: Phase, length: number | undefined, at: number, point?: [number, number, number], path = this.path): EffectPlay | null {
    const effect = this.spell.phases[phase];
    if (!effect) return null;
    const frame = point ? { ...this.frame, origin: point } : this.frame;
    const ctx: PlayContext = { frame, phaseLength: length ?? 0, path, texel: this.spell.texel };
    const play = new EffectPlay(this.system, effect, ctx, at);
    this.plays.push(play);
    return play;
  }

  /** Seconds a shot may fly at most: out past the volume and back is a miss. */
  private flightCap(): number {
    const a = this.spell.archetype;
    return (Math.max(4, a.range) * 1.8) / Math.max(1, a.speed);
  }

  private startShot(from: THREE.Vector3, vel: THREE.Vector3, external: boolean): Shot {
    const shot: Shot = {
      path: { pos: from.clone(), vel: vel.clone(), active: true },
      dir: new THREE.Vector3(vel.x, 0, vel.z).normalize(),
      from: from.clone(),
      travelled: 0,
      travel: null,
      ended: false,
      external,
      base: from.clone(),
      index: this.shotIndex,
    };
    shot.travel = this.playPhase("travel", this.flightCap(), this.system.now, undefined, shot.path);
    this.shots.push(shot);
    return shot;
  }

  private landShot(shot: Shot, at?: [number, number, number]): void {
    if (shot.ended) return;
    shot.ended = true;
    shot.travel?.stop(0.1);
    if (this.stopped || !at) return;
    this.playPhase("impact", undefined, this.system.now, at);
  }

  launch(position: [number, number, number], velocity: [number, number, number]): ShotHandle {
    const shot = this.startShot(new THREE.Vector3(...position), new THREE.Vector3(...velocity), true);
    return {
      setPath: (p, v) => {
        shot.path.pos.set(p[0], p[1], p[2]);
        if (v) shot.path.vel.set(v[0], v[1], v[2]);
      },
      impact: (at) => this.landShot(shot, at ?? [shot.path.pos.x, shot.path.pos.y, shot.path.pos.z]),
      end: (fade = 0.12) => {
        if (shot.ended) return;
        shot.ended = true;
        shot.travel?.stop(fade);
      },
    };
  }

  /**
   * Where a simulated shot flies. `aim`: the point it LEAVES toward — the
   * target point, else the origin (what the crosshair was on). `seek`: what a
   * seeker steers at once in flight — the target body, else the same point.
   */
  private aimPoint(out: THREE.Vector3, seek = false): THREE.Vector3 {
    const f = this.frame;
    if (seek && f.targetObject) {
      f.targetObject.updateWorldMatrix(true, false);
      return out.setFromMatrixPosition(f.targetObject.matrixWorld);
    }
    if (f.target) return out.set(f.target[0], f.target[1], f.target[2]);
    return out.set(f.origin[0], f.origin[1] + 1, f.origin[2]);
  }

  /** Launch the next simulated shot: from the hand, toward the aim, turned by its share of the scatter. */
  private fireSimulated(): void {
    const a = this.spell.archetype;
    const i = this.shotIndex++;
    const from = new THREE.Vector3();
    this.launchPoint(from);
    this.aimPoint(aimTo);
    const dir = new THREE.Vector3(aimTo.x - from.x, 0, aimTo.z - from.z);
    if (dir.lengthSq() < 1e-6) dir.set(this.frame.direction[0], 0, this.frame.direction[2]);
    dir.normalize();
    const off = (hash01(this.spell.seed, i) * 2 - 1) * shotSpread(a, i);
    dir.applyAxisAngle(upAxis, (off * Math.PI) / 180);
    // a barrage leaves from around the hand, not single file out of one point
    const [jr, ju] = shotJitter(a, this.spell.seed, i);
    from.x += dir.z * -jr;
    from.z += dir.x * jr;
    from.y += ju;
    const shot = this.startShot(from, dir.multiplyScalar(Math.max(1, a.speed)), false);
    shot.index = i;
  }

  /** Fly the simulated shots: steer the seekers, land each where it arrives. */
  private stepShots(dt: number): void {
    const a = this.spell.archetype;
    const homing = isHoming(a);
    for (const shot of this.shots) {
      if (shot.ended || shot.external) continue;
      this.aimPoint(aimTo, homing);
      if (homing) {
        // turn toward the target by at most turnRate·dt
        const want = new THREE.Vector3(aimTo.x - shot.path.pos.x, 0, aimTo.z - shot.path.pos.z);
        if (want.lengthSq() > 1e-6) {
          want.normalize();
          const angle = Math.acos(Math.max(-1, Math.min(1, shot.dir.dot(want))));
          const max = (a.homing.turnRate * Math.PI * dt) / 180;
          const side = shot.dir.x * want.z - shot.dir.z * want.x >= 0 ? -1 : 1;
          if (angle <= max) shot.dir.copy(want);
          else shot.dir.applyAxisAngle(upAxis, side * max).normalize();
        }
      }
      const speed = Math.max(1, a.speed);
      // the LINE moves; the drawn shot weaves off it (the same curve a host's hit test uses)
      shot.base.addScaledVector(shot.dir, speed * dt);
      shot.base.y += (aimTo.y - shot.base.y) * Math.min(1, dt * 2);
      shot.travelled += speed * dt;
      const seed = this.spell.seed * 131 + shot.index;
      const sway = wiggleOffset(a.wiggle, seed, shot.travelled);
      const lift = wiggleLift(a.wiggle, seed, shot.travelled);
      const prev = shot.path.pos.clone();
      shot.path.pos.set(shot.base.x - shot.dir.z * sway, shot.base.y + lift, shot.base.z + shot.dir.x * sway);
      shot.path.vel.copy(shot.path.pos).sub(prev).divideScalar(Math.max(1e-4, dt));
      const dx = aimTo.x - shot.base.x;
      const dz = aimTo.z - shot.base.z;
      const arrived = Math.hypot(dx, dz) < Math.max(0.4, speed * dt * 1.5);
      const reach = Math.hypot(aimTo.x - shot.from.x, aimTo.z - shot.from.z);
      // a straight shot lands at the aim's distance, wherever its scatter took it
      const spent = homing ? shot.travelled >= this.flightCap() * speed : shot.travelled >= reach;
      if (arrived || spent) this.landShot(shot, [shot.path.pos.x, this.frame.origin[1], shot.path.pos.z]);
    }
  }

  trigger(phase: Phase, at?: [number, number, number]): void {
    if (this.stopped) return;
    const t = this.timeline;
    const length =
      phase === "linger"
        ? (t.linger?.duration ?? this.spell.archetype.duration)
        : phase === "travel"
          ? (t.travel?.duration ?? 0)
          : phase === "telegraph"
            ? (t.telegraph ? t.telegraph.windup + t.telegraph.hold : 0)
            : phase === "charge"
              ? (t.charge?.duration ?? 0)
              : undefined;
    this.playPhase(phase, length, this.system.now, at);
  }

  setPath(position: [number, number, number], velocity?: [number, number, number]): void {
    this.pathExternal = true;
    this.path.active = true;
    this.path.pos.set(position[0], position[1], position[2]);
    if (velocity) this.path.vel.set(velocity[0], velocity[1], velocity[2]);
  }

  /** Where a projectile leaves the caster: the right hand, or chest height. */
  private launchPoint(out: THREE.Vector3): void {
    const f = this.frame;
    const hand = f.socket?.("caster", "rightHand");
    if (hand) {
      hand.updateWorldMatrix(true, false);
      out.setFromMatrixPosition(hand.matrixWorld);
      return;
    }
    if (f.caster) {
      f.caster.updateWorldMatrix(true, false);
      out.setFromMatrixPosition(f.caster.matrixWorld);
      out.y += 0.9;
      return;
    }
    out.set(f.origin[0], f.origin[1] + 1, f.origin[2]).addScaledVector(new THREE.Vector3(f.direction[0], 0, f.direction[2]), -1);
  }

  step(now: number, dt: number, camera: THREE.Camera): void {
    const time = now - this.startedAt;
    this.lastTime = time;
    // internal projectile path: launch point → origin over the flight time
    if (!this.pathExternal && this.travelAt >= 0) {
      if (time >= this.travelAt && !this.path.active) {
        this.launchPoint(this.pathFrom);
        this.pathTo.set(this.frame.origin[0], this.frame.origin[1] + 1, this.frame.origin[2]);
        this.path.active = true;
      }
      if (this.path.active) {
        const k = Math.min(1, (time - this.travelAt) / this.travelFor);
        this.path.pos.lerpVectors(this.pathFrom, this.pathTo, k);
        this.path.vel.copy(this.pathTo).sub(this.pathFrom).divideScalar(this.travelFor);
      }
    }
    while (this.shotTimes.length > 0 && this.shotTimes[0]! <= time) {
      this.shotTimes.shift();
      if (!this.stopped) this.fireSimulated();
    }
    this.stepShots(dt);
    while (this.events.length > 0 && this.events[0]!.at <= time) {
      const ev = this.events.shift()!;
      if (this.stopped) continue;
      this.playPhase(ev.phase, ev.length, this.startedAt + ev.at);
    }
    for (let i = this.plays.length - 1; i >= 0; i--) {
      const p = this.plays[i]!;
      p.step(now, dt, camera);
      if (p.done) this.plays.splice(i, 1);
    }
  }

  stop(fade = 0.25): void {
    this.stopped = true;
    this.events.length = 0;
    this.shotTimes.length = 0;
    for (const shot of this.shots) shot.ended = true;
    for (const p of this.plays) p.stop(fade);
  }

  kill(): void {
    this.events.length = 0;
    for (const p of this.plays) p.kill();
    this.plays.length = 0;
  }
}

interface Shake {
  strength: number;
  duration: number;
  frequency: number;
  startedAt: number;
  phase: number;
}

export interface VfxStats {
  live: number;
  pooled: number;
  plays: number;
  spells: number;
  lightsInUse: number;
}

export class VfxSystem implements LiveModuleHost {
  readonly root = new THREE.Group();
  readonly resolvers: VfxResolvers;
  readonly particles: LiveModuleHost["particles"];
  // batches parent under `root`, so they precompile with the warmup sampler
  private readonly particleSystem = new ParticleSystem({ host: this.root });
  /** Every live trail's strip, one draw per blend mode (modules/trail-batch). */
  readonly trails = new TrailBatch(this.root);
  private readonly pools = new Map<string, LiveModule[]>();
  private readonly plays: EffectPlay[] = [];
  private readonly spells: SpellPlay[] = [];
  private readonly lights: THREE.PointLight[] = [];
  private readonly freeLights: THREE.PointLight[] = [];
  private readonly shakes: Shake[] = [];
  private readonly savedCamPos = new THREE.Vector3();
  /** Where the camera was on the last update; shake falloff is measured from it. */
  private readonly camPos = new THREE.Vector3();
  private hasCamPos = false;
  private shaking = false;
  private clock = 0;
  private liveCount = 0;
  private pooledCount = 0;

  constructor(resolvers: VfxResolvers = {}, opts: { maxLights?: number } = {}) {
    this.resolvers = resolvers;
    this.root.name = "vfx";
    this.root.userData["vfx"] = true;
    const n = opts.maxLights ?? 4;
    for (let i = 0; i < n; i++) {
      const light = new THREE.PointLight(0xffffff, 0, 8, 2);
      light.name = `vfx-light-${i}`;
      light.castShadow = false;
      light.userData["vfx"] = true;
      this.root.add(light);
      this.lights.push(light);
      this.freeLights.push(light);
    }
    this.particles = {
      register: (id, group, data) => this.particleSystem.register(id, group, data as ParticlesData, (assetId) => resolvers.texture?.(assetId)),
      setValue: (id, value) => this.particleSystem.setValue(id, value),
      unregister: (id) => this.particleSystem.unregister(id),
    };
  }

  /** Play-clock seconds. */
  get now(): number {
    return this.clock;
  }

  /**
   * Put the root into a scene. Call before the first render so the slot
   * lights are part of the light set from the start; safe to call every
   * frame (a rebuilt scene gets the root back).
   */
  attach(scene: THREE.Object3D): void {
    if (this.root.parent !== scene) scene.add(this.root);
  }

  // --- host contract ------------------------------------------------------

  takeLight(): THREE.PointLight | null {
    const l = this.freeLights.pop();
    if (l) return l;
    // All busy: steal the dimmest so a big impact still lights up.
    let dimmest: THREE.PointLight | null = null;
    for (const light of this.lights) if (!dimmest || light.intensity < dimmest.intensity) dimmest = light;
    return dimmest;
  }

  giveLight(light: THREE.PointLight): void {
    light.intensity = 0;
    if (!this.freeLights.includes(light)) this.freeLights.push(light);
  }

  addShake(strength: number, duration: number, frequency: number, at?: THREE.Vector3, range = 0): void {
    // Distance falloff. Without it every impact in the world shakes every
    // camera equally — a test NPC fighting across the map jolts the player.
    if (range > 0 && at && this.hasCamPos) {
      const d = this.camPos.distanceTo(at);
      if (d >= range) return;
      const f = 1 - d / range;
      strength *= f * f;
    }
    if (strength < 0.002) return;
    this.shakes.push({ strength, duration, frequency, startedAt: this.clock, phase: Math.random() * 10 });
  }

  // --- pools --------------------------------------------------------------

  private poolKey(module: VfxModule): string {
    if (module.kind === "particles") return ParticlesLive.poolKey(module);
    // nearest-filtered symbols and bilinear flipbooks are different textures
    // (and the texel-grid / halo shader variants are different shaders)
    if (module.kind === "sprite")
      return `sprite:${module.sheet}:${module.texel > 0 ? "grid" : module.pixel > 0 ? "px" : "lin"}${module.cell && module.glow > 0 ? "+glow" : ""}`;
    // a decal's shader is bound to its sheet's texture
    if (module.kind === "decal") return `decal:${module.sheet}`;
    return module.kind;
  }

  private create(kind: VfxModuleKind): LiveModule | null {
    switch (kind) {
      case "sprite":
        return new SpriteLive(this);
      case "particles":
        return new ParticlesLive(this);
      case "ring":
        return new RingLive(this);
      case "decal":
        return new DecalLive(this);
      case "shell":
        return new ShellLive(this);
      case "column":
        return new ColumnLive(this);
      case "beam":
        return new BeamLive(this);
      case "bolt":
        return new BoltLive(this);
      case "light":
        return new LightLive(this);
      case "mesh":
        return new MeshLive(this);
      case "trail":
        return new TrailLive(this);
      case "telegraph":
        return new TelegraphLive(this);
      case "slash":
        return new SlashLive(this);
      case "shake":
        return new ShakeLive(this);
      case "sound":
        return new SoundLive(this);
    }
  }

  acquire(module: VfxModule): LiveModule | null {
    const key = this.poolKey(module);
    const pool = this.pools.get(key);
    const pooled = pool?.pop();
    if (pooled) {
      this.pooledCount--;
      this.liveCount++;
      return pooled;
    }
    const inst = this.create(module.kind);
    if (inst) {
      (inst as { poolKey?: string }).poolKey = key;
      this.liveCount++;
    }
    return inst;
  }

  release(inst: LiveModule): void {
    const key = (inst as { poolKey?: string }).poolKey ?? inst.kind;
    let pool = this.pools.get(key);
    if (!pool) {
      pool = [];
      this.pools.set(key, pool);
    }
    // Bounded: a pool that only grows keeps every peak's worth of GPU objects.
    if (pool.length >= 24) {
      inst.dispose();
    } else {
      pool.push(inst);
      this.pooledCount++;
    }
    this.liveCount--;
  }

  // --- playing ------------------------------------------------------------

  play(
    effect: VfxEffect,
    frame: VfxFrame,
    opts: { phaseLength?: number; ownLight?: () => THREE.PointLight | null } = {},
  ): VfxHandle {
    const ctx: PlayContext = {
      frame,
      phaseLength: opts.phaseLength ?? 0,
      path: { pos: new THREE.Vector3(frame.origin[0], frame.origin[1], frame.origin[2]), vel: new THREE.Vector3(), active: false },
      ...(opts.ownLight ? { ownLight: opts.ownLight } : {}),
    };
    const play = new EffectPlay(this, effect, ctx, this.clock);
    this.plays.push(play);
    return play;
  }

  playSpell(spell: SpellDoc, frame: VfxFrame, opts: SpellPlayOptions = {}): SpellHandle {
    const play = new SpellPlay(this, spell, frame, this.clock - (opts.at ?? 0), opts);
    this.spells.push(play);
    return play;
  }

  /**
   * Warm the texture cache for these asset ids (masks, sheets) so a first
   * play is not invisible while its texture is still loading.
   */
  preload(textureIds: readonly string[]): void {
    for (const id of textureIds) {
      const url = this.resolvers.texture?.(id);
      if (!url) continue;
      // both filterings: a sheet is a bilinear flipbook AND a set of hard-edged symbols
      loadTexture(url, () => {});
      loadTexture(url, () => {}, true);
    }
  }

  /**
   * Compile every module kind's pipelines BEFORE the first cast.
   *
   * Measured in the lab (2026-09-03): a cold first play created 10–12 render
   * pipelines and stalled the frame for 265–739 ms; the same spell played
   * again created none and never left 8 ms. That is the "chug" a player
   * feels on the first spell of a session. This plays an invisible sampler —
   * one of every kind, plus the textured ring, the nearest-filtered symbol
   * sprite and the particle variants — far below the world, steps it once so
   * every mesh exists, hands the root to the host's `precompile` (the
   * context-borrowing one on EngineRenderer, so the shaders compile for the
   * pass that will actually draw them), then discards the play. Pooled
   * instances keep their materials, so the first real cast reuses them.
   *
   * `mask` / `sheet` are asset ids the host has (any PSX mask, any
   * spritesheet); without them those two variants are skipped.
   */
  async warmup(
    precompile: (group: THREE.Object3D) => Promise<void> | void,
    opts: { mask?: string; sheet?: string; sheets?: readonly string[]; decals?: readonly string[]; camera?: THREE.Camera } = {},
  ): Promise<void> {
    const ids: string[] = [];
    if (opts.mask) ids.push(opts.mask);
    const sheetDoc = opts.sheet ? this.resolvers.sheet?.(opts.sheet) : undefined;
    if (sheetDoc) ids.push(sheetDoc.texture);
    // every sheet the host has: a sprite's first draw of a sheet is its GPU
    // upload plus a program keyed on that texture, ~100 ms on a big one
    const sheets = (opts.sheets ?? []).filter((id) => id !== opts.sheet);
    for (const id of sheets) {
      const doc = this.resolvers.sheet?.(id);
      if (doc) ids.push(doc.texture);
    }
    // decal pages load as raw data (their channels are timing, not colour)
    const decalIds = (opts.decals ?? []).filter((id) => this.resolvers.sheet?.(id));
    await Promise.all(
      decalIds.map((id) => {
        const url = this.resolvers.texture?.(this.resolvers.sheet!(id)!.texture);
        return url ? new Promise<void>((resolve) => loadTexture(url, () => resolve(), true, true)) : Promise.resolve();
      }),
    );
    // textures first: the textured ring and the symbol sprite only build
    // their shaders once the image has landed
    await Promise.all(
      ids.flatMap((id) => {
        const url = this.resolvers.texture?.(id);
        if (!url) return [];
        return [false, true].map((nearest) => new Promise<void>((resolve) => loadTexture(url, () => resolve(), nearest)));
      }),
    );
    const modules: Array<Record<string, unknown>> = [
      { kind: "ring", radius: 1, duration: 1 },
      { kind: "shell", radius: 1, duration: 1, style: "energy" },
      { kind: "shell", radius: 1, duration: 1, style: "smoke", blend: "normal" },
      { kind: "column", radius: 1, height: 2, duration: 1 },
      { kind: "beam", length: 3, duration: 1 },
      { kind: "bolt", length: 3, duration: 1, toTarget: false },
      { kind: "light", duration: 1 },
      { kind: "mesh", size: 1, duration: 1 },
      { kind: "trail", duration: 1 },
      { kind: "slash", radius: 1, duration: 1 },
      { kind: "telegraph", radius: 2, windup: 0.5, hold: 0.5, pixel: 24, posterize: 4 },
      { kind: "telegraph", shape: "cone", radius: 2, angle: 45, windup: 0.5, hold: 0.5, pixel: 24, posterize: 4 },
      { kind: "telegraph", shape: "line", radius: 3, width: 0.5, windup: 0.5, hold: 0.5, pixel: 24, posterize: 4 },
      { kind: "particles", burst: 4, duration: 1, emitter: { max: 8, lifetime: [1, 1] } },
      { kind: "particles", burst: 4, duration: 1, emitter: { max: 8, lifetime: [1, 1], sprite: "square", stretch: 0.05 } },
      { kind: "particles", burst: 4, duration: 1, emitter: { max: 8, lifetime: [1, 1], sprite: "pixel" } },
      { kind: "particles", burst: 4, duration: 1, emitter: { max: 8, lifetime: [1, 1], sprite: "flame" } },
      { kind: "particles", burst: 4, duration: 1, emitter: { max: 8, lifetime: [1, 1], softFade: 0.8 } },
      { kind: "particles", burst: 4, duration: 1, blend: "normal", emitter: { max: 8, lifetime: [1, 1], blending: "normal" } },
      { kind: "particles", burst: 4, duration: 1, blend: "normal", emitter: { max: 8, lifetime: [1, 1], blending: "normal", softFade: 0.8 } },
    ];
    if (opts.mask) modules.push({ kind: "ring", radius: 1, duration: 1, texture: opts.mask, pixel: 24, posterize: 4 });
    if (sheetDoc && opts.sheet) {
      modules.push({ kind: "sprite", sheet: opts.sheet, duration: 1 });
      modules.push({ kind: "sprite", sheet: opts.sheet, duration: 1, cell: [0, 0], pixel: 24 });
      // the texel-grid symbol, with and without its halo, and drawn summoned bodies
      modules.push({ kind: "sprite", sheet: opts.sheet, duration: 1, cell: [0, 0], texel: 0.03 });
      modules.push({ kind: "sprite", sheet: opts.sheet, duration: 1, cell: [0, 0], texel: 0.03, glow: 1, orient: "world", crossed: true });
      modules.push({ kind: "mesh", sheet: opts.sheet, cells: [[0, 0]], duration: 1, texel: 0.03 });
    }
    for (const id of sheets) modules.push({ kind: "sprite", sheet: id, duration: 1 });
    for (const id of decalIds) modules.push({ kind: "decal", sheet: id, duration: 1, grow: 0.5 });
    const effect = vfxEffectSchema.parse({ name: "warmup", modules });
    const frame: VfxFrame = { origin: [0, -1000, 0], direction: [0, 0, -1], palette: { primary: "#ffffff", secondary: "#888888", glow: "#ffffff" } };
    const play = this.play(effect, frame) as EffectPlay;
    const camera = opts.camera ?? new THREE.PerspectiveCamera();
    // two steps: modules begin on the first, textured ones show on the second
    this.update(0.016, camera);
    this.update(0.016, camera);
    // a trail with no history hides itself; the compile only needs the material
    this.root.traverse((o) => {
      if (o.userData["vfx"] && (o as THREE.Mesh).isMesh) o.visible = true;
    });
    try {
      await precompile(this.root);
    } catch (error) {
      console.warn("[vfx] warmup precompile failed:", error);
    }
    play.kill();
    this.root.traverse((o) => {
      if (o.userData["vfx"] && (o as THREE.Mesh).isMesh && !(o as THREE.Light).isLight) o.visible = false;
    });
  }

  /** Stop everything, fading over `fade` seconds. */
  stopAll(fade = 0.2): void {
    for (const p of this.plays) p.stop(fade);
    for (const s of this.spells) s.stop(fade);
  }

  update(dt: number, camera: THREE.Camera, scene?: THREE.Object3D): void {
    if (scene) this.attach(scene);
    // Before the modules step: a shake begun this frame measures from here.
    camera.updateMatrixWorld();
    this.camPos.setFromMatrixPosition(camera.matrixWorld);
    this.hasCamPos = true;
    this.clock += dt;
    const now = this.clock;
    this.trails.begin();
    for (let i = this.spells.length - 1; i >= 0; i--) {
      const s = this.spells[i]!;
      s.step(now, dt, camera);
      if (s.done) this.spells.splice(i, 1);
    }
    for (let i = this.plays.length - 1; i >= 0; i--) {
      const p = this.plays[i]!;
      p.step(now, dt, camera);
      if (p.done) this.plays.splice(i, 1);
    }
    this.trails.end();
    this.particleSystem.update(dt, camera);
    for (let i = this.shakes.length - 1; i >= 0; i--) {
      if (now - this.shakes[i]!.startedAt >= this.shakes[i]!.duration) this.shakes.splice(i, 1);
    }
  }

  /**
   * Offset the render camera by the summed shakes. Call right before the
   * render, then `restoreShake` right after — the rig owns the camera and
   * must never see the offset.
   */
  applyShake(camera: THREE.Camera): void {
    if (this.shakes.length === 0 || this.shaking) return;
    let x = 0;
    let y = 0;
    for (const s of this.shakes) {
      const age = this.clock - s.startedAt;
      const env = Math.max(0, 1 - age / s.duration);
      const w = age * s.frequency * Math.PI * 2;
      x += Math.sin(w + s.phase) * s.strength * env;
      y += Math.sin(w * 1.31 + s.phase * 2) * s.strength * env * 0.6;
    }
    this.savedCamPos.copy(camera.position);
    camera.updateMatrixWorld();
    const right = new THREE.Vector3(1, 0, 0).applyQuaternion(camera.quaternion);
    const up = new THREE.Vector3(0, 1, 0).applyQuaternion(camera.quaternion);
    camera.position.addScaledVector(right, x).addScaledVector(up, y);
    camera.updateMatrixWorld();
    this.shaking = true;
  }

  restoreShake(camera: THREE.Camera): void {
    if (!this.shaking) return;
    camera.position.copy(this.savedCamPos);
    camera.updateMatrixWorld();
    this.shaking = false;
  }

  stats(): VfxStats {
    return {
      live: this.liveCount,
      pooled: this.pooledCount,
      plays: this.plays.length,
      spells: this.spells.length,
      lightsInUse: this.lights.length - this.freeLights.length,
    };
  }

  dispose(): void {
    for (const p of this.plays) p.kill();
    for (const s of this.spells) s.kill();
    this.plays.length = 0;
    this.spells.length = 0;
    for (const pool of this.pools.values()) for (const inst of pool) inst.dispose();
    this.pools.clear();
    this.particleSystem.clear();
    this.trails.dispose();
    this.root.removeFromParent();
  }
}

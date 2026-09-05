import * as THREE from "three/webgpu";
import {
  expandRepeat,
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
import { ShellLive } from "./modules/shell.js";
import { SlashLive } from "./modules/slash.js";
import { SpriteLive } from "./modules/sprite.js";
import { TelegraphLive } from "./modules/telegraph.js";
import { TrailLive } from "./modules/trail.js";
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
}

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
    if (t.travel) add("travel", t.travel.at, t.travel.duration);
    if (t.impact) add("impact", t.impact.at);
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
    return this.events.length === 0 && this.plays.every((p) => p.done);
  }

  private playPhase(phase: Phase, length: number | undefined, at: number, point?: [number, number, number]): void {
    const effect = this.spell.phases[phase];
    if (!effect) return;
    const frame = point ? { ...this.frame, origin: point } : this.frame;
    const ctx: PlayContext = { frame, phaseLength: length ?? 0, path: this.path };
    this.plays.push(new EffectPlay(this.system, effect, ctx, at));
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
  private readonly particleSystem = new ParticleSystem();
  private readonly pools = new Map<string, LiveModule[]>();
  private readonly plays: EffectPlay[] = [];
  private readonly spells: SpellPlay[] = [];
  private readonly lights: THREE.PointLight[] = [];
  private readonly freeLights: THREE.PointLight[] = [];
  private readonly shakes: Shake[] = [];
  private readonly savedCamPos = new THREE.Vector3();
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

  addShake(strength: number, duration: number, frequency: number): void {
    this.shakes.push({ strength, duration, frequency, startedAt: this.clock, phase: Math.random() * 10 });
  }

  // --- pools --------------------------------------------------------------

  private poolKey(module: VfxModule): string {
    if (module.kind === "particles") return ParticlesLive.poolKey(module);
    // nearest-filtered symbols and bilinear flipbooks are different textures
    if (module.kind === "sprite") return `sprite:${module.sheet}:${module.pixel > 0 ? "px" : "lin"}`;
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

  play(effect: VfxEffect, frame: VfxFrame, opts: { phaseLength?: number } = {}): VfxHandle {
    const ctx: PlayContext = {
      frame,
      phaseLength: opts.phaseLength ?? 0,
      path: { pos: new THREE.Vector3(frame.origin[0], frame.origin[1], frame.origin[2]), vel: new THREE.Vector3(), active: false },
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
    opts: { mask?: string; sheet?: string; sheets?: readonly string[]; camera?: THREE.Camera } = {},
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
      { kind: "particles", burst: 4, duration: 1, emitter: { max: 8, lifetime: [1, 1], softFade: 0.8 } },
      { kind: "particles", burst: 4, duration: 1, blend: "normal", emitter: { max: 8, lifetime: [1, 1], blending: "normal" } },
      { kind: "particles", burst: 4, duration: 1, blend: "normal", emitter: { max: 8, lifetime: [1, 1], blending: "normal", softFade: 0.8 } },
    ];
    if (opts.mask) modules.push({ kind: "ring", radius: 1, duration: 1, texture: opts.mask, pixel: 24, posterize: 4 });
    if (sheetDoc && opts.sheet) {
      modules.push({ kind: "sprite", sheet: opts.sheet, duration: 1 });
      modules.push({ kind: "sprite", sheet: opts.sheet, duration: 1, cell: [0, 0], pixel: 24 });
    }
    for (const id of sheets) modules.push({ kind: "sprite", sheet: id, duration: 1 });
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
    this.clock += dt;
    const now = this.clock;
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
    this.root.removeFromParent();
  }
}

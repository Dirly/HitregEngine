import type * as THREE from "three";
import { Script, type BiomeAt, type LiveSkyBase } from "./script.js";
import type { ScriptRegistry } from "./registry.js";
import {
  approach,
  approachAngle,
  easingByName,
  lerpVec3,
  loopProgress,
  pingPongProgress,
  type LoopMode,
} from "./easing.js";

/**
 * The standard interaction vocabulary, v1. Most gameplay requests should
 * resolve to attaching one of these with params — code is the escape hatch.
 */

class Spinner extends Script {
  static override scriptName = "spinner";
  static override params = {
    speed: { default: 1.5, min: -10, max: 10, description: "radians/sec around local Y" },
  };

  override onFixedUpdate(dt: number): void {
    this.object.rotateY(this.param<number>("speed") * dt);
  }
}

class Oscillator extends Script {
  static override scriptName = "oscillator";
  static override params = {
    axis: { default: [0, 1, 0], description: "movement direction" },
    amplitude: { default: 1, min: 0, max: 20 },
    period: { default: 2, min: 0.1, max: 60, description: "seconds per cycle" },
  };

  private origin: [number, number, number] = [0, 0, 0];

  override onStart(): void {
    const p = this.object.position;
    this.origin = [p.x, p.y, p.z];
  }

  override onFixedUpdate(): void {
    // visual/kinematic motion — pair with a physics body only if kinematic
    const axis = this.param<[number, number, number]>("axis");
    const offset =
      Math.sin((this.ctx.now() / 1000 / this.param<number>("period")) * Math.PI * 2) *
      this.param<number>("amplitude");
    this.object.position.set(
      this.origin[0] + axis[0] * offset,
      this.origin[1] + axis[1] * offset,
      this.origin[2] + axis[2] * offset,
    );
  }
}

class PlayerController extends Script {
  static override scriptName = "player-controller";
  static override params = {
    speed: { default: 6, min: 0, max: 30 },
    jump: { default: 7, min: 0, max: 30, description: "jump velocity" },
  };

  override onFixedUpdate(): void {
    const sim = this.ctx.sim;
    if (!sim) return;
    const vel = sim.getLinvel(this.entityId);
    if (!vel) return;

    const input = this.ctx.input;
    let forwardIn = 0;
    let strafeIn = 0;
    if (input.isDown("KeyW") || input.isDown("ArrowUp")) forwardIn += 1;
    if (input.isDown("KeyS") || input.isDown("ArrowDown")) forwardIn -= 1;
    if (input.isDown("KeyA") || input.isDown("ArrowLeft")) strafeIn -= 1;
    if (input.isDown("KeyD") || input.isDown("ArrowRight")) strafeIn += 1;

    // camera-relative when the host provides a view direction; world axes otherwise
    const [fx, fz] = this.ctx.viewForward?.() ?? [0, -1];
    const rx = -fz; // right = forward rotated -90° about Y
    const rz = fx;
    let x = fx * forwardIn + rx * strafeIn;
    let z = fz * forwardIn + rz * strafeIn;
    const len = Math.hypot(x, z);
    const speed = this.param<number>("speed");
    if (len > 0) {
      x = (x / len) * speed;
      z = (z / len) * speed;
    }

    let vy = vel[1];
    // crude grounded check: vertical velocity near zero
    if (input.isDown("Space") && Math.abs(vy) < 0.05) {
      vy = this.param<number>("jump");
    }
    sim.setLinvel(this.entityId, [x, vy, z]);
  }
}

class Collectible extends Script {
  static override scriptName = "collectible";
  static override params = {
    collectorTag: { default: "player", description: "tag that may collect this" },
  };

  private collected = false;

  override onCollision(otherId: string): void {
    if (this.collected) return;
    const other = this.ctx.getEntity(otherId.split(":")[0]!) ?? this.ctx.getEntity(otherId);
    if (!other?.tags.includes(this.param<string>("collectorTag"))) return;
    this.collected = true;
    this.object.visible = false;
    this.ctx.playSound?.();
    console.log(`[collectible] ${this.entityId} collected by ${otherId}`);
  }
}

/**
 * Moving platform: ping-pongs between its start and start+`distance` at a
 * constant `speed`, pausing `dwell` seconds at each end. Kinematic (drives
 * the transform directly, like Oscillator) — pair with a kinematic rigidbody
 * so riders are carried. Motion is a pure function of accumulated sim time,
 * so it never drifts and replays identically on every client.
 */
class PlatformMover extends Script {
  static override scriptName = "platform-mover";
  static override params = {
    distance: { default: [0, 3, 0], description: "offset from start to the far end" },
    speed: { default: 2, min: 0, max: 50, description: "units/sec along the path" },
    dwell: { default: 1, min: 0, max: 60, description: "seconds paused at each end" },
    ease: { default: "linear", description: "easing curve name applied to each leg (e.g. easeInOutQuad)" },
  };

  private origin: [number, number, number] = [0, 0, 0];

  override onStart(): void {
    const p = this.object.position;
    this.origin = [p.x, p.y, p.z];
  }

  override onFixedUpdate(): void {
    const d = this.param<[number, number, number]>("distance");
    const length = Math.hypot(d[0], d[1], d[2]);
    const speed = this.param<number>("speed");
    if (length === 0 || speed === 0) return; // degenerate: nowhere to go
    const travel = length / speed; // seconds for one A→B leg
    const dwell = this.param<number>("dwell");
    const raw = pingPongProgress(this.ctx.now() / 1000, travel, dwell);
    const s = easingByName(this.param<string>("ease"))(raw); // 0 at A, 1 at B
    this.object.position.set(
      this.origin[0] + d[0] * s,
      this.origin[1] + d[1] * s,
      this.origin[2] + d[2] * s,
    );
  }
}

/**
 * Proximity door: opens while any entity tagged `openerTag` is within `range`
 * and closes when they leave, easing `open` 0→1 at `speed`/sec. Opening
 * slides by `move` and/or spins by `rotateY` degrees about local Y. Pure
 * transform animation — no physics, no events — so it is trivially authored
 * ("make this a door the player opens") and multiplayer-correct by suspension.
 */
class Door extends Script {
  static override scriptName = "door";
  static override params = {
    openerTag: { default: "player", description: "tag that opens the door when near" },
    range: { default: 3, min: 0, max: 50, description: "open when an opener is within this" },
    move: { default: [0, 3, 0], description: "slide offset when fully open" },
    rotateY: { default: 0, min: -180, max: 180, description: "spin (deg) about Y when open" },
    speed: { default: 3, min: 0.1, max: 20, description: "open/close rate (fraction/sec)" },
  };

  private origin: [number, number, number] = [0, 0, 0];
  private originYaw = 0;
  private open = 0;

  override onStart(): void {
    const p = this.object.position;
    this.origin = [p.x, p.y, p.z];
    this.originYaw = this.object.rotation.y;
  }

  override onFixedUpdate(dt: number): void {
    const target = this.anyOpenerNear() ? 1 : 0;
    const step = this.param<number>("speed") * dt;
    this.open = approach(this.open, target, step);

    const move = this.param<[number, number, number]>("move");
    this.object.position.set(
      this.origin[0] + move[0] * this.open,
      this.origin[1] + move[1] * this.open,
      this.origin[2] + move[2] * this.open,
    );
    const yaw = (this.param<number>("rotateY") * Math.PI) / 180;
    this.object.rotation.y = this.originYaw + yaw * this.open;
  }

  private anyOpenerNear(): boolean {
    const range = this.param<number>("range");
    const rangeSq = range * range;
    // measure from the REST position, never the animated one — otherwise the
    // door slides out of its own range as it opens and oscillates
    const [hx, hy, hz] = this.origin;
    for (const id of this.ctx.findByTag(this.param<string>("openerTag"))) {
      if (id === this.entityId) continue;
      const other = this.ctx.getObject(id);
      if (!other) continue;
      const dx = other.position.x - hx;
      const dy = other.position.y - hy;
      const dz = other.position.z - hz;
      if (dx * dx + dy * dy + dz * dz <= rangeSq) return true;
    }
    return false;
  }
}

/**
 * Face-target: yaws to look at the nearest entity tagged `targetTag`
 * (turrets, security cameras, NPCs tracking the player). `turnSpeed` 0 snaps
 * instantly; otherwise it eases at that many radians/sec along the shortest
 * arc. `range` 0 means unlimited; a positive range ignores targets farther
 * than that (and holds the last heading). Yaw-only — the entity stays upright.
 */
class FaceTarget extends Script {
  static override scriptName = "face-target";
  static override params = {
    targetTag: { default: "player", description: "tag of the entity to face" },
    range: { default: 0, min: 0, max: 500, description: "0 = unlimited; else max look distance" },
    turnSpeed: { default: 0, min: 0, max: 20, description: "rad/sec (0 = instant snap)" },
  };

  override onFixedUpdate(dt: number): void {
    const target = this.nearestTarget();
    if (!target) return; // nobody in range — hold heading
    const here = this.object.position;
    const dx = target[0] - here.x;
    const dz = target[2] - here.z;
    if (dx === 0 && dz === 0) return; // directly above/below — yaw undefined
    // default forward is local -Z; this yaw points it at (dx, dz)
    const desired = Math.atan2(-dx, -dz);
    const turnSpeed = this.param<number>("turnSpeed");
    if (turnSpeed <= 0) {
      this.object.rotation.y = desired;
      return;
    }
    // shortest-arc ease toward the desired heading
    this.object.rotation.y = approachAngle(this.object.rotation.y, desired, turnSpeed * dt);
  }

  private nearestTarget(): [number, number, number] | null {
    const range = this.param<number>("range");
    const rangeSq = range > 0 ? range * range : Infinity;
    const here = this.object.position;
    let best: [number, number, number] | null = null;
    let bestSq = rangeSq;
    for (const id of this.ctx.findByTag(this.param<string>("targetTag"))) {
      if (id === this.entityId) continue;
      const other = this.ctx.getObject(id);
      if (!other) continue;
      const dx = other.position.x - here.x;
      const dy = other.position.y - here.y;
      const dz = other.position.z - here.z;
      const distSq = dx * dx + dy * dy + dz * dz;
      if (distSq <= bestSq) {
        bestSq = distSq;
        best = [other.position.x, other.position.y, other.position.z];
      }
    }
    return best;
  }
}

/**
 * Generic property tweener: animates this entity's position, rotation (deg,
 * offset from spawn per axis — like `door`'s rotateY), or scale (multiplier
 * on spawn scale) from `from` to `to` over `duration` seconds along an easing
 * curve, `loop`-ing once/repeating/ping-ponging. For anything a dedicated
 * behavior (`oscillator`, `platform-mover`, `door`) doesn't already cover —
 * pulsing props, growing/shrinking pickups, custom eased motion.
 */
class Tweener extends Script {
  static override scriptName = "tweener";
  static override params = {
    property: { default: "position", description: "position | rotation (deg offset) | scale (multiplier)" },
    from: { default: [0, 0, 0], description: "value at t=0" },
    to: { default: [0, 1, 0], description: "value at t=1" },
    duration: { default: 2, min: 0.05, max: 300, description: "seconds for one from→to pass" },
    ease: { default: "linear", description: "easing curve name, e.g. easeInOutQuad, easeOutElastic" },
    loop: { default: "loop", description: "once | loop | pingpong" },
  };

  private origin: [number, number, number] = [0, 0, 0];
  private originEuler: [number, number, number] = [0, 0, 0];
  private originScale: [number, number, number] = [1, 1, 1];

  override onStart(): void {
    const p = this.object.position;
    this.origin = [p.x, p.y, p.z];
    const r = this.object.rotation;
    this.originEuler = [r.x, r.y, r.z];
    const s = this.object.scale;
    this.originScale = [s.x, s.y, s.z];
  }

  override onFixedUpdate(): void {
    const duration = this.param<number>("duration");
    const loop = this.param<LoopMode>("loop");
    const raw = loopProgress(this.ctx.now() / 1000, duration, loop);
    const eased = easingByName(this.param<string>("ease"))(raw);
    const v = lerpVec3(
      this.param<[number, number, number]>("from"),
      this.param<[number, number, number]>("to"),
      eased,
    );

    switch (this.param<string>("property")) {
      case "rotation":
        this.object.rotation.set(
          this.originEuler[0] + (v[0] * Math.PI) / 180,
          this.originEuler[1] + (v[1] * Math.PI) / 180,
          this.originEuler[2] + (v[2] * Math.PI) / 180,
        );
        break;
      case "scale":
        this.object.scale.set(
          this.originScale[0] * v[0],
          this.originScale[1] * v[1],
          this.originScale[2] * v[2],
        );
        break;
      default:
        this.object.position.set(
          this.origin[0] + v[0],
          this.origin[1] + v[1],
          this.origin[2] + v[2],
        );
    }
  }
}

/**
 * Damageable: hit points that drop when a collider tagged `hazardTag` touches
 * this entity (spikes, lava, projectiles), with `invulnMs` i-frames between
 * hits so one contact isn't billed every tick. Drives this entity's health
 * billboard (fill = hp/maxHp) if it has one, and hides the entity at 0 hp.
 *
 * Self-contained and LOCAL, exactly like `collectible` — no networked combat
 * contract is presumed here (that stays game-specific, e.g. a game's
 * authority-validated hit event). Good as a single-player / local hazard
 * primitive; graduate to a networked version when the combat model is settled.
 */
class Damageable extends Script {
  static override scriptName = "damageable";
  static override params = {
    maxHp: { default: 100, min: 1, max: 100000 },
    hazardTag: { default: "hazard", description: "colliders with this tag deal damage" },
    damagePerHit: { default: 10, min: 0, max: 100000 },
    invulnMs: { default: 500, min: 0, max: 10000, description: "i-frames between hits" },
  };

  private hp = 0;
  private invulnerable = false;

  override onStart(): void {
    this.hp = this.param<number>("maxHp");
    this.ctx.setBillboard?.({ fill: 1 });
  }

  override onCollision(otherId: string): void {
    if (this.invulnerable || this.hp <= 0) return;
    // colliders can be sub-entities ("id:childIndex") — resolve the root too
    const other = this.ctx.getEntity(otherId.split(":")[0]!) ?? this.ctx.getEntity(otherId);
    if (!other?.tags.includes(this.param<string>("hazardTag"))) return;

    this.hp = Math.max(0, this.hp - this.param<number>("damagePerHit"));
    this.ctx.setBillboard?.({ fill: this.hp / this.param<number>("maxHp") });

    if (this.hp <= 0) {
      this.object.visible = false;
      return;
    }
    // i-frames: use the sim-stepped timer, not wall-clock, so it replays
    const invulnMs = this.param<number>("invulnMs");
    if (invulnMs > 0) {
      this.invulnerable = true;
      this.ctx.after(invulnMs / 1000, () => {
        this.invulnerable = false;
      });
    }
  }
}

/**
 * Third-person character movement: camera-relative WASD, Space to jump, and
 * the model smoothly turns to face where it's running. Crossfades across a
 * full walk/run/sprint gait ladder off its own velocity, so it needs no
 * game-specific wiring. Reads a few optional runtime channels other scripts
 * may set on object.userData: speedMult (upgrades), frozen (menus pause
 * movement), holdingWeapon (swaps to the *_Hold clips), actionClip/actionUntil
 * (a one-shot clip that overrides locomotion until the given time),
 * impulseVel/impulseUntil (an external horizontal drive — dash, knockback —
 * that input cannot cancel while it lasts).
 *
 * The gait is chosen from MEASURED planar velocity, not from which key is
 * held, so a character slowed by a swamp or driven by AI rather than input
 * still picks the clip that matches how fast it is actually travelling.
 *
 * Every clip past idle/run is optional. A model that shipped without a "Walk"
 * falls back to its run cycle rather than asking the animator for a clip that
 * doesn't exist and freezing mid-stride, so this stays a drop-in for models
 * with two clips and for models with twenty.
 */
class ThirdPersonController extends Script {
  static override scriptName = "third-person-controller";
  static override params = {
    speed: { default: 6.5, min: 0, max: 30, description: "run speed — the default gait" },
    walkSpeed: { default: 2.2, min: 0, max: 30, description: "speed while the walk key is held" },
    sprintSpeed: { default: 9.5, min: 0, max: 40, description: "speed while the sprint key is held" },
    jump: { default: 8, min: 0, max: 30, description: "jump velocity" },
    idleClip: { default: "Idle" },
    walkClip: { default: "Walk", description: "optional — falls back to the run clip" },
    runClip: { default: "Run" },
    sprintClip: { default: "Sprint", description: "optional — falls back to the run clip" },
    airClip: { default: "Jump_Loop", description: "optional — played while off the ground" },
    backClip: { default: "Run_Bwd", description: "optional — played while backing up" },
    leftClip: { default: "Run_Left", description: "optional — played while strafing left" },
    rightClip: { default: "Run_Right", description: "optional — played while strafing right" },
    sprintKey: { default: "ShiftLeft", description: "hold to sprint" },
    walkKey: { default: "AltLeft", description: "hold to walk" },
    autoRunKey: {
      default: "NumLock",
      description: "Toggles run-forward-without-holding-a-key. Pressing back cancels it. Blank to disable.",
    },
    fallSpeed: {
      default: 2,
      min: 0.2,
      max: 20,
      description:
        "Downward speed that counts as FALLING rather than settling onto the ground. Too low and a " +
        "character walking down a slope plays the falling clip; too high and a real drop reads as " +
        "grounded until it is well underway.",
    },
    coyoteTime: {
      default: 0.12,
      min: 0,
      max: 1,
      description:
        "Seconds of continuous airborne evidence before the character is treated as off the ground — " +
        "and, as a bonus, the grace period in which a jump still registers after walking off a ledge.",
    },
    backpedal: {
      default: true,
      description:
        "Backing up keeps the character facing forward and plays the back clip, instead of " +
        "spinning it around to run away from the camera. Only applies when `face` is movement; " +
        "camera-facing already strafes.",
    },
    sideSpeedMult: {
      default: 0.65,
      min: 0.1,
      max: 1,
      description: "Fraction of the gait speed kept when moving sideways or backwards.",
    },
    syncClipSpeed: {
      default: true,
      description:
        "Scale playback to the distance actually covered, so feet stay planted between gaits. " +
        "Turn off for clips that carry their own root motion.",
    },
    clipSpeeds: {
      default: {},
      description:
        "The ground speed each locomotion clip was AUTHORED at, in m/s — e.g. " +
        '{"Walk": 1.02, "Run": 6.02}. This is what makes syncClipSpeed exact rather than a ' +
        "guess: without it a clip is assumed to be authored at whatever speed its gait is tuned " +
        "to, and any gap between the two shows up as skating feet. The `retarget` tool measures " +
        "these off the baked clips and prints them ready to paste.",
    },
    modelYaw: { default: 0, min: -3.1416, max: 3.1416, description: "extra yaw if the model faces backwards" },
    turnSpeed: { default: 14, min: 1, max: 40, description: "how snappily the character turns" },
    face: { default: "camera", description: "camera = always face the aim (strafe shooter); movement = face where you run" },
  };

  private yaw = 0;
  private airTime = 0;
  private lastJump = -999;
  private autoRun = false;
  private autoRunHeld = false;
  private lastClip = "";
  private lastRate = 1;
  private clips: Set<string> | null = null;

  private play(clip: string, fade: number): void {
    if (this.lastClip === clip) return;
    this.lastClip = clip;
    this.ctx.setAnimation?.(clip, fade);
  }

  /**
   * First clip of `names` the model actually has. When the host doesn't
   * publish a clip list we can't tell absent from present, so the first name
   * wins — exactly the behaviour before this list existed.
   */
  private pick(...names: string[]): string {
    if (!this.ctx.animationClips) return names[0]!;
    if (!this.clips) {
      // the glTF may still be in flight — keep asking until it answers, then
      // never again
      const list = this.ctx.animationClips();
      if (list.length === 0) return names[0]!;
      this.clips = new Set(list);
    }
    return names.find((n) => n && this.clips!.has(n)) ?? names[0]!;
  }

  /**
   * Playback rate that puts one stride on the ground per stride in the clip:
   * how fast we are travelling over the speed the clip was authored for. The
   * clamp keeps a badly matched pair from reading as slow motion or a scramble
   * — but it is a safety net, not the fix. Declare `clipSpeeds` and the rate
   * lands near 1 on its own.
   */
  private setRate(moving: number, clip: string, gaitSpeed: number): void {
    if (!this.param<boolean>("syncClipSpeed")) {
      this.setRateRaw(1);
      return;
    }
    const declared = (this.param<Record<string, number>>("clipSpeeds") ?? {})[clip];
    const nominal = declared && declared > 0 ? declared : gaitSpeed;
    this.setRateRaw(nominal > 0 ? moving / nominal : 1);
  }

  private setRateRaw(rate: number): void {
    const clamped = Math.max(0.6, Math.min(1.75, rate));
    if (Math.abs(clamped - this.lastRate) < 0.02) return;
    this.lastRate = clamped;
    this.ctx.setAnimationSpeed?.(clamped);
  }

  override onStart(): void {
    this.yaw = this.object.rotation.y;
    this.airTime = 0;
    this.autoRun = false;
    this.clips = null; // the model may still be loading; resolve on first use
    this.play(this.param<string>("idleClip"), 0.2);
  }

  override onFixedUpdate(dt: number): void {
    const sim = this.ctx.sim;
    if (!sim) return;
    const vel = sim.getLinvel(this.entityId);
    if (!vel) return;

    const ud = this.object.userData as {
      speedMult?: number;
      frozen?: boolean;
      holdingWeapon?: boolean;
      actionClip?: string;
      actionUntil?: number;
      impulseVel?: [number, number];
      impulseUntil?: number;
    };
    if (ud.frozen) {
      sim.setLinvel(this.entityId, [0, vel[1], 0]);
      this.play(this.param<string>("idleClip"), 0.25);
      return;
    }

    const input = this.ctx.input;
    let forwardIn = 0;
    let strafeIn = 0;
    if (input.isDown("KeyW") || input.isDown("ArrowUp")) forwardIn += 1;
    if (input.isDown("KeyS") || input.isDown("ArrowDown")) forwardIn -= 1;
    if (input.isDown("KeyA") || input.isDown("ArrowLeft")) strafeIn -= 1;
    if (input.isDown("KeyD") || input.isDown("ArrowRight")) strafeIn += 1;

    // Auto-run: a latch, so the hands are free. Toggled on the key's PRESS
    // edge (isDown is a level, and reading it as an event would flip the latch
    // every tick the key is held), and cancelled by asking to go backwards —
    // which is what every game that has this does, and what you expect when you
    // reach for the back key to stop.
    const autoRunKey = this.param<string>("autoRunKey");
    const autoRunDown = autoRunKey ? input.isDown(autoRunKey) : false;
    if (autoRunDown && !this.autoRunHeld) this.autoRun = !this.autoRun;
    this.autoRunHeld = autoRunDown;
    if (this.autoRun) {
      if (forwardIn < 0) this.autoRun = false;
      else forwardIn = 1;
    }

    // camera-relative when the host provides a view direction
    const [fx, fz] = this.ctx.viewForward?.() ?? [0, -1];
    const rx = -fz;
    const rz = fx;
    let x = fx * forwardIn + rx * strafeIn;
    let z = fz * forwardIn + rz * strafeIn;
    const len = Math.hypot(x, z);

    const runSpeed = this.param<number>("speed");
    const walkSpeed = this.param<number>("walkSpeed");
    const sprintSpeed = this.param<number>("sprintSpeed");
    const sprinting = input.isDown(this.param<string>("sprintKey"));
    const walking = input.isDown(this.param<string>("walkKey"));
    const gaitSpeed = sprinting ? sprintSpeed : walking ? walkSpeed : runSpeed;

    // Which way the character will FACE decides everything below, so resolve it
    // before the speed: camera mode always tracks the aim (so all four
    // directions are strafes), movement mode turns to where you run — except
    // when backing up, where spinning the character round to sprint at the
    // camera is exactly the thing that reads as broken. Backing up keeps the
    // facing and plays the back clip instead.
    const faceCamera = this.param<string>("face") === "camera";
    const backing =
      !faceCamera &&
      this.param<boolean>("backpedal") &&
      forwardIn < 0 &&
      strafeIn === 0 &&
      len > 0;

    // sideways and backwards travel is slower than a forward run, in every
    // game that has ever shipped and in every animation library authored for one
    const lateral = faceCamera ? forwardIn <= 0 || strafeIn !== 0 : backing;
    const speed =
      gaitSpeed * (ud.speedMult ?? 1) * (lateral ? this.param<number>("sideSpeedMult") : 1);
    if (len > 0) {
      x = (x / len) * speed;
      z = (z / len) * speed;
    }

    // An external drive — a dash, a knockback, a shove — owns horizontal
    // velocity for as long as it lasts. Without this channel any script that
    // sets linvel is silently stomped by the controller's next tick, which is
    // the single most confusing way for a dash to "not work".
    const driven = !!ud.impulseVel && (ud.impulseUntil ?? 0) > this.ctx.now() / 1000;
    if (driven) {
      x = ud.impulseVel![0];
      z = ud.impulseVel![1];
    }

    let vy = vel[1];

    // Grounded, carefully. "Vertical speed is near zero" is NOT a ground test:
    // gravity alone moves a resting body by ~0.16 m/s in a single 60Hz tick, so
    // a tight threshold reads as airborne almost every frame. That was harmless
    // while it only gated the jump key — you occasionally miss a jump — and
    // catastrophic once it picked the clip, because the character then plays a
    // falling pose permanently: legs tucked, feet still, sliding over the
    // ground. Which is exactly what "gliding in a jump pose" looks like.
    //
    // So require SUSTAINED evidence of leaving the ground, and give it a coyote
    // window. A downward raycast would be firmer, but it costs a query per
    // character per tick and this needs none.
    const now = this.ctx.now() / 1000;
    const leaving = vy > 0.8 || vy < -this.param<number>("fallSpeed");
    this.airTime = leaving ? this.airTime + dt : 0;
    const airborne =
      this.airTime > this.param<number>("coyoteTime") || now - this.lastJump < 0.25;
    const grounded = !airborne;
    if (input.isDown("Space") && grounded) {
      vy = this.param<number>("jump");
      this.lastJump = now; // and no re-jump inside the coyote window
    }
    sim.setLinvel(this.entityId, [x, vy, z]);

    // Where the body is headed, in world terms. The clip is chosen against
    // THIS rather than the interpolated `yaw` below: turning is cosmetic
    // smoothing, and reading a heading off a yaw that is still catching up
    // reports a strafe for the first few frames of every move.
    const facingTarget = faceCamera || backing ? Math.atan2(fx, fz) : Math.atan2(x, z);

    // steer the visual (body rotations are locked)
    if (faceCamera || backing || len > 0 || (driven && Math.hypot(x, z) > 0.05)) {
      const target = facingTarget + this.param<number>("modelYaw");
      let diff = target - this.yaw;
      while (diff > Math.PI) diff -= Math.PI * 2;
      while (diff < -Math.PI) diff += Math.PI * 2;
      this.yaw += diff * Math.min(1, this.param<number>("turnSpeed") * dt);
      this.object.rotation.set(0, this.yaw, 0);
    }

    if (ud.actionClip && (ud.actionUntil ?? 0) > now) {
      this.setRateRaw(1);
      this.play(ud.actionClip, 0.05);
      return;
    }

    // A held-weapon pose is a variant of whatever gait we land on, so resolve
    // the gait first and reach for the *_Hold variant second.
    const holding = ud.holdingWeapon === true;
    const variant = (base: string): string => (holding ? this.pick(`${base}_Hold`, base) : base);

    const idle = this.param<string>("idleClip");
    const run = this.param<string>("runClip");
    const walk = this.pick(this.param<string>("walkClip"), run);
    const sprint = this.pick(this.param<string>("sprintClip"), run);

    if (!grounded) {
      const air = this.pick(this.param<string>("airClip"), run);
      this.setRateRaw(1);
      this.play(variant(air), 0.15);
      return;
    }

    // Gait comes from how fast we are ACTUALLY moving, not from the key held:
    // a slowed or AI-driven character then still reads correctly. Thresholds
    // sit midway between the tiers so they follow the tuning params.
    const moving = Math.hypot(vel[0], vel[2]);
    if (moving < Math.max(0.15, walkSpeed * 0.35)) {
      this.setRateRaw(1);
      this.play(variant(idle), 0.25);
      return;
    }

    let clip = run;
    let nominal = runSpeed;
    if (walk !== run && moving < (walkSpeed + runSpeed) / 2) {
      clip = walk;
      nominal = walkSpeed;
    } else if (sprint !== run && moving > (runSpeed + sprintSpeed) / 2) {
      clip = sprint;
      nominal = sprintSpeed;
    }

    // Travelling in a direction the body is not pointing: a dedicated clip is
    // the only thing that reads right, because a forward cycle played while
    // sliding sideways is the definition of skating. Falls back to the gait
    // clip on a model that shipped without them.
    //
    // Only consult this where the facing is DELIBERATELY independent of travel
    // — camera-facing, or a backpedal. In movement-facing mode the character is
    // turning to face where it runs, so mid-turn the two disagree by up to 180°
    // for a few frames, and reading a heading off that flickers the back clip
    // at the start of every move.
    const heading = faceCamera || backing ? this.travelHeading(x, z, facingTarget) : null;
    if (heading !== null) {
      const directional =
        heading === "back"
          ? this.pick(this.param<string>("backClip"), clip)
          : heading === "left"
            ? this.pick(this.param<string>("leftClip"), clip)
            : this.pick(this.param<string>("rightClip"), clip);
      if (directional !== clip) {
        clip = directional;
        nominal = runSpeed * this.param<number>("sideSpeedMult");
      }
    }

    this.setRate(moving, clip, nominal);
    this.play(variant(clip), 0.15);
  }

  /**
   * Where the character is travelling relative to where it is FACING, or null
   * when it is running forwards (the common case, and the only one the plain
   * gait clips depict).
   */
  private travelHeading(
    x: number,
    z: number,
    facing: number,
  ): "back" | "left" | "right" | null {
    if (x === 0 && z === 0) return null;
    let angle = Math.atan2(x, z) - facing;
    while (angle > Math.PI) angle -= Math.PI * 2;
    while (angle < -Math.PI) angle += Math.PI * 2;
    const deg = (angle * 180) / Math.PI;
    if (Math.abs(deg) <= 50) return null;
    if (Math.abs(deg) >= 130) return "back";
    return deg > 0 ? "left" : "right";
  }
}

/**
 * Sockets this entity onto a named bone of its PARENT entity's skinned model
 * (weapons in hands, hats on heads). Visual-only: copies the bone's world
 * pose onto this entity every tick, with tunable offsets — adjust `offset` /
 * `rotationDeg` live in the inspector until the prop sits right.
 *
 * Finding the right bone: toggle "bones" in the editor toolbar to draw the
 * skeleton with joint name labels, and the inspector's `bone` field becomes
 * a dropdown of the parent model's actual bone names once the model loads.
 *
 * This package only imports three's *types*, so the scratch math objects are
 * cloned off the entity's own transform rather than constructed via
 * `new THREE.*` — keeps @hitreg/scripting runtime-free of three.
 */
class BoneSocket extends Script {
  static override scriptName = "bone-socket";
  static override params = {
    bone: {
      default: "mixamorig:RightHand",
      description: "bone name on the parent model's rig (see the 'bones' toolbar toggle)",
    },
    offset: { default: [0, 0, 0], description: "position offset, bone-oriented world units" },
    rotationDeg: { default: [0, 90, 0], description: "rotation offset in degrees" },
  };

  /**
   * Mirror of three's `PropertyBinding.sanitizeNodeName`, kept local because
   * `@hitreg/scripting` deliberately imports three only as a TYPE (`import type
   * * as THREE`) and must stay runtime-free of it.
   */
  static sanitizeBoneName(name: string): string {
    return name.replace(/[\s.:[\]/]/g, "");
  }

  private bone: THREE.Object3D | null = null;
  private offsetQuat!: THREE.Quaternion;
  private bonePos!: THREE.Vector3;
  private boneQuat!: THREE.Quaternion;
  private parentQuat!: THREE.Quaternion;
  private shift!: THREE.Vector3;

  override onStart(): void {
    const deg = this.param<[number, number, number]>("rotationDeg");
    const euler = this.object.rotation
      .clone()
      .set((deg[0] * Math.PI) / 180, (deg[1] * Math.PI) / 180, (deg[2] * Math.PI) / 180);
    this.offsetQuat = this.object.quaternion.clone().setFromEuler(euler);
    this.bonePos = this.object.position.clone();
    this.shift = this.object.position.clone();
    this.boneQuat = this.object.quaternion.clone();
    this.parentQuat = this.object.quaternion.clone();
    this.bone = null;
  }

  override onFixedUpdate(): void {
    const parent = this.object.parent;
    if (!parent) return;
    if (!this.bone) {
      // the skinned model loads async — keep looking until it appears
      const wanted = this.param<string>("bone");
      this.bone =
        parent.getObjectByName(wanted) ??
        // glTF node names are SANITIZED on load: three's GLTFLoader strips
        // `[ ] . : /` (PropertyBinding.sanitizeNodeName) because those are
        // reserved in animation-track paths. So the conventional Mixamo bone
        // "mixamorig:RightHand" — including this script's own default — exists
        // at runtime as "mixamorigRightHand" and a literal lookup NEVER
        // resolves. Falling back to the sanitized form means an author can
        // paste the name straight off the rig, or off any Mixamo export, and
        // have it work either way.
        parent.getObjectByName(BoneSocket.sanitizeBoneName(wanted)) ??
        null;
      if (!this.bone) return;
    }
    this.bone.updateWorldMatrix(true, false);
    this.bone.getWorldPosition(this.bonePos);
    this.bone.getWorldQuaternion(this.boneQuat);

    const off = this.param<[number, number, number]>("offset");
    this.shift.set(off[0], off[1], off[2]).applyQuaternion(this.boneQuat);
    this.bonePos.add(this.shift);

    parent.updateWorldMatrix(true, false);
    this.object.position.copy(parent.worldToLocal(this.bonePos));
    parent.getWorldQuaternion(this.parentQuat).invert();
    this.object.quaternion.copy(
      this.parentQuat.multiply(this.boneQuat).multiply(this.offsetQuat),
    );
  }
}

// ---- day/night ---------------------------------------------------------------

type Rgb = [number, number, number];
function hexToRgb(hex: string): Rgb {
  const n = parseInt(hex.replace("#", ""), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}
function rgbToHex(c: Rgb): string {
  const h = (v: number) => Math.round(Math.min(1, Math.max(0, v)) * 255).toString(16).padStart(2, "0");
  return `#${h(c[0])}${h(c[1])}${h(c[2])}`;
}
function mixRgb(a: Rgb, b: Rgb, t: number): Rgb {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}
function smooth01(x: number): number {
  const t = Math.min(1, Math.max(0, x));
  return t * t * (3 - 2 * t);
}
const NET_HOUR_KEY = "world.hour";

/**
 * A day/night cycle on the scene's existing sky and lights, with ONE
 * directional light playing sun and moon in turn and a moon disc on the dome.
 *
 * Everything it touches is a uniform or a light property (ctx.setSky), so it
 * runs every fixed tick for free. The two things it deliberately never does,
 * because each would recompile every lit material in the scene: toggle a
 * light on or off (the light set must stay constant — the sun dims to zero,
 * swings under the horizon and comes back as the moon), and hand the sky a
 * new environment texture (the IBL is refreshed IN PLACE, `envRefreshHours`
 * apart). The authored sky/sun/ambient are the DAY look; night is derived
 * from the params. Multiplayer: the authority owns the clock and publishes
 * it to netState every `syncSeconds`; peers ease toward it.
 */
class DayNight extends Script {
  static override scriptName = "day-night";
  static override params = {
    dayLength: { default: 1200, min: 10, max: 86400, description: "Real seconds per 24-hour game day." },
    startHour: { default: 9, min: 0, max: 24, description: "Clock at scene start: 6 = sunrise, 12 = noon, 18 = sunset." },
    tilt: { default: 30, min: 0, max: 80, description: "Degrees the sun's arc leans away from straight overhead (toward -Z), so noon shadows still fall somewhere." },
    dawnColor: { default: "#ff9d5c", description: "Sun colour at the horizon; blends into the sun light's authored colour by mid-morning." },
    moonColor: { default: "#93a9d6", description: "Moonlight colour — the same directional light, re-aimed for the night." },
    moonIntensity: { default: 0.25, min: 0, max: 5, description: "Moonlight intensity at its peak. The sun light's authored intensity is the noon value." },
    nightTop: { default: "#070a14", description: "Sky top colour at full night." },
    nightBottom: { default: "#121828", description: "Sky horizon and fog colour at full night." },
    nightAmbient: { default: 0.35, min: 0, max: 2, description: "Fraction of the authored ambient, hemisphere and IBL intensity kept at full night." },
    envRefreshHours: { default: 2, min: 0.25, max: 24, description: "Game hours between image-based-lighting refreshes. Each one is a prefilter pass — cheap a few times a day, not per frame." },
    syncSeconds: { default: 5, min: 1, max: 60, description: "Multiplayer: how often the host publishes the clock." },
    stars: { default: 1, min: 0, max: 4, description: "Star-field brightness at full night; 0 for no stars." },
    starDensity: { default: 0.35, min: 0, max: 1, description: "How much of the sky has a star in it." },
  };
  private hour = 9;
  private base: LiveSkyBase | null = null;
  private targetHour: number | null = null;
  private lastEnvBucket = -1;
  private sinceSync = 0;
  private unsubscribe: (() => void) | null = null;

  override onStart(): void {
    this.hour = ((this.param<number>("startHour") % 24) + 24) % 24;
    this.base = this.ctx.getSky?.() ?? null;
    const net = this.ctx.netState;
    if (net && !net.isAuthority()) {
      const published = net.get(NET_HOUR_KEY);
      if (typeof published === "number") this.hour = published;
      this.unsubscribe = net.onChange((key, value) => {
        if (key === NET_HOUR_KEY && typeof value === "number") this.targetHour = value;
      });
    }
    this.apply(true);
  }

  override onDispose(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  override onFixedUpdate(dt: number): void {
    const dayLength = Math.max(1, this.param<number>("dayLength"));
    this.hour = (this.hour + (dt / dayLength) * 24) % 24;
    const net = this.ctx.netState;
    if (net) {
      if (net.isAuthority()) {
        this.sinceSync += dt;
        if (this.sinceSync >= this.param<number>("syncSeconds")) {
          this.sinceSync = 0;
          net.set(NET_HOUR_KEY, this.hour);
        }
      } else if (this.targetHour !== null) {
        // ease onto the host's clock along the short way round the day
        let delta = this.targetHour - this.hour;
        if (delta > 12) delta -= 24;
        if (delta < -12) delta += 24;
        this.hour = (this.hour + delta * Math.min(1, dt * 2) + 24) % 24;
        if (Math.abs(delta) < 1e-3) this.targetHour = null;
      }
    }
    this.apply(false);
  }

  private apply(first: boolean): void {
    const setSky = this.ctx.setSky;
    if (!setSky) return;
    const base = this.base;
    const tilt = (this.param<number>("tilt") * Math.PI) / 180;
    // the sun's arc: sunrise at 6 (east, +X), noon at 12, sunset at 18 (west)
    const theta = ((this.hour - 6) / 12) * Math.PI;
    const sunDir: [number, number, number] = [Math.cos(theta), Math.sin(theta) * Math.cos(tilt), -Math.sin(theta) * Math.sin(tilt)];
    const moonDir: [number, number, number] = [-sunDir[0], -sunDir[1], -sunDir[2]];
    const e = sunDir[1]; // sun elevation, -1..1
    const day = smooth01((e + 0.12) / 0.3); // 1 by mid-morning, 0 once the sun is well down
    const horizonGlow = Math.max(0, 1 - Math.abs(e) / 0.25) * (e > -0.15 ? 1 : 0);

    const dawn = hexToRgb(this.param<string>("dawnColor"));
    const baseSunColor = hexToRgb(base?.sun?.color ?? "#fff1d6");
    const baseSunIntensity = base?.sun?.intensity ?? 1.2;
    const moonRgb = hexToRgb(this.param<string>("moonColor"));
    const moonIntensity = this.param<number>("moonIntensity");

    // ONE light: the sun until it sets, then the moon from the other side
    let lightDir = sunDir;
    let lightColor = mixRgb(dawn, baseSunColor, smooth01(e / 0.35));
    let lightIntensity = baseSunIntensity * smooth01(e / 0.2);
    if (e <= 0) {
      lightDir = moonDir;
      lightColor = moonRgb;
      lightIntensity = moonIntensity * smooth01(-e / 0.15);
    }

    const baseTop = hexToRgb(base?.top ?? "#39598f");
    const baseBottom = hexToRgb(base?.bottom ?? "#101522");
    const nightTop = hexToRgb(this.param<string>("nightTop"));
    const nightBottom = hexToRgb(this.param<string>("nightBottom"));
    const top = mixRgb(nightTop, baseTop, day);
    const bottom = mixRgb(mixRgb(nightBottom, baseBottom, day), dawn, 0.45 * horizonGlow);
    const keep = this.param<number>("nightAmbient") + (1 - this.param<number>("nightAmbient")) * day;

    const bucket = Math.floor(this.hour / Math.max(0.25, this.param<number>("envRefreshHours")));
    const refresh = first || bucket !== this.lastEnvBucket;
    this.lastEnvBucket = bucket;

    setSky({
      top: rgbToHex(top),
      bottom: rgbToHex(bottom),
      fog: { color: rgbToHex(bottom) },
      hemisphere: (base?.hemisphere ?? 0.5) * keep,
      sun: {
        direction: lightDir,
        color: rgbToHex(lightColor),
        intensity: lightIntensity,
        disc: { color: rgbToHex(mixRgb(dawn, [1, 0.96, 0.88], smooth01(e / 0.3))), size: 0.9985, intensity: 1.6 * smooth01((e + 0.03) / 0.08) },
      },
      moon: { direction: moonDir, color: this.param<string>("moonColor"), size: 0.9994, intensity: 1.2 * smooth01((moonDir[1] + 0.02) / 0.1) },
      // clouds keep the authored coverage; only their lighting follows the day —
      // white at noon, warmed by the dawn colour near the horizon, near-black
      // against the stars at night
      clouds: {
        light: 0.12 + 0.88 * day,
        color: rgbToHex(mixRgb(dawn, [1, 1, 1], smooth01(e / 0.3))),
        shadow: rgbToHex(mixRgb([0.08, 0.1, 0.16], [0.54, 0.58, 0.66], day)),
      },
      // the sky wheels about the arc's axis at the sun's own rate; stars fade
      // in once the sun is a little way down and are gone by mid-morning
      stars: {
        intensity: this.param<number>("stars") * smooth01((-e - 0.02) / 0.15),
        density: this.param<number>("starDensity"),
        rotation: { axis: [0, Math.sin(tilt), Math.cos(tilt)], angle: -theta },
      },
      ...(base?.ambient
        ? { ambient: { color: rgbToHex(mixRgb(mixRgb(nightBottom, hexToRgb(base.ambient.color), 0.5), hexToRgb(base.ambient.color), day)), intensity: base.ambient.intensity * keep } }
        : {}),
      environmentIntensity: (base?.environmentIntensity ?? 1) * keep,
      ...(refresh ? { refreshEnvironment: true } : {}),
    });
  }
}

// ---- weather ---------------------------------------------------------------

const NET_WEATHER_KEY = "world.weather";

/** The world's weather, as the authority rolls it: biome-agnostic on purpose. */
interface WeatherState {
  /** 0 = clear, 1 = the heaviest this world does. What it FALLS as is the client's biome's business. */
  precipitation: number;
  /** 0..1, how violent: wind, gloom, fog. */
  storm: number;
  /** Clock time (authority seconds) at which the next roll happens. */
  until: number;
}

type WeatherKind = "rain" | "sand" | "snow";
const KINDS: WeatherKind[] = ["rain", "sand", "snow"];
const TINTS: Record<WeatherKind, { color: string; amount: number }> = {
  rain: { color: "#6f7a8a", amount: 0.35 },
  sand: { color: "#b8895a", amount: 0.7 },
  snow: { color: "#cfd6e2", amount: 0.5 },
};

function splitList(value: string): Set<string> {
  return new Set(value.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean));
}

/**
 * Biome-aware weather on top of the day/night cycle.
 *
 * The AUTHORITY (dedicated server, or the P2P host) owns one biome-agnostic
 * state — how much precipitation, how stormy — rolled every `changeMinutes`
 * and published to netState. Every client then asks `ctx.biomeAt` what the
 * ground under its player is and blends three looks by the biome weights the
 * world already blends its textures with: rain where the rain biomes are,
 * blowing sand in the sand biomes, snow in the snow biomes or above
 * `snowAbove`. Walking from grassland into desert fades rain into sand over
 * the same metres the ground changes, with no extra traffic.
 *
 * Everything it drives is cheap by construction: three player-parented
 * emitters (tagged `weather-rain` / `weather-sand` / `weather-snow`) whose
 * RATE it dials, and `ctx.setSky`'s weather layer — gloom, tint, wind and
 * cloud coverage — which are uniforms applied on top of whatever the
 * `day-night` script wrote, so the two scripts never need to know about each
 * other. It never adds a light and never touches the environment texture.
 */
class Weather extends Script {
  static override scriptName = "weather";
  static override params = {
    changeMinutes: { default: 6, min: 0.1, max: 120, description: "Real minutes between weather rolls (the authority's cadence)." },
    chance: { default: 0.5, min: 0, max: 1, description: "Probability a roll brings precipitation rather than clear sky." },
    force: { default: "auto", description: "auto | clear | light | storm — pin the world's weather (authoring/testing); auto rolls it." },
    rainBiomes: { default: "grassland,forest,jungle,beach,swamp,fen,moor,savanna,foothills,highland,taiga", description: "Biome ids where precipitation falls as rain." },
    sandBiomes: { default: "desert,badlands", description: "Biome ids where a storm is blowing sand." },
    snowBiomes: { default: "tundra,alpine,montane,mountains", description: "Biome ids where precipitation is snow." },
    snowAbove: { default: 220, min: -1000, max: 5000, description: "World Y above which precipitation is snow in any biome." },
    fadeSeconds: { default: 12, min: 0.5, max: 120, description: "How long a change takes to fade in or out, locally." },
    rainRate: { default: 1600, min: 0, max: 5000, description: "Rain emitter spawn rate per second at full precipitation." },
    snowRate: { default: 250, min: 0, max: 5000, description: "Snow emitter spawn rate per second at full precipitation." },
    sandRate: { default: 900, min: 0, max: 5000, description: "Sand emitter spawn rate per second at full precipitation." },
    splashRate: { default: 700, min: 0, max: 5000, description: "Ground-splash emitter (tag weather-splash) spawn rate per second at full rain." },
    fogBoost: { default: 3, min: 0, max: 30, description: "Fog density multiplier at full storm, on top of the authored density." },
    gloomMax: { default: 0.6, min: 0, max: 1, description: "How much a full storm dims sun, fill, ambient and IBL." },
    windMax: { default: 3, min: 0, max: 10, description: "Foliage wind multiplier at full storm (1 = authored)." },
    syncSeconds: { default: 5, min: 1, max: 60, description: "Multiplayer: how often the authority publishes the state." },
  };
  private state: WeatherState = { precipitation: 0, storm: 0, until: 0 };
  private clock = 0;
  private sinceSync = 0;
  private sampleTimer = 0;
  private base: LiveSkyBase | null = null;
  private emitters: Record<WeatherKind, string | null> = { rain: null, sand: null, snow: null };
  /** Splashes where the rain lands: an emitter at the player's feet, tagged `weather-splash`. */
  private splash: string | null = null;
  /** Per-kind intensity targets from the biome blend, and the eased values the effects follow. */
  private target: Record<WeatherKind, number> = { rain: 0, sand: 0, snow: 0 };
  private local: Record<WeatherKind, number> = { rain: 0, sand: 0, snow: 0 };
  private localStorm = 0;
  private unsubscribe: (() => void) | null = null;

  override onStart(): void {
    for (const kind of KINDS) this.emitters[kind] = this.ctx.findByTag(`weather-${kind}`)[0] ?? null;
    this.splash = this.ctx.findByTag("weather-splash")[0] ?? null;
    this.base = this.ctx.getSky?.() ?? null;
    const net = this.ctx.netState;
    if (net && !net.isAuthority()) {
      const published = net.get(NET_WEATHER_KEY) as WeatherState | undefined;
      if (published && typeof published.precipitation === "number") this.state = published;
      this.unsubscribe = net.onChange((key, value) => {
        if (key === NET_WEATHER_KEY && value && typeof (value as WeatherState).precipitation === "number") this.state = value as WeatherState;
      });
    } else {
      this.roll();
      net?.set(NET_WEATHER_KEY, this.state);
    }
    this.sample();
  }

  override onDispose(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    for (const kind of KINDS) {
      const id = this.emitters[kind];
      if (id) this.ctx.setParticles?.(id, { emitting: false, rate: 0 });
    }
    if (this.splash) this.ctx.setParticles?.(this.splash, { restart: true });
  }

  override onFixedUpdate(dt: number): void {
    const net = this.ctx.netState;
    const authority = !net || net.isAuthority();
    if (authority) {
      this.clock += dt;
      if (this.clock >= this.state.until) {
        this.roll();
        net?.set(NET_WEATHER_KEY, this.state);
        this.sinceSync = 0;
      } else if (net) {
        this.sinceSync += dt;
        if (this.sinceSync >= this.param<number>("syncSeconds")) {
          this.sinceSync = 0;
          net.set(NET_WEATHER_KEY, this.state);
        }
      }
    }
    this.sampleTimer -= dt;
    if (this.sampleTimer <= 0) {
      this.sampleTimer = 1;
      this.sample();
    }
    // ease toward the targets: a change is a front rolling in, not a switch
    const k = Math.min(1, dt / Math.max(0.5, this.param<number>("fadeSeconds")));
    for (const kind of KINDS) this.local[kind] += (this.target[kind] - this.local[kind]) * k;
    this.localStorm += (this.state.storm * this.state.precipitation - this.localStorm) * k;
    this.apply();
  }

  /** The authority's dice: what the world's weather is for the next while. */
  private roll(): void {
    const force = String(this.param<string>("force") ?? "auto").toLowerCase();
    const minutes = Math.max(0.1, this.param<number>("changeMinutes"));
    let precipitation = 0;
    let storm = 0;
    if (force === "clear") {
      precipitation = 0;
    } else if (force === "light") {
      precipitation = 0.5;
      storm = 0.1;
    } else if (force === "storm") {
      precipitation = 1;
      storm = 0.8;
    } else if (Math.random() < this.param<number>("chance")) {
      precipitation = 0.4 + 0.6 * Math.random();
      const r = Math.random();
      storm = r * r;
    }
    this.state = { precipitation, storm, until: this.clock + minutes * 60 * (0.6 + 0.8 * Math.random()) };
  }

  /** Where am I: the biome blend under the local player, turned into per-kind targets. */
  private sample(): void {
    const playerId = this.ctx.localPlayer?.() ?? this.ctx.findByTag("player")[0];
    const object = playerId ? this.ctx.getObject(playerId) : null;
    const at: BiomeAt | null = object && this.ctx.biomeAt ? this.ctx.biomeAt(object.position.x, object.position.z) : null;
    const p = this.state.precipitation;
    if (!at) {
      // no world under us: precipitation falls as rain, whatever it is
      this.target = { rain: p, sand: 0, snow: 0 };
      return;
    }
    const rainSet = splitList(this.param<string>("rainBiomes"));
    const sandSet = splitList(this.param<string>("sandBiomes"));
    const snowSet = splitList(this.param<string>("snowBiomes"));
    let rain = 0;
    let sand = 0;
    let snow = 0;
    let total = 0;
    for (const [id, w] of Object.entries(at.weights)) {
      const key = id.toLowerCase();
      if (sandSet.has(key)) sand += w;
      else if (snowSet.has(key)) snow += w;
      else if (rainSet.has(key)) rain += w;
      else continue;
      total += w;
    }
    if (total > 0) {
      rain /= total;
      sand /= total;
      snow /= total;
    }
    // altitude wins over biome: cold enough up there for any rain to be snow
    const snowLine = this.param<number>("snowAbove");
    const aloft = Math.min(1, Math.max(0, (at.ground - snowLine) / 40));
    snow += rain * aloft;
    rain *= 1 - aloft;
    this.target = { rain: p * rain, sand: p * sand, snow: p * snow };
  }

  private apply(): void {
    const setParticles = this.ctx.setParticles;
    const rates: Record<WeatherKind, number> = {
      rain: this.param<number>("rainRate"),
      sand: this.param<number>("sandRate"),
      snow: this.param<number>("snowRate"),
    };
    if (setParticles) {
      for (const kind of KINDS) {
        const id = this.emitters[kind];
        if (!id) continue;
        const intensity = this.local[kind];
        setParticles(id, { emitting: intensity > 0.02, rate: rates[kind] * intensity });
      }
      if (this.splash) {
        const rain = this.local.rain;
        setParticles(this.splash, { emitting: rain > 0.02, rate: this.param<number>("splashRate") * rain });
      }
    }
    const setSky = this.ctx.setSky;
    if (!setSky) return;
    const cover = Math.max(this.local.rain, this.local.sand, this.local.snow);
    let dominant: WeatherKind = "rain";
    for (const kind of KINDS) if (this.local[kind] > this.local[dominant]) dominant = kind;
    const tint = TINTS[dominant];
    const base = this.base;
    const baseCoverage = base?.clouds?.coverage ?? 0.3;
    const baseSoftness = base?.clouds?.softness ?? 0.35;
    const baseDensity = base?.fog?.density ?? 0.002;
    // sand is not cloud: a sandstorm is fog and wind with an ordinary sky above it
    const cloudDrive = Math.max(this.local.rain, this.local.snow);
    setSky({
      clouds: {
        coverage: baseCoverage + (0.95 - baseCoverage) * cloudDrive,
        softness: baseSoftness + (0.65 - baseSoftness) * cloudDrive,
      },
      fog: { density: baseDensity * (1 + this.param<number>("fogBoost") * cover * (0.4 + 0.6 * this.localStorm + (dominant === "sand" ? 0.6 : 0))) },
      weather: {
        gloom: this.param<number>("gloomMax") * cover,
        tint: tint.color,
        tintAmount: tint.amount * cover,
        wind: 1 + this.param<number>("windMax") * this.localStorm,
      },
    });
  }
}

export function registerBuiltinScripts(registry: ScriptRegistry): void {
  registry.register(DayNight);
  registry.register(Weather);
  registry.register(Spinner);
  registry.register(Oscillator);
  registry.register(PlayerController);
  registry.register(Collectible);
  registry.register(PlatformMover);
  registry.register(Door);
  registry.register(FaceTarget);
  registry.register(Tweener);
  registry.register(Damageable);
  registry.register(ThirdPersonController);
  registry.register(BoneSocket);
}

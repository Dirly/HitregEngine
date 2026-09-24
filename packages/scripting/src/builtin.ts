import type * as THREE from "three";
import type { EventRegistry } from "@hitreg/core";
import {
  Script,
  type BiomeAt,
  type WaterAt,
  type LiveSkyBase,
  type ScriptClass,
  type ScriptCommandDecl,
  type SimLike,
} from "./script.js";
import type { DataTypeSink, ScriptRegistry } from "./registry.js";
import { CharacterSheetScript } from "./character-sheet.js";
import { CharacterUi } from "./character-ui.js";
import { EquipmentLook } from "./equipment-look.js";
import { WeaponStance } from "./weapon-stance.js";
import { MobBrain } from "./mob-brain.js";
import {
  damp,
  fitAction,
  gaitFor,
  gaitSpeed as speedForGait,
  GaitTracker,
  groundFollowVy,
  risingByGround,
  leavingGround,
  playbackRate,
  swimAim,
  swimStateFor,
  swimVy,
  swimming,
  type ActionFit,
  type Gait,
  type GaitTuning,
  type SwimState,
  type SwimTuning,
} from "./locomotion.js";
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
      const me = this.ctx.localPlayer?.();
      if (me == null || me === this.entityId) this.ctx.recenterView?.(); // see the full controller
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
 * movement), stance (weapon stances in force, most specific first: every clip
 * played — gait and action — becomes `<Stance>_<clip>` where the model has one;
 * see dress()), holdingWeapon (swaps to the *_Hold clips), actionClip/actionUntil
 * (a one-shot clip that takes over until the given time — on an upper-body
 * LAYER while the character is moving, so a cast or a swing does not stop the
 * legs, and full-body when standing still or when actionFullBody is set;
 * actionHold marks it a HELD pose — a raised guard — looped at its authored
 * pace instead of fitted to the window; actionUpperBody keeps it on the arms
 * even standing still, so the legs walk whenever the body does),
 * impulseVel/impulseUntil (an external horizontal drive — dash, knockback —
 * that input cannot cancel while it lasts), liftUntil (a deadline until which
 * a script that LAUNCHED the body — a jump pad, an updraft, a vertical
 * knockback — owns its vertical velocity, so the step-pop guard leaves the
 * launch alone), faceYaw/faceUntil (an external
 * FACING — an AI swinging at a target it has stopped to fight, a cutscene —
 * a separate channel because the controller otherwise only turns a body that
 * is moving).
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
/** How far below the body's origin the ground ray looks. */
const PROBE_REACH = 4;
/** Slack on the measured resting distance before the feet count as off it. */
const PROBE_SLACK = 0.3;
/** Rate the slope lean chases the ground normal (1/s). */
const LEAN_DAMP = 10;
/**
 * Metres a body may move in ONE tick and still have travelled there. Past it
 * — on top of a generous allowance for its own speed — it was PUT there: fast
 * travel, a respawn, a transfer. A sprint covers 0.16 m in a 60 Hz tick and a
 * hard knockback under half a metre, so this is far above anything honest and
 * far below the smallest teleport worth the name.
 */
const TELEPORT_JUMP = 3;

function clampAbs(value: number, limit: number): number {
  return Math.max(-limit, Math.min(limit, value));
}

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
    jumpClip: {
      default: "Jump_Start",
      description:
        "optional — the push-off, played once as the character leaves the ground before the air " +
        "clip loops. A jump that opens on its airborne pose has no weight to it.",
    },
    landClip: {
      default: "Jump_Land",
      description:
        "optional — the touchdown, played once after a real drop (see landDrop). Skipped at speed: " +
        "a character landing mid-run should flow back into the run, not stop to absorb it.",
    },
    landDrop: {
      default: 0.35,
      min: 0,
      max: 3,
      description:
        "Seconds airborne before a landing is worth animating. Below it the character simply " +
        "carries on — hopping over a rock is not an event.",
    },
    turnLeftClip: {
      default: "Turn_L",
      description:
        "optional — turning on the spot, left. In camera-facing mode the character pivots whenever " +
        "the camera does, and an idle clip played through that pivot is a statue on a turntable.",
    },
    turnRightClip: { default: "Turn_R", description: "optional — turning on the spot, right" },
    turnClipSpeed: {
      default: 1.2,
      min: 0.1,
      max: 10,
      description: "Radians per second of pivot before the turn-in-place clips take over from idle.",
    },
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
        "Downward speed that counts as FALLING rather than settling onto the ground, BEFORE the " +
        "slope allowance below. Too low and a character walking down a slope plays the falling clip; " +
        "too high and a real drop reads as grounded until it is well underway.",
    },
    slopeTolerance: {
      default: 0.8,
      min: 0,
      max: 3,
      description:
        "Steepest descent still counted as following the ground, as a ratio of forward speed " +
        "(0.8 ≈ 39°, about as steep as a body walks). The fall threshold grows with how fast the body is travelling, because a slope " +
        "can only take you down as fast as you are going along it: without this a character running " +
        "downhill trips the falling clip and glides in a jump pose, which is the most common " +
        "\"animation is broken on slopes\" report there is.",
    },
    groundProbe: {
      default: 0.05,
      min: 0,
      max: 1,
      description:
        "Seconds between downward ground rays. The ray settles both questions velocity only " +
        "guesses at — whether the feet are on something, and which way that something faces — so " +
        "it is what makes slopes read correctly. 0 turns it off and falls back to the velocity " +
        "heuristic alone (one query per character per interval, so raise it for a crowd).",
    },
    groundStick: {
      default: 0.5,
      min: 0,
      max: 2,
      description:
        "Metres of gap the body will close to stay ON the ground it is running over (needs " +
        "groundProbe; 0 turns it off). A body driven by velocity alone leaves the surface at every " +
        "convex break — the crest of a hill throws it into a ballistic arc for a third of a second, " +
        "and on rolling terrain that is a character permanently half-airborne. Inside this gap it " +
        "follows the surface instead, which is what every character controller does and what stops " +
        "a run downhill reading as a glide. A real drop is unaffected: past the gap, gravity has it.",
    },
    stepPopCap: {
      default: 2,
      min: 0,
      max: 20,
      description:
        "Upward speed, m/s, above which a rise the controller did not ask for is treated as a COLLISION POP " +
        "and replaced by ordinary ground-following (needs groundProbe and groundStick; 0 turns it off). A " +
        "capsule run at a low lip — a door threshold, a kerb, the first stair — is thrown upward by the " +
        "contact: measured, an 18 cm threshold at a 6.5 m/s run is a 0.78 m hop through every doorway, head " +
        "at the lintel. Jumps are exempt. A script that launches the body on purpose (jump pad, updraft, " +
        "vertical knockback) sets userData.liftUntil to a deadline in seconds and is left alone until then.",
    },
    slopeAlign: {
      default: 0.5,
      min: 0,
      max: 1,
      description:
        "How much of the ground's tilt the body takes on, 0..1 (needs groundProbe). A character " +
        "standing bolt upright on a hillside is the other half of what reads as wrong on slopes; " +
        "full alignment reads as a toy on a ramp, so the default leans part of the way.",
    },
    slopeAlignMax: {
      default: 25,
      min: 0,
      max: 60,
      description: "Ceiling on the slope lean, in degrees, however steep the ground is.",
    },
    gaitDwell: {
      default: 0.18,
      min: 0,
      max: 1,
      description:
        "Seconds a gait holds before it may change BACK. Speeding up is instant; reversing is not, " +
        "which is what stops a character hovering near a threshold from crossfading several times a " +
        "second. Works with the hysteresis band the thresholds already carry.",
    },
    fitActionClip: {
      default: true,
      description:
        "Stretch or compress a one-shot action clip (userData.actionClip) to the window its owner " +
        "asked for, instead of looping it. A three-second cast then plays as one slow cast rather " +
        "than the same second three times. Windows too long for even the slowest playback still " +
        "loop — and so do clips whose length nobody can report (a model still loading).",
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
    footsteps: { default: false, description: "Emit gait-synchronised local movement sounds. The controller measures distance travelled, so steps stay in sync when speed changes." },
    footstepSounds: { default: {}, description: "Surface-to-sound map. Keys: grass, sand, dirt, wood, stone, water, snow, metal, rubble. Each value may be a comma-separated variant list." },
    footstepCadence: { default: 3.1, min: 1, max: 8, description: "Target foot contacts per second while moving. Distance per contact grows with speed, keeping a run from becoming a sped-up walk sound." },
    footstepVolume: { default: 0.14, min: 0, max: 1, description: "Maximum local footstep volume. Kept quiet because these are close foley, not music." },
    jumpSound: { default: "", description: "Optional takeoff sound asset id." },
    landSound: { default: "", description: "Optional landing sound asset id; uses the current surface when footstepSounds has a matching key." },
    swimSound: { default: "", description: "Optional swim-stroke and water-entry sound asset id." },
    swim: {
      default: true,
      description:
        "Swim in water deep enough to float in (see swimEnterDepth). Needs a host that answers " +
        "`ctx.waterAt` — a scene with a procedural world, or authored water carrying the `water` " +
        "component. Off, the character walks along the bottom like it always did.",
    },
    swimSpeed: {
      default: 3.2,
      min: 0,
      max: 20,
      description: "Stroke speed. Swimming is slower than running in every game that has both, and much slower in the ones that mean it.",
    },
    swimEnterDepth: {
      default: 1.5,
      min: 0.2,
      max: 5,
      description:
        "Water over the FEET at which the character stops walking and starts swimming — SHOULDER deep on a " +
        "1.8 m body, which is about where a person actually gives up and swims. Lower it and you swim in " +
        "water you can obviously stand in: measured on this engine's own world, a typical river is 1.7-3.3 m " +
        "deep, so a chest-high threshold has you swimming down the middle of one with the bed at your knees " +
        "and nowhere to dive to.",
    },
    swimExitDepth: {
      default: 1.25,
      min: 0.1,
      max: 5,
      description:
        "Water depth at which a swimmer's feet find the bottom again — measured to the BED, not to the " +
        "floating body's feet. Keep it below swimEnterDepth: the gap is what stops a body at the waterline " +
        "flipping between the two modes several times a second.",
    },
    swimFloatDepth: {
      default: 0.1,
      min: 0,
      max: 5,
      description:
        "How deep a floating body rides — water over the FEET at rest. This belongs to the CLIPS: an " +
        "animation library authors its swim cycles with the waterline at the model's root (measured on this " +
        "engine's: the crawl's chest at 0.00 and head at 0.12 above the root, the tread's hip at -0.31), so " +
        "they want a hand's depth. A model with NO swim clips swims on its run cycle, which is posed standing " +
        "on the ground: give it about 1.15 — chest deep — or it floats out of the water to the waist.",
    },
    buoyancy: {
      default: 3.5,
      min: 0,
      max: 20,
      description:
        "How hard the water pushes a body back to its float line, per metre off it. Low is a heavy swimmer " +
        "that sinks when it stops; high pops to the surface like a cork.",
    },
    swimClimbSpeed: {
      default: 2.6,
      min: 0,
      max: 20,
      description: "Fastest deliberate dive or rise, m/s (the jump and dive keys while swimming).",
    },
    swimMaxPitch: {
      default: 60,
      min: 0,
      max: 90,
      description:
        "Steepest the body tips while swimming, degrees. The pose follows where the swimmer is going, so " +
        "this is the limit on both the dive and the climb; past about 60 a character reads as a torpedo " +
        "rather than as a person. 0 keeps the body flat and swims it down anyway.",
    },
    swimDownKey: {
      default: "ControlLeft,KeyC,KeyX",
      description:
        "Hold to dive while swimming; the jump key rises. A comma-separated LIST — Ctrl is spoken for on a " +
        "lot of setups (and some browsers eat it), so a second and third key cost nothing. Blank disables diving.",
    },
    wadeSpeedMult: {
      default: 0.35,
      min: 0.1,
      max: 1,
      description:
        "Fraction of the gait speed kept in the DEEPEST wade, just short of swimming. Shallower water takes " +
        "proportionally less: ankle-deep is barely slower than dry land, and the drag comes on as the water " +
        "climbs. A single step-change at the water's edge is what makes wading read as a trigger rather than " +
        "as water.",
    },
    wadeBand: {
      default: 0.35,
      min: 0.05,
      max: 2,
      description:
        "Metres either side of wadeDeepDepth over which the wade cycle mixes into the walk. Wider is a " +
        "longer, softer hand-over as the bottom shelves away; narrow reads as a line the character crosses.",
    },
    wadeClip: {
      default: "Crouch_Fwd",
      description:
        "optional — moving through water deeper than wadeDeepDepth. A crouched walk is the closest thing a " +
        "general library has to a wade: low stance, short stride, arms clear. Falls back to the walk cycle.",
    },
    wadeIdleClip: { default: "Crouch_Idle", description: "optional — standing in deep water; falls back to the idle clip" },
    wadeDeepDepth: {
      default: 0.8,
      min: 0,
      max: 5,
      description:
        "Water over the feet at which the walk gives way to the wade clips — thigh-deep, where a person stops " +
        "walking normally. Below it the ordinary gait plays (just slower), so the edge of the water is a walk " +
        "and the middle of the ford is a wade.",
    },
    swimClip: { default: "Swim", description: "optional — the stroke; falls back to the run cycle, pitched flat by swimPitch" },
    swimIdleClip: { default: "Tread_Water", description: "optional — treading water; falls back to the idle clip" },
    swimPitch: {
      default: 70,
      min: -90,
      max: 90,
      description:
        "Degrees the body tips face-down while stroking — applied ONLY where the run cycle is standing in " +
        "for a missing swim clip. A run played flat on its face at a slow rate reads as a crawl stroke, " +
        "while the same clip upright reads as a character marching along the lake bed. A real swim clip is " +
        "authored prone already, and tipping that too would swim the character nose-first into the bed. " +
        "Negative if the model faces backwards.",
    },
    modelYaw: { default: 0, min: -3.1416, max: 3.1416, description: "extra yaw if the model faces backwards" },
    turnSpeed: { default: 14, min: 1, max: 40, description: "how snappily the character turns" },
    face: { default: "camera", description: "camera = always face the aim (strafe shooter); movement = face where you run" },
    stanceGaits: {
      default: "combat",
      description:
        "When a weapon stance also changes how the character STANDS AND MOVES (idle, walk, run, turns). " +
        "Its actions — attacks, guard, hits, death — are always the stance's. combat = only while " +
        "userData.combatUntil (seconds, ctx.now) is in the future, so a character walks and idles normally " +
        "and takes the guarded stance around a fight; always = whenever the weapon is held; never = never.",
    },
    actionBlend: {
      default: "auto",
      description:
        "How a one-shot action clip (userData.actionClip — a cast, a swing) sits on the body. " +
        "layer = always on an upper-body layer over the gait, so the legs keep running; full = " +
        "always the whole body, the pre-layer behaviour; auto = layered when the character is " +
        "actually moving, full-body when it is standing still (a stationary swing then keeps its " +
        "weight shift). Decided once per action. A caster can force one action full-body with " +
        "userData.actionFullBody — a dodge roll is not an upper-body affair.",
    },
  };

  private yaw = 0;
  private airTime = 0;
  /** How long the last stretch off the ground lasted (the landing reads it). */
  private airFor = 0;
  private lastJump = -999;
  private autoRun = false;
  private autoRunHeld = false;
  private lastClip = "";
  private lastRate = 1;
  private clips: Set<string> | null = null;
  /** The action clip currently owning (part of) the body, and how. */
  private action: string | null = null;
  private actionLayered = false;
  /** How the running action was fitted to its window (rate, and whether it loops). */
  private actionFit: ActionFit = { rate: 1, loop: true };
  /** Gait tier currently playing, with its dwell state — see gaitDwell. */
  private readonly gait = new GaitTracker();
  /** Deadlines for the two one-shots that bracket a jump. */
  private jumpUntil = 0;
  private landUntil = 0;
  private wasAirborne = false;
  /** Turning on the spot: which way, and the yaw it was measured from. */
  private turning: "left" | "right" | null = null;
  private lastYaw = 0;
  /** Ground ray: when it last ran, what it found, and the resting distance. */
  private probeAt = -999;
  private groundNormal: [number, number, number] | null = null;
  private groundDist = Infinity;
  private groundRest: number | null = null;
  /** The vertical velocity ground-following wrote last tick, if it did. */
  private stickVy: number | null = null;
  /** Slope lean, smoothed — the ray is a step function and the body is not. */
  private pitch = 0;
  private roll = 0;
  private scratch: THREE.Vector3 | null = null;
  /** Scratch for the world scale (see restFromCollider) and for the teleport watch. */
  private scale: THREE.Vector3 | null = null;
  private here: THREE.Vector3 | null = null;
  /** Where the body was last tick — see teleported(). */
  private lastAt: THREE.Vector3 | null = null;
  /** Water: the state this body is in, and how deep its feet are standing. */
  private swimState: SwimState = "dry";
  private swimDepth = 0;
  /** Origin-to-feet, read off the collider once (see footDrop). */
  private foot: number | null = null;
  /** Swimming last tick — see the hand-off that stops a swimmer hopping out. */
  private wasSwimming = false;
  /** This tick's swim aim: the body's pitch, and the vertical speed it asked for. */
  private swimPitchNow = 0;
  private swimVertical = 0;
  /** Distance paid toward the next foot contact or swim stroke. */
  private footstepDistance = 0;

  private play(clip: string, fade: number, loop = true, restart = false): void {
    if (this.lastClip === clip && !restart) return;
    this.lastClip = clip;
    this.ctx.setAnimation?.(clip, fade, { loop, ...(restart ? { restart: true } : {}) });
  }

  /**
   * First clip of `names` the model actually has. When the host doesn't
   * publish a clip list we can't tell absent from present, so the first name
   * wins — exactly the behaviour before this list existed.
   */
  /**
   * The clip to actually play for `base`, dressed for what the character is
   * holding. `userData.stance` names the weapon stances in force, most
   * specific first (`["SwordShield", "Sword"]`): the first `<Stance>_<base>`
   * the model HAS wins — `GreatSword_Run`, `SwordShield_Attack1`,
   * `Staff_Death` — and a stance with no clip for this moment falls through
   * to the plain one. Locomotion and actions alike, so a script that asks for
   * "Attack1" or "Death" gets the version for the weapon in hand without
   * knowing which it is. `holdingWeapon` and its `<base>_Hold` clips are the
   * older, single-stance form of the same thing. A GAIT (`gait`) is dressed
   * only as `stanceGaits` allows — by default only in combat.
   */
  private dress(base: string, gait = false): string {
    const ud = this.object.userData as { stance?: string | string[]; holdingWeapon?: boolean; combatUntil?: number };
    let stances = typeof ud.stance === "string" ? [ud.stance] : (ud.stance ?? []);
    if (gait) {
      // How a character stands and walks is not how it fights: out of combat
      // the plain gait, with the weapon simply carried (see stanceGaits).
      const mode = this.param<string>("stanceGaits");
      const fighting = (ud.combatUntil ?? 0) > this.ctx.now() / 1000;
      if (mode === "never" || (mode !== "always" && !fighting)) stances = [];
    }
    for (const s of stances) {
      const name = `${s}_${base}`;
      if (this.hasClip(name)) return name;
    }
    return ud.holdingWeapon === true ? this.pick(`${base}_Hold`, base) : base;
  }

  /** Whether the model has `name` — false while the clip list is still unknown. */
  private hasClip(name: string): boolean {
    if (!this.ctx.animationClips) return false;
    this.pick(name); // loads the clip set once the model answers
    return this.clips?.has(name) ?? false;
  }

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
  private setRate(moving: number, clip: string, tuned: number): void {
    if (!this.param<boolean>("syncClipSpeed")) {
      this.setRateRaw(1);
      return;
    }
    const declared = (this.param<Record<string, number>>("clipSpeeds") ?? {})[clip];
    const authored = declared && declared > 0 ? declared : tuned;
    this.setRateRaw(playbackRate(moving, authored));
  }

  /** Push a playback rate through, unclamped — callers clamp for their case. */
  private setRateRaw(rate: number): void {
    if (Math.abs(rate - this.lastRate) < 0.02) return;
    this.lastRate = rate;
    this.ctx.setAnimationSpeed?.(rate);
  }

  override onStart(): void {
    this.yaw = this.object.rotation.y;
    this.airTime = 0;
    this.airFor = 0;
    this.autoRun = false;
    this.clips = null; // the model may still be loading; resolve on first use
    this.action = null;
    this.actionLayered = false;
    this.actionFit = { rate: 1, loop: true };
    this.gait.reset();
    // the body may have been moved (a respawn, a transfer): measure the ground
    // again rather than trusting a resting distance from wherever it was
    this.probeAt = -999;
    this.groundNormal = null;
    this.groundDist = Infinity;
    this.groundRest = null;
    this.stickVy = null;
    this.lastAt = null; // the teleport watch starts from wherever the body is now
    this.pitch = 0;
    this.roll = 0;
    this.swimState = "dry";
    this.swimDepth = 0;
    this.foot = null; // the body may have been rebuilt with a different collider
    this.wasSwimming = false;
    this.swimPitchNow = 0;
    this.swimVertical = 0;
    this.footstepDistance = 0;
    this.jumpUntil = 0;
    this.landUntil = 0;
    this.wasAirborne = false;
    this.turning = null;
    this.lastYaw = this.yaw;
    this.ctx.clearAnimationLayer?.(0);
    this.play(this.param<string>("idleClip"), 0.2);
  }

  override onDispose(): void {
    // the model outlives the script (a rebuild, a respawn); a layer left up
    // would hold a cast pose on its arms forever
    if (this.actionLayered) this.ctx.clearAnimationLayer?.(0);
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
      actionFullBody?: boolean;
      actionHold?: boolean;
      actionUpperBody?: boolean;
      impulseVel?: [number, number];
      impulseUntil?: number;
      liftUntil?: number;
      faceYaw?: number;
      faceUntil?: number;
      swimming?: SwimState;
      waterDepth?: number;
      /** The velocity a swimming body is asking for — what this tab sends its authority. */
      swimVelocity?: [number, number, number];
    };
    // Watched before the freeze, because a body is usually frozen exactly
    // while it is being moved (a death and its respawn are one pair).
    if (this.teleported(Math.hypot(vel[0], vel[1], vel[2]), dt)) this.forgetGround();
    if (ud.frozen) {
      sim.setLinvel(this.entityId, [0, vel[1], 0]);
      // A death or emote clip still plays through a freeze. Freezing stops the
      // legs; it does not cancel an animation somebody asked for — and a
      // script that sets actionClip and frozen together (dying is the usual
      // pair) otherwise watches its death clip get replaced by idle.
      const frozenNow = this.ctx.now() / 1000;
      const held = ud.actionClip && (ud.actionUntil ?? 0) > frozenNow ? this.dress(ud.actionClip) : null;
      if (this.actionLayered) {
        this.ctx.clearAnimationLayer?.(0.15); // no gait left for it to sit on
        this.actionLayered = false;
      }
      const starting = held !== this.action;
      this.action = held;
      if (held && starting) {
        // fitted like any other action — a death clip that reaches its end and
        // starts again is the single most obvious animation bug there is
        this.actionFit =
          this.param<boolean>("fitActionClip") && ud.actionHold !== true
            ? fitAction(this.clipLength(held), (ud.actionUntil ?? frozenNow) - frozenNow)
            : { rate: 1, loop: true };
      }
      this.setRateRaw(held ? this.actionFit.rate : 1);
      this.play(held ?? this.param<string>("idleClip"), 0.25, !held || this.actionFit.loop, starting && held !== null);
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
    // moving off brings a parked free-look camera back behind the character —
    // only for this tab's own body, never a peer's the host is simulating
    if (len > 0) {
      const me = this.ctx.localPlayer?.();
      if (me == null || me === this.entityId) this.ctx.recenterView?.();
    }

    // Water before speed: how deep the feet are decides which locomotion this
    // tick is, and a wade is a different speed from a run through air.
    const water = this.sampleWater();
    const swimTuning = this.swimTuning();
    this.swimDepth = water ? water.depth : -Infinity;
    this.swimState = water && water.swim && this.param<boolean>("swim")
      ? swimStateFor(water.depth, water.surfaceY - water.floorY, this.swimState, swimTuning)
      : "dry";
    const isSwimming = this.swimState === "swimming";
    // The tick a swimmer stops swimming — it rose out, or found the bottom —
    // any upward velocity it still carries becomes a hop out of the water once
    // gravity is back in charge of it. Dropped from the reading everything
    // below works off, so the hand-off is a body at the surface, not one
    // leaving it.
    if (this.wasSwimming && !isSwimming && vel[1] > 0) vel[1] = 0;
    if (!this.wasSwimming && isSwimming) this.movementSound(this.param<string>("swimSound"), 3, 0.85);
    this.wasSwimming = isSwimming;
    // published for anything else that cares — a breath meter, a splash
    // emitter, an AI that will not follow you into the lake
    ud.swimming = this.swimState === "dry" ? undefined : this.swimState;
    ud.waterDepth = water ? water.depth : undefined;
    if (!isSwimming) ud.swimVelocity = undefined;

    const runSpeed = this.param<number>("speed");
    const walkSpeed = this.param<number>("walkSpeed");
    const sprintSpeed = this.param<number>("sprintSpeed");
    const sprinting = input.isDown(this.param<string>("sprintKey"));
    const walking = input.isDown(this.param<string>("walkKey"));
    const gaitSpeed = isSwimming
      ? this.param<number>("swimSpeed")
      : (sprinting ? sprintSpeed : walking ? walkSpeed : runSpeed) * this.wadeDrag(swimTuning);

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
    // A slope is the same bug wearing a hat: running downhill at 6 m/s the body
    // descends several metres a second with its feet planted the whole way, and
    // any fixed threshold low enough to catch a real drop is well below that.
    // So the allowance GROWS with travel speed (slopeTolerance), and where the
    // sim can answer properly a ground ray settles it outright — which is also
    // where the surface normal comes from, so slopes are one problem and not
    // two. Everything still runs through the same SUSTAINED-evidence counter,
    // whose window doubles as the coyote grace on a jump.
    const now = this.ctx.now() / 1000;
    const planar = Math.hypot(vel[0], vel[2]);

    // Swimming replaces the whole vertical half of this tick — no gravity to
    // fight, no ground to follow, no jump, no coyote window — and nothing
    // else. It stays inside this controller rather than becoming its own
    // script because facing, the impulse channel, the action clips and the
    // freeze are all identical in water, and two controllers that have to
    // agree about all of that is exactly the trap `locomotion.ts` exists to
    // avoid.
    let grounded = false;
    let stroking = false;
    if (isSwimming) {
      // A swimmer goes where it LOOKS. The camera's full aim — pitch included
      // — turns forward/strafe into a direction in three dimensions, so
      // pointing at the bottom and holding forward swims you down, and the
      // body takes on the pitch of its own travel. That is how every
      // third-person game with swimming in it works, and it is the only way a
      // player ever finds out that diving is possible.
      const climbKeys =
        ((input.isDown("Space") ? 1 : 0) - (this.diveKeyDown(input) ? 1 : 0)) *
        this.param<number>("swimClimbSpeed");
      const view = this.ctx.viewDirection?.() ?? [fx, 0, fz];
      const aim = swimAim(
        view,
        forwardIn,
        strafeIn,
        speed,
        climbKeys,
        (this.param<number>("swimMaxPitch") * Math.PI) / 180,
      );
      // the current carries you: added AFTER the speed clamp, so a strong
      // river can push a swimmer faster than they can swim, which is the point
      x = (driven ? x : aim.velocity[0]) + water!.current[0];
      z = (driven ? z : aim.velocity[2]) + water!.current[1];
      this.swimPitchNow = aim.pitch;
      this.swimVertical = aim.vertical;
      // What this tab will send its authority, so the body the server moves
      // aims where this one is aiming instead of re-deriving it from a flat
      // camera direction it does not have.
      ud.swimVelocity = [aim.velocity[0], aim.vertical, aim.velocity[2]];
      // Decided here, once, and reused for the pose below: it sets which clip
      // plays, and a clip that disagrees with the body's own aim for a tick is
      // a swimmer that flickers every time it starts or stops.
      stroking = swimming(Math.hypot(x, z), aim.vertical, this.param<number>("swimSpeed")) === "stroke";
      vy = swimVy(water!.depth, aim.vertical, swimTuning);
      sim.setLinvel(this.entityId, [x, vy, z]);
      // A body that swims out of the water has not been in the air: leaving
      // these set plays the landing clip on the shore, and counts a swim
      // across a lake as one very long fall.
      this.airTime = 0;
      this.airFor = 0;
      this.wasAirborne = false;
      this.landUntil = 0;
      this.stickVy = null;
    } else {
      const probed = this.probeGround(sim, now, vy, planar);
      const leaving =
        probed !== null
          ? probed
          : leavingGround(vy, planar, this.param<number>("fallSpeed"), this.param<number>("slopeTolerance"));
      // airTime resets the moment the ground answers again, so the LAST length
      // of it is remembered separately: the landing needs to know how far the
      // character fell, and by then airTime is already zero.
      if (leaving) this.airTime += dt;
      else {
        this.airFor = this.airTime;
        this.airTime = 0;
      }
      const airborne =
        this.airTime > this.param<number>("coyoteTime") || now - this.lastJump < 0.25;
      grounded = !airborne;
      // Landing is an EDGE — the one tick where "was airborne" and "is
      // grounded" are both true — so it is read here, before any early return
      // can skip it.
      if (this.wasAirborne && grounded) {
        // The first contact after a fall belongs to the floor just as much as
        // an ordinary step: sand absorbs it, metal rings, rubble rattles.
        this.contactSound(4, 1);
        // Skipped at speed on purpose: a character landing mid-run flows back
        // into the run, and stopping to absorb the landing reads as a stumble.
        if (this.airFor >= this.param<number>("landDrop") && planar < this.param<number>("speed") * 0.6) {
          this.landUntil = now + (this.clipLength(this.param<string>("landClip")) ?? 0.3);
        }
      }
      this.wasAirborne = !grounded;
      if (input.isDown("Space") && grounded) {
        this.movementSound(this.param<string>("jumpSound"), 3, 0.75);
        vy = this.param<number>("jump");
        this.lastJump = now; // and no re-jump inside the coyote window
        // the push-off owns the body until it has played out, then the air clip
        // loops under it — a jump that opens on its airborne pose has no weight
        this.jumpUntil = now + (this.clipLength(this.param<string>("jumpClip")) ?? 0.35);
        this.landUntil = 0;
      }
      vy = this.followGround(x, vy, z, grounded && !((ud.liftUntil ?? 0) > now), now, dt);
      sim.setLinvel(this.entityId, [x, vy, z]);
    }

    this.updateFootsteps(planar, grounded, isSwimming, stroking, dt);

    const facingTarget = this.steerFacing(ud, x, z, faceCamera, backing, fx, fz, driven, len, now, dt);
    // sculling backwards plays the upright tread cycle, so it must not be laid
    // flat by the stand-in tilt either
    const swimBacking = isSwimming && this.travelHeading(x, z, facingTarget) === "back";
    // In the water the body's attitude comes from the water, not the ground —
    // but only where the RUN CYCLE is standing in for a swim clip. A real one
    // is authored prone, so tipping it as well swims the character head-first
    // into the bed.
    this.applyLean(
      grounded,
      dt,
      isSwimming ? this.swimPitchNow + (this.swimTilt(stroking && !swimBacking) * Math.PI) / 180 : null,
    );

    // A one-shot action — a cast, a swing — either owns the whole body or
    // rides on an upper-body LAYER over whatever gait is underneath, which is
    // what lets a character cast while running. Which of the two is decided
    // ONCE, when the action starts: re-deciding per tick would flip a cast
    // between layered and full-body every time the character crossed the
    // walking threshold mid-animation.
    const action = ud.actionClip && (ud.actionUntil ?? 0) > now ? this.dress(ud.actionClip) : null;
    if (action !== this.action) {
      const blend = this.param<string>("actionBlend");
      const layered =
        action !== null &&
        blend !== "full" &&
        ud.actionFullBody !== true &&
        this.ctx.setAnimationLayer !== undefined &&
        // In the water it is ALWAYS the arms. A cast pose is authored standing
        // on the ground, so a full-body one played on a swimmer is a character
        // standing to attention in the middle of a lake — and there is no
        // "standing still" in water to justify taking the whole body, which is
        // the reason the moving/standing split exists on land.
        (isSwimming ||
          blend === "layer" ||
          // a raised guard, say, is ARMS: you walk behind a shield, and a
          // full-body guard raised standing still would pin the legs in its
          // pose for as long as it is held — the character slides, not walks
          ud.actionUpperBody === true ||
          planar > Math.max(0.2, this.param<number>("walkSpeed") * 0.5));
      if (this.actionLayered && !layered) this.ctx.clearAnimationLayer?.(0.15);
      this.action = action;
      this.actionLayered = layered;
      // Fit the clip to the window the caller asked for. A cast that lasts
      // three seconds and a cast animation that lasts one are not a request to
      // play the animation three times — that repeat is what makes a long cast
      // read as a stuck loop rather than a long cast. Where the window is too
      // long for even the slowest playback to cover, it loops after all, and a
      // clip nobody can measure (model still loading, headless host) keeps the
      // old looping behaviour.
      // A HELD pose (a raised guard) has no window to fit: it loops at its
      // authored pace for as long as the caller keeps asserting it.
      this.actionFit =
        action && this.param<boolean>("fitActionClip") && ud.actionHold !== true
          ? fitAction(this.ctx.animationDuration?.(action) ?? null, (ud.actionUntil ?? now) - now)
          : { rate: 1, loop: true };
      if (action && layered) {
        this.ctx.setAnimationLayer?.(action, {
          fade: 0.08,
          loop: this.actionFit.loop,
          speed: this.actionFit.rate,
        });
      }
    }
    // Full-body: the action IS the pose, so nothing below runs. Layered: fall
    // through and pick a gait as usual — the legs are still ours.
    if (action && !this.actionLayered) {
      this.setRateRaw(this.actionFit.rate);
      // restart: the same clip twice in a row (a second cast of one spell) has
      // already been played to its clamped last frame, and a plain play() of
      // the clip already current is a no-op — the character would freeze
      // holding the pose from the previous cast.
      this.play(action, 0.05, this.actionFit.loop, true);
      return;
    }

    // A weapon stance (or a held-weapon pose) is a variant of whatever gait we
    // land on, so resolve the gait first and dress it second.
    const variant = (base: string): string => this.dress(base, true);

    const idle = this.param<string>("idleClip");
    const run = this.param<string>("runClip");
    const walk = this.pick(this.param<string>("walkClip"), run);
    const sprint = this.pick(this.param<string>("sprintClip"), run);

    // In the water none of the ground ladder below applies — no air clip (a
    // swimmer is not falling), no landing, no gait tiers.
    if (isSwimming) {
      this.playSwim(Math.hypot(x, z), vy, stroking, swimBacking, variant);
      return;
    }

    if (!grounded) {
      const air = this.pick(this.param<string>("airClip"), run);
      const start = this.pick(this.param<string>("jumpClip"), air);
      // a model without a push-off clip stays on its looping air clip; playing
      // that one as a one-shot would clamp it on its last frame forever
      const pushing = start !== air && now < this.jumpUntil;
      this.setRateRaw(1);
      this.play(variant(pushing ? start : air), 0.15, !pushing);
      return;
    }

    if (now < this.landUntil) {
      const land = this.pick(this.param<string>("landClip"), idle);
      if (land !== idle) {
        this.setRateRaw(1);
        this.play(variant(land), 0.08, false);
        return;
      }
      this.landUntil = 0;
    }

    // Gait comes from how fast we are ACTUALLY moving, not from the key held:
    // a slowed or AI-driven character then still reads correctly.
    //
    // Two different speeds, deliberately. WHICH clip comes from the horizontal
    // speed — the pace the character is travelling at, which is what the player
    // asked for and what a run reads as whatever the ground is doing. How fast
    // it PLAYS comes from the distance actually covered, vertical included: on
    // a hillside the feet travel further than the horizontal speed says, and
    // paying that out at the horizontal rate is skating. The vertical share is
    // capped against the horizontal so a body bouncing on the spot does not
    // read as sprinting.
    const tuning: GaitTuning = { walkSpeed, runSpeed, sprintSpeed };
    const gait = this.stepGait(planar, tuning, now);
    const moving = Math.hypot(planar, Math.min(Math.abs(vel[1]), planar * 1.2));

    // Wading is a BAND, not a line: the wade cycle is mixed into whatever the
    // body would otherwise be playing, in proportion to how deep the water is,
    // so a character walking down a beach takes the low stance on gradually
    // instead of ducking the moment its thighs are wet — which is what a
    // threshold looks like, and what was reported as "the crouch to walk looks
    // odd on the edges". The mix rides on TOP of the ordinary clip choice
    // below, directional clips included: wading sideways is still a strafe.
    const wadeMix = this.wadeMix();
    if (wadeMix > 0 && gait === "idle") {
      this.setRateRaw(1);
      this.blendPlay(variant(idle), variant(this.pick(this.param<string>("wadeIdleClip"), idle)), wadeMix, 0.3);
      this.turning = null;
      return;
    }

    if (gait === "idle") {
      this.setRateRaw(1);
      const turn = this.turnInPlace(dt);
      this.play(variant(turn ?? idle), 0.25);
      return;
    }
    this.turning = null;

    let clip = gait === "walk" ? walk : gait === "sprint" ? sprint : run;
    let nominal = speedForGait(gait, tuning);
    // a model without the clip falls back to the run cycle, which is authored
    // at the run's pace whatever tier asked for it
    if (clip === run) nominal = runSpeed;

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

    if (wadeMix > 0) {
      const wade = this.pick(this.param<string>("wadeClip"), walk);
      // paced by whichever half the body is mostly in — a mixed pair reads as
      // one gait only if the two are also running at one speed
      const leading = wadeMix >= 0.5;
      this.setRate(
        moving,
        leading ? wade : clip,
        leading ? (wade === walk ? walkSpeed : Math.max(0.3, walkSpeed * 0.5)) : nominal,
      );
      this.blendPlay(variant(clip), variant(wade), wadeMix, 0.3);
      return;
    }

    // paced by the clip actually SHOWN: a greatsword jog is not authored at
    // the pace of the unarmed run it stands in for
    const shown = variant(clip);
    this.setRate(moving, shown, nominal);
    this.play(shown, 0.15);
  }

  /**
   * Turn the visual toward where the body is going (body rotations are locked,
   * so the yaw is cosmetic) and return that heading in world terms.
   *
   * A claimed facing wins over movement. The controller only turns a body that
   * is MOVING, so an AI that stops to swing would keep facing where its target
   * used to be — and writing object.rotation.y from the outside does not work
   * either, because the yaw interpolated here is remembered across ticks and
   * would snap back the moment the body moved again. Hence a channel with a
   * deadline, exactly like impulseVel: a script that dies mid-swing releases
   * the head instead of freezing it.
   *
   * The returned heading is the RAW target, not the smoothed yaw: the clip is
   * chosen against it because reading a heading off a yaw that is still
   * catching up reports a strafe for the first few frames of every move.
   */
  private steerFacing(
    ud: { faceYaw?: number; faceUntil?: number },
    x: number,
    z: number,
    faceCamera: boolean,
    backing: boolean,
    fx: number,
    fz: number,
    driven: boolean,
    len: number,
    now: number,
    dt: number,
  ): number {
    const facingTarget = faceCamera || backing ? Math.atan2(fx, fz) : Math.atan2(x, z);
    const faced = typeof ud.faceYaw === "number" && (ud.faceUntil ?? 0) > now ? ud.faceYaw : null;
    if (faced !== null || faceCamera || backing || len > 0 || (driven && Math.hypot(x, z) > 0.05)) {
      const target = (faced ?? facingTarget) + this.param<number>("modelYaw");
      let diff = target - this.yaw;
      while (diff > Math.PI) diff -= Math.PI * 2;
      while (diff < -Math.PI) diff += Math.PI * 2;
      // Exponential, not a fraction of the frame: `turnSpeed * dt` turns at a
      // different rate on a 30 Hz sim than on a 60 Hz one and can overshoot
      // outright, and a turn that lands differently per machine is exactly the
      // kind of roughness nobody can reproduce.
      this.yaw = target - diff * Math.exp(-this.param<number>("turnSpeed") * dt);
    }
    return facingTarget;
  }

  /**
   * How much of the WADE cycle is mixed into the gait, 0..1, from how deep the
   * water is — ramped across a band centred on `wadeDeepDepth` rather than
   * switched at it. Zero on dry land and while swimming.
   */
  private wadeMix(): number {
    if (this.swimState !== "wading" || !(this.swimDepth > 0)) return 0;
    const mark = this.param<number>("wadeDeepDepth");
    const band = Math.max(0.05, this.param<number>("wadeBand"));
    const t = Math.max(0, Math.min(1, (this.swimDepth - (mark - band)) / (band * 2)));
    return t * t * (3 - 2 * t); // smoothstep: no corner at either end of the band
  }

  /** Two clips held at a weight, or the dominant one where the host cannot. */
  private blendPlay(from: string, to: string, weight: number, fade: number): void {
    if (this.ctx.setAnimationBlend && from !== to) {
      this.lastClip = weight >= 0.5 ? to : from; // keep play()'s idempotence honest
      this.ctx.setAnimationBlend(from, to, weight, fade);
      return;
    }
    this.play(weight >= 0.5 ? to : from, fade);
  }

  /**
   * How much of its gait a body keeps in the water it is standing in: 1 on dry
   * land, easing to `wadeSpeedMult` by the depth where it would start
   * swimming.
   *
   * Continuous on purpose. A single multiplier applied the instant a toe gets
   * wet is a step change at the shoreline, and a step change reads as a
   * trigger — you can see where the designer put the line. Water that gets
   * heavier as it climbs reads as water.
   */
  private wadeDrag(tuning: SwimTuning): number {
    if (this.swimState !== "wading" || !(this.swimDepth > 0)) return 1;
    const t = Math.max(0, Math.min(1, this.swimDepth / Math.max(0.1, tuning.enterDepth)));
    return 1 + (this.param<number>("wadeSpeedMult") - 1) * t;
  }

  /** Swim tuning as the shared rules want it (see locomotion.ts). */
  private swimTuning(): SwimTuning {
    const enter = this.param<number>("swimEnterDepth");
    return {
      enterDepth: enter,
      // a badly tuned pair (exit above enter) would flip modes every tick, so
      // the exit is held under the entry here rather than trusted
      exitDepth: Math.min(this.param<number>("swimExitDepth"), enter - 0.05),
      floatDepth: this.param<number>("swimFloatDepth"),
      buoyancy: this.param<number>("buoyancy"),
      climbSpeed: this.param<number>("swimClimbSpeed"),
    };
  }

  /**
   * Degrees to tip a swimming body, which is zero whenever the model has a
   * swim clip of its own: that clip already lies the character down, and
   * pitching it as well points it at the bottom of the lake. Only the
   * fallback — the run cycle, standing upright — needs to be laid flat.
   */
  private swimTilt(stroking: boolean): number {
    if (!stroking) return 0; // treading water is upright in either case
    const run = this.param<string>("runClip");
    return this.pick(this.param<string>("swimClip"), run) === run ? this.param<number>("swimPitch") : 0;
  }

  /**
   * True while any dive key is held (blank disables diving entirely).
   *
   * A LIST, because the obvious key for "go down" is spoken for on a lot of
   * setups — Ctrl is crouch in half the games this borrows from, and a browser
   * or an OS may take it before the page ever sees it. Naming a second key
   * costs nothing and is the difference between "I cannot dive" and a keybind.
   */
  private diveKeyDown(input: { isDown(code: string): boolean }): boolean {
    const keys = this.param<string>("swimDownKey");
    if (!keys) return false;
    for (const key of keys.split(",")) {
      const code = key.trim();
      if (code && input.isDown(code)) return true;
    }
    return false;
  }

  /**
   * The water over this body's FEET, or null when it is not in any.
   *
   * Measured at the feet, not at the origin, because the origin sits at a
   * different height inside every capsule a project authors — and the depth
   * thresholds are quoted as "chest deep", which is a statement about a body,
   * not about where somebody put its pivot. `groundRest` is that offset,
   * measured by the ground probe; until the probe has answered once (a
   * character that spawned in mid-air, or in the water) half a standing
   * capsule is the assumption.
   */
  private sampleWater(): WaterAt | null {
    if (!this.ctx.waterAt || !this.param<boolean>("swim")) return null;
    const at = (this.scratch ??= this.object.position.clone());
    this.object.getWorldPosition(at);
    return this.ctx.waterAt(at.x, at.y - this.footDrop(), at.z);
  }

  /**
   * How far this body's feet are below its origin.
   *
   * Taken from the COLLIDER, which states it exactly, rather than from the
   * ground probe's measured resting distance. The probe's number is right
   * whenever it is right, but it is recorded on the first tick the body looks
   * settled — and a body that spawned in mid-air with no velocity looks
   * settled, so it records the height it was dropped from and every depth
   * afterwards is measured from a point in the air. Seen: a character wading
   * in ankle-deep water reporting 1.4 m over its feet, and swimming in it.
   */
  private footDrop(): number {
    if (this.foot !== null) return this.foot;
    const stated = this.restFromCollider();
    if (stated !== null) {
      this.foot = stated;
      return this.foot;
    }
    // no collider to ask (a body driven some other way): the probe's guess,
    // then half a standing capsule
    return this.groundRest ?? 0.9;
  }

  /**
   * How far the ground is when this body is STANDING on it, straight off the
   * collider — or null where the collider cannot say.
   *
   * The ray runs down from the body's ORIGIN, so this is the collider's own
   * reach from that origin to its feet: half its height, less however far it
   * is offset, times the entity's scale. Exactly the shape the physics sim
   * builds, which is why it can be stated rather than measured.
   *
   * Only for the SIZED primitives. A trimesh/convex/heightmap collider is
   * cooked from the entity's mesh and its `size` means nothing at all — the
   * schema says so — so those bodies fall back to measuring.
   */
  private restFromCollider(): number | null {
    const collider = this.ctx.getEntity(this.entityId)?.components["collider"] as
      | { shape?: string; size?: number[]; offset?: number[] }
      | undefined;
    if (!collider) return null;
    const shape = collider.shape ?? "box";
    if (shape !== "capsule" && shape !== "box" && shape !== "sphere" && shape !== "cylinder") return null;
    const height = collider.size?.[1];
    if (!(typeof height === "number" && height > 0)) return null;
    // a collider hung BELOW the origin rests further from it, one lifted above
    // it rests nearer — and the whole thing scales with the entity
    const reach = height / 2 - (collider.offset?.[1] ?? 0);
    if (!(reach > 0)) return null;
    const scale = Math.abs(this.object.getWorldScale((this.scale ??= this.object.scale.clone())).y) || 1;
    return reach * scale;
  }

  /**
   * The swimming clip: a stroke, or treading water.
   *
   * Pitch (applied by the caller, through the slope-lean channel) is what
   * makes this work on a model that never shipped a swim clip. A run cycle
   * played face-down at a stroke's pace reads as a crawl; the same clip
   * upright reads as a character marching along the bottom of the lake, which
   * is the single most obvious way for swimming to look wrong.
   */
  private playSwim(
    planar: number,
    vy: number,
    stroking: boolean,
    backing: boolean,
    variant: (base: string) => string,
  ): void {
    const swimSpeed = this.param<number>("swimSpeed");
    // Nobody crawls backwards. Backing up in water is sculling: the treading
    // cycle, which is already an upright body moving its arms, played while
    // the body drifts back. A forward stroke run in reverse reads as a
    // character being dragged by the ankles.
    if (!stroking || backing) {
      this.setRateRaw(1);
      this.play(variant(this.pick(this.param<string>("swimIdleClip"), this.param<string>("idleClip"))), 0.25);
      return;
    }
    const run = this.param<string>("runClip");
    const clip = this.pick(this.param<string>("swimClip"), run);
    // A stand-in run cycle is authored for a RUN; paid out at swimming pace it
    // would be a sprint on its face. So the rate is measured against the speed
    // the clip actually depicts — the run's, for the fallback — and only
    // against the swim speed for a real swim clip.
    this.setRate(Math.hypot(planar, vy), clip, clip === run ? this.param<number>("speed") : swimSpeed);
    this.play(variant(clip), 0.2);
  }

  /**
   * How long a clip runs, or null when nobody can say (no model yet, a
   * headless host). Callers pick their own fallback rather than being handed a
   * guess dressed as a measurement.
   */
  private clipLength(clip: string): number | null {
    const seconds = this.ctx.animationDuration?.(clip);
    return typeof seconds === "number" && seconds > 0 ? seconds : null;
  }

  /**
   * Turning on the spot: which way, or null. In camera-facing mode the
   * character pivots every time the camera does, and an idle clip played
   * through that pivot is a statue on a turntable. Started on a brisk turn and
   * held down to a much slower one, so a pivot that eases off does not flicker
   * back to idle halfway through.
   */
  private turnInPlace(dt: number): string | null {
    let diff = this.yaw - this.lastYaw;
    while (diff > Math.PI) diff -= Math.PI * 2;
    while (diff < -Math.PI) diff += Math.PI * 2;
    this.lastYaw = this.yaw;
    const rate = dt > 0 ? diff / dt : 0;
    const start = this.param<number>("turnClipSpeed");
    if (this.turning && Math.abs(rate) < start * 0.4) this.turning = null;
    else if (!this.turning && Math.abs(rate) > start) this.turning = rate > 0 ? "left" : "right";
    if (!this.turning) return null;
    const idle = this.param<string>("idleClip");
    const clip = this.pick(
      this.param<string>(this.turning === "left" ? "turnLeftClip" : "turnRightClip"),
      idle,
    );
    return clip === idle ? null : clip;
  }

  /**
   * The gait to play, holding the current one through a REVERSAL inside the
   * dwell window. Speeding up is instant — that is the player's own input and
   * has to feel like it — but dropping back to a slower clip moments after
   * climbing out of it is never anything but noise, and each of those flips
   * costs a crossfade the eye can see.
   */
  private stepGait(speed: number, tuning: GaitTuning, now: number): Gait {
    return this.gait.step(speed, tuning, now, this.param<number>("gaitDwell"));
  }

  /**
   * Cast the ground ray (at most every `groundProbe` seconds) and answer the
   * one question the caller needs: is this body leaving the ground? Null means
   * "no opinion" — no ray available, or not yet calibrated — and the caller
   * falls back to the velocity heuristic.
   *
   * The resting distance — how far the ground is when the feet are ON it —
   * comes from the COLLIDER, which states it exactly (see restFromCollider).
   * It used to be measured instead, on the first tick the body looked
   * settled, because the origin sits at a different height above the feet for
   * every capsule and offset a project authors. The trouble is that "settled"
   * and "standing on something" are not the same thing: a body HELD in the
   * air reports identical evidence — no velocity, no air time — and the host
   * holds one every time it spawns or fast-travels a player while the
   * destination's terrain streams in (travelHold in the playground). The MMO's
   * own spawn sits 1.2 m over ground its capsule rests 0.9 m above, so the
   * character began every session believing the floor was 30 cm further down
   * than it is; a map fast-travel, which pins the body 2.5 m up, made it three
   * metres. Everything downhill of that number then reads air as floor: the
   * character walks off the lip of a slope, keeps following ground that is no
   * longer under it, and strolls out into space — "I can float on a gradient".
   *
   * Measuring survives only for a body whose collider cannot state it (a
   * cooked mesh collider, or no collider at all), and the old guards with it.
   */
  /**
   * Was the body MOVED rather than travelled — fast travel, a respawn, a
   * transfer between zones?
   *
   * Worth asking every tick because everything the controller knows about the
   * ground describes where the body USED to be: a normal from the old slope,
   * a gap measured to the old floor, a stretch of air time that belongs to a
   * fall somewhere else. Following that normal on the first tick at the new
   * place is a shove in a direction nothing under the character justifies,
   * and the air time turns a teleport into a landing.
   */
  private teleported(speed: number, dt: number): boolean {
    const at = (this.here ??= this.object.position.clone());
    this.object.getWorldPosition(at);
    // measured BEFORE the remembered position is overwritten — they are the
    // same vector from the second tick on
    const moved = this.lastAt ? this.lastAt.distanceToSquared(at) : -1;
    (this.lastAt ??= at.clone()).copy(at);
    if (moved < 0) return false;
    const reach = Math.max(TELEPORT_JUMP, speed * dt * 4);
    return moved > reach * reach;
  }

  /** Drop every ground measurement — it describes somewhere this body no longer is. */
  private forgetGround(): void {
    this.probeAt = -999;
    this.groundNormal = null;
    this.groundDist = Infinity;
    this.stickVy = null;
    this.airTime = 0;
    this.airFor = 0;
    this.wasAirborne = false;
    this.landUntil = 0;
    // and the water: a body teleported out of a lake is not still in it, and
    // the surface hand-off below would read the old state as "left the water"
    this.swimState = "dry";
    this.swimDepth = 0;
    this.wasSwimming = false;
    // The resting distance deliberately SURVIVES: it is a fact about this
    // body's capsule, not about the ground it happens to be over (see
    // restFromCollider, which is where it comes from).
  }

  private movementSound(raw: string, priority: number, gain = 1): void {
    if (!this.param<boolean>("footsteps")) return;
    const local = this.ctx.localPlayer?.();
    if (local && local !== this.entityId) return;
    const choices = raw.split(",").map((sound) => sound.trim()).filter(Boolean);
    const sound = choices[Math.floor(Math.random() * choices.length)];
    if (sound) this.ctx.playSound?.(sound, { volume: this.param<number>("footstepVolume") * gain, playbackRate: 0.95 + Math.random() * 0.1, priority });
  }

  private surfaceKey(raw: string): string {
    const value = raw.toLowerCase();
    if (value.includes("water")) return "water";
    if (value.includes("snow") || value.includes("ice")) return "snow";
    if (value.includes("sand")) return "sand";
    if (value.includes("grass") || value.includes("moss")) return "grass";
    if (value.includes("wood") || value.includes("timber")) return "wood";
    if (value.includes("metal") || value.includes("iron")) return "metal";
    if (value.includes("gravel")) return "gravel";
    if (value.includes("bone") || value.includes("paper") || value.includes("rubble") || value.includes("debris")) return "rubble";
    if (value.includes("stone") || value.includes("rock") || value.includes("brick")) return "stone";
    return "dirt";
  }

  private updateFootsteps(planar: number, grounded: boolean, swimming: boolean, stroking: boolean, dt: number): void {
    if (!this.param<boolean>("footsteps")) return;
    const moving = swimming ? stroking : grounded && planar > 0.15;
    if (!moving) {
      this.footstepDistance = 0;
      return;
    }
    this.footstepDistance += planar * dt;
    const distance = swimming ? Math.max(0.65, planar / 1.8) : Math.max(0.55, planar / this.param<number>("footstepCadence"));
    if (this.footstepDistance < distance) return;
    this.footstepDistance %= distance;
    if (swimming) {
      this.movementSound(this.param<string>("swimSound"), 2, 0.65);
      return;
    }
    this.contactSound(1, 1);
  }

  private contactSound(priority: number, gain: number): void {
    const p = this.object.position;
    const key = this.surfaceKey(this.ctx.surfaceAt?.(p.x, p.y, p.z) ?? "dirt");
    const sounds = this.param<Record<string, string>>("footstepSounds") ?? {};
    this.movementSound(sounds[key] ?? sounds.dirt ?? "", priority, gain);
  }

  private probeGround(sim: SimLike, now: number, vy: number, planarSpeed: number): boolean | null {
    const interval = this.param<number>("groundProbe");
    if (!(interval > 0) || !sim.raycast) return null;
    // Sticking to the ground needs a CURRENT normal — 50 ms is a third of a
    // metre at a run, which is the whole crest — so a moving body that sticks
    // probes every tick. Standing still, or with sticking off, the interval is
    // plenty.
    const fresh = this.param<number>("groundStick") > 0 && planarSpeed > 0.1;
    if (fresh || now - this.probeAt >= interval) {
      this.probeAt = now;
      const at = (this.scratch ??= this.object.position.clone());
      this.object.getWorldPosition(at);
      const hit = sim.raycast([at.x, at.y, at.z], [0, -1, 0], PROBE_REACH, {
        exclude: [this.entityId],
      });
      this.groundNormal = hit ? hit.normal : null;
      this.groundDist = hit ? hit.distance : Infinity;
      if (this.groundRest === null) this.groundRest = this.restFromCollider();
      if (hit && this.groundRest === null && this.airTime === 0 && Math.abs(vy) < 1) {
        this.groundRest = hit.distance;
      }
    }
    if (this.groundRest === null) return null;
    // Rising means the body has left the ground — unless the rise is the
    // ground itself, climbed. Following a slope up writes exactly this
    // velocity, and reading it as a jump is how running UP a hill ends in the
    // falling clip with both feet on the ground.
    if (vy > 0.8 && !this.risingByStick(vy)) return true;
    return this.groundDist > this.groundRest + PROBE_SLACK;
  }

  /**
   * Is this upward velocity one WE wrote to follow the ground, rather than a
   * jump, a knockback or a launch pad? Ours is ours to overwrite; anybody
   * else's has to survive untouched, which is the whole difference between
   * climbing a hill and cancelling a jump.
   */
  private risingByStick(vy: number): boolean {
    return risingByGround(vy, this.stickVy);
  }

  /**
   * Vertical velocity that keeps the body ON the ground it is running over,
   * or the one it already had.
   *
   * A body driven by `setLinvel` alone travels in a straight line, so every
   * convex break in the ground throws it off: at the crest of a hill it keeps
   * going straight while the ground drops away, and it is genuinely airborne
   * for a third of a second until gravity catches up. Measured on a 25° ramp
   * at 6.5 m/s, that is half a second of the falling clip at every crest —
   * which, on terrain that merely rolls, is a character permanently gliding.
   * No clip-picking rule can fix it, because the character really is in the
   * air. So follow the surface: the vertical rate that keeps a body on a plane
   * of this normal, capped by the slope the character is allowed to walk.
   *
   * Only inside `groundStick` metres of the ground, only on ground it could
   * walk on, and never during a jump — a real drop still falls.
   */
  private followGround(
    x: number,
    vy: number,
    z: number,
    grounded: boolean,
    now: number,
    dt: number,
  ): number {
    const n = this.groundNormal;
    // A jump owns the body outright for its grace window; everything else goes
    // to the shared rule, which the server runs on the same body.
    if (!grounded || !n || this.groundRest === null || now - this.lastJump < 0.25) {
      this.stickVy = null;
      return vy;
    }
    const follow = groundFollowVy(x, z, vy, n, this.groundDist - this.groundRest, {
      stick: this.param<number>("groundStick"),
      slopeTolerance: this.param<number>("slopeTolerance"),
      dt,
      ours: this.risingByStick(vy),
      popCap: this.param<number>("stepPopCap"),
    });
    this.stickVy = follow;
    return follow ?? vy;
  }

  /**
   * Lean the body onto the ground it is standing on, and write the rotation.
   *
   * Standing bolt upright on a hillside is the other half of "the animation is
   * wrong on slopes" — the clips are fine, the character is simply at the
   * wrong angle to the floor. This takes part of the way there (a full align
   * reads as a toy on a ramp) and is smoothed, because a ray is a step
   * function and a body is not.
   */
  private applyLean(grounded: boolean, dt: number, swimPitch: number | null): void {
    const amount = this.param<number>("slopeAlign");
    const n = grounded && amount > 0 ? this.groundNormal : null;
    let pitch = 0;
    let roll = 0;
    if (swimPitch !== null) {
      // swimming: the water decides the body's attitude, not the ground
      pitch = swimPitch;
    } else if (n && n[1] > 0.2) {
      const cap = (this.param<number>("slopeAlignMax") * Math.PI) / 180;
      // the model's own axes after the yaw: +Z is forward, +X is right
      const sy = Math.sin(this.yaw);
      const cy = Math.cos(this.yaw);
      const ahead = n[0] * sy + n[2] * cy;
      const beside = n[0] * cy - n[2] * sy;
      pitch = clampAbs(Math.atan2(ahead, n[1]) * amount, cap);
      roll = clampAbs(-Math.atan2(beside, n[1]) * amount, cap);
    }
    this.pitch = damp(this.pitch, pitch, LEAN_DAMP, dt);
    this.roll = damp(this.roll, roll, LEAN_DAMP, dt);
    // YXZ: yaw first about world up, then the lean about the body's own axes.
    this.object.rotation.set(this.pitch, this.yaw, this.roll, "YXZ");
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
    altOffset: {
      default: [],
      description:
        "A second pose for the held item, eased in while `altWhen` holds — [x, y, z]; empty = none. A shield is " +
        "carried flat against the arm but held face-forward in a guard, and no one pose is right for both.",
    },
    altRotationDeg: { default: [], description: "rotation of the second pose, degrees; empty = none" },
    altBone: {
      default: "",
      description:
        "bone the second pose hangs off; empty = `bone`. A shield carried on the forearm is held in the FIST in a guard.",
    },
    altWhen: {
      default: "",
      description:
        "userData key on the character (the nearest ancestor that carries it) that selects the second pose: " +
        "true, or a time in the future in seconds (e.g. combatUntil).",
    },
    altBlend: { default: 0.25, min: 0, max: 5, description: "seconds to ease between the two poses" },
  };

  private altQuat: THREE.Quaternion | null = null;
  private altMix = 0;
  private altBoneObj: THREE.Object3D | null = null;
  private altPos!: THREE.Vector3;
  private altBoneQuat!: THREE.Quaternion;

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

  /** The params the cached rotations and bone lookups were built from. */
  private synced = "";

  override onStart(): void {
    this.offsetQuat = this.object.quaternion.clone();
    this.synced = "";
    this.bonePos = this.object.position.clone();
    this.shift = this.object.position.clone();
    this.boneQuat = this.object.quaternion.clone();
    this.parentQuat = this.object.quaternion.clone();
    this.altPos = this.object.position.clone();
    this.altBoneQuat = this.object.quaternion.clone();
    this.altBoneObj = null;
    this.bone = null;
    this.altMix = 0;
    this.syncParams();
  }

  /**
   * Rebuild what is derived from the params whenever they change — they can
   * change UNDER a running socket (an inspector edit during play is patched in
   * live, not restarted), and placing a weapon by eye is exactly that loop.
   */
  private syncParams(): void {
    const deg = this.param<[number, number, number]>("rotationDeg");
    const alt = this.param<number[]>("altRotationDeg");
    const bone = this.param<string>("bone");
    const altBone = this.param<string>("altBone");
    const key = JSON.stringify([deg, alt, bone, altBone]);
    if (key === this.synced) return;
    if (this.synced) {
      const [, , prevBone, prevAlt] = JSON.parse(this.synced) as [unknown, unknown, string, string];
      if (prevBone !== bone) this.bone = null;
      if (prevAlt !== altBone) this.altBoneObj = null;
    }
    this.synced = key;
    const toRad = (d: number): number => (d * Math.PI) / 180;
    const euler = this.object.rotation.clone().set(toRad(deg[0]), toRad(deg[1]), toRad(deg[2]));
    this.offsetQuat.setFromEuler(euler);
    this.altQuat =
      Array.isArray(alt) && alt.length === 3
        ? this.object.quaternion.clone().setFromEuler(euler.clone().set(toRad(alt[0]!), toRad(alt[1]!), toRad(alt[2]!)))
        : null;
  }

  /**
   * After animation: place the item again on the bone as it is THIS frame. On
   * the fixed tick alone it sat where the arm was a frame ago — a shield that
   * visibly trailed a swinging forearm.
   */
  override onLateUpdate(): void {
    this.onFixedUpdate(0);
  }

  /** A live edit: re-pose now, even paused — you are placing it by eye. */
  override onParamsChanged(): void {
    this.onFixedUpdate(0);
  }

  /** Whether the character asks for the second pose now (see `altWhen`). */
  private altWanted(): boolean {
    const key = this.param<string>("altWhen");
    if (!key || !this.altQuat) return false;
    for (let o = this.object.parent; o; o = o.parent) {
      if (!(key in o.userData)) continue;
      const v = o.userData[key];
      return typeof v === "number" ? v > this.ctx.now() / 1000 : v === true;
    }
    return false;
  }

  override onFixedUpdate(dt: number): void {
    const parent = this.object.parent;
    if (!parent) return;
    this.syncParams();
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
    this.boneQuat.multiply(this.offsetQuat); // world pose of the MAIN socket

    // ease toward whichever pose the character is asking for
    const blend = this.param<number>("altBlend");
    const target = this.altWanted() ? 1 : 0;
    const step = blend > 0 ? dt / blend : 1;
    this.altMix = target > this.altMix ? Math.min(target, this.altMix + step) : Math.max(target, this.altMix - step);
    const m = this.altQuat ? this.altMix * this.altMix * (3 - 2 * this.altMix) : 0;
    // which pose is on show — the editor's gizmo edits THAT one
    this.object.userData["socketPose"] = m > 0.5 ? "alt" : "main";
    if (m > 0 && this.altQuat) {
      // the second pose, in world terms off its own bone, then blended — two
      // bones cannot be blended in either one's local frame
      const altName = this.param<string>("altBone");
      if (altName && !this.altBoneObj) {
        this.altBoneObj = parent.getObjectByName(altName) ?? parent.getObjectByName(BoneSocket.sanitizeBoneName(altName)) ?? null;
      }
      const altBone = altName ? this.altBoneObj : this.bone;
      if (altBone) {
        altBone.updateWorldMatrix(true, false);
        altBone.getWorldPosition(this.altPos);
        altBone.getWorldQuaternion(this.altBoneQuat);
        const ao = this.param<number[]>("altOffset");
        if (ao.length === 3) this.altPos.add(this.shift.set(ao[0]!, ao[1]!, ao[2]!).applyQuaternion(this.altBoneQuat));
        this.altBoneQuat.multiply(this.altQuat);
        this.bonePos.lerp(this.altPos, m);
        this.boneQuat.slerp(this.altBoneQuat, m);
      }
    }

    parent.updateWorldMatrix(true, false);
    this.object.position.copy(parent.worldToLocal(this.bonePos));
    parent.getWorldQuaternion(this.parentQuat).invert();
    this.object.quaternion.copy(this.parentQuat.multiply(this.boneQuat));
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

/** "2h 30m" / "45s" — console output, where a raw 9000 means nothing to anyone. */
function describeSeconds(total: number): string {
  if (!Number.isFinite(total) || total <= 0) return "no time at all";
  if (total < 90) return `${Math.round(total)}s`;
  const minutes = Math.round(total / 60);
  if (minutes < 90) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

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
    dayLength: { default: 7200, min: 10, max: 86400, description: "Real seconds per 24-hour game day." },
    startHour: { default: 9, min: 0, max: 24, description: "Clock at scene start: 6 = sunrise, 12 = noon, 18 = sunset. The live displayed hour is published on this entity's object.userData.dayNightHour (including offline play); multiplayer authority also replicates world.hour." },
    tilt: { default: 30, min: 0, max: 80, description: "Degrees the sun's arc leans away from straight overhead (toward -Z), so noon shadows still fall somewhere." },
    dawnColor: { default: "#ff9d5c", description: "Sun colour at the horizon; blends into the sun light's authored colour by mid-morning." },
    sunsetColor: { default: "#e2593a", description: "Colour the cloud burns on the sun's side of the sky at the exact horizon — deeper and redder than dawnColor, which it eases into as the sun climbs." },
    cloudGlow: { default: 1, min: 0, max: 1, description: "How hard the sun-facing clouds glow at dawn and dusk. 0 leaves the deck evenly lit, which is the look before this existed." },
    nightCloud: { default: "#2a3350", description: "Cloud colour at full night — moonlit blue-grey. Cloud is the LAST thing to go black: a night sky reads as overcast because the cloud is still faintly visible against the stars." },
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
  static override commands: ScriptCommandDecl[] = [
    {
      name: "time",
      args: "[hour | dawn | noon | dusk | night | midnight | +n | -n | freeze | resume]",
      description: "Set or report the clock. Bare /time says what time it is.",
      authority: true,
    },
    {
      name: "timescale",
      args: "[multiplier]",
      description: "Run the day faster or slower without touching dayLength (1 = authored).",
      authority: true,
    },
  ];
  private hour = 9;
  /** Console: the clock is held still. The sky still updates — sun, fog, stars. */
  private frozen = false;
  /** Console: multiplies the authored day length's rate. */
  private timescale = 1;
  private base: LiveSkyBase | null = null;
  private targetHour: number | null = null;
  private lastEnvBucket = -1;
  private sinceSync = 0;
  private unsubscribe: (() => void) | null = null;

  /**
   * The tagged emitter belonging to THIS tab's player.
   *
   * The emitters hang off the player body so the weather follows the camera,
   * and on a dedicated server every joiner gets a CLONE of that body — so a
   * plain "first entity with the tag" hands one tab the rain emitter parented
   * to somebody else's character, three zones away. Then it rains on a
   * stranger and never on you. Ids of a cloned body are prefixed with it
   * (`player:p-alice/weather-rain`), which is all it takes to tell them apart;
   * single-player has exactly one and falls through to it.
   */
  private ownEmitter(tag: string): string | null {
    const found = this.ctx.findByTag(tag);
    if (found.length <= 1) return found[0] ?? null;
    const self = this.ctx.localPlayer?.() ?? null;
    if (self) {
      const mine = found.find((id) => id === self || id.startsWith(`${self}/`));
      if (mine) return mine;
    }
    return found[0] ?? null;
  }

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
    if (!this.frozen) this.hour = (this.hour + ((dt * this.timescale) / dayLength) * 24) % 24;
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

  /**
   * `/time` and `/timescale`. Only reached from the developer console, which
   * a published build normally strips.
   *
   * It writes the clock straight to netState rather than waiting for the next
   * `syncSeconds` tick: a tester types /time 22, and a four-second wait for
   * the other tab to go dark reads as the command not having worked.
   */
  override onCommand(name: string, args: string[]): string | null {
    if (name === "timescale") {
      if (args.length === 0) return `timescale ${this.timescale}x`;
      const scale = Number(args[0]);
      if (!Number.isFinite(scale) || scale < 0) throw new Error("usage: /timescale <multiplier>, e.g. 60");
      this.timescale = scale;
      return `timescale ${scale}x (a day now takes ${describeSeconds(this.param<number>("dayLength") / Math.max(scale, 1e-6))})`;
    }
    const arg = (args[0] ?? "").toLowerCase();
    if (!arg) return this.clockLine();
    if (arg === "freeze" || arg === "stop" || arg === "pause") {
      this.frozen = true;
      return `clock frozen at ${this.clockLine()}`;
    }
    if (arg === "resume" || arg === "run" || arg === "start") {
      this.frozen = false;
      return `clock running — ${this.clockLine()}`;
    }
    const named: Record<string, number> = { dawn: 6, sunrise: 6.2, morning: 9, noon: 12, afternoon: 15, dusk: 18, sunset: 18.4, evening: 20, night: 22, midnight: 0 };
    let hour: number;
    if (arg in named) hour = named[arg]!;
    else if (/^[+-]/.test(arg)) {
      const delta = Number(arg);
      if (!Number.isFinite(delta)) throw new Error(`/time ${arg}: not a number of hours`);
      hour = this.hour + delta;
    } else {
      // "22" or "22:30"
      const [h, m] = arg.split(":");
      const parsed = Number(h) + (m ? Number(m) / 60 : 0);
      if (!Number.isFinite(parsed)) {
        throw new Error(`/time ${arg}: give an hour (0-24), a time (21:30), a shift (+2) or one of ${Object.keys(named).join(", ")}`);
      }
      hour = parsed;
    }
    this.hour = ((hour % 24) + 24) % 24;
    this.ctx.netState?.set(NET_HOUR_KEY, this.hour);
    this.targetHour = null; // a peer easing toward the old published hour must stop
    this.apply(false);
    return this.clockLine();
  }

  /** "21:30 · night" — the answer to "did that work?". */
  private clockLine(): string {
    const h = Math.floor(this.hour);
    const m = Math.floor((this.hour - h) * 60);
    const band = this.hour < 5 || this.hour >= 21 ? "night" : this.hour < 7.5 ? "dawn" : this.hour < 16.5 ? "day" : this.hour < 19.5 ? "dusk" : "evening";
    return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")} · ${band}${this.frozen ? " · frozen" : ""}`;
  }

  private apply(first: boolean): void {
    this.object.userData["dayNightHour"] = this.hour;
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
    // The cloud glow's window: full while the sun is within ~10° of the
    // horizon, gone by ~20° above it and shortly after it has set. Wider than
    // `horizonGlow` (which the sky gradient uses) and symmetric about e = 0,
    // so the sun's side of the deck is still burning as the disc goes down.
    const horizonBand = smooth01((0.34 - Math.abs(e)) / 0.17) * smooth01((e + 0.2) / 0.12);

    const dawn = hexToRgb(this.param<string>("dawnColor"));
    const nightCloud = hexToRgb(this.param<string>("nightCloud"));
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
      // Clouds keep the authored coverage; only their lighting follows the
      // day. Three separate things, because a sunset is not one colour:
      //  - `color`/`shadow` are the AMBIENT half — daylight white over grey by
      //    day, cooling to the moonlit blue of `nightColor` at night. It is
      //    deliberately never the dawn colour: warming the whole dome is what
      //    makes the flat everything-is-orange sunset, and it left midnight
      //    cloud a dim brown.
      //  - `sun`/`sunAmount` are the DIRECTIONAL half the dome resolves per
      //    pixel against the sun's own azimuth — the burning side of the sky.
      //    Open it while the sun is within ~20° of the horizon (either side,
      //    so dusk and dawn both get it) and shut it by mid-morning.
      // `sunset` deepens toward red exactly at the horizon, where the light
      // has the most atmosphere to cross.
      clouds: {
        light: 0.12 + 0.88 * day,
        color: rgbToHex(mixRgb(nightCloud, [1, 1, 1], day)),
        shadow: rgbToHex(mixRgb(mixRgb(nightCloud, [0.08, 0.1, 0.16], 0.5), [0.54, 0.58, 0.66], day)),
        sun: rgbToHex(mixRgb(hexToRgb(this.param<string>("sunsetColor")), dawn, smooth01((Math.abs(e) - 0.02) / 0.16))),
        sunAmount: this.param<number>("cloudGlow") * horizonBand,
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
      // Published for the WEATHER layer, which owns a tint but not the clock:
      // a tint is the colour of falling rain/sand/snow LIT, so at midnight it
      // has to be dimmed or it lights the fog back up (scene-lighting.ts
      // applyEffective). Nothing else reads it.
      daylight: day,
      environmentIntensity: (base?.environmentIntensity ?? 1) * keep,
      ...(refresh ? { refreshEnvironment: true } : {}),
    });
  }
}

// ---- weather ---------------------------------------------------------------

const NET_WEATHER_KEY = "world.weather";

/**
 * The world's weather, as the authority rolls it: biome-agnostic on purpose.
 *
 * Everything here is the CURRENT value, not the plan — the authority walks the
 * front's envelope itself and publishes where it has got to, so a joiner three
 * quarters of the way through a storm sees a storm three quarters through and
 * needs to know nothing about how it started.
 */
interface WeatherState {
  /** 0 = clear, 1 = the heaviest this world does. What it FALLS as is the client's biome's business. */
  precipitation: number;
  /** 0..1, how violent right now: wind, gloom, fog, lightning. */
  storm: number;
  /** Gust strength, 0..1 — the fast layer on top of `storm`. */
  wind: number;
  /** Where the wind is blowing TO, radians about +Y. Shared so every client's rain leans the same way. */
  windAngle: number;
  /** Bumped on every lightning strike; a client that sees it change flashes the sky. */
  strike: number;
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
 * How bright the sky is `t` seconds after a strike, 0..1.
 *
 * Not one ramp: a bolt is a stroke, a gap, then two or three return strokes
 * down the same channel, and the flicker is the whole reason lightning reads
 * as lightning rather than as somebody turning a light on. Total 0.6s.
 */
function strikeFlash(t: number): number {
  if (t < 0) return 0;
  if (t < 0.04) return t / 0.04;
  if (t < 0.09) return 1;
  if (t < 0.14) return 0.12; // the dark gap — without it there is no flicker
  if (t < 0.2) return 0.85;
  if (t < 0.26) return 0.3;
  if (t < 0.32) return 0.7;
  if (t < 0.62) return 0.7 * (1 - (t - 0.32) / 0.3);
  return 0;
}

/** "#rrggbb" dimmed by `k` — what a colour looks like with less light on it. */
function scaleHex(hex: string, k: number): string {
  const [r, g, b] = hexToRgb(hex);
  return rgbToHex([r * k, g * k, b * k]);
}

/** Eight directions on the unit circle — the disc the biome blend is averaged over. */
const RING: Array<[number, number]> = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
  [0.7, 0.7],
  [-0.7, 0.7],
  [0.7, -0.7],
  [-0.7, -0.7],
];

/** Shortest signed turn from `from` to `to`, both radians. */
function angleDelta(from: number, to: number): number {
  let d = (to - from) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return d;
}

/**
 * Biome-aware weather on top of the day/night cycle.
 *
 * The AUTHORITY (dedicated server, or the P2P host) owns one biome-agnostic
 * state — how much precipitation, how stormy, which way the wind is going —
 * and publishes it to netState. Every client then asks `ctx.biomeAt` what the
 * ground under its player is and blends three looks by the biome weights the
 * world already blends its textures with: rain where the rain biomes are,
 * blowing sand in the sand biomes, snow in the snow biomes or above
 * `snowAbove`. Walking from grassland into desert fades rain into sand over
 * the same metres the ground changes, with no extra traffic.
 *
 * Weather ARRIVES rather than switching on. A roll does not pick a downpour,
 * it picks a FRONT, and the authority walks that front's envelope: a drizzle
 * that builds, breaks into a pour that breathes, then tapers out. The cloud
 * darkens with it and, at the height of a storm, throws lightning.
 *
 * Everything it drives is cheap by construction: player-parented emitters
 * (tagged `weather-rain` / `weather-sand` / `weather-snow` / `weather-dust`)
 * whose rate and AIM it dials, and `ctx.setSky`'s weather layer — gloom, tint,
 * wind, cloud coverage and darkening, fog and the lightning flash — which are
 * uniforms applied on top of whatever the `day-night` script wrote, so the two
 * scripts never need to know about each other. It never adds a light and never
 * touches the environment texture.
 *
 * Splashes are NOT driven from here. A raindrop's `particles.ground.splash`
 * fires them where the drop actually landed; driving a splash emitter's rate
 * instead spawns every splash at the emitter's own origin, which is a puff of
 * particles at your feet however good the splash itself looks.
 */
class Weather extends Script {
  static override scriptName = "weather";
  static override params = {
    changeMinutes: { default: 6, min: 0.1, max: 120, description: "Real minutes between weather rolls (the authority's cadence). One roll is one FRONT, whose whole arrival-peak-departure arc fits in this window." },
    chance: { default: 0.5, min: 0, max: 1, description: "Probability a roll brings precipitation rather than clear sky." },
    force: { default: "auto", description: "auto | clear | drizzle | light | storm — pin the world's weather (authoring/testing); auto rolls it. A pinned front still arrives and builds; it just never leaves." },
    rainBiomes: { default: "grassland,forest,jungle,beach,swamp,fen,moor,savanna,foothills,highland,taiga", description: "Biome ids where precipitation falls as rain." },
    sandBiomes: { default: "desert,badlands", description: "Biome ids where a storm is blowing sand." },
    snowBiomes: { default: "tundra,alpine,montane,mountains", description: "Biome ids where precipitation is snow." },
    dustBiomes: {
      default: "desert,badlands,crag",
      description:
        "Biome ids whose AIR carries dust with no weather at all — bare, plantless country where the wind " +
        "always has something to pick up. Deliberately not the same question as what precipitation falls as, " +
        "and deliberately NOT beaches: sand underfoot is not dust in the air, and a hazy beach looks wrong.",
    },
    ambientDust: {
      default: 0.22,
      min: 0,
      max: 1,
      description:
        "How much of the dust bank drifts in those biomes on a clear day. Particles only — never the lens " +
        "overlay, which is a storm you are caught in, not the look of a dry country.",
    },
    biomeRadius: {
      default: 24,
      min: 0,
      max: 200,
      description:
        "Metres around the player the biome blend is averaged over, instead of read at one point. A footpath, " +
        "a rock shelf or a sandy clearing inside a forest is not a desert, and weather that changes when you " +
        "step onto one reads as broken. 0 samples the single point under the player.",
    },
    biomeMajority: {
      default: 0.35,
      min: 0,
      max: 1,
      description:
        "Share of the surrounding land a look needs before it appears at all; it reaches full strength at " +
        "roughly twice this. The guard against a sliver of one biome dressing the whole sky — at 0 a 5% " +
        "fringe of badlands puts a sandstorm over a forest.",
    },
    snowAbove: { default: 220, min: -1000, max: 5000, description: "World Y above which precipitation is snow in any biome." },
    fadeSeconds: { default: 8, min: 0.5, max: 120, description: "How long a change takes to fade in or out, locally. The front's own envelope is the slow shape; this only smooths the steps between published states." },
    drizzle: { default: 0.22, min: 0, max: 1, description: "Where a front OPENS, as a fraction of its peak. Rain that starts at full strength reads as a switch; this is the spitting few minutes before it means it." },
    rainRate: { default: 2600, min: 0, max: 8000, description: "Rain emitter spawn rate per second at full precipitation. A pour is DENSE: too few drops and each one reads as a scratch on the lens rather than as weather." },
    snowRate: { default: 250, min: 0, max: 5000, description: "Snow emitter spawn rate per second at full precipitation." },
    sandRate: {
      default: 480,
      min: 0,
      max: 5000,
      description:
        "Sand emitter spawn rate per second at full precipitation. Deliberately modest: the individual grains " +
        "are the least of what a sandstorm is — the lens overlay carries the near field and the bank carries " +
        "the distance, and a cloud of specks on top of both just reads as dirt on the screen.",
    },
    gritMax: {
      default: 1,
      min: 0,
      max: 1,
      description:
        "How much screen-space grit a full sandstorm throws across the lens (postfx.sandstorm). This is the " +
        "part that makes a storm something you are IN rather than something you are looking at; 0 leaves only " +
        "the world-space bank, which reads as a dust cloud in the middle distance.",
    },
    dustRate: { default: 34, min: 0, max: 200, description: "Ground-hugging dust bank (tag `weather-dust`) spawn rate per second at a full sandstorm — the big soft quads that roll past and take your sightline with them. Small on purpose: they live 6-10 seconds, so 34/s is ~240 alive, and each one is most of the screen in alpha when you are inside the bank." },
    rainSpeed: { default: 24, min: 1, max: 80, description: "How fast rain falls, m/s, at the height of a front." },
    rainWind: { default: 13, min: 0, max: 60, description: "How hard a full storm blows the rain sideways, m/s. This is what makes the streaks LEAN — they point along their own velocity, so wind is the only thing that can tilt them." },
    windTurnMinutes: { default: 5, min: 0.2, max: 120, description: "Roughly how long the wind takes to wander right round the compass." },
    gustSeconds: { default: 6, min: 0.5, max: 60, description: "Period of the gusting that rides on top of the wind. Short is chaotic — which is most of what separates a dust storm from a fog machine." },
    lightning: { default: 3, min: 0, max: 30, description: "Strikes per minute at the height of a storm; 0 for none. Each is a sky-wide flicker, not a bolt — no light is added, so it cannot stall the frame." },
    thunder: { default: "", description: "One or more comma-separated thunder sound asset ids, chosen at random after a strike and delayed by the distance the sound travelled. Empty = silent lightning." },
    thunderVolume: { default: 0.55, min: 0, max: 1, description: "Volume of the non-positional thunder roll." },
    rainSound: { default: "", description: "Looping rain ambience asset id. It fades with local rain intensity; empty keeps rain silent." },
    snowSound: { default: "", description: "Looping wind ambience asset id for snow. It fades with local snow intensity; empty keeps snow silent." },
    sandSound: { default: "", description: "Looping sandstorm ambience asset id. It fades with local sandstorm intensity; empty keeps sand silent." },
    rainSoundVolume: { default: 0.38, min: 0, max: 1, description: "Maximum local volume for rain ambience." },
    snowSoundVolume: { default: 0.24, min: 0, max: 1, description: "Maximum local volume for snow wind ambience." },
    sandSoundVolume: { default: 0.42, min: 0, max: 1, description: "Maximum local volume for sandstorm ambience." },
    fogBoost: {
      default: 9,
      min: 0,
      max: 60,
      description:
        "Fog density multiplier at the height of a rain or snow storm, on top of the authored density. Weather " +
        "you can see a kilometre through is weather you stop noticing: the distance closing in is most of what " +
        "makes a storm feel like one, and it is the cheapest part of it.",
    },
    sandFog: {
      default: 26,
      min: 0,
      max: 120,
      description:
        "The same, for a sandstorm — and far higher on purpose. Rain thins the distance; a sandstorm ENDS it, " +
        "at a few dozen metres. This is the knob that decides whether being caught in one is an event or a " +
        "colour grade.",
    },
    gloomMax: { default: 0.6, min: 0, max: 1, description: "How much a full storm dims sun, fill, ambient and IBL." },
    cloudDarkMax: { default: 0.85, min: 0, max: 1, description: "How far a full storm drives the cloud deck itself toward slate. Gloom dims what the cloud lights; this darkens the cloud you are looking AT, and a storm needs both or the world goes dim under a bright white sky." },
    windMax: { default: 3, min: 0, max: 10, description: "Foliage wind multiplier at full storm (1 = authored)." },
    syncSeconds: { default: 5, min: 1, max: 60, description: "Multiplayer: how often the authority publishes the state." },
    headHeight: {
      default: 0.75,
      min: 0,
      max: 3,
      description:
        "Metres from the player body's origin to its head, for the one thing this script asks about water: " +
        "precipitation stops while that head is under it.",
    },
  };
  static override commands: ScriptCommandDecl[] = [
    {
      name: "weather",
      args: "[auto | clear | drizzle | light | storm | front [kind] | rain | sand | snow | biome]",
      description: "Set or report the weather. A named front lands at full strength; 'front' plays its arrival from the first drizzle.",
      authority: true,
    },
    {
      name: "wind",
      args: "[degrees] [strength 0-1]",
      description: "Point the wind (0 = north, 90 = east) and set how hard it gusts.",
      authority: true,
    },
    { name: "lightning", args: "", description: "Strike now.", authority: true },
  ];
  private state: WeatherState = { precipitation: 0, storm: 0, wind: 0, windAngle: 0, strike: 0, until: 0 };
  /** Console: overrides the `force` param without editing the scene. */
  private forcedMode: string | null = null;
  /**
   * Console: what precipitation falls as here, whatever the biome says.
   *
   * This one exists because of how testing actually goes: a sandstorm only
   * happens in a desert, so checking one otherwise means walking there, or
   * rewriting the biome lists and reloading. Both are slow enough that the
   * effect gets shipped unlooked-at.
   */
  private forcedKind: WeatherKind | null = null;
  /** The authority's plan for the current front; peers never see it. */
  private front = { peak: 0, storm: 0, start: 0, span: 60 };
  /** `force` is set to something other than auto: the front arrives, then stays. */
  private pinned = false;
  private clock = 0;
  private sinceSync = 0;
  private sampleTimer = 0;
  private base: LiveSkyBase | null = null;
  private emitters: Record<WeatherKind, string | null> = { rain: null, sand: null, snow: null };
  /** The rolling bank of dust that makes a sandstorm a visibility problem rather than a texture. */
  private dust: string | null = null;
  /**
   * The splash emitters. Held ONLY so they can be dimmed with everything else
   * at night — their rate is never touched, because a splash belongs where the
   * drop landed (`ground.splash`), not at the emitter's own origin.
   */
  private splashes: string[] = [];
  /** Per-kind intensity targets from the biome blend, and the eased values the effects follow. */
  private target: Record<WeatherKind, number> = { rain: 0, sand: 0, snow: 0 };
  private local: Record<WeatherKind, number> = { rain: 0, sand: 0, snow: 0 };
  private localStorm = 0;
  /** How much of the land around the player is dusty country (see `dustBiomes`). */
  private dustShare = 0;
  /** Eased, so walking out of a desert does not switch the haze off. */
  private localDust = 0;
  /** The averaged blend, for `/weather` to report — placement bugs are invisible without it. */
  private blendHere: Record<string, number> = {};
  private localWind = 0;
  private localAngle = 0;
  /** Seconds since the last strike, or -1 when no flash is playing. */
  private flashAt = -1;
  /** Seconds until the thunder for that strike, or -1. */
  private thunderIn = -1;
  private lastStrike = 0;
  private unsubscribe: (() => void) | null = null;

  /**
   * The tagged emitter belonging to THIS tab's player.
   *
   * The emitters hang off the player body so the weather follows the camera,
   * and on a dedicated server every joiner gets a CLONE of that body — so a
   * plain "first entity with the tag" can hand one tab the rain emitter
   * parented to somebody else's character, three zones away. Then it rains on
   * a stranger and never on you. A cloned body prefixes its children's ids
   * (`player:p-alice/weather-rain`), which is all it takes to tell them apart;
   * single-player has exactly one and falls straight through.
   */
  private ownEmitter(tag: string): string | null {
    const found = this.ctx.findByTag(tag);
    if (found.length <= 1) return found[0] ?? null;
    const self = this.ctx.localPlayer?.() ?? null;
    if (self) {
      const mine = found.find((id) => id === self || id.startsWith(`${self}/`));
      if (mine) return mine;
    }
    return found[0] ?? null;
  }

  override onStart(): void {
    for (const kind of KINDS) this.emitters[kind] = this.ownEmitter(`weather-${kind}`);
    this.dust = this.ownEmitter("weather-dust");
    this.splashes = ["weather-splash", "weather-splash-ring"]
      .map((tag) => this.ownEmitter(tag))
      .filter((id): id is string => id !== null);
    this.base = this.ctx.getSky?.() ?? null;
    const net = this.ctx.netState;
    if (net && !net.isAuthority()) {
      const published = net.get(NET_WEATHER_KEY) as WeatherState | undefined;
      if (published && typeof published.precipitation === "number") this.adopt(published);
      this.unsubscribe = net.onChange((key, value) => {
        if (key === NET_WEATHER_KEY && value && typeof (value as WeatherState).precipitation === "number") this.adopt(value as WeatherState);
      });
    } else {
      this.roll();
      net?.set(NET_WEATHER_KEY, this.state);
    }
    this.localAngle = this.state.windAngle;
    this.lastStrike = this.state.strike;
    this.sample();
  }

  /** A state off the wire: take it, and flash if it carries a strike we have not seen. */
  private adopt(state: WeatherState): void {
    const strike = state.strike ?? 0;
    this.state = state;
    if (strike !== this.lastStrike) {
      this.lastStrike = strike;
      this.onStrike();
    }
  }

  override onDispose(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    for (const kind of KINDS) {
      const id = this.emitters[kind];
      if (id) this.ctx.setParticles?.(id, { emitting: false, rate: 0 });
    }
    if (this.dust) this.ctx.setParticles?.(this.dust, { emitting: false, rate: 0 });
    for (const slot of KINDS) this.ctx.setSoundLoop?.(slot);
  }

  override onFixedUpdate(dt: number): void {
    const net = this.ctx.netState;
    const authority = !net || net.isAuthority();
    if (authority) this.drive(dt);
    this.sampleTimer -= dt;
    if (this.sampleTimer <= 0) {
      this.sampleTimer = 1;
      this.sample();
    }
    // Under the surface there is no weather, and this one is NOT eased. The
    // rest of this script fades over `fadeSeconds` because a change in the
    // weather is a front rolling in; going under water is not a change in the
    // weather, it is a roof. Easing it left a diver swimming through a
    // curtain of rain for ten seconds, which is the clearest possible way to
    // say the two systems have never met.
    const submerged = this.headUnderWater();
    // ease toward the targets: a change is a front rolling in, not a switch
    const k = Math.min(1, dt / Math.max(0.5, this.param<number>("fadeSeconds")));
    for (const kind of KINDS) {
      this.local[kind] += (this.target[kind] - this.local[kind]) * k;
      if (submerged) this.local[kind] = 0;
    }
    this.localStorm += (this.state.storm * this.state.precipitation - this.localStorm) * k;
    this.localDust += (this.dustShare - this.localDust) * k;
    // Gusts are the FAST layer and must not be smoothed into the slow one:
    // eased at `fadeSeconds` a gust arrives as a gentle swell, which is the
    // opposite of what a gust is.
    this.localWind += (this.state.wind - this.localWind) * Math.min(1, dt * 1.5);
    this.localAngle += angleDelta(this.localAngle, this.state.windAngle) * Math.min(1, dt * 0.5);
    if (this.flashAt >= 0) {
      this.flashAt += dt;
      if (this.flashAt > 0.62) this.flashAt = -1;
    }
    if (this.thunderIn >= 0) {
      this.thunderIn -= dt;
      if (this.thunderIn <= 0) {
        this.thunderIn = -1;
        const sounds = String(this.param<string>("thunder") ?? "")
          .split(",")
          .map((id) => id.trim())
          .filter(Boolean);
        const sound = sounds[Math.floor(Math.random() * sounds.length)];
        // A small detune stops two close strikes using the same source from
        // sounding copy-pasted; wider variation turns thunder into a cartoon.
        if (sound)
          this.ctx.playSound?.(sound, {
            volume: this.param<number>("thunderVolume"),
            positional: false,
            playbackRate: 0.94 + Math.random() * 0.12,
          });
      }
    }
    this.syncSound("rain", this.local.rain, "rainSound", "rainSoundVolume");
    this.syncSound("snow", this.local.snow, "snowSound", "snowSoundVolume");
    this.syncSound("sand", this.local.sand, "sandSound", "sandSoundVolume");
    this.apply();
  }

  /** Keep the ambient bed continuous while the front and biome blend breathe. */
  private syncSound(kind: WeatherKind, intensity: number, soundParam: string, volumeParam: string): void {
    const sound = String(this.param<string>(soundParam) ?? "").trim();
    const volume = Math.max(0, Math.min(1, intensity * this.param<number>(volumeParam)));
    this.ctx.setSoundLoop?.(kind, volume > 0.003 ? sound : undefined, { volume, positional: false });
  }

  /**
   * The authority's half: walk the current front, wander the wind, throw
   * lightning, publish. One state for the whole world.
   */
  private drive(dt: number): void {
    const net = this.ctx.netState;
    this.clock += dt;
    let publish = false;
    if (this.clock >= this.state.until) {
      this.roll();
      publish = true;
    }
    const front = this.front;
    const raw = front.span > 0 ? Math.max(0, (this.clock - front.start) / front.span) : 1;
    // A pinned front still ARRIVES — drizzle, build, break — it just never
    // reaches the taper: it is held in the plateau for as long as it is pinned.
    const u = Math.min(this.pinned ? 0.72 : 1, raw);
    const precipitation = front.peak > 0 ? front.peak * this.envelope(u) : 0;
    // A storm is the HEIGHT of a front, not the whole of it: the wind gets up
    // and the sky starts throwing things once the rain has actually broken.
    const share = front.peak > 0 ? precipitation / front.peak : 0;
    const storm = front.storm * smooth01((share - 0.5) / 0.3);
    this.state.precipitation = precipitation;
    this.state.storm = storm;
    // The wind wanders on its own clock, faster while it is blowing hard.
    const turn = (Math.PI * 2) / Math.max(12, this.param<number>("windTurnMinutes") * 60);
    this.state.windAngle = (this.state.windAngle + turn * dt * (0.4 + 1.6 * storm)) % (Math.PI * 2);
    // Gusting: two incommensurable sines, so it never finds a rhythm.
    const g = Math.max(0.2, this.param<number>("gustSeconds"));
    const t = this.clock;
    const gust = 0.5 + 0.3 * Math.sin((t / g) * Math.PI * 2) + 0.2 * Math.sin((t / (g * 0.37)) * Math.PI * 2);
    this.state.wind = Math.min(1, Math.max(0, storm * (0.45 + 0.55 * gust) + 0.12 * gust));
    // Lightning: a Poisson trickle whose rate is the storm itself.
    const perMinute = this.param<number>("lightning") * storm * storm;
    if (perMinute > 0 && Math.random() < (perMinute / 60) * dt) {
      this.state.strike = (this.state.strike + 1) % 1e6;
      this.lastStrike = this.state.strike;
      this.onStrike();
      publish = true; // a strike is an EVENT: it cannot wait for the next sync
    }
    if (!net) return;
    this.sinceSync += dt;
    if (publish || this.sinceSync >= this.param<number>("syncSeconds")) {
      this.sinceSync = 0;
      net.set(NET_WEATHER_KEY, { ...this.state });
    }
  }

  /**
   * A front's shape over its window, 0..1 of its peak.
   *
   * Arrive as a drizzle, spit for a while, break into a pour that breathes,
   * then ease off. The plateau is the part that matters: weather that ramps
   * smoothly from nothing to everything has no MOMENT in it, and the moment —
   * the few seconds where the drizzle turns into a downpour — is the thing
   * anyone actually notices.
   */
  private envelope(u: number): number {
    const drizzle = Math.min(0.9, Math.max(0, this.param<number>("drizzle")));
    if (u < 0.1) return drizzle * smooth01(u / 0.1);
    if (u < 0.32) return drizzle * (1 + 0.4 * ((u - 0.1) / 0.22));
    if (u < 0.46) return drizzle * 1.4 + (1 - drizzle * 1.4) * smooth01((u - 0.32) / 0.14);
    if (u < 0.74) return 0.88 + 0.12 * Math.sin(this.clock * 0.5); // a downpour is not steady
    return smooth01(1 - (u - 0.74) / 0.26);
  }

  /** The pinned mode: the console's if it set one, else the authored param. */
  private forceMode(): string {
    return (this.forcedMode ?? String(this.param<string>("force") ?? "auto")).toLowerCase();
  }

  /** The authority's dice: what FRONT the world gets for the next while. */
  private roll(): void {
    const force = this.forceMode();
    const minutes = Math.max(0.1, this.param<number>("changeMinutes"));
    let peak = 0;
    let storm = 0;
    if (force === "clear") {
      peak = 0;
    } else if (force === "drizzle") {
      peak = Math.max(0.12, this.param<number>("drizzle"));
      storm = 0;
    } else if (force === "light") {
      peak = 0.5;
      storm = 0.1;
    } else if (force === "storm") {
      peak = 1;
      storm = 0.85;
    } else if (Math.random() < this.param<number>("chance")) {
      peak = 0.4 + 0.6 * Math.random();
      const r = Math.random();
      storm = r * r;
    }
    const span = minutes * 60 * (0.6 + 0.8 * Math.random());
    const wasPinned = this.pinned;
    this.pinned = force !== "auto";
    // A pinned front must not restart every window: keep the clock it arrived
    // on, so re-rolling under a pin changes nothing anyone can see.
    const start = wasPinned && this.pinned ? this.front.start : this.clock;
    this.front = { peak, storm, start, span };
    this.state.until = this.clock + span;
  }

  /** Start the flash locally, and line up the thunder behind it. */
  private onStrike(): void {
    this.flashAt = 0;
    // Distance is sound's delay: close strikes crack, far ones rumble late.
    // A violent storm is overhead, so its strikes arrive sooner.
    this.thunderIn = 0.3 + Math.random() * 6 * (1 - 0.7 * this.state.storm);
  }

  /** True while this tab's player has its head under water (see the ease above). */
  private headUnderWater(): boolean {
    if (!this.ctx.waterAt) return false;
    const playerId = this.ctx.localPlayer?.() ?? this.ctx.findByTag("player")[0];
    const object = playerId ? this.ctx.getObject(playerId) : null;
    if (!object) return false;
    const head = object.position.y + this.param<number>("headHeight");
    const water = this.ctx.waterAt(object.position.x, head, object.position.z);
    return !!water && water.depth > 0;
  }

  /**
   * Where am I, really: the biome blend AROUND the local player, turned into
   * per-kind targets.
   *
   * Two things this gets right that reading one point did not, both reported
   * from play:
   *
   *  - **It averages over a disc** (`biomeRadius`). A gravel path, a rock
   *    shelf or a sandy clearing in the middle of a forest is not a desert,
   *    and weather that switches as you step onto one is worse than weather
   *    that never changes at all.
   *  - **It divides by ALL the weight, not just the weight it recognised.**
   *    The old code normalised over the classified biomes only, so standing
   *    somewhere 95% blight (in no list) and 5% crag gave sand = 5/5 = a FULL
   *    sandstorm off a sliver. That is the bug behind "a dust storm appears
   *    when I stand on a small patch".
   *
   * On top of that a look has to EARN the sky: `biomeMajority` is the share
   * below which it contributes nothing, ramping to full at about twice that.
   * Real borders still cross smoothly, because at a real border the shares
   * really do cross.
   */
  private sample(): void {
    const playerId = this.ctx.localPlayer?.() ?? this.ctx.findByTag("player")[0];
    const object = playerId ? this.ctx.getObject(playerId) : null;
    const p = this.state.precipitation;
    if (this.forcedKind) {
      this.target = { rain: 0, sand: 0, snow: 0 };
      this.target[this.forcedKind] = p;
      this.dustShare = this.forcedKind === "sand" ? 1 : 0;
      return;
    }
    const biomeAt = this.ctx.biomeAt;
    if (!object || !biomeAt) {
      // no world under us: precipitation falls as rain, whatever it is
      this.target = { rain: p, sand: 0, snow: 0 };
      this.dustShare = 0;
      return;
    }
    const here = biomeAt(object.position.x, object.position.z);
    if (!here) {
      this.target = { rain: p, sand: 0, snow: 0 };
      this.dustShare = 0;
      return;
    }
    const radius = Math.max(0, this.param<number>("biomeRadius"));
    const blend: Record<string, number> = {};
    let total = 0;
    const add = (at: BiomeAt | null): void => {
      if (!at) return;
      for (const [id, w] of Object.entries(at.weights)) {
        if (!(w > 0)) continue;
        const key = id.toLowerCase();
        blend[key] = (blend[key] ?? 0) + w;
        total += w;
      }
    };
    add(here);
    if (radius > 0) {
      // eight points on two rings: enough to drown a clearing, cheap enough
      // to run once a second next to everything else this script does
      for (const [dx, dz] of RING) {
        add(biomeAt(object.position.x + dx * radius, object.position.z + dz * radius));
      }
    }
    this.blendHere = blend;
    if (total <= 0) {
      this.target = { rain: p, sand: 0, snow: 0 };
      this.dustShare = 0;
      return;
    }
    const shareOf = (list: string): number => {
      const set = splitList(list);
      let sum = 0;
      for (const [id, w] of Object.entries(blend)) if (set.has(id)) sum += w;
      return sum / total;
    };
    // A sliver earns nothing; a majority earns all of it.
    const majority = Math.max(0.001, this.param<number>("biomeMajority"));
    const earned = (share: number): number => smooth01((share - majority) / majority);
    let rain = earned(shareOf(this.param<string>("rainBiomes")));
    let snow = earned(shareOf(this.param<string>("snowBiomes")));
    const sand = earned(shareOf(this.param<string>("sandBiomes")));
    this.dustShare = earned(shareOf(this.param<string>("dustBiomes")));
    // altitude wins over biome: cold enough up there for any rain to be snow
    const snowLine = this.param<number>("snowAbove");
    const aloft = Math.min(1, Math.max(0, (here.ground - snowLine) / 40));
    snow = Math.min(1, snow + rain * aloft);
    rain *= 1 - aloft;
    this.target = { rain: p * rain, sand: p * sand, snow: p * snow };
  }

  override onCommand(name: string, args: string[]): string | null {
    if (name === "lightning") {
      this.state.strike = (this.state.strike + 1) % 1e6;
      this.lastStrike = this.state.strike;
      this.onStrike();
      this.ctx.netState?.set(NET_WEATHER_KEY, { ...this.state });
      return "strike";
    }
    if (name === "wind") {
      if (args.length === 0) return this.windLine();
      const degrees = Number(args[0]);
      if (!Number.isFinite(degrees)) throw new Error("usage: /wind <degrees 0-360> [strength 0-1]");
      this.state.windAngle = ((((degrees * Math.PI) / 180) % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
      if (args[1] !== undefined) {
        const strength = Number(args[1]);
        if (!Number.isFinite(strength)) throw new Error("usage: /wind <degrees> [strength 0-1]");
        this.state.wind = Math.min(1, Math.max(0, strength));
      }
      this.ctx.netState?.set(NET_WEATHER_KEY, { ...this.state });
      return this.windLine();
    }
    const first = (args[0] ?? "").toLowerCase();
    if (!first || first === "status") return this.weatherLine();
    // what it falls as, regardless of the ground underfoot
    if (first === "rain" || first === "sand" || first === "snow") {
      this.forcedKind = first as WeatherKind;
      this.sample();
      return `falling as ${first} here, biome ignored — /weather biome to undo`;
    }
    if (first === "biome" || first === "unpin") {
      this.forcedKind = null;
      this.sample();
      return "falling as the biome says again";
    }
    const arrive = first === "front";
    const mode = arrive ? (args[1] ?? "storm").toLowerCase() : first;
    if (!["auto", "clear", "drizzle", "light", "storm"].includes(mode)) {
      throw new Error(`/weather ${mode}: expected auto, clear, drizzle, light, storm, front, rain, sand, snow or biome`);
    }
    this.forcedMode = mode === "auto" ? null : mode;
    this.clock = Math.max(this.clock, 0);
    this.roll();
    // A pinned front normally holds where it was; the console is asking for a
    // NEW one, either landed (default) or from its first drizzle (`front`).
    this.front.start = arrive ? this.clock : this.clock - this.front.span * 0.6;
    this.ctx.netState?.set(NET_WEATHER_KEY, { ...this.state });
    if (mode === "auto") return "weather rolling on its own again";
    return arrive ? `a ${mode} front is coming in — watch it build` : `${mode}${mode === "clear" ? "" : " overhead"}`;
  }

  /**
   * The WORLD wind, not the eased local copy: a command that sets it should
   * read back what it set, and the ease is a visual detail of the next second.
   */
  private windLine(): string {
    const degrees = Math.round((this.state.windAngle * 180) / Math.PI);
    const compass = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"][Math.round(degrees / 45) % 8];
    return `wind ${degrees}° (${compass}) · gust ${this.state.wind.toFixed(2)}`;
  }

  /**
   * What is actually falling HERE — and WHY, which is the line that matters:
   * "there is a sandstorm in this forest" is unanswerable without seeing the
   * blend the script decided from.
   */
  private weatherLine(): string {
    const parts: string[] = [];
    for (const kind of KINDS) if (this.local[kind] > 0.01) parts.push(`${kind} ${this.local[kind].toFixed(2)}`);
    const falling = parts.length > 0 ? parts.join(" · ") : "clear";
    const mode = this.forcedMode ?? String(this.param<string>("force") ?? "auto");
    const total = Object.values(this.blendHere).reduce((a, b) => a + b, 0) || 1;
    const ground = Object.entries(this.blendHere)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([id, w]) => `${id} ${(w / total).toFixed(2)}`)
      .join(" · ");
    return [
      `${falling} · storm ${this.localStorm.toFixed(2)} · ${this.windLine()}`,
      `world precipitation ${this.state.precipitation.toFixed(2)} · mode ${mode}${this.forcedKind ? ` · pinned to ${this.forcedKind}` : ""}`,
      `land within ${Math.round(this.param<number>("biomeRadius"))}m: ${ground || "unknown"}${this.localDust > 0.01 ? ` · dusty ${this.localDust.toFixed(2)}` : ""}`,
    ].join("\n");
  }

  private apply(): void {
    const setParticles = this.ctx.setParticles;
    const storm = this.localStorm;
    const gust = this.localWind;
    /**
     * How lit the falling stuff is.
     *
     * Particles are UNLIT — the batch draws with a basic material — so a
     * raindrop is exactly as white at midnight as at noon, and a night storm
     * came out as bright white scratches over a black world. Nothing about
     * the drop changes after dark; what changes is that there is no light on
     * it. The floor is not 0 because rain picks up the moon, a window, the
     * sky itself: black rain is as wrong as white rain.
     */
    const lit = 0.2 + 0.8 * (this.ctx.daylight?.() ?? 1);
    // The wind, as a unit vector in the ground plane. Every emitter is aimed
    // off this one vector, which is why the whole weather leans TOGETHER.
    const wx = Math.sin(this.localAngle);
    const wz = Math.cos(this.localAngle);
    if (setParticles) {
      const rainId = this.emitters.rain;
      if (rainId) {
        const rain = this.local.rain;
        // A drizzle drifts and a downpour drives: speed and lean both follow
        // the front, so the fall itself says how hard it is raining.
        const fall = this.param<number>("rainSpeed") * (0.55 + 0.45 * Math.min(1, rain * 1.4));
        const blow = this.param<number>("rainWind") * (0.25 + 0.75 * gust);
        this.setAim(rainId, wx * blow, -fall, wz * blow, 0.92, 1.08);
        setParticles(rainId, { emitting: rain > 0.02, rate: this.param<number>("rainRate") * rain, colorScale: lit });
      }
      const snowId = this.emitters.snow;
      if (snowId) {
        const snow = this.local.snow;
        // Snow has no fall speed worth the name — it goes where the air goes.
        this.setAim(snowId, wx * (0.6 + 4 * gust), -1.1, wz * (0.6 + 4 * gust), 0.5, 1.4);
        setParticles(snowId, { emitting: snow > 0.02, rate: this.param<number>("snowRate") * snow, colorScale: lit });
      }
      const sandId = this.emitters.sand;
      if (sandId) {
        const sand = this.local.sand;
        // Sand is ALL wind: it is not falling, it is being carried past you,
        // and the gust is what makes that read as chaos rather than as drift.
        const blow = 8 + 16 * gust;
        this.setAim(sandId, wx * blow, 0.08 * blow, wz * blow, 0.7, 1.3);
        setParticles(sandId, { emitting: sand > 0.02, rate: this.param<number>("sandRate") * sand * (0.5 + 0.9 * gust), colorScale: lit });
      }
      // Splashes: brightness only. Their rate belongs to the drops that land.
      for (const id of this.splashes) setParticles(id, { colorScale: lit });
      if (this.dust) {
        // The bank itself: slow, huge, low, and thickest at the height of the
        // storm. This is the part that takes your sightline — the grains are
        // only what tells you it is moving.
        //
        // It also runs with NO weather at all in bare country (`dustBiomes`):
        // a desert or a badlands canyon has nothing holding the ground down,
        // so there is always something in the air. That is a property of the
        // PLACE, not of the forecast — and it is only ever the bank, never
        // the lens overlay, which is a storm you are caught in.
        const sand = this.local.sand;
        const ambient = this.localDust * this.param<number>("ambientDust");
        const thick = Math.max(sand * (0.25 + 0.75 * storm), ambient);
        const drift = 3 + 7 * gust;
        this.setAim(this.dust, wx * drift, 0.25, wz * drift, 0.6, 1.4);
        setParticles(this.dust, { emitting: thick > 0.02, rate: this.param<number>("dustRate") * thick * (0.6 + 0.6 * gust), colorScale: lit });
      }
    }
    // The lens. A sandstorm is the one weather you are INSIDE: the bank of
    // quads can only ever be a cloud in front of you, so the grit that
    // actually sells it goes across the screen. Driven with the WORLD wind —
    // the renderer knows where the camera is pointing, this script does not.
    const setPostFx = this.ctx.setPostFx;
    if (setPostFx) {
      const grit = this.local.sand * (0.35 + 0.65 * gust) * this.param<number>("gritMax");
      setPostFx({
        sandstorm: {
          amount: Math.min(1, grit),
          wind: [wx, -0.05, wz],
          // The grit on the lens is lit by the same sky the grains are. A
          // night sandstorm is a black, roaring nothing, not beige daylight.
          color: scaleHex(TINTS.sand.color, lit),
        },
      });
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
    const sandDrive = this.local.sand;
    // Visibility is the whole point of a dust storm, and it has to SURGE —
    // steady murk is fog. The gust drives the fog as well as the grains.
    // Rain/snow and sand are weighted separately because they are not the
    // same order of magnitude — see the two params.
    const wetDrive = Math.max(this.local.rain, this.local.snow) * (0.4 + 0.6 * storm);
    const dustFog = sandDrive * (0.45 + 0.55 * gust) * (0.4 + 0.6 * storm);
    setSky({
      clouds: {
        // NOT 0.95. At near-total coverage the deck stops having shapes in it
        // and becomes one flat card the colour of the fog — measured, and the
        // reason a "full storm" sky read as weaker than an overcast one. 0.85
        // keeps the gaps that make it look like weather moving overhead.
        coverage: baseCoverage + (0.85 - baseCoverage) * Math.min(1, cloudDrive + sandDrive * 0.45),
        // and HARDER edges, not softer: soft cloud is haze, and haze is what
        // fog is already doing.
        softness: baseSoftness + (0.28 - baseSoftness) * Math.min(1, cloudDrive + sandDrive * 0.5),
      },
      fog: {
        density:
          baseDensity *
          (1 + this.param<number>("fogBoost") * wetDrive + this.param<number>("sandFog") * dustFog),
      },
      weather: {
        gloom: Math.min(1, this.param<number>("gloomMax") * cover * (1 + 0.5 * sandDrive)),
        tint: tint.color,
        tintAmount: tint.amount * cover,
        wind: 1 + this.param<number>("windMax") * storm * (0.5 + 0.5 * gust),
        // The deck greys as the front builds and goes near-black at the height
        // of a storm — the sky is the first thing anyone reads the weather off.
        // A sandstorm darkens it too, just less and for a different reason:
        // there is no cloud up there, but the sun is not getting through.
        cloudDark: Math.min(
          1,
          this.param<number>("cloudDarkMax") * (cloudDrive * (0.35 + 0.65 * storm) + sandDrive * 0.5 * (0.4 + 0.6 * storm)),
        ),
        flash: this.flashAt >= 0 ? strikeFlash(this.flashAt) : 0,
      },
    });
  }

  /**
   * Aim one emitter down a world vector, at that vector's own magnitude.
   *
   * Fresh arrays every call rather than two reused ones: the renderer copies
   * them into the emitter's own tuples immediately, but a host that KEPT what
   * it was handed would find all four emitters sharing one aim, and four small
   * arrays a tick is not a cost worth that.
   */
  private setAim(id: string, x: number, y: number, z: number, lo: number, hi: number): void {
    const speed = Math.hypot(x, y, z) || 1;
    this.ctx.setParticles?.(id, { direction: [x, y, z], speed: [speed * lo, speed * hi] });
  }
}

/**
 * Register the standard vocabulary. Pass the session's `events` registry (and
 * the asset library) so builtins that declare `static events` — the
 * character-sheet's request/response contracts — register them too; without
 * it a `to-authority` request has no declared direction and never leaves a
 * peer.
 */

/**
 * A swimmer's wake — declared, not drawn.
 *
 * The script's whole job is to say "this body is disturbing the surface here,
 * this wide, this much"; the renderer's world-space wake field
 * (`water-wake.ts`) simulates the ripples that push makes, and the WATER
 * material deforms itself with them. That split is the point. Three earlier
 * attempts gave the wake a shape of its own — a sheet of particles, a trail
 * ribbon, then foam painted into a mask — and each read as exactly that: a
 * puff of cloud, a too-thick strip, a decal. A wake is not a thing on the
 * water, it is the water moving, and it only looks right when the surface's
 * own geometry and lighting do it.
 *
 * Put it on the swimming body (or a sibling anchor, naming the body). It
 * writes `userData.wake` and nothing else.
 */
class SwimWake extends Script {
  static override scriptName = "swim-wake";
  static override params = {
    body: {
      default: "",
      description:
        "The swimming body. Blank means this entity itself, or its PARENT when this script rides on an " +
        "anchor beside a body that already carries a controller. A server rewrites the id when it clones " +
        "the body per player.",
    },
    radius: {
      default: 0.7,
      min: 0.05,
      max: 20,
      description: "Metres of surface the body disturbs. Roughly its own width; the field stretches it along the direction of travel.",
    },
    strength: {
      default: 0.8,
      min: 0,
      max: 1,
      description: "How hard a full-speed stroke pushes the surface down. The trail's length comes from how long the ripples take to die, not from here.",
    },
    speed: { default: 3.2, min: 0.1, max: 30, description: "Speed counted as full — match the controller's swimSpeed." },
    minSpeed: { default: 0.5, min: 0, max: 10, description: "Below this the body leaves no wake: floating still barely marks the surface." },
    idleStrength: {
      default: 0.12,
      min: 0,
      max: 1,
      description: "What a body treading water still leaves. Not zero: a person holding themselves up makes a patch of disturbed water.",
    },
    headDepth: {
      default: 0.45,
      min: 0.05,
      max: 5,
      description:
        "Metres the body's TOP may sink below the surface before it stops marking it, faded out over that " +
        "distance. Only a body AT the surface disturbs it: a diver is moving water around down there, not " +
        "displacing the surface, and a wake that followed one under was the most obviously wrong thing " +
        "about the effect.",
    },
  };

  private bodyId = "";
  private foot = 0.9;

  override onStart(): void {
    const named = this.param<string>("body");
    this.bodyId = named || (this.ctx.getEntity(this.entityId)?.components["collider"] ? this.entityId : this.ctx.getEntity(this.entityId)?.parent || this.entityId);
    const collider = this.ctx.getEntity(this.bodyId)?.components["collider"] as { size?: number[] } | undefined;
    const height = collider?.size?.[1];
    if (typeof height === "number" && height > 0) this.foot = height / 2;
  }

  override onDispose(): void {
    const object = this.ctx.getObject(this.bodyId);
    if (object) (object.userData as { wake?: unknown }).wake = undefined;
  }

  override onFixedUpdate(): void {
    const object = this.ctx.getObject(this.bodyId);
    if (!object || !this.ctx.waterAt) return;
    const ud = object.userData as {
      swimming?: string;
      wake?: { radius: number; strength: number; y: number };
    };
    const water = this.ctx.waterAt(object.position.x, object.position.y - this.foot, object.position.z);
    const velocity = this.ctx.sim?.getLinvel(this.bodyId) ?? null;
    const planar = velocity ? Math.hypot(velocity[0], velocity[2]) : 0;
    // How far the body's TOP is below the surface. A wake is water being
    // pushed OUT OF THE WAY at the surface; a body swimming a metre down is
    // displacing water that has a metre of water above it, and the surface
    // barely knows. Measured from the head and faded, so breaking the surface
    // and going back under is a wake building and dying, not a switch.
    const sunk = water ? water.surfaceY - (object.position.y + this.foot) : Infinity;
    const band = Math.max(0.05, this.param<number>("headDepth"));
    const surfaced = Math.max(0, Math.min(1, 1 - sunk / band));
    if (!water || ud.swimming !== "swimming" || surfaced <= 0) {
      ud.wake = undefined;
      return;
    }
    const full = Math.max(0.1, this.param<number>("speed"));
    const moving = Math.max(0, Math.min(1, (planar - this.param<number>("minSpeed")) / full));
    const strength =
      (this.param<number>("idleStrength") +
        (this.param<number>("strength") - this.param<number>("idleStrength")) * moving) *
      surfaced;
    ud.wake = { radius: this.param<number>("radius"), strength, y: water.surfaceY };
  }
}

export function registerBuiltinScripts(
  registry: ScriptRegistry,
  events?: EventRegistry,
  dataTypes?: DataTypeSink,
): void {
  const add = (cls: ScriptClass): void => registry.register(cls, events, dataTypes);
  add(DayNight);
  add(Weather);
  add(Spinner);
  add(Oscillator);
  add(PlayerController);
  add(Collectible);
  add(PlatformMover);
  add(Door);
  add(FaceTarget);
  add(Tweener);
  add(Damageable);
  add(ThirdPersonController);
  add(SwimWake);
  add(BoneSocket);
  // The standard enemy: terrain-aware chase/leash/return, no navmesh.
  add(MobBrain);
  // RPG progression + grid inventory: the authority's sheet and its client view.
  add(CharacterSheetScript);
  add(CharacterUi);
  add(EquipmentLook);
  add(WeaponStance);
}

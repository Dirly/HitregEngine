import * as THREE from "three/webgpu";

/** World-space triple, matching the physics package's `Vec3`. */
export type RigVec3 = [number, number, number];

/**
 * Sweep a sphere of `radius` from `from` to `to` and return the distance along
 * that segment at which it was stopped, or `null` for a clear run.
 *
 * Injected rather than imported so this module stays renderer-side: the host
 * hands over `sim.spherecast` (see `PhysicsSim`), a stub in tests, or nothing
 * at all in a scene with no physics.
 */
export type CameraSweep = (radius: number, from: RigVec3, to: RigVec3) => number | null;

/**
 * A scene's authored `camera.rig` block, structurally. Kept as a plain shape
 * rather than an import of the Zod type so this module has no opinion about
 * where the numbers came from — a test, a script, or the component.
 */
export interface AuthoredCameraRig {
  mode?: string;
  distance?: number;
  height?: number;
  pivotHeight?: number;
  shoulder?: number;
  minDistance?: number;
  maxDistance?: number;
  damping?: number;
  collision?: boolean;
  /** How far the player may angle the view up, in DEGREES. */
  lookUp?: number;
  /** How far the player may angle the view down, in DEGREES. */
  lookDown?: number;
}

export interface CameraRigConfig {
  /**
   * follow = free mouse-orbit around the target. chase = the boom sits behind
   * the target's own yaw and the mouse is left to gameplay.
   */
  mode: "follow" | "chase";
  /** Framing the author asked for; the wheel moves it, collision only shortens it. */
  distance: number;
  /**
   * Floor for the resolved boom — small on purpose. Backed into a corner, the
   * camera goes effectively FIRST PERSON rather than holding a third-person
   * distance from inside the wall: a boom floored at a metre with a wall
   * behind it fills the screen with masonry and shows the player nothing,
   * while a floored-at-a-handspan boom is a view from the character's own
   * head. `fadeTargetBelow` takes the body out of the shot on the way down.
   */
  minDistance: number;
  maxDistance: number;
  /** Pivot height above the target's origin — chest/shoulder height, not the feet. */
  height: number;
  /** Lateral pivot offset, +right. Over-the-shoulder framing; 0 is centred. */
  shoulder: number;
  /**
   * Orbit limits in radians. `pitch` is the eye's elevation above the pivot,
   * so `pitchMax` is how far the camera may rise (view angled DOWN) and
   * `pitchMin` how far it may drop (view angled UP).
   *
   * `pitchMin` is not just taste. Below `asin(-height / distance)` the eye is
   * under the ground, and collision then crushes the boom to first person for
   * as long as the player holds that angle — which reads as the camera being
   * stuck rather than as a look limit. Keep it shallow enough that the crush
   * is a squeeze, not a wall.
   */
  pitchMin: number;
  pitchMax: number;
  /** Radians per pixel of mouse movement. */
  lookSpeed: number;
  /** Sweep radius. Must exceed the near plane's half-diagonal or corners clip. */
  collisionRadius: number;
  /** Stop this far short of whatever the sweep hit. */
  skin: number;
  /** Pivot tracking rate, horizontal — higher is tighter. */
  followDamping: number;
  /**
   * Pivot tracking rate, vertical. Deliberately looser than the horizontal
   * one: a hill town is stairs and slopes, and a pivot that tracks Y as
   * tightly as XZ bobs once per step.
   */
  verticalDamping: number;
  /** Vertical jump treated as a teleport/fall rather than a step, in metres. */
  verticalSnap: number;
  /** Seconds the boom stays short after an obstruction clears. */
  recoverDelay: number;
  /** How fast the boom returns afterwards, m/s. Linear — an exponential crawl reads as lag. */
  recoverSpeed: number;
  /**
   * Rise over an obstruction instead of only shortening into it. This is what
   * a town needs: pulling the boom in against a house fills the screen with
   * masonry, while lifting the camera over the eaves keeps the character in
   * frame. Costs up to `LIFT_CANDIDATES.length` extra sweeps, and only on the
   * frames where the boom is actually compressed.
   */
  lift: boolean;
  /** Most the rig may add to the author's pitch while avoiding, in radians. */
  liftMax: number;
  /** Hide the followed body below this boom length (host-applied). */
  fadeTargetBelow: number;
}

export const DEFAULT_CAMERA_RIG: CameraRigConfig = {
  mode: "follow",
  distance: 7,
  minDistance: 0.25,
  maxDistance: 14,
  height: 1.6,
  shoulder: 0,
  pitchMin: -0.56, // ~32° of look-up
  pitchMax: 1.15, // ~66° of look-down
  lookSpeed: 0.0025,
  collisionRadius: 0.3,
  skin: 0.2,
  followDamping: 14,
  verticalDamping: 7,
  verticalSnap: 2.5,
  recoverDelay: 0.12,
  recoverSpeed: 12,
  lift: true,
  liftMax: 0.7,
  fadeTargetBelow: 1.2,
};

/** Extra pitch, in radians, tried in order when the boom is compressed. */
const LIFT_CANDIDATES = [0.22, 0.45, 0.7];
/**
 * Below this fraction of the wanted boom the rig looks for a way over — and a
 * lift is only taken if it gets back ABOVE that same fraction. Half-measures
 * are refused on purpose: tilting the camera skyward to buy 40cm against an
 * infinitely tall wall trades a clear shortened shot for a worse tilted one.
 */
const LIFT_TRIGGER = 0.75;
/** Rate the applied lift eases in and out at, radians per second. */
const LIFT_RATE = 2.6;
/** Pivot jump treated as a teleport (fast travel, respawn) rather than motion. */
const TELEPORT_SNAP = 12;

/**
 * Third-person camera rig: pivot, orbit, boom, collision and obstruction
 * avoidance in one place, driving a plain `THREE.PerspectiveCamera`.
 *
 * ## Why it owns the camera outright
 *
 * The rig this replaces was a hybrid: `camera-controls` owned rotation and
 * damped the orbit TARGET toward the player, while the host separately
 * measured clearance from the player's *true* position and called `dollyTo`
 * with the result. Those are two different origins. `camera-controls`
 * smooth-damps the target with `smoothTime` 0.25 s, so at a sprint (9.5 m/s in
 * the MMO scene) the pivot trailed the character by over two metres — and the
 * boom length computed against the character was then applied about a pivot
 * that far behind them. In open country the error is invisible. In a town
 * whose alleys are three metres wide it puts the camera through the wall the
 * sweep had just proved was clear, which is exactly the "buildings block the
 * view of the player" symptom.
 *
 * So the rig smooths the pivot itself and resolves collision against that same
 * smoothed pivot. There is one origin, and what the sweep proves is what the
 * camera gets.
 *
 * ## What it fixes beyond that
 *
 * - **Actors don't shove the camera.** The old sweep ran against every layer,
 *   so an NPC wandering behind the player slammed the boom to nothing. The
 *   host passes a sweep already masked to world/terrain (see `Layers`).
 * - **Lift over, not only in.** A boom that can only shorten ends up flat
 *   against a housefront. `LIFT_CANDIDATES` first tries rising over the
 *   obstruction, which keeps the character framed instead of the wall.
 * - **Hold before recovering.** Snap in, then hold, then return at a linear
 *   rate. Passing a row of market stalls used to yo-yo once per stall.
 * - **A floor under the boom, with a fade.** `minDistance` keeps the camera
 *   out of the character's head; `fadeTargetBelow` tells the host to hide the
 *   body when it gets that close anyway.
 *
 * The rig is deliberately free of DOM and of physics: input arrives as mouse
 * deltas, collision as a `CameraSweep`. That keeps it testable in Node and
 * lets both hosts — the editor's play mode and the published runtime — share
 * one implementation instead of the two that had already drifted apart.
 */
export class ThirdPersonCameraRig {
  readonly config: CameraRigConfig;

  /** Smoothed orbit pivot: everything — framing and collision — derives from it. */
  private readonly pivot = new THREE.Vector3();
  /** Where the pivot is headed this frame (target position + height/shoulder). */
  private readonly wanted = new THREE.Vector3();
  private yaw = 0;
  private pitch = -0.18;
  /** Author/player framing distance, before collision. */
  private wantedDistance: number;
  /** Resolved boom actually in use. */
  private boom: number;
  private holdTimer = 0;
  private lift = 0;
  private seeded = false;

  private readonly eye = new THREE.Vector3();
  private readonly dir = new THREE.Vector3();
  private readonly right = new THREE.Vector3();
  private readonly scratch = new THREE.Vector3();
  private readonly targetForward = new THREE.Vector3();
  private readonly from: RigVec3 = [0, 0, 0];
  private readonly to: RigVec3 = [0, 0, 0];

  constructor(config: Partial<CameraRigConfig> = {}) {
    this.config = { ...DEFAULT_CAMERA_RIG, ...config };
    this.wantedDistance = this.clampDistance(this.config.distance);
    this.boom = this.wantedDistance;
    this.pitch = clamp(this.pitch, this.config.pitchMin, this.config.pitchMax);
  }

  /** Replace config in place (a live scene edit re-reads the `camera` component). */
  configure(patch: Partial<CameraRigConfig>): void {
    Object.assign(this.config, patch);
    this.wantedDistance = this.clampDistance(this.wantedDistance);
    this.boom = Math.min(this.boom, this.wantedDistance);
  }

  /**
   * Mouse-look, in raw pixel deltas. Ignored in chase mode, where the target
   * steers.
   *
   * Sign convention, since getting it backwards is invisible in code and
   * instantly obvious in the hand: `pitch` is the elevation of the EYE above
   * the pivot, so looking DOWN means raising the camera. Pushing the mouse
   * forward (`dy` negative, the standard "look up") therefore has to LOWER the
   * pitch, and pulling it back raises it.
   */
  addLook(dx: number, dy: number): void {
    if (this.config.mode === "chase") return;
    this.yaw -= dx * this.config.lookSpeed;
    this.pitch = clamp(
      this.pitch + dy * this.config.lookSpeed,
      this.config.pitchMin,
      this.config.pitchMax,
    );
  }

  /** Wheel zoom. The framing the player WANTS; collision may still shorten it. */
  addZoom(delta: number): void {
    this.wantedDistance = this.clampDistance(this.wantedDistance + delta);
  }

  /** Jump straight to a framing distance (entering play with the author's `rig.distance`). */
  setDistance(distance: number): void {
    this.wantedDistance = this.clampDistance(distance);
  }

  /**
   * Set the orbit outright. `null` leaves an axis alone — the host seeds pitch
   * from the authored `rig.height` on entering play and leaves yaw to the
   * mouse, and a chase rig sets pitch once and lets the target own yaw.
   */
  setOrbit(yaw: number | null, pitch: number | null): void {
    if (yaw !== null) this.yaw = yaw;
    if (pitch !== null) this.pitch = clamp(pitch, this.config.pitchMin, this.config.pitchMax);
  }

  /**
   * Adopt a scene's authored `camera.rig` block.
   *
   * The one interesting conversion is `height`, which is an EYE elevation
   * while the rig orbits `pivotHeight` (the character's chest). The difference
   * between the two is therefore a PITCH, not a translation — which is why a
   * follow rig authored at height 3.1 over distance 7.5 now starts looking
   * gently down at the character instead of, as it did before, having its
   * `height` ignored outright. In chase the framing is rigid, so the authored
   * distance is horizontal, the height literal, and the boom is the
   * hypotenuse of the two.
   */
  applyAuthored(rig: AuthoredCameraRig): void {
    const mode = rig.mode === "chase" ? "chase" : "follow";
    const pivotHeight = rig.pivotHeight ?? DEFAULT_CAMERA_RIG.height;
    const minDistance = Math.max(0.05, rig.minDistance ?? DEFAULT_CAMERA_RIG.minDistance);
    const maxDistance = Math.max(minDistance, rig.maxDistance ?? DEFAULT_CAMERA_RIG.maxDistance);
    const framing = clamp(rig.distance ?? DEFAULT_CAMERA_RIG.distance, minDistance, maxDistance);
    const rise = (rig.height ?? 3.5) - pivotHeight;
    const pitch =
      mode === "chase" ? Math.atan2(rise, framing) : Math.asin(clamp(rise / framing, -1, 1));
    const boom = clamp(
      mode === "chase" ? Math.hypot(framing, rise) : framing,
      minDistance,
      maxDistance,
    );
    this.configure({
      mode,
      distance: boom,
      minDistance,
      maxDistance,
      height: pivotHeight,
      shoulder: rig.shoulder ?? DEFAULT_CAMERA_RIG.shoulder,
      followDamping: rig.damping ?? DEFAULT_CAMERA_RIG.followDamping,
      // a rigid chase boom that went hunting for a way over its target's
      // obstruction would fight whatever the target is doing; it only shortens
      lift: mode === "follow",
      ...(mode === "chase"
        ? { pitchMin: pitch, pitchMax: pitch }
        : {
            pitchMin: rig.lookUp === undefined ? DEFAULT_CAMERA_RIG.pitchMin : -degrees(rig.lookUp),
            pitchMax:
              rig.lookDown === undefined ? DEFAULT_CAMERA_RIG.pitchMax : degrees(rig.lookDown),
          }),
    });
    this.setDistance(boom);
    this.setOrbit(null, pitch);
  }

  get distance(): number {
    return this.boom;
  }

  get wantedFraming(): number {
    return this.wantedDistance;
  }

  get orbit(): { yaw: number; pitch: number } {
    return { yaw: this.yaw, pitch: this.pitch };
  }

  /**
   * True when the boom is short enough that the followed body would be drawn
   * as the inside of its own head. The host hides the model instead.
   */
  get targetObscured(): boolean {
    return this.boom < this.config.fadeTargetBelow;
  }

  /** Current eye position — valid after `update`. */
  getPosition(out = new THREE.Vector3()): THREE.Vector3 {
    return out.copy(this.eye);
  }

  /** Current look point (the pivot) — what the streamer and world map should focus. */
  getPivot(out = new THREE.Vector3()): THREE.Vector3 {
    return out.copy(this.pivot);
  }

  /**
   * Adopt the orbit a free camera was already sitting at, so entering play
   * doesn't cut. `pivot` is where the rig is about to look from.
   */
  alignFromCamera(camera: THREE.Camera, pivot: THREE.Vector3Like): void {
    this.scratch.set(camera.position.x - pivot.x, camera.position.y - pivot.y, camera.position.z - pivot.z);
    const len = this.scratch.length();
    if (len < 1e-4) return;
    this.scratch.divideScalar(len);
    this.yaw = Math.atan2(this.scratch.x, this.scratch.z);
    this.pitch = clamp(Math.asin(this.scratch.y), this.config.pitchMin, this.config.pitchMax);
  }

  /** Drop all smoothing on the next update — a teleport, a respawn, a scene swap. */
  reset(): void {
    this.seeded = false;
    this.holdTimer = 0;
    this.lift = 0;
    this.boom = this.wantedDistance;
  }

  /**
   * Advance one rendered frame and write the result into `camera`.
   *
   * `targetQuaternion` is only read in chase mode, where the boom follows the
   * target's own yaw (roll and pitch are dropped so the camera never tips with
   * a vehicle).
   */
  update(
    dt: number,
    targetPosition: THREE.Vector3Like,
    camera: THREE.Camera,
    sweep?: CameraSweep | null,
    targetQuaternion?: THREE.Quaternion | null,
  ): void {
    const cfg = this.config;

    // A non-finite target would poison the pivot, and every comparison against
    // a NaN pivot is false — including the teleport test that would otherwise
    // re-seed it. The camera would then be frozen for the rest of the session
    // with no way back. Hold the last good pose instead.
    if (
      !Number.isFinite(targetPosition.x) ||
      !Number.isFinite(targetPosition.y) ||
      !Number.isFinite(targetPosition.z)
    ) {
      return;
    }

    // 1. pivot. Horizontal and vertical smooth at different rates, and a big
    // jump snaps: a fast travel or a respawn is not motion to be followed.
    this.wanted.set(targetPosition.x, targetPosition.y + cfg.height, targetPosition.z);
    if (cfg.mode === "chase" && targetQuaternion) {
      this.targetForward.set(0, 0, -1).applyQuaternion(targetQuaternion);
      this.yaw = Math.atan2(-this.targetForward.x, -this.targetForward.z);
    }
    if (cfg.shoulder !== 0) {
      this.right.set(Math.cos(this.yaw), 0, -Math.sin(this.yaw));
      this.wanted.addScaledVector(this.right, cfg.shoulder);
    }
    if (!this.seeded || this.pivot.distanceTo(this.wanted) > TELEPORT_SNAP) {
      this.pivot.copy(this.wanted);
      this.seeded = true;
    } else {
      const kh = approach(cfg.followDamping, dt);
      this.pivot.x += (this.wanted.x - this.pivot.x) * kh;
      this.pivot.z += (this.wanted.z - this.pivot.z) * kh;
      const dy = this.wanted.y - this.pivot.y;
      this.pivot.y += Math.abs(dy) > cfg.verticalSnap ? dy : dy * approach(cfg.verticalDamping, dt);
    }

    // 2. boom direction and length, resolved against the SAME pivot.
    //
    // The decision to lift is made from the UNLIFTED direction, never from the
    // lifted one. Judging it from where the camera currently sits makes the
    // lift self-cancelling: risen over the eave, the shot is clear, so the
    // rig stops lifting, so the eave blocks again — the camera bobs over the
    // roofline at the ease rate for as long as you stand there.
    const wantedBoom = this.wantedDistance;
    const base = this.castBoom(this.pitch, wantedBoom, sweep);

    // 3. compressed against something? Try rising over it before accepting a
    // view of the wall. The chosen lift eases in and out rather than popping.
    let liftTarget = 0;
    if (cfg.lift && sweep && base < wantedBoom * LIFT_TRIGGER) {
      // smallest lift that actually restores the shot wins; if none does, keep
      // the honest compression rather than tilting for a marginal gain
      for (const extra of LIFT_CANDIDATES) {
        if (extra > cfg.liftMax) break;
        const candidatePitch = Math.min(this.pitch + extra, cfg.pitchMax);
        if (this.castBoom(candidatePitch, wantedBoom, sweep) >= wantedBoom * LIFT_TRIGGER) {
          liftTarget = extra;
          break;
        }
      }
    }
    const liftStep = LIFT_RATE * dt;
    this.lift += clamp(liftTarget - this.lift, -liftStep, liftStep);
    if (this.lift < 1e-3) this.lift = 0;
    // mid-ease the camera is at neither the base nor the candidate pitch, so
    // the boom has to be resolved where it actually is
    const resolved = this.lift === 0 ? base : this.castBoom(this.pitch + this.lift, wantedBoom, sweep);

    // 4. snap in, hold, then return at a fixed rate. Instant intrusion because
    // one frame inside a wall shows the player the world's backfaces; the hold
    // and the linear return because a street of market stalls otherwise
    // yo-yos the camera once per stall.
    if (resolved < this.boom) {
      this.boom = resolved;
      this.holdTimer = cfg.recoverDelay;
    } else if (resolved < wantedBoom && resolved <= this.boom + 1e-3) {
      // still pinned by the same obstruction, just not cutting further. The
      // hold has to refresh here too, or an obstruction that flickers in and
      // out (a fence, a colonnade, a row of market stalls seen edge-on)
      // outlives the hold every other frame and the boom yo-yos.
      this.holdTimer = cfg.recoverDelay;
    } else if (this.holdTimer > 0) {
      this.holdTimer -= dt;
    } else {
      this.boom = Math.min(resolved, this.boom + cfg.recoverSpeed * dt);
    }

    // 5. write the pose.
    this.directionFor(this.pitch + this.lift, this.dir);
    this.eye.copy(this.pivot).addScaledVector(this.dir, this.boom);
    camera.position.copy(this.eye);
    camera.up.set(0, 1, 0);
    camera.lookAt(this.pivot);
  }

  /** Longest clear boom along `pitch`, capped at `wanted`. */
  private castBoom(pitch: number, wanted: number, sweep?: CameraSweep | null): number {
    const cfg = this.config;
    if (!sweep) return wanted;
    this.directionFor(pitch, this.scratch);
    this.from[0] = this.pivot.x;
    this.from[1] = this.pivot.y;
    this.from[2] = this.pivot.z;
    this.to[0] = this.pivot.x + this.scratch.x * wanted;
    this.to[1] = this.pivot.y + this.scratch.y * wanted;
    this.to[2] = this.pivot.z + this.scratch.z * wanted;
    const hit = sweep(cfg.collisionRadius, this.from, this.to);
    if (hit === null) return wanted;
    // A sweep that starts already penetrating reports 0. That means the pivot
    // itself is inside geometry (clipped into a wall, a doorway thinner than
    // the probe), and the honest answer is the floor — not zero, which would
    // park the camera inside the character.
    return clamp(hit - cfg.skin, cfg.minDistance, wanted);
  }

  /** Unit vector from pivot toward the eye for a given pitch. */
  private directionFor(pitch: number, out: THREE.Vector3): THREE.Vector3 {
    const cp = Math.cos(pitch);
    return out.set(Math.sin(this.yaw) * cp, Math.sin(pitch), Math.cos(this.yaw) * cp);
  }

  private clampDistance(d: number): number {
    return clamp(d, this.config.minDistance, this.config.maxDistance);
  }
}

/**
 * Framerate-independent exponential approach factor.
 *
 * `1 - exp(-k·dt)` rather than `k·dt`: the naive form is a different amount of
 * smoothing at 30 fps than at 144, and this engine's frame times in a streamed
 * town swing between the two within a second.
 */
function approach(rate: number, dt: number): number {
  return 1 - Math.exp(-Math.max(0, rate) * Math.max(0, dt));
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** Author-facing look limits are degrees; the rig works in radians. */
function degrees(d: number): number {
  return (Math.abs(d) * Math.PI) / 180;
}

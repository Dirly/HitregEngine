import * as THREE from "three/webgpu";

/** World-space triple, matching the physics package's `Vec3`. */
export type RigVec3 = [number, number, number];

/**
 * Sweep a sphere of `radius` from `from` to `to` and return the distance along
 * that segment at which it was stopped, or `null` for a clear run.
 *
 * `fromInside` asks for a sweep that may START touching geometry and is only
 * stopped by what it moves INTO (Rapier's `stopAtPenetration: false`). Every
 * sweep the rig makes asks for it: its probes start at a pivot that may be
 * grazing a lintel or a jamb, and a sweep that treats a graze it is moving
 * AWAY from as a hit at distance 0 slams the camera into first person. Do not
 * lean on it for a DEEP overlap — Rapier's answer there is not dependable
 * (measured: a probe sunk two-thirds into a box and moving straight out of it
 * can still report 0), which is why the pivot is kept inside the body's own
 * collider by {@link fitRigToBody} rather than rescued by a sweep.
 *
 * Injected rather than imported so this module stays renderer-side: the host
 * hands over `sim.spherecast` (see `PhysicsSim`), a stub in tests, or nothing
 * at all in a scene with no physics.
 */
export type CameraSweep = (
  radius: number,
  from: RigVec3,
  to: RigVec3,
  fromInside?: boolean,
) => number | null;

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
  /** Flip the vertical mouse axis (flight-stick style). */
  invertY?: boolean;
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
   * Floor for the boom — small on purpose. It is both where the wheel stops
   * (FIRST PERSON, see `firstPersonBelow`) and where a squeezed boom ends up:
   * backed into a corner, a boom floored a metre out fills the screen with the
   * wall it is inside, while a handspan is a view from the character's head.
   */
  minDistance: number;
  maxDistance: number;
  /**
   * Pivot height above the target's ORIGIN — head/upper-chest height. Mind
   * where the origin is: a physics capsule is centred on its entity, so a
   * 1.8 m character whose origin is its capsule wants ~0.65 here, not 1.6.
   * A pivot above the body's own collider is a pivot nothing keeps out of
   * door lintels and ceilings.
   */
  height: number;
  /** Lateral pivot offset, +right. Over-the-shoulder framing; 0 is centred. */
  shoulder: number;
  /**
   * Orbit limits in radians. `pitch` is the eye's elevation above the pivot,
   * so `pitchMax` is how far the camera may rise (view angled DOWN) and
   * `pitchMin` how far it may drop (view angled UP). Past roughly
   * `asin(-pivot height over the ground / distance)` the eye meets the ground
   * and slides along it toward the character, which is how an MMO camera
   * looks at the sky; the band only decides how far that slide may go.
   */
  pitchMin: number;
  pitchMax: number;
  /** Radians per pixel of mouse movement. */
  lookSpeed: number;
  /** Flip the vertical mouse axis. Off = mouse forward looks UP. */
  invertY: boolean;
  /** Sweep radius. Must exceed the near plane's half-diagonal or corners clip. */
  collisionRadius: number;
  /** Stop this far short of whatever the sweep hit, on top of the radius. */
  skin: number;
  /**
   * Pivot tracking rate, horizontal — higher is tighter. Tight on purpose: the
   * lag is `speed / rate` metres, and a pivot that trails half a metre cuts
   * the corner of every doorway the character turns through.
   */
  followDamping: number;
  /**
   * Pivot tracking rate, vertical. Looser than the horizontal one: a hill
   * town is stairs and slopes, and a pivot that tracks Y as tightly as XZ
   * bobs once per step.
   */
  verticalDamping: number;
  /** Vertical jump treated as a teleport/fall rather than a step, in metres. */
  verticalSnap: number;
  /**
   * At or below this WANTED distance the rig is in first person: the wheel has
   * been rolled all the way in, the body is hidden, and the look band opens to
   * `firstPersonLook` because there is no boom left to bury in the ground.
   */
  firstPersonBelow: number;
  /** Look band in first person, radians either way. */
  firstPersonLook: number;
  /** How fast the wheel's target distance is approached, per second. */
  zoomDamping: number;
  /** Seconds the boom stays short after an obstruction clears. */
  recoverDelay: number;
  /**
   * The boom's return is proportional to the gap (`recoverRate`, per second),
   * so it settles rather than arriving at full speed, and capped at
   * `recoverSpeed` m/s so a long way back does not whip.
   */
  recoverRate: number;
  recoverSpeed: number;
  /**
   * How far ahead, in seconds, the rig looks along the target's motion and the
   * player's own orbit for something that is ABOUT to cut the boom — a door
   * lintel, a building corner — so it can start closing before it has to.
   * Without it every doorway is a one-frame, six-metre jump cut. 0 disables.
   */
  lookAhead: number;
  /** Hide the followed body below this boom length (host-applied). */
  fadeTargetBelow: number;
  /**
   * How fast a free look swings back behind the aim once something asks for
   * it ({@link ThirdPersonCameraRig.returnToAim}), per second — exponential,
   * so about 3/rate seconds to settle. 0 cuts straight back.
   */
  freeLookReturn: number;
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
  invertY: false,
  collisionRadius: 0.3,
  skin: 0.05,
  followDamping: 25,
  verticalDamping: 9,
  verticalSnap: 2.5,
  firstPersonBelow: 0.6,
  firstPersonLook: 1.4,
  zoomDamping: 12,
  recoverDelay: 0.3,
  recoverRate: 3.5,
  recoverSpeed: 9,
  lookAhead: 0.4,
  fadeTargetBelow: 1,
  freeLookReturn: 14,
};

/** Slowest the boom closes on a forecast at, m/s — a small gap still gets closed. */
const CLOSE_FLOOR = 3;
/** Slowest the boom returns at, m/s — so a proportional return actually arrives. */
const RECOVER_FLOOR = 1.2;
/** Rate a pitch left outside the band (zooming out of first person) returns at, rad/s. */
const BAND_RETURN_RATE = 2.5;
/** Below this much predicted travel AND turn the look-ahead is skipped outright. */
const LOOKAHEAD_MIN_TRAVEL = 0.12;
const LOOKAHEAD_MIN_TURN = 0.04;
/** Forecast points along the look-ahead. Spaced under a metre apart at a run. */
const LOOKAHEAD_SAMPLES = 3;
/** Most orbit the look-ahead will extrapolate, radians — a mouse flick is not a plan. */
const LOOKAHEAD_MAX_TURN = 0.5;
/** The body vanishes a little closer in than it comes back at, so it cannot flicker. */
const FADE_HYSTERESIS = 0.8;
/** Gap the pivot keeps from whatever stopped it on the way out from the target. */
const PIVOT_SKIN = 0.03;
/** Pivot jump treated as a teleport (fast travel, respawn) rather than motion. */
const TELEPORT_SNAP = 12;

/**
 * Third-person camera rig: pivot, orbit, boom and collision in one place,
 * driving a plain `THREE.PerspectiveCamera`. The model is the classic MMO
 * camera (EverQuest, WoW): the boom only ever SHORTENS, the wheel runs from a
 * wide shot all the way into first person, and nothing but the player's mouse
 * ever changes the angle.
 *
 * ## Why it owns the camera outright
 *
 * The rig this replaced was a hybrid: `camera-controls` owned rotation and
 * damped the orbit TARGET toward the player, while the host separately
 * measured clearance from the player's *true* position and called `dollyTo`
 * with the result. Two origins, over two metres apart at a sprint — so a boom
 * proved clear against the character was applied about a pivot that far
 * behind, through the housefront. The rig smooths the pivot itself and
 * resolves collision against that same pivot: one origin, and what the sweep
 * proves is what the camera gets.
 *
 * ## The rules that make it calm indoors
 *
 * - **The pivot is kept out of geometry.** A boom sweep that STARTS inside a
 *   lintel reports distance 0 and slams the camera into first person for as
 *   long as it lasts. Two guards: the host fits the pivot inside the body's
 *   own collider ({@link fitRigToBody} — physics then vouches for it), and the
 *   smoothed pivot is swept out from that un-lagged point every frame, so the
 *   lag cannot carry it through a door jamb the character turned around.
 * - **Only the mouse pitches the camera.** An earlier cut rose over
 *   obstructions by adding pitch of its own. Looking up drives the eye into
 *   the ground, the boom compressed, the rig "helpfully" rose — so pushing the
 *   mouse forward moved the view DOWN, which reads as an inverted axis, and in
 *   a doorway the same logic pumped the camera up and down. It is gone.
 * - **Snap in only when it must, ease in when it can see it coming.** One
 *   frame inside a wall shows the world's backfaces, so an actual intrusion is
 *   instant. But a look-ahead sweep from where the target is about to be finds
 *   the lintel a third of a second early, and the boom is mostly home by the
 *   time the hard limit arrives.
 * - **Hold, then settle back.** The return waits `recoverDelay`, then closes
 *   the gap proportionally. A colonnade or a row of market stalls otherwise
 *   yo-yos the camera once per post.
 * - **Actors don't shove the camera.** The host's sweep is masked to
 *   world/terrain (see `Layers`).
 *
 * The rig is deliberately free of DOM and of physics: input arrives as mouse
 * deltas, collision as a `CameraSweep`. That keeps it testable in Node and
 * lets both hosts — the editor's play mode and the published runtime — share
 * one implementation.
 */
export class ThirdPersonCameraRig {
  readonly config: CameraRigConfig;

  /** Smoothed orbit pivot: everything — framing and collision — derives from it. */
  private readonly pivot = new THREE.Vector3();
  /** Where the pivot is headed this frame (target position + height/shoulder). */
  private readonly wanted = new THREE.Vector3();
  /** The AIM: where gameplay faces and moves. The camera shows it plus any free look. */
  private yaw = 0;
  private pitch = -0.18;
  /**
   * Free-look offset from the aim (see {@link setFreeLook}). Held, the mouse
   * moves this instead of the aim; released, it STAYS — players park the
   * camera in front to look at their character — until {@link returnToAim}
   * decays it to zero.
   */
  private freeLook = false;
  private returning = false;
  private freeYaw = 0;
  private freePitch = 0;
  /** Where the wheel has asked the framing to go. */
  private zoomGoal: number;
  /** Framing distance in effect this frame — `zoomGoal`, smoothed. Before collision. */
  private wantedDistance: number;
  /** Resolved boom actually in use. */
  private boom: number;
  private holdTimer = 0;
  /** Speed of the current forecast-driven close, m/s. Latched for the episode. */
  private closeSpeed = 0;
  private seeded = false;
  private hidden = false;

  /** Target velocity and orbit rate, low-passed, feeding the look-ahead. */
  private readonly velocity = new THREE.Vector3();
  private readonly lastTarget = new THREE.Vector3();
  private lastYaw = 0;
  private yawRate = 0;

  private readonly eye = new THREE.Vector3();
  private readonly dir = new THREE.Vector3();
  private readonly right = new THREE.Vector3();
  private readonly scratch = new THREE.Vector3();
  private readonly ahead = new THREE.Vector3();
  private readonly probe = new THREE.Vector3();
  private readonly targetForward = new THREE.Vector3();
  private readonly from: RigVec3 = [0, 0, 0];
  private readonly to: RigVec3 = [0, 0, 0];

  constructor(config: Partial<CameraRigConfig> = {}) {
    this.config = { ...DEFAULT_CAMERA_RIG, ...config };
    this.zoomGoal = this.clampDistance(this.config.distance);
    this.wantedDistance = this.zoomGoal;
    this.boom = this.wantedDistance;
    this.pitch = clamp(this.pitch, this.config.pitchMin, this.config.pitchMax);
  }

  /** Replace config in place (a live scene edit re-reads the `camera` component). */
  configure(patch: Partial<CameraRigConfig>): void {
    Object.assign(this.config, patch);
    this.zoomGoal = this.clampDistance(this.zoomGoal);
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
   * pitch, and pulling it back raises it. `invertY` flips exactly that.
   */
  addLook(dx: number, dy: number): void {
    if (this.config.mode === "chase") return;
    const sign = this.config.invertY ? -1 : 1;
    if (this.freeLook) {
      // the view pitch (aim + offset) stays inside the band; the aim is untouched
      this.freeYaw -= dx * this.config.lookSpeed;
      const view = this.pitch + this.freePitch + sign * dy * this.config.lookSpeed;
      this.freePitch = clamp(view, this.bandMin(), this.bandMax()) - this.pitch;
      return;
    }
    // Turning the AIM from a parked free look takes the view as the aim
    // first (WoW's right-drag): the camera stays put, the character comes
    // round to face where it points, and the turn continues from there.
    if (this.freeYaw !== 0 || this.freePitch !== 0) {
      this.yaw += this.freeYaw;
      this.pitch += this.freePitch;
      this.freeYaw = this.freePitch = 0;
      this.returning = false;
    }
    this.yaw -= dx * this.config.lookSpeed;
    const next = this.pitch + sign * dy * this.config.lookSpeed;
    // A pitch still outside the band (it is eased back in after a zoom out of
    // first person) may move toward the band freely, never further out.
    this.pitch = clamp(
      next,
      Math.min(this.bandMin(), this.pitch),
      Math.max(this.bandMax(), this.pitch),
    );
  }

  /**
   * Free look: while on, the mouse orbits the CAMERA only — the aim gameplay
   * reads ({@link aimDirection}) stays where it was, so the character keeps
   * its heading while the player looks around it. Turning it off leaves the
   * camera where it was put, so a player can park it in front to admire their
   * character; {@link returnToAim} brings it back. Follow mode only: a chase
   * rig's yaw belongs to its target.
   */
  setFreeLook(on: boolean): void {
    if (on && this.config.mode === "chase") return;
    this.freeLook = on;
    if (on) this.returning = false;
  }

  /**
   * Swing a parked free look back behind the aim at `freeLookReturn`, the
   * short way round however far the player spun. The host calls it when the
   * player acts — moves, casts — because that is when they need to see ahead
   * again. Ignored while free look is held, and free when there is none.
   */
  returnToAim(): void {
    if (this.freeLook || (this.freeYaw === 0 && this.freePitch === 0)) return;
    this.freeYaw = angleDelta(this.freeYaw, 0);
    if (this.config.freeLookReturn <= 0) this.freeYaw = this.freePitch = 0;
    else this.returning = true;
  }

  /** True while the view is off the aim — held, or still swinging back. */
  get freeLooking(): boolean {
    return this.freeLook || this.freeYaw !== 0 || this.freePitch !== 0;
  }

  /**
   * Unit vector of the AIM, eye toward pivot — what movement and facing read
   * in place of the camera's own direction, which a free look turns away from
   * it. The same as the camera's direction whenever there is no free look.
   */
  aimDirection(out = new THREE.Vector3()): THREE.Vector3 {
    return this.directionFor(this.yaw, this.pitch, out).negate();
  }

  /**
   * Wheel zoom, in metres at the default framing. Scaled by the current
   * distance so a notch is a nudge up close and a stride far out — the same
   * number of clicks crosses either half of the range — and rolled all the way
   * in it lands in first person.
   */
  addZoom(delta: number): void {
    const scale = clamp(this.zoomGoal / DEFAULT_CAMERA_RIG.distance, 0.25, 2);
    this.zoomGoal = this.clampDistance(this.zoomGoal + delta * scale);
  }

  /** Jump straight to a framing distance (entering play with the author's `rig.distance`). */
  setDistance(distance: number): void {
    this.zoomGoal = this.clampDistance(distance);
    this.wantedDistance = this.zoomGoal;
  }

  /**
   * Set the orbit outright. `null` leaves an axis alone — the host seeds pitch
   * from the authored `rig.height` on entering play and leaves yaw to the
   * mouse, and a chase rig sets pitch once and lets the target own yaw.
   */
  setOrbit(yaw: number | null, pitch: number | null): void {
    if (yaw !== null) {
      this.yaw = yaw;
      this.lastYaw = yaw;
      this.yawRate = 0;
    }
    if (pitch !== null) this.pitch = clamp(pitch, this.bandMin(), this.bandMax());
  }

  /**
   * Adopt a scene's authored `camera.rig` block.
   *
   * The one interesting conversion is `height`, which is an EYE elevation
   * while the rig orbits `pivotHeight`. The difference between the two is
   * therefore a PITCH, not a translation — a follow rig authored at height 3.1
   * over distance 7.5 starts looking gently down at the character. In chase
   * the framing is rigid, so the authored distance is horizontal, the height
   * literal, and the boom is the hypotenuse of the two.
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
      invertY: rig.invertY ?? DEFAULT_CAMERA_RIG.invertY,
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

  /** Where the wheel has asked the framing to go (collision may still shorten it). */
  get wantedFraming(): number {
    return this.zoomGoal;
  }

  /** True once the wheel is rolled all the way in. */
  get firstPerson(): boolean {
    return this.config.mode === "follow" && this.zoomGoal <= this.config.firstPersonBelow;
  }

  get orbit(): { yaw: number; pitch: number } {
    return { yaw: this.yaw, pitch: this.pitch };
  }

  /**
   * True when the boom is short enough that the followed body would be drawn
   * as the inside of its own head. The host hides the model instead. It has
   * hysteresis — a boom hovering at the threshold would strobe the character.
   */
  get targetObscured(): boolean {
    return this.hidden;
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
    this.setOrbit(Math.atan2(this.scratch.x, this.scratch.z), Math.asin(this.scratch.y));
  }

  /** Drop all smoothing on the next update — a teleport, a respawn, a scene swap. */
  reset(): void {
    this.seeded = false;
    this.holdTimer = 0;
    this.closeSpeed = 0;
    this.wantedDistance = this.zoomGoal;
    this.boom = this.wantedDistance;
    this.velocity.set(0, 0, 0);
    this.yawRate = 0;
    this.lastYaw = this.yaw;
    this.freeLook = false;
    this.returning = false;
    this.freeYaw = this.freePitch = 0;
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
    // the orbit the CAMERA shows: the aim plus the free-look offset, which
    // decays back to nothing once something has asked for it
    if (this.returning) {
      const k = approach(cfg.freeLookReturn, dt);
      this.freeYaw -= this.freeYaw * k;
      this.freePitch -= this.freePitch * k;
      if (Math.abs(this.freeYaw) < 1e-3 && Math.abs(this.freePitch) < 1e-3) {
        this.freeYaw = this.freePitch = 0;
        this.returning = false;
      }
    }
    const viewYaw = this.yaw + this.freeYaw;
    if (cfg.shoulder !== 0) {
      this.right.set(Math.cos(viewYaw), 0, -Math.sin(viewYaw));
      this.wanted.addScaledVector(this.right, cfg.shoulder);
    }
    if (!this.seeded || this.pivot.distanceTo(this.wanted) > TELEPORT_SNAP) {
      this.pivot.copy(this.wanted);
      this.seeded = true;
      this.velocity.set(0, 0, 0);
      this.yawRate = 0;
    } else {
      const kh = approach(cfg.followDamping, dt);
      this.pivot.x += (this.wanted.x - this.pivot.x) * kh;
      this.pivot.z += (this.wanted.z - this.pivot.z) * kh;
      const dy = this.wanted.y - this.pivot.y;
      this.pivot.y += Math.abs(dy) > cfg.verticalSnap ? dy : dy * approach(cfg.verticalDamping, dt);
      if (dt > 1e-5) {
        // low-passed: one physics-step hitch must not read as a sprint
        const kv = approach(10, dt);
        this.velocity.x += ((targetPosition.x - this.lastTarget.x) / dt - this.velocity.x) * kv;
        this.velocity.y += ((targetPosition.y - this.lastTarget.y) / dt - this.velocity.y) * kv;
        this.velocity.z += ((targetPosition.z - this.lastTarget.z) / dt - this.velocity.z) * kv;
        this.yawRate += (angleDelta(viewYaw, this.lastYaw) / dt - this.yawRate) * kv;
      }
    }
    this.lastTarget.set(targetPosition.x, targetPosition.y, targetPosition.z);
    this.lastYaw = viewYaw;

    // 2. keep the pivot out of geometry. Where the pivot is HEADED sits inside
    // the body's own collider (the host fits it there), so physics vouches
    // for it; nothing vouches for the smoothed point trailing it around a door
    // jamb or still up under the ceiling of the stair it just came down. Walk
    // the probe from the one to the other and stop where the world does. The
    // worst a bad answer can do here is cancel the lag for a frame.
    if (sweep) {
      const reach = this.wanted.distanceTo(this.pivot);
      if (reach > 1e-3) {
        const hit = this.cast(sweep, this.wanted, this.pivot, true);
        if (hit !== null) {
          this.pivot.lerpVectors(this.wanted, this.pivot, Math.max(0, hit - PIVOT_SKIN) / reach);
        }
      }
    }

    // 3. the framing the player wants: the wheel's goal, approached smoothly,
    // and a pitch left outside the band by a zoom out of first person walked
    // back into it rather than snapped.
    this.wantedDistance += (this.zoomGoal - this.wantedDistance) * approach(cfg.zoomDamping, dt);
    if (Math.abs(this.zoomGoal - this.wantedDistance) < 1e-3) this.wantedDistance = this.zoomGoal;
    const bandStep = BAND_RETURN_RATE * dt;
    if (this.pitch < this.bandMin()) this.pitch = Math.min(this.bandMin(), this.pitch + bandStep);
    else if (this.pitch > this.bandMax()) this.pitch = Math.max(this.bandMax(), this.pitch - bandStep);
    const wantedBoom = this.wantedDistance;
    const viewPitch = this.pitch + this.freePitch;

    // 4. what the world allows. `hard` is the law: past it the eye is inside
    // something. The look-ahead asks the same question from where the target
    // and the orbit will be in `lookAhead` seconds, and is only ever a reason
    // to start closing early.
    this.directionFor(viewYaw, viewPitch, this.dir);
    const hard = this.castBoom(this.pivot, this.dir, wantedBoom, sweep);
    let limit = hard;
    if (sweep && cfg.lookAhead > 0) {
      const travel = this.velocity.length() * cfg.lookAhead;
      const turn = clamp(this.yawRate * cfg.lookAhead, -LOOKAHEAD_MAX_TURN, LOOKAHEAD_MAX_TURN);
      if (travel > LOOKAHEAD_MIN_TRAVEL || Math.abs(turn) > LOOKAHEAD_MIN_TURN) {
        // the target cannot run through a wall, so neither may its forecast
        let reach = 1;
        if (travel > 1e-4) {
          this.ahead.copy(this.pivot).addScaledVector(this.velocity, cfg.lookAhead);
          const hit = this.cast(sweep, this.pivot, this.ahead, true);
          if (hit !== null) reach = Math.max(0, hit - PIVOT_SKIN) / travel;
        }
        // Sampled ALONG the way, not only at the end of it: under a lintel the
        // boom is shortest for the metre just inside the door and longer again
        // beyond, so a single far sample walks straight past the minimum and
        // the hard limit still lands as a jump.
        for (let k = 1; k <= LOOKAHEAD_SAMPLES; k++) {
          const f = k / LOOKAHEAD_SAMPLES;
          this.ahead.copy(this.pivot).addScaledVector(this.velocity, cfg.lookAhead * Math.min(f, reach));
          this.directionFor(viewYaw + turn * f, viewPitch, this.scratch);
          limit = Math.min(limit, this.castBoom(this.ahead, this.scratch, wantedBoom, sweep));
        }
      }
    }

    // 5. move the boom. Intrusion is instant; a forecast is eased toward; the
    // way back waits out the hold and then settles.
    if (this.boom > hard) {
      this.boom = hard;
      this.holdTimer = cfg.recoverDelay;
    }
    if (this.boom > limit + 1e-3) {
      // Sized to ARRIVE as the obstruction does: the forecast is `lookAhead`
      // seconds out, so gap / lookAhead gets the boom home on time at a steady
      // speed. Latched at its highest for the episode — an exponential here
      // starts at 60 m/s across a doorway and reads as the jump cut it replaces.
      this.closeSpeed = Math.max(this.closeSpeed, (this.boom - limit) / cfg.lookAhead, CLOSE_FLOOR);
      this.boom = Math.max(limit, this.boom - this.closeSpeed * dt);
      this.holdTimer = cfg.recoverDelay;
    } else if (this.boom >= limit - 1e-3) {
      // pinned by an obstruction, just not cut further. The hold refreshes here
      // too, or one that flickers in and out (a fence, a colonnade) outlives
      // the hold every other frame. At rest against nothing there is no hold.
      if (limit < wantedBoom - 1e-3) this.holdTimer = cfg.recoverDelay;
    } else if (this.holdTimer > 0) {
      this.holdTimer -= dt;
    } else {
      const speed = clamp((limit - this.boom) * cfg.recoverRate, RECOVER_FLOOR, cfg.recoverSpeed);
      this.boom = Math.min(limit, this.boom + speed * dt);
    }

    if (this.boom <= limit + 1e-3) this.closeSpeed = 0;

    // 6. the body. Hidden in first person and whenever the boom is inside it.
    if (this.boom < cfg.fadeTargetBelow * FADE_HYSTERESIS) this.hidden = true;
    else if (this.boom >= cfg.fadeTargetBelow) this.hidden = false;

    // 7. write the pose.
    this.eye.copy(this.pivot).addScaledVector(this.dir, this.boom);
    camera.position.copy(this.eye);
    camera.up.set(0, 1, 0);
    camera.lookAt(this.pivot);
  }

  /** Longest clear boom from `origin` along `dir`, capped at `wanted`. */
  private castBoom(
    origin: THREE.Vector3,
    dir: THREE.Vector3,
    wanted: number,
    sweep?: CameraSweep | null,
  ): number {
    const cfg = this.config;
    if (!sweep) return wanted;
    this.probe.copy(origin).addScaledVector(dir, wanted);
    const hit = this.cast(sweep, origin, this.probe, true);
    if (hit === null) return wanted;
    return clamp(hit - cfg.skin, cfg.minDistance, wanted);
  }

  private cast(sweep: CameraSweep, a: THREE.Vector3, b: THREE.Vector3, fromInside: boolean): number | null {
    this.from[0] = a.x;
    this.from[1] = a.y;
    this.from[2] = a.z;
    this.to[0] = b.x;
    this.to[1] = b.y;
    this.to[2] = b.z;
    return sweep(this.config.collisionRadius, this.from, this.to, fromInside);
  }

  /** Unit vector from pivot toward the eye for a given orbit. */
  private directionFor(yaw: number, pitch: number, out: THREE.Vector3): THREE.Vector3 {
    const cp = Math.cos(pitch);
    return out.set(Math.sin(yaw) * cp, Math.sin(pitch), Math.cos(yaw) * cp);
  }

  private bandMin(): number {
    return this.firstPerson
      ? Math.min(this.config.pitchMin, -this.config.firstPersonLook)
      : this.config.pitchMin;
  }

  private bandMax(): number {
    return this.firstPerson
      ? Math.max(this.config.pitchMax, this.config.firstPersonLook)
      : this.config.pitchMax;
  }

  private clampDistance(d: number): number {
    return clamp(d, this.config.minDistance, this.config.maxDistance);
  }
}

/** The followed body's `collider` component, structurally — only what {@link fitRigToBody} reads. */
export interface RigBodyCollider {
  shape?: string;
  size?: readonly number[];
  offset?: readonly number[];
}

/**
 * Headroom kept between the pivot and the top of the body's collider, metres.
 * The probe radius, so the probe sphere AT the pivot never pokes out of the
 * top of the body: wherever the character fits, the start of every boom sweep
 * fits too, and "starts inside the lintel" cannot happen by construction.
 */
const PIVOT_HEADROOM = DEFAULT_CAMERA_RIG.collisionRadius;

/**
 * Keep a follow rig's pivot inside the body it follows.
 *
 * `pivotHeight` is measured from the target's ORIGIN and defaults to 1.6,
 * which assumes an origin at the feet. But a collider is centred on its entity
 * unless it is offset, so the usual capsule character has its origin at its
 * waist — and 1.6 above that is 0.7 m over its head, where nothing stops the
 * pivot entering a door lintel or a low ceiling. Physics keeps the collider out
 * of the world; a pivot inside the collider inherits that for free. (Measured
 * in the MMO town before this existed: every doorway put the pivot's probe in
 * the lintel, the boom sweep reported 0, and the camera slammed to first
 * person and back — the "janky entering buildings" report.)
 *
 * Only sized primitives are read (a cooked trimesh has no meaningful "top"),
 * and only in follow mode: a chase rig on a vehicle frames what it authored.
 */
export function fitRigToBody<T extends AuthoredCameraRig>(rig: T, collider?: RigBodyCollider | null): T {
  if (!collider || rig.mode === "chase") return rig;
  const sized = ["box", "sphere", "capsule", "cylinder"].includes(collider.shape ?? "");
  const size = collider.size;
  if (!sized || !size) return rig;
  const tall = collider.shape === "sphere" ? size[0] : size[1];
  if (tall === undefined || !(tall > 0)) return rig;
  const top = (collider.offset?.[1] ?? 0) + tall / 2;
  const pivotHeight = rig.pivotHeight ?? DEFAULT_CAMERA_RIG.height;
  const fitted = Math.min(pivotHeight, top - PIVOT_HEADROOM);
  return fitted === pivotHeight ? rig : { ...rig, pivotHeight: fitted };
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

/** Shortest signed difference between two angles. */
function angleDelta(a: number, b: number): number {
  let d = (a - b) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  else if (d < -Math.PI) d += Math.PI * 2;
  return d;
}

/** Author-facing look limits are degrees; the rig works in radians. */
function degrees(d: number): number {
  return (Math.abs(d) * Math.PI) / 180;
}

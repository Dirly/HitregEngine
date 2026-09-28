/**
 * Gait selection and playback rates — the arithmetic half of character
 * animation, kept in one place because two different things do it: the
 * `third-person-controller` running on a body you can see, and the dedicated
 * server picking the clip a remote player's body should show every other
 * client. When those two disagree you get a character that walks on your
 * screen and runs on everybody else's, so they share this file rather than
 * each carrying their own copy of the thresholds.
 *
 * Everything here is pure: no clips, no animator, no physics. The caller maps
 * a tier onto whatever clip its model actually shipped with.
 */

/** A locomotion tier. Airborne is decided separately — see {@link leavingGround}. */
export type Gait = "idle" | "walk" | "run" | "sprint";

export interface GaitTuning {
  walkSpeed: number;
  runSpeed: number;
  sprintSpeed: number;
}

const TIER: Record<Gait, number> = { idle: 0, walk: 1, run: 2, sprint: 3 };

/**
 * How far past a threshold a gait holds before giving it up, as a fraction of
 * the threshold itself. Without this a character travelling at almost exactly
 * a boundary — which is what running along a hillside does, since the ground
 * steals and returns a fraction of a metre per second every step — crossfades
 * between two clips several times a second. That churn is most of what reads
 * as "the animation is rough".
 */
export const GAIT_HYSTERESIS = 0.12;

/** Speed below which a character is standing still, whatever it is doing. */
export function idleThreshold(tuning: GaitTuning): number {
  return Math.max(0.15, tuning.walkSpeed * 0.35);
}

/**
 * The gait a body travelling at `speed` should play, biased to keep whatever
 * it is playing now: thresholds sit midway between the tuned speeds, and each
 * one moves against the previous gait by {@link GAIT_HYSTERESIS}.
 */
export function gaitFor(speed: number, tuning: GaitTuning, previous: Gait | null = null): Gait {
  const at = previous ? TIER[previous] : -1;
  // `tier` is the level ABOVE the threshold: already there means hold on to it
  // (lower the bar), below it means the bar is raised.
  const edge = (tier: number, threshold: number): number => {
    const band = Math.max(0.08, threshold * GAIT_HYSTERESIS);
    return at >= tier ? threshold - band : threshold + band;
  };
  if (speed < edge(1, idleThreshold(tuning))) return "idle";
  if (speed < edge(2, (tuning.walkSpeed + tuning.runSpeed) / 2)) return "walk";
  if (speed < edge(3, (tuning.runSpeed + tuning.sprintSpeed) / 2)) return "run";
  return "sprint";
}

/**
 * The speed to pick a gait FROM, when the game itself slows some directions
 * of travel: measured speed with that deliberate slow-down taken back out.
 *
 * A strafe or a backpedal moves at `sideSpeedMult` of the gait's speed by
 * design — 6.5 m/s × 0.65 = 4.2 in the MMO, which is under the walk/run
 * threshold. Read raw, every sideways RUN became a walk cycle played at 4×
 * and clamped at {@link RATE_MAX}: a scurry that still skated. The multiplier
 * is the player's own intent (run key vs walk key, which way they pushed), so
 * it is divided back out; anything ELSE slowing the body — a swamp, a wade, a
 * debuff, an AI — is still read as measured.
 */
export function gaitReadingSpeed(planarSpeed: number, directionMult: number): number {
  return directionMult > 0 && directionMult < 1 ? planarSpeed / directionMult : planarSpeed;
}

/** Ordering of the tiers — idle 0 through sprint 3. */
export function gaitTier(gait: Gait): number {
  return TIER[gait];
}

/** The speed each gait is tuned for — what a clip with no declared speed is assumed to depict. */
export function gaitSpeed(gait: Gait, tuning: GaitTuning): number {
  return gait === "walk" ? tuning.walkSpeed : gait === "sprint" ? tuning.sprintSpeed : tuning.runSpeed;
}

/**
 * Downward speed that means FALLING rather than following the ground down.
 *
 * A flat threshold cannot tell the two apart: a character running at 6.5 m/s
 * down a 30° slope is descending at 3.75 m/s while its feet never leave the
 * ground, and any constant low enough to catch a real drop is below that. So
 * the allowance scales with how fast the body is travelling — a slope can only
 * take you down as fast as you are going along it — and `slopeTolerance` is the
 * steepest descent counted as ground, as a ratio (1 = 45°).
 */
export function fallThreshold(
  planarSpeed: number,
  fallSpeed: number,
  slopeTolerance: number,
): number {
  return fallSpeed + Math.max(0, planarSpeed) * Math.max(0, slopeTolerance);
}

/** Velocity-only airborne evidence for one tick (see fallThreshold). */
export function leavingGround(
  vy: number,
  planarSpeed: number,
  fallSpeed: number,
  slopeTolerance: number,
): boolean {
  return vy > 0.8 || vy < -fallThreshold(planarSpeed, fallSpeed, slopeTolerance);
}

/**
 * Rate clamp for locomotion. The floor keeps a slowed character from reading
 * as slow motion; the ceiling is generous because a strafe or backpedal clip
 * is often authored at a walking pace while the game moves you at a run, and
 * a stride that is too quick still beats feet that slide.
 */
export const RATE_MIN = 0.6;
export const RATE_MAX = 2.5;

/** Playback rate that puts one stride on the ground per stride in the clip. */
export function playbackRate(travelSpeed: number, authoredSpeed: number): number {
  if (!(authoredSpeed > 0)) return 1;
  return Math.max(RATE_MIN, Math.min(RATE_MAX, travelSpeed / authoredSpeed));
}

/**
 * How far a one-shot action clip may be stretched or compressed to fill the
 * window its owner asked for. Past the floor it plays once at the floor and
 * HOLDS its last frame — never loops: a swing or a death that starts over is
 * the single most obvious animation bug there is. A pose that is meant to
 * repeat (a channel) says so with `actionLoop` and is never fitted at all.
 */
export const ACTION_RATE_MIN = 0.35;
export const ACTION_RATE_MAX = 3;

export interface ActionFit {
  /** Playback rate for the clip. */
  rate: number;
  /** Whether it has to repeat to cover the window. */
  loop: boolean;
}

/**
 * Fit a clip to an action's duration. A three-second cast played with a
 * one-second animation should be one slow cast, not the same second three
 * times — that repeat is the single most obvious tell that an animation was
 * bolted onto a timer. Where the window is longer than even the slowest
 * playback covers, it plays once at that floor and holds the last frame for
 * the rest, and where it is shorter the clip speeds up to land on time.
 *
 * An unknown duration (a model still loading, a headless host with no mixer)
 * falls back to the old behaviour rather than guessing.
 */
export function fitAction(clipDuration: number | null | undefined, window: number): ActionFit {
  if (!clipDuration || clipDuration <= 0 || !(window > 0)) return { rate: 1, loop: true };
  const rate = clipDuration / window;
  if (rate < ACTION_RATE_MIN) return { rate: ACTION_RATE_MIN, loop: false };
  if (rate > ACTION_RATE_MAX) return { rate: ACTION_RATE_MAX, loop: false };
  return { rate, loop: false };
}

/**
 * Whether a one-shot action rides on an upper-body layer (legs keep their
 * gait) or owns the whole body. Decided ONCE when the action starts — see the
 * controller — and mirrored by the server so a peer sees the same split.
 */
export function actionIsLayered(
  planarSpeed: number,
  tuning: Pick<GaitTuning, "walkSpeed">,
  opts: { blend?: string; fullBody?: boolean } = {},
): boolean {
  if (opts.fullBody === true || opts.blend === "full") return false;
  if (opts.blend === "layer") return true;
  return planarSpeed > Math.max(0.2, tuning.walkSpeed * 0.5);
}

/**
 * One body's gait over time: {@link gaitFor} plus the rule that a gait may
 * speed up at once but may not drop BACK inside the dwell window.
 *
 * Speeding up is the player's own input and has to answer immediately.
 * Dropping a tier moments after climbing out of it is never anything but
 * noise — a body hovering either side of a threshold, which is what running
 * along a hillside is — and every one of those flips costs a visible
 * crossfade. Both the local controller and the server's view of a remote
 * player keep one of these, so the two agree about what a body is doing.
 */
export class GaitTracker {
  gait: Gait = "idle";
  private at = -Infinity;
  /** +1 if the last change was a speed-up, -1 a slow-down, 0 for none yet. */
  private dir = 0;

  reset(): void {
    this.gait = "idle";
    this.at = -Infinity;
    this.dir = 0;
  }

  /** `now` and `dwell` are seconds. */
  step(speed: number, tuning: GaitTuning, now: number, dwell: number): Gait {
    const next = gaitFor(speed, tuning, this.gait);
    if (next === this.gait) return this.gait;
    const dir = TIER[next] > TIER[this.gait] ? 1 : -1;
    if (this.dir !== 0 && dir !== this.dir && now - this.at < dwell) return this.gait;
    this.gait = next;
    this.at = now;
    this.dir = dir;
    return next;
  }
}

/**
 * Vertical velocity that keeps a body ON the ground it is running over, or
 * null to leave the one it has.
 *
 * A body driven by setLinvel travels in a straight line, so every convex break
 * in the ground throws it off: at the crest of a hill it keeps going straight
 * while the ground drops away, and it is genuinely airborne for a third of a
 * second until gravity catches up. Measured on a 25° ramp at 6.5 m/s that was
 * half a second of the falling clip at every crest — and on terrain that
 * merely rolls, a character permanently half in the air. No clip-picking rule
 * can fix that, because the character really is airborne.
 *
 * So follow the surface: the vertical rate that keeps a body on a plane of
 * this normal, capped by the slope the character is allowed to walk, plus
 * whatever closes a gap the last break opened. Both the local controller and
 * the server's player driver run this — a client predicting the ground while
 * the authority arcs over it is worse than either alone.
 *
 * `gap` is how far the ground sits BELOW its resting distance (0 = contact).
 * `ours` says this body's current rise was written by this function last tick:
 * ours is ours to overwrite, anybody else's — a jump, a knockback, a launch
 * pad — has to survive untouched.
 *
 * `popCap` is the one exception to that, and it exists because of doorways. A
 * capsule run at a low lip — a threshold, a kerb, the first stair — is thrown
 * UP by the contact: its rounded foot has to climb the lip in the few
 * centimetres it takes to cross it, which at a run is several metres a second
 * of rise that nobody asked for. Measured in the MMO town: an 18 cm threshold
 * at 6.5 m/s leaves the solver with 3.9 m/s upward, and because that rise was
 * "somebody else's" it survived — a 0.78 m hop through every front door, head
 * first at the lintel, falling clip and all. So a rise faster than `popCap`
 * that is NOT ours, this close to the ground, is a collision artefact and is
 * CLIPPED to `popCap` — not zeroed: the body does have to rise the lip's
 * height to cross it, and zeroing the rise stalled it against every lip of a
 * voxel hillside. Climbing also suspends the gap pull (the gap is the lower
 * cell the capsule's axis is still over), and `step` lifts the body over a lip
 * the look-ahead ray saw before the capsule reaches it. Jump shaping and air
 * control live in {@link airGravityScale} / {@link airSteer}.
 * The caller keeps real lifts out of here: it
 * does not call this during a jump, nor while a script holds the body's
 * `liftUntil` channel.
 */
export function groundFollowVy(
  x: number,
  z: number,
  vy: number,
  normal: readonly [number, number, number],
  gap: number,
  opts: {
    stick: number;
    slopeTolerance: number;
    dt: number;
    ours: boolean;
    popCap?: number;
    /**
     * Metres the ground just AHEAD stands above the plane the body is
     * following — a lip to step up (see {@link readGround}). 0/absent = none.
     */
    step?: number;
    /** How far ahead that step was measured, metres. */
    stepReach?: number;
    /**
     * What this function returned last tick, if anything. A rise past it that
     * gravity cannot explain is contact lifting the body up a lip, even when
     * it is close enough to count as `ours`.
     */
    wrote?: number | null;
  },
): number | null {
  if (!(opts.stick > 0) || normal[1] <= 0.5 || gap > opts.stick) return null;
  const popCap = opts.popCap ?? 0;
  if (vy > 0.8 && !opts.ours) {
    if (!(popCap > 0) || vy <= popCap) return null;
  }
  const planar = Math.hypot(x, z);
  if (planar < 0.1) return null; // standing still: leave it to contact resolution
  const along = -(normal[0] * x + normal[2] * z) / normal[1];
  // Downhill is capped by slopeTolerance — that is what separates following a
  // descent from falling. Uphill gets the steepest ground the follow runs on
  // at all (normal.y > 0.5 is 60°): marching-cubes terrain puts 45-55° faces
  // on every little lip, and capping the climb at 39° there held the body's
  // rise below what the ground asked for, so it ground into the face and its
  // measured speed sank under the idle threshold — a creep in the idle pose.
  const cap = Math.max(1, planar * (along > 0 ? Math.max(opts.slopeTolerance, UPHILL_RATIO) : opts.slopeTolerance));
  let follow = Math.max(-cap, Math.min(cap, along));
  // Closing a gap pulls DOWN, and that is only ever right on the way down.
  // Climbing — the ground rising under the feet, or contact lifting the body
  // up a lip — the gap is the lower cell the centre is still over, and pulling
  // toward it drags the body back into the step it is climbing.
  const lifted = vy > 0.05 && (!opts.ours || (opts.wrote != null && vy > opts.wrote + 0.1));
  const climbing = along > 0.05 || lifted;
  if (gap > 0.02 && !climbing) follow -= Math.min(gap / Math.max(opts.dt, 1 / 240), cap);
  // A rise contact gave the body climbing a lip is kept, clipped to the pop
  // cap: zeroing it stalled the body against every voxel lip, letting it
  // through whole is the doorway hop.
  if (lifted) follow = Math.max(follow, popCap > 0 ? Math.min(vy, popCap) : vy);
  // Step up a lip seen ahead, proportionally to what is left of it — so it
  // lands level with the top instead of hopping over it.
  const step = opts.step ?? 0;
  const reach = opts.stepReach ?? 0;
  if (step > STEP_MIN && reach > 0) {
    follow = Math.max(follow, Math.min(STEP_RATE_MAX, (2 * step * planar) / reach));
  }
  return follow;
}

/** Steepest uphill ratio ground-following climbs at (≈56°, under the 60° walkable cut). */
export const UPHILL_RATIO = 1.5;
/** Lips lower than this are the capsule's own business. */
const STEP_MIN = 0.04;
/** Fastest a step-up lifts the body, m/s. */
export const STEP_RATE_MAX = 5;

/** A rise this body owes to {@link groundFollowVy} rather than to a jump. */
export function risingByGround(vy: number, wrote: number | null): boolean {
  return wrote !== null && Math.abs(vy - wrote) < 1;
}

/* -------------------------------------------------------------------------- */
/* Reading the ground under a capsule                                          */
/* -------------------------------------------------------------------------- */

/** One downward ray's answer: distance below the body's origin, and the surface normal. */
export interface GroundCast {
  distance: number;
  normal: readonly [number, number, number];
}

/** What {@link readGround} learned about the ground under and ahead of a body. */
export interface GroundReading {
  /** Nearest ground under the FOOTPRINT: the centre ray, or the ring when the centre is off the ground. */
  dist: number;
  /** The centre ray alone (Infinity on a miss). */
  centre: number;
  /** Normal of the ground the body stands on, or null over nothing. */
  normal: [number, number, number] | null;
  /** Metres the ground ahead stands above the plane being followed — a lip to step up; 0 for none. */
  step: number;
  /** How far ahead the step ray looked, metres (0 = it did not). */
  reach: number;
}

/** Past this gap under the centre the footprint ring is consulted. */
const RING_AFTER = 0.05;
/** Ring points sit this fraction of the collider radius out from the axis. */
const RING_FRACTION = 0.75;
/** How far past the collider's edge the step ray looks. */
const STEP_LOOK = 0.2;

/**
 * Read the ground under a capsule with more than one ray.
 *
 * One ray from the body's CENTRE is wrong exactly where a character most needs
 * it right: climbing a lip. The capsule's rounded foot is on the upper cell
 * while its axis is still over the lower one, so the centre ray reads the
 * ground as a lip's height further down than it is — past the probe's slack,
 * which after `coyoteTime` played the air clip on a body sliding up a bump.
 * On voxel terrain with a lip every few metres that was a character gliding
 * up every hill.
 *
 * So: the centre ray first (the common case, one query), and only when it
 * reports a gap, four more on a ring inside the footprint, oriented along
 * travel. The nearest of them is the ground the capsule is standing on.
 * Separately, when `stepHeight` > 0 and the body is moving, one ray a little
 * past the collider's leading edge measures how far the ground AHEAD stands
 * above the plane under the body — a lip to lift over before the capsule runs
 * into it (see {@link groundFollowVy}'s `step`).
 *
 * `cast(dx, dz)` casts one ray straight down from the body's origin offset by
 * (dx, dz); `rest` is the origin-to-feet distance, `radius` the collider's.
 * Pure — the controller and the dedicated server run the same one.
 */
export function readGround(
  cast: (dx: number, dz: number) => GroundCast | null,
  o: { rest: number; radius: number; dirX: number; dirZ: number; stepHeight: number; slack: number },
): GroundReading {
  const c = cast(0, 0);
  const centre = c ? c.distance : Infinity;
  let dist = centre;
  let normal: [number, number, number] | null = c ? [c.normal[0], c.normal[1], c.normal[2]] : null;
  const dirLen = Math.hypot(o.dirX, o.dirZ);
  const fx = dirLen > 1e-6 ? o.dirX / dirLen : 1;
  const fz = dirLen > 1e-6 ? o.dirZ / dirLen : 0;
  if (centre > o.rest + RING_AFTER && o.radius > 0) {
    const r = o.radius * RING_FRACTION;
    // forward, back, left, right of travel
    const ring: Array<[number, number]> = [
      [fx * r, fz * r],
      [-fx * r, -fz * r],
      [-fz * r, fx * r],
      [fz * r, -fx * r],
    ];
    let best: GroundCast | null = null;
    for (const [dx, dz] of ring) {
      const hit = cast(dx, dz);
      if (hit && hit.distance < dist) {
        dist = hit.distance;
        best = hit;
      }
    }
    // the centre is off the ground the body stands on: take the footing's normal
    if (best && !(centre <= o.rest + o.slack)) normal = [best.normal[0], best.normal[1], best.normal[2]];
  }
  let step = 0;
  let reach = 0;
  if (o.stepHeight > 0 && dirLen > 1e-6 && Number.isFinite(dist)) {
    reach = o.radius + STEP_LOOK;
    const ahead = cast(fx * reach, fz * reach);
    if (ahead && ahead.normal[1] > 0.5) {
      // where a plane of this normal would put the ground ahead, from here
      const n = normal && normal[1] > 0.5 ? normal : ([0, 1, 0] as const);
      const expected = o.rest + (n[0] * fx * reach + n[2] * fz * reach) / n[1];
      const rise = expected - ahead.distance;
      if (rise > 0 && rise <= o.stepHeight) step = rise;
    }
  }
  return { dist, centre, normal, step, reach };
}

/**
 * Is the probe's reading evidence of LEAVING the ground this tick?
 *
 * Rising is not, by itself: a body running up a hill, or being lifted over a
 * lip by contact, rises with its feet on the ground, and the old rule — any
 * rise we did not write ourselves is airborne — read every such climb as a
 * jump. Only a rise somebody LAUNCHED (this body's own jump, or a script
 * holding `liftUntil`) is. A climb gets the ground-stick distance as its slack
 * instead of the tighter contact slack: a body going UP cannot be falling.
 */
export function probeLeaving(p: {
  dist: number;
  rest: number;
  slack: number;
  stick: number;
  vy: number;
  launched: boolean;
}): boolean {
  if (p.launched && p.vy > 0.8) return true;
  const slack = p.vy > 0.3 && !p.launched ? Math.max(p.slack, p.stick) : p.slack;
  return p.dist > p.rest + slack;
}

/* -------------------------------------------------------------------------- */
/* Jumps and air                                                               */
/* -------------------------------------------------------------------------- */

/** The gravity the physics world runs at (packages/physics sim default), m/s². */
export const STANDARD_GRAVITY = 9.81;

/**
 * How a jump is shaped. The multipliers are multiples of world gravity for the
 * body while airborne; the controller adds the difference on top of the sim's
 * own gravity each fixed tick, so it is per-character and runs identically on
 * the dedicated server.
 */
export interface JumpTuning {
  /** Take-off velocity, m/s. */
  jump: number;
  /** Gravity while rising with the jump key held. */
  riseGravity: number;
  /** Gravity once falling (any fall, not only a jump's). */
  fallGravity: number;
  /** Gravity while still rising after the jump key was let go — the short hop. */
  cutGravity: number;
}

/**
 * Gravity multiple for one airborne tick. Falling is always `fallGravity` —
 * a heavy fall is most of what makes a jump read as snappy rather than floaty.
 * Rising is only shaped for this body's OWN jump: a launch pad or a knockback
 * keeps plain gravity, so whoever launched it gets the arc they asked for.
 */
export function airGravityScale(vy: number, jumping: boolean, held: boolean, t: Omit<JumpTuning, "jump">): number {
  if (vy <= 0) return t.fallGravity;
  if (!jumping) return 1;
  return held ? t.riseGravity : Math.max(t.riseGravity, t.cutGravity);
}

/**
 * Velocity change for one tick that turns the sim's own gravity into `scale`
 * of it. The sim already applies 1×, so this is only the difference.
 */
export function extraGravityDv(scale: number, dt: number, g = STANDARD_GRAVITY): number {
  return -(scale - 1) * g * dt;
}

/** Approach rate (1/s) of the air steer at airControl = 1 — about ground-like. */
export const AIR_RESPONSE = 12;

/**
 * Horizontal velocity for an airborne tick: momentum carries, the stick only
 * NUDGES it. Writing the full gait velocity every airborne tick (what the
 * controller used to do) is a character that can reverse in mid-air — the
 * other half of floaty. `airControl` 0 is pure momentum, 1 near-full control.
 * With no input the body keeps what it has.
 */
export function airSteer(
  vx: number,
  vz: number,
  wantX: number,
  wantZ: number,
  steering: boolean,
  airControl: number,
  dt: number,
): [number, number] {
  if (!steering) return [vx, vz];
  const k = 1 - Math.exp(-Math.max(0, airControl) * AIR_RESPONSE * dt);
  return [vx + (wantX - vx) * k, vz + (wantZ - vz) * k];
}

/**
 * The arc a jump flies on flat ground, integrated at the fixed step exactly as
 * the controller + sim do it (the take-off tick at plain gravity, extra gravity
 * from the next one). `holdFor` is how long the key stays down (Infinity = the
 * whole jump). Returns the apex height and the time back on the ground.
 */
export function jumpArc(t: JumpTuning, opts: { dt?: number; holdFor?: number } = {}): { apex: number; airtime: number } {
  const dt = opts.dt ?? 1 / 60;
  const holdFor = opts.holdFor ?? Infinity;
  let vy = t.jump;
  let y = 0;
  let apex = 0;
  let time = 0;
  let first = true;
  while (time < 10) {
    if (!first) vy += extraGravityDv(airGravityScale(vy, vy > 0, time < holdFor, t), dt);
    first = false;
    vy -= STANDARD_GRAVITY * dt; // the sim's own step
    y += vy * dt;
    time += dt;
    apex = Math.max(apex, y);
    if (y <= 0) break;
  }
  return { apex, airtime: time };
}

/** Exponential smoothing that behaves the same at any tick rate. */
export function damp(current: number, target: number, rate: number, dt: number): number {
  if (!(rate > 0)) return target;
  return target + (current - target) * Math.exp(-rate * dt);
}

/* -------------------------------------------------------------------------- */
/* Swimming                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Where a body is with respect to water. Three states, not two, because the
 * middle one is most of what a shoreline is: standing in the shallows is
 * neither swimming nor dry land, and a controller that only knows the two
 * either has you swimming in ankle-deep water or walking along the bottom of a
 * lake.
 */
export type SwimState = "dry" | "wading" | "swimming";

export interface SwimTuning {
  /** Water over the FEET at which the body leaves the ground and swims. */
  enterDepth: number;
  /** Water over the feet at which a swimmer's feet find the bottom again. Below `enterDepth` — the gap is the hysteresis. */
  exitDepth: number;
  /**
   * Water over the FEET a floating body settles at: how deep it rides.
   *
   * It belongs to the CLIPS, not to the character. An animation library
   * authors its swim cycles with the waterline at the model's root — measured
   * on the one this engine uses: the crawl's chest sits at 0.00 and its head
   * at 0.12 above the root, the tread's hip at -0.31 — so those want a line of
   * about a hand's depth. A model with no swim clips, swimming on its RUN
   * cycle, is posed standing on the ground instead and has to sink to its
   * chest (about 1.15) or it floats out of the water to the waist.
   */
  floatDepth: number;
  /** How hard the body is pulled back to the float line, 1/s. */
  buoyancy: number;
  /** Fastest deliberate rise or dive, m/s. */
  climbSpeed: number;
}

/**
 * The state a body in water is in, biased to keep the one it has.
 *
 * Two different measurements, because entering and leaving are two different
 * questions. You START swimming when the water over your FEET is deeper than
 * you can stand in — that is a fact about a body standing on the bottom. You
 * STOP when the water HERE is shallow enough to stand in, which has to be
 * measured to the bed: a floating body's feet hang at its own float line, so
 * asking "how deep is the water over my feet" of a swimmer just reads the
 * float line back and says whatever that number happens to compare to. (It
 * did, once: a shallower line for a stroking body made every swimmer's feet
 * "find the bottom" the moment it started swimming, in any depth of water.)
 *
 * The bias is the other half. Without it a swimmer bobbing on its own float
 * line crosses the threshold several times a second, and every crossing is a
 * mode switch that hands the body back to gravity and the ground probe for a
 * tick — a character stuttering at the waterline, the classic tell of a swim
 * mode bolted onto a walk controller.
 *
 * `feetDepth` is negative in the air above the surface; both are metres, so
 * the numbers mean what they say: 1.35 is "water up to the chest of a person".
 */
export function swimStateFor(
  feetDepth: number,
  waterDepth: number,
  previous: SwimState,
  tuning: SwimTuning,
): SwimState {
  if (feetDepth <= 0) return "dry";
  if (previous === "swimming") return waterDepth > tuning.exitDepth ? "swimming" : "wading";
  return feetDepth >= tuning.enterDepth ? "swimming" : "wading";
}

/**
 * Vertical velocity for a swimming body: deliberate rise/dive if the player
 * asked for one, otherwise buoyancy toward the float line.
 *
 * Buoyancy is PROPORTIONAL to how far off the line the body is rather than a
 * constant push, because a constant one can only overshoot: a body shoved up
 * at a fixed speed leaps clear of the surface, falls back, and the pair make a
 * bob that never settles. Being proportional it is also already smooth, which
 * is why the result is commanded rather than eased into (see below).
 *
 * `request` is a vertical SPEED in m/s — what the swimmer is asking for, which
 * is where it is pointed times how fast it swims (see {@link swimAim}) plus
 * whatever the rise/dive keys add. Null, or near zero, hands the body back to
 * buoyancy. The result is the vertical velocity to COMMAND this tick; the
 * body's current `vy` is deliberately not an input, see the note at the return.
 */
export function swimVy(depth: number, request: number | null, tuning: SwimTuning): number {
  const climb = Math.max(0, tuning.climbSpeed);
  let target: number;
  if (request !== null && (request > 0.01 || request < -0.01)) {
    target = request;
    // Swimming UP stops AT the waterline. A body still rising when its feet
    // clear the surface leaves the water under its own power, and what the
    // player sees is their character hopping out of a lake — measured, and
    // reported as "I can jump out if I swim up to the top, which looks odd".
    // The rise fades out over the float line itself rather than half a metre
    // past it, so breaking the surface is a push against a ceiling, not a
    // launch. (Momentum cannot carry it either: this is a COMMANDED velocity.)
    if (target > 0) {
      target *= Math.max(0, Math.min(1, depth / Math.max(0.05, tuning.floatDepth)));
    }
  } else {
    // positive `error` = too deep, so rise
    const error = depth - tuning.floatDepth;
    target = Math.max(-climb, Math.min(climb, error * Math.max(0, tuning.buoyancy)));
  }
  // COMMANDED, not damped toward. The body is a dynamic rigidbody, so every
  // tick the solver adds another step of gravity to `vy` before this function
  // ever sees it; easing toward the target from that polluted reading leaves a
  // standing error, because the ease only ever cancels part of the tick's
  // gravity. Measured: a body floating 24 cm below its own float line and
  // sitting there — with the buoyancy asking, correctly and uselessly, for
  // 0.7 m/s of rise. The target is already smooth (it goes to zero at the
  // line), and the rest of this controller commands velocity outright too.
  return target;
}

/** Where a swimmer is pointed, and how fast it is going there. */
export interface SwimAim {
  /** World velocity to swim at, [x, y, z]. */
  velocity: [number, number, number];
  /** Body pitch in radians, nose-down positive — what the visual takes on. */
  pitch: number;
  /** The vertical part of `velocity`, which is what a peer's authority is sent. */
  vertical: number;
}

/**
 * Aim a swimmer along the way the player is LOOKING, the way every
 * third-person game with swimming in it does: hold forward with the camera
 * tipped down and the character swims down, body pitched along its travel.
 *
 * This is what makes diving discoverable. A dive key alone is a control nobody
 * finds — the first thing a player does in deep water is point the camera at
 * the bottom and push forward, and if that swims them along the surface the
 * game has told them, wrongly, that it cannot be done.
 *
 * Strafe stays horizontal (you do not roll sideways to swim sideways), so the
 * pitch comes from the forward part alone. `climb` is the deliberate rise/dive
 * the keys add on top, in m/s, and it steepens the pose as well as the path —
 * pressing dive while swimming level still tips the nose down.
 */
export function swimAim(
  view: readonly [number, number, number],
  forward: number,
  strafe: number,
  speed: number,
  climb: number,
  maxPitch: number,
): SwimAim {
  const flat = Math.hypot(view[0], view[2]) || 1e-6;
  // right = the view's horizontal, rotated -90° about Y
  const rx = -view[2] / flat;
  const rz = view[0] / flat;
  let x = view[0] * forward + rx * strafe;
  let y = view[1] * forward;
  let z = view[2] * forward + rz * strafe;
  const length = Math.hypot(x, y, z);
  if (length > 1e-6) {
    x = (x / length) * speed;
    y = (y / length) * speed;
    z = (z / length) * speed;
  } else {
    x = y = z = 0;
  }
  const vertical = y + climb;
  // The pose follows the whole movement, climb included, but never past the
  // cap: a body pointed straight down reads as a torpedo, not a swimmer.
  const travel = Math.hypot(x, z);
  const pitch = Math.max(-maxPitch, Math.min(maxPitch, -Math.atan2(vertical, Math.max(travel, 0.001))));
  return { velocity: [x, vertical, z], pitch, vertical };
}

/**
 * Whether a swimming body is STROKING or treading water — the swim equivalent
 * of the gait ladder, and deliberately just the two: a swim cycle played at a
 * rate that tracks the speed covers everything between them.
 *
 * Both inputs are the player's own INTENT, never the body's measured vertical
 * velocity, and that is not a detail. The pose picks the float line
 * ({@link floatLine}), the float line drives `vy`, so a pose chosen from `vy`
 * closes a loop: at the surface a treading body sinks toward the deeper line,
 * sinking fast enough reads as stroking, the shallower line pulls it back up,
 * rising reads as stroking too — a body that oscillates at the waterline
 * forever with its clips flickering between the two. Measured, then fixed by
 * this signature. Intent comes from outside the loop and cannot do that.
 *
 * `dive` is the vertical request, -1 (down) to +1 (up): a body going straight
 * down with no horizontal speed is swimming, not treading water.
 */
export function swimming(planarSpeed: number, dive: number, swimSpeed: number): "stroke" | "tread" {
  if (dive > 0.01 || dive < -0.01) return "stroke";
  return planarSpeed > Math.max(0.35, swimSpeed * 0.15) ? "stroke" : "tread";
}

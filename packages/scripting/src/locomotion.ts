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
 * window its owner asked for. Past the floor the clip is looped instead: a
 * two-second channel pose spread over thirty seconds is not slow, it is
 * stopped.
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
 * playback covers, it loops (slowly), and where it is shorter the clip speeds
 * up to land on time.
 *
 * An unknown duration (a model still loading, a headless host with no mixer)
 * falls back to the old behaviour rather than guessing.
 */
export function fitAction(clipDuration: number | null | undefined, window: number): ActionFit {
  if (!clipDuration || clipDuration <= 0 || !(window > 0)) return { rate: 1, loop: true };
  const rate = clipDuration / window;
  if (rate < ACTION_RATE_MIN) return { rate: ACTION_RATE_MIN, loop: true };
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
 */
export function groundFollowVy(
  x: number,
  z: number,
  vy: number,
  normal: readonly [number, number, number],
  gap: number,
  opts: { stick: number; slopeTolerance: number; dt: number; ours: boolean },
): number | null {
  if (!(opts.stick > 0) || normal[1] <= 0.5 || gap > opts.stick) return null;
  if (vy > 0.8 && !opts.ours) return null;
  const planar = Math.hypot(x, z);
  if (planar < 0.1) return null; // standing still: leave it to contact resolution
  const cap = Math.max(1, planar * opts.slopeTolerance);
  const along = -(normal[0] * x + normal[2] * z) / normal[1];
  let follow = Math.max(-cap, Math.min(cap, along));
  if (gap > 0.02) follow -= Math.min(gap / Math.max(opts.dt, 1 / 240), cap);
  return follow;
}

/** A rise this body owes to {@link groundFollowVy} rather than to a jump. */
export function risingByGround(vy: number, wrote: number | null): boolean {
  return wrote !== null && Math.abs(vy - wrote) < 1;
}

/** Exponential smoothing that behaves the same at any tick rate. */
export function damp(current: number, target: number, rate: number, dt: number): number {
  if (!(rate > 0)) return target;
  return target + (current - target) * Math.exp(-rate * dt);
}

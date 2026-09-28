/**
 * Clip advance: a one-shot that STEPS (a lunge, a sword combo, a heavy swing
 * that closes the distance) carries the body with its feet.
 *
 * Every clip `retarget` bakes is in place, so a step forward is a planted foot
 * sliding back under a body that stays where it is. Played on a capsule that
 * does not move, the feet skate and the character snaps back to where it
 * started. `retarget --measure` reads how far the ground goes by under each
 * one-shot (`clipAdvance`: a cumulative curve over the clip, in the model's
 * own frame) and the controller moves the body by that curve's slope while the
 * clip plays full-body — as a VELOCITY, so collisions, ledges and the server's
 * copy of the body all see an ordinary move rather than a teleport.
 *
 * Pure and DOM-free: curve and playhead in, velocity out.
 */

/**
 * One clip's travel. `f` and `s` are cumulative metres at evenly spaced points
 * over the clip (first point 0 at the first frame, last at the last frame):
 * `f` along the model's +Z (its forward), `s` along its +X. `d` is the clip's
 * length in seconds as measured — used where the host cannot report one.
 */
export interface ClipAdvance {
  d?: number;
  f: number[];
  s?: number[];
}

/** A table entry that can actually be sampled — hand-edited params are not trusted blindly. */
export function isClipAdvance(value: unknown): value is ClipAdvance {
  if (!value || typeof value !== "object") return false;
  const v = value as { f?: unknown; s?: unknown; d?: unknown };
  const curve = (c: unknown): boolean =>
    Array.isArray(c) && c.length >= 2 && c.every((n) => typeof n === "number" && Number.isFinite(n));
  if (!curve(v.f)) return false;
  if (v.s !== undefined && !curve(v.s)) return false;
  if (v.d !== undefined && !(typeof v.d === "number" && v.d > 0)) return false;
  return true;
}

/** The curve at `u` (0..1 of the clip), linear between points and clamped at both ends. */
export function sampleAdvance(curve: readonly number[], u: number): number {
  const n = curve.length;
  if (n === 0) return 0;
  if (!(u > 0)) return curve[0]!;
  if (u >= 1) return curve[n - 1]!;
  const x = u * (n - 1);
  const i = Math.floor(x);
  const t = x - i;
  return curve[i]! + (curve[i + 1]! - curve[i]!) * t;
}

/**
 * Travel along one curve between playheads `u0` and `u1` (fractions of the
 * clip, u1 >= u0). A looping clip carries on round (each whole loop adds the
 * curve's full travel); a one-shot is clamped at its last frame, so a playhead
 * that runs past the end adds nothing.
 */
export function advanceBetween(curve: readonly number[], u0: number, u1: number, loop: boolean): number {
  if (!(u1 > u0)) return 0;
  if (!loop) return sampleAdvance(curve, Math.min(1, u1)) - sampleAdvance(curve, Math.min(1, u0));
  const total = curve[curve.length - 1] ?? 0;
  const base = Math.floor(u0);
  const a = u0 - base;
  const b = u1 - base; // may exceed 1 — whole loops and a partial one
  const loops = Math.floor(b);
  const frac = b - loops;
  return loops * total + sampleAdvance(curve, frac) - sampleAdvance(curve, a);
}

export interface AdvanceStep {
  /** Seconds into the clip at the start of this tick (clip time, not wall time). */
  clock: number;
  /** Tick length, seconds. */
  dt: number;
  /** The clip's playback rate this tick. */
  rate: number;
  /** Clip length, seconds. */
  duration: number;
  loop: boolean;
  /** The model's yaw: rotation about +Y that takes its +Z to where it faces. */
  yaw: number;
  /** Multiplier on the travel (the controller's `advanceScale`). */
  scale?: number;
}

/**
 * The horizontal velocity (world x, z, m/s) that covers this tick's share of
 * the clip's travel: the curve's rise across `[clock, clock + dt * rate]`,
 * over `dt`, turned from the model's frame into the world's by `yaw`.
 * Playback rate is in there on purpose — a swing fitted to play twice as fast
 * covers its ground twice as fast, and its feet stay planted.
 */
export function advanceVelocity(entry: ClipAdvance, step: AdvanceStep): [number, number] {
  const { clock, dt, rate, duration, loop, yaw } = step;
  if (!(dt > 0) || !(duration > 0) || !(rate > 0)) return [0, 0];
  const u0 = clock / duration;
  const u1 = (clock + dt * rate) / duration;
  const scale = step.scale ?? 1;
  const f = (advanceBetween(entry.f, u0, u1, loop) * scale) / dt;
  const s = entry.s ? (advanceBetween(entry.s, u0, u1, loop) * scale) / dt : 0;
  // model +Z -> (sin yaw, cos yaw); model +X -> (cos yaw, -sin yaw)
  const sin = Math.sin(yaw);
  const cos = Math.cos(yaw);
  return [f * sin + s * cos, f * cos - s * sin];
}

/**
 * The fastest the table ever moves a body, m/s at playback rate 1 — what an
 * authority adds to its speed cap while an action plays, so a claimed lunge
 * is not clipped as a speed hack. Measured per span of each curve.
 */
export function peakAdvanceSpeed(table: Record<string, unknown>): number {
  let peak = 0;
  for (const entry of Object.values(table)) {
    if (!isClipAdvance(entry) || !entry.d) continue;
    const spans = entry.f.length - 1;
    const dt = entry.d / spans;
    for (let i = 0; i < spans; i++) {
      const df = entry.f[i + 1]! - entry.f[i]!;
      const ds = entry.s ? (entry.s[i + 1] ?? 0) - (entry.s[i] ?? 0) : 0;
      peak = Math.max(peak, Math.hypot(df, ds) / dt);
    }
  }
  return peak;
}

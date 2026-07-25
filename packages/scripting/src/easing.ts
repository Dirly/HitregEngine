/**
 * Shared, dependency-free tweening primitives for scripts. Everything here is
 * a pure function of its inputs (no wall-clock, no internal state) so callers
 * stay replay- and multiplayer-safe by construction, matching the built-in
 * behaviors' existing "pure function of ctx.now()" pattern.
 */

/** Standard normalized (0..1 -> 0..1) easing curves. */
export const Easings = {
  linear: (t: number): number => t,
  easeInQuad: (t: number): number => t * t,
  easeOutQuad: (t: number): number => 1 - (1 - t) * (1 - t),
  easeInOutQuad: (t: number): number => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2),
  easeInCubic: (t: number): number => t * t * t,
  easeOutCubic: (t: number): number => 1 - Math.pow(1 - t, 3),
  easeInOutCubic: (t: number): number => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2),
  easeInSine: (t: number): number => 1 - Math.cos((t * Math.PI) / 2),
  easeOutSine: (t: number): number => Math.sin((t * Math.PI) / 2),
  easeInOutSine: (t: number): number => -(Math.cos(Math.PI * t) - 1) / 2,
  easeOutBack: (t: number): number => {
    const c1 = 1.70158;
    const c3 = c1 + 1;
    return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
  },
  easeOutElastic: (t: number): number => {
    const c4 = (2 * Math.PI) / 3;
    if (t <= 0) return 0;
    if (t >= 1) return 1;
    return Math.pow(2, -10 * t) * Math.sin((t * 10 - 0.75) * c4) + 1;
  },
  easeOutBounce: (t: number): number => {
    const n1 = 7.5625;
    const d1 = 2.75;
    if (t < 1 / d1) return n1 * t * t;
    if (t < 2 / d1) return n1 * (t -= 1.5 / d1) * t + 0.75;
    if (t < 2.5 / d1) return n1 * (t -= 2.25 / d1) * t + 0.9375;
    return n1 * (t -= 2.625 / d1) * t + 0.984375;
  },
} as const satisfies Record<string, (t: number) => number>;

export type EasingName = keyof typeof Easings;

/** Looks up an easing curve by name, falling back to linear for an unknown
 * (e.g. AI-authored) name instead of throwing — params are unvalidated JSON. */
export function easingByName(name: string): (t: number) => number {
  return (Easings as Record<string, ((t: number) => number) | undefined>)[name] ?? Easings.linear;
}

export type LoopMode = "once" | "loop" | "pingpong";

/**
 * Raw (pre-ease) progress in [0, 1] for a tween of `duration` seconds,
 * given `elapsedSeconds` of simulated time and a loop mode:
 * - "once": clamps at 1 and stays there.
 * - "loop": repeats 0 -> 1, 0 -> 1, ...
 * - "pingpong": 0 -> 1 -> 0 -> 1 ... (triangle wave).
 */
export function loopProgress(elapsedSeconds: number, duration: number, loop: LoopMode): number {
  if (duration <= 0) return 1;
  const u = elapsedSeconds / duration;
  if (loop === "once") return Math.min(1, Math.max(0, u));
  if (loop === "loop") return u - Math.floor(u);
  // pingpong: triangle wave 0..1..0 with period 2
  const m = u % 2;
  const wrapped = m < 0 ? m + 2 : m; // guard against negative elapsed time
  return wrapped <= 1 ? wrapped : 2 - wrapped;
}

/**
 * Dwell-aware ping-pong progress: pauses `dwellSeconds` at each end of a
 * `travelSeconds` leg before heading back. Used by moving platforms/lifts
 * that need to sit at the top/bottom instead of ricocheting immediately.
 */
export function pingPongProgress(elapsedSeconds: number, travelSeconds: number, dwellSeconds: number): number {
  if (travelSeconds <= 0) return 0;
  const cycle = 2 * (travelSeconds + dwellSeconds);
  const u = elapsedSeconds % cycle;
  if (u < dwellSeconds) return 0;
  if (u < dwellSeconds + travelSeconds) return (u - dwellSeconds) / travelSeconds;
  if (u < 2 * dwellSeconds + travelSeconds) return 1;
  return 1 - (u - 2 * dwellSeconds - travelSeconds) / travelSeconds;
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

export function lerpVec3(
  a: readonly [number, number, number],
  b: readonly [number, number, number],
  t: number,
): [number, number, number] {
  return [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];
}

/** Move `current` toward `target` by at most `maxDelta`, clamping exactly at the target. */
export function approach(current: number, target: number, maxDelta: number): number {
  if (current < target) return Math.min(target, current + maxDelta);
  if (current > target) return Math.max(target, current - maxDelta);
  return current;
}

/** Like {@link approach}, but wraps the delta to the shortest arc — for yaw/heading (radians). */
export function approachAngle(current: number, target: number, maxDelta: number): number {
  const delta = Math.atan2(Math.sin(target - current), Math.cos(target - current));
  if (Math.abs(delta) <= maxDelta) return current + delta;
  return current + Math.sign(delta) * maxDelta;
}

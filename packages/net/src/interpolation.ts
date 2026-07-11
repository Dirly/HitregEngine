/**
 * Snapshot interpolation — the standard remote-entity smoothing for
 * snapshot-based multiplayer (milestone 2).
 *
 * Remote entities are rendered a fixed delay BEHIND the newest snapshot so
 * there are always two snapshots bracketing the render time: motion is a
 * true interpolation (correct velocity, jitter-free), not an easing chase
 * toward the latest packet. Two pieces:
 *
 * - `TransformInterpolator` — a ring of tick-stamped keyed transforms;
 *   `sample(renderTick)` returns per-id interpolated position/rotation,
 *   with short velocity extrapolation when the buffer runs dry.
 * - `InterpolationClock` — drives the render tick from local frame time,
 *   softly re-syncing toward (newestTick − delay) so it never needs a
 *   clock-sync protocol; snapshot arrival IS the clock.
 *
 * Deliberately dependency-free (no three.js): [x,y,z] arrays and quaternion
 * nlerp, usable headless and in tests.
 */

export interface TransformSnap {
  p: [number, number, number];
  /** Quaternion [x,y,z,w]. */
  q?: [number, number, number, number];
  /** Heading in radians (players) — interpolated along the shortest arc. */
  yaw?: number;
  /** Opaque extras (animation clip, display name…) — newest snapshot wins. */
  data?: unknown;
}

export interface SampledTransform {
  p: [number, number, number];
  q?: [number, number, number, number];
  yaw?: number;
  data?: unknown;
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function lerpYaw(a: number, b: number, t: number): number {
  let d = b - a;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return a + d * t;
}

/** Normalized-lerp (shortest path). Fine at snapshot-interval rotations. */
function nlerpQuat(
  a: [number, number, number, number],
  b: [number, number, number, number],
  t: number,
): [number, number, number, number] {
  const dot = a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3];
  const s = dot < 0 ? -1 : 1; // take the short way around
  const x = lerp(a[0], b[0] * s, t);
  const y = lerp(a[1], b[1] * s, t);
  const z = lerp(a[2], b[2] * s, t);
  const w = lerp(a[3], b[3] * s, t);
  const len = Math.hypot(x, y, z, w) || 1;
  return [x / len, y / len, z / len, w / len];
}

function interpolatePair(a: TransformSnap, b: TransformSnap, t: number): SampledTransform {
  const out: SampledTransform = {
    p: [lerp(a.p[0], b.p[0], t), lerp(a.p[1], b.p[1], t), lerp(a.p[2], b.p[2], t)],
    data: b.data ?? a.data,
  };
  if (a.q && b.q) out.q = nlerpQuat(a.q, b.q, t);
  else if (b.q) out.q = b.q;
  if (a.yaw !== undefined && b.yaw !== undefined) out.yaw = lerpYaw(a.yaw, b.yaw, t);
  else if (b.yaw !== undefined) out.yaw = b.yaw;
  return out;
}

export interface TransformInterpolatorOptions {
  /** Samples retained per entity (default 32 — 1.6s at 20 Hz). */
  maxSamples?: number;
  /** Max ticks of velocity extrapolation past an entity's newest sample (default 3). */
  maxExtrapolationTicks?: number;
}

interface Sample {
  tick: number;
  snap: TransformSnap;
}

/**
 * Per-entity sample streams. Each id interpolates within its OWN buffer,
 * so entities updating at different cadences (interest management's
 * `sendEvery`) interpolate correctly across their own gaps — an entity
 * absent from a snapshot simply carries forward. Despawn is explicit:
 * `remove(id)` (driven by the protocol's `removed` list), never inferred
 * from absence.
 */
export class TransformInterpolator {
  private readonly streams = new Map<string, Sample[]>();
  private readonly maxSamples: number;
  private readonly maxExtrapolationTicks: number;
  private newest: number | null = null;

  constructor(options: TransformInterpolatorOptions = {}) {
    this.maxSamples = options.maxSamples ?? 32;
    this.maxExtrapolationTicks = options.maxExtrapolationTicks ?? 3;
  }

  /** Insert a snapshot's states. Duplicate ticks replace; out-of-order sorts in. */
  push(tick: number, states: Record<string, TransformSnap>): void {
    this.newest = this.newest === null ? tick : Math.max(this.newest, tick);
    for (const [id, snap] of Object.entries(states)) {
      let stream = this.streams.get(id);
      if (!stream) {
        stream = [];
        this.streams.set(id, stream);
      }
      const i = stream.findIndex((s) => s.tick >= tick);
      if (i === -1) stream.push({ tick, snap });
      else if (stream[i]!.tick === tick) stream[i] = { tick, snap };
      else stream.splice(i, 0, { tick, snap });
      while (stream.length > this.maxSamples) stream.shift();
    }
  }

  /** Despawn: forget an entity entirely (protocol-driven, never inferred). */
  remove(id: string): void {
    this.streams.delete(id);
  }

  ids(): string[] {
    return [...this.streams.keys()];
  }

  newestTick(): number | null {
    return this.newest;
  }

  clear(): void {
    this.streams.clear();
    this.newest = null;
  }

  /**
   * Interpolated transforms at a (fractional) tick — every known entity,
   * each sampled within its own stream. Before an entity's first sample it
   * holds there; past its newest, position extrapolates along the last
   * pair's velocity for up to maxExtrapolationTicks, then holds (rotation
   * and data never extrapolate).
   */
  sample(renderTick: number): Map<string, SampledTransform> {
    const out = new Map<string, SampledTransform>();
    for (const [id, stream] of this.streams) {
      const sampled = this.sampleStream(stream, renderTick);
      if (sampled) out.set(id, sampled);
    }
    return out;
  }

  private sampleStream(stream: Sample[], renderTick: number): SampledTransform | null {
    const n = stream.length;
    if (n === 0) return null;
    const last = stream[n - 1]!;
    if (renderTick >= last.tick) {
      const prev = n >= 2 ? stream[n - 2]! : null;
      const over = Math.min(renderTick - last.tick, this.maxExtrapolationTicks);
      if (!prev || over <= 0 || prev.tick === last.tick) return { ...last.snap };
      const perTick = 1 / (last.tick - prev.tick);
      return {
        p: [
          last.snap.p[0] + (last.snap.p[0] - prev.snap.p[0]) * perTick * over,
          last.snap.p[1] + (last.snap.p[1] - prev.snap.p[1]) * perTick * over,
          last.snap.p[2] + (last.snap.p[2] - prev.snap.p[2]) * perTick * over,
        ],
        q: last.snap.q, // rotation/anim hold — extrapolating spin looks worse
        yaw: last.snap.yaw,
        data: last.snap.data,
      };
    }
    const first = stream[0]!;
    if (renderTick <= first.tick) return { ...first.snap };
    let hi = 1;
    while (stream[hi]!.tick < renderTick) hi++;
    const a = stream[hi - 1]!;
    const b = stream[hi]!;
    return interpolatePair(a.snap, b.snap, (renderTick - a.tick) / (b.tick - a.tick));
  }
}

export interface InterpolationClockOptions {
  /** Host snapshot rate in ticks/second. */
  hz: number;
  /** Render this many ticks behind the newest snapshot (default 2). */
  delayTicks?: number;
  /** Proportional re-sync rate toward the target tick (default 2 /s). */
  catchupRate?: number;
  /** Drift beyond this many ticks snaps instead of easing (default 8). */
  snapThresholdTicks?: number;
}

/**
 * Advances a render tick at the host's rate using local frame time, and
 * gently servos it toward (newest snapshot − delay). Absorbs network jitter
 * and clock skew without any explicit time synchronization.
 */
export class InterpolationClock {
  private readonly hz: number;
  private readonly delayTicks: number;
  private readonly catchupRate: number;
  private readonly snapThresholdTicks: number;
  private renderTick: number | null = null;
  private newest: number | null = null;

  constructor(options: InterpolationClockOptions) {
    this.hz = options.hz;
    this.delayTicks = options.delayTicks ?? 2;
    this.catchupRate = options.catchupRate ?? 2;
    this.snapThresholdTicks = options.snapThresholdTicks ?? 8;
  }

  onSnapshot(tick: number): void {
    this.newest = this.newest === null ? tick : Math.max(this.newest, tick);
  }

  /** Advance by a frame; returns the tick to sample at (null = no data yet). */
  advance(dtSeconds: number): number | null {
    if (this.newest === null) return null;
    const target = this.newest - this.delayTicks;
    if (this.renderTick === null) {
      this.renderTick = target;
      return this.renderTick;
    }
    this.renderTick += dtSeconds * this.hz;
    const err = target - this.renderTick;
    if (Math.abs(err) > this.snapThresholdTicks) this.renderTick = target;
    else this.renderTick += err * Math.min(1, this.catchupRate * dtSeconds);
    // snapshots stalled: hold at the newest — extrapolating past it is the
    // interpolator's (capped) job, not the clock's
    if (this.renderTick > this.newest) this.renderTick = this.newest;
    return this.renderTick;
  }

  reset(): void {
    this.renderTick = null;
    this.newest = null;
  }
}

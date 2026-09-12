import type { SimLike } from "./script.js";

/**
 * Terrain-aware steering for AI bodies — how a mob gets from A to B on a
 * streamed voxel world without a navmesh.
 *
 * There is no bake and no graph. Every decision is made from the live physics
 * world at the moment it is needed, which is the only kind of navigation that
 * survives terrain that streams in, gets terraformed, or has a river carved
 * through it while the server is running. The cost is that it is LOCAL: this
 * will slide a body around a boulder, up a hill and away from a cliff, but it
 * cannot plan around a mountain range. That is the right trade for mobs, which
 * are leashed to a home within tens of metres; a global path (a coarse nav grid
 * derived from the voxel field per chunk) is the next tier and belongs on top
 * of this, not instead of it.
 *
 * ## The one thing that is easy to get wrong
 *
 * Terrain and furniture are judged by DIFFERENT probes, and mixing them is the
 * bug you will spend an afternoon on:
 *
 *   - **Terrain is judged by SAMPLING HEIGHT**, ahead vs. underfoot. A grade
 *     too steep to climb, a step small enough to walk up, a drop too deep to
 *     jump off — all three are one downward ray and a subtraction.
 *   - **Furniture is judged by a HORIZONTAL RAY**, and that ray excludes
 *     terrain. A horizontal ray at chest height hits a perfectly walkable
 *     hillside about two metres ahead of a body standing on a 30 degree slope,
 *     so a mask that includes TERRAIN reports "wall" for every hill on the map
 *     and the pack mills around at the bottom of it.
 *
 * Nothing here allocates per probe, and the fan is only paid for when the way
 * ahead is actually blocked — a mob walking down an empty road costs three
 * raycasts per steering tick, not fifteen.
 */

/**
 * Collision layer bits, restated.
 *
 * The named constants live in `@hitreg/physics` (`Layers`, `SOLID_WORLD`,
 * `VISION_BLOCKERS`), but this package must not depend on that one — scripting
 * runs headless with no Rapier wasm, and the dependency runs the other way.
 * The bits are documented as APPEND-ONLY precisely so a restatement like this
 * cannot silently change meaning; `test/steering.test.ts` imports the real
 * `Layers` and asserts these still match, so a renumber fails a test instead of
 * quietly steering every mob into a wall.
 */
export const LAYER_WORLD = 1 << 0;
export const LAYER_TERRAIN = 1 << 1;
export const LAYER_PROP = 1 << 4;

/** What a body stands on: static geometry and the ground itself. */
export const GROUND_LAYERS = LAYER_WORLD | LAYER_TERRAIN;

/**
 * What stops a body horizontally. Terrain is deliberately ABSENT — see the
 * header: slope is a height question, not a ray question.
 */
export const OBSTACLE_LAYERS = LAYER_WORLD | LAYER_PROP;

const DOWN: [number, number, number] = [0, -1, 0];

/** Just the part of `SimLike` a probe needs, so tests can pass a stub. */
export type SteeringSim = Pick<SimLike, "raycast"> | null | undefined;

export interface GroundProbeOptions {
  /** Metres above `nearY` the probe starts. Must clear the tallest step a body can be standing on. */
  up?: number;
  /** Metres the probe searches downward from there. */
  down?: number;
  layers?: number;
  exclude?: readonly string[];
}

/**
 * Height of the ground under (x, z), or null when nothing is there.
 *
 * Null is a NORMAL answer, not an error: a chunk that has not streamed in yet,
 * a point over the void at the edge of the world, a body that fell through the
 * floor. Callers must treat it as "I do not know" rather than "y = 0" — every
 * world-space Y bug in a streamed world starts with someone defaulting it to a
 * constant, and the symptom is silent (the mob walks, correctly, fourteen
 * metres underground).
 *
 * The probe starts relative to `nearY` rather than at a fixed altitude so it
 * costs the same on a mountain as in a valley.
 */
export function groundHeightAt(
  sim: SteeringSim,
  x: number,
  z: number,
  nearY: number,
  opts: GroundProbeOptions = {},
): number | null {
  const raycast = sim?.raycast;
  if (!raycast) return null;
  const up = opts.up ?? 3;
  const down = opts.down ?? 24;
  const hit = raycast.call(sim, [x, nearY + up, z], DOWN, up + down, {
    layers: opts.layers ?? GROUND_LAYERS,
    ...(opts.exclude ? { exclude: opts.exclude } : {}),
  });
  return hit ? hit.point[1] : null;
}

export interface SteeringOptions {
  /** Body radius (m) — how far ahead of its centre an obstacle still counts. */
  radius: number;
  /** Height above the FEET the horizontal obstacle ray is cast from. */
  eyeHeight: number;
  /** How far ahead a candidate direction is tested (m). */
  probe: number;
  /** A rise this small is a step, not a slope — walked up without a second thought. */
  maxStepUp: number;
  /** A drop deeper than this is a ledge the body will not walk off. */
  maxDrop: number;
  /** Steepest climbable grade, in DEGREES. */
  maxSlope: number;
  /** How many candidate directions to try per side when the way ahead is blocked. */
  fan: number;
  /** Degrees between fan candidates. */
  spread: number;
  /**
   * How much a candidate is favoured for matching last tick's choice (0 = none).
   * Stops the jitter of two equally good ways around a rock.
   */
  stickiness: number;
  /** Seconds of evidence before a body that wants to move but is not is called stuck. */
  stuckSeconds: number;
  /** Fraction of the intended distance that still counts as moving. */
  stuckFraction: number;
  /** Seconds spent sidestepping after coming unstuck. */
  unstickSeconds: number;
}

export const DEFAULT_STEERING: SteeringOptions = {
  radius: 0.45,
  eyeHeight: 1,
  probe: 1.6,
  maxStepUp: 0.6,
  maxDrop: 2.5,
  maxSlope: 50,
  fan: 3,
  spread: 32,
  stickiness: 0.35,
  stuckSeconds: 0.8,
  stuckFraction: 0.25,
  unstickSeconds: 0.7,
};

export interface SteerRequest {
  /** Where the body is now (its transform position, not its feet). */
  from: readonly [number, number, number];
  /** Where it wants to go, horizontally. Need not be normalized; [0, 0] means stop. */
  desired: readonly [number, number];
  /** Seconds since the PREVIOUS solve — steering ticks slower than the sim. */
  dt: number;
  /** How fast it intends to travel (m/s) — only used to judge whether it is stuck. */
  speed: number;
  /** Ids the probes must ignore: at minimum the body itself and its model child. */
  exclude?: readonly string[];
  /** Bodies to slide around rather than through: [x, z, radius]. Packmates, mostly. */
  avoid?: ReadonlyArray<readonly [number, number, number]>;
}

export interface SteerResult {
  /** Unit direction to drive in, or [0, 0] when there is nowhere to go. */
  dir: [number, number];
  /** The way it wanted to go was impassable (it either found a way round or gave up). */
  blocked: boolean;
  /** It has been trying to move and is not; it is currently sidestepping. */
  stuck: boolean;
  /** Ground height under the body, or null when unknown (unstreamed, or no physics). */
  groundY: number | null;
}

/**
 * One steerer per body. It holds memory — the last direction chosen, how far
 * the body has actually travelled lately, which way it decided to sidestep —
 * and that memory is what separates "walks around the rock" from "vibrates
 * against the rock".
 */
export class TerrainSteering {
  readonly options: SteeringOptions;
  private lastDir: [number, number] = [0, 0];
  private lastPos: [number, number, number] | null = null;
  private wanted = 0;
  private moved = 0;
  private window = 0;
  private unstickUntil = 0;
  private unstickSign = 1;
  private stuckNow = false;

  constructor(options: Partial<SteeringOptions> = {}) {
    this.options = { ...DEFAULT_STEERING, ...options };
  }

  /** Forget the body's history — after a teleport, a respawn, a leash reset. */
  reset(): void {
    this.lastDir = [0, 0];
    this.lastPos = null;
    this.wanted = 0;
    this.moved = 0;
    this.window = 0;
    this.unstickUntil = 0;
    this.stuckNow = false;
  }

  /**
   * Pick a direction to drive in this tick.
   *
   * `now` is simulated seconds (`ctx.now() / 1000`), never wall-clock: a
   * steering decision that used real time would resolve differently on a
   * server under load than in a replay.
   */
  solve(sim: SteeringSim, req: SteerRequest, now: number): SteerResult {
    const o = this.options;
    const [x, y, z] = req.from;

    this.trackProgress(req, now);

    // No physics queries at all (a headless test scene, a doc-only world):
    // steering degrades to "go where you were going" rather than freezing the
    // population in place. A brain that cannot probe should still patrol.
    if (typeof sim?.raycast !== "function") {
      const dir = normalize(req.desired[0], req.desired[1]);
      this.lastDir = dir;
      return { dir, blocked: false, stuck: false, groundY: null };
    }

    const groundY = groundHeightAt(sim, x, z, y, { exclude: req.exclude });
    // Not knowing where the floor is disables the HEIGHT tests only — the
    // horizontal ray still means something, so the body keeps avoiding walls
    // while a chunk streams in instead of standing still in the open.
    const feet = groundY ?? y;
    const feetKnown = groundY !== null;

    let wx = req.desired[0];
    let wz = req.desired[1];
    if (req.avoid && req.avoid.length > 0) [wx, wz] = this.separate(x, z, wx, wz, req.avoid);
    let desired = normalize(wx, wz);
    if (desired[0] === 0 && desired[1] === 0) {
      this.lastDir = [0, 0];
      return { dir: [0, 0], blocked: false, stuck: this.stuckNow, groundY };
    }

    // Sidestepping: aim across the obstruction rather than at it. The chosen
    // side is held for the whole unstick window — re-picking per tick is how a
    // body ends up rocking left-right in a doorway forever.
    if (now < this.unstickUntil) {
      desired = [-desired[1] * this.unstickSign, desired[0] * this.unstickSign];
    }

    // Fast path: the way it wants to go is fine. Three rays, no fan.
    if (this.passable(sim, x, z, feet, feetKnown, desired, req.exclude)) {
      this.lastDir = desired;
      return { dir: desired, blocked: false, stuck: this.stuckNow, groundY };
    }

    // Blocked — fan out and take the best passable candidate. Scoring is
    // "how close to where I wanted to go" plus a nudge toward last tick's
    // answer, so a body committed to going round the left of a rock keeps
    // going round the left of it.
    let best: [number, number] | null = null;
    let bestScore = -Infinity;
    for (let k = 1; k <= o.fan; k++) {
      const angle = (k * o.spread * Math.PI) / 180;
      for (const sign of [1, -1] as const) {
        const cand = rotate(desired, angle * sign);
        if (!this.passable(sim, x, z, feet, feetKnown, cand, req.exclude)) continue;
        const score =
          cand[0] * desired[0] +
          cand[1] * desired[1] +
          o.stickiness * (cand[0] * this.lastDir[0] + cand[1] * this.lastDir[1]);
        if (score > bestScore) {
          bestScore = score;
          best = cand;
        }
      }
      // Nearest passable side wins: no point testing the wider fan once the
      // narrow one works, and it keeps the ray count down on a busy server.
      if (best) break;
    }

    if (!best) {
      this.lastDir = [0, 0];
      return { dir: [0, 0], blocked: true, stuck: this.stuckNow, groundY };
    }
    this.lastDir = best;
    return { dir: best, blocked: true, stuck: this.stuckNow, groundY };
  }

  /**
   * Can the body take a step in this direction?
   *
   * One downward ray (is the ground ahead climbable, and is it there at all)
   * and one horizontal ray (is there furniture in the way). Terrain is
   * excluded from the second on purpose — see the module header.
   */
  private passable(
    sim: SteeringSim,
    x: number,
    z: number,
    feet: number,
    feetKnown: boolean,
    dir: readonly [number, number],
    exclude: readonly string[] | undefined,
  ): boolean {
    const o = this.options;
    const ax = x + dir[0] * o.probe;
    const az = z + dir[1] * o.probe;

    if (feetKnown) {
      const ahead = groundHeightAt(sim, ax, az, feet, exclude ? { exclude } : {});
      if (ahead === null) return false; // a hole in the world: do not walk into it
      const rise = ahead - feet;
      if (rise > o.maxStepUp && rise / o.probe > Math.tan((o.maxSlope * Math.PI) / 180)) return false;
      if (rise < -o.maxDrop) return false;
    }

    const hit = sim!.raycast!([x, feet + o.eyeHeight, z], [dir[0], 0, dir[1]], o.probe + o.radius, {
      layers: OBSTACLE_LAYERS,
      ...(exclude ? { exclude } : {}),
    });
    return hit === null;
  }

  /**
   * Push away from crowded neighbours before choosing a direction, so a pack
   * of five arrives as a pack of five rather than as one body with four others
   * shoving it through the floor. Cheap and ray-free — the caller already
   * knows where its packmates are.
   */
  private separate(
    x: number,
    z: number,
    wx: number,
    wz: number,
    avoid: ReadonlyArray<readonly [number, number, number]>,
  ): [number, number] {
    const want = Math.hypot(wx, wz) || 1;
    let px = 0;
    let pz = 0;
    for (const [ax, az, ar] of avoid) {
      const dx = x - ax;
      const dz = z - az;
      const d = Math.hypot(dx, dz);
      const reach = this.options.radius + ar;
      if (d >= reach || d < 1e-4) continue;
      const push = (reach - d) / reach;
      px += (dx / d) * push;
      pz += (dz / d) * push;
    }
    // Scaled to the wish vector so separation nudges a heading, never overrides
    // it: a mob being crowded still walks toward its target.
    return [wx + px * want, wz + pz * want];
  }

  /** Stuck detection: wanted to travel, did not, for long enough to be sure. */
  private trackProgress(req: SteerRequest, now: number): void {
    const [x, , z] = req.from;
    if (this.lastPos) this.moved += Math.hypot(x - this.lastPos[0], z - this.lastPos[2]);
    this.lastPos = [x, req.from[1], z];

    const wants = req.desired[0] !== 0 || req.desired[1] !== 0;
    this.wanted += wants ? req.speed * req.dt : 0;
    this.window += req.dt;
    if (this.window < this.options.stuckSeconds) return;

    // A body that never asked to move is not stuck, it is standing.
    this.stuckNow = this.wanted > 0.1 && this.moved < this.wanted * this.options.stuckFraction;
    if (this.stuckNow && now >= this.unstickUntil) {
      this.unstickUntil = now + this.options.unstickSeconds;
      this.unstickSign = -this.unstickSign; // the other way next time
    }
    this.wanted = 0;
    this.moved = 0;
    this.window = 0;
  }
}

function normalize(x: number, z: number): [number, number] {
  const len = Math.hypot(x, z);
  return len < 1e-6 ? [0, 0] : [x / len, z / len];
}

function rotate(v: readonly [number, number], angle: number): [number, number] {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  return [v[0] * c - v[1] * s, v[0] * s + v[1] * c];
}

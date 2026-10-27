/**
 * WHITE WATER BY FLOW SPEED: the one mapping from a river's surface gradient to its current, and from the current to
 * the froth the water material paints. The field writes the speed into every river sample (`waterSurface` flowX/Z,
 * carried in the water mesh's uv); the material (`flowMode: "field"`) whitens by `rapidsFoam(speed)`. Pure, so the
 * chain gradient -> speed -> foam is tested in one place (test/white-water.test.ts) and the shader reads the same
 * constants.
 *
 * - a still pool drifts at RIVER_STILL_SPEED; the speed grows with the local fall of the surface (drop / run);
 * - a LEDGE (a short drop under a fall's height: a weir step in a pool-and-rapid chain) churns for
 *   RIVER_LEDGE_CHURN metres below its lip, so a stepped rapid reads white over its ledges, not as thin stripes;
 * - the froth fades in between RAPIDS_FOAM_SPEED[0] and [1] m/s: a pool stays dark, a rapid runs white.
 */
import { clamp, smoothstep } from "./noise.js";

/** Speed (m/s) of still water: the drift of a pool. */
export const RIVER_STILL_SPEED = 0.45;
/** Speed gained per unit surface gradient (drop / run). 3 % -> ~1 m/s (a quick run, no froth); 10 % -> 2.25 m/s. */
export const RIVER_SPEED_PER_GRADE = 18;
/** Fastest current the field writes on a river or a ledge (m/s); only a plunge pool runs faster (3.4), so the plunge churn is a plunge's alone. */
export const RIVER_MAX_SPEED = 3.1;
/** The froth band of the water material: none under [0], full (RAPIDS_FOAM_MAX) over [1] (m/s). */
export const RAPIDS_FOAM_SPEED: readonly [number, number] = [1.2, 3.0];
/** Over this band (m/s) the gaps between the froth streaks close up (a ledge's foot); the streaks stay. */
export const RAPIDS_SOLID_SPEED: readonly [number, number] = [2.6, 3.3];
/** Most the rapids froth ever covers the water (0..1): never a flat fill, the water texture always shows through. */
export const RAPIDS_FOAM_MAX = 0.75;
/** Least / most drop (m) a short step may make and still count as a LEDGE (under a fall's curtain height). */
export const RIVER_LEDGE_DROP: readonly [number, number] = [0.5, 2];
/** How far (m) below a ledge's lip the water churns white. */
export const RIVER_LEDGE_CHURN = 14;
/** Speed (m/s) at a ledge's foot; it eases off over RIVER_LEDGE_CHURN. */
export const RIVER_LEDGE_SPEED = 3.1;

/** The current (m/s) of a river reach whose surface falls `drop` metres over `run` metres. */
export function riverFlowSpeed(drop: number, run: number): number {
  const grade = run > 1e-6 ? Math.max(0, drop) / run : 0;
  return Math.min(RIVER_MAX_SPEED, RIVER_STILL_SPEED + RIVER_SPEED_PER_GRADE * grade);
}

/**
 * The churn speed `past` metres below the lip of a ledge that drops `drop` metres (0 before the lip and past the
 * churn). A tall ledge (~1.5 m and over) boils solid white at its foot; a low riffle (~0.6 m) only froths in streaks.
 * The churn rises over the lip's first 1.5 m, so it never starts on a hard line across the river.
 */
export function ledgeChurnSpeed(past: number, drop = RIVER_LEDGE_DROP[1]): number {
  if (!(past >= 0) || past > RIVER_LEDGE_CHURN) return 0;
  const peak = Math.min(RIVER_LEDGE_SPEED, 1.7 + 1.0 * Math.max(0, drop));
  return peak * smoothstep(0, 1.5, past) * (1 - smoothstep(RIVER_LEDGE_CHURN * 0.35, RIVER_LEDGE_CHURN, past));
}

/** Is a drop of `drop` m over `run` m a ledge (a rapid's step), not a fall and not a run? */
export function isLedge(drop: number, run: number, lip: number): boolean {
  return drop >= RIVER_LEDGE_DROP[0] && drop < RIVER_LEDGE_DROP[1] && run <= lip + 0.5;
}

/** Froth amount (0..1) the water material paints at a current of `speed` m/s (before its texture breakup). */
export function rapidsFoam(speed: number): number {
  return clamp(smoothstep(RAPIDS_FOAM_SPEED[0], RAPIDS_FOAM_SPEED[1], speed), 0, 1);
}

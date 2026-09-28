/**
 * Stance carry: how a character holding a weapon MOVES.
 *
 * A two-handed library's own run is a different run — shorter stride, sunk
 * hips, a different cadence — and next to the plain jog every other weapon
 * uses it reads as a different character. So while a stance is in force and
 * the body is in a locomotion gait, the LEGS play the plain gait clip and the
 * UPPER BODY plays the stance's: its own clip for that gait where the model
 * has one (`TwoHanded_Run` over `Run`), phase-locked so the arms swing with
 * the legs, else — for stances that hold something up, a shield — the
 * stance's idle as a held carry pose.
 *
 * Pure and DOM-free: the controller asks, the animation host plays. The same
 * answer is what a remote host would have to reproduce.
 */

/** What rides the upper-body layer over a plain gait. */
export interface StanceCarry {
  /** The stance clip on the upper-body layer. */
  clip: string;
  /**
   * Cycles the upper clip is held AHEAD of the legs' phase (0..1) — the layer
   * is phase-locked to the base — or null for a held pose that runs free
   * (a stance idle carried over a walk).
   */
  lock: number | null;
}

const wrap01 = (v: number): number => ((v % 1) + 1) % 1;

/**
 * How far ahead of the legs' phase the upper-body clip must run so the two
 * clips' LEFT-foot contacts coincide. `clipFootfalls` lists each clip's left
 * foot's contact first (as `retarget` prints them); aligning the first
 * contacts of two lists whose first entries are different feet puts the arms
 * half a stride out — swinging with the same-side leg — which is why the
 * order carries meaning here. Missing data on either side: 0, a plain
 * normalised-phase match.
 */
export function carryPhaseOffset(legs: readonly number[] | undefined, upper: readonly number[] | undefined): number {
  const a = legs?.[0];
  const b = upper?.[0];
  if (typeof a !== "number" || typeof b !== "number" || !Number.isFinite(a) || !Number.isFinite(b)) return 0;
  const offset = wrap01(b - a);
  // 0.9999999 and 0 are the same phase; keep the number a reader can check
  return offset > 1 - 1e-9 ? 0 : offset;
}

/**
 * The upper-body clip for a stance carried over the plain gait `gait`, or
 * null when nothing should ride over it (the plain gait plays whole — the
 * arm swing of a one-hander's jog).
 *
 * Stances are tried most specific first. Each one's own `<Stance>_<gait>` wins
 * (phase-locked to the legs); a stance listed in `hold` with a
 * `<Stance>_<idle>` holds that idle's upper body instead (a shield carried up
 * while walking); anything else falls through to the next stance.
 */
export function stanceCarryFor(opts: {
  /** The plain gait clip the legs are playing (Walk, Run, Run_Left, …). */
  gait: string;
  /** Weapon stances in force, most specific first. */
  stances: readonly string[];
  /** The plain idle clip's name (the stance idle is `<Stance>_<idle>`). */
  idle: string;
  /** Whether the model has a clip. */
  has: (clip: string) => boolean;
  /** Stances that hold their idle's upper body over a gait they have no clip for. */
  hold: readonly string[];
  /** `clipFootfalls` — left foot's contact first. */
  footfalls?: Readonly<Record<string, readonly number[]>>;
}): StanceCarry | null {
  for (const stance of opts.stances) {
    const own = `${stance}_${opts.gait}`;
    if (opts.has(own)) {
      return { clip: own, lock: carryPhaseOffset(opts.footfalls?.[opts.gait], opts.footfalls?.[own]) };
    }
    const held = `${stance}_${opts.idle}`;
    if (opts.hold.includes(stance) && opts.has(held)) return { clip: held, lock: null };
  }
  return null;
}

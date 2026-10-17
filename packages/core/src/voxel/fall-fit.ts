/**
 * FALL FIT — a waterfall's curtain hangs from the lip the terrain REALLY has.
 *
 * A fall is solved on the river (`RiverFall`: its foot, its two levels, its
 * direction) long before the ground around it is finished: planar cliffs,
 * terraces, buttes, fall-site gorges and formations all carve and rebuild it
 * afterwards. The curtain used to be placed from those solved numbers, so
 * wherever the ground moved, the curtain stood metres away from the real edge
 * — a sheet of water floating in front of rock, the river above stopping
 * short of it (Skelmorrow's Weeping Stair: the real lip 17 m upstream of the
 * solved one). Two measures, both from the solid field every chunk is meshed
 * from, so any terrain change that moves the lip moves the curtain with it:
 *
 * - {@link measureFallLip}: where the river surface meets the drop. Columns
 *   across the channel are walked along the current at a probe height under
 *   the upper water; the lip is where the bed under the water ends (solid →
 *   air). {@link fitFall} moves the fall along its direction by the median of
 *   the columns, so the upper water's cut, the curtain's top row and its span
 *   are all taken on the real line.
 * - {@link fallFace}: how far past the lip line the rock face stands at a
 *   height. The curtain's falling rows ride the face's running maximum (the
 *   envelope: water never tucks back under an overhang it has passed) plus a
 *   hand's clearance, so it hugs the face, and bulges out over anything that
 *   juts.
 *
 * Pure functions of the field; core, headless.
 */
import type { RiverFall } from "./field.js";

/** What the fit reads: the solid (density < 0 is rock). */
export interface FallFitField {
  density(x: number, y: number, z: number): number;
  /** The real top surface (treads, cuts, planar walls); the face hug reads it (one call per sample, not per row). */
  ground?(x: number, z: number): number;
}

/** How far up- or downstream of the solved lip line the real lip is looked for (m). */
export const FALL_LIP_SEARCH = 30;
/** The curtain's clearance off the face (m): it hugs the rock this far out. */
export const FALL_FACE_CLEAR = 0.3;
/** The measure's step along the current (m). */
const STEP = 0.25;

/** The probe height under the upper water: under any bed, above any real drop's floor. */
export function fallProbeDepth(fall: Pick<RiverFall, "top" | "bottom">): number {
  return Math.max(4, Math.min(8, (fall.top - fall.bottom) * 0.3));
}

export interface FallLip {
  /** Metres along the fall's direction from the SOLVED lip line to the measured one (+ downstream). */
  shift: number;
  /** False when no column found an edge within the search (the solved line is kept). */
  found: boolean;
  /** Each sampled column's own shift (null: none found), across offsets in `across`. */
  columns: (number | null)[];
  across: number[];
}

/**
 * Where the river surface really meets the drop, relative to the solved lip
 * line `lipOffset` upstream of the fall's foot. Per column (across the channel,
 * within its width): solid at the probe height on the line → walk downstream
 * to the first air (the rock reaches further out than solved); air → walk
 * upstream to the last air after the bed (the ground was cut back). A found
 * edge needs 2 m of air past it (a real drop, not a pothole).
 */
export function measureFallLip(field: FallFitField, fall: RiverFall, lipOffset: number): FallLip {
  const y = fall.top - fallProbeDepth(fall);
  const px = -fall.dirZ;
  const pz = fall.dirX;
  const lx = fall.x - fall.dirX * lipOffset;
  const lz = fall.z - fall.dirZ * lipOffset;
  const solid = (s: number, a: number): boolean =>
    field.density(lx + fall.dirX * s + px * a, y, lz + fall.dirZ * s + pz * a) < 0;
  const dropAfter = (s: number, a: number): boolean => {
    for (let t = s; t <= s + 2; t += STEP) if (solid(t, a)) return false;
    return true;
  };
  const half = Math.max(0.5, fall.width / 2 - 0.5);
  const across = [-half, -half / 2, 0, half / 2, half];
  const columns = across.map((a): number | null => {
    if (solid(0, a)) {
      for (let s = STEP; s <= FALL_LIP_SEARCH / 2; s += STEP) if (!solid(s, a)) return dropAfter(s, a) ? s - STEP / 2 : null;
      return null;
    }
    for (let s = -STEP; s >= -FALL_LIP_SEARCH; s -= STEP) {
      if (solid(s, a)) return dropAfter(s + STEP, a) ? s + STEP / 2 : null;
    }
    return null;
  });
  const found = columns.filter((c): c is number => c !== null).sort((a, b) => a - b);
  if (found.length === 0) return { shift: 0, found: false, columns, across };
  const shift = found[Math.floor(found.length / 2)]!;
  return { shift: Math.round(shift * 100) / 100, found: true, columns, across };
}

/** The fall moved along its direction so its lip line stands on the measured lip (`shift` m). */
export function shiftFall(fall: RiverFall, shift: number): RiverFall {
  if (shift === 0) return fall;
  return { ...fall, x: fall.x + fall.dirX * shift, z: fall.z + fall.dirZ * shift };
}

const fitted = new WeakMap<object, Map<RiverFall, RiverFall>>();

/**
 * The fall with its lip on the real edge (cached per field: every chunk near
 * the fall asks, and all of them must cut the water on the same line).
 */
export function fitFall(field: FallFitField, fall: RiverFall, lipOffset: number): RiverFall {
  let byFall = fitted.get(field);
  if (!byFall) fitted.set(field, (byFall = new Map()));
  let out = byFall.get(fall);
  if (!out) byFall.set(fall, (out = shiftFall(fall, Math.min(0, measureFallLip(field, fall, lipOffset).shift))));
  return out;
}

/**
 * Where the rock face stands at height `y`, in metres past the line through
 * (`lx`, `lz`) along the fall's direction, at `across` along the line: the
 * furthest-out place where rock gives way to air between `from` and `to` (a
 * jut past the face behind counts — the curtain must clear it). `landed`: the
 * row is still rock at `to` (the water has reached a floor or a ledge top).
 * `face` null: no rock in the row at all (the curtain falls free there).
 */
export function fallFace(
  field: FallFitField,
  fall: Pick<RiverFall, "dirX" | "dirZ">,
  lx: number,
  lz: number,
  across: number,
  y: number,
  from = -7.5,
  to = 12,
): { face: number | null; landed: boolean } {
  const px = -fall.dirZ;
  const pz = fall.dirX;
  const solid = (s: number): boolean => field.density(lx + fall.dirX * s + px * across, y, lz + fall.dirZ * s + pz * across) < 0;
  let face: number | null = null;
  let was = solid(from);
  for (let s = from + STEP; s <= to + 1e-9; s += STEP) {
    const now = solid(s);
    if (was && !now) face = s - STEP / 2;
    was = now;
  }
  return { face, landed: was };
}

/**
 * One curtain column's ground profile: the real top surface at every `STEP` along the fall's direction from `from` to
 * `to` metres past the line through (`lx`, `lz`), at `across` along it. Read once per column; every row's face is
 * then a lookup ({@link profileFace}) — the hug costs a column's samples, not rows x samples of density.
 */
export function fallColumn(field: FallFitField, fall: Pick<RiverFall, "dirX" | "dirZ">, lx: number, lz: number, across: number, from = -7.5, to = 16): { from: number; step: number; g: Float64Array } {
  const px = -fall.dirZ;
  const pz = fall.dirX;
  const n = Math.max(2, Math.round((to - from) / STEP) + 1);
  const g = new Float64Array(n);
  const ground = field.ground?.bind(field);
  for (let i = 0; i < n; i++) {
    const s = from + i * STEP;
    const x = lx + fall.dirX * s + px * across;
    const z = lz + fall.dirZ * s + pz * across;
    if (ground) g[i] = ground(x, z);
    else {
      // no ground(): bisect the density column (tests)
      let lo = -200, hi = 400;
      for (let k = 0; k < 30; k++) { const m = (lo + hi) / 2; if (field.density(x, m, z) < 0) lo = m; else hi = m; }
      g[i] = lo;
    }
  }
  return { from, step: STEP, g };
}

/**
 * The face at height `y` in a column profile, searched between `lo` and `hi` (m past the line): the furthest-out
 * place the ground drops from at/above `y` to below it (the outermost rock at that height — the envelope bulges over
 * overhangs by construction). `landed`: still ground at/above `y` at `hi` (a floor or a ledge top); `face` null:
 * no ground at that height in the window (the curtain falls free there).
 */
export function profileFace(col: { from: number; step: number; g: Float64Array }, y: number, lo: number, hi: number): { face: number | null; landed: boolean } {
  const i0 = Math.max(0, Math.floor((lo - col.from) / col.step));
  const i1 = Math.min(col.g.length - 1, Math.ceil((hi - col.from) / col.step));
  let face: number | null = null;
  for (let i = i0; i < i1; i++) {
    const a = col.g[i]!, b = col.g[i + 1]!;
    if (a >= y && b < y) face = col.from + (i + (a - y) / Math.max(1e-6, a - b)) * col.step;
  }
  return { face, landed: col.g[i1]! >= y };
}

/** The ground height at `s` metres past the line in a column profile (linear between samples). */
export function groundAtProfile(col: { from: number; step: number; g: Float64Array }, s: number): number {
  const t = Math.max(0, Math.min(col.g.length - 1.000001, (s - col.from) / col.step));
  const i = Math.floor(t);
  return col.g[i]! + (col.g[i + 1]! - col.g[i]!) * (t - i);
}

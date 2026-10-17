import { z } from "zod";
import type { ChunkDoc } from "../chunks.js";
import { terraceWallCutSchema, terraceWallPieceSchema } from "./terrace-walls.js";

/**
 * PATH RIBBONS — a walkable surface laid along a spline over gently graded ground.
 *
 * Owner ruling 2026-10-15: paths are ribbons; never carve a path into the terrain. A path carved into the 2 m voxel
 * lattice draws lumpy treads and bulging walls; a game path is a smooth SURFACE strip following a spline, with the
 * ground graded gently under it (a wide, feathered height patch: no terrain feature finer than 6 m), steps where it
 * is steep and retaining walls (the world-kit retaining-wall kit) where the side drop is high.
 *
 * Authoring is the `path` landform operator (`features.operators`, ./operators-path.ts): a control polyline, width,
 * style, maxGrade, edge. Its compile (this file, pure) fits a centripetal Catmull-Rom spline, resamples it at ~1 m,
 * solves a grade-limited longitudinal profile (switchbacks / steps where the ground is steeper), and writes the
 * derived pieces: one `ribbons` feature (the solved strip, stairs, wall pieces, face cuts) and one masked
 * `heightPatches` grade patch. The streamer draws the ribbon per cell (`ribbonEntities`) as one `surface` mesh per
 * ribbon per cell (static: batched per material) with a trimesh collider cooked from the same triangles.
 */

const xz = z.tuple([z.number().finite(), z.number().finite()]);
type XZ = [number, number];

export const RIBBON_STYLES = ["dirt", "cobble", "slab"] as const;
export type RibbonStyle = (typeof RIBBON_STYLES)[number];
/** Height the ribbon's walk surface stands above the graded ground under it (m). */
export const RIBBON_LIFT = 0.04;
/** Vertex shade at a dirt ribbon's worn rim (its centre line is 1): trodden earth darkens toward the verge. */
export const RIBBON_DIRT_RIM = 0.84;
/** Length (m) of the level run-out every path ends with (no stair reaches into it). */
export const RIBBON_RUNOUT = 2;
/** How far (m) a stair tread's side flank reaches below the graded ramp beside the flight at its foot. */
export const RIBBON_STAIR_FOOT = 0.03;
/** Space between the ribbon edge and the edge of the levelled core (m): the 2 m lattice is flat under the ribbon. */
export const RIBBON_CORE_MARGIN = 1.2;
/** Retaining-wall body depth behind its face (world-kit retaining-wall `size[2]`, 0.6-0.65 m). */
const WALL_DEPTH = 0.65;
/** Kit heights (m) the retaining-wall straights exist at (world-kit authoring/retaining-wall lookup.json). */
export const RIBBON_WALL_HEIGHTS = [0.8, 1.5, 2, 2.4, 3, 3.6, 4.4, 5.2, 6, 6.4] as const;
const RISER = 0.17;
/** A flight may not climb where the turn is this tight (inner-edge curvature x half width): it lands instead. */
const RIBBON_WINDER = 0.4;
const MIN_TREAD = 0.28;
/** Steepest a stair's profile may climb (rise / tread 0.17 / 0.34). */
const STAIR_GRADE = 0.5;

// ---------------------------------------------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------------------------------------------

export const pathParamsSchema = z.object({
  points: z.array(xz).min(2).describe("Control polyline, world XZ, in walking order. A centripetal Catmull-Rom spline runs through every point; 6-30 m apart is plenty."),
  width: z.number().min(1).max(8).default(2.4).describe("Walkable width of the ribbon (m). Footpath 2-2.6, town lane 3-4, street 5-6."),
  style: z.enum(RIBBON_STYLES).default("dirt").describe("dirt: trodden earth, the zone's `road` tile (else its `ground`) smoothed and lifted a little, a darker worn rim and a wide worn verge: it reads as a path from afar and still sits in the land. cobble: the zone's `paving` tile. slab: `paving` at a larger tile, a straight hard edge. Always the terrain's own tint: a ribbon never reads bluer than the ground it lies on, and only trodden dirt reads lighter."),
  surface: z.string().optional().describe("Palette surface NAME to pave with, overriding the zone tile the style picks (e.g. `gravel`)."),
  maxGrade: z.number().min(0.02).max(0.5).default(0.15).describe("Steepest longitudinal rise/run the ribbon may climb as a ramp. Steeper stretches become a switchback (inside `corridor`) or steps."),
  steep: z.enum(["auto", "steps", "switchback"]).default("auto").describe("Where the ground is steeper than maxGrade over a stretch: steps (flights + landings), switchback (zig-zag inside `corridor`, steps on any leg still too steep), auto = switchback when the corridor allows it, else steps."),
  corridor: z.number().min(0).max(60).default(0).describe("Half-width (m) the path may wander sideways from the control line to detour gently (switchbacks). 0 = keep to the line."),
  maxCutFill: z.number().min(0.3).max(4).default(1.0).describe("How far (m) the graded centre line may sit below/above the smoothed ground before the stretch is called steep."),
  shoulder: z.number().min(3).max(12).default(3.5).describe("Minimum feather (m) each side of the levelled core over which the grade blends back into the ground. Widens automatically on a high side drop (bank no steeper than 1:2)."),
  edge: z.enum(["verge", "hard"]).default("verge").describe("verge: a worn edge (noise-offset 0.3-0.6 m, deterministic) that fades dithered into the ground; both ends taper, round off and fade into whatever paving or road they meet. hard: a straight edge with a small lip (laid slabs, kerbless street)."),
  walls: z.enum(["auto", "none"]).default("auto").describe("auto: retaining walls from the world-kit retaining-wall kit on BOTH sides: the fill side where the drop exceeds `wallDrop`, the uphill cut where the bank exceeds `wallCut`. Runs end in the kit's stepped end pieces. none: banks only."),
  wallDrop: z.number().min(0.8).max(4).default(1.2).describe("Side drop (m) beyond which the fill side gets a retaining wall instead of a bank."),
  wallCut: z.number().min(0.8).max(6).default(1.5).describe("Uphill cut (m) beyond which the cut side gets a retaining wall holding the bank back instead of a raw earth slope."),
  wallStyle: z.enum(["common", "stone"]).default("common").describe("Retaining-wall kit style: common (coursed rubble), stone (dressed ashlar)."),
  wallSkin: z.string().optional().describe("Stone the walls wear: omitted = the zone's own stone (its `ground.cliff` surface, the rock-skins key: `worldgen-ribbon materials` writes `ribbon-wall/<cliff>-rubble|ashlar`); a palette cliff surface NAME to force one; `kit` = the kit's own grey stone."),
});
export type PathParams = z.infer<typeof pathParamsSchema>;

export const ribbonFlightSchema = z.object({
  from: z.number().int().min(0).describe("Sample index where the stair starts."),
  to: z.number().int().min(0).describe("Sample index where it ends."),
  treads: z.array(z.tuple([z.number(), z.number(), z.number()])).describe("[s0, s1, topY] of every tread and landing, s = metres along the ribbon."),
  rise: z.number().describe("Riser height (m)."),
});

export const ribbonSchema = z
  .object({
    id: z.string(),
    width: z.number().positive(),
    style: z.enum(RIBBON_STYLES),
    surface: z.string().optional().describe("Palette surface name; omitted = the zone's `road` (dirt) or `paving` (cobble, slab) tile at the ribbon's middle."),
    edge: z.enum(["verge", "hard"]).default("verge"),
    seed: z.number().int().default(0).describe("Edge-jitter phase."),
    wallSkin: z.string().optional().describe("The path's `wallSkin` (omitted = the zone's stone)."),
    samples: z
      .array(z.tuple([z.number(), z.number(), z.number(), z.number(), z.number()]))
      .min(2)
      .describe("[x, walkY, z, shoulderLeft, shoulderRight] every ~1 m along the centre. A negative shoulder = a retaining wall on that side, its face that far out."),
    flights: z.array(ribbonFlightSchema).default([]),
    switchbacks: z.number().int().min(0).default(0),
    pieces: z.array(terraceWallPieceSchema).default([]).describe("Retaining-wall kit pieces, world placed. The streamer emits them; do not hand-edit."),
    cuts: z.array(terraceWallCutSchema).default([]).describe("Oriented boxes the field carves in front of every wall face (same contract as terrace walls)."),
    clearing: z.array(xz).optional().describe("Outline kept clear of scatter and ground cover (the ribbon plus a metre each side)."),
    warnings: z.array(z.string()).default([]),
  })
  .describe("A solved path ribbon: compiled by the `path` landform operator; never hand-edit.");
export type RibbonDoc = z.infer<typeof ribbonSchema>;

// ---------------------------------------------------------------------------------------------------------------
// Spline
// ---------------------------------------------------------------------------------------------------------------

export interface Centreline {
  x: number[];
  z: number[];
  /** Arc length at each sample (m). */
  s: number[];
}

/** Centripetal (alpha 0.5) Catmull-Rom through `points`, resampled at an even step close to `step` metres. */
export function centripetalCatmullRom(points: readonly (readonly [number, number])[], step = 1): Centreline {
  const p: XZ[] = [];
  for (const q of points) {
    const last = p[p.length - 1];
    if (!last || Math.hypot(q[0] - last[0], q[1] - last[1]) > 1e-6) p.push([q[0], q[1]]);
  }
  if (p.length < 2) throw new Error("path needs two distinct points");
  const n = p.length;
  const ext: XZ[] = [
    [2 * p[0]![0] - p[1]![0], 2 * p[0]![1] - p[1]![1]],
    ...p,
    [2 * p[n - 1]![0] - p[n - 2]![0], 2 * p[n - 1]![1] - p[n - 2]![1]],
  ];
  const dense: XZ[] = [];
  const SUB = 32;
  for (let i = 1; i < ext.length - 2; i++) {
    const P0 = ext[i - 1]!, P1 = ext[i]!, P2 = ext[i + 1]!, P3 = ext[i + 2]!;
    const knot = (a: XZ, b: XZ) => Math.max(1e-4, Math.sqrt(Math.hypot(b[0] - a[0], b[1] - a[1])));
    const t0 = 0, t1 = t0 + knot(P0, P1), t2 = t1 + knot(P1, P2), t3 = t2 + knot(P2, P3);
    const lerp = (a: XZ, b: XZ, ta: number, tb: number, t: number): XZ => {
      const u = (t - ta) / (tb - ta);
      return [a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u];
    };
    for (let k = 0; k < SUB; k++) {
      const t = t1 + ((t2 - t1) * k) / SUB;
      const A1 = lerp(P0, P1, t0, t1, t), A2 = lerp(P1, P2, t1, t2, t), A3 = lerp(P2, P3, t2, t3, t);
      const B1 = lerp(A1, A2, t0, t2, t), B2 = lerp(A2, A3, t1, t3, t);
      dense.push(lerp(B1, B2, t1, t2, t));
    }
  }
  dense.push(p[n - 1]!);
  const cum = [0];
  for (let i = 1; i < dense.length; i++) cum.push(cum[i - 1]! + Math.hypot(dense[i]![0] - dense[i - 1]![0], dense[i]![1] - dense[i - 1]![1]));
  const total = cum[cum.length - 1]!;
  const count = Math.max(1, Math.round(total / step));
  const out: Centreline = { x: [], z: [], s: [] };
  let j = 0;
  for (let k = 0; k <= count; k++) {
    const target = (total * k) / count;
    while (j < dense.length - 2 && cum[j + 1]! < target) j++;
    const seg = cum[j + 1]! - cum[j]! || 1;
    const u = Math.min(1, Math.max(0, (target - cum[j]!) / seg));
    out.x.push(dense[j]![0] + (dense[j + 1]![0] - dense[j]![0]) * u);
    out.z.push(dense[j]![1] + (dense[j + 1]![1] - dense[j]![1]) * u);
    out.s.push(target);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// Longitudinal profile
// ---------------------------------------------------------------------------------------------------------------

/**
 * The grade-limited profile closest to `target`: the mean of the largest G-Lipschitz function under it and the
 * smallest one over it (cut and fill balanced), `grade[i]` bounding segment i..i+1. Then `smooth` passes of a
 * [1 2 1] kernel on every sample not `frozen`, and a final forward clamp so no segment ever exceeds its grade.
 */
export function solveProfile(s: readonly number[], target: readonly number[], grade: readonly number[], smooth = 0, frozen?: readonly boolean[]): number[] {
  const n = target.length;
  const lo = target.slice(), hi = target.slice();
  for (let i = 1; i < n; i++) {
    const g = grade[i - 1]! * (s[i]! - s[i - 1]!);
    lo[i] = Math.min(lo[i]!, lo[i - 1]! + g);
    hi[i] = Math.max(hi[i]!, hi[i - 1]! - g);
  }
  for (let i = n - 2; i >= 0; i--) {
    const g = grade[i]! * (s[i + 1]! - s[i]!);
    lo[i] = Math.min(lo[i]!, lo[i + 1]! + g);
    hi[i] = Math.max(hi[i]!, hi[i + 1]! - g);
  }
  let y = lo.map((v, i) => (v + hi[i]!) / 2);
  for (let pass = 0; pass < smooth; pass++) {
    const next = y.slice();
    for (let i = 0; i < n; i++) {
      if (frozen?.[i]) continue;
      next[i] = (y[Math.max(0, i - 1)]! + 2 * y[i]! + y[Math.min(n - 1, i + 1)]!) / 4;
    }
    y = next;
  }
  for (let i = 1; i < n; i++) {
    const g = grade[i - 1]! * (s[i]! - s[i - 1]!);
    y[i] = Math.min(y[i - 1]! + g, Math.max(y[i - 1]! - g, y[i]!));
  }
  return y;
}

/** Gaussian-ish smoothing of a ground profile (box filter applied three times, radius in samples). */
function smoothSeries(v: readonly number[], radius: number): number[] {
  let a = v.slice();
  for (let pass = 0; pass < 3; pass++) {
    const b = a.slice();
    for (let i = 0; i < a.length; i++) {
      let sum = 0, cnt = 0;
      for (let k = -radius; k <= radius; k++) {
        const j = Math.min(a.length - 1, Math.max(0, i + k));
        sum += a[j]!;
        cnt++;
      }
      b[i] = sum / cnt;
    }
    a = b;
  }
  return a;
}

/** Sample index ranges [from, to] where the ground is too steep to follow at the grade: dilated and merged. */
export function steepStretches(s: readonly number[], y: readonly number[], target: readonly number[], maxDev: number): [number, number][] {
  const n = y.length;
  const raw: [number, number][] = [];
  let start = -1;
  for (let i = 0; i < n; i++) {
    const steep = Math.abs(y[i]! - target[i]!) > maxDev;
    if (steep && start < 0) start = i;
    if ((!steep || i === n - 1) && start >= 0) {
      raw.push([start, steep ? i : i - 1]);
      start = -1;
    }
  }
  const out: [number, number][] = [];
  for (const [a0, b0] of raw) {
    // the deviation peaks mid-stretch; the steep ground starts and ends well outside it
    const pad = 4;
    const a = Math.max(0, a0 - pad), b = Math.min(n - 1, b0 + pad);
    const last = out[out.length - 1];
    if (last && s[a]! - s[last[1]]! < 6) last[1] = Math.max(last[1], b);
    else out.push([a, b]);
  }
  return out.filter(([a, b]) => b > a);
}

/**
 * Treads of a stair that follows the profile `y` (sampled at arc lengths `s`) from sample a to b: the walk level is
 * the profile quantised to whole risers (rise = H / round(|H| / 0.17)), so the stair starts and ends exactly on
 * the profile and never strays more than half a riser from it; a flat stretch of profile is a landing. Treads shorter
 * than a quarter metre are merged into the one before.
 */
export function quantizeStair(s: readonly number[], y: readonly number[], a: number, b: number, level?: readonly number[]): { treads: [number, number, number][]; rise: number; tread: number } {
  // `level` (0/1 per sample): where it is 0 the flight may not climb (a tight turn): the turn becomes one landing and
  // its rise moves onto the rest of the flight in proportion to how that already climbs (its own landings stay flat).
  // A stair never winds: on the inside of a tight turn the treads would fan to nothing and stack risers into a wall.
  if (level && level.slice(a, b).some((w) => w === 0) && level.slice(a, b).some((w) => w > 0)) {
    const open = (i: number) => (level[i]! && level[i + 1]! ? 1 : 0);
    let climb = 0;
    for (let i = a; i < b; i++) climb += open(i) * Math.max(0, y[i + 1]! - y[i]!);
    const byRise = climb > 0.5 * Math.abs(y[b]! - y[a]!);
    const W = [0];
    for (let i = a; i < b; i++) W.push(W[W.length - 1]! + open(i) * (byRise ? Math.max(0, y[i + 1]! - y[i]!) : s[i + 1]! - s[i]!));
    const total = W[W.length - 1]!;
    if (total > 1e-6) {
      const warped = y.slice();
      for (let i = a; i <= b; i++) warped[i] = y[a]! + ((y[b]! - y[a]!) * W[i - a]!) / total;
      return quantizeStair(s, warped, a, b);
    }
  }
  const ya = y[a]!, H = y[b]! - ya;
  const n = Math.max(1, Math.round(Math.abs(H) / RISER));
  const rise = Math.abs(H) / n || RISER;
  const runs: [number, number, number][] = [];
  const STEP = 0.05;
  let i = a;
  for (let sv = s[a]!; sv < s[b]! - 1e-9; sv += STEP) {
    while (i < b - 1 && s[i + 1]! <= sv) i++;
    const u = (sv - s[i]!) / (s[i + 1]! - s[i]! || 1);
    const level = ya + Math.round((y[i]! + (y[i + 1]! - y[i]!) * u - ya) / rise) * rise;
    const last = runs[runs.length - 1];
    if (last && Math.abs(last[2] - level) < 1e-6) last[1] = Math.min(s[b]!, sv + STEP);
    else runs.push([sv, Math.min(s[b]!, sv + STEP), level]);
  }
  const treads: [number, number, number][] = [];
  runs.forEach((r, k) => {
    const last = treads[treads.length - 1];
    if (last && r[1] - r[0] < 0.25 && k < runs.length - 1) last[1] = r[1];
    else treads.push([r[0], r[1], r[2]]);
  });
  const end = treads[treads.length - 1]!, before = treads[treads.length - 2];
  end[1] = s[b]!;
  if (before && end[1] - end[0] < 0.3) end[0] = before[1] = Math.max(before[0] + 0.25, end[1] - 0.3);
  let tread = Infinity;
  for (let k = 1; k < treads.length - 1; k++) tread = Math.min(tread, treads[k]![1] - treads[k]![0]);
  return { treads, rise, tread: Number.isFinite(tread) ? tread : s[b]! - s[a]! };
}

// ---------------------------------------------------------------------------------------------------------------
// Fit
// ---------------------------------------------------------------------------------------------------------------

export interface RibbonGround {
  height(x: number, z: number): number;
}

export interface RibbonFit {
  ribbon: Omit<RibbonDoc, "id">;
  /** The control polyline actually splined (switchback waypoints inserted). */
  control: XZ[];
  report: { length: number; maxGrade: number; cut: number; fill: number; flights: number; risers: number; walls: number; switchbacks: number; samples: number };
}

const r2 = (v: number) => Math.round(v * 100) / 100;
const r3 = (v: number) => Math.round(v * 1000) / 1000;

function tangentAt(c: Centreline, i: number): XZ {
  const a = Math.max(0, i - 1), b = Math.min(c.x.length - 1, i + 1);
  const dx = c.x[b]! - c.x[a]!, dz = c.z[b]! - c.z[a]!;
  const l = Math.hypot(dx, dz) || 1;
  return [dx / l, dz / l];
}

/** Fit a path: spline, profile, steps / switchbacks, shoulders and walls. Pure and deterministic. */
export function fitRibbon(params: PathParams, ground: RibbonGround, seed = 0): RibbonFit {
  const hw = params.width / 2;
  let control: XZ[] = params.points.map((p) => [p[0], p[1]]);
  const warnings: string[] = [];
  let switchbacks = 0;
  let c = centripetalCatmullRom(control, 1);
  let solved = solveCentre(c, params, ground);
  const mayDetour = params.steep !== "steps" && params.corridor >= hw + 4;
  if (mayDetour && solved.stretches.length) {
    // one detour pass: every steep stretch becomes a zig-zag inside the corridor, long enough for maxGrade
    const next: XZ[] = [];
    let cursor = 0;
    const amp = params.corridor - hw - 1;
    for (const [a, b] of solved.stretches) {
      for (let i = cursor; i < a; i += 6) next.push([c.x[i]!, c.z[i]!]);
      const H = Math.abs(solved.target[b]! - solved.target[a]!);
      const ax = c.x[a]!, az = c.z[a]!, bx = c.x[b]!, bz = c.z[b]!;
      const L0 = Math.hypot(bx - ax, bz - az);
      const need = H / (params.maxGrade * 0.9);
      // legs closer than two graded half-widths would grade over each other: cap them, steps take the rest
      const maxLegs = Math.floor(L0 / (2 * (hw + RIBBON_CORE_MARGIN + params.shoulder)));
      const legs = Math.min(maxLegs, Math.ceil(Math.sqrt(Math.max(0, need * need - L0 * L0)) / (2 * amp)));
      next.push([ax, az]);
      if (legs >= 2 && L0 > 1) {
        const ux = (bx - ax) / L0, uz = (bz - az) / L0;
        for (let j = 1; j <= legs; j++) {
          const f = ((j - 0.5) / legs) * L0, side = j % 2 ? 1 : -1;
          next.push([ax + ux * f - uz * amp * side, az + uz * f + ux * amp * side]);
        }
        switchbacks += legs - 1;
      }
      next.push([bx, bz]);
      cursor = b + 6;
    }
    for (let i = cursor; i < c.x.length - 1; i += 6) next.push([c.x[i]!, c.z[i]!]);
    next.push([c.x[c.x.length - 1]!, c.z[c.z.length - 1]!]);
    if (switchbacks > 0) {
      control = next;
      c = centripetalCatmullRom(control, 1);
      solved = solveCentre(c, params, ground);
    }
  } else if (params.steep === "switchback" && solved.stretches.length) {
    warnings.push(`steep: switchback asked but corridor ${params.corridor} m is narrower than the path + 4 m; built steps`);
  }
  const n = c.x.length;
  const y = solved.y;
  // A path ends on level ground: the last RIBBON_RUNOUT metres hold the level the last flight reaches, so no stair
  // consumes the end (it would finish on a tread standing over the graded ramp) and the walker steps off onto a landing.
  const sEnd = c.s[n - 1]! - RIBBON_RUNOUT;
  let iEnd = n - 1;
  while (iEnd > 0 && c.s[iEnd]! > sEnd) iEnd--;
  const stretches: [number, number][] = [];
  for (const [a, b] of solved.stretches) {
    if (a >= iEnd) continue;
    stretches.push([a, Math.min(b, iEnd)]);
  }
  if (c.s[n - 1]! > RIBBON_RUNOUT * 1.5) for (let i = iEnd + 1; i < n; i++) y[i] = y[iEnd]!;
  // stairs where it is still steep; never through a tight turn (the turn lands, the rise moves to the straights)
  const turn = ribbonCurvature(c);
  const flat = turn.map((k, i) => (Math.max(Math.abs(k), Math.abs(turn[i - 1] ?? 0), Math.abs(turn[i + 1] ?? 0)) * (params.width / 2) > RIBBON_WINDER ? 0 : 1));
  const flights: z.infer<typeof ribbonFlightSchema>[] = [];
  let risers = 0;
  for (const [a, b] of stretches) {
    const L = c.s[b]! - c.s[a]!;
    let steepest = 0;
    for (let i = a; i < b; i++) steepest = Math.max(steepest, Math.abs(y[i + 1]! - y[i]!) / (c.s[i + 1]! - c.s[i]! || 1));
    if (steepest <= params.maxGrade * 1.02 || L < 2) continue;
    // the flight that meets the run-out may not have the open length (straight, past the turn) to climb the whole ground
    // step at a walkable tread: it then tops out lower, on the run-out, and the ground is cut down to meet it
    if (b === iEnd) {
      let open = 0;
      for (let i = a; i < b; i++) if (flat[i] && flat[i + 1]) open += c.s[i + 1]! - c.s[i]!;
      const room = open < c.s[b]! - c.s[a]! ? open : Infinity;
      const maxRise = (room / (MIN_TREAD * 1.15)) * RISER;
      if (Math.abs(y[b]! - y[a]!) > maxRise) {
        const top = y[a]! + Math.sign(y[b]! - y[a]!) * maxRise;
        for (let i = b; i < n; i++) y[i] = top;
      }
    }
    const stair = quantizeStair(c.s, y, a, b, flat);
    if (stair.tread < MIN_TREAD) warnings.push(`stair at ${r2(c.x[a]!)},${r2(c.z[a]!)}: shortest tread ${r2(stair.tread)} m — the ground is steeper than a stair; widen the corridor or move the line`);
    risers += stair.treads.length;
    flights.push({ from: a, to: b, treads: stair.treads.map(([s0, s1, ty]) => [r3(s0), r3(s1), r3(ty)]), rise: r3(stair.rise) });
    for (let i = a + 1; i < b; i++) y[i] = stairTop(flights[flights.length - 1]!, c.s[i]!, y[a]!);
  }
  // shoulders and walls: what the ground does just outside the levelled core on each side
  const core = hw + RIBBON_CORE_MARGIN;
  const sl: number[] = [], sr: number[] = [];
  const dropL: number[] = [], dropR: number[] = [];
  for (let i = 0; i < n; i++) {
    const [tx, tz] = tangentAt(c, i);
    for (const side of [-1, 1] as const) {
      // n axis to the right of travel: (-tz, tx)
      const ox = -tz * side, oz = tx * side;
      const probe = core + params.shoulder * 0.6;
      const g = ground.height(c.x[i]! + ox * probe, c.z[i]! + oz * probe);
      const drop = y[i]! - RIBBON_LIFT - g; // > 0: the ground falls away (fill side); < 0: an uphill cut
      (side < 0 ? dropL : dropR).push(drop);
    }
  }
  const face = hw + WALL_DEPTH;
  const kappa = ribbonCurvature(c);
  const faceL: number[] = [], faceR: number[] = [];
  const wallKinds = (drops: number[], side: -1 | 1, faces: number[]): WallKind[] => {
    const m: WallKind[] = drops.map((d) => (params.walls !== "auto" ? 0 : d > params.wallDrop ? 1 : -d > params.wallCut ? 2 : 0));
    for (let i = 0; i < n; i++) {
      const f = wallFaceOffset(hw, face, side * kappa[i]!);
      faces.push(f);
      if (!m[i]) continue;
      // a wall inside a turn too tight for it, or reaching another leg of the path (a hairpin), is a bank instead
      if (!Number.isFinite(f) || wallCrowds(c, i, side, f, hw)) m[i] = 0;
      // a cut wall never runs beside a stair: its face cut would carve the bank flat and bare the treads' sides
      if (m[i] === 2 && flights.some((fl) => i >= fl.from - 2 && i <= fl.to + 2)) m[i] = 0;
    }
    // close gaps under 3 m, drop runs under 4 m (per kind)
    for (let i = 0; i < n; i++) if (!m[i]) {
      let j = i;
      while (j < n && !m[j]) j++;
      if (i > 0 && j < n && j - i < 3 && m[i - 1] === m[j]) for (let k = i; k < j; k++) m[k] = m[j]!;
      i = j;
    }
    for (let i = 0; i < n; i++) if (m[i]) {
      let j = i;
      while (j < n && m[j] === m[i]) j++;
      if (j - i < 4) for (let k = i; k < j; k++) m[k] = 0;
      i = j - 1;
    }
    return m;
  };
  const wallL = wallKinds(dropL, -1, faceL), wallR = wallKinds(dropR, 1, faceR);
  // soft, wide shoulders: a bank no steeper than 1:3, so the grade reads as worn ground and never a trench
  const shoulderFor = (drop: number) => Math.min(16, Math.max(params.shoulder, Math.abs(drop) * 3));
  for (let i = 0; i < n; i++) {
    sl.push(wallL[i] ? -r2(faceL[i]!) : shoulderFor(dropL[i]!));
    sr.push(wallR[i] ? -r2(faceR[i]!) : shoulderFor(dropR[i]!));
  }
  const { pieces, cuts } = wallPieces(c, y, wallL, wallR, faceL, faceR, params.wallStyle, ground);
  let cut = 0, fill = 0, maxG = 0;
  for (let i = 0; i < n; i++) {
    const d = y[i]! - RIBBON_LIFT - solved.raw[i]!;
    if (d > fill) fill = d;
    if (-d > cut) cut = -d;
    if (i > 0 && !flights.some((f) => i > f.from && i <= f.to)) maxG = Math.max(maxG, Math.abs(y[i]! - y[i - 1]!) / (c.s[i]! - c.s[i - 1]! || 1));
  }
  const samples = c.x.map((x, i) => [r3(x), r3(y[i]!), r3(c.z[i]!), r2(sl[i]!), r2(sr[i]!)] as [number, number, number, number, number]);
  const ribbon: Omit<RibbonDoc, "id"> = {
    width: params.width,
    style: params.style,
    ...(params.surface ? { surface: params.surface } : {}),
    edge: params.edge,
    seed,
    ...(params.wallSkin ? { wallSkin: params.wallSkin } : {}),
    samples,
    flights,
    switchbacks,
    pieces,
    cuts,
    clearing: clearingOutline(samples, hw + 1),
    warnings,
  };
  return {
    ribbon,
    control,
    report: { length: r2(c.s[n - 1]!), maxGrade: r3(maxG), cut: r2(cut), fill: r2(fill), flights: flights.length, risers, walls: pieces.filter((p) => p.role !== "cap").length, switchbacks, samples: n },
  };
}

function solveCentre(c: Centreline, params: PathParams, ground: RibbonGround) {
  const n = c.x.length;
  // ground across the whole walk width, not only the centre: a path on a side slope sits at the mean
  const raw: number[] = [];
  for (let i = 0; i < n; i++) {
    const [tx, tz] = tangentAt(c, i);
    const w = params.width / 2;
    raw.push((ground.height(c.x[i]!, c.z[i]!) * 2 + ground.height(c.x[i]! - tz * w, c.z[i]! + tx * w) + ground.height(c.x[i]! + tz * w, c.z[i]! - tx * w)) / 4);
  }
  const target = smoothSeries(raw, 3);
  const segs = n - 1;
  let grade = new Array<number>(segs).fill(params.maxGrade);
  let y = solveProfile(c.s, target, grade, 6);
  const stretches = steepStretches(c.s, y, target, params.maxCutFill);
  if (stretches.length) {
    grade = grade.slice();
    const frozen = new Array<boolean>(n).fill(false);
    for (const [a, b] of stretches) {
      for (let i = a; i < b; i++) grade[i] = STAIR_GRADE;
      for (let i = a; i <= b; i++) frozen[i] = true;
    }
    y = solveProfile(c.s, target, grade, 6, frozen);
  }
  return { y, target, raw, stretches };
}

/** Walk level on a stair at arc length `s` (`before` = the level ahead of its first riser). */
export function stairTop(f: { treads: readonly (readonly [number, number, number])[] }, s: number, before: number): number {
  if (!f.treads.length || s < f.treads[0]![0]) return before;
  for (const t of f.treads) if (s < t[1]) return t[2];
  return f.treads[f.treads.length - 1]![2];
}

/** Lowest walk level over [s0, s1] on a stair: the graded ground under it stays below every tread. */
function stairMin(f: RibbonDoc["flights"][number], s0: number, s1: number, before: number): number {
  let m = Infinity;
  if (s0 < f.treads[0]![0]) m = before;
  for (const t of f.treads) if (t[1] > s0 && t[0] < s1) m = Math.min(m, t[2]);
  if (s1 >= f.treads[f.treads.length - 1]![1]) m = Math.min(m, f.treads[f.treads.length - 1]![2]);
  return m === Infinity ? stairTop(f, s0, before) : m;
}

/** The graded ramp under a flight at arc length s: below every tread within 1.1 m either way (what the patch asks for). */
export function stairRamp(r: Pick<RibbonDoc, "samples">, f: RibbonDoc["flights"][number], s: number): number {
  return stairMin(f, s - 1.1, s + 1.1, r.samples[f.from]![1]) - 0.08;
}

/** 0 = no wall, 1 = fill wall (the ground falls away; the path stands on top), 2 = cut wall (holds the uphill bank). */
type WallKind = 0 | 1 | 2;

/** Clearance (m) beyond the walk edge a wall face keeps on the inside of a turn, before the corner cut. */
export const RIBBON_WALL_TURN_CLEAR = 0.8;

/**
 * Signed curvature (1/m) at every sample, lightly smoothed: > 0 turns toward the right of travel (n = (-tz, tx)),
 * so `side * kappa > 0` means that side is the inside of the turn.
 */
export function ribbonCurvature(c: Pick<Centreline, "x" | "z" | "s">): number[] {
  const n = c.x.length;
  const theta = (i: number) => {
    const a = Math.max(0, i - 1), b = Math.min(n - 1, i + 1);
    return Math.atan2(c.z[b]! - c.z[a]!, c.x[b]! - c.x[a]!);
  };
  const raw: number[] = [];
  for (let i = 0; i < n; i++) {
    const a = Math.max(0, i - 1), b = Math.min(n - 1, i + 1);
    let d = theta(b) - theta(a);
    while (d > Math.PI) d -= 2 * Math.PI;
    while (d < -Math.PI) d += 2 * Math.PI;
    raw.push(d / (c.s[b]! - c.s[a]! || 1));
  }
  return raw.map((_, i) => {
    let sum = 0, k = 0;
    for (let j = Math.max(0, i - 1); j <= Math.min(n - 1, i + 1); j++) { sum += raw[j]!; k++; }
    return sum / k;
  });
}

/**
 * Face offset of a wall on a side whose inside-curvature is `inner` (1/m; <= 0 = straight or the outside): pushed
 * out so a walker cutting the corner (a 6 m chord) still keeps RIBBON_WALL_TURN_CLEAR off it. Infinity = the turn
 * is too tight for a wall on its inside at all.
 */
export function wallFaceOffset(hw: number, face: number, inner: number): number {
  // outside a turn: a straight 2 m module laid from a sample swings in toward the walk by its chord's sagitta
  if (inner < -1e-3) return face + Math.min(1, 2 / (1 / -inner + face));
  if (inner <= 1e-3) return face;
  const R = 1 / inner;
  const f = Math.max(face, hw + RIBBON_WALL_TURN_CLEAR + Math.min(2, 36 / (8 * R)));
  return R < f + 1 ? Infinity : f;
}

/** Would a wall face at sample i (side, offset f) stand within the walk + clearance of another leg of the path? */
function wallCrowds(c: Centreline, i: number, side: -1 | 1, f: number, hw: number): boolean {
  const [tx, tz] = tangentAt(c, i);
  const px = c.x[i]! - tz * side * f, pz = c.z[i]! + tx * side * f;
  const need = hw + RIBBON_WALL_TURN_CLEAR;
  for (let j = 0; j < c.x.length; j++) {
    if (Math.abs(c.s[j]! - c.s[i]!) <= f + 4) continue;
    if (Math.hypot(c.x[j]! - px, c.z[j]! - pz) < need) return true;
  }
  return false;
}

function wallPieces(c: Centreline, y: number[], wallL: WallKind[], wallR: WallKind[], faceL: number[], faceR: number[], style: "common" | "stone", ground: RibbonGround) {
  const pieces: z.infer<typeof terraceWallPieceSchema>[] = [];
  const cuts: z.infer<typeof terraceWallCutSchema>[] = [];
  const n = c.x.length;
  for (const side of [-1, 1] as const) {
    const mask = side < 0 ? wallL : wallR;
    const faces = side < 0 ? faceL : faceR;
    for (let i = 0; i < n; i++) {
      const kind = mask[i]!;
      if (!kind) continue;
      let j = i;
      while (j < n && mask[j] === kind) j++;
      // face line of this run. Kit frame: the HIGH side is on the left walking the run. A fill wall holds the path
      // (right walls run with travel); a cut wall holds the bank, so the path is on its right (left walls run with travel)
      const line: { x: number; z: number; y: number }[] = [];
      for (let k = i; k < j; k++) {
        const [tx, tz] = tangentAt(c, k);
        line.push({ x: c.x[k]! + -tz * side * faces[k]!, z: c.z[k]! + tx * side * faces[k]!, y: y[k]! });
      }
      if ((side < 0) !== (kind === 2)) line.reverse();
      // chord the face into 2 m modules that cover the whole run (the last may overhang its end by under 2 m)
      const cum = [0];
      for (let q = 1; q < line.length; q++) cum.push(cum[q - 1]! + Math.hypot(line[q]!.x - line[q - 1]!.x, line[q]!.z - line[q - 1]!.z));
      const total = cum[cum.length - 1]!;
      const pointAt = (d: number) => {
        let q = 0;
        while (q < line.length - 2 && cum[q + 1]! < d) q++;
        const u = (d - cum[q]!) / (cum[q + 1]! - cum[q]! || 1);
        const A = line[q]!, Bq = line[q + 1]!;
        return { x: A.x + (Bq.x - A.x) * u, z: A.z + (Bq.z - A.z) * u, y: A.y + (Bq.y - A.y) * u };
      };
      const modules = Math.max(1, Math.ceil(total / 2 - 0.25));
      for (let mIdx = 0; mIdx < modules; mIdx++) {
        const at = pointAt(Math.min(2 * mIdx, Math.max(0, total - 2)));
        const end = pointAt(Math.min(total, 2 * mIdx + 2));
        const mid = pointAt(Math.min(total, 2 * mIdx + 1));
        const dx = end.x - at.x, dz = end.z - at.z, len = Math.hypot(dx, dz);
        if (len < 0.5) continue;
        const ux = dx / len, uz = dz / len;
        // ground on the right of the run (its low side) and on its left (behind the face)
        const probe = (d: number, pick: (a: number, b: number) => number, from: number) => {
          let v = from;
          for (const fr of [0, 0.5, 1]) for (const dd of [0.6, 1.6]) v = pick(v, ground.height(at.x + ux * 2 * fr - uz * d * dd, at.z + uz * 2 * fr + ux * d * dd));
          return v;
        };
        let base: number, top: number, h: number, cutY0: number, cutN: number;
        if (kind === 1) {
          top = Math.max(at.y, end.y, mid.y);
          const foot = probe(1, Math.min, Infinity);
          h = RIBBON_WALL_HEIGHTS.find((v) => v >= top - foot + 0.15) ?? RIBBON_WALL_HEIGHTS[RIBBON_WALL_HEIGHTS.length - 1]!;
          base = top - h;
          cutY0 = Math.max(base, foot - 0.05);
          cutN = 2.5;
        } else {
          base = Math.min(at.y, end.y, mid.y) - RIBBON_LIFT - 0.1;
          const bank = probe(-1, Math.max, -Infinity);
          h = RIBBON_WALL_HEIGHTS.find((v) => v >= bank - base + 0.1) ?? RIBBON_WALL_HEIGHTS[RIBBON_WALL_HEIGHTS.length - 1]!;
          top = base + h;
          // carve the bank in front of the face down to the module's highest graded level (a lower cut would dig the
          // ramp below its upper samples), never across the path's far side
          cutY0 = Math.max(at.y, end.y, mid.y) - RIBBON_LIFT - 0.02;
          cutN = Math.min(2.5, faces[i]!);
        }
        const yaw = r2((Math.atan2(-uz, ux) * 180) / Math.PI);
        const hk = Math.round(h * 100);
        // a run of two or more modules steps down at both ends (kit end pieces): never an abrupt freestanding block
        const role = modules >= 2 && mIdx === 0 ? "end-l" : modules >= 2 && mIdx === modules - 1 ? "end-r" : "straight-2";
        pieces.push({ prefab: `retaining-wall/${style}-h${hk}-${role}`, role, position: [r3(at.x), r3(base), r3(at.z)], yaw, run: 2 });
        if (role === "straight-2") pieces.push({ prefab: `retaining-wall/${style}-cap-2`, role: "cap", position: [r3(at.x), r3(top), r3(at.z)], yaw });
        cuts.push({ kind: "face", origin: [r3(at.x), r3(at.z)], dir: [r3(ux), r3(uz)], s: [0, 2], n: [0, r2(cutN)], y: [r3(cutY0), r3(top + 2)] });
      }
      i = j - 1;
    }
  }
  return { pieces, cuts };
}


/** The ribbon plus `margin` each side as one closed outline (left edge forward, right edge back). */
function clearingOutline(samples: readonly (readonly number[])[], half: number): XZ[] {
  const left: XZ[] = [], right: XZ[] = [];
  const stride = Math.max(1, Math.round(samples.length / 120));
  for (let i = 0; i < samples.length; i += stride) {
    const a = samples[Math.max(0, i - 1)]!, b = samples[Math.min(samples.length - 1, i + 1)]!;
    const dx = b[0]! - a[0]!, dz = b[2]! - a[2]!, l = Math.hypot(dx, dz) || 1;
    const nx = -dz / l, nz = dx / l, p = samples[i]!;
    left.push([r2(p[0]! - nx * half), r2(p[2]! - nz * half)]);
    right.push([r2(p[0]! + nx * half), r2(p[2]! + nz * half)]);
  }
  const last = samples[samples.length - 1]!;
  if ((samples.length - 1) % stride !== 0) {
    const a = samples[samples.length - 2]!, dx = last[0]! - a[0]!, dz = last[2]! - a[2]!, l = Math.hypot(dx, dz) || 1;
    left.push([r2(last[0]! + (dz / l) * half), r2(last[2]! - (dx / l) * half)]);
    right.push([r2(last[0]! - (dz / l) * half), r2(last[2]! + (dx / l) * half)]);
  }
  return [...left, ...right.reverse()];
}

// ---------------------------------------------------------------------------------------------------------------
// Along-ribbon queries
// ---------------------------------------------------------------------------------------------------------------

/** Cumulative arc length of a ribbon's samples. */
export function ribbonArc(r: Pick<RibbonDoc, "samples">): number[] {
  const s = [0];
  for (let i = 1; i < r.samples.length; i++) s.push(s[i - 1]! + Math.hypot(r.samples[i]![0] - r.samples[i - 1]![0], r.samples[i]![2] - r.samples[i - 1]![2]));
  return s;
}

/** Half-width of the walk surface at arc length `s` (a verge wanders a little; deterministic). */
export function ribbonHalfWidth(r: Pick<RibbonDoc, "width" | "edge" | "seed" | "style">, s: number, side: -1 | 1): number {
  const hw = r.width / 2;
  if (r.edge === "hard") return hw;
  const amp = r.style === "dirt" ? 0.07 : 0.025;
  const ph = (r.seed % 997) * 0.37 + (side > 0 ? 11.3 : 0);
  const w = 0.55 * Math.sin(s * 0.37 + ph) + 0.3 * Math.sin(s * 0.91 + 2.1 * ph) + 0.15 * Math.sin(s * 2.3 + 0.7 * ph);
  return hw * (1 + amp * w);
}

/** Graded-ground height the patch asks for at sample i (under the walk surface; under every tread on a stair). */
function gradeAt(r: RibbonDoc, s: number[], i: number): number {
  for (const f of r.flights) {
    if (i < f.from || i > f.to) continue;
    return stairRamp(r, f, s[i]!);
  }
  return r.samples[i]![1] - RIBBON_LIFT;
}

// ---------------------------------------------------------------------------------------------------------------
// Grade patch
// ---------------------------------------------------------------------------------------------------------------

export interface RibbonPatch {
  origin: [number, number];
  size: [number, number];
  columns: number;
  rows: number;
  heights: number[];
  weights: number[];
  blend: number;
  afterRivers: true;
  filter: 0;
  feather: number;
  /** Narrowest width (m) of the weighted footprint across the ribbon, for the 6 m rule. */
  minWidth: number;
}

const smoothstep = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/**
 * The masked height patch that grades the ground under a ribbon: levelled `RIBBON_LIFT` under the walk surface out
 * to `RIBBON_CORE_MARGIN` past each edge, then feathered back into the ground over each side's shoulder; up to the
 * wall face (and no further) on a walled side. Raster `cell` metres.
 */
export function ribbonPatch(r: RibbonDoc, cell = 1): RibbonPatch {
  const s = ribbonArc(r);
  const hw = r.width / 2, core = hw + RIBBON_CORE_MARGIN;
  let maxSh = 0;
  let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
  for (const p of r.samples) {
    maxSh = Math.max(maxSh, p[3], p[4]);
    x0 = Math.min(x0, p[0]); z0 = Math.min(z0, p[2]); x1 = Math.max(x1, p[0]); z1 = Math.max(z1, p[2]);
  }
  const reach = core + maxSh + 2;
  x0 = Math.floor(x0 - reach); z0 = Math.floor(z0 - reach); x1 = Math.ceil(x1 + reach); z1 = Math.ceil(z1 + reach);
  while ((x1 - x0) / cell > 1024 || (z1 - z0) / cell > 1024) cell *= 2;
  const columns = Math.ceil((x1 - x0) / cell) + 1, rows = Math.ceil((z1 - z0) / cell) + 1;
  const grade = r.samples.map((_, i) => gradeAt(r, s, i));
  // segment buckets
  const B = 8;
  const buckets = new Map<string, number[]>();
  for (let i = 0; i < r.samples.length - 1; i++) {
    const a = r.samples[i]!, b = r.samples[i + 1]!;
    const bx0 = Math.floor((Math.min(a[0], b[0]) - reach) / B), bx1 = Math.floor((Math.max(a[0], b[0]) + reach) / B);
    const bz0 = Math.floor((Math.min(a[2], b[2]) - reach) / B), bz1 = Math.floor((Math.max(a[2], b[2]) + reach) / B);
    for (let bx = bx0; bx <= bx1; bx++) for (let bz = bz0; bz <= bz1; bz++) {
      const k = `${bx},${bz}`;
      let list = buckets.get(k);
      if (!list) buckets.set(k, (list = []));
      list.push(i);
    }
  }
  const heights = new Array<number>(columns * rows).fill(0);
  const weights = new Array<number>(columns * rows).fill(0);
  let minWidth = Infinity;
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < columns; col++) {
      const x = x0 + col * cell, zz = z0 + row * cell;
      const list = buckets.get(`${Math.floor(x / B)},${Math.floor(zz / B)}`);
      const hits: { d: number; s: number; g: number; w: number }[] = [];
      let nearestG = NaN;
      if (list) {
        const cand: { d: number; s: number; i: number; u: number; side: number }[] = [];
        for (const i of list) {
          const a = r.samples[i]!, b = r.samples[i + 1]!;
          const dx = b[0] - a[0], dz = b[2] - a[2], L2 = dx * dx + dz * dz || 1;
          const u = Math.min(1, Math.max(0, ((x - a[0]) * dx + (zz - a[2]) * dz) / L2));
          const px = a[0] + dx * u, pz = a[2] + dz * u;
          const d = Math.hypot(x - px, zz - pz);
          if (d > reach) continue;
          const side = (x - a[0]) * -dz + (zz - a[2]) * dx >= 0 ? 1 : -1;
          cand.push({ d, s: s[i]! + (s[i + 1]! - s[i]!) * u, i, u, side });
        }
        cand.sort((p, q) => p.d - q.d);
        const taken: number[] = [];
        for (const k of cand) {
          // one hit per branch of the ribbon (a hairpin's two legs both count)
          if (taken.some((ts) => Math.abs(ts - k.s) < reach * 2)) continue;
          taken.push(k.s);
          const a = r.samples[k.i]!, b = r.samples[k.i + 1]!;
          const sh = k.side > 0 ? a[4] + (b[4] - a[4]) * k.u : a[3] + (b[3] - a[3]) * k.u;
          const g = grade[k.i]! + (grade[k.i + 1]! - grade[k.i]!) * k.u;
          // past either end the levelled core rounds off to the tapered tip and the shoulder fans out wide: the foot
          // of a path is worn ground, never a square pad cut into the slope
          // (a stepped path may top out below the hill it climbs, so its foot fans out wider)
          const pastEnd = (k.i === 0 && k.u === 0) || (k.i === r.samples.length - 2 && k.u === 1);
          let w: number;
          if (pastEnd) w = 1 - smoothstep(hw * 0.6, hw * 0.6 + Math.max(Math.abs(sh), r.flights.length ? 10 : 5), k.d);
          else if (sh < 0) w = k.d <= -sh ? 1 : 0;
          else w = 1 - smoothstep(core, core + sh, k.d);
          if (Number.isNaN(nearestG)) nearestG = g;
          if (w > 0) hits.push({ d: k.d, s: k.s, g, w });
        }
      }
      const at = row * columns + col;
      if (!hits.length) {
        // weight 0, but a sane height: bilinear neighbours of the rim must not be pulled toward 0
        if (!Number.isNaN(nearestG)) heights[at] = r3(nearestG);
        continue;
      }
      // inside some branch's levelled core that branch alone decides; between branches (a hairpin's shoulders) blend
      const solid = hits.filter((h) => h.w >= 1);
      const use = solid.length ? [solid.reduce((p, q) => (q.d < p.d ? q : p))] : hits;
      let sw = 0, sg = 0, wmax = 0;
      for (const h of use) { sw += h.w * h.w; sg += h.g * h.w * h.w; wmax = Math.max(wmax, h.w); }
      heights[at] = r3(sg / sw);
      weights[at] = r3(wmax);
    }
  }
  // footprint width: the core plus both shoulders (a walled side counts its levelled strip to the face)
  for (const p of r.samples) {
    const side = (v: number) => (v < 0 ? -v : core + v);
    // a walled causeway (walls both sides) is bounded by kit pieces, not by the patch
    if (p[3] < 0 && p[4] < 0) continue;
    minWidth = Math.min(minWidth, side(p[3]) + side(p[4]));
  }
  return { origin: [x0, z0], size: [(columns - 1) * cell, (rows - 1) * cell], columns, rows, heights, weights, blend: 2, feather: 2, afterRivers: true, filter: 0, minWidth };
}

// ---------------------------------------------------------------------------------------------------------------
// Mesh
// ---------------------------------------------------------------------------------------------------------------

export interface RibbonMesh {
  positions: number[];
  indices: number[];
  uvs: number[];
  /** r, g, b, a per vertex: white, alpha = the verge / end fade (drawn dithered by the `alphaHash` ribbon material). */
  colors: number[];
}

/** Deterministic 1-D value noise in [0, 1] (smooth, period-free), hashed from an integer seed. */
function valueNoise(seed: number, t: number): number {
  const h = (i: number) => {
    let v = (Math.imul(i, 374761393) + Math.imul(seed, 668265263)) | 0;
    v = Math.imul(v ^ (v >>> 13), 1274126177);
    return ((v ^ (v >>> 16)) >>> 0) / 4294967295;
  };
  const i = Math.floor(t), f = t - i, u = f * f * (3 - 2 * f);
  return h(i) + (h(i + 1) - h(i)) * u;
}

/**
 * The worn verge at arc length `s` on one side: `inner` = where the full surface stops (alpha 1), `outer` = where the
 * dithered fade reaches the ground (alpha 0), both metres from the centre line. The outer edge wanders 0.3-0.6 m by
 * deterministic value noise (seed + side), so neighbouring cells and hosts agree. A hard edge has no fade.
 */
export function ribbonVerge(r: Pick<RibbonDoc, "width" | "edge" | "seed" | "style">, s: number, side: -1 | 1): { inner: number; outer: number } {
  const hw = r.width / 2;
  if (r.edge === "hard") return { inner: hw, outer: hw };
  const k = (r.seed % 9973) * 2 + (side > 0 ? 1 : 0);
  const n1 = valueNoise(k, s / 2.6), n2 = valueNoise(k + 7919, s / 0.9);
  const wobble = 0.7 * n1 + 0.3 * n2; // 0..1
  const dirt = r.style === "dirt";
  const outer = hw + (dirt ? 0.3 : 0.15) + (dirt ? 0.3 : 0.25) * wobble;
  const inner = hw - (dirt ? 0.45 : 0.25) + 0.15 * valueNoise(k + 104729, s / 1.7);
  return { inner, outer };
}

/** Taper, round-off and fade length (m) at each end of a ribbon of length L. */
const endLength = (L: number) => Math.min(3, L / 4);

/**
 * The ribbon's walk surface and stair treads inside the XZ rectangle [x0, x1) x [z0, z1), positions relative to
 * (x0, 0, z0). A segment belongs to the cell its midpoint stands in, a tread to the cell of its centre, so
 * neighbouring cells share exact edge vertices and nothing is drawn twice. `uvScale` = metres per texture tile.
 *
 * Look: a verge edge wanders and fades out (vertex alpha) into the graded ground; both ends taper to 60 % width,
 * round off in a fan and fade, so a path melts into the paving or road it meets. A turn is resampled every <= 8
 * degrees and the inside of a tight turn folds into a fan about its centre (offsets capped at 0.92 R), so a hairpin
 * is round, its triangles never flip and its normals stay smooth.
 */
export function ribbonMesh(r: RibbonDoc, x0: number, z0: number, x1: number, z1: number, uvScale: number, tintAt?: (x: number, y: number, z: number) => [number, number, number]): RibbonMesh {
  const s = ribbonArc(r);
  const n = r.samples.length;
  const L = s[n - 1]!;
  const out: RibbonMesh = { positions: [], indices: [], uvs: [], colors: [] };
  const inStair = new Array<boolean>(n).fill(false);
  for (const f of r.flights) for (let i = f.from; i < f.to; i++) inStair[i] = true;
  const theta = (i: number): number => {
    const a = r.samples[Math.max(0, i - 1)]!, b = r.samples[Math.min(n - 1, i + 1)]!;
    return Math.atan2(b[2] - a[2], b[0] - a[0]);
  };
  const kappa = ribbonCurvature({ x: r.samples.map((p) => p[0]), z: r.samples.map((p) => p[2]), s });
  const hard = r.edge === "hard";
  const skirt = 0.04, drop = 0.1;
  const crown = r.style === "dirt" ? 0.015 : 0.03;
  const inCell = (x: number, z: number) => x >= x0 && x < x1 && z >= z0 && z < z1;
  const T = endLength(L);
  // trodden dirt darkens toward its worn rim (the verge), so the lighter centre reads as a path from afar
  const rimShade = r.style === "dirt" ? RIBBON_DIRT_RIM : 1;
  const vert = (x: number, y: number, z: number, u: number, v: number, a: number, shade = 1): number => {
    out.positions.push(r3(x - x0), r3(y), r3(z - z0));
    out.uvs.push(r3(u / uvScale), r3(v / uvScale));
    const t = tintAt ? tintAt(x, y, z) : [1, 1, 1];
    out.colors.push(r3(t[0]! * shade), r3(t[1]! * shade), r3(t[2]! * shade), r3(Math.min(1, Math.max(0, a))));
    return out.positions.length / 3 - 1;
  };
  // a triangle wound counter-clockwise seen from above, whatever order it comes in
  const tri = (a: number, b: number, c: number) => {
    const P = out.positions;
    const ax = P[a * 3]!, az = P[a * 3 + 2]!;
    const cross = (P[b * 3 + 2]! - az) * (P[c * 3]! - ax) - (P[b * 3]! - ax) * (P[c * 3 + 2]! - az);
    if (Math.abs(cross) < 1e-9) return; // degenerate (a folded inner fan point): nothing to draw or collide
    if (cross > 0) out.indices.push(a, b, c);
    else out.indices.push(a, c, b);
  };
  /** One cross-section at arc length sv: 5 vertices left verge -> right verge. */
  const ring = (px: number, py: number, pz: number, th: number, sv: number, kap: number): number[] => {
    const tx = Math.cos(th), tz = Math.sin(th);
    const nx = -tz, nz = tx; // right of travel
    const te = smoothstep(0, T, Math.min(sv, L - sv));
    const wf = 0.6 + 0.4 * te, af = 0.25 + 0.75 * te;
    const ids: number[] = [];
    const sides: [number, number, number][] = []; // [offset, dy, alpha] left to right
    for (const side of [-1, 1] as const) {
      const v = ribbonVerge(r, sv, side);
      const edge = hard ? ribbonHalfWidth(r, sv, side) : v.inner;
      const rim = hard ? edge + skirt : v.outer;
      // the inside of a tight turn folds into a fan about the centre of the turn
      const cap = side * kap > 1e-3 ? 0.92 / (side * kap) : Infinity;
      const pair: [number, number, number][] = [
        [side * Math.min(edge * wf, cap), 0, af],
        [side * Math.min(rim * wf, cap), hard ? -drop : -0.02, hard ? af : 0],
      ];
      if (side < 0) sides.push(pair[1]!, pair[0]!);
      else { sides.push([0, crown, af]); sides.push(...pair); }
    }
    for (const [o, dy, a] of sides) ids.push(vert(px + nx * o, py + dy, pz + nz * o, o, sv, a, o === 0 ? 1 : rimShade));
    return ids;
  };
  const stationRings = (i: number, t: number): number[] => {
    const a = r.samples[i]!, b = r.samples[i + 1]!;
    let dth = theta(i + 1) - theta(i);
    while (dth > Math.PI) dth -= 2 * Math.PI;
    while (dth < -Math.PI) dth += 2 * Math.PI;
    return ring(a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t, theta(i) + dth * t, s[i]! + (s[i + 1]! - s[i]!) * t, kappa[i]! + (kappa[i + 1]! - kappa[i]!) * t);
  };
  const strip = (A: number[], B: number[]) => {
    for (let k = 0; k < A.length - 1; k++) { tri(A[k]!, A[k + 1]!, B[k]!); tri(B[k]!, A[k + 1]!, B[k + 1]!); }
  };
  /** Half-disc fan off an end ring (dir +1 = forward past the last sample, -1 = back past the first). */
  const endCap = (R: number[], i: number, dir: 1 | -1) => {
    const p = r.samples[i]!, th = theta(i);
    const tx = Math.cos(th) * dir, tz = Math.sin(th) * dir;
    const nx = -Math.sin(th), nz = Math.cos(th);
    const P = out.positions;
    const rad = Math.hypot(P[R[0]! * 3]! - P[R[2]! * 3]!, P[R[0]! * 3 + 2]! - P[R[2]! * 3 + 2]!);
    const rimIds = [R[0]!];
    for (let q = 1; q < 8; q++) {
      const ang = (q / 8) * Math.PI; // from the left rim, round the tip, to the right rim
      const ox = -nx * Math.cos(ang) + tx * Math.sin(ang), oz = -nz * Math.cos(ang) + tz * Math.sin(ang);
      const o = -Math.cos(ang) * rad;
      rimIds.push(vert(p[0] + ox * rad, p[1] - 0.02, p[2] + oz * rad, o, s[i]! + dir * Math.sin(ang) * rad, 0, rimShade));
    }
    rimIds.push(R[4]!);
    for (let q = 0; q < rimIds.length - 1; q++) tri(R[2]!, rimIds[q]!, rimIds[q + 1]!);
  };
  let prev: number[] | null = null;
  for (let i = 0; i < n - 1; i++) {
    const a = r.samples[i]!, b = r.samples[i + 1]!;
    if (inStair[i] || !inCell((a[0] + b[0]) / 2, (a[2] + b[2]) / 2)) { prev = null; continue; }
    let dth = theta(i + 1) - theta(i);
    while (dth > Math.PI) dth -= 2 * Math.PI;
    while (dth < -Math.PI) dth += 2 * Math.PI;
    const steps = Math.min(8, Math.max(1, Math.ceil(Math.abs(dth) / ((8 * Math.PI) / 180))));
    let A: number[] = prev ?? stationRings(i, 0);
    if (i === 0 && !hard) endCap(A, 0, -1);
    for (let k = 1; k <= steps; k++) {
      const B = stationRings(i, k / steps);
      strip(A, B);
      A = B;
    }
    if (i === n - 2 && !hard) endCap(A, n - 1, 1);
    prev = A;
  }
  // stair treads: a solid per tread (top, a sloped flank down to the graded ramp each side, both ends), buried below the
  // ramp. The ramp beside a flight lies under the LOWEST tread within 1.1 m (up to ~0.6 m under a tread top), so a
  // vertical tread side would stand proud of it: a lip that snags a body approaching on the diagonal and draws a long
  // shaded line down the flight. The flank slopes from the tread edge to the ramp instead (<= ~1:2, faded like the
  // verge), and each end face closes the full profile so a higher tread's flank never leaves a notch over a lower one.
  for (const f of r.flights) {
    const at = (sv: number): { x: number; z: number; tx: number; tz: number; s: number } => {
      let i = f.from;
      while (i < f.to - 1 && s[i + 1]! < sv) i++;
      const u = Math.min(1, Math.max(0, (sv - s[i]!) / (s[i + 1]! - s[i]! || 1)));
      const a = r.samples[i]!, b = r.samples[i + 1]!;
      const dx = b[0] - a[0], dz = b[2] - a[2], l = Math.hypot(dx, dz) || 1;
      return { x: a[0] + dx * u, z: a[2] + dz * u, tx: dx / l, tz: dz / l, s: sv };
    };
    const before = r.samples[f.from]![1];
    const foot = (sv: number) => stairRamp(r, f, sv) - RIBBON_STAIR_FOOT;
    let drop = 0;
    for (const [sa, sb, top] of f.treads) drop = Math.max(drop, top - foot(sa), top - foot(sb));
    const run = Math.min(RIBBON_CORE_MARGIN + 0.8, Math.max(0.6, drop * 2.2));
    const hw = r.width / 2;
    const fade = hard ? 1 : 0;
    f.treads.forEach(([sa, sb, top], k) => {
      const mid = at((sa + sb) / 2);
      if (!inCell(mid.x, mid.z)) return;
      const prevTop = k === 0 ? before : f.treads[k - 1]![2];
      const nextTop = k === f.treads.length - 1 ? top : f.treads[k + 1]![2];
      const A = at(sa), Bp = at(sb);
      const fa = foot(sa), fb = foot(sb);
      const bottom = Math.min(prevTop, nextTop, top, fa, fb) - f.rise - 0.35;
      const corner = (p: typeof A, o: number, y: number): [number, number, number] => [p.x - p.tz * o, y, p.z + p.tx * o];
      /** A planar polygon, fanned from its first vertex; `up` = wound counter-clockwise from above (tops and flanks). */
      const poly = (v: [number, number, number][], uv: [number, number][], alpha: number[], up: boolean) => {
        const base = out.positions.length / 3;
        v.forEach((p, q) => {
          out.positions.push(r3(p[0] - x0), r3(p[1]), r3(p[2] - z0));
          out.uvs.push(r3(uv[q]![0] / uvScale), r3(uv[q]![1] / uvScale));
          const t = tintAt ? tintAt(p[0], p[1], p[2]) : [1, 1, 1];
          out.colors.push(r3(t[0]!), r3(t[1]!), r3(t[2]!), alpha[q]!);
        });
        for (let q = 1; q < v.length - 1; q++) {
          if (up) tri(base, base + q, base + q + 1);
          else out.indices.push(base, base + q, base + q + 1);
        }
      };
      // top
      poly([corner(A, -hw, top), corner(A, hw, top), corner(Bp, hw, top), corner(Bp, -hw, top)], [[-hw, sa], [hw, sa], [hw, sb], [-hw, sb]], [1, 1, 1, 1], true);
      // flanks: tread edge down to the ramp, faded at the foot like the verge
      for (const side of [-1, 1] as const) {
        const e = side * hw, o = side * (hw + run);
        poly([corner(A, e, top), corner(Bp, e, top), corner(Bp, o, fb), corner(A, o, fa)], [[e, sa], [e, sb], [o, sb], [o, sa]], [1, 1, fade, fade], true);
      }
      // start face (faces -travel) and end face (faces +travel): the whole profile, down to the buried bottom
      const W = hw + run;
      poly([corner(A, -W, bottom), corner(A, W, bottom), corner(A, W, fa), corner(A, hw, top), corner(A, -hw, top), corner(A, -W, fa)],
        [[-W, bottom], [W, bottom], [W, fa], [hw, top], [-hw, top], [-W, fa]], [1, 1, fade, 1, 1, fade], false);
      poly([corner(Bp, W, bottom), corner(Bp, -W, bottom), corner(Bp, -W, fb), corner(Bp, -hw, top), corner(Bp, hw, top), corner(Bp, W, fb)],
        [[W, bottom], [-W, bottom], [-W, fb], [-hw, top], [hw, top], [W, fb]], [1, 1, fade, 1, 1, fade], false);
    });
  }
  return out;
}


// ---------------------------------------------------------------------------------------------------------------
// Chunk emission
// ---------------------------------------------------------------------------------------------------------------

export interface RibbonSurfaceResolver {
  /** Palette surface name whose tile a ribbon draws (its `surface`, else the zone tile its style picks). */
  surfaceOf(r: RibbonDoc): string;
  /** Metres per texture tile of a palette surface. */
  uvScaleOf(name: string): number;
  /** A default dirt ribbon (trodden earth): the tile it wears (the zone's road, else ground), drawn by a `--trodden` material; else null. */
  troddenToward?(r: RibbonDoc): string | null;
  /** Biome tint (linear rgb) the terrain draws its tiles with at a point: ribbon vertices carry it in rgb. */
  tintAt?(x: number, y: number, z: number): [number, number, number];
  /** Stone the ribbon's retaining walls wear (a cliff surface name), or null for the kit's own. */
  wallSkinOf?(r: RibbonDoc): string | null;
}

/**
 * Material asset id a ribbon draws with (`worldgen-ribbon materials` writes them): the palette surface's own tile at
 * the terrain's own tint and roughness, vertex alpha dithered; `--trodden` = a smoothed, slightly lifted copy of the tile (worldgen-ribbon materials writes it).
 */
export const ribbonMaterialId = (name: string, troddenToward?: string | null): string => (troddenToward ? `ribbon/${name}--trodden` : `ribbon/${name}`);

/** Material a ribbon wall of zone stone `skin` wears in place of the kit's rubble / ashlar (one per stone and kind). */
export const ribbonWallMaterialId = (skin: string, kind: "rubble" | "ashlar"): string => `ribbon-wall/${skin}-${kind}`;

/**
 * Overrides that dress one kit wall piece in the zone's stone: the body (rubble on `common`, ashlar on `stone`), the
 * coping cap (ashlar) and a common end piece's ashlar trim. None when `skin` is null (the kit's own stone).
 */
export function wallSkinOverrides(p: { prefab: string; role: string }, skin: string | null): { path: string; value: unknown }[] {
  if (!skin) return [];
  const common = p.prefab.includes("/common-");
  const body = p.role === "cap" || !common ? "ashlar" : "rubble";
  const out: { path: string; value: unknown }[] = [{ path: "piece/components/mesh/material", value: ribbonWallMaterialId(skin, body) }];
  if (common && (p.role === "end-l" || p.role === "end-r")) out.push({ path: "trim-ashlar/components/mesh/material", value: ribbonWallMaterialId(skin, "ashlar") });
  return out;
}

/**
 * Every ribbon segment, stair and wall piece standing in cell (cx, cz): one static `surface` mesh per ribbon (the
 * static batcher merges them per material: one draw per surface style) with a trimesh collider from the same
 * triangles, plus the wall pieces as collapsed prefab instances.
 */
export function ribbonEntities(
  ribbons: readonly RibbonDoc[] | undefined,
  surfaces: RibbonSurfaceResolver,
  cellSize: number,
  cx: number,
  cz: number,
  entities: ChunkDoc["entities"],
  assetExists?: (assetId: string, kind: "prefab" | "model") => boolean,
): void {
  if (!ribbons?.length) return;
  const x0 = cx * cellSize, z0 = cz * cellSize, x1 = x0 + cellSize, z1 = z0 + cellSize;
  for (const r of ribbons) {
    let bx0 = Infinity, bz0 = Infinity, bx1 = -Infinity, bz1 = -Infinity;
    for (const p of r.samples) { bx0 = Math.min(bx0, p[0]); bz0 = Math.min(bz0, p[2]); bx1 = Math.max(bx1, p[0]); bz1 = Math.max(bz1, p[2]); }
    if (bx1 < x0 - 8 || bx0 > x1 + 8 || bz1 < z0 - 8 || bz0 > z1 + 8) continue;
    const name = surfaces.surfaceOf(r);
    const toward = surfaces.troddenToward?.(r) ?? null;
    const skin = surfaces.wallSkinOf?.(r) ?? null;
    const scale = surfaces.uvScaleOf(name) * (r.style === "slab" ? 1.6 : 1);
    const mesh = ribbonMesh(r, x0, z0, x1, z1, scale, surfaces.tintAt?.bind(surfaces));
    const key = r.id.replace(/[^a-zA-Z0-9_-]/g, "_");
    if (mesh.indices.length) {
      entities[`ribbon_${key}`] = {
        name: `${r.id} ribbon`,
        parent: null,
        tags: ["ribbon", r.style],
        components: {
          transform: { position: [0, 0, 0] },
          mesh: {
            source: { kind: "surface", positions: mesh.positions, indices: mesh.indices, uvs: mesh.uvs, colors: mesh.colors },
            material: ribbonMaterialId(name, toward),
            static: true,
            castShadow: false,
            receiveShadow: true,
          },
          collider: { shape: "trimesh" },
        },
      };
    }
    r.pieces.forEach((p, i) => {
      const [x, y, zz] = p.position;
      if (Math.floor(x / cellSize) !== cx || Math.floor(zz / cellSize) !== cz) return;
      if (assetExists && !assetExists(p.prefab, "prefab")) return;
      const half = (p.yaw * Math.PI) / 360;
      entities[`ribbon_${key}_w${i}`] = {
        name: `${r.id} ${p.role}`,
        parent: null,
        tags: ["ribbon-wall", r.id],
        components: {
          transform: { position: [x - x0, y, zz - z0], rotation: [0, Math.sin(half), 0, Math.cos(half)] },
          prefab: { prefabId: p.prefab, props: {}, overrides: [...(p.overrides ?? []), ...wallSkinOverrides(p, skin)] },
        },
      };
    });
  }
}

/**
 * `wall` — a SWEPT WALL (or causeway ramp) along a plan line: one cross-section profile (thickness, height, batter,
 * coping, footing) swept along a spline at ~1 m stations, with per-block seeded irregularity (thickness, height, lean),
 * bevelled coping/footing/pier/buttress edges, buttresses every N m, a crenellated parapet, gates at stations, a stair
 * flight along the face, ends that run into the terrain or stop in a pier, sharp MITRED corners on straight legs
 * (`smooth: false`; a closed ring when the last point is the first). `variant: "ramp"` is a sloped causeway deck
 * with kerbs/parapet whose steep stretches become stair flights (risers <= the body's 0.4 m step).
 *
 * It is a BUILT landmark: the generator below emits closed triangle solids (one mesh node per role) with explicit UVs
 * in metres (u along the wall, v up: the role tile = texture px / 40 texels per m), and the operator compiles through
 * the `landmark` operator (`kind: "built"`), so the bake (tools/landmark.mts), its per-cell collider tiles, the reach
 * loop and op-preview are the landmark's own. Agents write the line and a few numbers, never boxes.
 *
 * Geometry is authored in WALL SPACE (s along the line, y up, n to the right of travel) and warped onto the plan
 * curve: x,z = P(s) + n R(s). (s, y, n) is right-handed like (x, y, z), so box-style UVs in wall space read the same
 * way as a built box's (u to the viewer's right, v up).
 */
import { z } from "zod";
import { registerOperator, type OperatorFieldReader, type OperatorOutput, type OperatorPiece } from "./operator-registry.js";
import { registerLandmarkGenerator, type LandmarkSpec } from "./landmark-stamp.js";
import { compileLandmark, landmarkOperatorSchema, type LandmarkOperatorParams } from "./operators-landmark.js";
import { landmarkComponentSchema } from "../components/landmark.js";
import { compileTriangleMesh } from "./triangle-mesh.js";

const num = z.number().finite();
const xz = z.tuple([num, num]);
const xyz = z.tuple([num, num, num]);

/** Culture scale: course/block sizes and the defaults that follow from them (giant work = giant blocks). */
export const WALL_SCALE = {
  human: { segment: 2.4, bevel: 0.06, cap: [0.3, 0.08], footing: [0.6, 0.25, 0.3], jitter: [0.06, 0.1, 0.6], minFaceTile: 1.2 },
  giant: { segment: 7, bevel: 0.25, cap: [0.9, 0.3], footing: [2, 0.8, 0.8], jitter: [0.35, 0.5, 1.0], minFaceTile: 4.8 },
} as const;

export const wallParamsSchema = z.object({
  variant: z.enum(["free", "retaining", "quay", "ramp"]).default("free").describe("`free`: free-standing, both faces exposed and battered. `retaining`: one face exposed (`face`), earth behind (optional `backfill`). `quay`: a retaining embankment facing water (top defaults to sea level + `height`, footing down to the bed). `ramp`: a sloped causeway deck (`ramp` block) with kerbs/parapet; steep stretches become stair flights."),
  points: z.array(xz).min(2).max(96).describe("Plan line, world XZ, in order of travel (`face: right` = the right-hand side when walking from the first point). Last point = first (>= 4 points, not `ramp`): a CLOSED ring (a town wall round a court): no ends, the closing corner mitred like the others, the jitter wraps."),
  smooth: z.boolean().default(true).describe("true: a centripetal Catmull-Rom spline through the points (bends only: radius >= the half-width, else the inner face folds; the report warns). false: straight legs with SHARP MITRED corners at any angle up to 135 deg: every face, batter, footing, coping and parapet meets its continuation on the corner's mitre plane (inside corners included), UVs run on round the corner, and a leg shorter than its section (a jog, a landing) is clipped where its mitres meet. Use false for buildings' corners, town-wall rings, bastions and switchbacks."),
  scale: z.enum(["human", "giant"]).default("human").describe("Culture scale. Sets the block length of the irregularity, the bevel, coping and footing defaults, and the face texture course check (giant work wants a giant-block face texture: tile >= 4.8 m = 192 px at 40 texels/m; human >= 1.2 m)."),
  height: num.min(0.3).max(80).default(4).describe("Wall: height of the top above the face-side ground, metres (quay: above sea level). Ramp: ignored (see `ramp.levels`)."),
  heightMode: z.enum(["follow", "step", "level"]).default("follow").describe("`follow`: the top runs at ground + height, smoothed over ~12 m. `step`: the top is level per block and steps with the ground (quantum `stepRise`). `level`: one top height (`topY`, else median ground + height)."),
  topY: num.optional().describe("`level` mode (and `quay`): absolute world Y of the top."),
  stepRise: num.min(0.1).max(4).default(0.5).describe("`step` mode: the top is rounded to this many metres per block."),
  stepLength: num.min(2).max(40).optional().describe("`step` mode: block length, metres (default: the scale's block length, x2)."),
  thickness: num.min(0.3).max(30).default(1.2).describe("Wall: thickness at the top, metres. Ramp: the deck width (kerb to kerb outside)."),
  batter: num.min(0).max(0.4).default(0.06).describe("Face batter: extra thickness per metre of height at the foot (each exposed face; retaining: the face only)."),
  face: z.enum(["right", "left"]).default("right").describe("`retaining`/`quay`: the exposed side (right/left of travel); the other is earth or fill. `free`: the side buttresses and stairs go on by default."),
  bevel: num.min(0).max(1).optional().describe("Chamfer on coping, footing, pier, buttress and merlon edges, metres (default by scale: human 0.06, giant 0.25)."),
  step: num.min(0.5).max(4).default(1).describe("Station spacing along the line, metres (the sweep resolution; openings and arches add their own stations)."),
  cap: z.object({
    height: num.min(0.1).max(4).optional().describe("Coping height (default by scale: 0.3 / 0.9 m)."),
    overhang: num.min(0).max(1.5).optional().describe("Overhang past the face(s) (default 0.08 / 0.3 m)."),
  }).strict().nullable().default({}).describe("Coping on the top (role `cap`); null = none (the body's top is bare)."),
  footing: z.object({
    depth: num.min(0.2).max(20).optional().describe("Below the lowest ground under the foot (default 0.6 / 2 m); the bake trims what is buried > 1.5 m."),
    projection: num.min(0).max(4).optional().describe("Projection past the exposed face(s) (default 0.25 / 0.8 m)."),
    plinth: num.min(0).max(4).optional().describe("Height of the footing's top above the face-side ground (default 0.3 / 0.8 m)."),
  }).strict().nullable().default({}).describe("Footing that follows the terrain (role `footing`); null = none (the body still runs `depth` into the ground)."),
  bury: num.min(0.2).max(20).optional().describe("With `footing: null`: how far the body runs under the lowest ground, metres (default the scale's footing depth, 0.6 / 2). Built pieces that cross (a tower on a curtain's corner) take different depths so their buried undersides never lie in one plane (zfight)."),
  buttresses: z.object({
    every: num.min(3).max(80).describe("Spacing along the wall, metres."),
    depth: num.min(0.3).max(12).default(1.2).describe("Projection from the face at the foot."),
    width: num.min(0.3).max(12).default(1.2).describe("Width along the wall."),
    taper: num.min(0).max(1).default(0.35).describe("Top projection = depth x taper (a sloped weathering)."),
    below: num.min(0).max(20).default(0.6).describe("The buttress top stops this far under the wall top."),
    side: z.enum(["face", "both"]).default("face").describe("`face` (the exposed side) or `both` (free walls; ramps: both sides of the body)."),
    minHeight: num.min(0).max(60).default(0).describe("Build a buttress only where the exposed face stands at least this tall above its own ground, metres (a ramp's tall retaining faces get them, its low stretches stay plain)."),
    arches: z.object({
      tier: num.min(2).max(40).nullable().default(null).describe("Vertical spacing of stacked arch rows, metres (each row's top is a set-back course); null: one row under the buttress tops."),
      band: num.min(0.2).max(3).default(0.5).describe("Solid course over each arch's crown, metres."),
      projection: num.min(0.2).max(3).default(0.5).describe("How far an arch row stands out of the face (always at least 0.2 m less than the buttresses beside it there)."),
    }).strict().nullable().default(null).describe("Ramp: BLIND ARCHES (role `buttress`) spanning between neighbouring buttresses on one side (a blind arcade: the face reads as recessed bays), a row under the tops and, with `tier`, more rows down the face while the springing stays >= 1.5 m over the ground."),
  }).strict().nullable().default(null).describe("Buttresses (role `buttress`) on the face, skipped inside openings, at piers and at sharp corners (a corner stiffens itself). Ramp: on the body's sides under the deck; the depth shrinks so a buttress never reaches the line's other legs (switchbacks)."),
  parapet: z.object({
    height: num.min(0.3).max(4).default(1.1).describe("Parapet height above the walk (the coping top), metres."),
    thickness: num.min(0.2).max(3).default(0.45).describe("Parapet thickness."),
    side: z.enum(["face", "back", "both"]).default("face").describe("Which edge(s) of the walk carry a parapet."),
    crenels: z.object({
      merlon: num.min(0.3).max(6).default(1.4).describe("Merlon length along the wall."),
      gap: num.min(0.3).max(6).default(0.8).describe("Crenel (gap) length."),
      height: num.min(0.2).max(4).default(0.7).describe("Merlon height above the parapet."),
    }).strict().nullable().default(null).describe("Crenellation on the parapet; null = a plain parapet."),
    walked: z.boolean().default(true).describe("false: a crenellated top SEEN, not walked (a keep or tower top no stair reaches): the bake declares no `walk-mid` reach target. true: a walkway, which the bake requires a body can reach (a stair)."),
  }).strict().nullable().default(null).describe("A parapet on the top making it a walkway (role `parapet`, merlons `merlon`). Ramp: replaces the kerb on that side."),
  openings: z.array(z.object({
    name: z.string().describe("Label."),
    at: num.describe("Station of the opening's centre, metres along the line from the first point."),
    width: num.min(0.8).max(30).describe("Clear width."),
    height: num.min(1.5).max(40).describe("Clear height above the ground at its centre (arch: the crown)."),
    arch: z.boolean().default(true).describe("true: a round-arched head (springing at height - width/2); false: a flat lintel."),
    sill: num.min(0).max(38).default(0).describe("Bottom of the opening above the ground at its centre, metres: 0 = a gate/door (ground passes under); > 0 = a WINDOW or arrow slit, the body runs on under it up to the sill (height is still the head above the ground; at least 0.6 m clear)."),
  }).strict()).max(12).default([]).describe("Gates/openings through the wall body: the body ends in reveals, a lintel/arch spans the gap, the coping runs over it; ground passes under a gate (sill 0), the body under a window (sill > 0)."),
  ends: z.object({
    start: z.enum(["terrain", "pier", "none"]).default("terrain").describe("`terrain`: run `tie` m on past the point at the end's top height (into a hillside; the buried part is trimmed). `pier`: stop in a pier. `none`: a plain end."),
    end: z.enum(["terrain", "pier", "none"]).default("terrain"),
    tie: num.min(0).max(60).optional().describe("`terrain` ends: metres run on past the point (default 2 x thickness + 2)."),
    pierWidth: num.min(0.5).max(20).optional().describe("Pier length along the wall (default thickness + 0.8)."),
    pierProjection: num.min(0).max(6).default(0.4).describe("Pier projection past each face."),
    pierRise: num.min(0).max(10).default(0.6).describe("Pier top above the wall top."),
  }).strict().prefault({}).describe("How each end finishes."),
  stairs: z.array(z.object({
    from: num.describe("Station where the flight starts (on the ground)."),
    to: num.describe("Station where it reaches the wall top (the walk); may be < from (a flight running back along the line)."),
    width: num.min(0.8).max(8).default(1.6).describe("Flight width out from the face."),
    riser: num.min(0.1).max(0.4).default(0.28).describe("Riser height (<= 0.4: the body's step)."),
    side: z.enum(["face", "back"]).default("face").describe("Which face the flight runs along."),
  }).strict()).max(8).default([]).describe("Stair flights along a face (role `stair`), from the ground to the walk. Keep a flight on one straight leg: treads that would run round a corner are left out (warned)."),
  irregularity: z.object({
    thickness: num.min(0).max(3).optional().describe("Max +- thickness change per block (default 0.06 / 0.35 m)."),
    height: num.min(0).max(4).optional().describe("Max +- top height change per block (default 0.1 / 0.5 m)."),
    lean: num.min(0).max(6).optional().describe("Max +- face lean per block, degrees (default 0.6 / 1.0)."),
    segment: num.min(0.5).max(40).optional().describe("Block length, metres (default 2.4 / 7)."),
  }).strict().prefault({}).describe("Seeded per-block jitter within bounds so it reads hand-made (zeros = machine-straight)."),
  backfill: z.object({
    width: num.min(6).max(60).default(8).describe("Earth raised behind the wall to just under the coping, metres (>= 6 m: the 6 m rule)."),
    feather: num.min(4).max(80).default(12).describe("Feather back to the natural ground."),
  }).strict().nullable().default(null).describe("`retaining`/`quay`: raise the ground behind the wall (one masked height patch, only ever up)."),
  ramp: z.object({
    levels: z.array(z.object({
      at: z.union([num, z.literal("end")]).describe("Station, metres along the line, or `end`."),
      y: num.optional().describe("Deck top, world Y. Omit: the ground there + 0.05."),
    }).strict()).max(32).default([]).describe("Deck heights, linear between them (sorted by `at`). Default: the ground at both ends. With `followGround` the deck follows the smoothed ground between levels instead."),
    followGround: z.boolean().default(false).describe("Deck follows the smoothed ground (+ lift) between the levels."),
    lift: num.min(0).max(20).default(0.05).describe("followGround: deck height above the smoothed ground."),
    maxGrade: num.min(0.05).max(1).default(0.45).describe("Steepest walkable deck slope (rise/run). Steeper stretches become stair flights."),
    riser: num.min(0.1).max(0.4).default(0.3).describe("Stair riser in the flights (<= 0.4: the body's step)."),
    stairGrade: num.min(0.3).max(1).default(0.5).describe("Steepest flight (riser / tread; 0.5 = 0.6 m treads at 0.3 m risers). Where the levels or the ground climb faster, the deck is raised into a built-up causeway so the flights fit."),
    deck: num.min(0.1).max(2).default(0.35).describe("Paving slab thickness (role `deck`) on the body."),
    kerb: z.object({ height: num.min(0.05).max(1.5).default(0.3), width: num.min(0.15).max(2).default(0.45) }).strict().nullable().prefault({}).describe("Kerbs on both deck edges (role `kerb`); a parapet replaces it on its side."),
    cut: z.object({ feather: num.min(4).max(60).default(8).describe("Bank feather from the deck edge back to the natural ground."), calm: z.boolean().optional().describe("true: the cut is built ground: the terrain's overhang noise is off over it (heightPatch `calm`), so no rock heaves through the deck or the flights where the stair runs down a cliff (the noise adds up to `terrain.overhang.strength` metres on steep ground).") }).strict().nullable().prefault({}).describe("Lower the ground that rises over the deck (a causeway along a slope) under the slab, feathered back up the bank (one masked height patch, only ever down); null = leave the ground."),
  }).strict().prefault({}).describe("`variant: ramp` only. With `smooth: false` every corner gets a LEVEL LANDING across its mitre (|tan(turn/2)| x (half-width + 0.5) + 0.6 m each side; corners that close merge into one landing): a SWITCHBACK stair is a leg, two 90 deg corners round a short landing leg (legs >= deck width + 0.5 m apart), the reversed leg; put `levels` at the corners (report.landings)."),
  materials: z.record(z.string(), z.union([z.string(), z.array(z.string()).min(1).max(8)])).default({}).describe("Role -> material (the landmark material values: `zone`, `surface:<name>`, or a material asset id). Assign coherent materials by architectural purpose: continuous wall faces, distinct supports, coping, footings and paving. A LIST of 2-8 materials explicitly opts a role into spatial alternation (`materialBand`); this is an authored pattern, not a fix for repeating textures or a way to satisfy variety counts. Roles: face, cap, footing, buttress, pier, parapet, merlon, stair, deck, kerb. Unset: buttress/pier/parapet/merlon/stair/kerb -> face, deck -> cap -> face, footing -> face. A list's k-th entry (k >= 2) is the landmark role `<role>~k`."),
  materialBand: z.union([num.min(2).max(500), z.literal("leg")]).default(16).describe("Variant materials (a list in `materials`): the band length along the line, metres, rounded so the line divides into whole cycles and every variant covers the same length. Sweeps (face, cap, footing, deck slab, parapet...) are split square at band edges (never inside a corner's mitre zone); single solids (treads, buttresses, merlons) take the band under their middle. `leg` (straight legs, `smooth: false`): the variant changes at the corners, one per LEG as built (a leg shorter than 2 x `thickness` + 2 m, a landing or a jog, keeps the leg before it's), so a switchback's legs differ and no band runs across a face."),
  materialOffset: z.number().int().min(0).max(7).default(0).describe("Variant materials: start the cycle at this entry (lines that continue one another, e.g. a stair split into several ops, carry on where the last one ended)."),
  targets: z.array(z.object({ name: z.string(), at: xyz.describe("WORLD walkable point.") })).max(32).default([]).describe("Walkable points the baked collider must reach (tools/landmark.mts reach loop). Ramp: foot, middle and head of the deck are added automatically."),
  seed: z.number().int().default(1).describe("Irregularity seed (combined with the world seed and the id)."),
  fog: landmarkComponentSchema.optional().describe("As the landmark operator's `fog`: stands as a darker silhouette through zone fog."),
}).strict();
export type WallParams = z.infer<typeof wallParamsSchema>;

// ------------------------------------------------------------------------------------------------ plan curve
type P2 = [number, number];
/**
 * A sharp corner of a straight-leg (`smooth: false`) line at station `s`: the line turns by `turn` radians (signed,
 * from the incoming to the outgoing tangent in XZ), `k` = tan(turn / 2) (clamped to +-tan 67.5 deg). In wall space
 * the MITRE through the corner is s = s_c - k n on the incoming leg and s = s_c + k n on the outgoing one: a section
 * point at offset n ends there, so every face, batter, footing and coping meets its continuation on one shared plane
 * (inside faces shorter, outside faces longer).
 */
interface Corner { s: number; k: number; turn: number; point: number; closure: boolean }
export interface Curve {
  length: number;
  at(s: number): { x: number; z: number; tx: number; tz: number };
  minRadius: number;
  /** Sharp corners (straight legs only), ascending s; a closed loop lists its closing corner at 0 and at `length`. */
  corners: Corner[];
  closed: boolean;
  /** The leg a solid spanning around `s` is built in (straight legs; 0 for a spline). */
  legAt(s: number): number;
  /** World XZ of wall-space (s, n) on leg `leg`'s straight line, extended past its ends (a spline: the curve frame). */
  map(s: number, n: number, leg: number): P2;
  /** Sum of k over the corners before leg `leg` (the developed length along an offset line loses 2 k n per corner). */
  legK(leg: number): number;
}

const MAX_K = Math.tan((67.5 * Math.PI) / 180);

export function wallPlanCurve(points: readonly P2[], smooth: boolean, closed: boolean): Curve { return planCurve(points, smooth, closed); }
function planCurve(points: readonly P2[], smooth: boolean, closed: boolean): Curve {
  const pts = points.filter((p, i) => i === 0 || Math.hypot(p[0] - points[i - 1]![0], p[1] - points[i - 1]![1]) > 1e-6);
  if (!smooth || pts.length < 3) return polyline(pts, closed);
  const dense: P2[] = [];
  const P = closed
    ? [pts.at(-2)!, ...pts, pts[1]!]
    : [[2 * pts[0]![0] - pts[1]![0], 2 * pts[0]![1] - pts[1]![1]] as P2, ...pts, [2 * pts.at(-1)![0] - pts.at(-2)![0], 2 * pts.at(-1)![1] - pts.at(-2)![1]] as P2];
  for (let i = 1; i + 2 < P.length; i++) {
    const p0 = P[i - 1]!, p1 = P[i]!, p2 = P[i + 1]!, p3 = P[i + 2]!;
    const kt = (a: P2, b: P2) => Math.sqrt(Math.max(1e-9, Math.hypot(b[0] - a[0], b[1] - a[1]))); // centripetal
    const t0 = 0, t1 = t0 + kt(p0, p1), t2 = t1 + kt(p1, p2), t3 = t2 + kt(p2, p3);
    const n = Math.max(2, Math.ceil(Math.hypot(p2[0] - p1[0], p2[1] - p1[1]) / 0.25));
    for (let k = 0; k < n; k++) {
      const t = t1 + ((t2 - t1) * k) / n;
      const L = (a: P2, b: P2, ta: number, tb: number): P2 => [((tb - t) * a[0] + (t - ta) * b[0]) / (tb - ta), ((tb - t) * a[1] + (t - ta) * b[1]) / (tb - ta)];
      const A1 = L(p0, p1, t0, t1), A2 = L(p1, p2, t1, t2), A3 = L(p2, p3, t2, t3);
      const B1 = L(A1, A2, t0, t2), B2 = L(A2, A3, t1, t3);
      dense.push(L(B1, B2, t1, t2));
    }
  }
  dense.push(pts.at(-1)!);
  const cum = [0];
  for (let i = 1; i < dense.length; i++) cum.push(cum[i - 1]! + Math.hypot(dense[i]![0] - dense[i - 1]![0], dense[i]![1] - dense[i - 1]![1]));
  const length = cum.at(-1)!;
  const tan = (i: number): P2 => {
    const a = dense[Math.max(0, i - 1)]!, b = dense[Math.min(dense.length - 1, i + 1)]!, l = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
    return [(b[0] - a[0]) / l, (b[1] - a[1]) / l];
  };
  // smallest turning radius over ~2 m chords (the inner face folds when it is under the half-width)
  let minRadius = Infinity;
  for (let i = 0; i < dense.length; i++) {
    let j = i; while (j < dense.length - 1 && cum[j]! - cum[i]! < 2) j++;
    if (j === i) break;
    const ta = tan(i), tb = tan(j), ang = Math.acos(Math.max(-1, Math.min(1, ta[0] * tb[0] + ta[1] * tb[1])));
    if (ang > 1e-4) minRadius = Math.min(minRadius, (cum[j]! - cum[i]!) / ang);
  }
  const at = (s: number) => {
    if (s <= 0 || s >= length) { // run on along the end tangent
      const i = s <= 0 ? 0 : dense.length - 1, t = s <= 0 ? tan(0) : tan(dense.length - 1), d = s <= 0 ? s : s - length;
      return { x: dense[i]![0] + t[0] * d, z: dense[i]![1] + t[1] * d, tx: t[0], tz: t[1] };
    }
    let lo = 0, hi = cum.length - 1;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (cum[m]! <= s) lo = m; else hi = m; }
    const u = (s - cum[lo]!) / Math.max(1e-9, cum[hi]! - cum[lo]!);
    const ta = tan(lo), tb = tan(hi), tx = ta[0] + (tb[0] - ta[0]) * u, tz = ta[1] + (tb[1] - ta[1]) * u, tl = Math.hypot(tx, tz) || 1;
    return { x: dense[lo]![0] + (dense[hi]![0] - dense[lo]![0]) * u, z: dense[lo]![1] + (dense[hi]![1] - dense[lo]![1]) * u, tx: tx / tl, tz: tz / tl };
  };
  return {
    length, at, minRadius, corners: [], closed, legAt: () => 0, legK: () => 0,
    map: (s, n) => { const f = at(s); return [f.x - f.tz * n, f.z + f.tx * n]; },
  };
}

/** Straight legs between the points, each corner mitred (see `Corner`). */
function polyline(pts: readonly P2[], closed: boolean): Curve {
  const legs = pts.slice(0, -1).map((a, i) => {
    const b = pts[i + 1]!, l = Math.hypot(b[0] - a[0], b[1] - a[1]);
    return { a, l, t: [(b[0] - a[0]) / l, (b[1] - a[1]) / l] as P2, s: 0 };
  });
  let acc = 0; for (const g of legs) { g.s = acc; acc += g.l; }
  const length = acc;
  const turnOf = (ta: P2, tb: P2) => Math.atan2(ta[0] * tb[1] - ta[1] * tb[0], ta[0] * tb[0] + ta[1] * tb[1]);
  const kOf = (turn: number) => Math.max(-MAX_K, Math.min(MAX_K, Math.tan(turn / 2)));
  const corners: Corner[] = [];
  for (let i = 1; i < legs.length; i++) {
    const turn = turnOf(legs[i - 1]!.t, legs[i]!.t);
    if (Math.abs(turn) > 1e-6) corners.push({ s: legs[i]!.s, k: kOf(turn), turn, point: i, closure: false });
  }
  if (closed && legs.length > 1) {
    const turn = turnOf(legs.at(-1)!.t, legs[0]!.t);
    if (Math.abs(turn) > 1e-6) { corners.unshift({ s: 0, k: kOf(turn), turn, point: 0, closure: true }); corners.push({ s: length, k: kOf(turn), turn, point: 0, closure: true }); }
  }
  const legAt = (s: number) => { let i = 0; while (i < legs.length - 1 && s >= legs[i + 1]!.s) i++; return i; };
  const legKs = legs.map((g) => corners.filter((c) => !c.closure && c.s <= g.s + 1e-9).reduce((a, c) => a + c.k, 0));
  const map = (s: number, n: number, leg: number): P2 => {
    const g = legs[Math.max(0, Math.min(legs.length - 1, leg))]!, d = s - g.s;
    return [g.a[0] + g.t[0] * d - g.t[1] * n, g.a[1] + g.t[1] * d + g.t[0] * n];
  };
  return {
    length, minRadius: Infinity, corners, closed, legAt, legK: (leg) => legKs[leg] ?? 0, map,
    at: (s) => { const i = legAt(s), [x, z] = map(s, 0, i), t = legs[i]!.t; return { x, z, tx: t[0], tz: t[1] }; },
  };
}

// ------------------------------------------------------------------------------------------------ solids in wall space
/** A wall-space point: [s, y, n]. */
type W3 = [number, number, number];

class RoleMesh {
  pos: number[] = []; idx: number[] = []; uv: number[] = []; counts: number[] = [];
  constructor(readonly role: string) {}
}

function hash01(seed: number, a: number, b: number): number {
  let h = (seed ^ 0x9e3779b9) >>> 0;
  h = Math.imul(h ^ (a + 0x7f4a7c15), 0x85ebca6b) >>> 0; h ^= h >>> 13;
  h = Math.imul(h ^ (b + 0x165667b1), 0xc2b2ae35) >>> 0; h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}
const r4 = (v: number) => Math.round(v * 1e4) / 1e4;

/** A side face (normal along n, the developed length lays it). */
const wallSide = (nrm: W3): boolean => Math.abs(nrm[2]) >= 1.5 * Math.abs(nrm[0]) && Math.abs(nrm[1]) < Math.hypot(nrm[0], nrm[2]);
/** Box-style UV of a wall-space point on a face with wall-space normal nrm (u to the viewer's right, v up). */
function wallUv(q: W3, nrm: W3): [number, number] {
  // a top or soffit when it faces more up/down than sideways; a side when it faces along n (1.5 x more than along s);
  // else an end or a mitre (wallSide: the same split)
  const ax = Math.abs(nrm[1]) >= Math.hypot(nrm[0], nrm[2]) ? 1 : wallSide(nrm) ? 2 : 0;
  const pos = nrm[ax]! >= 0;
  // end faces and MITRES (a corner's shared plane, normal between s and n): u the in-plane horizontal distance, so a 45 deg
  // mitre of a thick tall square shell is laid square (u = -n alone read 1.41:1, and up to 5:1 where a tie sent half its
  // triangles down the side branch; LANDMARKS 2026-10-21: a keep's mitres were 22% of its face area)
  if (ax === 0) { const h = Math.hypot(nrm[0], nrm[2]) || 1; return [(q[0] * nrm[2] - q[2] * nrm[0]) / h, q[1]]; }
  // sides and tops: u along s, v the in-plane distance across the face (up a side, across a top): a battered face, a
  // chamfer or a sloped coping is laid square, never squashed by the box projection (a 45 deg bevel read 1.4:1)
  const l = Math.hypot(nrm[1], nrm[2]) || 1, cy = nrm[1] / l, cn = nrm[2] / l;
  if (ax === 2) return pos ? [q[0], q[1] * Math.abs(cn) - q[2] * cy * Math.sign(cn)] : [-q[0], q[1] * Math.abs(cn) - q[2] * cy * Math.sign(cn)];
  return [q[0], q[1] * cn - q[2] * cy]; // tops (v = -n on a level top) / soffits (v = n)
}

/**
 * The generator's builder: closed solids from stacked RINGS of wall-space points (every ring the same count, convex
 * enough to fan from its centroid), warped to world and grouped per role.
 */
class WallBuilder {
  roles = new Map<string, RoleMesh>();
  /** Material variants: role -> { n variants, band length (Infinity: per leg, `legs` = leg -> variant), offset }; a solid takes the variant under its middle. */
  variants = new Map<string, { n: number; band: number; offset: number; legs?: number[] }>();
  roleAt(role: string, s: number): string {
    const v = this.variants.get(role);
    if (!v) return role;
    const k = ((v.legs ? v.legs[this.curve.legAt(s)] ?? 0 : Math.floor(Math.max(0, s) / v.band + 1e-9)) + v.offset) % v.n;
    return k ? `${role}~${k + 1}` : role;
  }
  /** Sweep pieces that could not be built at a corner (reported). */
  dropped = 0;
  constructor(readonly curve: Curve, readonly origin: P2) {}
  world(q: W3, leg: number): [number, number, number] {
    const [x, z] = this.curve.map(q[0], q[2], leg);
    return [r4(x - this.origin[0]), r4(q[1]), r4(z - this.origin[1])];
  }
  /** Is [a, b] (a solid built in one leg's frame) clear of every corner's mitre zone for offsets up to `reach`? */
  clearOfCorners(a: number, b: number, reach: number): boolean {
    return !this.curve.corners.some((c) => c.s > a - Math.abs(c.k) * reach - 0.05 && c.s < b + Math.abs(c.k) * reach + 0.05);
  }
  /**
   * One closed solid: rings[i][k]. Sides connect ring i to i+1; the first and last rings are capped. Every point is
   * placed on leg `leg`'s straight line (default: the leg under the solid's middle), so a solid never bends; solids
   * that run round a corner come from `sweep`, which splits them there. `check`: validate the solid first (closed,
   * manifold, no self-intersection) and return false without adding it when it fails.
   */
  rings(role: string, rings: W3[][], leg?: number, check = false): boolean {
    const m = rings[0]!.length;
    if (rings.length < 2 || m < 3 || rings.some((r) => r.length !== m)) throw new Error(`wall: bad ring solid for ${role} (rings ${rings.length}, points ${[...new Set(rings.map((r) => r.length))].join("/")})`);
    let sMin = Infinity, sMax = -Infinity; for (const r of rings) for (const q of r) { sMin = Math.min(sMin, q[0]); sMax = Math.max(sMax, q[0]); }
    const lg = leg ?? this.curve.legAt((sMin + sMax) / 2);
    const K2 = 2 * this.curve.legK(lg);
    role = this.roleAt(role, (sMin + sMax) / 2);
    const rm = this.roles.get(role) ?? this.roles.set(role, new RoleMesh(role)).get(role)!;
    const verts: W3[] = [...rings.flat()];
    const cen = (r: W3[]): W3 => r.reduce((a, v) => [a[0] + v[0] / m, a[1] + v[1] / m, a[2] + v[2] / m] as W3, [0, 0, 0] as W3);
    const c0 = verts.length; verts.push(cen(rings[0]!));
    const c1 = verts.length; verts.push(cen(rings.at(-1)!));
    const tris: [number, number, number][] = [];
    for (let i = 0; i + 1 < rings.length; i++) for (let k = 0; k < m; k++) {
      const a = i * m + k, b = i * m + ((k + 1) % m), c = (i + 1) * m + ((k + 1) % m), d = (i + 1) * m + k;
      tris.push([a, b, c], [a, c, d]);
    }
    const L = (rings.length - 1) * m;
    for (let k = 0; k < m; k++) { tris.push([c0, (k + 1) % m, k]); tris.push([c1, L + k, L + ((k + 1) % m)]); }
    // drop degenerate triangles (coincident ring points), orient outward by the signed volume
    const area = (t: [number, number, number]) => { const [a, b, c] = t.map((i) => verts[i]!) as [W3, W3, W3]; const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], w = [c[0] - a[0], c[1] - a[1], c[2] - a[2]]; return [u[1]! * w[2]! - u[2]! * w[1]!, u[2]! * w[0]! - u[0]! * w[2]!, u[0]! * w[1]! - u[1]! * w[0]!] as W3; };
    let vol = 0;
    for (const t of tris) { const [a, b, c] = t.map((i) => verts[i]!) as [W3, W3, W3]; vol += a[0] * (b[1] * c[2] - b[2] * c[1]) - a[1] * (b[0] * c[2] - b[2] * c[0]) + a[2] * (b[0] * c[1] - b[1] * c[0]); }
    const flip = vol < 0;
    const W = verts.map((v) => this.world(v, lg));
    // weld coincident points (a degenerate ring corner) so the solid stays manifold
    const key = new Map<string, number>(), remap: number[] = [], used: number[] = [];
    W.forEach((p, i) => { const k = p.join(","); let j = key.get(k); if (j === undefined) { j = used.length; key.set(k, j); used.push(i); } remap.push(j); });
    // UVs: u is the DEVELOPED length along the offset line (each corner passed shortens an inside face by 2 k n), so
    // the texture runs on unbroken round a mitred corner
    // the texture runs on unbroken round a mitred corner. The offset is the SOLID's outermost offset on that side, not the point's
    // own: a leaning or battered face (n changing with height) developed point by point is sheared by 2k per corner passed
    // (owner walk kirk-knowe 2026-10-21: a ring wall's later legs read stretched)
    let refP = 0, refN = 0;
    for (const q of verts) [refP, refN] = [Math.max(refP, q[2]), Math.min(refN, q[2])];
    // (a plumb face PARALLEL to the line keeps its points' own offset, which is its plane's: exact round the corner. A face
    // turned in plan (a quad whose inner point was clamped onto the mitre, |n_s| > 0) developed point by point is sheared
    // by 2k x its change in n: LANDMARKS 2026-10-21, a keep's and a gatehouse's inside-corner faces read 8-38:1; they take
    // the solid's outermost offset like a battered face)
    const dev = (q: W3, nrm: W3): W3 => { const h = Math.hypot(...nrm); return [q[0] - K2 * (Math.abs(nrm[1]) <= 0.02 * h && Math.abs(nrm[0]) <= 0.02 * h ? q[2] : nrm[2] >= 0 ? refP : refN), q[1], q[2]]; };
    let count = 0;
    const out: number[] = [], compact = new Map<number, number>(); // (only welded points a kept triangle uses)
    const idx: number[] = [], uv: number[] = [];
    for (const t0 of tris) {
      const t = (flip ? [t0[0], t0[2], t0[1]] : t0).map((i) => remap[i]!);
      if (t[0] === t[1] || t[1] === t[2] || t[0] === t[2]) continue;
      const src = (flip ? [t0[0], t0[2], t0[1]] : t0);
      const nrm = area(src as [number, number, number]);
      if (Math.hypot(...nrm) < 1e-9) continue;
      for (const j of t) { let c = compact.get(j!); if (c === undefined) { c = compact.size; compact.set(j!, c); out.push(used[j!]!); } idx.push(c); }
      // only the SIDE faces (normal along n) take the developed length: a top, a soffit or an end in its own plane (u along s,
      // v across n) would be sheared by 2k per corner passed (a ring's coping read 6:1 stretched by its last leg; owner walk
      // kirk-knowe 2026-10-21)
      // (a mitre, |n_s| ~ |n_n|, is never a side: both its triangles take the end branch, laid in its own plane)
      const side = wallSide(nrm);
      for (const i of src) uv.push(...wallUv(side ? dev(verts[i]!, nrm) : verts[i]!, nrm).map(r4));
      count++;
    }
    const pos = out.flatMap((i) => W[i]!);
    if (check) { try { compileTriangleMesh({ positions: pos, indices: idx }); } catch { return false; } }
    const base = rm.pos.length / 3;
    for (const i of idx) rm.idx.push(base + i);
    rm.uv.push(...uv); rm.pos.push(...pos);
    rm.counts.push(count);
    return true;
  }
  /**
   * A sweep: profile(i) = the [n, y] section at stations[i] (same count everywhere). Split into one solid per straight
   * leg at every corner it runs round; each piece ends on the corner's MITRE (point by point: s -+ k n), so the pieces
   * share the mitre face exactly. Stations inside a mitre's fold zone (the inside of the corner, where a section would
   * lie past the mitre) are dropped; a piece too short for both its mitres pinches its inside points together (the
   * neighbouring legs cover that ground: the solids are unioned). `reach`: size the fold zones for sections reaching
   * this far either side (default: this section's own extent), so sweeps that meet one another (a deck, its kerbs and
   * the body under them) drop the SAME stations by a mitre and their shared edges stay one line.
   */
  sweep(role: string, stations: number[], profile: (s: number, i: number) => [number, number][], reach?: number): void {
    if (stations.length < 2) return;
    type Ring = { s: number; pts: [number, number][] };
    const norm = (p: [number, number][]) => { let a2 = 0; for (let k = 0; k < p.length; k++) { const a = p[k]!, b = p[(k + 1) % p.length]!; a2 += a[0] * b[1] - b[0] * a[1]; } return a2 < 0 ? [...p].reverse() : p; };
    let rs: Ring[] = stations.map((s, i) => ({ s, pts: norm(profile(s, i)) }));
    const corners = this.curve.corners;
    const cornerAt = (s: number) => corners.find((c) => Math.abs(c.s - s) < 1e-6);
    // a corner strictly inside the run without its own station gets an interpolated ring there
    for (const c of corners) {
      if (c.s <= rs[0]!.s + 1e-6 || c.s >= rs.at(-1)!.s - 1e-6 || rs.some((r) => Math.abs(r.s - c.s) < 1e-6)) continue;
      const j = rs.findIndex((r) => r.s > c.s), a = rs[j - 1]!, b = rs[j]!, u = (c.s - a.s) / (b.s - a.s);
      rs = [...rs.slice(0, j), { s: c.s, pts: a.pts.map((p, k) => [p[0] + (b.pts[k]![0] - p[0]) * u, p[1] + (b.pts[k]![1] - p[1]) * u] as [number, number]) }, ...rs.slice(j)];
    }
    // a role with material variants is split square at its band edges too (an interpolated ring there), never inside a
    // corner's fold zone (sized as attempt(4) sizes it, + 0.5 m)
    const v = this.variants.get(role), bands: number[] = [];
    if (v) {
      const ext = reach ?? Math.max(...rs.flatMap((r) => r.pts.map(([n]) => Math.abs(n))));
      for (let b0 = Math.ceil((rs[0]!.s + 1e-6) / v.band) * v.band; b0 < rs.at(-1)!.s - 1e-6; b0 += v.band) {
        // (a band edge within 0.4 m of a station splits ON that station: a sliver span between two rings a hair apart
        // welds into a non-manifold solid)
        const near = rs.reduce((m, r) => (!cornerAt(r.s) && Math.abs(r.s - b0) < Math.abs(m - b0) ? r.s : m), Infinity), b = Math.abs(near - b0) < 0.4 ? near : b0;
        if (b <= rs[0]!.s + 1e-6 || b >= rs.at(-1)!.s - 1e-6) continue;
        if (corners.some((c) => Math.abs(c.s - b) < Math.abs(c.k) * ext * 4 + 0.5)) continue;
        if (!rs.some((r) => Math.abs(r.s - b) < 1e-6)) {
          const j = rs.findIndex((r) => r.s > b), a = rs[j - 1]!, c = rs[j]!, u = (b - a.s) / (c.s - a.s);
          rs = [...rs.slice(0, j), { s: b, pts: a.pts.map((p, k) => [p[0] + (c.pts[k]![0] - p[0]) * u, p[1] + (c.pts[k]![1] - p[1]) * u] as [number, number]) }, ...rs.slice(j)];
        }
        bands.push(b);
      }
    }
    const isBand = (s: number) => bands.some((b) => Math.abs(b - s) < 1e-6);
    // pieces between corner (and band) rings
    const pieces: Ring[][] = [];
    let cur: Ring[] = [];
    for (const r of rs) { cur.push(r); if (cur.length > 1 && (cornerAt(r.s) || isBand(r.s))) { pieces.push(cur); cur = [r]; } }
    if (cur.length > 1) pieces.push(cur);
    for (const piece of pieces) {
      const first = piece[0]!, last = piece.at(-1)!;
      if (last.s - first.s < 1e-6) continue;
      const leg = this.curve.legAt((first.s + last.s) / 2);
      const cs = cornerAt(first.s), ce = cornerAt(last.s);
      // fold zone of an end: the furthest any section point's mitre lies inside the piece (the inside of the corner)
      const zone = (c: Corner | undefined, sign: number, end: Ring, r: Ring) => !c ? 0 : reach !== undefined ? Math.abs(c.k) * reach : Math.max(0, ...end.pts.map(([n]) => sign * c.k * n), ...r.pts.map(([n]) => sign * c.k * n));
      // build the piece; stations within `mult` x a mitre's fold zone are dropped (a ring close to a mitre twists the sides)
      const attempt = (mult: number): W3[][] => {
        const clear = (z: number) => (z > 0 ? z * mult + 0.1 : 0.03);
        const body = piece.slice(1, -1).filter((r) => r.s - first.s > clear(zone(cs, 1, first, r)) && last.s - r.s > clear(zone(ce, 1, last, r)));
        // the end rings lie point by point on the mitre (s + k n leaving a corner, s - k n arriving); where a mitre
        // would pass the next ring (a piece shorter than its fold zones: a switchback landing, a jog, a short run beside
        // an opening), the section is CLIPPED at the offset where it meets it: those points slide along the mitre plane
        // to that offset, so the end stays planar and the piece closed (the neighbouring legs, unioned, fill the
        // clipped ground)
        const fp = first.pts.map((q) => [...q] as [number, number]), lp = last.pts.map((q) => [...q] as [number, number]);
        const len = last.s - first.s;
        if (!body.length && cs && ce && Math.abs(cs.k + ce.k) > 1e-9) {
          // (the gap left at the clip grows with the section's fall across the piece: a near-zero gap under a 10 m step
          // in the footing makes the sides a vertical sliver whose triangles cross)
          const fall = Math.max(...fp.map((q, k) => Math.abs(q[1] - lp[k]![1])));
          const K = cs.k + ce.k, nc = (len - Math.min(0.4 * len, Math.max(0.02, 0.25 * fall))) / K;
          for (const q of [...fp, ...lp]) if (K * q[0] > K * nc) q[0] = nc;
        } else {
          const lim0 = body.length ? body[0]!.s - 0.02 : last.s - 0.02, lim1 = body.length ? body.at(-1)!.s + 0.02 : first.s + 0.02;
          if (cs && Math.abs(cs.k) > 1e-9) for (const q of fp) if (first.s + cs.k * q[0] > lim0) q[0] = (lim0 - first.s) / cs.k;
          if (ce && Math.abs(ce.k) > 1e-9) for (const q of lp) if (last.s - ce.k * q[0] < lim1) q[0] = (last.s - lim1) / ce.k;
        }
        // a span between a mitre ring and its neighbour (planes at an angle) whose section changes a lot (a footing
        // stepping down a bank) is split into short ones, or its triangulated sides twist through each other; each
        // intermediate ring is PLANAR (a fan of planes from the mitre to the next ring: s blends the two rings'
        // plane equations at the blended offset)
        type Plane = (n: number) => number;
        const span = (a: [number, number][], pa: Plane, b: [number, number][], pb: Plane): W3[][] => {
          const d = Math.max(...a.map((q, k) => Math.abs(q[1] - b[k]![1]) + Math.abs(q[0] - b[k]![0])));
          const m = Math.min(12, Math.ceil(d / 0.4));
          return Array.from({ length: Math.max(0, m - 1) }, (_, j) => {
            const t = (j + 1) / m;
            return a.map((q, k) => { const n = q[0] + (b[k]![0] - q[0]) * t; return [pa(n) * (1 - t) + pb(n) * t, q[1] + (b[k]![1] - q[1]) * t, n] as W3; });
          });
        };
        const planeA: Plane = (n) => first.s + (cs ? cs.k * n : 0), planeB: Plane = (n) => last.s - (ce ? ce.k * n : 0);
        const R: { pts: [number, number][]; plane: Plane }[] = [{ pts: fp, plane: planeA }, ...body.map((r) => ({ pts: r.pts, plane: (() => r.s) as Plane })), { pts: lp, plane: planeB }];
        const out: W3[][] = [];
        R.forEach((r, j) => {
          if (j > 0 && ((j === 1 && cs) || (j === R.length - 1 && ce))) out.push(...span(R[j - 1]!.pts, R[j - 1]!.plane, r.pts, r.plane));
          out.push(r.pts.map(([n, y]) => [r.plane(n), y, n] as W3));
        });
        return out;
      };
      if (!cs && !ce) { this.rings(role, attempt(1.5), leg); continue; }
      // a piece ending on a mitre is validated (clipped, fanned, a section that changes fast beside the mitre); if it
      // fails, it is rebuilt with the stations near the mitre dropped further back, then as a square-ended straight
      // block between its stations, then left out (the neighbouring legs carry the corner; reported)
      if (this.rings(role, attempt(1.5), leg, true) || this.rings(role, attempt(4), leg, true)) continue;
      const square = piece.map((r) => r.pts.map(([n, y]) => [r.s, y, n] as W3));
      if (!this.rings(role, square, leg, true)) this.dropped++;
    }
  }
  spec(): LandmarkSpec {
    const parts = [...this.roles.values()].filter((r) => r.idx.length).map((r) => ({
      name: r.role, role: r.role, triUv: r.uv,
      node: { id: r.role, op: "add", shape: "mesh", position: [0, 0, 0], rotation: [0, 0, 0], round: 0, blend: 0, mesh: { positions: r.pos, indices: r.idx, ...(r.counts.length > 1 ? { solidTriangleCounts: r.counts } : {}) } },
    }));
    return { version: 1, roles: {}, parts } as unknown as LandmarkSpec;
  }
}

/** Chamfered rectangle [a0..a1] x [b0..b1] (corner order CCW), chamfer c at the corners flagged. */
function chamferRect(a0: number, a1: number, b0: number, b1: number, c: number, corners: [boolean, boolean, boolean, boolean] = [true, true, true, true]): [number, number][] {
  // the point COUNT depends only on c and the flags (a sweep needs the same count at every station)
  if (a1 - a0 < 0.03) a1 = a0 + 0.03;
  if (b1 - b0 < 0.03) b1 = b0 + 0.03;
  const k = c > 0.005 ? Math.max(0.004, Math.min(c, 0.45 * (a1 - a0), 0.45 * (b1 - b0))) : 0;
  const pts: [number, number][] = [];
  const cs: [number, number, number, number][] = [[a0, b0, 1, 1], [a1, b0, -1, 1], [a1, b1, -1, -1], [a0, b1, 1, -1]];
  cs.forEach(([a, b, da, db], i) => {
    if (k > 0 && corners[i]) {
      // enter along the previous edge, leave along the next (CCW: b0 edge -> a1 edge -> b1 edge -> a0 edge)
      if (i === 0) pts.push([a, b + k * db], [a + k * da, b]);
      else if (i === 1) pts.push([a + k * da, b], [a, b + k * db]);
      else if (i === 2) pts.push([a, b + k * db], [a + k * da, b]);
      else pts.push([a + k * da, b], [a, b + k * db]);
    } else pts.push([a, b]);
  });
  return pts;
}

// ------------------------------------------------------------------------------------------------ the generator
export interface WallReport { [k: string]: unknown }

function seedOf(id: string, world: number, seed: number): number {
  let h = 0x811c9dc5 ^ world ^ Math.imul(seed, 0x9e3779b1);
  for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 0x01000193);
  return h >>> 0;
}

/** The plan origin the spec is local to (the bbox centre of the points, whole metres). */
export function wallOrigin(p: Pick<WallParams, "points">): P2 {
  let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
  for (const [x, z] of p.points) { x0 = Math.min(x0, x); z0 = Math.min(z0, z); x1 = Math.max(x1, x); z1 = Math.max(z1, z); }
  return [Math.round((x0 + x1) / 2), Math.round((z0 + z1) / 2)];
}

export function buildWall(input: unknown, reader: OperatorFieldReader, ctx: { id: string }): { spec: LandmarkSpec; at: P2; ground: OperatorPiece | null; report: WallReport; deckTargets: { name: string; at: [number, number, number] }[] } {
  const p = wallParamsSchema.parse(input);
  const D = WALL_SCALE[p.scale];
  // a line whose last point is its first (>= 4 points) is a CLOSED loop (a town wall ring): no ends, the closing corner mitred too
  const closed = p.points.length >= 4 && Math.hypot(p.points[0]![0] - p.points.at(-1)![0], p.points[0]![1] - p.points.at(-1)![1]) < 1e-3 && p.variant !== "ramp";
  const curve = planCurve(p.points, p.smooth, closed);
  const L = curve.length;
  const origin = wallOrigin(p);
  const B = new WallBuilder(curve, origin);
  for (const [role, m] of Object.entries(wallMaterialLists(p))) if (Array.isArray(m) && m.length > 1) {
    const n = m.length;
    if (p.materialBand === "leg") {
      // one variant per built leg: a leg shorter than the section (a landing, a jog) keeps the one before it
      const ends = [0, ...curve.corners.filter((c) => !c.closure).map((c) => c.s), L], legs: number[] = [];
      for (let i = 0; i + 1 < ends.length; i++) legs.push(i === 0 ? 0 : legs[i - 1]! + (ends[i + 1]! - ends[i]! >= 2 * p.thickness + 2 ? 1 : 0));
      B.variants.set(role, { n, band: Infinity, offset: p.materialOffset, legs });
    } else B.variants.set(role, { n, band: L / (n * Math.max(1, Math.round(L / (n * p.materialBand)))), offset: p.materialOffset });
  }
  const seed = seedOf(ctx.id, reader.seed, p.seed);
  const warnings: string[] = [];
  for (const c of curve.corners) if (!c.closure || c.s === 0) if (Math.abs(c.turn) > (135 * Math.PI) / 180 + 1e-6) warnings.push(`corner at point ${c.point} turns ${Math.round((Math.abs(c.turn) * 180) / Math.PI)} deg (> 135): its mitre is clamped and the outside corner left open; add a short leg (a switchback: two 90 deg corners and a landing leg)`);
  const bevel = p.bevel ?? D.bevel;
  const capH = p.cap ? p.cap.height ?? D.cap[0] : 0, capO = p.cap ? p.cap.overhang ?? D.cap[1] : 0;
  const footDepth = p.footing?.depth ?? (p.footing ? undefined : p.bury) ?? D.footing[0], footProj = p.footing ? p.footing.projection ?? D.footing[1] : 0, plinth = p.footing ? p.footing.plinth ?? D.footing[2] : 0;
  const jT = p.irregularity.thickness ?? D.jitter[0], jH = p.irregularity.height ?? D.jitter[1], jL = ((p.irregularity.lean ?? D.jitter[2]) * Math.PI) / 180;
  const segLen = p.irregularity.segment ?? D.segment;
  const f = p.face === "right" ? 1 : -1; // n sign of the exposed face
  const twoFaced = p.variant === "free" || p.variant === "ramp";
  const W0 = p.thickness;
  const ground = (s: number, n: number) => { const q = curve.at(s); return reader.height(q.x - q.tz * n, q.z + q.tx * n); };
  /** The DRAWN ground at (s, n): the field bilinear between its voxel-lattice samples (what the mesher draws). */
  const drawn = (s: number, n: number) => {
    const q = curve.at(s), x = q.x - q.tz * n, z = q.z + q.tx * n, v = reader.voxelSize || 2;
    const x0 = Math.floor(x / v) * v, z0 = Math.floor(z / v) * v, u = (x - x0) / v, w = (z - z0) / v;
    const a = reader.height(x0, z0), b = reader.height(x0 + v, z0), c = reader.height(x0, z0 + v), d = reader.height(x0 + v, z0 + v);
    return (a * (1 - u) + b * u) * (1 - w) + (c * (1 - u) + d * u) * w;
  };
  const deckTargets: { name: string; at: [number, number, number] }[] = [];
  const report: WallReport = {};
  let ground_: OperatorPiece | null = null;

  // ---- the ends: run-on (terrain) stations
  const tie = p.ends.tie ?? 2 * W0 + 2;
  const s0 = !closed && p.variant !== "ramp" && p.ends.start === "terrain" ? -tie : 0, s1 = !closed && p.variant !== "ramp" && p.ends.end === "terrain" ? L + tie : L;
  const clampS = (s: number) => Math.max(0, Math.min(L, s));

  // ---- stations: regular + opening edges + arch detail + (step mode) block edges
  const extra: number[] = [];
  for (const o of p.openings) {
    if (o.at - o.width / 2 < 0.5 || o.at + o.width / 2 > L - 0.5) warnings.push(`opening ${o.name} runs off the wall (0..${L.toFixed(1)} m)`);
    for (let k = 0; k <= 12; k++) extra.push(o.at - o.width / 2 + (o.width * k) / 12);
  }
  const stepLen = p.stepLength ?? segLen * 2;
  if (p.heightMode === "step") for (let s = 0; s < L; s += stepLen) extra.push(s);
  // every corner is a station (exact, unrounded: the sweeps split and mitre there); stations within 1 mm of one merge into it
  const cornerS = curve.corners.map((c) => c.s);
  const stations = [...new Set([...[...Array.from({ length: Math.floor((s1 - s0) / p.step) + 1 }, (_, i) => s0 + i * p.step), s1, 0, L, ...extra].filter((s) => s >= s0 - 1e-6 && s <= s1 + 1e-6).map((s) => Math.round(s * 1000) / 1000).filter((s) => !cornerS.some((c) => Math.abs(c - s) < 1e-3)), ...cornerS])].sort((a, b) => a - b);
  const nearestStation = (s: number) => { let b = 0; for (let i = 1; i < stations.length; i++) if (Math.abs(stations[i]! - s) < Math.abs(stations[b]! - s)) b = i; return b; };

  // ---- per-block jitter knots (linear between knots), seeded
  // (a closed loop: a whole number of blocks round it, the knots wrap, so the jitter meets itself at the closing corner)
  const nBlocks = closed ? Math.max(1, Math.round(L / segLen)) : 0, segJ = closed ? L / nBlocks : segLen;
  const wrapK = (k: number) => (closed ? ((k % nBlocks) + nBlocks) % nBlocks : k);
  const knot = (s: number, ch: number) => { const k = Math.floor((s - s0) / segJ), u = (s - s0) / segJ - k; const a = hash01(seed, wrapK(k), ch) * 2 - 1, b = hash01(seed, wrapK(k + 1), ch) * 2 - 1; return a + (b - a) * u; };
  const blockJ = (s: number, ch: number) => hash01(seed, wrapK(Math.floor((s - s0) / segJ)), ch) * 2 - 1;

  if (p.variant === "ramp") {
    buildRamp();
  } else {
    buildWallBody();
  }

  function buildWallBody() {
    // face-side ground and the lowest ground under the foot, per station
    const halfFoot = W0 / 2 + p.batter * p.height + footProj + 0.5;
    const gFace = (s: number) => {
      const ss = clampS(s);
      return twoFaced ? Math.min(ground(ss, halfFoot), ground(ss, -halfFoot), ground(ss, 0)) : ground(ss, f * halfFoot);
    };
    // the lowest ground under the foot: the field AND the drawn lattice (the mesher draws the voxel lattice; on a convex
    // slope the drawn ground sags under the field between samples), across the foot
    const gField = (s: number) => { const ss = clampS(s); return Math.min(ground(ss, halfFoot), ground(ss, -halfFoot), ground(ss, 0), ground(ss, halfFoot / 2), ground(ss, -halfFoot / 2)); };
    const gLow = (s: number) => { const ss = clampS(s); return Math.min(gField(s), ...[halfFoot, -halfFoot, 0, halfFoot / 2, -halfFoot / 2].map((n) => drawn(ss, n))); };
    // seated per SEGMENT: a station's foot is under the lowest ground of the span to its neighbours' midpoints (a dip
    // between two 1 m stations never shows daylight under the foot; Reedholt palisade 2026-10-21). Within 0.1 m of the
    // field under the station the station's own reading stands (the skirt depth covers it; walls on even ground keep
    // their bakes)
    const gL = stations.map((s, i) => Math.min(gField(s), 0.1 + Math.min(gLow(s), gLow((s + stations[Math.max(0, i - 1)]!) / 2), gLow((s + stations[Math.min(stations.length - 1, i + 1)]!) / 2))));
    const gF = stations.map(gFace);
    // smoothed face ground (12 m window) for `follow`
    const dS = (a: number, b: number) => { const d = Math.abs(a - b); return closed ? Math.min(d, L - d) : d; }; // round a closed loop
    const smooth = (arr: number[], win: number) => arr.map((_, i) => { let a = 0, n = 0; for (let j = 0; j < arr.length; j++) if (dS(stations[j]!, stations[i]!) <= win / 2) { a += arr[j]!; n++; } return a / n; });
    const gS = smooth(gF, 12);
    const sorted = [...gF].sort((a, b) => a - b), median = sorted[sorted.length >> 1]!;
    const levelTop = p.variant === "quay" ? (p.topY ?? reader.seaLevel + p.height) : (p.topY ?? median + p.height);
    const stepTop = (s: number) => {
      const k = Math.floor(clampS(s) / stepLen), a = k * stepLen, b = Math.min(L, a + stepLen);
      const inSeg = stations.map((t, i) => [t, gF[i]!] as const).filter(([t]) => t >= a - 1e-6 && t <= b + 1e-6).map(([, g]) => g).sort((x, y) => x - y);
      const med = inSeg.length ? inSeg[inSeg.length >> 1]! : gFace(s);
      return Math.round((med + p.height) / p.stepRise) * p.stepRise + blockJ(a + 1e-3, 5) * jH;
    };
    const topAt = (s: number, i: number): number => {
      if (s < 0) return topAt(0, nearestStation(0));
      if (s > L) return topAt(L, nearestStation(L));
      if (p.heightMode === "level" || p.variant === "quay") return levelTop + knot(s, 2) * jH;
      if (p.heightMode === "step") return stepTop(s);
      return gS[i]! + p.height + knot(s, 2) * jH;
    };
    const tops = stations.map((s, i) => topAt(s, i));
    const sec = (s: number, i: number, top = tops[i]!) => {
      const W = Math.max(0.3, W0 + knot(s, 1) * jT);
      // the foot stays >= 0.5 m under the body top: where the ground climbs over the top (a level / step block on a
      // steep bank, a small feather steepening the ground beside it) the section would turn inside out
      const yb = Math.min(gL[i]! - footDepth, top - capH - 0.5);
      const H = Math.max(0.5, top - gF[i]!);
      const lean = Math.tan(knot(s, 3) * jL) * (top - yb);
      const bH = p.batter * H;
      // n of the right (+) and left (-) faces at foot and top
      const rT = W / 2 + lean, lT = -W / 2 + lean;
      const rB = W / 2 + (twoFaced || f > 0 ? bH : 0), lB = -W / 2 - (twoFaced || f < 0 ? bH : 0);
      return { W, yb, top, rT, lT, rB, lB, gF: gF[i]!, H };
    };
    const secs = stations.map((s, i) => sec(s, i));
    const over = stations.filter((s, i) => s >= 0 && s <= L && gF[i]! > secs[i]!.top - capH).length;
    if (over) warnings.push(`the ground rises over the wall top at ${over} station(s) (buried there): shorten stepLength, raise the height or use heightMode follow`);
    const inOpening = (s: number) => p.openings.find((o) => s > o.at - o.width / 2 + 1e-6 && s < o.at + o.width / 2 - 1e-6);
    const runs = (pred: (s: number) => boolean, breakAt: (a: number, b: number) => boolean = () => false): number[][] => {
      const out: number[][] = []; let cur: number[] = [];
      stations.forEach((s, i) => {
        if (!pred(s)) { if (cur.length > 1) out.push(cur); cur = []; return; }
        if (cur.length && breakAt(stations[cur.at(-1)!]!, s)) { cur.push(i); out.push(cur); cur = [i]; return; }
        cur.push(i);
      });
      if (cur.length > 1) out.push(cur);
      return out;
    };
    const blockOf = (s: number) => Math.floor(clampS(s) / stepLen);
    // (a block edge is itself a station: the run breaks AT it, b + 1e-4 being in the next block; b - 1e-4 never broke)
    const stepBreak = (a: number, b: number) => p.heightMode === "step" && blockOf(a + 1e-4) !== blockOf(b + 1e-4);
    // body: a quad section [right foot, right top, left top, left foot]; in step mode each block its own solid at its top
    const bodyTop = (q: ReturnType<typeof sec>) => q.top - capH;
    const footTop = (q: ReturnType<typeof sec>) => Math.max(q.yb + 0.3, q.gF + plinth);
    const pierAtStart = !closed && p.ends.start === "pier", pierAtEnd = !closed && p.ends.end === "pier";
    const pierW = p.ends.pierWidth ?? W0 + 0.8;
    for (const run of runs((s) => !inOpening(s), stepBreak)) {
      const sts = run.map((i) => stations[i]!);
      const blockTop = p.heightMode === "step" ? stepTop((sts[0]! + sts.at(-1)!) / 2) : undefined;
      const q = (i: number) => (blockTop !== undefined ? sec(stations[i]!, i, blockTop) : secs[i]!);
      // (with a footing the body STANDS ON it: no face of one lies on a face of the other, mitres included)
      B.sweep("face", sts, (_s, k) => { const c = q(run[k]!); const t = bodyTop(c), y = p.footing ? Math.min(footTop(c), t - 0.3) : c.yb; return [[c.rB, y], [c.rT, t], [c.lT, t], [c.lB, y]]; });
      if (p.cap) B.sweep("cap", sts, (_s, k) => {
        const c = q(run[k]!), t = bodyTop(c), oR = twoFaced || f > 0 ? capO : 0, oL = twoFaced || f < 0 ? capO : 0;
        return chamferRect(c.lT - oL, c.rT + oR, t, c.top, bevel, [false, false, oR > 0, oL > 0]);
      });
    }
    // lintels / arches over the openings (the coping runs over: built as part of the cap sweep below)
    for (const o of p.openings) {
      const idx = stations.map((s, i) => [s, i] as const).filter(([s]) => s >= o.at - o.width / 2 - 1e-6 && s <= o.at + o.width / 2 + 1e-6).map(([, i]) => i);
      if (idx.length < 2) continue;
      const gc = gFace(o.at), r = o.width / 2;
      const soffit = (s: number) => (o.arch ? gc + o.height - r + Math.sqrt(Math.max(0, r * r - (s - o.at) ** 2)) : gc + o.height);
      const minTop = Math.min(...idx.map((i) => bodyTop(secs[i]!)));
      if (gc + o.height > minTop - 0.4) warnings.push(`opening ${o.name}: head ${(gc + o.height).toFixed(1)} is within 0.4 m of the wall top ${minTop.toFixed(1)} (lowered)`);
      const sts = idx.map((i) => stations[i]!);
      B.sweep("face", sts, (s, k) => { const c = secs[idx[k]!]!; const t = bodyTop(c), y0 = Math.min(soffit(s), t - 0.4); return [[c.rT, y0], [c.rT, t], [c.lT, t], [c.lT, y0]]; });
      if (p.cap) B.sweep("cap", sts, (_s, k) => { const c = secs[idx[k]!]!, t = bodyTop(c), oR = twoFaced || f > 0 ? capO : 0, oL = twoFaced || f < 0 ? capO : 0; return chamferRect(c.lT - oL, c.rT + oR, t, c.top, bevel, [false, false, oR > 0, oL > 0]); });
    }
    // sills: a window's body runs on under it (foot to sill), its top face level at the sill (LANDMARKS 2026-10-22: tower slits)
    for (const o of p.openings) {
      if (!(o.sill > 0)) continue;
      const idx = stations.map((s, i) => [s, i] as const).filter(([s]) => s >= o.at - o.width / 2 - 1e-6 && s <= o.at + o.width / 2 + 1e-6).map(([, i]) => i);
      if (idx.length < 2) continue;
      const gc = gFace(o.at), y1 = gc + o.sill;
      if (o.height - o.sill < 0.6) warnings.push(`opening ${o.name}: ${(o.height - o.sill).toFixed(2)} m between sill and head (at least 0.6)`);
      B.sweep("face", idx.map((i) => stations[i]!), (_s, k) => {
        const c = secs[idx[k]!]!, t = bodyTop(c), y = p.footing ? Math.min(footTop(c), t - 0.3) : c.yb, u = Math.max(0, Math.min(1, (y1 - y) / Math.max(1e-6, t - y)));
        return [[c.rB, y], [c.rB + (c.rT - c.rB) * u, y1], [c.lB + (c.lT - c.lB) * u, y1], [c.lB, y]];
      });
    }
    // footing: follows the ground, broken under openings
    // (one mesh owns each plane: the footing stands >= 0.05 m proud of the body on both sides (an earth side too), runs
    // fP past the wall's open ends and into a gate (returning round the reveal), so no footing face lies on a body face)
    const fP = Math.max(0.05, footProj);
    if (p.footing) for (const run of runs((s) => !(inOpening(s) && !(inOpening(s)!.sill > 0)))) {
      const sts = run.map((i) => stations[i]!);
      if (!closed) {
        const [a, b] = [sts[0]!, sts.at(-1)!];
        sts[0] = a - fP; sts[sts.length - 1] = b + fP;
      }
      B.sweep("footing", sts, (_s, k) => {
        const c = secs[run[k]!]!, top = Math.min(footTop(c), bodyTop(c) - 0.3), pr = twoFaced || f > 0 ? footProj : 0, pl = twoFaced || f < 0 ? footProj : 0;
        return chamferRect(c.lB - Math.max(0.05, pl), c.rB + Math.max(0.05, pr), c.yb, top, bevel, [false, false, pr > 0, pl > 0]);
      });
    }
    // parapet + merlons on the walk (the coping top)
    if (p.parapet) {
      const pp = p.parapet;
      const sides = pp.side === "both" ? [1, -1] : pp.side === "face" ? [f] : [-f];
      for (const sd of sides) for (const run of runs(() => true)) {
        const sts = run.map((i) => stations[i]!);
        // (one mesh owns each plane: the parapet SITS ON the coping, and where the coping has no overhang on its side it
        // stands 0.03 m back from the coping's edge: its outer face never continues the coping's side (a corner's
        // fold-zone stations, dropped from one sweep and not the other, would let the two overlap on one plane))
        const ovh = p.cap && (sd > 0 ? twoFaced || f > 0 : twoFaced || f < 0) ? capO : 0;
        const back = ovh < 0.03 ? 0.03 : 0;
        const edge = (c: ReturnType<typeof sec>) => (sd > 0 ? c.rT - back : c.lT + back);
        B.sweep("parapet", sts, (_s, k) => { const c = secs[run[k]!]!, e = edge(c), a = sd > 0 ? e - pp.thickness : e, b = sd > 0 ? e : e + pp.thickness; return chamferRect(a, b, c.top, c.top + pp.height, bevel, [false, false, true, true]); });
        // the parapet's top at s (linear between stations, as its sweep)
        const topS = (s: number) => { const j = stations.findIndex((t) => t >= s); if (j <= 0) return secs[Math.max(0, j)]!.top; if (j < 0) return secs.at(-1)!.top; const u = (s - stations[j - 1]!) / (stations[j]! - stations[j - 1]!); return secs[j - 1]!.top + (secs[j]!.top - secs[j - 1]!.top) * u; };
        if (pp.crenels) {
          const cr = pp.crenels, pitch = cr.merlon + cr.gap;
          for (let a = sts[0]! + cr.gap / 2; a + cr.merlon <= sts.at(-1)! + 1e-6; a += pitch) {
            const i = stations.findIndex((s) => s >= a); if (i < 0) continue;
            // (a merlon is one straight block while the parapet's faces wander with the jitter and lean: it stands 0.03 m
            // proud of both faces wherever they run under it, seated into the parapet, so its faces never lie on the parapet's)
            const c = secs[i]!, under = stations.map((t, j) => [t, j] as const).filter(([t]) => t >= a - 1.01 && t <= a + cr.merlon + 1.01).map(([, j]) => edge(secs[j]!));
            const nA = Math.min(...under) - (sd > 0 ? pp.thickness : 0) - 0.03, nB = Math.max(...under) + (sd > 0 ? 0 : pp.thickness) + 0.03;
            const y0 = c.top + pp.height - 0.05, y1 = c.top + pp.height + cr.height + blockJ(a, 7) * Math.min(0.08, cr.height * 0.1);
            const reach = Math.max(Math.abs(nA), Math.abs(nB));
            if (B.clearOfCorners(a, a + cr.merlon, reach)) {
              const prof = chamferRect(a, a + cr.merlon, y0, y1, bevel, [false, false, true, true]);
              B.rings("merlon", [nA, nB].map((n) => prof.map(([s, y]) => [s, y, n] as W3)));
            } else if (curve.corners.every((cn) => cn.s < a - Math.abs(cn.k) * reach - 0.05 || cn.s > a + cr.merlon + Math.abs(cn.k) * reach + 0.05 || cn.k * (nA + nB) < 0)) {
              // by an OUTSIDE corner: a mitred merlon round it; by an inside corner (the walk turns there) none
              // (its mitre meets the parapet's mitre at the parapet's top exactly: their mitre faces only touch)
              // (a merlon may also start or end on the corner)
              const cs = curve.corners.filter((cn) => cn.s > a - 1e-3 && cn.s < a + cr.merlon + 1e-3).map((cn) => cn.s);
              const inside = cs.filter((q) => q > a + 1e-3 && q < a + cr.merlon - 1e-3);
              B.sweep("merlon", [a, ...inside, a + cr.merlon], (s) => chamferRect(nA, nB, cs.some((q) => Math.abs(q - s) < 1e-3) ? topS(s) + pp.height : y0, y1, bevel, [false, false, true, true]));
            }
          }
        }
      }
      if (p.openings.length && pp.crenels) warnings.push("merlons run over the gates (fine for a gatehouse wall; split the wall for a tower)");
    }
    // buttresses (vertical ring stack: chamfered footprint at the foot, tapered and lowered at the top)
    if (p.buttresses) {
      const bt = p.buttresses;
      const sides = bt.side === "both" ? [1, -1] : [f];
      for (let a0 = bt.every / 2; a0 < L - bt.width / 2; a0 += bt.every) {
        // (step mode: a buttress side never on a block's end face, where the next block's top steps)
        let a = a0;
        if (p.heightMode === "step") for (const e of [a - bt.width / 2, a + bt.width / 2]) { const d = e - Math.round(e / stepLen) * stepLen; if (Math.abs(d) < 0.06) a += (d >= 0 ? 1 : -1) * 0.06 - d; }
        if (p.openings.some((o) => Math.abs(a - o.at) < o.width / 2 + bt.width)) continue;
        if ((pierAtStart && a < pierW + bt.width) || (pierAtEnd && a > L - pierW - bt.width)) continue;
        const i = stations.findIndex((s) => s >= a); if (i < 0) continue;
        const c = secs[i]!;
        if (!B.clearOfCorners(a - bt.width / 2, a + bt.width / 2, Math.max(Math.abs(c.rB), Math.abs(c.lB)) + bt.depth)) continue; // a corner stiffens itself
        for (const sd of sides) {
          const inner = sd > 0 ? c.rB - 0.3 - p.batter * c.H : c.lB + 0.3 + p.batter * c.H; // into the body at the top
          const out = (d: number) => (sd > 0 ? c.rB + d : c.lB - d);
          const yTop = Math.max(c.yb + 1, c.top - capH - bt.below);
          const footR = (d: number, y: number) => {
            const n0 = Math.min(inner, out(d)), n1 = Math.max(inner, out(d));
            return chamferRect(a - bt.width / 2, a + bt.width / 2, n0, n1, bevel, sd > 0 ? [false, false, true, true] : [true, true, false, false]).map(([s, n]) => [s, y, n] as W3);
          };
          // (the knee stays under the top: a low wall on rising ground would fold the weathering back on itself)
          const ringsB = [footR(bt.depth, c.yb - 0.2), // (its underside under the body's and the footing's)
             footR(bt.depth, Math.min(yTop - 0.2, Math.max(c.yb + 0.5, c.gF + plinth + 0.2))), footR(bt.depth * bt.taper, yTop)];
          B.rings("buttress", ringsB);
        }
      }
    }
    // piers at the ends
    const pier = (sa: number, sb: number, i: number) => {
      const c = secs[i]!, pr = p.ends.pierProjection, top = c.top + p.ends.pierRise;
      const nA = c.lB - pr, nB = c.rB + pr;
      const fp = (y: number, grow: number) => chamferRect(sa - grow, sb + grow, nA - grow, nB + grow, bevel * 2).map(([s, n]) => [s, y, n] as W3);
      const ch = Math.max(0.2, capH || 0.3);
      B.rings("pier", [fp(c.yb - 0.1, 0), fp(top - ch, 0)]); // (its underside under the body's; its top under its cap)
      B.rings(p.cap ? "cap" : "pier", [fp(top - ch, capO), fp(top - bevel, capO), fp(top, capO - bevel)]);
    };
    if (pierAtStart) pier(-0.2, pierW - 0.2, nearestStation(0));
    if (pierAtEnd) pier(L - pierW + 0.2, L + 0.2, nearestStation(L));
    // stair flights along a face: blocks from the foot up to the walk, rising toward `to`
    for (const st of p.stairs) {
      const a = clampS(Math.min(st.from, st.to)), b = clampS(Math.max(st.from, st.to)), up = st.to >= st.from;
      const iLow = stations.findIndex((s) => s >= (up ? a : b) - 1e-6), iTop = stations.findIndex((s) => s >= (up ? b : a) - 1e-6);
      const y0 = gFace(up ? a : b), y1 = (iTop >= 0 ? secs[iTop]!.top : tops.at(-1)!);
      const n = Math.max(1, Math.ceil((y1 - y0) / st.riser)), rise = (y1 - y0) / n, run = (b - a) / n;
      if (run < 0.25) warnings.push(`stair ${st.from}->${st.to}: treads ${run.toFixed(2)} m (< 0.25): lengthen the flight`);
      const sd = st.side === "face" ? f : -f;
      for (let k = 0; k < n; k++) {
        const sa = up ? a + k * run : b - (k + 1) * run, sb = sa + run;
        const i = stations.findIndex((s) => s >= (sa + sb) / 2); const c = secs[Math.max(0, i)]!;
        const nIn = sd > 0 ? c.rT - 0.15 : c.lT + 0.15, nOut = sd > 0 ? c.rB + st.width : c.lB - st.width;
        if (!B.clearOfCorners(sa, sb, Math.max(Math.abs(nIn), Math.abs(nOut)))) { if (!warnings.includes(`stair ${st.from}->${st.to} runs round a corner: those treads are left out (run the flight along one leg)`)) warnings.push(`stair ${st.from}->${st.to} runs round a corner: those treads are left out (run the flight along one leg)`); continue; }
        // (the top tread stops 0.04 m under the walk: it runs in under the coping, never on its top; undersides under the body's)
        const yk = y0 + (k + 1) * rise - (k === n - 1 ? 0.04 : 0), yb = Math.min(c.yb - 0.3, y0 - 0.6);
        const prof = up ? chamferRect(sa, sb + 0.02, yb, yk, Math.min(bevel, 0.04), [false, false, false, true]) : chamferRect(sa - 0.02, sb, yb, yk, Math.min(bevel, 0.04), [false, false, true, false]);
        B.rings("stair", [Math.min(nIn, nOut), Math.max(nIn, nOut)].map((nn) => prof.map(([s, y]) => [s, y, nn] as W3)));
      }
      const tq = curve.at(up ? b : a);
      deckTargets.push({ name: `stair-top-${Math.round(st.to)}`, at: [r4(tq.x - tq.tz * 0), r4(y1 + 0.1), r4(tq.z)] });
    }
    // reach targets on the walk (a parapet wall is a walkway): the middle of the wall top
    if (p.parapet && p.parapet.walked) { const m = curve.at(L / 2); const i = stations.findIndex((s) => s >= L / 2); deckTargets.push({ name: "walk-mid", at: [r4(m.x), r4(secs[i]!.top + 0.1), r4(m.z)] }); }
    report.top = { min: r4(Math.min(...tops)), max: r4(Math.max(...tops)) };
    report.groundFace = { min: r4(Math.min(...gF)), max: r4(Math.max(...gF)) };
    if (p.backfill && !twoFaced) ground_ = backfillPatch(secs.map((c) => c.top - capH - 0.2), secs.map((c) => (f > 0 ? c.lT : c.rT)));
  }

  function buildRamp() {
    const r = p.ramp;
    const half = W0 / 2;
    const gC = stations.map((s) => ground(s, 0));
    const gLo = stations.map((s) => Math.min(ground(s, half + 1), ground(s, -half - 1), ground(s, 0)));
    // the ground under each face (left n < 0, right n > 0): a body on a cross-slope stands down to each face's own
    // ground, its base sloping across (no uphill face run metres deep into the bank for nothing)
    const gSide = [stations.map((s) => Math.min(ground(s, -half - 1), ground(s, 0))), stations.map((s) => Math.min(ground(s, half + 1), ground(s, 0)))] as const;
    // deck line Y(s)
    const lv = r.levels.map((l) => ({ at: l.at === "end" ? L : clampS(l.at), y: l.y })).sort((a, b) => a.at - b.at);
    if (!lv.length || lv[0]!.at > 0) lv.unshift({ at: 0, y: undefined });
    if (lv.at(-1)!.at < L) lv.push({ at: L, y: undefined });
    const lvY = lv.map((l) => l.y ?? ground(l.at, 0) + 0.05);
    const smoothG = stations.map((_, i) => { let a = 0, n = 0; for (let j = 0; j < stations.length; j++) if (Math.abs(stations[j]! - stations[i]!) <= 6) { a += gC[j]!; n++; } return a / n; });
    const Y = stations.map((s, i) => {
      let k = 0; while (k < lv.length - 2 && lv[k + 1]!.at < s) k++;
      const a = lv[k]!, b = lv[k + 1]!, u = (s - a.at) / Math.max(1e-6, b.at - a.at);
      const lin = lvY[k]! + (lvY[k + 1]! - lvY[k]!) * Math.max(0, Math.min(1, u));
      if (!r.followGround || s <= a.at + 1e-6 || s >= b.at - 1e-6) return lin;
      // ground-following between levels, pinned to them at both ends
      const w = Math.min(1, Math.min(s - a.at, b.at - s) / 6);
      return lin + (Math.max(smoothG[i]!, gC[i]!) + r.lift - lin) * w;
    });
    // a LANDING at every corner: the deck is level across the corner's mitre zone (the inside edge of a flight never
    // runs round a mitre; a switchback = leg, two 90 deg corners round a level landing leg, the reversed leg)
    // (corners whose zones (nearly) meet share ONE landing: a switchback's landing leg is level end to end)
    const spans: [number, number][] = [];
    for (const c of curve.corners) {
      const z = Math.abs(c.k) * (half + 0.5) + 0.6, prev = spans.at(-1);
      if (prev && c.s - z <= prev[1] + 1.5) prev[1] = c.s + z; else spans.push([c.s - z, c.s + z]);
    }
    const landings = spans.map(([a, b]) => stations.map((s, i) => [s, i] as const).filter(([s]) => s >= a - 1e-6 && s <= b + 1e-6).map(([, i]) => i)).filter((l) => l.length);
    const flatten = (pick: (ys: number[]) => number) => { for (const l of landings) { const y = pick(l.map((i) => Y[i]!)); for (const i of l) Y[i] = y; } };
    flatten((ys) => ys[ys.length >> 1]!);
    if (landings.length) report.landings = landings.map((l) => [r4(stations[l[0]!]!), r4(stations[l.at(-1)!]!)]);
    // the steepest a flight may be (riser over tread): raise the deck (a built-up causeway) wherever the line climbs or drops faster
    {
      const lim = r.stairGrade, Y0 = [...Y];
      for (let pass = 0; pass < 6; pass++) { // (a raised landing stays level: re-level it at its highest, raise again)
        for (let i = 1; i < Y.length; i++) Y[i] = Math.max(Y[i]!, Y[i - 1]! - lim * (stations[i]! - stations[i - 1]!));
        for (let i = Y.length - 2; i >= 0; i--) Y[i] = Math.max(Y[i]!, Y[i + 1]! - lim * (stations[i + 1]! - stations[i]!));
        if (landings.every((l) => l.every((i) => Math.abs(Y[i]! - Y[l[0]!]!) < 1e-9))) break;
        flatten((ys) => Math.max(...ys));
      }
      const raised = Y.reduce((a, y, i) => Math.max(a, y - Y0[i]!), 0);
      if (raised > 0.05) report.raised = r4(raised);
    }
    // stair runs: consecutive intervals steeper than maxGrade (merged), treads at <= riser
    const steep = stations.slice(0, -1).map((s, i) => Math.abs(Y[i + 1]! - Y[i]!) / Math.max(1e-6, stations[i + 1]! - s) > r.maxGrade + 1e-6);
    const flights: [number, number][] = [];
    for (let i = 0; i < steep.length; i++) if (steep[i]) { if (flights.length && flights.at(-1)![1] === i) flights.at(-1)![1] = i + 1; else flights.push([i, i + 1]); }
    // the cut: ground over the deck (a causeway along a slope) is lowered under the slab and feathered back up the bank
    if (r.cut) {
      // flat (under the slab) out past the parapet / kerb by one lattice step: the terrain is drawn from 2 m nodes and
      // tent-filtered, so a bank feathering up from the rim itself is drawn ~1 m over the deck inside the parapet (a
      // landing on a cliff bank, weeping-stair -2448,87.5,-1081)
      const rim = Math.max(p.parapet ? p.parapet.thickness : 0, r.kerb ? r.kerb.width : 0);
      const g = reader.voxelSize, edge = Math.max(W0 / 2 + 0.8, W0 / 2 + rim + g), fe = r.cut.feather;
      // under the slab at the LOWEST deck within a lattice cell along the line (a node stands for the ground up to a
      // cell either way; on a flight the nearest station's Y is up to a riser or two above the deck beside it)
      // ... except over the last two cells at either end, where it rises to just under the deck top: the line's ends meet
      // the natural ground flush, and a full-depth cut there leaves the slab's end face standing as a > 0.4 m step
      const low = stations.map((s, i) => {
        let m = Y[i]!; for (let j = i; j >= 0 && s - stations[j]! <= 1.5 * g; j--) m = Math.min(m, Y[j]!); for (let j = i; j < stations.length && stations[j]! - s <= 1.5 * g; j++) m = Math.min(m, Y[j]!);
        // (the end cell itself stays flush: the tent filter blends the end node with the next one, and a ramp starting
        // AT the end sank the drawn ground there ~0.2 m, a 0.5 m first riser under a flight that starts at the end)
        const deep = m - r.deck - 0.1, flush = m - 0.05, e = Math.min(1, Math.max(0, Math.min(s, L - s) - g) / (2 * g));
        return flush + (deep - flush) * e;
      });
      // every node near the deck is written (weight 1, never raised): the patch's mask is tent-filtered, so an untouched
      // node beside a cut one dims the cut and lets the natural bank (rough spoil: metres higher) show through the
      // treads (FIX-T: wall-lab causeway, terrain 0.5-0.8 m over the flight head launched a running body)
      const solid = edge + 3 * g;
      ground_ = bandPatch("cut", Math.max(solid, edge + fe), (h0, i, n) => {
        const target = low[i]!, d = Math.abs(n) - edge;
        const t = d <= 0 ? 0 : Math.min(1, d / fe), u = t * t * (3 - 2 * t);
        const h = h0 <= target ? h0 : target + (h0 - target) * u;
        if (Math.abs(n) <= solid) return Math.min(h0, h);
        return h < h0 - 0.05 ? h : null;
      }, W0 / 2 - 0.2);
      // the body stands in the CUT ground: where the cut runs under a neighbouring leg (a switchback's leg above, its
      // downhill face over the lower landing's cut bank) and lowers the ground there by more than the footing depth, its
      // foot goes down to the lowered ground and never floats (a shallow cut leaves the foot as it was)
      if (ground_) {
        const cp = ground_ as unknown as { origin: [number, number]; columns: number; rows: number; heights: number[]; weights: number[] };
        const cutAt = (x: number, z: number) => {
          const cx = (x - cp.origin[0]) / g, cz = (z - cp.origin[1]) / g;
          let m = Infinity;
          for (const c of [Math.floor(cx), Math.floor(cx) + 1]) for (const rr of [Math.floor(cz), Math.floor(cz) + 1]) { // the 2x2 nodes round the point (the lowest)
            if (c < 0 || rr < 0 || c >= cp.columns || rr >= cp.rows) continue;
            const k = rr * cp.columns + c; if (cp.weights[k]! > 0) m = Math.min(m, cp.heights[k]!);
          }
          return m;
        };
        stations.forEach((s, i) => { const q = curve.at(s); for (const n of [-half - 1, 0, half + 1]) { const c = cutAt(q.x - q.tz * n, q.z + q.tx * n); for (const sd of n < 0 ? [0] : n > 0 ? [1] : [0, 1]) if (c < gSide[sd]![i]! - footDepth) gSide[sd]![i] = c; if (c < gLo[i]! - footDepth) gLo[i] = c; } });
      }
    }
    // the foot: under the ground by the footing depth, and always >= 1 m under the deck body (a deck cut into a slope stays a closed solid)
    const yb = stations.map((_, i) => Math.min(gLo[i]! - footDepth, Y[i]! - r.deck - r.riser - 1.2));
    const buried = stations.filter((s, i) => Y[i]! < ground(s, 0) - 0.3).length;
    if (buried) warnings.push(`the deck runs under the ground at ${buried} station(s): raise the levels or use followGround`);
    const kerb = r.kerb;
    const pp = p.parapet;
    const kerbSides = kerb ? [1, -1].filter((sd) => !(pp && (pp.side === "both" || (pp.side === "face" ? sd === f : sd === -f)))) : [];
    const parSides = pp ? (pp.side === "both" ? [1, -1] : pp.side === "face" ? [f] : [-f]) : [];
    const bH = (i: number) => p.batter * Math.max(0, Y[i]! - gLo[i]!);
    // body: one sweep under the deck line (minus slab, minus a riser in flights), battered sides down to the footing
    const bodyTop = (i: number) => Y[i]! - r.deck - (flights.some(([a, b]) => i >= a && i <= b) ? r.riser : 0);
    const W = (s: number) => Math.max(1, W0 + knot(s, 1) * jT * 0.5);
    // ONE MESH OWNS EACH PLANE (tools/zfight.mts): every solid that meets another meets it at an edge or buries the
    // shared face inside it, never on one plane: the kerbs/parapets SIT on the body (their outer face continues the
    // body's side above its top edge), the slab butts against their inner face (no kerb: it meets the body's edge), the
    // treads run 0.05 m into them (their side faces well clear of the outer face; no kerb: they stand 0.04 m in); with a
    // footing the body STANDS ON it; every sweep sizes its corner fold zones by one reach, so all drop the same stations
    const edgeW = (sd: number) => (parSides.includes(sd) ? pp!.thickness : kerbSides.includes(sd) ? kerb!.width : 0);
    const inner = (sd: number, w: number, into: number, bare: number) => { const e = edgeW(sd); return e > 0 ? w - e + Math.min(into, e / 3) : w - bare; };
    const footTopR = (i: number) => Math.min(Math.max(yb[i]! + 0.3, gLo[i]! + plinth), bodyTop(i) - 0.3);
    const ybSide = (i: number, sd: 0 | 1) => (p.footing ? footTopR(i) : Math.min(gSide[sd][i]! - footDepth, Y[i]! - r.deck - r.riser - 1.2));
    const fP = Math.max(0.05, footProj);
    const reach = Math.max(...stations.map((s, i) => W(s) / 2 + bH(i))) + (p.footing ? fP : 0) + 0.05; // (every ramp sweep drops the same stations by a mitre)
    B.sweep("face", stations, (s, i) => { const w = W(s) / 2; return [[w + bH(i), ybSide(i, 1)], [w, bodyTop(i)], [-w, bodyTop(i)], [-w - bH(i), ybSide(i, 0)]]; }, reach);
    // buttresses on the body's sides where the exposed face stands >= minHeight over its own ground (a switchback's tall
    // retaining faces): top under the deck (the parapet stays clear), depth shrunk to clear the line's OTHER legs
    if (p.buttresses) {
      const bt = p.buttresses, sides = bt.side === "both" ? [1, -1] : [f];
      const tally = { built: 0, corner: 0, low: 0, tight: 0, arches: 0 };
      const builtB: { sd: number; a: number; depth: number; yMid: number; top: number }[] = []; // (for the blind arches)
      const near = (s: number) => { let b = 0; for (let j = 1; j < stations.length; j++) if (Math.abs(stations[j]! - s) < Math.abs(stations[b]! - s)) b = j; return b; };
      for (let a = bt.every / 2; a < L - bt.width / 2; a += bt.every) {
        if (!B.clearOfCorners(a - bt.width / 2, a + bt.width / 2, reach + bt.depth)) { tally.corner++; continue; } // a corner stiffens itself
        const ia = near(a - bt.width / 2), ib = near(a + bt.width / 2), span = stations.map((_, j) => j).filter((j) => j >= ia && j <= ib);
        const top = Math.min(...span.map((j) => bodyTop(j))) - bt.below, w = Math.min(...span.map((j) => W(stations[j]!) / 2)), bh = Math.max(...span.map((j) => bH(j)));
        const q = curve.at(a);
        for (const sd of sides) {
          const g = Math.min(...span.map((j) => gSide[sd > 0 ? 1 : 0][j]!)), y0 = Math.min(...span.map((j) => ybSide(j, sd > 0 ? 1 : 0)));
          if (top - g < Math.max(bt.minHeight, 1)) { tally.low++; continue; }
          // clearance to the other legs: the foot's outer point vs every station farther than the buttress's reach along the line
          const n0 = w + bh;
          let depth = bt.depth;
          for (let j = 0; j < stations.length; j++) {
            if (Math.abs(stations[j]! - a) < n0 + bt.depth + bt.width + 2) continue;
            const o = curve.at(stations[j]!), half = W(stations[j]!) / 2 + bH(j) + 0.25;
            for (let d = 0.2; d <= depth + 1e-6; d += 0.1) { const px = q.x - q.tz * sd * (n0 + d), pz = q.z + q.tx * sd * (n0 + d);
              // distance from the point to the other station's cross-section line (along its own tangent: within its station step)
              const along = (px - o.x) * o.tx + (pz - o.z) * o.tz, across = Math.abs(-(px - o.x) * o.tz + (pz - o.z) * o.tx);
              if (Math.abs(along) <= p.step / 2 + 0.05 && across < half) { depth = d - 0.2; break; } }
          }
          if (depth < 0.4) { tally.tight++; continue; }
          tally.built++;
          const inN = w - 0.3, out = (d: number) => sd * (n0 + d);
          const ring = (d: number, y: number) => { const a0 = Math.min(sd * inN, out(d)), a1 = Math.max(sd * inN, out(d));
            return chamferRect(a - bt.width / 2, a + bt.width / 2, a0, a1, bevel, sd > 0 ? [false, false, true, true] : [true, true, false, false]).map(([s, n]) => [s, y, n] as W3); };
          const yMid = Math.min(top - 0.2, Math.max(y0 + 0.5, g + 0.4));
          B.rings("buttress", [ring(depth, y0 - 0.2), ring(depth, yMid), ring(depth * bt.taper, top)]);
          builtB.push({ sd, a, depth, yMid, top });
        }
      }
      // blind arches between NEIGHBOURING buttresses on one side (none skipped between them): each a solid from the arch's
      // soffit up to the row top, ends buried 0.1 m in the buttresses, its back 0.45 m inside the body (never on a plane
      // the buttress or the face owns), standing out of the face by the row's projection
      if (bt.arches) {
        const ar = bt.arches, dAt = (b: (typeof builtB)[number], y: number) => (y <= b.yMid ? b.depth : b.depth + (b.depth * bt.taper - b.depth) * Math.min(1, (y - b.yMid) / Math.max(1e-6, b.top - b.yMid)));
        for (const sd of sides) {
          const bs = builtB.filter((b) => b.sd === sd).sort((u, v) => u.a - v.a);
          for (let k = 0; k + 1 < bs.length; k++) {
            const b1 = bs[k]!, b2 = bs[k + 1]!;
            if (b2.a - b1.a > bt.every + 1e-6) continue; // a buttress skipped between them
            const sL = b1.a + bt.width / 2, sR = b2.a - bt.width / 2, r = (sR - sL) / 2, mid = (sL + sR) / 2;
            if (r < 0.5 || !B.clearOfCorners(sL - 0.1, sR + 0.1, reach + bt.depth)) continue;
            const ia = near(sL), ib = near(sR), span = stations.map((_, j) => j).filter((j) => j >= ia && j <= ib);
            const g = Math.max(...span.map((j) => gSide[sd > 0 ? 1 : 0][j]!)), w = Math.min(...span.map((j) => W(stations[j]!) / 2)), n0 = w + Math.max(...span.map((j) => bH(j)));
            const top0 = Math.min(b1.top, b2.top, ...span.map((j) => bodyTop(j) - bt.below));
            for (let row = 0; ; row++) {
              const yTop = top0 - row * (ar.tier ?? Infinity), spring = yTop - ar.band - r;
              if (!(spring >= g + 1.5)) break;
              const pr = Math.min(ar.projection, dAt(b1, yTop) - 0.2, dAt(b2, yTop) - 0.2);
              if (pr < 0.2) break;
              const nA = sd * (w - 0.45), nB = sd * (n0 + pr), lo = Math.min(nA, nB), hi = Math.max(nA, nB), N = 12;
              const ss = [sL - 0.1, ...Array.from({ length: N + 1 }, (_, i) => sL + ((sR - sL) * i) / N), sR + 0.1];
              const soffit = (s: number) => spring + Math.sqrt(Math.max(0, r * r - (s - mid) ** 2));
              B.rings("buttress", ss.map((s) => chamferRect(lo, hi, soffit(s), yTop, 0).map(([n, y]) => [s, y, n] as W3)));
              tally.arches++;
              if (ar.tier == null) break;
            }
          }
        }
      }
      report.buttresses = tally; // built; skipped at corners (stations), under minHeight, no room before another leg (sides)
    }
    // deck slab on the sloped stretches (split around flights)
    const runs: number[][] = []; let cur: number[] | null = null;
    for (let i = 0; i < steep.length; i++) { if (!steep[i]) { if (!cur) cur = [i]; cur.push(i + 1); } else if (cur) { runs.push(cur); cur = null; } }
    if (cur) runs.push(cur);
    for (const run of runs) {
      B.sweep("deck", run.map((i) => stations[i]!), (s, k) => { const i = run[k]!, w = W(s) / 2; return chamferRect(-inner(-1, w, 0, 0), inner(1, w, 0, 0), bodyTop(i), Y[i]!, Math.min(bevel, 0.05), [false, false, true, true]); }, reach);
    }
    // flights: treads (blocks across the deck), riser <= r.riser
    let treads = 0;
    for (const [ia, ib] of flights) {
      const sa = stations[ia]!, sb = stations[ib]!, ya = Y[ia]!, yB = Y[ib]!;
      const n = Math.max(1, Math.ceil(Math.abs(yB - ya) / r.riser)), run = (sb - sa) / n, rise = (yB - ya) / n;
      if (run < 0.25) warnings.push(`flight ${sa.toFixed(0)}-${sb.toFixed(0)} m: treads ${run.toFixed(2)} m (< 0.25): the levels are too steep`);
      for (let k = 0; k < n; k++) {
        const a = sa + k * run, b = a + run;
        // ascending in s: tread k is level at the top of riser k+1; descending: at the top of riser k
        const yk = rise > 0 ? ya + (k + 1) * rise : ya + k * rise;
        const w = W((a + b) / 2) / 2;
        // (at the line's ends a tread stands 0.03 m proud of the body's end face, never on it)
        // (a tread in another material variant than the one before it starts flush on that one's end instead of 0.02 m
        // into it: their side faces would share that strip)
        const newBand = k > 0 && B.roleAt("deck", (a + b) / 2) !== B.roleAt("deck", a - run / 2);
        // (the line's ends by index: sa + n x run lands a hair short of L, and the last tread stood 0.01 m proud of the
        // body's end face, on one plane with it: Ironspur climb stair head)
        const first = ia === 0 && k === 0, last = ib === stations.length - 1 && k === n - 1;
        const prof = chamferRect(a - (first ? 0.03 : newBand ? -0.01 : 0.01), b + (last ? 0.03 : 0.01), yk - Math.abs(rise) - r.deck - r.riser - 0.1, yk, Math.min(bevel, 0.04), rise > 0 ? [false, false, false, true] : [false, false, true, false]);
        B.rings("deck", [-inner(-1, w, 0.05, 0.04), inner(1, w, 0.05, 0.04)].map((nn) => prof.map(([s, y]) => [s, y, nn] as W3)));
        treads++;
      }
    }
    // kerbs / parapets: along the whole line at Y + height (straight over the flights' nosing line)
    const edgeSweep = (role: string, sd: number, width: number, height: number) => B.sweep(role, stations, (s, i) => {
      const w = W(s) / 2, a = sd > 0 ? w - width : -w, b = sd > 0 ? w : -w + width;
      return chamferRect(a, b, bodyTop(i), Y[i]! + height, bevel, [false, false, true, true]);
    }, reach);
    for (const sd of kerbSides) edgeSweep("kerb", sd, kerb!.width, kerb!.height);
    for (const sd of parSides) edgeSweep("parapet", sd, pp!.thickness, pp!.height);
    // (the footing projects >= 0.05 m past the body on every side and past both ends: its faces never lie on the body's)
    if (p.footing) B.sweep("footing", [stations[0]! - fP, ...stations.slice(1, -1), stations.at(-1)! + fP], (_s, i) => { const w = W(stations[i]!) / 2 + bH(i); return chamferRect(-w - fP, w + fP, yb[i]!, footTopR(i), bevel, [false, false, true, true]); }, reach);
    const atS = (s: number, i: number, name: string) => { const q = curve.at(s); deckTargets.push({ name, at: [r4(q.x), r4(Y[i]! + 0.1), r4(q.z)] }); };
    const mid = stations.findIndex((s) => s >= L / 2);
    atS(stations[1] ?? 0, 1, "ramp-foot"); atS(stations[mid]!, mid, "ramp-mid"); atS(stations.at(-2)!, stations.length - 2, "ramp-head");
    let maxGrade = 0; for (let i = 0; i + 1 < stations.length; i++) if (!steep[i]) maxGrade = Math.max(maxGrade, Math.abs(Y[i + 1]! - Y[i]!) / (stations[i + 1]! - stations[i]!));
    report.deck = { from: r4(Y[0]!), to: r4(Y.at(-1)!), maxSlopeGrade: r4(maxGrade), flights: flights.map(([a, b]) => [r4(stations[a]!), r4(stations[b]!)]), treads };
    // the walk line every ~8 m (world xyz on the deck): paste into handoff navigation.routes
    const route: number[][] = [];
    stations.forEach((s, i) => { if (i === 0 || i === stations.length - 1 || Math.floor(s / 8) !== Math.floor(stations[i - 1]! / 8)) { const q = curve.at(s); route.push([Math.round(q.x * 10) / 10, Math.round((Y[i]! + 0.1) * 10) / 10, Math.round(q.z * 10) / 10]); } });
    report.route = route;
    const exposed = Math.max(...Y.map((y, i) => y - gLo[i]!));
    if (!pp && exposed > 2) warnings.push(`the deck stands ${exposed.toFixed(1)} m over the ground with kerbs only: add a parapet on the drop side`);
  }

  /** One masked height patch over a band of half-width `band` around the line (stations 0..L): fn -> new height or null (untouched). */
  function bandPatch(id: string, band: number, fn: (h0: number, i: number, n: number) => number | null, claim = 0): OperatorPiece | null {
    const g = reader.voxelSize;
    const pts = stations.map((s, i) => { const q = curve.at(s); return { s, i, x: q.x, z: q.z, rx: -q.tz, rz: q.tx }; }).filter((q) => q.s >= 0 && q.s <= L);
    let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
    for (const q of pts) for (const d of [-band, band]) { x0 = Math.min(x0, q.x + q.rx * d); x1 = Math.max(x1, q.x + q.rx * d); z0 = Math.min(z0, q.z + q.rz * d); z1 = Math.max(z1, q.z + q.rz * d); }
    // pad past the blend (2 cells): the patch rectangle's own edge feather must fall on untouched nodes, never on the line's ends
    x0 = Math.floor((x0 - 3 * g) / g) * g; z0 = Math.floor((z0 - 3 * g) / g) * g; x1 = Math.ceil((x1 + 3 * g) / g) * g; z1 = Math.ceil((z1 + 3 * g) / g) * g;
    const cols = Math.round((x1 - x0) / g) + 1, rows = Math.round((z1 - z0) / g) + 1;
    const heights: number[] = [], weights: number[] = [];
    let changed = 0;
    for (let rr = 0; rr < rows; rr++) for (let cc = 0; cc < cols; cc++) {
      const x = x0 + cc * g, z = z0 + rr * g, h0 = reader.height(x, z);
      let best = Infinity, q0 = pts[0]!;
      for (const p of pts) { const d = (p.x - x) ** 2 + (p.z - z) ** 2; if (d < best) { best = d; q0 = p; } }
      const along0 = (x - q0.x) * -q0.rz + (z - q0.z) * q0.rx;
      // never past the ends: the line's ends meet the natural ground (a ramp head flush with it)
      const past = (q0.i === pts[0]!.i && along0 < 0) || (q0.i === pts.at(-1)!.i && along0 > 0);
      let h: number | null = null;
      if (!past) {
        // EVERY piece of the line passing the node within the band has its say and the lowest wins (the patch only
        // ever lowers): nearest-station-only gave the node between two switchback legs to the leg above (uncut there),
        // and the 2 m lattice + tent filter drew an earth wedge ~1 m over the landing below, inside its bank-side
        // parapet (weeping-stair, -2448,87.5,-1081). A station speaks for the nodes in its 1.5-cell slice.
        // ... except past the CENTRELINE of a body the node lies under (|n| <= claim) as seen from the piece that cut
        // deepest: there the body speaks for itself (the landing below digs up to and under the face of the leg above,
        // which then stands down to it, but never bares that leg's uphill face)
        let from: (typeof pts)[number] | null = null, own: number | null = null;
        const under: { q: (typeof pts)[number]; n: number }[] = [];
        for (const q of pts) {
          const n = (x - q.x) * q.rx + (z - q.z) * q.rz, along = (x - q.x) * -q.rz + (z - q.z) * q.rx;
          if (Math.abs(n) > band || Math.abs(along) >= g * 1.5) continue;
          const v = fn(h0, q.i, n);
          if (v === null) continue;
          if (h === null || v < h) { h = v; from = q; }
          if (Math.abs(n) <= claim) { under.push({ q, n }); if (own === null || v < own) own = v; }
        }
        if (from && under.length && !under.some((u) => u.q === from)) {
          const far = under.some(({ q, n }) => { const nf = (from!.x - q.x) * q.rx + (from!.z - q.z) * q.rz; return Math.abs(nf) > claim && Math.sign(nf) !== Math.sign(n) && Math.abs(n) > 1e-6; });
          if (far) h = own;
        }
      }
      heights.push(Math.round((h ?? h0) * 100) / 100); weights.push(h === null ? 0 : 1);
      if (h !== null) changed++;
    }
    report[id] = { cells: changed };
    return changed ? { id, origin: [x0, z0], size: [(cols - 1) * g, (rows - 1) * g], columns: cols, rows, heights, weights, blend: 2 * g, ...(id === "cut" && p.ramp.cut?.calm ? { calm: true } : {}) } : null;
  }

  function backfillPatch(top: number[], back: number[]): OperatorPiece | null {
    const bf = p.backfill!;
    const g = reader.voxelSize, reach = bf.width + bf.feather;
    const sb = -f; // earth side sign
    const pts = stations.map((s, i) => { const q = curve.at(s); return { s, i, x: q.x, z: q.z, rx: -q.tz, rz: q.tx }; });
    let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
    for (const q of pts) for (const d of [0, sb * (reach + W0)]) { x0 = Math.min(x0, q.x + q.rx * d); x1 = Math.max(x1, q.x + q.rx * d); z0 = Math.min(z0, q.z + q.rz * d); z1 = Math.max(z1, q.z + q.rz * d); }
    x0 = Math.floor((x0 - g) / g) * g; z0 = Math.floor((z0 - g) / g) * g; x1 = Math.ceil((x1 + g) / g) * g; z1 = Math.ceil((z1 + g) / g) * g;
    const cols = Math.round((x1 - x0) / g) + 1, rows = Math.round((z1 - z0) / g) + 1;
    const heights: number[] = [], weights: number[] = [];
    let raised = 0;
    for (let rr = 0; rr < rows; rr++) for (let cc = 0; cc < cols; cc++) {
      const x = x0 + cc * g, z = z0 + rr * g, h0 = reader.height(x, z);
      let best = Infinity, bi = -1;
      for (const q of pts) { const d = (q.x - x) ** 2 + (q.z - z) ** 2; if (d < best) { best = d; bi = q.i; } }
      const q = pts[bi]!, n = (x - q.x) * q.rx + (z - q.z) * q.rz, d = sb * (n - back[bi]!);
      let h = h0, w = 0;
      if (q.s >= 0 && q.s <= L && d >= -0.5 && d <= reach + g) {
        const t = d <= bf.width ? 1 : 1 - Math.min(1, (d - bf.width) / bf.feather), u = t * t * (3 - 2 * t);
        h = Math.max(h0, h0 + (top[bi]! - h0) * u); w = 1; if (h > h0 + 0.05) raised++;
      }
      heights.push(Math.round(h * 100) / 100); weights.push(w);
    }
    report.backfill = { cells: raised };
    return raised ? { id: "backfill", origin: [x0, z0], size: [(cols - 1) * g, (rows - 1) * g], columns: cols, rows, heights, weights, blend: 2 * g } : null;
  }

  // ---- report
  report.length = r4(L); report.stations = stations.length; report.variant = p.variant; report.scale = p.scale;
  const spec = B.spec();
  const tris: Record<string, number> = {};
  for (const [k, v] of B.roles) tris[k] = v.idx.length / 3;
  report.triangles = tris;
  report.minRadius = Number.isFinite(curve.minRadius) ? r4(curve.minRadius) : null;
  const halfMax = W0 / 2 + p.batter * p.height + footProj + (p.buttresses?.depth ?? 0);
  if (curve.minRadius < halfMax + 0.5) warnings.push(`the line turns at radius ${curve.minRadius.toFixed(1)} m, under the wall's half-width ${halfMax.toFixed(1)} m: the inner face folds (ease the bend or smooth the points)`);
  report.minFaceTile = D.minFaceTile;
  if (B.dropped) warnings.push(`${B.dropped} piece(s) at corners were too short for their section and left out (lengthen the legs between close corners)`);
  report.warnings = warnings;
  return { spec, at: origin, ground: ground_, report, deckTargets };
}

// ------------------------------------------------------------------------------------------------ operator
const ROLE_FALLBACK: Record<string, string[]> = {
  buttress: ["face"], pier: ["face"], parapet: ["face"], merlon: ["parapet", "face"], stair: ["face"], kerb: ["cap", "face"],
  deck: ["cap", "face"], footing: ["face"], cap: ["face"],
};
/** Role -> material or variant list (explicit roles first, then the fallbacks: a fallback role inherits the list). */
function wallMaterialLists(p: Pick<WallParams, "materials">): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = { ...p.materials };
  for (const [role, chain] of Object.entries(ROLE_FALLBACK)) if (!out[role]) for (const c of chain) if (p.materials[c]) { out[role] = p.materials[c]!; break; }
  return out;
}
/** The role -> material map handed to the landmark (explicit roles first, then the fallbacks); a variant list's k-th
 *  entry (k >= 2) is role `<role>~k`. */
export function wallMaterials(p: Pick<WallParams, "materials">): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [role, m] of Object.entries(wallMaterialLists(p))) (Array.isArray(m) ? m : [m]).forEach((id, k) => { out[k ? `${role}~${k + 1}` : role] = id; });
  return out;
}

registerLandmarkGenerator("wall", (args, reader, ctx) => {
  const w = buildWall(args, reader, ctx);
  return { spec: w.spec, at: w.at, footY: 0, ground: w.ground };
});

/**
 * The landmark operator params a wall doc compiles through (`kind: built`, source = the `wall` generator, y 0: the
 * spec is in world heights). The baker (tools/landmark.mts) and op-preview read a wall through this.
 */
export function wallLandmarkParams(input: unknown, reader?: OperatorFieldReader, ctx?: { id: string }, built?: { deckTargets: { name: string; at: [number, number, number] }[] }): LandmarkOperatorParams {
  const p = wallParamsSchema.parse(input);
  const at = wallOrigin(p);
  const { materials: _m, targets, seed, fog, ...rest } = p;
  const extra = built ? built.deckTargets : reader && ctx ? buildWall(p, reader, ctx).deckTargets : [];
  const local = (q: readonly number[]) => [Math.round((q[0]! - at[0]) * 100) / 100, q[1]!, Math.round((q[2]! - at[1]) * 100) / 100] as [number, number, number];
  return landmarkOperatorSchema.parse({
    // (variant lists ride in the generator args: the builder splits the solids by them; plain materials stay out, so
    // a wall without lists keeps its digest)
    kind: "built", at, y: 0, source: { generator: "wall", args: { ...rest, seed, ...(Object.values(p.materials).some((m) => Array.isArray(m) && m.length > 1) ? { materials: p.materials } : {}) } },
    materials: wallMaterials(p), blend: { mode: "none" }, seed,
    targets: [...targets, ...extra].slice(0, 32).map((t) => ({ name: t.name, at: local(t.at) })),
    ...(fog ? { fog } : {}),
  });
}

function compileWall(params: WallParams, reader: OperatorFieldReader, ctx: { id: string }): OperatorOutput {
  const w = buildWall(params, reader, ctx);
  const out = compileLandmark(wallLandmarkParams(params, reader, ctx, w), reader, ctx);
  return { features: out.features, report: { ...out.report, wall: w.report, targets: w.deckTargets.map((t) => t.name) } };
}

function wallBounds(raw: WallParams) {
  const parsed = wallParamsSchema.safeParse(raw); // bounds may be asked of the raw doc params
  const p = parsed.success ? parsed.data : wallParamsSchema.parse({ points: raw.points });
  const pad = p.thickness / 2 + p.batter * p.height + 4 + (p.buttresses?.depth ?? 0) + (p.backfill ? p.backfill.width + p.backfill.feather : 0) + (p.ends.tie ?? 2 * p.thickness + 2);
  let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
  for (const [x, z] of p.points) { x0 = Math.min(x0, x); z0 = Math.min(z0, z); x1 = Math.max(x1, x); z1 = Math.max(z1, z); }
  return { x0: x0 - pad, z0: z0 - pad, x1: x1 + pad, z1: z1 + pad };
}

registerOperator<WallParams>({
  op: "wall",
  description:
    "A SWEPT WALL or CAUSEWAY RAMP along a plan line (built landmark: real meshes, UVs in metres at the role tile, per-part materials face/cap/footing/..., per-cell trimesh collider): free-standing, retaining (earth behind, optional backfill), quay, or `ramp` (sloped deck with kerbs/parapet, stair flights where steeper than maxGrade, risers <= 0.4 m). Profile: thickness, height (follow/step/level with the ground), batter, coping, footing, seeded per-block irregularity, bevels; buttresses every N m, crenellated parapet, gates at stations, stair flights along a face, ends into terrain or a pier. Never stack boxes for a wall or a ramp.",
  schema: wallParamsSchema,
  compile: compileWall,
  bounds: wallBounds,
  outline: (p) => [p.points.map(([x, z]) => [x, z] as [number, number])],
});

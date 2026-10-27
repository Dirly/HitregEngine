/**
 * `cliff-path` — a LEDGE ROAD cut into a cliff face with switchbacks (owner ruling 2026-10-21: a cliff descent is a winch
 * lift or a carved cliff-edge path, never a stack of repeated stair modules; a ledge path cut into the face IS carved).
 *
 * The path zig-zags across the face between two turning lines (`ends`), from `top` to `bottom`, at one even grade with a
 * level turning platform at every hairpin. Each sample sits where the face's contour lets the WHOLE road width be cut into
 * the rock (the outer edge on the natural ground at the road's height), so the road is a bench: a cut-back wall on the
 * inside, the natural drop on the outside. It compiles to carved + painted ROADS (`features.roads`, the same system as every
 * footpath): `op:<id>:path` (the line, per-point surfaceY) and `op:<id>:turn-<n>` (one wide, level pad per hairpin, cut
 * inward). The parapet at the drops is the place builder's job (`place-build cliff-path`), from the report's `parapet`.
 *
 * `solveCliffPath` is the pure planner (tests: leg count, grade).
 */
import { z } from "zod";
import { registerOperator, type OperatorBounds, type OperatorFieldReader, type OperatorOutput } from "./operator-registry.js";

const xz = z.tuple([z.number().finite(), z.number().finite()]);

export const cliffPathOperatorSchema = z.object({
  top: xz.describe("[x, z] where the path leaves the cliff top (on the rim ground)."),
  bottom: xz.describe("[x, z] where the path reaches the foot (on the floor ground, dry)."),
  ends: z.tuple([xz, xz]).describe("Two [x, z] points on the face marking the two TURNING LINES: the legs run along the face between them (the line through them is the face's run; the hairpins stand on the perpendiculars through them)."),
  legs: z.number().int().min(1).max(12).describe("Number of legs. Leg 1 runs from `top` to the farther turning line, the last ends at `bottom`."),
  width: z.number().min(3.4).max(4).default(3.8).describe("Road width, metres (a footpath ledge: 3.4-4)."),
  maxGrade: z.number().min(0.08).max(0.35).default(0.27).describe("Steepest allowed rise/run along the legs (0.27 = the trail cap, 1.5 x the 0.18 footpath grade). The solver reports `GRADE` past it: add a leg or move the ends apart."),
  turnWidth: z.number().min(6).max(12).default(8).describe("Width of a hairpin's level turning platform, metres (cut INTO the face from the road's outer edge)."),
  turnLength: z.number().min(6).max(16).default(8).describe("Length along the face of each hairpin platform, metres (level: the grade is taken up on the legs)."),
  shoulder: z.number().min(0.5).max(4).default(1.2).describe("Metres over which the road's cut eases into the face: small = a near-vertical cut-back wall (a ledge cut into rock)."),
  surface: z.string().default("dirt").describe("Palette surface painted along the road (the zone's `road` ground role overrides it, as on any road)."),
  smooth: z.number().min(0).max(30).default(10).describe("Metres of along-face smoothing of the line's offset into the face (the contour wobbles; the road should not)."),
  topY: z.number().finite().optional().describe("Road height at `top` (default: the ground there)."),
  bottomY: z.number().finite().optional().describe("Road height at `bottom` (default: the ground there)."),
});
export type CliffPathParams = z.infer<typeof cliffPathOperatorSchema>;

export interface CliffPathPoint { x: number; z: number; y: number; s: number; n: number; leg: number; turn: boolean }
export interface CliffPathSolution {
  points: CliffPathPoint[];
  /** Hairpins: the platform's centre line (two points), its level y and width. */
  turns: Array<{ a: [number, number]; b: [number, number]; y: number }>;
  topY: number;
  bottomY: number;
  drop: number;
  /** Arclength of the line along the face (legs + platforms), metres. */
  length: number;
  /** The grade on the legs (the platforms are level). */
  grade: number;
  /** Unit vectors: `t` along the face (end 0 -> end 1), `out` horizontal down-slope (into the drop). */
  t: [number, number];
  out: [number, number];
  /** Where a parapet stands: the outer edge, every 2 m where the drop below is over 1.5 m; yaw = the road's heading. */
  parapet: Array<{ x: number; z: number; y: number; yaw: number }>;
  faults: string[];
}

const r2 = (v: number) => Math.round(v * 100) / 100;
const STEP = 2;

/** The planner (pure: params + ground -> the line). */
export function solveCliffPath(p: CliffPathParams, ground: (x: number, z: number) => number): CliffPathSolution {
  const faults: string[] = [];
  const [e0, e1] = p.ends;
  const dx = e1[0] - e0[0], dz = e1[1] - e0[1], span = Math.hypot(dx, dz);
  if (span < 12) throw new Error(`cliff-path: the turning lines are ${span.toFixed(1)} m apart (at least 12)`);
  const t: [number, number] = [dx / span, dz / span];
  // `out` is the horizontal normal that points DOWN the face (from top toward bottom)
  let out: [number, number] = [-t[1], t[0]];
  const ofs = (q: [number, number]) => (q[0] - e0[0]) * out[0] + (q[1] - e0[1]) * out[1];
  if (ofs(p.bottom) < ofs(p.top)) out = [-out[0], -out[1]];
  const sOf = (q: [number, number]) => (q[0] - e0[0]) * t[0] + (q[1] - e0[1]) * t[1];
  const nOf = (q: [number, number]) => (q[0] - e0[0]) * out[0] + (q[1] - e0[1]) * out[1];
  const at = (s: number, n: number): [number, number] => [e0[0] + t[0] * s + out[0] * n, e0[1] + t[1] * s + out[1] * n];

  const topY = p.topY ?? ground(p.top[0], p.top[1]);
  const bottomY = p.bottomY ?? ground(p.bottom[0], p.bottom[1]);
  const drop = topY - bottomY;
  if (drop < 6) faults.push(`DROP: ${r2(drop)} m from top to bottom (a cliff path descends at least 6 m)`);

  // the legs along s: top -> far end -> other end ... -> bottom
  const sTop = sOf(p.top), sBot = sOf(p.bottom);
  const nearEnd = Math.abs(sTop) <= Math.abs(sTop - span) ? 0 : span;
  const stops: number[] = [sTop];
  let cur = nearEnd === 0 ? span : 0;
  for (let i = 0; i < p.legs - 1; i++) { stops.push(cur); cur = cur === 0 ? span : 0; }
  stops.push(sBot);
  // a last leg that would run back over its own turn (bottom beyond the turn it starts from) is a planning fault
  for (let i = 0; i + 1 < stops.length; i++) if (Math.abs(stops[i + 1]! - stops[i]!) < 4) faults.push(`LEGS: leg ${i + 1} is ${r2(Math.abs(stops[i + 1]! - stops[i]!))} m long (top/bottom sit on a turning line: drop a leg or move the ends)`);
  const turns = p.legs - 1;
  const legLen = stops.slice(1).reduce((a, s, i) => a + Math.abs(s - stops[i]!), 0);
  const sloped = legLen - turns * p.turnLength;
  if (sloped <= 0) throw new Error(`cliff-path: the legs (${legLen.toFixed(0)} m) are shorter than the platforms`);
  const grade = drop / sloped;
  if (grade > p.maxGrade + 1e-9) faults.push(`GRADE: ${r2(grade)} on the legs over ${r2(sloped)} m (cap ${p.maxGrade}): add a leg or move the ends apart (or a lift, if the face has no room)`);

  // samples: each leg every STEP m along s; the platform halves at each hairpin are level
  const half = p.turnLength / 2;
  const raw: Array<{ s: number; y: number; leg: number; turn: boolean }> = [];
  let walked = 0, y = topY;
  for (let i = 0; i + 1 < stops.length; i++) {
    const a = stops[i]!, b = stops[i + 1]!, len = Math.abs(b - a), dir = Math.sign(b - a) || 1;
    const flatStart = i > 0 ? half : 0, flatEnd = i + 1 < stops.length - 1 ? half : 0;
    const n = Math.max(1, Math.round(len / STEP));
    for (let k = i === 0 ? 0 : 1; k <= n; k++) {
      const d = (len * k) / n;
      // y: level over the platform halves, the grade in between
      const slopedTo = Math.min(Math.max(d - flatStart, 0), len - flatStart - flatEnd);
      const yy = y - grade * slopedTo;
      raw.push({ s: a + dir * d, y: yy, leg: i, turn: d < flatStart - 1e-6 || d > len - flatEnd + 1e-6 });
    }
    y -= grade * (len - flatStart - flatEnd);
    walked += len;
  }
  if (raw.length) { raw[raw.length - 1]!.y = bottomY; }

  // n: where the road's OUTER edge meets the natural ground at the road height (the whole width cut into the face)
  const nLo = Math.min(nOf(p.top), nOf(p.bottom)) - 30, nHi = Math.max(nOf(p.top), nOf(p.bottom)) + 30;
  const contour = (s: number, yy: number): number | null => {
    for (let n = nLo; n <= nHi; n += 0.25) {
      const q = at(s, n + p.width / 2);
      if (ground(q[0], q[1]) <= yy) return n;
    }
    return null;
  };
  const ns: number[] = raw.map((r, i) => {
    const n = contour(r.s, r.y);
    if (n === null) { faults.push(`FACE: no face at the road's height ${r2(r.y)} near ${JSON.stringify(at(r.s, 0).map(r2))} (sample ${i})`); return NaN; }
    return n;
  });
  // the top and bottom stay where they were asked
  ns[0] = nOf(p.top); ns[ns.length - 1] = nOf(p.bottom);
  // smooth n per leg (a moving average over `smooth` metres); the platforms share their hairpin's mean
  const win = Math.max(0, Math.round(p.smooth / STEP / 2));
  const sm = ns.map((n, i) => {
    if (i === 0 || i === ns.length - 1 || win === 0) return n;
    let sum = 0, c = 0;
    for (let k = -win; k <= win; k++) {
      const j = i + k;
      if (j <= 0 || j >= ns.length - 1 || raw[j]!.leg !== raw[i]!.leg || !Number.isFinite(ns[j]!)) continue;
      sum += ns[j]!; c++;
    }
    return c ? sum / c : n;
  });
  const points: CliffPathPoint[] = raw.map((r, i) => { const q = at(r.s, sm[i]!); return { x: r2(q[0]), z: r2(q[1]), y: r2(r.y), s: r2(r.s), n: r2(sm[i]!), leg: r.leg, turn: r.turn }; });

  // hairpin platforms: level at the hairpin's height, `turnLength` along the face, cut inward to `turnWidth`
  const turnPads: CliffPathSolution["turns"] = [];
  for (let i = 1; i < stops.length - 1; i++) {
    const sEnd = stops[i]!, inward = Math.sign(stops[i - 1]! - sEnd) || 1;
    const here = points.filter((q) => q.turn && (q.leg === i - 1 || q.leg === i) && Math.abs(q.s - sEnd) <= half + 0.01);
    if (!here.length) continue;
    const yy = here[0]!.y, nMid = here.reduce((a, q) => a + q.n, 0) / here.length - (p.turnWidth - p.width) / 2;
    const a = at(sEnd + inward * Math.max(0, p.turnLength - p.turnWidth / 2), nMid), b = at(sEnd - inward * 0.5, nMid);
    turnPads.push({ a: [r2(a[0]), r2(a[1])], b: [r2(b[0]), r2(b[1])], y: r2(yy) });
  }

  // parapet: the outer edge where the ground 2 m beyond it is 1.5 m or more below the road
  const parapet: CliffPathSolution["parapet"] = [];
  for (let i = 0; i + 1 < points.length; i++) {
    const a = points[i]!, b = points[i + 1]!;
    if (a.turn && b.turn) continue; // the platform's lip gets the next leg's run; the hairpin itself stays open to walk
    const hx = b.x - a.x, hz = b.z - a.z, hl = Math.hypot(hx, hz);
    if (hl < 0.5) continue;
    const mx = (a.x + b.x) / 2 + out[0] * (p.width / 2 - 0.3), mz = (a.z + b.z) / 2 + out[1] * (p.width / 2 - 0.3), my = (a.y + b.y) / 2;
    if (ground(mx + out[0] * 2.3, mz + out[1] * 2.3) > my - 1.5) continue;
    parapet.push({ x: r2(mx), z: r2(mz), y: r2(my), yaw: r2(Math.atan2(hx, hz)) });
  }
  return { points, turns: turnPads, topY: r2(topY), bottomY: r2(bottomY), drop: r2(drop), length: r2(walked), grade: Math.round(grade * 1000) / 1000, t, out, parapet, faults };
}

function compileCliffPath(p: CliffPathParams, reader: OperatorFieldReader): OperatorOutput {
  const sol = solveCliffPath(p, (x, z) => reader.height(x, z));
  const road = (id: string, pts: Array<[number, number]>, ys: number[], width: number) => ({
    id, points: pts, surfaceY: ys, width, shoulder: p.shoulder, smooth: 0, flatten: 1, surface: p.surface, surfaceEdge: 1, keepLandforms: true,
  });
  const roads = [road("path", sol.points.map((q) => [q.x, q.z] as [number, number]), sol.points.map((q) => q.y), p.width)];
  sol.turns.forEach((tp, i) => roads.push(road(`turn-${i + 1}`, [tp.a, tp.b], [tp.y, tp.y], p.turnWidth)));
  const { points, ...rest } = sol;
  return {
    features: { roads },
    report: { ...rest, points: points.map((q) => [q.x, q.y, q.z, q.leg, q.turn ? 1 : 0]) },
  };
}

function cliffBounds(p: CliffPathParams): OperatorBounds {
  const xs = [p.top[0], p.bottom[0], p.ends[0][0], p.ends[1][0]], zs = [p.top[1], p.bottom[1], p.ends[0][1], p.ends[1][1]];
  const pad = 40;
  return { x0: Math.min(...xs) - pad, z0: Math.min(...zs) - pad, x1: Math.max(...xs) + pad, z1: Math.max(...zs) + pad };
}

registerOperator<CliffPathParams>({
  op: "cliff-path",
  description:
    "A LEDGE ROAD cut into a cliff face: switchback legs between two turning lines from `top` to `bottom` at one even grade (cap `maxGrade`), level turning platforms at the hairpins, the whole width cut into the face; compiles to carved + painted roads `op:<id>:path` + `op:<id>:turn-<n>`. The descent ruling: a cliff path or a winch lift, never repeated stair flights.",
  schema: cliffPathOperatorSchema,
  compile: compileCliffPath,
  bounds: cliffBounds,
  outline: (p) => [[p.top, p.ends[0], p.ends[1], p.bottom]],
});

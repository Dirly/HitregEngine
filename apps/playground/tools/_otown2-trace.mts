// o-town2 scratch (deleted when the round ends): Bell Strand (town-1) design RE-TRACED from the approved bird's-eye
// painting (towns/concept/town-1-top.png) with k-town2's kit: enterable 9.6 m party-wall row houses at EXACTLY the
// kit's row pitch (fronts on one line, straight rows only), strand-row-filler for short gaps, the smithy, inn, workshop
// (+ yard), hovels / sheds / boat shed outside the walls, the chapel INSIDE the curtain. Envelopes are measured from the
// shipped GLBs (tools/_otown2-measure.mts output). Also writes the curtain line for `town-wall-line kit`.
//   npx tsx tools/_otown2-trace.mts <measure.json> <design.json> <envelopes.json> <wall-line.json>
import fs from "node:fs";
import { bareOfTown } from "./worldgen-terrace-from-plan.mts";
import { createWorldField, worldRecipeSchema } from "@hitreg/core";
import { footprintOf, rowPairFault, type Envelopes } from "./town-design-check.mts";
import { layKitWall, worldFootprint } from "./_kit-wall.mts";
import { packRow, rowPackTypes, isCorner } from "./town-row-pack.mts";

type V2 = [number, number];
const [MEAS, OUT, ENVF, WALLF] = process.argv.slice(2) as [string, string, string, string];
const measure = JSON.parse(fs.readFileSync(MEAS, "utf8")) as Record<string, { x: V2; z: V2; ground: { x: V2; z: V2 }; doors: { p: number[]; yaw: number; ext: boolean }[] }>;
const recipe = worldRecipeSchema.parse(JSON.parse(fs.readFileSync("projects/redstrand/assets/worlds/redstrand.json", "utf8")));
const field = createWorldField(bareOfTown(recipe, "town-1")) as any;
const wet = (x: number, z: number) => { const w = field.waterY?.(x, z); return w !== null && w !== undefined && w > field.heightfield(x, z); };

const C: V2 = [640, -368];
const U: V2 = [-Math.SQRT1_2, -Math.SQRT1_2], V: V2 = [Math.SQRT1_2, -Math.SQRT1_2];
const r2 = (v: number) => Math.round(v * 100) / 100;
const r4 = (v: number) => Math.round(v * 10000) / 10000;
const W = (s: number, t: number): V2 => [r2(C[0] + s * U[0] + t * V[0]), r2(C[1] + s * U[1] + t * V[1])];
const Wx = (s: number, t: number): V2 => [r4(C[0] + s * U[0] + t * V[0]), r4(C[1] + s * U[1] + t * V[1])]; // exact (rows)
const L = (p: V2): V2 => { const dx = p[0] - C[0], dz = p[1] - C[1]; return [dx * U[0] + dz * U[1], dx * V[0] + dz * V[1]]; };
const dirW = (a: number, b: number): V2 => { const x = a * U[0] + b * V[0], z = a * U[1] + b * V[1]; const l = Math.hypot(x, z); return [r4(x / l), r4(z / l)]; };
const P = (pts: V2[]): V2[] => pts.map(([s, t]) => W(s, t));
const LV = { town: 58.4, close: 58.4 + +(process.env.CLOSE_RISE ?? 2), strand: 56.2 }; // the strand on the shore's own level (natural 56.0-56.8 from r 60 to the water): no walls round it

// ---------------------------------------------------------------- geometry helpers
const sub = (a: V2, b: V2): V2 => [a[0] - b[0], a[1] - b[1]];
const len = (a: V2) => Math.hypot(a[0], a[1]);
const inPoly = (pts: V2[], x: number, z: number) => { let c = false; for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) { const a = pts[i]!, b = pts[j]!; if ((a[1] > z) !== (b[1] > z) && x < ((b[0] - a[0]) * (z - a[1])) / (b[1] - a[1]) + a[0]) c = !c; } return c; };
const segD = (p: V2, a: V2, b: V2) => { const ab = sub(b, a), l2 = ab[0] ** 2 + ab[1] ** 2 || 1; const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * ab[0] + (p[1] - a[1]) * ab[1]) / l2)); return Math.hypot(p[0] - a[0] - ab[0] * t, p[1] - a[1] - ab[1] * t); };
const lineD = (pts: V2[], p: V2) => { let d = Infinity; for (let i = 0; i + 1 < pts.length; i++) d = Math.min(d, segD(p, pts[i]!, pts[i + 1]!)); return d; };
const polyEdgeD = (pts: V2[], p: V2) => { let d = Infinity; for (let i = 0; i < pts.length; i++) d = Math.min(d, segD(p, pts[i]!, pts[(i + 1) % pts.length]!)); return d; };
const densify = (pts: V2[], step: number, closed: boolean): V2[] => { const o: V2[] = []; const n = closed ? pts.length : pts.length - 1; for (let i = 0; i < n; i++) { const a = pts[i]!, b = pts[(i + 1) % pts.length]!; const k = Math.max(1, Math.ceil(len(sub(b, a)) / step)); for (let j = 0; j < k; j++) o.push([a[0] + (b[0] - a[0]) * j / k, a[1] + (b[1] - a[1]) * j / k]); } if (!closed) o.push(pts[pts.length - 1]!); return o; };
const quadGap = (A: V2[], B: V2[]): number => {
  if (A.some((p) => inPoly(B, p[0], p[1])) || B.some((p) => inPoly(A, p[0], p[1]))) return 0;
  let d = Infinity; for (const p of A) d = Math.min(d, polyEdgeD(B, p)); for (const p of B) d = Math.min(d, polyEdgeD(A, p));
  for (const p of densify(A, 0.5, true)) if (inPoly(B, p[0], p[1])) return 0;
  return d;
};

// ---------------------------------------------------------------- the curtain line (local polar: angle a from +s toward +t)
// r 55.5 on the painted ring; behind the chapel close it bows out 2 m so the close, its retaining walls and the chapel
// stand INSIDE the curtain with a walk behind them (Derek 10-30: nothing sticks out past the wall)
const RW0 = 55.5;
const bump = (a: number) => { const x = Math.abs(((((a % 360) + 540) % 360)) - 180); return x <= 16 ? 1 : x >= 34 ? 0 : (34 - x) / 18; };
const rW = (a: number) => RW0 + +(process.env.BUMP ?? 11.5) * bump(a);
const rl = (r: number, a: number): V2 => [r * Math.cos(a * Math.PI / 180), r * Math.sin(a * Math.PI / 180)];
// vertices every 15 deg (from 7.5); the two gates are mid-leg vertices (straight through) at 180 (main) and 120 (water gate, on the lake side)
const A_GATE = 180, A_POST = 120;
const PW = 7; // half-angle of the straight chord over the water gate
const wallVerts: { a: number; r: number; kind: "v" | "gate" | "tower" }[] = [];
const TOWER_AT = new Set([37.5, 67.5, 97.5, 142.5, 217.5, 247.5, 277.5, 307.5, 337.5]);
for (let a = 7.5; a < 360; a += 15) {
  wallVerts.push({ a, r: rW(a), kind: TOWER_AT.has(a) ? "tower" : "v" });
  for (const g of [A_GATE, A_POST]) if (Math.abs(a + 7.5 - g) < 1e-9) {
    const p0 = rl(rW(a), a), p1 = rl(rW(a + 15), a + 15), m: V2 = [(p0[0] + p1[0]) / 2, (p0[1] + p1[1]) / 2];
    wallVerts.push({ a: g, r: len(m), kind: "gate" });
  }
}
const wallLocal = wallVerts.map((v) => rl(v.r, v.a));
const wallPoly = wallLocal.map(([s, t]) => Wx(s, t));
const gateLocal = (a: number) => { const v = wallVerts.find((w) => w.kind === "gate" && w.a === a)!; return rl(v.r, v.a); };
const GATE = gateLocal(A_GATE), POST = gateLocal(A_POST);
// the curtain's footprint (local) for clearance: inner / outer faces at the line +- 1.2 m (towers 2.6, gates 3.5 deep)
const wallRAt = (a: number) => { // the line's radius at angle a (on the polygon)
  const d = rl(1, a); let best = Infinity;
  for (let i = 0; i < wallLocal.length; i++) {
    const p = wallLocal[i]!, q = wallLocal[(i + 1) % wallLocal.length]!;
    const e = sub(q, p), den = d[0] * e[1] - d[1] * e[0]; if (Math.abs(den) < 1e-9) continue;
    const t = (p[0] * e[1] - p[1] * e[0]) / den, u = (p[0] * d[1] - p[1] * d[0]) / den;
    if (t > 0 && u >= -1e-9 && u <= 1 + 1e-9) best = Math.min(best, t);
  }
  return best;
};
const angOfL = (p: V2) => Math.atan2(p[1], p[0]) * 180 / Math.PI;
const gateBoxes = [GATE, POST].map((g) => { const a = angOfL(g); const out = rl(1, a), tan: V2 = [-out[1], out[0]]; return { c: g, out, tan }; });
// k-town8 (Derek's walk 2026-11-02: "paving stops with a HARD edge at the wall's inner face"; the terrace edge ran 2.3 m
// past the line, out beyond the outer face): the intramural paving's outline is the curtain's INNER FACE (line - 1.2 m,
// mitred over the 15 deg chords), notched out through each gate passage to the gatehouse's outer face (3.5 m) so no
// road band shows inside the walls; `terrace --from-plan` paints it with a hard edge (design.paving.edge)
const GATE_HW = +(process.env.GATE_HW ?? 3);
const pavingEdgeL: V2[] = wallVerts.flatMap((v): V2[] => {
  if (v.kind !== "gate") return [rl(v.r - 1.2 / Math.cos((7.5 * Math.PI) / 180), v.a)];
  const g = rl(v.r, v.a), out = rl(1, v.a), tan: V2 = [-out[1], out[0]];
  return ([[-GATE_HW, -1.2], [-GATE_HW, 3.5], [GATE_HW, 3.5], [GATE_HW, -1.2]] as V2[]).map(([st, so]) => [g[0] + tan[0] * st + out[0] * so, g[1] + tan[1] * st + out[1] * so]);
});
/** inside the curtain with 0.5 m air (local point) */
const insideWall = (p: V2) => {
  if (len(p) > wallRAt(angOfL(p)) - 1.2 - 0.5) return false; // 0.5 m air + the kit layer's re-aimed legs (to ~0.2 m)
  for (const g of gateBoxes) { const d = sub(p, g.c); if (Math.abs(d[0] * g.tan[0] + d[1] * g.tan[1]) < 4.8 + 0.5 && Math.abs(d[0] * g.out[0] + d[1] * g.out[1]) < 3.5 + 0.5) return false; }
  return true;
};
// the curtain AS THE KIT LAYS IT (bearings re-aimed to 2 deg, legs closed by least squares): every lot's full envelope
// keeps 0.5 m off every piece's real footprint
const kitLay = layKitWall(wallPoly, { closed: true, towers: wallVerts.map((v, i) => (v.kind === "tower" ? i : -1)).filter((i) => i >= 0), gates: wallVerts.map((v, i) => (v.kind === "gate" ? i : -1)).filter((i) => i >= 0) });
const kitPolys: V2[][] = kitLay.pieces.flatMap((p) => worldFootprint(p) as V2[][]);
// see-through 10-30: 0.5-1 m slots (house vs curtain, back to back, hut to hut) framed sky under the eaves; an open
// alley instead (an intervallum lane behind the curtain, a yard between huts) reads as space, not a hole
// k-town7 (the bird's-eye painting: roofs shoulder to shoulder, houses backed onto the curtain): lot 3 -> 1.5, eaves 2 -> 0.6,
// wall 2.5 -> 0.4 (a house BACKED to the curtain leaves no sky slot; the 0.5-1 m slots that framed sky were free-standing gaps)
const AIR = { wall: +(process.env.AIR_WALL ?? 0.4), lot: +(process.env.AIR_LOT ?? 1.5), eaves: +(process.env.AIR_EAVES ?? 0.6), yard: +(process.env.AIR_YARD ?? 2.2) };
const clearOfWall = (pts: V2[]) => kitPolys.every((poly) => quadGap(pts, poly) >= AIR.wall);
const outsideWall = (p: V2) => {
  if (len(p) < wallRAt(angOfL(p)) + 1.2 + 0.5) return false;
  for (const g of gateBoxes) { const d = sub(p, g.c); if (Math.abs(d[0] * g.tan[0] + d[1] * g.tan[1]) < 4.8 + 0.5 && Math.abs(d[0] * g.out[0] + d[1] * g.out[1]) < 3.5 + 0.5) return false; }
  return true;
};

// ---------------------------------------------------------------- terraces (local)
// the town floor reaches 2.3 m past the curtain line (its 1.2 m half + room), and 6 m round the water gate (its outer
// half stands on the floor); its edge is a BANK all round: a retaining-wall run's stepped end lowers the floor ~6 m
// behind its face, which put curtain pieces over a drop (float 10-30), so the strand keeps clear of the town (SG)
const postBump = (a: number) => { const x = Math.abs(a - A_POST); return x <= PW ? 1 : x >= PW + 3 ? 0 : (PW + 3 - x) / 3; };
const RT0 = (a: number) => wallRAt(a) + 2.3; // (the strand and its lanes follow this, not the water gate's bump)
const RT = (a: number) => RT0(a) + 2.5 * postBump(a);
// the gap: the town's bank needs 2 m of run per metre of drop (1.7-2.2 m here) plus air; 4.5 m on the strand's broad
// north end (the boat shed's pocket, 50-58 deg, where the shore lies 90-96 m out), 6.5 m elsewhere
const SGa = (a: number) => (a > 42 && a < 73 ? 4.5 : 6.5);
const SG = 6.5;
// the arc's angles: a straight 14 deg chord over the water gate (the postern stair's insert needs a straight riser edge)
const arcAngles = (a0: number, a1: number, step = 4): number[] => { const o: number[] = []; const n = Math.max(1, Math.ceil(Math.abs(a1 - a0) / step)); for (let i = 0; i <= n; i++) { const a = a0 + (a1 - a0) * i / n; if (Math.abs(a - A_POST) < PW + 3 && i > 0 && i < n) continue; o.push(a); } for (const e of [A_POST - PW, A_POST + PW]) if ((e - a0) * (e - a1) < 0 && !o.includes(e)) o.push(e); return o.sort((x, y) => (a1 > a0 ? x - y : y - x)); };
const arcT = (a0: number, a1: number, step = 4): V2[] => arcAngles(a0, a1, step).map((a) => rl(RT(a), a));
// the close: a 2 m stepped-up rectangle under the chapel, wholly inside the curtain; the strip behind it (back walk) stays
// at town level so the curtain stands on one level all round
const CS = +(process.env.CLOSE_S0 ?? 20), CB = +(process.env.CLOSE_S1 ?? 57.6), CT = +(process.env.CLOSE_T ?? 14.2);
const STEP_S = +(process.env.STEPS_S ?? 24), STAIR_RUN = +(process.env.STAIR_RUN ?? 4.5), STAIR_W = +(process.env.STAIR_W ?? 6);
const close: V2[] = [[CS, -CT], [CS, CT], [CB, CT], [CB, -CT]];
const aCT = (t: number) => { // ring angle where |t| = CT on the RT curve (search)
  let lo = 0, hi = 60; for (let k = 0; k < 40; k++) { const m = (lo + hi) / 2; if (RT(m) * Math.sin(m * Math.PI / 180) < t) lo = m; else hi = m; } return (lo + hi) / 2;
};
const aC = aCT(CT);
// the road lobe at the gate: the town floor runs out to the gate-yard along t = +-LOBE
const LOBE = 13;
const aL = 180 - Math.asin(LOBE / RT(180)) * 180 / Math.PI;
const sL = -Math.sqrt(RT(180) ** 2 - LOBE ** 2) - 3.5; // 3.5 m past the ring: the gatehouse's outer face stands on the town floor
const town: V2[] = [[CB, CT], ...arcT(aC, aL).slice(1, -1), rl(RT(aL), aL), [sL, LOBE], [sL, -LOBE], rl(RT(aL), -aL), ...arcT(-aL, -aC).slice(1, -1), [CB, -CT], [CS, -CT], [CS, CT]];
const backWalk: V2[] = [[CB, -CT], ...arcT(-aC, aC, 3).map((p) => p), [CB, CT]];
const gateYard: V2[] = [[sL, LOBE + 19], [-118, LOBE + 19], [-118, -LOBE - 19], [sL, -LOBE - 19]];
// the strand: outside the east curtain between the town floor and the real shore (3 m off the waterline)
const shoreR = (a: number): number => { let r = RT(a) + 1; while (r < 120 && !wet(...W(...rl(r, a)))) r += 0.5; return r; };
const A0 = 30, A1 = 150;
const strandAngles = arcAngles(aC, aL).filter((a) => a >= A0 - 2 && a <= A1); // the town arc's own vertices: the riser edges meet end to end
// the strand's two ends stand 4.5 m off the town floor (a chamfered corner): its 1 : 2 bank cone (2 m over 4 m) then never
// reaches under the curtain at the strand's ends (a wall piece at 28 deg stood over a 1.4 m drop, float 10-30)
const outerAngles: number[] = []; for (let a = strandAngles[strandAngles.length - 1]!; a >= strandAngles[0]! - 1e-9; a -= 3) outerAngles.push(a); if (outerAngles[outerAngles.length - 1] !== strandAngles[0]) outerAngles.push(strandAngles[0]!);
const strandIn = strandAngles.map((a) => rl(RT(a) + SGa(a), a)), strandOut = outerAngles.map((ang) => rl(Math.max(RT0(ang) + SG + 5, shoreR(ang) - 1.5), ang)); // held in over the shore dip at 80 deg (a wall foot there hung 0.66 m)
const strand: V2[] = [...strandIn, ...strandOut];

// ---------------------------------------------------------------- streets (local)
const pom = (r: number, a0: number, a1: number, step = 10): V2[] => { const o: V2[] = []; const n = Math.max(1, Math.ceil(Math.abs(a1 - a0) / step)); for (let i = 0; i <= n; i++) o.push(rl(r, a0 + (a1 - a0) * i / n)); return o; };
// k-town5: the Y-fork ends 1 m in FRONT of the axial stair's foot, inside its clear width (town-design check: a street
// may not cross an axial stair's cheek; the old ends at the wall face beside the head wedged the walk)
const STAIR_FOOT = CS - STAIR_RUN - 1.5;
const tGS = (s: number) => 3.4 * (s - GATE[0]) / (-2 - GATE[0]); // Gate Street's centreline t at station s
const streetsL: { id: string; name: string; kind: string; width: number; pts: V2[]; note?: string }[] = [
  { id: "gate-street", name: "Gate Street", kind: "main", width: 6, pts: [[GATE[0], 0], [-2, 3.4]], note: "from the gatehouse to Bell Square, drifting right as painted; a continuous wall of row houses both sides" },
  { id: "fork-west", name: "Steps Way", kind: "lane", width: 4, pts: [[-2, 3.4], [7, -3.5], [STAIR_FOOT - 3, -4.5], [STAIR_FOOT, -1.2]], note: "the street's left branch round the dead tree to the chapel steps' FOOT, head-on (the painting's Y-fork)" },
  { id: "fork-east", name: "Tree Way", kind: "lane", width: 4, pts: [[-2, 3.4], [7, 10.5], [STAIR_FOOT - 3, 8.5], [STAIR_FOOT, 1.2]], note: "the right branch round the tree, rejoining at the chapel steps' foot" },
  { id: "square-west", name: "West Square Row", kind: "lane", width: 3, pts: [[-2, -16.5], [24, -16.5]], note: "along the square's west edge: the inn's front" },
  { id: "square-east", name: "East Square Row", kind: "lane", width: 3, pts: [[-1, 20], [24, 20]], note: "along the square's east edge: a row of houses" },
  { id: "tower-lane", name: "Tower Lane", kind: "lane", width: 3.5, pts: [[24, -16.5], [50, -16.5]], note: "out of the square's north-west corner along the close's west wall to the back walk" },
  { id: "bell-lane", name: "Bell Lane", kind: "lane", width: 3.5, pts: [[24, 20], [50, 20]], note: "out of the square's north-east corner along the close's east wall to the back walk" },
  { id: "smith-lane", name: "Smith's Lane", kind: "lane", width: 3.5, pts: [[-27, tGS(-27)], [-27, -34]], note: "across Gate Street's west rows behind the smithy toward the wall" },
  { id: "net-lane", name: "Net Lane", kind: "lane", width: 4, pts: [[-27, tGS(-27)], [POST[0] - 4.5 * Math.cos(A_POST * Math.PI / 180), POST[1] - 4.5 * Math.sin(A_POST * Math.PI / 180)]], note: "across Gate Street's east rows and out through the water gate to the strand" },
  { id: "west-lane", name: "Rope Walk", kind: "lane", width: 3.5, pts: [[-27, -22.6], [-3, -22.6]], note: "behind Gate Street's west rows, from Smith's Lane toward the inn's yard: a row faces it" },
  { id: "lake-lane", name: "Lake Lane", kind: "lane", width: 3.5, pts: [[-26, 28.3], [-6, 28.3]], note: "behind Gate Street's east rows, from Net Lane: a row faces it" },
  { id: "chapel-steps", name: "Chapel Steps", kind: "close", width: 3, pts: [[STEP_S, -9], [STEP_S, 9]], note: "the landing in front of the chapel and tower" },
  // outside the walls
  { id: "gate-road", name: "Gate Road", kind: "lane", width: 5, pts: [[GATE[0] - 3.5, 0], [-70, 0], [-112, 0]], note: "(k-town8: from the gatehouse's OUTER face, the passage is town paving) the road outside the gate: sheds, hovels and the cartwright's workshop stand along it" },
];
// k-town7 (the bird's-eye painting): a RING LANE inside the curtain, houses on both sides of it -- the outer row backed to
// the curtain (the painting's houses shoulder to shoulder round the wall), the inner row facing it -- from the close's
// lanes round to Gate Street on each side. RING_R = 0 turns it off.
const RING_R = +(process.env.RING_R ?? 0), RING_A0 = +(process.env.RING_A0 ?? 32);
// the ring replaces the old back lanes (Rope Walk, Lake Lane, Smith's Lane: 2 houses between them, and they cut the blocks the ring rows need)
if (RING_R > 0) for (const id of (process.env.RING_DROP ?? "west-lane,lake-lane,smith-lane").split(",")) { const i = streetsL.findIndex((s) => s.id === id); if (i >= 0) streetsL.splice(i, 1); }
// RING_EARLY: the whole arc is a street before anything is pinned (the pins and Gate Street's rows then fit round it)
const RING_EARLY = process.env.RING_EARLY === "1" && RING_R > 0;
if (RING_EARLY) for (const sg of [1, -1]) streetsL.push({ id: sg > 0 ? "ring-east-1" : "ring-west-1", name: sg > 0 ? "East Wall Lane" : "West Wall Lane", kind: "lane", width: 3.2, pts: pom(RING_R, sg * RING_A0, sg * 178, 8), note: "k-town7: the lane round the inside of the curtain, houses both sides (the bird's-eye painting)" });
const streets = streetsL.map((s) => ({ id: s.id, name: s.name, kind: s.kind, width: s.width, surface: "paving", points: P(s.pts), ...(s.note ? { note: s.note } : {}) }));
// strand lanes in world coordinates (from the water-gate stair foot along the shore)
const aP = A_POST, posternFoot = W(...rl(RT(aP) + SG + 2, aP)), posternTop = W(...rl(RT(aP) - 0.3, aP));
const strandPts: V2[] = [posternFoot, ...[127, 133].map((a) => W(...rl(RT(a) + SG + 2.6, a))), W(...rl(Math.max(shoreR(138) - 4, RT0(138) + SG + 4), 138))];
const netPts: V2[] = [posternFoot, ...[110, 98, 86, 78, 71.5].map((a) => W(...rl(RT(a) + SGa(a) + 2.6, a)))];
streets.push({ id: "net-walk", name: "Net Walk", kind: "lane", width: 3.5, surface: "paving", points: netPts, note: "from the water-gate stair foot north along the wall foot: the net yards and the boat shed" } as any);
// the boat slip: from Net Walk's end down to the water in the strand's deep pocket; the boat shed's open end faces it,
// its long axis along the shore (48-74 deg: the shore 84-96 m out)
const slipA = W(...rl(RT(71.5) + SGa(71.5) + 2.6, 71.5)), slipB = W(...rl(81, 71.5));
streets.push({ id: "boat-slip", name: "Boat Slip", kind: "lane", width: 3.5, surface: "paving", points: [slipA, slipB], note: "from Net Walk's end down to the water: the boat shed opens on it" } as any);
streets.push({ id: "strand-lane", name: "Strand Lane", kind: "lane", width: 3.5, surface: "paving", points: strandPts, note: "from the water gate down to the landing and along the shore: hovels and sheds" } as any);
const SQ1 = Math.min(23, CS - 0.5); const squareL: V2[] = [[-2, -14.5], [SQ1, -14.5], [SQ1, 18.5], [-2, 18.5]];
const squares = [{ id: "bell-square", name: "Bell Square", kind: "market", terrace: "town", polygon: P(squareL) }];
const connections = [
  // k-town4 (Derek 2026-11-02 "the stairs to the chapel are very strange"): broad straight steps on the gate axis, square
  // to the close wall (retaining-wall insert stair-axial), never the kit ramp along the face
  { id: "tower-stair", kind: (process.env.STAIR_KIND ?? "stair") as "stair", form: "axial", from: "town", to: "close", width: STAIR_W, street: "chapel-steps", points: P([[CS - STAIR_RUN, 0], [CS, 0]]) },
  { id: "back-walk-w", kind: "ramp", from: "town", to: "back-walk", width: 3, street: "tower-lane", points: P([[CB - 4.5, -(CT + 3.5)], [CB + 2, -(CT + 2.3)], [CB + 2, -(CT - 2)]]) },
  { id: "back-walk-e", kind: "ramp", from: "town", to: "back-walk", width: 3, street: "bell-lane", points: P([[CB - 4.5, CT + 3.5], [CB + 2, CT + 2.3], [CB + 2, CT - 2]]) },
  { id: "gate-passage", kind: "ramp", from: "gate-yard", to: "town", width: 6, street: "gate-street", points: P([[sL - 1, 0], [sL + 4, 0]]) },
  { id: "postern-stair", kind: "stair", from: "strand", to: "town", width: 3.5, street: "net-lane", points: [posternFoot, posternTop] },
];

// ---------------------------------------------------------------- kinds: kit request + prefab + measured envelope
type Kind = { prefab: string; req: any; zc: number; env: { size: [number, number]; full: any; ground: any; door: string }; party?: boolean; yard?: number };
const REQ: Record<string, any> = Object.fromEntries(["strand-town.json", "strand-town-small.json"].flatMap((f) => JSON.parse(fs.readFileSync("../../../MMO/WFC/wfc/requests/" + f, "utf8")).requests as any[]).map((r) => [r.name, r]));
const K: Record<string, Kind> = {};
for (const id of ["strand-barracks", "strand-row-house-a", "strand-row-house-b", "strand-row-house-c", "strand-row-house-d", "strand-row-filler", "strand-smithy", "strand-hovel", "strand-shed", "strand-boat-shed", "strand-workshop", "strand-inn", "strand-house-s", "strand-house-m", "strand-house-corner", "strand-chapel", "strand-cot-row", "strand-cot-wide", "strand-cot-corner", "strand-narrow-house", "strand-narrow-corner"]) {
  const m = measure[id]!; const rq = id === "strand-chapel" ? REQ["strand-chapel-nave"] : REQ[id];
  const [w, d] = rq.size as [number, number]; const Wm = w * 3.2, Dm = d * 3.2;
  const door = m.doors.find((x) => x.ext && Math.abs(x.yaw) < 1);
  // the front wall line: the yaw-0 exterior door marker, except the open-front sheds (centred request)
  const F = id === "strand-shed" || id === "strand-boat-shed" || !door ? Dm / 2 : door.p[2]!;
  const zc = F - Dm / 2;
  const ext = (xr: V2, zr: V2) => ({ left: r4(Math.max(0, -Wm / 2 - xr[0]) / 3.2), right: r4(Math.max(0, xr[1] - Wm / 2) / 3.2), front: r4(Math.max(0, zr[1] - F) / 3.2), back: r4(Math.max(0, (F - Dm) - zr[0]) / 3.2) });
  const yard = id === "strand-workshop" ? measure["strand-workshop-yard"]!.z[1] - measure["strand-workshop-yard"]!.z[0] : 0;
  const full = ext(m.x, m.z), ground = ext(m.ground.x, m.ground.z);
  if (yard) { full.back = r4(full.back + yard / 3.2); ground.back = r4(ground.back + yard / 3.2); }
  const req = { system: rq.system, size: rq.size, storeys: rq.storeys, roof: rq.roof, features: rq.features, ...(rq.party ? { party: rq.party } : {}), style: rq.style };
  K[id] = { prefab: `strand-town/${id}`, req, zc, env: { size: rq.size, full, ground, door: "-y" }, party: !!rq.party, yard };
}
// k-town9 (the painting's streets: tall and low houses shoulder to shoulder): the row pools, packed by plan type. Main
// street + square: the 2-storey row houses and narrow houses with a few cots between; lanes: the cots and narrow houses
const ROWS = (process.env.ROW_POOL ?? "strand-row-house-a,strand-narrow-house,strand-row-house-c,strand-cot-row,strand-row-house-b,strand-row-house-d,strand-row-filler,strand-narrow-corner,strand-cot-corner").split(",");
const LANE_ROWS = (process.env.LANE_POOL ?? "strand-cot-row,strand-narrow-house,strand-cot-wide,strand-row-house-b,strand-cot-corner,strand-narrow-corner").split(",");

// ---------------------------------------------------------------- placement
type B = { id: string; name: string; district: string; at: V2; facing: V2; street: string; kind: string; terrace: string; row?: string; note?: string };
const B: B[] = [];
const envelopes: Envelopes = {} as Envelopes;
const asDesign = (b: B) => ({ id: b.id, name: b.name, at: b.at, facing: b.facing, street: b.street, request: K[b.kind]!.req, prefab: K[b.kind]!.prefab, ...(b.row ? { row: b.row } : {}) });
const foot = (b: B) => { (envelopes as any)[b.id] = K[b.kind]!.env; return footprintOf({ buildings: [asDesign(b)] as any }, asDesign(b) as any, envelopes); };
const terr: Record<string, V2[]> = { town: P(town), close: P(close), strand: P(strand), "gate-yard": P(gateYard), "back-walk": P(backWalk) };
const WHY: Record<string, number> = {};
let LAST = ""; const no = (w: string): false => { WHY[w] = (WHY[w] ?? 0) + 1; LAST = w; return false; };
// k-town9: floor the packed rows must leave free for an open-air trade the installer places by rule (Derek 11-02: the
// forge patio right of the chapel; the densified Bell Lane row had taken it): local [s0, t0, s1, t1] boxes, metres.
// i-town2: the box's curtain-side edges sit ~2 m further in (inner edges kept: moving the whole box cost a house) (k-town9 lab: the patio's awning post seamed against the curtain)
const RESERVE: { id: string; box: [number, number, number, number] }[] = [{ id: "forge-patio", box: [38.5, 22.6, 46.8, 30.4] }];
function ok(b: B): boolean {
  const f = foot(b);
  for (const r of RESERVE) { const [s0, t0, s1, t1] = r.box; if (f.ground.some((p) => { const q = L(p as V2); return q[0] > s0 && q[0] < s1 && q[1] > t0 && q[1] < t1; }) || densify(f.ground as V2[], 0.75, true).some((p) => { const q = L(p); return q[0] > s0 && q[0] < s1 && q[1] > t0 && q[1] < t1; })) return no("reserve:" + r.id); }
  const poly = terr[b.terrace]!;
  const g = densify(f.ground, 0.75, true), full = densify(f.full, 0.75, true);
  { const bad = g.find((p) => !inPoly(poly, p[0], p[1]) || polyEdgeD(poly, p) < (b.terrace === "strand" ? 2.6 : 1.6)); if (bad) { no("terrace"); LAST = `terrace at ${len(L(bad)).toFixed(1)}@${angOfL(L(bad)).toFixed(1)} ${inPoly(poly, bad[0], bad[1]) ? "near edge" : "outside"}`; return false; } } // the strand's lake edge is ragged: more room
  if (!clearOfWall(f.full as V2[])) return no("wall-clear");
  if (b.terrace === "town" || b.terrace === "close") { if (full.some((p) => !insideWall(L(p)))) return no("wall-in"); }
  else { if (full.some((p) => !outsideWall(L(p)))) return no("wall-out"); if (g.some((p) => wet(p[0], p[1]))) return no("wet"); }
  for (const sq of squares) if (g.some((p) => inPoly(sq.polygon, p[0], p[1])) || sq.polygon.some((p) => inPoly(f.ground, p[0], p[1]))) return no("square");
  for (const st of streets) { if (st.points.length < 2) continue; const d = Math.min(...g.map((p) => lineD(st.points, p))) - st.width / 2; if (d < 0.6) return no("street:" + st.id); if (densify(st.points, 0.5, false).some((p) => inPoly(f.ground, p[0], p[1]))) return no("street-in:" + st.id); }
  for (const c of connections) { const d = Math.min(...g.map((p) => lineD(c.points as V2[], p))) - c.width / 2; if (d < 0.8) return no("conn:" + c.id); }
  const st = streets.find((s) => s.id === b.street)!; if (lineD(st.points, f.front) - st.width / 2 > 3.6) return no("door");
  for (const q of B) {
    const fq = foot(q);
    if (b.row && q.row === b.row) {
      const why = rowPairFault({ buildings: [asDesign(b), asDesign(q)] as any }, asDesign(b) as any, asDesign(q) as any, f, fq);
      if (why === null) continue; if (why !== "apart") return no("row:" + why.slice(0, 30));
    }
    if (quadGap(f.ground, fq.ground) < AIR.lot) return no("lot");
    // i-town2 (k-town9 lab see-through: a hovel|shed eaves slot in the gate yard framed sky): huts outside the walls are
    // free-standing, so between them the gap is an open yard (AIR.yard), never a 0.6-1 m slot
    const yardPair = !["town", "close"].includes(b.terrace) || !["town", "close"].includes(q.terrace);
    if (quadGap(f.full, fq.full) < (yardPair ? AIR.yard : AIR.eaves)) return no(yardPair ? "yard" : "eaves");
  }
  // the gate's sight line to the chapel: nothing over 2 storeys within 2.5 m of the gate axis
  return true;
}
let nid = 0;
const place = (b: Omit<B, "id"> & { id?: string }): boolean => { const id = b.id ?? `${b.kind.replace("strand-", "").replace("row-house-", "row").replace("row-filler", "fill")}-${++nid}`; const bb = { ...b, id } as B; if (!ok(bb)) { delete (envelopes as any)[id]; return false; } B.push(bb); return true; };

/** a straight party-wall row along street `sid` on `side`, from local station s0 to s1 (metres along the street), fronts
 *  0.65 m off the street edge. k-town9: the houses are PACKED BY PLAN TYPE (tools/town-row-pack.mts): the kit
 *  catalogue's `plan.rowPitchMetres` lots, laid -x to +x of the houses, every neighbour pair one the row-fit proof
 *  passed, a corner type on the row's +x end. A lot the town rules refuse is re-packed from there without that type. */
const RP = rowPackTypes("world-kit", "strand-town");
function row(sid: string, side: 1 | -1, s0: number, s1: number, kinds: string[], district: string, terrace = "town", tag = "") {
  const st = streets.find((s) => s.id === sid); if (!st) return 0; const pts = st.points;
  let acc = 0, leg = -1; for (let i = 0; i + 1 < pts.length; i++) { const l = len(sub(pts[i + 1]!, pts[i]!)); if (s0 >= acc - 1e-6 && s1 <= acc + l + 1e-6) { leg = i; break; } acc += l; }
  if (leg < 0) throw new Error(`${sid}: [${s0}, ${s1}] is not on one straight leg`);
  const a = pts[leg]!, b = pts[leg + 1]!, l = len(sub(b, a)); const tan: V2 = [(b[0] - a[0]) / l, (b[1] - a[1]) / l];
  const n: V2 = [-tan[1] * side, tan[0] * side]; const facing: V2 = [r4(-n[0]), r4(-n[1])];
  const rid = `${sid}-${side > 0 ? "a" : "b"}${tag}`;
  const at = (s: number, kind: string): V2 => { const k = K[kind]!; const Dm = k.req.size[1] * 3.2; const off = st.width / 2 + 0.65 + k.env.ground.front * 3.2 + Dm / 2; const p: V2 = [a[0] + tan[0] * (s - acc) + n[0] * off, a[1] + tan[1] * (s - acc) + n[1] * off]; return [r4(p[0]), r4(p[1])]; };
  // the houses' +x runs along -side * tan: for side +1 the row's -x (left) end is s1, for side -1 it is s0
  const lotAt = (u: number, w: number) => (side < 0 ? s0 + u + w / 2 : s1 - u - w / 2); // u = metres from the left end
  const pool = kinds.filter((k) => RP.types[k]);
  let u = 0, placed = 0, prev: string | null = null; const banned = new Set<string>();
  while (u < s1 - s0 - 1e-6) {
    const seq = packRow(s1 - s0 - u, RP.types, { pool: pool.filter((k) => !banned.has(k)), pairs: RP.pairs, leftOf: prev });
    if (!seq.length) { if (prev) break; u += 0.5; banned.clear(); continue; }
    const kind = seq[0]!, w = RP.types[kind]!.lot;
    if (place({ name: kind === "strand-row-filler" ? "Narrow house" : isCorner(RP.types[kind]!) ? "Corner house" : kind.startsWith("strand-cot") ? "Cottage" : "Row house", district, at: at(lotAt(u, w), kind), facing, street: sid, kind, terrace, row: rid })) {
      u += w; placed++; prev = kind; banned.clear(); if (isCorner(RP.types[kind]!)) break;
    } else { if (process.env.DBG) console.log(`  row ${rid} @${u.toFixed(1)} ${kind}: ${LAST}`); banned.add(kind); }
  }
  if (process.env.DBG) console.log(`row ${rid}: ${placed} placed`);
  return placed;
}

// ---- pins: the chapel (tower on the gate axis), the inn on the square, the smithy on Gate Street by the gate court
const sAt = (sid: string, local: V2) => { const st = streets.find((s) => s.id === sid)!; const w = W(...local); let best = 0, acc = 0, bd = Infinity; for (let i = 0; i + 1 < st.points.length; i++) { const a = st.points[i]!, b = st.points[i + 1]!, l = len(sub(b, a)); const t = Math.max(0, Math.min(1, ((w[0] - a[0]) * (b[0] - a[0]) + (w[1] - a[1]) * (b[1] - a[1])) / (l * l))); const d = Math.hypot(w[0] - a[0] - (b[0] - a[0]) * t, w[1] - a[1] - (b[1] - a[1]) * t); if (d < bd) { bd = d; best = acc + t * l; } acc += l; } return best; };
const pinFront = (kind: string, sid: string, local: V2, faceL: V2, name: string, district: string, terrace: string, id?: string, note?: string) => {
  // local = the street-edge point the door faces; the building stands behind it
  const k = K[kind]!, Dm = k.req.size[1] * 3.2, st = streets.find((s) => s.id === sid)!;
  // facing: the street's normal on the side of faceL (a door faces its street square-on)
  const sp = st.points.map(L); let bi = 0, bd = Infinity; for (let i = 0; i + 1 < sp.length; i++) { const d = segD(local, sp[i]!, sp[i + 1]!); if (d < bd) { bd = d; bi = i; } }
  const tg = sub(sp[bi + 1]!, sp[bi]!), tl = len(tg); let f: V2 = [-tg[1] / tl, tg[0] / tl]; if (f[0] * faceL[0] + f[1] * faceL[1] < 0) f = [-f[0], -f[1]];
  const off = st.width / 2 + 0.65 + k.env.ground.front * 3.2 + Dm / 2;
  const c: V2 = [local[0] - f[0] * off, local[1] - f[1] * off];
  const ok1 = place({ id, name, district, at: W(...c), facing: dirW(f[0], f[1]), street: sid, kind, terrace, note });
  if (!ok1) { console.log(`PIN FAILED ${id ?? kind} on ${sid}: ${LAST}`); if (process.env.DBGPIN === kind) { const b0 = { id: "dbg", name, district, at: W(...c), facing: dirW(f[0], f[1]), street: sid, kind, terrace } as B; console.log("  ground " + foot(b0).ground.map((p) => { const q2 = L(p); return len(q2).toFixed(1) + "@" + angOfL(q2).toFixed(1); }).join(" ")); } }
  return ok1;
};
pinFront("strand-chapel", "chapel-steps", [STEP_S, 0], [-1, 0], "Bell Chapel and tower", "chapel-close", "close", "chapel", "strand-town/strand-chapel (nave + bell tower 19.4 m) on the gate axis above the stepped close, inside the curtain");
pinFront("strand-inn", "square-west", [11, -16.5], [0, 1], "The Bell and Net (inn)", "square", "town", "inn", "common room and great hearth on the square's west side");
// k-town5 (Derek 2026-11-02 "a few more stone buildings, maybe a barracks"; the square painting): the watch barracks,
// red rubble with a crenellated wall-walk, on the square's east side by the close (before the east row fills it)
pinFront("strand-barracks", "square-east", [10, 20], [0, -1], "The Watch barracks", "square", "town", "barracks", "strand-town/strand-barracks: red rubble, flat roof, crenellated wall-walk, arched door on the square");
SMITHY: for (const fy of [1, -1]) for (const s0 of Array.from({ length: 49 }, (_, i) => -40.4 + i * 0.25)) // k-town3: 0.25 m steps (the one-roof smithy is 0.3 m wider)
   if (pinFront("strand-smithy", "gate-street", [s0, tGS(s0)], [0, fy], "Strand smithy", "gate-street", "town", "smithy", "the forge bay open to Gate Street by the gate court (anvil, bellows, kiln, quench tub)")) break SMITHY;
// with the 2.5 m air off the curtain the gate court is too tight for the 17.6 x 21.4 m smithy: the first street front
// that takes it (inner streets first), before the rows fill them
if (!B.some((b) => b.id === "smithy")) SM2: for (const sid of ["square-east", "square-west", "lake-lane", "tower-lane", "bell-lane", "net-lane", "gate-street", "west-lane", "ring-west", "ring-east"]) {
  const st = streets.find((x) => x.id === sid); if (!st) continue; const sp = st.points.map(L);
  for (let i = 0; i + 1 < sp.length; i++) { const l = len(sub(sp[i + 1]!, sp[i]!)); for (let d = 9; d <= l - 9; d += 1) { const q: V2 = [sp[i]![0] + (sp[i + 1]![0] - sp[i]![0]) * d / l, sp[i]![1] + (sp[i + 1]![1] - sp[i]![1]) * d / l]; const tg = sub(sp[i + 1]!, sp[i]!); for (const sd of [1, -1]) { const n: V2 = [-tg[1] / l * sd, tg[0] / l * sd]; const edge: V2 = [q[0] + n[0] * (st.width / 2), q[1] + n[1] * (st.width / 2)]; if (pinFront("strand-smithy", sid, edge, [-n[0], -n[1]], "Strand smithy", sid, "town", "smithy", "the forge bay open to its street (anvil, bellows, kiln, quench tub)")) { console.log("smithy on " + sid); break SM2; } } } }
}

// ---- Gate Street: party-wall rows both sides between the gate court and the square, broken by Smith's / Net Lane
const gs = (s: number) => sAt("gate-street", [s, 0]);
row("gate-street", -1, gs(-24.6), gs(-3), ROWS, "gate-street", "town", "1");   // west, square end (the smithy has the gate end)
row("gate-street", 1, gs(-23.2), gs(-3), ROWS.slice().reverse(), "gate-street", "town", "1");
row("gate-street", 1, gs(-49), gs(-29.3), ROWS.slice(1).concat(ROWS.slice(0, 1)), "gate-street", "town", "2");
// k-town9: the gate end of the west side too (no smithy pin holds it now: the forge is the open patio by the chapel)
row("gate-street", -1, gs(-49), gs(-29.3), ROWS.slice(2).concat(ROWS.slice(0, 2)), "gate-street", "town", "2");
// ---- the square's east edge: a row facing the square
row("square-east", 1, sAt("square-east", [-3, 20]), sAt("square-east", [24, 20]), ["strand-row-house-d", "strand-narrow-house", "strand-row-house-b", "strand-row-house-c", "strand-narrow-corner"], "square", "town", "1");
// k-town8 (Derek's walk 11-02: "a small house in the gap between the first two houses on the right inside the gate"):
// a Gate Street front gap the rows (and the smithy pin) left that a small house fits gets one, both sides, before
// the lanes and courts fill (fillLoose walks the whole front and takes only gaps that pass every lot / air rule)
if (process.env.GAP_FILL !== "0") for (const side of [1, -1] as const) fillLoose("gate-street", side, ["strand-cot-wide", "strand-cot-row", "strand-house-s"], "gate-street", "town", "Cottage");

pinFront("strand-workshop", "gate-road", [-92, 0], [0, -1], "Cartwright's workshop and yard", "extramural", "gate-yard", "workshop", "strand-town/strand-workshop with strand-workshop-yard on its back face: the cartwright outside the gate");
// the block between Gate Street's east gate-end rows and the lake curtain: cottages facing Net Lane
for (const t of [26, 30, 34, 38]) for (const kind of ["strand-house-corner", "strand-house-s"]) if (pinFront(kind, "net-lane", [-27 + 1.75 * (t - 1.8) / 41.9, t], [1, 0], "Cottage", "lanes", "town")) break;
// ---- loose houses on the lanes (corner / s / m), the workshop: greedy along each lane side
function fillLoose(sid: string, side: 1 | -1, kinds: string[], district: string, terrace = "town", name = "House") {
  const st = streets.find((s) => s.id === sid); if (!st) return; const pts = st.points; let total = 0; const segs: { a: V2; b: V2; l: number }[] = [];
  for (let i = 0; i + 1 < pts.length; i++) { const l = len(sub(pts[i + 1]!, pts[i]!)); segs.push({ a: pts[i]!, b: pts[i + 1]!, l }); total += l; }
  const pointAt = (d: number) => { let acc = 0; for (const g of segs) { if (d <= acc + g.l) { const t = (d - acc) / g.l; return { p: [g.a[0] + (g.b[0] - g.a[0]) * t, g.a[1] + (g.b[1] - g.a[1]) * t] as V2, tan: [(g.b[0] - g.a[0]) / g.l, (g.b[1] - g.a[1]) / g.l] as V2 }; } acc += g.l; } return null; };
  let s = 0, k = 0;
  while (s < total) {
    // the preference list, rotated by how many have been placed (variety): the first kind that fits here wins
    let placed = false;
    for (let j = 0; j < kinds.length && !placed; j++) {
      const kind = kinds[(k + j) % kinds.length]!; const kk = K[kind]!; const Wm = kk.req.size[0] * 3.2, Dm = kk.req.size[1] * 3.2;
      const lead = kk.env.ground.left * 3.2; // the envelope's left overhang starts at s
      const q = pointAt(s + lead + Wm / 2); if (!q) continue;
      const n: V2 = [-q.tan[1] * side, q.tan[0] * side];
      for (const set of [0.65, 1.2, 2.0, 2.8]) {
        const off = st.width / 2 + set + kk.env.ground.front * 3.2 + Dm / 2;
        if (place({ name, district, at: [r4(q.p[0] + n[0] * off), r4(q.p[1] + n[1] * off)], facing: [r4(-n[0]), r4(-n[1])], street: sid, kind, terrace })) { placed = true; s += Wm + (kk.env.ground.left + kk.env.ground.right) * 3.2 + 1.15; k++; break; }
      }
    }
    if (!placed) { if (process.env.DBGL === sid) console.log(`  loose ${sid} ${side} @${s.toFixed(0)}: ${LAST}`); s += 1; }
  }
}
// rows behind Gate Street's rows, on the parallel lanes, and on the square's lanes and the close lanes
for (const [sid, kinds] of [["west-lane", LANE_ROWS], ["lake-lane", LANE_ROWS.slice(1).concat(LANE_ROWS.slice(0, 1))], ["tower-lane", LANE_ROWS], ["bell-lane", LANE_ROWS.slice(2).concat(LANE_ROWS.slice(0, 2))]] as [string, string[]][]) {
  const st = streets.find((x) => x.id === sid); if (!st) continue; const l0 = len(sub(st.points[1]!, st.points[0]!)) - 0.01;
  for (const side of [1, -1] as const) row(sid, side, 0.8, l0, kinds, "lanes", "town", "1");
}
// the ring is laid AFTER the pinned buildings and Gate Street's rows: the arc at RING_R, cut into runs clear of every lot
// (and the square, the close), a run kept only when it is >= 14 m and one end meets another street (reached from the gate)
const ringIds: string[] = RING_EARLY ? ["ring-east-1", "ring-west-1"] : [];
if (RING_R > 0 && !RING_EARLY) for (const sg of [1, -1]) {
  const RW = 3.2, G = B.map((q) => foot(q).ground as V2[]);
  const clearAt = (a: number) => { const l = rl(RING_R, a), p = W(...l); if (!insideWall(l) || inPoly(terr.close!, p[0], p[1])) return false;
    if (squares.some((q) => inPoly(q.polygon, p[0], p[1]))) return false; return G.every((g) => !inPoly(g, p[0], p[1]) && polyEdgeD(g, p) >= RW / 2 + 0.7); };
  const runs: number[][] = []; let cur: number[] = [];
  for (let a = RING_A0; a <= 179; a += 1) { if (clearAt(sg * a)) cur.push(sg * a); else { if (cur.length) runs.push(cur); cur = []; } } if (cur.length) runs.push(cur);
  let n = 0;
  for (const r of runs) {
    const lenM = Math.abs(r[r.length - 1]! - r[0]!) * Math.PI / 180 * RING_R; if (lenM < 14) continue;
    const ends = [r[0]!, r[r.length - 1]!].map((a) => W(...rl(RING_R, a)));
    if (!ends.some((e) => streets.some((o) => lineD(o.points, e) < o.width / 2 + 2.5) || squares.some((q) => polyEdgeD(q.polygon, e) < 2.5))) continue;
    const vs = r.filter((a, i) => i === 0 || i === r.length - 1 || Math.abs(a - r[0]!) % 8 === 0);
    const id = `${sg > 0 ? "ring-east" : "ring-west"}-${++n}`; ringIds.push(id);
    streets.push({ id, name: `${sg > 0 ? "East" : "West"} Wall Lane ${n}`, kind: "lane", width: RW, surface: "paving", points: vs.map((a) => W(...rl(RING_R, a))), note: "k-town7: the lane round the inside of the curtain, houses both sides (the bird's-eye painting)" } as any);
  }
}
for (const sid of ringIds) for (const side of [1, -1] as const) fillLoose(sid, side, ["strand-cot-wide", "strand-cot-row", "strand-house-s", "strand-cot-corner"], "lanes", "town", "House by the wall");
console.log(`ring: ${ringIds.length} run(s) [${ringIds.map((id) => `${id} ${streets.find((s) => s.id === id)!.points.length}`).join(", ")}]`);
fillLoose("smith-lane", -1, ["strand-house-corner", "strand-house-s"], "lanes");
fillLoose("smith-lane", 1, ["strand-house-s", "strand-house-corner"], "lanes");
fillLoose("net-lane", 1, ["strand-workshop", "strand-house-corner", "strand-house-s"], "lanes");
fillLoose("net-lane", -1, ["strand-house-m", "strand-house-s"], "lanes");
fillLoose("tower-lane", -1, ["strand-house-corner", "strand-house-m", "strand-house-s"], "lanes");
fillLoose("bell-lane", 1, ["strand-house-m", "strand-house-corner", "strand-house-s"], "lanes");
for (const sid of ["lake-lane", "west-lane", "smith-lane", "net-lane", "tower-lane", "bell-lane", "square-west", "square-east", "gate-street"]) for (const side of [1, -1] as const) fillLoose(sid, side, ["strand-cot-wide", "strand-house-s", "strand-cot-row", "strand-house-corner", "strand-house-m"], "lanes");
// ---- k-town7 (Derek 2026-11-02 "it needs to feel like that concept art"): the painting packs ~30 buildings inside the
// ring, roofs nearly touching, reached by short courts and alleys; the street-front passes leave the blocks' insides
// empty (13 inside). Court fill: every free spot of the town floor big enough for a house gets one, facing one of the
// town's four axes, its door on a short COURT (a cul-de-sac lane, width COURT_W) run from the door to the nearest town
// street or square edge, clear of every other lot. Placed nearest the square first (the painting's dense core), then out.
const COURT_W = +(process.env.COURT_W ?? 2.6), COURT_MAX = +(process.env.COURT_MAX ?? 40);
function courtFill(kinds: string[], district: string) {
  const townStreets = () => streets.filter((s) => s.id !== "gate-road" && !["net-walk", "boat-slip", "strand-lane"].includes(s.id));
  const sqEdges = squares.map((q) => [...q.polygon, q.polygon[0]!] as V2[]);
  const nearestOn = (p: V2): V2 | null => { let best: V2 | null = null, bd = Infinity;
    const consider = (pts: V2[], inset: number) => { for (let i = 0; i + 1 < pts.length; i++) { const a = pts[i]!, b = pts[i + 1]!, ab = sub(b, a), l2 = ab[0] ** 2 + ab[1] ** 2 || 1; const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * ab[0] + (p[1] - a[1]) * ab[1]) / l2)); const q: V2 = [a[0] + ab[0] * t, a[1] + ab[1] * t]; const d = len(sub(p, q)) - inset; if (d < bd) { bd = d; best = q; } } };
    for (const s of townStreets()) consider(s.points, s.width / 2); for (const e of sqEdges) consider(e, 0);
    return bd <= COURT_MAX ? best : null; };
  const grounds = () => B.map((q) => foot(q).ground as V2[]);
  let LANEWHY = "";
  const laneClear = (pts: V2[], skipNear: V2) => { const G = grounds(); for (const p of densify(pts, 0.5, false)) {
      if (len(sub(p, skipNear)) < 0.01) continue; const l = L(p); if (!insideWall(l) || !inPoly(terr.town!, p[0], p[1]) || inPoly(terr.close!, p[0], p[1])) { LANEWHY = "terrain " + l.map((v) => v.toFixed(1)); return false; }
      for (const [gi, g] of G.entries()) if (inPoly(g, p[0], p[1]) || polyEdgeD(g, p) < COURT_W / 2 + 0.6) { LANEWHY = "lot " + B[gi]!.id + " at " + l.map((v) => v.toFixed(1)); return false; } }
    for (const c of connections) if (densify(pts, 0.5, false).some((p) => lineD(c.points as V2[], p) < c.width / 2 + 0.8)) { LANEWHY = "conn " + c.id; return false; }
    return true; };
  const cands: V2[] = []; for (let s = -54; s <= 54; s += 1.6) for (let t = -54; t <= 54; t += 1.6) if (Math.hypot(s, t) < 52) cands.push([s, t]);
  const sqMid: V2 = [10, 2]; cands.sort((a, b) => len(sub(a, sqMid)) - len(sub(b, sqMid)));
  const faces: V2[] = [[1, 0], [-1, 0], [0, 1], [0, -1]];
  let nc = 0, k = 0; const CW: Record<string, number> = { bld: 0, st: 0, tried: 0, lane: 0 };
  const G0 = () => grounds();
  for (const c of cands) {
    const cw = W(...c); if (!inPoly(terr.town!, cw[0], cw[1]) || inPoly(terr.close!, cw[0], cw[1])) continue;
    if (G0().some((g) => inPoly(g, cw[0], cw[1]) || polyEdgeD(g, cw) < 4)) { CW.bld++; continue; }
    if (streets.some((s) => lineD(s.points, cw) < s.width / 2 + 4) || squares.some((q) => inPoly(q.polygon, cw[0], cw[1]))) { CW.st++; continue; }
    CW.tried++;
    let done = false;
    for (let j = 0; j < kinds.length && !done; j++) {
      const kind = kinds[(k + j) % kinds.length]!, kk = K[kind]!, Dm = kk.req.size[1] * 3.2;
      // the face toward the nearest street first (a door on the street side reads right)
      const fs4 = faces.map((f) => { const fw = dirW(f[0], f[1]); const front: V2 = [cw[0] + fw[0] * (Dm / 2 + kk.env.ground.front * 3.2), cw[1] + fw[1] * (Dm / 2 + kk.env.ground.front * 3.2)]; const q = nearestOn(front); return { f, fw, front, q, d: q ? len(sub(q, front)) : Infinity }; }).filter((x) => x.q).sort((a, b) => a.d - b.d);
      for (const o of fs4) {
        const p0: V2 = [r2(o.front[0] + o.fw[0] * (0.65 + COURT_W / 2)), r2(o.front[1] + o.fw[1] * (0.65 + COURT_W / 2))];
        // the court runs straight out of the door, then square-on to a street or square edge it meets (an L, never a
        // diagonal slot); or first along the house front, then out. Targets: points every 2 m on every town street /
        // square edge within COURT_MAX, nearest first; the first L that keeps clear of every lot wins.
        const tg: V2[] = [];
        for (const st of townStreets()) for (const q of densify(st.points, 2, false)) tg.push(q);
        for (const e of sqEdges) for (const q of densify(e, 2, false)) tg.push(q);
        const near = tg.map((q) => ({ q, d: len(sub(q, p0)) })).filter((x) => x.d <= COURT_MAX).sort((x, y) => x.d - y.d).filter((_, i) => i < 6 || i % 3 === 0).slice(0, 60);
        const tn: V2 = [-o.fw[1], o.fw[0]];
        let pts: V2[] | null = null;
        for (const { q } of near) {
          const along = (q[0] - p0[0]) * o.fw[0] + (q[1] - p0[1]) * o.fw[1], side = (q[0] - p0[0]) * tn[0] + (q[1] - p0[1]) * tn[1];
          if (along < -0.3) continue; // never back past the door
          const e1: V2 = [r2(p0[0] + o.fw[0] * along), r2(p0[1] + o.fw[1] * along)], e2: V2 = [r2(p0[0] + tn[0] * side), r2(p0[1] + tn[1] * side)];
          for (const el of [e1, e2]) { const cand: V2[] = len(sub(el, p0)) > 0.3 && len(sub(q, el)) > 0.3 ? [p0, el, [r2(q[0]), r2(q[1])]] : [p0, [r2(q[0]), r2(q[1])]];
            if (laneClear(cand, p0)) { pts = cand; break; } }
          if (pts) break;
        }
        const dbg = process.env.DBGPT && (process.env.DBGPT === "any" ? CW.tried % 25 === 1 : process.env.DBGPT === c.map((v) => v.toFixed(1)).join(","));
        if (!pts) { CW.lane++; if (dbg) console.log("DBGPT", kind, o.f, "no lane; last", LANEWHY, near.length); continue; }
        const id = `court-${++nc}`;
        streets.push({ id, name: `Court ${nc}`, kind: "close", width: COURT_W, surface: "paving", points: pts, note: "k-town7 court fill: a short court from a house door to the street" } as any);
        if (place({ name: kind === "strand-house-s" ? "Cottage" : "House", district, at: [r4(cw[0]), r4(cw[1])], facing: o.fw, street: id, kind, terrace: "town" })) { done = true; k++; break; }
        streets.pop(); nc--; CW[LAST] = (CW[LAST] ?? 0) + 1; if (dbg) console.log("DBGPT", kind, o.f, "place:", LAST, JSON.stringify(pts.map(L).map((q) => q.map((v) => +v.toFixed(1)))));
      }
    }
  }
  console.log(`court fill: ${k} house(s) on ${nc} court(s) ${JSON.stringify(CW)}`);
}
if (process.env.COURTS !== "0") courtFill((process.env.COURT_KINDS ?? "strand-cot-wide,strand-cot-row,strand-house-s,strand-cot-corner,strand-house-corner,strand-house-m").split(","), "lanes");
// ---- outside the walls: the poor dwellings and sheds (Derek 10-30) along Gate Road and on the strand; the boat shed on the strand
fillLoose("gate-road", 1, ["strand-hovel", "strand-shed", "strand-hovel"], "extramural", "gate-yard", "Hovel outside the gate");
fillLoose("gate-road", -1, ["strand-shed", "strand-hovel", "strand-hovel"], "extramural", "gate-yard", "Hovel outside the gate");
// the boat shed: on the strand's broad north end, its open front on Net Walk, its back to the water
// the boat shed in the strand's deep pocket (50-58 deg: the shore 90-96 m out), its open front on Net Walk, its back to the water
for (const r of [71.5, 71, 72, 70.5, 72.5]) { const q = rl(r, 71.5); if (pinFront("strand-boat-shed", "boat-slip", q, rl(1, 71.5 + 90), "Boat shed", "strand", "strand", "boat-shed", "strand-town/strand-boat-shed (open front 4 cells) on the boat slip: boats hauled up off the water")) break; }
fillLoose("net-walk", 1, ["strand-boat-shed", "strand-shed", "strand-hovel"], "strand", "strand", "Boat shed / net shed");
fillLoose("net-walk", -1, ["strand-boat-shed", "strand-shed", "strand-hovel"], "strand", "strand", "Boat shed / net shed");
for (const side of [1, -1] as const) fillLoose("boat-slip", side, ["strand-hovel", "strand-shed"], "strand", "strand", "Fisher's hovel");
fillLoose("strand-lane", 1, ["strand-hovel", "strand-shed"], "strand", "strand", "Fisher's hovel");
fillLoose("strand-lane", -1, ["strand-hovel", "strand-shed"], "strand", "strand", "Fisher's hovel");
for (const k2 of ["strand-hovel", "strand-shed"]) for (const sid of ["gate-road", "net-walk", "strand-lane"]) for (const side of [1, -1] as const) fillLoose(sid, side, [k2], "extramural", sid === "gate-road" ? "gate-yard" : "strand", "Shed / hovel");

// ---------------------------------------------------------------- write
const names: Record<string, string> = { "strand-hovel": "Hovel", "strand-shed": "Shed", "strand-boat-shed": "Boat shed", "strand-workshop": "Cartwright's workshop and yard", "strand-house-s": "Cottage", "strand-house-m": "House", "strand-house-corner": "Corner house" };
const terraces = [
  { id: "town", name: "Town floor", level: LV.town, polygon: P(town), buildings: B.filter((b) => b.terrace === "town").map((b) => b.id), note: "inside the curtain (the painted ring, r 55.5, bowed 2.5 m behind the close) plus the road lobe through the gatehouse" },
  { id: "close", name: "Chapel close", level: LV.close, polygon: P(close), ...(LV.close - LV.town > 2.5 ? { edges: [0, 1, 2, 3].map((edge) => ({ edge, treatment: "wall" as const })) } : {}), buildings: B.filter((b) => b.terrace === "close").map((b) => b.id), note: "the stepped-up close under the bell tower, wholly inside the curtain" },
  { id: "back-walk", name: "Back walk", level: LV.town, polygon: P(backWalk), buildings: [], note: "the town-level walk between the close's back wall and the curtain (the curtain stands on one level all round)" },
  { id: "gate-yard", name: "Gate yard", level: LV.town, polygon: P(gateYard), extramural: true, buildings: B.filter((b) => b.terrace === "gate-yard").map((b) => b.id), note: "outside the gate along Gate Road: hovels, sheds, the cartwright" },
  { id: "strand", name: "The strand", level: LV.strand, polygon: P(strand), extramural: true, buildings: B.filter((b) => b.terrace === "strand").map((b) => b.id), note: "outside the east wall between the town's riser and the real shore (3 m off the waterline): boat shed, net sheds, fishers' hovels" },
];
const design = {
  version: 1, town: "town-1", world: "redstrand", name: "town-1", title: "Town-1 (Bell Strand)", status: "approved",
  approval: { by: "derek", at: "2026-10-30", note: "Derek approved the bird's-eye (towns/concept/town-1-top.png) as the plan to trace; walked the first grey box 10-30 and asked for the overhaul (o-town2): real enterable houses at the kit's row pitch, continuous kit curtain, chapel inside the wall, trades, poor dwellings outside" },
  idea: "A small walled lime-and-rubble town on a low point by the lake, traced from the approved bird's-eye painting: Gate Street of tall party-wall row houses from the squat red gatehouse to Bell Square round a dead tree (the street forks round it), the smithy's forge bay open to the street by the gate, the inn on the square, the red bell tower on the gate axis above a stepped close inside the curtain, and outside the walls the poor: hovels and sheds along Gate Road and a fisher strand with a boat shed under the water gate.",
  gate: { at: W(...GATE), facing: dirW(-1, 0) },
  // k-town5 (Derek 2026-11-02 "you'd see stone"): the red flagstone read as the red clay from above; inside the walls a
  // PALE buff limestone flag (red-region, painted, 40 tx/m) contrasts in value with the zone ground
  // k-town8 (Derek's walk 11-02: "too bright: warm, darker stone, not grey, not dirt"): a warm darker PAINTED flag (Codex,
  // 128 px / 3.2 m) replaces the pale one; `edge` = the curtain's inner face (hard paving edge, above)
  paving: { surface: process.env.PAVE_SURFACE ?? "redstrand-warm-flagstone", map: process.env.PAVE_MAP ?? "built/warm-flagstone.png", color: "#ffffff", uvScale: 3.2, edge: P(pavingEdgeL) },
  districts: [
    { id: "gate-street", name: "Gate Street", role: "row houses and the smithy" }, { id: "square", name: "Bell Square", role: "market and the inn" },
    { id: "chapel-close", name: "Chapel close", role: "chapel close" }, { id: "lanes", name: "The lanes", role: "houses and the cartwright" },
    { id: "extramural", name: "Outside the gate", role: "hovels and sheds along the road" }, { id: "strand", name: "The strand", role: "fishers outside the walls, boat shed" },
  ],
  terraces, streets, squares: [...squares, { id: "gate-court", name: "Gate court", kind: "gate", terrace: "town", polygon: P([[GATE[0] + 4, -3.2], [GATE[0] + 8, -3.2], [GATE[0] + 8, 3.2], [GATE[0] + 4, 3.2]]) }], connections,
  landmark: { building: "chapel", height: 19.4 },
  buildings: B.map((b) => ({ id: b.id, name: names[b.kind] && b.name.startsWith("House") ? names[b.kind] : b.name, district: b.district, at: b.at, facing: b.facing, street: b.street, prefab: K[b.kind]!.prefab, request: K[b.kind]!.req, ...(b.row ? { row: b.row } : {}), ...(b.note ? { note: b.note } : {}) })),
  note: "o-town2 re-trace (2026-10-30) of towns/concept/town-1-top.png with k-town2's kit: every building is a shipped, enterable strand-town WFC model (prefab); party-wall rows stand at the kit's row pitch with their fronts on one line (row-fit proven pairs); the curtain is laid from the kit's wall pieces (town-1-wall-line.json -> town-wall-line kit).",
};
fs.writeFileSync(OUT, JSON.stringify(design, null, 1) + "\n");
const envOut: Record<string, unknown> = {}; for (const b of B) envOut[b.id] = K[b.kind]!.env;
fs.writeFileSync(ENVF, JSON.stringify(envOut, null, 1) + "\n");
// the curtain line (world) + its towers and gates, and each prefab's model-origin offset (origin = at - facing * zc)
fs.writeFileSync(WALLF, JSON.stringify({ line: wallPoly, towers: wallVerts.map((v, i) => (v.kind === "tower" ? i : -1)).filter((i) => i >= 0), gates: wallVerts.map((v, i) => (v.kind === "gate" ? i : -1)).filter((i) => i >= 0), zc: Object.fromEntries(Object.entries(K).map(([k, v]) => [v.prefab, r4(v.zc)])), yard: { prefab: "strand-town/strand-workshop-yard", depth: K["strand-workshop"]!.yard } }, null, 1) + "\n");
const count = (pred: (b: B) => boolean) => B.filter(pred).length;
console.log(JSON.stringify(WHY));
const kinds: Record<string, number> = {}; for (const b of B) kinds[b.kind] = (kinds[b.kind] ?? 0) + 1;
console.log(`buildings ${B.length}: inside ${count((b) => b.terrace === "town" || b.terrace === "close")}, gate yard ${count((b) => b.terrace === "gate-yard")}, strand ${count((b) => b.terrace === "strand")}`);
console.log(JSON.stringify(kinds));

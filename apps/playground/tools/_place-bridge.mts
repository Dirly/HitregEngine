/**
 * place-build `bridge`: a built stone BRIDGE across a gorge — a structure kind of the place builder (docs/place-builder.md
 * "Bridges"). Data in: the deck line (two ends + one level deck height), the pier centres, the arch springing, the end
 * kinds (a GATE TOWER with its passage, a plain abutment BLOCK, or the bare rim) and a material per role. The tool
 * measures the ground and writes ONE `landmark` operator (`kind: built`: real meshes, UVs in metres at the role tile =
 * texture px / 40, one draw per material, its own trimesh collider) plus the BASES the `seated` gate measures.
 *
 * KISS classic-MMO masses (owner ruling 2026-10-19): piers are stacked tiers with plain set-backs (bevelled boxes), the
 * spandrel is one swept band over round arches (all spans share one crown height, so the deck reads as one level band),
 * the arch rings stand proud in their own pale role, parapets with a coping course, a half-round refuge where each pier
 * rises through the deck, a square gate tower with string courses and a pyramid roof. Curved pieces (arch rings, the
 * spandrel bays, refuges, cutwaters, the roof) are closed prisms with their UVs LAID FLAT per face (caps in their own
 * plane, sides along their running length): no face is projected off-axis, so no texel is stretched (the art gate's
 * 1.3:1 rule) and every face — caps, soffits and the deck's underside included — carries the 40 tx/m texture.
 *
 * Frame: s along the deck from `deck.from` to `deck.to`, x to the LEFT of travel (the landmark's local +X), y = world Y
 * (the operator stands at y 0). Pure: the ground is a function the caller passes (the lab field, or a test plane).
 */
import { z } from "zod";
import { ShapeUtils, Vector2 } from "three";

type V2 = [number, number];
type V3 = [number, number, number];
const num = z.number().finite();
const xz = z.tuple([num, num]);
const pair = z.tuple([num.positive(), num.positive()]);

export const bridgeTowerSchema = z.object({
  size: num.min(4).max(20).default(9).describe("Square plan, metres (centred on the deck line at `deck.from`; its far face is where the deck starts)."),
  eaves: num.min(4).max(40).default(15).describe("Wall top (eaves) above the deck, metres."),
  courses: z.number().int().min(0).max(4).default(2).describe("String courses (role arch) dividing the storeys: storeys = courses + 1."),
  passage: z.object({
    width: num.min(2).max(10).default(4).describe("Clear width of the gate passage."),
    height: num.min(2.5).max(12).default(5).describe("Crown of its round-arched head above the deck."),
  }).strict().prefault({}).describe("The round-arched gate passage on the deck line, floor = the deck."),
  roof: z.object({ rise: num.min(1).max(20).default(6), overhang: num.min(0).max(2).default(0.4) }).strict().prefault({}).describe("Pyramid roof (role roof): apex height above the eaves, eaves overhang."),
  slits: z.boolean().default(true).describe("Slit windows (recesses) on every face of the upper storeys."),
}).strict();

const endSchema = z.object({
  kind: z.enum(["gate-tower", "block", "rim"]).default("rim").describe("`gate-tower`: a square tower centred on this end, the deck through its passage; `block`: a plain abutment block `length` m long ending flush with the ground; `rim`: the deck simply meets the ground."),
  length: num.min(2).max(30).default(8).describe("`block`: length along the deck."),
}).strict();

export const bridgeSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9-]*$/).describe("Bridge id (the operator is pb-<place>-<id>)."),
  deck: z.object({
    from: xz.describe("World XZ of the deck line's START (a gate-tower start: the tower's centre; else the deck's first end)."),
    to: xz.describe("World XZ of the deck line's END (the end abutment's outer end, flush with the ground there)."),
    y: num.describe("Deck top (the walk), world Y; level end to end."),
    width: num.min(2).max(20).default(7).describe("Clear width between the parapets' inner faces."),
    thickness: num.min(0.6).max(4).default(1.5).describe("Slab under the walk (paving + cornice course), metres."),
    paving: num.min(0.1).max(0.6).default(0.3).describe("Paving course (role deck) on top of the slab."),
    overhang: num.min(0).max(1.5).default(0.3).describe("Cornice: the slab stands this far past the spandrel faces (its underside is textured)."),
  }).strict(),
  parapet: z.object({
    height: num.min(0.5).max(3).default(1.1).describe("Above the walk, coping included."),
    thickness: num.min(0.2).max(1.5).default(0.6),
    coping: num.min(0.05).max(0.5).default(0.15).describe("Coping course (role coping) on top."),
  }).strict().prefault({}),
  piers: z.array(z.object({
    at: xz.describe("World XZ of the pier centre (projected onto the deck line)."),
    foot: pair.default([11, 10]).describe("[across the deck, along it] at the foot, metres."),
    top: pair.default([8, 8]).describe("[across, along] of the top tier, under the deck."),
    setBacks: z.array(num).max(4).default([]).describe("World Y of each plain set-back; the tiers step linearly from `foot` to `top`."),
    footing: z.object({ height: num.min(0.5).max(12).default(4).describe("Footing course (role footing) up to the lowest ground under it + this."), projection: num.min(0).max(2).default(0.3) }).strict().prefault({}),
    cutwater: z.enum(["left", "right", "both", "none"]).default("none").describe("A pointed cutwater on the footing, on the face to the left / right of travel (from -> to)."),
    refuge: z.object({ bulge: num.min(0.5).max(4).default(1.5).describe("Bulge past the parapet's outer face."), radius: num.min(1.5).max(8).default(3).describe("Plan radius of the half-round.") }).strict().nullable().prefault({}).describe("Half-round refuge both sides where the pier rises through the deck (null = none)."),
  }).strict()).max(8).default([]),
  arches: z.object({
    springing: num.describe("World Y every arch springs from; crown = springing + span / 2 (the spans are equal: one crown height)."),
    endSpan: num.min(2).max(80).optional().describe("Clear span of the two end arches (pier to gorge wall). Default: the mean span between piers."),
    ring: num.min(0.4).max(4).default(1.6).describe("Arch ring (voussoirs, role arch) depth."),
    proud: num.min(0).max(0.6).default(0.15).describe("The ring stands this far proud of the spandrel faces."),
    segments: z.number().int().min(8).max(48).default(24),
    impost: z.object({ depth: num.min(1).max(20).default(4).describe("Minimum length into the wall."), maxDepth: num.min(2).max(40).default(14) }).strict().prefault({}).describe("An end arch whose outer springer stands over lower ground gets an impost block from the buried ground up to the springing, run into the wall until the ground there is at the springing."),
  }).strict(),
  start: endSchema.prefault({}),
  end: endSchema.prefault({}),
  tower: bridgeTowerSchema.prefault({}),
  bury: num.min(0.3).max(6).default(1.5).describe("Every footing goes this far under the LOWEST ground of its outline."),
  bevel: z.record(z.string(), num.min(0).max(1)).default({ face: 0.12, pier: 0.12, footing: 0.1, cornice: 0.06, arch: 0.06, parapet: 0, coping: 0, deck: 0, roof: 0 }).describe("Role -> box chamfer, metres (a chamfer strip takes box UVs off its dominant axis: keep it small, under the art gate's 5% stretched share; none on thin courses)."),
  materials: z.object({
    face: z.string().describe("Tower walls and abutments; the default of band / pierLow / pierMid / pierTop."),
    band: z.union([z.string(), z.array(z.string()).min(1).max(8)]).optional().describe("Spandrel band over the arches, per bay (a list cycles start -> end; default: face)."),
    cornice: z.string().optional().describe("The deck slab's edges and underside (default: arch)."),
    pierLow: z.union([z.string(), z.array(z.string()).min(1).max(8)]).optional().describe("The piers' lowest tier over the footing, per pier (a list cycles; default: face)."),
    pierMid: z.union([z.string(), z.array(z.string()).min(1).max(8)]).optional().describe("The piers' middle tiers, per pier (default: face)."),
    pierTop: z.union([z.string(), z.array(z.string()).min(1).max(8)]).optional().describe("The piers' top tier, under the deck (default: face). One tile over a whole 100 m pier breaks the art gate's variety rule (2500 m2 / 250 repeats per tile): split by height."),
    arch: z.string().describe("Arch rings, string courses, the cornice slab, refuge corbels."),
    parapet: z.string(),
    coping: z.string(),
    deck: z.string().describe("Paving (the walk)."),
    footing: z.string().describe("Pier footings + cutwaters (the wet zone), impost blocks."),
    roof: z.string(),
  }).strict().describe("Material asset ids per role (never the terrain cliff tile)."),
  fog: z.object({ fogReach: num.min(50).max(4000).default(1200), silhouette: num.min(0).max(1).default(0.7) }).strict().prefault({}),
}).strict();
export type BridgeSpec = z.infer<typeof bridgeSchema>;
export type BridgeInput = z.input<typeof bridgeSchema>;

export interface BridgeBase { name: string; poly: V2[]; y: number; why: string }
export interface BridgePlan {
  spec: BridgeSpec;
  /** The `landmark` operator params (no id/op: the caller adds them). */
  landmark: Record<string, unknown>;
  /** Bottoms that must sit on (in) the ground: the `seated` gate measures the daylight along each outline. */
  bases: BridgeBase[];
  /** The walk along the deck centreline, world [x, y, z], from the start end's outer mouth to the end. */
  walk: V3[];
  /** Deck ends as world points (the roads join here, flush). */
  ends: { start: V3; end: V3 };
  frame: { origin: V2; dir: V2; left: V2; length: number; yaw: number };
  hub: V2;
  top: number;
  report: Record<string, unknown>;
  faults: string[];
  notes: string[];
}

const r3 = (v: number) => Math.round(v * 1000) / 1000;

/** A closed prism: `poly` [a, b] (no repeated closing vertex) extruded t0..t1, mapped to local xyz by `to3`. UVs laid
 *  flat per face, in metres: caps (a, b), sides (running length, t). A landmark `mesh` part with explicit `triUv`. */
export function prismPart(name: string, role: string, poly: V2[], to3: (a: number, b: number, t: number) => V3, t0: number, t1: number, capTris?: number[][]): Record<string, unknown> {
  const P = capTris ? poly : poly.filter((p, i) => { const q = poly[(i + poly.length - 1) % poly.length]!; return Math.hypot(p[0] - q[0], p[1] - q[1]) > 1e-4; });
  const n = P.length;
  let area = 0; for (let i = 0; i < n; i++) { const a = P[i]!, b = P[(i + 1) % n]!; area += a[0] * b[1] - b[0] * a[1]; }
  const ccw = area > 0;
  const pos: number[] = [];
  for (const t of [t0, t1]) for (const [a, b] of P) pos.push(...to3(a, b, t).map(r3));
  const run = [0]; for (let i = 0; i < n; i++) { const a = P[i]!, b = P[(i + 1) % n]!; run.push(run[i]! + Math.hypot(b[0] - a[0], b[1] - a[1])); }
  const tris: number[][] = [], uv: number[][] = [];
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n, ui = run[i]!, uj = run[i + 1]!;
    if (ccw) { tris.push([i, j, n + j], [i, n + j, n + i]); uv.push([ui, t0, uj, t0, uj, t1], [ui, t0, uj, t1, ui, t1]); }
    else { tris.push([i, n + j, j], [i, n + i, n + j]); uv.push([ui, t0, uj, t1, uj, t0], [ui, t0, ui, t1, uj, t1]); }
  }
  const faces = capTris ?? ShapeUtils.triangulateShape(P.map(([a, b]) => new Vector2(a, b)), []); // an annulus strip is given (earcut folds a thin ring)
  for (const f of faces) {
    const [a, b, c] = f as [number, number, number];
    const s = (P[b]![0] - P[a]![0]) * (P[c]![1] - P[a]![1]) - (P[b]![1] - P[a]![1]) * (P[c]![0] - P[a]![0]);
    if (Math.abs(s) < 1e-9) throw new Error(`bridge part ${name}: degenerate cap triangle`);
    const [x, y, z] = s > 0 ? [a, b, c] : [a, c, b]; // CCW in (a, b): the top cap faces +t
    tris.push([n + x, n + y, n + z]); uv.push([P[x]![0], P[x]![1], P[y]![0], P[y]![1], P[z]![0], P[z]![1]]);
    tris.push([x, z, y]); uv.push([P[x]![0], P[x]![1], P[z]![0], P[z]![1], P[y]![0], P[y]![1]]);
  }
  // the mapping may be left-handed (a, b, t): outward by the signed volume
  let vol = 0;
  for (const [a, b, c] of tris) {
    const A = pos.slice(a! * 3, a! * 3 + 3), B = pos.slice(b! * 3, b! * 3 + 3), C = pos.slice(c! * 3, c! * 3 + 3);
    vol += A[0]! * (B[1]! * C[2]! - B[2]! * C[1]!) - A[1]! * (B[0]! * C[2]! - B[2]! * C[0]!) + A[2]! * (B[0]! * C[1]! - B[1]! * C[0]!);
  }
  if (vol < 0) for (let k = 0; k < tris.length; k++) { const t = tris[k]!, u = uv[k]!; tris[k] = [t[0]!, t[2]!, t[1]!]; uv[k] = [u[0]!, u[1]!, u[4]!, u[5]!, u[2]!, u[3]!]; }
  return { name, role, triUv: uv.flat().map(r3), node: { id: name, op: "add", shape: "mesh", position: [0, 0, 0], rotation: [0, 0, 0], round: 0, blend: 0, mesh: { positions: pos, indices: tris.flat() } } };
}

const boxPart = (name: string, role: string, x: [number, number], y: [number, number], s: [number, number], bevel?: number, op: "add" | "sub" = "add") =>
  ({ name, role, shape: "box", ...(op === "sub" ? { op } : {}), at: [r3((x[0] + x[1]) / 2), r3((y[0] + y[1]) / 2), r3((s[0] + s[1]) / 2)], size: [r3(x[1] - x[0]), r3(y[1] - y[0]), r3(s[1] - s[0])], ...(bevel ? { bevel } : {}) });

/** Plan the bridge on the measured ground. Throws on a schema error; geometry problems are `faults`. */
export function planBridge(input: BridgeInput, ground: (x: number, z: number) => number): BridgePlan {
  const p = bridgeSchema.parse(input), faults: string[] = [], notes: string[] = [];
  const O = p.deck.from, dx = p.deck.to[0] - O[0], dz = p.deck.to[1] - O[1], L = Math.hypot(dx, dz);
  if (L < 10) throw new Error(`bridge ${p.id}: deck line ${L.toFixed(1)} m is too short`);
  const u: V2 = [dx / L, dz / L], left: V2 = [u[1], -u[0]], yaw = Math.atan2(u[0], u[1]);
  const W = (x: number, s: number): V2 => [O[0] + s * u[0] + x * left[0], O[1] + s * u[1] + x * left[1]];
  const station = (q: V2) => (q[0] - O[0]) * u[0] + (q[1] - O[1]) * u[1];
  const lowest = (x0: number, x1: number, s0: number, s1: number) => { let m = Infinity; for (let i = 0; i <= 8; i++) for (let j = 0; j <= 8; j++) m = Math.min(m, ground(...W(x0 + ((x1 - x0) * i) / 8, s0 + ((s1 - s0) * j) / 8))); return m; };
  const rect = (x0: number, x1: number, s0: number, s1: number): V2[] => [W(x0, s0), W(x1, s0), W(x1, s1), W(x0, s1)];
  const bv = (role: string) => p.bevel[role] ?? 0; // pier tiers take `pier`
  const Y = p.deck.y, slabTop = Y - p.deck.paving, slabBot = Y - p.deck.thickness;
  const hw = p.deck.width / 2, hb = hw + p.parapet.thickness, hc = hb + p.deck.overhang; // walk, band (parapet outer face), cornice
  const parts: Record<string, unknown>[] = [], bases: BridgeBase[] = [];
  const tw = p.tower, towerStart = p.start.kind === "gate-tower", towerEnd = p.end.kind === "gate-tower";
  const s0 = towerStart ? tw.size / 2 : p.start.kind === "block" ? 0 : 0, s1 = towerEnd ? L - tw.size / 2 : L;
  let top = Y + p.parapet.height;

  // ---- gate towers (first: their passage cuts only the tower)
  const tower = (sc: number, sign: 1 | -1, tag: string) => {
    const h = tw.size / 2, ext: [number, number] = [sc - h, sc + h], base = lowest(-h, h, sc - h, sc + h) - p.bury, eaves = Y + tw.eaves;
    parts.push(boxPart(`${tag}-walls`, "face", [-h, h], [base, eaves], ext, bv("face")));
    const pw = tw.passage.width / 2, spring = Y + tw.passage.height - pw;
    parts.push(boxPart(`${tag}-passage`, "opening-cut", [-pw, pw], [Y - p.deck.paving, spring], [sc - h - 0.2, sc + h + 0.2], 0, "sub"));
    parts.push({ name: `${tag}-passage-head`, role: "opening-cut", op: "sub", shape: "cylinder", r: pw, h: tw.size + 0.4, segments: 24, rot: [90, 0, 0], at: [0, r3(spring), r3(sc - h - 0.2)] }); // base centre; Rx(90) runs its axis along +s
    if (tw.slits) {
      const storey = tw.eaves / (tw.courses + 1);
      for (let k = 1; k <= tw.courses; k++) {
        const cy = Y + storey * k + storey * 0.45;
        for (const [fx, fs] of [[0, 1], [0, -1], [1, 0], [-1, 0]] as V2[]) {
          const along: [number, number] = fs ? [sc + fs * h - 0.6, sc + fs * h + 0.6] : [sc - 0.25, sc + 0.25];
          const across: [number, number] = fx ? [fx * h - 0.6, fx * h + 0.6].sort((a, b) => a - b) as [number, number] : [-0.25, 0.25];
          parts.push(boxPart(`${tag}-slit-${k}-${fx}${fs}`, "opening-cut", across, [cy - 1.1, cy + 1.1], along, 0, "sub"));
        }
      }
    }
    parts.push(boxPart(`${tag}-passage-floor`, "deck", [-pw, pw], [Y - p.deck.paving, Y], [sc - h, sc + h], bv("deck")));
    for (let k = 1; k <= tw.courses; k++) { const cy = Y + (tw.eaves / (tw.courses + 1)) * k; parts.push(boxPart(`${tag}-course-${k}`, "arch", [-h - 0.35, h + 0.35], [cy, cy + 0.5], [sc - h - 0.35, sc + h + 0.35], bv("arch"))); }
    const o = h + tw.roof.overhang, apex = eaves + tw.roof.rise;
    // pyramid: a closed 5-vertex solid, each sloped face laid flat (u along its eave, v up the slope)
    const corners: V3[] = [[-o, eaves, sc - o], [o, eaves, sc - o], [o, eaves, sc + o], [-o, eaves, sc + o]], tip: V3 = [0, apex, sc];
    const pos = [...corners.flat(), ...tip].map(r3), slant = Math.hypot(o, tw.roof.rise), idx: number[] = [], uv: number[] = [];
    for (let i = 0; i < 4; i++) { const j = (i + 1) % 4; idx.push(i, 4, j); uv.push(0, 0, o, slant, 2 * o, 0); }
    idx.push(0, 1, 2, 0, 2, 3); uv.push(corners[0]![0], corners[0]![2], corners[1]![0], corners[1]![2], corners[2]![0], corners[2]![2], corners[0]![0], corners[0]![2], corners[2]![0], corners[2]![2], corners[3]![0], corners[3]![2]);
    parts.push({ name: `${tag}-roof`, role: "roof", triUv: uv.map(r3), node: { id: `${tag}-roof`, op: "add", shape: "mesh", position: [0, 0, 0], rotation: [0, 0, 0], round: 0, blend: 0, mesh: { positions: pos, indices: idx } } });
    bases.push({ name: `${tag}`, poly: rect(-h, h, ext[0], ext[1]), y: base, why: "gate tower" });
    top = Math.max(top, apex);
    void sign;
  };
  if (towerStart) tower(0, 1, "gate-tower");
  if (towerEnd) tower(L, -1, "end-tower");

  // ---- piers (stations on the deck line)
  const piers = p.piers.map((q) => ({ q, s: station(q.at), lateral: (q.at[0] - O[0]) * left[0] + (q.at[1] - O[1]) * left[1] })).sort((a, b) => a.s - b.s);
  for (const { q, lateral } of piers) if (Math.abs(lateral) > 1) notes.push(`pier at ${q.at.join(",")} stands ${lateral.toFixed(1)} m off the deck line: built on the line`);
  const pierRows: Record<string, unknown>[] = [];
  piers.forEach(({ q, s }, i) => {
    const tag = `pier-${i + 1}`, [fa, fl] = q.foot, [ta, tl] = q.top, fp = q.footing.projection;
    const groundMin = lowest(-fa / 2 - fp, fa / 2 + fp, s - fl / 2 - fp, s + fl / 2 + fp), base = groundMin - p.bury, footTop = groundMin + q.footing.height;
    const levels = [footTop, ...q.setBacks.filter((y) => y > footTop + 1 && y < slabBot - 1).sort((a, b) => a - b), slabBot];
    parts.push(boxPart(`${tag}-footing`, "footing", [-fa / 2 - fp, fa / 2 + fp], [base, footTop], [s - fl / 2 - fp, s + fl / 2 + fp], bv("footing")));
    for (const side of q.cutwater === "both" ? [1, -1] : q.cutwater === "left" ? [1] : q.cutwater === "right" ? [-1] : []) {
      const x0 = side * (fa / 2 + fp), half = fl / 2 + fp, poly: V2[] = [[x0, s - half], [x0 + side * half, s], [x0, s + half]];
      parts.push(prismPart(`${tag}-cutwater-${side > 0 ? "left" : "right"}`, "footing", poly, (a, b, t) => [a, t, b], base, footTop));
    }
    const tiers = levels.length - 1;
    for (let k = 0; k < tiers; k++) {
      const f = tiers === 1 ? 1 : k / (tiers - 1), a = fa + (ta - fa) * f, l = fl + (tl - fl) * f;
      parts.push(boxPart(`${tag}-tier-${k + 1}`, `${k === 0 ? "pier-low" : k === tiers - 1 ? "pier-top" : "pier-mid"}-${i + 1}`, [-a / 2, a / 2], [levels[k]!, levels[k + 1]!], [s - l / 2, s + l / 2], bv("pier")));
    }
    bases.push({ name: `${tag}-footing`, poly: rect(-fa / 2 - fp, fa / 2 + fp, s - fl / 2 - fp, s + fl / 2 + fp), y: base, why: "pier footing" });
    pierRows.push({ id: tag, at: W(0, s).map((v) => Math.round(v * 10) / 10), station: Math.round(s * 10) / 10, groundMin: Math.round(groundMin * 10) / 10, base: Math.round(base * 10) / 10, height: Math.round((Y - groundMin) * 10) / 10, tiers: levels.map((v) => Math.round(v * 10) / 10) });
  });

  // ---- arches: equal clear spans between piers, the same span at both ends (one crown height)
  const sp = p.arches.springing;
  const faces = piers.map(({ q, s }) => [s - q.top[1] / 2, s + q.top[1] / 2] as [number, number]);
  const inner = faces.slice(1).map((f, i) => f[0] - faces[i]![1]);
  const endSpan = p.arches.endSpan ?? (inner.length ? inner.reduce((a, b) => a + b, 0) / inner.length : Math.min(30, (s1 - s0) / 3));
  const arches: { name: string; c: number; R: number; end: "start" | "end" | null }[] = [];
  if (faces.length) {
    arches.push({ name: "arch-start", c: faces[0]![0] - endSpan / 2, R: endSpan / 2, end: "start" });
    inner.forEach((w, i) => arches.push({ name: `arch-${i + 1}`, c: faces[i]![1] + w / 2, R: w / 2, end: null }));
    arches.push({ name: "arch-end", c: faces[faces.length - 1]![1] + endSpan / 2, R: endSpan / 2, end: "end" });
  }
  const crowns = arches.map((a) => sp + a.R);
  if (crowns.length && Math.max(...crowns) - Math.min(...crowns) > 1) notes.push(`crowns differ by ${(Math.max(...crowns) - Math.min(...crowns)).toFixed(1)} m (pier spacing uneven)`);
  const Ro = (a: { R: number }) => a.R + p.arches.ring, seg = p.arches.segments;
  const arc = (c: number, R: number, from: number, to: number): V2[] => Array.from({ length: seg + 1 }, (_, k) => { const t = from + ((to - from) * k) / seg; return [c + R * Math.cos(t), sp + R * Math.sin(t)] as V2; });
  if (crowns.length && Math.max(...crowns) + p.arches.ring > slabBot - 0.5) faults.push(`ARCH: crown ${Math.max(...crowns).toFixed(1)} + ring ${p.arches.ring} reaches the deck slab (${slabBot.toFixed(1)}): lower the springing`);

  // impost blocks under an end arch's outer springer standing over lower ground; the band's own bottom beyond it
  const bandStations = [s0, ...piers.map((x) => x.s), s1];
  const impostExt: Record<string, [number, number]> = {};
  for (const a of arches.filter((x) => x.end)) {
    const dir = a.end === "start" ? -1 : 1, spr = a.c + dir * a.R, edge = a.c + dir * Ro(a);
    const reach = (s: number) => lowest(-hb - 0.5, hb + 0.5, s, s) >= sp + 0.3;
    let d = p.arches.impost.depth;
    while (d < p.arches.impost.maxDepth && !reach(edge + dir * d)) d += 1;
    if (lowest(-hb - 0.5, hb + 0.5, Math.min(spr, edge + dir * d), Math.max(spr, edge + dir * d)) >= sp - 0.05) { notes.push(`${a.name}: its outer springer beds into rock at ${lowest(-hb, hb, spr, spr).toFixed(1)} m >= the springing: no impost block`); continue; }
    const sA = Math.min(spr - dir * 0.6, edge + dir * d), sB = Math.max(spr - dir * 0.6, edge + dir * d);
    const ext: [number, number] = [Math.max(sA, s0), Math.min(sB, s1)], gmin = lowest(-hb - 0.5, hb + 0.5, ext[0], ext[1]);
    impostExt[a.end!] = ext;
    parts.push(boxPart(`impost-${a.end}`, "footing", [-hb - 0.5, hb + 0.5], [gmin - p.bury, sp], ext, bv("footing")));
    bases.push({ name: `impost-${a.end}`, poly: rect(-hb - 0.5, hb + 0.5, ext[0], ext[1]), y: gmin - p.bury, why: "end arch impost block" });
    if (!reach(edge + dir * d)) faults.push(`IMPOST ${a.end}: the ground under the band stays below the springing ${p.arches.impost.maxDepth} m past the springer (raise the springing or lengthen the end arch)`);
  }
  // abutment blocks
  for (const [k, e] of [["start", p.start], ["end", p.end]] as const) {
    if (e.kind !== "block") continue;
    const ext: [number, number] = k === "start" ? [0, e.length] : [L - e.length, L], gmin = lowest(-hc, hc, ext[0], ext[1]);
    parts.push(boxPart(`abutment-${k}`, "face", [-hc, hc], [gmin - p.bury, slabBot], ext, bv("face")));
    bases.push({ name: `abutment-${k}`, poly: rect(-hc, hc, ext[0], ext[1]), y: gmin - p.bury, why: "abutment block" });
  }

  // ---- deck: cornice slab, paving, parapets + coping (breaking at the refuges)
  parts.push(boxPart("deck-slab", "cornice", [-hc, hc], [slabBot, slabTop], [s0, s1], bv("cornice")));
  parts.push(boxPart("deck-paving", "deck", [-hw, hw], [slabTop, Y], [s0, s1], bv("deck")));
  const refuges = piers.filter(({ q }) => q.refuge).map(({ q, s }) => ({ s, R: q.refuge!.radius, bulge: q.refuge!.bulge }));
  const breaks: [number, number][] = [];
  for (const r of refuges) {
    const cx = hb + r.bulge - r.R; // circle centre (x) so the outer face reaches hb + bulge
    if (cx >= hb || r.R <= p.parapet.thickness + 0.5) { faults.push(`REFUGE at ${r.s.toFixed(1)}: radius ${r.R} too small for a ${r.bulge} m bulge`); continue; }
    const half = Math.sqrt(r.R * r.R - (hb - cx) ** 2), ri = r.R - p.parapet.thickness, halfIn = Math.sqrt(Math.max(0, ri * ri - (hw - cx) ** 2));
    const th0 = Math.acos((hb - cx) / r.R), ph0 = Math.acos(Math.min(1, (hw - cx) / ri)), n = 12;
    const outer: V2[] = Array.from({ length: n + 1 }, (_, k) => { const t = -th0 + (2 * th0 * k) / n; return [cx + r.R * Math.cos(t), r.s + r.R * Math.sin(t)] as V2; });
    const innerArc: V2[] = Array.from({ length: n + 1 }, (_, k) => { const t = ph0 - (2 * ph0 * k) / n; return [cx + ri * Math.cos(t), r.s + ri * Math.sin(t)] as V2; });
    const cPoly: V2[] = [...outer, [hw, r.s + half], ...innerArc, [hw, r.s - half]];
    const floor: V2[] = [[hw, r.s - halfIn], ...[...innerArc].reverse().slice(1, -1), [hw, r.s + halfIn]];
    const corbel: V2[] = [[hw, r.s - half], ...outer, [hw, r.s + half]];
    for (const side of [1, -1]) {
      const m = (q: V2[]): V2[] => q.map(([x, s]) => [side * x, s]);
      const tag = `refuge-${Math.round(r.s)}-${side > 0 ? "left" : "right"}`;
      parts.push(prismPart(`${tag}-corbel`, "arch", m(corbel), (a, b, t) => [a, t, b], slabBot - 1.5, slabTop));
      parts.push(prismPart(`${tag}-floor`, "deck", m(floor), (a, b, t) => [a, t, b], slabTop, Y));
      parts.push(prismPart(`${tag}-parapet`, "parapet", m(cPoly), (a, b, t) => [a, t, b], slabTop, Y + p.parapet.height - p.parapet.coping));
      parts.push(prismPart(`${tag}-coping`, "coping", m(cPoly), (a, b, t) => [a, t, b], Y + p.parapet.height - p.parapet.coping, Y + p.parapet.height));
    }
    breaks.push([r.s - half, r.s + half]);
  }
  const runs: [number, number][] = []; let at = s0;
  for (const [a, b] of breaks.sort((x, y) => x[0] - y[0])) { if (a > at + 0.3) runs.push([at, a]); at = Math.max(at, b); }
  if (s1 > at + 0.3) runs.push([at, s1]);
  const pTop = Y + p.parapet.height - p.parapet.coping;
  runs.forEach(([a, b], i) => { for (const side of [1, -1]) {
    const xr: [number, number] = side > 0 ? [hw, hb] : [-hb, -hw], tag = `parapet-${i + 1}-${side > 0 ? "left" : "right"}`;
    parts.push(boxPart(tag, "parapet", xr, [slabTop, pTop], [a, b], bv("parapet")));
    parts.push(boxPart(`${tag}-coping`, "coping", xr, [pTop, Y + p.parapet.height], [a, b], bv("coping")));
  } });

  // ---- spandrel band over the arches (bays between supports) and the arch rings
  for (let k = 0; k < arches.length; k++) {
    const a = arches[k]!, lo = bandStations[k]!, hi = bandStations[k + 1]!, ro = Ro(a);
    // a band ending against an abutment block stops 0.3 m inside it: its end face on the block's end face was a 70 m2 zfight
    const l0 = Math.max(lo, s0 + (p.start.kind === "block" ? 0.3 : 0)), h0 = Math.min(hi, s1 - (p.end.kind === "block" ? 0.3 : 0));
    const cl = a.c - ro, cr = a.c + ro;
    const bay: V2[] = [];
    if (cl > l0 + 0.05 && cr < h0 - 0.05) bay.push([l0, slabBot], [l0, sp], [cl, sp], ...arc(a.c, ro, Math.PI, 0).slice(1, -1), [cr, sp], [h0, sp], [h0, slabBot]);
    else {
      // an end arch whose outer half runs past the deck end: the band follows the arch out to the end station
      const lim = cl <= l0 + 0.05 ? l0 : h0, side = cl <= l0 + 0.05 ? -1 : 1;
      const tLim = Math.acos(Math.max(-1, Math.min(1, (lim - a.c) / ro)));
      const pts = side < 0 ? arc(a.c, ro, tLim, 0).slice(0, -1) : arc(a.c, ro, Math.PI, tLim).slice(1);
      if (side < 0) bay.push([l0, slabBot], ...pts, [cr, sp], [h0, sp], [h0, slabBot]);
      else bay.push([l0, slabBot], [l0, sp], [cl, sp], ...pts, [h0, slabBot]);
      notes.push(`${a.name}: its outer half runs past the deck end (s ${lim.toFixed(1)}): cut there`);
    }
    parts.push(prismPart(`band-${a.name}`, `band-${k + 1}`, bay.map(([s, y]) => [s, y]), (s, y, x) => [x, y, s], -hb, hb));
    const ring: V2[] = [...arc(a.c, ro, 0, Math.PI), ...arc(a.c, a.R, Math.PI, 0)];
    const I = (k: number) => 2 * seg + 1 - k, strip = Array.from({ length: seg }, (_, k) => [[k, k + 1, I(k + 1)], [k, I(k + 1), I(k)]]).flat();
    if (ring.every(([s]) => s >= s0 - 0.01 && s <= s1 + 0.01)) parts.push(prismPart(`ring-${a.name}`, "arch", ring, (s, y, x) => [x, y, s], -hb - p.arches.proud, hb + p.arches.proud, strip));
    else { const cut = ring.filter(([s]) => s >= s0 - 0.01 && s <= s1 + 0.01); if (cut.length >= 6) parts.push(prismPart(`ring-${a.name}`, "arch", cut, (s, y, x) => [x, y, s], -hb - p.arches.proud, hb + p.arches.proud)); }
    // the band's own bottom beyond an end arch (the springing level) must stand on rock or the impost
    if (a.end) {
      const im = impostExt[a.end];
      const [b0, b1] = a.end === "start" ? [l0, Math.max(l0, Math.min(cl, im ? im[0] : cl))] : [Math.min(h0, Math.max(cr, im ? im[1] : cr)), h0];
      if (b1 - b0 > 0.2) bases.push({ name: `band-${a.end}-bottom`, poly: rect(-hb, hb, b0, b1), y: sp, why: "spandrel bottom beyond the end arch (rock or impost under it)" });
    }
  }

  // ---- placement + bookkeeping
  const mid = (s0 + s1) / 2, hub = W(0, mid);
  const walk: V3[] = [];
  const mouth = towerStart ? -tw.size / 2 - 3 : s0;
  for (let s = mouth; s < s1; s += 6) walk.push([...W(0, s), Y] as unknown as V3);
  walk.push([...W(0, s1), Y] as unknown as V3);
  const walkW: V3[] = walk.map((q) => [Math.round(q[0] * 100) / 100, Y, Math.round(q[1] * 100) / 100]);
  // reach targets at the deck start only: the deck itself is the declared `deck` route (poi-walk walks it); poi-walk
  // chains landmark targets with its GROUND planner, which cannot plan along a deck 100 m over a gorge (STUCK at once)
  const targets = [{ name: "deck-start", at: [0, r3(Y + 0.05), r3(s0 + 1.5)] }];
  if (towerStart) targets.unshift({ name: "gate-passage", at: [0, r3(Y + 0.05), 0] });
  const mf = p.materials.face;
  const pick = (v: string | string[] | undefined, k: number) => (v === undefined ? mf : Array.isArray(v) ? v[k % v.length]! : v);
  const materials: Record<string, string> = { cornice: p.materials.cornice ?? p.materials.arch, face: p.materials.face, arch: p.materials.arch, parapet: p.materials.parapet, coping: p.materials.coping, deck: p.materials.deck, footing: p.materials.footing, roof: p.materials.roof };
  arches.forEach((_, k) => { materials[`band-${k + 1}`] = pick(p.materials.band, k); });
  piers.forEach((_, i) => { materials[`pier-low-${i + 1}`] = pick(p.materials.pierLow, i); materials[`pier-mid-${i + 1}`] = pick(p.materials.pierMid, i); materials[`pier-top-${i + 1}`] = pick(p.materials.pierTop, i); });
  const landmark = {
    kind: "built", at: [r3(O[0]), r3(O[1])], y: 0, yaw: Math.round((yaw * 180) / Math.PI * 1e4) / 1e4, voxel: 0.5,
    source: { csg: { version: 1, roles: {}, parts } }, materials: Object.fromEntries(Object.entries(materials).filter(([r]) => parts.some((q) => q.role === r))), blend: { mode: "none" }, targets, fog: p.fog,
  };
  const ends = { start: [...W(0, mouth), Y] as unknown as V3, end: [...W(0, s1), Y] as unknown as V3 };
  const report = {
    span: Math.round((s1 - s0) * 10) / 10, deckY: Y, deckLength: Math.round((s1 - s0) * 10) / 10, heading: Math.round(((yaw * 180) / Math.PI + 360) % 360),
    piers: pierRows, arches: arches.map((a) => ({ name: a.name, span: Math.round(2 * a.R * 10) / 10, crown: Math.round((sp + a.R) * 10) / 10, from: Math.round((a.c - a.R) * 10) / 10, to: Math.round((a.c + a.R) * 10) / 10 })),
    refuges: refuges.map((r) => Math.round(r.s * 10) / 10), towerTop: Math.round(top * 10) / 10, parts: parts.length,
  };
  return { spec: p, landmark, bases, walk: walkW, ends: { start: [r3(ends.start[0]), Y, r3(ends.start[1])], end: [r3(ends.end[0]), Y, r3(ends.end[1])] }, frame: { origin: O, dir: u, left, length: L, yaw }, hub: [r3(hub[0]), r3(hub[1])], top, report, faults, notes };
}

/** Daylight along a base outline: the most metres between the base and the ground under it (0 when buried), sampled
 *  every `step` m along every edge. The `seated` gate's rule for a bridge base (max <= SEAT_GAP_M). */
export function baseGap(b: { poly: V2[]; y: number }, ground: (x: number, z: number) => number, step = 0.5): { gap: number; at: V2 | null; buried: number } {
  let gap = 0, at: V2 | null = null, buried = Infinity;
  for (let i = 0; i < b.poly.length; i++) {
    const a = b.poly[i]!, c = b.poly[(i + 1) % b.poly.length]!, n = Math.max(1, Math.ceil(Math.hypot(c[0] - a[0], c[1] - a[1]) / step));
    for (let k = 0; k < n; k++) {
      const x = a[0] + ((c[0] - a[0]) * k) / n, z = a[1] + ((c[1] - a[1]) * k) / n, g = ground(x, z), d = b.y - g;
      buried = Math.min(buried, g - b.y);
      if (d > gap) { gap = d; at = [Math.round(x * 10) / 10, Math.round(z * 10) / 10]; }
    }
  }
  return { gap: Math.round(gap * 100) / 100, at, buried: Math.round(buried * 100) / 100 };
}

/** A masked LOWERING patch under a gate tower's passage and its mouth (the ground pokes through the passage floor, or
 *  lies coplanar with the paving: zfight): along the deck line from `sFrom` to `sTo` (stations from `origin`), across
 *  +-`halfAcross`, the ground is pulled to `y(s)`, the weight falling to 0 over `feather` m; a sample whose ground is
 *  already at or under its target height gets weight 0 (the patch only ever lowers: it never fills the rim's edge). */
export function lowerPatch(id: string, origin: V2, dir: V2, halfAcross: number, sFrom: number, sTo: number, y: (s: number) => number, ground: (x: number, z: number) => number, feather = 3): Record<string, unknown> {
  const left: V2 = [dir[1], -dir[0]], sc = (sFrom + sTo) / 2, half = (sTo - sFrom) / 2, R = Math.hypot(halfAcross, half) + feather + 1;
  const cx = origin[0] + sc * dir[0], cz = origin[1] + sc * dir[1];
  const x0 = Math.floor(cx - R), z0 = Math.floor(cz - R), n = Math.ceil(2 * R) + 1;
  const heights: number[] = [], weights: number[] = [];
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
    const X = x0 + i, Z = z0 + j, dx = X - origin[0], dz = Z - origin[1], a = dx * left[0] + dz * left[1], st = dx * dir[0] + dz * dir[1];
    const out = Math.hypot(Math.max(0, Math.abs(a) - halfAcross), Math.max(0, Math.abs(st - sc) - half)), h = y(Math.max(sFrom, Math.min(sTo, st)));
    heights.push(Math.round(h * 100) / 100);
    weights.push(ground(X, Z) <= h + 0.02 ? 0 : Math.round(Math.max(0, Math.min(1, 1 - out / feather)) * 1000) / 1000);
  }
  return { id, origin: [x0, z0], size: [n - 1, n - 1], columns: n, rows: n, heights, weights, blend: 1, calm: true, filter: 0.5 };
}

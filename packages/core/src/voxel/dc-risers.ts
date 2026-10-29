/**
 * DC RISERS: a terrace riser as a PLANAR-FACED volume in the voxel field (`features.dcRisers`).
 *
 * Derek, 2026-10-29: "those retaining walls just dont feel good... i feel like you could do this with a DC much
 * better" and "my problem with the walls is they dont feel hand made". A kit retaining wall is a flat panel set
 * against the ground: a seam where it meets the terrain, a ruler-straight top, the same pieces repeated. A DC riser
 * is the GROUND itself: the shelf, the face and the foot are one density, so there is no seam to hide, and render,
 * physics and placement read the same surface (they all mesh the field: docs/voxel-worlds.md section 4).
 *
 * Shape (all planes, so the dual contourer keeps every edge sharp):
 * - a polyline: the riser's TOP EDGE, walked with the high ground (the shelf) on the LEFT, the low side to the
 *   right (the kit and `terraceWalls` convention); `top` is the shelf level, `foot` the ground in front;
 * - a battered face (`batter` metres back per metre of height), optionally STEPPED: `steps.tiers` lower faces with
 *   flat planted treads `steps.tread` m deep between them (a tall riser as benches, never one sheer face);
 * - hand-made roughness, seeded per riser (`rough`): the face is cut into PANELS of varying width, each standing out and
 *   leaning by its own hashed amount with a planar V joint between neighbours; the crest is laid in short RUNS, some
 *   stepped down a course or two, with a few dropped stones (notches). Every term is planar and a pure function of
 *   world position (chunks agree; the server builds the same ground);
 * - paint: the face takes the palette surfaces named in `surfaces` (the riser tiles: rubble body, a damp mossy foot
 *   band over every foot and tread, a lighter weathered band under every crest), else the zone's own cliff splat.
 *
 * Blend: within `back` m behind the top edge and `apron` m in front of the lowest foot the riser OWNS the ground
 * (weight 1: the density is the riser's planes alone); over `feather` m beyond that, and past the polyline's ends,
 * the density blends back into the heightfield's. The weight depends on (x, z) only, so `height()` is the same blend
 * of the riser's exact column top and the heightfield (exact wherever the weight is 0 or 1).
 *
 * The mesher: `voxelWorld.mesher: "auto"` picks dual contouring for every cell a riser's influence reaches (plus a
 * margin, so each MC/DC border lies on smooth ground — the planar-cliff rule), with exact Hermite data on the
 * riser's samples. Keep features at least one voxel (2 m on a 48/24 world) wide: `rough.panel` >= 2 voxels and
 * `rough.run` >= 2 voxels; offsets (set-backs, steps) may be any size — a plane can sit anywhere, but a feature
 * narrower than a cell has no vertex of its own.
 */
import { z } from "zod";
import { hash3i, smoothstep } from "./noise.js";

const slug = z.string().regex(/^[a-z][a-z0-9-]*$/, "lowercase slug");
const xz = z.tuple([z.number().finite(), z.number().finite()]);

export const dcRiserRoughSchema = z
  .object({
    panel: z.number().min(2).max(40).default(5).describe("Mean width (m) of one face panel along the riser (each panel is one plane). Keep >= 2 voxels."),
    depth: z.number().min(0).max(2).default(0.45).describe("Most a panel stands proud of the face line (m), hashed per panel: neighbouring panels make set-backs."),
    lean: z.number().min(0).max(0.3).default(0.08).describe("Most a panel's batter differs from the riser's (m per m of height), hashed per panel: faces that lean differently."),
    joint: z.number().min(0).max(1.5).default(0.3).describe("Depth (m) of the planar V joint cut between neighbouring panels."),
    jointWidth: z.number().min(0.5).max(4).default(1.6).describe("Half-width (m) of a joint's V at the face."),
    run: z.tuple([z.number().min(2), z.number().min(2)]).default([4, 10]).describe("Crest runs: min and max length (m). Each run of the crest is laid at its own height."),
    step: z.number().min(0).max(1.5).default(0.4).describe("Metres a stepped run of the crest sits below the shelf (a course or two)."),
    stepShare: z.number().min(0).max(1).default(0.35).describe("Share of crest runs stepped down (`step`, a few twice)."),
    crest: z.number().min(1).max(6).default(2).describe("Depth (m) behind the top edge the crest steps and dropped stones reach (keep >= 1 voxel)."),
    drop: z.number().min(0).max(2).default(0.6).describe("Depth (m) of a dropped stone: a notch in the crest one panel joint wide."),
    dropShare: z.number().min(0).max(1).default(0.15).describe("Share of crest runs with a dropped stone."),
  })
  .describe("Hand-made roughness: panels, joints, crest runs, dropped stones. Every number is seeded per riser (`seed`).");

export const dcRiserSchema = z
  .object({
    id: slug.describe("Stable id (`<town>-riser-<n>` when `worldgen terrace` writes it)."),
    owner: z.string().optional().describe("Who wrote it (a town or POI id). `worldgen terrace` rewrites the risers its towns own."),
    points: z.array(xz).min(2).max(64).describe("The TOP EDGE, world XZ, walked with the shelf on the LEFT (the low side is on the right). Turns are rounded on the outside; keep them under ~60 deg."),
    top: z.number().finite().describe("Shelf level: world Y of the ground behind the top edge."),
    foot: z.number().finite().describe("World Y of the ground in front of the riser's foot. Must be below `top`."),
    batter: z.number().min(0).max(0.6).default(0.12).describe("Metres the face leans back per metre of height (0 = vertical). Dry-stone retaining work: 0.1-0.2."),
    steps: z
      .object({
        tiers: z.number().int().min(2).max(4).describe("How many faces the drop is split into (equal heights)."),
        tread: z.number().min(1).max(8).default(2).describe("Depth (m) of the flat planted tread between two faces."),
      })
      .optional()
      .describe("A STEPPED riser: benches with planted treads (each face <= 2.5 m is the riser rule's tier). Absent = one face."),
    back: z.number().min(0).max(40).default(2).describe("Metres behind the top edge the riser holds the shelf at `top` before blending into the ground."),
    apron: z.number().min(0).max(40).default(2).describe("Metres in front of the lowest foot held at `foot` before blending into the ground."),
    feather: z.number().min(1).max(30).default(6).describe("Metres over which the riser blends back into the heightfield (beyond `back` / `apron`, and past the polyline's ends)."),
    surfaces: z
      .object({
        face: z.string().optional().describe("Palette surface (recipe.surfaces name) for the face body. Omitted = the zone's natural cliff splat."),
        foot: z.string().optional().describe("Palette surface for the damp band over every foot and tread (moss, water staining)."),
        top: z.string().optional().describe("Palette surface for the weathered band under every crest (lighter)."),
        band: z.number().min(0.2).max(3).default(0.9).describe("Height (m) of the foot and crest bands."),
      })
      .prefault({})
      .describe("Face paint by role. Names that are not in the palette are ignored (the face keeps the natural splat)."),
    rough: dcRiserRoughSchema.prefault({}),
    seed: z.number().int().default(1).describe("Seeds the panels, runs, steps and dropped stones (combined with the world seed and the id)."),
  })
  .describe("A terrace riser as a planar-faced DC volume of the terrain: top edge polyline, shelf/foot levels, batter, optional benches, hand-made roughness, face paint. No kit pieces, no seam.");

export type DcRiserDoc = z.infer<typeof dcRiserSchema>;

/** What the field asks of the compiled risers. */
export interface DcRisers {
  readonly count: number;
  /** Influence rectangles [x0, z0, x1, z1] (weight > 0 inside), one per riser. */
  readonly bounds: readonly (readonly [number, number, number, number])[];
  /** Largest blend weight at (x, z) (0 = no riser reaches). */
  weight(x: number, z: number): number;
  /** Density `d` (the heightfield's, already resolved at this point) blended toward every riser reaching (x, z). */
  blend(x: number, y: number, z: number, d: number): number;
  /** Column ground: heightfield `h` blended toward each riser's exact column top (exact where the weight is 0 or 1). */
  column(x: number, z: number, h: number): number;
  /** Does any riser's influence (+ `margin`) reach the rectangle? */
  reaches(x0: number, z0: number, x1: number, z1: number, margin?: number): boolean;
  /** Y span [foot - 2, top + 2] of every riser reaching the rectangle, or null. */
  span(x0: number, z0: number, x1: number, z1: number): { min: number; max: number } | null;
  /** Paint at a face point: which band of which riser, and how strongly (weight x steepness), or null. */
  paint(x: number, y: number, z: number, steep: number): { riser: number; band: "face" | "foot" | "top"; amount: number } | null;
  /** The compiled riser `k`'s doc. */
  doc(k: number): DcRiserDoc;
}

interface Seg { ax: number; az: number; dx: number; dz: number; len: number; s0: number }
interface Compiled {
  doc: DcRiserDoc;
  segs: Seg[];
  /** pseudo-normal at each vertex (sum of the adjacent segments' right normals, normalised) */
  vn: [number, number][];
  length: number;
  /** tier crests: y and edge offset n (0 for the top tier, growing toward the low side) */
  tiers: { y: number; n: number; h: number }[];
  /** n of the lowest foot */
  footN: number;
  panels: number[];
  panelSet: number[];
  panelLean: number[];
  runs: number[];
  runDrop: number[];
  /** dropped stone: [s0, s1] inside the run, or null */
  runNotch: ([number, number] | null)[];
  box: [number, number, number, number];
  seed: number;
}

function strHash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h | 0;
}
const unit = (a: number, b: number, seed: number) => hash3i(a, b, 0x51ed, seed) / 4294967296;

function compile(doc: DcRiserDoc, worldSeed: number): Compiled {
  const seed = (worldSeed * 31 + strHash(doc.id) + doc.seed * 7919) | 0;
  const pts = doc.points.filter((p, i) => i === 0 || Math.hypot(p[0] - doc.points[i - 1]![0], p[1] - doc.points[i - 1]![1]) > 1e-6);
  const segs: Seg[] = [];
  let s0 = 0;
  for (let i = 0; i + 1 < pts.length; i++) {
    const a = pts[i]!, b = pts[i + 1]!, len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    segs.push({ ax: a[0], az: a[1], dx: (b[0] - a[0]) / len, dz: (b[1] - a[1]) / len, len, s0 });
    s0 += len;
  }
  if (!segs.length) throw new Error(`dcRiser ${doc.id}: needs two distinct points`);
  const right = (g: Seg): [number, number] => [-g.dz, g.dx];
  const vn: [number, number][] = pts.map((_, i) => {
    const a = segs[Math.max(0, i - 1)]!, b = segs[Math.min(segs.length - 1, i)]!;
    const na = right(a), nb = right(b), x = na[0] + nb[0], z = na[1] + nb[1], l = Math.hypot(x, z) || 1;
    return [x / l, z / l];
  });
  const H = doc.top - doc.foot;
  if (!(H > 0)) throw new Error(`dcRiser ${doc.id}: top ${doc.top} must be above foot ${doc.foot}`);
  const k = doc.steps?.tiers ?? 1, tread = doc.steps?.tread ?? 0, h = H / k, b = doc.batter;
  const tiers = Array.from({ length: k }, (_, j) => ({ y: doc.top - j * h, n: j * (tread + h * b), h }));
  const footN = (k - 1) * (tread + h * b) + h * b + doc.rough.depth + doc.rough.lean * h;
  const r = doc.rough, ext = doc.feather + doc.back + doc.apron + r.panel + 4;
  // panel borders along s (jittered), and crest runs (lengths in [run0, run1]); both over the whole blended span
  const panels: number[] = [], panelSet: number[] = [], panelLean: number[] = [];
  for (let i = 0, s = -ext; s < s0 + ext; i++) {
    panels.push(s);
    panelSet.push(unit(i, 1, seed) * r.depth);
    panelLean.push((unit(i, 2, seed) * 2 - 1) * r.lean);
    s += r.panel * (0.6 + unit(i, 3, seed) * 0.8);
  }
  panels.push(s0 + ext + r.panel * 2);
  const runs: number[] = [], runDrop: number[] = [], runNotch: ([number, number] | null)[] = [];
  let prevDrop = -1, flat = 0;
  for (let i = 0, s = -ext; s < s0 + ext; i++) {
    const len = r.run[0] + unit(i, 4, seed) * Math.max(0, r.run[1] - r.run[0]);
    runs.push(s);
    const u = unit(i, 5, seed);
    let drop = u < r.stepShare ? r.step * (u < r.stepShare * 0.25 ? 2 : 1) : 0;
    // never a ruler-flat crest: a run that would carry one level past ~10 m steps (handmade-check fails 12 m of flat top)
    if (r.stepShare > 0 && r.step > 0 && drop === prevDrop && flat + len > 10) drop = prevDrop > 0 ? 0 : r.step;
    flat = drop === prevDrop ? flat + len : len;
    prevDrop = drop;
    runDrop.push(drop);
    if (unit(i, 6, seed) < r.dropShare && len >= 4) {
      const at = s + 1 + unit(i, 7, seed) * (len - 3);
      runNotch.push([at, at + 2]);
    } else runNotch.push(null);
    s += len;
  }
  runs.push(s0 + ext + r.run[1] * 2);
  // influence box: every vertex padded by the band + feather (both sides) and the end feather
  const reach = Math.max(doc.back, footN + doc.apron) + doc.feather + 1;
  let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
  const ends: [number, number][] = [
    [segs[0]!.ax - segs[0]!.dx * doc.feather, segs[0]!.az - segs[0]!.dz * doc.feather],
    ...pts,
    [pts.at(-1)![0] + segs.at(-1)!.dx * doc.feather, pts.at(-1)![1] + segs.at(-1)!.dz * doc.feather],
  ];
  for (const [x, z] of ends) { x0 = Math.min(x0, x - reach); z0 = Math.min(z0, z - reach); x1 = Math.max(x1, x + reach); z1 = Math.max(z1, z + reach); }
  return { doc, segs, vn, length: s0, tiers, footN, panels, panelSet, panelLean, runs, runDrop, runNotch, box: [x0, z0, x1, z1], seed };
}

/** Index i with list[i] <= v < list[i + 1] (list ascending; clamped). */
function bisect(list: readonly number[], v: number): number {
  let lo = 0, hi = list.length - 2;
  if (v <= list[0]!) return 0;
  if (v >= list[hi]!) return hi;
  while (lo < hi) {
    const m = (lo + hi + 1) >> 1;
    if (list[m]! <= v) lo = m; else hi = m - 1;
  }
  return lo;
}

/** Riser-frame coordinates of (x, z): s along the top edge (beyond the ends: past them), n signed (+ = low side). */
function frame(c: Compiled, x: number, z: number, out: { s: number; n: number; past: number }): void {
  let best = Infinity, bs = 0, bn = 0, past = 0;
  const last = c.segs.length - 1;
  for (let i = 0; i <= last; i++) {
    const g = c.segs[i]!, rx = x - g.ax, rz = z - g.az;
    let t = rx * g.dx + rz * g.dz;
    let over = 0;
    if (t < 0 && i === 0) { over = -t; } else if (t > g.len && i === last) { over = t - g.len; }
    // the END segments extend straight on past their ends (the riser fades out along its own line, no round end)
    const tc = over > 0 ? t : Math.max(0, Math.min(g.len, t));
    const px = rx - g.dx * tc, pz = rz - g.dz * tc, d = Math.hypot(px, pz);
    if (d < best - 1e-9) {
      best = d;
      bs = g.s0 + tc;
      past = over;
      // sign: the segment's right normal inside its span, the vertex pseudo-normal at a clamped vertex
      let nx = -g.dz, nz = g.dx;
      if (over === 0 && (tc <= 0 || tc >= g.len)) { const v = c.vn[tc <= 0 ? i : i + 1]!; nx = v[0]; nz = v[1]; }
      bn = px * nx + pz * nz >= 0 ? d : -d;
    }
  }
  out.s = bs; out.n = bn; out.past = past;
}

/** Blend weight from the frame: 1 inside the owned band, smooth to 0 over the feather. */
function weightOf(c: Compiled, n: number, past: number): number {
  const d = c.doc, out = Math.max(-d.back - n, n - (c.footN + d.apron), 0);
  if (out >= d.feather || past >= d.feather) return 0;
  return (1 - smoothstep(0, d.feather, out)) * (1 - smoothstep(0, d.feather, past));
}

/** Crest drop at s for tier j (a stepped run, a dropped stone) and the run index. */
function crestDrop(c: Compiled, s: number, j: number): number {
  const i = bisect(c.runs, s + j * 3.7); // each tier's runs offset so the benches do not step in line
  let drop = c.runDrop[i]!;
  const notch = c.runNotch[i];
  if (notch && s + j * 3.7 >= notch[0] && s + j * 3.7 < notch[1]) drop = Math.max(drop, c.doc.rough.drop);
  return drop;
}

/** Panel offset toward the low side (m; a joint's V makes it negative) and lean at s. */
function panelAt(c: Compiled, s: number, out: { set: number; lean: number }): void {
  const r = c.doc.rough, i = bisect(c.panels, s);
  const a = c.panels[i]!, b = c.panels[i + 1]!;
  const edge = Math.min(s - a, b - s);
  // a panel stands PROUD of the line by its own share of `depth`; the joint between two panels is cut back into it
  out.set = c.panelSet[i]! - Math.max(0, r.joint * (1 - edge / r.jointWidth));
  out.lean = c.panelLean[i]!;
}

const scratch = { s: 0, n: 0, past: 0 };
const pscratch = { set: 0, lean: 0 };

/** The riser's own signed field at (s, n, y): negative is rock. Planes only. */
function riserDensity(c: Compiled, s: number, n: number, y: number): number {
  const d = c.doc;
  panelAt(c, s, pscratch);
  const set = pscratch.set, b = Math.max(0, d.batter + pscratch.lean), inv = 1 / Math.sqrt(1 + b * b);
  let best = y - d.foot; // the ground in front: rock below the foot
  for (let j = 0; j < c.tiers.length; j++) {
    const t = c.tiers[j]!;
    // the tier's battered face (its crest edge at n = t.n + set) and its tread / shelf top
    let dt = Math.max(y - t.y, (n - t.n - set - (t.y - y) * b) * inv);
    // the crest: a stepped run or a dropped stone lowers the first `crest` m behind the edge
    const drop = crestDrop(c, s, j);
    if (drop > 0) dt = Math.max(dt, Math.min(y - (t.y - drop), n - t.n - Math.max(0, set) + d.rough.crest)); // from the panel line, never the joint: the crest reaches exactly `crest` m back
    // the tread in front of a tier is the next tier's top: nothing to add (the next tier's solid holds it)
    if (dt < best) best = dt;
  }
  return best;
}

/** Exact column top of the riser at (s, n): the highest y with riserDensity <= 0. */
function riserColumn(c: Compiled, s: number, n: number): number {
  const d = c.doc;
  panelAt(c, s, pscratch);
  const set = pscratch.set, b = Math.max(0, d.batter + pscratch.lean);
  let top = d.foot;
  for (let j = 0; j < c.tiers.length; j++) {
    const t = c.tiers[j]!, over = n - t.n - set;
    // face: y <= t.y - over / b (vertical face: all or nothing)
    let y = over <= 0 ? t.y : b > 1e-9 ? t.y - over / b : -Infinity;
    const drop = crestDrop(c, s, j);
    if (drop > 0 && n - t.n - Math.max(0, set) > -d.rough.crest) y = Math.min(y, t.y - drop);
    if (y > top) top = y;
  }
  return top;
}

export function createDcRisers(docs: readonly DcRiserDoc[], worldSeed: number): DcRisers {
  const list = docs.map((d) => compile(d, worldSeed));
  // a coarse bucket grid over the boxes (risers are few; this keeps the hot path to a lookup)
  const B = 64, grid = new Map<string, number[]>();
  list.forEach((c, k) => {
    for (let bx = Math.floor(c.box[0] / B); bx <= Math.floor(c.box[2] / B); bx++)
      for (let bz = Math.floor(c.box[1] / B); bz <= Math.floor(c.box[3] / B); bz++) {
        const key = bx + "," + bz;
        (grid.get(key) ?? grid.set(key, []).get(key)!).push(k);
      }
  });
  const EMPTY: number[] = [];
  const at = (x: number, z: number) => grid.get(Math.floor(x / B) + "," + Math.floor(z / B)) ?? EMPTY;
  return {
    count: list.length,
    bounds: list.map((c) => c.box),
    doc: (k) => list[k]!.doc,
    weight(x, z) {
      let w = 0;
      for (const k of at(x, z)) {
        const c = list[k]!;
        if (x < c.box[0] || x > c.box[2] || z < c.box[1] || z > c.box[3]) continue;
        frame(c, x, z, scratch);
        w = Math.max(w, weightOf(c, scratch.n, scratch.past));
      }
      return w;
    },
    blend(x, y, z, d) {
      for (const k of at(x, z)) {
        const c = list[k]!;
        if (x < c.box[0] || x > c.box[2] || z < c.box[1] || z > c.box[3]) continue;
        frame(c, x, z, scratch);
        const w = weightOf(c, scratch.n, scratch.past);
        if (w <= 0) continue;
        const r = riserDensity(c, scratch.s, scratch.n, y);
        d = w >= 1 ? r : d + (r - d) * w;
      }
      return d;
    },
    column(x, z, h) {
      for (const k of at(x, z)) {
        const c = list[k]!;
        if (x < c.box[0] || x > c.box[2] || z < c.box[1] || z > c.box[3]) continue;
        frame(c, x, z, scratch);
        const w = weightOf(c, scratch.n, scratch.past);
        if (w <= 0) continue;
        const r = riserColumn(c, scratch.s, scratch.n);
        h = w >= 1 ? r : h + (r - h) * w;
      }
      return h;
    },
    reaches(x0, z0, x1, z1, margin = 0) {
      return list.some((c) => c.box[2] + margin >= x0 && c.box[0] - margin <= x1 && c.box[3] + margin >= z0 && c.box[1] - margin <= z1);
    },
    span(x0, z0, x1, z1) {
      let min = Infinity, max = -Infinity;
      for (const c of list) {
        if (c.box[2] < x0 || c.box[0] > x1 || c.box[3] < z0 || c.box[1] > z1) continue;
        min = Math.min(min, c.doc.foot - 2);
        max = Math.max(max, c.doc.top + 2);
      }
      return min === Infinity ? null : { min, max };
    },
    paint(x, y, z, steep) {
      let best: { riser: number; band: "face" | "foot" | "top"; amount: number } | null = null;
      for (const k of at(x, z)) {
        const c = list[k]!;
        if (x < c.box[0] || x > c.box[2] || z < c.box[1] || z > c.box[3]) continue;
        frame(c, x, z, scratch);
        const w = weightOf(c, scratch.n, scratch.past);
        // the face only: inside the band between the top edge and the foot, on steep ground
        if (w <= 0 || scratch.n < -c.doc.rough.crest - 0.5 || scratch.n > c.footN + 0.5) continue;
        const amount = w * smoothstep(0.35, 0.6, steep);
        if (amount <= 0 || (best && best.amount >= amount)) continue;
        const band = c.doc.surfaces.band;
        let kind: "face" | "foot" | "top" = "face";
        for (const t of c.tiers) {
          if (y > t.y + 0.25 || y < t.y - t.h - 0.25) continue;
          if (y - (t.y - t.h) < band) kind = "foot";
          else if (t.y - y < band) kind = "top";
        }
        best = { riser: k, band: kind, amount };
      }
      return best;
    },
  };
}

/** Feature id for the recipe undo / derived-feature conventions. */
export const dcRiserFeatureId = (id: string): string => `dcr-${id}`;

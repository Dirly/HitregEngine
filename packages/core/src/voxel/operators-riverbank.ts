/**
 * `riverbank` — natural banks for a stretch of river that reads as a dug canal (a straight V trench with the same bank
 * on both sides). One side is a STEEP ROCK SHOULDER rising from the water's edge (steeper than 45 degrees, so the zone's
 * cliff tile draws it), the other a LOW SHELVING SHELF just above the water that climbs back to the old bank; the sides
 * swap where `sides` says, blended over `swapLength`. At each `breaks` station (a riffle) the shoulder drops away and a
 * boulder cluster crosses the margins, so the bank lines are broken where the water steps. Boulders (catalogued rock
 * scatter rules) stand along the channel margins, half in the water.
 *
 * The WATER is never touched: the operator reads the bank edge from the ground at each station against the given water
 * `level`, leaves `edgeKeep` metres beyond it alone, and its height patch is `afterRivers` (the river solve never sees
 * it, so levels, beds and the curtain stay where WATER put them). `keep` discs (bridge ends, a structure on the bank)
 * are left untouched and get no boulders.
 *
 * Compiles to `op:<id>:banks` (heightPatches, masked, afterRivers) and `op:<id>:rocks` (rockSets).
 */
import { z } from "zod";
import { FINE_MIN, registerOperator, type OperatorFieldReader, type OperatorOutput } from "./operator-registry.js";
import { hashUnit, perlin2 } from "./noise.js";

const xz = z.tuple([z.number().finite(), z.number().finite()]);

export const riverbankOperatorSchema = z
  .object({
    line: z.array(xz).min(2).describe("The river's centreline over the stretch, in FLOW order (downstream last), world [x, z]."),
    level: z.array(z.number().finite()).min(2).describe("Water surface Y at each `line` point (the solved levels: read them, never guess). Same length as `line`."),
    sides: z
      .array(z.object({ at: z.number().min(0).describe("Metres along `line` where this arrangement starts."), steep: z.enum(["left", "right"]).describe("Which bank is the rock shoulder (left/right looking DOWNSTREAM); the other shelves.") }))
      .min(1)
      .describe("Which bank is steep, from where: [{ at: 0, steep: 'left' }, { at: 140, steep: 'right' }] swaps once."),
    swapLength: z.number().min(FINE_MIN).max(80).default(24).describe("Metres over which a side swap blends."),
    steep: z
      .object({
        rise: z.number().min(1).max(20).default(6).describe("Metres the shoulder's crest stands above the old bank one shoulder-width back from the water."),
        width: z.number().min(FINE_MIN).max(40).default(8).describe("Width of the shoulder's top before it falls back to the ground."),
        slope: z.number().min(0.6).max(1.5).default(1.15).describe("Rise/run of its water-side face (1.15 = 49 degrees: draws as cliff and stays under the lips gate's 1.6 between 2 m samples with the crease)."),
        back: z.number().min(0.2).max(1).default(0.6).describe("Rise/run of its land-side fall back to the ground."),
      })
      .prefault({}),
    shelf: z
      .object({
        above: z.number().min(0.3).max(3).default(0.7).describe("Shelf height above the water, metres."),
        width: z.number().min(FINE_MIN).max(40).default(10).describe("Shelf width from the edge kept untouched."),
        back: z.number().min(0.2).max(1.4).default(0.7).describe("Rise/run of the cut back up to the old bank behind the shelf."),
        maxCut: z.number().min(0.5).max(12).default(4).describe("Deepest cut into the old bank, metres: past it the shelf's back slope follows the hill (a steep hill is not dug away to a shelf)."),
        reach: z.number().min(4).max(60).default(18).describe("Metres past the shelf over which the cut fades out to the old ground."),
      })
      .prefault({}),
    breaks: z.array(z.number().min(0)).default([]).describe("Metres along `line` of the riffles: the shoulder drops away there and a boulder cluster crosses the margins."),
    breakLength: z.number().min(FINE_MIN).max(60).default(16).describe("Length of a break, metres."),
    edgeKeep: z.number().min(0.5).max(6).default(1.5).describe("Metres beyond the water's edge left untouched (the bank under the water line, the river's own carve)."),
    reach: z.number().min(10).max(60).default(30).describe("Furthest a bank edge is searched for from the centreline, metres."),
    keep: z.array(z.tuple([z.number(), z.number(), z.number().positive()])).default([]).describe("Discs [x, z, r] left untouched (bridge ends, structures on the bank); no boulders in them."),
    boulders: z
      .union([
        z.literal(false),
        z.object({
          rules: z.tuple([z.string(), z.string()]).default(["rock-medium", "rock-big"]).describe("Catalogued rock scatter rule ids [smaller, larger]."),
          every: z.number().min(4).max(60).default(11).describe("Mean spacing of margin boulders along each bank, metres."),
          scale: z.tuple([z.number().positive(), z.number().positive()]).default([0.9, 1.5]),
          riffle: z.number().int().min(0).max(20).default(7).describe("Boulders in each break's cluster."),
        }),
      ])
      .default({ rules: ["rock-medium", "rock-big"], every: 11, scale: [0.9, 1.5], riffle: 7 }),
    seed: z.number().int().default(1),
  })
  .refine((p) => p.level.length === p.line.length, { message: "`level` needs one value per `line` point" });
export type RiverbankOperatorParams = z.infer<typeof riverbankOperatorSchema>;

type V2 = [number, number];
const r2 = (v: number) => Math.round(v * 100) / 100;
const smooth = (t: number) => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t));
/** Metres over which a fill or cut is blended into the ground it meets (smooth max/min). */
const CREASE = 2.5;
/** Metres between stations. */
const STATION = 2;

interface Station { s: number; x: number; z: number; tx: number; tz: number; nx: number; nz: number; level: number; edge: [number, number] }

/** Stations every `step` m along the line: position, tangent, left normal, water level, bank edges (left, right). */
export function riverbankStations(p: RiverbankOperatorParams, reader: OperatorFieldReader, step = 2): Station[] {
  const seg: { ax: number; az: number; tx: number; tz: number; L: number; s0: number; i: number }[] = [];
  let acc = 0;
  for (let i = 0; i < p.line.length - 1; i++) {
    const [ax, az] = p.line[i]!, [bx, bz] = p.line[i + 1]!;
    const L = Math.hypot(bx - ax, bz - az);
    if (L < 1e-6) continue;
    seg.push({ ax, az, tx: (bx - ax) / L, tz: (bz - az) / L, L, s0: acc, i });
    acc += L;
  }
  const out: Station[] = [];
  let k = 0;
  for (let s = 0; s <= acc + 1e-6; s += step) {
    while (k < seg.length - 1 && s > seg[k]!.s0 + seg[k]!.L) k++;
    const g = seg[k]!;
    const d = Math.min(g.L, Math.max(0, s - g.s0)), q = d / g.L;
    const x = g.ax + g.tx * d, z = g.az + g.tz * d, level = p.level[g.i]! + (p.level[g.i + 1]! - p.level[g.i]!) * q;
    // left normal looking downstream (x east, z south): facing north (0,-1) the left is west (-1,0)
    const nx = g.tz, nz = -g.tx;
    const edge = [1, -1].map((sgn) => {
      for (let u = 0.5; u <= p.reach; u += 0.5) if (reader.height(x + nx * u * sgn, z + nz * u * sgn) > level + 0.25) return u;
      return p.reach;
    }) as [number, number];
    out.push({ s, x, z, tx: g.tx, tz: g.tz, nx, nz, level, edge });
  }
  return out;
}

function steepLeftAt(p: RiverbankOperatorParams, s: number): number {
  // 1 = the left bank is the shoulder, 0 = the right; blended over swapLength centred on each switch
  const sides = [...p.sides].sort((a, b) => a.at - b.at);
  let v = sides[0]!.steep === "left" ? 1 : 0;
  for (let k = 1; k < sides.length; k++) {
    const to = sides[k]!.steep === "left" ? 1 : 0;
    const t = smooth((s - (sides[k]!.at - p.swapLength / 2)) / p.swapLength);
    v = v + (to - v) * t;
  }
  return v;
}

/** 1 away from every break, falling to 0 at a break's centre. */
function unbroken(p: RiverbankOperatorParams, s: number): number {
  let v = 1;
  for (const b of p.breaks) v = Math.min(v, smooth((Math.abs(s - b) - p.breakLength / 2) / 8));
  return v;
}

function compileRiverbank(p: RiverbankOperatorParams, reader: OperatorFieldReader, ctx: { id: string }): OperatorOutput {
  const who = `riverbank "${ctx.id}"`;
  if (p.boulders && reader.scatterRules) for (const r of p.boulders.rules) if (!reader.scatterRules.includes(r)) throw new Error(`${who}: boulder rule "${r}" is not a scatter rule of this world`);
  const st = riverbankStations(p, reader, STATION);
  if (st.length < 4) throw new Error(`${who}: the line is shorter than ${FINE_MIN} m`);
  const total = st[st.length - 1]!.s;
  const seed = Math.abs((reader.seed * 7919 + p.seed * 104729 + ctx.id.length * 31) | 0) % 1000 + 1;
  const pad = p.reach + Math.max(p.steep.rise / p.steep.slope + p.steep.width + 30, p.shelf.width + 30);
  let bx0 = Infinity, bz0 = Infinity, bx1 = -Infinity, bz1 = -Infinity;
  for (const s of st) { bx0 = Math.min(bx0, s.x); bx1 = Math.max(bx1, s.x); bz0 = Math.min(bz0, s.z); bz1 = Math.max(bz1, s.z); }
  bx0 -= pad; bz0 -= pad; bx1 += pad; bz1 += pad;
  const step = Math.max(1, Math.ceil(Math.max(bx1 - bx0, bz1 - bz0) / 1024));
  const cols = Math.ceil((bx1 - bx0) / step) + 1, rows = Math.ceil((bz1 - bz0) / step) + 1;
  const heights = new Array<number>(cols * rows), weights = new Array<number>(cols * rows);
  const kept = (x: number, z: number) => p.keep.some(([kx, kz, kr]) => Math.hypot(x - kx, z - kz) < kr);
  const keepFade = (x: number, z: number) => {
    let v = 1;
    for (const [kx, kz, kr] of p.keep) v = Math.min(v, smooth((Math.hypot(x - kx, z - kz) - kr) / 8));
    return v;
  };
  // per station and side: the water's-edge distance, the bank top there and a shoulder-width back, smoothed over +-4 stations
  const n = st.length, edgeS = new Float64Array(n * 2), baseS = new Float64Array(n * 2), backS = new Float64Array(n * 2);
  const raw = { e: new Float64Array(n * 2), b: new Float64Array(n * 2), k: new Float64Array(n * 2), f: new Float64Array(n * 2) };
  const footS = new Float64Array(n * 2);
  for (let q = 0; q < n; q++) for (const sd of [0, 1]) {
    const S = st[q]!, sg = sd === 0 ? 1 : -1, e = S.edge[sd]!;
    const at = (uu: number) => reader.height(S.x + S.nx * (e + p.edgeKeep + uu) * sg, S.z + S.nz * (e + p.edgeKeep + uu) * sg);
    raw.e[q * 2 + sd] = e; raw.b[q * 2 + sd] = Math.max(S.level + 0.3, at(0)); raw.k[q * 2 + sd] = at(p.steep.width);
    // the foot of the hill behind the bank: the first place the old ground climbs steeper than 1:1 (a shelf is never dug into it)
    let foot = 80;
    for (let uu = 1; uu < 80; uu += 1) if ((at(uu + 1) - at(uu - 1)) / 2 > 1) { foot = uu; break; }
    raw.f[q * 2 + sd] = foot;
  }
  for (let q = 0; q < n; q++) for (const sd of [0, 1]) {
    let se = 0, sb = 0, sk = 0, c = 0;
    for (let d = -4; d <= 4; d++) { const r = Math.max(0, Math.min(n - 1, q + d)); se += raw.e[r * 2 + sd]!; sb += raw.b[r * 2 + sd]!; sk += raw.k[r * 2 + sd]!; c++; }
    // the foot is averaged wider (+-8 stations, capped at the cut's reach): it can jump tens of metres between stations
    let sf = 0, cf = 0;
    for (let d = -8; d <= 8; d++) { const r = Math.max(0, Math.min(n - 1, q + d)); sf += Math.min(raw.f[r * 2 + sd]!, p.shelf.width + p.shelf.reach); cf++; }
    footS[q * 2 + sd] = sf / cf;
    edgeS[q * 2 + sd] = se / c; baseS[q * 2 + sd] = Math.max(st[q]!.level + 0.3, sb / c); backS[q * 2 + sd] = sk / c;
  }
  let maxFill = 0, maxCut = 0, touched = 0;
  for (let j = 0; j < rows; j++) for (let i = 0; i < cols; i++) {
    const x = bx0 + i * step, z = bz0 + j * step, k = j * cols + i;
    const g = reader.height(x, z);
    heights[k] = r2(g);
    weights[k] = 0;
    // nearest station
    let best = -1, bd = Infinity;
    for (let q = 0; q < st.length; q++) { const d = (x - st[q]!.x) ** 2 + (z - st[q]!.z) ** 2; if (d < bd) { bd = d; best = q; } }
    const S = st[best]!;
    const along = (x - S.x) * S.tx + (z - S.z) * S.tz;
    if ((best === 0 && along < -1) || (best === st.length - 1 && along > 1)) continue; // past the stretch's ends
    const lat = (x - S.x) * S.nx + (z - S.z) * S.nz; // + = left
    const left = lat >= 0;
    // the bank's measures between the two stations either side, smoothed along the bank: a per-station jump
    // (the edge found 0.5 m further out, a notch in the old bank) would draw as a wall across the slope
    const fq = Math.max(0, Math.min(st.length - 1, best + along / STATION));
    const q0 = Math.floor(fq), q1 = Math.min(st.length - 1, q0 + 1), w = fq - q0;
    const sd = left ? 0 : 1;
    const lerp = (arr: Float64Array) => arr[q0 * 2 + sd]! * (1 - w) + arr[q1 * 2 + sd]! * w;
    const e = lerp(edgeS);
    const u = Math.abs(lat) - e - p.edgeKeep;
    if (u < 0) continue;
    const s = S.s + along;
    const ub = unbroken(p, s);
    const steepness = left ? steepLeftAt(p, s) : 1 - steepLeftAt(p, s);
    // irregular lines: the shoulder's rise and width wander along the bank
    const n1 = perlin2(s / 37 + (left ? 3.1 : 7.7), seed * 0.13, seed), n2 = perlin2(s / 23 + (left ? 11.3 : 5.9), seed * 0.29, seed);
    const level = S.level;
    // the face starts from the ground right at its foot (this column's own, not the smoothed bank top: the fade-in
    // across a 2 m band would otherwise lift the difference as a wall)
    const sgn = left ? 1 : -1;
    const base = Math.max(level + 0.3, reader.height(x - S.nx * u * sgn, z - S.nz * u * sgn));
    // where the old bank already climbs steeply (a natural cliff) the shoulder adds nothing: heaping rock on its top
    // would only make the cliff taller than the lattice can draw
    const oldSlope = (lerp(backS) - lerp(baseS)) / p.steep.width;
    const gain = 1 - smooth((oldSlope - 1) / 0.4);
    const rise = p.steep.rise * (1 + 0.35 * n1) * ub * gain;
    const width = p.steep.width * (1 + 0.4 * n2);
    // the crest stands `rise` over the old bank a shoulder-width back; the face climbs to it from the water's edge
    const crest = Math.max(base, lerp(backS)) + rise;
    const faceRun = (crest - base) / p.steep.slope;
    let shoulder: number;
    if (u <= faceRun) shoulder = base + p.steep.slope * u;
    else if (u <= faceRun + width) shoulder = crest;
    else shoulder = crest - p.steep.back * (u - faceRun - width);
    const shelfTop = level + p.shelf.above;
    const shelfW = p.shelf.width * (1 + 0.3 * n2);
    const shelf = u <= shelfW ? shelfTop : shelfTop + p.shelf.back * (u - shelfW);
    // fill only for the shoulder (smooth max), cut only for the shelf (smooth min)
    const fillT = 0.5 * (g + shoulder + Math.sqrt((g - shoulder) ** 2 + CREASE * CREASE));
    // the cut fades out by the hill's foot, never deeper than 0.25 m per metre of gentle ground before it (a cut into
    // the toe of a steep hill would only steepen it past what the lattice draws); a bank that is already a cliff
    // gets no shelf at all: that side stays steep
    const foot = lerp(footS);
    const run = Math.max(0, Math.min(p.shelf.reach, foot - shelfW));
    const cutDepth = Math.min(p.shelf.maxCut, 0.25 * run) * gain;
    const cutFade = run > 0 ? 1 - smooth((u - shelfW) / run) : 0;
    const shelfC = Math.max(shelf, g - cutDepth * cutFade);
    const cutT = 0.5 * (g + shelfC - Math.sqrt((g - shelfC) ** 2 + CREASE * CREASE));
    let t = cutT + (fillT - cutT) * steepness;
    // fade in from the kept edge band over 5 m (the smooth max lifts ~1.2 m where shoulder and ground meet), and out at the stretch's ends and round kept discs
    const endFade = smooth(Math.min(s, total - s) / 12);
    const f = smooth(u / 5) * endFade * keepFade(x, z);
    if (kept(x, z)) continue;
    t = g + (t - g) * f;
    const d = t - g;
    if (Math.abs(d) < 0.05) continue;
    heights[k] = r2(t);
    weights[k] = Math.round(Math.min(1, (Math.abs(d) - 0.05) / 0.6) * 1000) / 1000;
    maxFill = Math.max(maxFill, d);
    maxCut = Math.max(maxCut, -d);
    touched++;
  }
  if (touched === 0) throw new Error(`${who}: nothing to shape (check \`line\` and \`level\`: no bank found within ${p.reach} m)`);
  const patch = {
    id: "banks", origin: [r2(bx0), r2(bz0)], size: [(cols - 1) * step, (rows - 1) * step], columns: cols, rows,
    heights, weights, blend: 4, feather: 6, filter: Math.max(step, reader.voxelSize), afterRivers: true,
  };
  // boulders along the margins (straddling the water's edge) and a cluster across each break
  const rocks: { rule: string; at: V2; yaw: number; scale: number }[] = [];
  if (p.boulders) {
    const b = p.boulders;
    const place = (S: Station, side: 1 | -1, off: number, key: number, big: boolean) => {
      const e = S.edge[side > 0 ? 0 : 1];
      const x = S.x + S.nx * side * (e + off), z = S.z + S.nz * side * (e + off);
      if (kept(x, z)) return;
      const h = (c: number) => hashUnit(key, c, side + 3, seed);
      const scale = b.scale[0] + (b.scale[1] - b.scale[0]) * h(1);
      rocks.push({ rule: big || h(2) > 0.55 ? b.rules[1] : b.rules[0], at: [r2(x), r2(z)], yaw: r2(h(3) * Math.PI * 2), scale: r2(scale) });
    };
    let k = 0;
    for (const side of [1, -1] as const) {
      for (let s = b.every * hashUnit(side + 5, 0, 1, seed); s < total; s += b.every * (0.6 + 0.8 * hashUnit(k, side, 2, seed)), k++) {
        const S = st[Math.min(st.length - 1, Math.round(s / 2))]!;
        place(S, side, -1.5 + 3 * hashUnit(k, side, 4, seed), k, false);
      }
    }
    for (const [bi, br] of p.breaks.entries()) {
      for (let n = 0; n < b.riffle; n++) {
        const s = br + (hashUnit(bi, n, 7, seed) - 0.5) * p.breakLength;
        const S = st[Math.max(0, Math.min(st.length - 1, Math.round(s / 2)))]!;
        place(S, n % 2 ? 1 : -1, -3 + 4.5 * hashUnit(bi, n, 8, seed), 1000 + bi * 50 + n, true);
      }
    }
  }
  const features: OperatorOutput["features"] = { heightPatches: [patch] };
  if (rocks.length) features.rockSets = [{ id: "rocks", rocks }];
  return {
    features,
    report: {
      length: r2(total), stations: st.length, raster: `${cols}x${rows} @ ${step} m`, maxFill: r2(maxFill), maxCut: r2(maxCut), touched,
      edges: { minLeft: r2(Math.min(...st.map((s) => s.edge[0]))), maxLeft: r2(Math.max(...st.map((s) => s.edge[0]))), minRight: r2(Math.min(...st.map((s) => s.edge[1]))), maxRight: r2(Math.max(...st.map((s) => s.edge[1]))) },
      boulders: rocks.length,
    },
  };
}

function riverbankBounds(p: RiverbankOperatorParams) {
  const pad = p.reach + 60;
  const xs = p.line.map((q) => q[0]), zs = p.line.map((q) => q[1]);
  return { x0: Math.min(...xs) - pad, z0: Math.min(...zs) - pad, x1: Math.max(...xs) + pad, z1: Math.max(...zs) + pad };
}

registerOperator<RiverbankOperatorParams>({
  op: "riverbank",
  description:
    "Natural banks for a river stretch that reads as a dug canal: one side a steep rock shoulder rising from the water (> 45 degrees, draws as the zone's cliff), the other a low shelving shelf just above the water climbing back to the old bank; the sides swap along the stretch, the shoulder drops away at each riffle (`breaks`) where a boulder cluster crosses the margins, catalogued boulders stand along the margins. The water is never touched (afterRivers patch, bank edges read against the given levels). Compiles to `op:<id>:banks` (height patch) + `op:<id>:rocks` (rockSets).",
  schema: riverbankOperatorSchema,
  compile: compileRiverbank,
  bounds: riverbankBounds,
  outline: (p) => [p.line.map((q) => [q[0], q[1]] as [number, number])],
});

/**
 * `island` — raise a small island out of a lake (or the sea): a beach shelf at the waterline, a gentle walkable top, an
 * optional rock knoll at its core, its underwater flank seated in the bed, and an optional submerged SHOAL (a sunken
 * causeway) toward a shore for stepping stones to stand on. Owner ruling 2026-11-02 (the Weeping Stair moved off the
 * Bell Strand land gate onto an island in lake-1: "slap it in the middle of the lake on a small island").
 *
 * Built on raise-only masked height patches over the lake bed the field already carved (height patches apply after
 * the lake, so the island is ground the water sheet hides under: the sheet is clipped against the terrain). Nothing is
 * lowered, so the lake keeps its one still level and its bed round the island.
 *
 * Compiles to `heightPatches` `op:<id>:ground` (+ `op:<id>:shoal`) and `groundPaints` `op:<id>:shore` (the beach band),
 * `op:<id>:core` (the knoll's rock, faces included) and `op:<id>:top` when asked.
 *
 * It REFUSES (throws, with the reason) an island whose centre is not in water at least 1.5 m deep, or whose waterline
 * would run onto ground already above the water (a peninsula is not an island: move it out or shrink it).
 */
import { z } from "zod";
import { registerOperator, type OperatorBounds, type OperatorFieldReader, type OperatorOutput, type OperatorPiece } from "./operator-registry.js";
import { requireSurface } from "./operators-paint.js";

const xz = z.tuple([z.number().finite(), z.number().finite()]);

export const islandOperatorSchema = z.object({
  center: xz.describe("Island centre [x, z], in open water (at least 1.5 m deep there)."),
  waterY: z.number().finite().describe("The water level the island stands out of: the lake's `features.lakes[].waterY` (or the sea level). The beach meets it."),
  radius: z.number().min(8).max(60).default(16).describe("Waterline radius across the island, metres (the short axis when `stretch` > 1). 12-20 = a small island 25-40 m across."),
  stretch: z.number().min(1).max(2.5).default(1).describe("Long-axis / short-axis ratio of the waterline ellipse (1 = round). The long axis runs along `yaw`."),
  yaw: z.number().min(-360).max(360).default(0).describe("Degrees of the long axis from +x toward +z (0 = east-west, 90 = north-south)."),
  rise: z.number().min(1).max(10).default(3).describe("Height of the island top over `waterY`, metres."),
  shore: z.number().min(3).max(14).default(5).describe("Width of the beach band inland from the waterline, metres: it climbs `beach` over this run, then the shoulder rises to the top."),
  beach: z.number().min(0.2).max(1.5).default(0.6).describe("Height the beach climbs over its band, metres (0.6 over 5 m = a 7 degree beach)."),
  shelf: z.number().min(0).max(10).default(3).describe("Metres the beach runs on UNDER the water at its own slope before the flank drops: the shallows a swimmer wades out of."),
  slope: z.number().min(0.1).max(0.55).default(0.3).describe("Steepest rise/run of the shoulder from the beach top to the island top (walkable is <= 0.6; 0.3 = 17 degrees)."),
  flank: z.number().min(0.3).max(1.4).default(0.6).describe("Rise/run of the underwater flank from the shelf down to the bed (where it meets the bed it stops: the island is seated, never perched)."),
  swell: z.number().min(0).max(1.5).default(0.4).describe("Metres of low ground swell over the top (deterministic noise), so it is never a flat plate."),
  edgeNoise: z.number().min(0).max(8).default(2.5).describe("Metres the waterline wanders in and out round the island (a few lobes and bays), so it never reads as a drawn ellipse."),
  core: z
    .object({
      at: xz.default([0, 0]).describe("Knoll centre as an offset [dx, dz] from `center`, metres (world axes)."),
      radius: z.number().min(6).max(40).describe("Knoll radius at its foot, metres (>= 6: the 6 m rule; a 2 m lattice draws nothing finer)."),
      rise: z.number().min(1).max(14).describe("Knoll height over the island top, metres."),
      slope: z.number().min(0.6).max(1.6).default(1).describe("Rise/run of the knoll's sides (>= 0.6 reads as rock, <= 1.6 so the 2 m lattice draws it without a zig-zag)."),
      top: z.number().min(0).max(0.9).default(0.5).describe("Share of the knoll radius that is its (gently domed) top, inside the sides."),
    })
    .optional()
    .describe("A rock KNOLL at the island's core: the mass a stair-well or a door is cut into (a cave needs a face or cover over its roof). Omit = no knoll."),
  shoal: z
    .object({
      to: xz.describe("Where the shoal ends [x, z]: on the shore (the stepping stones' landing)."),
      width: z.number().min(6).max(24).default(8).describe("Shoal crest width, metres (>= 6: the 6 m rule)."),
      depth: z.number().min(0.2).max(2.5).default(0.7).describe("Metres the crest stays UNDER `waterY` (0.5-0.8 = wading water; stepping stones stand on it)."),
      wobble: z.number().min(0).max(6).default(1.5).describe("Metres the crest line wanders off the straight line."),
    })
    .optional()
    .describe("A submerged shoal (a sunken causeway) from the island toward a shore: raise-only ground under the water, never above it, for stepping stones or a wade. Omit = open water all round."),
  shoreSurface: z.string().min(1).default("sand").describe("Palette surface of the beach band (waterline to the beach top, and the shallows under the water)."),
  coreSurface: z.string().min(1).optional().describe("Palette surface painted on the knoll (sides and top, faces included): the zone's rock, e.g. `redrock`. Omit = the biome decides."),
  topSurface: z.string().min(1).optional().describe("Palette surface for the island top above the beach. Omit = the biome decides."),
  seed: z.number().int().default(1).describe("Shoreline / swell seed (combined with the world seed)."),
});
export type IslandOperatorParams = z.infer<typeof islandOperatorSchema>;

const r2 = (v: number) => Math.round(v * 100) / 100;
function smoothstep(a: number, b: number, x: number): number {
  if (b <= a) return x >= b ? 1 : 0;
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}
/** Deterministic 0..1 from two ints. */
function hash01(seed: number, k: number): number {
  let h = (seed ^ Math.imul(k + 0x9e3779b9, 0x85ebca6b)) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35) >>> 0;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** The island's shape in its own frame: waterline radius along a world bearing, and the knoll. */
export interface IslandShape {
  /** Metres inside the (wobbled) waterline at world (x, z): > 0 dry side, < 0 water side. */
  inside(x: number, z: number): number;
  /** The island's long and short waterline radii, metres. */
  a: number;
  b: number;
  /** The farthest the waterline reaches from the centre (wobble included). */
  reach: number;
}

export function islandShape(p: IslandOperatorParams): IslandShape {
  // the shoreline depends on the doc alone (`seed`), so the preview outline (no reader) draws the waterline that compiles
  const seed = (p.seed * 104729 + 7919) | 0;
  const a = p.radius * p.stretch, b = p.radius, yaw = (p.yaw * Math.PI) / 180, c = Math.cos(yaw), s = Math.sin(yaw);
  // lobes: three harmonics of the bearing (2..4 per turn, amplitude falling as 1/k so the shoreline bends gently), seeded
  // amplitude and phase, normalised to +-1
  const harm = [2, 3, 4].map((k, i) => ({ k, amp: (0.5 + 0.5 * hash01(seed, i * 2)) * (2 / k), ph: hash01(seed, i * 2 + 1) * Math.PI * 2 }));
  const ampSum = harm.reduce((m, h) => m + h.amp, 0);
  const wob = (th: number) => (harm.reduce((m, h) => m + h.amp * Math.sin(h.k * th + h.ph), 0) / ampSum) * p.edgeNoise;
  return {
    a, b, reach: a + p.edgeNoise,
    inside(x, z) {
      const dx = x - p.center[0], dz = z - p.center[1];
      const u = dx * c + dz * s, v = -dx * s + dz * c;
      const d = Math.hypot(u, v);
      const th = Math.atan2(v, u);
      // waterline radius along this bearing (the ellipse's polar radius), wobbled. The wobble grows with the distance
      // from the centre (d / rr): a bearing's lobe is a shoreline bay, never a crease across the middle of the top.
      const rr = 1 / Math.sqrt((Math.cos(th) / a) ** 2 + (Math.sin(th) / b) ** 2);
      return rr + wob(th) * Math.min(1, d / rr) - d;
    },
  };
}

/** The island ground height for `s` metres inside the waterline (before the knoll and the swell). */
function profile(p: IslandOperatorParams, s: number): number {
  const beachSlope = p.beach / p.shore;
  if (s <= 0) {
    // the beach runs on under the water for `shelf`, then the flank drops to the bed
    if (s >= -p.shelf) return p.waterY + beachSlope * s;
    return p.waterY - beachSlope * p.shelf - p.flank * (-s - p.shelf);
  }
  if (s <= p.shore) return p.waterY + beachSlope * s;
  // shoulder: climbs at `slope`, eased in and out over EASE metres each end (no kink at the beach top or the top edge)
  return p.waterY + p.beach + softRamp(Math.max(0, p.rise - p.beach), p.slope, s - p.shore);
}

const EASE = 3;
/** Height gained `u` metres into a ramp that climbs `rise` at grade `g`, accelerating from flat over EASE m and easing back to flat. */
function softRamp(rise: number, g: number, u: number): number {
  if (rise <= 0 || u <= 0) return 0;
  const L = rise / g + EASE;
  if (u >= L) return rise;
  const a = (v: number) => (g * v * v) / (2 * EASE);
  if (u < EASE) return a(u);
  if (u > L - EASE) return rise - a(L - u);
  return a(EASE) + g * (u - EASE);
}

/** Metres the knoll stands over the island profile at (x, z): 0 past its foot, `rise` on its crown. */
function knoll(p: IslandOperatorParams, x: number, z: number): number {
  const k = p.core!;
  const cx = p.center[0] + k.at[0], cz = p.center[1] + k.at[1];
  const d = Math.hypot(x - cx, z - cz);
  const inner = k.radius * k.top, side = k.radius - inner;
  // side run that keeps the steepest grade at `slope` (smoothstep peak 1.5 x mean) — never narrower than the band
  const run = Math.min(side, (1.5 * k.rise) / k.slope);
  const t = 1 - smoothstep(k.radius - run, k.radius, d); // 1 inside the top, 0 at the foot
  const dome = d < inner ? 0.15 * k.rise * (1 - (d / Math.max(inner, 1e-6)) ** 2) : 0;
  return k.rise * 0.85 * t + dome * t;
}

/** Island bounds: the waterline reach plus the flank run to the deepest bed it may meet, plus the shoal. */
export function islandBounds(p: IslandOperatorParams, depth = 12): OperatorBounds {
  const reach = p.radius * p.stretch + p.edgeNoise + p.shelf + depth / p.flank + 4;
  let x0 = p.center[0] - reach, z0 = p.center[1] - reach, x1 = p.center[0] + reach, z1 = p.center[1] + reach;
  if (p.shoal) {
    const pad = p.shoal.width / 2 + p.shoal.wobble + depth / p.flank + 4;
    x0 = Math.min(x0, p.shoal.to[0] - pad); z0 = Math.min(z0, p.shoal.to[1] - pad);
    x1 = Math.max(x1, p.shoal.to[0] + pad); z1 = Math.max(z1, p.shoal.to[1] + pad);
  }
  return { x0, z0, x1, z1 };
}

function compileIsland(p: IslandOperatorParams, reader: OperatorFieldReader, ctx: { id: string }): OperatorOutput {
  const what = `island "${ctx.id}" refused`;
  for (const sname of [p.shoreSurface, p.coreSurface, p.topSurface]) if (sname) requireSurface(reader, sname, `island "${ctx.id}"`);
  const bed0 = reader.height(p.center[0], p.center[1]);
  if (bed0 > p.waterY - 1.5) throw new Error(`${what}: the ground at the centre [${p.center.map(Math.round).join(", ")}] stands at ${r2(bed0)} m, ${r2(p.waterY - bed0)} m under the water at ${p.waterY} (an island needs >= 1.5 m of water there: move it out into the lake)`);
  const shape = islandShape(p);
  const g = Math.max(1, reader.voxelSize);
  // the deepest bed the flank may meet: sample a ring just past the waterline
  let deepest = bed0;
  for (let i = 0; i < 48; i++) {
    const th = (i / 48) * Math.PI * 2;
    for (const f of [0.5, 1, 1.5]) deepest = Math.min(deepest, reader.height(p.center[0] + Math.cos(th) * shape.reach * f, p.center[1] + Math.sin(th) * shape.reach * f));
  }
  const depth = Math.max(1.5, p.waterY - deepest);
  const ib = islandBounds({ ...p, shoal: undefined }, depth);
  const x0 = Math.floor(ib.x0 / g) * g, z0 = Math.floor(ib.z0 / g) * g;
  const cols = Math.ceil((ib.x1 - x0) / g) + 1, rows = Math.ceil((ib.z1 - z0) / g) + 1;
  const topY = p.waterY + p.rise;
  const sseed = (reader.seed * 7919 + p.seed * 104729) | 0;
  const ph = [hash01(sseed, 91), hash01(sseed, 92), hash01(sseed, 93)].map((v) => v * Math.PI * 2);
  const swell = (x: number, z: number) => p.swell * 0.5 * (Math.sin(x / 9.7 + ph[0]!) * Math.cos(z / 11.3 + ph[1]!) + 0.6 * Math.sin((x + z) / 6.1 + ph[2]!)) / 1.6;
  const heights: number[] = new Array(cols * rows);
  const weights: number[] = new Array(cols * rows);
  let dryCells = 0, steepDry = 0, maxDrySlope = 0, peak = -Infinity, landHit: [number, number] | null = null;
  const H = (x: number, z: number): number => {
    const s = shape.inside(x, z);
    let y = profile(p, s);
    if (s > p.shore) y += swell(x, z) * smoothstep(p.shore, p.shore + 6, s);
    if (p.core) y += knoll(p, x, z);
    return y;
  };
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
    const x = x0 + c * g, z = z0 + r * g, i = r * cols + c;
    const s = shape.inside(x, z);
    const y = H(x, z);
    const under = reader.height(x, z);
    // a peninsula, not an island: dry ground inside the waterline band before the island is raised
    if (s > -2 && under >= p.waterY && !landHit) landHit = [Math.round(x), Math.round(z)];
    heights[i] = r2(y);
    // the patch only takes where it lifts the bed: past the flank toe it fades out (raise-only keeps the bed anyway)
    weights[i] = y > under - 0.05 ? 1 : 0;
    if (y > p.waterY) {
      dryCells++;
      const gx = (H(x + 1, z) - H(x - 1, z)) / 2, gz = (H(x, z + 1) - H(x, z - 1)) / 2;
      const sl = Math.hypot(gx, gz);
      maxDrySlope = Math.max(maxDrySlope, sl);
      if (sl > 0.6) steepDry++;
      peak = Math.max(peak, y);
    }
  }
  if (landHit) throw new Error(`${what}: its waterline runs onto ground already above the water at [${landHit.join(", ")}] (a peninsula, not an island): move the centre out into the lake, shrink \`radius\` / \`stretch\` or lower \`edgeNoise\``);
  const maxSlope = Math.max(1.0, p.core?.slope ?? 0) + 0.1;
  const patches: OperatorPiece[] = [{
    id: "ground", origin: [x0, z0], size: [(cols - 1) * g, (rows - 1) * g], columns: cols, rows, heights, weights,
    blend: 2 * g, feather: 2 * g, raiseOnly: true, maxSlope: r2(maxSlope),
  }];
  let shoalReport: Record<string, unknown> | undefined;
  if (p.shoal) {
    const sh = p.shoal, crest = p.waterY - sh.depth;
    const ax = p.center[0], az = p.center[1], bx = sh.to[0], bz = sh.to[1];
    const L = Math.hypot(bx - ax, bz - az);
    if (L < shape.b) throw new Error(`${what}: shoal.to [${sh.to.join(", ")}] is inside the island (${r2(L)} m from the centre): it must end on a shore`);
    const ux = (bx - ax) / L, uz = (bz - az) / L;
    const run = (p.waterY - deepest) / p.flank;
    const pad = sh.width / 2 + sh.wobble + run + 2;
    const sx0 = Math.floor((Math.min(ax, bx) - pad) / g) * g, sz0 = Math.floor((Math.min(az, bz) - pad) / g) * g;
    const sc = Math.ceil((Math.max(ax, bx) + pad - sx0) / g) + 1, sr = Math.ceil((Math.max(az, bz) + pad - sz0) / g) + 1;
    const hs: number[] = new Array(sc * sr), ws: number[] = new Array(sc * sr);
    const wph = hash01(sseed, 95) * Math.PI * 2;
    for (let r = 0; r < sr; r++) for (let c = 0; c < sc; c++) {
      const x = sx0 + c * g, z = sz0 + r * g, i = r * sc + c;
      const t = Math.max(0, Math.min(L, (x - ax) * ux + (z - az) * uz));
      const off = sh.wobble * Math.sin((t / Math.max(L, 1)) * Math.PI * 2 + wph) * Math.sin((t / Math.max(L, 1)) * Math.PI);
      const across = Math.abs(-(x - ax) * uz + (z - az) * ux - off);
      const along = (x - ax) * ux + (z - az) * uz;
      const beyond = Math.max(0, along - L, -along); // past either end
      const out = Math.max(0, across - sh.width / 2) + beyond;
      const y = crest - p.flank * out;
      const under = reader.height(x, z);
      hs[i] = r2(Math.min(y, p.waterY - sh.depth));
      ws[i] = y > under - 0.05 ? 1 : 0;
    }
    patches.push({ id: "shoal", origin: [sx0, sz0], size: [(sc - 1) * g, (sr - 1) * g], columns: sc, rows: sr, heights: hs, weights: ws, blend: 2 * g, feather: 2 * g, raiseOnly: true, maxSlope: r2(Math.max(1, p.flank) + 0.1) });
    shoalReport = { crestY: r2(crest), length: r2(L - shape.b), width: sh.width };
  }
  // the paints follow the waterline ellipse (32-point outline, wobble included)
  const outline = (inset: number): [number, number][] => {
    const pts: [number, number][] = [];
    for (let i = 0; i < 40; i++) {
      const th = (i / 40) * Math.PI * 2;
      // walk out along the bearing to the waterline - inset (the shape is star-shaped round the centre)
      let lo = 0, hi = shape.reach + 2;
      for (let k = 0; k < 24; k++) {
        const m = (lo + hi) / 2;
        if (shape.inside(p.center[0] + Math.cos(th) * m, p.center[1] + Math.sin(th) * m) > inset) lo = m; else hi = m;
      }
      pts.push([r2(p.center[0] + Math.cos(th) * lo), r2(p.center[1] + Math.sin(th) * lo)]);
    }
    return pts;
  };
  const paints: OperatorPiece[] = [
    { id: "shore", surface: p.shoreSurface, polygon: outline(-(p.shelf + 4)), feather: 2, edgeNoise: 1.5, strength: 1, breakup: 0, fringe: 0, blotch: 8, height: [r2(p.waterY - 4), r2(p.waterY + p.beach + 0.5)], faces: false },
  ];
  if (p.topSurface) paints.push({ id: "top", surface: p.topSurface, polygon: outline(p.shore), feather: 3, edgeNoise: 2, strength: 1, breakup: 0.25, fringe: 3, blotch: 6, faces: false });
  if (p.core && p.coreSurface) {
    const k = p.core;
    paints.push({ id: "core", surface: p.coreSurface, center: [r2(p.center[0] + k.at[0]), r2(p.center[1] + k.at[1])], radius: r2(k.radius + 1), feather: 2, edgeNoise: 1.5, strength: 1, breakup: 0, fringe: 2, blotch: 5, height: [r2(topY + 0.5), r2(topY + k.rise + 2)], faces: true });
  }
  return {
    features: { heightPatches: patches, groundPaints: paints },
    report: {
      waterY: p.waterY, topY: r2(topY), peakY: r2(peak), bedAtCentre: r2(bed0), deepestBed: r2(deepest),
      waterline: { long: r2(shape.a), short: r2(shape.b), across: `${Math.round(2 * shape.a)} x ${Math.round(2 * shape.b)} m` },
      dryAreaM2: Math.round(dryCells * g * g), steepDryShare: dryCells ? r2(steepDry / dryCells) : 0, maxDrySlope: r2(maxDrySlope),
      ...(p.core ? { knoll: { at: [r2(p.center[0] + p.core.at[0]), r2(p.center[1] + p.core.at[1])], topY: r2(topY + p.core.rise) } } : {}),
      ...(shoalReport ? { shoal: shoalReport } : {}),
    },
  };
}

registerOperator<IslandOperatorParams>({
  op: "island",
  description: "Raise a small island out of a lake or the sea: beach shelf at the waterline, gentle walkable top (swell), optional rock knoll at the core (the mass a stair or door is cut into), underwater flank seated in the bed, optional submerged shoal toward a shore for stepping stones. Raise-only; refuses a centre not in >= 1.5 m of water and a waterline that runs onto dry ground. Compiles to `heightPatches` op:<id>:ground (+ op:<id>:shoal) and `groundPaints` op:<id>:shore (+ :top, :core).",
  schema: islandOperatorSchema,
  compile: compileIsland,
  bounds: (p) => islandBounds(p),
  outline: (p) => {
    const sh = islandShape(p);
    const pts: [number, number][] = [];
    for (let i = 0; i < 48; i++) {
      const th = (i / 48) * Math.PI * 2;
      let lo = 0, hi = sh.reach + 2;
      for (let k = 0; k < 20; k++) { const m = (lo + hi) / 2; if (sh.inside(p.center[0] + Math.cos(th) * m, p.center[1] + Math.sin(th) * m) > 0) lo = m; else hi = m; }
      pts.push([p.center[0] + Math.cos(th) * lo, p.center[1] + Math.sin(th) * lo]);
    }
    return [pts];
  },
});

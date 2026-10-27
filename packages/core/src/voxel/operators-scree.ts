/**
 * `scree` — a talus fan (scree cone) from a source on a cliff lip down to a toe: loose rock lying at its angle of repose,
 * widening downslope, scalloped at the toe, its surface painted with a scree ground tile and (optionally) boulders that
 * grade coarser toward the toe.
 *
 * The ground is shaped THROUGH THE FIELD, never stamped: the fan is a surface H(s, lat) — a slightly concave profile
 * down the axis (angle of repose `angle` at the head easing to ~70% of it at the toe), a convex cross-section, low
 * ridges and gullies that deepen toward the toe — and the compiled height patch is max(ground, H). So the fan only ever
 * ADDS rock (heaped against the face, filling the slope), ends wherever its surface meets the ground (that IS the
 * natural toe), and no slope inside it is steeper than ~45 degrees (the repose angle down the axis, its flanks at 33 degrees across it). One masked
 * height patch (>= 6 m, the 6 m rule) whose weight is 0 wherever the fan is under the ground.
 *
 * Compiles to `op:<id>:fan` (heightPatches), `op:<id>:paint` (groundPaints over the fan's footprint, with a vegetation
 * clearing), `op:<id>:chute` (groundPaints: the face from the source down to the fan's head, faces included) and, with boulders, `op:<id>:rocks` (rockSets: instances of the world's catalogued rock scatter rules,
 * seated on the meshed ground like fall-site rocks).
 */
import { z } from "zod";
import { FINE_MIN, registerOperator, type OperatorFieldReader, type OperatorOutput } from "./operator-registry.js";
import { hashUnit, perlin2 } from "./noise.js";
import { requireSurface } from "./operators-paint.js";

const xz = z.tuple([z.number().finite(), z.number().finite()]);

export const screeOperatorSchema = z
  .object({
    from: z.union([xz, z.tuple([xz, xz])]).describe("Source: a point [x, z] on the cliff lip (the fan's apex), or a source LINE [[x, z], [x, z]] along the lip (the fan starts as wide as the line)."),
    to: xz.optional().describe("Toe direction and reach [x, z]: the fan runs from the source toward it. Omit to run straight downhill from the source."),
    length: z.number().min(FINE_MIN).max(400).optional().describe("Fan length, metres, along the axis (instead of `to`). Omit both: the fan runs until its surface meets the ground (the natural toe), at most 400 m."),
    apexDrop: z.number().min(0).max(160).default(2).describe("Metres below the ground at the source where the fan's head starts: 0 = tipped right off the lip, 6 = a band of bare face shows above the fan. On a TALL face start it part-way down (a 130 m face: 60-100) — the fan is then a cone at the foot, fed by its `chute` — or it heaps as high as the face and runs far past the foot."),
    chute: z.boolean().default(true).describe("Paint the face between the source and the fan's head with the scree surface too (a pale streak of fallen rock down the face, faces included). Only drawn when the head is more than 6 m below the source."),
    angle: z.number().min(26).max(40).default(34).describe("Angle of repose at the head, degrees (dry scree 32-38). The profile eases to ~70% of it at the toe (talus is concave)."),
    widthTop: z.number().min(FINE_MIN).max(120).default(10).describe("Fan width at the head, metres (at least the source line's length)."),
    widthToe: z.number().min(FINE_MIN).max(300).default(40).describe("Fan width at the toe, metres."),
    lobes: z.number().int().min(1).max(8).optional().describe("Ridges/gullies across the fan (debris lobes). Omit: about one per 14 m of toe width."),
    relief: z.number().min(0).max(2).default(0.6).describe("Height of the lobes at the toe, metres (0 = a smooth cone)."),
    surface: z.string().min(1).default("scree-pale").describe("Palette surface painted on the fan (world-kit ground tile `scree-pale` = pale fresh talus). Must be in the world's palette."),
    paintFeather: z.number().min(0).max(20).default(3).describe("Metres the scree paint fades past the fan's edge."),
    clear: z.boolean().default(true).describe("Keep scatter (trees, bushes) and ground cover off the fan."),
    boulders: z
      .union([
        z.literal(false),
        z.object({
          density: z.number().min(0).max(4).default(0.6).describe("Boulders per 100 m2 at the toe (half that at the head)."),
          rules: z.tuple([z.string(), z.string(), z.string()]).default(["rock-small", "rock-medium", "rock-big"]).describe("Catalogued rock scatter rule ids, [fine, medium, coarse]: fine near the head, coarse at the toe."),
          scale: z.tuple([z.number().positive(), z.number().positive()]).default([0.6, 1.5]).describe("Scale at the head and at the toe (grading coarser downslope)."),
        }),
      ])
      .default({ density: 0.6, rules: ["rock-small", "rock-medium", "rock-big"], scale: [0.6, 1.5] })
      .describe("Boulders on the fan, seated on the meshed ground (an unsupported one is dropped). false = none."),
    seed: z.number().int().default(1).describe("Lobe / toe / boulder seed (combined with the world seed)."),
  })
  .refine((p) => !(p.to && p.length), { message: "give `to` or `length`, not both" });
export type ScreeOperatorParams = z.infer<typeof screeOperatorSchema>;

type V2 = [number, number];

/** Apex, axis, width and length of a fan, before reading the ground for an auto direction/length. */
interface FanFrame {
  ax: number; az: number; // apex (source centre)
  ux: number; uz: number; // axis (downslope)
  vx: number; vz: number; // lateral
  hwTop: number; hwToe: number;
  L: number;
  apexY: number;
  t: number; // tan(angle)
  lobes: number;
  relief: number;
  seed: number;
}

function sourceOf(p: ScreeOperatorParams): { a: V2; line: number; lineDir: V2 | null } {
  const f = p.from;
  if (Array.isArray(f[0])) {
    const [a, b] = f as [V2, V2];
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    return { a: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2], line: len, lineDir: len > 1e-6 ? [(b[0] - a[0]) / len, (b[1] - a[1]) / len] : null };
  }
  return { a: f as V2, line: 0, lineDir: null };
}

/** Steepest-descent bearing around a point (sampled on two rings). */
function downhill(reader: OperatorFieldReader, x: number, z: number): V2 {
  let best: V2 = [0, 1], bestDrop = -Infinity;
  for (let k = 0; k < 48; k++) {
    const a = (k / 48) * Math.PI * 2, dx = Math.cos(a), dz = Math.sin(a);
    const drop = reader.height(x, z) - 0.5 * (reader.height(x + dx * 12, z + dz * 12) + reader.height(x + dx * 24, z + dz * 24));
    if (drop > bestDrop) { bestDrop = drop; best = [dx, dz]; }
  }
  return best;
}

/** The fan's surface height at (x, z), or -Infinity outside its reach. Pure in the frame. */
export function fanSurface(fr: FanFrame, x: number, z: number): number {
  const dx = x - fr.ax, dz = z - fr.az;
  const s = dx * fr.ux + dz * fr.uz, lat = dx * fr.vx + dz * fr.vz;
  const L = fr.L;
  // toe scallop: the reach varies across the fan
  const Llat = L * (1 + 0.1 * perlin2(lat / 18 + fr.seed * 0.37, fr.seed * 0.11, fr.seed));
  const q = Math.max(0, Math.min(1, s / Math.max(1, Llat)));
  const hw = fr.hwTop + (fr.hwToe - fr.hwTop) * q;
  // concave profile: slope t at the head, 0.7 t at s = L
  const c = 0.15;
  let along: number;
  if (s < 0) along = -s * fr.t * 3; // behind the head: drops away fast (the face is there)
  else if (s <= Llat) along = fr.t * s * (1 - c * (s / Llat));
  else along = fr.t * Llat * (1 - c) + (s - Llat) * fr.t; // past a set length: a snout at the repose angle down to the ground
  // convex cross-section, then the flanks fall away
  // (flank rate kept so the combined gradient stays under ~45 degrees, below the 50-degree walk limit: hypot(t, FLANK) at 34 degrees = 0.94)
  const a = Math.abs(lat), bulge = 0.25;
  const cross = a <= hw ? fr.t * bulge * hw * (a / hw) ** 2 : fr.t * bulge * hw + (a - hw) * FLANK;
  // debris lobes: ridges and gullies, deepening toward the toe, fading out on the flanks
  const lobe = fr.relief * q * Math.cos((lat / Math.max(1, 2 * hw)) * Math.PI * 2 * fr.lobes * 0.5 + fr.seed) * Math.max(0, 1 - a / (hw * 1.1));
  return fr.apexY - along - cross + lobe;
}

function frameFor(p: ScreeOperatorParams, reader: OperatorFieldReader, id: string): FanFrame {
  const src = sourceOf(p);
  const [ax, az] = src.a;
  let u: V2;
  if (p.to) {
    const d = Math.hypot(p.to[0] - ax, p.to[1] - az);
    if (d < FINE_MIN) throw new Error(`scree "${id}": \`to\` is ${d.toFixed(1)} m from the source (at least ${FINE_MIN})`);
    u = [(p.to[0] - ax) / d, (p.to[1] - az) / d];
  } else u = downhill(reader, ax, az);
  // a source line sets the head width; the axis is kept as given/downhill
  const hwTop = Math.max(p.widthTop, src.line) / 2;
  const seedMix = (reader.seed * 7919 + p.seed * 104729 + id.length * 31) | 0;
  const fr: FanFrame = {
    ax, az, ux: u[0], uz: u[1], vx: -u[1], vz: u[0],
    hwTop, hwToe: Math.max(hwTop, p.widthToe / 2),
    L: p.to ? Math.hypot(p.to[0] - ax, p.to[1] - az) : p.length ?? 400,
    apexY: reader.height(ax, az) - p.apexDrop,
    t: Math.tan((p.angle * Math.PI) / 180),
    lobes: p.lobes ?? Math.max(1, Math.round(p.widthToe / 14)),
    relief: p.relief,
    seed: Math.abs(seedMix % 1000) + 1,
  };
  if (!p.to && p.length === undefined) {
    // natural toe: walk down the axis past the head (where the fan first stands proud of the face) until the fan
    // surface is under the ground for 4 m
    let under = 0, toe = 400, proud = false;
    for (let s = 2; s <= 400; s += 1) {
      const x = ax + u[0] * s, z = az + u[1] * s;
      const h = fr.apexY - fr.t * s * (1 - 0.15 * (s / 400));
      if (h < reader.height(x, z)) { if (proud && ++under >= 4) { toe = s - 3; break; } } else { proud = true; under = 0; }
    }
    fr.L = Math.max(FINE_MIN, toe);
  }
  return fr;
}

/**
 * Oriented box of the fan's reach, as a world AABB. The reach comes from how far above the lowest ground around it the
 * fan stands (flanks at FLANK, the snout at the repose angle), so the raster always ends where the fan is already under
 * the ground: a raster edge across a fan still standing proud would draw as a wall.
 */
function fanBox(fr: FanFrame, pad: number, reader: OperatorFieldReader): { x0: number; z0: number; x1: number; z1: number } {
  let minG = Infinity;
  const probeHalf = fr.hwToe + 120;
  for (let s = 0; s <= fr.L * 1.12 + 60; s += 8) for (let l = -probeHalf; l <= probeHalf; l += 8) {
    minG = Math.min(minG, reader.height(fr.ax + fr.ux * s + fr.vx * l, fr.az + fr.uz * s + fr.vz * l));
  }
  const rise = Math.max(0, fr.apexY - minG);
  const sMin = -fr.hwTop - 4;
  const sMax = Math.min(fr.L * 1.12 + rise / fr.t + 6, fr.L * 1.12 + 300);
  const half = Math.min(fr.hwToe * 1.1 + rise / FLANK + 6, fr.hwToe + 300);
  let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
  for (const s of [sMin, sMax]) for (const l of [-half, half]) {
    const x = fr.ax + fr.ux * s + fr.vx * l, z = fr.az + fr.uz * s + fr.vz * l;
    x0 = Math.min(x0, x); z0 = Math.min(z0, z); x1 = Math.max(x1, x); z1 = Math.max(z1, z);
  }
  return { x0: x0 - pad, z0: z0 - pad, x1: x1 + pad, z1: z1 + pad };
}

const r2 = (v: number) => Math.round(v * 100) / 100;
/** Rise/run of a fan's flanks past its width (33 degrees): a fan heaped high above open ground spills sideways at it. */
const FLANK = 0.65;
/** Metres over which the fan is blended into the ground it meets (smooth max). */
const CREASE = 3;

function compileScree(p: ScreeOperatorParams, reader: OperatorFieldReader, ctx: { id: string }): OperatorOutput {
  const who = `scree "${ctx.id}"`;
  requireSurface(reader, p.surface, who);
  if (p.boulders && reader.scatterRules) {
    for (const r of p.boulders.rules) if (!reader.scatterRules.includes(r)) throw new Error(`${who}: boulder rule "${r}" is not a scatter rule of this world (the catalogued rock rules, e.g. rock-small / rock-medium / rock-big)`);
  }
  const fr = frameFor(p, reader, ctx.id);
  const box = fanBox(fr, 2, reader);
  // raster: 1 m where it fits, coarser for a huge fan (<= 1025 samples a side)
  const spanX = box.x1 - box.x0, spanZ = box.z1 - box.z0;
  const step = Math.max(1, Math.ceil(Math.max(spanX, spanZ) / 1024));
  const cols = Math.ceil(spanX / step) + 1, rows = Math.ceil(spanZ / step) + 1;
  const heights = new Array<number>(cols * rows), weights = new Array<number>(cols * rows);
  const fill = new Float32Array(cols * rows);
  let maxFill = 0, area = 0, minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity, toeY = Infinity;
  for (let j = 0; j < rows; j++) for (let i = 0; i < cols; i++) {
    const x = box.x0 + i * step, z = box.z0 + j * step, k = j * cols + i;
    const g = reader.height(x, z), h = fanSurface(fr, x, z);
    // a SMOOTH union of ground and fan (rounded over ~CREASE m): the hard max(ground, fan) crease where the fan meets a
    // steep face is sharper than the 2 m lattice can draw (the lips gate reads it as alias)
    const u = 0.5 * (g + h + Math.sqrt((g - h) * (g - h) + CREASE * CREASE));
    const d = u - g;
    fill[k] = Math.max(0, h - g); // the fan proper (footprint, outline, boulders, slope report), not the blended crease
    // weight 0 where the fan is under the ground (the ground shows through, never frozen), 1 once it is 0.8 m proud
    const w = d < 0.05 ? 0 : Math.min(1, (d - 0.05) / 0.8);
    weights[k] = Math.round(w * 1000) / 1000;
    heights[k] = r2(u);
    if (h - g > 0.3) {
      maxFill = Math.max(maxFill, h - g); area += step * step;
      minX = Math.min(minX, x); maxX = Math.max(maxX, x); minZ = Math.min(minZ, z); maxZ = Math.max(maxZ, z);
      toeY = Math.min(toeY, h);
    }
  }
  if (!(area > 0) || maxX - minX < FINE_MIN || maxZ - minZ < FINE_MIN) {
    throw new Error(`${who}: the fan never stands proud of the ground (area ${area} m2) — the source is not above a slope steeper than the angle of repose; move \`from\` to the lip, lower \`apexDrop\`, or raise \`angle\``);
  }
  // steepest slope of the finished surface inside the fan (report: the repose angle on the axis, up to ~45 on the flanks; over that = a fault — the walk limit is 50)
  let steepest = 0;
  const finished = (i: number, j: number) => heights[j * cols + i]!;
  for (let j = 1; j < rows - 1; j++) for (let i = 1; i < cols - 1; i++) {
    // the fan's own surface: all four neighbours on the fan (the crease against the face is the face's slope, not the fan's)
    const F = CREASE; // past the blended crease: the fan proper
    if (fill[j * cols + i]! < F || fill[j * cols + i - 1]! < F || fill[j * cols + i + 1]! < F || fill[(j - 1) * cols + i]! < F || fill[(j + 1) * cols + i]! < F) continue;
    const gx = (finished(i + 1, j) - finished(i - 1, j)) / (2 * step), gz = (finished(i, j + 1) - finished(i, j - 1)) / (2 * step);
    steepest = Math.max(steepest, Math.atan(Math.hypot(gx, gz)) * 180 / Math.PI);
  }
  const patch = {
    id: "fan",
    origin: [r2(box.x0), r2(box.z0)],
    size: [(cols - 1) * step, (rows - 1) * step],
    columns: cols,
    rows,
    heights,
    weights,
    blend: 4,
    feather: 4,
    filter: Math.max(step, reader.voxelSize),
  };
  // the fan's footprint (fill > 0.3 m) as a star outline from its centroid: the scree paint and its clearing
  const fx = (minX + maxX) / 2, fz = (minZ + maxZ) / 2;
  const fillAt = (x: number, z: number) => {
    const i = Math.round((x - box.x0) / step), j = Math.round((z - box.z0) / step);
    return i < 0 || j < 0 || i >= cols || j >= rows ? 0 : fill[j * cols + i]!;
  };
  const outline: V2[] = [];
  const reach = Math.hypot(maxX - minX, maxZ - minZ);
  for (let k = 0; k < 48; k++) {
    const a = (k / 48) * Math.PI * 2, dx = Math.cos(a), dz = Math.sin(a);
    let last = 0;
    for (let r = 0; r <= reach; r += step) if (fillAt(fx + dx * r, fz + dz * r) > 0.3) last = r;
    outline.push([r2(fx + dx * (last + step)), r2(fz + dz * (last + step))]);
  }
  const paint = {
    id: "paint", surface: p.surface, polygon: outline, feather: p.paintFeather, edgeNoise: 1.5, strength: 1, breakup: 0, faces: false,
    ...(p.clear ? { clear: { scatter: true, cover: true } } : {}),
  };
  // the chute: the face from the source down to the fan's head, painted (faces too) so the fan reads as fed from the lip
  const paints: Record<string, unknown>[] = [paint];
  let headS = -1;
  for (let sAx = 0; sAx <= fr.L; sAx += step) if (fillAt(fr.ax + fr.ux * sAx, fr.az + fr.uz * sAx) > 0.3) { headS = sAx; break; }
  const headY = headS >= 0 ? reader.height(fr.ax + fr.ux * headS, fr.az + fr.uz * headS) : NaN;
  if (p.chute && headS > 0 && reader.height(fr.ax, fr.az) - headY > FINE_MIN) {
    const src = sourceOf(p);
    const hwHead = fr.hwTop + (fr.hwToe - fr.hwTop) * Math.min(1, headS / fr.L);
    const tw = Math.max(FINE_MIN / 2, src.line > 0 ? src.line / 2 : fr.hwTop * 0.6), hw = Math.max(tw, hwHead * 0.7);
    const at = (sAx: number, l: number): V2 => [r2(fr.ax + fr.ux * sAx + fr.vx * l), r2(fr.az + fr.uz * sAx + fr.vz * l)];
    paints.push({
      id: "chute", surface: p.surface, polygon: [at(-2, -tw), at(-2, tw), at(headS + 4, hw), at(headS + 4, -hw)], feather: 2, edgeNoise: 2, strength: 1,
      breakup: 0.2, faces: true,
    });
  }
  // boulders: a jittered lattice over the fan, denser and coarser toward the toe
  const rocks: { rule: string; at: V2; yaw: number; scale: number }[] = [];
  if (p.boulders && p.boulders.density > 0) {
    const b = p.boulders;
    const cell = Math.sqrt(100 / b.density);
    for (let gz = minZ; gz <= maxZ; gz += cell) for (let gx = minX; gx <= maxX; gx += cell) {
      const ci = Math.round(gx / cell), cj = Math.round(gz / cell);
      const x = gx + (hashUnit(ci, cj, 1, fr.seed) - 0.5) * cell * 0.9, z = gz + (hashUnit(ci, cj, 2, fr.seed) - 0.5) * cell * 0.9;
      if (fillAt(x, z) < 0.6) continue;
      const s = (x - fr.ax) * fr.ux + (z - fr.az) * fr.uz;
      const q = Math.max(0, Math.min(1, s / fr.L));
      if (hashUnit(ci, cj, 3, fr.seed) > 0.5 + 0.5 * q) continue; // half the density at the head
      const pick = q + (hashUnit(ci, cj, 4, fr.seed) - 0.5) * 0.5;
      const rule = pick < 0.4 ? b.rules[0] : pick < 0.78 ? b.rules[1] : b.rules[2];
      const scale = (b.scale[0] + (b.scale[1] - b.scale[0]) * q) * (0.85 + 0.3 * hashUnit(ci, cj, 5, fr.seed));
      rocks.push({ rule, at: [r2(x), r2(z)], yaw: r2(hashUnit(ci, cj, 6, fr.seed) * Math.PI * 2), scale: r2(scale) });
    }
  }
  const features: OperatorOutput["features"] = { heightPatches: [patch], groundPaints: paints as never };
  if (rocks.length) features.rockSets = [{ id: "rocks", rocks }];
  return {
    features,
    report: {
      apex: [r2(fr.ax), r2(fr.apexY), r2(fr.az)], axis: [r2(fr.ux), r2(fr.uz)], length: r2(fr.L), toeY: r2(toeY), drop: r2(fr.apexY - toeY),
      widthTop: r2(fr.hwTop * 2), widthToe: r2(fr.hwToe * 2), lobes: fr.lobes, maxFill: r2(maxFill), area: Math.round(area),
      head: headS >= 0 ? [r2(fr.ax + fr.ux * headS), r2(headY), r2(fr.az + fr.uz * headS)] : null, chute: paints.length > 1,
      steepestDeg: Math.round(steepest * 10) / 10, raster: `${cols}x${rows} @ ${step} m`, boulders: rocks.length, surface: p.surface,
    },
  };
}

function screeBounds(p: ScreeOperatorParams) {
  const src = sourceOf(p);
  const reach = p.to ? Math.hypot(p.to[0] - src.a[0], p.to[1] - src.a[1]) * 1.12 + 30 : (p.length ?? 400) * 1.12 + 30;
  const r = reach + Math.max(p.widthToe, p.widthTop, src.line) * 0.6 + 30;
  if (p.to) {
    // the oriented box, not the whole disc: a fan with `to` has a known axis
    const x0 = Math.min(src.a[0], p.to[0]), x1 = Math.max(src.a[0], p.to[0]), z0 = Math.min(src.a[1], p.to[1]), z1 = Math.max(src.a[1], p.to[1]);
    const pad = Math.max(p.widthToe, p.widthTop, src.line) * 0.6 + 34;
    return { x0: x0 - pad, z0: z0 - pad, x1: x1 + pad, z1: z1 + pad };
  }
  return { x0: src.a[0] - r, z0: src.a[1] - r, x1: src.a[0] + r, z1: src.a[1] + r };
}

registerOperator<ScreeOperatorParams>({
  op: "scree",
  description:
    "A talus/scree FAN from a source point or line on a cliff lip down to a toe: rock heaped at its angle of repose (concave profile, convex cross-section, debris lobes, scalloped toe), widening downslope, ending where it meets the ground; shaped through the field (max(ground, fan), fill only), painted with a scree ground tile and dressed with catalogued boulders grading coarser toward the toe. Compiles to `op:<id>:fan` (height patch) + `op:<id>:paint` (groundPaints + clearing) + `op:<id>:rocks` (rockSets).",
  schema: screeOperatorSchema,
  compile: compileScree,
  bounds: screeBounds,
  outline: (p) => {
    const src = sourceOf(p);
    const pts: [number, number][] = [];
    if (src.lineDir) {
      const f = p.from as [V2, V2];
      pts.push(f[0], f[1]);
    } else pts.push(src.a);
    if (p.to) pts.push(p.to);
    return [pts];
  },
});

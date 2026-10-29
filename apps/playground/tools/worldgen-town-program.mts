/**
 * A town's PROGRAM decides how much flat ground it gets (2026-10-29, firstshore s1f).
 *
 * `worldgen terrace` used to size a town's shelves from its radius: Saltharrow (11 buildings at the kit's proven
 * sizes) got three 20 m discs, ~2,400 m2 of level ground, and its town master cut the program three times (11 -> 7
 * -> 5) to make it fit. The program is the given; the ground is what the stage makes. This module is that rule, shared
 * by `worldgen terrace` (sizing), the `program-fit` row of `worldgen status` and the `zonegen town` lint (the gate):
 *
 *   required = sum(lot envelope x margin) + streets + wall clearance          (`programFromPlan`, `PROGRAM_RULE`)
 *   shelves  = street-shaped BANDS along the contour, sized and counted to hold it (`planProgramShelves`)
 *   achieved = level, dry ground at a shelf's height inside its band, measured on the built field (`measureShelfFlat`)
 *
 * The schema's `townSchema.program` and `terraceSchema.street` `.describe()` carry the same numbers.
 */
import fs from "node:fs";
import path from "node:path";
import type { TerraceDoc, TownDoc, TownGateDoc, WorldField, WorldRecipe } from "@hitreg/core";
import { gateIsLandward, nearestShore } from "./worldgen-coastal-towns.mts";

type V2 = [number, number];

/** The sizing rule. One table; the schema's `townSchema.program` describe quotes it. */
export const PROGRAM_RULE = {
  /** the building kit's cell (tools/town-layout.mts `CELL`) */
  cell: 3.2,
  /** each lot's envelope (request footprint + measured or default extents) x this: 1 m air to its neighbours, setback, its 0.6 m raised pad's skirt */
  margin: 1.15,
  /** street width (m); every lot fronts one */
  street: 5,
  /** streets = sum(frontage) x street / 2 (a street serves two rows) x this (crossings, a square) */
  junction: 1.2,
  /** the town wall keeps this far (m) off every lot ... */
  wallClear: 4,
  /** ... along this share of its run (the rest is street-lined anyway) */
  wallShare: 0.5,
  /** a lot's setback from its street edge (town-layout's default) */
  setback: 1,
  /** a street on a band's SEAWARD edge keeps this much flat ground (m) between its edge and the riser face below:
   *  the lanterns' kerb (street-lights edgeOffset 0.5 + post + the riser's coping) — the band grows seaward by it, the
   *  street and the lots stay (Saltharrow 10-29: streets hung 0.5-1.5 m over the riser drop, no lawful lantern spot) */
  kerb: 2.5,
} as const;

/** tools/town-layout.mts DEFAULT_EXT: a lot with no measured envelope (cells beyond the requested footprint). */
const DEFAULT_EXT = { full: { left: 0.45, right: 0.45, front: 0.75, back: 0.55 }, ground: { left: 0.4, right: 0.4, front: 0.55, back: 0.55 } };
type Ext = { left: number; right: number; front: number; back: number };

export interface ProgramLot {
  id: string;
  /** envelope width along the street, m */
  width: number;
  /** envelope depth away from the street, m */
  depth: number;
  /** what the lot needs ACROSS a band (its shorter side + setback: a long lot turns onto a cross lane), m */
  across: number;
}

export interface TownProgram {
  /** required flat ground, m2 */
  area: number;
  lots: number;
  lotArea: number;
  streetArea: number;
  wallArea: number;
  /** the deepest lot across a band (m): some band must be at least this + one street deep */
  across: number;
  /** the median lot across a band (m): a band two of these + a street deep takes a street down its middle */
  acrossTypical: number;
  detail: ProgramLot[];
  source: string;
}

interface PlanLike {
  buildings?: { id: string; model?: string; request?: { size?: [number, number] } }[];
}

/** The required flat area of a plan (every building in it: optional and `droppedWhy` lots count — the program is not cut). */
export function programFromPlan(plan: PlanLike, envelopes: Record<string, { full?: Ext; ground?: Ext }> = {}, source = "plan", rule = PROGRAM_RULE): TownProgram {
  const byId = new Map((plan.buildings ?? []).map((b) => [b.id, b]));
  const detail: ProgramLot[] = [];
  for (const b of plan.buildings ?? []) {
    const model = b.model ?? b.id;
    const size = byId.get(model)?.request?.size ?? b.request?.size;
    if (!size) continue;
    const env = envelopes[`bh_${model.replace(/-/g, "_")}`] ?? envelopes[model] ?? DEFAULT_EXT;
    const full = env.full ?? DEFAULT_EXT.full, ground = env.ground ?? DEFAULT_EXT.ground;
    const side = (k: keyof Ext) => Math.max(full[k], ground[k]);
    const width = (size[0] + side("left") + side("right")) * rule.cell;
    const depth = (size[1] + side("front") + side("back")) * rule.cell;
    detail.push({ id: b.id, width: r1(width), depth: r1(depth), across: r1(Math.min(width, depth) + rule.setback) });
  }
  const lotArea = detail.reduce((s, l) => s + l.width * l.depth, 0) * rule.margin;
  const streetArea = detail.reduce((s, l) => s + l.width + 1, 0) * (rule.street / 2) * rule.junction;
  const base = lotArea + streetArea;
  const wallArea = rule.wallClear * 2 * Math.sqrt(Math.PI * base) * rule.wallShare;
  const across = detail.reduce((m, l) => Math.max(m, l.across), 0);
  const sorted = detail.map((l) => l.across).sort((a, b) => a - b);
  return {
    area: Math.round(base + wallArea),
    lots: detail.length,
    lotArea: Math.round(lotArea),
    streetArea: Math.round(streetArea),
    wallArea: Math.round(wallArea),
    across: r1(across),
    acrossTypical: r1(sorted[Math.floor(sorted.length / 2)] ?? 0),
    detail,
    source,
  };
}

/** The town plan of a recipe town: authoring/towns/<name>.json with `town` = the id (and `world` when given). */
export function findTownPlan(projectDir: string, townId: string, world?: string): { name: string; plan: string; envelopes: string } | null {
  const dir = path.join(projectDir, "authoring", "towns");
  if (!fs.existsSync(dir)) return null;
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith(".json")) continue;
    try {
      const doc = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")) as { town?: string; world?: string };
      if (doc.town !== townId || (world && doc.world && doc.world !== world)) continue;
      const name = f.slice(0, -5);
      const plan = path.join(dir, `${name}-plan.json`);
      if (!fs.existsSync(plan)) return null;
      return { name, plan, envelopes: path.join(dir, `${name}-envelopes.json`) };
    } catch {
      continue;
    }
  }
  return null;
}

/** The program of a recipe town from its plan on disk (null: the town has no plan). */
export function loadTownProgram(projectDir: string, townId: string, world?: string): TownProgram | null {
  const found = findTownPlan(projectDir, townId, world);
  if (!found) return null;
  const plan = JSON.parse(fs.readFileSync(found.plan, "utf8")) as PlanLike;
  const env = fs.existsSync(found.envelopes) ? (JSON.parse(fs.readFileSync(found.envelopes, "utf8")) as Record<string, { full?: Ext; ground?: Ext }>) : {};
  return programFromPlan(plan, env, path.relative(projectDir, found.plan).replace(/\\/g, "/"));
}

// ---------------------------------------------------------------- the planner

export interface ShelfPlanInput {
  /** natural ground (the town's own shelves and ramps lifted off) */
  height: (x: number, z: number) => number;
  sea: number;
  centre: V2;
  /** the town's radius: the plane is fitted inside it */
  radius: number;
  /** usable flat area to reach, m2 */
  required: number;
  /** deepest lot across a band, m */
  across: number;
  /** median lot across a band, m */
  acrossTypical: number;
  street: number;
  /** a riser's horizontal run (the shelf falloff), m */
  riser: number;
  /** tallest step (one retaining wall), m */
  maxStep: number;
  /** the retaining-wall fit holds a drop this much over maxStep by moving the shelf above down (default 0.9) */
  stepSlack?: number;
  /** two shelves closer in height than this are one rough floor, m */
  minStep: number;
  maxTerraces: number;
  /** no band corner further than this from the centre, m */
  reach: number;
  /** most the natural ground under a band's centreline may sit off its level (cut or fill), m */
  cutTol: number;
  /** most fall from the lowest to the highest shelf, m */
  maxRelief: number;
  /** the retaining-wall fit's outline is the band less this on each long side (usable depth = depth - 2 inset), m */
  inset: number;
  /** a band shorter than this is not a street, m */
  minLength?: number;
  sample?: number;
}

export interface PlannedBand {
  /** centreline ends (the street direction is a -> b) */
  a: V2;
  b: V2;
  /** the ends along the contour axis through the centre, m */
  a0: number;
  a1: number;
  /** the centreline offset up the fall line from the centre, m */
  w: number;
  length: number;
  depth: number;
  level: number;
  /** why each end stopped growing */
  stops: [string, string];
}

export interface ShelfPlan {
  ok: boolean;
  bands: PlannedBand[];
  /** sum(length x usable depth), m2 */
  capacity: number;
  required: number;
  slope: number;
  /** unit XZ downhill */
  downhill: V2;
  why: string[];
}

/** Least-squares plane over the disc: the hill's fall line and slope. */
export function fallLine(height: (x: number, z: number) => number, c: V2, radius: number, step = 4): { downhill: V2; slope: number } {
  let n = 0, sx = 0, sz = 0, sxx = 0, szz = 0, sxz = 0, sh = 0, sxh = 0, szh = 0;
  for (let dz = -radius; dz <= radius; dz += step)
    for (let dx = -radius; dx <= radius; dx += step) {
      if (dx * dx + dz * dz > radius * radius) continue;
      const h = height(c[0] + dx, c[1] + dz);
      n++; sx += dx; sz += dz; sxx += dx * dx; szz += dz * dz; sxz += dx * dz; sh += h; sxh += dx * h; szh += dz * h;
    }
  // centred: the disc is symmetric, so sx ~ sz ~ 0; solve the 2x2 for the gradient
  const mx = sx / n, mz = sz / n, mh = sh / n;
  const cxx = sxx / n - mx * mx, czz = szz / n - mz * mz, cxz = sxz / n - mx * mz;
  const cxh = sxh / n - mx * mh, czh = szh / n - mz * mh;
  const det = cxx * czz - cxz * cxz || 1;
  const gx = (cxh * czz - czh * cxz) / det, gz = (czh * cxx - cxh * cxz) / det;
  const slope = Math.hypot(gx, gz);
  return { downhill: slope > 1e-9 ? [-gx / slope, -gz / slope] : [0, 1], slope };
}

const median = (v: number[]): number => {
  const s = [...v].sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length / 2)]! : 0;
};

/**
 * Cut a hillside into street-shaped bands that hold `required` m2: straight bands ALONG the contour (the street
 * direction), stacked up the fall line one riser apart, each held at the median height of the ground under its
 * centreline. A band grows lengthwise from the town's fall line until the ground leaves its level by `cutTol`,
 * reaches the sea, or reaches `reach` from the centre; bands are added up the hill until the program fits or
 * `maxTerraces` / `maxRelief` stop it. Depth is what the hill allows for one wall-high step (maxStep / slope less the
 * riser), held between one row of the deepest lot + a street and two rows of the typical lot + a street; the
 * deepest candidate that fits wins, then the one with fewest bands. Pure: `height` is the only input from the world.
 */
export function planProgramShelves(input: ShelfPlanInput): ShelfPlan {
  const step = input.sample ?? 2;
  const { downhill, slope } = fallLine(input.height, input.centre, input.radius);
  const up: V2 = [-downhill[0], -downhill[1]];
  const u: V2 = [-downhill[1], downhill[0]];
  const c = input.centre;
  const at = (a: number, w: number): V2 => [c[0] + u[0] * a + up[0] * w, c[1] + u[1] * a + up[1] * w];
  const h = (a: number, w: number): number => {
    const p = at(a, w);
    return input.height(p[0], p[1]);
  };
  const minLength = input.minLength ?? 16;
  // the retaining-wall fit holds a drop up to one course over its tallest wall (the shelf above moves down)
  const maxDrop = input.maxStep + (input.stepSlack ?? 0.9);
  // DEPTHS: the lowest band holds the deepest lot (one row + a street); the rest the typical lot, two rows when the
  // hill gives the room for one wall-high step, else one row; never deeper than two typical rows + a street
  const dDeep = Math.max(input.across + input.street + 2 * input.inset, 18);
  const dTyp = Math.max(input.acrossTypical + input.street + 2 * input.inset, 18);
  const dMax = Math.max(dDeep, 2 * input.acrossTypical + input.street + 2 * input.inset);
  const dHill = slope > 1e-3 ? input.maxStep / slope - input.riser : dMax;
  const top = Math.max(dTyp, Math.min(dMax, dHill));
  const depths: number[] = [];
  for (let d = Math.floor(top / 2) * 2; d >= Math.ceil(dTyp / 2) * 2 - 1e-9; d -= 2) depths.push(d);
  if (depths.length === 0) depths.push(Math.ceil(dTyp));

  const tryDepth = (D: number): { bands: PlannedBand[]; capacity: number; why: string[] } => {
    const why: string[] = [];
    const D0 = Math.max(D, dDeep);
    // the lowest band's front edge: the first dry ground up the fall line from the sea
    let wf = -input.reach;
    while (wf < input.reach && !(h(0, wf) >= input.sea + 1 && h(0, wf + D0 / 2) >= input.sea + 2)) wf += 1;
    if (wf >= input.reach) return { bands: [], capacity: 0, why: ["no dry ground on the fall line through the centre"] };
    const bands: PlannedBand[] = [];
    let capacity = 0;
    let tries = 0;
    for (let k = 0; k < input.maxTerraces && tries < 200; k++, tries++) {
      const depth = k === 0 ? D0 : D;
      const usable = Math.max(1, depth - 2 * input.inset);
      const wc = wf + depth / 2;
      const across: number[] = [];
      for (let w = wf; w <= wf + depth + 1e-9; w += Math.max(2, depth / 6)) across.push(w);
      const prev = bands[bands.length - 1];
      // A TERRACE STANDS ON THE ONE BELOW (the retaining-wall fit trims an upper shelf to 2 m inside the lower's ends)
      const lo = prev ? prev.a0 + 2 : -Infinity;
      const hi = prev ? prev.a1 - 2 : Infinity;
      const ok = (a: number, level: number): string | null => {
        if (a < lo || a > hi) return "the shelf below ends";
        for (const w of [wf, wf + depth]) {
          const p = at(a, w);
          if (Math.hypot(p[0] - c[0], p[1] - c[1]) > input.reach) return `reach ${input.reach} m`;
        }
        if (Math.abs(h(a, wc) - level) > input.cutTol) return `ground leaves the level by ${input.cutTol} m`;
        for (const w of across) {
          const g = h(a, w);
          if (g < input.sea + 0.3) return "the sea";
          if (Math.abs(g - level) > input.maxStep) return `cut/fill over ${input.maxStep} m`;
        }
        return null;
      };
      const start = Math.max(lo, Math.min(hi, 0));
      const grow = (level: number): { a0: number; a1: number; stops: [string, string] } => {
        const first = ok(start, level);
        if (first !== null) return { a0: start, a1: start, stops: [first, first] };
        let a0 = start, a1 = start, s0 = "", s1 = "";
        while (!s0) {
          const r = ok(a0 - step, level);
          if (r) s0 = r;
          else a0 -= step;
        }
        while (!s1) {
          const r = ok(a1 + step, level);
          if (r) s1 = r;
          else a1 += step;
        }
        return { a0, a1, stops: [s0, s1] };
      };
      let level = h(start, wc);
      let span = grow(level);
      for (let it = 0; it < 3; it++) {
        const line: number[] = [];
        for (let a = span.a0; a <= span.a1 + 1e-9; a += step) line.push(h(a, wc));
        const next = median(line);
        if (Math.abs(next - level) < 0.05) break;
        level = next;
        span = grow(level);
      }
      const length = span.a1 - span.a0;
      if (level < input.sea + 1 || (prev && level - prev.level < input.minStep)) {
        // under the floor rule, or flatter here than the stack assumed: move this band up until it is a step
        wf += 2;
        k--;
        continue;
      }
      if (prev && level - prev.level > maxDrop) {
        why.push(`band ${k + 1} at ${level.toFixed(1)} m is ${(level - prev.level).toFixed(1)} m over the one below (one wall holds ${maxDrop.toFixed(1)})`);
        break;
      }
      if (length < Math.max(minLength, depth * 0.6)) {
        why.push(`band ${k + 1} at ${level.toFixed(1)} m is only ${length.toFixed(0)} m long (stops: ${span.stops.join(" / ")})`);
        break;
      }
      if (bands.length && level - bands[0]!.level > input.maxRelief) {
        why.push(`band ${k + 1} at ${level.toFixed(1)} m is over the ${input.maxRelief} m relief limit`);
        break;
      }
      const band: PlannedBand = { a: at(span.a0, wc), b: at(span.a1, wc), a0: span.a0, a1: span.a1, w: wc, length, depth, level: r2(level), stops: span.stops };
      bands.push(band);
      capacity += length * usable;
      if (capacity >= input.required) {
        // trim the band just added to what is still needed (its longer arm first), never under a street's length
        const keep = Math.max(Math.max(minLength, depth * 0.6), length - (capacity - input.required) / usable);
        let cut = length - keep;
        if (cut > 0) {
          capacity -= cut * usable;
          let a0 = span.a0, a1 = span.a1;
          const fromRight = Math.min(cut, Math.max(0, a1 + a0));
          a1 -= fromRight;
          cut -= fromRight;
          const fromLeft = Math.min(cut, Math.max(0, -a0 - a1));
          a0 += fromLeft;
          cut -= fromLeft;
          a0 += cut / 2;
          a1 -= cut / 2;
          Object.assign(band, { a: at(a0, wc), b: at(a1, wc), a0, a1, length: a1 - a0 });
        }
        break;
      }
      wf = wf + depth + input.riser;
      if (k === input.maxTerraces - 1) why.push(`--max-terraces ${input.maxTerraces} reached`);
    }
    return { bands, capacity, why };
  };

  let best: { D: number; bands: PlannedBand[]; capacity: number; why: string[] } | null = null;
  for (const D of depths) {
    const r = tryDepth(D);
    const meets = r.capacity >= input.required;
    if (!best) best = { D, ...r };
    else {
      const bestMeets = best.capacity >= input.required;
      if (meets && (!bestMeets || r.bands.length < best.bands.length)) best = { D, ...r };
      else if (!meets && !bestMeets && r.capacity > best.capacity) best = { D, ...r };
    }
  }
  const b = best!;
  const ok = b.capacity >= input.required && b.bands.length > 0;
  const why = ok
    ? []
    : [
        `shelves hold ${Math.round(b.capacity)} of ${Math.round(input.required)} m2 (short ${Math.round(input.required - b.capacity)} m2) at ${b.D} m deep`,
        ...b.why,
        ...b.bands.map((x, i) => `band ${i + 1} at ${x.level} m: ${x.length.toFixed(0)} m long, ends stopped by ${x.stops.join(" / ")}`),
      ];
  return { ok, bands: b.bands, capacity: Math.round(b.capacity), required: Math.round(input.required), slope: r2(slope), downhill: [r2(downhill[0]), r2(downhill[1])], why };
}

/** The street a band carries: two-sided down the middle when two typical lots + a street fit, else along its seaward (downhill) edge. */
export function bandStreet(band: Pick<PlannedBand, "a" | "b" | "depth">, downhill: V2, acrossTypical: number, street: number, inset: number): { axis: V2; offset: number; width: number } {
  const l = Math.hypot(band.b[0] - band.a[0], band.b[1] - band.a[1]) || 1;
  const axis: V2 = [r2((band.b[0] - band.a[0]) / l), r2((band.b[1] - band.a[1]) / l)];
  const usable = band.depth - 2 * inset;
  if (usable >= 2 * acrossTypical + street) return { axis, offset: 0, width: street };
  // +offset is the axis's left ([-axis.z, axis.x]); the seaward edge is the side the hill falls to
  const left: V2 = [-axis[1], axis[0]];
  const sign = left[0] * downhill[0] + left[1] * downhill[1] >= 0 ? 1 : -1;
  return { axis, offset: r2(sign * (usable / 2 - street / 2)), width: street };
}

/**
 * The band a TerraceDoc carries: an edge street (offset != 0) gets the kerb — the band's seaward edge moves `kerb` m
 * further down the fall (centreline + kerb/2 seaward, depth + kerb), the street stays where it was in the world (its
 * offset from the moved centreline - kerb/2) and so do the uphill edge and the lots. A middle street is unchanged.
 */
export function kerbedBand(a: V2, b: V2, depth: number, street: { axis: V2; offset: number; width: number }, kerb: number = PROGRAM_RULE.kerb): { a: V2; b: V2; depth: number; street: { axis: V2; offset: number; width: number } } {
  if (!street.offset || kerb <= 0) return { a, b, depth, street };
  const sign = Math.sign(street.offset), left: V2 = [-street.axis[1], street.axis[0]], m = (sign * kerb) / 2;
  const sh = (p: V2): V2 => [r2(p[0] + left[0] * m), r2(p[1] + left[1] * m)];
  return { a: sh(a), b: sh(b), depth: r2(depth + kerb), street: { ...street, offset: r2(street.offset - m) } };
}

// ---------------------------------------------------------------- the measure (and the gate)

const distToPolyline = (pts: readonly (readonly [number, number])[], x: number, z: number): number => {
  if (pts.length === 1) return Math.hypot(x - pts[0]![0], z - pts[0]![1]);
  let best = Infinity;
  for (let i = 0; i + 1 < pts.length; i++) {
    const a = pts[i]!, b = pts[i + 1]!;
    const dx = b[0] - a[0], dz = b[1] - a[1], l2 = dx * dx + dz * dz || 1;
    const t = Math.max(0, Math.min(1, ((x - a[0]) * dx + (z - a[1]) * dz) / l2));
    best = Math.min(best, Math.hypot(x - a[0] - dx * t, z - a[1] - dz * t));
  }
  return best;
};
/** Inside a band: within `radius` of its centreline AND between its two end edges (a band is a street, not a capsule). */
function inBand(t: Pick<TerraceDoc, "points" | "radius">, x: number, z: number): boolean {
  if (distToPolyline(t.points, x, z) > t.radius) return false;
  if (t.points.length < 2) return true;
  const a = t.points[0]!, b = t.points[t.points.length - 1]!;
  const a1 = t.points[1]!, b1 = t.points[t.points.length - 2]!;
  const beyond = (p: readonly [number, number], q: readonly [number, number]) => (x - p[0]) * (p[0] - q[0]) + (z - p[1]) * (p[1] - q[1]) > 0;
  return !beyond(a, a1) && !beyond(b, b1);
}

/**
 * The level ground a town's shelves hold, measured on the BUILT field: 2 m samples inside a shelf's band (a one-point
 * shelf: its disc) whose ground is within `tol` of that shelf's height, dry and above the sea. This is what a lot can
 * stand on — risers, ramp cuts and the retaining-wall fit's inset are not counted.
 */
export function measureShelfFlat(field: Pick<WorldField, "height" | "waterY">, town: Pick<TownDoc, "terraces" | "center" | "radius" | "flatten" | "groundY">, sea: number, tol = 0.4, step = 2): { area: number; perShelf: Record<string, number> } {
  const shelves = town.terraces.length > 0 ? town.terraces : town.flatten > 0.5 ? [{ id: "pad", points: [town.center] as [number, number][], radius: town.radius, groundY: town.groundY ?? field.height(town.center[0], town.center[1]) }] : [];
  const perShelf: Record<string, number> = {};
  if (shelves.length === 0) return { area: 0, perShelf };
  let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
  for (const t of shelves) for (const p of t.points) { x0 = Math.min(x0, p[0] - t.radius); x1 = Math.max(x1, p[0] + t.radius); z0 = Math.min(z0, p[1] - t.radius); z1 = Math.max(z1, p[1] + t.radius); }
  let count = 0;
  for (let z = Math.floor(z0); z <= z1; z += step)
    for (let x = Math.floor(x0); x <= x1; x += step) {
      let hit: string | null = null;
      let g: number | null = null;
      for (const t of shelves) {
        if (!inBand(t as TerraceDoc, x, z)) continue;
        g ??= field.height(x, z);
        if (Math.abs(g - t.groundY) <= tol) { hit = t.id; break; }
      }
      if (!hit || g === null || g < sea + 0.5 || field.waterY(x, z) !== null) continue;
      count++;
      perShelf[hit] = (perShelf[hit] ?? 0) + step * step;
    }
  return { area: count * step * step, perShelf };
}

/** Band depth (2 x radius) of the deepest shelf. */
export function deepestShelf(town: Pick<TownDoc, "terraces" | "radius" | "flatten">): number {
  if (town.terraces.length === 0) return town.flatten > 0.5 ? 2 * town.radius : 0;
  return Math.max(...town.terraces.map((t) => 2 * t.radius));
}

/**
 * The `program-fit` gate: every town with a plan (or a `program` the terrace stage recorded) against its measured
 * flat ground. One line per fault; empty = every program fits. The plan on disk wins over the recorded number, so a
 * plan grown after the terrace stage fails here before the freeze.
 */
export function programFitFindings(recipe: WorldRecipe, field: Pick<WorldField, "height" | "waterY">, projectDir: string | null, only?: (town: TownDoc) => boolean): string[] {
  const out: string[] = [];
  for (const town of recipe.features.towns) {
    if (only && !only(town)) continue;
    const fromPlan = projectDir ? loadTownProgram(projectDir, town.id, recipe.name) : null;
    const required = fromPlan?.area ?? town.program?.area;
    if (!required) continue;
    const across = fromPlan?.across ?? town.program?.across ?? 0;
    const flat = measureShelfFlat(field, town, recipe.seaLevel);
    const how = `worldgen terrace ${recipe.name} --town ${town.id}`;
    if (flat.area < required)
      out.push(`${town.id}: its program needs ${required} m2 of flat ground (${fromPlan?.lots ?? town.program?.lots ?? "?"} lots, ${fromPlan ? fromPlan.source : "recipe program"}), its shelves hold ${flat.area} m2 (short ${required - flat.area}): ${how}`);
    const deep = deepestShelf(town);
    if (across > 0 && deep < across + PROGRAM_RULE.street)
      out.push(`${town.id}: its deepest lot needs a band ${r1(across + PROGRAM_RULE.street)} m deep (lot ${across} m across + a ${PROGRAM_RULE.street} m street), its deepest shelf is ${r1(deep)} m: ${how}`);
  }
  return out;
}

function r1(v: number): number {
  return Math.round(v * 10) / 10;
}
function r2(v: number): number {
  return Math.round(v * 100) / 100;
}

// ---------------------------------------------------------------- the land gate of a program town

/**
 * A coastal program town's land gate, off one END of its top band (2026-10-29, s1f).
 *
 * The gate `towns` writes sits on the pad circle facing straight up the fall line, so the road left the top shelf
 * through the cut bank behind it: Saltharrow's gate road climbed 24 % (37 % over the first 4 m at the apron). A band's
 * ENDS are where the hill comes back to the shelf's level (it grew until the ground left it), so the gate stands at
 * one end, turned off the landward line toward that end by up to 55 deg (it stays a landward gate: `gateIsLandward`
 * wants 60), whichever end and turn needs the gentlest straight lead to meet the natural ground over the approach.
 */
export function programLandGate(
  recipe: WorldRecipe,
  town: Pick<TownDoc, "center" | "gates">,
  plan: Pick<ShelfPlan, "bands" | "downhill">,
  height: (x: number, z: number) => number,
  opts: { width?: number; approach?: number; maxTurn?: number } = {},
): { gate: TownGateDoc; grade: number; end: "first" | "last" } {
  const width = opts.width ?? town.gates.find((g) => g.id === "land-gate")?.width ?? 6;
  const approach = opts.approach ?? town.gates.find((g) => g.id === "land-gate")?.approach ?? 30;
  const maxTurn = ((opts.maxTurn ?? 55) * Math.PI) / 180;
  const top = [...plan.bands].sort((p, q) => q.level - p.level)[0]!;
  const shore = nearestShore(recipe, town.center[0], town.center[1]);
  let landward: V2 = [town.center[0] - shore.point[0], town.center[1] - shore.point[1]];
  const ll = Math.hypot(landward[0], landward[1]);
  landward = ll > 1e-6 ? [landward[0] / ll, landward[1] / ll] : [-plan.downhill[0], -plan.downhill[1]];
  const axis: V2 = [(top.b[0] - top.a[0]) / (top.length || 1), (top.b[1] - top.a[1]) / (top.length || 1)];
  let best: { gate: TownGateDoc; grade: number; end: "first" | "last" } | null = null;
  for (const [end, at0, out] of [["first", top.a, [-axis[0], -axis[1]]], ["last", top.b, axis]] as ["first" | "last", V2, V2][]) {
    // turn the landward line toward this end
    const cross = landward[0] * out[1] - landward[1] * out[0];
    for (let deg = 0; deg <= (maxTurn * 180) / Math.PI + 1e-9; deg += 5) {
      const t = ((deg * Math.PI) / 180) * Math.sign(cross || 1);
      const f: V2 = [landward[0] * Math.cos(t) - landward[1] * Math.sin(t), landward[0] * Math.sin(t) + landward[1] * Math.cos(t)];
      if (f[0] * out[0] + f[1] * out[1] < -1e-6) continue; // never back across the band
      // the gate stands inside the band's end, 1 m in from its edge along f
      const reachIn = Math.min(top.depth / 2 - 1, 6);
      const at: V2 = [at0[0] + f[0] * reachIn, at0[1] + f[1] * reachIn];
      if (!gateIsLandward(town, { at, facing: f }, landward)) continue;
      // the grade a straight lead from the shelf level needs to meet the hill at each distance out (0.5 m of give)
      let grade = 0;
      for (let d = 4; d <= approach + 1e-9; d += 2) grade = Math.max(grade, Math.max(0, Math.abs(height(at[0] + f[0] * d, at[1] + f[1] * d) - top.level) - 0.5) / d);
      // and the hill's own grade along the lead beyond that
      for (let d = 4; d + 4 <= approach + 1e-9; d += 2) grade = Math.max(grade, Math.abs(height(at[0] + f[0] * (d + 4), at[1] + f[1] * (d + 4)) - height(at[0] + f[0] * d, at[1] + f[1] * d)) / 4);
      if (!best || grade < best.grade - 1e-6) {
        best = { gate: { id: "land-gate", at: [r2(at[0]), r2(at[1])], facing: [r2(f[0]), r2(f[1])], width, approach, tags: ["coastal", "program"] }, grade, end };
      }
    }
  }
  if (!best) {
    const at: V2 = [r2(top.a[0] + (top.b[0] - top.a[0]) / 2 + landward[0] * (top.depth / 2 - 1)), r2(top.a[1] + (top.b[1] - top.a[1]) / 2 + landward[1] * (top.depth / 2 - 1))];
    best = { gate: { id: "land-gate", at, facing: [r2(landward[0]), r2(landward[1])], width, approach, tags: ["coastal", "program"] }, grade: Infinity, end: "first" };
  }
  return best;
}

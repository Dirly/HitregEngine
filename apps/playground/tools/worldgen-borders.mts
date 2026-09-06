/**
 * Zone borders against the real world: the classifier `worldgen barriers`
 * and the `worldgen regions` audit share, and the plan the barriers stage
 * writes (docs/world-editing/barriers.md).
 *
 * The geometry (shared edges, open runs, passes, ridge pieces) is pure and
 * lives in `@hitreg/core` (`borders.ts`, unit-tested with a fake
 * classifier). This file supplies the classifier that needs the field —
 * water, canyon, steep, coast, ridge, town — and turns the plan into
 * recipe features: `ridges` with per-point crest heights measured off the
 * higher flank, and a `waystation` poi per pass.
 */

import {
  allSharedBorders,
  classBreakdown,
  classifyChain,
  guaranteedPass,
  openRuns,
  passWidthFor,
  passesOnRun,
  pointInPolygon,
  ridgePieces,
  simplifyPolyline,
  type BorderClass,
  type BorderSample,
  type ClassifiedSample,
  type OpenRun,
  type PassPlan,
  type PoiDoc,
  type RegionDoc,
  type RidgeDoc,
  type WorldField,
  type WorldRecipe,
} from "@hitreg/core";

type P = readonly [number, number];

function segDist(x: number, z: number, a: P, b: P): number {
  const dx = b[0] - a[0];
  const dz = b[1] - a[1];
  const l = dx * dx + dz * dz;
  const t = l < 1e-9 ? 0 : Math.max(0, Math.min(1, ((x - a[0]) * dx + (z - a[1]) * dz) / l));
  return Math.hypot(x - (a[0] + dx * t), z - (a[1] + dz * t));
}

function polylineDist(points: readonly P[], x: number, z: number): number {
  let best = Infinity;
  for (let i = 0; i + 1 < points.length; i++) best = Math.min(best, segDist(x, z, points[i]!, points[i + 1]!));
  return best;
}

export interface ClassifierOptions {
  /** Ridge geometry the stage would write (existing ridges are matched at this reach). */
  ridge: { width: number; falloff: number };
  /** Slope (0..1, sin of the angle) above which ground is "steep" (default 0.7 ≈ 35°). */
  steepSlope?: number;
  /** Height difference across ±`across` metres perpendicular to the border that counts as steep (default 18 over ±25). */
  steepDrop?: number;
  across?: number;
}

/**
 * The lowest height at which the recipe paints snow — the snow line — or
 * the ceiling when no biome is snow-topped. A ridge is never raised past
 * this plus 40 m: the generator has no `snowLine` field, the biome height
 * windows are where it lives (zone-gated biomes such as tundra are snow by
 * latitude and do not count).
 */
export function snowLineOf(recipe: WorldRecipe): number {
  let line = Infinity;
  for (const biome of recipe.biomes) {
    let top = -1;
    let w = 0;
    biome.surface.forEach((v, i) => {
      if (v > w) {
        w = v;
        top = i;
      }
    });
    // a biome gated to climate zones (tundra) is snow by latitude, not altitude: not a snow LINE
    if (top < 0 || recipe.surfaces[top]?.name.toLowerCase() !== "snow" || !biome.height || (biome.zones && biome.zones.length > 0)) continue;
    line = Math.min(line, biome.height[0]);
  }
  if (Number.isFinite(line)) return line;
  return recipe.terrain.ceiling?.height ?? recipe.maxY;
}

/** The field-backed classifier: what a border sample is standing on. */
export function borderClassifier(field: WorldField, recipe: WorldRecipe, opts: ClassifierOptions): (s: BorderSample) => BorderClass {
  const sea = recipe.seaLevel;
  const limit = field.worldLimit;
  const steepSlope = opts.steepSlope ?? 0.7;
  const steepDrop = opts.steepDrop ?? 18;
  const across = opts.across ?? 25;
  const canyons = recipe.features.canyons.map((c) => ({ points: c.points, reach: c.width / 2 + c.rim }));
  const ridges = recipe.features.ridges.map((r) => ({ points: r.points, reach: r.width / 2 + r.falloff }));
  const towns = recipe.features.towns.map((t) => ({ x: t.center[0], z: t.center[1], reach: t.radius + t.falloff }));
  return (s) => {
    const { x, z } = s;
    if (limit !== Infinity && x * x + z * z > limit * limit) return "coast";
    const h = field.height(x, z);
    if (h <= sea + 2) return "coast";
    if (field.waterY(x, z) !== null || field.shoreDistance(x, z) < 6) return "water";
    for (const t of towns) if (Math.hypot(x - t.x, z - t.z) <= t.reach) return "town";
    for (const c of canyons) if (polylineDist(c.points, x, z) <= c.reach) return "canyon";
    for (const r of ridges) if (polylineDist(r.points, x, z) <= r.reach) return "ridge";
    if (field.slope(x, z) > steepSlope) return "steep";
    // a ridge line you cannot see over, not a hillside you can: measure across the border
    const nx = -s.dz;
    const nz = s.dx;
    const left = field.height(x + nx * across, z + nz * across);
    const right = field.height(x - nx * across, z - nz * across);
    if (Math.abs(left - right) > steepDrop || Math.max(left, right) - h > steepDrop) return "steep";
    return "open";
  };
}

export interface BorderPairReport {
  a: string;
  b: string;
  /** Metres of shared border (all chains). */
  length: number;
  /** Metres by class before any ridge is written. */
  classes: Record<BorderClass, number>;
  /** Open runs of at least `minRun` metres (findings until built). */
  runs: Array<{ length: number; from: [number, number]; to: [number, number]; run: OpenRun }>;
  /** Passes on this pair's border: planned by the stage, or existing `pass-*` pois when auditing. */
  passes: Array<{ x: number; z: number; source: PassPlan["source"] | "existing"; paths: string[]; id?: string }>;
  /** Whether any path crosses this pair's border anywhere (open or not). */
  crossed: boolean;
  /** True for a cut-out (town zone) and its parent: no ridge is ever built there. */
  town: boolean;
}

export interface BorderReportOptions {
  sample?: number;
  tolerance?: number;
  minRun?: number;
  ridge: { width: number; falloff: number };
  path: { width: number; shoulder: number };
  classify: (s: BorderSample) => BorderClass;
  /** Passes already in the recipe (`pass-*` pois), listed on their pair. */
  existingPasses?: readonly PoiDoc[];
}

/**
 * Measure every shared border: length, class breakdown, open runs, passes.
 * The audit prints this; the stage builds from it.
 */
export function borderReport(regions: readonly RegionDoc[], paths: ReadonlyArray<{ id: string; points: readonly P[] }>, opts: BorderReportOptions): BorderPairReport[] {
  const step = opts.sample ?? 15;
  const tolerance = opts.tolerance ?? 2;
  const minRun = opts.minRun ?? 60;
  const passWidth = passWidthFor(opts.ridge, opts.path);
  const byId = new Map(regions.map((r) => [r.id, r]));
  const chains = allSharedBorders(regions, step, tolerance);
  const pairs = new Map<string, BorderPairReport>();
  for (const chain of chains) {
    const key = `${chain.a}/${chain.b}`;
    const town = byId.get(chain.a)?.within === chain.b || byId.get(chain.b)?.within === chain.a;
    let report = pairs.get(key);
    if (!report) {
      report = { a: chain.a, b: chain.b, length: 0, classes: { water: 0, canyon: 0, steep: 0, coast: 0, ridge: 0, town: 0, pass: 0, open: 0 }, runs: [], passes: [], crossed: false, town };
      pairs.set(key, report);
    }
    const classified: ClassifiedSample[] = town ? chain.samples.map((s) => ({ ...s, cls: "town" as const })) : classifyChain(chain, opts.classify);
    // ground inside an existing pass is open by construction: listed, not flagged
    for (const s of classified) {
      if (s.cls !== "open") continue;
      for (const poi of opts.existingPasses ?? []) {
        if (Math.hypot(s.x - poi.position[0], s.z - poi.position[2]) <= passWidth / 2) {
          s.cls = "pass";
          break;
        }
      }
    }
    report.length += chain.length;
    const breakdown = classBreakdown(classified, step);
    for (const k of Object.keys(breakdown) as BorderClass[]) report.classes[k] += breakdown[k];
    // any path within half a pass width of any sample: this pair is crossed somewhere
    const whole: OpenRun = { start: 0, end: classified.length - 1, length: chain.length, samples: classified };
    const crossings = passesOnRun(whole, paths, passWidth);
    if (crossings.length > 0) report.crossed = true;
    if (town) {
      // gates: where a path leaves town through its zone border
      for (const c of crossings) report.passes.push({ x: c.x, z: c.z, source: "path", paths: c.paths });
      continue;
    }
    for (const run of openRuns(classified, step, minRun)) {
      report.runs.push({ length: run.length, from: [run.samples[0]!.x, run.samples[0]!.z], to: [run.samples[run.samples.length - 1]!.x, run.samples[run.samples.length - 1]!.z], run });
    }
  }
  for (const poi of opts.existingPasses ?? []) {
    const zones = poi.tags.filter((t) => t.startsWith("zone:")).map((t) => t.slice(5));
    const report = pairs.get(`${zones[0]}/${zones[1]}`) ?? pairs.get(`${zones[1]}/${zones[0]}`);
    if (report) report.passes.push({ x: poi.position[0], z: poi.position[2], source: "existing", paths: [], id: poi.id });
  }
  return [...pairs.values()].sort((p, q) => (p.a === q.a ? p.b.localeCompare(q.b) : p.a.localeCompare(q.a)));
}

export interface BarrierPlanOptions extends BorderReportOptions {
  height: number;
  /** The recipe's terrain (crest heights are measured off it). */
  field: WorldField;
  /** Never raise a crest above this. */
  heightCap: number;
  sanctuaryRadius: number;
  safe: boolean;
  /** Lake outlines: samples inside one are skipped entirely. */
  lakes: ReadonlyArray<{ polygon?: readonly P[] | undefined; center?: readonly [number, number] | undefined; radius?: number | undefined }>;
}

export interface BarrierPlan {
  report: BorderPairReport[];
  ridges: RidgeDoc[];
  pois: PoiDoc[];
  /** Per pair: the passes planned, for the log. */
  passes: Array<{ a: string; b: string; pass: PassPlan; id: string }>;
}

/**
 * Turn open runs into ridges and passes. A run gets a pass wherever a path
 * crosses it; a pair no path crosses anywhere gets one pass at the
 * midpoint of its longest run; a town zone's border gets a waystation at
 * every gate and no ridge.
 */
export function planBarriers(regions: readonly RegionDoc[], paths: ReadonlyArray<{ id: string; points: readonly P[] }>, opts: BarrierPlanOptions): BarrierPlan {
  const step = opts.sample ?? 15;
  const minRun = opts.minRun ?? 60;
  const passWidth = passWidthFor(opts.ridge, opts.path);
  const report = borderReport(regions, paths, { ...opts, existingPasses: [] });
  const ridges: RidgeDoc[] = [];
  const pois: PoiDoc[] = [];
  const passes: BarrierPlan["passes"] = [];
  const inLake = (x: number, z: number): boolean =>
    opts.lakes.some((l) => (l.polygon ? pointInPolygon(x, z, l.polygon) : l.center && l.radius !== undefined ? Math.hypot(x - l.center[0], z - l.center[1]) <= l.radius : false));
  const tags = (a: string, b: string, extra: string[]): string[] => [...extra, ...(opts.safe ? ["safe"] : []), `zone:${a}`, `zone:${b}`];
  const passPoi = (a: string, b: string, n: number, p: PassPlan, extra: string[]): PoiDoc => {
    const id = `pass-${a}-${b}-${n}`;
    passes.push({ a, b, pass: p, id });
    return {
      id,
      kind: "waystation",
      position: [Math.round(p.x * 10) / 10, Math.round(opts.field.height(p.x, p.z) * 10) / 10, Math.round(p.z * 10) / 10],
      rotationY: Math.round(Math.atan2(-p.dx, -p.dz) * 1000) / 1000,
      radius: opts.sanctuaryRadius,
      tags: tags(a, b, extra),
    };
  };
  for (const pair of report) {
    let n = 0;
    if (pair.town) {
      // gates as passes: the sanctuary extends `radius` outside the gate; no ridge on a town border
      for (const gate of pair.passes) pois.push(passPoi(pair.a, pair.b, ++n, { x: gate.x, z: gate.z, along: 0, width: passWidth, dx: 0, dz: 1, source: "path", paths: gate.paths }, ["pass", "gate"]));
      continue;
    }
    if (pair.runs.length === 0) continue;
    const longest = pair.runs.reduce((best, r) => (r.length > best.length ? r : best), pair.runs[0]!);
    let ridgeNo = 0;
    for (const entry of pair.runs) {
      const run = entry.run;
      const planned = passesOnRun(run, paths, passWidth);
      if (!pair.crossed && entry === longest) planned.push(guaranteedPass(run, passWidth));
      planned.sort((p, q) => p.along - q.along);
      for (const p of planned) pois.push(passPoi(pair.a, pair.b, ++n, p, ["pass"]));
      // a run is measured in samples, a piece in the intervals between them: a run
      // of exactly minRun is minRun - step of intervals and still wants its wall
      for (const piece of ridgePieces(run, planned, step, Math.max(step, minRun - step))) {
        const kept = piece.filter((s) => !inLake(s.x, s.z));
        if (kept.length < 2) continue;
        const points = simplifyPolyline(
          kept.map((s) => [s.x, s.z] as [number, number]),
          opts.ridge.width / 2, // the crest is that wide: a corner cut by half a crest still covers the border
        );
        const heights = points.map(([x, z]) => crestHeightAt(opts.field, x, z, opts.ridge, opts.height, opts.heightCap));
        ridges.push({
          id: `barrier-${pair.a}-${pair.b}-${++ridgeNo}`,
          points: points.map(([x, z]) => [Math.round(x * 10) / 10, Math.round(z * 10) / 10] as [number, number]),
          height: opts.height,
          width: opts.ridge.width,
          falloff: opts.ridge.falloff,
          heights: heights.map((h) => Math.round(Math.max(0, h) * 10) / 10),
          tags: ["barrier", `zone:${pair.a}`, `zone:${pair.b}`],
        });
      }
    }
  }
  return { report, ridges, pois, passes };
}

/**
 * Crest height at a ridge point so the crest sits `height` above the HIGHER
 * of the two flanks measured `falloff` out on either side (the flank
 * direction is the ground's gradient, which is where the view is from),
 * clamped under `cap` and under three times `height` (a cliff foot is
 * not a place for a 300 m wall). 0 when the ground is already at the cap.
 */
export function crestHeightAt(field: WorldField, x: number, z: number, ridge: { width: number; falloff: number }, height: number, cap: number): number {
  const h = field.height(x, z);
  const out = ridge.width / 2 + ridge.falloff;
  let flank = -Infinity;
  for (let k = 0; k < 8; k++) {
    const a = (k / 8) * Math.PI * 2;
    flank = Math.max(flank, field.height(x + Math.cos(a) * out, z + Math.sin(a) * out));
  }
  // tie into a higher flank, but never build a wall the size of the
  // mountain beside it: at a cliff foot the "higher flank" is the cliff
  const crest = Math.min(Math.max(flank, h) + height - h, height * 3);
  // never above the cap — unless the ground already is, where the smallest
  // ridge that still reads as one is better than an open plateau
  return Math.min(crest, Math.max(height, cap - h));
}

/** Strip everything an earlier barriers run wrote, so the stage is idempotent. */
export function stripBarrierFeatures(recipe: WorldRecipe): { ridges: number; pois: number } {
  const ridgesBefore = recipe.features.ridges.length;
  const poisBefore = recipe.features.pois.length;
  recipe.features.ridges = recipe.features.ridges.filter((r) => !r.id.startsWith("barrier-"));
  recipe.features.pois = recipe.features.pois.filter((p) => !p.id.startsWith("pass-"));
  return { ridges: ridgesBefore - recipe.features.ridges.length, pois: poisBefore - recipe.features.pois.length };
}

/**
 * worldgen relief — re-tune the recipe's own relief bands to the LANDMASS, and the altitude-ladder rules.
 *
 *   relief <world> --scale <km> [--target 140] [--anchor-relief 0.3] [--mask-start s --mask-end e] [--dry]
 *   relief <world> --report                                  the ladder as it is, nothing written
 *
 * Why: the continental preset's bands (`terrain.continent` / `mountains` / `mountainMask` / `mesas`) are tuned for a
 * ~7 km continent. On a 2.3 km island the mountain mask (frequency 0.0013, start 0.52) is one slow swell that never
 * opens, so the island came out as a PLATE: p50 57 m, p90 74 m, a cliff spike for a max, every site on the rim — and it
 * passed every gate (firstshore, 2026-10-28). `--scale` multiplies those frequencies by (7 / scale) so the landmass
 * holds as many swells as the continent did, then bisects `mountains.amplitude` until the land's p98 reaches
 * `--target` metres over the sea. It never touches the hills band (that is local texture) or the coast.
 *
 * The rules (`worldgen status`, on the `zones` row — docs/voxel-worlds.md §22 "The altitude ladder"):
 *   relief    a zone's land must climb RELIEF_MIN_M from its low ground (p05) to its high ground (p98), and at least
 *             UPLAND_SHARE_MIN of it must stand UPLAND_RISE_M over its lowland (p10): a plate with one cliff spike fails
 *   interior  a zone must hold INTERIOR_LAKES_MIN lake(s) away from the sea and WOODLAND_SHARE_MIN of its land must be
 *             woodland (expected tree density from the scatter rules, before clumping, with the region's vegetation plan)
 *
 * Everything here is pure over a height sampler so it is testable; the host (worldgen.mts) supplies files and the field.
 */

import { continentalWorldRecipe, createWorldField, pointInPolygon, vegetationIndex, worldRecipeSchema, type VegetationIndex, type WorldField, type WorldRecipe } from "@hitreg/core";

export interface ReliefHost {
  argv: string[];
  loadRecipe(): { recipe: WorldRecipe; file: string };
  writeRecipe(recipe: WorldRecipe, file: string): void;
  fail(message: string): never;
}

/** The scale the continental preset's relief bands were tuned at (Skelmorrow: 7 x 6 km). */
export const REFERENCE_KM = 7;
/** Height band of the altitude ladder, m. */
export const BAND_M = 20;
/** A zone's land must climb this much from its p05 to its p98 (quantiles, so one cliff spike is not relief). */
export const RELIEF_MIN_M = 100;
/** ...and this share of its land must stand UPLAND_RISE_M over its lowland (p10). */
export const UPLAND_RISE_M = 60;
export const UPLAND_SHARE_MIN = 0.15;
/** Lakes a zone's interior needs (centre further than INTERIOR_SHORE_M from the sea). */
export const INTERIOR_LAKES_MIN = 1;
export const INTERIOR_SHORE_M = 150;
/** Share of a zone's land that must be woodland. */
export const WOODLAND_SHARE_MIN = 0.15;
/** Expected trees per m² (before clumping) at which ground counts as woodland: one tree per ~13 x 13 m. */
export const WOODLAND_DENSITY = 0.006;
/** A scatter rule is a TREE when it has wind (a plant) and a collider at least this tall. */
export const TREE_COLLIDER_M = 4;
/**
 * The generator's relief defaults (2026-10-28 ruling: the world is ALGORITHM-driven in this phase; nothing below is a
 * hand value in a recipe — `worldgen continents` derives them from the land it laid, `worldgen relief` re-derives them).
 */
/** Target p98 of the land over the sea: 1.5 x the `relief` rule's floor, so a landmass passes the rule with margin. */
export const RELIEF_TARGET_P98_M = RELIEF_MIN_M * 1.5;
/** Mountain-mask window: the mask noise (0..1) opens the ridged band between these — 0.45/0.8 gives one upland core per swell. */
export const MASK_START_DEFAULT = 0.45;
export const MASK_END_DEFAULT = 0.8;
/** Every zone anchor keeps at least this much relief: an anchor at 0 flattens the upland under it into a plate. */
export const ANCHOR_RELIEF_MIN = 0.3;
/** When the p98 target leaves too little upland (a spike, not a massif), the target rises by this much per round. */
export const UPLAND_TARGET_STEP_M = 15;

const r1 = (v: number): number => Math.round(v * 10) / 10;
const pct = (v: number): string => `${(v * 100).toFixed(1)}%`;

function opt(argv: string[], name: string): string | null {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1]! : null;
}
function num(argv: string[], name: string, fallback: number): number {
  const v = opt(argv, name);
  const n = v === null ? NaN : Number(v);
  return Number.isFinite(n) ? n : fallback;
}

// ---------------------------------------------------------------- the ladder

export interface Ladder {
  /** land samples */
  count: number;
  min: number;
  p05: number;
  p10: number;
  p50: number;
  p90: number;
  p98: number;
  max: number;
  /** p98 - p05: the relief the land actually spreads over */
  relief: number;
  /** share of land standing UPLAND_RISE_M over p10 */
  uplandShare: number;
  /** [band start m, share of land] from the sea up, BAND_M wide */
  bands: [number, number][];
}

/** The ladder of a set of land heights (metres over the sea). Pure. */
export function altitudeLadder(heightsOverSea: readonly number[]): Ladder {
  const h = [...heightsOverSea].sort((a, b) => a - b);
  const n = h.length;
  const q = (f: number): number => (n === 0 ? 0 : h[Math.min(n - 1, Math.max(0, Math.floor(f * (n - 1))))]!);
  const p10 = q(0.1);
  let upland = 0;
  const counts = new Map<number, number>();
  for (const v of h) {
    if (v >= p10 + UPLAND_RISE_M) upland++;
    const band = Math.max(0, Math.floor(v / BAND_M) * BAND_M);
    counts.set(band, (counts.get(band) ?? 0) + 1);
  }
  const bands = [...counts.entries()].sort((a, b) => a[0] - b[0]).map(([band, c]) => [band, c / Math.max(1, n)] as [number, number]);
  return { count: n, min: q(0), p05: q(0.05), p10, p50: q(0.5), p90: q(0.9), p98: q(0.98), max: q(1), relief: q(0.98) - q(0.05), uplandShare: n ? upland / n : 0, bands };
}

/** The relief rule on one ladder: findings, empty when it passes. Pure. */
export function reliefFindings(ladder: Ladder, label: string): string[] {
  const out: string[] = [];
  if (ladder.count === 0) return [`${label}: no land sampled`];
  if (ladder.relief < RELIEF_MIN_M) out.push(`${label}: relief ${r1(ladder.relief)} m from its low ground (p05 ${r1(ladder.p05)}) to its high ground (p98 ${r1(ladder.p98)}), under ${RELIEF_MIN_M} m — a plate`);
  if (ladder.uplandShare < UPLAND_SHARE_MIN) out.push(`${label}: ${pct(ladder.uplandShare)} of its land stands ${UPLAND_RISE_M} m over its lowland (p10 ${r1(ladder.p10)}), under ${pct(UPLAND_SHARE_MIN)} — no upland`);
  return out;
}

export function describeLadder(l: Ladder): string {
  const bands = l.bands.map(([b, s]) => `${b}-${b + BAND_M}: ${pct(s)}`).join("  ");
  return `land p05/p10/p50/p90/p98/max ${r1(l.p05)} / ${r1(l.p10)} / ${r1(l.p50)} / ${r1(l.p90)} / ${r1(l.p98)} / ${r1(l.max)} m; relief ${r1(l.relief)} m; upland (${UPLAND_RISE_M} m over p10) ${pct(l.uplandShare)}\n    bands: ${bands}`;
}

// ---------------------------------------------------------------- sampling the world

/** Sample points over a polygon (or the whole bounded world) at a step that yields ~`target` samples. */
export function samplePoints(recipe: WorldRecipe, polygon: readonly (readonly [number, number])[] | null, target = 2500): { points: [number, number][]; step: number } {
  let minX: number, maxX: number, minZ: number, maxZ: number;
  if (polygon && polygon.length >= 3) {
    minX = Math.min(...polygon.map((p) => p[0]));
    maxX = Math.max(...polygon.map((p) => p[0]));
    minZ = Math.min(...polygon.map((p) => p[1]));
    maxZ = Math.max(...polygon.map((p) => p[1]));
  } else {
    const limit = recipe.bounds?.limit ?? 3000;
    minX = minZ = -limit;
    maxX = maxZ = limit;
  }
  const area = Math.max(1, (maxX - minX) * (maxZ - minZ));
  const step = Math.max(8, Math.sqrt(area / target));
  const points: [number, number][] = [];
  for (let z = minZ + step / 2; z < maxZ; z += step) for (let x = minX + step / 2; x < maxX; x += step) {
    if (polygon && polygon.length >= 3 && !pointInPolygon(x, z, polygon)) continue;
    points.push([x, z]);
  }
  return { points, step };
}

/** Land heights over the sea inside a polygon (null = the whole world), lakes and the sea excluded. */
export function landHeights(recipe: WorldRecipe, field: WorldField, polygon: readonly (readonly [number, number])[] | null, target = 2500): number[] {
  const { points } = samplePoints(recipe, polygon, target);
  const sea = recipe.seaLevel;
  const limit = field.worldLimit;
  const out: number[] = [];
  for (const [x, z] of points) {
    if (limit !== Infinity && x * x + z * z > limit * limit) continue;
    const h = field.height(x, z);
    if (h <= sea + 0.5) continue;
    out.push(h - sea);
  }
  return out;
}

/** The zone regions of a recipe: not a town zone, not a place. */
export function zoneRegions(recipe: WorldRecipe): WorldRecipe["regions"] {
  return recipe.regions.filter((r) => r.within === undefined && !r.tags.includes("town") && !r.tags.includes("place"));
}

// ---------------------------------------------------------------- trees and woodland

type ScatterRule = WorldRecipe["scatter"][number];

/** The scatter rules that are trees: a plant (wind) with a collider TREE_COLLIDER_M or taller. */
export function treeRules(recipe: WorldRecipe): { rule: ScatterRule; index: number }[] {
  return recipe.scatter
    .map((rule, index) => ({ rule, index }))
    .filter(({ rule }) => !!rule.wind && rule.density > 0 && rule.biomes.length > 0 && (rule.colliderSize?.[1] ?? 0) >= TREE_COLLIDER_M);
}

/** Every scatter rule that stands taller than `minH` m (trees AND boulders): what blocks a camera's near view. */
export function tallScatterRules(recipe: WorldRecipe, minH = 2): { rule: ScatterRule; index: number }[] {
  return recipe.scatter.map((rule, index) => ({ rule, index })).filter(({ rule }) => rule.density > 0 && rule.biomes.length > 0 && (rule.colliderSize?.[1] ?? 0) >= minH);
}

export interface TreeSampler {
  /**
   * Expected trees per m² at (x, z) with ground `h`, before clumping; 0 under water, on a cleared plot, or too steep.
   * `perRule` (length trees.length) receives each tree rule's share (the map colours pine / broadleaf / scrub by it).
   */
  density(x: number, z: number, h?: number, perRule?: Float32Array): number;
  trees: { rule: ScatterRule; index: number }[];
}

/**
 * Expected tree density from the rules themselves — the biome memberships at the point, each tree rule's
 * `density` x `biomeDensity[biome]`, its slope and height windows, the region's vegetation plan and clearings.
 * Clumping is not applied (it moves trees into groves; the share of woodland is what this measures).
 */
export function treeSampler(recipe: WorldRecipe, field: WorldField, veg: VegetationIndex = vegetationIndex(recipe), rules: { rule: ScatterRule; index: number }[] = treeRules(recipe)): TreeSampler {
  const trees = rules;
  const biomeIndex = new Map(recipe.biomes.map((b, i) => [b.id, i] as const));
  const sea = recipe.seaLevel;
  const perRule = trees.map(({ rule }) => rule.biomes.map((id) => ({ i: biomeIndex.get(id) ?? -1, gain: rule.biomeDensity?.[id] ?? 1 })).filter((b) => b.i >= 0));
  return {
    trees,
    density(x, z, h, out) {
      if (out) out.fill(0);
      const ground = h ?? field.height(x, z);
      if (ground <= sea + 0.5) return 0;
      const water = field.waterY(x, z);
      if (water !== null && water > ground) return 0;
      const slope = field.slope(x, z);
      const sample = field.biome(x, z, ground, slope);
      const plan = veg.planAt(x, z);
      const keep = veg.clearingKeep(x, z, 0, 0);
      if (keep <= 0) return 0;
      let d = 0;
      for (let k = 0; k < trees.length; k++) {
        const { rule, index } = trees[k]!;
        if (slope > rule.slopeMax || slope < rule.slopeMin) continue;
        if (rule.height && (ground < rule.height[0] || ground > rule.height[1])) continue;
        const mult = plan ? plan.ruleKeep[index]! : 1;
        if (mult <= 0) continue;
        let membership = 0;
        for (const b of perRule[k]!) membership += sample.weights[b.i]! * b.gain;
        const dk = rule.density * membership * Math.min(1, mult) * keep;
        if (out) out[k] = dk;
        d += dk;
      }
      return d;
    },
  };
}

/** Share of a polygon's land that is woodland (tree density >= WOODLAND_DENSITY). */
export function woodlandShare(recipe: WorldRecipe, field: WorldField, polygon: readonly (readonly [number, number])[] | null, sampler = treeSampler(recipe, field), target = 1600): { share: number; land: number } {
  const { points } = samplePoints(recipe, polygon, target);
  const sea = recipe.seaLevel;
  const limit = field.worldLimit;
  let land = 0;
  let wood = 0;
  for (const [x, z] of points) {
    if (limit !== Infinity && x * x + z * z > limit * limit) continue;
    const h = field.height(x, z);
    if (h <= sea + 0.5) continue;
    const water = field.waterY(x, z);
    if (water !== null && water > h) continue;
    land++;
    if (sampler.density(x, z, h) >= WOODLAND_DENSITY) wood++;
  }
  return { share: land ? wood / land : 0, land };
}

/** Lakes whose centre lies in the polygon and stands INTERIOR_SHORE_M from the sea in every direction. */
export function interiorLakes(recipe: WorldRecipe, field: WorldField, polygon: readonly (readonly [number, number])[]): WorldRecipe["features"]["lakes"] {
  const sea = recipe.seaLevel;
  return recipe.features.lakes.filter((lake) => {
    const [cx, cz] = lake.center;
    if (!pointInPolygon(cx, cz, polygon)) return false;
    for (let a = 0; a < 16; a++) {
      const x = cx + Math.cos((a / 16) * Math.PI * 2) * INTERIOR_SHORE_M;
      const z = cz + Math.sin((a / 16) * Math.PI * 2) * INTERIOR_SHORE_M;
      if (field.height(x, z) <= sea) return false;
    }
    return true;
  });
}

// ---------------------------------------------------------------- the status rules

/** The `relief` rule over every zone: findings, empty when every zone climbs its ladder. */
export function zoneReliefFindings(recipe: WorldRecipe, field: WorldField): string[] {
  const out: string[] = [];
  for (const zone of zoneRegions(recipe)) out.push(...reliefFindings(altitudeLadder(landHeights(recipe, field, zone.polygon)), zone.name || zone.id));
  return out;
}

/** The `interior` rule over every zone: lakes away from the sea and a woodland share. */
export function zoneInteriorFindings(recipe: WorldRecipe, field: WorldField): string[] {
  const out: string[] = [];
  const sampler = treeSampler(recipe, field);
  for (const zone of zoneRegions(recipe)) {
    const label = zone.name || zone.id;
    const lakes = interiorLakes(recipe, field, zone.polygon);
    if (lakes.length < INTERIOR_LAKES_MIN) out.push(`${label}: ${lakes.length} lake(s) in its interior (centre ${INTERIOR_SHORE_M} m from the sea), needs ${INTERIOR_LAKES_MIN}`);
    const wood = woodlandShare(recipe, field, zone.polygon, sampler);
    if (wood.share < WOODLAND_SHARE_MIN) out.push(`${label}: ${pct(wood.share)} of its land is woodland (>= ${WOODLAND_DENSITY} trees/m² from the scatter rules + vegetation plan), under ${pct(WOODLAND_SHARE_MIN)}`);
  }
  return out;
}

/** The `zones` status row's landform half: null when every zone has relief, lakes and woods. */
export function zonesLandformCheck(recipe: WorldRecipe, field: WorldField): string | null {
  if (zoneRegions(recipe).length === 0) return null;
  const findings = [...zoneReliefFindings(recipe, field).map((f) => `relief — ${f}`), ...zoneInteriorFindings(recipe, field).map((f) => `interior — ${f}`)];
  return findings.length === 0 ? null : findings.join("; ");
}

/** Biome rules gated to zone anchors this world does not have: the field un-gates them, so they apply EVERYWHERE. */
export function biomesGatedToMissingAnchors(recipe: WorldRecipe): string[] {
  const anchors = recipe.climate.zones?.anchors;
  if (!anchors || anchors.length === 0) return [];
  const have = new Set(anchors.map((a) => a.id));
  return recipe.biomes.filter((b) => b.zones && b.zones.length > 0 && !b.zones.some((z) => have.has(z))).map((b) => b.id);
}

/** The `relief` status row: the world's own bands have been tuned to its landmass. */
export function reliefStageCheck(recipe: WorldRecipe): string | null {
  return recipe.pipeline?.["relief"] ? null : "the preset's relief bands are tuned for a 7 km continent — worldgen continents (derives them) or worldgen relief <world>";
}

// ---------------------------------------------------------------- the command

/** Mask swells across the landmass the relief is tuned for: 2 = one upland massif and one lowland on an island. */
export const DEFAULT_SWELLS = 2;

/**
 * Set the landmass-scale bands' frequencies from the landmass's WIDTH: the mountain mask gets `swells` cycles across
 * it (2 on an island = one upland and one lowland, 9 on the 7 km continental preset = several ranges), the ridged
 * mountain band 1.5x that (crests a third of a swell apart), the continent swell 0.75x, the mesa band 2x. Derived from
 * the width, not multiplied onto the current values, so a re-run is idempotent. Hills and detail stay: they are local.
 */
export function rescaleRelief(recipe: WorldRecipe, scaleKm: number, swells = DEFAULT_SWELLS): { factor: number; changed: string[] } {
  const t = recipe.terrain;
  const width = scaleKm * 1000;
  const factor = swells / width / (DEFAULT_SWELLS / (REFERENCE_KM * 1000));
  const changed: string[] = [];
  const set = (label: string, band: { frequency: number } | undefined, cycles: number): void => {
    if (!band) return;
    const before = band.frequency;
    band.frequency = Number((cycles / width).toPrecision(4));
    changed.push(`${label} ${before} -> ${band.frequency}`);
  };
  set("continent", t.continent, swells * 0.75);
  set("mountains", t.mountains, swells * 1.5);
  set("mountainMask", t.mountainMask.spec, swells);
  set("mesas", t.mesas, swells * 2);
  return { factor, changed };
}

/** Where the upland is: the centroid of the land standing UPLAND_RISE_M over p10, and its spread (RMS radius). */
export function uplandCentroid(recipe: WorldRecipe, field: WorldField, polygon: readonly (readonly [number, number])[] | null = null): { x: number; z: number; radius: number; share: number } | null {
  const { points } = samplePoints(recipe, polygon, 2500);
  const sea = recipe.seaLevel;
  const limit = field.worldLimit;
  const land: [number, number, number][] = [];
  for (const [x, z] of points) {
    if (limit !== Infinity && x * x + z * z > limit * limit) continue;
    const h = field.height(x, z);
    if (h > sea + 0.5) land.push([x, z, h - sea]);
  }
  if (land.length === 0) return null;
  const sorted = land.map((p) => p[2]).sort((a, b) => a - b);
  const p10 = sorted[Math.floor(0.1 * (sorted.length - 1))]!;
  const up = land.filter((p) => p[2] >= p10 + UPLAND_RISE_M);
  if (up.length === 0) return { x: 0, z: 0, radius: 0, share: 0 };
  const x = up.reduce((a, p) => a + p[0], 0) / up.length;
  const z = up.reduce((a, p) => a + p[1], 0) / up.length;
  const radius = Math.sqrt(up.reduce((a, p) => a + (p[0] - x) ** 2 + (p[1] - z) ** 2, 0) / up.length);
  return { x: Math.round(x), z: Math.round(z), radius: Math.round(radius), share: up.length / land.length };
}

/**
 * The width of the largest landmass (km): the land sampled on a ~50 x 50 lattice, 4-connected components, the biggest
 * one's bounding box (its longer side). What the relief bands scale to.
 */
export function measureLandWidth(recipe: WorldRecipe, field: WorldField): { widthKm: number; landKm2: number } {
  const { points, step } = samplePoints(recipe, null, 2500);
  const sea = recipe.seaLevel;
  const limit = field.worldLimit;
  const xs = [...new Set(points.map((p) => p[0]))].sort((a, b) => a - b);
  const zs = [...new Set(points.map((p) => p[1]))].sort((a, b) => a - b);
  const nx = xs.length;
  const nz = zs.length;
  const ix = new Map(xs.map((x, i) => [x, i]));
  const iz = new Map(zs.map((z, i) => [z, i]));
  const land = new Uint8Array(nx * nz);
  let landCells = 0;
  for (const [x, z] of points) {
    if (limit !== Infinity && x * x + z * z > limit * limit) continue;
    if (field.height(x, z) > sea + 0.5) {
      land[ix.get(x)! + iz.get(z)! * nx] = 1;
      landCells++;
    }
  }
  const seen = new Uint8Array(nx * nz);
  let best = 0;
  let bestBox: [number, number, number, number] | null = null;
  for (let start = 0; start < land.length; start++) {
    if (!land[start] || seen[start]) continue;
    const stack = [start];
    seen[start] = 1;
    let n = 0;
    let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
    while (stack.length) {
      const c = stack.pop()!;
      n++;
      const cx = c % nx;
      const cz = Math.floor(c / nx);
      x0 = Math.min(x0, cx); x1 = Math.max(x1, cx); z0 = Math.min(z0, cz); z1 = Math.max(z1, cz);
      for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
        const ax = cx + dx, az = cz + dz;
        if (ax < 0 || az < 0 || ax >= nx || az >= nz) continue;
        const j = ax + az * nx;
        if (land[j] && !seen[j]) { seen[j] = 1; stack.push(j); }
      }
    }
    if (n > best) { best = n; bestBox = [x0, x1, z0, z1]; }
  }
  const widthKm = bestBox ? ((Math.max(bestBox[1] - bestBox[0], bestBox[3] - bestBox[2]) + 1) * step) / 1000 : 0;
  return { widthKm: Math.round(widthKm * 100) / 100, landKm2: Math.round((landCells * step * step) / 1e4) / 100 };
}

export interface AutoReliefOptions {
  /** landmass width (km); measured from the land when absent */
  scaleKm?: number;
  target?: number;
  swells?: number;
  maskSeed?: number;
  maskStart?: number;
  maskEnd?: number;
  anchorRelief?: number;
  log?: (line: string) => void;
}

export interface AutoReliefResult {
  scaleKm: number;
  landKm2: number;
  before: Ladder;
  after: Ladder;
  changed: string[];
  amplitude: number;
  upland: ReturnType<typeof uplandCentroid>;
  findings: string[];
}

/**
 * Re-derive the recipe's relief from the land it has: the band frequencies from the landmass width (rescaleRelief), the
 * mask window and seed, every anchor's relief floor, and the mountain amplitude bisected so the land's p98 reaches the
 * target. Idempotent: the same land gives the same numbers again. `continents` runs it after laying the land (the
 * preset's bands are for a 7 km continent and left a 2.3 km island a plate — firstshore, 2026-10-28).
 */
export function autoRelief(recipe: WorldRecipe, options: AutoReliefOptions = {}): AutoReliefResult {
  const log = options.log ?? (() => {});
  const field0 = createWorldField(recipe);
  const before = altitudeLadder(landHeights(recipe, field0, null));
  const measured = measureLandWidth(recipe, field0);
  const scaleKm = options.scaleKm ?? measured.widthKm;
  if (!(scaleKm > 0)) throw new Error("no land to scale the relief to (run worldgen continents first)");
  const target = options.target ?? RELIEF_TARGET_P98_M;
  const swells = options.swells ?? DEFAULT_SWELLS;
  const { changed } = rescaleRelief(recipe, scaleKm, swells);
  // the mask's seed follows the world's seed (a different world, a different upland), unless the author pins one
  recipe.terrain.mountainMask.spec.seed = options.maskSeed ?? ((recipe.seed * 7919 + 53) % 100000);
  recipe.terrain.mountainMask.start = options.maskStart ?? MASK_START_DEFAULT;
  recipe.terrain.mountainMask.end = options.maskEnd ?? MASK_END_DEFAULT;
  const anchorRelief = options.anchorRelief ?? ANCHOR_RELIEF_MIN;
  const anchors = recipe.climate.zones?.anchors ?? [];
  const raised = anchors.filter((a) => a.relief < anchorRelief);
  for (const a of raised) a.relief = anchorRelief;
  log(`relief: landmass ${scaleKm} km wide (${measured.landKm2} km² of land), ${swells} mask swells across it — ${changed.join(", ")}; mask seed ${recipe.terrain.mountainMask.spec.seed}, window ${recipe.terrain.mountainMask.start}..${recipe.terrain.mountainMask.end}${raised.length ? `; anchor relief raised to ${anchorRelief} on ${raised.map((a) => a.id).join(", ")}` : ""}`);
  const p98At = (amplitude: number): number => {
    recipe.terrain.mountains.amplitude = amplitude;
    return altitudeLadder(landHeights(recipe, createWorldField(recipe), null, 1800)).p98;
  };
  let lo = 0;
  let hi = Math.max(400, recipe.terrain.mountains.amplitude * 4);
  if (p98At(hi) < target) log(`  amplitude ${hi} reaches p98 ${r1(p98At(hi))} m < target ${target}: the mask or the anchors' relief gate it`);
  for (let i = 0; i < 14 && hi - lo > 4; i++) {
    const mid = (lo + hi) / 2;
    if (p98At(mid) < target) lo = mid;
    else hi = mid;
  }
  recipe.terrain.mountains.amplitude = Math.round(hi);
  let field = createWorldField(recipe);
  let after = altitudeLadder(landHeights(recipe, field, null));
  let upland = uplandCentroid(recipe, field);
  // the upland must be a SHARE of the land, not a spike: a p98 at the target with 14 % of the land 60 m up (seed 1438)
  // fails the upland rule; raise the target in UPLAND_TARGET_STEP_M steps until the share clears the rule with margin
  for (let round = 0; round < 4 && upland && upland.share < UPLAND_SHARE_MIN + 0.03; round++) {
    const higher = target + UPLAND_TARGET_STEP_M * (round + 1);
    let lo2 = recipe.terrain.mountains.amplitude;
    let hi2 = Math.max(lo2 * 2, 400);
    if (p98At(hi2) < higher) break;
    for (let i = 0; i < 14 && hi2 - lo2 > 4; i++) {
      const mid = (lo2 + hi2) / 2;
      if (p98At(mid) < higher) lo2 = mid;
      else hi2 = mid;
    }
    recipe.terrain.mountains.amplitude = Math.round(hi2);
    field = createWorldField(recipe);
    after = altitudeLadder(landHeights(recipe, field, null));
    upland = uplandCentroid(recipe, field);
    log(`  upland ${pct(upland?.share ?? 0)} under ${pct(UPLAND_SHARE_MIN + 0.03)}: target raised to ${higher} m (amplitude ${Math.round(hi2)})`);
  }
  log(`  mountains.amplitude ${Math.round(hi)} (target p98 ${target} m over the sea)`);
  log(`  before: ${describeLadder(before)}`);
  log(`  after:  ${describeLadder(after)}`);
  if (upland) log(`  upland centroid [${upland.x}, ${upland.z}], RMS radius ${upland.radius} m, ${pct(upland.share)} of land`);
  const findings = reliefFindings(after, "world");
  for (const f of findings) log(`  ! ${f}`);
  return { scaleKm, landKm2: measured.landKm2, before, after, changed, amplitude: Math.round(hi), upland, findings };
}

export function commandRelief(host: ReliefHost): void {
  const { recipe, file } = host.loadRecipe();
  const argv = host.argv;
  if (argv.includes("--report")) {
    console.log(`world: ${describeLadder(altitudeLadder(landHeights(recipe, createWorldField(recipe), null)))}`);
    const field = createWorldField(recipe);
    for (const zone of zoneRegions(recipe)) console.log(`  ${zone.name || zone.id}: ${describeLadder(altitudeLadder(landHeights(recipe, field, zone.polygon)))}`);
    for (const f of zoneReliefFindings(recipe, field)) console.log(`  ! relief — ${f}`);
    return;
  }
  const scaleKm = num(argv, "scale", NaN);
  const maskSeed = opt(argv, "mask-seed");
  const maskStart = opt(argv, "mask-start");
  const maskEnd = opt(argv, "mask-end");
  const anchorRelief = num(argv, "anchor-relief", NaN);
  autoRelief(recipe, {
    ...(Number.isFinite(scaleKm) && scaleKm > 0 ? { scaleKm } : {}),
    target: num(argv, "target", RELIEF_TARGET_P98_M),
    swells: num(argv, "swells", DEFAULT_SWELLS),
    ...(maskSeed !== null ? { maskSeed: Math.round(Number(maskSeed)) } : {}),
    ...(maskStart !== null ? { maskStart: Number(maskStart) } : {}),
    ...(maskEnd !== null ? { maskEnd: Number(maskEnd) } : {}),
    ...(Number.isFinite(anchorRelief) ? { anchorRelief } : {}),
    log: (line) => console.log(line),
  });
  const field = createWorldField(recipe);
  for (const zone of zoneRegions(recipe)) console.log(`  ${zone.name || zone.id}: ${describeLadder(altitudeLadder(landHeights(recipe, field, zone.polygon)))}`);
  if (argv.includes("--dry")) {
    console.log("(dry) nothing written");
    return;
  }
  host.writeRecipe(recipe, file);
  console.log("next: worldgen coast, rivers, towns, terrace, zones, paths (the ground moved under all of them)");
}

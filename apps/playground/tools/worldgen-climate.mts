/**
 * The climate of a landmass as the GENERATOR decides it (2026-10-28, Derek: "zones need multiple biomes... wetlands
 * and a jungle, or cliffs of Moher against a pine forest... mix it up"; and the Skelmorrow failure the rule exists
 * for: "cliffs into desert then into wetlands, which doesn't make sense... just the cliffs, 2 lakes and a river, where
 * there should have been a forest").
 *
 *   climateCellSize      the climate lattice from the land area: ~CLIMATE_CELLS_PER_LANDMASS cells on the largest landmass
 *   assignClimateSites   one anchor per lattice cell with land under it, from the ground's traits (altitude, shore
 *                        distance, windward exposure, latitude) through the recipe's transition grammar
 *                        (`climate.transitions`): legal neighbours preferred, wetlands by water and lowland, dry
 *                        biomes on the lee (rain-shadow) side, no tundra against jungle; written as
 *                        `climate.zones.sites`, which the field honours
 *   biomeFindings        the `biomes` rule, two halves: (A) TRANSITIONS — every adjacent anchor pair legal, wetlands
 *                        touching water or lowland, dry biomes on the dry side; (B) DIVERSITY — >= DIVERSITY_KINDS_MIN
 *                        feature kinds of woodland / open ground / upland / lake / river / cliff coast / beach or cove /
 *                        wetland / canyon / crater or tarn; plus >= BIOME_KINDS_MIN anchors at >= BIOME_SHARE_MIN of
 *                        the land each and none over BIOME_SHARE_MAX
 */
import type { WorldField, WorldRecipe } from "@hitreg/core";
import { createWorldField, pointInPolygon } from "@hitreg/core";
import { INTERIOR_SHORE_M, UPLAND_RISE_M, WOODLAND_DENSITY, WOODLAND_SHARE_MIN, altitudeLadder, interiorLakes, samplePoints, treeSampler, woodlandShare } from "./worldgen-relief.mts";

/** Climate cells the largest landmass carries: 3.5 -> a 5 km² island reads three or four biomes. */
export const CLIMATE_CELLS_PER_LANDMASS = 3.5;
export const CLIMATE_CELL_MIN_M = 600;
/** Distinct anchors the climate assignment spreads over a landmass when it has that many (three to four biomes). */
export const SPREAD_ANCHORS = 4;
/** Anchors a zone must carry at >= BIOME_SHARE_MIN of its land each; none over BIOME_SHARE_MAX. */
export const BIOME_KINDS_MIN = 3;
export const BIOME_SHARE_MIN = 0.1;
export const BIOME_SHARE_MAX = 0.6;
/** Feature kinds a zone must show (of the ten the inventory knows). */
export const DIVERSITY_KINDS_MIN = 5;
/** Open ground: expected trees under this share of the woodland density, on ground under this slope. */
export const OPEN_TREE_SHARE = 0.3;
export const OPEN_SLOPE_MAX = 0.35;
export const OPEN_SHARE_MIN = 0.15;
/** A wetland anchor's samples: this share must be lowland (<= p50) or within INTERIOR_SHORE_M of the sea. */
export const WET_PLACEMENT_MIN = 0.5;
/** A dry anchor's samples: this share must lie on the lee side of the wind frame. */
export const DRY_LEE_MIN = 0.5;

type Anchor = NonNullable<WorldRecipe["climate"]["zones"]>["anchors"][number];
type Transitions = WorldRecipe["climate"]["transitions"];

export function climateCellSize(landKm2: number): number {
  return Math.max(CLIMATE_CELL_MIN_M, Math.round((Math.sqrt(Math.max(landKm2, 0.01) / CLIMATE_CELLS_PER_LANDMASS) * 1000) / 50) * 50);
}

export function isWet(a: Anchor, t: Transitions): boolean {
  return a.waterTable !== undefined || a.moisture >= t.wetMoisture;
}
export function isDry(a: Anchor, t: Transitions): boolean {
  return a.moisture <= t.dryMoisture;
}

/** Is a pair of anchors a legal neighbourhood under the recipe's grammar? */
export function legalPair(a: Anchor, b: Anchor, t: Transitions): { legal: boolean; why: string } {
  if (a.id === b.id) return { legal: true, why: "" };
  const key = (x: string, y: string) => t.allow.some(([p, q]) => (p === x && q === y) || (p === y && q === x));
  if (t.forbid.some(([p, q]) => (p === a.id && q === b.id) || (p === b.id && q === a.id))) return { legal: false, why: "forbidden" };
  if (key(a.id, b.id)) return { legal: true, why: "" };
  const dt = Math.abs(a.temperature - b.temperature);
  const dm = Math.abs(a.moisture - b.moisture);
  if (dt > t.temperatureStep) return { legal: false, why: `temperature step ${dt.toFixed(2)} > ${t.temperatureStep}` };
  if (dm > t.moistureStep) return { legal: false, why: `moisture step ${dm.toFixed(2)} > ${t.moistureStep}` };
  if ((isWet(a, t) && isDry(b, t)) || (isWet(b, t) && isDry(a, t))) return { legal: false, why: "wetland against a dry biome" };
  return { legal: true, why: "" };
}

interface LandSample { x: number; z: number; h: number; shore: number }

function landSamples(recipe: WorldRecipe, field: WorldField, polygon: readonly (readonly [number, number])[] | null, target: number): { land: LandSample[]; step: number } {
  const { points, step } = samplePoints(recipe, polygon, target);
  const sea = recipe.seaLevel;
  const limit = field.worldLimit;
  const land: LandSample[] = [];
  for (const [x, z] of points) {
    if (limit !== Infinity && x * x + z * z > limit * limit) continue;
    const h = field.height(x, z);
    if (h > sea + 0.5) land.push({ x, z, h, shore: field.shoreDistance(x, z) });
  }
  return { land, step };
}

/** The latitude a cell is judged at: the lattice position along the latitude axis, shifted by the world's `warmth`. */
function latitudeOf(recipe: WorldRecipe, x: number, z: number): number {
  const zones = recipe.climate.zones;
  const lat = zones?.latitude;
  const warmth = zones?.warmth ?? 0;
  if (!lat) return Math.max(0, Math.min(1, 0.5 + warmth));
  const along = lat.axis === "x" ? x : z;
  const u = 0.5 + along / lat.scale;
  return Math.max(0, Math.min(1, (lat.flip ? 1 - u : u) + warmth));
}

export interface SiteAssignment {
  cell: [number, number];
  x: number;
  z: number;
  anchor: string;
  alt01: number;
  shore01: number;
  exposure01: number;
  wet01: number;
  land: number;
}

/**
 * One anchor per climate cell with land under it. Traits per site from the land samples its cell covers; fit = the
 * anchor's (temperature, moisture) distance from the site's wanted pair (cold up high, wet by the water, the lowland
 * and the windward side; the recipe's latitude kept); legality against the neighbours already placed (the grammar),
 * wetlands only on low shore-near ground, dry anchors only on the lee, high-relief anchors only up high; a diversity
 * pull toward anchors not yet used and toward one wetland where the ground allows; then a repair pass on any illegal
 * pair and a cap on one anchor holding most of the land.
 */
export function assignClimateSites(recipe: WorldRecipe, field: WorldField, log: (line: string) => void = () => {}): SiteAssignment[] {
  const zones = recipe.climate.zones;
  if (!zones || zones.anchors.length === 0) return [];
  const t = recipe.climate.transitions;
  // the riparian (oasis) anchor is a ribbon along the rivers, never a region: no cell picks it
  const anchors = zones.anchors.filter((a) => a.id !== zones.riparian?.anchor);
  if (anchors.length === 0) return [];
  const aridity = zones.aridity ?? 0;
  const { land } = landSamples(recipe, field, null, 2500);
  if (land.length === 0) return [];
  const ladder = altitudeLadder(land.map((p) => p.h - recipe.seaLevel));
  const span = Math.max(1, ladder.p98 - ladder.p10);
  const cx = land.reduce((a, p) => a + p.x, 0) / land.length;
  const cz = land.reduce((a, p) => a + p.z, 0) / land.length;
  const wind = recipe.terrain.dunes.angle;
  const wx = Math.cos(wind);
  const wz = Math.sin(wind);
  const reach = land.reduce((m, p) => Math.max(m, Math.hypot(p.x - cx, p.z - cz)), 1);
  const size = zones.size;
  const sites: SiteAssignment[] = [];
  for (const s of field.climateSites()) {
    const mine = land.filter((p) => Math.hypot(p.x - s.x, p.z - s.z) <= size * 0.7);
    if (mine.length < 3) continue;
    const h = mine.reduce((a, p) => a + p.h, 0) / mine.length - recipe.seaLevel;
    const shore = mine.reduce((a, p) => a + p.shore, 0) / mine.length;
    const alt01 = Math.max(0, Math.min(1, (h - ladder.p10) / span));
    const shore01 = Math.max(0, Math.min(1, shore / 1200));
    // windward = upwind of the landmass centre: the side the wind frame blows onto (rain), lee = the rain shadow
    const exposure01 = Math.max(0, Math.min(1, 0.5 - (0.5 * ((s.x - cx) * wx + (s.z - cz) * wz)) / reach));
    const wet01 = Math.max(0, Math.min(1, 0.45 * (1 - shore01) + 0.3 * (1 - alt01) + 0.25 * exposure01));
    sites.push({ cell: s.cell, x: s.x, z: s.z, anchor: "", alt01, shore01, exposure01, wet01, land: mine.length });
  }
  // a cell's traits average a ~1 km disc, so on a 3-4 km island every cell reads mid-altitude (redstrand 2026-10-29:
  // 0.24..0.58) and the upland anchor landed on the LOWEST cell: stretch the cells' altitude over 0..1 among themselves
  // (the highest cell of the landmass is its upland), and re-derive the wet trait from it
  const altLo = Math.min(...sites.map((s) => s.alt01));
  const altHi = Math.max(...sites.map((s) => s.alt01));
  if (sites.length >= 2 && altHi - altLo > 0.02) {
    for (const s of sites) {
      s.alt01 = (s.alt01 - altLo) / (altHi - altLo);
      s.wet01 = Math.max(0, Math.min(1, 0.45 * (1 - s.shore01) + 0.3 * (1 - s.alt01) + 0.25 * s.exposure01));
    }
  }
  sites.sort((a, b) => b.land - a.land);
  const used = new Map<string, number>();
  const neighbours = (i: number): SiteAssignment[] => sites.filter((o, j) => j !== i && o.anchor && Math.hypot(o.x - sites[i]!.x, o.z - sites[i]!.z) <= size * 1.6);
  const fit = (a: Anchor, s: SiteAssignment): number => {
    const lat = latitudeOf(recipe, s.x, s.z);
    const wantT = Math.max(0, Math.min(1, lat + 0.2 - 0.45 * s.alt01));
    // a dry climate (aridity) scales the wet trait down: on a small island every cell is near the sea
    const wantM = s.wet01 * (1 - aridity);
    let c = (a.temperature - wantT) ** 2 + (a.moisture - wantM) ** 2;
    if (a.latitude !== undefined && zones.latitude) c += 0.25 * ((a.latitude - lat) / 0.3) ** 2;
    if (isWet(a, t) && !(s.alt01 < 0.35 && s.shore01 < 0.5)) c += 4;
    if (isDry(a, t) && s.exposure01 > 0.5) c += 2;
    if (a.relief >= 1 && s.alt01 < 0.5) c += 1;
    return c;
  };
  const cost = (a: Anchor, i: number, diversity = true): number => {
    const s = sites[i]!;
    let c = fit(a, s);
    for (const n of neighbours(i)) if (!legalPair(a, anchors.find((q) => q.id === n.anchor)!, t).legal) c += 3;
    if (diversity) {
      if (isWet(a, t) && ![...used.keys()].some((id) => isWet(anchors.find((q) => q.id === id)!, t)) && s.alt01 < 0.35 && s.shore01 < 0.4) c -= 0.3;
    }
    return c;
  };
  const best = (i: number, exclude: Set<string> = new Set()): Anchor => {
    let bestA = anchors[0]!;
    let bestC = Infinity;
    for (const a of anchors) {
      if (exclude.has(a.id)) continue;
      const c = cost(a, i);
      if (c < bestC) { bestC = c; bestA = a; }
    }
    return bestA;
  };
  for (let i = 0; i < sites.length; i++) {
    const a = best(i);
    sites[i]!.anchor = a.id;
    used.set(a.id, (used.get(a.id) ?? 0) + sites[i]!.land);
  }
  // repair: an illegal pair re-picks the site whose change costs least, among anchors legal with every neighbour
  for (let round = 0; round < 6; round++) {
    let fixed = 0;
    for (let i = 0; i < sites.length; i++) {
      const bad = neighbours(i).filter((n) => !legalPair(anchors.find((q) => q.id === sites[i]!.anchor)!, anchors.find((q) => q.id === n.anchor)!, t).legal);
      if (bad.length === 0) continue;
      const a = best(i);
      if (a.id !== sites[i]!.anchor) { sites[i]!.anchor = a.id; fixed++; }
    }
    if (fixed === 0) break;
  }
  // spread: the greedy pass picks each cell's best fit, so a small island can draw two anchors. Until SPREAD_ANCHORS
  // (or every anchor) are on the land, the unused anchor whose switch costs least takes that cell — never an anchor's
  // last cell, never a switch that makes an illegal pair. (Before 2026-10-29 an "unused" bonus inside the greedy pass
  // did this, and handed the upland anchor to whichever cell came first by size: redstrand's pines on the lowest cell.)
  const target = Math.min(anchors.length, SPREAD_ANCHORS);
  for (let round = 0; round < anchors.length; round++) {
    const counts = new Map<string, number>();
    for (const s of sites) counts.set(s.anchor, (counts.get(s.anchor) ?? 0) + 1);
    if (counts.size >= target) break;
    let pick: { i: number; a: Anchor; d: number } | null = null;
    for (const a of anchors) {
      if (counts.has(a.id)) continue;
      for (let i = 0; i < sites.length; i++) {
        const cur = sites[i]!.anchor;
        if ((counts.get(cur) ?? 0) <= 1) continue;
        if (neighbours(i).some((n) => !legalPair(a, anchors.find((q) => q.id === n.anchor)!, t).legal)) continue;
        const d = cost(a, i, false) - cost(anchors.find((q) => q.id === cur)!, i, false);
        if (!pick || d < pick.d) pick = { i, a, d };
      }
    }
    if (!pick) break;
    sites[pick.i]!.anchor = pick.a.id;
  }
  // dominance: one anchor over BIOME_SHARE_MAX of the land sites hands its worst-fitting sites to their runner-up
  const total = sites.reduce((a, s) => a + s.land, 0);
  for (let round = 0; round < 4; round++) {
    const share = new Map<string, number>();
    for (const s of sites) share.set(s.anchor, (share.get(s.anchor) ?? 0) + s.land / total);
    const top = [...share.entries()].sort((a, b) => b[1] - a[1])[0];
    if (!top || top[1] <= BIOME_SHARE_MAX) break;
    const mine = sites.map((s, i) => ({ s, i })).filter((x) => x.s.anchor === top[0]).sort((p, q) => fit(anchors.find((a) => a.id === top[0])!, q.s) - fit(anchors.find((a) => a.id === top[0])!, p.s));
    const victim = mine[0];
    if (!victim) break;
    const alt = best(victim.i, new Set([top[0]]));
    victim.s.anchor = alt.id;
  }
  // balance on the MEASURED shares: the site discs above overlap and a cell's Voronoi region is not its disc, so the
  // cells' land counts said 18 % where the drawn zone held 0-6 % (redstrand dogfood loop 1, 2026-10-29: 3 of 4 seeds
  // failed the biomes rule's ">= 3 anchors at >= 10 %, none over 60 %"). Pin the sites into a copy, sample field.zone()
  // on the land as the rule does, and move one cell per round: an anchor over BIOME_SHARE_MAX gives its worst-fitting
  // cell away; with fewer than BIOME_KINDS_MIN anchors at BIOME_SHARE_MIN, the cheapest legal cell of the largest anchor
  // goes to the most-needed one. Each move is kept only if the measured shares get closer to the rule.
  const measure = (): Map<string, number> => {
    const copy = structuredClone(recipe);
    copy.climate.zones!.sites = sites.map((s) => ({ cell: s.cell, anchor: s.anchor }));
    const f = createWorldField(copy);
    const m = new Map<string, number>();
    for (const p of land) { const id = f.zone(p.x, p.z).id; m.set(id, (m.get(id) ?? 0) + 1 / land.length); }
    return m;
  };
  const miss = (m: Map<string, number>): number => {
    let d = 0;
    for (const v of m.values()) d += Math.max(0, v - BIOME_SHARE_MAX);
    const ranked = [...m.values()].sort((a, b) => b - a);
    for (let k = 0; k < Math.min(BIOME_KINDS_MIN, anchors.length); k++) d += Math.max(0, BIOME_SHARE_MIN - (ranked[k] ?? 0));
    return d;
  };
  {
    let shares = measure();
    for (let round = 0; round < 8 && miss(shares) > 0; round++) {
      const ranked = [...shares.entries()].sort((a, b) => b[1] - a[1]);
      const top = ranked[0]![0];
      const counts = new Map<string, number>();
      for (const s of sites) counts.set(s.anchor, (counts.get(s.anchor) ?? 0) + 1);
      const moves: { i: number; to: string; c: number }[] = [];
      const needed = anchors.filter((a) => (shares.get(a.id) ?? 0) < BIOME_SHARE_MIN).map((a) => a.id);
      for (let i = 0; i < sites.length; i++) {
        const cur = sites[i]!.anchor;
        if (cur !== top || (counts.get(cur) ?? 0) <= 1) continue;
        for (const to of [...needed, ...anchors.map((a) => a.id)]) {
          if (to === cur) continue;
          const a = anchors.find((q) => q.id === to)!;
          if (neighbours(i).some((n) => !legalPair(a, anchors.find((q) => q.id === n.anchor)!, t).legal)) continue;
          moves.push({ i, to, c: cost(a, i, false) - (needed.includes(to) ? 1 : 0) });
        }
      }
      moves.sort((p, q) => p.c - q.c);
      let moved = false;
      for (const mv of moves.slice(0, 6)) {
        const was = sites[mv.i]!.anchor;
        sites[mv.i]!.anchor = mv.to;
        const next = measure();
        if (miss(next) < miss(shares)) { shares = next; moved = true; break; }
        sites[mv.i]!.anchor = was;
      }
      if (!moved) break;
    }
    log(`climate: measured shares ${[...shares.entries()].sort((a, b) => b[1] - a[1]).map(([id, v]) => `${id} ${(v * 100).toFixed(0)}%`).join(", ")}${miss(shares) > 0 ? " (the biomes rule's shares still missed)" : ""}`);
  }
  const share = new Map<string, number>();
  for (const s of sites) share.set(s.anchor, (share.get(s.anchor) ?? 0) + s.land / total);
  log(`climate: ${sites.length} site(s) with land on a ${size} m lattice -> ${[...share.entries()].sort((a, b) => b[1] - a[1]).map(([id, v]) => `${id} ${(v * 100).toFixed(0)}%`).join(", ")}`);
  for (const s of sites) log(`  cell [${s.cell[0]}, ${s.cell[1]}] at [${Math.round(s.x)}, ${Math.round(s.z)}]: ${s.anchor.padEnd(10)} alt ${s.alt01.toFixed(2)} shore ${s.shore01.toFixed(2)} windward ${s.exposure01.toFixed(2)} wet ${s.wet01.toFixed(2)} (${s.land} land samples)`);
  return sites;
}

export interface BiomeReport {
  findings: string[];
  /** anchor id -> share of the land */
  shares: Map<string, number>;
  /** adjacent anchor pairs with their count and legality */
  pairs: { a: string; b: string; count: number; legal: boolean; why: string }[];
  /** feature kinds present */
  kinds: Record<string, boolean>;
  kindCount: number;
}

function nearPolygon(x: number, z: number, polygon: readonly (readonly [number, number])[] | null, reach: number): boolean {
  if (!polygon) return true;
  if (pointInPolygon(x, z, polygon)) return true;
  for (let i = 0; i < polygon.length; i++) {
    const [ax, az] = polygon[i]!;
    const [bx, bz] = polygon[(i + 1) % polygon.length]!;
    const dx = bx - ax, dz = bz - az;
    const l2 = dx * dx + dz * dz || 1;
    const u = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / l2));
    if (Math.hypot(x - ax - dx * u, z - az - dz * u) <= reach) return true;
  }
  return false;
}

/** The `biomes` rule on a zone (or the whole land with polygon = null). */
export function biomeFindings(recipe: WorldRecipe, field: WorldField, polygon: readonly (readonly [number, number])[] | null, label: string): BiomeReport {
  const findings: string[] = [];
  const zones = recipe.climate.zones;
  const t = recipe.climate.transitions;
  const anchors = zones?.anchors ?? [];
  const byId = new Map(anchors.map((a) => [a.id, a]));
  const { land, step } = landSamples(recipe, field, polygon, 2500);
  const shares = new Map<string, number>();
  const pairsMap = new Map<string, number>();
  const kinds: Record<string, boolean> = {};
  if (land.length === 0) return { findings: [`${label}: no land`], shares, pairs: [], kinds, kindCount: 0 };
  const ladder = altitudeLadder(land.map((p) => p.h - recipe.seaLevel));
  const ids = new Map<string, string>();
  const key = (x: number, z: number) => `${Math.round(x)},${Math.round(z)}`;
  for (const p of land) ids.set(key(p.x, p.z), field.zone(p.x, p.z).id);
  // (A) shares, placement, adjacency
  const lowOrShore = new Map<string, number>();
  const lee = new Map<string, number>();
  const cx = land.reduce((a, p) => a + p.x, 0) / land.length;
  const cz = land.reduce((a, p) => a + p.z, 0) / land.length;
  const wind = recipe.terrain.dunes.angle;
  for (const p of land) {
    const id = ids.get(key(p.x, p.z))!;
    shares.set(id, (shares.get(id) ?? 0) + 1 / land.length);
    if (p.h - recipe.seaLevel <= ladder.p50 || p.shore <= INTERIOR_SHORE_M) lowOrShore.set(id, (lowOrShore.get(id) ?? 0) + 1);
    if ((p.x - cx) * Math.cos(wind) + (p.z - cz) * Math.sin(wind) > 0) lee.set(id, (lee.get(id) ?? 0) + 1);
    for (const [dx, dz] of [[step, 0], [0, step]] as const) {
      const o = ids.get(key(p.x + dx, p.z + dz));
      if (!o || o === id) continue;
      const k = [id, o].sort().join("|");
      pairsMap.set(k, (pairsMap.get(k) ?? 0) + 1);
    }
  }
  const pairs = [...pairsMap.entries()].map(([k, count]) => {
    const [a, b] = k.split("|") as [string, string];
    const aa = byId.get(a), bb = byId.get(b);
    const v = aa && bb ? legalPair(aa, bb, t) : { legal: true, why: "" };
    return { a, b, count, legal: v.legal, why: v.why };
  }).sort((p, q) => q.count - p.count);
  const kindsAtShare = [...shares.entries()].filter(([, v]) => v >= BIOME_SHARE_MIN);
  if (kindsAtShare.length < BIOME_KINDS_MIN) findings.push(`${label}: ${kindsAtShare.length} anchor(s) at >= ${BIOME_SHARE_MIN * 100}% of the land (${[...shares.entries()].map(([k, v]) => `${k} ${(v * 100).toFixed(0)}%`).join(", ")}), under ${BIOME_KINDS_MIN}`);
  for (const [id, v] of shares) if (v > BIOME_SHARE_MAX) findings.push(`${label}: ${id} holds ${(v * 100).toFixed(0)}% of the land, over ${BIOME_SHARE_MAX * 100}%`);
  for (const p of pairs) if (!p.legal) findings.push(`${label}: ${p.a} against ${p.b} (${p.count} border samples): ${p.why}`);
  for (const [id, v] of shares) {
    const a = byId.get(id);
    if (!a || v < 0.02) continue;
    const n = v * land.length;
    if (isWet(a, t) && (lowOrShore.get(id) ?? 0) / n < WET_PLACEMENT_MIN) findings.push(`${label}: wetland ${id} sits ${((1 - (lowOrShore.get(id) ?? 0) / n) * 100).toFixed(0)}% on high ground away from water`);
    if (isDry(a, t) && (lee.get(id) ?? 0) / n < DRY_LEE_MIN) findings.push(`${label}: dry ${id} sits ${(((lee.get(id) ?? 0) / n) * 100).toFixed(0)}% on the lee (rain-shadow) side, under ${DRY_LEE_MIN * 100}%`);
  }
  // (B) the feature inventory
  const sampler = treeSampler(recipe, field);
  const wood = woodlandShare(recipe, field, polygon, sampler);
  kinds.woodland = wood.share >= WOODLAND_SHARE_MIN;
  let open = 0;
  for (const p of land) {
    const e = 4;
    const sx = (field.height(p.x + e, p.z) - field.height(p.x - e, p.z)) / (2 * e);
    const sz = (field.height(p.x, p.z + e) - field.height(p.x, p.z - e)) / (2 * e);
    if (Math.hypot(sx, sz) <= OPEN_SLOPE_MAX && sampler.density(p.x, p.z, p.h) < WOODLAND_DENSITY * OPEN_TREE_SHARE) open++;
  }
  kinds.open = open / land.length >= OPEN_SHARE_MIN;
  kinds.upland = land.filter((p) => p.h - recipe.seaLevel >= ladder.p10 + UPLAND_RISE_M).length / land.length >= 0.15;
  const lakes = polygon ? interiorLakes(recipe, field, polygon) : recipe.features.lakes;
  kinds.lake = lakes.length >= 1;
  kinds.river = recipe.features.rivers.some((r) => r.points.some((p) => nearPolygon(p[0], p[1], polygon, 0)) && r.points.reduce((s, p, i, a) => (i ? s + Math.hypot(p[0] - a[i - 1]![0], p[1] - a[i - 1]![1]) : 0), 0) >= 300);
  const segs = recipe.features.coastSegments ?? [];
  const segNear = (type: string[]) => segs.some((s) => type.includes(s.type) && s.points.some((p) => nearPolygon(p[0], p[1], polygon, 150)));
  kinds.cliffCoast = segNear(["sheer-cliff"]);
  kinds.beach = segNear(["sand-beach", "cove", "shingle"]);
  kinds.wetland = [...shares.entries()].some(([id, v]) => v >= 0.05 && byId.get(id) && isWet(byId.get(id)!, t));
  kinds.canyon = recipe.features.canyons.some((c) => c.points.some((p) => nearPolygon(p[0], p[1], polygon, 0)));
  kinds.tarn = lakes.some((l) => l.tags.includes("endorheic") || l.waterY - recipe.seaLevel >= ladder.p50);
  const kindCount = Object.values(kinds).filter(Boolean).length;
  if (kindCount < DIVERSITY_KINDS_MIN) findings.push(`${label}: ${kindCount} feature kind(s) (${Object.entries(kinds).filter(([, v]) => v).map(([k]) => k).join(", ") || "none"}), under ${DIVERSITY_KINDS_MIN} — missing ${Object.entries(kinds).filter(([, v]) => !v).map(([k]) => k).join(", ")}`);
  return { findings, shares, pairs, kinds, kindCount };
}

/** The status row's one-line verdict over every wilderness zone (null = ok). */
export function zonesBiomeCheck(recipe: WorldRecipe, field: WorldField): string | null {
  const wild = recipe.regions.filter((r) => !r.within && r.polygon.length >= 3);
  const out: string[] = [];
  for (const z of wild) out.push(...biomeFindings(recipe, field, z.polygon, z.name || z.id).findings);
  return out.length ? `biomes — ${out[0]}${out.length > 1 ? ` (+${out.length - 1} more: worldgen climate --report)` : ""}` : null;
}

export function describeBiomes(rep: BiomeReport): string[] {
  const shares = [...rep.shares.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${(v * 100).toFixed(0)}%`).join(", ");
  const pairs = rep.pairs.map((p) => `${p.a}-${p.b}${p.legal ? "" : " ILLEGAL"}`).join(", ");
  const kinds = Object.entries(rep.kinds).map(([k, v]) => `${v ? "+" : "-"}${k}`).join(" ");
  return [`anchors: ${shares}`, `pairs: ${pairs || "none"}`, `kinds ${rep.kindCount}/${DIVERSITY_KINDS_MIN}: ${kinds}`];
}

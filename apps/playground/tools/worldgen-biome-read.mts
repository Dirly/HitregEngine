/**
 * Biomes that READ (2026-10-29 redstrand w2-shape): Derek asked for "multiple biomes which make sense", and the map drew
 * dark green over lowland and upland alike — no oasis ribbon, pine and broadleaf the same dots, dry ground the colour
 * of any other ground. This module classifies a land point the way the map draws it and the dogfood `biomeRead` rule
 * judges it:
 *
 *   woodland   tree density >= WOODLAND_DENSITY, of a KIND: pine (needle), broadleaf or scrub (palm, dead/dry trees),
 *              from the tree rule ids
 *   riparian   the climate's riparian anchor rules the biome here while the zone under it is another anchor: the oasis
 *              ribbon along a wet river (climate.zones.riparian)
 *   dry        the zone's dominant anchor is a dry one (moisture < DRY_MOISTURE)
 *
 * The rule is climate-agnostic: a HARSH climate — dry (climate.zones.aridity >= DRY_ARIDITY) or cold (warmth <=
 * COLD_WARMTH; Derek 2026-10-29 "you can also make a frozen world") — must read harsh: mostly OPEN ground of its harsh
 * anchors (dry: moisture < DRY_MOISTURE; cold: temperature < COLD_TEMPERATURE — tundra, snow, bare peaks), share >=
 * dryOpenMin(severity); the woodland where it belongs (dry: on the upland or by water; cold: below the treeline — under
 * the upland line — or by water), share >= WOOD_PLACED_MIN; and the riparian ribbon (oasis / meltwater valley) along
 * at least one river for RIBBON_MIN_M. A temperate climate passes it untouched.
 */
import type { WorldField, WorldRecipe } from "@hitreg/core";
import { UPLAND_RISE_M, WOODLAND_DENSITY, altitudeLadder, landHeights, samplePoints, treeSampler, type TreeSampler } from "./worldgen-relief.mts";

export const DRY_MOISTURE = 0.45;
export const DRY_ARIDITY = 0.3;
export const COLD_WARMTH = -0.2;
export const COLD_TEMPERATURE = 0.32;
export const COLD_COLOUR: [number, number, number] = [214, 222, 232];

export type Harsh = "dry" | "cold" | null;
/** Which harsh climate a world has, and how severe (0..1): aridity, or the cold of its warmth. */
export function harshness(recipe: WorldRecipe): { kind: Harsh; severity: number } {
  const z = recipe.climate.zones;
  const aridity = z?.aridity ?? 0, warmth = z?.warmth ?? 0;
  if (aridity >= DRY_ARIDITY && aridity >= -warmth) return { kind: "dry", severity: aridity };
  if (warmth <= COLD_WARMTH) return { kind: "cold", severity: Math.min(1, -warmth * 1.25) };
  return { kind: null, severity: 0 };
}
export const WOOD_PLACED_MIN = 0.6;
export const RIBBON_MIN_M = 400;
/** Share of the land that must be dry open ground in a climate of this aridity. */
export const dryOpenMin = (aridity: number): number => Math.min(0.75, 0.25 + 0.5 * aridity);

export type TreeKind = "pine" | "broadleaf" | "scrub";
export const TREE_KIND_COLOURS: Record<TreeKind, [number, number, number]> = { pine: [26, 66, 58], broadleaf: [78, 132, 46], scrub: [128, 116, 62] };
export const RIPARIAN_COLOUR: [number, number, number] = [60, 190, 110];
export const DRY_COLOUR: [number, number, number] = [214, 158, 92];

export function treeKindOf(id: string): TreeKind {
  if (/pine|fir|spruce|larch|cedar|conifer|taiga/.test(id)) return "pine";
  if (/palm|dead|dried|acacia|scrub|cactus|joshua|thorn|mesquite|baobab/.test(id)) return "scrub";
  return "broadleaf";
}

export interface LandClass {
  woodland: boolean;
  kind: TreeKind | null;
  riparian: boolean;
  /** the zone is one of the harsh climate's open anchors (dry: badlands, savanna; cold: tundra, peaks) */
  dry: boolean;
}

export interface Classifier {
  sampler: TreeSampler;
  at(x: number, z: number, h: number): LandClass;
}

export function landClassifier(recipe: WorldRecipe, field: WorldField, sampler: TreeSampler = treeSampler(recipe, field)): Classifier {
  const kinds = sampler.trees.map((t) => treeKindOf(t.rule.id));
  const per = new Float32Array(Math.max(1, kinds.length));
  const anchors = recipe.climate.zones?.anchors ?? [];
  const harsh = harshness(recipe).kind;
  const dryAnchor = new Set(anchors.filter((a) => (harsh === "cold" ? a.temperature < COLD_TEMPERATURE : a.moisture < DRY_MOISTURE)).map((a) => a.id));
  const rip = recipe.climate.zones?.riparian?.anchor ?? null;
  const ripBiomes = new Set(rip ? recipe.biomes.filter((b) => b.zones?.includes(rip)).map((b) => b.id) : []);
  const out: LandClass = { woodland: false, kind: null, riparian: false, dry: false };
  return {
    sampler,
    at(x, z, h) {
      const d = sampler.density(x, z, h, per);
      out.woodland = d >= WOODLAND_DENSITY;
      out.kind = null;
      if (d > 0) {
        const sum: Record<TreeKind, number> = { pine: 0, broadleaf: 0, scrub: 0 };
        for (let k = 0; k < kinds.length; k++) sum[kinds[k]!] += per[k]!;
        out.kind = (Object.keys(sum) as TreeKind[]).sort((a, b) => sum[b] - sum[a])[0]!;
      }
      const zone = field.zone(x, z).id;
      out.riparian = !!rip && zone !== rip && ripBiomes.has(field.biome(x, z, h).id);
      out.dry = !out.riparian && dryAnchor.has(zone);
      return out;
    },
  };
}

export interface BiomeReadReport {
  applies: boolean;
  harsh: Harsh;
  aridity: number;
  dryOpen: number;
  dryOpenMin: number;
  woodland: number;
  woodPlaced: number;
  kinds: Record<TreeKind, number>;
  ribbonM: number;
  findings: string[];
}

/** Longest run (m) along any wet river where a bank point is riparian. */
export function ribbonLength(recipe: WorldRecipe, field: WorldField, c: Classifier): number {
  let best = 0;
  for (const river of field.rivers) {
    if (river.water === false) continue;
    let run = 0;
    for (let i = 0; i + 1 < river.points.length; i++) {
      const [ax, az] = river.points[i]!, [bx, bz] = river.points[i + 1]!;
      const len = Math.hypot(bx - ax, bz - az);
      if (len <= 0) continue;
      const nx = -(bz - az) / len, nz = (bx - ax) / len;
      for (let s = 0; s < len; s += 20) {
        const x = ax + ((bx - ax) * s) / len, z = az + ((bz - az) * s) / len;
        const off = (river.width ?? 8) / 2 + 30;
        let rip = false;
        for (const sgn of [-1, 1]) {
          const px = x + nx * off * sgn, pz = z + nz * off * sgn;
          const h = field.height(px, pz);
          if (h <= recipe.seaLevel + 0.5) continue;
          if (c.at(px, pz, h).riparian) rip = true;
        }
        run = rip ? run + Math.min(20, len - s) : 0;
        best = Math.max(best, run);
      }
    }
  }
  return Math.round(best);
}

export function biomeRead(recipe: WorldRecipe, field: WorldField, c: Classifier = landClassifier(recipe, field)): BiomeReadReport {
  const { kind: harsh, severity } = harshness(recipe);
  const aridity = severity;
  const applies = harsh !== null;
  const ladder = altitudeLadder(landHeights(recipe, field, null));
  // "on the upland" = the HIGHER HALF of the land (above p50): a pine belt on the 40-60 m foothills of a 150 m island is
  // upland woodland though under the 60-m-over-p10 upland line (seed 2029: 50 % placed by that line, the woods all on the
  // foothill flanks); "under the treeline" = below p75 (the top quarter of a cold land is bare)
  const sorted = landHeights(recipe, field, null).sort((a, b) => a - b);
  const q = (f: number): number => sorted.length ? sorted[Math.floor(f * (sorted.length - 1))]! : 0;
  const upAt = recipe.seaLevel + (harsh === "cold" ? q(0.75) : q(0.5));
  const { points } = samplePoints(recipe, null, 2500);
  const limit = field.worldLimit;
  let land = 0, dryOpen = 0, wood = 0, placed = 0;
  const kinds: Record<TreeKind, number> = { pine: 0, broadleaf: 0, scrub: 0 };
  for (const [x, z] of points) {
    if (limit !== Infinity && x * x + z * z > limit * limit) continue;
    const h = field.height(x, z);
    if (h <= recipe.seaLevel + 0.5) continue;
    const w = field.waterY(x, z);
    if (w !== null && w > h) continue;
    land++;
    const k = c.at(x, z, h);
    if (k.woodland) {
      wood++;
      if (k.kind) kinds[k.kind]++;
      // by water: the ribbon itself, or a river / lake within 250 m
      let wet = k.riparian;
      for (let a = 0; a < 8 && !wet; a++) {
        const px = x + Math.cos((a * Math.PI) / 4) * 250, pz = z + Math.sin((a * Math.PI) / 4) * 250;
        const pw = field.waterY(px, pz);
        if (pw !== null && pw > field.height(px, pz) && field.height(px, pz) > recipe.seaLevel) wet = true;
      }
      // dry: woods climb to the upland's moisture; cold: woods stay under the treeline (the upland is bare)
      if ((harsh === "cold" ? h < upAt : h >= upAt) || wet) placed++;
    } else if (k.dry) dryOpen++;
  }
  const r: BiomeReadReport = {
    applies,
    harsh,
    aridity,
    dryOpen: land ? Math.round((dryOpen / land) * 100) / 100 : 0,
    dryOpenMin: dryOpenMin(aridity),
    woodland: land ? Math.round((wood / land) * 100) / 100 : 0,
    woodPlaced: wood ? Math.round((placed / wood) * 100) / 100 : 1,
    kinds,
    ribbonM: recipe.climate.zones?.riparian ? ribbonLength(recipe, field, c) : 0,
    findings: [],
  };
  if (applies) {
    const open = harsh === "cold" ? "tundra / snow / bare ground" : "dry open ground";
    if (r.dryOpen < r.dryOpenMin) r.findings.push(`${open} ${Math.round(r.dryOpen * 100)} % of the land < ${Math.round(r.dryOpenMin * 100)} % for a ${harsh} climate of severity ${aridity}`);
    if (r.woodPlaced < WOOD_PLACED_MIN) r.findings.push(`only ${Math.round(r.woodPlaced * 100)} % of the woodland stands ${harsh === "cold" ? "under the treeline" : "on the upland"} or by water (>= ${WOOD_PLACED_MIN * 100} %)`);
    if (recipe.climate.zones?.riparian && r.ribbonM < RIBBON_MIN_M) r.findings.push(`riparian ribbon ${r.ribbonM} m along the longest river reach < ${RIBBON_MIN_M} m`);
  }
  return r;
}

export function describeBiomeRead(r: BiomeReadReport): string {
  const k = r.kinds;
  const t = k.pine + k.broadleaf + k.scrub || 1;
  return `read ${r.harsh ?? "temperate"}: ${r.harsh === "cold" ? "tundra/snow open" : "dry open"} ${Math.round(r.dryOpen * 100)}% (min ${Math.round(r.dryOpenMin * 100)}%), wood placed ${Math.round(r.woodPlaced * 100)}%, pine/broad/scrub ${Math.round((k.pine / t) * 100)}/${Math.round((k.broadleaf / t) * 100)}/${Math.round((k.scrub / t) * 100)}, ribbon ${r.ribbonM} m`;
}

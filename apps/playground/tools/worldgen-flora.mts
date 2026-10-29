/**
 * SPECIES FOLLOW THE CLIMATE (2026-10-29 redstrand w5-ground). `init --from proving` borrows proving's scatter rules,
 * and they name species by BIOME only: palm grew on every beach and in the savanna, pine in the riparian "forest" —
 * so the dry red-sandstone world grew a palm grove on its town approach and palms by the dungeon shore, against the zone
 * frame (oasis = reeds, tamarisk, figs, scrub trees; dry ground = scrub and dead trees; pines only on the upland) and
 * Derek's firstshore ruling (palms only where the climate is tropical).
 *
 *   floraClimate   tropical | dry | cold | temperate, from the climate block (harshness: aridity / warmth; tropical =
 *                  warmth >= TROPICAL_WARMTH or a hot wet anchor)
 *   floraKindOf    the TREE kind of a scatter rule from its id / model: palm, jungle, pine, broadleaf, scrub-tree (null =
 *                  not a tree species this rule judges: bushes, rocks, logs)
 *   floraBan       why a kind may not grow in a biome of this climate: palms and jungle only in a tropical climate; in a
 *                  dry one pines only on the upland (not in a dry anchor's biome, the oasis ribbon or a shore band) and
 *                  broadleaf only by water or on the upland (the oasis is the dry world's broadleaf, figs and tamarisk)
 *   floraFindings  the `flora` status row and the dogfood rule: every live (rule, biome) pair the climate bans
 *   applyFlora     the generator side, run by `worldgen climate` and `worldgen flora`: each banned pair is taken out of
 *                  its rule (a rule left with no biome is dropped — an empty list means "anywhere"), and in a dry climate
 *                  its density goes to the kind the climate grows there instead (the oasis: broadleaf; dry ground: the
 *                  scrub tree), so the land keeps its trees and only their species change
 */
import type { WorldRecipe } from "@hitreg/core";
import { DRY_MOISTURE, harshness } from "./worldgen-biome-read.mts";

export type FloraClimate = "tropical" | "dry" | "cold" | "temperate";
export type FloraKind = "palm" | "jungle" | "pine" | "broadleaf" | "scrub-tree";

/** A temperate world this much nearer the hot pole is tropical. */
export const TROPICAL_WARMTH = 0.25;
/** An anchor this hot and wet (a jungle) makes the world tropical where it draws. */
const TROPICAL_ANCHOR = { temperature: 0.7, moisture: 0.65 };
/** A biome whose height band tops out under this (m over the sea) is a shore band, never upland. */
const SHORE_BAND_TOP = 10;

type Rule = WorldRecipe["scatter"][number];

export function floraClimate(recipe: WorldRecipe): FloraClimate {
  const h = harshness(recipe).kind;
  if (h) return h;
  const z = recipe.climate.zones;
  if ((z?.warmth ?? 0) >= TROPICAL_WARMTH) return "tropical";
  if (z?.anchors.some((a) => a.temperature >= TROPICAL_ANCHOR.temperature && a.moisture >= TROPICAL_ANCHOR.moisture)) return "tropical";
  return "temperate";
}

function ruleText(rule: Rule): string {
  const r = rule as { id: string; model?: string; prefab?: string; modelVariants?: { model: string }[] };
  return [r.id, r.model ?? "", r.prefab ?? "", ...(r.modelVariants ?? []).map((v) => v.model)].join(" ").toLowerCase();
}

export function floraKindOf(rule: Rule): FloraKind | null {
  const t = ruleText(rule);
  if (/palm/.test(t)) return "palm";
  if (/jungle|tropical|vine-hung/.test(t)) return "jungle";
  if (/stump|log|root|bush|shrub|fern|mushroom|rock|boulder|outcrop|hoodoo|crag|ledge|buttress|scree|talus/.test(t)) return null;
  if (/pine|\bfir\b|spruce|larch|cedar|conifer/.test(t)) return "pine";
  if (/acacia|tamarisk|\bfig\b|olive|mesquite|baobab|thorn-tree|(dead|dried|dry)[-_ ]?(dried[-_ ]?)?tree/.test(t)) return "scrub-tree";
  if (/maple|oak|willow|birch|beech|elm|ash-tree|canopy|broadleaf|\btree\b/.test(t)) return "broadleaf";
  return null;
}

interface BiomeTraits { dry: boolean; riparian: boolean; shore: boolean }

function biomeTraits(recipe: WorldRecipe): Map<string, BiomeTraits> {
  const zones = recipe.climate.zones;
  const anchors = new Map((zones?.anchors ?? []).map((a) => [a.id, a] as const));
  const rip = zones?.riparian?.anchor ?? null;
  const out = new Map<string, BiomeTraits>();
  for (const b of recipe.biomes) {
    const gates = (b.zones ?? []).filter((id) => anchors.has(id));
    const dryGate = (id: string) => (anchors.get(id)?.moisture ?? 1) < DRY_MOISTURE;
    const riparian = !!rip && gates.includes(rip);
    // dry: gated, and every live gate is a dry anchor (a biome shared with a wetter anchor grows on that one too)
    const dry = gates.length > 0 && gates.every((id) => id !== rip && dryGate(id));
    // the riparian anchor's own biome, when nothing but the ribbon (and dry anchors) draws it
    const ribbon = riparian && gates.every((id) => id === rip || dryGate(id));
    const shore = !!b.height && b.height[1] - recipe.seaLevel <= SHORE_BAND_TOP;
    out.set(b.id, { dry, riparian: ribbon, shore });
  }
  return out;
}

/** Why `kind` may not grow in biome `biome` of this world's climate, or null. */
export function floraBan(recipe: WorldRecipe, climate: FloraClimate = floraClimate(recipe), traits = biomeTraits(recipe)): (kind: FloraKind, biome: string) => string | null {
  return (kind, biome) => {
    if ((kind === "palm" || kind === "jungle") && climate !== "tropical") return `${kind} in a ${climate} climate (tropical only)`;
    if (climate !== "dry") return null;
    const t = traits.get(biome);
    if (!t) return null;
    if (kind === "pine" && (t.dry || t.riparian || t.shore)) return `pine in ${t.riparian ? "the oasis ribbon" : t.shore ? "a shore band" : "dry ground"} (a dry climate grows pine only on the upland)`;
    if (kind === "broadleaf" && (t.dry || t.shore)) return `broadleaf on ${t.shore ? "a shore band" : "dry ground"} (a dry climate grows broadleaf only by water or on the upland)`;
    return null;
  };
}

export interface FloraFinding { rule: string; biome: string; kind: FloraKind; why: string }

/** Every live (rule, biome) pair this climate bans. */
export function floraFindings(recipe: WorldRecipe): FloraFinding[] {
  const live = new Set(recipe.biomes.map((b) => b.id));
  const ban = floraBan(recipe);
  const out: FloraFinding[] = [];
  for (const rule of recipe.scatter) {
    const kind = floraKindOf(rule);
    if (!kind || rule.density <= 0) continue;
    // an empty biome list grows anywhere: judged against every biome of the world
    const biomes = rule.biomes.length ? rule.biomes : [...live];
    for (const b of biomes) {
      if (!live.has(b) || (rule.biomeDensity?.[b] ?? 1) <= 0) continue;
      const why = ban(kind, b);
      if (why) out.push({ rule: rule.id, biome: b, kind, why });
    }
  }
  return out;
}

export function describeFlora(findings: FloraFinding[]): string {
  const byRule = new Map<string, FloraFinding[]>();
  for (const f of findings) byRule.set(f.rule, [...(byRule.get(f.rule) ?? []), f]);
  return [...byRule.entries()].map(([rule, fs]) => `${rule} in ${fs.map((f) => f.biome).join("/")} (${fs[0]!.why})`).join("; ");
}

/**
 * Take every banned (rule, biome) pair out of the scatter; in a dry climate hand its density to the kind the climate
 * grows there instead. Mutates `recipe.scatter`; returns one note per change.
 */
export function applyFlora(recipe: WorldRecipe): string[] {
  const climate = floraClimate(recipe);
  const traits = biomeTraits(recipe);
  const findings = floraFindings(recipe);
  if (findings.length === 0) return [];
  const notes: string[] = [];
  const byId = new Map(recipe.scatter.map((r) => [r.id, r] as const));
  const firstOf = (kind: FloraKind): Rule | undefined => recipe.scatter.find((r) => floraKindOf(r) === kind);
  for (const f of findings) {
    const rule = byId.get(f.rule)!;
    const gain = rule.biomeDensity?.[f.biome] ?? 1;
    const wanted = rule.density * gain;
    if (rule.biomes.length === 0) rule.biomes = recipe.biomes.map((b) => b.id);
    rule.biomes = rule.biomes.filter((b) => b !== f.biome);
    if (rule.biomeDensity) delete rule.biomeDensity[f.biome];
    let line = `flora: ${rule.id} out of ${f.biome} (${f.why})`;
    // the replacement species, in a dry climate only: the oasis grows broadleaf (figs, tamarisk), dry ground scrub trees
    const t = traits.get(f.biome);
    const instead: FloraKind | null = climate !== "dry" || !t || t.shore ? null : t.riparian ? "broadleaf" : t.dry ? "scrub-tree" : null;
    const sub = instead ? firstOf(instead) : undefined;
    if (sub && sub !== rule && !sub.biomes.includes(f.biome) && sub.biomes.length > 0 && sub.density > 0) {
      const g = Math.round(Math.min(1, wanted / sub.density) * 1000) / 1000;
      sub.biomes = [...sub.biomes, f.biome];
      sub.biomeDensity = { ...(sub.biomeDensity ?? {}), [f.biome]: g };
      line += `; ${sub.id} grows there instead (x${g})`;
    }
    notes.push(line);
  }
  const before = recipe.scatter.length;
  const dropped = recipe.scatter.filter((r) => floraKindOf(r) && r.biomes.length === 0 && findings.some((f) => f.rule === r.id)).map((r) => r.id);
  recipe.scatter = recipe.scatter.filter((r) => !dropped.includes(r.id));
  if (recipe.scatter.length < before) notes.push(`flora: dropped ${dropped.join(", ")} (no biome of this ${climate} climate grows it)`);
  return notes;
}

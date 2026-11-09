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
import fs from "node:fs";
import path from "node:path";
import { DRY_MOISTURE, harshness } from "./worldgen-biome-read.mts";
import { propPolicy } from "./_prop-curation.mts";

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

/**
 * Why `kind` may not grow in biome `biome` of this world's climate, or null. `byWater`: the rule stands on a lake or
 * river bank (scatter `water.mode: "shore"`).
 *
 * BY WATER IN A DRY CLIMATE (owner ruling 2026-10-30, redstrand: "the weeping willows really shouldn't be there. Palm
 * trees along the lakes, yeah"): the desert's water edge (dry ground and the oasis ribbon) grows PALMS, never willows;
 * a willow stands only by upland water. Away from water a palm is still tropical only.
 */
export function floraBan(recipe: WorldRecipe, climate: FloraClimate = floraClimate(recipe), traits = biomeTraits(recipe)): (kind: FloraKind, biome: string, byWater?: boolean) => string | null {
  return (kind, biome, byWater = false) => {
    const t0 = traits.get(biome);
    const desertWater = climate === "dry" && byWater && !!t0 && (t0.dry || t0.riparian);
    if (kind === "palm" && desertWater) return null;
    if (kind === "palm" && climate === "dry" && byWater) return `palm by ${t0?.shore ? "a shore band's" : "upland"} water (a dry climate grows palms only at the desert's and the oasis's water)`;
    if ((kind === "palm" || kind === "jungle") && climate !== "tropical") return `${kind} in a ${climate} climate (tropical only${kind === "palm" && climate === "dry" ? "; by desert water a palm is fine" : ""})`;
    if (climate !== "dry") return null;
    const t = t0;
    if (!t) return null;
    if (kind === "broadleaf" && byWater) return desertWater ? `broadleaf by ${t.riparian ? "the oasis's" : "desert"} water (a dry climate's water edge grows palms; willows only by upland water)` : null;
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
    // a shore rule stands BY water: judged by the by-water rules (palms at desert water, willows at upland water)
    const byWater = (rule as { water?: { mode: string } }).water?.mode === "shore";
    // an empty biome list grows anywhere: judged against every biome of the world
    const biomes = rule.biomes.length ? rule.biomes : [...live];
    for (const b of biomes) {
      if (!live.has(b) || (rule.biomeDensity?.[b] ?? 1) <= 0) continue;
      const why = ban(kind, b, byWater);
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
    // a bank rule's trees are not handed to the dry ground's species (the woodland's oasis palms take the desert water)
    const bank = (rule as { water?: { mode: string } }).water?.mode === "shore";
    const instead: FloraKind | null = bank || climate !== "dry" || !t || t.shore ? null : t.riparian ? "broadleaf" : t.dry ? "scrub-tree" : null;
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

// ------------------------------------------------------------------ WOODLAND (2026-10-29 redstrand w9-world)
/*
 * Derek: "use the new trees and add woodland". The world-kit woodland-botany species join the scatter through the same
 * climate rule: each species has a ROLE and a KIND, and `applyWoodland` writes one generated rule per role from the
 * first species the climate and the owner's curation allow.
 *
 *   canopy      WOODS: clumped stands with edges (clump floor 0, a narrow blend) in the moister biomes: the riparian
 *               ribbon's own biome and every biome that is neither dry ground nor a shore band (uplands). Real woods,
 *               not a sprinkle: the density is the peak inside a stand, open ground between stands.
 *   understory  under the canopy: the SAME clump mask (same noise, same seed), so ferns stand where the woods stand
 *   shore       by sweet water: lake and river banks (scatter `water: shore`, snapped to the waterline, standing on
 *               the bank), on any land biome but a shore band; a willow by water is allowed in a dry climate, which
 *               grows broadleaf "only by water or on the upland"
 *
 * A species is REFUSED (and the refusal printed) when the climate bans its kind (jungle species outside a tropical
 * climate) or the owner's curation excludes it (`authoring/prop-curation.json` use exclude/trash: the Codex cattail
 * reeds, which the foundation cover reeds beat). Reeds are not a woodland role at all: shore reeds are ground cover.
 * Every generated rule keeps out of each sited place's footprint by a rule-limited clearing
 * (`features.clearings[].rules`), so the rocks the ground carries there stay.
 */

export type WoodlandRole = "canopy" | "understory" | "shore" | "oasis";
export interface WoodlandSpecies {
  /** catalogue / curation id */
  id: string;
  /** scatter model path (under a project's assets/models) */
  model: string;
  role: WoodlandRole;
  /** the tree kind the climate judges (null = not judged: ground plants) */
  kind: FloraKind | null;
  /** wind material filter */
  leaves: string;
  scale: [number, number];
  /** model-unit footprint radius and trunk collider */
  footprint: number;
  collider: "cylinder" | "none";
  colliderSize: [number, number, number];
}

/** Ordered by preference within a role; the first one allowed is used. */
export const WOODLAND_SPECIES: readonly WoodlandSpecies[] = [
  { id: "woodland-botany/vine-hung-jungle", model: "woodland-botany/vine-hung-jungle.glb", role: "canopy", kind: "jungle", leaves: "leaves,vine", scale: [0.85, 1.15], footprint: 1.2, collider: "cylinder", colliderSize: [0.9, 6, 0.9] },
  { id: "woodland-botany/great-canopy", model: "woodland-botany/great-canopy.glb", role: "canopy", kind: "broadleaf", leaves: "leaves", scale: [2.0, 3.0], footprint: 1.6, collider: "cylinder", colliderSize: [1, 7, 1] },
  { id: "woodland-botany/tropical-broadleaf", model: "woodland-botany/tropical-broadleaf.glb", role: "understory", kind: "jungle", leaves: "leaves,broadlea", scale: [0.8, 1.2], footprint: 0.6, collider: "none", colliderSize: [1, 1, 1] },
  { id: "woodland-botany/woodland-fern", model: "woodland-botany/woodland-fern.glb", role: "understory", kind: null, leaves: "leaves,fern,frond", scale: [0.8, 1.3], footprint: 0.55, collider: "none", colliderSize: [1, 1, 1] },
  { id: "woodland-botany/weeping-willow", model: "woodland-botany/weeping-willow.glb", role: "shore", kind: "broadleaf", leaves: "leaves,willow", scale: [2.0, 3.0], footprint: 1.3, collider: "cylinder", colliderSize: [0.9, 5, 0.9] },
  // 6.9 m at scale 1 -> 11-18 m date palms (owner ruling 2026-10-30: palms along a dry world's lakes)
  { id: "mmo/nature/PalmTree", model: "mmo/nature/PalmTree.gltf", role: "oasis", kind: "palm", leaves: "leaves,bush", scale: [1.6, 2.6], footprint: 0.9, collider: "cylinder", colliderSize: [0.6, 6.6, 0.6] },
];

/** The generated rule id per role (rewritten on every run). */
export const WOODLAND_RULE: Record<WoodlandRole, string> = { canopy: "woodland-canopy", understory: "woodland-understory", shore: "woodland-shore", oasis: "oasis-palm" };
/** The oasis palms' second, sparser band further back from the water: density falls off away from the bank. */
export const OASIS_GROVE_RULE = "oasis-palm-grove";
/** Every rule id the woodland writes (rewritten on every run). */
const WOODLAND_IDS: readonly string[] = [...Object.values(WOODLAND_RULE), OASIS_GROVE_RULE];
/** The woodland mask: low-frequency stands a few hundred metres across with a short edge. Canopy and understory share it. */
export const WOODLAND_CLUMP = { frequency: 0.0042, octaves: 3, threshold: 0.08, blend: 0.16, floor: 0, seed: 61 };
/** Peak densities (per m2) inside a stand. */
const WOODLAND_DENSITY = { canopy: 0.011, understory: 0.04, shore: 0.03, oasis: 0.03 } as const;
/** The bank band (wade, in footprints x scale: - = landward) and the grove band behind it, sparser. */
/** clearance: metres from roads, river banks and the LAKE OUTLINE (featureClearance counts lakes): a bank tree 4 m off
 *  the outline (the willow's) never stands at the water, so the palms keep 1 m (the bank) and 3 m (the grove). */
const OASIS_BANK = { reach: 14, wade: [-2.5, -0.6] as [number, number], keep: 1, clearance: 1 };
const OASIS_GROVE = { reach: 18, wade: [-9, -2.5] as [number, number], keep: 0.5, density: 0.012, clearance: 3 };
const WOODLAND_KEEP_PREFIX = "woodland-keep-";
const BARE_BIOME = /seabed|beach|alpine|crag|glacier|ice|snow/;

export interface WoodlandPlace { id: string; center: [number, number]; radius: number }
export interface WoodlandOptions {
  /** the owner's curation: why this catalogue id may not be placed (null = allowed) */
  excluded?: (id: string) => string | null;
  /** sited places: the generated species keep out of each footprint (plus a margin) */
  places?: readonly WoodlandPlace[];
}

/** The biomes a woodland of this climate stands in: the riparian ribbon's biome and every non-dry, non-shore land biome. */
export function woodlandBiomes(recipe: WorldRecipe): string[] {
  const traits = biomeTraits(recipe);
  return recipe.biomes.filter((b) => {
    const t = traits.get(b.id);
    return !!t && !t.shore && !t.dry && !BARE_BIOME.test(b.id);
  }).map((b) => b.id);
}

/** Land biomes a shore species may stand in (by water): every biome but the sea floor, beach, bare tops and shore bands. */
function shoreBiomes(recipe: WorldRecipe): string[] {
  const traits = biomeTraits(recipe);
  return recipe.biomes.filter((b) => !traits.get(b.id)?.shore && !BARE_BIOME.test(b.id)).map((b) => b.id);
}

/**
 * Write the woodland: one rule per role from the first species the climate and the curation allow, the keep-outs
 * round the places, and the notes (what grows, what was refused and why). Idempotent; mutates the recipe.
 */
export function applyWoodland(recipe: WorldRecipe, o: WoodlandOptions = {}): string[] {
  const notes: string[] = [];
  const climate = floraClimate(recipe);
  const ban = floraBan(recipe, climate);
  const woods = woodlandBiomes(recipe);
  const shore = shoreBiomes(recipe);
  const ruleIds = new Set<string>(WOODLAND_IDS);
  recipe.scatter = recipe.scatter.filter((r) => !ruleIds.has(r.id));
  const written: string[] = [];
  const rip = recipe.climate.zones?.riparian?.anchor ?? null;
  for (const role of ["canopy", "understory", "shore", "oasis"] as WoodlandRole[]) {
    const bank = role === "shore" || role === "oasis";
    const biomes = bank ? shore : woods;
    // the oasis is a DRY world's water edge: elsewhere the climate's own palms (tropical) or none
    if (role === "oasis" && climate !== "dry") continue;
    let chosen: WoodlandSpecies | null = null;
    let allowed: string[] = [];
    for (const sp of WOODLAND_SPECIES.filter((s) => s.role === role)) {
      // the climate first (the reason that holds whatever the owner decides), then the owner's curation
      if ((sp.kind === "jungle" || (sp.kind === "palm" && !bank)) && climate !== "tropical") { notes.push(`woodland: ${sp.id} refused (${sp.kind} in a ${climate} climate: tropical only)`); continue; }
      const ex = o.excluded?.(sp.id) ?? null;
      if (ex) { notes.push(`woodland: ${sp.id} refused (owner curation: ${ex})`); continue; }
      // a bank species is judged by the by-water rules: palms at the desert's water, willows at upland water
      const ok = biomes.filter((b) => !sp.kind || !ban(sp.kind, b, bank));
      if (!ok.length) { notes.push(`woodland: ${sp.id} refused (no ${role} biome of this ${climate} climate grows ${sp.kind})`); continue; }
      if (!chosen) { chosen = sp; allowed = ok; }
    }
    if (!chosen) { notes.push(`woodland: no ${role} species allowed`); continue; }
    const id = WOODLAND_RULE[role];
    const gain: Record<string, number> = {};
    for (const b of allowed) {
      const biome = recipe.biomes.find((x) => x.id === b);
      // the wettest woods are thickest: the riparian ribbon full, the other moist biomes thinner, the high bands thin
      gain[b] = rip && biome?.zones?.includes(rip) ? 1 : /highland|montane/.test(b) ? 0.45 : 0.7;
    }
    const under = role === "understory";
    const rule = {
      id,
      model: chosen.model,
      foliageNormals: 1,
      foliageUp: under ? 0.75 : 0.8,
      brightness: under ? 1.25 : 1.35,
      wind: { mode: under ? "sway" : "ripple", strength: under ? 0.035 : 0.05, speed: under ? 1.1 : 1.5, canopy: under ? 0.25 : 0.4, materials: chosen.leaves },
      cameraFade: !under,
      biomes: allowed,
      biomeDensity: bank ? {} : gain,
      clump: bank ? { frequency: 0.02, octaves: 2, threshold: -0.1, blend: 0.4, floor: 0.25, seed: 62 } : { ...WOODLAND_CLUMP },
      density: WOODLAND_DENSITY[role],
      slopeMax: under ? 0.6 : 0.45,
      slopeMin: 0,
      yawOffset: 0,
      height: [1.5, 260],
      scale: chosen.scale,
      alignToNormal: 0,
      yOffset: under ? -0.02 : -0.3,
      jitter: 0.9,
      clearance: under ? 0.6 : role === "oasis" ? OASIS_BANK.clearance : 4,
      footprint: chosen.footprint,
      spacing: under ? 0.6 : 1.5,
      collider: chosen.collider,
      colliderSize: chosen.colliderSize,
      static: true,
      castShadow: !under,
      lod: true,
      ...(role === "shore" ? { water: { mode: "shore", waters: "both", snap: true, snapStep: 6, reach: 14, wade: [-1.6, -0.9], keep: 1, steepness: 0.4, headland: 0 } } : {}),
      ...(role === "oasis" ? { water: { mode: "shore", waters: "both", snap: true, snapStep: 6, reach: OASIS_BANK.reach, wade: OASIS_BANK.wade, keep: OASIS_BANK.keep, steepness: 0.4, headland: 0 } } : {}),
    };
    recipe.scatter.push(rule as unknown as Rule);
    written.push(`${id} = ${chosen.id} in ${allowed.join("/")}`);
    if (role === "oasis") {
      // the grove behind the bank row: fewer palms further from the water (the density falls off with distance)
      recipe.scatter.push({ ...rule, id: OASIS_GROVE_RULE, density: OASIS_GROVE.density, clearance: OASIS_GROVE.clearance, clump: { ...rule.clump, seed: 63 }, water: { ...rule.water!, reach: OASIS_GROVE.reach, wade: OASIS_GROVE.wade, keep: OASIS_GROVE.keep } } as unknown as Rule);
      written.push(`${OASIS_GROVE_RULE} = its grove band`);
    }
  }
  notes.unshift(`woodland (${climate} climate): ${written.join("; ") || "nothing allowed"}`);
  // keep-outs: the generated species never stand in a sited place's footprint (the rocks there stay)
  const feats = recipe.features as unknown as { clearings?: { id: string }[] };
  const kept = (feats.clearings ?? []).filter((c) => !c.id.startsWith(WOODLAND_KEEP_PREFIX));
  const rules = recipe.scatter.filter((r) => ruleIds.has(r.id)).map((r) => r.id);
  const keeps = rules.length ? (o.places ?? []).map((p) => ({ id: `${WOODLAND_KEEP_PREFIX}${p.id}`, center: p.center, radius: Math.round(p.radius + 20), feather: 15, keep: 0, scatter: true, cover: false, owner: "woodland", rules })) : [];
  if (kept.length || keeps.length || feats.clearings) feats.clearings = [...kept, ...keeps];
  if (keeps.length) notes.push(`woodland: kept out of ${keeps.map((k) => `${k.id.slice(WOODLAND_KEEP_PREFIX.length)} r${k.radius}`).join(", ")}`);
  return notes;
}

export interface WoodlandFinding { rule: string; why: string }

/** The woodland check: a scatter rule placing an owner-excluded catalogue model, or a generated woodland rule with no
 * keep-out round a sited place. */
export function woodlandFindings(recipe: WorldRecipe, o: WoodlandOptions = {}): WoodlandFinding[] {
  const out: WoodlandFinding[] = [];
  if (o.excluded) {
    for (const r of recipe.scatter) {
      const rr = r as { model?: string; modelVariants?: { model: string }[] };
      for (const m of [rr.model ?? "", ...(rr.modelVariants ?? []).map((v) => v.model)]) {
        const id = WOODLAND_SPECIES.find((s) => s.model === m)?.id ?? (m.startsWith("woodland-botany/") ? m.replace(/\.glb$/, "") : null);
        const ex = id ? o.excluded(id) : null;
        if (ex) out.push({ rule: r.id, why: `places ${id}, which the owner's curation excludes (${ex})` });
      }
    }
  }
  const ruleIds = new Set<string>(WOODLAND_IDS);
  const live = recipe.scatter.filter((r) => ruleIds.has(r.id)).map((r) => r.id);
  if (live.length) {
    const clearings = (recipe.features as unknown as { clearings?: { id: string; rules?: string[] }[] }).clearings ?? [];
    for (const p of o.places ?? []) {
      const c = clearings.find((x) => x.id === `${WOODLAND_KEEP_PREFIX}${p.id}`);
      if (!c || live.some((id) => !c.rules?.includes(id))) out.push({ rule: live.join(","), why: `no woodland keep-out round ${p.id} (worldgen flora)` });
    }
  }
  return out;
}

// ------------------------------------------------------------------ GROUND COVER species (2026-10-29 w9: papyrus at town-1's lake)
/*
 * Cover follows the climate like the trees do. A layer's KINDS come from the tiles it draws (the atlas page's
 * tiles.json names) and its id:
 *
 *   tropical  papyrus, bamboo, jungle plants: only in a tropical climate (2026-10-29 w9)
 *   crop      wheat: a crop, grown only in DECLARED FIELDS (`cover[].fields` + `features.fields`), in any climate
 *   grain     wheat-looking plumes (savannatall): never on a dry world's dry ground
 *   lush      tall green grass and meadow flowers: never on a dry world's dry ground
 *   desert    desert scrub, prickly pear, agave, short straw tufts: what dry ground grows instead
 *
 * Owner ruling 2026-10-30 (redstrand): "we have this wheat-looking grass, which honestly a desert wouldn't have; now the
 * farm would have some crops."
 */
type CoverLayer = { id: string; texture?: string; tiles?: number[]; biomes: string[]; surfaces?: string[]; density?: number; water?: { mode: string }; fields?: boolean; clump?: unknown };
export type CoverKind = "tropical" | "crop" | "grain" | "lush" | "desert";
/** Names of an atlas page's tiles (its tiles.json), by texture id; null = unknown page. */
export type CoverTileNames = (texture: string) => readonly (string | null)[] | null;

const TILE_KIND: Record<string, CoverKind> = {
  wheat: "crop",
  savannatall: "grain",
  tallgrass: "lush", poppies: "lush", daisies: "lush", lupine: "lush", buttercups: "lush", clover: "lush", foxglove: "lush", bluebells: "lush",
  desertscrub: "desert", pricklypear: "desert", agave: "desert", savannagrass: "desert",
  papyrus: "tropical", bamboo: "tropical", elephantear: "tropical", junglefern: "tropical", bromeliad: "tropical", heliconia: "tropical",
};

/** The kinds a cover layer draws: from its tiles' names (when the page is known) and its id. */
export function coverKindsOf(layer: { id: string; texture?: string; tiles?: number[] }, tileNames?: CoverTileNames): Set<CoverKind> {
  const out = new Set<CoverKind>();
  const id = layer.id.toLowerCase();
  if (/papyrus|palm|bamboo|jungle/.test(id)) out.add("tropical");
  if (/wheat|grain|crop/.test(id)) out.add("crop");
  const names = layer.texture && tileNames ? tileNames(layer.texture) : null;
  if (names) {
    const used = layer.tiles?.length ? layer.tiles : names.map((_, i) => i);
    for (const t of used) {
      const k = TILE_KIND[names[t] ?? ""];
      if (k) out.add(k);
    }
  }
  return out;
}

/** A cover layer's plant kind, judged like a tree's: papyrus, palms and bamboo are tropical. */
export function coverKindOf(layer: { id: string; texture?: string }): "tropical" | null {
  return coverKindsOf(layer).has("tropical") ? "tropical" : null;
}

export interface CoverFloraFinding { layer: string; biome: string; why: string }

/** Every live (cover layer, biome) pair this climate does not grow, and every crop layer growing wild. */
export function coverFloraFindings(recipe: WorldRecipe, tileNames?: CoverTileNames): CoverFloraFinding[] {
  const climate = floraClimate(recipe);
  const traits = biomeTraits(recipe);
  const live = new Set(recipe.biomes.map((b) => b.id));
  const out: CoverFloraFinding[] = [];
  for (const l of recipe.cover as unknown as CoverLayer[]) {
    if ((l.density ?? 1) <= 0) continue;
    const kinds = coverKindsOf(l, tileNames);
    const biomes = (l.biomes?.length ? l.biomes : [...live]).filter((b) => live.has(b));
    if (kinds.has("crop") && !l.fields) {
      out.push({ layer: l.id, biome: "(wild)", why: "crop cover (wheat) grows only in declared fields (cover[].fields + features.fields)" });
      continue;
    }
    if (l.fields) continue;
    if (kinds.has("tropical") && climate !== "tropical") {
      for (const b of biomes) out.push({ layer: l.id, biome: b, why: `tropical cover (papyrus/palm/bamboo) in a ${climate} climate` });
      continue;
    }
    if (climate === "dry" && !l.water && (kinds.has("grain") || kinds.has("lush"))) {
      for (const b of biomes) if (traits.get(b)?.dry) out.push({ layer: l.id, biome: b, why: `${kinds.has("grain") ? "wheat-looking grass" : "lush grass/flowers"} on a dry world's dry ground (it grows desert scrub, cactus and straw tufts)` });
    }
  }
  return out;
}

/**
 * Make the cover follow the climate. Mutates `recipe.cover`; returns notes.
 *  - a crop layer becomes a FIELDS layer (no biome/surface/clump gate: the declared field decides);
 *  - tropical cover leaves a non-tropical world's biomes (the temperate layer of the same water mode takes them);
 *  - on a dry world wheat-looking and lush cover leave the dry biomes; every desert layer grows there instead (with the
 *    ground surfaces the leaving layer stood on).
 * A layer left with no biome is dropped (an empty list would grow anywhere).
 */
export function applyCoverFlora(recipe: WorldRecipe, tileNames?: CoverTileNames): string[] {
  const found = coverFloraFindings(recipe, tileNames);
  if (!found.length) return [];
  const notes: string[] = [];
  const layers = recipe.cover as unknown as CoverLayer[];
  const emptied: string[] = [];
  for (const id of new Set(found.map((f) => f.layer))) {
    const l = layers.find((x) => x.id === id)!;
    const kinds = coverKindsOf(l, tileNames);
    if (kinds.has("crop") && !l.fields) {
      l.fields = true;
      l.biomes = [];
      l.surfaces = [];
      delete l.clump;
      notes.push(`flora: cover ${id} is a crop: it grows only in declared fields now (features.fields; worldgen vegetation --fields)`);
      continue;
    }
    const gone = found.filter((f) => f.layer === id).map((f) => f.biome);
    let instead: CoverLayer[];
    if (kinds.has("tropical")) {
      const twin = layers.find((x) => x !== l && !coverKindsOf(x, tileNames).has("tropical") && x.biomes.length > 0 && (x.water?.mode ?? null) === (l.water?.mode ?? null));
      instead = twin ? [twin] : [];
    } else {
      instead = layers.filter((x) => x !== l && !x.water && !x.fields && x.biomes.length > 0 && coverKindsOf(x, tileNames).has("desert"));
    }
    for (const t of instead) {
      for (const b of gone) if (!t.biomes.includes(b)) t.biomes.push(b);
      if (!kinds.has("tropical") && t.surfaces?.length) for (const s of l.surfaces ?? []) if (!t.surfaces.includes(s)) t.surfaces.push(s);
    }
    if (!l.biomes.length) l.biomes = recipe.biomes.map((b) => b.id);
    l.biomes = l.biomes.filter((b) => !gone.includes(b));
    if (!l.biomes.length) emptied.push(id);
    notes.push(`flora: cover ${id} out of ${gone.join("/")}${instead.length ? `; ${instead.map((t) => t.id).join(", ")} grow${instead.length > 1 ? "" : "s"} there instead` : ""}`);
  }
  if (emptied.length) {
    (recipe as { cover: unknown[] }).cover = layers.filter((x) => !emptied.includes(x.id));
    notes.push(`flora: dropped cover ${emptied.join(", ")} (no biome of this ${floraClimate(recipe)} climate grows it)`);
  }
  return notes;
}

/**
 * The woodland's context for a world on disk: the owner's curation of the project closure that holds `recipeFile`
 * (projects/<p>/assets/worlds/<w>.json) and the sited places (recipe towns + every zone's reservations).
 */
export function woodlandContext(recipe: WorldRecipe, recipeFile: string, world: string): WoodlandOptions {
  recipeFile = path.resolve(recipeFile);
  const m = /[\\/]projects[\\/]([^\\/]+)[\\/]assets[\\/]worlds[\\/]/.exec(recipeFile);
  const places: WoodlandPlace[] = recipe.features.towns.map((t) => ({ id: t.id, center: [t.center[0], t.center[1]] as [number, number], radius: t.radius }));
  if (!m) return { places };
  const projectsRoot = path.resolve(recipeFile, "..", "..", "..", "..");
  let excluded: WoodlandOptions["excluded"];
  try {
    const pol = propPolicy(projectsRoot, m[1]!);
    excluded = (id) => { const e = pol.excluded(id); return e ? `${e.project}: ${e.note || "excluded"}` : null; };
  } catch { excluded = undefined; }
  const zones = path.join(projectsRoot, m[1]!, "authoring", "zonegen", world, "zones");
  if (fs.existsSync(zones))
    for (const z of fs.readdirSync(zones)) {
      const f = path.join(zones, z, "reservations.json");
      if (!fs.existsSync(f)) continue;
      for (const r of (JSON.parse(fs.readFileSync(f, "utf8")).reservations ?? []) as { location: string; center?: [number, number]; radius?: number }[])
        if (r.center && r.radius && !places.some((p) => p.id === r.location)) places.push({ id: r.location, center: r.center, radius: r.radius });
    }
  return { excluded, places };
}

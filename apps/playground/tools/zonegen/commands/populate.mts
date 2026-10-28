/**
 * zonegen populate <world> --project <p> --zone <z> [--dry] [--budget 20] [--view 150] [--step 16] [--gap 100] [--starter]
 *
 * Fills a zone's wilderness with creatures: the zone bestiary's wildlife in its habitats, every group at the places it
 * holds, the rares where they haunt, and a low-density fill so no stretch of walkable wilderness is empty. Output is an
 * ops batch of `spawnArea` entities (+ the NPC templates they name), never a live-scene write:
 *
 *   zones/<z>/populate/ops.json          the batch (add-entity / set-component / set-tags)
 *   zones/<z>/populate/inverse.json      its inverse against the scene as it is now (preview; install records the real one)
 *   zones/<z>/populate/install.mts       the coordinator's installer (--dry-run, --uninstall, --scene <id>)
 *   zones/<z>/reports/populate.json      areas by creature and group, densities, placeholders, worst case in view
 *   zones/<z>/reports/populate-map.png   spawn areas over the zone
 *
 * WHERE (all from data, on a grid of --step metres over the zone):
 *  - the zone's own land: inside its region polygon, outside its nested town zones;
 *  - minus every sanctuary (safe POIs and safe town zones, as serve() publishes them) plus --sanctuary-margin;
 *  - minus every road / path / street (recipe roads, their half width plus --road-margin either side);
 *  - minus water deeper than --wade, ground steeper than --max-slope (sin of the angle, the field's unit);
 *  - minus every reservation that is not a `wild` location (its radius + 10 m) — POIs are built by their owners;
 *  - an area's whole spawn disc must stay on that land (clearance >= spread), and its whole reach
 *    (spread + leash + roam + 20 m band) inside the zone border, the measure SpawnAreaManager.borderWarnings audits.
 * Habitat at a point comes from the world field's biome (BIOME_HABITATS below) plus derived habitats: coast (ground
 * within 4 m of sea level), marsh (standing water or fen/swamp), farmland (open low ground within 1 km of a town),
 * town-outskirts (the 250 m outside a sanctuary), ruin (80 m around a ruin/watchtower site), road (just off a road).
 * Levels run from the zone band's low end at the hub town to its high end at the 95th percentile of walking distance
 * (Dijkstra over the grid: water and steep ground cost more), clamped to each creature's own band, in tiers of
 * --tier levels (one template per creature, theme and tier).
 */
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import zlib from "node:zlib";
import { assetPath, findAsset } from "../../_closure.mjs";
import {
  applyOps,
  ComponentRegistry,
  createWorldField,
  pointInPolygon,
  polygonEdgeDistance,
  registerChunkComponents,
  registerCoreComponents,
  sanctuariesFromPois,
  worldRecipeSchema,
  type Op,
  type SanctuaryCircle,
} from "@hitreg/core";
import { digest, digestMatches, exists, readJson, writeJson, type Ctx, type Finding } from "../lib.mts";
import { HABITATS, castSchema, type Bestiary, type Creature } from "../schemas.mts";
import { loadZonePlan, type ZonePlan } from "./_zone.mts";
import { DISPOSITIONS, fodderLevel, starterDisposition, starterMixFindings, type Shares, WANDER_RULES, loadWanderers, longestRun, nameSlug, offsetLine, resample, routeLength, wandererFindings, wanderersFile, type WandererArea } from "./_wanderers.mts";
import { checkHumanSubtree, dressFor, humanConfigFile, humanTemplateOps, loadHumanKit, type HumanDress, type HumanKit } from "./_human-template.mts";

type Habitat = (typeof HABITATS)[number];
type Role = "melee" | "ranged" | "caster" | "swarm" | "brute" | "skirmisher" | "support" | "elite" | "boss";

/** World-field biome id -> bestiary habitats. */
export const BIOME_HABITATS: Record<string, Habitat[]> = {
  seabed: [], beach: ["coast"], tundra: ["tundra"], taiga: ["forest"], grassland: ["grassland"], forest: ["forest"],
  foothills: ["grassland", "mountain"], moor: ["grassland"], fen: ["marsh"], savanna: ["grassland"], swamp: ["marsh"],
  jungle: ["forest"], desert: ["desert"], badlands: ["badlands"], blight: ["badlands"], highland: ["grassland", "mountain"],
  montane: ["mountain"], alpine: ["mountain"], crag: ["mountain"],
};
const OPEN_BIOMES = new Set(["grassland", "moor", "fen", "savanna", "foothills", "swamp"]);

/** Pack vocabulary per role (the `story` command's pack fields): size, scatter, leash, idle roam, and stats. */
export const PACK: Record<Role, { min: number; max: number; spread: number; leash: number; roam: number; hp: number; xp: number; aggro: number }> = {
  swarm: { min: 3, max: 5, spread: 7, leash: 22, roam: 10, hp: 55, xp: 0.6, aggro: 9 },
  melee: { min: 2, max: 3, spread: 6, leash: 26, roam: 8, hp: 110, xp: 1, aggro: 12 },
  skirmisher: { min: 2, max: 3, spread: 8, leash: 30, roam: 12, hp: 90, xp: 1, aggro: 13 },
  ranged: { min: 1, max: 2, spread: 8, leash: 30, roam: 6, hp: 80, xp: 1, aggro: 16 },
  caster: { min: 1, max: 2, spread: 5, leash: 24, roam: 4, hp: 80, xp: 1.2, aggro: 15 },
  brute: { min: 1, max: 2, spread: 5, leash: 24, roam: 6, hp: 200, xp: 1.6, aggro: 11 },
  support: { min: 1, max: 1, spread: 4, leash: 22, roam: 4, hp: 80, xp: 1, aggro: 12 },
  elite: { min: 1, max: 1, spread: 2, leash: 20, roam: 3, hp: 260, xp: 3, aggro: 14 },
  boss: { min: 1, max: 1, spread: 0, leash: 15, roam: 0, hp: 800, xp: 10, aggro: 16 },
};
/** Packs per km² of a creature's habitat. */
export const DENSITY = { sparse: 1.2, common: 3, dense: 6 } as const;
/** Placeholder capsule size [diameter, height, diameter] per body family. */
const CAPSULE: Record<string, [number, number, number]> = { human: [0.8, 1.8, 0.8], ghoul: [0.8, 1.8, 0.8], ratkin: [0.7, 1.5, 0.7], ogre: [1.3, 2.8, 1.3] };

const REASON = ["ok", "outside zone", "sanctuary/town", "road", "water", "steep", "reserved POI", "unreachable"] as const;
const BORDER_BAND = 20;

interface Spawn { template: string; count: number; spread: number }
export interface Area {
  id: string;
  kind: "camp" | "group" | "rare" | "wildlife" | "fill" | "wanderer";
  /** A wanderer (zones/<z>/wanderers.json): the roaming spawnArea fields (placement, mix, patrol...) and creatures alive. */
  life?: Record<string, unknown>;
  alive?: number;
  x: number;
  y: number;
  z: number;
  level: number;
  creature: string;
  group?: string;
  location?: string;
  camp?: string;
  /** A reused camp moved off illegal ground: its recipe centre. */
  movedFrom?: [number, number];
  habitats: string[];
  radius: number;
  sleepRadius: number;
  idleSeconds: number;
  leash: number;
  roam: number;
  spawns: Spawn[];
  /** A starter zone's wildlife: its disposition as a mob-brain temperament (and wary metres). */
  temperament?: "hostile" | "territorial" | "passive";
  territory?: number;
}
export interface Template {
  /** combat-actor loot spec ('item:qty:chance,...'): the plan's items whose source is this creature. */
  loot?: string;
  id: string;
  creature: string;
  family: string;
  theme: string;
  name: string;
  level: number;
  levels: [number, number];
  role: Role;
  faction: string;
  /** True only for a capsule: a creature with no body at all (resolveBody). */
  placeholder: boolean;
  /**
   * Prefab id (ready body, or the family's base body when its theme is unpainted), "human" (a dressed, armed modular
   * human cloned from the project's declared pattern, authoring/zonegen/human-template.json) or "capsule".
   */
  body: string;
  why: string;
  /** An art row: the paint (or modelled item) this template still stands in for; its body renders regardless. */
  art?: string;
  /** body "human": the stand-in weapon / outfit it wears (an art row, not a placeholder). */
  standIns?: string[];
  /** A painted theme with no prefab of its own: the base body wears this material (materials/<id>.json). */
  material?: string;
  /** Abilities the brain uses and the caster bar holds. */
  abilities: string[];
  /** body "human": outfit, worn items, held weapon, and any stand-ins (which keep the template a placeholder). */
  dress?: HumanDress;
  /** body "human": the look picked from the creation options. */
  appearance?: Record<string, string>;
  standsAt?: string;
  /** Body size multiplier (bestiary `scale`); absent = 1. */
  scale?: number;
}

const hash01 = (s: string): number => {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return ((h >>> 0) % 1000003) / 1000003;
};
const r2 = (v: number): number => Math.round(v * 100) / 100;

export function populateDir(ctx: Ctx, zone: string): string {
  return path.join(ctx.paths.zoneDir(zone), "populate");
}
/**
 * zones/<z>/site-packs.json: the clearings the owners of large sites handed over (an estate's lawns, a cave's chambers,
 * a shore camp), filled exactly as written. The plan's groups only hold the places the QUEST plan reserved; a site added
 * after it (exploration) has no holder, so its creatures are listed here: where, who, how many, what level, and any
 * named creature that leads the pack. `y` is given for a spot underground (the cave floor): the spawn area stands at
 * that height and the server spawns on that floor.
 */
export function sitePacksFile(ctx: Ctx, zone: string): string {
  return path.join(ctx.paths.zoneDir(zone), "site-packs.json");
}
interface SitePack {
  id: string;
  site: string;
  at: [number, number];
  y?: number;
  faction: string;
  level: number;
  members: { creature: string; theme?: string; role: Role; count: number; scale?: number }[];
  named?: { id: string; name: string; base: string; theme?: string; level: number; scale?: number; title?: string };
}

/** The files whose content decides the population: the status row re-digests them. */
export function populateInputs(ctx: Ctx, zone: string): string[] {
  const p = ctx.paths;
  return [p.zoneBestiary(zone), p.reservations(zone), p.quests(zone), p.brief(zone), p.bestiary, p.recipe, humanConfigFile(p.projectDir), sitePacksFile(ctx, zone), wanderersFile(ctx, zone)].filter((x) => x.endsWith("site-packs.json") || x.endsWith("wanderers.json") ? exists(x) : true);
}

export async function run(ctx: Ctx): Promise<number> {
  const zone = ctx.zone;
  if (!zone) {
    console.error("usage: zonegen populate <world> --project <p> --zone <id> [--dry] [--budget 20] [--view 150]");
    return 2;
  }
  const f: Finding[] = [];
  const plan = loadZonePlan(ctx, zone, f);
  if (!plan || !plan.zoneBestiary || !plan.bestiary) {
    if (plan && !plan.zoneBestiary) f.push({ level: "error", code: "missing-file", message: "zone bestiary.json not written" });
    for (const x of f) console.log(`  ERROR ${x.code}: ${x.message}`);
    return 1;
  }
  const t0 = Date.now();
  const out = populate(ctx, zone, plan, f);
  if (!out) {
    for (const x of f) console.log(`  ${x.level === "error" ? "ERROR" : "warn "} ${x.code}: ${x.message}`);
    return 1;
  }
  const { areas, templates, report, ops } = out;

  // ---- listing (always) -----------------------------------------------------------------------------------------
  const n = report.numbers as Record<string, unknown>;
  console.log(`populate ${zone}: ${areas.length} spawn areas, ${n.creatures} creatures over ${n.wildernessKm2} km² of wilderness (${n.perKm2}/km²) in ${Date.now() - t0} ms`);
  for (const [c, row] of Object.entries(report.byCreature as Record<string, { areas: number; creatures: number; perKm2: number; placeholder: boolean }>))
    console.log(`  ${c.padEnd(22)} ${String(row.areas).padStart(3)} areas ${String(row.creatures).padStart(4)} creatures  ${String(row.perKm2).padStart(5)}/km²${row.placeholder ? "  PLACEHOLDER" : ""}`);
  for (const [g, row] of Object.entries(report.byGroup as Record<string, { areas: number; creatures: number; locations: string[] }>))
    console.log(`  group ${g.padEnd(24)} ${row.areas} areas, ${row.creatures} creatures at ${row.locations.join(", ")}`);
  const camps = report.camps as { id: string; use: string }[];
  for (const c of camps) console.log(`  ${c.id}: ${c.use}`);
  for (const [id, w] of Object.entries((report.wanderers ?? {}) as Record<string, { placement: string; alive: number; routeM?: number; radius?: number; templates: string[]; rares: string[] }>))
    console.log(`  wanderer ${id.padEnd(26)} ${w.placement.padEnd(8)} ${String(w.alive).padStart(2)} alive  ${w.routeM ? `route ${w.routeM} m` : `disc ${w.radius} m`}  ${w.templates.join(", ")}${w.rares.length ? `  rares: ${w.rares.join("; ")}` : ""}`);
  console.log(`  templates: ${templates.length} (${templates.filter((t) => t.placeholder).length} capsule placeholder, ${templates.filter((t) => t.art).length} art rows)`);
  const w = n.worstInView as { count: number; at: number[]; p95: number; view: number; budget: number };
  console.log(`  worst case in view: ${w.count} animated creatures at [${w.at.join(", ")}] (p95 ${w.p95}; ${w.view} m all round, budget ${w.budget})`);
  console.log(`  excluded km²: ${JSON.stringify(n.excludedKm2)}`);
  const cov = n.coverage as { largestEmptyAcross: number; coveredShare: number; coverableShare: number; gap: number; budgetSkips: number };
  console.log(`  coverage: ${Math.round(cov.coveredShare * 100)}% of wilderness within ${cov.gap} m of an area (${Math.round(cov.coverableShare * 100)}% coverable by a legal site; ${cov.budgetSkips} fill sites refused by the view budget); largest empty stretch ~${cov.largestEmptyAcross} m across`);
  for (const x of f) console.log(`  ${x.level === "error" ? "ERROR" : "warn "} ${x.code}: ${x.message}`);
  if (ctx.flag("dry")) {
    for (const a of areas) console.log(`    ${a.id.padEnd(26)} ${a.kind.padEnd(8)} [${Math.round(a.x)}, ${Math.round(a.z)}] lv ${a.level} ${[...templates.filter((t) => t.standsAt === a.id).map((t) => `1x ${t.id} (the template itself)`), ...a.spawns.map((s) => `${s.count}x ${s.template}`)].join(" + ") || "(disabled)"}`);
    console.log("--dry: nothing written");
    return f.some((x) => x.level === "error") ? 1 : 0;
  }

  // ---- files ------------------------------------------------------------------------------------------------------
  const dir = populateDir(ctx, zone);
  fs.mkdirSync(dir, { recursive: true });
  writeJson(path.join(dir, "ops.json"), ops);
  const opsSha = createHash("sha256").update(fs.readFileSync(path.join(dir, "ops.json"))).digest("hex");
  // inverse against the live scene as it stands now (a preview: install.mts records the inverse it actually applies)
  const base = baseScene(ctx, zone);
  const sceneFile = base.file;
  if (base.doc) {
    const reg = new ComponentRegistry();
    registerCoreComponents(reg);
    registerChunkComponents(reg);
    try {
      const res = applyOps(base.doc as never, ops, reg);
      writeJson(path.join(dir, "inverse.json"), res.inverse);
    } catch (e) {
      f.push({ level: "error", code: "ops", message: `the batch does not apply to ${path.basename(sceneFile)}: ${(e as Error).message}` });
    }
  }
  fs.writeFileSync(path.join(dir, "install.mts"), installer(ctx, zone));
  const mapFile = path.join(ctx.paths.zoneDir(zone), "reports", "populate-map.png");
  fs.mkdirSync(path.dirname(mapFile), { recursive: true });
  fs.writeFileSync(mapFile, out.png);
  const rel = (file: string): string => path.relative(ctx.paths.projectDir, file).replaceAll("\\", "/");
  const final = {
    ...report,
    ok: !f.some((x) => x.level === "error"),
    opsSha,
    files: { ops: rel(path.join(dir, "ops.json")), inverse: rel(path.join(dir, "inverse.json")), install: rel(path.join(dir, "install.mts")), map: rel(mapFile) },
    findings: f,
  };
  writeJson(ctx.paths.report("populate", zone), final);
  console.log(`wrote ${rel(path.join(dir, "ops.json"))} (${ops.length} ops), inverse.json, install.mts, ${rel(ctx.paths.report("populate", zone))}, ${rel(mapFile)}`);
  console.log(`install (coordinator): npx tsx ${path.relative(process.cwd(), path.join(dir, "install.mts")).replaceAll("\\", "/")} [--dry-run | --uninstall]`);
  return final.ok ? 0 : 1;
}

// ===================================================================================================== bodies + names

/**
 * How a template's body is chosen (owner ruling 2026-10-20: "a lot of capsules roaming around instead of actual
 * enemies"). A creature whose body EXISTS is never a capsule:
 *  1. its own prefab (`mobs/<id>-<theme>`, `mobs/<family>-<theme>`, a rare's `mobs/<rare id>`): ready;
 *  2. else the creature's catalogue `template` prefab, or any prefab of its themes: it stands in that BASE body (with
 *     its bestiary scale) and the missing paint is an ART row, not a placeholder;
 *  3. only a creature with no body prefab at all is a capsule (the one true placeholder).
 * Pure: the caller passes the prefab lookups.
 */
export function resolveBody(o: { own: string | null; template: string | null; anyTheme: string | null; artWhy: string }): { body: string; placeholder: boolean; art?: string; why: string } {
  if (o.own) return { body: o.own, placeholder: false, why: "ready body + theme" };
  const base = o.template ?? o.anyTheme;
  if (base) return { body: base, placeholder: false, art: o.artWhy, why: `base body ${base}; ${o.artWhy}` };
  return { body: "capsule", placeholder: true, why: `no body prefab at all (${o.artWhy})` };
}

/**
 * A human's dress for a theme. A theme whose outfit is not painted yet (needs-art) or names no declared outfit wears the
 * creature's first ready theme instead, as a stand-in outfit (an art row): the body exists, so it is never a capsule.
 */
export function humanDress(dress: (theme: string) => HumanDress | { error: string }, themes: readonly { id: string; status: string }[], theme: string): HumanDress | { error: string } {
  const row = themes.find((t) => t.id === theme);
  const first = row?.status === "ready" ? dress(theme) : { error: `theme '${theme}' ${row?.status ?? "missing"}` };
  if (!("error" in first)) return first;
  for (const t of themes) {
    if (t.id === theme || t.status !== "ready") continue;
    const d = dress(t.id);
    if (!("error" in d)) return { ...d, standIns: [`outfit ${theme} -> ${t.id} (${first.error})`, ...d.standIns] };
  }
  return first;
}

/** Weapon word in a human theme id -> the role noun its display name ends in ("oilskin-bearded-axe" -> Axeman). */
export const WEAPON_ROLE: Record<string, string> = {
  axe: "Axeman", greataxe: "Axeman", mace: "Maceman", club: "Clubman", sword: "Swordsman", greatsword: "Swordsman",
  bow: "Archer", crossbow: "Crossbowman", spear: "Spearman", staff: "Adept", dagger: "Cutthroat", hammer: "Hammerer", flail: "Flailman",
};
/** A one-word faction kin's role noun, from the template role ("Frogkin" + melee -> "Frogkin Warrior"). */
export const ROLE_NOUN: Record<Role, string> = {
  melee: "Warrior", ranged: "Hunter", caster: "Shaman", swarm: "Runt", brute: "Brute", skirmisher: "Raider", support: "Mystic", elite: "Champion", boss: "Chieftain",
};
const titleWord = (w: string): string => w.split("-").map((p) => (p ? p[0]!.toUpperCase() + p.slice(1).toLowerCase() : p)).join("-");
/** "giant sewer rat" -> "Giant Sewer Rat" (hyphenated parts too: "Salvage-Reeve"; "FrogKin" -> "Frogkin"). */
export const titleCase = (s: string): string => s.trim().split(/\s+/).filter(Boolean).map(titleWord).join(" ");

/**
 * A creature's display name in a theme, WoW-style "<Kin> <Role>" and the same in every zone (owner ruling 2026-10-20:
 * "Frogkin Warrior", not a unique name per spawn). The catalogue theme's own `name` wins; otherwise:
 *  - a human: "<Name> <weapon role>" when the name is one word ("Wrecker Axeman"), else the name ("Bandit Bowman");
 *  - a faction creature: a name of two words already says kin + role ("Ratkin Warrior"); a one-word kin gets the
 *    template role's noun ("Frogkin Warrior", "Ogre Brute");
 *  - wildlife: the theme words before the name, after a leading "Giant" ("Giant Sewer Rat", "Brinecoat Wolf");
 *    "base" and words already in the name add nothing. No levels in it: they live in the template id and `level`.
 */
export function displayName(c: { name: string; kind?: string; themes: readonly { id: string; name?: string }[] }, theme: string, human: boolean, role?: Role): string {
  const row = c.themes.find((t) => t.id === theme);
  if (row?.name) return row.name;
  const base = titleCase(c.name);
  const parts = base.split(" ");
  const words = theme.split("-").filter((w) => w && w !== "base");
  if (human) {
    const weapon = [...words].reverse().find((w) => WEAPON_ROLE[w]);
    return weapon && parts.length === 1 ? `${base} ${WEAPON_ROLE[weapon]}` : base;
  }
  if (c.kind === "faction" || c.kind === "unique") return parts.length === 1 && role && c.kind === "faction" ? `${base} ${ROLE_NOUN[role]}` : base;
  // a theme word the name already says, in any form ("pestilence" on a Pestilent Wolf, "ashen" on an Ash Wolf), adds nothing
  const said = (w: string): boolean => parts.some((p) => {
    const q = p.toLowerCase();
    return q.length >= 3 && (w.startsWith(q) || q.startsWith(w) || (q.length >= 6 && w.startsWith(q.slice(0, 6))));
  });
  const adj = titleCase(words.filter((w) => !said(w)).join(" "));
  if (!adj) return base;
  return parts[0] === "Giant" && parts.length > 1 ? ["Giant", adj, ...parts.slice(1)].join(" ") : `${adj} ${base}`;
}

/** A rare or named creature keeps its unique name plus a title: its own, the one in the name, or "the <kin>". */
export function namedTitle(name: string, kin: string, title?: string): string {
  if (title) return `${name}, ${title.replace(/^,\s*/, "")}`;
  if (/,|\bthe\b/i.test(name)) return name;
  return `${name}, the ${kin}`;
}

// ===================================================================================================== the planner

export function populate(ctx: Ctx, zone: string, plan: ZonePlan, f: Finding[]): { areas: Area[]; templates: Template[]; report: Record<string, unknown>; ops: Op[]; png: Buffer } | null {
  const p = ctx.paths;
  const zb = plan.zoneBestiary!;
  const cat = plan.bestiary as Bestiary;
  const creatures = new Map<string, Creature>(cat.creatures.map((c) => [c.id, c]));
  const num = (k: string, d: number): number => {
    const v = Number(ctx.opt(k, String(d)));
    return Number.isFinite(v) ? v : d;
  };
  const step = num("step", 16);
  const budget = num("budget", 20);
  const view = num("view", 150);
  const gap = num("gap", 100);
  const sep = num("sep", 70);
  const roadMargin = num("road-margin", 20);
  const sanctMargin = num("sanctuary-margin", 25);
  const maxSlope = num("max-slope", 0.57);
  const wade = num("wade", 0.5);
  const tierWidth = Math.max(1, Math.round(num("tier", 3)));
  const wakeRadius = num("radius", 60);
  const campShift = num("camp-shift", 80);

  const recipe = worldRecipeSchema.parse(readJson(p.recipe));
  const field = createWorldField(recipe);
  const region = recipe.regions.find((r) => r.id === zone && r.within === undefined);
  if (!region) {
    f.push({ level: "error", code: "no-region", message: `the recipe has no region ${zone}` });
    return null;
  }
  const townZones = recipe.regions.filter((r) => r.within === zone);
  const [lo, hi] = plan.brief.level;
  let starter = ctx.flag("starter");
  if (!starter && exists(p.cast)) {
    const cast = castSchema.safeParse(readJson(p.cast));
    starter = cast.success && cast.data.rows.some((r) => r.zone === zone && r.starter);
  }
  const familyOf = (id: string): string => creatures.get(id)?.family ?? id;
  // a starter zone's wildlife is never a bird or livestock (owner ruling 2026-10-22: ravens and horses read strange as
  // starter creatures): those stay at the places that declare them (site packs, a rare at its place)
  const wildlife = starter ? zb.wildlife.filter((w) => !WANDER_RULES.neverInStarter.includes(familyOf(w.creature))) : zb.wildlife;
  if (wildlife.length < zb.wildlife.length)
    f.push({ level: "warn", code: "starter-no-livestock", message: `starter zone: ${zb.wildlife.filter((w) => !wildlife.includes(w)).map((w) => w.creature).join(", ")} not placed as wildlife (birds and livestock never wander a starter zone)` });
  const wanderers = loadWanderers(ctx, zone, f);
  const hubTown = recipe.features.towns.find((t) => t.id === plan.brief.hub);
  const hub: [number, number] = hubTown ? [hubTown.center[0], hubTown.center[1]] : [region.hub[0], region.hub[1]];

  // ---- sanctuaries, exactly as serve() / quest-play publish them
  const sanct: SanctuaryCircle[] = sanctuariesFromPois(recipe.features.pois);
  for (const r of recipe.regions) {
    if (!r.tags.includes("safe")) continue;
    const [cx, cz] = r.hub ?? [0, 0];
    let rad = 0;
    for (const [x, z] of r.polygon) rad = Math.max(rad, Math.hypot(x - cx, z - cz));
    if (rad > 0) sanct.push([cx, cz, rad, 0]);
  }

  // ---- the grid
  const xs = region.polygon.map((q) => q[0]);
  const zs = region.polygon.map((q) => q[1]);
  const x0 = Math.min(...xs);
  const z0 = Math.min(...zs);
  const nx = Math.ceil((Math.max(...xs) - x0) / step);
  const nz = Math.ceil((Math.max(...zs) - z0) / step);
  const N = nx * nz;
  const cx = (i: number): number => x0 + ((i % nx) + 0.5) * step;
  const cz = (i: number): number => z0 + (Math.floor(i / nx) + 0.5) * step;
  const cellOf = (x: number, z: number): number => {
    const ix = Math.floor((x - x0) / step);
    const iz = Math.floor((z - z0) / step);
    return ix < 0 || iz < 0 || ix >= nx || iz >= nz ? -1 : iz * nx + ix;
  };
  const inZone = new Uint8Array(N); // 1 zone land, 2 town zone (walkable, never populated)
  const ground = new Float32Array(N);
  const slope = new Float32Array(N);
  const depth = new Float32Array(N);
  const reason = new Uint8Array(N);
  const edge = new Float32Array(N);
  const roadDist = new Float32Array(N).fill(Infinity);
  const sanctDist = new Float32Array(N).fill(Infinity);
  const habit = new Uint32Array(N);
  const biomeOf = new Uint8Array(N);
  const biomeIds = recipe.biomes.map((b) => b.id);
  const H = (h: Habitat): number => 1 << HABITATS.indexOf(h);
  const ruins = recipe.features.pois.filter((q) => /ruin|watchtower/.test(q.kind) && pointInPolygon(q.position[0], q.position[2], region.polygon));
  const towns = recipe.features.towns.filter((t) => pointInPolygon(t.center[0], t.center[1], region.polygon));

  for (let i = 0; i < N; i++) {
    const x = cx(i);
    const z = cz(i);
    if (!pointInPolygon(x, z, region.polygon)) {
      reason[i] = 1;
      continue;
    }
    inZone[i] = townZones.some((t) => pointInPolygon(x, z, t.polygon)) ? 2 : 1;
    const g = field.height(x, z);
    ground[i] = g;
    slope[i] = field.slope(x, z);
    const wy = field.waterY(x, z);
    let d = wy === null ? 0 : wy - g;
    if (g < recipe.seaLevel) d = Math.max(d, recipe.seaLevel - g);
    depth[i] = Math.max(0, d);
    edge[i] = polygonEdgeDistance(x, z, region.polygon);
    let sd = Infinity;
    for (const [sx, sz, sr] of sanct) sd = Math.min(sd, Math.hypot(x - sx, z - sz) - sr);
    sanctDist[i] = sd;
    const b = field.biome(x, z, g, slope[i]!).id;
    const bi = biomeIds.indexOf(b);
    biomeOf[i] = bi < 0 ? 255 : bi;
    let m = 0;
    for (const h of BIOME_HABITATS[b] ?? []) m |= H(h);
    if (g < recipe.seaLevel + 4) m |= H("coast");
    if (depth[i]! > 0.05 || b === "fen" || b === "swamp") m |= H("marsh");
    if (OPEN_BIOMES.has(b) && g < recipe.seaLevel + 40 && towns.some((t) => Math.hypot(x - t.center[0], z - t.center[1]) < 1000)) m |= H("farmland");
    if (sd < sanctMargin + 250) m |= H("town-outskirts");
    if (ruins.some((q) => Math.hypot(x - q.position[0], z - q.position[2]) < 80)) m |= H("ruin");
    habit[i] = m;
  }
  // roads: rasterise each segment's corridor
  for (const road of recipe.features.roads) {
    const half = road.width / 2;
    const reach = half + roadMargin + 80;
    for (let k = 1; k < road.points.length; k++) {
      const [ax, az] = road.points[k - 1]!;
      const [bx, bz] = road.points[k]!;
      const i0 = Math.max(0, Math.floor((Math.min(ax, bx) - reach - x0) / step));
      const i1 = Math.min(nx - 1, Math.floor((Math.max(ax, bx) + reach - x0) / step));
      const j0 = Math.max(0, Math.floor((Math.min(az, bz) - reach - z0) / step));
      const j1 = Math.min(nz - 1, Math.floor((Math.max(az, bz) + reach - z0) / step));
      const vx = bx - ax;
      const vz = bz - az;
      const l2 = vx * vx + vz * vz || 1;
      for (let j = j0; j <= j1; j++)
        for (let ii = i0; ii <= i1; ii++) {
          const c = j * nx + ii;
          const x = cx(c);
          const z = cz(c);
          const u = Math.max(0, Math.min(1, ((x - ax) * vx + (z - az) * vz) / l2));
          const dd = Math.hypot(x - (ax + vx * u), z - (az + vz * u)) - half;
          if (dd < roadDist[c]!) roadDist[c] = dd;
        }
    }
  }
  // reservations that are not wild places are their owners' ground
  const locKind = new Map(plan.graph.locations.map((l) => [l.id, l.kind]));
  const reserved = plan.reservations.reservations.filter((r) => locKind.get(r.location) !== "wild");
  for (let i = 0; i < N; i++) {
    if (reason[i]) continue;
    const x = cx(i);
    const z = cz(i);
    if (roadDist[i]! < roadMargin + 60) habit[i]! |= H("road");
    if (inZone[i] === 2 || sanctDist[i]! < sanctMargin) reason[i] = 2;
    else if (roadDist[i]! < roadMargin) reason[i] = 3;
    else if (depth[i]! > wade) reason[i] = 4;
    else if (slope[i]! > maxSlope) reason[i] = 5;
    else if (reserved.some((r) => Math.hypot(x - r.center[0], z - r.center[1]) < r.radius + 10)) reason[i] = 6;
  }

  // ---- walking distance from the hub (Dijkstra, 8-neighbour) -> level
  const dist = new Float32Array(N).fill(Infinity);
  {
    const heap: number[] = [];
    const push = (c: number): void => {
      heap.push(c);
      let k = heap.length - 1;
      while (k > 0) {
        const pk = (k - 1) >> 1;
        if (dist[heap[pk]!]! <= dist[heap[k]!]!) break;
        [heap[pk], heap[k]] = [heap[k]!, heap[pk]!];
        k = pk;
      }
    };
    const pop = (): number => {
      const top = heap[0]!;
      const last = heap.pop()!;
      if (heap.length) {
        heap[0] = last;
        let k = 0;
        for (;;) {
          const a = 2 * k + 1;
          const b = a + 1;
          let m = k;
          if (a < heap.length && dist[heap[a]!]! < dist[heap[m]!]!) m = a;
          if (b < heap.length && dist[heap[b]!]! < dist[heap[m]!]!) m = b;
          if (m === k) break;
          [heap[m], heap[k]] = [heap[k]!, heap[m]!];
          k = m;
        }
      }
      return top;
    };
    const cost = (c: number): number => (depth[c]! > 1.5 ? 10 : depth[c]! > wade ? 4 : 1) * (slope[c]! > 0.8 ? 12 : slope[c]! > maxSlope ? 4 : 1);
    let src = cellOf(hub[0], hub[1]);
    if (src < 0 || !inZone[src]) src = [...Array(N).keys()].filter((i) => inZone[i]).sort((a, b) => Math.hypot(cx(a) - hub[0], cz(a) - hub[1]) - Math.hypot(cx(b) - hub[0], cz(b) - hub[1]))[0] ?? -1;
    if (src >= 0) {
      dist[src] = 0;
      push(src);
      const done = new Uint8Array(N);
      while (heap.length) {
        const c = pop();
        if (done[c]) continue;
        done[c] = 1;
        const ix = c % nx;
        const iz = Math.floor(c / nx);
        for (let dz = -1; dz <= 1; dz++)
          for (let dx = -1; dx <= 1; dx++) {
            if (!dx && !dz) continue;
            const jx = ix + dx;
            const jz = iz + dz;
            if (jx < 0 || jz < 0 || jx >= nx || jz >= nz) continue;
            const n = jz * nx + jx;
            if (!inZone[n] || done[n]) continue;
            const nd = dist[c]! + step * Math.hypot(dx, dz) * (cost(c) + cost(n)) * 0.5;
            if (nd < dist[n]!) {
              dist[n] = nd;
              push(n);
            }
          }
      }
    }
  }
  for (let i = 0; i < N; i++) if (!reason[i] && !Number.isFinite(dist[i]!)) reason[i] = 7;
  const reachD = [...Array(N).keys()].filter((i) => !reason[i]).map((i) => dist[i]!).sort((a, b) => a - b);
  const d95 = reachD[Math.floor(reachD.length * 0.95)] ?? 1;
  const levelAt = (i: number): number => Math.round(lo + (hi - lo) * Math.min(1, (Number.isFinite(dist[i]!) ? dist[i]! : d95) / Math.max(1, d95)));

  // ---- clearance: metres from each cell to the nearest forbidden cell (two-pass chamfer)
  const clear = new Float32Array(N);
  for (let i = 0; i < N; i++) clear[i] = reason[i] ? 0 : 1e9;
  const D1 = step;
  const D2 = step * Math.SQRT2;
  for (let iz = 0; iz < nz; iz++)
    for (let ix = 0; ix < nx; ix++) {
      const c = iz * nx + ix;
      let v = clear[c]!;
      if (ix > 0) v = Math.min(v, clear[c - 1]! + D1);
      if (iz > 0) {
        v = Math.min(v, clear[c - nx]! + D1);
        if (ix > 0) v = Math.min(v, clear[c - nx - 1]! + D2);
        if (ix < nx - 1) v = Math.min(v, clear[c - nx + 1]! + D2);
      }
      clear[c] = v;
    }
  for (let iz = nz - 1; iz >= 0; iz--)
    for (let ix = nx - 1; ix >= 0; ix--) {
      const c = iz * nx + ix;
      let v = clear[c]!;
      if (ix < nx - 1) v = Math.min(v, clear[c + 1]! + D1);
      if (iz < nz - 1) {
        v = Math.min(v, clear[c + nx]! + D1);
        if (ix < nx - 1) v = Math.min(v, clear[c + nx + 1]! + D2);
        if (ix > 0) v = Math.min(v, clear[c + nx - 1]! + D2);
      }
      clear[c] = v;
    }
  // a cell is half a step from its own edge
  const clearAt = (i: number): number => (reason[i] ? 0 : clear[i]! - step / 2);

  // ---- templates
  const templates = new Map<string, Template>();
  const tiers: [number, number][] = [];
  for (let a = lo; a <= hi; a += tierWidth) tiers.push([a, Math.min(hi, a + tierWidth - 1)]);
  if (tiers.length > 1 && tiers.at(-1)![1] - tiers.at(-1)![0] < Math.ceil(tierWidth / 2)) tiers.splice(-2, 2, [tiers.at(-2)![0], hi]);
  // an item the plan sources from a creature drops from every template of that creature (60% a kill)
  const lootOf = new Map<string, string>();
  for (const it of plan.graph.items) if (it.source?.type === "creature") lootOf.set(it.source.ref, [lootOf.get(it.source.ref), it.id + ":1:0.6"].filter(Boolean).join(","));
  // prefabs resolve through the project's dependsOn closure (a world's mob bodies live in foundation)
  const prefabExists = (id: string): boolean => findAsset(p.projectDir, `prefabs/${id}.json`) !== null;
  const readyPrefab = (c: Creature, theme: string): string | null => {
    for (const id of [`mobs/${c.id}-${theme}`, `mobs/${c.family}-${theme}`, ...(theme === "base" || theme === "" ? [`mobs/${c.family}`] : [])]) if (prefabExists(id)) return id;
    return null;
  };
  const anyReadyPrefab = (c: Creature): string | null => {
    for (const t of c.themes) {
      const id = readyPrefab(c, t.id);
      if (id) return id;
    }
    return null;
  };
  // human families: dressed and armed from the declared pattern (none declared -> capsules, as before)
  const kit = loadHumanKit(p.projectDir, f);
  const templateFor = (creatureId: string, themeIn: string, role: Role, level: number, faction: string, rare?: { id: string; name: string; level: number; title?: string }, scaleIn = 1, nameAs?: string): Template | null => {
    const scale = Math.round(scaleIn * 100) / 100;
    const c = creatures.get(creatureId);
    if (!c) {
      f.push({ level: "error", code: "unknown-creature", message: `${creatureId} is not in the catalogue bestiary` });
      return null;
    }
    const theme = themeIn || c.themes[0]?.id || "base";
    const band: [number, number] = rare ? [rare.level, rare.level] : [Math.max(lo, c.level[0]), Math.min(hi, c.level[1])];
    if (band[0] > band[1]) band[1] = band[0]; // a creature whose band misses the zone's keeps its own floor
    const lv = Math.max(band[0], Math.min(band[1], level));
    const tier = rare ? band : (tiers.find((t) => lv >= t[0] && lv <= t[1]) ?? [lv, lv]);
    const levels: [number, number] = rare ? band : [Math.max(tier[0], band[0]), Math.min(tier[1], band[1])];
    // a wanderer row's own '<Kin> <Role>' name (Bandit Cutpurse) is its own template: the id says the name
    const slug = rare ? rare.id : nameAs ? nameSlug(nameAs) : `${c.id}${theme && theme !== "base" ? `-${theme}` : ""}`;
    // an oversized body is its own template (its own size, reach and gait)
    const id = `pop-${slug}${scale !== 1 ? `-x${scale}` : ""}-l${levels[0]}${levels[1] !== levels[0] ? `-${levels[1]}` : ""}`;
    const have = templates.get(id);
    if (have) return have;
    const themeRow = c.themes.find((t) => t.id === theme);
    // display name: "<Kin> <Role>" from the catalogue, the same in every zone; a rare keeps its own name + a title
    const human = c.family === "human" || !!kit?.families.has(c.family);
    const kin = displayName(c, themeRow ? theme : (c.themes[0]?.id ?? "base"), human, role);
    const name = rare ? namedTitle(rare.name, kin, rare.title) : (nameAs ?? displayName(c, theme, human, role));
    // a human's theme is an outfit set + a weapon item, not art on a mob page: a rare in one is dressed like its base
    if (kit && kit.families.has(c.family) && c.body.status === "ready") {
      const dress = humanDress((t) => dressFor(kit, t), c.themes, theme);
      if (!("error" in dress)) {
        // a stand-in weapon or outfit is an ART row: the dressed human body renders with it, never a capsule
        const t: Template = {
          id, creature: rare ? rare.id : c.id, family: c.family, theme, name,
          level: Math.round((levels[0] + levels[1]) / 2), levels, role, faction,
          placeholder: false,
          body: "human",
          why: dress.standIns.length ? `dressed human with stand-ins: ${dress.standIns.join("; ")}` : "dressed + armed human (declared pattern)",
          abilities: c.abilities.length ? c.abilities : ["strike"],
          dress,
        };
        if (dress.standIns.length) {
          t.standIns = [...dress.standIns];
          t.art = `stand-ins: ${dress.standIns.join("; ")}`;
        }
        t.loot = lootOf.get(t.creature) ?? lootOf.get(c.id) ?? "";
        if (scale !== 1) t.scale = scale;
        templates.set(id, t);
        return t;
      }
      f.push({ level: "warn", code: "human-undressed", message: `${id}: ${dress.error} (capsule placeholder)` });
    }
    // a rare or boss gets its OWN body when one exists: a prefab named for it, or its base family in its own theme
    // (mobs/hob-yarrow, mobs/ghost-reeve); otherwise it stands in the base creature's body (an art row)
    const ready = c.body.status === "ready";
    const own = !ready ? null : rare ? ([`mobs/${rare.id}`, `mobs/${c.id}-${theme}`, `mobs/${c.family}-${theme}`].find(prefabExists) ?? null) : themeRow?.status === "ready" ? readyPrefab(c, theme) : null;
    const artWhy = !ready
      ? `body ${c.body.status}`
      : rare
        ? `rare theme '${theme}' has no painted atlas on the ${c.family} body yet`
        : themeRow?.status !== "ready"
          ? `theme '${theme}' ${themeRow?.status ?? "missing"}`
          : `no prefab mobs/${c.id}-${theme} for the painted '${theme}' theme yet`;
    const catTemplate = ready && c.template && prefabExists(c.template) ? c.template : null;
    const body = resolveBody({ own, template: catTemplate, anyTheme: ready ? anyReadyPrefab(c) : null, artWhy });
    // a painted theme (atlas + its material) with no prefab of its own is worn by the base body: painted, not owed
    const atlasBase = themeRow?.status === "ready" && /.png$/i.test(themeRow.atlas) ? path.basename(themeRow.atlas, path.extname(themeRow.atlas)) : "";
    const paint = !own && body.body !== "capsule" && !rare && atlasBase && findAsset(p.projectDir, `materials/mobs/${atlasBase}.json`) ? `mobs/${atlasBase}` : "";
    if (paint) {
      delete body.art;
      body.why = `base body ${body.body} wearing the painted theme ${paint}`;
    }
    const t: Template = {
      id,
      creature: rare ? rare.id : c.id,
      family: c.family,
      theme,
      name,
      level: Math.round((levels[0] + levels[1]) / 2),
      levels,
      role,
      faction,
      placeholder: body.placeholder,
      body: body.body,
      why: body.why,
      ...(body.art ? { art: body.art } : {}),
      ...(paint ? { material: paint } : {}),
      abilities: c.abilities.length ? c.abilities : ["strike"],
    };
    t.loot = lootOf.get(t.creature) ?? lootOf.get(c.id) ?? "";
    if (scale !== 1) t.scale = scale;
    templates.set(id, t);
    return t;
  };

  // ---- placing
  const areas: Area[] = [];
  const legal = (i: number, spread: number, reach: number): boolean => i >= 0 && !reason[i] && clearAt(i) >= spread + 2 && edge[i]! >= reach;
  const farFromAll = (x: number, z: number, d: number): boolean => areas.every((a) => Math.hypot(a.x - x, a.z - z) >= d);
  const habitatsOf = (i: number): string[] => HABITATS.filter((h) => habit[i]! & H(h));
  const packCount = (role: Role, key: string, density: "sparse" | "common" | "dense" | "fill"): number => {
    const r = PACK[role];
    if (density === "sparse" || density === "fill") return r.min;
    if (density === "dense") return r.max;
    return r.min + Math.floor(hash01(key) * (r.max - r.min + 1));
  };
  let serial = 0;
  const addArea = (a0: Omit<Area, "id" | "y" | "radius" | "sleepRadius" | "idleSeconds"> & { id?: string; yAt?: number }): Area => {
    const { yAt, ...a } = a0;
    const i = cellOf(a.x, a.z);
    const area: Area = {
      ...a,
      id: a.id ?? `pop-${zone}-${String(++serial).padStart(3, "0")}`,
      y: yAt ?? r2(field.surfaceCast(a.x, a.z) ?? ground[i] ?? 0),
      radius: wakeRadius,
      sleepRadius: Math.round(wakeRadius * 1.5),
      idleSeconds: 10,
    };
    // one template id may serve two members (two roles of one body): one spawn entry each
    const merged: Spawn[] = [];
    for (const s of area.spawns) {
      const m = merged.find((x) => x.template === s.template);
      if (m) {
        m.count += s.count;
        m.spread = Math.max(m.spread, s.spread);
      } else merged.push({ ...s });
    }
    area.spawns = merged;
    areas.push(area);
    bump(area, area.spawns.reduce((n, s) => n + s.count, 0));
    if (!area.life) noteAlive(area);
    return area;
  };
  // animated creatures a player standing in each cell could see (all round, within `view`), kept as areas are added
  const stand = new Uint8Array(N);
  for (let i = 0; i < N; i++) stand[i] = inZone[i] && depth[i]! <= 1.2 ? 1 : 0;
  const seen = new Float32Array(N);
  const windowCells = (x: number, z: number, r: number, fn: (c: number) => boolean | void): boolean => {
    const i0 = Math.max(0, Math.floor((x - r - x0) / step));
    const i1 = Math.min(nx - 1, Math.floor((x + r - x0) / step));
    const j0 = Math.max(0, Math.floor((z - r - z0) / step));
    const j1 = Math.min(nz - 1, Math.floor((z + r - z0) / step));
    for (let j = j0; j <= j1; j++)
      for (let k = i0; k <= i1; k++) {
        const c = j * nx + k;
        if (stand[c] && Math.hypot(cx(c) - x, cz(c) - z) <= r && fn(c) === false) return false;
      }
    return true;
  };
  /** Alive creatures per grid cell (the view cap's measure, WANDER_RULES.viewCap): every area by its alive share. */
  const aliveCell = new Float32Array(N);
  function noteAlive(a: Area): void {
    const life = a.life as { placement?: string; patrol?: number[][] } | undefined;
    const n = a.life ? (a.alive ?? 0) : a.spawns.reduce((m, s) => m + s.count, 0);
    if (!n) return;
    if (life?.placement === "anywhere") {
      const cells: number[] = [];
      windowCells(a.x, a.z, a.radius, (c) => void cells.push(c));
      if (cells.length) { for (const c of cells) aliveCell[c] = aliveCell[c]! + n / cells.length; return; }
    }
    if (life?.placement === "route" && life.patrol?.length) {
      const pts = life.patrol.map((p) => cellOf(a.x + p[0]!, a.z + p[2]!)).filter((c) => c >= 0);
      if (pts.length) { for (const c of pts) aliveCell[c] = aliveCell[c]! + n / pts.length; return; }
    }
    const c = cellOf(a.x, a.z);
    if (c >= 0) aliveCell[c] = aliveCell[c]! + n;
  }
  /** Creatures alive inside the view circle round (x, z). */
  const aliveInView = (x: number, z: number): number => {
    let n = 0;
    windowCells(x, z, WANDER_RULES.viewRadius, (c) => void (n += aliveCell[c]!));
    return n;
  };
  function bump(a: Area, n: number): void {
    const sp = a.spawns.reduce((m, s) => Math.max(m, s.spread), 0);
    windowCells(a.x, a.z, view + sp + a.roam, (c) => void (seen[c] = seen[c]! + n));
  }
  /** Would a pack of n here push any standing point past the budget? (wildlife and fill respect it; planned groups do not) */
  const withinBudget = (x: number, z: number, n: number, reach: number): boolean => windowCells(x, z, view + reach, (c) => seen[c]! + n <= budget);
  const reachOf = (role: Role): number => PACK[role].spread + PACK[role].leash + PACK[role].roam + BORDER_BAND;
  const WEIGHT = { sparse: 1, common: 3, dense: 6 } as const;
  const wildlifeFor = (i: number): { creature: string; density: "sparse" | "common" | "dense" } | null => {
    const hs = habitatsOf(i);
    const fits = wildlife.filter((w) => w.habitats.some((h) => hs.includes(h)));
    if (!fits.length) return null;
    // weighted by density: where rats (common) and wolves (sparse) both fit, rats are three times as likely
    let roll = hash01(`${cx(i)}:${cz(i)}`) * fits.reduce((s, w) => s + WEIGHT[w.density], 0);
    for (const w of fits) if ((roll -= WEIGHT[w.density]) < 0) return w;
    return fits[0]!;
  };
  const wildArea = (kind: Area["kind"], i: number, creature: string, density: "sparse" | "common" | "dense" | "fill", extra: Partial<Area> = {}): Area | null => {
    const c = creatures.get(creature)!;
    const role = (c.roles[0] ?? "melee") as Role;
    const level = levelAt(i);
    const t = templateFor(creature, c.themes.find((th) => th.status === "ready")?.id ?? c.themes[0]?.id ?? "base", role, level, "wild");
    if (!t) return null;
    const pk = PACK[role];
    return addArea({
      kind, x: r2(cx(i)), z: r2(cz(i)), level: Math.max(t.levels[0], Math.min(t.levels[1], level)), creature, habitats: habitatsOf(i),
      leash: pk.leash, roam: pk.roam, spawns: [{ template: t.id, count: packCount(role, `${creature}:${i}`, density), spread: pk.spread }],
      // a starter zone's wildlife is mostly not hostile on sight (starterDisposition): wary wolves, neutral rats
      ...(starter ? (() => { const d = starterDisposition(c.family, `${creature}:${i}`); return { temperament: DISPOSITIONS[d], ...(d === "wary" ? { territory: WANDER_RULES.waryMetres } : {}) }; })() : {}),
      ...extra,
    });
  };

  // 1. the procedural camps already in the recipe are sites, reused (their entity is re-pointed, not duplicated)
  const campRows: { id: string; use: string }[] = [];
  const groupLocations = new Map<string, { location: string; center: [number, number]; radius: number }[]>();
  for (const l of plan.graph.locations) {
    if (!l.hostile) continue;
    const res = plan.reservations.reservations.find((r) => r.location === l.id);
    if (!res) continue;
    const list = groupLocations.get(l.hostile) ?? [];
    list.push({ location: l.id, center: [res.center[0], res.center[1]], radius: res.radius });
    groupLocations.set(l.hostile, list);
  }
  const groupAt = (x: number, z: number): { group: string; location: string } | null => {
    for (const [g, locs] of groupLocations) for (const l of locs) if (Math.hypot(x - l.center[0], z - l.center[1]) <= l.radius) return { group: g, location: l.location };
    return null;
  };
  // What a POI owner has BUILT at a reserved place (entities under a `poi-<id>` root in the scene): creatures keep
  // 7 m clear of every piece, so a pack never spawns inside a pen, a hut or a net ring. Yaw-only parent chains.
  const built: [number, number][] = [];
  {
    const sceneDoc = baseScene(ctx, zone).doc as { entities: Record<string, { parent?: string | null; components?: Record<string, unknown> }> } | null;
    const world = (id: string): [number, number, number, number] | null => {
      const e = sceneDoc?.entities[id];
      if (!e) return null;
      const t = (e.components?.["transform"] ?? {}) as { position?: number[]; rotation?: number[] };
      const p = t.position ?? [0, 0, 0];
      const q = t.rotation ?? [0, 0, 0, 1];
      const yaw = 2 * Math.atan2(q[1] ?? 0, q[3] ?? 1);
      if (!e.parent) return [p[0] ?? 0, p[1] ?? 0, p[2] ?? 0, yaw];
      const up = world(e.parent);
      if (!up) return null;
      const c = Math.cos(up[3]);
      const s = Math.sin(up[3]);
      return [up[0] + (p[0] ?? 0) * c + (p[2] ?? 0) * s, up[1] + (p[1] ?? 0), up[2] - (p[0] ?? 0) * s + (p[2] ?? 0) * c, up[3] + yaw];
    };
    const rootOf = (id: string): string => { let k = id; for (let n = 0; n < 12; n++) { const up = sceneDoc?.entities[k]?.parent; if (!up) break; k = up; } return k; };
    for (const id of Object.keys(sceneDoc?.entities ?? {})) {
      const root = rootOf(id);
      if (!root.startsWith("poi-") || id === root) continue;
      const w = world(id);
      if (w) built.push([w[0], w[2]]);
    }
  }
  const clearOfBuilt = (x: number, z: number): boolean => built.every(([bx, bz]) => Math.hypot(x - bx, z - bz) >= 7);
  const questLevel = new Map<string, number>();
  for (const q of plan.graph.quests)
    for (const o of q.objectives) if (o.at) questLevel.set(o.at, Math.min(questLevel.get(o.at) ?? Infinity, q.level));
  const zoneCamps = recipe.features.camps.filter((c) => c.zone === zone);
  const disabledCamps: string[] = [];
  const groupArea = (gid: string, location: string, i: number, extra: Partial<Area> = {}): Area | null => {
    const g = zb.groups.find((x) => x.id === gid);
    if (!g) return null;
    // a place a quest sends the player to is as hard as the EASIEST quest that acts there, not as hard as its distance
    // from town says (the first quest of the arc held a causeway of level 5 dead at level 2)
    const level = questLevel.get(location) ?? levelAt(i);
    const spawns: Spawn[] = [];
    let leash = 0;
    let roam = 0;
    for (const [k, m] of g.members.entries()) {
      const role = m.role as Role;
      const t = templateFor(m.creature, m.theme, role, level, g.faction || g.id, undefined, m.scale);
      if (!t) continue;
      const pk = PACK[role];
      // a group is a mixed pack: the first member at full role size, the rest at their minimum
      spawns.push({ template: t.id, count: k === 0 ? packCount(role, `${gid}:${location}:${i}`, "common") : pk.min, spread: Math.max(...g.members.map((mm) => PACK[mm.role as Role].spread)) });
      leash = Math.max(leash, pk.leash);
      roam = Math.max(roam, pk.roam);
    }
    if (!spawns.length) return null;
    return addArea({ kind: "group", x: r2(cx(i)), z: r2(cz(i)), level, creature: g.members[0]!.creature, group: gid, location, habitats: habitatsOf(i), leash, roam, spawns, ...extra });
  };
  for (const camp of zoneCamps) {
    const c0 = cellOf(camp.center[0], camp.center[1]);
    const why = c0 < 0 ? "outside the grid" : reason[c0] ? REASON[reason[c0]!] : clearAt(c0) < 8 ? `only ${Math.round(clearAt(c0))} m from ${nearestReason(c0)}` : edge[c0]! < reachOf("skirmisher") ? `${Math.round(edge[c0]!)} m from the zone border` : "";
    let i = c0;
    if (why) {
      // the site is kept: the camp moves to the nearest legal ground within campShift metres, else it is emptied
      let best = -1;
      if (c0 >= 0)
        windowCells(camp.center[0], camp.center[1], campShift, (c) => {
          if (legal(c, PACK.skirmisher.spread, reachOf("skirmisher")) && farFromAll(cx(c), cz(c), sep) && (best < 0 || Math.hypot(cx(c) - camp.center[0], cz(c) - camp.center[1]) < Math.hypot(cx(best) - camp.center[0], cz(best) - camp.center[1]))) best = c;
        });
      if (best < 0) {
        disabledCamps.push(camp.id);
        campRows.push({ id: camp.id, use: `DISABLED (spawns emptied): ${why}; no legal ground within ${campShift} m` });
        continue;
      }
      i = best;
    }
    const moved = i !== c0 ? `moved ${Math.round(Math.hypot(cx(i) - camp.center[0], cz(i) - camp.center[1]))} m off ${why}; ` : "";
    const held = groupAt(camp.center[0], camp.center[1]);
    let a: Area | null = null;
    if (held) a = groupArea(held.group, held.location, i, { id: camp.id, kind: "camp", camp: camp.id });
    else {
      const w = wildlifeFor(i);
      a = wildArea("camp", i, w?.creature ?? fillCreature(i), w?.density ?? "common", { id: camp.id, camp: camp.id });
    }
    if (a && moved) a.movedFrom = [camp.center[0], camp.center[1]];
    campRows.push({ id: camp.id, use: a ? `${moved}${held ? `group ${held.group}` : a.creature} (${habitatsOf(i).join("/") || "no habitat"})` : "no creature fits" });
  }
  function nearestReason(i: number): string {
    const ix = i % nx;
    const iz = Math.floor(i / nx);
    let best = "";
    let bd = Infinity;
    for (let dz = -6; dz <= 6; dz++)
      for (let dx = -6; dx <= 6; dx++) {
        const jx = ix + dx;
        const jz = iz + dz;
        if (jx < 0 || jz < 0 || jx >= nx || jz >= nz) continue;
        const r = reason[jz * nx + jx]!;
        if (r && Math.hypot(dx, dz) < bd) {
          bd = Math.hypot(dx, dz);
          best = REASON[r];
        }
      }
    return best || "forbidden ground";
  }
  function fillCreature(i: number): string {
    const w = wildlifeFor(i);
    if (w) return w.creature;
    // nothing lives in this habitat by the bestiary: the zone's most widespread wildlife fills it
    const ranked = [...wildlife].sort((a, b) => b.habitats.length - a.habitats.length || (a.density === "common" ? -1 : 1));
    return ranked[0]?.creature ?? zb.faction[0]!.creature;
  }

  // 2. each group at the places it holds, and nowhere else (relaxed out of the reservation's own exclusion)
  const groupRows: Record<string, { areas: number; creatures: number; locations: string[]; unplaced: string[] }> = {};
  for (const g of zb.groups) {
    const row = (groupRows[g.id] = { areas: 0, creatures: 0, locations: [], unplaced: [] } as { areas: number; creatures: number; locations: string[]; unplaced: string[] });
    const locs = groupLocations.get(g.id) ?? [];
    if (!locs.length) f.push({ level: "warn", code: "group-homeless", message: `group ${g.id} holds no reserved location (where: "${g.where}"): not placed` });
    for (const l of locs) {
      row.locations.push(l.location);
      const want = Math.max(1, Math.round((l.radius * l.radius) / (90 * 90)));
      const spreadMax = Math.max(...g.members.map((m) => PACK[m.role as Role].spread));
      const reach = Math.max(...g.members.map((m) => reachOf(m.role as Role)));
      // candidates inside the reservation that pass every rule except the reservation itself, nearest the centre first
      const cand: number[] = [];
      const ci = cellOf(l.center[0], l.center[1]);
      const rc = Math.ceil((l.radius * 1.5) / step);
      for (let dz = -rc; dz <= rc; dz++)
        for (let dx = -rc; dx <= rc; dx++) {
          if (ci < 0) break;
          const jx = (ci % nx) + dx;
          const jz = Math.floor(ci / nx) + dz;
          if (jx < 0 || jz < 0 || jx >= nx || jz >= nz) continue;
          cand.push(jz * nx + jx);
        }
      const dc = (i: number): number => Math.hypot(cx(i) - l.center[0], cz(i) - l.center[1]);
      cand.sort((a, b) => dc(a) - dc(b));
      // the reservation's own exclusion is lifted for its holder: recompute clearance against the other reasons only
      const ok = (i: number, within: number): boolean => {
        if (dc(i) > within) return false;
        // at its OWN place a group may stand near the road that runs through it (a roadside chapel, a camp): only the
        // road itself and 8 m either side stay clear
        const r = reason[i]!;
        if (r && r !== 6 && !(r === 3 && roadDist[i]! >= 8)) return false;
        if (edge[i]! < reach) return false;
        const k = Math.ceil((spreadMax + 2) / step);
        const ix = i % nx;
        const iz = Math.floor(i / nx);
        for (let dz = -k; dz <= k; dz++)
          for (let dx = -k; dx <= k; dx++) {
            const jx = ix + dx;
            const jz = iz + dz;
            if (jx < 0 || jz < 0 || jx >= nx || jz >= nz) return false;
            if (Math.hypot(dx, dz) * step > spreadMax + 2) continue;
            const rr = reason[jz * nx + jx]!;
            if (rr && rr !== 6 && !(rr === 3 && roadDist[jz * nx + jx]! >= 8)) return false;
          }
        return true;
      };
      let placed = 0;
      for (const within of [l.radius, l.radius * 1.5]) {
        for (const i of cand) {
          if (placed >= want) break;
          if (!ok(i, within) || !clearOfBuilt(cx(i), cz(i)) || !farFromAll(cx(i), cz(i), Math.min(sep, Math.max(40, l.radius)))) continue;
          const a = groupArea(g.id, l.location, i);
          if (!a) break;
          placed++;
        }
        if (placed) {
          if (within > l.radius) f.push({ level: "warn", code: "group-outside", message: `${g.id} at ${l.location}: no standable ground inside the ${l.radius} m reservation; placed within ${Math.round(within)} m` });
          break;
        }
      }
      if (!placed) {
        row.unplaced.push(l.location);
        f.push({ level: "warn", code: "group-unplaced", message: `${g.id} at ${l.location}: no dry, flat ground clear of roads and sanctuaries within ${Math.round(l.radius * 1.5)} m` });
      }
    }
  }

  // 3. rares: one each, at the location (or habitat) they haunt
  const named: NamedTemplate[] = []; // rares and site-pack leaders: each should sit behind placeholders (rareFindings)
  for (const rare of zb.rares) {
    const base = creatures.get(rare.base);
    if (!base) {
      f.push({ level: "warn", code: "rare-base", message: `rare ${rare.id}: base ${rare.base} not in the catalogue` });
      continue;
    }
    const role: Role = base.roles.includes("elite") ? "elite" : ((base.roles[0] ?? "melee") as Role);
    const res = plan.reservations.reservations.find((r) => r.location === rare.where);
    const hab = HABITATS.includes(rare.where as Habitat) ? H(rare.where as Habitat) : 0;
    const cand: number[] = [];
    for (let i = 0; i < N; i++) {
      if (!legal(i, PACK[role].spread, reachOf(role)) && !(res && reason[i] === 6 && clearAt(i) >= 0)) continue;
      if (res ? Math.hypot(cx(i) - res.center[0], cz(i) - res.center[1]) > res.radius * 2 : !(habit[i]! & hab)) continue;
      if (reason[i] && reason[i] !== 6) continue;
      if (edge[i]! < reachOf(role)) continue;
      cand.push(i);
    }
    // at a reserved place the rare stands INSIDE the reservation when any ground there allows it (the quest sends the
    // player to the place, and its owner builds round the spot); only a habitat rare is scattered by hash
    const dRes = (c: number): number => (res ? Math.hypot(cx(c) - res.center[0], cz(c) - res.center[1]) : 0);
    cand.sort((a, b) => (res ? Number(dRes(a) > res.radius) - Number(dRes(b) > res.radius) || hash01(`${rare.id}:${a}`) - hash01(`${rare.id}:${b}`) : hash01(`${rare.id}:${a}`) - hash01(`${rare.id}:${b}`)));
    const i = cand.find((c) => clearOfBuilt(cx(c), cz(c)) && farFromAll(cx(c), cz(c), res && dRes(c) <= res.radius ? 15 : 25));
    if (i === undefined) {
      f.push({ level: "warn", code: "rare-unplaced", message: `rare ${rare.id}: no ground at "${rare.where}"` });
      continue;
    }
    // a rare belongs to whoever holds its place (Ned Cotter is a Cotter wrecker, not wildlife): same faction, so the
    // pack does not turn on its own leader
    const holder = zb.groups.find((g) => (groupLocations.get(g.id) ?? []).some((l) => l.location === rare.where));
    const t = templateFor(rare.base, rare.theme, role, rare.level, holder ? holder.faction || holder.id : "wild", { id: rare.id, name: rare.name, level: rare.level, title: rare.title }, rare.scale);
    if (!t) continue;
    named.push({ template: t.id, name: rare.name, kind: "rare" });
    addArea({ kind: "rare", x: r2(cx(i)), z: r2(cz(i)), level: rare.level, creature: rare.id, location: res ? rare.where : undefined, habitats: habitatsOf(i), leash: PACK.elite.leash, roam: PACK.elite.roam, spawns: [{ template: t.id, count: 1, spread: 2 }] });
  }

  // 3b. site packs: the clearings handed over by the owners of sites outside the quest plan, filled as written
  const siteRows: Record<string, { areas: number; creatures: number; named: string[] }> = {};
  if (exists(sitePacksFile(ctx, zone))) {
    for (const sp of (readJson(sitePacksFile(ctx, zone)) as { packs: SitePack[] }).packs) {
      const near = areas.find((a) => Math.hypot(a.x - sp.at[0], a.z - sp.at[1]) < 12 && Math.abs(a.y - (sp.y ?? a.y)) < 6);
      if (near) {
        f.push({ level: "warn", code: "site-pack-crowded", message: `site pack ${sp.id}: ${near.id} already stands ${Math.round(Math.hypot(near.x - sp.at[0], near.z - sp.at[1]))} m away; not placed` });
        continue;
      }
      const i = cellOf(sp.at[0], sp.at[1]);
      const spawns: Spawn[] = [];
      let leash = 0;
      let roam = 0;
      for (const m of sp.members) {
        const t = templateFor(m.creature, m.theme ?? "", m.role, sp.level, sp.faction, undefined, m.scale);
        if (!t) continue;
        const pk = PACK[m.role];
        // a pack in a clearing of 8 m (or a cave chamber) keeps to it: half the open-ground spread
        spawns.push({ template: t.id, count: m.count, spread: Math.min(pk.spread, 5) });
        leash = Math.max(leash, pk.leash);
        roam = Math.max(roam, sp.y !== undefined ? Math.min(pk.roam, 4) : pk.roam);
      }
      const row = (siteRows[sp.site] ??= { areas: 0, creatures: 0, named: [] });
      if (sp.named) {
        const base = creatures.get(sp.named.base);
        const t = base ? templateFor(sp.named.base, sp.named.theme ?? "", "elite", sp.named.level, sp.faction, { id: sp.named.id, name: sp.named.name, level: sp.named.level, title: sp.named.title }, sp.named.scale) : null;
        if (t) {
          named.push({ template: t.id, name: sp.named.name, kind: "named" });
          spawns.push({ template: t.id, count: 1, spread: 2 });
          row.named.push(sp.named.name);
        } else f.push({ level: "warn", code: "site-pack-named", message: `site pack ${sp.id}: named base ${sp.named.base} not in the catalogue` });
      }
      if (!spawns.length) continue;
      const a = addArea({ id: `pop-${zone}-site-${sp.id}`, kind: sp.members.length ? "group" : "rare", x: sp.at[0], z: sp.at[1], yAt: sp.y, level: sp.level, creature: sp.members[0]?.creature ?? sp.named!.id, location: sp.site, habitats: i >= 0 ? habitatsOf(i) : [], leash: leash || PACK.elite.leash, roam, spawns });
      row.areas += 1;
      row.creatures += a.spawns.reduce((n, x) => n + x.count, 0);
    }
    for (const [site, row] of Object.entries(siteRows)) console.log(`  site ${site.padEnd(24)} ${row.areas} areas, ${row.creatures} creatures${row.named.length ? `; named: ${row.named.join(", ")}` : ""}`);
  }

  // 3c. wanderers: packs walking roads and loops, roamers round places (zones/<z>/wanderers.json), placed before the
  // wildlife so they claim their ground first
  const wanderTemplates = new Map<string, string>(); // template id -> the wanderer area it stands at (the server holds it back)
  const wanderRows: Record<string, { placement: string; alive: number; routeM?: number; radius?: number; templates: string[]; rares: string[] }> = {};
  f.push(...wandererFindings(wanderers, familyOf, starter));
  function anchorOf(a: { near?: string; at?: [number, number] } | undefined, id: string): [number, number] | null {
    if (a?.at) return a.at;
    const res = a?.near ? plan.reservations.reservations.find((r) => r.location === a.near) : undefined;
    if (res) return [res.center[0], res.center[1]];
    f.push({ level: "error", code: "wanderer-anchor", message: `${id}: no place ${a?.near ?? "(none given)"} in the reservations` });
    return null;
  }
  /** Open ground a creature may walk: not a town or sanctuary, not deep water or a cliff, inside the zone with `reach` to spare. */
  function walkOk(x: number, z: number, reach: number): boolean {
    const i = cellOf(x, z);
    if (i < 0 || inZone[i] !== 1 || sanctDist[i]! < sanctMargin) return false;
    return depth[i]! <= wade && slope[i]! <= maxSlope && edge[i]! >= reach;
  }
  function placeWanderer(w: WandererArea & { solo?: boolean }): (typeof wanderRows)[string] | null {
    const leash = 30;
    const reach = leash + BORDER_BAND;
    let pts: Array<[number, number]> = [];
    let loop = false;
    if (w.placement === "route") {
      const r = w.route;
      if (r?.road?.length) {
        const line: Array<[number, number]> = [];
        for (const id of r.road) {
          const road = recipe.features.roads.find((x) => x.id === id);
          if (!road) {
            f.push({ level: "error", code: "wanderer-road", message: `${w.id}: no road ${id} in the recipe` });
            return null;
          }
          for (const q of road.points) line.push([q[0]!, q[1]!]);
        }
        pts = longestRun(offsetLine(resample(line, 25), r.offset), ([x, z]) => walkOk(x, z, reach) || (() => {
          // the road bed itself is walkable even where the grid calls it steep (a cut through a bank)
          const i = cellOf(x, z);
          return i >= 0 && inZone[i] === 1 && roadDist[i]! < 4 && sanctDist[i]! >= sanctMargin && edge[i]! >= reach && depth[i]! <= wade;
        })());
      } else if (r?.loop) {
        const c = anchorOf({ near: r.loop.near, at: r.loop.at }, w.id);
        if (!c) return null;
        const n = Math.max(8, Math.round((2 * Math.PI * r.loop.radius) / 45));
        for (let k = 0; k < n; k++) {
          const a = (k / n) * Math.PI * 2;
          // bend each point onto walkable ground along its spoke, nearest the circle first
          for (const s of [1, 0.9, 1.1, 0.8, 1.2, 0.7, 1.3, 0.6, 0.5]) {
            const x = c[0] + Math.cos(a) * r.loop.radius * s;
            const z = c[1] + Math.sin(a) * r.loop.radius * s;
            if (walkOk(x, z, reach)) {
              pts.push([x, z]);
              break;
            }
          }
        }
        loop = true;
      } else if (r?.points?.length) {
        pts = r.points.map((q) => [q[0], q[1]]);
        loop = r.closed;
      }
      if (pts.length < (loop ? 4 : 2) || routeLength(pts) < 120) {
        f.push({ level: "error", code: "wanderer-route", message: `${w.id}: route has ${pts.length} walkable point(s), ${Math.round(routeLength(pts))} m (needs 120 m+)` });
        return null;
      }
      if (!loop) pts = resample(pts, 40);
    } else {
      const c = anchorOf(w.at, w.id);
      if (!c) return null;
      // the disc stays off the towns (sanctuary + margin) and inside the zone with its roamers' reach to spare
      let r = w.radius;
      for (const [sx, sz, sr] of sanct) r = Math.min(r, Math.hypot(c[0] - sx, c[1] - sz) - sr - sanctMargin);
      // a solo walks 8-20 m from where it rose: its disc needs less border band than a ranging roamer
      r = Math.min(r, polygonEdgeDistance(c[0], c[1], region!.polygon) - (w.solo ? 40 : 80) - BORDER_BAND);
      if (r < 40) {
        f.push({ level: "error", code: "wanderer-disc", message: `${w.id}: only ${Math.round(r)} m of room round ${w.at?.near ?? w.at?.at} (a town or the zone border is too close)` });
        return null;
      }
      pts = [c];
      w = { ...w, radius: Math.round(r) };
    }
    // origin: the route's middle point (or the disc's centre); level by walking distance there unless given
    const mid = pts[Math.floor(pts.length / 2)]!;
    const oi = cellOf(mid[0], mid[1]);
    if (oi < 0) return null;
    const level = w.level ?? levelAt(oi);
    const faction = (cid: string): string => {
      const c = creatures.get(cid);
      return !c || c.kind === "wildlife" ? "wild" : c.family === "human" ? "bandits" : c.family;
    };
    const tplOf = (m: { creature: string; theme: string; name?: string; role?: string }, lv = level): string | null => {
      const c = creatures.get(m.creature);
      if (!c) {
        f.push({ level: "error", code: "unknown-creature", message: `${w.id}: ${m.creature} is not in the catalogue bestiary` });
        return null;
      }
      const t = templateFor(m.creature, m.theme, (m.role ?? c.roles[0] ?? "melee") as Role, lv, faction(m.creature), undefined, 1, m.name);
      if (!t) return null;
      if (!wanderTemplates.has(t.id)) wanderTemplates.set(t.id, `pop-${zone}-wander-${w.id}`);
      return t.id;
    };
    const mix: Array<Record<string, unknown>> = [];
    for (const m of w.mix) {
      const dispFirst = m.disposition ?? w.disposition ?? (m.temperament || w.temperament ? undefined : starter ? starterDisposition(familyOf(m.creature), `${w.id}:${m.creature}`) : undefined);
      // fodder (passive) stands 1-3 levels under where it lives; aggressive kinds at level; rares above (their own level)
      const t = tplOf(m, dispFirst && DISPOSITIONS[dispFirst] === "passive" ? fodderLevel(level, `${w.id}:${m.creature}:${m.theme}`) : level);
      if (!t) continue;
      const withT = m.with.map(tplOf).filter((x): x is string => !!x);
      // disposition: the row's, else the area's, else (starter zone) the family default; wary = territorial within waryMetres
      const disp = m.disposition ?? w.disposition ?? (m.temperament || w.temperament ? undefined : starter ? starterDisposition(familyOf(m.creature), `${w.id}:${m.creature}`) : undefined);
      const temper = disp ? DISPOSITIONS[disp] : m.temperament;
      mix.push({ template: t, weight: m.weight, count: m.count, ...(temper ? { temperament: temper } : {}), near: w.placement === "route" ? 3 : 4, ...(withT.length ? { with: withT } : {}) });
    }
    const rares: Array<Record<string, unknown>> = [];
    for (const r of w.rares) {
      if (!creatures.get(r.creature)) continue;
      const t = templateFor(r.creature, r.theme, (r.role ?? "elite") as Role, r.level, faction(r.creature), { id: r.id, name: r.name, level: r.level, title: r.title }, r.scale);
      if (!t) continue;
      if (!wanderTemplates.has(t.id)) wanderTemplates.set(t.id, `pop-${zone}-wander-${w.id}`);
      named.push({ template: t.id, name: r.name, kind: "rare" });
      rares.push({ template: t.id, chance: r.chance, lockout: r.lockout, id: r.id, temperament: "hostile" });
    }
    if (!mix.length) return null;
    const y = r2(field.surfaceCast(mid[0], mid[1]) ?? ground[oi] ?? 0);
    const far = Math.max(...pts.map(([x, z]) => Math.hypot(x - mid[0], z - mid[1])));
    const patrol = w.placement === "route" ? pts.map(([x, z]) => [r2(x - mid[0]), r2((field.surfaceCast(x, z) ?? field.height(x, z)) - y), r2(z - mid[1])]) : [];
    const life: Record<string, unknown> = {
      placement: w.placement,
      mix,
      population: w.population,
      respawn: w.solo ? [60, 120] : [90, 180],
      hiddenFrom: w.solo ? 45 : 60,
      // a solo walks its own short wander loop round where it rose; a roamer ranges wider
      ...(w.placement === "route" ? { patrol, ...(loop ? { loop: true } : {}) } : { roamRange: w.solo ? [8, 20] : [25, 60] }),
      territory: WANDER_RULES.waryMetres,
      ...(w.hours ? { hours: w.hours } : {}),
      ...(w.disposition ? { temperament: DISPOSITIONS[w.disposition] } : w.temperament ? { temperament: w.temperament } : {}),
      ...(rares.length ? { rares } : {}),
    };
    const a = addArea({
      id: `pop-${zone}-wander-${w.id}`, kind: "wanderer", x: r2(mid[0]), z: r2(mid[1]), yAt: y, level, creature: w.mix[0]!.creature,
      habitats: habitatsOf(oi), leash, roam: w.placement === "route" ? 6 : 10, spawns: [], life, alive: w.population ?? 1,
    });
    // a route wakes while a player is anywhere near it (its furthest point + 80 m); an `anywhere` disc's radius IS where it
    // spawns, so it stays the disc (the server places the creatures out of sight before a player reaches it)
    a.radius = Math.round(w.placement === "route" ? far + 80 : w.radius);
    a.sleepRadius = a.radius + 60;
    bump(a, w.population ?? 1);
    noteAlive(a);
    return { placement: w.placement, alive: w.population ?? 1, ...(w.placement === "route" ? { routeM: Math.round(routeLength(loop ? [...pts, pts[0]!] : pts)) } : { radius: w.radius }), templates: [...new Set(mix.flatMap((m) => [m.template as string, ...((m.with as string[] | undefined) ?? [])]))], rares: w.rares.map((r) => (r.title ? `${r.name}, ${r.title}` : r.name)) };
  }
  /** Open land (km²) a disc of radius r round c holds: zone land, dry, walkable, off the sanctuaries. */
  const discLandKm2 = (c: [number, number], r: number): number => {
    let n = 0;
    windowCells(c[0], c[1], r, (k) => void (inZone[k] === 1 && depth[k]! <= wade && slope[k]! <= maxSlope && sanctDist[k]! >= sanctMargin && n++));
    return (n * step * step) / 1e6;
  };
  const soloDiscs: Array<[number, number, number]> = []; // always-out solo discs: x, z, r (they never overlap)
  const order = [...(wanderers?.areas ?? [])].sort((a, b) => (a.placement === "solo" ? (a.tile ? 2 : 1) : 0) - (b.placement === "solo" ? (b.tile ? 2 : 1) : 0));
  for (const w of order) {
    if (w.placement !== "solo") {
      const row = placeWanderer(w);
      if (row) wanderRows[w.id] = row;
      continue;
    }
    const centres: Array<[number, number]> = [];
    for (const pl of w.places ?? []) {
      const c = anchorOf({ near: pl }, w.id);
      if (c) centres.push(c);
    }
    if (w.tile) {
      // a hex-ish grid over the zone, every centre on open land with the disc's reach to spare
      const s = w.radius * 2; // touching, never overlapping
      for (let z = z0 + s / 2, row = 0; z < z0 + nz * step; z += s * 0.87, row++)
        for (let x = x0 + (row % 2 ? s / 2 : 0); x < x0 + nx * step; x += s) if (walkOk(x, z, 60) && !centres.some((c) => Math.hypot(c[0] - x, c[1] - z) < w.radius)) centres.push([x, z]);
    }
    let alive = 0;
    let discs = 0;
    const templatesSeen = new Set<string>();
    for (const [k, c] of centres.entries()) {
      let r = w.radius;
      for (const [sx, sz, sr] of sanct) r = Math.min(r, Math.hypot(c[0] - sx, c[1] - sz) - sr - sanctMargin);
      r = Math.min(r, polygonEdgeDistance(c[0], c[1], region!.polygon) - 40 - BORDER_BAND);
      if (r < 50) continue;
      // an always-out disc never overlaps another (a time-gated extra may sit on its place's day disc)
      if (!w.hours) {
        if (soloDiscs.some(([dx, dz, dr]) => Math.hypot(dx - c[0], dz - c[1]) < dr + r - 1)) {
          const room = Math.min(...soloDiscs.map(([dx, dz, dr]) => Math.hypot(dx - c[0], dz - c[1]) - dr));
          if (room < 50) continue;
          r = Math.min(r, room);
        }
      }
      let pop = w.population ?? Math.round((w.perKm2 ?? 0) * discLandKm2(c, r));
      // the view cap: what already stands within view of any point this disc's creatures can be seen from, plus this
      // disc's whole population, stays under WANDER_RULES.viewCap (so discs thin out where places' own packs stand)
      // per viewing point q: what stands in view of q now, plus this disc's population times the share of its land q sees
      const own: number[] = [];
      windowCells(c[0], c[1], r, (k) => void own.push(k));
      let fit = Infinity;
      windowCells(c[0], c[1], r + WANDER_RULES.viewRadius, (q) => {
        const seen = own.length ? own.filter((k) => Math.hypot(cx(k) - cx(q), cz(k) - cz(q)) <= WANDER_RULES.viewRadius).length / own.length : 1;
        if (seen > 0) fit = Math.min(fit, (WANDER_RULES.viewCap - aliveInView(cx(q), cz(q))) / seen);
      });
      pop = Math.min(pop, Math.floor(fit));
      if (pop < 1) continue;
      // night extras are staggered: each disc comes out an hour after the one before (19:00, 20:00, 21:00)
      const hours = w.hours ? ([(w.hours[0] + (k % 3)) % 24, w.hours[1]] as [number, number]) : undefined;
      const sub = placeWanderer({ ...w, id: `${w.id}-${String(k + 1).padStart(2, "0")}`, placement: "anywhere", at: { at: c }, radius: Math.round(r), population: pop, ...(hours ? { hours } : {}), mix: w.mix.map((m) => ({ ...m, count: [1, 1] as [number, number], with: [] })), solo: true } as never);
      if (sub && !w.hours) soloDiscs.push([c[0], c[1], r]);
      if (!sub) continue;
      alive += sub.alive;
      discs++;
      for (const t of sub.templates) templatesSeen.add(t);
    }
    if (!discs) f.push({ level: "error", code: "wanderer-solo", message: `${w.id}: no disc found room (places ${(w.places ?? []).join(", ") || "-"}${w.tile ? ", tiled" : ""})` });
    wanderRows[w.id] = { placement: `solo x${discs}`, alive, radius: w.radius, templates: [...templatesSeen], rares: w.rares.map((r) => (r.title ? `${r.name}, ${r.title}` : r.name)) };
  }

  // 4. wildlife at its density, in its habitats
  const habitatKm2: Record<string, number> = {};
  for (const w of wildlife) {
    const c = creatures.get(w.creature);
    if (!c) continue;
    const role = (c.roles[0] ?? "melee") as Role;
    const mask = w.habitats.reduce((m, h) => m | H(h as Habitat), 0);
    const cand: number[] = [];
    let cells = 0;
    for (let i = 0; i < N; i++) {
      if (reason[i] || !(habit[i]! & mask)) continue;
      cells++;
      if (legal(i, PACK[role].spread, reachOf(role))) cand.push(i);
    }
    const km2 = (cells * step * step) / 1e6;
    habitatKm2[w.creature] = r2(km2);
    const target = Math.round(km2 * DENSITY[w.density]);
    const own = Math.max(sep, 500 / Math.sqrt(DENSITY[w.density]));
    cand.sort((a, b) => hash01(`${w.creature}:${a}`) - hash01(`${w.creature}:${b}`));
    let have = areas.filter((a) => a.creature === w.creature).length;
    for (const i of cand) {
      if (have >= target) break;
      const x = cx(i);
      const z = cz(i);
      if (!farFromAll(x, z, sep) || areas.some((a) => a.creature === w.creature && Math.hypot(a.x - x, a.z - z) < own)) continue;
      if (!withinBudget(x, z, PACK[role].max, PACK[role].spread + PACK[role].roam)) continue;
      if (wildArea("wildlife", i, w.creature, w.density)) have++;
    }
    if (have < target) f.push({ level: "warn", code: "density-short", message: `${w.creature}: ${have} of ${target} areas fit in ${r2(km2)} km² of ${w.habitats.join("/")}` });
  }

  // 5. standard-fare fill: no stretch of walkable wilderness more than ~2 x gap across without a pack
  const wild = [...Array(N).keys()].filter((i) => !reason[i]);
  const near = new Float32Array(N).fill(Infinity);
  const touch = (a: Area): void => {
    for (const i of wild) {
      const d = Math.hypot(cx(i) - a.x, cz(i) - a.z);
      if (d < near[i]!) near[i] = d;
    }
  };
  for (const a of areas) touch(a);
  let fills = 0;
  let budgetSkips = 0;
  const refused = new Uint8Array(N);
  for (let guard = 0; guard < 4000; guard++) {
    let best = -1;
    for (const i of wild) if (!refused[i] && near[i]! > gap && legal(i, PACK.swarm.spread, reachOf("skirmisher")) && (best < 0 || near[i]! > near[best]!)) best = i;
    if (best < 0) break;
    const creature = fillCreature(best);
    const role = (creatures.get(creature)?.roles[0] ?? "melee") as Role;
    if (!withinBudget(cx(best), cz(best), PACK[role].min, PACK[role].spread + PACK[role].roam)) {
      refused[best] = 1;
      budgetSkips++;
      continue;
    }
    const a = wildArea("fill", best, creature, "fill");
    if (!a) break;
    touch(a);
    fills++;
  }
  // wilderness no legal area could ever cover (a strip between a road and the border, say) is not a fill failure
  const host = new Uint8Array(N);
  for (const i of wild) if (legal(i, PACK.swarm.spread, reachOf("skirmisher"))) host[i] = 1;
  let coverable = 0;
  for (const i of wild) if (!windowCells(cx(i), cz(i), gap, (c) => !host[c])) coverable++;
  let largest = 0;
  let covered = 0;
  for (const i of wild) {
    largest = Math.max(largest, near[i]!);
    if (near[i]! <= gap) covered++;
  }

  // ---- templates stand somewhere: NpcManager adopts every npc-tagged scene subtree as a template AND a live NPC, so
  // each one stands in the first area that spawns it, as one of that pack (its count drops by one)
  for (const t of templates.values()) {
    const a = areas.find((x) => x.spawns.some((s) => s.template === t.id));
    if (!a) continue;
    t.standsAt = a.id;
    const s = a.spawns.find((x) => x.template === t.id)!;
    s.count -= 1;
    if (s.count <= 0) a.spawns = a.spawns.filter((x) => x !== s);
  }
  for (const [tid, aid] of wanderTemplates) {
    const t = templates.get(tid);
    if (t && !t.standsAt) t.standsAt = aid;
  }
  const used = [...templates.values()].filter((t) => t.standsAt);

  // ---- alive in view (the cap's measure): the worst circle of WANDER_RULES.viewRadius over every standing point
  let aliveWorst = { count: 0, at: [0, 0] as number[] };
  for (let i = 0; i < N; i++) {
    if (!stand[i]) continue;
    const n = aliveInView(cx(i), cz(i));
    if (n > aliveWorst.count) aliveWorst = { count: Math.round(n * 10) / 10, at: [Math.round(cx(i)), Math.round(cz(i))] };
  }
  if (aliveWorst.count > WANDER_RULES.viewCap)
    f.push({ level: "warn", code: "alive-in-view", message: `${aliveWorst.count} creatures alive within ${WANDER_RULES.viewRadius} m of [${aliveWorst.at.join(", ")}] (cap ${WANDER_RULES.viewCap}; the wanderers row fails)` });
  console.log(`  alive in view: worst ${aliveWorst.count} within ${WANDER_RULES.viewRadius} m at [${aliveWorst.at.join(", ")}] (cap ${WANDER_RULES.viewCap})`);

  // ---- numbers
  // a wanderer's creatures are its population (its templates are held back by the server, never standing extra)
  const countOf = (a: Area): number => (a.life ? (a.alive ?? 0) : a.spawns.reduce((n, s) => n + s.count, 0) + used.filter((t) => t.standsAt === a.id).length);
  const wildKm2 = (wild.length * step * step) / 1e6;
  const total = areas.reduce((n, a) => n + countOf(a), 0);
  const byCreature: Record<string, { areas: number; creatures: number; perKm2: number; placeholder: boolean; templates: string[] }> = {};
  for (const a of areas)
    for (const s of a.spawns.length ? a.spawns : [{ template: "", count: 0, spread: 0 }]) {
      const t = templates.get(s.template);
      const key = t?.creature ?? a.creature;
      const row = (byCreature[key] ??= { areas: 0, creatures: 0, perKm2: 0, placeholder: !!t?.placeholder, templates: [] });
      row.areas += 1;
      row.creatures += s.count;
      if (t && !row.templates.includes(t.id)) row.templates.push(t.id);
    }
  for (const t of used) {
    const row = (byCreature[t.creature] ??= { areas: 1, creatures: 0, perKm2: 0, placeholder: t.placeholder, templates: [] });
    row.creatures += 1;
    if (!row.templates.includes(t.id)) row.templates.push(t.id);
  }
  // a row is a placeholder when any template it shows is (a rare's area spawns nothing but its standing template)
  for (const row of Object.values(byCreature)) {
    row.perKm2 = r2(row.creatures / Math.max(0.01, wildKm2));
    row.placeholder = row.templates.some((id) => templates.get(id)?.placeholder);
  }
  for (const a of areas) if (a.group && groupRows[a.group]) {
    groupRows[a.group]!.areas += 1;
    groupRows[a.group]!.creatures += countOf(a);
  }

  // worst case in view: every area within `view` (+ its scatter and roam) of a standing point is assumed awake and
  // fully alive — all directions, no occlusion — the upper bound a player turning on the spot could face
  let worst = 0;
  let worstAt = [0, 0];
  const views: number[] = [];
  let over = 0;
  for (let i = 0; i < N; i++) {
    if (!inZone[i] || depth[i]! > 1.2) continue;
    const x = cx(i);
    const z = cz(i);
    let n = 0;
    for (const a of areas) {
      const sp = a.spawns.reduce((m, s) => Math.max(m, s.spread), 0);
      if (Math.hypot(a.x - x, a.z - z) <= view + sp + a.roam) n += countOf(a);
    }
    views.push(n);
    if (n > budget) over++;
    if (n > worst) {
      worst = n;
      worstAt = [Math.round(x), Math.round(z)];
    }
  }
  views.sort((a, b) => a - b);
  const p95 = views[Math.floor(views.length * 0.95)] ?? 0;
  if (worst > budget)
    f.push({ level: "warn", code: "view-budget", message: `up to ${worst} animated creatures within ${view} m of [${worstAt.join(", ")}] (budget ${budget}); ${Math.round((over / Math.max(1, views.length)) * 100)}% of standing points exceed it` });
  const placeholders = used.filter((t) => t.placeholder);
  for (const t of placeholders) f.push({ level: "warn", code: "capsule", message: `${t.id} (${t.name}) is a CAPSULE: ${t.why}` });
  // an art row: the body renders (base theme, or a dressed human with a stand-in), the paint / item is still owed
  const artRows = used.filter((t) => t.art);
  for (const t of artRows) f.push({ level: "warn", code: "art", message: `${t.id} (${t.name}) renders ${t.body}; art owed: ${t.art}` });
  // a mob body needs all three: mob-brain asks to attack, combat-caster resolves the request, combat-actor takes the hit.
  // A prefab missing one spawns, walks up and can never hurt anyone (found on the first proving zone).
  for (const body of new Set(used.filter((t) => t.body !== "capsule" && t.body !== "human").map((t) => t.body))) {
    const doc = readJson(assetPath(p.projectDir, `prefabs/${body}.json`)) as { entities?: Record<string, { components?: { script?: { name?: string } } }> };
    const have = new Set(Object.values(doc.entities ?? {}).map((e) => e.components?.script?.name));
    const lacks = ["mob-brain", "combat-caster", "combat-actor"].filter((n) => !have.has(n));
    if (lacks.length) f.push({ level: "error", code: "mob-unarmed", message: `prefab ${body} has no ${lacks.join(", ")} script: its creatures could not fight` });
  }

  // ---- a starter zone's ambient life: thick enough, mostly not hostile, singles and pairs rather than packs
  let hostileShare: number | undefined;
  let dispositionShares: Shares | undefined;
  if (starter) {
    let landCells = 0;
    for (let i = 0; i < N; i++) if (inZone[i] === 1 && reason[i] !== 2 && reason[i] !== 4) landCells++;
    const landKm2 = (landCells * step * step) / 1e6;
    // a populate-owned area the live scene has already turned into a roamer (placement "anywhere", e.g. zones/<z>/life/install.mts) counts as the roamer it is
    const liveFile = path.join(p.projectDir, "assets", "scenes", `${ctx.opt("scene", ctx.world)}.scene.json`);
    const liveEnts = (exists(liveFile) ? (readJson(liveFile) as { entities?: Record<string, { components?: Record<string, unknown> }> }).entities : undefined) ?? {};
    const lived: LifeArea[] = areas.map((a) => {
      const live = liveEnts[a.id]?.components?.["spawnArea"] as LifeArea["data"] | undefined;
      // a wanderer is a designed pack or swarm (the table is the design), not ambient singles and pairs
      if (a.life) return { id: a.id, ambient: false, data: a.life as LifeArea["data"] };
      return { id: a.id, ambient: a.kind === "wildlife" || a.kind === "fill", data: live?.placement === "anywhere" ? live : { spawns: a.spawns, ...(a.temperament ? { temperament: a.temperament } : {}) } };
    });
    // hand-authored spawn areas inside the zone count too (populate's own are already in `areas`)
    const scene = baseScene(ctx, zone).doc;
    for (const [id, e] of Object.entries(scene?.entities ?? {})) {
      const data = e.components?.["spawnArea"] as LifeArea["data"] | undefined;
      const at = (e.components?.["transform"] as { position?: number[] } | undefined)?.position;
      if (!data || !at || (e.tags ?? []).includes("populate") || id.startsWith(`pop-${zone}-`)) continue;
      if (!pointInPolygon(at[0]!, at[2]!, region.polygon)) continue;
      lived.push({ id, ambient: data.placement === "anywhere", data });
    }
    f.push(...starterLifeFindings(lived, landKm2));
    let alive = 0, hostile = 0;
    for (const a of lived) { const l = lifeOf(a.data); alive += l.alive; hostile += l.hostile; }
    hostileShare = alive ? Math.round((hostile / alive) * 1000) / 1000 : 0;
    dispositionShares = sharesOf(lived.map((a) => a.data));
    const mixBad = starterMixFindings(dispositionShares);
    if (mixBad.length || dispositionShares.aggressive > 0.25) {
      // name who carries the aggressive share, so the fix is a table edit, not a hunt
      const agg = lived.map((a) => ({ id: a.id, n: Math.round(sharesOf([a.data]).aggressive * lifeOf(a.data).alive) })).filter((x) => x.n > 0).sort((x, y) => y.n - x.n).slice(0, 8);
      mixBad.push({ level: "info", code: "starter-mix-aggressive", message: `most aggressive alive: ${agg.map((x) => `${x.id} ${x.n}`).join(", ")}` });
    }
    f.push(...mixBad);
    console.log(`  dispositions (alive): passive ${Math.round(dispositionShares.passive * 100)}%, wary ${Math.round(dispositionShares.wary * 100)}%, aggressive ${Math.round(dispositionShares.aggressive * 100)}%`);
  }

  // ---- rares and named creatures sit behind placeholders (spawnArea.rares) in the live scene, never always up
  {
    const liveFile = path.join(p.projectDir, "assets", "scenes", `${ctx.opt("scene", ctx.world)}.scene.json`);
    const ents = (exists(liveFile) ? (readJson(liveFile) as { entities?: Record<string, { components?: Record<string, unknown> }> }).entities : undefined) ?? {};
    const entries: RareEntry[] = [];
    for (const [id, e] of Object.entries(ents)) {
      const data = e.components?.["spawnArea"] as { rares?: Array<{ template: string; chance: number }> } | undefined;
      const at = (e.components?.["transform"] as { position?: number[] } | undefined)?.position;
      if (!data?.rares?.length || !at || !pointInPolygon(at[0]!, at[2]!, region.polygon)) continue;
      for (const r of data.rares) entries.push({ area: id, template: r.template, chance: r.chance });
    }
    f.push(...rareFindings(named, entries));
  }

  // ---- the hub town's halo (owner ruling 2026-10-27: undead stood at the starter town's own graveyard, and the whole-moor
  // solo row carried skeletons up to the town box): nothing that attacks on sight — a roamer disc or route, a camp, and the
  // template bodies that stand at an area — within --hub-halo m (default 300) of the hub town, the area's radius included.
  // A town's own graveyard, kirk, fields and yards are the town. Roamers fail; a camp or group only warns (a quest may
  // want a bandit camp on the town's edge, and the brief carries that).
  const hubHalo = num("hub-halo", 300);
  for (const a of areas) {
    const mix = (a.life?.["mix"] as Array<{ template?: string; temperament?: string }> | undefined) ?? [];
    const areaTemper = (a.life?.["temperament"] as string | undefined) ?? a.temperament;
    const hostileMix = mix.filter((m) => (m.temperament ?? areaTemper ?? "hostile") === "hostile");
    const hostile = a.kind === "wanderer" ? hostileMix.length > 0 : (a.temperament ?? "hostile") === "hostile";
    if (!hostile) continue;
    const reach = Math.hypot(a.x - hub[0], a.z - hub[1]) - (a.kind === "wanderer" ? a.radius : 0);
    if (reach >= hubHalo) continue;
    const who = a.kind === "wanderer" ? [...new Set(hostileMix.map((m) => m.template ?? "?"))].join(", ") : a.creature;
    f.push({
      level: a.kind === "wanderer" ? "error" : "warn",
      code: "hub-halo",
      message: `${a.id} (${a.kind}): ${who} attack on sight within ${Math.round(Math.max(0, reach))} m of the hub town (halo ${hubHalo} m); move the anchor out, make those rows passive/territorial, or keep them to a place beyond the halo`,
    });
  }

  // ---- ops
  const ops = buildOps(ctx, zone, areas, used, disabledCamps, kit, f);

  const rules = [
    `zone land: inside ${zone}'s polygon, outside its town zones`,
    `not within ${sanctMargin} m of a sanctuary (${sanct.length} circles: safe POIs + safe town zones, as serve() publishes them)`,
    `nothing that attacks on sight within ${hubHalo} m of the hub town (radius included): roamers fail, camps warn (hub-halo)`,
    `not within a road's half width + ${roadMargin} m (every recipe road, path and street)`,
    `not in water deeper than ${wade} m, not on ground steeper than ${maxSlope} (sin of the angle: ${Math.round((Math.asin(maxSlope) * 180) / Math.PI)}°)`,
    `not inside a non-wild reservation (+10 m): ${reserved.map((r) => r.location).join(", ")}`,
    `an area's spawn disc lies wholly on that ground; its reach (spread + leash + roam + ${BORDER_BAND} m) stays inside the zone border`,
    `groups only at the reservations of the locations they hold (that reservation's own exclusion lifted for them), ${sep} m apart`,
    `wildlife in its habitats at ${JSON.stringify(DENSITY)} packs/km², same-creature spacing 500/sqrt(density) m, ${sep} m from any other area`,
    `fill: any wilderness point farther than ${gap} m from every area gets a minimum pack of the wildlife that fits there`,
    `levels ${lo}-${hi}: by walking distance from ${hubTown?.id ?? "the hub"} (95th percentile = ${Math.round(d95)} m), clamped to each creature's band, tiers of ${tierWidth}`,
  ];
  const report = {
    zone,
    at: new Date().toISOString(),
    inputs: Object.fromEntries(populateInputs(ctx, zone).filter(exists).map((file) => [path.relative(p.projectDir, file).replaceAll("\\", "/"), digest(p, file, zone)])),
    params: { step, budget, view, gap, sep, roadMargin, sanctuaryMargin: sanctMargin, maxSlope, wade, tier: tierWidth, wakeRadius },
    rules,
    habitatFromBiome: BIOME_HABITATS,
    numbers: {
      zoneKm2: r2((wild.length + [...reason].filter((r) => r > 1).length) * step * step / 1e6),
      wildernessKm2: r2(wildKm2),
      excludedKm2: Object.fromEntries(REASON.map((r, k) => [r, r2(([...reason].filter((x) => x === k).length * step * step) / 1e6)]).filter(([k]) => k !== "ok" && k !== "outside zone")),
      areas: areas.length,
      activeAreas: areas.filter((a) => countOf(a) > 0).length,
      creatures: total,
      perKm2: r2(total / Math.max(0.01, wildKm2)),
      fills,
      templates: used.length,
      placeholderTemplates: placeholders.length,
      placeholderCreatures: areas.reduce((n, a) => n + a.spawns.filter((s) => templates.get(s.template)?.placeholder).reduce((m, s) => m + s.count, 0), 0) + placeholders.length,
      artTemplates: artRows.length,
      artCreatures: areas.reduce((n, a) => n + a.spawns.filter((s) => templates.get(s.template)?.art).reduce((m, s) => m + s.count, 0), 0) + artRows.length,
      aliveInView: { ...aliveWorst, radius: WANDER_RULES.viewRadius, cap: WANDER_RULES.viewCap, how: "every area by its alive share inside the circle: a pack at its origin, an anywhere/solo disc spread over its land cells, a route over its points; time-gated areas (night extras) counted as out" },
      worstInView: { count: worst, at: worstAt, p95, view, budget, overShare: r2(over / Math.max(1, views.length)), how: "every standing point of the zone grid (incl. roads and towns); every area whose origin lies within view + its spread + roam counts with its whole pack, as if woken and alive; all directions, no occlusion or frustum" },
      coverage: { gap, coveredShare: r2(covered / Math.max(1, wild.length)), coverableShare: r2(coverable / Math.max(1, wild.length)), largestEmptyAcross: Math.round(largest * 2), budgetSkips },
      habitatKm2,
      ...(hostileShare !== undefined ? { hostileShare } : {}),
      ...(dispositionShares ? { dispositionShares } : {}),
    },
    byCreature,
    byGroup: groupRows,
    wanderers: wanderRows,
    camps: campRows,
    templates: used,
    areas: areas.map((a) => ({ ...a, count: countOf(a) })),
  };
  return { areas, templates: used, report, ops, png: drawMap({ nx, nz, reason, inZone, dist, d95, areas, worstAt: worstAt as [number, number], x0, z0, step, templates }) };
}

// ======================================================================================================== ops

/**
 * The scene this command computes against: the live scene with its OWN installed batch undone (the installer's saved
 * inverse applied in memory). Without this a re-run sees its own templates and moved camps and refuses to apply.
 */
// ================================================================================================= rares

/**
 * Rares are not always up (owner ruling 2026-10-07, EverQuest placeholders): a rare or named creature spawns in place
 * of a common one when its slot respawns (`spawnArea.rares`). The one place the bar lives.
 *  - maxChance: a placeholder roll above this makes the rare nearly always up.
 */
export const RARE_RULES = { maxChance: 0.3 } as const;

/** A rare or a site pack's named leader the plan made a template for. */
export interface NamedTemplate { template: string; name: string; kind: "rare" | "named" }
/** One `spawnArea.rares` row of the live scene inside the zone. */
export interface RareEntry { area: string; template: string; chance: number }

/** The placeholder-rare lint: rares / named creatures no area rolls (always up), and chances that make one nearly always up. */
export function rareFindings(named: readonly NamedTemplate[], entries: readonly RareEntry[]): Finding[] {
  const f: Finding[] = [];
  const rolled = new Set(entries.map((e) => e.template));
  const up = named.filter((n) => !rolled.has(n.template));
  const list = (xs: string[]): string => xs.slice(0, 8).join(", ") + (xs.length > 8 ? ", ..." : "");
  if (up.length && !entries.length)
    f.push({ level: "warn", code: "rare-no-placeholders", message: `zone has ${named.length} rare/named creature(s) and no placeholder rare entries (spawnArea.rares): ${list(up.map((n) => n.name))} are always up` });
  else if (up.length)
    f.push({ level: "warn", code: "rare-always-up", message: `${up.length} rare/named creature(s) stand always up, behind no placeholder (spawnArea.rares): ${list(up.map((n) => `${n.name} (${n.template})`))}` });
  const hot = entries.filter((e) => e.chance > RARE_RULES.maxChance);
  if (hot.length)
    f.push({ level: "warn", code: "rare-chance", message: `${hot.length} placeholder rare(s) roll over ${RARE_RULES.maxChance} a respawn, so they are nearly always up: ${list(hot.map((e) => `${e.template} ${e.chance} at ${e.area}`))}` });
  return f;
}

// ================================================================================================= starter life

/**
 * What a starter zone's ambient life must clear (owner ruling 2026-10-07: starter areas full of roaming life of mixed
 * types, singles and pairs, not all hostile, spawns that cannot be camped). The one place the bar lives.
 *  - perKm2: creatures alive at once per km² of the zone's dry, non-town land (a minute's walk meets several).
 *  - hostileShare: at most this share of them attacks on sight (the rest territorial or passive).
 *  - ambientMax: one roll of ambient life spawns at most this many together; more reads as a camp.
 */
export const STARTER_LIFE = { perKm2: 25, hostileShare: 0.5, ambientMax: 2 } as const;

type MixLike = { template: string; weight?: number; count?: [number, number]; temperament?: string };
export interface LifeArea {
  id: string;
  /** Ambient life (wildlife, fill, an `anywhere` area), as opposed to a camp or a site's pack. */
  ambient: boolean;
  data: { spawns?: Array<{ template: string; count?: number }>; mix?: MixLike[]; placement?: string; population?: number; unique?: boolean; temperament?: string };
}

/** Creatures alive at once, and how many of them attack on sight (spawnArea semantics, as SpawnAreaManager's populationOf). */
export function lifeOf(d: LifeArea["data"]): { alive: number; hostile: number } {
  const placement = d.placement ?? "pack";
  const counted = (d.spawns ?? []).reduce((n, s) => n + (s.count ?? 1), 0);
  const mix = d.mix ?? [];
  const alive =
    placement === "route" ? (d.unique ? 1 : (d.population ?? 1))
    : placement === "anywhere" ? (d.population ?? (mix.length ? 6 : counted))
    : counted + (mix.length ? (d.population ?? mix.length) : 0);
  const hostileOf = (t: string | undefined): boolean => (t ?? d.temperament ?? "hostile") === "hostile";
  // the table a roll draws from: the mix by weight, else the spawns by count
  const rows = mix.length ? mix.map((m) => ({ w: m.weight ?? 1, hostile: hostileOf(m.temperament) })) : (d.spawns ?? []).map((s) => ({ w: s.count ?? 1, hostile: hostileOf(undefined) }));
  const total = rows.reduce((n, r) => n + r.w, 0);
  const share = total > 0 ? rows.reduce((n, r) => n + (r.hostile ? r.w : 0), 0) / total : 1;
  return { alive, hostile: alive * share };
}

/** Shares of the creatures alive by disposition (mob-brain temperament: passive / territorial = wary / hostile = aggressive). */
export function sharesOf(areas: ReadonlyArray<LifeArea["data"]>): Shares {
  const sum = { passive: 0, wary: 0, aggressive: 0 };
  for (const d of areas) {
    const { alive } = lifeOf(d);
    const mix = d.mix ?? [];
    // the table a roll draws from, as lifeOf: the mix by weight, else the spawns by count
    const rows = mix.length ? mix.map((m) => ({ w: m.weight ?? 1, t: m.temperament ?? d.temperament ?? "hostile" })) : (d.spawns ?? []).map((sp) => ({ w: sp.count ?? 1, t: d.temperament ?? "hostile" }));
    const total = rows.reduce((n, r) => n + r.w, 0) || 1;
    for (const r of rows) sum[r.t === "passive" ? "passive" : r.t === "territorial" ? "wary" : "aggressive"] += (alive * r.w) / total;
  }
  const all = sum.passive + sum.wary + sum.aggressive || 1;
  const k = (v: number): number => Math.round((v / all) * 1000) / 1000;
  return { passive: k(sum.passive), wary: k(sum.wary), aggressive: k(sum.aggressive) };
}

/** The starter-zone life lint: thin (alive per km²), mostly hostile, packs as ambient life. Warnings, never errors. */
export function starterLifeFindings(areas: readonly LifeArea[], landKm2: number): Finding[] {
  const f: Finding[] = [];
  let alive = 0;
  let hostile = 0;
  for (const a of areas) {
    const l = lifeOf(a.data);
    alive += l.alive;
    hostile += l.hostile;
  }
  const perKm2 = alive / Math.max(0.01, landKm2);
  if (perKm2 < STARTER_LIFE.perKm2)
    f.push({ level: "warn", code: "starter-thin", message: `starter zone: ${alive} creatures alive at once over ${r2(landKm2)} km² of land (${r2(perKm2)}/km², bar ${STARTER_LIFE.perKm2}): add spawn areas with placement "anywhere" and a mix of singles and pairs` });
  if (alive > 0 && hostile / alive > STARTER_LIFE.hostileShare)
    f.push({ level: "warn", code: "starter-hostile", message: `starter zone: ${Math.round((hostile / alive) * 100)}% of its creatures attack on sight (bar ${Math.round(STARTER_LIFE.hostileShare * 100)}%): give the wildlife a temperament, passive or territorial` });
  const packs = areas.filter((a) => a.ambient && ((a.data.spawns ?? []).some((s) => (s.count ?? 1) > STARTER_LIFE.ambientMax) || (a.data.mix ?? []).some((m) => (m.count?.[1] ?? 1) > STARTER_LIFE.ambientMax)));
  if (packs.length)
    f.push({ level: "warn", code: "starter-packs", message: `starter zone: ${packs.length} ambient-life areas spawn more than ${STARTER_LIFE.ambientMax} together (${packs.slice(0, 5).map((a) => a.id).join(", ")}${packs.length > 5 ? ", ..." : ""}): ambient life is singles and pairs; packs belong at camps` });
  return f;
}

function baseScene(ctx: Ctx, zone: string): { doc: { entities: Record<string, { tags?: string[]; components?: Record<string, unknown> }> } | null; file: string; undone: boolean } {
  const id = ctx.opt("scene", ctx.world);
  const file = path.join(ctx.paths.projectDir, "assets", "scenes", `${id}.scene.json`);
  if (!exists(file)) return { doc: null, file, undone: false };
  const live = readJson(file) as never;
  const inv = path.join(populateDir(ctx, zone), `install-inverse-${id}.json`);
  if (!exists(inv)) return { doc: live, file, undone: false };
  const reg = new ComponentRegistry();
  registerCoreComponents(reg);
  registerChunkComponents(reg);
  return { doc: applyOps(live, readJson(inv) as never, reg).doc as never, file, undone: true };
}

function buildOps(ctx: Ctx, zone: string, areas: Area[], templates: Template[], disabledCamps: string[], kit: HumanKit | null, f: Finding[]): Op[] {
  const ops: Op[] = [];
  // a body prefab that declares a `level` prop gets the template's (combat-actor level: armour and crit maths)
  const hasLevelProp = (id: string): boolean => {
    try {
      return Boolean((JSON.parse(fs.readFileSync(assetPath(ctx.paths.projectDir, `prefabs/${id}.json`), "utf8")) as { props?: Record<string, unknown> }).props?.["level"]);
    } catch {
      return false;
    }
  };
  // ---- oversized bodies (bestiary `scale`): the root scales the mesh and collider; what is measured in metres
  // inside the scripts (reach, body radius, eyes, the speed each clip was authored at) is scaled with it, or a giant
  // swings at air from 8 m and moonwalks
  const scaledParams = (script: string, params: Record<string, unknown>, k: number): Record<string, unknown> | null => {
    const out: Record<string, unknown> = {};
    if (script === "mob-brain") {
      for (const key of ["attackRange", "radius", "eyeHeight"]) if (typeof params[key] === "number") out[key] = Math.round((params[key] as number) * k * 100) / 100;
      if (Array.isArray(params["moves"]))
        // only the moves made from within reach (range from 0); a leap's window is set by its lunge, which does not scale
        out["moves"] = (params["moves"] as Array<Record<string, unknown>>).map((m) => {
          const r = m["range"] as number[] | undefined;
          return Array.isArray(r) && r[0] === 0 ? { ...m, range: [0, Math.round(r[1]! * k * 100) / 100] } : m;
        });
    } else if (script === "combat-caster") out["reach"] = Math.round((typeof params["reach"] === "number" ? (params["reach"] as number) : 1) * k * 100) / 100; // on top of a big body prefab's own reach
    else if (script === "third-person-controller" && params["clipSpeeds"] && typeof params["clipSpeeds"] === "object")
      out["clipSpeeds"] = Object.fromEntries(Object.entries(params["clipSpeeds"] as Record<string, number>).map(([c, v]) => [c, Math.round(v * k * 100) / 100]));
    return Object.keys(out).length ? out : null;
  };
  /** Prefab overrides that size a ready mob body's scripts to `k`. */
  const sizeOverrides = (prefabId: string, k: number): Array<{ path: string; value: unknown }> => {
    let prefab: { entities?: Record<string, { components?: { script?: { name: string; params?: Record<string, unknown> } } }> };
    try {
      prefab = JSON.parse(fs.readFileSync(assetPath(ctx.paths.projectDir, `prefabs/${prefabId}.json`), "utf8"));
    } catch {
      return [];
    }
    const out: Array<{ path: string; value: unknown }> = [];
    for (const [key, e] of Object.entries(prefab.entities ?? {})) {
      const script = e.components?.script;
      const sized = script ? scaledParams(script.name, script.params ?? {}, k) : null;
      if (sized) for (const [param, value] of Object.entries(sized)) out.push({ path: `${key}/components/script/params/${param}`, value });
    }
    return out;
  };
  /** The entities of a body prefab that carry an asset mesh (the ones a painted theme's material goes on). */
  const meshKeys = (prefabId: string): string[] => {
    try {
      const doc = JSON.parse(fs.readFileSync(assetPath(ctx.paths.projectDir, `prefabs/${prefabId}.json`), "utf8")) as { entities?: Record<string, { components?: { mesh?: { source?: { kind?: string } } } }> };
      return Object.entries(doc.entities ?? {}).filter(([, e]) => e.components?.mesh?.source?.kind === "asset").map(([k]) => k);
    } catch {
      return [];
    }
  };
  /** The same for a template written as add-entity ops (capsule, dressed human): root scaled, scripts sized. */
  const sizeOps = (rootId: string, list: Array<{ op: string; id?: string; entity?: { components?: Record<string, unknown> } }>, k: number): void => {
    for (const o of list) {
      if (o.op !== "add-entity" || !o.entity?.components) continue;
      const c = o.entity.components;
      if (o.id === rootId) c["transform"] = { ...(c["transform"] as object), scale: [k, k, k] };
      const script = c["script"] as { name: string; params?: Record<string, unknown> } | undefined;
      const sized = script ? scaledParams(script.name, script.params ?? {}, k) : null;
      if (script && sized) script.params = { ...(script.params ?? {}), ...sized };
    }
  };
  const doc = baseScene(ctx, zone).doc ?? { entities: {} };
  const hasBridge = Object.values(doc.entities).some((e) => (e.components?.["script"] as { name?: string } | undefined)?.name === "mob-combat-bridge");
  if (!hasBridge)
    ops.push({ op: "add-entity", id: `pop-${zone}-mob-combat-bridge`, entity: { name: "Mob combat bridge (populate)", parent: null, tags: ["populate", `zone:${zone}`], components: { script: { name: "mob-combat-bridge", params: { fallbackAbility: "strike" } } } } as never });
  const byId = new Map(areas.map((a) => [a.id, a]));
  for (const t of templates) {
    const a = byId.get(t.standsAt!)!;
    const pk = PACK[t.role];
    const hp = Math.round(pk.hp * (1 + 0.22 * (t.level - 1)));
    const xp = Math.round(4 + 3 * t.level * pk.xp);
    // the display name only (levels live in the id and the `level` tag); only a body-less capsule says PLACEHOLDER
    const label = `${t.placeholder ? "PLACEHOLDER " : ""}${t.name}`;
    const tags = ["npc", "populate", `zone:${zone}`, `creature:${t.creature}`, `level:${t.level}`, ...(t.theme ? [`theme:${t.theme}`] : []), ...(t.placeholder ? ["placeholder"] : [])];
    // a template is itself a body standing at its area: templates that share an area stand in a ring, not on one spot
    const mates = templates.filter((x) => x.standsAt === t.standsAt);
    const k = mates.indexOf(t);
    const ring = mates.length > 1 ? 2.2 : 0;
    const at = [r2(a.x + Math.cos((k / mates.length) * Math.PI * 2) * ring), r2(a.y + 1.2), r2(a.z + Math.sin((k / mates.length) * Math.PI * 2) * ring)];
    const brain = { faction: t.faction, hostileTo: "player", speed: t.role === "swarm" ? 5 : 4.6, aggroRange: pk.aggro, deaggroRange: pk.aggro * 2, attackInterval: t.role === "elite" ? 2.4 : 1.8, alertRadius: 12 };
    if (t.body === "human" && kit && t.dress) {
      const built = humanTemplateOps(kit, {
        id: t.id, label, tags, at, faction: t.faction, level: t.level, hp, xp, abilities: t.abilities, dress: t.dress, loot: t.loot ?? "", pin: kit.cfg.looks?.[t.creature],
        brain: { hostileTo: brain.hostileTo, speed: brain.speed, aggroRange: brain.aggroRange, deaggroRange: brain.deaggroRange, attackInterval: brain.attackInterval, alertRadius: brain.alertRadius, leash: a.leash, roam: a.roam },
      });
      t.appearance = built.appearance;
      // the same contract as a prefab mob: brain + caster + actor, and every id/actor on the <root>-<part> pattern
      const problems = checkHumanSubtree(t.id, built.entities);
      if (problems.length) f.push({ level: "error", code: "mob-unarmed", message: `human template ${t.id}: ${problems.join("; ")}` });
      if (t.scale) sizeOps(t.id, built.ops as never, t.scale);
      ops.push(...built.ops);
      continue;
    }
    if (t.body !== "capsule") {
      const paintOv = t.material ? meshKeys(t.body).map((key) => ({ path: `${key}/components/mesh/material`, value: t.material })) : [];
      const ov = [...(t.loot ? [{ path: "combat/components/script/params/loot", value: t.loot }] : []), ...(t.scale ? sizeOverrides(t.body, t.scale) : []), ...paintOv];
      ops.push({ op: "add-entity", id: t.id, entity: { name: label, parent: null, tags, components: { transform: { position: at, ...(t.scale ? { scale: [t.scale, t.scale, t.scale] } : {}) }, prefab: { prefabId: t.body, props: { actor: t.id, faction: t.faction, maxHp: hp, xpValue: xp, ...(hasLevelProp(t.body) ? { level: t.level } : {}), aggroRange: brain.aggroRange, deaggroRange: brain.deaggroRange }, ...(ov.length ? { overrides: ov } : {}) } } } as never });
      continue;
    }
    const size = CAPSULE[t.family] ?? CAPSULE.human!;
    const capsuleStart = ops.length;
    ops.push(
      { op: "add-entity", id: t.id, entity: { name: label, parent: null, tags, components: {
        transform: { position: at },
        mesh: { source: { kind: "primitive", shape: "capsule", size, segments: [10, 5] }, material: `terrain/${ctx.world}-mob`, castShadow: true },
        rigidbody: { kind: "dynamic", lockRotations: true, ccd: true, linearDamping: 0.1 },
        collider: { shape: "capsule", size, friction: 0.4 },
        script: { name: "third-person-controller", params: { speed: 4.2, face: "movement" } },
      } } as never },
      { op: "add-entity", id: `${t.id}-combat`, entity: { name: `${t.id} combat`, parent: t.id, tags: ["combatant"], components: {
        transform: { position: [0, 0, 0] },
        billboard: { kind: "bar", offset: [0, size[1] / 2 + 0.3, 0], size: [1.1, 0.11], fill: 1, color: "#e0483f", background: "#0d1017" },
        script: { name: "combat-actor", params: { actor: t.id, faction: t.faction, maxHp: hp, xpValue: xp, level: t.level, maxStability: 60, weight: 0.5, staggerClip: "", deathClip: "", loot: t.loot ?? "" } },
      } } as never },
      { op: "add-entity", id: `${t.id}-brain`, entity: { name: `${t.id} brain`, parent: t.id, tags: [], components: {
        transform: { position: [0, 0, 0] },
        script: { name: "mob-brain", params: { actor: t.id, abilities: "strike", attackRange: 2.4, radius: size[0] / 2, eyeHeight: size[1] * 0.45, ...brain } },
      } } as never },
      // the brain only ASKS to attack; combat-caster on the body is what resolves the request into a hit
      { op: "add-entity", id: `${t.id}-caster`, entity: { name: `${t.id} caster`, parent: t.id, tags: [], components: {
        transform: { position: [0, 0, 0] },
        script: { name: "combat-caster", params: { actor: t.id, playerControlled: false, bar: "strike" } },
      } } as never },
    );
    if (t.scale) sizeOps(t.id, ops.slice(capsuleStart) as never, t.scale);
  }
  for (const a of areas) {
    const spawnArea = { radius: a.radius, sleepRadius: a.sleepRadius, idleSeconds: a.idleSeconds, spawns: a.spawns, leash: a.leash, roam: a.roam, ...(a.temperament ? { temperament: a.temperament } : {}), ...(a.territory ? { territory: a.territory } : {}), ...(a.life ?? {}) };
    const tags = ["populate", `zone:${zone}`, `pop:${a.kind}`, `creature:${a.creature}`, ...(a.group ? [`group:${a.group}`] : []), ...(a.location ? [`location:${a.location}`] : []), `level:${a.level}`];
    if (a.camp) {
      const prev = doc.entities[a.camp]?.tags ?? ["camp", `zone:${zone}`];
      ops.push({ op: "set-component", id: a.camp, component: "spawnArea", data: spawnArea }, { op: "set-tags", id: a.camp, tags: [...new Set([...prev, ...tags])] });
      if (a.movedFrom) ops.push({ op: "set-component", id: a.camp, component: "transform", data: { position: [a.x, a.y, a.z] } });
      continue;
    }
    ops.push({ op: "add-entity", id: a.id, entity: { name: `${a.kind} ${a.group ?? a.creature}${a.location ? ` @ ${a.location}` : ""}`, parent: null, tags: ["spawn-area", ...tags], components: { transform: { position: [a.x, a.y, a.z] }, spawnArea } } as never });
  }
  for (const id of disabledCamps) {
    const prev = doc.entities[id];
    if (!prev) continue;
    const data = { ...(prev.components?.["spawnArea"] as Record<string, unknown>), spawns: [] };
    ops.push({ op: "set-component", id, component: "spawnArea", data }, { op: "set-tags", id, tags: [...new Set([...(prev.tags ?? []), "populate", "populate:disabled"])] });
  }
  return ops;
}

// ======================================================================================================== map

function drawMap(m: { nx: number; nz: number; reason: Uint8Array; inZone: Uint8Array; dist: Float32Array; d95: number; areas: Area[]; worstAt: [number, number]; x0: number; z0: number; step: number; templates: Map<string, Template> }): Buffer {
  const S = 3;
  const W = m.nx * S;
  const Hh = m.nz * S;
  const px = new Uint8Array(W * Hh * 4);
  const put = (x: number, y: number, c: [number, number, number]): void => {
    if (x < 0 || y < 0 || x >= W || y >= Hh) return;
    const k = (y * W + x) * 4;
    px[k] = c[0];
    px[k + 1] = c[1];
    px[k + 2] = c[2];
    px[k + 3] = 255;
  };
  const RC: Record<number, [number, number, number]> = { 1: [18, 20, 26], 2: [214, 214, 196], 3: [196, 150, 84], 4: [52, 92, 160], 5: [92, 92, 100], 6: [150, 96, 170], 7: [60, 40, 40] };
  for (let i = 0; i < m.nx * m.nz; i++) {
    const r = m.reason[i]!;
    let c: [number, number, number];
    if (r) c = RC[r]!;
    else {
      const t = Math.min(1, m.dist[i]! / Math.max(1, m.d95)); // level shading: light green near the hub -> dark olive far out
      c = [Math.round(120 - 60 * t), Math.round(170 - 80 * t), Math.round(100 - 60 * t)];
    }
    const ix = i % m.nx;
    const iz = Math.floor(i / m.nx);
    for (let a = 0; a < S; a++) for (let b = 0; b < S; b++) put(ix * S + a, iz * S + b, c);
  }
  const kindColour: Record<Area["kind"], [number, number, number]> = { camp: [255, 255, 255], group: [230, 40, 40], rare: [255, 215, 0], wildlife: [255, 140, 30], fill: [255, 190, 120], wanderer: [80, 220, 255] };
  const disc = (x: number, z: number, r: number, c: [number, number, number], ring: boolean): void => {
    const gx = ((x - m.x0) / m.step) * S;
    const gz = ((z - m.z0) / m.step) * S;
    const rr = (r / m.step) * S;
    for (let y = Math.floor(gz - rr - 1); y <= gz + rr + 1; y++)
      for (let xx = Math.floor(gx - rr - 1); xx <= gx + rr + 1; xx++) {
        const d = Math.hypot(xx - gx, y - gz);
        if (ring ? Math.abs(d - rr) < 0.8 : d <= rr) put(xx, y, c);
      }
  };
  for (const a of m.areas) {
    const placeholder = a.spawns.some((s) => m.templates.get(s.template)?.placeholder);
    disc(a.x, a.z, a.radius, [40, 40, 40], true);
    disc(a.x, a.z, 14, a.spawns.length || a.kind === "rare" ? kindColour[a.kind] : [90, 90, 90], false);
    if (placeholder) disc(a.x, a.z, 14, [255, 0, 255], true);
  }
  disc(m.worstAt[0], m.worstAt[1], 22, [0, 255, 255], true);
  return pngRGBA(W, Hh, px);
}

/** Minimal RGBA PNG encoder (zlib store via node:zlib deflate). */
function pngRGBA(w: number, h: number, rgba: Uint8Array): Buffer {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0;
    Buffer.from(rgba.buffer, rgba.byteOffset + y * w * 4, w * 4).copy(raw, y * (w * 4 + 1) + 1);
  }
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (b: Buffer): number => {
    let c = 0xffffffff;
    for (const v of b) c = crcTable[(c ^ v) & 0xff]! ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer): Buffer => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const c = Buffer.alloc(4);
    c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

// ===================================================================================================== installer

function installer(ctx: Ctx, zone: string): string {
  const rel = path.relative(process.cwd(), populateDir(ctx, zone)).replaceAll("\\", "/");
  return `/**
 * zonegen populate installer, ${zone} of ${ctx.world} — for the COORDINATOR (run from apps/playground). Generated by
 * \`zonegen populate\`; do not edit (re-run the command). Applies ops.json to a scene as ONE applyOps batch.
 *
 *   npx tsx ${rel}/install.mts --dry-run
 *   npx tsx ${rel}/install.mts                  (live scene: ${ctx.world})
 *   npx tsx ${rel}/install.mts --uninstall
 *   npx tsx ${rel}/install.mts --scene <id>     (a scratch copy; same gates)
 *
 * Gates (stop on failure): ops.json is the batch reports/populate.json was written with; every prefab a template names
 * exists; no id it adds already exists; every camp it re-points exists. Writes the scene, install-inverse-<scene>.json
 * and installed-<scene>.json (what the zonegen status row reads).
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { applyOps, ComponentRegistry, registerCoreComponents, registerChunkComponents } from "@hitreg/core";
import { findAsset } from "${path.relative(populateDir(ctx, zone), path.resolve("tools", "_closure.mjs")).replaceAll("\\", "/")}";
import { applyOpsToSceneFile } from "${path.relative(populateDir(ctx, zone), path.resolve("tools", "_scene-write.mts")).replaceAll("\\", "/")}";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROJECT = path.resolve(HERE, "${path.relative(populateDir(ctx, zone), ctx.paths.projectDir).replaceAll("\\", "/")}");
const argv = process.argv.slice(2);
const opt = (k: string, d: string): string => (argv.includes("--" + k) ? argv[argv.indexOf("--" + k) + 1] ?? d : d);
const dry = argv.includes("--dry-run");
const sceneId = opt("scene", "${ctx.world}");
const SCENE = path.join(PROJECT, "assets", "scenes", sceneId + ".scene.json");
const INV = path.join(HERE, "install-inverse-" + sceneId + ".json");
const REC = path.join(HERE, "installed-" + sceneId + ".json");
const REPORT = path.join(HERE, "..", "reports", "populate.json");
const read = (p: string) => JSON.parse(fs.readFileSync(p, "utf8"));
const sha = (p: string) => crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex");
const fail = (why: string): never => { console.error("STOP: " + why); process.exit(1); };
const reg = new ComponentRegistry(); registerCoreComponents(reg); registerChunkComponents(reg);
if (!fs.existsSync(SCENE)) fail("no scene " + SCENE);

if (argv.includes("--uninstall")) {
  if (!fs.existsSync(INV)) fail("nothing installed into " + sceneId + " by this script (no " + path.basename(INV) + ")");
  applyOps(read(SCENE), read(INV), reg);
  if (dry) { console.log("[dry-run] would undo the populate batch in " + sceneId); process.exit(0); }
  applyOpsToSceneFile(SCENE, read(INV), (d, o) => applyOps(d, o as never, reg), { label: "populate uninstall ${zone}" }); // fresh read under the scene lock
  fs.rmSync(INV);
  if (fs.existsSync(REC)) fs.rmSync(REC);
  console.log("removed the populate batch from " + sceneId);
  process.exit(0);
}

const opsFile = path.join(HERE, "ops.json");
const report = read(REPORT);
if (report.opsSha !== sha(opsFile)) fail("ops.json is not the batch reports/populate.json describes: re-run zonegen populate");
if (fs.existsSync(INV)) fail("already installed into " + sceneId + " (uninstall first)");
const ops = read(opsFile) as Array<{ op: string; id: string; entity?: { components?: { prefab?: { prefabId: string } } } }>;
const live = read(SCENE);
for (const o of ops) {
  if (o.op === "add-entity" && live.entities[o.id]) fail("the scene already has " + o.id);
  if (o.op !== "add-entity" && !live.entities[o.id] && !ops.some((x) => x.op === "add-entity" && x.id === o.id)) fail("the scene has no " + o.id + " to change");
  const pf = o.entity?.components?.prefab?.prefabId;
  if (pf && !findAsset(PROJECT, "prefabs/" + pf + ".json")) fail("prefab " + pf + " missing (not in the dependsOn closure)");
}
const before = sha(SCENE);
const res = applyOps(live, ops as never, reg);
const adds = ops.filter((o) => o.op === "add-entity").length;
if (dry) { console.log("[dry-run] would apply " + ops.length + " ops (" + adds + " new entities, " + (ops.length - adds) + " camp edits) to " + sceneId); process.exit(0); }
const done = applyOpsToSceneFile(SCENE, ops, (d, o) => applyOps(d, o as never, reg), { label: "populate install ${zone}" }); // fresh read under the scene lock (tools/_scene-write.mts)
fs.writeFileSync(INV, JSON.stringify(done.inverse ?? res.inverse, null, 2) + "\\n");
fs.writeFileSync(REC, JSON.stringify({ installedAt: new Date().toISOString(), scene: sceneId, sceneBefore: before, sceneAfter: sha(SCENE), opsSha: report.opsSha, ids: ops.map((o) => o.id) }, null, 2) + "\\n");
console.log("installed " + ops.length + " ops into " + sceneId + "; inverse at " + path.basename(INV));
`;
}

// ===================================================================================================== status row

/** The zonegen status row: report present, inputs unchanged, batch installed into the live scene with these ops. */
export function populateRow(ctx: Ctx, zone: string): { state: "ok" | "STALE" | "MISSING" | "FAILED"; why: string; how: string } {
  const how = `npx tsx tools/zonegen.mts populate ${ctx.world} --project ${ctx.project} --zone ${zone}  -> coordinator: npx tsx ${path.relative(process.cwd(), path.join(populateDir(ctx, zone), "install.mts")).replaceAll("\\", "/")}`;
  const file = ctx.paths.report("populate", zone);
  if (!exists(file)) return { state: "MISSING", why: "never run", how };
  const rep = readJson(file) as { ok?: boolean; opsSha?: string; inputs?: Record<string, string>; numbers?: { areas?: number; creatures?: number; placeholderTemplates?: number; worstInView?: { count: number; budget: number } } };
  const changed = Object.entries(rep.inputs ?? {}).filter(([rel, h]) => {
    const full = path.join(ctx.paths.projectDir, rel);
    return !exists(full) || !digestMatches(ctx.paths, full, zone, h);
  }).map(([rel]) => path.basename(rel));
  if (changed.length) return { state: "STALE", why: `changed since populate ran: ${changed.join(", ")}`, how };
  if (!rep.ok) return { state: "FAILED", why: "populate reported errors (reports/populate.json)", how };
  const n = rep.numbers ?? {};
  const summary = `${n.areas} areas, ${n.creatures} creatures, ${n.placeholderTemplates} placeholder template(s), worst ${n.worstInView?.count}/${n.worstInView?.budget} in view`;
  const rec = path.join(populateDir(ctx, zone), `installed-${ctx.world}.json`);
  if (!exists(rec)) return { state: "MISSING", why: `${summary}; batch not installed`, how };
  const r = readJson(rec) as { opsSha?: string; ids?: string[] };
  if (r.opsSha !== rep.opsSha) return { state: "STALE", why: `${summary}; the installed batch is an older one (uninstall, then install)`, how };
  const scene = path.join(ctx.paths.projectDir, "assets", "scenes", `${ctx.world}.scene.json`);
  const ents = exists(scene) ? (readJson(scene) as { entities?: Record<string, unknown> }).entities ?? {} : {};
  const lost = (r.ids ?? []).filter((id) => !(id in ents));
  if (lost.length) return { state: "FAILED", why: `${lost.length} installed entities missing from the scene (${lost.slice(0, 3).join(", ")})`, how };
  return { state: "ok", why: summary, how };
}

/**
 * zonegen town <world> --project <p> --zone <id> — lint the plan of every town in the zone brief.
 *
 * The plan format is the one tools/town-layout.mts reads (authoring/towns/<name>-plan.json); a town NAME is found
 * from the town doc (authoring/towns/<name>.json with `town` = recipe id and `world`). This is the planning half of
 * what town-layout checks — services, homes, workplaces, size, wealth — so a plan can fail before any lot is laid.
 * Whether the town is on the coast comes from its survey (tools/town-survey.mts) when one exists; without it the
 * coast is decided from the recipe: its tags, else the world field (built once, only then) sampled around the pad.
 * Relationship refs must be residents of the same town unless marked `crossTown`.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createWorldField } from "@hitreg/core";
import { exists, finish, load, loadRecipe, readJson, type Ctx, type Finding } from "../lib.mts";
import { zoneBriefSchema } from "../schemas.mts";
import { err, requireZone, townNames, warn, WEALTH, type Tier } from "./_shared.mts";

/** Every town, whatever its size, has these (Derek's rule, docs/town-npcs.md and the town planner). */
export const REQUIRED_SERVICES = ["vault", "soul-binder", "food", "drink", "repair", "basic-gear", "quest-giver", "guard"];
/** Residents a town of each tier plans for: [min, max]. One table; change it here. */
export const ROSTER_BANDS: Record<Tier, [number, number]> = {
  hamlet: [6, 14],
  village: [12, 26],
  town: [20, 45],
  city: [35, 70],
  capital: [60, 250],
};

/**
 * Skinned residents a town of each tier may carry (docs/world-standards towns: "skinned residents count against a
 * performance budget; the rest are ambient bodies"). A plan's own `bodyCap` (data, per town) overrides its tier's.
 * A resident with `body: "ambient"` is an ambient body and does not count.
 */
export const SKINNED_BUDGET: Record<Tier, number> = { hamlet: 14, village: 20, town: 28, city: 36, capital: 45 };
/** Wear 3 (holed walls, slipped roofs) is for ruins and abandoned buildings only. */
export const RUIN_WEAR = 3;
/** The building kit's style files (MMO/WFC/styles/<style>.json, beside the engine); HITREG_STYLES_DIR overrides. */
const STYLES_DIR = process.env.HITREG_STYLES_DIR ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../../../MMO/WFC/styles");
const styleWear = new Map<string, number | null>();
function wearOfStyle(style: string): number | null {
  if (!styleWear.has(style)) {
    const f = path.join(STYLES_DIR, `${style}.json`);
    let w: number | null = null;
    try { w = fs.existsSync(f) ? Number((JSON.parse(fs.readFileSync(f, "utf8")) as { wear?: number }).wear ?? 0) : null; } catch { w = null; }
    styleWear.set(style, w);
  }
  return styleWear.get(style)!;
}
interface PlanBuilding { id: string; style?: string; wear?: number; abandoned?: boolean; ruin?: boolean; request?: { style?: string; wear?: number } }
/** Inhabited buildings (someone lives or works there, not declared abandoned/ruin) whose wear is ruin-grade. Pure. */
export function wearFindings(buildings: PlanBuilding[], residents: PlanResident[], styleWearOf: (style: string) => number | null = wearOfStyle): string[] {
  const out: string[] = [];
  for (const b of buildings) {
    if (b.abandoned || b.ruin) continue;
    const people = residents.filter((r) => r.home === b.id || r.work === b.id);
    if (!people.length) continue;
    const style = b.request?.style ?? b.style;
    const wear = b.request?.wear ?? b.wear ?? (style ? styleWearOf(style) : null);
    if (wear !== null && wear !== undefined && wear >= RUIN_WEAR)
      out.push(`${b.id}: wear ${wear}${b.request?.wear ?? b.wear ? "" : ` (style ${style})`} on an inhabited building (${people.slice(0, 3).map((r) => r.id).join(", ")}${people.length > 3 ? ", ..." : ""}): wear 3 is for ruins and abandoned buildings only; use wear 1-2, or declare it abandoned and move its people`);
  }
  return out;
}
/** Skinned residents against the town's budget (the plan's bodyCap, else the tier's). Pure. */
export function skinnedFinding(tier: Tier, residents: (PlanResident & { body?: string })[], bodyCap?: number): string | null {
  const cap = bodyCap ?? SKINNED_BUDGET[tier];
  const skinned = residents.filter((r) => r.body !== "ambient").length;
  return skinned > cap ? `${skinned} skinned residents for a ${tier} (budget ${cap}${bodyCap !== undefined ? ", the plan's bodyCap" : `, SKINNED_BUDGET.${tier}`}): mark the background folk body: "ambient", or cut residents` : null;
}
interface PlanResident { id: string; wealth?: string; home?: string; work?: string; services?: string[]; body?: string }
interface TownPlan {
  town?: string;
  tier?: string;
  required?: string[];
  residents?: PlanResident[];
  buildings?: PlanBuilding[];
  bodyCap?: number;
  structures?: { id: string; kind: string }[];
  relationships?: { a: string; b: string; kind?: string; crossTown?: boolean }[];
}

/** Metres beyond pad + falloff the coast test looks (the same reach as tools/town-survey.mts). */
const COAST_REACH = 60;
/**
 * Coastal without a survey: tagged so in the recipe, or sea-level ground within COAST_REACH of the pad. The second needs
 * ground heights, so the world field is built ONCE, lazily, only when some town has no survey and no tag.
 */
let field: { height(x: number, z: number): number } | null = null;
let recipeCache: ReturnType<typeof loadRecipe> | null = null;
function coastalFromRecipe(ctx: Ctx, townId: string): { coastal: boolean; how: string } {
  const recipe = (recipeCache ??= loadRecipe(ctx.paths));
  const t = recipe.features.towns.find((x) => x.id === townId);
  if (!t) return { coastal: false, how: "town not in recipe" };
  if (t.tags.some((g) => /^(coastal|harbou?r|port|quay|fishing)$/.test(g))) return { coastal: true, how: "recipe tags" };
  field ??= createWorldField(recipe);
  let wet = 0;
  let n = 0;
  for (const extra of [20, 40, COAST_REACH])
    for (let i = 0; i < 32; i++) {
      const a = (i / 32) * Math.PI * 2;
      const r = t.radius + t.falloff + extra;
      n++;
      if (field.height(t.center[0] + Math.cos(a) * r, t.center[1] + Math.sin(a) * r) < recipe.seaLevel) wet++;
    }
  return { coastal: wet >= 4, how: `${wet}/${n} ground samples within ${COAST_REACH} m of the pad below sea level (world field)` };
}

export async function run(ctx: Ctx): Promise<number> {
  const bad = requireZone(ctx.zone, "town");
  if (bad !== null) return bad;
  const f: Finding[] = [];
  const p = ctx.paths;
  const inputs = [p.brief(ctx.zone)];
  const brief = load(p.brief(ctx.zone), zoneBriefSchema, f, "zone brief");
  if (brief) {
    const names = townNames(p, ctx.world);
    for (const t of brief.towns) {
      const name = names.get(t.id);
      if (!name) {
        err(f, "no-town-doc", `${t.id}: no town doc (authoring/towns/<name>.json with "town": "${t.id}", "world": "${ctx.world}") — the town has no name to plan under`, t.id);
        continue;
      }
      inputs.push(p.townDoc(name), p.townPlan(name));
      const planFile = p.townPlan(name);
      if (!exists(planFile)) {
        err(f, "no-plan", `${t.id}: ${name}-plan.json not written yet (the town-planner skill writes it)`, name);
        continue;
      }
      let plan: TownPlan;
      try {
        plan = readJson(planFile) as TownPlan;
      } catch (e) {
        err(f, "bad-json", `${name}-plan.json: ${(e as Error).message}`, name);
        continue;
      }
      const ref = name;
      if (plan.town !== name) err(f, "plan-town", `${name}-plan.json says town "${plan.town}"`, ref);
      if (plan.tier && plan.tier !== t.tier) err(f, "tier", `${name}: the plan says ${plan.tier}, the brief ${t.tier}`, ref);
      const residents = plan.residents ?? [];
      const buildings = new Set((plan.buildings ?? []).map((b) => b.id));
      const structures = plan.structures ?? [];
      const places = new Set([...buildings, ...structures.map((s) => s.id), "none"]);

      const provided = new Set(residents.flatMap((r) => r.services ?? []));
      for (const need of new Set([...REQUIRED_SERVICES, ...(plan.required ?? [])])) if (!provided.has(need)) err(f, "service", `${name}: no resident provides "${need}"`, ref);
      for (const need of REQUIRED_SERVICES) if (!(plan.required ?? []).includes(need)) warn(f, "required-list", `${name}: the plan's own "required" list omits ${need}`, ref);

      const [lo, hi] = ROSTER_BANDS[t.tier];
      if (residents.length < lo || residents.length > hi) err(f, "roster", `${name}: ${residents.length} residents for a ${t.tier} (plan ${lo}-${hi})`, ref);

      const ids = new Set<string>();
      for (const r of residents) {
        if (ids.has(r.id)) err(f, "duplicate", `${name}: resident ${r.id} twice`, ref);
        ids.add(r.id);
        for (const k of ["home", "work"] as const) {
          if (!r[k]) err(f, k, `${name}: resident ${r.id} has no ${k}`, ref);
          else if (!places.has(r[k]!)) err(f, k, `${name}: resident ${r.id}'s ${k} "${r[k]}" is not a building or structure in the plan`, ref);
        }
        if (r.wealth && !(WEALTH as readonly string[]).includes(r.wealth)) err(f, "wealth", `${name}: resident ${r.id} has wealth "${r.wealth}"`, ref);
      }
      for (const b of buildings) if (!residents.some((r) => r.home === b || r.work === b)) warn(f, "empty-building", `${name}: nobody lives or works in ${b}`, ref);
      // wear follows occupancy; skinned residents count against a budget
      for (const w of wearFindings(plan.buildings ?? [], residents)) err(f, "wear-inhabited", `${name}: ${w}`, ref);
      const sk = skinnedFinding(t.tier, residents, plan.bodyCap);
      if (sk) err(f, "skinned-budget", `${name}: ${sk}`, ref);

      // the town's wealth is where its people sit: the median resident within one step of the brief
      const steps = residents.map((r) => WEALTH.indexOf((r.wealth ?? "") as (typeof WEALTH)[number])).filter((i) => i >= 0).sort((a, b) => a - b);
      const target = WEALTH.indexOf(t.wealth);
      if (steps.length) {
        const median = steps[Math.floor(steps.length / 2)]!;
        if (Math.abs(median - target) > 1) err(f, "wealth", `${name}: the brief says ${t.wealth}, the median resident is ${WEALTH[median]}`, ref);
        if (target <= 1 && steps.filter((s) => s === 4).length > 1) warn(f, "wealth", `${name}: a ${t.wealth} town with several noble residents`, ref);
      }

      const surveyFile = path.join(p.projectDir, "authoring", "towns", "survey", `${name}.json`);
      if (exists(surveyFile)) {
        inputs.push(surveyFile);
        const coastal = (readJson(surveyFile) as { coastal?: boolean }).coastal === true;
        if (coastal && !structures.some((s) => s.kind === "dock")) err(f, "dock", `${name}: an ocean-coastal town (survey) without a dock structure`, ref);
      } else {
        inputs.push(p.recipe);
        const c = coastalFromRecipe(ctx, t.id);
        if (c.coastal && !structures.some((s) => s.kind === "dock")) err(f, "dock", `${name}: coastal by the recipe (${c.how}; no survey yet) and the plan has no dock structure`, ref);
      }
      const people = new Set(residents.map((r) => r.id));
      for (const rel of plan.relationships ?? []) {
        for (const who of [rel.a, rel.b])
          if (!people.has(who) && !rel.crossTown) err(f, "relationship", `${name}: relationship ${rel.a}~${rel.b} names "${who}", who is not a resident here (mark it crossTown: true if they live elsewhere)`, ref);
      }
      console.log(`  ${name.padEnd(18)} ${t.tier.padEnd(8)} ${residents.length} residents, ${buildings.size} buildings, ${structures.length} structures`);
    }
  }
  return finish(ctx, "town", inputs, f);
}

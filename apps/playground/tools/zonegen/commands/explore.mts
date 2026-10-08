/**
 * zonegen explore <world> --project <p> --zone <z> [--spacing <m>]
 *
 * The exploration gate. Exploration content is added AFTER the freeze, in zones/<z>/exploration.json (schema
 * `explorationSchema`), never in the frozen quests.json, so adding to it never stales the build. This gate:
 *   - counts the locations it adds against the brief's budget.expansion (error over it): the brake on POI -> quest -> POI;
 *   - refuses a discovery quest that needs a NEW place (a discovery quest finds what exists; it never mints a POI);
 *   - counts added quests together with the frozen ones against the brief's quest budgets;
 *   - needs a reservation inside the zone, clear of the frozen ones, for every added location;
 *   - lists the candidate sites left in the zone (recipe POIs nobody reserved, away from towns and reservations,
 *     thinned to --spacing metres, default 150) by kind, into reports/explore-sites.json, for a later agent. It places
 *     nothing.
 */
import path from "node:path";
import { exists, finish, load, readJson, writeJson, type Ctx, type Finding } from "../lib.mts";
import type { WorldRecipe } from "@hitreg/core";
import { explorationSchema, type Exploration } from "../schemas.mts";
import { loadZonePlan } from "./_zone.mts";
import { err, inZone, rel, requireZone, warn } from "./_shared.mts";

export const explorationFile = (ctx: Ctx, zone: string): string => path.join(ctx.paths.zoneDir(zone), "exploration.json");

export async function run(ctx: Ctx): Promise<number> {
  const bad = requireZone(ctx.zone, "explore");
  if (bad !== null) return bad;
  const f: Finding[] = [];
  const p = ctx.paths;
  const zone = ctx.zone;
  const file = explorationFile(ctx, zone);
  const inputs = [p.brief(zone), p.quests(zone), p.reservations(zone), p.recipe, file];
  const plan = loadZonePlan(ctx, zone, f);
  if (!plan) return finish(ctx, "explore", inputs, f);
  const ex: Exploration = exists(file) ? (load(file, explorationSchema, f, "exploration") ?? { zone, locations: [], reservations: [], quests: [] }) : { zone, locations: [], reservations: [], quests: [] };
  const b = plan.brief.budget;

  // added locations against the expansion budget
  const frozenIds = new Set(plan.graph.locations.map((l) => l.id));
  const added = ex.locations.filter((l) => l.kind !== "town");
  for (const l of ex.locations) if (frozenIds.has(l.id)) err(f, "clash", `added location ${l.id} already exists in the frozen plan`, l.id);
  if (added.length > b.expansion) err(f, "expansion", `${added.length} location(s) added after the freeze against budget.expansion ${b.expansion}: ${added.map((l) => l.id).join(", ")}`);

  // reservations for what is added: inside the zone, clear of the frozen ones and of towns
  // read raw (not schema-parsed): only regions, towns and POIs are needed, and a partial recipe must still work
  const raw = readJson(p.recipe) as Partial<WorldRecipe> & { features?: Partial<WorldRecipe["features"]> };
  const recipe = { regions: raw.regions ?? [], features: { towns: raw.features?.towns ?? [], pois: raw.features?.pois ?? [] } };
  const region = recipe.regions.find((r) => r.id === zone && r.within === undefined);
  const reserved = [...plan.reservations.reservations, ...ex.reservations];
  for (const l of added) {
    const r = ex.reservations.find((x) => x.location === l.id);
    if (!r) {
      err(f, "unreserved", `added location ${l.id} has no reservation in exploration.json`, l.id);
      continue;
    }
    if (region && !inZone(region, r.center[0], r.center[1])) err(f, "outside-zone", `added location ${l.id}: centre outside ${zone}`, l.id);
    for (const o of plan.reservations.reservations) {
      const d = Math.hypot(o.center[0] - r.center[0], o.center[1] - r.center[1]);
      if (d < o.radius + r.radius) err(f, "overlap", `added location ${l.id} overlaps ${o.location} (${Math.round(d)} m apart)`, l.id);
    }
  }

  // added quests: discovery never mints a place; budgets count frozen + added
  const newIds = new Set(added.map((l) => l.id));
  const entityAt = new Map(plan.graph.entities.map((e) => [e.id, e.location]));
  for (const q of ex.quests) {
    if (plan.graph.quests.some((x) => x.id === q.id)) err(f, "clash", `added quest ${q.id} already exists in the frozen plan`, q.id);
    const places = new Set(q.objectives.flatMap((o) => [o.at, o.target.type === "place" ? o.target.ref : "", o.target.type === "entity" ? (entityAt.get(o.target.ref) ?? "") : ""]).filter(Boolean));
    const fresh = [...places].filter((x) => newIds.has(x) || (!frozenIds.has(x) && !plan.graph.locations.some((l) => l.id === x)));
    if (q.kind === "discovery" && fresh.length) err(f, "discovery-new-poi", `discovery quest ${q.id} needs place(s) that are not in the frozen plan: ${fresh.join(", ")} — discovery finds what exists`, q.id);
    else if (fresh.some((x) => !newIds.has(x))) err(f, "unknown-place", `quest ${q.id} uses unknown place(s): ${fresh.filter((x) => !newIds.has(x)).join(", ")}`, q.id);
  }
  const count = (k: string[]): number => [...plan.graph.quests, ...ex.quests].filter((q) => k.includes(q.kind)).length;
  if (count(["discovery"]) > b.discoveryQuests) err(f, "budget", `${count(["discovery"])} discovery quests (frozen + added) against a budget of ${b.discoveryQuests}`);
  if (count(["side", "link"]) > b.sideQuests) err(f, "budget", `${count(["side", "link"])} side and link quests (frozen + added) against a budget of ${b.sideQuests}`);

  // candidate sites left: recipe POIs of this zone nobody reserved, away from towns and reservations, thinned
  const spacing = Number(ctx.opt("spacing", "150")) || 150;
  const taken = new Set(reserved.map((r) => r.site));
  const towns = recipe.features.towns;
  const picked: { id: string; kind: string; at: [number, number]; nearest: string; gap: number }[] = [];
  const pois = recipe.features.pois.filter((x) => ((x as { zone?: string }).zone ? (x as { zone?: string }).zone === zone : region ? inZone(region, x.position[0]!, x.position[2]!) : false));
  for (const poi of pois) {
    if (taken.has(poi.id)) continue;
    const at: [number, number] = [poi.position[0]!, poi.position[2]!];
    if (towns.some((t) => Math.hypot(t.center[0] - at[0], t.center[1] - at[1]) < t.radius + t.falloff + spacing)) continue;
    let nearest = "";
    let gap = Infinity;
    for (const r of reserved) {
      const d = Math.hypot(r.center[0] - at[0], r.center[1] - at[1]) - r.radius;
      if (d < gap) (gap = d), (nearest = r.location);
    }
    if (gap < spacing) continue;
    if (picked.some((c) => Math.hypot(c.at[0] - at[0], c.at[1] - at[1]) < spacing)) continue;
    picked.push({ id: poi.id, kind: poi.kind, at, nearest, gap: Math.round(gap) });
  }
  const byKind = new Map<string, typeof picked>();
  for (const c of picked) byKind.set(c.kind, [...(byKind.get(c.kind) ?? []), c]);
  const sitesFile = path.join(p.zoneDir(zone), "reports", "explore-sites.json");
  writeJson(sitesFile, { zone, at: new Date().toISOString(), spacing, budgetLeft: Math.max(0, b.expansion - added.length), byKind: Object.fromEntries([...byKind].map(([k, v]) => [k, v])) });
  console.log(`explore ${zone}: ${added.length}/${b.expansion} expansion location(s) used, ${ex.quests.length} quest(s) added${exists(file) ? "" : " (no exploration.json yet)"}`);
  console.log(`  candidate sites left (recipe POIs, >= ${spacing} m from towns, reservations and each other): ${picked.length}`);
  for (const [k, v] of [...byKind].sort((a, c) => c[1].length - a[1].length))
    console.log(`    ${k.padEnd(16)} ${String(v.length).padStart(2)}  ${v.slice(0, 4).map((c) => `${c.id} (${c.gap} m from ${c.nearest || "any reservation"})`).join(", ")}${v.length > 4 ? " …" : ""}`);
  console.log(`  -> ${rel(p, sitesFile)} (a list for a later agent; nothing is placed)`);
  if (!picked.length && b.expansion > added.length) warn(f, "no-sites", `budget allows ${b.expansion - added.length} more location(s) but no unreserved recipe site is left at ${spacing} m spacing`);
  return finish(ctx, "explore", inputs, f);
}

/**
 * zonegen freeze <world> --project <p> --zone <id> — end of planning. Refuses unless every planning gate of the
 * world and the zone is ok (not stale), then writes freeze.json: the planning digest (lib.digest) of every planning file. From here on a
 * builder owns its reservation and nothing else, and any later edit to a planning file makes every build stage STALE.
 */
import { DIGEST_VERSION, digest, exists, finish, gateState, loadRecipe, readJson, writeJson, type Ctx, type Finding } from "../lib.mts";
import { freezeSchema, zoneBriefSchema } from "../schemas.mts";
import { err, rel, requireZone, townNames } from "./_shared.mts";

export const WORLD_GATES = ["bestiary", "adjacency", "cast", "links"] as const;
export const ZONE_GATES = ["sites", "brief", "bestiary", "town", "quests", "reserve", "manifest"] as const;

/** The files a frozen plan consists of. */
export function planningFiles(ctx: Ctx, zone: string): string[] {
  const p = ctx.paths;
  // the recipe and town plans are digested to their PLANNING content (lib.digest): layout written later never counts
  const files = [p.recipe, p.bestiary, p.adjacency, p.cast, p.links, p.brief(zone), p.zoneBestiary(zone), p.quests(zone), p.reservations(zone), p.assets(zone)];
  if (exists(p.brief(zone))) {
    const brief = zoneBriefSchema.safeParse(readJson(p.brief(zone)));
    const names = townNames(p, ctx.world);
    if (brief.success) for (const t of brief.data.towns) {
      const name = names.get(t.id);
      if (name) files.push(p.townPlan(name));
    }
  }
  return files;
}

export async function run(ctx: Ctx): Promise<number> {
  const bad = requireZone(ctx.zone, "freeze");
  if (bad !== null) return bad;
  const f: Finding[] = [];
  const p = ctx.paths;
  for (const g of WORLD_GATES) {
    const s = gateState(p, g);
    if (s.state !== "ok") err(f, "world-gate", `world gate ${g} is ${s.state}${s.why ? `: ${s.why}` : ""}`, g);
  }
  for (const g of ZONE_GATES) {
    const s = gateState(p, g, ctx.zone);
    if (s.state !== "ok") err(f, "zone-gate", `zone gate ${g} is ${s.state}${s.why ? `: ${s.why}` : ""}`, g);
  }
  // names are a world stage owned by worldgen; the zone's own part of it is cheap to check here
  const recipe = loadRecipe(p);
  for (const r of recipe.regions) {
    if (r.id === ctx.zone && /^Zone \d+$/.test(r.name)) err(f, "unnamed", `${r.id} is still called "${r.name}" (zone-setup skill)`, r.id);
    if (r.within === ctx.zone && /^Town \d+$/.test(r.name)) err(f, "unnamed", `town zone ${r.id} is still called "${r.name}"`, r.id);
  }
  const files = planningFiles(ctx, ctx.zone);
  for (const file of files) if (!exists(file)) err(f, "missing-file", `${rel(p, file)} does not exist`);
  if (f.some((x) => x.level === "error")) {
    console.log("freeze refused: planning is not finished");
    return finish(ctx, "freeze", [], f);
  }
  const freeze = freezeSchema.parse({ zone: ctx.zone, at: new Date().toISOString(), v: DIGEST_VERSION, hashes: Object.fromEntries(files.map((file) => [rel(p, file), digest(p, file, ctx.zone)])) });
  writeJson(p.freeze(ctx.zone), freeze);
  console.log(`froze ${ctx.zone}: ${files.length} planning files`);
  return finish(ctx, "freeze", files, f);
}

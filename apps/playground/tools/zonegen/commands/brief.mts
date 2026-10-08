/**
 * zonegen brief <world> --project <p> --zone <id> — lint the zone brief against the map and the cast.
 *
 * The brief's towns are exactly the zone's towns in the recipe (tiers included); the hub is one of them and, in a
 * starter zone, not a capital; its level is the cast row's; it names every neighbour; its budget is not empty.
 */
import { finish, load, loadRecipe, type Ctx, type Finding } from "../lib.mts";
import { castSchema, zoneBriefSchema } from "../schemas.mts";
import { err, neighboursOf, readAdjacency, requireZone, warn, zoneTowns } from "./_shared.mts";

export async function run(ctx: Ctx): Promise<number> {
  const bad = requireZone(ctx.zone, "brief");
  if (bad !== null) return bad;
  const f: Finding[] = [];
  const p = ctx.paths;
  const zone = ctx.zone;
  const brief = load(p.brief(zone), zoneBriefSchema, f, "zone brief");
  const cast = load(p.cast, castSchema, f, "cast");
  const adj = readAdjacency(p, f);
  if (brief && cast && adj) {
    const recipe = loadRecipe(p);
    if (brief.zone !== zone) err(f, "wrong-zone", `brief.zone is "${brief.zone}", not "${zone}"`);
    const region = recipe.regions.find((r) => r.id === zone && r.within === undefined);
    if (!region) err(f, "unknown-zone", `${zone} is not a wilderness zone of ${ctx.world}`);
    else if (region.name !== brief.name) warn(f, "name", `the brief calls it "${brief.name}", the map "${region.name}"`);
    const real = zoneTowns(recipe, zone);
    for (const t of real) {
      const b = brief.towns.find((x) => x.id === t.id);
      if (!b) err(f, "town-missing", `the zone holds ${t.id} (${t.tier}) and the brief leaves it out`, t.id);
      else if (b.tier !== t.tier) err(f, "tier", `${t.id}: the brief says ${b.tier}, the recipe ${t.tier}`, t.id);
    }
    for (const b of brief.towns) if (!real.some((t) => t.id === b.id)) err(f, "town-extra", `${b.id} is not a town of ${zone} in the recipe`, b.id);
    if (real.length > 5) warn(f, "many-towns", `${real.length} towns: the pipeline is planned for 0-5 per zone`);

    const row = cast.rows.find((r) => r.zone === zone);
    if (!row) err(f, "no-cast-row", `${zone} has no cast row`);
    else {
      if (row.level[0] !== brief.level[0] || row.level[1] !== brief.level[1]) err(f, "level", `brief level ${brief.level.join("-")} differs from the cast row's ${row.level.join("-")}`);
      const hub = brief.towns.find((t) => t.id === brief.hub);
      if (row.starter && hub?.tier === "capital") err(f, "starter-capital", `${zone} is a starter zone and its hub ${brief.hub} is a capital`);
    }
    for (const n of neighboursOf(adj, zone)) if (!brief.neighbours.some((x) => x.zone === n)) err(f, "neighbour-missing", `${n} borders ${zone} and the brief says nothing about it`, n);
    for (const n of brief.neighbours) if (!neighboursOf(adj, zone).includes(n.zone)) err(f, "not-a-neighbour", `${n.zone} does not border ${zone}`, n.zone);
    const b = brief.budget;
    const total = b.arcs + b.sideQuests + b.discoveryQuests + b.pois.small + b.pois.medium + b.pois.large + b.dungeons;
    if (total === 0) err(f, "empty-budget", "the budget is all zeros: nothing to build");
    if (b.arcs === 0 && b.sideQuests === 0) warn(f, "no-quests", "no arcs and no side quests");
    // owner ruling 2026-10-06: a zone carries 3 to 5 dungeons (every landmark owns one; capitals and starter towns get one nearby)
    const hasCapital = brief.towns.some((t) => t.tier === "capital");
    if (hasCapital && b.dungeons < 5) warn(f, "few-dungeons", `a zone with a capital carries 5 dungeons; the budget plans ${b.dungeons}`);
    else if (b.dungeons < 3) warn(f, "few-dungeons", `the budget plans ${b.dungeons} dungeon(s); a zone carries 3 to 5`);
    if (b.dungeons > 5) warn(f, "many-dungeons", `the budget plans ${b.dungeons} dungeons; a zone carries 3 to 5`);

    // signature places: designed before quests (docs/zone-creation.md). Zones planned before places existed only warn.
    const places = brief.places;
    if (!places.length) warn(f, "no-places", "no signature places: design the zone's places (read, landmark, set piece, unique) before its quests");
    else {
      const large = places.filter((x) => x.size === "large");
      if (large.length < b.pois.large) err(f, "large-places", `the budget promises ${b.pois.large} large site(s) and ${large.length} place(s) are large`);
      for (const x of large) if (x.features.length < 3) err(f, "thin-large", `${x.id} is large with ${x.features.length} feature(s): a large place is three or more linked sub-sites`, x.id);
      for (const x of places) if (x.size !== "pinpoint" && x.holder && !x.named.length) warn(f, "no-named", `${x.id} is held by ${x.holder} and names nobody to meet or farm`, x.id);
      // places come from the ground (`zonegen sites`, run before the brief), not from text
      const unsited = places.filter((x) => !x.site);
      if (unsited.length) warn(f, "place-unsited", `${unsited.length} of ${places.length} place(s) record no ground pick (\`site\`, from \`zonegen sites\`): ${unsited.map((x) => x.id).join(", ")}`);
      const withDungeon = places.filter((x) => x.dungeon);
      if (withDungeon.length < b.dungeons) err(f, "dungeon-places", `the budget promises ${b.dungeons} dungeon(s) and ${withDungeon.length} place(s) own one: a dungeon belongs to a place`);
      // sameness: two places remembered for the same thing are one place built twice
      const norm = (s: string): string => s.toLowerCase().replace(/[^a-z0-9 ]/g, "").replace(/\s+/g, " ").trim();
      for (const key of ["setPiece", "unique", "landmark"] as const) {
        const seen = new Map<string, string>();
        for (const x of places) {
          const k = norm(x[key]);
          const prev = seen.get(k);
          if (prev) err(f, `same-${key}`, `${x.id} and ${prev} share their ${key}: "${x[key]}"`, x.id);
          seen.set(k, x.id);
        }
      }
    }
    console.log(`brief ${zone}: ${brief.name}, ${brief.towns.length} town(s), level ${brief.level.join("-")}`);
  }
  return finish(ctx, "brief", [p.brief(zone), p.cast, p.adjacency, p.recipe], f);
}

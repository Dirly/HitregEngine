/**
 * zonegen links <world> --project <p> — lint how towns relate.
 *
 * A `road` link must be a route that exists: a recipe road whose id is `path-<a>-<b>` (either order), or, failing
 * that, any road whose polyline reaches both towns' pads. Other kinds are relationships, not routes.
 */
import { finish, load, loadRecipe, type Ctx, type Finding } from "../lib.mts";
import { linksSchema } from "../schemas.mts";
import { distToPolyline, err, warn } from "./_shared.mts";

export async function run(ctx: Ctx): Promise<number> {
  const f: Finding[] = [];
  const p = ctx.paths;
  const links = load(p.links, linksSchema, f, "links");
  if (links) {
    const recipe = loadRecipe(p);
    if (links.world !== ctx.world) err(f, "wrong-world", `links.world is "${links.world}", not "${ctx.world}"`);
    const towns = new Map(recipe.features.towns.map((t) => [t.id, t]));
    const zoned = new Set(recipe.regions.filter((r) => r.within !== undefined).map((r) => r.landmarks[0] ?? ""));
    const reaches = (road: { points: [number, number][] }, id: string): boolean => {
      const t = towns.get(id)!;
      return distToPolyline(t.center[0], t.center[1], road.points) <= t.radius + t.falloff + Math.max(0, ...t.gates.map((g) => g.approach));
    };
    const seen = new Set<string>();
    for (const l of links.links) {
      const ref = `${l.a}~${l.b}`;
      for (const t of [l.a, l.b]) if (!towns.has(t)) err(f, "unknown-town", `${ref}: town "${t}" is not in the recipe`, ref);
      if (l.a === l.b) err(f, "self-link", `${ref}: a town linked to itself`, ref);
      const key = [l.a, l.b].sort().join("~") + `:${l.kind}`;
      if (seen.has(key)) warn(f, "duplicate", `${ref}: a second ${l.kind} link between the same towns`, ref);
      seen.add(key);
      if (l.kind !== "road" || !towns.has(l.a) || !towns.has(l.b)) continue;
      const byId = recipe.features.roads.find((r) => r.id === `path-${l.a}-${l.b}` || r.id === `path-${l.b}-${l.a}`);
      const byShape = byId ?? recipe.features.roads.find((r) => reaches(r, l.a) && reaches(r, l.b));
      if (!byShape) err(f, "no-road", `${ref}: a road link, but no path in the recipe joins them (run \`worldgen paths\`, or make it a trade/ferry link)`, ref);
    }
    if (links.links.length === 0 && zoned.size > 1) err(f, "empty", "no links at all between " + zoned.size + " towns");
    const linked = new Set(links.links.flatMap((l) => [l.a, l.b]));
    for (const id of zoned) if (id && !linked.has(id)) warn(f, "unlinked-town", `town ${id} appears in no link: nothing connects it to the world's story`, id);
    console.log(`links: ${links.links.length}, ${[...zoned].filter((t) => linked.has(t)).length} of ${zoned.size} zoned towns linked`);
  }
  return finish({ ...ctx, zone: "" }, "links", [p.links, p.recipe], f);
}

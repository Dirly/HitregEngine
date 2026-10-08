/**
 * zonegen init <world> --project <p> [--zone <id>] — scaffold the planning files, never overwriting one.
 *
 * World: the catalogue, cast and links. Zone: the brief (prefilled with what the map already decides — name, towns
 * and tiers, neighbours, the cast row's level), the zone bestiary, the quest graph and the reservations. Text an
 * agent must write is left EMPTY so the schema fails until it is: a template never passes a gate by itself.
 * Each file carries a "$fill" note naming the stage and the brief that fills it (unknown keys are ignored on parse).
 */
import { exists, loadRecipe, readJson, writeJson, type Ctx } from "../lib.mts";
import { rel, zoneTowns, type Adjacency } from "./_shared.mts";

export async function run(ctx: Ctx): Promise<number> {
  const p = ctx.paths;
  const wrote: string[] = [];
  const put = (file: string, value: unknown): void => {
    if (exists(file)) return;
    writeJson(file, value);
    wrote.push(rel(p, file));
  };
  const fill = (stage: string, who: string): string => `${who}: \`zonegen brief-for ${stage} ${ctx.world} --project ${ctx.project}${ctx.zone ? ` --zone ${ctx.zone}` : ""}\`; gate: \`zonegen ${stage === "zone-bestiary" ? "bestiary" : stage === "zone-brief" ? "brief" : stage} ...\``;

  put(p.bestiary, { $fill: "the creature catalogue: everything the GAME supports (opus, from the existing mob library; gate `zonegen bestiary`)", version: 1, creatures: [], factions: [] });
  put(p.cast, { $fill: fill("cast", "opus"), world: ctx.world, rules: { maxFactionShare: 0.25, maxLevelStep: 8 }, rows: [] });
  put(p.links, { $fill: "sonnet: one link per town relationship; every road link must be a recipe path (gate `zonegen links`)", world: ctx.world, links: [] });

  if (ctx.zone) {
    const recipe = loadRecipe(p);
    const region = recipe.regions.find((r) => r.id === ctx.zone && r.within === undefined);
    if (!region) {
      console.error(`init: ${ctx.zone} is not a wilderness zone of ${ctx.world}`);
      return 1;
    }
    const towns = zoneTowns(recipe, ctx.zone);
    const adj = exists(p.adjacency) ? (readJson(p.adjacency) as Adjacency) : null;
    const neighbours = adj?.zones.find((z) => z.id === ctx.zone)?.neighbours ?? [];
    const cast = exists(p.cast) ? (readJson(p.cast) as { rows?: { zone: string; level: [number, number] }[] }) : {};
    const level = cast.rows?.find((r) => r.zone === ctx.zone)?.level ?? region.level ?? [1, 10];
    put(p.brief(ctx.zone), {
      $fill: fill("zone-brief", "fable"),
      zone: ctx.zone, name: region.name, premise: "", history: "", threat: "", tone: "", level, traversal: "",
      hub: towns[0]?.id ?? "",
      towns: towns.map((t) => ({ id: t.id, name: t.name, tier: t.tier, role: "", wealth: "" })),
      neighbours: neighbours.map((zone) => ({ zone, relation: "" })),
      budget: { arcs: 0, sideQuests: 0, discoveryQuests: 0, pois: { small: 0, medium: 0, large: 0 }, dungeons: 0, expansion: 0 },
    });
    put(p.zoneBestiary(ctx.zone), { $fill: fill("zone-bestiary", "sonnet"), zone: ctx.zone, wildlife: [], faction: [], minor: [], rares: [], bosses: [] });
    put(p.quests(ctx.zone), { $fill: fill("quests", "opus"), zone: ctx.zone, arcs: [], quests: [], locations: [], dungeons: [], items: [] });
    put(p.reservations(ctx.zone), { $fill: fill("reserve", "sonnet"), zone: ctx.zone, reservations: [] });
  }
  console.log(wrote.length ? `wrote:\n${wrote.map((w) => `  ${w}`).join("\n")}` : "nothing to write: every file exists");
  console.log("town plans stay at authoring/towns/<name>-plan.json (`zonegen brief-for town`); next: `zonegen status`");
  return 0;
}

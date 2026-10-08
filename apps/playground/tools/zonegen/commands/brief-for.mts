/**
 * zonegen brief-for <stage> <world> --project <p> [--zone <id>] — print an agent stage's brief with paths filled in.
 *
 *   stages: cast, zone-brief, zone-bestiary, town, quests, reserve   (templates: tools/zonegen/briefs/<stage>.md)
 *           dress-building --town <name> --building <id> [--map <id>]  (one fresh agent furnishes one building)
 *           dress-site --poi <id> --area <area id>  (one fresh Sonnet dresses one outdoor area of a place: tools/site-sockets.mts maps)
 *
 * The coordinating session hands the printed text to a FRESH agent, so every agent of a stage gets the same bounded
 * contract: what to read, the one file to write, the gate that must pass, what it must not touch. Judgment lives in
 * the brief; facts (fields, enums) live in the schemas' `.describe()` text, which the brief points at.
 *
 * `--stage <stage>` after the world works too.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { questBlocks } from "@hitreg/core";
import { exists, makePaths, readJson, type Ctx } from "../lib.mts";
import { zoneBriefSchema } from "../schemas.mts";
import { rel, townNames } from "./_shared.mts";

const here = path.dirname(fileURLToPath(import.meta.url));
const briefsDir = path.join(here, "..", "briefs");
const STAGES = ["cast", "zone-brief", "zone-bestiary", "town", "quests", "reserve", "dress-building", "dress-site"];
/** Stages that work on one building of one town rather than on a zone: `--town <name> --building <id> [--map <socket map id>]`. */
const BUILDING_STAGES = ["dress-building"];

/** A condition block's fields from the engine registry, as "name (description)" — what a plan can actually ask for. */
function blockFields(name: string): string {
  const shape = (questBlocks.get("condition", name)?.schema as { shape?: Record<string, { description?: string }> } | undefined)?.shape ?? {};
  return Object.entries(shape).map(([k, v]) => `${k}${v.description ? ` (${v.description.split(/\.\s|:\s/)[0]})` : ""}`).join("; ") || "(none registered)";
}

/** The area role site-sockets measured the map as ("(site camp, ..." in its source line). */
function siteRole(projectDir: string, mapId: string): string {
  const f = path.join(projectDir, "authoring", "dressing", "sockets", `${mapId}.json`);
  try { return /\(site ([a-z-]+)/.exec(String((readJson(f) as { source?: { model?: string } }).source?.model ?? ""))?.[1] ?? "camp"; } catch { return "camp"; }
}

export async function run(ctx: Ctx): Promise<number> {
  // the dispatcher took the first positional as the world: `brief-for cast mmo` arrives as world=cast, argv=[mmo, ...]
  let stage = ctx.opt("stage");
  let world = ctx.world;
  if (!stage && STAGES.includes(ctx.world) && ctx.argv[0] && !ctx.argv[0].startsWith("--")) {
    stage = ctx.world;
    world = ctx.argv[0];
  }
  if (!STAGES.includes(stage)) {
    console.error(`brief-for: stage must be one of ${STAGES.join(", ")}`);
    return 2;
  }
  const p = makePaths(ctx.project, world);
  const zone = ctx.zone;
  if (BUILDING_STAGES.includes(stage) && (!ctx.opt("town") || !ctx.opt("building"))) {
    console.error(`brief-for ${stage}: give --town <name> --building <id> [--map <socket map id>]`);
    return 2;
  }
  if (stage === "dress-site" && (!ctx.opt("poi") || !ctx.opt("area"))) {
    console.error("brief-for dress-site: give --poi <id> --area <area id> (maps from tools/site-sockets.mts)");
    return 2;
  }
  if (stage !== "cast" && stage !== "dress-site" && !BUILDING_STAGES.includes(stage) && !zone) {
    console.error(`brief-for ${stage}: give --zone <id>`);
    return 2;
  }
  const r = (file: string): string => `projects/${ctx.project}/${rel(p, file)}`;
  let townPlans = "(write the zone brief first: it lists the towns)";
  if (zone && exists(p.brief(zone))) {
    const b = zoneBriefSchema.safeParse(readJson(p.brief(zone)));
    const names = townNames(p, world);
    if (b.success)
      townPlans = b.data.towns
        .map((t) => {
          const n = names.get(t.id);
          return n ? `${t.id} (${t.tier}, ${t.wealth}) "${n}": ${r(p.townPlan(n))}  [town doc ${r(p.townDoc(n))}]` : `${t.id} (${t.tier}): NO town doc yet — create authoring/towns/<name>.json {"town": "${t.id}", "world": "${world}"} first`;
        })
        .join("\n  ");
  }
  const vars: Record<string, string> = {
    world,
    project: ctx.project,
    zone,
    zonegen: `npx tsx tools/zonegen.mts`,
    flags: `${world} --project ${ctx.project}${zone ? ` --zone ${zone}` : ""}`,
    schemas: "tools/zonegen/schemas.mts",
    recipe: r(p.recipe),
    bestiary: r(p.bestiary),
    adjacency: r(p.adjacency),
    cast: r(p.cast),
    links: r(p.links),
    brief: zone ? r(p.brief(zone)) : "",
    zoneBestiary: zone ? r(p.zoneBestiary(zone)) : "",
    quests: zone ? r(p.quests(zone)) : "",
    reservations: zone ? r(p.reservations(zone)) : "",
    zoneDir: zone ? r(p.zoneDir(zone)) : "",
    townPlans,
    weather: blockFields("weather"),
    clock: blockFields("clock"),
    town: ctx.opt("town"),
    building: ctx.opt("building"),
    map: ctx.opt("map", ctx.opt("building")),
    plan: stage === "dress-site" ? `${ctx.opt("poi")}--${ctx.opt("area")}` : `${ctx.opt("town")}--${ctx.opt("building")}`,
    poi: ctx.opt("poi"),
    area: ctx.opt("area"),
    siteMap: `${ctx.opt("poi")}-${ctx.opt("area")}`,
    role: siteRole(p.projectDir, `${ctx.opt("poi")}-${ctx.opt("area")}`),
  };
  const text = fs.readFileSync(path.join(briefsDir, `${stage}.md`), "utf8").replace(/\{(\w+)\}/g, (m, k: string) => vars[k] ?? m);
  console.log(text.trimEnd());
  return 0;
}

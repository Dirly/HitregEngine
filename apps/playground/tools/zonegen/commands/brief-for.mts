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
import { questObjectsText } from "./quest-objects.mts";
import { questDecls } from "../../_dress-quest.mts";

/** The quest objects a dresser of `location` must include (zonegen quest-objects), for the {questObjects} brief var. */
function questObjectsFor(projectDir: string, world: string, location: string): string {
  if (!location) return "";
  const zones = [...new Set(questDecls(projectDir).filter((d) => d.location === location).map((d) => d.zone))];
  const sceneFile = path.join(projectDir, "assets", "scenes", `${world}.scene.json`);
  const scene = exists(sceneFile) ? (readJson(sceneFile) as { entities: Record<string, { tags?: string[] }> }) : null;
  const body = zones.length ? zones.map((z) => questObjectsText(projectDir, z, scene, location)).join("\n") : `(the quest plans declare no objects at ${location})`;
  return (
    `${body}\nEach declared object is one plan item with \`quest.entity\`: \`{ "id": "<id>", "prop": "<a catalogued prop from the menu>", "place": {...}, "quest": { "entity": "<id>" } }\`` +
    " (an object in no plan is a check warning; one already in another plan stays there)."
  );
}

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

/** The socket map a building was measured as: `<town>-<building>` (town-builder sockets), else the first map whose id
 * starts with it (a lot variant such as `reeve-house-b`), else the bare building id. */
function defaultBuildingMap(projectDir: string, town: string, building: string): string {
  const dir = path.join(projectDir, "authoring", "dressing", "sockets");
  const want = `${town}-${building}`;
  if (fs.existsSync(path.join(dir, `${want}.json`))) return want;
  const hit = fs.existsSync(dir)
    ? fs.readdirSync(dir).find((f) => f.startsWith(`${want}-`) && f.endsWith(".json") && !f.endsWith(".steps.json"))
    : undefined;
  return hit ? hit.slice(0, -".json".length) : building;
}

/** The project whose sockets/ holds a site map: the world project, else the place's place-build lab (projects/pb-<poi>). */
export function siteMapDir(projectDir: string, mapId: string, poi: string): string {
  const has = (d: string) => !!mapId && fs.existsSync(path.join(d, "authoring", "dressing", "sockets", `${mapId}.json`));
  const lab = path.join(path.dirname(projectDir), `pb-${poi}`);
  return has(projectDir) || !poi || !has(lab) ? projectDir : lab;
}

/** L (KNUCKLECROWN close 2026-10-29: four Sonnet dressers passed chain-coils, skulls, spades and camp gear that the
 *  place-build dress gate then refused as wrong-culture): the dresser's `props menu` and `dress check` ran with no culture.
 *  The place's dressing SPACE { kind, scale, cultures } is the one place-build wrote into the job's first plan for that area
 *  (`<job>/dressing/<poi>-<area>.json`, the cultures its install check uses); else the job brief's `culture` set. Null: none. */
export function siteSpace(zoneDir: string, poi: string, area: string): { kind: string; scale: string; cultures: string[] } | null {
  const job = path.join(zoneDir, "pois", poi), first = path.join(job, "dressing", `${poi}-${area}.json`);
  try { const sp = (readJson(first) as { space?: { kind?: string; scale?: string; cultures?: string[] } }).space; if (sp?.cultures?.length) return { kind: sp.kind ?? "site", scale: sp.scale ?? "human", cultures: sp.cultures }; } catch { /* no first plan */ }
  try { const set = ((readJson(path.join(job, "brief.json")) as { sets?: string[] }).sets ?? []).find((x) => x.startsWith("culture="));
    if (set) { const v = set.slice("culture=".length).replace(/^\[|\]$/g, "").split(",").map((x) => x.trim().replace(/^"|"$/g, "")).filter(Boolean); if (v.length) return { kind: "site", scale: "human", cultures: v }; } } catch { /* no brief */ }
  return null;
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
  // L (Wristgate 2026-10-29): a place-build place's socket maps are measured in its LAB (projects/pb-<poi>), not in the
  // world project (the place is not installed yet): the brief named the project, found no map and called a yard a camp
  const siteDir = siteMapDir(p.projectDir, stage === "dress-site" ? `${ctx.opt("poi")}-${ctx.opt("area")}` : "", ctx.opt("poi"));
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
    map: ctx.opt("map", defaultBuildingMap(p.projectDir, ctx.opt("town"), ctx.opt("building"))),
    plan: stage === "dress-site" ? `${ctx.opt("poi")}--${ctx.opt("area")}` : `${ctx.opt("town")}--${ctx.opt("building")}`,
    poi: ctx.opt("poi"),
    area: ctx.opt("area"),
    siteMap: `${ctx.opt("poi")}-${ctx.opt("area")}`,
    role: siteRole(siteDir, `${ctx.opt("poi")}-${ctx.opt("area")}`),
    siteProject: path.basename(siteDir),
    ...(() => { const sp = stage === "dress-site" && zone ? siteSpace(p.zoneDir(zone), ctx.opt("poi"), ctx.opt("area")) : null;
      return { space: sp ? JSON.stringify(sp) : '{ "kind": "site", "scale": "human", "cultures": ["<the people of the place>"] }', spaceFlags: sp ? ` --scale ${sp.scale} --culture ${sp.cultures.join(",")}` : "" }; })(),
    questObjects: stage === "dress-site" || BUILDING_STAGES.includes(stage) ? questObjectsFor(p.projectDir, world, stage === "dress-site" ? ctx.opt("poi") : ctx.opt("town")) : "",
  };
  const text = fs.readFileSync(path.join(briefsDir, `${stage}.md`), "utf8").replace(/\{(\w+)\}/g, (m, k: string) => vars[k] ?? m);
  const visualStage = ["zone-brief", "zone-bestiary", "town", "dress-building", "dress-site"].includes(stage);
  console.log([...(visualStage ? ["Read docs/art-direction.md for the shared texture-led PSX direction across this whole layout and its assets. Plan surface artwork with the structural forms and review a representative textured sample before repetition. Honour this job's scope; a planning brief does not authorize building."] : []), text.trimEnd()].join("\n\n"));
  return 0;
}

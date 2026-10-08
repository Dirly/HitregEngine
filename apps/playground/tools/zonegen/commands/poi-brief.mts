/**
 * zonegen poi-brief <world> --project <p> --zone <z> (--location <id> | --all) [--dry] [--mode plan|build] [--refresh]
 *
 * Turns a planned location into the POI creator's intake brief (tools/poi-review/creator/brief.mjs) and prepares the
 * job with the creator's own `prepare.mjs` into zones/<z>/pois/<location>/, so ONE fresh owner agent can be started
 * from that folder. Our plan maps onto the creator's brief:
 *   adventureSize  <- the location's size        hostility   <- whether a zone group/faction holds it
 *   description    <- the plan's own words (location note, holder premise, the quests that happen there)
 *   location       <- the reservation (site, centre, radius, approach; anchor from the recipe POI)
 *   requirements   <- the location's `needs`, every declared quest entity standing there (with the exact entity id the
 *                     quests bind to), every objective that happens there, the occupants
 *   constraints    <- stay inside the reservation and its terrainRadius, catalogued props and creatures only, and the
 *                     creatures whose bodies are not ready (placeholders the pipeline swaps later)
 * Idempotent: a job past `briefed`, or one with an owner, is never touched. A briefed job whose brief no longer matches
 * the plan is reported; `--refresh` re-prepares it (still only while nobody owns it). --dry prints the listing only.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { exists, readJson, writeJson, type Ctx, type Finding } from "../lib.mts";
import { factionMembers, type Location, type PlannedQuest } from "../schemas.mts";
import { loadZonePlan, poiJob, poiJobDir, reservationOf, type ZonePlan } from "./_zone.mts";
import { rel, requireZone } from "./_shared.mts";

const ENGINE = path.resolve("..", "..");
const PREPARE = path.join(ENGINE, "tools", "poi-review", "creator", "prepare.mjs");

interface CreatorBrief {
  version: 1;
  id: string;
  name: string;
  project: string;
  adventureSize: "pinpoint" | "small" | "medium" | "large";
  hostility: "non-hostile" | "hostile" | "mixed";
  description: string;
  location: { hint: string; anchor?: [number, number, number] };
  requirements: string[];
  constraints: string[];
  mode: "plan" | "build";
}

const condText = (c: unknown): string => JSON.stringify(c);
type PlannedObjective = PlannedQuest["objectives"][number];
/** The condition a planned step carries: its `if`, else its night/day shorthand as a clock window. */
export const whenOf = (o: PlannedObjective): Record<string, unknown> | undefined =>
  o.if ?? (o.when === "night" ? { clock: { from: 20, to: 4 } } : o.when === "day" ? { clock: { from: 6, to: 20 } } : undefined);

/** Objectives (and quest starts) that happen at a location: what must physically work there. */
function questsAt(plan: ZonePlan, loc: Location): { q: PlannedQuest; line: string }[] {
  const out: { q: PlannedQuest; line: string }[] = [];
  const entityLoc = new Map(plan.graph.entities.map((e) => [e.id, e.location]));
  for (const q of plan.graph.quests) {
    const startsHere = (q.giver.type === "object" || q.giver.type === "presence") && entityLoc.get(q.giver.ref) === loc.id;
    if (startsHere) out.push({ q, line: `${q.id}: STARTS here from ${q.giver.type} entity \`${q.giver.ref}\` (no marker; found through leads)` });
    for (const o of q.objectives) {
      const here = o.at === loc.id || (o.target.type === "place" && o.target.ref === loc.id) || (o.target.type === "entity" && entityLoc.get(o.target.ref) === loc.id);
      if (!here) continue;
      const w = whenOf(o);
      const target = o.target.type === "place" ? "" : ` ${o.target.type} \`${o.target.ref}\``;
      const extra = [o.count > 1 ? `x${o.count}` : "", w ? `only while ${condText(w)}` : "", Object.keys(o.params).length ? `params ${JSON.stringify(o.params)}` : "", o.grants.length ? `gives ${o.grants.join(", ")}` : ""].filter(Boolean).join(", ");
      out.push({ q, line: `${q.id}/${o.id}: ${o.action}${target}${extra ? ` (${extra})` : ""}` });
    }
  }
  return out;
}

export function creatorBrief(ctx: Ctx, plan: ZonePlan, loc: Location, mode: "plan" | "build"): { brief: CreatorBrief; placeholders: string[]; problems: string[] } {
  const problems: string[] = [];
  const res = reservationOf(plan, loc.id);
  if (!res) problems.push(`location ${loc.id} has no reservation`);
  const zb = plan.zoneBestiary;
  const group = zb?.groups.find((g) => g.id === loc.hostile);
  const faction = !group && loc.hostile ? plan.bestiary?.factions.find((f) => f.id === loc.hostile) : undefined;
  const creatures = new Map((plan.bestiary?.creatures ?? []).map((c) => [c.id, c]));
  const here = questsAt(plan, loc);
  const entities = plan.graph.entities.filter((e) => e.location === loc.id);

  // where populate already stood this location's creatures (its batch tags each area `location:<id>`)
  const popFile = path.join(ctx.paths.zoneDir(ctx.zone), "populate", "ops.json");
  const popAreas: { x: number; z: number; what: string }[] = exists(popFile)
    ? (readJson(popFile) as { op: string; entity?: { name?: string; tags?: string[]; components?: { transform?: { position?: number[] } } } }[])
        .filter((o) => o.op === "add-entity" && o.entity?.tags?.includes(`location:${loc.id}`) && o.entity.components?.transform?.position)
        .map((o) => ({ x: Math.round(o.entity!.components!.transform!.position![0]!), z: Math.round(o.entity!.components!.transform!.position![2]!), what: o.entity!.name ?? "" }))
    : [];

  // occupants and the bodies that are not ready
  const members:{ creature: string; theme: string; role?: string }[] = group ? group.members : faction ? factionMembers(faction) : [];
  const rares = [
    ...(zb?.rares ?? []).filter((r) => r.where === loc.id).map((r) => ({ id: r.id, name: r.name, base: r.base, theme: r.theme })),
    ...(zb?.bosses ?? []).filter((b) => b.dungeon && loc.entranceTo === b.dungeon).map((b) => ({ id: b.id, name: b.name, base: b.base, theme: b.theme })),
  ];
  const placeholders: string[] = [];
  const noted = new Set<string>();
  const bodyNote = (id: string, theme: string): void => {
    const key = `${id}:${theme}`;
    if (noted.has(key)) return;
    noted.add(key);
    const c = creatures.get(id);
    if (!c) return void placeholders.push(`${id} (not in the catalogue)`);
    const th = c.themes.find((t) => t.id === theme);
    const why = [c.body.status !== "ready" ? `body ${c.body.status}` : "", theme && th && th.status !== "ready" ? `theme ${theme} ${th.status}` : "", theme && !th ? `theme ${theme} not catalogued` : "", !c.template ? "no spawn template" : ""].filter(Boolean);
    if (why.length) placeholders.push(`${id}${theme ? `:${theme}` : ""} (${why.join(", ")})`);
  };
  for (const m of members) bodyNote(m.creature, m.theme);
  for (const r of rares) bodyNote(r.base, r.theme);
  for (const { q } of here)
    for (const o of q.objectives)
      if (o.action === "kill" && o.target.type === "creature" && o.at === loc.id && creatures.has(o.target.ref)) bodyNote(o.target.ref, "");

  const peaceful = here.some(({ q }) => q.objectives.some((o) => o.at === loc.id && ["talk", "read", "deliver"].includes(o.action)));
  const hostility: CreatorBrief["hostility"] = loc.hostile ? (peaceful ? "mixed" : "hostile") : "non-hostile";
  const holder = group
    ? `Held by ${group.name} (zone group ${group.id}${group.faction ? `, faction ${group.faction}` : ""}): ${group.premise}`
    : faction
      ? `Held by ${faction.name}: ${faction.premise}`
      : "Nobody hostile holds it.";
  const titles = [...new Set(here.map((h) => h.q.id))].map((id) => {
    const q = plan.graph.quests.find((x) => x.id === id)!;
    return `${q.title}: ${q.summary}`;
  });
  const description = [
    `${loc.name}, a ${loc.size} ${loc.kind} in ${plan.brief.name} (${plan.brief.zone}).`,
    loc.note,
    holder,
    loc.entranceTo ? `It is the way into the dungeon ${loc.entranceTo}; the interior is its own dungeon project, this job builds the surface and the entrance.` : "",
    titles.length ? `Quests that happen here: ${titles.join(" / ")}` : "",
  ].filter(Boolean).join(" ");

  const recipe = readJson(ctx.paths.recipe) as { features?: { pois?: { id: string; kind: string; position: number[] }[] } };
  const recipePoi = res && res.site !== "new" ? recipe.features?.pois?.find((x) => x.id === res.site) : undefined;
  const anchor: [number, number, number] | undefined = recipePoi && recipePoi.position.length === 3 ? [recipePoi.position[0]!, recipePoi.position[1]!, recipePoi.position[2]!] : undefined;
  const approaches = res ? [res.approach, ...res.approaches].map((a) => a.from).join(", ") : "?";
  const hint = res
    ? `Reserved site ${res.site}${recipePoi ? ` (recipe POI kind ${recipePoi.kind})` : ""} centred at x ${res.center[0]}, z ${res.center[1]}, radius ${res.radius} m, reached from ${approaches}. World ${ctx.world}, scene ${ctx.opt("scene", ctx.world)}. Survey the rendered ground there before fixing the footprint.`
    : `No reservation: survey ${plan.brief.name} for a ${loc.siteKinds.join("/") || "fitting"} site`;

  const entityLine = (e: (typeof entities)[number]): string => {
    const presenceWhen = plan.graph.quests.flatMap((q) => q.objectives.filter((o) => o.target.type === "entity" && o.target.ref === e.id).map(whenOf)).find(Boolean);
    const how =
      e.kind === "readable"
        ? "an `npc` builtin with readable: true and face: false (its text is written later)"
        : e.kind === "object"
          ? "an entity tagged `interactable`, with an `npc` builtin (face: false) when a quest starts from it or it hands something over"
          : `an \`npc\` builtin whose \`presence\` param is the condition${presenceWhen ? ` ${condText(presenceWhen)}` : ""} (an entity runs ONE script: presence is a param of npc, not a second script)`;
    return `Place quest entity \`${e.id}\` (${e.kind}: ${e.what}) with EXACTLY this entity id, as ${how}. Quests bind to the id; its dialogue/text is written after placement.`;
  };
  const requirements = [
    ...loc.needs.map((n) => `Physically present: ${n}.`),
    ...entities.map(entityLine),
    ...here.map((h) => `Must work here: ${h.line}.`),
    // creatures are zonegen populate's: one writer for every spawn area, so level tiers, densities and kill tags stay consistent
    ...(members.length || rares.length
      ? [
          `Occupants (${[...members.map((m) => m.creature), ...rares.map((r) => `${r.id}, a rare`)].join(", ")}) are placed by \`zonegen populate\`, NOT by you: add no spawn area, template or creature. ` +
            (popAreas.length
              ? `Their areas already stand at ${popAreas.map((a) => `[${a.x}, ${a.z}] (${a.what})`).join("; ")}. Keep each spot open, dry and standable for 8 m round; if the build must cover one, say so in your report and the coordinator re-runs populate.`
              : "None are installed here yet: leave at least two open, dry, standable clearings of 8 m radius for them and list their centres in your report."),
        ]
      : []),
  ];
  const constraints = [
    res ? `Stay inside the reservation: centre x ${res.center[0]}, z ${res.center[1]}, radius ${res.radius} m. Nothing outside it is yours.` : "",
    res ? (res.terrainRadius > 0 ? `Terrain may be reshaped only within ${res.terrainRadius} m of the centre. What the place is made OF the land (a cutting, a hollow, a bank, a pond, a mound, a sunk floor) is shaped in the terrain there, never laid on top as a slab of geometry; what is BUILT (walls, a sluice, a hide, a tower) is geometry standing on ground that was only levelled for it.` : "No terrain reshaping: the reservation allows none (terrainRadius 0). Fit the place to the ground.") : "",
    res ? `Keep the approach from ${approaches} walkable; do not move roads or rivers.` : "",
    loc.minTownDistance > 0 ? `Keep at least ${loc.minTownDistance} m from any town.` : "",
    "What you may make and what you may not. The catalogue comes first: search `props menu` and use what exists (barrels, crates, tents, stands, carts, torches); never remake a thing the catalogue has, that is the fastest way to lose consistency. You MAY generate: ruins (build them from the DC stamp kit's columns and pieces under tools/dc-construction, tools/dc-carving and tools/structural-assemblies, deformed and broken, not from plain boxes), wooden docks, shacks, rocks, bones through the DC tool (no skulls), and flat art from the image generator (tools/image-request.mjs: a hide stretched on a tanning rack, carvings, banners, decals of dragged reeds or mud) at the project's pixel scale. You may NEVER generate animals or any wildlife, plants, grass or reeds. Land is site material too: a cave, a mine, a den or a mountain path is cut with the voxel tools (worldgen caves and passages), sized from one town-kit grid cell (3.2 m) as the smallest clear width, height and depth so a player fits. Coursed block walls built in code are welcome for house and tower ruins, but they must never read as a stack of boxes: chip and round the corner stones, shift or drop a few blocks, break the wall tops unevenly and let a wall lean a little, while every stone stays a closed solid on its mortar lines. The idea must read at a glance from the road: say in one line what a passer-by sees, and build that.",
    placeholders.length
      ? `For information, these creatures have no finished body yet: ${placeholders.join("; ")}. That is not yours to solve: zonegen populate stands them as placeholders and swaps the body when it is ready.`
      : "",
    "One art style: every surface you make is drawn at the project's texel standard (`texelDensity` in authoring/prop-catalogs.json: 128 px across 3.2 m, nearest filtering), never finer on a wall, floor, deck or other large surface. Stone, masonry and wood use the TOWN's role tiles named there (`detailRoles`), cropped into a tiling texture when they must repeat; no dungeon or trial textures, no newly generated stone or wood. Size blocks and planks so courses line up with the tile. `props status` must not report your pieces HIGH or LOW, and one evidence picture shows your work beside a town wall or the terrain at player distance.",
    "One place, one bucket of lights: read tools/light-buckets.json, pick the bucket that fits this place (tomb, manor, delve, camp, street), name it in every dressing plan (`\"lights\": \"<bucket>\"`) and use only its fixtures; several kinds from the same bucket are wanted, a fixture from another is not. `dress check` prints a LIGHTS line when a plan breaks it.",
    "The zone plan is frozen: if the brief cannot be met, report the conflict in progress.json; never reinterpret a quest, rename an entity id or move the reservation.",
    "Quest text, dialogue and readable text are written later by the bind stage's writers: place the entities, do not write their lines.",
  ].filter(Boolean);

  return {
    brief: { version: 1, id: loc.id, name: loc.name, project: ctx.project, adventureSize: loc.size, hostility, description, location: { hint, ...(anchor ? { anchor } : {}) }, requirements, constraints, mode },
    placeholders,
    problems,
  };
}

export async function run(ctx: Ctx): Promise<number> {
  const bad = requireZone(ctx.zone, "poi-brief");
  if (bad !== null) return bad;
  const f: Finding[] = [];
  const plan = loadZonePlan(ctx, ctx.zone, f);
  if (!plan) {
    for (const x of f) console.error(`  ERROR ${x.code}: ${x.message}`);
    return 1;
  }
  const one = ctx.opt("location");
  if (!one && !ctx.flag("all")) {
    console.error("poi-brief: give --location <id> or --all");
    return 2;
  }
  const mode = ctx.opt("mode", "build") === "plan" ? "plan" : "build";
  const locs = plan.graph.locations.filter((l) => l.kind !== "town" && (!one || l.id === one));
  if (!locs.length) {
    console.error(`poi-brief: ${one ? `no non-town location "${one}"` : "no locations"} in ${ctx.zone}`);
    return 2;
  }
  const dry = ctx.flag("dry");
  let failed = 0;
  console.log(`poi-brief ${ctx.zone}${dry ? " (dry)" : ""}: ${locs.length} location(s)  [id, size, hostility, requirements, placeholders, job]`);
  for (const loc of locs) {
    const { brief, placeholders, problems } = creatorBrief(ctx, plan, loc, mode);
    const dir = poiJobDir(ctx, ctx.zone, loc.id);
    const job = poiJob(ctx, ctx.zone, loc.id);
    const briefFile = path.join(dir, "brief.json");
    const same = !!job && exists(briefFile) && JSON.stringify(readJson(briefFile)) === JSON.stringify(brief);
    const head = `  ${loc.id.padEnd(16)} ${loc.size.padEnd(8)} ${brief.hostility.padEnd(11)} ${String(brief.requirements.length).padStart(2)} req  ${placeholders.length} placeholder(s)`;
    if (problems.length) {
      failed++;
      console.log(`${head}  REFUSED: ${problems.join("; ")}`);
      continue;
    }
    const owned = !!job && (job.stage !== "briefed" || !!job.ownerAgentId);
    const state = !job ? "no job" : owned ? `job at "${job.stage}"${job.ownerAgentId ? ` owned by ${job.ownerAgentId}` : ""}: never touched` : same ? "briefed, current" : "briefed, brief differs from the plan";
    if (dry || (job && (owned || same || !ctx.flag("refresh")))) {
      console.log(`${head}  [${state}${!dry && job && !owned && !same ? "; --refresh re-prepares it" : ""}]`);
      continue;
    }
    if (job) fs.rmSync(dir, { recursive: true });
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zonegen-poi-"));
    const tmp = path.join(tmpDir, "brief.json");
    writeJson(tmp, brief);
    const r = spawnSync(process.execPath, [PREPARE, "--brief", tmp, "--out-dir", dir], { encoding: "utf8" });
    fs.rmSync(tmpDir, { recursive: true, force: true });
    if (r.status !== 0) {
      failed++;
      console.log(`${head}  prepare.mjs FAILED: ${(r.stderr || r.stdout).trim().split(/\r?\n/).slice(-3).join(" | ")}`);
      continue;
    }
    console.log(`${head}  prepared -> ${rel(ctx.paths, dir)}  (start ONE fresh owner with the poi-creator skill on this job dir)`);
  }
  return failed ? 1 : 0;
}

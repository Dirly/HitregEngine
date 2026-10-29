/**
 * place-build — the PLACE BUILDER: an outdoor place (camp, croft row, shrine, graveyard, landing, work yard, den, watch
 * ruin, halt yard, cuttings) from a place ARCHETYPE + the zone brief + the reservation + the measured ground. Data in,
 * the tool builds, the gates run. Small and medium places; a hero place stays with an Opus owner. docs/place-builder.md.
 *
 *   node node_modules/tsx/dist/cli.mjs tools/place-build.mts <command> <world> --zone <z> --location <id> [--project <p>]
 *     archetypes                        list the archetypes (projects/world-kit/authoring/place-archetypes/*.json)
 *     survey [--at x,z] [--r 90] [--step 10]   a height grid round the site (~~~ = water), to choose --archetype / --set
 *     plan   [--archetype a] [--set k=v ...] [--at x,z | auto] [--faces E | auto] [--roam 1.5]   SITE SEARCH (level connected pockets; --at pins the core) + survey the ground and write the job dir (zonegen/<world>/zones/<z>/pois/<id>/):
 *                                       brief.json, handoff.json, ops.json, world-ops.json, operators.json, clearings.json,
 *                                       encounter-clearings.json, dressing/<poi>-<pocket>.json, views.json, prop-requests.json,
 *                                       progress.json, reports/plan.json. Never writes the world or the scene.
 *     props                             the LAYOUT's hero-prop sheet: every <job>/layout.json piece rendered (soft renderer, no
 *                                       browser) with its id, its element's `shows` and its catalogued size -> reports/layout-props.png
 *                                       + a line per piece (size-band WARN); look at it before spending a chain
 *     approach                          re-plan the APPROACH only on the recorded site (no site search): the carved + painted
 *                                       track (worldgen road, road-pb-<id>-approach in world-ops.json), its route, lanes and
 *                                       keep-clear; structures, walls and dressing plans kept. Then lab -> build -> gates -> install.
 *     dress                             re-lay the DRESSING only (vignettes by pocket role, from the live plans; quest objects kept)
 *     lab    [--lab <name>]             (re)make the lab project projects/<lab>/ (default pb-<id>) from the LIVE world + scene,
 *                                       the place's own entities and features taken out
 *     build  [--lab <name>]             apply the job to the lab (scene ops, pads, operators + wall bakes, clearings, sockets,
 *                                       dressing plans): the same code path as `install`
 *     gates  [--lab <name> | --live] [--only a,b]  every install gate on the lab (--live: on the live world after install) -> <job>/reports/*.json + reports/gates.json (table)
 *     shots  [--lab <name>] [--port 5291] [--shots-timeout 15]  (hard cap, minutes) play-mode pictures from views.json at hours 12 and 20 -> <job>/evidence/
 *     all    [--archetype a] [--set ..] [--port p]   plan -> lab -> build -> gates -> shots
 *     evidence                          record progress.json evidence.readShot (+ viewpoints) from pictures already taken
 *                                       (shots does it itself; job.mjs refuses any stage past blockout without it)
 *     install [--dry-run] [--uninstall] [--target-world <w>]   the LIVE world + scene (coordinator; refused without a fresh
 *                                       reviewer's PASS: job.mjs requireFinalReview). Idempotent: whatever this place had is
 *                                       removed first (entities tagged poi:<id>, features pb-<id>-*, clearings owned by <id>),
 *                                       so a re-install never keeps a stale piece; --uninstall removes only.
 *   node node_modules/tsx/dist/cli.mjs tools/place-build.mts lift <plan|gate|install|uninstall> <world> --zone <z> --location <poi> --lift <id> ...
 *                                       a winch LIFT (structure kind) beside a long descent: tools/_place-lift.mts
 *   node node_modules/tsx/dist/cli.mjs tools/place-build.mts bridge <world> --zone <z> --location <id> [--spec <file>]
 *                                       a BRIDGE place (structure kind, tools/_place-bridge.mts): <job>/bridge.json { bridge, roads,
 *                                       views } -> the job files (one built landmark operator, the gate passage patch, carved +
 *                                       painted roads pinned flush to the deck ends, routes, views); then lab -> build -> gates -> shots
 *   node node_modules/tsx/dist/cli.mjs tools/place-build.mts quality <world> --zone <z> [--shots] [--only a,b] [--port p]
 *                                       every installed place-build place of the zone graded in the LIVE world (core
 *                                       footprint, props / 100 m2, cliff-tile walls, read px) -> <zone>/reports/poi-quality.md;
 *                                       --shots first re-takes core-close / aerial-150 / the read view at noon (one browser run)
 *
 * Heavy (world field, bakes, server boots, a browser): run each command inside the machine's heavy-job lock.
 * Loose props are never placed by transform: each pocket's first dressing plan names props (dress check/apply resolve
 * them on the socket map); a Sonnet dresser may refine the plan files in the job's dressing/ folder.
 */
import fs from "node:fs";
import { readableReportFile } from "./_dress-report.mts";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { runCapped, shotsCapMs } from "./_run-capped.mts";
import { seatPlaced } from "./float.mts";
import { skinPlacedOps } from "./rock-skins.mts";
import { applyOps, applyRecipeEdits, ComponentRegistry, createWorldField, registerChunkComponents, registerCoreComponents, worldRecipeSchema } from "@hitreg/core";
import { assetIds, findAsset, PROJECTS } from "./_closure.mjs";
import {
  applySets, silhouetteHeight, SILHOUETTE_RATIO, arrangeFirstPlan, DENIED_PROPS, approachLines, burnsAtDusk, forTier, newZfightClusters, approachReadAny, fillOk, installGuard, RESEAT_MAX_M, routeOnRibbon, hull, readBand, pickArchetype, roomFill, placeArchetypeSchema, planPlace, primitiveMeshes, siteSearch, staleEntities, unclearedStructures, uniqueItemIds, usableArea, type PlaceArchetype, type PlaceGround, type PlaceTier, type SiteBlockers, type SiteChoice,
  ribbonApproachOps, approachForBuilt, trackId, trimTrack, TRACK_CUT_M, TRACK_FILL_M, type ApproachTrack, type PlacePlan,
  fillerFor, requestedShortfall, type PlanDrop, placeLayoutSchema, withLayout, layoutCoverage, layoutSizeWarn, type PlaceLayout,
} from "./_place-archetype.mts";
import os from "node:os";
import { baseGap, lowerPatch, planBridge } from "./_place-bridge.mts";
import { baseOutline, coverClearedShare, scaleBase, seatGap, SEAT_GAP_M, type BaseOutline } from "./_place-quality.mts";
import { prefabGeometry, projectedTexels, texelDensity } from "./_prop-geometry.mts";
import { CLASS_FOOTPRINT_M, gradeScore, heightForPx, POCKET_FLOOR_M, READ_PX_MIN, readPixels, spanOf, wearsCliffTile, type QualityRow, type Tier } from "./_place-quality.mts";
// @ts-ignore untyped engine tool module
import { designFaults, requireFinalReview, setStage } from "../../../tools/poi-review/job.mjs";
// @ts-ignore untyped engine tool module
import { tierFor } from "../../../tools/poi-review/size-tiers.mjs";
import { builtStoneSet, zonePalette } from "./_zone-palette.mts";
import {propPolicy} from './_prop-curation.mts';

type V2 = [number, number];
const argv = process.argv.slice(2), cmd = argv[0], world = argv[1] ?? "";
const opt = (n: string) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : undefined; };
const opts = (n: string) => argv.flatMap((a, i) => (a === `--${n}` && argv[i + 1] ? [argv[i + 1]!] : []));
const has = (n: string) => argv.includes(`--${n}`);
const read = (f: string) => JSON.parse(fs.readFileSync(f, "utf8").replace(/^﻿/, ""));
const write = (f: string, v: unknown) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(v, null, 1) + "\n"); };
const fail = (why: string): never => { console.error(`STOP: ${why}`); process.exit(1); };
const ARCH_DIR = path.join(PROJECTS, "world-kit", "authoring", "place-archetypes");
const project = opt("project") ?? world, zone = opt("zone") ?? "", poi = opt("location") ?? "";
const JOB = path.join(PROJECTS, project, "authoring", "zonegen", world, "zones", zone, "pois", poi);
const ZONE = path.join(PROJECTS, project, "authoring", "zonegen", world, "zones", zone);
// `gates --live`: the same gates on the LIVE world + scene after an install (the place is in it; float/scatter-float then
// compare live with itself, so they report only the absolute verdict of the tools run)
const LIVE = has("live") && cmd === "gates";
const lab = LIVE ? project : opt("lab") ?? `pb-${poi}`, labWorld = LIVE ? world : `pb${poi.replace(/[^a-z0-9]/gi, "")}`;
const TSX = ["--max-old-space-size=6144", "node_modules/tsx/dist/cli.mjs"];
const PREFIX = `pb-${poi}-`;

function archetypes(): { raw: any; a: PlaceArchetype }[] {
  return fs.readdirSync(ARCH_DIR).filter((f) => f.endsWith(".json")).sort().map((f) => { const raw = read(path.join(ARCH_DIR, f)); return { raw, a: placeArchetypeSchema.parse(raw) }; });
}
/** Run a tool; its output goes to <job>/reports/<label>.log (overwritten). */
function tool(label: string, args: string[], node = false) {
  const t0 = Date.now();
  const r = spawnSync(process.execPath, node ? args : [...TSX, ...args], { encoding: "utf8", maxBuffer: 256 << 20 });
  fs.mkdirSync(path.join(JOB, "reports"), { recursive: true });
  fs.writeFileSync(path.join(JOB, "reports", `${label}.log`), `$ ${args.join(" ")}\n${r.stdout ?? ""}\n${r.stderr ?? ""}`);
  return { status: r.status ?? 1, out: `${r.stdout ?? ""}${r.stderr ?? ""}`, s: Math.round((Date.now() - t0) / 1000) };
}
async function toolTimed(label: string, ms: number, args: string[]) {
  const r = await runCapped([...TSX, ...args], ms);
  fs.mkdirSync(path.join(JOB, "reports"), { recursive: true });
  fs.writeFileSync(path.join(JOB, "reports", `${label}.log`), `$ ${args.join(" ")}\n${r.out}`);
  return r;
}
/** Every feature list entry this place owns (ids pb-<poi>-*, op:pb-<poi>-*, clearings owned by <poi>). */
const ownsFeature = (f: any) => typeof f?.id === "string" && (f.id.startsWith(PREFIX) || f.id.startsWith(`op:${PREFIX}`) || f.id.startsWith(`road-${PREFIX}`) || f.id.startsWith(`bridge-road-${PREFIX}`) || (f.owner === poi && f.id.startsWith(`${poi}-`)));
/** The world's roads, paths and trails an approach track may start on (other places' own tracks left out: a re-plan of
 *  one place never strands another's join). */
const existingRoads = (recipe: any) => ((recipe.features?.roads ?? []) as any[]).filter((r) => typeof r.id === "string" && !r.id.startsWith("road-pb-") && (r.points ?? []).length >= 2)
  .map((r) => ({ id: r.id as string, points: (r.points as number[][]).map((q) => (q.length >= 3 ? [q[0]!, q[2]!] : [q[0]!, q[1]!]) as V2) }));
/** L (owner ruling 2026-10-20, no ribbon roads): the approach TRACK graded by the world's own road machinery
 *  (`worldgen road`: roadFrom's solved profile, shoulder, embankment band and painted tread; dry run on the ground the
 *  plan measured, this place left out) into recipe edits for world-ops.json (road-pb-<id>-approach[.n] + any bridge). */
// L (fowlers-drop 2026-10-21): a track is NO obstacle to sea cliffs or buttes (--keep-landforms): a plain road on a sea-cliff
// top made the cliff generator clear round it and the whole headland fell from 130 m to 10 m (the tower baked 150 m tall)
function gradeTrack(recipe: any, t: ApproachTrack | null): any[] {
  if (!t) return [];
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), `pb-track-${poi}-`)), rf = path.join(tmp, "recipe.json"), out = path.join(tmp, "built.json");
  try {
    fs.writeFileSync(rf, JSON.stringify(recipe));
    const r = tool("track", ["tools/worldgen.mts", "road", world, "--recipe", rf, "--id", t.id, "--points", t.points.map((q) => `${q[0]},${q[1]}`).join(";"), "--width", String(t.width),
      "--max-grade", String(t.maxGrade), "--max-cut", String(TRACK_CUT_M), "--max-fill", String(TRACK_FILL_M), "--tread-cut", String(TRACK_CUT_M), "--tread-fill", String(TRACK_FILL_M), "--keep-landforms", "--dry-run", "--out", out]);
    if (r.status || !fs.existsSync(out)) fail(`approach track ${t.id}: worldgen road failed (reports/track.log): ${r.out.trim().split("\n").slice(-2).join(" | ")}`);
    const built = read(out) as { roads: any[]; bridges: any[] };
    console.log(`  TRACK: ${r.out.split("\n").find((l) => l.includes(`${t.id}:`))?.trim() ?? t.id}`);
    return [...built.roads.map((f) => ({ edit: "add-feature", kind: "roads", feature: f })), ...built.bridges.map((f) => ({ edit: "add-feature", kind: "bridges", feature: f }))];
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
}
function withoutPlace(w: any) { const features: any = {}; for (const [k, v] of Object.entries(w.features ?? {})) features[k] = Array.isArray(v) ? v.filter((f) => !ownsFeature(f)) : v; return { ...w, features }; }
/** A prop's catalogue dressing declaration (the prefab root's `dressing` component), for the plan's culture checks. */
const propInfoCache = new Map<string, { cultures?: string[]; height?: number; size?: number[] } | null>();
let placementPolicy:ReturnType<typeof propPolicy>|undefined;
function propInfo(prefab: string): { cultures?: string[]; height?: number; size?: number[] } | null {
  (placementPolicy??=propPolicy(PROJECTS,project)).assertAllowed(prefab);
  if (!propInfoCache.has(prefab)) { const f = findAsset(project, `prefabs/${prefab}.json`); let d: any = null;
    try { const j = f ? read(f) : null; d = Object.values(j?.entities ?? {}).map((e: any) => e?.components?.dressing).find(Boolean) ?? null; } catch {}
    propInfoCache.set(prefab, d ? { cultures: d.cultures, height: Array.isArray(d.size) ? d.size[1] : undefined, size: Array.isArray(d.size) ? d.size : undefined } : null); }
  return propInfoCache.get(prefab)!;
}
/** A catalogued piece's texel density (median tx/m), for the scale floor (cached). */
const texCache2 = new Map<string, number | null>();
function texelsOf(prefab: string): number | null {
  if (!texCache2.has(prefab)) { let v: number | null = null; try { const A = path.join(PROJECTS, project, "assets"); v = texelDensity(prefabGeometry(A, prefab), { projected: projectedTexels(A) }).median || null; } catch { v = null; } texCache2.set(prefab, v); }
  return texCache2.get(prefab)!;
}
/** Highest mesh surface of a catalogued piece over a local point (prefab frame), for a piece set `on` it. */
function topOf(prefab: string, x: number, z: number): number | null {
  let tris: any[]; try { tris = prefabGeometry(path.join(PROJECTS, project, "assets"), prefab).tris; } catch { return null; }
  let best: number | null = null;
  for (const t of tris) { const [a, b, c] = [t.a, t.b, t.c]; const d = (b[2] - c[2]) * (a[0] - c[0]) + (c[0] - b[0]) * (a[2] - c[2]); if (Math.abs(d) < 1e-9) continue;
    const l1 = ((b[2] - c[2]) * (x - c[0]) + (c[0] - b[0]) * (z - c[2])) / d, l2 = ((c[2] - a[2]) * (x - c[0]) + (a[0] - c[0]) * (z - c[2])) / d, l3 = 1 - l1 - l2;
    if (l1 < 0 || l2 < 0 || l3 < 0) continue; const y = l1 * a[1] + l2 * b[1] + l3 * c[1]; if (best === null || y > best) best = y; }
  return best;
}
/** A catalogued piece's height (its declared dressing size), for the silhouette rule (withBeacon). */
const heightOf = (prefab: string): number | null => (propInfo(prefab) as any)?.height ?? null;
/** What a pocket may not stand on (site search): the road corridor (half width + shoulder + 3 m), other POIs' discs
 *  (world `pois` features) and the scene's placed things that are not this place's (root entities with a prefab or
 *  children: 5 m; another place's root: 20 m). The approach lines themselves are roads too (+3 m). */
function siteBlockers(recipe: any, approaches: V2[][]): SiteBlockers {
  const segs: SiteBlockers["segs"] = [], discs: SiteBlockers["discs"] = [];
  for (const r of recipe.features?.roads ?? []) { const w = (r.width ?? 3.4) / 2 + (typeof r.shoulder === "number" ? r.shoulder : 1) + 3; for (let i = 0; i + 1 < (r.points ?? []).length; i++) segs.push([r.points[i], r.points[i + 1], w]); }
  for (const l of approaches) for (let i = 0; i + 1 < l.length; i++) segs.push([l[i]!, l[i + 1]!, 4.5]);
  for (const f of recipe.features?.pois ?? []) if (f.position && !String(f.id).includes(poi)) discs.push({ at: [f.position[0], f.position[2]], r: Math.min(60, f.radius ?? 20) });
  try {
    const s = read(sceneFile(project, world)), kids = new Set(Object.values(s.entities).map((e: any) => e.parent).filter(Boolean));
    for (const [id, e] of Object.entries(s.entities) as any) {
      const pos = e.components?.transform?.position; if (e.parent || !pos || (pos[0] === 0 && pos[2] === 0) || (e.tags ?? []).includes(`poi:${poi}`) || id.startsWith(`dress-${poi}-`) || (e.tags ?? []).includes("populate")) continue;
      if (e.components?.voxelWorld) continue;
      if ((e.tags ?? []).includes("poi")) discs.push({ at: [pos[0], pos[2]], r: 20 }); else if (e.components?.prefab || kids.has(id)) discs.push({ at: [pos[0], pos[2]], r: 5 });
    }
  } catch { /* no scene: roads and pois only */ }
  return { segs, discs };
}
/** null when the plan's socket map (projects/<p>/authoring/dressing/sockets/<id>.json) has open floor (or none was
 *  measured); else why not ("0 m2 open of the area"). */
function noFloor(p: string, id: string): string | null {
  const f = path.join(PROJECTS, p, "authoring", "dressing", "sockets", `${id}.json`); if (!fs.existsSync(f)) return null;
  try { const rooms = (read(f).levels ?? []).flatMap((l: any) => l.rooms ?? []); return rooms.length && rooms.every((r: any) => !(r.area > 0)) ? "0 m2 open of the area" : null; } catch { return null; }
}
/** A structure prefab's base outline from its triangles (cached): the planner seats on it, the seated gate measures it. */
const baseCache = new Map<string, BaseOutline | null>();
function structureBase(prefab: string): BaseOutline | null {
  if (!baseCache.has(prefab)) { let b: BaseOutline | null = null; try { b = baseOutline(prefabGeometry(path.join(PROJECTS, project, "assets"), prefab).tris); } catch { b = null; } baseCache.set(prefab, b); }
  return baseCache.get(prefab)!;
}
const siteRecord =(s: SiteChoice | null) => (s ? { at: s.at, pockets: s.pockets, moved: s.moved, estUsableM2: s.areaM2, padRelief: s.relief, why: s.why, ...(s.read ? { read: s.read } : {}) } : null);
function ground(recipe: any): PlaceGround { const f = createWorldField(worldRecipeSchema.parse(recipe)); return { height: (x, z) => f.height(x, z), wet: (x, z) => f.waterY(x, z) !== null, waterY: (x, z) => f.waterY(x, z) }; }
const worldFile = (p: string, w: string) => path.join(PROJECTS, p, "assets", "worlds", `${w}.json`);
const sceneFile = (p: string, w: string) => path.join(PROJECTS, p, "assets", "scenes", `${w}.scene.json`);

// ---------------------------------------------------------------------------------------------------------------------
/** `approach`: re-plan the approach only (owner ruling 2026-10-20: the approach becomes a carved + painted track). */
let approachOnly = false;
/** APPROACH ONLY: the place planned again on its RECORDED site, pockets and tier (no site search, no tier change) and only
 *  its approach taken from that plan: the approach ribbon operator out, the graded track (road-pb-<id>-approach) into
 *  world-ops.json, the approach route, its lane clearings, keep-clear lines and network line replaced. Structures, walls,
 *  pocket footpaths and the dressing plans stay as built and reviewed. Refused when the re-plan does not land on the
 *  recorded core (> 0.5 m). */
function spliceApproach(recipe: any, g: PlaceGround, approaches: V2[][]) {
  const J = (f: string) => path.join(JOB, f), old = read(J("reports/plan.json")), brief = read(J("brief.json"));
  const operators = read(J("operators.json")) as any[], worldOps = read(J("world-ops.json")) as any[], clearings = read(J("clearings.json")) as any[], hand = read(J("handoff.json"));
  const a = placeArchetypeSchema.parse(applySets(archetypes().find((x) => x.a.id === brief.archetype)?.raw ?? fail(`no archetype ${brief.archetype}`), brief.sets ?? []));
  const oldRoute = (hand.navigation?.routes ?? []).find((r: any) => r.id === "approach"), last = oldRoute?.points?.[oldRoute.points.length - 1];
  const core = { at: old.centre as V2, radius: forTier(a, brief.adventureSize, heightOf).pockets[0]!.radius };
  const built = approachForBuilt(g, {
    poi, size: brief.adventureSize, core, stand: last ? [last[0], last[2]] : core.at, maxGrade: a.route.maxGrade,
    solids: (hand.siteDressing?.keepClear ?? []).filter((k: any) => String(k.why).startsWith("structure") && k.at).map((k: any) => ({ at: k.at as V2, r: k.radius ?? 1 })),
    walls: operators.filter((o) => o.op === "wall"), approaches, roads: existingRoads(recipe),
  });
  if (!built.route) fail(`approach: ${built.faults.join("; ")}`);
  const ribbon = operators.find((o) => ribbonApproachOps([o]).length), oldTrack = (hand.siteDressing?.keepClear ?? []).find((k: any) => k.id === "track-approach")?.points;
  const ownTrack = (id: unknown) => typeof id === "string" && (id.startsWith(`road-${PREFIX}`) || id.startsWith(`bridge-road-${PREFIX}`));
  const lanes = new Set([`${poi}-lane-approach`, `${poi}-lane-cover-approach`]), same = (l: any, m: any) => !!m && JSON.stringify(l) === JSON.stringify(m);
  write(J("operators.json"), operators.filter((o) => !ribbonApproachOps([o]).length));
  write(J("world-ops.json"), [...worldOps.filter((o) => !ownTrack(o.feature?.id) && !ribbonApproachOps([], [o]).length), ...gradeTrack(recipe, built.track)]);
  write(J("clearings.json"), [...clearings.filter((c) => !lanes.has(c.id)), ...built.clearings]);
  const i = hand.navigation.routes.findIndex((r: any) => r.id === "approach");
  if (i >= 0) hand.navigation.routes[i] = built.route; else hand.navigation.routes.unshift(built.route);
  hand.navigation.network = [...(built.track ? [built.track.points] : []), ...(hand.navigation.network ?? []).filter((l: any) => !same(l, ribbon?.points) && !same(l, oldTrack))];
  hand.siteDressing.keepClear = [...(hand.siteDressing.keepClear as any[]).filter((k) => k.id !== "route-approach" && k.id !== "track-approach" && !(k.why === "footpath" && same(k.points, ribbon?.points))), ...built.keepClear];
  hand.approachTrack = built.track ? { id: built.track.id, width: built.track.width, from: built.track.from, lengthM: built.track.lengthM } : null;
  write(J("handoff.json"), hand); write(J("walk-route.json"), hand.navigation.routes[0]);
  write(J("reports/plan.json"), { ...old, approach: { at: new Date().toISOString(), why: "approach re-planned only (place-build approach) round the place as built: carved + painted track, the ribbon removed", track: hand.approachTrack, removed: ribbon?.id ?? null, notes: built.notes } });
  console.log(`approach ${poi}: ${ribbon ? `ribbon ${ribbon.id} removed, ` : ""}${built.track ? `track ${built.track.id} ${built.track.width} m x ${built.track.lengthM} m from ${built.track.from}` : "no track"}; planned round the place as built`);
  for (const n of built.notes) console.log(`  NOTE: ${n}`);
}
/** DRESSING ONLY: every dressing plan of the place as built laid out again in VIGNETTES (arrangeFirstPlan by the pocket's
 *  role and structures), no site search, no other job file touched. The base is the project's LIVE plan when there is one
 *  (newer than the job copy: prop swaps and quest-object changes made after the install), else the job copy; quest objects
 *  and graves in rows keep their places, denied pieces leave, item ids are kept. Then lab -> build (its dress loop tops
 *  up / trims to the site density) -> gates -> install. L (PLACES-FIX 2026-10-21: 26 installed places failed
 *  site-dense / site-spread / site-clutter: "clutter in a small area, not designed"). */
function redress() {
  const brief = read(path.join(JOB, "brief.json")), arch = archetypes().find((x) => x.a.id === brief.archetype) ?? fail(`no archetype ${brief.archetype}`);
  const a = forTier(placeArchetypeSchema.parse(applySets(arch.raw, brief.sets ?? [])), brief.adventureSize, heightOf);
  const live = path.join(PROJECTS, project, "authoring", "dressing", "plans"), dir = path.join(JOB, "dressing");
  const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith(".json") && !/\.(report|inverse|walk|owner)\.json$/.test(f)) : [];
  if (!files.length) fail(`${poi}: no dressing plans in ${dir}`);
  for (const f of files) {
    const fromLive = fs.existsSync(path.join(live, f)), doc = read(fromLive ? path.join(live, f) : path.join(dir, f));
    const room = Object.keys(doc.rooms ?? {})[0] ?? fail(`${f}: no room`), role = doc.rooms[room].role ?? "yard";
    const pocket = a.pockets.find((k) => k.id === room), dropped: string[] = [];
    const items = (doc.items as any[]).filter((it) => { if (!it.quest && DENIED_PROPS[it.prop]) { dropped.push(`${it.id} (${it.prop}: ${DENIED_PROPS[it.prop]})`); return false; } return true; })
      .map((it) => (doc.arrangements?.length || it.quest || it.place?.prefer === "row" || it.place?.kind !== "auto" ? it : { ...it, place: { kind: "auto", room: it.place?.room ?? room, prefer: /^rock-kit\//.test(it.prop) ? "open" : it.place?.prefer ?? "open" } }));
    // the made pieces first (they fill the vignettes), natural fill after (it stays loose)
    const ordered = [...items.filter((it) => !/^rock-kit\//.test(it.prop)), ...items.filter((it) => /^rock-kit\//.test(it.prop))];
    // a plan already laid out in vignettes (a dresser's) is kept as it is, its denied pieces out
    const laid = doc.arrangements?.length ? { items, arrangements: doc.arrangements } : arrangeFirstPlan(ordered, role, room, pocket?.structures ?? [], room);
    const out: any = { ...doc, items: uniqueItemIds(laid.items) };
    if (laid.arrangements.length) out.arrangements = laid.arrangements; else delete out.arrangements;
    write(path.join(dir, f), out);
    const vig = laid.arrangements.map((v: any) => `${v.kind}${v.anchor ? `@${v.anchor}` : ""}(${laid.items.filter((it: any) => it.place?.arrangement === v.id).length})`).join(" ") || "none";
    console.log(`dress ${f.replace(/\.json$/, "")}: ${fromLive ? "live" : "job"} plan${doc.arrangements?.length ? " (laid out already: kept)" : ""}, ${out.items.length} items, vignettes ${vig}${dropped.length ? `; dropped ${dropped.join(", ")}` : ""}`);
  }
}
/** L (PLACES-FIX 2026-10-21): a re-plan of an INSTALLED place keeps what was decided on its live plans since: a quest
 *  object's prop (a Codex stand-in swap: the gibbet cage, the kelp pit) and the named pieces a dresser or a prop round added
 *  that the archetype does not list (net frames, a tar boiler, a coffin bier). Denied pieces, boulders and top-up fill are
 *  not carried (the density loop re-tops). The merged plan is laid out again in vignettes. */
function carryLive(d: any, pocket: { id: string; structures: { id: string; role: string }[] } | undefined, questOnly = false): { doc: any; carried: string[] } {
  const f = path.join(PROJECTS, project, "authoring", "dressing", "plans", `${d.id}.json`);
  if (!fs.existsSync(f)) return { doc: d, carried: [] };
  const live = read(f), room = Object.keys(d.rooms ?? {})[0] ?? "core", role = d.rooms?.[room]?.role ?? "yard", carried: string[] = [];
  const items = (d.items as any[]).map((it) => { const q = it.quest?.entity && (live.items as any[]).find((x) => x.quest?.entity === it.quest.entity);
    if (q && q.prop !== it.prop && !DENIED_PROPS[q.prop]) { carried.push(`${it.id} -> ${q.prop} (quest)`); return { ...it, prop: q.prop }; } return it; });
  const have = new Set(items.map((it) => it.prop));
  for (const x of live.items as any[]) {
    if (questOnly || x.quest || have.has(x.prop) || DENIED_PROPS[x.prop] || /^rock-kit\//.test(x.prop) || /^fill-/.test(x.id) || x.place?.prefer === "row") continue;
    items.push({ id: x.id, prop: x.prop, place: { kind: "auto", room, prefer: "open" } }); carried.push(`${x.id} ${x.prop}`);
  }
  if (!carried.length) return { doc: d, carried };
  const ordered = [...items.filter((it) => !/^rock-kit\//.test(it.prop)), ...items.filter((it) => /^rock-kit\//.test(it.prop))]
    .map((it) => (it.quest || it.place?.prefer === "row" ? it : { ...it, place: { kind: "auto", room, prefer: /^rock-kit\//.test(it.prop) ? "open" : it.place?.prefer ?? "open" } }));
  const laid = arrangeFirstPlan(ordered, role, room, pocket?.structures ?? [], room), doc = { ...d, items: laid.items };
  if (laid.arrangements.length) doc.arrangements = laid.arrangements; else delete doc.arrangements;
  return { doc, carried };
}
function plan() {
  const brief = read(path.join(ZONE, "brief.json")), place = (brief.places ?? []).find((p: any) => p.id === poi) ?? fail(`no place ${poi} in ${ZONE}/brief.json`);
  const res = (read(path.join(ZONE, "reservations.json")).reservations ?? []).find((r: any) => r.location === poi) ?? fail(`no reservation for ${poi}`);
  const prior = fs.existsSync(path.join(JOB, "brief.json")) ? read(path.join(JOB, "brief.json")) : {};
  const all = archetypes(), want = opt("archetype") ?? prior.archetype;
  const pick = want ? all.find((x) => x.a.id === want) ?? fail(`no archetype ${want} (${all.map((x) => x.a.id).join(", ")})`) : all.find((x) => x.a.id === pickArchetype(place, all.map((y) => y.a))?.id) ?? fail(`no archetype fits ${poi}: pass --archetype`);
  const setList = has("set") ? opts("set") : prior.sets ?? [];
  // --at x,z PINS the core (the site search then only refines within 14 m); kept in brief.json. `--at auto` clears a pin.
  // Without a pin the SITE SEARCH chooses the core and every pocket (siteSearch: the flattest connected layout in 1.5 x
  // the reserved disc); its choice is recorded in brief.json `site` and reports/plan.json, never pinned.
  // L (TOOLS-LAYOUT 2026-10-24): <job>/layout.json is the owner's composition (placeLayoutSchema, docs/place-builder.md "Layout")
  const lf = path.join(JOB, "layout.json"), lp = fs.existsSync(lf) ? placeLayoutSchema.safeParse(read(lf)) : null;
  if (lp && !lp.success) fail(`${lf}: ${lp.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
  const layout: PlaceLayout | null = lp?.success ? lp.data : null;
  const atArg = opt("at"), pinned = (layout?.origin ?? (atArg === "auto" ? null : atArg?.split(",").map(Number) ?? prior.at ?? null)) as V2 | null;
  const at = (pinned ?? place.site?.at ?? res.center) as V2;
  // L (ravenstacks 2026-10-21: a pinned core 42 m from the OTHER approach's end turned the castle's gate to the sea):
  // --faces N|NE|E|..|auto names the front of a pinned site (kept in brief.json); unpinned, the brief's site.faces
  const facesArg = opt("faces"), faces = (facesArg === "auto" ? undefined : facesArg ?? prior.faces ?? (pinned ? undefined : place.site?.faces)) as string | undefined;
  if (faces && !/^(NE|NW|SE|SW|N|S|E|W)(?![a-z])/i.test(faces.trim())) fail(`--faces ${faces}: a compass point (N, NE, E, SE, S, SW, W, NW) or auto`);
  const a = placeArchetypeSchema.parse(applySets(pick.raw, setList));
  // L: man-made = catalogued pieces: every prefab must resolve in the world's closure
  const missing = [...a.pockets.flatMap((p) => [...p.structures.map((s) => s.prefab), ...(p.dressing?.props ?? []).map((q) => q.prop)]), ...(a.ring?.props ?? []).map((q) => q.prop), ...Object.values(a.quest)].filter((id) => !findAsset(project, `prefabs/${id}.json`));
  if (missing.length) fail(`not catalogued in ${project}'s closure: ${[...new Set(missing)].join(", ")}`);
  // L (art, Hagsheer 2026-10-21): walls take the zone's BUILT stone (role materials at the town texel standard), never the
  // terrain cliff tile: <zone>/place-build.json { builtStone: { face, cap, footing, ... } }
  const zdf = path.join(ZONE, "place-build.json"), builtStone: Record<string, string> | undefined = fs.existsSync(zdf) ? read(zdf).builtStone : undefined;
  const noMat = Object.values(builtStone ?? {}).filter((m) => !findAsset(project, `materials/${m}.json`));
  if (noMat.length) fail(`zone builtStone materials not in ${project}'s closure: ${noMat.join(", ")} (${zdf})`);
  // built wall kinds (curtain, tower, keep, gatehouse) take <zone>/place-build.json builtKinds[kind] when their archetype names no materials
  const builtKinds: Record<string, Record<string, string | string[]>> | undefined = fs.existsSync(zdf) ? Object.fromEntries(Object.entries(read(zdf).builtKinds ?? {}).filter(([k]) => k !== "about")) as any : undefined;
  const noKindMat = Object.values(builtKinds ?? {}).flatMap((r) => Object.values(r).flat()).filter((m) => !findAsset(project, `materials/${m}.json`));
  if (noKindMat.length) fail(`zone builtKinds materials not in ${project}'s closure: ${[...new Set(noKindMat)].join(", ")} (${zdf})`);
  const t0 = Date.now();
  const recipe = withoutPlace(read(worldFile(project, world))), g = ground(recipe);
  // ONE palette per role per zone (recipe regions[].palette.builtStone): the zone defaults may not name a stone outside it
  const zpal = zonePalette(recipe, zone);
  if (zpal && Object.keys(zpal.builtStone).length) {
    const okStone = builtStoneSet(zpal);
    // only the built kinds this archetype can build at the brief's tier or the ones a downgrade takes it to (its silhouette
    // tower included) are this place's to answer for (RETTING 2026-10-23: a pits place with no tower, keep or gatehouse was
    // refused for the zone's keep stone)
    const tiers = ["pinpoint", "small", "medium", "large"] as PlaceTier[], upTo = tiers.indexOf((place.size ?? "large") as PlaceTier);
    const kinds = new Set(tiers.slice(0, upTo < 0 ? 4 : upTo + 1).flatMap((t) => forTier(a, t, heightOf).pockets.flatMap((p) => p.walls.map((w) => w.kind))));
    const off = [...new Set([...Object.values(builtStone ?? {}), ...Object.entries(builtKinds ?? {}).filter(([k]) => kinds.has(k as never)).flatMap(([, r]) => Object.values(r).flat())].filter((m) => !okStone.has(m as string)))];
    if (off.length && !has("allow-off-palette")) fail(`zone ${zone} builtStone REFUSED: ${off.join(", ")} not in regions[].palette.builtStone (${[...okStone].join(", ")}); --allow-off-palette with a ruling`);
  }
  // L (approach): a reservation approach that names only its `from` is resolved from the world (approachLines)
  const apr = approachLines(recipe, read(path.join(ZONE, "reservations.json")).reservations ?? [], res), approaches = apr.lines;
  if (apr.resolved.length) console.log(`  APPROACH: resolved from the world (the reservation had no points): ${apr.resolved.join(", ")}`);
  if (apr.unresolved.length) console.log(`  FIT: approach from ${apr.unresolved.join(", ")}: no road, river, town, POI, region or reservation of that id`);
  const blockers = siteBlockers(recipe, approaches);
  if (approachOnly) return spliceApproach(recipe, g, approaches); // the approach only, round the place as built
  // the brief's words drive row counts and ring switches (expandRows, ring.when); its people (place.culture) the fill
  const briefText = [place.read, place.landmark, ...(place.features ?? [])].filter(Boolean).join(" ");
  const culture = place.culture ? ([] as string[]).concat(place.culture) : null;
  const waters = ((recipe.features?.lakes ?? []) as any[]).filter((l) => Array.isArray(l.center) && Number.isFinite(l.radius) && Number.isFinite(l.waterY)).map((l) => ({ id: l.id, center: l.center as V2, radius: l.radius, waterY: l.waterY }));
  // the quest plan's objects at this place (kind object/readable): each becomes a core plan item via archetype `quest`
  const qf = path.join(ZONE, "quests.json"), questObjects = (fs.existsSync(qf) ? (read(qf).entities ?? []) as any[] : []).filter((e) => e.location === poi && (e.kind === "object" || e.kind === "readable")).map((e) => ({ id: e.id as string, kind: e.kind as string, what: e.what as string | undefined }));
  const roam = +(opt("roam") ?? 1.5), sites: Record<string, SiteChoice | null> = {};
  const planAt = (size: PlaceTier) => {
    const at0 = forTier(a, size, heightOf), at_ = layout ? withLayout(at0, layout, propInfo) : at0; // L (weepmouth 2026-10-21): a pinpoint is the core pocket only
    const base = { world, zone, project, place: { id: poi, name: place.name, size, at, faces, text: briefText, ...(culture ? { culture } : {}) }, reservation: { center: res.center, radius: res.radius, approaches }, propInfo, texelsOf, topOf, questObjects, waters, builtStone, builtKinds, structureBase, materialExists: (m: string) => !!findAsset(project, `materials/${m}.json`), ...(layout ? { layout, catalogued: (id: string) => !!findAsset(project, `prefabs/${id}.json`), surfaces: ((recipe.surfaces ?? []) as any[]).map((x) => x.name as string), surfaceColors: Object.fromEntries(((recipe.surfaces ?? []) as any[]).filter((x) => typeof x.color === "string").map((x) => [x.name as string, x.color as string])) } : {}), scatterRules: ((recipe.scatter ?? []) as any[]).map((s) => s.id as string), roads: existingRoads(recipe), kitBuildings: assetIds(project, "prefabs/wfc-ruins").size > 0 };
    const site = sites[size] = siteSearch(at_, base, g, { needM2: tierFor(size).minUsableAreaM2, roam, pinned, blockers, read: { band: readBand(size, a.read.band) } });
    const p = planPlace(at_, site ? { ...base, place: { ...base.place, at: site.at }, pocketAt: site.pockets } : base, g);
    const bcn = [...at_.pockets[0]!.structures, ...at_.pockets[0]!.walls].find((x) => x.id === "beacon");
    { const sh = silhouetteHeight(at_, size, heightOf); const lmH = Math.max(0, ...at_.pockets.flatMap((k) => [...k.structures.map((x) => x.landmark?.height ?? 0), ...k.walls.map((x) => x.landmark?.height ?? 0)]));
      p.notes.push(`SILHOUETTE: ${bcn ? ("prefab" in bcn ? `${bcn.prefab}${bcn.scale !== 1 ? ` x${bcn.scale}` : ""}` : `a ${bcn.kind} ${bcn.height} m`) : "the landmark"} ${lmH.toFixed(1)} m (floor ${sh.floor.toFixed(1)} m: ${READ_PX_MIN} px at ${readBand(size, a.read.band)[1]} m and ${SILHOUETTE_RATIO} x the tallest other piece ${sh.other.toFixed(1)} m)`);
      if (lmH < sh.floor - 0.05) p.faults.push(`SILHOUETTE: the landmark is ${lmH.toFixed(1)} m, under the floor ${sh.floor.toFixed(1)} m: name the place's own element (--set read.beacon={"structures":[...]}) or a taller one`); }
    for (const k of at_.pockets) if (k.fit !== undefined) p.notes.push(`pocket ${k.id}: spread to the ${size} floor, radius ${k.radius} m (fit and pad ${k.fit} m)`);
    if (!site) p.notes.push(`SITE: no level connected layout for a ${size} ${a.id} within ${pinned ? "14 m of --at" : `${roam} x the reserved disc`}: pockets fitted at the archetype's own offsets`);
    const reach = Math.max(...p.pockets.map((k) => Math.hypot(k.at[0] - p.centre[0], k.at[1] - p.centre[1]) + k.radius)) + 10; // what it builds (the site search may roam 1.5 x the disc)
    // measured inside the footprint hull (every pocket disc and route end), as the size gate compares it
    const rim = [...p.pockets.flatMap((k) => Array.from({ length: 12 }, (_, i) => [k.at[0] + k.radius * Math.cos((i * Math.PI) / 6), k.at[1] + k.radius * Math.sin((i * Math.PI) / 6)] as V2)), ...p.handoff.navigation.routes.flatMap((r: any) => r.points.map((q: number[]) => [q[0], q[2]] as V2))];
    p.handoff.measurements.measuredCombinedUsableAreaM2 = Math.round(usableArea(g, p.centre, reach, hull(rim), p.pockets.map((k) => k.at)));
    p.handoff.measurements.usableAreaMethod = "2 m cells, dry, slope <= 0.6, inside the footprint hull, flood-filled from the core and every pocket (each joined by a walked footpath; place-build plan, before the pads)";
    return p;
  };
  // L (size, coordinator ruling 2026-10-20): the ground decides the tier. When the reservation's ground cannot hold the
  // tier's usable area, the place is MEASURED and built one tier down (medium -> small); the downgrade and its reason go
  // into the job (brief.json adventureSize + tierDowngrade, handoff tierDowngrade, reports/size.json). size-tiers.mjs is
  // never loosened.
  const asked = place.size as PlaceTier;
  let size = asked, p = planAt(size), downgrade: any = null;
  for (const lower of ({ large: ["medium", "small"], medium: ["small"] } as Record<string, ("small" | "medium")[]>)[asked] ?? []) {
    const have = p.handoff.measurements.measuredCombinedUsableAreaM2;
    if (have >= tierFor(size).minUsableAreaM2) break;
    const first = downgrade?.from ?? asked, firstHave = downgrade?.measuredUsableAreaM2 ?? have;
    size = lower; p = planAt(size);
    downgrade = { from: first, to: size, measuredUsableAreaM2: firstHave, neededM2: tierFor(first).minUsableAreaM2,
      why: `the ground round the reservation holds ${firstHave} m2 of dry ground under 31 deg (flood-filled from every pocket); a ${first} place needs ${tierFor(first).minUsableAreaM2} m2, so it is built at the tier the ground supports` };
  }
  if (downgrade) { downgrade.after = p.handoff.measurements.measuredCombinedUsableAreaM2; p.handoff.measurements.adventureSize = size; p.handoff.tierDowngrade = downgrade; }
  // L (size, kelpmane-cove / weepmouth 2026-10-20): the lowest tier the builder makes still does not fit: the brief's size
  // is wrong for this ground. Reported for the zone master (pinpoint, or another site), never forced; the size gate stays red
  const have = p.handoff.measurements.measuredCombinedUsableAreaM2, need = tierFor(size).minUsableAreaM2;
  const zoneMaster = have < need ? { asked, built: size, measuredUsableAreaM2: have, neededM2: need, suggest: have >= tierFor("pinpoint").minUsableAreaM2 ? "pinpoint" : "another site",
    why: `the flattest connected layout the site search found in ${roam} x the reserved disc holds ${have} m2; a ${size} place needs ${need} m2: the zone master re-sizes the brief (pinpoint) or moves the reservation` } : null;
  p.handoff.zoneMaster = zoneMaster;
  fs.mkdirSync(path.join(JOB, "reports"), { recursive: true });
  if (zoneMaster) write(path.join(JOB, "reports", "zone-master.json"), zoneMaster); else fs.rmSync(path.join(JOB, "reports", "zone-master.json"), { force: true });
  fs.mkdirSync(JOB, { recursive: true });
  for (const f of fs.existsSync(path.join(JOB, "dressing")) ? fs.readdirSync(path.join(JOB, "dressing")) : []) fs.unlinkSync(path.join(JOB, "dressing", f)); // overwrite in place
  write(path.join(JOB, "brief.json"), { id: poi, name: place.name, adventureSize: size, ...(downgrade ? { tierDowngrade: downgrade } : {}), archetype: a.id, sets: setList, ...(pinned ? { at: pinned } : {}), ...(faces && faces !== place.site?.faces ? { faces } : {}), site: siteRecord(sites[size] ?? null), place });
  write(path.join(JOB, "handoff.json"), p.handoff);
  write(path.join(JOB, "ops.json"), p.ops);
  write(path.join(JOB, "world-ops.json"), [...p.worldOps, ...gradeTrack(recipe, p.track)]);
  write(path.join(JOB, "operators.json"), p.operators);
  write(path.join(JOB, "clearings.json"), [...p.clearings]);
  write(path.join(JOB, "encounter-clearings.json"), p.encounters);
  write(path.join(JOB, "prop-requests.json"), p.propRequests);
  // L (TOOLS-LAYOUT 3): coverage both ways, here (the catalogue is at hand): a design element made of catalogue props with no
  // piece, a piece naming no element
  if (layout) { const df = path.join(JOB, "design.json"); for (const f of layoutCoverage(fs.existsSync(df) ? read(df) : null, layout, { catalogued: (id) => !!findAsset(project, `prefabs/${id}.json`), questProps: Object.values(a.quest) })) p.faults.push(`LAYOUT: ${f}`); }
  const tierPockets = (layout ? withLayout(forTier(a, size, heightOf), layout, propInfo) : forTier(a, size, heightOf)).pockets;
  for (const d0 of p.plans) { const { doc: d, carried } = carryLive(d0, tierPockets.find((k) => d0.id === `${poi}-${k.id}`), !!layout); if (carried.length) p.notes.push(`${d.id}: carried from the live plan: ${carried.join(", ")}`); write(path.join(JOB, "dressing", `${d.id}.json`), { ...d, items: uniqueItemIds(d.items) }); }
  const views = [...p.handoff.viewpoints, { name: "aerial-150", x: p.aerial[0], z: p.aerial[1], facing: Math.round(((Math.atan2(-p.front[0], p.front[1]) * 180) / Math.PI + 360) % 360), pitch: 0.6, distance: 150 }];
  // L (HERO-BRIDGE discipline, LANDMARKS 2026-10-21): <job>/contract.json { idea, mustRead[], views[] } is written by the
  // owner BEFORE the grey box; its fixed cameras (camera + target, light-shots' contract shot list) ride every plan's views
  const cf = path.join(JOB, "contract.json"), contract = fs.existsSync(cf) ? read(cf) : null;
  const cviews = ((contract?.views ?? []) as any[]).filter((v) => Array.isArray(v.camera) && Array.isArray(v.target));
  if (contract && cviews.length !== (contract.views ?? []).length) fail(`${cf}: every contract view needs camera [x,y,z] and target [x,y,z]`);
  // L (TOOLS-PB 2026-10-23): the design's own cameras (archetype `views`, `--set views=[...]`, place frame) ride the same way
  const setViews = (p.setViews ?? []).filter((v: any) => !cviews.some((c) => c.name === v.name));
  write(path.join(JOB, "views.json"), [...views.filter((v) => !cviews.some((c) => c.name === v.name) && !setViews.some((c: any) => c.name === v.name)), ...setViews, ...cviews.map((v) => ({ name: v.name, x: v.x ?? v.camera[0], z: v.z ?? v.camera[2], y: v.y ?? Math.round((v.camera[1] - 1.7) * 10) / 10, camera: v.camera, target: v.target }))]);
  write(path.join(JOB, "walk-route.json"), p.handoff.navigation.routes[0]);
  if (!fs.existsSync(path.join(JOB, "progress.json"))) write(path.join(JOB, "progress.json"), { version: 1, poiId: poi, ownerAgentId: "place-build", stage: "blockout", mode: "build" });
  write(path.join(JOB, "reports", "plan.json"), { archetype: a.id, sets: setList, ...(layout ? { layout: { pieces: layout.pieces.length, ground: layout.ground.length, views: layout.views.length, origin: layout.origin ?? null } } : {}), site: siteRecord(sites[size] ?? null), centre: p.centre, padY: p.padY, front: p.front, faults: p.faults, notes: p.notes, adventureSize: size, tierDowngrade: downgrade, requested: p.requested, pockets: p.pockets.map((k) => ({ id: k.id, at: k.at, y: k.y, relief: Math.round(k.fit.stats.relief * 10) / 10, ok: k.fit.ok, why: k.fit.why })), usableAreaM2: p.handoff.measurements.measuredCombinedUsableAreaM2, seconds: Math.round((Date.now() - t0) / 1000) });
  console.log(`plan ${poi}: archetype ${a.id}${setList.length ? ` (${setList.join(" ")})` : ""}, core ${p.centre.map(Math.round)} y ${p.padY}, ${p.pockets.length} pockets, ${p.ops.length} entities, ${p.operators.length} operators, ${p.plans.length} dressing plans, usable ${p.handoff.measurements.measuredCombinedUsableAreaM2} m2 -> ${path.relative(process.cwd(), JOB)}`);
  const sc = sites[size]; if (sc) console.log(`  SITE: core ${sc.at.map(Math.round)} (${sc.moved} m from the brief site): ${sc.why}`);
  if (downgrade) console.log(`  TIER: ${downgrade.from} -> ${downgrade.to}: ${downgrade.why} (now ${downgrade.after} m2)`);
  if (zoneMaster) console.log(`  SIZE FOR THE ZONE MASTER: ${zoneMaster.why} (suggest: ${zoneMaster.suggest}; reports/zone-master.json)`);
  for (const n of p.notes) console.log(`  NOTE: ${n}`);
  for (const f of p.faults) console.log(`  FIT: ${f}`);
  if (p.faults.length) process.exitCode = 1;
}

// ---------------------------------------------------------------------------------------------------------------------
/** L (TOOLS-LAYOUT 5, 2026-10-24: the 4.8 m "bonfire" and the hero props were first seen in a review after a 15-minute
 *  chain): `props` renders every layout piece's prefab (the props proof soft renderer: headless, no server, no Blender)
 *  into ONE sheet <job>/reports/layout-props.png, each card labelled with the piece id, its element's `shows` and its
 *  catalogued size (cm, x its scale), and prints a line per piece with the size-band WARN (layoutSizeWarn). The
 *  coordinator looks at it before spending a chain. Cards are auto-fitted: the size line is the scale, not the picture. */
async function layoutPropsSheet() {
  const lf = path.join(JOB, "layout.json"); if (!fs.existsSync(lf)) fail(`${lf}: no layout.json (props renders a layout's pieces)`);
  const lp = placeLayoutSchema.safeParse(read(lf)); if (!lp.success) fail(`${lf}: ${lp.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
  const layout = lp.data!, df = path.join(JOB, "design.json"), design = fs.existsSync(df) ? read(df) : null;
  const shows = (el: string) => String((design?.elements ?? []).find((e: any) => e.id === el)?.shows ?? "(no such element)");
  const THREE = await import("three");
  const { renderStrip } = await import("./_softrender.mjs" as string), { decodePng, encodePng } = await import("./_png.mjs" as string), { drawText } = await import("./_font.mjs" as string);
  const tile = 240, band = 46, cols = 5, n = layout.pieces.length, rows = Math.ceil(n / cols), W = tile * cols, H = (tile + band) * rows;
  const rgba = new Uint8Array(W * H * 4).fill(0x10); for (let i = 3; i < rgba.length; i += 4) rgba[i] = 255;
  const pages = new Map<string, any>(), A = path.join(PROJECTS, project, "assets");
  const page = (f: string | undefined) => { if (!f || !/\.png$/i.test(f) || !fs.existsSync(f)) return null; if (!pages.has(f)) { const png = decodePng(fs.readFileSync(f)); pages.set(f, { width: png.width, height: png.height, rgba: png.data }); } return pages.get(f); };
  const words = (s: string) => s.toUpperCase().replace(/[^A-Z0-9 -]+/g, " ").replace(/\s+/g, " ").trim();
  const wrap = (s: string, max: number) => { const out: string[] = []; let line = ""; for (const w of s.split(" ")) { if ((line + " " + w).trim().length > max) { if (line) out.push(line); line = w; } else line = (line + " " + w).trim(); } if (line) out.push(line); return out; };
  console.log(`layout pieces of ${poi} (${n}):`);
  layout.pieces.forEach((q, k) => {
    const size = propInfo(q.prefab)?.size, ox = (k % cols) * tile, oy = Math.floor(k / cols) * (tile + band);
    const cm = size ? size.map((v) => Math.round(v * q.scale * 100)) : null, warn = layoutSizeWarn(q, size);
    let geo: any = null; try { geo = prefabGeometry(A, q.prefab); } catch { geo = null; }
    const t0 = geo?.tris.find((t: any) => t.tex?.file), tex = page(t0?.tex?.file), flip = t0?.tex?.flipY !== false;
    const tris = (geo?.tris ?? []).map((t: any) => ({ p: [t.a, t.b, t.c].map((v: number[]) => new THREE.Vector3(v[0], v[1], v[2])), uv: t.uv?.map(([u, v]: [number, number]) => [u, flip ? 1 - v : v]) }));
    if (tris.length) { const img = renderStrip([{ tris }], [new THREE.Vector3(-0.55, -0.45, -0.75)], tex, tile);
      for (let y = 0; y < tile; y++) for (let x = 0; x < tile; x++) for (let c = 0; c < 4; c++) rgba[((oy + y) * W + ox + x) * 4 + c] = img.rgba[(y * tile + x) * 4 + c]; }
    const plot = (col: number[]) => (x: number, y: number) => { if (x < ox || x >= ox + tile || y >= H) return; const i = (y * W + x) * 4; rgba[i] = col[0]!; rgba[i + 1] = col[1]!; rgba[i + 2] = col[2]!; };
    drawText(words(`${q.id} ${q.kind}`), ox + 4, oy + tile + 3, 1, plot(warn ? [255, 170, 60] : [235, 235, 235]));
    wrap(words(shows(q.element)), 38).slice(0, 3).forEach((l, i) => drawText(l, ox + 4, oy + tile + 13 + i * 9, 1, plot([170, 190, 210])));
    drawText(cm ? `${cm.join(" X ")} CM` : "NO SIZE", ox + 4, oy + 4, 1, plot(warn ? [255, 170, 60] : [235, 235, 235]));
    if (!tris.length) drawText("NO MESH", ox + 80, oy + tile / 2, 2, plot([255, 90, 90]));
    console.log(`  ${q.id.padEnd(16)} ${q.kind.padEnd(9)} ${q.prefab.padEnd(36)} ${cm ? cm.map((v) => (v / 100).toFixed(2)).join(" x ") + " m" : "no catalogue size"}${q.scale !== 1 ? ` (x${q.scale})` : ""}  ${q.element}${warn ? `  WARN: ${warn}` : ""}`);
  });
  const out = path.join(JOB, "reports", "layout-props.png"); fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, Buffer.from(encodePng(W, H, rgba)));
  console.log(`-> ${path.relative(process.cwd(), out)} (${cols} x ${rows} cards; look at it before spending a chain)`);
}

// ---------------------------------------------------------------------------------------------------------------------
function makeLab() {
  const live = path.join(PROJECTS, project), dir = path.join(PROJECTS, lab), pj = read(path.join(live, "project.json"));
  write(path.join(dir, "project.json"), { version: 1, name: lab, title: `place-build lab: ${poi} (scratch)`, description: `Scratch copy of ${world} world + scene for place-build ${poi}. Never installed; delete when done.`, group: "Worlds", menuOrder: 99,
    scenes: [{ id: labWorld, label: `place-build lab ${poi}`, variants: [] }], engine: pj.engine ?? "^0.1", multiplayer: pj.multiplayer ?? "server", tools: [], dependsOn: [...new Set([...(pj.dependsOn ?? []), project])] });
  const wt = fs.readFileSync(worldFile(project, world), "utf8");
  write(worldFile(lab, labWorld), withoutPlace(JSON.parse(wt)));
  fs.writeFileSync(path.join(dir, "source-world.sha1"), `${crypto.createHash("sha1").update(wt).digest("hex")} *${project}/assets/worlds/${world}.json\n`);
  const tdir = path.join(live, "assets", "materials", "terrain"), tout = path.join(dir, "assets", "materials", "terrain");
  fs.mkdirSync(tout, { recursive: true });
  for (const f of fs.readdirSync(tdir).filter((f) => f === `${world}.json` || f.startsWith(`${world}-`))) fs.copyFileSync(path.join(tdir, f), path.join(tout, labWorld + f.slice(world.length)));
  const s = read(sceneFile(project, world)), own = new Set(Object.entries(s.entities).filter(([id, e]: any) => (e.tags ?? []).includes(`poi:${poi}`) || id.startsWith(`dress-${poi}-`)).map(([id]) => id));
  for (const id of [...own]) for (const [k, e] of Object.entries(s.entities) as any) if (e.parent === id) own.add(k);
  for (const id of own) delete s.entities[id];
  // L (gates on the lab): populated creatures are left out of the lab: the walk judges the place's ground and pieces, and
  // an aggroed ghost knight on a route turns it into a fight (encounters are gated by populate/encounter tools)
  const pop = new Set(Object.entries(s.entities).filter(([, e]: any) => (e.tags ?? []).includes("populate")).map(([id]) => id));
  for (let grew = true; grew;) { grew = false; for (const [k, e] of Object.entries(s.entities) as any) if (e.parent && pop.has(e.parent) && !pop.has(k)) { pop.add(k); grew = true; } }
  for (const id of pop) delete s.entities[id];
  for (const e of Object.values(s.entities) as any) if (e.components?.voxelWorld) e.components.voxelWorld.world = labWorld;
  s.name = `place-build lab ${poi}`;
  write(sceneFile(lab, labWorld), s);
  console.log(`lab ${lab}: world ${labWorld} <- live ${world} (place features out), scene minus ${own.size} entities of ${poi}`);
}

// ---------------------------------------------------------------------------------------------------------------------
/** Apply (or with `remove` only take out) this place in a project's world + scene. The lab build and the live install. */
function applyPlace(p: string, w: string, { remove = false, dry = false } = {}) {
  const reg = new ComponentRegistry(); registerCoreComponents(reg); registerChunkComponents(reg);
  const SF = sceneFile(p, w), WF = worldFile(p, w);
  const ops = read(path.join(JOB, "ops.json")) as any[], worldOps = read(path.join(JOB, "world-ops.json")) as any[], operators = read(path.join(JOB, "operators.json")) as any[];
  if(!remove){const policy=propPolicy(PROJECTS,p);for(const op of ops){const id=op.entity?.components?.prefab?.prefabId??(op.component==='prefab'?op.data?.prefabId:undefined);if(id)policy.assertAllowed(id);}}
  // scene: everything tagged poi:<poi> (and its dressing) out, deepest first; then the ops in
  const scene = read(SF), own = Object.keys(scene.entities).filter((id) => (scene.entities[id].tags ?? []).includes(`poi:${poi}`) || id.startsWith(`dress-${poi}-`));
  const depth = (id: string): number => (scene.entities[id]?.parent ? 1 + depth(scene.entities[id].parent) : 0);
  const removes = own.filter((id) => !own.includes(scene.entities[id].parent)).sort((x, y) => depth(y) - depth(x)).map((id) => ({ op: "remove-entity", id }));
  const res0 = applyOps(scene, [...removes, ...(remove ? [] : ops)] as never, reg);
  // L (rock-skins, bar-watch 2026-10-21): a rock-kit STRUCTURE (a ledge outcrop) is placed by ops, not by dress apply, so
  // it drew the model's own granite on the zone's slate; it is skinned like a dressed rock (same ops batch, one inverse)
  const skin = remove || dry ? { ops: [] as any[] } : skinPlacedOps(p, res0.doc, createWorldField(worldRecipeSchema.parse(read(WF))), new Set(ops.map((o: any) => o.id)));
  const res = skin.ops.length ? applyOps(scene, [...removes, ...ops, ...skin.ops] as never, reg) : res0;
  // world: own operators removed through the operator tool (their pieces and its cascade), then the rest of own features raw
  const wdoc = read(WF), ownOps = (wdoc.features.operators ?? []).filter((o: any) => ownsFeature(o)).map((o: any) => o.id);
  if (dry) { console.log(`[dry-run] ${p}/${w}: remove ${removes.length} entity roots + ${ownOps.length} operators + own features; ${remove ? "" : `add ${ops.length} entities, ${worldOps.length} patches, ${operators.length} operators`}`); return; }
  write(SF, res.doc);
  if (!remove) write(path.join(JOB, p === lab ? "reports/lab-inverse.json" : "install-inverse.json"), res.inverse);
  const wg = (label: string, args: string[]) => { const r = tool(label, ["tools/worldgen.mts", ...args]); if (r.status) fail(`${label} failed (see ${JOB}/reports/${label}.log): ${r.out.trim().split("\n").slice(-3).join(" | ")}`); return r; };
  for (const id of ownOps) wg(`op-remove`, ["op", w, "--project", p, "--remove", id]);
  const w2 = withoutPlace(read(WF));
  if (!remove) {
    const parsed = applyRecipeEdits(worldRecipeSchema.parse(w2), worldOps as never); // validates every patch
    for (const o of worldOps) (w2.features[o.kind] ??= []).push((parsed.recipe.features as any)[o.kind].find((f: any) => f.id === o.feature.id));
  }
  write(WF, w2);
  if (remove) { console.log(`removed ${poi} from ${p}/${w}: ${removes.length} entity roots, ${ownOps.length} operators, own patches + clearings`); return; }
  if (operators.length) wg("op-apply", ["op", w, "--project", p, "--apply", path.join(JOB, "operators.json")]);
  if (!remove && p === lab) { // L: routes on the walk surface as BUILT (pads, raiseOnly, the footpaths' grade patches): re-measured on the lab ground AFTER the operators
    const f = createWorldField(worldRecipeSchema.parse(read(WF))), hand = read(path.join(JOB, "handoff.json"));
    const ribbons = (read(WF).features.ribbons ?? []) as any[]; // the footpath legs follow their ribbon as built (routeOnRibbon)
    for (const r of hand.navigation.routes) { const rb = ribbons.find((x) => x.id === `op:${PREFIX}${r.id}:ribbon`); if (rb) r.points = routeOnRibbon(r.points, rb.samples, rb.width / 2); }
    for (const r of hand.navigation.routes) if (!r.onBuilt) for (const q of r.points) q[1] = Math.round(f.height(q[0], q[2]) * 100) / 100; // a deck route stays on the deck
    write(path.join(JOB, "handoff.json"), hand); write(path.join(JOB, "walk-route.json"), hand.navigation.routes[0]);
  }
  for (const o of operators.filter((o) => o.op === "wall" || o.op === "landmark")) { // walls and built landmarks (a bridge) bake the same way
    const r = tool(`bake-${o.id}`, ["tools/landmark.mts", p, w, o.id]); if (r.status) fail(`bake ${o.id} failed (reports/bake-${o.id}.log)`); }
  wg("clearings", ["vegetation", w, "--project", p, "--clearings", path.join(JOB, "clearings.json")]);
  // dressing: socket maps from the handoff's areas, then each first plan checked and applied BY NAME (never a transform)
  // dress apply/walk write .inverse/.walk files beside the plans (and older dress wrote .report there): never apply those as plans
  const plans = fs.existsSync(path.join(JOB, "dressing")) ? fs.readdirSync(path.join(JOB, "dressing")).filter((f) => f.endsWith(".json") && !/\.(report|inverse|walk)\.json$/.test(f)) : [];
  if (plans.length) {
    const r = tool("sockets", ["tools/site-sockets.mts", "--project", p, "--job", JOB, "--scene", w]);
    if (r.status) fail(`site-sockets failed (reports/sockets.log)`);
    const pdir = path.join(PROJECTS, p, "authoring", "dressing", "plans");
    // L (dress, peat-banks 2026-10-21): a plan this place no longer writes (a re-plan dropped or renamed an area) is removed
    // from the project's plans, or its quest objects collide with the new plan's (quest-duplicate) and the apply is refused
    for (const f of fs.existsSync(pdir) ? fs.readdirSync(pdir) : []) { const base = f.replace(/(\.(report|inverse|walk))?\.json$/, ""); if (base.startsWith(`${poi}-`) && !plans.includes(`${base}.json`)) { fs.unlinkSync(path.join(pdir, f)); console.log(`  removed stale plan file ${f}`); } }
    // ...and every plan of this place is written before any is checked: a quest object that moved between two of its
    // plans (core -> far-cut) was still in the other's old copy when the first was applied (quest-duplicate)
    for (const f of plans) { const d0 = read(path.join(JOB, "dressing", f)); d0.items = uniqueItemIds(d0.items ?? []); write(path.join(pdir, f), d0); }
    for (const f of plans) {
      { const d0 = read(path.join(JOB, "dressing", f)); d0.items = uniqueItemIds(d0.items ?? []); write(path.join(JOB, "dressing", f), d0); write(path.join(pdir, f), d0); } // L (dress check): unique item ids, also in a plan a dresser edited
      const id = f.replace(/\.json$/, "");
      // L (dress): an area whose socket map has no open floor (area 0: the pocket stands on a bank) has nothing to dress;
      // the core schema refuses a 0 m2 room, so it is skipped here and named by the dress gate (noFloor)
      if (noFloor(p, id) !== null) { console.log(`  dress ${id}: SKIPPED (its socket map has no open floor: ${noFloor(p, id)})`); continue; }
      // the dressing retry loop (site-dressing: refused -> drop, never hand-nudge): items the socket map has no room for
      // are dropped from the plan (job copy = the source) until `dress check` places the rest; what stays is the dresser's
      // L (TOOLS-PB 2026-10-23, silent drop): every item the loop takes out is recorded with its reason (the dress gate names it)
      const drops: PlanDrop[] = [], dropFile = path.join(JOB, "reports", `dress-${id}.dropped.json`);
      for (let round = 0; round < 6; round++) {
        if (!tool(`check-${id}`, ["tools/dress.mts", "check", "--project", p, "--plan", id, "--scene", w, "--at", "0,0,0", "--quiet", "--poi", poi]).status) break;
        const rp = readableReportFile(path.join(pdir, `${id}.json`)) ?? "", bad = new Set(((fs.existsSync(rp) ? read(rp).violations : []) as any[]).filter((v) => /^auto-no-room|no-room|refused|overlaps/.test(v.code) && v.item).map((v) => v.item));
        if (!bad.size) { // top a sparse room up with the role's small fill props (never the props that just had no room)
          // L (PLACES-FIX 2026-10-21: 42 site-dense plans): an outdoor area over the density cap (@hitreg/core SITE_DENSITY_CAP)
          // sheds loose pieces, never a vignette member or a quest object: top-up fill first, then boulders, then the rest
          const dense = ((fs.existsSync(rp) ? read(rp).violations : []) as any[]).find((v) => v.code === "site-dense"), dm = dense?.message.match(/has (\d+) props;.*\((\d+)\)/);
          if (dm && +dm[1] > +dm[2]) {
            const planDoc = read(path.join(JOB, "dressing", f)), rank = (it: any) => (/^fill-/.test(it.id) ? 0 : /^rock-kit\//.test(it.prop) ? 1 : 2);
            const shed = planDoc.items.filter((it: any) => !it.quest && !it.place?.arrangement && it.place?.prefer !== "row").sort((x: any, y: any) => rank(x) - rank(y)).slice(0, +dm[1] - +dm[2]).map((it: any) => it.id);
            if (shed.length) {
              for (const it of planDoc.items) if (shed.includes(it.id)) drops.push({ prop: it.prop, why: `shed: ${dense.message}` });
              planDoc.items = planDoc.items.filter((it: any) => !shed.includes(it.id));
              write(path.join(JOB, "dressing", f), planDoc); write(path.join(pdir, f), planDoc);
              console.log(`  dress ${id}: shed ${shed.join(", ")} (over the site density cap)`); continue;
            }
          }
          // L (owner walk, kirk-knowe 2026-10-21: graves clumped in the centre): a graveyard short of graves is topped up with
          // more of its own grave props in rows (`prefer: "row"`), never with the role's fill
          const graves = ((fs.existsSync(rp) ? read(rp).violations : []) as any[]).find((v) => v.code === "graveyard-sparse"), gm = graves?.message.match(/plan (\d+) more/);
          if (gm) {
            const planDoc = read(path.join(JOB, "dressing", f)), rows = planDoc.items.filter((it: any) => it.place?.kind === "auto" && it.place.prefer === "row" && it.prop), ids = new Set(planDoc.items.map((it: any) => it.id));
            if (rows.length) {
              for (let n = 0, k = 1; n < +gm[1]; n++) { const src = rows[n % rows.length], base = String(src.prop).split("/").pop(); while (ids.has(`${base}-${k}`)) k++; ids.add(`${base}-${k}`); planDoc.items.push({ id: `${base}-${k}`, prop: src.prop, place: { ...src.place } }); }
              write(path.join(JOB, "dressing", f), planDoc); write(path.join(pdir, f), planDoc);
              console.log(`  dress ${id}: topped up ${gm[1]} grave(s) in rows (graveyard minimum)`); continue;
            }
          }
          // a vignette the ground cannot hold (no open ground off the lanes, a missing anchor): its members stand loose instead
          const unlaid = new Set(((fs.existsSync(rp) ? read(rp).violations : []) as any[]).filter((v) => v.code === "arrangement" && v.item).map((v) => v.item));
          if (unlaid.size) {
            const planDoc = read(path.join(JOB, "dressing", f));
            for (const it of planDoc.items) if (unlaid.has(it.id)) it.place = { kind: "auto", room: it.place.room, prefer: "open" };
            write(path.join(JOB, "dressing", f), planDoc); write(path.join(pdir, f), planDoc);
            console.log(`  dress ${id}: ${[...unlaid].join(", ")} placed loose (their vignette could not be laid out)`); continue;
          }
          // a room's minimum (room-sparse) or an outdoor area's density by area (site-sparse, @hitreg/core SITE_DENSITY)
          const sparse = ((fs.existsSync(rp) ? read(rp).violations : []) as any[]).find((v) => v.code === "room-sparse" || v.code === "site-sparse");
          const mm = sparse?.message.match(/has (\d+) (?:items?|props);.*?(?:it needs at least (\d+)|\((\d+)\): add)/), m = mm ? [mm[0], mm[1], mm[2] ?? mm[3]] : null;
          if (!m) break;
          const planDoc = read(path.join(JOB, "dressing", f)), role = Object.values(planDoc.rooms ?? {})[0] as any, room = Object.keys(planDoc.rooms ?? {})[0]!, br = read(path.join(JOB, "brief.json")), raw = archetypes().find((x) => x.a.id === br.archetype)?.raw;
          const arch = raw ? placeArchetypeSchema.parse(applySets(raw, br.sets ?? [])) : undefined, pk = arch?.pockets.find((k) => k.id === room);
          // L (TOOLS-PB 2026-10-23, hero top-up): the pocket's / archetype's filler, never a requested prop
          const fill = fillerFor(pk?.dressing?.filler ?? arch?.filler, role?.role ?? "yard", fillOk({ culture: planDoc.space?.cultures ?? arch?.culture ?? [], deny: arch?.deny ?? [], id: arch?.id ?? "" }, propInfo), (pk?.dressing?.props ?? []).map((q) => q.prop)), ids = new Set(planDoc.items.map((it: any) => it.id));
          if (!fill.length) { console.log(`  dress ${id}: room sparse and no allowed fill prop for role ${role?.role}`); break; }
          // L (dress check): item ids are unique: a rebuild over a plan that already holds fill-N items counts on
          for (let n = 0, k = 1; n < +m[2] - +m[1]; n++) { while (ids.has(`fill-${k}`)) k++; ids.add(`fill-${k}`); planDoc.items.push({ id: `fill-${k}`, prop: fill[n % fill.length], place: { kind: "auto", room, prefer: "open" } }); }
          write(path.join(JOB, "dressing", f), planDoc); write(path.join(pdir, f), planDoc);
          console.log(`  dress ${id}: topped up ${+m[2] - +m[1]} small prop(s) (room minimum)`); continue;
        }
        const planDoc = read(path.join(JOB, "dressing", f)), vs = (fs.existsSync(rp) ? read(rp).violations : []) as any[];
        for (const it of planDoc.items) if (bad.has(it.id)) { const v = vs.find((x) => x.item === it.id); drops.push({ prop: it.prop, why: v ? `${v.code}: ${String(v.message ?? "").slice(0, 160)}` : "no room on the socket map" }); }
        planDoc.items = planDoc.items.filter((it: any) => !bad.has(it.id));
        write(path.join(JOB, "dressing", f), planDoc); write(path.join(pdir, f), planDoc);
        console.log(`  dress ${id}: dropped ${[...bad].join(", ")} (no room on the socket map)`);
      }
      write(dropFile, drops);
      const ap = tool(`dress-${id}`, ["tools/dress.mts", "apply", "--project", p, "--plan", id, "--scene", w, "--at", "0,0,0", "--yaw", "0", "--poi", poi]);
      if (ap.status) console.log(`  dress ${id}: apply FAILED (reports/dress-${id}.log) — ${ap.out.trim().split("\n").slice(-2).join(" | ")}`);
    }
  }
  console.log(`applied ${poi} to ${p}/${w}: ${ops.length} entities, ${worldOps.length} pads, ${operators.length} operators, clearings, ${plans.length} dressing plans`);
  // the job is now live: zonegen status/bind read the stage, so a place-build install stamps it (gate 2 still applies: readShot evidence, no home-made fire)
  try { setStage(JOB, "installed"); } catch (e) { console.log(`WARN stage not moved to installed: ${String((e as Error).message).slice(0, 200)}`); }
}

// ---------------------------------------------------------------------------------------------------------------------
const GATES = ["design", "size", "fine", "roads", "lips", "scatter-float", "float", "seated", "rock-skins", "water-edges", "zfight", "op-check", "art", "walk", "dress", "place"] as const;
function gates(onlyArg?: string[]) {
  const hand = read(path.join(JOB, "handoff.json")), plan = read(path.join(JOB, "reports", "plan.json"));
  const pts = [plan.centre, ...plan.pockets.map((k: any) => k.at)] as V2[], c = plan.centre as V2;
  const R = Math.ceil(Math.max(...pts.map((q) => Math.hypot(q[0] - c[0], q[1] - c[1]))) + 30), near = `${Math.round(c[0])},${Math.round(c[1])},${R}`;
  const only = onlyArg ?? opt("only")?.split(","), rows: any[] = [], rep = (n: string) => path.join(JOB, "reports", `${n}.json`);
  const okOf = (n: string) => { try { return read(rep(n)).ok === true; } catch { return false; } };
  const gate = (name: string, fn: () => { ok: boolean; detail: string }) => { if (only && !only.includes(name)) return; const t0 = Date.now(); let r; try { r = fn(); } catch (e: any) { const at = [...String(e.stack ?? "").matchAll(/\n\s+at .*?([\w.-]+\.m?ts:\d+)/g)].slice(0, 3).map((m) => m[1]).join(" < "); r = { ok: false, detail: `${e.message}${at ? ` (at ${at})` : ""}` }; } rows.push({ gate: name, ok: r.ok, detail: r.detail, s: Math.round((Date.now() - t0) / 1000) }); console.log(`${r.ok ? "ok  " : "FAIL"} ${name.padEnd(13)} ${r.detail}`); };
  const job = ["../../tools/poi-review/job.mjs"], last = (o: string) => { const ls = o.trim().split("\n").filter((l) => l.trim() && !l.startsWith("[") && !/deprecated/.test(l)); return [...ls].reverse().find((l) => /FAIL|\bok\b|OK|PASS|fault/i.test(l)) ?? ls[ls.length - 1] ?? ""; };
  // gate 16 (owner ruling 2026-10-22: a zone of places passed every gate below and read as nothing): the design is written,
  // one area is finished at player height, and a fresh reviewer has passed the Place lines on it; the install refuses without it
  gate("design", () => { const r = tool("design", [...job, "design", JOB], true); return { ok: r.status === 0, detail: last(r.out).replace(/^(review|design \(gate 16\) FAIL):\s*/, "").slice(0, 300) }; });
  gate("size", () => { const r = tool("size", [...job, "measure", JOB], true); let j: any = {}; try { j = read(rep("size")); } catch {}
    // the tier downgrade (plan: the ground holds less than the asked tier) is reported with the size, never hidden
    const dg = hand.tierDowngrade; if (dg) { j.tierDowngrade = dg; write(rep("size"), j); }
    const note = dg ? ` (built ${dg.to}, asked ${dg.from}: ${dg.measuredUsableAreaM2} m2 < ${dg.neededM2} m2)` : "";
    return { ok: r.status === 0, detail: (j.faults?.length ? j.faults.join("; ") : `${j.tier} ok`) + note }; });
  gate("fine", () => { const r = tool("fine", [...job, "fine", JOB], true); return { ok: r.status === 0, detail: r.out.split("\n")[0]! }; });
  gate("roads", () => roadsCheck(hand));
  gate("lips", () => { const r = tool("lips", ["tools/worldgen.mts", "lips", labWorld, "--project", lab, "--near", near, "--json"]); let j: any = null; try { j = JSON.parse(r.out.slice(r.out.indexOf("{"), r.out.lastIndexOf("}") + 1)); } catch {}
    if (!j) { write(rep("lips"), { ok: false, log: "reports/lips.log" }); return { ok: false, detail: "no lips report (reports/lips.log)" }; }
    // this place's own patches / operator pieces fail; faults of what was there before are listed, not charged
    const own = (j.owners ?? []).filter((o: any) => String(o.id).startsWith(PREFIX) || String(o.id).startsWith(`op:${PREFIX}`)), bad = own.filter((o: any) => !o.allowed && (o.alias || o.step || o.lip));
    const before = (j.owners ?? []).filter((o: any) => !own.includes(o) && (o.alias || o.step || o.lip)).map((o: any) => o.id);
    write(rep("lips"), { ok: !bad.length, own, preExisting: before, totals: j.totals });
    return { ok: !bad.length, detail: bad.length ? bad.map((o: any) => `${o.id} alias ${o.alias} step ${o.step} lip ${o.lip} worst ${o.worst} m`).join("; ") : `own patches clean${before.length ? ` (pre-existing: ${before.join(", ")})` : ""}` }; });
  // L (gates on the lab, 2026-10-20): a site the search moved 200 m widens --near, and with it the world's own old floats
  // (hoodoos, shore rocks, cover on raw heightfield edges): float/scatter-float charge only findings the LIVE world (same
  // --near, without this place) does not already have, as rock-skins does
  // keyed on what + where ("... at (x, z)"): the measures after it (base, gap, ring drop) move by tenths between the lab
  // and live bakes of the same plant, and a whole-line match charged those as new (HERO-BRIDGE 2026-10-22)
  const findings = (out: string) => out.split("\n").filter((l) => /\bat \(/.test(l)).map((l) => l.trim().replace(/\s+/g, " ").replace(/(\bat \([^)]*\)).*/, "$1"));
  const newOnly = (g: string, r: { status: number; out: string }, extra: string[] = []) => { if (r.status === 0) return { ok: true, detail: last(r.out).slice(0, 200) };
    const live = tool(`${g}-live`, ["tools/worldgen.mts", g, world, "--project", project, "--near", near, ...extra.map((x) => (x === rep(g) ? rep(`${g}-live`) : x))]), had = new Set(findings(live.out)), mine = findings(r.out).filter((l) => !had.has(l));
    return { ok: mine.length === 0, detail: mine.length ? mine.slice(0, 3).join(" | ").slice(0, 300) : `${findings(r.out).length} finding(s) the live world has too, none new` }; };
  // --list on both sides: the default print is the first 25 findings, ordered differently in lab and live (HERO-BRIDGE 2026-10-22:
  // 89 lab findings all present among 178 live ones were charged as new)
  gate("scatter-float", () => newOnly("scatter-float", tool("scatter-float", ["tools/worldgen.mts", "scatter-float", labWorld, "--project", lab, "--near", near, "--list"]), ["--list"]));
  gate("float", () => { const res = newOnly("float", tool("float", ["tools/worldgen.mts", "float", labWorld, "--project", lab, "--near", near, "--out", rep("float")]), ["--out", rep("float")]);
    // the install guard (job.mjs gate 5) reads reports/float.json: record the gate's own verdict there, as rock-skins does
    if (res.ok && fs.existsSync(rep("float"))) { const j = read(rep("float")); if (j.ok !== true) write(rep("float"), { ...j, ok: true, passed: true, preExisting: (j.rows ?? []).length, own: [] }); }
    return res; });
  gate("seated", () => seatedCheck());
  for (const g of ["water-edges"]) gate(g, () => { const r = tool(g, ["tools/worldgen.mts", g, labWorld, "--project", lab, "--near", near, "--out", rep(g)]); return { ok: r.status === 0 && okOf(g), detail: last(r.out).slice(0, 200) }; });
  gate("rock-skins", () => { // charged only for rocks the live world did not already have wrong (same --near, live recipe)
    const r = tool("rock-skins", ["tools/worldgen.mts", "rock-skins", labWorld, "--project", lab, "--near", near, "--out", rep("rock-skins")]); if (okOf("rock-skins")) return { ok: true, detail: last(r.out).slice(0, 200) };
    tool("rock-skins-live", ["tools/worldgen.mts", "rock-skins", world, "--project", project, "--near", near, "--out", rep("rock-skins-live")]);
    const key = (f: any) => `${f.fault}:${f.id}`, had = new Set(((fs.existsSync(rep("rock-skins-live")) ? read(rep("rock-skins-live")).rows : []) ?? []).map(key));
    const j = read(rep("rock-skins")), mine = (j.rows ?? []).filter((f: any) => !had.has(key(f)));
    write(rep("rock-skins"), { ...j, ok: mine.length === 0, own: mine, preExisting: (j.rows ?? []).length - mine.length });
    return { ok: !mine.length, detail: mine.length ? mine.slice(0, 3).map((f: any) => `${f.fault} ${f.id}: ${f.detail}`).join("; ") : `${(j.rows ?? []).length} pre-existing fault(s) the live world has too, none new` }; });
  gate("zfight", () => { // charged only for clusters the live world does not already have (newZfightClusters)
    const r = tool("zfight", ["tools/zfight.mts", lab, "--scene", labWorld, "--world", labWorld, "--near", near, "--out", rep("zfight")]);
    if (r.status === 0 || !fs.existsSync(rep("zfight"))) return { ok: r.status === 0, detail: last(r.out).slice(0, 200) };
    tool("zfight-live", ["tools/zfight.mts", project, "--scene", world, "--world", world, "--near", near, "--out", rep("zfight-live")]);
    const j = read(rep("zfight")), mine = newZfightClusters(j, fs.existsSync(rep("zfight-live")) ? read(rep("zfight-live")) : null, labWorld, world);
    if (mine.length) return { ok: false, detail: `FAIL ${mine.length} new: ${mine.slice(0, 2).map((c: any) => `${c.a.mesh} vs ${c.b.mesh} ${c.area} m2 at ${c.centre.map(Math.round)}`).join("; ")}`.slice(0, 300) };
    write(rep("zfight"), { ...j, passed: true, ok: true, preExisting: (j.failures ?? []).length, own: [] });
    return { ok: true, detail: `${(j.failures ?? []).length} cluster(s) the live world has too, none new` }; });
  gate("op-check", () => { const r = tool("op-check", ["tools/worldgen.mts", "op", labWorld, "--project", lab, "--check"]); const mine = r.out.split("\n").filter((l) => l.includes(PREFIX) && /EDITED|MISSING|STALE/.test(l)); return { ok: mine.length === 0, detail: mine.length ? mine.slice(0, 3).join(" | ") : `${PREFIX}* operators current` }; });
  // L (art, signal-tower 2026-10-21): measured in the LAB (the live scene still held the old install's barrel)
  gate("art", () => { const r = tool("art", ["tools/art-check.mts", JOB, "--culture", "human", "--project", lab, "--world", labWorld]); return { ok: r.status === 0 && okOf("art-check"), detail: last(r.out).slice(0, 220) }; });
  gate("walk", () => { const r = tool("walk", ["tools/poi-walk.mts", JOB, "--scene", labWorld]); return { ok: r.status === 0 && okOf("walk"), detail: last(r.out).slice(0, 220) }; });
  gate("dress", () => { const bad: string[] = []; for (const f of fs.readdirSync(path.join(JOB, "dressing")).filter((f) => f.endsWith(".json") && !/.(report|inverse|walk).json$/.test(f))) { const id = f.replace(/\.json$/, ""); const nf = noFloor(lab, id); if (nf !== null) { bad.push(`${id}: no open floor on its socket map (${nf}): the pocket is not on level ground, re-plan (site search)`); continue; } const r = tool(`check-${id}`, ["tools/dress.mts", "check", "--project", lab, "--plan", id, "--scene", labWorld, "--at", "0,0,0", "--quiet", "--poi", poi]); if (r.status) bad.push(`${id}: ${last(r.out).slice(0, 120)}`); }
    // L (TOOLS-PB 2026-10-23, silent drop): every prop the design asked of a plan is in it, else a fault naming the prop and why
    const requested = (plan.requested ?? {}) as Record<string, { prop: string; count: number; why?: string }[]>;
    for (const [id, want] of Object.entries(requested)) {
      const pf = path.join(JOB, "dressing", `${id}.json`), items = fs.existsSync(pf) ? (read(pf).items ?? []) as any[] : [], df = path.join(JOB, "reports", `dress-${id}.dropped.json`);
      const short = requestedShortfall(want, items, fs.existsSync(df) ? read(df) : []).map((s) => (fs.existsSync(pf) ? s : `${s} [no plan file]`));
      if (!short.length) continue;
      fs.appendFileSync(path.join(JOB, "reports", `dress-${id}.log`), ["", "REQUESTED PROPS NOT PLACED (dress gate):", ...short.map((s) => `  ${s}`), ""].join("\n"));
      bad.push(`${id}: requested not placed: ${short.join("; ").slice(0, 300)}`);
    }
    return { ok: !bad.length, detail: bad.join(" | ") || "every first plan resolves, every requested prop placed" }; });
  gate("place", () => placeChecks(hand));
  const prev = fs.existsSync(rep("gates")) ? read(rep("gates")).rows ?? [] : [];
  const merged = [...prev.filter((r: any) => !rows.some((x) => x.gate === r.gate)), ...rows].sort((x, y) => GATES.indexOf(x.gate) - GATES.indexOf(y.gate));
  write(rep("gates"), { ok: merged.length === GATES.length && merged.every((r: any) => r.ok), lab, at: new Date().toISOString(), rows: merged });
  if (rows.some((r) => !r.ok)) process.exitCode = 1;
}
/** ROADS (owner ruling 2026-10-20: "no ribbon roads: buried by terrain, never approved"): the job carries no ribbon /
 *  path-operator approach (ribbonApproachOps; zonegen status `poi <id>` fails on the same rule), and the approach track
 *  it declares (handoff approachTrack) is a carved + painted road in the lab world. reports/roads.json. */
function roadsCheck(hand: any): { ok: boolean; detail: string } {
  const ribbons = ribbonApproachOps(read(path.join(JOB, "operators.json")), read(path.join(JOB, "world-ops.json")));
  const t = hand.approachTrack ?? null, labRoads = (read(worldFile(lab, labWorld)).features.roads ?? []) as any[], built = t ? labRoads.filter((r) => r.id === t.id || r.id.startsWith(`${t.id}.`)) : [];
  // a bridge place declares a track per end (handoff approachTracks): every one carved + painted in the lab
  const more = ((hand.approachTracks ?? []) as any[]).filter((x) => x.id !== t?.id), moreBuilt = more.map((x) => ({ x, r: labRoads.filter((r) => r.id === x.id || r.id.startsWith(`${x.id}.`)) }));
  const faults = [...ribbons.map((r) => `ribbon approach ${r}: re-plan the approach (place-build approach)`), ...(t && !built.length ? [`approach track ${t.id} is not in the lab world (build)`] : []), ...built.filter((r) => !r.surface).map((r) => `track ${r.id} is not painted`),
    // L (fowlers-drop 2026-10-21): a track without keepLandforms clears every sea cliff / butte round it (a 120 m headland fell)
    ...built.filter((r) => !r.keepLandforms).map((r) => `track ${r.id} has no keepLandforms: it clears the sea cliffs and buttes round it (re-plan: place-build plan)`),
    ...moreBuilt.flatMap(({ x, r }) => (r.length ? r.filter((q) => !q.surface).map((q) => `track ${q.id} is not painted`) : [`track ${x.id} is not in the lab world (build)`]))];
  write(path.join(JOB, "reports", "roads.json"), { ok: !faults.length, faults, ribbons, track: t, built: built.map((r) => ({ id: r.id, width: r.width, points: r.points.length, surface: r.surface })) });
  return { ok: !faults.length, detail: faults.join("; ") || (t ? `approach track ${t.id}: ${t.width} m carved + painted, ${t.lengthM} m from ${t.from}; no ribbon approach` : "no ribbon approach (no track: pinpoint or no walkable leg)") };
}
/** SEATED (signal-tower 2026-10-21, owner: "the ruins are floating"; float passed it on ONE contact within 0.05 m): every
 *  structure of the place (not a fire or a boat) is measured along its whole BASE OUTLINE on the lab's built ground: the
 *  most daylight between its base and the ground (or its skirt's top, along the skirt) must be <= SEAT_GAP_M.
 *  reports/seated.json. */
function seatedCheck(): { ok: boolean; detail: string } {
  const g = ground(read(worldFile(lab, labWorld))), scene = read(sceneFile(lab, labWorld)), E = scene.entities as Record<string, any>;
  const ops = read(path.join(JOB, "ops.json")) as any[], walls = (read(path.join(JOB, "operators.json")) as any[]).filter((o) => o.op === "wall");
  const root = E[`poi-${poi}`]?.components?.transform?.position ?? [0, 0, 0], rows: any[] = [];
  for (const o of ops) {
    const slot = (o.entity?.tags ?? []).find((t: string) => t.startsWith("slot:"))?.slice(5), prefab = o.entity?.components?.prefab?.prefabId;
    if (!prefab || !slot || slot === "fire" || slot === "boat" || slot === "ring" || (o.entity?.tags ?? []).some((t: string) => t.startsWith("on:"))) continue; // a piece on another piece is not seated on the ground
    const e = E[o.id]; if (!e) { rows.push({ id: o.id, prefab, fault: "not in the lab scene" }); continue; }
    const b0 = structureBase(prefab); if (!b0) { rows.push({ id: o.id, prefab, gap: null, note: "no base outline (no triangles)" }); continue; }
    const t = e.components.transform, base = scaleBase(b0, t.scale?.[0] ?? 1), q = t.rotation ?? [0, 0, 0, 1], yawR = 2 * Math.atan2(q[1], q[3]), at: V2 = [root[0] + t.position[0], root[2] + t.position[2]], lift = Number((o.entity?.tags ?? []).find((t: string) => t.startsWith("lift:"))?.slice(5) ?? 0) || 0, y = root[1] + t.position[1] - lift; // a lifted piece (layout `lift`) is seated at its footing, `lift` below its base plane
    const sk = walls.find((w) => w.id === `pb-${poi}-skirt-${o.id.slice(poi.length + 1)}`);
    const m = seatGap(base, at, y, yawR, (x, z) => g.height(x, z), sk ? { hull: sk.points, top: sk.topY, reach: sk.thickness / 2 + 0.3 } : null);
    rows.push({ id: o.id, prefab, gap: m.gap, at: m.at, skirt: sk?.id ?? null, ok: m.gap <= SEAT_GAP_M });
  }
  // a bridge's bases (pier footings, imposts, the tower, abutments, the band beyond the end arches): daylight along each outline
  const bf = path.join(JOB, "reports", "bridge.json");
  if (fs.existsSync(bf)) for (const b of (read(bf).bases ?? []) as any[]) { const m = baseGap(b, (x, z) => g.height(x, z)); rows.push({ id: b.name, prefab: `bridge ${b.why}`, gap: m.gap, at: m.at, buried: m.buried, ok: m.gap <= SEAT_GAP_M }); }
  const bad = rows.filter((r) => r.fault || r.ok === false);
  write(path.join(JOB, "reports", "seated.json"), { ok: !bad.length, tolerance: SEAT_GAP_M, rows });
  return { ok: !bad.length, detail: bad.length ? bad.slice(0, 3).map((r) => r.fault ? `${r.id}: ${r.fault}` : `${r.id} (${r.prefab}) stands ${r.gap} m clear at ${r.at}`).join("; ") : `${rows.length} structure(s) seated (max gap ${Math.max(0, ...rows.map((r) => r.gap ?? 0)).toFixed(2)} m <= ${SEAT_GAP_M})` };
}
/** The place's own lesson checks: approach read, stale entities, cleared structures, primitives, catalogued prefabs,
 *  dusk light, evidence after the last ops change. reports/place.json. */
/** L (all, 2026-10-20 batch: a shot failure showed as three faults): `all` runs the gates BEFORE the shots, so the first
 *  `place` pass does not charge the evidence (pending); the pass after the shots charges it, as one fault naming why. */
let evidencePending = false;
function placeChecks(hand: any) {
  const faults: string[] = [], out: any = {};
  // the plan's own FIT faults (a route with no walkable way, a pocket that does not fit) are named here, once
  const planRep = path.join(JOB, "reports", "plan.json"), planFaults: string[] = fs.existsSync(planRep) ? read(planRep).faults ?? [] : [];
  if (planFaults.length) faults.push(`plan: ${planFaults.length} FIT fault(s): ${planFaults.slice(0, 2).join("; ")}`);
  const recipe = read(worldFile(lab, labWorld)), g = ground(recipe), lm = hand.landmark;
  const res = (read(path.join(ZONE, "reservations.json")).reservations ?? []).find((r: any) => r.location === poi);
  const lines = res ? approachLines(recipe, read(path.join(ZONE, "reservations.json")).reservations ?? [], res).lines : [];
  const band = readBand(hand.measurements?.adventureSize, hand.read?.band); out.band = band;
  if (!lm) faults.push("no landmark");
  else { // L: judged along the approach the place's own footpath joins (the plan's approach); every other line is reported, not charged
    const need = typeof hand.read?.approachLine === "number" ? [hand.read.approachLine] : undefined;
    out.read = approachReadAny(g, [{ at: lm.at, top: lm.top, fogReach: lm.fogReach, foot: lm.foot }, ...((hand.smoke ?? []) as any[]).map((q) => ({ ...q, foot: g.height(q.at[0], q.at[1]) }))], lines, band, need);
    if (!out.read.ok) faults.push(`approach read: ${out.read.note || `approach line(s) ${out.read.unread.join(", ")} never show the landmark ${READ_PX_MIN} px tall at ${band[0]}-${band[1]} m (${hand.measurements?.adventureSize ?? "medium"} tier; best ${out.read.rows.map((r: any) => r.reason ?? `${r.px ?? "-"} px @ ${r.distance} m`).join(", ")})`}`); }
  // L (art, Hagsheer 2026-10-21): a built wall never wears the terrain cliff tile (the zone's built stone: zone defaults builtStone)
  const cliffWalls = (read(path.join(JOB, "operators.json")) as any[]).filter((o) => o.op === "wall" && wearsCliffTile(o.materials)).map((o) => o.id);
  if (cliffWalls.length) faults.push(`walls in the terrain cliff tile (no face material): ${cliffWalls.slice(0, 4).join(", ")}`);
  { // and every wall material is one of the zone palette's built stones
    const zp = zonePalette(read(worldFile(project, world)), zone);
    const okStone = zp ? builtStoneSet(zp) : null;
    if (okStone && okStone.size) {
      const offWalls = (read(path.join(JOB, "operators.json")) as any[]).filter((o) => o.op === "wall" && Object.values(o.materials ?? {}).flat().some((m) => !okStone.has(m as string))).map((o) => o.id);
      if (offWalls.length) faults.push(`walls in a stone outside the zone palette (regions[].palette.builtStone): ${offWalls.slice(0, 4).join(", ")}`);
    }
  }
  const ops = read(path.join(JOB, "ops.json")) as any[], scene = read(sceneFile(lab, labWorld));
  // L (weepmouth 2026-10-21): a quest object keeps its quest id (no dress-<poi>- prefix): delivered by the job's plans
  const questIds = fs.readdirSync(path.join(JOB, "dressing")).filter((f) => f.endsWith(".json")).flatMap((f) => ((read(path.join(JOB, "dressing", f)).items ?? []) as any[]).flatMap((it) => (it.quest?.entity ? [it.quest.entity as string] : [])));
  out.stale = staleEntities(scene, poi, new Set([...ops.map((o) => o.id), ...questIds])); if (out.stale.length) faults.push(`stale entities after the build: ${out.stale.slice(0, 5).join(", ")}`);
  out.missing = ops.map((o) => o.id).filter((id) => !scene.entities[id]); if (out.missing.length) faults.push(`not in the lab scene: ${out.missing.slice(0, 5).join(", ")}`);
  out.uncleared = unclearedStructures(hand.siteDressing.keepClear, read(path.join(JOB, "clearings.json"))); if (out.uncleared.length) faults.push(`cover not cleared under: ${out.uncleared.join(", ")}`);
  const inWorld = new Set((recipe.features.clearings ?? []).map((c: any) => c.id)), lost = (read(path.join(JOB, "clearings.json")) as any[]).filter((c) => !inWorld.has(c.id)).map((c) => c.id);
  if (lost.length) faults.push(`clearings not installed in the lab world: ${lost.slice(0, 4).join(", ")}`);
  out.primitives = primitiveMeshes(ops); if (out.primitives.length) faults.push(`primitive meshes: ${out.primitives.join(", ")}`);
  const prefabs = ops.map((o) => o.entity?.components?.prefab?.prefabId).filter(Boolean); out.uncatalogued = prefabs.filter((id: string) => !findAsset(project, `prefabs/${id}.json`)); if (out.uncatalogued.length) faults.push(`uncatalogued: ${out.uncatalogued.join(", ")}`);
  if (hand.read?.duskLight !== false && !burnsAtDusk(prefabs)) faults.push("nothing burns at dusk");
  // evidence is taken after the last ops change (named by view, overwritten in place)
  const ev = path.join(JOB, "evidence"), newest = Math.max(...["ops.json", "world-ops.json", "operators.json", "clearings.json"].map((f) => fs.statSync(path.join(JOB, f)).mtimeMs));
  const shots = fs.existsSync(ev) ? fs.readdirSync(ev, { recursive: true } as any).map(String).filter((f) => f.endsWith(".png") && !/-failed.png$/.test(f)) : []; // a failed run's diagnostic picture is not evidence
  out.evidence = { shots: shots.length, fresh: shots.length > 0 && shots.every((f) => fs.statSync(path.join(ev, f)).mtimeMs >= newest) };
  const sj = path.join(JOB, "reports", "shots.json"), shotRun = fs.existsSync(sj) ? read(sj) : null;
  if (evidencePending) out.evidence.pending = true; // judged after the shots (all)
  else if (!out.evidence.fresh) faults.push(shotRun && !shotRun.ok && Date.parse(shotRun.at) >= newest ? `shots FAILED: ${shotRun.reason} (reports/shots.log)` : shots.length ? "evidence older than the ops: run shots again" : "no evidence yet: run shots");
  write(path.join(JOB, "reports", "place.json"), { ok: !faults.length, faults, ...out });
  return { ok: !faults.length, detail: faults.join("; ") || `reads along the approach (lines read ${out.read?.rows.filter((r: any) => r.reads).length}/${out.read?.rows.length}); clean` };
}

async function shots() {
  const port = opt("port") ?? "5291";
  // the views are the plan's: a view renamed by a later plan (read-1-152m -> read-1-142m) leaves no old picture behind
  fs.rmSync(path.join(JOB, "evidence", labWorld), { recursive: true, force: true });
  for (const f of ["boot", "play"]) fs.rmSync(path.join(JOB, "evidence", `${labWorld}-${f}-failed.png`), { force: true }); // a past failure's picture
  // L (shots, 2026-10-20 runs: a shot run hung ~60 min holding the heavy slot): a hard wall-clock cap, the whole process
  // tree (vite, the browser) killed on expiry and the stage FAILED with the reason; --shots-timeout <min> (default
  // max(15, spots x 2 x 50 s): the cap grows with the views, shotsCapMs); one stalled spot is skipped after 90 s (light-shots --spot-timeout)
  const nViews = (() => { try { return (read(path.join(JOB, "views.json")) as unknown[]).length; } catch { return 0; } })();
  const r = await toolTimed("shots", opt("shots-timeout") ? +opt("shots-timeout")! * 60_000 : shotsCapMs(nViews), ["tools/light-shots.mts", "--scene", labWorld, "--spots", path.join(JOB, "views.json"), "--times", "12,20", "--no-refs", "--weather-settle", "4", "--out", path.join(JOB, "evidence"), "--port", port, ...(opt("spot-timeout") ? ["--spot-timeout", opt("spot-timeout")!] : [])]); // --spot-timeout <s>: far read spots stream a lot of world (Wristgate 2026-10-28: 90 s timed out every trail view)
  const errLine = r.out.split("\n").map((l) => l.trim()).filter((l) => /^(\w*Error|STOP):/.test(l)).slice(-1).join(" | ");
  const reason = r.timedOut ? `TIMEOUT after ${r.s} s (--shots-timeout <min>; the run and its vite/browser killed)` : r.status ? (errLine || r.out.trim().split("\n").slice(-1)[0] || `exit ${r.status}`).slice(0, 300) : "";
  write(path.join(JOB, "reports", "shots.json"), { ok: !r.status, at: new Date().toISOString(), seconds: r.s, reason, log: "reports/shots.log" });
  console.log(r.status ? `shots FAILED: ${reason} (reports/shots.log)` : `shots: ${path.join(JOB, "evidence", `${labWorld}-sheet.png`)} (${r.s}s)`);
  if (r.status) process.exitCode = 1; else recordReadShot();
}
/** job.mjs stageBlock: past blockout needs progress.json evidence.readShot { file, viewpoint } (the place's defining read
 *  from a declared viewpoint at a readable hour): the approach read shot at noon, the plan's view names declared. */
function recordReadShot() {
  const views = (read(path.join(JOB, "views.json")) as any[]).map((v) => v.name as string), dir = path.join(JOB, "evidence", labWorld);
  // a bridge job's views are its contract cameras (no read-*/core-front): the first declared one with a picture
  // L (Wristgate 2026-10-28): a scene with no day-night clock shoots one `-interior` column (light-shots: no time axis);
  // the noon picture is then that one, never "no picture" (the stage could not leave blockout on a lab without a clock)
  const shotOf = (v: string) => [`${v}-12.png`, `${v}-interior.png`].find((f) => fs.existsSync(path.join(dir, f)));
  const pick = [...views.filter((v) => v.startsWith("read-")), "core-close", "core-front", ...views].find((v) => shotOf(v));
  if (!pick) { console.log(`readShot: no read or core-front picture in ${dir} (run shots)`); return; }
  const pf = path.join(JOB, "progress.json"), prog = fs.existsSync(pf) ? read(pf) : { version: 1, poiId: poi, ownerAgentId: "place-build", stage: "blockout", mode: "build" };
  prog.viewpoints = [...new Set([...(prog.viewpoints ?? []).filter((v: any) => typeof v === "string"), ...views])];
  prog.evidence = { ...(prog.evidence ?? {}), readShot: { file: path.relative(JOB, path.join(dir, shotOf(pick)!)).split(path.sep).join("/"), viewpoint: pick } };
  write(pf, prog); console.log(`readShot: ${prog.evidence.readShot.file} (${pick}) -> progress.json`);
}

function install() {
  const tw = opt("target-world") ?? world, dry = has("dry-run");
  if (has("uninstall")) return applyPlace(project, tw, { remove: true, dry });
  if (!dry) requireFinalReview(JOB);
  // the ground the work was proved on: live (without this place) vs the lab (without this place), 4 m grid over the pockets
  const plan = read(path.join(JOB, "reports", "plan.json")), live = ground(withoutPlace(read(worldFile(project, tw)))), labG = ground(withoutPlace(read(worldFile(lab, labWorld))));
  let d = 0; for (const k of plan.pockets) for (let x = -12; x <= 12; x += 4) for (let z = -12; z <= 12; z += 4) d = Math.max(d, Math.abs(live.height(k.at[0] + x, k.at[1] + z) - labG.height(k.at[0] + x, k.at[1] + z)));
  // L (install, Hagsheer 2026-10-20: the core road-band change moved the ground 0.24-0.94 m under five reviewed places):
  // a small drift re-seats the place's pieces on the live ground and gates float there; a large one is a re-plan
  const guard = installGuard(d); console.log(`install guard: live vs lab ground max ${d.toFixed(3)} m -> ${guard}`);
  if (guard === "refuse") fail(`the live ground differs from the lab under the place (max ${d.toFixed(3)} m > ${RESEAT_MAX_M} m): re-run place-build all`);
  applyPlace(project, tw, { dry });
  if (guard === "reseat" && !dry) reseatLive(tw);
}
/** Re-seat every entity of this place (tagged poi:<id>, dress-<id>-*) on the live solid through applyOps (inverse in
 *  <job>/install-seat-inverse.json), then the float rule on those entities: any still off or unsupported fails the
 *  install (the place stays installed; the coordinator re-plans or uninstalls). reports/install-float.json. */
function reseatLive(tw: string) {
  const SF = sceneFile(project, tw), reg = new ComponentRegistry(); registerCoreComponents(reg); registerChunkComponents(reg);
  let doc = read(SF);
  const ids = new Set(Object.keys(doc.entities).filter((id) => (doc.entities[id].tags ?? []).includes(`poi:${poi}`) || id.startsWith(`dress-${poi}-`)));
  const seat = seatPlaced(project, doc, ids);
  if (seat.ops.length) { const r = applyOps(doc, seat.ops as never, reg); doc = r.doc; write(SF, doc); write(path.join(JOB, "install-seat-inverse.json"), r.inverse); }
  const after = seatPlaced(project, doc, ids), bad = after.rows.filter((r) => r.status !== "ok");
  write(path.join(JOB, "reports", "install-float.json"), { ok: !bad.length, at: new Date().toISOString(), reseated: seat.ops.length, entities: ids.size, faults: bad });
  console.log(`install re-seat: ${seat.ops.length} op(s) on ${ids.size} entities; float on the live scene: ${bad.length ? `${bad.length} FAULT(S): ${bad.slice(0, 4).map((r) => `${r.id} ${r.status} gap ${r.gap}`).join("; ")}` : "no piece off or unsupported"}`);
  if (bad.length) fail(`float on the live scene after the re-seat: ${bad.length} fault(s) (reports/install-float.json)`);
}

// ---------------------------------------------------------------------------------------------------------------------
/** QUALITY (a zone, not one place): every installed place-build place graded on four measured lines in the LIVE world
 *  (core footprint vs its tier's floor, loose props per 100 m2 of the core area, built walls in the zone's built stone
 *  vs the terrain cliff tile, the landmark's pixel height in the read shot) -> <zone>/reports/poi-quality.md + .json,
 *  weakest first. `--shots` first re-takes the evidence in the live world in ONE light-shots run (per place: core-front,
 *  aerial-150 and the read view of the approach its footpath joins, at noon) -> <zone>/reports/poi-quality/<world>/
 *  <place>--<view>-12.png. L (Hagsheer 2026-10-21): the evidence of 28 places had only been judged one lab at a time. */
async function quality() {
  const Q = path.join(ZONE, "reports", "poi-quality"), PD = path.join(ZONE, "pois"), only = opt("only")?.split(",");
  const jobs = fs.readdirSync(PD).filter((id) => { try { const pr = read(path.join(PD, id, "progress.json")); return pr.ownerAgentId === "place-build" && pr.stage === "installed" && fs.existsSync(path.join(PD, id, "views.json")) && (!only || only.includes(id)); } catch { return false; } }).sort();
  const recipe = read(worldFile(project, world)), g = ground(recipe), reservations = read(path.join(ZONE, "reservations.json")).reservations ?? [];
  const segD = (q: V2, l: V2[]) => { let m = Infinity; for (let i = 0; i + 1 < l.length; i++) { const a = l[i]!, b = l[i + 1]!, dx = b[0] - a[0], dz = b[1] - a[1], L = dx * dx + dz * dz || 1, t = Math.max(0, Math.min(1, ((q[0] - a[0]) * dx + (q[1] - a[1]) * dz) / L)); m = Math.min(m, Math.hypot(q[0] - a[0] - t * dx, q[1] - a[1] - t * dz)); } return m; };
  /** the views a place is judged by: core-front, aerial-150 and the read view nearest the approach its footpath joins */
  const viewsOf = (id: string) => {
    const views = read(path.join(PD, id, "views.json")) as any[], hand = read(path.join(PD, id, "handoff.json")), res = reservations.find((r: any) => r.location === id);
    const lines = res ? approachLines(recipe, reservations, res).lines : [], line = lines[hand.read?.approachLine ?? 0] ?? lines[0] ?? [];
    const reads = views.filter((v) => v.name.startsWith("read-")).sort((x, y) => segD([x.x, x.z], line) - segD([y.x, y.z], line));
    return [views.find((v) => v.name === "core-close") ?? views.find((v) => v.name === "core-front"), views.find((v) => v.name === "aerial-150"), reads[0]].filter(Boolean);
  };
  if (has("shots")) {
    const spots = jobs.flatMap((id) => viewsOf(id).map((v: any) => ({ ...v, name: `${id}--${v.name}` }))), sf = path.join(Q, "spots.json");
    write(sf, spots); fs.rmSync(path.join(Q, world), { recursive: true, force: true });
    console.log(`quality shots: ${spots.length} views of ${jobs.length} places in the live ${world} (noon) -> ${path.relative(process.cwd(), Q)}`);
    const r = await runCapped([...TSX, "tools/light-shots.mts", "--scene", world, "--spots", sf, "--times", "12", "--no-refs", "--weather-settle", "4", "--out", Q, "--port", opt("port") ?? "5291"], +(opt("shots-timeout") ?? 80) * 60_000, path.join(Q, "shots.log"));
    console.log(r.status ? `quality shots FAILED (${r.timedOut ? "TIMEOUT" : `exit ${r.status}`}; ${path.join(Q, "shots.log")})` : `quality shots: ${r.s} s`);
    if (r.status) process.exitCode = 1;
  }
  const shotJson = path.join(Q, `${world}.json`), cams = new Map<string, number[]>();
  if (fs.existsSync(shotJson)) for (const s of read(shotJson).spots ?? []) if (s.camera) cams.set(s.name, s.camera);
  const scene = read(sceneFile(project, world)), E = scene.entities as Record<string, any>;
  const sizes = new Map<string, number[]>(); for (const p of [project, "world-kit"]) { const f = path.join(PROJECTS, p, "authoring", "dressing", "prop-index.json"); if (fs.existsSync(f)) for (const q of read(f).props ?? []) if (q.size && !sizes.has(q.id)) sizes.set(q.id, q.size); }
  const rows: QualityRow[] = [];
  for (const id of jobs) {
    const J = path.join(PD, id), hand = read(path.join(J, "handoff.json")), brief = read(path.join(J, "brief.json")), tier = (brief.adventureSize ?? hand.measurements?.adventureSize ?? "medium") as Tier;
    const area = (hand.siteDressing?.areas ?? []).find((a: any) => a.id === "core") ?? { centre: read(path.join(J, "reports", "plan.json")).centre, radius: 10 };
    const c = area.centre as V2, root = E[`poi-${id}`]?.components?.transform?.position ?? [0, 0, 0];
    const mine = Object.entries(E).filter(([eid, e]) => (e.tags ?? []).includes(`poi:${id}`) && e.components?.prefab?.prefabId).map(([eid, e]) => {
      const p = e.components.transform?.position ?? [0, 0, 0], w: V2 = e.parent === `poi-${id}` ? [root[0] + p[0], root[2] + p[2]] : [p[0], p[2]];
      return { eid, prefab: e.components.prefab.prefabId as string, at: w, dressed: (e.tags ?? []).includes("dressing") };
    });
    const ops = (fs.existsSync(path.join(J, "operators.json")) ? read(path.join(J, "operators.json")) : []) as any[], walls = ops.filter((o) => o.op === "wall");
    const reach = area.radius + 6, coreThings = mine.filter((m) => Math.hypot(m.at[0] - c[0], m.at[1] - c[1]) <= reach);
    const pts: V2[] = [...coreThings.map((m) => m.at), ...walls.filter((o) => String(o.id).startsWith(`pb-${id}-core-`)).flatMap((o) => o.points as V2[])];
    const floorR = POCKET_FLOOR_M[tier].core, diameter = spanOf(pts), coreFloor = Math.round(1.5 * floorR);
    const inArea = coreThings.filter((m) => m.dressed && Math.hypot(m.at[0] - c[0], m.at[1] - c[1]) <= area.radius), areaM2 = Math.round(Math.PI * area.radius * area.radius);
    const per100 = Math.round((inArea.length / areaM2) * 1000) / 10, dFloor = 1.0;
    const cliff = walls.filter((o) => wearsCliffTile(o.materials)).length, mats = [...new Set(walls.flatMap((o) => Object.values(o.materials ?? {}).flat() as string[]))];
    const bigRocks = mine.filter((m) => /^rock-kit\//.test(m.prefab) && (sizes.get(m.prefab)?.[1] ?? 0) >= 4).length;
    // the read: from the read view's camera (the shot's own, else the view spot at eye height) to the landmark / smoke
    const rv = viewsOf(id).find((v: any) => v.name.startsWith("read-")) as any, cam = rv ? cams.get(`${id}--${rv.name}`) : undefined;
    const eye: [number, number, number] | null = rv ? (cam as [number, number, number] | undefined) ?? [rv.x, g.height(rv.x, rv.z) + 1.7, rv.z] : null;
    const lm = hand.landmark, targets = [...(lm ? [{ what: "landmark", at: lm.at as V2, foot: lm.foot, top: lm.top, fogReach: lm.fogReach }] : []), ...((hand.smoke ?? []) as any[]).map((s) => ({ what: "smoke", at: s.at as V2, foot: g.height(s.at[0], s.at[1]), top: s.top, fogReach: s.fogReach }))];
    const best = eye ? targets.map((t) => ({ t, r: readPixels(g, eye, t) })).sort((x, y) => y.r.px - x.r.px)[0] : undefined;
    const row: Omit<QualityRow, "score"> = { id, tier, archetype: brief.archetype ?? "",
      core: { diameter, floor: coreFloor, ok: diameter >= coreFloor },
      density: { props: inArea.length, areaM2, per100, floor: dFloor, ok: per100 >= dFloor, coverCleared: coverClearedShare(c, area.radius, fs.existsSync(path.join(J, "clearings.json")) ? read(path.join(J, "clearings.json")) : []) },
      built: { walls: walls.length, cliff, materials: mats, bigRocks, ok: cliff === 0 },
      read: { view: rv?.name ?? null, distance: best?.r.distance ?? null, px: best?.r.px ?? null, floor: READ_PX_MIN, ok: (best?.r.px ?? 0) >= READ_PX_MIN, target: best?.t.what ?? null } };
    rows.push({ ...row, ribbons: ops.filter((o) => o.op === "path").map((o) => String(o.id).replace(`pb-${id}-`, "")), score: gradeScore(row) });
  }
  rows.sort((x, y) => x.score - y.score || x.id.localeCompare(y.id));
  const rel = (f: string) => path.relative(path.join(ZONE, "reports"), f).split(path.sep).join("/");
  // a live shot when --shots took one, else the job's own lab evidence (marked "lab"): the whole-world scene had not
  // booted in a headless browser inside 240 s (light-shots "timed out waiting for scene", Hagsheer 2026-10-21)
  const pic = (id: string, v: string | undefined) => {
    if (!v) return "";
    const f = path.join(Q, world, `${id}--${v}-12.png`), lab = path.join(ZONE, "pois", id, "evidence", `pb${id.replace(/[^a-z0-9]/g, "")}`, `${v}-12.png`);
    return fs.existsSync(f) ? `[${v.replace(/-\d+m$/, "")}](${rel(f)})` : fs.existsSync(lab) ? `[${v.replace(/-\d+m$/, "")} (lab)](${rel(lab)})` : "";
  };
  const md = [`# POI quality: ${zone} (${world})`, "",
    `Generated by \`place-build quality ${world} --zone ${zone}${has("shots") ? " --shots" : ""}\` on ${new Date().toISOString().slice(0, 16)}Z; ${rows.length} installed place-build places, LIVE world. Weakest first.`,
    `Lines: core = the built footprint (structures, walls, dressing within the core area + 6 m) across, floor 1.5 x the tier's core radius (${Object.entries(POCKET_FLOOR_M).map(([t, f]) => `${t} ${Math.round(1.5 * f.core)} m`).join(", ")}; site-standards class ${Object.entries(CLASS_FOOTPRINT_M).map(([t, m]) => `${t} ${m} m`).join(", ")}); props = loose dressing props per 100 m2 of the core area (floor 1.0); built = wall operators wearing the terrain cliff tile (no face material / \`zone\`); big rocks = rock-kit props >= 4 m (the zone cliff tile's slate patchwork shows on them up close: zone-texture pass, not this tool); read = the landmark or smoke column's visible pixel height in the noon read shot (1280 x 720, 60 deg), floor ${READ_PX_MIN} px. Score = sum of the four lines' ratios to their floors (max 4).`, "",
    "| # | place | tier / archetype | core across m (floor) | props / 100 m2 (n, area m2) | cover cleared | built: walls / cliff-tile | big rocks | read px @ m (target) | ribbon paths | score | live pictures (noon) |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
    ...rows.map((r, i) => `| ${i + 1} | ${r.id} | ${r.tier} / ${r.archetype} | ${r.core.ok ? "" : "**"}${r.core.diameter}${r.core.ok ? "" : "**"} (${r.core.floor}) | ${r.density.ok ? "" : "**"}${r.density.per100}${r.density.ok ? "" : "**"} (${r.density.props}, ${r.density.areaM2}) | ${r.density.coverCleared >= 0.6 ? `**${Math.round(r.density.coverCleared * 100)}%**` : `${Math.round(r.density.coverCleared * 100)}%`} | ${r.built.walls} / ${r.built.cliff ? `**${r.built.cliff}**` : 0} | ${r.built.bigRocks} | ${r.read.ok ? "" : "**"}${r.read.px ?? "-"}${r.read.ok ? "" : "**"} @ ${r.read.distance ?? "-"} (${r.read.target ?? "none"}) | ${r.ribbons.length ? `**${r.ribbons.join(", ")}**` : "-"} | ${r.score} | ${[pic(r.id, "core-front"), pic(r.id, "aerial-150"), pic(r.id, r.read.view ?? undefined)].filter(Boolean).join(" ")} |`),
    "", `Bold = under its floor. Faults per line: core ${rows.filter((r) => !r.core.ok).length}, props ${rows.filter((r) => !r.density.ok).length}, built ${rows.filter((r) => !r.built.ok).length}, read ${rows.filter((r) => !r.read.ok).length} of ${rows.length}. Ribbon footpaths (path operator; the owner rejected ribbon roads: carved + painted only): ${rows.filter((r) => r.ribbons.length).length} of ${rows.length} places, their approach included in ${rows.filter((r) => r.ribbons.includes("approach")).length} (an approach ribbon fails gate roads: "place-build approach" re-plans it as a carved + painted track; the rest are footpaths between pockets).`,
    `Cover cleared = share of the core area whose ground cover the place's clearings remove; >= 60% (bold) reads as one flat bare tile to the horizon: a dressing-density finding.`,
    `Not this tool (zone-texture pass owed): rock-kit props >= 4 m (column big rocks) and the world's big rock fins beside places wear the Hagsheer cliff tile, whose slate patchwork shows up close (rock >= 4 m cap tile pass).`, ""];
  fs.mkdirSync(path.join(ZONE, "reports"), { recursive: true });
  fs.writeFileSync(path.join(ZONE, "reports", "poi-quality.md"), md.join("\n"));
  write(path.join(ZONE, "reports", "poi-quality.json"), { world, zone, at: new Date().toISOString(), rows });
  for (const r of rows) console.log(`${String(r.score).padEnd(5)} ${r.id.padEnd(16)} core ${r.core.diameter}/${r.core.floor}  props ${r.density.per100}/100m2  cliff ${r.built.cliff}/${r.built.walls}  read ${r.read.px ?? "-"} px @ ${r.read.distance ?? "-"}`);
  console.log(`-> ${path.relative(process.cwd(), path.join(ZONE, "reports", "poi-quality.md"))}`);
}

function survey() {
  const res = (read(path.join(ZONE, "reservations.json")).reservations ?? []).find((r: any) => r.location === poi);
  const place = (read(path.join(ZONE, "brief.json")).places ?? []).find((p: any) => p.id === poi);
  const at = (opt("at")?.split(",").map(Number) ?? place?.site?.at ?? res?.center) as V2, R = +(opt("r") ?? 90), st = +(opt("step") ?? 10);
  const f = createWorldField(worldRecipeSchema.parse(withoutPlace(read(worldFile(project, world)))));
  console.log(`${poi} site ${at} (faces ${place?.site?.faces ?? "?"}), reservation r ${res?.radius}; rows = z, cols = x from ${at[0] - R} step ${st}`);
  for (let z = at[1] - R; z <= at[1] + R; z += st) { let row = String(Math.round(z)).padStart(6) + " "; for (let x = at[0] - R; x <= at[0] + R; x += st) row += f.waterY(x, z) !== null ? "  ~~~" : String(Math.round(f.height(x, z))).padStart(5); console.log(row); }
}

// ---------------------------------------------------------------------------------------------------------------------
/** BRIDGE (structure kind, tools/_place-bridge.mts): <job>/bridge.json { bridge: <bridgeSchema>, roads: [{ id, from:
 *  "start"|"end", points: [[x,z],...] (after the deck end), width?, joins? }], views: [{ name, camera: [x,y,z], target:
 *  [x,y,z] }] } -> the job files the rest of place-build reads (lab, build, gates, shots, install). Measured on the live
 *  world without this place; never writes the world or the scene. */
function bridgeJob() {
  const J = (f: string) => path.join(JOB, f), src = read(opt("spec") ?? J("bridge.json"));
  const brief = read(path.join(ZONE, "brief.json")), place = (brief.places ?? []).find((q: any) => q.id === poi) ?? fail(`no place ${poi} in ${ZONE}/brief.json`);
  const recipe = withoutPlace(read(worldFile(project, world))), f = createWorldField(worldRecipeSchema.parse(recipe));
  const gnd = (x: number, z: number) => Math.min(f.height(x, z), f.surfaceCast(x, z, 400, -50) ?? Infinity);
  const b = planBridge(src.bridge, gnd), Y = b.spec.deck.y, tw = b.spec.tower;
  const noMat = [...new Set(Object.values(b.spec.materials).flat())].filter((m) => !findAsset(project, `materials/${m}.json`));
  if (noMat.length) fail(`bridge materials not in ${project}'s closure: ${noMat.join(", ")}`);
  const opId = `${PREFIX}${b.spec.id}`, faults = [...b.faults], notes = [...b.notes];
  const worldOps: any[] = [];
  if (b.spec.start.kind === "gate-tower") worldOps.push({ edit: "add-feature", kind: "heightPatches", feature: lowerPatch(`${PREFIX}gate`, b.frame.origin, b.frame.dir, tw.passage.width / 2 + 0.6, -tw.size / 2 - 3, tw.size / 2 + 1, (s) => (s < -tw.size / 2 ? Y - 0.05 : Y - b.spec.deck.paving - 0.05), gnd) }); // the mouth flush with the deck, under the passage paving
  // the roads: carved + painted recipe roads from each deck end, pinned to the deck height (flush, no step)
  const tracks: any[] = [], routes: any[] = [], network: V2[][] = [];
  for (const r of (src.roads ?? []) as any[]) {
    const end = r.from === "start" ? b.ends.start : b.ends.end, pts: V2[] = [[end[0], end[2]], ...(r.points as V2[])], id = `road-${PREFIX}${r.id}`;
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), `pb-road-${poi}-`)), rf = path.join(tmp, "recipe.json"), out = path.join(tmp, "built.json");
    try {
      fs.writeFileSync(rf, JSON.stringify(recipe));
      const t = tool(`road-${r.id}`, ["tools/worldgen.mts", "road", world, "--recipe", rf, "--id", id, "--points", pts.map((q) => `${q[0]},${q[1]}`).join(";"), "--width", String(r.width ?? 5),
        "--max-grade", String(r.maxGrade ?? 0.18), "--max-cut", String(r.maxCut ?? TRACK_CUT_M), "--max-fill", String(r.maxFill ?? TRACK_FILL_M), "--tread-cut", String(TRACK_CUT_M), "--tread-fill", String(TRACK_FILL_M), "--pin-start", String(Y), "--keep-landforms", "--dry-run", "--out", out]); // a bridge road is no obstacle to cliffs either (as tracks, l.112)
      if (t.status || !fs.existsSync(out)) fail(`road ${id}: worldgen road failed (reports/road-${r.id}.log): ${t.out.trim().split("\n").slice(-2).join(" | ")}`);
      const built = read(out) as { roads: any[]; bridges: any[] };
      console.log(`  ROAD: ${t.out.split("\n").find((l) => l.includes(`${id}:`))?.trim() ?? id}`);
      worldOps.push(...built.roads.map((q) => ({ edit: "add-feature", kind: "roads", feature: q })), ...built.bridges.map((q) => ({ edit: "add-feature", kind: "bridges", feature: q })));
    } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
    let len = 0; for (let i = 1; i < pts.length; i++) len += Math.hypot(pts[i]![0] - pts[i - 1]![0], pts[i]![1] - pts[i - 1]![1]);
    tracks.push({ id, width: r.width ?? 5, from: r.joins ?? r.id, lengthM: Math.round(len) });
    const dense: number[][] = [];
    for (let i = 0; i + 1 < pts.length; i++) { const a = pts[i]!, c = pts[i + 1]!, n = Math.max(1, Math.ceil(Math.hypot(c[0] - a[0], c[1] - a[1]) / 6)); for (let k = 0; k < n; k++) dense.push([a[0] + ((c[0] - a[0]) * k) / n, 0, a[1] + ((c[1] - a[1]) * k) / n]); }
    dense.push([pts[pts.length - 1]![0], 0, pts[pts.length - 1]![1]]);
    for (const q of dense) q[1] = f.height(q[0]!, q[2]!);
    dense[0]![1] = Y;
    routes.push({ id: `${r.id}-road`, note: `the ${r.id} road from the deck end to ${r.joins ?? "the trail"}`, points: dense.map((q) => q.map((v) => Math.round(v * 100) / 100)) });
    network.push(pts);
  }
  const deckRoute = { id: "deck", note: "the deck end to end (the gate passage included)", onBuilt: true, points: b.walk };
  const hub = b.hub, Rm = (v: number) => Math.round(v * 100) / 100;
  const hand: any = {
    version: 1, poiId: poi, ownerAgentId: "place-build", builder: { tool: "place-build", kind: "bridge" }, stage: "blockout",
    integration: { sceneOps: "ops.json", worldOps: "world-ops.json + operators.json", clearings: "clearings.json" },
    measurements: { adventureSize: place.size ?? "medium", features: [{ id: "bridge", kind: "landmark", linkedTo: [] }], approaches: routes.map((r) => r.id),
      measuredCombinedUsableAreaM2: Math.round(b.spec.deck.width * (b.report.deckLength as number)), usableAreaMethod: "deck walk area (place-build bridge: a bridge's usable ground is its deck)" },
    navigation: { routes: [deckRoute, ...routes], network: [[b.ends.start, b.ends.end].map((q) => [q[0], q[2]]), ...network] },
    siteDressing: { lights: "town", areas: [], keepClear: [{ id: "deck", why: "structure bridge deck", points: [[b.ends.start[0], b.ends.start[2]], [b.ends.end[0], b.ends.end[2]]], width: b.spec.deck.width + 2 * b.spec.parapet.thickness }] },
    landmark: { at: hub, foot: Rm(gnd(hub[0], hub[1])), top: Rm(b.top), fogReach: b.spec.fog.fogReach },
    smoke: [], read: { duskLight: false, reason: "lamps and the gate lantern are the LIGHT role's (contract section 5, installed after the coordinator's look)", approachLine: 0 },
    viewpoints: (src.views ?? []).map((v: any) => ({ name: v.name, x: v.camera[0], z: v.camera[2] })),
    approachTrack: tracks[0] ?? null, approachTracks: tracks, bridge: { operator: opId, report: b.report },
  };
  const clearings = [
    ...(b.spec.start.kind === "gate-tower" ? [{ id: `${poi}-gate-tower`, center: [Rm(b.frame.origin[0]), Rm(b.frame.origin[1])], radius: tw.size / 2 + 4, feather: 2, keep: 0, scatter: true, cover: true, owner: poi, walk: false }] : []),
    { id: `${poi}-deck-end`, center: [Rm(b.ends.end[0]), Rm(b.ends.end[2])], radius: 8, feather: 2, keep: 0, scatter: true, cover: true, owner: poi, walk: false },
  ];
  const views = [...(src.views ?? []).map((v: any) => ({ name: v.name, x: v.camera[0], z: v.camera[2], y: v.camera[1] - 1.7, camera: v.camera, target: v.target })),
    { name: "aerial-150", x: hub[0], z: hub[1], y: Y, facing: Math.round(((b.frame.yaw * 180) / Math.PI + 90 + 360) % 360), pitch: 0.6, distance: 150 }];
  const ops = [{ op: "add-entity", id: `poi-${poi}`, entity: { name: place.name ?? poi, parent: null, tags: ["poi", `zone:${zone}`, `poi:${poi}`], components: { transform: { position: [hub[0], Y, hub[1]] } } } }];
  fs.mkdirSync(path.join(JOB, "dressing"), { recursive: true });
  write(J("brief.json"), { id: poi, name: place.name, adventureSize: place.size ?? "medium", archetype: "bridge", sets: [], place });
  write(J("handoff.json"), hand); write(J("ops.json"), ops); write(J("world-ops.json"), worldOps);
  write(J("operators.json"), [{ id: opId, op: "landmark", ...b.landmark }]);
  write(J("clearings.json"), clearings); write(J("encounter-clearings.json"), []); write(J("prop-requests.json"), []);
  write(J("views.json"), views); write(J("walk-route.json"), deckRoute);
  if (!fs.existsSync(J("progress.json"))) write(J("progress.json"), { version: 1, poiId: poi, ownerAgentId: "place-build", stage: "blockout", mode: "build" });
  const pockets = [{ id: "core", at: hub, y: Y }, { id: "start", at: [b.ends.start[0], b.ends.start[2]], y: Y }, { id: "end", at: [b.ends.end[0], b.ends.end[2]], y: Y }];
  write(J("reports/bridge.json"), { at: new Date().toISOString(), operator: opId, bases: b.bases, report: b.report, faults, notes, ends: b.ends });
  write(J("reports/plan.json"), { archetype: "bridge", sets: [], site: null, centre: hub, padY: Y, front: b.frame.dir, faults, notes, adventureSize: place.size ?? "medium", tierDowngrade: null, pockets: pockets.map((k) => ({ ...k, relief: 0, ok: true, why: "bridge" })), usableAreaM2: hand.measurements.measuredCombinedUsableAreaM2, bridge: b.report });
  console.log(`bridge ${poi}: ${opId} ${b.report.deckLength} m deck at y ${Y}, ${(b.report.piers as any[]).length} piers, ${(b.report.arches as any[]).length} arches, ${b.bases.length} bases, ${tracks.length} road(s) -> ${path.relative(process.cwd(), JOB)}`);
  for (const n of notes) console.log(`  NOTE: ${n}`);
  for (const x of faults) console.log(`  FIT: ${x}`);
  if (faults.length) process.exitCode = 1;
}

const ID_CMDS = new Set(["bridge", "survey", "plan", "props", "approach", "dress", "lab", "build", "gates", "shots", "all", "install", "evidence"]);
if (cmd === "archetypes") { for (const { a } of archetypes()) console.log(`${a.id.padEnd(14)} ${a.pockets.length} pockets  ${a.description}`); }
else if (cmd === "lift") { const { liftCommand } = await import("./_place-lift.mts"); await liftCommand(argv.slice(1)); } // a winch lift beside a long descent (tools/_place-lift.mts)
else if (cmd === "quality") { if (!world || !zone) fail("usage: place-build quality <world> --zone <z> [--shots] [--only a,b] [--port p]"); await quality(); }
else if (ID_CMDS.has(cmd ?? "")) {
  if (!world || !zone || !poi) fail("usage: place-build <command> <world> --zone <z> --location <id> [--project p]");
  const t0 = Date.now();
  if (cmd === "survey") survey();
  if (cmd === "bridge") bridgeJob();
  if (cmd === "approach") { approachOnly = true; plan(); }
  if (cmd === "dress") redress(); // the dressing only, round the place as built
  if (cmd === "plan" || cmd === "all") plan();
  if (cmd === "props") await layoutPropsSheet(); // the layout's hero-prop sheet (no browser): before a chain
  if (cmd === "lab" || cmd === "all" || (cmd === "build" && !fs.existsSync(path.join(PROJECTS, lab)))) makeLab();
  if (cmd === "build" || cmd === "all") {
    // gate 16: nothing is built before the place is designed — premise, journey, areas, story elements made of catalogued
    // things (the sample frames and the design review come after the build: `gates` and `install` ask for them)
    const df = designFaults(JOB, undefined, { sample: false });
    if (df.length) { console.error(`STOP (design gate 16): write ${path.join(JOB, "design.json")} first —\n  ${df.join("\n  ")}`); process.exit(1); }
    applyPlace(lab, labWorld);
  }
  if (cmd === "gates" || cmd === "all") { evidencePending = cmd === "all"; gates(); evidencePending = false; }
  if (cmd === "shots" || cmd === "all") await shots();
  if (cmd === "all") { gates(["place"]); process.exitCode = read(path.join(JOB, "reports", "gates.json")).ok ? 0 : 1; } // the evidence check again, now the shots are newer than the ops; the exit is the final table
  if (cmd === "evidence") recordReadShot(); // the read shot from pictures already taken (no browser)
  if (cmd === "install") install();
  console.log(`(${cmd} ${poi}: ${Math.round((Date.now() - t0) / 1000)} s)`);
} else fail("usage: place-build archetypes | plan|lab|build|gates|shots|all|install <world> --zone <z> --location <id> [...]  (header of tools/place-build.mts)");

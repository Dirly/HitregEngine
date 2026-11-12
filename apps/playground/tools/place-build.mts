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
 *                                       Also MIGRATES an old job's footpath ribbons (`path` operators, removed 2026-10-30) to
 *                                       carved + painted footpath tracks (road-pb-<id>-to-<pocket>) on the same lines.
 *     tracks                            ONLY that migration (no approach re-plan, no build): old footpath ribbons -> tracks.
 *     dress                             re-lay the DRESSING only (vignettes by pocket role, from the live plans; quest objects kept)
 *     lab    [--lab <name>]             (re)make the lab project projects/<lab>/ (default pb-<id>) from the LIVE world + scene,
 *                                       the place's own entities and features taken out; CROPPED to the job's box (pieces,
 *                                       patches, routes, view cameras + 96 m: lab-box.json, voxelWorld.bounds), its ground
 *                                       proved identical to live inside it (tools/_lab-crop.mts); --whole-world copies all
 *     lab-spawn [--lab <name>] [--dry-run]  an EXISTING lab (cropped or --whole-world): start the player + camera at the place (where its reservation's
 *                                       approach arrives, facing its centre) and give it the game shell (tools/game-shell.mts);
 *                                       nothing else rebuilt. `lab` does the same on every remake.
 *     build  [--lab <name>]             apply the job to the lab (scene ops, pads, operators + wall bakes, clearings, sockets,
 *                                       dressing plans): the same code path as `install`
 *   (plan / all / build / shots take --sample: the design's sample area before design-review, needs only the `design`
 *    stage, lab only, never install)
 *   (lab / build / gates also take --job <dir>: a copy of the job dir, so a tools proof never writes the owner's job)
 *     gates  [--lab <name> | --live] [--only a,b]  every install gate on the lab (--live: on the live world after install) -> <job>/reports/*.json + reports/gates.json (table)
 *     scale  [--lab <name> | --live]    a PAINTED place against its painting: <job>/concept-marks.json (each hero piece's painted
 *                                       pixel box) vs the built pieces projected through the painting's own camera; > 15 % off
 *                                       fails -> reports/scale.json (also the gates' `scale` row; the install guard reads it)
 *     shots  [--lab <name>] [--port 5291] [--shots-timeout 15]  (hard cap, minutes) play-mode pictures from views.json at hours 12 and 20 -> <job>/evidence/ (iso-ne / iso-sw overviews first, noon only, review-only)
 *            --views <a,b> --merge [--spot-timeout 600]   re-shoot ONLY those views and merge them into the evidence run (frames
 *                                       overwritten in place, wash judged again over the merged set); the wash gate prints this command
 *     all    [--archetype a] [--set ..] [--port p] [--shots]   plan -> lab -> build -> gates (-> shots only with --shots:
 *                                       Derek 2026-10-31, no per-place shot runs while building; render-batch shoots after install)
 *     evidence                          record progress.json evidence.readShot (+ viewpoints) from pictures already taken
 *                                       (shots does it itself; job.mjs refuses any stage past blockout without it)
 *     install [--dry-run] [--uninstall] [--target-world <w>] [--draft [--draft-note "<dated go>"]]   (geometry gates only: no shots asked) the LIVE world + scene (coordinator; refused without a fresh
 *                                       reviewer's PASS: job.mjs requireFinalReview). Idempotent: whatever this place had is
 *                                       removed first (entities tagged poi:<id>, features pb-<id>-*, clearings owned by <id>),
 *                                       so a re-install never keeps a stale piece; --uninstall removes only.
 *                                       --draft (Derek 2026-11-03, i-drafts): a half-finished place AS IT IS, with no review
 *                                       stage asked (they stay open): every geometry guard still runs (job.mjs draftInstallBlock:
 *                                       float, water edges, walk, the 6 m rule and the lab gates table's geometry rows; the
 *                                       ground guard; the overlap with other places, roads, towns and live reservations ->
 *                                       reports/draft-overlap.json); the root is tagged `draft`, `installed` records the note
 *                                       (default "draft install, Derek 2026-11-03"), progress.json `draftInstalls` what is open.
 *                                       `build --draft` builds the lab without design-review (the design gate printed, not refused);
 *                                       `plan --draft` only for a job with the owner's layout.json (expanded as it is, no re-design).
 *   node node_modules/tsx/dist/cli.mjs tools/place-build.mts lift <plan|gate|install|uninstall> <world> --zone <z> --location <poi> --lift <id> ...
 *                                       a winch LIFT (structure kind) beside a long descent: tools/_place-lift.mts
 *   node node_modules/tsx/dist/cli.mjs tools/place-build.mts bridge <world> --zone <z> --location <id> [--spec <file>]
 *                                       a BRIDGE place (structure kind, tools/_place-bridge.mts): <job>/bridge.json { bridge, roads,
 *                                       views } -> the job files (one built landmark operator, the gate passage patch, carved +
 *                                       painted roads pinned flush to the deck ends, routes, views); then lab -> build -> gates -> shots
 *   node node_modules/tsx/dist/cli.mjs tools/place-build.mts render-batch <world> --zone <z> --places a,b,c [--port p]
 *        [--night auto|off] [--extra <spots.json>] [--batch <id>] [--spot-timeout 300] [--lock-wait 240] [--dry-run]
 *                                       the BATCH RENDER after a batch install (tools/_render-batch.mts): ONE light-shots run
 *                                       over the LIVE world (one browser, shaders warm) in the render lock; per place iso-ne,
 *                                       iso-sw first, then core-close/core-front, its approach read view and its views.json
 *                                       `batch: true` views (20:00 too where the live place has lights); a stalled spot is
 *                                       skipped and listed. -> <job>/evidence/live/<batch>/ + <batch>.json (its evidence
 *                                       record, read shot recorded), <zone>/reports/batches/<batch>/sheet-<place>.png +
 *                                       index.json. The SHOT rows (wash, read, design sample, see-through) are judged
 *                                       there, never on the install path; a fault is a fix round.
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
import { artFor, placeBuildGate, recordPlaceStage, requirePlaceStage, stampsInstalled } from "./world-order.mts";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { runCapped, shotsCapMs } from "./_run-capped.mts";
import { seatPlaced } from "./float.mts";
import { skinPlacedOps } from "./rock-skins.mts";
import { applyOps, applyRecipeEdits, ComponentRegistry, createWorldField, registerChunkComponents, registerCoreComponents, REMOVED_RIBBON_OPS, regionAt, worldRecipeSchema } from "@hitreg/core";
import { assetIds, findAsset, PROJECTS } from "./_closure.mjs";
import {
  sinkToBase, seatPad, mergeSeatPads, type SeatPadRaw, padPatch, applySets, silhouetteHeight, SILHOUETTE_RATIO, arrangeFirstPlan, DENIED_PROPS, approachLines, nearestOnApproach, featureCoverage, burnsAtDusk, forTier, newZfightClusters, approachReadAny, fillOk, installGuard, RESEAT_MAX_M, routeOnTrack, hull, readBand, pickArchetype, roomFill, placeArchetypeSchema, planPlace, primitiveMeshes, siteSearch, staleEntities, unclearedStructures, uniqueItemIds, usableArea, footprintRim, type PlaceArchetype, type PlaceGround, type PlaceTier, type SiteBlockers, type SiteChoice,
  caveWalkRoute, type CaveWalk, ribbonsDeclared, footpathTrackId, FOOTPATH_WIDTH_M, approachForBuilt, trackId, trimTrack, TRACK_CUT_M, TRACK_FILL_M, type ApproachTrack, type PlacePlan,
  fillerFor, requestedShortfall, type PlanDrop, placeLayoutSchema, withLayout, expandFields, expandCrops, campLayout, campRuleFaults, stoneFamilyFaults, stonePieceFaults, standardFaults, STONE_PIECE_RE, placeFacing, layoutCoverage, layoutSizeWarn, type PlaceLayout, toWorld, gradePatch, hollowPatch,
  SHELTER_LEVEL_M,
  placeSceneRemoves, placeWorldRebase,
} from "./_place-archetype.mts";
import os from "node:os";
import { mergeCommand, mergeShotRuns, missingViews } from "./_shots-merge.mts";
import { excuseWashFaults, isReviewShot, judgeRun, washRun, type WashRuling } from "./_light-wash.mts";
import { jobIsoViews, withIsoViews } from "./_iso-views.mts";
import { batchId, batchSpots, batchTimes, composeSheet, dropSpots, mergeRuns, poseFaults, spotTiming, pruneOldBatches, salvageRun, sheetRows, shotEvidence, skippedSpots, splitRun, SEP, type BatchPlace, type Run, type ShotRow } from "./_render-batch.mts";
import { fileURLToPath } from "node:url";
import { baseGap, lowerPatch, planBridge } from "./_place-bridge.mts";
import { drawnGround, walkField, walkGround, walkGroundFrom } from "./_ground.mts";
import { wallSeat } from "./_wall-seated.mts";
import { abutGap, ABUT_GAP_M, baseOutline, measuredFooting, seatedCounts, seatedExclusion, coverClearedShare, isLeaned, orientBase, scaleBase, seatGap, SEAT_GAP_M, toWorldYaw, type BaseOutline } from "./_place-quality.mts";
import { prefabGeometry, projectedTexels, sceneGeometry, texelDensity } from "./_prop-geometry.mts";
import { decodePng as decodePngSync } from "./_png.mjs";
import { compareExtent, compareMark, conceptMarksSchema, paintedViews, screenBox, type ConceptMarks, type ExtentReport, type ScaleRow } from "./_place-scale.mts";
import { CLASS_FOOTPRINT_M, FLAT_BASE_M, FLUSH_SINK_M, planeSeatKind, PLATE_TILT_MAX_DEG, SKIRT_MIN_FILL, THIN_PIECE_M, THIN_TILT_MAX_DEG, thinTiltSeat, upFaces, type UpFace, gradeScore, heightForPx, POCKET_FLOOR_M, READ_PX_MIN, readPixels, spanOf, wearsCliffTile, type QualityRow, type Tier } from "./_place-quality.mts";
// @ts-ignore untyped engine tool module
import { designFaults, jobExceptions, opsHash, requireFinalReview, seeThroughBlock, setStage, sizeRulingFor } from "../../../tools/poi-review/job.mjs";
// @ts-ignore untyped engine tool module
import { tierFor } from "../../../tools/poi-review/size-tiers.mjs";
import { builtStoneSet, zonePalette } from "./_zone-palette.mts";
import {propPolicy} from './_prop-curation.mts';
import { removalsOf, updateJsonFile } from "./_scene-write.mts";
import { approachArrival, cropRecipe, cropScene, featureExtent, labBox, labShell, labSpawn, viewPoints, type LabBox } from "./_lab-crop.mts";
import { placeRuleFor, prefabInfo, solveScenePieces, solveLine, repeatsInOps, PLACE_SOLVE_FILE } from "./_place-solve.mts";

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
// --job <dir>: a COPY of a place's job (a tools proof, an A/B) built and gated without touching the owner's job dir;
// lab/build/gates only (install refuses a copied job)
const JOB = opt("job") ? path.resolve(opt("job")!) : path.join(PROJECTS, project, "authoring", "zonegen", world, "zones", zone, "pois", poi);
if (opt("job") && cmd === "install") fail("install runs on the place's own job, never a --job copy");
const ZONE = path.join(PROJECTS, project, "authoring", "zonegen", world, "zones", zone);
// `gates --live`: the same gates on the LIVE world + scene after an install (the place is in it; float/scatter-float then
// compare live with itself, so they report only the absolute verdict of the tools run)
const LIVE = has("live") && (cmd === "gates" || cmd === "scale");
// a --lab <name> other than the default gets its own world id (two labs of one place never register the same world)
const lab = LIVE ? project : opt("lab") ?? `pb-${poi}`, labWorld = LIVE ? world : lab === `pb-${poi}` ? `pb${poi.replace(/[^a-z0-9]/gi, "")}` : lab.replace(/[^a-z0-9]/gi, "");
const TSX = ["--max-old-space-size=6144", "node_modules/tsx/dist/cli.mjs"];
const PREFIX = `pb-${poi}-`;
/** The placement solver is OPT-IN (`--solver`) until it matches or beats the legacy seat (seatStructure, seat pads, layout
 *  `lift`) on Red Dial and the smalls (coordinator 2026-10-30: build 7 regressed float/zfight/walk/dress/art). Default and
 *  `--legacy-seat`: the legacy seat. Loose props ALWAYS get dress apply's `--solve` (keep-outs + the spread-aware support
 *  move; coordinator 2026-10-30: without it rubble keeps landing on steps), whichever seat the structures get. The legacy
 *  seat still hands a piece with a catalogue `placeRule.foundation` to the solver where it would raise, skirt or bury it
 *  (r-found 2026-10-30: a foundation skirt at the layout spot, no raise pad; _place-quality legacyFounds). */
const LEGACY_SEAT = !has("solver") || has("legacy-seat");

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
// The line is folded into the network (`worldgen road`: a run beside an existing road is dropped and the pieces end ON it;
// Derek 2026-10-31 "criss-crossing and overlapping"). A place's own designed road (layout roads: an avenue) is kept whole
// (keepParallel) and the paths fold into it instead.
function gradeTrack(recipe: any, t: ApproachTrack | null, keepParallel = false): any[] {
  if (!t) return [];
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), `pb-track-${poi}-`)), rf = path.join(tmp, "recipe.json"), out = path.join(tmp, "built.json");
  try {
    fs.writeFileSync(rf, JSON.stringify(recipe));
    const r = tool("track", ["tools/worldgen.mts", "road", world, "--recipe", rf, "--id", t.id, "--points", t.points.map((q) => `${q[0]},${q[1]}`).join(";"), "--width", String(t.width),
      "--max-grade", String(t.maxGrade), ...(t.surface ? ["--surface", t.surface] : []), "--max-cut", String(TRACK_CUT_M), "--max-fill", String(TRACK_FILL_M), "--tread-cut", String(TRACK_CUT_M), "--tread-fill", String(TRACK_FILL_M), "--keep-landforms", ...(keepParallel ? ["--keep-parallel"] : []), "--dry-run", "--out", out]);
    if (r.status || !fs.existsSync(out)) fail(`approach track ${t.id}: worldgen road failed (reports/track.log): ${r.out.trim().split("\n").slice(-2).join(" | ")}`);
    const built = read(out) as { roads: any[]; bridges: any[] };
    console.log(`  TRACK: ${r.out.split("\n").find((l) => l.includes(`${t.id}:`))?.trim() ?? t.id}`);
    return [...built.roads.map((f) => ({ edit: "add-feature", kind: "roads", feature: f })), ...built.bridges.map((f) => ({ edit: "add-feature", kind: "bridges", feature: f }))];
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
}
/** The zone's PATH surface a footpath track wears (owner ruling 2026-10-30): the place's zone `ground.road` tile (a nested
 *  zone with none takes its parent's), when the palette has it; undefined = `worldgen road`'s default. */
function zonePathSurface(recipe: any): string | undefined {
  const regions = (recipe.regions ?? []) as any[], names = new Set(((recipe.surfaces ?? []) as any[]).map((s) => s.name));
  let r = regions.find((x) => x.id === zone);
  for (let hop = 0; r && !r.ground?.road && r.within && hop < 4; hop++) r = regions.find((x) => x.id === r.within);
  const s = r?.ground?.road;
  return s && names.has(s) ? s : undefined;
}
const onZonePath = (recipe: any) => (t: ApproachTrack): ApproachTrack => { const s = t.surface ?? zonePathSurface(recipe); return s ? { ...t, surface: s } : t; };
function withoutPlace(w: any) { const features: any = {}; for (const [k, v] of Object.entries(w.features ?? {})) features[k] = Array.isArray(v) ? v.filter((f) => !ownsFeature(f)) : v; return { ...w, features }; }
/** A prop's catalogue dressing declaration (the prefab root's `dressing` component), for the plan's culture checks. */
type PropInfo = { cultures?: string[]; height?: number; size?: number[]; footing?: number; facesCentre?: "+z" | "-z" | "+x" | "-x"; shelter?: boolean; underCover?: boolean; centrepiece?: boolean; fire?: boolean };
const propInfoCache = new Map<string, PropInfo | null>();
let placementPolicy:ReturnType<typeof propPolicy>|undefined;
function propInfo(prefab: string): PropInfo | null {
  (placementPolicy??=propPolicy(PROJECTS,project)).assertAllowed(prefab);
  if (!propInfoCache.has(prefab)) { const f = findAsset(project, `prefabs/${prefab}.json`); let d: any = null;
    try { const j = f ? read(f) : null; d = Object.values(j?.entities ?? {}).map((e: any) => e?.components?.dressing).find(Boolean) ?? null; } catch {}
    propInfoCache.set(prefab, d ? { cultures: d.cultures, height: Array.isArray(d.size) ? d.size[1] : undefined, size: Array.isArray(d.size) ? d.size : undefined, ...(Number(d.footing) > 0 ? { footing: Number(d.footing) } : {}), ...(d.facesCentre ? { facesCentre: d.facesCentre } : {}), ...(d.shelter ? { shelter: true } : {}), ...(d.underCover ? { underCover: true } : {}), ...(d.centrepiece ? { centrepiece: true } : {}), ...(d.fire ? { fire: true } : {}) } : null); }
  return propInfoCache.get(prefab)!;
}
/** The ground skin of the region chain at a point (place region -> zone -> parent): the first `ground` map up the chain, else the
 *  zone region's (wearSurface: layout wear paints the zone's own earth, never the generic `dirt`). */
function zoneGroundAt(recipe: any, at: readonly number[], zone: string): Record<string, string> | null {
  const regions = (recipe.regions ?? recipe.features?.regions ?? []) as any[];
  for (let r = regionAt(regions, at[0]!, at[1]!, { places: true }), k = 0; r && k < 4; r = regions.find((x) => x.id === r!.within) ?? null, k++) if (r.ground) return r.ground;
  return regions.find((x) => x.id === zone)?.ground ?? null;
}
/** Mean colour (area weighted) of the texels a prefab's model draws: each textured triangle sampled at its centroid and
 *  three inner points on the page it really samples (glTF pages v * H, material pages (1 - v) * H when flipY). null when
 *  nothing it draws is textured. For the stone-piece check (stonePieceFaults). */
const colourCache = new Map<string, [number, number, number] | null>(), pageCache = new Map<string, { width: number; height: number; data: Uint8Array } | null>();
function drawnColour(prefab: string): [number, number, number] | null {
  if (colourCache.has(prefab)) return colourCache.get(prefab)!;
  let out: [number, number, number] | null = null;
  try {
    const geo = prefabGeometry(path.join(PROJECTS, project, "assets"), prefab), acc = [0, 0, 0]; let wsum = 0;
    for (const t of geo.tris) {
      const tex = t.tex; if (!tex || !t.uv || t.uv.length < 3) continue;
      const key = tex.file ?? tex.key; if (!pageCache.has(key)) { let pg = null; try { pg = tex.bytes ? decodePngSync(tex.bytes) : tex.file && /\.png$/i.test(tex.file) ? decodePngSync(fs.readFileSync(tex.file)) : null; } catch { pg = null; } pageCache.set(key, pg); }
      const pg = pageCache.get(key); if (!pg) continue;
      const e1 = [t.b[0] - t.a[0], t.b[1] - t.a[1], t.b[2] - t.a[2]], e2 = [t.c[0] - t.a[0], t.c[1] - t.a[1], t.c[2] - t.a[2]];
      const area = 0.5 * Math.hypot(e1[1]! * e2[2]! - e1[2]! * e2[1]!, e1[2]! * e2[0]! - e1[0]! * e2[2]!, e1[0]! * e2[1]! - e1[1]! * e2[0]!); if (!(area > 0)) continue;
      for (const [wa, wb] of [[1 / 3, 1 / 3], [0.6, 0.2], [0.2, 0.6], [0.2, 0.2]] as const) {
        const u = t.uv[0]![0] * wa + t.uv[1]![0] * wb + t.uv[2]![0] * (1 - wa - wb), v = t.uv[0]![1] * wa + t.uv[1]![1] * wb + t.uv[2]![1] * (1 - wa - wb);
        const fu = ((u * (tex.repeat?.[0] ?? 1)) % 1 + 1) % 1, fv = ((v * (tex.repeat?.[1] ?? 1)) % 1 + 1) % 1;
        const x = Math.min(pg.width - 1, Math.floor(fu * pg.width)), y = Math.min(pg.height - 1, Math.floor((tex.flipY ? 1 - fv : fv) * pg.height)), i = (y * pg.width + x) * 4;
        if (pg.data[i + 3]! < 8) continue;
        for (let k = 0; k < 3; k++) acc[k]! += pg.data[i + k]! * area; wsum += area;
      }
    }
    out = wsum > 0 ? [acc[0]! / wsum, acc[1]! / wsum, acc[2]! / wsum] : null;
  } catch { out = null; }
  colourCache.set(prefab, out); return out;
}
/** The zone's cliff tile mean colour at a point (the region chain's ground.cliff surface -> its map), for stonePieceFaults. */
function zoneCliffColour(recipe: any, at: readonly number[], zone: string): [number, number, number] | null {
  const name = zoneGroundAt(recipe, at, zone)?.cliff, surf = ((recipe.surfaces ?? []) as any[]).find((x) => x.name === name);
  const f = surf?.map ? findAsset(project, `textures/${surf.map}`) : null; if (!f || !/\.png$/i.test(f)) return null;
  const pg = decodePngSync(fs.readFileSync(f)), acc = [0, 0, 0]; let n = 0;
  for (let i = 0; i < pg.width * pg.height; i++) { if (pg.data[i * 4 + 3]! < 8) continue; for (let k = 0; k < 3; k++) acc[k]! += pg.data[i * 4 + k]!; n++; }
  return n ? [acc[0]! / n, acc[1]! / n, acc[2]! / n] : null;
}
/** A catalogued piece's texel density (median tx/m), for the scale floor (cached). */
const texCache2 = new Map<string, number | null>();
function texelsOf(prefab: string): number | null {
  if (!texCache2.has(prefab)) { let v: number | null = null; try { const A = path.join(PROJECTS, project, "assets"); v = texelDensity(prefabGeometry(A, prefab), { projected: projectedTexels(A) }).median || null; } catch { v = null; } texCache2.set(prefab, v); }
  return texCache2.get(prefab)!;
}
/** A catalogued piece's triangles (cached: the support gate asks a host's top a few hundred times). */
const trisCache = new Map<string, any[] | null>();
function trisOf(prefab: string): any[] | null {
  if (!trisCache.has(prefab)) { let t: any[] | null = null; try { t = prefabGeometry(path.join(PROJECTS, project, "assets"), prefab).tris; } catch { t = null; } trisCache.set(prefab, t); }
  return trisCache.get(prefab)!;
}
/** Highest mesh surface of a catalogued piece over a local point (prefab frame), for a piece set `on` it. */
function topOf(prefab: string, x: number, z: number): number | null { return surfaceOf(prefab, x, z, 1); }
/** Lowest mesh surface of a catalogued piece over a local point (prefab frame): its underside (support gate). */
function bottomOf(prefab: string, x: number, z: number): number | null { return surfaceOf(prefab, x, z, -1); }
/** A piece's up-facing flat faces' heights (prefab frame, unscaled; cached): a skirt's top keeps off them (skirtTop). */
const flatCache = new Map<string, number[]>();
function flatsOf(prefab: string): number[] {
  if (!flatCache.has(prefab)) { const ys = new Set<number>(); for (const t of trisOf(prefab) ?? []) { const [a, b, c] = [t.a, t.b, t.c]; if (Math.abs(a[1] - b[1]) < 1e-3 && Math.abs(a[1] - c[1]) < 1e-3 && (b[0] - a[0]) * (c[2] - a[2]) - (c[0] - a[0]) * (b[2] - a[2]) !== 0) ys.add(Math.round(a[1] * 1000) / 1000); } flatCache.set(prefab, [...ys]); }
  return flatCache.get(prefab)!;
}
function surfaceOf(prefab: string, x: number, z: number, sign: 1 | -1): number | null {
  const tris = trisOf(prefab); if (!tris) return null;
  let best: number | null = null;
  for (const t of tris) { const [a, b, c] = [t.a, t.b, t.c]; const d = (b[2] - c[2]) * (a[0] - c[0]) + (c[0] - b[0]) * (a[2] - c[2]); if (Math.abs(d) < 1e-9) continue;
    const l1 = ((b[2] - c[2]) * (x - c[0]) + (c[0] - b[0]) * (z - c[2])) / d, l2 = ((c[2] - a[2]) * (x - c[0]) + (a[0] - c[0]) * (z - c[2])) / d, l3 = 1 - l1 - l2;
    if (l1 < 0 || l2 < 0 || l3 < 0) continue; const y = l1 * a[1] + l2 * b[1] + l3 * c[1]; if (best === null || y * sign > best * sign) best = y; }
  return best;
}
/** A catalogued piece's marker (prefab frame) from the <model>.markers.json beside its mesh (layout `waters`: a kit basin's level). */
// L (o-small 2026-10-29): a .gltf model's markers were never found (only .glb was stripped)
/** A catalogued piece's door markers (kind `door` in its <model>.markers.json, prefab frame): the place's door steps and walk targets. */
const doorsCache = new Map<string, { id: string; position: [number, number, number]; yaw: number; size: [number, number, number] }[]>();
function doorsOf(prefab: string): { id: string; position: [number, number, number]; yaw: number; size: [number, number, number] }[] {
  if (doorsCache.has(prefab)) return doorsCache.get(prefab)!;
  const out: { id: string; position: [number, number, number]; yaw: number; size: [number, number, number] }[] = [];
  try {
    const pf = findAsset(project, `prefabs/${prefab}.json`);
    if (pf) for (const e of Object.values(read(pf).entities ?? {}) as any[]) {
      const asset = e?.components?.mesh?.source?.assetId; if (typeof asset !== "string") continue;
      const mf = findAsset(project, `models/${asset.replace(/.(glb|gltf)$/i, "")}.markers.json`); if (!mf) continue;
      const t = e.components.transform?.position ?? [0, 0, 0];
      for (const m of (read(mf).markers ?? []) as any[]) if (m.kind === "door" && Array.isArray(m.position)) out.push({ id: String(m.id), position: [m.position[0] + t[0], m.position[1] + t[1], m.position[2] + t[2]], yaw: Number(m.yaw) || 0, size: (m.size ?? [1, 2, 0]) as [number, number, number] });
    }
  } catch {}
  doorsCache.set(prefab, out); return out;
}
function markerOf(prefab: string, id: string): { position: [number, number, number]; size: [number, number, number]; shape?: "rect" | "round" } | null {
  try {
    const pf = findAsset(project, `prefabs/${prefab}.json`); if (!pf) return null;
    for (const e of Object.values(read(pf).entities ?? {}) as any[]) {
      const asset = e?.components?.mesh?.source?.assetId; if (typeof asset !== "string") continue;
      const mf = findAsset(project, `models/${asset.replace(/.(glb|gltf)$/i, "")}.markers.json`); if (!mf) continue;
      const m = (read(mf).markers ?? []).find((x: any) => x.id === id); if (!m) continue;
      const t = e.components.transform?.position ?? [0, 0, 0];
      return { position: [m.position[0] + t[0], m.position[1] + t[1], m.position[2] + t[2]], size: m.size ?? [0, 0, 0], ...(m.shape === "round" ? { shape: "round" as const } : {}) };
    }
  } catch {}
  return null;
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
/** A prefab's declared dressing footing (m below its base plane; 0 when none). */
function footingOf(prefab: unknown): number { if (typeof prefab !== "string") return 0; try { const pf = findAsset(project, `prefabs/${prefab}.json`); return Number((Object.values(read(pf!).entities ?? {}).map((x: any) => x?.components?.dressing).find(Boolean) as any)?.footing) || 0; } catch { return 0; } }
/** A prefab's catalogue dressing contact (embed, base, ...), "" when it declares none. */
function contactOf(prefab: unknown): string { if (typeof prefab !== "string") return ""; try { const pf = findAsset(project, `prefabs/${prefab}.json`); return String((Object.values(read(pf!).entities ?? {}).map((x: any) => x?.components?.dressing).find(Boolean) as any)?.contact ?? ""); } catch { return ""; } }
/** A structure prefab's base outline from its triangles (cached): the planner seats on it, the seated gate measures it. */
const baseCache = new Map<string, BaseOutline | null>();
/** A prefab's up-facing layers (cached), for the thin-prop seat. */
const upFaceCache = new Map<string, UpFace[]>();
function thinFaces(prefab: string): UpFace[] { if (!upFaceCache.has(prefab)) { let u: UpFace[] = []; try { u = upFaces(prefabGeometry(path.join(PROJECTS, project, "assets"), prefab).tris); } catch {} upFaceCache.set(prefab, u); } return upFaceCache.get(prefab)!; }
function structureBase(prefab: string): BaseOutline | null {
  if (!baseCache.has(prefab)) { let b: BaseOutline | null = null; try { b = baseOutline(prefabGeometry(path.join(PROJECTS, project, "assets"), prefab).tris); } catch { b = null; } baseCache.set(prefab, b); }
  return baseCache.get(prefab)!;
}
const siteRecord =(s: SiteChoice | null) => (s ? { at: s.at, pockets: s.pockets, moved: s.moved, estUsableM2: s.areaM2, padRelief: s.relief, why: s.why, ...(s.read ? { read: s.read } : {}) } : null);
/** The ground every plan, seat and gate here reads: the WALKED ground (tools/_ground.mts: a cave mouth reads its floor, never the height map over it). */
function ground(recipe: any): PlaceGround { const f = createWorldField(worldRecipeSchema.parse(recipe)), walk = walkGround(f); return { height: walk, wet: (x, z) => f.waterY(x, z) !== null, waterY: (x, z) => f.waterY(x, z) }; }
const worldFile = (p: string, w: string) => path.join(PROJECTS, p, "assets", "worlds", `${w}.json`);
const sceneFile = (p: string, w: string) => path.join(PROJECTS, p, "assets", "scenes", `${w}.scene.json`);

// ---------------------------------------------------------------------------------------------------------------------
/** `approach`: re-plan the approach only (owner ruling 2026-10-20: the approach becomes a carved + painted track); old
 *  footpath ribbons become footpath tracks (owner ruling 2026-10-30: ribbons removed from every tool). */
let approachOnly = false;
/** `tracks`: migrate the job's footpath ribbons to carved + painted tracks only (migrateFootpaths). */
let tracksOnly = false;
/** APPROACH ONLY: the place planned again on its RECORDED site, pockets and tier (no site search, no tier change) and only
 *  its approach taken from that plan: the graded track (road-pb-<id>-approach) into world-ops.json, the approach route,
 *  its lane clearings, keep-clear lines and network line replaced. Every old `path`/`ribbon` operator goes: the approach
 *  one is replaced by the track, a footpath one by a footpath track on its own line (footpathTrackId, graded by `worldgen
 *  road` like the approach). Structures, walls and the dressing plans stay as built and reviewed. Refused when the re-plan
 *  does not land on the recorded core (> 0.5 m). */
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
  // an old ribbon approach (removed 2026-10-30) goes; the footpath ribbons were already migrated (migrateFootpaths)
  const ribbon = operators.find((o) => REMOVED_RIBBON_OPS.includes(o.op) && /(^|-)approach$/.test(String(o.id))), oldTrack = (hand.siteDressing?.keepClear ?? []).find((k: any) => k.id === "track-approach")?.points;
  const ownTrack = (id: unknown) => typeof id === "string" && (id === trackId(poi) || id.startsWith(`${trackId(poi)}.`) || id.startsWith(`bridge-${trackId(poi)}`));
  const lanes = new Set([`${poi}-lane-approach`, `${poi}-lane-cover-approach`]), same = (l: any, m: any) => !!m && JSON.stringify(l) === JSON.stringify(m);
  write(J("operators.json"), operators.filter((o) => !REMOVED_RIBBON_OPS.includes(o.op)));
  write(J("world-ops.json"), [...worldOps.filter((o) => !ownTrack(o.feature?.id) && o.kind !== "ribbons"), ...gradeTrack(recipe, built.track)]);
  write(J("clearings.json"), [...clearings.filter((c) => !lanes.has(c.id)), ...built.clearings]);
  const i = hand.navigation.routes.findIndex((r: any) => r.id === "approach");
  if (i >= 0) hand.navigation.routes[i] = built.route; else hand.navigation.routes.unshift(built.route);
  hand.navigation.network = [...(built.track ? [built.track.points] : []), ...(hand.navigation.network ?? []).filter((l: any) => !same(l, ribbon?.points) && !same(l, oldTrack))];
  hand.siteDressing.keepClear = [...(hand.siteDressing.keepClear as any[]).filter((k) => k.id !== "route-approach" && k.id !== "track-approach" && !(k.why === "footpath" && same(k.points, ribbon?.points))), ...built.keepClear];
  hand.approachTrack = built.track ? { id: built.track.id, width: built.track.width, from: built.track.from, lengthM: built.track.lengthM } : null;
  write(J("handoff.json"), hand); write(J("walk-route.json"), hand.navigation.routes[0]);
  write(J("reports/plan.json"), { ...read(J("reports/plan.json")), approach: { at: new Date().toISOString(), why: "approach re-planned only (place-build approach) round the place as built: carved + painted track", track: hand.approachTrack, removed: ribbon?.id ?? null, notes: built.notes } });
  console.log(`approach ${poi}: ${ribbon ? `old ribbon ${ribbon.id} removed, ` : ""}${built.track ? `track ${built.track.id} ${built.track.width} m x ${built.track.lengthM} m from ${built.track.from}` : "no track"}; planned round the place as built`);
  for (const n of built.notes) console.log(`  NOTE: ${n}`);
}
/** `tracks` (and the first step of `approach`): MIGRATE an old job's FOOTPATH ribbons (ribbons removed 2026-10-30, owner
 *  ruling) without re-planning or building: every non-approach `path`/`ribbon` operator in operators.json becomes a
 *  footpath track on its own control line (footpathTrackId, tread clamped to FOOTPATH_WIDTH_M, graded by `worldgen road`
 *  dry run on the world without this place, like the approach) in world-ops.json; any features.ribbons world-op goes;
 *  handoff footpathTracks and its footpath keep-clear widths follow. The ribbon approach is left for `approach`. */
function migrateFootpaths(recipe: any): void {
  const J = (f: string) => path.join(JOB, f), brief = read(J("brief.json"));
  const operators = read(J("operators.json")) as any[], worldOps = read(J("world-ops.json")) as any[], hand = read(J("handoff.json"));
  const a = placeArchetypeSchema.parse(applySets(archetypes().find((x) => x.a.id === brief.archetype)?.raw ?? fail(`no archetype ${brief.archetype}`), brief.sets ?? []));
  const isApproachOp = (o: any) => /(^|-)approach$/.test(String(o.id));
  const old = operators.filter((o) => REMOVED_RIBBON_OPS.includes(o.op) && !isApproachOp(o));
  const footpaths: ApproachTrack[] = old.filter((o) => (o.points ?? []).length >= 2).map((o) => { const pts = (o.points as number[][]).map((q) => [q[0]!, q[1]!] as V2);
    return { id: footpathTrackId(poi, String(o.id).replace(PREFIX, "")), points: pts, width: Math.min(FOOTPATH_WIDTH_M[1], Math.max(FOOTPATH_WIDTH_M[0], Number(o.width ?? a.route.width))), maxGrade: Number(o.maxGrade ?? a.route.maxGrade), from: "the core", lengthM: Math.round(pts.slice(1).reduce((m, q, i) => m + Math.hypot(q[0] - pts[i]![0], q[1] - pts[i]![1]), 0)) }; });
  const mine = new Set(footpaths.map((t) => t.id)), ownTrack = (id: unknown) => typeof id === "string" && [...mine].some((t) => id === t || id.startsWith(`${t}.`) || id.startsWith(`bridge-${t}`));
  const ribbonOps = worldOps.filter((o) => o.kind === "ribbons").length;
  if (!old.length && !ribbonOps) { console.log(`tracks ${poi}: no footpath ribbons in the job`); return; }
  const footOps = footpaths.map(onZonePath(recipe)).map((t) => ({ t, ops: gradeTrack(recipe, t) })), carried = footOps.filter((x) => !x.ops.length).map((x) => x.t.id);
  write(J("world-ops.json"), [...worldOps.filter((o) => !ownTrack(o.feature?.id) && o.kind !== "ribbons"), ...footOps.flatMap((x) => x.ops)]);
  write(J("operators.json"), operators.filter((o) => !(REMOVED_RIBBON_OPS.includes(o.op) && !isApproachOp(o))));
  // a footpath the network already carries cut nothing: not a track of this place (see plan)
  hand.footpathTracks = footpaths.filter((t) => !carried.includes(t.id)).map((t) => ({ id: t.id, width: t.width, lengthM: t.lengthM }));
  if (carried.length) hand.footpathsCarried = carried; else delete hand.footpathsCarried;
  const r2p = (l: V2[]) => JSON.stringify(l.map((q) => q.map((v) => Math.round(v * 100) / 100)));
  for (const k of (hand.siteDressing?.keepClear ?? []) as any[]) { const t = k.why === "footpath" ? footpaths.find((x) => r2p(x.points) === r2p(k.points)) : undefined; if (t) { k.width = t.width + 1.2; k.track = t.id; } }
  write(J("handoff.json"), hand);
  write(J("reports/plan.json"), { ...read(J("reports/plan.json")), tracks: { at: new Date().toISOString(), why: "footpath ribbons (removed 2026-10-30) migrated to carved + painted footpath tracks (place-build tracks)", removed: old.map((o) => o.id), footpathTracks: hand.footpathTracks } });
  console.log(`tracks ${poi}: ${old.length} footpath ribbon operator(s) -> ${footpaths.length} carved + painted track(s) (${footpaths.map((t) => `${t.id} ${t.width} m x ${t.lengthM} m`).join(", ")})${ribbonOps ? `; ${ribbonOps} features.ribbons world-op(s) dropped` : ""}`);
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
function carryLive(d: any, pocket: { id: string; structures: { id: string; role: string }[] } | undefined, questOnly = false, layoutQuests: Set<string> = new Set()): { doc: any; carried: string[] } {
  const f = path.join(PROJECTS, project, "authoring", "dressing", "plans", `${d.id}.json`);
  if (!fs.existsSync(f)) return { doc: d, carried: [] };
  const live = read(f), room = Object.keys(d.rooms ?? {})[0] ?? "core", role = d.rooms?.[room]?.role ?? "yard", carried: string[] = [];
  // L (widows-cairn n-cairn2 2026-11-10: every plan put the old live tally prop back over the layout's): a quest slot the
  // owner's layout.json places (piece `quest`) keeps the layout's prop; the live swap is carried only for slots the layout leaves to the plan
  const items = (d.items as any[]).map((it) => { const q = it.quest?.entity && !layoutQuests.has(it.quest.entity) && (live.items as any[]).find((x) => x.quest?.entity === it.quest.entity);
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
  let layout: PlaceLayout | null = lp?.success ? lp.data : null;
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
  const recipe = withoutPlace(read(worldFile(project, world)));
  if (tracksOnly) return migrateFootpaths(recipe); // footpath ribbons -> tracks on their own lines: no ground survey, no re-plan
  let g = ground(recipe);
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
  // layout FIELDS become pieces here, on the world's ground in the place frame, so every later path (withLayout's
  // structures, the plan, ops, gates) sees them as drawn pieces (expandFields; the field list is emptied)
  if (layout?.fields?.length) { const fn: string[] = []; layout = expandFields(layout, g, (layout.origin ?? at) as V2, placeFacing(at, faces, approaches), (id) => propInfo(id)?.size, fn); for (const n of fn) console.log(`  ${n}`); }
  // layout CROPS (a farm's sown strips) -> tilled wear discs + stook pieces in the layout, and the sown strips' crop polygons
  // written to <job>/fields.json (build upserts them; L Marrow's Farm 2026-11-02: a hand-written crop polygon read as a patch)
  if (layout?.crops?.length) { const cn: string[] = []; const cr = expandCrops(layout, (layout.origin ?? at) as V2, placeFacing(at, faces, approaches), poi, cn, { surfaces: ((recipe.surfaces ?? []) as any[]).map((x) => x.name as string), world }); layout = cr.layout; write(path.join(JOB, "fields.json"), cr.fields); for (const n of cn) console.log(`  ${n}`); }
  // CAMP RULES (Derek 2026-10-31): pieces that face the centre are yawed to the fire, gear kept under cover stands at a shelter's mouth
  const campFaults: string[] = [];
  if (layout) { const cr = campLayout(layout, (id) => propInfo(id)); layout = cr.layout; for (const n of cr.notes) console.log(`  ${n}`); campFaults.push(...cr.faults); }
  if (approachOnly) { migrateFootpaths(recipe); return spliceApproach(recipe, g, approaches); } // the approach only, round the place as built
  // the brief's words drive row counts and ring switches (expandRows, ring.when); its people (place.culture) the fill
  const briefText = [place.read, place.landmark, ...(place.features ?? [])].filter(Boolean).join(" ");
  const culture = place.culture ? ([] as string[]).concat(place.culture) : null;
  const waters = ((recipe.features?.lakes ?? []) as any[]).filter((l) => Array.isArray(l.center) && Number.isFinite(l.radius) && Number.isFinite(l.waterY)).map((l) => ({ id: l.id, center: l.center as V2, radius: l.radius, waterY: l.waterY }));
  // the quest plan's objects at this place (kind object/readable): each becomes a core plan item via archetype `quest`
  const qf = path.join(ZONE, "quests.json"), questObjects = (fs.existsSync(qf) ? (read(qf).entities ?? []) as any[] : []).filter((e) => e.location === poi && (e.kind === "object" || e.kind === "readable")).map((e) => ({ id: e.id as string, kind: e.kind as string, what: e.what as string | undefined }));
  const roam = +(opt("roam") ?? 1.5), sites: Record<string, SiteChoice | null> = {};
  const planAt = (size: PlaceTier) => {
    const at0 = forTier(a, size, heightOf), at_ = layout ? withLayout(at0, layout, propInfo) : at0; // L (weepmouth 2026-10-21): a pinpoint is the core pocket only
    const base = { world, zone, project, place: { id: poi, name: place.name, size, at, faces, text: briefText, ...(culture ? { culture } : {}) }, reservation: { center: res.center, radius: res.radius, approaches }, propInfo, texelsOf, topOf, bottomOf, markerOf, doorsOf, questObjects, waters, builtStone, builtKinds, structureBase, placeRuleOf: (pf: string) => placeRuleFor(project, pf), solver: !LEGACY_SEAT /* the legacy seat founds declared-foundation pieces too (r-found 2026-10-30: legacyFounds) */, flatsOf, materialExists: (m: string) => !!findAsset(project, `materials/${m}.json`), ...(layout ? { layout, catalogued: (id: string) => !!findAsset(project, `prefabs/${id}.json`), surfaces: ((recipe.surfaces ?? []) as any[]).map((x) => x.name as string), surfaceColors: Object.fromEntries(((recipe.surfaces ?? []) as any[]).filter((x) => typeof x.color === "string").map((x) => [x.name as string, x.color as string])), zoneGround: zoneGroundAt(recipe, at, zone) } : {}), scatterRules: ((recipe.scatter ?? []) as any[]).map((s) => s.id as string), roads: existingRoads(recipe), kitBuildings: assetIds(project, "prefabs/wfc-ruins").size > 0, worldSeed: Number(recipe.seed ?? 0), seaLevel: Number(recipe.seaLevel ?? 0) };
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
    const rim: V2[] = footprintRim(p.pockets, p.handoff.navigation.routes); // the approach route is not the place's ground
    // L (o-farms 2026-11-02: a farm's strips and fold stood outside every pocket disc, so the size gate measured only the
    // yard): the layout's drawn pieces and ground patches (crops' tilled discs, stooks) are part of the built footprint too
    if (layout) { const o = (layout.origin ?? p.centre) as V2; for (const q of [...layout.pieces.map((x) => ({ at: x.at as V2, r: 0 })), ...layout.ground.map((x) => ({ at: x.at as V2, r: x.radius ?? 0 }))]) { const w = toWorld(o, p.front as V2, q.at); rim.push(w); if (q.r > 0) rim.push([w[0] + q.r, w[1]], [w[0] - q.r, w[1]], [w[0], w[1] + q.r], [w[0], w[1] - q.r]); } }
    const reachAll = Math.max(reach, ...rim.map((q) => Math.hypot(q[0] - p.centre[0], q[1] - p.centre[1]) + 2));
    p.handoff.measurements.measuredCombinedUsableAreaM2 = Math.round(usableArea(g, p.centre, reachAll, hull(rim), p.pockets.map((k) => k.at)));
    p.handoff.measurements.usableAreaMethod = "2 m cells, dry, slope <= 0.6, inside the footprint hull, flood-filled from the core and every pocket (each joined by a walked footpath; place-build plan, before the pads)";
    return p;
  };
  // L (size, coordinator ruling 2026-10-20): the ground decides the tier. When the reservation's ground cannot hold the
  // tier's usable area, the place is MEASURED and built one tier down (medium -> small); the downgrade and its reason go
  // into the job (brief.json adventureSize + tierDowngrade, handoff tierDowngrade, reports/size.json). size-tiers.mjs is
  // never loosened.
  const asked = place.size as PlaceTier;
  let size = asked, p = planAt(size), downgrade: any = null;
  // a coordinator size ruling with `keepTier: true` (<zone>/size-rulings.json, job.mjs sizeRulingFor) keeps the asked tier on
  // ground that holds less: the place is MEASURED at that tier and its `usableAreaM2` excepts only the usable-area fault
  // (L o-gates 2026-10-30: the Weeping Sun's mountainside ruins make a medium hull on a small apron)
  const keepTier = (sizeRulingFor(JOB, poi) as { keepTier?: boolean } | null)?.keepTier === true;
  if (keepTier) console.log(`  TIER: ${asked} kept by the zone's size ruling (size-rulings.json keepTier)`);
  if (!keepTier) for (const lower of ({ large: ["medium", "small"], medium: ["small"] } as Record<string, ("small" | "medium")[]>)[asked] ?? []) {
    const have = p.handoff.measurements.measuredCombinedUsableAreaM2;
    if (have >= tierFor(size).minUsableAreaM2) break;
    const first = downgrade?.from ?? asked, firstHave = downgrade?.measuredUsableAreaM2 ?? have;
    size = lower; p = planAt(size);
    downgrade = { from: first, to: size, measuredUsableAreaM2: firstHave, neededM2: tierFor(first).minUsableAreaM2,
      why: `the ground round the reservation holds ${firstHave} m2 of dry ground under 31 deg (flood-filled from every pocket); a ${first} place needs ${tierFor(first).minUsableAreaM2} m2, so it is built at the tier the ground supports` };
  }
  // L (Red Dial 2026-10-30): a layout road's FIXED-PROFILE grade (roads[].grade) is a height patch on the ground BEFORE the
  // pieces seat: the plan runs again on the graded ground (pillars, plinth and walls seat on the cut), the patch leads world-ops
  const gradeOps: any[] = [], gradeFaults: string[] = [];
  if (layout?.roads.some((r) => r.grade) || layout?.ground.some((q) => q.kind === "hollow")) {
    const centre0 = p.centre as V2;
    // L (r-go2 north-flat 2026-11-11): an impact HOLLOW (layout ground kind hollow) is ground too: pit + broken rim, seated on
    for (const q of layout.ground) if (q.kind === "hollow") {
      const hp = hollowPatch(`${PREFIX}hollow-${q.id}`, toWorld(p.centre as V2, p.front as V2, q.at as V2), { radius: q.radius, depth: q.depth, rim: q.rim, rimWidth: q.rimWidth, ...(q.feather !== undefined ? { feather: q.feather } : {}) }, g);
      gradeOps.push(hp.op);
      console.log(`  HOLLOW: ${q.id} floor ${hp.floorY} m (cut ${hp.cut} m), rim crest +${hp.crest} m at ${q.radius} m, reach ${hp.reach} m, profile slope ${hp.profileSlope}`);
    }
    for (const r of layout.roads) if (r.grade) {
      const gp = gradePatch(`${PREFIX}grade-${r.id}`, r.points.map((q) => toWorld(p.centre as V2, p.front as V2, q as V2)), r as any, g);
      gradeOps.push(gp.op); gradeFaults.push(...gp.faults.map((f) => `LAYOUT: ${f}`));
      console.log(`  GRADE: ${r.id} ${gp.startY} -> ${gp.levelY} m over ${gp.lengthM} m (grade ${gp.grade}), cut ${gp.cut} / fill ${gp.fill} m under the band`);
    }
    recipe.features.heightPatches = [...((recipe.features.heightPatches ?? []) as any[]), ...gradeOps.map((o) => o.feature)];
    g = ground(recipe); p = planAt(size); p.faults.push(...gradeFaults);
    if (Math.hypot(p.centre[0] - centre0[0], p.centre[1] - centre0[1]) > 0.5) p.faults.push(`LAYOUT: the plan centre moved ${Math.round(Math.hypot(p.centre[0] - centre0[0], p.centre[1] - centre0[1]))} m on the graded ground: pin layout origin`);
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
  // overwrite in place; a layout area's plan is its dresser's, never the plan's (L o-small2 dropped-hour 2026-10-30)
  const keepPlans = new Set((layout?.areas ?? []).map((q) => `${poi}-${q.id}.json`));
  for (const f of fs.existsSync(path.join(JOB, "dressing")) ? fs.readdirSync(path.join(JOB, "dressing")) : []) if (!keepPlans.has(f)) fs.unlinkSync(path.join(JOB, "dressing", f));
  write(path.join(JOB, "brief.json"), { id: poi, name: place.name, adventureSize: size, ...(downgrade ? { tierDowngrade: downgrade } : {}), archetype: a.id, sets: setList, ...(pinned ? { at: pinned } : {}), ...(faces ? { faces } : {}) /* L (o-small 2026-10-29): a --faces equal to the zone brief site.faces was dropped here, and the pinned re-plan of `all` then ignored site.faces and turned the frame to the nearest approach point */, site: siteRecord(sites[size] ?? null), place });
  write(path.join(JOB, "handoff.json"), p.handoff);
  write(path.join(JOB, "ops.json"), p.ops);
  // layout ROADS (an avenue): carved + painted through the same road machinery as the approach track
  const layoutRoads: ApproachTrack[] = (layout?.roads ?? []).map((r) => { const pts = r.points.map((q) => toWorld(p.centre as V2, p.front as V2, q as V2).map((v) => Math.round(v * 100) / 100) as V2);
    if (r.surface && !((recipe.surfaces ?? []) as any[]).some((x) => x.name === r.surface)) fail(`layout road ${r.id}: surface ${r.surface} is not in the recipe's surfaces`);
    return { id: `road-${PREFIX}${r.id}`, points: pts, width: r.width, maxGrade: r.maxGrade, from: "layout", ...(r.surface ? { surface: r.surface } : {}), lengthM: Math.round(pts.slice(1).reduce((n, q, i) => n + Math.hypot(q[0] - pts[i]![0], q[1] - pts[i]![1]), 0)) }; });
  // L (r-found 2026-10-31): a footpath the road network already carries cuts nothing (`worldgen road` folds it whole into
  // the roads it runs beside); it leaves the handoff's footpathTracks (the roads gate would demand a road that was never
  // cut: "track ... is not in the lab world") and is kept as footpathsCarried
  const footOps = p.footpaths.map(onZonePath(recipe)).map((t) => ({ t, ops: gradeTrack(recipe, t) }));
  const carried = footOps.filter((x) => !x.ops.length).map((x) => x.t.id);
  if (carried.length) {
    p.handoff.footpathTracks = (p.handoff.footpathTracks ?? []).filter((x: any) => !carried.includes(x.id));
    p.handoff.footpathsCarried = carried;
    write(path.join(JOB, "handoff.json"), p.handoff);
    for (const id of carried) console.log(`  NOTE: footpath ${id}: carried by the road network (nothing cut; not a track of this place)`);
  }
  write(path.join(JOB, "world-ops.json"), [...gradeOps, ...p.worldOps, ...gradeTrack(recipe, p.track), ...footOps.flatMap((x) => x.ops), ...layoutRoads.flatMap((t) => gradeTrack(recipe, t, true))]);
  { const left = ribbonsDeclared(p.operators, p.worldOps); if (left.length) fail(`plan ${poi}: ${left.join("; ")}`); } // never: the planner emits tracks
  // layout STAIRS (L o-gates 2026-10-30): a ramp wall operator cut into the slope, flights where it climbs (layout stairs[])
  const layoutStairs = (layout?.stairs ?? []).map((st, si) => ({ id: `${PREFIX}stair-${st.id}`, op: "wall", variant: "ramp", scale: "human", smooth: false, seed: 101 + si,
    points: st.points.map((q) => toWorld(p.centre as V2, p.front as V2, q as V2).map((v) => Math.round(v * 100) / 100)), thickness: st.width,
    materials: Object.keys(st.materials).length ? st.materials : { ...(builtStone ?? {}) },
    ramp: { levels: st.levels, riser: 0.3, stairGrade: 0.5, maxGrade: 0.3, cut: { feather: 8, calm: true } } }));
  for (const st of layoutStairs) if (wearsCliffTile(st.materials)) p.faults.push(`LAYOUT: stair ${st.id}: no materials and no zone builtStone (it would wear the terrain cliff tile)`);
  // the stair is walked: its centre line joins the navigation network
  if (layoutStairs.length) { p.handoff.navigation = { ...(p.handoff.navigation ?? {}), network: [...(p.handoff.navigation?.network ?? []), ...layoutStairs.map((st) => st.points)] }; write(path.join(JOB, "handoff.json"), p.handoff); }
  write(path.join(JOB, "operators.json"), [...p.operators, ...layoutStairs]);
  write(path.join(JOB, "clearings.json"), [...p.clearings]);
  write(path.join(JOB, "encounter-clearings.json"), p.encounters);
  write(path.join(JOB, "prop-requests.json"), p.propRequests);
  // L (TOOLS-LAYOUT 3): coverage both ways, here (the catalogue is at hand): a design element made of catalogue props with no
  // piece, a piece naming no element
  p.faults.push(...campFaults);
  // STONE FAMILY (L Marrow's Farm 2026-10-31): the layout's `stone`, else the zone's place-build.json `stoneFamily`
  { const family: string[] | null = layout?.stone ?? (fs.existsSync(zdf) ? read(zdf).stoneFamily ?? null : null);
    const founds = (layout?.pieces ?? []).filter((q) => q.kind === "structure").map((q) => ({ id: q.id, prefab: q.prefab, material: (placeRuleFor(project, q.prefab) as any)?.foundation?.material ?? null }));
    p.faults.push(...stoneFamilyFaults(family, [...p.operators, ...layoutStairs], founds));
    // the landmark / centrepiece STONE shows the zone's stone too (stonePieceFaults: its drawn texels vs the zone cliff tile)
    // L (Derek 2026-11-10, the Widows' Cairn): an archetype standard with `stone: "every"` judges EVERY stone piece (headstones,
    // cairn-graves, statues), one row per prefab
    const every = a.standard?.stone === "every";
    const stones = (layout?.pieces ?? []).filter((q) => !q.prefab.startsWith("rock-kit/") && STONE_PIECE_RE.test(q.prefab.split("/").pop()!) && (every || q.role === "landmark" || !!q.landmark || !!propInfo(q.prefab)?.centrepiece));
    const byPrefab = [...new Map(stones.map((q) => [q.prefab, q])).values()].map((q) => { const n = stones.filter((x) => x.prefab === q.prefab).length; return { id: n > 1 ? `${q.id} (+${n - 1} more)` : q.id, prefab: q.prefab, rgb: drawnColour(q.prefab) }; });
    if (byPrefab.length) p.faults.push(...stonePieceFaults(byPrefab, zoneCliffColour(recipe, (layout?.origin ?? at) as number[], zone))); }
  // L (Derek 2026-11-10, THE graveyard standard): the archetype's measured standard (standardFaults): boundary wall numbers,
  // railing sections lining every boundary wall, a gate piece in a wall gap, denied pieces; walls and pieces in world x,z
  if (a.standard) {
    const pks = (layout ? withLayout(forTier(a, size, heightOf), layout, propInfo) : forTier(a, size, heightOf)).pockets;
    const walls = pks.flatMap((pk) => pk.walls.filter((wl) => (wl.kind ?? "wall") === "wall").map((wl) => {
      const ops = p.operators.filter((o: any) => o.op === "wall" && String(o.id).startsWith(`${PREFIX}${pk.id}-${wl.id}`) && Array.isArray(o.points));
      return { id: `${pk.id}.${wl.id}`, height: wl.height, thickness: wl.thickness, runs: ops.map((o: any) => o.points as V2[]) };
    }));
    const o = (layout?.origin ?? p.centre) as V2;
    const pieces = (layout?.pieces ?? []).map((q) => ({ id: q.id, prefab: q.prefab, at: toWorld(o, p.front as V2, q.at as V2), width: (propInfo(q.prefab)?.size?.[0] ?? 0) * (q.scale ?? 1) }));
    p.faults.push(...standardFaults(a.standard, walls, pieces));
  }
  if (layout) { const df = path.join(JOB, "design.json"); for (const f of layoutCoverage(fs.existsSync(df) ? read(df) : null, layout, { catalogued: (id) => !!findAsset(project, `prefabs/${id}.json`), questProps: Object.values(a.quest) })) p.faults.push(`LAYOUT: ${f}`); }
  const tierPockets = (layout ? withLayout(forTier(a, size, heightOf), layout, propInfo) : forTier(a, size, heightOf)).pockets;
  for (const d0 of p.plans) { const { doc: d, carried } = carryLive(d0, tierPockets.find((k) => d0.id === `${poi}-${k.id}`), !!layout, new Set((layout?.pieces ?? []).flatMap((q) => (q.quest ? [q.quest] : [])))); if (carried.length) p.notes.push(`${d.id}: carried from the live plan: ${carried.join(", ")}`); write(path.join(JOB, "dressing", `${d.id}.json`), { ...d, items: uniqueItemIds(d.items) }); }
  const views = [...p.handoff.viewpoints, { name: "aerial-150", x: p.aerial[0], z: p.aerial[1], facing: Math.round(((Math.atan2(-p.front[0], p.front[1]) * 180) / Math.PI + 360) % 360), pitch: 0.6, distance: 150 }];
  // L (HERO-BRIDGE discipline, LANDMARKS 2026-10-21): <job>/contract.json { idea, mustRead[], views[] } is written by the
  // owner BEFORE the grey box; its fixed cameras (camera + target, light-shots' contract shot list) ride every plan's views
  const cf = path.join(JOB, "contract.json"), contract = fs.existsSync(cf) ? read(cf) : null;
  const cviews = ((contract?.views ?? []) as any[]).filter((v) => Array.isArray(v.camera) && Array.isArray(v.target));
  if (contract && cviews.length !== (contract.views ?? []).length) fail(`${cf}: every contract view needs camera [x,y,z] and target [x,y,z]`);
  // L (TOOLS-PB 2026-10-23): the design's own cameras (archetype `views`, `--set views=[...]`, place frame) ride the same way
  // L (Red Dial 2026-10-30: the layout's hand-copied concept cameras were world offsets read in the turned place frame, 134
  // deg off the painting: the far shot showed open ground, no place): the APPROVED painting's own cameras (the concept-on-site
  // record <zone>/concept/<poi>.site.json, world space) are the concept-<view> shots; a layout view of that name is replaced
  // and named in the faults when it stands more than 5 m off
  const sitef = path.join(JOB, "..", "..", "concept", `${poi}.site.json`), site = fs.existsSync(sitef) ? read(sitef) : null;
  for (const [k, r] of Object.entries((site?.renders ?? {}) as Record<string, any>)) {
    if (!Array.isArray(r?.camera) || !Array.isArray(r?.target)) continue;
    const name = `concept-${k}`, own = (p.setViews ?? []).find((v: any) => v.name === name);
    if (own?.camera && Math.hypot(own.camera[0] - r.camera[0], own.camera[2] - r.camera[2]) > 5) p.faults.push(`LAYOUT: view ${name} stands ${Math.round(Math.hypot(own.camera[0] - r.camera[0], own.camera[2] - r.camera[2]))} m off the painting's camera [${r.camera.join(", ")}] (concept site record): the painting's camera is used; layout views are in the PLACE frame`);
    if (!cviews.some((c) => c.name === name)) cviews.push({ name, camera: r.camera, target: r.target });
  }
  const setViews = (p.setViews ?? []).filter((v: any) => !cviews.some((c) => c.name === v.name));
  write(path.join(JOB, "views.json"), [...views.filter((v) => !cviews.some((c) => c.name === v.name) && !setViews.some((c: any) => c.name === v.name)), ...setViews, ...cviews.map((v) => ({ name: v.name, x: v.x ?? v.camera[0], z: v.z ?? v.camera[2], y: v.y ?? Math.round((v.camera[1] - 1.7) * 10) / 10, camera: v.camera, target: v.target }))]);
  write(path.join(JOB, "walk-route.json"), p.handoff.navigation.routes[0]);
  if (!fs.existsSync(path.join(JOB, "progress.json"))) write(path.join(JOB, "progress.json"), { version: 1, poiId: poi, ownerAgentId: "place-build", stage: "blockout", mode: "build" });
  write(path.join(JOB, "reports", "plan.json"), { archetype: a.id, sets: setList, ...(layout ? { layout: { pieces: layout.pieces.length, ground: layout.ground.length, views: layout.views.length, origin: layout.origin ?? null } } : {}), site: siteRecord(sites[size] ?? null), centre: p.centre, padY: p.padY, front: p.front, faults: p.faults, notes: p.notes, adventureSize: size, tierDowngrade: downgrade, requested: p.requested, pockets: p.pockets.map((k) => ({ id: k.id, at: k.at, y: k.y, relief: Math.round(k.fit.stats.relief * 10) / 10, ok: k.fit.ok, why: k.fit.why })), usableAreaM2: p.handoff.measurements.measuredCombinedUsableAreaM2, support: p.support, seconds: Math.round((Date.now() - t0) / 1000) });
  ensureIsoViews(); // the iso overviews, framed to the planned footprint, first in views.json
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
/** L (Derek 2026-10-30 "take a few chunks and send it to do the work there... otherwise you're gonna bloat"): the lab's box —
 *  every point the job touches (its pieces, world patches, operators, routes) and every shot camera (a fixed camera also
 *  reaches past its target), plus a margin (tools/_lab-crop.mts). Null when the job has nothing planned yet. */
function jobBox(): LabBox | null {
  const pts: V2[] = [], j = (f: string) => { const p = path.join(JOB, f); return fs.existsSync(p) ? read(p) : null; };
  const ops = (j("ops.json") ?? []) as any[], at = new Map<string, any>();
  for (const o of ops) if (o.op === "add-entity") at.set(o.id, o.entity);
  const worldAt = (id: string, guard = 0): V2 => { const e = at.get(id), q = e?.components?.transform?.position ?? [0, 0, 0], up: V2 = e?.parent && at.has(e.parent) && guard < 16 ? worldAt(e.parent, guard + 1) : [0, 0]; return [up[0] + q[0], up[1] + q[2]]; };
  for (const id of at.keys()) if (at.get(id)?.components?.transform) pts.push(worldAt(id));
  for (const o of (j("world-ops.json") ?? []) as any[]) { const e = featureExtent(o.feature); if (e) pts.push(e.min, e.max); }
  for (const o of (j("operators.json") ?? []) as any[]) { const e = featureExtent(o); if (e) pts.push(e.min, e.max); }
  // an iso overview's camera hangs far off in the air over nothing it shows: only its framed ground counts (target)
  for (const v of (j("views.json") ?? []) as any[]) pts.push(...(isReviewShot(v) && Array.isArray(v.target) ? [[v.target[0], v.target[2]] as V2] : viewPoints(v)));
  for (const q of ((j("walk-route.json")?.points ?? []) as number[][])) pts.push([q[0]!, q[q.length - 1]!]);
  for (const k of ((j("reports/plan.json")?.pockets ?? []) as any[])) if (Array.isArray(k.at)) pts.push(k.at);
  return pts.length ? labBox(pts) : null;
}

/** Where the lab starts: AT THE PLACE (Derek 2026-10-31), on walkable ground where its reservation's approach arrives,
 *  facing its centre; else the start of its first walked route, else the box centre (tools/_lab-crop.mts labSpawn).
 *  `full` = the live world recipe (its roads resolve the approach). */
function labStart(full: any, box: LabBox, field: ReturnType<typeof createWorldField>) {
  const hf = path.join(JOB, "handoff.json"), routeStart = fs.existsSync(hf) ? (read(hf).navigation?.routes?.[0]?.points?.[0] ?? null) : null;
  const rf = path.join(ZONE, "reservations.json"), rall = fs.existsSync(rf) ? (read(rf).reservations ?? []) : [], rsv = rall.find((r: any) => r.location === poi);
  const arrival = rsv ? approachArrival(approachLines(full, rall, rsv).lines, rsv.center, rsv.radius ?? 40) : null;
  const boxMid: V2 = [(box.min[0] + box.max[0]) / 2, (box.min[1] + box.max[1]) / 2];
  const target: V2 = rsv ? [rsv.center[0], rsv.center[1]] : boxMid;
  const at: V2 = arrival ?? (routeStart ? [routeStart[0], routeStart[2]] : boxMid);
  return labSpawn(field, at, target, arrival ? `${poi}: where its approach arrives, facing its centre` : routeStart ? `${poi}: its first walked route's start, facing its centre` : `${poi}: the lab box centre`);
}

/** `lab-spawn`: an EXISTING lab (built or not) gets its start at the place and the game shell, nothing else rebuilt. */
function respawnLab() {
  const sf = sceneFile(lab, labWorld), bf = path.join(PROJECTS, lab, "lab-box.json");
  if (!fs.existsSync(sf)) fail(`no lab scene ${sf}: run place-build lab first`);
  // a cropped lab's box, else (a --whole-world lab: it is a lab scene, not the world, so it starts at the place too) the
  // place's own box (startBox)
  const b = fs.existsSync(bf) ? read(bf) : null, box: LabBox | null = b ? { min: b.min, max: b.max } : startBox();
  if (!box) fail(`${poi}: no lab-box.json, no reservation and no planned job: nothing says where the place is`);
  const field = createWorldField(worldRecipeSchema.parse(read(worldFile(lab, labWorld))));
  const spawn = labStart(read(worldFile(project, world)), box!, field);
  const r = labShell(lab, read(sf), spawn);
  if (!has("dry-run")) write(sf, r.scene);
  console.log(`lab ${lab}${b ? "" : " (whole world)"}: starts at ${spawn.position.join(", ")} (${spawn.from})`);
  console.log(r.added.length ? r.added.map((a) => `  ${a}`).join("\n") : "  nothing to change");
  if (has("dry-run")) console.log("  (dry run: nothing written)");
}

/** Where the place is when the lab has no crop box: its reservation disc (+ 60 m), else the job's box. */
function startBox(): LabBox | null {
  const rf = path.join(ZONE, "reservations.json"), rsv = fs.existsSync(rf) ? (read(rf).reservations ?? []).find((r: any) => r.location === poi) : null;
  return rsv ? labBox([[rsv.center[0], rsv.center[1]]], (rsv.radius ?? 40) + 60) : jobBox();
}

function makeLab() {
  const live = path.join(PROJECTS, project), dir = path.join(PROJECTS, lab), pj = read(path.join(live, "project.json"));
  const box = has("whole-world") ? null : jobBox();
  write(path.join(dir, "project.json"), { version: 1, name: lab, title: `place-build lab: ${poi} (scratch)`, description: `Scratch ${box ? `crop [${box.min}]..[${box.max}]` : "copy"} of ${world} world + scene for place-build ${poi}. Never installed; delete when done.`, group: "Worlds", menuOrder: 99,
    scenes: [{ id: labWorld, label: `place-build lab ${poi}`, variants: [] }], engine: pj.engine ?? "^0.1", multiplayer: pj.multiplayer ?? "server", tools: [], dependsOn: [...new Set([...(pj.dependsOn ?? []), project, ...portalProjects()])] });
  const wt = fs.readFileSync(worldFile(project, world), "utf8");
  // a remade lab starts clean: the old lab's terrain undo files and baked op pieces are scratch of a previous build
  fs.rmSync(path.join(dir, "authoring", "terrain", "undo"), { recursive: true, force: true });
  const full = withoutPlace(JSON.parse(wt));
  let labRecipe = full, cropNote = "whole world (--whole-world)";
  if (box) {
    const c = cropRecipe(full, box, { log: (s) => console.log(s) });
    labRecipe = c.recipe;
    cropNote = `box [${box.min}]..[${box.max}] (${box.max[0] - box.min[0]} x ${box.max[1] - box.min[1]} m), dropped ${Object.entries(c.dropped).map(([k, n]) => `${n} ${k}`).join(", ") || "nothing"}; ground proved identical to live on ${c.proof.samples} samples + ${c.proof.cells} cells${c.proof.restored.length ? ` (put back: ${c.proof.restored.join(", ")})` : ""} in ${(c.proof.ms / 1000).toFixed(1)} s`;
  }
  write(worldFile(lab, labWorld), labRecipe);
  fs.writeFileSync(path.join(dir, "source-world.sha1"), `${crypto.createHash("sha1").update(wt).digest("hex")} *${project}/assets/worlds/${world}.json\n`);
  if (box) write(path.join(dir, "lab-box.json"), { min: box.min, max: box.max, source: `${project}/assets/worlds/${world}.json`, note: "voxelWorld.bounds of the lab scene; the recipe keeps only features reaching it (tools/_lab-crop.mts)" });
  else fs.rmSync(path.join(dir, "lab-box.json"), { force: true });
  // terrain materials: only the world's own material + water set that the recipe names (never every <world>-* file)
  const tdir = path.join(live, "assets", "materials", "terrain"), tout = path.join(dir, "assets", "materials", "terrain");
  fs.rmSync(tout, { recursive: true, force: true }); fs.mkdirSync(tout, { recursive: true });
  const named = new Set(JSON.stringify(labRecipe).match(new RegExp(`terrain/${world}[a-z0-9-]*`, "g")) ?? []);
  for (const f of fs.readdirSync(tdir).filter((f) => f === `${world}.json` || (f.startsWith(`${world}-`) && (!box || named.has(`terrain/${f.replace(/\.json$/, "")}`))))) fs.copyFileSync(path.join(tdir, f), path.join(tout, labWorld + f.slice(world.length)));
  const s0 = read(sceneFile(project, world)), g0 = box ? createWorldField(worldRecipeSchema.parse(labRecipe)) : null;
  // every lab starts at its place, a --whole-world lab too (its scene is a lab's, not the world's)
  const sbox = box ?? startBox();
  const spawn = sbox ? labStart(full, sbox, g0 ?? createWorldField(worldRecipeSchema.parse(labRecipe))) : null;
  const cs = box ? cropScene(s0, box, { x: spawn!.position[0], z: spawn!.position[2], groundY: spawn!.ground, target: spawn!.target }) : null;
  const s = cs ? cs.scene : s0, own = new Set(Object.entries(s.entities).filter(([id, e]: any) => (e.tags ?? []).includes(`poi:${poi}`) || id.startsWith(`dress-${poi}-`)).map(([id]) => id));
  if (cs) cropNote += `; scene ${cs.kept} entities kept, ${cs.dropped} outside the box`;
  // every DESCENDANT, not only children: a town building's interior dressing hangs under its rooms, which hang under the
  // house piece (r-go-farms 2026-11-11: the ninth-furrow lab kept 69 orphaned room dressings and site-sockets refused it)
  for (let grew = true; grew;) { grew = false; for (const [k, e] of Object.entries(s.entities) as any) if (e.parent && own.has(e.parent) && !own.has(k)) { own.add(k); grew = true; } }
  for (const id of own) delete s.entities[id];
  // L (gates on the lab): populated creatures are left out of the lab: the walk judges the place's ground and pieces, and
  // an aggroed ghost knight on a route turns it into a fight (encounters are gated by populate/encounter tools)
  const pop = new Set(Object.entries(s.entities).filter(([, e]: any) => (e.tags ?? []).includes("populate")).map(([id]) => id));
  for (let grew = true; grew;) { grew = false; for (const [k, e] of Object.entries(s.entities) as any) if (e.parent && pop.has(e.parent) && !pop.has(k)) { pop.add(k); grew = true; } }
  for (const id of pop) delete s.entities[id];
  for (const e of Object.values(s.entities) as any) if (e.components?.voxelWorld) e.components.voxelWorld.world = labWorld;
  s.name = `place-build lab ${poi}`;
  // playable like the world: the game shell (player prefab, camera rig, HUD/UI, fx pools), the player at the place
  const shelled = labShell(lab, s, spawn);
  if (shelled.added.length) cropNote += `; game shell: ${shelled.added.length} part(s)`;
  if (spawn) cropNote += `; starts at ${spawn.position.join(", ")} (${spawn.from})`;
  write(sceneFile(lab, labWorld), shelled.scene);
  console.log(`lab ${lab}: world ${labWorld} <- live ${world} (place features out), scene minus ${own.size} entities of ${poi}\n  crop: ${cropNote}`);
}

// ---------------------------------------------------------------------------------------------------------------------
/** L (Wristgate 2026-10-29: portal-play FAILED "shackle-halls is not in pb-wristgate's dependsOn closure"): the lab depends on
 *  every project its job's portals lead into (a `dungeon:<id>` tag on a scene op whose project exists), or the editor cannot
 *  open the instance at the door. The live world lists them itself (install). */
function portalProjects(): string[] {
  const f = path.join(JOB, "ops.json"); if (!fs.existsSync(f)) return [];
  const ids = [...new Set([...fs.readFileSync(f, "utf8").matchAll(/"dungeon:([a-z0-9-]+)"/g)].map((m) => m[1]!))];
  return ids.filter((id) => fs.existsSync(path.join(PROJECTS, id, "project.json")));
}

/** Apply (or with `remove` only take out) this place in a project's world + scene. The lab build and the live install. */
function applyPlace(p: string, w: string, { remove = false, dry = false } = {}) {
  const reg = new ComponentRegistry(); registerCoreComponents(reg); registerChunkComponents(reg);
  const SF = sceneFile(p, w), WF = worldFile(p, w);
  const ops = (read(path.join(JOB, "ops.json")) as any[]).map((o) => // a DRAFT install tags the place root `draft` (the job's ops on disk unchanged)
    cmd === "install" && has("draft") && !remove && o.op === "add-entity" && !o.entity?.parent && (o.entity?.tags ?? []).includes(`poi:${poi}`) && !(o.entity.tags as string[]).includes("draft")
      ? { ...o, entity: { ...o.entity, tags: [...o.entity.tags, "draft"] } } : o);
  const worldOps = read(path.join(JOB, "world-ops.json")) as any[], operators = read(path.join(JOB, "operators.json")) as any[];
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
  // L (o-wild4 2026-11-03: South Watch's 15 installed entities vanished 2 min later — a concurrent draft install had read
  // the live scene before this write and wrote its own copy back after): the scene write RE-READS the file under its lock
  // (_scene-write updateJsonFile) and applies this place's removes + ops to what is on disk now, never to the copy read above
  let inverse = res.inverse;
  updateJsonFile(SF, (fresh: any) => {
    if (!fresh) fail(`no scene at ${SF}`);
    const removes2 = placeSceneRemoves(fresh, poi);
    const r2 = applyOps(fresh, [...removes2, ...(remove ? [] : [...ops, ...skin.ops])] as never, reg); inverse = r2.inverse;
    return { doc: r2.doc, removed: removalsOf(removes2, fresh) };
  }, { label: `place-build ${cmd} ${poi}`, indent: 1 });
  if (!remove) write(path.join(JOB, p === lab ? "reports/lab-inverse.json" : "install-inverse.json"), inverse);
  const wg = (label: string, args: string[]) => { const r = tool(label, ["tools/worldgen.mts", ...args]); if (r.status) fail(`${label} failed (see ${JOB}/reports/${label}.log): ${r.out.trim().split("\n").slice(-3).join(" | ")}`); return r; };
  for (const id of ownOps) wg(`op-remove`, ["op", w, "--project", p, "--remove", id]);
  // the world recipe the same way (o-wild4 2026-11-03): own features off + this place's patches on, applied to the recipe
  // as it is on disk under its lock (another install's patches written meanwhile stay)
  const lfv = path.join(JOB, "layout.json"), vfv = path.join(JOB, "vegetation.json"), veg = (fs.existsSync(lfv) ? read(lfv).vegetation : undefined) ?? (fs.existsSync(vfv) ? read(vfv) : undefined);
  updateJsonFile(WF, (fresh: any) => {
    if (!fresh) fail(`no world recipe at ${WF}`);
    let adds: { kind: string; feature: unknown }[] = [];
    if (!remove) {
      const parsed = applyRecipeEdits(worldRecipeSchema.parse(withoutPlace(fresh)), worldOps as never); // validates every patch
      adds = worldOps.map((o: any) => ({ kind: o.kind, feature: (parsed.recipe.features as any)[o.kind].find((f: any) => f.id === o.feature.id) }));
    }
    const rb = placeWorldRebase(fresh, ownsFeature, adds), w2 = rb.doc;
    { // the layout's place-region vegetation (layout `vegetation`, or <job>/vegetation.json for a job built by its own build-spec
      // with no layout: Wristgate 2026-10-29): set on regions[id = poi], taken off on remove
      w2.regions = (w2.regions ?? []).map((r: any) => (r.id === poi ? { ...r } : r));
      const region = (w2.regions ?? []).find((r: any) => r.id === poi);
      if (veg && !region) fail(`layout vegetation: the world has no place region ${poi} (worldgen regions) to carry it`);
      if (veg && region) { if (remove) delete region.vegetation; else region.vegetation = veg; worldRecipeSchema.parse(w2); }
    }
    return { doc: w2, removed: rb.removed };
  }, { label: `place-build ${cmd} ${poi} world`, indent: 1 });
  if (remove) { console.log(`removed ${poi} from ${p}/${w}: ${removes.length} entity roots, ${ownOps.length} operators, own patches + clearings`); return; }
  if (operators.length) wg("op-apply", ["op", w, "--project", p, "--apply", path.join(JOB, "operators.json")]);
  if (p === lab) { // L (o-smalls 2026-10-30: a place with no operators skipped this, so a layout rock-kit structure stayed 4% embedded and failed float; the re-seat is general). L (KNUCKLECROWN 2026-10-29): a retaining wall's backfill regrades the treads AFTER the plan seated the
    // pieces on them (cairns buried in the tread): re-seat the place's pieces (not the leaning set pieces) on the lab ground as built, seats carried into ops.json
    // L (o-sunwine3 2026-10-31): a piece HELD at its layout `y` (tag `held`: a pier deck over the bed, a pillar on a cave hall floor) and
    // every piece in a layout cave (tag `cave:<id>`) keep the plan's height: re-seated on the walked ground they went to the sea bed
    // and the cliff top 80 m over the hall
    const d0 = read(SF), ids = new Set(Object.keys(d0.entities).filter((id) => (d0.entities[id].tags ?? []).includes(`poi:${poi}`) && !(d0.entities[id].tags ?? []).includes("solver") && !(d0.entities[id].tags ?? []).some((t: string) => /^(lean|cave):/.test(t) || t === "held" || t === "wall-cap" /* on a boundary wall cap (layout onWall): never re-seated on the ground */)));
    const st = seatPlaced(p, d0, ids), fb = walkField(createWorldField(worldRecipeSchema.parse(read(WF))));
    let dg: ((x: number, z: number) => number) | undefined; const thinRows: string[] = []; // the drawn ground (thin props only: built on first use)
    // a piece the tread was raised OVER is buried (float never re-seats those): sink it to the lowest built ground round its foot (1.4 m ring: seated wants no daylight on its low side)
    for (const r of st.rows as any[]) {
      if (r.status !== "off" || Number.isFinite(r.gap) || r.kind !== "scene" || st.ops.some((o: any) => o.id === r.id)) continue;
      const hs = [0, 1, 2, 3, 4, 5, 6, 7].map((k) => fb.height(r.x + 1.4 * Math.cos(k * Math.PI / 4), r.z + 1.4 * Math.sin(k * Math.PI / 4))), g = Math.min(...hs, fb.height(r.x, r.z)) - 0.03;
      const e = d0.entities[r.id], t = e?.components?.transform; if (!t || !(g > r.y + 0.01)) continue;
      // L (Red Dial 2026-10-30): a kit structure with a declared footing keeps the plan's seat (its footing is MEANT to be in
      // the levelled ground; lifted to a 1.4 m ring round its centre it stood 0.2-1.7 m clear on its outline)
      if (footingOf(e?.components?.prefab?.prefabId) > 0) continue;
      const q = t.position ?? [0, 0, 0]; st.ops.push({ op: "set-component", id: r.id, component: "transform", data: { ...t, position: [q[0], Math.round((q[1] + g - r.y) * 1000) / 1000, q[2]] } });
    }
    // L (Red Dial 2026-10-30): a piece the footpath grades cut under still shows daylight at its edges after the centre
    // re-seat: sink it to the lowest built ground under its WHOLE turned footprint, capped by its declared footing (sinkToBase)
    // every piece (seatPlaced reports only the faulty ones), its world foot = the place root's position + its own (no root turn)
    for (const id of ids) {
      const e = d0.entities[id], t0 = e?.components?.transform, prefab = e?.components?.prefab?.prefabId; if (!t0 || typeof prefab !== "string") continue;
      if ((e.tags ?? []).some((g: string) => /^(on|lift):/.test(g))) continue; // up on another piece or lifted on purpose: not the ground's
      // L (o-smalls 2026-10-30: a layout rock-kit lookout rock was embedded by seatPlaced above, then this pass lifted it back to
      // its lowest ground and float failed "embedded 3% (< 10%)"): a rock keeps the embed seatPlaced gives it (rocks embed, never sink to a base)
      // L (r-go-crown3 2026-11-11, Ribcrown: 16 dragon-bones pieces, catalogue contact embed, lifted back to their base and
      // failed float "embedded 2% (< 10%)"): every piece whose catalogue contact is embed keeps seatPlaced's embed, not only rock-kit
      if (String(prefab).startsWith("rock-kit/") || contactOf(prefab) === "embed") continue;
      const root = e.parent ? d0.entities[e.parent]?.components?.transform?.position ?? [0, 0, 0] : [0, 0, 0];
      const prior = st.ops.find((o: any) => o.op === "set-component" && o.id === id) as any, t = prior?.data ?? t0, q = t.position ?? [0, 0, 0];
      const r = { id, x: root[0] + q[0], z: root[2] + q[2] };
      const y = root[1] + q[1], size = propInfo(prefab)?.size, k = Array.isArray(t.scale) ? t.scale[0] : 1, rot = t.rotation ?? [0, 0, 0, 1];
      if (!size) continue;
      const footing = footingOf(prefab);
      // a kit structure with a declared footing is sized by its catalogue box (rubble spread and all): sunk to the lowest
      // ground under that box it came out BURIED (float, 2026-10-30) — it keeps the plan's seat; props and posts only
      if (footing > 0) continue;
      // L (r1b 2026-10-31, Drinking Stone: layered bedrolls z-fought uneven ground at every sink depth): a THIN GROUND PROP
      // (rug, mat, hide, pallet, bedroll) or a piece with a broad low plate (trough floor, cage floor; _place-quality planeSeatKind) is TILTED to the plane fitted to the DRAWN ground
      // under its footprint and seated so that ground runs clear of every up-facing layer (thinTiltSeat), never sunk level
      if (!(e.tags ?? []).includes("bedded")) { const hgt = size[1] * k, faces = thinFaces(prefab).map((f) => ({ h: f.h * k, area: f.area * k * k }));
        const kind = planeSeatKind(hgt, faces, size[0] * size[2] * k * k, structureBase(prefab)?.cells.map((c) => c[2] * k)); if (kind) {
          const ts = thinTiltSeat(dg ??= drawnGround(createWorldField(worldRecipeSchema.parse(read(WF))), Object.values(d0.entities as Record<string, any>).find((x) => x.components?.voxelWorld)?.components?.voxelWorld?.mesher ?? "auto"), [r.x, r.z], 2 * Math.atan2(rot[1], rot[3]), [(size[0] * k) / 2, (size[2] * k) / 2], hgt, faces, 0.25, kind === "thin" ? THIN_TILT_MAX_DEG : PLATE_TILT_MAX_DEG);
          thinRows.push(`${id.replace(`${poi}-`, "")} (${kind}) ${ts.slopeDeg} deg, ground ${ts.level} m up, clear ${ts.clear} m`);
          const data = { ...t, rotation: ts.rotation, position: [q[0], Math.round((q[1] + ts.y - y) * 1000) / 1000, q[2]] };
          if (prior) prior.data = data; else st.ops.push({ op: "set-component", id: r.id, component: "transform", data }); continue;
        } }
      // L (r-go-scarp3 2026-11-11, south-scarp salt-vent: a BEDDED mound on 1.35 m of fall, sunk to its lowest ground by the
      // plan, was raised here to the 0.6 m cap and float failed "bedded piece hovers"): a bedded piece is sunk on purpose, so
      // the cap never lifts it (float holds it to its lowest ground)
      const bedded = (e.tags ?? []).includes("bedded");
      let ny = sinkToBase({ x: r.x, y, z: r.z, yaw: 2 * Math.atan2(rot[1], rot[3]) }, [(size[0] * k) / 2, (size[2] * k) / 2], bedded ? 6 : Math.max(footing * k, 0.6 /* the plan's own SINK_MAX_M */), (x, z) => fb.height(x, z));
      // L (o-fill4 2026-10-31, Noon Stone: a toppled stele resting on its flared base and cap stood 0.19 m clear along its
      // shaft): the catalogue box assumes a FLAT bottom. A piece whose base outline is not flat (a lying stele, a heap) is
      // sunk until no outline cell shows daylight (the seated gate's measure), at most 0.6 m under its highest ground
      const b0 = isLeaned(rot) ? null : structureBase(prefab);
      let outlineG: number[] = [];
      let outlineWant: number | null = null; // the outline sink a raised base cell asked for (the thin seat below keeps it)
      if (b0) {
        const base = scaleBase(b0, k), yawR = 2 * Math.atan2(rot[1], rot[3]), at0 = ny ?? y;
        const per = base.perimeter.map(([x, z, yb]) => { const w = toWorldYaw([r.x, r.z], yawR, x, z), g = fb.height(w[0], w[1]); return { need: g - yb, g }; });
        // the ground each base cell needs its origin at (ground minus the cell bottom: a round log meets the ground on one
        // line, its sides stand higher); a piece on legs (low fill) is read by its box, where its feet are
        // L (r1b 2026-10-31, Salt-Wagon Halt: a supine corpse, fill 0.18, its outline the torso 0.17 m over the hands that are its
        // mesh bottom, stood 0.105 m clear by the seated gate): an outline wholly above the mesh foot is a raised BODY, not feet, and
        // is read cell by cell like a solid base (the seated gate judges it there)
        if (b0.fill >= SKIRT_MIN_FILL || Math.min(...base.cells.map((q) => q[2])) > FLAT_BASE_M) outlineG = base.cells.map(([x, z, yb]) => { const w = toWorldYaw([r.x, r.z], yawR, x, z); return fb.height(w[0], w[1]) - yb; });
        const gap = Math.max(...per.map((p) => at0 - p.need));
        if (gap > SEAT_GAP_M) { const want = Math.max(Math.min(...per.map((p) => p.need)) - 0.02, Math.max(...per.map((p) => p.g)) - 0.6); if (want < at0 - 0.01) { ny = Math.round(want * 1000) / 1000; outlineWant = ny; } }
      }
      // L (r1 2026-10-31, Drinking Stone): a flat bottom seated flush on flat ground z-fights it, so every piece seated here
      // stands at least FLUSH_SINK_M under the LOWEST ground of its box; a thin piece (bedroll, cage floor, trough) is never
      // buried past half its height at its HIGH side (sunk deeper, its top lay flush with the uphill ground and z-fought there)
      { const yawR = 2 * Math.atan2(rot[1], rot[3]), c = Math.cos(yawR), sn = Math.sin(yawR), hx = (size[0] * k) / 2, hz = (size[2] * k) / 2, hgt = size[1] * k;
        let lo = Infinity, hi = -Infinity;
        // the ground under its BASE OUTLINE when it has one (a cage on four feet: its catalogue box reached 0.12 m lower ground)
        if (outlineG.length) { lo = Math.min(...outlineG); hi = Math.max(...outlineG); } else for (let i = 0; i <= 4; i++) for (let j = 0; j <= 4; j++) { const lx = -hx + (hx * i) / 2, lz = -hz + (hz * j) / 2, h = fb.height(r.x + lx * c + lz * sn, r.z - lx * sn + lz * c); lo = Math.min(lo, h); hi = Math.max(hi, h); }
        let want = Math.min(ny ?? y, lo - FLUSH_SINK_M);
        // a THIN piece is layered (a bedroll: faces at 0, 0.04 and 0.1 m): it sinks FLUSH_SINK_M under its MEDIAN ground, so
        // each face clears the ground by ~0.03 m on the ground it mostly stands on, never past half its height at its high side,
        if (hgt <= THIN_PIECE_M) { const gs = outlineG.length ? [...outlineG].sort((m, n) => m - n) : [lo, hi]; want = Math.min(Math.max(gs[Math.floor(gs.length / 2)]! - FLUSH_SINK_M, hi - hgt / 2), lo + SEAT_GAP_M - 0.01); if (outlineWant !== null) want = Math.min(want, outlineWant); } // L (r-go-crown3 2026-11-11, Ribcrown chain-coil: a coil whose base outline has a link 0.12 m over its mesh foot was re-lifted by this thin seat and the seated gate saw 0.12 m of daylight): the outline sink stands // and never more daylight on its low side than the seated gate allows
        ny = Math.abs(want - y) < 0.002 ? null : Math.round(want * 1000) / 1000; }
      if (ny === null) continue;
      const data = { ...t, position: [q[0], Math.round((q[1] + ny - y) * 1000) / 1000, q[2]] };
      if (prior) prior.data = data; else st.ops.push({ op: "set-component", id: r.id, component: "transform", data });
    }
    if (thinRows.length) console.log(`  thin/plated props tilted to the drawn ground: ${thinRows.length} (${thinRows.slice(0, 6).join("; ")}${thinRows.length > 6 ? "; ..." : ""})`);
    // THE PLACEMENT SOLVER on the ground AS BUILT (t-place 2026-10-30): every piece the plan seated by the solver (tag
    // `solver`) is re-solved where it stands (xz kept) after the operators' backfill: y by its rule, its foundation skirt
    // re-written down to the lowest ground as built. It replaces the re-seat / sink / seat-pad passes for those pieces.
    const solverIds = Object.keys(d0.entities).filter((id) => (d0.entities[id].tags ?? []).includes(`poi:${poi}`) && (d0.entities[id].tags ?? []).includes("solver"));
    const fops: any[] = [];
    if (solverIds.length) {
      // the place's own pieces were judged against each other by the plan (layout `over`, overlap refusals): never re-refused here
      // (r-found 2026-10-31: a house seated legacy became an obstacle and dropped its street wall's skirt)
      const own = new Set(Object.keys(d0.entities).filter((id) => (d0.entities[id].tags ?? []).includes(`poi:${poi}`)));
      const sv = solveScenePieces(p, d0, (x, z) => fb.height(x, z), solverIds, { movable: false, ctx: { exclude: own } });
      for (const o of sv.ops) (o.op === "set-component" ? st.ops : fops).push(o);
      // a piece the plan placed but the ground as built refuses (a path cut steepened it past its slope tolerance) is held where
      // it stands and skirted there (holdY), never left on the plan's skirt over moved ground (r-found 2026-10-31: t1-e2w 0.94 m)
      const refusedIds = sv.rows.filter((r) => r.status === "dropped").map((r) => r.id);
      if (refusedIds.length) { const hv0 = solveScenePieces(p, d0, (x, z) => fb.height(x, z), refusedIds, { movable: false, holdY: true }); for (const o of hv0.ops) if (o.op !== "set-component") fops.push(o); for (const r of hv0.rows) if (r.status !== "dropped") console.log(`  held after a refusal: ${r.id}${r.foundation ? " (skirted where it stands)" : ""}`); }
      write(PLACE_SOLVE_FILE(JOB), { at: new Date().toISOString(), stage: "build", rows: sv.rows });
      const refused = sv.rows.filter((r) => r.status === "dropped");
      console.log(`  placement solver: ${sv.rows.length} piece(s) re-solved on the ground as built, ${sv.rows.filter((r) => r.foundation).length} foundation skirt(s)${refused.length ? `, ${refused.length} REFUSED: ${refused.slice(0, 3).map(solveLine).join(" | ")}` : ""}`);
    }
    // L (r-found 2026-10-30, Derek: "a lot of the ruins are still hovering"): a LEGACY-seated piece with a declared foundation
    // (tag `found`: a levelled open court, a walked-on slab, a small fall) keeps its height and gets a foundation skirt
    // wherever the ground as built still shows daylight under it (core solvePlacement holdY): no move, no pad
    const foundIds = Object.keys(d0.entities).filter((id) => (d0.entities[id].tags ?? []).includes(`poi:${poi}`) && (d0.entities[id].tags ?? []).includes("found"));
    if (foundIds.length) {
      const dh = applyOps(d0, st.ops.filter((o: any) => o.op === "set-component") as never, reg).doc;
      const hv = solveScenePieces(p, dh, (x, z) => fb.height(x, z), foundIds, { movable: false, holdY: true });
      for (const o of hv.ops) if (o.op !== "set-component") fops.push(o);
      console.log(`  held foundations: ${foundIds.length} legacy-seated piece(s) with a declared foundation, ${hv.rows.filter((r) => r.foundation).length} skirted where they stand`);
    }
    // L (Red Dial 2026-10-30: a fire bowl `on` a pillar floated after the pillar was re-seated): a piece `on` a moved
    // piece moves with it (same dy), down a chain of `on` pieces
    for (let moved = true, guard = 0; moved && guard < 4; guard++) {
      moved = false;
      for (const o of [...st.ops] as any[]) {
        if (o.op !== "set-component") continue;
        const dy = o.data.position[1] - (d0.entities[o.id]?.components?.transform?.position?.[1] ?? o.data.position[1]); if (Math.abs(dy) < 1e-4) continue;
        const short = o.id.replace(`${poi}-`, "").replace(/^[^-]+-/, ""); // red-dial-core-pillar-w3 -> pillar-w3 (layout id)
        for (const id of ids) {
          const c = d0.entities[id]; if (!(c?.tags ?? []).includes(`on:${short}`) || st.ops.some((x: any) => x.op === "set-component" && x.id === id)) continue;
          const tc = c.components.transform, pc = tc.position ?? [0, 0, 0];
          st.ops.push({ op: "set-component", id, component: "transform", data: { ...tc, position: [pc[0], Math.round((pc[1] + dy) * 1000) / 1000, pc[2]] } }); moved = true;
        }
      }
    }
    if (st.ops.length || fops.length) {
      // the re-seat lands on the scene as it is on disk now (locked re-read), never on d0 read before the seat solve (o-wild4)
      updateJsonFile(SF, (fresh: any) => ({ doc: applyOps(fresh, [...st.ops, ...fops] as never, reg).doc, removed: removalsOf(fops, fresh) }), { label: `place-build ${cmd} ${poi} re-seat`, indent: 1 }); // a dropped foundation skirt is a declared removal (L o-fix2 tide-chapel 2026-11-03)
      const byId = new Map(st.ops.filter((o: any) => o.op === "set-component").map((o: any) => [o.id, o.data]));
      let jops = read(path.join(JOB, "ops.json")) as any[];
      for (const o of jops) if (o.op === "add-entity" && byId.has(o.id)) o.entity.components.transform = byId.get(o.id);
      // the solver's foundation skirts as built replace the plan's (the live install writes these ops)
      const gone = new Set(fops.filter((o) => o.op === "remove-entity").map((o) => o.id));
      jops = [...jops.filter((o) => !(o.op === "add-entity" && gone.has(o.id))), ...fops.filter((o) => o.op === "add-entity")];
      write(path.join(JOB, "ops.json"), jops); console.log(`  re-seated ${st.ops.length} piece(s) on the ground as built (operator backfill); ops.json updated`);
    }
  }
  // L (Red Dial 2026-10-30): SEAT PADS after the footpaths — a piece whose base still shows daylight on the ground as built
  // (a 2.5 m pillar on 0.8-1.5 m of fall, past the sink cap) gets a small feathered level pad at its foot (seatPad, capped
  // SEAT_PAD_MAX_M; never under a kit structure with a declared footing). Measured on the lab, kept in seat-pads.json so the
  // live install appends the same patches AFTER its own op-apply (later height patches win)
  if (!remove) {
    const spf = path.join(JOB, "seat-pads.json");
    let pads: any[] = [];
    if (p === lab) {
      const d1 = read(SF), fb2 = walkField(createWorldField(worldRecipeSchema.parse(read(WF))));
      const raw: SeatPadRaw[] = [];
      for (const [id, e] of Object.entries(d1.entities) as [string, any][]) {
        const tags: string[] = e.tags ?? [], prefab = e.components?.prefab?.prefabId, t = e.components?.transform;
        if (!tags.includes(`poi:${poi}`) || tags.includes("solver") || tags.includes("found") || tags.includes("bedded") || tags.includes("held") || tags.some((g) => /^(on|lift|lean|cave):/.test(g)) || typeof prefab !== "string" || !t) continue; // a solver piece never gets a seat pad (its foundation covers the fall); a bedded piece is sunk on purpose
        const info = propInfo(prefab); if (!info?.size || info.footing || isLeaned(t.rotation ?? [0, 0, 0, 1])) continue; // a thin prop tilted to its ground (thinTiltSeat) gets no pad: it lies on the ground as it is
        const root = e.parent ? d1.entities[e.parent]?.components?.transform?.position ?? [0, 0, 0] : [0, 0, 0], q = t.position ?? [0, 0, 0], rot = t.rotation ?? [0, 0, 0, 1], k = Array.isArray(t.scale) ? t.scale[0] : 1;
        const x = root[0] + q[0], z = root[2] + q[2], pad = seatPad({ x, y: root[1] + q[1], z, yaw: 2 * Math.atan2(rot[1], rot[3]) }, [(info.size[0] * k) / 2, (info.size[2] * k) / 2], (a, b) => fb2.height(a, b));
        if (pad) raw.push({ id: id.replace(`${poi}-`, ""), at: [x, z], radius: pad.radius, y: pad.y, gap: pad.gap });
      }
      // overlapping pieces (a spit over its pyre) share ONE pad at the lowest base, never two at different heights (dropped-hour)
      for (const m of mergeSeatPads(raw)) pads.push({ ...padPatch(`${PREFIX}seatpad-${m.id}`, m.at, m.radius, m.y - 0.02, 2, true /* raise-only: a pad never cuts from under the next piece up the slope */), gap: m.gap });
      write(spf, pads);
    } else if (fs.existsSync(spf)) pads = read(spf);
    if (pads.length) {
      const ids3 = new Set(pads.map((q) => q.feature.id)); // seat pads onto the recipe as it is on disk, under its lock (o-wild4)
      updateJsonFile(WF, (fresh: any) => {
        const rb = placeWorldRebase(fresh, (f: any) => ids3.has(f?.id), pads.map((q) => ({ kind: "heightPatches", feature: q.feature })));
        worldRecipeSchema.parse(rb.doc); return rb;
      }, { label: `place-build ${cmd} ${poi} seat pads`, indent: 1 });
      console.log(`  seat pads: ${pads.length} piece(s) on a level pad at their foot after the paths (${pads.map((q) => `${q.feature.id.slice(PREFIX.length + 8)} ${q.gap} m`).join(", ")})`);
      // the footpaths are baked again on the padded ground (op-check: STALE "the ground under it moved" otherwise)
      if (operators.length) wg("op-apply", ["op", w, "--project", p, "--apply", path.join(JOB, "operators.json")]);
    }
  }
  if (!remove && p === lab) { // L: routes on the walk surface as BUILT (pads, raiseOnly, the footpaths' grade patches): re-measured on the lab ground AFTER the operators
    const f = walkField(createWorldField(worldRecipeSchema.parse(read(WF)))), hand = read(path.join(JOB, "handoff.json"));
    // the footpath legs follow their carved track as built (routeOnTrack: the road's own graded points, its pieces in order)
    const roads = (read(WF).features.roads ?? []) as any[];
    for (const r of hand.navigation.routes) {
      const id = footpathTrackId(poi, r.id), pieces = roads.filter((x) => x.id === id || String(x.id).startsWith(`${id}.`));
      const pts = pieces.flatMap((x) => (x.points ?? []) as number[][]).map((q) => (q.length >= 3 ? [q[0]!, q[1]!, q[2]!] : [q[0]!, f.height(q[0]!, q[1]!), q[1]!]));
      if (pts.length >= 2) r.points = routeOnTrack(r.points, pts, (pieces[0]?.width ?? FOOTPATH_WIDTH_M[1]) / 2);
    }
    // a deck route stays on the deck; a route's last `builtLast` points (layout walkOn: a ledge, a porch) stay on the built piece
    for (const r of hand.navigation.routes) if (!r.onBuilt) r.points.forEach((q: number[], i: number) => { if (!(r.builtLast > 0 && i >= r.points.length - r.builtLast)) q[1] = Math.round(f.height(q[0]!, q[2]!) * 100) / 100; });
    // L (r-found 2026-10-30: a yard's levelling cut 0.77 m under the coldblocks reach, measured on the PLANNED ground, and
    // walk read it as a MISS): an area's reach on the ground (no declared floorY) is re-measured on the ground as built too
    for (const a of (hand.siteDressing?.areas ?? []) as any[]) if (Array.isArray(a.reach) && a.reach.length === 3 && a.floorY === undefined) a.reach[1] = Math.round(f.height(a.reach[0], a.reach[2]) * 100) / 100;
    // a layout cave is walked on the floor its operator carved (the bore it chose, the hall), never the cliff top over it
    hand.navigation.routes = (hand.navigation.routes as any[]).filter((r) => !r.cave);
    const drawnCave = (hand.navigation.caves ?? []).length ? drawnGround(f) : null;
    for (const c of (hand.navigation.caves ?? []) as CaveWalk[]) {
      const r = caveWalkRoute(c, read(WF).features, hand.navigation.routes, (x, z) => f.height(x, z), (x, z, y) => drawnCave!(x, z, walkGroundFrom(f, y)(x, z), 2.5)); // the DRAWN floor (the mesh the body walks), nearest the field's floor under the rock
      if (r) { hand.navigation.routes.push(r); console.log(`  cave walk ${r.id}: ${r.points.length} points, ${r.note}`); } else console.log(`  cave walk ${c.id}: no bore ${c.operator} in the world (operator refused?)`);
    }
    write(path.join(JOB, "handoff.json"), hand); write(path.join(JOB, "walk-route.json"), hand.navigation.routes[0]);
  }
  for (const o of operators.filter((o) => o.op === "wall" || o.op === "landmark")) { // walls and built landmarks (a bridge) bake the same way
    const r = tool(`bake-${o.id}`, ["tools/landmark.mts", p, w, o.id]); if (r.status) fail(`bake ${o.id} failed (reports/bake-${o.id}.log)`); }
  wg("clearings", ["vegetation", w, "--project", p, "--clearings", path.join(JOB, "clearings.json")]);
  // a farm's declared fields (<job>/fields.json, ids <poi>-*, owner <poi>): the only ground crop cover grows on (owner ruling
  // 2026-10-30: a desert grows no wheat; a farm does). Removed with the place like its clearings (withoutPlace).
  if (fs.existsSync(path.join(JOB, "fields.json"))) { wg("fields-clear", ["vegetation", w, "--project", p, "--remove-fields", poi]); wg("fields", ["vegetation", w, "--project", p, "--fields", path.join(JOB, "fields.json")]); } // the place's old fields first (a re-planned field changes its ids)
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
      const ap = tool(`dress-${id}`, ["tools/dress.mts", "apply", "--project", p, "--plan", id, "--scene", w, "--at", "0,0,0", "--yaw", "0", "--poi", poi, "--solve"]);
      if (ap.status) console.log(`  dress ${id}: apply FAILED (reports/dress-${id}.log) — ${ap.out.trim().split("\n").slice(-2).join(" | ")}`);
    }
  }
  console.log(`applied ${poi} to ${p}/${w}: ${ops.length} entities, ${worldOps.length} pads, ${operators.length} operators, clearings, ${plans.length} dressing plans`);
  // the job is now live: zonegen status/bind read the stage, so a place-build install stamps it (gate 2 still applies: readShot evidence, no home-made fire)
  if (stampsInstalled({ target: p, lab, remove, dry, jobCopy: !!opt("job") })) try { setStage(JOB, "installed"); } catch (e) { console.log(`WARN stage not moved to installed: ${String((e as Error).message).slice(0, 200)}`); }
}

/** L (Wristgate 2026-10-29: `gates` crashed on reports/plan.json): a HERO place's owner writes its own build (build-spec, no
 *  `plan`), so the gates take the area from its handoff instead: centre = the landmark (else the first dressing area), pockets
 *  = the dressing areas' centres. A planned place keeps its plan. */
export function gatePlan(job: string, hand: any): { centre: V2; pockets: { at: V2 }[]; requested?: unknown } {
  const f = path.join(job, "reports", "plan.json");
  if (fs.existsSync(f)) return JSON.parse(fs.readFileSync(f, "utf8"));
  const areas = (hand?.siteDressing?.areas ?? []).filter((a: any) => Array.isArray(a.centre)).map((a: any) => ({ at: [a.centre[0], a.centre[1]] as V2 }));
  const centre = (Array.isArray(hand?.landmark?.at) ? [hand.landmark.at[0], hand.landmark.at[1]] : areas[0]?.at) as V2 | undefined;
  if (!centre) throw new Error(`no reports/plan.json and no handoff landmark.at / siteDressing.areas in ${job}: cannot place the gates`);
  return { centre, pockets: areas };
}

// ---------------------------------------------------------------------------------------------------------------------
const GATES = ["design", "size", "fine", "roads", "lips", "scatter-float", "float", "seated", "rock-skins", "water-edges", "zfight", "op-check", "art", "scale", "support", "wash", "walk", "dress", "place"] as const;
function gates(onlyArg?: string[]) {
  const hand = read(path.join(JOB, "handoff.json")), plan = gatePlan(JOB, hand);
  const pts = [plan.centre, ...plan.pockets.map((k: any) => k.at)] as V2[], c = plan.centre as V2;
  const R = Math.ceil(Math.max(...pts.map((q) => Math.hypot(q[0] - c[0], q[1] - c[1]))) + 30), near = `${Math.round(c[0])},${Math.round(c[1])},${R}`;
  const only = onlyArg ?? opt("only")?.split(","), rows: any[] = [], rep = (n: string) => path.join(JOB, "reports", `${n}.json`);
  const okOf = (n: string) => { try { return read(rep(n)).ok === true; } catch { return false; } };
  const gate = (name: string, fn: () => { ok: boolean; detail: string; deferred?: boolean }) => { if (only && !only.includes(name)) return; const t0 = Date.now(); let r: { ok: boolean; detail: string; deferred?: boolean }; try { r = fn(); } catch (e: any) { const at = [...String(e.stack ?? "").matchAll(/\n\s+at .*?([\w.-]+\.m?ts:\d+)/g)].slice(0, 3).map((m) => m[1]).join(" < "); r = { ok: false, detail: `${e.message}${at ? ` (at ${at})` : ""}` }; } rows.push({ gate: name, ok: r.ok, detail: r.detail, ...(r.deferred ? { deferred: true } : {}), s: Math.round((Date.now() - t0) / 1000) }); console.log(`${r.deferred ? "def " : r.ok ? "ok  " : "FAIL"} ${name.padEnd(13)} ${r.detail}`); };
  const job = ["../../tools/poi-review/job.mjs"], last = (o: string) => { const ls = o.trim().split("\n").filter((l) => l.trim() && !l.startsWith("[") && !/deprecated/.test(l)); return [...ls].reverse().find((l) => /FAIL|\bok\b|OK|PASS|fault/i.test(l)) ?? ls[ls.length - 1] ?? ""; };
  // gate 16 (owner ruling 2026-10-22: a zone of places passed every gate below and read as nothing): the design is written,
  // one area is finished at player height, and a fresh reviewer has passed the Place lines on it; the install refuses without it
  gate("design", () => { const r = tool("design", [...job, "design", JOB, "--no-sample"], true); /* --no-sample: the sample frames are a SHOT row (render-batch) */ return { ok: r.status === 0, detail: last(r.out).replace(/^(review|design \(gate 16\) FAIL):\s*/, "").slice(0, 300) }; });
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
  // L (o-smalls 2026-10-30): `bg` rows are the tool's own BACKGROUND ("not failed on"): never charged as new
  const findings = (out: string) => out.split("\n").filter((l) => /\bat \(/.test(l) && !/^\s*bg\s/.test(l)).map((l) => l.trim().replace(/\s+/g, " ").replace(/(\bat \([^)]*\)).*/, "$1"));
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
  gate("heroes", () => heroCheck());
  gate("features", () => featureCheck());
  gate("shelters", () => shelterCheck());
  gate("camp", () => campCheck());
  gate("abut", () => abutCheck());
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
    const j = read(rep("zfight")), found = newZfightClusters(j, fs.existsSync(rep("zfight-live")) ? read(rep("zfight-live")) : null, labWorld, world);
    // L (o-coast 2026-10-31, coordinator ruling): a PREFAB's own self z-fight (both meshes inside one catalogued prefab:
    // sailing-cutter-furled hull vs rig) is the kit's fault, logged in authoring/kit-faults.md for a kit agent, not the
    // place's: a dated row in <job>/quality-exceptions.json (gates ["zfight"], match { rule: "prefab-self", what: <prefab id> })
    const selfRules = jobExceptions(JOB, "zfight").filter((e: any) => e.match.rule === "prefab-self" && typeof e.match.what === "string");
    // L (o-coast sunwine-hold 2026-10-31): a COMPOSITE prefab (spoilgate/counting-table holds interior-props/table-b + book-c)
    // names its nested parts' prefabs in the mesh path, never its own: both meshes under ONE placed entity whose prefab is
    // the excepted one is the same self z-fight
    const opPrefab = new Map<string, string>(((read(path.join(JOB, "ops.json")) as any[]) ?? []).map((o: any) => [String(o.id), String(o.entity?.components?.prefab?.prefabId ?? "")]));
    const ent = (m: string) => String(m).split("/")[0]!;
    const selfOf = (c: any) => selfRules.find((e: any) => [c.a.mesh, c.b.mesh].every((m: string) => String(m).includes(`/${e.match.what}:`))
      || (ent(c.a.mesh) === ent(c.b.mesh) && opPrefab.get(ent(c.a.mesh)) === e.match.what));
    const mine = found.filter((c: any) => !selfOf(c)), selfExcused = found.length - mine.length;
    if (mine.length) return { ok: false, detail: `FAIL ${mine.length} new${selfExcused ? ` (${selfExcused} prefab self z-fight excepted)` : ""}: ${mine.slice(0, 2).map((c: any) => `${c.a.mesh} vs ${c.b.mesh} ${c.area} m2 at ${c.centre.map(Math.round)}`).join("; ")}`.slice(0, 300) };
    write(rep("zfight"), { ...j, passed: true, ok: true, preExisting: (j.failures ?? []).length, own: [] });
    return { ok: true, detail: `${(j.failures ?? []).length} cluster(s) the live world has too, none new${selfExcused ? `; ${selfExcused} prefab self z-fight(s) excepted by quality-exceptions.json` : ""}` }; });
  gate("op-check", () => { const r = tool("op-check", ["tools/worldgen.mts", "op", labWorld, "--project", lab, "--check"]); const mine = r.out.split("\n").filter((l) => l.includes(PREFIX) && /EDITED|MISSING|STALE/.test(l)); return { ok: mine.length === 0, detail: mine.length ? mine.slice(0, 3).join(" | ") : `${PREFIX}* operators current` }; });
  // L (art, signal-tower 2026-10-21): measured in the LAB (the live scene still held the old install's barrel)
  gate("art", () => { const r = tool("art", ["tools/art-check.mts", JOB, "--culture", "human", "--project", lab, "--world", labWorld, ...(opt("job") ? ["--home", project, "--home-world", world] : [])]); return { ok: r.status === 0 && okOf("art-check"), detail: last(r.out).slice(0, 220) }; });
  gate("scale", () => scaleCheck());
  gate("support", () => supportCheck());
  gate("wash", () => washCheck());
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
  write(rep("gates"), { ok: GATES.every((g) => merged.some((r: any) => r.gate === g)) && merged.every((r: any) => r.ok) /* every listed gate ran (gates outside GATES, e.g. heroes/shelters/abut, count too: o-smalls 2026-10-31, the length test failed every place once they were added) */, lab, at: new Date().toISOString(), rows: merged });
  if (rows.some((r) => !r.ok)) process.exitCode = 1;
}
/** WASH (Red Dial 2026-10-30, Derek: "so washed out from how bright that lighting is"; the far-read rule "fires > 4 px
 *  at 450 m" had been passed with glow 4 + glowReach 800 halos 10 m across): the evidence run (shots, light-shots --wash)
 *  judges every frame against the wash band (near/mid luma, blown white, glare, and the share the halos + lamp fog glow
 *  alone brighten) and every far fire at dusk by its FLAME with a modest glow (tools/_light-wash.mts). Read from
 *  evidence/<lab>.json; a run without it fails ("run shots"). */
/** SUPPORT (Red Dial 2026-10-30, Derek: "a lot of the braziers that are on top of pillars are not centred, or are hanging
 *  off edges and clipping through some geometry"): every piece `on` another (no sink, no lean) as planned stands on its
 *  host's named marker or a pedestal's top-face centre; its base may not hang off the host's top (overhang share >
 *  SUPPORT_OVERHANG_SHARE) and the host's mesh may not rise into it (clip > SUPPORT_CLIP_M). Read from reports/plan.json
 *  `support` (planPlace supportOf), written to reports/support.json. */
function supportCheck(): { ok: boolean; detail: string } {
  const f = path.join(JOB, "reports", "plan.json"); if (!fs.existsSync(f)) return { ok: false, detail: "no reports/plan.json: run plan" };
  const rows = read(f).support as { id: string; on: string; overhang: number; clip: number; ok: boolean }[] | undefined;
  if (!rows) return { ok: false, detail: "the plan has no support rows (planned before the support gate): run plan" };
  const bad = rows.filter((r) => !r.ok);
  write(path.join(JOB, "reports", "support.json"), { ok: !bad.length, at: new Date().toISOString(), rows });
  return { ok: !bad.length, detail: bad.length ? `${bad.length} of ${rows.length}: ${bad.slice(0, 4).map((r) => `${r.id} on ${r.on} overhang ${Math.round(r.overhang * 100)} % clip ${r.clip} m`).join("; ")}` : `${rows.length} piece(s) on hosts: none overhangs or clips` };
}
/** WASH is a SHOT row (Derek 2026-10-31, batch-renders-after-install): judged from the newest evidence that is current for
 *  the ops: the latest batch render of the LIVE world (evidence/live/<batch>.json, place-build render-batch), else a lab
 *  shots run newer than the ops; with neither the row is DEFERRED (ok, never an install block): the batch judges it after
 *  the install and a fault there is a fix round. */
function washCheck(): { ok: boolean; detail: string; deferred?: boolean } {
  const ev = shotEvidence(JOB, path.join(JOB, "evidence", `${labWorld}.json`));
  if (ev.kind === "batch") { const r = washJudge(JOB, poi, ev.file, (ev.rec.planned ?? []).filter((v: string) => !isReviewShot({ spot: v }))); return { ok: r.ok, detail: `batch ${ev.rec.batch}: ${r.detail}` }; }
  if (ev.kind === "lab") return washJudge(JOB, poi, ev.file);
  return { ok: true, deferred: true, detail: `deferred to the batch render (${ev.why}; place-build render-batch after the install)` };
}
/** The wash verdict of one evidence run (a lab shots run or a place's batch record) -> <job>/reports/wash.json.
 *  `want`: the views the run had to hold (default: every judged view in views.json; a batch: the views it planned). */
function washJudge(job: string, id: string, f: string, want?: string[]): { ok: boolean; detail: string } {
  if (!fs.existsSync(f)) return { ok: false, detail: "no evidence run: run shots" };
  const run = read(f), v = run.washVerdict;
  if (!v) return { ok: false, detail: "the evidence run has no wash verdict (shots from before the wash gate): run shots" };
  // L (o-fill2 2026-10-31: salt-wagon-halt's 18 blank luma-14 frames were judged "near/mid luma 13.8 < 25" and "nothing burns
  // at dusk"): a run with failed renders (light-shots blackFrames) is no evidence; say so instead of judging the light
  // (the iso-* overviews are review-only: a failed or skipped one never fails the wash gate; re-shoot it with --merge)
  const blank = ((run.blackFrames ?? []) as string[]).filter((b) => !isReviewShot({ spot: b }));
  if (blank.length) return { ok: false, detail: `the evidence run has ${blank.length} failed (blank) render(s): ${blank.slice(0, 6).join(", ")}; re-run shots (render lock; --views ... --merge for a few)` };
  // L (o-gates 2026-10-30): light-shots SKIPS a spot that stalls past --spot-timeout, and the far views are the ones that
  // stall; a run without its concept-far frames then passed the far-fire read as "no far fires in frame". Every view in
  // views.json must be in the evidence run.
  const vf = path.join(job, "views.json"), shot = new Set(((run.shots ?? []) as { spot: string }[]).map((x) => x.spot));
  const judged = want ?? (fs.existsSync(vf) ? (read(vf) as { name: string; review?: boolean }[]).filter((x) => !isReviewShot(x)).map((x) => x.name) : []);
  const missing = judged.filter((n) => !isReviewShot({ spot: n }) && !shot.has(n));
  if (missing.length) return { ok: false, detail: `the evidence run is missing ${missing.length} view(s) (skipped by light-shots --spot-timeout?): ${missing.join(", ")}; ${want ? "re-run the batch (place-build render-batch ... --places " + id + ")" : `re-shoot only those and merge them: ${mergeCommand({ world, project, zone, poi: id, lab: opt("lab") ?? null, port: opt("port") ?? null }, missing)}`}` };
  // L (coordinator ruling 2026-10-30, o-smalls): the far-fire read is a beacon rule (city fires at 300-450 m); a catalogue
  // small place (one camp fire, a gate torch, a wildlife den with none) is not judged by it
  if (artFor(path.join(PROJECTS, project), id, world) === "catalogue") { v.faults = (v.faults ?? []).filter((x: string) => !/^far fires/.test(x)); v.ok = !v.faults.length; }
  // dated wash rulings in <job>/quality-exceptions.json (match { spot } | { rule: "far-fires" }): excused, and reported
  const qx = path.join(job, "quality-exceptions.json"), ex = excuseWashFaults(v.faults ?? [], fs.existsSync(qx) ? ((read(qx).exceptions ?? []) as WashRuling[]) : []);
  v.faults = ex.faults; v.ok = !ex.faults.length;
  write(path.join(job, "reports", "wash.json"), { ...v, excused: ex.excused, at: new Date().toISOString(), run: path.relative(job, f) });
  const exc = ex.excused.length ? `${ex.excused.length} fault(s) excused by quality-exceptions.json (${[...new Set(ex.excused.map((e) => e.by))].join(", ")}); ` : "";
  return { ok: !!v.ok, detail: v.ok ? `${exc}${v.fireLine}; ${v.veilLine}` : v.faults.slice(0, 4).join("; ").slice(0, 400) };
}
/** SCALE (Red Dial 2026-10-30, owner: "you don't have the scale correct with the concept art"; every gate had passed): a
 *  PAINTED place (concept/<poi>.site.json renders) declares <job>/concept-marks.json (conceptMarksSchema: the painting's
 *  pixel box of each hero piece or group) and each marked piece's built world triangles (lab scene, sceneGeometry) are
 *  projected through the painting's own camera (site record camera + target, vfov 60, the painting's size; a piece's
 *  footing under its origin is counted at grade). A judged
 *  width or height more than the tolerance (15 %) off fails, naming the factor it needs. reports/scale.json. */
function scaleCheck(): { ok: boolean; detail: string } {
  const sitef = path.join(JOB, "..", "..", "concept", `${poi}.site.json`), site = fs.existsSync(sitef) ? read(sitef) : null, views = paintedViews(site);
  const mf = path.join(JOB, "concept-marks.json"), out = path.join(JOB, "reports", "scale.json");
  if (!views.length) { write(out, { ok: true, painted: false, at: new Date().toISOString(), rows: [] }); return { ok: true, detail: "not a painted place (no concept site record)" }; }
  // L (o-smalls 2026-10-30: a catalogue small place failed scale for its BARE site renders): a catalogue place has bare renders
  // and no painting, so there is nothing to measure against
  if (artFor(path.join(PROJECTS, project), poi, world) === "catalogue") { write(out, { ok: true, painted: false, at: new Date().toISOString(), rows: [] }); return { ok: true, detail: "catalogue place (bare renders, no painting)" }; }
  if (!fs.existsSync(mf)) { write(out, { ok: false, painted: true, at: new Date().toISOString(), rows: [], faults: ["no concept-marks.json"] }); return { ok: false, detail: `painted place with no concept-marks.json: mark each hero piece's painted pixel box on ${views.join("/")} (docs/place-builder.md "scale")` }; }
  const marks = conceptMarksSchema.parse(read(mf)), r = site.renders[marks.view];
  if (!r?.camera || !r?.target) fail(`concept-marks.json view ${marks.view} is not a render of ${sitef} (${views.join(", ")})`);
  const cam = { eye: r.camera, target: r.target, vfov: marks.vfov, width: marks.image.width, height: marks.image.height };
  const want = new Set(marks.marks.flatMap((m) => m.pieces.map((p) => `${poi}-core-${p}`)));
  const geo = sceneGeometry(path.join(PROJECTS, lab, "assets"), read(sceneFile(lab, labWorld)), (id) => !want.has(id)), byId = new Map(geo.map((g) => [g.id, g]));
  const rows: ScaleRow[] = marks.marks.map((m) => {
    const parts = m.pieces.map((p) => byId.get(`${poi}-core-${p}`));
    if (parts.some((g) => !g)) return compareMark(m, null, marks.tolerance);
    // a piece's footing (catalogued solids run below its grade, the origin) never shows in a painting: counted at grade
    const xyz: number[] = []; for (const g of parts) { const gy = g!.m[13]!; for (let i = 0; i < g!.world.length; i += 3) xyz.push(g!.world[i]!, Math.max(g!.world[i + 1]!, gy), g!.world[i + 2]!); }
    return compareMark(m, screenBox(xyz, cam), marks.tolerance);
  });
  // a dated coordinator ruling in <job>/quality-exceptions.json (gates ["scale"], match { rule: "scale-mark", what: <mark
  // id> }, `max` { w?, h? }: the ruled ratio ceiling) excepts that mark only while it measures at or under the ruled ratio
  // (L o-gates 2026-10-30: the Weeping Sun built ~25 % taller than painted, ruled GRAND; a further growth fails again)
  const ruled = jobExceptions(JOB, "scale").filter((e: any) => e.match.rule === "scale-mark" && typeof e.match.what === "string");
  const excused: string[] = [];
  for (const x of rows) {
    if (x.ok) continue;
    const e: any = ruled.find((q: any) => q.match.what === x.id);
    if (!e) continue;
    const within = (["w", "h"] as const).every((d) => x.ratio[d] == null || (typeof e.max?.[d] === "number" && Math.max(x.ratio[d]!, 1 / x.ratio[d]!) <= e.max[d] + 1e-9));
    if (within) { excused.push(`${x.id} (${e.id}: ${e.ruling.slice(0, 60)})`); (x as any).excepted = e.id; }
  }
  const bad = rows.filter((x) => !x.ok && !(x as any).excepted);
  const extent = scaleExtent(marks, site, want);
  // the same for the EXTENT (match { rule: "scale-extent" }, `min` { area?, width? }: the ruled ratio FLOOR): a narrow site
  // ruled smaller than its painting is excepted only while it measures at or over the floor (L o-gates 2026-10-30, the Moon:
  // a cliff front on a narrow apron, 97 m built vs 124 m painted; widening it would hang pieces over the fall)
  const ex = extent && !extent.ok ? jobExceptions(JOB, "scale").find((e: any) => e.match.rule === "scale-extent") as any : undefined;
  if (ex && extent && (["area", "width"] as const).every((d) => typeof ex.min?.[d] !== "number" || (extent.ratio?.[d] ?? 0) >= ex.min[d] - 1e-9)) { (extent as any).excepted = ex.id; excused.push(`extent (${ex.id}: ${String(ex.ruling).slice(0, 60)})`); }
  const extentOk = !!extent?.ok || !!(extent as any)?.excepted;
  write(out, { ok: !bad.length && extentOk, painted: true, view: marks.view, camera: { eye: cam.eye, target: cam.target, vfov: cam.vfov }, tolerance: marks.tolerance, lab, at: new Date().toISOString(), rows, extent: extent ?? { ok: false, why: "no extent in concept-marks.json" } });
  for (const x of rows) console.log(`  ${x.ok ? "ok  " : "FAIL"} ${x.id.padEnd(16)} painted ${x.painted.w} x ${x.painted.h} px, built ${x.built ? `${x.built.w} x ${x.built.h} px at ${x.built.depth} m` : "-"}  ratio w ${x.ratio.w ?? "-"} h ${x.ratio.h ?? "-"}${x.ok ? "" : `: ${x.why}`}`);
  console.log(`  ${extentOk ? "ok  " : "FAIL"} extent           ${extent ? `${extent.why} (${extent.view}, zoom ${extent.zoom}, reach ${extent.reach} m)` : "no extent: mark the painted city's ground outline (concept-marks.json extent)"}`);
  for (const m of extent?.masses ?? []) console.log(`       mass ${m.id.padEnd(20)} ${m.area} m2, built covers ${Math.round(m.covered * 100)} %`);
  const faults = [...bad.slice(0, 4).map((x) => `${x.id}: ${x.why}`), ...(extentOk ? [] : [`extent: ${extent?.why ?? "no extent in concept-marks.json: mark the painted city's ground outline (docs/place-builder.md scale)"}`])];
  if (excused.length) console.log(`  EXCEPTED ${excused.join("; ")}`);
  return { ok: !faults.length, detail: faults.length ? faults.join("; ").slice(0, 400) : `${excused.length ? `${excused.length} mark(s) excepted by quality-exceptions.json; ` : ""}${rows.length} marks within ${Math.round(marks.tolerance * 100)} % of the painting (${marks.view}); ${extent!.why}` };
}
/** EXTENT (Red Dial 2026-10-30, owner: "the concept art is correct, it should be that grand ... looks like the ruins of an
 *  old city"): the painted city's ground outline (concept-marks.json `extent`) back-projected through the painting's camera
 *  (zoomed by its anchor: the hero's painted width / its built width) onto the lab ground, against the BUILT DISTRICT (every
 *  layout structure's vertices grown by `reach`). Built area or width more than the tolerance short fails. */
function scaleExtent(marks: ConceptMarks, site: any, want: Set<string>): ExtentReport | null {
  const ext = marks.extent; if (!ext) return null;
  const r = site.renders[ext.view]; if (!r?.camera || !r?.target) fail(`concept-marks.json extent.view ${ext.view} is not a render of the site record (${paintedViews(site).join(", ")})`);
  const cam = { eye: r.camera, target: r.target, vfov: marks.vfov, width: marks.image.width, height: marks.image.height };
  const lf = path.join(JOB, "layout.json"), layout = fs.existsSync(lf) ? read(lf) : null;
  const structs = new Set<string>(layout ? (layout.pieces as any[]).filter((p) => p.kind === "structure").map((p) => `${poi}-core-${p.id}`)
    : (read(path.join(JOB, "ops.json")) as any[]).filter((o) => o.entity?.components?.prefab && (o.entity.tags ?? []).some((t: string) => t.startsWith("slot:") && t !== "slot:fire")).map((o) => o.id));
  const anchorIds = new Set((ext.anchor?.pieces ?? []).map((p) => `${poi}-core-${p}`));
  const geo = sceneGeometry(path.join(PROJECTS, lab, "assets"), read(sceneFile(lab, labWorld)), (id) => !structs.has(id) && !anchorIds.has(id) && !want.has(id));
  let zoom = 1;
  if (ext.anchor) {
    const xyz: number[] = []; for (const g of geo.filter((g) => anchorIds.has(g.id))) for (let i = 0; i < g.world.length; i += 3) xyz.push(g.world[i]!, Math.max(g.world[i + 1]!, g.m[13]!), g.world[i + 2]!);
    const sb = xyz.length ? screenBox(xyz, cam) : null, bw = sb ? sb.box[2] - sb.box[0] : 0;
    if (!(bw > 0)) return { ok: false, why: `anchor ${ext.anchor.pieces.join("+")} is not in the built scene`, view: ext.view, zoom: 0, reach: ext.reach, painted: { outline: [], area: 0, width: 0, depth: 0 }, built: { area: 0, width: 0, depth: 0, cells: 0 }, ratio: { area: 0, width: 0, depth: 0 }, masses: [] };
    zoom = (ext.anchor.box[2] - ext.anchor.box[0]) / bw;
  }
  const xz: number[] = []; for (const g of geo.filter((g) => structs.has(g.id))) for (let i = 0; i < g.world.length; i += 3) xz.push(g.world[i]!, g.world[i + 2]!);
  return compareExtent(ext, cam, zoom, ground(read(worldFile(lab, labWorld))).height, xz, marks.tolerance);
}
/** ROADS (owner rulings 2026-10-20 "no ribbon roads" and 2026-10-30 "ribbons removed from the tools"): the job and the lab
 *  world carry NO ribbon at all (ribbonsDeclared: a `path`/`ribbon` operator, a features.ribbons world-op or a lab
 *  features.ribbons entry; zonegen status `poi <id>` fails on the same rule; no allow-list), and every track it declares
 *  (handoff approachTrack, approachTracks, footpathTracks) is a carved + painted road in the lab world. reports/roads.json. */
function roadsCheck(hand: any): { ok: boolean; detail: string } {
  const labDoc = read(worldFile(lab, labWorld));
  const ribbons = ribbonsDeclared(read(path.join(JOB, "operators.json")), read(path.join(JOB, "world-ops.json")), labDoc.features.ribbons ?? []);
  const t = hand.approachTrack ?? null, labRoads = (labDoc.features.roads ?? []) as any[], built = t ? labRoads.filter((r) => r.id === t.id || r.id.startsWith(`${t.id}.`)) : [];
  // a bridge place declares a track per end (handoff approachTracks): every one carved + painted in the lab
  const more = [...(hand.approachTracks ?? []), ...(hand.footpathTracks ?? [])].filter((x: any) => x.id !== t?.id), moreBuilt = more.map((x) => ({ x, r: labRoads.filter((r) => r.id === x.id || r.id.startsWith(`${x.id}.`)) }));
  const faults = [...ribbons.map((r) => `${r} (migrate: place-build approach, or re-plan: place-build plan)`), ...(t && !built.length ? [`approach track ${t.id} is not in the lab world (build)`] : []), ...built.filter((r) => !r.surface).map((r) => `track ${r.id} is not painted`),
    // L (fowlers-drop 2026-10-21): a track without keepLandforms clears every sea cliff / butte round it (a 120 m headland fell)
    ...built.filter((r) => !r.keepLandforms).map((r) => `track ${r.id} has no keepLandforms: it clears the sea cliffs and buttes round it (re-plan: place-build plan)`),
    ...moreBuilt.flatMap(({ x, r }) => (r.length ? r.filter((q) => !q.surface).map((q) => `track ${q.id} is not painted`) : [`track ${x.id} is not in the lab world (build)`]))];
  write(path.join(JOB, "reports", "roads.json"), { ok: !faults.length, faults, ribbons, track: t, built: built.map((r) => ({ id: r.id, width: r.width, points: r.points.length, surface: r.surface })) });
  return { ok: !faults.length, detail: faults.join("; ") || (t ? `approach track ${t.id}: ${t.width} m carved + painted, ${t.lengthM} m from ${t.from}; ${more.length} more track(s); no ribbon` : `no ribbon (no approach track: pinpoint or no walkable leg; ${more.length} other track(s))`) };
}
/** SEATED (signal-tower 2026-10-21, owner: "the ruins are floating"; float passed it on ONE contact within 0.05 m): every
 *  structure of the place (not a fire or a boat) is measured along its whole BASE OUTLINE on the lab's built ground: the
 *  most daylight between its base and the ground (or its skirt's top, along the skirt) must be <= SEAT_GAP_M.
 *  reports/seated.json. */
/** The placement solver's foundation (entity `<piece>--foundation`, a surface box under the piece) as the seated gate's
 *  skirt: its plan corners and its top, world frame. */
/** A foundation box's BOTTOM outline (world plan corners) and bottom y: what the seated gate measures it by. */
function foundationBottom(e: any, root: number[]): { poly: V2[]; y: number } | undefined {
  const pos = e?.components?.mesh?.source?.positions as number[] | undefined, sk = foundationSkirt(e, root);
  if (!pos?.length || !sk) return undefined;
  let y0 = Infinity; for (let i = 1; i < pos.length; i += 3) y0 = Math.min(y0, pos[i]!);
  return { poly: sk.points.slice(0, 4), y: root[1]! + e.components.transform.position[1] + y0 };
}
function foundationSkirt(e: any, root: number[]): { id: string; points: V2[]; topY: number; thickness: number; solid: boolean } | undefined {
  const pos = e?.components?.mesh?.source?.positions as number[] | undefined, t = e?.components?.transform;
  if (!pos?.length || !t) return undefined;
  const q = t.rotation ?? [0, 0, 0, 1], yaw = 2 * Math.atan2(q[1], q[3]), c = Math.cos(yaw), sn = Math.sin(yaw);
  let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity, y1 = -Infinity;
  for (let i = 0; i < pos.length; i += 3) { x0 = Math.min(x0, pos[i]!); x1 = Math.max(x1, pos[i]!); y1 = Math.max(y1, pos[i + 1]!); z0 = Math.min(z0, pos[i + 2]!); z1 = Math.max(z1, pos[i + 2]!); }
  const w = (x: number, z: number): V2 => [root[0]! + t.position[0] + x * c + z * sn, root[2]! + t.position[2] - x * sn + z * c];
  return { id: e.name ?? "foundation", points: [w(x0, z0), w(x1, z0), w(x1, z1), w(x0, z1), w(x0, z0)], topY: root[1]! + t.position[1] + y1, thickness: 0.4, solid: true };
}
/** A SOLVER piece meets the ground at its catalogue footing (a WFC house's foundation storey, 3.2 m under the floor: the
 *  solver lets the fall run down it before it adds a skirt), so the seated gate measures its base that far down, past the
 *  0.3 m floor band the outline is cut at. Other pieces: 0. */
function solverFooting(entity: any, prefab: string, base?: BaseOutline | null): number {
  const info = prefabInfo(project, prefab), k = entity?.components?.transform?.scale?.[0] ?? 1;
  return measuredFooting(entity?.tags ?? [], (info?.footing ?? 0) * k, base?.perimeter.length ? Math.min(...base.perimeter.map((q) => q[2])) * k : null);
}
/** A piece hung on a wall or a ceiling (catalogue `dressing.mount`: a banner on a pillar's face) is not seated on the ground. */
function hungOf(prefab: string): string | null {
  const f = findAsset(project, `prefabs/${prefab}.json`); if (!f) return null;
  try { const m = Object.values(read(f).entities ?? {}).map((e: any) => e?.components?.dressing?.mount).find(Boolean); return m === "wall" || m === "ceiling" ? m : null; } catch { return null; }
}
/** ABUT (o-gates 2026-10-30, Derek on the Moon: "the wall for the actual doorway doesn't connect with the 2 tower pillars"):
 *  every layout piece's `abuts` pair, in the lab scene's world pose, sliced by height (abutGap): daylight over ABUT_GAP_M
 *  anywhere fails. reports/abut.json. */
function abutCheck(): { ok: boolean; detail: string } {
  const lf = path.join(JOB, "layout.json"); if (!fs.existsSync(lf)) return { ok: true, detail: "no layout: nothing declared to abut" };
  const pairs = ((read(lf).pieces ?? []) as { id: string; abuts?: string[] }[]).flatMap((q) => (q.abuts ?? []).map((b) => [q.id, b] as [string, string]));
  if (!pairs.length) return { ok: true, detail: "no piece declares abuts" };
  const E = read(sceneFile(lab, labWorld)).entities as Record<string, any>, root = E[`poi-${poi}`]?.components?.transform?.position ?? [0, 0, 0];
  const ops = (read(path.join(JOB, "ops.json")) as any[]).filter((o) => o.entity?.components?.prefab);
  const world = (id: string) => { const o = ops.find((x) => x.id.endsWith(`-${id}`)), e = o && E[o.id]; if (!e) return null;
    const t = e.components.transform, q = t.rotation ?? [0, 0, 0, 1], k = t.scale?.[0] ?? 1, yaw = 2 * Math.atan2(q[1], q[3]), c = Math.cos(yaw), s = Math.sin(yaw);
    const tr = (v: number[]) => [root[0] + t.position[0] + k * (v[0]! * c + v[2]! * s), root[1] + t.position[1] + k * v[1]!, root[2] + t.position[2] + k * (-v[0]! * s + v[2]! * c)];
    return prefabGeometry(path.join(PROJECTS, project, "assets"), o.entity.components.prefab.prefabId).tris.map((x: any) => ({ a: tr(x.a), b: tr(x.b), c: tr(x.c) })); };
  const rows = pairs.map(([a, b]) => { const A = world(a), B = world(b); if (!A || !B) return { a, b, fault: `${!A ? a : b} is not in the lab scene` };
    const g = abutGap(A, B); return { a, b, gap: +g.gap.toFixed(3), at: +g.at.toFixed(2), slices: g.slices, ok: g.slices > 0 && g.gap <= ABUT_GAP_M }; });
  const bad = rows.filter((r: any) => r.fault || !r.ok);
  write(path.join(JOB, "reports", "abut.json"), { ok: !bad.length, tolerance: ABUT_GAP_M, rows });
  return { ok: !bad.length, detail: bad.length ? bad.slice(0, 3).map((r: any) => r.fault ?? (r.slices ? `${r.a} | ${r.b}: ${r.gap} m of daylight at y ${r.at}` : `${r.a} | ${r.b}: no shared height or depth (not side by side)`)).join("; ") : `${rows.length} pair(s) flush (worst ${Math.max(...rows.map((r: any) => r.gap)).toFixed(2)} m <= ${ABUT_GAP_M})` };
}
function seatedCheck(): { ok: boolean; detail: string } {
  // the lab ground with its HOLES (cave mouths): the WALKED ground (tools/_ground.mts), the one every placer reads
  const labR = worldRecipeSchema.parse(read(worldFile(lab, labWorld))), hf = createWorldField(labR), g = { height: walkGround(hf) }, scene = read(sceneFile(lab, labWorld)), E = scene.entities as Record<string, any>;
  // L (t-ground 2026-10-31): the place's wall operators are the job's operators.json AND the world's own pb-<poi>- walls
  // (Red Dial's operators.json listed 1 of its 16 installed skirts: the other pieces were measured without their skirt)
  // L (t-ground 2026-10-31): --live judges what is INSTALLED: the live scene's entities of the place (poi:<id>), with their
  // live tags, and the live world's walls. The job's ops.json may be a newer lab build (Red Dial: 157 of 227 ops differed
  // from the live scene, 68 foundations were never installed), so its pieces are not the live place's pieces
  const ops = LIVE ? Object.entries(E).filter(([id, e]) => id !== `poi-${poi}` && (e.tags ?? []).includes(`poi:${poi}`)).map(([id, e]) => ({ id, entity: e })) : read(path.join(JOB, "ops.json")) as any[];
  const jobWalls = LIVE ? [] : (read(path.join(JOB, "operators.json")) as any[]).filter((o) => o.op === "wall");
  const walls = [...jobWalls, ...((labR.features.operators ?? []) as any[]).filter((o) => o.op === "wall" && String(o.id).startsWith(PREFIX) && !jobWalls.some((w) => w.id === o.id))];
  const root = E[`poi-${poi}`]?.components?.transform?.position ?? [0, 0, 0], rows: any[] = [];
  for (const o of ops) {
    const slot = (o.entity?.tags ?? []).find((t: string) => t.startsWith("slot:"))?.slice(5), prefab = o.entity?.components?.prefab?.prefabId;
    if (!prefab) continue; // not a placed prefab: a foundation box is judged below, the root and water are no piece
    // L (t-ground 2026-10-31, NO SILENT SKIPS): every placed prefab is a row: measured here, or EXCLUDED naming the gate that
    // judges it instead (counted in the report), or a FAULT when it cannot be measured
    const ex = (o.entity?.tags ?? []).includes("dressing") ? "a dressing prop (float judges it)" : seatedExclusion(o.entity?.tags ?? [], hungOf(prefab)); if (ex) { rows.push({ id: o.id, prefab, slot, excluded: ex }); continue; }
    const e = E[o.id]; if (!e) { rows.push({ id: o.id, prefab, fault: "not in the lab scene" }); continue; }
    // L (r-found 2026-10-30): a banner hung on a pillar's face was charged "no base outline" (its rig has no triangles): a
    // wall- or ceiling-mounted piece is recorded (seatedExclusion), never measured on the ground
    const b0 = structureBase(prefab); if (!b0) { rows.push({ id: o.id, prefab, gap: null, fault: "no base outline (no triangles): not measured, so not passed" }); continue; } // L (o-gates 2026-10-30): a silent note let floating ruins through
    // L (KNUCKLECROWN 2026-10-29): a LEANED piece (layout `lean`) is measured on its outline turned in 3D, never by its yaw alone
    const t = e.components.transform, q = t.rotation ?? [0, 0, 0, 1], leaned = isLeaned(q), base = leaned ? orientBase(scaleBase(b0, t.scale?.[0] ?? 1), q) : scaleBase(b0, t.scale?.[0] ?? 1), yawR = leaned ? 0 : 2 * Math.atan2(q[1], q[3]), at: V2 = [root[0] + t.position[0], root[2] + t.position[2]], lift = Number((o.entity?.tags ?? []).find((t: string) => t.startsWith("lift:"))?.slice(5) ?? 0) || 0, y = root[1] + t.position[1] - lift - solverFooting(o.entity, prefab, b0); // a lifted piece (layout `lift`) is seated at its footing, `lift` below its base plane
    const sk = walls.find((w) => w.id === `pb-${poi}-skirt-${o.id.slice(poi.length + 1)}`) ?? foundationSkirt(E[`${o.id}--foundation`], root);
    // a piece on a layout cave's floor (tag cave:<id>) is measured on the floor under its own height, never the cliff top over the hall
    const caveFloor = (o.entity?.tags ?? []).some((t: string) => t.startsWith("cave:")) ? walkGroundFrom(hf, y + 1) : null;
    const m = seatGap(base, at, y, yawR, (x, z) => (caveFloor ?? g.height)(x, z), sk ? { hull: sk.points, top: sk.topY, reach: sk.thickness / 2 + 0.3, solid: !!(sk as { solid?: boolean }).solid } : null);
    rows.push({ id: o.id, prefab, gap: m.gap, at: m.at, skirt: sk?.id ?? null, ok: m.gap <= SEAT_GAP_M });
  }
  // L (t-ground 2026-10-31): the pieces no prefab carries were never judged. A placement-solver FOUNDATION box (its bottom
  // outline on the walked ground) and every WALL OPERATOR of the place (pillars, wall stumps, pens, dykes, skirts: the
  // baked wall's bottom per segment, _wall-seated) are measured here too
  for (const o of ops) {
    if (!String(o.id).endsWith("--foundation")) continue;
    const fb = foundationBottom(E[o.id], root);
    if (!fb) { rows.push({ id: o.id, prefab: "foundation", fault: E[o.id] ? "foundation without mesh positions: not measured, so not passed" : "not in the lab scene" }); continue; }
    const m = baseGap(fb, (x, z) => g.height(x, z)); rows.push({ id: o.id, prefab: "foundation", gap: m.gap, at: m.at, ok: m.gap <= SEAT_GAP_M });
  }
  for (const w of walls) {
    if (w.variant === "ramp") { rows.push({ id: w.id, prefab: "wall operator (ramp)", excluded: "a ramp is a deck over its own cut (float judges what stands on it)" }); continue; }
    try { const r = wallSeat(labR, w.id, { maxGap: SEAT_GAP_M, ground: (x, z) => g.height(x, z) });
      rows.push({ id: w.id, prefab: "wall operator", gap: r.worst, at: r.worstAt, ok: r.ok, ...(r.ok ? {} : { fault: r.stale ?? (r.samples ? `${r.bad} segment(s) show daylight, worst ${r.worst} m at ${r.worstAt}` : "no samples: not measured, so not passed") }) });
    } catch (err) { rows.push({ id: w.id, prefab: "wall operator", fault: `cannot be measured: ${(err as Error).message}` }); }
  }
  // a bridge's bases (pier footings, imposts, the tower, abutments, the band beyond the end arches): daylight along each outline
  const bf = path.join(JOB, "reports", "bridge.json");
  if (fs.existsSync(bf)) for (const b of (read(bf).bases ?? []) as any[]) { const m = baseGap(b, (x, z) => g.height(x, z)); rows.push({ id: b.name, prefab: `bridge ${b.why}`, gap: m.gap, at: m.at, buried: m.buried, ok: m.gap <= SEAT_GAP_M }); }
  const bad = rows.filter((r) => r.fault || r.ok === false), counts = seatedCounts(rows);
  write(path.join(JOB, "reports", "seated.json"), { ok: !bad.length, tolerance: SEAT_GAP_M, counts, rows });
  return { ok: !bad.length, detail: `judged ${counts.judged} of ${counts.pieces} piece(s) (${counts.excluded} excluded to float); ` + (bad.length ? `${bad.length} fault(s): ` + bad.slice(0, 3).map((r) => r.fault ? `${r.id}: ${r.fault}` : `${r.id} (${r.prefab}) stands ${r.gap} m clear at ${r.at}`).join("; ") : `${counts.judged} structure(s) seated (max gap ${Math.max(0, ...rows.map((r) => r.gap ?? 0)).toFixed(2)} m <= ${SEAT_GAP_M})`) };
}
/** The layout's pieces placed in the lab scene, by layout id (an op's `slot:<id>` tag), with their world position. */
function layoutEntities() {
  const lf = path.join(JOB, "layout.json"), pieces = fs.existsSync(lf) ? ((read(lf).pieces ?? []) as any[]) : [];
  const scene = read(sceneFile(lab, labWorld)), E = scene.entities as Record<string, any>, ops = read(path.join(JOB, "ops.json")) as any[];
  const root = E[`poi-${poi}`]?.components?.transform?.position ?? [0, 0, 0];
  // a layout piece's op is `<poi>-<pocket>-<piece id>` (its `slot:` tag holds the ROLE, not the id)
  const pieceOp = (id: string) => ops.find((o) => o.entity?.components?.prefab && typeof o.id === "string" && o.id.startsWith(`${poi}-`) && o.id.endsWith(`-${id}`) && /^[a-z0-9]+$/.test(o.id.slice(poi.length + 1, o.id.length - id.length - 1)));
  return { pieces, find: (id: string) => { const o = pieceOp(id); const e = o ? E[o.id] : null; const t = e?.components?.transform;
    return { op: o ?? null, entity: e ?? null, pos: t ? [root[0] + t.position[0], root[1] + t.position[1], root[2] + t.position[2]] as [number, number, number] : null, yaw: t ? 2 * Math.atan2((t.rotation ?? [0, 0, 0, 1])[1], (t.rotation ?? [0, 0, 0, 1])[3]) : 0, scale: t?.scale?.[0] ?? 1 }; } };
}
/** L (coordinator 2026-10-31, Dark Lamp: a box tower and five graves passed every gate): every brief feature and the set
 *  piece is BUILT by a layout piece that declares it (`feature: i | "setPiece"`; featureCoverage). reports/features.json. */
function featureCheck(): { ok: boolean; detail: string } {
  const bf = path.join(JOB, "brief.json"), place = fs.existsSync(bf) ? read(bf).place ?? {} : {}, L = layoutEntities();
  // L (o-wild4 2026-11-03, Widows' Cairn): a layout piece that is a QUEST object (`quest: <id>`) is delivered by the job's
  // dressing plan under its quest id, never as a layout op: it is built when a plan item carries that quest entity
  const dd = path.join(JOB, "dressing"), questIds = new Set(fs.existsSync(dd) ? fs.readdirSync(dd).filter((f) => f.endsWith(".json")).flatMap((f) => ((read(path.join(dd, f)).items ?? []) as any[]).flatMap((it) => (it.quest?.entity ? [it.quest.entity as string] : []))) : []);
  const questOf = new Map((L.pieces as any[]).filter((p) => typeof p.quest === "string").map((p) => [p.id as string, p.quest as string]));
  const res = featureCoverage({ features: place.features ?? [], setPiece: place.setPiece ?? null }, L.pieces, (id) => !!L.find(id).op || (questOf.has(id) && questIds.has(questOf.get(id)!)));
  write(path.join(JOB, "reports", "features.json"), res);
  return { ok: res.ok, detail: res.detail };
}
/** L (Derek 2026-10-31, careening-strand: "I don't see the boat"): a declared HERO piece (role landmark / set-piece,
 *  or a `landmark` block) that the build dropped, that is missing from the lab scene, or that stands mostly under the
 *  ground or the water fails loudly, by name. Visible = at least HERO_SHOWN of its height above max(ground, sea). */
const HERO_SHOWN = 0.5;
function heroCheck(): { ok: boolean; detail: string } {
  const g = ground(read(worldFile(lab, labWorld))), sea = Number(read(worldFile(lab, labWorld)).seaLevel ?? 0), L = layoutEntities(), rows: any[] = [];
  for (const p of L.pieces) {
    if (!(["landmark", "set-piece"].includes(p.role) || p.landmark)) continue; // a beached dinghy (role boat) is no hero; a ship that carries the read has its landmark block
    const f = L.find(p.id), h = (propInfo(p.prefab)?.size?.[1] ?? 0) * f.scale;
    // L (coordinator 2026-10-31, Dark Lamp: the small-brick sun-ruins watch towers read as plain boxes): a prefab whose root
    // carries the tag `not-landmark` is never a place's hero
    const pf = findAsset(project, `prefabs/${p.prefab}.json`), ptags: string[] = pf ? (() => { const j = read(pf); return (j.entities?.[j.root]?.tags ?? []) as string[]; })() : [];
    if (ptags.includes("not-landmark")) { rows.push({ id: p.id, prefab: p.prefab, fault: "its prefab is tagged not-landmark (frequency: rare): no place uses it as a hero; pick another landmark" }); continue; }
    if (!f.op) { rows.push({ id: p.id, prefab: p.prefab, fault: "declared in layout.json but DROPPED from the build (no op): see the plan's FIT/NOTE lines" }); continue; }
    if (!f.entity || !f.pos) { rows.push({ id: p.id, prefab: p.prefab, fault: "has an op but is not in the lab scene" }); continue; }
    const floor = Math.max(g.height(f.pos[0], f.pos[2]), sea), shown = h > 0 ? (f.pos[1] + h - floor) / h : 1;
    rows.push({ id: p.id, prefab: p.prefab, at: f.pos.map((v) => +v.toFixed(2)), height: +h.toFixed(2), shown: +shown.toFixed(2), ok: shown >= HERO_SHOWN, ...(shown < HERO_SHOWN ? { fault: `only ${Math.round(Math.max(0, shown) * 100)}% of its ${h.toFixed(1)} m stands above the ${floor === sea ? "water" : "ground"} (need ${HERO_SHOWN * 100}%)` } : {}) });
  }
  const bad = rows.filter((r) => r.fault);
  write(path.join(JOB, "reports", "heroes.json"), { ok: !bad.length, shown: HERO_SHOWN, rows });
  return { ok: !bad.length, detail: bad.length ? bad.slice(0, 3).map((r) => `${r.id} (${r.prefab}): ${r.fault}`).join("; ") : `${rows.length} hero piece(s) built and in view (>= ${HERO_SHOWN * 100}% above ground/water)` };
}
/** L (Derek 2026-10-31, careening-strand: "the lean-to is floating and needs to be on some flat ground"): a shelter (a
 *  catalogue `shelter`: tent, lean-to) stands on LEVEL ground: the built ground under its footprint (corners, edge
 *  midpoints, centre) may vary by at most SHELTER_LEVEL_M. Put the camp on a flat, or give it a level shelf. */
function shelterCheck(): { ok: boolean; detail: string } {
  const g = ground(read(worldFile(lab, labWorld))), L = layoutEntities(), rows: any[] = [];
  for (const p of L.pieces) {
    const info = propInfo(p.prefab); if (!info?.shelter || !info.size) continue;
    const f = L.find(p.id); if (!f.pos) { rows.push({ id: p.id, prefab: p.prefab, fault: "not in the lab scene" }); continue; }
    const hx = (info.size[0]! * f.scale) / 2, hz = (info.size[2]! * f.scale) / 2, c = Math.cos(f.yaw), s = Math.sin(f.yaw), hs: number[] = [];
    for (const [u, v] of [[-1, -1], [1, -1], [1, 1], [-1, 1], [0, -1], [1, 0], [0, 1], [-1, 0], [0, 0]]) { const lx = u! * hx, lz = v! * hz; hs.push(g.height(f.pos[0] + lx * c + lz * s, f.pos[2] - lx * s + lz * c)); }
    const relief = Math.max(...hs) - Math.min(...hs), gap = f.pos[1] - Math.min(...hs);
    rows.push({ id: p.id, prefab: p.prefab, at: f.pos.map((v) => +v.toFixed(2)), relief: +relief.toFixed(2), ok: relief <= SHELTER_LEVEL_M, ...(relief > SHELTER_LEVEL_M ? { fault: `stands on ${relief.toFixed(2)} m of fall under its footprint (base ${gap.toFixed(2)} m over the lowest ground; level <= ${SHELTER_LEVEL_M} m): move it onto a flat or give it a level shelf` } : {}) });
  }
  const bad = rows.filter((r) => r.fault);
  write(path.join(JOB, "reports", "shelters.json"), { ok: !bad.length, tolerance: SHELTER_LEVEL_M, rows });
  return { ok: !bad.length, detail: bad.length ? bad.slice(0, 3).map((r) => `${r.id} (${r.prefab}) ${r.fault}`).join("; ") : rows.length ? `${rows.length} shelter(s) on level ground (<= ${SHELTER_LEVEL_M} m)` : "no shelter in the layout" };
}
/** L (coordinator 2026-10-31, Derek on the Drinking Stone: tents not facing the fire, bedrolls / jars / the weapon rack in the
 *  open): the camp rules on EVERY layout piece as built (campRuleFaults), so a hand-yawed tent or a loose bedroll cannot
 *  bypass campLayout. reports/camp.json. */
function campCheck(): { ok: boolean; detail: string } {
  const L = layoutEntities();
  const built = L.pieces.flatMap((p: any) => { const f = L.find(p.id); return f.pos ? [{ id: p.id, prefab: p.prefab, at: [f.pos[0], f.pos[2]] as [number, number], yaw: f.yaw, ...(p.inOpen ? { inOpen: p.inOpen } : {}), ...(p.kind === "fire" ? { centre: true } : {}) }] : []; });
  const res = campRuleFaults(built, (id) => propInfo(id)), n = res.rows.length;
  write(path.join(JOB, "reports", "camp.json"), { ok: !res.faults.length, at: new Date().toISOString(), rows: res.rows });
  return { ok: !res.faults.length, detail: res.faults.length ? `${res.faults.length} of ${n}: ${res.faults.slice(0, 4).join("; ")}` : n ? `${n} camp row(s): shelters face the fire, gear under cover` : "no camp (no shelter, or no fire near one)" };
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
  const apl = res ? approachLines(recipe, read(path.join(ZONE, "reservations.json")).reservations ?? [], res) : null, lines = apl?.lines ?? [], lineName = (l: number) => apl?.names[l] ?? `line ${l}`;
  const band = readBand(hand.measurements?.adventureSize, hand.read?.band); out.band = band;
  if (!lm) faults.push("no landmark");
  else { // L: judged along the approach the place's own footpath joins (the plan's approach); every other line is reported, not charged
    // a reservation approach marked `read: false` (with its dated `readNote`) is another place's road that passes by: it
    // is reported, never charged (L o-gates 2026-10-30: road-moon, the Moon's road round the lake, as a Weeping Sun approach)
    const noRead = new Set([res?.approach, ...((res?.approaches ?? []) as any[])].filter((q: any) => q && q.read === false && typeof q.readNote === "string").map((q: any) => q.from));
    const charged = lines.map((_, i) => i).filter((i) => !noRead.has(lineName(i)));
    // the plan's own approach line counts unless it is ruled read: false (then the charged lines do)
    // L (o-coast2 sunwine-hold 2026-10-31): a place reached BY a lift (layout `arrival.by` lift:<id>) is judged on the line its
    // lift's TOP joins (where the player comes from), never the line nearest the core (a passing leg on the far cliff with no
    // standable spot in the band); without a lift plan yet, the plan's line as before
    const lay = fs.existsSync(path.join(JOB, "layout.json")) ? read(path.join(JOB, "layout.json")) : null, liftId = /^lift:(.+)$/.exec(lay?.arrival?.by ?? "")?.[1];
    const liftPlan = liftId && fs.existsSync(path.join(JOB, "lifts", `${liftId}.plan.json`)) ? read(path.join(JOB, "lifts", `${liftId}.plan.json`)) : null;
    const liftLine = liftPlan ? nearestOnApproach(liftPlan.spec.top as V2, lines)?.line : undefined;
    const need = typeof liftLine === "number" ? [liftLine] : typeof hand.read?.approachLine === "number" && !noRead.has(lineName(hand.read.approachLine)) ? [hand.read.approachLine] : noRead.size ? charged : undefined;
    out.read = approachReadAny(g, [{ at: lm.at, top: lm.top, fogReach: lm.fogReach, foot: lm.foot }, ...((hand.smoke ?? []) as any[]).map((q) => ({ ...q, foot: g.height(q.at[0], q.at[1]) }))], lines, band, need);
    // rows name their road (a line index alone hid which road failed and shifted when a leg was renumbered)
    out.read.rows = out.read.rows.map((r: any) => ({ road: lineName(r.line), ...r }));
    if (!out.read.ok) faults.push(`approach read: ${out.read.note || `approach line(s) ${out.read.unread.map((l: number) => `${l} (${lineName(l)})`).join(", ")} never show the landmark ${READ_PX_MIN} px tall at ${band[0]}-${band[1]} m (${hand.measurements?.adventureSize ?? "medium"} tier; best ${out.read.rows.map((r: any) => `${r.road}: ${r.reason ?? `${r.px ?? "-"} px @ ${r.distance} m`}`).join(", ")})`}`); }
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
  // the PICTURES are a shot row (Derek 2026-10-31, batch-renders-after-install): taken by the batch render of the live world
  // after the install (place-build render-batch -> evidence/live/<batch>/), never asked for here. Reported: the batch's
  // frames when current for the ops, else a lab shots run newer than the ops, else deferred. Never a fault.
  const ev = shotEvidence(JOB, path.join(JOB, "evidence", `${labWorld}.json`));
  out.evidence = ev.kind === "batch" ? { from: `batch ${ev.rec.batch}`, shots: (ev.rec.shots ?? []).length, fresh: true }
    : ev.kind === "lab" ? { from: "lab shots", shots: ((read(ev.file).shots ?? []) as unknown[]).length, fresh: true }
    : { from: null, shots: 0, fresh: false, deferred: `no current pictures (${ev.why}): the batch render takes them after the install` };
  if (evidencePending) out.evidence.pending = true; // judged after the shots (all --shots)
  // L (o-smalls 2026-10-30): a dated coordinator ruling in <job>/quality-exceptions.json (gates ["place"], fault = the
  // fault's opening words) excuses that fault here, as art-check does for art; it is reported, never silently dropped
  const qx = path.join(JOB, "quality-exceptions.json"), rulings = fs.existsSync(qx) ? ((read(qx).exceptions ?? []) as any[]).filter((e) => (e.gates ?? []).includes("place") && e.ruling && e.fault) : [];
  const key = (t: string) => t.replace(/approach line\(s\) \d+ \(/, "").replace(/[^a-z0-9]+/gi, " ").trim().toLowerCase();
  const excused = faults.filter((t) => rulings.some((e) => key(t).startsWith(key(e.fault).slice(0, 30))));
  for (const t of excused) faults.splice(faults.indexOf(t), 1);
  out.excused = excused;
  write(path.join(JOB, "reports", "place.json"), { ok: !faults.length, faults, ...out });
  return { ok: !faults.length, detail: faults.join("; ") || (excused.length ? `${excused.length} fault(s) excused by quality-exceptions.json; ` : "") + `reads along the approach (lines read ${out.read?.rows.filter((r: any) => r.reads).length}/${out.read?.rows.length}); clean` };
}

/** `shots --views <ids> --merge` (r-found 2026-10-31, coordinator ruling): re-shoot ONLY those views (default
 *  --spot-timeout 600) into a scratch folder and fold them into the existing evidence run: their frames overwrite the old
 *  ones in place, their records replace that view's records (tools/_shots-merge.mts), and the wash verdict is judged
 *  again over the merged set. The far / aerial views of a big place stall on a busy machine, a different set each run. */
async function shotsMerge(port: string) {
  ensureIsoViews();
  const views = (opt("views") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const all = read(path.join(JOB, "views.json")) as { name: string }[], runFile = path.join(JOB, "evidence", `${labWorld}.json`);
  const unknown = views.filter((v) => !all.some((x) => x.name === v));
  if (!views.length || unknown.length) fail(`shots --merge: --views <ids> from views.json (${unknown.length ? `not views: ${unknown.join(", ")}` : "none given"})`);
  if (!fs.existsSync(runFile)) fail(`shots --merge: no evidence run ${path.relative(JOB, runFile)} to merge into (run shots first)`);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), `pb-shots-${poi}-`)), spots = path.join(tmp, "views.json");
  try {
    fs.writeFileSync(spots, JSON.stringify(all.filter((x) => views.includes(x.name)), null, 1));
    const out = path.join(tmp, "out"), timeout = opt("spot-timeout") ?? "600";
    const r = await toolTimed("shots", opt("shots-timeout") ? +opt("shots-timeout")! * 60_000 : Math.max(shotsCapMs(views.length), views.length * 2 * (+timeout + 30) * 1000), ["tools/light-shots.mts", "--scene", labWorld, "--spots", spots, "--times", "12,20", "--no-refs", "--wash", "--weather-settle", "4", "--out", out, "--port", port, ...urlArg(), "--spot-timeout", timeout]);
    const addFile = path.join(out, `${labWorld}.json`);
    if (r.status || !fs.existsSync(addFile)) { console.log(`shots --merge FAILED: ${r.timedOut ? `TIMEOUT after ${r.s} s` : `exit ${r.status}`} (reports/shots.log); the evidence run is unchanged`); process.exitCode = 1; return; }
    // the frames (and their layer frames) overwrite the old ones in place
    const src = path.join(out, labWorld), dst = path.join(JOB, "evidence", labWorld);
    fs.mkdirSync(dst, { recursive: true });
    for (const f of fs.existsSync(src) ? fs.readdirSync(src) : []) fs.copyFileSync(path.join(src, f), path.join(dst, f));
    const merged = mergeShotRuns(read(runFile), read(addFile), views);
    write(runFile, merged);
    // the wash verdict over the MERGED frames (never the partial run's, never the stale one)
    const { frames, wantFireRead } = await judgeRun(runFile);
    write(runFile, { ...merged, washVerdict: washRun(frames, wantFireRead) });
    const got = merged.merged.at(-1)!.got, still = missingViews(all.map((x) => x.name), merged);
    write(path.join(JOB, "reports", "shots.json"), { ok: true, at: new Date().toISOString(), seconds: r.s, merged: { views, got }, log: "reports/shots.log" });
    console.log(`shots --merge: ${got.length}/${views.length} view(s) re-shot and merged (${got.join(", ") || "none"}) in ${r.s}s${still.length ? `; still missing: ${still.join(", ")}` : "; every view in the run"}`);
    recordReadShot();
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
}

/** ISO OVERVIEWS (Derek 2026-10-31: "an isometric view may help the most"): iso-ne and iso-sw (tools/_iso-views.mts), high
 *  narrow-FOV cameras on opposite diagonals framed to the job's footprint + 15 m, noon only, review-only (never judged by
 *  wash / far fires / missing views), refreshed and put FIRST in views.json by plan and by every shots run, so the place
 *  sheet opens on them; an older job gains them on its next shots (or `shots --views iso-ne,iso-sw --merge`). */
function ensureIsoViews() {
  const f = path.join(JOB, "views.json"); if (!fs.existsSync(f)) return;
  const r = withIsoViews(read(f), jobIsoViews(JOB)); if (r.changed) write(f, r.views);
}

/** `--url http://localhost:<p>`: shoot through a RUNNING dev app (the orchestrator's own server on the owner's port)
 *  instead of starting a vite on --port (light-shots --url). L (r-go-farms 2026-11-11: r-go's dev server held :5394, the
 *  only render port its owners may use, and every shots run stopped on "port already in use"). */
function urlArg(): string[] { return opt("url") ? ["--url", opt("url")!] : []; }
async function shots() {
  const port = opt("port") ?? "5291";
  if (has("merge")) return shotsMerge(port);
  ensureIsoViews();
  if (opt("views")) fail("shots --views needs --merge (a partial run never replaces the whole evidence run)");
  // the views are the plan's: a view renamed by a later plan (read-1-152m -> read-1-142m) leaves no old picture behind
  fs.rmSync(path.join(JOB, "evidence", labWorld), { recursive: true, force: true });
  for (const f of ["boot", "play"]) fs.rmSync(path.join(JOB, "evidence", `${labWorld}-${f}-failed.png`), { force: true }); // a past failure's picture
  // L (shots, 2026-10-20 runs: a shot run hung ~60 min holding the heavy slot): a hard wall-clock cap, the whole process
  // tree (vite, the browser) killed on expiry and the stage FAILED with the reason; --shots-timeout <min> (default
  // max(15, spots x 2 x 50 s): the cap grows with the views, shotsCapMs); one stalled spot is skipped after 90 s (light-shots --spot-timeout)
  const nViews = (() => { try { return (read(path.join(JOB, "views.json")) as unknown[]).length; } catch { return 0; } })();
  const r = await toolTimed("shots", opt("shots-timeout") ? +opt("shots-timeout")! * 60_000 : shotsCapMs(nViews), ["tools/light-shots.mts", "--scene", labWorld, "--spots", path.join(JOB, "views.json"), "--times", "12,20", "--no-refs", "--wash", "--weather-settle", "4", "--out", path.join(JOB, "evidence"), "--port", port, ...urlArg(), ...(opt("spot-timeout") ? ["--spot-timeout", opt("spot-timeout")!] : [])]); // --spot-timeout <s>: far read spots stream a lot of world (Wristgate 2026-10-28: 90 s timed out every trail view)
  const errLine = r.out.split("\n").map((l) => l.trim()).filter((l) => /^(\w*Error|STOP):/.test(l)).slice(-1).join(" | ");
  const reason = r.timedOut ? `TIMEOUT after ${r.s} s (--shots-timeout <min>; the run and its vite/browser killed)` : r.status ? (errLine || r.out.trim().split("\n").slice(-1)[0] || `exit ${r.status}`).slice(0, 300) : "";
  write(path.join(JOB, "reports", "shots.json"), { ok: !r.status, at: new Date().toISOString(), seconds: r.s, reason, log: "reports/shots.log" });
  console.log(r.status ? `shots FAILED: ${reason} (reports/shots.log)` : `shots: ${path.join(JOB, "evidence", `${labWorld}-sheet.png`)} (${r.s}s)`);
  if (r.status) process.exitCode = 1; else recordReadShot();
}
/** job.mjs stageBlock: past blockout needs progress.json evidence.readShot { file, viewpoint } (the place's defining read
 *  from a declared viewpoint at a readable hour): the approach read shot at noon, the plan's view names declared. */
function recordReadShot(job = JOB, id = poi, dir = path.join(JOB, "evidence", labWorld)) {
  const views = (read(path.join(job, "views.json")) as any[]).map((v) => v.name as string);
  // a bridge job's views are its contract cameras (no read-*/core-front): the first declared one with a picture
  // L (Wristgate 2026-10-28): a scene with no day-night clock shoots one `-interior` column (light-shots: no time axis);
  // the noon picture is then that one, never "no picture" (the stage could not leave blockout on a lab without a clock)
  const shotOf = (v: string) => [`${v}-12.png`, `${v}-interior.png`].find((f) => fs.existsSync(path.join(dir, f)));
  const pick = [...views.filter((v) => v.startsWith("read-")), "core-close", "core-front", ...views].find((v) => shotOf(v));
  if (!pick) { console.log(`readShot: no read or core-front picture in ${dir} (run shots)`); return null; }
  const pf = path.join(job, "progress.json"), prog = fs.existsSync(pf) ? read(pf) : { version: 1, poiId: id, ownerAgentId: "place-build", stage: "blockout", mode: "build" };
  prog.viewpoints = [...new Set([...(prog.viewpoints ?? []).filter((v: any) => typeof v === "string"), ...views])];
  prog.evidence = { ...(prog.evidence ?? {}), readShot: { file: path.relative(job, path.join(dir, shotOf(pick)!)).split(path.sep).join("/"), viewpoint: pick } };
  write(pf, prog); console.log(`readShot: ${prog.evidence.readShot.file} (${pick}) -> progress.json`);
  return prog.evidence.readShot as { file: string; viewpoint: string };
}

/** Every entity's world position (parent chain: position, quaternion [x,y,z,w] rotation, scale). */
function worldPositions(doc: any): Map<string, [number, number, number]> {
  const out = new Map<string, [number, number, number]>();
  type M = { p: number[]; q: number[]; s: number[] };
  const rot = (q: number[], v: number[]) => { const [x, y, z, w] = q as [number, number, number, number]; const ix = w * v[0]! + y * v[2]! - z * v[1]!, iy = w * v[1]! + z * v[0]! - x * v[2]!, iz = w * v[2]! + x * v[1]! - y * v[0]!, iw = -x * v[0]! - y * v[1]! - z * v[2]!; return [ix * w + iw * -x + iy * -z - iz * -y, iy * w + iw * -y + iz * -x - ix * -z, iz * w + iw * -z + ix * -y - iy * -x]; };
  const qmul = (a: number[], b: number[]) => [a[3]! * b[0]! + a[0]! * b[3]! + a[1]! * b[2]! - a[2]! * b[1]!, a[3]! * b[1]! - a[0]! * b[2]! + a[1]! * b[3]! + a[2]! * b[0]!, a[3]! * b[2]! + a[0]! * b[1]! - a[1]! * b[0]! + a[2]! * b[3]!, a[3]! * b[3]! - a[0]! * b[0]! - a[1]! * b[1]! - a[2]! * b[2]!];
  const memo = new Map<string, M>();
  const of = (id: string, hop = 0): M => {
    const hit = memo.get(id); if (hit) return hit;
    const e = doc.entities[id], t = e?.components?.transform ?? {};
    const local: M = { p: t.position ?? [0, 0, 0], q: t.rotation ?? [0, 0, 0, 1], s: t.scale ?? [1, 1, 1] };
    let m = local;
    if (e?.parent && doc.entities[e.parent] && hop < 64) { const P = of(e.parent, hop + 1), v = rot(P.q, [local.p[0]! * P.s[0]!, local.p[1]! * P.s[1]!, local.p[2]! * P.s[2]!]); m = { p: [P.p[0]! + v[0]!, P.p[1]! + v[1]!, P.p[2]! + v[2]!], q: qmul(P.q, local.q), s: [P.s[0]! * local.s[0]!, P.s[1]! * local.s[1]!, P.s[2]! * local.s[2]!] }; }
    memo.set(id, m); return m;
  };
  for (const id of Object.keys(doc.entities)) { const m = of(id); out.set(id, [m.p[0]!, m.p[1]!, m.p[2]!]); }
  return out;
}
/** The place (or town) an entity belongs to: its root's poi:/town: tag, or a dress-<place>- id; null = the world's own. */
function ownerOf(doc: any, id: string, places: string[]): string | null {
  let e = doc.entities[id], cur = id;
  for (let hop = 0; e && hop < 64; hop++) {
    for (const t of (e.tags ?? []) as string[]) { if (t.startsWith("poi:")) return t.slice(4); if (t.startsWith("town:")) return `town:${t.slice(5)}`; }
    const d = places.filter((p) => cur.startsWith(`dress-${p}-`)).sort((a, b) => b.length - a.length)[0]; if (d) return d;
    if (!e.parent) break; cur = e.parent; e = doc.entities[cur];
  }
  return null;
}
/** Metres from a point to a polyline (xz). */
function toLine(x: number, z: number, pts: V2[]): number {
  let best = Infinity;
  for (let i = 1; i < pts.length; i++) { const [ax, az] = pts[i - 1]!, [bx, bz] = pts[i]!, dx = bx - ax, dz = bz - az, L = dx * dx + dz * dz, t = L ? Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / L)) : 0; best = Math.min(best, Math.hypot(x - ax - t * dx, z - az - t * dz)); }
  return best;
}
/** DRAFT OVERLAP (i-drafts 2026-11-03: a draft never skips a geometry guard): this place's built pieces (prefab or mesh
 *  entities of the LAB build) against the LIVE world: within DRAFT_PIECE_GAP_M of another place's or the town's piece,
 *  deeper than DRAFT_RES_DEPTH of the radius inside another LIVE place's reservation or a town disc, or on the tread of a
 *  road the place does not own. -> reports/draft-overlap.json; faults refuse the install. */
const DRAFT_PIECE_GAP_M = 3, DRAFT_RES_DEPTH = 0.6;
function draftOverlap(tw: string): string[] {
  const labScene = read(sceneFile(lab, labWorld)), liveScene = read(sceneFile(project, tw)), liveWorld = read(worldFile(project, tw));
  const res = ((read(path.join(ZONE, "reservations.json")).reservations ?? []) as any[]).filter((r) => Array.isArray(r.center));
  const places = [...new Set([...res.map((r) => String(r.location)), poi])];
  const solid = (e: any) => !!(e?.components?.prefab || e?.components?.mesh);
  const lp = worldPositions(labScene), vp = worldPositions(liveScene);
  const mine = Object.keys(labScene.entities).filter((id) => solid(labScene.entities[id]) && ownerOf(labScene, id, places) === poi).map((id) => ({ id, at: lp.get(id)! }));
  const others = Object.keys(liveScene.entities).filter((id) => solid(liveScene.entities[id])).map((id) => ({ id, owner: ownerOf(liveScene, id, places), at: vp.get(id)! })).filter((o) => o.owner && o.owner !== poi);
  const liveOwners = new Set(others.map((o) => o.owner));
  const faults: string[] = [];
  for (const m of mine) {
    const near = others.find((o) => Math.hypot(o.at[0] - m.at[0], o.at[2] - m.at[2]) < DRAFT_PIECE_GAP_M);
    if (near) faults.push(`piece ${m.id} (${m.at[0].toFixed(1)}, ${m.at[2].toFixed(1)}) within ${DRAFT_PIECE_GAP_M} m of ${near.owner}'s ${near.id}`);
    for (const r of res) if (r.location !== poi && liveOwners.has(r.location) && Math.hypot(r.center[0] - m.at[0], r.center[1] - m.at[2]) < DRAFT_RES_DEPTH * r.radius) faults.push(`piece ${m.id} inside live ${r.location}'s reservation (${Math.round(Math.hypot(r.center[0] - m.at[0], r.center[1] - m.at[2]))} m from its centre, radius ${r.radius})`);
    for (const t of (liveWorld.features?.towns ?? []) as any[]) if (Array.isArray(t.center) && Math.hypot(t.center[0] - m.at[0], t.center[1] - m.at[2]) < (t.radius ?? 0)) faults.push(`piece ${m.id} inside town ${t.id} (radius ${t.radius})`);
    for (const r of (liveWorld.features?.roads ?? []) as any[]) {
      if (typeof r.id !== "string" || ownsFeature(r) || (r.points ?? []).length < 2) continue;
      const pts = (r.points as number[][]).map((q) => (q.length >= 3 ? [q[0]!, q[2]!] : [q[0]!, q[1]!]) as V2), d = toLine(m.at[0], m.at[2], pts);
      if (d < (r.width ?? 3) / 2) faults.push(`piece ${m.id} on road ${r.id} (${d.toFixed(1)} m from its line, width ${r.width})`);
    }
  }
  let nearest = { m: Infinity, mine: "", other: "", owner: "" as string | null };
  for (const m of mine) for (const o of others) { const d = Math.hypot(o.at[0] - m.at[0], o.at[2] - m.at[2]); if (d < nearest.m) nearest = { m: Math.round(d * 10) / 10, mine: m.id, other: o.id, owner: o.owner }; }
  write(path.join(JOB, "reports", "draft-overlap.json"), { ok: !faults.length, at: new Date().toISOString(), pieces: mine.length, against: others.length, nearest, faults });
  console.log(`draft overlap: ${mine.length} piece(s) vs ${others.length} live piece(s) of ${liveOwners.size} place(s), nearest other piece ${nearest.m} m (${nearest.owner}): ${faults.length ? `${faults.length} FAULT(S)` : "clear"}`);
  return faults;
}
const DRAFT_NOTE = () => opt("draft-note") ?? `draft install, Derek 2026-11-03`;

function install() {
  const tw = opt("target-world") ?? world, dry = has("dry-run");
  if (has("uninstall")) return applyPlace(project, tw, { remove: true, dry });
  if (has("draft")) { // geometry guards only (job.mjs draftInstallBlock) + the overlap with the live world, before any write
    if (!fs.existsSync(sceneFile(lab, labWorld))) fail(`--draft: no lab scene ${lab}/${labWorld}: run place-build lab + build --draft + gates first`);
    const ov = draftOverlap(tw);
    if (ov.length && !dry) fail(`draft overlap (reports/draft-overlap.json): ${ov.slice(0, 4).join("; ")}${ov.length > 4 ? ` (+${ov.length - 4})` : ""}`);
  }
  if (!dry) requireFinalReview(JOB);
  // the ground the work was proved on: live (without this place) vs the lab (without this place), 4 m grid over the pockets
  // L (Wristgate 2026-10-29): an OWNER-BUILT place (its own build-spec, no `plan` run) has no reports/plan.json; the
  // drift check then samples the reserved site's centre and its sub-sites (the door) instead of the planned pockets
  const planFile = path.join(JOB, "reports", "plan.json");
  const plan = fs.existsSync(planFile) ? read(planFile) : { pockets: (read(path.join(ZONE, "reservations.json")).reservations ?? [])
    .filter((r: any) => r.location === poi || String(r.location).startsWith(`${poi}-`)).map((r: any) => ({ at: r.center })) };
  if (!plan.pockets?.length) fail(`no reports/plan.json and no reservation for ${poi}: nothing to compare the live ground on`);
  const live = ground(withoutPlace(read(worldFile(project, tw)))), labG = ground(withoutPlace(read(worldFile(lab, labWorld))));
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
  // --labs (r1 2026-10-31: owners grade a built-not-installed place before the batch install): each --only job graded on
  // its own lab scene (projects/pb-<id>), written to poi-quality-labs.md; the live report is untouched
  const LABS = has("labs"); if (LABS && !only) fail("quality --labs needs --only a,b");
  const labScene = (id: string) => sceneFile(`pb-${id}`, `pb${id.replace(/[^a-z0-9]/gi, "")}`);
  const jobs = fs.readdirSync(PD).filter((id) => { try { const pr = read(path.join(PD, id, "progress.json")); // a place-build job is one with a plan (its owner may be any agent: o-smalls ran dropped-hour)
    return fs.existsSync(path.join(PD, id, "reports", "plan.json")) && (LABS ? fs.existsSync(labScene(id)) : pr.stage === "installed") && fs.existsSync(path.join(PD, id, "views.json")) && (!only || only.includes(id)); } catch { return false; } }).sort();
  const recipe = read(worldFile(project, world)), g = ground(recipe), reservations = read(path.join(ZONE, "reservations.json")).reservations ?? [];
  /** the views a place is judged by: iso-ne (overview), core-front, aerial-150 and the read view nearest the approach its footpath joins */
  const viewsOf = (id: string) => {
    const views = read(path.join(PD, id, "views.json")) as any[];
    const rn = approachReadView(path.join(PD, id), id, recipe, reservations), reads = views.filter((v) => v.name === rn);
    // the iso-ne overview FIRST (Derek 2026-10-31: the contact grid opens on the whole place), framed to the job's footprint
    return [views.find((v) => v.name === "iso-ne") ?? jobIsoViews(path.join(PD, id), ["iso-ne"])[0], views.find((v) => v.name === "core-close") ?? views.find((v) => v.name === "core-front"), views.find((v) => v.name === "aerial-150"), reads[0]].filter(Boolean);
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
  const liveE = LABS ? {} : (read(sceneFile(project, world)).entities as Record<string, any>);
  const sizes = new Map<string, number[]>(); for (const p of [project, "world-kit"]) { const f = path.join(PROJECTS, p, "authoring", "dressing", "prop-index.json"); if (fs.existsSync(f)) for (const q of read(f).props ?? []) if (q.size && !sizes.has(q.id)) sizes.set(q.id, q.size); }
  const rows: QualityRow[] = [];
  for (const id of jobs) {
    const J = path.join(PD, id), hand = read(path.join(J, "handoff.json")), brief = read(path.join(J, "brief.json")), tier = (brief.adventureSize ?? hand.measurements?.adventureSize ?? "medium") as Tier;
    const area = (hand.siteDressing?.areas ?? []).find((a: any) => a.id === "core") ?? { centre: read(path.join(J, "reports", "plan.json")).centre, radius: 10 };
    const E = LABS ? (read(labScene(id)).entities as Record<string, any>) : liveE;
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
    rows.push({ ...row, ribbons: ops.filter((o) => REMOVED_RIBBON_OPS.includes(o.op)).map((o) => String(o.id).replace(`pb-${id}-`, "")), score: gradeScore(row) });
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
  const QF = LABS ? "poi-quality-labs" : "poi-quality";
  if (LABS) md[2] = md[2]!.replace("installed place-build places, LIVE world", "built place-build places graded on their LABS (--labs)");
  fs.writeFileSync(path.join(ZONE, "reports", `${QF}.md`), md.join("\n"));
  write(path.join(ZONE, "reports", `${QF}.json`), { world, zone, at: new Date().toISOString(), labs: LABS, rows });
  for (const r of rows) console.log(`${String(r.score).padEnd(5)} ${r.id.padEnd(16)} core ${r.core.diameter}/${r.core.floor}  props ${r.density.per100}/100m2  cliff ${r.built.cliff}/${r.built.walls}  read ${r.read.px ?? "-"} px @ ${r.read.distance ?? "-"}`);
  console.log(`-> ${path.relative(process.cwd(), path.join(ZONE, "reports", `${QF}.md`))}`);
}

/** The read view of a place: the read-* view nearest the approach line its footpath joins (handoff read.approachLine). */
function approachReadView(job: string, id: string, recipe: any, reservations: any[]): string | null {
  const segD = (q: V2, l: V2[]) => { let m = Infinity; for (let i = 0; i + 1 < l.length; i++) { const a = l[i]!, b = l[i + 1]!, dx = b[0] - a[0], dz = b[1] - a[1], L = dx * dx + dz * dz || 1, t = Math.max(0, Math.min(1, ((q[0] - a[0]) * dx + (q[1] - a[1]) * dz) / L)); m = Math.min(m, Math.hypot(q[0] - a[0] - t * dx, q[1] - a[1] - t * dz)); } return m; };
  const views = read(path.join(job, "views.json")) as any[], hand = fs.existsSync(path.join(job, "handoff.json")) ? read(path.join(job, "handoff.json")) : {}, res = reservations.find((r: any) => r.location === id);
  const lines = res ? approachLines(recipe, reservations, res).lines : [], line = lines[hand.read?.approachLine ?? 0] ?? lines[0] ?? [];
  const reads = views.filter((v) => String(v.name).startsWith("read-")).sort((x, y) => segD([x.x, x.z], line) - segD([y.x, y.z], line));
  return reads[0]?.name ?? null;
}

// ---------------------------------------------------------------------------------------------------------------------
/** RENDER-BATCH (Derek 2026-10-31, memory batch-renders-after-install): ONE light-shots run over the LIVE world (one
 *  browser, the world loaded once, shaders warm) hops over every place of a batch: per place the iso pair first, then
 *  core-close / core-front, the read view of its approach and the views marked `batch: true` (tools/_render-batch.mts),
 *  20:00 only where the live place has lights; --extra spots ride along. A spot that stalls is skipped and listed; a run
 *  that dies is retried once for the spots it never reached. Inside the render lock (blender-lock.mjs FIFO on
 *  .hitreg/render.lock). Writes each place's frames + evidence record (evidence/live/<batch>/), records its read shot,
 *  judges its SHOT rows (wash, read, design sample, see-through) and makes one contact sheet per place:
 *  <zone>/reports/batches/<batch>/sheet-<place>.png + index.json. */
async function renderBatch() {
  const t0 = Date.now(), places = (opt("places") ?? "").split(",").map((x) => x.trim()).filter(Boolean);
  if (!places.length) fail("render-batch: --places a,b,c (the installed places of the batch)");
  const PD = path.join(ZONE, "pois"), recipe = read(worldFile(project, world)), reservations = fs.existsSync(path.join(ZONE, "reservations.json")) ? read(path.join(ZONE, "reservations.json")).reservations ?? [] : [];
  const E = read(sceneFile(project, world)).entities as Record<string, any>;
  const inputs: BatchPlace[] = [], warn: string[] = [];
  for (const id of places) {
    const J = path.join(PD, id);
    if (!fs.existsSync(path.join(J, "views.json"))) fail(`render-batch: ${id} has no job (${path.relative(process.cwd(), J)}/views.json)`);
    const live = Object.entries(E).filter(([eid, e]) => (e.tags ?? []).includes(`poi:${id}`) || eid.startsWith(`dress-${id}-`));
    if (!live.length) warn.push(`${id}: nothing tagged poi:${id} in the live ${world} scene (not installed?): shot anyway`);
    const hand = fs.existsSync(path.join(J, "handoff.json")) ? read(path.join(J, "handoff.json")) : {};
    const prefabs = live.map(([, e]) => e.components?.prefab?.prefabId).filter((x): x is string => typeof x === "string");
    inputs.push({ id, views: read(path.join(J, "views.json")), iso: jobIsoViews(J), readView: approachReadView(J, id, recipe, reservations), lit: hand.read?.duskLight !== false && burnsAtDusk(prefabs) });
  }
  for (const w of warn) console.log(`WARN ${w}`);
  const extraFile = opt("extra") ? path.resolve(opt("extra")!) : undefined, extra = extraFile ? read(extraFile) : [];
  const spots = batchSpots(inputs, extra, { night: opt("night") === "off" ? "off" : "auto" });
  const BID = opt("batch") ?? batchId(places, extraFile), B = path.join(ZONE, "reports", "batches", BID);
  console.log(`render-batch ${BID}: ${spots.length} spot(s) over ${places.length} place(s)${extra.length ? ` + ${extra.length} extra` : ""} in the live ${world} (${inputs.map((p) => `${p.id}${p.lit ? " lit" : ""}`).join(", ")}) -> ${path.relative(process.cwd(), B)}`);
  if (has("dry-run")) { console.log(spots.map((s) => `  ${s.name}${s.review ? " (review)" : ""} @ ${s.times.join(",")}`).join("\n")); return; } // writes nothing
  // the same batch re-run overwrites in place (its contents emptied, the folder kept: a shell standing in it holds it on Windows)
  fs.mkdirSync(B, { recursive: true }); for (const f of fs.readdirSync(B)) fs.rmSync(path.join(B, f), { recursive: true, force: true });
  write(path.join(B, "spots.json"), spots);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), `render-batch-${BID}-`)), port = opt("port") ?? "5291", spotTimeout = opt("spot-timeout") ?? "300";
  // the render lock (one browser render on the machine at a time, FIFO): blender-lock.mjs on .hitreg/render.lock
  process.env.HITREG_BLENDER_LOCK = process.env.HITREG_RENDER_LOCK ?? path.join(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", ".."), ".hitreg", "render.lock");
  // @ts-ignore untyped engine tool module
  const lock = await import("../../../tools/blender-lock.mjs");
  const shoot = async (list: typeof spots, out: string, log: string) => {
    const sf = path.join(tmp, `${path.basename(out)}-spots.json`); fs.writeFileSync(sf, JSON.stringify(list, null, 1));
    // the cap: every frame at a settled 120 s worst case + 10 min boot (a killed run keeps its frames: salvageRun)
    const cap = opt("shots-timeout") ? +opt("shots-timeout")! * 60_000 : list.reduce((t, sp) => t + sp.times.length * 120_000, 0) + 10 * 60_000;
    const r = await runCapped([...TSX, "tools/light-shots.mts", "--scene", world, "--spots", sf, "--times", batchTimes(list).join(","), "--no-refs", "--wash", "--weather-settle", "4", "--out", out, "--port", port, "--places", "all", "--spot-timeout", spotTimeout, "--settle-max", opt("settle-max") ?? "45"], cap, log);
    const rf = path.join(out, `${world}.json`), run: Run | null = fs.existsSync(rf) ? read(rf) : null;
    // frame paths absolute (a retry run lives in another folder)
    if (!run) { const sal = salvageRun(out, world, list); if (sal) console.log(`render-batch: light-shots wrote no run record (${r.timedOut ? "TIMEOUT" : `exit ${r.status}`}); ${sal.shots!.length} frame(s) salvaged from disk`); return { r, run: sal, tried: new Set<string>() }; }
    for (const s of run.shots ?? []) { s.file = path.join(out, s.file); if (s.layers) for (const k of Object.keys(s.layers)) s.layers[k] = path.join(out, s.layers[k]!); }
    const tried = new Set([...r.out.matchAll(/TIMEOUT spot (\S+)/g), ...r.out.matchAll(/^\s*(\S+): FAILED again/gm)].map((m) => m[1]!));
    return { r, run, tried };
  };
  let first: Awaited<ReturnType<typeof shoot>> | null = null, again: Awaited<ReturnType<typeof shoot>> | null = null, waited = 0;
  let poseFirst: ReturnType<typeof poseFaults> = [], poseAgain: ReturnType<typeof poseFaults> = [];
  try {
    const tw = Date.now(); lock.takeBlenderLock(`render-batch ${BID} (${spots.length} spots)`, +(opt("lock-wait") ?? 240)); waited = Math.round((Date.now() - tw) / 1000);
    first = await shoot(spots, path.join(tmp, "run"), path.join(B, "shots.log"));
    // POSE CHECK (t-batch2 2026-10-31: after one fixed-camera spot the body stopped following travel and every later
    // camera-less view shot Red Dial): each frame's recorded camera + body must stand at its own spot; a frame that does
    // not is dropped (never evidence) and its spot re-shot once in the retry run
    const f = first;
    poseFirst = f.run ? poseFaults(spots, f.run) : [];
    const posed = new Set(poseFirst.map((x) => x.spot));
    if (posed.size) { console.log(`render-batch: POSE FAULT on ${poseFirst.length} frame(s) (dropped, re-shot):\n${poseFirst.map((x) => `  ${x.spot}@${x.time}: ${x.detail}`).join("\n")}`); f.run = dropSpots(f.run!, posed); }
    // the run DIED (watchdog, crash) before some spots were tried: once more for exactly those (a stalled spot is not
    // retried), plus the pose faults
    const never = skippedSpots(spots, f.run ? [f.run] : []).filter((n) => !f.tried.has(n) || posed.has(n));
    if ((f.r.status || posed.size) && never.length && !has("no-retry")) {
      console.log(`render-batch: ${f.r.status ? `the run ended (${f.r.timedOut ? "TIMEOUT" : `exit ${f.r.status}`})` : `${posed.size} spot(s) failed the pose check`}; retrying ${never.length} spot(s) once`);
      again = await shoot(spots.filter((s) => never.includes(s.name)), path.join(tmp, "retry"), path.join(B, "shots-retry.log"));
      poseAgain = again.run ? poseFaults(spots, again.run) : [];
      if (poseAgain.length) { console.log(`render-batch: POSE FAULT again (skipped): ${poseAgain.map((x) => `${x.spot}@${x.time}: ${x.detail}`).join("; ")}`); again.run = dropSpots(again.run!, new Set(poseAgain.map((x) => x.spot))); }
    }
  } finally { lock.releaseBlenderLock(); }
  const run = mergeRuns(first?.run ?? { shots: [] }, again?.run ?? null), skipped = skippedSpots(spots, [run]);
  const rel = (f: string) => path.relative(ZONE, f).split(path.sep).join("/");
  const index: any = { batch: BID, world, zone, at: new Date().toISOString(), seconds: 0, lockWaitS: waited, shotsS: (first?.r.s ?? 0) + (again?.r.s ?? 0), spots: spots.length, frames: (run.shots ?? []).length, skipped, poseFaults: [...poseFirst, ...poseAgain.map((x) => ({ ...x, retry: true }))], spotTiming: spotTiming([first?.run, again?.run]), extra: extraFile ?? null, log: rel(path.join(B, "shots.log")), places: [] as any[] };
  for (const p of inputs) {
    const J = path.join(PD, p.id), LD = path.join(J, "evidence", "live");
    const { shots: mine, blackFrames, copies } = splitRun(run, p.id, BID);
    pruneOldBatches(J, BID); fs.rmSync(path.join(LD, BID), { recursive: true, force: true }); fs.mkdirSync(path.join(LD, BID), { recursive: true });
    for (const c of copies) if (fs.existsSync(c.from)) fs.copyFileSync(c.from, path.join(LD, c.to));
    const planned = spots.filter((s) => s.name.startsWith(`${p.id}${SEP}`)), views = planned.map((s) => s.name.slice(p.id.length + SEP.length));
    const skippedViews = skipped.filter((n) => n.startsWith(`${p.id}${SEP}`)).map((n) => n.slice(p.id.length + SEP.length));
    const recFile = path.join(LD, `${BID}.json`);
    const rec: any = { source: "render-batch", batch: BID, world, zone, place: p.id, at: index.at, opsHash: opsHash(J), lit: p.lit, times: batchTimes(planned), planned: views, skipped: skippedViews, shots: mine, ...(blackFrames.length ? { blackFrames } : {}), sheet: rel(path.join(B, `sheet-${p.id}.png`)) };
    write(recFile, rec);
    // the wash verdict over this place's judged frames (light-shots judged the whole batch as one run)
    const { frames, wantFireRead } = await judgeRun(recFile);
    rec.washVerdict = washRun(frames, wantFireRead); write(recFile, rec);
    // SHOT rows, judged from this batch (never an install block; a fault is a fix round)
    const rows: ShotRow[] = [];
    const wash = washJudge(J, p.id, recFile, views.filter((v) => !isReviewShot({ spot: v })));
    rows.push({ row: "wash", state: wash.ok ? "ok" : "fault", detail: wash.detail });
    const readShot = recordReadShot(J, p.id, path.join(LD, BID)), readName = p.readView ?? views.find((v) => v.startsWith("read-"));
    const readBad = !!readName && (skippedViews.includes(readName) || blackFrames.some((b) => b.startsWith(`${readName}@`)));
    rows.push(readShot && readName && !readBad ? { row: "read", state: "ok", detail: `${readShot.file} (${readShot.viewpoint}) -> progress.json evidence.readShot` } : { row: "read", state: "fault", detail: readName ? `the read view ${readName} was ${readBad ? "skipped or blank" : "not shot"} in this batch` : "no read view in views.json" });
    const noSample = new Set(designFaults(J, undefined, { sample: false }) as string[]), sampleFaults = (designFaults(J) as string[]).filter((f) => !noSample.has(f));
    rows.push(sampleFaults.length ? { row: "design-sample", state: "fault", detail: `${sampleFaults.join("; ")}: pick the sample frames from evidence/live/${BID}/ (copy under the job, design.json sample.shots)` } : { row: "design-sample", state: "ok", detail: "sample frames present (or a catalogue place: none asked)" });
    const st = seeThroughBlock(J) as string | null;
    rows.push(!st ? { row: "see-through", state: "ok", detail: "report ok and current (or no built structures)" } : /no see-through gate evidence|older than/.test(st) ? { row: "see-through", state: "deferred", detail: `${st.slice(0, 160)} (on the live scene: tools/see-through.mts scene ${world} --route ${path.join(J, "walk-route.json")} --out ${path.join(J, "reports", "see-through.json")} --openings ${path.join(PROJECTS, project, "authoring", "see-through-openings.json")}, render lock)` } : { row: "see-through", state: "fault", detail: st.slice(0, 300) });
    write(recFile, { ...rec, rows });
    // the contact sheet: the iso pair on top, then a row per close view (noon, 20:00)
    const fdir = path.join(LD, BID), frameOf = (v: string, h: number) => { const f = path.join(fdir, `${v}-${String(h).padStart(2, "0")}.png`); return fs.existsSync(f) ? f : null; };
    const sheet = path.join(B, `sheet-${p.id}.png`);
    composeSheet(`${p.id}  |  batch ${BID}  |  live ${world}  |  ${index.at.slice(0, 16)}Z`, sheetRows(spots, p.id, frameOf, new Set(skipped), new Set(blackFrames)), sheet);
    index.places.push({ place: p.id, lit: p.lit, sheet: rel(sheet), record: rel(recFile), frames: mine.map((s) => rel(path.join(LD, s.file))), skipped: skippedViews, blank: blackFrames, rows });
    console.log(`  ${p.id.padEnd(18)} ${mine.length} frame(s)${skippedViews.length ? `, SKIPPED ${skippedViews.join(", ")}` : ""}${blackFrames.length ? `, BLANK ${blackFrames.join(", ")}` : ""}  ${rows.map((r) => `${r.row} ${r.state}`).join(", ")}  -> ${rel(sheet)}`);
    for (const r of rows.filter((x) => x.state === "fault")) console.log(`      FAULT ${r.row}: ${r.detail.slice(0, 240)}`);
  }
  if (extra.length) { // the extra spots: frames + one sheet in the batch folder
    const xn = (n: string) => n.slice(`extra${SEP}`.length);
    const { shots: xs, blackFrames: xb, copies } = splitRun(run, "extra", "extra");
    fs.mkdirSync(path.join(B, "extra"), { recursive: true });
    for (const c of copies) if (fs.existsSync(c.from)) fs.copyFileSync(c.from, path.join(B, c.to));
    const xskip = skipped.filter((n) => n.startsWith(`extra${SEP}`)).map(xn);
    const rows = spots.filter((s) => s.name.startsWith(`extra${SEP}`)).map((s) => s.times.map((h) => {
      const v = xn(s.name), f = path.join(B, "extra", `${v}-${String(h).padStart(2, "0")}.png`), has = fs.existsSync(f);
      return { label: `${v} ${String(h).padStart(2, "0")}:00`, file: has ? f : null, ...(xskip.includes(v) ? { note: "SKIPPED (stalled)" } : !has ? { note: "NO FRAME" } : xb.includes(`${v}@${h}`) ? { note: "BLANK RENDER" } : {}) };
    }));
    composeSheet(`extra spots (${extraFile ? path.basename(extraFile) : ""})  |  batch ${BID}  |  live ${world}`, rows, path.join(B, "sheet-extra.png"));
    index.extraSpots = { sheet: rel(path.join(B, "sheet-extra.png")), frames: xs.map((s) => rel(path.join(B, s.file))), skipped: xskip, blank: xb };
    console.log(`  extra              ${xs.length} frame(s)${xskip.length ? `, SKIPPED ${xskip.join(", ")}` : ""}  -> ${rel(path.join(B, "sheet-extra.png"))}`);
  }
  index.seconds = Math.round((Date.now() - t0) / 1000);
  write(path.join(B, "index.json"), index);
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`render-batch ${BID}: ${index.frames} frame(s), ${skipped.length} spot(s) skipped${skipped.length ? ` (${skipped.join(", ")})` : ""}; lock wait ${waited} s, shots ${index.shotsS} s, total ${index.seconds} s -> ${path.relative(process.cwd(), path.join(B, "index.json"))}`);
  if (!(run.shots ?? []).length) process.exitCode = 1;
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

const ID_CMDS = new Set(["bridge", "survey", "plan", "props", "approach", "tracks", "dress", "lab", "lab-spawn", "build", "gates", "scale", "shots", "all", "install", "evidence"]);
if (cmd === "archetypes") { for (const { a } of archetypes()) console.log(`${a.id.padEnd(14)} ${a.pockets.length} pockets  ${a.description}`); }
else if (cmd === "lift") { const { liftCommand } = await import("./_place-lift.mts"); await liftCommand(argv.slice(1)); } // a winch lift beside a long descent (tools/_place-lift.mts)
else if (cmd === "render-batch") { if (!world || !zone) fail("usage: place-build render-batch <world> --zone <z> --places a,b,c [--port p] [--night auto|off] [--extra <spots.json>] [--batch <id>] [--spot-timeout 300] [--dry-run]"); await renderBatch(); }
else if (cmd === "quality") { if (!world || !zone) fail("usage: place-build quality <world> --zone <z> [--shots] [--only a,b] [--labs] [--port p]"); await quality(); }
else if (ID_CMDS.has(cmd ?? "")) {
  if (!world || !zone || !poi) fail("usage: place-build <command> <world> --zone <z> --location <id> [--project p]");
  const t0 = Date.now();
  // WORLD ORDER (tools/world-order.mts): in a staged world the grey box starts only after the design passed review, and the
  // live install only after the final review, both on the current world
  // --sample (the design's sample area, before design-review: job.mjs needs its shots to record that review): design is
  // enough, lab only, never install (placeBuildGate refuses)
  const gateOf = placeBuildGate(cmd ?? "", { sample: has("sample"), live: has("live"), dryRun: has("dry-run"), uninstall: has("uninstall"), draft: has("draft"), layout: fs.existsSync(path.join(JOB, "layout.json")) });
  if (gateOf.refuse) fail(gateOf.refuse);
  const orderGate = gateOf.stage;
  // a --job COPY (a tools proof in a scratch lab) is outside the place's order: it never installs and never moves a stage
  if (orderGate && !opt("job")) { const refused = requirePlaceStage(path.join(PROJECTS, project), poi, orderGate, `place-build ${cmd}`, world); if (refused) { console.error(refused); process.exit(3); } }
  // EXTERIOR CHAIN (tools/_exterior.mts, Derek 2026-11-10 Rustgut): a live install (a --draft too) of a door / painted place
  // waits on its location, unedited grab, concepts and concept check, whatever the world order says (or an owner ruling)
  if (cmd === "install" && !has("dry-run") && !has("uninstall") && !opt("job")) { const { exteriorOrExit } = await import("./_exterior.mts"); exteriorOrExit(project, world, poi, `place-build install${has("draft") ? " --draft" : ""}`); }
  if (cmd === "survey") survey();
  if (cmd === "bridge") bridgeJob();
  if (cmd === "approach") { approachOnly = true; plan(); }
  if (cmd === "tracks") { tracksOnly = true; plan(); }
  if (cmd === "dress") redress(); // the dressing only, round the place as built
  if (cmd === "plan" || cmd === "all") plan();
  if (cmd === "props") await layoutPropsSheet(); // the layout's hero-prop sheet (no browser): before a chain
  if (cmd === "lab" || cmd === "all" || (cmd === "build" && !fs.existsSync(path.join(PROJECTS, lab)))) makeLab();
  if (cmd === "lab-spawn") respawnLab();
  if (cmd === "build" || cmd === "all") {
    // gate 16: nothing is built before the place is designed — premise, journey, areas, story elements made of catalogued
    // things (the sample frames and the design review come after the build: `gates` and `install` ask for them)
    const df = designFaults(JOB, undefined, { sample: false });
    if (df.length && has("draft")) console.log(`DRAFT build: the design gate (16) is open, built as it is —\n  ${df.join("\n  ")}`);
    else if (df.length) { console.error(`STOP (design gate 16): write ${path.join(JOB, "design.json")} first —\n  ${df.join("\n  ")}`); process.exit(1); }
    applyPlace(lab, labWorld);
  }
  // `all` takes no pictures unless --shots (Derek 2026-10-31: no per-place shot runs while building; the batch render
  // shoots the live world after the install: place-build render-batch)
  const allShots = cmd === "all" && has("shots");
  if (cmd === "gates" || cmd === "all") { evidencePending = allShots; gates(); evidencePending = false; }
  if (cmd === "shots" || allShots) await shots();
  if (cmd === "all") { if (allShots) gates(["place"]); else console.log("all: no shots (the batch render takes them after the install; --shots for a lab run)"); process.exitCode = read(path.join(JOB, "reports", "gates.json")).ok ? 0 : 1; } // the evidence check again, now the shots are newer than the ops; the exit is the final table
  if (cmd === "scale") gates(["scale"]); // the built place against its painting, in the painting's pixels (also a gates row)
  if (cmd === "evidence") recordReadShot(); // the read shot from pictures already taken (no browser)
  if (cmd === "install") {
    install();
    if (!has("dry-run") && !has("uninstall") && !process.exitCode) { const r = recordPlaceStage(path.join(PROJECTS, project), poi, "installed", has("draft") ? { by: "place-build install --draft", note: DRAFT_NOTE() } : { by: "place-build install" }, world); if (r) console.log(`  ${r}`); }
  }
  console.log(`(${cmd} ${poi}: ${Math.round((Date.now() - t0) / 1000)} s)`);
} else fail("usage: place-build archetypes | plan|lab|build|gates|shots|all|install <world> --zone <z> --location <id> [...]  (header of tools/place-build.mts)");

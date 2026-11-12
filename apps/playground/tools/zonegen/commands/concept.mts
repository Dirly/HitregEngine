/**
 * zonegen concept <world> --project <p> --zone <z> --poi <id>   (or --town <name> for a town, zone optional)
 *   [--height <m>] [--port 5317] [--spot-timeout 240] [--renders-only [--paint-ruling "YYYY-MM-DD ..."] [--keep-cameras <site.json | views.json>] | --paint-only | --measure] [--views gate,street,square] [--dry-run] [--keep-bare] [--style "..."] [--identity] [--change "..."] [--timeout 1800]
 *   --identity (a POI): the approved approach painting rides along as the identity + layout reference; --change says the ONE
 *   thing the repaint differs in. --views sea|shelf: extra views from saved cameras (--keep-cameras concept-<name>).
 *
 * CONCEPT ON SITE (Derek 2026-10-29: "do you take a snapshot of the area then feed those for the concept art?"). Every
 * firstshore concept frame was drawn from text; Codex invented a cliff tall enough for a 50 m gate and the owner built
 * to it on a 40 m gorge. This command paints the concept ONTO the real ground:
 *
 *  1. measures the bare site (world field): ground, relief, the tallest rock face, standable apron, water, read distance
 *     (size tier; a dungeon entrance >= 300 m) — printed beside the frames and kept in the manifest (`fit`);
 *  2. picks two cameras: APPROACH = the first-sight point on the road(s) it is reached from, at player height (the
 *     farthest point within 1.25 x read where a --height mark shows >= 16 px); FAR = from >= the read distance, the
 *     bearing that shows most, player height (raised only when nothing shows, and said so);
 *     a TOWN adds the NEAR set (Derek 2026-10-30: "you only have far away views ... it's honestly so far"): GATE on the
 *     main road 40-70 m out from the gatehouse, STREET just inside the gate down the main street, SQUARE across the
 *     square to the chapel, all at player height, on a plan STAKED from the site (_concept-site.mts townStakePlan: wall
 *     ring at the radius, gatehouse where the road crosses it, street, square, chapel lot, street lots), the stakes
 *     drawn over those bare renders for scale and kept as `stakes` in the manifest. `--views a,b` renders/paints only
 *     those views (the others' records kept while the ground is unchanged);
 *     `--measure`: the painted outline in <id>.concept-marks.json (`extent`, the place-scale schema) back-projected
 *     through its view's camera to metres, written as `extent` into the manifest and outlined on the sheet;
 *  3. renders the BARE site in play mode (tools/light-shots.mts, its own vite on --port, fixed cameras, noon, no
 *     reference characters): the world with the place's own features and entities taken out (a scratch copy
 *     projects/concept-<id>/, deleted after the run; the live scene itself when the place has none yet), plus a
 *     plan-map crop with the reservation, the approach and both cameras drawn;
 *  4. repaints both renders with `image-request.mjs gen-set` (--paint: the render is the composition; one Codex
 *     session) with the place's premise + the zone tone/mood + the style, telling Codex the ground is fixed;
 *  5. writes, overwriting in place, under <zone>/concept/ (towns: authoring/towns/concept/):
 *       <id>-approach.site.png  <id>-far.site.png  <id>-plan.site.png   the bare renders
 *       <id>-approach.png       <id>-far.png                            the concept frames (design.json concept[])
 *       <id>.site.json   manifest: reservation, ground fingerprint, cameras, fit numbers (gate 16 reads it)
 *       <id>-sheet.png   bare | painted per view with the fit numbers, and the plan crop: what the reviewer opens
 *  6. records the world order: bare-renders; concept-painted on a painting run, with each painted frame's sha256
 *     (`frames`). `--renders-only` re-composes the sheet around the SAME paintings and carries concept-painted forward
 *     when every frame's hash matches the record (order.paintedCarry); a record from before the hashes needs
 *     `--paint-ruling "YYYY-MM-DD ..."` (a dated ruling that the paintings are unchanged). The approval is re-given after.
 *     A painted view is always re-rendered from the painting's own camera (the manifest's, or --keep-cameras), never a
 *     recomputed one: a moved road moves "first sight", not the painting.
 *
 * Gate 16 (tools/poi-review/concept-site.mjs) counts a concept frame only when its request record names one of these
 * renders, for the same reservation, on unchanged ground. Walled towns also get the overlook verdict of
 * `town-wall-line check`. Heavy (world field, a browser): one at a time; never on :5173.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { AssetLibrary, ComponentRegistry, createWorldField, expandScene, scatterCell, scatterSeatSize, PrefabError, registerChunkComponents, registerCoreComponents, worldRecipeSchema, type PrefabDoc, type SceneDoc } from "@hitreg/core";
// @ts-ignore untyped helper module
import { findAsset } from "../../_closure.mjs";
import { runCapped } from "../../_run-capped.mts";
import { cropRecipe, cropScene, labBox, labSpawn, viewPoints } from "../../_lab-crop.mts";
import { tallScatterRules, treeSampler } from "../../worldgen-relief.mts";
import { groundSpread, GROUNDLESS_STD } from "../../_far-camera.mts";
import { approachView, conceptBrief, EXTRA_VIEWS, paintingCamera, farView, GATEHOUSE_M, measureSite, NEAR_VIEWS, readDistance, seenOverGround, stakeLines, townNearViews, townStakePlan, WALL_M, type Obstacle, type PromptText, type SiteFit, type TownPlan, type View, type ViewName } from "../../_concept-site.mts";
import { extentSchema, groundAxes, groundHit, pixelRay, polyArea, projector, type ScaleCamera } from "../../_place-scale.mts";
import { z } from "zod";
// @ts-ignore plain JS engine tool module
import { CONCEPT_TOOL, fileSha, groundFingerprint, ownership, ownsFeature, stampOf, uneditedRecipe, uneditedStamp } from "../../../../../tools/poi-review/concept-site.mjs";
// @ts-ignore plain JS engine tool module
import { placeOwnership } from "../../../../../tools/poi-review/exterior-chain.mjs";
import { decodePng, encodePng } from "../../_png.mjs";
import * as order from "../../world-order.mts";
// @ts-expect-error untyped helper module
import { drawText } from "../../_font.mjs";

type V2 = [number, number];
type V3 = [number, number, number];
type J = Record<string, any>;
/** The zonegen context (tools/zonegen/lib.mts Ctx), the part this command reads: kept local so the tools typecheck
 *  does not pull in the zonegen schemas. */
interface Ctx {
  project: string; world: string; zone: string;
  opt(name: string, fallback?: string): string; flag(name: string): boolean;
  paths: { projectDir: string; recipe: string; zoneDir(z: string): string; brief(z: string): string; quests(z: string): string; reservations(z: string): string; townDoc(t: string): string };
}
const exists = (f: string): boolean => fs.existsSync(f);
const readJson = (f: string): unknown => JSON.parse(fs.readFileSync(f, "utf8").replace(/^﻿/, ""));
type Img = { width: number; height: number; data: Uint8Array };
const PG = process.cwd();
const TSX = ["--max-old-space-size=6144", "node_modules/tsx/dist/cli.mjs"];
const W = 1280, H = 720;
const slug = (s: string) => s.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
const tryJson = (f: string): J | null => { try { return exists(f) ? (readJson(f) as J) : null; } catch { return null; } };
const writeJson = (f: string, v: unknown) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(v, null, 1) + "\n"); };
const prior0 = (outDir: string, id: string): J | null => tryJson(path.join(outDir, `${id}.site.json`));
const rel = (f: string) => path.relative(PG, f).split(path.sep).join("/");
const xz = (p: number[]): V2 => (p.length >= 3 ? [p[0]!, p[2]!] : [p[0]!, p[1]!]);

export async function run(ctx: Ctx): Promise<number> {
  const P = ctx.paths, poiArg = ctx.opt("poi"), townArg = ctx.opt("town");
  if (!poiArg === !townArg) { console.error("zonegen concept: give --poi <reservation location> (with --zone) or --town <name>"); return 2; }
  if (poiArg && !ctx.zone) { console.error("zonegen concept: --poi needs --zone <id>"); return 2; }
  if (!exists(P.recipe)) { console.error(`zonegen concept: no world ${P.recipe}`); return 2; }
  // WORLD ORDER (tools/world-order.mts): render on a place sited on its current LOCAL ground (no world freeze needed);
  // a repaint needs current renders; a catalogue place (art: "catalogue") gets bare renders only, never a painting
  const orderKey = (poiArg || townArg)!;
  const catalogue = order.artFor(P.projectDir, orderKey, ctx.world) === "catalogue";
  if (catalogue && ctx.flag("paint-only")) { console.error(`zonegen concept: ${orderKey} is a catalogue place (art: "catalogue", Derek 2026-10-29: no artwork) — it gets bare renders only; its design names catalogue props`); return 3; }
  const rendersOnly = ctx.flag("renders-only") || catalogue;
  if (!ctx.flag("dry-run")) {
    const refused = order.requirePlaceStage(P.projectDir, orderKey, ctx.flag("paint-only") ? "bare-renders" : "sited", "zonegen concept", ctx.world);
    if (refused) { console.error(refused); return 3; }
  }
  const raw = readJson(P.recipe) as J;
  const recipe = worldRecipeSchema.parse(raw);

  // ---- the site: a reservation, or a town ----------------------------------------------------------------------------
  let id: string, center: V2, radius: number, terrainRadius: number, approachPts: V2[] = [], fromIds: string[] = [], entrance = false, outDir: string, reservation: J | null = null;
  let size: string | undefined, text: PromptText, townName: string | null = null;
  const brief = ctx.zone ? tryJson(P.brief(ctx.zone)) : null;
  const quests = ctx.zone ? tryJson(P.quests(ctx.zone)) : null;
  if (poiArg) {
    id = poiArg;
    const res = tryJson(P.reservations(ctx.zone));
    const r = (res?.reservations ?? []).find((x: J) => x.location === id);
    if (!r) { console.error(`zonegen concept: no reservation for ${id} in ${P.reservations(ctx.zone)} (zonegen reserve first)`); return 2; }
    reservation = r;
    center = [r.center[0], r.center[1]]; radius = r.radius; // a reservation's terrainRadius 0 means "no terrain of its own", not "measure nothing": the probe still reads the
    // reservation (2026-10-30 w15: both entrance sheets said "tallest face: none" over a 73 m face)
    terrainRadius = Math.max(r.radius, r.terrainRadius ?? 0);
    for (const a of [r.approach, ...(r.approaches ?? [])].filter(Boolean)) { if (a.from) fromIds.push(a.from); if (!approachPts.length && a.points?.length) approachPts = a.points.map(xz); }
    const loc = (quests?.locations ?? []).find((l: J) => l.id === id) ?? {};
    const place = (brief?.places ?? []).find((p: J) => p.id === id) ?? (loc.place ? (brief?.places ?? []).find((p: J) => p.id === loc.place) : null) ?? {};
    entrance = !!r.entrance || /entrance/.test(String(loc.kind ?? "")) || r.interior === "instanced";
    size = loc.size ?? place.size;
    const jobDesign = [path.join(P.zoneDir(ctx.zone), "pois", id, "design.json"), path.join(P.zoneDir(ctx.zone), "dungeons", id, "design.json")].map(tryJson).find(Boolean);
    text = {
      name: loc.name ?? place.name ?? id,
      premise: jobDesign?.premise ?? (place.id === id ? place.read : undefined) ?? (loc.needs?.[0] ? `${loc.name ?? id}: ${loc.needs[0]}` : `${loc.name ?? id}`),
      read: place.id === id ? undefined : place.read, landmark: place.landmark, setPiece: place.id === id ? place.setPiece : undefined,
      mood: place.mood, needs: place.id === id ? place.features : loc.needs, zoneTone: brief?.tone,
    };
    outDir = path.join(P.zoneDir(ctx.zone), "concept");
  } else {
    townName = townArg!;
    const tdoc = tryJson(P.townDoc(townName));
    const tid = tdoc?.town ?? townName;
    const t = (raw.features?.towns ?? []).find((x: J) => x.id === tid);
    if (!t) { console.error(`zonegen concept: no town ${tid} in ${P.recipe} (authoring/towns/${townName}.json names it)`); return 2; }
    id = slug(townName); center = [t.center[0], t.center[1]]; radius = t.radius; terrainRadius = t.radius + (t.falloff ?? 60);
    // roads that end at the town are its approaches
    for (const rd of raw.features?.roads ?? []) if (!String(rd.id).startsWith(`${tid}-`) && (rd.points ?? []).length >= 2) {
      const ends = [xz(rd.points[0]), xz(rd.points[rd.points.length - 1])];
      if (ends.some((e) => Math.hypot(e[0] - center[0], e[1] - center[1]) < radius + 120)) fromIds.push(rd.id);
    }
    size = "large";
    text = { name: tdoc?.name ?? townName, premise: tdoc?.story?.why ?? tdoc?.premise ?? `the town of ${townName}`, zoneTone: brief?.tone };
    outDir = path.join(P.projectDir, "authoring", "towns", "concept");
  }
  const region = (recipe.regions ?? []).find((g: J) => g.id === ctx.zone) as J | undefined;
  if (region?.mood) text.zoneMood = Object.entries(region.mood).map(([k, v]) => `${k} ${v}`).join(", ");
  if (ctx.opt("style")) text.style = ctx.opt("style");
  const read = readDistance(size, entrance);
  const height = Number(ctx.opt("height", entrance ? "20" : size === "large" ? "18" : "12"));

  // ---- measure + views (bare ground: the field of the world WITHOUT the place's own features) ------------------------
  const subSites = (quests?.locations ?? []).filter((l: J) => l.place === id).map((l: J) => l.id as string);
  const jobDir = ctx.zone ? path.join(P.zoneDir(ctx.zone), "pois", id) : "";
  const worldOpIds = ((tryJson(path.join(jobDir, "world-ops.json")) ?? []) as J[]).flatMap((o) => (typeof o?.feature?.id === "string" ? [o.feature.id] : []));
  const name = text.name.replace(/^the\s+/i, "");
  const ownBase = { prefixes: [...new Set([slug(name), ...subSites].filter((s) => s && s !== id).map((s) => `${s}-`))], ids: [...subSites, ...worldOpIds] };
  // THE UNEDITED GROUND (Derek 2026-11-10, Rustgut: concepts were painted on the place's own stamped cliff block): a POI's
  // bare render leaves out EVERY edit of the place — its needs and need patches, its operators and their pieces, landmarks,
  // clearings, roads made for it (exterior-chain.mjs placeOwnership, concept-site.mjs uneditedRecipe). Towns keep the
  // older feature ownership (their terraces and walls are judged by the town chain).
  const own: J = poiArg ? placeOwnership(raw, { id, center, radius, terrainRadius, reservation }, ownBase) : ownership(id, ownBase);
  const bareOf = (doc: J): J => (poiArg ? uneditedRecipe(doc, own).recipe : { ...doc, features: Object.fromEntries(Object.entries(doc.features ?? {}).map(([k, v]) => [k, Array.isArray(v) ? v.filter((f) => !ownsFeature(own, f)) : v])) });
  const bareRaw: J = bareOf(raw);
  const ownedFeatures = poiArg ? uneditedRecipe(raw, own).excluded.length : Object.values(raw.features ?? {}).reduce((n: number, v) => n + (Array.isArray(v) ? v.filter((f) => ownsFeature(own, f)).length : 0), 0);
  const t0 = Date.now();
  const field = createWorldField(worldRecipeSchema.parse(bareRaw));
  console.log(`field: ${((Date.now() - t0) / 1000).toFixed(1)} s (bare: ${ownedFeatures} edit(s) of ${id} left out${poiArg ? `: ${uneditedRecipe(raw, own).excluded.slice(0, 12).join(", ")}` : ""})`);
  // an entrance stands at a face's foot: its face is the one rising from the door, not a drop behind the massif
  const fit: SiteFit = measureSite(field, center, radius, terrainRadius, { rising: entrance });
  // L (o-smalls 2026-10-30: a farm's approach and far eyes stood among town-1's houses on the road out of its gate): a
  // place that is not the town is never framed from inside a town's site (radius + 15 m); the road stretch there is cut
  const inTown = (p: V2): boolean => !townName && (raw.features?.towns ?? []).some((t: J) => Array.isArray(t.center) && Math.hypot(p[0] - t.center[0], p[1] - t.center[1]) < (Number(t.radius) || 0) + 15);
  const roads = fromIds.map((rid) => (raw.features?.roads ?? []).find((r: J) => r.id === rid)).filter(Boolean).map((r: J) => (r.points as number[][]).map(xz).filter((p) => !inTown(p))).filter((r: V2[]) => r.length >= 2);
  // the trees the scatter rules stand on the ground: a sight line through a wood shows trunks, not the site
  const trees = treeSampler(worldRecipeSchema.parse(bareRaw), field);
  const canopy = (x: number, z: number): number => trees.density(x, z);
  const bareRecipe = worldRecipeSchema.parse(bareRaw), tall = treeSampler(bareRecipe, field, undefined, tallScatterRules(bareRecipe));
  const clutter = (x: number, z: number): number => tall.density(x, z);
  // a town is approached from OUTSIDE its walls (radius + 25 m); a POI from 10 m (its reservation is the whole site)
  // an entrance's approach frames its FRONT: the face rises from the door along fit.face's bearing, the front looks back
  const fb = entrance && fit.face ? (fit.face.bearing * Math.PI) / 180 : null;
  const front: V2 | undefined = fb === null ? undefined : [-Math.sin(fb), Math.cos(fb)];
  // tall scatter objects (hoodoos, buttresses, big rocks) a camera must not stand against, out to the far ring
  const obstacles: Obstacle[] = [];
  {
    const cs = bareRecipe.cellSize, R = read * 1.3;
    for (let cz = Math.floor((center[1] - R) / cs); cz <= Math.floor((center[1] + R) / cs); cz++)
      for (let cx = Math.floor((center[0] - R) / cs); cx <= Math.floor((center[0] + R) / cs); cx++)
        for (const inst of scatterCell(field, cx, cz)) {
          const rule = bareRecipe.scatter[inst.ruleIndex]!, s = scatterSeatSize(rule, inst.scale);
          if (s.height >= 4) obstacles.push({ x: inst.position[0] + cx * cs, y: inst.position[1], z: inst.position[2] + cz * cs, r: Math.max(s.halfX, s.halfZ), h: s.height });
        }
  }
  const approach = approachView(field, center, height, read, roads, approachPts, canopy, clutter, townName ? radius + 25 : 10, front, obstacles);
  const far = farView(field, center, height, read, [approach.eye[0], approach.eye[2]], canopy, clutter, obstacles);
  // a TOWN also gets the NEAR set (Derek 2026-10-30: "you only have far away views"): gate, street and square at player
  // height, on a plan staked from the site (wall ring, gatehouse on the main road, street, square, chapel, lots)
  let plan: TownPlan | null = null;
  const allViews: View[] = [approach, far];
  if (townName) {
    // the main road: the one whose nearest point comes closest to the centre
    const near = (r: V2[]) => Math.min(...r.map((p) => Math.hypot(p[0] - center[0], p[1] - center[1])));
    const main = [...roads].sort((a, b) => near(a) - near(b))[0] ?? null;
    plan = townStakePlan(field, center, radius, main, fit.water.nearest?.at ?? null);
    allViews.push(...townNearViews(field, plan));
  }
  const want = ctx.opt("views") ? new Set(ctx.opt("views").split(",").map((s) => s.trim())) : null;
  // an EXTRA view (sea, shelf) comes only from a saved camera (--keep-cameras: a views.json `concept-<name>` or a
  // manifest's renders.<name>; later runs read the manifest), never computed: it is the owner's chosen frame
  for (const n of EXTRA_VIEWS) {
    const saved = prior0(outDir, id), src = (ctx.opt("keep-cameras") ? tryJson(ctx.opt("keep-cameras")) : null) ?? saved;
    if (!want?.has(n) && !saved?.renders?.[n]) continue;
    const r = (Array.isArray(src) ? src.find((x: J) => x?.name === `concept-${n}`) : src?.renders?.[n]) as J | undefined;
    if (!r?.camera || !r?.target) { if (want?.has(n)) { console.error(`zonegen concept: --views ${n} needs its camera in --keep-cameras (concept-${n}: camera, target)`); return 2; } continue; }
    allViews.push({ name: n, eye: r.camera, target: r.target, from: Math.round(Math.hypot(r.camera[0] - center[0], r.camera[2] - center[1])), px: 0, visible: 1, note: `the owner's ${n} camera${r.note ? ` (${r.note})` : ""}` });
  }
  if (want) for (const v of want) if (!allViews.some((x) => x.name === v)) { console.error(`zonegen concept: --views ${v}: this place has ${allViews.map((x) => x.name).join(", ")}`); return 2; }
  const views = allViews.filter((v) => !want || want.has(v.name));
  // A PAINTED view is re-rendered from the painting's OWN camera (r-found 2026-10-31: a --renders-only after a road trim
  // recomputed "first sight" on the trimmed road, moved Red Dial's approach 42 m and its far camera to another bearing,
  // and the bare frames no longer matched Derek's paintings; the scale gate then measured the paintings through the
  // wrong cameras). --renders-only keeps the manifest's cameras; --keep-cameras <file> takes them from a saved manifest
  // (renders.<view>) or a place-build views.json (concept-<view>), to recover a manifest a re-render already moved.
  const camSrc = (ctx.opt("keep-cameras") ? tryJson(ctx.opt("keep-cameras")) : rendersOnly ? tryJson(path.join(outDir, `${id}.site.json`)) : null) as J | J[] | null;
  if (ctx.opt("keep-cameras") && !camSrc) { console.error(`zonegen concept: --keep-cameras ${ctx.opt("keep-cameras")}: not a readable JSON file`); return 2; }
  // every painted view (also one this run does not render: its fit numbers go into the manifest) keeps its camera
  for (const [i, v] of allViews.entries()) {
    if ((EXTRA_VIEWS as readonly string[]).includes(v.name)) continue;
    const k = paintingCamera(v, camSrc, exists(path.join(outDir, `${id}-${v.name}.png`)), center);
    if (k === v) continue;
    if (Math.hypot(k.eye[0] - v.eye[0], k.eye[2] - v.eye[2]) > 1) console.log(`  ${v.name}: the painting's camera kept (${k.eye.join(",")}); this ground would pick ${v.eye.map((n) => Math.round(n)).join(",")}`);
    allViews[i] = k; const j = views.indexOf(v); if (j >= 0) views[j] = k;
  }

  let wall: string | null = null;
  if (townName) {
    const r = spawnSync(process.execPath, [...TSX, "tools/town-wall-line.mts", "check", "--project", ctx.project, "--town", townName], { encoding: "utf8", maxBuffer: 64 << 20 });
    const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
    wall = out.match(/WALL LINE[^\n]*/)?.[0]?.replace(/\s+/g, " ").slice(0, 220) ?? "no wall line report";
    wall += r.status === 0 ? " -> ok" : ` -> FAILED${out.match(/FAIL [^\n]*/)?.[0] ? `: ${out.match(/FAIL [^\n]*/)![0].slice(5, 160)}` : ""}`;
  }
  const fitLines = [
    `${text.name} (${id}) at ${center.join(",")}  r ${radius} m / terrain ${terrainRadius} m  ${size ?? "?"}${entrance ? " entrance" : ""}`,
    `ground ${fit.groundY} m, relief ${fit.relief} m inside the radius`,
    `tallest face ${fit.face ? `${fit.face.height} m (bearing ${fit.face.bearing}, ${fit.face.from} m out, ${fit.face.footY}-${fit.face.topY} m)` : "none"}; under the place ${fit.faceAtPlace ? `${fit.faceAtPlace.height} m` : "none"}`,
    `apron ${fit.apronM2} m2 standable round the centre`,
    `water ${fit.water.atCentre !== null ? `at centre y ${fit.water.atCentre}` : fit.water.nearest ? `y ${fit.water.nearest.y} at ${fit.water.nearest.from} m` : "none within the terrain radius"}`,
    `read distance ${read} m; mark ${height} m`,
    ...allViews.map((v) => `${v.name}: ${v.from} m${v.name === "approach" || v.name === "far" ? `, ${v.px} px` : ""} — ${v.note}`),
    ...(plan ? [`stakes: wall ${WALL_M} m at r ${radius}, gatehouse ${GATEHOUSE_M} m, chapel tower ${plan.chapel.tower} m, ${plan.stakes.filter((s) => s.kind === "lot").length} lots 8 x 11 m (${plan.note})`] : []),
    ...(wall ? [`wall overlook: ${wall}`] : []),
  ];
  fs.mkdirSync(outDir, { recursive: true });
  const file = (s: string) => path.join(outDir, `${id}${s}`);
  const manifestFile = file(".site.json");
  const renders: Record<string, string> = { plan: file("-plan.site.png") }, frames: Record<string, string> = {};
  for (const v of allViews) { renders[v.name] = file(`-${v.name}.site.png`); frames[v.name] = file(`-${v.name}.png`); }
  // EXTENT (step 2 of the near round): the painted town's ground outline (<id>.concept-marks.json `extent`, the
  // place-scale schema), back-projected through its view's camera to metres and kept in the manifest
  const marksFile = file(".concept-marks.json");
  const prior = tryJson(manifestFile);
  const extent = exists(marksFile) && prior ? paintedExtent(readJson(marksFile), prior, plan, field) : null;
  if (extent?.vsStakes) fitLines.push(`painted extent (${extent.view}): ${extent.vsStakes.painted} px wide vs the staked wall ${extent.vsStakes.staked} px -> x${extent.vsStakes.ratio}: build the wall ring to r ~${extent.vsStakes.radius} m${extent.vsStakes.gatehouse ? `; gatehouse x${extent.vsStakes.gatehouse}` : ""}${extent.metric ? "" : " (eye at ground level: metres not readable)"}`);
  else if (extent) fitLines.push(`painted extent (${extent.view}): ${extent.area} m2, ${extent.width} m wide x ${extent.depth} m deep, ${extent.reach} m from the centre at most${extent.missed ? `; ${extent.missed} outline point(s) miss the ground` : ""}${extent.metric ? "" : " (eye at ground level: metres NOT reliable)"}`);
  console.log(fitLines.map((l) => `  ${l}`).join("\n"));
  const sheet = file("-sheet.png");
  if (ctx.flag("measure")) {
    // read-only on the renders: write the extent into the manifest and redraw the sheet
    if (!prior) { console.error(`zonegen concept --measure: no ${rel(manifestFile)} (render first)`); return 2; }
    if (!extent) { console.error(`zonegen concept --measure: no extent in ${rel(marksFile)} ({ image, vfov, extent: { view, outline, masses } } — docs/place-builder.md scale)`); return 2; }
    writeJson(manifestFile, { ...prior, extent });
    writeSheet(sheet, encodePng(...conceptSheet(allViews.map((v) => v.name), renders, frames, fitLines, { extent, prior })));
    console.log(`  extent -> ${rel(manifestFile)}\n  sheet  ${rel(sheet)}`);
    return 0;
  }
  const briefText = conceptBrief(text, fit, height);
  // the cameras as light-shots spots: a pre-freeze look at the bare site renders them with tools/light-shots.mts --spots
  if (ctx.flag("dry-run")) console.log(`cameras: ${JSON.stringify(allViews.map((v) => ({ name: `${id}-${v.name}`, x: Math.round(v.eye[0]), z: Math.round(v.eye[2]), camera: v.eye, target: v.target, note: v.note })))}`);
  if (ctx.flag("dry-run")) { console.log(`\n--- repaint brief ---\n${briefText}\n--- (dry run: nothing rendered) ---`); return 0; }

  // ---- render the bare site ------------------------------------------------------------------------------------------
  const fpRes = { center, radius, terrainRadius };
  const fingerprint = groundFingerprint(raw, { center, radius: terrainRadius }, own);
  // the unedited stamp (gate 16 and the exterior chain read it): the ground WITHOUT the place's edits, and what was left out
  const unedited = uneditedStamp(raw, { center, radius: terrainRadius }, own);
  const fitRec = (v: View) => ({ from: v.from, px: v.px, note: v.note });
  if (!ctx.flag("paint-only")) {
    fs.writeFileSync(renders.plan!, encodePng(...planCrop(field, raw, center, radius, terrainRadius, approachPts, roads, allViews, plan)));
    const shot = await renderBare(ctx, id, own, views, terrainRadius, bareOf);
    if (!shot.ok) { console.error(`zonegen concept: the bare render failed — ${shot.why}`); return 1; }
    for (const v of views) {
      if (plan && (NEAR_VIEWS as readonly string[]).includes(v.name)) fs.writeFileSync(renders[v.name]!, encodePng(...staked(decodePng(fs.readFileSync(shot.files[v.name]!)) as Img, field, plan, v)));
      else fs.copyFileSync(shot.files[v.name]!, renders[v.name]!);
    }
    // a partial run (--views) keeps the other views' records when the ground has not moved
    // (and only renders made of the same UNEDITED ground: a view rendered before the 2026-11-10 rule is never carried)
    const keep = want && prior && prior.fingerprint === fingerprint.hash && prior.unedited?.fingerprint === unedited.fingerprint ? (prior.renders ?? {}) : {};
    if (want && prior && (prior.fingerprint !== fingerprint.hash || prior.unedited?.fingerprint !== unedited.fingerprint)) console.warn(`WARN: the ground under ${id} changed since ${prior.renderedAt}: the views not re-rendered now are dropped from the manifest`);
    const rec = (v: View) => ({ file: path.basename(renders[v.name]!), sha256: fileSha(renders[v.name]!), ...cam(v), ...(plan && (NEAR_VIEWS as readonly string[]).includes(v.name) ? { staked: true } : {}) });
    writeJson(manifestFile, {
      tool: CONCEPT_TOOL, version: 1, poi: id, project: ctx.project, world: ctx.world, zone: ctx.zone || null, town: townName,
      reservation: fpRes, worldFile: rel(P.recipe), ownership: own, ...stampOf(fingerprint), unedited,
      renderedAt: new Date().toISOString(), bare: shot.bare,
      renders: { ...keep, ...Object.fromEntries(views.map((v) => [v.name, rec(v)])), plan: { file: path.basename(renders.plan!), sha256: fileSha(renders.plan!) } },
      fit: { ...fit, read, height, ...Object.fromEntries(allViews.map((v) => [v.name, fitRec(v)])), wall },
      ...(plan ? { stakes: stakeRecord(plan) } : {}),
      ...(extent ? { extent } : {}),
    });
  } else if (!prior || views.some((v) => !exists(renders[v.name]!))) { console.error(`zonegen concept: --paint-only needs the renders + ${rel(manifestFile)} (run without it first)`); return 2; }
  else if (prior.fingerprint !== fingerprint.hash) console.warn(`WARN: the ground under ${id} changed since ${prior.renderedAt}: repainting stale renders (gate 16 will refuse them; re-render)`);
  if (ctx.flag("paint-only") && poiArg && prior && prior.unedited?.fingerprint !== unedited.fingerprint) { console.error(`zonegen concept: the bare renders of ${id} were not made of its UNEDITED ground (${prior.unedited ? "the unedited ground moved" : "made before the 2026-11-10 rule"}): re-render first (--renders-only), then paint`); return 3; }

  // ---- repaint -------------------------------------------------------------------------------------------------------
  if (!rendersOnly) {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "concept-set-"));
    try {
      // a town's frames are the SAME place: its current approach painting rides along as the identity reference (copied
      // out first: a repainted approach overwrites it); one Codex session, refs attached once each in first-seen order
      // a POI gets the same with --identity (o-sunwine5 2026-11-02: repaint ONE piece of an approved place, keep the rest)
      const identity = (plan || ctx.flag("identity")) && exists(frames.approach!) ? path.join(tmp, "identity-approach.png") : null;
      if (identity) fs.copyFileSync(frames.approach!, identity);
      const refOrder: string[] = [], at = (f: string) => { if (!refOrder.includes(f)) refOrder.push(f); return refOrder.indexOf(f) + 1; };
      const set = {
        brief: briefText,
        images: views.map((v) => {
          const near = (NEAR_VIEWS as readonly string[]).includes(v.name), ref = [...(identity ? [identity] : []), renders[v.name]!];
          const idN = identity ? at(identity) : 0, n = at(renders[v.name]!);
          return {
            id: `concept-${ctx.world}-${id}-${v.name}`, target: frames[v.name]!, size: `${W}x${H}`, paint: true, ref, purpose: `concept on site: ${id} ${v.name} view (gate 16)`,
            prompt: [
              `This frame repaints attached image ${n} only (its COMPOSITION: keep its camera, horizon and ground): ${viewText(v)}. Same camera, same horizon, same ground.`,
              near ? `The coloured lines in image ${n} are survey STAKES of the town's plan, standing on the real ground at true scale: RED = the town wall line with its ${WALL_M} m top line and posts; ORANGE = the gatehouse footprint and its ${GATEHOUSE_M} m top; YELLOW = the main street's edges (6 m wide); CYAN = the market square; MAGENTA = the chapel lot and its tower (${plan!.chapel.tower} m top); WHITE = building lots (8 m frontage, 11 m deep, 3 m posts). Build the town ON them: walls on the red line at that height, the gatehouse on the orange box, houses filling the white lots fronting the street, the square open, the chapel on the magenta lot with its tower where the small box is. Then REMOVE every stake line: none may show in the painting.` : "",
              identity && plan ? `Attached image ${idN} is the current APPROACH painting of this same town (from ${approach.from} m): it is the town's identity. Match it exactly — the same red rubble wall and stone, the same roofs, the same gatehouse and chapel tower, the same light and air — so this frame reads as that town seen up close. Do not repaint image ${idN}.` : "",
              identity && !plan ? `Attached image ${idN} is the current APPROVED approach painting of this same place: it is the place's identity and its LAYOUT. Paint the same place: the same pieces where it puts them, the same stone, timber, light and air${ctx.opt("change") ? ", EXCEPT what THE CHANGE below says" : ""}. Do not repaint image ${idN}.` : "",
              ctx.opt("change") ? `THE CHANGE (the only thing that differs from the approved painting): ${ctx.opt("change")}` : "",
            ].filter(Boolean).join("\n"),
          };
        }),
      };
      const mf = path.join(tmp, "set.json");
      writeJson(mf, set);
      const r = spawnSync(process.execPath, ["tools/image-request.mjs", "gen-set", "--manifest", mf, "--timeout", ctx.opt("timeout", "1800"), "--force", "--requester", "zonegen-concept"], { encoding: "utf8", maxBuffer: 64 << 20, stdio: ["ignore", "pipe", "pipe"] });
      process.stdout.write(r.stdout ?? ""); if (r.status !== 0) { process.stderr.write((r.stderr ?? "").slice(-2000)); console.error("zonegen concept: the repaint failed (renders and manifest kept; --paint-only retries)"); return 1; }
    } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  }
  writeSheet(sheet, encodePng(...conceptSheet(allViews.map((v) => v.name), renders, frames, fitLines, extent ? { extent, prior: tryJson(manifestFile) ?? prior! } : null)));
  console.log(`\nconcept on site: ${id}`);
  for (const v of allViews) console.log(`  ${v.name.padEnd(8)} bare ${rel(renders[v.name]!)}${exists(frames[v.name]!) ? `  ->  painted ${rel(frames[v.name]!)}` : ""}`);
  console.log(`  plan     ${rel(renders.plan!)}\n  sheet    ${rel(sheet)}   (open it: judge the painting against the numbers)\n  manifest ${rel(manifestFile)}`);
  const painted = allViews.map((v) => frames[v.name]!).filter(exists);
  if (painted.length) console.log(`  design.json: "concept": [${painted.map((f) => `"${rel(f)}"`).join(", ")}]`);
  if (!ctx.flag("paint-only")) { const r = order.recordPlaceStage(P.projectDir, orderKey, "bare-renders", { by: "zonegen concept", evidenceFile: manifestFile }, ctx.world); if (r) console.log(`  ${r}`); }
  // the painted frames' hashes ride on the concept-painted record, so a later bare re-render can prove them unchanged
  const frameShas = Object.fromEntries(views.map((v) => [path.relative(P.projectDir, frames[v.name]!).split(path.sep).join("/"), exists(frames[v.name]!) ? fileSha(frames[v.name]!) as string : null]));
  // a partial painting run (--views) keeps the hashes of the frames it did not paint when they are unchanged on disk
  // (L o-sunwine5 2026-11-02: --views sea,shelf dropped the approved approach/far hashes, so no later run could carry them)
  const kept = (() => { if (!want) return {}; const pr = order.loadStages(P.projectDir, ctx.world)?.places.find((x) => order.matchPlace(x, orderKey))?.stages["concept-painted"]?.frames ?? {}; return Object.fromEntries(Object.entries(pr).filter(([f, sha]) => !(f in frameShas) && exists(path.join(P.projectDir, f)) && fileSha(path.join(P.projectDir, f)) === sha)); })();
  if (!rendersOnly) { const r = order.recordPlaceStage(P.projectDir, orderKey, "concept-painted", { by: "zonegen concept", evidenceFile: sheet, frames: { ...kept, ...frameShas } as Record<string, string> }, ctx.world); if (r) console.log(`  ${r}`); }
  // --renders-only re-composes the sheet (the concept-painted evidence) around the SAME paintings: carry that record
  // forward when the paintings are the recorded ones (order.paintedCarry: content hashes; a record without them needs a
  // dated --paint-ruling). r-found 2026-10-31: a re-render after a road trim STALEd Red Dial's approved paintings with
  // no way back short of a Codex repaint. The approval after it is still re-given (`zonegen approve`).
  else if (!catalogue) {
    const prior = order.loadStages(P.projectDir, ctx.world)?.places.find((x) => order.matchPlace(x, orderKey))?.stages["concept-painted"];
    const c = order.paintedCarry(prior, frameShas, ctx.opt("paint-ruling", ""));
    if (c.carry) { const r = order.recordPlaceStage(P.projectDir, orderKey, "concept-painted", { by: "zonegen concept --renders-only", note: c.why, evidenceFile: sheet, frames: frameShas as Record<string, string>, ...(prior?.frames ? {} : { ruling: ctx.opt("paint-ruling") }) }, ctx.world); if (r) console.log(`  ${r}`); }
    else if (prior) console.log(`  concept-painted not carried: ${c.why}`);
  }
  return 0;
}

function viewText(v: View): string {
  switch (v.name) {
    case "approach": return `the APPROACH view, at player height on the road ${v.from} m out, where the place first comes into sight`;
    case "far": return `the FAR view from ${v.from} m: the place's silhouette over its land`;
    case "gate": return `the GATE view, at player height on the main road ${v.from} m out from the gatehouse: the wall and the gatehouse close up, the road running into the gate passage`;
    case "street": return "the STREET view, at player height just inside the gate, looking down the main street: house fronts on both sides, the market square ahead and the chapel tower beyond";
    case "square": return "the SQUARE view, at player height on the near corner of the market square, looking across it at the chapel and its tower, houses round the square";
    case "sea": return `the SEA view from ${v.from} m out on the water (a boat's deck), looking in at the place over the bay: it must read from here`;
    case "shelf": return `the SHELF view, at player height on the place's own ground ${v.from} m from the centre, close to its hero piece`;
  }
}

/** The plan summary kept in the manifest (the town planner reads it as the concept's assumed layout). */
function stakeRecord(p: TownPlan): J {
  const r = (q: V2) => [Math.round(q[0] * 10) / 10, Math.round(q[1] * 10) / 10];
  return {
    note: p.note, gate: r(p.gate), axis: r(p.axis), wallM: WALL_M, gatehouseM: GATEHOUSE_M,
    square: { at: r(p.square.at), halfDepth: p.square.halfDepth, halfWidth: p.square.halfWidth }, chapel: { at: r(p.chapel.at), tower: p.chapel.tower },
    lots: p.stakes.filter((s) => s.kind === "lot").map((s) => s.points.map(r)),
  };
}

const STAKE_RGB: Record<string, [number, number, number]> = { wall: [255, 50, 40], gatehouse: [255, 150, 20], street: [255, 235, 60], square: [40, 230, 255], chapel: [255, 60, 230], lot: [255, 255, 255] };
/** The staked plan drawn over a bare near render: each stake line projected through the view's camera (vfov 60, the play
 *  camera), drawn where the ground does not hide it, 3 px within 25 m, 2 px beyond. */
function staked(img: Img, g: { height(x: number, z: number): number }, plan: TownPlan, v: View): [number, number, Uint8Array] {
  const camera: ScaleCamera = { eye: v.eye, target: v.target, vfov: 60, width: img.width, height: img.height }, proj = projector(camera);
  const out = new Uint8Array(img.data.length === img.width * img.height * 4 ? img.data : toRgba(img));
  const put = (x: number, y: number, c: number[], r: number) => {
    for (let a = -r; a <= r; a++) for (let b = -r; b <= r; b++) { const X = Math.round(x + a), Y = Math.round(y + b); if (X < 0 || Y < 0 || X >= img.width || Y >= img.height) continue; const k = (Y * img.width + X) * 4; out[k] = c[0]!; out[k + 1] = c[1]!; out[k + 2] = c[2]!; out[k + 3] = 255; }
  };
  // lots first: the street, square and chapel edges they front stay readable on top
  const layer = ["lot", "wall", "square", "street", "chapel", "gatehouse"];
  for (const line of stakeLines(g, plan).sort((a, b) => layer.indexOf(a.kind) - layer.indexOf(b.kind))) {
    const col = STAKE_RGB[line.kind]!;
    // a vertical post is two points: densify it so the occlusion test runs along it
    const pts = line.pts.length === 2 ? Array.from({ length: 9 }, (_, i) => [line.pts[0]![0], line.pts[0]![1] + ((line.pts[1]![1] - line.pts[0]![1]) * i) / 8, line.pts[0]![2]] as [number, number, number]) : line.pts;
    let prev: [number, number, number] | null = null;
    for (const p of pts) {
      const s = proj(p), seen = s && seenOverGround(g, v.eye, p) ? s : null;
      if (seen && prev) { const L = Math.hypot(seen[0] - prev[0], seen[1] - prev[1]); if (L < 400) for (let t = 0; t <= L; t += 0.7) put(prev[0] + ((seen[0] - prev[0]) * t) / (L || 1), prev[1] + ((seen[1] - prev[1]) * t) / (L || 1), col, seen[2] < 25 ? 1 : 0.5); }
      else if (seen) put(seen[0], seen[1], col, 1);
      prev = seen;
    }
  }
  return [img.width, img.height, out];
}
function toRgba(img: Img): Uint8Array {
  const ch = img.data.length / (img.width * img.height), out = new Uint8Array(img.width * img.height * 4);
  for (let i = 0; i < img.width * img.height; i++) { out[i * 4] = img.data[i * ch]!; out[i * 4 + 1] = img.data[i * ch + 1]!; out[i * 4 + 2] = img.data[i * ch + 2]!; out[i * 4 + 3] = 255; }
  return out;
}

/** A town's concept-marks file: no hero pieces to mark before anything is built, only the painted extent. */
const townMarksSchema = z.object({
  image: z.object({ width: z.number().int().positive(), height: z.number().int().positive() }).strict().default({ width: 1280, height: 720 }),
  vfov: z.number().min(10).max(120).default(60),
  extent: extentSchema,
}).passthrough();
/** An eye less than this far (m) above the ground its outline lands on reads no metres: at player height a pixel row near
 *  the horizon spans tens of metres (redstrand town-1 2026-10-30: the gate painting's wall foot back-projected 20 m short). */
const METRIC_EYE_M = 10;
/**
 * The painted outline back-projected through its view's camera onto the bare ground (no zoom: the painting is made over
 * the true render; an `anchor` needs built pieces and is ignored here). On a STAKED near view the outline is also judged
 * in the frame's own pixels against the staked wall ring (+ a `gatehouse` mass against the staked gatehouse): the ratio
 * is the painting's scale on the plan, readable at player height where metres are not.
 */
function paintedExtent(rawMarks: unknown, manifest: J, plan: TownPlan | null, g: { height(x: number, z: number): number }): J | null {
  const m = townMarksSchema.safeParse(rawMarks); if (!m.success) { console.warn(`WARN: concept-marks: ${m.error.message.slice(0, 300)}`); return null; }
  const ext = m.data.extent, r = manifest.renders?.[ext.view];
  if (!r?.camera || !r?.target) { console.warn(`WARN: concept-marks extent.view ${ext.view} has no camera in the manifest`); return null; }
  const camera: ScaleCamera = { eye: r.camera, target: r.target, vfov: m.data.vfov, width: m.data.image.width, height: m.data.image.height };
  const ray = pixelRay(camera), h = ext.planeY != null ? () => ext.planeY! : (x: number, z: number) => g.height(x, z);
  const hits = ext.outline.map((p) => groundHit(camera.eye as V3, ray(p[0], p[1]), h));
  const poly = hits.filter(Boolean).map((p) => [p![0], p![2]] as V2);
  const ax = groundAxes(camera), span = (a: [number, number]) => { const v = poly.map((p) => p[0] * a[0] + p[1] * a[1]); return v.length ? Math.max(...v) - Math.min(...v) : 0; };
  const c = manifest.reservation.center as V2, r1 = (v: number) => Math.round(v * 10) / 10, r2 = (v: number) => Math.round(v * 100) / 100;
  const metric = camera.eye[1] - h(c[0], c[1]) >= METRIC_EYE_M;
  let vsStakes: J | null = null;
  if (plan && r.staked) {
    const proj = projector(camera), xs = (pts: V3[]) => pts.filter((p) => seenOverGround(g, camera.eye as V3, p)).map((p) => proj(p)).filter((s): s is [number, number, number] => !!s && s[0] >= 0 && s[0] <= camera.width).map((s) => s[0]);
    const lines = stakeLines(g, plan), wide = (k: string) => { const v = lines.filter((l) => l.kind === k).flatMap((l) => xs(l.pts)); return v.length ? Math.max(...v) - Math.min(...v) : 0; };
    const ox = ext.outline.map((p) => p[0]), painted = Math.max(...ox) - Math.min(...ox), staked = wide("wall");
    const gm = ext.masses.find((q) => q.id === "gatehouse"), gw = gm ? Math.max(...gm.points.map((p) => p[0])) - Math.min(...gm.points.map((p) => p[0])) : 0, sg = wide("gatehouse");
    if (staked > 0) vsStakes = { painted: Math.round(painted), staked: Math.round(staked), ratio: r2(painted / staked), radius: Math.round((manifest.reservation.radius * painted) / staked), ...(gw && sg ? { gatehouse: r2(gw / sg) } : {}) };
  }
  return {
    view: ext.view, metric, ...(vsStakes ? { vsStakes } : {}), outline: ext.outline, world: hits.map((p) => (p ? [r1(p[0]), r1(p[1]), r1(p[2])] : null)), missed: hits.filter((p) => !p).length,
    area: Math.round(polyArea(poly)), width: r1(span(ax.right)), depth: r1(span(ax.fwd)), reach: r1(Math.max(0, ...poly.map((p) => Math.hypot(p[0] - c[0], p[1] - c[1])))),
    masses: ext.masses.map((q) => { const w = q.points.map((p) => groundHit(camera.eye as V3, ray(p[0], p[1]), h)).filter(Boolean).map((p) => [p![0], p![2]] as V2); return { id: q.id, note: q.note, area: Math.round(polyArea(w)) }; }),
    at: new Date().toISOString(),
  };
}

/** Is a PNG one flat colour (every sampled pixel within 6 of the first)? */
function blankFrame(file: string): boolean {
  try {
    const img = decodePng(fs.readFileSync(file)) as Img;
    const ch = img.data.length / (img.width * img.height);
    const step = Math.max(1, Math.floor((img.width * img.height) / 4000));
    for (let i = step; i < img.width * img.height; i += step) for (let c = 0; c < 3; c++) if (Math.abs(img.data[i * ch + c]! - img.data[c]!) > 6) return false;
    return true;
  } catch { return false; }
}

const cam = (v: View) => ({ camera: v.eye.map((n) => Math.round(n * 10) / 10), target: v.target.map((n) => Math.round(n * 10) / 10), from: v.from, px: v.px, note: v.note });

/** Scene entities that are prefab instances the closure cannot expand (PrefabError), the place's own skipped. */
function brokenInstances(scene: J, project: string, skip: Set<string>): Set<string> {
  class Lazy extends AssetLibrary {
    override getPrefab(pid: string): PrefabDoc | undefined {
      const have = super.getPrefab(pid);
      if (have) return have;
      const f = findAsset(project, `prefabs/${pid}.json`);
      if (f) try { this.addPrefab(pid, JSON.parse(fs.readFileSync(f, "utf8").replace(/^﻿/, ""))); } catch { /* an invalid prefab: the instance fails */ }
      return super.getPrefab(pid);
    }
  }
  const lib = new Lazy(), reg = new ComponentRegistry(); registerCoreComponents(reg); registerChunkComponents(reg);
  const out = new Set<string>();
  for (const [eid, e] of Object.entries(scene.entities ?? {}) as [string, any][]) {
    if (skip.has(eid) || !e?.components?.prefab) continue;
    try { expandScene({ ...scene, entities: { [eid]: { ...e, parent: null } } } as SceneDoc, lib, reg); }
    catch (err) { if (err instanceof PrefabError) out.add(eid); }
  }
  return out;
}

/** Shoot the two fixed cameras on the BARE site in play mode at noon (light-shots, its own vite on --port). */
async function renderBare(ctx: Ctx, id: string, own: J, views: View[], terrainRadius: number, bareOf: (doc: J) => J): Promise<{ ok: true; files: Record<string, string>; bare: string } | { ok: false; why: string }> {
  const P = ctx.paths;
  const sceneFile = path.join(P.projectDir, "assets", "scenes", `${ctx.world}.scene.json`);
  if (!exists(sceneFile)) return { ok: false, why: `no scene ${sceneFile}` };
  const scene = readJson(sceneFile) as J;
  const mine = new Set(Object.entries(scene.entities ?? {}).filter(([eid, e]: [string, any]) => (e.tags ?? []).some((t: string) => t === `poi:${id}` || own.ids.includes(t.replace(/^poi:/, ""))) || eid.startsWith(`dress-${id}-`)).map(([eid]) => eid));
  for (let grew = true; grew;) { grew = false; for (const [k, e] of Object.entries(scene.entities ?? {}) as [string, any][]) if (e.parent && mine.has(e.parent) && !mine.has(k)) { mine.add(k); grew = true; } }
  const raw = readJson(P.recipe) as J;
  const count = (doc: J) => Object.values(doc.features ?? {}).reduce((n: number, v) => n + (Array.isArray(v) ? v.length : 0), 0) + (Array.isArray(doc.needs) ? doc.needs.length : 0);
  const ownedF = count(raw) - count(bareOf(raw));
  // L (dogfood 2026-10-29: proving's live scene no longer boots, a merchant-cart instance override names a path its
  // prefab lost): an instance that does not expand would fail the whole bare render, so it is left out of the copy
  const broken = brokenInstances(scene, ctx.project, mine);
  let sceneId = ctx.world, scratch: string | null = null, bare = "live scene (the place has no features or entities yet)";
  // views whose eye stands over open water: their lower frame is water by design, so the groundless check reads the
  // shore band, as for a sea view (w-temple3 2026-11-02: a swimmer's-eye front view of a drowned temple read "no ground")
  const overWater = new Set<string>();
  // L (Derek 2026-10-30 "take a few chunks and send it to do the work there"): the bare render is ALWAYS a cropped scratch
  // (tools/_lab-crop.mts): the box round both cameras, a stretch past their target and the site's terrain radius; the
  // recipe keeps only the features reaching it (ground proved identical to live), the scene only what stands in it, and
  // voxelWorld.bounds stops the streamer at its edge
  {
    for (const b of broken) mine.add(b);
    for (let grew = true; grew;) { grew = false; for (const [k, e] of Object.entries(scene.entities ?? {}) as [string, any][]) if (e.parent && mine.has(e.parent) && !mine.has(k)) { mine.add(k); grew = true; } }
    // a scratch copy like place-build's lab: the world minus the place's features, the scene minus its entities
    const lab = `concept-${id}`, labWorld = `concept${id.replace(/[^a-z0-9]/gi, "")}`;
    scratch = path.join(PG, "projects", lab);
    const pj = readJson(path.join(P.projectDir, "project.json")) as J;
    writeJson(path.join(scratch, "project.json"), { version: 1, name: lab, title: `concept on site: ${id} (scratch)`, description: `Scratch bare copy of ${ctx.world} for zonegen concept ${id}; deleted after the run.`, group: "Worlds", menuOrder: 99,
      scenes: [{ id: labWorld, label: `concept ${id}`, variants: [] }], engine: pj.engine ?? "^0.1", multiplayer: pj.multiplayer ?? "server", tools: [], dependsOn: [...new Set([...(pj.dependsOn ?? []), ctx.project])] });
    const box = labBox([...views.flatMap((v) => viewPoints({ camera: v.eye, target: v.target })), ...views.flatMap((v) => [[v.target[0] - terrainRadius, v.target[2] - terrainRadius], [v.target[0] + terrainRadius, v.target[2] + terrainRadius]] as V2[])]);
    const crop = cropRecipe(bareOf(raw), box, { log: (l) => console.log(l) });
    writeJson(path.join(scratch, "assets", "worlds", `${labWorld}.json`), crop.recipe);
    const tdir = path.join(P.projectDir, "assets", "materials", "terrain"), tout = path.join(scratch, "assets", "materials", "terrain");
    const named = new Set(JSON.stringify(crop.recipe).match(new RegExp(`terrain/${ctx.world}[a-z0-9-]*`, "g")) ?? []);
    if (exists(tdir)) { fs.mkdirSync(tout, { recursive: true }); for (const f of fs.readdirSync(tdir).filter((f) => f === `${ctx.world}.json` || (f.startsWith(`${ctx.world}-`) && named.has(`terrain/${f.replace(/.json$/, "")}`)))) fs.copyFileSync(path.join(tdir, f), path.join(tout, labWorld + f.slice(ctx.world.length))); }
    const t0 = views[0]!.target, g0 = createWorldField(worldRecipeSchema.parse(crop.recipe));
    for (const v of views) { const w = g0.waterY(v.eye[0], v.eye[2]); if (w !== null && w > g0.height(v.eye[0], v.eye[2]) + 0.5) overWater.add(v.name); }
    // the scratch starts AT THE PLACE (Derek 2026-10-31): on walkable ground at the first view's eye, facing its target
    const e0 = views[0]!.eye, st = labSpawn(g0, [e0[0], e0[2]], [t0[0], t0[2]], `${id}: the ${views[0]!.name} view's eye, facing its target`);
    const s = cropScene(scene, box, { x: st.position[0], z: st.position[2], groundY: st.ground, target: st.target }).scene;
    for (const eid of mine) delete s.entities[eid];
    for (const e of Object.values(s.entities) as any[]) if (e.components?.voxelWorld) e.components.voxelWorld.world = labWorld;
    s.name = `concept ${id}`;
    writeJson(path.join(scratch, "assets", "scenes", `${labWorld}.scene.json`), s);
    sceneId = labWorld;
    bare = `cropped scratch [${box.min}]..[${box.max}] (dropped ${Object.entries(crop.dropped).map(([k, n]) => `${n} ${k}`).join(", ") || "nothing"}; ground proved identical on ${crop.proof.samples} samples + ${crop.proof.cells} cells): ${ownedF} feature(s) and ${mine.size - broken.size} entit(ies) of ${id} taken out${broken.size ? `; ${broken.size} instance(s) that do not expand left out (${[...broken].slice(0, 3).join(", ")})` : ""}`;
    if (broken.size) console.log(`WARN: ${broken.size} prefab instance(s) of the live scene do not expand (left out of the bare copy): ${[...broken].slice(0, 5).join(", ")}`);
  }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "concept-shots-"));
  try {
    // the body (the streaming centre) stands at the EYE, as a player would: from the eye/target midpoint the trees beside a
    // far camera were HLOD impostor cut-outs (2026-10-29 redstrand w9; light-shots now checks it per frame)
    const spots = views.map((v) => ({ name: v.name, x: Math.round(v.eye[0]), z: Math.round(v.eye[2]), camera: v.eye, target: v.target }));
    const spotsFile = path.join(tmp, "spots.json");
    writeJson(spotsFile, spots);
    const scope = Math.round(Math.max(...views.map((v) => Math.hypot(v.eye[0] - v.target[0], v.eye[2] - v.target[2]))) + terrainRadius + 150);
    const port = ctx.opt("port", "5317");
    if (["5173", "5287", "5291", "5293"].includes(port)) return { ok: false, why: `port ${port} belongs to someone else: pass a probe port of your own` };
    console.log(`rendering ${spots.length} bare view(s) of ${sceneId} on :${port} (scope ${scope} m) ...`);
    const r = await runCapped([...TSX, "tools/light-shots.mts", "--scene", sceneId, "--spots", spotsFile, "--times", "12", "--no-refs", "--weather-settle", "4", "--out", tmp, "--port", port, "--scope", String(scope), "--spot-timeout", ctx.opt("spot-timeout", "240")], 20 * 60_000, path.join(tmp, "shots.log"));
    const dir = path.join(tmp, sceneId), files: Record<string, string> = {};
    for (const v of views) { const f = exists(dir) ? fs.readdirSync(dir).find((n) => n.startsWith(`${v.name}-`) && n.endsWith(".png")) : undefined; if (f) files[v.name] = path.join(dir, f); }
    const lost = views.filter((v) => !files[v.name]).map((v) => v.name);
    if (lost.length) return { ok: false, why: `light-shots exit ${r.status}${r.timedOut ? " (TIMEOUT)" : ""}, no ${lost.join("/")} frame: ${r.out.split("\n").filter((l) => /STOP|Error|TIMEOUT|fail/i.test(l)).slice(-4).join(" | ") || r.out.slice(-400)}` };
    // a frame of one flat colour is a render that never drew (2026-10-29 w5-ground: two black 4 KB frames were kept as the
    // bare site on a busy machine); refuse it rather than overwrite the last good render
    for (const [k, f] of Object.entries(files)) if (blankFrame(f)) return { ok: false, why: `the ${k} frame is blank (one flat colour): the scene never drew — retry on a quieter machine or raise --spot-timeout` };
    // ... and one whose ground never streamed in (sky over the sea plane; 2026-10-29 w6, tools/_far-camera.mts groundSpread)
    for (const [k, f] of Object.entries(files)) { const g = groundSpread(decodePng(fs.readFileSync(f)) as Img, k === "sea" || overWater.has(k) ? 0.3 : 0.6); if (g < GROUNDLESS_STD) return { ok: false, why: `the ${k} frame shows no ground (lower-frame luma spread ${g.toFixed(1)} < ${GROUNDLESS_STD}): the terrain never streamed — retry` }; }
    // copy out before the temp folder goes
    const keep = fs.mkdtempSync(path.join(os.tmpdir(), "concept-frames-"));
    for (const [k, f] of Object.entries(files)) { const to = path.join(keep, `${k}.png`); fs.copyFileSync(f, to); files[k] = to; }
    return { ok: true, files, bare };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
    if (scratch && !ctx.flag("keep-bare")) fs.rmSync(scratch, { recursive: true, force: true });
  }
}


const VIEW_MARK: Record<ViewName, { letter: string; col: number[] }> = {
  approach: { letter: "A", col: [255, 230, 60] }, far: { letter: "F", col: [90, 220, 255] },
  gate: { letter: "G", col: [255, 150, 20] }, street: { letter: "S", col: [255, 255, 255] }, square: { letter: "Q", col: [40, 230, 255] },
  sea: { letter: "W", col: [120, 160, 255] }, shelf: { letter: "B", col: [255, 120, 200] },
};
/** The plan-map crop: hillshaded bare ground, water, roads, the reservation (radius solid, terrain radius dashed), the
 *  approach points, a town's stakes, and every camera with its view line. North up. */
function planCrop(g: { height(x: number, z: number): number; waterY(x: number, z: number): number | null }, raw: J, c: V2, radius: number, terrainRadius: number, approachPts: V2[], roads: V2[][], views: View[], plan: TownPlan | null): [number, number, Uint8Array] {
  const N = 640, pts: V2[] = [[c[0] - terrainRadius, c[1] - terrainRadius], [c[0] + terrainRadius, c[1] + terrainRadius], ...views.map((v) => [v.eye[0], v.eye[2]] as V2)];
  const x0 = Math.min(...pts.map((p) => p[0])), x1 = Math.max(...pts.map((p) => p[0])), z0 = Math.min(...pts.map((p) => p[1])), z1 = Math.max(...pts.map((p) => p[1]));
  const span = Math.max(x1 - x0, z1 - z0) * 1.15, cx = (x0 + x1) / 2, cz = (z0 + z1) / 2, m = span / N, ox = cx - span / 2, oz = cz - span / 2;
  const px = (p: V2): V2 => [(p[0] - ox) / m, (p[1] - oz) / m];
  const rgba = new Uint8Array(N * N * 4);
  const hs = new Float32Array(N * N);
  let lo = Infinity, hi = -Infinity;
  for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) { const h = g.height(ox + (i + 0.5) * m, oz + (j + 0.5) * m); hs[j * N + i] = h; lo = Math.min(lo, h); hi = Math.max(hi, h); }
  for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
    const h = hs[j * N + i]!, hx = (hs[j * N + Math.min(N - 1, i + 1)]! - hs[j * N + Math.max(0, i - 1)]!) / (2 * m), hz = (hs[Math.min(N - 1, j + 1) * N + i]! - hs[Math.max(0, j - 1) * N + i]!) / (2 * m);
    const shade = Math.max(0.25, Math.min(1.2, 0.8 + (-hx * 0.6 - hz * 0.6) / Math.hypot(1, hx, hz)));
    const t = (h - lo) / Math.max(1, hi - lo), steep = Math.hypot(hx, hz) > 1;
    let col = steep ? [120, 112, 104] : [Math.round(90 + 90 * t), Math.round(110 + 70 * t), Math.round(70 + 80 * t)];
    const wy = g.waterY(ox + (i + 0.5) * m, oz + (j + 0.5) * m);
    if (wy !== null && wy > h + 0.2) col = [52, 88, 128];
    const k = (j * N + i) * 4;
    rgba[k] = Math.min(255, col[0]! * shade); rgba[k + 1] = Math.min(255, col[1]! * shade); rgba[k + 2] = Math.min(255, col[2]! * shade); rgba[k + 3] = 255;
  }
  const dot = (x: number, y: number, col: number[], r = 1) => { for (let a = -r; a <= r; a++) for (let b = -r; b <= r; b++) { const X = Math.round(x + a), Y = Math.round(y + b); if (X < 0 || Y < 0 || X >= N || Y >= N) continue; const k = (Y * N + X) * 4; rgba[k] = col[0]!; rgba[k + 1] = col[1]!; rgba[k + 2] = col[2]!; } };
  const line = (a: V2, b: V2, col: number[], r = 0, dash = 0) => { const L = Math.hypot(b[0] - a[0], b[1] - a[1]); for (let s = 0; s <= L; s += 0.5) { if (dash && Math.floor(s / dash) % 2) continue; dot(a[0] + ((b[0] - a[0]) * s) / L, a[1] + ((b[1] - a[1]) * s) / L, col, r); } };
  for (const rd of (raw.features?.roads ?? []) as J[]) { const p = (rd.points ?? []).map((q: number[]) => px(xz(q))); for (let k = 0; k + 1 < p.length; k++) line(p[k], p[k + 1], [196, 170, 120]); }
  for (const r of roads) { const p = r.map(px); for (let k = 0; k + 1 < p.length; k++) line(p[k]!, p[k + 1]!, [240, 214, 150], 1); }
  const ring = (rr: number, col: number[], dash: number) => { const pc = px(c); for (let a = 0; a < 720; a++) { const t = (a / 720) * Math.PI * 2; if (dash && Math.floor(a / dash) % 2) continue; dot(pc[0] + (Math.cos(t) * rr) / m, pc[1] + (Math.sin(t) * rr) / m, col, 1); } };
  ring(terrainRadius, [255, 160, 60], 12); ring(radius, [235, 60, 60], 0);
  for (let k = 0; k + 1 < approachPts.length; k++) line(px(approachPts[k]!), px(approachPts[k + 1]!), [255, 255, 255], 1, 4);
  if (plan) for (const s of plan.stakes) { const p = (s.closed ? [...s.points, s.points[0]!] : s.points).map(px); for (let k = 0; k + 1 < p.length; k++) line(p[k]!, p[k + 1]!, STAKE_RGB[s.kind]!, 0); }
  const label = (s: string, x: number, y: number, col: number[]) => drawText(s, Math.round(x), Math.round(y), 2, (X: number, Y: number) => dot(X, Y, col, 0));
  for (const v of views) {
    const e = px([v.eye[0], v.eye[2]]), t = px([v.target[0], v.target[2]]), { letter, col } = VIEW_MARK[v.name];
    line(e, t, col, 0, 6); dot(e[0], e[1], col, 3); label(letter, e[0] + 7, e[1] - 7, col);
  }
  const bar = 100 / m; line([16, N - 20], [16 + bar, N - 20], [255, 255, 255], 1); label("100 M", 20 + bar, N - 27, [255, 255, 255]); label("N", N - 24, 10, [255, 255, 255]);
  return [N, N, rgba];
}

/** bare | painted per view (640 x 360 each, one row per view) over a band of the fit numbers, the plan crop at the right;
 *  a measured extent is outlined on its painted frame. */
function conceptSheet(names: string[], renders: Record<string, string>, frames: Record<string, string>, lines: string[], measured: { extent: J; prior: J } | null): [number, number, Uint8Array] {
  const TW = 640, TH = 360, rows = names.length, BAND = 12 + lines.length * 18, PW = 2 * TH, SW = 2 * TW + PW, SH = rows * TH + BAND;
  const out = new Uint8Array(SW * SH * 4).fill(24);
  for (let k = 3; k < out.length; k += 4) out[k] = 255;
  const blit = (file: string, ox: number, oy: number, w: number, h: number) => {
    if (!exists(file)) return;
    const img = decodePng(fs.readFileSync(file)) as Img, ch = img.data.length / (img.width * img.height);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const sx = Math.floor((x * img.width) / w), sy = Math.floor((y * img.height) / h), s = (sy * img.width + sx) * ch, d = ((oy + y) * SW + ox + x) * 4;
      out[d] = img.data[s]!; out[d + 1] = img.data[s + 1]!; out[d + 2] = img.data[s + 2]!;
    }
  };
  const plot = (col: number[]) => (x: number, y: number) => { if (x < 0 || y < 0 || x >= SW || y >= SH) return; const d = (y * SW + x) * 4; out[d] = col[0]!; out[d + 1] = col[1]!; out[d + 2] = col[2]!; };
  names.forEach((v, row) => {
    blit(renders[v]!, 0, row * TH, TW, TH); blit(frames[v]!, TW, row * TH, TW, TH);
    drawText(`${v} - bare site${(NEAR_VIEWS as readonly string[]).includes(v) ? " (staked)" : ""}`, 8, row * TH + 8, 2, plot([255, 255, 255]));
    drawText(exists(frames[v]!) ? `${v} - concept` : `${v} - not painted`, TW + 8, row * TH + 8, 2, plot([255, 255, 255]));
  });
  if (measured) {
    const row = names.indexOf(measured.extent.view), o = measured.extent.outline as V2[];
    if (row >= 0) for (let k = 0; k < o.length; k++) {
      const a = o[k]!, b = o[(k + 1) % o.length]!, L = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
      for (let t = 0; t <= L; t += 1) for (const [dx, dy] of [[0, 0], [1, 0], [0, 1]]) plot([255, 40, 200])(Math.round(TW + ((a[0] + ((b[0] - a[0]) * t) / L) * TW) / 1280) + dx!, Math.round(row * TH + ((a[1] + ((b[1] - a[1]) * t) / L) * TH) / 720) + dy!);
    }
  }
  blit(renders.plan!, 2 * TW, 0, PW, PW);
  lines.forEach((l, i) => drawText(l.replace(/[^\x20-\x7e]/g, "-").slice(0, 200), 8, rows * TH + 8 + i * 18, 2, plot(i === 0 ? [255, 220, 120] : [220, 220, 220])));
  return [SW, SH, out];
}

/** The sheet, retried: a viewer holding the PNG open (Windows EBUSY / UNKNOWN on open) failed the 2026-10-30 town-1
 *  repaint AFTER Codex had painted, losing the concept-painted record. A last failure warns instead of throwing. */
function writeSheet(file: string, png: Uint8Array): void {
  for (let i = 0; i < 4; i++) {
    try { fs.writeFileSync(file, png); return; } catch (err) {
      if (i === 3) { console.warn(`WARN: could not write ${rel(file)} (${(err as Error).message.slice(0, 120)}): close the viewer and rerun with --measure or --paint-only`); return; }
      const until = Date.now() + 1500; while (Date.now() < until) { /* wait for the holder */ }
    }
  }
}

/**
 * zonegen concept <world> --project <p> --zone <z> --poi <id>   (or --town <name> for a town, zone optional)
 *   [--height <m>] [--port 5317] [--spot-timeout 240] [--renders-only | --paint-only] [--dry-run] [--keep-bare] [--style "..."] [--timeout 1800]
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
 *
 * Gate 16 (tools/poi-review/concept-site.mjs) counts a concept frame only when its request record names one of these
 * renders, for the same reservation, on unchanged ground. Walled towns also get the overlook verdict of
 * `town-wall-line check`. Heavy (world field, a browser): one at a time; never on :5173.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { AssetLibrary, ComponentRegistry, createWorldField, expandScene, PrefabError, registerChunkComponents, registerCoreComponents, worldRecipeSchema, type PrefabDoc, type SceneDoc } from "@hitreg/core";
// @ts-ignore untyped helper module
import { findAsset } from "../../_closure.mjs";
import { runCapped } from "../../_run-capped.mts";
import { tallScatterRules, treeSampler } from "../../worldgen-relief.mts";
import { groundSpread, GROUNDLESS_STD } from "../../_far-camera.mts";
import { approachView, conceptBrief, farView, measureSite, readDistance, type PromptText, type SiteFit, type View } from "../../_concept-site.mts";
// @ts-ignore plain JS engine tool module
import { CONCEPT_TOOL, fileSha, groundFingerprint, ownership, ownsFeature } from "../../../../../tools/poi-review/concept-site.mjs";
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
const rel = (f: string) => path.relative(PG, f).split(path.sep).join("/");
const xz = (p: number[]): V2 => (p.length >= 3 ? [p[0]!, p[2]!] : [p[0]!, p[1]!]);

export async function run(ctx: Ctx): Promise<number> {
  const P = ctx.paths, poiArg = ctx.opt("poi"), townArg = ctx.opt("town");
  if (!poiArg === !townArg) { console.error("zonegen concept: give --poi <reservation location> (with --zone) or --town <name>"); return 2; }
  if (poiArg && !ctx.zone) { console.error("zonegen concept: --poi needs --zone <id>"); return 2; }
  if (!exists(P.recipe)) { console.error(`zonegen concept: no world ${P.recipe}`); return 2; }
  // WORLD ORDER (tools/world-order.mts): paint only on a frozen world, on a sited place; a repaint needs current renders
  const orderKey = (poiArg || townArg)!;
  if (!ctx.flag("dry-run")) {
    const refused = order.requirePlaceStage(P.projectDir, orderKey, "world-frozen", "zonegen concept", ctx.world)
      ?? order.requirePlaceStage(P.projectDir, orderKey, ctx.flag("paint-only") ? "bare-renders" : "sited", "zonegen concept", ctx.world);
    if (refused) { console.error(refused); return 3; }
  }
  const raw = readJson(P.recipe) as J;
  const recipe = worldRecipeSchema.parse(raw);

  // ---- the site: a reservation, or a town ----------------------------------------------------------------------------
  let id: string, center: V2, radius: number, terrainRadius: number, approachPts: V2[] = [], fromIds: string[] = [], entrance = false, outDir: string;
  let size: string | undefined, text: PromptText, townName: string | null = null;
  const brief = ctx.zone ? tryJson(P.brief(ctx.zone)) : null;
  const quests = ctx.zone ? tryJson(P.quests(ctx.zone)) : null;
  if (poiArg) {
    id = poiArg;
    const res = tryJson(P.reservations(ctx.zone));
    const r = (res?.reservations ?? []).find((x: J) => x.location === id);
    if (!r) { console.error(`zonegen concept: no reservation for ${id} in ${P.reservations(ctx.zone)} (zonegen reserve first)`); return 2; }
    center = [r.center[0], r.center[1]]; radius = r.radius; terrainRadius = r.terrainRadius ?? r.radius;
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
  const own = ownership(id, { prefixes: [...new Set([slug(name), ...subSites].filter((s) => s && s !== id).map((s) => `${s}-`))], ids: [...subSites, ...worldOpIds] });
  const bareRaw: J = { ...raw, features: Object.fromEntries(Object.entries(raw.features ?? {}).map(([k, v]) => [k, Array.isArray(v) ? v.filter((f) => !ownsFeature(own, f)) : v])) };
  const ownedFeatures = Object.values(raw.features ?? {}).reduce((n: number, v) => n + (Array.isArray(v) ? v.filter((f) => ownsFeature(own, f)).length : 0), 0);
  const t0 = Date.now();
  const field = createWorldField(worldRecipeSchema.parse(bareRaw));
  console.log(`field: ${((Date.now() - t0) / 1000).toFixed(1)} s (bare: ${ownedFeatures} feature(s) of ${id} left out)`);
  const fit: SiteFit = measureSite(field, center, radius, terrainRadius);
  const roads = fromIds.map((rid) => (raw.features?.roads ?? []).find((r: J) => r.id === rid)).filter(Boolean).map((r: J) => (r.points as number[][]).map(xz));
  // the trees the scatter rules stand on the ground: a sight line through a wood shows trunks, not the site
  const trees = treeSampler(worldRecipeSchema.parse(bareRaw), field);
  const canopy = (x: number, z: number): number => trees.density(x, z);
  const bareRecipe = worldRecipeSchema.parse(bareRaw), tall = treeSampler(bareRecipe, field, undefined, tallScatterRules(bareRecipe));
  const clutter = (x: number, z: number): number => tall.density(x, z);
  const approach = approachView(field, center, height, read, roads, approachPts, canopy, clutter);
  const far = farView(field, center, height, read, [approach.eye[0], approach.eye[2]], canopy, clutter);
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
    `approach: ${approach.from} m, ${approach.px} px — ${approach.note}`,
    `far: ${far.from} m, ${far.px} px — ${far.note}`,
    ...(wall ? [`wall overlook: ${wall}`] : []),
  ];
  console.log(fitLines.map((l) => `  ${l}`).join("\n"));
  fs.mkdirSync(outDir, { recursive: true });
  const file = (s: string) => path.join(outDir, `${id}${s}`);
  const renders = { approach: file("-approach.site.png"), far: file("-far.site.png"), plan: file("-plan.site.png") };
  const frames = { approach: file("-approach.png"), far: file("-far.png") };
  const briefText = conceptBrief(text, fit, height);
  // the two cameras as light-shots spots: a pre-freeze look at the bare site renders them with tools/light-shots.mts --spots
  if (ctx.flag("dry-run")) console.log(`cameras: ${JSON.stringify([approach, far].map((v, i) => ({ name: `${id}-${i ? "far" : "approach"}`, x: Math.round((v.eye[0] + v.target[0]) / 2), z: Math.round((v.eye[2] + v.target[2]) / 2), camera: v.eye, target: v.target, note: v.note })))}`);
  if (ctx.flag("dry-run")) { console.log(`\n--- repaint brief ---\n${briefText}\n--- (dry run: nothing rendered) ---`); return 0; }

  // ---- render the bare site ------------------------------------------------------------------------------------------
  const fpRes = { center, radius, terrainRadius };
  const fingerprint = groundFingerprint(raw, { center, radius: terrainRadius }, own);
  const manifestFile = file(".site.json");
  if (!ctx.flag("paint-only")) {
    fs.writeFileSync(renders.plan, encodePng(...planCrop(field, raw, center, radius, terrainRadius, approachPts, roads, [approach, far])));
    const shot = await renderBare(ctx, id, own, [approach, far], terrainRadius);
    if (!shot.ok) { console.error(`zonegen concept: the bare render failed — ${shot.why}`); return 1; }
    fs.copyFileSync(shot.files.approach!, renders.approach);
    fs.copyFileSync(shot.files.far!, renders.far);
    writeJson(manifestFile, {
      tool: CONCEPT_TOOL, version: 1, poi: id, project: ctx.project, world: ctx.world, zone: ctx.zone || null, town: townName,
      reservation: fpRes, worldFile: rel(P.recipe), ownership: own, fingerprint: fingerprint.hash, featuresUnder: fingerprint.features,
      renderedAt: new Date().toISOString(), bare: shot.bare,
      renders: Object.fromEntries(Object.entries(renders).map(([k, f]) => [k, { file: path.basename(f), sha256: fileSha(f), ...(k === "approach" ? cam(approach) : k === "far" ? cam(far) : {}) }])),
      fit: { ...fit, read, height, approach: { from: approach.from, px: approach.px, note: approach.note }, far: { from: far.from, px: far.px, note: far.note }, wall },
    });
  } else if (!exists(manifestFile) || !exists(renders.approach) || !exists(renders.far)) { console.error(`zonegen concept: --paint-only needs the renders + ${rel(manifestFile)} (run without it first)`); return 2; }
  else {
    const m = readJson(manifestFile) as J;
    if (m.fingerprint !== fingerprint.hash) console.warn(`WARN: the ground under ${id} changed since ${m.renderedAt}: repainting stale renders (gate 16 will refuse them; re-render)`);
  }

  // ---- repaint -------------------------------------------------------------------------------------------------------
  if (!ctx.flag("renders-only")) {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "concept-set-"));
    try {
      const set = {
        brief: briefText,
        images: (["approach", "far"] as const).map((v, i) => ({
          id: `concept-${ctx.world}-${id}-${v}`, target: frames[v], size: `${W}x${H}`, paint: true, ref: [renders[v]], purpose: `concept on site: ${id} ${v} view (gate 16)`,
          prompt: `This frame repaints the ${i === 0 ? "FIRST" : "SECOND"} attached image only: the ${v === "approach" ? `APPROACH view, at player height on the road ${approach.from} m out, where the place first comes into sight` : `FAR view from ${far.from} m: the place's silhouette over its land`}. Same camera, same horizon, same ground.`,
        })),
      };
      const mf = path.join(tmp, "set.json");
      writeJson(mf, set);
      const r = spawnSync(process.execPath, ["tools/image-request.mjs", "gen-set", "--manifest", mf, "--timeout", ctx.opt("timeout", "1800"), "--force", "--requester", "zonegen-concept"], { encoding: "utf8", maxBuffer: 64 << 20, stdio: ["ignore", "pipe", "pipe"] });
      process.stdout.write(r.stdout ?? ""); if (r.status !== 0) { process.stderr.write((r.stderr ?? "").slice(-2000)); console.error("zonegen concept: the repaint failed (renders and manifest kept; --paint-only retries)"); return 1; }
    } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  }
  const sheet = file("-sheet.png");
  fs.writeFileSync(sheet, encodePng(...conceptSheet(renders, frames, fitLines)));
  console.log(`\nconcept on site: ${id}`);
  for (const v of ["approach", "far"] as const) console.log(`  ${v.padEnd(8)} bare ${rel(renders[v])}${exists(frames[v]) ? `  ->  painted ${rel(frames[v])}` : ""}`);
  console.log(`  plan     ${rel(renders.plan)}\n  sheet    ${rel(sheet)}   (open it: judge the painting against the numbers)\n  manifest ${rel(manifestFile)}`);
  if (exists(frames.approach)) console.log(`  design.json: "concept": [${[frames.approach, frames.far].filter(exists).map((f) => `"${rel(f)}"`).join(", ")}]`);
  if (!ctx.flag("paint-only")) { const r = order.recordPlaceStage(P.projectDir, orderKey, "bare-renders", { by: "zonegen concept", evidenceFile: manifestFile }, ctx.world); if (r) console.log(`  ${r}`); }
  if (!ctx.flag("renders-only")) { const r = order.recordPlaceStage(P.projectDir, orderKey, "concept-painted", { by: "zonegen concept", evidenceFile: sheet }, ctx.world); if (r) console.log(`  ${r}`); }
  return 0;
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
async function renderBare(ctx: Ctx, id: string, own: J, views: View[], terrainRadius: number): Promise<{ ok: true; files: Record<string, string>; bare: string } | { ok: false; why: string }> {
  const P = ctx.paths;
  const sceneFile = path.join(P.projectDir, "assets", "scenes", `${ctx.world}.scene.json`);
  if (!exists(sceneFile)) return { ok: false, why: `no scene ${sceneFile}` };
  const scene = readJson(sceneFile) as J;
  const mine = new Set(Object.entries(scene.entities ?? {}).filter(([eid, e]: [string, any]) => (e.tags ?? []).some((t: string) => t === `poi:${id}` || own.ids.includes(t.replace(/^poi:/, ""))) || eid.startsWith(`dress-${id}-`)).map(([eid]) => eid));
  for (let grew = true; grew;) { grew = false; for (const [k, e] of Object.entries(scene.entities ?? {}) as [string, any][]) if (e.parent && mine.has(e.parent) && !mine.has(k)) { mine.add(k); grew = true; } }
  const raw = readJson(P.recipe) as J;
  const ownedF = Object.values(raw.features ?? {}).reduce((n: number, v) => n + (Array.isArray(v) ? v.filter((f) => ownsFeature(own, f)).length : 0), 0);
  // L (dogfood 2026-10-29: proving's live scene no longer boots, a merchant-cart instance override names a path its
  // prefab lost): an instance that does not expand would fail the whole bare render, so it is left out of the copy
  const broken = brokenInstances(scene, ctx.project, mine);
  let sceneId = ctx.world, scratch: string | null = null, bare = "live scene (the place has no features or entities yet)";
  if (mine.size || ownedF || broken.size) {
    for (const b of broken) mine.add(b);
    for (let grew = true; grew;) { grew = false; for (const [k, e] of Object.entries(scene.entities ?? {}) as [string, any][]) if (e.parent && mine.has(e.parent) && !mine.has(k)) { mine.add(k); grew = true; } }
    // a scratch copy like place-build's lab: the world minus the place's features, the scene minus its entities
    const lab = `concept-${id}`, labWorld = `concept${id.replace(/[^a-z0-9]/gi, "")}`;
    scratch = path.join(PG, "projects", lab);
    const pj = readJson(path.join(P.projectDir, "project.json")) as J;
    writeJson(path.join(scratch, "project.json"), { version: 1, name: lab, title: `concept on site: ${id} (scratch)`, description: `Scratch bare copy of ${ctx.world} for zonegen concept ${id}; deleted after the run.`, group: "Worlds", menuOrder: 99,
      scenes: [{ id: labWorld, label: `concept ${id}`, variants: [] }], engine: pj.engine ?? "^0.1", multiplayer: pj.multiplayer ?? "server", tools: [], dependsOn: [...new Set([...(pj.dependsOn ?? []), ctx.project])] });
    writeJson(path.join(scratch, "assets", "worlds", `${labWorld}.json`), { ...raw, features: Object.fromEntries(Object.entries(raw.features ?? {}).map(([k, v]) => [k, Array.isArray(v) ? v.filter((f) => !ownsFeature(own, f)) : v])) });
    const tdir = path.join(P.projectDir, "assets", "materials", "terrain"), tout = path.join(scratch, "assets", "materials", "terrain");
    if (exists(tdir)) { fs.mkdirSync(tout, { recursive: true }); for (const f of fs.readdirSync(tdir).filter((f) => f === `${ctx.world}.json` || f.startsWith(`${ctx.world}-`))) fs.copyFileSync(path.join(tdir, f), path.join(tout, labWorld + f.slice(ctx.world.length))); }
    const s = JSON.parse(JSON.stringify(scene));
    for (const eid of mine) delete s.entities[eid];
    for (const e of Object.values(s.entities) as any[]) if (e.components?.voxelWorld) e.components.voxelWorld.world = labWorld;
    s.name = `concept ${id}`;
    writeJson(path.join(scratch, "assets", "scenes", `${labWorld}.scene.json`), s);
    sceneId = labWorld;
    bare = `scratch copy: ${ownedF} feature(s) and ${mine.size - broken.size} entit(ies) of ${id} taken out${broken.size ? `; ${broken.size} instance(s) that do not expand left out (${[...broken].slice(0, 3).join(", ")})` : ""}`;
    if (broken.size) console.log(`WARN: ${broken.size} prefab instance(s) of the live scene do not expand (left out of the bare copy): ${[...broken].slice(0, 5).join(", ")}`);
  }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "concept-shots-"));
  try {
    const spots = views.map((v) => ({ name: v.name, x: Math.round((v.eye[0] + v.target[0]) / 2), z: Math.round((v.eye[2] + v.target[2]) / 2), camera: v.eye, target: v.target }));
    const spotsFile = path.join(tmp, "spots.json");
    writeJson(spotsFile, spots);
    const scope = Math.round(Math.max(...views.map((v) => Math.hypot(v.eye[0] - v.target[0], v.eye[2] - v.target[2]) / 2)) + terrainRadius + 150);
    const port = ctx.opt("port", "5317");
    if (["5173", "5287", "5291", "5293"].includes(port)) return { ok: false, why: `port ${port} belongs to someone else: pass a probe port of your own` };
    console.log(`rendering ${spots.length} bare view(s) of ${sceneId} on :${port} (scope ${scope} m) ...`);
    const r = await runCapped([...TSX, "tools/light-shots.mts", "--scene", sceneId, "--spots", spotsFile, "--times", "12", "--no-refs", "--weather-settle", "4", "--out", tmp, "--port", port, "--scope", String(scope), "--spot-timeout", ctx.opt("spot-timeout", "240")], 20 * 60_000, path.join(tmp, "shots.log"));
    const dir = path.join(tmp, sceneId), files: Record<string, string> = {};
    for (const v of views) { const f = exists(dir) ? fs.readdirSync(dir).find((n) => n.startsWith(`${v.name}-`) && n.endsWith(".png")) : undefined; if (f) files[v.name] = path.join(dir, f); }
    if (!files.approach || !files.far) return { ok: false, why: `light-shots exit ${r.status}${r.timedOut ? " (TIMEOUT)" : ""}: ${r.out.split("\n").filter((l) => /STOP|Error|TIMEOUT|fail/i.test(l)).slice(-4).join(" | ") || r.out.slice(-400)}` };
    // a frame of one flat colour is a render that never drew (2026-10-29 w5-ground: two black 4 KB frames were kept as the
    // bare site on a busy machine); refuse it rather than overwrite the last good render
    for (const [k, f] of Object.entries(files)) if (blankFrame(f)) return { ok: false, why: `the ${k} frame is blank (one flat colour): the scene never drew — retry on a quieter machine or raise --spot-timeout` };
    // ... and one whose ground never streamed in (sky over the sea plane; 2026-10-29 w6, tools/_far-camera.mts groundSpread)
    for (const [k, f] of Object.entries(files)) { const g = groundSpread(decodePng(fs.readFileSync(f)) as Img); if (g < GROUNDLESS_STD) return { ok: false, why: `the ${k} frame shows no ground (lower-frame luma spread ${g.toFixed(1)} < ${GROUNDLESS_STD}): the terrain never streamed — retry` }; }
    // copy out before the temp folder goes
    const keep = fs.mkdtempSync(path.join(os.tmpdir(), "concept-frames-"));
    for (const [k, f] of Object.entries(files)) { const to = path.join(keep, `${k}.png`); fs.copyFileSync(f, to); files[k] = to; }
    return { ok: true, files, bare };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
    if (scratch && !ctx.flag("keep-bare")) fs.rmSync(scratch, { recursive: true, force: true });
  }
}

/** The plan-map crop: hillshaded bare ground, water, roads, the reservation (radius solid, terrain radius dashed), the
 *  approach points and both cameras with their view lines. North up. */
function planCrop(g: { height(x: number, z: number): number; waterY(x: number, z: number): number | null }, raw: J, c: V2, radius: number, terrainRadius: number, approachPts: V2[], roads: V2[][], views: View[]): [number, number, Uint8Array] {
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
  const label = (s: string, x: number, y: number, col: number[]) => drawText(s, Math.round(x), Math.round(y), 2, (X: number, Y: number) => dot(X, Y, col, 0));
  for (const v of views) {
    const e = px([v.eye[0], v.eye[2]]), t = px([v.target[0], v.target[2]]), col = v.name === "approach" ? [255, 230, 60] : [90, 220, 255];
    line(e, t, col, 0, 6); dot(e[0], e[1], col, 4); label(v.name === "approach" ? "A" : "F", e[0] + 7, e[1] - 7, col);
  }
  const bar = 100 / m; line([16, N - 20], [16 + bar, N - 20], [255, 255, 255], 1); label("100 M", 20 + bar, N - 27, [255, 255, 255]); label("N", N - 24, 10, [255, 255, 255]);
  return [N, N, rgba];
}

/** bare | painted per view (640 x 360 each) over a band of the fit numbers, the plan crop at the right. */
function conceptSheet(renders: Record<string, string>, frames: Record<string, string>, lines: string[]): [number, number, Uint8Array] {
  const TW = 640, TH = 360, BAND = 12 + lines.length * 18, PW = 2 * TH, SW = 2 * TW + PW, SH = 2 * TH + BAND;
  const out = new Uint8Array(SW * SH * 4).fill(24);
  for (let k = 3; k < out.length; k += 4) out[k] = 255;
  const blit = (file: string, ox: number, oy: number, w: number, h: number) => {
    if (!exists(file)) return;
    const img = decodePng(fs.readFileSync(file)) as Img;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const sx = Math.floor((x * img.width) / w), sy = Math.floor((y * img.height) / h), s = (sy * img.width + sx) * 4, d = ((oy + y) * SW + ox + x) * 4;
      out[d] = img.data[s]!; out[d + 1] = img.data[s + 1]!; out[d + 2] = img.data[s + 2]!;
    }
  };
  const plot = (col: number[]) => (x: number, y: number) => { if (x < 0 || y < 0 || x >= SW || y >= SH) return; const d = (y * SW + x) * 4; out[d] = col[0]!; out[d + 1] = col[1]!; out[d + 2] = col[2]!; };
  (["approach", "far"] as const).forEach((v, row) => {
    blit(renders[v]!, 0, row * TH, TW, TH); blit(frames[v]!, TW, row * TH, TW, TH);
    drawText(`${v} - bare site`, 8, row * TH + 8, 2, plot([255, 255, 255]));
    drawText(exists(frames[v]!) ? `${v} - concept` : `${v} - not painted`, TW + 8, row * TH + 8, 2, plot([255, 255, 255]));
  });
  blit(renders.plan!, 2 * TW, 0, PW, PW > 2 * TH ? 2 * TH : PW);
  lines.forEach((l, i) => drawText(l.replace(/[^\x20-\x7e]/g, "-").slice(0, 200), 8, 2 * TH + 8 + i * 18, 2, plot(i === 0 ? [255, 220, 120] : [220, 220, 220])));
  return [SW, SH, out];
}

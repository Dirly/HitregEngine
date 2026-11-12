/**
 * THE EXTERIOR CHAIN — every dungeon door and painted outdoor place is built off its LOCATION, in this order, and every
 * exterior build path refuses until the chain is complete (Derek 2026-11-10, Rustgut: "you need to always build it off of
 * a location, a screen grab of that location ... create a system that verifies these steps are rigidly followed"; then
 * "I don't need to approve it ... you just need to have the steps in place ... you follow the recipe to a T"):
 *
 *   location  the reservation (zones/<z>/reservations.json) the place is sited at; in a staged world its `sited` record
 *             stands at the same centre
 *   grab      `zonegen concept --renders-only`: the bare render of the site with NO edits of the place (concept-site.mjs
 *             uneditedRecipe: its needs, need patches, operators and their pieces, landmarks, clearings, roads made for
 *             it, entities). Its manifest (<zone>/concept/<id>.site.json) carries the `unedited` stamp, and the unedited
 *             ground under the reservation is still that stamp now
 *   concepts  `zonegen concept --paint-only`: the painted frames <id>-<view>.png, each an image-request repaint of one of
 *             THOSE renders (gate 16, conceptSiteFault)
 *   check     `zonegen concept-check`: the automated concept check — frames painted from the current grabs, the reviewer
 *             sheet <id>-sheet.png written after them, and ONE frame picked as the build target (by sha256). It writes
 *             the record into projects/<p>/authoring/exterior/<world>.json `checks.<id>`; the record goes STALE when a
 *             frame, the sheet or the unedited ground changes
 *   build     only now: worldgen needs / op / landmark bakes for the place, vegetation clearings, place-build install,
 *             a site install.mts, dress apply, populate site packs, portal installs into the world scene
 *
 * Enforced places: a staged place (authoring/stages/<world>.json) that is painted (not catalogue) and not a town, or an
 * unstaged reservation that is an entrance / instanced door. A place passes on its complete chain, or on a GRANDFATHER
 * ruling recorded in the exterior file (places shipped before the chain existed). The one escape hatch for a build
 * command is an OWNER ruling: `--no-concept-ruling "YYYY-MM-DD <Derek's words, verbatim>"` (or env
 * HITREG_NO_CONCEPT_RULING), recorded with the command in the exterior file's `rulings`.
 *
 * Plain JS (node tools, tsx tools and the dungeon pipeline share it); no world field.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CONCEPT_TOOL, conceptSiteFault, fileSha, hasToken, ownership, ownsFeature, uneditedStamp, UNEDITED_RULE } from "./concept-site.mjs";

export const PLAYGROUND = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "apps", "playground");
export const RULING_FLAG = "--no-concept-ruling";
export const RULING_ENV = "HITREG_NO_CONCEPT_RULING";
export const CHAIN_STEPS = ["location", "grab", "concepts", "check"];

const readJson = (f) => JSON.parse(fs.readFileSync(f, "utf8").replace(/^﻿/, ""));
const tryJson = (f) => { try { return fs.existsSync(f) ? readJson(f) : null; } catch { return null; } };
const rel = (from, f) => path.relative(from, f).split(path.sep).join("/");
export function stable(v) {
  if (Array.isArray(v)) return `[${v.map(stable).join(",")}]`;
  if (v && typeof v === "object") return `{${Object.keys(v).sort().filter((k) => v[k] !== undefined).map((k) => `${JSON.stringify(k)}:${stable(v[k])}`).join(",")}}`;
  return JSON.stringify(v);
}
const DATED = /^\s*20\d\d-\d\d-\d\d\b/;
export const isDatedRuling = (s) => typeof s === "string" && DATED.test(s) && s.replace(DATED, "").trim().length >= 8;

// ------------------------------------------------------------------ places

export const zonegenDir = (projectDir, world) => path.join(projectDir, "authoring", "zonegen", world);
export const exteriorFile = (projectDir, world) => path.join(projectDir, "authoring", "exterior", `${world}.json`);
export const recipeFileOf = (projectDir, world) => path.join(projectDir, "assets", "worlds", `${world}.json`);

/** Every reservation of every zone of a world, with its zone. */
export function reservationsOf(projectDir, world) {
  const zdir = path.join(zonegenDir(projectDir, world), "zones");
  if (!fs.existsSync(zdir)) return [];
  const out = [];
  for (const z of fs.readdirSync(zdir).sort()) {
    const doc = tryJson(path.join(zdir, z, "reservations.json"));
    for (const r of doc?.reservations ?? []) if (r && typeof r.location === "string" && Array.isArray(r.center)) out.push({ ...r, zone: z });
  }
  return out;
}
/** The art mode of a staged place (world-order.mts artOf). */
export const artOf = (p) => p.art ?? (p.kind === "poi" && /small|roadside|camp/.test(p.role ?? "") ? "catalogue" : "painted");

/** The places of a world, each { id, zone, kind, center, radius, terrainRadius, reservation, stage, enforced }. */
export function exteriorPlaces(projectDir, world) {
  const stages = tryJson(path.join(projectDir, "authoring", "stages", `${world}.json`));
  const out = [];
  for (const r of reservationsOf(projectDir, world)) {
    if (out.some((p) => p.id === r.location)) continue;
    const sp = (stages?.places ?? []).find((p) => p.id === r.location) ?? null;
    const enforced = sp ? sp.kind !== "town" && artOf(sp) === "painted" : !!(r.entrance || r.interior === "instanced");
    out.push({ id: r.location, zone: r.zone, kind: sp?.kind ?? (r.entrance || r.interior === "instanced" ? "entrance" : "poi"), center: [r.center[0], r.center[1]], radius: r.radius ?? 0,
      terrainRadius: Math.max(r.radius ?? 0, r.terrainRadius ?? 0), reservation: r, stage: sp, enforced });
  }
  return out;
}

/**
 * What the place owns in a recipe (concept-site.mjs ownership + the derived edits): its needs (`for` / `poi` / `owner`
 * = the place, or an id `<place>-...`) and their patches (`need-<id>`, `solved.patch`), its operators (by the ownership
 * rules, the token rule included) with every compiled piece, `dress-<place>-` dressing clearings, `woodland-keep-<place>`,
 * and the TOKEN rule (the place id as a whole token of a feature id, for a feature reaching the site). A reservation may
 * name more (`owns`, `ownsPrefixes`) or fewer (`disowns`) when the names do not say it.
 */
export function placeOwnership(recipe, place, extra = {}) {
  const id = place.id, r = place.reservation ?? {};
  const needs = (Array.isArray(recipe?.needs) ? recipe.needs : []).filter((n) => n && (n.for === id || n.poi === id || n.owner === id || String(n.id ?? "").startsWith(`${id}-`)));
  const needPatches = needs.flatMap((n) => [`need-${n.id}`, n.solved?.patch].filter((x) => typeof x === "string" && x));
  const base = ownership(id, { prefixes: [`dress-${id}-`, ...(extra.prefixes ?? []), ...(r.ownsPrefixes ?? [])], ids: [`woodland-keep-${id}`, ...needPatches, ...(extra.ids ?? []), ...(r.owns ?? [])] });
  const own = { ...base, needs: needs.map((n) => n.id).sort(), tokens: [id], near: { center: place.center, r: (place.terrainRadius ?? place.radius ?? 0) + 100 }, disowns: [...(r.disowns ?? [])].sort(), operators: [] };
  for (const o of recipe?.features?.operators ?? []) {
    if (!ownsFeature(own, o)) continue;
    own.operators.push(o.id);
    own.prefixes.push(`op:${o.id}:`);
    for (const p of o.compiled?.pieces ?? []) { const pid = String(p).split("/").slice(1).join("/"); if (pid) own.ids.push(pid); }
  }
  own.prefixes = [...new Set(own.prefixes)].sort();
  own.ids = [...new Set(own.ids)].sort();
  own.operators.sort();
  return own;
}

/** The place a recipe feature / need / operator belongs to (first enforced-or-not place that owns it), or null. */
export function placeOfFeature(recipe, places, f, { strong = false } = {}) {
  for (const p of places) if (ownsFeature(placeOwnership(recipe, p), f, { strong })) return p;
  return null;
}

// ------------------------------------------------------------------ the exterior file

export function loadExterior(projectDir, world) {
  const doc = tryJson(exteriorFile(projectDir, world));
  return { version: 1, world, project: path.basename(projectDir), checks: {}, rulings: [], ...(doc ?? {}) };
}
export function saveExterior(projectDir, doc) {
  const f = exteriorFile(projectDir, doc.world);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  // overwritten in place (git is the history)
  fs.writeFileSync(f, JSON.stringify(doc, null, 1) + "\n");
}
export const grandfatherOf = (doc, placeId) => (doc.rulings ?? []).find((r) => r.place === placeId && r.kind === "grandfather") ?? null;

// ------------------------------------------------------------------ the chain

export const conceptDirOf = (projectDir, world, place) => path.join(zonegenDir(projectDir, world), "zones", place.zone ?? "", "concept");
export const manifestOf = (projectDir, world, place) => path.join(conceptDirOf(projectDir, world, place), `${place.id}.site.json`);
export const sheetOf = (projectDir, world, place) => path.join(conceptDirOf(projectDir, world, place), `${place.id}-sheet.png`);
/** The painted frames a manifest's views name (<id>-<view>.png beside it) that exist. */
export function framesOf(projectDir, world, place, manifest) {
  const dir = conceptDirOf(projectDir, world, place);
  return Object.keys(manifest?.renders ?? {}).filter((v) => v !== "plan").map((v) => path.join(dir, `${place.id}-${v}.png`)).filter((f) => fs.existsSync(f));
}

/**
 * The chain of one place: rows { step, state: ok | MISSING | STALE | BLOCKED, why, how } in CHAIN_STEPS order, the first
 * not-ok row (`next`), and `ok`. `opts.recipe`: the parsed or raw recipe (read from the world file when absent).
 */
export function exteriorChain(projectDir, world, placeId, opts = {}) {
  const project = path.basename(projectDir);
  const place = exteriorPlaces(projectDir, world).find((p) => p.id === placeId) ?? null;
  const zone = place?.zone ?? "<zone>";
  const zg = (cmd, tail = "") => `npx tsx tools/zonegen.mts ${cmd} ${world} --project ${project} --zone ${zone} --poi ${placeId}${tail}`;
  const rows = [];
  const push = (step, state, why, how) => rows.push({ step, state, why, how });
  const blockRest = (from) => { for (const s of CHAIN_STEPS.slice(CHAIN_STEPS.indexOf(from) + 1)) push(s, "BLOCKED", `${from} is not ok`, ""); };
  const done = () => { const next = rows.find((r) => r.state !== "ok") ?? null; return { place, rows, next, ok: !next }; };
  const howFor = {
    location: `site it: zonegen reserve ${world} --project ${project} --zone <z> (site-finder skill), then zonegen stages ${world} --project ${project} --site ${placeId} --kind poi|entrance --role <role> --zone <z> --by <agent>`,
    grab: zg("concept", " --renders-only"),
    concepts: zg("concept", " --paint-only"),
    check: zg("concept-check", " --target <zone>/concept/<id>-<view>.png"),
  };

  // 1. location
  if (!place) { push("location", "MISSING", `no reservation "${placeId}" in any zone of ${world}`, howFor.location); blockRest("location"); return done(); }
  const sited = place.stage?.stages?.sited;
  if (place.stage && !sited) { push("location", "MISSING", `${placeId} is reserved but not sited in authoring/stages/${world}.json`, howFor.location); blockRest("location"); return done(); }
  if (sited?.site && Math.hypot(sited.site.center[0] - place.center[0], sited.site.center[1] - place.center[1]) > 0.5) { push("location", "STALE", `the reservation moved since it was sited ([${sited.site.center}] -> [${place.center}])`, howFor.location); blockRest("location"); return done(); }
  push("location", "ok", `reserved at [${place.center}] r ${place.radius} (zone ${place.zone})`, howFor.location);

  // 2. the unedited grab
  const mf = manifestOf(projectDir, world, place), m = tryJson(mf);
  const recipeRaw = opts.recipe ?? tryJson(recipeFileOf(projectDir, world));
  let stamp = null;
  const grabWhy = (() => {
    if (!m || m.tool !== CONCEPT_TOOL) return [`MISSING`, `no bare render manifest ${rel(projectDir, mf)}`];
    if (m.poi !== placeId) return ["STALE", `${rel(projectDir, mf)} is of ${m.poi}`];
    if (m.unedited?.rule !== UNEDITED_RULE) return ["STALE", `the bare render (${m.renderedAt ?? "?"}) was made before the unedited-ground rule (2026-11-10): it may show the place's own stamped terrain`];
    const c = m.reservation?.center;
    if (!Array.isArray(c) || Math.hypot(c[0] - place.center[0], c[1] - place.center[1]) > 1 || Math.abs((m.reservation.radius ?? 0) - place.radius) > 1) return ["STALE", `the reservation moved since the bare render ([${c}] r ${m.reservation?.radius} then, [${place.center}] r ${place.radius} now)`];
    for (const [v, r] of Object.entries(m.renders ?? {})) {
      const f = path.join(path.dirname(mf), r?.file ?? "");
      if (!r?.file || !fs.existsSync(f)) return ["STALE", `render ${v} (${r?.file}) is gone`];
      if (r.sha256 && fileSha(f) !== r.sha256) return ["STALE", `render ${r.file} changed since the manifest was written`];
    }
    if (!recipeRaw) return ["STALE", `the world ${world} cannot be read`];
    stamp = uneditedStamp(recipeRaw, { center: m.reservation.center, radius: m.reservation.terrainRadius ?? m.reservation.radius }, m.ownership ?? placeOwnership(recipeRaw, place));
    if (stamp.fingerprint !== m.unedited.fingerprint) {
      const moved = [stamp.parts.global !== m.unedited.parts?.global ? "the global ground fields" : "", stamp.parts.near !== m.unedited.parts?.near ? "the world features under the reservation" : ""].filter(Boolean);
      return ["STALE", `the unedited ground under ${placeId} changed since the bare render (${m.renderedAt})${moved.length ? `: ${moved.join(" and ")}` : ""}`];
    }
    return null;
  })();
  if (grabWhy) { push("grab", grabWhy[0], grabWhy[1], howFor.grab); blockRest("grab"); return done(); }
  push("grab", "ok", `unedited render ${m.renderedAt}, ${m.unedited.excluded?.length ?? 0} edit(s) of ${placeId} left out`, howFor.grab);

  // 3. concepts painted from those grabs
  const frames = framesOf(projectDir, world, place, m);
  if (!frames.length) { push("concepts", "MISSING", `no painted frame beside ${rel(projectDir, mf)} (${Object.keys(m.renders ?? {}).filter((v) => v !== "plan").map((v) => `${placeId}-${v}.png`).join(", ")})`, howFor.concepts); blockRest("concepts"); return done(); }
  const site = { poi: placeId, zoneDir: path.join(zonegenDir(projectDir, world), "zones", place.zone), reservation: place.reservation };
  const faults = frames.map((f) => conceptSiteFault(f, site, opts.playground ?? PLAYGROUND)).filter(Boolean);
  if (faults.length) { push("concepts", "STALE", faults[0] + (faults.length > 1 ? ` (+${faults.length - 1} more frame(s))` : ""), howFor.concepts); blockRest("concepts"); return done(); }
  push("concepts", "ok", `${frames.length} frame(s) painted from the current grabs`, howFor.concepts);

  // 4. the concept check record
  const doc = opts.exterior ?? loadExterior(projectDir, world), rec = doc.checks?.[placeId];
  const checkWhy = (() => {
    if (!rec) return ["MISSING", "no concept check recorded"];
    if (rec.unedited !== m.unedited.fingerprint) return ["STALE", "the bare render was re-made since the check"];
    for (const [f, sha] of Object.entries(rec.frames ?? {})) {
      const full = path.resolve(projectDir, f);
      if (!fs.existsSync(full)) return ["STALE", `checked frame ${f} is gone`];
      if (fileSha(full) !== sha) return ["STALE", `checked frame ${f} was repainted since the check`];
    }
    const sheet = path.resolve(projectDir, rec.sheet?.file ?? "");
    if (!rec.sheet?.file || !fs.existsSync(sheet) || fileSha(sheet) !== rec.sheet.sha256) return ["STALE", `the reviewer sheet ${rec.sheet?.file ?? "?"} changed or is gone since the check`];
    if (!rec.target?.file || rec.frames?.[rec.target.file] !== rec.target.sha256) return ["STALE", "the check names no target frame among its frames"];
    return null;
  })();
  if (checkWhy) { push("check", checkWhy[0], checkWhy[1], howFor.check); return done(); }
  push("check", "ok", `checked ${rec.at}, target ${path.basename(rec.target.file)}`, howFor.check);
  return done();
}

/**
 * THE CONCEPT CHECK (step 4, automated; `zonegen concept-check` runs it): steps 1-3 ok, the reviewer sheet
 * <id>-sheet.png written after every frame (and, when `paintedSheetSha` is given, the very sheet the world order recorded
 * as painted), ONE target frame picked (`target`: a path, or the design's `conceptTarget` string / { file, sha256 }).
 * Returns { ok: true, rec } (the record to keep) or { ok: false, code: 2 | 3, error }.
 */
export function conceptCheck({ projectDir, world, placeId, target = "", design = null, paintedSheetSha = null, playground }) {
  const chain = exteriorChain(projectDir, world, placeId, { playground });
  const before = chain.rows.filter((r) => r.step !== "check").find((r) => r.state !== "ok");
  if (before) return { ok: false, code: 3, chain, error: `concept-check refused: ${before.step} is ${before.state}${before.why ? ` (${before.why})` : ""}\n  do it: ${before.how}   (from apps/playground)` };
  const place = chain.place, mf = manifestOf(projectDir, world, place), m = tryJson(mf);
  const frames = framesOf(projectDir, world, place, m);
  const sheet = sheetOf(projectDir, world, place);
  if (!fs.existsSync(sheet)) return { ok: false, code: 3, chain, error: `concept-check refused: no reviewer sheet ${rel(projectDir, sheet)} — ${chain.rows.find((r) => r.step === "concepts").how} writes it` };
  const sheetAt = fs.statSync(sheet).mtimeMs, late = frames.filter((f) => fs.statSync(f).mtimeMs > sheetAt + 1000);
  if (late.length) return { ok: false, code: 3, chain, error: `concept-check refused: ${late.map((f) => path.basename(f)).join(", ")} painted after the reviewer sheet — re-compose it: ${chain.rows.find((r) => r.step === "grab").how}` };
  const sheetSha = fileSha(sheet);
  if (paintedSheetSha && paintedSheetSha !== sheetSha) return { ok: false, code: 3, chain, error: `concept-check refused: ${rel(projectDir, sheet)} is not the sheet the world order recorded as painted — re-run the painting step` };
  const want = target || (typeof design?.conceptTarget === "string" ? design.conceptTarget : design?.conceptTarget?.file) || "";
  const list = frames.map((f) => `  ${rel(projectDir, f)}`).join("\n");
  if (!want) return { ok: false, code: 2, chain, error: `concept-check: pick ONE frame as the build target: --target <frame> (or the design's "conceptTarget"); frames:\n${list}` };
  const cands = [path.resolve(want), path.resolve(projectDir, want), path.join(path.dirname(sheet), path.basename(want))].map((c) => c.toLowerCase());
  const t = frames.find((f) => cands.includes(path.resolve(f).toLowerCase()));
  if (!t) return { ok: false, code: 2, chain, error: `concept-check: target ${want} is not one of the place's frames:\n${list}` };
  if (design?.conceptTarget?.sha256 && design.conceptTarget.sha256 !== fileSha(t)) return { ok: false, code: 3, chain, error: `concept-check refused: the design's conceptTarget sha256 does not match ${path.basename(t)} (repainted since the design picked it)` };
  const rec = {
    at: new Date().toISOString(), by: "zonegen concept-check",
    unedited: m.unedited.fingerprint, excluded: m.unedited.excluded ?? [],
    manifest: { file: rel(projectDir, mf), renderedAt: m.renderedAt },
    frames: Object.fromEntries(frames.map((f) => [rel(projectDir, f), fileSha(f)])),
    sheet: { file: rel(projectDir, sheet), sha256: sheetSha },
    target: { file: rel(projectDir, t), sha256: fileSha(t) },
  };
  return { ok: true, chain, rec, frames, sheet, target: t };
}
/** Keep a concept check record (overwrites the place's previous one). */
export function writeConceptCheck(projectDir, world, placeId, rec) {
  const doc = loadExterior(projectDir, world);
  doc.checks = { ...(doc.checks ?? {}), [placeId]: rec };
  saveExterior(projectDir, doc);
}

/** The verdict a build command reads: { enforced, ok, via, chain }. Not enforced (catalogue, town, unknown) = ok. */
export function exteriorVerdict(projectDir, world, placeId, opts = {}) {
  const place = exteriorPlaces(projectDir, world).find((p) => p.id === placeId);
  if (!place?.enforced) return { enforced: false, ok: true, via: place ? `${place.id} is not an enforced place (catalogue or town)` : `no reservation ${placeId}`, chain: null };
  const doc = opts.exterior ?? loadExterior(projectDir, world);
  const chain = exteriorChain(projectDir, world, placeId, { ...opts, exterior: doc });
  if (chain.ok) return { enforced: true, ok: true, via: "chain complete", chain };
  const g = grandfatherOf(doc, placeId);
  if (g) return { enforced: true, ok: true, via: `grandfathered (${g.ruling})`, chain };
  return { enforced: true, ok: false, via: "", chain };
}

export function refusalText(command, world, placeId, chain) {
  const n = chain.next;
  return `${command} refused (exterior chain: location -> unedited grab -> concepts painted from it -> concept check -> build): ${placeId} in ${world} is not ready.\n`
    + `  ${chain.rows.map((r) => `${r.step} ${r.state}`).join("  |  ")}\n`
    + `  missing step: ${n.step} [${n.state}${n.why ? `: ${n.why}` : ""}]\n`
    + `  do it:        ${n.how}   (from apps/playground)\n`
    + `  an OWNER ruling only: ${RULING_FLAG} "YYYY-MM-DD <Derek's words, verbatim>" (recorded)`;
}

/** The owner ruling a command was given (`--no-concept-ruling "<text>"` or the env), or "". */
export function rulingArg(argv = process.argv, env = process.env) {
  const i = argv.indexOf(RULING_FLAG);
  if (i >= 0) return String(argv[i + 1] ?? "");
  const eq = argv.find((a) => a.startsWith(`${RULING_FLAG}=`));
  if (eq) return eq.slice(RULING_FLAG.length + 1);
  return env?.[RULING_ENV] ?? "";
}

const recordedThisRun = new Set();
/** Append an owner ruling to the exterior file (once per place and command in a process). */
export function recordRuling(projectDir, world, placeId, ruling, command, kind = "no-concept") {
  const key = `${projectDir}|${world}|${placeId}|${command}|${kind}`;
  if (recordedThisRun.has(key)) return;
  recordedThisRun.add(key);
  const doc = loadExterior(projectDir, world);
  doc.rulings = [...(doc.rulings ?? []), { place: placeId, kind, ruling: ruling.trim(), command, at: new Date().toISOString(), by: process.env.HITREG_AGENT ?? "unstated" }];
  saveExterior(projectDir, doc);
}

/**
 * The build-command hook: null when the place may be built (not enforced, chain complete, grandfathered, or a dated owner
 * ruling given — recorded), else the refusal text naming the missing step and its command.
 */
export function requireExterior({ projectDir, world, place, command, argv = process.argv, env = process.env, recipe }) {
  const v = exteriorVerdict(projectDir, world, place, { recipe });
  if (v.ok) return null;
  const ruling = rulingArg(argv, env);
  if (ruling) {
    if (!isDatedRuling(ruling)) return `${command}: ${RULING_FLAG} needs a dated owner ruling ("YYYY-MM-DD <Derek's words, verbatim>"), got ${JSON.stringify(ruling)}`;
    recordRuling(projectDir, world, place, ruling, command);
    console.warn(`exterior chain: ${place} built WITHOUT its chain on an owner ruling (${ruling.trim()}) — recorded in ${rel(projectDir, exteriorFile(projectDir, world))}`);
    return null;
  }
  return refusalText(command, world, place, v.chain);
}

/** The worlds of a project that have zonegen places. */
export function zonedWorlds(projectDir) {
  const d = path.join(projectDir, "authoring", "zonegen");
  return fs.existsSync(d) ? fs.readdirSync(d).filter((w) => fs.existsSync(path.join(d, w, "zones"))) : [];
}

// ------------------------------------------------------------------ the write guard

/** A world recipe or world scene path -> { projectDir, world, kind: "recipe" | "scene" }, or null. */
export function worldFileOf(file) {
  const m = /[\\/]projects[\\/]([^\\/]+)[\\/]assets[\\/](worlds|scenes)[\\/]([^\\/]+?)(\.scene)?\.json$/.exec(path.resolve(file));
  if (!m || (m[2] === "worlds") === !!m[4]) return null;
  const projectDir = path.resolve(file, "..", "..", "..");
  const world = m[3];
  if (!fs.existsSync(path.join(zonegenDir(projectDir, world), "zones"))) return null;
  return { projectDir, world, kind: m[2] === "worlds" ? "recipe" : "scene" };
}
/** Is there anything to guard in this file (an enforced place in its world)? Cheap: reservations + stages only. */
export function guardTargetOf(file) {
  const w = worldFileOf(file);
  if (!w) return null;
  const places = exteriorPlaces(w.projectDir, w.world).filter((p) => p.enforced);
  return places.length ? { ...w, places } : null;
}

/** The enforced places whose own items an edit adds or changes (removals never build). `normalize` parses a recipe. */
export function touchedPlaces(target, before, after, normalize = (d) => d) {
  const touched = new Set();
  if (target.kind === "recipe") {
    for (const p of target.places) {
      const subset = (doc) => {
        if (!doc) return null;
        const own = placeOwnership(doc, p);
        const features = {};
        for (const [k, list] of Object.entries(doc.features ?? {})) if (Array.isArray(list)) { const mine = list.filter((f) => ownsFeature(own, f, { strong: true })); if (mine.length) features[k] = mine; }
        const needs = (doc.needs ?? []).filter((n) => own.needs.includes(n?.id));
        return { ...doc, features, needs };
      };
      const a = subset(after);
      if (!a || (!Object.keys(a.features).length && !a.needs.length)) continue;
      const b = subset(before);
      const na = normalize(a), nb = b ? normalize(b) : null;
      const key = (doc) => { const m = new Map(); for (const [k, list] of Object.entries(doc?.features ?? {})) for (const f of list ?? []) m.set(`${k}/${f?.id}`, stable(f)); for (const n of doc?.needs ?? []) m.set(`needs/${n?.id}`, stable(n)); return m; };
      const ka = key(na), kb = key(nb);
      for (const [k, v] of ka) if (kb.get(k) !== v) { touched.add(p.id); break; }
    }
  } else {
    const ids = new Set(target.places.map((p) => p.id));
    const ownerIn = (doc) => {
      const memo = new Map();
      const of = (eid, depth = 0) => {
        if (memo.has(eid)) return memo.get(eid);
        const e = doc?.entities?.[eid];
        let o = null;
        if (e) {
          for (const t of e.tags ?? []) if (typeof t === "string" && t.startsWith("poi:") && ids.has(t.slice(4))) { o = t.slice(4); break; }
          if (!o && e.parent && depth < 64) o = of(e.parent, depth + 1);
        }
        memo.set(eid, o);
        return o;
      };
      return of;
    };
    const ofA = ownerIn(after);
    for (const [eid, e] of Object.entries(after?.entities ?? {})) {
      const o = ofA(eid);
      if (!o || touched.has(o)) continue;
      const was = before?.entities?.[eid];
      if (!was || stable(was) !== stable(e)) touched.add(o);
    }
  }
  return [...touched].sort();
}

/**
 * The write guard (_scene-write.mts calls it for every locked JSON write): a world recipe or world scene write that adds or
 * changes an enforced place's own items is refused unless that place's chain is complete (or grandfathered, or a dated
 * owner ruling is on the command line / env). Returns null or the refusal text.
 */
export function exteriorWriteGuard(file, before, after, { argv = process.argv, env = process.env, normalize, label = "" } = {}) {
  const target = guardTargetOf(file);
  if (!target) return null;
  const touched = touchedPlaces(target, before, after, normalize);
  const out = [];
  for (const id of touched) {
    const why = requireExterior({ projectDir: target.projectDir, world: target.world, place: id, command: `${label || path.basename(argv[1] ?? "tool")} (writing ${path.basename(file)})`, argv, env, recipe: target.kind === "recipe" ? after : undefined });
    if (why) out.push(why);
  }
  return out.length ? out.join("\n") : null;
}

export { hasToken };

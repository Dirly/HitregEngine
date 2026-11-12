/**
 * CONCEPT ON SITE — the provenance rule for a place's concept frames (gate 16 `concept[]`, rubric P5).
 *
 * Why (Derek, 2026-10-29): every firstshore concept frame was drawn from TEXT only (their image-request records carry
 * no refs). Codex invented a cliff tall enough for a 50 m gate; the real gorge was 40 m with a 31 m falls, and the owner
 * built to the invented cliff. A concept frame now counts only when it is a REPAINT of a render of the place's real,
 * bare site: `zonegen concept <world> --project <p> --zone <z> --poi <id>` (apps/playground/tools/zonegen/commands/
 * concept.mts) renders the site, writes `<zone>/concept/<id>.site.json` (this module's manifest) beside the renders
 * `<id>-<view>.site.png`, and has `image-request.mjs gen --paint` repaint each render into `<id>-<view>.png`.
 *
 * A frame passes when:
 *  - an image-request record (apps/playground/.hitreg/image-requests/*.json) has it as its `target`, and that record's
 *    `refs` name a `*.site.png`;
 *  - a `*.site.json` manifest beside that render lists it (same sha256: the render is the one this tool made) for the
 *    same place, and the reservation it was shot for is the one in the zone's reservations.json now (same centre and
 *    radius);
 *  - the manifest carries an `unedited` stamp (rule UNEDITED_RULE: the render was made of the recipe WITHOUT the place's
 *    own edits, `uneditedRecipe`) and the UNEDITED ground under the reservation has not changed since (`uneditedStamp`:
 *    the recipe's non-feature fields and every world feature that reaches inside the terrain radius, the place's OWN
 *    edits left out, so building the place never stales its concept).
 * Plain JS (job.mjs, the zonegen command and tests share it); no world field.
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

export const CONCEPT_TOOL = "concept-on-site";
export const CONCEPT_COMMAND = "node node_modules/tsx/dist/cli.mjs tools/zonegen.mts concept <world> --project <p> --zone <z> --poi <id> (from apps/playground)";
/** Recipe keys that never SHAPE the ground: stage stamps, zone polygons and moods, plus plants and paint (a concept
 *  painting replaces those; matches world-order's local-ground rule). L (Weeping Sun 2026-10-30: a world-wide flora
 *  write staled every painted place's concept frames). */
const NOT_GROUND = new Set(["features", "regions", "pipeline", "name", "version", "scatter", "cover", "surfaces", "splat",
  "zoneGround", "rockSkins", "textureFilter", "material", "waterMaterial", "riverMaterial", "marshMaterial", "bridgeMaterial"]);
/** Feature kinds that are plants / paint only. */
const NOT_GROUND_KINDS = new Set(["clearings", "fields"]);
/** Feature keys read as a position or a point list ([x, z] or [x, y, z]). */
const COORD_KEYS = ["points", "polygon", "footprint", "center", "position", "origin", "start", "end", "at"];
/** Feature keys read as a reach (metres) round its coordinates. */
const REACH_KEYS = ["radius", "falloff", "width", "length", "terrainRadius", "sleepRadius", "feather"];

const sha = (b) => crypto.createHash("sha256").update(b).digest("hex");
const readJson = (f) => JSON.parse(fs.readFileSync(f, "utf8").replace(/^﻿/, ""));
const tryJson = (f) => { try { return readJson(f); } catch { return null; } };
export const fileSha = (f) => sha(fs.readFileSync(f));

/** Stable JSON (sorted keys) so a re-saved recipe with the same content hashes the same. */
function stable(v) {
  if (Array.isArray(v)) return `[${v.map(stable).join(",")}]`;
  if (v && typeof v === "object") return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stable(v[k])}`).join(",")}}`;
  return JSON.stringify(v);
}

/** The id rules a place's own features match (its build, never its site): exact ids, id prefixes, `owner` / `poi` fields. */
export function ownership(poi, { prefixes = [], ids = [] } = {}) {
  const pre = [...new Set([`pb-${poi}-`, `op:pb-${poi}-`, `road-pb-${poi}-`, `bridge-road-pb-${poi}-`, `${poi}-`, ...prefixes])].sort();
  return { poi, prefixes: pre, ids: [...new Set([poi, ...ids])].sort() };
}
/**
 * Is a recipe feature (or a need) the place's own edit? `owner` / `poi` / `for` naming the place, an exact id, an id
 * prefix; and, for an ownership made by `placeOwnership` (exterior-chain.mjs), the TOKEN rule: the place id as a whole
 * token of the feature's id (`talus-rustgut-apron`, `woodland-keep-rustgut`, `road-rustgut-track`) for a feature that
 * reaches the place (`own.near`). `{ strong: true }` skips the token rule (the write guard: a world-wide pass that
 * rewrites a keep-clearing is not the place's build). `own.disowns` lists ids that are never the place's.
 */
export function ownsFeature(own, f, { strong = false } = {}) {
  if (!f || typeof f !== "object") return false;
  const id = typeof f.id === "string" ? f.id : "";
  if (id && (own.disowns ?? []).includes(id)) return false;
  if (f.owner === own.poi || f.poi === own.poi || f.for === own.poi) return true;
  if (id && (own.ids.includes(id) || own.prefixes.some((p) => id.startsWith(p)))) return true;
  // the token rule reads an operator doc's source / toe / site too (`from`, `to`, `near`): a named-for-it feature far away is not its
  if (!strong && id && own.near && (own.tokens ?? []).some((t) => hasToken(id, t))) return reaches({ ...f, points: [f.points ?? [], f.from ?? [], f.to ?? [], f.near ?? []] }, own.near.center[0], own.near.center[1], own.near.r);
  return false;
}
/** Is `token` (a place id, itself hyphenated) a whole run of the id's tokens (split on - : / . _)? */
export function hasToken(id, token) {
  const a = String(id).toLowerCase().split(/[-:/._]+/).filter(Boolean), b = String(token).toLowerCase().split(/[-:/._]+/).filter(Boolean);
  if (!b.length || b.length > a.length) return false;
  for (let i = 0; i + b.length <= a.length; i++) if (b.every((t, k) => a[i + k] === t)) return true;
  return false;
}

/**
 * THE UNEDITED GROUND (Derek 2026-11-10, Rustgut: "you need to always build it off of a location, a screen grab of that
 * location"): the recipe with every edit attributable to the place taken out — its features (need patches, operator
 * pieces, landmarks, clearings, its own roads, dressing clearings), its operator docs and its `needs` (`for` = the
 * place). The bare render and its fingerprint are made of THIS, so a concept is never painted on the place's own stamped
 * block, and building the place (solving its need, applying its operator) never stales the grab.
 * Returns { recipe, excluded: ["heightPatches/need-x", "needs/x", ...] }.
 */
export function uneditedRecipe(recipe, own) {
  const excluded = [];
  const features = {};
  for (const [kind, list] of Object.entries(recipe.features ?? {})) {
    if (!Array.isArray(list)) { features[kind] = list; continue; }
    features[kind] = list.filter((f) => { const mine = ownsFeature(own, f); if (mine) excluded.push(`${kind}/${f?.id ?? "?"}`); return !mine; });
  }
  const needs = Array.isArray(recipe.needs) ? recipe.needs.filter((n) => { const mine = (own.needs ?? []).includes(n?.id) || ownsFeature(own, n); if (mine) excluded.push(`needs/${n?.id ?? "?"}`); return !mine; }) : recipe.needs;
  return { recipe: { ...recipe, features, ...(needs !== undefined ? { needs } : {}) }, excluded: excluded.sort() };
}
/** The rule name an unedited stamp carries (a later change of the rule re-renders, never silently matches). */
export const UNEDITED_RULE = "unedited-2026-11-10";
/**
 * The manifest's `unedited` stamp: the ground fingerprint of the UNEDITED recipe under the reservation (needs are
 * declarations: their solved patches are features, so the `needs` list itself is left out), plus the excluded edits.
 */
export function uneditedStamp(recipe, { center, radius }, own) {
  const u = uneditedRecipe(recipe, own);
  const { needs: _needs, ...ground } = u.recipe;
  const fp = groundFingerprint(ground, { center, radius }, own);
  return { rule: UNEDITED_RULE, fingerprint: fp.hash, parts: fp.parts, featuresUnder: fp.features, excluded: u.excluded };
}

/** Every [x, z] a feature's top-level coordinate keys hold, and the reach round them. */
function footprint(f) {
  const pts = [];
  const take = (v) => {
    if (!Array.isArray(v) || !v.length) return;
    if (typeof v[0] === "number") { if (v.length >= 3) pts.push([v[0], v[2]]); else if (v.length === 2) pts.push([v[0], v[1]]); return; }
    for (const q of v) take(q);
  };
  for (const k of COORD_KEYS) take(f[k]);
  if (Array.isArray(f.origin) && Array.isArray(f.size) && f.size.length >= 2) pts.push([f.origin[0] + f.size[0], f.origin[f.origin.length >= 3 ? 2 : 1] + f.size[1]]);
  let reach = 0;
  for (const k of REACH_KEYS) if (typeof f[k] === "number" && Number.isFinite(f[k])) reach = Math.max(reach, f[k]);
  if (f.area && typeof f.area.radius === "number") reach = Math.max(reach, f.area.radius);
  return { pts, reach };
}

/** Does a feature reach within `r` of (cx, cz)? A feature with no coordinates counts (it may shape everything). */
function reaches(f, cx, cz, r) {
  const { pts, reach } = footprint(f);
  if (!pts.length) return true;
  let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
  for (const [x, z] of pts) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); z0 = Math.min(z0, z); z1 = Math.max(z1, z); }
  const dx = Math.max(x0 - reach - cx, 0, cx - x1 - reach), dz = Math.max(z0 - reach - cz, 0, cz - z1 - reach);
  return dx * dx + dz * dz <= r * r;
}

/**
 * The ground under a reservation, as a hash: every recipe key that shapes or paints ground (seed, terrain, climate,
 * biomes, scatter, ...) and every feature that reaches within `radius` (+ 20 m) of `center`, sorted by kind and id; the
 * place's own features (`own`, from `ownership`) left out. Changes elsewhere in the world never stale it.
 */
export function groundFingerprint(recipe, { center, radius }, own) {
  const global = Object.fromEntries(Object.entries(recipe).filter(([k]) => !NOT_GROUND.has(k)));
  const near = [];
  const r = radius + 20;
  for (const [kind, list] of Object.entries(recipe.features ?? {})) {
    if (!Array.isArray(list) || NOT_GROUND_KINDS.has(kind)) continue;
    for (const f of list) if (!ownsFeature(own, f) && reaches(f, center[0], center[1], r)) near.push([kind, String(f?.id ?? ""), stable(f)]);
  }
  near.sort((a, b) => (a[0] + "\0" + a[1] < b[0] + "\0" + b[1] ? -1 : 1));
  const g = stable(global), n = near.map((x) => x.join("\t")).join("\n");
  // per-part hashes (stored as the manifest's `fingerprintParts`): a later mismatch names the part that moved, and a
  // change of what counts as ground can be told from a moved ground (o-gates 2026-10-30)
  return { hash: sha(g + "\n" + n), features: near.length, parts: { global: sha(g), near: sha(n) } };
}

/** A manifest's stamp: the fingerprint, its parts and the feature count. */
export const stampOf = (fp) => ({ fingerprint: fp.hash, fingerprintParts: fp.parts, featuresUnder: fp.features });

/** Which parts of a stamp moved, or [] when the stamp has no parts (made before 2026-10-30) or nothing moved. */
export function movedParts(m, fp) {
  const was = m?.fingerprintParts;
  if (!was) return [];
  return [...(was.global !== fp.parts.global ? ["the global ground fields"] : []), ...(was.near !== fp.parts.near ? ["the features under the reservation"] : [])];
}

const DATED_RULING = /^\d{4}-\d{2}-\d{2}\b.{8,}/;
/**
 * RESTAMP a site manifest: rewrite its fingerprint with the CURRENT groundFingerprint, never re-rendering. For when what
 * counts as ground changed (L o-gates 2026-10-30: NOT_GROUND gained the plant/paint keys, so every stamp hashed with the
 * old set could never match again), never for a moved ground: the CALLER proves the ground did not move (the
 * `concept-site restamp` command, apps/playground/tools/concept-site.mts, refuses unless the place's bare-renders stage
 * is ok on its local ground). Logs the dated ruling and the old and new hashes in the manifest's `restamps`.
 * Returns { old, new, changed }; throws on an undated ruling or an unreadable manifest/world.
 */
export function restampManifest(file, ruling, playground = PLAYGROUND, now = new Date()) {
  if (typeof ruling !== "string" || !DATED_RULING.test(ruling.trim())) throw Error(`restamp needs a dated ruling ("YYYY-MM-DD who: why"), got ${JSON.stringify(ruling)}`);
  const m = tryJson(file);
  if (m?.tool !== CONCEPT_TOOL) throw Error(`${file} is not a ${CONCEPT_TOOL} manifest`);
  const recipe = tryJson(path.resolve(playground, m.worldFile ?? ""));
  if (!recipe) throw Error(`${file}: its world ${m.worldFile} cannot be read`);
  const fp = groundFingerprint(recipe, { center: m.reservation.center, radius: m.reservation.terrainRadius ?? m.reservation.radius }, m.ownership ?? ownership(m.poi));
  const old = m.fingerprint;
  if (old === fp.hash && m.fingerprintParts) return { old, new: fp.hash, changed: false };
  const next = { ...m, ...stampOf(fp), restamps: [...(m.restamps ?? []), { at: now.toISOString(), ruling: ruling.trim(), old, new: fp.hash }] };
  fs.writeFileSync(file, JSON.stringify(next, null, 2) + "\n");
  return { old, new: fp.hash, changed: true };
}

const PLAYGROUND = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "apps", "playground");
/** Where image-request.mjs keeps its records (HITREG_IMAGE_REQUESTS overrides: tests). */
export function imageRequestDir(playground = PLAYGROUND) {
  return process.env.HITREG_IMAGE_REQUESTS ?? path.join(playground, ".hitreg", "image-requests");
}
/** The image-request record whose `target` is this file (the newest when several), or null. */
export function requestRecordFor(file, playground) {
  const dir = imageRequestDir(playground), want = path.resolve(file).toLowerCase();
  if (!fs.existsSync(dir)) return null;
  let best = null;
  for (const f of fs.readdirSync(dir).filter((n) => n.endsWith(".json"))) {
    const r = tryJson(path.join(dir, f));
    if (!r || typeof r.target !== "string" || path.resolve(r.target).toLowerCase() !== want) continue;
    if (!best || String(r.createdAt ?? "") > String(best.createdAt ?? "")) best = r;
  }
  return best;
}

/** The manifest (`*.site.json` beside it) that lists this render by name and sha256, or null. */
export function siteManifestFor(render) {
  const dir = path.dirname(render), base = path.basename(render);
  if (!fs.existsSync(render) || !fs.existsSync(dir)) return null;
  const have = fileSha(render);
  for (const f of fs.readdirSync(dir).filter((n) => n.endsWith(".site.json"))) {
    const m = tryJson(path.join(dir, f));
    if (m?.tool !== CONCEPT_TOOL || !m.renders) continue;
    for (const [view, r] of Object.entries(m.renders)) if (r?.file === base && r.sha256 === have) return { manifest: m, file: path.join(dir, f), view };
  }
  return null;
}

/** The job's place id, zone folder and current reservation, read from its path (…/zones/<z>/pois|dungeons/<id>). */
export function jobSite(dir) {
  const abs = path.resolve(dir), parts = abs.split(path.sep), zi = parts.lastIndexOf("zones");
  const progress = tryJson(path.join(abs, "progress.json"));
  const poi = (typeof progress?.poiId === "string" && progress.poiId) || path.basename(abs);
  if (zi < 0 || !parts[zi + 1]) return { poi, zoneDir: null, reservation: null };
  const zoneDir = parts.slice(0, zi + 2).join(path.sep);
  const res = tryJson(path.join(zoneDir, "reservations.json"));
  const reservation = (res?.reservations ?? []).find((r) => r?.location === poi) ?? null;
  return { poi, zoneDir, reservation };
}

/**
 * Why one concept frame does not count as drawn on its site, or null when it does. `file` is the frame (absolute);
 * `site` is jobSite(dir); `playground` resolves the manifest's worldFile.
 */
export function conceptSiteFault(file, site, playground = PLAYGROUND) {
  const name = path.basename(file);
  const rec = requestRecordFor(file, playground);
  if (!rec) return `concept frame ${name} has no image-request record (hand-made or copied): concept frames are repainted renders of the bare site — ${CONCEPT_COMMAND}`;
  const refs = (rec.refs ?? []).filter((r) => typeof r === "string" && /\.site\.png$/i.test(r));
  if (!refs.length) return `concept frame ${name} was drawn from TEXT only (request ${rec.id} has no site render ref): text-only concepts invent the ground (Wristgate's 50 m cliff on a 40 m gorge) — ${CONCEPT_COMMAND}`;
  const faults = [];
  for (const ref of refs) {
    const hit = siteManifestFor(ref);
    if (!hit) { faults.push(`its ref ${path.basename(ref)} is not a render this tool made (no matching *.site.json beside it)`); continue; }
    const m = hit.manifest;
    if (m.poi !== site.poi) { faults.push(`its site render is of ${m.poi}, not ${site.poi}`); continue; }
    const cur = site.reservation;
    if (cur && (Math.hypot(cur.center[0] - m.reservation.center[0], cur.center[1] - m.reservation.center[1]) > 1 || Math.abs((cur.radius ?? 0) - (m.reservation.radius ?? 0)) > 1)) {
      faults.push(`the reservation moved since its site render (${m.reservation.center.join(",")} r ${m.reservation.radius} then, ${cur.center.join(",")} r ${cur.radius} now)`);
      continue;
    }
    const wf = path.resolve(playground, m.worldFile ?? "");
    const recipe = tryJson(wf);
    if (!recipe) { faults.push(`its world ${m.worldFile} cannot be read`); continue; }
    // the UNEDITED ground (2026-11-10): a render made before the rule may show the place's own stamped terrain
    if (m.unedited?.rule !== UNEDITED_RULE) { faults.push(`its site render ${path.basename(ref)} was made before the unedited-ground rule (2026-11-10: the place's own needs, patches, operators and clearings are taken out of the bare render) — re-render it`); continue; }
    const st = uneditedStamp(recipe, { center: m.reservation.center, radius: m.reservation.terrainRadius ?? m.reservation.radius }, m.ownership ?? ownership(m.poi));
    if (st.fingerprint !== m.unedited.fingerprint) { const moved = movedParts({ fingerprintParts: m.unedited.parts }, { parts: st.parts }); faults.push(`the world changed under the reservation (its unedited ground) since its site render (${m.renderedAt})${moved.length ? `: ${moved.join(" and ")} moved` : ""}`); continue; }
    return null;
  }
  return `concept frame ${name}: ${faults.join("; ")} — re-run ${CONCEPT_COMMAND}`;
}

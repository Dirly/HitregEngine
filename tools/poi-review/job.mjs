/**
 * POI / dungeon JOB gates, enforced by tools instead of prose (docs/world-standards process rules):
 *
 *   1. Nothing installs before the FINAL review passes. An installer calls `requireFinalReview(jobDir)` before it
 *      writes: progress.json must record `finalReview` { file, verdict: "PASS", opsHash }, the review file must say
 *      PASS and name the same opsHash, and opsHash must equal the hash of the ops delivered NOW (any edit after the
 *      review re-opens it). `--force-dogfood` (the coordinator's, for a deliberate dogfood install) passes the gate
 *      and records the bypass in progress.json.
 *   2. The grey box proves the read: a job's stage may not move past `blockout` until progress.json `evidence.readShot`
 *      is { file, viewpoint } with the file present and the viewpoint one the job declared (`viewpoints[]` in
 *      progress.json or handoff.json) BEFORE the shot.
 *   4. Fire is the engine's fire: past blockout (and at install) the delivered scene ops may hold no home-made fire —
 *      no primitive or fx-material mesh named as a flame/fire/torch/brazier/pyre, and no raw `light` outside a `vfx`
 *      fire or a catalogued prefab. Fire and its light come from the standing `vfx` fire through the catalogue's
 *      prefabs (world-kit poi-props/brazier, standing-torch, campfire, camp-props/bonfire, giant-camp/giant-fire,
 *      fixtures/sconce-fire, ...) from one light bucket (owner ruling 2026-10-11: "why does it not use the fire we built").
 *   5. Nothing floats: the install needs `reports/float.json` from the float gate (`worldgen float <world> --near
 *      x,z,r --out ...`, or `tools/float.mts scene <project> --out ...`) saying ok, newer than every delivered ops file.
 *   6. Stone follows the place: the install needs `reports/rock-skins.json` from the rock-skins gate (`worldgen rock-skins
 *      <world> --near x,z,r --out ...`) saying ok — every rock the job places (and every scatter rock around it) in its
 *      zone's or its cliff's stone, every cap on the ground band beside it — newer than every delivered ops file.
 *   7. No water ends in the air: the install needs `reports/water-edges.json` from the water-edges gate (`worldgen
 *      water-edges <world> --near x,z,r --out ...`, or `tools/water-edges.mts scene <project> --out ...`) saying ok —
 *      every curtain on its measured lip and hugging its face, every water edge buried or finished — newer than every
 *      delivered ops file.
 *   8. No holes you can see through the map: a job that delivers BUILT structures (any added `mesh` component in its
 *      scene ops) needs `reports/see-through.json` from the see-through gate (`tools/see-through.mts scene <preview scene>
 *      --route <walk-route.json> --out ...`) saying ok — no sentinel (magenta) pixel where ground or built geometry must
 *      be, from eye height along the walk route — newer than every delivered ops file (docs/see-through.md). Since
 *      2026-10-31 a SHOT ROW (SHOT_ROWS): judged after the install from the batch render, never an install block.
 *   9. Flat art reads upright: a job delivering a model that wears an engine material (a slab + a generated picture:
 *      door relief, plaque, panel) needs `reports/flat-art.json` (`tools/flat-art.mts check <project> --scene <preview>
 *      --out ...`) saying ok — no picture upside down or mirrored — newer than every delivered ops file.
 *  10. Monuments are climbed around, not up a freestanding stair: a monument or butte site (its brief) delivering built
 *      structures needs `reports/monument-approach.json` (`tools/monument-approach.mts scene <project> --scene <preview>
 *      --near x,z,r --monument --out ...`) saying ok — every stair flight held by the face it climbs.
 *  11. Ground is shaped by operators, not fine carves (the 6 m rule): the delivered files may hold no passage, height
 *      patch or blob under 6 m in its smallest dimension ("too fine for terrain: use a kit/hero piece or an operator").
 *      Checked straight from the delivered files (`terrainFineBlock`); `op:` / `tw-` / `bs-` pieces are exempt. A coordinator-ruled
 *      exception is listed in `<project>/authoring/terrain/<world>.fine-exceptions.json` (beside the lips exceptions and the
 *      world's fine-legacy list): `{ exceptions: [{ id, job, reason, ruling, carves: ["passages/<id>", ...] }] }` — the
 *      listed carves of THAT job are reported excepted, never counted; `job.mjs fine <jobDir> [--no-exceptions]`.
 *  12. Size meets its tier (tools/poi-review/size-tiers.mjs, owner ruling 2026-10-03): the job's MEASURED footprint, usable
 *      area, linked features, creature groups, approaches and terrain shaping (`job.mjs measure <jobDir>`) are at least
 *      its tier's. The tier is brief.json `adventureSize`, else the zone plan's place/location size.
 *  13. The review is someone else's: the final review names `Reviewer: <agent id>` that is neither the job's owner
 *      (progress.json `ownerAgentId`) nor the coordinator, and answers EVERY Quality + Site line of
 *      docs/world-standards/review-rubric.md (Q1..Q5, S1..S9) pass / fault / n/a with evidence; a PASS with a fault
 *      answer is refused. The only override is `ownerApproval: { by: "derek", note }` in progress.json, which a human
 *      writes by hand — no tool writes it.
 *  14. A real body walks it (QA-B 2026-10-18: every collider gate passed and a player still fell through the ramp): the
 *      install needs `reports/walk.json` from `apps/playground/tools/poi-walk.mts <jobDir>` saying ok — the scene booted as
 *      the server boots it (project closure only, the server's ring), every handoff `navigation.routes` route (required),
 *      path and landmark chain walked BOTH ways from a cold start, and every derived target (landmark targets + openings,
 *      WFC doorways, portals, dressing areas, encounter clearings, quest entities) reached and standing — no fall, stuck,
 *      miss, one-way leg, unsent portal, shadowed asset or collider the server does not stream where it is stood on —
 *      newer than every delivered ops file, and a whole run (not --only).
 *  15. It looks like the place it stands in (QA-C art audit 2026-10-18: a door drawn 4.4x denser than the mountain, black
 *      leaves, one stone tile over 16,500 m2, a dungeon door with no portal): a job delivering landmarks, terrain paint or
 *      structures needs `reports/art-check.json` from `apps/playground/tools/art-check.mts <jobDir>` saying ok — texel
 *      match against the terrain and props around it (triplanar + splat counted), value inside the zone ground's L* band,
 *      architectural material assignments (numeric texture variety is diagnostic by default), every door with a portal (veil + travel target) or declared sealed (handoff.json
 *      `doors`), and the landmark-spec form lint (identical copies, butted raw boxes, bevels, course scale vs culture) —
 *      newer than every delivered ops file.
 *  16. The place is DESIGNED before it expands (owner ruling 2026-10-22: a zone of places passed every gate above and
 *      read as nothing — gates are not quality). The owner writes `design.json` { premise, journey[], areas[], elements[],
 *      sample: { area, shots[] }, reference[], concept[] }: the one-line premise, the player's journey, the areas and their purpose,
 *      the story elements each made of named catalogue props / structures / creatures / decals (a prop id must exist in
 *      the project closure's catalogues), ONE area finished at player height (its frames) and the owner-approved
 *      reference frames it is judged against, and a CONCEPT frame drawn from the premise before the build ON ITS SITE: a repaint of a
 *      bare-site render (`zonegen concept`, tools/poi-review/concept-site.mjs; a text-only frame is refused for a new job). A fresh reviewer (gate 13's identity rules) answers the rubric's Place lines
 *      P1..P5 on that sample — story read, every element seen, nothing random, worth visiting, finished to the bar —
 *      naming `Design hash: <job.mjs design>`; `job.mjs design-review <dir> --file <review>` records it. No stage past
 *      greybox-review (no detail: no repeated fences, graves, stalls), and no install, without that PASS; editing
 *      design.json or its sample frames re-opens it. The final review (gate 13) answers P1..P5 again on the whole place.
 *  17. It matches its painting's scale: a PAINTED place (concept/<poi>.site.json) needs `reports/scale.json` from
 *      `place-build scale` saying ok (scaleBlock) — its hero pieces' screen sizes through the painting's camera.
 *   3. The loop is capped: `fix` records each fix attempt in progress.json `fixes`; a third attempt is refused unless
 *      the coordinator passes --coordinator (and it is recorded as theirs).
 *
 *   node tools/poi-review/job.mjs design <jobDir>                          check design.json (gate 16); prints the design hash
 *   node tools/poi-review/job.mjs design-review <jobDir> --file <review>   record the design review (verdict read from the file)
 *      (its sample frames are FROZEN under reviews/<place>/: later shots never re-open it; a design.json edit does)
 *   node tools/poi-review/job.mjs design-backfill <jobDir> --ruling "YYYY-MM-DD ..."   freeze the current sample frames under a
 *      review recorded before freezing, only when design.json was last written before that review (backfillDesignSample)
 *   node tools/poi-review/job.mjs hash   <jobDir>                          the delivered-ops hash a reviewer records
 *   node tools/poi-review/job.mjs review <jobDir> --file <review>          record the FINAL review (verdict read from the file)
 *   node tools/poi-review/job.mjs stage  <jobDir> <stage>                  move the job's stage (gate 2)
 *   node tools/poi-review/job.mjs fix    <jobDir> --what "<the fix>" [--coordinator]   record a fix attempt (gate 3)
 *   node tools/poi-review/job.mjs fire   <jobDir>                          list home-made fire in the delivered ops (gate 4)
 *   node tools/poi-review/job.mjs check-install <jobDir> [--force-dogfood] exit 0 when an installer may run (gate 1)
 *   node tools/poi-review/job.mjs measure <jobDir>                        measure the place against its size tier (gate 12)
 *
 * A review file is JSON { verdict, opsHash, reviewer, answers: { Q1: { result, evidence }, ... } }, or text/markdown
 * with lines `Verdict: PASS`, `Ops hash: <hash>`, `Reviewer: <agent id>` and one line per rubric item
 * `- S1: pass — <evidence>`. A design review names `Design hash: <hash>` (designHash in JSON) instead of the ops hash
 * and answers the Place lines only. Pure helpers are exported for tests and installers.
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { CONCEPT_COMMAND, conceptSiteFault, jobSite } from "./concept-site.mjs";
import { aggregateMeasurement, measurementFaults, parentedTierFault, sizeMeasurementSchema, TIER_NAMES } from "./size-tiers.mjs";

export const STAGES = ["briefed", "survey", "blockout", "greybox-review", "detail", "final-review", "installed"];
/** Fix attempts allowed before the coordinator must decide (install with the fault logged, or cut the feature). */
export const MAX_FIXES = 2;
const DEFAULT_OPS = ["ops.json", "world-ops.json", "clearings.json", "region.json"];
/** World edits a job delivers whether or not its handoff names them: a sightline clearing or a rope bridge changes the place. */
const ALWAYS_OPS = ["clearings.json", "bridges.json"];

const readJson = (f) => JSON.parse(fs.readFileSync(f, "utf8").replace(/^﻿/, ""));
const sha = (b) => crypto.createHash("sha256").update(b).digest("hex");
const progressFile = (dir) => path.join(dir, "progress.json");
const loadProgress = (dir) => readJson(progressFile(dir));
const saveProgress = (dir, p) => fs.writeFileSync(progressFile(dir), JSON.stringify(p, null, 2) + "\n");

/**
 * The job's ONE handoff (`<dir>/handoff.json`, null when absent) and any stray iteration folders (`v<N>/`) beside it.
 * Revisions overwrite the handoff in place (no iteration files: git is the history), so a v<N>/handoff.json is never
 * read — tools name the folders so they get deleted.
 */
export function jobHandoff(dir) {
  const f = path.join(dir, "handoff.json");
  let iterationDirs = [];
  try { iterationDirs = fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory() && /^v\d+$/i.test(e.name)).map((e) => e.name).sort(); } catch { /* no dir */ }
  return { file: fs.existsSync(f) ? f : null, iterationDirs };
}

/**
 * The ops files a job delivers: handoff.integration's sceneOps / worldOps / clearings / bridges / region, else the
 * defaults — plus, always, its clearings.json and bridges.json when present (a handoff that named only its scene and
 * world ops left a later sightline clearing out of the hash: KS-8, 2026-10-21).
 */
export function deliveredOps(dir) {
  const hf = path.join(dir, "handoff.json");
  const integ = fs.existsSync(hf) ? readJson(hf).integration ?? {} : {};
  const named = ["sceneOps", "worldOps", "clearings", "bridges", "region"].flatMap((k) => (typeof integ[k] === "string" ? integ[k].split(/\s*\+\s*|\s+/) : Array.isArray(integ[k]) ? integ[k] : []))
    .filter((f) => typeof f === "string" && /\.json$/i.test(f));
  const list = [...new Set([...(named.length ? named : DEFAULT_OPS), ...ALWAYS_OPS])].filter((f) => fs.existsSync(path.join(dir, f)));
  return list.sort();
}
/** One hash over the delivered ops (name + content of each). */
export function opsHash(dir, files = deliveredOps(dir)) {
  if (!files.length) return null;
  return sha(files.map((f) => `${f}\0${sha(fs.readFileSync(path.join(dir, f)))}`).join("\n"));
}

/** Verdict, ops hash, reviewer and rubric answers a review file states. */
export function readReview(file) {
  const text = fs.readFileSync(file, "utf8").replace(/^﻿/, "");
  try {
    const j = JSON.parse(text);
    const answers = {};
    for (const [k, v] of Object.entries(j.answers ?? {})) {
      const o = typeof v === "string" ? { result: v.split(/[\s:—–-]/)[0], evidence: v.replace(/^\S+[\s:—–-]*/, "") } : v ?? {};
      answers[k.toUpperCase()] = { result: normResult(o.result), evidence: String(o.evidence ?? "").trim() };
    }
    return { verdict: String(j.verdict ?? "").toUpperCase(), opsHash: j.opsHash ?? null, designHash: j.designHash ?? null, reviewer: j.reviewer ? String(j.reviewer).trim() : null, answers };
  } catch {
    const v = /^\W*verdict\W*[:=]\s*\**\s*([A-Za-z-]+)/im.exec(text);
    const h = /ops ?hash\W*[:=]\s*`?([0-9a-f]{64})/i.exec(text);
    const d = /design ?hash\W*[:=]\s*`?([0-9a-f]{64})/i.exec(text);
    const r = /^\W*reviewer\W*[:=]\s*(.+?)\s*$/im.exec(text);
    const answers = {};
    for (const m of text.matchAll(/^[\s>*|-]*\**([A-Z]\d{1,2})\**\s*[:=|.]?\s*\**(pass|fault|n\/a|na)\**(?![\w/])\s*[:—–|-]*\s*(.*)$/gim))
      answers[m[1].toUpperCase()] ??= { result: normResult(m[2]), evidence: m[3].replace(/\|\s*$/, "").trim() };
    return { verdict: (v?.[1] ?? "").toUpperCase(), opsHash: h?.[1] ?? null, designHash: d?.[1] ?? null, reviewer: r ? r[1].replace(/[*`]+/g, "").trim() : null, answers };
  }
}
const normResult = (x) => { const s = String(x ?? "").toLowerCase(); return s === "na" ? "n/a" : s; };

/** The rubric lines a POI final review answers: every Quality, Site and Place code of docs/world-standards/review-rubric.md. */
export const RUBRIC_FILE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../docs/world-standards/review-rubric.md");
/** The Place lines (P1..P5): the design review answers these alone, on the one finished sample area (gate 16). */
export const designCodes = (file = RUBRIC_FILE) => rubricCodes(file, ["Place"]);
export function rubricCodes(file = RUBRIC_FILE, sections = ["Quality", "Site", "Place"]) {
  const text = fs.readFileSync(file, "utf8");
  const out = [];
  for (const part of text.split(/^## /m).slice(1)) {
    if (!sections.some((s) => part.startsWith(s))) continue;
    for (const m of part.matchAll(/^- ([A-Z]\d{1,2}) /gm)) out.push(m[1]);
  }
  return out;
}

/** Words that never identify a fresh reviewer agent. */
const NOT_AN_AGENT = new Set(["owner", "self", "me", "coordinator", "reviewer", "agent", "opus", "sonnet", "haiku", "claude", "fresh", "derek"]);
const STOP = new Set([...NOT_AN_AGENT, "continuing", "finished", "the", "after", "who", "took", "over", "from", "detail", "pass", "and", "of", "by", "via", "context", "cap", "grey", "box", "review", "poi"]);
/** Agent ids named in an owner field ("POI-I3 (Opus), continuing POI-I / POI-I2" -> poi-i3, poi-i, poi-i2). */
export function ownerIds(owner) {
  return new Set(String(owner ?? "").toLowerCase().split(/[^a-z0-9_.-]+/).map((t) => t.replace(/^[.-]+|[.-]+$/g, "")).filter((t) => t.length >= 2 && !STOP.has(t)));
}
/** The job's owner field: progress.json ownerAgentId, else handoff.json's. */
function ownerOf(dir) {
  const p = fs.existsSync(progressFile(dir)) ? loadProgress(dir) : {};
  const hf = path.join(dir, "handoff.json");
  return p.ownerAgentId ?? (fs.existsSync(hf) ? readJson(hf).ownerAgentId : null) ?? null;
}

/**
 * Why a review file cannot be a review of this job (identity + rubric), or null. Gate 13 for the final review (every
 * Quality + Site + Place line); the design review (gate 16) passes `codes: designCodes()` and answers the Place lines only.
 */
export function reviewIdentityBlock(dir, said, file = "the review", { codes = rubricCodes(), gate = 13, sections = "Quality + Site + Place" } = {}) {
  const reviewer = said.reviewer;
  if (!reviewer) return `${file} names no reviewer: a fresh reviewer writes "Reviewer: <their agent id>" (gate ${gate})`;
  if (!/^[A-Za-z][A-Za-z0-9_.-]{1,63}$/.test(reviewer)) return `${file} reviewer "${reviewer.slice(0, 80)}" is not an agent id (one token, e.g. REV-G1): the reviewer states who they are (gate ${gate})`;
  const id = reviewer.toLowerCase();
  if (/coordinator/.test(id) || NOT_AN_AGENT.has(id)) return `${file} is reviewed by "${reviewer}": the coordinator, the owner or a model name does not review (gate ${gate}); Derek approves by writing ownerApproval in progress.json himself`;
  const owner = ownerOf(dir);
  if (!owner) return `the job records no ownerAgentId (progress.json): a review cannot be checked against its owner (gate ${gate})`;
  if (ownerIds(owner).has(id)) return `${file} is reviewed by ${reviewer}, who is an owner of this job (${owner}): a fresh reviewer agent reviews (gate ${gate})`;
  const missing = codes.filter((c) => !said.answers?.[c] || !["pass", "fault", "n/a"].includes(said.answers[c].result) || said.answers[c].evidence.length < 3);
  if (missing.length) return `${file} does not answer rubric line(s) ${missing.join(", ")} (docs/world-standards/review-rubric.md ${sections}): each needs pass / fault / n/a with evidence (gate ${gate})`;
  const faults = codes.filter((c) => said.answers[c].result === "fault");
  if (said.verdict === "PASS" && faults.length) return `${file} says PASS with fault answer(s) ${faults.join(", ")}: a PASS has no faults (gate ${gate})`;
  // the Place lines are never n/a on a place (owner ruling 2026-10-22): "no nets visible" is a fault, not a note
  const dodged = codes.filter((c) => /^P\d/.test(c) && said.answers[c].result === "n/a");
  if (dodged.length) return `${file} answers ${dodged.join(", ")} n/a: the Place lines are answered pass or fault from the frames, never n/a (gate ${gate})`;
  return null;
}

/** A hand-written owner override: progress.json ownerApproval { by: "derek", note[, opsHash][, designHash] }. No tool writes it. designHash, when it names the current design, also passes gate 16 (designBlock). */
export function ownerApproval(p, now) {
  const a = p?.ownerApproval;
  if (!a || typeof a !== "object" || String(a.by).toLowerCase() !== "derek" || typeof a.note !== "string" || a.note.trim().length < 3) return null;
  if (a.opsHash && a.opsHash !== now) return null;
  return a;
}

/**
 * The SHOT-DEPENDENT rows (Derek 2026-10-31, memory batch-renders-after-install: no per-place shot runs while building;
 * install in batches, then ONE batch render over the live world): gate 8 see-through (a browser render along the walk
 * route) and gate 16's sample frames. They are judged AFTER the install from the latest batch evidence
 * (`place-build render-batch`, apps/playground/tools/_render-batch.mts) and a fault there is a fix round; they never block
 * the install. `installBlock(dir, { shots: true })` still asks for them (a caller that wants the old full set).
 */
export const SHOT_ROWS = ["see-through", "design-sample"];
/** Why an install may not run, or null when it may. Pure apart from reading the job directory. Geometry gates only
 *  unless `shots: true` (SHOT_ROWS). */
export function installBlock(dir, { fineExceptions = true, shots = false } = {}) {
  if (!fs.existsSync(progressFile(dir))) return `no progress.json in ${dir}`;
  const p = loadProgress(dir);
  const now = opsHash(dir);
  if (!now) return "the job delivers no ops files";
  return (ownerApproval(p, now) ? null : finalReviewBlock(dir, p, now) ?? designBlock(dir, p, { sample: shots })) ?? sizeBlock(dir) ?? floatBlock(dir) ?? rockSkinsBlock(dir) ?? waterEdgesBlock(dir) ?? walkBlock(dir) ?? artBlock(dir) ?? scaleBlock(dir) ?? (shots ? seeThroughBlock(dir) : null) ?? flatArtBlock(dir) ?? monumentApproachBlock(dir) ?? terrainFineBlock(dir, { exceptions: fineExceptions });
}

/** Gates 1 + 13: the recorded final review passes for these ops and is a fresh reviewer's, answering the rubric. */
export function finalReviewBlock(dir, p, now) {
  // called without a progress record (the zonegen gates, a job not yet started): a block reason, never a throw
  if (p === undefined) {
    if (!fs.existsSync(progressFile(dir))) return `no progress.json in ${dir}: the job has recorded no stage and no final review — the owner starts it (job.mjs stage ${dir} <stage>) and a fresh reviewer's PASS is required before install (job.mjs review ${dir} --file <review>)`;
    try { p = loadProgress(dir); } catch (e) { return `progress.json in ${dir} is not readable JSON (${e.message}): fix it before the final review can count`; }
  }
  if (!p || typeof p !== "object") return `progress.json in ${dir} holds no progress record`;
  if (now === undefined) now = opsHash(dir);
  const r = p.finalReview;
  if (!r || typeof r !== "object") return `progress.json records no final review: a fresh reviewer's PASS is required before install (job.mjs review ${dir} --file <review>)`;
  if (String(r.verdict).toUpperCase() !== "PASS") return `the final review's verdict is ${r.verdict}, not PASS`;
  const file = path.resolve(dir, r.file ?? "");
  if (!r.file || !fs.existsSync(file)) return `the final review file ${r.file} does not exist`;
  const said = readReview(file);
  if (said.verdict !== "PASS") return `${r.file} does not say Verdict: PASS (it says ${said.verdict || "nothing"})`;
  if (said.opsHash !== r.opsHash) return `${r.file} names ops hash ${said.opsHash ?? "(none)"}, progress.json ${r.opsHash}`;
  if (r.opsHash !== now) return `the delivered ops changed after the final review (reviewed ${String(r.opsHash).slice(0, 12)}, now ${String(now).slice(0, 12)}): review again`;
  return reviewIdentityBlock(dir, said, r.file);
}

// ---------------------------------------------------------------------------------------------------------------------
// Gate 16: the design. design.json, its hash, its faults (with the catalogue check) and the recorded design review.

export const DESIGN_FILE = "design.json";
/** Story elements a place must state, by tier: a pinpoint shrine two, a large district eight. */
export const DESIGN_MIN_ELEMENTS = { pinpoint: 2, small: 3, medium: 5, large: 8 };
const MADE_OF = /^(structure|terrain|creature|decal|water|text|light):\s*\S/;

/** design.json as written, null when absent, { __error } when not JSON. */
export function readDesign(dir) {
  const f = path.join(dir, DESIGN_FILE);
  if (!fs.existsSync(f)) return null;
  try { return readJson(f); } catch (e) { return { __error: e.message }; }
}

/** One hash over design.json and every sample frame it names: editing either re-opens the design review. */
/** Top-level design.json fields that record a coordinator ruling or bookkeeping, not the design: editing them never stales a
 *  review (L o-small 2026-10-29: recording a size ruling in design.json re-opened a design review twice). */
export const DESIGN_RULING_KEY = (k) => k === "size" || /Ruling$/.test(k);
/** design.json without its ruling fields, canonical: what a design review judges. */
export function designBody(design) {
  return JSON.stringify(Object.fromEntries(Object.entries(design).filter(([k]) => !DESIGN_RULING_KEY(k))));
}
/** Where `design-review` FREEZES a sample frame: reviews/<place>/<file> (overwritten in place). r-found 2026-10-31
 *  (coordinator ruling): the sample frames are the place's ordinary shots (evidence/<lab>/avenue-12.png), so every later
 *  `place-build shots` rewrote them and re-opened a design nobody had changed (Red Dial failed gate 16 for 12 rounds). */
export const frozenSample = (dir, shot) => path.join(dir, "reviews", path.basename(path.resolve(dir)), path.basename(shot));
/**
 * Gate 16's design hash: design.json's body + each sample frame. A frame is read from its FROZEN copy (frozenSample) when
 * a review froze one, else from the live shot; the key stays the shot's own path, so a frozen copy of the same picture
 * hashes the same. `live: true` reads the live shots (what a reviewer is shown: `job.mjs design` prints it, and
 * `design-review` checks the review against it before freezing). A changed design.json always re-opens the review.
 */
export function designHash(dir, design = readDesign(dir), { legacy = false, live = false } = {}) {
  const f = path.join(dir, DESIGN_FILE);
  if (!design || design.__error || !fs.existsSync(f)) return null;
  const shots = Array.isArray(design.sample?.shots) ? design.sample.shots.filter((s) => typeof s === "string") : [];
  // legacy: the raw file bytes (reviews recorded before the ruling fields were left out still match their design)
  const parts = [`${DESIGN_FILE}\0${legacy ? sha(fs.readFileSync(f)) : sha(designBody(design))}`];
  for (const s of shots) {
    const fz = frozenSample(dir, s), p = !live && fs.existsSync(fz) ? fz : path.resolve(dir, s);
    parts.push(`${s}\0${fs.existsSync(p) ? sha(fs.readFileSync(p)) : "missing"}`);
  }
  return sha(parts.join("\n"));
}
/** Freeze the design's sample frames under reviews/<place>/ (overwritten in place; no numbered copies). Returns their paths. */
export function freezeDesignSample(dir, design = readDesign(dir)) {
  const shots = Array.isArray(design?.sample?.shots) ? design.sample.shots.filter((s) => typeof s === "string") : [];
  const out = [];
  for (const s of shots) {
    const p = path.resolve(dir, s); if (!fs.existsSync(p)) continue;
    const fz = frozenSample(dir, s); fs.mkdirSync(path.dirname(fz), { recursive: true }); fs.copyFileSync(p, fz);
    out.push(path.relative(dir, fz).split(path.sep).join("/"));
  }
  return out;
}

/** The playground folder (the one holding projects/) and the project a job dir lives in, or nulls. */
function projectOf(dir) {
  const parts = path.resolve(dir).split(path.sep), i = parts.lastIndexOf("projects");
  if (i < 1 || !parts[i + 1]) return { playground: null, project: null };
  return { playground: parts.slice(0, i).join(path.sep), project: parts[i + 1] };
}
/** Every catalogued prop id in the job's project closure (project.json dependsOn; authoring/prop-catalogs.json rows with prefabIds, and every catalogue's dressing sidecar ids), or null when the job is not inside a project. */
export function catalogueIds(dir) {
  const { playground, project } = projectOf(dir);
  if (!playground) return null;
  const ids = new Set(), seen = new Set();
  const visit = (name) => {
    if (seen.has(name)) return;
    seen.add(name);
    const pd = path.join(playground, "projects", name);
    for (const d of tryJson(path.join(pd, "project.json"))?.dependsOn ?? []) visit(d);
    for (const c of tryJson(path.join(pd, "authoring", "prop-catalogs.json"))?.catalogs ?? []) {
      // a collection catalogued by its output files (entries "outputs", no prefabIds: rural-props) names its prefabs in its
      // dressing sidecar (`props` keyed by prefab id), the list `props menu` offers (RETTING 2026-10-23: the quest stook
      // rural-props/hay-bale was refused as "not in the closure's catalogues")
      if (c.dressing) for (const id of Object.keys(tryJson(path.join(pd, c.dressing))?.props ?? {})) if (id.includes("/")) ids.add(id);
      if (!c.prefabIds) continue;
      const rows = tryJson(path.join(pd, c.path))?.[c.entries ?? "props"];
      const list = Array.isArray(rows) ? rows : rows && typeof rows === "object" ? Object.entries(rows).map(([id, v]) => ({ id, ...(v ?? {}) })) : [];
      for (const r of list) if (r?.id) ids.add(String(r.id));
    }
  };
  visit(project);
  return ids;
}
/** The tier the element floor is read from: brief.json adventureSize, else the handoff's, else small. */
function tierOfJob(dir) {
  const b = tryJson(path.join(dir, "brief.json")), h = tryJson(path.join(dir, "handoff.json"));
  const t = String(b?.adventureSize ?? h?.adventureSize ?? h?.tier ?? "small").toLowerCase();
  return DESIGN_MIN_ELEMENTS[t] ? t : "small";
}
/** The share of a design's props that may be custom-made for the place (owner ruling 2026-10-23: 60% reusable). */
export const REUSE_CUSTOM_MAX = 0.4;
/** Prop ids made for THIS place: the project's prop-requests.json rows whose `for` is this poi and that were made (their `made` id). */
export function customPropsFor(dir) {
  const { playground, project } = projectOf(dir);
  const out = new Set();
  if (!playground) return out;
  const poi = tryJson(progressFile(dir))?.poiId ?? tryJson(path.join(dir, "brief.json"))?.id ?? path.basename(dir);
  const reqs = tryJson(path.join(playground, "projects", project, "authoring", "dressing", "prop-requests.json"));
  for (const r of Array.isArray(reqs) ? reqs : reqs?.requests ?? []) if (r?.for === poi && typeof r.made === "string" && r.made.includes("/")) out.add(r.made);
  return out;
}
/** A reference frame path: under the job dir, else under the playground folder, else absolute. */
function resolveRef(dir, r) {
  const { playground } = projectOf(dir);
  for (const p of [path.resolve(dir, r), ...(playground ? [path.resolve(playground, r)] : []), path.resolve(r)]) if (fs.existsSync(p)) return p;
  return null;
}

/**
 * The job's art mode from its project's world order (`authoring/stages/<world>.json`, apps/playground/tools/world-order.mts
 * `artOf`): the place's `art`, else a small / roadside / camp POI is "catalogue" and everything else "painted" (Derek
 * 2026-10-29: small places get no concept art and no new props). Null when no staged world knows the place. Read from
 * the world order, never from design.json: a design cannot excuse itself from its concept frame.
 */
export function jobArt(dir) {
  const { playground, project } = projectOf(dir);
  if (!playground) return null;
  const poi = tryJson(progressFile(dir))?.poiId ?? tryJson(path.join(dir, "brief.json"))?.id ?? path.basename(dir);
  const stages = path.join(playground, "projects", project, "authoring", "stages");
  if (!fs.existsSync(stages)) return null;
  for (const f of fs.readdirSync(stages).filter((x) => x.endsWith(".json"))) {
    const p = (tryJson(path.join(stages, f))?.places ?? []).find((x) => x?.id === poi || x?.name === poi);
    if (p) return p.art ?? (p.kind === "poi" && /small|roadside|camp/.test(String(p.role ?? "")) ? "catalogue" : "painted");
  }
  return null;
}

/** A design review PASS is on record for the job (its concept frames were judged before the concept-on-site rule or on it). */
function designReviewed(dir) {
  const p = tryJson(progressFile(dir));
  return !!p?.designReview && String(p.designReview.verdict).toUpperCase() === "PASS";
}
/** The world-order ledger (<project>/authoring/stages/<world>.json, zonegen stages) records this place's concept as
 *  approved and its design as reviewed: the stage machine owns ground freshness from then on (it marks the place STALE
 *  and refuses place-build when the LOCAL ground moves), so gate 16 stops re-judging the frames against a whole-world
 *  fingerprint. L (Red Dial 2026-10-29: a woodland pass elsewhere in the world blocked a reviewed place's build). */
function stageReviewed(dir) {
  const { playground, project } = projectOf(dir), parts = path.resolve(dir).split(path.sep), zi = parts.lastIndexOf("zonegen");
  if (!playground || !project || zi < 0 || !parts[zi + 1]) return false;
  const ledger = tryJson(path.join(playground, "projects", project, "authoring", "stages", `${parts[zi + 1]}.json`));
  const place = (ledger?.places ?? []).find((q) => q?.id === jobSite(dir).poi);
  return !!place?.stages?.["concept-approved"] && !!place?.stages?.["design-review"];
}

/**
 * What is wrong with design.json (gate 16), as a list; empty when it holds everything a design review needs.
 * `sample: false` checks the written design alone (what a builder needs BEFORE it builds anything: the sample frames
 * come from the build); the review and the install check the whole file.
 */
export function designFaults(dir, design = readDesign(dir), { sample = true } = {}) {
  const out = [];
  if (!design) return [`no ${DESIGN_FILE}: the owner writes premise, journey[], areas[], elements[], sample { area, shots[] } and reference[] before the place expands`];
  if (design.__error) return [`${DESIGN_FILE} is not JSON: ${design.__error}`];
  const str = (v, n) => typeof v === "string" && v.trim().length >= n;
  if (!str(design.premise, 20) || design.premise.length > 400) out.push("premise: one or two sentences (20-400 characters) saying what this place is, who is there and why");
  const journey = Array.isArray(design.journey) ? design.journey.filter((s) => str(s, 10)) : [];
  if (journey.length < 3) out.push("journey: at least 3 steps (strings), from the road to the payoff and out, each a sentence");
  const tier = tierOfJob(dir), minEl = DESIGN_MIN_ELEMENTS[tier];
  const elements = Array.isArray(design.elements) ? design.elements : [];
  const ids = new Set(), cat = catalogueIds(dir);
  for (const [i, e] of elements.entries()) {
    const tag = `elements[${i}]${e?.id ? ` ${e.id}` : ""}`;
    if (!e || !str(e.id, 2)) { out.push(`${tag}: needs an id`); continue; }
    if (ids.has(e.id)) out.push(`${tag}: duplicate id`);
    ids.add(e.id);
    if (!str(e.shows, 8)) out.push(`${tag}: shows — what the occupants do or what happened here, in a sentence`);
    const made = Array.isArray(e.madeOf) ? e.madeOf.filter((m) => typeof m === "string" && m.trim()) : [];
    if (!made.length) out.push(`${tag}: madeOf — the catalogue prop ids ("<collection>/<id>") or "structure: ...", "creature: ...", "decal: ...", "terrain: ..." it is built from`);
    for (const m of made) {
      if (MADE_OF.test(m)) continue;
      if (!m.includes("/")) { out.push(`${tag}: madeOf "${m}" is neither a catalogue prop id (<collection>/<id>) nor structure:/creature:/decal:/terrain:/water:/text:/light:`); continue; }
      if (cat && !cat.has(m)) out.push(`${tag}: prop "${m}" is not in the project closure's catalogues (props menu): a missing prop is a prop request, and the element needs something that exists`);
    }
  }
  if (elements.length < minEl) out.push(`elements: ${elements.length} of at least ${minEl} for a ${tier} place — each a thing the player sees that tells the story`);
  const areas = Array.isArray(design.areas) ? design.areas : [], minAreas = tier === "pinpoint" ? 1 : 2, areaIds = new Set();
  for (const [i, a] of areas.entries()) {
    const tag = `areas[${i}]${a?.id ? ` ${a.id}` : ""}`;
    if (!a || !str(a.id, 2)) { out.push(`${tag}: needs an id`); continue; }
    areaIds.add(a.id);
    if (!str(a.purpose, 8)) out.push(`${tag}: purpose — what happens in this area, in a sentence`);
    const held = Array.isArray(a.elements) ? a.elements : [];
    if (!held.length) out.push(`${tag}: elements — which story elements stand here (ids)`);
    for (const h of held) if (!ids.has(h)) out.push(`${tag}: element "${h}" is not in elements[]`);
  }
  if (areas.length < minAreas) out.push(`areas: ${areas.length} of at least ${minAreas} for a ${tier} place — the functional layout (where people enter, work, gather, leave)`);
  const placed = new Set(areas.flatMap((a) => (Array.isArray(a?.elements) ? a.elements : [])));
  for (const id of ids) if (!placed.has(id)) out.push(`element "${id}" stands in no area`);
  // a catalogue place (world order art mode) has no concept painting and no sample-before-repeat stage: it is built
  // from catalogue props in one go and the grey-box / final review judge the built frames (L o-small 2026-10-29: the
  // design gate demanded a concept frame the world order had ruled out)
  // a job dir outside a project (a --job copy in a scratch lab) has no stages ledger: its design.json `art` says it
  const catalogue = (jobArt(dir) ?? design.art) === "catalogue";
  const s = design.sample;
  if (!sample || (catalogue && !s)) { /* before the build, or a catalogue place: no sample frames asked for */ }
  else if (!s || typeof s !== "object" || !str(s.area, 2)) out.push("sample: { area, shots[] } — the ONE area finished to the bar before anything repeats, with its player-height frames");
  else {
    if (!areaIds.has(s.area)) out.push(`sample.area "${s.area}" is not in areas[]`);
    const shots = Array.isArray(s.shots) ? s.shots.filter((x) => typeof x === "string") : [];
    if (!shots.length) out.push("sample.shots: at least one player-height frame of the finished area (a path under the job dir)");
    for (const sh of shots) if (!fs.existsSync(path.resolve(dir, sh))) out.push(`sample shot ${sh} does not exist`);
  }
  const refs = Array.isArray(design.reference) ? design.reference.filter((x) => typeof x === "string") : [];
  if (!refs.length) out.push("reference: at least one owner-approved reference frame the sample is judged against (P5)");
  for (const r of refs) if (!resolveRef(dir, r)) out.push(`reference ${r} does not exist (a path under the job dir or under the playground folder)`);
  // the concept frame (owner ruling 2026-10-11, reaffirmed 2026-10-23 "ask image gen for a poi reference image"): drawn from the
  // premise BEFORE the build (image-request.mjs gen, the zone's concept frames as --ref); the build composes to it, the reviewer
  // holds the sample frames beside it (P5)
  const concepts = Array.isArray(design.concept) ? design.concept.filter((x) => typeof x === "string") : [];
  if (!concepts.length && !catalogue) out.push(`concept: at least one concept frame drawn from the premise before the build, painted on a render of the bare site (${CONCEPT_COMMAND}; it writes <zone>/concept/<id>-approach.png and -far.png)`);
  for (const c of concepts) if (!resolveRef(dir, c)) out.push(`concept frame ${c} does not exist`);
  // L (Wristgate 2026-10-29: every firstshore concept was drawn from TEXT; Codex invented a cliff tall enough for a 50 m
  // gate on a 40 m gorge and the owner built to it): a NEW job's concept frames (no design review PASS recorded yet) count
  // only as repaints of a render of the bare site made by `zonegen concept` for the same reservation, on the ground as it
  // is now (concept-site.mjs). A job whose design was already reviewed keeps its frames until the design re-opens.
  if (concepts.length && !designReviewed(dir) && !stageReviewed(dir)) {
    const site = jobSite(dir), { playground } = projectOf(dir);
    for (const f of concepts.map((c) => resolveRef(dir, c)).filter(Boolean)) { const why = conceptSiteFault(f, site, playground ?? undefined); if (why) out.push(why); }
  }
  // owner ruling 2026-10-23 ("not everything should be custom props... 60% should be leveraging reusable props"): of the catalogue
  // props the elements are made of, those made FOR THIS PLACE (prop-requests.json `for` = this poi, or not in any catalogue =
  // a request to come) are at most 40%; the rest is the world's reusable props and kits (tents, huts, racks, carts, boats, bones)
  const props = [...new Set(elements.flatMap((e) => (Array.isArray(e?.madeOf) ? e.madeOf : [])).filter((m) => typeof m === "string" && !MADE_OF.test(m) && m.includes("/")))];
  if (props.length >= 3) {
    const mine = customPropsFor(dir);
    const custom = props.filter((p) => mine.has(p) || (cat && !cat.has(p)));
    if (custom.length / props.length > REUSE_CUSTOM_MAX) out.push(`reuse: ${custom.length} of ${props.length} props are custom for this place (${custom.slice(0, 5).join(", ")}${custom.length > 5 ? ", ..." : ""}); at least ${Math.round((1 - REUSE_CUSTOM_MAX) * 100)}% must be the world's reusable props and kits (tents, huts, racks, carts, boats, bones: props menu) — custom props are the few that carry what the story cannot say otherwise`);
  }
  return out;
}

/** Gate 16: why the place may not expand or install — no design, a faulty one, no fresh reviewer's PASS on its sample, or a
 *  design edited since. `sample: false` (the install path, SHOT_ROWS): the sample frames are not asked for (they come from
 *  the batch render after the install); a recorded review still has to name this design. */
export function designBlock(dir, p, { sample = true } = {}) {
  const design = readDesign(dir);
  const faults = designFaults(dir, design, { sample });
  if (faults.length) return `the design gate failed (gate 16): ${faults.slice(0, 4).join("; ")}${faults.length > 4 ? `; +${faults.length - 4} more (job.mjs design ${dir})` : ""}`;
  if (p === undefined) p = fs.existsSync(progressFile(dir)) ? loadProgress(dir) : {};
  const now = designHash(dir, design);
  // the owner's hand-written override (progress.json ownerApproval, as for the install) passes gate 16 when it names THIS
  // design: { by: "derek", note, designHash }. L (o-smalls 2026-10-30, coordinator: Derek approves the redstrand places himself, no reviewer)
  const oa = p?.ownerApproval;
  if (oa && typeof oa === "object" && String(oa.by).toLowerCase() === "derek" && typeof oa.note === "string" && oa.note.trim().length >= 3 && oa.designHash === now) return null;
  const r = p?.designReview;
  if (!r || typeof r !== "object") return `no design review recorded (gate 16): a fresh reviewer answers the Place lines ${designCodes().join(", ")} on the sample area's frames (Design hash: ${now}) and job.mjs design-review ${dir} --file <review> records it`;
  if (String(r.verdict).toUpperCase() !== "PASS") return `the design review's verdict is ${r.verdict}, not PASS (gate 16): fix the design or the sample and review again`;
  const file = path.resolve(dir, r.file ?? "");
  if (!r.file || !fs.existsSync(file)) return `the design review file ${r.file} does not exist (gate 16)`;
  const said = readReview(file);
  if (said.verdict !== "PASS") return `${r.file} does not say Verdict: PASS (it says ${said.verdict || "nothing"}) (gate 16)`;
  // a back-filled review keeps the hash its reviewer named as reviewedHash (backfillDesignSample)
  if (said.designHash !== (r.reviewedHash ?? r.designHash)) return `${r.file} names design hash ${said.designHash ?? "(none)"}, progress.json ${r.reviewedHash ?? r.designHash} (gate 16)`;
  if (r.designHash !== now && r.designHash !== designHash(dir, design, { legacy: true })) return `the design or its sample frames changed after the design review (reviewed ${String(r.designHash).slice(0, 12)}, now ${String(now).slice(0, 12)}): review again (gate 16)`;
  return reviewIdentityBlock(dir, said, r.file, { codes: designCodes(), gate: 16, sections: "Place" });
}

/** Record the design review from its file (gate 16). Throws when it names another design hash, no fresh reviewer, or leaves a Place line unanswered. A FAIL is recorded too. */
export function recordDesignReview(dir, file) {
  const rel = path.relative(dir, path.resolve(file)).replaceAll("\\", "/");
  const faults = designFaults(dir);
  if (faults.length) throw new Error(`${DESIGN_FILE} is not reviewable yet (gate 16): ${faults.slice(0, 4).join("; ")}`);
  const said = readReview(path.resolve(file));
  // the reviewer judged the LIVE frames (job.mjs design prints that hash); they are frozen below once the review is recorded
  const now = designHash(dir, undefined, { live: true });
  if (!said.designHash) throw new Error(`${rel} names no design hash: the reviewer writes "Design hash: ${now}" (job.mjs design) in it`);
  if (said.designHash !== now && said.designHash !== designHash(dir, undefined, { legacy: true, live: true })) throw new Error(`${rel} reviewed design ${said.designHash.slice(0, 12)}, the job's design is ${String(now).slice(0, 12)} now`);
  const who = reviewIdentityBlock(dir, said, rel, { codes: designCodes(), gate: 16, sections: "Place" });
  if (who) throw new Error(who);
  const p = loadProgress(dir);
  const frozen = freezeDesignSample(dir);
  p.designReview = { file: rel, verdict: said.verdict, designHash: said.designHash, reviewer: said.reviewer, answered: Object.keys(said.answers).length, at: new Date().toISOString(), ...(frozen.length ? { frozen } : {}) };
  saveProgress(dir, p);
  return p.designReview;
}

/**
 * BACK-FILL the frozen sample for a review recorded before reviews froze their frames (r-found 2026-10-31, coordinator
 * ruling): the frames that review saw were overwritten by later shots, so its hash can never be met again. Allowed only
 * when design.json ALONE proves the design body is the reviewed one: the file was last written no later than the review
 * was recorded (recordDesignReview checked the review against exactly that body; a copy or checkout only makes the time
 * newer, which refuses). Freezes the CURRENT sample frames, keeps the reviewer's named hash as `reviewedHash`, and binds
 * `designHash` to design.json + the frozen frames. Needs a dated ruling. A later design.json edit re-opens it as usual.
 */
export function backfillDesignSample(dir, ruling) {
  if (typeof ruling !== "string" || !DATED_RULING.test(ruling) || ruling.replace(DATED_RULING, "").replace(/[\s,:;-]/g, "").length < 8) throw new Error(`design-backfill needs --ruling "YYYY-MM-DD who: why" (a dated ruling)`);
  const p = loadProgress(dir), r = p.designReview;
  if (!r || typeof r !== "object" || String(r.verdict).toUpperCase() !== "PASS") throw new Error("design-backfill: no PASS design review recorded to back-fill");
  if (r.frozen?.length) throw new Error(`design-backfill: the review already froze its frames (${r.frozen.join(", ")})`);
  const reviewedAt = Date.parse(r.at ?? ""), written = fs.statSync(path.join(dir, DESIGN_FILE)).mtimeMs;
  if (!Number.isFinite(reviewedAt)) throw new Error("design-backfill: the review has no time recorded (progress.json designReview.at)");
  if (written > reviewedAt) throw new Error(`design-backfill refused: ${DESIGN_FILE} was written ${new Date(written).toISOString()}, after the review (${r.at}): the reviewed body is not proven; review again`);
  const frozen = freezeDesignSample(dir);
  p.designReview = { ...r, reviewedHash: r.reviewedHash ?? r.designHash, designHash: designHash(dir), frozen, backfill: { at: new Date().toISOString(), ruling, proof: `${DESIGN_FILE} last written ${new Date(written).toISOString()}, review recorded ${r.at}` } };
  saveProgress(dir, p);
  return p.designReview;
}

/** The zone folder a job lives in (zones/<z>/pois/<...>/<job>) or null. */
function zoneDirOf(dir) {
  for (let d = path.resolve(dir); path.dirname(d) !== d; d = path.dirname(d)) if (path.basename(path.dirname(d)) === "pois") return path.dirname(path.dirname(d));
  return null;
}
const tryJson = (f) => { try { return fs.existsSync(f) ? readJson(f) : null; } catch { return null; } };

const isBridgeJob = (dir) => !!tryJson(path.join(dir, "bridge.json"))?.bridge;
/** A crossing job measured from its own reports (size-tiers CROSSING): span, clearance, seated, read-* views, end landmark. */
function crossingMeasure(dir) {
  const rb = tryJson(path.join(dir, "reports", "bridge.json")) ?? {}, r = rb.report ?? {}, ends = rb.ends ?? {};
  const seatedRep = tryJson(path.join(dir, "reports", "seated.json"));
  const A = ends.start, B = ends.end, deckY = Number(r.deckY ?? (A ? A[1] : 0));
  const segD = (x, z) => { if (!A || !B) return 0; const dx = B[0] - A[0], dz = B[2] - A[2], L = dx * dx + dz * dz || 1, k = Math.max(0, Math.min(1, ((x - A[0]) * dx + (z - A[2]) * dz) / L)); return Math.hypot(x - A[0] - k * dx, z - A[2] - k * dz); };
  const pics = new Set();
  const scan = (d) => { let es = []; try { es = fs.readdirSync(d, { withFileTypes: true }); } catch { return; } for (const e of es) e.isDirectory() ? scan(path.join(d, e.name)) : pics.add(e.name); };
  scan(path.join(dir, "evidence"));
  const views = tryJson(path.join(dir, "views.json")) ?? [];
  const reads = (Array.isArray(views) ? views : []).filter((v) => typeof v?.name === "string" && v.name.startsWith("read-")).map((v) => {
    const c = Array.isArray(v.camera) ? [v.camera[0], v.camera[2]] : [v.x, v.z];
    const end = A && B && Math.hypot(c[0] - A[0], c[1] - A[2]) <= Math.hypot(c[0] - B[0], c[1] - B[2]) ? "start" : "end";
    return { name: v.name, end, distanceM: Math.round(segD(c[0], c[1]) * 10) / 10, picture: pics.has(`${v.name}-12.png`) };
  });
  const ground = Math.min(...(r.piers ?? []).map((p) => Number(p.groundMin)).filter(Number.isFinite), deckY);
  const roads = (tryJson(path.join(dir, "bridge.json"))?.roads ?? []).length;
  return { spanM: Number(r.span ?? 0), clearanceM: Math.round((deckY - ground) * 10) / 10, seated: seatedRep ? seatedRep.ok === true : null, reads, endHeightM: Number.isFinite(r.towerTop) ? Math.round((r.towerTop - deckY) * 10) / 10 : 0, roads };
}

/** The job's size tier: brief.json adventureSize, handoff measurements, else the zone brief place / quest location. */
export function jobTier(dir) {
  const brief = tryJson(path.join(dir, "brief.json")), hand = tryJson(path.join(dir, "handoff.json")) ?? {}, prog = tryJson(progressFile(dir)) ?? {};
  const id = prog.poiId ?? hand.poiId ?? brief?.id ?? path.basename(dir);
  const zd = zoneDirOf(dir);
  const place = zd ? (tryJson(path.join(zd, "brief.json"))?.places ?? []).find((x) => x.id === id) : null;
  const loc = zd ? (tryJson(path.join(zd, "quests.json"))?.locations ?? []).find((x) => x.id === id) : null;
  const res = zd ? (tryJson(path.join(zd, "reservations.json"))?.reservations ?? []).find((x) => x.location === id) : null;
  // a bridge job (place-build `bridge`: bridge.json { bridge }) is a crossing whatever size the plan named (size-tiers CROSSING)
  const tier = isBridgeJob(dir) ? "crossing" : [brief?.adventureSize, hand.measurements?.adventureSize, place?.size, loc?.size].find((s) => TIER_NAMES.includes(s)) ?? null;
  return { id, tier, reservation: res ?? null };
}

const isXZ = (v) => Array.isArray(v) && (v.length === 2 || v.length === 3) && v.every((n) => typeof n === "number" && Number.isFinite(n));
const xz = (v) => (v.length === 3 ? [v[0], v[2]] : [v[0], v[1]]);
const SKIP_KEYS = new Set(["heights", "parts", "source", "materials", "roles", "colors", "weights", "center", "at", "origin", "blend", "size"]);
/** The approach track's plain tread: up to this width it is arrival, not footprint (gate 12). */
export const APPROACH_TREAD_M = 4;
/** World-space [x, z] points of everything a job delivers (scene root entities, clearings, patches, paths, landmarks). */
export function footprintPoints(dir) {
  const pts = [], built = [];
  const entities = new Map();
  const ring = (c, r) => { const [x, z] = xz(c); pts.push([x, z]); if (r > 0) pts.push([x + r, z], [x - r, z], [x, z + r], [x, z - r]); };
  const walk = (v) => {
    if (Array.isArray(v)) {
      if (v.length >= 2 && v.every(isXZ) && v.every((q) => q.length === v[0].length)) { for (const q of v) pts.push(xz(q)); return; }
      for (const x of v) walk(x);
      return;
    }
    if (!v || typeof v !== "object") return;
    if (v.op === "landmark" && isXZ(v.at)) {
      const [ax, az] = xz(v.at), a = ((v.yaw ?? 0) * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a);
      pts.push([ax, az]);
      for (const q of Array.isArray(v.blend?.area) ? v.blend.area : []) if (isXZ(q)) { const [lx, lz] = xz(q); pts.push([ax + lx * c - lz * s, az + lx * s + lz * c]); }
      return;
    }
    if (isXZ(v.center)) ring(v.center, Number(v.radius ?? v.r ?? 0) || 0);
    if (isXZ(v.at)) pts.push(xz(v.at));
    if (isXZ(v.origin) && Array.isArray(v.size) && v.size.length === 2) {
      const [ox, oz] = xz(v.origin), cols = Number(v.columns), rows = Number(v.rows);
      // L (o-wild3 2026-11-02): a MASKED height patch (per-sample `weights`) edits only where its weight is above zero.
      // Its rectangle's corners put a round 42 m camp pad in a 46 x 46 m box, 65 m corner to corner, over the pinpoint
      // maximum. Measure the samples it really moves, widened by the tent filter that spreads the mask (packages/core height-patch)
      if (Array.isArray(v.weights) && cols >= 2 && rows >= 2 && v.weights.length === cols * rows) {
        const cx = v.size[0] / (cols - 1), cz = v.size[1] / (rows - 1), f = Number(v.filter ?? 0) || 0;
        for (let j = 0; j < rows; j++) for (let i = 0; i < cols; i++) {
          if (!(Number(v.weights[j * cols + i]) > 0)) continue;
          const x = ox + i * cx, z = oz + j * cz;
          pts.push([x, z]);
          if (f > 0) pts.push([x + f, z], [x - f, z], [x, z + f], [x, z - f]);
        }
      } else pts.push([ox, oz], [ox + v.size[0], oz + v.size[1]]);
    }
    for (const [k, x] of Object.entries(v)) if (!SKIP_KEYS.has(k)) walk(x);
  };
  // L (Wristgate 2026-10-29, coordinator ruling): a vegetation clearing wholly OUTSIDE the job's reservation (sight-line
  // tree cuts on the moor 40-160 m past the rim) is vegetation, not built footprint: it never stretches the hull
  const res = jobTier(dir).reservation;
  const approachHeld = [], isApproachId = (id) => typeof id === "string" && (/^road-pb-.+-approach$/.test(id) || /-lane-(cover-)?approach$/.test(id));
  const outside = (c) => !!res && Array.isArray(res.center) && isXZ(c?.center) && Math.hypot(xz(c.center)[0] - res.center[0], xz(c.center)[1] - res.center[1]) - (Number(c.radius) || 0) > (Number(res.radius) || 0);
  for (const f of deliveredOps(dir)) {
    if (/\.landmark\.json$/i.test(f)) continue; // a landmark's own parts are in its local frame
    let j = tryJson(path.join(dir, f));
    if (!j) continue;
    if (f === "clearings.json" && Array.isArray(j)) j = j.filter((c) => !outside(c));
    // L (o-coast drowned-mole 2026-10-31): a place-build VIEW CUT (layout clearing `sightline: true`, id `<poi>-sightline-<id>`)
    // clears trees on the line the player sees the landmark along; like the approach, it is not ground of the place
    if (f === "clearings.json" && Array.isArray(j)) j = j.filter((c) => !(typeof c?.id === "string" && /-sightline-[a-z0-9-]+$/.test(c.id)));
    // L (o-coast drowned-mole 2026-10-31, coordinator ruling): the APPROACH is ARRIVAL, not the place: the place-build
    // approach track (`road-pb-<id>-approach`) and its lane clearings (`<id>-lane-(cover-)approach`) are held out of the
    // hull, inside the reservation disc or not; whether they stay out is decided below (a 4 m tread, nothing built on it)
    if (Array.isArray(j)) j = j.filter((o) => { const id = o?.feature?.id ?? o?.id; if (!isApproachId(id)) return true; approachHeld.push(o); return false; });
    const ops = Array.isArray(j) ? j : j.ops;
    if (Array.isArray(ops) && ops.some((o) => o?.op === "add-entity")) {
      for (const o of ops) {
        const e = o?.op === "add-entity" ? o.entity ?? o : null;
        if (e) entities.set(o.id, e);
      }
    } else walk(j);
  }
  // A dressing root at the origin is an identity container, not a place at (0,0).
  // Measure its actual contents through their parent transforms instead. Missing
  // external parents cannot be resolved from this delivery and are not guessed.
  for (const [id, entity] of entities) {
    let p = [0, 0, 0], current = id;
    const seen = new Set();
    while (current != null && entities.has(current) && !seen.has(current)) {
      seen.add(current);
      const e = entities.get(current), t = e.components?.transform ?? {};
      const s = t.scale ?? [1, 1, 1], q = t.rotation ?? [0, 0, 0, 1];
      const v = p.map((n, k) => n * s[k]);
      const u = [q[1] * v[2] - q[2] * v[1], q[2] * v[0] - q[0] * v[2], q[0] * v[1] - q[1] * v[0]];
      const uu = [q[1] * u[2] - q[2] * u[1], q[2] * u[0] - q[0] * u[2], q[0] * u[1] - q[1] * u[0]];
      const at = t.position?.length === 2 ? [t.position[0], 0, t.position[1]] : t.position ?? [0, 0, 0];
      p = v.map((n, k) => n + 2 * (q[3] * u[k] + uu[k]) + at[k]);
      current = e.parent;
    }
    if (current != null || !p.every(Number.isFinite)) continue;
    const physical = Object.keys(entity.components ?? {}).some(k => !["transform", "culling", "landmark"].includes(k));
    if (physical || p.some(n => n !== 0)) { pts.push([p[0], p[2]]); built.push([p[0], p[2]]); }
  }
  // the approach stays ARRIVAL only while it is a plain tread: at most APPROACH_TREAD_M wide and no built piece on it
  // (a piece within half the tread of its line); a wider track or one built along counts in full, so it cannot hide sprawl
  const track = approachHeld.map((o) => o?.feature ?? o).find((f) => /^road-pb-.+-approach$/.test(f?.id ?? "") && Array.isArray(f.points));
  if (track) {
    const w = Number(track.width ?? APPROACH_TREAD_M), line = track.points.filter(isXZ).map(xz);
    const on = (q) => line.some((a, i) => { const b = line[i + 1]; if (!b) return Math.hypot(q[0] - a[0], q[1] - a[1]) <= w / 2; const dx = b[0] - a[0], dz = b[1] - a[1], L2 = dx * dx + dz * dz || 1, t = Math.max(0, Math.min(1, ((q[0] - a[0]) * dx + (q[1] - a[1]) * dz) / L2)); return Math.hypot(q[0] - a[0] - t * dx, q[1] - a[1] - t * dz) <= w / 2; });
    if (w > APPROACH_TREAD_M || built.some(on)) for (const o of approachHeld) walk(o);
  }
  // a dressing-only job's footprint is its declared dressing areas (handoff.siteDressing.areas[] { centre, radius })
  const hand = tryJson(path.join(dir, "handoff.json")) ?? {};
  for (const ar of Array.isArray(hand.siteDressing?.areas) ? hand.siteDressing.areas : []) { const c = ar?.centre ?? ar?.center; if (isXZ(c)) ring(c, Number(ar.radius ?? 0) || 0); }
  return pts;
}

/** Convex hull (monotone chain) of [x, z] points: its widest span and its area. */
export function hullMeasure(points) {
  const p = [...new Map(points.map((q) => [`${q[0].toFixed(2)},${q[1].toFixed(2)}`, q])).values()].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (p.length < 2) return { diameter: 0, area: 0 };
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lo = [], hi = [];
  for (const q of p) { while (lo.length >= 2 && cross(lo.at(-2), lo.at(-1), q) <= 0) lo.pop(); lo.push(q); }
  for (const q of [...p].reverse()) { while (hi.length >= 2 && cross(hi.at(-2), hi.at(-1), q) <= 0) hi.pop(); hi.push(q); }
  const h = [...lo.slice(0, -1), ...hi.slice(0, -1)];
  let diameter = 0, area = 0;
  for (let i = 0; i < h.length; i++) {
    for (let j = i + 1; j < h.length; j++) diameter = Math.max(diameter, Math.hypot(h[i][0] - h[j][0], h[i][1] - h[j][1]));
    const a = h[i], b = h[(i + 1) % h.length];
    area += a[0] * b[1] - b[0] * a[1];
  }
  return { diameter, area: Math.abs(area) / 2 };
}

const ENCOUNTER_RE = /(^|-)(enc|pack|packs|lair|camp|den)(-|$)/i;
/** What ONE job delivers, measured (no children, no judging). */
function measureOwn(dir) {
  const { id, tier, reservation } = jobTier(dir);
  const hand = tryJson(path.join(dir, "handoff.json")) ?? {};
  const m = hand.measurements ?? {};
  const pts = footprintPoints(dir);
  const hull = hullMeasure(pts);
  const groups = new Set((Array.isArray(hand.populateClearings) ? hand.populateClearings : []).map((c, i) => (typeof c === "string" ? c : c?.id ?? `populate-${i}`)));
  // creature groups populate stood here: spawn areas tagged location:<id> in zones/<z>/populate/ops.json
  const zd = zoneDirOf(dir);
  const pop = zd ? tryJson(path.join(zd, "populate", "ops.json")) : null;
  for (const o of Array.isArray(pop) ? pop : []) if (o?.op === "add-entity" && o.entity?.tags?.includes(`location:${id}`)) groups.add(o.id ?? o.entity.name);
  let terrainEdits = 0;
  for (const f of deliveredOps(dir)) {
    if (/\.landmark\.json$/i.test(f)) continue;
    const j = tryJson(path.join(dir, f));
    const list = Array.isArray(j) ? j : Array.isArray(j?.ops) ? j.ops : [];
    for (const o of list) {
      if (!o || typeof o !== "object" || o.op === "add-entity" || o.op === "remove-entity" || o.op === "set-component" || o.op === "patch-component") continue;
      if (typeof o.id === "string" && ENCOUNTER_RE.test(o.id) && (isXZ(o.center) || Array.isArray(o.polygon))) groups.add(o.id);
      if (o.op || o.heights || o.kind || o.feature) terrainEdits++;
    }
  }
  const featureFaults = [];
  const features = (Array.isArray(m.features) ? m.features : []).flatMap((x, i) => {
    const r = sizeMeasurementSchema.shape.features.element.safeParse(x);
    if (!r.success) { featureFaults.push(`measurements.features[${i}] is not { id, kind, linkedTo[] } (${r.error.issues[0]?.path.join(".")}: ${r.error.issues[0]?.message})`); return []; }
    return [r.data];
  });
  const resApproaches = reservation ? 1 + (reservation.approaches?.length ?? 0) : 0;
  const measurement = {
    tier: tier ?? "pinpoint",
    footprintDiameterM: Math.round(hull.diameter * 10) / 10,
    footprintHullAreaM2: Math.round(hull.area),
    usableAreaM2: typeof m.measuredCombinedUsableAreaM2 === "number" ? m.measuredCombinedUsableAreaM2 : null,
    features,
    creatureGroups: groups.size,
    approaches: Math.max(Array.isArray(m.approaches) ? m.approaches.length : 0, resApproaches),
    terrainEdits,
    ...(tier === "crossing" ? { crossing: crossingMeasure(dir) } : {}),
  };
  return { id, tier, pts, measurement, featureFaults };
}

/** The job's parent place (brief.json / handoff.json `parent`: a dungeon door names the place it opens), or null. */
export function jobParent(dir) {
  const v = tryJson(path.join(dir, "brief.json"))?.parent ?? tryJson(path.join(dir, "handoff.json"))?.parent ?? null;
  return typeof v === "string" && v ? v : null;
}
/** Every POI job dir of the job's world (zonegen/<world>/zones/<z>/pois/<id>). */
function worldJobDirs(dir) {
  const zd = zoneDirOf(dir);
  if (!zd) return [];
  const zones = path.dirname(zd), out = [];
  const sub = (d) => { try { return fs.readdirSync(d, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => path.join(d, e.name)); } catch { return []; } };
  for (const z of sub(zones)) out.push(...sub(path.join(z, "pois")));
  return out;
}
/** The parent place and its children (jobs naming it as `parent`), measured as ONE place against the parent's tier. */
function measureFamily(pdir) {
  const own = measureOwn(pdir);
  const kids = worldJobDirs(pdir).filter((d) => path.resolve(d) !== path.resolve(pdir) && jobParent(d) === own.id).map(measureOwn);
  const noTier = `no size tier: brief.json adventureSize, handoff.measurements.adventureSize or the zone plan's place/location size must name one of ${TIER_NAMES.join(", ")}`;
  let measurement = own.measurement;
  if (kids.length) {
    const hull = hullMeasure([...own.pts, ...kids.flatMap((k) => k.pts)]);
    measurement = aggregateMeasurement(own.measurement.tier, [own.measurement, ...kids.map((k) => ({ ...k.measurement, job: k.id }))], { diameter: Math.round(hull.diameter * 10) / 10, hullArea: Math.round(hull.area) });
  }
  const all = own.tier ? [...own.featureFaults, ...measurementFaults(measurement)] : [noTier];
  const ruling = sizeRulingFor(pdir, own.id), excepted = ruling ? all.filter((f) => rulingExcepts(ruling, f, measurement)) : [];
  const faults = all.filter((f) => !excepted.includes(f));
  return { ...own, measurement, children: kids.map((k) => k.id), faults, ...(excepted.length ? { excepted: excepted.map((f) => `${f} (EXCEPTED: ${ruling.by} ${ruling.date}: ${ruling.ruling})`) } : {}) };
}

/**
 * L (Wristgate 2026-10-29): a coordinator's size ruling is recorded where gate 12 reads it, never in the owner's prose:
 * `<zone>/size-rulings.json` `{ rulings: [{ job, by, date, ruling, usableAreaM2?, keepTier? }] }` (`keepTier`: place-build keeps the
 * asked tier on ground that holds less, never downgrading it; o-gates 2026-10-30). `usableAreaM2` excepts the
 * usable-area fault only while the MEASURED area stays at or above the ruled figure (a shrunk place fails again); no
 * other fault is ever excepted. Each entry cites the dated coordinator decision it records (`ruling`).
 */
export function sizeRulingFor(dir, id) {
  const zd = zoneDirOf(dir);
  const all = zd ? tryJson(path.join(zd, "size-rulings.json"))?.rulings ?? [] : [];
  return all.find((r) => r && (r.job === id || r.job === path.basename(dir)) && typeof r.ruling === "string" && r.by) ?? null;
}
function rulingExcepts(r, fault, m) {
  return typeof r.usableAreaM2 === "number" && /^usable area \d+ m2, a \w+ place needs/.test(fault) && typeof m.usableAreaM2 === "number" && m.usableAreaM2 >= r.usableAreaM2;
}

/**
 * Gate 12's measurement: what the job delivers, against its tier. `faults` empty = meets it. A job with children (jobs
 * naming it `parent`) is measured over itself plus them; a parented job (a dungeon door) must be a pinpoint child and is
 * judged by its PARENT's tier over that aggregate (tools/poi-review/size-tiers.mjs "PARENTED JOBS").
 */
export function measureSize(dir) {
  const parent = jobParent(dir);
  if (!parent) {
    const f = measureFamily(dir);
    return { id: f.id, tier: f.tier, points: f.pts.length, measurement: f.measurement, ...(f.children.length ? { children: f.children } : {}), faults: f.faults, ...(f.excepted ? { excepted: f.excepted } : {}), ok: f.faults.length === 0 };
  }
  const own = measureOwn(dir);
  const faults = [...own.featureFaults];
  const tf = parentedTierFault(own.tier, parent);
  if (tf) faults.push(tf);
  const pdir = worldJobDirs(dir).find((d) => path.basename(d) === parent || jobTier(d).id === parent);
  let aggregate = null;
  if (!pdir) faults.push(`parent "${parent}" is not a POI job of this world (zonegen/<world>/zones/<zone>/pois/${parent}): a parented job is judged by its parent's tier`);
  else {
    const fam = measureFamily(pdir);
    aggregate = { job: path.basename(pdir), tier: fam.tier, children: fam.children, measurement: fam.measurement };
    faults.push(...fam.faults.map((x) => `parent ${parent} (${fam.tier ?? "no"} tier, with ${fam.children.length} child job(s)): ${x}`));
  }
  return { id: own.id, tier: own.tier, parent, points: own.pts.length, measurement: own.measurement, aggregate, faults, ok: faults.length === 0 };
}

/** Gate 12 (size meets its tier): null, or why the measured place is smaller than its tier. */
export function sizeBlock(dir) {
  const r = measureSize(dir);
  if (r.ok) return null;
  return `the size gate failed (gate 12, ${r.tier ?? "no"} tier, tools/poi-review/size-tiers.mjs): ${r.faults.join("; ")} — grow the place, or Derek re-tiers it in the plan; measure with job.mjs measure ${dir}`;
}

/** The 6 m rule (packages/core voxel/operator-registry.ts FINE_MIN): three 2 m lattice steps. */
export const FINE_MIN = 6;
const FINE_KINDS = new Set(["passages", "heightPatches", "blobs"]);
const FINE_EXEMPT = ["op:", "tw-", "bs-"];

/** Smallest dimension of a delivered passage / height patch / blob, metres (core `featureMinDimension`). */
function fineMin(kind, f) {
  const n = (v, d) => (typeof v === "number" && Number.isFinite(v) ? v : d);
  if (kind === "passages") return Math.min(n(f.width, 0), n(f.length, 0), n(f.height, 0));
  if (kind === "heightPatches") return Math.min(...(Array.isArray(f.size) ? f.size : [0]));
  const r = n(f.radius, 0);
  return 2 * Math.min(r, n(f.topRadius, r)) * Math.min(n(f.scaleX, 1), n(f.scaleZ, 1));
}

/** Terrain carves in the delivered files: recipe edits ({kind, feature}) and raw `passages` / `heightPatches` / `blobs` arrays. */
export function deliveredCarves(dir) {
  const out = [];
  const walk = (v, kind) => {
    if (Array.isArray(v)) { for (const x of v) walk(x, kind); return; }
    if (!v || typeof v !== "object") return;
    if (kind && typeof v.id === "string") { out.push({ kind, feature: v }); return; }
    if (FINE_KINDS.has(v.kind) && v.feature && typeof v.feature === "object") { out.push({ kind: v.kind, feature: v.feature }); return; }
    for (const [k, x] of Object.entries(v)) walk(x, FINE_KINDS.has(k) ? k : null);
  };
  for (const f of deliveredOps(dir)) {
    try { walk(readJson(path.join(dir, f)), null); } catch { /* unreadable: other gates say so */ }
  }
  return out;
}

/**
 * The world's documented 6 m exceptions file for a job (zonegen/<world>/... under projects/<project>/authoring):
 * `<project>/authoring/terrain/<world>.fine-exceptions.json`, or null when the job does not sit in a project world.
 */
export function fineExceptionsFile(dir) {
  const parts = path.resolve(dir).split(/[\\/]/), z = parts.lastIndexOf("zonegen");
  if (z < 2 || parts[z - 1] !== "authoring" || !parts[z + 1]) return null;
  return path.join(parts.slice(0, z).join(path.sep), "terrain", `${parts[z + 1]}.fine-exceptions.json`);
}
/** Entries of a fine-exceptions file that belong to this job (entry.job = the job's id or folder name). */
export function readFineExceptions(dir, file = fineExceptionsFile(dir)) {
  const j = file ? tryJson(file) : null;
  const all = Array.isArray(j?.exceptions) ? j.exceptions : [];
  const me = new Set([path.basename(path.resolve(dir)), jobTier(dir).id]);
  return all.filter((e) => e && me.has(e.job) && Array.isArray(e.carves));
}

/**
 * A job's own dated quality exceptions (`<job>/quality-exceptions.json`, i-install 2026-10-30: Red Dial's coordinator
 * ruling on its skirt stone was written there but no gate read it, so the art gate blocked the install on a ruled fault):
 * `{ exceptions: [{ id, gates: ["art", ...], pieces: [], match: { rule, what? }, fault, why, ruling: "YYYY-MM-DD <who>..." }] }`.
 * A row counts for `gate` only when it names the gate, carries a dated ruling with its author (isDatedRuling: the date plus
 * >= 8 more characters) and a reason (`why` >= 8 chars), and states what it matches (`match.rule`) — a row without a
 * matcher excepts nothing, so a ruling never widens into a blanket pass.
 */
export const EXCEPTIONS_FILE = "quality-exceptions.json";
const DATED_RULING = /\b20\d\d-\d\d-\d\d\b/;
export function jobExceptions(dir, gate) {
  const j = tryJson(path.join(dir, EXCEPTIONS_FILE));
  const rows = Array.isArray(j?.exceptions) ? j.exceptions : [];
  return rows.filter((e) => e && Array.isArray(e.gates) && e.gates.includes(gate)
    && typeof e.ruling === "string" && DATED_RULING.test(e.ruling) && e.ruling.replace(DATED_RULING, "").replace(/[\s,:;-]/g, "").length >= 8
    && typeof e.why === "string" && e.why.trim().length >= 8
    && e.match && typeof e.match.rule === "string" && e.match.rule.length > 0);
}
/** Split gate faults ({ rule, piece, what }) into kept and excepted by the job's rows: rule equal, `what` equal when the
 *  row states it, and the piece containing one of the row's `pieces` when it lists any. */
export function exceptFaults(faults, rows) {
  const kept = [], excepted = [];
  for (const f of faults) {
    const row = rows.find((e) => e.match.rule === f.rule && (e.match.what === undefined || e.match.what === f.what)
      && (!Array.isArray(e.pieces) || !e.pieces.length || e.pieces.some((p) => String(f.piece ?? "").includes(p))));
    if (row) excepted.push({ ...f, exception: row.id, ruling: row.ruling }); else kept.push(f);
  }
  return { kept, excepted };
}
/** Gate 11 detail: carves finer than 6 m, split into counted faults and documented exceptions. */
export function fineCarveReport(dir, { exceptions = true } = {}) {
  const fine = deliveredCarves(dir).filter(({ kind, feature }) => !FINE_EXEMPT.some((p) => String(feature.id).startsWith(p)) && fineMin(kind, feature) < FINE_MIN - 1e-6);
  const listed = new Set(exceptions ? readFineExceptions(dir).flatMap((e) => e.carves) : []);
  const key = ({ kind, feature }) => `${kind}/${feature.id}`;
  return { faults: fine.filter((c) => !listed.has(key(c))), excepted: fine.filter((c) => listed.has(key(c))).length };
}

/**
 * Gate 11 (the 6 m rule): no delivered terrain carve or patch may be finer than 6 m in its smallest dimension — the
 * 2 m lattice cannot draw it (the Kings' Path: 413 box carves drew lumpy treads and a kerb over the walk line). Shaped
 * ground is a landform operator (`features.operators`, `worldgen op`), anything finer a kit / hero piece. Checked
 * straight from the delivered files; operator (`op:`), terrace-wall (`tw-`) and bridge (`bs-`) pieces are exempt, and the
 * carves a coordinator ruling lists for this job in the world's fine-exceptions file (`fineExceptionsFile`) are excepted
 * (`exceptions: false` ignores the file).
 */
export function terrainFineBlock(dir, { exceptions = true } = {}) {
  const { faults: bad, excepted } = fineCarveReport(dir, { exceptions });
  if (!bad.length) return null;
  const list = bad.slice(0, 4).map(({ kind, feature }) => `${kind}/${feature.id} (${Math.round(fineMin(kind, feature) * 10) / 10} m)`).join(", ");
  return `the 6 m gate failed (gate 11): ${bad.length} terrain carve(s) finer than ${FINE_MIN} m${excepted ? ` (${excepted} excepted)` : ""} — ${list}${bad.length > 4 ? ", ..." : ""}: too fine for terrain: use a kit/hero piece or an operator (worldgen op; docs/voxel-worlds.md "Landform operators")`;
}

/**
 * Gate 5 (float): nothing the job places may hang in the air. `reports/float.json` — the float gate's report
 * (`worldgen float <world> --near x,z,r --out <dir>/reports/float.json` on the preview, or `tools/float.mts scene
 * <project> --out ...` for a dungeon) — must say ok and be newer than every delivered ops file.
 */
export function floatBlock(dir) {
  const file = path.join(dir, "reports", "float.json");
  const how = `worldgen float <world> --near x,z,r --out ${path.join(dir, "reports", "float.json")} (dungeon: tools/float.mts scene <project> --out ...)`;
  if (!fs.existsSync(file)) return `no float gate evidence (gate 5): run ${how}`;
  let rep;
  try { rep = JSON.parse(fs.readFileSync(file, "utf8")); } catch { return `${file} is not a float report`; }
  if (rep.ok !== true) return `the float gate failed (gate 5): ${rep.counts?.off ?? "?"} off, ${rep.counts?.unsupported ?? "?"} unsupported — re-seat (tools/float.mts scene --fix, or the placer) and run it again`;
  const at = fs.statSync(file).mtimeMs;
  const newer = deliveredOps(dir).filter((f) => fs.statSync(path.join(dir, f)).mtimeMs > at);
  if (newer.length) return `the float report is older than ${newer.join(", ")}: run the float gate again (${how})`;
  return null;
}

/**
 * Gate 6 (rock skins): every rock in its place's stone, every cap on the ground band beside it. `reports/rock-skins.json`
 * — `worldgen rock-skins <world> --near x,z,r --out <dir>/reports/rock-skins.json` on the preview — must say ok and be
 * newer than every delivered ops file. Placed rock-kit props get their skin from `dress apply` (or the gate's fix ops).
 */
export function rockSkinsBlock(dir) {
  const file = path.join(dir, "reports", "rock-skins.json");
  const how = `worldgen rock-skins <world> --near x,z,r --out ${file}`;
  if (!fs.existsSync(file)) return `no rock-skins gate evidence (gate 6): run ${how}`;
  let rep;
  try { rep = JSON.parse(fs.readFileSync(file, "utf8")); } catch { return `${file} is not a rock-skins report`; }
  if (rep.ok !== true) return `the rock-skins gate failed (gate 6): ${rep.counts?.skin ?? "?"} skin, ${rep.counts?.cap ?? "?"} cap, ${rep.counts?.recipe ?? "?"} recipe faults — skin the rocks (recipe.rockSkins, dress apply) and run it again`;
  const at = fs.statSync(file).mtimeMs;
  const newer = deliveredOps(dir).filter((f) => fs.statSync(path.join(dir, f)).mtimeMs > at);
  if (newer.length) return `the rock-skins report is older than ${newer.join(", ")}: run the gate again (${how})`;
  return null;
}

/**
 * Gate 7 (water edges): no water ends in the air. `reports/water-edges.json` — `worldgen water-edges <world> --near x,z,r
 * --out <dir>/reports/water-edges.json` on the preview (or `tools/water-edges.mts scene <project> --out ...`) — must
 * say ok and be newer than every delivered ops file.
 */
export function waterEdgesBlock(dir) {
  const file = path.join(dir, "reports", "water-edges.json");
  const how = `worldgen water-edges <world> --near x,z,r --out ${file}`;
  if (!fs.existsSync(file)) return `no water-edges gate evidence (gate 7): run ${how}`;
  let rep;
  try { rep = JSON.parse(fs.readFileSync(file, "utf8")); } catch { return `${file} is not a water-edges report`; }
  if (rep.ok !== true) return `the water-edges gate failed (gate 7): ${rep.rows?.length ?? "?"} fault(s) — re-cut the water to its walls and finish what stays open (tools/water-edges.mts scene --fix), or fix the ground under the curtain, and run it again`;
  const at = fs.statSync(file).mtimeMs;
  const newer = deliveredOps(dir).filter((f) => fs.statSync(path.join(dir, f)).mtimeMs > at);
  if (newer.length) return `the water-edges report is older than ${newer.join(", ")}: run the gate again (${how})`;
  return null;
}

/** Does the job deliver anything art-check judges (a `landmark` or `paint` world op, an added mesh or prefab)? Gate 15. */
export function deliversArt(dir) {
  for (const f of deliveredOps(dir)) {
    let j; try { j = readJson(path.join(dir, f)); } catch { continue; }
    const ops = Array.isArray(j) ? j : j?.ops ?? (j?.op ? [j] : []);
    if (ops.some((o) => o?.op === "landmark" || o?.op === "paint" || (o?.op === "add-entity" && ((o.components ?? o.entity?.components)?.mesh || (o.components ?? o.entity?.components)?.prefab)))) return true;
  }
  return false;
}

/**
 * Gate 15 (art): `reports/art-check.json` — `node node_modules/tsx/dist/cli.mjs tools/art-check.mts <jobDir>` from
 * apps/playground — must say ok and be newer than every delivered ops file, for a job that delivers art (deliversArt).
 */
export function artBlock(dir) {
  if (!deliversArt(dir)) return null;
  const how = `node node_modules/tsx/dist/cli.mjs tools/art-check.mts ${dir} (from apps/playground)`;
  const block = reportBlock(dir, "art-check", 15, how, (rep) => {
    const counts = Object.entries(rep.counts ?? {}).map(([k, n]) => `${n} ${k}`).join(", ") || "faults";
    const first = (rep.faults ?? []).slice(0, 3).map((f) => `${f.rule} ${f.piece} ${f.what}: ${f.detail}`).join("; ");
    return `the art gate failed (gate 15): ${counts} — ${first}; fix the materials/specs and run it again`;
  });
  if (block) return block;
  const rep = readJson(path.join(dir, "reports", "art-check.json"));
  if (!["architecture", "counts"].includes(rep.materialPolicy)) return `the art-check report predates the architectural material policy (gate 15): rerun ${how}; an old texture-count approval does not check architectural assignments`;
  return null;
}

/** Is the job a PAINTED place: its zone's concept/<poi>.site.json records a render with a camera (the approved painting's)? */
export function paintedPlace(dir) {
  const { poi, zoneDir } = jobSite(dir);
  if (!zoneDir) return false;
  const f = path.join(zoneDir, "concept", `${poi}.site.json`);
  if (!fs.existsSync(f)) return false;
  try { return Object.values(readJson(f).renders ?? {}).some((r) => Array.isArray(r?.camera) && Array.isArray(r?.target)); } catch { return false; }
}

/**
 * Gate 17 (scale, Red Dial 2026-10-30: "you don't have the scale correct with the concept art"): a PAINTED place needs
 * `reports/scale.json` from `place-build scale` saying ok — every hero piece marked in <job>/concept-marks.json within
 * 15 % of its painted width/height, projected through the painting's own camera — newer than every delivered ops file.
 */
export function scaleBlock(dir) {
  if (!paintedPlace(dir)) return null;
  const how = `node node_modules/tsx/dist/cli.mjs tools/place-build.mts scale <world> --zone <z> --location ${jobSite(dir).poi} (from apps/playground; marks in ${path.join(dir, "concept-marks.json")})`;
  return reportBlock(dir, "scale", 17, how, (rep) => {
    const bad = (rep.rows ?? []).filter((r) => !r.ok).slice(0, 3).map((r) => `${r.id}: ${r.why}`).join("; ") || (rep.faults ?? []).join("; ") || "faults";
    return `the scale gate failed (gate 17): the place does not match its painting's proportions — ${bad}; rescale the layout and run it again`;
  });
}

/** Does the job deliver built structures (an added `mesh` component in its scene ops)? Gate 8 applies to those. */
export function deliversStructures(dir) {
  for (const f of deliveredOps(dir)) {
    let j; try { j = readJson(path.join(dir, f)); } catch { continue; }
    const ops = Array.isArray(j) ? j : j?.ops ?? [];
    if (ops.some((o) => o?.op === "add-entity" && (o.components ?? o.entity?.components)?.mesh)) return true;
  }
  return false;
}

/**
 * Gate 8 (see-through): no holes you can see through the map. For a job with built structures, `reports/see-through.json`
 * — `tools/see-through.mts scene <preview scene> --route <walk-route.json> --out <dir>/reports/see-through.json` — must say
 * ok and be newer than every delivered ops file.
 */
export function seeThroughBlock(dir) {
  if (!deliversStructures(dir)) return null;
  const file = path.join(dir, "reports", "see-through.json");
  const how = `tools/see-through.mts scene <preview scene> --route ${path.join(dir, "walk-route.json")} --out ${file}`;
  if (!fs.existsSync(file)) return `no see-through gate evidence (gate 8): run ${how}`;
  let rep;
  try { rep = JSON.parse(fs.readFileSync(file, "utf8")); } catch { return `${file} is not a see-through report`; }
  if (rep.ok !== true) return `the see-through gate failed (gate 8): ${rep.counts?.sites ?? "?"} hole site(s) — see ${rep.sheet ?? "the report"}; close them (thicken thin DC shells, overlap group seams, double-side or close single-sided faces) or declare a real opening in see-through-openings.json, and run it again`;
  const at = fs.statSync(file).mtimeMs;
  const newer = deliveredOps(dir).filter((f) => fs.statSync(path.join(dir, f)).mtimeMs > at);
  if (newer.length) return `the see-through report is older than ${newer.join(", ")}: run the gate again (${how})`;
  return null;
}

/** A gate report under <dir>/reports: null when it says ok and is newer than every delivered ops file, else the reason. */
function reportBlock(dir, name, gate, how, failed) {
  const file = path.join(dir, "reports", `${name}.json`);
  if (!fs.existsSync(file)) return `no ${name} gate evidence (gate ${gate}): run ${how}`;
  let rep;
  try { rep = JSON.parse(fs.readFileSync(file, "utf8")); } catch { return `${file} is not a ${name} report`; }
  if (rep.ok !== true) return failed(rep);
  const at = fs.statSync(file).mtimeMs;
  const newer = deliveredOps(dir).filter((f) => fs.statSync(path.join(dir, f)).mtimeMs > at);
  if (newer.length) return `the ${name} report is older than ${newer.join(", ")}: run the gate again (${how})`;
  return null;
}

/**
 * Gate 14 (walk): a real server body walks the place. `reports/walk.json` — `node node_modules/tsx/dist/cli.mjs
 * tools/poi-walk.mts <jobDir>` from apps/playground — must say ok, cover the whole job (no --only) and be newer than every
 * delivered ops file. Its faults name the leg, the point and what the body did (reports/walk.png shows the traces).
 */
export function walkBlock(dir) {
  const file = path.join(dir, "reports", "walk.json");
  const how = `node node_modules/tsx/dist/cli.mjs tools/poi-walk.mts ${dir} (from apps/playground)`;
  const block = reportBlock(dir, "walk", 14, how, (rep) => {
    const counts = Object.entries(rep.counts ?? {}).map(([k, n]) => `${n} ${k}`).join(", ") || "faults";
    const first = (rep.faults ?? []).slice(0, 3).map((f) => `${f.kind} ${f.what}${f.detail ? `: ${f.detail}` : ""}`).join("; ");
    return `the walk gate failed (gate 14): ${counts} — ${first}; see ${path.join(dir, "reports", "walk.png")}, fix the place (or declare navigation.routes) and run it again`;
  });
  if (block) return block;
  const rep = JSON.parse(fs.readFileSync(file, "utf8"));
  if (rep.partial) return `the walk report is a partial run (--only ${rep.partial}): run the whole job (${how})`;
  return null;
}

/** Added mesh entities in the delivered scene ops (id, name, mesh component). */
function addedMeshes(dir) {
  const out = [];
  for (const f of deliveredOps(dir)) {
    let j; try { j = readJson(path.join(dir, f)); } catch { continue; }
    for (const o of Array.isArray(j) ? j : j?.ops ?? []) {
      const c = o?.op === "add-entity" ? o.components ?? o.entity?.components : null;
      if (c?.mesh) out.push({ id: o.id ?? o.entityId ?? "", name: o.name ?? o.entity?.name ?? "", mesh: c.mesh });
    }
  }
  return out;
}

/** Does the job deliver a model wearing an engine material (a GLB + material asset: a flat-art slab candidate)? */
export function deliversMaterialModels(dir) {
  return addedMeshes(dir).some((m) => m.mesh?.source?.kind === "asset" && typeof m.mesh.material === "string");
}

/**
 * Gate 9 (flat art upright): a job that delivers a model wearing an engine material (door reliefs, plaques, panels:
 * slabs + a generated picture) needs `reports/flat-art.json` — `tools/flat-art.mts check <preview project> --scene
 * <preview scene> --out <dir>/reports/flat-art.json` — saying ok: every picture upright and not mirrored (an engine
 * material map loads flipY, so a slab stores v = 1 - row; the First King's Door showed upside down, 2026-10-13).
 */
export function flatArtBlock(dir) {
  if (!deliversMaterialModels(dir)) return null;
  const how = `node tools/flat-art.mts check <preview project> --scene <preview scene> --out ${path.join(dir, "reports", "flat-art.json")} (--fix flips a flipped GLB's v, inverse kept)`;
  return reportBlock(dir, "flat-art", 9, how, (rep) => `the flat-art gate failed (gate 9): ${rep.faults ?? "?"} slab(s) upside down or mirrored — ${(rep.failures ?? []).slice(0, 3).map((f) => f.what).join("; ")}`);
}

/** Words that make a place a monument site (a butte, mesa, monument ... climbed by its approach). */
export const MONUMENT_RE = /\b(buttes?|mesas?|monuments?|tors?|stacks?|spires?|pillars?|plinth)\b/i;
/** Is the job's place a monument or butte site (its brief, or handoff.siteKind)? */
export function isMonumentSite(dir) {
  for (const f of ["brief.json", "handoff.json"]) {
    const file = path.join(dir, f);
    if (!fs.existsSync(file)) continue;
    let j; try { j = readJson(file); } catch { continue; }
    if (typeof j.siteKind === "string") return MONUMENT_RE.test(j.siteKind);
    if (f === "brief.json" && MONUMENT_RE.test(`${j.name ?? ""} ${j.description ?? ""} ${JSON.stringify(j.location ?? {})}`)) return true;
  }
  return false;
}

/**
 * Gate 10 (monument approach): a monument or butte site that delivers built structures needs
 * `reports/monument-approach.json` — `tools/monument-approach.mts scene <preview project> --scene <preview scene> --near
 * x,z,r --monument --out <dir>/reports/monument-approach.json` — saying ok: no stair flight standing free of the face
 * (site-standards "Monument approach": the climb is carved AROUND it, a cut ledge with a kerb, not a freestanding stair).
 */
export function monumentApproachBlock(dir) {
  if (!isMonumentSite(dir) || !deliversStructures(dir)) return null;
  const how = `node tools/monument-approach.mts scene <preview project> --scene <preview scene> --near x,z,r --monument --out ${path.join(dir, "reports", "monument-approach.json")}`;
  return reportBlock(dir, "monument-approach", 10, how, (rep) => `the monument-approach gate failed (gate 10): ${rep.counts?.faults ?? "?"} free-standing stair(s) — ${(rep.failures ?? []).slice(0, 3).map((f) => f.what).join("; ")}`);
}

/**
 * For installers: call first. Exits 1 with the reason unless the final review passed for exactly these ops, or the
 * coordinator passed --force-dogfood (recorded in progress.json unless it is a dry run). An --uninstall or --dry-run
 * is never blocked (a dry run prints what the install would need).
 */
export function requireFinalReview(dir, argv = process.argv) {
  const fire = fireFaults(dir);
  if (fire.length && !argv.includes("--force-dogfood")) throw new Error(`home-made fire in the delivered ops (gate 4):\n  ${fire.join("\n  ")}`);
  if (argv.includes("--draft") && !argv.includes("--uninstall")) return requireDraftGeometry(dir, argv);
  const block = installBlock(dir);
  if (argv.includes("--uninstall")) return true;
  if (argv.includes("--dry-run") || argv.includes("--dry")) { if (block) console.warn(`[install guard] a real install would be refused: ${block}`); return true; }
  ownerApplyLast(dir);
  if (!block) return true;
  if (argv.includes("--force-dogfood")) {
    console.warn(`[install guard] --force-dogfood: installing WITHOUT a passed final review (${block}); recorded in progress.json`);
    if (fs.existsSync(progressFile(dir))) {
      const p = loadProgress(dir);
      (p.forcedInstalls ??= []).push({ at: new Date().toISOString(), block, opsHash: opsHash(dir) });
      saveProgress(dir, p);
    }
    return true;
  }
  console.error(`STOP (install guard): ${block}`);
  process.exit(1);
}

/**
 * The GEOMETRY rows of the lab's `reports/gates.json` a DRAFT install needs ok (Derek 2026-11-03, i-drafts: half-finished
 * places brought into the live world as they are). Ground, seat, float, lips, support, water, walk, z-fight, the 6 m rule
 * and the operators: a draft never skips one of these. Not here (they stay open on a draft): design, size, art, scale,
 * rock-skins, wash, dress, place, heroes, features, camp — the review and finish rows.
 */
export const DRAFT_GEOMETRY_GATES = ["fine", "roads", "lips", "scatter-float", "float", "seated", "shelters", "abut", "water-edges", "zfight", "op-check", "support", "walk"];

/**
 * A DRAFT install's block (null = may install): no review stage is asked for (final review, design, size, art, scale stay
 * open), but every geometry report must say ok and be newer than the delivered ops — float, water edges, walk, flat art,
 * monument approach, the 6 m rule — and the lab's gates table must hold every DRAFT_GEOMETRY_GATES row it ran ok, newer
 * than the ops. The overlap with other places, roads and reservations is place-build's own check (install --draft).
 */
export function draftInstallBlock(dir) {
  if (!opsHash(dir)) return "the job delivers no ops files";
  const geo = floatBlock(dir) ?? waterEdgesBlock(dir) ?? walkBlock(dir) ?? flatArtBlock(dir) ?? monumentApproachBlock(dir) ?? terrainFineBlock(dir);
  if (geo) return geo;
  const gf = path.join(dir, "reports", "gates.json");
  if (!fs.existsSync(gf)) return `no reports/gates.json: run place-build gates on the lab first`;
  let g; try { g = readJson(gf); } catch { return `${gf} is not a gates table`; }
  const at = fs.statSync(gf).mtimeMs, newer = deliveredOps(dir).filter((f) => fs.statSync(path.join(dir, f)).mtimeMs > at);
  if (newer.length) return `reports/gates.json is older than ${newer.join(", ")}: run place-build gates on the lab again`;
  const rows = Array.isArray(g.rows) ? g.rows : [];
  const missing = DRAFT_GEOMETRY_GATES.filter((n) => ["lips", "float", "seated", "walk"].includes(n) && !rows.some((r) => r.gate === n));
  if (missing.length) return `reports/gates.json has no ${missing.join(", ")} row(s) (a partial --only run?): run place-build gates on the lab`;
  const bad = rows.filter((r) => DRAFT_GEOMETRY_GATES.includes(r.gate) && r.ok !== true);
  if (bad.length) return `geometry gate(s) failed on the lab (a draft never skips one): ${bad.map((r) => `${r.gate}: ${String(r.detail ?? "").slice(0, 160)}`).join("; ")}`;
  return null;
}

/** The draft install guard (requireFinalReview with --draft): geometry only, recorded in progress.json `draftInstalls`. */
function requireDraftGeometry(dir, argv) {
  const block = draftInstallBlock(dir);
  if (argv.includes("--dry-run") || argv.includes("--dry")) { if (block) console.warn(`[draft install guard] a real draft install would be refused: ${block}`); return true; }
  if (block) { console.error(`STOP (draft install guard): ${block}`); process.exit(1); }
  ownerApplyLast(dir);
  if (fs.existsSync(progressFile(dir))) {
    const p = loadProgress(dir), i = argv.indexOf("--draft-note");
    (p.draftInstalls ??= []).push({ at: new Date().toISOString(), opsHash: opsHash(dir), note: i >= 0 && argv[i + 1] ? argv[i + 1] : "draft install", open: installBlock(dir) ?? null });
    saveProgress(dir, p);
  }
  return true;
}

/**
 * The owner's edits win: every scene of the job's project with owner overrides (authoring/owner-overrides/<scene>.json,
 * written by the in-editor prop editor) gets `dress owner-apply` as the installer's LAST step — on a clean exit,
 * after everything the installer wrote. Idempotent (nothing to do = no write); the inverse lands beside the overrides.
 * Registered once by requireFinalReview for a real install (never a dry run or an uninstall).
 */
let ownerHooked = false;
export function ownerApplyLast(dir) {
  if (ownerHooked) return;
  const scenes = ownerOverrideScenes(dir);
  if (!scenes.project || !scenes.list.length) return;
  ownerHooked = true;
  process.on("exit", (code) => {
    if (code !== 0 || process.exitCode) return;
    for (const scene of scenes.list) {
      try {
        const out = execFileSync(process.execPath, [path.join(scenes.playground, "node_modules/tsx/dist/cli.mjs"), "tools/dress.mts", "owner-apply", "--project", scenes.project, "--scene", scene],
          { cwd: scenes.playground, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
        console.log(`[install] owner edits last: ${out.trim()}`);
      } catch (e) { console.error(`[install] dress owner-apply ${scenes.project}/${scene} FAILED: ${String(e.stderr ?? e.message).trim().slice(0, 400)}`); process.exitCode = 1; }
    }
  });
}
/** The project a job dir lives in (projects/<name>/...) and its scenes that carry owner overrides. */
export function ownerOverrideScenes(dir) {
  const parts = path.resolve(dir).split(path.sep), i = parts.lastIndexOf("projects");
  if (i < 1 || !parts[i + 1]) return { project: null, playground: null, list: [] };
  const playground = parts.slice(0, i).join(path.sep), project = parts[i + 1];
  const od = path.join(playground, "projects", project, "authoring", "owner-overrides");
  const list = fs.existsSync(od) ? fs.readdirSync(od).filter((f) => f.endsWith(".json") && !f.endsWith(".inverse.json")).map((f) => f.slice(0, -5)) : [];
  return { project, playground, list };
}

/**
 * Record the FINAL review from its file. Returns the recorded entry; throws when the file does not name these ops, names
 * no fresh reviewer (the owner or the coordinator), or leaves a rubric line unanswered (gate 13). A FAIL is recorded
 * with its reviewer too (it re-opens the job). Never writes ownerApproval: that is Derek's, by hand.
 */
export function recordReview(dir, file) {
  const rel = path.relative(dir, path.resolve(file)).replaceAll("\\", "/");
  const said = readReview(path.resolve(file));
  const now = opsHash(dir);
  if (!said.opsHash) throw new Error(`${rel} names no ops hash: the reviewer writes "Ops hash: ${now}" (job.mjs hash) in it`);
  if (said.opsHash !== now) throw new Error(`${rel} reviewed ops ${said.opsHash.slice(0, 12)}, the job delivers ${String(now).slice(0, 12)} now`);
  const who = reviewIdentityBlock(dir, said, rel);
  if (who) throw new Error(who);
  const p = loadProgress(dir);
  p.finalReview = { file: rel, verdict: said.verdict, opsHash: said.opsHash, reviewer: said.reviewer, answered: Object.keys(said.answers).length, at: new Date().toISOString() };
  saveProgress(dir, p);
  return p.finalReview;
}

const FIRE_WORDS = /\b(fire|flames?|torch(es)?|brazier|pyres?|bonfire|campfire|embers?|candles?|lantern-?flame)\b/i;
/** Home-made fire in the delivered scene ops (gate 4): one line per offender, empty when clean. */
export function fireFaults(dir) {
  const ops = deliveredOps(dir).flatMap((f) => { try { const j = readJson(path.join(dir, f)); return Array.isArray(j) ? j : Array.isArray(j?.ops) ? j.ops : []; } catch { return []; } });
  const ents = new Map(ops.filter((o) => o?.op === "add-entity" && o.entity).map((o) => [o.id, o.entity]));
  const caught = (id) => { for (let e = ents.get(id), n = 0; e && n < 64; e = ents.get(e.parent), n++) if (e.components?.vfx || e.components?.prefab) return true; return false; };
  const out = [];
  for (const [id, e] of ents) {
    const c = e.components ?? {};
    const label = `${id} (${e.name ?? ""})`;
    const src = c.mesh?.source;
    const material = typeof c.mesh?.material === "string" ? c.mesh.material : "";
    if (c.mesh && !caught(id) && ((src?.kind === "primitive" && FIRE_WORDS.test(`${id} ${e.name ?? ""}`)) || /^fx\//.test(material)))
      out.push(`${label}: a mesh drawn as fire (${src?.kind === "primitive" ? `primitive ${src.shape}` : "mesh"}${material ? ` on ${material}` : ""}) — use the standing vfx fire through a catalogued prefab`);
    if (c.light && !caught(id)) out.push(`${label}: a raw light — lights come with their fixture (a catalogued fire/lamp prefab from the place's one bucket)`);
  }
  return out;
}

/** Why a stage move is refused, or null. */
export function stageBlock(dir, to, p = loadProgress(dir)) {
  const ti = STAGES.indexOf(to);
  if (ti < 0) return `unknown stage "${to}" (${STAGES.join(", ")})`;
  if (ti > STAGES.indexOf("blockout")) {
    const shot = p.evidence?.readShot;
    if (!shot || typeof shot !== "object" || !shot.file || !shot.viewpoint)
      return `past blockout needs evidence.readShot { file, viewpoint }: the place's defining read from its declared viewpoint (clear weather, a readable hour)`;
    if (!fs.existsSync(path.resolve(dir, shot.file))) return `read shot ${shot.file} does not exist`;
    const hf = path.join(dir, "handoff.json");
    const declared = [...(p.viewpoints ?? []), ...(fs.existsSync(hf) ? readJson(hf).viewpoints ?? [] : [])].map((v) => (typeof v === "string" ? v : v?.id));
    if (!declared.includes(shot.viewpoint)) return `read shot viewpoint "${shot.viewpoint}" is not a declared viewpoint (${declared.join(", ") || "none declared: add viewpoints[] { id, at, look } to progress.json first"})`;
  }
  if (ti > STAGES.indexOf("blockout")) {
    const fire = fireFaults(dir);
    if (fire.length) return `home-made fire in the delivered ops (gate 4):\n  ${fire.join("\n  ")}`;
  }
  // gate 16: nothing repeats (detail) before one area is finished and a fresh reviewer has read the story in it
  if (ti > STAGES.indexOf("greybox-review")) { const d = designBlock(dir, p); if (d) return d; }
  if (to === "installed" && installBlock(dir)) return installBlock(dir);
  return null;
}
export function setStage(dir, to) {
  const p = loadProgress(dir);
  const block = stageBlock(dir, to, p);
  if (block) throw new Error(block);
  p.stage = to;
  saveProgress(dir, p);
  return p;
}

/** Record a fix attempt; the third (MAX_FIXES + 1) needs the coordinator. */
export function recordFix(dir, what, { coordinator = false } = {}) {
  const p = loadProgress(dir);
  const fixes = (p.fixes ??= []);
  if (fixes.length >= MAX_FIXES && !coordinator)
    throw new Error(`fix attempt ${fixes.length + 1} refused: the loop is capped at ${MAX_FIXES} (${fixes.map((f) => f.what).join("; ")}). The coordinator decides: install with the fault logged, or cut the feature (--coordinator)`);
  fixes.push({ n: fixes.length + 1, what, at: new Date().toISOString(), ...(coordinator && fixes.length >= MAX_FIXES ? { by: "coordinator" } : {}) });
  saveProgress(dir, p);
  return fixes.length;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [cmd, dirArg, ...rest] = process.argv.slice(2);
  const opt = (k) => { const i = rest.indexOf(`--${k}`); return i >= 0 ? rest[i + 1] : undefined; };
  const dir = dirArg ? path.resolve(dirArg) : "";
  try {
    if (cmd === "hash") console.log(`${opsHash(dir)}  (${deliveredOps(dir).join(", ")})`);
    else if (cmd === "review") console.log(JSON.stringify(recordReview(dir, opt("file"))));
    else if (cmd === "design") {
      // --no-sample (place-build's design gate, SHOT_ROWS): the sample frames are judged after the batch render
      const sample = !rest.includes("--no-sample");
      const faults = designFaults(dir, undefined, { sample });
      if (faults.length) { console.error(`design (gate 16) FAIL:\n  ${faults.join("\n  ")}\nDesign hash: ${designHash(dir, undefined, { live: true })} (art ${jobArt(dir) ?? "unknown"})`); process.exitCode = 1; }
      else { console.log(`design ok (gate 16)\nDesign hash: ${designHash(dir, undefined, { live: true })}`); const d = designBlock(dir, undefined, { sample }); if (d) { console.log(`review: ${d}`); process.exitCode = 1; } else console.log("review: PASS recorded for this design"); }
    }
    else if (cmd === "design-review") console.log(JSON.stringify(recordDesignReview(dir, opt("file"))));
    else if (cmd === "design-backfill") console.log(JSON.stringify(backfillDesignSample(dir, opt("ruling"))));
    else if (cmd === "stage") console.log(`stage -> ${setStage(dir, rest[0]).stage}`);
    else if (cmd === "fix") console.log(`fix attempt ${recordFix(dir, opt("what") ?? "", { coordinator: rest.includes("--coordinator") })} recorded`);
    else if (cmd === "fire") { const fire = fireFaults(dir); console.log(fire.length ? fire.join("\n") : "ok: no home-made fire"); if (fire.length) process.exitCode = 1; }
    else if (cmd === "measure") {
      const r = measureSize(dir);
      fs.mkdirSync(path.join(dir, "reports"), { recursive: true });
      fs.writeFileSync(path.join(dir, "reports", "size.json"), JSON.stringify(r, null, 2) + "\n");
      console.log(JSON.stringify({ id: r.id, tier: r.tier, ...(r.parent ? { parent: r.parent, parentTier: r.aggregate?.tier ?? null, parentChildren: r.aggregate?.children ?? [] } : {}), ...(r.children ? { children: r.children } : {}), ok: r.ok, ...r.measurement, features: r.measurement.features.map((f) => `${f.id}:${f.kind}`), faults: r.faults }, null, 2));
      if (!r.ok) process.exitCode = 1;
    }
    else if (cmd === "fine") {
      const r = fineCarveReport(dir, { exceptions: !rest.includes("--no-exceptions") });
      console.log(`6 m gate (gate 11): ${r.faults.length ? `FAIL ${r.faults.length} carve(s) finer than ${FINE_MIN} m` : "ok"}, ${r.excepted} excepted (${fineExceptionsFile(dir) ?? "no fine-exceptions file"})`);
      for (const c of r.faults.slice(0, rest.includes("--list") ? Infinity : 12)) console.log(`  ${c.kind}/${c.feature.id} (${Math.round(fineMin(c.kind, c.feature) * 10) / 10} m)`);
      if (r.faults.length) process.exitCode = 1;
    }
    else if (cmd === "check-install") { const b = installBlock(dir, { fineExceptions: !rest.includes("--no-exceptions") }); if (b && !rest.includes("--force-dogfood")) { console.error(`REFUSED: ${b}`); process.exitCode = 1; } else console.log(b ? `ok (--force-dogfood over: ${b})` : "ok: the final review passed for these ops"); }
    else { console.error("usage: job.mjs hash|review|design|design-review|design-backfill|stage|fix|fire|measure|fine|check-install <jobDir> ... (fine / check-install: --no-exceptions)"); process.exitCode = 2; }
  } catch (e) { console.error(`REFUSED: ${e.message}`); process.exitCode = 1; }
}

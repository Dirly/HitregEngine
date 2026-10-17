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
 *      be, from eye height along the walk route — newer than every delivered ops file (docs/see-through.md).
 *   9. Flat art reads upright: a job delivering a model that wears an engine material (a slab + a generated picture:
 *      door relief, plaque, panel) needs `reports/flat-art.json` (`tools/flat-art.mts check <project> --scene <preview>
 *      --out ...`) saying ok — no picture upside down or mirrored — newer than every delivered ops file.
 *  10. Monuments are climbed around, not up a freestanding stair: a monument or butte site (its brief) delivering built
 *      structures needs `reports/monument-approach.json` (`tools/monument-approach.mts scene <project> --scene <preview>
 *      --near x,z,r --monument --out ...`) saying ok — every stair flight held by the face it climbs.
 *  11. Ground is shaped by operators, not fine carves (the 6 m rule): the delivered files may hold no passage, height
 *      patch or blob under 6 m in its smallest dimension ("too fine for terrain: use a kit/hero piece or an operator").
 *      Checked straight from the delivered files (`terrainFineBlock`); `op:` / `tw-` / `bs-` pieces are exempt.
 *   3. The loop is capped: `fix` records each fix attempt in progress.json `fixes`; a third attempt is refused unless
 *      the coordinator passes --coordinator (and it is recorded as theirs).
 *
 *   node tools/poi-review/job.mjs hash   <jobDir>                          the delivered-ops hash a reviewer records
 *   node tools/poi-review/job.mjs review <jobDir> --file <review>          record the FINAL review (verdict read from the file)
 *   node tools/poi-review/job.mjs stage  <jobDir> <stage>                  move the job's stage (gate 2)
 *   node tools/poi-review/job.mjs fix    <jobDir> --what "<the fix>" [--coordinator]   record a fix attempt (gate 3)
 *   node tools/poi-review/job.mjs fire   <jobDir>                          list home-made fire in the delivered ops (gate 4)
 *   node tools/poi-review/job.mjs check-install <jobDir> [--force-dogfood] exit 0 when an installer may run (gate 1)
 *
 * A review file is JSON with `verdict` and `opsHash`, or text/markdown with lines `Verdict: PASS` and
 * `Ops hash: <hash>`. Pure helpers are exported for tests and installers.
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export const STAGES = ["briefed", "survey", "blockout", "greybox-review", "detail", "final-review", "installed"];
/** Fix attempts allowed before the coordinator must decide (install with the fault logged, or cut the feature). */
export const MAX_FIXES = 2;
const DEFAULT_OPS = ["ops.json", "world-ops.json", "clearings.json", "region.json"];

const readJson = (f) => JSON.parse(fs.readFileSync(f, "utf8").replace(/^﻿/, ""));
const sha = (b) => crypto.createHash("sha256").update(b).digest("hex");
const progressFile = (dir) => path.join(dir, "progress.json");
const loadProgress = (dir) => readJson(progressFile(dir));
const saveProgress = (dir, p) => fs.writeFileSync(progressFile(dir), JSON.stringify(p, null, 2) + "\n");

/** The ops files a job delivers: handoff.integration's sceneOps / worldOps / clearings / region, else the defaults. */
export function deliveredOps(dir) {
  const hf = path.join(dir, "handoff.json");
  const integ = fs.existsSync(hf) ? readJson(hf).integration ?? {} : {};
  const named = ["sceneOps", "worldOps", "clearings", "region"].flatMap((k) => (typeof integ[k] === "string" ? integ[k].split(/\s*\+\s*|\s+/) : Array.isArray(integ[k]) ? integ[k] : []))
    .filter((f) => typeof f === "string" && /\.json$/i.test(f));
  const list = [...new Set(named.length ? named : DEFAULT_OPS)].filter((f) => fs.existsSync(path.join(dir, f)));
  return list.sort();
}
/** One hash over the delivered ops (name + content of each). */
export function opsHash(dir, files = deliveredOps(dir)) {
  if (!files.length) return null;
  return sha(files.map((f) => `${f}\0${sha(fs.readFileSync(path.join(dir, f)))}`).join("\n"));
}

/** Verdict and ops hash a review file states. */
export function readReview(file) {
  const text = fs.readFileSync(file, "utf8").replace(/^﻿/, "");
  try {
    const j = JSON.parse(text);
    return { verdict: String(j.verdict ?? "").toUpperCase(), opsHash: j.opsHash ?? null };
  } catch {
    const v = /^\W*verdict\W*[:=]\s*\**\s*([A-Za-z-]+)/im.exec(text);
    const h = /ops ?hash\W*[:=]\s*`?([0-9a-f]{64})/i.exec(text);
    return { verdict: (v?.[1] ?? "").toUpperCase(), opsHash: h?.[1] ?? null };
  }
}

/** Why an install may not run, or null when it may. Pure apart from reading the job directory. */
export function installBlock(dir) {
  if (!fs.existsSync(progressFile(dir))) return `no progress.json in ${dir}`;
  const p = loadProgress(dir);
  const r = p.finalReview;
  if (!r || typeof r !== "object") return `progress.json records no final review: a fresh reviewer's PASS is required before install (job.mjs review ${dir} --file <review>)`;
  if (String(r.verdict).toUpperCase() !== "PASS") return `the final review's verdict is ${r.verdict}, not PASS`;
  const file = path.resolve(dir, r.file ?? "");
  if (!r.file || !fs.existsSync(file)) return `the final review file ${r.file} does not exist`;
  const said = readReview(file);
  if (said.verdict !== "PASS") return `${r.file} does not say Verdict: PASS (it says ${said.verdict || "nothing"})`;
  const now = opsHash(dir);
  if (!now) return "the job delivers no ops files";
  if (said.opsHash !== r.opsHash) return `${r.file} names ops hash ${said.opsHash ?? "(none)"}, progress.json ${r.opsHash}`;
  if (r.opsHash !== now) return `the delivered ops changed after the final review (reviewed ${String(r.opsHash).slice(0, 12)}, now ${now.slice(0, 12)}): review again`;
  return floatBlock(dir) ?? rockSkinsBlock(dir) ?? waterEdgesBlock(dir) ?? seeThroughBlock(dir) ?? flatArtBlock(dir) ?? monumentApproachBlock(dir) ?? terrainFineBlock(dir);
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
 * Gate 11 (the 6 m rule): no delivered terrain carve or patch may be finer than 6 m in its smallest dimension — the
 * 2 m lattice cannot draw it (the Kings' Path: 413 box carves drew lumpy treads and a kerb over the walk line). Shaped
 * ground is a landform operator (`features.operators`, `worldgen op`), anything finer a kit / hero piece. Checked
 * straight from the delivered files; operator (`op:`), terrace-wall (`tw-`) and bridge (`bs-`) pieces are exempt.
 */
export function terrainFineBlock(dir) {
  const bad = deliveredCarves(dir).filter(({ kind, feature }) => !FINE_EXEMPT.some((p) => String(feature.id).startsWith(p)) && fineMin(kind, feature) < FINE_MIN - 1e-6);
  if (!bad.length) return null;
  const list = bad.slice(0, 4).map(({ kind, feature }) => `${kind}/${feature.id} (${Math.round(fineMin(kind, feature) * 10) / 10} m)`).join(", ");
  return `the 6 m gate failed (gate 11): ${bad.length} terrain carve(s) finer than ${FINE_MIN} m — ${list}${bad.length > 4 ? ", ..." : ""}: too fine for terrain: use a kit/hero piece or an operator (worldgen op; docs/voxel-worlds.md "Landform operators")`;
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

/** Record the FINAL review from its file. Returns the recorded entry; throws when the file does not say PASS for these ops. */
export function recordReview(dir, file) {
  const rel = path.relative(dir, path.resolve(file)).replaceAll("\\", "/");
  const said = readReview(path.resolve(file));
  const now = opsHash(dir);
  if (!said.opsHash) throw new Error(`${rel} names no ops hash: the reviewer writes "Ops hash: ${now}" (job.mjs hash) in it`);
  if (said.opsHash !== now) throw new Error(`${rel} reviewed ops ${said.opsHash.slice(0, 12)}, the job delivers ${String(now).slice(0, 12)} now`);
  const p = loadProgress(dir);
  p.finalReview = { file: rel, verdict: said.verdict, opsHash: said.opsHash, at: new Date().toISOString() };
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
    else if (cmd === "stage") console.log(`stage -> ${setStage(dir, rest[0]).stage}`);
    else if (cmd === "fix") console.log(`fix attempt ${recordFix(dir, opt("what") ?? "", { coordinator: rest.includes("--coordinator") })} recorded`);
    else if (cmd === "fire") { const fire = fireFaults(dir); console.log(fire.length ? fire.join("\n") : "ok: no home-made fire"); if (fire.length) process.exitCode = 1; }
    else if (cmd === "check-install") { const b = installBlock(dir); if (b && !rest.includes("--force-dogfood")) { console.error(`REFUSED: ${b}`); process.exitCode = 1; } else console.log(b ? `ok (--force-dogfood over: ${b})` : "ok: the final review passed for these ops"); }
    else { console.error("usage: job.mjs hash|review|stage|fix|check-install <jobDir> ..."); process.exitCode = 2; }
  } catch (e) { console.error(`REFUSED: ${e.message}`); process.exitCode = 1; }
}

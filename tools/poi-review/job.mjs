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
 *   3. The loop is capped: `fix` records each fix attempt in progress.json `fixes`; a third attempt is refused unless
 *      the coordinator passes --coordinator (and it is recorded as theirs).
 *
 *   node tools/poi-review/job.mjs hash   <jobDir>                          the delivered-ops hash a reviewer records
 *   node tools/poi-review/job.mjs review <jobDir> --file <review>          record the FINAL review (verdict read from the file)
 *   node tools/poi-review/job.mjs stage  <jobDir> <stage>                  move the job's stage (gate 2)
 *   node tools/poi-review/job.mjs fix    <jobDir> --what "<the fix>" [--coordinator]   record a fix attempt (gate 3)
 *   node tools/poi-review/job.mjs check-install <jobDir> [--force-dogfood] exit 0 when an installer may run (gate 1)
 *
 * A review file is JSON with `verdict` and `opsHash`, or text/markdown with lines `Verdict: PASS` and
 * `Ops hash: <hash>`. Pure helpers are exported for tests and installers.
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
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
  return null;
}

/**
 * For installers: call first. Exits 1 with the reason unless the final review passed for exactly these ops, or the
 * coordinator passed --force-dogfood (recorded in progress.json unless it is a dry run). An --uninstall or --dry-run
 * is never blocked (a dry run prints what the install would need).
 */
export function requireFinalReview(dir, argv = process.argv) {
  const block = installBlock(dir);
  if (!block) return true;
  if (argv.includes("--uninstall")) return true;
  if (argv.includes("--dry-run") || argv.includes("--dry")) { console.warn(`[install guard] a real install would be refused: ${block}`); return true; }
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
    else if (cmd === "check-install") { const b = installBlock(dir); if (b && !rest.includes("--force-dogfood")) { console.error(`REFUSED: ${b}`); process.exitCode = 1; } else console.log(b ? `ok (--force-dogfood over: ${b})` : "ok: the final review passed for these ops"); }
    else { console.error("usage: job.mjs hash|review|stage|fix|check-install <jobDir> ..."); process.exitCode = 2; }
  } catch (e) { console.error(`REFUSED: ${e.message}`); process.exitCode = 1; }
}

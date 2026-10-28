/**
 * props codex: open prop requests -> Codex design jobs -> gated designs -> the world-kit codex-craft collection.
 *
 * One bounded job per request through tools/codex-task.mjs (staging dir, Codex never in a project folder), with
 * check.mts as the gate; a failed gate is retried ONCE with the gate text fed back; only passing designs land in
 * world-kit/authoring/codex-craft/designs/. Each job appends a ledger line to the request project's
 * authoring/dressing/prop-requests.md. The runner is injectable (tests use a fake; no live Codex in tests).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { PropRequest } from "../_prop-composite-guard.mts";
import { exampleContext, helperContext, propName, writeBrief, type ScaleInfo } from "./brief.mts";
import { dir as collectionDir, writeOrigin } from "./install.mts";
import {readReusePolicy,reuseFaults,reuseBrief} from '../_prop-reuse.mts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PLAYGROUND = path.resolve(HERE, "../..");

export type Req = PropRequest & { project: string };
export interface RunnerResult { status: number; output: string }
/** Runs one codex-task invocation (argv for tools/codex-task.mjs); the real one spawns node, a test one fakes it. */
export type Runner = (args: string[]) => Promise<RunnerResult>;

export const codexTaskRunner: Runner = (args) => new Promise((resolve) => {
  const p = spawn(process.execPath, [path.join(PLAYGROUND, "tools/codex-task.mjs"), ...args], { cwd: PLAYGROUND });
  let output = "";
  p.stdout.on("data", (d) => (output += d)); p.stderr.on("data", (d) => (output += d));
  p.on("close", (status) => resolve({ status: status ?? 1, output }));
});

/** Kit faults, wall sections and the like are not prop jobs: a request whose text says so is skipped. */
export const NOT_A_PROP = /KIT FAULT|palisade|wall section|hanging sign|props wrap wrapper/i;

export interface JobOutcome { request: Req; name: string; status: "pass" | "retry-pass" | "fail" | "codex-error"; attempts: number; seconds: number; tokens: number | null; gate: string; stage?: string; design?: string }

const parseStage = (out: string) => out.match(/stage(?: kept at)? ([^\s;]+codex-staging[^\s;]+)/)?.[1];
const parseTokens = (out: string) => { const m = out.match(/Codex tokens:? ([\d,]+)/i); return m ? Number(m[1]!.replace(/,/g, "")) : null; };

export async function runJob(req: Req, o: { name?: string; scale: ScaleInfo; scales: ScaleInfo[]; worldKit: string; cultureNote?: string; reviewNote?: string; runner?: Runner; jobRoot?: string; log?: (s: string) => void }): Promise<JobOutcome> {
  const runner = o.runner ?? codexTaskRunner, log = o.log ?? (() => {});
  const name = o.name ?? propName(req);
  const reusePolicy=readReusePolicy(o.worldKit),reuse=reuseFaults({name:`${name} ${req.name}`},reusePolicy);
  if(reuse.length)return {request:req,name,status:'fail',attempts:0,seconds:0,tokens:null,gate:reuse.join('\n')};
  const jobDir = path.join(o.jobRoot ?? path.join(os.tmpdir(), "hitreg-prop-codex"), name);
  fs.mkdirSync(jobDir, { recursive: true });
  const helpers = path.join(jobDir, "helpers.py"), examples = path.join(jobDir, "examples.py"), job = path.join(jobDir, "job.json"), brief = path.join(jobDir, "brief.md");
  fs.writeFileSync(helpers, helperContext(o.worldKit));
  fs.writeFileSync(examples, exampleContext(o.worldKit));
  fs.writeFileSync(job, JSON.stringify({ name, culture: req.culture, scale: o.scale, scales: o.scales, worldKit: path.resolve(o.worldKit), ...(req.landmark ? { landmark: req.landmark } : {}) }, null, 2));
  const dest = path.join(collectionDir(o.worldKit), "designs", `${name}.py`);
  const t0 = Date.now(); let tokens: number | null = null, gate = "", stage: string | undefined, retry: string | undefined;
  for (let attempt = 1; attempt <= 2; attempt++) {
    fs.writeFileSync(brief, writeBrief({ request: req, name, scale: o.scale, cultureNote: o.cultureNote, reviewNote: o.reviewNote, retry, reuseNotes:reuseBrief(reusePolicy) }));
    const check = `npx tsx tools/prop-codex/check.mts {stage} --job "${job}"`;
    log(`  ${name}: codex attempt ${attempt}`);
    const r = await runner(["--brief", brief, "--out", `${name}.py=${dest}`, "--context", `${helpers},${examples}`, "--check", check, "--timeout", "1500"]);
    const t = parseTokens(r.output); if (t !== null) tokens = (tokens ?? 0) + t;
    stage = parseStage(r.output) ?? stage;
    const gateFile = stage ? path.join(stage, "gate.txt") : "";
    gate = gateFile && fs.existsSync(gateFile) ? fs.readFileSync(gateFile, "utf8").trim() : r.output.split("\n").filter((l) => /FAIL|did not deliver/.test(l)).join("\n");
    const seconds = Math.round((Date.now() - t0) / 1000);
    if (r.status === 0) return { request: req, name, status: attempt === 1 ? "pass" : "retry-pass", attempts: attempt, seconds, tokens, gate: gate || "pass", stage, design: dest };
    if (r.status !== 1) return { request: req, name, status: "codex-error", attempts: attempt, seconds, tokens, gate: r.output.slice(-600), stage };
    retry = gate || "the design failed the check (no gate text)";
  }
  return { request: req, name, status: "fail", attempts: 2, seconds: Math.round((Date.now() - t0) / 1000), tokens, gate, stage };
}

/** One ledger line per job, appended to the request project's authoring/dressing/prop-requests.md. */
export function ledgerLine(j: JobOutcome): string {
  return `- ${new Date().toISOString().slice(0, 16)} codex ${j.request.id} -> codex-craft/${j.name}: ${j.status} (${j.attempts} attempt${j.attempts > 1 ? "s" : ""}, ${j.seconds}s, ${j.tokens ?? "?"} Codex tokens)${j.status === "pass" || j.status === "retry-pass" ? "" : ` - ${j.gate.split("\n")[0]!.replace(/^- /, "").slice(0, 160)}`}`;
}
export function appendLedger(projectsDir: string, j: JobOutcome): void {
  const f = path.join(projectsDir, j.request.project, "authoring/dressing/prop-requests.md");
  if (!fs.existsSync(f)) fs.writeFileSync(f, "# Prop requests: Codex ledger\n\nOne line per Codex design job (props codex): request -> prop, result, attempts, seconds, tokens.\n");
  fs.appendFileSync(f, ledgerLine(j) + "\n");
}

/** Run a batch of requests in parallel; record the origin of every design that passed. */
export async function runBatch(reqs: Req[], o: { names?: Record<string, string>; scales: ScaleInfo[]; worldKit: string; projectsDir: string; cultureNotes?: Record<string, string>; reviewNotes?: Record<string, string>; runner?: Runner; jobRoot?: string; staggerMs?: number; log?: (s: string) => void }): Promise<JobOutcome[]> {
  // staggered starts: parallel Codex launches on Windows race its sandbox setup ("setup refresh had errors") and burn an attempt
  const stagger = o.staggerMs ?? 25000;
  const results = await Promise.all(reqs.map(async (r, i) => {
    if (i && stagger) await new Promise((res) => setTimeout(res, i * stagger));
    const scale = o.scales.find((s) => s.id === r.scale) ?? { id: r.scale, height: 1.8 };
    return runJob(r, { name: o.names?.[r.id], scale, scales: o.scales, worldKit: o.worldKit, cultureNote: o.cultureNotes?.[r.culture], reviewNote: o.reviewNotes?.[r.id], runner: o.runner, jobRoot: o.jobRoot, log: o.log });
  }));
  for (const j of results) {
    appendLedger(o.projectsDir, j);
    if (j.status === "pass" || j.status === "retry-pass")
      writeOrigin(o.worldKit, j.name, { request: j.request.id, project: j.request.project, for: j.request.for, culture: j.request.culture, scale: j.request.scale, tokens: j.tokens, seconds: j.seconds, attempts: j.attempts, at: new Date().toISOString() });
  }
  return results;
}

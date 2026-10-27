// props codex: the brief writer and the gate wiring (a fake codex-task runner; no live Codex, no Blender).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { propName, writeBrief, kindRange, helperContext, exampleContext } from "../tools/prop-codex/brief.mts";
import { gateFaults, type GeometryRecord } from "../tools/prop-codex/check.mts";
import { runJob, ledgerLine, NOT_A_PROP, type Req, type Runner } from "../tools/prop-codex/run.mts";

const human = { id: "human", height: 1.8 }, scales = [human, { id: "giant", height: 6 }];
const req = (over: Partial<Req> = {}): Req => ({ id: "rural/hanged-thief-iron-gibbet-cage-rural", name: "hanged-thief-iron-gibbet-cage-rural", culture: "rural", scale: "human", for: "gibbet-rise", why: "quest object gibbet-cage; stand-in spoilgate/chain-post", at: "", status: "open", project: "skelmorrow", ...over });

/** A minimal world-kit: the town-craft helper section, the shared Mesh class and two example designs. */
function fakeWorldKit(): string {
  const wk = fs.mkdtempSync(path.join(os.tmpdir(), "prop-codex-wk-"));
  fs.mkdirSync(path.join(wk, "authoring/town-craft"), { recursive: true });
  fs.mkdirSync(path.join(wk, "authoring/crockin-river-culture"), { recursive: true });
  fs.writeFileSync(path.join(wk, "authoring/town-craft/build.py"), "import bpy\ndef block(m,c,size,role='wood',part='x'):pass\ndef beam(m,a,b,w=.07,d=None,role='wood',part='y'):pass\ndef emit(m,family,design):pass\nexec(compile((HERE/'designs.py').read_text()))\n");
  fs.writeFileSync(path.join(wk, "authoring/crockin-river-culture/mesh.py"), "class Mesh:\n    def add(self):pass\n    def object(self,wall=False):pass\n");
  fs.writeFileSync(path.join(wk, "authoring/town-craft/designs.py"), "# MARKET\nm=Mesh('wash-tub-and-board');block(m,(0,0,0),(1,1,1))\nemit(m,'household','tub')\n\nm=Mesh('public-pillory');beam(m,(0,0,0),(0,0,1))\nemit(m,'street','stocks')\n");
  return wk;
}

test("propName: the request slug's first words, the culture never repeated", () => {
  assert.equal(propName(req()), "hanged-thief-iron-gibbet-cage");
  assert.equal(propName(req({ id: "crypt/chain-coil", culture: "crypt" })), "chain-coil");
  assert.ok(propName(req({ id: "bandit/salvage-pile-wreckage-spars-hull-planks" })).length <= 40);
});

test("writeBrief: request, real size for the scale class, KISS rules, contract, retry gate text", () => {
  const b = writeBrief({ request: req({ id: "crypt/chain-coil", name: "chain-coil", culture: "crypt" }), name: "chain-coil", scale: human, cultureNote: "the dead and their keepers" });
  assert.match(b, /`chain-coil`/);
  assert.match(b, /\*\*crypt\*\* culture \(the dead and their keepers\)/);
  assert.match(b, /Size gate: the name reads as a "chain"/); // prop-kind-sizes.json applies
  assert.match(b, /No part smaller than 5 cm/);
  assert.match(b, /m=Mesh\('chain-coil'\)/);
  assert.match(b, /cultures=\['crypt'/);
  assert.doesNotMatch(b, /previous design FAILED/);
  const giant = writeBrief({ request: req(), name: "x", scale: { id: "giant", height: 6 }, retry: "- sub-5 cm detail: 3 part(s)" });
  assert.match(giant, /a door 6\.67 m/);
  assert.match(giant, /previous design FAILED[\s\S]*sub-5 cm detail: 3 part/);
  assert.equal(kindRange("loose-coffin-lid", human), null);
});

test("helper + example context: town-craft's helper section (no emit, no build), the Mesh class, whole example designs", () => {
  const wk = fakeWorldKit();
  const h = helperContext(wk);
  assert.match(h, /class Mesh/);
  assert.match(h, /def block\(/);
  assert.doesNotMatch(h, /def emit\(|def object\(|exec\(compile/);
  const e = exampleContext(wk);
  assert.match(e, /m=Mesh\('wash-tub-and-board'\)[\s\S]*emit\(m,'household','tub'\)/);
  assert.match(e, /m=Mesh\('public-pillory'\)/);
});

const good: GeometryRecord = { name: "chain-coil", design: "coil", category: "tool", mount: "floor", solid: true, setting: "both", cultures: ["crypt"], size: [0.7, 0.2, 0.7], triangles: 400, texel: 39.8,
  parts: [{ part: "coil", role: "iron", faces: 300, extent: [0.7, 0.7, 0.2] }, { part: "loose end", role: "iron", faces: 40, extent: [0.4, 0.1, 0.1] }] };
const job = { name: "chain-coil", culture: "crypt", scale: human, worldKit: "" };

test("gateFaults: a landmark request is built at full height, never a small prop scaled up", () => {
  const tall: GeometryRecord = { ...good, size: [5, 18.2, 9], triangles: 2100 };
  assert.match(gateFaults(tall, job, scales).join(" | "), /size: 18.20 m.*at most|triangles: 2100 > 1200/, "a plain request refuses an 18 m frame");
  const lm = { ...job, landmark: 18 };
  assert.deepEqual(gateFaults(tall, lm, scales), [], "an 18 m landmark request passes at 18.2 m and 2100 triangles");
  assert.match(gateFaults({ ...tall, size: [2, 6, 3] }, lm, scales).join(" | "), /height: 6.00 m; the landmark is 18 m/, "a landmark built small is refused");
  assert.match(gateFaults({ ...tall, triangles: 3000 }, lm, scales).join(" | "), /triangles: 3000 > 2400/);
  assert.match(writeBrief({ request: req({ landmark: 18 }), name: "mine-headframe", scale: human }), /LANDMARK structure[\s\S]*18 m tall/);
});

test("gateFaults: a sound design passes; each rule refuses its fault", () => {
  assert.deepEqual(gateFaults(good, job, scales), []);
  assert.match(gateFaults({ ...good, error: "NameError: x" }, job, scales)[0]!, /build failed: NameError/);
  const f = (over: Partial<GeometryRecord>) => gateFaults({ ...good, ...over }, job, scales).join(" | ");
  assert.match(f({ triangles: 2000 }), /triangles: 2000 > 1200/);
  assert.match(f({ parts: [...good.parts!, { part: "rivet", role: "iron", faces: 12, extent: [0.02, 0.02, 0.01] }] }), /sub-5 cm detail: 1 part.*rivet/);
  assert.match(f({ texel: 20 }), /texel density 20/);
  assert.match(f({ size: [7, 1, 1] }), /at most 6\.0 m/);
  assert.match(f({ size: [0.7, 1.6, 0.7] }), /real size: a chain 1\.6 m tall/);
  assert.match(f({ cultures: ["civic"] }), /must include "crypt"/);
  assert.match(f({ mount: "hover" }), /mount "hover"/);
  assert.match(f({ mount: "surface" }), /surface prop is 0\.70 m/);
  assert.match(f({ category: "weapon" }), /category "weapon"/);
  assert.match(f({ parts: [good.parts![0]!] }), /one part only/);
});

test("runJob: a failed gate is retried once with its text in the brief; the design lands only on a pass", async () => {
  const wk = fakeWorldKit(), jobRoot = fs.mkdtempSync(path.join(os.tmpdir(), "prop-codex-job-")), stage = fs.mkdtempSync(path.join(os.tmpdir(), "codex-staging-"));
  const calls: string[][] = [];
  const runner: Runner = async (args) => {
    calls.push(args);
    const brief = fs.readFileSync(args[args.indexOf("--brief") + 1]!, "utf8");
    const [, dest] = args[args.indexOf("--out") + 1]!.split("=");
    assert.match(args[args.indexOf("--check") + 1]!, /check\.mts \{stage\} --job/);
    if (calls.length === 1) {
      fs.writeFileSync(path.join(stage, "gate.txt"), "- sub-5 cm detail: 2 part(s) under 5 cm (nail)\n");
      return { status: 1, output: `FAIL chain-coil: sub-5 cm detail\ncheck failed; nothing installed; stage kept at ${stage}\n` };
    }
    assert.match(brief, /previous design FAILED[\s\S]*nail/);
    fs.mkdirSync(path.dirname(dest!), { recursive: true });
    fs.writeFileSync(dest!, "m=Mesh('chain-coil')\n");
    return { status: 0, output: `installed 1 file(s) in 12s; Codex tokens: 1,234; stage ${stage}\n` };
  };
  const r = await runJob(req({ id: "crypt/chain-coil", name: "chain-coil", culture: "crypt" }), { scale: human, scales, worldKit: wk, runner, jobRoot });
  assert.equal(r.status, "retry-pass");
  assert.equal(r.attempts, 2);
  assert.equal(r.tokens, 1234);
  assert.ok(fs.existsSync(path.join(wk, "authoring/codex-craft/designs/chain-coil.py")));
  assert.match(ledgerLine(r), /codex crypt\/chain-coil -> codex-craft\/chain-coil: retry-pass \(2 attempts, \d+s, 1234 Codex tokens\)/);

  const failing: Runner = async () => { fs.writeFileSync(path.join(stage, "gate.txt"), "- triangles: 3000 > 1200\n"); return { status: 1, output: `stage kept at ${stage}` }; };
  const f = await runJob(req({ id: "crypt/spade", name: "spade", culture: "crypt" }), { scale: human, scales, worldKit: wk, runner: failing, jobRoot });
  assert.equal(f.status, "fail");
  assert.ok(!fs.existsSync(path.join(wk, "authoring/codex-craft/designs/spade.py")));
  assert.match(ledgerLine(f), /fail .* - triangles: 3000 > 1200/);
});

test("NOT_A_PROP: kit faults, wall sections, signs and wrapper jobs are not Codex prop jobs", () => {
  assert.ok(NOT_A_PROP.test("rural/rope-bridge-end-frame KIT FAULT, not a site fault"));
  assert.ok(NOT_A_PROP.test("rural/marsh-stake-palisade-sharpened-log-stakes"));
  assert.ok(!NOT_A_PROP.test("rural/tar-boiler-cold-iron-pot-on-a-stand quest object tar-boiler"));
});

test("redo brief and the new mounts: review note, ceiling, no modelled smoke, water as an engine disc", () => {
  const b = writeBrief({ request: req(), name: "gibbet-cage", scale: human, reviewNote: "cage only, no post: it hangs from existing beams" });
  assert.match(b, /sent it back[\s\S]*cage only, no post/);
  assert.match(b, /`ceiling`: hangs from a beam/);
  assert.match(b, /Never model smoke/);
  assert.match(b, /water=dict\(centre=/);
  assert.deepEqual(gateFaults({ ...good, mount: "ceiling" }, job, scales), []);
  const pool = { ...good, size: [1.6, 0.4, 1.6], water: { centre: [0, 0.25, 0], radius: 0.6, depth: 0.5 } };
  assert.deepEqual(gateFaults(pool, job, scales), []);
  assert.match(gateFaults({ ...pool, water: { centre: [0, 0.25, 0], radius: 1.2, depth: 0.5 } }, job, scales).join(), /spills past/);
  assert.match(gateFaults({ ...pool, water: { centre: [0, 0.25, 0], radius: 0.6, depth: 9 } }, job, scales).join(), /water depth 9/);
});

test("request reopen: a made request goes back to open with the reason kept", async () => {
  const { addRequest, closeRequest, reopenRequest, readRequests } = await import("../tools/_prop-composite-guard.mts");
  const p = fs.mkdtempSync(path.join(os.tmpdir(), "prop-req-"));
  const r = addRequest(p, { name: "kelp pit", culture: "rural", scale: "human", for: "kelp-kilns", why: "" });
  closeRequest(p, r.id, "made", "codex-craft/kelp-burning-pit");
  const o = reopenRequest(p, r.id, "smoke modelled as blobs");
  assert.equal(o.status, "open");
  assert.equal(readRequests(p)[0]!.made, undefined);
  assert.match((readRequests(p)[0] as any).reopened[0], /was made \(codex-craft\/kelp-burning-pit\): smoke modelled as blobs/);
  assert.throws(() => reopenRequest(p, r.id, "again"), /already open/);
});

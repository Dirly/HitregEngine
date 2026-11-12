import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { updateJsonFile, writeJsonFile } from "../tools/_scene-write.mts";
import { placeOfFeature, placeOfNeed } from "../tools/_exterior.mts";
import { run as conceptCheck } from "../tools/zonegen/commands/concept-check.mts";
// @ts-ignore plain JS engine tool module
import { CONCEPT_TOOL, fileSha, uneditedStamp } from "../../../tools/poi-review/concept-site.mjs";
// @ts-ignore plain JS engine tool module
import { exteriorChain, exteriorPlaces, loadExterior, placeOwnership } from "../../../tools/poi-review/exterior-chain.mjs";

type J = Record<string, any>;
const REQUESTS = fs.mkdtempSync(path.join(os.tmpdir(), "exterior-guard-requests-"));
process.env.HITREG_IMAGE_REQUESTS = REQUESTS;
process.on("exit", () => fs.rmSync(REQUESTS, { recursive: true, force: true }));

const recipe = (): J => ({
  version: 1, name: "w", seed: 1, pipeline: {},
  needs: [{ id: "hold-face", kind: "cliff-face", for: "hold", near: [100, 50], solved: { at: [100, 50], patch: "need-hold-face" } }],
  features: {
    heightPatches: [{ id: "need-hold-face", origin: [80, 30], size: [40, 40] }],
    operators: [{ id: "pb-hold-front", op: "landmark", at: [100, 50], compiled: { pieces: ["landmarks/op:pb-hold-front:landmark"] } }],
    clearings: [{ id: "meadow", center: [300, 300], radius: 5 }],
  },
});

/** projects/wp: a zoned world `w` with the entrance `hold` (staged nowhere: an entrance reservation is enforced). */
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "exterior-guard-"));
  const pd = path.join(root, "projects", "wp"), zone = path.join(pd, "authoring", "zonegen", "w", "zones", "zone-1");
  for (const d of [path.join(zone, "concept"), path.join(pd, "assets", "worlds"), path.join(pd, "assets", "scenes")]) fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(zone, "reservations.json"), JSON.stringify({ reservations: [{ location: "hold", center: [100, 50], radius: 20, terrainRadius: 40, entrance: true }] }));
  const wf = path.join(pd, "assets", "worlds", "w.json"), sf = path.join(pd, "assets", "scenes", "w.scene.json");
  fs.writeFileSync(wf, JSON.stringify(recipe()));
  fs.writeFileSync(sf, JSON.stringify({ entities: { "poi-hold": { tags: ["poi:hold"], components: {} }, tree: { components: {} } } }));
  return { root, pd, zone, wf, sf, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}
function grabAndPaint(fx: ReturnType<typeof fixture>): string {
  const c = path.join(fx.zone, "concept"), render = path.join(c, "hold-far.site.png"), frame = path.join(c, "hold-far.png");
  fs.writeFileSync(render, "bare");
  const r = JSON.parse(fs.readFileSync(fx.wf, "utf8")), place = exteriorPlaces(fx.pd, "w")[0], own = placeOwnership(r, place);
  fs.writeFileSync(path.join(c, "hold.site.json"), JSON.stringify({ tool: CONCEPT_TOOL, poi: "hold", reservation: { center: [100, 50], radius: 20, terrainRadius: 40 }, worldFile: fx.wf, ownership: own,
    unedited: uneditedStamp(r, { center: [100, 50], radius: 40 }, own), renderedAt: new Date().toISOString(), renders: { far: { file: path.basename(render), sha256: fileSha(render) } } }));
  fs.writeFileSync(frame, "painted");
  fs.writeFileSync(path.join(REQUESTS, `hold-${Math.random()}.json`), JSON.stringify({ id: "concept-hold-far", status: "done", createdAt: new Date().toISOString(), target: frame, refs: [render] }));
  fs.writeFileSync(path.join(c, "hold-sheet.png"), "sheet");
  return frame;
}
const ctxOf = (fx: ReturnType<typeof fixture>, opts: Record<string, string> = {}, flags: string[] = []) => ({
  project: "wp", world: "w", zone: "zone-1", opt: (n: string, f = "") => ({ poi: "hold", ...opts })[n] ?? f, flag: (n: string) => flags.includes(n),
  paths: { projectDir: fx.pd, zoneDir: (z: string) => path.join(fx.pd, "authoring", "zonegen", "w", "zones", z) },
});

test("scene-write refuses a world scene write that builds an unready place, passes everything else", () => {
  const fx = fixture();
  try {
    assert.throws(() => updateJsonFile<J>(fx.sf, (d: any) => { d.entities["hold-veil"] = { parent: "poi-hold", components: {} }; return { doc: d }; }), /hold in w is not ready[\s\S]*missing step: grab/);
    assert.ok(!JSON.parse(fs.readFileSync(fx.sf, "utf8")).entities["hold-veil"], "nothing written");
    updateJsonFile<J>(fx.sf, (d: any) => { d.entities.tree.name = "oak"; return { doc: d }; });
    updateJsonFile<J>(fx.sf, (d: any) => { delete d.entities["poi-hold"]; return { doc: d, removed: ["poi-hold"] }; });
    assert.equal(JSON.parse(fs.readFileSync(fx.sf, "utf8")).entities.tree.name, "oak");
  } finally { fx.cleanup(); }
});

test("scene-write refuses a world recipe write of the place's need / operator; an owner ruling passes and is recorded", () => {
  const fx = fixture();
  try {
    const solved = recipe(); solved.needs[0].solved.raised = 62;
    assert.throws(() => writeJsonFile(fx.wf, solved), /not ready/);
    const op = recipe(); op.features.operators[0].at = [101, 50];
    assert.throws(() => updateJsonFile(fx.wf, () => ({ doc: op })), /not ready/);
    const other = recipe(); other.features.clearings[0].radius = 9;
    writeJsonFile(fx.wf, other);
    process.env.HITREG_NO_CONCEPT_RULING = "2026-11-10 Derek: solve the face as it is";
    try { writeJsonFile(fx.wf, solved); } finally { delete process.env.HITREG_NO_CONCEPT_RULING; }
    assert.equal(loadExterior(fx.pd, "w").rulings.at(-1).ruling, "2026-11-10 Derek: solve the face as it is");
  } finally { fx.cleanup(); }
});

test("the hooks find the place a need or an operator belongs to", () => {
  const fx = fixture();
  try {
    assert.equal(placeOfNeed(fx.pd, "w", recipe(), "hold-face"), "hold");
    assert.equal(placeOfFeature(fx.pd, "w", recipe(), recipe().features.operators[0]), "hold");
    assert.equal(placeOfFeature(fx.pd, "w", recipe(), { id: "talus-hold-apron", op: "scree", from: [[95, 45]], to: [100, 50] }), "hold", "named for it at its site");
    assert.equal(placeOfFeature(fx.pd, "w", recipe(), { id: "talus-hold-apron", op: "scree", from: [[4000, 4000]], to: [4010, 4000] }), null, "named for it but far away");
    assert.equal(placeOfFeature(fx.pd, "w", recipe(), recipe().features.clearings[0]), null);
  } finally { fx.cleanup(); }
});

test("zonegen concept-check: refuses before the grab, needs a target, then records the check and the chain is complete", async () => {
  const fx = fixture();
  const log = console.log, err = console.error;
  console.log = () => {}; console.error = () => {};
  try {
    assert.equal(await conceptCheck(ctxOf(fx)), 3, "no grab yet");
    const frame = grabAndPaint(fx);
    assert.equal(await conceptCheck(ctxOf(fx)), 2, "no target");
    assert.equal(await conceptCheck(ctxOf(fx, { target: "elsewhere.png" })), 2, "a target that is not a frame");
    assert.equal(await conceptCheck(ctxOf(fx, { target: frame })), 0);
    const rec = loadExterior(fx.pd, "w").checks.hold;
    assert.equal(rec.target.sha256, fileSha(frame));
    assert.ok(exteriorChain(fx.pd, "w", "hold").ok);
    // now the build goes through
    updateJsonFile<J>(fx.sf, (d: any) => { d.entities["hold-veil"] = { parent: "poi-hold", components: {} }; return { doc: d }; });
  } finally { console.log = log; console.error = err; fx.cleanup(); }
});

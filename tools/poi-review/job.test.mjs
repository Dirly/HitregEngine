import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { artBlock, deliversArt, finalReviewBlock, footprintPoints, jobHandoff, jobParent, measureSize, ownerApproval, readReview, rubricCodes, sizeBlock, deliversMaterialModels, deliversStructures, flatArtBlock, installBlock, terrainFineBlock, fineExceptionsFile, isMonumentSite, monumentApproachBlock, ownerOverrideScenes, opsHash, recordFix, recordReview, requireFinalReview, seeThroughBlock, setStage, stageBlock, catalogueIds, designBlock, designCodes, designFaults, designHash, recordDesignReview } from "./job.mjs";

function job({ designed = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "poi-job-"));
  fs.writeFileSync(path.join(dir, "progress.json"), JSON.stringify({ version: 1, poiId: "t", ownerAgentId: "POI-T (Opus), continuing POI-T0", stage: "blockout", evidence: {}, viewpoints: [], fixes: [], finalReview: null }));
  fs.writeFileSync(path.join(dir, "brief.json"), JSON.stringify({ id: "t", adventureSize: "pinpoint" }));
  // a pinpoint shrine: 20 m across, 200 m2 measured, one landmark, one approach
  fs.writeFileSync(path.join(dir, "handoff.json"), JSON.stringify({ integration: { sceneOps: "ops.json", worldOps: "world-ops.json + clearings.json" }, measurements: { measuredCombinedUsableAreaM2: 200, features: [{ id: "shrine", kind: "landmark" }], approaches: [{ from: "road-1" }] } }));
  fs.writeFileSync(path.join(dir, "ops.json"), "[]");
  fs.writeFileSync(path.join(dir, "world-ops.json"), "[]");
  fs.writeFileSync(path.join(dir, "clearings.json"), JSON.stringify([{ id: "shrine-yard", center: [100, 50], radius: 10 }]));
  if (designed) passDesign(dir);
  return dir;
}
/** A review file a fresh reviewer writes: verdict, ops hash, reviewer id and every Quality + Site + Place rubric answer. */
function reviewText(dir, { verdict = "PASS", reviewer = "REV-T1", skip = [], fault = [] } = {}) {
  const lines = rubricCodes().filter((c) => !skip.includes(c)).map((c) => `- ${c}: ${fault.includes(c) ? "fault" : "pass"} — evidence/${c.toLowerCase()}.png shows it`);
  return ["# Final review", `Verdict: ${verdict}`, `Ops hash: ${opsHash(dir)}`, ...(reviewer ? [`Reviewer: ${reviewer}`] : []), "", ...lines, ""].join("\n");
}
/** A pinpoint shrine's design.json (gate 16): premise, journey, one area, two elements, the finished sample's frame, a reference frame. */
function designJson(dir, patch = {}) {
  fs.mkdirSync(path.join(dir, "evidence", "design"), { recursive: true });
  fs.writeFileSync(path.join(dir, "evidence", "design", "yard-12.png"), "png");
  fs.writeFileSync(path.join(dir, "evidence", "reference.png"), "png");
  fs.mkdirSync(path.join(dir, "concept"), { recursive: true });
  fs.writeFileSync(path.join(dir, "concept", "01-shrine.png"), "png");
  const design = {
    version: 1,
    premise: "A roadside shrine where carters leave a stone for a safe crossing of the moor.",
    journey: ["The cairn and its lamp are seen from the road bend.", "The player walks up the worn step to the niche.", "A note on the slab names the drowned carter; a stone can be left."],
    areas: [{ id: "yard", purpose: "The cairn, its step and the niche where stones are left.", elements: ["cairn", "lamp"] }],
    elements: [
      { id: "cairn", shows: "Carters have stacked stones here for years.", madeOf: ["structure: dry-stone cairn", "poi-props/offering-stones"] },
      { id: "lamp", shows: "Someone keeps the shrine lit at night.", madeOf: ["poi-props/standing-torch"] },
    ],
    sample: { area: "yard", shots: ["evidence/design/yard-12.png"] },
    reference: ["evidence/reference.png"],
    concept: ["concept/01-shrine.png"],
    ...patch,
  };
  fs.writeFileSync(path.join(dir, "design.json"), JSON.stringify(design, null, 2));
  return design;
}
/** A design review file: verdict, design hash, reviewer and every Place line. */
function designReviewText(dir, { verdict = "PASS", reviewer = "REV-D1", skip = [], fault = [], na = [] } = {}) {
  const lines = designCodes().filter((c) => !skip.includes(c)).map((c) => `- ${c}: ${fault.includes(c) ? "fault" : na.includes(c) ? "n/a" : "pass"} — evidence/design/yard-12.png shows it`);
  return ["# Design review", `Verdict: ${verdict}`, `Design hash: ${designHash(dir)}`, ...(reviewer ? [`Reviewer: ${reviewer}`] : []), "", ...lines, ""].join("\n");
}
function passDesign(dir) {
  designJson(dir);
  fs.writeFileSync(path.join(dir, "design-review.md"), designReviewText(dir));
  recordDesignReview(dir, path.join(dir, "design-review.md"));
}
const progress = (dir) => JSON.parse(fs.readFileSync(path.join(dir, "progress.json"), "utf8"));

test("footprint measures transformed contents, not an empty dressing origin or unresolved local coordinates", () => {
  const dir = job();
  try {
    fs.writeFileSync(path.join(dir, "clearings.json"), "[]");
    const s = Math.SQRT1_2;
    const entity = (id, parent, transform, physical = false) => ({ op: "add-entity", id, entity: { parent, components: { transform, ...(physical ? { mesh: {} } : {}) } } });
    fs.writeFileSync(path.join(dir, "ops.json"), JSON.stringify([
      entity("dressing", null, { position: [0, 0, 0] }),
      entity("nets", "dressing", { position: [-3000, 125, -100] }, true),
      entity("store", "dressing", { position: [-2990, 125, -100], rotation: [0, s, 0, s], scale: [2, 1, 2] }),
      entity("goods", "store", { position: [5, 0, 0] }, true),
      entity("unresolved", "external-building", { position: [1, 0, 1] }, true),
    ]));
    const points = footprintPoints(dir);
    assert.ok(!points.some(([x, z]) => x === 0 && z === 0), "identity containers cannot inflate the site to the world origin");
    assert.ok(points.some(([x, z]) => x === -3000 && z === -100));
    assert.ok(points.some(([x, z]) => Math.abs(x + 2990) < 1e-8 && Math.abs(z + 110) < 1e-8), "nested translation, rotation and scale produce a world-space point");
    assert.ok(!points.some(([x, z]) => x === 1 && z === 1), "unknown parent transforms cannot be treated as world coordinates");
  } finally {
    assert.equal(path.dirname(path.resolve(dir)), path.resolve(os.tmpdir()));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("the ops hash covers clearings.json and bridges.json even when the handoff names only scene and world ops", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "poi-hash-"));
  fs.writeFileSync(path.join(dir, "handoff.json"), JSON.stringify({ integration: { sceneOps: "ops.json", worldOps: "world-ops.json" } }));
  fs.writeFileSync(path.join(dir, "ops.json"), "[]");
  fs.writeFileSync(path.join(dir, "world-ops.json"), "[]");
  const bare = opsHash(dir);
  fs.writeFileSync(path.join(dir, "clearings.json"), JSON.stringify([{ id: "sightline", at: [0, 0], r: 6 }]));
  const withClearing = opsHash(dir);
  assert.notEqual(withClearing, bare, "a sightline clearing changes the hash");
  fs.writeFileSync(path.join(dir, "clearings.json"), JSON.stringify([{ id: "sightline", at: [0, 0], r: 8 }]));
  assert.notEqual(opsHash(dir), withClearing, "and so does editing it");
  const before = opsHash(dir);
  fs.writeFileSync(path.join(dir, "bridges.json"), JSON.stringify([{ id: "span" }]));
  assert.notEqual(opsHash(dir), before, "a rope bridge too");
});

test("no install without a final PASS review of exactly the delivered ops", () => {
  const dir = job();
  assert.match(installBlock(dir), /no final review/);
  const h = opsHash(dir);
  fs.writeFileSync(path.join(dir, "final-review.md"), reviewText(dir, { verdict: "FAIL" }));
  recordReview(dir, path.join(dir, "final-review.md"));
  assert.match(installBlock(dir), /verdict is FAIL/);
  fs.writeFileSync(path.join(dir, "final-review.md"), reviewText(dir));
  assert.equal(h, opsHash(dir));
  recordReview(dir, path.join(dir, "final-review.md"));
  // gate 5: the float report must exist, pass, and be newer than the ops
  assert.match(installBlock(dir), /no float gate evidence/);
  fs.mkdirSync(path.join(dir, "reports"), { recursive: true });
  fs.writeFileSync(path.join(dir, "reports", "float.json"), JSON.stringify({ ok: false, counts: { off: 2, unsupported: 1 } }));
  assert.match(installBlock(dir), /float gate failed/);
  fs.writeFileSync(path.join(dir, "reports", "float.json"), JSON.stringify({ ok: true, counts: { off: 0, unsupported: 0 } }));
  const later = new Date(Date.now() + 5000);
  fs.utimesSync(path.join(dir, "reports", "float.json"), later, later);
  // gate 6: the rock-skins report likewise
  assert.match(installBlock(dir), /no rock-skins gate evidence/);
  fs.writeFileSync(path.join(dir, "reports", "rock-skins.json"), JSON.stringify({ ok: false, counts: { skin: 3, cap: 1, recipe: 0 } }));
  assert.match(installBlock(dir), /rock-skins gate failed.*3 skin/);
  fs.writeFileSync(path.join(dir, "reports", "rock-skins.json"), JSON.stringify({ ok: true, counts: { skin: 0, cap: 0, recipe: 0 } }));
  fs.utimesSync(path.join(dir, "reports", "rock-skins.json"), later, later);
  // gate 7: the water-edges report likewise
  assert.match(installBlock(dir), /no water-edges gate evidence/);
  fs.writeFileSync(path.join(dir, "reports", "water-edges.json"), JSON.stringify({ ok: false, rows: [{ kind: "edge" }, { kind: "curtain" }] }));
  assert.match(installBlock(dir), /water-edges gate failed.*2 fault/);
  fs.writeFileSync(path.join(dir, "reports", "water-edges.json"), JSON.stringify({ ok: true, rows: [] }));
  fs.utimesSync(path.join(dir, "reports", "water-edges.json"), later, later);
  // gate 14: a real body walked it — a whole run, ok, newer than the ops
  assert.match(installBlock(dir), /no walk gate evidence \(gate 14\)/);
  const walk = path.join(dir, "reports", "walk.json");
  fs.writeFileSync(walk, JSON.stringify({ ok: false, counts: { FALL: 1, "NO-ROUTES": 1 }, faults: [{ kind: "FALL", what: "path:bank (forward) leg 2", detail: "fell 18 m in 0.5 s" }] }));
  fs.utimesSync(walk, later, later);
  assert.match(installBlock(dir), /walk gate failed \(gate 14\): 1 FALL, 1 NO-ROUTES — FALL path:bank/);
  fs.writeFileSync(walk, JSON.stringify({ ok: true, partial: "door", counts: {}, faults: [] }));
  fs.utimesSync(walk, later, later);
  assert.match(installBlock(dir), /partial run/);
  fs.writeFileSync(walk, JSON.stringify({ ok: true, partial: null, counts: {}, faults: [] }));
  fs.utimesSync(walk, later, later);
  assert.equal(installBlock(dir), null);
  // an edit after the review re-opens it
  fs.writeFileSync(path.join(dir, "clearings.json"), '[{"id":"x"}]');
  assert.match(installBlock(dir), /changed after the final review/);
  assert.throws(() => recordReview(dir, path.join(dir, "final-review.md")), /reviewed ops/);
  // the coordinator's dogfood bypass passes and is recorded
  assert.equal(requireFinalReview(dir, ["node", "install.mts", "--force-dogfood"]), true);
  assert.equal(progress(dir).forcedInstalls.length, 1);
});

test("the grey box proves the read: no stage past blockout without a read shot from a declared viewpoint", () => {
  const dir = job();
  assert.match(stageBlock(dir, "greybox-review"), /readShot/);
  const p = progress(dir);
  fs.mkdirSync(path.join(dir, "evidence"), { recursive: true });
  fs.writeFileSync(path.join(dir, "evidence/read.png"), "png");
  p.evidence.readShot = { file: "evidence/read.png", viewpoint: "road-bend" };
  fs.writeFileSync(path.join(dir, "progress.json"), JSON.stringify(p));
  assert.match(stageBlock(dir, "greybox-review"), /not a declared viewpoint/);
  p.viewpoints = [{ id: "road-bend", at: [0, 2, 0], look: [10, 0, 0] }];
  fs.writeFileSync(path.join(dir, "progress.json"), JSON.stringify(p));
  assert.equal(setStage(dir, "greybox-review").stage, "greybox-review");
  assert.equal(stageBlock(dir, "survey"), null);
  assert.match(stageBlock(dir, "installed"), /no final review/);
});

test("the fix loop is capped at two; the third needs the coordinator", () => {
  const dir = job();
  assert.equal(recordFix(dir, "raise the gibbet"), 1);
  assert.equal(recordFix(dir, "light the carts"), 2);
  assert.throws(() => recordFix(dir, "again"), /fix attempt 3 refused/);
  assert.equal(recordFix(dir, "cut the carts", { coordinator: true }), 3);
  assert.equal(progress(dir).fixes[2].by, "coordinator");
});

test("fire is the engine's fire: home-made flames and raw lights block the stage past blockout and the install", async () => {
  const { fireFaults } = await import("./job.mjs");
  const dir = job();
  const ops = [
    { op: "add-entity", id: "lamp", entity: { name: "The Lamp", parent: null, components: { transform: {} } } },
    { op: "add-entity", id: "lamp-fire", entity: { name: "lamp-fire (greybox)", parent: "lamp", components: { mesh: { source: { kind: "primitive", shape: "cone" }, material: "fx/fire" } } } },
    { op: "add-entity", id: "lamp-light", entity: { name: "glow", parent: "lamp", components: { light: { kind: "point" } } } },
    { op: "add-entity", id: "firewood", entity: { name: "firewood stack", parent: null, components: { mesh: { source: { kind: "primitive", shape: "box" }, material: "wood" } } } },
    { op: "add-entity", id: "brazier", entity: { name: "brazier", parent: null, components: { prefab: { prefabId: "poi-props/brazier" } } } },
    { op: "add-entity", id: "brazier-light", entity: { name: "brazier glow", parent: "brazier", components: { light: { kind: "point" } } } },
  ];
  fs.writeFileSync(path.join(dir, "ops.json"), JSON.stringify(ops));
  const faults = fireFaults(dir);
  assert.equal(faults.length, 2, faults.join("\n"));
  assert.match(faults[0], /lamp-fire.*primitive cone/);
  assert.match(faults[1], /lamp-light.*raw light/);
  fs.writeFileSync(path.join(dir, "shot.png"), "x");
  const p = progress(dir); p.viewpoints = [{ id: "v" }]; p.evidence = { readShot: { file: "shot.png", viewpoint: "v" } };
  fs.writeFileSync(path.join(dir, "progress.json"), JSON.stringify(p));
  assert.match(stageBlock(dir, "greybox-review"), /home-made fire/);
  assert.equal(stageBlock(dir, "blockout"), null);
  fs.writeFileSync(path.join(dir, "ops.json"), JSON.stringify(ops.filter((o) => !["lamp-fire", "lamp-light"].includes(o.id))));
  assert.deepEqual(fireFaults(dir), []);
  assert.equal(stageBlock(dir, "greybox-review"), null);
});

test("gate 8: a job with built structures needs a passing see-through report newer than its ops", () => {
  const dir = job();
  assert.equal(deliversStructures(dir), false);
  assert.equal(seeThroughBlock(dir), null); // loose props only: the gate does not apply
  fs.writeFileSync(path.join(dir, "ops.json"), JSON.stringify([{ op: "add-entity", id: "wall", components: { transform: {}, mesh: { source: { kind: "asset", assetId: "x/wall.glb" } } } }]));
  assert.equal(deliversStructures(dir), true);
  assert.match(seeThroughBlock(dir), /no see-through gate evidence \(gate 8\)/);
  fs.mkdirSync(path.join(dir, "reports"), { recursive: true });
  const rep = path.join(dir, "reports", "see-through.json");
  fs.writeFileSync(rep, JSON.stringify({ ok: false, counts: { sites: 4 }, sheet: "see-through/sheet.png" }));
  assert.match(seeThroughBlock(dir), /see-through gate failed \(gate 8\): 4 hole site/);
  fs.writeFileSync(rep, JSON.stringify({ ok: true, counts: { sites: 0 } }));
  const later = new Date(Date.now() + 60000);
  fs.utimesSync(rep, later, later);
  assert.equal(seeThroughBlock(dir), null);
  const older = new Date(Date.now() - 60000);
  fs.utimesSync(rep, older, older);
  assert.match(seeThroughBlock(dir), /older than .*ops.json/);
});

test("gate 9: a job delivering a model with an engine material (a flat-art slab) needs a passing flat-art report", () => {
  const dir = job();
  fs.writeFileSync(path.join(dir, "ops.json"), JSON.stringify([{ op: "add-entity", id: "wall", components: { transform: {}, mesh: { source: { kind: "asset", assetId: "x/wall.glb" } } } }]));
  assert.equal(deliversMaterialModels(dir), false);
  assert.equal(flatArtBlock(dir), null); // no engine material on a model: nothing to judge
  fs.writeFileSync(path.join(dir, "ops.json"), JSON.stringify([{ op: "add-entity", id: "relief", components: { transform: {}, mesh: { source: { kind: "asset", assetId: "x/relief.glb" }, material: "x/relief" } } }]));
  assert.match(flatArtBlock(dir), /no flat-art gate evidence \(gate 9\)/);
  fs.mkdirSync(path.join(dir, "reports"), { recursive: true });
  const rep = path.join(dir, "reports", "flat-art.json");
  fs.writeFileSync(rep, JSON.stringify({ ok: false, faults: 1, failures: [{ what: "scene:x relief is flipped" }] }));
  assert.match(flatArtBlock(dir), /flat-art gate failed \(gate 9\): 1 slab.*relief is flipped/);
  fs.writeFileSync(rep, JSON.stringify({ ok: true, faults: 0 }));
  const later = new Date(Date.now() + 60000);
  fs.utimesSync(rep, later, later);
  assert.equal(flatArtBlock(dir), null);
});

test("gate 10: a monument or butte site with built structures needs a passing monument-approach report", () => {
  const dir = job();
  fs.writeFileSync(path.join(dir, "ops.json"), JSON.stringify([{ op: "add-entity", id: "stair", components: { transform: {}, mesh: { source: { kind: "asset", assetId: "x/stair.glb" } } } }]));
  assert.equal(isMonumentSite(dir), false);
  assert.equal(monumentApproachBlock(dir), null);
  fs.writeFileSync(path.join(dir, "brief.json"), JSON.stringify({ id: "t", name: "The Old Kings", description: "Landmark: the King's Table mesa, reached by one stair" }));
  assert.equal(isMonumentSite(dir), true);
  assert.match(monumentApproachBlock(dir), /no monument-approach gate evidence \(gate 10\)/);
  fs.mkdirSync(path.join(dir, "reports"), { recursive: true });
  const rep = path.join(dir, "reports", "monument-approach.json");
  fs.writeFileSync(rep, JSON.stringify({ ok: false, counts: { faults: 1 }, failures: [{ what: "old-kings: stair-1 stands free" }] }));
  assert.match(monumentApproachBlock(dir), /monument-approach gate failed \(gate 10\): 1 free-standing stair.*stair-1 stands free/);
  fs.writeFileSync(rep, JSON.stringify({ ok: true, counts: { faults: 0 } }));
  const later = new Date(Date.now() + 60000);
  fs.utimesSync(rep, later, later);
  assert.equal(monumentApproachBlock(dir), null);
  // handoff.siteKind overrides the brief's words
  fs.writeFileSync(path.join(dir, "handoff.json"), JSON.stringify({ siteKind: "camp" }));
  fs.writeFileSync(path.join(dir, "brief.json"), JSON.stringify({ id: "t", description: "a camp" }));
  assert.equal(isMonumentSite(dir), false);
});

test("installers re-apply the owner's edits last: the job's project scenes with owner overrides", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "owner-last-"));
  const jobDir = path.join(root, "apps", "playground", "projects", "w", "authoring", "zonegen", "w", "zones", "z", "pois", "p");
  fs.mkdirSync(jobDir, { recursive: true });
  assert.deepEqual(ownerOverrideScenes(jobDir).list, []);
  const od = path.join(root, "apps", "playground", "projects", "w", "authoring", "owner-overrides");
  fs.mkdirSync(od, { recursive: true });
  fs.writeFileSync(path.join(od, "w.json"), "{}");
  fs.writeFileSync(path.join(od, "w.inverse.json"), "{}");
  const s = ownerOverrideScenes(jobDir);
  assert.equal(s.project, "w");
  assert.deepEqual(s.list, ["w"]);
  assert.equal(s.playground, path.join(root, "apps", "playground"));
});

test("gate 11: a delivered terrain carve finer than 6 m fails; operator, wall and bridge pieces pass", () => {
  const dir = job();
  fs.writeFileSync(path.join(dir, "world-ops.json"), JSON.stringify({ features: { passages: [{ id: "hall", width: 12, length: 20, height: 8 }], heightPatches: [{ id: "op:hill:ground", size: [3, 3] }] } }));
  assert.equal(terrainFineBlock(dir), null);
  fs.writeFileSync(path.join(dir, "world-ops.json"), JSON.stringify([
    { edit: "add-feature", kind: "passages", feature: { id: "kings-tread-7", width: 3.6, length: 1.4, height: 4.2 } },
    { edit: "add-feature", kind: "passages", feature: { id: "tw-x-cut", width: 1, length: 3, height: 3 } },
    { edit: "add-feature", kind: "blobs", feature: { id: "pebble", radius: 2 } },
  ]));
  assert.match(terrainFineBlock(dir), /6 m gate failed \(gate 11\): 2 terrain carve.*passages\/kings-tread-7 \(1\.4 m\).*blobs\/pebble \(4 m\).*kit\/hero piece or an operator/);
});

test("gate 11 exceptions: a coordinator-ruled carve listed for THIS job in <world>.fine-exceptions.json is excepted", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "poi-fine-"));
  const dir = path.join(root, "authoring", "zonegen", "w", "zones", "z", "pois", "t");
  fs.mkdirSync(dir, { recursive: true });
  fs.cpSync(job(), dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "world-ops.json"), JSON.stringify({ features: { passages: [{ id: "stair-1", width: 2.6, length: 1.4, height: 3 }, { id: "stair-2", width: 2.6, length: 1.4, height: 3 }] } }));
  const file = fineExceptionsFile(dir);
  assert.equal(file, path.join(root, "authoring", "terrain", "w.fine-exceptions.json"));
  assert.match(terrainFineBlock(dir), /2 terrain carve/);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const entry = (owner, carves) => ({ id: `${owner}:stairs`, job: owner, reason: "legacy stair tunnel", ruling: "test ruling", carves });
  fs.writeFileSync(file, JSON.stringify({ exceptions: [entry("t", ["passages/stair-1"])] }));
  assert.match(terrainFineBlock(dir), /1 terrain carve\(s\) finer than 6 m \(1 excepted\).*passages\/stair-2/);
  fs.writeFileSync(file, JSON.stringify({ exceptions: [entry("t", ["passages/stair-1", "passages/stair-2"])] }));
  assert.equal(terrainFineBlock(dir), null);
  assert.match(terrainFineBlock(dir, { exceptions: false }), /2 terrain carve/, "--no-exceptions ignores the file");
  fs.writeFileSync(file, JSON.stringify({ exceptions: [entry("someone-else", ["passages/stair-1", "passages/stair-2"])] }));
  assert.match(terrainFineBlock(dir), /2 terrain carve/, "an entry excepts only the carves of its own job");
  assert.equal(fineExceptionsFile(job()), null, "a job outside a project world has no exceptions file");
});

test("gate 13: the final review is a fresh reviewer's, answers every rubric line, and only Derek's hand-written approval overrides it", () => {
  const dir = job();
  const file = path.join(dir, "final-review.md");
  const write = (o) => fs.writeFileSync(file, reviewText(dir, o));
  assert.deepEqual(rubricCodes(), ["P1", "P2", "P3", "P4", "P5", "P6", "Q1", "Q2", "Q3", "Q4", "Q5", "S1", "S2", "S3", "S4", "S5", "S6", "S7", "S8", "S9"]);
  assert.deepEqual(designCodes(), ["P1", "P2", "P3", "P4", "P5", "P6"]);
  write({ reviewer: null });
  assert.throws(() => recordReview(dir, file), /names no reviewer/);
  write({ reviewer: "coordinator" });
  assert.throws(() => recordReview(dir, file), /coordinator/);
  write({ reviewer: "ZONE-COORDINATOR-2" });
  assert.throws(() => recordReview(dir, file), /coordinator/);
  write({ reviewer: "Owner review (Derek) via coordinator" });
  assert.throws(() => recordReview(dir, file), /not an agent id/);
  write({ reviewer: "POI-T" });
  assert.throws(() => recordReview(dir, file), /an owner of this job/);
  write({ reviewer: "poi-t0" });
  assert.throws(() => recordReview(dir, file), /an owner of this job/);
  write({ skip: ["S1", "Q4"] });
  assert.throws(() => recordReview(dir, file), /does not answer rubric line\(s\) Q4, S1/);
  write({ fault: ["S1"] });
  assert.throws(() => recordReview(dir, file), /PASS with fault answer\(s\) S1/);
  write({ verdict: "FAIL", fault: ["S1"] });
  assert.equal(recordReview(dir, file).verdict, "FAIL");
  write();
  const rec = recordReview(dir, file);
  assert.equal(rec.reviewer, "REV-T1");
  assert.equal(rec.answered, 20);
  assert.equal(finalReviewBlock(dir), null);
  // a hand edit of the review file after recording is caught at install
  fs.writeFileSync(file, reviewText(dir).replace("Reviewer: REV-T1", "Reviewer: coordinator"));
  assert.match(finalReviewBlock(dir), /coordinator/);
  // JSON review files carry the same fields
  fs.writeFileSync(file, JSON.stringify({ verdict: "PASS", opsHash: opsHash(dir), reviewer: "REV-T2", answers: Object.fromEntries(rubricCodes().map((c) => [c, { result: "pass", evidence: "seen in shot 3" }])) }));
  assert.equal(readReview(file).reviewer, "REV-T2");
  assert.equal(recordReview(dir, file).reviewer, "REV-T2");
  // Derek's override: only by: "derek" with a note (and, when it names one, the same ops hash); no tool writes it
  const p = progress(dir);
  p.finalReview = null;
  assert.equal(ownerApproval(p, opsHash(dir)), null);
  p.ownerApproval = { by: "coordinator", note: "fine" };
  assert.equal(ownerApproval(p, opsHash(dir)), null);
  p.ownerApproval = { by: "derek", note: "walked it, ship", opsHash: "0".repeat(64) };
  assert.equal(ownerApproval(p, opsHash(dir)), null);
  p.ownerApproval = { by: "derek", note: "walked it, ship" };
  fs.writeFileSync(path.join(dir, "progress.json"), JSON.stringify(p));
  assert.ok(ownerApproval(progress(dir), opsHash(dir)));
  assert.doesNotMatch(installBlock(dir), /review/);
  write();
  recordReview(dir, file);
  assert.deepEqual(progress(dir).ownerApproval, { by: "derek", note: "walked it, ship" }); // recordReview leaves it alone
});

test("gate 12: the measured place meets its size tier", () => {
  const dir = job();
  assert.equal(sizeBlock(dir), null);
  const m = measureSize(dir);
  assert.equal(m.tier, "pinpoint");
  assert.equal(m.measurement.footprintDiameterM, 20);
  // the same place briefed LARGE fails on every count
  fs.writeFileSync(path.join(dir, "brief.json"), JSON.stringify({ id: "t", adventureSize: "large" }));
  const big = measureSize(dir);
  assert.equal(big.ok, false);
  const why = big.faults.join(" | ");
  for (const re of [/footprint 20 m across, a large place needs >= 300 m/, /usable area 200 m2, a large place needs >= 30000/, /linked feature/, /none of water\/cave\/interior/, /0 creature group\(s\), a large place needs 3\+/, /1 approach\(es\), a large place needs 3\+/, /no terrain shaping/]) assert.match(why, re);
  assert.match(installBlock(dir) ?? "", /no final review/);
  // grow it: a 400 m district with water, a cave and camps, three ways in, its own shaping, measured
  const hf = path.join(dir, "handoff.json");
  const h = JSON.parse(fs.readFileSync(hf, "utf8"));
  h.measurements = { measuredCombinedUsableAreaM2: 45000, approaches: [{ from: "road-1" }, { from: "river-ford" }, { from: "shore" }],
    features: [{ id: "tower", kind: "landmark", linkedTo: ["lake"] }, { id: "lake", kind: "water", linkedTo: ["cave"] }, { id: "cave", kind: "cave", linkedTo: ["tower"] }, { id: "camp", kind: "camp", linkedTo: ["lake"] }] };
  h.populateClearings = [{ id: "a" }, { id: "b" }];
  fs.writeFileSync(hf, JSON.stringify(h));
  fs.writeFileSync(path.join(dir, "clearings.json"), JSON.stringify([{ id: "big-enc-west", center: [0, 0], radius: 20 }, { id: "big-enc-east", center: [380, 0], radius: 20 }, { id: "shore", polygon: [[0, -150], [380, -150], [380, 150], [0, 150]] }]));
  assert.match(measureSize(dir).faults.join(" | "), /no terrain shaping/);
  fs.writeFileSync(path.join(dir, "world-ops.json"), JSON.stringify([{ id: "big-lake", op: "operator", kind: "basin", at: [190, 0] }]));
  const ok = measureSize(dir);
  assert.deepEqual(ok.faults, []);
  assert.equal(ok.measurement.creatureGroups, 4);
  assert.ok(ok.measurement.footprintDiameterM >= 400);
  // an estimate is not a measurement; a usable claim larger than the footprint is refused
  h.measurements.measuredCombinedUsableAreaM2 = null;
  fs.writeFileSync(hf, JSON.stringify(h));
  assert.match(sizeBlock(dir), /no MEASURED usable area/);
  h.measurements.measuredCombinedUsableAreaM2 = 900000;
  fs.writeFileSync(hf, JSON.stringify(h));
  assert.match(sizeBlock(dir), /re-measure/);
  // a feature of an unknown kind is named
  h.measurements.measuredCombinedUsableAreaM2 = 45000;
  h.measurements.features.push({ id: "x", kind: "volcano" });
  fs.writeFileSync(hf, JSON.stringify(h));
  assert.match(sizeBlock(dir), /features\[4\]/);
});

test("gate 15 (art): a job delivering a landmark, paint or structures needs an ok art-check report newer than its ops", () => {
  const dir = job();
  assert.equal(deliversArt(dir), false);
  assert.equal(artBlock(dir), null); // clearings only: nothing to judge
  fs.writeFileSync(path.join(dir, "world-ops.json"), JSON.stringify([{ id: "door", op: "landmark", kind: "built", at: [0, 0] }]));
  assert.equal(deliversArt(dir), true);
  assert.match(artBlock(dir), /no art-check gate evidence \(gate 15\)/);
  fs.mkdirSync(path.join(dir, "reports"), { recursive: true });
  const rep = path.join(dir, "reports", "art-check.json");
  const later = new Date(Date.now() + 5000);
  fs.writeFileSync(rep, JSON.stringify({ ok: false, counts: { texel: 1, portal: 1 }, faults: [{ rule: "texel", piece: "door", what: "landmarks/cliff", detail: "113.8 texels/m vs 27.3" }] }));
  fs.utimesSync(rep, later, later);
  assert.match(artBlock(dir), /art gate failed \(gate 15\): 1 texel, 1 portal — texel door landmarks\/cliff/);
  fs.writeFileSync(rep, JSON.stringify({ ok: true, counts: {}, faults: [] }));
  fs.utimesSync(rep, later, later);
  assert.match(artBlock(dir), /predates the architectural material policy/);
  fs.writeFileSync(rep, JSON.stringify({ ok: true, materialPolicy: "architecture", counts: {}, faults: [] }));
  fs.utimesSync(rep, later, later);
  assert.equal(artBlock(dir), null);
  // Explicit legacy projects remain possible, but a pre-policy cached approval is not accepted silently.
  fs.writeFileSync(rep, JSON.stringify({ ok: true, materialPolicy: "counts", counts: {}, faults: [] }));
  fs.utimesSync(rep, later, later);
  assert.equal(artBlock(dir), null);
  const old = new Date(Date.now() - 60000);
  fs.utimesSync(rep, old, old);
  assert.match(artBlock(dir), /art-check report is older than/);
});

test("finalReviewBlock without progress.json returns a block reason instead of throwing", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "poi-noprog-"));
  fs.writeFileSync(path.join(dir, "ops.json"), "[]");
  assert.match(finalReviewBlock(dir), /no progress\.json/);
  fs.writeFileSync(path.join(dir, "progress.json"), "{ not json");
  assert.match(finalReviewBlock(dir), /not readable JSON/);
  fs.writeFileSync(path.join(dir, "progress.json"), JSON.stringify({ version: 1 }));
  assert.match(finalReviewBlock(dir), /records no final review/);
});

test("jobHandoff reads the one handoff.json and names stray v<N>/ iteration folders (never reads them)", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "poi-hand-"));
  assert.deepEqual(jobHandoff(dir), { file: null, iterationDirs: [] });
  fs.writeFileSync(path.join(dir, "handoff.json"), "{}");
  for (const v of ["v2", "v10", "visuals"]) fs.mkdirSync(path.join(dir, v));
  fs.writeFileSync(path.join(dir, "v2", "handoff.json"), "{}");
  const h = jobHandoff(dir);
  assert.equal(h.file, path.join(dir, "handoff.json"));
  assert.deepEqual(h.iterationDirs, ["v10", "v2"]);
});

test("a dungeon-door job with a parent is a pinpoint child, sized by its parent's tier over parent + children", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "poi-parent-"));
  const pois = path.join(root, "zonegen", "w", "zones", "z", "pois");
  const mk = (id, brief, hand, clearings) => {
    const d = path.join(pois, id); fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, "brief.json"), JSON.stringify({ id, ...brief }));
    fs.writeFileSync(path.join(d, "handoff.json"), JSON.stringify({ integration: { worldOps: "clearings.json" }, ...hand }));
    fs.writeFileSync(path.join(d, "clearings.json"), JSON.stringify(clearings));
    return d;
  };
  // a small place 100+ m across short on usable area and creature groups alone; its door brings the rest
  const place = mk("barrow", { adventureSize: "small" }, { measurements: { measuredCombinedUsableAreaM2: 2000, features: [{ id: "mound", kind: "landmark", linkedTo: ["yard"] }, { id: "yard", kind: "camp", linkedTo: [] }], approaches: [{ from: "road" }] } }, [{ id: "barrow-yard", center: [0, 0], radius: 55 }]);
  const door = mk("barrow-door", { adventureSize: "pinpoint", parent: "barrow" }, { measurements: { measuredCombinedUsableAreaM2: 1600, features: [{ id: "door", kind: "cave", linkedTo: [] }], approaches: [{ from: "yard" }] } }, [{ id: "door-pack", center: [60, 0], radius: 8 }]);
  assert.equal(jobParent(door), "barrow");
  const d = measureSize(door);
  assert.equal(d.parent, "barrow");
  assert.equal(d.aggregate.tier, "small");
  assert.deepEqual(d.aggregate.children, ["barrow-door"]);
  assert.deepEqual(d.faults, [], d.faults.join("; "));
  // the parent alone would be short; with its child it meets small
  const p = measureSize(place);
  assert.deepEqual(p.children, ["barrow-door"]);
  assert.equal(p.measurement.usableAreaM2, 3600);
  assert.deepEqual(p.faults, []);
  // a parented job tiered above pinpoint, or naming no real parent, fails
  fs.writeFileSync(path.join(door, "brief.json"), JSON.stringify({ id: "barrow-door", adventureSize: "small", parent: "barrow" }));
  assert.ok(measureSize(door).faults.some((f) => /pinpoint child/.test(f)));
  fs.writeFileSync(path.join(door, "brief.json"), JSON.stringify({ id: "barrow-door", adventureSize: "pinpoint", parent: "nowhere" }));
  assert.ok(measureSize(door).faults.some((f) => /not a POI job of this world/.test(f)));
});

test("a bridge job (bridge.json) is sized as a crossing from its own reports, whatever size the plan named", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "poi-bridge-"));
  const w = (f, v) => { fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true }); fs.writeFileSync(path.join(dir, f), JSON.stringify(v)); };
  w("progress.json", { version: 1, poiId: "span", ownerAgentId: "place-build", stage: "blockout" });
  w("brief.json", { id: "span", adventureSize: "medium" });
  w("bridge.json", { bridge: { id: "span" }, roads: [{ id: "n" }, { id: "s" }] });
  w("reports/bridge.json", { report: { span: 119.8, deckY: 121.6, piers: [{ groundMin: 15.1 }, { groundMin: 15.7 }], towerTop: 142.6 }, ends: { start: [0, 121.6, 0], end: [0, 121.6, -120] } });
  w("reports/seated.json", { ok: true, rows: [] });
  w("views.json", [{ name: "read-south", camera: [0, 100, 330] }, { name: "read-north", camera: [0, 100, -460] }, { name: "bank", camera: [80, 130, 10] }]);
  w("handoff.json", { measurements: { measuredCombinedUsableAreaM2: 839, features: [{ id: "bridge", kind: "landmark", linkedTo: [] }], approaches: ["n", "s"] } });
  let m = measureSize(dir);
  assert.equal(m.tier, "crossing");
  assert.deepEqual(m.measurement.crossing.reads.map((r) => [r.name, r.end, r.distanceM, r.picture]), [["read-south", "start", 330, false], ["read-north", "end", 340, false]]);
  assert.match(m.faults.join(" | "), /no read from the start approach.*no picture/);
  for (const n of ["read-south", "read-north"]) w(`evidence/lab/${n}-12.png`, "png");
  m = measureSize(dir);
  assert.deepEqual(m.faults, []);
  assert.equal(m.ok, true);
});

test("gate 16: no detail and no install before the design is written, one area is finished and a fresh reviewer passes the Place lines", () => {
  const dir = job({ designed: false });
  const p = progress(dir);
  fs.mkdirSync(path.join(dir, "evidence"), { recursive: true });
  fs.writeFileSync(path.join(dir, "evidence/read.png"), "png");
  p.evidence.readShot = { file: "evidence/read.png", viewpoint: "road-bend" };
  p.viewpoints = [{ id: "road-bend", at: [0, 2, 0], look: [10, 0, 0] }];
  fs.writeFileSync(path.join(dir, "progress.json"), JSON.stringify(p));
  assert.equal(stageBlock(dir, "greybox-review"), null, "the grey box and its review need no design yet");
  assert.match(stageBlock(dir, "detail"), /design gate failed \(gate 16\): no design\.json/);
  assert.match(installBlock(dir) ?? "", /no final review/, "the final review is asked for first");
  // a thin design: every missing part is named
  designJson(dir, { premise: "ruins", journey: ["x"], elements: [{ id: "alt" }], areas: [], sample: null, reference: [], concept: [] });
  const faults = designFaults(dir);
  for (const want of [/premise/, /journey/, /elements\[0\] alt: shows/, /madeOf/, /elements: 1 of at least 2/, /areas: 0 of at least 1/, /stands in no area/, /sample:/, /reference:/, /concept:/]) assert.ok(faults.some((f) => want.test(f)), `${want} in ${faults.join(" | ")}`);
  assert.match(stageBlock(dir, "detail"), /design gate failed/);
  // a good design, no review yet: the block names the hash the reviewer records
  designJson(dir);
  assert.deepEqual(designFaults(dir), []);
  assert.match(stageBlock(dir, "detail"), new RegExp(`no design review recorded [(]gate 16[)].*P1, P2, P3, P4, P5, P6.*${designHash(dir)}`));
  const file = path.join(dir, "design-review.md");
  const write = (o) => fs.writeFileSync(file, designReviewText(dir, o));
  write({ reviewer: "POI-T" });
  assert.throws(() => recordDesignReview(dir, file), /an owner of this job/);
  write({ reviewer: "coordinator" });
  assert.throws(() => recordDesignReview(dir, file), /coordinator/);
  write({ skip: ["P4"] });
  assert.throws(() => recordDesignReview(dir, file), /does not answer rubric line\(s\) P4 .*Place/);
  write({ na: ["P2"] });
  assert.throws(() => recordDesignReview(dir, file), /P2 n\/a: the Place lines are answered pass or fault/);
  write({ fault: ["P3"] });
  assert.throws(() => recordDesignReview(dir, file), /PASS with fault answer\(s\) P3/);
  write({ verdict: "FAIL", fault: ["P3"] });
  assert.equal(recordDesignReview(dir, file).verdict, "FAIL");
  assert.match(stageBlock(dir, "detail"), /verdict is FAIL/);
  write();
  const rec = recordDesignReview(dir, file);
  assert.equal(rec.reviewer, "REV-D1");
  assert.equal(stageBlock(dir, "detail"), null);
  assert.equal(setStage(dir, "detail").stage, "detail");
  assert.match(installBlock(dir), /no final review/);
  // editing the design, or its sample frame, re-opens the review
  fs.writeFileSync(path.join(dir, "evidence", "design", "yard-12.png"), "png2");
  assert.match(stageBlock(dir, "final-review"), /changed after the design review/);
  assert.throws(() => recordDesignReview(dir, file), /reviewed design/);
  // and the final review must answer the Place lines on the whole place
  fs.writeFileSync(path.join(dir, "design-review.md"), designReviewText(dir));
  recordDesignReview(dir, file);
  fs.writeFileSync(path.join(dir, "final-review.md"), reviewText(dir, { skip: ["P2"] }));
  assert.throws(() => recordReview(dir, path.join(dir, "final-review.md")), /does not answer rubric line\(s\) P2/);
  fs.writeFileSync(path.join(dir, "final-review.md"), reviewText(dir, { fault: ["P4"] }));
  assert.throws(() => recordReview(dir, path.join(dir, "final-review.md")), /PASS with fault answer\(s\) P4/);
});

test("gate 16: a story element's props must exist in the project closure's catalogues; reference frames resolve under the playground folder", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "poi-pg-"));
  const proj = (name, dependsOn, props) => {
    const pd = path.join(root, "projects", name);
    fs.mkdirSync(path.join(pd, "authoring", "kit"), { recursive: true });
    fs.writeFileSync(path.join(pd, "project.json"), JSON.stringify({ name, dependsOn }));
    fs.writeFileSync(path.join(pd, "authoring", "prop-catalogs.json"), JSON.stringify({ catalogs: [{ path: "authoring/kit/catalog.json", entries: "props", prefabIds: true }, { path: "authoring/kit/raw.json", entries: "assets" }] }));
    fs.writeFileSync(path.join(pd, "authoring", "kit", "catalog.json"), JSON.stringify({ props: props.map((id) => ({ id })) }));
    fs.writeFileSync(path.join(pd, "authoring", "kit", "raw.json"), JSON.stringify({ assets: [{ id: "raw/not-a-prefab" }] }));
    return pd;
  };
  const kd = proj("kit", [], ["poi-props/standing-torch", "poi-props/offering-stones"]);
  // a collection catalogued by its outputs (no prefabIds) names its prefabs in its dressing sidecar
  fs.writeFileSync(path.join(kd, "authoring", "prop-catalogs.json"), JSON.stringify({ catalogs: [{ path: "authoring/kit/catalog.json", entries: "props", prefabIds: true }, { path: "authoring/kit/raw.json", entries: "assets" }, { path: "authoring/rural/catalog.json", entries: "outputs", pathFields: ["path"], dressing: "authoring/rural/dressing.json" }] }));
  fs.mkdirSync(path.join(kd, "authoring", "rural"), { recursive: true });
  fs.writeFileSync(path.join(kd, "authoring", "rural", "dressing.json"), JSON.stringify({ version: 1, props: { "rural-props/hay-bale": { mount: "floor" } } }));
  const pd = proj("w", ["kit"], ["w-props/skull-pole"]);
  const dir = path.join(pd, "authoring", "zonegen", "w", "zones", "z", "pois", "t");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "progress.json"), JSON.stringify({ version: 1, poiId: "t", ownerAgentId: "POI-T", stage: "blockout" }));
  fs.writeFileSync(path.join(dir, "brief.json"), JSON.stringify({ id: "t", adventureSize: "pinpoint" }));
  try {
    assert.deepEqual([...catalogueIds(dir)].sort(), ["poi-props/offering-stones", "poi-props/standing-torch", "rural-props/hay-bale", "w-props/skull-pole"], "the closure's prefab catalogues and dressing sidecars, never raw asset rows");
    designJson(dir);
    assert.deepEqual(designFaults(dir), []);
    designJson(dir, { elements: [
      { id: "cairn", shows: "Carters have stacked stones here for years.", madeOf: ["w-props/skull-pole", "poi-props/ghost-net"] },
      { id: "lamp", shows: "Someone keeps the shrine lit at night.", madeOf: ["lantern"] },
    ] });
    const faults = designFaults(dir);
    assert.ok(faults.some((f) => /prop "poi-props\/ghost-net" is not in the project closure's catalogues/.test(f)), faults.join(" | "));
    assert.ok(faults.some((f) => /madeOf "lantern" is neither a catalogue prop id/.test(f)), faults.join(" | "));
    assert.ok(!faults.some((f) => /skull-pole/.test(f)));
    // a zone-wide reference frame named from the playground folder
    fs.mkdirSync(path.join(root, "projects", "w", "refs"), { recursive: true });
    fs.writeFileSync(path.join(root, "projects", "w", "refs", "bar.png"), "png");
    designJson(dir, { reference: ["projects/w/refs/bar.png"] });
    assert.deepEqual(designFaults(dir), []);
    designJson(dir, { reference: ["projects/w/refs/nope.png"] });
    assert.match(designFaults(dir).join(" | "), /reference projects\/w\/refs\/nope.png does not exist/);
    // owner ruling 2026-10-23: at most 40% of the props may be made for this place (prop-requests `for` + made), the rest reusable
    fs.mkdirSync(path.join(pd, "authoring", "dressing"), { recursive: true });
    fs.writeFileSync(path.join(pd, "authoring", "dressing", "prop-requests.json"), JSON.stringify([{ id: "r1", for: "t", status: "made", made: "w-props/skull-pole" }]));
    designJson(dir, { elements: [
      { id: "cairn", shows: "Carters have stacked stones here for years.", madeOf: ["w-props/skull-pole", "poi-props/offering-stones"] },
      { id: "lamp", shows: "Someone keeps the shrine lit at night.", madeOf: ["poi-props/standing-torch"] },
    ] });
    assert.deepEqual(designFaults(dir), [], "one custom prop of three is under the 40% cap");
    designJson(dir, { elements: [
      { id: "cairn", shows: "Carters have stacked stones here for years.", madeOf: ["w-props/skull-pole", "poi-props/ghost-net"] },
      { id: "lamp", shows: "Someone keeps the shrine lit at night.", madeOf: ["poi-props/standing-torch"] },
    ] });
    assert.match(designFaults(dir).join(" | "), /reuse: 2 of 3 props are custom for this place [(]w-props[/]skull-pole, poi-props[/]ghost-net[)]/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

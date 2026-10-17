import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { deliversMaterialModels, deliversStructures, flatArtBlock, installBlock, terrainFineBlock, isMonumentSite, monumentApproachBlock, ownerOverrideScenes, opsHash, recordFix, recordReview, requireFinalReview, seeThroughBlock, setStage, stageBlock } from "./job.mjs";

function job() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "poi-job-"));
  fs.writeFileSync(path.join(dir, "progress.json"), JSON.stringify({ version: 1, poiId: "t", stage: "blockout", evidence: {}, viewpoints: [], fixes: [], finalReview: null }));
  fs.writeFileSync(path.join(dir, "handoff.json"), JSON.stringify({ integration: { sceneOps: "ops.json", worldOps: "world-ops.json + clearings.json" } }));
  fs.writeFileSync(path.join(dir, "ops.json"), "[]");
  fs.writeFileSync(path.join(dir, "world-ops.json"), "[]");
  fs.writeFileSync(path.join(dir, "clearings.json"), "[]");
  return dir;
}
const progress = (dir) => JSON.parse(fs.readFileSync(path.join(dir, "progress.json"), "utf8"));

test("no install without a final PASS review of exactly the delivered ops", () => {
  const dir = job();
  assert.match(installBlock(dir), /no final review/);
  const h = opsHash(dir);
  fs.writeFileSync(path.join(dir, "final-review.md"), `# Final review\nVerdict: FAIL\nOps hash: ${h}\n`);
  recordReview(dir, path.join(dir, "final-review.md"));
  assert.match(installBlock(dir), /verdict is FAIL/);
  fs.writeFileSync(path.join(dir, "final-review.md"), `# Final review\nVerdict: PASS\nOps hash: ${h}\n`);
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
  fs.mkdirSync(path.join(dir, "evidence"));
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

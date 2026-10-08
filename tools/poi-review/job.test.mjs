import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { installBlock, opsHash, recordFix, recordReview, requireFinalReview, setStage, stageBlock } from "./job.mjs";

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

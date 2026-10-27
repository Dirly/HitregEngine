// prove fight under load: a fake clock drives the tick timer; a failed fight is "unjudged (load)" only when the
// median step is over 1.5x the fixed step, and the pipeline shows such a report as UNJUDGED.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { instrumentTicks, judgeUnderLoad } from "./step-jitter.mjs";
import { evaluate } from "./pipeline.mjs";

const run = (costs) => {
  let clock = 0, i = 0;
  const server = { ticks: 0, tick() { this.ticks++; clock += costs[i++ % costs.length]; } };
  const j = instrumentTicks(server, { fixedStepMs: 1000 / 60, now: () => clock });
  for (let k = 0; k < 100; k++) server.tick();
  assert.equal(server.ticks, 100);
  return j.summary();
};

test("quiet steps judge normally; a loaded median makes a failure unjudged", () => {
  const quiet = run([5, 8, 40]);         // median 8 ms < 16.7 (one slow outlier does not count)
  assert.equal(quiet.underLoad, false);
  assert.equal(judgeUnderLoad(false, quiet).result, "FAILED");
  const loaded = run([30, 26, 10]);       // median 26 ms > 25 ms (1.5 x 16.67)
  assert.equal(loaded.underLoad, true);
  const v = judgeUnderLoad(false, loaded);
  assert.equal(v.result, "unjudged (load)");
  assert.match(v.unjudged, /median step 26 ms/);
  assert.equal(judgeUnderLoad(true, loaded).result, "PASSED");
  const edge = run([25]);                 // exactly 1.5x is not over
  assert.equal(edge.underLoad, false);
});

test("the pipeline shows an unjudged report as UNJUDGED", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dp-unjudged-"));
  fs.writeFileSync(path.join(root, "fight.json"), JSON.stringify(judgeUnderLoad(false, run([40]))));
  const [row] = evaluate(root, [{ name: "fight", out: "fight.json", report: "fight.json", inputs: [] }]);
  assert.equal(row.status, "UNJUDGED");
  fs.rmSync(root, { recursive: true, force: true });
});

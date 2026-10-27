// A dungeon whose exit is at the end of a long route declares where portal-play starts its walk to the exit
// (plan.portalPlay.exitFrom, engine metres): the `portal play` stage command carries it as --exit-from.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { evaluate, portalPlayRun, standardStages, writePlanGeometry } from "./pipeline.mjs";

test("portal play carries the plan's portalPlay.exitFrom as --exit-from; none without one", () => {
  assert.match(portalPlayRun("tipped-kirk", { portalPlay: { exitFrom: [72, -6.4, 0] } }), /--dungeon tipped-kirk --exit-from 72,-6\.4,0 /);
  assert.doesNotMatch(portalPlayRun("d", {}), /--exit-from/);
  assert.doesNotMatch(portalPlayRun("d", { portalPlay: { exitFrom: [1, "x", 2] } }), /--exit-from/, "malformed: left out");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dp-exit-"));
  fs.mkdirSync(path.join(root, "authoring"));
  fs.writeFileSync(path.join(root, "authoring/plan.json"), JSON.stringify({ spaces: [], portalPlay: { exitFrom: [72, -6.4, 0] } }));
  const row = evaluate(root, standardStages({ id: "d" })).find((r) => r.name === "portal play");
  assert.match(row.run, /--exit-from 72,-6\.4,0/);
});

test("portalPlay is not plan geometry: adding it does not move the export's digest", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dp-exit-geo-"));
  fs.mkdirSync(path.join(root, "authoring"));
  const plan = path.join(root, "authoring/plan.json"), geo = path.join(root, "authoring/.plan-geometry.json");
  fs.writeFileSync(plan, JSON.stringify({ spaces: [{ id: "a" }] }));
  writePlanGeometry(root, { populationKeys: [], stamp: "authoring/x.json" });
  const before = JSON.parse(fs.readFileSync(geo, "utf8")).digest;
  fs.writeFileSync(plan, JSON.stringify({ spaces: [{ id: "a" }], portalPlay: { exitFrom: [1, 2, 3] } }));
  writePlanGeometry(root, { populationKeys: [], stamp: "authoring/x.json" });
  assert.equal(JSON.parse(fs.readFileSync(geo, "utf8")).digest, before);
});

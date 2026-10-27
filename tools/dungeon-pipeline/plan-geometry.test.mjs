// writePlanGeometry (review r1 fault 5): the plan's geometry digest file must be as old as the plan edit that changed
// the shape, not the board run that noticed it. Plan edited at T-60 s, the export consumed it at T-30 s, the board runs
// at T: the digest must not be newer than the stamp (export ok), and a later plan edit must still make it newer (STALE).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { writePlanGeometry, mtimeOf } from "./pipeline.mjs";

const opts = { populationKeys: ["packs"], stamp: "authoring/x.mesh-stamp.json" };
const at = (f, ms) => fs.utimesSync(f, new Date(ms), new Date(ms));

test("a shape change dates the digest file to the plan edit, not the board run", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dp-plangeo-"));
  const A = path.join(root, "authoring");
  fs.mkdirSync(A);
  const plan = path.join(A, "plan.json"), stamp = path.join(A, "x.mesh-stamp.json"), geo = path.join(A, ".plan-geometry.json");
  const T = Date.now();
  // an earlier export of an earlier shape: the digest file exists
  fs.writeFileSync(plan, JSON.stringify({ spaces: [1], packs: [1] }));
  fs.writeFileSync(stamp, "{}");
  writePlanGeometry(root, opts);
  at(geo, T - 300_000); at(stamp, T - 200_000);
  // the shape changes at T-60, the export runs at T-30, the board runs now (T)
  fs.writeFileSync(plan, JSON.stringify({ spaces: [1, 2], packs: [1] })); at(plan, T - 60_000);
  fs.writeFileSync(stamp, "{}"); at(stamp, T - 30_000);
  writePlanGeometry(root, opts);
  assert.ok(Math.abs(mtimeOf(geo) - (T - 60_000)) < 2000, "digest dated to the plan edit");
  assert.ok(mtimeOf(geo) < mtimeOf(stamp), "not newer than the stamp that consumed that plan");
  // a population-only edit leaves it alone
  fs.writeFileSync(plan, JSON.stringify({ spaces: [1, 2], packs: [1, 2] })); at(plan, T - 10_000);
  writePlanGeometry(root, opts);
  assert.ok(mtimeOf(geo) < mtimeOf(stamp));
  // a later shape edit after the export: newer than the stamp (export STALE)
  fs.writeFileSync(plan, JSON.stringify({ spaces: [1, 2, 3], packs: [1, 2] }));
  writePlanGeometry(root, opts);
  assert.ok(mtimeOf(geo) > mtimeOf(stamp), "a shape edit after the export is newer than the stamp");
  fs.rmSync(root, { recursive: true, force: true });
});

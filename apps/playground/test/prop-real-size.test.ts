import { test } from "node:test";
import assert from "node:assert/strict";
import { kindOf, kindSizes, realSizeExemptIds, realSizeIssue, standsAgainstWall, supersededIds } from "../tools/_prop-real-size.mts";
import { dressReportFile, readableReportFile } from "../tools/_dress-report.mts";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const scales = [{ id: "human", height: 1.8 }, { id: "small", height: 1.2 }, { id: "giant", height: 4.5 }];
const T = kindSizes();

test("kinds come from prefab names", () => {
  assert.equal(kindOf("poi-props/barrel-a", T), "barrel");
  assert.equal(kindOf("interior-props/barrel-shelf", T), null);
  assert.equal(kindOf("town/oak-door", T), "door");
  assert.equal(kindOf("camp/hide-tent-large", T), "tent");
  assert.equal(kindOf("decor/candle", T), null);
});

test("a prop inside its kind's range at its user's scale is fine; outside is a fault", () => {
  assert.equal(realSizeIssue("x/barrel", [0.6, 0.9, 0.6], "human", scales, T), null);
  assert.match(realSizeIssue("x/barrel", [1.6, 2.4, 1.6], "human", scales, T)!, /barrel 2.4 m tall.*never scale a prop up/);
  // a door 2 m tall is right for a human, far too small for a giant; 2.4 m is too tall for small folk
  assert.equal(realSizeIssue("x/door", [1, 2, 0.1], undefined, scales, T), null);
  assert.ok(realSizeIssue("x/door", [1.2, 2.4, 0.1], "small", scales, T));
  assert.ok(realSizeIssue("x/door", [1, 2, 0.1], "giant", scales, T));
  assert.equal(realSizeIssue("x/door", [2.2, 4.8, 0.2], "giant", scales, T), null);
  assert.match(realSizeIssue("x/chain-barrier", [3, 2.2, 0.1], "human", scales, T)!, /chain/);
});

test("a project overrides or drops a kind", () => {
  const P = kindSizes({ kinds: { barrel: { range: [0.3, 3] }, door: null, cage: { match: "cage", dim: "h", range: [0.3, 2.5] } } });
  assert.equal(realSizeIssue("x/barrel", [1.6, 2.4, 1.6], "human", scales, P), null);
  assert.equal(kindOf("x/door", P), null);
  assert.ok(realSizeIssue("x/cage", [1, 3, 1], "human", scales, P));
});

test("the thing a chain hangs from is not a chain", () => {
  assert.equal(kindOf("spoilgate/chain-post", T), null);
  assert.equal(kindOf("x/chain-mail-coat", T), null);
  assert.equal(kindOf("x/hanging-chain", T), "chain");
});

test("catalogue rows with realSizeExempt are exempt (dress check honours them), resolved across the closure", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "realsize-"));
  const own = path.join(tmp, "own"), kit = path.join(tmp, "kit");
  fs.mkdirSync(path.join(own, "authoring"), { recursive: true });
  fs.mkdirSync(path.join(kit, "authoring/house"), { recursive: true });
  fs.writeFileSync(path.join(own, "authoring/prop-catalogs.json"), JSON.stringify({ catalogs: [{ path: "authoring/house/catalog.json", entries: "props", prefabIds: true }] }));
  fs.writeFileSync(path.join(kit, "authoring/house/catalog.json"), JSON.stringify({ props: [
    { id: "house/bed-single", realSizeExempt: "drawn at 1.5x for the 2.5x town buildings" },
    { id: "house/bed-tiny", realSizeExempt: "short" },
    { id: "house/stool" },
  ] }));
  try {
    const ids = realSizeExemptIds([own, kit]);
    assert.deepEqual([...ids], ["house/bed-single"]);
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

test("a superseded prop maps to its last successor (dress sets and props menu place the reskin)", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "supersede-"));
  const own = path.join(tmp, "own");
  fs.mkdirSync(path.join(own, "authoring/kit"), { recursive: true });
  fs.writeFileSync(path.join(own, "authoring/prop-catalogs.json"), JSON.stringify({ catalogs: [{ path: "authoring/kit/catalog.json", entries: "props", prefabIds: true }] }));
  fs.writeFileSync(path.join(own, "authoring/kit/catalog.json"), JSON.stringify({ props: [
    { id: "old/chair", supersededBy: "mid/chair" },
    { id: "mid/chair", supersededBy: "house/chair" },
    { id: "house/chair" },
    { id: "old/table", supersededBy: "house/table" },
  ] }));
  try {
    const next = supersededIds([own]);
    assert.equal(next.get("old/chair"), "house/chair");
    assert.equal(next.get("mid/chair"), "house/chair");
    assert.equal(next.get("old/table"), "house/table");
    assert.equal(next.has("house/chair"), false);
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

test("dress check reports live in the project's reports dir, never beside the plan", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "dress-report-"));
  const proj = path.join(tmp, "town"), plans = path.join(proj, "authoring/dressing/plans"), job = path.join(proj, "authoring/jobs/x/dressing");
  fs.mkdirSync(plans, { recursive: true });
  fs.mkdirSync(job, { recursive: true });
  fs.writeFileSync(path.join(proj, "project.json"), "{}");
  try {
    assert.equal(dressReportFile(path.join(plans, "a--b.json")), path.join(proj, "authoring/dressing/reports/a--b.report.json"));
    assert.equal(dressReportFile(path.join(job, "c-d.json")), path.join(proj, "authoring/dressing/reports/c-d.report.json"));
    // a legacy report beside the plan is still read until the next check moves it
    assert.equal(readableReportFile(path.join(plans, "a--b.json")), undefined);
    fs.writeFileSync(path.join(plans, "a--b.report.json"), "{}");
    assert.equal(readableReportFile(path.join(plans, "a--b.json")), path.join(plans, "a--b.report.json"));
    // a plan outside any project (a trial) keeps it beside itself
    const loose = path.join(tmp, "trial.json");
    assert.equal(dressReportFile(loose), path.join(tmp, "trial.report.json"));
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

test("a bed stands against a wall; a bedroll or a flowerbed does not", () => {
  for (const n of ["bed", "oak-bed", "bed-double", "wardrobe-tall", "shelf-low", "bookshelf"]) assert.equal(standsAgainstWall(n), true, n);
  for (const n of ["bedroll", "flowerbed", "bedside-table", "seabed-rock"]) assert.equal(standsAgainstWall(n), false, n);
});

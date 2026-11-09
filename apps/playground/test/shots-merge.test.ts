import { test } from "node:test";
import assert from "node:assert/strict";
import { mergeCommand, mergeShotRuns, missingViews } from "../tools/_shots-merge.mts";

// r-found 2026-10-31 (coordinator ruling): on a busy machine Red Dial's far / aerial views timed out in every shots run, a
// different set each time; `shots --views <ids> --merge` re-shoots only the missing ones and folds them into the run.
const rec = (spot: string, time: number, file = `pbx/${spot}-${time}.png`) => ({ spot, time, file });
const base = { scene: "pbx", shots: [rec("core-close", 12), rec("core-close", 20), rec("avenue", 12), rec("avenue", 20)], washVerdict: { ok: false, faults: ["old"] } };

test("mergeShotRuns: re-shot views replace their records, the rest stay, the stale verdict is dropped", () => {
  const add = { scene: "pbx", shots: [rec("aerial", 12), rec("aerial", 20), rec("blocks", 12), rec("stray", 12)] };
  const m = mergeShotRuns(base, add, ["aerial", "blocks", "read-2"], "2026-10-31T00:00:00Z");
  assert.deepEqual(m.shots!.map((s) => `${s.spot}@${s.time}`), ["core-close@12", "core-close@20", "avenue@12", "avenue@20", "aerial@12", "aerial@20", "blocks@12"]);
  assert.equal((m as { washVerdict?: unknown }).washVerdict, undefined, "the caller judges the merged frames again");
  assert.deepEqual(m.merged, [{ at: "2026-10-31T00:00:00Z", views: ["aerial", "blocks", "read-2"], got: ["aerial", "blocks"] }]);
  assert.deepEqual(missingViews(["core-close", "avenue", "aerial", "blocks", "read-2"], m), ["read-2"], "a view skipped again stays missing");
  // a second merge replaces a view already in the run (frames re-taken) and keeps the merge log
  const again = mergeShotRuns(m, { shots: [rec("avenue", 12, "pbx/avenue-12.png")] }, ["avenue"], "2026-10-31T01:00:00Z");
  assert.deepEqual(again.shots!.filter((s) => s.spot === "avenue").map((s) => s.time), [12]);
  assert.equal(again.merged.length, 2);
});

test("mergeCommand: the wash gate prints the exact re-shoot", () => {
  assert.equal(mergeCommand({ world: "redstrand", project: "redstrand", zone: "zone-1", poi: "red-dial", lab: null, port: "5385" }, ["read-2-421m", "aerial"]),
    "node --max-old-space-size=6144 node_modules/tsx/dist/cli.mjs tools/place-build.mts shots redstrand --project redstrand --zone zone-1 --location red-dial --views read-2-421m,aerial --merge --port 5385");
});

test("wash rulings: a dated row excuses its frame (match spot) or the far-fire read (match rule), and is reported", async () => {
  const { excuseWashFaults } = await import("../tools/_light-wash.mts");
  const faults = ["beacon-embers@20: 1.47 % blown white > 0.40 %", "beacon-embers@20: halos + fog glow brighten 71.5 %", "far fires at dusk/night: 45/68 read by flame (< 75 %)", "avenue@20: 0.9 % blown white"];
  const rows = [
    { id: "beacon-embers-close-up", gates: ["wash"], ruling: "2026-10-30, coordinator", match: { spot: "beacon-embers" } },
    { id: "far-fires-behind-woodland", gates: ["wash"], ruling: "2026-10-30, coordinator", match: { rule: "far-fires" } },
    { id: "undated", gates: ["wash"], ruling: "coordinator said so", match: { spot: "avenue" } },
    { id: "other-gate", gates: ["place"], ruling: "2026-10-30 x", match: { spot: "avenue" } },
  ];
  const r = excuseWashFaults(faults, rows);
  assert.deepEqual(r.faults, ["avenue@20: 0.9 % blown white"], "undated and other-gate rows excuse nothing");
  assert.deepEqual(r.excused.map((e) => e.by), ["beacon-embers-close-up", "beacon-embers-close-up", "far-fires-behind-woodland"]);
  assert.equal(excuseWashFaults(["beacon-embers-2@12: x"], rows).faults.length, 1, "a spot match is the whole view name");
});

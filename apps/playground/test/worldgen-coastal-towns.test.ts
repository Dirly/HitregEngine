import { test } from "node:test";
import assert from "node:assert/strict";
import { COASTAL_TOWN, coastalFaults, gateIsLandward, landGate, terraceReach, TERRACE_DEFAULTS, type CoastalSite } from "../tools/worldgen-coastal-towns.mts";

const site = (over: Partial<CoastalSite> = {}): CoastalSite => ({
  x: 0,
  z: 0,
  altitude: 6,
  shore: 60,
  shorePoint: [0, -60],
  segment: { id: "cs-0-1", type: "cove", exposure: "sheltered" } as CoastalSite["segment"],
  landward: [0, 1],
  relief: 10,
  meanSlope: 0.1,
  steepest: 0.4,
  wet: 0,
  ...over,
});

test("terrace reach comes from the terrace defaults", () => {
  const r = terraceReach();
  assert.equal(r.maxRelief, TERRACE_DEFAULTS.maxTerraces * TERRACE_DEFAULTS.stepHeight);
  assert.ok(Math.abs(r.maxSlope - 6 / 23) < 1e-9);
  assert.ok(Math.abs(r.maxFace - 1.2) < 1e-9);
});

test("a shore site passes; the hilltop over the cove does not", () => {
  assert.deepEqual(coastalFaults(site()), []);
  // Saltharrow as first sited: 102 m up, 357 m back
  const hill = coastalFaults(site({ altitude: 102, shore: 357 }));
  assert.equal(hill.length, 2);
  assert.ok(hill[0]!.includes(`max ${COASTAL_TOWN.maxAltitude}`));
});

test("wrong landing, exposure and slope are faults; the built check skips slope", () => {
  const s = site({ segment: { id: "cs-0-2", type: "sheer-cliff", exposure: "exposed" } as CoastalSite["segment"], meanSlope: 0.5, steepest: 2 });
  assert.equal(coastalFaults(s).length, 4);
  assert.equal(coastalFaults(s, terraceReach(), { ground: false }).length, 2);
});

test("the land gate faces away from the water and counts as landward", () => {
  const g = landGate(site(), 45);
  assert.deepEqual(g.at, [0, 45]);
  assert.ok(gateIsLandward({ center: [0, 0] }, g, [0, 1]));
  assert.ok(!gateIsLandward({ center: [0, 0] }, { at: [0, -45], facing: [0, -1] }, [0, 1]));
});

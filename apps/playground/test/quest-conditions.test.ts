import { test } from "node:test";
import assert from "node:assert/strict";
import { conditionLeaves, requiredLevel } from "../tools/_quest-conditions.mts";

test("requiredLevel: a bare level leaf (the-dun-boys: when {level:5})", () => {
  assert.equal(requiredLevel({ level: 5 }), 5);
});
test("requiredLevel: the highest level inside nested all wrappers", () => {
  assert.equal(requiredLevel({ all: [{ clock: { from: 20, to: 4 } }, { all: [{ level: 3 }, { level: 7 }] }] }), 7);
});
test("requiredLevel: no level asked, or no condition", () => {
  assert.equal(requiredLevel({ clock: { from: 6, to: 18 } }), 0);
  assert.equal(requiredLevel(undefined), 0);
});
test("conditionLeaves: opens all, keeps other leaves whole", () => {
  assert.deepEqual(conditionLeaves({ all: [{ level: 2 }, { flag: "x" }] }), [{ level: 2 }, { flag: "x" }]);
});

import { weatherHolds, weatherModeFor } from "../tools/_quest-conditions.mts";
test("weatherModeFor: storm >= 0.3 needs a storm front (a light front is storm 0.1) — the-wall-in-a-gale", () => {
  assert.equal(weatherModeFor({ storm: 0.3 }, true), "storm");
  assert.equal(weatherModeFor({ storm: 0.3 }, false), "clear");
});
test("weatherModeFor: rain bands pick the mildest front that holds", () => {
  assert.equal(weatherModeFor({ min: 0.3 }, true), "light");
  assert.equal(weatherModeFor({ min: 0.05, max: 0.2 }, true), "drizzle");
  assert.equal(weatherModeFor({ max: 0.05 }, true), "clear");
  assert.equal(weatherModeFor({ min: 0.3 }, false), "clear");
});
test("weatherHolds: storm and precipitation bounds", () => {
  assert.equal(weatherHolds({ storm: 0.3 }, { precipitation: 0.5, storm: 0.1 }), false);
  assert.equal(weatherHolds({ storm: 0.3 }, { precipitation: 0.9, storm: 0.85 }), true);
  assert.equal(weatherHolds({ min: 0.2 }, null), false);
});

import { drivableParts } from "../tools/_quest-conditions.mts";
test("drivableParts: a dry-night gate (all: [clock, weather]) drives both leaves — the-honest-light", () => {
  const can = (k: string): boolean => ["clock", "weather", "tide"].includes(k);
  assert.deepEqual(drivableParts({ all: [{ clock: { from: 20, to: 4 } }, { weather: { max: 0.3 } }] }, can), ["clock", "weather"]);
  assert.deepEqual(drivableParts({ clock: { from: 6, to: 18 } }, can), ["clock"]);
  assert.deepEqual(drivableParts({ all: [{ flag: "x" }, { level: 3 }] }, can), []);
  assert.deepEqual(drivableParts(undefined, can), []);
});

import { ownCorpses } from "../tools/_quest-conditions.mts";
test("ownCorpses: only the body's own corpses, not loot bags or another's corpse — the-hoist-house coins -301", () => {
  const bags: Array<[string, unknown]> = [
    ["lootbag/a", { owner: "p1", corpse: "p1", at: [0, 0, 0], items: [], coins: 301 }],
    ["lootbag/b", { owner: "p1", at: [0, 0, 0], items: [] }],
    ["lootbag/c", { owner: "p2", corpse: "p1", claimUntil: 10, at: [0, 0, 0], items: [] }],
    ["lootbag/d", { owner: "p2", corpse: "p2", at: [0, 0, 0], items: [] }],
  ];
  assert.deepEqual(ownCorpses(bags, "p1"), ["lootbag/a"]);
  assert.deepEqual(ownCorpses([], "p1"), []);
});

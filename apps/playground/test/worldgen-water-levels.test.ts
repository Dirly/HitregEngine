import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { WorldRecipe } from "@hitreg/core";
import { acceptWater, diffWaterLevels, recordWaterRun, waterLevels, waterLevelsCheck } from "../tools/worldgen-water-levels.mts";

// 2026-10-29 redstrand w9 (coordinator): a `worldgen rivers` re-solve rewrote every lake and river with no record of
// what moved, so a town's lake shore could shift under a painted concept unseen. Each run diffs against the last.
const world = (lakeY: number, poly: number[][] = [[0, 0], [10, 0], [10, 10]], fallX = 500): WorldRecipe =>
  ({
    features: {
      lakes: [{ id: "lake-1", waterY: lakeY, center: [0, 0], radius: 50, polygon: poly }],
      rivers: [{ id: "river-1", points: [[0, 0], [100, 0]], bedY: [10, 2] }],
      pois: [{ id: "falls-1", kind: "falls", position: [fallX, 20, 0] }],
    },
  }) as unknown as WorldRecipe;

test("water levels: a lake's level past the tolerance, its shoreline and a fall's move are listed with the places near", () => {
  const places = [{ id: "town-1", center: [40, 0] as [number, number], radius: 60 }];
  assert.deepEqual(diffWaterLevels(waterLevels(world(55.8)), waterLevels(world(55.9)), places), []);
  const moved = diffWaterLevels(waterLevels(world(55.8)), waterLevels(world(46, [[0, 0], [9, 0], [10, 10]], 520)), places);
  assert.deepEqual(moved.map((m) => `${m.kind} ${m.id} ${m.what} ${m.near.join(",")}`), ["lake lake-1 level 55.8 -> 46, shoreline moved town-1", "fall falls-1 moved 20 m "]);
});

test("water baseline: first run writes, a quiet re-run passes, a move near a place fails the row until accepted", () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "water-levels-")), "w-water-levels.json");
  const places = [{ id: "town-1", center: [40, 0] as [number, number], radius: 60 }];
  assert.equal(waterLevelsCheck(world(55.8), file)?.startsWith("no water baseline"), true);
  assert.equal(recordWaterRun(file, world(55.8), places).first, true);
  assert.equal(waterLevelsCheck(world(55.8), file), null);
  // another tool moved the water outside the rivers stage
  assert.match(waterLevelsCheck(world(50), file)!, /changed since the last rivers run/);
  // a re-solve that moved the town's lake: listed, the row fails; a later quiet run keeps it listed
  assert.equal(recordWaterRun(file, world(50), places).moves.length, 1);
  assert.match(waterLevelsCheck(world(50), file)!, /NEAR town-1/);
  recordWaterRun(file, world(50), places);
  assert.match(waterLevelsCheck(world(50), file)!, /NEAR town-1/);
  acceptWater(file, "2026-10-29 coordinator: re-shot town-1");
  assert.equal(waterLevelsCheck(world(50), file), null);
});

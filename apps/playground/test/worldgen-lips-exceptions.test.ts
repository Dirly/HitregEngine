import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { createWorldField, defaultWorldRecipe, worldRecipeSchema } from "@hitreg/core";
import { lipsExceptionsFile, runLipsGate } from "../tools/worldgen-lips.mts";

// a documented lips exception: the listed cells of one owner are reported as excepted, never counted
const base = worldRecipeSchema.parse({ ...defaultWorldRecipe(), cellSize: 48, resolution: 24 });
const g = createWorldField(base).height(0, 0);
// a 12 m raster with a 15 m block standing in its middle: a wall the 2 m lattice draws as a step
const cols = 13, heights: number[] = [];
for (let j = 0; j < cols; j++) for (let i = 0; i < cols; i++) heights.push(i >= 5 && i <= 7 && j >= 5 && j <= 7 ? g + 15 : g);
const recipe = { ...base, features: { ...base.features, heightPatches: [{ id: "blockp", origin: [-6, -6], size: [12, 12], columns: cols, rows: cols, heights, filter: 0, blend: 2 }] } } as unknown as typeof base;

test("lips counts a patch's faults; listed cells are excepted, others still count", () => {
  const bare = runLipsGate(recipe, { near: [0, 0, 30] });
  const n = bare.totals.alias + bare.totals.step + bare.totals.lip;
  assert.ok(n > 0, "the block draws faults");
  assert.equal(bare.excepted, 0);
  const cells = bare.faults.map((f) => [f.x, f.z] as [number, number]);
  const all = runLipsGate(recipe, { near: [0, 0, 30], exceptions: [{ id: "blockp", reason: "test", cells }] });
  assert.equal(all.ok, true);
  assert.equal(all.excepted, n);
  const some = runLipsGate(recipe, { near: [0, 0, 30], exceptions: [{ id: "blockp", reason: "test", cells: cells.filter(([x, z]) => x !== cells[0]![0] || z !== cells[0]![1]) }] });
  assert.equal(some.ok, false);
  assert.ok(some.excepted >= 1 && some.excepted < n);
  assert.equal(some.totals.alias + some.totals.step + some.totals.lip, n - some.excepted);
  const other = runLipsGate(recipe, { near: [0, 0, 30], exceptions: [{ id: "someone-else", reason: "test", cells }] });
  assert.equal(other.excepted, 0, "cells belong to their owner");
});

test("lipsExceptionsFile sits beside the fine-legacy list", () => {
  assert.equal(lipsExceptionsFile(path.join("projects", "w", "assets", "worlds", "w.json")), path.resolve("projects", "w", "authoring", "terrain", "w.lips-exceptions.json"));
});

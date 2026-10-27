import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { defaultWorldRecipe, worldRecipeSchema } from "@hitreg/core";
import { fineExceptionsFile, readFineExceptions, stampGateStage } from "../tools/worldgen-operators.mts";

test("a whole-world gate stamps its stage without writing back the world it loaded", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gate-stamp-"));
  const file = path.join(dir, "w.json");
  const loaded = worldRecipeSchema.parse(defaultWorldRecipe({ name: "w" }));
  fs.writeFileSync(file, JSON.stringify(loaded));
  // another job edits the world while the sweep runs
  const edited = JSON.parse(fs.readFileSync(file, "utf8"));
  edited.seaLevel = 7.5;
  edited.pipeline = { ...(edited.pipeline ?? {}), op: "2026-10-21T12:00:00.000Z" };
  fs.writeFileSync(file, JSON.stringify(worldRecipeSchema.parse(edited)));
  stampGateStage(file, "float", "2026-10-21T11:00:00.000Z");
  const after = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal(after.seaLevel, 7.5, "the other job's edit survives");
  assert.equal(after.pipeline.float, "2026-10-21T11:00:00.000Z", "stamped at load time");
  assert.equal(after.pipeline.op, "2026-10-21T12:00:00.000Z");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("the world 6 m gate reads the coordinator's fine-exceptions file beside the legacy list", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fine-exc-"));
  const recipeFile = path.join(dir, "projects", "p", "assets", "worlds", "w.json");
  const exc = fineExceptionsFile(recipeFile);
  assert.equal(exc, path.join(dir, "projects", "p", "authoring", "terrain", "w.fine-exceptions.json"));
  assert.deepEqual(readFineExceptions(recipeFile), []);
  fs.mkdirSync(path.dirname(exc), { recursive: true });
  fs.writeFileSync(exc, JSON.stringify({ exceptions: [{ id: "a", job: "j", reason: "r", ruling: "x", carves: ["passages/s-1", "passages/s-2"] }, { id: "b", carves: ["blobs/b"] }] }));
  assert.deepEqual(readFineExceptions(recipeFile), ["passages/s-1", "passages/s-2", "blobs/b"]);
  fs.rmSync(dir, { recursive: true, force: true });
});

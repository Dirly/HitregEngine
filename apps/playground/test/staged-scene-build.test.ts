import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { stagedSceneBuild, stagingSceneOf } from "../tools/_scene-write.mts";

// A dungeon build-scene writes the live scene only when every step succeeded (staging copy, swap at the end).
test("staged scene build: success swaps the staged scene in; a failed step leaves the live scene untouched", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "staged-scene-"));
  const live = path.join(dir, "kirk.scene.json");
  fs.writeFileSync(live, JSON.stringify({ name: "kirk", entities: { a: {} } }));
  const st = stagingSceneOf(live);
  assert.equal(st.id, "staging/kirk");

  // step 2 of 3 fails: live as it was, staging gone
  assert.throws(() => stagedSceneBuild(live, (s) => {
    fs.writeFileSync(s.file, JSON.stringify({ name: "kirk", entities: { b: {} } }));
    throw new Error("portal-veil failed");
  }));
  assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(live, "utf8")).entities), ["a"]);
  assert.equal(fs.existsSync(st.file), false);
  assert.equal(stagedSceneBuild(live, () => false), false);
  assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(live, "utf8")).entities), ["a"]);

  // every step succeeds: the staged doc (seeded from live, then edited) becomes live
  assert.equal(stagedSceneBuild(live, (s) => {
    const d = JSON.parse(fs.readFileSync(s.file, "utf8"));
    d.entities.b = {};
    fs.writeFileSync(s.file, JSON.stringify(d));
  }), true);
  assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(live, "utf8")).entities), ["a", "b"]);
  assert.equal(fs.existsSync(path.dirname(st.file)), false);
  fs.rmSync(dir, { recursive: true, force: true });
});

// recipe gate (quality.mjs gateRecipe): a light whose source is the place itself (daylight down an oculus, light off
// water) is tagged with one of thresholds recipe.environmentLightTags and needs no fixture prop; any other point/spot
// light without a fixture within sourceRadiusM is sourceless. The tag is capped per dungeon (environmentLightsMax).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runGate, setDry } from "./quality.mjs";

const T = JSON.parse(fs.readFileSync(new URL("./thresholds.json", import.meta.url), "utf8")).recipe;

function dungeon(id, lights) {
  const root = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "envlights-")), "projects", id);
  for (const d of ["authoring", "assets/scenes"]) fs.mkdirSync(path.join(root, d), { recursive: true });
  fs.writeFileSync(path.join(root, "authoring/plan.json"), JSON.stringify({ spaces: [] }));
  fs.writeFileSync(path.join(root, "authoring/pipeline.mjs"), "");
  const entities = {};
  lights.forEach((tags, k) => { entities[`l${k}`] = { tags, components: { transform: { position: [k * 10, 2, 0] }, light: { kind: "point", intensity: 5, range: 6 } } }; });
  fs.writeFileSync(path.join(root, `assets/scenes/${id}.scene.json`), JSON.stringify({ entities }));
  return root;
}
const checks = (r) => r.failures.map((f) => f.check);

test("tagged environment lights need no fixture; an untagged one is still sourceless", async () => {
  setDry(true);
  const r = await runGate("recipe", dungeon("envlights-a", [["lights:x", "sky-source"], ["water-source"], ["lights:x"]]));
  assert.equal(r.metrics.environmentLights, 2);
  assert.equal(r.metrics.sourcelessLights, 1);
  assert.ok(checks(r).includes("sourceless"));
  assert.ok(!checks(r).includes("environmentLights"));
});

test("the environment tag is capped per dungeon", async () => {
  setDry(true);
  const n = T.environmentLightsMax + 1;
  const r = await runGate("recipe", dungeon("envlights-b", Array.from({ length: n }, () => ["sky-source"])));
  assert.equal(r.metrics.environmentLights, n);
  assert.equal(r.metrics.sourcelessLights, 0);
  assert.ok(checks(r).includes("environmentLights"));
});

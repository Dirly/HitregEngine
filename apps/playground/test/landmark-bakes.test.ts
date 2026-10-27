import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { defaultWorldRecipe, worldRecipeSchema } from "@hitreg/core";
import { unbakedLandmarks } from "../tools/_landmark-bakes.mts";

test("landmark bakes: an applied landmark is UNBAKED until its prefab exists (the chunk silently skips it)", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "landmark-bake-"));
  try {
    const assets = path.join(dir, "projects", "lab", "assets");
    fs.mkdirSync(path.join(assets, "worlds"), { recursive: true });
    const base = defaultWorldRecipe({ cellSize: 48 });
    const recipe = worldRecipeSchema.parse({ ...base, features: { ...base.features, landmarks: [{ id: "op:town-wall:landmark", prefab: "landmarks/town-wall-abc12345", position: [0, 0, 0], radius: 40, digest: "abc12345" }] } });
    const file = path.join(assets, "worlds", "lab.json");
    assert.deepEqual(unbakedLandmarks(recipe, file), [{ id: "op:town-wall:landmark", prefab: "landmarks/town-wall-abc12345" }]);
    // baked into a sibling project (tools/landmark.mts --into) counts too
    const other = path.join(dir, "projects", "kit", "assets", "prefabs", "landmarks");
    fs.mkdirSync(other, { recursive: true });
    fs.writeFileSync(path.join(other, "town-wall-abc12345.json"), "{}");
    assert.deepEqual(unbakedLandmarks(recipe, file), []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

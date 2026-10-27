import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { cacheBytes, contentKey } from "../src/voxel-disk-cache.js";
import { voxelCodeKey } from "../tools/_voxel-code-key.mts";
import { assetChangePublisher, assetSourceProject, scopedAssetChange } from "../tools/_asset-watch.mts";

test("terrain cache keys change with recipe, mesher options, code and available props", async () => {
  const input = { code: "code", recipe: { seed: 1 }, options: { mesher: "mc" }, present: ["tree"] };
  const key = await contentKey(input);
  assert.equal(await contentKey(structuredClone(input)), key);
  for (const change of [{ code: "changed" }, { recipe: { seed: 2 } }, { options: { mesher: "dc" } }, { present: [] }]) {
    assert.notEqual(await contentKey({ ...input, ...change }), key);
  }
  // Account for binary arrays by their byte size, without expanding their
  // millions of elements into a JSON string or temporary number array.
  assert.equal(cacheBytes(new Float32Array(1000)), 4000);
});

test("the generation fingerprint notices source edits without restarting the dev server", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hitreg-cache-key-"));
  try {
    for (const file of ["packages/core/src/voxel/mesh.ts", "apps/playground/src/voxel-worker.ts", "apps/playground/src/voxel-world.ts", "apps/playground/src/voxel-disk-cache.ts"]) {
      const target = path.join(root, file); fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, "initial");
    }
    const before = voxelCodeKey(root);
    fs.writeFileSync(path.join(root, "packages/core/src/voxel/mesh.ts"), "edited");
    assert.notEqual(voxelCodeKey(root), before);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("duplicate watcher events and unchanged rewrites produce one update, while later content still arrives", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hitreg-asset-watch-"));
  const seen: string[] = [];
  const publisher = assetChangePublisher((_root, _file, content) => seen.push(content));
  const untilPublished = async (count: number): Promise<void> => {
    const deadline = Date.now() + 5000;
    while (seen.length < count && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(seen.length, count);
  };
  try {
    fs.writeFileSync(path.join(root, "asset.json"), '{"value":1}');
    for (let i = 0; i < 20; i++) publisher.enqueue(root, "asset.json");
    await untilPublished(1);
    publisher.enqueue(root, "asset.json");
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.deepEqual(seen, ['{"value":1}']);
    fs.writeFileSync(path.join(root, "asset.json"), '{"value":2}');
    publisher.enqueue(root, "asset.json");
    await untilPublished(2);
    assert.deepEqual(seen, ['{"value":1}', '{"value":2}']);
  } finally { publisher.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

test("watcher provenance identifies project assets and preserves the flat asset tree", () => {
  const root = path.resolve(os.tmpdir(), "hitreg-watch-roots");
  assert.equal(assetSourceProject(path.join(root, "projects"), path.join(root, "projects/world/assets")), "world");
  assert.equal(assetSourceProject(path.join(root, "projects"), path.join(root, "assets")), null);
});

test("unrelated world saves never send their large JSON to a scoped tab; scene discovery is metadata only", () => {
  const scope = new Set(["world", "foundation"]);
  const change = { project: "other-world", file: "worlds/recipe.json", content: '{"large":"recipe"}' };
  assert.equal(scopedAssetChange(change, scope), null);
  assert.deepEqual(scopedAssetChange({ ...change, file: "scenes/new.scene.json" }, scope), {
    ...change, file: "scenes/new.scene.json", content: null,
  });
  assert.equal(scopedAssetChange({ ...change, project: "foundation" }, scope)?.content, change.content);
  assert.equal(scopedAssetChange({ ...change, project: null }, scope)?.content, change.content);
  assert.equal(scopedAssetChange(change, undefined), change); // clients predating subscription
  assert.equal(scopedAssetChange(change, null), change); // explicit unscoped editor
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { renderThumbnails, type RenderThumbnailsDeps } from "../src/thumbnails.js";

test("an unopened library never loads models, expands prefabs, or renders thumbnails", async () => {
  const unexpected = () => { throw new Error("Unrequested asset was accessed"); };
  await renderThumbnails({
    assets: {
      prefabIds: () => ["hidden/prefab"],
      modelIds: () => Array.from({ length: 4000 }, (_, i) => `hidden/model-${i}`),
      dataAssetsOfType: () => [{ id: "hidden/material" }],
      getPrefab: unexpected,
      getModel: unexpected,
    },
    thumbnails: { get: () => ({}), set: unexpected },
    thumbnailRequests: { get: () => [] },
    renderer: new Proxy({}, { get: unexpected }),
  } as unknown as RenderThumbnailsDeps);
});

test("leaving a page while its bake is queued cancels the GPU work", async () => {
  let ids = ["visible/model"];
  let accessed = 0;
  let bakes = 0;
  const pending = renderThumbnails({
    assets: {
      prefabIds: () => [],
      modelIds: () => ["visible/model", "hidden/model"],
      dataAssetsOfType: () => [],
      getModel: () => { accessed++; return { url: "must-not-fetch.glb" }; },
    },
    thumbnails: { get: () => ({}), set: () => {} },
    thumbnailRequests: { get: () => ids },
    span: () => { bakes++; return () => {}; },
  } as unknown as RenderThumbnailsDeps);
  ids = [];
  await pending;
  assert.equal(accessed, 1);
  assert.equal(bakes, 0);
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { assetInFolder, assetPage } from "../../../packages/editor/src/asset-browsing.js";

test("root and folder browsing do not enumerate descendants; search does", () => {
  const ids = ["root.glb", "town/wall.glb", "town/interior/table.glb", "township/tree.glb"];
  assert.deepEqual(ids.filter((id) => assetInFolder(id, "", false)), ["root.glb"]);
  assert.deepEqual(ids.filter((id) => assetInFolder(id, "town", false)), ["town/wall.glb"]);
  assert.deepEqual(ids.filter((id) => assetInFolder(id, "town", true)), ids.slice(1, 3));
  assert.deepEqual(ids.filter((id) => assetInFolder(id, "", true)), ids);
});

test("large asset libraries have bounded, complete pages and clamp after deletion", () => {
  const ids = Array.from({ length: 7800 }, (_, i) => `asset-${i}`);
  const collected: string[] = [];
  for (let page = 0; page < assetPage(ids, 0).pages; page++) {
    const result = assetPage(ids, page);
    assert.ok(result.ids.length <= 48);
    collected.push(...result.ids);
  }
  assert.deepEqual(collected, ids);
  assert.deepEqual(assetPage(["remaining"], 162), { ids: ["remaining"], page: 0, pages: 1 });
  assert.deepEqual(assetPage([], 10), { ids: [], page: 0, pages: 1 });
});

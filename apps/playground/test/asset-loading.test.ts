import { test } from "node:test";
import assert from "node:assert/strict";
import { batchedAssetReader } from "../src/asset-reads.js";
import { setAssetScopeOwner } from "../src/asset-url.js";
import { acceptsAssetChange, coalesceAssetChanges } from "../src/asset-changes.js";

test("large libraries use bounded scoped batches, preserving good reads around a broken file", async () => {
  const original = globalThis.fetch;
  let active = 0, peak = 0, requests = 0;
  try {
    setAssetScopeOwner("world");
    globalThis.fetch = (async (url, options) => {
      assert.match(String(url), /asset-json.*project=world/);
      const { files } = JSON.parse(String(options!.body)) as { files: string[] };
      assert.ok(files.length <= 64);
      requests++; peak = Math.max(peak, ++active);
      await new Promise((resolve) => setTimeout(resolve, 1));
      active--;
      return new Response(JSON.stringify(files.map((file) => file === "prefabs/100.json" ? { error: "broken JSON" } : { data: file })));
    }) as typeof fetch;
    const read = batchedAssetReader();
    const results = await Promise.allSettled(Array.from({ length: 1000 }, (_, i) => read("prefabs", `${i}.json`)));
    assert.equal(requests, 16);
    assert.ok(peak <= 4);
    assert.equal(results[100]!.status, "rejected");
    assert.deepEqual(results[999], { status: "fulfilled", value: "prefabs/999.json" });
  } finally { globalThis.fetch = original; setAssetScopeOwner(null); }
});

test("a failed batch releases its slot so later assets can still load", async () => {
  const original = globalThis.fetch;
  let requests = 0;
  try {
    globalThis.fetch = (async (_url, options) => {
      if (++requests === 1) throw new Error("network failure");
      const { files } = JSON.parse(String(options!.body));
      return new Response(JSON.stringify(files.map(() => ({ data: true }))));
    }) as typeof fetch;
    const read = batchedAssetReader();
    const result = await Promise.allSettled(Array.from({ length: 400 }, (_, i) => read("items", `${i}.json`)));
    assert.equal(result.filter((r) => r.status === "rejected").length, 64);
    assert.equal(result[399]!.status, "fulfilled");
  } finally { globalThis.fetch = original; }
});

test("another project's asset writes cannot rebuild the loaded world", () => {
  const scope = new Set(["world", "foundation", "world-kit"]);
  assert.equal(acceptsAssetChange({ project: "other-lab", file: "prefabs/house.json", content: "{}" }, scope), false);
  assert.equal(acceptsAssetChange({ project: "world-kit", file: "prefabs/house.json", content: "{}" }, scope), true);
  assert.equal(acceptsAssetChange({ project: "other-lab", file: "scenes/new.scene.json", content: "{}" }, scope), true);
});

test("a save burst invalidates the scene once, and subsequent edits still arrive", async () => {
  let calls = 0;
  const notify = coalesceAssetChanges(() => calls++);
  for (let i = 0; i < 500; i++) notify();
  await new Promise((resolve) => setTimeout(resolve, 70));
  assert.equal(calls, 1);
  notify();
  await new Promise((resolve) => setTimeout(resolve, 70));
  assert.equal(calls, 2);
});

test("a burst of recipe writes applies once, the last one, after the writes go quiet (or at the max wait)", async () => {
  const { settleBurst } = await import("../src/asset-changes.js");
  const applied: number[] = [];
  const burst = settleBurst<number>((v) => applied.push(v), 40, 1000);
  for (let i = 0; i < 5; i++) { burst.push(i); await new Promise((r) => setTimeout(r, 10)); }
  assert.deepEqual(applied, []);
  await new Promise((r) => setTimeout(r, 80));
  assert.deepEqual(applied, [4]);
  // a writer that never goes quiet still lands at the max wait
  const steady: number[] = [];
  const capped = settleBurst<number>((v) => steady.push(v), 40, 100);
  const t0 = Date.now();
  while (Date.now() - t0 < 200) { capped.push(Date.now() - t0); await new Promise((r) => setTimeout(r, 15)); }
  assert.ok(steady.length >= 1, "applied at least once while writes never stopped");
  // flush applies what is held at once
  capped.push(-1);
  capped.flush();
  assert.equal(steady.at(-1), -1);
  assert.equal(capped.pending(), false);
});

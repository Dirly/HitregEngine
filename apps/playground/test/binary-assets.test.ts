import { test } from "node:test";
import assert from "node:assert/strict";
import { AssetLibrary } from "@hitreg/core";
import { applyBinaryAssetIndex, flushBinaryAssetIndex, type BinaryAssetIndex } from "../src/binary-assets.js";
import { prepareAssetChanges } from "../src/prepared-asset-changes.js";
import { refreshBinaryAssets } from "../src/asset-loader.js";
import { setAssetScopeOwner } from "../src/asset-url.js";

const snapshot = (revision: string, extra = false): BinaryAssetIndex => ({
  index: { models: ["helm.glb", ...(extra ? ["new-mask.glb"] : [])], textures: ["bronze.png"] },
  revisions: { "models/helm.glb": revision, "textures/bronze.png": revision, ...(extra ? { "models/new-mask.glb": "fresh" } : {}) },
});
test("bootstrap versions avoid unchanged reimports; replacements get revision URLs only when Play stops", () => {
  const assets = new AssetLibrary(); applyBinaryAssetIndex(assets, snapshot("first"), { seed: true });
  const original = assets.getModel("helm.glb")!.url;
  assert.deepEqual(applyBinaryAssetIndex(assets, snapshot("first"), { stage: true }), { models: [], textures: [] });
  assert.deepEqual(applyBinaryAssetIndex(assets, snapshot("second", true), { stage: true }), { models: ["new-mask.glb"], textures: [] });
  assert.equal(assets.getModel("helm.glb")!.url, original);
  assert.ok(assets.getModel("new-mask.glb"));
  assert.deepEqual(flushBinaryAssetIndex(assets), { models: ["helm.glb"], textures: ["bronze.png"] });
  assert.notEqual(assets.getModel("helm.glb")!.url, original);
  assert.match(assets.getModel("helm.glb")!.url, /_hitreg_rev=second/);
  assert.deepEqual(flushBinaryAssetIndex(assets), { models: [], textures: [] });
});
test("only the last binary revision is applied and an explicit revert cancels a staged revision", () => {
  const assets = new AssetLibrary(); applyBinaryAssetIndex(assets, snapshot("first"), { seed: true });
  applyBinaryAssetIndex(assets, snapshot("second"), { stage: true }); applyBinaryAssetIndex(assets, snapshot("third"), { stage: true });
  flushBinaryAssetIndex(assets); assert.match(assets.getTexture("bronze.png")!.url, /_hitreg_rev=third/);
  applyBinaryAssetIndex(assets, snapshot("fourth"), { stage: true }); applyBinaryAssetIndex(assets, snapshot("third"), { stage: true });
  assert.deepEqual(flushBinaryAssetIndex(assets), { models: [], textures: [] });
});
test("coalesced binary registration completes before JSON or scene delivery and preserves the latest scene save", async () => {
  const assets = new AssetLibrary(); let refreshes = 0; const delivered: string[] = [];
  let release!: () => void; const waiting = new Promise<void>(resolve => { release = resolve; });
  const prepared = prepareAssetChanges(async () => { refreshes++; await waiting; applyBinaryAssetIndex(assets, snapshot("first", true)); }, change => {
    assert.ok(assets.getModel("new-mask.glb"), "the scene's newly referenced model must already resolve"); delivered.push(change.content!);
  }, 1000);
  prepared.push({ file: "prefabs/cult.json", content: "prefab" });
  prepared.push({ file: "scenes/new.scene.json", content: "old-scene" });
  const flushing = prepared.flush();
  prepared.push({ file: "scenes/new.scene.json", content: "latest-scene" });
  assert.deepEqual(delivered, []); release(); await flushing;
  assert.equal(refreshes, 2, "writes during discovery need a fresh index snapshot"); assert.deepEqual(delivered, ["prefab", "latest-scene"]);
});
test("failed binary discovery retains queued JSON until a successful retry", async () => {
  let fail = true; const delivered: string[] = [];
  const prepared = prepareAssetChanges(async () => { if (fail) throw new Error("offline"); }, c => delivered.push(c.content!), 1000);
  prepared.push({ file: "scenes/new.scene.json", content: "scene" });
  await assert.rejects(prepared.flush(), /offline/); assert.deepEqual(delivered, []);
  fail = false; await prepared.flush(); assert.deepEqual(delivered, ["scene"]);
});
test("binary refresh uses the current scene scope and project-owned file URLs", async () => {
  const original = globalThis.fetch; setAssetScopeOwner("my-world");
  try {
    globalThis.fetch = (async url => { assert.match(String(url), /scene=my-scene.*kinds=models,textures.*revisions=1/); return new Response(JSON.stringify(snapshot("v"))); }) as typeof fetch;
    const assets = new AssetLibrary(); await refreshBinaryAssets(assets, "my-scene", { stage: false });
    assert.match(assets.getModel("helm.glb")!.url, /project=my-world/);
  } finally { globalThis.fetch = original; setAssetScopeOwner(null); }
});

test("an in-flight index read checks Play state at commit, so Stop cannot strand a late revision", async () => {
  const original = globalThis.fetch, assets = new AssetLibrary(); applyBinaryAssetIndex(assets, snapshot("first"), { seed: true });
  let playing = true, release!: (response: Response) => void;
  try {
    globalThis.fetch = (() => new Promise<Response>(resolve => { release = resolve; })) as typeof fetch;
    const refreshing = refreshBinaryAssets(assets, "scene", { stage: () => playing });
    playing = false; release(new Response(JSON.stringify(snapshot("second"))));
    assert.deepEqual(await refreshing, { models: ["helm.glb"], textures: ["bronze.png"] });
    assert.match(assets.getModel("helm.glb")!.url, /_hitreg_rev=second/);
    assert.deepEqual(flushBinaryAssetIndex(assets), { models: [], textures: [] });
  } finally { globalThis.fetch = original; }
});

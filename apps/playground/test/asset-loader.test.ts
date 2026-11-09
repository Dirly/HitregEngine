import { test } from "node:test";
import assert from "node:assert/strict";
import {
  AssetLibrary, defaultWorldRecipe, getVoxelRecipe, registerCoreAssetTypes, volumeIds,
} from "@hitreg/core";
import { loadAssets, loadedProjectScope } from "../src/asset-loader.js";
import { setAssetScopeOwner } from "../src/asset-url.js";

test("scene and registries overlap the bounded library queue, but load resolves with the entire scope available", async () => {
  const original = globalThis.fetch;
  const assets = new AssetLibrary();
  registerCoreAssetTypes(assets);
  const batches: { files: string[]; finish(): void }[] = [];
  let sceneStarted = false, active = 0, peak = 0, resolved = false;
  const world = "asset-loader-overlap-world", volume = "asset-loader-overlap-volume";
  const scene = JSON.stringify({ version: 1, name: "selected", entities: {} });
  const prefab = { version: 1, name: "Prop", root: "root", entities: { root: { name: "Prop", components: {} } } };
  const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
  const until = async (ready: () => boolean) => {
    for (let i = 0; i < 100 && !ready(); i++) await tick();
    assert.ok(ready(), "expected loading stage was reached");
  };
  try {
    globalThis.fetch = (async (url, options) => {
      if (String(url).startsWith("/__hitreg/assets-index")) return new Response(JSON.stringify({
        scenes: ["other.scene.json", "selected.scene.json"],
        prefabs: Array.from({ length: 300 }, (_, i) => `${i}.json`),
        materials: ["material.json"], worlds: [`${world}.json`], volumes: [`${volume}.json`],
        models: ["prop.glb"], textures: ["prop.png"], audio: ["prop.ogg"],
      }), { headers: { "x-hitreg-scope": "world,foundation" } });
      assert.match(String(url), /project=world/);
      if (String(url).includes("asset-file")) {
        assert.match(String(url), /selected\.scene\.json/);
        sceneStarted = true;
        return new Response(scene);
      }
      assert.match(String(url), /asset-json/);
      const { files } = JSON.parse(String(options!.body)) as { files: string[] };
      assert.ok(files.length <= 64);
      peak = Math.max(peak, ++active);
      return new Promise<Response>((resolve) => batches.push({ files, finish: () => {
        active--;
        resolve(new Response(JSON.stringify(files.map((file) => ({ data:
          file.startsWith("worlds/") ? defaultWorldRecipe({ name: world }) :
          file.startsWith("volumes/") ? { version: 1 } :
          file.startsWith("materials/") ? { shader: "standard" } : prefab,
        })))));
      } }));
    }) as typeof fetch;
    const loading = loadAssets(assets, "selected").then((result) => { resolved = true; return result; });
    await until(() => batches.length === 4);
    assert.equal(sceneStarted, true, "scene text must not wait behind the library");
    assert.ok(batches[0]!.files.includes(`worlds/${world}.json`));
    assert.ok(batches[0]!.files.includes(`volumes/${volume}.json`));
    assert.equal(resolved, false);
    batches[0]!.finish();
    await until(() => batches.length === 5);
    assert.equal(getVoxelRecipe(world)?.name, world);
    assert.ok(volumeIds().includes(volume));
    assert.equal(resolved, false, "an early scene/registry result must not expose an incomplete library");
    for (const batch of batches.slice(1)) batch.finish();
    assert.deepEqual(await loading, { id: "selected", content: scene });
    assert.equal(peak, 4);
    assert.equal(batches.length, 5, "registry reads share library batches rather than adding two serial requests");
    assert.equal(assets.prefabIds().length, 300);
    assert.ok(assets.getDataAsset("material"));
    assert.ok(assets.getModel("prop.glb"));
    assert.ok(assets.getTexture("prop.png"));
    assert.ok(assets.getSound("prop.ogg"));
    assert.deepEqual([...loadedProjectScope()!], ["world", "foundation"]);
  } finally {
    globalThis.fetch = original;
    setAssetScopeOwner(null);
  }
});

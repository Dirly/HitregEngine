import { test } from "node:test";
import assert from "node:assert/strict";
import { AssetLibrary, characterCreationSchema, dressCharacter, itemSchema, type DataAssetDoc } from "@hitreg/core";
import { createDeferredAppearanceAssets } from "../src/deferred-appearance-assets.js";

const item = (model: string, value = 1, id = "hood"): DataAssetDoc => ({
  id, type: "item", name: id,
  data: itemSchema.parse({ name: "Cult hood", kind: "equipment", slots: ["helm"], value,
    appearance: { model, parts: ["Hood"], texture: "red.png" } }),
});
const creation = (model: string): DataAssetDoc => ({
  id: "cult", type: "creation", name: "cult",
  data: characterCreationSchema.parse({ model: "body.glb", traitPicks: 0, archetypes: [{ id: "human", name: "Human" }],
    mounts: [{ model, socket: "Head" }] }),
});
function setup(initialMode: "playing" | "paused" | "edit" = "playing") {
  const assets = new AssetLibrary();
  assets.defineDataType("item", itemSchema); assets.defineDataType("creation", characterCreationSchema);
  assets.addDataAsset(item("old.glb")); assets.addDataAsset(creation("old.glb"));
  let mode = initialMode;
  const rebuilds: Array<{ model: string; mount: string; newItem: boolean }> = [];
  const queue = createDeferredAppearanceAssets({
    read: (id) => assets.getDataAsset(id),
    write: (asset) => { if (assets.getDataAsset(asset.id)) assets.updateDataAsset(asset); else assets.addDataAsset(asset); },
    playing: () => mode !== "edit",
    invalidate: () => rebuilds.push({ model: model(), mount: mount(), newItem: !!assets.getDataAsset("new-hood") }),
  });
  const model = () => (assets.getDataAsset("hood")!.data as any).appearance.model as string;
  const mount = () => (assets.getDataAsset("cult")!.data as any).mounts[0].model as string;
  return { assets, queue, rebuilds, model, mount, stop: () => { mode = "edit"; queue.flush(); } };
}

test("warm Play keeps old model targets compatible until item and creation changes flush together", () => {
  const s = setup(), liveTarget = "old.glb";
  const visibleParts = (target: string) => {
    const appearance = itemSchema.parse(s.assets.getDataAsset("hood")!.data).appearance!;
    return dressCharacter({ creation: characterCreationSchema.parse(s.assets.getDataAsset("cult")!.data),
      items: [{ model: appearance.model, parts: appearance.parts, texture: appearance.texture ?? null }] }).models.get(target)?.parts ?? [];
  };
  assert.deepEqual(visibleParts(liveTarget), ["Hood"]);
  s.queue.update(item("private.glb")); s.queue.update(creation("private.glb"));
  assert.equal(s.model(), liveTarget); assert.equal(s.mount(), liveTarget); assert.deepEqual(s.rebuilds, []);
  assert.deepEqual(visibleParts(liveTarget), ["Hood"], "the old runtime mesh keeps its hood while the new prefab is held");
  s.stop();
  assert.deepEqual(visibleParts("private.glb"), ["Hood"]);
  assert.deepEqual(s.rebuilds, [{ model: "private.glb", mount: "private.glb", newItem: false }]);
  s.queue.flush(); assert.equal(s.rebuilds.length, 1);
});

test("stats-only edits stay live; a mixed appearance/stat edit stays complete and the latest save wins", () => {
  const s = setup();
  s.queue.update(item("old.glb", 2)); assert.equal((s.assets.getDataAsset("hood")!.data as any).value, 2);
  s.queue.update(item("private.glb", 3)); s.queue.update(item("private.glb", 4));
  assert.equal(s.model(), "old.glb"); assert.equal((s.assets.getDataAsset("hood")!.data as any).value, 2);
  s.stop(); assert.equal(s.model(), "private.glb"); assert.equal((s.assets.getDataAsset("hood")!.data as any).value, 4);
});

test("new scene equipment is upserted before the held scene rebuild instead of being lost", () => {
  const s = setup();
  s.queue.update(item("private.glb")); s.queue.update(creation("private.glb")); s.queue.update(item("private.glb", 7, "new-hood"));
  assert.equal(s.assets.getDataAsset("new-hood"), undefined);
  s.stop();
  assert.deepEqual(s.rebuilds, [{ model: "private.glb", mount: "private.glb", newItem: true }]);
  assert.equal((s.assets.getDataAsset("new-hood")!.data as any).value, 7);
});

test("a later explicit appearance revert cancels the pending migration without losing the stat edit", () => {
  const s = setup(); s.queue.update(item("private.glb", 2)); s.queue.update(item("old.glb", 8)); s.stop();
  assert.equal(s.model(), "old.glb"); assert.equal((s.assets.getDataAsset("hood")!.data as any).value, 8);
  assert.deepEqual(s.rebuilds, []);
});

test("invalid latest edits do not replace a valid pending save or modify the live catalog", () => {
  const s = setup(); s.queue.update(item("private.glb", 3));
  assert.throws(() => s.queue.update({ ...item("bad.glb"), data: { name: 7 } }));
  assert.equal(s.model(), "old.glb"); s.stop(); assert.equal(s.model(), "private.glb");
});

test("edit-mode presentation changes invalidate immediately and unrelated data types remain outside the queue", () => {
  const s = setup(); s.stop(); s.queue.update(item("private.glb"));
  assert.equal(s.model(), "private.glb"); assert.equal(s.rebuilds.length, 1);
  assert.equal(s.queue.update({ id: "xp", type: "progression", name: "XP", data: {} }), false);
});

test("paused Play also retains the old appearance until Stop", () => {
  const s = setup("paused"); s.queue.update(item("private.glb")); s.queue.update(creation("private.glb"));
  assert.equal(s.model(), "old.glb"); assert.equal(s.mount(), "old.glb"); assert.deepEqual(s.rebuilds, []);
  s.stop(); assert.equal(s.model(), "private.glb"); assert.equal(s.mount(), "private.glb");
});

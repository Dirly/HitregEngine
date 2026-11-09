// Stale scene autosaves (2026-11-03: a dev client autosaved the scene it booted with and erased places tools had
// installed meanwhile). Server: tools/_scene-write.mts writeAssetGuarded refuses a stale or blind scene write under the
// tools' lock. Client: src/scene-save.ts rebases its own edits onto the refused file and saves again.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ComponentRegistry, contentTag, registerCoreComponents, type EntityDoc, type SceneDoc } from "@hitreg/core";
import { lockFileOf, writeAssetGuarded, applyOpsToSceneFile } from "../tools/_scene-write.mts";
import { createSceneSaver } from "../src/scene-save.js";
import { mergeIncomingScene } from "../src/live-sync.js";
import { applyOps } from "@hitreg/core";

const registry = new ComponentRegistry();
registerCoreComponents(registry);
const ent = (name: string, x = 0, parent: string | null = null): EntityDoc => ({
  name, parent, tags: [], components: { transform: { position: [x, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] } },
});
const scene = (entities: Record<string, EntityDoc>): SceneDoc => ({ version: 1, name: "s", entities });
const text = (d: SceneDoc) => JSON.stringify(d, null, 2);
const tmpScene = (d: SceneDoc): string => {
  const dir = fs.mkdtempSync(path.join(process.env.TEMP ?? os.tmpdir(), "scene-save-"));
  const f = path.join(dir, "s.scene.json");
  fs.writeFileSync(f, text(d));
  return f;
};
/** The dev server's write-asset, in process. */
const serverOf = (file: string) => async (body: Record<string, unknown>) => {
  const out = writeAssetGuarded(file, body.content as string, { base: body.base as string | undefined, requireBase: true });
  return { status: out.status, body: out.body };
};

test("server: a scene write with a stale or missing base is refused with the current text; a current one writes", () => {
  const d0 = scene({ a: ent("A") });
  const file = tmpScene(d0);
  const blind = writeAssetGuarded(file, text(scene({})), { requireBase: true });
  assert.equal(blind.status, 409);
  assert.equal(blind.body.stale, true);
  const stale = writeAssetGuarded(file, text(scene({})), { base: contentTag("old"), requireBase: true });
  assert.equal(stale.status, 409);
  assert.equal(stale.body.content, text(d0));
  assert.equal(stale.body.tag, contentTag(text(d0)));
  assert.equal(fs.readFileSync(file, "utf8"), text(d0), "refused writes leave the file alone");
  const ok = writeAssetGuarded(file, text(scene({ b: ent("B") })), { base: contentTag(text(d0)), requireBase: true });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.tag, contentTag(text(scene({ b: ent("B") }))));
});

test("server: a write while a tool holds the file's lock is refused as locked", () => {
  const file = tmpScene(scene({}));
  fs.writeFileSync(lockFileOf(file), JSON.stringify({ pid: process.pid, host: os.hostname(), label: "place-build", at: new Date().toISOString() }));
  const out = writeAssetGuarded(file, text(scene({})), { base: contentTag(text(scene({}))), requireBase: true });
  assert.equal(out.status, 409);
  assert.equal(out.body.locked, true);
  fs.rmSync(lockFileOf(file));
  // a dead holder's lock is stale: broken, the write goes through
  fs.writeFileSync(lockFileOf(file), JSON.stringify({ pid: 999_999_9, host: os.hostname(), label: "dead", at: new Date().toISOString() }));
  assert.equal(writeAssetGuarded(file, text(scene({})), { base: contentTag(text(scene({}))) }).status, 200);
  assert.equal(fs.existsSync(lockFileOf(file)), false);
});

test("client: a stale autosave rebases the human's edits onto the tool's install instead of erasing it", async () => {
  const booted = scene({ a: ent("A"), b: ent("B") });
  const file = tmpScene(booted);
  // a tool installs a place under its lock meanwhile
  applyOpsToSceneFile(file, [
    { op: "add-entity", id: "place", entity: ent("Place") },
    { op: "add-entity", id: "place-wall", entity: ent("Wall", 1, "place") },
  ], (doc, ops) => applyOps(doc, ops, registry), { label: "test install" });
  // the human (who never saw it) moved A and added H; the editor autosaves with base = what it booted with
  const mine = scene({ a: ent("A", 7), b: ent("B"), h: ent("Human") });
  const adopted: string[] = [];
  const saver = createSceneSaver({ registry, post: serverOf(file), onSaved: (_s, o) => { if (o.rebased && o.disk) adopted.push(o.disk); }, warn: () => {} });
  const out = await saver.save({ file: "scenes/s.scene.json", content: text(mine), base: text(booted) });
  assert.equal(out.error, undefined);
  assert.equal(out.rebased, true);
  const disk = JSON.parse(fs.readFileSync(file, "utf8")) as SceneDoc;
  assert.deepEqual(Object.keys(disk.entities).sort(), ["a", "b", "h", "place", "place-wall"], "both the install and the human's add survive");
  assert.equal((disk.entities.a!.components.transform as any).position[0], 7, "the human's move survives");
  assert.equal(adopted.length, 1, "the merged text is handed back to adopt into the open doc");
});

test("client: a stale save with no edits of its own writes nothing (the canonicalising-save clobber)", async () => {
  const booted = scene({ a: ent("A") });
  const file = tmpScene(booted);
  const installed = scene({ a: ent("A"), place: ent("Place") });
  fs.writeFileSync(file, text(installed) + "\n");
  const before = fs.readFileSync(file, "utf8");
  const saver = createSceneSaver({ registry, post: serverOf(file), warn: () => {} });
  // same doc it booted with, re-serialised (different text from the tool's file)
  const out = await saver.save({ file: "scenes/s.scene.json", content: text(booted), base: text(booted) + "\n" });
  assert.equal(out.rebased, true);
  assert.equal(fs.readFileSync(file, "utf8"), before, "the tool's file is untouched");
});

test("client: queued saves stay in order and converge after a rebase", async () => {
  const booted = scene({ a: ent("A") });
  const file = tmpScene(booted);
  fs.writeFileSync(file, text(scene({ a: ent("A"), t: ent("Tool") })));
  const saver = createSceneSaver({ registry, post: serverOf(file), warn: () => {} });
  const c1 = text(scene({ a: ent("A", 1) }));
  const c2 = text(scene({ a: ent("A", 2), h: ent("H") }));
  void saver.save({ file: "f", content: c1, base: text(booted) });
  void saver.save({ file: "f", content: c2, base: c1 });
  await saver.idle();
  const disk = JSON.parse(fs.readFileSync(file, "utf8")) as SceneDoc;
  assert.deepEqual(Object.keys(disk.entities).sort(), ["a", "h", "t"]);
  assert.equal((disk.entities.a!.components.transform as any).position[0], 2);
});

test("client: a tool holding the lock is waited out, then the save goes through", async () => {
  const d = scene({ a: ent("A") });
  const file = tmpScene(d);
  fs.writeFileSync(lockFileOf(file), JSON.stringify({ pid: process.pid, host: os.hostname(), label: "tool", at: new Date().toISOString() }));
  let waits = 0;
  const saver = createSceneSaver({ registry, post: serverOf(file), warn: () => {}, sleep: async () => { if (++waits === 2) fs.rmSync(lockFileOf(file)); } });
  const out = await saver.save({ file: "f", content: text(scene({ a: ent("A", 3) })), base: text(d) });
  assert.equal(out.error, undefined);
  assert.equal(waits, 2);
});

test("live-sync: a file change under unsaved local edits keeps both", () => {
  const known = scene({ a: ent("A") });
  const open = scene({ a: ent("A", 4), h: ent("H") }); // edited here, not saved yet
  const incoming = scene({ a: ent("A"), place: ent("Place") }); // a tool's write
  const { doc } = mergeIncomingScene(open, text(known), incoming, registry);
  assert.deepEqual(Object.keys(doc.entities).sort(), ["a", "h", "place"]);
  assert.equal((doc.entities.a!.components.transform as any).position[0], 4);
  // no local edits: the file wins outright (an external removal applies)
  const removed = mergeIncomingScene(known, text(known), scene({}), registry).doc;
  assert.deepEqual(Object.keys(removed.entities), []);
});

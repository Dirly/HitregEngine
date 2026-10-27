import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { countItems, lockFileOf, lockIsStale, removalsOf, updateJsonFile } from "../tools/_scene-write.mts";

const here = path.dirname(fileURLToPath(import.meta.url));
const helper = pathToFileURL(path.resolve(here, "../tools/_scene-write.mts")).href;

function tmpScene(n = 0): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scene-write-"));
  const file = path.join(dir, "w.scene.json");
  const entities: Record<string, unknown> = {};
  for (let i = 0; i < n; i++) entities[`base-${i}`] = { name: `base-${i}`, components: {} };
  fs.writeFileSync(file, JSON.stringify({ name: "w", entities }));
  return file;
}

/** A writer process: N read-modify-writes, each adding its own entity after a slow "plan" inside the lock. */
function writer(file: string, tag: string, n: number): Promise<number> {
  const code = `
    import { updateJsonFile } from "${helper}";
    const until = (ms) => { const t = Date.now() + ms; while (Date.now() < t); };
    for (let i = 0; i < ${n}; i++) updateJsonFile(${JSON.stringify(file)}, (doc) => { until(15); doc.entities["${tag}-" + i] = { name: "${tag}", components: {} }; return { doc }; }, { label: "${tag}" });
  `;
  return new Promise((resolve) => {
    const p = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", code], { stdio: "inherit" });
    p.on("exit", (c) => resolve(c ?? 1));
  });
}

test("two concurrent writers never lose each other's entities", async () => {
  const file = tmpScene(5);
  const [a, b] = await Promise.all([writer(file, "rock-skins", 8), writer(file, "place-build", 8)]);
  assert.equal(a, 0); assert.equal(b, 0);
  const doc = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal(Object.keys(doc.entities).length, 5 + 16);
  assert.equal(fs.existsSync(lockFileOf(file)), false, "lock released");
  assert.deepEqual(fs.readdirSync(path.dirname(file)).filter((f) => f.endsWith(".tmp")), [], "no tmp left");
});

test("a write that drops items it did not declare is refused; declared removals pass", () => {
  const file = tmpScene(4);
  assert.throws(() => updateJsonFile(file, (d: any) => { delete d.entities["base-0"]; return { doc: d }; }), /refusing/);
  assert.equal(countItems(JSON.parse(fs.readFileSync(file, "utf8"))), 4, "file untouched");
  updateJsonFile(file, (d: any) => { delete d.entities["base-0"]; return { doc: d, removed: ["base-0"] }; });
  updateJsonFile(file, (d: any) => { delete d.entities["base-1"]; return { doc: d }; }, { allowRemovals: true });
  assert.equal(countItems(JSON.parse(fs.readFileSync(file, "utf8"))), 2);
});

test("recipe features are counted across every kind", () => {
  assert.equal(countItems({ features: { patches: [1, 2], operators: [3], seed: 4 } }), 3);
});

test("a lock held by a dead pid is stale; a live one waits", () => {
  const now = Date.parse("2026-10-21T12:00:00Z");
  const info = { pid: 999999, host: os.hostname(), label: "x", at: "2026-10-21T11:59:00Z" };
  assert.equal(lockIsStale(info, now, 30 * 60_000, () => false), true);
  assert.equal(lockIsStale(info, now, 30 * 60_000, () => true), false);
  assert.equal(lockIsStale({ ...info, at: "2026-10-21T11:00:00Z" }, now, 30 * 60_000, () => true), true, "too old");
  const file = tmpScene(1);
  fs.writeFileSync(lockFileOf(file), JSON.stringify({ ...info, at: new Date().toISOString() })); // pid 999999 is dead
  updateJsonFile(file, (d: any) => { d.entities.x = { name: "x", components: {} }; return { doc: d }; });
  assert.equal(countItems(JSON.parse(fs.readFileSync(file, "utf8"))), 2);
});

test("removalsOf counts the removed subtrees", () => {
  const doc = { entities: { a: {}, b: { parent: "a" }, c: { parent: "b" }, d: {} } };
  assert.deepEqual(removalsOf([{ op: "remove-entity", id: "a" }], doc).sort(), ["a", "b", "c"]);
});

test("a whole-doc writer refuses when another tool wrote the file after its read", async () => {
  const { readJsonTracked, writeJsonFile } = await import("../tools/_scene-write.mts");
  const file = tmpScene(3);
  const doc: any = readJsonTracked(file);
  updateJsonFile(file, (d: any) => { d.entities.other = { name: "other", components: {} }; return { doc: d }; }); // the other tool
  doc.entities.mine = { name: "mine", components: {} };
  assert.throws(() => writeJsonFile(file, doc), /changed on disk/);
  const again: any = readJsonTracked(file);
  again.entities.mine = { name: "mine", components: {} };
  writeJsonFile(file, again);
  assert.equal(countItems(JSON.parse(fs.readFileSync(file, "utf8"))), 5);
});

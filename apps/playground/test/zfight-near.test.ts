import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { nearCells, parseNear, staticSoup, triangleNear } from "../tools/zfight.mts";

test("zfight --near: parse, triangle and cell selection", () => {
  assert.deepEqual(parseNear("3440,660,240"), { x: 3440, z: 660, r: 240 });
  assert.equal(parseNear(undefined), undefined);
  assert.throws(() => parseNear("1,2"));
  const n = { x: 0, z: 0, r: 10 };
  assert.equal(triangleNear([9, 0, 9, 30, 0, 9, 30, 0, 30], 0, n), true); // one corner inside
  assert.equal(triangleNear([-30, 0, 5, 30, 0, 5, 0, 0, 40], 0, n), true); // spans it without a vertex inside
  assert.equal(triangleNear([11, 0, 0, 20, 0, 0, 20, 0, 5], 0, n), false);
  assert.deepEqual(nearCells({ x: 32, z: 32, r: 1 }, 32), [[0, 0], [0, 1], [1, 0], [1, 1]]);
});

test("zfight --near: the soup keeps only the region's static meshes", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "zfight-near-"));
  const assets = path.join(dir, "assets");
  fs.mkdirSync(assets, { recursive: true });
  const box = (x: number) => ({ name: `b${x}`, parent: null, tags: [], components: { transform: { position: [x, 0, 0] }, mesh: { source: { kind: "primitive", shape: "box", size: [1, 1, 1] } } } });
  const doc: any = { version: 1, entities: { near: box(0), far: box(500) } };
  const all = staticSoup("none", assets, doc, null);
  assert.deepEqual(all.labels.sort(), ["far", "near"]);
  const some = staticSoup("none", assets, doc, null, undefined, { x: 0, z: 0, r: 20 });
  assert.deepEqual(some.labels, ["near"]);
  assert.equal(some.meshes[0]!.positions.length, all.meshes.find((m) => m.id === "near")!.positions.length);
});

test("zfight: hidden prefab parts (a landmark bake's welded collider) never fight", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "zfight-hidden-"));
  const assets = path.join(dir, "assets");
  fs.mkdirSync(path.join(assets, "prefabs", "t"), { recursive: true });
  const mesh = { source: { kind: "primitive", shape: "box", size: [2, 2, 2] } };
  fs.writeFileSync(path.join(assets, "prefabs", "t", "lm.json"), JSON.stringify({ root: "r", entities: {
    r: { name: "r", parent: null, components: { transform: {} } },
    shell: { name: "shell", parent: "r", components: { transform: {}, mesh: { ...mesh, material: "a" } } },
    collider: { name: "collider", parent: "r", components: { transform: {}, visibility: { visible: false }, mesh: { ...mesh, material: "a" }, collider: { shape: "trimesh" } } },
  } }));
  const doc: any = { version: 1, entities: { lm: { name: "lm", parent: null, tags: [], components: { transform: {}, prefab: { prefabId: "t/lm" } } } } };
  const s = staticSoup("none", assets, doc, null);
  assert.deepEqual(s.labels, ["lm/t/lm:shell"]);
});

test("zfight: a bare collider (physics only, never drawn) never fights the visual it shadows", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "zfight-collider-"));
  const assets = path.join(dir, "assets");
  fs.mkdirSync(assets, { recursive: true });
  const doc: any = { version: 1, entities: {
    deck: { name: "deck", parent: null, tags: [], components: { transform: {}, mesh: { source: { kind: "primitive", shape: "box", size: [4, 0.2, 4] } } } },
    "deck-col": { name: "deck (collider)", parent: null, tags: ["static"], components: { transform: {}, collider: { shape: "box", size: [4, 0.2, 4] } } },
  } };
  assert.deepEqual(staticSoup("none", assets, doc, null).labels, ["deck"]);
});

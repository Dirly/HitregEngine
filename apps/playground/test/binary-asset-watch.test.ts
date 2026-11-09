import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs"; import os from "node:os"; import path from "node:path";
import { binaryAssetChangePublisher, isBinaryAsset } from "../tools/_asset-watch.mts";

test("model and texture saves publish bounded binary notices, not file bytes or repeated identical events", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hitreg-binary-watch-")), seen: string[] = [];
  const pub = binaryAssetChangePublisher((_root, file) => seen.push(file));
  try {
    fs.mkdirSync(path.join(root, "models")); fs.writeFileSync(path.join(root, "models/test.glb"), Buffer.from([0, 255, 0, 240]));
    pub.enqueue(root, "models/test.glb"); pub.enqueue(root, "models/test.glb");
    await new Promise(r => setTimeout(r, 100)); assert.deepEqual(seen, ["models/test.glb"]);
    pub.enqueue(root, "models/test.glb"); await new Promise(r => setTimeout(r, 100)); assert.equal(seen.length, 1);
    fs.appendFileSync(path.join(root, "models/test.glb"), Buffer.from([1])); pub.enqueue(root, "models/test.glb");
    await new Promise(r => setTimeout(r, 100)); assert.equal(seen.length, 2);
    assert.equal(isBinaryAsset("textures\\mmo\\mask.png"), true); assert.equal(isBinaryAsset("authoring/master.png"), false);
  } finally { pub.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

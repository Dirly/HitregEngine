import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { run } from "./run.mjs";
import { collapseTileset, collapsedPrefab } from "./wfc.mjs";

const tile = (id, prefabId, socket, weight = 1) => ({
  id,
  ...(prefabId ? { prefabId } : {}),
  weight,
  offset: id === "moss" ? [0.5, 0.25, -0.5] : [0, 0, 0],
  rotations: [0, 90, 180, 270],
  sockets: { px: socket, nx: socket, py: socket, ny: socket, pz: socket, nz: socket },
});

const tileset = {
  version: 1,
  name: "Self test",
  cellSize: [2, 3, 4],
  tiles: [tile("stone", "kit/stone", "same", 4), tile("moss", "kit/moss", "same", 1)],
  pins: [{ at: [0, 0, 0], tile: "moss", rotation: 90 }],
};

const a = collapseTileset(tileset, { width: 4, height: 2, depth: 3, seed: 42, attempts: 2 });
const b = collapseTileset(tileset, { width: 4, height: 2, depth: 3, seed: 42, attempts: 2 });
assert.deepEqual(a.cells, b.cells, "same seed must produce the same collapse");
assert.equal(a.cells.length, 24);
assert.equal(a.cells[0].tileId, "moss");
assert.equal(a.cells[0].rotation, 90);

const prefab = collapsedPrefab(a, "self-layout", "center");
assert.equal(Object.keys(prefab.entities).length, 25);
assert.deepEqual(prefab.entities.root.components, { transform: {} });
assert.equal(prefab.entities["cell-0-0-0"].components.prefab.prefabId, "kit/moss");
assert.deepEqual(prefab.entities["cell-0-0-0"].components.transform.position, [-3.5, 0.25, -4.5]);

const temp = fs.mkdtempSync(path.join(os.tmpdir(), "hitreg-wfc-"));
const written = new Map();
try {
  const result = await run(
    {
      runDir: temp,
      writeAsset(file, data) {
        written.set(file, data);
        return file;
      },
      assetExists(file) {
        return file === "prefabs/kit/stone.json" || file === "prefabs/kit/moss.json";
      },
    },
    {
      tileset: {
        name: "self.tileset.json",
        mediaType: "application/json",
        data: Buffer.from(JSON.stringify(tileset)).toString("base64"),
      },
      name: "generated/self-layout",
      width: 4,
      height: 2,
      depth: 3,
      seed: 42,
      attempts: 2,
      origin: "center",
    },
  );
  assert.equal(result.assets[0].kind, "prefab");
  assert.ok(written.has("prefabs/generated/self-layout.json"));
  assert.equal(JSON.parse(written.get("prefabs/generated/self-layout.json")).root, "root");
  assert.equal(result.report.occupied, 24);
  assert.equal(result.previews[0].mediaType, "image/svg+xml");

  await assert.rejects(
    run(
      {
        runDir: temp,
        writeAsset() { throw new Error("must not write a broken prefab"); },
        assetExists() { return false; },
      },
      {
        tileset: { name: "missing.json", mediaType: "application/json", data: Buffer.from(JSON.stringify(tileset)).toString("base64") },
        name: "generated/missing",
        width: 2,
        height: 1,
        depth: 2,
        seed: 1,
        attempts: 1,
        origin: "center",
      },
    ),
    /missing source prefab asset/,
  );
  console.log("3D Prefab WFC self-test OK");
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}

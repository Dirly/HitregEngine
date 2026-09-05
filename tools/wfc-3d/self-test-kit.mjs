/**
 * End-to-end check of the kit pipeline on a synthetic kit: a plank floor and
 * a brick wall are built as glTF parts, a 3x2 room is assembled from them as
 * a GLB example, the import atlases + learns, a solve produces an enclosed
 * layout, and the floor counter-rotation is verified numerically against
 * three's rotateUV formula.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readGltf, accessorFloats } from "./gltf.mjs";
import { importKit, solveKit, packProps, fitFloorUv, rotateDirection, stripCopySuffix } from "./kit.mjs";
import { writeSyntheticKit, partDoc, boxGeometry, stripesPng } from "./synthetic-kit.mjs";
import { faceCompatibility, parseTileset, uvCounterRotation } from "./wfc.mjs";
import { run } from "./run.mjs";

import { CELL } from "./synthetic-kit.mjs";

// --- unit checks ------------------------------------------------------------

assert.equal(rotateDirection("pz", 90), "px");
assert.equal(rotateDirection("pz", 180), "nz");
assert.equal(rotateDirection("pz", 270), "nx");
assert.equal(rotateDirection("px", 90), "nz");
assert.equal(stripCopySuffix("Wall 2"), "wall");
assert.equal(stripCopySuffix("wall.001"), "wall");
assert.equal(stripCopySuffix("floor_planks_3"), "floor-planks");

// The counter-rotation must cancel the mesh rotation for any UV projection
// handedness. Shader: rotateUV(uv, φ, c) = rotate(uv − c, φ) + c with
// rotate = (x cos φ − y sin φ, x sin φ + y cos φ). Mesh yaw θ (three): (x, z)
// → (x cos θ + z sin θ, −x sin θ + z cos θ).
for (const flipV of [false, true]) {
  const uvOf = (x, z) => [x / 4 + 0.5, (flipV ? -z : z) / 4 + 0.5];
  const samples = [];
  for (const [x, z] of [[-2, -2], [2, -2], [2, 2], [-2, 2], [0.5, -1]]) {
    const [u, v] = uvOf(x, z);
    samples.push({ x, z, u, v });
  }
  const fit = fitFloorUv(samples);
  assert.ok(fit, "fit exists");
  assert.equal(fit.factor, flipV ? 1 : -1, `factor for flipV=${flipV}`);
  assert.deepEqual(fit.center.map((v) => +v.toFixed(6)), [0.5, 0.5]);
  for (const rotation of [0, 90, 180, 270]) {
    const phi = (uvCounterRotation(rotation, fit.factor) * Math.PI) / 180;
    const theta = (rotation * Math.PI) / 180;
    for (const [x, z] of [[1, 0], [0, 1], [1.5, -0.5], [-2, 2]]) {
      // the part's own vertex at local (x, z) samples uv0; after the mesh turns by θ it sits at world (wx, wz)
      const [u, v] = uvOf(x, z);
      const du = u - fit.center[0];
      const dv = v - fit.center[1];
      const ru = du * Math.cos(phi) - dv * Math.sin(phi) + fit.center[0];
      const rv = du * Math.sin(phi) + dv * Math.cos(phi) + fit.center[1];
      const wx = x * Math.cos(theta) + z * Math.sin(theta);
      const wz = -x * Math.sin(theta) + z * Math.cos(theta);
      const [eu, ev] = uvOf(wx, wz);
      assert.ok(Math.abs(ru - eu) < 1e-9 && Math.abs(rv - ev) < 1e-9, `rotation ${rotation} flipV=${flipV}: got ${ru},${rv} want ${eu},${ev}`);
    }
  }
}

// --- pipeline ---------------------------------------------------------------

const temp = fs.mkdtempSync(path.join(os.tmpdir(), "hitreg-wfc-kit-"));
try {
  const kitDir = writeSyntheticKit(path.join(temp, "drop", "cabin"));
  const assetsDir = path.join(temp, "project", "assets");
  const logs = [];
  const log = (s) => logs.push(s);

  const report = await importKit({ kitDir, assetsDir, cellSize: CELL, log });
  assert.equal(report.kit, "cabin");
  const floor = report.parts.find((p) => p.name === "floor");
  const wall = report.parts.find((p) => p.name === "wall");
  assert.equal(floor.role, "floor");
  assert.equal(floor.uvAlign.factor, -1, "planar u=x, v=z projection preserves handedness → factor -1");
  assert.equal(wall.role, "edge");
  assert.equal(wall.slot, "pz");
  assert.equal(report.atlas.islands, 2, "two distinct textures → two islands");
  assert.equal(report.atlas.pages, 1);
  assert.equal(report.examples[0].placements.length, 6 + 10, "6 floors + 10 walls placed");
  assert.deepEqual(report.examples[0].unmatched, []);
  assert.ok(report.examples[0].placements.some((p) => p.node === "thing" && p.matchedBy === "geometry"), "a renamed node matched by geometry");
  assert.deepEqual(report.warnings.filter((w) => !w.includes("not square")), [], `unexpected warnings: ${report.warnings.join(" | ")}`);

  // rewritten module: atlas image shared by name, UVs inside the island, uv1 = rotation centre
  const floorModel = readGltf(path.join(assetsDir, "models", "wfc", "cabin", "floor.gltf"));
  assert.ok(floorModel.doc.images[0].name.startsWith("hitreg-shared:"));
  assert.ok(floorModel.doc.textures[0].name.startsWith("hitreg-shared:"));
  assert.equal(floorModel.doc.samplers[0].wrapS, 33071, "atlas sampler clamps");
  const prim = floorModel.doc.meshes[0].primitives[0];
  const uv0 = accessorFloats(floorModel, prim.attributes.TEXCOORD_0);
  const uv1 = accessorFloats(floorModel, prim.attributes.TEXCOORD_1);
  const layout = JSON.parse(fs.readFileSync(path.join(assetsDir, "textures", "atlas", "cabin.atlas.json"), "utf8"));
  const islands = Object.values(layout.islands);
  const inside = (u, v) => islands.some((is) => u >= is.x / 2048 - 1e-6 && u <= (is.x + is.w) / 2048 + 1e-6 && v >= is.y / 2048 - 1e-6 && v <= (is.y + is.h) / 2048 + 1e-6);
  for (let i = 0; i < uv0.length; i += 2) assert.ok(inside(uv0[i], uv0[i + 1]), `uv ${uv0[i]},${uv0[i + 1]} lies in an island`);
  const centreU = uv1[0];
  const centreV = uv1[1];
  for (let i = 0; i < uv1.length; i += 2) assert.ok(uv1[i] === centreU && uv1[i + 1] === centreV, "uv1 constant per part");
  assert.ok(inside(centreU, centreV), "rotation centre lies in the floor's island");
  const wallModel = readGltf(path.join(assetsDir, "models", "wfc", "cabin", "wall.gltf"));
  assert.equal(wallModel.doc.images[0].name, floorModel.doc.images[0].name, "every module embeds the SAME atlas under the same shared name");
  const page = fs.readFileSync(path.join(assetsDir, "textures", "atlas", "cabin-0.png"));
  assert.ok(page.length > 100);

  // learned tileset
  const tileset = JSON.parse(fs.readFileSync(path.join(assetsDir, "wfc", "cabin.tileset.json"), "utf8"));
  const parsed = parseTileset(tileset);
  assert.equal(parsed.outside, "void");
  const real = tileset.tiles.filter((t) => t.id !== "void");
  assert.equal(real.length, 2, `corner (floor + 2 walls) and straight (floor + 1 wall): ${real.map((t) => t.id).join(", ")}`);
  const corner = real.find((t) => t.parts.length === 3);
  const straight = real.find((t) => t.parts.length === 2);
  assert.equal(corner.weight, 4);
  assert.equal(straight.weight, 2);
  assert.deepEqual(corner.rotations, [0, 90, 180, 270]);
  assert.deepEqual(corner.alignUv, [{ child: "floor", factor: -1 }]);
  const h = new Set(tileset.adjacency.horizontal.map((p) => p.join("|")));
  assert.ok(h.has("wall|void") || h.has("void|wall"), "wall faces the void");
  assert.ok(h.has("open|open"), "open floor continues");
  assert.ok(!h.has("open|void") && !h.has("void|open"), "an open face never meets the void (never seen)");
  const v = new Set(tileset.adjacency.vertical.map((p) => p.join("|")));
  assert.ok(v.has("void|floor"), "floor over the ground void");
  assert.ok(v.has("open-top|void"), "sky above an open room");
  for (const tile of real) {
    const prefab = JSON.parse(fs.readFileSync(path.join(assetsDir, "prefabs", "wfc", "cabin", `${tile.id}.json`), "utf8"));
    assert.equal(prefab.root, "root");
    assert.deepEqual(prefab.entities.root.components, { transform: {} });
    assert.ok(prefab.entities.floor, "floor child keeps a stable id");
    assert.equal(prefab.entities.floor.components.mesh.source.assetId, "wfc/cabin/floor.gltf");
    assert.equal(prefab.entities.floor.components.mesh.renderMode, "instanced");
    assert.equal(prefab.entities.floor.components.collider.shape, "box");
  }

  // solve: enclosed, and every rotated floor carries its counter-rotation
  const solved = solveKit({ assetsDir, kit: "cabin", name: "generated/room-test", size: [6, 1, 6], seed: 7, attempts: 40, log });
  assert.ok(fs.existsSync(solved.file));
  assert.ok(solved.occupied > 0, "something was built");
  const compatible = faceCompatibility(parsed);
  const byXYZ = new Map(solved.result.cells.map((c) => [`${c.x},${c.y},${c.z}`, c]));
  let rotatedFloors = 0;
  for (const cell of solved.result.cells) {
    for (const [dir, dx, dz] of [["px", 1, 0], ["pz", 0, 1]]) {
      const n = byXYZ.get(`${cell.x + dx},${cell.y},${cell.z + dz}`);
      if (!n) continue;
      const opp = dir === "px" ? "nx" : "nz";
      assert.ok(compatible(cell.sockets[dir], dir, n.sockets[opp]), `${cell.tileId}@${cell.rotation} ${dir} vs ${n.tileId}@${n.rotation}`);
      assert.ok(!((cell.sockets[dir] === "open" && n.sockets[opp] === "void") || (cell.sockets[dir] === "void" && n.sockets[opp] === "open")), "no open floor edge faces the void");
    }
    const entity = solved.prefab.entities[`cell-${cell.x}-${cell.y}-${cell.z}`];
    if (!cell.prefabId) {
      assert.equal(entity, undefined);
      continue;
    }
    if (cell.rotation !== 0) {
      rotatedFloors += 1;
      assert.deepEqual(entity.components.prefab.overrides, [{ path: "floor/components/mesh/source/uvRotation", value: uvCounterRotation(cell.rotation, -1) }]);
    } else {
      assert.equal(entity.components.prefab.overrides, undefined);
    }
  }
  assert.ok(rotatedFloors > 0, "some cells were placed rotated");

  // the registered runner accepts the learned tileset unchanged
  const written = new Map();
  const runResult = await run(
    {
      runDir: temp,
      writeAsset(file, data) {
        written.set(file, data);
        return file;
      },
      assetExists: () => true,
    },
    {
      tileset: { name: "cabin.tileset.json", mediaType: "application/json", data: Buffer.from(JSON.stringify(tileset)).toString("base64") },
      name: "generated/runner",
      width: 4,
      height: 1,
      depth: 4,
      seed: 3,
      attempts: 40,
      origin: "center",
    },
  );
  assert.ok(written.has("prefabs/generated/runner.json"));
  assert.ok(runResult.report.occupied >= 0);

  // plain props join the SAME atlas, and every earlier consumer is re-emitted onto the new page
  const propsDir = path.join(temp, "drop", "props");
  fs.mkdirSync(propsDir, { recursive: true });
  const rockDoc = partDoc(boxGeometry([-0.5, 0, -0.5], [0.5, 0.8, 0.5]), stripesPng(8, true, [90, 90, 100], [60, 60, 70]), "rock");
  rockDoc.materials[0].name = "Leaves"; // a name wind.materials matches — must survive the rewrite
  fs.writeFileSync(path.join(propsDir, "Rock Big.gltf"), JSON.stringify(rockDoc));
  const packed = packProps({ srcDir: propsDir, assetsDir, atlasName: "cabin", out: "models/props", log });
  assert.equal(packed.islands, 3, "kit's two textures + the rock's on one atlas");
  assert.equal(packed.pages, 1);
  assert.deepEqual(packed.written, ["models/props/rock-big.gltf"]);
  const rockModel = readGltf(path.join(assetsDir, "models", "props", "rock-big.gltf"));
  assert.equal(rockModel.doc.materials[0].name, "Leaves", "source material names are kept");
  const floorAfterPack = readGltf(path.join(assetsDir, "models", "wfc", "cabin", "floor.gltf"));
  assert.equal(rockModel.doc.images[0].name, floorAfterPack.doc.images[0].name, "the kit module was re-emitted with the new page under the same shared name");
  assert.notEqual(floorAfterPack.doc.images[0].name, floorModel.doc.images[0].name, "the page changed when the rock joined");
  const layoutAfterPack = JSON.parse(fs.readFileSync(path.join(assetsDir, "textures", "atlas", "cabin.atlas.json"), "utf8"));
  for (const [hash, island] of Object.entries(layout.islands)) assert.deepEqual(layoutAfterPack.islands[hash], island, "kit islands did not move when the rock joined");
  assert.equal(layoutAfterPack.sources.length, 3, "atlas remembers all three consumers");
  await assert.rejects(async () => packProps({ srcDir: path.join(assetsDir, "models", "props"), assetsDir, atlasName: "cabin", out: "models/props", log }), /must differ/);

  // re-import keeps islands where they were, and re-emits the prop too
  const again = await importKit({ kitDir, assetsDir, cellSize: CELL, log });
  const rockAgain = readGltf(path.join(assetsDir, "models", "props", "rock-big.gltf"));
  const floorAgain = readGltf(path.join(assetsDir, "models", "wfc", "cabin", "floor.gltf"));
  assert.equal(rockAgain.doc.images[0].name, floorAgain.doc.images[0].name, "kit re-import re-emits the prop onto the same page");
  const layout2 = JSON.parse(fs.readFileSync(path.join(assetsDir, "textures", "atlas", "cabin.atlas.json"), "utf8"));
  for (const [hash, island] of Object.entries(layout.islands)) assert.deepEqual(layout2.islands[hash], island, "islands are stable across imports");
  assert.equal(again.atlas.islands, 3);

  console.log("WFC kit pipeline self-test OK");
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}

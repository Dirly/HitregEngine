import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { convertMeshStamp, paletteMaterial, MAX_SOURCE_BYTES } from "./convert.mjs";
import { run } from "./run.mjs";

const require = createRequire(new URL("../../apps/playground/package.json", import.meta.url));
const { tsImport } = await import(pathToFileURL(require.resolve("tsx/esm/api")).href);
const { ToolRegistry, toolResultSchema } = await tsImport("../../packages/core/src/tools.ts", import.meta.url);
const { createVolume, buildVolumeMesh } = await tsImport("../../packages/core/src/voxel/csg.ts", import.meta.url);
const manifest = JSON.parse(fs.readFileSync(new URL("./tool.json", import.meta.url), "utf8"));

function cube(name = "Entry Hall", offset = [-2.23, 4.31, 7.17]) {
  const positions = [-1,-1,-1, 1,-1,-1, 1,1,-1, -1,1,-1, -1,-1,1, 1,-1,1, 1,1,1, -1,1,1]
    .map((n, i) => n + offset[i % 3]);
  const indices = [0,2,1, 0,3,2, 4,5,6, 4,6,7, 0,1,5, 0,5,4, 3,7,6, 3,6,2, 0,4,7, 0,7,3, 1,2,6, 1,6,5];
  return { name, positions, indices, solidTriangleCounts: [12], triangleMaterials: indices.filter((_, i) => i % 3 === 0).map((_, i) => i % 11) };
}

function source(meshes = [cube()]) {
  return { version: 1, name: "Measured entrance", palette: Array.from({ length: 11 }, (_, i) => ({ id: `role-${i}`, color: `#${(0x334455 + i * 0x10101).toString(16)}`, originalSlot: i })), meshes };
}

function input(src = source()) {
  return { source: { name: "source.json", mediaType: "application/json", data: Buffer.from(JSON.stringify(src)).toString("base64") }, name: "test-import", voxelSize: 0.25 };
}

function context(t, collisions = []) {
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), "hitreg-mesh-dc-test-"));
  const written = new Map();
  t.after(() => fs.rmSync(runDir, { recursive: true, force: true }));
  return { runDir, written, assetExists: file => collisions.includes(file), writeAsset(file, data) { written.set(file, data); return file; } };
}

test("preserves global mesh coordinates, eleven palette roles, and empty entrance anchor", () => {
  const src = source([cube(), cube("Cave Room", [7.13, -3.12, -1.16])]);
  const result = convertMeshStamp(src, { name: "blackvein-depths" });
  assert.equal(typeof result.then, "undefined", "converter API is synchronous");
  assert.deepEqual(result.volumes.map(v => v.id), ["blackvein-depths/entry-hall", "blackvein-depths/cave-room"]);
  assert.deepEqual(result.palette, src.palette);
  assert.deepEqual(result.volumes[0].doc.palette, src.palette.map(p => p.id));
  assert.deepEqual(result.volumes[0].doc.nodes[0].mesh, { positions: src.meshes[0].positions, indices: src.meshes[0].indices, solidTriangleCounts: [12], triangleMaterials: src.meshes[0].triangleMaterials });
  assert.deepEqual(result.volumes[0].doc.nodes[0].position, [0, 0, 0]);
  assert.deepEqual(result.prefab.entities.root.components, { transform: { position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] } });
  const child = result.prefab.entities["volume-entry-hall"];
  assert.equal(child.parent, "root");
  assert.deepEqual(child.components.transform.position, [0, 0, 0]);
  assert.deepEqual(child.components.mesh.source, { kind: "csg", volume: result.volumes[0].id });
  assert.equal(child.components.collider.shape, "trimesh");
  assert.deepEqual(result.material.doc.splat.layers.map(layer => layer.color), src.palette.map(p => p.color));
  assert.equal(result.report.extraction, "pending");
  assert.equal(result.report.volumes[0].sourceValidation, "passed");
  for (const volume of result.volumes) {
    const measured = result.report.volumes.find(v => v.id === volume.id);
    volume.bounds.min.forEach((min, axis) => {
      assert.ok(Math.abs(min / 0.12 - Math.round(min / 0.12)) < 1e-10);
      assert.ok(min <= measured.sourceBounds.min[axis] - 3 * 0.12 + 1e-12);
      assert.ok(volume.bounds.max[axis] >= measured.sourceBounds.max[axis] + 3 * 0.12 - 1e-12);
    });
  }
  // Documents do not alias the input: an editor mutation cannot alter the source recipe.
  result.volumes[0].doc.nodes[0].mesh.positions[0] = 99;
  assert.equal(src.meshes[0].positions[0], -3.23);
});

test("one selected group retains original triangle material channels", () => {
  const result = convertMeshStamp(source([cube(), cube("Side Cave")]), { meshNames: ["Side Cave"], materialId: "custom/palette" });
  assert.equal(result.volumes.length, 1);
  assert.equal(result.volumes[0].id, "mesh-import/side-cave");
  assert.equal(result.material.id, "custom/palette");
  assert.equal(result.palette.length, 11);
  assert.equal(result.report.sourceGroups, 2);
  assert.equal(result.prefab.entities["volume-side-cave"].components.mesh.material, "custom/palette");
});

test("overlapping independent closed solids import and extract through the native engine", () => {
  const first = cube("Overlap", [0, 0, 0]), second = cube("Second", [1, 0, 0]);
  const combined = { ...first, positions: [...first.positions, ...second.positions], indices: [...first.indices, ...second.indices.map(i => i + 8)], solidTriangleCounts: [12, 12], triangleMaterials: [...first.triangleMaterials, ...second.triangleMaterials] };
  const result = convertMeshStamp(source([combined]), { voxelSize: 0.5 });
  const mesh = buildVolumeMesh(createVolume(result.volumes[0].doc));
  assert.ok(mesh.positions.length > 0);
  assert.ok(mesh.indices.length > 0);
  assert.equal(result.report.volumes[0].declaredSolids, 2);
});

test("rejects malformed closed-solid sources before producing assets", () => {
  const mutations = [
    [m => { m.indices.splice(0, 3); m.triangleMaterials.shift(); m.solidTriangleCounts = [11]; }, /closed|edge|solid/i],
    [m => { [m.indices[0], m.indices[1]] = [m.indices[1], m.indices[0]]; }, /winding|solid/i],
    [m => { m.indices[0] = 999; }, /index|indices|solid/i],
    [m => { m.positions[0] = Infinity; }, /finite/i],
    [m => { m.solidTriangleCounts = [11]; }, /count|solid/i],
    [m => { m.indices[1] = m.indices[0]; }, /degenerate|solid/i],
    [m => { m.triangleMaterials[0] = 11; }, /palette index/i],
    [m => { m.triangleMaterials.pop(); }, /palette index/i],
  ];
  for (const [mutate, expected] of mutations) {
    const src = source(); mutate(src.meshes[0]);
    assert.throws(() => convertMeshStamp(src), expected);
  }
});

test("rejects unsafe names, duplicate IDs, invalid selections and palettes", () => {
  for (const name of ["", "../bad", "foo/bar", "UPPER", "nul", "con", "a\\b"]) assert.throws(() => convertMeshStamp(source(), { name }), /name|ID/i);
  for (const materialId of ["../bad", "a//b", "a/../b", "C:/bad", "a/nul"]) assert.throws(() => convertMeshStamp(source(), { materialId }), /ID/i);
  assert.throws(() => convertMeshStamp(source([cube("Room A"), cube("Room-A")])), /Duplicate output ID/);
  assert.throws(() => convertMeshStamp(source([cube("")])), /nonempty name/);
  assert.throws(() => convertMeshStamp(source([cube("!!!")])), /safe output name/);
  assert.throws(() => convertMeshStamp(source(), { meshNames: ["missing"] }), /does not exist/);
  assert.throws(() => convertMeshStamp(source(), { meshNames: [] }), /nonempty/);
  const duplicatePalette = source(); duplicatePalette.palette[1].id = duplicatePalette.palette[0].id;
  assert.throws(() => convertMeshStamp(duplicatePalette), /Duplicate palette/);
  assert.throws(() => convertMeshStamp({ ...source(), meshes: [] }), /at least one/);
  assert.equal(paletteMaterial([{ id: "stone", color: "#123456" }]).shader, "standard");
});

test("checks actual padded cell budget before compiling or extracting a huge source", () => {
  const huge = cube(); huge.positions = huge.positions.map(n => n * 1000);
  assert.throws(() => convertMeshStamp(source([huge])), /exceeding.*15,000,000/);
  assert.throws(() => convertMeshStamp(source(), { maxCells: 15_000_001 }), /Cell limit/);
  assert.throws(() => convertMeshStamp(source(), { maxCells: 1 }), /exceeding.*1 limit/);
  assert.throws(() => convertMeshStamp(source(), { voxelSize: 0 }), /Voxel size/);
});

test("public registry validates invocation and registered runner writes full valid assets", async t => {
  const registry = new ToolRegistry();
  registry.register(manifest);
  const validated = registry.validate("hitreg.mesh-dc", input());
  assert.equal(validated.ok, true);
  assert.equal(registry.describe()["hitreg.mesh-dc"].name, "Blender to DC");
  assert.equal(registry.validate("hitreg.mesh-dc", { ...input(), name: "../bad" }).ok, false);
  assert.equal(registry.validate("hitreg.mesh-dc", { ...input(), maxCells: 15_000_001 }).ok, false);
  assert.equal(registry.validate("hitreg.mesh-dc", { ...input(), unexpected: 1 }).ok, false);
  const ctx = context(t);
  const result = toolResultSchema.parse(await run(ctx, validated.data));
  assert.equal(ctx.written.size, 3);
  assert.deepEqual(result.assets.map(a => a.kind), ["volume", "material", "prefab"]);
  assert.deepEqual(result.assets.find(a => a.kind === "prefab"), { kind: "prefab", id: "test-import/stamp", file: "prefabs/test-import/stamp.json" });
  assert.ok(ctx.written.has("prefabs/test-import/stamp.json"));
  assert.equal(ctx.written.has("prefabs/test-import.json"), false);
  for (const [file, bytes] of ctx.written) assert.doesNotThrow(() => JSON.parse(bytes.toString("utf8")), file);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(ctx.runDir, "recipe.json"), "utf8")).source, source());
  assert.equal(JSON.parse(fs.readFileSync(path.join(ctx.runDir, "report.json"), "utf8")).extraction, "pending");
  assert.equal(result.report.compositions.length, 1);
  const composition = result.report.compositions[0];
  assert.equal(composition.materialId, "test-import/dc-palette");
  const recipe = JSON.parse(fs.readFileSync(composition.file, "utf8"));
  assert.deepEqual(recipe, {
    version: 1, name: "Entry Hall", voxelSize: 0.25, palette: source().palette.map(entry => entry.id),
    instances: [{ id: "structure", volume: JSON.parse(ctx.written.get("volumes/test-import/entry-hall.json")), position: [0, 0, 0], yaw: 0 }],
    connections: [],
  });
});

test("preflights every asset and every selected group before any write", async t => {
  for (const collision of ["volumes/test-import/entry-hall.json", "materials/test-import/dc-palette.json", "prefabs/test-import/stamp.json"]) {
    const ctx = context(t, [collision]);
    await assert.rejects(run(ctx, input()), /Output already exists/);
    assert.equal(ctx.written.size, 0);
    assert.deepEqual(fs.readdirSync(ctx.runDir), []);
  }
  const laterCollision = context(t, ["volumes/test-import/last-room.json"]);
  await assert.rejects(run(laterCollision, input(source([cube(), cube("Last Room")]))), /Output already exists/);
  assert.equal(laterCollision.written.size, 0, "a collision in a later volume must preserve all earlier outputs");
  assert.deepEqual(fs.readdirSync(laterCollision.runDir), []);
  const bad = cube("Broken Room"); bad.indices[0] = 999;
  const ctx = context(t);
  await assert.rejects(run(ctx, input(source([cube(), bad]))), /valid closed solid/);
  assert.equal(ctx.written.size, 0);
  await assert.rejects(run({ ...ctx, assetExists: undefined }, input()), /existence checks/);
  await assert.rejects(run(ctx, { ...input(), source: { data: "!bad" } }), /valid Blender/);
});

test("runner waits for every asset write before returning success", async t => {
  const ctx = context(t);
  ctx.writeAsset = async (file, bytes) => {
    await new Promise(resolve => setImmediate(resolve));
    ctx.written.set(file, bytes);
    return file;
  };
  const result = await run(ctx, input());
  assert.equal(ctx.written.size, result.assets.length);
  assert.deepEqual([...ctx.written.keys()], result.assets.map(asset => asset.file));
});

test("source limit leaves room for base64 within the host body limit", async t => {
  assert.equal(MAX_SOURCE_BYTES, 32 * 1024 * 1024);
  assert.equal(manifest.inputs.source.maxBytes, MAX_SOURCE_BYTES);
  const encodedLimit = Math.ceil(MAX_SOURCE_BYTES / 3) * 4;
  assert.ok(encodedLimit + 1024 * 1024 < 48 * 1024 * 1024, "leave more than 1 MiB for invocation metadata");
  const ctx = context(t);
  await assert.rejects(run(ctx, { ...input(), source: { data: "A".repeat(encodedLimit + 4) } }), /32 MiB limit/);
  assert.equal(ctx.written.size, 0);
  assert.deepEqual(fs.readdirSync(ctx.runDir), []);
});

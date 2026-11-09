import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import sharp from "sharp";
import { compareModel, compressBundle, imageBytes, optimizePng, readGltf } from "../tools/publish-compress.mjs";

const rgba = (width: number, height: number, pixel: (x: number, y: number) => number[]): Buffer => {
  const out = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) out.set(pixel(x, y), (y * width + x) * 4);
  return out;
};
const png = (data: Buffer, width: number, height: number): Promise<Buffer> =>
  sharp(data, { raw: { width, height, channels: 4 } }).png({ compressionLevel: 0 }).toBuffer();
const decoded = async (bytes: Buffer): Promise<Buffer> => sharp(bytes).toColourspace("srgb").ensureAlpha().raw().toBuffer();

/** A one-triangle .gltf with base64 buffers and one embedded image, as the kit tools write them. */
function gltfFile(image: Buffer, tag: string): Buffer {
  const positions = Buffer.from(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1.000123, 0, 0.3, 0.7, 2, 5, 5, 5, 9, 1, 3]).buffer);
  const uvs = Buffer.from(new Float32Array([0.123456789, 0.5, 0.75, 0.25, 1 / 3, 2 / 3, 0, 0, 1, 1, 0.5, 0.1]).buffer);
  const indices = Buffer.from(new Uint16Array([0, 1, 2, 3, 4, 5]).buffer);
  const bin = Buffer.concat([positions, uvs, indices]);
  return Buffer.from(JSON.stringify({
    asset: { version: "2.0" },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0, name: tag, extras: { keep: tag } }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0, TEXCOORD_0: 1 }, indices: 2, material: 0 }] }],
    materials: [{ name: "m", pbrMetallicRoughness: { baseColorTexture: { index: 0 } } }],
    textures: [{ name: "hitreg-shared:abc", source: 0, sampler: 0 }],
    samplers: [{ magFilter: 9728, minFilter: 9728 }],
    images: [{ name: "atlas", uri: `data:image/png;base64,${image.toString("base64")}` }],
    accessors: [
      { bufferView: 0, componentType: 5126, count: 6, type: "VEC3", min: [0, 0, 0], max: [9, 5, 5] },
      { bufferView: 1, componentType: 5126, count: 6, type: "VEC2" },
      { bufferView: 2, componentType: 5123, count: 6, type: "SCALAR" },
    ],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: positions.length, target: 34962 },
      { buffer: 0, byteOffset: positions.length, byteLength: uvs.length, target: 34962 },
      { buffer: 0, byteOffset: positions.length + uvs.length, byteLength: indices.length, target: 34963 },
    ],
    buffers: [{ byteLength: bin.length, uri: `data:application/octet-stream;base64,${bin.toString("base64")}` }],
  }));
}

test("optimizePng: decoded pixels stay byte-identical, including colour under transparency", async () => {
  const cases: Array<[string, Buffer, number, number]> = [
    // few colours: goes indexed; alpha 0 pixels carry distinct RGB that must survive
    ["indexed", rgba(32, 32, (x, y) => [(x >> 3) * 60, (y >> 3) * 60, 7, x % 5 === 0 ? 0 : 255]), 32, 32],
    ["four colours", rgba(16, 16, (x) => [x % 4 * 80, 0, 0, 255]), 16, 16],
    // many colours: truecolour
    ["truecolour", rgba(64, 64, (x, y) => [x * 4, y * 4, (x * y) & 255, 255]), 64, 64],
    ["truecolour alpha", rgba(64, 64, (x, y) => [x * 4, y * 4, (x ^ y) & 255, (x + y) & 255]), 64, 64],
  ];
  for (const [name, pixels, width, height] of cases) {
    const source = await png(pixels, width, height);
    const out = await optimizePng(source);
    assert.ok(out.length <= source.length, name);
    assert.ok((await decoded(out)).equals(await decoded(source)), `${name}: pixels changed`);
  }
});

test("optimizePng: a PNG with a colour chunk a browser acts on keeps its bytes", async () => {
  const plain = await png(rgba(8, 8, () => [10, 20, 30, 255]), 8, 8);
  // insert gAMA after IHDR (8 signature + 25 IHDR)
  const gama = Buffer.from([0, 0, 0, 4, 0x67, 0x41, 0x4d, 0x41, 0, 0, 0xb1, 0x8f, 0x0b, 0xfc, 0x61, 0x05]);
  const withGamma = Buffer.concat([plain.subarray(0, 33), gama, plain.subarray(33)]);
  assert.equal(await optimizePng(withGamma), withGamma);
});

test("compressBundle: dedupes shared images, keeps every vertex and pixel, writes sidecars, leaves other files", async () => {
  const dir = mkdtempSync(join(tmpdir(), "publish-compress-"));
  try {
    const content = join(dir, "content");
    mkdirSync(join(content, "models/kit/deep"), { recursive: true });
    mkdirSync(join(content, "textures"), { recursive: true });
    const atlas = await png(rgba(32, 32, (x, y) => [(x >> 2) * 30, (y >> 2) * 30, 0, 255]), 32, 32);
    const lonely = await png(rgba(32, 32, (x, y) => [0, (x >> 2) * 30, (y >> 2) * 30, 255]), 32, 32);
    const sources: Record<string, Buffer> = {
      "models/kit/a.gltf": gltfFile(atlas, "a"),
      "models/kit/deep/b.gltf": gltfFile(atlas, "b"),
      "models/kit/solo.gltf": gltfFile(lonely, "solo"),
    };
    for (const [rel, bytes] of Object.entries(sources)) writeFileSync(join(content, rel), bytes);
    writeFileSync(join(content, "textures/loose.png"), atlas);
    writeFileSync(join(content, "big.json"), JSON.stringify({ text: "x".repeat(5000) }));

    const stats = await compressBundle(dir, { log: () => {} });
    assert.equal(stats.verified, 3);
    assert.equal(stats.models.kept, 0);
    assert.equal(stats.images.shared, 1);

    const shared = readdirSync(join(content, "shared"));
    assert.equal(shared.length, 1);
    assert.ok((await decoded(readFileSync(join(content, "shared", shared[0]!)))).equals(await decoded(atlas)));

    const a = readGltf(readFileSync(join(content, "models/kit/a.gltf")))!;
    const b = readGltf(readFileSync(join(content, "models/kit/deep/b.gltf")))!;
    assert.equal(a.json.images[0].uri, `../../shared/${shared[0]}`);
    assert.equal(b.json.images[0].uri, `../../../shared/${shared[0]}`);
    // the sampler and texture naming ride through untouched: nearest stays nearest
    assert.deepEqual(a.json.samplers, [{ magFilter: 9728, minFilter: 9728 }]);
    assert.equal(a.json.textures[0].name, "hitreg-shared:abc");
    assert.deepEqual(a.json.nodes[0].extras, { keep: "a" });

    const solo = readGltf(readFileSync(join(content, "models/kit/solo.gltf")))!;
    assert.equal(solo.json.images[0].uri, undefined);
    assert.ok((await decoded(imageBytes(solo, solo.json.images[0])!.bytes)).equals(await decoded(lonely)));

    assert.ok(existsSync(join(content, "big.json.br")));
    assert.ok(existsSync(join(content, "big.json.gz")));
    assert.ok((await decoded(readFileSync(join(content, "textures/loose.png")))).equals(await decoded(atlas)));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("compareModel catches a moved UV", () => {
  const image = Buffer.from([1, 2, 3]);
  const source = readGltf(gltfFile(image, "a"))!;
  const moved = readGltf(gltfFile(image, "a"))!;
  const view = moved.json.bufferViews[1];
  moved.buffers[0]![view.byteOffset] ^= 1; // one low bit of one UV
  assert.match(String(compareModel(source, moved, () => true)), /accessor 1: bytes differ/);
  assert.equal(compareModel(source, readGltf(gltfFile(image, "a"))!, () => true), null);
});

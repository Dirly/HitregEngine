import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { clearGltfCache, gltfTris, measure, texelDensity, trs, type PropGeometry, type Tri } from "../tools/_prop-geometry.mts";
// @ts-expect-error plain JS module
import { encodePng } from "../tools/_png.mjs";

const geo = (min: [number, number, number], max: [number, number, number]): PropGeometry =>
  ({ tris: [], min, max, effects: [], lights: 0, nested: [], warnings: [] });

test("a prop whose origin is its bottom centre is foot", () => {
  assert.equal(measure(geo([-1, 0, -1], [1, 2, 1])).origin, "foot");
  assert.equal(measure(geo([-1, 0.5, -1], [1, 2, 1])).origin, "off");
});

test("a flat ground card held a few cm above its foot (one mesh owns each plane) is still foot", () => {
  assert.equal(measure(geo([-2, 0.04, -2], [2, 0.04, 2])).origin, "foot");
  assert.equal(measure(geo([-1.8, 0.08, -1.8], [1.8, 0.08, 1.8])).origin, "foot");
  // a thick prop lifted 8 cm, or a card floating 30 cm up, is not
  assert.equal(measure(geo([-1, 0.08, -1], [1, 1, 1])).origin, "off");
  assert.equal(measure(geo([-1, 0.3, -1], [1, 0.3, 1])).origin, "off");
});

test("atlased kit texel density keeps tile pixels and whole UV repeats, including rectangular pages", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hitreg-atlas-measure-"));
  try {
    // A 6.4 x 3.2 m triangle spans two 128 px tiles horizontally and one vertically: 40 tx/m.
    const arrays = [
      new Float32Array([0, 0, 0, 6.4, 0, 0, 0, 3.2, 0]),
      new Float32Array([0, 0, 2, 0, 0, 1]),
      new Float32Array(Array.from({ length: 3 }, () => [0.5, 0.25, 0.25, 0.125]).flat()),
    ];
    const bin = Buffer.concat(arrays.map(a => Buffer.from(a.buffer)));
    let offset = 0;
    const bufferViews = arrays.map(a => { const v = { buffer: 0, byteOffset: offset, byteLength: a.byteLength }; offset += a.byteLength; return v; });
    const image = encodePng(512, 1024, Buffer.alloc(512 * 1024 * 4, 255));
    const doc = {
      asset: { version: "2.0" }, scene: 0, scenes: [{ nodes: [0] }], nodes: [{ mesh: 0 }],
      buffers: [{ byteLength: bin.length, uri: `data:application/octet-stream;base64,${bin.toString("base64")}` }],
      bufferViews,
      accessors: ["VEC3", "VEC2", "VEC4"].map((type, bufferView) => ({ bufferView, componentType: 5126, count: 3, type })),
      images: [{ uri: `data:image/png;base64,${image.toString("base64")}` }], textures: [{ source: 0 }],
      materials: [{ extras: { hitregAtlas: true }, pbrMetallicRoughness: { baseColorTexture: { index: 0 } } }],
      meshes: [{ primitives: [{ attributes: { POSITION: 0, TEXCOORD_0: 1, _ATLASRECT: 2 }, material: 0 }] }],
    };
    const file = path.join(dir, "kit.gltf");
    const read = (override?: string): Tri[] => {
      const tris: Tri[] = [];
      gltfTris(file, trs(), override, tris, override ? { key: "override", size: [128, 128], repeat: [1, 1] } : undefined);
      return tris;
    };
    const density = (tris: Tri[]): number => texelDensity({ ...geo([0, 0, 0], [6.4, 3.2, 0]), tris }).median;
    fs.writeFileSync(file, JSON.stringify(doc));
    assert.ok(Math.abs(density(read()) - 40) < 1e-4, "use the atlas rectangle's pixels without fract-ing away two full repeats");
    assert.ok(Math.abs(density(read("override")) - 40) < 1e-4, "an ordinary material override does not use the atlas shader");
    doc.materials[0]!.extras.hitregAtlas = false;
    fs.writeFileSync(file, JSON.stringify(doc));
    clearGltfCache();
    assert.ok(density(read()) > 200, "a custom attribute alone must not activate atlas sampling");
  } finally {
    clearGltfCache();
    assert.equal(path.dirname(path.resolve(dir)), path.resolve(os.tmpdir()));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// flat-art (tools/flat-art.mts): a slab picture is upright when its image rows fall going up the face; the First King's
// Door stored glTF image-space v (rows from the top) under an engine material (flipY) and showed upside down.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { artOrientation, flipGlbV, slabV, uvOverlap } from "../tools/flat-art.mts";
import { gltfTris, trs } from "../tools/_prop-geometry.mts";

type V3 = [number, number, number];
/** A 2 x 3 m slab face looking north (-z), its picture region [u0..u1] x rows [r0..r1], stored with `v(row)`. */
function slab(v: (row: number) => number, r = [0, 0, 1, 1], mirror = false) {
  const [u0, r0, u1, r1] = r;
  // viewer at -z looking +z: their right is -x, so the image's left column sits at +x
  const P = (x: number, y: number): V3 => [x, y, 0];
  const a = P(1, 3), b = P(-1, 3), c = P(-1, 0), d = P(1, 0); // top-left, top-right, bottom-right, bottom-left as seen
  const uv = (u: number, row: number): [number, number] => [mirror ? 1 - u : u, v(row)]; // mirrored: columns run to the left
  // wound so the normal is -z (faces the viewer)
  return [
    { a, b: c, c: b, uv: [uv(u0!, r0!), uv(u1!, r1!), uv(u1!, r0!)] },
    { a, b: d, c, uv: [uv(u0!, r0!), uv(u0!, r1!), uv(u1!, r1!)] },
  ];
}

test("v = 1 - row under an engine material (flipY) is upright; v = row is upside down", () => {
  const up = artOrientation(slab(slabV), true);
  assert.equal(up.flippedShare, 0);
  assert.equal(up.mirroredShare, 0);
  assert.ok(up.slabShare > 0.99);
  const flipped = artOrientation(slab((row) => row), true);
  assert.equal(flipped.flippedShare, 1);
  // the same UVs on a glTF-embedded texture (flipY false) are upright
  assert.equal(artOrientation(slab((row) => row), false).flippedShare, 0);
});

test("a mirrored slab is caught; one picture laid out once does not overlap, a repeated patch does", () => {
  assert.equal(artOrientation(slab(slabV, [0, 0, 1, 1], true), true).mirroredShare, 1);
  const once = slab(slabV, [0, 0, 0.5, 1]).map((t) => t.uv!);
  assert.ok(uvOverlap(once) < 0.05);
  assert.ok(uvOverlap([...once, ...once]) > 0.9);
});

test("flipGlbV flips TEXCOORD_0 v in a GLB (the fix), twice is the identity (the inverse)", () => {
  const pos = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]), uv = new Float32Array([0, 0.1, 1, 0.1, 0, 0.9]);
  const bin = Buffer.concat([Buffer.from(pos.buffer), Buffer.from(uv.buffer)]);
  const json = {
    asset: { version: "2.0" }, scene: 0, scenes: [{ nodes: [0] }], nodes: [{ mesh: 0 }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0, TEXCOORD_0: 1 } }] }],
    buffers: [{ byteLength: bin.length }],
    bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: 36 }, { buffer: 0, byteOffset: 36, byteLength: 24 }],
    accessors: [
      { bufferView: 0, componentType: 5126, count: 3, type: "VEC3", min: [0, 0, 0], max: [1, 1, 0] },
      { bufferView: 1, componentType: 5126, count: 3, type: "VEC2", min: [0, 0.1], max: [1, 0.9] },
    ],
  };
  let js = Buffer.from(JSON.stringify(json));
  js = Buffer.concat([js, Buffer.alloc((4 - (js.length % 4)) % 4, 0x20)]);
  const head = Buffer.alloc(12); head.writeUInt32LE(0x46546c67, 0); head.writeUInt32LE(2, 4); head.writeUInt32LE(12 + 8 + js.length + 8 + bin.length, 8);
  const ch = (len: number, type: number) => { const b = Buffer.alloc(8); b.writeUInt32LE(len, 0); b.writeUInt32LE(type, 4); return b; };
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "flat-art-")), "slab.glb");
  fs.writeFileSync(file, Buffer.concat([head, ch(js.length, 0x4e4f534a), js, ch(bin.length, 0x004e4942), bin]));
  let n = 0;
  // gltfTris caches by file name: read a fresh copy each time
  const read = () => { const copy = `${file}.${n++}.glb`; fs.copyFileSync(file, copy); const out: any[] = []; gltfTris(copy, trs(), undefined, out); return out[0].uv.map((p: number[]) => +p[1].toFixed(4)); };
  assert.deepEqual(read(), [0.1, 0.1, 0.9]);
  assert.equal(flipGlbV(file), 3);
  assert.deepEqual(read(), [0.9, 0.9, 0.1]);
  flipGlbV(file);
  assert.deepEqual(read(), [0.1, 0.1, 0.9]);
});

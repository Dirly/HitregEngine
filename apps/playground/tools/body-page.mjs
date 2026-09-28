#!/usr/bin/env node
/**
 * body-page — add or replace outfit sheets on the skinned body's page without
 * re-running `reskin` (docs/armor-sets.md).
 *
 *   node tools/body-page.mjs --glb projects/voxel-demo/assets/models/mmo/human-body.glb \
 *     --theme mmo/human-body-leather.png=../../tools/atlas/out/human-body/leather/atlas.png \
 *     --theme mmo/human-body-leather-f.png=../../tools/atlas/out/human-body/leather-f/atlas.png
 *
 * `reskin --theme` bakes the page together with the weight transfer, so adding
 * one outfit meant re-running the whole body with every sheet. This reads the
 * sheets already on the page back out of it (the `tiles` table says where each
 * sits), puts the given ones after them (or in place of the same id), and
 * repacks with reskin's layout: square page, PAD-texel clamped bleed, the first
 * sheet the default look. Geometry, skin, clips and every other extra are kept
 * byte for byte. Run item-icon for the body model afterwards.
 */
import fs from "node:fs";
import path from "node:path";
import { decodePng, encodePng } from "./_png.mjs";
import { assertSquarePage, squareGrid } from "./_page.mjs";

const args = { theme: [] };
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (!a.startsWith("--")) continue;
  const key = a.slice(2);
  const value = process.argv[++i];
  if (key === "theme") args.theme.push(value);
  else args[key] = value;
}
if (!args.glb || !args.theme.length) {
  console.error("usage: body-page --glb <human-body.glb> --theme <sheetId>=<atlas.png> ...");
  process.exit(1);
}
const PAD = 8; // reskin's

const glbPath = path.resolve(args.glb);
const glb = fs.readFileSync(glbPath);
const jsonLen = glb.readUInt32LE(12);
const json = JSON.parse(glb.subarray(20, 20 + jsonLen).toString());
const binStart = 20 + jsonLen + 8;
const bin = glb.subarray(binStart, binStart + glb.readUInt32LE(20 + jsonLen));

const meshNode = json.nodes.find((n) => n.mesh !== undefined && n.skin !== undefined);
if (!meshNode?.extras?.tiles) throw new Error("no skinned mesh with a tiles table: bake it with reskin --theme first");
const prim = json.meshes[meshNode.mesh].primitives[0];
const tex = json.materials[prim.material].pbrMetallicRoughness.baseColorTexture;
const imageIndex = json.textures[tex.index].source;
const image = json.images[imageIndex];
const view = json.bufferViews[image.bufferView];
const oldPage = decodePng(Buffer.from(bin.subarray(view.byteOffset ?? 0, (view.byteOffset ?? 0) + view.byteLength)));

// the sheets already on the page, in page order
const sheets = [];
for (const [id, [u, v, s]] of Object.entries(meshNode.extras.tiles)) {
  const ox = Math.round(u * oldPage.width), oy = Math.round(v * oldPage.height), size = Math.round(s * oldPage.width);
  const data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++)
    data.set(oldPage.data.subarray(((oy + y) * oldPage.width + ox) * 4, ((oy + y) * oldPage.width + ox + size) * 4), y * size * 4);
  sheets.push({ id, png: { width: size, height: size, data } });
}
for (const t of args.theme) {
  const [id, file] = String(t).split("=");
  const png = decodePng(fs.readFileSync(path.resolve(file)));
  const at = sheets.findIndex((s) => s.id === id);
  if (at >= 0) sheets[at] = { id, png };
  else sheets.push({ id, png });
  console.log(`  ${at >= 0 ? "replace" : "add"} ${id}`);
}
const size = sheets[0].png.width;
for (const sh of sheets)
  if (sh.png.width !== size || sh.png.height !== size) throw new Error(`${sh.id}: ${sh.png.width}px, the page is ${size}px — one sheet size per page`);

const { cols, stride, W, H } = squareGrid(sheets.length, size, PAD);
assertSquarePage(W, H, "body-page");
const page = new Uint8Array(W * W * 4);
const tiles = {};
sheets.forEach((sh, i) => {
  const ox = (i % cols) * stride + PAD;
  const oy = Math.floor(i / cols) * stride + PAD;
  for (let y = -PAD; y < size + PAD; y++) {
    const sy = Math.min(size - 1, Math.max(0, y));
    for (let x = -PAD; x < size + PAD; x++) {
      const sx = Math.min(size - 1, Math.max(0, x));
      page.set(sh.png.data.subarray((sy * size + sx) * 4, (sy * size + sx) * 4 + 4), ((oy + y) * W + ox + x) * 4);
    }
  }
  tiles[sh.id] = [ox / W, oy / W, size / W].map((v) => +v.toFixed(6));
});
meshNode.extras.tiles = tiles;
const first = tiles[sheets[0].id];
if (tex.extensions?.KHR_texture_transform) tex.extensions.KHR_texture_transform = { offset: [first[0], first[1]], scale: [first[2], first[2]] };

// rebuild the binary view by view, the page swapped in
const pagePng = encodePng(W, W, page);
const chunks = [];
let offset = 0;
json.bufferViews.forEach((bv, i) => {
  const bytes = i === image.bufferView ? pagePng : bin.subarray(bv.byteOffset ?? 0, (bv.byteOffset ?? 0) + bv.byteLength);
  const pad = (4 - (offset % 4)) % 4;
  if (pad) chunks.push(Buffer.alloc(pad)), (offset += pad);
  chunks.push(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.length));
  bv.byteOffset = offset;
  bv.byteLength = bytes.length;
  offset += bytes.length;
});
const newBin = Buffer.concat(chunks);
const binPadded = Buffer.concat([newBin, Buffer.alloc((4 - (newBin.length % 4)) % 4)]);
json.buffers[0].byteLength = binPadded.length;
let js = Buffer.from(JSON.stringify(json));
js = Buffer.concat([js, Buffer.alloc((4 - (js.length % 4)) % 4, 0x20)]);
const header = Buffer.alloc(12);
header.writeUInt32LE(0x46546c67, 0);
header.writeUInt32LE(2, 4);
header.writeUInt32LE(12 + 8 + js.length + 8 + binPadded.length, 8);
const jsHead = Buffer.alloc(8);
jsHead.writeUInt32LE(js.length, 0);
jsHead.writeUInt32LE(0x4e4f534a, 4);
const binHead = Buffer.alloc(8);
binHead.writeUInt32LE(binPadded.length, 0);
binHead.writeUInt32LE(0x004e4942, 4);
fs.writeFileSync(glbPath, Buffer.concat([header, jsHead, js, binHead, binPadded]));
console.log(`body-page: ${sheets.length} sheets on a ${W}x${W} page -> ${path.relative(process.cwd(), glbPath)}`);

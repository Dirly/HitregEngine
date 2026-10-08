#!/usr/bin/env node
/**
 * Build a role-separated tree GLB variant from independent Bark and Leaves
 * sheets. A square, two-cell atlas is generated with the project's shared page
 * grid. Source images are downsampled proportionally into padded cells and the
 * GLB's UV accessors are remapped into those cells; the source GLB is untouched.
 *
 * Example:
 * node tools/tree-variant.mjs --model projects/voxel-demo/assets/models/purchased/nature/pine_tree_n_3.glb \
 *   --bark projects/voxel-demo/assets/textures/purchased/nature/pine_bark_1_winter.png \
 *   --foliage projects/voxel-demo/assets/textures/purchased/nature/pine_branch_2_snowy.png \
 *   --name pine_tree_snow --out projects/voxel-demo/assets/models/purchased/nature/pine_tree_snow.glb \
 *   --atlas projects/voxel-demo/assets/textures/purchased/nature/pine_tree_snow_atlas.png \
 *   --manifest projects/voxel-demo/authoring/purchased-assets/pine-tree-snow.json
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { inflateSync } from 'node:zlib';
import { decodePng, encodePng } from './_png.mjs';
import { assertSquarePage, squareGrid } from './_page.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const PLAYGROUND = path.resolve(here, '..');
function parseArgs(argv) {
  const args = {}; let key = null;
  for (const arg of argv) {
    if (arg.startsWith('--')) { key = arg.slice(2); args[key] = true; }
    else if (key) args[key] = args[key] === true ? arg : [].concat(args[key], arg);
  }
  return args;
}
const args = parseArgs(process.argv.slice(2));
const required = ['model', 'bark', 'foliage', 'name', 'out', 'atlas', 'manifest'];
for (const k of required) if (!args[k] || args[k] === true) throw new Error(`Missing --${k}`);
const resolve = (p) => path.resolve(String(p));
const modelPath = resolve(args.model), barkPath = resolve(args.bark), foliagePath = resolve(args.foliage);
const outPath = resolve(args.out), atlasPath = resolve(args.atlas), manifestPath = resolve(args.manifest);
const tileSize = Number(args['tile-size'] && args['tile-size'] !== true ? args['tile-size'] : 256);
const pad = Number(args.pad && args.pad !== true ? args.pad : 8);
if (!Number.isInteger(tileSize) || tileSize < 32 || !Number.isInteger(pad) || pad < 1) throw new Error('Invalid tile size or pad');
for (const p of [modelPath, barkPath, foliagePath]) if (!fs.existsSync(p)) throw new Error(`Missing input ${p}`);
const outputs = new Set([outPath, atlasPath, manifestPath]);
if (outputs.size !== 3 || [modelPath, barkPath, foliagePath].some(p => outputs.has(p))) throw new Error('Output paths must be distinct from each other and from every input');

const hash = (buf) => createHash('sha256').update(buf).digest('hex');
function decodeInputPng(buffer) {
  if (buffer[24] === 8) return decodePng(buffer);
  // The purchased winter bark PNG is 16-bit RGBA. Reduce to the high byte
  // deterministically, which is sufficient for this PSX-resolution material.
  if (buffer[24] !== 16 || buffer[25] !== 6 || buffer[28] !== 0) throw new Error('Only 8-bit PNGs or non-interlaced 16-bit RGBA are supported');
  let pos = 8, width, height; const chunks = [];
  while (pos < buffer.length) {
    const length = buffer.readUInt32BE(pos), type = buffer.toString('ascii', pos + 4, pos + 8), body = buffer.subarray(pos + 8, pos + 8 + length);
    if (type === 'IHDR') { width = body.readUInt32BE(0); height = body.readUInt32BE(4); }
    if (type === 'IDAT') chunks.push(body);
    pos += 12 + length;
    if (type === 'IEND') break;
  }
  const bpp = 8, rowBytes = width * bpp, raw = inflateSync(Buffer.concat(chunks));
  const bytes = new Uint8Array(height * rowBytes); let r = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[r++], row = y * rowBytes, prev = row - rowBytes;
    for (let x = 0; x < rowBytes; x++) {
      const q = raw[r + x], a = x >= bpp ? bytes[row + x - bpp] : 0, b = y ? bytes[prev + x] : 0, c = x >= bpp && y ? bytes[prev + x - bpp] : 0;
      let v;
      if (filter === 0) v = q;
      else if (filter === 1) v = q + a;
      else if (filter === 2) v = q + b;
      else if (filter === 3) v = q + ((a + b) >> 1);
      else if (filter === 4) { const p = a + b - c, pa = Math.abs(p-a), pb = Math.abs(p-b), pc = Math.abs(p-c); v = q + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c); }
      else throw new Error(`Unknown PNG filter ${filter}`);
      bytes[row + x] = v & 255;
    }
    r += rowBytes;
  }
  const data = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height * 4; i++) data[i] = bytes[i * 2];
  return { width, height, data };
}

function nearestScale(image, maxW, maxH) {
  const ratio = Math.min(1, maxW / image.width, maxH / image.height);
  const width = Math.max(1, Math.floor(image.width * ratio));
  const height = Math.max(1, Math.floor(image.height * ratio));
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const sx = Math.min(image.width - 1, Math.floor((x + 0.5) * image.width / width));
    const sy = Math.min(image.height - 1, Math.floor((y + 0.5) * image.height / height));
    const si = (sy * image.width + sx) * 4, di = (y * width + x) * 4;
    data.set(image.data.subarray(si, si + 4), di);
  }
  return { width, height, data };
}
const barkPng = decodeInputPng(fs.readFileSync(barkPath));
const foliagePng = decodeInputPng(fs.readFileSync(foliagePath));
const { cols, rows, stride, W, H } = squareGrid(2, tileSize, pad);
assertSquarePage(W, H, 'tree variant atlas');
const atlas = new Uint8Array(W * H * 4);
const inputs = [
  { role: 'Bark', source: barkPng, x: pad, y: pad },
  { role: 'Leaves', source: foliagePng, x: stride + pad, y: pad },
];
const tiles = {};
for (const item of inputs) {
  const scaled = nearestScale(item.source, tileSize, tileSize);
  const x = item.x + Math.floor((tileSize - scaled.width) / 2);
  const y = item.y + Math.floor((tileSize - scaled.height) / 2);
  // Dilate edge texels into the gutter to prevent mip bleed while preserving alpha.
  for (let gy = -pad; gy < scaled.height + pad; gy++) for (let gx = -pad; gx < scaled.width + pad; gx++) {
    const sx = Math.max(0, Math.min(scaled.width - 1, gx));
    const sy = Math.max(0, Math.min(scaled.height - 1, gy));
    const si = (sy * scaled.width + sx) * 4;
    const di = ((y + gy) * W + x + gx) * 4;
    if (x + gx < 0 || x + gx >= W || y + gy < 0 || y + gy >= H) continue;
    atlas.set(scaled.data.subarray(si, si + 4), di);
  }
  tiles[item.role] = {
    offset: [x / W, y / H],
    scale: [scaled.width / W, scaled.height / H],
    sourceSize: [item.source.width, item.source.height],
    scaledSize: [scaled.width, scaled.height],
    alphaPixels: Array.from({ length: scaled.width * scaled.height }, (_, i) => scaled.data[i * 4 + 3]).filter(a => a > 0).length,
  };
}
fs.mkdirSync(path.dirname(atlasPath), { recursive: true });
fs.writeFileSync(atlasPath, encodePng(W, H, atlas));

function parseGlb(file) {
  const b = fs.readFileSync(file);
  if (b.readUInt32LE(0) !== 0x46546c67 || b.readUInt32LE(4) !== 2) throw new Error('Expected GLB 2.0');
  let off = 12, doc, bin;
  while (off < b.length) {
    const len = b.readUInt32LE(off), type = b.readUInt32LE(off + 4), body = b.subarray(off + 8, off + 8 + len);
    if (type === 0x4e4f534a) doc = JSON.parse(body.toString('utf8').trim());
    else if (type === 0x004e4942) bin = Buffer.from(body);
    off += 8 + len;
  }
  if (!doc || !bin) throw new Error('GLB needs JSON and BIN chunks');
  return { doc, bin };
}
function packGlb(doc, bin) {
  while (bin.length % 4) bin = Buffer.concat([bin, Buffer.from([0])]);
  doc.buffers[0].byteLength = bin.length;
  let json = Buffer.from(JSON.stringify(doc));
  while (json.length % 4) json = Buffer.concat([json, Buffer.from([0x20])]);
  const out = Buffer.alloc(12 + 8 + json.length + 8 + bin.length);
  out.writeUInt32LE(0x46546c67, 0); out.writeUInt32LE(2, 4); out.writeUInt32LE(out.length, 8);
  out.writeUInt32LE(json.length, 12); out.writeUInt32LE(0x4e4f534a, 16); json.copy(out, 20);
  const p = 20 + json.length; out.writeUInt32LE(bin.length, p); out.writeUInt32LE(0x004e4942, p + 4); bin.copy(out, p + 8);
  return out;
}
const { doc, bin: originalBin } = parseGlb(modelPath);
let bin = Buffer.from(originalBin);
const bRole = doc.materials.findIndex(m => /^bark(?:\.\d+)?$/i.test(m.name ?? ''));
const lRole = doc.materials.findIndex(m => /^(?:leaves|foliage)(?:\.\d+)?$/i.test(m.name ?? ''));
if (bRole < 0 || lRole < 0) throw new Error('Input GLB must have separate Bark and Leaves material slots');
const COMPONENTS = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 };
const TYPE_BYTES = { 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 };
function readAccessor(index) {
  const accessor = doc.accessors[index], view = doc.bufferViews[accessor.bufferView];
  if (!accessor || !view || !COMPONENTS[accessor.type] || !TYPE_BYTES[accessor.componentType]) throw new Error(`Unsupported accessor ${index}`);
  if (accessor.sparse) throw new Error(`Sparse accessor ${index} is not supported`);
  const compBytes = TYPE_BYTES[accessor.componentType], count = COMPONENTS[accessor.type];
  const stride = view.byteStride ?? compBytes * count, start = (view.byteOffset ?? 0) + (accessor.byteOffset ?? 0);
  const readAt = (offset) => accessor.componentType === 5126 ? originalBin.readFloatLE(offset)
    : accessor.componentType === 5125 ? originalBin.readUInt32LE(offset)
      : accessor.componentType === 5123 ? originalBin.readUInt16LE(offset)
        : accessor.componentType === 5122 ? originalBin.readInt16LE(offset)
          : accessor.componentType === 5121 ? originalBin.readUInt8(offset) : originalBin.readInt8(offset);
  const values = [];
  for (let i = 0; i < accessor.count; i++) {
    const row = [];
    for (let j = 0; j < count; j++) {
      let value = readAt(start + i * stride + j * compBytes);
      if (accessor.normalized) value = accessor.componentType === 5120 ? Math.max(value / 127, -1)
        : accessor.componentType === 5122 ? Math.max(value / 32767, -1)
          : value / (accessor.componentType === 5121 ? 255 : accessor.componentType === 5123 ? 65535 : 4294967295);
      row.push(value);
    }
    values.push(row);
  }
  return { values, type: accessor.type, count };
}
function writeAttribute(values, type) {
  while (bin.length % 4) bin = Buffer.concat([bin, Buffer.from([0])]);
  const byteOffset = bin.length, bytes = Buffer.alloc(values.length * values[0].length * 4);
  values.forEach((row, i) => row.forEach((v, j) => bytes.writeFloatLE(v, (i * row.length + j) * 4)));
  bin = Buffer.concat([bin, bytes]);
  doc.bufferViews.push({ buffer: 0, byteOffset, byteLength: bytes.length });
  const flat = values.flat(), count = values[0].length;
  doc.accessors.push({ bufferView: doc.bufferViews.length - 1, componentType: 5126, count: values.length, type, min: Array.from({ length: count }, (_, j) => Math.min(...values.map(v => v[j]))), max: Array.from({ length: count }, (_, j) => Math.max(...values.map(v => v[j]))) });
  return doc.accessors.length - 1;
}
function clip(poly, axis, bound, keepGreater) {
  const out = [];
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length], da = a.attrs.TEXCOORD_0[axis] - bound, db = b.attrs.TEXCOORD_0[axis] - bound;
    const ain = keepGreater ? da >= -1e-8 : da <= 1e-8, bin = keepGreater ? db >= -1e-8 : db <= 1e-8;
    if (ain) out.push(a);
    if (ain !== bin) {
      const t = da / (da - db), attrs = {};
      for (const key of Object.keys(a.attrs)) attrs[key] = a.attrs[key].map((v, c) => v + (b.attrs[key][c] - v) * t);
      out.push({ attrs });
    }
  }
  return out;
}
function splitTriangle(tri) {
  const uv = tri.map(v => v.attrs.TEXCOORD_0);
  const u0 = Math.floor(Math.min(...uv.map(v => v[0]))), u1 = Math.floor(Math.max(...uv.map(v => v[0])) - 1e-8);
  let v0 = Math.floor(Math.min(...uv.map(v => v[1]))), v1 = Math.floor(Math.max(...uv.map(v => v[1])) - 1e-8);
  let fixedU1 = u1;
  if (fixedU1 < u0) fixedU1 = u0;
  if (v1 < v0) v1 = v0;
  const out = [];
  for (let u = u0; u <= fixedU1; u++) for (let v = v0; v <= v1; v++) {
    let poly = clip(tri, 0, u, true); poly = clip(poly, 0, u + 1, false);
    poly = clip(poly, 1, v, true); poly = clip(poly, 1, v + 1, false);
    if (poly.length >= 3) out.push({ cell: [u, v], poly });
  }
  return out;
}
let sourceTriangles = 0, outputTriangles = 0, uvRanges = {}, areaBefore = 0, areaAfter = 0, maxTileUVError = 0;
if (doc.skins?.length || doc.animations?.length) throw new Error('Only static, unskinned trees are supported');
for (const m of doc.materials) if (m.normalTexture || m.occlusionTexture || m.emissiveTexture) throw new Error('Only base-color texture variants are supported');
for (const mesh of doc.meshes ?? []) for (const primitive of mesh.primitives ?? []) {
  const material = primitive.material;
  if (material !== bRole && material !== lRole) continue;
  if (primitive.mode !== undefined && primitive.mode !== 4) throw new Error('Tree variant currently requires triangle-list primitives');
  const attrs = {};
  for (const [key, accessor] of Object.entries(primitive.attributes)) {
    if (['JOINTS_0', 'JOINTS_1', 'WEIGHTS_0', 'WEIGHTS_1'].includes(key)) throw new Error('Skinned trees are not supported');
    attrs[key] = readAccessor(accessor);
  }
  const uvData = attrs.TEXCOORD_0;
  if (!uvData || uvData.type !== 'VEC2') throw new Error(`Material ${doc.materials[material].name} needs UV0`);
  const indices = primitive.indices === undefined ? Array.from({ length: uvData.values.length }, (_, i) => i) : readAccessor(primitive.indices).values.map(v => v[0]);
  if (indices.length % 3) throw new Error('Triangle-list index count is not divisible by 3');
  const tile = tiles[material === bRole ? 'Bark' : 'Leaves'];
  const range = { minU: Infinity, maxU: -Infinity, minV: Infinity, maxV: -Infinity };
  const outAttrs = Object.fromEntries(Object.keys(attrs).map(k => [k, []]));
  const position = attrs.POSITION;
  if (!position || position.type !== 'VEC3') throw new Error('Tree primitive must have POSITION VEC3');
  const triArea = (a, b, c) => {
    const ab = b.map((v, i) => v - a[i]), ac = c.map((v, i) => v - a[i]);
    const cross = [ab[1]*ac[2]-ab[2]*ac[1], ab[2]*ac[0]-ab[0]*ac[2], ab[0]*ac[1]-ab[1]*ac[0]];
    return Math.hypot(...cross) * .5;
  };
  for (let t = 0; t < indices.length; t += 3) {
    sourceTriangles++;
    const tri = [0, 1, 2].map(c => ({ attrs: Object.fromEntries(Object.entries(attrs).map(([key, a]) => [key, [...a.values[indices[t + c]]]])) }));
    areaBefore += triArea(...tri.map(v => v.attrs.POSITION));
    for (const vert of tri) { const [u, v] = vert.attrs.TEXCOORD_0; range.minU = Math.min(range.minU,u); range.maxU = Math.max(range.maxU,u); range.minV = Math.min(range.minV,v); range.maxV = Math.max(range.maxV,v); }
    const pieces = splitTriangle(tri);
    for (const piece of pieces) {
      const poly = piece.poly.map(point => {
        const copy = structuredClone(point.attrs), [u, v] = copy.TEXCOORD_0;
        copy.TEXCOORD_0 = [tile.offset[0] + (u - piece.cell[0]) * tile.scale[0], tile.offset[1] + (v - piece.cell[1]) * tile.scale[1]];
        for (let axis = 0; axis < 2; axis++) maxTileUVError = Math.max(maxTileUVError, Math.max(tile.offset[axis] - copy.TEXCOORD_0[axis], copy.TEXCOORD_0[axis] - (tile.offset[axis] + tile.scale[axis]), 0));
        if (copy.NORMAL) { const n = Math.hypot(...copy.NORMAL) || 1; copy.NORMAL = copy.NORMAL.map(x => x / n); }
        if (copy.TANGENT) { const n = Math.hypot(copy.TANGENT[0], copy.TANGENT[1], copy.TANGENT[2]) || 1; copy.TANGENT = [copy.TANGENT[0]/n,copy.TANGENT[1]/n,copy.TANGENT[2]/n,copy.TANGENT[3]]; }
        return copy;
      });
      for (let i = 1; i + 1 < poly.length; i++) {
        areaAfter += triArea(poly[0].POSITION, poly[i].POSITION, poly[i + 1].POSITION);
        for (const vert of [poly[0], poly[i], poly[i + 1]]) for (const key of Object.keys(attrs)) outAttrs[key].push(vert[key]);
      }
      outputTriangles += poly.length - 2;
    }
  }
  uvRanges[doc.materials[material].name] = range;
  for (const [key, values] of Object.entries(outAttrs)) primitive.attributes[key] = writeAttribute(values, attrs[key].type);
  delete primitive.indices;
  primitive.mode = 4;
}
const areaError = Math.abs(areaAfter - areaBefore) / Math.max(1e-12, areaBefore);
if (!sourceTriangles || !outputTriangles || areaError > 1e-5) throw new Error(`Geometry-area conservation failed (${areaBefore} -> ${areaAfter}, rel=${areaError})`);
if (maxTileUVError > 1e-6) throw new Error(`Output UV escaped its role tile by ${maxTileUVError}`);

const pngBytes = fs.readFileSync(atlasPath);
while (bin.length % 4) bin = Buffer.concat([bin, Buffer.from([0])]);
const imageOffset = bin.length;
bin = Buffer.concat([bin, pngBytes]);
doc.bufferViews.push({ buffer: 0, byteOffset: imageOffset, byteLength: pngBytes.length });
const imageIndex = (doc.images ??= []).push({ name: path.basename(atlasPath).replace(/\.png$/i, ''), bufferView: doc.bufferViews.length - 1, mimeType: 'image/png' }) - 1;
const sampler = doc.textures?.[0]?.sampler;
doc.textures.push({ source: imageIndex, ...(sampler === undefined ? {} : { sampler }) });
const textureIndex = doc.textures.length - 1;
const sourceAlphaModes = { Bark: doc.materials[bRole].alphaMode ?? 'OPAQUE', Leaves: doc.materials[lRole].alphaMode ?? 'OPAQUE' };
for (const [index, name] of [[bRole, 'Bark'], [lRole, 'Leaves']]) {
  const material = doc.materials[index];
  material.name = name;
  material.alphaMode = sourceAlphaModes[name];
  material.pbrMetallicRoughness ??= {};
  material.pbrMetallicRoughness.baseColorTexture = { index: textureIndex, texCoord: 0 };
}
doc.extras = { ...(doc.extras ?? {}), treeVariant: { name: String(args.name), roles: ['Bark', 'Leaves'], atlas: path.basename(atlasPath), tiles, alphaPreserved: true } };
const outputBytes = packGlb(doc, bin);
fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, outputBytes);
const report = {
  schemaVersion: 1,
  name: String(args.name),
  source: path.relative(PLAYGROUND, modelPath).replaceAll('\\', '/'),
  sourceSha256: hash(fs.readFileSync(modelPath)),
  barkSource: path.relative(PLAYGROUND, barkPath).replaceAll('\\', '/'),
  barkSha256: hash(fs.readFileSync(barkPath)),
  foliageSource: path.relative(PLAYGROUND, foliagePath).replaceAll('\\', '/'),
  foliageSha256: hash(fs.readFileSync(foliagePath)),
  model: path.relative(PLAYGROUND, outPath).replaceAll('\\', '/'),
  modelSha256: hash(outputBytes),
  atlas: path.relative(PLAYGROUND, atlasPath).replaceAll('\\', '/'),
  atlasSha256: hash(pngBytes),
  atlasSize: [W, H],
  tileSize,
  pad,
  grid: [cols, rows],
  tiles,
  materialRoles: { Bark: { alphaMode: sourceAlphaModes.Bark }, Leaves: { alphaMode: sourceAlphaModes.Leaves, alphaPixels: tiles.Leaves.alphaPixels } },
  sourceTriangles,
  outputTriangles,
  geometryArea: { before: areaBefore, after: areaAfter, relativeError: areaError },
  maxTileUVError,
  uvRanges,
  uvRemap: 'Triangles are split at integer UV repeat seams, then each repeat maps into its padded role tile; source UV repeat and image aspect ratios are retained.',
};
fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
fs.writeFileSync(manifestPath, JSON.stringify(report, null, 2) + '\n', 'utf8');
console.log(JSON.stringify(report, null, 2));

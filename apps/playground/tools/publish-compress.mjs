// Shrink a published bundle in place, changing no pixel and no vertex. Run by tools/publish.mjs; alone:
//   node tools/publish-compress.mjs <bundle dir> [--no-meshopt] [--no-precompress]
//
// It only ever touches the bundle: the source projects are read by export-game and never written here.
//
// Owner ruling 2026-11-05: the game's look is low-res nearest-neighbour art and must stay EXACTLY the same. So there is
// no lossy path here and there must never be one: no ETC1S/UASTC, no lossy WebP, no resizing, no mip or sampler change,
// no quantised UVs or positions. KTX2 was measured and dropped (docs/hosting.md, "What publish compresses").
//
//  1. Models. Kit tools embed the same atlas in every file: 945 MB of images across the redstrand closure's models are
//     109 MB of distinct files. An image used by two or more models moves to content/shared/<hash>.<ext>, fetched once;
//     a .gltf's base64 buffers become a binary chunk. A .gltf path then holds GLB bytes: GLTFLoader reads the magic, not
//     the extension, so no reference anywhere changes.
//  2. Geometry. EXT_meshopt_compression with no filter and no quantisation: bit-exact, every view decodes to its source
//     bytes. Brotli alone beats meshopt + brotli on this repetitive low-poly data, so a model's .br sidecar holds
//     whichever form is smaller: the plain file serves hosts that compress nothing, the sidecar serves hosts that do.
//  3. PNGs. Re-encoded (indexed when <= 256 colours, else best filter) only if smaller and only if the decoded RGBA is
//     byte-identical. A PNG whose colour chunks a browser would act on keeps its original bytes.
//  4. Sidecars: <file>.br and, for code and JSON, <file>.gz, for hosts that serve precompressed files (deploy/Caddyfile).
//
// Every model is re-read after writing and proven against its source; a failure aborts the publish.
import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, extname, join, posix, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import zlib from "node:zlib";
import sharp from "sharp";

const HERE = dirname(fileURLToPath(import.meta.url));
// meshoptimizer is @hitreg/render's dependency, not the playground's
const renderRequire = createRequire(join(HERE, "../../../packages/render/package.json"));
const { MeshoptEncoder, MeshoptDecoder } = await import(pathToFileURL(renderRequire.resolve("meshoptimizer")).href);

const brotli = promisify(zlib.brotliCompress);
const gzip = promisify(zlib.gzip);
const GLB_MAGIC = 0x46546c67;
const CHUNK_JSON = 0x4e4f534a;
const CHUNK_BIN = 0x004e4942;
const MESHOPT = "EXT_meshopt_compression";
const COMPONENT_BYTES = { 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 };
const COMPONENTS = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT2: 4, MAT3: 9, MAT4: 16 };
/** Disk-heavy batch work disturbs other agents' timing runs: keep it modest. */
const POOL = 3;

const sha = (bytes) => createHash("sha256").update(bytes).digest("hex").slice(0, 32);
const align4 = (n) => (n + 3) & ~3;

async function pool(items, work, width = POOL) {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(width, items.length) }, async () => {
    while (next < items.length) { const i = next++; await work(items[i], i); }
  }));
}

function walk(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]);
}

// ---- glTF container ------------------------------------------------------------------------------------------------

/** { json, buffers } of a .glb or .gltf, or null when it is neither. A non-data buffer uri stays a null entry. */
export function readGltf(bytes) {
  try {
    let json, bin = null;
    if (bytes.length >= 20 && bytes.readUInt32LE(0) === GLB_MAGIC) {
      const jsonLength = bytes.readUInt32LE(12);
      json = JSON.parse(bytes.toString("utf8", 20, 20 + jsonLength));
      const at = 20 + align4(jsonLength);
      if (at + 8 <= bytes.length && bytes.readUInt32LE(at + 4) === CHUNK_BIN) bin = bytes.subarray(at + 8, at + 8 + bytes.readUInt32LE(at));
    } else json = JSON.parse(bytes.toString("utf8"));
    const buffers = (json.buffers ?? []).map((b) => {
      if (b.uri?.startsWith("data:")) return Buffer.from(b.uri.slice(b.uri.indexOf(",") + 1), "base64");
      return b.uri ? null : b.extensions?.[MESHOPT]?.fallback ? null : bin;
    });
    return { json, buffers };
  } catch {
    return null;
  }
}

function writeGlb(json, bin) {
  const text = Buffer.from(JSON.stringify(json), "utf8");
  const jsonLength = align4(text.length);
  const binLength = align4(bin.length);
  const out = Buffer.alloc(12 + 8 + jsonLength + (binLength ? 8 + binLength : 0), 0);
  out.writeUInt32LE(GLB_MAGIC, 0);
  out.writeUInt32LE(2, 4);
  out.writeUInt32LE(out.length, 8);
  out.writeUInt32LE(jsonLength, 12);
  out.writeUInt32LE(CHUNK_JSON, 16);
  text.copy(out, 20);
  out.fill(0x20, 20 + text.length, 20 + jsonLength);
  if (binLength) {
    const at = 20 + jsonLength;
    out.writeUInt32LE(binLength, at);
    out.writeUInt32LE(CHUNK_BIN, at + 4);
    bin.copy(out, at + 8);
  }
  return out;
}

const viewBytes = (gltf, index) => {
  const view = gltf.json.bufferViews[index];
  const offset = view.byteOffset ?? 0;
  return gltf.buffers[view.buffer].subarray(offset, offset + view.byteLength);
};

/** The encoded bytes of one image, with its media type. Null for an external file. */
export function imageBytes(gltf, image) {
  if (image.uri?.startsWith("data:")) {
    return { bytes: Buffer.from(image.uri.slice(image.uri.indexOf(",") + 1), "base64"), mimeType: image.mimeType ?? image.uri.slice(5, image.uri.search(/[;,]/)) };
  }
  if (image.bufferView !== undefined) return { bytes: viewBytes(gltf, image.bufferView), mimeType: image.mimeType };
  return null;
}

/** Only files whose every buffer we hold can be rewritten; a draco file or an external .bin ships as it came. */
function canRepack(gltf) {
  if (!gltf) return false;
  if (gltf.buffers.some((b) => !b)) return false;
  if ((gltf.json.images ?? []).some((i) => !i.uri?.startsWith("data:") && i.bufferView === undefined)) return false;
  return !(gltf.json.extensionsUsed ?? []).some((e) => e === MESHOPT || e === "KHR_draco_mesh_compression");
}

/**
 * How meshopt may encode each bufferView, by index: a view holding exactly one tightly described accessor. Anything
 * else (a shared view, an animation-sparse view, u8 indices, a stride the codec refuses) stays raw.
 */
function meshoptPlans(json) {
  const indices = new Set();
  for (const mesh of json.meshes ?? []) for (const p of mesh.primitives ?? []) if (p.indices !== undefined) indices.add(p.indices);
  const sparse = new Set();
  const users = new Map();
  (json.accessors ?? []).forEach((a, i) => {
    if (a.sparse) { sparse.add(a.sparse.indices.bufferView); sparse.add(a.sparse.values.bufferView); }
    if (a.bufferView === undefined) return;
    const list = users.get(a.bufferView);
    if (list) list.push(i); else users.set(a.bufferView, [i]);
  });
  const plans = new Map();
  for (const [viewIndex, list] of users) {
    if (list.length !== 1 || sparse.has(viewIndex)) continue;
    const accessor = json.accessors[list[0]];
    const view = json.bufferViews[viewIndex];
    if ((accessor.byteOffset ?? 0) !== 0) continue;
    const element = COMPONENT_BYTES[accessor.componentType] * COMPONENTS[accessor.type];
    const stride = view.byteStride ?? element;
    if (view.byteLength !== stride * accessor.count) continue;
    if (indices.has(list[0])) {
      // INDICES, not TRIANGLES: TRIANGLES may rotate a triangle's corners, and this path changes nothing
      if (element === 2 || element === 4) plans.set(viewIndex, { mode: "INDICES", stride: element, count: accessor.count });
    } else if (stride % 4 === 0 && stride <= 256) plans.set(viewIndex, { mode: "ATTRIBUTES", stride, count: accessor.count });
  }
  return plans;
}

/**
 * Rebuild one model as a GLB. `place(bytes, mimeType)` answers { uri } to reference a shared file or { bytes } to embed.
 * Only bufferViews, buffers, images and the accessors' view numbers change; the rest of the JSON is carried verbatim.
 */
export function repackModel(gltf, place, { meshopt }) {
  const json = structuredClone(gltf.json);
  const imageViews = new Set((json.images ?? []).map((i) => i.bufferView).filter((v) => v !== undefined));
  const plans = meshopt ? meshoptPlans(json) : new Map();
  const chunks = [];
  let binLength = 0;
  const add = (bytes) => {
    const at = binLength;
    chunks.push(bytes);
    const padded = align4(bytes.length);
    if (padded !== bytes.length) chunks.push(Buffer.alloc(padded - bytes.length));
    binLength += padded;
    return at;
  };
  const views = [];
  const renumber = new Map();
  let fallbackLength = 0;
  (json.bufferViews ?? []).forEach((view, index) => {
    if (imageViews.has(index)) return;
    const data = viewBytes(gltf, index);
    const plan = plans.get(index);
    const encoded = plan ? Buffer.from(MeshoptEncoder.encodeGltfBuffer(new Uint8Array(data), plan.count, plan.stride, plan.mode, 0)) : null;
    renumber.set(index, views.length);
    if (encoded && encoded.length < data.length) {
      const at = add(encoded);
      views.push({
        ...view,
        buffer: 1,
        byteOffset: fallbackLength,
        extensions: { ...view.extensions, [MESHOPT]: { buffer: 0, byteOffset: at, byteLength: encoded.length, byteStride: plan.stride, mode: plan.mode, count: plan.count } },
      });
      fallbackLength += align4(data.length);
    } else views.push({ ...view, buffer: 0, byteOffset: add(data) });
  });
  for (const image of json.images ?? []) {
    const { bytes, mimeType } = imageBytes(gltf, image);
    const placed = place(bytes, mimeType);
    delete image.uri;
    delete image.bufferView;
    if (mimeType) image.mimeType = mimeType;
    if (placed.uri) image.uri = placed.uri;
    else {
      image.bufferView = views.length;
      views.push({ buffer: 0, byteOffset: add(placed.bytes), byteLength: placed.bytes.length });
    }
  }
  for (const accessor of json.accessors ?? []) {
    if (accessor.bufferView !== undefined) accessor.bufferView = renumber.get(accessor.bufferView);
    if (accessor.sparse) {
      accessor.sparse.indices.bufferView = renumber.get(accessor.sparse.indices.bufferView);
      accessor.sparse.values.bufferView = renumber.get(accessor.sparse.values.bufferView);
    }
  }
  if (views.length) json.bufferViews = views; else delete json.bufferViews;
  json.buffers = binLength ? [{ byteLength: binLength }] : [];
  if (fallbackLength) {
    json.buffers.push({ byteLength: fallbackLength, extensions: { [MESHOPT]: { fallback: true } } });
    json.extensionsUsed = [...(json.extensionsUsed ?? []), MESHOPT];
    json.extensionsRequired = [...(json.extensionsRequired ?? []), MESHOPT];
  }
  if (!json.buffers.length) delete json.buffers;
  return writeGlb(json, Buffer.concat(chunks));
}

/** The decoded bytes of an output bufferView (meshopt or plain). */
function outputView(gltf, index) {
  const view = gltf.json.bufferViews[index];
  const ext = view.extensions?.[MESHOPT];
  if (!ext) return viewBytes(gltf, index);
  const target = new Uint8Array(ext.count * ext.byteStride);
  const source = new Uint8Array(gltf.buffers[ext.buffer].subarray(ext.byteOffset, ext.byteOffset + ext.byteLength));
  MeshoptDecoder.decodeGltfBuffer(target, ext.count, ext.byteStride, source, ext.mode);
  return Buffer.from(target);
}

/**
 * Prove an output model equals its source: the same JSON outside the rewritten tables, every accessor and animation byte
 * identical after decoding, every image resolving to a file `resolveImage(image, gltf)` confirms. Returns the first
 * difference, or null.
 */
export function compareModel(source, output, sameImage) {
  const a = source.json, b = output.json;
  const skip = new Set(["bufferViews", "buffers", "images", "accessors", "extensionsUsed", "extensionsRequired"]);
  for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
    if (!skip.has(key) && JSON.stringify(a[key]) !== JSON.stringify(b[key])) return `json.${key} changed`;
  }
  const extensions = (j, k) => JSON.stringify((j[k] ?? []).filter((e) => e !== MESHOPT));
  if (extensions(a, "extensionsUsed") !== extensions(b, "extensionsUsed")) return "extensionsUsed changed";
  if (extensions(a, "extensionsRequired") !== extensions(b, "extensionsRequired")) return "extensionsRequired changed";
  const sameView = (i, j, what) => {
    if (i === undefined && j === undefined) return null;
    if (i === undefined || j === undefined) return `${what}: view dropped`;
    const va = a.bufferViews[i], vb = b.bufferViews[j];
    if ((va.byteStride ?? 0) !== (vb.byteStride ?? 0) || (va.target ?? 0) !== (vb.target ?? 0)) return `${what}: view layout changed`;
    return viewBytes(source, i).equals(outputView(output, j)) ? null : `${what}: bytes differ`;
  };
  if ((a.accessors?.length ?? 0) !== (b.accessors?.length ?? 0)) return "accessor count changed";
  for (let i = 0; i < (a.accessors?.length ?? 0); i++) {
    const { bufferView: va, sparse: sa, ...restA } = a.accessors[i];
    const { bufferView: vb, sparse: sb, ...restB } = b.accessors[i];
    if (JSON.stringify(restA) !== JSON.stringify(restB)) return `accessor ${i} changed`;
    const problem = sameView(va, vb, `accessor ${i}`)
      ?? (sa ? sameView(sa.indices.bufferView, sb?.indices.bufferView, `accessor ${i} sparse indices`) ?? sameView(sa.values.bufferView, sb?.values.bufferView, `accessor ${i} sparse values`) : null);
    if (problem) return problem;
  }
  if ((a.images?.length ?? 0) !== (b.images?.length ?? 0)) return "image count changed";
  for (let i = 0; i < (a.images?.length ?? 0); i++) {
    if ((a.images[i].name ?? "") !== (b.images[i].name ?? "")) return `image ${i} renamed`;
    if (!sameImage(imageBytes(source, a.images[i]).bytes, b.images[i], output)) return `image ${i} differs`;
  }
  return null;
}

// ---- PNG -----------------------------------------------------------------------------------------------------------

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
/** Chunks that carry no pixels and that no browser uses to alter them. */
const INERT = new Set(["IHDR", "PLTE", "tRNS", "IDAT", "IEND", "pHYs", "tEXt", "zTXt", "iTXt", "tIME", "bKGD", "sRGB"]);

function pngChunks(bytes) {
  if (bytes.length < 8 || !bytes.subarray(0, 8).equals(PNG_SIGNATURE)) return null;
  const types = [];
  for (let at = 8; at + 8 <= bytes.length;) {
    const length = bytes.readUInt32BE(at);
    const type = bytes.toString("latin1", at + 4, at + 8);
    types.push(type);
    at += 12 + length;
    if (type === "IEND") break;
  }
  return types;
}

/**
 * May this PNG be re-encoded? The pixels a browser shows must not depend on what we drop. gAMA/cHRM/iCCP change colours
 * on the <img> path (three's TextureLoader), so a file with one keeps its bytes unless an sRGB chunk overrides them. A
 * 16-bit file does not fit the 8-bit compare.
 */
function reencodable(bytes) {
  const types = pngChunks(bytes);
  if (!types || bytes[24] > 8) return false;
  const sRGB = types.includes("sRGB");
  return types.every((t) => INERT.has(t) || (sRGB && (t === "gAMA" || t === "cHRM")));
}

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function pngChunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, "latin1");
  data.copy(out, 8);
  let crc = 0xffffffff;
  for (let i = 4; i < 8 + data.length; i++) crc = crcTable[(crc ^ out[i]) & 0xff] ^ (crc >>> 8);
  out.writeUInt32BE((crc ^ 0xffffffff) >>> 0, 8 + data.length);
  return out;
}

/** An indexed PNG of RGBA pixels with at most 256 distinct colours, or null. sharp's palette path quantises, so not that. */
function indexedPng(rgba, width, height) {
  const slots = new Map();
  const palette = [];
  const pixels = new Uint32Array(Uint8Array.from(rgba).buffer); // a copy: a Buffer need not be 4-byte aligned
  const picks = new Uint8Array(pixels.length);
  for (let i = 0; i < pixels.length; i++) {
    let slot = slots.get(pixels[i]);
    if (slot === undefined) {
      if (palette.length === 256) return null;
      slot = palette.length;
      slots.set(pixels[i], slot);
      palette.push(pixels[i]);
    }
    picks[i] = slot;
  }
  // translucent entries first, so tRNS stops at the last one
  const order = palette.map((_, i) => i).sort((p, q) => (palette[p] >>> 24) - (palette[q] >>> 24));
  const remap = new Uint8Array(palette.length);
  order.forEach((old, next) => { remap[old] = next; });
  const depth = palette.length <= 2 ? 1 : palette.length <= 4 ? 2 : palette.length <= 16 ? 4 : 8;
  const rowBytes = Math.ceil((width * depth) / 8);
  const raw = Buffer.alloc((rowBytes + 1) * height);
  for (let y = 0; y < height; y++) {
    const row = y * (rowBytes + 1) + 1;
    for (let x = 0; x < width; x++) {
      const bit = x * depth;
      raw[row + (bit >> 3)] |= remap[picks[y * width + x]] << (8 - depth - (bit & 7));
    }
  }
  const plte = Buffer.alloc(palette.length * 3);
  const alpha = [];
  order.forEach((old, i) => {
    const c = palette[old];
    plte[i * 3] = c & 0xff;
    plte[i * 3 + 1] = (c >>> 8) & 0xff;
    plte[i * 3 + 2] = (c >>> 16) & 0xff;
    if (c >>> 24 !== 255) alpha.push(c >>> 24);
  });
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = depth;
  header[9] = 3;
  return Buffer.concat([
    PNG_SIGNATURE,
    pngChunk("IHDR", header),
    pngChunk("PLTE", plte),
    ...(alpha.length ? [pngChunk("tRNS", Buffer.from(alpha))] : []),
    pngChunk("IDAT", zlib.deflateSync(raw, { level: 9, memLevel: 9 })),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

const decodeRgba = (bytes) => sharp(bytes, { limitInputPixels: false }).toColourspace("srgb").ensureAlpha().raw().toBuffer({ resolveWithObject: true });

/** The smallest PNG whose decoded RGBA equals the input's byte for byte. Never lossy: a candidate that differs is thrown away. */
export async function optimizePng(bytes) {
  if (!reencodable(bytes)) return bytes;
  const { data, info } = await decodeRgba(bytes);
  if (info.channels !== 4) return bytes;
  let opaque = true;
  for (let i = 3; i < data.length && opaque; i += 4) opaque = data[i] === 255;
  const encoder = () => sharp(data, { raw: { width: info.width, height: info.height, channels: 4 } });
  const truecolour = (opaque ? encoder().removeAlpha() : encoder()).png({ compressionLevel: 9, adaptiveFiltering: true, palette: false });
  const candidates = [indexedPng(data, info.width, info.height), await truecolour.toBuffer()].filter(Boolean).sort((a, b) => a.length - b.length);
  for (const candidate of candidates) {
    if (candidate.length >= bytes.length) break;
    const decoded = await decodeRgba(candidate);
    if (decoded.info.width === info.width && decoded.info.height === info.height && decoded.data.equals(data)) return candidate;
  }
  return bytes;
}

const imageExtension = (bytes) => {
  if (bytes.subarray(0, 8).equals(PNG_SIGNATURE)) return "png";
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return "jpg";
  if (bytes.toString("latin1", 0, 4) === "RIFF") return "webp";
  return "bin";
};

// ---- the bundle ----------------------------------------------------------------------------------------------------

const SIDECAR_BROTLI = /\.(json|js|mjs|css|html|svg|wasm|glb|gltf)$/i;
const SIDECAR_GZIP = /\.(json|js|mjs|css|html|svg|wasm)$/i;
/** Brotli 11 costs minutes on the model set for a few percent; code and JSON are few and read by every player. */
const brotliOptions = (quality, size) => ({ params: { [zlib.constants.BROTLI_PARAM_QUALITY]: quality, [zlib.constants.BROTLI_PARAM_SIZE_HINT]: size } });

const writeAtomic = (file, bytes) => {
  const temp = `${file}.tmp`;
  writeFileSync(temp, bytes);
  renameSync(temp, file);
};

export async function compressBundle(bundle, { meshopt = true, precompress = true, log = console.log } = {}) {
  const root = resolve(bundle);
  const contentDir = join(root, "content");
  const modelsDir = join(contentDir, "models");
  await MeshoptEncoder.ready;
  await MeshoptDecoder.ready;
  sharp.concurrency(2);
  sharp.cache(false);
  const stats = { models: { files: 0, before: 0, after: 0, kept: 0 }, images: { distinct: 0, shared: 0, embeddedBefore: 0, stored: 0 }, png: { files: 0, before: 0, after: 0 }, sidecars: { files: 0, bytes: 0 }, verified: 0 };

  // pass 1: every embedded image, by content
  const modelFiles = walk(modelsDir).filter((f) => /\.(glb|gltf)$/i.test(f));
  const images = new Map();
  for (const file of modelFiles) {
    const gltf = readGltf(readFileSync(file));
    if (!canRepack(gltf)) continue;
    const seen = new Set();
    for (const image of gltf.json.images ?? []) {
      const { bytes, mimeType } = imageBytes(gltf, image);
      const key = sha(bytes);
      stats.images.embeddedBefore += bytes.length;
      const entry = images.get(key) ?? { bytes: Buffer.from(bytes), mimeType, users: 0 };
      if (!seen.has(key)) entry.users++;
      seen.add(key);
      images.set(key, entry);
    }
  }
  stats.images.distinct = images.size;
  log(`  ${modelFiles.length} models, ${images.size} distinct images in ${(stats.images.embeddedBefore / 1e6).toFixed(1)} MB of embedded copies`);

  // pass 2: lossless re-encode of each distinct image once; shared ones become files
  const sharedDir = join(contentDir, "shared");
  mkdirSync(sharedDir, { recursive: true });
  await pool([...images], async ([key, entry]) => {
    entry.out = imageExtension(entry.bytes) === "png" ? await optimizePng(entry.bytes) : entry.bytes;
    if (entry.users < 2) return;
    entry.file = `${key}.${imageExtension(entry.out)}`;
    writeFileSync(join(sharedDir, entry.file), entry.out);
    stats.images.shared++;
    stats.images.stored += entry.out.length;
  });

  // pass 3: rewrite, prove, write. Original bytes of an embedded image are compared by content key.
  const imageOf = (bytes) => images.get(sha(bytes));
  const failures = [];
  const sidecarOf = new Map();
  await pool(modelFiles, async (file) => {
    const original = readFileSync(file);
    const gltf = readGltf(original);
    stats.models.files++;
    stats.models.before += original.length;
    if (!canRepack(gltf)) {
      stats.models.kept++;
      stats.models.after += original.length;
      return;
    }
    const uriBase = relative(dirname(file), sharedDir).split("\\").join("/");
    const place = (bytes) => {
      const entry = imageOf(bytes);
      return entry.file ? { uri: posix.join(uriBase, entry.file) } : { bytes: entry.out };
    };
    const plain = repackModel(gltf, place, { meshopt: false });
    const packed = meshopt ? repackModel(gltf, place, { meshopt: true }) : plain;
    const sameImage = (sourceBytes, image, output) => {
      const entry = imageOf(sourceBytes);
      if (image.uri) return image.uri === posix.join(uriBase, entry.file ?? "?");
      return viewBytes(output, image.bufferView).equals(entry.out);
    };
    for (const candidate of packed === plain ? [plain] : [plain, packed]) {
      const problem = compareModel(gltf, readGltf(candidate), sameImage);
      if (problem) { failures.push(`${relative(root, file)}: ${problem}`); return; }
    }
    stats.verified++;
    const best = packed.length < plain.length ? packed : plain;
    stats.models.after += best.length;
    writeAtomic(file, best);
    if (precompress) {
      const forms = await Promise.all((best === plain ? [plain] : [plain, best]).map((x) => brotli(x, brotliOptions(9, x.length))));
      const smallest = forms.reduce((x, y) => (y.length < x.length ? y : x));
      if (smallest.length < best.length * 0.95) sidecarOf.set(file, smallest);
    }
  });
  if (failures.length) throw new Error(`publish-compress: ${failures.length} model(s) would change:\n${failures.slice(0, 20).join("\n")}`);
  for (const [file, bytes] of sidecarOf) {
    writeFileSync(`${file}.br`, bytes);
    stats.sidecars.files++;
    stats.sidecars.bytes += bytes.length;
  }

  // loose PNGs (material maps, sprite sheets, maps, loading art)
  const pngs = walk(contentDir).filter((f) => extname(f).toLowerCase() === ".png" && !f.startsWith(sharedDir));
  await pool(pngs, async (file) => {
    const before = readFileSync(file);
    const after = await optimizePng(before);
    stats.png.files++;
    stats.png.before += before.length;
    stats.png.after += after.length;
    if (after !== before) writeAtomic(file, after);
  });

  // code, JSON and the shell
  if (precompress) {
    const texts = walk(root).filter((f) => SIDECAR_BROTLI.test(f) && !/\.(glb|gltf)$/i.test(f) && statSync(f).size >= 1024);
    await pool(texts, async (file) => {
      const bytes = readFileSync(file);
      const quality = bytes.length > 4_000_000 ? 9 : 11;
      const [br, gz] = await Promise.all([brotli(bytes, brotliOptions(quality, bytes.length)), SIDECAR_GZIP.test(file) ? gzip(bytes, { level: 9 }) : null]);
      if (br.length < bytes.length * 0.95) { writeFileSync(`${file}.br`, br); stats.sidecars.files++; stats.sidecars.bytes += br.length; }
      if (gz && gz.length < bytes.length * 0.95) { writeFileSync(`${file}.gz`, gz); stats.sidecars.files++; stats.sidecars.bytes += gz.length; }
    });
  }
  return stats;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [bundle] = process.argv.slice(2).filter((a) => !a.startsWith("--"));
  if (!bundle) throw new Error("usage: node tools/publish-compress.mjs <bundle dir> [--no-meshopt] [--no-precompress]");
  const stats = await compressBundle(bundle, { meshopt: !process.argv.includes("--no-meshopt"), precompress: !process.argv.includes("--no-precompress") });
  console.log(JSON.stringify(stats, null, 2));
}

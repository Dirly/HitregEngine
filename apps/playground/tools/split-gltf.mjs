#!/usr/bin/env node
/**
 * Split a grouped glTF into one self-contained glTF per root node.
 *
 * Blockbench (and most DCC tools) will happily export a whole shelf of props
 * as ONE file with each prop a root node laid out side by side. The engine
 * wants one asset per prop — a scatter rule names a model, an instanced batch
 * is one model — so this cuts the group apart along its root nodes:
 *
 *   node tools/split-gltf.mjs <group.gltf> <outdir> [--skip Name,Name] [--rename Old=New,...] [--prefix p]
 *
 * Each output keeps only the meshes, accessors, buffer views, materials,
 * textures, images and samplers its node uses, packed into a fresh embedded
 * buffer, with the node's translation zeroed so the prop stands at its own
 * origin (rotation and scale are kept — those are authoring). Everything is
 * base64-embedded, because the asset bridge resolves self-contained files
 * only. Prints each model's bounds, which are what a scatter rule's
 * `footprint` and `colliderSize` want.
 */
import fs from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const positional = args.filter((a) => !a.startsWith("--"));
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : fallback;
};
if (positional.length < 2) {
  console.error("usage: split-gltf.mjs <group.gltf> <outdir> [--skip A,B] [--rename Old=New,...] [--prefix p]");
  process.exit(2);
}
const [input, outdir] = positional;
const skip = new Set((opt("skip", "") || "").split(",").filter(Boolean));
const rename = new Map(
  (opt("rename", "") || "")
    .split(",")
    .filter(Boolean)
    .map((pair) => pair.split("=")),
);
const prefix = opt("prefix", "");

const gltf = JSON.parse(fs.readFileSync(input, "utf8"));
const inputDir = path.dirname(input);

/** Decode every source buffer once (data URI or sidecar file). */
const buffers = gltf.buffers.map((b) => {
  if (b.uri.startsWith("data:")) return Buffer.from(b.uri.slice(b.uri.indexOf(",") + 1), "base64");
  return fs.readFileSync(path.join(inputDir, decodeURIComponent(b.uri)));
});

/** Bytes of one buffer view. */
function viewBytes(index) {
  const view = gltf.bufferViews[index];
  const buffer = buffers[view.buffer];
  return buffer.subarray(view.byteOffset ?? 0, (view.byteOffset ?? 0) + view.byteLength);
}

const COMPONENT_BYTES = { 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 };
const TYPE_COUNT = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT2: 4, MAT3: 9, MAT4: 16 };

/** Recompute an accessor's min/max from its bytes (positions may not carry them, and we trust nothing after a re-pack). */
function accessorBounds(accessor, bytes) {
  const n = TYPE_COUNT[accessor.type];
  const size = COMPONENT_BYTES[accessor.componentType];
  const view = gltf.bufferViews[accessor.bufferView];
  const stride = view.byteStride ?? n * size;
  const min = new Array(n).fill(Infinity);
  const max = new Array(n).fill(-Infinity);
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const read = (off) => {
    switch (accessor.componentType) {
      case 5126:
        return dv.getFloat32(off, true);
      case 5125:
        return dv.getUint32(off, true);
      case 5123:
        return dv.getUint16(off, true);
      case 5122:
        return dv.getInt16(off, true);
      case 5121:
        return dv.getUint8(off);
      default:
        return dv.getInt8(off);
    }
  };
  for (let i = 0; i < accessor.count; i++) {
    const base = (accessor.byteOffset ?? 0) + i * stride;
    for (let c = 0; c < n; c++) {
      const v = read(base + c * size);
      if (v < min[c]) min[c] = v;
      if (v > max[c]) max[c] = v;
    }
  }
  return { min, max };
}

function splitNode(rootIndex) {
  const out = {
    asset: { ...gltf.asset, generator: `${gltf.asset?.generator ?? "unknown"} + hitreg split-gltf` },
    scene: 0,
    scenes: [{ name: "split", nodes: [0] }],
    nodes: [],
    meshes: [],
    accessors: [],
    bufferViews: [],
    buffers: [],
    materials: [],
    textures: [],
    images: [],
    samplers: [],
  };
  const chunks = [];
  let byteLength = 0;
  const viewMap = new Map();
  const accessorMap = new Map();
  const materialMap = new Map();
  const textureMap = new Map();
  const imageMap = new Map();
  const samplerMap = new Map();

  const copyView = (index) => {
    if (viewMap.has(index)) return viewMap.get(index);
    const view = gltf.bufferViews[index];
    const bytes = viewBytes(index);
    // 4-byte align every view, as the spec asks
    const pad = (4 - (byteLength % 4)) % 4;
    if (pad) {
      chunks.push(Buffer.alloc(pad));
      byteLength += pad;
    }
    const copy = { buffer: 0, byteOffset: byteLength, byteLength: bytes.byteLength };
    if (view.byteStride !== undefined) copy.byteStride = view.byteStride;
    if (view.target !== undefined) copy.target = view.target;
    chunks.push(bytes);
    byteLength += bytes.byteLength;
    out.bufferViews.push(copy);
    viewMap.set(index, out.bufferViews.length - 1);
    return out.bufferViews.length - 1;
  };
  const copyAccessor = (index) => {
    if (accessorMap.has(index)) return accessorMap.get(index);
    const a = gltf.accessors[index];
    const copy = { ...a };
    if (a.bufferView !== undefined) copy.bufferView = copyView(a.bufferView);
    if (a.sparse) throw new Error("sparse accessors are not supported by split-gltf");
    out.accessors.push(copy);
    accessorMap.set(index, out.accessors.length - 1);
    return out.accessors.length - 1;
  };
  const copyImage = (index) => {
    if (imageMap.has(index)) return imageMap.get(index);
    const image = { ...gltf.images[index] };
    if (image.bufferView !== undefined) image.bufferView = copyView(image.bufferView);
    else if (image.uri && !image.uri.startsWith("data:")) {
      const bytes = fs.readFileSync(path.join(inputDir, decodeURIComponent(image.uri)));
      const ext = path.extname(image.uri).toLowerCase();
      image.uri = `data:image/${ext === ".jpg" ? "jpeg" : ext.slice(1)};base64,${bytes.toString("base64")}`;
    }
    out.images.push(image);
    imageMap.set(index, out.images.length - 1);
    return out.images.length - 1;
  };
  const copySampler = (index) => {
    if (samplerMap.has(index)) return samplerMap.get(index);
    out.samplers.push({ ...gltf.samplers[index] });
    samplerMap.set(index, out.samplers.length - 1);
    return out.samplers.length - 1;
  };
  const copyTexture = (index) => {
    if (textureMap.has(index)) return textureMap.get(index);
    const t = { ...gltf.textures[index] };
    if (t.source !== undefined) t.source = copyImage(t.source);
    if (t.sampler !== undefined) t.sampler = copySampler(t.sampler);
    out.textures.push(t);
    textureMap.set(index, out.textures.length - 1);
    return out.textures.length - 1;
  };
  const remapTextureRefs = (obj) => {
    if (!obj || typeof obj !== "object") return obj;
    if (Array.isArray(obj)) return obj.map(remapTextureRefs);
    const copy = {};
    for (const [k, v] of Object.entries(obj)) {
      if (v && typeof v === "object" && typeof v.index === "number" && k.toLowerCase().endsWith("texture")) {
        copy[k] = { ...v, index: copyTexture(v.index) };
      } else copy[k] = remapTextureRefs(v);
    }
    return copy;
  };
  const copyMaterial = (index) => {
    if (materialMap.has(index)) return materialMap.get(index);
    out.materials.push(remapTextureRefs(gltf.materials[index]));
    materialMap.set(index, out.materials.length - 1);
    return out.materials.length - 1;
  };
  const bounds = { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };
  const copyMesh = (index) => {
    const mesh = gltf.meshes[index];
    const copy = { ...mesh, primitives: [] };
    for (const prim of mesh.primitives) {
      const p = { ...prim, attributes: {} };
      for (const [name, acc] of Object.entries(prim.attributes)) {
        p.attributes[name] = copyAccessor(acc);
        if (name === "POSITION") {
          const b = accessorBounds(gltf.accessors[acc], viewBytes(gltf.accessors[acc].bufferView));
          for (let c = 0; c < 3; c++) {
            bounds.min[c] = Math.min(bounds.min[c], b.min[c]);
            bounds.max[c] = Math.max(bounds.max[c], b.max[c]);
          }
        }
      }
      if (prim.indices !== undefined) p.indices = copyAccessor(prim.indices);
      if (prim.material !== undefined) p.material = copyMaterial(prim.material);
      if (prim.targets) p.targets = prim.targets.map((t) => Object.fromEntries(Object.entries(t).map(([k, v]) => [k, copyAccessor(v)])));
      copy.primitives.push(p);
    }
    out.meshes.push(copy);
    return out.meshes.length - 1;
  };
  const copyNode = (index, isRoot) => {
    const node = { ...gltf.nodes[index] };
    if (node.mesh !== undefined) node.mesh = copyMesh(node.mesh);
    if (node.skin !== undefined) throw new Error(`node ${node.name} is skinned; split-gltf handles static props only`);
    // the prop stands at its own origin: the group's layout was a shelf, not authoring
    if (isRoot) delete node.translation;
    const slot = out.nodes.length;
    out.nodes.push(node);
    if (node.children) node.children = node.children.map((c) => copyNode(c, false));
    return slot;
  };
  copyNode(rootIndex, true);
  const buffer = Buffer.concat(chunks);
  out.buffers.push({ byteLength: buffer.byteLength, uri: `data:application/octet-stream;base64,${buffer.toString("base64")}` });
  for (const key of ["materials", "textures", "images", "samplers"]) if (out[key].length === 0) delete out[key];
  return { doc: out, bounds };
}

fs.mkdirSync(outdir, { recursive: true });
const roots = gltf.scenes[gltf.scene ?? 0].nodes;
let written = 0;
for (const rootIndex of roots) {
  const node = gltf.nodes[rootIndex];
  const sourceName = node.name ?? `node${rootIndex}`;
  if (skip.has(sourceName)) {
    console.log(`  skip ${sourceName}`);
    continue;
  }
  const name = rename.get(sourceName) ?? sourceName;
  const { doc, bounds } = splitNode(rootIndex);
  const file = path.join(outdir, `${prefix}${name}.gltf`);
  fs.writeFileSync(file, JSON.stringify(doc));
  written++;
  const size = bounds.max.map((v, i) => v - bounds.min[i]);
  const materials = (doc.materials ?? []).length;
  console.log(
    `  ${name}.gltf  ${(fs.statSync(file).size / 1024).toFixed(0)} KB  size ${size.map((v) => v.toFixed(2)).join(" x ")}  ` +
      `y ${bounds.min[1].toFixed(2)}..${bounds.max[1].toFixed(2)}  ${materials} material${materials === 1 ? "" : "s"}` +
      (name !== sourceName ? `  (was ${sourceName})` : ""),
  );
}
console.log(`split ${written} of ${roots.length} root nodes from ${path.basename(input)} into ${outdir}`);

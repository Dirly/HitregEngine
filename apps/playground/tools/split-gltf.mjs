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
import { boundsOf } from "./_gltf-bounds.mjs";

const args = process.argv.slice(2);
const positional = args.filter((a) => !a.startsWith("--"));
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : fallback;
};
if (positional.length < 2) {
  console.error(
    "usage: split-gltf.mjs <group.gltf> <outdir> [--skip A,B] [--rename Old=New|index=New,...] " +
      "[--texnames 3=Leaves,4=Bark,...] [--reorigin] [--prefix p]",
  );
  process.exit(2);
}
const [input, outdir] = positional;
const skip = new Set((opt("skip", "") || "").split(",").filter(Boolean));
// Keyed by source node NAME, or by its index — a shelf routinely carries two
// nodes of the same name (a granite and a sandstone cut of the same rock),
// and a name key cannot tell them apart.
const rename = new Map(
  (opt("rename", "") || "")
    .split(",")
    .filter(Boolean)
    .map((pair) => pair.split("=")),
);
// Rename the SOURCE images by index, before anything is split. Blockbench
// exports every pasted texture as literally "pasted", and the name-driven
// passes downstream — `wind.materials` above all — select on that name, so an
// unnamed group is one nothing can pick foliage out of. Naming them here,
// once, beats renaming in the DCC tool on every re-export.
const texnames = new Map(
  (opt("texnames", "") || "")
    .split(",")
    .filter(Boolean)
    .map((pair) => {
      const [key, value] = pair.split("=");
      return [Number(key), value];
    }),
);
/**
 * Stand each prop on its own base at its own origin: translate the split root
 * so the geometry's lowest point sits at y=0 and its XZ centre at 0.
 *
 * Everything downstream assumes it. The voxel scatter emits its collider at
 * `offset: [0, size.y / 2, 0]` — rising from the ENTITY origin — so a model
 * whose geometry starts 4m below its own origin (a hoodoo modelled about its
 * middle, a jungle tree with buttress roots) gets a collider floating 4m off
 * the rock, and `yOffset` can only paper over one prop at a time.
 */
const reorigin = args.includes("--reorigin");
const prefix = opt("prefix", "");

const gltf = JSON.parse(fs.readFileSync(input, "utf8"));
const inputDir = path.dirname(input);

// Name the images/textures before the split, so every prop that shares one
// carries the same name out (a leaf texture named once names the leaves of
// every tree using it).
for (const [source, name] of texnames) {
  if (!gltf.images?.[source]) {
    console.error(`  --texnames: no image ${source} (this file has ${gltf.images?.length ?? 0})`);
    process.exit(2);
  }
  gltf.images[source].name = name;
  for (const texture of gltf.textures ?? []) if (texture.source === source) texture.name = name;
}

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
  const copyMesh = (index) => {
    const mesh = gltf.meshes[index];
    const copy = { ...mesh, primitives: [] };
    for (const prim of mesh.primitives) {
      const p = { ...prim, attributes: {} };
      for (const [name, acc] of Object.entries(prim.attributes)) {
        p.attributes[name] = copyAccessor(acc);
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
  // Bounds AFTER the split, walking the node transforms. Raw accessor min/max
  // is what the geometry says in its own space; a child node rotated or
  // shifted by the DCC tool (Blockbench nests a prop's parts freely) makes
  // that a different box from the one the prop actually occupies — and this
  // box is what a scatter rule's `footprint` and `colliderSize` copy.
  const bounds = boundsOf(out, () => Buffer.from(out.buffers[0].uri.slice(out.buffers[0].uri.indexOf(",") + 1), "base64"));
  if (reorigin) {
    const shift = [-(bounds.min[0] + bounds.max[0]) / 2, -bounds.min[1], -(bounds.min[2] + bounds.max[2]) / 2];
    if (shift.some((v) => Math.abs(v) > 1e-4)) {
      const root = out.nodes[0];
      const t = root.translation ?? [0, 0, 0];
      root.translation = [t[0] + shift[0], t[1] + shift[1], t[2] + shift[2]];
      for (let c = 0; c < 3; c++) {
        bounds.min[c] += shift[c];
        bounds.max[c] += shift[c];
      }
      return { doc: out, bounds, shift };
    }
  }
  return { doc: out, bounds, shift: null };
}

fs.mkdirSync(outdir, { recursive: true });
// A shelf is usually exported as a flat list of root nodes, but a DCC tool
// will just as happily wrap the whole shelf in ONE empty group ("Nature
// Props"). Split along that group's children instead, or the "split" writes
// the entire shelf back out as a single prop.
const sceneRoots = gltf.scenes[gltf.scene ?? 0].nodes;
const roots =
  sceneRoots.length === 1 && gltf.nodes[sceneRoots[0]].mesh === undefined && gltf.nodes[sceneRoots[0]].children?.length
    ? gltf.nodes[sceneRoots[0]].children
    : sceneRoots;
if (roots !== sceneRoots) console.log(`  (splitting the ${roots.length} children of group "${gltf.nodes[sceneRoots[0]].name ?? "?"}")`);
let written = 0;
for (const rootIndex of roots) {
  const node = gltf.nodes[rootIndex];
  const sourceName = node.name ?? `node${rootIndex}`;
  if (skip.has(sourceName) || skip.has(String(rootIndex))) {
    console.log(`  skip ${sourceName}`);
    continue;
  }
  const name = rename.get(String(rootIndex)) ?? rename.get(sourceName) ?? sourceName;
  const { doc, bounds, shift } = splitNode(rootIndex);
  const file = path.join(outdir, `${prefix}${name}.gltf`);
  fs.writeFileSync(file, JSON.stringify(doc));
  written++;
  const size = bounds.max.map((v, i) => v - bounds.min[i]);
  const materials = (doc.materials ?? []).length;
  const textures = (doc.textures ?? []).map((t) => t.name ?? "?").join("/");
  console.log(
    `  ${name}.gltf  ${(fs.statSync(file).size / 1024).toFixed(0)} KB  size ${size.map((v) => v.toFixed(2)).join(" x ")}  ` +
      `y ${bounds.min[1].toFixed(2)}..${bounds.max[1].toFixed(2)}  ${materials} material${materials === 1 ? "" : "s"} [${textures}]` +
      (shift ? `  re-origined by ${shift.map((v) => v.toFixed(2)).join(",")}` : "") +
      (name !== sourceName ? `  (was ${sourceName})` : ""),
  );
}
console.log(`split ${written} of ${roots.length} root nodes from ${path.basename(input)} into ${outdir}`);

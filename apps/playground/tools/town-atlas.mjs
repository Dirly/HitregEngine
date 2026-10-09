#!/usr/bin/env node
/**
 * Town texture atlas: one atlas page per town, one shared material per town.
 *
 *   node tools/town-atlas.mjs <town-model-dir> --out <staging-dir> [--page 1024] [--pad 8]
 *   e.g. node tools/town-atlas.mjs projects/proving/assets/models/towns/tidewell \
 *          --out projects/proving/authoring/town-atlas/tidewell
 *
 * The town building GLBs exported from Blender each carry ~13 kit materials and
 * embed their own copies of the kit's textures (55 files, 658 images, 37
 * distinct). Every material is its own draw in every pass, and a building can
 * never merge with its neighbour. This tool rewrites a town's GLBs so all kit
 * surfaces use ONE material sampling ONE atlas page (docs/town-baking.md,
 * "Atlas first, merge compatible materials second").
 *
 * Repeat-preserving (the doc's hard rule): kit walls TILE — UVs run to 9+.
 * Clamping or `fract` on vertex UVs would destroy the texture scale or break
 * triangles that cross a seam. So the original UVs are kept unchanged and each
 * vertex also carries `_ATLASRECT` = (u0, v0, du, dv), its tile on the page;
 * the runtime material samples `rect.xy + fract(uv) * rect.zw` per FRAGMENT
 * with gradients from the unwrapped UV (packages/render town-atlas material),
 * and the packer's wrap gutter (pad pixels copied from the opposite edge)
 * keeps filtering and the first mips inside the tile.
 *
 * Kept out of the atlas: `WindowGlass` (its night glow is applied by material
 * name) and any material that is not a plain opaque base-colour material.
 * Everything else must match the kit's matte setup (metallic 0, specular 0);
 * a material with different roughness is reported, and atlased as matte.
 *
 * Writes the rewritten GLBs (same file names) plus `atlas-report.json`
 * (source hashes, counts, islands) and `atlas-page.png` for review. Installing
 * is a separate step: review first (docs/town-baking.md, "Review before
 * installing a new bake").
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { Atlas, decodeImage } from "../../../tools/wfc-3d/atlas.mjs";
import { accessorArray, imageBytes, readGltf, viewBytes } from "../../../tools/wfc-3d/gltf.mjs";

const KEEP_NAME = /windowglass/i;
const baseName = (name) => String(name ?? "").replace(/\.\d+$/, "");

/** Is this material a plain opaque base-colour kit material we can fold into the atlas? */
function atlasable(material) {
  if (KEEP_NAME.test(material.name ?? "")) return false;
  if ((material.alphaMode ?? "OPAQUE") !== "OPAQUE") return false;
  const pbr = material.pbrMetallicRoughness ?? {};
  if (!pbr.baseColorTexture || (pbr.baseColorTexture.texCoord ?? 0) !== 0) return false;
  if (pbr.metallicRoughnessTexture || material.normalTexture || material.emissiveTexture || material.occlusionTexture) return false;
  if (pbr.baseColorTexture.extensions?.KHR_texture_transform) return false;
  const color = pbr.baseColorFactor ?? [1, 1, 1, 1];
  if (color.some((c) => Math.abs(c - 1) > 1e-4)) return false; // tinted: would need a baked tile per tint
  if ((pbr.metallicFactor ?? 1) > 1e-4) return false;
  return true;
}

/**
 * Atlas every GLB in `srcDir` onto one page and write the rewritten files to
 * `outDir` (same names), plus atlas-report.json and atlas-page.png beside the
 * sources. Returns the report.
 */
export function buildAtlas(srcDir, outDir, name, options = {}) {
const pad = options.pad ?? 8;
const reportDir = options.reportDir ?? srcDir;
const files = fs.readdirSync(srcDir).filter((f) => f.toLowerCase().endsWith(".glb")).sort();
if (files.length === 0) throw new Error(`${srcDir}: no .glb files`);
// ---- pass 1: read every file, collect the images the atlas needs ----------
const sources = files.map((file) => {
  const full = path.join(srcDir, file);
  return { file, g: readGltf(full), sha: crypto.createHash("sha1").update(fs.readFileSync(full)).digest("hex").slice(0, 16) };
});
const warnings = [];
function tryPack(pageSize) {
  const atlas = new Atlas({ pageSize, pad });
  for (const { g } of sources) {
    for (const material of g.doc.materials ?? []) {
      if (!atlasable(material)) continue;
      const texture = g.doc.textures[material.pbrMetallicRoughness.baseColorTexture.index];
      const { bytes, mimeType } = imageBytes(g, texture.source);
      atlas.add(decodeImage(bytes, mimeType));
    }
  }
  return atlas;
}
let pageSize = options.page || 512;
let atlas = tryPack(pageSize);
while (atlas.pages.length > 1 && pageSize < 4096) {
  pageSize *= 2;
  atlas = tryPack(pageSize);
}
if (atlas.pages.length > 1) throw new Error(`${name}: kit textures do not fit one ${pageSize}px page`);
const [pagePng] = atlas.encodePages();
const pageHash = crypto.createHash("sha1").update(pagePng).digest("hex").slice(0, 16);
// the runtime shares textures across files by this name (scene-builder shareNamedTextures)
const pageTextureName = `hitreg-shared:town-atlas:${name}:${pageHash}`;

// ---- pass 2: rewrite each file -----------------------------------------------
fs.mkdirSync(outDir, { recursive: true });
fs.mkdirSync(reportDir, { recursive: true });
const report = { tool: "town-atlas", version: 1, name, pageSize, pad, pageHash, files: [] };

for (const { file, g, sha } of sources) {
  const doc = structuredClone(g.doc);
  const chunks = [];
  let byteLength = 0;
  const pushView = (bytes, extra = {}) => {
    const fill = (4 - (byteLength % 4)) % 4;
    if (fill) { chunks.push(Buffer.alloc(fill)); byteLength += fill; }
    const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    chunks.push(buf);
    const view = { buffer: 0, byteOffset: byteLength, byteLength: buf.byteLength, ...extra };
    byteLength += buf.byteLength;
    return view;
  };

  // which materials fold, and the tile each one samples
  const tileOf = new Map(); // material index -> [u0, v0, du, dv]
  let toughness = 0;
  (g.doc.materials ?? []).forEach((material, index) => {
    if (!atlasable(material)) return;
    const texture = g.doc.textures[material.pbrMetallicRoughness.baseColorTexture.index];
    const { bytes, mimeType } = imageBytes(g, texture.source);
    const island = atlas.add(decodeImage(bytes, mimeType));
    tileOf.set(index, [island.x / pageSize, island.y / pageSize, island.w / pageSize, island.h / pageSize]);
    if ((material.pbrMetallicRoughness.roughnessFactor ?? 1) < 0.999) toughness++;
  });
  if (toughness) warnings.push(`${file}: ${toughness} material(s) with roughness < 1 atlased as matte`);

  // rebuild buffer views: keep every view an accessor uses (copied compactly),
  // drop image views; images are re-added below
  const viewRemap = new Map();
  const newViews = [];
  const keepView = (index) => {
    if (viewRemap.has(index)) return viewRemap.get(index);
    const old = g.doc.bufferViews[index];
    const view = pushView(viewBytes(g, index), {
      ...(old.byteStride !== undefined ? { byteStride: old.byteStride } : {}),
      ...(old.target !== undefined ? { target: old.target } : {}),
    });
    newViews.push(view);
    viewRemap.set(index, newViews.length - 1);
    return newViews.length - 1;
  };
  for (const accessor of doc.accessors ?? []) {
    if (accessor.bufferView !== undefined) accessor.bufferView = keepView(accessor.bufferView);
  }

  // materials: kept ones first (with their images), then the atlas material
  const materials = [];
  const textures = [];
  const images = [];
  const samplers = [];
  const materialRemap = new Map();
  const addImage = (bytes, mimeType, name) => {
    newViews.push(pushView(bytes));
    images.push({ bufferView: newViews.length - 1, mimeType, name });
    return images.length - 1;
  };
  (g.doc.materials ?? []).forEach((material, index) => {
    if (tileOf.has(index)) return;
    const copy = structuredClone(material);
    const remapTex = (ref) => {
      if (!ref) return;
      const t = g.doc.textures[ref.index];
      const img = imageBytes(g, t.source);
      const sampler = t.sampler !== undefined ? (samplers.push(structuredClone(g.doc.samplers[t.sampler])), samplers.length - 1) : undefined;
      textures.push({ source: addImage(img.bytes, img.mimeType, img.name), ...(sampler !== undefined ? { sampler } : {}), ...(t.name ? { name: t.name } : {}) });
      ref.index = textures.length - 1;
    };
    remapTex(copy.pbrMetallicRoughness?.baseColorTexture);
    remapTex(copy.pbrMetallicRoughness?.metallicRoughnessTexture);
    remapTex(copy.normalTexture);
    remapTex(copy.emissiveTexture);
    remapTex(copy.occlusionTexture);
    materials.push(copy);
    materialRemap.set(index, materials.length - 1);
  });
  let atlasMaterial = -1;
  if (tileOf.size > 0) {
    // the kit's sampler (nearest, nearest-mipmap) from the first folded material
    const firstKit = [...tileOf.keys()][0];
    const kitTex = g.doc.textures[g.doc.materials[firstKit].pbrMetallicRoughness.baseColorTexture.index];
    const kitSampler = kitTex.sampler !== undefined ? structuredClone(g.doc.samplers[kitTex.sampler]) : {};
    samplers.push({ ...kitSampler, wrapS: 33071, wrapT: 33071 }); // clamp: tiling happens in the shader
    const pageImage = addImage(pagePng, "image/png", pageTextureName);
    textures.push({ source: pageImage, sampler: samplers.length - 1, name: pageTextureName });
    materials.push({
      name: `town-atlas:${name}`,
      pbrMetallicRoughness: { baseColorTexture: { index: textures.length - 1 }, metallicFactor: 0, roughnessFactor: 1 },
      doubleSided: true,
      extensions: { KHR_materials_specular: { specularFactor: 0 } },
      // read by the runtime (GLTFLoader → material.userData): sample per-vertex tiles
      extras: { hitregAtlas: { name, page: pageHash, size: pageSize, pad } },
    });
    atlasMaterial = materials.length - 1;
  }

  // primitives: folded materials get the atlas material + an _ATLASRECT stream
  const accessors = doc.accessors ?? (doc.accessors = []);
  let folded = 0;
  for (const mesh of doc.meshes ?? []) {
    for (const prim of mesh.primitives) {
      if (prim.material === undefined) continue;
      const tile = tileOf.get(prim.material);
      if (!tile) {
        prim.material = materialRemap.get(prim.material);
        continue;
      }
      const count = accessors[prim.attributes.POSITION].count;
      const rect = new Float32Array(count * 4);
      for (let i = 0; i < count; i++) rect.set(tile, i * 4);
      newViews.push(pushView(rect, { target: 34962 }));
      accessors.push({ bufferView: newViews.length - 1, componentType: 5126, count, type: "VEC4" });
      prim.attributes._ATLASRECT = accessors.length - 1;
      prim.material = atlasMaterial;
      folded++;
    }
  }

  doc.bufferViews = newViews;
  doc.materials = materials;
  doc.textures = textures;
  doc.images = images;
  doc.samplers = samplers;
  for (const key of ["materials", "textures", "images", "samplers"]) if (doc[key].length === 0) delete doc[key];
  const extensionsUsed = new Set(doc.extensionsUsed ?? []);
  if (atlasMaterial >= 0) extensionsUsed.add("KHR_materials_specular");
  if (extensionsUsed.size) doc.extensionsUsed = [...extensionsUsed];

  const bin = Buffer.concat(chunks);
  doc.buffers = [{ byteLength: bin.byteLength }];
  writeGlb(path.join(outDir, file), doc, bin);
  const markers = path.join(srcDir, file.replace(/\.glb$/i, ".markers.json"));
  if (outDir !== srcDir && fs.existsSync(markers) && !fs.existsSync(path.join(outDir, path.basename(markers)))) fs.copyFileSync(markers, path.join(outDir, path.basename(markers)));
  report.files.push({
    file, sourceSha1: sha,
    materialsBefore: g.doc.materials?.length ?? 0, materialsAfter: materials.length,
    imagesBefore: g.doc.images?.length ?? 0, imagesAfter: images.length,
    primitivesFolded: folded, primitives: doc.meshes.reduce((n, m) => n + m.primitives.length, 0),
    bytesBefore: fs.statSync(path.join(srcDir, file)).size, bytesAfter: fs.statSync(path.join(outDir, file)).size,
  });
}

fs.writeFileSync(path.join(reportDir, "atlas-page.png"), pagePng);
report.islands = atlas.toLayout().islands;
report.warnings = warnings;
fs.writeFileSync(path.join(reportDir, "atlas-report.json"), JSON.stringify(report, null, 2));
const sum = (k) => report.files.reduce((n, f) => n + f[k], 0);
console.log(`${name}: ${files.length} files · page ${pageSize}px (${Object.keys(report.islands).length} tiles) · ` +
  `materials ${sum("materialsBefore")} → ${sum("materialsAfter")} · images ${sum("imagesBefore")} → ${sum("imagesAfter")} · ` +
  `${sum("primitivesFolded")}/${sum("primitives")} primitives on the atlas · ${(sum("bytesBefore") / 1048576).toFixed(1)} → ${(sum("bytesAfter") / 1048576).toFixed(1)} MB`);
for (const w of warnings) console.log(`  warn: ${w}`);

return report;
}

function writeGlb(file, json, bin) {
  const jsonBytes = Buffer.from(JSON.stringify(json), "utf8");
  const jsonPad = (4 - (jsonBytes.length % 4)) % 4;
  const binPad = (4 - (bin.length % 4)) % 4;
  const total = 12 + 8 + jsonBytes.length + jsonPad + 8 + bin.length + binPad;
  const out = Buffer.alloc(total);
  let o = 0;
  out.writeUInt32LE(0x46546c67, o); o += 4;
  out.writeUInt32LE(2, o); o += 4;
  out.writeUInt32LE(total, o); o += 4;
  out.writeUInt32LE(jsonBytes.length + jsonPad, o); o += 4;
  out.writeUInt32LE(0x4e4f534a, o); o += 4;
  jsonBytes.copy(out, o); o += jsonBytes.length;
  out.fill(0x20, o, o + jsonPad); o += jsonPad;
  out.writeUInt32LE(bin.length + binPad, o); o += 4;
  out.writeUInt32LE(0x004e4942, o); o += 4;
  bin.copy(out, o);
  fs.writeFileSync(file, out);
}

// ---------------------------------------------------------------------------
// Pipeline layer: sources, staleness, the status row, the CLI.
//
// A tagged model folder (every assets/models/towns/<town>, or any folder with
// an `atlas.json`) is ATLASED IN PLACE: the scene keeps referencing the same
// files. The un-atlased exports are the truth and live in
// authoring/atlas/<path-under-models>/src/. A fresh export dropped into the
// model folder by the building-constructor (a GLB with kit materials and no
// atlas material) is moved into src/ on the next run, and the whole page is
// rebuilt from src/ — so every file's tiles always point at the same page.

const readJsonChunk = (file) => {
  const b = fs.readFileSync(file);
  if (b.readUInt32LE(0) !== 0x46546c67) return JSON.parse(b.toString("utf8"));
  return JSON.parse(b.subarray(20, 20 + b.readUInt32LE(12)).toString("utf8"));
};

/** "atlased" (carries the atlas material), "raw" (has kit materials to fold) or "plain" (nothing to fold). */
export function glbAtlasKind(file) {
  const doc = readJsonChunk(file);
  if ((doc.materials ?? []).some((m) => m.extras?.hitregAtlas)) return "atlased";
  return (doc.materials ?? []).some(atlasable) ? "raw" : "plain";
}

function projectDirOf(modelDir) {
  const parts = path.resolve(modelDir).split(path.sep);
  const at = parts.lastIndexOf("assets");
  if (at < 1 || parts[at + 1] !== "models") throw new Error(`${modelDir}: not under <project>/assets/models`);
  return { projectDir: parts.slice(0, at).join(path.sep), rel: parts.slice(at + 2).join("/") };
}

export function atlasPaths(modelDir) {
  const { projectDir, rel } = projectDirOf(modelDir);
  const reportDir = path.join(projectDir, "authoring", "atlas", ...rel.split("/"));
  return { projectDir, rel, reportDir, srcDir: path.join(reportDir, "src") };
}

/** { state: ok | STALE | MISSING, why } for one tagged model folder. */
export function atlasState(modelDir) {
  const { reportDir, srcDir } = atlasPaths(modelDir);
  const glbs = fs.existsSync(modelDir) ? fs.readdirSync(modelDir).filter((f) => f.toLowerCase().endsWith(".glb")) : [];
  if (!glbs.length) return { state: "MISSING", why: "no building models yet" };
  const reportFile = path.join(reportDir, "atlas-report.json");
  if (!fs.existsSync(reportFile)) return { state: "MISSING", why: "never atlased" };
  const report = JSON.parse(fs.readFileSync(reportFile, "utf8"));
  const raw = glbs.filter((f) => glbAtlasKind(path.join(modelDir, f)) === "raw");
  if (raw.length) return { state: "STALE", why: `${raw.length} fresh export(s) not on the atlas (${raw.slice(0, 3).join(", ")})` };
  const noSrc = glbs.filter((f) => glbAtlasKind(path.join(modelDir, f)) === "atlased" && !fs.existsSync(path.join(srcDir, f)));
  if (noSrc.length) return { state: "STALE", why: `${noSrc.length} atlased file(s) with no source in authoring/atlas (${noSrc.slice(0, 3).join(", ")})` };
  const sha = (f) => crypto.createHash("sha1").update(fs.readFileSync(f)).digest("hex").slice(0, 16);
  const recorded = new Map(report.files.map((f) => [f.file, f.sourceSha1]));
  const changed = fs.readdirSync(srcDir).filter((f) => f.endsWith(".glb") && recorded.get(f) !== sha(path.join(srcDir, f)));
  if (changed.length) return { state: "STALE", why: `${changed.length} source(s) changed since the atlas was built (${changed.slice(0, 3).join(", ")})` };
  return { state: "ok", why: `${glbs.length} file(s) on one ${report.pageSize}px page` };
}

/** Pull fresh exports into src/, drop sources of removed files, rebuild the page in place. */
export function syncAtlas(modelDir, options = {}) {
  const { reportDir, srcDir } = atlasPaths(modelDir);
  fs.mkdirSync(srcDir, { recursive: true });
  const glbs = fs.readdirSync(modelDir).filter((f) => f.toLowerCase().endsWith(".glb"));
  for (const f of glbs) {
    if (glbAtlasKind(path.join(modelDir, f)) === "raw") fs.copyFileSync(path.join(modelDir, f), path.join(srcDir, f));
  }
  for (const f of fs.readdirSync(srcDir)) {
    if (f.endsWith(".glb") && !glbs.includes(f)) fs.rmSync(path.join(srcDir, f));
  }
  const missing = glbs.filter((f) => !fs.existsSync(path.join(srcDir, f)) && glbAtlasKind(path.join(modelDir, f)) !== "plain");
  if (missing.length) throw new Error(`${modelDir}: atlased file(s) with no source to rebuild from: ${missing.join(", ")} (re-export them)`);
  return buildAtlas(srcDir, modelDir, path.basename(path.resolve(modelDir)), { ...options, reportDir });
}

/** Every tagged folder of a project: assets/models/towns/* and any folder holding an atlas.json. */
export function taggedAtlasDirs(projectDir) {
  const models = path.join(projectDir, "assets", "models");
  const out = new Set();
  const towns = path.join(models, "towns");
  if (fs.existsSync(towns)) for (const e of fs.readdirSync(towns, { withFileTypes: true })) if (e.isDirectory()) out.add(path.join(towns, e.name));
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.isDirectory()) walk(path.join(d, e.name));
      else if (e.name === "atlas.json") out.add(d);
    }
  };
  if (fs.existsSync(models)) walk(models);
  return [...out].sort();
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
if (isMain) {
  const args = process.argv.slice(2);
  const flag = (name) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : undefined; };
  const check = args.includes("--check");
  const page = Number(flag("page") ?? 0) || undefined;
  const pad = flag("pad") !== undefined ? Number(flag("pad")) : undefined;
  let dirs;
  if (args.includes("--all")) {
    const project = flag("project");
    if (!project) { console.error("usage: node tools/town-atlas.mjs --all --project <name> [--check]"); process.exit(2); }
    dirs = taggedAtlasDirs(path.join("projects", project));
  } else {
    const dir = args.find((a, i) => !a.startsWith("--") && !["--project", "--page", "--pad"].includes(args[i - 1]));
    if (!dir) { console.error("usage: node tools/town-atlas.mjs <model-dir> [--check] | --all --project <name> [--check]"); process.exit(2); }
    dirs = [dir];
  }
  let bad = 0;
  for (const dir of dirs) {
    if (check) {
      const s = atlasState(dir);
      if (s.state !== "ok") bad++;
      console.log(`${s.state.padEnd(7)} ${path.relative(process.cwd(), dir).replaceAll("\\", "/")} — ${s.why}`);
      continue;
    }
    if (atlasState(dir).state === "ok" && !args.includes("--force")) { console.log(`ok      ${dir} (up to date)`); continue; }
    syncAtlas(dir, { page, pad });
  }
  if (check && bad) process.exit(1);
}

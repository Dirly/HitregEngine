#!/usr/bin/env node
/**
 * WFC kit pipeline: parts + examples in, atlased modules + cell prefabs +
 * a learned tileset out.
 *
 *   node tools/wfc-3d/kit.mjs import <kitDir> --project <name> --cell 4,3,4 [--kit <id>] [--atlas <name>] [--examples <dir>] [--page 2048] [--pad 4]
 *   node tools/wfc-3d/kit.mjs pack   <propsDir> --project <name> --atlas <name> --out models/<folder>
 *   node tools/wfc-3d/kit.mjs solve  --project <name> --kit <id> --name generated/house-01 --size 6,1,6 [--seed 1] [--attempts 20] [--origin center|min]
 *   node tools/wfc-3d/kit.mjs inspect <file.glb|gltf> [--cell 4,3,4]
 *
 * The drop (`<kitDir>`):
 *   <part>.glb|gltf          one PART per file — floor, wall, door, stair… —
 *                            authored in its cell's frame: origin at the cell's
 *                            bottom centre, a floor centred on it, a wall on
 *                            one cell edge with its thickness inside the cell.
 *   examples/<name>.glb      structures BUILT FROM THOSE PARTS on the cell grid,
 *                            rotated about Y only (never mirrored), each node
 *                            named after its part (Blockbench's "wall 2" /
 *                            "wall.001" suffixes are fine).
 *
 * What one import writes under the project's assets/:
 *   models/wfc/<kit>/<part>.gltf     the part, UVs remapped onto the kit atlas,
 *                                    self-contained, TEXCOORD_1 = UV rotation
 *                                    centre for the renderer's floor alignment
 *   textures/atlas/<atlas>-<n>.png   the atlas page(s), for inspection
 *   textures/atlas/<atlas>.atlas.json the island layout + every module on the
 *                                    page — kept, so a re-pack never moves an
 *                                    island and re-emits every consumer
 *   prefabs/wfc/<kit>/<tile>.json    one prefab per DISTINCT cell composition
 *                                    seen in the examples (up to rotation)
 *   wfc/<kit>.tileset.json           the learned tileset: tiles, weights,
 *                                    rotations, face profiles, allowed pairs
 *   wfc/<kit>.kit.json               the import report, for humans and agents
 *
 * The parts stay the only thing anyone models. Cell prefabs and the tileset
 * are derived; re-run the import after any change to parts or examples.
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  GltfBuilder,
  accessorArray,
  accessorFloats,
  fileGeometryStats,
  imageBytes,
  mat4Det3,
  mat4YawDegrees,
  readGltf,
  sceneNodes,
  subtreeGeometryStats,
  subtreeIndices,
  yawQuaternion,
} from "./gltf.mjs";
import { Atlas, decodeImage, solidImage } from "./atlas.mjs";
import { collapseTileset, collapsedPrefab, previewSvg, uvCounterRotation } from "./wfc.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..");

const HORIZONTAL = ["px", "nx", "pz", "nz"];
const VOID = "void";

/** Role by NAME PREFIX — the first word of the part's file name. */
const ROLE_OF_PREFIX = {
  floor: "floor",
  ground: "floor",
  ceiling: "ceiling",
  roof: "ceiling",
  wall: "edge",
  door: "edge",
  doorway: "edge",
  window: "edge",
  arch: "edge",
  fence: "edge",
  rail: "edge",
  railing: "edge",
  gate: "edge",
  balustrade: "edge",
};

export function slug(name) {
  return name
    .toLowerCase()
    .replace(/\.(glb|gltf)$/i, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** "wall 2", "wall.001", "Wall_3" → "wall"; a name with no suffix is unchanged. */
export function stripCopySuffix(name) {
  return slug(name).replace(/-\d+$/, "");
}

export function roleFor(partName) {
  const first = partName.split("-")[0];
  return ROLE_OF_PREFIX[first] ?? "fill";
}

/** The same +90° turn wfc.mjs applies to sockets: px → nz → nx → pz → px. */
export function rotateDirection(direction, degrees) {
  const turns = ((Math.round(degrees / 90) % 4) + 4) % 4;
  const vectors = { px: [1, 0], nx: [-1, 0], pz: [0, 1], nz: [0, -1] };
  let [x, z] = vectors[direction];
  for (let t = 0; t < turns; t++) [x, z] = [z, -x];
  return Object.entries(vectors).find(([, v]) => v[0] === x && v[1] === z)[0];
}

const norm360 = (deg) => ((Math.round(deg) % 360) + 360) % 360;

// ---------------------------------------------------------------------------
// Parts

/**
 * Least-squares affine fit (x, z) → (u, v) over the vertices of up-facing
 * triangles. Returns the 2x2 basis, the UV of the local origin, and the
 * determinant sign the renderer's counter-rotation needs.
 */
export function fitFloorUv(samples) {
  // samples: [{x, z, u, v}], need ≥ 3 non-collinear
  if (samples.length < 3) return null;
  const solve = (key) => {
    // normal equations for [a b c] · [x z 1] = key
    let sxx = 0, sxz = 0, sx = 0, szz = 0, sz = 0, n = 0, sxk = 0, szk = 0, sk = 0;
    for (const s of samples) {
      const k = s[key];
      sxx += s.x * s.x; sxz += s.x * s.z; sx += s.x; szz += s.z * s.z; sz += s.z; n += 1;
      sxk += s.x * k; szk += s.z * k; sk += k;
    }
    const m = [sxx, sxz, sx, sxz, szz, sz, sx, sz, n];
    const r = [sxk, szk, sk];
    const det =
      m[0] * (m[4] * m[8] - m[5] * m[7]) - m[1] * (m[3] * m[8] - m[5] * m[6]) + m[2] * (m[3] * m[7] - m[4] * m[6]);
    if (Math.abs(det) < 1e-12) return null;
    const inv = [
      (m[4] * m[8] - m[5] * m[7]) / det, (m[2] * m[7] - m[1] * m[8]) / det, (m[1] * m[5] - m[2] * m[4]) / det,
      (m[5] * m[6] - m[3] * m[8]) / det, (m[0] * m[8] - m[2] * m[6]) / det, (m[2] * m[3] - m[0] * m[5]) / det,
      (m[3] * m[7] - m[4] * m[6]) / det, (m[1] * m[6] - m[0] * m[7]) / det, (m[0] * m[4] - m[1] * m[3]) / det,
    ];
    return [inv[0] * r[0] + inv[1] * r[1] + inv[2] * r[2], inv[3] * r[0] + inv[4] * r[1] + inv[5] * r[2], inv[6] * r[0] + inv[7] * r[1] + inv[8] * r[2]];
  };
  const U = solve("u");
  const V = solve("v");
  if (!U || !V) return null;
  const det = U[0] * V[1] - U[1] * V[0];
  if (Math.abs(det) < 1e-9) return null;
  return { basis: [U[0], U[1], V[0], V[1]], center: [U[2], V[2]], det, factor: det > 0 ? -1 : 1 };
}

function upFacingUvSamples(g) {
  const samples = [];
  for (const n of sceneNodes(g)) {
    if (n.node.mesh === undefined) continue;
    for (const prim of g.doc.meshes[n.node.mesh].primitives) {
      if ((prim.mode ?? 4) !== 4) continue;
      const posIndex = prim.attributes?.POSITION;
      const uvIndex = prim.attributes?.TEXCOORD_0;
      if (posIndex === undefined || uvIndex === undefined) continue;
      const pos = accessorFloats(g, posIndex);
      const uv = accessorFloats(g, uvIndex);
      const count = pos.length / 3;
      const indices = prim.indices !== undefined ? accessorArray(g, prim.indices) : Array.from({ length: count }, (_, i) => i);
      const seen = new Set();
      const m = n.world;
      const world = (i) => [
        m[0] * pos[i * 3] + m[4] * pos[i * 3 + 1] + m[8] * pos[i * 3 + 2] + m[12],
        m[1] * pos[i * 3] + m[5] * pos[i * 3 + 1] + m[9] * pos[i * 3 + 2] + m[13],
        m[2] * pos[i * 3] + m[6] * pos[i * 3 + 1] + m[10] * pos[i * 3 + 2] + m[14],
      ];
      for (let t = 0; t + 2 < indices.length; t += 3) {
        const a = world(indices[t]);
        const b = world(indices[t + 1]);
        const c = world(indices[t + 2]);
        const e1 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
        const e2 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
        const nx = e1[1] * e2[2] - e1[2] * e2[1];
        const ny = e1[2] * e2[0] - e1[0] * e2[2];
        const nz = e1[0] * e2[1] - e1[1] * e2[0];
        const len = Math.hypot(nx, ny, nz);
        if (len < 1e-12 || ny / len < 0.9) continue;
        for (const i of [indices[t], indices[t + 1], indices[t + 2]]) {
          if (seen.has(i)) continue;
          seen.add(i);
          const p = world(i);
          samples.push({ x: p[0], z: p[2], u: uv[i * 2], v: uv[i * 2 + 1] });
        }
      }
    }
  }
  return samples;
}

/** Read one part file and classify it. */
export function analyzePart(file, cellSize, warn) {
  const g = readGltf(file);
  const name = slug(path.basename(file));
  const role = roleFor(name);
  if (g.doc.skins?.length) throw new Error(`${name}: skinned meshes are not kit parts`);
  if (g.doc.animations?.length) warn(`${name}: animations are ignored (kit parts are static)`);
  const stats = fileGeometryStats(g);
  if (!stats.min) throw new Error(`${name}: no geometry`);
  const size = stats.max.map((v, i) => v - stats.min[i]);
  const centre = stats.max.map((v, i) => (v + stats.min[i]) / 2);
  const part = { name, file, role, slot: null, edge: null, bounds: { min: stats.min, max: stats.max, size, centre }, vertices: stats.vertices, indices: stats.indices, uvAlign: null };

  if (role === "edge") {
    const thinAxis = size[0] < size[2] ? 0 : 2;
    const along = thinAxis === 0 ? "x" : "z";
    const offset = centre[thinAxis];
    if (size[thinAxis] > cellSize[thinAxis] * 0.6) {
      warn(`${name}: named like a wall but ${size[thinAxis].toFixed(2)} thick on ${along} (cell ${cellSize[thinAxis]}) — treated as a fill part`);
      part.role = "fill";
    } else if (Math.abs(offset) < cellSize[thinAxis] * 0.1) {
      warn(`${name}: sits in the MIDDLE of the cell on ${along}, not on an edge — treated as a fill part`);
      part.role = "fill";
    } else {
      part.edge = `${offset > 0 ? "p" : "n"}${along}`;
      part.slot = part.edge;
    }
  }
  if (part.role === "floor" || part.role === "ceiling") {
    part.slot = part.role;
    const fit = fitFloorUv(upFacingUvSamples(g));
    if (fit) {
      part.uvAlign = { center: fit.center, factor: fit.factor, det: fit.det };
    } else {
      warn(`${name}: no up-facing textured triangles to fit a UV projection — texture alignment falls back to the island centre`);
      part.uvAlign = { center: [0.5, 0.5], factor: -1, det: 1 };
    }
  }
  if (part.role === "fill") part.slot = "fill";
  // A face part covering the whole cell footprint reads the same at every
  // Y rotation once its texture is counter-rotated (the whole point of
  // alignUv), so its placed rotation carries no information: normalised to 0
  // when learning. A partial floor (a balcony's half square) keeps its
  // rotation — it is a different shape when turned.
  part.symmetric =
    (part.role === "floor" || part.role === "ceiling") &&
    Math.abs(size[0] - cellSize[0]) < cellSize[0] * 0.05 &&
    Math.abs(size[2] - cellSize[2]) < cellSize[2] * 0.05 &&
    Math.abs(centre[0]) < cellSize[0] * 0.05 &&
    Math.abs(centre[2]) < cellSize[2] * 0.05;
  if (Math.abs(centre[0]) > cellSize[0] * 0.5 || Math.abs(centre[2]) > cellSize[2] * 0.5 || stats.min[1] < -cellSize[1] * 0.25) {
    warn(`${name}: geometry centre ${centre.map((v) => v.toFixed(2)).join(", ")} is outside its cell — is the origin at the cell's bottom centre?`);
  }
  part.fingerprint = fingerprintOf(stats.vertices, stats.indices, size);
  return { part, g };
}

function fingerprintOf(vertices, indices, size) {
  const xz = [size[0], size[2]].map((v) => v.toFixed(2)).sort();
  return `${vertices}:${indices}:${xz.join("x")}:${size[1].toFixed(2)}`;
}

// ---------------------------------------------------------------------------
// Atlas + module rewrite
//
// An atlas is a PROJECT resource, not a kit's: kits and plain props pack onto
// the same named page(s) so a whole town is one texture. The layout file
// remembers every module that consumes the page (its source file and output
// path), and every pack re-emits all of them, so they all embed the SAME page
// bytes under the same shared name and the renderer uploads it once.

function materialKey(mat) {
  const pbr = mat.pbrMetallicRoughness ?? {};
  return [
    mat.name ?? "",
    mat.alphaMode ?? "OPAQUE",
    mat.alphaMode === "MASK" ? (mat.alphaCutoff ?? 0.5) : "",
    mat.doubleSided ? "2s" : "1s",
    pbr.metallicFactor ?? 1,
    pbr.roughnessFactor ?? 1,
    (mat.emissiveFactor ?? [0, 0, 0]).join(","),
  ].join("|");
}

const FALLBACK_KEY = "|OPAQUE||1s|0|1|0,0,0";

/**
 * Register every material of a module in the atlas; returns material index →
 * island (index −1 = the solid white island for primitives with no material).
 */
function atlasModuleMaterials(g, atlas, imageCache, warn) {
  const islands = new Map();
  const materials = g.doc.materials ?? [];
  materials.forEach((mat, index) => {
    const pbr = mat.pbrMetallicRoughness ?? {};
    const factor = pbr.baseColorFactor ?? [1, 1, 1, 1];
    let image;
    if (pbr.baseColorTexture) {
      const tex = g.doc.textures[pbr.baseColorTexture.index];
      const src = imageBytes(g, tex.source);
      const cacheKey = crypto.createHash("sha1").update(src.bytes).digest("hex");
      let decoded = imageCache.get(cacheKey);
      if (!decoded) {
        decoded = decodeImage(src.bytes, src.mimeType);
        imageCache.set(cacheKey, decoded);
      }
      image = decoded;
      const tinted = factor.some((f, i) => Math.abs(f - 1) > 1e-6 && i < 4);
      if (tinted) {
        const rgba = new Uint8Array(decoded.rgba.length);
        for (let i = 0; i < rgba.length; i += 4) {
          for (let c = 0; c < 4; c++) rgba[i + c] = Math.round(decoded.rgba[i + c] * Math.max(0, Math.min(1, factor[c])));
        }
        image = { width: decoded.width, height: decoded.height, rgba };
      }
      if ((pbr.baseColorTexture.texCoord ?? 0) !== 0) warn(`material "${mat.name ?? index}" samples TEXCOORD_${pbr.baseColorTexture.texCoord}; only TEXCOORD_0 is atlased`);
    } else {
      image = solidImage(factor);
    }
    islands.set(index, { island: atlas.add(image), key: materialKey(mat), source: mat });
  });
  const needsFallback = (g.doc.meshes ?? []).some((mesh) => mesh.primitives.some((p) => p.material === undefined));
  if (needsFallback) islands.set(-1, { island: atlas.add(solidImage([1, 1, 1, 1])), key: FALLBACK_KEY, source: {} });
  return islands;
}

/**
 * Re-emit one module onto the atlas: UVs remapped into their islands,
 * TEXCOORD_1 = the UV rotation centre, one material per distinct source
 * material (its NAME is kept, so anything that matches materials by name —
 * `wind.materials` — keeps working), every page embedded under its shared name.
 */
function rewriteModule(source, g, atlas, islands, pages, warn) {
  const b = new GltfBuilder("hitreg wfc-3d atlas");
  // one shared sampler: pixel-art magnification, clamped (islands must never wrap across the page)
  const sourceSampler = g.doc.samplers?.[0];
  const sampler = b.pushSampler({
    magFilter: sourceSampler?.magFilter ?? 9728,
    minFilter: sourceSampler?.minFilter ?? 9987,
    wrapS: 33071,
    wrapT: 33071,
  });
  const textureForPage = new Map();
  const materialFor = new Map();
  const materialIndexFor = (sourceIndex) => {
    const entry = islands.get(sourceIndex);
    const page = entry.island.page;
    if (!textureForPage.has(page)) {
      const image = b.pushImage(pages.pngs[page], `hitreg-shared:${pages.hashes[page]}`);
      textureForPage.set(page, b.pushTexture({ name: `hitreg-shared:${pages.hashes[page]}`, sampler, source: image }));
    }
    const key = `${page}|${entry.key}`;
    if (!materialFor.has(key)) {
      const src = entry.source;
      const pbr = src.pbrMetallicRoughness ?? {};
      const material = {
        name: src.name || `atlas-${source.atlasName}-${page}`,
        pbrMetallicRoughness: {
          baseColorTexture: { index: textureForPage.get(page) },
          baseColorFactor: [1, 1, 1, 1],
          metallicFactor: pbr.metallicFactor ?? 0,
          roughnessFactor: pbr.roughnessFactor ?? 1,
        },
      };
      if (src.alphaMode && src.alphaMode !== "OPAQUE") material.alphaMode = src.alphaMode;
      if (src.alphaMode === "MASK") material.alphaCutoff = src.alphaCutoff ?? 0.5;
      if (src.doubleSided) material.doubleSided = true;
      if (src.emissiveFactor?.some((v) => v > 0)) material.emissiveFactor = src.emissiveFactor;
      materialFor.set(key, b.pushMaterial(material));
    }
    return materialFor.get(key);
  };

  const uvCentre = source.uvCentre ?? [0.5, 0.5];
  let wrapWarned = false;
  const meshMap = new Map();
  const copyMesh = (index) => {
    if (meshMap.has(index)) return meshMap.get(index);
    const mesh = g.doc.meshes[index];
    const out = { name: mesh.name, primitives: [] };
    for (const prim of mesh.primitives) {
      const p = { attributes: {} };
      if (prim.mode !== undefined) p.mode = prim.mode;
      const count = g.doc.accessors[prim.attributes.POSITION].count;
      for (const [attr, acc] of Object.entries(prim.attributes)) {
        if (attr.startsWith("TEXCOORD_")) continue;
        const type = g.doc.accessors[acc].type;
        let array = accessorArray(g, acc);
        if (!(array instanceof Float32Array || array instanceof Uint16Array || array instanceof Uint32Array || array instanceof Uint8Array)) {
          array = Float32Array.from(array);
        }
        p.attributes[attr] = b.pushAccessor(array, type, { target: 34962, normalized: g.doc.accessors[acc].normalized, minMax: attr === "POSITION" });
      }
      const sourceIndex = prim.material !== undefined ? prim.material : -1;
      const island = islands.get(sourceIndex).island;
      p.material = materialIndexFor(sourceIndex);
      const uv = new Float32Array(count * 2);
      const uv1 = new Float32Array(count * 2);
      const uvSource = prim.attributes.TEXCOORD_0 !== undefined ? accessorFloats(g, prim.attributes.TEXCOORD_0) : null;
      const centre = atlas.remapUv(island, uvCentre[0], uvCentre[1]);
      let minU = Infinity, maxU = -Infinity, minV = Infinity, maxV = -Infinity;
      for (let i = 0; i < count; i++) {
        let u = uvSource ? uvSource[i * 2] : 0.5;
        let v = uvSource ? uvSource[i * 2 + 1] : 0.5;
        if (u < minU) minU = u; if (u > maxU) maxU = u; if (v < minV) minV = v; if (v > maxV) maxV = v;
        u = Math.max(0, Math.min(1, u));
        v = Math.max(0, Math.min(1, v));
        const [au, av] = atlas.remapUv(island, u, v);
        uv[i * 2] = au;
        uv[i * 2 + 1] = av;
        uv1[i * 2] = centre[0];
        uv1[i * 2 + 1] = centre[1];
      }
      if (uvSource && !wrapWarned && (minU < -0.002 || maxU > 1.002 || minV < -0.002 || maxV > 1.002)) {
        wrapWarned = true;
        warn(`${source.name}: UVs run ${minU.toFixed(2)}..${maxU.toFixed(2)} × ${minV.toFixed(2)}..${maxV.toFixed(2)} — a face relies on texture WRAP, which an atlas cannot repeat; clamped (subdivide the face or pre-tile the texture)`);
      }
      p.attributes.TEXCOORD_0 = b.pushAccessor(uv, "VEC2", { target: 34962 });
      p.attributes.TEXCOORD_1 = b.pushAccessor(uv1, "VEC2", { target: 34962 });
      if (prim.indices !== undefined) {
        let idx = accessorArray(g, prim.indices);
        if (idx instanceof Uint8Array) idx = Uint16Array.from(idx);
        p.indices = b.pushAccessor(idx, "SCALAR", { target: 34963 });
      }
      out.primitives.push(p);
    }
    const slot = b.pushMesh(out);
    meshMap.set(index, slot);
    return slot;
  };

  const doc = g.doc;
  const scene = doc.scenes?.[doc.scene ?? 0];
  const roots = scene?.nodes ?? doc.nodes.map((_, i) => i);
  const copyNode = (index, isRoot) => {
    const node = doc.nodes[index];
    const copy = {};
    if (node.name !== undefined) copy.name = node.name;
    if (node.matrix) copy.matrix = node.matrix;
    if (node.translation) copy.translation = node.translation;
    if (node.rotation) copy.rotation = node.rotation;
    if (node.scale) copy.scale = node.scale;
    if (node.mesh !== undefined) copy.mesh = copyMesh(node.mesh);
    const slot = b.pushNode(copy, isRoot);
    if (node.children?.length) copy.children = node.children.map((c) => copyNode(c, false));
    return slot;
  };
  for (const root of roots) copyNode(root, true);
  return b.finish();
}

/** A plain prop: no role, no cell — just a module that wants to live on the atlas. */
export function analyzeProp(file, warn) {
  const g = readGltf(file);
  const name = slug(path.basename(file));
  if (g.doc.skins?.length) warn(`${name}: skinned mesh — atlased, but instancing will skip its skinned submeshes`);
  const stats = fileGeometryStats(g);
  if (!stats.min) throw new Error(`${name}: no geometry`);
  const size = stats.max.map((v, i) => v - stats.min[i]);
  const centre = stats.max.map((v, i) => (v + stats.min[i]) / 2);
  return { part: { name, file, role: "prop", slot: null, bounds: { min: stats.min, max: stats.max, size, centre }, vertices: stats.vertices, indices: stats.indices, uvAlign: null, symmetric: false }, g };
}

export function atlasPaths(assetsDir, atlasName) {
  const dir = path.join(assetsDir, "textures", "atlas");
  return { dir, layoutFile: path.join(dir, `${atlasName}.atlas.json`), pagePng: (page) => path.join(dir, `${atlasName}-${page}.png`) };
}

/**
 * Pack a set of modules onto a named project atlas and re-emit EVERY module
 * the atlas has ever packed (kits and props alike), so all of them embed the
 * page as it is now.
 *
 * @param {{ assetsDir: string, atlasName: string, pageSize?: number, pad?: number,
 *   entries: { file: string, out: string, kind: "part"|"prop", cellSize?: number[], analyzed?: { part: any, g: any } }[],
 *   log: (s: string) => void, warn: (s: string) => void }} options
 */
export function packAtlas({ assetsDir, atlasName, pageSize, pad, entries, log, warn }) {
  const { dir, layoutFile, pagePng } = atlasPaths(assetsDir, atlasName);
  const layout = fs.existsSync(layoutFile) ? JSON.parse(fs.readFileSync(layoutFile, "utf8")) : null;
  const atlas = new Atlas({ pageSize: pageSize ?? 2048, pad: pad ?? 4, layout });

  // consumers: previously recorded sources first, this call's entries override by output path
  const byOut = new Map();
  for (const prev of layout?.sources ?? []) byOut.set(prev.out, { ...prev, recorded: true });
  for (const entry of entries) byOut.set(entry.out, entry);
  const consumers = [];
  for (const entry of byOut.values()) {
    if (!entry.analyzed && !fs.existsSync(entry.file)) {
      warn(`atlas ${atlasName}: source ${entry.file} for ${entry.out} no longer exists — dropped from the atlas (its islands keep their place)`);
      continue;
    }
    consumers.push(entry);
  }

  const imageCache = new Map();
  for (const entry of consumers) {
    if (!entry.analyzed) {
      entry.analyzed = entry.kind === "part" && entry.cellSize ? analyzePart(entry.file, entry.cellSize, () => {}) : analyzeProp(entry.file, () => {});
    }
    entry.islands = atlasModuleMaterials(entry.analyzed.g, atlas, imageCache, warn);
    const part = entry.analyzed.part;
    if (part.uvAlign) {
      for (const island of entry.islands.values()) {
        if (island.island.w !== island.island.h) {
          warn(`${part.name}: texture ${island.island.w}x${island.island.h} is not square — a 90° rotation of a non-square island skews the texture; floors and ceilings need square textures`);
        }
      }
    }
  }

  const pngs = atlas.encodePages();
  const hashes = pngs.map((png) => crypto.createHash("sha1").update(png).digest("hex").slice(0, 16));
  const pages = { pngs, hashes };
  for (const entry of consumers) {
    const part = entry.analyzed.part;
    const doc = rewriteModule({ name: part.name, uvCentre: part.uvAlign?.center, atlasName }, entry.analyzed.g, atlas, entry.islands, pages, entry.recorded ? () => {} : warn);
    const target = path.join(assetsDir, entry.out);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, JSON.stringify(doc));
  }
  fs.mkdirSync(dir, { recursive: true });
  pngs.forEach((png, page) => fs.writeFileSync(pagePng(page), png));
  const sources = consumers
    .map((e) => ({ file: path.resolve(e.file).replace(/\\/g, "/"), out: e.out.replace(/\\/g, "/"), kind: e.kind, ...(e.cellSize ? { cellSize: e.cellSize } : {}) }))
    .sort((a, b) => (a.out < b.out ? -1 : 1));
  writeJson(layoutFile, { ...atlas.toLayout(), sources });
  if (atlas.stale.size) warn(`${atlas.stale.size} atlas island(s) are no longer used by any module; they keep their place (delete ${path.relative(assetsDir, layoutFile)} to repack from scratch)`);
  const reemitted = consumers.filter((e) => e.recorded).length;
  log(`  atlas "${atlasName}": ${atlas.islands.size} island(s) on ${atlas.pages.length} page(s) of ${atlas.pageSize}px; ${consumers.length} module(s) written${reemitted ? ` (${reemitted} re-emitted from earlier packs)` : ""}`);
  return { atlas, layoutFile, pages, consumers };
}

/**
 * Put plain props on a project atlas: every .glb/.gltf in `srcDir` is rewritten to
 * `<out>/<name>.gltf` under assets/. Sources must stay where they are (a re-pack reads
 * them again), so `out` cannot be the source folder.
 */
export function packProps({ srcDir, assetsDir, atlasName, out, pageSize, pad, log = () => {} }) {
  const warnings = [];
  const warn = (m) => {
    warnings.push(m);
    log(`  ! ${m}`);
  };
  const files = listModels(path.resolve(srcDir));
  if (files.length === 0) throw new Error(`no .glb/.gltf props in ${srcDir}`);
  const outDir = out.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
  if (path.resolve(assetsDir, outDir) === path.resolve(srcDir)) throw new Error("--out must differ from the source folder: a re-pack reads the originals again");
  const entries = files.map((file) => {
    const analyzed = analyzeProp(file, warn);
    return { file, out: `${outDir}/${analyzed.part.name}.gltf`, kind: "prop", analyzed };
  });
  log(`pack ${files.length} prop(s) onto atlas "${atlasName}" → ${outDir}/`);
  for (const e of entries) log(`  ${e.analyzed.part.name.padEnd(24)} ${e.analyzed.part.bounds.size.map((v) => v.toFixed(2)).join(" x ")}  ${(e.analyzed.g.doc.materials ?? []).length} material(s)`);
  const packed = packAtlas({ assetsDir: path.resolve(assetsDir), atlasName: slug(atlasName), pageSize, pad, entries, log, warn });
  return { atlasName: slug(atlasName), written: entries.map((e) => e.out), pages: packed.atlas.pages.length, islands: packed.atlas.islands.size, warnings };
}

// ---------------------------------------------------------------------------
// Examples → placements → cell compositions

export function readExample(file, parts, cellSize, warn) {
  const g = readGltf(file);
  const nodes = sceneNodes(g);
  const worldByIndex = new Map(nodes.map((n) => [n.index, n.world]));
  const byName = new Map(parts.map((p) => [p.name, p]));
  const byFingerprint = new Map(parts.map((p) => [p.fingerprint, p]));
  const claimed = new Set();
  const placements = [];
  const unmatched = [];
  for (const n of nodes) {
    if (claimed.has(n.index)) continue;
    const raw = n.node.name ?? "";
    let part = byName.get(slug(raw)) ?? byName.get(stripCopySuffix(raw)) ?? null;
    let how = "name";
    if (!part && n.node.mesh !== undefined) {
      const s = subtreeGeometryStats(g, n.index, (i) => worldByIndex.get(i));
      if (s.min) {
        const size = s.max.map((v, i) => v - s.min[i]);
        part = byFingerprint.get(fingerprintOf(s.vertices, s.indices, size)) ?? null;
        how = "geometry";
      }
    }
    if (!part) {
      if (n.node.mesh !== undefined) unmatched.push(raw || `node ${n.index}`);
      continue;
    }
    for (const i of subtreeIndices(g, n.index)) claimed.add(i);
    const m = n.world;
    if (mat4Det3(m) < 0) {
      warn(`${path.basename(file)}: "${raw}" is MIRRORED — the solver can only rotate; skipped (supply a mirrored part instead)`);
      continue;
    }
    const yaw = mat4YawDegrees(m);
    const rotation = norm360(Math.round(yaw / 90) * 90);
    const drift = Math.abs(((yaw - rotation + 540) % 360) - 180);
    if (drift > 5) warn(`${path.basename(file)}: "${raw}" is rotated ${yaw.toFixed(1)}°, snapped to ${rotation}°`);
    const origin = [m[12], m[13], m[14]];
    let cell = origin.map((v, i) => Math.round(v / cellSize[i]));
    const offGrid = origin.some((v, i) => Math.abs(v / cellSize[i] - cell[i]) > 0.2);
    if (offGrid) {
      const s = subtreeGeometryStats(g, n.index, (i) => worldByIndex.get(i));
      const centre = s.min ? s.max.map((v, i) => (v + s.min[i]) / 2) : origin;
      cell = [Math.round(centre[0] / cellSize[0]), Math.floor((s.min ? s.min[1] : origin[1]) / cellSize[1] + 0.25), Math.round(centre[2] / cellSize[2])];
      warn(`${path.basename(file)}: "${raw}" origin ${origin.map((v) => v.toFixed(2)).join(", ")} is off the cell grid; placed by its bounds into cell ${cell.join(",")}`);
    }
    placements.push({ part: part.name, cell, rotation: part.symmetric ? 0 : rotation, node: raw, matchedBy: how });
  }
  return { file, placements, unmatched };
}

/** A placed part's slot in its cell after its rotation. */
function slotOf(part, rotation) {
  if (part.role === "edge") return rotateDirection(part.edge, rotation);
  return part.slot;
}

function compositionKey(items) {
  return items.map((it) => `${it.part}@${it.slot}@${it.rotation}`).sort().join("+");
}

function rotateComposition(items, partsByName, turns) {
  return items.map((it) => {
    const part = partsByName.get(it.part);
    const rotation = part.symmetric ? 0 : norm360(it.rotation + 90 * turns);
    return { part: it.part, rotation, slot: slotOf(part, rotation) };
  });
}

/** Face profiles of a composition, in its own orientation. */
export function faceProfiles(items, partsByName) {
  const profiles = {};
  const hasFloor = items.some((it) => partsByName.get(it.part).role === "floor");
  const occupied = items.length > 0;
  for (const d of HORIZONTAL) {
    const edge = items.filter((it) => it.slot === d).map((it) => it.part).sort();
    profiles[d] = edge.length ? edge.join("+") : occupied ? "open" : VOID;
  }
  const tops = items.filter((it) => it.slot === "ceiling").map((it) => it.part).sort();
  profiles.py = tops.length ? tops.join("+") : occupied ? "open-top" : VOID;
  const bottoms = items.filter((it) => it.slot === "floor").map((it) => it.part).sort();
  profiles.ny = bottoms.length ? bottoms.join("+") : occupied ? (hasFloor ? "open-bottom" : "open-bottom") : VOID;
  return profiles;
}

function shortHash(text) {
  return crypto.createHash("sha1").update(text).digest("hex").slice(0, 6);
}

function tileIdFor(items, canonicalKey) {
  const counts = new Map();
  for (const it of items) counts.set(it.part, (counts.get(it.part) ?? 0) + 1);
  const summary = [...counts]
    .sort()
    .map(([part, n]) => (n > 1 ? `${part}${n}` : part))
    .join("-")
    .slice(0, 48)
    .replace(/-+$/, "");
  return `${summary}-${shortHash(canonicalKey)}`;
}

/**
 * Learn cell types and allowed face pairs from placements. Every cell in the
 * examples' bounding box plus a one-cell margin counts, so "wall next to
 * nothing" and "floor over nothing" (the ground) are learned from the void.
 */
export function learnFromExamples(examples, parts, warn) {
  const partsByName = new Map(parts.map((p) => [p.name, p]));
  const tiles = new Map(); // canonicalKey → { id, items, count, rotations }
  const horizontal = new Set();
  const vertical = new Set();
  let voidCount = 0;
  const observations = [];

  for (const example of examples) {
    if (example.placements.length === 0) continue;
    const cells = new Map();
    for (const p of example.placements) {
      const key = p.cell.join(",");
      const part = partsByName.get(p.part);
      if (!cells.has(key)) cells.set(key, []);
      cells.get(key).push({ part: p.part, rotation: p.rotation, slot: slotOf(part, p.rotation) });
    }
    const lo = [Infinity, Infinity, Infinity];
    const hi = [-Infinity, -Infinity, -Infinity];
    for (const p of example.placements) {
      for (let i = 0; i < 3; i++) {
        lo[i] = Math.min(lo[i], p.cell[i]);
        hi[i] = Math.max(hi[i], p.cell[i]);
      }
    }
    const profileAt = new Map();
    const itemsAt = (x, y, z) => cells.get(`${x},${y},${z}`) ?? [];
    for (let y = lo[1] - 1; y <= hi[1] + 1; y++) {
      for (let z = lo[2] - 1; z <= hi[2] + 1; z++) {
        for (let x = lo[0] - 1; x <= hi[0] + 1; x++) {
          const items = itemsAt(x, y, z);
          profileAt.set(`${x},${y},${z}`, faceProfiles(items, partsByName));
          const inside = x >= lo[0] && x <= hi[0] && y >= lo[1] && y <= hi[1] && z >= lo[2] && z <= hi[2];
          if (items.length === 0) {
            if (inside) voidCount += 1;
            continue;
          }
          // canonicalize under the four Y rotations
          let best = null;
          const keys = [];
          for (let k = 0; k < 4; k++) {
            const rotated = rotateComposition(items, partsByName, k);
            const key = compositionKey(rotated);
            keys.push(key);
            if (best === null || key < best.key) best = { key, items: rotated, k };
          }
          const variantRotation = norm360(90 * ((4 - best.k) % 4));
          if (!tiles.has(best.key)) {
            const distinct = [];
            const seenKeys = new Set();
            for (let r = 0; r < 4; r++) {
              const key = compositionKey(rotateComposition(best.items, partsByName, r));
              if (seenKeys.has(key)) continue;
              seenKeys.add(key);
              distinct.push(r * 90);
            }
            tiles.set(best.key, { id: tileIdFor(best.items, best.key), items: best.items, count: 0, rotations: distinct });
          }
          const tile = tiles.get(best.key);
          tile.count += 1;
          observations.push({ example: path.basename(example.file), cell: [x, y, z], tile: tile.id, rotation: variantRotation });
        }
      }
    }
    // pairs, each touching pair once
    for (let y = lo[1] - 1; y <= hi[1] + 1; y++) {
      for (let z = lo[2] - 1; z <= hi[2] + 1; z++) {
        for (let x = lo[0] - 1; x <= hi[0] + 1; x++) {
          const a = profileAt.get(`${x},${y},${z}`);
          const px = profileAt.get(`${x + 1},${y},${z}`);
          const pz = profileAt.get(`${x},${y},${z + 1}`);
          const py = profileAt.get(`${x},${y + 1},${z}`);
          if (px) horizontal.add(`${a.px}|${px.nx}`);
          if (pz) horizontal.add(`${a.pz}|${pz.nz}`);
          if (py) vertical.add(`${a.py}|${py.ny}`);
        }
      }
    }
  }
  if (tiles.size === 0) warn("no example placed any part — the tileset has only the void tile");
  // symmetric closure for horizontal pairs; drop the void|void pairs the margin always produces? No: void next to void is legal and needed.
  const horizontalPairs = [...horizontal].map((s) => s.split("|"));
  const verticalPairs = [...vertical].map((s) => s.split("|"));
  const ids = new Set();
  for (const tile of tiles.values()) {
    if (ids.has(tile.id)) throw new Error(`tile id collision "${tile.id}"`);
    ids.add(tile.id);
  }
  return { tiles: [...tiles.values()], horizontal: horizontalPairs, vertical: verticalPairs, voidCount, observations };
}

// ---------------------------------------------------------------------------
// Output documents

function childIdsFor(items) {
  const used = new Map();
  return items.map((it) => {
    const base = it.slot === "floor" || it.slot === "ceiling" ? it.slot : it.slot === "fill" ? "fill" : `${it.part.split("-")[0]}-${it.slot}`;
    const n = (used.get(base) ?? 0) + 1;
    used.set(base, n);
    return n === 1 ? base : `${base}-${n}`;
  });
}

export function cellPrefab(tile, partsByName, kit, assetIdFor) {
  const ids = childIdsFor(tile.items);
  const entities = {
    root: { name: tile.id, parent: null, tags: ["wfc-cell", `wfc-kit:${kit}`], components: { transform: {} }, locked: false },
  };
  tile.items.forEach((it, i) => {
    const part = partsByName.get(it.part);
    const b = part.bounds;
    entities[ids[i]] = {
      name: it.part,
      parent: "root",
      tags: [`wfc-part:${it.part}`],
      components: {
        transform: { position: [0, 0, 0], rotation: yawQuaternion(it.rotation) },
        mesh: {
          source: { kind: "asset", assetId: assetIdFor(part) },
          renderMode: "instanced",
          lod: false,
          castShadow: true,
          receiveShadow: true,
        },
        collider: { shape: "box", size: b.size.map((v) => Math.max(v, 0.01)), offset: b.centre },
      },
      locked: false,
    };
  });
  const alignUv = tile.items
    .map((it, i) => ({ it, id: ids[i] }))
    .filter(({ it }) => partsByName.get(it.part).uvAlign)
    .map(({ it, id }) => ({ child: id, factor: partsByName.get(it.part).uvAlign.factor }));
  return { prefab: { version: 1, name: tile.id, root: "root", entities, props: {} }, alignUv };
}

export function tilesetDoc({ kit, cellSize, learned, partsByName, prefabIdFor }) {
  const tiles = learned.tiles.map((tile) => {
    const { alignUv } = cellPrefab(tile, partsByName, kit, () => "");
    return {
      id: tile.id,
      prefabId: prefabIdFor(tile),
      weight: tile.count,
      rotations: tile.rotations,
      sockets: faceProfiles(tile.items, partsByName),
      ...(alignUv.length ? { alignUv } : {}),
      parts: tile.items.map((it) => `${it.part}@${it.slot}@${it.rotation}`),
    };
  });
  tiles.push({
    id: VOID,
    weight: Math.max(1, learned.voidCount),
    rotations: [0],
    sockets: { px: VOID, nx: VOID, py: VOID, ny: VOID, pz: VOID, nz: VOID },
  });
  return {
    version: 1,
    name: `${kit} (learned)`,
    kit,
    cellSize,
    outside: VOID,
    adjacency: { horizontal: learned.horizontal.sort(), vertical: learned.vertical.sort() },
    tiles,
  };
}

// ---------------------------------------------------------------------------
// Commands

function listModels(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => /\.(glb|gltf)$/i.test(f))
    .sort()
    .map((f) => path.join(dir, f));
}

function writeJson(file, doc) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(doc, null, 2) + "\n");
}

/**
 * @param {{ kitDir: string, assetsDir: string, kit?: string, atlas?: string, cellSize: number[], examplesDir?: string, pageSize?: number, pad?: number, log?: (s: string) => void }} options
 */
export async function importKit(options) {
  const log = options.log ?? (() => {});
  const warnings = [];
  const warn = (message) => {
    warnings.push(message);
    log(`  ! ${message}`);
  };
  const kitDir = path.resolve(options.kitDir);
  const kit = slug(options.kit ?? path.basename(kitDir));
  if (!kit) throw new Error("kit id is empty");
  const cellSize = options.cellSize;
  const assetsDir = path.resolve(options.assetsDir);
  const examplesDir = options.examplesDir ? path.resolve(options.examplesDir) : path.join(kitDir, "examples");

  const partFiles = listModels(kitDir);
  if (partFiles.length === 0) throw new Error(`no .glb/.gltf parts in ${kitDir}`);
  log(`kit "${kit}" — ${partFiles.length} part(s), cell ${cellSize.join(" x ")}`);
  const analyzed = partFiles.map((file) => analyzePart(file, cellSize, warn));
  const parts = analyzed.map((a) => a.part);
  const partsByName = new Map(parts.map((p) => [p.name, p]));
  for (const p of parts) {
    log(`  ${p.name.padEnd(24)} ${p.role.padEnd(8)} ${p.slot ? `slot ${p.slot}`.padEnd(10) : "".padEnd(10)} ${p.bounds.size.map((v) => v.toFixed(2)).join(" x ")}${p.uvAlign ? `  uv factor ${p.uvAlign.factor > 0 ? "+1" : "-1"}` : ""}`);
  }

  // atlas — shared by name across kits and props (`--atlas`; defaults to the kit id)
  const atlasName = slug(options.atlas ?? kit);
  const packed = packAtlas({
    assetsDir,
    atlasName,
    pageSize: options.pageSize,
    pad: options.pad,
    entries: analyzed.map((entry) => ({ file: entry.part.file, out: `models/wfc/${kit}/${entry.part.name}.gltf`, kind: "part", cellSize, analyzed: entry })),
    log,
    warn,
  });
  const { atlas, layoutFile } = packed;

  // examples
  const exampleFiles = listModels(examplesDir);
  const examples = exampleFiles.map((file) => {
    const ex = readExample(file, parts, cellSize, warn);
    log(`  example ${path.basename(file)}: ${ex.placements.length} placement(s)${ex.unmatched.length ? `, ${ex.unmatched.length} unmatched node(s): ${ex.unmatched.slice(0, 6).join(", ")}` : ""}`);
    if (ex.unmatched.length) warn(`${path.basename(file)}: ${ex.unmatched.length} mesh node(s) match no part by name or geometry: ${ex.unmatched.slice(0, 10).join(", ")}`);
    return ex;
  });
  if (exampleFiles.length === 0) warn(`no examples in ${examplesDir} — nothing to learn; the tileset only has the void tile`);
  const learned = learnFromExamples(examples, parts, warn);
  log(`  learned ${learned.tiles.length} cell type(s), ${learned.horizontal.length} horizontal + ${learned.vertical.length} vertical face pair(s)`);

  // prefabs + tileset
  const assetIdFor = (part) => `wfc/${kit}/${part.name}.gltf`;
  const prefabIdFor = (tile) => `wfc/${kit}/${tile.id}`;
  const prefabsDir = path.join(assetsDir, "prefabs", "wfc", kit);
  fs.rmSync(prefabsDir, { recursive: true, force: true });
  for (const tile of learned.tiles) {
    const { prefab } = cellPrefab(tile, partsByName, kit, assetIdFor);
    writeJson(path.join(prefabsDir, `${tile.id}.json`), prefab);
  }
  const tileset = tilesetDoc({ kit, cellSize, learned, partsByName, prefabIdFor });
  const tilesetFile = path.join(assetsDir, "wfc", `${kit}.tileset.json`);
  writeJson(tilesetFile, tileset);

  const report = {
    version: 1,
    kit,
    cellSize,
    importedAt: new Date().toISOString(),
    source: { kitDir, examplesDir },
    parts: parts.map((p) => ({
      name: p.name,
      file: path.basename(p.file),
      role: p.role,
      slot: p.slot,
      symmetric: p.symmetric,
      assetId: assetIdFor(p),
      bounds: { min: p.bounds.min, max: p.bounds.max },
      ...(p.uvAlign ? { uvAlign: p.uvAlign } : {}),
    })),
    atlas: { name: atlasName, pages: atlas.pages.length, islands: atlas.islands.size, layout: path.relative(assetsDir, layoutFile).replace(/\\/g, "/") },
    examples: examples.map((ex) => ({ file: path.basename(ex.file), placements: ex.placements, unmatched: ex.unmatched })),
    tiles: tileset.tiles.map((t) => ({ id: t.id, weight: t.weight, rotations: t.rotations, parts: t.parts ?? [] })),
    tileset: path.relative(assetsDir, tilesetFile).replace(/\\/g, "/"),
    warnings,
  };
  writeJson(path.join(assetsDir, "wfc", `${kit}.kit.json`), report);
  log(`  wrote ${learned.tiles.length} cell prefab(s), ${path.relative(assetsDir, tilesetFile)}`);
  return report;
}

/**
 * @param {{ assetsDir: string, kit: string, name: string, size: number[], seed?: number, attempts?: number, origin?: "center"|"min", log?: (s: string) => void }} options
 */
export function solveKit(options) {
  const log = options.log ?? (() => {});
  const assetsDir = path.resolve(options.assetsDir);
  const tilesetFile = path.join(assetsDir, "wfc", `${slug(options.kit)}.tileset.json`);
  if (!fs.existsSync(tilesetFile)) throw new Error(`no tileset at ${tilesetFile} — run import first`);
  const raw = JSON.parse(fs.readFileSync(tilesetFile, "utf8"));
  const name = String(options.name).replace(/\\/g, "/").replace(/\.json$/i, "");
  if (!/^[a-z0-9][a-z0-9/_-]*$/.test(name) || name.includes("..")) throw new Error("output name must be a safe path below assets/prefabs");
  const [width, height, depth] = options.size;
  const result = collapseTileset(raw, { width, height, depth, seed: options.seed ?? 1, attempts: options.attempts ?? 20 });
  const prefab = collapsedPrefab(result, path.posix.basename(name), options.origin ?? "center");
  const file = path.join(assetsDir, "prefabs", `${name}.json`);
  writeJson(file, prefab);
  const svgDir = path.join(assetsDir, "..", ".hitreg", "wfc");
  fs.mkdirSync(svgDir, { recursive: true });
  const svgFile = path.join(svgDir, `${name.replace(/\//g, "_")}.svg`);
  fs.writeFileSync(svgFile, previewSvg(result));
  const occupied = result.cells.filter((c) => c.prefabId).length;
  log(`collapsed ${width}x${height}x${depth} on attempt ${result.attempt}: ${occupied} occupied cell(s), ${result.cells.length - occupied} void`);
  log(asciiTopLayer(result));
  log(`wrote prefabs/${name}.json and ${path.relative(assetsDir, svgFile)}`);
  return { file, prefab, result, occupied };
}

function asciiTopLayer(result) {
  const top = new Map();
  for (const cell of result.cells) {
    const key = `${cell.x}:${cell.z}`;
    const prev = top.get(key);
    if (!prev || (cell.prefabId && (!prev.prefabId || cell.y > prev.y))) top.set(key, cell);
  }
  const rows = [];
  for (let z = result.depth - 1; z >= 0; z--) {
    let row = "";
    for (let x = 0; x < result.width; x++) {
      const cell = top.get(`${x}:${z}`);
      row += cell?.prefabId ? "#" : ".";
    }
    rows.push(`    ${row}`);
  }
  return rows.join("\n");
}

export function inspectFile(file, cellSize) {
  const g = readGltf(file);
  const lines = [];
  const stats = fileGeometryStats(g);
  lines.push(`${path.basename(file)}: ${g.doc.nodes?.length ?? 0} node(s), ${g.doc.meshes?.length ?? 0} mesh(es), ${g.doc.materials?.length ?? 0} material(s), ${g.doc.images?.length ?? 0} image(s)`);
  if (stats.min) lines.push(`  bounds ${stats.min.map((v) => v.toFixed(2)).join(", ")} .. ${stats.max.map((v) => v.toFixed(2)).join(", ")}  (${stats.vertices} vertices)`);
  for (const mat of g.doc.materials ?? []) {
    const pbr = mat.pbrMetallicRoughness ?? {};
    const tex = pbr.baseColorTexture ? g.doc.images?.[g.doc.textures[pbr.baseColorTexture.index].source] : null;
    lines.push(`  material "${mat.name ?? ""}" ${tex ? `texture "${tex.name ?? tex.uri?.slice(0, 20) ?? "(embedded)"}"` : `colour ${(pbr.baseColorFactor ?? [1, 1, 1, 1]).map((v) => v.toFixed(2)).join(",")}`}${mat.alphaMode ? ` ${mat.alphaMode}` : ""}${mat.doubleSided ? " double-sided" : ""}`);
  }
  const nodes = sceneNodes(g);
  const worldByIndex = new Map(nodes.map((n) => [n.index, n.world]));
  for (const n of nodes) {
    const m = n.world;
    const s = n.node.mesh !== undefined ? subtreeGeometryStats(g, n.index, (i) => worldByIndex.get(i)) : null;
    const t = [m[12], m[13], m[14]];
    const yaw = mat4YawDegrees(m);
    const cell = cellSize ? ` cell ${t.map((v, i) => (v / cellSize[i]).toFixed(2)).join(",")}` : "";
    lines.push(
      `  ${"  ".repeat(n.depth)}${n.node.name ?? `node ${n.index}`}${n.node.mesh !== undefined ? " [mesh]" : ""} at ${t.map((v) => v.toFixed(2)).join(", ")} yaw ${yaw.toFixed(0)}°${mat4Det3(m) < 0 ? " MIRRORED" : ""}${cell}` +
        (s?.min ? ` size ${s.max.map((v, i) => (v - s.min[i]).toFixed(2)).join(" x ")}` : ""),
    );
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// CLI

function parseArgs(argv) {
  const positional = [];
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        opts[key] = next;
        i++;
      } else opts[key] = "true";
    } else positional.push(a);
  }
  return { positional, opts };
}

function projectAssets(opts) {
  if (opts.assets) return path.resolve(opts.assets);
  if (!opts.project) throw new Error("--project <name> (or --assets <dir>) is required");
  const dir = path.join(REPO, "apps", "playground", "projects", opts.project, "assets");
  if (!fs.existsSync(path.dirname(dir))) throw new Error(`no project at ${path.dirname(dir)}`);
  return dir;
}

const triple = (text, what) => {
  const v = String(text).split(/[,x ]+/).map(Number);
  if (v.length !== 3 || v.some((n) => !Number.isFinite(n) || n <= 0)) throw new Error(`${what} must be three positive numbers, e.g. 4,3,4`);
  return v;
};

async function main() {
  const { positional, opts } = parseArgs(process.argv.slice(2));
  const command = positional[0];
  const log = (s) => console.log(s);
  if (command === "import") {
    if (!positional[1]) throw new Error("usage: kit.mjs import <kitDir> --project <name> --cell x,y,z");
    if (!opts.cell) throw new Error("--cell x,y,z is required (the kit's cell size in metres)");
    const report = await importKit({
      kitDir: positional[1],
      assetsDir: projectAssets(opts),
      kit: opts.kit,
      atlas: opts.atlas,
      cellSize: triple(opts.cell, "--cell"),
      examplesDir: opts.examples,
      pageSize: opts.page ? Number(opts.page) : undefined,
      pad: opts.pad ? Number(opts.pad) : undefined,
      log,
    });
    if (report.warnings.length) console.log(`${report.warnings.length} warning(s) — see wfc/${report.kit}.kit.json`);
    return;
  }
  if (command === "solve") {
    if (!opts.kit || !opts.name || !opts.size) throw new Error("usage: kit.mjs solve --project <name> --kit <id> --name <prefab> --size w,h,d [--seed n]");
    const size = triple(opts.size, "--size").map((v) => Math.round(v));
    solveKit({
      assetsDir: projectAssets(opts),
      kit: opts.kit,
      name: opts.name,
      size,
      seed: opts.seed ? Number(opts.seed) >>> 0 : 1,
      attempts: opts.attempts ? Number(opts.attempts) : 20,
      origin: opts.origin === "min" ? "min" : "center",
      log,
    });
    return;
  }
  if (command === "pack") {
    if (!positional[1] || !opts.atlas || !opts.out) throw new Error("usage: kit.mjs pack <propsDir> --project <name> --atlas <name> --out models/<folder>");
    const result = packProps({
      srcDir: positional[1],
      assetsDir: projectAssets(opts),
      atlasName: opts.atlas,
      out: opts.out,
      pageSize: opts.page ? Number(opts.page) : undefined,
      pad: opts.pad ? Number(opts.pad) : undefined,
      log,
    });
    if (result.warnings.length) console.log(`${result.warnings.length} warning(s)`);
    return;
  }
  if (command === "inspect") {
    if (!positional[1]) throw new Error("usage: kit.mjs inspect <file.glb|gltf> [--cell x,y,z]");
    console.log(inspectFile(positional[1], opts.cell ? triple(opts.cell, "--cell") : null));
    return;
  }
  console.error("usage:\n  kit.mjs import <kitDir> --project <name> --cell x,y,z [--kit id] [--atlas name] [--examples dir]\n  kit.mjs pack <propsDir> --project <name> --atlas <name> --out models/<folder>\n  kit.mjs solve --project <name> --kit <id> --name <prefab> --size w,h,d [--seed n] [--attempts n] [--origin center|min]\n  kit.mjs inspect <file> [--cell x,y,z]");
  process.exit(2);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}

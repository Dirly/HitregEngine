/**
 * The world-space bounding box of a glTF/GLB model, walking its node
 * transforms — zero dependencies, no renderer, no DOM.
 *
 * This is the number every prop decision is keyed off and the one nobody has
 * without opening a viewer: a scatter rule's `footprint`, its `colliderSize`,
 * whether a hoodoo is 18m or 32m tall, and whether the collider the recipe
 * declares is anywhere near the rock it is supposed to be. Raw accessor
 * min/max is NOT that box — a DCC tool nests a prop's parts under nodes with
 * their own rotation and offset (Blockbench does it constantly), so the
 * geometry's own idea of its extent and the space the prop actually occupies
 * are different boxes.
 *
 * Used by `split-gltf.mjs` (to report and to re-origin) and by
 * `worldgen scatter` (to check every rule's collider against its model).
 */
import fs from "node:fs";
import path from "node:path";

/** Parse a .gltf (JSON) or .glb (binary container) into { json, bin }. */
function parse(file) {
  const bytes = fs.readFileSync(file);
  if (bytes.length >= 4 && bytes.readUInt32LE(0) === 0x46546c67) {
    // GLB: 12-byte header, then length-prefixed chunks (JSON first, BIN next)
    let offset = 12;
    let json = null;
    let bin = null;
    while (offset + 8 <= bytes.length) {
      const length = bytes.readUInt32LE(offset);
      const type = bytes.readUInt32LE(offset + 4);
      const body = bytes.subarray(offset + 8, offset + 8 + length);
      if (type === 0x4e4f534a) json = JSON.parse(body.toString("utf8"));
      else if (type === 0x004e4942) bin = body;
      offset += 8 + length + ((4 - (length % 4)) % 4);
    }
    if (!json) throw new Error(`${file}: GLB has no JSON chunk`);
    return { json, bin };
  }
  return { json: JSON.parse(bytes.toString("utf8")), bin: null };
}

/** Node TRS as a column-major 4x4. */
function matrixOf(node) {
  if (node.matrix) return node.matrix.slice();
  const [x, y, z, w] = node.rotation ?? [0, 0, 0, 1];
  const [sx, sy, sz] = node.scale ?? [1, 1, 1];
  const [tx, ty, tz] = node.translation ?? [0, 0, 0];
  const x2 = x + x, y2 = y + y, z2 = z + z;
  const xx = x * x2, xy = x * y2, xz = x * z2;
  const yy = y * y2, yz = y * z2, zz = z * z2;
  const wx = w * x2, wy = w * y2, wz = w * z2;
  return [
    (1 - (yy + zz)) * sx, (xy + wz) * sx, (xz - wy) * sx, 0,
    (xy - wz) * sy, (1 - (xx + zz)) * sy, (yz + wx) * sy, 0,
    (xz + wy) * sz, (yz - wx) * sz, (1 - (xx + yy)) * sz, 0,
    tx, ty, tz, 1,
  ];
}

function multiply(a, b) {
  const out = new Array(16).fill(0);
  for (let c = 0; c < 4; c++)
    for (let r = 0; r < 4; r++)
      for (let k = 0; k < 4; k++) out[c * 4 + r] += a[k * 4 + r] * b[c * 4 + k];
  return out;
}

const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

/**
 * @param {object} doc parsed glTF JSON
 * @param {(index: number) => Buffer} bufferBytes resolves buffer `index`
 * @param {number[]|undefined} roots node indices to walk (default: the scene's)
 */
export function boundsOf(doc, bufferBytes, roots) {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  let triangles = 0;
  const viewBytes = (index) => {
    const view = doc.bufferViews[index];
    const buffer = bufferBytes(view.buffer);
    return buffer.subarray(view.byteOffset ?? 0, (view.byteOffset ?? 0) + view.byteLength);
  };
  const walk = (index, parent) => {
    const node = doc.nodes[index];
    const world = multiply(parent, matrixOf(node));
    if (node.mesh !== undefined) {
      for (const prim of doc.meshes[node.mesh].primitives) {
        const accessor = doc.accessors[prim.attributes.POSITION];
        triangles += (prim.indices !== undefined ? doc.accessors[prim.indices].count : accessor.count) / 3;
        if (accessor.bufferView === undefined) continue;
        const view = doc.bufferViews[accessor.bufferView];
        const bytes = viewBytes(accessor.bufferView);
        const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        const stride = view.byteStride ?? 12;
        for (let i = 0; i < accessor.count; i++) {
          const base = (accessor.byteOffset ?? 0) + i * stride;
          const px = dv.getFloat32(base, true);
          const py = dv.getFloat32(base + 4, true);
          const pz = dv.getFloat32(base + 8, true);
          const p = [
            world[0] * px + world[4] * py + world[8] * pz + world[12],
            world[1] * px + world[5] * py + world[9] * pz + world[13],
            world[2] * px + world[6] * py + world[10] * pz + world[14],
          ];
          for (let c = 0; c < 3; c++) {
            if (p[c] < min[c]) min[c] = p[c];
            if (p[c] > max[c]) max[c] = p[c];
          }
        }
      }
    }
    for (const child of node.children ?? []) walk(child, world);
  };
  for (const root of roots ?? doc.scenes[doc.scene ?? 0].nodes) walk(root, IDENTITY);
  return {
    min,
    max,
    size: max.map((v, i) => v - min[i]),
    triangles: Math.round(triangles),
    /** Radius of the footprint circle the prop actually occupies on the ground. */
    radius: Math.max(max[0] - min[0], max[2] - min[2]) / 2,
  };
}

/** Bounds of a model on disk, including the textures' names (which drive the wind filter). */
export function modelBounds(file) {
  const { json, bin } = parse(file);
  const dir = path.dirname(file);
  const cache = new Map();
  const bufferBytes = (index) => {
    if (cache.has(index)) return cache.get(index);
    const buffer = json.buffers[index];
    let bytes;
    if (buffer.uri === undefined) bytes = bin;
    else if (buffer.uri.startsWith("data:")) bytes = Buffer.from(buffer.uri.slice(buffer.uri.indexOf(",") + 1), "base64");
    else bytes = fs.readFileSync(path.join(dir, decodeURIComponent(buffer.uri)));
    cache.set(index, bytes);
    return bytes;
  };
  const result = boundsOf(json, bufferBytes);
  result.textures = (json.textures ?? []).map((t) => t.name ?? "");
  return result;
}

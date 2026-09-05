/**
 * Zero-dependency glTF 2.0 reader/writer for the WFC kit pipeline.
 *
 * Reads `.glb` and `.gltf` (embedded data URIs or sidecar files), exposes
 * accessor data as typed arrays, walks node world transforms, and re-emits a
 * SELF-CONTAINED `.gltf` (one embedded buffer, data-URI images) — the only
 * form the playground asset bridge resolves. Static meshes only: skins,
 * animations and sparse accessors are refused loudly rather than dropped
 * silently, because a kit module with either is an authoring mistake.
 */
import fs from "node:fs";
import path from "node:path";

const GLB_MAGIC = 0x46546c67;
const CHUNK_JSON = 0x4e4f534a;
const CHUNK_BIN = 0x004e4942;

export const COMPONENT_BYTES = { 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 };
export const TYPE_COUNT = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT2: 4, MAT3: 9, MAT4: 16 };
const ARRAY_FOR = {
  5120: Int8Array,
  5121: Uint8Array,
  5122: Int16Array,
  5123: Uint16Array,
  5125: Uint32Array,
  5126: Float32Array,
};

/** @returns {{ doc: any, buffers: Buffer[], dir: string, file: string }} */
export function readGltf(file) {
  const bytes = fs.readFileSync(file);
  const dir = path.dirname(file);
  if (bytes.length >= 12 && bytes.readUInt32LE(0) === GLB_MAGIC) {
    let offset = 12;
    let doc = null;
    let bin = null;
    while (offset + 8 <= bytes.length) {
      const length = bytes.readUInt32LE(offset);
      const type = bytes.readUInt32LE(offset + 4);
      const chunk = bytes.subarray(offset + 8, offset + 8 + length);
      if (type === CHUNK_JSON) doc = JSON.parse(chunk.toString("utf8"));
      else if (type === CHUNK_BIN) bin = chunk;
      offset += 8 + length;
    }
    if (!doc) throw new Error(`${file}: GLB has no JSON chunk`);
    const buffers = (doc.buffers ?? []).map((b, i) => {
      if (b.uri === undefined) {
        if (!bin) throw new Error(`${file}: buffer ${i} expects the GLB BIN chunk, which is missing`);
        return bin;
      }
      return decodeBufferUri(b.uri, dir, file);
    });
    return { doc, buffers, dir, file };
  }
  const doc = JSON.parse(bytes.toString("utf8"));
  const buffers = (doc.buffers ?? []).map((b, i) => {
    if (b.uri === undefined) throw new Error(`${file}: buffer ${i} has no uri and this is not a GLB`);
    return decodeBufferUri(b.uri, dir, file);
  });
  return { doc, buffers, dir, file };
}

function decodeBufferUri(uri, dir, file) {
  if (uri.startsWith("data:")) return Buffer.from(uri.slice(uri.indexOf(",") + 1), "base64");
  const sidecar = path.join(dir, decodeURIComponent(uri));
  if (!fs.existsSync(sidecar)) throw new Error(`${file}: buffer sidecar "${uri}" not found`);
  return fs.readFileSync(sidecar);
}

/** Bytes of one buffer view. */
export function viewBytes(g, index) {
  const view = g.doc.bufferViews[index];
  const buffer = g.buffers[view.buffer];
  const start = view.byteOffset ?? 0;
  return buffer.subarray(start, start + view.byteLength);
}

/**
 * An accessor's data as a fresh, tightly packed typed array of
 * `count * components` elements (strided sources are de-interleaved).
 */
export function accessorArray(g, index) {
  const accessor = g.doc.accessors[index];
  if (accessor.sparse) throw new Error("sparse accessors are not supported");
  const n = TYPE_COUNT[accessor.type];
  const Array = ARRAY_FOR[accessor.componentType];
  const size = COMPONENT_BYTES[accessor.componentType];
  const out = new Array(accessor.count * n);
  if (accessor.bufferView === undefined) return out; // all zeros per spec
  const view = g.doc.bufferViews[accessor.bufferView];
  const bytes = viewBytes(g, accessor.bufferView);
  const stride = view.byteStride ?? n * size;
  const base = accessor.byteOffset ?? 0;
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const little = true;
  for (let i = 0; i < accessor.count; i++) {
    const row = base + i * stride;
    for (let c = 0; c < n; c++) {
      const at = row + c * size;
      let v;
      switch (accessor.componentType) {
        case 5126: v = dv.getFloat32(at, little); break;
        case 5125: v = dv.getUint32(at, little); break;
        case 5123: v = dv.getUint16(at, little); break;
        case 5122: v = dv.getInt16(at, little); break;
        case 5121: v = dv.getUint8(at); break;
        default: v = dv.getInt8(at);
      }
      out[i * n + c] = v;
    }
  }
  return out;
}

/** Normalized-integer UV accessors are rare but legal; hand back floats. */
export function accessorFloats(g, index) {
  const accessor = g.doc.accessors[index];
  const raw = accessorArray(g, index);
  if (accessor.componentType === 5126) return raw;
  const out = new Float32Array(raw.length);
  const max = accessor.componentType === 5121 ? 255 : accessor.componentType === 5123 ? 65535 : 1;
  for (let i = 0; i < raw.length; i++) out[i] = accessor.normalized ? raw[i] / max : raw[i];
  return out;
}

/** @returns {{ bytes: Buffer, mimeType: string, name: string }} */
export function imageBytes(g, index) {
  const image = g.doc.images[index];
  const name = image.name ?? `image${index}`;
  if (image.bufferView !== undefined) {
    return { bytes: Buffer.from(viewBytes(g, image.bufferView)), mimeType: image.mimeType ?? "image/png", name };
  }
  if (typeof image.uri === "string") {
    if (image.uri.startsWith("data:")) {
      const header = image.uri.slice(5, image.uri.indexOf(";"));
      return { bytes: Buffer.from(image.uri.slice(image.uri.indexOf(",") + 1), "base64"), mimeType: header, name };
    }
    const sidecar = path.join(g.dir, decodeURIComponent(image.uri));
    if (!fs.existsSync(sidecar)) throw new Error(`${g.file}: image sidecar "${image.uri}" not found`);
    const ext = path.extname(sidecar).toLowerCase();
    return { bytes: fs.readFileSync(sidecar), mimeType: ext === ".jpg" ? "image/jpeg" : `image/${ext.slice(1)}`, name };
  }
  throw new Error(`${g.file}: image ${index} has neither bufferView nor uri`);
}

// ---------------------------------------------------------------------------
// 4x4 column-major matrices (glTF / three layout)

export const IDENTITY = Object.freeze([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);

export function mat4Multiply(a, b) {
  const out = new Array(16);
  for (let col = 0; col < 4; col++) {
    for (let row = 0; row < 4; row++) {
      let sum = 0;
      for (let k = 0; k < 4; k++) sum += a[k * 4 + row] * b[col * 4 + k];
      out[col * 4 + row] = sum;
    }
  }
  return out;
}

export function mat4FromTRS(t = [0, 0, 0], q = [0, 0, 0, 1], s = [1, 1, 1]) {
  const [x, y, z, w] = q;
  const xx = x * x, yy = y * y, zz = z * z;
  const xy = x * y, xz = x * z, yz = y * z, wx = w * x, wy = w * y, wz = w * z;
  const m = [
    (1 - 2 * (yy + zz)) * s[0], (2 * (xy + wz)) * s[0], (2 * (xz - wy)) * s[0], 0,
    (2 * (xy - wz)) * s[1], (1 - 2 * (xx + zz)) * s[1], (2 * (yz + wx)) * s[1], 0,
    (2 * (xz + wy)) * s[2], (2 * (yz - wx)) * s[2], (1 - 2 * (xx + yy)) * s[2], 0,
    t[0], t[1], t[2], 1,
  ];
  return m;
}

export function nodeLocalMatrix(node) {
  if (node.matrix) return [...node.matrix];
  return mat4FromTRS(node.translation, node.rotation, node.scale);
}

export function transformPoint(m, p) {
  const x = p[0], y = p[1], z = p[2];
  return [
    m[0] * x + m[4] * y + m[8] * z + m[12],
    m[1] * x + m[5] * y + m[9] * z + m[13],
    m[2] * x + m[6] * y + m[10] * z + m[14],
  ];
}

/** Determinant of the upper-left 3x3: negative means a mirrored transform. */
export function mat4Det3(m) {
  return (
    m[0] * (m[5] * m[10] - m[9] * m[6]) -
    m[4] * (m[1] * m[10] - m[9] * m[2]) +
    m[8] * (m[1] * m[6] - m[5] * m[2])
  );
}

/**
 * Yaw about +Y in DEGREES, three's convention: a rotation by θ maps the local
 * +X axis to (cos θ, 0, −sin θ). Read from the transformed X axis so a scale
 * on the node does not change the answer.
 */
export function mat4YawDegrees(m) {
  const deg = (Math.atan2(-m[2], m[0]) * 180) / Math.PI;
  return ((deg % 360) + 360) % 360;
}

/** Quaternion [x, y, z, w] for a yaw about +Y in degrees (matches wfc.mjs). */
export function yawQuaternion(degrees) {
  const half = (degrees * Math.PI) / 360;
  const y = Math.sin(half);
  const w = Math.cos(half);
  return [0, Math.abs(y) < 1e-12 ? 0 : y, 0, Math.abs(w) < 1e-12 ? 0 : w];
}

/**
 * Every node of the default scene with its world matrix, depth-first, with
 * parent links — the example reader walks this to find placed parts.
 * @returns {{ index: number, node: any, world: number[], parent: number | null, depth: number }[]}
 */
export function sceneNodes(g) {
  const doc = g.doc;
  const scene = doc.scenes?.[doc.scene ?? 0];
  const roots = scene?.nodes ?? doc.nodes?.map((_, i) => i) ?? [];
  const out = [];
  const visit = (index, parentWorld, parent, depth) => {
    const node = doc.nodes[index];
    const world = mat4Multiply(parentWorld, nodeLocalMatrix(node));
    out.push({ index, node, world, parent, depth });
    for (const child of node.children ?? []) visit(child, world, index, depth + 1);
  };
  for (const root of roots) visit(root, [...IDENTITY], null, 0);
  return out;
}

/** Node indices of `index`'s whole subtree, itself included. */
export function subtreeIndices(g, index) {
  const out = [];
  const visit = (i) => {
    out.push(i);
    for (const child of g.doc.nodes[i].children ?? []) visit(child);
  };
  visit(index);
  return out;
}

/**
 * Axis-aligned bounds and vertex/index totals of the meshes in a node subtree,
 * in the space `worldOf(nodeIndex)` maps into. `min`/`max` are `null` when
 * the subtree has no geometry.
 */
export function subtreeGeometryStats(g, rootIndex, worldOf) {
  const stats = emptyStats();
  for (const index of subtreeIndices(g, rootIndex)) {
    const node = g.doc.nodes[index];
    if (node.mesh === undefined) continue;
    accumulateMesh(g, node.mesh, worldOf(index), stats);
  }
  return finishStats(stats);
}

/** Whole-file stats in the file's own scene space. */
export function fileGeometryStats(g) {
  const stats = emptyStats();
  for (const n of sceneNodes(g)) {
    if (n.node.mesh === undefined) continue;
    accumulateMesh(g, n.node.mesh, n.world, stats);
  }
  return finishStats(stats);
}

function emptyStats() {
  return { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity], vertices: 0, indices: 0 };
}

function finishStats(stats) {
  return stats.vertices === 0 ? { ...stats, min: null, max: null } : stats;
}

function accumulateMesh(g, meshIndex, world, stats) {
  for (const prim of g.doc.meshes[meshIndex].primitives) {
    const posIndex = prim.attributes?.POSITION;
    if (posIndex === undefined) continue;
    const pos = accessorFloats(g, posIndex);
    stats.vertices += pos.length / 3;
    if (prim.indices !== undefined) stats.indices += g.doc.accessors[prim.indices].count;
    for (let i = 0; i < pos.length; i += 3) {
      const p = transformPoint(world, [pos[i], pos[i + 1], pos[i + 2]]);
      for (let c = 0; c < 3; c++) {
        if (p[c] < stats.min[c]) stats.min[c] = p[c];
        if (p[c] > stats.max[c]) stats.max[c] = p[c];
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Writing

/**
 * Incremental builder for a self-contained glTF: push raw bytes as buffer
 * views, typed arrays as accessors, PNG bytes as images, then `finish()`.
 */
export class GltfBuilder {
  constructor(generator) {
    this.doc = {
      asset: { version: "2.0", generator },
      scene: 0,
      scenes: [{ nodes: [] }],
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
    this.chunks = [];
    this.byteLength = 0;
  }

  pushView(bytes, extra = {}) {
    const pad = (4 - (this.byteLength % 4)) % 4;
    if (pad) {
      this.chunks.push(Buffer.alloc(pad));
      this.byteLength += pad;
    }
    const view = { buffer: 0, byteOffset: this.byteLength, byteLength: bytes.byteLength, ...extra };
    this.chunks.push(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength));
    this.byteLength += bytes.byteLength;
    this.doc.bufferViews.push(view);
    return this.doc.bufferViews.length - 1;
  }

  /** @param {Float32Array|Uint16Array|Uint32Array|Uint8Array} array */
  pushAccessor(array, type, { target, normalized, minMax } = {}) {
    const componentType =
      array instanceof Float32Array ? 5126
      : array instanceof Uint32Array ? 5125
      : array instanceof Uint16Array ? 5123
      : array instanceof Uint8Array ? 5121
      : null;
    if (componentType === null) throw new Error("unsupported accessor array type");
    const n = TYPE_COUNT[type];
    const view = this.pushView(array, target !== undefined ? { target } : {});
    const accessor = { bufferView: view, componentType, count: array.length / n, type };
    if (normalized) accessor.normalized = true;
    if (minMax) {
      const min = new Array(n).fill(Infinity);
      const max = new Array(n).fill(-Infinity);
      for (let i = 0; i < array.length; i += n) {
        for (let c = 0; c < n; c++) {
          if (array[i + c] < min[c]) min[c] = array[i + c];
          if (array[i + c] > max[c]) max[c] = array[i + c];
        }
      }
      accessor.min = min;
      accessor.max = max;
    }
    this.doc.accessors.push(accessor);
    return this.doc.accessors.length - 1;
  }

  pushImage(pngBytes, name) {
    this.doc.images.push({ name, mimeType: "image/png", uri: `data:image/png;base64,${Buffer.from(pngBytes).toString("base64")}` });
    return this.doc.images.length - 1;
  }

  pushSampler(sampler) {
    this.doc.samplers.push(sampler);
    return this.doc.samplers.length - 1;
  }

  pushTexture(texture) {
    this.doc.textures.push(texture);
    return this.doc.textures.length - 1;
  }

  pushMaterial(material) {
    this.doc.materials.push(material);
    return this.doc.materials.length - 1;
  }

  pushMesh(mesh) {
    this.doc.meshes.push(mesh);
    return this.doc.meshes.length - 1;
  }

  pushNode(node, isRoot) {
    this.doc.nodes.push(node);
    const index = this.doc.nodes.length - 1;
    if (isRoot) this.doc.scenes[0].nodes.push(index);
    return index;
  }

  /** The finished document (JSON-serializable), with one embedded buffer. */
  finish() {
    const buffer = Buffer.concat(this.chunks);
    this.doc.buffers = [{ byteLength: buffer.byteLength, uri: `data:application/octet-stream;base64,${buffer.toString("base64")}` }];
    for (const key of ["materials", "textures", "images", "samplers"]) {
      if (this.doc[key].length === 0) delete this.doc[key];
    }
    return this.doc;
  }
}

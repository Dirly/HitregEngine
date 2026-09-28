/**
 * Collision geometry straight from glTF bytes — no Three.js, no DOM.
 *
 * The browser cooks trimesh/convex colliders from the model its renderer
 * loaded (@hitreg/render `extractCollisionGeometry`). A headless host (the
 * dedicated server, a Node tool) has no GLTFLoader, and without geometry the
 * sim falls back to a `collider.size` box at the entity origin — so every
 * asset trimesh simply did not exist on the authority while the client stood
 * on it. This reader is the headless half of that contract and produces the
 * SAME triangles as `extractCollisionGeometry`: every triangle primitive under
 * the scene (or under the named node), each with its transform relative to
 * that start node baked into the vertices. World placement and scale stay the
 * physics body's job.
 *
 * Supported: .glb (and .gltf JSON with a buffer loader), float and quantized
 * (KHR_mesh_quantization, normalized or not) positions, u8/u16/u32 or absent
 * indices, strided buffer views, sparse accessors, node matrix or TRS,
 * triangle strips and fans. Draco and meshopt compression are not decoded —
 * the reader throws, and the caller falls back (with a warning) to a box.
 */

import type { MeshGeometryData } from "./sim.js";

export interface GltfGeometryOptions {
  /** Extract only this node's subtree (its own transform excluded, like
   * `extractCollisionGeometry(root, node)`). Matched against the raw glTF
   * node name and Three's sanitized form of it. */
  node?: string;
  /** Bytes of an external buffer (`buffers[i].uri` that is not a data URI) —
   * needed only for .gltf files; a .glb carries its buffer inline. */
  loadBuffer?: (uri: string) => Uint8Array;
}

const GLB_MAGIC = 0x46546c67; // "glTF"
const CHUNK_JSON = 0x4e4f534a;
const CHUNK_BIN = 0x004e4942;

/* eslint-disable @typescript-eslint/no-explicit-any -- raw glTF JSON */
type Gltf = any;

/**
 * Parse glTF/GLB bytes into collision geometry. Returns null when there is
 * nothing to collide with (no triangle primitives, or the named node is
 * missing); throws on malformed or unsupported (compressed) files.
 */
export function gltfCollisionGeometry(
  bytes: Uint8Array,
  opts: GltfGeometryOptions = {},
): MeshGeometryData | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let json: Gltf;
  let bin: Uint8Array | undefined;
  if (bytes.byteLength >= 12 && view.getUint32(0, true) === GLB_MAGIC) {
    let offset = 12;
    while (offset + 8 <= bytes.byteLength) {
      const length = view.getUint32(offset, true);
      const type = view.getUint32(offset + 4, true);
      const chunk = bytes.subarray(offset + 8, offset + 8 + length);
      if (type === CHUNK_JSON) json = JSON.parse(new TextDecoder().decode(chunk));
      else if (type === CHUNK_BIN && !bin) bin = chunk;
      offset += 8 + length;
    }
    if (!json) throw new Error("GLB has no JSON chunk");
  } else {
    json = JSON.parse(new TextDecoder().decode(bytes));
  }

  const required: string[] = json.extensionsRequired ?? [];
  const compressed = required.filter((e) => /draco|meshopt/i.test(e));
  if (compressed.length > 0) throw new Error(`compressed glTF (${compressed.join(", ")}) is not supported headless`);

  const buffers: Uint8Array[] = (json.buffers ?? []).map((b: { uri?: string }, i: number) => {
    if (b.uri === undefined) {
      if (i !== 0 || !bin) throw new Error(`buffer ${i} has no data`);
      return bin;
    }
    const data = /^data:[^,]*;base64,(.*)$/.exec(b.uri);
    if (data) return base64Bytes(data[1]!);
    if (!opts.loadBuffer) throw new Error(`external buffer "${b.uri}" needs a loadBuffer`);
    return opts.loadBuffer(decodeURIComponent(b.uri));
  });

  const nodes: Gltf[] = json.nodes ?? [];
  // start nodes: the named node alone, else the scene's roots (or every
  // parentless node when the file declares no scene)
  let roots: number[];
  if (opts.node !== undefined) {
    const found = findNode(json, opts.node);
    if (found === null) return null;
    roots = [found];
  } else {
    const scene = json.scenes?.[json.scene ?? 0];
    if (scene) roots = scene.nodes ?? [];
    else {
      const child = new Set<number>();
      for (const n of nodes) for (const c of n.children ?? []) child.add(c);
      roots = nodes.map((_, i) => i).filter((i) => !child.has(i));
    }
  }

  const positionsOut: number[] = [];
  const indicesOut: number[] = [];
  const visit = (index: number, parent: Float64Array, isStart: boolean): void => {
    const node = nodes[index];
    if (!node) return;
    // the start node's own transform is excluded when extracting a named
    // subtree (the entity transform places it), included for scene roots
    const world = isStart && opts.node !== undefined ? parent : multiply(parent, localMatrix(node));
    if (node.mesh !== undefined) {
      for (const prim of json.meshes?.[node.mesh]?.primitives ?? []) {
        appendPrimitive(json, buffers, prim, world, positionsOut, indicesOut);
      }
    }
    for (const c of node.children ?? []) visit(c, world, false);
  };
  for (const r of roots) visit(r, IDENTITY, true);

  if (indicesOut.length === 0) return null;
  return { positions: Float32Array.from(positionsOut), indices: Uint32Array.from(indicesOut) };
}

/** Three's PropertyBinding.sanitizeNodeName: whitespace → "_", reserved chars dropped. */
function sanitize(name: string): string {
  return name.replace(/\s/g, "_").replace(/[[\].:/]/g, "");
}

/** First node (scene pre-order, like Object3D.getObjectByName) with this name. */
function findNode(json: Gltf, name: string): number | null {
  const nodes: Gltf[] = json.nodes ?? [];
  const matches = (i: number) => {
    const n = nodes[i]?.name;
    return typeof n === "string" && (n === name || sanitize(n) === name);
  };
  const scene = json.scenes?.[json.scene ?? 0];
  const stack: number[] = [...(scene?.nodes ?? [])].reverse();
  while (stack.length > 0) {
    const i = stack.pop()!;
    if (matches(i)) return i;
    const kids: number[] = nodes[i]?.children ?? [];
    for (let k = kids.length - 1; k >= 0; k--) stack.push(kids[k]!);
  }
  for (let i = 0; i < nodes.length; i++) if (matches(i)) return i;
  return null;
}

function appendPrimitive(
  json: Gltf,
  buffers: Uint8Array[],
  prim: Gltf,
  world: Float64Array,
  positionsOut: number[],
  indicesOut: number[],
): void {
  const mode = prim.mode ?? 4;
  if (mode !== 4 && mode !== 5 && mode !== 6) return; // points / lines: nothing to stand on
  if (prim.attributes?.POSITION === undefined) return;
  const pos = readAccessor(json, buffers, prim.attributes.POSITION);
  const count = pos.length / 3;
  if (count === 0) return;
  const base = positionsOut.length / 3;
  const m = world;
  for (let i = 0; i < count; i++) {
    const x = pos[i * 3]!, y = pos[i * 3 + 1]!, z = pos[i * 3 + 2]!;
    positionsOut.push(
      m[0]! * x + m[4]! * y + m[8]! * z + m[12]!,
      m[1]! * x + m[5]! * y + m[9]! * z + m[13]!,
      m[2]! * x + m[6]! * y + m[10]! * z + m[14]!,
    );
  }
  let order: ArrayLike<number>;
  if (prim.indices !== undefined) order = readAccessor(json, buffers, prim.indices, true);
  else {
    const seq = new Uint32Array(count);
    for (let i = 0; i < count; i++) seq[i] = i;
    order = seq;
  }
  if (mode === 4) {
    const n = order.length - (order.length % 3);
    for (let i = 0; i < n; i++) indicesOut.push(base + order[i]!);
  } else if (mode === 5) {
    // strip: alternate winding so every triangle faces the same way
    for (let i = 0; i + 2 < order.length; i++) {
      const a = order[i]!, b = order[i + 1]!, c = order[i + 2]!;
      if (i % 2 === 0) indicesOut.push(base + a, base + b, base + c);
      else indicesOut.push(base + b, base + a, base + c);
    }
  } else {
    for (let i = 1; i + 1 < order.length; i++) {
      indicesOut.push(base + order[0]!, base + order[i]!, base + order[i + 1]!);
    }
  }
}

const COMPONENTS: Record<string, number> = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT2: 4, MAT3: 9, MAT4: 16 };
const BYTES: Record<number, number> = { 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 };

/** Flat element values of an accessor (dequantized unless `raw`). */
function readAccessor(json: Gltf, buffers: Uint8Array[], index: number, raw = false): Float64Array {
  const acc = json.accessors?.[index];
  if (!acc) throw new Error(`accessor ${index} missing`);
  const comps = COMPONENTS[acc.type];
  const size = BYTES[acc.componentType];
  if (!comps || !size) throw new Error(`accessor ${index}: unsupported type ${acc.type}/${acc.componentType}`);
  const out = new Float64Array(acc.count * comps);
  if (acc.bufferView !== undefined) {
    const bv = json.bufferViews[acc.bufferView];
    const buf = buffers[bv.buffer];
    if (!buf) throw new Error(`bufferView ${acc.bufferView}: buffer ${bv.buffer} missing`);
    const stride = bv.byteStride ?? comps * size;
    const start = (bv.byteOffset ?? 0) + (acc.byteOffset ?? 0);
    const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    for (let i = 0; i < acc.count; i++) {
      for (let c = 0; c < comps; c++) {
        out[i * comps + c] = readComponent(dv, start + i * stride + c * size, acc.componentType);
      }
    }
  }
  if (acc.sparse) {
    const s = acc.sparse;
    const idx = readRaw(json, buffers, s.indices.bufferView, s.indices.byteOffset ?? 0, s.count, 1, s.indices.componentType);
    const val = readRaw(json, buffers, s.values.bufferView, s.values.byteOffset ?? 0, s.count, comps, acc.componentType);
    for (let k = 0; k < s.count; k++) {
      for (let c = 0; c < comps; c++) out[idx[k]! * comps + c] = val[k * comps + c]!;
    }
  }
  if (!raw && acc.normalized) {
    const t = acc.componentType;
    for (let i = 0; i < out.length; i++) {
      const v = out[i]!;
      out[i] =
        t === 5120 ? Math.max(v / 127, -1)
        : t === 5121 ? v / 255
        : t === 5122 ? Math.max(v / 32767, -1)
        : t === 5123 ? v / 65535
        : v;
    }
  }
  return out;
}

function readRaw(
  json: Gltf,
  buffers: Uint8Array[],
  bufferView: number,
  byteOffset: number,
  count: number,
  comps: number,
  componentType: number,
): Float64Array {
  const bv = json.bufferViews[bufferView];
  const buf = buffers[bv.buffer]!;
  const size = BYTES[componentType]!;
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const start = (bv.byteOffset ?? 0) + byteOffset;
  const out = new Float64Array(count * comps);
  for (let i = 0; i < count * comps; i++) out[i] = readComponent(dv, start + i * size, componentType);
  return out;
}

function readComponent(dv: DataView, at: number, type: number): number {
  switch (type) {
    case 5126: return dv.getFloat32(at, true);
    case 5125: return dv.getUint32(at, true);
    case 5123: return dv.getUint16(at, true);
    case 5122: return dv.getInt16(at, true);
    case 5121: return dv.getUint8(at);
    case 5120: return dv.getInt8(at);
    default: throw new Error(`component type ${type}`);
  }
}

const IDENTITY = new Float64Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);

/** Column-major local matrix from `matrix` or translation/rotation/scale. */
function localMatrix(node: Gltf): Float64Array {
  if (Array.isArray(node.matrix) && node.matrix.length === 16) return Float64Array.from(node.matrix);
  const [tx, ty, tz] = node.translation ?? [0, 0, 0];
  const [x, y, z, w] = node.rotation ?? [0, 0, 0, 1];
  const [sx, sy, sz] = node.scale ?? [1, 1, 1];
  const x2 = x + x, y2 = y + y, z2 = z + z;
  const xx = x * x2, xy = x * y2, xz = x * z2, yy = y * y2, yz = y * z2, zz = z * z2;
  const wx = w * x2, wy = w * y2, wz = w * z2;
  return new Float64Array([
    (1 - (yy + zz)) * sx, (xy + wz) * sx, (xz - wy) * sx, 0,
    (xy - wz) * sy, (1 - (xx + zz)) * sy, (yz + wx) * sy, 0,
    (xz + wy) * sz, (yz - wx) * sz, (1 - (xx + yy)) * sz, 0,
    tx, ty, tz, 1,
  ]);
}

function multiply(a: Float64Array, b: Float64Array): Float64Array {
  const out = new Float64Array(16);
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      out[c * 4 + r] =
        a[r]! * b[c * 4]! + a[4 + r]! * b[c * 4 + 1]! + a[8 + r]! * b[c * 4 + 2]! + a[12 + r]! * b[c * 4 + 3]!;
    }
  }
  return out;
}

function base64Bytes(b64: string): Uint8Array {
  const g = globalThis as { atob?: (s: string) => string };
  if (!g.atob) throw new Error("no base64 decoder available");
  const s = g.atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

/**
 * Minimal GLB reading for the armor tools: triangles (mesh-space positions, uv0, part index from uv1.x), the part /
 * tile / rules extras, node world matrices and skin joints (bind matrices) — enough to measure sheets on a model's
 * real UVs and to draw a bind-pose review. No three.js, no deps.
 */
import fs from "node:fs";

export type M4 = number[]; // column-major 4x4, like glTF
export const I4 = (): M4 => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
export function mul(a: M4, b: M4): M4 {
  const o = new Array(16).fill(0);
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) for (let k = 0; k < 4; k++) o[c * 4 + r] += a[k * 4 + r]! * b[c * 4 + k]!;
  return o;
}
export function compose(t: number[] = [0, 0, 0], q: number[] = [0, 0, 0, 1], s: number[] = [1, 1, 1]): M4 {
  const [x, y, z, w] = q as [number, number, number, number];
  const [sx, sy, sz] = s as [number, number, number];
  return [
    (1 - 2 * (y * y + z * z)) * sx, 2 * (x * y + z * w) * sx, 2 * (x * z - y * w) * sx, 0,
    2 * (x * y - z * w) * sy, (1 - 2 * (x * x + z * z)) * sy, 2 * (y * z + x * w) * sy, 0,
    2 * (x * z + y * w) * sz, 2 * (y * z - x * w) * sz, (1 - 2 * (x * x + y * y)) * sz, 0,
    t[0]!, t[1]!, t[2]!, 1,
  ];
}
/** three.js Euler 'XYZ' (degrees) as a quaternion — the order Object3D.rotation uses for mount `rotationDeg`. */
export function eulerXYZ(deg: number[]): number[] {
  const [a, b, c] = deg.map((d) => (d * Math.PI) / 360) as [number, number, number];
  const c1 = Math.cos(a), c2 = Math.cos(b), c3 = Math.cos(c), s1 = Math.sin(a), s2 = Math.sin(b), s3 = Math.sin(c);
  return [s1 * c2 * c3 + c1 * s2 * s3, c1 * s2 * c3 - s1 * c2 * s3, c1 * c2 * s3 + s1 * s2 * c3, c1 * c2 * c3 - s1 * s2 * s3];
}
export const apply = (m: M4, p: number[]): number[] => [
  m[0]! * p[0]! + m[4]! * p[1]! + m[8]! * p[2]! + m[12]!,
  m[1]! * p[0]! + m[5]! * p[1]! + m[9]! * p[2]! + m[13]!,
  m[2]! * p[0]! + m[6]! * p[1]! + m[10]! * p[2]! + m[14]!,
];
export function invert(m: M4): M4 {
  // general 4x4 inverse (cofactors)
  const a = m, o = new Array(16);
  o[0] = a[5]! * a[10]! * a[15]! - a[5]! * a[11]! * a[14]! - a[9]! * a[6]! * a[15]! + a[9]! * a[7]! * a[14]! + a[13]! * a[6]! * a[11]! - a[13]! * a[7]! * a[10]!;
  o[4] = -a[4]! * a[10]! * a[15]! + a[4]! * a[11]! * a[14]! + a[8]! * a[6]! * a[15]! - a[8]! * a[7]! * a[14]! - a[12]! * a[6]! * a[11]! + a[12]! * a[7]! * a[10]!;
  o[8] = a[4]! * a[9]! * a[15]! - a[4]! * a[11]! * a[13]! - a[8]! * a[5]! * a[15]! + a[8]! * a[7]! * a[13]! + a[12]! * a[5]! * a[11]! - a[12]! * a[7]! * a[9]!;
  o[12] = -a[4]! * a[9]! * a[14]! + a[4]! * a[10]! * a[13]! + a[8]! * a[5]! * a[14]! - a[8]! * a[6]! * a[13]! - a[12]! * a[5]! * a[10]! + a[12]! * a[6]! * a[9]!;
  o[1] = -a[1]! * a[10]! * a[15]! + a[1]! * a[11]! * a[14]! + a[9]! * a[2]! * a[15]! - a[9]! * a[3]! * a[14]! - a[13]! * a[2]! * a[11]! + a[13]! * a[3]! * a[10]!;
  o[5] = a[0]! * a[10]! * a[15]! - a[0]! * a[11]! * a[14]! - a[8]! * a[2]! * a[15]! + a[8]! * a[3]! * a[14]! + a[12]! * a[2]! * a[11]! - a[12]! * a[3]! * a[10]!;
  o[9] = -a[0]! * a[9]! * a[15]! + a[0]! * a[11]! * a[13]! + a[8]! * a[1]! * a[15]! - a[8]! * a[3]! * a[13]! - a[12]! * a[1]! * a[11]! + a[12]! * a[3]! * a[9]!;
  o[13] = a[0]! * a[9]! * a[14]! - a[0]! * a[10]! * a[13]! - a[8]! * a[1]! * a[14]! + a[8]! * a[2]! * a[13]! + a[12]! * a[1]! * a[10]! - a[12]! * a[2]! * a[9]!;
  o[2] = a[1]! * a[6]! * a[15]! - a[1]! * a[7]! * a[14]! - a[5]! * a[2]! * a[15]! + a[5]! * a[3]! * a[14]! + a[13]! * a[2]! * a[7]! - a[13]! * a[3]! * a[6]!;
  o[6] = -a[0]! * a[6]! * a[15]! + a[0]! * a[7]! * a[14]! + a[4]! * a[2]! * a[15]! - a[4]! * a[3]! * a[14]! - a[12]! * a[2]! * a[7]! + a[12]! * a[3]! * a[6]!;
  o[10] = a[0]! * a[5]! * a[15]! - a[0]! * a[7]! * a[13]! - a[4]! * a[1]! * a[15]! + a[4]! * a[3]! * a[13]! + a[12]! * a[1]! * a[7]! - a[12]! * a[3]! * a[5]!;
  o[14] = -a[0]! * a[5]! * a[14]! + a[0]! * a[6]! * a[13]! + a[4]! * a[1]! * a[14]! - a[4]! * a[2]! * a[13]! - a[12]! * a[1]! * a[6]! + a[12]! * a[2]! * a[5]!;
  o[3] = -a[1]! * a[6]! * a[11]! + a[1]! * a[7]! * a[10]! + a[5]! * a[2]! * a[11]! - a[5]! * a[3]! * a[10]! - a[9]! * a[2]! * a[7]! + a[9]! * a[3]! * a[6]!;
  o[7] = a[0]! * a[6]! * a[11]! - a[0]! * a[7]! * a[10]! - a[4]! * a[2]! * a[11]! + a[4]! * a[3]! * a[10]! + a[8]! * a[2]! * a[7]! - a[8]! * a[3]! * a[6]!;
  o[11] = -a[0]! * a[5]! * a[11]! + a[0]! * a[7]! * a[9]! + a[4]! * a[1]! * a[11]! - a[4]! * a[3]! * a[9]! - a[8]! * a[1]! * a[7]! + a[8]! * a[3]! * a[5]!;
  o[15] = a[0]! * a[5]! * a[10]! - a[0]! * a[6]! * a[9]! - a[4]! * a[1]! * a[10]! + a[4]! * a[2]! * a[9]! + a[8]! * a[1]! * a[6]! - a[8]! * a[2]! * a[5]!;
  const det = a[0]! * o[0] + a[1]! * o[4] + a[2]! * o[8] + a[3]! * o[12];
  return o.map((v: number) => v / det);
}

export interface Tri { p: number[][]; uv: number[][]; part: number }
export interface Glb {
  tris: Tri[];
  /** part name -> index (uv1.x) */
  parts: Record<string, number>;
  tiles: Record<string, number[]>;
  rules: unknown;
  /** world matrix of the mesh node (positions in `tris` are mesh-space) */
  meshWorld: M4;
  /** joint name -> bind-pose world matrix (meshWorld * inverse(IBM)) */
  joints: Record<string, M4>;
}

export function readGlb(file: string): Glb {
  const buf = fs.readFileSync(file);
  const jsonLen = buf.readUInt32LE(12);
  const json = JSON.parse(buf.subarray(20, 20 + jsonLen).toString());
  const binStart = 20 + jsonLen + 8;
  const bin = buf.subarray(binStart, binStart + buf.readUInt32LE(20 + jsonLen));
  const N: Record<string, number> = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 };
  const acc = (i: number): Float64Array => {
    const a = json.accessors[i];
    const v = json.bufferViews[a.bufferView];
    const n = N[a.type]!;
    const size = { 5126: 4, 5125: 4, 5123: 2, 5121: 1 }[a.componentType as 5126]!;
    const stride = v.byteStride ?? n * size;
    const base = (v.byteOffset ?? 0) + (a.byteOffset ?? 0);
    const out = new Float64Array(a.count * n);
    for (let k = 0; k < a.count; k++)
      for (let c = 0; c < n; c++) {
        const o = base + k * stride + c * size;
        out[k * n + c] = a.componentType === 5126 ? bin.readFloatLE(o) : a.componentType === 5125 ? bin.readUInt32LE(o) : a.componentType === 5123 ? bin.readUInt16LE(o) : bin[o]!;
      }
    return out;
  };
  // world matrices
  const parent: Record<number, number> = {};
  json.nodes.forEach((n: { children?: number[] }, i: number) => (n.children ?? []).forEach((c) => (parent[c] = i)));
  const local = (i: number): M4 => {
    const n = json.nodes[i];
    return n.matrix ? n.matrix : compose(n.translation, n.rotation, n.scale);
  };
  const world = (i: number): M4 => (parent[i] === undefined ? local(i) : mul(world(parent[i]!), local(i)));
  const meshIndex = json.nodes.findIndex((n: { mesh?: number; extras?: { parts?: unknown } }) => n.mesh !== undefined && n.extras?.parts) >= 0
    ? json.nodes.findIndex((n: { mesh?: number; extras?: { parts?: unknown } }) => n.mesh !== undefined && n.extras?.parts)
    : json.nodes.findIndex((n: { mesh?: number }) => n.mesh !== undefined);
  const node = json.nodes[meshIndex];
  const meshWorld = world(meshIndex);
  const tris: Tri[] = [];
  for (const prim of json.meshes[node.mesh].primitives) {
    const P = acc(prim.attributes.POSITION);
    const UV = prim.attributes.TEXCOORD_0 !== undefined ? acc(prim.attributes.TEXCOORD_0) : null;
    const PART = prim.attributes.TEXCOORD_1 !== undefined ? acc(prim.attributes.TEXCOORD_1) : null;
    const count = P.length / 3;
    const idx = prim.indices !== undefined ? acc(prim.indices) : Float64Array.from({ length: count }, (_, i) => i);
    for (let t = 0; t < idx.length; t += 3) {
      const v = [idx[t]!, idx[t + 1]!, idx[t + 2]!];
      tris.push({
        p: v.map((i) => [P[i * 3]!, P[i * 3 + 1]!, P[i * 3 + 2]!]),
        uv: v.map((i) => (UV ? [UV[i * 2]!, UV[i * 2 + 1]!] : [0, 0])),
        part: PART ? Math.round(PART[v[0]! * 2]!) : 0,
      });
    }
  }
  const joints: Record<string, M4> = {};
  if (node.skin !== undefined) {
    const skin = json.skins[node.skin];
    const ibm = acc(skin.inverseBindMatrices);
    skin.joints.forEach((j: number, k: number) => {
      joints[json.nodes[j].name] = mul(meshWorld, invert(Array.from(ibm.subarray(k * 16, k * 16 + 16))));
    });
  }
  const ex = node.extras ?? {};
  return { tris, parts: ex.parts ?? {}, tiles: ex.tiles ?? {}, rules: ex.rules ?? {}, meshWorld, joints };
}

/** Uniform world scale of the mesh node (metres per model unit for a skinned body). */
export const worldScale = (m: M4): number => Math.hypot(m[0]!, m[1]!, m[2]!);

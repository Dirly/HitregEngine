/**
 * Prop geometry for intake (`props.mts`): a prefab's triangles in its ROOT's
 * frame (the frame a placement uses: the instance replaces the root's own
 * transform), through nested entity transforms, nested prefabs and primitive
 * meshes. Zero renderer, zero DOM: reads glb/gltf directly.
 *
 * Also the measurements every intake decision is keyed off: bounds, where the
 * origin sits on them, and up-facing flat areas (shelf boards, table tops)
 * with the clear height above each.
 */
import fs from "node:fs";
import path from "node:path";

export type V3 = [number, number, number];
/** The texture a triangle samples: its texel size, the material's `repeat`, and a key naming it. */
export interface TexInfo { key: string; size: [number, number]; repeat: [number, number]; /** image file (material assets); row = (1 - v) * H when flipY (TextureLoader), v * H otherwise (glTF) */ file?: string; flipY?: boolean }
export interface Tri { a: V3; b: V3; c: V3; uv?: [number, number][]; material?: string; /** authored normal (mean of vertex normals), when the mesh has them */ n?: V3; /** base-colour texture it samples (texel density) */ tex?: TexInfo }
export interface PropGeometry {
  tris: Tri[];
  min: V3;
  max: V3;
  /** Entities whose components include a `vfx` (effect ids), lights, and nested prefab ids. */
  effects: string[];
  lights: number;
  nested: string[];
  warnings: string[];
}

type M4 = number[]; // column-major
const I4: M4 = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
function mul(a: M4, b: M4): M4 {
  const o = new Array(16).fill(0);
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) for (let k = 0; k < 4; k++) o[c * 4 + r] += a[k * 4 + r] * b[c * 4 + k];
  return o;
}
function trs(t: number[] = [0, 0, 0], q: number[] = [0, 0, 0, 1], s: number[] = [1, 1, 1]): M4 {
  const [x, y, z, w] = q;
  return [
    (1 - 2 * (y * y + z * z)) * s[0], 2 * (x * y + z * w) * s[0], 2 * (x * z - y * w) * s[0], 0,
    2 * (x * y - z * w) * s[1], (1 - 2 * (x * x + z * z)) * s[1], 2 * (y * z + x * w) * s[1], 0,
    2 * (x * z + y * w) * s[2], 2 * (y * z - x * w) * s[2], (1 - 2 * (x * x + y * y)) * s[2], 0,
    t[0], t[1], t[2], 1,
  ];
}
const apply = (m: M4, p: number[]): V3 => [
  m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12],
  m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13],
  m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14],
];

// ---------------------------------------------------------------- glTF ----
interface Gltf { json: any; buffers: Buffer[] }
const gltfCache = new Map<string, Gltf>();
function loadGltf(file: string): Gltf {
  const hit = gltfCache.get(file);
  if (hit) return hit;
  const bytes = fs.readFileSync(file);
  let json: any, bin: Buffer | null = null;
  if (bytes.length >= 4 && bytes.readUInt32LE(0) === 0x46546c67) {
    let o = 12;
    while (o + 8 <= bytes.length) {
      const len = bytes.readUInt32LE(o), type = bytes.readUInt32LE(o + 4), body = bytes.subarray(o + 8, o + 8 + len);
      if (type === 0x4e4f534a) json = JSON.parse(body.toString("utf8"));
      else if (type === 0x004e4942) bin = body;
      o += 8 + len + ((4 - (len % 4)) % 4);
    }
  } else json = JSON.parse(bytes.toString("utf8"));
  const buffers = (json.buffers ?? []).map((b: any) => {
    if (!b.uri) return bin!;
    if (b.uri.startsWith("data:")) return Buffer.from(b.uri.slice(b.uri.indexOf(",") + 1), "base64");
    return fs.readFileSync(path.resolve(path.dirname(file), decodeURIComponent(b.uri)));
  });
  const g = { json, buffers };
  gltfCache.set(file, g);
  return g;
}
const CT: Record<number, [number, (d: DataView, o: number) => number]> = {
  5120: [1, (d, o) => d.getInt8(o)], 5121: [1, (d, o) => d.getUint8(o)], 5122: [2, (d, o) => d.getInt16(o, true)],
  5123: [2, (d, o) => d.getUint16(o, true)], 5125: [4, (d, o) => d.getUint32(o, true)], 5126: [4, (d, o) => d.getFloat32(o, true)],
};
const NC: Record<string, number> = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 };
function accessor(g: Gltf, i: number): number[] {
  const a = g.json.accessors[i], n = NC[a.type], [size, get] = CT[a.componentType];
  const out = new Array(a.count * n).fill(0);
  if (a.bufferView == null) return out;
  const v = g.json.bufferViews[a.bufferView], buf = g.buffers[v.buffer];
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const stride = v.byteStride ?? n * size, base = (v.byteOffset ?? 0) + (a.byteOffset ?? 0);
  for (let k = 0; k < a.count; k++) for (let c = 0; c < n; c++) out[k * n + c] = get(dv, base + k * stride + c * size);
  return out;
}
/** Pixel size of a PNG or JPEG, from its header; null for anything else. */
export function imageSize(b: Buffer): [number, number] | null {
  if (b.length > 24 && b.readUInt32BE(0) === 0x89504e47) return [b.readUInt32BE(16), b.readUInt32BE(20)];
  if (b.length > 4 && b[0] === 0xff && b[1] === 0xd8) {
    let o = 2;
    while (o + 9 < b.length) {
      if (b[o] !== 0xff) { o++; continue; }
      const mk = b[o + 1], len = b.readUInt16BE(o + 2);
      if (mk >= 0xc0 && mk <= 0xcf && mk !== 0xc4 && mk !== 0xc8 && mk !== 0xcc) return [b.readUInt16BE(o + 7), b.readUInt16BE(o + 5)];
      o += 2 + len;
    }
  }
  return null;
}
/** The glTF's own base-colour texture for a primitive (used when the prefab names no material asset). */
function gltfTex(g: Gltf, file: string, matIndex: number | undefined): TexInfo | undefined {
  const mat = matIndex == null ? null : g.json.materials?.[matIndex];
  const ti = mat?.pbrMetallicRoughness?.baseColorTexture?.index;
  const img = ti == null ? null : g.json.images?.[g.json.textures?.[ti]?.source];
  if (!img) return undefined;
  let bytes: Buffer | null = null;
  if (img.bufferView != null) { const v = g.json.bufferViews[img.bufferView]; bytes = g.buffers[v.buffer].subarray(v.byteOffset ?? 0, (v.byteOffset ?? 0) + v.byteLength); }
  else if (typeof img.uri === "string") {
    if (img.uri.startsWith("data:")) bytes = Buffer.from(img.uri.slice(img.uri.indexOf(",") + 1), "base64");
    else { const f = path.resolve(path.dirname(file), decodeURIComponent(img.uri)); if (fs.existsSync(f)) bytes = fs.readFileSync(f); }
  }
  const size = bytes && imageSize(bytes);
  return size ? { key: `${path.basename(file)}#image${g.json.textures[ti].source}`, size, repeat: [1, 1] } : undefined;
}
function gltfTris(file: string, m: M4, material: string | undefined, out: Tri[], tex?: TexInfo): void {
  const g = loadGltf(file), json = g.json;
  const walk = (ni: number, parent: M4) => {
    const n = json.nodes[ni], local = n.matrix ?? trs(n.translation, n.rotation, n.scale), w = mul(parent, local);
    if (n.mesh != null)
      for (const p of json.meshes[n.mesh].primitives) {
        if ((p.mode ?? 4) !== 4) continue;
        const pos = accessor(g, p.attributes.POSITION);
        const uv = p.attributes.TEXCOORD_0 != null ? accessor(g, p.attributes.TEXCOORD_0) : null;
        const nor = p.attributes.NORMAL != null ? accessor(g, p.attributes.NORMAL) : null;
        const N = (ks: number[]): V3 | undefined => {
          if (!nor) return undefined;
          const v = [0, 1, 2].map((c) => ks.reduce((t, k) => t + nor[k * 3 + c], 0));
          const w2 = [w[0] * v[0] + w[4] * v[1] + w[8] * v[2], w[1] * v[0] + w[5] * v[1] + w[9] * v[2], w[2] * v[0] + w[6] * v[1] + w[10] * v[2]];
          const l = Math.hypot(...w2) || 1;
          return [w2[0] / l, w2[1] / l, w2[2] / l];
        };
        const idx = p.indices != null ? accessor(g, p.indices) : Array.from({ length: pos.length / 3 }, (_, k) => k);
        const ptex = material ? tex : gltfTex(g, file, p.material);
        const P = (k: number) => apply(w, [pos[k * 3], pos[k * 3 + 1], pos[k * 3 + 2]]);
        for (let t = 0; t + 2 < idx.length; t += 3) {
          const [i0, i1, i2] = [idx[t], idx[t + 1], idx[t + 2]];
          out.push({ a: P(i0), b: P(i1), c: P(i2), material, tex: ptex, n: N([i0, i1, i2]), uv: uv ? [i0, i1, i2].map((k) => [uv[k * 2], uv[k * 2 + 1]] as [number, number]) : undefined });
        }
      }
    for (const c of n.children ?? []) walk(c, w);
  };
  for (const r of json.scenes[json.scene ?? 0].nodes) walk(r, m);
}
/** Primitive meshes: their `size` is the full bounding box on every shape; a box stands in for the shape. */
/** UVs only on boxes (stretch = one tile per face; world = face metres / `scale`), for texel density. */
function boxTris(size: number[], m: M4, out: Tri[], look?: { material?: string; tex?: TexInfo; box?: boolean; uv?: { mode?: string; scale?: number[] } }): void {
  const [x, y, z] = size.map((s) => s / 2);
  const c = (sx: number, sy: number, sz: number) => apply(m, [sx * x, sy * y, sz * z]);
  const world = look?.uv?.mode === "world", sc = look?.uv?.scale ?? [1, 1];
  const quad = (p: V3[], du: number, dv: number) => {
    const U = look?.box && look.tex ? (world ? [du / sc[0], dv / sc[1]] : [1, 1]) : null;
    const uv = (k: number): [number, number] => [k === 1 || k === 2 ? U![0] : 0, k >= 2 ? U![1] : 0];
    const t = (i: number, j: number, k: number): Tri => ({ a: p[i], b: p[j], c: p[k], material: look?.material, tex: look?.tex, ...(U ? { uv: [uv(i), uv(j), uv(k)] } : {}) });
    out.push(t(0, 1, 2), t(0, 2, 3));
  };
  const [X, Y, Z] = size;
  quad([c(-1, 1, -1), c(-1, 1, 1), c(1, 1, 1), c(1, 1, -1)], Z, X); // top (CCW from above => +Y)
  quad([c(-1, -1, -1), c(1, -1, -1), c(1, -1, 1), c(-1, -1, 1)], X, Z);
  quad([c(-1, -1, 1), c(1, -1, 1), c(1, 1, 1), c(-1, 1, 1)], X, Y);
  quad([c(1, -1, -1), c(-1, -1, -1), c(-1, 1, -1), c(1, 1, -1)], X, Y);
  quad([c(1, -1, 1), c(1, -1, -1), c(1, 1, -1), c(1, 1, 1)], Z, Y);
  quad([c(-1, -1, -1), c(-1, -1, 1), c(-1, 1, 1), c(-1, 1, -1)], Z, Y);
}
/** A material asset's base-colour texture (size + repeat), from assets/materials/<id>.json. */
const matTexCache = new Map<string, TexInfo | null>();
export function materialTex(assets: string, material: string | undefined): TexInfo | undefined {
  if (!material) return undefined;
  const k = `${assets}|${material}`;
  if (!matTexCache.has(k)) {
    let info: TexInfo | null = null;
    const mf = path.join(assets, "materials", `${material}.json`);
    if (fs.existsSync(mf)) {
      const md = readJson(mf), tf = typeof md.map === "string" ? path.join(assets, "textures", md.map) : null;
      const size = tf && fs.existsSync(tf) ? imageSize(fs.readFileSync(tf)) : null;
      if (size) info = { key: md.map, size, repeat: Array.isArray(md.repeat) ? [md.repeat[0], md.repeat[1]] : [1, 1], file: tf!, flipY: true };
    }
    matTexCache.set(k, info);
  }
  return matTexCache.get(k) ?? undefined;
}

// -------------------------------------------------------------- prefab ----
export function prefabFile(assets: string, id: string): string {
  return path.join(assets, "prefabs", `${id}.json`);
}
export function readJson(file: string): any {
  return JSON.parse(fs.readFileSync(file, "utf8").replace(/^﻿/, ""));
}

/** Triangles of prefab `id` in its root's frame (root transform ignored: an instance replaces it). */
export function prefabGeometry(assets: string, id: string): PropGeometry {
  const geo: PropGeometry = { tris: [], min: [0, 0, 0], max: [0, 0, 0], effects: [], lights: 0, nested: [], warnings: [] };
  const visit = (pid: string, rootM: M4, depth: number) => {
    if (depth > 8) { geo.warnings.push(`nested prefab depth > 8 at ${pid}`); return; }
    const file = prefabFile(assets, pid);
    if (!fs.existsSync(file)) { geo.warnings.push(`missing prefab ${pid}`); return; }
    const doc = readJson(file), ents: Record<string, any> = doc.entities ?? {};
    const rootId = doc.root ?? Object.keys(ents).find((k) => ents[k].parent == null);
    const world = new Map<string, M4>();
    const worldOf = (eid: string): M4 => {
      const hit = world.get(eid);
      if (hit) return hit;
      const e = ents[eid];
      let m: M4;
      if (eid === rootId || e.parent == null) m = rootM;
      else {
        const t = e.components?.transform ?? {};
        m = mul(worldOf(e.parent), trs(t.position, t.rotation, t.scale));
      }
      world.set(eid, m);
      return m;
    };
    for (const [eid, e] of Object.entries(ents)) {
      const c = e.components ?? {}, m = worldOf(eid);
      if (c.vfx?.effect) geo.effects.push(c.vfx.effect);
      if (c.light) geo.lights++;
      if (c.mesh?.source?.kind === "asset") {
        const f = path.join(assets, "models", c.mesh.source.assetId);
        if (!fs.existsSync(f)) geo.warnings.push(`missing model ${c.mesh.source.assetId}`);
        else { const mat = typeof c.mesh.material === "string" ? c.mesh.material : undefined; gltfTris(f, m, mat, geo.tris, materialTex(assets, mat)); }
      } else if (c.mesh?.source?.kind === "primitive") {
        const mat = typeof c.mesh.material === "string" ? c.mesh.material : undefined;
        boxTris(c.mesh.source.size ?? [1, 1, 1], m, geo.tris, { material: mat, tex: materialTex(assets, mat), box: (c.mesh.source.shape ?? "box") === "box", uv: c.mesh.uv });
      }
      else if (c.mesh?.source) geo.warnings.push(`mesh source kind ${c.mesh.source.kind} not measured (${eid})`);
      if (c.prefab?.prefabId) {
        geo.nested.push(c.prefab.prefabId);
        // the instance's transform replaces the nested prefab root's own
        const t = c.transform ?? {};
        const nm = eid === rootId ? rootM : mul(worldOf(e.parent), trs(t.position, t.rotation, t.scale));
        visit(c.prefab.prefabId, nm, depth + 1);
      }
    }
  };
  visit(id, I4, 0);
  if (geo.tris.length) {
    const mn: V3 = [Infinity, Infinity, Infinity], mx: V3 = [-Infinity, -Infinity, -Infinity];
    for (const t of geo.tris) for (const p of [t.a, t.b, t.c]) for (let k = 0; k < 3; k++) { mn[k] = Math.min(mn[k], p[k]); mx[k] = Math.max(mx[k], p[k]); }
    geo.min = mn; geo.max = mx;
  } else geo.warnings.push("no triangles");
  geo.effects = [...new Set(geo.effects)].sort();
  return geo;
}

// ------------------------------------------------------------ measures ----
const r3 = (v: number) => Math.round(v * 1000) / 1000;
export type OriginClass = "foot" | "back" | "top" | "off";
export interface Measure {
  size: V3;
  min: V3;
  max: V3;
  origin: OriginClass;
  /** Where the origin is on the bounds, as a fraction (0 = min side, 0.5 = centre, 1 = max side) per axis. */
  originAt: V3;
  triangles: number;
}
/** Tolerance on "the origin is on that face/centre": 3 cm or 4% of the axis. */
export function onFace(v: number, target: number, extent: number): boolean {
  return Math.abs(v - target) <= Math.max(0.03, extent * 0.04);
}
export function measure(geo: PropGeometry): Measure {
  const size = geo.max.map((v, k) => r3(v - geo.min[k])) as V3;
  const at = (k: number) => (size[k] > 1e-6 ? r3(-geo.min[k] / size[k]) : 0.5);
  const cx = (geo.min[0] + geo.max[0]) / 2, cy = (geo.min[1] + geo.max[1]) / 2, cz = (geo.min[2] + geo.max[2]) / 2;
  const xC = onFace(0, cx, size[0]), zC = onFace(0, cz, size[2]), yC = onFace(0, cy, size[1]);
  let origin: OriginClass = "off";
  if (xC && zC && onFace(0, geo.min[1], size[1])) origin = "foot";
  else if (xC && zC && onFace(0, geo.max[1], size[1])) origin = "top";
  else if (xC && onFace(0, geo.min[2], size[2]) && yC) origin = "back";
  return { size, min: geo.min.map(r3) as V3, max: geo.max.map(r3) as V3, origin, originAt: [at(0), at(1), at(2)], triangles: geo.tris.length };
}

const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

/** Nearest triangle hit straight up (dir +1) or down (-1) from (x, y, z); Infinity when none. */
export function rayY(tris: Tri[], x: number, y: number, z: number, dir: 1 | -1): number {
  let best = Infinity;
  for (const t of tris) {
    const { a, b, c } = t;
    if (x < Math.min(a[0], b[0], c[0]) || x > Math.max(a[0], b[0], c[0]) || z < Math.min(a[2], b[2], c[2]) || z > Math.max(a[2], b[2], c[2])) continue;
    // barycentric in XZ
    const d = (b[2] - c[2]) * (a[0] - c[0]) + (c[0] - b[0]) * (a[2] - c[2]);
    if (Math.abs(d) < 1e-12) continue;
    const l1 = ((b[2] - c[2]) * (x - c[0]) + (c[0] - b[0]) * (z - c[2])) / d;
    const l2 = ((c[2] - a[2]) * (x - c[0]) + (a[0] - c[0]) * (z - c[2])) / d;
    const l3 = 1 - l1 - l2;
    if (l1 < -1e-6 || l2 < -1e-6 || l3 < -1e-6) continue;
    const hy = l1 * a[1] + l2 * b[1] + l3 * c[1], dist = (hy - y) * dir;
    if (dist > 0 && dist < best) best = dist;
  }
  return best;
}

export interface SurfaceFound {
  /** centre of the usable rectangle at the surface's height */
  position: V3;
  size: [number, number];
  /** gap to the next geometry above (min over interior samples); Infinity = open above */
  clearHeight: number;
  area: number;
}

/**
 * Up-facing flat areas: triangles with normal.y > 0.97, grouped by height (2 cm),
 * rasterised on a 2.5 cm XZ grid; each connected patch's largest axis-aligned
 * rectangle that nothing else covers from above within 1.5 cm is a candidate
 * surface. Ignores anything within `minRise` of the prop's foot.
 */
export function findSurfaces(geo: PropGeometry, opts: { cell?: number; minArea?: number; minSide?: number; minRise?: number; minClear?: number; limit?: number } = {}): SurfaceFound[] {
  const cell = opts.cell ?? 0.025, minArea = opts.minArea ?? 0.04, minSide = opts.minSide ?? 0.15, minRise = opts.minRise ?? 0.08, minClear = opts.minClear ?? 0.1;
  const ups: { t: Tri; y: number; area: number }[] = [];
  for (const t of geo.tris) {
    const n = cross(sub(t.b, t.a), sub(t.c, t.a)), len = Math.hypot(...n);
    if (len < 1e-10) continue;
        // flat by geometry; UP (not the underside of a board) by the authored normal, since atlases are double sided
    if (Math.abs(n[1]) / len < 0.97) continue;
    if (t.n ? t.n[1] < -0.2 : n[1] < 0) continue;
    const y = (t.a[1] + t.b[1] + t.c[1]) / 3;
    if (y - geo.min[1] < minRise) continue;
    ups.push({ t, y, area: len / 2 });
  }
  ups.sort((p, q) => p.y - q.y);
  const levels: { y: number; tris: Tri[]; wy: number; wa: number }[] = [];
  for (const u of ups) {
    const last = levels[levels.length - 1];
    if (last && u.y - last.y <= 0.02) { last.tris.push(u.t); last.wy += u.y * u.area; last.wa += u.area; }
    else levels.push({ y: u.y, tris: [u.t], wy: u.y * u.area, wa: u.area });
  }
  const out: SurfaceFound[] = [];
  const x0 = geo.min[0], z0 = geo.min[2];
  const W = Math.max(1, Math.ceil((geo.max[0] - x0) / cell)), H = Math.max(1, Math.ceil((geo.max[2] - z0) / cell));
  for (const lv of levels) {
    if (lv.wa < minArea * 0.5) continue;
    const h = lv.wy / lv.wa;
    const grid = new Uint8Array(W * H);
    for (let j = 0; j < H; j++)
      for (let i = 0; i < W; i++) {
        const x = x0 + (i + 0.5) * cell, z = z0 + (j + 0.5) * cell;
        // the patch covers this cell AND nothing sits right on top of it
        const down = rayY(lv.tris, x, h + 0.03, z, -1);
        if (down > 0.06) continue;
        const up = rayY(geo.tris, x, h + 0.005, z, 1);
        if (up < 0.015) continue;
        grid[j * W + i] = 1;
      }
    // repeatedly take the largest rectangle (histogram method), then clear it
    for (let pass = 0; pass < 6; pass++) {
      const hist = new Array(W).fill(0);
      let best = { area: 0, i0: 0, i1: 0, j0: 0, j1: 0 };
      for (let j = 0; j < H; j++) {
        for (let i = 0; i < W; i++) hist[i] = grid[j * W + i] ? hist[i] + 1 : 0;
        const stack: number[] = [];
        for (let i = 0; i <= W; i++) {
          const hh = i < W ? hist[i] : 0;
          while (stack.length && hist[stack[stack.length - 1]] >= hh) {
            const top = stack.pop()!, height = hist[top], left = stack.length ? stack[stack.length - 1] + 1 : 0;
            const a = height * (i - left);
            if (a > best.area) best = { area: a, i0: left, i1: i - 1, j0: j - height + 1, j1: j };
          }
          stack.push(i);
        }
      }
      const sx = (best.i1 - best.i0 + 1) * cell, sz = (best.j1 - best.j0 + 1) * cell;
      if (!best.area || sx * sz < minArea || Math.min(sx, sz) < minSide) break;
      for (let j = best.j0; j <= best.j1; j++) for (let i = best.i0; i <= best.i1; i++) grid[j * W + i] = 0;
      const cx = x0 + ((best.i0 + best.i1 + 1) / 2) * cell, cz = z0 + ((best.j0 + best.j1 + 1) / 2) * cell;
      // clear height: lowest geometry above the rectangle's interior (5 x 5 samples, inset 10%)
      let clear = Infinity;
      for (let a = 0; a < 5; a++)
        for (let b = 0; b < 5; b++) {
          const x = cx + (a / 4 - 0.5) * sx * 0.8, z = cz + (b / 4 - 0.5) * sz * 0.8;
          clear = Math.min(clear, rayY(geo.tris, x, h + 0.005, z, 1));
        }
      if (clear < minClear) continue;
      out.push({ position: [r3(cx), r3(h), r3(cz)], size: [r3(sx), r3(sz)], clearHeight: Number.isFinite(clear) ? r3(clear) : Infinity, area: r3(sx * sz) });
    }
  }
  return out.sort((p, q) => q.area - p.area).slice(0, opts.limit ?? 6).sort((p, q) => q.position[1] - p.position[1]);
}

/** Distance from (x, y, z) straight down to the prop's geometry (Infinity = nothing below). */
export function supportBelow(geo: PropGeometry, p: V3): number {
  return rayY(geo.tris, p[0], p[1] + 0.02, p[2], -1) - 0.02;
}

// ------------------------------------------------------- texel density ----
export interface UvIsland { worldArea: number; texelArea: number; tex: string }
export interface Density {
  /** Area-weighted median and 10th percentile texels per metre over the TEXTURED, non-flat surface. */
  median: number;
  p10: number;
  /** m² of surface: all, sampling a texture with real UV area, and flat (UVs collapsed onto one texel: palette colour). */
  area: number;
  texturedArea: number;
  flatArea: number;
  /** Textures sampled, by key, with their pixel size. */
  textures: { key: string; size: [number, number] }[];
  /** Per texture: page pixels per real texel where the art was blown up nearest by a whole factor (1 = none). */
  effective: Record<string, number>;
  /** UV layout: share of covered UV cells hit by 2+ triangles (stacked/mirrored islands), and of the UV bounds covered. */
  overlap: number;
  coverage: number;
  islands: UvIsland[];
}
const triArea = (a: V3, b: V3, c: V3) => { const k = cross(sub(b, a), sub(c, a)); return Math.hypot(k[0], k[1], k[2]) / 2; };
/** Weighted quantile of [value, weight] pairs. */
export function wQuantile(pairs: [number, number][], q: number): number {
  if (!pairs.length) return NaN;
  const s = [...pairs].sort((x, y) => x[0] - y[0]), total = s.reduce((t, p) => t + p[1], 0);
  let acc = 0;
  for (const [v, w] of s) { acc += w; if (acc >= q * total) return v; }
  return s[s.length - 1][0];
}
/**
 * Texel density as the prop stands (its root frame, metres): per triangle sqrt(texel area / world area), where
 * texel area = UV area x texture pixels x material repeat. Measured from the mesh UVs and the texture actually
 * sampled, never from a catalogued guess. Triangles whose UVs collapse below 1 texel/m are FLAT (a palette colour,
 * no detail to be blurry) and are reported apart instead of dragging the percentiles to zero.
 */
export interface PixelPage { width: number; height: number; data: Uint8Array }
/**
 * Whole-factor nearest blow-up of the texels a prop actually samples: the largest k in 4..2 for which >= 97% of the
 * aligned k x k blocks under its UV triangles are one colour. A page enlarged nearest so that one prop can be redrawn
 * finer must not make every other prop on it read as finer: it carries no more detail than before.
 */
export function blowUp(img: PixelPage, pts: [number, number][]): number {
  for (const k of [4, 3, 2]) {
    const seen = new Set<number>();
    let blocks = 0, flat = 0;
    for (const [x, y] of pts) {
      const bx = Math.floor(x / k) * k, by = Math.floor(y / k) * k;
      if (bx < 0 || by < 0 || bx + k > img.width || by + k > img.height) continue;
      const id = by * img.width + bx;
      if (seen.has(id)) continue;
      seen.add(id); blocks++;
      const i0 = id * 4;
      let same = true;
      for (let yy = 0; yy < k && same; yy++) for (let xx = 0; xx < k; xx++) {
        const i = ((by + yy) * img.width + bx + xx) * 4;
        if (img.data[i] !== img.data[i0] || img.data[i + 1] !== img.data[i0 + 1] || img.data[i + 2] !== img.data[i0 + 2]) { same = false; break; }
      }
      if (same) flat++;
    }
    if (blocks >= 16 && flat >= 0.97 * blocks) return k;
  }
  return 1;
}
export function texelDensity(geo: PropGeometry, opts: { grid?: number; pixels?: (t: TexInfo) => PixelPage | null } = {}): Density {
  const grid = opts.grid ?? 256;
  const pairs: [number, number][] = [], texs = new Map<string, [number, number]>();
  // nearest blow-up per texture, over the texels this prop samples (not tiling textures: those are not a region)
  const effective: Record<string, number> = {};
  if (opts.pixels) {
    const samples = new Map<string, { t: TexInfo; img: PixelPage; pts: [number, number][] } | null>();
    for (const t of geo.tris) if (t.tex && t.uv) {
      if (!samples.has(t.tex.key)) { const img = t.tex.repeat[0] === 1 && t.tex.repeat[1] === 1 ? opts.pixels(t.tex) : null; samples.set(t.tex.key, img ? { t: t.tex, img, pts: [] } : null); }
      const e = samples.get(t.tex.key);
      if (!e) continue;
      // a lattice of points inside the triangle, denser for big UV triangles (about one per 4x4 texels, 2..24 a side)
      const uvA = Math.abs((t.uv[1][0] - t.uv[0][0]) * (t.uv[2][1] - t.uv[0][1]) - (t.uv[1][1] - t.uv[0][1]) * (t.uv[2][0] - t.uv[0][0])) / 2;
      const n = Math.max(2, Math.min(24, Math.ceil(Math.sqrt(uvA * e.img.width * e.img.height * 2) / 4)));
      const bary: number[][] = [];
      for (let i = 0; i < n; i++) for (let j = 0; i + j < n; j++) bary.push([(i + 1 / 3) / n, (j + 1 / 3) / n]);
      for (const [s, r] of bary) {
        const u = t.uv[0][0] * (1 - s - r) + t.uv[1][0] * s + t.uv[2][0] * r, v = t.uv[0][1] * (1 - s - r) + t.uv[1][1] * s + t.uv[2][1] * r;
        if (u < 0 || u > 1 || v < 0 || v > 1) { samples.set(t.tex.key, null); break; }
        e.pts.push([Math.floor(u * e.img.width), Math.floor((t.tex.flipY ? 1 - v : v) * e.img.height)]);
      }
    }
    for (const [key, e] of samples) if (e) { const k = blowUp(e.img, e.pts); if (k > 1) effective[key] = k; }
  }
  let area = 0, texturedArea = 0, flatArea = 0;
  const byTex = new Map<string, { t: Tri; uv: [number, number][] }[]>();
  // islands: union-find over UV vertices (quantized) within each texture
  const parent: number[] = [], vid = new Map<string, number>();
  const find = (i: number): number => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
  const triRoot: { root: number; worldArea: number; texelArea: number; tex: string }[] = [];
  for (const t of geo.tris) {
    const A = triArea(t.a, t.b, t.c);
    if (!(A > 1e-9)) continue;
    area += A;
    if (!t.tex || !t.uv) continue;
    const [w, h] = t.tex.size, [rx, ry] = t.tex.repeat;
    texs.set(t.tex.key, t.tex.size);
    const uv = t.uv.map(([u, v]) => [u * rx, v * ry] as [number, number]);
    const uvA = Math.abs((uv[1][0] - uv[0][0]) * (uv[2][1] - uv[0][1]) - (uv[1][1] - uv[0][1]) * (uv[2][0] - uv[0][0])) / 2;
    const kb = effective[t.tex.key] ?? 1, texel = (uvA * w * h) / (kb * kb), d = Math.sqrt(texel / A);
    if (d < 1) { flatArea += A; continue; }
    texturedArea += A;
    pairs.push([d, A]);
    const list = byTex.get(t.tex.key) ?? []; list.push({ t, uv }); byTex.set(t.tex.key, list);
    const ids = uv.map(([u, v]) => {
      const k = `${t.tex!.key}|${Math.round(u * 1e5)}|${Math.round(v * 1e5)}`;
      let i = vid.get(k);
      if (i == null) { i = parent.length; parent.push(i); vid.set(k, i); }
      return i;
    });
    const r0 = find(ids[0]);
    for (const i of ids.slice(1)) { const r = find(i); if (r !== r0) parent[r] = r0; }
    triRoot.push({ root: ids[0], worldArea: A, texelArea: texel, tex: t.tex.key });
  }
  const isl = new Map<number, UvIsland>();
  for (const r of triRoot) {
    const k = find(r.root), cur = isl.get(k) ?? { worldArea: 0, texelArea: 0, tex: r.tex };
    cur.worldArea += r.worldArea; cur.texelArea += r.texelArea; isl.set(k, cur);
  }
  // UV raster per texture: cell centres inside each triangle
  let covered = 0, multi = 0, cells = 0;
  for (const list of byTex.values()) {
    let u0 = Infinity, v0 = Infinity, u1 = -Infinity, v1 = -Infinity;
    for (const { uv } of list) for (const [u, v] of uv) { u0 = Math.min(u0, u); v0 = Math.min(v0, v); u1 = Math.max(u1, u); v1 = Math.max(v1, v); }
    const span = Math.max(u1 - u0, v1 - v0) || 1, cs = span / grid;
    const nx = Math.max(1, Math.ceil((u1 - u0) / cs)), ny = Math.max(1, Math.ceil((v1 - v0) / cs));
    const count = new Uint16Array(nx * ny);
    for (const { uv } of list) {
      const [a, b, c] = uv;
      const d = (b[1] - c[1]) * (a[0] - c[0]) + (c[0] - b[0]) * (a[1] - c[1]);
      if (Math.abs(d) < 1e-14) continue;
      const ix0 = Math.max(0, Math.floor((Math.min(a[0], b[0], c[0]) - u0) / cs)), ix1 = Math.min(nx - 1, Math.floor((Math.max(a[0], b[0], c[0]) - u0) / cs));
      const iy0 = Math.max(0, Math.floor((Math.min(a[1], b[1], c[1]) - v0) / cs)), iy1 = Math.min(ny - 1, Math.floor((Math.max(a[1], b[1], c[1]) - v0) / cs));
      for (let iy = iy0; iy <= iy1; iy++) for (let ix = ix0; ix <= ix1; ix++) {
        const px = u0 + (ix + 0.5) * cs, py = v0 + (iy + 0.5) * cs;
        const l1 = ((b[1] - c[1]) * (px - c[0]) + (c[0] - b[0]) * (py - c[1])) / d, l2 = ((c[1] - a[1]) * (px - c[0]) + (a[0] - c[0]) * (py - c[1])) / d;
        if (l1 >= 0 && l2 >= 0 && l1 + l2 <= 1) count[iy * nx + ix] = Math.min(65535, count[iy * nx + ix] + 1);
      }
    }
    cells += nx * ny;
    for (const n of count) { if (n) covered++; if (n > 1) multi++; }
  }
  return {
    median: wQuantile(pairs, 0.5), p10: wQuantile(pairs, 0.1), area, texturedArea, flatArea,
    textures: [...texs].map(([key, size]) => ({ key, size })), effective,
    overlap: covered ? multi / covered : 0, coverage: cells ? covered / cells : 0,
    islands: [...isl.values()],
  };
}
/** Forget cached models and material textures (after a tool rewrote them on disk). */
export function clearGeometryCaches(): void { gltfCache.clear(); matTexCache.clear(); }

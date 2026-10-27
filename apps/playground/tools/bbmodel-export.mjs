#!/usr/bin/env node
/**
 * bbmodel-export — lift named mesh elements out of an owner's Blockbench file (.bbmodel, free/mesh format) into a GLB,
 * with the texture each face samples embedded (nearest filter, the PSX look). The source is never touched. Use it when
 * an owner-made piece was never exported from Blockbench (the shelf exports that tools/split-gltf.mjs cuts apart).
 *
 *   node tools/bbmodel-export.mjs <file.bbmodel> --element <name>[,<name>...] --out <file.glb>
 *        [--height <m> | --unit <m per Blockbench unit>] [--flip]
 *
 * The elements keep their own rotation (about their origin) and relative placement; group transforms are ignored, so
 * a part posed inside a scene comes out in its modelled pose. The result is recentred: foot (min y) at 0, x/z centred.
 * --height scales so the whole thing is that tall; --unit is a fixed scale (default 1/16, Blockbench's block).
 * Faces: triangles and quads; a quad's vertices are sorted into the non-crossing order of largest area (Blockbench
 * stores them unordered). --flip reverses the winding. Pure parts tested in test/bbmodel-export.test.ts.
 */
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const len = (a) => Math.hypot(a[0], a[1], a[2]);

/** Euler degrees -> 3x3 rotation, Blockbench/three order 'ZYX' (R = Rz * Ry * Rx). */
export function rotationMatrix([rx, ry, rz]) {
  const [x, y, z] = [rx, ry, rz].map((d) => (d * Math.PI) / 180);
  const cx = Math.cos(x), sx = Math.sin(x), cy = Math.cos(y), sy = Math.sin(y), cz = Math.cos(z), sz = Math.sin(z);
  const Rx = [[1, 0, 0], [0, cx, -sx], [0, sx, cx]], Ry = [[cy, 0, sy], [0, 1, 0], [-sy, 0, cy]], Rz = [[cz, -sz, 0], [sz, cz, 0], [0, 0, 1]];
  const mul = (A, B) => A.map((r) => [0, 1, 2].map((j) => r[0] * B[0][j] + r[1] * B[1][j] + r[2] * B[2][j]));
  return mul(mul(Rz, Ry), Rx);
}
const apply = (M, v) => [0, 1, 2].map((i) => M[i][0] * v[0] + M[i][1] * v[1] + M[i][2] * v[2]);

/** A quad's 4 vertex keys in the non-crossing order with the largest area. */
export function sortQuad(keys, pos) {
  const orders = [[0, 1, 2, 3], [0, 1, 3, 2], [0, 2, 1, 3]];
  let best = orders[0], bestA = -1;
  for (const o of orders) {
    const p = o.map((i) => pos[keys[i]]);
    const n = [0, 0, 0];
    for (let i = 0; i < 4; i++) { const c = cross(p[i], p[(i + 1) % 4]); n[0] += c[0]; n[1] += c[1]; n[2] += c[2]; }
    const a = len(n);
    if (a > bestA + 1e-9) { bestA = a; best = o; }
  }
  return best.map((i) => keys[i]);
}

/**
 * The named elements as one triangle soup per texture: { groups: [{ texture, positions, normals, uvs }], textures }.
 * Positions in Blockbench units with each element's rotation applied; not yet recentred or scaled.
 */
export function bbmodelToMesh(model, names, { flip = false } = {}) {
  const want = new Set(names);
  const els = model.elements.filter((e) => e.type === "mesh" && want.has(e.name));
  const missing = names.filter((n) => !els.some((e) => e.name === n));
  if (missing.length) throw new Error(`no mesh element named ${missing.join(", ")}`);
  const groups = new Map();
  for (const e of els) {
    const R = rotationMatrix(e.rotation ?? [0, 0, 0]), o = e.origin ?? [0, 0, 0];
    const pos = Object.fromEntries(Object.entries(e.vertices).map(([k, v]) => { const r = apply(R, v); return [k, [r[0] + o[0], r[1] + o[1], r[2] + o[2]]]; }));
    for (const f of Object.values(e.faces)) {
      if (f.texture === null || f.texture === undefined || f.texture === false) continue;
      const tex = model.textures[f.texture];
      if (!tex) continue;
      const keys = f.vertices.length === 4 ? sortQuad(f.vertices, pos) : f.vertices.slice();
      if (keys.length < 3) continue;
      const tris = keys.length === 4 ? [[0, 1, 2], [0, 2, 3]] : [[0, 1, 2]];
      const uw = tex.uv_width ?? model.resolution?.width ?? 16, uh = tex.uv_height ?? model.resolution?.height ?? 16;
      let g = groups.get(f.texture);
      if (!g) groups.set(f.texture, (g = { texture: f.texture, positions: [], normals: [], uvs: [] }));
      for (const t of tris) {
        const k = flip ? [keys[t[0]], keys[t[2]], keys[t[1]]] : t.map((i) => keys[i]);
        const p = k.map((kk) => pos[kk]);
        let n = cross(sub(p[1], p[0]), sub(p[2], p[0]));
        const l = len(n) || 1; n = n.map((x) => x / l);
        for (let i = 0; i < 3; i++) {
          g.positions.push(...p[i]); g.normals.push(...n);
          const uv = f.uv[k[i]] ?? [0, 0];
          g.uvs.push(uv[0] / uw, uv[1] / uh);
        }
      }
    }
  }
  return { groups: [...groups.values()], textures: model.textures };
}

/** Recentre (foot at y 0, x/z centred) and scale in place; returns the final size [x,y,z] in metres. */
export function placeMesh(mesh, { height, unit = 1 / 16 } = {}) {
  const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
  for (const g of mesh.groups) for (let i = 0; i < g.positions.length; i += 3) for (let j = 0; j < 3; j++) { mn[j] = Math.min(mn[j], g.positions[i + j]); mx[j] = Math.max(mx[j], g.positions[i + j]); }
  const s = height ? height / (mx[1] - mn[1]) : unit;
  const c = [(mn[0] + mx[0]) / 2, mn[1], (mn[2] + mx[2]) / 2];
  for (const g of mesh.groups) for (let i = 0; i < g.positions.length; i += 3) for (let j = 0; j < 3; j++) g.positions[i + j] = (g.positions[i + j] - c[j]) * s;
  return [0, 1, 2].map((j) => +((mx[j] - mn[j]) * s).toFixed(4));
}

function pngOf(tex, bbFile) {
  if (typeof tex.source === "string" && tex.source.startsWith("data:image/png;base64,")) return Buffer.from(tex.source.slice(22), "base64");
  const p = tex.path && fs.existsSync(tex.path) ? tex.path : path.join(path.dirname(bbFile), `${tex.name.replace(/\.png$/i, "")}.png`);
  if (fs.existsSync(p)) return fs.readFileSync(p);
  throw new Error(`texture ${tex.name}: no embedded source and no file at ${p}`);
}

/** A GLB: one mesh, one primitive per texture, matte PBR, nearest filter. */
export function writeGlb(mesh, pngs, name) {
  const bin = [], views = [], accessors = [], prims = [], materials = [], images = [], textures = [];
  let off = 0;
  const push = (buf, target) => { const pad = (4 - (buf.length % 4)) % 4; bin.push(buf, Buffer.alloc(pad)); views.push({ buffer: 0, byteOffset: off, byteLength: buf.length, ...(target ? { target } : {}) }); off += buf.length + pad; return views.length - 1; };
  const f32 = (a) => Buffer.from(new Float32Array(a).buffer);
  for (const g of mesh.groups) {
    const n = g.positions.length / 3;
    const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < g.positions.length; i += 3) for (let j = 0; j < 3; j++) { mn[j] = Math.min(mn[j], g.positions[i + j]); mx[j] = Math.max(mx[j], g.positions[i + j]); }
    const P = accessors.push({ bufferView: push(f32(g.positions), 34962), componentType: 5126, count: n, type: "VEC3", min: mn, max: mx }) - 1;
    const N = accessors.push({ bufferView: push(f32(g.normals), 34962), componentType: 5126, count: n, type: "VEC3" }) - 1;
    const T = accessors.push({ bufferView: push(f32(g.uvs), 34962), componentType: 5126, count: n, type: "VEC2" }) - 1;
    const img = images.push({ bufferView: push(pngs.get(g.texture)), mimeType: "image/png" }) - 1;
    const tex = textures.push({ source: img, sampler: 0 }) - 1;
    const mat = materials.push({ name: mesh.textures[g.texture].name.replace(/\.png$/i, ""), pbrMetallicRoughness: { baseColorTexture: { index: tex }, metallicFactor: 0, roughnessFactor: 0.92 } }) - 1;
    prims.push({ attributes: { POSITION: P, NORMAL: N, TEXCOORD_0: T }, material: mat });
  }
  const json = {
    asset: { version: "2.0", generator: "hitreg bbmodel-export" }, scene: 0, scenes: [{ nodes: [0] }], nodes: [{ name, mesh: 0 }], meshes: [{ name, primitives: prims }],
    materials, textures, images, samplers: [{ magFilter: 9728, minFilter: 9728, wrapS: 33071, wrapT: 33071 }], accessors, bufferViews: views, buffers: [{ byteLength: off }],
  };
  let jb = Buffer.from(JSON.stringify(json));
  jb = Buffer.concat([jb, Buffer.alloc((4 - (jb.length % 4)) % 4, 0x20)]);
  const bb = Buffer.concat(bin);
  const head = Buffer.alloc(12);
  head.writeUInt32LE(0x46546c67, 0); head.writeUInt32LE(2, 4); head.writeUInt32LE(12 + 8 + jb.length + 8 + bb.length, 8);
  const ch = (t, b) => { const h = Buffer.alloc(8); h.writeUInt32LE(b.length, 0); h.writeUInt32LE(t, 4); return Buffer.concat([h, b]); };
  return Buffer.concat([head, ch(0x4e4f534a, jb), ch(0x004e4942, bb)]);
}

function main() {
  const a = process.argv.slice(2);
  const opt = (k) => { const i = a.indexOf(`--${k}`); return i >= 0 ? a[i + 1] : undefined; };
  const file = a[0], names = opt("element")?.split(","), out = opt("out");
  if (!file || !names || !out) {
    console.error("usage: node tools/bbmodel-export.mjs <file.bbmodel> --element <name>[,...] --out <file.glb> [--height m | --unit m] [--flip]");
    process.exit(2);
  }
  const model = JSON.parse(fs.readFileSync(file, "utf8"));
  const mesh = bbmodelToMesh(model, names, { flip: a.includes("--flip") });
  const size = placeMesh(mesh, { height: opt("height") ? Number(opt("height")) : undefined, unit: opt("unit") ? Number(opt("unit")) : 1 / 16 });
  const pngs = new Map(mesh.groups.map((g) => [g.texture, pngOf(model.textures[g.texture], file)]));
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, writeGlb(mesh, pngs, names.join("+")));
  const tris = mesh.groups.reduce((s, g) => s + g.positions.length / 9, 0);
  console.log(`bbmodel-export: ${names.join(", ")} from ${path.basename(file)} -> ${out} (${tris} triangles, ${mesh.groups.length} texture(s), size ${size.join(" x ")} m)`);
}
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) main();

/**
 * WFC part COLLIDERS from the part's own geometry (not its bounding box).
 *
 * A part's bounding box as its collider made every doorway a solid slab, every deck a 3 m block down to the water
 * (a sheer wall at each deck edge) and every railing gap shut. Instead the part's triangles are voxelised (0.1 m
 * across, 0.05 m up), closed by `close` metres (a morphological closing: a reed panel's two faces, a plank's top
 * and underside and the gaps between lashings fuse into one solid; an opening wider than 2 x close stays open: a
 * 1.6 m doorway, a ladder notch, a railing gate) and greedily merged into boxes, written as ONE welded trimesh
 * per part. So a deck is a slab at deck height on its posts, a wall is a thin wall, a doorway has jambs and a
 * lintel and a hole, and a rail is a fence a body cannot step through. Walking tops land on the voxel lattice
 * (a surface at y = 0 keeps its top at 0: the y index rounds DOWN into the voxel under it).
 *
 * Exported: `partColliderBoxes(triangles, options)` (pure; the self-test drives it) and `writePartCollider`.
 */
import fs from "node:fs";
import path from "node:path";
import { GltfBuilder, accessorArray, accessorFloats, sceneNodes } from "./gltf.mjs";

/** Every triangle of a glTF's scene in its own frame: flat [ax, ay, az, bx, by, bz, cx, cy, cz] per triangle. */
export function gltfTriangles(g) {
  const out = [];
  for (const n of sceneNodes(g)) {
    if (n.node.mesh === undefined) continue;
    const m = n.world;
    for (const prim of g.doc.meshes[n.node.mesh].primitives) {
      if ((prim.mode ?? 4) !== 4 || prim.attributes?.POSITION === undefined) continue;
      const pos = accessorFloats(g, prim.attributes.POSITION);
      const count = pos.length / 3;
      const idx = prim.indices !== undefined ? accessorArray(g, prim.indices) : Array.from({ length: count }, (_, i) => i);
      const w = (i) => [
        m[0] * pos[i * 3] + m[4] * pos[i * 3 + 1] + m[8] * pos[i * 3 + 2] + m[12],
        m[1] * pos[i * 3] + m[5] * pos[i * 3 + 1] + m[9] * pos[i * 3 + 2] + m[13],
        m[2] * pos[i * 3] + m[6] * pos[i * 3 + 1] + m[10] * pos[i * 3 + 2] + m[14],
      ];
      for (let t = 0; t + 2 < idx.length; t += 3) out.push([...w(idx[t]), ...w(idx[t + 1]), ...w(idx[t + 2])]);
    }
  }
  return out;
}

/**
 * Boxes ({ min, max }, part frame) covering the closed voxel solid of `triangles`.
 * @param {number[][]} triangles
 * @param {{ voxel?: number, voxelY?: number, close?: number }} [options]
 */
export function partColliderBoxes(triangles, options = {}) {
  const vx = options.voxel ?? 0.1, vy = options.voxelY ?? 0.05, close = options.close ?? 0.2;
  if (!triangles.length) return [];
  const kx = Math.max(0, Math.round(close / vx)), ky = Math.max(0, Math.round(close / vy));
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (const t of triangles) for (let k = 0; k < 9; k++) { const a = k % 3; lo[a] = Math.min(lo[a], t[k]); hi[a] = Math.max(hi[a], t[k]); }
  // lattice: x/z cells CENTRED on the lattice planes ((i-0.5)*vx .. (i+0.5)*vx: a wall face on a cell edge overhangs
  // half a voxel either way, symmetrically), y cells ((j-1)*vy, j*vy] (a walking top on a lattice plane keeps it as its top)
  const ix = (x) => Math.round(x / vx), iz = ix, jy = (y) => Math.ceil(y / vy - 1e-6) - 1;
  const pad = [kx + 1, ky + 1, kx + 1];
  const o = [ix(lo[0]) - pad[0], jy(lo[1]) - pad[1], iz(lo[2]) - pad[2]];
  const n = [ix(hi[0]) - o[0] + pad[0] + 1, jy(hi[1]) - o[1] + pad[1] + 1, iz(hi[2]) - o[2] + pad[2] + 1];
  const N = n[0] * n[1] * n[2];
  if (N > 8e6) throw new Error(`part collider grid ${n.join("x")} is too large (a part bigger than its cell?)`);
  const at = (x, y, z) => (y * n[2] + z) * n[0] + x;
  let solid = new Uint8Array(N);
  const step = Math.min(vx, vy) / 2;
  for (const t of triangles) {
    const a = [t[0], t[1], t[2]], b = [t[3], t[4], t[5]], c = [t[6], t[7], t[8]];
    const len = Math.max(Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]), Math.hypot(c[0] - a[0], c[1] - a[1], c[2] - a[2]), Math.hypot(c[0] - b[0], c[1] - b[1], c[2] - b[2]));
    const s = Math.max(1, Math.ceil(len / step));
    for (let i = 0; i <= s; i++) for (let j = 0; j <= s - i; j++) {
      const u = i / s, v = j / s, w = 1 - u - v;
      const x = a[0] * w + b[0] * u + c[0] * v, y = a[1] * w + b[1] * u + c[1] * v, z = a[2] * w + b[2] * u + c[2] * v;
      solid[at(ix(x) - o[0], jy(y) - o[1], iz(z) - o[2])] = 1;
    }
  }
  // closing = dilate then erode, each a separable box filter (x, z by kx; y by ky)
  const pass = (src, axis, k, dilate) => {
    if (k === 0) return src;
    const dst = new Uint8Array(N), len = n[axis];
    const stride = axis === 0 ? 1 : axis === 1 ? n[0] * n[2] : n[0];
    for (let y = 0; y < (axis === 1 ? 1 : n[1]); y++) for (let z = 0; z < (axis === 2 ? 1 : n[2]); z++) for (let x = 0; x < (axis === 0 ? 1 : n[0]); x++) {
      const base = at(x, y, z);
      for (let i = 0; i < len; i++) {
        let v = dilate ? 0 : 1;
        for (let d = -k; d <= k; d++) {
          const q = i + d;
          const s = q < 0 || q >= len ? 0 : src[base + q * stride];
          if (dilate ? s : !s) { v = dilate ? 1 : 0; break; }
        }
        dst[base + i * stride] = v;
      }
    }
    return dst;
  };
  solid = pass(pass(pass(solid, 0, kx, true), 2, kx, true), 1, ky, true);
  solid = pass(pass(pass(solid, 0, kx, false), 2, kx, false), 1, ky, false);
  // greedy boxes: run along x, grow along z, then up y
  const used = new Uint8Array(N), boxes = [];
  const free = (x, y, z) => solid[at(x, y, z)] && !used[at(x, y, z)];
  for (let y = 0; y < n[1]; y++) for (let z = 0; z < n[2]; z++) for (let x = 0; x < n[0]; x++) {
    if (!free(x, y, z)) continue;
    let x1 = x; while (x1 + 1 < n[0] && free(x1 + 1, y, z)) x1++;
    let z1 = z;
    grow: while (z1 + 1 < n[2]) { for (let q = x; q <= x1; q++) if (!free(q, y, z1 + 1)) break grow; z1++; }
    let y1 = y;
    up: while (y1 + 1 < n[1]) { for (let r = z; r <= z1; r++) for (let q = x; q <= x1; q++) if (!free(q, y1 + 1, r)) break up; y1++; }
    for (let yy = y; yy <= y1; yy++) for (let r = z; r <= z1; r++) for (let q = x; q <= x1; q++) used[at(q, yy, r)] = 1;
    const r6 = (v) => Math.round(v * 1e6) / 1e6;
    boxes.push({ min: [r6((x + o[0] - 0.5) * vx), r6((y + o[1]) * vy), r6((z + o[2] - 0.5) * vx)], max: [r6((x1 + 0.5 + o[0]) * vx), r6((y1 + 1 + o[1]) * vy), r6((z1 + 0.5 + o[2]) * vx)] });
  }
  return boxes;
}

/** Boxes as one welded triangle mesh (12 triangles a box, shared corners welded). */
export function boxesMesh(boxes) {
  const pos = [], idx = [], weld = new Map();
  const vert = (x, y, z) => {
    const k = `${x},${y},${z}`;
    let i = weld.get(k);
    if (i === undefined) { i = pos.length / 3; weld.set(k, i); pos.push(x, y, z); }
    return i;
  };
  for (const { min: a, max: b } of boxes) {
    const v = [[a[0], a[1], a[2]], [b[0], a[1], a[2]], [b[0], a[1], b[2]], [a[0], a[1], b[2]], [a[0], b[1], a[2]], [b[0], b[1], a[2]], [b[0], b[1], b[2]], [a[0], b[1], b[2]]].map((p) => vert(p[0], p[1], p[2]));
    // outward winding (counter-clockwise seen from outside)
    for (const [p, q, r, s] of [[0, 1, 2, 3], [4, 7, 6, 5], [0, 4, 5, 1], [1, 5, 6, 2], [2, 6, 7, 3], [3, 7, 4, 0]]) idx.push(v[p], v[r], v[q], v[p], v[s], v[r]);
  }
  return { positions: Float32Array.from(pos), indices: Uint32Array.from(idx) };
}

/** Write a part's collider as a self-contained glTF (POSITION + NORMAL, no material); returns its triangle count. */
export function writePartCollider(boxes, file, name) {
  const { positions, indices } = boxesMesh(boxes);
  const b = new GltfBuilder(`HitReg WFC part collider (${name}: closed voxel boxes)`);
  const normals = new Float32Array(positions.length);
  for (let i = 1; i < normals.length; i += 3) normals[i] = 1;
  const attributes = { POSITION: b.pushAccessor(positions, "VEC3", { minMax: true }), NORMAL: b.pushAccessor(normals, "VEC3") };
  b.pushNode({ name, mesh: b.pushMesh({ name, primitives: [{ attributes, indices: b.pushAccessor(indices, "SCALAR") }] }) }, true);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(b.finish()));
  return indices.length / 3;
}

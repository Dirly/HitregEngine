/**
 * A baked DC volume mesh as a GLB: POSITION, NORMAL, COLOR_0 (tint) and _SPLATWEIGHT[2|3] — the terrain-splat
 * material's contract, as the DC dungeon bakes write it. One primitive: one draw with the world's terrain material.
 * Used by rock-formations.mts (fall sites) and ledge-landmark.mts (ledge landmarks).
 */
import { writeFileSync } from "node:fs";
import type { VoxelMesh } from "@hitreg/core";
// @ts-expect-error plain JS tool module
import { GltfBuilder } from "../../../tools/wfc-3d/gltf.mjs";

export function writeVolumeGlb(mesh: VoxelMesh, file: string): number {
  const b = new GltfBuilder("HitReg rock formations (baked DC volume)");
  const count = mesh.vertexCount;
  const attributes: Record<string, number> = {
    POSITION: b.pushAccessor(mesh.positions, "VEC3", { minMax: true }),
    NORMAL: b.pushAccessor(mesh.normals, "VEC3"),
    COLOR_0: b.pushAccessor(mesh.tint.length === count * 3 ? mesh.tint : new Float32Array(count * 3).fill(1), "VEC3"),
  };
  const S = mesh.surfaceCount;
  for (let k = 0; k * 4 < S; k++) {
    const a = new Float32Array(count * 4);
    for (let i = 0; i < count; i++) for (let j = 0; j < 4; j++) a[i * 4 + j] = k * 4 + j < S ? mesh.splat[i * S + k * 4 + j]! : 0;
    attributes["_SPLATWEIGHT" + (k ? String(k + 1) : "")] = b.pushAccessor(a, "VEC4");
  }
  b.pushNode({ mesh: b.pushMesh({ primitives: [{ attributes, indices: b.pushAccessor(mesh.indices, "SCALAR") }] }) }, true);
  const doc = b.finish();
  const uri: string = doc.buffers[0].uri;
  const bin = Buffer.from(uri.slice(uri.indexOf(",") + 1), "base64");
  const json = Buffer.from(JSON.stringify({ ...doc, buffers: [{ byteLength: bin.byteLength }] }), "utf8");
  const jsonPad = (4 - (json.byteLength % 4)) % 4, binPad = (4 - (bin.byteLength % 4)) % 4;
  const total = 12 + 8 + json.byteLength + jsonPad + 8 + bin.byteLength + binPad;
  const out = Buffer.alloc(total);
  let o = 0;
  out.writeUInt32LE(0x46546c67, o); o += 4;
  out.writeUInt32LE(2, o); o += 4;
  out.writeUInt32LE(total, o); o += 4;
  out.writeUInt32LE(json.byteLength + jsonPad, o); o += 4;
  out.writeUInt32LE(0x4e4f534a, o); o += 4;
  json.copy(out, o); o += json.byteLength;
  out.fill(0x20, o, o + jsonPad); o += jsonPad;
  out.writeUInt32LE(bin.byteLength + binPad, o); o += 4;
  out.writeUInt32LE(0x004e4942, o); o += 4;
  bin.copy(out, o); o += bin.byteLength;
  out.fill(0, o, o + binPad);
  writeFileSync(file, out);
  return total;
}

/** Merge DC tile meshes into one, welding coincident vertices (tile seams meet exactly on the lattice). */
export function mergeMeshes(ms: VoxelMesh[], surfaceCount: number): VoxelMesh {
  const S = ms[0]?.surfaceCount ?? surfaceCount;
  const V = ms.reduce((a, m) => a + m.vertexCount, 0), I = ms.reduce((a, m) => a + m.indices.length, 0);
  const positions = new Float32Array(V * 3), normals = new Float32Array(V * 3), tintA = new Float32Array(V * 3), splat = new Float32Array(V * S), indices = new Uint32Array(I);
  const min: [number, number, number] = [Infinity, Infinity, Infinity], max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  let v = 0, k = 0;
  const weld = new Map<string, number>(), remap: number[] = [];
  for (const m of ms) {
    positions.set(m.positions, v * 3); normals.set(m.normals, v * 3);
    tintA.set(m.tint.length === m.vertexCount * 3 ? m.tint : new Float32Array(m.vertexCount * 3).fill(1), v * 3);
    splat.set(m.splat.subarray(0, m.vertexCount * S), v * S);
    for (let i = 0; i < m.vertexCount; i++) {
      const kk = `${Math.round(m.positions[i * 3]! * 1000)},${Math.round(m.positions[i * 3 + 1]! * 1000)},${Math.round(m.positions[i * 3 + 2]! * 1000)}`;
      const w = weld.get(kk);
      if (w === undefined) weld.set(kk, v + i);
      remap[v + i] = w ?? v + i;
    }
    for (let i = 0; i < m.indices.length; i++) indices[k + i] = remap[m.indices[i]! + v]!;
    for (let a = 0; a < 3; a++) { min[a] = Math.min(min[a]!, m.min[a]!); max[a] = Math.max(max[a]!, m.max[a]!); }
    v += m.vertexCount; k += m.indices.length;
  }
  return { positions, normals, tint: tintA, splat, surfaceCount: S, indices, min, max, vertexCount: V, triangleCount: I / 3 } as VoxelMesh;
}

/** Edges used by one triangle only, by welded position (a closed bake has none away from its buried cut). */
export function openEdges(m: VoxelMesh): number {
  const key = (i: number) => `${Math.round(m.positions[i * 3]! * 200)},${Math.round(m.positions[i * 3 + 1]! * 200)},${Math.round(m.positions[i * 3 + 2]! * 200)}`;
  const ids = new Map<string, number>(), id = new Int32Array(m.vertexCount);
  for (let i = 0; i < m.vertexCount; i++) { const kk = key(i); let n = ids.get(kk); if (n === undefined) { n = ids.size; ids.set(kk, n); } id[i] = n; }
  const count = new Map<string, number>();
  for (let t = 0; t < m.indices.length; t += 3) for (let e = 0; e < 3; e++) {
    const a = id[m.indices[t + e]!]!, b = id[m.indices[t + ((e + 1) % 3)]!]!;
    if (a === b) continue;
    const kk = a < b ? `${a}_${b}` : `${b}_${a}`;
    count.set(kk, (count.get(kk) ?? 0) + 1);
  }
  let open = 0;
  for (const c of count.values()) if (c === 1) open++;
  return open;
}

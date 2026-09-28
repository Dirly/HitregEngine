/* scratch: run the formation checks on the current baked GLB (read back) or a fresh mesh of the volume doc */
import fs from "node:fs";
import { createWorldField, worldRecipeSchema, createVolume, buildVolumeMesh } from "@hitreg/core";
import { checkFormationMesh, terrainSolid } from "./rock-formations-check.mts";
const recipe = worldRecipeSchema.parse(JSON.parse(fs.readFileSync("projects/voxel-demo/assets/worlds/mmo.json", "utf8")));
const field = createWorldField(recipe);
// the baked GLB: positions/normals/indices from its single primitive
const buf = fs.readFileSync("projects/voxel-demo/assets/models/rock-formations/rock-site-river-15-21.glb");
const jl = buf.readUInt32LE(12), json = JSON.parse(buf.subarray(20, 20 + jl).toString("utf8")), bin = buf.subarray(20 + jl + 8);
const acc = (i: number, T: any) => { const a = json.accessors[i], v = json.bufferViews[a.bufferView]; const n = { SCALAR: 1, VEC3: 3, VEC4: 4 }[a.type as "SCALAR"]!; return new T(bin.buffer.slice(bin.byteOffset + (v.byteOffset ?? 0), bin.byteOffset + (v.byteOffset ?? 0) + a.count * n * 4)); };
const prim = json.meshes[0].primitives[0];
const positions = acc(prim.attributes.POSITION, Float32Array), normals = acc(prim.attributes.NORMAL, Float32Array), indices = acc(prim.indices, Uint32Array);
const mesh = { positions, normals, indices, vertexCount: positions.length / 3, triangleCount: indices.length / 3 };
const t = performance.now();
const r = checkFormationMesh(mesh, terrainSolid(field, mesh));
console.log(`baked GLB: ${mesh.triangleCount} tris; open edges ${r.openEdges}, exposed (not buried 0.3 m) ${r.exposedOpenEdges}; components ${r.components.length}, unsupported ${r.unsupported}  (${(performance.now() - t).toFixed(0)} ms)`);
for (const c of r.components) if (!c.ok || process.env.ALL) console.log(`  #${c.index} ${c.triangles} tris size ${c.size.map((v) => v.toFixed(1)).join("x")} minY ${c.minY.toFixed(1)}: ${c.ok ? "ok" : c.why} (seated ${(c.seated * 100).toFixed(0)}%, overhang ${c.overhang.toFixed(1)})`);
console.log("exposed open edges at", r.exposedAt.slice(0, 8).map((p) => p.map((v) => v.toFixed(0)).join(",")).join("  "));
{
  const solid = terrainSolid(field, mesh);
  const want = (process.env.COMP ?? "0,11,16").split(",").map(Number);
  for (const ci of want) {
    const vs: number[] = [];
    for (let i = 0; i < mesh.vertexCount; i++) if (r.vertexComponent[i] === ci && !solid(positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2])) vs.push(i);
    vs.sort((a, b) => positions[a * 3 + 1] - positions[b * 3 + 1]);
    console.log(`#${ci} lowest exposed:`, vs.slice(0, 6).map((i) => { const x = positions[i * 3], y = positions[i * 3 + 1], z = positions[i * 3 + 2]; let g = -1; for (let t = 0; t < 30; t += 0.25) if (solid(x, y - t, z)) { g = t; break; } return `(${x.toFixed(1)},${y.toFixed(1)},${z.toFixed(1)} n.y ${normals[i * 3 + 1].toFixed(2)} gap ${g} water ${field.waterY(x, z)?.toFixed(1)})`; }).join(" "));
  }
}
if (process.env.NEAR) {
  const [nx, ny, nz] = process.env.NEAR.split(",").map(Number);
  const hits = new Map<number, number>();
  for (let i = 0; i < mesh.vertexCount; i++) if (Math.hypot(positions[i * 3] - nx, positions[i * 3 + 1] - ny, positions[i * 3 + 2] - nz) < 3) hits.set(r.vertexComponent[i], (hits.get(r.vertexComponent[i]) ?? 0) + 1);
  for (const [ci] of hits) { const c = r.components[ci]; console.log(`near: piece #${ci} ${c.triangles} tris size ${c.size.map((v) => v.toFixed(1)).join("x")} minY ${c.minY.toFixed(1)} seated ${c.seated.toFixed(2)} overhang ${c.overhang.toFixed(1)}`); }
}

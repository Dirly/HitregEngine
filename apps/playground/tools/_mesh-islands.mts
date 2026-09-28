/* scratch: connected components per cell mesh (floating rock, perforations) near falls vs random cells */
import fs from "node:fs";
import { buildVoxelMesh, createWorldField, worldRecipeSchema } from "@hitreg/core";
const file = process.argv[2] ?? "projects/voxel-demo/assets/worlds/mmo.json";
const recipe = worldRecipeSchema.parse(JSON.parse(fs.readFileSync(file, "utf8")));
if (process.argv[3] === "nooverhang") recipe.terrain.overhang.strength = 0;
const field = createWorldField(recipe);
const S = recipe.cellSize;
const comps = (cx: number, cz: number) => {
  const m = buildVoxelMesh(field, { kind: "voxel", world: "w", cell: [cx, cz] } as never);
  const pos = m.positions, idx = m.indices;
  const id = new Map<string, number>();
  const w = new Int32Array(pos.length / 3);
  for (let v = 0; v < w.length; v++) {
    const k = `${pos[v * 3]!.toFixed(3)},${pos[v * 3 + 1]!.toFixed(3)},${pos[v * 3 + 2]!.toFixed(3)}`;
    let n = id.get(k); if (n === undefined) { n = id.size; id.set(k, n); } w[v] = n;
  }
  const parent = Array.from({ length: id.size }, (_, i) => i);
  const find = (a: number): number => (parent[a] === a ? a : (parent[a] = find(parent[a]!)));
  for (let t = 0; t < idx.length; t += 3) { const a = find(w[idx[t]!]!), b = find(w[idx[t + 1]!]!), c = find(w[idx[t + 2]!]!); parent[b] = a; parent[find(c)] = a; }
  const sizes = new Map<number, number>();
  for (let t = 0; t < idx.length; t += 3) { const r = find(w[idx[t]!]!); sizes.set(r, (sizes.get(r) ?? 0) + 1); }
  // small components = floating fragments
  return [...sizes.values()].filter((n) => n < 200).length;
};
let fallFrags = 0, fallCells = 0;
const seen = new Set<string>();
for (const f of field.falls) for (const dx of [-1, 0, 1]) for (const dz of [-1, 0, 1]) {
  const cx = Math.floor(f.x / S) + dx, cz = Math.floor(f.z / S) + dz;
  if (seen.has(`${cx},${cz}`)) continue; seen.add(`${cx},${cz}`);
  fallCells++; fallFrags += comps(cx, cz);
}
let bankFrags = 0, bankCells = 0;
for (const r of field.rivers) for (let k = 0; k < r.points.length; k += 10) {
  const cx = Math.floor(r.points[k]![0] / S), cz = Math.floor(r.points[k]![1] / S);
  if (seen.has(`${cx},${cz}`)) continue; seen.add(`${cx},${cz}`);
  bankCells++; bankFrags += comps(cx, cz);
}
console.log(`fall cells ${fallCells}: ${fallFrags} floating fragments; river cells ${bankCells}: ${bankFrags}`);

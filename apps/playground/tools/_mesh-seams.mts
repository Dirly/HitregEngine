/* scratch: do neighbouring cells' border vertices agree (same lod), and how far apart are two lods' borders */
import fs from "node:fs";
import { buildVoxelMesh, createWorldField, worldRecipeSchema } from "@hitreg/core";
const recipe = worldRecipeSchema.parse(JSON.parse(fs.readFileSync("projects/voxel-demo/assets/worlds/mmo.json", "utf8")));
const field = createWorldField(recipe);
const S = recipe.cellSize;
const cells = new Set<string>();
for (const f of field.falls) for (const dx of [-1, 0]) for (const dz of [-1, 0, 1]) cells.add(`${Math.floor(f.x / S) + dx},${Math.floor(f.z / S) + dz}`);
const border = (cx: number, cz: number, lodStep: number, side: "east" | "west") => {
  const m = buildVoxelMesh(field, { kind: "voxel", world: "w", cell: [cx, cz], lodStep } as never);
  const out: [number, number][] = []; // (z, y) of vertices on that border
  const xb = side === "east" ? S : 0;
  for (let v = 0; v < m.positions.length / 3; v++) {
    const x = m.positions[v * 3]!;
    if (Math.abs(x - xb) < 1e-3) out.push([m.positions[v * 3 + 2]!, m.positions[v * 3 + 1]!]);
  }
  return out;
};
let checked = 0, mismatch = 0, lodGap = 0, uncovered = 0; const worstU: string[] = [];
const notes: string[] = [];
for (const k of cells) {
  const [cx, cz] = k.split(",").map(Number) as [number, number];
  const a = border(cx, cz, 1, "east");
  const b = border(cx + 1, cz, 1, "west");
  const key = (p: [number, number]) => `${p[0].toFixed(2)},${p[1].toFixed(2)}`;
  const sb = new Set(b.map(key));
  const miss = a.filter((p) => !sb.has(key(p))).length + b.filter((p) => !new Set(a.map(key)).has(key(p))).length;
  checked++;
  if (miss) { mismatch++; if (notes.length < 6) notes.push(`${k}: ${miss} border vertices unmatched (${a.length}/${b.length})`); }
  // lod 1 next to lod 4 (a near cell beside an HLOD far cell): largest vertical gap along the border
  const c = border(cx + 1, cz, 4, "west");
  let gap = 0;
  for (const p of a) {
    let best = Infinity;
    for (const q of c) if (Math.abs(q[0] - p[0]) < 4.1) best = Math.min(best, Math.abs(q[1] - p[1]));
    if (best < Infinity) gap = Math.max(gap, best);
  }
  if (gap > 3) lodGap++;
  // uncovered: where the FINE side stands higher than its 6 m skirt reaches (the coarse 24 m skirt covers coarse-higher)
  for (const p of a) { let top = -Infinity; for (const q of c) if (Math.abs(q[0] - p[0]) < 4.1) top = Math.max(top, q[1]); const best = p[1] - top; if (top > -Infinity && best > 6) { uncovered++; if (worstU.length < 8) worstU.push(k + " z " + p[0].toFixed(0) + " fine above coarse by " + best.toFixed(1)); } }
}
console.log(`cells ${checked}: same-lod seam mismatches in ${mismatch}; lod1|lod4 border gaps > 3 m in ${lodGap}`);
for (const n of notes) console.log("  " + n);
console.log("fine-above-coarse > 6 m (visible cracks):", uncovered); for (const n of worstU) console.log("  " + n);

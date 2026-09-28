import fs from "node:fs";
import { createWorldField, voxelChunkDoc, worldRecipeSchema } from "@hitreg/core";
const recipe = worldRecipeSchema.parse(JSON.parse(fs.readFileSync("projects/voxel-demo/assets/worlds/mmo.json", "utf8")));
const field = createWorldField(recipe);
const [x, z] = process.argv[2]!.split(",").map(Number) as [number, number];
const cx = Math.floor(x / 48), cz = Math.floor(z / 48);
const doc = voxelChunkDoc(field, "mmo", cx, cz, { scatter: false, collision: false });
for (const [id, e] of Object.entries(doc.entities)) {
  if (!id.startsWith("water")) continue;
  const s = (e.components["mesh"] as { source: { positions: number[]; indices: number[] } }).source;
  let steep = 0, offLattice = 0;
  for (let t = 0; t < s.indices.length; t += 3) {
    const vs = [0, 1, 2].map((m) => s.indices[t + m]!);
    const ys = vs.map((v) => s.positions[v * 3 + 1]!);
    if (Math.max(...ys) - Math.min(...ys) < 1.5) continue;
    steep++;
    // a vertex off the 2 m lattice is a clip crossing
    if (vs.some((v) => Math.abs(s.positions[v * 3]! / 2 - Math.round(s.positions[v * 3]! / 2)) > 1e-3 || Math.abs(s.positions[v * 3 + 2]! / 2 - Math.round(s.positions[v * 3 + 2]! / 2)) > 1e-3)) offLattice++;
  }
  console.log(id, "steep tris", steep, "of which clipped", offLattice);
}

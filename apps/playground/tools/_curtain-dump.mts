/* scratch: dump a river-15 fall curtain's rows: across, out, y, speed, and each quad's normal Y */
import fs from "node:fs";
import { createWorldField, voxelChunkDoc, worldRecipeSchema } from "@hitreg/core";
const recipe = worldRecipeSchema.parse(JSON.parse(fs.readFileSync("projects/voxel-demo/assets/worlds/mmo.json", "utf8")));
const field = createWorldField(recipe);
const falls = field.falls.filter((f) => f.river === "river-15").sort((a, b) => b.top - a.top);
const fall = falls[+(process.argv[2] ?? 0)]!;
const size = recipe.cellSize;
const cx = Math.floor(fall.x / size), cz = Math.floor(fall.z / size);
const doc = voxelChunkDoc(field, "mmo", cx, cz, { scatter: false, collision: false });
for (const [id, e] of Object.entries(doc.entities)) {
  if (!id.startsWith("fall_")) continue;
  const s = (e.components["mesh"] as { source: { positions: number[]; indices: number[]; uvs: number[] } }).source;
  if (Math.abs(Math.max(...s.positions.filter((_, i) => i % 3 === 1)) - fall.top) > 1) continue;
  console.log(id, "verts", s.positions.length / 3, "tris", s.indices.length / 3);
  let minNy = 1, steepCount = 0;
  const speeds: number[] = [];
  for (let i = 0; i < s.uvs.length; i += 2) speeds.push(Math.hypot(s.uvs[i]!, s.uvs[i + 1]!));
  for (let t = 0; t < s.indices.length; t += 3) {
    const [a, b, c] = [0, 1, 2].map((k) => s.indices[t + k]!);
    const P = (i: number) => [s.positions[i * 3]!, s.positions[i * 3 + 1]!, s.positions[i * 3 + 2]!];
    const A = P(a), B = P(b), C = P(c);
    const u = [B[0] - A[0], B[1] - A[1], B[2] - A[2]], v = [C[0] - A[0], C[1] - A[1], C[2] - A[2]];
    const n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
    const ny = n[1] / Math.hypot(...n);
    if (Math.abs(ny) < 0.35) steepCount++;
    minNy = Math.min(minNy, ny);
  }
  console.log("normal y min", minNy.toFixed(2), "steep tris", steepCount, "speed min/max", Math.min(...speeds).toFixed(2), Math.max(...speeds).toFixed(2));
  console.log("row 6 speeds", speeds.slice(6 * 22, 7 * 22).map((v) => v.toFixed(1)).join(" "));
}
for (const [id, e] of Object.entries(doc.entities)) {
  if (!id.startsWith("fall_")) continue;
  const s = (e.components["mesh"] as { source: { uvs: number[] } }).source;
  console.log(id, "first 12 uv pairs", Array.from({ length: 12 }, (_, i) => `(${s.uvs[i * 2]},${s.uvs[i * 2 + 1]})`).join(" "));
}

/* scratch: water tris near a river-15 lip whose surface is not over real (density) ground within D m, or buried */
import fs from "node:fs";
import { createWorldField, voxelChunkDoc, worldRecipeSchema } from "@hitreg/core";
const recipe = worldRecipeSchema.parse(JSON.parse(fs.readFileSync("projects/voxel-demo/assets/worlds/mmo.json", "utf8")));
const field = createWorldField(recipe);
const falls = field.falls.filter((f) => f.river === "river-15").sort((a, b) => b.top - a.top);
const fi = +(process.argv[2] ?? 1), R = +(process.argv[3] ?? 14);
const fall = falls[fi]!;
const lx = fall.x - fall.dirX * 3, lz = fall.z - fall.dirZ * 3;
const size = recipe.cellSize;
/** real ground under (x,z) below y: first solid going down from y */
const realGround = (x: number, y: number, z: number): number => {
  for (let yy = y + 0.3; yy > y - 30; yy -= 0.1) if (field.density(x, yy, z) < 0) return yy;
  return -Infinity;
};
const seen = new Set<string>();
let n = 0;
for (let ox = -R; ox <= R; ox += R) for (let oz = -R; oz <= R; oz += R) {
  const cx = Math.floor((lx + ox) / size), cz = Math.floor((lz + oz) / size);
  const key = `${cx},${cz}`;
  if (seen.has(key)) continue;
  seen.add(key);
  const doc = voxelChunkDoc(field, "mmo", cx, cz, { scatter: false, collision: false });
  for (const [id, e] of Object.entries(doc.entities)) {
    if (!id.startsWith("water")) continue;
    const s = (e.components["mesh"] as { source: { positions: number[]; indices: number[] } }).source;
    for (let t = 0; t < s.indices.length; t += 3) {
      const v = [0, 1, 2].map((k) => { const i = s.indices[t + k]!; return [s.positions[i * 3]! + cx * size, s.positions[i * 3 + 1]!, s.positions[i * 3 + 2]! + cz * size] as const; });
      const mx = (v[0][0] + v[1][0] + v[2][0]) / 3, my = (v[0][1] + v[1][1] + v[2][1]) / 3, mz = (v[0][2] + v[1][2] + v[2][2]) / 3;
      const along = (mx - lx) * fall.dirX + (mz - lz) * fall.dirZ, across = -(mx - lx) * fall.dirZ + (mz - lz) * fall.dirX;
      if (Math.abs(along) > R || Math.abs(across) > R) continue;
      const rg = realGround(mx, my, mz);
      const h = field.height(mx, mz);
      const depth = my - rg;
      const flag = depth > 1.2 && my - h < 1.2 ? "FLOAT(real ground far below, height() says shallow)" : depth < -0.2 ? "BURIED" : "";
      if (!flag && !process.argv.includes("--all")) continue;
      n++;
      console.log(`${key} ${id} along ${along.toFixed(1)} across ${across.toFixed(1)} y ${my.toFixed(2)} height ${h.toFixed(2)} realGround ${rg.toFixed(2)} ${flag}`);
    }
  }
}
console.log("flagged", n);

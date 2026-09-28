/* scratch: every water/curtain triangle within R m of a river-15 fall lip, with Y and height over ground */
import fs from "node:fs";
import { createWorldField, voxelChunkDoc, worldRecipeSchema } from "@hitreg/core";
const recipe = worldRecipeSchema.parse(JSON.parse(fs.readFileSync("projects/voxel-demo/assets/worlds/mmo.json", "utf8")));
const field = createWorldField(recipe);
const falls = field.falls.filter((f) => f.river === "river-15").sort((a, b) => b.top - a.top);
const fi = +(process.argv[2] ?? 1), R = +(process.argv[3] ?? 6);
const fall = falls[fi]!;
const lx = fall.x - fall.dirX * 3, lz = fall.z - fall.dirZ * 3;
console.log("fall", fi, "lip", lx.toFixed(2), lz.toFixed(2), "top", fall.top, "bottom", fall.bottom, "prev bottom", falls[fi - 1]?.bottom);
const size = recipe.cellSize;
const seen = new Set<string>();
for (const [ox, oz] of [[-R, -R], [R, -R], [-R, R], [R, R], [0, 0]]) {
  const cx = Math.floor((lx + ox) / size), cz = Math.floor((lz + oz) / size);
  const key = `${cx},${cz}`;
  if (seen.has(key)) continue;
  seen.add(key);
  const doc = voxelChunkDoc(field, "mmo", cx, cz, { scatter: false, collision: false });
  for (const [id, e] of Object.entries(doc.entities)) {
    if (!(e.tags ?? []).includes("water")) continue;
    const m = e.components["mesh"] as { source: { positions: number[]; indices: number[] } } | undefined;
    if (!m?.source?.indices) continue;
    const p0 = (e.components["transform"] as { position: number[] }).position; const p = [p0[0]! + cx * size, p0[1]!, p0[2]! + cz * size];
    const s = m.source;
    for (let t = 0; t < s.indices.length; t += 3) {
      const v = [0, 1, 2].map((k) => { const i = s.indices[t + k]!; return [s.positions[i * 3]! + p[0]!, s.positions[i * 3 + 1]! + p[1]!, s.positions[i * 3 + 2]! + p[2]!]; });
      const mx = (v[0]![0]! + v[1]![0]! + v[2]![0]!) / 3, my = (v[0]![1]! + v[1]![1]! + v[2]![1]!) / 3, mz = (v[0]![2]! + v[1]![2]! + v[2]![2]!) / 3;
      const along = (mx - lx) * fall.dirX + (mz - lz) * fall.dirZ, across = -(mx - lx) * fall.dirZ + (mz - lz) * fall.dirX;
      if (Math.hypot(along, across) > R) continue;
      const g = field.height(mx, mz);
      const ys = v.map((q) => q[1]!);
      const dy = Math.max(...ys) - Math.min(...ys);
      const ux = v[1]![0]! - v[0]![0]!, uy = v[1]![1]! - v[0]![1]!, uz = v[1]![2]! - v[0]![2]!;
      const wx = v[2]![0]! - v[0]![0]!, wy = v[2]![1]! - v[0]![1]!, wz = v[2]![2]! - v[0]![2]!;
      const nx = uy * wz - uz * wy, ny = uz * wx - ux * wz, nz = ux * wy - uy * wx;
      const area = Math.hypot(nx, ny, nz) / 2;
      console.log(`${key} ${id.padEnd(9)} along ${along.toFixed(1).padStart(5)} across ${across.toFixed(1).padStart(5)} y ${my.toFixed(2)} dy ${dy.toFixed(2)} overGround ${(my - g).toFixed(2).padStart(6)} area ${area.toFixed(2)} ny ${(ny / (2 * area || 1)).toFixed(2)}`);
    }
  }
}

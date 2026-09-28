/* scratch: open (boundary) edges of the upper water near each river-15 lip that are NOT at a shore: an edge used by
 * one triangle whose midpoint has the ground well under the water (> 0.6 m) and is not on the lip line = a crack. */
import fs from "node:fs";
import { createWorldField, voxelChunkDoc, worldRecipeSchema } from "@hitreg/core";
const recipe = worldRecipeSchema.parse(JSON.parse(fs.readFileSync("projects/voxel-demo/assets/worlds/mmo.json", "utf8")));
const field = createWorldField(recipe);
const falls = field.falls.filter((f) => f.river === "river-15").sort((a, b) => b.top - a.top);
const size = recipe.cellSize;
for (const [fi, fall] of falls.entries()) {
  const lx = fall.x - fall.dirX * 3.45, lz = fall.z - fall.dirZ * 3.45;
  const edges = new Map<string, { n: number; a: number[]; b: number[] }>();
  const key = (p: number[]) => `${p[0]!.toFixed(2)},${p[1]!.toFixed(2)},${p[2]!.toFixed(2)}`;
  for (let ox = -1; ox <= 1; ox++) for (let oz = -1; oz <= 1; oz++) {
    const cx = Math.floor(lx / size) + ox, cz = Math.floor(lz / size) + oz;
    const d = voxelChunkDoc(field, "mmo", cx, cz, { scatter: false, collision: false });
    for (const [id, e] of Object.entries(d.entities)) {
      if (!id.startsWith("water")) continue;
      const s = (e.components["mesh"] as { source: { positions: number[]; indices: number[] } }).source;
      const P = (i: number) => [s.positions[i * 3]! + cx * size, s.positions[i * 3 + 1]!, s.positions[i * 3 + 2]! + cz * size];
      for (let t = 0; t < s.indices.length; t += 3) for (let k = 0; k < 3; k++) {
        const a = P(s.indices[t + k]!), b = P(s.indices[t + ((k + 1) % 3)]!);
        const ka = key(a), kb = key(b); const kk = ka < kb ? ka + "|" + kb : kb + "|" + ka;
        const got = edges.get(kk); if (got) got.n++; else edges.set(kk, { n: 1, a, b });
      }
    }
  }
  let cracks = 0;
  for (const { n, a, b } of edges.values()) {
    if (n !== 1) continue;
    const mx = (a[0]! + b[0]!) / 2, my = (a[1]! + b[1]!) / 2, mz = (a[2]! + b[2]!) / 2;
    if (Math.abs(my - fall.top) > 0.1) continue;
    const along = (mx - lx) * fall.dirX + (mz - lz) * fall.dirZ, across = -(mx - lx) * fall.dirZ + (mz - lz) * fall.dirX;
    if (along < -8 || along > -0.02 || Math.abs(across) > 14) continue;
    const g = field.height(mx, mz);
    if (my - g < 0.6) continue;
    cracks++;
    if (cracks <= 12) console.log(`  lip ${fi} crack a ${a.map((v) => v.toFixed(3))} b ${b.map((v) => v.toFixed(3))} len ${Math.hypot(a[0]! - b[0]!, a[2]! - b[2]!).toFixed(2)} at along ${along.toFixed(2)} across ${across.toFixed(2)} depth ${(my - g).toFixed(2)}`);
  }
  console.log(`lip ${fi}: ${cracks} open interior edges`);
}

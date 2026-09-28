import fs from "node:fs";
import { createWorldField, worldRecipeSchema } from "@hitreg/core";
const recipe = worldRecipeSchema.parse(JSON.parse(fs.readFileSync("projects/voxel-demo/assets/worlds/mmo.json", "utf8")));
const field = createWorldField(recipe);
const found: { h: number; spot: unknown[] }[] = [];
for (const r of field.rivers) {
  for (let k = 1; k + 2 < r.points.length; k++) {
    const len = Math.hypot(r.points[k]![0] - r.points[k - 1]![0], r.points[k]![1] - r.points[k - 1]![1]);
    const drop = r.surfaceY![k - 1]! - r.surfaceY![k]!;
    if (len > 3.5 || drop < 4) continue;
    // camera downstream of the fall, looking back up at it
    const d = r.points[Math.min(r.points.length - 1, k + 3)]!;
    const [x, z] = r.points[k]!;
    found.push({ h: drop, spot: [`fall-${r.id}-${k}`, x, r.surfaceY![k]! + drop * 0.4, z, d[0] - x, d[1] - z, 8 + drop * 0.3, 40 + drop] });
  }
}
found.sort((a, b) => b.h - a.h);
// a medium one, a big one, and one of the smaller
const pick = [found[0]!, found[Math.floor(found.length * 0.3)]!, found[Math.floor(found.length * 0.6)]!];
console.log(JSON.stringify(pick.map((p) => p.spot)));

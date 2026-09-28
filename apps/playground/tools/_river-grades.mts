/* scratch: per river, how much of its length is steep, where its falls are, how much it drops */
import fs from "node:fs";
import { createWorldField, worldRecipeSchema } from "@hitreg/core";
const recipe = worldRecipeSchema.parse(JSON.parse(fs.readFileSync("projects/voxel-demo/assets/worlds/mmo.json", "utf8")));
const field = createWorldField(recipe);
let tot = { len: 0, steep: 0, falls: 0, drop: 0, headSteep: 0 };
const rows: string[] = [];
for (const r of field.rivers) {
  const n = r.points.length;
  const along = [0];
  for (let k = 1; k < n; k++) along.push(along[k - 1]! + Math.hypot(r.points[k]![0] - r.points[k - 1]![0], r.points[k]![1] - r.points[k - 1]![1]));
  const L = along[n - 1]!;
  // grade of the WATER over 100 m windows
  let steep = 0;
  for (let k = 0, j = 0; k < n; k++) {
    while (j < n - 1 && along[j]! - along[k]! < 100) j++;
    if (along[j]! - along[k]! < 50) break;
    const g = (r.surfaceY![k]! - r.surfaceY![j]!) / (along[j]! - along[k]!);
    if (g > 0.04 && k + 1 < n) steep += along[k + 1]! - along[k]!;
  }
  let falls = 0;
  let firstFlat = L;
  for (let k = 1; k < n; k++) if (r.surfaceY![k - 1]! - r.surfaceY![k]! >= 1.5 && along[k]! - along[k - 1]! <= 3.5) falls++;
  const drop = r.surfaceY![0]! - Math.max(recipe.seaLevel, r.surfaceY![n - 1]!);
  tot.len += L; tot.steep += steep; tot.falls += falls; tot.drop += drop;
  rows.push(`${r.id.padEnd(10)} ${(L / 1000).toFixed(1).padStart(5)} km  drop ${drop.toFixed(0).padStart(4)} m  steep(>4%/100m) ${((100 * steep) / L).toFixed(0).padStart(3)} %  falls ${falls}`);
}
console.log(rows.join("\n"));
console.log(`TOTAL ${(tot.len / 1000).toFixed(1)} km, ${((100 * tot.steep) / tot.len).toFixed(0)} % steep, ${tot.falls} falls, mean drop ${(tot.drop / field.rivers.length).toFixed(0)} m`);

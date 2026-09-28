/* scratch: the river profiles as runs and falls */
import fs from "node:fs";
import { createWorldField, worldRecipeSchema } from "@hitreg/core";
const recipe = worldRecipeSchema.parse(JSON.parse(fs.readFileSync(process.argv[2] ?? "projects/voxel-demo/assets/worlds/mmo.json", "utf8")));
const t0 = performance.now();
const field = createWorldField(recipe);
console.log(`field ${(performance.now() - t0).toFixed(0)} ms`);
const falls: number[] = [];
const gaps: number[] = [];
const grades: number[] = [];
let lenRun = 0, lenAll = 0;
for (const r of field.rivers) {
  let since = 0;
  for (let k = 1; k < r.points.length; k++) {
    const len = Math.hypot(r.points[k]![0] - r.points[k - 1]![0], r.points[k]![1] - r.points[k - 1]![1]);
    const drop = r.surfaceY![k - 1]! - r.surfaceY![k]!;
    lenAll += len;
    if (drop >= 1 && len <= 3.5) { falls.push(drop); gaps.push(since); since = 0; }
    else { since += len; lenRun += len; if (len > 3.5) grades.push(drop / len); }
  }
}
const q = (a: number[], f: number) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor(f * (s.length - 1))]!.toFixed(3) : "-"; };
console.log(`falls ${falls.length}: height p10/50/90 ${q(falls, 0.1)} / ${q(falls, 0.5)} / ${q(falls, 0.9)} m; run between falls p10/50/90 ${q(gaps, 0.1)} / ${q(gaps, 0.5)} / ${q(gaps, 0.9)} m`);
console.log(`run grade p50/p90/max ${q(grades, 0.5)} / ${q(grades, 0.9)} / ${q(grades, 1)}; ${(100 * lenRun / lenAll).toFixed(1)} % of length is running water`);

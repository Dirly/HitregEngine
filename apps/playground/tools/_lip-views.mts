/* scratch: close camera views of each river-15 lip (front, just over lip level; low side angle) for w-shots EXTRA */
import fs from "node:fs";
import { createWorldField, worldRecipeSchema } from "@hitreg/core";
const recipe = worldRecipeSchema.parse(JSON.parse(fs.readFileSync("projects/voxel-demo/assets/worlds/mmo.json", "utf8")));
const field = createWorldField(recipe);
const falls = field.falls.filter((f) => f.river === "river-15").sort((a, b) => b.top - a.top);
const views: { name: string; cam: number[]; target: number[] }[] = [];
const r = (v: number) => Math.round(v * 10) / 10;
falls.forEach((f, i) => {
  const lx = f.x - f.dirX * 3, lz = f.z - f.dirZ * 3, px = -f.dirZ, pz = f.dirX;
  const t = [r(lx), r(f.top - 0.6), r(lz)];
  // front: 11 m downstream of the lip, 1.5 m over it, looking back at the brink
  views.push({ name: `lip${i}-front`, cam: [r(lx + f.dirX * 11), r(f.top + 1.5), r(lz + f.dirZ * 11)], target: t });
  // low side: 9 m out to one side and 4 m downstream, 0.8 m over the upper water, looking at the lip corner
  const cx = lx + px * 9 + f.dirX * 4, cz = lz + pz * 9 + f.dirZ * 4;
  let cy = f.top + 0.8;
  cy = Math.max(cy, field.height(cx, cz) + 1.2);
  views.push({ name: `lip${i}-side`, cam: [r(cx), r(cy), r(cz)], target: [r(lx + px * 3), r(f.top - 0.8), r(lz + pz * 3)] });
  // above: looking down at the join from upstream
  views.push({ name: `lip${i}-above`, cam: [r(lx - f.dirX * 5), r(f.top + 7), r(lz - f.dirZ * 5)], target: [r(lx + f.dirX * 1), r(f.top - 1), r(lz + f.dirZ * 1)] });
});
console.log(JSON.stringify(views));

/* scratch: review cameras over a world's sea bed, as [name, cx, cy, cz, tx, ty, tz]
 *   npx tsx tools/_sea-views.mts <recipe.json> [bearings=4]
 * For each bearing from the world centre: past the last land on the ray, find the bed ~5 m and ~14 m deep and the
 * foot of the shelf drop; a diver's-eye camera at each (looking along the shore, and one looking out to sea) and
 * one from above the surface. */
import fs from "node:fs";
import { createWorldField, worldRecipeSchema } from "@hitreg/core";
const recipe = worldRecipeSchema.parse(JSON.parse(fs.readFileSync(process.argv[2]!, "utf8")));
const n = Number(process.argv[3] ?? 4);
const field = createWorldField(recipe);
const sea = recipe.seaLevel;
const out: [string, number, number, number, number, number, number][] = [];
for (let b = 0; b < n; b++) {
  const a = (b / n) * Math.PI * 2 + 0.3, dx = Math.cos(a), dz = Math.sin(a), px = -dz, pz = dx;
  let last = 0;
  for (let r = 0; r < 2600; r += 8) if (field.height(dx * r, dz * r) > sea) last = r;
  const want = [5, 14, 26];
  let wi = 0;
  for (let r = last; r < last + 900 && wi < want.length; r += 2) {
    const x = dx * r, z = dz * r, h = field.height(x, z);
    if (sea - h < want[wi]!) continue;
    const eye = Math.min(h + 2.2, sea - 0.8);
    if (wi === 0) out.push([`b${b}-d${want[wi]}-along`, x - px * 10, eye, z - pz * 10, x + px * 8, h + 0.8, z + pz * 8]);
    if (wi === 1) {
      out.push([`b${b}-d${want[wi]}-seaward`, x - dx * 10, eye, z - dz * 10, x + dx * 10, h - 1, z + dz * 10]);
      out.push([`b${b}-d${want[wi]}-above`, x - dx * 16, sea + 10, z - dz * 16, x + dx * 8, h, z + dz * 8]);
    }
    if (wi === 2) out.push([`b${b}-d${want[wi]}-shoreward`, x + dx * 12, h + 3, z + dz * 12, x - dx * 10, h + 6, z - dz * 10]);
    wi++;
  }
}
console.log(JSON.stringify(out));

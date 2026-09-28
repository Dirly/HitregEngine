import fs from "node:fs";
import { createWorldField, worldRecipeSchema } from "@hitreg/core";
const recipe = worldRecipeSchema.parse(JSON.parse(fs.readFileSync("projects/voxel-demo/assets/worlds/mmo.json", "utf8")));
const field = createWorldField(recipe) as any;
// steep rocky ground within ~1.5 km of the site
const hits: any[] = [];
for (let dx = -3000; dx <= 3000; dx += 80) for (let dz = -3000; dz <= 3000; dz += 80) {
  const x = 5358 + dx, z = -3872 + dz;
  const b = field.biome(x, z);
  if (b.slope > 0.6 && ["highland","montane","alpine","crag"].includes(b.id)) hits.push([b.id, x, z, +b.slope.toFixed(2), Math.round(field.groundHeight?.(x, z) ?? 0), Math.hypot(dx, dz) | 0]);
}
hits.sort((a, b) => a[5] - b[5]);
console.log(hits.filter((h) => h[5] > 250).slice(0, 25).map((h) => h.join(" ")).join("\n"));

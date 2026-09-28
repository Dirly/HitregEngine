/* scratch: camera spots on lake shores, near and far */
import fs from "node:fs";
import { worldRecipeSchema } from "@hitreg/core";
const recipe = worldRecipeSchema.parse(JSON.parse(fs.readFileSync("projects/voxel-demo/assets/worlds/mmo.json", "utf8")));
const spots: unknown[] = [];
for (const id of ["lake-3", "lake-11", "lake-9"]) {
  const lake = recipe.features.lakes.find((l) => l.id === id);
  if (!lake || !lake.polygon) continue;
  const p = lake.polygon[Math.floor(lake.polygon.length / 3)]!;
  const dx = p[0] - lake.center[0], dz = p[1] - lake.center[1];
  const l = Math.hypot(dx, dz) || 1;
  // camera out over the land, looking back at the shore
  spots.push([`near-${id}`, p[0], lake.waterY, p[1], dx / l, dz / l, 14, 36]);
  spots.push([`far-${id}`, p[0], lake.waterY, p[1], dx / l, dz / l, 70, 260]);
}
console.log(JSON.stringify(spots));

import fs from "node:fs";
import { createWorldField, worldRecipeSchema } from "@hitreg/core";
const recipe = worldRecipeSchema.parse(JSON.parse(fs.readFileSync("projects/voxel-demo/assets/worlds/mmo.json", "utf8")));
const field = createWorldField(recipe);
const falls = [...field.falls].sort((a, b) => (b.top - b.bottom) - (a.top - a.bottom));
const spots: unknown[] = [];
for (const f of [falls[0]!, falls[Math.floor(falls.length / 2)]!]) {
  const h = f.top - f.bottom;
  // from the pool, low, looking back up at the fall
  spots.push([`pool-${f.river}`, f.x, f.bottom + h * 0.45, f.z, f.dirX, f.dirZ, 3 - h * 0.45, 22 + h * 0.6]);
  // from beside the crest, above it
  const lx = f.x - f.dirX * 3, lz = f.z - f.dirZ * 3;
  spots.push([`crest-${f.river}`, lx, f.top, lz, -f.dirZ - f.dirX * 0.6, f.dirX - f.dirZ * 0.6, 10, 26]);
}
console.log(JSON.stringify(spots));

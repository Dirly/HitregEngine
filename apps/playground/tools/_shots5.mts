import fs from "node:fs";
import { createWorldField, worldRecipeSchema } from "@hitreg/core";
const recipe = worldRecipeSchema.parse(JSON.parse(fs.readFileSync("projects/voxel-demo/assets/worlds/mmo.json", "utf8")));
const field = createWorldField(recipe);
const ws = { y: 0, flowX: 0, flowZ: 0, kind: "lake" as "lake" | "river", floor: 0 };
const spots: unknown[] = [];
for (const f of field.falls) {
  const lx = f.x - f.dirX * 8, lz = f.z - f.dirZ * 8;
  const spill = field.waterSurface(lx, lz, ws) && ws.kind === "lake";
  if (!spill) continue;
  const h = f.top - f.bottom;
  // from beside and above the lip, looking across it (Derek's angle)
  spots.push([`spill-${f.river}`, f.x - f.dirX * 3, f.top - h * 0.3, f.z - f.dirZ * 3, -f.dirZ * 1.2 + f.dirX * 0.6, f.dirX * 1.2 + f.dirZ * 0.6, h * 0.6 + 8, 30 + h * 0.4]);
  if (spots.length >= 3) break;
}
console.log(JSON.stringify(spots));

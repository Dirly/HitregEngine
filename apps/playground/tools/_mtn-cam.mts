import fs from "node:fs";
import { createWorldField, worldRecipeSchema } from "@hitreg/core";
const recipe = worldRecipeSchema.parse(JSON.parse(fs.readFileSync("projects/voxel-demo/assets/worlds/mmo.json", "utf8")));
const f = createWorldField(recipe);
const out: any[] = [];
for (const [name, tx, tz, cx, cz] of [["m1-highland", 5398, -2952, 5398, -3250], ["m2-montane", 5878, -3112, 5700, -3400]] as const) {
  const ty = f.height(tx, tz), cy = Math.max(f.height(cx, cz), ty - 30) + 25;
  out.push({ name, cam: [cx, cy, cz], target: [tx, ty, tz] });
}
console.log(JSON.stringify(out));

import fs from "node:fs";
import { createWorldField, worldRecipeSchema } from "@hitreg/core";
const recipe = worldRecipeSchema.parse(JSON.parse(fs.readFileSync("projects/voxel-demo/assets/worlds/mmo.json", "utf8")));
const field = createWorldField(recipe);
// ground minus natural along cross-sections at several distances along the cascade
const cx = 5358;
for (const z of [-3830, -3845, -3860, -3870, -3885, -3900, -3915]) {
  const row: string[] = [];
  for (let x = cx - 40; x <= cx + 40; x += 5) row.push((field.height(x, z) - field.naturalHeight(x, z)).toFixed(0).padStart(4));
  console.log(String(z).padStart(6), row.join(""), "  surf:", field.biome(cx + 25, z).surface ? "" : "");
}

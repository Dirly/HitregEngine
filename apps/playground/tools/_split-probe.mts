import fs from "node:fs";
import { createWorldField, worldRecipeSchema } from "@hitreg/core";
const recipe = worldRecipeSchema.parse(JSON.parse(fs.readFileSync("projects/voxel-demo/assets/worlds/mmo.json", "utf8")));
const field = createWorldField(recipe);
const natural = createWorldField({ ...recipe, features: { ...recipe.features, rivers: [], roads: [], bridges: [], towns: [] } });
for (const f of field.falls) {
  const drop = f.top - f.bottom;
  const lip = [f.x - f.dirX * 3, f.z - f.dirZ * 3];
  const px = -f.dirZ, pz = f.dirX;
  const rows: string[] = [];
  for (const side of [1, -1]) for (const off of [f.width / 2 + 14, f.width / 2 + 22, f.width / 2 + 30]) {
    const x = lip[0]! + px * side * off, z = lip[1]! + pz * side * off;
    rows.push(`${side > 0 ? "+" : "-"}${off.toFixed(0)}: top ${(natural.height(x, z) - f.top).toFixed(1)} below ${(natural.height(x + f.dirX * 10, z + f.dirZ * 10) - f.top).toFixed(1)}`);
  }
  console.log(`${f.river} drop ${drop.toFixed(0)} | ${rows.join(" | ")}`);
}

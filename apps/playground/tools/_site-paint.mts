import fs from "node:fs";
import { createWorldField, worldRecipeSchema } from "@hitreg/core";
const recipe = worldRecipeSchema.parse(JSON.parse(fs.readFileSync("projects/voxel-demo/assets/worlds/mmo.json", "utf8")));
const field = createWorldField(recipe);
const names = recipe.surfaces.map((s) => (s as { name?: string; id?: string }).name ?? (s as { id?: string }).id);
for (const x of [5358 + 12, 5358 + 18, 5358 + 25, 5358 + 32, 5358 + 45]) {
  const z = -3870;
  const b = field.biome(x, z);
  const top = [...b.surface].map((w, i) => [names[i], w] as const).filter(([, w]) => w > 0.05).map(([n, w]) => `${n}:${w.toFixed(2)}`).join(" ");
  console.log(x - 5358, "biome", b.id, "slope", b.slope.toFixed(2), "clearance", field.featureClearance(x, z).toFixed(1), "|", top);
}

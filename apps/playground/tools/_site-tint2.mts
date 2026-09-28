import fs from "node:fs";
import { createWorldField, worldRecipeSchema } from "@hitreg/core";
const recipe = worldRecipeSchema.parse(JSON.parse(fs.readFileSync("projects/voxel-demo/assets/worlds/mmo.json", "utf8")));
const field = createWorldField(recipe) as any;
const names = recipe.surfaces.map((s: any) => s.name); const n = names.length;
const out = new Float32Array(n + 3);
for (const [x, z] of [[5368, -3935], [5372, -3925], [5362, -3940], [5375, -3945], [5340, -3900], [5330, -3880]]) {
  const y = field.height(x, z); const sl = field.slope(x, z);
  const ny = Math.cos(Math.asin(Math.min(1, sl)));
  field.surfaceAt(x, y, z, 1 - sl, out, 0);
  const top = [...out.slice(0, n)].map((w, i) => [names[i], w] as const).filter(([, w]) => w > 0.05).map(([k, w]) => `${k}:${w.toFixed(2)}`).join(" ");
  console.log(x, z, "d", Math.hypot(x - 5358, z + 3872).toFixed(0), "y", y.toFixed(1), "slope", sl.toFixed(2), field.biome(x, z).id, "|", top);
}

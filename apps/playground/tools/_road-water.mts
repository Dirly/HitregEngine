import fs from "node:fs";
import { createWorldField, worldRecipeSchema } from "@hitreg/core";
const recipe = worldRecipeSchema.parse(JSON.parse(fs.readFileSync("projects/voxel-demo/assets/worlds/mmo.json", "utf8")));
const field = createWorldField(recipe);
for (const road of recipe.features.roads) {
  if (!road.surfaceY) continue;
  for (let i = 0; i + 1 < road.points.length; i++) {
    const a = road.points[i]!, b = road.points[i + 1]!;
    const steps = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / 4));
    for (let k = 0; k < steps; k++) {
      const t = k / steps, x = a[0] + (b[0] - a[0]) * t, z = a[1] + (b[1] - a[1]) * t;
      const w = field.waterY(x, z);
      if (w === null || w <= recipe.seaLevel + 0.05) continue;
      const y = road.surfaceY[i]! + (road.surfaceY[i + 1]! - road.surfaceY[i]!) * t;
      if (y < w - 0.8) console.log(road.id, i, [x.toFixed(0), z.toFixed(0)], "road", y.toFixed(2), "water", w.toFixed(2), "ground", field.height(x, z).toFixed(2));
    }
  }
}

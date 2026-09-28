import fs from "node:fs";
import { createWorldField, worldRecipeSchema } from "@hitreg/core";
const recipe = worldRecipeSchema.parse(JSON.parse(fs.readFileSync("projects/voxel-demo/assets/worlds/mmo.json", "utf8")));
const field = createWorldField(recipe);
const ws = { y: 0, flowX: 0, flowZ: 0, kind: "lake" as "lake" | "river", floor: 0 };
for (const lake of recipe.features.lakes) {
  const t = performance.now();
  field.waterSurface(lake.center[0], lake.center[1], ws);
  const p = lake.polygon?.[0] ?? lake.center;
  const d = Math.hypot(p[0] - lake.center[0], p[1] - lake.center[1]) || 1;
  field.waterSurface(p[0] + ((p[0] - lake.center[0]) / d) * lake.bank, p[1] + ((p[1] - lake.center[1]) / d) * lake.bank, ws);
  console.log(lake.id, "r", Math.round(lake.radius), (performance.now() - t).toFixed(0), "ms");
}

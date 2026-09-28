import fs from "node:fs";
import { createWorldField, worldRecipeSchema } from "@hitreg/core";
const recipe = worldRecipeSchema.parse(JSON.parse(fs.readFileSync("projects/voxel-demo/assets/worlds/mmo.json", "utf8")));
const field = createWorldField(recipe);
const r = field.rivers.find((d) => d.id === process.argv[2])!;
let s = 0;
r.points.forEach((p, k) => {
  if (k) s += Math.hypot(p[0] - r.points[k - 1]![0], p[1] - r.points[k - 1]![1]);
  if (k < 30) console.log(k, s.toFixed(1), "water", r.surfaceY![k], "bed", r.bedY![k], "ground", field.height(p[0], p[1]).toFixed(1));
});

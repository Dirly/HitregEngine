import fs from "node:fs";
import { createWorldField, worldRecipeSchema } from "@hitreg/core";
const recipe = worldRecipeSchema.parse(JSON.parse(fs.readFileSync("projects/voxel-demo/assets/worlds/mmo.json", "utf8")));
const field = createWorldField(recipe);
const f = field.falls[0]!;
for (const [label, cx, cz] of [["near fall", f.x, f.z], ["far", f.x + 800, f.z + 800]] as const) {
  const t = performance.now();
  let n = 0;
  for (let z = -48; z < 48; z += 2) for (let x = -48; x < 48; x += 2) { field.height(cx + x, cz + z); n++; }
  console.log(label, ((performance.now() - t) * 1000 / n).toFixed(1), "us/column");
}

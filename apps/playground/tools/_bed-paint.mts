import fs from "node:fs";
import { createWorldField, worldRecipeSchema } from "@hitreg/core";
const recipe = worldRecipeSchema.parse(JSON.parse(fs.readFileSync("projects/voxel-demo/assets/worlds/mmo.json", "utf8")));
const field = createWorldField(recipe);
const names = recipe.surfaces.map((s) => (s as { name?: string }).name ?? "?");
const g = names.indexOf("gravel");
const out = new Float32Array(field.surfaceCount);
let n = 0, painted = 0;
for (const r of field.rivers) for (let k = 0; k < r.points.length; k += 4) {
  const [x, z] = r.points[k]!;
  const s = field.slope(x, z);
  if (s > 0.5) continue;
  field.splatAt(x, field.height(x, z), z, Math.sqrt(1 - s * s), out, 0);
  n++;
  if (out[g]! > 0.5) painted++;
}
console.log(`gentle river-bed samples ${n}: gravel-painted ${painted} (${((100 * painted) / n).toFixed(1)} %)`);

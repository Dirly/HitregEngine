/* scratch: ground height at points, and an outdoor viewpoint a given distance from a target */
import fs from "node:fs";
import { createWorldField, worldRecipeSchema } from "@hitreg/core";

const recipe = worldRecipeSchema.parse(JSON.parse(fs.readFileSync("projects/voxel-demo/assets/worlds/voxel-demo.json", "utf8")));
const field = createWorldField(recipe);
const [tx, tz, dist] = process.argv.slice(2).map(Number);
// try 16 directions; report ground + water at the candidate and the max ground along the line of sight
for (let k = 0; k < 16; k++) {
  const a = (k / 16) * Math.PI * 2;
  const x = tx + Math.cos(a) * dist;
  const z = tz + Math.sin(a) * dist;
  const g = field.height(x, z);
  const w = field.waterY(x, z);
  let blockMax = -Infinity;
  for (let s = 0.1; s < 0.95; s += 0.05) blockMax = Math.max(blockMax, field.height(tx + (x - tx) * s, tz + (z - tz) * s));
  console.log(`dir ${k.toString().padStart(2)}: at [${x.toFixed(0)}, ${z.toFixed(0)}] ground ${g.toFixed(1)} water ${w ?? "-"} maxBetween ${blockMax.toFixed(1)}`);
}
console.log(`target ground ${field.height(tx, tz).toFixed(1)} water ${field.waterY(tx, tz)}`);

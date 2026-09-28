/* scratch: long profile of a river chain (bed, surface, ground, natural ground) from the RECIPE docs and the solved ones */
import fs from "node:fs";
import { createWorldField, worldRecipeSchema } from "@hitreg/core";

const recipe = worldRecipeSchema.parse(JSON.parse(fs.readFileSync("projects/voxel-demo/assets/worlds/mmo.json", "utf8")));
const field = createWorldField(recipe);
const prefix = process.argv[2]!;
const every = Number(process.argv[3] ?? 5);
for (const r of field.rivers) {
  if (r.id !== prefix && !r.id.startsWith(prefix + ".")) continue;
  console.log(`== ${r.id} (${r.points.length} pts) first [${r.points[0]}] last [${r.points[r.points.length - 1]}]`);
  let along = 0;
  for (let k = 0; k < r.points.length; k++) {
    if (k > 0) along += Math.hypot(r.points[k]![0] - r.points[k - 1]![0], r.points[k]![1] - r.points[k - 1]![1]);
    if (k % every !== 0 && k !== r.points.length - 1) continue;
    const [x, z] = r.points[k]!;
    console.log(
      `${along.toFixed(0).padStart(6)}  bed ${r.bedY![k]!.toFixed(1).padStart(6)}  water ${r.surfaceY![k]!.toFixed(1).padStart(6)}  ground ${field.height(x, z).toFixed(1).padStart(6)}  natural ${field.naturalHeight(x, z).toFixed(1).padStart(6)}`,
    );
  }
}

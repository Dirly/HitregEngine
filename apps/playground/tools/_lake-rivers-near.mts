/* scratch: river samples within 40 m of given points, with their levels (to see which rivers block a lake's reach) */
import fs from "node:fs";
import { createWorldField, worldRecipeSchema } from "@hitreg/core";
const recipe = worldRecipeSchema.parse(JSON.parse(fs.readFileSync("projects/voxel-demo/assets/worlds/mmo.json", "utf8")));
const field = createWorldField(recipe);
const pts = process.argv.slice(2).map((s) => s.split(",").map(Number) as [number, number]);
for (const [x, z] of pts) {
  console.log(`@ ${x},${z}`);
  for (const r of field.rivers as { id?: string; points: [number, number][]; surfaceY?: number[] }[]) {
    r.points.forEach((p, k) => {
      const d = Math.hypot(p[0] - x, p[1] - z);
      if (d < 40) console.log(`  ${r.id}[${k}/${r.points.length}] d ${d.toFixed(1)} surf ${r.surfaceY?.[k]?.toFixed(2)}`);
    });
  }
}
for (const l of recipe.features.lakes) if (["lake-1", "lake-6", "lake-11", "lake-16"].includes(l.id ?? "")) console.log(l.id, l.waterY, l.bank);

import fs from "node:fs";
import { createWorldField, worldRecipeSchema } from "@hitreg/core";
const recipe = worldRecipeSchema.parse(JSON.parse(fs.readFileSync("projects/voxel-demo/assets/worlds/mmo.json", "utf8")));
const field = createWorldField(recipe);
const ws = { y: 0, flowX: 0, flowZ: 0, kind: "lake" as "lake" | "river", floor: 0 };
for (const r of field.rivers) for (let k = 1; k < r.points.length; k++) {
  const [x, z] = r.points[k]!;
  const g = field.height(x, z);
  if (g >= r.bedY![k]! - 3) continue;
  if (field.waterSurface(x, z, ws) && ws.kind === "lake") continue;
  const nearFall = field.falls.some((f) => Math.hypot(f.x - x, f.z - z) < 12);
  console.log(r.id, k, [x.toFixed(0), z.toFixed(0)], "ground", g.toFixed(1), "bed", r.bedY![k], "nearFall", nearFall);
}

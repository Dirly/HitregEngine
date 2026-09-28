/* scratch: every place a river leaves a lake, and how far its water drops at the shore */
import fs from "node:fs";
import { createWorldField, worldRecipeSchema } from "@hitreg/core";
const recipe = worldRecipeSchema.parse(JSON.parse(fs.readFileSync("projects/voxel-demo/assets/worlds/mmo.json", "utf8")));
const field = createWorldField(recipe);
const ws = { y: 0, flowX: 0, flowZ: 0, kind: "lake" as "lake" | "river", floor: 0 };
for (const r of field.rivers) {
  for (let k = 1; k < r.points.length; k++) {
    const [px, pz] = r.points[k - 1]!;
    const [x, z] = r.points[k]!;
    const prevLake = field.waterSurface(px, pz, ws) && ws.kind === "lake" ? ws.y : NaN;
    if (Number.isNaN(prevLake)) continue;
    if (field.waterSurface(x, z, ws) && ws.kind === "lake") continue;
    // the river's water over the next 60 m
    const next = r.surfaceY!.slice(k, k + 8);
    const g = next.map((_, j) => field.height(r.points[k + j]![0], r.points[k + j]![1]).toFixed(1));
    console.log(`${r.id}[${k}] at [${x.toFixed(0)},${z.toFixed(0)}] lake ${prevLake.toFixed(1)} -> water ${next.map((v) => v.toFixed(1)).join(" ")} | ground ${g.join(" ")}`);
  }
}
const f = field.falls.map((f) => `${f.river} [${f.x.toFixed(0)},${f.z.toFixed(0)}] ${f.top.toFixed(1)}->${f.bottom.toFixed(1)}`);
console.log("falls:", f.join("  "));

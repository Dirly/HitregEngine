import fs from "node:fs";
import { createWorldField, worldRecipeSchema } from "@hitreg/core";
const recipe = worldRecipeSchema.parse(JSON.parse(fs.readFileSync("projects/voxel-demo/assets/worlds/mmo.json", "utf8")));
const field = createWorldField(recipe);
const lake = recipe.features.lakes.find((l) => l.id === process.argv[2])!;
const [mx, mz] = process.argv[3]!.split(",").map(Number) as [number, number];
const dx = mx - lake.center[0], dz = mz - lake.center[1];
const l = Math.hypot(dx, dz);
const ws = { y: 0, flowX: 0, flowZ: 0, kind: "lake" as "lake" | "river", floor: 0 };
const near = field.falls.filter((f) => Math.hypot(f.x - mx, f.z - mz) < 120).map((f) => f.river);
console.log(lake.id, "waterY", lake.waterY, "bank", lake.bank, "falls near", near.join(","));
for (let t = -4; t <= 30; t += 2) {
  const x = mx + (dx / l) * t, z = mz + (dz / l) * t;
  const w = field.waterSurface(x, z, ws) ? `${ws.kind} ${ws.y.toFixed(2)}` : "-";
  console.log(t.toString().padStart(4), "ground", field.height(x, z).toFixed(2), "natural", field.naturalHeight(x, z).toFixed(2), "water", w);
}

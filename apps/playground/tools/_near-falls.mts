import fs from "node:fs";
import { createWorldField, worldRecipeSchema } from "@hitreg/core";
const recipe = worldRecipeSchema.parse(JSON.parse(fs.readFileSync("projects/voxel-demo/assets/worlds/mmo.json", "utf8")));
const field = createWorldField(recipe);
const t = recipe.features.towns.find((t) => t.id === "town-1")!;
const ws = { y: 0, flowX: 0, flowZ: 0, kind: "lake" as "lake" | "river", floor: 0 };
field.falls.forEach((f, i) => {
  const d = Math.hypot(f.x - t.center[0], f.z - t.center[1]);
  if (d > 3000) return;
  const spill = field.waterSurface(f.x - f.dirX * 10, f.z - f.dirZ * 10, ws) && ws.kind === "lake";
  console.log(i, f.river, `d=${d.toFixed(0)}`, `top ${f.top.toFixed(1)} bottom ${f.bottom.toFixed(1)}`, spill ? "LAKE SPILL" : "", f.bottom <= recipe.seaLevel + 1 ? "TO SEA" : "");
});
console.log("town-1", t.center);

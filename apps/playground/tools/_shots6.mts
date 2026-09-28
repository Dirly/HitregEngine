import fs from "node:fs";
import { createWorldField, worldRecipeSchema } from "@hitreg/core";
const recipe = worldRecipeSchema.parse(JSON.parse(fs.readFileSync("projects/voxel-demo/assets/worlds/mmo.json", "utf8")));
const field = createWorldField(recipe);
const spots: unknown[] = [];
const casc = field.falls.filter((f) => f.river === "river-6").sort((a, b) => b.top - a.top);
if (casc.length) {
  const top = casc[0]!, bot = casc[casc.length - 1]!;
  const cx = (top.x + bot.x) / 2, cz = (top.z + bot.z) / 2, h = top.top - bot.bottom;
  spots.push(["cascade-front", cx, bot.bottom + h * 0.45, cz, bot.dirX, bot.dirZ, h * 0.25, 45 + h * 0.6]);
  spots.push(["cascade-side", cx, bot.bottom + h * 0.45, cz, bot.dirX - bot.dirZ * 1.4, bot.dirZ + bot.dirX * 1.4, h * 0.3, 50 + h * 0.5]);
}
const ws = { y: 0, flowX: 0, flowZ: 0, kind: "lake" as "lake" | "river", floor: 0 };
const spill = field.falls.find((f) => field.waterSurface(f.x - f.dirX * 8, f.z - f.dirZ * 8, ws) && ws.kind === "lake");
if (spill) spots.push(["spill", spill.x - spill.dirX * 3, spill.top - 4, spill.z - spill.dirZ * 3, -spill.dirZ + spill.dirX * 0.5, spill.dirX + spill.dirZ * 0.5, 14, 36]);
const lake = recipe.features.lakes[3]!;
spots.push(["lake-shore", lake.center[0], lake.waterY, lake.center[1], 1, 0.4, 25, lake.radius + 30]);
console.log(JSON.stringify(spots));

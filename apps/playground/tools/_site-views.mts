/* scratch: the fixed review views of one fall site (river-15 cascade by default) */
import fs from "node:fs";
import { createWorldField, worldRecipeSchema } from "@hitreg/core";
const recipe = worldRecipeSchema.parse(JSON.parse(fs.readFileSync("projects/voxel-demo/assets/worlds/mmo.json", "utf8")));
const field = createWorldField(recipe);
const river = process.argv[2] ?? "river-15";
const c = field.falls.filter((f) => f.river === river).sort((a, b) => b.top - a.top);
const top = c[0]!, bot = c[c.length - 1]!, h = top.top - bot.bottom;
const cx = (top.x + bot.x) / 2, cz = (top.z + bot.z) / 2, cy = bot.bottom + h * 0.45;
const dx = bot.dirX, dz = bot.dirZ, px = -dz, pz = dx;
console.log(JSON.stringify([
  ["1-front", cx, cy, cz, dx, dz, h * 0.15, 50 + h * 0.6],
  ["2-left", cx, cy, cz, dx * 0.6 + px, dz * 0.6 + pz, h * 0.3, 45 + h * 0.5],
  ["3-right", cx, cy, cz, dx * 0.6 - px, dz * 0.6 - pz, h * 0.6 + 8, 50 + h * 0.5],
  ["4-above", cx, cy, cz, dx * 0.3, dz * 0.3, 40 + h, 20],
  ["5-from-lake", top.x, top.top, top.z, -dx, -dz, 10, 40],
]));

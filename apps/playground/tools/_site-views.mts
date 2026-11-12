/* scratch: the fixed review views of one fall site, as cameras [name, cx, cy, cz, tx, ty, tz]
 *   npx tsx tools/_site-views.mts <river> [recipe.json]
 * Five framing views plus pool-eye and a 3/4 hero; a camera inside the ground is lifted clear of it. */
import fs from "node:fs";
import { createWorldField, worldRecipeSchema } from "@hitreg/core";
const river = process.argv[2] ?? "river-15";
const recipe = worldRecipeSchema.parse(JSON.parse(fs.readFileSync(process.argv[3] ?? "projects/proving/assets/worlds/mmo.json", "utf8")));
const field = createWorldField(recipe);
const c = field.falls.filter((f) => f.river === river).sort((a, b) => b.top - a.top);
if (!c.length) throw new Error(`no falls on ${river}`);
const top = c[0]!, bot = c[c.length - 1]!, h = top.top - bot.bottom;
const cx = (top.x + bot.x) / 2, cz = (top.z + bot.z) / 2, cy = bot.bottom + h * 0.45;
const dx = bot.dirX, dz = bot.dirZ, px = -dz, pz = dx;
const views: [string, number, number, number, number, number, number, number, number, number][] = [
  ["1-front", cx, cy, cz, dx, dz, h * 0.15, 50 + h * 0.6],
  ["2-left", cx, cy, cz, dx * 0.6 + px, dz * 0.6 + pz, h * 0.3, 45 + h * 0.5],
  ["3-right", cx, cy, cz, dx * 0.6 - px, dz * 0.6 - pz, h * 0.6 + 8, 50 + h * 0.5],
  ["4-above", cx, cy, cz, dx * 0.3, dz * 0.3, 40 + h, 20],
  ["5-from-lake", top.x, top.top, top.z, -dx, -dz, 10, 40],
  ["6-pool-eye", bot.x, bot.bottom + h * 0.4, bot.z, dx, dz, 1.8 - h * 0.4, 22],
  ["7-hero", cx, cy, cz, dx + px * 0.5, dz + pz * 0.5, h * 0.1, 30 + h * 0.4],
  ["8-close", bot.x, bot.bottom + h * 0.5, bot.z, dx + px * 0.35, dz + pz * 0.35, 2, 14],
];
console.log(JSON.stringify(views.map(([name, tx, ty, tz, vx, vz, up, back]) => {
  const l = Math.hypot(vx, vz) || 1;
  const x = tx + (vx / l) * back, z = tz + (vz / l) * back;
  let y = ty + up;
  const ws = { y: 0 } as never as { y: number };
  const floor = Math.max(field.height(x, z), field.waterSurface(x, z, ws as never) ? ws.y : -Infinity) + 1.7;
  if (y < floor) y = floor;
  return [name, x, y, z, tx, ty, tz];
})));

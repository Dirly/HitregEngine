/* scratch: water level / ground (rel. to the lip water) on rows across a river-15 lip: _lip-grid.mts <fall index> "<along list>" */
import fs from "node:fs";
import { createWorldField, worldRecipeSchema } from "@hitreg/core";
const recipe = worldRecipeSchema.parse(JSON.parse(fs.readFileSync("projects/voxel-demo/assets/worlds/mmo.json", "utf8")));
const field = createWorldField(recipe);
const falls = field.falls.filter((f) => f.river === "river-15").sort((a, b) => b.top - a.top);
const fall = falls[+process.argv[2]!]!;
const lx = fall.x - fall.dirX * 3, lz = fall.z - fall.dirZ * 3;
const ws = { y: 0, flowX: 0, flowZ: 0, kind: "lake" as "lake" | "river", floor: 0 };
for (const along of (process.argv[3] ?? "-0.3,-1,-2,-3").split(",").map(Number)) {
  let row = `${along}`.padStart(5) + ": ";
  for (let c = -12; c <= 12; c += 1) {
    const x = lx + fall.dirX * along - fall.dirZ * c, z = lz + fall.dirZ * along + fall.dirX * c;
    const h = field.height(x, z);
    const w = field.waterSurface(x, z, ws) ? (ws.y - fall.top).toFixed(1) : "--";
    row += `${w}/${(h - fall.top).toFixed(1)} `;
  }
  console.log(row);
}

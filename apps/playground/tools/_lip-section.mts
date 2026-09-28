/* scratch: vertical section along a river-15 fall's flow line — solid ('#') vs air, with water level marks */
import fs from "node:fs";
import { createWorldField, worldRecipeSchema } from "@hitreg/core";
const recipe = worldRecipeSchema.parse(JSON.parse(fs.readFileSync("projects/voxel-demo/assets/worlds/mmo.json", "utf8")));
const field = createWorldField(recipe);
const falls = field.falls.filter((f) => f.river === "river-15").sort((a, b) => b.top - a.top);
const fi = +(process.argv[2] ?? 1), across = +(process.argv[3] ?? 0);
const fall = falls[fi]!;
const lx = fall.x - fall.dirX * 3, lz = fall.z - fall.dirZ * 3;
const ws = { y: 0, flowX: 0, flowZ: 0, kind: "lake" as "lake" | "river", floor: 0 };
const Y0 = fall.bottom - 4, Y1 = fall.top + 5;
const cols: number[] = [];
for (let a = -12; a <= 8; a += 0.5) cols.push(a);
const water = cols.map((a) => { const x = lx + fall.dirX * a - fall.dirZ * across, z = lz + fall.dirZ * a + fall.dirX * across; return field.waterSurface(x, z, ws) ? ws.y : NaN; });
for (let y = Y1; y >= Y0; y -= 0.5) {
  let row = "";
  cols.forEach((a, k) => {
    const x = lx + fall.dirX * a - fall.dirZ * across, z = lz + fall.dirZ * a + fall.dirX * across;
    const solid = field.density(x, y, z) < 0;
    const w = water[k]!;
    row += solid ? "#" : !Number.isNaN(w) && Math.abs(w - y) < 0.25 ? "~" : !Number.isNaN(w) && y < w ? "w" : " ";
  });
  console.log(y.toFixed(1).padStart(6), row);
}
console.log("       " + cols.map((a) => (a === 0 ? "|" : a % 2 === 0 ? "'" : " ")).join(""));

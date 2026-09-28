/* scratch: ground minus lake level (dm, clamped) around the river-15 lake outlet, lip frame, 1 m; W = water kind */
import fs from "node:fs";
import { createWorldField, worldRecipeSchema } from "@hitreg/core";
const recipe = worldRecipeSchema.parse(JSON.parse(fs.readFileSync("projects/voxel-demo/assets/worlds/mmo.json", "utf8")));
const field = createWorldField(recipe);
const top = field.falls.filter((f) => f.river === "river-15").sort((a, b) => b.top - a.top)[0]!;
const L = 68.31, lx = top.x - top.dirX * 3, lz = top.z - top.dirZ * 3;
const ws = { y: 0, flowX: 0, flowZ: 0, kind: "lake" as "lake" | "river", floor: 0 };
for (let a = -14; a >= -52; a--) {
  let row = `${String(a).padStart(4)} `;
  for (let c = -24; c <= 22; c++) {
    const x = lx + a * top.dirX - c * top.dirZ, z = lz + a * top.dirZ + c * top.dirX;
    const g = field.height(x, z) - L;
    const w = field.waterSurface(x, z, ws) && ws.y + 0.35 > field.height(x, z);
    const ch = g >= 0 ? "#" : g > -0.5 ? "+" : g > -1 ? "=" : g > -2 ? "-" : " ";
    row += w ? (ws.kind === "lake" ? (g >= -1 ? "l" : "L") : g >= -1 ? "r" : "R") : ch;
  }
  console.log(row);
}

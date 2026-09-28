/* scratch: waterSurface flow (speed, heading) on rows across the river-15 outlet above the top lip */
import fs from "node:fs";
import { createWorldField, worldRecipeSchema } from "@hitreg/core";
const recipe = worldRecipeSchema.parse(JSON.parse(fs.readFileSync("projects/voxel-demo/assets/worlds/mmo.json", "utf8")));
const field = createWorldField(recipe);
const top = field.falls.filter((f) => f.river === "river-15").sort((a, b) => b.top - a.top)[0]!;
const lx = top.x - top.dirX * 3, lz = top.z - top.dirZ * 3;
const ws = { y: 0, flowX: 0, flowZ: 0, kind: "lake" as "lake" | "river", floor: 0 };
for (const a of [-4, -8, -12, -16, -20]) {
  let row = `${String(a).padStart(4)} `;
  for (let c = -16; c <= 8; c += 2) {
    const x = lx + a * top.dirX - c * top.dirZ, z = lz + a * top.dirZ + c * top.dirX;
    if (!field.waterSurface(x, z, ws)) { row += "   .     "; continue; }
    const sp = Math.hypot(ws.flowX, ws.flowZ);
    const hd = (Math.atan2(ws.flowZ, ws.flowX) * 180) / Math.PI;
    row += `${sp.toFixed(1)}@${hd.toFixed(0).padStart(4)} `;
  }
  console.log(row);
}

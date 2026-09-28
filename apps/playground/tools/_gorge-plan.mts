/* scratch: plan view of the river-15 site, 2 m cells, height bands of 4 m ('~' = water); arg "off" disables the site gorge */
import fs from "node:fs";
import { createWorldField, worldRecipeSchema } from "@hitreg/core";
const json = JSON.parse(fs.readFileSync("projects/voxel-demo/assets/worlds/mmo.json", "utf8"));
if (process.argv[2] === "off") for (const s of json.features.fallSites) s.gorge = { enabled: false };
const f = createWorldField(worldRecipeSchema.parse(json));
const ws = { y: 0, flowX: 0, flowZ: 0, kind: "lake" as "lake" | "river", floor: 0 };
const chars = "0123456789abcdefghijklmnopqrstuvwxyz";
console.log("x 5300..5420 (cols), z -3940..-3820 (rows, north up); band = floor((h-12)/4)");
for (let z = -3820; z >= -3940; z -= 2) {
  let row = "";
  for (let x = 5300; x <= 5420; x += 2) {
    const h = f.height(x, z);
    if (f.waterSurface(x, z, ws) && ws.y > h) row += "~";
    else row += chars[Math.max(0, Math.min(35, Math.floor((h - 12) / 4)))];
  }
  console.log(row);
}

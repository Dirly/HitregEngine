/* scratch: plan map of the site gorge's cut (after - before), 2 m cells: '.' none, 1-9 metres cut, '#' >= 10, '+' raised; 'L' lake water after */
import fs from "node:fs";
import { createWorldField, worldRecipeSchema } from "@hitreg/core";
const load = (off: boolean) => { const json = JSON.parse(fs.readFileSync("projects/voxel-demo/assets/worlds/mmo.json", "utf8")); if (off) for (const s of json.features.fallSites) s.gorge = { enabled: false }; return createWorldField(worldRecipeSchema.parse(json)); };
const B = load(true), A = load(false);
const ws = { y: 0, flowX: 0, flowZ: 0, kind: "lake" as "lake" | "river", floor: 0 };
let lakeDiff = 0;
for (let z = -3790; z >= -3960; z -= 2) {
  let row = "";
  for (let x = 5270; x <= 5450; x += 2) {
    const c = B.height(x, z) - A.height(x, z);
    const la = A.waterSurface(x, z, ws) && ws.kind === "lake" && ws.y > A.height(x, z); const lb = B.waterSurface(x, z, ws) && ws.kind === "lake" && ws.y > B.height(x, z);
    if (la !== lb) lakeDiff++;
    row += la && c < 0.05 ? "L" : c < -0.05 ? "+" : c < 0.05 ? "." : c >= 10 ? "#" : String(Math.max(1, Math.floor(c)));
  }
  console.log(row);
}
console.log("lake-water cells that differ:", lakeDiff);

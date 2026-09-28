/* scratch: lake sheet vs the top lip of river-15 cascade — counts overflow cells */
import fs from "node:fs";
import { createWorldField, worldRecipeSchema } from "@hitreg/core";
const recipe = worldRecipeSchema.parse(JSON.parse(fs.readFileSync("projects/voxel-demo/assets/worlds/mmo.json", "utf8")));
const t0 = Date.now();
const field = createWorldField(recipe);
const falls = field.falls.filter((f) => f.river === "river-15").sort((a, b) => b.top - a.top);
console.log("build ms", Date.now() - t0);
for (const f of falls) console.log(JSON.stringify(f));
const top = falls[0]!;
const lake = recipe.features.lakes.map((l) => ({ l, d: Math.hypot(l.center[0] - top.x, l.center[1] - top.z) - l.radius })).sort((a, b) => a.d - b.d)[0]!.l;
console.log("lake", lake.id ?? "", lake.waterY, lake.center, lake.radius, lake.bank);
const dx = top.dirX, dz = top.dirZ;
const ws = { y: 0, flowX: 0, flowZ: 0, kind: "lake" as "lake" | "river", floor: 0 };
// lip line point: find the fall record fields
const lx = top.x - dx * 3, lz = top.z - dz * 3;
let dryDrawn = 0, pastLip = 0, lakeCells = 0, shoreSheet = 0;
const rows: string[] = [];
for (let a = -60; a <= 20; a += 1) {
  let row = "";
  for (let c = -40; c <= 40; c += 1) {
    const x = lx + dx * a - dz * c, z = lz + dz * a + dx * c;
    const h = field.height(x, z);
    if (field.waterSurface(x, z, ws) && ws.kind === "lake") {
      lakeCells++;
      if (h > ws.y + 0.05) { dryDrawn++; row += "#"; }
      else if (a > 0 && Math.abs(c) < 15) { pastLip++; row += "!"; }
      else row += "L";
      if (h > ws.y - 0.3 && h <= ws.y + 0.05) shoreSheet++;
    } else if (field.waterSurface(x, z, ws)) row += ws.y + 0.3 > h ? "r" : ",";
    else row += h < lake.waterY ? "_" : ".";
  }
  rows.push(`${String(a).padStart(4)} ${row}`);
}
console.log(`lake cells ${lakeCells}, drawn over ground above level ${dryDrawn}, past lip line ${pastLip}, shallow(<0.3) ${shoreSheet}`);
if (process.argv.includes("--map")) console.log(rows.join("\n"));

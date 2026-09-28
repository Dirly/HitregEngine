import fs from "node:fs";
import { createWorldField, worldRecipeSchema } from "@hitreg/core";
const recipe = worldRecipeSchema.parse(JSON.parse(fs.readFileSync("projects/voxel-demo/assets/worlds/mmo.json", "utf8")));
const field = createWorldField(recipe);
const f = field.falls.filter((q) => q.river === "river-15").sort((a, b) => b.top - a.top)[1]!;
console.log("fall", f.x.toFixed(1), f.z.toFixed(1), "top", f.top, "bottom", f.bottom, "dir", f.dirX.toFixed(2), f.dirZ.toFixed(2), "width", f.width.toFixed(1));
const ws = { y: 0, flowX: 0, flowZ: 0, kind: "lake" as "lake" | "river", floor: 0 };
// along-flow from 10 m before lip to 8 m past foot, across -10..10
for (let a = -14; a <= 6; a += 2) {
  const row: string[] = [];
  for (let c = -10; c <= 10; c += 2) {
    const x = f.x + f.dirX * a - f.dirZ * c, z = f.z + f.dirZ * a + f.dirX * c;
    const g = field.height(x, z);
    const w = field.waterSurface(x, z, ws) ? ws.y : NaN;
    row.push(Number.isNaN(w) ? `  .${(g - f.bottom).toFixed(0).padStart(3)}` : (w + 0.35 > g ? ` W${(w - f.bottom).toFixed(0).padStart(2)}/${(g - f.bottom).toFixed(0).padStart(3)}` : `  -${(g - f.bottom).toFixed(0).padStart(3)}`));
  }
  console.log(String(a).padStart(4), row.join(""));
}

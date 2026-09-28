/* scratch: water level and ground (rel. to lake level) along the top tier of river-15 */
import fs from "node:fs";
import { createWorldField, worldRecipeSchema } from "@hitreg/core";
const recipe = worldRecipeSchema.parse(JSON.parse(fs.readFileSync("projects/voxel-demo/assets/worlds/mmo.json", "utf8")));
const field = createWorldField(recipe);
const falls = field.falls.filter((f) => f.river === "river-15").sort((a, b) => b.top - a.top);
const top = falls[0]!;
const L = 68.31;
const dx = top.dirX, dz = top.dirZ;
const lx = top.x - dx * 3, lz = top.z - dz * 3;
const ws = { y: 0, flowX: 0, flowZ: 0, kind: "lake" as "lake" | "river", floor: 0 };
const A0 = +(process.argv[2] ?? -50), A1 = +(process.argv[3] ?? 4), C = +(process.argv[4] ?? 14), S = +(process.argv[5] ?? 2);
console.log("lip", lx.toFixed(1), lz.toFixed(1), "rows: along (neg upstream); cells water-L/ground-L (x10 dm) ; L=lake w/ lvl");
for (let a = A0; a <= A1; a += S) {
  const parts: string[] = [];
  for (let c = -C; c <= C; c += S) {
    const x = lx + dx * a - dz * c, z = lz + dz * a + dx * c;
    const h = field.height(x, z);
    const g = Math.round((h - L) * 10);
    if (field.waterSurface(x, z, ws)) parts.push(`${ws.kind === "lake" ? "L" : "r"}${Math.round((ws.y - L) * 10)}/${g}`.padStart(9));
    else parts.push(`./${g}`.padStart(9));
  }
  console.log(String(a).padStart(4), parts.join(""));
}

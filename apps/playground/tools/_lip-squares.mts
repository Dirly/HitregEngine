/* scratch: the water lattice's corner samples around lip 0 (river-15): level, ground, along/across, to see why squares drop out */
import fs from "node:fs";
import { createWorldField, worldRecipeSchema } from "@hitreg/core";
const recipe = worldRecipeSchema.parse(JSON.parse(fs.readFileSync("projects/voxel-demo/assets/worlds/mmo.json", "utf8")));
const field = createWorldField(recipe);
const fi = +(process.argv[2] ?? 0);
const fall = field.falls.filter((f) => f.river === "river-15").sort((a, b) => b.top - a.top)[fi]!;
const lx = fall.x - fall.dirX * 3, lz = fall.z - fall.dirZ * 3;
const s = { y: 0, flowX: 0, flowZ: 0, kind: "lake", floor: 0 } as never as { y: number; kind: string };
const step = field.voxelSize;
const rows: string[] = [];
for (let z = Math.floor((lz - 12) / step) * step; z <= lz + 6; z += step) {
  let line = `z ${z}: `;
  for (let x = Math.floor((lx - 12) / step) * step; x <= lx + 12; x += step) {
    const along = (x - lx) * fall.dirX + (z - lz) * fall.dirZ;
    const g = field.height(x, z);
    const w = field.waterSurface(x, z, s as never) ? s.y : NaN;
    line += `${isNaN(w) ? "  ----" : (w - fall.top).toFixed(1).padStart(6)}${g > w + 0.35 || isNaN(w) ? "#" : along < 0 ? " " : "'"}`;
  }
  rows.push(line);
}
console.log(`lip ${fi}: lip at (${lx.toFixed(1)}, ${lz.toFixed(1)}) dir (${fall.dirX.toFixed(2)}, ${fall.dirZ.toFixed(2)}); water level - top per 2 m sample, # = dry, ' = past the lip line`);
console.log(rows.join("\n"));

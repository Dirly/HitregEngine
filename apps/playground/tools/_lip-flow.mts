/* scratch: the field's current and upper-water width just upstream of each river-15 lip line (for the curtain weld) */
import fs from "node:fs";
import { createWorldField, worldRecipeSchema } from "@hitreg/core";
const recipe = worldRecipeSchema.parse(JSON.parse(fs.readFileSync("projects/voxel-demo/assets/worlds/mmo.json", "utf8")));
const field = createWorldField(recipe);
const falls = field.falls.filter((f) => f.river === "river-15").sort((a, b) => b.top - a.top);
const s = { y: 0, flowX: 0, flowZ: 0, kind: "lake", floor: 0 } as never as { y: number; flowX: number; flowZ: number };
for (const [fi, f] of falls.entries()) {
  const lx = f.x - f.dirX * 3, lz = f.z - f.dirZ * 3;
  console.log(`lip ${fi}: top ${f.top.toFixed(2)} dir (${f.dirX.toFixed(4)}, ${f.dirZ.toFixed(4)}) reach ${f.reach} width ${f.width}`);
  for (const up of [0.25, 1, 2, 3, 4, 6]) {
    let lo = 99, hi = -99; const flows: string[] = [];
    for (let w = -16; w <= 16; w += 0.5) {
      const x = lx - f.dirX * up - f.dirZ * w, z = lz - f.dirZ * up + f.dirX * w;
      if (field.waterSurface(x, z, s as never) && Math.abs(s.y - f.top) < 0.6 && field.height(x, z) < f.top) { lo = Math.min(lo, w); hi = Math.max(hi, w); if (w % 4 === 0) flows.push(`${w}:${Math.hypot(s.flowX, s.flowZ).toFixed(2)}@${(Math.atan2(s.flowZ, s.flowX) - Math.atan2(f.dirZ, f.dirX)).toFixed(2)}`); }
    }
    console.log(`  ${up} m up: water across [${lo}, ${hi}]  flow ${flows.join(" ")}`);
  }
}

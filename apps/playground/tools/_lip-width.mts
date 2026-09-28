/* scratch: how wide the upper water is AT each river-15 lip line vs the curtain's half-width */
import fs from "node:fs";
import { createWorldField, worldRecipeSchema } from "@hitreg/core";
const recipe = worldRecipeSchema.parse(JSON.parse(fs.readFileSync("projects/voxel-demo/assets/worlds/mmo.json", "utf8")));
const field = createWorldField(recipe);
const river = process.argv[2] ?? "river-15";
const falls = field.falls.filter((f) => f.river === river).sort((a, b) => b.top - a.top);
const ws = { y: 0, flowX: 0, flowZ: 0, kind: "lake" as "lake" | "river", floor: 0 };
for (const fall of falls) {
  const lx = fall.x - fall.dirX * 3, lz = fall.z - fall.dirZ * 3;
  for (const along of [-0.3, -1, -2]) {
    let lo = Infinity, hi = -Infinity;
    for (let c = -20; c <= 20; c += 0.25) {
      const x = lx + fall.dirX * along - fall.dirZ * c, z = lz + fall.dirZ * along + fall.dirX * c;
      if (!field.waterSurface(x, z, ws) || Math.abs(ws.y - fall.top) > 0.6) continue;
      if (ws.y + 0.35 <= field.height(x, z)) continue;
      lo = Math.min(lo, c); hi = Math.max(hi, c);
    }
    console.log(`${river} fall top ${fall.top} along ${along}: upper water across [${lo}, ${hi}], curtain ±${(fall.width / 2 + 1.5).toFixed(2)} (width ${fall.width.toFixed(2)})`);
  }
}

/* scratch: waterline width of each plunge pool on a river's fall site vs its channel width.
 *   npx tsx tools/_pool-width.mts <river>
 * For every pool (below each fall, to the next lip or 40 m), scans lines across the flow every metre and takes the
 * widest contiguous run where field.waterSurface stands above field.height (2 m lattice is ignored: field truth). */
import fs from "node:fs";
import { createWorldField, worldRecipeSchema } from "@hitreg/core";
const river = process.argv[2] ?? "river-15";
const recipe = worldRecipeSchema.parse(JSON.parse(fs.readFileSync("projects/voxel-demo/assets/worlds/mmo.json", "utf8")));
const field = createWorldField(recipe);
const falls = field.falls.filter((f) => f.river === river).sort((a, b) => b.top - a.top);
const s = { y: 0, flowX: 0, flowZ: 0, kind: "river", floor: 0 } as never as { y: number };
for (const [i, f] of falls.entries()) {
  const next = falls[i + 1];
  const lx = f.x - f.dirX * 3, lz = f.z - f.dirZ * 3;
  const len = next ? Math.hypot(next.x - f.dirX * 0 - lx, next.z - lz) - 3 : 40;
  let widest = 0, at = 0, area = 0;
  for (let r = 1; r < len; r += 1) {
    const cx = lx + f.dirX * r, cz = lz + f.dirZ * r;
    let run = 0, best = 0;
    for (let a = -40; a <= 40; a += 0.25) {
      const x = cx - f.dirZ * a, z = cz + f.dirX * a;
      const wet = field.waterSurface(x, z, s as never) && Math.abs(s.y - f.bottom) < 1 && s.y > field.height(x, z);
      if (wet) { run += 0.25; best = Math.max(best, run); area += 0.25; } else run = 0;
    }
    if (best > widest) { widest = best; at = r; }
  }
  console.log(`tier ${i}: drop ${(f.top - f.bottom).toFixed(1)} m, channel ${f.width.toFixed(1)} m, pool widest ${widest.toFixed(1)} m at ${at} m past the lip (x${(widest / f.width).toFixed(2)}), pool water area ~${area.toFixed(0)} m2 over ${len.toFixed(0)} m`);
}

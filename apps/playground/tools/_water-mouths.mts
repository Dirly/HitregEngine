/* scratch: every chain end — where it stops and what water is there */
import fs from "node:fs";
import { createWorldField, worldRecipeSchema } from "@hitreg/core";
const recipe = worldRecipeSchema.parse(JSON.parse(fs.readFileSync("projects/voxel-demo/assets/worlds/mmo.json", "utf8")));
const field = createWorldField(recipe);
const ids = process.argv.slice(2);
for (const r of field.rivers) {
  if (ids.length && !ids.some((id) => r.id === id || r.id.startsWith(id + "."))) continue;
  const [hx, hz] = r.points[0]!;
  const [mx, mz] = r.points[r.points.length - 1]!;
  // nearest OTHER river point to the mouth
  let best = { d: Infinity, id: "", y: NaN };
  for (const o of field.rivers) {
    if (o === r) continue;
    o.points.forEach((p, k) => {
      const d = Math.hypot(p[0] - mx, p[1] - mz);
      if (d < best.d) best = { d, id: o.id, y: o.surfaceY![k]! };
    });
  }
  console.log(`${r.id}: head [${hx.toFixed(0)},${hz.toFixed(0)}] ${r.surfaceY![0]}  mouth [${mx.toFixed(0)},${mz.toFixed(0)}] ${r.surfaceY![r.surfaceY!.length - 1]}  nearest other: ${best.id} ${best.d.toFixed(1)} m at ${best.y}`);
}

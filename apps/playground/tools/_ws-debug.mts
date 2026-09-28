import fs from "node:fs";
import { createWorldField, worldRecipeSchema } from "@hitreg/core";
const recipe = worldRecipeSchema.parse(JSON.parse(fs.readFileSync("projects/voxel-demo/assets/worlds/mmo.json", "utf8")));
const field = createWorldField(recipe);
const [x, z] = process.argv[2]!.split(",").map(Number) as [number, number];
for (const r of field.rivers) {
  let best = { d: Infinity, k: 0 };
  r.points.forEach((p, k) => { const d = Math.hypot(p[0] - x, p[1] - z); if (d < best.d) best = { d, k }; });
  if (best.d > 40) continue;
  const k = best.k;
  console.log(r.id, "pts", r.points.length, "nearest k", k, "d", best.d.toFixed(1), "surf", r.surfaceY!.slice(Math.max(0, k - 3), k + 4).join(","), "bed", r.bedY!.slice(Math.max(0, k - 3), k + 4).join(","), "width", r.widths?.[k] ?? r.width);
  console.log("  seg lens", r.points.slice(Math.max(0, k - 3), k + 4).map((p, i, a) => (i ? Math.hypot(p[0] - a[i - 1]![0], p[1] - a[i - 1]![1]).toFixed(1) : "-")).join(","));
}
console.log("falls near", field.falls.filter((f) => Math.hypot(f.x - x, f.z - z) < 60).map((f) => `${f.river} ${f.top}->${f.bottom}`));

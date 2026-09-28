/* scratch: how high the land beside each river stands over its water */
import fs from "node:fs";
import { createWorldField, worldRecipeSchema } from "@hitreg/core";
const riverBank = (r: { bank: number }, w: number): number => (Number.isNaN(w) ? r.bank : Math.min(r.bank, 0.7 * w + 3));
const recipe = worldRecipeSchema.parse(JSON.parse(fs.readFileSync("projects/voxel-demo/assets/worlds/mmo.json", "utf8")));
const field = createWorldField(recipe);
const out: number[] = [];
const ws = { y: 0, flowX: 0, flowZ: 0, kind: "lake" as "lake" | "river", floor: 0 };
for (const r of field.rivers) {
  const m = r.points.length;
  for (let k = 1; k + 1 < m; k += 2) {
    const [x, z] = r.points[k]!;
    if (field.waterSurface(x, z, ws) && ws.kind === "lake") continue;
    if (r.surfaceY![k]! <= recipe.seaLevel + 0.1) continue;
    const a = r.points[k - 1]!, b = r.points[k + 1]!;
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
    const nx = -(b[1] - a[1]) / len, nz = (b[0] - a[0]) / len;
    const w = r.widths ? r.widths[k]! : r.width;
    const reach = w / 2 + riverBank(r, r.widths ? w : NaN) * 0.75;
    for (const s of [1, -1]) out.push(field.height(x + nx * reach * s, z + nz * reach * s) - r.surfaceY![k]!);
  }
}
out.sort((p, q) => p - q);
const q = (f: number) => out[Math.floor(f * (out.length - 1))]!.toFixed(2);
console.log(`bank over water at 0.75 bank: p5 ${q(0.05)} p10 ${q(0.1)} p50 ${q(0.5)} p90 ${q(0.9)} (n ${out.length}); under 0.3 m: ${((100 * out.filter((v) => v < 0.3).length) / out.length).toFixed(1)} %`);

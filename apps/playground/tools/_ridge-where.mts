import fs from "node:fs";
import { createWorldField, worldRecipeSchema } from "@hitreg/core";
const recipe = worldRecipeSchema.parse(JSON.parse(fs.readFileSync("projects/voxel-demo/assets/worlds/mmo.json", "utf8")));
const field = createWorldField(recipe);
const dry = createWorldField({ ...recipe, features: { ...recipe.features, rivers: [], lakes: [], fills: [] } });
const S = field.voxelSize;
const bins = new Map<string, number>();
const ex: string[] = [];
const seen = new Set<string>();
for (const r of field.rivers) for (let k = 0; k < r.points.length; k += 12) {
  const [cx, cz] = r.points[k]!;
  for (let z = cz - 40; z <= cz + 40; z += S) for (let x = cx - 40; x <= cx + 40; x += S) {
    const gx = Math.round(x / S) * S, gz = Math.round(z / S) * S;
    if (seen.has(gx + "," + gz)) continue; seen.add(gx + "," + gz);
    const h = field.height(gx, gz);
    let ridge = false;
    for (const [dx, dz] of [[1, 0], [0, 1], [1, 1], [1, -1]] as const) {
      if (h - field.height(gx + dx * S * 2, gz + dz * S * 2) > 4 && h - field.height(gx - dx * S * 2, gz - dz * S * 2) > 4) ridge = true;
    }
    if (!ridge) continue;
    // nearest river and distance past its bed edge, in banks; and did the carve RAISE this point?
    let best = { d: Infinity, rel: 0, id: "", sea: false };
    for (const o of field.rivers) o.points.forEach((p, j) => {
      const d = Math.hypot(p[0] - gx, p[1] - gz);
      if (d < best.d) { const w = (o.widths?.[j] ?? o.width) / 2; const bank = Math.min(o.bank, 0.7 * w * 2 + 3); best = { d, rel: (d - w) / bank, id: o.id, sea: o.surfaceY![j]! < 1 }; }
    });
    const raised = h - dry.height(gx, gz);
    const bin = `${best.rel < 1 ? "<1bank" : best.rel < 2 ? "1-2bank" : ">2bank"} ${raised > 0.5 ? "raised" : raised < -0.5 ? "cut" : "natural"}${best.sea ? " sea" : ""}`;
    bins.set(bin, (bins.get(bin) ?? 0) + 1);
    if (ex.length < 6) ex.push(`${bin} [${gx},${gz}] ${best.id} raised ${raised.toFixed(1)}`);
  }
}
console.log(Object.fromEntries([...bins].sort((a, b) => b[1] - a[1])));
for (const e of ex) console.log("  " + e);

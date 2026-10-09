/* scratch: where a river has no drawn water on its own centreline, and whether tributaries' water reaches their trunk */
import fs from "node:fs";
import { createWorldField, worldRecipeSchema } from "@hitreg/core";
const recipe = worldRecipeSchema.parse(JSON.parse(fs.readFileSync("projects/proving/assets/worlds/mmo.json", "utf8")));
const field = createWorldField(recipe);
const ws = { y: 0, flowX: 0, flowZ: 0, kind: "lake" as "lake" | "river", floor: 0 };
const drawnAt = (x: number, z: number): string => {
  if (!field.waterSurface(x, z, ws)) return "no-surface";
  if (ws.y <= recipe.seaLevel + 0.05) return "ok"; // ocean covers it
  const g = field.height(x, z);
  if (ws.kind === "river" && g < ws.floor - 3) return "refused-deep";
  if (ws.y + 0.35 - g <= 0) return `ground-above(${(g - ws.y).toFixed(1)})`;
  return "ok";
};
const reasons = new Map<string, number>();
const where = new Map<string, string[]>();
let total = 0;
for (const r of field.rivers) {
  if (!r.water) continue;
  for (let k = 0; k + 1 < r.points.length; k++) {
    const a = r.points[k]!, b = r.points[k + 1]!;
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (len < 4) continue; // a fall lip
    for (const t of [0.25, 0.75]) {
      const x = a[0] + (b[0] - a[0]) * t, z = a[1] + (b[1] - a[1]) * t;
      total++;
      const why = drawnAt(x, z);
      if (why === "ok") continue;
      const key = why.replace(/\(.*\)/, "") + (k * 8 < 40 ? "@head" : k >= r.points.length - 6 ? "@mouth" : "@body");
      reasons.set(key, (reasons.get(key) ?? 0) + 1);
      const list = where.get(r.id) ?? [];
      if (list.length < 3 && key === "no-surface@body") list.push(`[${x.toFixed(0)},${z.toFixed(0)}] ${why} ${key}`);
      where.set(r.id, list);
    }
  }
}
console.log(`centreline samples ${total}; missing:`, Object.fromEntries(reasons));
for (const [id, l] of where) console.log(`  ${id}: ${l.join("  ")}`);
// confluences: from each chain end that is not at the sea or a lake, walk to the nearest other river's centreline
console.log("confluences:");
for (const r of field.rivers) {
  if (!r.water) continue;
  const [mx, mz] = r.points[r.points.length - 1]!;
  if (r.surfaceY![r.surfaceY!.length - 1]! <= recipe.seaLevel + 0.5) continue;
  if (field.waterSurface(mx, mz, ws) && ws.kind === "lake") continue;
  let best = { d: Infinity, x: 0, z: 0, id: "" };
  for (const o of field.rivers) {
    if (o === r || o.id.split(".")[0] === r.id.split(".")[0] && o.points[0]![0] === mx && o.points[0]![1] === mz) continue;
    for (const p of o.points) {
      const d = Math.hypot(p[0] - mx, p[1] - mz);
      if (d < best.d) best = { d, x: p[0], z: p[1], id: o.id };
    }
  }
  if (best.d > 80) { console.log(`  ${r.id} ends at [${mx.toFixed(0)},${mz.toFixed(0)}] with no river within 80 m (${best.d.toFixed(0)} m to ${best.id})`); continue; }
  let gaps = 0;
  const n = Math.max(2, Math.ceil(best.d / 1.5));
  for (let i = 0; i <= n; i++) {
    const x = mx + (best.x - mx) * (i / n), z = mz + (best.z - mz) * (i / n);
    if (drawnAt(x, z) !== "ok") gaps++;
  }
  console.log(`  ${r.id} -> ${best.id} ${best.d.toFixed(1)} m: ${gaps} dry samples of ${n + 1}`);
}

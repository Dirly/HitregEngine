import fs from "node:fs";
import { createWorldField, worldRecipeSchema } from "@hitreg/core";
const recipe = worldRecipeSchema.parse(JSON.parse(fs.readFileSync("projects/firstshore/assets/worlds/firstshore.json", "utf8")));
const f = createWorldField(recipe);
const t = recipe.features.towns.find((x) => x.id === "town-1")!;
const g = t.gates.find((x) => x.id === "land-gate")!;
console.log("gate", g.at, g.facing, "ground", f.height(g.at[0], g.at[1]).toFixed(2), "top shelf", Math.max(...t.terraces.map((x) => x.groundY)));
for (const r of recipe.features.roads) {
  const pts = r.points;
  const d0 = Math.hypot(pts[0]![0] - g.at[0], pts[0]![1] - g.at[1]);
  const d1 = Math.hypot(pts.at(-1)![0] - g.at[0], pts.at(-1)![1] - g.at[1]);
  if (Math.min(d0, d1) > 20) continue;
  const line = d0 <= d1 ? pts : [...pts].reverse();
  // resample every 1 m along the polyline, first 60 m
  const s: [number, number][] = [];
  let acc = 0;
  for (let i = 1; i < line.length && acc < 60; i++) {
    const a = line[i - 1]!, b = line[i]!;
    const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
    for (let u = 0; u < L && acc < 60; u += 1, acc += 1) s.push([a[0] + ((b[0] - a[0]) * u) / L, a[1] + ((b[1] - a[1]) * u) / L]);
  }
  const h = s.map((p) => f.height(p[0], p[1]));
  let m4 = 0, at4 = 0, m2 = 0;
  for (let i = 0; i + 4 < h.length; i++) { const gr = Math.abs(h[i + 4]! - h[i]!) / 4; if (gr > m4) { m4 = gr; at4 = i; } }
  for (let i = 0; i + 2 < h.length; i++) m2 = Math.max(m2, Math.abs(h[i + 2]! - h[i]!) / 2);
  const first4 = Math.abs(h[4]! - h[0]!) / 4;
  console.log(r.id, `start ${d0 <= d1 ? "head" : "tail"} ${Math.min(d0, d1).toFixed(1)} m from gate; first 4 m ${(first4 * 100).toFixed(0)} %; max 4 m window ${(m4 * 100).toFixed(0)} % at ${at4} m; max 2 m ${(m2 * 100).toFixed(0)} %`);
  console.log("   h:", h.filter((_, i) => i % 4 === 0).map((v) => v.toFixed(1)).join(" "));
}

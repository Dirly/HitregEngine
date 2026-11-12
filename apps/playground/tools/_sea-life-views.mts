/* scratch: where the sea-bed scatter rules actually landed, and a review camera on the biggest instance in the fullest cell of each.
 *   npx tsx tools/_sea-life-views.mts <recipe.json> [rule,rule,...] > views.json   (counts on stderr)
 * Samples every 3rd cell whose centre is 4-34 m under the sea. */
import fs from "node:fs";
import { createWorldField, scatterCell, worldRecipeSchema } from "@hitreg/core";
const recipe = worldRecipeSchema.parse(JSON.parse(fs.readFileSync(process.argv[2]!, "utf8")));
const want = (process.argv[3] ?? "coral-heads-rose,coral-heads-violet,reef-pinnacles,reef-spires,reef-ledges,sea-anemone").split(",");
const field = createWorldField(recipe), sea = recipe.seaLevel, cs = recipe.cellSize;
const limit = (recipe.bounds as any)?.limit ?? 4000, n = Math.ceil(limit / cs);
const count: Record<string, number> = {}, best: Record<string, { n: number; x: number; y: number; z: number }[]> = {};
let cells = 0;
for (let cx = -n; cx < n; cx += 3)
  for (let cz = -n; cz < n; cz += 3) {
    const mx = (cx + 0.5) * cs, mz = (cz + 0.5) * cs, d = sea - field.height(mx, mz);
    if (d < 4 || d > 34) continue;
    cells++;
    const per: Record<string, { n: number; x: number; y: number; z: number }> = {};
    for (const i of scatterCell(field, cx, cz, { fastGround: true })) {
      if (!want.includes(i.rule)) continue;
      count[i.rule] = (count[i.rule] ?? 0) + 1;
      const p = (per[i.rule] ??= { n: 0, x: 0, y: 0, z: 0 });
      p.n++; if (i.scale > (p as any).s || p.n === 1) { (p as any).s = i.scale; p.x = i.position[0] + cx * cs; p.y = i.position[1]; p.z = i.position[2] + cz * cs; }
    }
    for (const [r, p] of Object.entries(per)) (best[r] ??= []).push({ n: p.n, x: p.x, y: p.y, z: p.z });
  }
console.error(`${cells} sea cells sampled (cell ${cs} m):`, JSON.stringify(count));
const out: (string | number)[][] = [];
for (const r of want) {
  const top = (best[r] ?? []).sort((a, b) => b.n - a.n).slice(0, 2);
  top.forEach((p, k) => { const a = k * 2 + 0.7; out.push([`${r}-${k + 1}`, p.x + Math.cos(a) * 9, Math.min(p.y + 4, sea - 1), p.z + Math.sin(a) * 9, p.x, p.y + 1.5, p.z]); });
}
console.log(JSON.stringify(out));

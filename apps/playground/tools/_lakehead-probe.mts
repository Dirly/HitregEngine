/* scratch: the lake at the head of the river-15 cascade on a 1 m grid.
   Prints river-15's samples near the lake (level vs lake level, inside the outline?), and counts:
   - water points with the ground ABOVE the surface (> 0.05 m) that the field still calls water
   - water edges (1 m) whose dry neighbour's ground is > 0.3 m under the water (hanging)
   - lake-vs-river neighbours at different levels (> 0.05 m) — two sheets meeting at a step
   Map with -m (L lake, r river, . dry; uppercase = hanging edge). */
import fs from "node:fs";
import { createWorldField, worldRecipeSchema } from "@hitreg/core";
const recipe = worldRecipeSchema.parse(JSON.parse(fs.readFileSync(process.argv.find((a) => a.endsWith(".json")) ?? "projects/voxel-demo/assets/worlds/mmo.json", "utf8")));
const field = createWorldField(recipe);
const falls = field.falls.filter((f) => f.river === "river-15").sort((a, b) => b.top - a.top);
const top = falls[0]!;
const lake = recipe.features.lakes.map((l) => ({ l, d: Math.hypot(l.center[0] - top.x, l.center[1] - top.z) - l.radius })).sort((a, b) => a.d - b.d)[0]!.l;
const poly = lake.polygon ?? [];
const inside = (x: number, z: number): boolean => {
  let c = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i]!, b = poly[j]!;
    if ((a[1] > z) !== (b[1] > z) && x < ((b[0] - a[0]) * (z - a[1])) / (b[1] - a[1]) + a[0]) c = !c;
  }
  return c;
};
console.log(`lake ${lake.id} level ${lake.waterY} bank ${lake.bank} pts ${poly.length}; top lip ${top.top} at ${top.x.toFixed(1)},${top.z.toFixed(1)} dir ${top.dirX.toFixed(2)},${top.dirZ.toFixed(2)}`);
const lx = top.x - top.dirX * 3, lz = top.z - top.dirZ * 3;
const A = (x: number, z: number) => (x - lx) * top.dirX + (z - lz) * top.dirZ;
const C = (x: number, z: number) => -(x - lx) * top.dirZ + (z - lz) * top.dirX;
const r = (field.rivers as { id?: string; points: [number, number][]; surfaceY?: number[]; bedY?: number[] }[]).find((q) => q.id === "river-15")!;
if (process.argv.includes("-r")) r.points.forEach((p, k) => {
  const a = A(p[0], p[1]);
  if (a < -80 || a > 3) return;
  console.log(`  k${k} along ${a.toFixed(1)} across ${C(p[0], p[1]).toFixed(1)} surf ${r.surfaceY?.[k]?.toFixed(2)} bed ${r.bedY?.[k]?.toFixed(2)} ground ${field.height(p[0], p[1]).toFixed(2)} inOutline ${inside(p[0], p[1])}`);
});
const ws = { y: 0, flowX: 0, flowZ: 0, kind: "lake" as "lake" | "river", floor: 0 };
// grid in lip frame: along -90..2, across -45..45
const AL0 = -90, AL1 = 1, CR0 = -45, CR1 = 45;
const NA = AL1 - AL0 + 1, NC = CR1 - CR0 + 1;
const lvl = new Float64Array(NA * NC).fill(NaN), gr = new Float64Array(NA * NC), kd: string[] = [];
const xy = (ia: number, ic: number) => { const a = AL0 + ia, c = CR0 + ic; return [lx + a * top.dirX - c * top.dirZ, lz + a * top.dirZ + c * top.dirX] as const; };
for (let ia = 0; ia < NA; ia++) for (let ic = 0; ic < NC; ic++) {
  const [x, z] = xy(ia, ic);
  const i = ia * NC + ic;
  gr[i] = field.height(x, z);
  if (field.waterSurface(x, z, ws) && ws.y + 0.35 > gr[i]!) { lvl[i] = ws.y; kd[i] = ws.kind; }
}
let buried = 0, hang = 0, hangBig = 0, step = 0, stepBig = 0;
const hangAt = new Set<number>(), notes: string[] = [];
for (let ia = 0; ia < NA; ia++) for (let ic = 0; ic < NC; ic++) {
  const i = ia * NC + ic;
  if (!Number.isNaN(lvl[i]!) && gr[i]! > lvl[i]! + 0.05) buried++;
  for (const [da, dc] of [[1, 0], [0, 1]] as const) {
    if (ia + da >= NA || ic + dc >= NC) continue;
    const j = (ia + da) * NC + ic + dc;
    const a = lvl[i]!, b = lvl[j]!;
    if (Number.isNaN(a) !== Number.isNaN(b)) {
      const w = Number.isNaN(a) ? b : a, g = Number.isNaN(a) ? gr[i]! : gr[j]!;
      const wi = Number.isNaN(a) ? j : i;
      // curtain: the lip line itself
      if (AL0 + ia >= -1 && kd[wi] === "river") continue;
      if (w - g > 0.3) { hang++; hangAt.add(wi); if (w - g > 1) hangBig++; notes.push(`hang ${kd[wi]} along ${AL0 + ia} across ${CR0 + ic} level ${w.toFixed(2)} ground ${g.toFixed(2)}`); }
    } else if (!Number.isNaN(a) && kd[i] !== kd[j] && Math.abs(a - b) > 0.05 && Math.abs(a - b) < 1.5) {
      step++; if (Math.abs(a - b) > 0.3) stepBig++;
      notes.push(`step along ${AL0 + ia} across ${CR0 + ic} ${kd[i]} ${a.toFixed(2)} vs ${kd[j]} ${b.toFixed(2)}`);
    }
  }
}
console.log(`1 m grid: buried water ${buried}, hanging edges >0.3 ${hang} (>1 m ${hangBig}), lake-vs-river steps ${step} (>0.3 ${stepBig})`);
if (process.argv.includes("-v")) console.log(notes.join("\n"));
if (process.argv.includes("-m")) {
  for (let ia = NA - 1; ia >= 0; ia -= 1) {
    let row = `${String(AL0 + ia).padStart(4)} `;
    for (let ic = 0; ic < NC; ic++) {
      const i = ia * NC + ic;
      const [x, z] = xy(ia, ic);
      let ch = Number.isNaN(lvl[i]!) ? (inside(x, z) ? "o" : ".") : kd[i] === "lake" ? "L" : "r";
      if (hangAt.has(i)) ch = ch === "L" ? "H" : "R";
      row += ch;
    }
    console.log(row);
  }
}

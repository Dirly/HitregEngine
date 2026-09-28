/* scratch: on the 2 m water lattice around the top of the river-15 cascade, count lattice edges where both ends
   are drawn water (level + 0.35 over ground) and the levels differ (> 0.3 m): sloped step faces, lake vs river */
import fs from "node:fs";
import { createWorldField, worldRecipeSchema } from "@hitreg/core";
const recipe = worldRecipeSchema.parse(JSON.parse(fs.readFileSync("projects/voxel-demo/assets/worlds/mmo.json", "utf8")));
const field = createWorldField(recipe);
const falls = field.falls.filter((f) => f.river === "river-15").sort((a, b) => b.top - a.top);
const top = falls[0]!;
const lx = top.x - top.dirX * 3, lz = top.z - top.dirZ * 3;
const ws = { y: 0, flowX: 0, flowZ: 0, kind: "lake" as "lake" | "river", floor: 0 };
const X0 = Math.floor((lx - 90) / 2) * 2, Z0 = Math.floor((lz - 20) / 2) * 2, N = 90, M = 70; // 180 m x 140 m, upstream (+z)
const lvl = new Float64Array(N * M).fill(NaN), kind: string[] = [];
for (let j = 0; j < M; j++) for (let i = 0; i < N; i++) {
  const x = X0 + i * 2, z = Z0 + j * 2;
  if (field.waterSurface(x, z, ws) && ws.y + 0.35 > field.height(x, z)) { lvl[j * N + i] = ws.y; kind[j * N + i] = ws.kind; }
}
const gr = new Float64Array(N * M);
for (let j = 0; j < M; j++) for (let i = 0; i < N; i++) gr[j * N + i] = field.height(X0 + i * 2, Z0 + j * 2);
let hang = 0, hangBig = 0;
let steps = 0, lakeRiver = 0, big = 0; const where: string[] = [];
for (let j = 0; j < M; j++) for (let i = 0; i < N; i++) for (const [di, dj] of [[1, 0], [0, 1]]) {
  if (i + di >= N || j + dj >= M) continue;
  const a = lvl[j * N + i]!, b = lvl[(j + dj) * N + i + di]!;
  if (Number.isNaN(a) !== Number.isNaN(b)) {
    const w = Number.isNaN(a) ? b : a, g = Number.isNaN(a) ? gr[j * N + i]! : gr[(j + dj) * N + i + di]!;
    if (w - g > 0.5) { const x = X0 + i * 2, z = Z0 + j * 2; if (process.argv.includes("-h")) console.log(`hang along ${((x - lx) * top.dirX + (z - lz) * top.dirZ).toFixed(0)} across ${(-(x - lx) * top.dirZ + (z - lz) * top.dirX).toFixed(0)} level ${w.toFixed(2)} ground ${g.toFixed(2)} ${kind[Number.isNaN(a) ? (j + dj) * N + i + di : j * N + i]}`); hang++; if (w - g > 1) hangBig++; }
  }
  if (Number.isNaN(a) || Number.isNaN(b)) continue;
  const d = Math.abs(a - b);
  if (d <= 0.3 || d > 1.5) continue; // > 1.5 is cut by the mesh (not drawn as a slope)
  steps++;
  if (kind[j * N + i] !== kind[(j + dj) * N + i + di]) lakeRiver++;
  if (d > 0.6) big++;
  const x = X0 + i * 2, z = Z0 + j * 2;
  const along = (x - lx) * top.dirX + (z - lz) * top.dirZ, across = -(x - lx) * top.dirZ + (z - lz) * top.dirX;
  where.push(`along ${along.toFixed(0)} across ${across.toFixed(0)}: ${kind[j * N + i]} ${a.toFixed(2)} vs ${kind[(j + dj) * N + i + di]} ${b.toFixed(2)}`);
}
console.log(`water edges hanging over dry ground below the level (>0.5 m) ${hang} (>1 m ${hangBig})`);
console.log(`sloped step edges ${steps} (lake-vs-river ${lakeRiver}, > 0.6 m ${big})`);
if (process.argv.includes("-v")) console.log(where.join("\n"));

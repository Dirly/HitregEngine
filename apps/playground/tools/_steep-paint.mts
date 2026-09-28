/* scratch: on steep ground near water (fall walls, gorge sides, river banks, lake shores), which surface wins the splat? */
import fs from "node:fs";
import { createWorldField, worldRecipeSchema } from "@hitreg/core";

const recipe = worldRecipeSchema.parse(JSON.parse(fs.readFileSync("projects/voxel-demo/assets/worlds/mmo.json", "utf8")));
const field = createWorldField(recipe);
const names = recipe.surfaces.map((s) => (s as { name?: string }).name ?? "?");
const cliffIdx = names.indexOf("cliff");
const rockIdx = names.indexOf("rock");
const out = new Float32Array(field.surfaceCount);
const ws = { y: 0, flowX: 0, flowZ: 0, kind: "lake" as "lake" | "river", floor: 0 };

type Row = { steep: number; win: string; rockShare: number };
const rows: Row[] = [];
const sample = (x: number, z: number): void => {
  const y = field.height(x, z);
  const s = field.slope(x, z);
  if (s < 0.82) return; // steeper than ~55 degrees: the cliff rule should own it
  // near water only: within the reach of a river or lake
  if (!field.waterSurface(x, z, ws)) {
    let near = false;
    for (const [ox, oz] of [[6, 0], [-6, 0], [0, 6], [0, -6], [12, 0], [-12, 0], [0, 12], [0, -12]] as const) {
      if (field.waterSurface(x + ox, z + oz, ws)) near = true;
    }
    if (!near) return;
  }
  const ny = Math.sqrt(Math.max(0, 1 - s * s));
  field.splatAt(x, y, z, ny, out, 0);
  let best = 0;
  for (let i = 1; i < out.length; i++) if (out[i]! > out[best]!) best = i;
  rows.push({ steep: s, win: names[best]!, rockShare: (out[cliffIdx] ?? 0) + (out[rockIdx] ?? 0) });
};

// around every fall, and along every river bank
for (const f of field.falls) {
  for (let dx = -30; dx <= 30; dx += 2) for (let dz = -30; dz <= 30; dz += 2) sample(f.x + dx, f.z + dz);
}
for (const r of field.rivers) {
  for (let k = 0; k < r.points.length; k += 3) {
    const [x, z] = r.points[k]!;
    const b = r.points[Math.min(r.points.length - 1, k + 1)]!;
    const len = Math.hypot(b[0] - x, b[1] - z) || 1;
    const px = -(b[1] - z) / len, pz = (b[0] - x) / len;
    for (let o = 4; o <= 24; o += 2) for (const sgn of [1, -1]) sample(x + px * o * sgn, z + pz * o * sgn);
  }
}
const counts = new Map<string, number>();
for (const r of rows) counts.set(r.win, (counts.get(r.win) ?? 0) + 1);
const notRock = rows.filter((r) => r.rockShare < 0.5).length;
console.log(`steep (>55 deg) samples near water: ${rows.length}`);
console.log("winning surface:", Object.fromEntries([...counts].sort((a, b) => b[1] - a[1])));
console.log(`cliff+rock share under 50 %: ${notRock} (${((100 * notRock) / Math.max(1, rows.length)).toFixed(1)} %)`);

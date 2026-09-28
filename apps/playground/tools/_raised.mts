/* scratch: ground RAISED above natural near water, and knife ridges near falls/coast */
import fs from "node:fs";
import { createWorldField, worldRecipeSchema } from "@hitreg/core";
const file = process.argv[2] ?? "projects/voxel-demo/assets/worlds/mmo.json";
const recipe = worldRecipeSchema.parse(JSON.parse(fs.readFileSync(file, "utf8")));
const field = createWorldField(recipe);
// the world with rivers+lakes removed but everything else (fills, canyons, towns, roads) kept:
// raise = ground the WATER features built
const dry = createWorldField({ ...recipe, features: { ...recipe.features, rivers: [], lakes: [] } });
const q = (a: number[], f: number) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.min(s.length - 1, Math.floor(f * s.length))]! : NaN; };
const raises: number[] = [];
let samples = 0;
const worst: { r: number; x: number; z: number; what: string }[] = [];
const probe = (x: number, z: number, what: string) => {
  samples++;
  const r = field.height(x, z) - dry.height(x, z);
  if (r > 0.05) {
    raises.push(r);
    worst.push({ r, x, z, what });
  }
};
// river banks: both sides, 0..1.2 bank out, every 8 m
for (const r of field.rivers) {
  for (let k = 1; k < r.points.length; k += 1) {
    const a = r.points[k - 1]!, b = r.points[k]!;
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
    const nx = -(b[1] - a[1]) / len, nz = (b[0] - a[0]) / len;
    const half = (r.widths ? r.widths[k]! : r.width) / 2;
    const bank = Math.min(r.bank, 0.7 * half * 2 + 3);
    for (const s of [1, -1]) for (const f of [0.2, 0.5, 0.8, 1.1]) {
      const o = half + bank * f;
      probe(b[0] + nx * o * s, b[1] + nz * o * s, r.id);
    }
  }
}
// lake shores: walk polygon, sample outward
for (const lake of recipe.features.lakes) {
  const poly = lake.polygon ?? [];
  let area = 0;
  for (let i = 0; i < poly.length; i++) { const a = poly[i]!, b = poly[(i + 1) % poly.length]!; area += a[0] * b[1] - b[0] * a[1]; }
  const sign = area > 0 ? 1 : -1;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i]!, b = poly[(i + 1) % poly.length]!;
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
    const nx = (sign * (b[1] - a[1])) / len, nz = (-sign * (b[0] - a[0])) / len;
    const steps = Math.max(1, Math.round(len / 8));
    for (let s = 0; s < steps; s++) {
      const t = (s + 0.5) / steps;
      const x = a[0] + (b[0] - a[0]) * t, z = a[1] + (b[1] - a[1]) * t;
      for (const o of [0, lake.bank * 0.3, lake.bank * 0.6, lake.bank * 0.9]) probe(x + nx * o, z + nz * o, lake.id);
    }
  }
}
console.log(`shore samples ${samples}; raised ${raises.length} (${((100 * raises.length) / samples).toFixed(1)} %); raise p50/p90/max ${q(raises, 0.5).toFixed(2)} / ${q(raises, 0.9).toFixed(2)} / ${Math.max(0, ...raises).toFixed(2)} m; over 1 m: ${raises.filter((r) => r > 1).length}, over 3 m: ${raises.filter((r) => r > 3).length}`);
worst.sort((a, b) => b.r - a.r);
for (const w of worst.slice(0, 6)) console.log(`  +${w.r.toFixed(1)} at [${w.x.toFixed(0)},${w.z.toFixed(0)}] ${w.what}`);

// knife ridges: within 90 m of every fall foot, a column higher by > 4 m than BOTH neighbours 5 m away along some axis
let ridges = 0;
const ridgeAt: string[] = [];
const dirs = [[1, 0], [0, 1], [0.7071, 0.7071], [0.7071, -0.7071]];
for (const f of field.falls) {
  for (let dz = -90; dz <= 90; dz += 3) for (let dx = -90; dx <= 90; dx += 3) {
    const x = f.x + dx, z = f.z + dz;
    const h = field.height(x, z);
    for (const [ax, az] of dirs) {
      const l = field.height(x + ax! * 5, z + az! * 5), r2 = field.height(x - ax! * 5, z - az! * 5);
      const dh = dry.height(x, z), dl = dry.height(x + ax! * 5, z + az! * 5), dr = dry.height(x - ax! * 5, z - az! * 5);
      if (h - l > 4 && h - r2 > 4 && !(dh - dl > 4 && dh - dr > 4)) {
        ridges++;
        if (ridgeAt.length < 8 && !ridgeAt.some((s) => s.startsWith(f.river + " "))) ridgeAt.push(`${f.river} [${x},${z}] +${Math.min(h - l, h - r2).toFixed(1)} natural ${(h - dry.height(x, z)).toFixed(1)}`);
        break;
      }
    }
  }
}
console.log(`knife-ridge columns near falls: ${ridges}`);
for (const s of ridgeAt) console.log("  " + s);

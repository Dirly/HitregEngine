import fs from "node:fs";
import { createWorldField, worldRecipeSchema } from "@hitreg/core";
const recipe = worldRecipeSchema.parse(JSON.parse(fs.readFileSync("projects/voxel-demo/assets/worlds/mmo.json", "utf8")));
const field = createWorldField(recipe);
const spots: unknown[] = [];
const splits = field.falls.filter((f) => f.river.endsWith("-split"));
for (const s of splits) {
  const main = field.falls.find((f) => f.river === s.river.replace(/-split$/, "") && Math.hypot(f.x - s.x, f.z - s.z) < 90);
  const cx = main ? (main.x + s.x) / 2 : s.x, cz = main ? (main.z + s.z) / 2 : s.z;
  const h = (main ?? s).top - (main ?? s).bottom;
  spots.push([`split-${s.river}`, cx, (main ?? s).bottom + h * 0.4, cz, s.dirX, s.dirZ, 4 + h * 0.2, 45 + h]);
}
const big = [...field.falls].filter((f) => !f.river.endsWith("-split")).sort((a, b) => (b.top - b.bottom) - (a.top - a.bottom))[1]!;
const h = big.top - big.bottom;
// low and from the side, the angles the bottom glitched from
spots.push([`side-${big.river}`, big.x, big.bottom + 3, big.z, big.dirX - big.dirZ * 1.2, big.dirZ + big.dirX * 1.2, 2, 30]);
spots.push([`low-${big.river}`, big.x, big.bottom + 4, big.z, big.dirX, big.dirZ, 1.5, 18]);
spots.push([`crest-${big.river}`, big.x - big.dirX * 6, big.top, big.z - big.dirZ * 6, -big.dirX, -big.dirZ, 6, 22]);
// a long river reach seen from far away, for the line and the flicker
const r = [...field.rivers].sort((a, b) => b.points.length - a.points.length)[0]!;
const k = Math.floor(r.points.length * 0.5);
spots.push([`far-${r.id}`, r.points[k]![0], r.surfaceY![k], r.points[k]![1], 0.6, 0.8, 60, 220]);
console.log(JSON.stringify(spots));

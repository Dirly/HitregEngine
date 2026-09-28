import fs from "node:fs";
import { createWorldField, worldRecipeSchema } from "@hitreg/core";
const recipe = worldRecipeSchema.parse(JSON.parse(fs.readFileSync("projects/voxel-demo/assets/worlds/mmo.json", "utf8")));
const field = createWorldField(recipe);
const spots: unknown[] = [];
for (const s of field.falls.filter((f) => f.river.endsWith("-split"))) {
  const main = field.falls.find((f) => f.river === s.river.replace(/-split$/, ""));
  if (!main) continue;
  const cx = (main.x + s.x) / 2, cz = (main.z + s.z) / 2;
  const h = Math.max(main.top - main.bottom, s.top - s.bottom);
  // downstream of both, looking back up at them
  spots.push([`split2-${s.river}`, cx, main.bottom + h * 0.5, cz, main.dirX, main.dirZ, h * 0.3, 40 + h * 1.2]);
}
// a lake outlet: a river whose first points sit in a lake
const ws = { y: 0, flowX: 0, flowZ: 0, kind: "lake" as "lake" | "river", floor: 0 };
for (const r of field.rivers) {
  const k = r.points.findIndex((p) => !(field.waterSurface(p[0], p[1], ws) && ws.kind === "lake"));
  if (k <= 0 || k + 6 >= r.points.length) continue;
  const [x, z] = r.points[k]!;
  const d = r.points[k + 6]!;
  spots.push([`outlet-${r.id}`, x, r.surfaceY![k], z, d[0] - x, d[1] - z, 14, 30]);
  if (spots.length > 4) break;
}
console.log(JSON.stringify(spots));

/* scratch: rock-formation vertices standing over water (must be 0), and distance of the nearest vertex to the channel centreline per tier */
import fs from "node:fs";
import { createWorldField, worldRecipeSchema, createVolume, buildVolumeMesh } from "@hitreg/core";
const recipe = worldRecipeSchema.parse(JSON.parse(fs.readFileSync("projects/voxel-demo/assets/worlds/mmo.json", "utf8")));
const field = createWorldField(recipe);
const doc = JSON.parse(fs.readFileSync("projects/voxel-demo/assets/volumes/rock-site-river-15-21.json", "utf8"));
const t = performance.now();
const mesh = buildVolumeMesh(createVolume(doc));
console.log(`mesh ${mesh.triangleCount} tris in ${(performance.now() - t).toFixed(0)} ms`);
let overWater = 0, aboveRim = 0;
const river = field.rivers.find((r) => r.id === "river-15")!;
let nearest = Infinity;
for (let i = 0; i < mesh.vertexCount; i++) {
  const x = mesh.positions[i * 3]!, y = mesh.positions[i * 3 + 1]!, z = mesh.positions[i * 3 + 2]!;
  const w = field.waterY(x, z);
  if (w !== null && w > field.height(x, z) + 0.05 && y > field.height(x, z) + 0.2) { overWater++; if (overWater % 15 === 1) console.log("over water", x.toFixed(1), y.toFixed(1), z.toFixed(1), "water", w.toFixed(1), "ground", field.height(x, z).toFixed(1)); }
  let d = Infinity;
  for (let k = 0; k + 1 < river.points.length; k++) {
    const [ax, az] = river.points[k]!, [bx, bz] = river.points[k + 1]!;
    const sx = bx - ax, sz = bz - az, l2 = sx * sx + sz * sz || 1;
    const tt = Math.max(0, Math.min(1, ((x - ax) * sx + (z - az) * sz) / l2));
    d = Math.min(d, Math.hypot(x - ax - sx * tt, z - az - sz * tt));
  }
  if (y > field.height(x, z) - 0.5) nearest = Math.min(nearest, d);
}
console.log(`vertices over water ${overWater}; nearest exposed vertex to the centreline ${nearest.toFixed(2)} m (channel half-width ~3.6)`);

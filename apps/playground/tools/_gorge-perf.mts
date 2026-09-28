import fs from "node:fs";
import { createWorldField, worldRecipeSchema } from "@hitreg/core";
const load = (off: boolean) => { const json = JSON.parse(fs.readFileSync("projects/voxel-demo/assets/worlds/mmo.json", "utf8")); if (off) for (const s of json.features.fallSites) s.gorge = { enabled: false }; return createWorldField(worldRecipeSchema.parse(json)); };
const F = { off: load(true), on: load(false) };
for (let rep = 0; rep < 2; rep++) for (const k of ["off", "on"] as const) {
  const f = F[k]; let t = performance.now(), acc = 0;
  for (let x = 5280; x < 5440; x += 1) for (let z = -3960; z < -3800; z += 1) acc += f.height(x + 0.3, z + 0.7);
  const site = performance.now() - t; t = performance.now();
  for (let x = 1000; x < 1160; x += 1) for (let z = 1000; z < 1160; z += 1) acc += f.height(x + 0.3, z + 0.7);
  console.log(k, `site box 25.6k heights ${site.toFixed(0)} ms, elsewhere ${(performance.now() - t).toFixed(0)} ms`, acc > 0 ? "" : "");
}

/* scratch: per-mass exposure of the generated rock formations (share of the mass's surface in terrain air) */
import fs from "node:fs";
import { createWorldField, worldRecipeSchema, createVolume, buildVolumeMesh, rockFormations } from "@hitreg/core";
const recipe = worldRecipeSchema.parse(JSON.parse(fs.readFileSync("projects/voxel-demo/assets/worlds/mmo.json", "utf8")));
const field = createWorldField(recipe);
const site = (recipe.features.fallSites ?? []).find((s: any) => s.id === "site-river-15-21") as any;
const r = rockFormations(field, site, {});
const mesh = buildVolumeMesh(createVolume({ ...(r.docs[0] as any), voxelSize: 1 }));
const tot = new Float64Array(r.masses.length), air = new Float64Array(r.masses.length);
for (let i = 0; i < mesh.vertexCount; i++) {
  const x = mesh.positions[i * 3]!, y = mesh.positions[i * 3 + 1]!, z = mesh.positions[i * 3 + 2]!;
  let best = Infinity, bi = 0;
  r.masses.forEach((m, k) => { const d = Math.hypot((x - m.center[0]) / m.size[0], (y - m.center[1]) / m.size[1], (z - m.center[2]) / m.size[2]); if (d < best) { best = d; bi = k; } });
  tot[bi]++;
  if (field.density(x, y, z) > 0.2) air[bi]++;
}
r.masses.forEach((m, k) => console.log(m.kind.padEnd(8), m.tier, String(m.side).padStart(2), `size ${m.size.map((v) => v.toFixed(0)).join("x").padEnd(9)} verts ${String(tot[k]).padStart(4)} exposed ${(100 * air[k]! / Math.max(1, tot[k]!)).toFixed(0)}%`));

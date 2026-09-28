/* scratch: the river-15 scree with and without the formations joined in (site.formations set in memory; mmo.json untouched).
   Reports count, rocks overlapping a formation, and rocks whose base has air under it (no terrain and no formation). */
import fs from "node:fs";
import { createWorldField, worldRecipeSchema, fallSiteRockInstances, rockFormationSolid } from "@hitreg/core";
const json = JSON.parse(fs.readFileSync("projects/voxel-demo/assets/worlds/mmo.json", "utf8"));
for (const withF of [false, true]) {
  const j = JSON.parse(JSON.stringify(json));
  const s = j.features.fallSites.find((x: any) => x.id === "site-river-15-21");
  if (withF) s.formations = {};
  else delete s.formations;
  const recipe = worldRecipeSchema.parse(j);
  const field = createWorldField(recipe);
  const site = recipe.features.fallSites.find((x) => x.id === "site-river-15-21")!;
  const t = performance.now();
  const rocks = fallSiteRockInstances(field, site).filter((r) => r.id.includes("-wall-"));
  const ms = performance.now() - t;
  const solid = rockFormationSolid(field, site, {})!;
  let overlap = 0;
  const bad: string[] = [];
  for (const r of rocks) {
    // sample a small cloud around the rock's middle (model ~1.6 x 1.14 x 2.47 m at scale 1)
    const [x, y, z] = r.position, k = r.scale;
    let inside = 0, n = 0;
    for (const dx of [-0.5, 0, 0.5]) for (const dz of [-0.8, 0, 0.8]) for (const dy of [0.7, 0.95]) { n++; if (solid.density(x + dx * k, y + dy * 1.14 * k, z + dz * k) < 0) inside++; }
    if (inside / n > 0.25) { overlap++; bad.push(`${r.id.replace("site-river-15-21-", "")}@${[x, y, z].map((v) => v.toFixed(0))} ${(100 * inside / n).toFixed(0)}%`); }
  }
  console.log(`${withF ? "WITH" : "without"} formations: ${rocks.length} scree in ${ms.toFixed(0)} ms, ${overlap} overlapping a formation >25%`, bad.slice(0, 8).join(" "));
}

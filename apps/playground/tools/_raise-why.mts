/* scratch: at a point, what each water feature does to the ground */
import fs from "node:fs";
import { createWorldField, worldRecipeSchema } from "@hitreg/core";
const recipe = worldRecipeSchema.parse(JSON.parse(fs.readFileSync("projects/voxel-demo/assets/worlds/mmo.json", "utf8")));
const full = createWorldField(recipe);
const noRivers = createWorldField({ ...recipe, features: { ...recipe.features, rivers: [] } });
const noLakes = createWorldField({ ...recipe, features: { ...recipe.features, lakes: [] } });
const dry = createWorldField({ ...recipe, features: { ...recipe.features, rivers: [], lakes: [] } });
const ws = { y: 0, flowX: 0, flowZ: 0, kind: "lake" as "lake" | "river", floor: 0 };
for (const arg of process.argv.slice(2)) {
  const [x, z] = arg.split(",").map(Number) as [number, number];
  const lakes = recipe.features.lakes.map((l) => `${l.id}@${l.waterY}`).filter(() => false);
  const water = full.waterSurface(x, z, ws) ? `${ws.kind} ${ws.y.toFixed(2)}` : "none";
  console.log(`[${x},${z}] full ${full.height(x, z).toFixed(2)} noRivers ${noRivers.height(x, z).toFixed(2)} noLakes ${noLakes.height(x, z).toFixed(2)} dry ${dry.height(x, z).toFixed(2)} water ${water}`, lakes.join(""));
}

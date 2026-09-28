/* scratch: the site's rocks as they come out of voxelChunkDoc (the real instanced path) */
import fs from "node:fs";
import { createWorldField, worldRecipeSchema, voxelChunkDoc } from "@hitreg/core";
const json = JSON.parse(fs.readFileSync("projects/voxel-demo/assets/worlds/mmo.json", "utf8"));
const raw = json.features.fallSites.find((s: { id: string }) => s.id === "site-river-15-21");
raw.walls = process.argv[2] ? JSON.parse(process.argv[2]) : { rule: "rock-medium" };
const field = createWorldField(worldRecipeSchema.parse(json));
const size = field.recipe.cellSize;
let n = 0, meshes = new Set<string>();
const t = performance.now();
for (let cx = Math.floor((5358 - 120) / size); cx <= Math.floor((5358 + 120) / size); cx++)
  for (let cz = Math.floor((-3872 - 120) / size); cz <= Math.floor((-3872 + 120) / size); cz++) {
    const doc = voxelChunkDoc(field, "w", cx, cz, {}) as { entities: Record<string, { components: Record<string, any> }> };
    for (const [id, e] of Object.entries(doc.entities)) if (id.startsWith("site-river-15-21-")) {
      n++;
      meshes.add(`${e.components.mesh?.source?.assetId}|${e.components.mesh?.renderMode}`);
    }
  }
console.log(`site rock entities ${n} in ${(performance.now() - t).toFixed(0)} ms; mesh/renderMode:`, [...meshes]);

import fs from "node:fs";
import { createWorldField, worldRecipeSchema } from "@hitreg/core";
const recipe = worldRecipeSchema.parse(JSON.parse(fs.readFileSync("projects/voxel-demo/assets/worlds/mmo.json", "utf8")));
const field = createWorldField(recipe);
const names = recipe.surfaces.map((s) => s.name);
const blobs = recipe.features.blobs.filter((b) => b.id.startsWith("site-river-15-21") && b.op === "add").slice(0, 5);
for (const b of blobs) {
  const x = b.center[0], z = b.center[2];
  const bio = field.biome(x, z);
  console.log(b.id, "r", b.radius, "| ground", field.height(x, z).toFixed(1), "blob y", b.center[1].toFixed(1), "|", [...bio.surface].map((w, i) => w > 0.05 ? `${names[i]}:${w.toFixed(2)}` : "").filter(Boolean).join(" "));
}
console.log(JSON.stringify(recipe.surfaces.filter((s) => ["cliff", "rock", "dirt"].includes(s.name))).slice(0, 600));

import fs from "node:fs";
import { createWorldField, worldRecipeSchema } from "@hitreg/core";
const recipe = worldRecipeSchema.parse(JSON.parse(fs.readFileSync("projects/voxel-demo/assets/worlds/mmo.json", "utf8")));
const field = createWorldField(recipe) as any;
const names = recipe.surfaces.map((s: any) => s.name);
const n = names.length;
const out = new Float32Array(n + 3);
for (const [dx, dz] of [[0, 0], [15, 0], [-15, 0], [20, 10], [30, -20], [60, 0], [0, 60]]) {
  const x = 5358 + dx, z = -3872 + dz;
  const y = field.heightAt ? field.heightAt(x, z) : 60;
  const b = field.biome(x, z);
  for (const ny of [0.95, 0.3]) {
    field.surfaceAt(x, y, z, ny, out, 0);
    const top = [...out.slice(0, n)].map((w, i) => [names[i], w] as const).filter(([, w]) => w > 0.05).map(([k, w]) => `${k}:${w.toFixed(2)}`).join(" ");
    console.log(dx, dz, "y", y?.toFixed?.(1), "biome", b.id, "ny", ny, "|", top, "| tint", [...out.slice(n)].map((v) => v.toFixed(2)).join(","));
  }
}

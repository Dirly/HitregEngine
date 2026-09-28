import fs from "node:fs";
import { createWorldField, worldRecipeSchema } from "@hitreg/core";
const recipe = worldRecipeSchema.parse(JSON.parse(fs.readFileSync("projects/voxel-demo/assets/worlds/mmo.json", "utf8")));
const field = createWorldField(recipe);
const out: number[] = [];
for (const f of field.falls) for (let z = -60; z <= 60; z += 3) for (let x = -60; x <= 60; x += 3) out.push(field.height(f.x + x, f.z + z));
fs.writeFileSync(process.argv[2]!, JSON.stringify(out));

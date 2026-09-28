import fs from "node:fs";
import { createWorldField, worldRecipeSchema } from "@hitreg/core";
const json = JSON.parse(fs.readFileSync("projects/voxel-demo/assets/worlds/mmo.json", "utf8"));
if (process.argv[4] === "off") for (const s of json.features.fallSites) s.gorge = { enabled: false };
const f = createWorldField(worldRecipeSchema.parse(json));
const cx = Number(process.argv[2]), cz = Number(process.argv[3]);
for (let z = cz - 14; z <= cz + 14; z += 2) { let r = ""; for (let x = cx - 20; x <= cx + 20; x += 2) r += f.height(x, z).toFixed(0).padStart(4); console.log(String(z).padStart(6), r); }

import fs from "node:fs";
import { worldRecipeSchema } from "@hitreg/core";
const file = "projects/voxel-demo/assets/worlds/mmo.json";
const raw = JSON.parse(fs.readFileSync(file, "utf8"));
const sites = process.argv.slice(2).map((p) => JSON.parse(fs.readFileSync(p, "utf8")));
raw.features.fallSites = [...(raw.features.fallSites ?? []).filter((s: { id: string }) => !sites.some((n) => n.id === s.id)), ...sites];
worldRecipeSchema.parse(raw); // validate
fs.writeFileSync(file, JSON.stringify(raw, null, 2) + "\n");
console.log("fallSites:", raw.features.fallSites.map((s: { id: string; template: string }) => `${s.id} (${s.template})`).join(", "));

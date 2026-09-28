/* scratch: height map around a point: full ground minus min, as digits of 3 m, plus which is water */
import fs from "node:fs";
import { createWorldField, worldRecipeSchema } from "@hitreg/core";
const recipe = worldRecipeSchema.parse(JSON.parse(fs.readFileSync("projects/voxel-demo/assets/worlds/mmo.json", "utf8")));
const field = createWorldField(recipe);
const dry = createWorldField({ ...recipe, features: { ...recipe.features, rivers: [], lakes: [] } });
const [cx, cz] = process.argv[2]!.split(",").map(Number) as [number, number];
const R = Number(process.argv[3] ?? 30), S = Number(process.argv[4] ?? 2);
const ws = { y: 0, flowX: 0, flowZ: 0, kind: "lake" as "lake" | "river", floor: 0 };
const rows: string[] = [];
const rowsD: string[] = [];
for (let z = cz - R; z <= cz + R; z += S) {
  let a = "", b = "";
  for (let x = cx - R; x <= cx + R; x += S) {
    const h = field.height(x, z);
    const wet = field.waterSurface(x, z, ws) && ws.y > h;
    a += wet ? "~" : String.fromCharCode(48 + Math.max(0, Math.min(42, Math.round((h - recipe.seaLevel) / 3))));
    const d = h - dry.height(x, z);
    b += Math.abs(d) < 0.5 ? "." : d > 0 ? (d > 3 ? "U" : "u") : d < -10 ? "D" : "d";
  }
  rows.push(a);
  rowsD.push(b);
}
for (let i = 0; i < rows.length; i++) console.log(rows[i] + "   " + rowsD[i]);

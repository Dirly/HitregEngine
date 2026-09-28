/* scratch: around each lake-spill fall, map ground-vs-natural and water */
import fs from "node:fs";
import { createWorldField, worldRecipeSchema } from "@hitreg/core";
const recipe = worldRecipeSchema.parse(JSON.parse(fs.readFileSync("projects/voxel-demo/assets/worlds/mmo.json", "utf8")));
const field = createWorldField(recipe);
const natural = createWorldField({ ...recipe, features: { ...recipe.features, rivers: [], roads: [], bridges: [], towns: [] } });
const ws = { y: 0, flowX: 0, flowZ: 0, kind: "lake" as "lake" | "river", floor: 0 };
const only = process.argv[2];
for (const f of field.falls) {
  const lx = f.x - f.dirX * 8, lz = f.z - f.dirZ * 8;
  const spill = field.waterSurface(lx, lz, ws) && ws.kind === "lake";
  if (!only && !spill) continue;
  if (only && f.river !== only) continue;
  console.log(`== ${f.river} foot [${f.x.toFixed(0)},${f.z.toFixed(0)}] ${f.top}->${f.bottom} dir ${f.dirX.toFixed(2)},${f.dirZ.toFixed(2)} w ${f.width.toFixed(1)} spill ${spill}`);
  // frame: rows = along (upstream -30 .. +10), cols = across -30..30; show raise (ground-natural) and water
  const px = -f.dirZ, pz = f.dirX;
  const lipX = f.x - f.dirX * 3, lipZ = f.z - f.dirZ * 3;
  for (let a = -24; a <= 8; a += 2) {
    let raise = "", wat = "";
    for (let c = -30; c <= 30; c += 2) {
      const x = lipX + f.dirX * a + px * c, z = lipZ + f.dirZ * a + pz * c;
      const g = field.height(x, z), n = natural.height(x, z);
      const d = g - n;
      raise += d > 6 ? "#" : d > 2 ? "+" : d < -6 ? "v" : d < -2 ? "-" : ".";
      const ok = field.waterSurface(x, z, ws);
      wat += !ok ? " " : ws.y + 0.35 > g ? (ws.kind === "lake" ? "L" : "~") : "o";
    }
    console.log(`${String(a).padStart(4)} ${raise}   ${wat}`);
  }
}

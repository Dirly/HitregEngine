/* scratch: how many rivers start in a lake (or, for -split, in their parent), and km */
import fs from "node:fs";
import { createWorldField, worldRecipeSchema } from "@hitreg/core";
const recipe = worldRecipeSchema.parse(JSON.parse(fs.readFileSync(process.argv[2]!, "utf8")));
const field = createWorldField(recipe);
const ws = { y: 0, flowX: 0, flowZ: 0, kind: "lake" as "lake" | "river", floor: 0 };
let lake = 0, split = 0, other: string[] = [], km = 0;
const heads = new Set<string>();
for (const r of recipe.features.rivers) for (let i = 1; i < r.points.length; i++) km += Math.hypot(r.points[i]![0] - r.points[i - 1]![0], r.points[i]![1] - r.points[i - 1]![1]);
const mouths = new Set(recipe.features.rivers.map((r) => r.points[r.points.length - 1]!.map(Math.round).join(",")));
for (const r of recipe.features.rivers) {
  const [x, z] = r.points[0]!;
  if (r.id.endsWith("-split")) { split++; continue; }
  // a continuation piece (head on another piece's mouth) belongs to its chain
  if (mouths.has(r.points[0]!.map(Math.round).join(","))) continue;
  let inLake = false;
  for (const lk of recipe.features.lakes) {
    // within ~40 m of a lake's surface sample
    for (const [dx, dz] of [[0, 0], [16, 0], [-16, 0], [0, 16], [0, -16], [32, 0], [-32, 0], [0, 32], [0, -32]]) if (field.waterSurface(x + dx!, z + dz!, ws) && ws.kind === "lake") inLake = true;
    if (inLake) break;
  }
  if (inLake) lake++; else other.push(r.id);
}
console.log(`rivers ${recipe.features.rivers.length} (${split} split), chains starting at a lake ${lake}, not: ${other.length} ${other.join(" ")}; ${(km / 1000).toFixed(1)} km; lakes ${recipe.features.lakes.length}`);

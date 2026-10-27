/**
 * Path ribbons — the support commands of the `path` landform operator (packages/core/src/voxel/ribbon.ts).
 *
 *   tsx tools/worldgen-ribbon.mts materials <world.json>   write ribbon/<surface>[--trodden] (terrain tint, alphaHash verge) and
 *       ribbon-wall/<cliff>-rubble|ashlar (kit masonry in the zone stone tone) materials next to the world;
 *       for every palette surface a compiled ribbon paves with (the streamer draws a ribbon with `ribbon/<surface>`)
 *   tsx tools/worldgen-ribbon.mts report <world.json>      per ribbon: length, steepest ramp, flights/risers, walls,
 *       switchbacks, warnings, and how far the drawn ground sits from the walk surface (the 5 cm contract)
 *
 * Install / preview a path with the operator commands: `worldgen op <world> --apply <file>` and
 * `worldgen op-preview <world> --op <id>` (both take `--recipe <file>` for a scratch copy).
 */
import fs from "node:fs";
import { createWorldField, ribbonSurfaces, RIBBON_LIFT, worldRecipeSchema, type WorldRecipe } from "@hitreg/core";
import { writeRibbonMaterials } from "./_ribbon-materials.mts";

const [cmd, file] = process.argv.slice(2);
if (!cmd || !file) {
  console.error("usage: worldgen-ribbon.mts materials|report <world.json>");
  process.exit(2);
}
const recipe: WorldRecipe = worldRecipeSchema.parse(JSON.parse(fs.readFileSync(file, "utf8")));
const ribbons = recipe.features.ribbons ?? [];
const surfaces = ribbonSurfaces(recipe);

if (cmd === "materials") {
  const { wrote, warnings } = writeRibbonMaterials(recipe, file);
  for (const w of warnings) console.warn(w);
  console.log(`ribbon materials: ${wrote.length ? wrote.join(", ") : "none needed"}`);
} else if (cmd === "report") {
  const field = createWorldField(recipe);
  let bad = 0;
  for (const r of ribbons) {
    const inStair = (i: number) => r.flights.some((f) => i >= f.from - 2 && i <= f.to + 2);
    let worst = 0, at = -1;
    for (let i = 0; i < r.samples.length; i++) {
      if (inStair(i)) continue;
      const [x, y, z] = r.samples[i]!;
      const d = Math.abs(field.height(x, z) - (y - RIBBON_LIFT));
      if (d > worst) { worst = d; at = i; }
    }
    const risers = r.flights.reduce((n, f) => n + f.treads.length, 0);
    const ok = worst <= 0.05;
    if (!ok) bad++;
    console.log(`${ok ? "ok  " : "FAIL"} ${r.id}: ${r.samples.length} m, ${surfaces.surfaceOf(r)}, ${r.flights.length} flight(s) / ${risers} treads, ${r.switchbacks} switchback(s), ${r.pieces.filter((p) => p.role !== "cap").length} wall piece(s); ground vs walk surface ${worst.toFixed(3)} m (sample ${at})${r.warnings.length ? `; ${r.warnings.join("; ")}` : ""}`);
  }
  process.exit(bad ? 1 : 0);
} else {
  console.error(`unknown command ${cmd}`);
  process.exit(2);
}

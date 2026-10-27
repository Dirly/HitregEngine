/**
 * Landmarks the recipe places whose baked prefab is missing. `worldgen op --apply` compiles a landmark/wall operator
 * into `features.landmarks` naming `landmarks/<opId>-<digest>`, but only `tools/landmark.mts` writes that prefab; the
 * chunk builder silently skips an absent prefab, so an applied-but-unbaked wall or landmark simply is not there in
 * game (no mesh, no collider). `worldgen op --check` fails while any is missing.
 */
import fs from "node:fs";
import path from "node:path";
import type { WorldRecipe } from "@hitreg/core";

/** Landmark prefab ids with no prefabs/<id>.json in the world's project or any project beside it. */
export function unbakedLandmarks(recipe: WorldRecipe, file: string): { id: string; prefab: string }[] {
  const assets = path.resolve(path.dirname(file), "..");
  const projectsDir = path.resolve(assets, "..", "..");
  const dirs = [path.join(assets, "prefabs"), ...(fs.existsSync(projectsDir) ? fs.readdirSync(projectsDir).map((d) => path.join(projectsDir, d, "assets", "prefabs")) : [])];
  return (recipe.features.landmarks ?? [])
    .filter((l) => !dirs.some((d) => fs.existsSync(path.join(d, `${l.prefab}.json`))))
    .map((l) => ({ id: l.id, prefab: l.prefab }));
}

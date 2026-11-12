/**
 * The exterior chain's command hooks (tools/poi-review/exterior-chain.mjs): a build command for a PLACE (a dungeon door,
 * a painted POI, a landmark) refuses until the place's chain is complete — location -> unedited grab -> concepts painted
 * from it -> `zonegen concept-check` — or the place is grandfathered, or an owner ruling is given
 * (--no-concept-ruling "YYYY-MM-DD <Derek's words>", recorded). The write guard in _scene-write.mts catches every world
 * write as well; these hooks refuse EARLY, before the heavy work, and name the place the command was for.
 */
import fs from "node:fs";
import path from "node:path";
// @ts-ignore plain JS engine tool module
import { exteriorPlaces, placeOwnership, requireExterior, zonedWorlds } from "../../../tools/poi-review/exterior-chain.mjs";
// @ts-ignore plain JS engine tool module
import { ownsFeature } from "../../../tools/poi-review/concept-site.mjs";

type J = Record<string, any>;
const PG = path.resolve(import.meta.dirname, "..");
export const projectDirOf = (project: string): string => path.join(PG, "projects", project);

/** The place (id) whose own need this is, or null. */
export function placeOfNeed(projectDir: string, world: string, recipe: J, needId: string): string | null {
  for (const p of exteriorPlaces(projectDir, world)) if (placeOwnership(recipe, p).needs.includes(needId)) return p.id;
  return null;
}
/** The place (id) whose own operator / feature this is (the token rule included), or null. */
export function placeOfFeature(projectDir: string, world: string, recipe: J, f: J): string | null {
  for (const p of exteriorPlaces(projectDir, world)) if (ownsFeature(placeOwnership(recipe, p), f)) return p.id;
  return null;
}

/** The refusal text for a place build, or null when it may go on. */
export function exteriorRefusal(project: string, world: string, place: string, command: string, recipe?: J): string | null {
  const projectDir = projectDirOf(project);
  if (!fs.existsSync(path.join(projectDir, "authoring", "zonegen", world, "zones"))) return null;
  return requireExterior({ projectDir, world, place, command, recipe });
}
/** Print the refusal and exit 3 when the place may not be built. */
export function exteriorOrExit(project: string, world: string, place: string | null, command: string, recipe?: J): void {
  if (!place) return;
  const why = exteriorRefusal(project, world, place, command, recipe);
  if (why) { console.error(why); process.exit(3); }
}
/** The zoned worlds of a project (where a place id may live). */
export const worldsOf = (project: string): string[] => zonedWorlds(projectDirOf(project));

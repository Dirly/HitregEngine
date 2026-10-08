/**
 * `worldgen zone-textures <world> --project <p> [--zone <id>]` — give zones their own ground.
 *
 * The cast (authoring/zonegen/<world>/cast.json) names each zone's `palette`; a palette's ground LOOK is
 * authoring/zonegen/palettes/<palette>.json (`groundPaletteSchema`): one tile per ground role (grass, ground,
 * cliff, road, paving, accent). This stage:
 *
 *   1. tags the base palette's surfaces with their roles if nothing is tagged yet (grass/drygrass = grass,
 *      dirt/mud = ground, cliff/rock = cliff, sand = accent) — edit `surfaces[].role` to change it;
 *   2. registers each tile as a palette surface `<palette>-<role>` (texture, average colour, tile scale);
 *   3. sets every cast zone's `regions[].ground` (role -> that surface), which the field blends in by zone
 *      membership over `zoneGround.band`;
 *   4. switches the world to `splat: "indexed"` (four layers per vertex from one texture array) and
 *      re-emits the terrain material so its layers match the palette.
 *
 * Nothing is baked: voxel cells mesh from the recipe as they stream, so a reload shows it. Town streets
 * take the zone's `paving` once their roads carry `role: "paving"` (`town-ground paving --town <t>`).
 * `worldgen status` reports the row `zone-textures`.
 */
import fs from "node:fs";
import path from "node:path";
import { NATURAL_SURFACE_ROLES, recipeSplatIndexed, type WorldRecipe } from "@hitreg/core";
// @ts-expect-error plain JS helper
import { decodePng } from "./_png.mjs";
import { groundPaletteSchema, type GroundPalette } from "./zonegen/schemas.mts";

export interface ZoneTexturesHost {
  argv: string[];
  project: string;
  assetsRoot(): string;
  loadRecipe(name: string): { recipe: WorldRecipe; file: string };
  writeRecipe(recipe: WorldRecipe, file: string): void;
  writeTerrainMaterial(recipe: WorldRecipe, id: string, force?: boolean): void;
  fail(message: string): never;
}

const PLAYGROUND = path.resolve(import.meta.dirname, "..");

/** Base surfaces a role is assumed to cover when a palette carries no role tags yet. */
const DEFAULT_ROLE_TAGS: Record<string, (typeof NATURAL_SURFACE_ROLES)[number]> = {
  grass: "grass",
  drygrass: "grass",
  dirt: "ground",
  mud: "ground",
  cliff: "cliff",
  rock: "cliff",
  sand: "accent",
};
/** Metres per tile when no base surface fills the role (road/paving are paint roles). */
const DEFAULT_UV: Record<string, number> = { grass: 3.5, ground: 4, cliff: 20, road: 3.5, paving: 3, accent: 4.5 };

interface CastRowLite {
  zone: string;
  palette: string;
}

function projectDir(project: string): string {
  return path.join(PLAYGROUND, "projects", project);
}

function readCast(project: string, world: string): CastRowLite[] {
  const file = path.join(projectDir(project), "authoring", "zonegen", world, "cast.json");
  if (!fs.existsSync(file)) return [];
  const doc = JSON.parse(fs.readFileSync(file, "utf8")) as { rows?: CastRowLite[] };
  return (doc.rows ?? []).filter((r) => r && typeof r.zone === "string" && typeof r.palette === "string");
}

function paletteFile(project: string, id: string): string {
  return path.join(projectDir(project), "authoring", "zonegen", "palettes", `${id}.json`);
}

function readPalette(project: string, id: string): GroundPalette | null {
  const file = paletteFile(project, id);
  if (!fs.existsSync(file)) return null;
  const parsed = groundPaletteSchema.safeParse(JSON.parse(fs.readFileSync(file, "utf8")));
  if (!parsed.success) throw new Error(`palette ${file} is invalid:\n${parsed.error.message}`);
  return parsed.data;
}

type Entry = { role: string; texture: string; uvScale?: number; roughness?: number };
function entries(palette: GroundPalette): Entry[] {
  return Object.entries(palette.ground).map(([role, v]) =>
    typeof v === "string" ? { role, texture: v } : { role, texture: v!.texture, uvScale: v!.uvScale, roughness: v!.roughness },
  );
}

const surfaceName = (palette: string, role: string): string => `${palette}-${role}`;

/** Average colour of a PNG as #rrggbb (the surface's fallback colour and what the map draws). */
function averageColor(file: string): string {
  try {
    const png = decodePng(fs.readFileSync(file)) as { width: number; height: number; data: Uint8Array };
    let r = 0;
    let g = 0;
    let b = 0;
    let n = 0;
    for (let i = 0; i < png.data.length; i += 4) {
      if (png.data[i + 3]! < 128) continue;
      r += png.data[i]!;
      g += png.data[i + 1]!;
      b += png.data[i + 2]!;
      n++;
    }
    if (n === 0) return "#808080";
    const hex = (v: number): string => Math.round(v / n).toString(16).padStart(2, "0");
    return `#${hex(r)}${hex(g)}${hex(b)}`;
  } catch {
    return "#808080";
  }
}

export function commandZoneTextures(host: ZoneTexturesHost, world: string): void {
  const { project } = host;
  if (!project) host.fail("zone-textures needs --project <p> (the cast and palettes live in its authoring/zonegen)");
  const opt = (name: string): string => {
    const i = host.argv.indexOf(`--${name}`);
    return i >= 0 && host.argv[i + 1] && !host.argv[i + 1]!.startsWith("--") ? host.argv[i + 1]! : "";
  };
  const only = opt("zone");
  const rows = readCast(project, world).filter((r) => !only || r.zone === only);
  if (rows.length === 0) host.fail(only ? `no cast row for zone "${only}" in authoring/zonegen/${world}/cast.json` : `no cast rows in authoring/zonegen/${world}/cast.json`);

  // read the recipe FRESH, change it, write it at once: other tools write this file too
  const { recipe, file } = host.loadRecipe(world);

  // 1. role tags on the base palette
  if (!recipe.surfaces.some((s) => s.role)) {
    const tagged: string[] = [];
    for (const s of recipe.surfaces) {
      const role = DEFAULT_ROLE_TAGS[s.name.toLowerCase()];
      if (role) {
        s.role = role;
        tagged.push(`${s.name}=${role}`);
      }
    }
    console.log(`tagged base surfaces: ${tagged.join(", ") || "(none matched; set surfaces[].role by hand)"}`);
  }

  let applied = 0;
  for (const row of rows) {
    const palette = readPalette(project, row.palette);
    if (!palette) {
      const msg = `${row.zone}: palette "${row.palette}" has no ground look (${path.relative(process.cwd(), paletteFile(project, row.palette))})`;
      if (only) host.fail(msg);
      console.log(`  skip ${msg}`);
      continue;
    }
    const region = recipe.regions.find((r) => r.id === row.zone);
    if (!region) host.fail(`${row.zone}: no such region in ${world} (run worldgen zones, or fix the cast)`);
    const ground: Record<string, string> = {};
    for (const e of entries(palette)) {
      const png = path.join(host.assetsRoot(), "textures", e.texture);
      if (!fs.existsSync(png)) host.fail(`${row.palette}.${e.role}: texture ${e.texture} not found under ${path.relative(process.cwd(), path.join(host.assetsRoot(), "textures"))}`);
      const name = surfaceName(row.palette, e.role);
      const base = recipe.surfaces.find((s) => s.role === e.role);
      const surface = {
        name,
        color: averageColor(png),
        roughness: e.roughness ?? base?.roughness ?? 0.95,
        map: e.texture,
        uvScale: e.uvScale ?? base?.uvScale ?? DEFAULT_UV[e.role] ?? 4,
      };
      const at = recipe.surfaces.findIndex((s) => s.name.toLowerCase() === name.toLowerCase());
      if (at >= 0) recipe.surfaces[at] = surface as (typeof recipe.surfaces)[number];
      else recipe.surfaces.push(surface as (typeof recipe.surfaces)[number]);
      ground[e.role] = name;
    }
    region.ground = ground as typeof region.ground;
    applied++;
    console.log(`  ${row.zone} (${region.name}) <- ${row.palette}: ${Object.entries(ground).map(([r, s]) => `${r}=${s}`).join(", ")}`);
  }
  if (applied === 0) host.fail("no zone had a ground look to apply");
  recipe.splat = "indexed";
  host.writeRecipe(recipe, file);
  host.writeTerrainMaterial(recipe, recipe.material ?? `terrain/${recipe.name}`, true);
  console.log(
    `${recipe.surfaces.length} surfaces, splat ${recipeSplatIndexed(recipe) ? "indexed" : "dense"}; nothing to bake — cells mesh from the recipe as they stream.\n` +
      `towns in these zones take the paving once their streets carry role "paving": npx tsx tools/town-ground.mts paving --project ${project} --town <town>`,
  );
}

/**
 * The status row: MISSING while a cast zone whose palette has a ground look does not carry it (or the
 * terrain material does not match the palette, or a town street in it is unpaved); ok when nothing is
 * declared. STALE comes from the pipeline stamps (re-running `zones` rewrites the regions).
 */
export function zoneTexturesStageCheck(recipe: WorldRecipe, project: string, assetsRoot: string): string | null {
  if (!project) return null;
  const rows = readCast(project, recipe.name);
  const wanted: { row: CastRowLite; palette: GroundPalette }[] = [];
  for (const row of rows) {
    try {
      const palette = readPalette(project, row.palette);
      if (palette) wanted.push({ row, palette });
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  }
  if (wanted.length === 0) return null;
  const problems: string[] = [];
  for (const { row, palette } of wanted) {
    const region = recipe.regions.find((r) => r.id === row.zone);
    if (!region) {
      problems.push(`${row.zone}: no region`);
      continue;
    }
    for (const e of entries(palette)) {
      const name = surfaceName(row.palette, e.role);
      const surface = recipe.surfaces.find((s) => s.name === name);
      const have = (region.ground as Record<string, string> | undefined)?.[e.role];
      if (!surface || surface.map !== e.texture || have !== name) {
        problems.push(`${row.zone}.${e.role} not applied`);
        break;
      }
    }
    // a town's own streets, in a zone with paving, should carry it
    if (palette.ground.paving) {
      const towns = recipe.regions.filter((r) => r.within === row.zone && r.tags.includes("town")).map((r) => r.landmarks[0]).filter(Boolean);
      for (const town of towns) {
        const streets = recipe.features.roads.filter((r) => r.id.startsWith(`${town}-street-`));
        if (streets.length > 0 && streets.some((r) => r.role !== "paving")) problems.push(`${town} streets unpaved (town-ground paving --town <name>)`);
      }
    }
  }
  const materialFile = path.join(assetsRoot, "materials", `${recipe.material ?? `terrain/${recipe.name}`}.json`);
  if (fs.existsSync(materialFile)) {
    const mat = JSON.parse(fs.readFileSync(materialFile, "utf8")) as { splat?: { source?: string; layers?: { map?: string }[] } };
    const layers = mat.splat?.layers ?? [];
    const source = recipeSplatIndexed(recipe) ? "indexed" : "vertex";
    const mapsMatch = layers.length === recipe.surfaces.length && recipe.surfaces.every((s, i) => (layers[i]?.map ?? undefined) === (s.map ?? undefined));
    if (mat.splat?.source !== source || !mapsMatch) problems.push("terrain material does not match the palette (worldgen material)");
  }
  return problems.length > 0 ? problems.slice(0, 4).join("; ") : null;
}

/**
 * `worldgen zone-textures <world> --project <p> [--zone <id>]` — give zones their own ground.
 *
 * The cast (authoring/zonegen/<world>/cast.json) names each zone's `palette`; a palette's ground LOOK is
 * authoring/zonegen/palettes/<palette>.json (`groundPaletteSchema`): one tile per ground role (grass, ground,
 * cliff, road, paving, accent). Palettes and their tiles (assets/textures) are looked up across the project's
 * dependsOn closure (tools/_closure.mjs), own project first — a world reuses the foundation's tiles. This stage:
 *
 *   1. tags the base palette's surfaces with their roles if nothing is tagged yet (grass/drygrass = grass,
 *      dirt/mud = ground, cliff/rock = cliff, sand = accent) — edit `surfaces[].role` to change it;
 *   2. registers each tile as a palette surface `<palette>-<role>` (texture, average colour, tile scale);
 *   3. sets every cast zone's `regions[].ground` (role -> that surface), which the field blends in by zone
 *      membership over `zoneGround.band`;
 *   3b. gives every sea-cliff stretch its zone's cliff (`turf.zone` + `turf.cliff`): the wall stands on the zone
 *      polygon's edge, so without it the face draws a share of the base `cliff` (the row faults a stretch without it);
 *   4. switches the world to `splat: "indexed"` (four layers per vertex from one texture array) and
 *      re-emits the terrain material so its layers match the palette.
 *
 * Nothing is baked: voxel cells mesh from the recipe as they stream, so a reload shows it. Town streets
 * take the zone's `paving` once their roads carry `role: "paving"` (`town-ground paving --town <t>`).
 * `worldgen status` reports the row `zone-textures`.
 *
 * A CORRIDOR (one stretch of a zone restyled, e.g. a gorge's walls darker than the rest of the zone):
 *
 *   worldgen zone-textures <world> --project <p> --region <id> --palette <palette> [--within <zone> --polygon "x,z;..."
 *     --name "..."] [--band m] [--rock-cap <role>[:amount]] [--rock-slice n] [--extend-palette] [--inverse f.json] | --undo f.json
 *
 * applies one palette to ONE region nested in a zone (creating it as a look-only `place` region when --polygon is
 * given): its roles over the zone's own ground (a nested region's membership takes the zone's share, so every role
 * the zone restyles is carried over, else the base tile would show through), every tile inside the ZONE's palette
 * (regions[].palette; refused otherwise), its rock skins (the 8 rock slices are full in a big world: `--rock-slice`
 * reclaims one, by ruling). Keep the region's polygon ~1 band (zoneGround.band) wider than the stretch it restyles.
 * `--inverse` records every recipe key and material file it changes; `--undo` restores them.
 */
import fs from "node:fs";
import path from "node:path";
import { NATURAL_SURFACE_ROLES, recipeSplatIndexed, type WorldRecipe } from "@hitreg/core";
// @ts-expect-error plain JS helper
import { decodePng } from "./_png.mjs";
import { motifScore } from "./texture-swatch.mjs";
import { groundPaletteSchema, type GroundPalette } from "./zonegen/schemas.mts";
import { closure, findAsset } from "./_closure.mjs";
import { writeRockSkinTemplate } from "./rock-skins.mts";
import { paletteRefusals, zoneAt, zoneOf, zonePalette } from "./_zone-palette.mts";

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

/** A palette's ground look: the first `authoring/zonegen/palettes/<id>.json` across the project's dependsOn closure (own first). */
function paletteFile(project: string, id: string): string {
  for (const p of closure(project) as string[]) {
    const f = path.join(projectDir(p), "authoring", "zonegen", "palettes", `${id}.json`);
    if (fs.existsSync(f)) return f;
  }
  return path.join(projectDir(project), "authoring", "zonegen", "palettes", `${id}.json`);
}

/** A ground tile's PNG: `assets/textures/<rel>` across the closure (where the running game resolves it), or null. */
function textureFile(project: string, rel: string): string | null {
  return findAsset(project, path.join("textures", rel)) as string | null;
}

function readPalette(project: string, id: string): GroundPalette | null {
  const file = paletteFile(project, id);
  if (!fs.existsSync(file)) return null;
  const parsed = groundPaletteSchema.safeParse(JSON.parse(fs.readFileSync(file, "utf8")));
  if (!parsed.success) throw new Error(`palette ${file} is invalid:\n${parsed.error.message}`);
  return parsed.data;
}

/** Tiles that read as wood: a street or road is never planks (Derek rejected the Drownmere plank street, 2026-10-21). */
const WOOD_TILE = /plank|board|deck/i;
const STREET_ROLES = ["road", "paving"];

/** A palette's road/paving tiles that are wood (planks, boards, decking), as printable faults. */
export function woodenStreetFaults(palette: GroundPalette, paletteId = palette.id): string[] {
  return entries(palette)
    .filter((e) => STREET_ROLES.includes(e.role) && WOOD_TILE.test(e.texture))
    .map((e) => `${paletteId}.${e.role}: tile ${e.texture} is wood — roads and streets are dirt, gravel or stone, never planks/boards/decking (pick or paint a ground tile; a note does not excuse it)`);
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
  if (opt("undo")) return undoRegionTextures(host, world, opt("undo"));
  if (opt("region")) return commandRegionTextures(host, world, opt);
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
  const rockPrefer: Record<string, string> = {}, rockSmallPrefer: Record<string, string> = {}, rockLargePrefer: Record<string, string> = {};
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
    const wood = woodenStreetFaults(palette, row.palette);
    if (wood.length) host.fail(`${row.zone}: FAULT\n  ${wood.join("\n  ")}`);
    const ground: Record<string, string> = {};
    for (const e of entries(palette)) {
      const png = textureFile(project, e.texture);
      if (!png) host.fail(`${row.palette}.${e.role}: texture ${e.texture} not found under assets/textures of ${(closure(project) as string[]).join(", ")}`);
      // a lone mark on a tile repeats into a grid of icons on the ground (Hagsheer 2026-10-21: lichen clovers read as
      // plus signs); tools/texture-swatch.mjs writes the 4 x 4 swatch to look at
      const motif = (() => { try { const im = decodePng(fs.readFileSync(png)) as { width: number; height: number; data: Uint8Array }; return motifScore(im.width, im.height, im.data); } catch { return { score: 0 }; } })();
      if (motif.score >= 1) host.fail(`${row.palette}.${e.role}: FAULT tile ${e.texture} has a lone mark (motif ${motif.score}) that repeats into a grid of icons: node tools/texture-swatch.mjs ${path.relative(process.cwd(), png)} and repaint or pick another tile`);
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
    // ONE palette per role per zone (regions[].palette): the cast may not hand a zone a tile its palette refuses
    const zp = zonePalette(recipe, region.id);
    if (zp) {
      const bad = [
        ...paletteRefusals(zp, "cliff", ground["cliff"] ? [ground["cliff"]] : []).map((t) => `cliff ${t}`),
        ...paletteRefusals(zp, "ground", Object.entries(ground).filter(([r]) => r !== "cliff").map(([, s]) => s)).map((t) => `ground ${t}`),
        ...(palette.rockSmall ? paletteRefusals(zp, "rockSmall", [palette.rockSmall]).map((t) => `rockSmall ${t}`) : []),
        ...(palette.rockLarge ? paletteRefusals(zp, "rockLarge", [palette.rockLarge]).map((t) => `rockLarge ${t}`) : []),
      ];
      if (bad.length) host.fail(`${row.zone}: REFUSED ${bad.join(", ")}: outside the zone palette (recipe regions[].palette; change the palette first, by ruling)`);
    }
    region.ground = ground as typeof region.ground;
    if (palette.rock && ground["cliff"]) rockPrefer[ground["cliff"]] = palette.rock;
    if (palette.rockSmall && ground["cliff"]) rockSmallPrefer[ground["cliff"]] = palette.rockSmall;
    if (palette.rockLarge && ground["cliff"]) rockLargePrefer[ground["cliff"]] = palette.rockLarge;
    applied++;
    console.log(`  ${row.zone} (${region.name}) <- ${row.palette}: ${Object.entries(ground).map(([r, s]) => `${r}=${s}`).join(", ")}`);
  }
  if (applied === 0) host.fail("no zone had a ground look to apply");
  // 4b. sea cliffs are the zone's cliff: each stretch's turf names its zone and carries the cliff tile onto the wall
  const sea = seaCliffTurf(recipe);
  if (sea.length) console.log(`  sea cliffs take their zone's cliff: ${sea.join(", ")}`);
  recipe.splat = "indexed";
  // 5. the stone follows the place: each zone's cliff gets a slice of the world's rock material (recipe.rockSkins)
  // its small rocks (under 4 m) a grainy small-rock tile in the parallel slot of the small rock material, and its
  // free-standing large rocks (4-16 m) its boulder tile in the large rock material
  writeRockSkinTemplate(project, recipe, rockPrefer, rockSmallPrefer, rockLargePrefer);
  host.writeRecipe(recipe, file);
  host.writeTerrainMaterial(recipe, recipe.material ?? `terrain/${recipe.name}`, true);
  console.log(
    `${recipe.surfaces.length} surfaces, splat ${recipeSplatIndexed(recipe) ? "indexed" : "dense"}; nothing to bake — cells mesh from the recipe as they stream.\n` +
      `towns in these zones take the paving once their streets carry role "paving": npx tsx tools/town-ground.mts paving --project ${project} --town <town>`,
  );
}

type SeaCliffLite = { id?: string; region?: string; along?: [number, number][]; turf?: { zone?: string; surface?: string; amount?: number; cliff?: boolean } };

/** Distance from (x, z) to a polygon's edges. */
function polygonDistance(x: number, z: number, poly: readonly (readonly number[])[]): number {
  let best = Infinity;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [ax, az] = poly[j]! as [number, number], [bx, bz] = poly[i]! as [number, number];
    const dx = bx - ax, dz = bz - az, len = dx * dx + dz * dz;
    const t = len > 0 ? Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / len)) : 0;
    best = Math.min(best, Math.hypot(x - (ax + dx * t), z - (az + dz * t)));
  }
  return best;
}

/**
 * The zone a sea-cliff stretch is the coast of: its `region`'s zone, else the zone whose polygon holds most of its
 * `along` points, else the nearest zone polygon (the wall runs on the coastline, the polygon's edge, often just outside).
 */
export function seaCliffZone(recipe: WorldRecipe, doc: SeaCliffLite): string | null {
  if (doc.region) return zoneOf(recipe, doc.region)?.id ?? null;
  const zones = recipe.regions.filter((r) => !r.within && r.polygon && r.polygon.length >= 3);
  if (zones.length === 0 || !doc.along?.length) return null;
  const votes = new Map<string, number>();
  for (const [x, z] of doc.along) {
    let id = zoneAt(recipe, x, z);
    if (!id) {
      let bd = Infinity;
      for (const r of zones) { const d = polygonDistance(x, z, r.polygon!); if (d < bd) { bd = d; id = r.id; } }
    }
    if (id) votes.set(id, (votes.get(id) ?? 0) + 1);
  }
  let best: string | null = null, bv = 0;
  for (const [id, v] of votes) if (v > bv) { bv = v; best = id; }
  return best;
}

/** The zone ground's cliff of a zone (or null): what its sea cliffs should draw. */
function zoneCliffTile(recipe: WorldRecipe, zone: string): string | null {
  return (recipe.regions.find((r) => r.id === zone)?.ground as Record<string, string> | undefined)?.cliff ?? null;
}

/**
 * Sea cliffs take the zone's cliff tile (redstrand 2026-10-29: the Weeping Sun's face and its cape drew the base
 * palette's grey `cliff` because the wall stands on the zone polygon's edge, half outside its membership band). Sets
 * `turf.zone` + `turf.cliff` on every stretch of a zone with a ground cliff, keeping the rest of its turf. Returns the
 * stretches changed, as "id->zone".
 */
export function seaCliffTurf(recipe: WorldRecipe): string[] {
  const docs = ((recipe.terrain as { seaCliffs?: SeaCliffLite[] }).seaCliffs ?? []);
  const changed: string[] = [];
  for (const doc of docs) {
    const zone = seaCliffZone(recipe, doc);
    if (!zone || !zoneCliffTile(recipe, zone)) continue;
    if (doc.turf?.zone === zone && doc.turf.cliff === true) continue;
    doc.turf = { ...(doc.turf ?? {}), zone, cliff: true };
    changed.push(`${doc.id ?? "?"}->${zone}`);
  }
  return changed;
}

/** Stretches of a zone with a ground cliff whose wall does not take it (the row's fault; zone-textures re-sets them). */
export function seaCliffTurfFaults(recipe: WorldRecipe): string[] {
  const docs = ((recipe.terrain as { seaCliffs?: SeaCliffLite[] }).seaCliffs ?? []);
  const out: string[] = [];
  for (const doc of docs) {
    const zone = seaCliffZone(recipe, doc);
    if (!zone || !zoneCliffTile(recipe, zone)) continue;
    if (doc.turf?.zone !== zone || doc.turf.cliff !== true) out.push(`sea cliff ${doc.id ?? "?"} does not take ${zone}'s cliff (turf.zone + turf.cliff; re-run zone-textures)`);
  }
  return out;
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
  // a zone with no ground look is not "done" because nothing was declared (firstshore 2026-10-28: the row read ok
  // with an empty cast while zone-1 drew the base tiles and rock-skins failed for want of a zone stone)
  const problems: string[] = [];
  for (const z of recipe.regions.filter((r) => !r.within)) {
    if (z.ground && Object.keys(z.ground).length > 0) continue;
    const row = rows.find((r) => r.zone === z.id);
    problems.push(row ? `${z.id}: palette ${row.palette} has no ground look (authoring/zonegen/palettes/${row.palette}.json)` : `${z.id}: no ground look (no cast row with a palette)`);
  }
  if (wanted.length === 0) return problems.length > 0 ? problems.slice(0, 4).join("; ") : null;
  for (const { row, palette } of wanted) {
    const region = recipe.regions.find((r) => r.id === row.zone);
    if (!region) {
      problems.push(`${row.zone}: no region`);
      continue;
    }
    problems.push(...woodenStreetFaults(palette, row.palette));
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
        // e-paving / i-town 2026-11-02: a designed town's own stone (design.paving) lays its intramural streets with
        // role "none" in the same surface its plan paving paints: those are paved too
        const ownStone = new Set((recipe.features.groundPaints ?? []).filter((g) => g.id.startsWith(`${town}-plan-paving-`)).map((g) => g.surface));
        if (streets.length > 0 && streets.some((r) => r.role !== "paving" && !(r.role === "none" && ownStone.has(r.surface!)))) problems.push(`${town} streets unpaved (town-ground paving --town <name>)`);
      }
    }
  }
  problems.push(...seaCliffTurfFaults(recipe));
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

// ------------------------------------------------------------------ one nested region (a corridor)

interface RegionTexturesInverse {
  world: string;
  region: string;
  created: boolean;
  recipe: { surfaces: unknown; region: unknown; rockSkins: unknown; splat: unknown; zone?: string; zonePalette?: unknown };
  files: Record<string, string | null>;
}

/** The files a region apply may write: the rock-cap materials of the world's scatter rules and the terrain material. */
function touchedFiles(host: ZoneTexturesHost, recipe: WorldRecipe): string[] {
  const out = new Set<string>();
  for (const r of recipe.scatter)
    for (const id of [r.material, r.smallMaterial, r.largeMaterial]) {
      if (!id) continue;
      const f = findAsset(host.project, `materials/${id}.json`) as string | null;
      if (f) out.add(path.resolve(f));
    }
  out.add(path.resolve(path.join(host.assetsRoot(), "materials", `${recipe.material ?? `terrain/${recipe.name}`}.json`)));
  return [...out];
}

/** The ground a nested region draws: its zone's roles, the palette's own roles over them. Pure. */
export function nestedRegionGround(parent: Record<string, string> | undefined, own: Record<string, string>): Record<string, string> {
  return { ...(parent ?? {}), ...own };
}

function commandRegionTextures(host: ZoneTexturesHost, world: string, opt: (n: string) => string): void {
  const { project } = host;
  const id = opt("region");
  const paletteId = opt("palette") || host.fail("--region needs --palette <palette id> (authoring/zonegen/palettes/<id>.json)");
  const palette = readPalette(project, paletteId) ?? host.fail(`no palette ${paletteId} (${path.relative(process.cwd(), paletteFile(project, paletteId))})`);
  const { recipe, file } = host.loadRecipe(world);
  const inverse: RegionTexturesInverse = {
    world,
    region: id,
    created: !recipe.regions.some((r) => r.id === id),
    recipe: {
      surfaces: JSON.parse(JSON.stringify(recipe.surfaces)),
      region: JSON.parse(JSON.stringify(recipe.regions.find((r) => r.id === id) ?? null)),
      rockSkins: JSON.parse(JSON.stringify((recipe as { rockSkins?: unknown }).rockSkins ?? null)),
      splat: (recipe as { splat?: unknown }).splat ?? null,
    },
    files: Object.fromEntries(touchedFiles(host, recipe).map((f) => [f, fs.existsSync(f) ? fs.readFileSync(f, "utf8") : null])),
  };
  let region = recipe.regions.find((r) => r.id === id);
  const polygonText = opt("polygon");
  const polygon = polygonText ? polygonText.split(";").map((p) => p.split(",").map(Number) as [number, number]) : null;
  if (polygon && (polygon.length < 3 || polygon.some((p) => p.length !== 2 || p.some((v) => !Number.isFinite(v))))) host.fail('--polygon "x,z;x,z;x,z..." (3+ points)');
  if (!region) {
    if (!polygon) host.fail(`no region ${id}: give --within <zone> --polygon "x,z;..." to create it (a look-only place region)`);
    const within = opt("within") || host.fail("a new region needs --within <zone>");
    if (!recipe.regions.some((r) => r.id === within)) host.fail(`no zone ${within}`);
    region = { id, name: opt("name") || id, story: "", polygon, landmarks: [], within, tags: ["place"] } as unknown as (typeof recipe.regions)[number];
    // LAST: a place earlier in the list (its own mood, vegetation, cap) keeps winning where the two overlap
    recipe.regions.push(region);
  } else if (polygon) region.polygon = polygon;
  if (!region.within) host.fail(`${id} is a top-level zone: give it its look through the cast (zone-textures --zone)`);
  const parent = recipe.regions.find((r) => r.id === region!.within);
  const own: Record<string, string> = {};
  for (const e of entries(palette)) {
    const png = textureFile(project, e.texture) ?? host.fail(`${paletteId}.${e.role}: texture ${e.texture} not found`);
    const motif = (() => {
      try {
        const im = decodePng(fs.readFileSync(png)) as { width: number; height: number; data: Uint8Array };
        return motifScore(im.width, im.height, im.data);
      } catch {
        return { score: 0 };
      }
    })();
    if (motif.score >= 1) host.fail(`${paletteId}.${e.role}: FAULT tile ${e.texture} has a lone mark (motif ${motif.score}) that repeats into a grid of icons: node tools/texture-swatch.mjs ${path.relative(process.cwd(), png)}`);
    const name = surfaceName(paletteId, e.role);
    const base = recipe.surfaces.find((s) => s.role === e.role);
    const surface = { name, color: averageColor(png), roughness: e.roughness ?? base?.roughness ?? 0.95, map: e.texture, uvScale: e.uvScale ?? base?.uvScale ?? DEFAULT_UV[e.role] ?? 4 };
    const at = recipe.surfaces.findIndex((s) => s.name.toLowerCase() === name.toLowerCase());
    if (at >= 0) recipe.surfaces[at] = surface as (typeof recipe.surfaces)[number];
    else recipe.surfaces.push(surface as (typeof recipe.surfaces)[number]);
    own[e.role] = name;
  }
  const ground = nestedRegionGround(parent?.ground as Record<string, string> | undefined, own);
  const cap = opt("rock-cap");
  const [capRole, capAmount] = cap ? cap.split(":") : ["", ""];
  const zp = zonePalette(recipe, region.id);
  if (zp) {
    const bad = [
      ...paletteRefusals(zp, "cliff", ground["cliff"] ? [ground["cliff"]] : []).map((t) => `cliff ${t}`),
      ...paletteRefusals(zp, "ground", Object.entries(ground).filter(([r]) => r !== "cliff").map(([, s]) => s)).map((t) => `ground ${t}`),
      ...(palette.rockSmall ? paletteRefusals(zp, "rockSmall", [palette.rockSmall]).map((t) => `rockSmall ${t}`) : []),
      ...(palette.rockLarge ? paletteRefusals(zp, "rockLarge", [palette.rockLarge]).map((t) => `rockLarge ${t}`) : []),
      ...(capRole && own[capRole] ? paletteRefusals(zp, "cap", [own[capRole]!]).map((t) => `cap ${t}`) : []),
    ];
    if (bad.length && !host.argv.includes("--extend-palette")) host.fail(`${id}: REFUSED ${bad.join(", ")}: outside zone ${region.within}'s palette (worldgen palette --zone ${region.within} --set ..., or --extend-palette by ruling)`);
    if (bad.length) {
      // by ruling: the corridor's tiles join the zone's palette (one palette per role per ZONE: the corridor is part of it)
      const zone = zoneOf(recipe, region.id)!;
      inverse.recipe.zone = zone.id;
      inverse.recipe.zonePalette = JSON.parse(JSON.stringify(zone.palette ?? null));
      const p = (zone as { palette: Record<string, string[]> }).palette;
      for (const b of bad) {
        const [role, tile] = b.split(" ") as [string, string];
        (p[role] ??= []).includes(tile) || p[role]!.push(tile);
      }
      console.log(`  zone ${zone.id} palette extended: ${bad.join(", ")}`);
    }
  }
  region.ground = ground as typeof region.ground;
  if (opt("band")) (region as { groundBand?: number }).groundBand = Number(opt("band"));
  if (capRole) {
    const layer = own[capRole] ?? host.fail(`--rock-cap ${capRole}: the palette has no ${capRole} tile`);
    (region as { rockCap?: { layer: string; amount: number } }).rockCap = { layer, amount: capAmount ? Number(capAmount) : 0.6 };
  }
  const cliff = own["cliff"];
  const prefer: Record<string, string> = palette.rock && cliff ? { [cliff]: palette.rock } : {};
  const small: Record<string, string> = palette.rockSmall && cliff ? { [cliff]: palette.rockSmall } : {};
  const large: Record<string, string> = palette.rockLarge && cliff ? { [cliff]: palette.rockLarge } : {};
  const slice = opt("rock-slice");
  const assign: Record<string, number> = slice !== "" && cliff ? { [cliff]: Number(slice) } : {};
  recipe.splat = "indexed";
  const inv = opt("inverse");
  // keep the FIRST inverse: a re-run (a repainted tile, a moved polygon) must still undo to the state before the corridor
  if (inv && fs.existsSync(inv)) console.log(`inverse kept: ${inv} (from the first apply)`);
  else if (inv) {
    fs.mkdirSync(path.dirname(inv), { recursive: true });
    fs.writeFileSync(inv, JSON.stringify(inverse, null, 1));
    console.log(`inverse -> ${inv}`);
  }
  writeRockSkinTemplate(project, recipe, prefer, small, large, assign);
  host.writeRecipe(recipe, file);
  host.writeTerrainMaterial(recipe, recipe.material ?? `terrain/${recipe.name}`, true);
  console.log(`  ${id} (within ${region.within}) <- ${paletteId}: ${Object.entries(ground).map(([r, s]) => `${r}=${s}`).join(", ")}${capRole ? `; rockCap ${cap}` : ""}`);
}

function undoRegionTextures(host: ZoneTexturesHost, world: string, invFile: string): void {
  const inv = JSON.parse(fs.readFileSync(invFile, "utf8")) as RegionTexturesInverse;
  if (inv.world !== world) host.fail(`${invFile} is for world ${inv.world}`);
  const { recipe, file } = host.loadRecipe(world);
  recipe.surfaces = inv.recipe.surfaces as typeof recipe.surfaces;
  const at = recipe.regions.findIndex((r) => r.id === inv.region);
  if (inv.created) {
    if (at >= 0) recipe.regions.splice(at, 1);
  } else if (at >= 0) recipe.regions[at] = inv.recipe.region as (typeof recipe.regions)[number];
  if (inv.recipe.zone) {
    const z = recipe.regions.find((r) => r.id === inv.recipe.zone) as { palette?: unknown } | undefined;
    if (z) z.palette = inv.recipe.zonePalette ?? undefined;
  }
  if (inv.recipe.rockSkins === null) delete (recipe as { rockSkins?: unknown }).rockSkins;
  else (recipe as { rockSkins?: unknown }).rockSkins = inv.recipe.rockSkins;
  (recipe as { splat?: unknown }).splat = inv.recipe.splat ?? undefined;
  for (const [f, text] of Object.entries(inv.files)) {
    if (text === null) {
      if (fs.existsSync(f)) fs.rmSync(f);
    } else fs.writeFileSync(f, text);
  }
  host.writeRecipe(recipe, file);
  console.log(`undone: ${inv.region} (${inv.created ? "removed" : "restored"}), ${Object.keys(inv.files).length} file(s) restored`);
}

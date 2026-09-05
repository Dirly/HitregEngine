#!/usr/bin/env tsx
/**
 * worldgen — the world pipeline, one stage per command.
 *
 * ```text
 * init  ->  rivers  ->  towns  ->  paths  ->  pois        ->  (WFC buildings)
 * noise     carve      mark       carve      place
 * ```
 *
 * Every stage reads the recipe, computes something from the CURRENT terrain
 * (which includes every earlier stage's carving), and writes a handful of
 * lines back into `features`. Nothing is baked: the recipe stays a small,
 * diffable, hand-editable JSON document at every step, and the terrain is
 * re-derived from it. Re-run a stage and it replaces its own features; delete
 * a river by hand and the valley closes up again.
 *
 * That is the property that makes the next stage — dropping WFC-generated
 * buildings into towns — tractable: the town pads already exist as data, with
 * a known flat height and radius, before a single building is placed.
 *
 * Usage:
 *   pnpm -F playground worldgen init <world> [--project <name>] [--seed N] [--scene]
 *   pnpm -F playground worldgen rivers <world> [--count 8] [--extent 3000]
 *   pnpm -F playground worldgen towns  <world> [--count 6]
 *   pnpm -F playground worldgen paths  <world>
 *   pnpm -F playground worldgen pois   <world> [--count 12]
 *   pnpm -F playground worldgen canyons <world> [--count 4]
 *   pnpm -F playground worldgen monoliths <world> [--biome desert] [--count 44] [--tallest 150]
 *   pnpm -F playground worldgen map    <world> [--extent 3000] [--size 800] [--cx 0] [--cz 0]
 *   pnpm -F playground worldgen stats  <world> [--cells 9]
 *   pnpm -F playground worldgen all    <world> [--project <name>]
 */

import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import {
  createWorldField,
  defaultWorldRecipe,
  continentalWorldRecipe,
  worldRecipeSchema,
  buildVoxelMesh,
  scatterCell,
  MAX_SURFACES,
  mulberry32,
  type WorldField,
  type WorldRecipe,
  type RiverDoc,
  type CanyonDoc,
  type RoadDoc,
  type TownDoc,
  type PoiDoc,
  type LakeDoc,
  type FillDoc,
  type BridgeDoc,
  type RiverPathDoc,
} from "@hitreg/core";
import { basinFootprint, computeHydrology, extractBasins, extractChannels, simplifyLoop, type Channel, type HydroGrid } from "./worldgen-hydrology.mts";
import { nearestRouteCell, routeBetween, smoothRoute, solveProfile, type RouteGrid, type RouteOptions } from "./worldgen-routing.mts";
import { auditWorld } from "./worldgen-audit.mts";

// ---------------------------------------------------------------- cli plumbing

const argv = process.argv.slice(2);
const command = argv[0] ?? "help";
const worldName = argv[1] && !argv[1].startsWith("--") ? argv[1] : "world";

function flag(name: string): boolean {
  return argv.includes(`--${name}`);
}
function option(name: string, fallback: number): number {
  const i = argv.indexOf(`--${name}`);
  if (i < 0 || i + 1 >= argv.length) return fallback;
  const value = Number(argv[i + 1]);
  return Number.isFinite(value) ? value : fallback;
}
function stringOption(name: string, fallback: string): string {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1]! : fallback;
}

const PLAYGROUND = path.resolve(import.meta.dirname, "..");

/** `--extent`, defaulting to the recipe's world limit (plus a margin) when it has one. */
function extentFor(recipe: WorldRecipe, fallback = 3000): number {
  const limit = recipe.bounds?.limit;
  return option("extent", limit ? Math.ceil((limit + 200) / 100) * 100 : fallback);
}
const project = stringOption("project", "");

/**
 * Where this world's assets live. A project (gitignored, per
 * apps/playground/projects/README.md) is the default home for anything with a
 * game behind it; the flat tree is for throwaway experiments only.
 */
function assetsRoot(): string {
  return project
    ? path.join(PLAYGROUND, "projects", project, "assets")
    : path.join(PLAYGROUND, "assets");
}

function recipePath(name = worldName): string {
  return path.join(assetsRoot(), "worlds", `${name}.json`);
}

/** Read a recipe from either tree — a world may have been created in the other one. */
function findRecipeFile(name: string): string | null {
  const candidates = [recipePath(name), path.join(PLAYGROUND, "assets", "worlds", `${name}.json`)];
  const projects = path.join(PLAYGROUND, "projects");
  if (fs.existsSync(projects)) {
    for (const entry of fs.readdirSync(projects, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        candidates.push(path.join(projects, entry.name, "assets", "worlds", `${name}.json`));
      }
    }
  }
  return candidates.find((file) => fs.existsSync(file)) ?? null;
}

function loadRecipe(name = worldName): { recipe: WorldRecipe; file: string } {
  const file = findRecipeFile(name);
  if (!file) {
    fail(`no world recipe "${name}" — run: worldgen init ${name}${project ? ` --project ${project}` : ""}`);
  }
  const parsed = worldRecipeSchema.safeParse(JSON.parse(fs.readFileSync(file, "utf8")));
  if (!parsed.success) fail(`world recipe ${file} is invalid:\n${parsed.error.message}`);
  return { recipe: parsed.data, file };
}

function writeRecipe(recipe: WorldRecipe, file: string): void {
  // validate BEFORE writing: a stage must never leave a broken world on disk
  const parsed = worldRecipeSchema.safeParse(recipe);
  if (!parsed.success) fail(`refusing to write an invalid recipe:\n${parsed.error.message}`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(parsed.data, null, 2)}\n`);
  console.log(`wrote ${path.relative(process.cwd(), file)}`);
}

function fail(message: string): never {
  console.error(`worldgen: ${message}`);
  process.exit(1);
}

// ---------------------------------------------------------------- init

const HELP = `worldgen — procedural world pipeline

  init   <world>   write a complete starting recipe: continents in a bounded sea, zoned into
                   tundra/taiga/mountains/highlands/grassland/forest/swamp/jungle/desert/badlands/
                   blight (+ terrain & water materials; --scene for a scene; --classic for the old
                   endless-noise world)
  continents <world> re-lay the landmasses (--count 1 --islands 2 --radius 2200 --gap 900
                   --limit auto --land-floor 4 --variation 0.55 --ocean -45)
  rivers <world>   HYDROLOGY: fill depressions, accumulate rain, trace the channel network,
                   fill the LAKES (--lakes 16) and the hollows on the network; rivers are AUTHORED
                   (write { points, width } into features.rivers — the field solves the bed) unless
                   --trace carves the traced network (--catchment 0.12 km² --step 16 --wet-grade 0.02)
  descend <world>  --from x,z: follow the water downhill from a point to the sea, a lake or a pit,
                   and print the valley-floor polyline as --points (--simplify 30 m)
  profile <world>  --points "x,z;…" [--width 14]: ground, grade and bank heights along a route —
                   what to read before writing a river
  towns  <world>   flat, dry, off-the-beach sites near water, spread across the landmasses
  paths  <world>   footpaths between the towns that FOLLOW the ground (--width 2.4 --max-grade 0.18, cut-only,
                   --max-cross 1.0 keeps them off hillsides steeper than 45° — the cut bank would be a wall;
                   --turn-weight 24 --max-turn 1 give them a turning radius, --smooth-passes 2 rounds the corners;
                   --surface dirt, gravel across every snow biome — --surface-by-biome alpine=gravel,… to say which)
  trails <world>   footpaths from the path network up to the peaks (--to peak,cave; --turn-weight 20 --max-turn 1;
                   a summit no 88 % scramble can reach gets a trail to the highest walkable point below it)
  pois   <world>   place landmark points on distinctive ground
  caves  <world>   dig cave systems into steep faces and MEASURE that a player fits
  canyons <world>  cut terraced gorges (--count 6; --zone badlands to keep them in one kind of place)
  monoliths <world> raise rock spires in a zone (--biome desert --count 44 --tallest 150)
  material <world> re-emit the terrain material from the recipe surfaces (after adding textures)
  map    <world>   PNG overview: zones/surfaces, water at every level, rivers, paths, towns, the
                   world limit; --zones colours by zone, --cx/--cz/--extent to zoom
  stats  <world>   zone & biome mix, tris/cell, ms/cell against the frame budget
  river-path <world> add a DRAWN river centreline the rivers stage will solve (--id r1 --points "x,z;x,z;…"
                   --width 18, or --from-scene <scene> --entity <id> to import a path-tool entity; --remove <id>)
  audit  <world>   water & paths: every river ends somewhere, every lake has a river, beds descend,
                   no town or path under water, every bridge has its paths (exit 1 on findings)
  all    <world>   init (if missing) + canyons + rivers + towns + paths + pois + trails + caves + map + stats

Options: --project <name>  --seed N  --extent <world units, default = the world limit>  --count N  --size <px>  --scene`;

function commandInit(): void {
  const file = recipePath();
  if (fs.existsSync(file) && !flag("force")) {
    fail(`${path.relative(process.cwd(), file)} already exists (pass --force to overwrite)`);
  }
  const seed = option("seed", 1337);
  const material = `terrain/${worldName}`;
  const waterMaterial = `terrain/${worldName}-water`;
  const preset = flag("classic") ? defaultWorldRecipe() : continentalWorldRecipe();
  const recipe = worldRecipeSchema.parse({
    ...preset,
    name: worldName,
    seed,
    material,
    waterMaterial,
    scatter: defaultScatter(),
  });
  writeRecipe(recipe, file);
  writeTerrainMaterial(recipe, material);
  writeWaterMaterial(recipe, waterMaterial);
  if (flag("scene")) writeScene(recipe);
  const limit = recipe.bounds?.limit;
  console.log(
    `\nworld: ${recipe.bounds ? `${recipe.bounds.continents.length} landmasses, limit ${limit}m` : "endless"}, ` +
      `${recipe.climate.zones ? `${recipe.climate.zones.anchors.length} zone kinds` : "noise climate"}\n` +
      `next:\n  worldgen rivers ${worldName}${project ? ` --project ${project}` : ""}\n` +
      `  worldgen towns ${worldName}\n  worldgen paths ${worldName}\n  worldgen trails ${worldName}\n  worldgen map ${worldName}`,
  );
}

/**
 * Starter scatter rules. They reference prefabs that may not exist yet, which
 * is deliberate: an unresolvable prefab renders nothing and warns, so the
 * world is walkable before there is a single tree asset, and populating it is
 * a matter of dropping prefabs in at those ids.
 */
function defaultScatter(): unknown[] {
  return [
    {
      id: "pine",
      prefab: "trees/pine",
      biomes: ["grassland", "forest", "foothills", "taiga", "highland"],
      // nothing scatters below the waterline: the seabed is ordinary ground to
      // the solver, so without a floor here boulders and shrubs grow in the sea
      height: [1, 1400],
      density: 0.012,
      slopeMax: 0.42,
      scale: [0.85, 1.35],
      jitter: 0.85,
      clearance: 4,
      collider: "cylinder",
      colliderSize: [0.6, 6, 0.6],
    },
    {
      id: "boulder",
      prefab: "rocks/boulder",
      biomes: [],
      height: [0.8, 1400],
      density: 0.004,
      slopeMax: 0.75,
      scale: [0.6, 1.8],
      alignToNormal: 0.7,
      yOffset: -0.35,
      jitter: 0.95,
      // Nothing scatters onto a road, a river or a town square. `clearance` is
      // measured from the feature's EDGE, so this is metres of verge — and a
      // boulder in the middle of the highway is the single most obvious way a
      // generated world announces that nothing was thought about.
      clearance: 3.5,
      collider: "box",
      colliderSize: [1.4, 1.2, 1.4],
    },
    {
      id: "shrub",
      prefab: "plants/shrub",
      biomes: ["grassland", "beach", "desert", "forest", "jungle", "swamp", "badlands"],
      height: [0.6, 1400],
      density: 0.03,
      slopeMax: 0.5,
      scale: [0.7, 1.2],
      jitter: 1,
      clearance: 2.5,
      collider: "none",
    },
    {
      // A quarter of the meadow's tree density and nothing else: the blight
      // reads as blighted because it is EMPTY, not because the trees in it
      // are a different colour. Sparse standing deadwood is what sells that
      // the emptiness is a loss rather than a plain.
      id: "deadtree",
      prefab: "trees/dead",
      biomes: ["blight"],
      height: [1, 1400],
      density: 0.003,
      slopeMax: 0.45,
      scale: [0.8, 1.4],
      jitter: 1,
      clearance: 4,
      collider: "cylinder",
      colliderSize: [0.5, 5, 0.5],
    },
  ];
}

/**
 * The terrain material for a recipe: one splat layer per surface, weights read
 * from the mesh's own vertices. Textures are left unset — drop image ids into
 * `splat.layers[i].map` and the shader picks them up triplanar, no other
 * change needed.
 */
function writeTerrainMaterial(recipe: WorldRecipe, id: string, force = false): void {
  const file = path.join(assetsRoot(), "materials", `${id}.json`);
  if (fs.existsSync(file) && !force && !flag("force")) {
    console.log(`kept existing material ${path.relative(process.cwd(), file)}`);
    return;
  }
  const doc = {
    shader: "terrain-splat",
    color: "#ffffff",
    roughness: 0.95,
    metalness: 0,
    filter: recipe.textureFilter,
    splat: {
      source: "vertex",
      tintByVertexColor: true,
      layers: recipe.surfaces.map((surface) => ({
        // A textured layer tints WHITE so the texture reads as painted; the
        // surface's own colour stays in the recipe as the fallback (and as
        // what `worldgen map` draws the overview with). Multiplying a green
        // tint over an already-green grass texture is the usual reason
        // textured terrain comes out oversaturated.
        color: surface.map ? "#ffffff" : surface.color,
        roughness: surface.roughness,
        uvScale: surface.uvScale,
        ...(surface.map ? { map: surface.map } : {}),
        ...(surface.normalMap ? { normalMap: surface.normalMap } : {}),
      })),
      ...(recipe.macroNoise ? { macroNoise: recipe.macroNoise } : {}),
    },
  };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(doc, null, 2)}\n`);
  console.log(`wrote ${path.relative(process.cwd(), file)}  (layer order: ${recipe.surfaces.map((s) => s.name).join(", ")})`);
}

/**
 * The ocean surface. Without it a world with a sea level has visible seabed
 * where the water should be, which reads as a bug rather than as an ocean —
 * and the depth-faded water shader needs real geometry beneath it to read
 * depth against, which generated terrain provides for free.
 */
function writeWaterMaterial(recipe: WorldRecipe, id: string): void {
  const file = path.join(assetsRoot(), "materials", `${id}.json`);
  if (fs.existsSync(file) && !flag("force")) return;
  const doc = {
    shader: "water",
    color: "#2f7fa8",
    transparent: true,
    opacity: 0.9,
    water: {
      // deep enough that a shelf reads as a gradient rather than as dark blotches
      depthFadeDistance: 30,
      foamWidth: 1.2,
      waveAmplitude: 0.12,
      waveFrequency: 0.18,
      // an ocean plane is thousands of units across, so the shader's default
      // 400/600 edge fade would dissolve it a few steps from shore
      edgeFadeStart: 2600,
      edgeFadeEnd: 3600,
    },
  };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(doc, null, 2)}\n`);
  console.log(`wrote ${path.relative(process.cwd(), file)}`);
}

/**
 * Standing swamp water: murky, nearly opaque, barely moving, no foam line. The
 * clear-water shader with its depth fade reads as a mountain tarn; a bog
 * pool that lets you see the bottom is not a bog pool.
 */
function writeSwampWaterMaterial(recipe: WorldRecipe, id: string): void {
  const file = path.join(assetsRoot(), "materials", `${id}.json`);
  if (fs.existsSync(file)) return;
  const doc = {
    shader: "water",
    color: "#3d4a2c",
    transparent: true,
    opacity: 0.97,
    water: {
      depthFadeDistance: 1.2,
      foamWidth: 0.15,
      waveAmplitude: 0.02,
      waveFrequency: 0.35,
      edgeFadeStart: 2600,
      edgeFadeEnd: 3600,
    },
  };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(doc, null, 2)}\n`);
  console.log(`wrote ${path.relative(process.cwd(), file)}  (swamp water)`);
  void recipe;
}

/**
 * The river ribbons' material: the standing-water material with
 * `flowMode: "channel"`, so waves, texture and foam run along the ribbon at
 * the speed the chunk emitter wrote into its `flow` attribute. Copies the
 * base material's texture, preferring a `<Name>Flowing` sibling when the
 * project has one (a moving-water tile beside a still one), at a tighter
 * tile because a channel is metres wide, not kilometres. Rewritten whenever
 * the rivers stage runs, so a change to the base water carries over.
 */
/** A copy of a water material with a few fields overridden; rewritten every run so the base carries over. */
function writeDerivedWaterMaterial(baseId: string, id: string, overrides: Record<string, unknown>, label: string): void {
  const root = assetsRoot();
  const file = path.join(root, "materials", `${id}.json`);
  let base: { color?: string; opacity?: number; water?: Record<string, unknown> } = {};
  try {
    base = JSON.parse(fs.readFileSync(path.join(root, "materials", `${baseId}.json`), "utf8")) as typeof base;
  } catch {
    // no base material yet: the defaults stand
  }
  const doc = {
    shader: "water",
    color: base.color ?? "#2f7fa8",
    transparent: true,
    opacity: base.opacity ?? 0.9,
    water: { ...(base.water ?? {}), ...overrides },
  };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(doc, null, 2)}\n`);
  console.log(`wrote ${path.relative(process.cwd(), file)}  (${label})`);
}

function writeRiverWaterMaterial(baseId: string, id: string): void {
  const root = assetsRoot();
  const file = path.join(root, "materials", `${id}.json`);
  const baseFile = path.join(root, "materials", `${baseId}.json`);
  let base: { color?: string; opacity?: number; water?: Record<string, unknown> } = {};
  try {
    base = JSON.parse(fs.readFileSync(baseFile, "utf8")) as typeof base;
  } catch {
    // no base material yet: the defaults below stand on their own
  }
  let texture = base.water?.["texture"] as string | undefined;
  if (texture) {
    const flowing = texture.replace(/(\.[a-z0-9]+)$/i, "Flowing$1");
    if (flowing !== texture && fs.existsSync(path.join(root, "textures", flowing))) texture = flowing;
  }
  const doc = {
    shader: "water",
    color: base.color ?? "#2f7fa8",
    transparent: true,
    opacity: base.opacity ?? 0.9,
    water: {
      ...(base.water ?? {}),
      flowMode: "channel",
      // a river is a few metres deep at most: the depth ramp must turn
      // over inside it or every channel reads as the shallowest band
      depthFadeDistance: 4,
      foamWidth: 0.6,
      // the current itself makes the motion; big standing waves on a
      // narrow channel look like a shaken tray, and a crisp two-step foam
      // band along the ribbon's edge read as a painted white rectangle
      waveAmplitude: 0.03,
      waveFrequency: 0.5,
      waveSpeed: 1.2,
      foamSteps: 3,
      foamPixel: 0.7,
      displace: false,
      ...(texture ? { texture, textureScale: 7 } : {}),
    },
  };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(doc, null, 2)}\n`);
  console.log(`wrote ${path.relative(process.cwd(), file)}  (river water)`);
}

/** Point-in-polygon (even-odd) for a closed XZ outline. */
/** Distance from (x, z) to the nearest edge of a closed polygon. */
function polygonDistance(points: readonly (readonly [number, number])[], x: number, z: number): number {
  let best = Infinity;
  for (let i = 0; i < points.length; i++) {
    const a = points[i]!;
    const b = points[(i + 1) % points.length]!;
    best = Math.min(best, pointSegmentDistance([x, z], [a[0], a[1]], [b[0], b[1]]));
  }
  return best;
}

function pointInPolygon(points: readonly (readonly [number, number])[], x: number, z: number): boolean {
  let inside = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const a = points[i]!;
    const b = points[j]!;
    if (a[1] > z !== b[1] > z && x < ((b[0] - a[0]) * (z - a[1])) / (b[1] - a[1]) + a[0]) inside = !inside;
  }
  return inside;
}

/**
 * Slide each vertex of a traced lake outline along its outward normal to
 * where the ground crosses the water level.
 *
 * The outline comes off the hydrology grid — cell corners, then simplified
 * — so it can sit a cell inside the true waterline or a cell up the bank.
 * The field no longer carves from the polygon (it trusts the basin the
 * terrain already has), so the polygon's only job is to say where the sheet
 * is drawn and where the wet band is, and for that it should be the shore
 * of THIS terrain: a vertex under water walks out until the ground rises
 * through the surface, a dry vertex walks in until it finds water, and the
 * crossing is bisected. The walk is bounded by a cell and by half the
 * distance to each neighbour so the loop cannot fold over itself.
 */
function refineShoreline(outline: [number, number][], waterY: number, field: WorldField, step: number): [number, number][] {
  const n = outline.length;
  if (n < 4) return outline;
  const out = outline.map((p) => [p[0], p[1]] as [number, number]);
  for (let i = 0; i < n; i++) {
    const prev = outline[(i - 1 + n) % n]!;
    const next = outline[(i + 1) % n]!;
    const p = outline[i]!;
    let nx = next[1] - prev[1];
    let nz = -(next[0] - prev[0]);
    const len = Math.hypot(nx, nz);
    if (len < 1e-6) continue;
    nx /= len;
    nz /= len;
    if (pointInPolygon(outline, p[0] + nx * 2, p[1] + nz * 2)) {
      nx = -nx;
      nz = -nz;
    }
    const reach = Math.min(
      step * 0.9,
      0.45 * Math.min(Math.hypot(p[0] - prev[0], p[1] - prev[1]), Math.hypot(next[0] - p[0], next[1] - p[1])),
    );
    if (reach < 1) continue;
    const h = (s: number): number => field.height(p[0] + nx * s, p[1] + nz * s);
    let lo = NaN;
    let hi = NaN;
    if (h(0) < waterY) {
      for (let s = 1; s <= reach; s += 1) {
        if (h(s) >= waterY) {
          lo = s - 1;
          hi = s;
          break;
        }
      }
    } else {
      for (let s = -1; s >= -reach; s -= 1) {
        if (h(s) < waterY) {
          lo = s;
          hi = s + 1;
          break;
        }
      }
    }
    if (Number.isNaN(lo)) continue;
    for (let k = 0; k < 4; k++) {
      const mid = (lo + hi) / 2;
      if (h(mid) < waterY) lo = mid;
      else hi = mid;
    }
    const s = (lo + hi) / 2;
    out[i] = [round(p[0] + nx * s), round(p[1] + nz * s)];
  }
  return out;
}

/** Nearest point on a swung channel to `p`, with the bed interpolated there. */
function nearestOnSwung(
  points: readonly (readonly [number, number])[],
  bed: readonly number[],
  p: readonly [number, number],
  depths?: readonly number[],
): { point: [number, number]; bed: number; depth: number } | null {
  let best: { point: [number, number]; bed: number; depth: number; d: number } | null = null;
  for (let i = 0; i + 1 < points.length; i++) {
    const a = points[i]!;
    const b = points[i + 1]!;
    const dx = b[0] - a[0];
    const dz = b[1] - a[1];
    const l = dx * dx + dz * dz;
    const t = l < 1e-9 ? 0 : Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dz) / l));
    const x = a[0] + dx * t;
    const z = a[1] + dz * t;
    const d = Math.hypot(p[0] - x, p[1] - z);
    if (!best || d < best.d) {
      const depth = depths ? depths[i]! + (depths[i + 1]! - depths[i]!) * t : NaN;
      best = { point: [x, z], bed: bed[i]! + (bed[i + 1]! - bed[i]!) * t, depth, d };
    }
  }
  return best ? { point: best.point, bed: best.bed, depth: best.depth } : null;
}

/** A plain opaque material, for the player capsule and other markers. */
function writeFlatMaterial(id: string, color: string): void {
  const file = path.join(assetsRoot(), "materials", `${id}.json`);
  if (fs.existsSync(file) && !flag("force")) return;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(
    file,
    `${JSON.stringify({ shader: "standard", color, roughness: 0.6, metalness: 0 }, null, 2)}\n`,
  );
}

/**
 * Somewhere worth starting: a town if the world has one (flat, coastal, with
 * roads leading out of it), else the first patch of gentle dry land found
 * spiralling out from the origin.
 */
function pickSpawn(field: WorldField, recipe: WorldRecipe): [number, number] {
  const town = recipe.features.towns[0];
  if (town) return [town.center[0], town.center[1]];
  for (let r = 0; r < 4000; r += 60) {
    for (let a = 0; a < 12; a++) {
      const angle = (a / 12) * Math.PI * 2;
      const x = Math.cos(angle) * r;
      const z = Math.sin(angle) * r;
      if (field.height(x, z) > recipe.seaLevel + 3 && field.slope(x, z) < 0.3) return [x, z];
    }
  }
  return [0, 0];
}

/** A minimal scene that streams the world: sun, sky, ocean, voxelWorld. */
function writeScene(recipe: WorldRecipe): void {
  const file = path.join(assetsRoot(), "scenes", `${recipe.name}.scene.json`);
  if (fs.existsSync(file) && !flag("force")) {
    console.log(`kept existing scene ${path.relative(process.cwd(), file)}`);
    return;
  }
  const waterMaterial = `terrain/${recipe.name}-water`;
  writeWaterMaterial(recipe, waterMaterial);
  const playerMaterial = `terrain/${recipe.name}-player`;
  writeFlatMaterial(playerMaterial, "#d8643c");
  const field = createWorldField(recipe);
  // Spawn on real land, not at the origin — the origin is as likely to be open
  // ocean as anything else, and a player that starts underwater tells you
  // nothing about how the world streams.
  const [spawnX, spawnZ] = pickSpawn(field, recipe);
  // the sea reaches the world limit and a little past it, never short of it
  const oceanSize = recipe.bounds?.limit ? Math.ceil((recipe.bounds.limit + 1200) * 2) : 7000;
  const spawnY = (field.surfaceCast(spawnX, spawnZ) ?? field.height(spawnX, spawnZ)) + 2;
  const doc = {
    version: 1,
    name: recipe.name,
    entities: {
      world: {
        name: "World",
        parent: null,
        tags: ["world"],
        components: { voxelWorld: { world: recipe.name } },
      },
      sky: {
        name: "Sky",
        parent: null,
        tags: [],
        components: { sky: { preset: "day" } },
      },
      sun: {
        name: "Sun",
        parent: null,
        tags: [],
        components: {
          transform: { position: [40, 90, 30] },
          light: { kind: "directional", intensity: 1.6, castShadow: true },
        },
      },
      ambient: {
        name: "Ambient",
        parent: null,
        tags: [],
        components: { light: { kind: "ambient", intensity: 0.55 } },
      },
      ocean: {
        name: "Ocean",
        parent: null,
        tags: ["water"],
        components: {
          transform: { position: [0, recipe.seaLevel, 0] },
          mesh: {
            // subdivided: the water shader displaces vertices, and a bare quad
            // has nothing for it to move
            source: { kind: "primitive", shape: "plane", size: [oceanSize, 1, oceanSize], segments: [180, 180] },
            material: waterMaterial,
            castShadow: false,
            receiveShadow: false,
          },
        },
      },
      // A capsule you can actually walk around on, so streaming can be judged
      // at gameplay speed rather than at fly-cam speed — they stress it very
      // differently, and the one that matters is the one the player does.
      player: {
        name: "Player",
        parent: null,
        tags: ["player"],
        components: {
          transform: { position: [spawnX, spawnY, spawnZ] },
          mesh: {
            source: { kind: "primitive", shape: "capsule", size: [0.8, 1.8, 0.8], segments: [10, 5] },
            material: playerMaterial,
            castShadow: true,
          },
          rigidbody: {
            kind: "dynamic",
            // an upright capsule that is free to spin will tip over the first
            // time it clips a rock and then roll away downhill
            lockRotations: true,
            ccd: true,
            linearDamping: 0.1,
          },
          collider: { shape: "capsule", size: [0.8, 1.8, 0.8], friction: 0.4 },
          script: { name: "player-controller", params: { speed: 5, jump: 6 } },
        },
      },
      camera: {
        name: "Camera",
        parent: null,
        tags: [],
        components: {
          transform: { position: [spawnX + 6, spawnY + 4, spawnZ + 6] },
          camera: {
            active: true,
            fov: 65,
            far: 4000,
            rig: { mode: "follow", targetTag: "player", distance: 7, height: 3 },
          },
        },
      },
      spawn: {
        name: "Spawn",
        parent: null,
        tags: ["spawn"],
        components: { transform: { position: [spawnX, spawnY, spawnZ] } },
      },
    },
  };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(doc, null, 2)}\n`);
  console.log(`wrote ${path.relative(process.cwd(), file)}`);
}

// ---------------------------------------------------------------- height grid
//
// Every downstream stage needs the same thing: the current terrain, sampled
// coarsely enough to search over. Sampling it once and sharing it is the
// difference between a stage taking a second and taking a minute.

interface HeightGrid {
  /** World-space extent, centred on the origin. */
  extent: number;
  /** Samples per axis. */
  n: number;
  step: number;
  height: Float32Array;
  slope: Float32Array;
  at(ix: number, iz: number): number;
  worldX(ix: number): number;
  worldZ(iz: number): number;
  nearest(x: number, z: number): [number, number];
}

function sampleGrid(field: WorldField, extent: number, n: number): HeightGrid {
  const step = (extent * 2) / (n - 1);
  const height = new Float32Array(n * n);
  const slope = new Float32Array(n * n);
  for (let iz = 0; iz < n; iz++) {
    for (let ix = 0; ix < n; ix++) {
      height[ix + iz * n] = field.height(-extent + ix * step, -extent + iz * step);
    }
  }
  // slope from the grid itself rather than four more field calls per sample
  for (let iz = 0; iz < n; iz++) {
    for (let ix = 0; ix < n; ix++) {
      const x0 = height[Math.max(0, ix - 1) + iz * n]!;
      const x1 = height[Math.min(n - 1, ix + 1) + iz * n]!;
      const z0 = height[ix + Math.max(0, iz - 1) * n]!;
      const z1 = height[ix + Math.min(n - 1, iz + 1) * n]!;
      const g = Math.hypot((x1 - x0) / (2 * step), (z1 - z0) / (2 * step));
      slope[ix + iz * n] = g / Math.sqrt(1 + g * g);
    }
  }
  return {
    extent,
    n,
    step,
    height,
    slope,
    at: (ix, iz) => height[clampIndex(ix, n) + clampIndex(iz, n) * n]!,
    worldX: (ix) => -extent + ix * step,
    worldZ: (iz) => -extent + iz * step,
    nearest: (x, z) => [
      clampIndex(Math.round((x + extent) / step), n),
      clampIndex(Math.round((z + extent) / step), n),
    ],
  };
}

function clampIndex(v: number, n: number): number {
  return v < 0 ? 0 : v >= n ? n - 1 : v;
}

/** RDP tolerances, in GRID INDEX units. Bigger = fewer, straighter control points. */
const RIVER_SIMPLIFY = 1.6;
const ROAD_SIMPLIFY = 0.9;

/**
 * How many world units of HEIGHT error count as one grid cell of plan error
 * when simplifying a route (see simplify3). Small = keep more vertical detail.
 * 2 means a 2 m bump is worth a control point.
 */
const ROAD_HEIGHT_WEIGHT = 2;
const RIVER_HEIGHT_WEIGHT = 3;

const NEIGHBORS: readonly [number, number][] = [
  [1, 0], [-1, 0], [0, 1], [0, -1],
  [1, 1], [1, -1], [-1, 1], [-1, -1],
];

// ---------------------------------------------------------------- rivers

/** One zone-aware sample of the world on a square grid, for the water and road stages. */
interface WorldGridSample extends HydroGrid {
  worldX(ix: number): number;
  worldZ(iz: number): number;
  nearest(x: number, z: number): number;
  /** Zone flatten (swampiness) per cell, 0..1. */
  swamp: Float32Array;
  /** Zone dune multiplier per cell. */
  dunes: Float32Array;
  /** Signed shore distance per cell (Infinity without bounds). */
  shore: Float32Array;
  /** Strongest zone anchor index per cell, -1 without zones or at sea. */
  zone: Int16Array;
  /** Anchor ids, indexed by `zone`. */
  anchorIds: string[];
}

function sampleWorldGrid(field: WorldField, extent: number, step: number): WorldGridSample {
  const n = Math.max(16, Math.round((extent * 2) / step) + 1);
  const actualStep = (extent * 2) / (n - 1);
  const total = n * n;
  const height = new Float32Array(total);
  const rain = new Float32Array(total);
  const swamp = new Float32Array(total);
  const dunes = new Float32Array(total);
  const shore = new Float32Array(total);
  const zoneIndex = new Int16Array(total).fill(-1);
  const recipe = field.recipe;
  const anchors = recipe.climate.zones?.anchors ?? [];
  const anchorIds = anchors.map((a) => a.id);
  const limit = field.worldLimit;
  const t0 = performance.now();
  for (let iz = 0; iz < n; iz++) {
    const z = -extent + iz * actualStep;
    for (let ix = 0; ix < n; ix++) {
      const x = -extent + ix * actualStep;
      const i = ix + iz * n;
      if (limit !== Infinity && x * x + z * z > (limit + 300) ** 2) {
        height[i] = recipe.bounds?.oceanFloor ?? -45;
        rain[i] = 0;
        shore[i] = -Infinity;
        continue;
      }
      const h = field.height(x, z);
      height[i] = h;
      shore[i] = field.shoreDistance(x, z);
      if (h < recipe.seaLevel) {
        rain[i] = 0;
        continue;
      }
      const c = field.climate(x, z);
      rain[i] = 0.15 + 0.85 * c.moisture;
      if (anchors.length > 0) {
        const zone = field.zone(x, z);
        let f = 0;
        let d = 0;
        for (let a = 0; a < anchors.length; a++) {
          f += zone.weights[a]! * anchors[a]!.flatten;
          d += zone.weights[a]! * anchors[a]!.dunes;
        }
        swamp[i] = f;
        dunes[i] = d;
        zoneIndex[i] = anchorIds.indexOf(zone.id);
      }
    }
  }
  console.log(`  sampled ${n}x${n} grid at ${actualStep.toFixed(1)}m in ${((performance.now() - t0) / 1000).toFixed(1)}s`);
  return {
    n,
    step: actualStep,
    extent,
    height,
    rain,
    swamp,
    dunes,
    shore,
    zone: zoneIndex,
    anchorIds,
    seaLevel: recipe.seaLevel,
    worldX: (ix) => -extent + ix * actualStep,
    worldZ: (iz) => -extent + iz * actualStep,
    nearest: (x, z) => clampIndex(Math.round((x + extent) / actualStep), n) + clampIndex(Math.round((z + extent) / actualStep), n) * n,
  };
}

/**
 * Rivers and lakes from real drainage — see worldgen-hydrology.mts.
 *
 * Every river is where enough rain-weighted upstream area coincides; every
 * lake is a depression the filling had to raise to make the surface drain.
 * A river therefore has tributaries that end where they join, a bed that
 * only ever descends, a width that grows with its catchment, a lake wherever
 * the ground made one, and a WATERFALL wherever the bed drops a cliff's worth
 * in one step — none of it placed, all of it derived.
 */
function commandRivers(): void {
  const { recipe, file } = loadRecipe();
  /**
   * LAKES ONLY, unless --trace. The traced network is what the hydrology
   * finds; it is not what a level designer draws. Rivers are AUTHORED now —
   * a person with the path tool, or an agent writing `{ points, width }`
   * straight into `features.rivers` (the field solves the bed, see
   * field.ts solveRiverBeds) — and this stage's job is the lakes and the
   * valley-floor fills the hydrology is good at. The channel tree is still
   * computed: it decides which hollows are lakes.
   */
  const traceRivers = flag("trace");
  // hand-written rivers (no bedY: the field solves them) are the author's,
  // and survive every re-run of this stage; drawn paths are re-solved
  const handRivers = recipe.features.rivers.filter((r) => !r.bedY || r.bedY.length !== r.points.length);
  // this stage replaces its own features: sample the world WITHOUT them
  recipe.features.rivers = [];
  recipe.features.lakes = [];
  recipe.features.fills = [];
  recipe.features.pois = recipe.features.pois.filter((p) => p.kind !== "falls");
  // and WITHOUT the features that come after water: towns, roads and bridges
  // are re-run once the rivers move, and sampling drainage over the old
  // road embankments and town pads made every re-run drift from the last
  const field = createWorldField({ ...recipe, features: { ...recipe.features, towns: [], roads: [], bridges: [] } });
  const extent = extentFor(recipe);
  const step = option("step", 16);
  const grid = sampleWorldGrid(field, extent, step);
  const cellArea = grid.step * grid.step;
  const catchmentKm2 = option("catchment", 0.12);
  const threshold = (catchmentKm2 * 1e6) / cellArea;

  const t0 = performance.now();
  const hydro = computeHydrology(grid);
  console.log(`  filled depressions and accumulated flow in ${((performance.now() - t0) / 1000).toFixed(1)}s`);
  const channels: AuthoredChannel[] = extractChannels(grid, hydro, threshold, Math.max(6, Math.round(120 / grid.step)));
  // Drawn rivers (the path tool, or an agent writing points) join the
  // network as channels of their own: densified to the grid, snapped to the
  // nearest cells so every lookup below works, solved and carved exactly
  // like a traced one — the land is shaped to them, not the other way round.
  for (const path of recipe.features.riverPaths) {
    const dense = densifyPolyline(path.points, grid.step * 0.5);
    const cells = dense.map((p) => grid.nearest(p[0], p[1]));
    if (cells.length < 2) continue;
    channels.push({ cells, size: hydro.accumulation[cells[cells.length - 1]!]!, joins: -1, authored: { path, points: dense } });
  }
  if (recipe.features.riverPaths.length > 0) console.log(`  ${recipe.features.riverPaths.length} drawn river paths join the network`);
  const allBasins = extractBasins(grid, hydro, option("lake-depth", 1.0), Math.max(8, Math.round(3500 / cellArea)));
  // RIVERS FIRST. A basin is a lake only if the channel network runs
  // through it: the outlet channel leaves it, so every lake drawn has a
  // river leaving it, and most have one arriving. Every other depression
  // the fill found — a pit in the noise whose whole catchment is too small
  // to make a stream — stays what it is, a dry hollow in the ground. The
  // old rule kept the biggest N basins whether or not any river went near
  // them, and the map was covered in ponds no river visited (45 of 64).
  const onChannel = new Uint8Array(grid.n * grid.n);
  for (const channel of channels) for (const c of channel.cells) onChannel[c] = 1;
  const basins = allBasins.filter((basin) => basin.cells.some((c) => onChannel[c] === 1));
  /** Lowest channel cell inside each kept basin: where its water must be if it is drained. */
  const channelLow = basins.map((basin) => {
    let low = -1;
    for (const c of basin.cells) if (onChannel[c] === 1 && (low < 0 || grid.height[c]! < grid.height[low]!)) low = c;
    return low;
  });
  /**
   * The filled surface at the MOUTH of each basin's outlet channel (the
   * channel that runs through the basin and ends outside it), -Infinity
   * when that mouth is the sea. A drained lake can never sit below the
   * river its outlet joins: the outlet's bed is solved from that mouth
   * upward, so a lake lowered under the confluence got an outlet that left
   * it fourteen metres above the water.
   */
  const outletMouthFilled = basins.map((basin) => {
    const member = new Set(basin.cells);
    let worst = -Infinity;
    for (const channel of channels) {
      if (!channel.cells.some((c) => member.has(c))) continue;
      const mouth = channel.cells[channel.cells.length - 1]!;
      if (member.has(mouth)) continue; // a tributary ending in this lake
      worst = Math.max(worst, hydro.sea[mouth] ? -Infinity : hydro.filled[mouth]!);
    }
    return worst;
  });
  console.log(`  ${allBasins.length} depressions, ${basins.length} on the channel network (the rest stay dry hollows)`);

  // Lakes first, so river beds can be checked against them. A basin bigger
  // than --max-lake (km²) is DRAINED: its surface is lowered to a few metres
  // over its floor and the outlet river is cut down through the sill to
  // match, so an inland sea the size of a province becomes a lake with a
  // gorge leaving it — which is what the big bowls in the noise turn into
  // once water has had a few thousand years at them.
  /** First of the wanted surface names the palette actually has, or "" (paints nothing). */
  const paletteSurface = (...wanted: string[]): string => wanted.find((n) => recipe.surfaces.some((sf) => sf.name === n)) ?? "";
  const lakeSurface = stringOption("lake-surface", paletteSurface("wetsand", "sand"));
  const riverSurface = stringOption("surface", paletteSurface("gravel", "sand"));
  const maxLakes = Math.round(option("lakes", 16));
  /**
   * Connected hollows that are not kept as lakes are FILLED: raised to
   * their spill level so the river cuts a channel through a flat valley
   * floor. This is what "start with the rivers and shape the land around
   * them" means here — the drainage the fill computed becomes the ground.
   */
  const fills: FillDoc[] = [];
  const fillBasin = (basin: (typeof basins)[number]): void => {
    const outline = simplifyLoop(basin.outline, 0.6, 80).map(
      ([cx, cz]) => [round(grid.worldX(cx) - grid.step / 2), round(grid.worldZ(cz) - grid.step / 2)] as [number, number],
    );
    if (outline.length < 4) return;
    fills.push({ id: `fill-${fills.length + 1}`, polygon: outline, y: round(basin.level + 0.35), bank: 12, tags: [] });
  };
  const maxLakeArea = option("max-lake", 0.12) * 1e6;
  const lakeFill = option("lake-fill", 9);
  const lakes: LakeDoc[] = [];
  /** Water level per basin index, after draining. */
  const basinLevel = new Map<number, number>();
  /** Every cell of a kept basin, shallows and drained bowl included: where a river bed answers to the lake's level. */
  const basinCells = new Map<number, Set<number>>();
  /** Only the cells under the water that is actually drawn. */
  const wetCells = new Map<number, Set<number>>();
  let drained = 0;
  // Which basin a basin drains INTO, so a drained lake is never lowered under
  // the water it flows out to. Draining used to lower a big basin to a few
  // metres over its floor regardless of what lay downstream; where that
  // floor sat below the NEXT lake's spill level the river between them ran
  // uphill — it left one lake fourteen metres under the surface of the one
  // it arrived in, and arrived under water. Levels are settled downstream
  // first: a drained lake sits at least a metre and a half over the lake (or
  // the sea) its outlet reaches.
  const basinIndexOf = new Int32Array(grid.n * grid.n).fill(-1);
  basins.forEach((basin, index) => {
    for (const c of basin.cells) basinIndexOf[c] = index;
  });
  const receivingBasin = (index: number): number => {
    let cur = basins[index]!.outlet;
    let guard = 0;
    while (cur >= 0 && guard++ < grid.n * grid.n) {
      const b = basinIndexOf[cur]!;
      if (b >= 0 && b !== index) return b;
      cur = hydro.downstream[cur]!;
    }
    return -1;
  };
  const settled = new Map<number, number>();
  const settleLevel = (index: number, hops = 0): number => {
    const known = settled.get(index);
    if (known !== undefined) return known;
    const basin = basins[index]!;
    let waterY = basin.level;
    // sized by its DEEP cells: the shallows are shore, and counting them
    // would drain every lake with a gentle shelf
    if (basin.deep * cellArea > maxLakeArea) {
      const into = hops < 64 ? receivingBasin(index) : -1;
      const floorLevel = Math.max(into >= 0 ? settleLevel(into, hops + 1) + 1.5 : recipe.seaLevel + 1, outletMouthFilled[index]! + 0.6);
      // drained to a few metres over the floor UNDER THE RIVER, not the
      // basin's deepest side bowl, so the water that stays is on the channel
      const low = channelLow[index]!;
      const floor = low >= 0 ? Math.max(basin.floor, grid.height[low]!) : basin.floor;
      // never above its own spill level: a lake that cannot be drained
      // below what waits downstream simply is not drained
      waterY = Math.min(basin.level, Math.max(floor + lakeFill, floorLevel));
    }
    settled.set(index, waterY);
    return waterY;
  };
  let raised = 0;
  /** Basin index per written lake, for the diagnostics at the end. */
  const lakeBasin: number[] = [];
  basins.forEach((basin, index) => {
    if (lakes.length >= maxLakes) {
      fillBasin(basin);
      return;
    }
    const waterY = settleLevel(index);
    let footprint: { cells: number[]; outline: [number, number][]; centroid: [number, number] } | null = {
      cells: basin.cells,
      outline: basin.outline,
      centroid: basin.centroid,
    };
    if (waterY < basin.level - 1e-6) {
      footprint = basinFootprint(grid, basin, waterY, channelLow[index]!);
      drained++;
      if (waterY > basin.floor + lakeFill + 1e-6) raised++;
      if (!footprint || footprint.cells.length < 8) {
        fillBasin(basin);
        return;
      }
    }
    basinLevel.set(index, waterY);
    basinCells.set(index, new Set(basin.cells));
    wetCells.set(index, new Set(footprint.cells));
    lakeBasin.push(index);
    // outline is in cell-corner space; a corner (ix, iz) sits half a step
    // before the cell centre (ix, iz). The point cap used to be 56, which
    // let the tolerance climb to dozens of cells on a big lake: the polygon
    // cut straight across bays and headlands, and everything inside it was
    // carved down to the water — a hillside truncated by a vertical wall
    // where the real shore curved away.
    const traced = simplifyLoop(footprint.outline, 0.6, Math.round(option("lake-points", 160))).map(
      ([cx, cz]) => [round(grid.worldX(cx) - grid.step / 2), round(grid.worldZ(cz) - grid.step / 2)] as [number, number],
    );
    if (traced.length < 4) {
      fillBasin(basin);
      return;
    }
    // then onto the ground: each vertex slides along its outward normal to
    // where the field actually crosses the water level, so the polygon is
    // the shoreline of THIS terrain and not of a 16 m grid's idea of it
    const outline = refineShoreline(traced, waterY, field, grid.step);
    // a lake in a swamp or a fen is standing, murky water: its own material
    const centreCell = grid.nearest(grid.worldX(footprint.centroid[0]), grid.worldZ(footprint.centroid[1]));
    const marsh = grid.swamp[centreCell]! > 0.4;
    if (marsh && recipe.waterMaterial) writeSwampWaterMaterial(recipe, `${recipe.waterMaterial}-swamp`);
    lakes.push({
      id: `lake-${lakes.length + 1}`,
      ...(marsh && recipe.waterMaterial ? { material: `${recipe.waterMaterial}-swamp` } : {}),
      center: [round(grid.worldX(footprint.centroid[0])), round(grid.worldZ(footprint.centroid[1]))],
      polygon: outline,
      radius: round(Math.sqrt((footprint.cells.length * cellArea) / Math.PI)),
      waterY: round(waterY),
      depth: round(Math.min(14, Math.max(3, (waterY - basin.floor) * 0.8 + 1))),
      bank: 16,
      // the terrain holds this basin already; the field only deepens it
      carve: false,
      // wet sand (or whatever the palette has) on the bed and a shore band
      surface: lakeSurface,
      shore: 8,
      tags: [],
    });
  });

  const rivers: RiverDoc[] = [];
  const falls: PoiDoc[] = [];
  const random = mulberry32(recipe.seed ^ 0x5ca1ab1e);
  /** Basin index per cell, for cells inside any kept basin (drained bowl included). */
  const basinOf = new Int32Array(grid.n * grid.n).fill(-1);
  for (const [index, cells] of basinCells) for (const c of cells) basinOf[c] = index;
  /** 1 under drawn water: where a head is an outlet, a swing is damped and a drop is not a fall. */
  const inLake = new Uint8Array(grid.n * grid.n);
  for (const cells of wetCells.values()) for (const c of cells) inLake[c] = 1;
  /**
   * The basin whose drawn water a cell is under or right beside (one cell
   * out). An outlet's first cell is often the cell just OUTSIDE the wet
   * footprint — the polygon is refined onto the real shoreline, which runs
   * through that ring — so "starts in a lake" has to look one cell around.
   */
  const wetOrRing = new Int32Array(grid.n * grid.n).fill(-1);
  for (const [index, cells] of wetCells) {
    for (const c of cells) {
      wetOrRing[c] = index;
      const ix = c % grid.n;
      const iz = (c / grid.n) | 0;
      for (let dz = -1; dz <= 1; dz++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = ix + dx;
          const nz = iz + dz;
          if (nx < 0 || nz < 0 || nx >= grid.n || nz >= grid.n) continue;
          const ni = nx + nz * grid.n;
          if (wetOrRing[ni]! < 0 && !inLake[ni]) wetOrRing[ni] = index;
        }
      }
    }
  }
  /** The water surface sits this fraction of the depth above the bed (field.ts riverSurface). */
  const SURFACE = 0.7;
  const meanderAmp = option("meander", 4.5);
  /** Each channel's swung polyline, bed and depth by channel index, so a tributary can end ON its parent. */
  const swung = new Map<number, { points: [number, number][]; bed: number[]; depths: number[] }>();
  /**
   * Channel width for a rain-weighted catchment of `acc` grid cells: a
   * stream at the threshold is a few metres across, a river draining
   * sixteen square kilometres is thirty. One law for the whole tree, so
   * width grows continuously downstream and jumps at every confluence by
   * exactly what the tributary brought — the old per-river width (a floor
   * of ten metres, most rivers 10-13) is why every river looked the same.
   */
  const widthFor = (acc: number): number => Math.max(2.5, Math.min(30, 2.5 + 6.5 * Math.sqrt((Math.max(0, acc) * cellArea) / 1e6)));
  /** Channel depth for a channel `width` wide: a metre and a half for a brook, six and a half for the trunk. */
  const depthFor = (width: number): number => Math.max(1, Math.min(6.5, 0.9 + 0.2 * width));
  const headTaper = option("taper", 120);
  /**
   * LOWLAND WATER. A water sheet laid on a 6 % slope is a wall of water, and
   * this landform drops 5-7 % over most of its length: every channel was a
   * mountain torrent drawn as a tilted sheet with the current streaked down
   * it. Only reaches at or under this grade carry a water sheet; the steep
   * reaches stay carved as dry gravel gullies, and a channel is written as
   * one document per wet/dry run (`water: false` on the dry ones — the carve
   * is the same, the ribbon is not emitted and waterY is null there). Points
   * under or beside a lake are always wet so the water visibly leaves and
   * arrives. A wet run away from any lake must be at least three points long.
   */
  const wetGrade = option("wet-grade", 0.02);
  let dryPieces = 0;
  let wetPieces = 0;
  let outlets = 0;
  let snapped = 0;
  let snappedBy = 0;
  /** What became of each channel: the river id it was written as, or why it was dropped. */
  const channelFate = new Map<number, string>();

  channels.forEach((channel, channelIndex) => {
    const authored = channel.authored;
    if (!authored && !traceRivers) {
      channelFate.set(channelIndex, "not carved (lakes only; --trace carves the traced network)");
      return;
    }
    const baseWidth = round(authored ? authored.path.width : widthFor(channel.size));
    const depth = round(depthFor(baseWidth));
    let cells = channel.cells;
    let taper = headTaper;
    // A channel whose source lies under a lake is that lake's OUTLET. It
    // used to begin as a tapered trickle somewhere out in the water and
    // reach full size 220 m downstream — the lake ended at a wall of shore
    // with a ditch starting beyond it. Now it begins at the shore (one cell
    // inside, so the ribbon starts under the sheet), full width from the
    // first metre, at the lake's own surface.
    if (!authored && wetOrRing[cells[0]!]! >= 0) {
      // through THIS lake's water only: two lakes a cell apart share a
      // contiguous wet run, and skipping both left the first with no outlet
      const source = wetOrRing[cells[0]!]!;
      let k = 0;
      while (k + 1 < cells.length && wetOrRing[cells[k + 1]!] === source) k++;
      cells = cells.slice(Math.max(0, k - 1));
      taper = 0;
      outlets++;
    }
    // A mouth in the DRY bowl of a drained lake (its parent's reach there was
    // the lake's own outlet, trimmed to the shore) is carried on to the
    // water: the bowl drains into the lake, so does the tributary.
    {
      const mouthCell = cells[cells.length - 1]!;
      // the dry bowl of a drained lake, or the one-cell ring round any lake
      const bowl = basinOf[mouthCell]! >= 0 ? basinOf[mouthCell]! : wetOrRing[mouthCell]!;
      if (bowl >= 0 && !inLake[mouthCell]) {
        let nearest = -1;
        let nearestD = Infinity;
        const mx = mouthCell % grid.n;
        const mz = (mouthCell / grid.n) | 0;
        for (const c of wetCells.get(bowl) ?? []) {
          const d = Math.hypot((c % grid.n) - mx, ((c / grid.n) | 0) - mz);
          if (d < nearestD) {
            nearestD = d;
            nearest = c;
          }
        }
        if (nearest >= 0 && nearestD > 0.5) cells = [...cells, nearest];
      }
    }
    if (cells.length < 2) {
      channelFate.set(channelIndex, "trimmed to under two cells");
      return;
    }
    const last = cells.length - 1;
    let points: [number, number][] = authored
      ? authored.points.slice(0, cells.length)
      : cells.map((c) => [grid.worldX(c % grid.n), grid.worldZ((c / grid.n) | 0)] as [number, number]);
    // the catchment at each cell sizes the channel there: the bed target,
    // the surface over it and the ribbon all follow the LOCAL depth. A drawn
    // river takes its author's width — a ramp from half at the head to full
    // at the mouth unless per-point widths were given.
    let catchWidth: number[] = authored
      ? cells.map((_, i) => {
          const w = authored.path.widths;
          if (w && w.length === authored.path.points.length) return sampleAlong(authored.path.points, w, authored.points[i]!);
          return authored.path.width * (0.5 + 0.5 * (i / Math.max(1, cells.length - 1)));
        })
      : cells.map((c) => widthFor(hydro.accumulation[c]!));
    let depths = catchWidth.map((w) => round(depthFor(w)));
    // The bed. The natural target is the filled surface less the channel
    // depth: the filled surface is what guarantees a way down, the ground
    // under a lake may not have one. Inside a kept basin the channel answers
    // to the LAKE instead: its surface runs a hair under the lake's, and
    // across the dry bowl of a drained basin it follows the ground down to
    // the water rather than dropping to it in one step at the basin's edge.
    //
    // And from the first cell under drawn water onward the bed is CAPPED at
    // that lake's flush level: water leaving a lake cannot stand higher than
    // the lake. That is what cuts a drained basin's outlet down through its
    // sill (the filled surface there is the old spill level, metres above
    // the drained water) and through the dry bowl between the water and the
    // sill; without it the mouth-first solve below lifted the whole lake
    // reach up to the sill instead.
    const target: number[] = [];
    let cap = Infinity;
    for (let i = 0; i < cells.length; i++) {
      const c = cells[i]!;
      const basin = basinOf[c]!;
      const wet = wetOrRing[c]!;
      const d = depths[i]!;
      if (wet >= 0) cap = Math.min(cap, basinLevel.get(wet)! - SURFACE * d - 0.15);
      let t: number;
      if (basin >= 0) {
        const flush = basinLevel.get(basin)! - SURFACE * d - 0.15;
        t = Math.max(grid.height[c]! - d, flush);
      } else {
        t = hydro.filled[c]! - d;
      }
      target.push(Math.min(t, cap));
    }
    // The mouth: the SURFACE, not the bed, meets the receiving water — a
    // hair under the sea so the ribbon slips beneath the ocean plane rather
    // than stopping at the beach, and flush with the parent's surface at a
    // confluence (the parent is deeper, so its bed is lower; matching beds
    // had every tributary arriving as a little step above its river).
    //
    // And the mouth is where the parent's channel NOW runs. A tributary was
    // traced to the grid cell its parent flowed through, but the parent has
    // since been swung sideways by its meander — up to sixty metres — so the
    // tributary ended in a field beside its river. Its last point is moved
    // onto the nearest point of the parent's swung polyline, and its bed
    // there is read off the parent's.
    const mouth = cells[last]!;
    const parent = channel.joins >= 0 ? swung.get(channel.joins) : undefined;
    let mouthBed = target[last]!;
    let mouthPoint: [number, number] | null = null;
    if (hydro.sea[mouth]) {
      mouthBed = recipe.seaLevel - SURFACE * depths[last]! - 0.3;
    } else if (parent && !inLake[mouth]) {
      // (a mouth inside a lake answers to the lake — the parent's reach there
      // was trimmed to the shore, and snapping onto what remains of it dragged
      // tributaries a kilometre across the water as dead-straight stubs)
      const near = nearestOnSwung(parent.points, parent.bed, points[last - 1]!, parent.depths);
      if (near && Math.hypot(near.point[0] - points[last]![0], near.point[1] - points[last]![1]) <= Math.max(80, 4 * grid.step)) {
        const moved = Math.hypot(near.point[0] - points[last]![0], near.point[1] - points[last]![1]);
        if (moved > 0.5) {
          snapped++;
          snappedBy += moved;
        }
        mouthPoint = near.point;
        mouthBed = near.bed + SURFACE * near.depth - SURFACE * depths[last]! - 0.15;
        // the tributary arrives at the parent's depth, so its surface meets the parent's
        depths[last] = round(near.depth);
      }
    }
    // Solved from the mouth UP: every bed is at least the one below it, so
    // the profile only ever descends AND honours what waits downstream — a
    // river approaching a lake across a flat arrives flush with it instead
    // of sliding in a metre under its surface (solving downward could only
    // lower a bed, never lift the approach up to the lake it was about to
    // enter). Uphill steps in bedY: none, by construction.
    let bed = new Array<number>(cells.length);
    if (authored) {
      // a drawn river is a decision: it cuts down through whatever the path
      // crosses (a ridge becomes a gorge) and never lifts — running MIN from
      // the head, then the mouth rule
      bed[0] = target[0]!;
      for (let i = 1; i <= last; i++) bed[i] = Math.min(target[i]!, bed[i - 1]!);
      bed[last] = Math.min(bed[last]!, mouthBed);
      for (let i = last - 1; i >= 0; i--) bed[i] = Math.max(bed[i]!, bed[i + 1]!);
    } else {
      bed[last] = mouthBed;
      for (let i = last - 1; i >= 0; i--) bed[i] = Math.max(target[i]!, bed[i + 1]!);
    }
    // waterfalls: a drop of more than half a cliff in one grid step
    for (let i = 0; i + 1 < cells.length; i++) {
      const drop = bed[i]! - bed[i + 1]!;
      if (drop >= option("falls", 7) && !inLake[cells[i]!]) {
        const x = points[i]![0];
        const z = points[i]![1];
        if (falls.every((f) => Math.hypot(f.position[0] - x, f.position[2] - z) > 120)) {
          falls.push({ id: `falls-${falls.length + 1}`, kind: "falls", position: [round(x), round(bed[i]!), round(z)], rotationY: 0, tags: [] });
        }
      }
    }
    // MEANDERS, as a real river makes them. A traced corridor is a run of
    // cell centres and reads as a straight line; offsetting its points by
    // a sine can never give a real bend (a sine capped so the ribbon does
    // not fold has a sinuosity of about 1.1). The sine-generated curve
    // (Langbein & Leopold) swings the channel's HEADING like a sine along
    // its arc length and integrates position from it: proper loops with a
    // bend radius of a couple of widths, sinuosity 1.3-1.8, and no
    // self-intersection below a swing of ~110°. It rides the corridor —
    // position is corridor(u) + normal(u)·v — so it still follows the
    // valley, damps on steep reaches and near the mouth, goes straight
    // through a lake, and pulls back toward the corridor wherever the ground
    // beside it is a bluff or a ledge. A drawn river is left as drawn.
    const wavelength = Math.max(180, 12 * baseWidth);
    const swing = option("swing", 1.05) * Math.min(1, meanderAmp / 3);
    const woven = authored
      ? { points, t: points.map((_, i) => i), theta: points.map(() => 0) }
      : meanderSine(points, bed, cells, grid, inLake, {
          omega: swing,
          wavelength,
          step: 6,
          depth,
          taper,
          bluff: option("bluff", 3.5),
          random,
        });
    /** Linear sample of a per-corridor-point array at a fractional index. */
    const atT = (arr: readonly number[], t: number): number => {
      const i = Math.max(0, Math.min(arr.length - 1, Math.floor(t)));
      const j = Math.min(arr.length - 1, i + 1);
      return arr[i]! + (arr[j]! - arr[i]!) * Math.max(0, Math.min(1, t - i));
    };
    const corridorCells = cells;
    const corridorBed = bed;
    const corridorDepths = depths;
    const corridorWidth = catchWidth;
    points = woven.points;
    cells = woven.t.map((t) => corridorCells[Math.max(0, Math.min(corridorCells.length - 1, Math.round(t)))]!);
    bed = woven.t.map((t) => atT(corridorBed, t));
    depths = woven.t.map((t) => round(atT(corridorDepths, t)));
    catchWidth = woven.t.map((t) => atT(corridorWidth, t));
    // beds only descend, still: the resample is monotone in t and the
    // corridor bed is monotone in index, so this is a safety net, not a fix
    for (let i = 1; i < bed.length; i++) if (bed[i]! > bed[i - 1]!) bed[i] = bed[i - 1]!;
    const along: number[] = [0];
    for (let i = 1; i < points.length; i++) {
      along.push(along[i - 1]! + Math.hypot(points[i]![0] - points[i - 1]![0], points[i]![1] - points[i - 1]![1]));
    }
    if (mouthPoint) points[points.length - 1] = mouthPoint;
    swung.set(channelIndex, { points, bed, depths });
    // Width along the channel: grows with the catchment (a river below a
    // confluence is wider than above it), swells at the apex of each bend
    // where the outer bank is eaten, and wanders a little besides. `width`
    // stays the widest, because the field sizes the carve's reach from it.
    const phase3 = random() * Math.PI * 2;
    const widths: number[] = [];
    for (let i = 0; i < points.length; i++) {
      const swell = 1 + 0.12 * Math.min(1, Math.abs(woven.theta[i]!) / Math.max(0.05, swing));
      const wander = 1 + 0.1 * Math.sin((2 * Math.PI * along[i]!) / (wavelength * 0.5) + phase3);
      widths.push(Math.max(2.5, Math.min(baseWidth * 1.2, catchWidth[i]! * swell * wander)));
    }
    const width = round(Math.max(...widths));
    const keep = simplify3(
      points.map((p) => [p[0] / grid.step, p[1] / grid.step] as [number, number]),
      bed,
      0.45,
      0.45 / 0.8,
    );
    if (keep.length < 2) {
      channelFate.set(channelIndex, "simplified to under two points");
      return;
    }
    let length = 0;
    for (let i = 1; i < keep.length; i++) length += Math.hypot(points[keep[i]!]![0] - points[keep[i - 1]!]![0], points[keep[i]!]![1] - points[keep[i - 1]!]![1]);
    if (length < 12) {
      channelFate.set(channelIndex, `${length.toFixed(0)} m stub`);
      return;
    }
    const riverNo = rivers.length + 1;
    channelFate.set(channelIndex, `river-${riverNo}`);
    // grade at each kept point over its kept neighbours, and the wet mask
    const keptAlong = keep.map((i) => along[i]!);
    const wet: boolean[] = keep.map((i, k) => {
      if (wetOrRing[cells[i]!]! >= 0 || inLake[cells[i]!]) return true;
      // the mouth: the last step drops under the sea plane, which is not a slope
      if (hydro.sea[cells[i]!] || (i + 1 < cells.length && hydro.sea[cells[i + 1]!])) return true;
      const a = Math.max(0, k - 1);
      const b = Math.min(keep.length - 1, k + 1);
      const run = keptAlong[b]! - keptAlong[a]!;
      const grade = run > 0 ? (bed[keep[a]!]! - bed[keep[b]!]!) / run : 0;
      return grade <= wetGrade;
    });
    // short wet runs away from lakes are puddles on a slope: dry them
    for (let k = 0; k < wet.length; ) {
      if (!wet[k]) {
        k++;
        continue;
      }
      let e = k;
      while (e + 1 < wet.length && wet[e + 1]) e++;
      const touchesLake = keep.slice(k, e + 1).some((i) => wetOrRing[cells[i]!]! >= 0 || inLake[cells[i]!] || hydro.sea[cells[i]!] === 1);
      if (e - k + 1 < 3 && !touchesLake) for (let j = k; j <= e; j++) wet[j] = false;
      k = e + 1;
    }
    // one document per run; neighbouring runs share their boundary point so
    // the carve is continuous, and only the head piece tapers
    const pieces: { from: number; to: number; water: boolean }[] = [];
    for (let k = 0; k < wet.length; ) {
      let e = k;
      while (e + 1 < wet.length && wet[e + 1] === wet[k]) e++;
      pieces.push({ from: k, to: Math.min(wet.length - 1, e + 1), water: wet[k]! });
      k = e + 1;
    }
    pieces.forEach((piece, pieceIndex) => {
      const idx = keep.slice(piece.from, piece.to + 1);
      if (idx.length < 2) return;
      if (piece.water) wetPieces++;
      else dryPieces++;
      rivers.push({
        id: pieceIndex === 0 ? `river-${riverNo}` : `river-${riverNo}.${pieceIndex + 1}`,
        points: idx.map((i) => [round(points[i]![0]), round(points[i]![1])] as [number, number]),
        width,
        widths: idx.map((i) => round(widths[i]!)),
        depth: round(Math.max(...depths)),
        depths: idx.map((i) => depths[i]!),
        // the bank at the channel's widest; the field narrows it with the local width
        bank: round(width * 0.7 + 3),
        bedY: idx.map((i) => round(bed[i]!)),
        water: piece.water,
        // a gravel bed where the palette has one: a riverbed is not a beach
        surface: riverSurface,
        surfaceEdge: 3,
        taper: pieceIndex === 0 ? taper : 0,
      });
    });
  });
  console.log(`  lowland water: ${wetPieces} wet reaches carry a sheet, ${dryPieces} steep reaches are dry gullies (--wet-grade ${wetGrade})`);

  // every lake was chosen for having the network run through it; if the
  // written rivers no longer reach one, say which and why it was kept
  const lakeIndexToBasin = new Map<string, number>();
  lakes.forEach((lake, k) => lakeIndexToBasin.set(lake.id, lakeBasin[k]!));
  for (const lake of lakes) {
    if (!traceRivers) break; // lakes without rivers are the point of lakes-only
    const poly = lake.polygon!;
    // inside the outline, or within a bank of it: an outlet starts AT the shore
    const near = rivers.some((r) =>
      r.points.some((p) => pointInPolygon(poly, p[0], p[1]) || polygonDistance(poly, p[0], p[1]) <= lake.bank),
    );
    if (near) continue;
    const bi = lakeIndexToBasin.get(lake.id)!;
    const basin = basins[bi]!;
    const low = channelLow[bi]!;
    const member = new Set(basin.cells);
    const crossing = channels
      .map((channel, index) => ({ index, inside: channel.cells.filter((c) => member.has(c)).length, length: channel.cells.length }))
      .filter((c) => c.inside > 0)
      .map((c) => `#${c.index} ${c.inside}/${c.length} cells -> ${channelFate.get(c.index) ?? "?"}`);
    console.warn(
      `  ! ${lake.id} at [${lake.center[0]}, ${lake.center[1]}] has no river point inside its outline: ` +
        `basin level ${basin.level.toFixed(1)} floor ${basin.floor.toFixed(1)} water ${lake.waterY} channel-low ${low >= 0 ? grid.height[low]!.toFixed(1) : "none"} ` +
        `(${basin.cells.length} cells, ${wetCells.get(bi)?.size ?? 0} wet); channels: ${crossing.join("; ")}`,
    );
  }
  recipe.features.rivers = [...rivers, ...handRivers];
  recipe.features.lakes = lakes;
  recipe.features.fills = fills;
  recipe.features.pois = [...recipe.features.pois, ...falls];
  if (handRivers.length > 0) console.log(`  ${handRivers.length} hand-written rivers kept (the field solves their beds)`);
  if (!traceRivers) console.log(`  lakes only: the traced network is not carved (--trace to carve it); rivers are authored — see docs/voxel-worlds.md`);
  // moving water for the ribbons: the standing-water material's twin with
  // the channel flow mode, so rivers visibly run downstream
  if (recipe.waterMaterial) {
    // the ocean plane keeps the base material (finely subdivided, its
    // vertices may move); lake sheets and river ribbons get twins with
    // `displace: false` — a polygon fan or a two-wide ribbon lifted at its
    // vertices is a faceted, streaked sheet, not water
    const baseWater = recipe.waterMaterial.replace(/-lake$/, "");
    const lakeMaterialId = `${baseWater}-lake`;
    writeDerivedWaterMaterial(baseWater, lakeMaterialId, { displace: false }, "lake water");
    recipe.waterMaterial = lakeMaterialId;
    const riverMaterialId = `${baseWater}-river`;
    writeRiverWaterMaterial(baseWater, riverMaterialId);
    recipe.riverMaterial = riverMaterialId;
  }
  writeRecipe(recipe, file);
  console.log(
    `  ${outlets} lake outlets start at their shore, ${snapped} mouths moved onto their swung parent ` +
      `(${snapped > 0 ? (snappedBy / snapped).toFixed(0) : 0} m avg), ${raised} drained lakes held up over the water downstream`,
  );
  const totalPoints = rivers.reduce((n, r) => n + r.points.length, 0);
  const km = rivers.reduce((sum, r) => {
    let len = 0;
    for (let i = 0; i + 1 < r.points.length; i++) len += Math.hypot(r.points[i + 1]![0] - r.points[i]![0], r.points[i + 1]![1] - r.points[i]![1]);
    return sum + len;
  }, 0) / 1000;
  console.log(
    `carved ${rivers.length} rivers (${channels.filter((c) => c.joins < 0).length} reach the sea, ${totalPoints} control points, ${km.toFixed(1)} km), ` +
      `${lakes.length} lakes (${basins.length} basins on the network, ${drained} drained, ${fills.length} filled to valley floors), ${falls.length} waterfalls`,
  );
  if (meanderStats.requested > 0) {
    console.log(
      `  meander: ${((100 * meanderStats.applied) / meanderStats.requested).toFixed(0)}% of the requested swing applied ` +
        `(the rest ran into hillsides; --meander widths, --bluff depths)`,
    );
  }
  for (const lake of lakes.slice(0, 8)) {
    console.log(`  ${lake.id}: at [${lake.center[0]}, ${lake.center[1]}] surface ${lake.waterY}m, ~${lake.radius}m across, ${lake.depth}m deep`);
  }
  if (lakes.length > 8) console.log(`  ... and ${lakes.length - 8} more`);
  const audit = auditWorld(recipe, createWorldField(recipe));
  console.log(`  ${audit.summary}`);
  if (audit.counts.townsUnderWater > 0) console.log("  lakes moved: re-run towns, paths, pois and trails (worldgen audit for the list)");
}

/**
 * `worldgen river-path`: add, replace or remove a DRAWN river centreline.
 * The rivers stage solves it (bed, banks, wet reaches) on its next run —
 * this command only records the author's intent in `features.riverPaths`.
 */
function commandRiverPath(): void {
  const { recipe, file } = loadRecipe();
  const remove = stringOption("remove", "");
  if (remove) {
    const before = recipe.features.riverPaths.length;
    recipe.features.riverPaths = recipe.features.riverPaths.filter((p) => p.id !== remove);
    writeRecipe(recipe, file);
    console.log(`removed ${before - recipe.features.riverPaths.length} path(s); run: worldgen rivers ${worldName}`);
    return;
  }
  if (flag("list")) {
    for (const p of recipe.features.riverPaths) console.log(`  ${p.id}: ${p.points.length} points, width ${p.width}`);
    if (recipe.features.riverPaths.length === 0) console.log("  (no drawn river paths)");
    return;
  }
  const id = stringOption("id", "");
  let points: [number, number][] = [];
  const fromScene = stringOption("from-scene", "");
  const entityId = stringOption("entity", "");
  if (fromScene) {
    // the editor's path tool: a `path` mesh entity, control points in
    // entity-local space under a transform — the same thing the ribbon and
    // the river water are built from
    const sceneFile = path.join(assetsRoot(), "scenes", `${fromScene}.scene.json`);
    if (!fs.existsSync(sceneFile)) fail(`no scene ${sceneFile}`);
    const scene = JSON.parse(fs.readFileSync(sceneFile, "utf8")) as { entities: Record<string, { components?: Record<string, unknown> }> };
    const entity = scene.entities[entityId];
    if (!entity) fail(`no entity "${entityId}" in ${fromScene} (--entity <id>)`);
    const mesh = entity.components?.["mesh"] as { source?: { kind?: string; points?: [number, number, number][] } } | undefined;
    if (mesh?.source?.kind !== "path" || !mesh.source.points) fail(`entity "${entityId}" is not a path mesh`);
    const transform = entity.components?.["transform"] as { position?: [number, number, number]; rotation?: [number, number, number, number] } | undefined;
    const pos = transform?.position ?? [0, 0, 0];
    const rot = transform?.rotation ?? [0, 0, 0, 1];
    if (Math.abs(rot[0]) + Math.abs(rot[1]) + Math.abs(rot[2]) > 1e-3) console.warn("  (entity rotation ignored — the path is taken in its local XZ plus the position)");
    points = mesh.source.points.map((p) => [round(p[0] + pos[0]), round(p[2] + pos[2])] as [number, number]);
  } else {
    const raw = stringOption("points", "");
    if (!raw) fail("give --points \"x,z;x,z;…\" (head first) or --from-scene <scene> --entity <id>");
    points = raw.split(";").map((pair) => {
      const [x, z] = pair.split(",").map(Number);
      if (!Number.isFinite(x) || !Number.isFinite(z)) fail(`bad point "${pair}"`);
      return [round(x!), round(z!)] as [number, number];
    });
  }
  if (points.length < 2) fail("a river path needs at least two points");
  const pathId = id || entityId || `path-${recipe.features.riverPaths.length + 1}`;
  const doc: RiverPathDoc = { id: pathId, points, width: option("width", 14), tags: [] };
  recipe.features.riverPaths = [...recipe.features.riverPaths.filter((p) => p.id !== pathId), doc];
  writeRecipe(recipe, file);
  console.log(`recorded ${pathId}: ${points.length} points, width ${doc.width} — now run: worldgen rivers ${worldName}${project ? ` --project ${project}` : ""} (then towns, paths, pois, trails)`);
}

/** Parse `--points "x,z;x,z;…"` into world XZ pairs. */
function pointsOption(name = "points"): [number, number][] {
  const raw = stringOption(name, "");
  if (!raw) fail(`give --${name} "x,z;x,z;…"`);
  return raw.split(";").map((pair) => {
    const [x, z] = pair.split(",").map(Number);
    if (!Number.isFinite(x) || !Number.isFinite(z)) fail(`bad point "${pair}"`);
    return [x!, z!] as [number, number];
  });
}

/** Douglas–Peucker on world XZ, tolerance in metres. */
function simplifyPolyline(points: readonly [number, number][], tolerance: number): [number, number][] {
  if (points.length < 3) return points.slice();
  const keep = new Uint8Array(points.length);
  keep[0] = 1;
  keep[points.length - 1] = 1;
  const stack: [number, number][] = [[0, points.length - 1]];
  while (stack.length > 0) {
    const [a, b] = stack.pop()!;
    const pa = points[a]!;
    const pb = points[b]!;
    const dx = pb[0] - pa[0];
    const dz = pb[1] - pa[1];
    const len = Math.hypot(dx, dz) || 1;
    let worst = -1;
    let worstD = tolerance;
    for (let i = a + 1; i < b; i++) {
      const p = points[i]!;
      const d = Math.abs((p[0] - pa[0]) * dz - (p[1] - pa[1]) * dx) / len;
      if (d > worstD) {
        worstD = d;
        worst = i;
      }
    }
    if (worst >= 0) {
      keep[worst] = 1;
      stack.push([a, worst], [worst, b]);
    }
  }
  return points.filter((_, i) => keep[i] === 1);
}

/**
 * `worldgen descend`: where does water go from here? The hydrology's own
 * answer — depressions filled, D8 flow on the filled surface — walked
 * downstream from a point (or from a lake, `--from-lake <id>`, starting at
 * its centre so the walk leaves by the lake's real spill) until the sea or
 * another lake. Prints the route as a table and as a --points string an
 * author can hand to `profile`, bend, and write into `features.rivers`.
 * It is a valley floor, not a river: a hand-written river follows it
 * loosely — bends of a few widths, cutting the corners of the grid — and
 * stays off the reaches this prints as steep.
 */
function commandDescend(): void {
  const { recipe } = loadRecipe();
  const field = createWorldField(recipe);
  const fromLake = stringOption("from-lake", "");
  let start: [number, number];
  if (fromLake) {
    const lake = recipe.features.lakes.find((l) => l.id === fromLake);
    if (!lake) fail(`no lake "${fromLake}"`);
    start = [lake.center[0], lake.center[1]];
  } else {
    start = pointsOption("from")[0]!;
  }
  const extent = extentFor(recipe);
  const gridStep = option("step", 16);
  const grid = sampleWorldGrid(field, extent, gridStep);
  const hydro = computeHydrology(grid);
  const lakeAt = (x: number, z: number): LakeDoc | undefined =>
    recipe.features.lakes.find((l) => l.id !== fromLake && l.polygon && polygonDistance(l.polygon, x, z) <= l.bank);
  const route: [number, number][] = [];
  const heights: number[] = [];
  let c = grid.nearest(start[0], start[1]);
  let fate = "ran out of steps";
  let left = !fromLake;
  const fromDoc = fromLake ? recipe.features.lakes.find((l) => l.id === fromLake) : undefined;
  for (let n = 0; n < grid.n * grid.n; n++) {
    const x = grid.worldX(c % grid.n);
    const z = grid.worldZ((c / grid.n) | 0);
    // inside the starting lake the walk is under water: report from the shore
    if (!left && fromDoc?.polygon && polygonDistance(fromDoc.polygon, x, z) > fromDoc.bank * 0.5) left = true;
    if (left) {
      route.push([x, z]);
      heights.push(grid.height[c]!);
    }
    if (hydro.sea[c]) {
      fate = "the sea";
      break;
    }
    const lake = lakeAt(x, z);
    if (lake) {
      fate = `${lake.id} (surface ${lake.waterY})`;
      break;
    }
    const next = hydro.downstream[c]!;
    if (next < 0 || next === c) {
      fate = `a pit at ${x.toFixed(0)},${z.toFixed(0)} (the fill found no way out: the world's edge, or a bowl under the sea floor)`;
      break;
    }
    c = next;
  }
  if (route.length === 0) fail("the start is under the lake and the walk never left it");
  let along = 0;
  console.log(`  chainage      x       z   ground   grade`);
  let lastReport = -1e9;
  let lastH = heights[0]!;
  const every = option("every", 100);
  for (let i = 0; i < route.length; i++) {
    if (i > 0) along += Math.hypot(route[i]![0] - route[i - 1]![0], route[i]![1] - route[i - 1]![1]);
    if (along - lastReport >= every || i === route.length - 1) {
      const grade = along - lastReport > 0 && lastReport > -1e8 ? (lastH - heights[i]!) / (along - lastReport) : 0;
      console.log(
        `  ${along.toFixed(0).padStart(8)} ${route[i]![0].toFixed(0).padStart(6)} ${route[i]![1].toFixed(0).padStart(7)} ${heights[i]!.toFixed(1).padStart(8)} ${(grade * 100).toFixed(1).padStart(6)}%`,
      );
      lastReport = along;
      lastH = heights[i]!;
    }
  }
  console.log(`  ${along.toFixed(0)} m, ${heights[0]!.toFixed(1)} m down to ${heights[heights.length - 1]!.toFixed(1)} m, ended at ${fate}`);
  const simple = simplifyPolyline(route, option("simplify", 30));
  console.log(`  --points "${simple.map((p) => `${p[0].toFixed(0)},${p[1].toFixed(0)}`).join(";")}"`);
}

/**
 * `worldgen profile`: the ground along a route, sampled every --step
 * metres, with the bed grade a river there would carry and the ground a
 * bank width to either side — the numbers that say whether a reach is a
 * floodplain (a sheet reads well under 2 %), a torrent, or a side-slope
 * that would give a canal cliff. Read it before writing a river; read the
 * river's own solved bed after (`--river <id>`).
 */
function commandProfile(): void {
  const { recipe } = loadRecipe();
  const field = createWorldField(recipe);
  const riverId = stringOption("river", "");
  const river = riverId ? field.rivers.find((r) => r.id === riverId) : undefined;
  if (riverId && !river) fail(`no river "${riverId}" (${field.rivers.map((r) => r.id).join(", ") || "none"})`);
  const points = river ? river.points : pointsOption();
  const width = river ? river.width : option("width", 14);
  const side = option("side", width / 2 + Math.min(14, width * 0.7 + 3));
  const step = option("step", 20);
  const dense = densifyPolyline(points, step);
  let along = 0;
  let prevH = NaN;
  let prevAlong = 0;
  let steep = 0;
  let sideSlope = 0;
  let maxGrade = 0;
  let underWater = 0;
  console.log(`  chainage      x       z   ground   grade   left  right   note`);
  for (let i = 0; i < dense.length; i++) {
    const [x, z] = dense[i]!;
    if (i > 0) along += Math.hypot(x - dense[i - 1]![0], z - dense[i - 1]![1]);
    const h = field.height(x, z);
    const j = Math.min(dense.length - 1, i + 1);
    const k = Math.max(0, i - 1);
    const dx = dense[j]![0] - dense[k]![0];
    const dz = dense[j]![1] - dense[k]![1];
    const l = Math.hypot(dx, dz) || 1;
    const nx = -dz / l;
    const nz = dx / l;
    const left = field.height(x + nx * side, z + nz * side);
    const right = field.height(x - nx * side, z - nz * side);
    const grade = i > 0 && along > prevAlong ? (prevH - h) / (along - prevAlong) : 0;
    const water = field.waterY(x, z);
    const notes: string[] = [];
    if (h < recipe.seaLevel) notes.push("sea");
    else if (water !== null && water > h) notes.push(`under water ${water.toFixed(1)}`);
    if (i > 0 && grade < -0.005) notes.push("UPHILL");
    if (i > 0 && grade > 0.02) notes.push("steep");
    if (Math.max(left, right) - h > side * 0.35) notes.push("side slope");
    if (i > 0) {
      const run = along - prevAlong;
      if (grade > 0.02) steep += run;
      if (Math.max(left, right) - h > side * 0.35) sideSlope += run;
      maxGrade = Math.max(maxGrade, grade);
      if (water !== null && water > h && h >= recipe.seaLevel) underWater += run;
    }
    console.log(
      `  ${along.toFixed(0).padStart(8)} ${x.toFixed(0).padStart(6)} ${z.toFixed(0).padStart(7)} ${h.toFixed(1).padStart(8)} ${(grade * 100).toFixed(1).padStart(6)}% ${left.toFixed(1).padStart(6)} ${right.toFixed(1).padStart(6)}   ${notes.join(", ")}`,
    );
    prevH = h;
    prevAlong = along;
  }
  console.log(
    `  ${along.toFixed(0)} m; max grade ${(maxGrade * 100).toFixed(1)}%; ${steep.toFixed(0)} m over 2% (${((100 * steep) / Math.max(1, along)).toFixed(0)}%), ` +
      `${sideSlope.toFixed(0)} m on a side slope, ${underWater.toFixed(0)} m already under water`,
  );
  if (river) {
    const bed = river.bedY!;
    const drop = bed[0]! - bed[bed.length - 1]!;
    console.log(`  solved bed: ${bed[0]!.toFixed(1)} → ${bed[bed.length - 1]!.toFixed(1)} m (${drop.toFixed(1)} m over ${along.toFixed(0)} m, ${((100 * drop) / Math.max(1, along)).toFixed(2)}% mean)`);
  }
}

/** `worldgen audit`: print every finding; exit 1 if there are any. */
function commandAudit(): void {
  const { recipe } = loadRecipe();
  const field = createWorldField(recipe);
  const audit = auditWorld(recipe, field);
  if (flag("verbose")) console.log(audit.detail.join("\n"));
  for (const p of audit.problems) console.log(`  ! ${p}`);
  console.log(audit.summary);
  if (audit.problems.length > 0) process.exit(1);
}

/** Bilinear ground height from the sampled grid at a world point (clamped to the grid). */
function gridHeightAt(grid: WorldGridSample, x: number, z: number): number {
  const fx = Math.max(0, Math.min(grid.n - 1.001, (x + grid.extent) / grid.step));
  const fz = Math.max(0, Math.min(grid.n - 1.001, (z + grid.extent) / grid.step));
  const ix = Math.floor(fx);
  const iz = Math.floor(fz);
  const tx = fx - ix;
  const tz = fz - iz;
  const h00 = grid.height[ix + iz * grid.n]!;
  const h10 = grid.height[ix + 1 + iz * grid.n]!;
  const h01 = grid.height[ix + (iz + 1) * grid.n]!;
  const h11 = grid.height[ix + 1 + (iz + 1) * grid.n]!;
  return (h00 * (1 - tx) + h10 * tx) * (1 - tz) + (h01 * (1 - tx) + h11 * tx) * tz;
}

/**
 * Swing a traced channel from side to side so it reads as a river and not
 * as the D8 walk it is.
 *
 * Steepest descent on a 16 m grid produces runs of straight cells joined by
 * 45° corners; a real river on the same ground meanders with a wavelength
 * of ten or so channel widths. The offset is a wave along the arc length,
 * applied perpendicular to the smoothed tangent, and it is damped where the
 * river would not meander: on a steep grade (a torrent cuts straight down;
 * `calm` fades between 1.2 % and 5 %), at the tapered head, and inside a
 * lake. The bed heights are NOT touched — they came from the filled surface
 * and stay monotone — so a swing that would run the channel into a hillside
 * is what shows up as a gorge wall; each offset is halved until the ground
 * there is within a couple of depths of the bed. Two smoothing passes then
 * round the grid corners the walk left behind.
 */
/** A channel from the tracer, or one built from a drawn path. */
type AuthoredChannel = Channel & { authored?: { path: RiverPathDoc; points: [number, number][] } };

/** Resample a polyline so no segment is longer than `maxStep`. */
function densifyPolyline(points: readonly (readonly [number, number])[], maxStep: number): [number, number][] {
  const out: [number, number][] = [];
  for (let i = 0; i + 1 < points.length; i++) {
    const a = points[i]!;
    const b = points[i + 1]!;
    const n = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / maxStep));
    for (let k = 0; k < n; k++) out.push([a[0] + ((b[0] - a[0]) * k) / n, a[1] + ((b[1] - a[1]) * k) / n]);
  }
  const lastPoint = points[points.length - 1]!;
  out.push([lastPoint[0], lastPoint[1]]);
  return out;
}

/** Value of a per-point array at the point of `points` nearest to `p`, interpolated along its segment. */
function sampleAlong(points: readonly (readonly [number, number])[], values: readonly number[], p: readonly [number, number]): number {
  let best = Infinity;
  let value = values[0]!;
  for (let i = 0; i + 1 < points.length; i++) {
    const a = points[i]!;
    const b = points[i + 1]!;
    const dx = b[0] - a[0];
    const dz = b[1] - a[1];
    const l = dx * dx + dz * dz;
    const t = l < 1e-9 ? 0 : Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dz) / l));
    const d = Math.hypot(p[0] - (a[0] + dx * t), p[1] - (a[1] + dz * t));
    if (d < best) {
      best = d;
      value = values[i]! + (values[i + 1]! - values[i]!) * t;
    }
  }
  return value;
}

/**
 * Sine-generated meanders along a corridor. Returns the woven points, the
 * fractional corridor index each rides on (for resampling bed, depth, width
 * and cell), and the heading swing at each (for the bend swell).
 */
function meanderSine(
  corridor: readonly (readonly [number, number])[],
  bed: readonly number[],
  cells: readonly number[],
  grid: WorldGridSample,
  inLake: Uint8Array,
  options: {
    /** Peak heading swing, radians (1.05 ≈ 60°; loops close up past ~1.9). */
    omega: number;
    /** Arc-length wavelength of the heading swing. */
    wavelength: number;
    /** Integration step along the channel, metres. */
    step: number;
    depth: number;
    taper: number;
    bluff: number;
    random: () => number;
  },
): { points: [number, number][]; t: number[]; theta: number[] } {
  const n = corridor.length;
  const straight = { points: corridor.map((p) => [p[0], p[1]] as [number, number]), t: corridor.map((_, i) => i), theta: corridor.map(() => 0) };
  if (n < 4) return straight;
  // smooth the corridor first: a D8 trace turns in 45° steps every cell,
  // and the frame the curve rides must not
  const axis = corridor.map((p) => [p[0], p[1]] as [number, number]);
  for (let pass = 0; pass < 3; pass++) {
    const next = axis.map((p) => [p[0], p[1]] as [number, number]);
    for (let i = 1; i < n - 1; i++) {
      next[i] = [(axis[i - 1]![0] + axis[i]![0] * 2 + axis[i + 1]![0]) / 4, (axis[i - 1]![1] + axis[i]![1] * 2 + axis[i + 1]![1]) / 4];
    }
    for (let i = 0; i < n; i++) axis[i] = next[i]!;
  }
  const cum: number[] = [0];
  for (let i = 1; i < n; i++) cum.push(cum[i - 1]! + Math.hypot(axis[i]![0] - axis[i - 1]![0], axis[i]![1] - axis[i - 1]![1]));
  const total = cum[n - 1]!;
  if (total < options.wavelength * 0.6) return straight;
  /** Corridor point, unit tangent and fractional index at arc u. */
  let cursor = 0;
  const at = (u: number): { x: number; z: number; tx: number; tz: number; t: number } => {
    const uu = Math.max(0, Math.min(total, u));
    while (cursor + 1 < n - 1 && cum[cursor + 1]! < uu) cursor++;
    while (cursor > 0 && cum[cursor]! > uu) cursor--;
    const a = axis[cursor]!;
    const b = axis[cursor + 1]!;
    const len = cum[cursor + 1]! - cum[cursor]!;
    const f = len > 1e-6 ? (uu - cum[cursor]!) / len : 0;
    const tx = len > 1e-6 ? (b[0] - a[0]) / len : 1;
    const tz = len > 1e-6 ? (b[1] - a[1]) / len : 0;
    return { x: a[0] + (b[0] - a[0]) * f, z: a[1] + (b[1] - a[1]) * f, tx, tz, t: cursor + f };
  };
  const bedAt = (t: number): number => {
    const i = Math.max(0, Math.min(n - 1, Math.floor(t)));
    const j = Math.min(n - 1, i + 1);
    return bed[i]! + (bed[j]! - bed[i]!) * Math.max(0, Math.min(1, t - i));
  };
  const phase = options.random() * Math.PI * 2;
  const phase2 = options.random() * Math.PI * 2;
  const points: [number, number][] = [[corridor[0]![0], corridor[0]![1]]];
  const ts: number[] = [0];
  const thetas: number[] = [0];
  let u = 0;
  let v = 0;
  let s = 0;
  const step = options.step;
  let guard = 0;
  while (u < total - step && guard++ < 20000) {
    const here = at(u);
    const i = Math.round(here.t);
    // damping: a torrent runs straight; the head grows into it; the last
    // stretch holds its line into the mouth; a lake reach is left alone
    const i0 = Math.max(0, i - 3);
    const i1 = Math.min(n - 1, i + 3);
    const grade = (bed[i0]! - bed[i1]!) / Math.max(1, cum[i1]! - cum[i0]!);
    const calm = 1 - smoothstep01((grade - 0.02) / (0.08 - 0.02));
    const grow = options.taper > 0 ? Math.min(1, u / options.taper) : 1;
    const mouthHold = Math.min(1, (total - u) / (options.wavelength * 0.35));
    const lakeHold = inLake[cells[Math.min(cells.length - 1, i)]!] ? 0 : 1;
    const omega = options.omega * calm * (0.35 + 0.65 * grow) * mouthHold * lakeHold;
    // the heading swing, plus a weak spring back to the corridor so the
    // drift the bluff damping introduces never carries the channel off
    let theta =
      omega * (0.8 * Math.sin((2 * Math.PI * s) / options.wavelength + phase) + 0.2 * Math.sin((2 * Math.PI * s) / (options.wavelength * 0.43) + phase2)) -
      0.6 * Math.max(-1, Math.min(1, v / (options.wavelength * 0.22)));
    theta = Math.max(-1.3, Math.min(1.3, theta));
    let du = step * Math.cos(theta);
    let dv = step * Math.sin(theta);
    // bluff / ledge: if the ground where this step lands stands more than a
    // few depths above OR below the bed, halve the sideways part and pull in
    let nv = v + dv;
    for (let tries = 0; tries < 4; tries++) {
      const there = at(u + du);
      const px = there.x - there.tz * nv;
      const pz = there.z + there.tx * nv;
      const h = gridHeightAt(grid, px, pz);
      if (Math.abs(h - bedAt(there.t)) <= options.depth * options.bluff) break;
      nv = v + (nv - v) * 0.5 - v * 0.15;
      du = Math.max(du, step * 0.7);
    }
    meanderStats.requested += Math.abs(dv);
    meanderStats.applied += Math.abs(nv - v);
    u += du;
    v = nv;
    s += step;
    const p = at(u);
    points.push([p.x - p.tz * v, p.z + p.tx * v]);
    ts.push(p.t);
    thetas.push(theta);
  }
  points.push([corridor[n - 1]![0], corridor[n - 1]![1]]);
  ts.push(n - 1);
  thetas.push(0);
  // one light pass so the step-wise integration reads as a curve
  for (let i = 1; i < points.length - 1; i++) {
    points[i] = [(points[i - 1]![0] + points[i]![0] * 2 + points[i + 1]![0]) / 4, (points[i - 1]![1] + points[i]![1] * 2 + points[i + 1]![1]) / 4];
  }
  return { points, t: ts, theta: thetas };
}

/** @deprecated the offset meander; kept for reference, replaced by meanderSine. */
function meanderChannel(
  points: [number, number][],
  bed: readonly number[],
  cells: readonly number[],
  grid: WorldGridSample,
  inLake: Uint8Array,
  options: {
    amplitude: number;
    depth: number;
    taper: number;
    along: readonly number[];
    wave: (i: number) => number;
    /** How many channel depths above the bed the ground at the swung point may stand before the swing is halved. */
    bluff: number;
  },
): [number, number][] {
  const last = points.length - 1;
  if (last < 3 || options.amplitude <= 0) return points;
  const moved = points.map((p) => [p[0], p[1]] as [number, number]);
  for (let i = 1; i < last; i++) {
    if (inLake[cells[i]!]) continue;
    const i0 = Math.max(0, i - 3);
    const i1 = Math.min(last, i + 3);
    const grade = (bed[i0]! - bed[i1]!) / Math.max(1, options.along[i1]! - options.along[i0]!);
    // a torrent runs straight; this world's rivers drop 5-7 % over most of
    // their length, so the window is wider than the textbook's or nothing
    // but the last flat reach before the sea would ever bend
    const calm = 1 - smoothstep01((grade - 0.03) / (0.12 - 0.03));
    const grow = options.taper > 0 ? Math.min(1, options.along[i]! / options.taper) : 1;
    // the last few cells before the mouth hold their line, so the meander
    // never swings the channel out of the water it was traced to reach
    const mouthHold = Math.min(1, (last - i) / 3);
    let offset = options.amplitude * calm * (0.35 + 0.65 * grow) * mouthHold * options.wave(i);
    if (Math.abs(offset) < 0.5) continue;
    const a = points[Math.max(0, i - 2)]!;
    const b = points[Math.min(last, i + 2)]!;
    let tx = b[0] - a[0];
    let tz = b[1] - a[1];
    const len = Math.hypot(tx, tz) || 1;
    tx /= len;
    tz /= len;
    const nx = -tz;
    const nz = tx;
    const requested = Math.abs(offset);
    for (let tries = 0; tries < 4; tries++) {
      const h = gridHeightAt(grid, points[i]![0] + nx * offset, points[i]![1] + nz * offset);
      // neither into a hillside nor off a ledge: ground far BELOW the bed
      // would leave the channel perched on a side slope with a levee wall
      if (Math.abs(h - bed[i]!) <= options.depth * options.bluff) break;
      offset *= 0.5;
    }
    meanderStats.requested += requested;
    meanderStats.applied += Math.abs(offset);
    moved[i] = [points[i]![0] + nx * offset, points[i]![1] + nz * offset];
  }
  for (let pass = 0; pass < 2; pass++) {
    const next = moved.map((p) => [p[0], p[1]] as [number, number]);
    for (let i = 1; i < last; i++) {
      next[i] = [
        (moved[i - 1]![0] + moved[i]![0] * 2 + moved[i + 1]![0]) / 4,
        (moved[i - 1]![1] + moved[i]![1] * 2 + moved[i + 1]![1]) / 4,
      ];
    }
    for (let i = 0; i <= last; i++) moved[i] = next[i]!;
  }
  return moved;
}

/** Metres of sideways swing the meander asked for vs. what the hillside check let through, summed over a run. */
const meanderStats = { requested: 0, applied: 0 };

function smoothstep01(t: number): number {
  const x = Math.max(0, Math.min(1, t));
  return x * x * (3 - 2 * x);
}

/**
 * Ramer-Douglas-Peucker in THREE dimensions: plan position plus height.
 *
 * Simplifying in XZ alone is what made roads read as flat causeways. A route
 * that runs straight across rolling hills is, in plan, a straight line — so
 * 2D RDP collapsed it to its two endpoints, and the height profile sampled at
 * those two points became a single linear ramp from one town to the other.
 * The road followed nothing.
 *
 * Including height in the error term keeps a control point wherever the ground
 * actually rises or falls, and still throws away points along a genuinely
 * straight, level run. `heightWeight` converts world-unit height error into
 * the grid-index units the XZ error is measured in, so one knob trades plan
 * fidelity against vertical fidelity.
 */
function simplify3(
  points: [number, number][],
  heights: readonly number[],
  tolerance: number,
  heightWeight: number,
): number[] {
  if (points.length < 3) return points.map((_, i) => i);
  const keep = new Uint8Array(points.length);
  keep[0] = 1;
  keep[points.length - 1] = 1;
  const at = (i: number): [number, number, number] => [points[i]![0], points[i]![1], heights[i]! * heightWeight];
  const stack: [number, number][] = [[0, points.length - 1]];
  while (stack.length > 0) {
    const [first, last] = stack.pop()!;
    let worst = 0;
    let worstIndex = -1;
    const a = at(first);
    const b = at(last);
    for (let i = first + 1; i < last; i++) {
      const d = pointSegmentDistance3(at(i), a, b);
      if (d > worst) {
        worst = d;
        worstIndex = i;
      }
    }
    if (worstIndex >= 0 && worst > tolerance) {
      keep[worstIndex] = 1;
      stack.push([first, worstIndex], [worstIndex, last]);
    }
  }
  const out: number[] = [];
  for (let i = 0; i < points.length; i++) if (keep[i]) out.push(i);
  return out;
}

function pointSegmentDistance3(
  p: [number, number, number],
  a: [number, number, number],
  b: [number, number, number],
): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const dz = b[2] - a[2];
  const lenSq = dx * dx + dy * dy + dz * dz;
  const t = lenSq < 1e-12 ? 0 : Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy + (p[2] - a[2]) * dz) / lenSq));
  return Math.hypot(p[0] - (a[0] + dx * t), p[1] - (a[1] + dy * t), p[2] - (a[2] + dz * t));
}

/** Ramer-Douglas-Peucker on grid coordinates, so a polyline stays readable. */
function simplify(points: [number, number][], tolerance: number): [number, number][] {
  if (points.length < 3) return points;
  const keep = new Uint8Array(points.length);
  keep[0] = 1;
  keep[points.length - 1] = 1;
  const stack: [number, number][] = [[0, points.length - 1]];
  while (stack.length > 0) {
    const [first, last] = stack.pop()!;
    let worst = 0;
    let worstIndex = -1;
    const a = points[first]!;
    const b = points[last]!;
    for (let i = first + 1; i < last; i++) {
      const d = pointSegmentDistance(points[i]!, a, b);
      if (d > worst) {
        worst = d;
        worstIndex = i;
      }
    }
    if (worstIndex >= 0 && worst > tolerance) {
      keep[worstIndex] = 1;
      stack.push([first, worstIndex], [worstIndex, last]);
    }
  }
  return points.filter((_, i) => keep[i] === 1);
}

function pointSegmentDistance(p: [number, number], a: [number, number], b: [number, number]): number {
  const dx = b[0] - a[0];
  const dz = b[1] - a[1];
  const lenSq = dx * dx + dz * dz;
  const t = lenSq < 1e-12 ? 0 : Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dz) / lenSq));
  return Math.hypot(p[0] - (a[0] + dx * t), p[1] - (a[1] + dz * t));
}

// ---------------------------------------------------------------- towns

/**
 * Site towns where a town would actually go: flat, dry, off the beach, not
 * in a swamp, near fresh water or the coast, and spread across every
 * landmass big enough to deserve one. Each term is printed so a world that
 * sites its towns somewhere daft can be diagnosed by reading the numbers.
 */
function commandTowns(): void {
  const { recipe, file } = loadRecipe();
  const field = createWorldField(recipe);
  const extent = extentFor(recipe);
  const radius = option("radius", 45);
  const grid = sampleWorldGrid(field, extent, option("step", 24));
  // default: one town per ~3 km² of land (--per-km2 to change, --count to force)
  let landCells = 0;
  for (let i = 0; i < grid.n * grid.n; i++) if (grid.height[i]! >= recipe.seaLevel) landCells++;
  const landKm2 = (landCells * grid.step * grid.step) / 1e6;
  const count = Math.round(option("count", Math.max(4, landKm2 * option("per-km2", 0.35))));
  console.log(`  ${landKm2.toFixed(1)} km² of land -> ${count} towns`);
  const minSeparation = option("separation", Math.max(radius * 8, extent / Math.max(3, Math.sqrt(count)) / 1.6));
  const n = grid.n;

  // water cells for the proximity score
  const waterCells: number[] = [];
  for (const river of recipe.features.rivers) for (let i = 0; i < river.points.length; i += 2) waterCells.push(grid.nearest(river.points[i]![0], river.points[i]![1]));
  for (const lake of recipe.features.lakes) waterCells.push(grid.nearest(lake.center[0], lake.center[1]));
  const waterX = waterCells.map((c) => grid.worldX(c % n));
  const waterZ = waterCells.map((c) => grid.worldZ((c / n) | 0));

  const landmass = landComponentsOf(grid.height, n, recipe.seaLevel);
  const landArea = new Map<number, number>();
  for (let i = 0; i < n * n; i++) if (landmass[i]! > 0) landArea.set(landmass[i]!, (landArea.get(landmass[i]!) ?? 0) + 1);

  const probe = Math.max(2, Math.round(radius / grid.step));
  const scored: { x: number; z: number; score: number; flat: number; water: number; ground: number; mass: number }[] = [];
  for (let iz = probe; iz < n - probe; iz += 1) {
    for (let ix = probe; ix < n - probe; ix += 1) {
      const i = ix + iz * n;
      const h = grid.height[i]!;
      if (h < recipe.seaLevel + 3 || h > recipe.seaLevel + 110) continue;
      if (grid.shore[i]! < 70) continue; // off the beach
      if (grid.swamp[i]! > 0.4) continue; // nobody builds in a bog
      let slopeSum = 0;
      let min = Infinity;
      let max = -Infinity;
      let samples = 0;
      let wet = 0;
      for (let dz = -probe; dz <= probe; dz += 1) {
        for (let dx = -probe; dx <= probe; dx += 1) {
          const j = ix + dx + (iz + dz) * n;
          const hh = grid.height[j]!;
          const gx = (grid.height[j + 1]! - grid.height[j - 1]!) / (2 * grid.step);
          const gz = (grid.height[j + n]! - grid.height[j - n]!) / (2 * grid.step);
          const g = Math.hypot(gx, gz);
          slopeSum += g / Math.sqrt(1 + g * g);
          if (hh < min) min = hh;
          if (hh > max) max = hh;
          if (hh < recipe.seaLevel + 0.5) wet++;
          samples += 1;
        }
      }
      if (wet > 0) continue;
      const meanSlope = slopeSum / samples;
      const spread = max - min;
      if (meanSlope > 0.22 || spread > 16) continue;
      const x = grid.worldX(ix);
      const z = grid.worldZ(iz);
      if (field.waterY(x, z) !== null) continue;
      let nearest = Infinity;
      for (let k = 0; k < waterX.length; k++) nearest = Math.min(nearest, Math.hypot(waterX[k]! - x, waterZ[k]! - z));
      const coast = Math.max(0, 1 - Math.max(0, grid.shore[i]! - 70) / 400);
      const fresh = nearest === Infinity ? 0 : Math.max(0, 1 - nearest / 350);
      const water = Math.max(fresh, coast * 0.8);
      const flat = 1 - meanSlope / 0.22;
      const score = flat * 2 + water * 1.6 + (1 - Math.abs(h - recipe.seaLevel - 20) / 90);
      scored.push({ x, z, score, flat, water, ground: (min + max) / 2, mass: landmass[i]! });
    }
  }
  if (scored.length === 0) fail("no buildable ground found — widen --extent or soften the terrain");
  scored.sort((a, b) => b.score - a.score);

  const towns: TownDoc[] = [];
  const masses = new Set<number>();
  const place = (site: (typeof scored)[number]): void => {
    masses.add(site.mass);
    towns.push({
      id: `town-${towns.length + 1}`,
      center: [round(site.x), round(site.z)],
      radius,
      falloff: radius * 0.8,
      groundY: round(site.ground),
      flatten: 0.95,
      tags: towns.length === 0 ? ["capital"] : ["village"],
    });
    console.log(
      `  ${towns[towns.length - 1]!.id}: [${round(site.x)}, ${round(site.z)}] ground ${round(site.ground)}  ` +
        `flat ${site.flat.toFixed(2)} water ${site.water.toFixed(2)} landmass ${site.mass}`,
    );
  };
  const clearOf = (site: (typeof scored)[number]): boolean =>
    towns.every((t) => Math.hypot(t.center[0] - site.x, t.center[1] - site.z) > minSeparation);

  // every landmass over ~1.5 km² gets a town before the best sites are filled in
  const bigMasses = [...landArea.entries()].filter(([, cells]) => cells * grid.step * grid.step > 1.5e6).map(([id]) => id);
  for (const mass of bigMasses) {
    if (towns.length >= count) break;
    const best = scored.find((site) => site.mass === mass && clearOf(site));
    if (best) place(best);
  }
  for (const site of scored) {
    if (towns.length >= count) break;
    if (clearOf(site)) place(site);
  }

  recipe.features.towns = towns;
  writeRecipe(recipe, file);
  console.log(`sited ${towns.length} towns across ${masses.size} landmasses`);
}

/** Flood-fill land (8-connected, above sea level) into components. 0 = water. */
function landComponentsOf(height: Float32Array, n: number, seaLevel: number): Int32Array {
  const out = new Int32Array(n * n);
  let next = 1;
  const stack: number[] = [];
  for (let start = 0; start < out.length; start++) {
    if (out[start] !== 0) continue;
    if (height[start]! < seaLevel) continue;
    const id = next++;
    out[start] = id;
    stack.push(start);
    while (stack.length > 0) {
      const cell = stack.pop()!;
      const ix = cell % n;
      const iz = (cell / n) | 0;
      for (const [dx, dz] of NEIGHBORS) {
        const nx = ix + dx;
        const nz = iz + dz;
        if (nx < 0 || nz < 0 || nx >= n || nz >= n) continue;
        const ni = nx + nz * n;
        if (out[ni] !== 0 || height[ni]! < seaLevel) continue;
        out[ni] = id;
        stack.push(ni);
      }
    }
  }
  return out;
}

function round(v: number): number {
  return Math.round(v * 100) / 100;
}

// ---------------------------------------------------------------- roads

/** The grid every route is searched on: heights with all features, water as walls, rivers tolled. */
function routeGridFor(field: WorldField, recipe: WorldRecipe, grid: WorldGridSample): RouteGrid {
  const n = grid.n;
  const total = n * n;
  const cost = new Float32Array(total).fill(1);
  const river = new Float32Array(total);
  // lakes and the sea are walls; rivers are crossable at a toll
  for (let i = 0; i < total; i++) {
    if (grid.height[i]! < recipe.seaLevel + 0.5) cost[i] = Infinity;
    else if (grid.swamp[i]! > 0.3) cost[i] = 1 + grid.swamp[i]! * 2.2;
    else if (grid.dunes[i]! > 0.3) cost[i] = 1.25;
  }
  for (const lake of recipe.features.lakes) {
    const outline = lake.polygon ?? [];
    let minX = Infinity;
    let minZ = Infinity;
    let maxX = -Infinity;
    let maxZ = -Infinity;
    if (outline.length >= 3) {
      for (const [x, z] of outline) {
        minX = Math.min(minX, x);
        maxX = Math.max(maxX, x);
        minZ = Math.min(minZ, z);
        maxZ = Math.max(maxZ, z);
      }
    } else {
      minX = lake.center[0] - lake.radius;
      maxX = lake.center[0] + lake.radius;
      minZ = lake.center[1] - lake.radius;
      maxZ = lake.center[1] + lake.radius;
    }
    for (let z = minZ - lake.bank; z <= maxZ + lake.bank; z += grid.step) {
      for (let x = minX - lake.bank; x <= maxX + lake.bank; x += grid.step) {
        // only ground that is actually under the surface: waterY also reports
        // a lake over the dry half-bank beyond its outline (the sheet is drawn
        // that wide), and walling that band cut lakeside towns off entirely
        const w = field.waterY(x, z);
        const c = grid.nearest(x, z);
        if (w !== null && grid.height[c]! < w) cost[c] = Infinity;
      }
    }
  }
  // The banks: dearer to travel, so a road keeps off them unless it is
  // crossing. A road that ran along a river inside its bank band regraded
  // the bank into a beach (its embankment reached into the channel), and a
  // bank is soft ground anyway.
  const nearBank = new Uint8Array(total);
  for (const r of recipe.features.rivers) {
    const reach = Math.ceil((r.width / 2 + r.bank) / grid.step);
    for (let i = 0; i + 1 < r.points.length; i++) {
      const a = r.points[i]!;
      const b = r.points[i + 1]!;
      const steps = Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / grid.step) + 1;
      for (let s = 0; s <= steps; s++) {
        const t = s / steps;
        const c = grid.nearest(a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t);
        river[c] = Math.max(river[c]!, r.width);
        const cx = c % n;
        const cz = (c / n) | 0;
        for (let dz = -reach; dz <= reach; dz++) {
          for (let dx = -reach; dx <= reach; dx++) {
            if (dx * dx + dz * dz > reach * reach) continue;
            const x = cx + dx;
            const z = cz + dz;
            if (x < 0 || z < 0 || x >= n || z >= n) continue;
            nearBank[x + z * n] = 1;
          }
        }
      }
    }
  }
  for (let i = 0; i < total; i++) if (nearBank[i] && river[i] === 0 && Number.isFinite(cost[i]!)) cost[i] = cost[i]! * 1.6;
  // The ground's gradient per cell, for the cross-slope cap: the larger
  // one-sided difference on each axis (a cliff inside one cell must not be
  // halved by a central difference), signed by the central one.
  const gradX = new Float32Array(total);
  const gradZ = new Float32Array(total);
  const h = grid.height;
  for (let z = 0; z < n; z++) {
    for (let x = 0; x < n; x++) {
      const i = x + z * n;
      const xm = h[Math.max(0, x - 1) + z * n]!;
      const xp = h[Math.min(n - 1, x + 1) + z * n]!;
      const zm = h[x + Math.max(0, z - 1) * n]!;
      const zp = h[x + Math.min(n - 1, z + 1) * n]!;
      const mx = Math.max(Math.abs(xp - h[i]!), Math.abs(h[i]! - xm)) / grid.step;
      const mz = Math.max(Math.abs(zp - h[i]!), Math.abs(h[i]! - zm)) / grid.step;
      gradX[i] = xp >= xm ? mx : -mx;
      gradZ[i] = zp >= zm ? mz : -mz;
    }
  }
  // town pads and their ramps are exempt from the hard grade cap: a pad
  // edge is a 17 % step on this grid, and every road starts on one
  const exempt = new Uint8Array(total);
  for (const town of recipe.features.towns) {
    const reach = town.radius + town.falloff + grid.step;
    const cells = Math.ceil(reach / grid.step);
    const c = grid.nearest(town.center[0], town.center[1]);
    const cx = c % n;
    const cz = (c / n) | 0;
    for (let dz = -cells; dz <= cells; dz++) {
      for (let dx = -cells; dx <= cells; dx++) {
        if (dx * dx + dz * dz > cells * cells) continue;
        const x = cx + dx;
        const z = cz + dz;
        if (x >= 0 && z >= 0 && x < n && z < n) exempt[x + z * n] = 1;
      }
    }
  }
  return { n, step: grid.step, height: grid.height, cost, river, gradX, gradZ, exempt };
}

/**
 * Route with a hard grade cap, relaxing it only if the cap leaves no route
 * at all: a road that must reach a town on a plateau ringed by cliffs gets
 * its cut, every other road contours. The ends are exempt — `endRadius`
 * cells around the start and the goal, plus the grid's own exemptions —
 * because the last cone up to a summit is steeper than any trail and a
 * cap that fails there fails the whole route. Returns the cap it managed with.
 */
function routeWithGradeCap(
  routeGrid: RouteGrid,
  from: number,
  to: number,
  options: RouteOptions,
  endRadius: number,
  policy: {
    /** Multiples of `maxGrade` to try as the hard cap, in order; `undefined` = uncapped (a path that MUST arrive). */
    caps?: (number | undefined)[];
    /** The cap inside the exempt end zones, as a multiple of `maxGrade` (absent = uncapped there, the old behaviour). */
    exempt?: number;
    /** After every cap fails, take the route to the nearest reachable cell under the LAST cap instead of giving up. */
    partial?: boolean;
    /** Cells round the goal flooded exhaustively before that choice (RouteOptions.partialRadius). */
    partialRadius?: number;
  } = {},
): { route: number[] | null; cap: number | undefined; reached: boolean } {
  const n = routeGrid.n;
  const exempt = routeGrid.exempt ? Uint8Array.from(routeGrid.exempt) : new Uint8Array(n * n);
  for (const centre of [from, to]) {
    const cx = centre % n;
    const cz = (centre / n) | 0;
    for (let dz = -endRadius; dz <= endRadius; dz++) {
      for (let dx = -endRadius; dx <= endRadius; dx++) {
        if (dx * dx + dz * dz > endRadius * endRadius) continue;
        const x = cx + dx;
        const z = cz + dz;
        if (x >= 0 && z >= 0 && x < n && z < n) exempt[x + z * n] = 1;
      }
    }
  }
  const caps = (policy.caps ?? [1.5, 2.5, 4, undefined]).map((m) => (m === undefined ? undefined : options.maxGrade * m));
  const exemptGrade = policy.exempt === undefined ? undefined : options.maxGrade * policy.exempt;
  for (const cap of caps) {
    const route = routeBetween(routeGrid, from, to, { ...options, hardGrade: cap, hardGradeExempt: exempt, exemptGrade });
    if (route) return { route, cap, reached: true };
  }
  if (policy.partial) {
    const cap = caps[caps.length - 1];
    const route = routeBetween(routeGrid, from, to, { ...options, hardGrade: cap, hardGradeExempt: exempt, exemptGrade, partial: true, partialRadius: policy.partialRadius });
    if (route) return { route, cap, reached: false };
  }
  return { route: null, cap: undefined, reached: false };
}

/**
 * What a footpath is painted with: `--surface` (dirt) everywhere, except that
 * every biome whose ground is mostly SNOW gets gravel — a dirt track across a
 * snowfield reads as mud, a gravel one as the trodden stone it would be. The
 * palette must have gravel for that to happen; `--surface-by-biome
 * alpine=gravel,tundra=rock` names the swaps by hand.
 */
function pathSurfaces(recipe: WorldRecipe): { surface: string; surfaceByBiome: Record<string, string> | undefined } {
  const has = (name: string): boolean => recipe.surfaces.some((sf) => sf.name.toLowerCase() === name.toLowerCase());
  const surface = stringOption("surface", has("dirt") ? "dirt" : (recipe.surfaces[0]?.name ?? ""));
  const byBiome: Record<string, string> = {};
  const explicit = stringOption("surface-by-biome", "");
  if (explicit) {
    for (const pair of explicit.split(",")) {
      const [biome, name] = pair.split("=").map((t) => t.trim());
      if (!biome || !name) fail(`--surface-by-biome wants biome=surface pairs, got "${pair}"`);
      if (!recipe.biomes.some((b) => b.id === biome)) fail(`--surface-by-biome: no biome "${biome}" in the recipe`);
      if (!has(name)) fail(`--surface-by-biome: no surface "${name}" in the palette`);
      byBiome[biome] = name;
    }
  } else if (has("gravel")) {
    for (const biome of recipe.biomes) {
      let top = -1;
      let topWeight = 0;
      biome.surface.forEach((w, i) => {
        if (w > topWeight) {
          topWeight = w;
          top = i;
        }
      });
      const name = top >= 0 ? recipe.surfaces[top]?.name.toLowerCase() : "";
      if (name === "snow") byBiome[biome.id] = "gravel";
    }
  }
  const keys = Object.keys(byBiome).filter((k) => byBiome[k]!.toLowerCase() !== surface.toLowerCase());
  return { surface, surfaceByBiome: keys.length > 0 ? Object.fromEntries(keys.map((k) => [k, byBiome[k]!])) : undefined };
}

/** A dense route into a graded road document. */
function roadFrom(
  id: string,
  route: readonly number[],
  grid: WorldGridSample,
  field: WorldField,
  routeGrid: RouteGrid,
  options: {
    width: number;
    maxGrade: number;
    maxFill: number;
    maxCut: number;
    surface?: string;
    surfaceByBiome?: Record<string, string>;
    pinStart?: number;
    pinEnd?: number;
    /** [1 2 1] passes over the dense route in plan; 0 keeps the grid's own corners. */
    smoothPasses?: number;
    /** How far under the water surface a crossing's roadway sits. */
    fordDepth?: number;
    /** Which clamp wins at the end of the profile solve: `grade` for a road, `cut` for a footpath (see solveProfile). */
    finalClamp?: "grade" | "cut";
    /** Rivers at least this wide are bridged; narrower ones are forded. */
    bridgeMin?: number;
    /** Deck height over the water. */
    bridgeClearance?: number;
  },
): { roads: RoadDoc[]; bridges: BridgeDoc[] } {
  const n = grid.n;
  const step = grid.step;
  // Round the corners in plan FIRST, then take the ground where the road
  // actually runs: a route that is smoothed after its profile is solved has
  // heights from a different line than the one it draws.
  const raw = route.map((c) => [grid.worldX(c % n), grid.worldZ((c / n) | 0)] as [number, number]);
  const passable = (x: number, z: number): boolean => Number.isFinite(routeGrid.cost[grid.nearest(x, z)]!);
  const points = smoothRoute(raw, options.smoothPasses ?? 2, passable);
  const natural = points.map((p, i) => (options.smoothPasses === 0 ? grid.height[route[i]!]! : field.height(p[0], p[1])));
  const spans = points.map((pt, i) => (i === 0 ? 0 : Math.hypot(pt[0] - points[i - 1]![0], pt[1] - points[i - 1]![1])));
  // Fords. Where the route crosses water the surface is pinned just under
  // it, so the road neither follows the channel down into the bed (a road
  // under two metres of river) nor rides over it as a dam; the field keeps
  // the roadway and shoulder there and drops the embankment band. The
  // water level is taken from a little around each point too, so the
  // submerged part of the bank counts as the crossing as well as the bed.
  const fordDepth = options.fordDepth ?? 0.4;
  const waterAt = (p: readonly [number, number]): number | null => {
    let water: number | null = null;
    for (const [ox, oz] of [[0, 0], [6, 0], [-6, 0], [0, 6], [0, -6]] as const) {
      const w = field.waterY(p[0] + ox, p[1] + oz);
      if (w !== null && (water === null || w > water)) water = w;
    }
    return water;
  };
  const pins: (number | undefined)[] = points.map((p, i) => {
    const water = waterAt(p);
    return water !== null && natural[i]! < water - fordDepth ? water - fordDepth : undefined;
  });
  // Bridges. Where the route crosses a river at least `bridgeMin` wide the
  // road does not ford it: the profile over the crossing is pinned to a
  // deck height clear of the water, the road is SPLIT at the two abutments
  // (one route point back from the water on each bank), and a bridge
  // feature spans the gap. The water underneath is left alone — a road
  // carve there keeps the roadway and shoulder even in water, which is
  // what a ford is, and over a real river that is a dam. The deck is a
  // placeholder for the WFC bridge builder; the abutments and the deck
  // height are the contract it builds to.
  const bridgeMin = options.bridgeMin ?? 6;
  const clearance = options.bridgeClearance ?? 1.2;
  const rivers = field.recipe.features.rivers;
  const crossing = points.map((p) => {
    const near = nearestRiverAt(rivers, p);
    if (!near || near.width < bridgeMin || near.along < near.river.taper * 0.5) return -1;
    return near.distance <= near.half + near.bank * 0.63 + 1 ? near.index : -1;
  });
  const crossings: { river: number; start: number; end: number }[] = [];
  crossing.forEach((river, i) => {
    if (river < 0) return;
    const last = crossings[crossings.length - 1];
    if (last && last.river === river && i - last.end <= 2) last.end = i;
    else crossings.push({ river, start: i, end: i });
  });
  const bridged: { river: number; start: number; end: number; waterY: number }[] = [];
  for (const s of crossings) {
    const start = s.start - 1;
    const end = s.end + 1;
    // a crossing at either end of the route (a town on the bank) stays a
    // ford, as does a run long enough to be the road following the bank
    // rather than crossing the water, and one overlapping the last bridge
    if (start < 1 || end > points.length - 2 || end - start > 8) continue;
    const prev = bridged[bridged.length - 1];
    if (prev && start <= prev.end) continue;
    let waterY = -Infinity;
    for (let i = start; i <= end; i++) waterY = Math.max(waterY, waterAt(points[i]!) ?? -Infinity);
    if (!Number.isFinite(waterY)) continue;
    // the deck sits on the LOWER bank (the higher one is cut down to it)
    // and never less than the clearance over the water
    const deckY = round(Math.max(waterY + clearance, Math.min(natural[start]!, natural[end]!)));
    for (let i = start; i <= end; i++) pins[i] = deckY;
    bridged.push({ river: s.river, start, end, waterY });
  }
  const surfaceY = solveProfile(
    natural,
    spans,
    { maxGrade: options.maxGrade, maxFill: options.maxFill, maxCut: options.maxCut, finalClamp: options.finalClamp },
    { start: options.pinStart, end: options.pinEnd, at: pins },
  );
  // keep a control point wherever the road bends or the profile moves by more
  // than half a metre: a road is only as smooth as its densest stretch.
  // Tolerance in grid units (0.25 of a 16 m cell is 4 m of plan drift, so a
  // rounded corner keeps enough points to read as a curve at road width);
  // heightWeight converts metres of profile error into the same units, so a
  // point is kept wherever the road would otherwise drift more than half a
  // metre from its solved profile
  // The shoulder and the embankment band beyond it: the ground out to
  // `outer` is regraded into a clean slope from the road edge to the sampled
  // height there, so the road is not a notch in whatever crinkle was there.
  // These used to be 1.25w+2 and 1.5w+4 — a 57 m corridor for a 7 m road —
  // and at that width the "clean slope" was a planar cut face thirty metres
  // tall on any hillside, and the bands of a switchback's two legs overlapped.
  // Half a width of shoulder and a width of embankment is a road, not a
  // motorway cutting.
  // …and never finer than the voxel grid can draw: a 2.2 m shoulder on a
  // 2 m voxel mesh is a one-sample feature, and along a diagonal path the
  // samples fall alternately on the tread, the shoulder and the bank — a
  // washboard. A blend at least a voxel and a half wide is what the mesh
  // can reproduce; the painted tread stays as narrow as the path.
  const voxel = field.recipe.cellSize / field.recipe.resolution;
  const shoulder = round(Math.max(options.width * 0.5 + 1, voxel * 1.5));
  const smooth = round(Math.max(options.width + 2, voxel * 2.5));
  const outer = options.width / 2 + shoulder + smooth;
  const blurRadius = smooth * 0.5;
  /** Ground height near (x, z) with the fine detail averaged out — five taps over the blur radius. */
  const blurred = (x: number, z: number): number =>
    (field.height(x, z) +
      field.height(x + blurRadius, z) +
      field.height(x - blurRadius, z) +
      field.height(x, z + blurRadius) +
      field.height(x, z - blurRadius)) /
    5;
  /** One road document from the dense route between indices a and b (inclusive). */
  const piece = (pieceId: string, a: number, b: number): RoadDoc | null => {
    if (b - a < 1) return null;
    const pts = points.slice(a, b + 1);
    const ys = surfaceY.slice(a, b + 1);
    const keep = simplify3(
      pts.map((p) => [p[0] / step, p[1] / step] as [number, number]),
      ys,
      0.25,
      0.25 / 0.5,
    );
    const leftY: number[] = [];
    const rightY: number[] = [];
    for (let k = 0; k < keep.length; k++) {
      const i = keep[k]!;
      const prev = pts[keep[Math.max(0, k - 1)]!]!;
      const next = pts[keep[Math.min(keep.length - 1, k + 1)]!]!;
      let dx = next[0] - prev[0];
      let dz = next[1] - prev[1];
      const len = Math.hypot(dx, dz) || 1;
      dx /= len;
      dz /= len;
      // left is the positive cross-product side of the travel direction — the
      // convention the field decodes with
      const p = pts[i]!;
      leftY.push(round(blurred(p[0] - dz * outer, p[1] + dx * outer)));
      rightY.push(round(blurred(p[0] + dz * outer, p[1] - dx * outer)));
    }
    return {
      id: pieceId,
      points: keep.map((i) => [round(pts[i]![0]), round(pts[i]![1])] as [number, number]),
      width: options.width,
      shoulder,
      surfaceY: keep.map((i) => round(ys[i]!)),
      smooth,
      leftY,
      rightY,
      flatten: 1,
      surface: options.surface ?? "dirt",
      surfaceEdge: options.width > 4 ? 2.5 : 1.5,
      ...(options.surfaceByBiome ? { surfaceByBiome: options.surfaceByBiome } : {}),
    };
  };
  const roads: RoadDoc[] = [];
  const bridges: BridgeDoc[] = [];
  let from = 0;
  bridged.forEach((s, k) => {
    const road = piece(k === 0 ? id : `${id}.${k + 1}`, from, s.start);
    if (road) roads.push(road);
    const a = points[s.start]!;
    const b = points[s.end]!;
    bridges.push({
      id: `bridge-${id}-${k + 1}`,
      points: [
        [round(a[0]), round(a[1])],
        [round(b[0]), round(b[1])],
      ],
      width: options.width,
      deckY: round(surfaceY[s.start]!),
      thickness: options.width > 4 ? 0.6 : 0.3,
      river: rivers[s.river]!.id,
      waterY: round(s.waterY),
      tags: [],
    });
    from = s.end;
  });
  const tail = piece(bridged.length === 0 ? id : `${id}.${bridged.length + 1}`, from, points.length - 1);
  if (tail) roads.push(tail);
  return { roads, bridges };
}

/**
 * The river nearest a point, with the channel's LOCAL width and bank there
 * (the same rule as the field's riverBank): what a route needs to know to
 * tell a brook it can ford from a river it must bridge.
 */
function nearestRiverAt(
  rivers: readonly RiverDoc[],
  p: readonly [number, number],
): { index: number; river: RiverDoc; distance: number; width: number; half: number; bank: number; along: number } | null {
  let best: { index: number; river: RiverDoc; distance: number; width: number; half: number; bank: number; along: number } | null = null;
  rivers.forEach((river, index) => {
    const widths = river.widths && river.widths.length === river.points.length ? river.widths : null;
    let along = 0;
    for (let i = 0; i + 1 < river.points.length; i++) {
      const a = river.points[i]!;
      const b = river.points[i + 1]!;
      const dx = b[0] - a[0];
      const dz = b[1] - a[1];
      const len = Math.hypot(dx, dz);
      const l = dx * dx + dz * dz;
      const t = l < 1e-9 ? 0 : Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dz) / l));
      const d = Math.hypot(p[0] - (a[0] + dx * t), p[1] - (a[1] + dz * t));
      if (!best || d < best.distance) {
        const width = widths ? widths[i]! + (widths[i + 1]! - widths[i]!) * t : river.width;
        best = { index, river, distance: d, width, half: width / 2, bank: Math.min(river.bank, 0.7 * width + 3), along: along + len * t };
      }
      along += len;
    }
  });
  return best;
}

/**
 * Connect the towns with footpaths that follow the ground.
 *
 * The route is a least-cost search whose cost punishes GRADE far more than
 * distance, so a road goes around a hill or switchbacks up it rather than
 * over it; water is a wall and a river crossing carries a toll, so crossings
 * are few and where a bridge would be. The profile is then solved on the
 * DENSE route with fill capped at a metre — see worldgen-routing.mts for why
 * that, and not the field, is what stopped roads being causeways.
 *
 * The path graph is a minimum spanning tree per landmass (everywhere
 * reachable, no redundancy) plus the shortest few extra links, because a
 * pure tree makes every journey pass through the capital.
 *
 * These were 6 m graded ROADS until 2026-09-04: a wide cut with a 15 m
 * corridor of embankment looked like earthworks on every hillside, and the
 * 2.4 m trails cut for the peaks looked like the world had been walked in.
 * So the town links are now built the way a trail is — narrow, steeper, a
 * cut-only clamp so the path steepens where the ground does rather than
 * digging a trench to stay drivable — and there is nothing a "road" does
 * that a path does not. `worldgen roads` is kept as an alias.
 */
function commandPaths(): void {
  const { recipe, file } = loadRecipe();
  const towns = recipe.features.towns;
  if (towns.length < 2) fail("need at least two towns — run: worldgen towns <world>");
  recipe.features.roads = recipe.features.roads.filter((r) => r.id.startsWith("trail-"));
  recipe.features.bridges = recipe.features.bridges.filter((b) => b.id.startsWith("bridge-trail-"));
  const field = createWorldField(recipe);
  const extent = extentFor(recipe);
  const grid = sampleWorldGrid(field, extent, option("step", 16));
  const routeGrid = routeGridFor(field, recipe, grid);
  const maxGrade = option("max-grade", 0.18);
  const bridges: BridgeDoc[] = [];
  const paint = pathSurfaces(recipe);
  if (paint.surfaceByBiome) console.log(`  surface ${paint.surface}; ${Object.entries(paint.surfaceByBiome).map(([b, sf]) => `${sf} across ${b}`).join(", ")}`);

  // Towns on different islands cannot be joined by a road, and a spanning tree
  // that does not know that produces roads striding across open ocean.
  const landmass = landComponentsOf(grid.height, grid.n, recipe.seaLevel);
  const groups = new Map<number, number[]>();
  towns.forEach((town, index) => {
    const id = landmass[grid.nearest(town.center[0], town.center[1])]!;
    const list = groups.get(id);
    if (list) list.push(index);
    else groups.set(id, [index]);
  });
  if (groups.size > 1) console.log(`  towns sit on ${groups.size} separate landmasses — roading each independently`);

  const edges: [number, number][] = [];
  for (const members of groups.values()) {
    const local = spanningEdges(
      members.map((i) => towns[i]!),
      option("extra", 2),
    );
    for (const [a, b] of local) edges.push([members[a]!, members[b]!]);
  }

  // a town centre is never a wall, whatever water its pad now touches: a
  // goal cell the search cannot step into fails every cap and the road is
  // simply missing
  for (const town of towns) {
    const c = grid.nearest(town.center[0], town.center[1]);
    if (!Number.isFinite(routeGrid.cost[c]!)) routeGrid.cost[c] = 1;
  }
  const paths: RoadDoc[] = [];
  for (const [a, b] of edges) {
    const from = grid.nearest(towns[a]!.center[0], towns[a]!.center[1]);
    const to = grid.nearest(towns[b]!.center[0], towns[b]!.center[1]);
    const t0 = performance.now();
    // each 45° bend costs as much as 24 m of path, and a path may bend by at
    // most one of them per cell: a hairpin is four bends over four cells.
    // The grade is capped HARD at 1.5× the design grade per step, so the
    // search contours round a hill (or spirals up it) instead of taking a
    // steep step the profile would then have to cut through. The two cells
    // round each town pad are exempt up to a 3× scramble (a pad edge is a
    // 17 % step on a 16 m grid). The ladder stops at 4×: an uncapped last
    // resort once joined two towns with a path climbing a cliff at 150 %,
    // and an unlinked pair (logged below) is better than that.
    const { route, cap } = routeWithGradeCap(routeGrid, from, to, {
      maxGrade,
      gradeWeight: 12,
      riverToll: 420,
      turnWeight: option("turn-weight", 24),
      maxTurn: option("max-turn", 1),
      maxExpansions: 1500000,
      maxCross: option("max-cross", 1.0),
      crossWeight: 3,
    }, 2, { caps: [1.5, 2.5, 4], exempt: 3 });
    if (!route) {
      console.warn(`  no route between ${towns[a]!.id} and ${towns[b]!.id} within ${(maxGrade * 400).toFixed(0)} % — left unlinked`);
      continue;
    }
    const built = roadFrom(`path-${towns[a]!.id}-${towns[b]!.id}`, route, grid, field, routeGrid, {
      width: option("width", 2.4),
      maxGrade,
      // a footpath follows the ground: the cut/fill clamp wins over the
      // grade clamp, so it steepens on a spur instead of trenching through it
      finalClamp: "cut",
      maxFill: option("max-fill", 0.8),
      maxCut: option("max-cut", 3),
      pinStart: towns[a]!.groundY,
      pinEnd: towns[b]!.groundY,
      smoothPasses: option("smooth-passes", 2),
      bridgeMin: option("bridge-min", 6),
      surface: paint.surface,
      surfaceByBiome: paint.surfaceByBiome,
    });
    paths.push(...built.roads);
    bridges.push(...built.bridges);
    const len = (route.length * grid.step) / 1000;
    const relaxed = cap === undefined ? ", grade cap DROPPED" : cap > maxGrade * 2 ? ", grade cap relaxed" : "";
    const spans = built.bridges.length > 0 ? `, ${built.bridges.length} bridge${built.bridges.length > 1 ? "s" : ""}` : "";
    const pts = built.roads.reduce((n, r) => n + r.points.length, 0);
    console.log(`  ${built.roads[0]?.id ?? "path"}: ${pts} points, ${len.toFixed(1)} km${spans}${relaxed} (${((performance.now() - t0) / 1000).toFixed(1)}s)`);
  }

  recipe.features.roads = [...paths, ...recipe.features.roads];
  recipe.features.bridges = [...bridges, ...recipe.features.bridges];
  if (bridges.length > 0 && !recipe.bridgeMaterial) {
    // a plain timber deck for the placeholder spans
    const id = `${recipe.name}-bridge`;
    writeFlatMaterial(id, "#6f5236");
    recipe.bridgeMaterial = id;
  }
  writeRecipe(recipe, file);
  console.log(`cut ${paths.length} path pieces, ${bridges.length} bridges`);
  console.log(`  ${auditWorld(recipe, createWorldField(recipe)).summary}`);
}

/**
 * Trails: footpaths from the path network up to the peaks (and other POIs).
 * This is what makes a mountain climbable on purpose — the ridge you can
 * walk is the one the trail found, and the faces it avoided stay cliffs.
 *
 * The cap ladder is 1.5×, 2.5×, 4× the design grade (33 / 55 / 88 % for a
 * 22 % trail — the last is a hands-on climb, and the voxel summits are
 * terraced crags that nothing gentler reaches) and STOPS there: the old
 * uncapped rung, and the uncapped exemption round the summit, put forty
 * trails in the demo up a 300-500 % wall for their last leg. The four cells
 * round the summit are exempt only up to `--scramble` × the design grade
 * (4× = 88 %). A summit no 88 % step reaches gets a trail to the highest
 * walkable point in the 640 m round it (`--partial-radius` cells) instead
 * of a cliff, and the log says how far below the top it ends.
 */
function commandTrails(): void {
  const { recipe, file } = loadRecipe();
  recipe.features.roads = recipe.features.roads.filter((r) => !r.id.startsWith("trail-"));
  recipe.features.bridges = recipe.features.bridges.filter((b) => !b.id.startsWith("bridge-trail-"));
  const trailBridges: BridgeDoc[] = [];
  const kinds = stringOption("to", "peak").split(",").map((k) => k.trim());
  // the highest first, capped: a trail to every one of two hundred peaks is a
  // road network, not a set of climbs
  const targets = recipe.features.pois
    .filter((p) => kinds.includes(p.kind))
    .sort((a, b) => b.position[1] - a.position[1])
    .slice(0, Math.round(option("max", 40)));
  if (targets.length === 0) fail(`no POIs of kind ${kinds.join("/")} — run: worldgen pois <world>`);
  const field = createWorldField(recipe);
  const extent = extentFor(recipe);
  const grid = sampleWorldGrid(field, extent, option("step", 16));
  const routeGrid = routeGridFor(field, recipe, grid);
  const maxGrade = option("max-grade", 0.22);
  const n = grid.n;
  const paint = pathSurfaces(recipe);
  if (paint.surfaceByBiome) console.log(`  surface ${paint.surface}; ${Object.entries(paint.surfaceByBiome).map(([b, sf]) => `${sf} across ${b}`).join(", ")}`);

  // attach to the nearest point of the path network (towns included) on the
  // SAME landmass — a peak on an island must not try to reach the mainland
  const landmass = landComponentsOf(grid.height, n, recipe.seaLevel);
  const network: number[][] = recipe.features.roads.map((r) => r.points.map((pt) => grid.nearest(pt[0], pt[1])));
  network.push(recipe.features.towns.map((t) => grid.nearest(t.center[0], t.center[1])));
  if (network.every((r) => r.length === 0)) fail("no paths or towns to start a trail from");

  const trails: RoadDoc[] = [];
  for (const poi of targets) {
    const goal = grid.nearest(poi.position[0], poi.position[2]);
    const mass = landmass[goal]!;
    const local = network.map((r) => r.filter((c) => landmass[c] === mass)).filter((r) => r.length > 0);
    if (local.length === 0) {
      console.warn(`  ${poi.id} is on a landmass with no paths or towns — no trail`);
      continue;
    }
    const start = nearestRouteCell(n, local, goal);
    if (start < 0) continue;
    const t0 = performance.now();
    // the same one-bend-per-cell radius as a road. Two bends per cell was
    // tried: a footpath allowed to corner at 90° corkscrews up a peak in
    // 300°+ of turning inside 120 m — every remaining loop in the demo was a
    // trail — and a trail's steeper grade allowance means it needs fewer
    // bends anyway, not tighter ones
    // and never across a hillside steeper than --max-cross: the grade cap
    // looks along the path, and a trail traversing a 65° face at 20 % left
    // a 17 m cut wall beside it (the "thorns" along every climb)
    const { route, cap, reached } = routeWithGradeCap(routeGrid, start, goal, {
      maxGrade,
      gradeWeight: 7,
      riverToll: 200,
      maxExpansions: 400000,
      turnWeight: option("turn-weight", 20),
      maxTurn: option("max-turn", 1),
      maxCross: option("max-cross", 1.0),
      crossWeight: 3,
    }, 4, { caps: [1.5, 2.5, 4], exempt: option("scramble", 4), partial: true, partialRadius: Math.round(option("partial-radius", 40)) });
    if (!route || route.length < 4) {
      console.warn(`  no way up to ${poi.id}`);
      continue;
    }
    let short = "";
    if (!reached) {
      const top = route[route.length - 1]!;
      const dy = grid.height[goal]! - grid.height[top]!;
      const away = Math.hypot(grid.worldX(top % n) - grid.worldX(goal % n), grid.worldZ((top / n) | 0) - grid.worldZ((goal / n) | 0));
      short = dy > 2
        ? `, ends ${dy.toFixed(0)} m below the summit, ${away.toFixed(0)} m out (no ${((cap ?? maxGrade) * 100).toFixed(0)} % route to the top)`
        : `, ends level with the summit ${away.toFixed(0)} m out`;
    }
    const builtTrail = roadFrom(`trail-${poi.id}`, route, grid, field, routeGrid, {
      width: option("width", 2.4),
      // a footpath may steepen into a scramble where the ground does; a
      // trench dug into the summit so the last leg stays at 22 % is what it
      // must never do (every trail in the demo ended in a 100-300 m cut)
      finalClamp: "cut",
      maxGrade,
      maxFill: option("max-fill", 0.8),
      maxCut: option("max-cut", 3),
      smoothPasses: option("smooth-passes", 2),
      bridgeMin: option("bridge-min", 6),
      surface: paint.surface,
      surfaceByBiome: paint.surfaceByBiome,
    });
    trails.push(...builtTrail.roads);
    trailBridges.push(...builtTrail.bridges);
    network.push(route);
    let climb = 0;
    for (const trail of builtTrail.roads) {
      for (let i = 1; i < trail.surfaceY!.length; i++) climb += Math.max(0, trail.surfaceY![i]! - trail.surfaceY![i - 1]!);
    }
    const trailPts = builtTrail.roads.reduce((n, r) => n + r.points.length, 0);
    console.log(`  trail-${poi.id}: ${trailPts} points, ${((route.length * grid.step) / 1000).toFixed(1)} km, climbs ${climb.toFixed(0)}m${builtTrail.bridges.length > 0 ? `, ${builtTrail.bridges.length} footbridge(s)` : ""}${short} (${((performance.now() - t0) / 1000).toFixed(1)}s)`);
  }
  recipe.features.roads = [...recipe.features.roads, ...trails];
  recipe.features.bridges = [...recipe.features.bridges, ...trailBridges];
  if (trailBridges.length > 0 && !recipe.bridgeMaterial) {
    const id = `${recipe.name}-bridge`;
    writeFlatMaterial(id, "#6f5236");
    recipe.bridgeMaterial = id;
  }
  writeRecipe(recipe, file);
  console.log(`cut ${trails.length} trails`);
}

/** Minimum spanning tree over the towns, plus the `extra` shortest leftover links. */
function spanningEdges(towns: TownDoc[], extra: number): [number, number][] {
  const all: { a: number; b: number; d: number }[] = [];
  for (let a = 0; a < towns.length; a++) {
    for (let b = a + 1; b < towns.length; b++) {
      all.push({
        a,
        b,
        d: Math.hypot(towns[a]!.center[0] - towns[b]!.center[0], towns[a]!.center[1] - towns[b]!.center[1]),
      });
    }
  }
  all.sort((x, y) => x.d - y.d);
  const parent = towns.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i]!)));
  const tree: [number, number][] = [];
  const leftover: [number, number][] = [];
  for (const edge of all) {
    const ra = find(edge.a);
    const rb = find(edge.b);
    if (ra === rb) leftover.push([edge.a, edge.b]);
    else {
      parent[ra] = rb;
      tree.push([edge.a, edge.b]);
    }
  }
  return [...tree, ...leftover.slice(0, Math.max(0, extra))];
}

// ---------------------------------------------------------------- pois

/** Landmark points on distinctive ground: peaks, coves, river mouths, cliffs. */
/**
 * Give the world an edge, and a shape.
 *
 * Without this a recipe is an ENDLESS noise field — "world size" is only
 * however far the CLI happened to scatter features, and a player who walks far
 * enough finds terrain forever and content never. This lays down N continents
 * and M smaller islands with open ocean around and between them, a land floor
 * that keeps the sea out of the interior, and a hard LIMIT beyond which there
 * is nothing but ocean floor: the sea is the boundary, so nothing needs an
 * invisible wall.
 *
 * Landmasses are placed on a ring rather than at random: two drawn from noise
 * regularly overlap into one blob or drift so far apart the crossing is empty
 * ocean, and neither is a map anyone wants. `--gap` is the water between
 * their coasts, so the sailing distance is authored rather than discovered.
 */
function commandContinents(): void {
  const { recipe, file } = loadRecipe();
  const count = Math.max(1, Math.round(option("count", 1)));
  const islands = Math.max(0, Math.round(option("islands", 2)));
  const radius = option("radius", 2200);
  const falloff = option("falloff", 650);
  const gap = option("gap", 900);
  const warp = option("warp", 0.6);
  const warpScale = option("warpScale", 1100);
  const variation = option("variation", 0.55);
  const oceanFloor = option("ocean", -45);
  const landFloor = option("land-floor", 4);
  const random = mulberry32(recipe.seed ^ 0xc0a57);

  if (oceanFloor <= recipe.minY) {
    fail(`--ocean ${oceanFloor} is at or below the recipe's minY (${recipe.minY}); the sea bed would fall through the world's solid floor.`);
  }

  type Continent = NonNullable<WorldRecipe["bounds"]>["continents"][number];
  const continents: Continent[] = [];
  const make = (center: [number, number], r: number, f: number, scale: number): Continent => ({
    center: [round(center[0]), round(center[1])],
    radius: round(r),
    falloff: round(f),
    warp,
    warpScale: round(scale),
    coastVariation: variation,
    coastVariationScale: round(scale * 1.5),
  });
  if (count === 1) continents.push(make([0, 0], radius, falloff, warpScale));
  else {
    const ringRadius = ((radius + falloff) * 2 + gap) / 2 / Math.sin(Math.PI / count);
    for (let i = 0; i < count; i++) {
      const a = (i / count) * Math.PI * 2;
      // a second landmass is smaller — an equal pair reads as a symmetry, not a world
      const r = i === 0 ? radius : radius * 0.72;
      continents.push(make([Math.cos(a) * ringRadius, Math.sin(a) * ringRadius], r, falloff, warpScale));
    }
  }
  // islands: out past the continents' coasts, spaced around the compass
  const outer = Math.max(...continents.map((c) => Math.hypot(c.center[0], c.center[1]) + c.radius + c.falloff));
  for (let i = 0; i < islands; i++) {
    const r = radius * (0.2 + random() * 0.14);
    const f = falloff * 0.6;
    const a = ((i + 0.5 + random() * 0.4) / islands) * Math.PI * 2 + (count === 1 ? 0 : Math.PI / count);
    const d = outer + gap * 0.6 + r + f;
    continents.push(make([Math.cos(a) * d, Math.sin(a) * d], r, f, warpScale * 0.65));
  }
  const reach = Math.max(...continents.map((c) => Math.hypot(c.center[0], c.center[1]) + c.radius + c.falloff));
  const limit = option("limit", Math.ceil((reach + 500) / 100) * 100);

  recipe.bounds = { continents, oceanFloor, landFloor, shelf: recipe.bounds?.shelf ?? 0.58, limit, limitFalloff: recipe.bounds?.limitFalloff ?? 600 };
  writeRecipe(recipe, file);

  const land = continents.reduce((a, c) => a + Math.PI * c.radius * c.radius, 0) / 1e6;
  console.log(`${count} continent${count === 1 ? "" : "s"} + ${islands} island${islands === 1 ? "" : "s"}, ocean floor ${oceanFloor}m, land floor +${landFloor}m, limit ${limit}m:`);
  for (const c of continents) {
    console.log(`  centre [${c.center[0]}, ${c.center[1]}]  radius ${c.radius}m  coast band ${c.falloff}m`);
  }
  console.log(`~${land.toFixed(1)} km² of land; the world is ${limit * 2}m across`);
  console.log("re-run rivers/towns/paths/trails/pois: the old ones were sited on terrain that no longer exists.");
}

/**
 * Points of interest at open-world density, in every zone.
 *
 * Skyrim has roughly 24 named places per square mile and almost none of them
 * are summits. The first version of this stage found peaks and little else,
 * which put every marker in the mountains. Now each KIND is read off the
 * terrain where it naturally occurs — a saddle between two rises, a cliff
 * edge with a view, a bay with a beach, a hollow, a glade in the forest, an
 * oasis in the desert, a bog in the swamp — plus SITE kinds for the prefabs
 * that come later (a ruin on a hilltop, a camp beside a road, a watchtower
 * hill, a mine at a cliff foot). Each has a quota, a score and its own
 * separation, and a global separation keeps any two markers apart.
 *
 * Everything is data: `kind`, a position on the ground, and tags carrying
 * the zone and the reason (`ridge`, `coast`, `near-road`, ...). Nothing
 * spawns until a POI is given a `prefab`. Density is `--per-km2` (default 9,
 * about Skyrim's), and the stage keeps the POIs other stages own (falls,
 * cave, spire-field).
 */
function commandPois(): void {
  const { recipe, file } = loadRecipe();
  const extent = extentFor(recipe);
  const field = createWorldField(recipe);
  const grid = sampleWorldGrid(field, extent, option("step", 24));
  const n = grid.n;
  const step = grid.step;
  const sea = recipe.seaLevel;
  const at = (ix: number, iz: number): number => grid.height[clampIndex(ix, n) + clampIndex(iz, n) * n]!;
  const slopeAt = (i: number): number => {
    const ix = i % n;
    const iz = (i / n) | 0;
    const g = Math.hypot((at(ix + 1, iz) - at(ix - 1, iz)) / (2 * step), (at(ix, iz + 1) - at(ix, iz - 1)) / (2 * step));
    return g / Math.sqrt(1 + g * g);
  };
  const zoneOf = (i: number): string => grid.anchorIds[grid.zone[i]!] ?? "";
  const landCells: number[] = [];
  for (let i = 0; i < n * n; i++) if (grid.height[i]! >= sea + 1 && Number.isFinite(grid.shore[i]!)) landCells.push(i);
  const landKm2 = (landCells.length * step * step) / 1e6;
  const target = Math.round(landKm2 * option("per-km2", 9));

  // distance fields the kinds score against
  const townCells = recipe.features.towns.map((t) => grid.nearest(t.center[0], t.center[1]));
  const roadCells: number[] = [];
  for (const r of recipe.features.roads) if (!r.id.startsWith("trail-")) for (let i = 0; i < r.points.length; i += 2) roadCells.push(grid.nearest(r.points[i]![0], r.points[i]![1]));
  const nearestOf = (cells: number[], i: number): number => {
    const ix = i % n;
    const iz = (i / n) | 0;
    let best = Infinity;
    for (const c of cells) best = Math.min(best, Math.hypot((c % n) - ix, ((c / n) | 0) - iz));
    return best * step;
  };
  const waterNear = (i: number, radius: number): boolean => {
    const ix = i % n;
    const iz = (i / n) | 0;
    const r = Math.ceil(radius / step);
    for (let dz = -r; dz <= r; dz += 1) for (let dx = -r; dx <= r; dx += 1) if (field.waterY(grid.worldX(ix + dx), grid.worldZ(iz + dz)) !== null) return true;
    return false;
  };
  const localMax = (i: number, r: number): boolean => {
    const ix = i % n;
    const iz = (i / n) | 0;
    const h = grid.height[i]!;
    for (let dz = -r; dz <= r; dz++) for (let dx = -r; dx <= r; dx++) if ((dx || dz) && at(ix + dx, iz + dz) > h) return false;
    return true;
  };
  const localMin = (i: number, r: number): boolean => {
    const ix = i % n;
    const iz = (i / n) | 0;
    const h = grid.height[i]!;
    for (let dz = -r; dz <= r; dz++) for (let dx = -r; dx <= r; dx++) if ((dx || dz) && at(ix + dx, iz + dz) < h) return false;
    return true;
  };
  const dropWithin = (i: number, cells: number): number => {
    const ix = i % n;
    const iz = (i / n) | 0;
    const h = grid.height[i]!;
    let drop = 0;
    for (const [dx, dz] of NEIGHBORS) drop = Math.max(drop, h - at(ix + dx * cells, iz + dz * cells));
    return drop;
  };

  type Candidate = { i: number; kind: string; score: number; tags: string[] };
  const candidates: Candidate[] = [];
  const FOREST = new Set(["forest", "jungle", "taiga"]);
  const OPEN = new Set(["grassland", "savanna", "highlands", "moor", "foothills"]);
  for (const i of landCells) {
    const ix = i % n;
    const iz = (i / n) | 0;
    if (ix < 3 || iz < 3 || ix >= n - 3 || iz >= n - 3) continue;
    const h = grid.height[i]!;
    const s = slopeAt(i);
    const zone = zoneOf(i);
    const shore = grid.shore[i]!;
    const townD = nearestOf(townCells, i);
    const roadD = nearestOf(roadCells, i);
    if (townD < 90) continue;
    const tags = [zone];
    if (localMax(i, 3) && h > sea + 60) candidates.push({ i, kind: "peak", score: h, tags: [...tags, "summit"] });
    else if (localMax(i, 2) && h > sea + 15 && s < 0.2) {
      if (roadD < 300 && (OPEN.has(zone) || zone === "mountains")) candidates.push({ i, kind: "watchtower-site", score: 40 + h * 0.2 - roadD * 0.05, tags: [...tags, "hilltop", "near-path"] });
      else if (OPEN.has(zone) || zone === "blight" || zone === "badlands") candidates.push({ i, kind: "ruin-site", score: 30 + h * 0.15, tags: [...tags, "hilltop"] });
    }
    // saddle: two opposite sides rise, the other two fall
    const N = at(ix, iz - 3), S = at(ix, iz + 3), E = at(ix + 3, iz), W = at(ix - 3, iz);
    if (h > sea + 40 && ((N > h + 8 && S > h + 8 && E < h - 6 && W < h - 6) || (E > h + 8 && W > h + 8 && N < h - 6 && S < h - 6)) && s < 0.3) {
      candidates.push({ i, kind: "saddle", score: 35 + h * 0.1, tags: [...tags, "pass"] });
    }
    if (s < 0.22 && h > sea + 25 && dropWithin(i, 2) > 22) candidates.push({ i, kind: "overlook", score: 30 + dropWithin(i, 2), tags: [...tags, "cliff-edge"] });
    if (Math.abs(h - sea) < 3 && s < 0.12 && shore > -10 && shore < 60) {
      // a bay: sea on roughly half the ring around it
      let wet = 0;
      let all = 0;
      for (let dz = -4; dz <= 4; dz++) for (let dx = -4; dx <= 4; dx++) if (Math.abs(dx) === 4 || Math.abs(dz) === 4) { all++; if (at(ix + dx, iz + dz) < sea) wet++; }
      const f = wet / all;
      if (f > 0.3 && f < 0.7) candidates.push({ i, kind: "cove", score: 20 + f * 20, tags: [...tags, "coast", "beach"] });
    }
    if (s < 0.15 && h > sea + 3 && waterNear(i, step * 1.5) && field.waterY(grid.worldX(ix), grid.worldZ(iz)) === null) {
      if (zone === "desert" || zone === "badlands") candidates.push({ i, kind: "oasis", score: 45, tags: [...tags, "lakeshore"] });
      else if (zone === "swamp" || zone === "fen") candidates.push({ i, kind: "bog", score: 20, tags: [...tags, "wet"] });
      else candidates.push({ i, kind: "lakeshore", score: 18 + (roadD < 400 ? 6 : 0), tags: [...tags, "water"] });
    }
    if (FOREST.has(zone) && s < 0.1 && roadD > 150 && townD > 300) candidates.push({ i, kind: "glade", score: 15 + Math.min(10, roadD / 100), tags: [...tags, "clearing"] });
    if (FOREST.has(zone) && s < 0.25 && roadD > 400) candidates.push({ i, kind: "grove", score: 10 + roadD / 200, tags: [...tags, "deep-forest"] });
    if (localMin(i, 2) && h > sea + 6 && !waterNear(i, step * 2) && s < 0.2) candidates.push({ i, kind: "hollow", score: 18, tags: [...tags, "basin"] });
    if (zone === "desert" && s > 0.12 && s < 0.4 && !waterNear(i, 300)) candidates.push({ i, kind: "dune-field", score: 12 + s * 20, tags: [...tags, "sand"] });
    if (zone === "badlands" && s < 0.06 && dropWithin(i, 3) > 15) candidates.push({ i, kind: "mesa-top", score: 25 + dropWithin(i, 3), tags: [...tags, "table"] });
    if (OPEN.has(zone) && s < 0.08 && waterNear(i, 200) && roadD > 120) candidates.push({ i, kind: "meadow", score: 12, tags: [...tags, "open"] });
    if (s < 0.1 && roadD > 40 && roadD < 140 && townD > 250) candidates.push({ i, kind: "camp-site", score: 16 + (waterNear(i, 120) ? 8 : 0), tags: [...tags, "near-path"] });
    if ((zone === "mountains" || zone === "peaks" || zone === "highlands" || zone === "badlands" || zone === "foothills") && h > sea + 40 && s < 0.2 && dropWithin(i, 1) < 4) {
      // a cliff foot: steep ground within two cells, but this cell flat
      let steepNear = false;
      for (const [dx, dz] of NEIGHBORS) if (slopeAt(clampIndex(ix + dx * 2, n) + clampIndex(iz + dz * 2, n) * n) > 0.6) steepNear = true;
      if (steepNear) candidates.push({ i, kind: "mine-site", score: 22 + h * 0.05, tags: [...tags, "cliff-foot"] });
    }
    if (h > sea + 80 && s > 0.15 && s < 0.45 && ((E < h - 6 && W < h - 6 && Math.abs(N - h) < 4 && Math.abs(S - h) < 4) || (N < h - 6 && S < h - 6 && Math.abs(E - h) < 4 && Math.abs(W - h) < 4))) {
      candidates.push({ i, kind: "ridge", score: 20 + h * 0.08, tags: [...tags, "walkable-ridge"] });
    }
  }
  // river-derived kinds
  for (const river of recipe.features.rivers) {
    const head = river.points[0]!;
    candidates.push({ i: grid.nearest(head[0], head[1]), kind: "spring", score: 25, tags: [zoneOf(grid.nearest(head[0], head[1])), "river-source"] });
  }
  for (const road of recipe.features.roads) {
    if (road.id.startsWith("trail-")) continue;
    for (let a = 0; a + 1 < road.points.length; a++) {
      for (const river of recipe.features.rivers) {
        for (let b = 0; b + 1 < river.points.length; b++) {
          const hit = segmentsCross(road.points[a]!, road.points[a + 1]!, river.points[b]!, river.points[b + 1]!);
          if (!hit) continue;
          const i = grid.nearest(hit[0], hit[1]);
          candidates.push({ i, kind: river.width > 12 ? "bridge-site" : "ford", score: 30 + river.width, tags: [zoneOf(i), "crossing", road.id] });
        }
      }
    }
  }
  for (const canyon of recipe.features.canyons) {
    const mid = canyon.points[Math.floor(canyon.points.length / 2)]!;
    const i = grid.nearest(mid[0], mid[1]);
    candidates.push({ i, kind: "canyon-floor", score: 40, tags: [zoneOf(i), "gorge"] });
  }

  // quotas, as shares of the target; kinds that found nothing give their share back
  const QUOTA: Record<string, number> = {
    peak: 0.06, saddle: 0.04, overlook: 0.07, ridge: 0.04, cove: 0.05, lakeshore: 0.05, oasis: 0.02, bog: 0.03,
    spring: 0.04, ford: 0.03, "bridge-site": 0.02, glade: 0.07, grove: 0.05, hollow: 0.05, "dune-field": 0.03,
    "mesa-top": 0.02, meadow: 0.06, "canyon-floor": 0.01, "ruin-site": 0.09, "camp-site": 0.09, "watchtower-site": 0.04,
    "mine-site": 0.04,
  };
  const SEPARATION: Record<string, number> = { peak: 500, overlook: 350, ridge: 400, spring: 250, "ruin-site": 450, "watchtower-site": 700, "camp-site": 300, glade: 350, grove: 450, meadow: 400, "mine-site": 450 };
  const globalSep = option("separation", Math.max(70, Math.sqrt((landKm2 * 1e6) / Math.max(1, target)) * 0.55));
  const byKind = new Map<string, Candidate[]>();
  for (const c of candidates) (byKind.get(c.kind) ?? byKind.set(c.kind, []).get(c.kind)!).push(c);
  for (const list of byKind.values()) list.sort((a, b) => b.score - a.score);

  const kept = recipe.features.pois.filter((p) => !(p.kind in QUOTA));
  const placed: { x: number; z: number; kind: string }[] = kept.map((p) => ({ x: p.position[0], z: p.position[2], kind: p.kind }));
  const out: PoiDoc[] = [];
  const counts = new Map<string, number>();
  const tryPlace = (c: Candidate): boolean => {
    const x = grid.worldX(c.i % n);
    const z = grid.worldZ((c.i / n) | 0);
    const sep = SEPARATION[c.kind] ?? 200;
    for (const p of placed) {
      const d = Math.hypot(p.x - x, p.z - z);
      if (d < globalSep) return false;
      if (p.kind === c.kind && d < sep) return false;
    }
    for (const t of recipe.features.towns) if (Math.hypot(t.center[0] - x, t.center[1] - z) < t.radius + 40) return false;
    placed.push({ x, z, kind: c.kind });
    const k = (counts.get(c.kind) ?? 0) + 1;
    counts.set(c.kind, k);
    out.push({ id: `${c.kind}-${k}`, kind: c.kind, position: [round(x), round(grid.height[c.i]!), round(z)], rotationY: 0, tags: c.tags });
    return true;
  };
  // round-robin over kinds up to each quota, then a second pass fills the remainder by score
  const cursors = new Map<string, number>();
  let progress = true;
  while (out.length < target && progress) {
    progress = false;
    for (const [kind, list] of byKind) {
      const quota = Math.ceil(target * (QUOTA[kind] ?? 0.02));
      if ((counts.get(kind) ?? 0) >= quota) continue;
      let cursor = cursors.get(kind) ?? 0;
      while (cursor < list.length) {
        const ok = tryPlace(list[cursor++]!);
        if (ok) {
          progress = true;
          break;
        }
      }
      cursors.set(kind, cursor);
    }
  }
  if (out.length < target) {
    const rest = candidates.filter((c) => (cursors.get(c.kind) ?? 0) <= byKind.get(c.kind)!.indexOf(c)).sort((a, b) => b.score - a.score);
    for (const c of rest) {
      if (out.length >= target) break;
      tryPlace(c);
    }
  }

  recipe.features.pois = [...kept, ...out];
  writeRecipe(recipe, file);
  const summary = [...counts].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(", ");
  console.log(`marked ${out.length} points of interest over ${landKm2.toFixed(1)} km² (${((out.length + kept.length) / (landKm2 / 2.59)).toFixed(0)} per sq mi with ${kept.length} kept from other stages):`);
  console.log(`  ${summary}`);
  console.log("(no `prefab` set yet — give a POI one and it spawns in the cell that contains it)");
}

/** Intersection point of segments a-b and c-d in XZ, or null. */
function segmentsCross(a: [number, number], b: [number, number], c: [number, number], d: [number, number]): [number, number] | null {
  const r = [b[0] - a[0], b[1] - a[1]];
  const s = [d[0] - c[0], d[1] - c[1]];
  const den = r[0]! * s[1]! - r[1]! * s[0]!;
  if (Math.abs(den) < 1e-9) return null;
  const qp = [c[0] - a[0], c[1] - a[1]];
  const t = (qp[0]! * s[1]! - qp[1]! * s[0]!) / den;
  const u = (qp[0]! * r[1]! - qp[1]! * r[0]!) / den;
  if (t < 0 || t > 1 || u < 0 || u > 1) return null;
  return [a[0] + r[0]! * t, a[1] + r[1]! * t];
}

/**
 * Re-emit the terrain material from the recipe's `surfaces`.
 *
 * The material is derived data — one splat layer per surface — so after adding
 * a `map` / `normalMap` / `uvScale` to a surface this rewrites it, rather than
 * asking you to keep two files in sync by hand.
 */
function commandMaterial(): void {
  const { recipe } = loadRecipe();
  const id = recipe.material ?? `terrain/${recipe.name}`;
  writeTerrainMaterial(recipe, id, true);
  const textured = recipe.surfaces.filter((s) => s.map).length;
  console.log(`${textured}/${recipe.surfaces.length} surfaces textured`);
  for (const s of recipe.surfaces) {
    console.log(`  ${s.name.padEnd(8)} ${s.map ?? `(flat colour ${s.color})`}  ${s.uvScale}m per tile`);
  }
}

// ---------------------------------------------------------------- caves

/**
 * Find cave mouths and measure whether a player actually fits through them.
 *
 * "There are caves" is not a useful claim — a tunnel network sealed under the
 * surface is scenery nobody will ever see, and one whose passages are narrower
 * than the character capsule is a wall with a hole painted on it. So this
 * probes the real field: stand on steep ground, walk a ray INTO the hill, and
 * see whether the rock opens up and stays open. Clearance is measured as the
 * largest sphere that fits at the deepest reachable point, which is directly
 * comparable to the capsule radius the player controller uses.
 *
 * Confirmed entrances are written into `features.pois` as `kind: "cave"`, so
 * they are addressable data like everything else — the map draws them, and
 * gameplay can hang a prefab or a spawn on them.
 */
function commandCaves(): void {
  const { recipe, file } = loadRecipe();
  const extent = extentFor(recipe);
  const field = createWorldField(recipe);
  const playerRadius = option("radius", 0.45);
  const playerHeight = option("height", 1.8);
  const wanted = option("count", 24);
  const separation = option("separation", 90);

  const grid = sampleGrid(field, extent, Math.round(option("grid", 200)));

  // Collect steep candidates first, then thin them, THEN probe. A probe is a
  // 45 m march with a clearance solve at every half-metre, so running one per
  // grid point would be tens of millions of field evaluations for answers we
  // would immediately throw away as too close together.
  const candidates: { x: number; z: number; h: number; steep: number; inX: number; inZ: number }[] = [];
  for (let iz = 2; iz < grid.n - 2; iz++) {
    for (let ix = 2; ix < grid.n - 2; ix++) {
      const steep = grid.slope[ix + iz * grid.n]!;
      if (steep < recipe.terrain.caves.entrances.slopeStart) continue;
      const h = grid.at(ix, iz);
      if (h < recipe.seaLevel + 4) continue; // underwater mouths are not much use
      // inward = uphill, i.e. against the surface gradient
      const gx = grid.at(ix + 1, iz) - grid.at(ix - 1, iz);
      const gz = grid.at(ix, iz + 1) - grid.at(ix, iz - 1);
      const glen = Math.hypot(gx, gz);
      if (glen < 1e-4) continue;
      candidates.push({
        x: grid.worldX(ix),
        z: grid.worldZ(iz),
        h,
        steep,
        inX: gx / glen,
        inZ: gz / glen,
      });
    }
  }
  // steepest first: a near-vertical face is where a mouth reads best
  candidates.sort((a, b) => b.steep - a.steep);
  const probes: typeof candidates = [];
  for (const c of candidates) {
    if (probes.length >= option("probes", 1500)) break;
    if (probes.some((p) => Math.hypot(p.x - c.x, p.z - c.z) < separation * 0.5)) continue;
    probes.push(c);
  }

  // With noise caves off (the default) there is no pre-existing void to probe
  // for — the tunnel pass DIGS the system, so any steep face with enough rock
  // behind it to hold a passage is a valid mouth. When noise caves ARE on, the
  // probe still runs and prefers faces that already open into something.
  const found: { x: number; y: number; z: number; clearance: number; depth: number; slope: number; inX: number; inZ: number }[] = [];
  for (const c of probes) {
    if (recipe.terrain.caves.enabled) {
      const probe = probeEntrance(field, c.x, c.h, c.z, c.inX, c.inZ, playerRadius);
      if (!probe) continue;
      if (probe.headroom < playerHeight) continue;
      found.push({ x: c.x, y: probe.y, z: c.z, clearance: probe.clearance, depth: probe.depth, slope: c.steep, inX: c.inX, inZ: c.inZ });
      continue;
    }
    // enough hillside behind the face for a passage to live inside?
    const buried = field.height(c.x + c.inX * 30, c.z + c.inZ * 30) - (c.h - 1.2);
    if (buried < 12) continue;
    found.push({ x: c.x, y: c.h - 1.2, z: c.z, clearance: 0, depth: buried, slope: c.steep, inX: c.inX, inZ: c.inZ });
  }

  found.sort((a, b) => b.clearance * b.depth - a.clearance * a.depth);
  const picked: typeof found = [];
  for (const cave of found) {
    if (picked.length >= wanted) break;
    if (picked.some((p) => Math.hypot(p.x - cave.x, p.z - cave.z) < separation)) continue;
    picked.push(cave);
  }

  console.log(
    `${candidates.length} steep points -> ${probes.length} probed -> ` +
      `${found.length} openings a ${playerRadius}m-radius / ${playerHeight}m capsule fits through`,
  );
  for (const cave of picked.slice(0, 12)) {
    console.log(
      `  [${cave.x.toFixed(0)}, ${cave.y.toFixed(1)}, ${cave.z.toFixed(0)}]  ` +
        `tightest ${cave.clearance.toFixed(2)}m  reaches ${cave.depth.toFixed(0)}m in  slope ${cave.slope.toFixed(2)}`,
    );
  }
  if (picked.length === 0) {
    console.log(
      "\n  No enterable openings. Raise terrain.caves.threshold (wider tunnels), lower\n" +
        "  caves.entrances.minDepth (further past the surface), or lower entrances.slopeStart.",
    );
  }

  // -- dig a tunnel network from each mouth -------------------------------
  //
  // A pass in the same spirit as roads: a route is CHOSEN and written down,
  // rather than falling out of a noise threshold. That makes the result
  // uniform (every system is one you asked for), controllable (edit the
  // polyline), and cheap (the field only evaluates a tunnel near the tunnel,
  // instead of testing every voxel of rock in the world for cave noise).
  const random = mulberry32((recipe.seed ^ 0x0caf3) >>> 0);
  const voxel = recipe.cellSize / recipe.resolution;
  const tunnelRadius = option("mouth", Math.max(2.6, voxel * 1.5));
  const tunnels = picked.map((cave, i) =>
    digTunnel(field, recipe, cave, `cave-${i + 1}`, tunnelRadius, random, {
      length: option("length", 220),
      branches: Math.round(option("branches", 2)),
    }),
  );
  recipe.features.tunnels = tunnels.flat();
  const totalLength = tunnels.flat().reduce((n, t) => {
    let len = 0;
    for (let i = 1; i < t.points.length; i++) {
      const a = t.points[i - 1]!;
      const b = t.points[i]!;
      len += Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
    }
    return n + len;
  }, 0);
  console.log(
    `dug ${tunnels.flat().length} passages, ${totalLength.toFixed(0)}m total, radius ${tunnelRadius.toFixed(1)}m ` +
      `(voxel ${voxel.toFixed(1)}m — a passage must exceed it to survive meshing)`,
  );

  // Carve each confirmed mouth explicitly, as a chain of overlapping spheres
  // from just outside the rock face into the system.
  //
  // This is not belt-and-braces, it is the whole point. The field can describe
  // a passage 1.2 m across, but marching cubes on a 2 m lattice cannot
  // REPRESENT a hole narrower than roughly one voxel — so the mesh (and the
  // collider cooked from it) quietly pinches those shut, and a player-sized
  // sphere swept at the mouth is blocked a couple of metres in. Measured that
  // way before this existed: every one of the first six "entrances" was
  // impassable in the cooked mesh despite the field saying otherwise.
  //
  // A carve whose radius is comfortably ABOVE the voxel size always survives
  // meshing, so the opening you measured is the opening that exists.
  const mouthRadius = option("mouth", Math.max(2.6, (recipe.cellSize / recipe.resolution) * 1.5));
  const blobs = recipe.features.blobs.filter((b) => !b.id.startsWith("cave-mouth-"));
  picked.forEach((cave, i) => {
    const inX = cave.inX;
    const inZ = cave.inZ;
    // start OUTSIDE the face so the mouth is genuinely open to the sky, and
    // run past the point the probe reached so it meets the natural passage
    for (let s = -2; s <= Math.max(4, cave.depth * 0.5); s += mouthRadius * 0.6) {
      blobs.push({
        id: `cave-mouth-${i + 1}`,
        center: [
          round(cave.x + inX * s),
          round(cave.y - s * 0.06), // slope gently down as it goes in
          round(cave.z + inZ * s),
        ],
        radius: mouthRadius,
        op: "remove" as const,
        falloff: 1.5,
      });
    }
  });
  recipe.features.blobs = blobs;

  const others = recipe.features.pois.filter((p) => p.kind !== "cave");
  recipe.features.pois = [
    ...others,
    ...picked.map((cave, i) => ({
      id: `cave-${i + 1}`,
      kind: "cave",
      position: [round(cave.x), round(cave.y), round(cave.z)] as [number, number, number],
      rotationY: Math.atan2(cave.inX, cave.inZ),
      tags: [`clearance:${cave.clearance.toFixed(2)}`, `depth:${cave.depth.toFixed(0)}`],
    })),
  ];
  console.log(
    `carved ${picked.length} mouths at radius ${mouthRadius.toFixed(1)}m ` +
      `(voxel size ${(recipe.cellSize / recipe.resolution).toFixed(1)}m — a mouth must exceed it to survive meshing)`,
  );
  writeRecipe(recipe, file);
}

/**
 * Dig a cave system inward from a mouth: a main passage plus a few branches.
 *
 * The walk is deliberately simple and deterministic — head inward, wander a
 * little, drift downward, and stay under enough rock to still be a cave. What
 * makes it read as a system rather than a worm is the branching and the
 * gentle descent; what makes it usable is that the whole thing is a handful of
 * polylines you can open in a text editor and move.
 */
function digTunnel(
  field: WorldField,
  recipe: WorldRecipe,
  mouth: { x: number; y: number; z: number; inX: number; inZ: number },
  id: string,
  radius: number,
  random: () => number,
  opts: { length: number; branches: number },
): { id: string; points: [number, number, number][]; radius: number; endRadius?: number }[] {
  const step = Math.max(6, radius * 2);
  const out: { id: string; points: [number, number, number][]; radius: number; endRadius?: number }[] = [];

  const walk = (
    startX: number,
    startY: number,
    startZ: number,
    dirX: number,
    dirZ: number,
    maxLength: number,
    tunnelId: string,
  ): [number, number, number][] => {
    // start OUTSIDE the face so the passage genuinely opens to the sky
    const points: [number, number, number][] = [[startX - dirX * 4, startY, startZ - dirZ * 4]];
    let x = startX;
    let y = startY;
    let z = startZ;
    let dx = dirX;
    let dz = dirZ;
    for (let travelled = 0; travelled < maxLength; travelled += step) {
      // wander: a small deterministic turn each step
      const turn = (random() - 0.5) * 0.7;
      const nx = dx * Math.cos(turn) - dz * Math.sin(turn);
      const nz = dx * Math.sin(turn) + dz * Math.cos(turn);
      dx = nx;
      dz = nz;
      x += dx * step;
      z += dz * step;
      // drift down, but never below the world floor or so deep it is pointless
      y -= step * (0.06 + random() * 0.12);
      y = Math.max(y, recipe.minY + 8);
      // stay buried: if the ground has dropped to meet us, dive
      const ground = field.height(x, z);
      if (y > ground - radius - 2) y = ground - radius - 4;
      points.push([round(x), round(y), round(z)]);
    }
    void tunnelId;
    return points;
  };

  const main = walk(mouth.x, mouth.y, mouth.z, mouth.inX, mouth.inZ, opts.length, id);
  out.push({ id, points: main, radius, endRadius: radius * 1.6 });

  // branches leave the main passage at a junction and run shorter
  for (let b = 0; b < opts.branches; b++) {
    const at = Math.floor(main.length * (0.3 + 0.5 * random()));
    const from = main[Math.min(at, main.length - 1)]!;
    const angle = random() * Math.PI * 2;
    const branch = walk(
      from[0],
      from[1],
      from[2],
      Math.cos(angle),
      Math.sin(angle),
      opts.length * (0.3 + 0.3 * random()),
      `${id}-b${b + 1}`,
    );
    // a branch starts AT the junction, not outside a face
    branch[0] = [from[0], from[1], from[2]];
    out.push({ id: `${id}-b${b + 1}`, points: branch, radius: radius * 0.85 });
  }
  return out;
}

/**
 * Walk a ray into the hillside from a surface point and find the passage
 * behind it — if there is one you could actually get through.
 *
 * The number that matters is the BOTTLENECK: the tightest point along the way
 * in, not the size of whatever chamber it eventually opens into. A 10 m
 * cavern behind a 20 cm crack is not an entrance. So this marches at a fine
 * step, measures clearance at every one of them, and reports the minimum over
 * the continuous run of air leading inward.
 */
function probeEntrance(
  field: WorldField,
  x: number,
  surfaceY: number,
  z: number,
  inX: number,
  inZ: number,
  playerRadius: number,
): { y: number; clearance: number; headroom: number; depth: number } | null {
  const walk = 0.5;
  const maxDepth = 45;
  /** How far in the passage must reach before it counts as a cave, not a nook. */
  const minReach = 10;
  // A mouth is a hole in the FACE, so sample at roughly chest height inside it
  // rather than on the skin.
  const y = surfaceY - 1.2;

  let bottleneck = Infinity;
  let reached = 0;
  let inPassage = false;
  for (let t = walk; t <= maxDepth; t += walk) {
    const px = x + inX * t;
    const pz = z + inZ * t;
    const solid = field.density(px, y, pz) < 0;
    // once the heightfield is well overhead we are genuinely inside the hill
    // rather than following the outside of a slope
    const buried = field.height(px, pz) > y + 3;
    if (solid) {
      if (inPassage) break; // the passage pinched shut
      continue;
    }
    if (!buried) {
      if (inPassage) break; // we came out the far side; stop measuring
      continue;
    }
    const clear = clearanceAt(field, px, y, pz, playerRadius);
    if (clear < playerRadius) {
      if (inPassage) break;
      continue;
    }
    inPassage = true;
    bottleneck = Math.min(bottleneck, clear);
    reached = t;
  }

  if (!inPassage || reached < minReach) return null;
  return {
    y,
    clearance: bottleneck,
    headroom: headroomAt(field, x + inX * reached, y, z + inZ * reached),
    depth: reached,
  };
}

/**
 * Radius of the largest sphere centred here that contains no rock, capped at
 * `cap` (there is no reason to keep measuring a cavern once it is comfortably
 * bigger than the player — and the cap is what keeps this affordable).
 */
function clearanceAt(field: WorldField, x: number, y: number, z: number, playerRadius: number): number {
  const dirs: [number, number, number][] = [
    [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1],
    [0.707, 0, 0.707], [-0.707, 0, 0.707], [0.707, 0, -0.707], [-0.707, 0, -0.707],
    [0, 1, 0], [0, -1, 0],
  ];
  const cap = Math.max(2, playerRadius * 4);
  let best = cap;
  for (const [dx, dy, dz] of dirs) {
    for (let r = 0.2; r <= best; r += 0.2) {
      if (field.density(x + dx * r, y + dy * r, z + dz * r) < 0) {
        best = Math.min(best, r);
        break;
      }
    }
    if (best < playerRadius) return best; // already too tight; stop early
  }
  return best;
}

/** Floor-to-ceiling clearance through this point. */
function headroomAt(field: WorldField, x: number, y: number, z: number): number {
  let up = 0;
  for (let r = 0.25; r <= 12; r += 0.25) {
    if (field.density(x, y + r, z) < 0) break;
    up = r;
  }
  let down = 0;
  for (let r = 0.25; r <= 12; r += 0.25) {
    if (field.density(x, y - r, z) < 0) break;
    down = r;
  }
  return up + down;
}

// ---------------------------------------------------------------- canyons

/**
 * Cut terraced gorges through the high dry country.
 *
 * Traced the same way a river is — steepest descent from high ground — because
 * that is honestly how a canyon got there: it is an old river that cut down
 * faster than its walls could retreat. What makes it read as a canyon rather
 * than a big stream is the profile the field carves from it (a flat floor and
 * stepped walls, see `canyonSchema`) and the scale: hundreds of metres across
 * where a river is ten.
 *
 * Sited away from existing rivers on purpose. A canyon that swallows a
 * watercourse leaves the river's own bed hanging in mid-air halfway up a wall,
 * because the two carves are independent and the deeper one simply wins.
 */
function commandCanyons(): void {
  const { recipe, file } = loadRecipe();
  const extent = extentFor(recipe);
  const count = option("count", 6);
  const grid = sampleGrid(createWorldField(recipe), extent, Math.round(option("grid", 300)));
  const random = mulberry32(recipe.seed ^ 0x0ca0f00d);
  const minStart = option("min-height", recipe.seaLevel + 90);
  const zoneFilter = stringOption("zone", "");
  const zoneField = zoneFilter ? createWorldField(recipe) : null;

  // Start high, but not on a summit: a canyon head belongs on a plateau, and
  // a peak start produces a chute down one mountain face instead of a system.
  const candidates: { ix: number; iz: number; h: number; flat: number }[] = [];
  for (let iz = 3; iz < grid.n - 3; iz++) {
    for (let ix = 3; ix < grid.n - 3; ix++) {
      const h = grid.at(ix, iz);
      if (h < minStart) continue;
      const slope = grid.slope[ix + iz * grid.n]!;
      if (slope > 0.36) continue;
      if (zoneField && zoneField.zone(grid.worldX(ix), grid.worldZ(iz)).id !== zoneFilter) continue;
      candidates.push({ ix, iz, h, flat: 1 - slope });
    }
  }
  candidates.sort((a, b) => b.h * b.flat - a.h * a.flat);

  const separation = option("separation", (extent * 2) / Math.max(2, count * 1.8));
  const starts: { ix: number; iz: number }[] = [];
  for (const candidate of candidates) {
    if (starts.length >= count) break;
    const x = grid.worldX(candidate.ix);
    const z = grid.worldZ(candidate.iz);
    const clearOfOthers = starts.every(
      (s) => Math.hypot(grid.worldX(s.ix) - x, grid.worldZ(s.iz) - z) > separation,
    );
    const clearOfRivers = recipe.features.rivers.every((r) =>
      r.points.every((p) => Math.hypot(p[0] - x, p[1] - z) > 160),
    );
    if (clearOfOthers && clearOfRivers) starts.push({ ix: candidate.ix, iz: candidate.iz });
  }
  if (starts.length === 0) {
    fail(`no plateau above ${minStart.toFixed(0)}m${zoneFilter ? ` in zone "${zoneFilter}"` : ""} to head a canyon — lower --min-height, or raise terrain.mountains.amplitude`);
  }

  const canyons: CanyonDoc[] = [];
  starts.forEach((start, index) => {
    const depthGuess = 40 + 45 * 0.5;
    const full = traceGently(grid, start.ix, start.iz, recipe.seaLevel + depthGuess * 0.8, random, option("length", 140));
    const depth = 40 + Math.round(random() * 45);
    const width = 55 + Math.round(random() * 70);
    // Where the canyon MOUTHS OUT: you cannot cut a fifty-metre gorge into
    // twenty metres of land. Traced all the way to the sea like a river, a
    // canyon spends most of its length in lowland where there is nothing to
    // cut into — measured before this existed, three of four came out with
    // their floor and their rim both at 2 m, which is not a canyon, it is a
    // ditch. Trimming by DEPTH rather than by an absolute altitude keeps each
    // one exactly as long as it is still a canyon.
    const needed = recipe.seaLevel + depth * 0.8;
    let cut = full.length;
    for (let i = 0; i < full.length; i++) {
      if (grid.at(full[i]![0], full[i]![1]) < needed) {
        cut = i;
        break;
      }
    }
    const path = full.slice(0, cut);
    if (path.length < 6) return;
    const pathHeights = path.map((p) => grid.at(p[0], p[1]));
    const kept = simplify3(path, pathHeights, RIVER_SIMPLIFY * 1.4, RIVER_HEIGHT_WEIGHT / grid.step);
    if (kept.length < 3) return;
    const points = kept.map((i) => [grid.worldX(path[i]![0]), grid.worldZ(path[i]![1])] as [number, number]);
    // The floor is forced monotonically DOWN and clamped just above the
    // waterline. A floor that climbs would dam the canyon at its own midpoint;
    // a floor below sea level would flood it.
    const floorY: number[] = [];
    let running = Infinity;
    kept.forEach((i, n) => {
      const cut = depth * (0.55 + 0.45 * (n / Math.max(1, kept.length - 1)));
      running = Math.min(running, pathHeights[i]! - cut);
      floorY.push(Math.max(running, recipe.seaLevel + 1.5));
    });
    canyons.push({
      id: `canyon-${index + 1}`,
      points,
      width,
      depth,
      rim: width * (0.7 + random() * 0.5),
      steps: 2 + Math.floor(random() * 3),
      stepSharpness: 0.66 + random() * 0.24,
      floorY,
    });
  });

  recipe.features.canyons = canyons;
  writeRecipe(recipe, file);
  console.log(
    `cut ${canyons.length} canyons from ${starts.length} heads (${candidates.length} plateau candidates above ${minStart.toFixed(0)}m)`,
  );
  if (canyons.length < starts.length) {
    console.log(`  ${starts.length - canyons.length} head(s) ran out of high ground before making a canyon's length`);
  }
  for (const canyon of canyons) {
    const drop = (canyon.floorY![0]! - canyon.floorY![canyon.floorY!.length - 1]!).toFixed(0);
    console.log(
      `  ${canyon.id}: ${canyon.points.length} points, ${canyon.width}m floor, ${canyon.depth}m deep, ${canyon.steps} terraces, drops ${drop}m`,
    );
  }
}

/**
 * Descend at the GENTLEST available gradient rather than the steepest.
 *
 * This is the whole difference between a canyon and a gully. Steepest descent
 * — right for a river, which is trying to reach the sea — runs off the edge of
 * the plateau within a few grid steps and plunges; every canyon traced that
 * way came out six points long and below the altitude it needed before it had
 * gone anywhere. Choosing the smallest positive drop instead follows the
 * plateau's own drainage, wandering across the high country the way a gorge
 * actually does, and the result is a long sinuous course that stays high
 * enough to be cut into.
 */
function traceGently(
  grid: HeightGrid,
  startX: number,
  startZ: number,
  stopBelow: number,
  random: () => number,
  maxSteps: number,
): [number, number][] {
  const path: [number, number][] = [[startX, startZ]];
  const visited = new Set<number>([startX + startZ * grid.n]);
  let ix = startX;
  let iz = startZ;
  let climbBudget = 14; // it may cross a low lip, as an eroding watercourse does
  const target = 0.6; // world units of drop per step it prefers — a ~3% grade

  for (let step = 0; step < maxSteps; step++) {
    const here = grid.at(ix, iz);
    if (here < stopBelow) break;
    let best: [number, number, number] | null = null;
    let bestScore = Infinity;
    for (const [dx, dz] of NEIGHBORS) {
      const nx = ix + dx;
      const nz = iz + dz;
      if (nx < 1 || nz < 1 || nx >= grid.n - 1 || nz >= grid.n - 1) continue;
      if (visited.has(nx + nz * grid.n)) continue;
      const drop = here - grid.at(nx, nz);
      if (drop < 0 && climbBudget <= 0) continue;
      // a touch of noise, or it follows a lattice diagonal rather than a valley
      const score = Math.abs(drop - target) + (random() - 0.5) * 0.5;
      if (score < bestScore) {
        bestScore = score;
        best = [nx, nz, drop];
      }
    }
    if (!best) break;
    if (best[2] < 0) climbBudget -= 1;
    ix = best[0];
    iz = best[1];
    visited.add(ix + iz * grid.n);
    path.push([ix, iz]);
  }
  return path;
}

// ---------------------------------------------------------------- monoliths

/**
 * Rock pillars standing out of a zone — the desert's monoliths.
 *
 * A biome that differs from its neighbour only in which texture it paints is
 * a recolour, not a place. Two things make it a place: its own LANDFORM
 * (`terrain.dunes`, derived continuously from the recipe) and its own
 * SILHOUETTE, which is what this writes — a handful of `features.blobs`, one
 * line each, that the field turns into vertical capsules of solid rock.
 *
 * They are authored data rather than yet another noise band on purpose. A
 * pillar is a landmark: you want to be able to see the list, move one, delete
 * one you dislike, and have a downstream stage (POIs, WFC) reason about where
 * they are. A noise band gives you none of that, and would have to be
 * evaluated across the whole world's volume to find the 1% of it that is
 * a monolith.
 *
 * Re-running replaces only its own blobs, so the cave mouths `caves` carved
 * survive untouched.
 */
function commandMonoliths(): void {
  const { recipe, file } = loadRecipe();
  const extent = option("extent", 3000);
  const count = option("count", 130);
  const biomeId = stringOption("biome", "desert");
  // Barely wider than the tallest spire is tall. A spire on its own is a
  // curiosity; a hundred within sight of each other is a landscape.
  const separation = option("separation", 42);
  const clearance = option("clearance", 26);
  // THE change that makes this read as a place: spires are concentrated into
  // a field of this radius, densest at its heart and thinning to nothing at
  // its edge. Spread evenly across every desert in the world instead, they
  // read as scenery scattered by a machine — one lone pillar here, two there,
  // no reason for any of them. A named field has a middle, an edge, and a
  // silhouette you can navigate by.
  const fieldRadius = option("radius", 400);
  const fields = Math.max(1, Math.round(option("fields", 1)));
  const biomeIndex = recipe.biomes.findIndex((b) => b.id === biomeId);
  if (biomeIndex < 0) fail(`no biome "${biomeId}" in ${recipe.name} — biomes are ${recipe.biomes.map((b) => b.id).join(", ")}`);
  const field = createWorldField(recipe);
  const grid = sampleGrid(field, extent, Math.round(option("grid", 200)));
  const random = mulberry32(recipe.seed ^ 0x11071f);

  // Candidate ground: inside the zone rather than on its fringe (a monolith
  // half in a meadow reads as a mistake), flat enough to stand on, and clear
  // of anything a player travels along.
  const sites: { x: number; z: number; y: number }[] = [];
  for (let iz = 1; iz < grid.n - 1; iz++) {
    for (let ix = 1; ix < grid.n - 1; ix++) {
      const y = grid.at(ix, iz);
      if (y < recipe.seaLevel + 3) continue;
      const steep = grid.slope[ix + iz * grid.n]!;
      if (steep > 0.3) continue;
      const x = grid.worldX(ix);
      const z = grid.worldZ(iz);
      const sample = field.biome(x, z, y, steep);
      if ((sample.weights[biomeIndex] ?? 0) < 0.5) continue;
      if (field.featureClearance(x, z) < clearance) continue;
      sites.push({ x, z, y });
    }
  }
  if (sites.length === 0) {
    recipe.features.blobs = recipe.features.blobs.filter((b) => !b.id.startsWith("monolith-"));
    writeRecipe(recipe, file);
    console.log(`no site had "${biomeId}" membership above 0.5 — check the biome exists with: worldgen map ${worldName}`);
    return;
  }

  // Pick each field's centre by DENSITY: the candidate with the most other
  // candidates around it is the deepest part of the zone, which is where a
  // landmark belongs and where the ground is least likely to be a fringe.
  const centres: { x: number; z: number; n: number }[] = [];
  const taken: { x: number; z: number }[] = [];
  for (let f = 0; f < fields; f++) {
    let best: { x: number; z: number; n: number } | null = null;
    for (const site of sites) {
      if (!taken.every((t) => Math.hypot(t.x - site.x, t.z - site.z) > fieldRadius * 1.8)) continue;
      let n = 0;
      for (const other of sites) {
        if (Math.hypot(other.x - site.x, other.z - site.z) < fieldRadius) n += 1;
      }
      if (!best || n > best.n) best = { x: site.x, z: site.z, n };
    }
    if (!best) break;
    centres.push(best);
    taken.push({ x: best.x, z: best.z });
  }

  // Shuffle so the greedy separation pass does not sweep the field in raster
  // order, which packs one edge and leaves the other bare.
  for (let i = sites.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [sites[i], sites[j]] = [sites[j]!, sites[i]!];
  }

  const blobs = recipe.features.blobs.filter((b) => !b.id.startsWith("monolith-"));
  const placed: { x: number; z: number }[] = [];
  const tallest = option("tallest", 170);
  const shortest = option("shortest", 50);
  const perField = Math.max(1, Math.round(count / centres.length));
  for (const centre of centres) {
    let here = 0;
    for (const site of sites) {
      if (here >= perField) break;
      const d = Math.hypot(site.x - centre.x, site.z - centre.z);
      if (d > fieldRadius) continue;
      // thin out toward the rim: a hard-edged disc of spires reads as a
      // cookie cutter, a field that fades reads as erosion
      const t = d / fieldRadius;
      if (random() > 1 - t * t * 0.7) continue;
      if (!placed.every((p) => Math.hypot(p.x - site.x, p.z - site.z) > separation)) continue;

      // A spire is an ASPECT RATIO, not a width: pick height and radius
      // independently and the tall ones come out as fat mesas and the short
      // ones as posts. One in four is deliberately a squat butte — a field of
      // nothing but needles reads as a pin cushion.
      const butte = random() < 0.17;
      const height = butte ? 30 + random() * 45 : shortest + random() * Math.max(0, tallest - shortest);
      const aspect = butte ? 2.4 + random() * 1.6 : 8 + random() * 6;
      const radius = Math.max(3, height / aspect);
      placed.push({ x: site.x, z: site.z });
      here += 1;
      blobs.push({
        id: `monolith-${placed.length}`,
        // rooted well BELOW the ground line so the wide base merges into the
        // sand as a talus foot; a capsule that starts at the surface stands on
        // it like a dropped pipe
        center: [round(site.x), round(site.y - radius * 1.5 - 3), round(site.z)],
        radius: round(radius),
        op: "add" as const,
        falloff: 3,
        height: round(height),
        // strongly tapered: a spire that narrows as it rises reads as
        // weathered stone, a cylinder reads as a prop
        topRadius: round(radius * (butte ? 0.72 + random() * 0.2 : 0.22 + random() * 0.26)),
        // squashed in plan so they read as weathered slabs, not extruded circles
        scaleX: round(0.7 + random() * 0.85),
        scaleZ: round(0.7 + random() * 0.85),
      });
    }
  }

  recipe.features.blobs = blobs;
  // A landmark you cannot find is not a landmark: mark each field so the POI
  // list, and anything downstream reading it, knows where to send you.
  recipe.features.pois = [
    ...recipe.features.pois.filter((p) => p.kind !== "spire-field"),
    ...centres.map((c, i) => ({
      id: `spires-${i + 1}`,
      kind: "spire-field",
      position: [round(c.x), round(field.height(c.x, c.z)), round(c.z)] as [number, number, number],
      rotationY: 0,
      tags: [`radius:${fieldRadius}`, `biome:${biomeId}`],
    })),
  ];
  writeRecipe(recipe, file);
  const peak = blobs.filter((b) => b.id.startsWith("monolith-")).reduce((m, b) => Math.max(m, b.height), 0);
  console.log(
    `raised ${placed.length} spires in ${centres.length} field(s) of ${fieldRadius}m, from ${sites.length} "${biomeId}" sites (tallest ${peak.toFixed(0)}m)`,
  );
  for (const c of centres) console.log(`  field centre [${c.x.toFixed(0)}, ${c.z.toFixed(0)}]  ground ${field.height(c.x, c.z).toFixed(0)}m`);
}

// ---------------------------------------------------------------- map

/**
 * A PNG overview: biome colour shaded by terrain slope, with water, rivers,
 * roads and towns drawn over it.
 *
 * This exists because a world you cannot look at is a world you cannot tune,
 * and opening the browser to answer "did the rivers reach the sea" is a slow
 * way to ask. It is also how an agent checks its own work — the map is a file
 * it can generate and read back.
 */
/** A stable, distinguishable colour per zone id for the overview. */
const ZONE_COLOURS: Record<string, [number, number, number]> = {
  tundra: [214, 224, 230],
  taiga: [78, 112, 84],
  mountains: [140, 132, 124],
  highlands: [150, 160, 96],
  grassland: [132, 176, 78],
  forest: [58, 120, 52],
  swamp: [96, 112, 62],
  jungle: [34, 130, 60],
  desert: [226, 200, 130],
  badlands: [190, 110, 70],
  blight: [90, 74, 68],
};

function commandMap(): void {
  const { recipe } = loadRecipe();
  const extent = extentFor(recipe);
  const size = Math.round(option("size", 900));
  // Centre the window somewhere other than the origin. A world-wide map at
  // 10 m per pixel cannot show dunes or a mottled blight; --cx/--cz --extent
  // 300 is how you actually check that a zone looks like the place it claims.
  const cx = option("cx", 0);
  const cz = option("cz", 0);
  const byZone = flag("zones");
  // --plain: terrain and water only, no markers — for judging the river
  // network itself, which the POI squares bury at world scale
  const plain = flag("plain");
  const field = createWorldField(recipe);
  const step = (extent * 2) / size;
  const pixels = new Uint8Array(size * size * 3);
  const surfaces = recipe.surfaces.map((s) => hexToRgb(s.color));
  const anchors = recipe.climate.zones?.anchors ?? [];
  const anchorColour = anchors.map((a, i) => ZONE_COLOURS[a.id] ?? [80 + ((i * 97) % 150), 80 + ((i * 61) % 150), 80 + ((i * 37) % 150)]);
  // MAX_SURFACES wide, not surfaces.length: splatAt always writes the full
  // palette width, and a short buffer silently drops the writes past its end —
  // then reads back undefined, so every land pixel came out NaN and rendered
  // BLACK the moment the palette grew past four.
  const splat = new Float32Array(MAX_SURFACES);
  const limit = field.worldLimit;

  for (let py = 0; py < size; py++) {
    const z = cz - extent + py * step;
    for (let px = 0; px < size; px++) {
      const x = cx - extent + px * step;
      const beyond = limit !== Infinity && x * x + z * z > limit * limit;
      const h = beyond ? recipe.bounds!.oceanFloor : field.height(x, z);
      const slope = beyond ? 0 : field.slope(x, z);
      let r: number;
      let g: number;
      let b: number;
      if (h < recipe.seaLevel) {
        // depth-shaded ocean, so the coastline reads
        const depth = Math.min(1, (recipe.seaLevel - h) / 40);
        r = 30 + (1 - depth) * 40;
        g = 70 + (1 - depth) * 60;
        b = 120 + (1 - depth) * 70;
        if (beyond) {
          r *= 0.7;
          g *= 0.7;
          b *= 0.7;
        }
      } else {
        const water = field.waterY(x, z);
        if (water !== null) {
          // inland water: lakes and river channels, at whatever level they sit
          const depth = Math.min(1, (water - h) / 8);
          r = 60 + (1 - depth) * 30;
          g = 120 + (1 - depth) * 40;
          b = 190 + (1 - depth) * 40;
        } else if (byZone && anchors.length > 0) {
          const zone = field.zone(x, z);
          r = g = b = 0;
          for (let i = 0; i < anchors.length; i++) {
            const w = zone.weights[i]!;
            r += anchorColour[i]![0] * w;
            g += anchorColour[i]![1] * w;
            b += anchorColour[i]![2] * w;
          }
          const shade = 0.6 + 0.5 * Math.max(0, 1 - slope * 1.7);
          r *= shade;
          g *= shade;
          b *= shade;
        } else {
          field.splatAt(x, h, z, Math.sqrt(Math.max(0, 1 - slope * slope)), splat, 0);
          r = g = b = 0;
          for (let i = 0; i < surfaces.length; i++) {
            const w = splat[i]!;
            r += surfaces[i]![0] * w;
            g += surfaces[i]![1] * w;
            b += surfaces[i]![2] * w;
          }
          // hillshade from the north-west, the cartographic convention
          const shade = 0.72 + 0.55 * Math.max(0, 1 - slope * 1.7);
          r *= 255 * shade;
          g *= 255 * shade;
          b *= 255 * shade;
        }
      }
      const o = (px + py * size) * 3;
      pixels[o] = clamp255(r);
      pixels[o + 1] = clamp255(g);
      pixels[o + 2] = clamp255(b);
    }
  }

  const toPixel = (x: number, z: number): [number, number] => [
    Math.round((x - cx + extent) / step),
    Math.round((z - cz + extent) / step),
  ];
  const plot = (px: number, py: number, rgb: [number, number, number], radius = 0): void => {
    for (let dy = -radius; dy <= radius; dy++) {
      for (let dx = -radius; dx <= radius; dx++) {
        const x = px + dx;
        const y = py + dy;
        if (x < 0 || y < 0 || x >= size || y >= size) continue;
        const o = (x + y * size) * 3;
        pixels[o] = rgb[0];
        pixels[o + 1] = rgb[1];
        pixels[o + 2] = rgb[2];
      }
    }
  };
  const stroke = (
    points: readonly (readonly [number, number])[],
    rgb: [number, number, number],
    radius: number,
  ): void => {
    for (let i = 0; i + 1 < points.length; i++) {
      const [ax, ay] = toPixel(points[i]![0], points[i]![1]);
      const [bx, by] = toPixel(points[i + 1]![0], points[i + 1]![1]);
      const steps = Math.max(1, Math.round(Math.hypot(bx - ax, by - ay)));
      for (let s = 0; s <= steps; s++) {
        const t = s / steps;
        plot(Math.round(ax + (bx - ax) * t), Math.round(ay + (by - ay) * t), rgb, radius);
      }
    }
  };

  if (!plain) {
    for (const canyon of recipe.features.canyons) {
      stroke(canyon.points, [120, 84, 58], Math.max(1, Math.round(canyon.width / (2 * step))));
    }
  }
  // rivers at their real width where the scale allows: a trunk reads wider than its brooks
  for (const river of recipe.features.rivers) {
    const widths = river.widths && river.widths.length === river.points.length ? river.widths : null;
    for (let i = 0; i + 1 < river.points.length; i++) {
      const w = widths ? (widths[i]! + widths[i + 1]!) / 2 : river.width;
      stroke([river.points[i]!, river.points[i + 1]!], [70, 150, 235], Math.round(w / (2 * step)));
    }
  }
  for (const bridge of recipe.features.bridges) stroke(bridge.points, [250, 250, 250], Math.max(1, Math.round(bridge.width / step)));
  if (plain) {
    const out = path.join(assetsRoot(), "..", `${recipe.name}-map-plain.png`);
    fs.writeFileSync(out, encodePng(pixels, size, size));
    console.log(`wrote ${path.relative(process.cwd(), out)}  (${size}x${size}, ${extent * 2} world units across, ${step.toFixed(1)} m/px, plain)`);
    return;
  }
  for (const road of recipe.features.roads) stroke(road.points, road.id.startsWith("trail-") ? [200, 170, 110] : [235, 215, 160], road.id.startsWith("trail-") ? 0 : 1);
  for (const town of recipe.features.towns) {
    const [px, py] = toPixel(town.center[0], town.center[1]);
    plot(px, py, [240, 60, 60], Math.max(2, Math.round(town.radius / step)));
  }
  // Additive blobs stand above the heightfield this map samples, so they are
  // invisible to it by construction. Plot them, or a stage that raised forty
  // pillars looks like a stage that did nothing.
  for (const blob of recipe.features.blobs) {
    if (blob.op !== "add") continue;
    const [px, py] = toPixel(blob.center[0], blob.center[2]);
    plot(px, py, [70, 66, 62], Math.max(1, Math.round((blob.radius * Math.max(blob.scaleX, blob.scaleZ)) / step)));
  }
  for (const poi of recipe.features.pois) {
    const [px, py] = toPixel(poi.position[0], poi.position[2]);
    plot(px, py, poi.kind === "falls" ? [120, 220, 255] : poi.kind === "peak" ? [255, 235, 90] : [255, 180, 90], poi.kind === "falls" ? 1 : 2);
  }
  if (limit !== Infinity) {
    const pts: [number, number][] = [];
    for (let a = 0; a <= Math.PI * 2 + 0.01; a += 0.01) pts.push([Math.cos(a) * limit, Math.sin(a) * limit]);
    stroke(pts, [200, 40, 40], 0);
  }

  const out = path.join(assetsRoot(), "..", `${recipe.name}-map${byZone ? "-zones" : ""}.png`);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const png = encodePng(pixels, size, size);
  fs.writeFileSync(out, png);
  // a copy inside the asset tree, where the running app can fetch it for the
  // in-game map (M key); the project-root copy is the one humans open
  if (!byZone && cx === 0 && cz === 0) {
    const inAssets = path.join(assetsRoot(), "maps", `${recipe.name}.png`);
    fs.mkdirSync(path.dirname(inAssets), { recursive: true });
    fs.writeFileSync(inAssets, png);
  }
  console.log(`wrote ${path.relative(process.cwd(), out)}  (${size}x${size}, ${extent * 2} world units across, ${step.toFixed(1)} m/px)`);
  console.log("  blue = rivers/lakes, brown = canyons, tan = town paths, thin tan = peak trails, red = towns, yellow = peaks, cyan = waterfalls, red ring = world limit");
  if (byZone) console.log(`  zones: ${anchors.map((a, i) => `${a.id} rgb(${anchorColour[i]!.join(",")})`).join(", ")}`);
}

function clamp255(v: number): number {
  return v < 0 ? 0 : v > 255 ? 255 : Math.round(v);
}

function hexToRgb(hex: string): [number, number, number] {
  const v = parseInt(hex.replace("#", ""), 16);
  return [((v >> 16) & 255) / 255, ((v >> 8) & 255) / 255, (v & 255) / 255];
}

/** Minimal PNG encoder (RGB8, one IDAT) — node's zlib does the only hard part. */
function encodePng(rgb: Uint8Array, width: number, height: number): Buffer {
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 3 + 1)] = 0; // filter: none
    Buffer.from(rgb.buffer, rgb.byteOffset + y * width * 3, width * 3).copy(
      raw,
      y * (width * 3 + 1) + 1,
    );
  }
  const chunk = (type: string, data: Buffer): Buffer => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body) >>> 0);
    return Buffer.concat([length, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type: truecolour
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buffer: Buffer): number {
  let c = -1;
  for (let i = 0; i < buffer.length; i++) c = CRC_TABLE[(c ^ buffer[i]!) & 0xff]! ^ (c >>> 8);
  return c ^ -1;
}

// ---------------------------------------------------------------- stats

/**
 * Mesh some cells for real and report what it cost.
 *
 * The numbers that matter for a streamed world are per-cell triangle count and
 * per-cell build time, because those are what a chunk crossing pays in one
 * synchronous lump. Getting them here, in Node, before opening the browser, is
 * how you find out that `resolution: 64` was a bad idea.
 */
function commandStats(): void {
  const { recipe } = loadRecipe();
  const field = createWorldField(recipe);
  const extent = extentFor(recipe);

  // the mix: a coarse sweep of the whole world, land only
  const zoneCount = new Map<string, number>();
  const biomeCount = new Map<string, number>();
  const heights: number[] = [];
  let land = 0;
  let sea = 0;
  let inland = 0;
  let steep = 0;
  const sweep = Math.max(40, extent / 90);
  for (let z = -extent; z <= extent; z += sweep) {
    for (let x = -extent; x <= extent; x += sweep) {
      if (field.worldLimit !== Infinity && x * x + z * z > field.worldLimit ** 2) continue;
      const h = field.height(x, z);
      if (h < recipe.seaLevel) {
        sea++;
        continue;
      }
      land++;
      heights.push(h);
      const water = field.waterY(x, z);
      if (water !== null) inland++;
      const b = field.biome(x, z, h);
      biomeCount.set(b.id, (biomeCount.get(b.id) ?? 0) + 1);
      if (b.slope > 0.78) steep++;
      if (b.zone) zoneCount.set(b.zone, (zoneCount.get(b.zone) ?? 0) + 1);
    }
  }
  heights.sort((a, b) => a - b);
  const pct = (n: number, of: number): string => `${((100 * n) / Math.max(1, of)).toFixed(1)}%`;
  const q = (f: number): string => (heights[Math.floor(f * (heights.length - 1))] ?? 0).toFixed(0);
  console.log(`world "${recipe.name}"  seed ${recipe.seed}  ${field.worldLimit !== Infinity ? `limit ${field.worldLimit}m` : "endless"}`);
  console.log(`  land ${pct(land, land + sea)} of the area inside the limit; inland water ${pct(inland, land)} of land; near-vertical ${pct(steep, land)}`);
  console.log(`  land height p10/p50/p90/max: ${q(0.1)} / ${q(0.5)} / ${q(0.9)} / ${q(1)} m`);
  if (zoneCount.size > 0) {
    console.log(`  zones (share of land): ${[...zoneCount].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${pct(v, land)}`).join(", ")}`);
  }
  console.log(`  biomes (share of land): ${[...biomeCount].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${pct(v, land)}`).join(", ")}`);
  console.log(
    `  features: ${recipe.features.rivers.length} rivers, ${recipe.features.lakes.length} lakes, ${recipe.features.roads.filter((r) => !r.id.startsWith("trail-")).length} paths, ` +
      `${recipe.features.roads.filter((r) => r.id.startsWith("trail-")).length} trails, ${recipe.features.towns.length} towns, ${recipe.features.canyons.length} canyons, ` +
      `${recipe.features.tunnels.length} tunnels, ${recipe.features.pois.length} POIs`,
  );
  const landKm2 = (land * sweep * sweep) / 1e6;
  console.log(`  ~${landKm2.toFixed(1)} km² (${(landKm2 / 2.59).toFixed(1)} sq mi) of land: ${(recipe.features.pois.length / (landKm2 / 2.59)).toFixed(1)} POIs and ${(recipe.features.towns.length / (landKm2 / 2.59)).toFixed(1)} towns per sq mi`);

  // meshing cost on real LAND cells spread across the world, after a warm-up
  const random = mulberry32(recipe.seed ^ 0x57a75);
  const cells: [number, number][] = [];
  const wanted = Math.max(1, Math.round(option("cells", 12)));
  for (let tries = 0; cells.length < wanted && tries < 2000; tries++) {
    const cx = Math.floor(((random() * 2 - 1) * extent * 0.9) / recipe.cellSize);
    const cz = Math.floor(((random() * 2 - 1) * extent * 0.9) / recipe.cellSize);
    const x = (cx + 0.5) * recipe.cellSize;
    const z = (cz + 0.5) * recipe.cellSize;
    if (field.worldLimit !== Infinity && x * x + z * z > field.worldLimit ** 2) continue;
    if (field.height(x, z) < recipe.seaLevel) continue;
    cells.push([cx, cz]);
  }
  for (const [cx, cz] of cells.slice(0, 3)) {
    buildVoxelMesh(field, { kind: "voxel", world: recipe.name, cell: [cx, cz] });
    scatterCell(field, cx, cz);
  }
  let triangles = 0;
  let vertices = 0;
  let meshMs = 0;
  let props = 0;
  let scatterMs = 0;
  let worst = 0;
  for (const [cx, cz] of cells) {
    const t0 = performance.now();
    const mesh = buildVoxelMesh(field, { kind: "voxel", world: recipe.name, cell: [cx, cz] });
    const dt = performance.now() - t0;
    meshMs += dt;
    worst = Math.max(worst, dt);
    const t1 = performance.now();
    const instances = scatterCell(field, cx, cz);
    scatterMs += performance.now() - t1;
    triangles += mesh.triangleCount;
    vertices += mesh.vertexCount;
    props += instances.length;
  }
  const n = Math.max(1, cells.length);
  const voxel = recipe.cellSize / recipe.resolution;
  console.log(`  cell ${recipe.cellSize}m / ${recipe.resolution} = ${voxel.toFixed(2)}m voxels; ${n} land cells meshed`);
  console.log(`    ${Math.round(triangles / n)} tris/cell, ${Math.round(vertices / n)} verts/cell`);
  console.log(`    ${(meshMs / n).toFixed(1)} ms/cell to mesh (worst ${worst.toFixed(1)}), ${(scatterMs / n).toFixed(1)} ms/cell to scatter, ${(props / n).toFixed(1)} props/cell`);
  const budget = 16;
  if (meshMs / n > budget) {
    console.log(
      `\n  WARNING: ${(meshMs / n).toFixed(1)} ms/cell exceeds a ${budget} ms frame budget — a chunk crossing will hitch.\n` +
        `  Lower \`resolution\`, or shrink \`verticalRange.below\` (it multiplies the volume linearly).`,
    );
  }
}

// ---------------------------------------------------------------- entry

switch (command) {
  case "init":
    commandInit();
    break;
  case "rivers":
    commandRivers();
    break;
  case "towns":
    commandTowns();
    break;
  case "paths":
  case "roads":
    commandPaths();
    break;
  case "trails":
    commandTrails();
    break;
  case "continents":
    commandContinents();
    break;
  case "pois":
    commandPois();
    break;
  case "caves":
    commandCaves();
    break;
  case "canyons":
    commandCanyons();
    break;
  case "monoliths":
    commandMonoliths();
    break;
  case "material":
    commandMaterial();
    break;
  case "map":
    commandMap();
    break;
  case "audit":
    commandAudit();
    break;
  case "river-path":
    commandRiverPath();
    break;
  case "profile":
    commandProfile();
    break;
  case "descend":
    commandDescend();
    break;
  case "stats":
    commandStats();
    break;
  case "all": {
    if (!findRecipeFile(worldName)) commandInit();
    // canyons BEFORE rivers: the hydrology then drains through the gorges it
    // finds; cut after, a canyon floor under a lake outline flooded 90 m deep
    commandCanyons();
    commandRivers();
    commandTowns();
    commandPaths();
    commandPois();
    commandTrails();
    commandCaves();
    commandMap();
    commandStats();
    break;
  }
  default:
    console.log(HELP);
    process.exit(command === "help" ? 0 : 1);
}

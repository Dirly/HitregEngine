#!/usr/bin/env tsx
/**
 * worldgen — the world pipeline, one stage per command.
 *
 * ```text
 * init  ->  rivers  ->  towns  ->  roads  ->  pois        ->  (WFC buildings)
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
 *   pnpm -F playground worldgen roads  <world>
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
} from "@hitreg/core";

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

  init   <world>   write a complete starting recipe (+ terrain material, --scene for a scene)
  continents <world> give the world an EDGE: N landmasses ringed by open ocean
                   (--count 2 --radius 2000 --falloff 700 --gap 900 --ocean -45)
  rivers <world>   trace watercourses downhill from the high ground and carve them
  towns  <world>   find flat, low, water-adjacent sites and flatten a pad at each
  roads  <world>   grade least-cost roads between towns, avoiding slopes and rivers
  pois   <world>   place landmark points on distinctive ground
  caves  <world>   find cave mouths and MEASURE whether a player capsule fits through them
  canyons <world>  cut terraced gorges across the high plateaus (--count 6)
  monoliths <world> raise rock spires in a zone (--biome desert --count 44 --tallest 150)
  material <world> re-emit the terrain material from the recipe surfaces (after adding textures)
  map    <world>   render a PNG overview (biomes, water, rivers, roads, towns); --cx/--cz to centre it
  stats  <world>   mesh a few cells and report triangle counts, timings, biome mix
  all    <world>   init (if missing) + rivers + canyons + towns + roads + pois + caves + monoliths + map

Options: --project <name>  --seed N  --extent <world units>  --count N  --size <px>  --scene`;

function commandInit(): void {
  const file = recipePath();
  if (fs.existsSync(file) && !flag("force")) {
    fail(`${path.relative(process.cwd(), file)} already exists (pass --force to overwrite)`);
  }
  const seed = option("seed", 1337);
  const material = `terrain/${worldName}`;
  const recipe = worldRecipeSchema.parse({
    ...defaultWorldRecipe(),
    name: worldName,
    seed,
    material,
    scatter: defaultScatter(),
  });
  writeRecipe(recipe, file);
  writeTerrainMaterial(recipe, material);
  if (flag("scene")) writeScene(recipe);
  console.log(
    `\nnext:\n  worldgen rivers ${worldName}${project ? ` --project ${project}` : ""}\n` +
      `  worldgen towns ${worldName}\n  worldgen roads ${worldName}\n  worldgen map ${worldName}`,
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
      biomes: ["meadow", "highland"],
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
      biomes: ["meadow", "beach", "desert"],
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
            source: { kind: "primitive", shape: "plane", size: [7000, 1, 7000], segments: [180, 180] },
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

/**
 * Trace watercourses by steepest descent from high ground.
 *
 * Real rivers erode through obstacles rather than stopping at the first dip,
 * so a walk that finds itself in a local minimum is allowed to climb out a
 * bounded number of times — without that, almost every trace dies within a
 * few hundred metres in a noise basin and you get puddles instead of rivers.
 * The recorded bed is then forced monotonically downhill, which is what makes
 * the carved channel actually flow rather than pool in the middle.
 */
function commandRivers(): void {
  const { recipe, file } = loadRecipe();
  const extent = option("extent", 3000);
  const count = option("count", 8);
  const grid = sampleGrid(createWorldField(recipe), extent, Math.round(option("grid", 320)));
  const random = mulberry32(recipe.seed ^ 0x5ca1ab1e);

  // sources: the highest samples, spread out so eight rivers aren't one river
  const candidates: { ix: number; iz: number; h: number }[] = [];
  for (let iz = 2; iz < grid.n - 2; iz++) {
    for (let ix = 2; ix < grid.n - 2; ix++) {
      candidates.push({ ix, iz, h: grid.at(ix, iz) });
    }
  }
  candidates.sort((a, b) => b.h - a.h);
  const minSeparation = (extent * 2) / Math.max(2, Math.sqrt(count) * 1.6);
  const sources: { ix: number; iz: number }[] = [];
  for (const candidate of candidates) {
    if (sources.length >= count) break;
    if (candidate.h < recipe.seaLevel + 25) break; // nothing left high enough to source a river
    const x = grid.worldX(candidate.ix);
    const z = grid.worldZ(candidate.iz);
    const clear = sources.every(
      (s) => Math.hypot(grid.worldX(s.ix) - x, grid.worldZ(s.iz) - z) > minSeparation,
    );
    if (clear) sources.push({ ix: candidate.ix, iz: candidate.iz });
  }
  if (sources.length === 0) fail("no ground high enough to source a river — raise terrain amplitude or lower seaLevel");

  const rivers: RiverDoc[] = [];
  sources.forEach((source, index) => {
    const path = traceDownhill(grid, source.ix, source.iz, recipe.seaLevel, random);
    if (path.length < 6) return;
    // Tolerance is in GRID INDEX units, not world units — `path` holds lattice
    // coordinates, and mixing the two collapses every river to a straight line.
    // Simplified in 3D (see simplify3) so the bed keeps a control point at every
    // drop instead of becoming one long ramp between source and sea.
    const pathHeights = path.map((p) => grid.at(p[0], p[1]));
    const keptIndices = simplify3(path, pathHeights, RIVER_SIMPLIFY, RIVER_HEIGHT_WEIGHT / grid.step);
    if (keptIndices.length < 3) return;
    const simplified = keptIndices.map((i) => path[i]!);
    const points = simplified.map((p) => [grid.worldX(p[0]), grid.worldZ(p[1])] as [number, number]);
    const heights = keptIndices.map((i) => pathHeights[i]!);
    // a river only ever flows down, and cuts a little deeper as it gathers
    const bedY: number[] = [];
    let running = Infinity;
    heights.forEach((h, i) => {
      const depth = 1.5 + 2.5 * (i / Math.max(1, heights.length - 1));
      running = Math.min(running, h - depth);
      bedY.push(Math.max(running, recipe.seaLevel - 4));
    });
    const width = 6 + Math.round(random() * 6);
    rivers.push({
      id: `river-${index + 1}`,
      points,
      width,
      depth: 4,
      bank: width * 2.2,
      bedY,
    });
  });

  recipe.features.rivers = rivers;
  writeRecipe(recipe, file);
  const totalPoints = rivers.reduce((n, r) => n + r.points.length, 0);
  console.log(`carved ${rivers.length} rivers (${totalPoints} control points)`);
  for (const river of rivers) {
    const from = river.points[0]!;
    const to = river.points[river.points.length - 1]!;
    console.log(
      `  ${river.id}: [${from[0].toFixed(0)}, ${from[1].toFixed(0)}] -> [${to[0].toFixed(0)}, ${to[1].toFixed(0)}]  width ${river.width}`,
    );
  }
}

function traceDownhill(
  grid: HeightGrid,
  startX: number,
  startZ: number,
  seaLevel: number,
  random: () => number,
): [number, number][] {
  const path: [number, number][] = [[startX, startZ]];
  const visited = new Set<number>([startX + startZ * grid.n]);
  let ix = startX;
  let iz = startZ;
  let climbBudget = 24; // erosion allowance: how often it may cross a lip
  const maxSteps = grid.n * 3;

  for (let step = 0; step < maxSteps; step++) {
    const here = grid.at(ix, iz);
    if (here <= seaLevel) break; // reached the ocean — done
    let best: [number, number] | null = null;
    let bestH = Infinity;
    for (const [dx, dz] of NEIGHBORS) {
      const nx = ix + dx;
      const nz = iz + dz;
      if (nx < 1 || nz < 1 || nx >= grid.n - 1 || nz >= grid.n - 1) continue;
      if (visited.has(nx + nz * grid.n)) continue;
      // a touch of noise so a river follows a valley instead of a pixel diagonal
      const h = grid.at(nx, nz) + (random() - 0.5) * 0.6;
      if (h < bestH) {
        bestH = h;
        best = [nx, nz];
      }
    }
    if (!best) break; // boxed in by its own path
    if (bestH > here) {
      if (climbBudget-- <= 0) break; // stuck in a basin with nothing left to erode
    }
    ix = best[0];
    iz = best[1];
    visited.add(ix + iz * grid.n);
    path.push([ix, iz]);
  }
  return path;
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
 * Site towns where a town would actually go: flat, above the waterline but not
 * in the mountains, and near fresh water. The scoring is transparent on
 * purpose — each term is printed with the result, so a world that sites its
 * towns somewhere daft can be diagnosed by reading the numbers rather than by
 * staring at the map.
 */
function commandTowns(): void {
  const { recipe, file } = loadRecipe();
  const extent = option("extent", 3000);
  const count = option("count", 6);
  const field = createWorldField(recipe);
  const grid = sampleGrid(field, extent, Math.round(option("grid", 240)));
  const radius = option("radius", 45);
  const minSeparation = option("separation", radius * 6);

  const scored: { x: number; z: number; score: number; flat: number; water: number; ground: number }[] = [];
  const probe = Math.max(2, Math.round(radius / grid.step));
  for (let iz = probe; iz < grid.n - probe; iz += 1) {
    for (let ix = probe; ix < grid.n - probe; ix += 1) {
      const h = grid.at(ix, iz);
      if (h < recipe.seaLevel + 2 || h > recipe.seaLevel + 70) continue;

      // flatness: mean slope, and the height spread, over the whole pad
      let slopeSum = 0;
      let min = Infinity;
      let max = -Infinity;
      let samples = 0;
      for (let dz = -probe; dz <= probe; dz += 2) {
        for (let dx = -probe; dx <= probe; dx += 2) {
          const hh = grid.at(ix + dx, iz + dz);
          slopeSum += grid.slope[clampIndex(ix + dx, grid.n) + clampIndex(iz + dz, grid.n) * grid.n]!;
          if (hh < min) min = hh;
          if (hh > max) max = hh;
          samples += 1;
        }
      }
      const meanSlope = slopeSum / samples;
      const spread = max - min;
      if (meanSlope > 0.25 || spread > 22) continue; // too rough to build on

      const x = grid.worldX(ix);
      const z = grid.worldZ(iz);
      const water = waterProximity(recipe, x, z, recipe.seaLevel, h);
      const flat = 1 - meanSlope / 0.25;
      const score = flat * 2 + water * 1.5 + (1 - Math.abs(h - recipe.seaLevel - 14) / 60);
      scored.push({ x, z, score, flat, water, ground: (min + max) / 2 });
    }
  }
  if (scored.length === 0) fail("no buildable ground found — widen --extent or soften the terrain");

  scored.sort((a, b) => b.score - a.score);
  const towns: TownDoc[] = [];
  for (const site of scored) {
    if (towns.length >= count) break;
    const clear = towns.every((t) => Math.hypot(t.center[0] - site.x, t.center[1] - site.z) > minSeparation);
    if (!clear) continue;
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
        `flat ${site.flat.toFixed(2)} water ${site.water.toFixed(2)}`,
    );
  }

  recipe.features.towns = towns;
  writeRecipe(recipe, file);
  console.log(`sited ${towns.length} towns`);
}

/** 0..1 — how close this point is to a river or the sea. */
function waterProximity(recipe: WorldRecipe, x: number, z: number, seaLevel: number, h: number): number {
  let best = Infinity;
  for (const river of recipe.features.rivers) {
    for (let i = 0; i + 1 < river.points.length; i++) {
      best = Math.min(best, pointSegmentDistance([x, z], river.points[i]!, river.points[i + 1]!));
    }
  }
  const riverScore = best === Infinity ? 0 : Math.max(0, 1 - best / 300);
  const coastScore = Math.max(0, 1 - Math.abs(h - seaLevel) / 25);
  return Math.max(riverScore, coastScore * 0.8);
}

function round(v: number): number {
  return Math.round(v * 100) / 100;
}

// ---------------------------------------------------------------- roads

/**
 * Connect the towns with graded roads.
 *
 * The route is an A* over the height grid whose cost punishes GRADE, not
 * distance — a road that goes around a hill is cheaper than one that goes over
 * it, which is what makes the result look like a road rather than a straight
 * line drawn on terrain. River crossings are allowed but expensive, so roads
 * cross at few places and those places are where bridges belong.
 *
 * The road graph is a minimum spanning tree (everywhere reachable, no
 * redundancy) plus the shortest few extra links, because a pure tree makes
 * every journey pass through the capital.
 */
function commandRoads(): void {
  const { recipe, file } = loadRecipe();
  const towns = recipe.features.towns;
  if (towns.length < 2) fail("need at least two towns — run: worldgen towns <world>");
  const extent = option("extent", 3000);
  const field = createWorldField(recipe);
  const grid = sampleGrid(field, extent, Math.round(option("grid", 260)));
  const riverMask = buildRiverMask(recipe, grid);

  // Towns on different islands cannot be joined by a road, and a spanning tree
  // that does not know that produces roads striding across open ocean. Group
  // the towns by which landmass they stand on first, and span each group.
  const landmass = landComponents(grid, recipe.seaLevel);
  const groups = new Map<number, number[]>();
  towns.forEach((town, index) => {
    const [ix, iz] = grid.nearest(town.center[0], town.center[1]);
    const id = landmass[ix + iz * grid.n]!;
    const list = groups.get(id);
    if (list) list.push(index);
    else groups.set(id, [index]);
  });
  if (groups.size > 1) {
    console.log(`  towns sit on ${groups.size} separate landmasses — roading each independently`);
  }

  const edges: [number, number][] = [];
  for (const members of groups.values()) {
    const local = spanningEdges(
      members.map((i) => towns[i]!),
      option("extra", 2),
    );
    for (const [a, b] of local) edges.push([members[a]!, members[b]!]);
  }

  const roads: RoadDoc[] = [];
  for (const [a, b] of edges) {
    const from = grid.nearest(towns[a]!.center[0], towns[a]!.center[1]);
    const to = grid.nearest(towns[b]!.center[0], towns[b]!.center[1]);
    const route = aStar(grid, riverMask, from, to, recipe.seaLevel);
    if (!route) {
      console.warn(`  no route between ${towns[a]!.id} and ${towns[b]!.id}`);
      continue;
    }
    // simplify in 3D so the road keeps a control point at every rise and dip,
    // not just at every turn — see simplify3
    const routeHeights = route.map((p) => grid.at(p[0], p[1]));
    const kept = simplify3(route, routeHeights, ROAD_SIMPLIFY, ROAD_HEIGHT_WEIGHT / grid.step);
    const simplified = kept.map((i) => route[i]!);
    const points = simplified.map((p) => [grid.worldX(p[0]), grid.worldZ(p[1])] as [number, number]);
    const raw = kept.map((i) => routeHeights[i]!);
    // the towns' own pads are the fixed endpoints, or the road arrives at a cliff
    raw[0] = towns[a]!.groundY ?? raw[0]!;
    raw[raw.length - 1] = towns[b]!.groundY ?? raw[raw.length - 1]!;
    const surfaceY = gradeProfile(points, raw, option("maxGrade", 0.12));
    roads.push({
      id: `road-${towns[a]!.id}-${towns[b]!.id}`,
      points,
      width: 7,
      shoulder: 10,
      surfaceY,
      flatten: 1,
    });
    console.log(`  ${roads[roads.length - 1]!.id}: ${points.length} points`);
  }

  recipe.features.roads = roads;
  writeRecipe(recipe, file);
  console.log(`graded ${roads.length} roads`);
}

/**
 * Flood-fill the land into connected components (8-connected, above sea
 * level). Component 0 is water; land components count from 1.
 */
function landComponents(grid: HeightGrid, seaLevel: number): Int32Array {
  const n = grid.n;
  const out = new Int32Array(n * n);
  let next = 1;
  const stack: number[] = [];
  for (let start = 0; start < out.length; start++) {
    if (out[start] !== 0) continue;
    if (grid.height[start]! < seaLevel) continue;
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
        if (out[ni] !== 0 || grid.height[ni]! < seaLevel) continue;
        out[ni] = id;
        stack.push(ni);
      }
    }
  }
  return out;
}

/** Grid cells a river runs through — road crossings there cost extra. */
function buildRiverMask(recipe: WorldRecipe, grid: HeightGrid): Uint8Array {
  const mask = new Uint8Array(grid.n * grid.n);
  for (const river of recipe.features.rivers) {
    for (let i = 0; i + 1 < river.points.length; i++) {
      const a = river.points[i]!;
      const b = river.points[i + 1]!;
      const steps = Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / grid.step) + 1;
      for (let s = 0; s <= steps; s++) {
        const t = s / steps;
        const [ix, iz] = grid.nearest(a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t);
        mask[ix + iz * grid.n] = 1;
      }
    }
  }
  return mask;
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

/** A* over the height grid, costing grade far more heavily than distance. */
function aStar(
  grid: HeightGrid,
  riverMask: Uint8Array,
  start: [number, number],
  goal: [number, number],
  seaLevel: number,
): [number, number][] | null {
  const n = grid.n;
  const index = (ix: number, iz: number): number => ix + iz * n;
  const startIndex = index(start[0], start[1]);
  const goalIndex = index(goal[0], goal[1]);
  const gScore = new Float64Array(n * n).fill(Infinity);
  const cameFrom = new Int32Array(n * n).fill(-1);
  const closed = new Uint8Array(n * n);
  gScore[startIndex] = 0;

  // a binary heap keyed on f — a linear scan is O(n^2) and this grid is 68k cells
  const heap: { index: number; f: number }[] = [{ index: startIndex, f: 0 }];
  const push = (item: { index: number; f: number }): void => {
    heap.push(item);
    let i = heap.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (heap[parent]!.f <= heap[i]!.f) break;
      [heap[parent], heap[i]] = [heap[i]!, heap[parent]!];
      i = parent;
    }
  };
  const pop = (): { index: number; f: number } | undefined => {
    const top = heap[0];
    const last = heap.pop();
    if (heap.length > 0 && last) {
      heap[0] = last;
      let i = 0;
      for (;;) {
        const l = i * 2 + 1;
        const r = l + 1;
        let smallest = i;
        if (l < heap.length && heap[l]!.f < heap[smallest]!.f) smallest = l;
        if (r < heap.length && heap[r]!.f < heap[smallest]!.f) smallest = r;
        if (smallest === i) break;
        [heap[smallest], heap[i]] = [heap[i]!, heap[smallest]!];
        i = smallest;
      }
    }
    return top;
  };

  const heuristic = (i: number): number => {
    const ix = i % n;
    const iz = (i / n) | 0;
    return Math.hypot(ix - goal[0], iz - goal[1]) * grid.step;
  };

  while (heap.length > 0) {
    const current = pop()!;
    if (closed[current.index]) continue;
    if (current.index === goalIndex) break;
    closed[current.index] = 1;
    const ix = current.index % n;
    const iz = (current.index / n) | 0;
    const h0 = grid.at(ix, iz);
    for (const [dx, dz] of NEIGHBORS) {
      const nx = ix + dx;
      const nz = iz + dz;
      if (nx < 0 || nz < 0 || nx >= n || nz >= n) continue;
      const ni = index(nx, nz);
      if (closed[ni]) continue;
      // roads do not swim: the sea is a wall, not an expensive shortcut
      if (grid.height[ni]! < seaLevel) continue;
      const run = Math.hypot(dx, dz) * grid.step;
      const rise = Math.abs(grid.at(nx, nz) - h0);
      const grade = rise / run;
      // a 12% grade roughly doubles the cost; a cliff is effectively a wall
      const cost = run * (1 + grade * 8 + (grade > 0.35 ? 40 : 0)) + (riverMask[ni] ? 260 : 0);
      const tentative = gScore[current.index]! + cost;
      if (tentative >= gScore[ni]!) continue;
      gScore[ni] = tentative;
      cameFrom[ni] = current.index;
      push({ index: ni, f: tentative + heuristic(ni) });
    }
  }

  if (cameFrom[goalIndex] === -1 && goalIndex !== startIndex) return null;
  const out: [number, number][] = [];
  let node = goalIndex;
  for (let guard = 0; guard < n * n; guard++) {
    out.push([node % n, (node / n) | 0]);
    if (node === startIndex) break;
    node = cameFrom[node]!;
    if (node < 0) return null;
  }
  return out.reverse();
}

/**
 * Smooth a route's height profile into a drivable one: a couple of averaging
 * passes, then a forward/backward sweep clamping the grade. Without the clamp,
 * smoothing alone still leaves the odd 40% ramp where the route crosses a
 * ridge — passable on foot, absurd for a cart.
 */
function gradeProfile(points: [number, number][], heights: number[], maxGrade: number): number[] {
  const out = [...heights];
  // ONE smoothing pass, not three. Three passes of a [1,2,1] kernel over a
  // simplified polyline pulls the whole profile toward its mean — which,
  // combined with 2D simplification, is what made roads read as dead-level
  // causeways. The grade clamp below is what keeps a road drivable; smoothing
  // is only here to take the corner off a sampling step.
  for (let i = 1; i + 1 < out.length; i++) {
    out[i] = (out[i - 1]! + out[i]! * 2 + out[i + 1]!) / 4;
  }
  const span = (i: number): number =>
    Math.max(1e-3, Math.hypot(points[i]![0] - points[i - 1]![0], points[i]![1] - points[i - 1]![1]));
  for (let i = 1; i < out.length; i++) {
    const limit = span(i) * maxGrade;
    out[i] = Math.max(out[i - 1]! - limit, Math.min(out[i - 1]! + limit, out[i]!));
  }
  for (let i = out.length - 2; i >= 0; i--) {
    const limit = span(i + 1) * maxGrade;
    out[i] = Math.max(out[i + 1]! - limit, Math.min(out[i + 1]! + limit, out[i]!));
  }
  return out.map(round);
}

// ---------------------------------------------------------------- pois

/** Landmark points on distinctive ground: peaks, coves, river mouths, cliffs. */
/**
 * Give the world an edge.
 *
 * Without this a recipe is an ENDLESS noise field — "world size" is only
 * however far the CLI happened to scatter features, and a player who walks far
 * enough finds terrain forever and content never. This lays down N landmasses
 * with open ocean around and between them, which is the WoW/Skyrim shape: the
 * sea is the boundary, so nothing needs an invisible wall.
 *
 * Continents are placed on a ring (or at the origin, if there is one) rather
 * than at random: two landmasses drawn from noise regularly overlap into one
 * blob or drift so far apart the crossing is empty ocean, and neither is a
 * map anyone wants. `--gap` is the water between their coasts, so the sailing
 * distance is authored rather than discovered.
 */
function commandContinents(): void {
  const { recipe, file } = loadRecipe();
  const count = Math.max(1, Math.round(option("count", 2)));
  const radius = option("radius", 2000);
  const falloff = option("falloff", 700);
  const gap = option("gap", 900);
  const warp = option("warp", 0.55);
  const warpScale = option("warpScale", 1100);
  const oceanFloor = option("ocean", -45);

  if (oceanFloor <= recipe.minY) {
    console.error(
      `--ocean ${oceanFloor} is at or below the recipe's minY (${recipe.minY}); the sea bed would fall through the world's solid floor.`,
    );
    process.exit(1);
  }

  const continents: { center: [number, number]; radius: number; falloff: number; warp: number; warpScale: number }[] = [];
  if (count === 1) {
    continents.push({ center: [0, 0], radius, falloff, warp, warpScale });
  } else {
    // centre-to-centre spacing that leaves `gap` of water between the coasts
    const ringRadius = ((radius + falloff) * 2 + gap) / 2 / Math.sin(Math.PI / count);
    for (let i = 0; i < count; i++) {
      const a = (i / count) * Math.PI * 2;
      // a second landmass is smaller — an equal pair reads as a symmetry, not a world
      const r = i === 0 ? radius : radius * 0.72;
      continents.push({
        center: [round(Math.cos(a) * ringRadius), round(Math.sin(a) * ringRadius)],
        radius: round(r),
        falloff,
        warp,
        warpScale,
      });
    }
  }

  recipe.bounds = { continents, oceanFloor };
  writeRecipe(recipe, file);

  const reach = Math.max(...continents.map((c) => Math.hypot(c.center[0], c.center[1]) + c.radius + c.falloff));
  const land = continents.reduce((a, c) => a + Math.PI * c.radius * c.radius, 0) / 1e6;
  console.log(`${count} continent${count === 1 ? "" : "s"}, ocean floor ${oceanFloor}m:`);
  for (const c of continents) {
    console.log(`  centre [${c.center[0]}, ${c.center[1]}]  radius ${c.radius}m  coast band ${c.falloff}m`);
  }
  console.log(`~${land.toFixed(1)} km² of land; world fits in --extent ${Math.ceil((reach + 400) / 100) * 100}`);
  console.log("re-run rivers/towns/roads/pois: the old ones were sited on terrain that no longer exists.");
}

function commandPois(): void {
  const { recipe, file } = loadRecipe();
  const extent = option("extent", 3000);
  const count = option("count", 12);
  const field = createWorldField(recipe);
  const grid = sampleGrid(field, extent, Math.round(option("grid", 200)));

  const candidates: { x: number; z: number; y: number; kind: string; score: number }[] = [];
  for (let iz = 3; iz < grid.n - 3; iz++) {
    for (let ix = 3; ix < grid.n - 3; ix++) {
      const h = grid.at(ix, iz);
      const slope = grid.slope[ix + iz * grid.n]!;
      let higher = 0;
      for (const [dx, dz] of NEIGHBORS) if (grid.at(ix + dx, iz + dz) > h) higher += 1;
      const x = grid.worldX(ix);
      const z = grid.worldZ(iz);
      if (higher === 0 && h > recipe.seaLevel + 60) {
        candidates.push({ x, z, y: h, kind: "peak", score: h });
      } else if (slope > 0.62 && h > recipe.seaLevel + 20) {
        candidates.push({ x, z, y: h, kind: "cliff", score: slope * 40 });
      } else if (Math.abs(h - recipe.seaLevel) < 2 && slope < 0.12) {
        candidates.push({ x, z, y: h, kind: "cove", score: 12 });
      }
    }
  }
  candidates.sort((a, b) => b.score - a.score);

  const pois: PoiDoc[] = [];
  const separation = option("separation", 220);
  for (const candidate of candidates) {
    if (pois.length >= count) break;
    const clear = pois.every(
      (p) => Math.hypot(p.position[0] - candidate.x, p.position[2] - candidate.z) > separation,
    );
    const offTown = recipe.features.towns.every(
      (t) => Math.hypot(t.center[0] - candidate.x, t.center[1] - candidate.z) > t.radius + 40,
    );
    if (!clear || !offTown) continue;
    pois.push({
      id: `${candidate.kind}-${pois.length + 1}`,
      kind: candidate.kind,
      position: [round(candidate.x), round(candidate.y), round(candidate.z)],
      rotationY: 0,
      tags: [],
    });
  }

  recipe.features.pois = pois;
  writeRecipe(recipe, file);
  const byKind = pois.reduce<Record<string, number>>((acc, p) => ({ ...acc, [p.kind]: (acc[p.kind] ?? 0) + 1 }), {});
  console.log(`marked ${pois.length} points of interest:`, byKind);
  console.log("(no `prefab` set yet — give a POI one and it spawns in the cell that contains it)");
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
  const extent = option("extent", 3000);
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
  const extent = option("extent", 3000);
  const count = option("count", 6);
  const grid = sampleGrid(createWorldField(recipe), extent, Math.round(option("grid", 300)));
  const random = mulberry32(recipe.seed ^ 0x0ca0f00d);
  const minStart = option("min-height", recipe.seaLevel + 90);

  // Start high, but not on a summit: a canyon head belongs on a plateau, and
  // a peak start produces a chute down one mountain face instead of a system.
  const candidates: { ix: number; iz: number; h: number; flat: number }[] = [];
  for (let iz = 3; iz < grid.n - 3; iz++) {
    for (let ix = 3; ix < grid.n - 3; ix++) {
      const h = grid.at(ix, iz);
      if (h < minStart) continue;
      const slope = grid.slope[ix + iz * grid.n]!;
      if (slope > 0.36) continue;
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
    fail(`no plateau above ${minStart.toFixed(0)}m to head a canyon — lower --min-height, or raise terrain.mountains.amplitude`);
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
function commandMap(): void {
  const { recipe } = loadRecipe();
  const extent = option("extent", 3000);
  const size = Math.round(option("size", 800));
  // Centre the window somewhere other than the origin. A world-wide map at
  // 7.5 m per pixel cannot show dunes or a mottled blight; --cx/--cz --extent
  // 300 is how you actually check that a zone looks like the place it claims.
  const cx = option("cx", 0);
  const cz = option("cz", 0);
  const field = createWorldField(recipe);
  const step = (extent * 2) / size;
  const pixels = new Uint8Array(size * size * 3);
  const surfaces = recipe.surfaces.map((s) => hexToRgb(s.color));
  // MAX_SURFACES wide, not surfaces.length: splatAt always writes the full
  // palette width, and a short buffer silently drops the writes past its end —
  // then reads back undefined, so every land pixel came out NaN and rendered
  // BLACK the moment the palette grew past four.
  const splat = new Float32Array(MAX_SURFACES);

  for (let py = 0; py < size; py++) {
    const z = cz - extent + py * step;
    for (let px = 0; px < size; px++) {
      const x = cx - extent + px * step;
      const h = field.height(x, z);
      const slope = field.slope(x, z);
      let r: number;
      let g: number;
      let b: number;
      if (h < recipe.seaLevel) {
        // depth-shaded ocean, so the coastline reads
        const depth = Math.min(1, (recipe.seaLevel - h) / 40);
        r = 30 + (1 - depth) * 40;
        g = 70 + (1 - depth) * 60;
        b = 120 + (1 - depth) * 70;
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

  for (const canyon of recipe.features.canyons) {
    stroke(canyon.points, [120, 84, 58], Math.max(1, Math.round(canyon.width / (2 * step))));
  }
  for (const river of recipe.features.rivers) stroke(river.points, [70, 150, 235], 1);
  for (const road of recipe.features.roads) stroke(road.points, [225, 205, 150], 1);
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
    plot(px, py, [255, 235, 90], 2);
  }

  const out = path.join(assetsRoot(), "..", `${recipe.name}-map.png`);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, encodePng(pixels, size, size));
  console.log(`wrote ${path.relative(process.cwd(), out)}  (${size}x${size}, ${extent * 2} world units across)`);
  console.log("  blue = rivers, brown = canyons, tan = roads, red = towns, yellow = POIs, dark grey = monoliths");
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
  const span = Math.max(1, Math.round(option("cells", 9) ** 0.5));
  // A warm-up round, discarded: the first few cells pay JIT compilation for
  // the whole noise stack and read ~50% slow, which would make every reported
  // number a lie about what a running game actually pays.
  for (let cz = 0; cz < span; cz++) {
    for (let cx = 0; cx < span; cx++) {
      buildVoxelMesh(field, { kind: "voxel", world: recipe.name, cell: [cx - 500, cz - 500] });
      scatterCell(field, cx - 500, cz - 500);
    }
  }
  let triangles = 0;
  let vertices = 0;
  let meshMs = 0;
  let props = 0;
  let scatterMs = 0;
  const biomes = new Map<string, number>();
  let cells = 0;

  for (let cz = 0; cz < span; cz++) {
    for (let cx = 0; cx < span; cx++) {
      const t0 = performance.now();
      const mesh = buildVoxelMesh(field, { kind: "voxel", world: recipe.name, cell: [cx, cz] });
      meshMs += performance.now() - t0;
      const t1 = performance.now();
      const instances = scatterCell(field, cx, cz);
      scatterMs += performance.now() - t1;
      triangles += mesh.triangleCount;
      vertices += mesh.vertexCount;
      props += instances.length;
      for (const instance of instances) biomes.set(instance.biome, (biomes.get(instance.biome) ?? 0) + 1);
      cells += 1;
    }
  }

  const voxel = recipe.cellSize / recipe.resolution;
  console.log(`world "${recipe.name}"  seed ${recipe.seed}`);
  console.log(`  cell ${recipe.cellSize}m / ${recipe.resolution} = ${voxel.toFixed(2)}m voxels`);
  console.log(`  vertical band: ${recipe.verticalRange.below}m below .. ${recipe.verticalRange.above}m above ground`);
  console.log(`  ${cells} cells meshed`);
  console.log(`    ${Math.round(triangles / cells)} tris/cell, ${Math.round(vertices / cells)} verts/cell`);
  console.log(`    ${(meshMs / cells).toFixed(1)} ms/cell to mesh, ${(scatterMs / cells).toFixed(1)} ms/cell to scatter`);
  console.log(`    ${(props / cells).toFixed(1)} props/cell`);
  if (biomes.size > 0) console.log(`  biomes hit: ${[...biomes].map(([k, v]) => `${k} ${v}`).join(", ")}`);
  const budget = 16;
  if (meshMs / cells > budget) {
    console.log(
      `\n  WARNING: ${(meshMs / cells).toFixed(1)} ms/cell exceeds a ${budget} ms frame budget — a chunk crossing will hitch.\n` +
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
  case "roads":
    commandRoads();
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
  case "stats":
    commandStats();
    break;
  case "all": {
    if (!findRecipeFile(worldName)) commandInit();
    commandRivers();
    commandCanyons();
    commandTowns();
    commandRoads();
    commandPois();
    commandCaves();
    commandMonoliths();
    commandMap();
    commandStats();
    break;
  }
  default:
    console.log(HELP);
    process.exit(command === "help" ? 0 : 1);
}

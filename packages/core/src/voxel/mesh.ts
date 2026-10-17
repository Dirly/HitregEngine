/**
 * Cell meshing: `{ kind: "voxel", world, cell }` -> real geometry.
 *
 * This is the exact counterpart of `heightmapMesh` in `terrain.ts`, and it is
 * deliberately the same shape: **one function that render, physics and the
 * placement solver all call**, so the mesh you see, the mesh you collide with
 * and the mesh props are snapped onto cannot drift apart.
 *
 * A mesh source stays tiny and legible in JSON — a world id and a cell
 * coordinate — because the recipe is the truth and the geometry is a cache.
 * That cache lives here: a cell is meshed once and shared by all three
 * consumers, which matters because a chunk load asks for the same cell from
 * the renderer and the physics cooker within a frame of each other.
 */

import { marchingCubes, type MarchResult, type SampledBlock } from "./marching-cubes.js";
import { dualContour, type DualContourOptions, type HermiteSource } from "./dual-contouring.js";
import { createWorldField, type SampleBlockExact, type WorldField } from "./field.js";
import { recipeSplatIndexed, worldRecipeSchema, type WorldRecipe } from "./recipe.js";
import { reduceSplatTop4 } from "./splat-top4.js";
import { planarReach } from "./planar-cliffs.js";
import { zoneGroundRoles } from "./zone-ground.js";

/** The `mesh.source` shape for a streamed voxel cell. */
export interface VoxelMeshSource {
  kind: "voxel";
  /** World recipe asset id (assets/worlds/<id>.json, sans extension). */
  world: string;
  /** Chunk cell coordinates. Geometry is emitted LOCAL to the cell origin. */
  cell: [number, number];
  /** Coarsening factor: 1 = full detail, 2 = half the lattice per axis. */
  lodStep?: number;
  /** Explicit vertical band to mesh. Omit and it is derived from the terrain in this cell. */
  yRange?: [number, number];
  /**
   * Which mesher turns the sampled field into triangles. Omit for `"mc"`.
   *
   * `"dc"` and `"nets"` are the EXPERIMENT (`./dual-contouring.ts`) — the same
   * field, contoured dually so a comparison is one field flip on one scene
   * rather than a branch. They are clipped to the cell and skirted
   * (`addInwardSkirts`), and take exact Hermite data from a planar-cliffs world.
   */
  mesher?: VoxelMesherChoice;
}

/**
 * `"mc"` — marching cubes, the shipping mesher.
 * `"dc"` — dual contouring: a QEF vertex per cell, so sharp features survive.
 * `"nets"` — surface nets: the same dual topology with the mass point instead
 * of the QEF, i.e. DC's cheap half, smooth rather than sharp.
 */
export type VoxelMesher = "mc" | "dc" | "nets";
/** A mesher, or `"auto"`: per cell, DC where planar cliffs reach it (plus `planarCliffs.dcMargin`), MC elsewhere. */
export type VoxelMesherChoice = VoxelMesher | "auto";

const autoCache = new WeakMap<WorldField, Map<string, VoxelMesher>>();
/**
 * The mesher one cell is built with. `"auto"` is a pure function of the
 * world and the cell (never of the LOD or the host), so the server, the
 * client, the HLOD bake and every tool choose alike: dual contouring where a
 * planar-cliff mask lies within the cell plus `dcMargin` metres, marching
 * cubes elsewhere. The margin is what keeps every MC/DC border on smooth
 * ground (measured: a border inside the cliff band opens holes; on smooth
 * ground the two meshers meet within a skirt). A world without
 * `terrain.planarCliffs` is MC everywhere.
 */
export function resolveCellMesher(field: WorldField, cx: number, cz: number, choice: VoxelMesherChoice | undefined): VoxelMesher {
  if (choice !== "auto") return choice ?? "mc";
  const pc = field.recipe.terrain.planarCliffs;
  if (!pc) return "mc";
  let cache = autoCache.get(field);
  if (!cache) autoCache.set(field, (cache = new Map()));
  const key = cx + "," + cz;
  let m = cache.get(key);
  if (m === undefined) {
    const S = field.recipe.cellSize, g = pc.dcMargin;
    m = field.planarMaskIn(cx * S - g, cz * S - g, (cx + 1) * S + g, (cz + 1) * S + g) ? "dc" : "mc";
    if (cache.size > 100000) cache.clear();
    cache.set(key, m);
  }
  return m;
}

export interface VoxelMesh {
  positions: Float32Array;
  normals: Float32Array;
  indices: Uint32Array;
  /** Per-vertex splat weights over `recipe.surfaces` (`surfaceCount` per vertex), summing to 1. */
  splat: Float32Array;
  /** Weights per vertex in `splat` — `recipe.surfaces.length`, so the palette can be read off the mesh alone. */
  surfaceCount: number;
  /** Per-vertex vec3 biome tint, multiplied over the blended surface color. */
  tint: Float32Array;
  /**
   * Indexed worlds only (`recipeSplatIndexed`): the four palette ids each
   * vertex blends (`SPLAT_TOP_UNUSED` in an empty slot), consistent across
   * every triangle — see `reduceSplatTop4`. Absent on a dense world.
   */
  layerIndex?: Uint8Array;
  /** Indexed worlds only: the weights of `layerIndex`'s four layers, 0..255. */
  layerWeight?: Uint8Array;
  /** Cell-local AABB. Empty cells report a degenerate box at the origin. */
  min: [number, number, number];
  max: [number, number, number];
  vertexCount: number;
  triangleCount: number;
}

const EMPTY_MESH: VoxelMesh = {
  positions: new Float32Array(0),
  normals: new Float32Array(0),
  indices: new Uint32Array(0),
  splat: new Float32Array(0),
  surfaceCount: 0,
  tint: new Float32Array(0),
  min: [0, 0, 0],
  max: [0, 0, 0],
  vertexCount: 0,
  triangleCount: 0,
};

// ------------------------------------------------------------------ registry
//
// Render, physics and placement receive a mesh SOURCE, not a recipe — the same
// way they receive an `assetId` for a glTF and resolve it through the asset
// library. The host (playground asset loader, worldgen CLI, a test) registers
// worlds once; everything downstream resolves by id.

// A project can hold several recipes (the live world, older versions, test
// fields) while a session streams one. A built field is large, so loaders
// register recipes and the field is built the first time something asks for
// it: building every recipe at load had five unused worlds holding ~200 MB of
// the MMO tab's heap.
interface WorldEntry {
  /** Null until a loader-registered recipe is first needed (registerVoxelRecipeLoader). */
  recipe: WorldRecipe | null;
  load?: () => unknown;
  field: WorldField | null;
  /** Building threw: warned once, and `getVoxelWorld` answers null until re-registered. */
  failed: boolean;
}
const worlds = new Map<string, WorldEntry>();

/** Register/replace a world recipe. Returns the built field. Throws on an invalid recipe. */
export function registerVoxelWorld(id: string, recipe: unknown): WorldField {
  return registerVoxelField(id, worldRecipeSchema.parse(recipe));
}

/** Register an already-parsed recipe (the CLI path, which parses once itself). */
export function registerVoxelField(id: string, recipe: WorldRecipe): WorldField {
  const field = createWorldField(recipe);
  worlds.set(id, { recipe, field, failed: false });
  invalidateVoxelWorld(id);
  return field;
}

/**
 * Register/replace a world recipe WITHOUT building its field; the first
 * `getVoxelWorld` builds it. For loaders that register every recipe in a
 * project. Throws when the recipe does not parse; a field that fails to build
 * warns at first use and resolves to null.
 */
export function registerVoxelRecipe(id: string, recipe: unknown): WorldRecipe {
  const parsed = worldRecipeSchema.parse(recipe);
  worlds.set(id, { recipe: parsed, field: null, failed: false });
  invalidateVoxelWorld(id);
  return parsed;
}

/**
 * Register a world by how to READ its recipe, not the recipe: nothing is read
 * or parsed until something asks for the world (`getVoxelWorld`,
 * `getVoxelRecipe`). A dedicated server sees every project's recipes (tens of
 * MB of JSON) and streams one; parsing them all held ~100 MB it never used.
 * A recipe that fails to read or parse warns at first use and resolves to null.
 */
export function registerVoxelRecipeLoader(id: string, load: () => unknown): void {
  worlds.set(id, { recipe: null, load, field: null, failed: false });
  invalidateVoxelWorld(id);
}

/** A registered world's recipe (parsed now if it was registered by loader), or null. */
export function getVoxelRecipe(id: string): WorldRecipe | null {
  const entry = worlds.get(id);
  if (!entry || entry.failed) return null;
  if (!entry.recipe && entry.load) {
    try {
      entry.recipe = worldRecipeSchema.parse(entry.load());
      entry.load = undefined;
    } catch (error) {
      entry.failed = true;
      console.warn(`[voxel] world recipe "${id}" failed to load:`, error);
      return null;
    }
  }
  return entry.recipe;
}

export function getVoxelWorld(id: string): WorldField | null {
  const entry = worlds.get(id);
  if (!entry || entry.failed) return null;
  if (!entry.field) {
    const recipe = getVoxelRecipe(id);
    if (!recipe) return null;
    try {
      entry.field = createWorldField(recipe);
    } catch (error) {
      entry.failed = true;
      console.warn(`[voxel] world recipe "${id}" failed to build:`, error);
      return null;
    }
  }
  return entry.field;
}

/**
 * Whether anything has asked for this world's field (built, or tried and
 * failed). A recipe edit to a world nobody uses has nothing to re-stream.
 */
export function isVoxelWorldInUse(id: string): boolean {
  const entry = worlds.get(id);
  return !!entry && (entry.field !== null || entry.failed);
}

export function voxelWorldIds(): string[] {
  return [...worlds.keys()];
}

export function clearVoxelWorlds(): void {
  worlds.clear();
  meshCache.clear();
  meshCacheBytes = 0;
}

// --------------------------------------------------------------- mesh cache

/**
 * Cache budget in BYTES, not entries.
 *
 * Entry counting was wrong in a way that only showed up under load: a full
 * cell is ~110 KB and an HLOD-coarsened one ~25 KB, so a fixed count budgets
 * wildly different amounts of memory depending on which mix you happen to
 * hold. With ~650 cells resident across the rings, a 512-entry cap sat just
 * under what the world actually needed and evicted cells that were about to
 * be asked for again — so every HLOD supercell re-bake re-meshed from scratch
 * instead of hitting the cache, which is what turned a rebake into hundreds
 * of milliseconds.
 *
 * Note this bounds re-meshing work, not live memory: a cached mesh whose
 * arrays are already inside a live BufferGeometry is not freed by eviction.
 */
const MESH_CACHE_BYTES = 128 * 1024 * 1024;
const meshCache = new Map<string, VoxelMesh>();
let meshCacheBytes = 0;

function meshBytes(mesh: VoxelMesh): number {
  return (
    mesh.positions.byteLength +
    mesh.normals.byteLength +
    mesh.indices.byteLength +
    mesh.splat.byteLength +
    mesh.tint.byteLength +
    (mesh.layerIndex?.byteLength ?? 0) +
    (mesh.layerWeight?.byteLength ?? 0)
  );
}

function cacheKey(source: VoxelMeshSource): string {
  const y = source.yRange ? `:${source.yRange[0]},${source.yRange[1]}` : "";
  const m = source.mesher && source.mesher !== "mc" ? `:${source.mesher}` : "";
  return `${source.world}:${source.cell[0]}_${source.cell[1]}:${source.lodStep ?? 1}${y}${m}`;
}

function dropCached(key: string): void {
  const mesh = meshCache.get(key);
  if (!mesh) return;
  meshCacheBytes -= meshBytes(mesh);
  meshCache.delete(key);
}

/** Drop every cached cell of a world — call when its recipe file changes. */
export function invalidateVoxelWorld(id: string): void {
  const prefix = `${id}:`;
  for (const key of [...meshCache.keys()]) {
    if (key.startsWith(prefix)) dropCached(key);
  }
}

/**
 * Drop only the named cells of a world — what a TARGETED edit wants.
 *
 * `invalidateVoxelWorld` is right for a recipe file changing wholesale (the
 * dev watcher: anything may have moved). It is far too blunt for one carved
 * blob, which would re-mesh every resident cell to reveal a 20m crater. Pair
 * this with `cellsForEdits` from `terraform.ts`, which reports exactly the
 * cells an edit batch reached — blend margins included.
 *
 * Every LOD step and Y-section of a named cell is dropped, since the cache
 * holds a cell at several detail levels and all of them are equally stale.
 */
export function invalidateVoxelCells(id: string, cells: readonly (readonly [number, number])[]): void {
  for (const [cx, cz] of cells) {
    const prefix = `${id}:${cx}_${cz}:`;
    for (const key of [...meshCache.keys()]) {
      if (key.startsWith(prefix)) dropCached(key);
    }
  }
}

export function voxelMeshCacheStats(): { entries: number; bytes: number; budget: number } {
  return { entries: meshCache.size, bytes: meshCacheBytes, budget: MESH_CACHE_BYTES };
}

// ---------------------------------------------------------------- the mesher

/**
 * Mesh one cell of a registered world. Returns an empty mesh for an unknown
 * world or a cell with no surface in it (sky, or solid interior) — callers
 * treat that as "nothing to draw", never as an error.
 */
export function voxelMesh(source: VoxelMeshSource): VoxelMesh {
  const key = cacheKey(source);
  const hit = meshCache.get(key);
  if (hit) {
    // refresh recency (Map preserves insertion order, so re-insert to move to the end)
    meshCache.delete(key);
    meshCache.set(key, hit);
    return hit;
  }
  const field = getVoxelWorld(source.world);
  if (!field) return EMPTY_MESH;
  const mesh = buildVoxelMesh(field, source);
  meshCache.set(key, mesh);
  meshCacheBytes += meshBytes(mesh);
  while (meshCacheBytes > MESH_CACHE_BYTES && meshCache.size > 1) {
    const oldest = meshCache.keys().next().value;
    if (oldest === undefined) break;
    dropCached(oldest);
  }
  return mesh;
}

/**
 * The cached mesh for a source, or null — never builds one and does not
 * refresh recency. For main-thread readers (ground cover) that must not mesh
 * a cell themselves but can use one the streamer already holds.
 */
export function cachedVoxelMesh(source: VoxelMeshSource): VoxelMesh | null {
  return meshCache.get(cacheKey(source)) ?? null;
}

/**
 * Hand the cache a mesh built ELSEWHERE — a worker thread that ran
 * `buildVoxelMesh` against its own copy of the field. The next `voxelMesh`
 * for the same source is then a hit, so render, physics and placement keep
 * sharing one geometry while the marching happened off the calling thread.
 * A mesh for an unregistered world is ignored (it would never be asked for).
 */
export function primeVoxelMesh(source: VoxelMeshSource, mesh: VoxelMesh): void {
  if (!worlds.has(source.world)) return;
  const key = cacheKey(source);
  dropCached(key);
  meshCache.set(key, mesh);
  meshCacheBytes += meshBytes(mesh);
  while (meshCacheBytes > MESH_CACHE_BYTES && meshCache.size > 1) {
    const oldest = meshCache.keys().next().value;
    if (oldest === undefined) break;
    dropCached(oldest);
  }
}

/** Mesh a cell against an explicit field, bypassing the registry and the cache. */
export function buildVoxelMesh(field: WorldField, source: VoxelMeshSource): VoxelMesh {
  const recipe = field.recipe;
  const surfaceCount = field.surfaceCount;
  const [cx, cz] = source.cell;
  const lodStep = Math.max(1, Math.floor(source.lodStep ?? 1));
  const step = field.voxelSize * lodStep;
  const cells = Math.max(1, Math.round(recipe.resolution / lodStep));
  const x0 = cx * recipe.cellSize;
  const z0 = cz * recipe.cellSize;

  // One padding sample on every side: marching cubes needs it for
  // central-difference normals, and it is what makes normals match ACROSS a
  // chunk seam without the two chunks ever exchanging geometry. The dual
  // meshers need TWO, because a dual face spans four cells and so reaches one
  // cell into the neighbour — and that cell's own vertex has to be solved from
  // true central differences, or the two chunks place it differently.
  const mesher = resolveCellMesher(field, cx, cz, source.mesher);
  const pad = mesher === "mc" ? 1 : 2;
  const { yMin, cellsY, cut } = verticalBand(field, source, x0, z0, step, pad, cells + 2 * pad + 1);
  if (cellsY < 1) return EMPTY_MESH;
  const nx = cells + 2 * pad + 1;
  const ny = cellsY + 2 * pad + 1;
  const nz = cells + 2 * pad + 1;
  const origin: [number, number, number] = [x0 - pad * step, yMin - pad * step, z0 - pad * step];

  // A world with `terrain.planarCliffs` hands the dual meshers exact Hermite
  // data for its cliff band (crossings + gradients of the planar field), gated
  // per sample; anything the band cut or the seal then rewrites drops out of it.
  const exact: SampleBlockExact = {};
  const values = field.sampleBlock({ origin, nx, ny, nz, step }, mesher !== "mc" ? exact : undefined);
  const before = exact.active ? values.slice() : null;
  if (cut) applyBandCut(values, nx, ny, nz, origin, step, cut);
  sealVertically(values, nx, ny, nz);
  if (before && exact.active) for (let i = 0; i < values.length; i++) if (values[i] !== before[i]) exact.active[i] = 0;
  const hermite: HermiteSource | undefined = exact.hermite;

  const contour: (block: SampledBlock, options: DualContourOptions) => MarchResult =
    mesher === "mc" ? marchingCubes : dualContour;
  const block = { values, nx, ny, nz, origin, step };
  const result: MarchResult = (mesher === "mc" ? flatCellMesh(field, block) : null) ?? contour(
    block,
    {
      ...(mesher === "mc"
        ? {}
        : {
            pad,
            sharpness: mesher === "nets" ? 0 : 1,
            // End the dual mesh ON the cell's planes, like an MC cell, so the
            // same skirts close an LOD step (see clipToColumn).
            ...(dualMeshExperiment.seams === "clip" ? { clip: { x: [x0, x0 + recipe.cellSize] as const, z: [z0, z0 + recipe.cellSize] as const } } : {}),
            ...(mesher === "dc" ? { creaseAngle: dualMeshExperiment.crease } : {}),
            ...(hermite ? { hermite, hermiteSteps: dualMeshExperiment.hermiteSteps, hermiteGate: dualMeshExperiment.hermiteGate } : {}),
          }),
      // ONE interleaved stream, split below. Splat weights and biome tint come
      // from the SAME biome evaluation, so asking for them as two attributes
      // resolved the climate noise and every rule's membership twice per
      // vertex for nothing.
      attributes: {
        surface: {
          size: surfaceCount + 3,
          compute: (x, y, z, _nx, ny2, _nz, out, offset) => field.surfaceAt(x, y, z, ny2, out, offset),
        },
      },
    },
  );
  if (result.triangleCount === 0) return EMPTY_MESH;

  const interleaved = result.attributes["surface"];
  const stride = surfaceCount + 3;
  const splat = new Float32Array(result.vertexCount * surfaceCount);
  const tint = new Float32Array(result.vertexCount * 3);
  if (interleaved) {
    for (let i = 0; i < result.vertexCount; i++) {
      for (let s2 = 0; s2 < surfaceCount; s2++) splat[i * surfaceCount + s2] = interleaved[i * stride + s2]!;
      tint[i * 3] = interleaved[i * stride + surfaceCount]!;
      tint[i * 3 + 1] = interleaved[i * stride + surfaceCount + 1]!;
      tint[i * 3 + 2] = interleaved[i * stride + surfaceCount + 2]!;
    }
  }

  // world -> cell-local: the chunk root already sits at [cx*cellSize, 0, cz*cellSize]
  // Skirts hang from every boundary edge, so a neighbour meshed at a
  // different lattice step (the HLOD ring) cannot open a crack at the join.
  //
  // `addSkirts` finds the boundary by testing which vertices lie exactly on
  // the cell plane — true of an MC vertex (it sits on a lattice edge), never of
  // a dual one (it sits in a cell interior). So the dual meshers are CLIPPED to
  // the cell's column (`dualMeshExperiment.seams`), which puts their border on the plane too,
  // and then take the same skirts. Unclipped ("own"), equal-LOD dual
  // neighbours still agree exactly but an LOD step cracks.
  const skirted =
    mesher === "mc"
      ? addSkirts(result, splat, tint, surfaceCount, x0, z0, recipe.cellSize, step * SKIRT_STEPS, block)
      : dualMeshExperiment.seams === "clip"
      ? addInwardSkirts(result, splat, tint, surfaceCount, x0, z0, recipe.cellSize, Math.max(step * SKIRT_STEPS, dualMeshExperiment.skirtMin), block)
      : { ...result, splat, tint };
  const positions = skirted.positions;
  let minX = Infinity;
  let minY2 = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxY2 = -Infinity;
  let maxZ = -Infinity;
  for (let i = 0; i < positions.length; i += 3) {
    const px = positions[i]! - x0;
    const py = positions[i + 1]!;
    const pz = positions[i + 2]! - z0;
    positions[i] = px;
    positions[i + 2] = pz;
    if (px < minX) minX = px;
    if (px > maxX) maxX = px;
    if (py < minY2) minY2 = py;
    if (py > maxY2) maxY2 = py;
    if (pz < minZ) minZ = pz;
    if (pz > maxZ) maxZ = pz;
  }

  const mesh: VoxelMesh = {
    positions,
    normals: skirted.normals,
    indices: skirted.indices,
    splat: skirted.splat,
    surfaceCount,
    tint: skirted.tint,
    min: [minX, minY2, minZ],
    max: [maxX, maxY2, maxZ],
    vertexCount: skirted.vertexCount,
    triangleCount: skirted.triangleCount,
  };
  return recipeSplatIndexed(recipe) ? reduceSplatTop4(mesh, { roleGroup: roleGroupsOf(recipe) }) : mesh;
}

const roleGroupCache = new WeakMap<object, Int8Array>();
/** Role group per palette surface (base role or the role it overrides), for `reduceSplatTop4`. */
function roleGroupsOf(recipe: WorldRecipe): Int8Array {
  let groups = roleGroupCache.get(recipe);
  if (!groups) {
    const roles = zoneGroundRoles(recipe);
    groups = new Int8Array(recipe.surfaces.length);
    for (let s = 0; s < groups.length; s++) groups[s] = roles.baseRole[s]! >= 0 ? roles.baseRole[s]! : roles.overrideRole[s]!;
    roleGroupCache.set(recipe, groups);
  }
  return groups;
}

/**
 * Collapse a sampled, horizontal, uniformly painted cell to a planar interior.
 * This is a lossless shortcut over the SAME samples MC would consume, not an
 * ocean-depth heuristic: every padded column must have the same density profile,
 * with one upward crossing, and every original surface vertex the same attributes.
 * Keep the entire boundary lattice so ordinary neighbouring cells still weld.
 * A cave, slope, edit, paint variation or uncertain value falls back to MC.
 */
function flatCellMesh(field: WorldField, block: SampledBlock): MarchResult | null {
  const { values, nx, ny, nz, origin, step } = block;
  const cellsX = nx - 3, cellsZ = nz - 3;
  if (cellsX < 3 || cellsZ < 3) return null; // no useful reduction on tiny LOD grids
  let crossing = -1;
  for (let j = 1; j < ny - 2; j++) {
    const a = values[j * nx]!, b = values[(j + 1) * nx]!;
    if ((a < 0) === (b < 0)) continue;
    if (a >= 0 || crossing !== -1) return null;
    crossing = j;
  }
  if (crossing === -1) return null;
  for (let k = 0; k < nz; k++) {
    for (let j = 0; j < ny; j++) {
      const expected = values[j * nx]!;
      if (!Number.isFinite(expected)) return null;
      const row = (k * ny + j) * nx;
      for (let i = 0; i < nx; i++) if (values[row + i] !== expected) return null;
    }
  }
  const a = values[crossing * nx]!, b = values[(crossing + 1) * nx]!;
  const t = Math.abs(b - a) < 1e-12 ? 0.5 : -a / (b - a);
  const y = origin[1] + (crossing + t) * step;
  const stride = field.surfaceCount + 3;
  const surface = new Float32Array(stride), scratch = new Float32Array(stride);
  field.surfaceAt(origin[0] + step, y, origin[2] + step, 1, surface, 0);
  for (let k = 1; k <= cellsZ + 1; k++) {
    for (let i = 1; i <= cellsX + 1; i++) {
      field.surfaceAt(origin[0] + i * step, y, origin[2] + k * step, 1, scratch, 0);
      for (let s = 0; s < stride; s++) if (!Number.isFinite(surface[s]) || scratch[s] !== surface[s]) return null;
    }
  }
  const perimeter = 2 * (cellsX + cellsZ), vertexCount = perimeter + 1;
  const positions = new Float32Array(vertexCount * 3), normals = new Float32Array(vertexCount * 3);
  const attributes = new Float32Array(vertexCount * stride), indices = new Uint32Array(perimeter * 3);
  let vertex = 0;
  const put = (i: number, k: number): void => {
    positions.set([origin[0] + i * step, y, origin[2] + k * step], vertex * 3);
    normals[vertex * 3 + 1] = 1;
    attributes.set(surface, vertex * stride);
    vertex++;
  };
  put(1 + cellsX / 2, 1 + cellsZ / 2);
  for (let i = 1; i <= cellsX; i++) put(i, 1);
  for (let k = 1; k <= cellsZ; k++) put(cellsX + 1, k);
  for (let i = cellsX + 1; i > 1; i--) put(i, cellsZ + 1);
  for (let k = cellsZ + 1; k > 1; k--) put(1, k);
  for (let i = 0; i < perimeter; i++) indices.set([0, 1 + (i + 1) % perimeter, 1 + i], i * 3);
  return { positions, normals, indices, attributes: { surface: attributes }, vertexCount, triangleCount: perimeter };
}

/**
 * EXPERIMENT switches for the dual meshers, mutable so a measuring tool can
 * A/B them (`tools/voxel-seams.mts`); the shipping MC path never reads them.
 * - `seams`: "clip" ends each dual cell on its column planes and skirts it
 *   like MC, so an LOD step closes; "own" is the original face-ownership rule
 *   (no skirts — equal-LOD seams exact, LOD steps crack).
 * - `crease`: radians; `"dc"` splits a vertex's normal where its cell's
 *   crossing normals spread wider (0 = one averaged normal). 0.6 = 34 deg.
 * - `skirtMin`: metres; the dual meshers' skirts hang at least this far (0 = SKIRT_STEPS lattice steps). Measured
 *   on terrace cliffs at the 1:4 HLOD join: 0, 12, 16 and 24 m leak alike — the leaks there were the FIELD moving
 *   with the lattice (fixed in sampleBlock: coarse blocks read the full-detail planar function), not skirt depth.
 * Meshes are cached by source, so flip these before meshing, not between.
 */
export const dualMeshExperiment: { seams: "clip" | "own"; crease: number; hermiteSteps: number; hermiteGate: number; skirtMin: number } = { seams: "clip", crease: 0.6, hermiteSteps: 3, hermiteGate: -2, skirtMin: 0 };

/** Skirt depth in lattice steps: a full-detail cell drops 6 m, an HLOD cell (4x lattice) 24 m. */
const SKIRT_STEPS = 3;

interface SkirtInput {
  positions: Float32Array;
  normals: Float32Array;
  indices: Uint32Array;
  vertexCount: number;
  triangleCount: number;
}

/**
 * Skirts: a vertical strip hung from every mesh edge that lies on one of the
 * cell's four side planes.
 *
 * Two cells meshed at the SAME step weld exactly (§4), but the HLOD ring is
 * meshed at a coarser lattice, and a coarse surface crosses the shared plane
 * at different heights than the fine one — a crack you can see the sky
 * through wherever the coarse side is lower. A strip hanging `depth` down
 * from each cell's own boundary edge covers the gap from whichever side is
 * higher; the other cell's strip is buried in rock. Both sides emit them
 * unconditionally because a cell does not know its neighbour's step.
 *
 * Marching cubes puts every vertex on a lattice edge, so a triangle crossing
 * a boundary cube face has exactly one edge in the plane: the boundary edges
 * are found by looking for triangle edges whose endpoints both sit on a
 * plane, no adjacency structure needed. Skirt vertices copy the edge vertex's
 * normal, splat and tint, so the strip shades as a continuation of the
 * surface rather than as a wall.
 *
 * The skirt is part of the one shared mesh (render, physics, placement), so
 * it must be entirely inside rock: an underside edge (normal pointing down)
 * extrudes UP, everything else down, and each skirt vertex travels at most
 * as far as the sampled lattice says the rock continues on that boundary
 * column (a quarter step short of the first air crossing). Where there is
 * less rock than `depth` the strip is shorter; where there is none it is
 * omitted. `auditVoxelMesh` (mesh-audit.ts) is the check.
 */
function addSkirts(
  mesh: SkirtInput,
  splat: Float32Array,
  tint: Float32Array,
  surfaceCount: number,
  x0: number,
  z0: number,
  cellSize: number,
  depth: number,
  block: SampledBlock,
): SkirtInput & { splat: Float32Array; tint: Float32Array } {
  const { positions, normals, indices, vertexCount, triangleCount } = mesh;
  const eps = 1e-4;
  const planes: { axis: 0 | 2; at: number; outward: number }[] = [
    { axis: 0, at: x0, outward: -1 },
    { axis: 0, at: x0 + cellSize, outward: 1 },
    { axis: 2, at: z0, outward: -1 },
    { axis: 2, at: z0 + cellSize, outward: 1 },
  ];
  const on = (v: number, plane: (typeof planes)[number]): boolean => Math.abs(positions[v * 3 + plane.axis]! - plane.at) < eps;
  /** [a, b, planeIndex] per boundary edge. */
  const edges: number[] = [];
  for (let t = 0; t < triangleCount; t++) {
    const i0 = indices[t * 3]!;
    const i1 = indices[t * 3 + 1]!;
    const i2 = indices[t * 3 + 2]!;
    for (let p = 0; p < planes.length; p++) {
      const plane = planes[p]!;
      const a = on(i0, plane);
      const b = on(i1, plane);
      const c = on(i2, plane);
      const before = edges.length;
      if (a && b && !c) edges.push(i0, i1, p);
      else if (b && c && !a) edges.push(i1, i2, p);
      else if (c && a && !b) edges.push(i2, i0, p);
      // A downward skirt from an underside (cave ceiling, passage roof,
      // overhang) hangs through playable air. Extrude undersides UP into
      // their backing rock instead. Encode that direction in the plane
      // index; winding uses the signed drop.
      if (edges.length > before) {
        const ea = edges[edges.length - 3]!, eb = edges[edges.length - 2]!;
        if (normals[ea * 3 + 1]! + normals[eb * 3 + 1]! < -1e-4) edges[edges.length - 1]! += planes.length;
      }
    }
  }
  const count = edges.length / 3;
  if (count === 0) return { ...mesh, splat, tint };

  // How far a skirt vertex may travel and stay INSIDE rock. A fixed `depth`
  // was the zone-5/Gnawspur blade: a passage roof with 3 m of cover under a
  // 6 m upward skirt (or a knife ridge / carved overhang under a 6 m
  // downward one) pushed the flap out through the far side of the rock as a
  // pale sliver — rendered, collided and prop-snapped, since it is the one
  // shared mesh. The run is read from the SAME sampled lattice the surface
  // came from, on the cell's own boundary plane (so both neighbours see the
  // same column), and stops a quarter step short of the first air crossing.
  const { values, nx, ny, origin, step } = block;
  const strideZ = nx * ny;
  const sample = (x: number, y: number, z: number): number => {
    const fx = Math.min(nx - 1.0001, Math.max(0, (x - origin[0]) / step));
    const fy = (y - origin[1]) / step;
    const fz = Math.min(block.nz - 1.0001, Math.max(0, (z - origin[2]) / step));
    if (fy <= 0) return -1; // below the band: rock (sealVertically)
    if (fy >= ny - 1) return 1; // above the band: sky
    const i = Math.floor(fx), j = Math.floor(fy), k = Math.floor(fz);
    const tx = fx - i, ty = fy - j, tz = fz - k;
    const at = (di: number, dj: number, dk: number): number => values[i + di + (j + dj) * nx + (k + dk) * strideZ]!;
    const lerp = (p: number, q: number, t: number): number => p + (q - p) * t;
    const x00 = lerp(at(0, 0, 0), at(1, 0, 0), tx), x10 = lerp(at(0, 1, 0), at(1, 1, 0), tx);
    const x01 = lerp(at(0, 0, 1), at(1, 0, 1), tx), x11 = lerp(at(0, 1, 1), at(1, 1, 1), tx);
    return lerp(lerp(x00, x10, ty), lerp(x01, x11, ty), tz);
  };
  const probe = step / 4;
  const buriedRun = (v: number, dir: number): number => {
    const x = positions[v * 3]!, y = positions[v * 3 + 1]!, z = positions[v * 3 + 2]!;
    let prevT = 0;
    let prevD = 0;
    for (let t = probe; t <= depth + 1e-6; t += probe) {
      const d = sample(x, y + dir * t, z);
      if (d >= 0) {
        // linear crossing between the last rock sample and this air one
        const cross = prevD < 0 ? prevT + (t - prevT) * (prevD / (prevD - d)) : prevT;
        const run = cross - probe;
        return run > probe * 0.5 ? run : 0;
      }
      prevT = t;
      prevD = d;
    }
    return depth;
  };

  const outPositions = new Float32Array((vertexCount + count * 2) * 3);
  const outNormals = new Float32Array((vertexCount + count * 2) * 3);
  const outSplat = new Float32Array((vertexCount + count * 2) * surfaceCount);
  const outTint = new Float32Array((vertexCount + count * 2) * 3);
  const outIndices = new Uint32Array((triangleCount + count * 2) * 3);
  outPositions.set(positions);
  outNormals.set(normals);
  outSplat.set(splat);
  outTint.set(tint);
  outIndices.set(indices);

  let v = vertexCount;
  let tri = triangleCount;
  const copyVertex = (from: number, to: number, drop: number): void => {
    outPositions[to * 3] = positions[from * 3]!;
    outPositions[to * 3 + 1] = positions[from * 3 + 1]! - drop;
    outPositions[to * 3 + 2] = positions[from * 3 + 2]!;
    outNormals[to * 3] = normals[from * 3]!;
    outNormals[to * 3 + 1] = normals[from * 3 + 1]!;
    outNormals[to * 3 + 2] = normals[from * 3 + 2]!;
    for (let k = 0; k < surfaceCount; k++) outSplat[to * surfaceCount + k] = splat[from * surfaceCount + k]!;
    outTint[to * 3] = tint[from * 3]!;
    outTint[to * 3 + 1] = tint[from * 3 + 1]!;
    outTint[to * 3 + 2] = tint[from * 3 + 2]!;
  };
  // A boundary vertex is shared by two boundary edges; measure each once.
  const runs = new Map<number, number>();
  const runOf = (vertex: number, dir: number): number => {
    const key = dir > 0 ? -1 - vertex : vertex;
    let run = runs.get(key);
    if (run === undefined) {
      run = buriedRun(vertex, dir);
      runs.set(key, run);
    }
    return run;
  };
  for (let e = 0; e < count; e++) {
    const a = edges[e * 3]!;
    const b = edges[e * 3 + 1]!;
    const encodedPlane = edges[e * 3 + 2]!;
    const plane = planes[encodedPlane % planes.length]!;
    const up = encodedPlane >= planes.length;
    const runA = runOf(a, up ? 1 : -1);
    const runB = runOf(b, up ? 1 : -1);
    // No rock to hide in on either end (a sliver of rock thinner than half a
    // probe): no skirt. A crack at an LOD seam is better than a blade.
    if (runA <= 0 && runB <= 0) continue;
    const drop = up ? -depth : depth;
    // one zero end: the strip degenerates to a single triangle
    const a2 = runA > 0 ? v++ : a;
    const b2 = runB > 0 ? v++ : b;
    if (a2 !== a) copyVertex(a, a2, up ? -runA : runA);
    if (b2 !== b) copyVertex(b, b2, up ? -runB : runB);
    // wind so the strip faces OUT of the cell: (b - a) x (b2 - a) along the plane normal
    const abx = positions[b * 3]! - positions[a * 3]!;
    const abz = positions[b * 3 + 2]! - positions[a * 3 + 2]!;
    // (ab) x (0, -depth, 0): x = abz * depth ... only the plane-axis component matters
    const nx = -abz * -drop;
    const nz = abx * -drop;
    const facing = plane.axis === 0 ? nx * plane.outward : nz * plane.outward;
    const pair = facing >= 0 ? [a, b, b2, a, b2, a2] : [a, b2, b, a, a2, b2];
    for (let q = 0; q < 6; q += 3) {
      const p0 = pair[q]!, p1 = pair[q + 1]!, p2 = pair[q + 2]!;
      if (p0 === p1 || p1 === p2 || p2 === p0) continue; // the collapsed half of a one-ended strip
      outIndices[tri * 3] = p0;
      outIndices[tri * 3 + 1] = p1;
      outIndices[tri * 3 + 2] = p2;
      tri++;
    }
  }
  // Clamped strips can be shorter or missing; trim the reserved tail so the
  // one shared mesh carries no zero-area padding triangles or orphan vertices.
  return {
    positions: v === vertexCount + count * 2 ? outPositions : outPositions.slice(0, v * 3),
    normals: v === vertexCount + count * 2 ? outNormals : outNormals.slice(0, v * 3),
    indices: tri === triangleCount + count * 2 ? outIndices : outIndices.slice(0, tri * 3),
    splat: v === vertexCount + count * 2 ? outSplat : outSplat.slice(0, v * surfaceCount),
    tint: v === vertexCount + count * 2 ? outTint : outTint.slice(0, v * 3),
    vertexCount: v,
    triangleCount: tri,
  };
}

/**
 * Skirts for the CLIPPED dual meshers: the same strip from every boundary edge
 * on a side plane, but extruded INTO THE ROCK along the surface's inward normal
 * projected into that plane, instead of straight down (or up).
 *
 * Down/up is right for ground and for undersides, and wrong for a vertical
 * face: there the two LOD levels' borders are offset SIDEWAYS in the plane, a
 * downward strip hung from a vertical border has no area, and the slot between
 * the faces stays open. DC keeps faces vertical (that is the point of it), so
 * its skirts follow the face: a floor's skirt still hangs down, an underside's
 * still rises, a wall's goes back into the wall. Same rock-run clamp as
 * {@link addSkirts}, measured along the new direction.
 */
function addInwardSkirts(
  mesh: SkirtInput,
  splat: Float32Array,
  tint: Float32Array,
  surfaceCount: number,
  x0: number,
  z0: number,
  cellSize: number,
  depth: number,
  block: SampledBlock,
): SkirtInput & { splat: Float32Array; tint: Float32Array } {
  const { positions, normals, indices, vertexCount, triangleCount } = mesh;
  const eps = 1e-4;
  const planes: { axis: 0 | 2; at: number; outward: number }[] = [
    { axis: 0, at: x0, outward: -1 },
    { axis: 0, at: x0 + cellSize, outward: 1 },
    { axis: 2, at: z0, outward: -1 },
    { axis: 2, at: z0 + cellSize, outward: 1 },
  ];
  const on = (v: number, plane: (typeof planes)[number]): boolean => Math.abs(positions[v * 3 + plane.axis]! - plane.at) < eps;
  const edges: number[] = [];
  for (let t = 0; t < triangleCount; t++) {
    const i0 = indices[t * 3]!, i1 = indices[t * 3 + 1]!, i2 = indices[t * 3 + 2]!;
    for (let p = 0; p < planes.length; p++) {
      const plane = planes[p]!;
      const a = on(i0, plane), b = on(i1, plane), c = on(i2, plane);
      if (a && b && !c) edges.push(i0, i1, p);
      else if (b && c && !a) edges.push(i1, i2, p);
      else if (c && a && !b) edges.push(i2, i0, p);
    }
  }
  const count = edges.length / 3;
  if (count === 0) return { ...mesh, splat, tint };
  const { values, nx, ny, origin, step } = block;
  const strideZ = nx * ny;
  const sample = (x: number, y: number, z: number): number => {
    const fx = Math.min(nx - 1.0001, Math.max(0, (x - origin[0]) / step));
    const fy = (y - origin[1]) / step;
    const fz = Math.min(block.nz - 1.0001, Math.max(0, (z - origin[2]) / step));
    if (fy <= 0) return -1;
    if (fy >= ny - 1) return 1;
    const i = Math.floor(fx), j = Math.floor(fy), k = Math.floor(fz);
    const tx = fx - i, ty = fy - j, tz = fz - k;
    const at = (di: number, dj: number, dk: number): number => values[i + di + (j + dj) * nx + (k + dk) * strideZ]!;
    const lerp = (p: number, q: number, t: number): number => p + (q - p) * t;
    const x00 = lerp(at(0, 0, 0), at(1, 0, 0), tx), x10 = lerp(at(0, 1, 0), at(1, 1, 0), tx);
    const x01 = lerp(at(0, 0, 1), at(1, 0, 1), tx), x11 = lerp(at(0, 1, 1), at(1, 1, 1), tx);
    return lerp(lerp(x00, x10, ty), lerp(x01, x11, ty), tz);
  };
  const probe = step / 4;
  /** Per (vertex, plane): unit in-plane inward direction and how far it stays in rock along it. */
  const runs = new Map<number, [number, number, number, number]>();
  const runOf = (v: number, p: number): [number, number, number, number] => {
    const key = v * 4 + p;
    let r = runs.get(key);
    if (r) return r;
    const plane = planes[p]!;
    // inward = -normal with the plane-axis component removed
    let dx = -normals[v * 3]!, dy = -normals[v * 3 + 1]!, dz = -normals[v * 3 + 2]!;
    if (plane.axis === 0) dx = 0;
    else dz = 0;
    const l = Math.hypot(dx, dy, dz);
    if (l < 0.2) {
      dx = 0;
      dy = -1;
      dz = 0;
    } else {
      dx /= l;
      dy /= l;
      dz /= l;
    }
    const x = positions[v * 3]!, y = positions[v * 3 + 1]!, z = positions[v * 3 + 2]!;
    let run = depth, prevT = 0, prevD = 0;
    for (let t = probe; t <= depth + 1e-6; t += probe) {
      const d = sample(x + dx * t, y + dy * t, z + dz * t);
      if (d >= 0) {
        const cross = prevD < 0 ? prevT + (t - prevT) * (prevD / (prevD - d)) : prevT;
        run = cross - probe > probe * 0.5 ? cross - probe : 0;
        break;
      }
      prevT = t;
      prevD = d;
    }
    r = [dx, dy, dz, run];
    runs.set(key, r);
    return r;
  };
  const outPositions = new Float32Array((vertexCount + count * 2) * 3);
  const outNormals = new Float32Array((vertexCount + count * 2) * 3);
  const outSplat = new Float32Array((vertexCount + count * 2) * surfaceCount);
  const outTint = new Float32Array((vertexCount + count * 2) * 3);
  const outIndices = new Uint32Array((triangleCount + count * 2) * 3);
  outPositions.set(positions);
  outNormals.set(normals);
  outSplat.set(splat);
  outTint.set(tint);
  outIndices.set(indices);
  let v = vertexCount, tri = triangleCount;
  // one skirt vertex per (boundary vertex, plane), shared by the two strips that meet at it
  const skirtVertex = new Map<number, number>();
  const extruded = (from: number, p: number): number => {
    const [dx, dy, dz, run] = runOf(from, p);
    if (run <= 0) return from;
    const key = from * 4 + p;
    const hit = skirtVertex.get(key);
    if (hit !== undefined) return hit;
    const to = v++;
    outPositions[to * 3] = positions[from * 3]! + dx * run;
    outPositions[to * 3 + 1] = positions[from * 3 + 1]! + dy * run;
    outPositions[to * 3 + 2] = positions[from * 3 + 2]! + dz * run;
    for (let k = 0; k < 3; k++) outNormals[to * 3 + k] = normals[from * 3 + k]!;
    for (let k = 0; k < surfaceCount; k++) outSplat[to * surfaceCount + k] = splat[from * surfaceCount + k]!;
    for (let k = 0; k < 3; k++) outTint[to * 3 + k] = tint[from * 3 + k]!;
    skirtVertex.set(key, to);
    return to;
  };
  const P = (i: number): [number, number, number] => [outPositions[i * 3]!, outPositions[i * 3 + 1]!, outPositions[i * 3 + 2]!];
  for (let e = 0; e < count; e++) {
    const a = edges[e * 3]!, b = edges[e * 3 + 1]!, p = edges[e * 3 + 2]!;
    const plane = planes[p]!;
    const a2 = extruded(a, p), b2 = extruded(b, p);
    if (a2 === a && b2 === b) continue;
    // wind so the strip faces OUT of the cell: its normal's plane-axis component along `outward`
    const far = b2 !== b ? b2 : a2;
    const pa = P(a), pb = P(b), pf = P(far);
    const u = [pb[0] - pa[0], pb[1] - pa[1], pb[2] - pa[2]], w = [pf[0] - pa[0], pf[1] - pa[1], pf[2] - pa[2]];
    const n = plane.axis === 0 ? u[1]! * w[2]! - u[2]! * w[1]! : u[0]! * w[1]! - u[1]! * w[0]!;
    const pair = n * plane.outward >= 0 ? [a, b, b2, a, b2, a2] : [a, b2, b, a, a2, b2];
    for (let q = 0; q < 6; q += 3) {
      const p0 = pair[q]!, p1 = pair[q + 1]!, p2 = pair[q + 2]!;
      if (p0 === p1 || p1 === p2 || p2 === p0) continue;
      outIndices[tri * 3] = p0;
      outIndices[tri * 3 + 1] = p1;
      outIndices[tri * 3 + 2] = p2;
      tri++;
    }
  }
  const full = v === vertexCount + count * 2;
  return {
    positions: full ? outPositions : outPositions.slice(0, v * 3),
    normals: full ? outNormals : outNormals.slice(0, v * 3),
    indices: tri === triangleCount + count * 2 ? outIndices : outIndices.slice(0, tri * 3),
    splat: full ? outSplat : outSplat.slice(0, v * surfaceCount),
    tint: full ? outTint : outTint.slice(0, v * 3),
    vertexCount: v,
    triangleCount: tri,
  };
}

/**
 * The vertical band to polygonize for a cell, snapped to the GLOBAL lattice.
 *
 * Snapping is not cosmetic: two neighbouring cells derive different bands from
 * their own terrain, and they only produce identical vertices on the shared
 * boundary plane if both bands sit on multiples of `step`. Without the snap
 * you get a hairline crack along every chunk edge, visible as flickering
 * skybox and felt as a lip the character controller catches on.
 *
 * Snapping alone is not enough where something CROSSES a band limit — a cave,
 * tunnel or carve running below the floor of one cell's band but inside its
 * neighbour's. Each cell sealed it at its own flat height, and on the shared
 * plane one side had cave wall where the other had nothing: open edges, a
 * hole you can see the void through. So the limits are a per-COLUMN pure
 * function of world (x, z) (`bandLimits`: ceiling from ground, additive blob
 * tops and passage roofs plus headroom; floor from `floorAt`), applied to the
 * samples (`applyBandCut`). Both sides of a seam evaluate the same function
 * on the shared plane, so they seal identically. The band is that function's
 * range over the block's columns.
 */
function verticalBand(
  field: WorldField,
  source: VoxelMeshSource,
  x0: number,
  z0: number,
  step: number,
  pad: number,
  columns: number,
): { yMin: number; cellsY: number; cut: BandCut | null } {
  const recipe = field.recipe;
  let rawMin: number;
  let rawMax: number;
  let cut: BandCut | null = null;
  if (source.yRange) {
    rawMin = source.yRange[0];
    rawMax = source.yRange[1];
  } else {
    cut = bandLimits(field, x0 - pad * step, z0 - pad * step, columns, step);
    rawMin = cut.min;
    rawMax = cut.max;
  }
  const yMin = Math.max(recipe.minY, Math.floor(rawMin / step) * step);
  const yMax = Math.min(recipe.maxY, Math.ceil(rawMax / step) * step);
  return { yMin, cellsY: Math.max(0, Math.round((yMax - yMin) / step)), cut };
}

interface BandCut {
  /** Per column (i + k * n): rock forced below `lo`, air above `hi`. */
  lo: Float32Array;
  hi: Float32Array;
  n: number;
  min: number;
  max: number;
}

/**
 * Band limits for every lattice column of a block — the per-column version of
 * what `field.heightRange` reports per cell, and nothing but a function of
 * the column's world position, so neighbours agree on shared columns. The
 * ceiling is per column (ground, additive blob tops, passage roofs + headroom);
 * the floor is `floorAt`.
 */
function bandLimits(field: WorldField, ox: number, oz: number, n: number, step: number): BandCut {
  const recipe = field.recipe;
  const below = recipe.verticalRange.below;
  // headroom must clear the overhang band or a bulge gets flat-capped
  const above = Math.max(recipe.verticalRange.above, recipe.terrain.overhang.strength * 1.6 + step * 2);
  const x1 = ox + (n - 1) * step, z1 = oz + (n - 1) * step;
  // Ceiling raisers whose footprint reaches this block (the boxes heightRange uses).
  const boxes: { x0: number; z0: number; x1: number; z1: number; hi: number }[] = [];
  for (const blob of recipe.features.blobs) {
    if (blob.op !== "add") continue;
    const reach = Math.max(blob.radius, blob.topRadius ?? blob.radius);
    const rx = reach * blob.scaleX + blob.falloff, rz = reach * blob.scaleZ + blob.falloff;
    const b = { x0: blob.center[0] - rx, x1: blob.center[0] + rx, z0: blob.center[2] - rz, z1: blob.center[2] + rz,
      hi: blob.center[1] + blob.height + reach + blob.falloff };
    if (b.x1 >= ox && b.x0 <= x1 && b.z1 >= oz && b.z0 <= z1) boxes.push(b);
  }
  for (const p of recipe.features.passages) {
    const end = p.start[p.axis === "x" ? 0 : 2] + p.direction * p.length;
    const half = p.width / 2 + p.wallNoise + p.falloff;
    const padP = p.falloff + (p.footprint === "ellipse" ? p.wallNoise : 0);
    const b = {
      x0: p.axis === "x" ? Math.min(p.start[0], end) - padP : p.start[0] - half,
      x1: p.axis === "x" ? Math.max(p.start[0], end) + padP : p.start[0] + half,
      z0: p.axis === "z" ? Math.min(p.start[2], end) - padP : p.start[2] - half,
      z1: p.axis === "z" ? Math.max(p.start[2], end) + padP : p.start[2] + half,
      hi: p.start[1] + p.height + p.roofRise + p.roofNoise + p.falloff,
    };
    if (b.x1 >= ox && b.x0 <= x1 && b.z1 >= oz && b.z0 <= z1) boxes.push(b);
  }
  const lo = new Float32Array(n * n);
  const hi = new Float32Array(n * n);
  let min = Infinity;
  let max = -Infinity;
  // Planar cliffs warp rock SIDEWAYS: a column at a cliff's foot can hold rock
  // up to the height of any column within the warp's reach, so its ceiling is
  // the highest ground in that window (a pure function of world position, so
  // neighbours still agree). Without this the pushed-out face is flat-capped.
  const pc = recipe.terrain.planarCliffs;
  const reach = pc ? planarReach(pc, recipe.seed) : null;
  const rr = reach ? Math.ceil(reach.maxPush / step) + 1 : 0;
  const sink = reach && reach.sink > 0 ? reach.sink + 2 * step : 0;
  const gn = n + 2 * rr;
  const grounds = rr > 0 ? new Float64Array(gn * gn) : null;
  if (grounds) for (let k = 0; k < gn; k++) for (let i = 0; i < gn; i++) grounds[i + k * gn] = field.height(ox + (i - rr) * step, oz + (k - rr) * step);
  for (let k = 0; k < n; k++) {
    const z = oz + k * step;
    for (let i = 0; i < n; i++) {
      const x = ox + i * step;
      const ground = grounds ? grounds[i + rr + (k + rr) * gn]! : field.height(x, z);
      let b = ground;
      if (grounds) for (let dk = 0; dk <= 2 * rr; dk++) for (let di = 0; di <= 2 * rr; di++) b = Math.max(b, grounds[i + di + (k + dk) * gn]!);
      for (const box of boxes) {
        if (x < box.x0 || x > box.x1 || z < box.z0 || z > box.z1) continue;
        if (box.hi > b) b = box.hi;
      }
      b += above;
      // terrace walls open treads up to a riser below the ground: the floor goes down with them
      const a = floorAt(field, x, z, ground) - sink;
      lo[i + k * n] = a;
      hi[i + k * n] = b;
      if (a < min) min = a;
      if (b > max) max = b;
    }
  }
  return { lo, hi, n, min, max };
}

/**
 * The band FLOOR under a column. Uncarved ground: the column's own height
 * minus `below` (nothing down there to see). Near a carve: bilinear between
 * cell-corner nodes, each the lowest floor (`heightRange` min − `below`) of
 * the carved cells meeting there — a per-column floor alone would cap a
 * tunnel 28 m into a hillside that the cell's valley floor used to keep open,
 * and a corner minimum is never above any adjacent carved cell's own floor,
 * so nothing that used to mesh is lost. Pure in (x, z): seams agree.
 */
function floorAt(field: WorldField, x: number, z: number, ground: number): number {
  const S = field.recipe.cellSize;
  const column = ground - field.recipe.verticalRange.below;
  const ix = Math.floor(x / S), iz = Math.floor(z / S);
  const tx = x / S - ix, tz = z / S - iz;
  // a corner with no carve in any of its cells contributes this column's own floor
  const c = (v: number): number => (v === Infinity ? column : v);
  const n00 = c(floorNode(field, ix, iz)), n10 = c(floorNode(field, ix + 1, iz));
  const n01 = c(floorNode(field, ix, iz + 1)), n11 = c(floorNode(field, ix + 1, iz + 1));
  return Math.min(column, (n00 * (1 - tx) + n10 * tx) * (1 - tz) + (n01 * (1 - tx) + n11 * tx) * tz);
}

const floorCache = new WeakMap<WorldField, Map<string, number>>();
function cellFloor(field: WorldField, cx: number, cz: number): number {
  let cache = floorCache.get(field);
  if (!cache) floorCache.set(field, (cache = new Map()));
  const key = `${cx},${cz}`;
  let floor = cache.get(key);
  if (floor === undefined) {
    const recipe = field.recipe;
    const S = recipe.cellSize;
    floor = carved(field, cx, cz) ? field.heightRange(cx * S, cz * S, (cx + 1) * S, (cz + 1) * S, Math.min(17, recipe.resolution + 1)).min - recipe.verticalRange.below : Infinity;
    if (cache.size > 50000) cache.clear();
    cache.set(key, floor);
  }
  return floor;
}

/** Does anything carve rock out of this cell (passage, tunnel, subtracting blob, noise caves)? */
function carved(field: WorldField, cx: number, cz: number): boolean {
  const recipe = field.recipe;
  if (recipe.terrain.caves.enabled) return true;
  const S = recipe.cellSize;
  return field.carveSpan(cx * S, cz * S, (cx + 1) * S, (cz + 1) * S) !== null;
}

/** Lowest floor of the four cells meeting at corner (ix, iz); Infinity when none of them is carved. */
function floorNode(field: WorldField, ix: number, iz: number): number {
  return Math.min(cellFloor(field, ix - 1, iz - 1), cellFloor(field, ix, iz - 1), cellFloor(field, ix - 1, iz), cellFloor(field, ix, iz));
}

/**
 * Force rock below each column's band floor and air above its ceiling (see
 * `verticalBand`). Inclusive, with a sliver of margin: a limit landing exactly
 * on a lattice row must not be left to `sealVertically`, which only sees THIS
 * cell's band and could seal it differently from the neighbour.
 */
function applyBandCut(
  values: Float32Array,
  nx: number,
  ny: number,
  nz: number,
  origin: readonly [number, number, number],
  step: number,
  cut: BandCut,
): void {
  const strideZ = nx * ny;
  for (let k = 0; k < nz; k++) {
    for (let i = 0; i < nx; i++) {
      const lo = cut.lo[i + k * cut.n]!;
      const hi = cut.hi[i + k * cut.n]!;
      for (let j = 0; j < ny; j++) {
        const y = origin[1] + j * step;
        const at = i + j * nx + k * strideZ;
        if (y <= lo) values[at] = Math.min(values[at]!, y - lo - step * 1e-3);
        else if (y >= hi) values[at] = Math.max(values[at]!, y - hi + step * 1e-3);
      }
    }
  }
}

/**
 * Force the outermost Y sample layers solid (bottom) and air (top).
 *
 * Below the band everything is rock and above it everything is sky, so in the
 * ordinary case this changes nothing. What it buys is a guarantee: a cave
 * network that runs out through the bottom of a cell's band gets capped
 * instead of leaving an open hole, so the cooked collider is always a closed
 * volume. A hole in terrain collision is the single worst failure this system
 * can produce — you fall out of the world — so it is sealed by construction
 * rather than by hoping the band was generous enough.
 */
function sealVertically(values: Float32Array, nx: number, ny: number, nz: number): void {
  const strideZ = nx * ny;
  const topRow = (ny - 1) * nx;
  for (let k = 0; k < nz; k++) {
    const base = k * strideZ;
    for (let i = 0; i < nx; i++) {
      const bottom = base + i;
      if (values[bottom]! > 0) values[bottom] = -Math.max(1, values[bottom]!);
      const top = base + topRow + i;
      if (values[top]! < 0) values[top] = Math.max(1, -values[top]!);
    }
  }
}

/** Type guard for the mesh-source union, shared by render/physics/placement. */
export function isVoxelSource(source: unknown): source is VoxelMeshSource {
  return (
    typeof source === "object" &&
    source !== null &&
    (source as { kind?: unknown }).kind === "voxel" &&
    typeof (source as { world?: unknown }).world === "string" &&
    Array.isArray((source as { cell?: unknown }).cell)
  );
}

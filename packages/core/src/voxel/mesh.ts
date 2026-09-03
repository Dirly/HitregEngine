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

import { marchingCubes, type MarchResult } from "./marching-cubes.js";
import { createWorldField, type WorldField } from "./field.js";
import { worldRecipeSchema, type WorldRecipe } from "./recipe.js";

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

const worlds = new Map<string, WorldField>();

/** Register/replace a world recipe. Returns the built field. Throws on an invalid recipe. */
export function registerVoxelWorld(id: string, recipe: unknown): WorldField {
  const parsed = worldRecipeSchema.parse(recipe);
  const field = createWorldField(parsed);
  worlds.set(id, field);
  invalidateVoxelWorld(id);
  return field;
}

/** Register an already-parsed recipe (the CLI path, which parses once itself). */
export function registerVoxelField(id: string, recipe: WorldRecipe): WorldField {
  const field = createWorldField(recipe);
  worlds.set(id, field);
  invalidateVoxelWorld(id);
  return field;
}

export function getVoxelWorld(id: string): WorldField | null {
  return worlds.get(id) ?? null;
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
    mesh.tint.byteLength
  );
}

function cacheKey(source: VoxelMeshSource): string {
  const y = source.yRange ? `:${source.yRange[0]},${source.yRange[1]}` : "";
  return `${source.world}:${source.cell[0]}_${source.cell[1]}:${source.lodStep ?? 1}${y}`;
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
  const field = worlds.get(source.world);
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

  const { yMin, cellsY } = verticalBand(field, source, x0, z0, step);
  if (cellsY < 1) return EMPTY_MESH;

  // one padding sample on every side: the mesher needs it for central-difference
  // normals, and it is what makes normals match ACROSS a chunk seam without the
  // two chunks ever exchanging geometry
  const nx = cells + 3;
  const ny = cellsY + 3;
  const nz = cells + 3;
  const origin: [number, number, number] = [x0 - step, yMin - step, z0 - step];

  const values = field.sampleBlock({ origin, nx, ny, nz, step });
  sealVertically(values, nx, ny, nz);

  const result: MarchResult = marchingCubes(
    { values, nx, ny, nz, origin, step },
    {
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
  const skirted = addSkirts(result, splat, tint, surfaceCount, x0, z0, recipe.cellSize, step * SKIRT_STEPS);
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

  return {
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
}

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
 * The skirt is part of the one shared mesh (render, physics, placement): in
 * the simulation ring every neighbour is full detail, so there it is entirely
 * inside rock and nothing can touch it.
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
      if (a && b && !c) edges.push(i0, i1, p);
      else if (b && c && !a) edges.push(i1, i2, p);
      else if (c && a && !b) edges.push(i2, i0, p);
    }
  }
  const count = edges.length / 3;
  if (count === 0) return { ...mesh, splat, tint };

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
  for (let e = 0; e < count; e++) {
    const a = edges[e * 3]!;
    const b = edges[e * 3 + 1]!;
    const plane = planes[edges[e * 3 + 2]!]!;
    const a2 = v++;
    const b2 = v++;
    copyVertex(a, a2, depth);
    copyVertex(b, b2, depth);
    // wind so the strip faces OUT of the cell: (b - a) x (b2 - a) along the plane normal
    const abx = positions[b * 3]! - positions[a * 3]!;
    const abz = positions[b * 3 + 2]! - positions[a * 3 + 2]!;
    // (ab) x (0, -depth, 0): x = abz * depth ... only the plane-axis component matters
    const nx = -abz * -depth; // (ab_y * c_z - ab_z * c_y) with c = (0,-depth,0): -ab_z * -depth
    const nz = abx * -depth; // (ab_x * c_y - ab_y * c_x)
    const facing = plane.axis === 0 ? nx * plane.outward : nz * plane.outward;
    if (facing >= 0) {
      outIndices.set([a, b, b2, a, b2, a2], tri * 3);
    } else {
      outIndices.set([a, b2, b, a, a2, b2], tri * 3);
    }
    tri += 2;
  }
  return {
    positions: outPositions,
    normals: outNormals,
    indices: outIndices,
    splat: outSplat,
    tint: outTint,
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
 */
function verticalBand(
  field: WorldField,
  source: VoxelMeshSource,
  x0: number,
  z0: number,
  step: number,
): { yMin: number; cellsY: number } {
  const recipe = field.recipe;
  let rawMin: number;
  let rawMax: number;
  if (source.yRange) {
    rawMin = source.yRange[0];
    rawMax = source.yRange[1];
  } else {
    const range = field.heightRange(x0, z0, x0 + recipe.cellSize, z0 + recipe.cellSize, Math.min(17, recipe.resolution + 1));
    // headroom must clear the overhang band or a bulge gets flat-capped
    const above = Math.max(recipe.verticalRange.above, recipe.terrain.overhang.strength * 1.6 + step * 2);
    rawMin = range.min - recipe.verticalRange.below;
    rawMax = range.max + above;
  }
  const yMin = Math.max(recipe.minY, Math.floor(rawMin / step) * step);
  const yMax = Math.min(recipe.maxY, Math.ceil(rawMax / step) * step);
  return { yMin, cellsY: Math.max(0, Math.round((yMax - yMin) / step)) };
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

/**
 * Procedural voxel worlds: marching-cubes terrain with layered noise, biome
 * rules, streamed chunks and deterministic scatter.
 *
 * The pipeline this is built for, in order — each stage writes a few lines of
 * JSON into the recipe's `features`, and the field re-derives around them:
 *
 * ```text
 * noise field -> carve streams -> mark towns -> carve roads -> place POIs -> WFC buildings
 * ```
 *
 * Entry points, roughly in the order you meet them:
 * - {@link worldRecipeSchema} / {@link defaultWorldRecipe} — the world document
 * - {@link createWorldField} — the recipe made sampleable (height, density, biome)
 * - {@link voxelMesh} — one cell's geometry, shared by render/physics/placement
 * - {@link voxelChunkDoc} — one cell as an ordinary streamable chunk document
 * - {@link scatterCell} — the trees and rocks in a cell, chunk-independent
 */

export { mergeVoxelMeshes } from "./merge.js";
export {
  hash3i,
  hash2i,
  hashUnit,
  perlin2,
  perlin3,
  fbm2,
  fbm3,
  smoothstep,
  clamp,
  mulberry32,
  type FbmSpec,
} from "./noise.js";

export {
  MC_TRIANGLES,
  MC_EDGE_MASK,
  CORNER_OFFSETS,
  EDGE_CORNERS,
  EDGE_LATTICE,
} from "./tables.js";

export {
  marchingCubes,
  emptyMarchResult,
  type SampledBlock,
  type MarchOptions,
  type MarchResult,
  type VertexAttributeSpec,
} from "./marching-cubes.js";

export {
  worldRecipeSchema,
  defaultWorldRecipe,
  continentalWorldRecipe,
  MAX_SURFACES,
  riverSchema,
  canyonSchema,
  roadSchema,
  townSchema,
  blobSchema,
  tunnelSchema,
  poiSchema,
  type WorldRecipe,
  type FbmSpecDoc,
  type SurfaceDoc,
  type BiomeDoc,
  type PatchDoc,
  type ScatterDoc,
  type RiverDoc,
  type CanyonDoc,
  type RoadDoc,
  type TownDoc,
  type BlobDoc,
  type TunnelDoc,
  type PoiDoc,
  type LakeDoc,
  type BridgeDoc,
  type FillDoc,
  type RiverPathDoc,
  type ZoneAnchorDoc,
  type ZonesDoc,
  lakeSchema,
  bridgeSchema,
  fillSchema,
  riverPathSchema,
} from "./recipe.js";

export {
  createWorldField,
  type WorldField,
  type BiomeSample,
  type ZoneSample,
  type SampleBlockRequest,
  type PolylineHit,
} from "./field.js";

export {
  voxelMesh,
  buildVoxelMesh,
  primeVoxelMesh,
  registerVoxelWorld,
  registerVoxelField,
  getVoxelWorld,
  voxelWorldIds,
  clearVoxelWorlds,
  invalidateVoxelWorld,
  invalidateVoxelCells,
  voxelMeshCacheStats,
  isVoxelSource,
  type VoxelMesh,
  type VoxelMeshSource,
} from "./mesh.js";

export {
  scatterCell,
  scatterVariation,
  type VoxelScatterInstance,
  type ScatterCellOptions,
} from "./scatter.js";

export {
  voxelChunkDoc,
  voxelChunkOptionsFrom,
  cellsInRect,
  VOXEL_TERRAIN_ID,
  type VoxelChunkOptions,
} from "./chunk.js";

export {
  applyRecipeEdits,
  featureFootprint,
  cellsForFootprints,
  cellsForEdits,
  recipeEditSchema,
  RecipeEditError,
  FEATURE_KINDS,
  RECIPE_EDIT_SPECS,
  type RecipeEdit,
  type RecipeEditResult,
  type FeatureKind,
  type Footprint,
} from "./terraform.js";

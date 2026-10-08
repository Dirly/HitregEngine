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
export { reduceSplatTop4, SPLAT_TOP_UNUSED, type SplatTop4Options } from "./splat-top4.js";
export { zoneGroundRoles, surfaceAliases, surfaceBaseIndex, type ZoneGroundRoles } from "./zone-ground.js";
export {
  coverClumpKeep,
  coverEdgeClearance,
  coverClumpRejects,
  coverKeepHash,
  coverScratch,
  coverWaterLevel,
  coverWaterGate,
  type CoverGateLayer,
} from "./cover.js";
export {
  regionVegetationSchema,
  clearingSchema,
  vegetationIndex,
  coverVegetationRejects,
  VegetationIndex,
  CLEARING_PAD,
  type RegionVegetation,
  type ClearingDoc,
  type VegetationPlan,
  type VegetationRecipe,
  type CoverVegetationLayer,
} from "./vegetation.js";
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

export { dualContour, type DualContourOptions } from "./dual-contouring.js";
export { csgTriangleMeshSchema, compileTriangleMesh, type CsgTriangleMesh, type CompiledTriangleMesh } from "./triangle-mesh.js";

export {
  volumeDocSchema,
  volumePaintSchema,
  blendVolumePaint,
  type VolumePaint,
  csgNodeSchema,
  csgSurfaceSchema,
  csgHeightfieldSchema,
  csgNoiseSchema,
  type CsgNoise,
  encodeHeightfieldValues,
  decodeHeightfieldValues,
  createVolume,
  buildVolumeMesh,
  registerVolume,
  registerVolumeDoc,
  isVolumeInUse,
  getVolume,
  volumeIds,
  invalidateVolume,
  clearVolumes,
  isCsgSource,
  csgMesh,
  type VolumeDoc,
  type CsgNode,
  type CsgSurface,
  type CsgHeightfield,
  type CsgMeshSource,
  type Volume,
} from "./csg.js";

export {
  worldRecipeSchema,
  defaultWorldRecipe,
  continentalWorldRecipe,
  MAX_SURFACES,
  MAX_INDEXED_SURFACES,
  SURFACE_ROLES,
  NATURAL_SURFACE_ROLES,
  type SurfaceRole,
  type NaturalSurfaceRole,
  recipeSplatIndexed,
  riverSchema,
  canyonSchema,
  roadSchema,
  townSchema,
  heightPatchSchema,
  type HeightPatchDoc,
  townGateSchema,
  terraceSchema,
  blobSchema,
  passageSchema,
  tunnelSchema,
  poiSchema,
  storySchema,
  storyBeatSchema,
  storyPackSchema,
  type WorldRecipe,
  type FbmSpecDoc,
  type SurfaceDoc,
  type BiomeDoc,
  type PatchDoc,
  type ScatterDoc,
  type ScatterClumpDoc,
  coverLayerSchema,
  type CoverLayerDoc,
  type RiverDoc,
  type CanyonDoc,
  type RoadDoc,
  type TownDoc,
  type TownGateDoc,
  type TerraceDoc,
  campSchema,
  type CampDoc,
  type BlobDoc,
  type PassageDoc,
  type TunnelDoc,
  type PoiDoc,
  type StoryDoc,
  type StoryBeatDoc,
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
  ridgeSchema,
  type RidgeDoc,
} from "./recipe.js";
export {
  regionSchema,
  regionMoodSchema,
  type RegionMood,
  regionAt,
  townRegionOf,
  polygonEnclosesCircle,
  auditRegions,
  type RegionDoc,
  type RegionInput,
  type RegionReport,
  type RegionsAudit,
} from "./regions.js";

export {
  sharedBorderChains,
  outlineChain,
  allSharedBorders,
  classifyChain,
  classBreakdown,
  openRuns,
  passesOnRun,
  guaranteedPass,
  ridgePieces,
  simplifyPolyline,
  passWidthFor,
  BORDER_CLASSES,
  type BorderClass,
  type BorderSample,
  type ClassifiedSample,
  type BorderChain,
  type OpenRun,
  type PassPlan,
  type PathLike,
} from "./borders.js";

export {
  createWorldField,
  type WorldField,
  type RiverFall,
  type SurfaceSample,
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
  registerVoxelRecipe,
  registerVoxelRecipeLoader,
  getVoxelRecipe,
  getVoxelWorld,
  isVoxelWorldInUse,
  voxelWorldIds,
  clearVoxelWorlds,
  invalidateVoxelWorld,
  invalidateVoxelCells,
  voxelMeshCacheStats,
  isVoxelSource,
  type VoxelMesh,
  type VoxelMeshSource,
  type VoxelMesher,
} from "./mesh.js";

export {
  scatterCell,
  scatterFooting,
  editedGround,
  FOOTING_OPEN,
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
export { fallSiteSchema, applyFallSites, fallSiteLedge, FALL_SITE_MIN_TIER, type FallSiteDoc, type SolvedFallSite } from "./fall-sites.js";
export { rockFormations, rockFormationSolid, type RockFormationSolid, type RockFormationSite, type RockFormationOptions, type RockFormationResult, type RockMass } from "./rock-formations.js";
export { fallSiteRockInstances, meshDensity, type SiteRockInstance, type MeshDensity } from "./fall-site-rocks.js";

export {
  auditVoxelMesh,
  type VoxelMeshAuditOptions,
  type VoxelMeshAuditResult,
  type VoxelMeshBlade,
} from "./mesh-audit.js";
export {
  prepareHeightPatch,
  tentFilterRaster,
  slopeLimitRaster,
  PATCH_EDGE_SLOPE,
  type PreparedHeightPatch,
} from "./height-patch.js";
export {
  measureTerrainLips,
  latticeHeight,
  seatReport,
  type TerrainLipOptions,
  type TerrainLipFault,
  type TerrainLipKind,
  type TerrainLipReport,
  type SeatReport,
} from "./terrain-lips.js";

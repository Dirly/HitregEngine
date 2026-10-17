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
  coverKindAllowed,
  coverWantsInland,
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

export { dualContour, type DualContourOptions, type HermiteSource } from "./dual-contouring.js";
export { planarCliffsSchema, planarZoneSchema, planarFallsSchema, createPlanarCliffs, planarReach, wallsDensity, type PlanarCliffs, type PlanarCliffsDoc, type PlanarZoneDoc, type PlanarFallsDoc } from "./planar-cliffs.js";
export { seaCliffSchema, seaCliffsSchema, seaStackShapeSchema, createSeaCliffs, type SeaCliffDoc, type SeaCliffs, type SeaStack, type SeaStackShapeDoc } from "./sea-cliffs.js";
export { butteFieldSchema, buttesSchema, createButtes, type ButteFieldDoc, type Buttes } from "./buttes.js";
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
  regionSoundSchema,
  regionSoundBandsSchema,
  regionAmbientLayerSchema,
  type RegionSound,
  type RegionSoundBands,
  type RegionAmbientLayer,
  regionLookAt,
  type RegionLook,
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
  type SampleBlockExact,
  type PolylineHit,
} from "./field.js";

export {
  voxelMesh,
  buildVoxelMesh,
  dualMeshExperiment,
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
  cachedVoxelMesh,
  isVoxelSource,
  type VoxelMesh,
  type VoxelMeshSource,
  type VoxelMesher,
  type VoxelMesherChoice,
  resolveCellMesher,
} from "./mesh.js";

export {
  scatterCell,
  scatterFooting,
  scatterContact,
  scatterGroundProbe,
  scatterSeatSize,
  editedGround,
  FOOTING_OPEN,
  scatterVariation,
  type VoxelScatterInstance,
  type ScatterCellOptions,
} from "./scatter.js";

export {
  voxelChunkDoc,
  ribbonSurfaces,
  voxelChunkOptionsFrom,
  voxelRecipeAssetRefs,
  cellsInRect,
  VOXEL_TERRAIN_ID,
  fittedFalls,
  voxelWaterEntities,
  FALL_LIP_OFFSET,
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
export {
  terraceWallSchema,
  terraceWallInsertSchema,
  terraceWallPieceSchema,
  terraceWallSolvedSchema,
  terraceWallCutSchema,
  terraceWallEntities,
  terraceWallFeatureId,
  TERRACE_WALL_STYLES,
  TERRACE_WALL_INSERTS,
  type TerraceWallDoc,
  type TerraceWallSolved,
  type TerraceWallInsert,
  type TerraceWallCut,
} from "./terrace-walls.js";
export {
  FINE_MIN,
  FINE_REMEDY,
  FINE_EXEMPT_PREFIXES,
  registerOperator,
  getOperator,
  operatorNames,
  operatorSpecs,
  operatorDocSchema,
  operatorCompiledSchema,
  operatorParams,
  operatorPrefix,
  operatorPieces,
  withoutOperatorPieces,
  groundFingerprint,
  featureMinDimension,
  fineCarves,
  compileOperator,
  applyOperator,
  removeOperator,
  checkOperators,
  hash32,
  type LandformOperator,
  type OperatorDoc,
  type OperatorFieldReader,
  type OperatorOutput,
  type OperatorPiece,
  type OperatorBounds,
  type OperatorApplyResult,
  type OperatorState,
  type FineCarve,
  type FineReport,
} from "./operators.js";
export { terraceOperatorSchema, type TerraceOperatorParams } from "./operators-terrace.js";
export * from "./ribbon.js";
export * from "./kit-walls.js";
export * from "./ledge-landmark.js";
export { caveOperatorSchema, caveRoutes, type CaveOperatorParams } from "./operators-cave.js";
export { ledgesOperatorSchema, landmarkOptions, landmarkPrefabId, solveLedges, type LedgesOperatorParams } from "./operators-ledges.js";
export { rockCover, routeCover } from "./cave-route.js";
export { solveShelves, contourLines, fringeShelves, type ShelvingOptions, type ShelvingResult, type ShelvingGrid, type ShelfArea } from "./shelving.js";
export {
  bridgeSpanSchema,
  bridgeAnchorSchema,
  bridgeSpanPieceSchema,
  bridgeSpanPierSchema,
  bridgeSpanSolvedSchema,
  bridgeSpanEntities,
  bridgeSpanFeatureId,
  BRIDGE_SPAN_KINDS,
  BRIDGE_SPAN_STYLES,
  type BridgeSpanDoc,
  type BridgeSpanSolved,
} from "./bridge-spans.js";
export { measureFallLip, fitFall, shiftFall, fallFace, fallColumn, profileFace, groundAtProfile, fallProbeDepth, FALL_LIP_SEARCH, FALL_FACE_CLEAR, type FallLip, type FallFitField } from "./fall-fit.js";
export { fallSiteSchema, applyFallSites, fallSiteLedge, FALL_SITE_MIN_TIER, type FallSiteDoc, type SolvedFallSite } from "./fall-sites.js";
export { rockFormations, rockFormationSolid, rockMassNodes, zoneWallStone, type RockShapeContext, type RockFormationSolid, type RockFormationSite, type RockFormationOptions, type RockFormationResult, type RockMass } from "./rock-formations.js";
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
export { rockCapResolver, createRockCapResolver, rockSkinProbe, createRockSkinProbe, type RockCapResolver, type RockSkinProbe, type RockSkinPick, type GroundBand } from "./rock-cap.js";
export { formationMembers, waterPlacement, type FormationMember } from "./formations.js";
export {
  seatObject,
  seatMany,
  seatSamples,
  fieldSolidProbe,
  triangleSolidProbe,
  unionSolidProbe,
  defaultSeatContact,
  SEAT_CONTACTS,
  type SeatContact,
  type SeatFootprint,
  type SeatOptions,
  type SeatResult,
  type SeatStatus,
  type SolidProbe,
  type SeatField,
} from "./seat.js";
export * from "./landmark-stamp.js";
export { landmarkOperatorSchema, landmarkSourceSchema, compileLandmarkOperator, landmarkSpecOf, type LandmarkOperatorParams } from "./operators-landmark.js";

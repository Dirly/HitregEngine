export { newId, type EntityId } from "./ids.js";
export {
  createScene,
  childrenOf,
  subtreeOf,
  validateScene,
  entityDocSchema,
  sceneDocSchema,
  type EntityDoc,
  type SceneDoc,
  type SceneIssue,
} from "./scene.js";
export {
  ComponentRegistry,
  type ValidationResult,
} from "./components/registry.js";
export {
  registerCoreComponents,
  transformSchema,
  visibilitySchema,
  meshSchema,
  lightSchema,
  cameraSchema,
  materialSchema,
  scriptSchema,
  animatorSchema,
  audioSchema,
  skySchema,
  postfxSchema,
  particlesSchema,
  billboardSchema,
  grassSchema,
  netObjectSchema,
  type NetObjectData,
  vec3,
  quat,
  hexColor,
} from "./components/core.js";
export { applyOps, OpError, OP_SPECS, type Op, type ApplyResult } from "./ops.js";
export {
  buildEngineSpec,
  ENGINE_SPEC_VERSION,
  type EngineSpec,
  type EngineSpecInputs,
} from "./spec.js";
export {
  ToolRegistry,
  toolDefinitionSchema,
  toolIdSchema,
  toolManifestSchema,
  toolInputSchema,
  toolFileValueSchema,
  toolResultSchema,
  type ToolDefinition,
  type ToolDescription,
  type ToolManifest,
  type ToolInput,
  type ToolFileValue,
  type ToolResult,
  type ToolValidationResult,
} from "./tools.js";
export { FixedTimestepLoop, type LoopOptions } from "./loop.js";
export {
  expandScene,
  prefabFromSubtree,
  validatePrefab,
  describePrefab,
  inferPropKind,
  prefabDocSchema,
  prefabInstanceSchema,
  propSpecSchema,
  PROP_KINDS,
  PrefabError,
  type PrefabDoc,
  type PrefabInstance,
  type PrefabPartSpec,
  type PrefabPropSpec,
  type PrefabSpec,
  type PropKind,
  type PropSpec,
} from "./prefab.js";
export {
  AssetLibrary,
  AssetError,
  registerCoreAssetTypes,
  type DataAssetDoc,
  type ModelAssetDoc,
} from "./assets.js";
export { SceneStore, type StoreChange } from "./store.js";
export { duplicateSubtree } from "./duplicate.js";
export {
  quatMultiply,
  vecApplyQuat,
  worldTransforms,
  type Vec3,
  type Quat,
  type WorldTransform,
} from "./math.js";
export {
  registerPhysicsComponents,
  rigidbodySchema,
  colliderSchema,
  jointSchema,
} from "./components/physics.js";
export {
  registerPathComponents,
  pathScatterSchema,
  type PathScatterData,
} from "./components/path.js";
export {
  sampleHeightmap,
  heightmapMesh,
  type HeightmapParams,
  type HeightmapMesh,
} from "./terrain.js";
export { terrainHeightfieldSchema, type TerrainHeightfield } from "./assets.js";
export {
  PlayerDataService,
  PlayerDataError,
  MemoryPlayerDataBackend,
  playerDataRecordSchema,
  defaultPlayerDataLimits,
  type PlayerDataBackend,
  type PlayerDataRecord,
  type PlayerDataScope,
  type PlayerDataLimits,
} from "./player-data.js";
export {
  chunkDocSchema,
  chunkStreamerSchema,
  registerChunkComponents,
  parseChunkCoords,
  chunkFileName,
  chunkToSceneDoc,
  chunkOrigin,
  chunkLocalToWorld,
  worldToChunkLocal,
  moveEntityAcrossChunks,
  computeChunkStates,
  resolveChunkRings,
  chunkKey,
  parseChunkKey,
  partitionScene,
  DEFAULT_GLOBAL_COMPONENTS,
  subsceneSchema,
  subsceneToSceneDoc,
  type ChunkDoc,
  type ChunkStreamerData,
  type ChunkCell,
  type ChunkMoveResult,
  type ChunkRep,
  type PartitionOptions,
  type PartitionResult,
  type SubsceneData,
} from "./chunks.js";
export {
  supercellForCell,
  supercellOrigin,
  groupCellsBySupercell,
  isStaticRenderEntity,
  assembleHlodBuildDoc,
  hlodCacheKey,
  HLOD_GENERATOR_VERSION,
  type HlodDependencies,
  type HlodBuildResult,
  type AssembleHlodOptions,
  type HlodCacheKeyInput,
} from "./hlod.js";
export {
  buildSceneIndex,
  updateSceneIndex,
  indexChildrenOf,
  indexSubtreeOf,
  type SceneIndex,
} from "./scene-index.js";
export { diffSceneDocs } from "./diff.js";
export {
  spritesheetSchema,
  resolveSpriteFrames,
  resolveSpriteFrame,
  gridFrameRect,
  frameToUv,
  nearestFrameName,
  type SpritesheetDoc,
  type SpriteFrame,
} from "./spritesheet.js";
export {
  EventRegistry,
  registerCoreEvents,
  type EventReplication,
  type EventRegistrationOptions,
} from "./events.js";
export {
  NetStateStore,
  type NetStateDelta,
  type NetStateChangeHandler,
} from "./net-state.js";
export {
  gameManifestSchema,
  parseManifest,
  RUNTIME_ENGINE,
  RUNTIME_VERSION,
  MANIFEST_VERSION,
  type GameManifest,
} from "./manifest.js";
export * from "./poly-mesh/index.js";
export {
  Profiler,
  noopProfiler,
  type ProfilerLike,
  type ProfilerOptions,
  type ProfileSummary,
  type ProfileMarker,
  type ScopeStat,
  type SpikeFrame,
} from "./profiler.js";
export {
  digestProfile,
  type ProfileDigest,
  type PerfVerdict,
  type DigestContext,
} from "./profile-digest.js";
export {
  placementSchema,
  registerPlacementComponent,
  type PlacementData,
} from "./components/placement.js";
export {
  collectSceneTriangles,
  raycastTriangles,
  snapPlacementOps,
  lintPlacement,
  type TriangleSoup,
  type RayHit,
  type SnapOptions,
  type SnapResult,
  type LintOptions,
  type PlacementFinding,
  type PlacementFindingKind,
} from "./placement.js";
export {
  themeSchema,
  themeSlotSchema,
  themeLightSchema,
  THEME_SLOTS,
  REQUIRED_THEME_SLOTS,
  DEFAULT_SLOT_UV_SCALE,
  registerThemeAssetType,
  materialsForTheme,
  materialIdFor,
  uvScaleFor,
  themeFromTextureFolder,
  type Theme,
  type ThemeInput,
  type ThemeSlot,
  type ThemeSlotInput,
  type ThemeSlotName,
  type ThemeMaterialDoc,
  type ThemeFolderReport,
} from "./theme.js";
export {
  scatterOps,
  polygonArea,
  pointInPolygon,
  polygonEdgeDistance,
  type ScatterEntry,
  type ScatterRegion,
  type ScatterOptions,
  type ScatterPlacement,
  type ScatterDrop,
  type ScatterReport,
  type ScatterResult,
} from "./scatter.js";
export {
  waterFillOps,
  lintWater,
  type WaterRegion,
  type WaterFillOptions,
  type WaterFillReport,
  type WaterFillResult,
  type WaterFinding,
  type WaterLintOptions,
} from "./water.js";
export { decalSchema, registerDecalComponent, type DecalData } from "./components/decal.js";
export {
  voxelWorldSchema,
  registerVoxelComponents,
  type VoxelWorldData,
} from "./components/voxel.js";
export * from "./voxel/index.js";
export {
  projectManifestSchema,
  projectToolDependencySchema,
  resolveProjectTools,
  describeMissingTools,
  type ProjectManifest,
  type ProjectToolDependency,
  type ProjectToolReport,
  type ProjectToolStatus,
} from "./project.js";

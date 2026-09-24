export {
  buildScene,
  polygonGeometry,
  geometryFor,
  loadGltf,
  gltfLoadingCount,
  makeMaterial,
  patchMaterial,
  materialForId,
  applyEntityTransform,
  rebuildEntityVisuals,
  type BuiltScene,
  type BuildOptions,
  type MaterialData,
} from "./scene-builder.js";
export { buildHlodProxy, type HlodProxy, type HlodProxyStats } from "./hlod-proxy.js";
export { reconcileScene, type ReconcileHooks } from "./reconcile.js";
export { attachPhysicsDebug, detachPhysicsDebug } from "./physics-debug.js";
export { attachLightDebug, detachLightDebug } from "./light-debug.js";
export { attachSkeletonDebug, collectBones, countAttachedSkeletonDebug, setSkeletonDebugAttached } from "./skeleton-debug.js";
export { extractCollisionGeometry, makeMeshGeometryProvider, type CollisionGeometry } from "./collision-geometry.js";
export { AnimationSystem, type AnimatorData } from "./animation.js";
export { ClothSwaySystem, DEFAULT_CLOTH_SWAY, markClothVertices, type ClothSwayOptions, type IslandReport } from "./cloth-sway.js";
export { ParticleSystem, type ParticlesData, type ParticleValue } from "./particles.js";
export {
  AmbientVfx,
  VfxSystem,
  resolveAnchor,
  type AmbientVfxData,
  type AmbientVfxOptions,
  type SpellHandle,
  type SpellPlayOptions,
  type VfxFrame,
  type VfxHandle,
  type VfxResolvers,
  type VfxStats,
} from "./vfx/index.js";
export {
  BillboardSystem,
  type BillboardData,
  type BillboardValue,
  type BillboardResolvers,
  type FlipbookData,
} from "./billboards.js";
export { applyFoliageNormals, foliageNormals, type FoliageNormalOptions } from "./foliage-normals.js";
export { applyModelBrightness } from "./model-brightness.js";
export { applyModelEmissive, applyModelMap, applyModelPartMask, modelPartIndex, partBounds, partMaskFromNames, partSize, resolvePartAnchor, type PartAnchor } from "./ubermesh.js";
export { MovingInstanceSystem, type MovingInstanceEntry, type MovingInstanceGlow, type MovingInstanceLook } from "./moving-instances.js";
export { findSocketBone, socketParamsFrom, socketWorldPose, type SocketParams } from "./socket-pose.js";
export { applyFoliageWind, setFoliageWindScale, windMaterialMatches, FOLIAGE_WIND, type FoliageWindMode, type FoliageWindOptions } from "./foliage-wind.js";
export { applyFoliageFade, setFoliageFade, FOLIAGE_FADE, type FoliageFadeState } from "./foliage-fade.js";
export { asNodeMaterial, cloneMaterial, editMeshMaterials } from "./node-material.js";
export {
  GrassSystem,
  crossQuadGeometry,
  type GrassData,
  type GroundSampler,
  type FoliageSampler,
  type GrassTextureResolver,
} from "./grass.js";
export {
  EngineRenderer,
  type Backend,
  type BloomOptions,
  type RenderScopeSink,
} from "./renderer.js";
export {
  POST_PASS_ORDER,
  PostChain,
  TAA_FALLBACK_REASON,
  evaluateGrade,
  needsPipeline,
  passPlan,
  pipelineSignature,
  resolvePostFx,
  toneMappingConstant,
  type AntialiasMode,
  type PostFxData,
  type PostPassId,
  type PostTextureResolver,
  type ResolvedPostFx,
  type TonemapMode,
  pixelateRatio,
  type PixelateFx,
  type PixelateFilter,
  type LivePostFxOptions,
  type SandstormFx,
} from "./post.js";
export { FoliageLodSystem, type InstancedPropBatch } from "./foliage-lod.js";
export { simplifyGeometry, simplifierReady, type SimplifiedGeometry, type SimplifyOptions } from "./mesh-simplify.js";
export {
  buildClusterDag,
  clusterDagReady,
  clusterDagSupported,
  selectClusterCut,
  cutTriangleCount,
  type ClusterDag,
  type ClusterDagOptions,
  type CutView,
  type DagCluster,
  type DagGroup,
} from "./cluster-dag.js";
export { ClusteredMesh, ClusterLodSystem, clusterDagFromGeometry } from "./clustered-mesh.js";
export {
  DEFAULT_IMPOSTOR_FRAME_SIZE,
  DEFAULT_IMPOSTOR_GRID,
  hemiOctDecode,
  hemiOctEncode,
  impostorFrameDirection,
  impostorFrameDirections,
  impostorFrameUp,
  selectImpostorFrames,
  type ImpostorAtlas,
  type ImpostorInstanceData,
} from "./impostor.js";
export { LightBudgetSystem } from "./light-budget.js";
export { pathGeometry, type PathMeshSource } from "./path-mesh.js";
export { WaterWake, waterWakeUniforms, type WaterWakeOptions } from "./water-wake.js";
export { polyMeshGeometry, polyFaceForHit } from "./poly-mesh-geometry.js";
export {
  CASCADE_BIAS_SCALE_CAP,
  CascadeShadowSystem,
  DEFAULT_SHADOW_SETTINGS,
  applyShadowSettings,
  cascadeBiasScale,
  cascadeDistances,
  cascadeSplits,
  frustumSliceCorners,
  frustumSliceSphere,
  quantizeExtent,
  shadowEnabled,
  shadowFarPlane,
  shadowPassCost,
  snapToTexelGrid,
  type CascadeShadowStats,
  type ShadowSettings,
  type SliceSphere,
} from "./csm.js";
export {
  DEFAULT_VOLUMETRIC_SETTINGS,
  FogSystem,
  VOLUMETRIC_RESOLUTION_SCALE,
  VolumetricShafts,
  decayToDistanceAttenuation,
  densityToGodrayDensity,
  fogFactor,
  heightFogAttenuation,
  volumetricLightCandidates,
  volumetricPlanKey,
  volumetricSampleCost,
  volumetricSignature,
  type FogSettings,
  type VolumetricInputs,
  type VolumetricRequest,
  type VolumetricSettings,
} from "./atmosphere.js";
export {
  EnvironmentSystem,
  NO_ENVIRONMENT,
  SKY_ENVIRONMENT_SIZE,
  applyEnvironment,
  averageLuminance,
  environmentCacheKey,
  loadEquirectTexture,
  skyEnvironmentTexture,
  skyEquirectData,
  type EnvironmentOptions,
  type EnvironmentResult,
  type EnvironmentSettings,
  type SkyEnvironmentSource,
} from "./environment.js";
export {
  SceneLighting,
  sceneLighting,
  type LiveSkyOptions,
  type LiveSkyBase,
  type SceneLightingOptions,
  type SceneLightingStats,
  type SkyData,
  type SkyFogData,
} from "./scene-lighting.js";
export { currentMaterialEnvironment, setEnvironment, applyModelTextureFilter, type TextureFilter } from "./material-maps.js";
export { cachedSkyEnvironmentTexture, clearSkyEnvironmentCache } from "./environment.js";
export {
  batchStaticMeshes,
  mergeModelSubmeshes,
  ownerOfFace,
  BATCH_OWNERS,
  STATIC_BATCH_FLAG,
  type BatchOwners,
  type StaticBatchHandle,
  type StaticBatchStats,
} from "./static-batch.js";
export {
  InstancedProps,
  applyInstancedProps,
  instanceMatrixNode,
  instancedPositionLocal,
  isInstancedProps,
  isInstancedPropMaterial,
  INSTANCE_MATRIX_ATTRIBUTES,
} from "./instancing.js";
export {
  freezeStaticSubtree,
  refreshStaticSubtree,
  thawStaticSubtree,
  isFrozenStaticSubtree,
} from "./static-transforms.js";
export { bumpShadowPassMaterials } from "./shadow-pass-material.js";
export { trackRenderObjects, SWEEP_FRAMES, type RenderObjectSweep } from "./render-object-sweep.js";
export { InstancedPropPool, type PoolEntry, type PoolStats } from "./prop-pool.js";
export {
  flushDecals,
  reprojectDecalsAround,
  syncEntityDecals,
  type DecalBuildOptions,
  type DecalData,
  type DecalRequest,
} from "./decals.js";

export {
  ThirdPersonCameraRig,
  DEFAULT_CAMERA_RIG,
  type CameraRigConfig,
  type CameraSweep,
  type RigVec3,
  fitRigToBody,
  type RigBodyCollider,
} from "./camera-rig.js";

export { voxelGeometry, csgGeometry, voxelColliderProxyGeometry } from "./voxel-geometry.js";
export { PortraitView, type PortraitOptions } from "./portrait.js";
export { buildTerrainSplatMaterial, SPLAT_ATTRIBUTE, SPLAT_ATTRIBUTES, type SplatData } from "./terrain-splat.js";

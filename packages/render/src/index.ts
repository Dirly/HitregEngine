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
export { attachPhysicsDebug } from "./physics-debug.js";
export { attachLightDebug } from "./light-debug.js";
export { attachSkeletonDebug, collectBones } from "./skeleton-debug.js";
export { extractCollisionGeometry, makeMeshGeometryProvider, type CollisionGeometry } from "./collision-geometry.js";
export { AnimationSystem, type AnimatorData } from "./animation.js";
export { ParticleSystem, type ParticlesData, type ParticleValue } from "./particles.js";
export { BillboardSystem, type BillboardData, type BillboardValue, type BillboardResolvers } from "./billboards.js";
export { GrassSystem, type GrassData, type GroundSampler } from "./grass.js";
export { EngineRenderer, type Backend, type BloomOptions } from "./renderer.js";
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
export { WaterSimulation } from "./water-sim.js";
export { polyMeshGeometry, polyFaceForHit } from "./poly-mesh-geometry.js";

export {
  buildScene,
  polygonGeometry,
  geometryFor,
  loadGltf,
  makeMaterial,
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
export { attachSkeletonDebug, collectBones } from "./skeleton-debug.js";
export { extractCollisionGeometry, makeMeshGeometryProvider, type CollisionGeometry } from "./collision-geometry.js";
export { AnimationSystem, type AnimatorData } from "./animation.js";
export { ParticleSystem, type ParticlesData } from "./particles.js";
export { BillboardSystem, type BillboardData, type BillboardValue, type BillboardResolvers } from "./billboards.js";
export { EngineRenderer, type Backend, type BloomOptions } from "./renderer.js";

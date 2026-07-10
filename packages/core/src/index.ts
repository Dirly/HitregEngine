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
  vec3,
  quat,
  hexColor,
} from "./components/core.js";
export { applyOps, OpError, type Op, type ApplyResult } from "./ops.js";
export { FixedTimestepLoop, type LoopOptions } from "./loop.js";
export {
  expandScene,
  prefabFromSubtree,
  validatePrefab,
  prefabDocSchema,
  prefabInstanceSchema,
  PrefabError,
  type PrefabDoc,
  type PrefabInstance,
} from "./prefab.js";
export {
  AssetLibrary,
  AssetError,
  registerCoreAssetTypes,
  type DataAssetDoc,
  type ModelAssetDoc,
} from "./assets.js";
export { SceneStore } from "./store.js";
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
  sampleHeightmap,
  heightmapMesh,
  type HeightmapParams,
  type HeightmapMesh,
} from "./terrain.js";
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
  type ChunkDoc,
  type ChunkStreamerData,
} from "./chunks.js";

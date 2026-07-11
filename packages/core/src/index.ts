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
  billboardSchema,
  netObjectSchema,
  type NetObjectData,
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
  subsceneSchema,
  subsceneToSceneDoc,
  type ChunkDoc,
  type ChunkStreamerData,
  type ChunkCell,
  type ChunkMoveResult,
  type SubsceneData,
} from "./chunks.js";
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

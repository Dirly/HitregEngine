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

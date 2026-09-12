export {
  Script,
  type InputLike,
  type ScriptClass,
  type ScriptChat,
  type ScriptChatMessage,
  type ScriptContext,
  type ScriptDataTypeDecl,
  type ScriptEventDecl,
  type ScriptEvents,
  type ScriptNetState,
  type ScriptParamSpec,
  type SimLike,
  // The physics-query surface `SimLike` is expressed in. Call sites usually
  // infer these through `ctx.sim?.…`, but anything storing a hit or building
  // query options as a named value needs them by name.
  type SimCharacterMove,
  type SimCharacterOptions,
  type SimHit,
  type SimOverlapOptions,
  type SimQueryOptions,
  type SimQueryShape,
  type SimRaycastAllOptions,
  type SimRaycastOptions,
  type SimShapecastOptions,
  type AnimationLayerOptions,
  type BiomeAt,
  type LiveSkyOptions,
  type LiveSkyBase,
} from "./script.js";
export { EventBus, type EventHandler, type NetRole, type TraceEntry } from "./events.js";
export { ScriptRegistry, type DataTypeSink } from "./registry.js";
export { InputService } from "./input.js";
export { ScriptRuntime, type RuntimeOptions, type RuntimeVfxFrame, type RuntimeVfxHost, type ScriptChatHost } from "./runtime.js";
export { registerBuiltinScripts } from "./builtin.js";
export {
  actionIsLayered,
  damp,
  fallThreshold,
  fitAction,
  gaitFor,
  gaitSpeed,
  GaitTracker,
  gaitTier,
  groundFollowVy,
  risingByGround,
  idleThreshold,
  leavingGround,
  playbackRate,
  ACTION_RATE_MAX,
  ACTION_RATE_MIN,
  GAIT_HYSTERESIS,
  RATE_MAX,
  RATE_MIN,
  type ActionFit,
  type Gait,
  type GaitTuning,
} from "./locomotion.js";
export { MobBrain } from "./mob-brain.js";
export {
  TerrainSteering,
  groundHeightAt,
  DEFAULT_STEERING,
  GROUND_LAYERS,
  OBSTACLE_LAYERS,
  LAYER_WORLD,
  LAYER_TERRAIN,
  LAYER_PROP,
  type GroundProbeOptions,
  type SteerRequest,
  type SteerResult,
  type SteeringOptions,
  type SteeringSim,
} from "./steering.js";
export {
  Easings,
  easingByName,
  loopProgress,
  pingPongProgress,
  lerp,
  lerpVec3,
  approach,
  approachAngle,
  type EasingName,
  type LoopMode,
} from "./easing.js";

export type { ScriptVfx, ScriptVfxFrame, ScriptVfxHandle, ScriptSpellHandle } from "./script.js";

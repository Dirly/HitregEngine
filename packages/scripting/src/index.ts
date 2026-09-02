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
} from "./script.js";
export { EventBus, type EventHandler, type NetRole, type TraceEntry } from "./events.js";
export { ScriptRegistry, type DataTypeSink } from "./registry.js";
export { InputService } from "./input.js";
export { ScriptRuntime, type RuntimeOptions, type ScriptChatHost } from "./runtime.js";
export { registerBuiltinScripts } from "./builtin.js";
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

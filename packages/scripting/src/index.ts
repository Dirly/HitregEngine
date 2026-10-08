export {
  Script,
  type InputLike,
  type ScriptClass,
  type ScriptChat,
  type ScriptCommandDecl,
  type ScriptChatMessage,
  type ScriptContext,
  type ScriptDataTypeDecl,
  type ScriptEventDecl,
  type ScriptEvents,
  type ScriptNetState,
  type ScriptParamSpec,
  type SimLike,
  type SimRagdollSpec,
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
  type RegionAt,
  type WaterAt,
  type LiveSkyOptions,
  type ModelLook,
  type ModelTables,
  type LivePostFxOptions,
  type LiveSkyBase,
} from "./script.js";
export { EventBus, type EventHandler, type NetRole, type TraceEntry } from "./events.js";
export { ScriptRegistry, type DataTypeSink } from "./registry.js";
export { InputService } from "./input.js";
export { ScriptRuntime, type RuntimeOptions, type RuntimeVfxFrame, type RuntimeVfxHost, type ScriptChatHost } from "./runtime.js";
export { registerBuiltinScripts } from "./builtin.js";
export { CharacterLook } from "./character-look.js";
export {
  RagdollScript,
  RAGDOLL_LIMITS,
  RAGDOLL_PRESETS,
  RAGDOLL_MIN_SEGMENT,
  boneSide,
  planRagdoll,
  planSkinnedRagdoll,
  quatFromY,
  ragdollIgnores,
  ragdollMerges,
  ragdollSpec,
  type RagdollBoneInput,
  type RagdollKick,
  type RagdollPlan,
  type RagdollPlanBody,
  type RagdollPlanOptions,
  type RagdollPosture,
  type RagdollRole,
  type RagdollTuning,
} from "./ragdoll.js";
export { fillItemTip, setSkillDescriber, type SkillDescriber } from "./character-ui.js";
export { NpcScript } from "./npc.js";
export { NpcUi, parseCoins } from "./npc-ui.js";
export { LootUi } from "./loot-ui.js";
export { Nameplates } from "./nameplates.js";
export { QuestLog } from "./quest-log.js";
export { PresenceScript, presentFor } from "./presence.js";
export { PlayerRecords } from "./player-records.js";
export { PortalScript } from "./portal.js";
export { EncounterWavesScript, WaveTracker, npcSpawnEventSchema, npcDespawnEventSchema, type WaveDef, type WaveTrackerConfig } from "./encounter-waves.js";
export {
  actionIsLayered,
  damp,
  fallThreshold,
  fitAction,
  gaitFor,
  gaitReadingSpeed,
  gaitSpeed,
  GaitTracker,
  gaitTier,
  groundFollowVy,
  risingByGround,
  readGround,
  probeLeaving,
  airGravityScale,
  extraGravityDv,
  airSteer,
  jumpArc,
  STANDARD_GRAVITY,
  AIR_RESPONSE,
  UPHILL_RATIO,
  STEP_RATE_MAX,
  type GroundCast,
  type GroundReading,
  type JumpTuning,
  idleThreshold,
  leavingGround,
  playbackRate,
  swimAim,
  swimStateFor,
  swimVy,
  swimming,
  ACTION_RATE_MAX,
  ACTION_RATE_MIN,
  GAIT_HYSTERESIS,
  RATE_MAX,
  RATE_MIN,
  type ActionFit,
  type Gait,
  type GaitTuning,
  type SwimAim,
  type SwimState,
  type SwimTuning,
} from "./locomotion.js";
export { MobBrain, nearestOnRoute } from "./mob-brain.js";
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

export type { ScriptVfx, ScriptVfxFrame, ScriptVfxHandle, ScriptSpellHandle, ScriptShotHandle } from "./script.js";
export { footfallsCrossed, FootfallTracker, type FootfallStep } from "./footfalls.js";
export {
  advanceBetween,
  advanceVelocity,
  isClipAdvance,
  peakAdvanceSpeed,
  sampleAdvance,
  type AdvanceStep,
  type ClipAdvance,
} from "./advance.js";
export { carryPhaseOffset, stanceCarryFor, type StanceCarry } from "./stance-carry.js";
export { inHours, SettleLatch, SoundEmitter, Soundscape, SoundZone, worldClock } from "./soundscape.js";
export { AmbientParticles, layerStrength, normalizeLayer, timeWeight, type AmbientLayer, type AmbientSample } from "./ambient-particles.js";

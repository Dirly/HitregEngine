import type { ComponentRegistry } from "./components/registry.js";
import type { AssetLibrary } from "./assets.js";
import type { EventRegistry } from "./events.js";
import type { NetStateStore } from "./net-state.js";
import { OP_SPECS } from "./ops.js";

/**
 * The engine's self-describing capability spec: a single machine-readable
 * manifest of everything an AI can build with, derived from the SAME Zod
 * schemas that validate mutations at runtime. Because it is generated, it
 * cannot drift from behavior the way a hand-written reference does — add a
 * component field and it appears here the next time the spec is emitted.
 *
 * Two consumers:
 *  - a committed `spec.json` (see examples/write-spec.ts) so schema changes show
 *    up as a reviewable diff — drift becomes visible instead of silent;
 *  - the live `/__hitreg/spec` dev endpoint, which serves the running app's full
 *    surface (including app-registered scripts, events, and current prefabs).
 *
 * This assembles only the parts owned by @hitreg/core's registries. Environment
 * facts — the dev bridge's HTTP endpoints, on-disk asset inventory — are the
 * caller's to attach; they don't belong to the schema surface.
 */
export interface EngineSpecInputs {
  registry: ComponentRegistry;
  assets?: AssetLibrary;
  events?: EventRegistry;
  netState?: NetStateStore;
  /**
   * Behavior specs — @hitreg/scripting's `ScriptRegistry.describe()`. Passed in
   * rather than imported so core stays free of the scripting layer.
   */
  scripts?: Record<string, unknown>;
  /** Spec-shape version, so a consumer can detect format changes. */
  version?: string;
}

export interface EngineSpec {
  version: string;
  /** The mutation protocol: every scene change is one of these ops. */
  ops: typeof OP_SPECS;
  /** component name -> JSON Schema of its data (what you can put on an entity). */
  components: Record<string, unknown>;
  /** data-asset type -> JSON Schema (materials, spritesheets, terrain, …). */
  dataAssets: Record<string, unknown>;
  /** gameplay event name -> JSON Schema of its payload. */
  events: Record<string, unknown>;
  /** replicated net-state namespace -> JSON Schema. */
  netState: Record<string, unknown>;
  /** behavior name -> its param specs (attachable via the `script` component). */
  scripts: Record<string, unknown>;
  /** prefab asset ids currently registered. */
  prefabs: string[];
}

/** Current spec shape version — bump on a breaking change to EngineSpec. */
export const ENGINE_SPEC_VERSION = "1";

/** Assemble the engine capability spec from the live registries (pure). */
export function buildEngineSpec(inputs: EngineSpecInputs): EngineSpec {
  return {
    version: inputs.version ?? ENGINE_SPEC_VERSION,
    ops: OP_SPECS,
    components: inputs.registry.jsonSchemas(),
    dataAssets: inputs.assets?.dataTypeJsonSchemas() ?? {},
    events: inputs.events?.jsonSchemas() ?? {},
    netState: inputs.netState?.jsonSchemas() ?? {},
    scripts: inputs.scripts ?? {},
    prefabs: inputs.assets?.prefabIds() ?? [],
  };
}

import type { EventRegistry } from "@hitreg/core";
import type { ScriptClass, ScriptParamSpec } from "./script.js";

export class ScriptRegistry {
  private classes = new Map<string, ScriptClass>();

  /**
   * `events`, when passed, auto-registers whatever `cls.events` declares —
   * a project-specific script's own request/response contracts (e.g.
   * "npc.hit") register themselves just by being loaded, instead of every
   * project hand-editing the shared app bootstrap to declare them. Already-
   * registered names are skipped rather than re-thrown (a shared event
   * declared by more than one script, or a hot-reloaded re-registration).
   */
  register(cls: ScriptClass, events?: EventRegistry): void {
    if (!cls.scriptName) throw new Error("script class needs a static scriptName");
    if (this.classes.has(cls.scriptName)) {
      throw new Error(`script "${cls.scriptName}" is already registered`);
    }
    this.classes.set(cls.scriptName, cls);
    if (events) {
      for (const decl of cls.events ?? []) {
        if (events.has(decl.name)) continue;
        events.register(decl.name, decl.schema, decl.options);
      }
    }
  }

  get(name: string): ScriptClass | undefined {
    return this.classes.get(name);
  }

  names(): string[] {
    return [...this.classes.keys()];
  }

  paramsOf(name: string): Record<string, ScriptParamSpec> {
    return this.classes.get(name)?.params ?? {};
  }

  defaultParams(name: string): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [key, spec] of Object.entries(this.paramsOf(name))) {
      out[key] = structuredClone(spec.default);
    }
    return out;
  }

  /** Machine-readable spec of every script + params (for AI / inspector). */
  describe(): Record<string, Record<string, ScriptParamSpec>> {
    const out: Record<string, Record<string, ScriptParamSpec>> = {};
    for (const name of this.names()) out[name] = this.paramsOf(name);
    return out;
  }
}

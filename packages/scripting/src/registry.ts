import type { ScriptClass, ScriptParamSpec } from "./script.js";

export class ScriptRegistry {
  private classes = new Map<string, ScriptClass>();

  register(cls: ScriptClass): void {
    if (!cls.scriptName) throw new Error("script class needs a static scriptName");
    if (this.classes.has(cls.scriptName)) {
      throw new Error(`script "${cls.scriptName}" is already registered`);
    }
    this.classes.set(cls.scriptName, cls);
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

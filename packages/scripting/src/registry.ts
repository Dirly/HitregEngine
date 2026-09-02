import type { EventRegistry } from "@hitreg/core";
import type { z } from "zod";
import type { ScriptClass, ScriptParamSpec } from "./script.js";

/**
 * The one method of `AssetLibrary` a data-type declaration needs. Structural
 * on purpose: the registry stays independent of core's asset library (and of a
 * runtime zod dependency), and an `AssetLibrary` satisfies it as-is.
 */
export interface DataTypeSink {
  defineDataType(type: string, schema: z.ZodType): void;
}

export class ScriptRegistry {
  private classes = new Map<string, ScriptClass>();
  /** Data types already pushed into a sink, and which script claimed each. */
  private dataTypeOwners = new Map<string, string>();

  /**
   * Register whatever `cls.dataTypes` declares (see `static dataTypes` on
   * Script) so a project can define its own ScriptableObject type — weapon
   * stats, a loot table, a dialogue tree — by shipping a script, instead of
   * hand-editing the shared app bootstrap. Exactly the pattern `cls.events`
   * already uses, for exactly the same reason: main.ts is generic across every
   * project it serves, so nothing project-specific may live there.
   *
   * DUPLICATE SEMANTICS — the non-obvious part. `defineDataType` throws on a
   * re-definition, and script files re-execute constantly under HMR
   * (project-scripts.ts is the hot boundary), so the naive version throws on
   * every keystroke-save. Here:
   *
   *   - first declaration wins and is remembered with its owning script;
   *   - the SAME script re-declaring the SAME type is a silent no-op — that is
   *     the hot-reload path, and it must stay silent or the console fills with
   *     warnings about nothing;
   *   - a DIFFERENT script claiming a defined type warns and is skipped: two
   *     scripts claiming one type name is the same real bug `register`'s
   *     strict name guard exists to catch, and the second one silently
   *     shadowing the first would be worse than noisy;
   *   - a sink that throws anyway (a project colliding with a core type such
   *     as "material") warns and is skipped, never thrown: one bad declaration
   *     must not stop the rest of that script — or the scripts after it —
   *     from registering.
   *
   * Consequence worth knowing: EDITING a declared schema needs a page reload
   * to take effect. Define-once is `AssetLibrary`'s own design (data assets
   * already validated against the old schema keep their meaning), and telling
   * an edited schema from an identical one would mean re-deriving both as JSON
   * Schema — a runtime zod dependency this package deliberately does not have.
   * Script *logic* still hot-swaps in place; only the schema shape is pinned
   * for the life of the page.
   */
  private declareDataTypes(cls: ScriptClass, sink?: DataTypeSink): void {
    if (!sink) return;
    const name = cls.scriptName;
    for (const decl of cls.dataTypes ?? []) {
      const owner = this.dataTypeOwners.get(decl.type);
      if (owner !== undefined) {
        if (owner !== name) {
          console.warn(
            `[scripts] data type "${decl.type}" is already defined by script "${owner}"; ` +
              `"${name}" declares it too and was ignored — rename one of them.`,
          );
        }
        continue; // same script re-declaring: the hot-reload path, stay quiet
      }
      try {
        sink.defineDataType(decl.type, decl.schema);
        this.dataTypeOwners.set(decl.type, name);
      } catch (error) {
        console.warn(`[scripts] ${name} could not define data type "${decl.type}":`, error);
      }
    }
  }

  /**
   * `events`, when passed, auto-registers whatever `cls.events` declares —
   * a project-specific script's own request/response contracts (e.g.
   * "npc.hit") register themselves just by being loaded, instead of every
   * project hand-editing the shared app bootstrap to declare them. Already-
   * registered names are skipped rather than re-thrown (a shared event
   * declared by more than one script, or a hot-reloaded re-registration).
   *
   * `dataTypes` (any `AssetLibrary`) does the same for whatever
   * `cls.dataTypes` declares — see declareDataTypes for the duplicate rules.
   * Both are optional: every existing call site keeps working unchanged.
   */
  register(cls: ScriptClass, events?: EventRegistry, dataTypes?: DataTypeSink): void {
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
    this.declareDataTypes(cls, dataTypes);
  }

  /**
   * Hot-reload path: replace an already-registered class (or add a new one)
   * instead of throwing on the duplicate name. `register`'s strict guard exists
   * to catch two *different* scripts claiming one name — a real bug — but a
   * file re-executing under HMR legitimately re-registers its own name with
   * fresh code, so that route skips the guard and overwrites. Event decls are
   * added the same way `register` does (already-registered names are skipped),
   * and so are data-type decls — a script that declares a data type is
   * re-registered on every save of its file, which is precisely why
   * declareDataTypes has to be idempotent rather than strict.
   */
  reregister(cls: ScriptClass, events?: EventRegistry, dataTypes?: DataTypeSink): void {
    if (!cls.scriptName) throw new Error("script class needs a static scriptName");
    this.classes.set(cls.scriptName, cls);
    if (events) {
      for (const decl of cls.events ?? []) {
        if (events.has(decl.name)) continue;
        events.register(decl.name, decl.schema, decl.options);
      }
    }
    this.declareDataTypes(cls, dataTypes);
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

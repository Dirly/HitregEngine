/**
 * Project script discovery for a headless host.
 *
 * The playground uses Vite's `import.meta.glob`; here every `scripts/*.ts`
 * under the content roots is imported dynamically (the process runs under
 * `tsx`, which is what makes `.ts` importable). A file that fails to import
 * — a renderer-only script pulling `three/webgpu` into a Node process — is
 * skipped with its name, never fatal: the server needs the GAMEPLAY scripts,
 * and a HUD that cannot load is not a gameplay script.
 *
 * Scripts may also opt out explicitly with `static clientOnly = true`; the
 * runtime then never instantiates them on the server even when they import
 * fine (a telegraph pool that imports cleanly but creates meshes in onStart).
 */

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { AssetLibrary, EventRegistry } from "@hitreg/core";
import type { ScriptClass, ScriptRegistry } from "@hitreg/scripting";

export interface ScriptLoadReport {
  registered: string[];
  skipped: Array<{ file: string; reason: string }>;
}

export async function loadProjectScripts(
  scriptDirs: string[],
  registry: ScriptRegistry,
  events: EventRegistry,
  assets?: AssetLibrary,
): Promise<ScriptLoadReport> {
  const report: ScriptLoadReport = { registered: [], skipped: [] };
  for (const dir of scriptDirs) {
    if (!fs.existsSync(dir)) continue;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".ts") || entry.name.endsWith(".d.ts")) continue;
      const file = path.join(dir, entry.name);
      let mod: { default?: ScriptClass };
      try {
        mod = (await import(pathToFileURL(file).href)) as { default?: ScriptClass };
      } catch (error) {
        report.skipped.push({ file, reason: `import failed: ${error instanceof Error ? error.message : String(error)}` });
        continue;
      }
      const cls = mod.default;
      if (!cls || typeof cls !== "function" || !cls.scriptName) {
        report.skipped.push({ file, reason: "no default Script export" });
        continue;
      }
      try {
        registry.reregister(cls, events, assets as Parameters<ScriptRegistry["reregister"]>[2]);
        report.registered.push(cls.scriptName);
      } catch (error) {
        report.skipped.push({ file, reason: `register failed: ${error instanceof Error ? error.message : String(error)}` });
      }
    }
  }
  return report;
}

/** Does this script class declare itself client-only? */
export function isClientOnlyScript(registry: ScriptRegistry, name: string): boolean {
  const cls = registry.get(name) as (ScriptClass & { clientOnly?: boolean }) | undefined;
  return cls?.clientOnly === true;
}

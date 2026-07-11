/**
 * Emit the engine capability spec to a committed `spec.json` at the repo root.
 * Run with `pnpm spec` (or `pnpm -F @hitreg/core spec`).
 *
 * This captures the STABLE engine surface — the core + chunk component schemas,
 * the built-in data-asset types, the core event schemas, and the ops protocol —
 * from the exact registration functions the runtime uses. Committing the output
 * turns schema drift into a reviewable diff: change a Zod schema and `spec.json`
 * changes with it, so a PR that alters the AI-facing contract shows it plainly.
 *
 * App/demo-specific registrations (extra events, behaviors, prefabs) are NOT
 * here by design — they belong to whatever app composes the engine, and the
 * live `/__hitreg/spec` endpoint serves that fuller, running-app surface.
 */
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  AssetLibrary,
  ComponentRegistry,
  EventRegistry,
  buildEngineSpec,
  registerChunkComponents,
  registerCoreAssetTypes,
  registerCoreComponents,
  registerCoreEvents,
} from "../src/index.js";

const registry = new ComponentRegistry();
registerCoreComponents(registry);
registerChunkComponents(registry);

const events = new EventRegistry();
registerCoreEvents(events);

const assets = new AssetLibrary();
registerCoreAssetTypes(assets);

const spec = buildEngineSpec({ registry, events, assets });
const target = fileURLToPath(new URL("../../../spec.json", import.meta.url));
writeFileSync(target, JSON.stringify(spec, null, 2) + "\n", "utf8");

console.log(
  `wrote ${target}: ${Object.keys(spec.components).length} components, ` +
    `${Object.keys(spec.dataAssets).length} data types, ` +
    `${Object.keys(spec.events).length} events, ${spec.ops.length} ops`,
);

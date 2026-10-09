// A project's dependency closure — the project plus its project.json `dependsOn`, transitively —
// and asset lookups across it. This is the same scoping the editor and server use
// (core `projectDependencyClosure`), so a tool finds an asset wherever the running game would:
// a world's tools see the foundation's items, creation and player prefab without hardcoding
// which project holds them.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const PROJECTS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../projects");

/** Project name from a name or a project directory path. */
const nameOf = (project) => path.basename(path.resolve(PROJECTS, project));

/** The project first, then its dependencies (depth-first, each once). */
export function closure(project) {
  const out = [];
  const visit = (name) => {
    if (out.includes(name)) return;
    out.push(name);
    try {
      const manifest = JSON.parse(fs.readFileSync(path.join(PROJECTS, name, "project.json"), "utf8"));
      for (const dep of manifest.dependsOn ?? []) visit(dep);
    } catch { /* no or invalid manifest: no dependencies */ }
  };
  visit(nameOf(project));
  return out;
}

/** Existing `assets/<kind>` folders across the closure, the project's own first. */
export function assetDirs(project, kind) {
  return closure(project).map((p) => path.join(PROJECTS, p, "assets", kind)).filter((d) => fs.existsSync(d));
}

/** The first existing `assets/<rel>` across the closure, or null. */
export function findAsset(project, rel) {
  for (const p of closure(project)) {
    const f = path.join(PROJECTS, p, "assets", rel);
    if (fs.existsSync(f)) return f;
  }
  return null;
}

/** Like findAsset, but returns the project's own path when nothing exists (for error messages). */
export function assetPath(project, rel) {
  return findAsset(project, rel) ?? path.join(PROJECTS, nameOf(project), "assets", rel);
}

/** Ids (file names without `ext`, top level of the folder) of one asset kind across the closure. */
export function assetIds(project, kind, ext = ".json") {
  const ids = new Set();
  for (const d of assetDirs(project, kind)) for (const f of fs.readdirSync(d)) if (f.endsWith(ext)) ids.add(f.slice(0, -ext.length));
  return ids;
}

/**
 * Where a virtual asset path ("models/props/x.glb") lives on disk, for the dev
 * bridge (vite.config.ts /__hitreg/asset-file, write-asset, tool runs).
 *
 * A request made for a scene resolves inside that scene's project closure
 * first — the owning project, then its project.json `dependsOn` (core
 * `projectDependencyClosure`, the same scoping the server and tools use) — so
 * a same-named file in an unrelated project can never shadow it. Only then
 * does it fall back: the flat assets/ tree, then every other project ordered
 * shared-first (the more projects' closures include it, the earlier) with
 * scratch/lab projects last. An unscoped request uses the same fallback order.
 *
 * Node only (fs). Imported by vite.config.ts and test/asset-resolve.test.ts.
 */
import fs from "node:fs";
import path from "node:path";
import {
  projectDependencyClosure,
  projectManifestSchema,
  type ProjectManifest,
} from "../../../packages/core/src/project.ts";

export interface AssetRoots {
  /** apps/playground/assets — the flat (throwaway) tree. */
  assetsRoot: string;
  /** apps/playground/projects */
  projectsRoot: string;
}

const PROJECT_NAME = /^[a-z0-9][a-z0-9_-]*$/i;

export function readProjectManifest(projectsRoot: string, name: string): ProjectManifest | null {
  try {
    const parsed = projectManifestSchema.safeParse(
      JSON.parse(fs.readFileSync(path.join(projectsRoot, name, "project.json"), "utf8")),
    );
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** Project folders under projectsRoot, in directory order. */
export function projectNames(projectsRoot: string): string[] {
  if (!fs.existsSync(projectsRoot)) return [];
  return fs
    .readdirSync(projectsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
}

/** The project and its `dependsOn`, transitively (own first); null for an unknown project. */
export function projectClosure(projectsRoot: string, project: string): string[] | null {
  if (!PROJECT_NAME.test(project) || !fs.existsSync(path.join(projectsRoot, project))) return null;
  return projectDependencyClosure(project, (name) => readProjectManifest(projectsRoot, name));
}

/** The project owning scenes/<scene>.scene.json, or null (flat-tree or unknown scene). */
export function sceneOwnerProject(projectsRoot: string, scene: string): string | null {
  if (!/^[a-z0-9][a-z0-9/_-]*$/i.test(scene)) return null;
  return (
    projectNames(projectsRoot).find((name) =>
      fs.existsSync(path.join(projectsRoot, name, "assets", "scenes", `${scene}.scene.json`)),
    ) ?? null
  );
}

/**
 * A scratch preview, not real content: a folder named *-lab / *-proof /
 * *-scratch, or a manifest whose title or description says "scratch". These
 * carry stale copies of real assets, so they never win a fallback.
 */
export function isScratchProject(name: string, manifest: Pick<ProjectManifest, "title" | "description"> | null): boolean {
  if (/-(lab|proof|scratch)$/i.test(name)) return true;
  return /\bscratch\b/i.test(`${manifest?.title ?? ""} ${manifest?.description ?? ""}`);
}

/**
 * Every project in fallback order: real before scratch, then shared before
 * leaf (how many projects' closures include it — a lab that copied a world's
 * file depends on that world, so the world ranks higher), then by name.
 */
export function fallbackProjectOrder(projectsRoot: string): string[] {
  const names = projectNames(projectsRoot);
  const manifests = new Map(names.map((name) => [name, readProjectManifest(projectsRoot, name)]));
  const sharedBy = new Map(names.map((name) => [name, 0]));
  for (const name of names) {
    for (const dep of projectDependencyClosure(name, (n) => manifests.get(n) ?? null)) {
      if (sharedBy.has(dep)) sharedBy.set(dep, sharedBy.get(dep)! + 1);
    }
  }
  const scratch = (name: string) => (isScratchProject(name, manifests.get(name) ?? null) ? 1 : 0);
  return [...names].sort(
    (a, b) => scratch(a) - scratch(b) || sharedBy.get(b)! - sharedBy.get(a)! || a.localeCompare(b),
  );
}

/**
 * The file a virtual asset path names. `scope` is the requesting scene's
 * project closure (projectClosure), or null when the request is unscoped.
 * An existing file resolves closure → flat tree → other projects
 * (fallbackProjectOrder). A NEW file (nowhere yet) goes beside its siblings:
 * into the one project that already has its folder, else the flat tree.
 */
export function resolveAssetFile(roots: AssetRoots, file: string, scope: readonly string[] | null): string {
  const { assetsRoot, projectsRoot } = roots;
  const inProject = (name: string) => path.resolve(projectsRoot, name, "assets", file);
  for (const name of scope ?? []) {
    const candidate = inProject(name);
    if (fs.existsSync(candidate)) return candidate;
  }
  const flat = path.resolve(assetsRoot, file);
  if (fs.existsSync(flat)) return flat;
  const projects = fallbackProjectOrder(projectsRoot);
  const tried = new Set(scope ?? []);
  for (const name of projects) {
    if (tried.has(name)) continue;
    const candidate = inProject(name);
    if (fs.existsSync(candidate)) return candidate;
  }
  // A NEW file belongs beside its siblings: if exactly one project already
  // owns that folder, write there. Without this, creating an asset from the
  // editor drops it in the flat tree — which is for throwaway experiments, so
  // a project's first new scene or material silently landed outside the
  // project and outside its git repo.
  const dir = path.dirname(file);
  if (dir && dir !== "." && dir !== path.sep) {
    const owners = projects.filter((name) => fs.existsSync(path.resolve(projectsRoot, name, "assets", dir)));
    if (owners.length === 1) return inProject(owners[0]!);
  }
  return flat;
}

/**
 * Same-path asset files in more than one project, with the winner an unscoped
 * request now gets — for auditing shadowing (lab copies, real duplicates).
 */
export function duplicateAssets(projectsRoot: string): { file: string; projects: string[]; fallbackWinner: string }[] {
  const order = fallbackProjectOrder(projectsRoot);
  const owners = new Map<string, string[]>();
  for (const name of projectNames(projectsRoot)) {
    const base = path.join(projectsRoot, name, "assets");
    const walk = (dir: string) => {
      if (!fs.existsSync(dir)) return;
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else {
          const rel = path.relative(base, full).split(path.sep).join("/");
          owners.set(rel, [...(owners.get(rel) ?? []), name]);
        }
      }
    };
    walk(base);
  }
  return [...owners]
    .filter(([, list]) => list.length > 1)
    .map(([file, list]) => ({ file, projects: list, fallbackWinner: order.find((p) => list.includes(p))! }))
    .sort((a, b) => a.file.localeCompare(b.file));
}

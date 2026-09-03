/**
 * Project content, read straight off disk.
 *
 * Mirrors what the playground's dev server does for the browser
 * (`/__hitreg/assets-index` + `asset-loader.ts`): every `<root>/assets/<kind>/`
 * tree merges into ONE id namespace, world recipes register into the voxel
 * world registry, and one bad file is skipped with its name rather than
 * aborting the whole load. The server needs no models/textures/audio to
 * SIMULATE — they are registered by id anyway so `assetExists` checks (scatter
 * rules, POIs) answer the same way they do in the browser, which keeps the
 * generated cells identical on both sides.
 */

import fs from "node:fs";
import path from "node:path";
import {
  AssetLibrary,
  registerCoreAssetTypes,
  registerVoxelWorld,
  sceneDocSchema,
  type SceneDoc,
} from "@hitreg/core";

export const ASSET_KINDS = [
  "scenes",
  "prefabs",
  "materials",
  "terrain",
  "spritesheets",
  "worlds",
  "models",
  "textures",
  "audio",
  "chunks",
] as const;

export interface LoadedContent {
  assets: AssetLibrary;
  /** Scene name -> parsed scene doc (validated). */
  scenes: Map<string, SceneDoc>;
  /** Scene name -> the file it came from. */
  sceneFiles: Map<string, string>;
  /** World recipe ids that registered. */
  worlds: string[];
  /** Every `<root>/scripts/` folder found, in root order. */
  scriptDirs: string[];
  warnings: string[];
}

function walk(dir: string, base: string, out: string[]): void {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, base, out);
    else out.push(path.relative(base, full).split(path.sep).join("/"));
  }
}

/**
 * Load every asset under the given roots. A root is a project folder
 * (`apps/playground/projects/<name>`) or the flat playground (`apps/playground`)
 * — anything with an `assets/` (and optionally `scripts/`) child.
 */
export function loadContent(roots: string[], assets = new AssetLibrary()): LoadedContent {
  const warnings: string[] = [];
  const warn = (message: string): void => {
    warnings.push(message);
    console.warn(`[server:assets] ${message}`);
  };
  const scenes = new Map<string, SceneDoc>();
  const sceneFiles = new Map<string, string>();
  const worlds: string[] = [];
  const scriptDirs: string[] = [];
  // data types must exist before data assets validate against them
  try {
    registerCoreAssetTypes(assets);
  } catch {
    // already registered on a shared library — fine
  }

  const readJson = (file: string): unknown => JSON.parse(fs.readFileSync(file, "utf8"));
  const addOrWarn = (label: string, add: () => void): void => {
    try {
      add();
    } catch (error) {
      warn(`skipped ${label}: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  for (const root of roots) {
    const assetsRoot = path.join(root, "assets");
    const scriptsDir = path.join(root, "scripts");
    if (fs.existsSync(scriptsDir)) scriptDirs.push(scriptsDir);
    if (!fs.existsSync(assetsRoot)) continue;
    const files: Record<string, string[]> = {};
    for (const kind of ASSET_KINDS) {
      files[kind] = [];
      walk(path.join(assetsRoot, kind), path.join(assetsRoot, kind), files[kind]);
    }
    const fileOf = (kind: string, rel: string) => path.join(assetsRoot, kind, rel);

    for (const file of files["prefabs"] ?? []) {
      if (!file.endsWith(".json")) continue;
      addOrWarn(`prefabs/${file}`, () => assets.addPrefab(file.replace(/\.json$/, ""), readJson(fileOf("prefabs", file))));
    }
    const dataKinds: Array<[string, string]> = [
      ["materials", "material"],
      ["terrain", "terrain-heightfield"],
      ["spritesheets", "spritesheet"],
    ];
    for (const [kind, type] of dataKinds) {
      for (const file of files[kind] ?? []) {
        if (!file.endsWith(".json")) continue;
        const id = file.replace(/\.json$/, "");
        addOrWarn(`${kind}/${file}`, () =>
          assets.addDataAsset({ id, type, name: id, data: readJson(fileOf(kind, file)) }),
        );
      }
    }
    for (const file of files["worlds"] ?? []) {
      if (!file.endsWith(".json")) continue;
      const id = file.replace(/\.json$/, "");
      addOrWarn(`worlds/${file}`, () => {
        registerVoxelWorld(id, readJson(fileOf("worlds", file)));
        worlds.push(id);
      });
    }
    // binary assets register by id only — the server never loads their bytes
    for (const file of files["models"] ?? []) {
      if (!/\.(glb|gltf)$/.test(file)) continue;
      addOrWarn(`models/${file}`, () => assets.addModel({ id: file, name: path.basename(file), url: fileOf("models", file) }));
    }
    for (const file of files["textures"] ?? []) {
      if (!/\.(png|jpe?g|webp)$/i.test(file)) continue;
      addOrWarn(`textures/${file}`, () => assets.addTexture({ id: file, name: path.basename(file), url: fileOf("textures", file) }));
    }
    for (const file of files["audio"] ?? []) {
      if (!/\.(wav|mp3|ogg)$/i.test(file)) continue;
      addOrWarn(`audio/${file}`, () => assets.addSound({ id: file, name: path.basename(file), url: fileOf("audio", file) }));
    }
    for (const file of files["scenes"] ?? []) {
      if (!file.endsWith(".scene.json")) continue;
      const full = fileOf("scenes", file);
      try {
        const parsed = sceneDocSchema.safeParse(readJson(full));
        if (!parsed.success) {
          warn(`scene ${file} is invalid: ${JSON.stringify(parsed.error.issues.slice(0, 3))}`);
          continue;
        }
        const name = file.replace(/\.scene\.json$/, "").split("/").pop()!;
        if (scenes.has(name)) warn(`scene name "${name}" appears twice; keeping the first`);
        else {
          scenes.set(name, parsed.data);
          sceneFiles.set(name, full);
        }
      } catch (error) {
        warn(`scene ${file} unreadable: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }
  return { assets, scenes, sceneFiles, worlds, scriptDirs, warnings };
}

/**
 * Resolve the content roots for a playground checkout: every
 * `projects/<name>/` that has an `assets/` folder, plus the flat playground
 * tree itself (throwaway experiments live there). Order matters only for
 * duplicate ids (first wins), same as the dev server.
 */
export function playgroundRoots(playgroundDir: string): string[] {
  const roots: string[] = [];
  const projectsDir = path.join(playgroundDir, "projects");
  if (fs.existsSync(projectsDir)) {
    for (const entry of fs.readdirSync(projectsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const dir = path.join(projectsDir, entry.name);
      if (fs.existsSync(path.join(dir, "assets"))) roots.push(dir);
    }
  }
  if (fs.existsSync(path.join(playgroundDir, "assets"))) roots.push(playgroundDir);
  return roots;
}

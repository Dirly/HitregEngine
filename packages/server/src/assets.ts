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
  projectDependencyClosure,
  projectManifestSchema,
  registerCoreAssetTypes,
  registerVoxelRecipeLoader,
  sceneDocSchema,
  type SceneDoc,
} from "@hitreg/core";

export const ASSET_KINDS = [
  "scenes",
  "prefabs",
  "materials",
  "terrain",
  "spritesheets",
  "items",
  "progression",
  "creation",
  "quests",
  "dialogues",
  "shops",
  "places",
  "perform-actions",
  "worlds",
  "models",
  "textures",
  "audio",
  "chunks",
] as const;

export interface LoadedContent {
  assets: AssetLibrary;
  /**
   * Scene name -> parsed scene doc (validated). Read and parsed on first
   * `get`: a server hosts one scene, and parsing every scene of every
   * project (tens of MB of JSON) held hundreds of MB it never used. An
   * invalid scene warns on that first `get` and reads as absent.
   */
  scenes: ReadonlyMap<string, SceneDoc>;
  /** Scene name -> the file it came from. */
  sceneFiles: Map<string, string>;
  /** World recipe ids that registered. */
  worlds: string[];
  /** World recipe id -> the file it was read from (terraform writes back here). */
  worldFiles: Map<string, string>;
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
  const scenes = new LazyScenes(warn);
  const sceneFiles = new Map<string, string>();
  const worlds: string[] = [];
  const worldFiles = new Map<string, string>();
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
      // the character scripts read these on the authority, which is here
      ["items", "item"],
      ["progression", "progression"],
      ["creation", "creation"],
      // townsfolk: the npc builtin decides conversations, trades and quests here
      ["quests", "quest"],
      ["dialogues", "dialogue"],
      ["shops", "shop"],
      ["places", "places"],
      // a project's extra /dance-style perform actions (the quest-log's `performActions`)
      ["perform-actions", "performActions"],
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
        // read, parsed and built only when the terrain host first asks for it
        // (getVoxelWorld): a server streams one world of the many a checkout holds
        const full = fileOf("worlds", file);
        registerVoxelRecipeLoader(id, () => readJson(full));
        worlds.push(id);
        worldFiles.set(id, fileOf("worlds", file));
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
      const name = file.replace(/\.scene\.json$/, "").split("/").pop()!;
      if (sceneFiles.has(name)) warn(`scene name "${name}" appears twice; keeping the first`);
      else {
        sceneFiles.set(name, full);
        scenes.add(name, full, file);
      }
    }
  }
  return { assets, scenes, sceneFiles, worlds, worldFiles, scriptDirs, warnings };
}

/** Scene docs by name, read off disk and validated when first asked for (see LoadedContent.scenes). */
class LazyScenes implements ReadonlyMap<string, SceneDoc> {
  private readonly files = new Map<string, { full: string; rel: string }>();
  private readonly parsed = new Map<string, SceneDoc | null>();
  constructor(private readonly warn: (message: string) => void) {}

  add(name: string, full: string, rel: string): void {
    this.files.set(name, { full, rel });
  }

  get(name: string): SceneDoc | undefined {
    const done = this.parsed.get(name);
    if (done !== undefined) return done ?? undefined;
    const file = this.files.get(name);
    if (!file) return undefined;
    let doc: SceneDoc | null = null;
    try {
      const parsed = sceneDocSchema.safeParse(JSON.parse(fs.readFileSync(file.full, "utf8")));
      if (parsed.success) doc = parsed.data;
      else this.warn(`scene ${file.rel} is invalid: ${JSON.stringify(parsed.error.issues.slice(0, 3))}`);
    } catch (error) {
      this.warn(`scene ${file.rel} unreadable: ${error instanceof Error ? error.message : String(error)}`);
    }
    this.parsed.set(name, doc);
    return doc ?? undefined;
  }

  has(name: string): boolean {
    return this.get(name) !== undefined;
  }

  get size(): number {
    return this.files.size;
  }

  keys(): MapIterator<string> {
    return this.files.keys();
  }

  *entries(): MapIterator<[string, SceneDoc]> {
    for (const name of this.files.keys()) {
      const doc = this.get(name);
      if (doc) yield [name, doc];
    }
  }

  *values(): MapIterator<SceneDoc> {
    for (const [, doc] of this.entries()) yield doc;
  }

  forEach(cb: (value: SceneDoc, key: string, map: ReadonlyMap<string, SceneDoc>) => void): void {
    for (const [name, doc] of this.entries()) cb(doc, name, this);
  }

  [Symbol.iterator](): MapIterator<[string, SceneDoc]> {
    return this.entries();
  }
}

/**
 * The projects a scene needs: the one owning `scenes/<scene>.scene.json` plus
 * its project.json `dependsOn`, transitively — the same scope the dev bridge
 * boots the editor with. null when no project owns the scene (load everything).
 */
function projectScopeOf(projectsDir: string, scene: string): string[] | null {
  if (!fs.existsSync(projectsDir)) return null;
  const owner = fs
    .readdirSync(projectsDir, { withFileTypes: true })
    .find((entry) => entry.isDirectory() && fs.existsSync(path.join(projectsDir, entry.name, "assets", "scenes", `${scene}.scene.json`)));
  if (!owner) return null;
  return projectDependencyClosure(owner.name, (name) => {
    try {
      const parsed = projectManifestSchema.safeParse(JSON.parse(fs.readFileSync(path.join(projectsDir, name, "project.json"), "utf8")));
      return parsed.success ? parsed.data : null;
    } catch {
      return null;
    }
  });
}

/**
 * Resolve the content roots for a playground checkout: every
 * `projects/<name>/` that has an `assets/` folder, plus the flat playground
 * tree itself (throwaway experiments live there). Order matters only for
 * duplicate ids (first wins), same as the dev server. With `scene`, only the
 * project owning it and its `dependsOn` closure load — a server hosting
 * proving never parses an unrelated project's prefabs.
 */
export function playgroundRoots(playgroundDir: string, scene?: string): string[] {
  const roots: string[] = [];
  const projectsDir = path.join(playgroundDir, "projects");
  const scope = scene ? projectScopeOf(projectsDir, scene) : null;
  if (fs.existsSync(projectsDir)) {
    for (const entry of fs.readdirSync(projectsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      if (scope && !scope.includes(entry.name)) continue;
      const dir = path.join(projectsDir, entry.name);
      if (fs.existsSync(path.join(dir, "assets"))) roots.push(dir);
    }
  }
  if (fs.existsSync(path.join(playgroundDir, "assets"))) roots.push(playgroundDir);
  return roots;
}

import { assetFileUrl, setAssetScopeOwner } from "./asset-url.js";
import { type AssetLibrary } from "@hitreg/core";
import { loadVolumes, loadWorldRecipes } from "./voxel-world.js";
import { batchedAssetReader } from "./asset-reads.js";
import { subscribeAssetScope } from "./asset-changes.js";
import { applyBinaryAssetIndex, binaryAssetIndex, flushBinaryAssetIndex, type BinaryAssetChanges } from "./binary-assets.js";
export type { BinaryAssetChanges } from "./binary-assets.js";
export const flushBinaryAssets = flushBinaryAssetIndex;

export async function refreshBinaryAssets(assets: AssetLibrary, preferredScene: string, options: { stage: boolean | (() => boolean) }): Promise<BinaryAssetChanges> {
  const response = await fetch(`/__hitreg/assets-index?scene=${encodeURIComponent(preferredScene)}&kinds=models,textures&revisions=1`, { cache: "no-store" });
  if (!response.ok) throw new Error(`Asset index refresh failed: ${response.status}`);
  const snapshot = binaryAssetIndex(await response.json());
  return applyBinaryAssetIndex(assets, snapshot, { stage: typeof options.stage === "function" ? options.stage() : options.stage });
}

/**
 * assets/ is the project content folder. In dev everything is fetched FRESH
 * from disk through the bridge — vite's module cache must never serve assets
 * (its watcher ignores assets/, so cached imports go stale across reloads).
 * Returns the freshest scene doc content found, if any. When `preferredScene`
 * (a base name, no extension) matches a scene in the index, that one loads
 * instead of the first — used to reopen the last scene the user was editing.
 * `id` is the scene file it came from, which is the scene's identity (saves
 * go back to that file whatever the doc calls itself).
 */
/**
 * Projects whose assets this page loaded (the preferred scene's project plus
 * its project.json `dependsOn`), or null when everything was loaded. A scene
 * outside this set needs a page load, not an in-place switch: its assets were
 * never registered.
 */
let projectScope: ReadonlySet<string> | null = null;
export const loadedProjectScope = (): ReadonlySet<string> | null => projectScope;

export async function loadAssets(
  assets: AssetLibrary,
  preferredScene?: string | null,
): Promise<{ id: string; content: string } | null> {
  const response = await fetch(
    `/__hitreg/assets-index?revisions=1${preferredScene ? `&scene=${encodeURIComponent(preferredScene)}` : ""}`,
  );
  const scopeHeader = response.headers.get("x-hitreg-scope");
  projectScope = scopeHeader && scopeHeader !== "*" ? new Set(scopeHeader.split(",")) : null;
  subscribeAssetScope(projectScope);
  // the header lists the owning project first; every later read resolves in its closure
  setAssetScopeOwner(projectScope ? scopeHeader!.split(",")[0]! : null);
  if (projectScope) console.info(`[assets] loading projects: ${[...projectScope].join(", ")}`);
  const snapshot = binaryAssetIndex(await response.json()), index = snapshot.index;
  const fileUrl = (kind: string, file: string) => assetFileUrl(`${kind}/${file}`);
  // A merged project library can contain thousands of prefabs. Starting all
  // fetches together exhausts browser request resources and silently drops
  // later kinds (including materials). Share one bounded queue across kinds.
  const readJson = batchedAssetReader();

  const scenes = (index["scenes"] ?? []).filter((f) => f.endsWith(".scene.json"));
  const sceneFile =
    (preferredScene && scenes.find((f) => f === `${preferredScene}.scene.json`)) ||
    scenes[0];
  const sceneContent = sceneFile
    ? fetch(fileUrl("scenes", sceneFile)).then((r) => r.text())
    : Promise.resolve(null);
  // These registries have no dependency on the asset library. Queue them first
  // in its SAME bounded reader, so their parse/validation and the scene fetch
  // overlap the large prefab queue instead of adding serial stages at its end.
  // Redstrand's startup trace recorded about half a second in that serial tail.
  const worlds = loadWorldRecipes(index, readJson);
  const volumes = loadVolumes(index, readJson);

  // Every JSON asset fetch is independent, so issue them all at once instead of
  // one blocking round-trip at a time — on a large project this is the
  // difference between a serial stall and a single parallel burst at boot (and
  // on every unavoidable reload). Registration order within a kind is
  // irrelevant (each keys by id), so await the whole batch, then add.
  const jsonKinds: { kind: string; type?: string; onlyJson?: boolean }[] = [
    { kind: "prefabs", onlyJson: true },
    { kind: "materials", type: "material", onlyJson: true },
    { kind: "terrain", type: "terrain-heightfield", onlyJson: true },
    { kind: "spritesheets", type: "spritesheet", onlyJson: true },
    { kind: "vfx", type: "vfx", onlyJson: true },
    { kind: "spells", type: "spell", onlyJson: true },
    // character progression: item definitions and the levelling rules
    { kind: "items", type: "item", onlyJson: true },
    { kind: "progression", type: "progression", onlyJson: true },
    // character creation: archetypes, birth traits, appearance slots
    { kind: "creation", type: "creation", onlyJson: true },
    // townsfolk: quests, what NPCs say, what shops sell
    { kind: "quests", type: "quest", onlyJson: true },
    { kind: "dialogues", type: "dialogue", onlyJson: true },
    { kind: "shops", type: "shop", onlyJson: true },
    { kind: "places", type: "places", onlyJson: true },
    // a project's extra perform actions (/dance-style), read by the quest-log
    { kind: "perform-actions", type: "performActions", onlyJson: true },
  ];
  const library = Promise.all(
    jsonKinds.map(async ({ kind, type, onlyJson }) => {
      const files = (index[kind] ?? []).filter((f) => !onlyJson || f.endsWith(".json"));
      // One bad file must never take the scene with it. Before this guard a
      // single data asset that failed its schema threw out of loadAssets,
      // main.ts caught it as "fresh load failed" and seeded a BLANK starter
      // scene in place of the one being edited — which reads as the whole
      // world having vanished. Skip the file, say so, keep loading.
      const loaded = await Promise.all(
        files.map(async (file) => {
          const id = file.replace(/\.json$/, "");
          try {
            return { id, data: await readJson(kind, file) };
          } catch (error) {
            console.warn(`[assets] skipped ${kind}/${file}: unreadable JSON —`, error);
            return null;
          }
        }),
      );
      for (const entry of loaded) {
        if (!entry) continue;
        const { id, data } = entry;
        try {
          if (type) assets.addDataAsset({ id, type, name: id, data });
          else assets.addPrefab(id, data);
        } catch (error) {
          console.warn(`[assets] skipped ${kind}/${id}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    }),
  );

  // Return only once every library asset and both registries are available:
  // scene switching, editor browsing and dynamic spawns still see the full scope.
  const [content] = await Promise.all([sceneContent, worlds, volumes, library]);

  // Every project's assets/ merges into ONE id namespace, so two projects that
  // both ship "textures/mmo/Grass.png" collide. That must not be fatal: the
  // add* calls throw on a duplicate id, and an uncaught throw here aborts the
  // WHOLE asset load — leaving the app on its starter scene with nothing to
  // suggest a name clash caused it. Skip the loser, name it, carry on; the same
  // diagnosed-not-crashed contract the data-asset loop above already uses.
  const addOrWarn = (kind: string, id: string, add: () => void): void => {
    try {
      add();
    } catch (error) {
      const why = error instanceof Error ? error.message : String(error);
      console.warn(
        `[assets] skipped ${kind}/${id}: ${why} — asset ids are shared across ALL ` +
          "projects; give one of them its own folder",
      );
    }
  };

  applyBinaryAssetIndex(assets, snapshot, { seed: true });
  for (const file of index["audio"] ?? []) {
    if (!/.(wav|mp3|ogg)$/i.test(file)) continue;
    addOrWarn("audio", file, () =>
      assets.addSound({ id: file, name: file.split("/").pop()!, url: fileUrl("audio", file) }),
    );
  }

  if (!sceneFile || content === null) return null;
  return { id: sceneFile.replace(/\.scene\.json$/, ""), content };
}

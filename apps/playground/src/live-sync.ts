import {
  diffSceneDocs,
  rebaseSceneEdits,
  sceneDocSchema,
  type SceneDoc,
  validateScene,
  type AssetLibrary,
  type ComponentRegistry,
  type SceneStore,
} from "@hitreg/core";
import type { EditingPrefab, Observable, Selection } from "@hitreg/editor";
import type { ChunkManager } from "./chunk-manager.js";
import type { SubsceneManager } from "./subscene-manager.js";
import { applyWorldRecipeEdit } from "./voxel-world.js";
import { loadedProjectScope, refreshBinaryAssets, flushBinaryAssets, type BinaryAssetChanges } from "./asset-loader.js";
import { acceptsAssetChange, coalesceAssetChanges, settleBurst, type AssetChange } from "./asset-changes.js";
import { createDeferredAppearanceAssets } from "./deferred-appearance-assets.js";
import { prepareAssetChanges } from "./prepared-asset-changes.js";

/**
 * A world recipe edit waits until its file has been quiet this long (and at most WORLD_EDIT_MAX_WAIT_MS after the
 * first write): applying one re-streams the whole world, and installers save the recipe several times in a row.
 */
export const WORLD_EDIT_QUIET_MS = 6000;
export const WORLD_EDIT_MAX_WAIT_MS = 30000;

export interface LiveSyncDeps {
  assets: AssetLibrary;
  registry: ComponentRegistry;
  store: SceneStore;
  selection: Selection;
  sceneList: Observable<string[]>;
  chunkManager: ChunkManager;
  subsceneManager: SubsceneManager;
  editingPrefab: EditingPrefab;
  assetsVersion: Observable<number>;
  /**
   * Try to apply a material-file edit to the live material in place. Returns
   * true if it patched (no rebuild needed), false to fall back to a full
   * rebuild via assetsVersion.
   */
  patchMaterialLive: (id: string, data: unknown) => boolean;
  /** A `vfx` effect asset changed on disk: restart the standing effects playing it. */
  onVfxAssetChanged: (id: string) => void;
  /** URLs have changed: retire the old model/table/material caches before the held scene rebuild. */
  onBinaryAssetsChanged?: (changes: BinaryAssetChanges) => void;
  getLastWrittenScene: () => string;
  setLastWrittenScene: (content: string) => void;
  getLastWrittenPrefab: () => string;
  /**
   * True while the player is playing. A change to the OPEN scene's file that
   * arrives then is held and applied when play stops: applying it mid-play
   * rebuilds the whole scene (a multi-second freeze on a big world) and
   * restarts the session — and agents editing a zone write it constantly.
   */
  isPlaying?: () => boolean;
}

/** Re-apply the scene file change held during play (call when play stops). */
export interface LiveSync {
  flushDeferred(): void;
  /**
   * A save of ours was rebased onto another writer's text (src/scene-save.ts): merge what is now on disk into the
   * open doc exactly like a file change (held while playing; three-way, so edits made since the save survive).
   */
  adoptSceneText(file: string, content: string): void;
}

/**
 * The doc the open scene should become when its file changes on disk: a three-way merge of `incoming` (the file) with
 * the edits this client made since `lastKnown` (the text it last loaded, merged or wrote), so an external write never
 * drops unsaved local edits and a local edit never drops the external write. No usable `lastKnown`: nothing of the
 * file is removed, local additions/changes are kept.
 */
export function mergeIncomingScene(
  open: SceneDoc,
  lastKnown: string,
  incoming: SceneDoc,
  registry: ComponentRegistry,
): { doc: SceneDoc; skipped: number } {
  let base: SceneDoc | null = null;
  if (lastKnown) {
    try {
      const parsed = sceneDocSchema.safeParse(JSON.parse(lastKnown));
      if (parsed.success) base = parsed.data;
    } catch {
      /* unknown base */
    }
  }
  const r = rebaseSceneEdits(base, open, incoming, registry);
  return { doc: r.doc, skipped: r.skipped.length };
}

/** file changes (AI edits, text editors) apply in place. */
export function installLiveSync(deps: LiveSyncDeps): LiveSync {
  const notifyAssetsChanged = coalesceAssetChanges(() => deps.assetsVersion.set(deps.assetsVersion.get() + 1));
  let deferred: { file: string; content: string } | null = null;
  // While playing, asset edits that would REBUILD the scene (prefabs, terrain, spritesheets, materials that cannot
  // patch in place) or RE-STREAM the world (recipes) are held like the scene file is: each one was a multi-second
  // freeze mid-play, and installers write dozens of them (p-perf 2026-11-02). The library itself updates at once.
  let rebuildHeld = false;
  const heldWorlds = new Map<string, string>();
  const playing = (): boolean => deps.isPlaying?.() === true;
  const requestRebuild = (): void => {
    if (playing()) {
      if (!rebuildHeld) console.info("[live-sync] assets changed on disk while playing — rebuilding when play stops");
      rebuildHeld = true;
      return;
    }
    notifyAssetsChanged();
  };
  const appearanceAssets = createDeferredAppearanceAssets({
    read: (id) => deps.assets.getDataAsset(id),
    write: (asset) => {
      if (deps.assets.getDataAsset(asset.id)) deps.assets.updateDataAsset(asset);
      else deps.assets.addDataAsset(asset);
    },
    playing,
    invalidate: requestRebuild,
  });
  const binaryChanges = (changes: BinaryAssetChanges): void => {
    if (!changes.models.length && !changes.textures.length) return;
    deps.onBinaryAssetsChanged?.(changes);
    requestRebuild();
  };
  const applyWorld = (id: string, content: string): void => {
    if (applyWorldRecipeEdit(id, content)) {
      deps.chunkManager.reloadAll();
      notifyAssetsChanged();
    }
  };
  const worldBursts = new Map<string, ReturnType<typeof settleBurst<string>>>();
  const worldEdit = (id: string, content: string): void => {
    if (playing()) {
      if (!heldWorlds.has(id)) console.info(`[live-sync] world recipe "${id}" changed on disk while playing — re-streaming when play stops`);
      heldWorlds.set(id, content);
      return;
    }
    let burst = worldBursts.get(id);
    if (!burst) worldBursts.set(id, (burst = settleBurst<string>((c) => applyWorld(id, c), WORLD_EDIT_QUIET_MS, WORLD_EDIT_MAX_WAIT_MS)));
    burst.push(content);
  };
  let flushPrepared = (): Promise<void> => Promise.resolve();
  let enqueuePrepared: (change: AssetChange) => void = onChange;
  const sync: LiveSync = {
    flushDeferred() {
      // Also retry a discovery read that failed during a file-save burst.
      // Its JSON still goes through the same binary-before-reference boundary.
      void flushPrepared().catch(error => console.warn("[live-sync] deferred asset preparation failed", error));
      const held = deferred;
      deferred = null;
      // New item model IDs and their creation mounts land together, before a
      // held scene/prefab rebuild can dress characters against the new catalog.
      binaryChanges(flushBinaryAssets(deps.assets));
      appearanceAssets.flush();
      for (const [id, content] of heldWorlds) applyWorld(id, content);
      heldWorlds.clear();
      if (rebuildHeld) {
        rebuildHeld = false;
        notifyAssetsChanged();
      }
      if (held) onChange(held);
    },
    adoptSceneText(file, content) {
      if (import.meta.hot) enqueuePrepared({ file, content } as AssetChange);
    },
  };
  if (!import.meta.hot) return sync;
  const {
    assets,
    registry,
    store,
    selection,
    sceneList,
    chunkManager,
    subsceneManager,
    editingPrefab,
    assetsVersion,
    patchMaterialLive,
    onVfxAssetChanged,
    getLastWrittenScene,
    setLastWrittenScene,
    getLastWrittenPrefab,
  } = deps;
  const prepared = prepareAssetChanges(async () => {
    binaryChanges(await refreshBinaryAssets(deps.assets, deps.store.doc.name, { stage: playing }));
  }, onChange);
  flushPrepared = prepared.flush;
  enqueuePrepared = prepared.push;
  import.meta.hot.on("hitreg:asset-changed", (payload: AssetChange) => {
    if (!acceptsAssetChange(payload, loadedProjectScope())) return;
    if (!payload.content && payload.file.startsWith("scenes/")) onChange(payload);
    else prepared.push(payload);
  });
  return sync;

  function onChange(payload: AssetChange): void {
    if (!acceptsAssetChange(payload, loadedProjectScope())) return;
    {
      const { file, content } = payload;
      if (!content) {
        // An out-of-scope scene is discoverable without receiving/parsing its
        // potentially multi-megabyte document in every connected editor.
        if (file.startsWith("scenes/")) {
          const name = file.slice("scenes/".length).replace(/\.scene\.json$/, "");
          if (!sceneList.get().includes(name)) sceneList.set([...sceneList.get(), name].sort());
        }
        return;
      }
      try {
        if (file.startsWith("scenes/")) {
          const name = file.slice("scenes/".length).replace(/\.scene\.json$/, "");
          if (!sceneList.get().includes(name)) {
            sceneList.set([...sceneList.get(), name].sort()); // e.g. an agent made a scene
          }
          if (name !== store.doc.name) {
            // not the scene being edited — but it may be loaded as a subscene
            subsceneManager.onSceneFileChanged(name, content);
            return;
          }
          if (content === getLastWrittenScene()) return; // our own autosave echo
          if (deps.isPlaying?.()) {
            if (!deferred) console.info(`[live-sync] ${name} changed on disk while playing — applying when play stops`);
            deferred = { file, content }; // newest wins
            return;
          }
          // the file is the scene's identity, whatever the doc calls itself
          const doc = { ...sceneDocSchema.parse(JSON.parse(content)), name };
          const issues = validateScene(doc, registry);
          if (issues.length > 0) {
            console.warn("[live-sync] scene file invalid:", issues);
            return;
          }
          // three-way against what we last knew to be on disk: edits made here since then (not saved yet, or a save
          // the server refused as stale) are carried onto the file instead of being reverted by it
          const lastKnown = getLastWrittenScene();
          // set BEFORE applying so the watcher echo of this exact content is
          // suppressed; the autosave of the merged doc may canonicalize the
          // file once (it updates lastWrittenScene itself, so no ping-pong)
          // and, when local edits were kept, writes them with base = this text
          setLastWrittenScene(content);
          if (doc.name !== store.doc.name) {
            // different scene identity: merging is meaningless, take the file
            selection.set(null);
            store.replace(doc);
            return;
          }
          const merged = mergeIncomingScene(store.doc, lastKnown, doc, registry);
          if (merged.skipped > 0) console.warn(`[live-sync] ${name}: ${merged.skipped} local edit(s) no longer fit the file on disk (their entity was removed there)`);
          const ops = diffSceneDocs(store.doc, merged.doc);
          if (ops.length > 0) {
            try {
              // one undo-able batch: non-overlapping concurrent edits merge
              store.apply(ops, "file");
            } catch (error) {
              console.warn("[live-sync] merge failed, falling back to replace:", error);
              store.replace(merged.doc);
            }
            const selected = selection.get();
            if (selected && !(selected in store.doc.entities)) {
              selection.set(null); // only drop selection if the entity vanished
            }
          }
        } else if (file.startsWith("materials/")) {
          const id = file.slice("materials/".length).replace(/\.json$/, "");
          const data = JSON.parse(content);
          const asset = { id, type: "material", name: id, data };
          const previous = assets.getDataAsset(id);
          const isNew = !previous;
          if (isNew) assets.addDataAsset(asset);
          else assets.updateDataAsset(asset);
          if (previous && JSON.stringify(previous.data) === JSON.stringify(assets.getDataAsset(id)!.data)) return;
          // A plain property tweak on an already-instanced material patches the
          // live THREE.Material and refreshes just its swatch — no scene
          // rebuild. Shader-class/texture changes (and brand-new materials not
          // yet in the scene) decline and take the full rebuild below.
          if (isNew || !patchMaterialLive(id, data)) {
            requestRebuild();
          }
        } else if (file.startsWith("terrain/")) {
          const id = file.slice("terrain/".length).replace(/\.json$/, "");
          const asset = { id, type: "terrain-heightfield", name: id, data: JSON.parse(content) };
          const previous = assets.getDataAsset(id);
          if (previous) assets.updateDataAsset(asset);
          else assets.addDataAsset(asset);
          if (!previous || JSON.stringify(previous.data) !== JSON.stringify(assets.getDataAsset(id)!.data)) requestRebuild();
        } else if (file.startsWith("spritesheets/")) {
          const id = file.slice("spritesheets/".length).replace(/\.json$/, "");
          const asset = { id, type: "spritesheet", name: id, data: JSON.parse(content) };
          const previous = assets.getDataAsset(id);
          if (previous) assets.updateDataAsset(asset);
          else assets.addDataAsset(asset);
          if (!previous || JSON.stringify(previous.data) !== JSON.stringify(assets.getDataAsset(id)!.data)) requestRebuild();
        } else if (file.startsWith("prefabs/")) {
          const id = file.slice("prefabs/".length).replace(/\.json$/, "");
          // isolation editing writes this file itself — skip our own echo
          if (id === editingPrefab.get() && content === getLastWrittenPrefab()) return;
          const doc = JSON.parse(content);
          const previous = assets.getPrefab(id);
          if (previous) assets.updatePrefab(id, doc);
          else assets.addPrefab(id, doc);
          if (!previous || JSON.stringify(previous) !== JSON.stringify(assets.getPrefab(id))) requestRebuild();
        } else if (/^(items|progression|creation|quests|dialogues|shops|places)\//.test(file)) {
          // Stats stay live; item appearances and creation mounts wait with
          // structural prefab/scene edits, preserving the running model targets.
          // An invalid file is rejected by the schema and the old values stay.
          const kind = file.slice(0, file.indexOf("/"));
          const type = ({ items: "item", quests: "quest", dialogues: "dialogue", shops: "shop" } as Record<string, string>)[kind] ?? kind;
          const id = file.slice(kind.length + 1).replace(/\.json$/, "");
          const asset = { id, type, name: id, data: JSON.parse(content) };
          if (appearanceAssets.update(asset)) return;
          if (assets.getDataAsset(id)) assets.updateDataAsset(asset);
          else assets.addDataAsset(asset);
        } else if (file.startsWith("vfx/")) {
          // Standing effects (torches, braziers) resolve their asset when they
          // start, so updating the asset and restarting those plays is the whole
          // hot-reload. An invalid file is rejected by the schema, old one stays.
          const id = file.slice("vfx/".length).replace(/\.json$/, "");
          const asset = { id, type: "vfx", name: id, data: JSON.parse(content) };
          if (assets.getDataAsset(id)) assets.updateDataAsset(asset);
          else assets.addDataAsset(asset);
          onVfxAssetChanged(id);
        } else if (file.startsWith("worlds/")) {
          // A world recipe governs EVERY generated cell at once, so there is
          // nothing finer to invalidate: re-register it, drop the cached cell
          // meshes, and re-stream whatever is resident. An invalid edit is
          // rejected and the running world is left exactly as it was, the same
          // rule every other asset watcher here follows.
          const id = file.slice("worlds/".length).replace(/\.json$/, "");
          // settled (a burst of saves applies once, when they stop) and held while playing: see worldEdit
          worldEdit(id, content);
        } else if (file.startsWith("chunks/")) {
          // hot-swap a loaded chunk in place (or pick up a brand-new cell)
          void chunkManager.onFileChanged(file.slice("chunks/".length), content);
        }
      } catch (error) {
        console.warn(`[live-sync] rejected change to ${file}:`, error);
      }
    }
  }
}

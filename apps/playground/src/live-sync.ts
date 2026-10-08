import {
  diffSceneDocs,
  sceneDocSchema,
  validateScene,
  type AssetLibrary,
  type ComponentRegistry,
  type SceneStore,
} from "@hitreg/core";
import type { EditingPrefab, Observable, Selection } from "@hitreg/editor";
import type { ChunkManager } from "./chunk-manager.js";
import type { SubsceneManager } from "./subscene-manager.js";
import { applyWorldRecipeEdit } from "./voxel-world.js";

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
}

/** file changes (AI edits, text editors) apply in place. */
export function installLiveSync(deps: LiveSyncDeps): LiveSync {
  let deferred: { file: string; content: string } | null = null;
  const sync: LiveSync = {
    flushDeferred() {
      const held = deferred;
      deferred = null;
      if (held) onChange(held);
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
  import.meta.hot.on("hitreg:asset-changed", (payload: { file: string; content: string | null }) => onChange(payload));
  return sync;

  function onChange(payload: { file: string; content: string | null }): void {
    {
      const { file, content } = payload;
      if (!content) return;
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
          // set BEFORE applying so the watcher echo of this exact content is
          // suppressed; the autosave of the merged doc may canonicalize the
          // file once (it updates lastWrittenScene itself, so no ping-pong)
          setLastWrittenScene(content);
          if (doc.name !== store.doc.name) {
            // different scene identity: merging is meaningless, take the file
            selection.set(null);
            store.replace(doc);
            return;
          }
          const ops = diffSceneDocs(store.doc, doc);
          if (ops.length > 0) {
            try {
              // one undo-able batch: non-overlapping concurrent edits merge
              store.apply(ops);
            } catch (error) {
              console.warn("[live-sync] merge failed, falling back to replace:", error);
              store.replace(doc);
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
          const isNew = !assets.getDataAsset(id);
          if (isNew) assets.addDataAsset(asset);
          else assets.updateDataAsset(asset);
          // A plain property tweak on an already-instanced material patches the
          // live THREE.Material and refreshes just its swatch — no scene
          // rebuild. Shader-class/texture changes (and brand-new materials not
          // yet in the scene) decline and take the full rebuild below.
          if (isNew || !patchMaterialLive(id, data)) {
            assetsVersion.set(assetsVersion.get() + 1);
          }
        } else if (file.startsWith("terrain/")) {
          const id = file.slice("terrain/".length).replace(/\.json$/, "");
          const asset = { id, type: "terrain-heightfield", name: id, data: JSON.parse(content) };
          if (assets.getDataAsset(id)) assets.updateDataAsset(asset);
          else assets.addDataAsset(asset);
          assetsVersion.set(assetsVersion.get() + 1);
        } else if (file.startsWith("spritesheets/")) {
          const id = file.slice("spritesheets/".length).replace(/\.json$/, "");
          const asset = { id, type: "spritesheet", name: id, data: JSON.parse(content) };
          if (assets.getDataAsset(id)) assets.updateDataAsset(asset);
          else assets.addDataAsset(asset);
          assetsVersion.set(assetsVersion.get() + 1); // re-resolves every consumer
        } else if (file.startsWith("prefabs/")) {
          const id = file.slice("prefabs/".length).replace(/\.json$/, "");
          // isolation editing writes this file itself — skip our own echo
          if (id === editingPrefab.get() && content === getLastWrittenPrefab()) return;
          const doc = JSON.parse(content);
          if (assets.getPrefab(id)) assets.updatePrefab(id, doc);
          else assets.addPrefab(id, doc);
          assetsVersion.set(assetsVersion.get() + 1);
        } else if (/^(items|progression|creation|quests|dialogues|shops|places)\//.test(file)) {
          // Item definitions and levelling rules are read live by the
          // character scripts (ctx.getDataAsset on every reducer call), so
          // updating the asset is the whole hot-reload — no scene rebuild.
          // An invalid file is rejected by the schema and the old values stay.
          const kind = file.slice(0, file.indexOf("/"));
          const type = ({ items: "item", quests: "quest", dialogues: "dialogue", shops: "shop" } as Record<string, string>)[kind] ?? kind;
          const id = file.slice(kind.length + 1).replace(/\.json$/, "");
          const asset = { id, type, name: id, data: JSON.parse(content) };
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
          if (applyWorldRecipeEdit(id, content)) {
            chunkManager.reloadAll();
            assetsVersion.set(assetsVersion.get() + 1);
          }
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

import { createRoot } from "react-dom/client";
import type { AssetLibrary, ComponentRegistry, SceneStore } from "@hitreg/core";
import { App } from "./overlay/App.js";
import type {
  AssetSelection,
  ContextMenu,
  DockSizes,
  EditorSettings,
  GizmoMode,
  GrayboxShape,
  ModelBones,
  Observable,
  PlayMode,
  Selection,
  TerrainBrushSettings,
} from "./state.js";

export interface MountOptions {
  container: HTMLElement;
  store: SceneStore;
  registry: ComponentRegistry;
  assets: AssetLibrary;
  selection: Selection;
  visible: Observable<boolean>;
  settings: Observable<EditorSettings>;
  gizmoMode: Observable<GizmoMode>;
  playMode: Observable<PlayMode>;
  contextMenu: ContextMenu;
  assetSelection: AssetSelection;
  grayboxActive: Observable<boolean>;
  grayboxShape: Observable<GrayboxShape>;
  grayboxBevel: Observable<number>;
  terrainActive: Observable<boolean>;
  terrainBrush: Observable<TerrainBrushSettings>;
  thumbnails: Observable<Record<string, string>>;
  dockSizes: Observable<DockSizes>;
  assetsVersion: Observable<number>;
  /** Entity id -> bone names of its loaded skinned model (bone dropdowns). */
  modelBones?: ModelBones;
  saveAsset?: (file: string, content: string) => void;
  onFocusEntity?: (entityId: string) => void;
  onUnpackModel?: (entityId: string) => void;
  scenes?: Observable<string[]>;
  onSwitchScene?: (name: string) => void;
  onNewScene?: (name: string) => void;
  /** Prefab isolation editing: id of the prefab open in the viewport, or null. */
  editingPrefab?: Observable<string | null>;
  /** Open a prefab definition alone in the viewport (host swaps the working doc). */
  onEditPrefab?: (id: string) => void;
  /** Leave prefab isolation: save=true flushes to the definition, false discards. */
  onClosePrefabEdit?: (save: boolean) => void;
}

/** Mount the editor overlay panels. Dev-only: don't ship this in production builds. */
export function mountEditor(options: MountOptions): { unmount(): void } {
  const root = createRoot(options.container);
  root.render(
    <App
      store={options.store}
      registry={options.registry}
      assets={options.assets}
      selection={options.selection}
      visible={options.visible}
      settings={options.settings}
      gizmoMode={options.gizmoMode}
      playMode={options.playMode}
      contextMenu={options.contextMenu}
      assetSelection={options.assetSelection}
      grayboxActive={options.grayboxActive}
      grayboxShape={options.grayboxShape}
      grayboxBevel={options.grayboxBevel}
      terrainActive={options.terrainActive}
      terrainBrush={options.terrainBrush}
      thumbnails={options.thumbnails}
      dockSizes={options.dockSizes}
      assetsVersion={options.assetsVersion}
      modelBones={options.modelBones}
      saveAsset={options.saveAsset}
      onFocusEntity={options.onFocusEntity}
      onUnpackModel={options.onUnpackModel}
      scenes={options.scenes}
      onSwitchScene={options.onSwitchScene}
      onNewScene={options.onNewScene}
      editingPrefab={options.editingPrefab}
      onEditPrefab={options.onEditPrefab}
      onClosePrefabEdit={options.onClosePrefabEdit}
    />,
  );
  return { unmount: () => root.unmount() };
}

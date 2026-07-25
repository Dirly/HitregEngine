import { createRoot } from "react-dom/client";
import type { AssetLibrary, ComponentRegistry, SceneStore } from "@hitreg/core";
import { App } from "./overlay/App.js";
import type { LoadedChunkCell } from "./overlay/hierarchy-dock.js";
import type {
  AssetSelection,
  ContextMenu,
  DockSizes,
  EditorSettings,
  GizmoMode,
  GrayboxShape,
  ModelBones,
  MultiSelection,
  Observable,
  PlayMode,
  Selection,
  TerrainBrushSettings,
} from "./state.js";
import type { PathCrossSection } from "./path-tool.js";

export interface MountOptions {
  container: HTMLElement;
  store: SceneStore;
  registry: ComponentRegistry;
  assets: AssetLibrary;
  selection: Selection;
  multiSelection: MultiSelection;
  visible: Observable<boolean>;
  settings: Observable<EditorSettings>;
  gizmoMode: Observable<GizmoMode>;
  playMode: Observable<PlayMode>;
  contextMenu: ContextMenu;
  assetSelection: AssetSelection;
  grayboxActive: Observable<boolean>;
  grayboxShape: Observable<GrayboxShape>;
  grayboxBevel: Observable<number>;
  /** Material GUID stamped onto newly-drawn graybox shapes ("" = engine default). */
  grayboxMaterial: Observable<string>;
  terrainActive: Observable<boolean>;
  terrainBrush: Observable<TerrainBrushSettings>;
  pathActive: Observable<boolean>;
  pathCrossSection: Observable<PathCrossSection>;
  pathWidth: Observable<number>;
  pathRadius: Observable<number>;
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
  /** Chunk-cell isolation editing: the cell open in the viewport, or null. */
  editingChunk?: Observable<{ world: string; cx: number; cz: number } | null>;
  /** Currently-loaded chunk cells, for the hierarchy's "chunk sections" list. */
  loadedChunkCells?: Observable<LoadedChunkCell[]>;
  /** Open a chunk cell alone-but-in-context in the viewport (neighbors stay visible). */
  onEditChunkCell?: (world: string, cx: number, cz: number) => void;
  /** Leave chunk isolation: save=true flushes to the cell's file(s), false discards. */
  onCloseChunkEdit?: (save: boolean) => void;
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
      multiSelection={options.multiSelection}
      visible={options.visible}
      settings={options.settings}
      gizmoMode={options.gizmoMode}
      playMode={options.playMode}
      contextMenu={options.contextMenu}
      assetSelection={options.assetSelection}
      grayboxActive={options.grayboxActive}
      grayboxShape={options.grayboxShape}
      grayboxBevel={options.grayboxBevel}
      grayboxMaterial={options.grayboxMaterial}
      terrainActive={options.terrainActive}
      terrainBrush={options.terrainBrush}
      pathActive={options.pathActive}
      pathCrossSection={options.pathCrossSection}
      pathWidth={options.pathWidth}
      pathRadius={options.pathRadius}
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
      editingChunk={options.editingChunk}
      loadedChunkCells={options.loadedChunkCells}
      onEditChunkCell={options.onEditChunkCell}
      onCloseChunkEdit={options.onCloseChunkEdit}
    />,
  );
  return { unmount: () => root.unmount() };
}

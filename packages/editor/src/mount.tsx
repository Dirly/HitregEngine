import { createRoot } from "react-dom/client";
import type {
  AssetLibrary,
  ComponentRegistry,
  SceneStore,
  ToolDefinition,
  ToolResult,
} from "@hitreg/core";
import { App } from "./overlay/App.js";
import type { LoadedChunkCell } from "./overlay/hierarchy-dock.js";
import type {
  AssetSelection,
  ContextMenu,
  DockSizes,
  EditorSettings,
  GizmoMode,
  GrayboxShape,
  MeshEditActions,
  MeshEditState,
  ModelBones,
  MultiSelection,
  Observable,
  Pin,
  Pins,
  PlayMode,
  Selection,
  TerrainBrushSettings,
} from "./state.js";
import type * as THREE from "three/webgpu";
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
  /** Drawn shapes commit as editable poly meshes (default on). */
  grayboxEditable?: Observable<boolean>;
  /** Mesh-edit (vertex/edge/face) mode state, shared with the viewport MeshEditTool. */
  meshEdit?: MeshEditState;
  /** The viewport MeshEditTool's action surface (element toolbar buttons call into it). */
  meshEditActions?: MeshEditActions;
  terrainActive: Observable<boolean>;
  terrainBrush: Observable<TerrainBrushSettings>;
  pathActive: Observable<boolean>;
  pathCrossSection: Observable<PathCrossSection>;
  pathWidth: Observable<number>;
  pathThickness: Observable<number>;
  pathRadius: Observable<number>;
  thumbnails: Observable<Record<string, string>>;
  dockSizes: Observable<DockSizes>;
  assetsVersion: Observable<number>;
  /** Entity id -> bone names of its loaded skinned model (bone dropdowns). */
  modelBones?: ModelBones;
  /** World-anchored notes; the host owns persistence (dev bridge pin store). */
  pins?: Pins;
  camera?: THREE.PerspectiveCamera;
  canvas?: HTMLCanvasElement;
  onPinCreate?: (point: [number, number, number], entityId: string | null) => void;
  /** Attach a note to an entity from its inspector (anchored at its origin). */
  onPinCreateForEntity?: (entityId: string) => void;
  onPinUpdate?: (id: string, patch: Partial<Pin>) => void;
  onPinDelete?: (id: string) => void;
  onFocusPoint?: (point: [number, number, number]) => void;
  saveAsset?: (file: string, content: string) => void;
  /** Installed engine/plugin tools. */
  tools?: Observable<ToolDefinition[]>;
  /** Shared editor/agent tool invocation surface supplied by the host. */
  runTool?: (id: string, inputs: Record<string, unknown>) => Promise<ToolResult>;
  /** Open the host's frame profiler window (toolbar button; P does the same). */
  onProfiler?: () => void;
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
      grayboxEditable={options.grayboxEditable}
      meshEdit={options.meshEdit}
      meshEditActions={options.meshEditActions}
      terrainActive={options.terrainActive}
      terrainBrush={options.terrainBrush}
      pathActive={options.pathActive}
      pathCrossSection={options.pathCrossSection}
      pathWidth={options.pathWidth}
      pathThickness={options.pathThickness}
      pathRadius={options.pathRadius}
      thumbnails={options.thumbnails}
      dockSizes={options.dockSizes}
      assetsVersion={options.assetsVersion}
      modelBones={options.modelBones}
      pins={options.pins}
      camera={options.camera}
      canvas={options.canvas}
      onPinCreate={options.onPinCreate}
      onPinCreateForEntity={options.onPinCreateForEntity}
      onPinUpdate={options.onPinUpdate}
      onPinDelete={options.onPinDelete}
      onFocusPoint={options.onFocusPoint}
      saveAsset={options.saveAsset}
      tools={options.tools}
      runTool={options.runTool}
      onProfiler={options.onProfiler}
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

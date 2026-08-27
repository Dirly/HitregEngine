import { useState } from "react";
import type * as THREE from "three/webgpu";
import {
  newId,
  prefabFromSubtree,
  type AssetLibrary,
  type ComponentRegistry,
  type SceneStore,
} from "@hitreg/core";
import type {
  AssetSelection,
  ContextMenu,
  DockSizes,
  EditorSettings,
  GizmoMode,
  GrayboxShape,
  MeshEditActions,
  MeshEditState,
  MultiSelection,
  Observable,
  Pin,
  Pins,
  PlayMode,
  Selection,
  TerrainBrushSettings,
} from "../state.js";
import type { PathCrossSection } from "../path-tool.js";
import { activeButtonStyle, buttonStyle, clamp, dockStyle, Splitter, useObservable } from "./common.js";
import { Toolbar } from "./toolbar.js";
import { MeshEditPanel } from "./mesh-edit-panel.js";
import { UvEditor } from "./uv-editor.js";
import { HierarchyDock, type LoadedChunkCell } from "./hierarchy-dock.js";
import { AssetsDock } from "./assets-dock.js";
import { InspectorDock } from "./inspector-dock.js";
import { ContextMenuView } from "./context-menu-view.js";
import { PinOverlay } from "./pin-overlay.js";

export interface AppProps {
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
  /** prefab id -> data-url thumbnail rendered by the host. */
  thumbnails: Observable<Record<string, string>>;
  /** World-anchored notes + the host's persistence callbacks (see PinOverlay). */
  pins?: Pins;
  camera?: THREE.PerspectiveCamera;
  canvas?: HTMLCanvasElement;
  onPinCreate?: (point: [number, number, number], entityId: string | null) => void;
  onPinCreateForEntity?: (entityId: string) => void;
  onPinUpdate?: (id: string, patch: Partial<Pin>) => void;
  onPinDelete?: (id: string) => void;
  onFocusPoint?: (point: [number, number, number]) => void;
  /** Resizable dock sizes; the host resizes the viewport canvas from these. */
  dockSizes: Observable<DockSizes>;
  assetsVersion: Observable<number>;
  /** Entity id -> bone names of its loaded skinned model (host-populated). */
  modelBones?: Observable<Record<string, string[]>>;
  saveAsset?: (file: string, content: string) => void;
  /** Fly the editor camera to frame an entity (double-click in hierarchy / F key). */
  onFocusEntity?: (entityId: string) => void;
  /** Detach a loaded model's named sub-objects into child entities. */
  onUnpackModel?: (entityId: string) => void;
  /** Open the host's frame profiler window (toolbar button; P does the same). */
  onProfiler?: () => void;
  /** Scene management (host-provided): available scene names + switching. */
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

const nullEditingPrefab: Observable<string | null> = {
  get: () => null,
  set: () => undefined,
  subscribe: () => () => undefined,
};

const nullEditingChunk: Observable<{ world: string; cx: number; cz: number } | null> = {
  get: () => null,
  set: () => undefined,
  subscribe: () => () => undefined,
};

export function App(props: AppProps) {
  const visible = useObservable(props.visible);
  const docks = useObservable(props.dockSizes);
  const [showResolvedPins, setShowResolvedPins] = useState(false);
  const editingPrefab = useObservable(props.editingPrefab ?? nullEditingPrefab);
  const editingChunk = useObservable(props.editingChunk ?? nullEditingChunk);
  if (!visible) return null;

  const bumpAssets = () => props.assetsVersion.set(props.assetsVersion.get() + 1);

  const createPrefabFrom = (entityId: string, folder = ""): void => {
    const doc = props.store.doc;
    const entity = doc.entities[entityId];
    if (!entity) return;
    const base =
      entity.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "entity";
    const prefix = folder ? `${folder}/` : "";
    let id = `${prefix}prefab-${base}`;
    let n = 2;
    while (props.assets.getPrefab(id)) id = `${prefix}prefab-${base}-${n++}`;
    try {
      const { prefab, replaceOps } = prefabFromSubtree(doc, entityId, id);
      props.assets.addPrefab(id, prefab);
      props.store.apply(replaceOps);
      props.saveAsset?.(`prefabs/${id}.json`, JSON.stringify(prefab, null, 2));
      bumpAssets();
    } catch (error) {
      console.warn("[editor] create prefab failed:", error);
    }
  };

  // lighting tool: jump to (or create) the scene's Environment entity — its
  // sky component edits with color pickers in the inspector
  const selectEnvironment = (): void => {
    const existing = Object.entries(props.store.doc.entities).find(
      ([, e]) => "sky" in e.components,
    );
    if (existing) {
      props.assetSelection.set(null);
      props.selection.set(existing[0]);
      return;
    }
    const id = newId();
    try {
      props.store.apply([
        {
          op: "add-entity",
          id,
          entity: { name: "Environment", parent: null, tags: [], components: { sky: {} } },
        },
      ]);
      props.assetSelection.set(null);
      props.selection.set(id);
    } catch (error) {
      console.warn("[editor] environment create failed:", error);
    }
  };

  const createMaterial = (folder = ""): void => {
    const prefix = folder ? `${folder}/` : "";
    let n = props.assets.dataAssetsOfType("material").length + 1;
    let id = `${prefix}material-${n}`;
    while (props.assets.getDataAsset(id)) id = `${prefix}material-${++n}`;
    const stored = props.assets.addDataAsset({ id, type: "material", name: id, data: {} });
    props.saveAsset?.(`materials/${id}.json`, JSON.stringify(stored.data, null, 2));
    bumpAssets();
    props.selection.set(null);
    props.assetSelection.set({ kind: "material", id });
  };

  // spritesheet.texture is required (no schema default) — needs a texture
  // asset to point at, so the button that calls this stays disabled until one exists.
  const createSpritesheet = (folder = ""): void => {
    const textureId = props.assets.textureIds()[0];
    if (!textureId) return;
    const prefix = folder ? `${folder}/` : "";
    let n = props.assets.dataAssetsOfType("spritesheet").length + 1;
    let id = `${prefix}spritesheet-${n}`;
    while (props.assets.getDataAsset(id)) id = `${prefix}spritesheet-${++n}`;
    const stored = props.assets.addDataAsset({
      id,
      type: "spritesheet",
      name: id,
      data: { texture: textureId },
    });
    props.saveAsset?.(`spritesheets/${id}.json`, JSON.stringify(stored.data, null, 2));
    bumpAssets();
    props.selection.set(null);
    props.assetSelection.set({ kind: "spritesheet", id });
  };

  return (
    <>
      <div
        style={{
          position: "fixed",
          inset: 0,
          display: "grid",
          gridTemplateColumns: `${docks.left}px 1fr ${docks.right}px`,
          gridTemplateRows: `${docks.top}px 1fr ${docks.bottom}px`,
          zIndex: 900,
          pointerEvents: "none",
        }}
      >
        <div style={{ ...dockStyle, gridColumn: "1 / 4", gridRow: 1 }}>
          <Toolbar
            store={props.store}
            assets={props.assets}
            assetsVersion={props.assetsVersion}
            playMode={props.playMode}
            gizmoMode={props.gizmoMode}
            settings={props.settings}
            grayboxActive={props.grayboxActive}
            grayboxShape={props.grayboxShape}
            grayboxBevel={props.grayboxBevel}
            grayboxMaterial={props.grayboxMaterial}
            grayboxEditable={props.grayboxEditable}
            meshEdit={props.meshEdit}
            terrainActive={props.terrainActive}
            terrainBrush={props.terrainBrush}
            pathActive={props.pathActive}
            pathCrossSection={props.pathCrossSection}
            pathWidth={props.pathWidth}
            pathThickness={props.pathThickness}
            pathRadius={props.pathRadius}
            scenes={props.scenes}
            onSwitchScene={props.onSwitchScene}
            onNewScene={props.onNewScene}
            onEnvironment={selectEnvironment}
            onProfiler={props.onProfiler}
            editingPrefab={editingPrefab}
            editingChunk={editingChunk}
          />
        </div>

        <div style={{ ...dockStyle, gridColumn: 1, gridRow: "2 / 4" }}>
          <HierarchyDock
            store={props.store}
            selection={props.selection}
            multiSelection={props.multiSelection}
            assetSelection={props.assetSelection}
            contextMenu={props.contextMenu}
            onFocusEntity={props.onFocusEntity}
            loadedChunkCells={props.loadedChunkCells}
            onEditChunkCell={props.onEditChunkCell}
          />
        </div>

        {/* center = the live viewport; the canvas is sized to this hole */}
        <div
          style={{
            gridColumn: 2,
            gridRow: 2,
            minWidth: 0,
            pointerEvents: "none",
            display: "flex",
            flexDirection: "column",
          }}
        >
          {editingPrefab && (
            <PrefabEditBanner
              prefabId={editingPrefab}
              assets={props.assets}
              assetsVersion={props.assetsVersion}
              onClose={props.onClosePrefabEdit}
            />
          )}
          {editingChunk && <ChunkEditBanner cell={editingChunk} onClose={props.onCloseChunkEdit} />}
          {props.pins && <PinBadge pins={props.pins} showResolved={showResolvedPins} onToggle={() => setShowResolvedPins((v) => !v)} />}
          {props.meshEdit && (
            <div style={{ flex: 1, minHeight: 0, display: "flex", alignItems: "flex-start", justifyContent: "space-between", pointerEvents: "none" }}>
              <MeshEditPanel
                state={props.meshEdit}
                actions={props.meshEditActions ?? null}
                gizmoMode={props.gizmoMode}
                assets={props.assets}
                assetsVersion={props.assetsVersion}
                store={props.store}
                multiSelection={props.multiSelection}
                onOpenUvEditor={() => props.meshEdit!.uvEditorOpen.set(!props.meshEdit!.uvEditorOpen.get())}
              />
              <UvEditor store={props.store} assets={props.assets} state={props.meshEdit} assetsVersion={props.assetsVersion} />
            </div>
          )}
        </div>

        <div style={{ ...dockStyle, gridColumn: 2, gridRow: 3 }}>
          <AssetsDock
            assets={props.assets}
            store={props.store}
            selection={props.selection}
            multiSelection={props.multiSelection}
            assetSelection={props.assetSelection}
            assetsVersion={props.assetsVersion}
            thumbnails={props.thumbnails}
            onCreateMaterial={createMaterial}
            onCreateSpritesheet={createSpritesheet}
            onCreatePrefab={createPrefabFrom}
            onSetSky={(textureId) => {
              // put the panorama on the scene's Environment (creating it if needed)
              const found = Object.entries(props.store.doc.entities).find(
                ([, e]) => "sky" in e.components,
              );
              try {
                if (found) {
                  const sky = found[1].components["sky"] as Record<string, unknown>;
                  props.store.apply([
                    {
                      op: "set-component",
                      id: found[0],
                      component: "sky",
                      data: { ...sky, texture: textureId },
                    },
                  ]);
                } else {
                  props.store.apply([
                    {
                      op: "add-entity",
                      id: newId(),
                      entity: {
                        name: "Environment",
                        parent: null,
                        tags: [],
                        components: { sky: { texture: textureId } },
                      },
                    },
                  ]);
                }
              } catch (error) {
                console.warn("[editor] set sky failed:", error);
              }
            }}
          />
        </div>

        <div style={{ ...dockStyle, gridColumn: 3, gridRow: "2 / 4" }}>
          <InspectorDock
            pins={props.pins}
            onPinCreateForEntity={props.onPinCreateForEntity}
            onPinUpdate={props.onPinUpdate}
            onPinDelete={props.onPinDelete}
            store={props.store}
            registry={props.registry}
            selection={props.selection}
            assets={props.assets}
            assetSelection={props.assetSelection}
            assetsVersion={props.assetsVersion}
            modelBones={props.modelBones}
            saveAsset={props.saveAsset}
            thumbnails={props.thumbnails}
            onEditPrefab={props.onEditPrefab}
            meshEdit={props.meshEdit}
          />
        </div>
      </div>

      {/* resizable dock splitters (Unity-style) */}
      <Splitter
        style={{ top: docks.top, bottom: 0, left: docks.left - 3, width: 6, cursor: "ew-resize" }}
        onDrag={(dx) => {
          const s = props.dockSizes.get();
          props.dockSizes.set({ ...s, left: clamp(s.left + dx, 180, 560) });
        }}
      />
      <Splitter
        style={{ top: docks.top, bottom: 0, right: docks.right - 3, width: 6, cursor: "ew-resize" }}
        onDrag={(dx) => {
          const s = props.dockSizes.get();
          props.dockSizes.set({ ...s, right: clamp(s.right - dx, 220, 640) });
        }}
      />
      <Splitter
        style={{
          left: docks.left,
          right: docks.right,
          bottom: docks.bottom - 3,
          height: 6,
          cursor: "ns-resize",
        }}
        onDrag={(_dx, dy) => {
          const s = props.dockSizes.get();
          props.dockSizes.set({ ...s, bottom: clamp(s.bottom - dy, 120, 520) });
        }}
      />

      <ContextMenuView
        store={props.store}
        selection={props.selection}
        multiSelection={props.multiSelection}
        contextMenu={props.contextMenu}
        meshEdit={props.meshEdit}
        meshEditActions={props.meshEditActions}
        onCreatePrefab={createPrefabFrom}
        onUnpackModel={props.onUnpackModel}
        onPinHere={props.onPinCreate}
      />

      {props.pins && props.camera && props.canvas && (
        <PinOverlay
          pins={props.pins}
          camera={props.camera}
          canvas={props.canvas}
          showResolved={showResolvedPins}
          onUpdate={(id, patch) => props.onPinUpdate?.(id, patch)}
          onDelete={(id) => props.onPinDelete?.(id)}
          onFocusPoint={props.onFocusPoint}
        />
      )}
    </>
  );
}

/**
 * Prefab isolation mode indicator: a slim bar across the top of the viewport.
 * Muted accent so the mode is unmistakable without shouting; edits autosave
 * to the definition live, the buttons decide how the session ends.
 */
function PrefabEditBanner(props: {
  prefabId: string;
  assets: AssetLibrary;
  assetsVersion: Observable<number>;
  onClose?: (save: boolean) => void;
}) {
  useObservable(props.assetsVersion); // prefab rename mid-edit updates the title
  const name = props.assets.getPrefab(props.prefabId)?.name ?? props.prefabId;
  return (
    <div
      style={{
        pointerEvents: "auto",
        display: "flex",
        alignItems: "center",
        gap: 8,
        padding: "4px 10px",
        background: "rgba(31, 58, 95, 0.92)",
        borderBottom: "1px solid #79c0ff",
        color: "#e6edf3",
        font: "12px ui-monospace, monospace",
      }}
    >
      <span style={{ color: "#79c0ff" }} aria-hidden>
        ◆
      </span>
      <span
        style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
      >
        Editing prefab <strong>{name}</strong> — saves apply to every instance
      </span>
      <button
        style={activeButtonStyle}
        title="Save the definition and return to the scene"
        onClick={() => props.onClose?.(true)}
      >
        ✓ save &amp; close
      </button>
      <button
        style={buttonStyle}
        title="Return to the scene without saving pending changes"
        onClick={() => props.onClose?.(false)}
      >
        ✕ discard
      </button>
    </div>
  );
}

function ChunkEditBanner(props: {
  cell: { world: string; cx: number; cz: number };
  onClose?: (save: boolean) => void;
}) {
  return (
    <div
      style={{
        pointerEvents: "auto",
        display: "flex",
        alignItems: "center",
        gap: 8,
        padding: "4px 10px",
        background: "rgba(66, 51, 15, 0.92)",
        borderBottom: "1px solid #d29922",
        color: "#e6edf3",
        font: "12px ui-monospace, monospace",
      }}
    >
      <span style={{ color: "#d29922" }} aria-hidden>
        ▤
      </span>
      <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
        Editing chunk <strong>{props.cell.world}</strong> {props.cell.cx}_{props.cell.cz} — the
        rest of the streamed world stays visible for context
      </span>
      <button
        style={activeButtonStyle}
        title="Save this cell (and any entity dragged into a neighboring cell) and return to the scene"
        onClick={() => props.onClose?.(true)}
      >
        ✓ save &amp; close
      </button>
      <button
        style={buttonStyle}
        title="Return to the scene without saving pending changes"
        onClick={() => props.onClose?.(false)}
      >
        ✕ discard
      </button>
    </div>
  );
}

/**
 * Unobtrusive count of open notes, with the show-resolved toggle. Sits in the
 * viewport hole rather than the toolbar so pins stay a property of the world
 * you're looking at, not another panel to go find.
 */
function PinBadge(props: { pins: Pins; showResolved: boolean; onToggle: () => void }) {
  const pins = useObservable(props.pins);
  if (pins.length === 0) return null;
  const open = pins.filter((pin) => !pin.resolved).length;
  return (
    <div style={{ display: "flex", justifyContent: "flex-end", padding: 6 }}>
      <button
        onClick={props.onToggle}
        title={
          props.showResolved
            ? "Showing resolved notes too — click to show only open ones"
            : "Showing open notes — click to include resolved"
        }
        style={{
          ...buttonStyle,
          pointerEvents: "auto",
          padding: "2px 8px",
          font: "11px ui-monospace, monospace",
          background: "rgba(13, 17, 23, 0.9)",
        }}
      >
        {open} open note{open === 1 ? "" : "s"}
        {pins.length > open ? ` · ${pins.length - open} resolved${props.showResolved ? " ✓" : ""}` : ""}
      </button>
    </div>
  );
}

import { useSyncExternalStore, useState } from "react";
import {
  childrenOf,
  duplicateSubtree,
  newId,
  prefabFromSubtree,
  type AssetLibrary,
  type ComponentRegistry,
  type SceneDoc,
  type SceneStore,
  type Op,
} from "@hitreg/core";
import type {
  AssetSelection,
  ContextMenu,
  EditorSettings,
  GizmoMode,
  GrayboxShape,
  Observable,
  PlayMode,
  Selection,
} from "../state.js";
import { ColorField, NumberField, Row, SliderField, TextField, ValueField } from "./fields.js";

/** Docked layout constants — main.ts sizes the viewport canvas to the center hole. */
export const DOCK = { left: 300, right: 360, top: 64, bottom: 240 } as const;

/** Minimal valid data for components whose schemas have required fields. */
const componentSeeds: Record<string, unknown> = {
  light: { kind: "point" },
  mesh: { source: { kind: "primitive", shape: "box", size: [1, 1, 1] } },
  prefab: { prefabId: "" },
  rigidbody: {},
  collider: {},
  joint: { kind: "hinge", target: "SET-TARGET-ENTITY-ID" },
};

export interface AppProps {
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
  /** prefab id -> data-url thumbnail rendered by the host. */
  thumbnails: Observable<Record<string, string>>;
  assetsVersion: Observable<number>;
  saveAsset?: (file: string, content: string) => void;
}

function useObservable<T>(obs: Observable<T>): T {
  return useSyncExternalStore(
    (cb) => obs.subscribe(cb),
    () => obs.get(),
  );
}

function useStoreDoc(store: SceneStore): SceneDoc {
  return useSyncExternalStore(
    (cb) => store.subscribe(cb),
    () => store.doc,
  );
}

function apply(store: SceneStore, ops: Op[]): void {
  try {
    store.apply(ops);
  } catch (error) {
    console.warn("[editor] ops rejected:", error);
  }
}

const buttonStyle: React.CSSProperties = {
  background: "#21262d",
  border: "1px solid #30363d",
  borderRadius: 3,
  color: "#c9d1d9",
  cursor: "pointer",
  font: "12px ui-monospace, monospace",
  padding: "4px 10px",
};

const activeButtonStyle: React.CSSProperties = {
  ...buttonStyle,
  background: "#1f3a5f",
  borderColor: "#79c0ff",
  color: "#e6edf3",
};

const dockStyle: React.CSSProperties = {
  background: "#0d1117",
  border: "1px solid #21262d",
  color: "#c9d1d9",
  font: "12px ui-monospace, monospace",
  display: "flex",
  flexDirection: "column",
  minHeight: 0,
  pointerEvents: "auto",
};

export function App(props: AppProps) {
  const visible = useObservable(props.visible);
  if (!visible) return null;

  const bumpAssets = () => props.assetsVersion.set(props.assetsVersion.get() + 1);

  const createPrefabFrom = (entityId: string): void => {
    const doc = props.store.doc;
    const entity = doc.entities[entityId];
    if (!entity) return;
    const base =
      entity.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "entity";
    let id = `prefab-${base}`;
    let n = 2;
    while (props.assets.getPrefab(id)) id = `prefab-${base}-${n++}`;
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

  const createMaterial = (): void => {
    let n = props.assets.dataAssetsOfType("material").length + 1;
    let id = `material-${n}`;
    while (props.assets.getDataAsset(id)) id = `material-${++n}`;
    const stored = props.assets.addDataAsset({ id, type: "material", name: id, data: {} });
    props.saveAsset?.(`materials/${id}.json`, JSON.stringify(stored.data, null, 2));
    bumpAssets();
    props.selection.set(null);
    props.assetSelection.set({ kind: "material", id });
  };

  return (
    <>
      <div
        style={{
          position: "fixed",
          inset: 0,
          display: "grid",
          gridTemplateColumns: `${DOCK.left}px 1fr ${DOCK.right}px`,
          gridTemplateRows: `${DOCK.top}px 1fr ${DOCK.bottom}px`,
          zIndex: 900,
          pointerEvents: "none",
        }}
      >
        <div style={{ ...dockStyle, gridColumn: "1 / 4", gridRow: 1 }}>
          <Toolbar
            store={props.store}
            playMode={props.playMode}
            gizmoMode={props.gizmoMode}
            settings={props.settings}
            grayboxActive={props.grayboxActive}
            grayboxShape={props.grayboxShape}
            grayboxBevel={props.grayboxBevel}
          />
        </div>

        <div style={{ ...dockStyle, gridColumn: 1, gridRow: "2 / 4" }}>
          <HierarchyDock
            store={props.store}
            selection={props.selection}
            assetSelection={props.assetSelection}
            contextMenu={props.contextMenu}
          />
        </div>

        {/* center = the live viewport; the canvas is sized to this hole */}
        <div style={{ gridColumn: 2, gridRow: 2, pointerEvents: "none" }} />

        <div style={{ ...dockStyle, gridColumn: 2, gridRow: 3 }}>
          <AssetsDock
            assets={props.assets}
            store={props.store}
            selection={props.selection}
            assetSelection={props.assetSelection}
            assetsVersion={props.assetsVersion}
            thumbnails={props.thumbnails}
            onCreateMaterial={createMaterial}
            onCreatePrefab={createPrefabFrom}
          />
        </div>

        <div style={{ ...dockStyle, gridColumn: 3, gridRow: "2 / 4" }}>
          <InspectorDock
            store={props.store}
            registry={props.registry}
            selection={props.selection}
            assets={props.assets}
            assetSelection={props.assetSelection}
            assetsVersion={props.assetsVersion}
            saveAsset={props.saveAsset}
          />
        </div>
      </div>

      <ContextMenuView
        store={props.store}
        selection={props.selection}
        contextMenu={props.contextMenu}
        onCreatePrefab={createPrefabFrom}
      />
    </>
  );
}

function DockHeader(props: { title: string; children?: React.ReactNode }) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 6,
        padding: "5px 8px",
        background: "#161b22",
        borderBottom: "1px solid #21262d",
        flexShrink: 0,
      }}
    >
      <strong style={{ color: "#e6edf3", flex: 1, whiteSpace: "nowrap", overflow: "hidden" }}>
        {props.title}
      </strong>
      {props.children}
    </div>
  );
}

export function SearchInput(props: { value: string; onChange: (v: string) => void }) {
  return (
    <input
      placeholder="search…"
      value={props.value}
      onChange={(e) => props.onChange(e.target.value)}
      style={{
        background: "#0d1117",
        border: "1px solid #30363d",
        borderRadius: 3,
        color: "#c9d1d9",
        font: "11px ui-monospace, monospace",
        padding: "2px 6px",
        width: 130,
      }}
    />
  );
}

// ---------------------------------------------------------------- toolbar

function Toolbar(props: {
  store: SceneStore;
  playMode: Observable<PlayMode>;
  gizmoMode: Observable<GizmoMode>;
  settings: Observable<EditorSettings>;
  grayboxActive: Observable<boolean>;
  grayboxShape: Observable<GrayboxShape>;
  grayboxBevel: Observable<number>;
}) {
  const play = useObservable(props.playMode);
  const mode = useObservable(props.gizmoMode);
  const settings = useObservable(props.settings);
  const grayboxOn = useObservable(props.grayboxActive);
  const shape = useObservable(props.grayboxShape);
  const bevel = useObservable(props.grayboxBevel);
  const set = (patch: Partial<EditorSettings>) => props.settings.set({ ...settings, ...patch });

  const group: React.CSSProperties = {
    display: "flex",
    gap: 5,
    alignItems: "center",
    paddingRight: 10,
    marginRight: 10,
    borderRight: "1px solid #21262d",
  };

  const modes: Array<{ key: GizmoMode; label: string }> = [
    { key: "translate", label: "move" },
    { key: "rotate", label: "rotate" },
    { key: "scale", label: "scale" },
  ];

  return (
    <div style={{ padding: "6px 10px", display: "flex", flexDirection: "column", gap: 3, height: "100%" }}>
      <div style={{ display: "flex", alignItems: "center", flexWrap: "nowrap", overflowX: "auto" }}>
        <span style={group}>
          <strong style={{ color: "#e6edf3", marginRight: 4 }}>HitReg</strong>
          <button
            style={play === "playing" ? activeButtonStyle : buttonStyle}
            disabled={play === "playing"}
            onClick={() => props.playMode.set("playing")}
          >
            ▶ play
          </button>
          <button
            style={play === "paused" ? activeButtonStyle : buttonStyle}
            disabled={play !== "playing"}
            onClick={() => props.playMode.set("paused")}
          >
            ⏸
          </button>
          <button style={buttonStyle} disabled={play === "edit"} onClick={() => props.playMode.set("edit")}>
            ⏹
          </button>
        </span>

        <span style={group}>
          {modes.map((m) => (
            <button
              key={m.key}
              style={mode === m.key ? activeButtonStyle : buttonStyle}
              onClick={() => props.gizmoMode.set(m.key)}
            >
              {m.label}
            </button>
          ))}
        </span>

        <span style={group}>
          <label style={{ display: "flex", gap: 3, alignItems: "center", cursor: "pointer" }}>
            <input type="checkbox" checked={settings.snap} onChange={(e) => set({ snap: e.target.checked })} />
            snap
          </label>
          <span style={{ width: 46 }}>
            <NumberField value={settings.translateSnap} onCommit={(v) => v > 0 && set({ translateSnap: v })} />
          </span>
          <label style={{ display: "flex", gap: 3, alignItems: "center", cursor: "pointer" }}>
            <input type="checkbox" checked={settings.grid} onChange={(e) => set({ grid: e.target.checked })} />
            grid
          </label>
          <label
            style={{ display: "flex", gap: 3, alignItems: "center", cursor: "pointer" }}
            title="Collider wireframes + joint anchors/axes"
          >
            <input
              type="checkbox"
              checked={settings.showPhysics}
              onChange={(e) => set({ showPhysics: e.target.checked })}
            />
            phys
          </label>
        </span>

        <span style={group}>
          <button
            style={grayboxOn ? activeButtonStyle : buttonStyle}
            title="Graybox draw mode — drag footprint, pull height, click to place. Alt+drag box face = extrude. Ctrl inverts snap."
            onClick={() => props.grayboxActive.set(!grayboxOn)}
          >
            ✏ draw (G)
          </button>
          <select
            style={{ ...buttonStyle, padding: "4px 6px" }}
            value={shape}
            onChange={(e) => props.grayboxShape.set(e.target.value as GrayboxShape)}
          >
            {(["box", "cylinder", "sphere", "wedge", "poly"] as GrayboxShape[]).map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
          <span style={{ color: "#8b949e" }}>bevel</span>
          <span style={{ width: 44 }} title="0 = off; boxes/polys extrude with rounded edges">
            <NumberField value={bevel} onCommit={(v) => v >= 0 && props.grayboxBevel.set(v)} />
          </span>
        </span>

        <span style={{ ...group, borderRight: "none" }}>
          <button style={buttonStyle} disabled={!props.store.canUndo} onClick={() => props.store.undo()}>
            ⟲ undo
          </button>
          <button style={buttonStyle} disabled={!props.store.canRedo} onClick={() => props.store.redo()}>
            ⟳ redo
          </button>
        </span>
      </div>
      <div style={{ color: "#8b949e", fontSize: 10 }}>
        ~ close editor · W/E/R gizmo · F frame · G draw · Del delete · Ctrl+D duplicate · Ctrl+Z/Y undo ·
        Ctrl inverts snap · poly: click points, Enter/near-first closes · dbl-click prefab opens it
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- hierarchy

function HierarchyDock(props: {
  store: SceneStore;
  selection: Selection;
  assetSelection: AssetSelection;
  contextMenu: ContextMenu;
}) {
  const doc = useStoreDoc(props.store);
  const selected = useObservable(props.selection);
  const [query, setQuery] = useState("");

  const matches = query
    ? Object.entries(doc.entities)
        .filter(([, e]) => e.name.toLowerCase().includes(query.toLowerCase()))
        .map(([id]) => id)
    : null;

  return (
    <>
      <DockHeader title={`Hierarchy — ${doc.name}`}>
        <SearchInput value={query} onChange={setQuery} />
        <button
          style={buttonStyle}
          title="Add entity (child of selection)"
          onClick={() =>
            apply(props.store, [
              {
                op: "add-entity",
                id: newId(),
                entity: {
                  name: "New Entity",
                  parent: selected && doc.entities[selected] ? selected : null,
                  tags: [],
                  components: { transform: {} },
                },
              },
            ])
          }
        >
          +
        </button>
      </DockHeader>
      <div
        style={{ flex: 1, overflowY: "auto", padding: 6 }}
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => {
          const dragged = e.dataTransfer.getData("text/plain");
          if (dragged) apply(props.store, [{ op: "reparent", id: dragged, parent: null }]);
        }}
      >
        <div style={{ color: "#8b949e", fontSize: 10, marginBottom: 4 }}>
          drag rows to nest · drop on empty space for root
        </div>
        {matches ? (
          matches.map((id) => (
            <TreeRow
              key={id}
              id={id}
              doc={doc}
              depth={0}
              selected={selected}
              selection={props.selection}
              assetSelection={props.assetSelection}
              store={props.store}
              contextMenu={props.contextMenu}
            />
          ))
        ) : (
          <Tree
            doc={doc}
            parent={null}
            depth={0}
            selected={selected}
            selection={props.selection}
            assetSelection={props.assetSelection}
            store={props.store}
            contextMenu={props.contextMenu}
          />
        )}
      </div>
    </>
  );
}

interface TreeProps {
  doc: SceneDoc;
  parent: string | null;
  depth: number;
  selected: string | null;
  selection: Selection;
  assetSelection: AssetSelection;
  store: SceneStore;
  contextMenu: ContextMenu;
}

function Tree(props: TreeProps) {
  const ids = childrenOf(props.doc, props.parent);
  return (
    <>
      {ids.map((id) => (
        <div key={id}>
          <TreeRow {...props} id={id} />
          <Tree {...props} parent={id} depth={props.depth + 1} />
        </div>
      ))}
    </>
  );
}

function TreeRow(props: Omit<TreeProps, "parent"> & { id: string }) {
  const entity = props.doc.entities[props.id]!;
  const isSelected = props.id === props.selected;
  const isPrefab = "prefab" in entity.components;
  return (
    <div
      draggable
      onDragStart={(e) => e.dataTransfer.setData("text/plain", props.id)}
      onDragOver={(e) => {
        e.preventDefault();
        e.stopPropagation();
      }}
      onDrop={(e) => {
        e.stopPropagation();
        const dragged = e.dataTransfer.getData("text/plain");
        if (dragged && dragged !== props.id) {
          apply(props.store, [{ op: "reparent", id: dragged, parent: props.id }]);
        }
      }}
      onClick={() => {
        props.assetSelection.set(null);
        props.selection.set(props.id);
      }}
      onDoubleClick={() => {
        const prefabId = (entity.components["prefab"] as { prefabId?: string } | undefined)
          ?.prefabId;
        if (prefabId) {
          props.selection.set(null);
          props.assetSelection.set({ kind: "prefab", id: prefabId });
        }
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        props.selection.set(props.id);
        props.contextMenu.set({ x: e.clientX, y: e.clientY, entityId: props.id });
      }}
      style={{
        display: "flex",
        justifyContent: "space-between",
        padding: "2px 4px",
        paddingLeft: 4 + props.depth * 14,
        cursor: "pointer",
        borderRadius: 3,
        background: isSelected ? "#1f3a5f" : "transparent",
        color: isPrefab ? "#79c0ff" : "#c9d1d9",
      }}
    >
      <span>
        {isPrefab ? "◆ " : "· "}
        {entity.name}
      </span>
      <span
        style={{ color: "#8b949e", cursor: "pointer" }}
        title="Delete entity (and subtree)"
        onClick={(e) => {
          e.stopPropagation();
          if (props.selected === props.id) props.selection.set(null);
          apply(props.store, [{ op: "remove-entity", id: props.id }]);
        }}
      >
        ✕
      </span>
    </div>
  );
}

// ---------------------------------------------------------------- assets

function AssetsDock(props: {
  assets: AssetLibrary;
  store: SceneStore;
  selection: Selection;
  assetSelection: AssetSelection;
  assetsVersion: Observable<number>;
  thumbnails: Observable<Record<string, string>>;
  onCreateMaterial: () => void;
  onCreatePrefab: (entityId: string) => void;
}) {
  useObservable(props.assetsVersion);
  const thumbnails = useObservable(props.thumbnails);
  const selectedEntity = useObservable(props.selection);
  const selectedAsset = useObservable(props.assetSelection);
  const [query, setQuery] = useState("");
  const q = query.toLowerCase();

  const prefabIds = props.assets
    .prefabIds()
    .filter((id) => props.assets.getPrefab(id)!.name.toLowerCase().includes(q));
  const modelIds = props.assets
    .modelIds()
    .filter((id) => props.assets.getModel(id)!.name.toLowerCase().includes(q));
  const materials = props.assets
    .dataAssetsOfType("material")
    .filter((a) => a.name.toLowerCase().includes(q));

  const instantiate = (ops: Op[], selectId: string) => {
    apply(props.store, ops);
    props.assetSelection.set(null);
    props.selection.set(selectId);
  };

  const select = (kind: "material" | "prefab" | "model", id: string) => {
    props.selection.set(null);
    props.assetSelection.set({ kind, id });
  };

  const applyMaterialToSelection = (materialId: string) => {
    if (!selectedEntity) return;
    const entity = props.store.doc.entities[selectedEntity];
    const mesh = entity?.components["mesh"] as Record<string, unknown> | undefined;
    if (!mesh) return;
    apply(props.store, [
      { op: "set-component", id: selectedEntity, component: "mesh", data: { ...mesh, material: materialId } },
    ]);
  };

  return (
    <>
      <DockHeader title="Assets — assets/">
        <SearchInput value={query} onChange={setQuery} />
        <button style={buttonStyle} title="New material asset" onClick={props.onCreateMaterial}>
          + material
        </button>
        <button
          style={buttonStyle}
          title="Create a prefab from the selected entity"
          disabled={!selectedEntity}
          onClick={() => selectedEntity && props.onCreatePrefab(selectedEntity)}
        >
          + prefab
        </button>
      </DockHeader>
      <div style={{ flex: 1, overflowY: "auto", padding: 8 }}>
        {prefabIds.length === 0 && modelIds.length === 0 && materials.length === 0 && (
          <div style={{ color: "#8b949e" }}>
            {query
              ? "No assets match."
              : "Create materials/prefabs here, drop .glb models in assets/models/, prefab .json in assets/prefabs/"}
          </div>
        )}
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
          {materials.map((mat) => {
            const color = (mat.data as { color?: string }).color ?? "#9aa0a8";
            return (
              <AssetCard
                key={mat.id}
                swatch={color}
                color="#e3b341"
                name={mat.name}
                kind="material"
                selected={selectedAsset?.kind === "material" && selectedAsset.id === mat.id}
                onSelect={() => select("material", mat.id)}
                actionLabel="apply to selection"
                actionDisabled={!selectedEntity}
                onAction={() => applyMaterialToSelection(mat.id)}
              />
            );
          })}
          {prefabIds.map((pid) => (
            <AssetCard
              key={pid}
              glyph="◆"
              color="#79c0ff"
              name={props.assets.getPrefab(pid)!.name}
              kind="prefab"
              thumbnail={thumbnails[pid]}
              selected={selectedAsset?.kind === "prefab" && selectedAsset.id === pid}
              onSelect={() => select("prefab", pid)}
              actionLabel="+ add to scene"
              onAction={() => {
                const id = newId();
                instantiate(
                  [
                    {
                      op: "add-entity",
                      id,
                      entity: {
                        name: props.assets.getPrefab(pid)!.name,
                        parent: null,
                        tags: [],
                        components: { transform: {}, prefab: { prefabId: pid } },
                      },
                    },
                  ],
                  id,
                );
              }}
            />
          ))}
          {modelIds.map((mid) => (
            <AssetCard
              key={mid}
              glyph="▣"
              color="#7ee787"
              name={props.assets.getModel(mid)!.name}
              kind="model"
              selected={selectedAsset?.kind === "model" && selectedAsset.id === mid}
              onSelect={() => select("model", mid)}
              actionLabel="+ add to scene"
              onAction={() => {
                const id = newId();
                instantiate(
                  [
                    {
                      op: "add-entity",
                      id,
                      entity: {
                        name: props.assets.getModel(mid)!.name,
                        parent: null,
                        tags: [],
                        components: {
                          transform: {},
                          mesh: { source: { kind: "asset", assetId: mid } },
                        },
                      },
                    },
                  ],
                  id,
                );
              }}
            />
          ))}
        </div>
      </div>
    </>
  );
}

function AssetCard(props: {
  glyph?: string;
  swatch?: string;
  thumbnail?: string;
  color: string;
  name: string;
  kind: string;
  selected: boolean;
  onSelect: () => void;
  actionLabel: string;
  actionDisabled?: boolean;
  onAction: () => void;
}) {
  return (
    <div
      onClick={props.onSelect}
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 4,
        padding: 6,
        width: 132,
        background: props.selected ? "#1f3a5f" : "#161b22",
        border: `1px solid ${props.selected ? "#79c0ff" : "#30363d"}`,
        borderRadius: 3,
        cursor: "pointer",
      }}
    >
      {props.thumbnail ? (
        <img
          src={props.thumbnail}
          alt={props.name}
          style={{ width: "100%", height: 84, objectFit: "cover", borderRadius: 3, background: "#0b0e14" }}
        />
      ) : props.swatch ? (
        <div
          style={{
            width: "100%",
            height: 40,
            borderRadius: 3,
            background: props.swatch,
            border: "1px solid #30363d",
          }}
        />
      ) : (
        <div
          style={{
            width: "100%",
            height: 40,
            borderRadius: 3,
            background: "#0b0e14",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            color: props.color,
            fontSize: 20,
          }}
        >
          {props.glyph}
        </div>
      )}
      <span
        style={{
          color: props.color,
          whiteSpace: "nowrap",
          overflow: "hidden",
          textOverflow: "ellipsis",
        }}
      >
        {props.name}
      </span>
      <span style={{ color: "#8b949e", fontSize: 10 }}>{props.kind}</span>
      <button
        style={buttonStyle}
        disabled={props.actionDisabled}
        onClick={(e) => {
          e.stopPropagation();
          props.onAction();
        }}
      >
        {props.actionLabel}
      </button>
    </div>
  );
}

// ---------------------------------------------------------------- inspector

function InspectorDock(props: {
  store: SceneStore;
  registry: ComponentRegistry;
  selection: Selection;
  assets: AssetLibrary;
  assetSelection: AssetSelection;
  assetsVersion: Observable<number>;
  saveAsset?: (file: string, content: string) => void;
}) {
  const doc = useStoreDoc(props.store);
  const selected = useObservable(props.selection);
  const selectedAsset = useObservable(props.assetSelection);
  useObservable(props.assetsVersion);
  const entity = selected ? doc.entities[selected] : undefined;

  const title =
    selected && entity
      ? `Inspector — ${entity.name}`
      : selectedAsset
        ? `Inspector — ${selectedAsset.kind}: ${selectedAsset.id}`
        : "Inspector";

  return (
    <>
      <DockHeader title={title} />
      <div style={{ flex: 1, overflowY: "auto", padding: 8 }}>
        {selected && entity ? (
          <Inspector id={selected} doc={doc} store={props.store} registry={props.registry} />
        ) : selectedAsset ? (
          <AssetInspector
            selection={selectedAsset}
            assets={props.assets}
            assetsVersion={props.assetsVersion}
            saveAsset={props.saveAsset}
          />
        ) : (
          <div style={{ color: "#8b949e" }}>
            Select an entity (viewport/hierarchy) or an asset (assets panel)
          </div>
        )}
      </div>
    </>
  );
}

function Inspector(props: {
  id: string;
  doc: SceneDoc;
  store: SceneStore;
  registry: ComponentRegistry;
}) {
  const entity = props.doc.entities[props.id]!;
  const [addChoice, setAddChoice] = useState("");
  const available = props.registry.names().filter((name) => !(name in entity.components));

  return (
    <div>
      <Row label="name">
        <TextField
          value={entity.name}
          onCommit={(name) =>
            name.length > 0 && apply(props.store, [{ op: "rename", id: props.id, name }])
          }
        />
      </Row>
      <Row label="id">
        <span style={{ color: "#8b949e", fontSize: 10 }}>{props.id}</span>
      </Row>
      <Row label="tags">
        <TextField
          value={entity.tags.join(", ")}
          onCommit={(text) =>
            apply(props.store, [
              {
                op: "set-tags",
                id: props.id,
                tags: text.split(",").map((t) => t.trim()).filter(Boolean),
              },
            ])
          }
        />
      </Row>

      {Object.entries(entity.components).map(([name, data]) => (
        <div key={name} style={{ marginTop: 10 }}>
          <div style={{ display: "flex", justifyContent: "space-between" }}>
            <strong style={{ color: "#d2a8ff" }}>{name}</strong>
            <span
              style={{ color: "#8b949e", cursor: "pointer" }}
              title="Remove component"
              onClick={() =>
                apply(props.store, [{ op: "remove-component", id: props.id, component: name }])
              }
            >
              ✕
            </span>
          </div>
          <ValueField
            value={data}
            onCommit={(next) =>
              apply(props.store, [
                { op: "set-component", id: props.id, component: name, data: next },
              ])
            }
          />
        </div>
      ))}

      <div style={{ display: "flex", gap: 6, marginTop: 12 }}>
        <select
          style={{ ...buttonStyle, flex: 1 }}
          value={addChoice}
          onChange={(e) => setAddChoice(e.target.value)}
        >
          <option value="">add component…</option>
          {available.map((name) => (
            <option key={name} value={name}>
              {name}
            </option>
          ))}
        </select>
        <button
          style={buttonStyle}
          disabled={addChoice === ""}
          onClick={() => {
            apply(props.store, [
              {
                op: "set-component",
                id: props.id,
                component: addChoice,
                data: componentSeeds[addChoice] ?? {},
              },
            ]);
            setAddChoice("");
          }}
        >
          add
        </button>
      </div>
    </div>
  );
}

function AssetInspector(props: {
  selection: { kind: "material" | "prefab" | "model"; id: string };
  assets: AssetLibrary;
  assetsVersion: Observable<number>;
  saveAsset?: (file: string, content: string) => void;
}) {
  const bump = () => props.assetsVersion.set(props.assetsVersion.get() + 1);
  const { kind, id } = props.selection;

  if (kind === "material") {
    const asset = props.assets.getDataAsset(id);
    if (!asset) return <div style={{ color: "#8b949e" }}>Missing material {id}</div>;
    const data = asset.data as {
      shader: string;
      color: string;
      roughness: number;
      metalness: number;
      emissive: string;
      emissiveIntensity: number;
      opacity: number;
      transparent: boolean;
    };
    const commit = (patch: Record<string, unknown>) => {
      try {
        const stored = props.assets.updateDataAsset({ ...asset, data: { ...data, ...patch } });
        props.saveAsset?.(`materials/${id}.json`, JSON.stringify(stored.data, null, 2));
        bump();
      } catch (error) {
        console.warn("[editor] material update rejected:", error);
      }
    };
    return (
      <div>
        <div style={{ color: "#8b949e", fontSize: 10, marginBottom: 8 }}>
          assets/materials/{id}.json — edits apply live to every mesh using it
        </div>
        <Row label="shader">
          <select
            style={{ ...buttonStyle, width: "100%" }}
            value={data.shader}
            onChange={(e) => commit({ shader: e.target.value })}
          >
            {["standard", "unlit", "toon", "wireframe"].map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </Row>
        <Row label="color">
          <ColorField value={data.color} onCommit={(v) => commit({ color: v })} />
        </Row>
        {data.shader === "standard" && (
          <>
            <Row label="roughness">
              <SliderField value={data.roughness} min={0} max={1} onCommit={(v) => commit({ roughness: v })} />
            </Row>
            <Row label="metalness">
              <SliderField value={data.metalness} min={0} max={1} onCommit={(v) => commit({ metalness: v })} />
            </Row>
          </>
        )}
        {(data.shader === "standard" || data.shader === "toon") && (
          <>
            <Row label="emissive">
              <ColorField value={data.emissive} onCommit={(v) => commit({ emissive: v })} />
            </Row>
            <Row label="glow">
              <SliderField
                value={data.emissiveIntensity}
                min={0}
                max={10}
                step={0.1}
                onCommit={(v) => commit({ emissiveIntensity: v })}
              />
            </Row>
          </>
        )}
        <Row label="opacity">
          <SliderField value={data.opacity} min={0} max={1} onCommit={(v) => commit({ opacity: v })} />
        </Row>
        <Row label="transparent">
          <input
            type="checkbox"
            checked={data.transparent}
            onChange={(e) => commit({ transparent: e.target.checked })}
          />
        </Row>
      </div>
    );
  }

  if (kind === "prefab") {
    const prefab = props.assets.getPrefab(id);
    if (!prefab) return <div style={{ color: "#8b949e" }}>Missing prefab {id}</div>;
    return (
      <PrefabInspector
        id={id}
        assets={props.assets}
        onSaved={(stored) => {
          props.saveAsset?.(`prefabs/${id}.json`, JSON.stringify(stored, null, 2));
          bump();
        }}
      />
    );
  }

  const model = props.assets.getModel(id);
  if (!model) return <div style={{ color: "#8b949e" }}>Missing model {id}</div>;
  return (
    <div>
      <Row label="name">
        <span>{model.name}</span>
      </Row>
      <Row label="url">
        <span style={{ color: "#8b949e", fontSize: 10, wordBreak: "break-all" }}>{model.url}</span>
      </Row>
      <div style={{ color: "#8b949e", fontSize: 10, marginTop: 6 }}>
        glTF/GLB from assets/models/ — rendered thumbnails come with the asset viewer.
      </div>
    </div>
  );
}

function PrefabInspector(props: {
  id: string;
  assets: AssetLibrary;
  onSaved: (stored: unknown) => void;
}) {
  const prefab = props.assets.getPrefab(props.id)!;

  const update = (mutate: (draft: typeof prefab) => void): void => {
    const draft = structuredClone(prefab);
    mutate(draft);
    try {
      const stored = props.assets.updatePrefab(props.id, draft);
      props.onSaved(stored);
    } catch (error) {
      console.warn("[editor] prefab edit rejected:", error);
    }
  };

  const rows: Array<{ localId: string; depth: number }> = [];
  const walk = (parent: string | null, depth: number) => {
    for (const [localId, entity] of Object.entries(prefab.entities)) {
      if (entity.parent === parent) {
        rows.push({ localId, depth });
        walk(localId, depth + 1);
      }
    }
  };
  walk(null, 0);

  return (
    <div>
      <div style={{ color: "#8b949e", fontSize: 10, marginBottom: 8 }}>
        assets/prefabs/{props.id}.json · edits propagate to all instances
      </div>

      <Row label="name">
        <TextField
          value={prefab.name}
          onCommit={(name) => name.length > 0 && update((d) => void (d.name = name))}
        />
      </Row>

      <div style={{ marginTop: 12 }}>
        <strong style={{ color: "#e6edf3" }}>Props</strong>
        {Object.keys(prefab.props).length === 0 && (
          <div style={{ color: "#8b949e", fontSize: 11, marginTop: 2 }}>
            none — props expose tunable values (see prefab-streetlight.json for the shape)
          </div>
        )}
        {Object.entries(prefab.props).map(([name, spec]) => (
          <div key={name} style={{ marginTop: 6, padding: 6, background: "#161b22", borderRadius: 3 }}>
            <div style={{ display: "flex", justifyContent: "space-between" }}>
              <strong style={{ color: "#e3b341" }}>{name}</strong>
              <span
                style={{ color: "#8b949e", cursor: "pointer" }}
                title="Remove prop"
                onClick={() => update((d) => void delete d.props[name])}
              >
                ✕
              </span>
            </div>
            <Row label="default">
              <ValueField
                value={spec.default}
                onCommit={(v) => update((d) => void (d.props[name]!.default = v))}
              />
            </Row>
            <div style={{ color: "#8b949e", fontSize: 10 }}>
              → {spec.bindings.join(", ") || "(no bindings)"}
            </div>
          </div>
        ))}
      </div>

      <div style={{ marginTop: 12 }}>
        <strong style={{ color: "#e6edf3" }}>Entities</strong>
        {rows.map(({ localId, depth }) => {
          const entity = prefab.entities[localId]!;
          return (
            <div
              key={localId}
              style={{
                marginTop: 6,
                marginLeft: depth * 12,
                padding: 6,
                background: "#161b22",
                borderRadius: 3,
              }}
            >
              <div style={{ display: "flex", justifyContent: "space-between" }}>
                <span>
                  · {entity.name}
                  {localId === prefab.root && (
                    <span style={{ color: "#8b949e", fontSize: 10 }}> (root)</span>
                  )}
                </span>
                <span style={{ color: "#8b949e", fontSize: 10 }}>{localId}</span>
              </div>
              {Object.entries(entity.components).map(([comp, data]) => (
                <div key={comp} style={{ marginTop: 4 }}>
                  <strong style={{ color: "#d2a8ff", fontSize: 11 }}>{comp}</strong>
                  <ValueField
                    value={data}
                    onCommit={(next) =>
                      update((d) => void (d.entities[localId]!.components[comp] = next))
                    }
                  />
                </div>
              ))}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- context menu

function ContextMenuView(props: {
  store: SceneStore;
  selection: Selection;
  contextMenu: ContextMenu;
  onCreatePrefab: (entityId: string) => void;
}) {
  const menu = useObservable(props.contextMenu);
  if (!menu) return null;

  const close = () => props.contextMenu.set(null);
  const id = menu.entityId;

  const item = (label: string, onClick: () => void, disabled = false) => (
    <div
      key={label}
      onClick={() => {
        if (disabled) return;
        onClick();
        close();
      }}
      style={{
        padding: "3px 12px",
        cursor: disabled ? "default" : "pointer",
        color: disabled ? "#484f58" : "#c9d1d9",
      }}
      onMouseEnter={(e) => !disabled && ((e.target as HTMLElement).style.background = "#1f3a5f")}
      onMouseLeave={(e) => ((e.target as HTMLElement).style.background = "transparent")}
    >
      {label}
    </div>
  );

  return (
    <>
      <div
        onClick={close}
        onContextMenu={(e) => {
          e.preventDefault();
          close();
        }}
        style={{ position: "fixed", inset: 0, zIndex: 5000 }}
      />
      <div
        style={{
          position: "fixed",
          left: Math.min(menu.x, window.innerWidth - 180),
          top: Math.min(menu.y, window.innerHeight - 160),
          zIndex: 5001,
          minWidth: 160,
          background: "rgba(13, 17, 23, 0.97)",
          border: "1px solid #30363d",
          borderRadius: 3,
          font: "12px ui-monospace, monospace",
          padding: "4px 0",
        }}
      >
        {item("add child entity", () =>
          apply(props.store, [
            {
              op: "add-entity",
              id: newId(),
              entity: { name: "New Entity", parent: id, tags: [], components: { transform: {} } },
            },
          ]),
        )}
        {item(
          "duplicate  (Ctrl+D)",
          () => {
            if (!id) return;
            const ops = duplicateSubtree(props.store.doc, id);
            apply(props.store, ops);
            if (ops[0]?.op === "add-entity") props.selection.set(ops[0].id);
          },
          !id,
        )}
        {item(
          "create prefab from this",
          () => id && props.onCreatePrefab(id),
          !id || "prefab" in (props.store.doc.entities[id]?.components ?? {}),
        )}
        {item(
          "delete  (Del)",
          () => {
            if (!id) return;
            props.selection.set(null);
            apply(props.store, [{ op: "remove-entity", id }]);
          },
          !id,
        )}
        {item("deselect", () => props.selection.set(null))}
      </div>
    </>
  );
}

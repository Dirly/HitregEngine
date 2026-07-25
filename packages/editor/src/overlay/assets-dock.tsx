import { useState } from "react";
import { newId, type AssetLibrary, type Op, type SceneStore } from "@hitreg/core";
import type { AssetSelection, MultiSelection, Observable, Selection } from "../state.js";
import { applyMaterialToMany } from "../selection-ops.js";
import { apply, buttonStyle, DockHeader, SearchInput, useObservable } from "./common.js";

const ASSET_FOLDERS_KEY = "hitreg-asset-folders";
const ASSET_FOLDERS_OPEN_KEY = "hitreg-asset-folders-open";

interface FolderNode {
  name: string;
  path: string;
  children: FolderNode[];
}

/** Build a nested folder tree from slash-delimited folder paths (adds missing ancestors). */
function buildFolderTree(paths: Iterable<string>): FolderNode[] {
  const root: FolderNode = { name: "", path: "", children: [] };
  const byPath = new Map<string, FolderNode>([["", root]]);
  for (const raw of paths) {
    if (!raw) continue;
    let parent = root;
    let path = "";
    for (const seg of raw.split("/").filter(Boolean)) {
      path = path ? `${path}/${seg}` : seg;
      let node = byPath.get(path);
      if (!node) {
        node = { name: seg, path, children: [] };
        byPath.set(path, node);
        parent.children.push(node);
      }
      parent = node;
    }
  }
  const sortRec = (nodes: FolderNode[]): void => {
    nodes.sort((a, b) => a.name.localeCompare(b.name));
    for (const n of nodes) sortRec(n.children);
  };
  sortRec(root.children);
  return root.children;
}

function FolderRow(props: {
  node: FolderNode;
  depth: number;
  selected: string;
  open: Record<string, boolean>;
  onToggle: (path: string) => void;
  onSelect: (path: string) => void;
}) {
  const hasChildren = props.node.children.length > 0;
  const isOpen = !!props.open[props.node.path];
  const isSelected = props.selected === props.node.path;
  return (
    <>
      <div
        onClick={() => props.onSelect(props.node.path)}
        title={props.node.path}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 4,
          padding: "2px 4px",
          paddingLeft: 4 + props.depth * 14,
          cursor: "pointer",
          borderRadius: 3,
          background: isSelected ? "#1f3a5f" : "transparent",
          color: isSelected ? "#e6edf3" : "#c9d1d9",
          whiteSpace: "nowrap",
        }}
      >
        <span
          onClick={(e) => {
            if (!hasChildren) return;
            e.stopPropagation();
            props.onToggle(props.node.path);
          }}
          title={hasChildren ? (isOpen ? "Collapse" : "Expand") : undefined}
          style={{ width: 12, flexShrink: 0, color: "#8b949e", textAlign: "center" }}
        >
          {hasChildren ? (isOpen ? "▾" : "▸") : ""}
        </span>
        <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>{props.node.name}</span>
      </div>
      {hasChildren &&
        isOpen &&
        props.node.children.map((child) => (
          <FolderRow {...props} key={child.path} node={child} depth={props.depth + 1} />
        ))}
    </>
  );
}

/** A labelled group of asset cards (one per asset type). */
function AssetSection(props: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 8 }}>
      <div style={{ color: "#8b949e", fontSize: 10, marginBottom: 4 }}>{props.label}</div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>{props.children}</div>
    </div>
  );
}

export function AssetsDock(props: {
  assets: AssetLibrary;
  store: SceneStore;
  selection: Selection;
  multiSelection: MultiSelection;
  assetSelection: AssetSelection;
  assetsVersion: Observable<number>;
  thumbnails: Observable<Record<string, string>>;
  onCreateMaterial: (folder: string) => void;
  onCreateSpritesheet: (folder: string) => void;
  onCreatePrefab: (entityId: string, folder: string) => void;
  onSetSky: (textureId: string) => void;
}) {
  useObservable(props.assetsVersion);
  const thumbnails = useObservable(props.thumbnails);
  const selectedEntity = useObservable(props.selection);
  const multiSelected = useObservable(props.multiSelection);
  const selectedAsset = useObservable(props.assetSelection);
  const [query, setQuery] = useState("");
  const [folder, setFolder] = useState("");
  const [userFolders, setUserFolders] = useState<string[]>(() => {
    try {
      return JSON.parse(localStorage.getItem(ASSET_FOLDERS_KEY) ?? "[]") as string[];
    } catch {
      return [];
    }
  });
  const [openFolders, setOpenFolders] = useState<Record<string, boolean>>(() => {
    try {
      const paths = JSON.parse(localStorage.getItem(ASSET_FOLDERS_OPEN_KEY) ?? "[]") as string[];
      return Object.fromEntries(paths.map((p) => [p, true]));
    } catch {
      return {};
    }
  });
  const q = query.toLowerCase();

  const persistOpen = (next: Record<string, boolean>) => {
    setOpenFolders(next);
    try {
      localStorage.setItem(
        ASSET_FOLDERS_OPEN_KEY,
        JSON.stringify(Object.keys(next).filter((p) => next[p])),
      );
    } catch {
      /* non-fatal */
    }
  };

  const toggleFolder = (path: string) =>
    persistOpen({ ...openFolders, [path]: !openFolders[path] });

  /** Select a folder and expand it plus every ancestor so it stays visible. */
  const selectFolder = (path: string) => {
    setFolder(path);
    if (!path) return;
    const next = { ...openFolders };
    let prefix = "";
    for (const seg of path.split("/")) {
      prefix = prefix ? `${prefix}/${seg}` : seg;
      next[prefix] = true;
    }
    persistOpen(next);
  };

  const folderOf = (id: string) => (id.includes("/") ? id.slice(0, id.lastIndexOf("/")) : "");
  // prefix match: a folder shows its own assets plus everything in descendants
  const inFolder = (id: string) => {
    if (folder === "") return true;
    const f = folderOf(id);
    return f === folder || f.startsWith(folder + "/");
  };

  const prefabIds = props.assets
    .prefabIds()
    .filter((id) => inFolder(id) && props.assets.getPrefab(id)!.name.toLowerCase().includes(q));
  const modelIds = props.assets
    .modelIds()
    .filter((id) => inFolder(id) && props.assets.getModel(id)!.name.toLowerCase().includes(q));
  const materials = props.assets
    .dataAssetsOfType("material")
    .filter((a) => inFolder(a.id) && a.name.toLowerCase().includes(q));
  const spritesheets = props.assets
    .dataAssetsOfType("spritesheet")
    .filter((a) => inFolder(a.id) && a.name.toLowerCase().includes(q));
  const textureIds = props.assets
    .textureIds()
    .filter((id) => inFolder(id) && id.toLowerCase().includes(q));
  const soundIds = props.assets
    .soundIds()
    .filter((sid) => inFolder(sid) && sid.toLowerCase().includes(q));

  const allIds = [
    ...props.assets.prefabIds(),
    ...props.assets.modelIds(),
    ...props.assets.textureIds(),
    ...props.assets.soundIds(),
    ...props.assets.dataAssetsOfType("material").map((a) => a.id),
    ...props.assets.dataAssetsOfType("spritesheet").map((a) => a.id),
  ];
  const tree = buildFolderTree([...allIds.map(folderOf).filter(Boolean), ...userFolders]);

  const addFolder = () => {
    const name = window
      .prompt(
        `New folder${folder ? ` in ${folder}/` : ""} (a-z, 0-9, dashes; use / to nest):`,
      )
      ?.toLowerCase()
      .replace(/[^a-z0-9/-]+/g, "-")
      .replace(/\/{2,}/g, "/")
      .replace(/^[-/]+|[-/]+$/g, "");
    if (!name) return;
    const path = folder ? `${folder}/${name}` : name;
    const next = [...new Set([...userFolders, path])];
    setUserFolders(next);
    try {
      localStorage.setItem(ASSET_FOLDERS_KEY, JSON.stringify(next));
    } catch {
      /* non-fatal */
    }
    selectFolder(path);
  };

  const instantiate = (ops: Op[], selectId: string) => {
    apply(props.store, ops);
    props.assetSelection.set(null);
    props.selection.set(selectId);
  };

  const select = (kind: "material" | "prefab" | "model" | "texture" | "spritesheet", id: string) => {
    props.selection.set(null);
    props.assetSelection.set({ kind, id });
  };

  const applyMaterialToSelection = (materialId: string) => {
    const ids = multiSelected.length > 1 ? multiSelected : selectedEntity ? [selectedEntity] : [];
    if (ids.length === 0) return;
    applyMaterialToMany(props.store, props.store.doc, ids, materialId);
  };

  const crumbs = folder ? folder.split("/") : [];
  const empty =
    prefabIds.length === 0 &&
    modelIds.length === 0 &&
    materials.length === 0 &&
    spritesheets.length === 0 &&
    textureIds.length === 0 &&
    soundIds.length === 0;

  return (
    <>
      <DockHeader title="Assets">
        <span title="Search within the selected folder (and its subfolders)">
          <SearchInput value={query} onChange={setQuery} />
        </span>
        <button
          style={buttonStyle}
          title={`New material asset${folder ? ` in ${folder}/` : ""}`}
          onClick={() => props.onCreateMaterial(folder)}
        >
          + material
        </button>
        <button
          style={buttonStyle}
          title={
            props.assets.textureIds().length === 0
              ? "Add a texture (assets/textures/) first — a spritesheet slices one"
              : `New spritesheet asset${folder ? ` in ${folder}/` : ""}`
          }
          disabled={props.assets.textureIds().length === 0}
          onClick={() => props.onCreateSpritesheet(folder)}
        >
          + spritesheet
        </button>
        <button
          style={buttonStyle}
          title={`Create a prefab from the selected entity${folder ? ` in ${folder}/` : ""}`}
          disabled={!selectedEntity}
          onClick={() => selectedEntity && props.onCreatePrefab(selectedEntity, folder)}
        >
          + prefab
        </button>
        <button
          style={buttonStyle}
          title={`New folder${folder ? ` inside ${folder}/` : ""}`}
          onClick={addFolder}
        >
          + folder
        </button>
      </DockHeader>
      <div style={{ display: "flex", flex: 1, minHeight: 0 }}>
        {/* folder tree — scrolls independently of the card grid */}
        <div
          style={{
            width: 190,
            flexShrink: 0,
            overflowY: "auto",
            overflowX: "hidden",
            borderRight: "1px solid #21262d",
            padding: 4,
          }}
        >
          <div
            onClick={() => selectFolder("")}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 4,
              padding: "2px 4px",
              cursor: "pointer",
              borderRadius: 3,
              background: folder === "" ? "#1f3a5f" : "transparent",
              color: folder === "" ? "#e6edf3" : "#c9d1d9",
              whiteSpace: "nowrap",
            }}
          >
            <span style={{ width: 12, flexShrink: 0 }} />
            <span>assets</span>
          </div>
          {tree.map((node) => (
            <FolderRow
              key={node.path}
              node={node}
              depth={1}
              selected={folder}
              open={openFolders}
              onToggle={toggleFolder}
              onSelect={selectFolder}
            />
          ))}
        </div>
        {/* breadcrumb + cards */}
        <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", minHeight: 0 }}>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 3,
              padding: "3px 8px",
              borderBottom: "1px solid #21262d",
              flexShrink: 0,
              whiteSpace: "nowrap",
              overflowX: "auto",
              fontSize: 11,
            }}
          >
            <span
              onClick={() => selectFolder("")}
              style={{
                cursor: "pointer",
                color: folder === "" ? "#e6edf3" : "#8b949e",
              }}
            >
              assets
            </span>
            {crumbs.map((seg, i) => {
              const path = crumbs.slice(0, i + 1).join("/");
              const last = i === crumbs.length - 1;
              return (
                <span key={path} style={{ display: "flex", gap: 3 }}>
                  <span style={{ color: "#8b949e" }}>/</span>
                  <span
                    onClick={() => selectFolder(path)}
                    style={{ cursor: last ? "default" : "pointer", color: last ? "#e6edf3" : "#8b949e" }}
                  >
                    {seg}
                  </span>
                </span>
              );
            })}
          </div>
          <div style={{ flex: 1, overflowY: "auto", padding: 8 }}>
            {empty && (
              <div style={{ color: "#8b949e" }}>
                {query
                  ? "No assets match."
                  : folder
                    ? "Folder is empty — new materials/prefabs land in the selected folder."
                    : "Create materials/prefabs here; drop .glb in assets/models/, images in assets/textures/"}
              </div>
            )}
            {materials.length > 0 && (
              <AssetSection label="materials">
                {materials.map((mat) => {
                  const color = (mat.data as { color?: string }).color ?? "#9aa0a8";
                  return (
                    <AssetCard
                      key={mat.id}
                      swatch={color}
                      thumbnail={thumbnails[mat.id]}
                      color="#e3b341"
                      name={mat.name.split("/").pop()!}
                      kind="material"
                      dragPayload={{ kind: "material", id: mat.id }}
                      selected={selectedAsset?.kind === "material" && selectedAsset.id === mat.id}
                      onSelect={() => select("material", mat.id)}
                      actionLabel="apply to selection"
                      actionDisabled={!selectedEntity}
                      onAction={() => applyMaterialToSelection(mat.id)}
                    />
                  );
                })}
              </AssetSection>
            )}
            {spritesheets.length > 0 && (
              <AssetSection label="spritesheets">
                {spritesheets.map((sheet) => {
                  const textureId = (sheet.data as { texture?: string }).texture;
                  const thumbnail = textureId ? props.assets.getTexture(textureId)?.url : undefined;
                  return (
                    <AssetCard
                      key={sheet.id}
                      thumbnail={thumbnail}
                      glyph="▦"
                      color="#d2a8ff"
                      name={sheet.name.split("/").pop()!}
                      kind="spritesheet"
                      selected={selectedAsset?.kind === "spritesheet" && selectedAsset.id === sheet.id}
                      onSelect={() => select("spritesheet", sheet.id)}
                      actionLabel="edit frames"
                      onAction={() => select("spritesheet", sheet.id)}
                    />
                  );
                })}
              </AssetSection>
            )}
            {prefabIds.length > 0 && (
              <AssetSection label="prefabs">
                {prefabIds.map((pid) => (
                  <AssetCard
                    key={pid}
                    glyph="◆"
                    color="#79c0ff"
                    name={props.assets.getPrefab(pid)!.name}
                    kind="prefab"
                    thumbnail={thumbnails[pid]}
                    dragPayload={{ kind: "prefab", id: pid }}
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
              </AssetSection>
            )}
            {textureIds.length > 0 && (
              <AssetSection label="textures">
                {textureIds.map((tid) => (
                  <AssetCard
                    key={tid}
                    thumbnail={props.assets.getTexture(tid)!.url}
                    color="#ffa657"
                    name={props.assets.getTexture(tid)!.name}
                    kind="texture"
                    selected={selectedAsset?.kind === "texture" && selectedAsset.id === tid}
                    onSelect={() => select("texture", tid)}
                    actionLabel="set as sky"
                    onAction={() => props.onSetSky(tid)}
                  />
                ))}
              </AssetSection>
            )}
            {soundIds.length > 0 && (
              <AssetSection label="audio">
                {soundIds.map((sid) => (
                  <AssetCard
                    key={sid}
                    glyph="♪"
                    color="#f778ba"
                    name={props.assets.getSound(sid)!.name}
                    kind="sound"
                    selected={false}
                    onSelect={() => new Audio(props.assets.getSound(sid)!.url).play()}
                    actionLabel="▶ preview"
                    onAction={() => new Audio(props.assets.getSound(sid)!.url).play()}
                  />
                ))}
              </AssetSection>
            )}
            {modelIds.length > 0 && (
              <AssetSection label="models">
                {modelIds.map((mid) => (
                  <AssetCard
                    key={mid}
                    glyph="▣"
                    thumbnail={thumbnails[mid]}
                    color="#7ee787"
                    name={props.assets.getModel(mid)!.name}
                    kind="model"
                    dragPayload={{ kind: "model", id: mid }}
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
              </AssetSection>
            )}
          </div>
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
  /** Enables drag & drop into the viewport (spawn / assign material). */
  dragPayload?: { kind: string; id: string };
}) {
  return (
    <div
      onClick={props.onSelect}
      draggable={!!props.dragPayload}
      onDragStart={(e) => {
        if (props.dragPayload) {
          e.dataTransfer.setData("application/x-hitreg-asset", JSON.stringify(props.dragPayload));
          e.dataTransfer.effectAllowed = "copy";
        }
      }}
      title={props.dragPayload ? "Drag into the viewport" : undefined}
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

import { useState } from "react";
import { childrenOf, newId, type SceneDoc, type SceneStore } from "@hitreg/core";
import {
  observable,
  rangeSelectTo,
  selectSingle,
  toggleSelection,
  type AssetSelection,
  type ContextMenu,
  type MultiSelection,
  type Observable,
  type Selection,
} from "../state.js";
import { applyMaterialToMany } from "../selection-ops.js";
import { apply, buttonStyle, DockHeader, SearchInput, useObservable, useStoreDoc } from "./common.js";

/** Flat, depth-first visible order (roots then children) — used for shift-range selection. */
function flattenIds(doc: SceneDoc, parent: string | null = null): string[] {
  const out: string[] = [];
  for (const id of childrenOf(doc, parent)) {
    out.push(id, ...flattenIds(doc, id));
  }
  return out;
}

/** Drag payload for a row: a lone id, or (when the row is part of a >1 multi-selection) the whole set. */
const DRAG_MIME = "application/x-hitreg-entities";

/** Reads the dragged entity id(s) off a hierarchy-row drag, however they were encoded. */
function draggedEntityIds(e: React.DragEvent): string[] {
  const multi = e.dataTransfer.getData(DRAG_MIME);
  if (multi) {
    try {
      const ids = JSON.parse(multi) as unknown;
      if (Array.isArray(ids)) return ids.filter((id): id is string => typeof id === "string");
    } catch {
      /* fall through to plain id */
    }
  }
  const single = e.dataTransfer.getData("text/plain");
  return single ? [single] : [];
}

/** One streamed-in chunk cell, collapsed to a single row — never exploded
 * into its (possibly hundreds of) individual entities. */
export interface LoadedChunkCell {
  world: string;
  cx: number;
  cz: number;
  count: number;
}

const EMPTY_CHUNK_CELLS: Observable<LoadedChunkCell[]> = observable([]);

export function HierarchyDock(props: {
  store: SceneStore;
  selection: Selection;
  multiSelection: MultiSelection;
  assetSelection: AssetSelection;
  contextMenu: ContextMenu;
  onFocusEntity?: (entityId: string) => void;
  /** Currently-loaded chunk cells (reflects proximity automatically — only
   * ever holds cells within the active streaming rings), shown as a
   * "chunk sections" list above the normal tree. */
  loadedChunkCells?: Observable<LoadedChunkCell[]>;
  /** Double-clicked a chunk section — opens it for isolation editing. */
  onEditChunkCell?: (world: string, cx: number, cz: number) => void;
}) {
  const doc = useStoreDoc(props.store);
  const selected = useObservable(props.selection);
  const multiIds = useObservable(props.multiSelection);
  const chunkCells = useObservable(props.loadedChunkCells ?? EMPTY_CHUNK_CELLS);
  const [query, setQuery] = useState("");

  // "#tag" searches tags; anything else searches names
  const q = query.toLowerCase();
  const matches = query
    ? Object.entries(doc.entities)
        .filter(([, e]) =>
          q.startsWith("#")
            ? e.tags.some((t) => t.toLowerCase().includes(q.slice(1)))
            : e.name.toLowerCase().includes(q),
        )
        .map(([id]) => id)
    : null;
  const orderedIds = matches ?? flattenIds(doc);

  return (
    <>
      <DockHeader title={`Hierarchy — ${doc.name}`}>
        <span title={'Search names, or "#tag" to search tags'}>
          <SearchInput value={query} onChange={setQuery} />
        </span>
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
          const raw = e.dataTransfer.getData("application/x-hitreg-asset");
          if (raw) return; // asset drops (e.g. materials) have no target here
          const dragged = draggedEntityIds(e);
          if (dragged.length > 0) {
            apply(
              props.store,
              dragged.map((id) => ({ op: "reparent", id, parent: null })),
            );
          }
        }}
      >
        {chunkCells.length > 0 && (
          <div style={{ marginBottom: 8 }}>
            <div style={{ color: "#8b949e", fontSize: 10, marginBottom: 2 }}>
              streamed chunks · double-click to edit
            </div>
            {chunkCells.map((cell) => (
              <div
                key={`${cell.world}:${cell.cx}_${cell.cz}`}
                onDoubleClick={() => props.onEditChunkCell?.(cell.world, cell.cx, cell.cz)}
                title={`Edit ${cell.world} ${cell.cx}_${cell.cz} (${cell.count} entities)`}
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  padding: "2px 4px",
                  cursor: "pointer",
                  borderRadius: 3,
                  color: "#d29922",
                }}
              >
                <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  ▤ {cell.world} · {cell.cx}_{cell.cz}
                </span>
                <span style={{ color: "#8b949e", fontSize: 10 }}>{cell.count}</span>
              </div>
            ))}
          </div>
        )}
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
              multiIds={multiIds}
              orderedIds={orderedIds}
              selection={props.selection}
              multiSelection={props.multiSelection}
              assetSelection={props.assetSelection}
              store={props.store}
              contextMenu={props.contextMenu}
              onFocusEntity={props.onFocusEntity}
            />
          ))
        ) : (
          <Tree
            doc={doc}
            parent={null}
            depth={0}
            selected={selected}
            multiIds={multiIds}
            orderedIds={orderedIds}
            selection={props.selection}
            multiSelection={props.multiSelection}
            assetSelection={props.assetSelection}
            store={props.store}
            contextMenu={props.contextMenu}
            onFocusEntity={props.onFocusEntity}
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
  multiIds: string[];
  orderedIds: string[];
  selection: Selection;
  multiSelection: MultiSelection;
  assetSelection: AssetSelection;
  store: SceneStore;
  contextMenu: ContextMenu;
  onFocusEntity?: (entityId: string) => void;
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
  const isPrimary = props.id === props.selected;
  const isMultiMember = props.multiIds.includes(props.id);
  const isPrefab = "prefab" in entity.components;
  const isLocked = entity.locked === true;
  const dragIds = isMultiMember && props.multiIds.length > 1 ? props.multiIds : [props.id];
  return (
    <div
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData("text/plain", props.id);
        if (dragIds.length > 1) e.dataTransfer.setData(DRAG_MIME, JSON.stringify(dragIds));
      }}
      onDragOver={(e) => {
        e.preventDefault();
        e.stopPropagation();
      }}
      onDrop={(e) => {
        e.stopPropagation();
        const raw = e.dataTransfer.getData("application/x-hitreg-asset");
        if (raw) {
          // material dropped from the Assets dock: assign it (to the whole
          // multi-selection when this row is one of its members)
          try {
            const payload = JSON.parse(raw) as { kind: string; id: string };
            if (payload.kind === "material") {
              const targets = isMultiMember && props.multiIds.length > 1 ? props.multiIds : [props.id];
              applyMaterialToMany(props.store, props.doc, targets, payload.id);
            }
          } catch (error) {
            console.warn("[editor] asset drop failed:", error);
          }
          return;
        }
        const dragged = draggedEntityIds(e).filter((id) => id !== props.id);
        if (dragged.length > 0) {
          apply(
            props.store,
            dragged.map((id) => ({ op: "reparent", id, parent: props.id })),
          );
        }
      }}
      onClick={(e) => {
        props.assetSelection.set(null);
        if (e.shiftKey) rangeSelectTo(props.selection, props.multiSelection, props.orderedIds, props.id);
        else if (e.ctrlKey || e.metaKey) toggleSelection(props.selection, props.multiSelection, props.id);
        else selectSingle(props.selection, props.multiSelection, props.id);
      }}
      onDoubleClick={() => {
        // frame the entity in the viewport (Unity double-click)
        props.onFocusEntity?.(props.id);
        // ...and if it's a prefab instance, open its definition too
        const prefabId = (entity.components["prefab"] as { prefabId?: string } | undefined)
          ?.prefabId;
        if (prefabId) {
          props.selection.set(null);
          props.multiSelection.set([]);
          props.assetSelection.set({ kind: "prefab", id: prefabId });
        }
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        if (!isMultiMember) selectSingle(props.selection, props.multiSelection, props.id);
        props.contextMenu.set({ x: e.clientX, y: e.clientY, entityId: props.id });
      }}
      style={{
        display: "flex",
        justifyContent: "space-between",
        alignItems: "center",
        padding: "2px 4px",
        paddingLeft: 4 + props.depth * 14,
        cursor: "pointer",
        borderRadius: 3,
        background: isPrimary ? "#1f3a5f" : isMultiMember ? "#17293f" : "transparent",
        color: isLocked ? "#6e7681" : isPrefab ? "#79c0ff" : "#c9d1d9",
      }}
    >
      <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
        {isPrefab ? "◆ " : "· "}
        {entity.name}
        {entity.tags.map((tag) => (
          <span
            key={tag}
            style={{
              marginLeft: 4,
              padding: "0 4px",
              borderRadius: 3,
              background: "#21262d",
              color: "#8b949e",
              fontSize: 9,
            }}
          >
            #{tag}
          </span>
        ))}
      </span>
      <span
        style={{ color: isLocked ? "#d29922" : "#484f58", cursor: "pointer", flexShrink: 0, marginLeft: 4 }}
        title={isLocked ? "Unlock (allow viewport click/drag)" : "Lock (protect from viewport click/drag)"}
        onClick={(e) => {
          e.stopPropagation();
          apply(props.store, [{ op: "set-locked", id: props.id, locked: !isLocked }]);
        }}
      >
        ⚿
      </span>
    </div>
  );
}

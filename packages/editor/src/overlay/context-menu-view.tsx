import { newId, type SceneStore } from "@hitreg/core";
import type { ContextMenu, MultiSelection, Selection } from "../state.js";
import { deleteMany, duplicateMany, toggleLockMany } from "../selection-ops.js";
import { apply, useObservable } from "./common.js";

export function ContextMenuView(props: {
  store: SceneStore;
  selection: Selection;
  multiSelection: MultiSelection;
  contextMenu: ContextMenu;
  onCreatePrefab: (entityId: string) => void;
  onUnpackModel?: (entityId: string) => void;
}) {
  const menu = useObservable(props.contextMenu);
  if (!menu) return null;

  const close = () => props.contextMenu.set(null);
  const id = menu.entityId;
  // right-click already collapsed the multi-selection to just `id` unless
  // `id` was already one of its members (see viewport.ts's onContextMenu) —
  // so this is always the right group to act on
  const multi = props.multiSelection.get();
  const ids = id && multi.includes(id) && multi.length > 1 ? multi : id ? [id] : [];

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
            const newRoots = duplicateMany(props.store, props.store.doc, ids);
            if (newRoots.length === 0) return;
            props.selection.set(newRoots[newRoots.length - 1]!);
            props.multiSelection.set(newRoots);
          },
          ids.length === 0,
        )}
        {item(
          "create prefab from this",
          () => id && props.onCreatePrefab(id),
          !id || "prefab" in (props.store.doc.entities[id]?.components ?? {}),
        )}
        {item(
          "unpack model parts",
          () => id && props.onUnpackModel?.(id),
          !id ||
            !props.onUnpackModel ||
            (() => {
              const source = (
                props.store.doc.entities[id]?.components["mesh"] as
                  | { source?: { kind?: string; node?: string } }
                  | undefined
              )?.source;
              return source?.kind !== "asset" || !!source.node;
            })(),
        )}
        {item(
          "lock" + (id && props.store.doc.entities[id]?.locked === true ? " ✓" : ""),
          () => toggleLockMany(props.store, props.store.doc, ids),
          ids.length === 0,
        )}
        {item(
          "delete  (Del)",
          () => {
            if (ids.length === 0) return;
            props.selection.set(null);
            props.multiSelection.set([]);
            deleteMany(props.store, props.store.doc, ids);
          },
          ids.length === 0,
        )}
        {item("deselect", () => {
          props.selection.set(null);
          props.multiSelection.set([]);
        })}
      </div>
    </>
  );
}

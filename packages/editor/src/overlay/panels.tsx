import { useState } from "react";

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

const STORAGE_PREFIX = "hitreg-editor-panel:";
let topZ = 1000;

export function clearPanelLayout(): void {
  const keys: string[] = [];
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (key?.startsWith(STORAGE_PREFIX)) keys.push(key);
  }
  for (const key of keys) localStorage.removeItem(key);
}

function clampRect(rect: Rect): Rect {
  return {
    ...rect,
    x: Math.min(Math.max(0, rect.x), window.innerWidth - 80),
    y: Math.min(Math.max(0, rect.y), window.innerHeight - 32),
  };
}

/**
 * A floating editor window: draggable title bar, corner resize, collapse,
 * position persisted per panel id. Everything outside panels stays free
 * canvas, so viewport clicks keep working.
 */
export function Panel(props: {
  id: string;
  title: string;
  defaultRect: () => Rect;
  headerExtra?: React.ReactNode;
  children: React.ReactNode;
}) {
  const storageKey = STORAGE_PREFIX + props.id;
  const [rect, setRect] = useState<Rect>(() => {
    try {
      const saved = localStorage.getItem(storageKey);
      if (saved) return clampRect(JSON.parse(saved) as Rect);
    } catch {
      /* fall through to default */
    }
    return props.defaultRect();
  });
  const [collapsed, setCollapsed] = useState(false);
  const [z, setZ] = useState(() => ++topZ);

  const save = (next: Rect) => {
    setRect(next);
    try {
      localStorage.setItem(storageKey, JSON.stringify(next));
    } catch {
      /* storage full/blocked: position just won't persist */
    }
  };

  const dragFrom = (e: React.PointerEvent, mode: "move" | "resize") => {
    e.preventDefault();
    const start = { x: e.clientX, y: e.clientY, rect };
    const onMove = (ev: PointerEvent) => {
      const dx = ev.clientX - start.x;
      const dy = ev.clientY - start.y;
      if (mode === "move") {
        save(clampRect({ ...start.rect, x: start.rect.x + dx, y: start.rect.y + dy }));
      } else {
        save({
          ...start.rect,
          w: Math.max(220, start.rect.w + dx),
          h: Math.max(120, start.rect.h + dy),
        });
      }
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  return (
    <div
      onPointerDownCapture={() => setZ(++topZ)}
      style={{
        position: "fixed",
        left: rect.x,
        top: rect.y,
        width: rect.w,
        height: collapsed ? "auto" : rect.h,
        zIndex: z,
        display: "flex",
        flexDirection: "column",
        background: "rgba(13, 17, 23, 0.94)",
        border: "1px solid #30363d",
        borderRadius: 3,
        color: "#c9d1d9",
        font: "12px ui-monospace, monospace",
        overflow: "hidden",
      }}
    >
      <div
        onPointerDown={(e) => dragFrom(e, "move")}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          padding: "3px 6px",
          background: "#161b22",
          borderBottom: collapsed ? "none" : "1px solid #30363d",
          cursor: "grab",
          userSelect: "none",
        }}
      >
        <strong style={{ color: "#e6edf3", flex: 1, whiteSpace: "nowrap", overflow: "hidden" }}>
          {props.title}
        </strong>
        <span onPointerDown={(e) => e.stopPropagation()} style={{ display: "flex", gap: 4 }}>
          {props.headerExtra}
          <button
            style={{
              background: "transparent",
              border: "none",
              color: "#8b949e",
              cursor: "pointer",
              font: "11px ui-monospace, monospace",
            }}
            title={collapsed ? "Expand" : "Collapse"}
            onClick={() => setCollapsed(!collapsed)}
          >
            {collapsed ? "▸" : "▾"}
          </button>
        </span>
      </div>
      {!collapsed && (
        <>
          <div style={{ flex: 1, overflowY: "auto", padding: 8 }}>{props.children}</div>
          <div
            onPointerDown={(e) => dragFrom(e, "resize")}
            title="Resize"
            style={{
              position: "absolute",
              right: 0,
              bottom: 0,
              width: 14,
              height: 14,
              cursor: "nwse-resize",
            }}
          />
        </>
      )}
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
        padding: "1px 5px",
        width: 110,
      }}
    />
  );
}

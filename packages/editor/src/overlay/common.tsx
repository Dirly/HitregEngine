import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { SceneDoc, SceneStore, Op } from "@hitreg/core";
import type { Observable } from "../state.js";

export function useObservable<T>(obs: Observable<T>): T {
  return useSyncExternalStore(
    (cb) => obs.subscribe(cb),
    () => obs.get(),
  );
}

export function useStoreDoc(store: SceneStore): SceneDoc {
  return useSyncExternalStore(
    (cb) => store.subscribe(cb),
    () => store.doc,
  );
}

export function apply(store: SceneStore, ops: Op[]): void {
  try {
    store.apply(ops);
  } catch (error) {
    console.warn("[editor] ops rejected:", error);
  }
}

export function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v));
}

export const buttonStyle: React.CSSProperties = {
  background: "#21262d",
  border: "1px solid #30363d",
  borderRadius: 3,
  color: "#c9d1d9",
  cursor: "pointer",
  font: "12px ui-monospace, monospace",
  padding: "4px 10px",
};

export const activeButtonStyle: React.CSSProperties = {
  ...buttonStyle,
  background: "#1f3a5f",
  // full shorthand (not borderColor) so toggling a button between the two
  // styles never mixes shorthand + longhand on one element (React warns)
  border: "1px solid #79c0ff",
  color: "#e6edf3",
};

export const dockStyle: React.CSSProperties = {
  background: "#0d1117",
  border: "1px solid #21262d",
  color: "#c9d1d9",
  font: "12px ui-monospace, monospace",
  display: "flex",
  flexDirection: "column",
  minHeight: 0,
  pointerEvents: "auto",
};

export function Splitter(props: {
  style: React.CSSProperties;
  onDrag: (dx: number, dy: number) => void;
}) {
  return (
    <div
      style={{ ...props.style, position: "fixed", zIndex: 950, pointerEvents: "auto" }}
      onPointerDown={(e) => {
        e.preventDefault();
        let last = { x: e.clientX, y: e.clientY };
        const move = (ev: PointerEvent) => {
          props.onDrag(ev.clientX - last.x, ev.clientY - last.y);
          last = { x: ev.clientX, y: ev.clientY };
        };
        const up = () => {
          window.removeEventListener("pointermove", move);
          window.removeEventListener("pointerup", up);
        };
        window.addEventListener("pointermove", move);
        window.addEventListener("pointerup", up);
      }}
    />
  );
}

export function DockHeader(props: { title: string; children?: React.ReactNode }) {
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

/** Keycap chip for shortcut hints inside tooltips. */
export function Kbd(props: { children: React.ReactNode }) {
  return (
    <kbd
      style={{
        display: "inline-block",
        padding: "0 5px",
        minWidth: 16,
        textAlign: "center",
        lineHeight: "16px",
        background: "#161b22",
        border: "1px solid #30363d",
        borderBottomWidth: 2,
        borderRadius: 3,
        color: "#e6edf3",
        font: "10px ui-monospace, monospace",
        whiteSpace: "nowrap",
      }}
    >
      {props.children}
    </kbd>
  );
}

/**
 * Hover/focus tooltip. Rendered `position: fixed` from the trigger's rect so
 * it escapes `overflow` clipping (the toolbar row scrolls horizontally).
 * Replaces native `title` for controls that carry shortcuts — a keycap chip
 * reads faster than "(Ctrl+Z)" buried in a sentence, and it appears on
 * keyboard focus too, which native titles never do.
 */
export function Tooltip(props: { content: React.ReactNode; delay?: number; width?: number; children: React.ReactNode }) {
  const anchor = useRef<HTMLSpanElement>(null);
  const timer = useRef<number | null>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const width = props.width ?? 320;

  const clear = () => {
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = null;
  };
  const show = () => {
    clear();
    timer.current = window.setTimeout(() => {
      const r = anchor.current?.getBoundingClientRect();
      if (!r) return;
      setPos({ left: Math.max(4, Math.min(r.left, window.innerWidth - width - 4)), top: r.bottom + 6 });
    }, props.delay ?? 250);
  };
  const hide = () => {
    clear();
    setPos(null);
  };
  useEffect(() => clear, []);

  return (
    <span
      ref={anchor}
      style={{ display: "inline-flex", alignItems: "stretch" }}
      onPointerEnter={show}
      onPointerLeave={hide}
      onPointerDown={hide}
      onFocus={show}
      onBlur={hide}
    >
      {props.children}
      {pos && (
        <span
          role="tooltip"
          style={{
            position: "fixed",
            left: pos.left,
            top: pos.top,
            zIndex: 1200,
            maxWidth: width,
            padding: "6px 8px",
            background: "rgba(13, 17, 23, 0.97)",
            border: "1px solid #30363d",
            borderRadius: 4,
            boxShadow: "0 4px 12px rgba(0,0,0,0.45)",
            color: "#c9d1d9",
            font: "11px ui-monospace, monospace",
            lineHeight: "16px",
            whiteSpace: "normal",
            pointerEvents: "none",
          }}
        >
          {props.content}
        </span>
      )}
    </span>
  );
}

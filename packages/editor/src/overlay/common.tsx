import { useSyncExternalStore } from "react";
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
  borderColor: "#79c0ff",
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

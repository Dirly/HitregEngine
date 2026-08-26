import { useEffect, useRef, useState } from "react";
import * as THREE from "three/webgpu";
import type { Pin, Pins } from "../state.js";
import { buttonStyle, useObservable } from "./common.js";

/**
 * Pins, drawn as screen-projected markers over the viewport.
 *
 * Deliberately DOM rather than scene objects: a note has to stay readable
 * through walls, survive every scene rebuild without re-registering itself,
 * and be clickable and editable as text. Depth-correct 3D markers would fail
 * the first three to win the one thing (occlusion) a note shouldn't have
 * anyway — a comment about a thing you can't see is exactly the comment you
 * most need to find.
 */

/** Projection rate. Pins are a handful of DOM nodes; 20Hz reads as attached. */
const PROJECT_MS = 50;

interface Projected {
  pin: Pin;
  x: number;
  y: number;
  /** Behind the camera or off-screen — skip drawing entirely. */
  visible: boolean;
}

export function PinOverlay(props: {
  pins: Pins;
  camera: THREE.PerspectiveCamera;
  canvas: HTMLCanvasElement;
  showResolved: boolean;
  onUpdate: (id: string, patch: Partial<Pin>) => void;
  onDelete: (id: string) => void;
  onFocusPoint?: (point: [number, number, number]) => void;
}) {
  const pins = useObservable(props.pins);
  const [projected, setProjected] = useState<Projected[]>([]);
  const [openId, setOpenId] = useState<string | null>(null);
  const frame = useRef(0);

  const shown = pins.filter((pin) => props.showResolved || !pin.resolved);

  useEffect(() => {
    let stop = false;
    let last = 0;
    const world = new THREE.Vector3();

    const tick = (now: number) => {
      if (stop) return;
      frame.current = requestAnimationFrame(tick);
      if (now - last < PROJECT_MS) return;
      last = now;
      const rect = props.canvas.getBoundingClientRect();
      setProjected(
        shown.map((pin) => {
          world.set(pin.point[0], pin.point[1], pin.point[2]).project(props.camera);
          // z > 1 means the point is behind the near plane — projecting it
          // yields a mirrored on-screen position that looks plausible and is
          // completely wrong, which is the classic billboard-overlay bug
          const visible = world.z < 1 && world.x >= -1.2 && world.x <= 1.2 && world.y >= -1.2 && world.y <= 1.2;
          return {
            pin,
            x: rect.left + ((world.x + 1) / 2) * rect.width,
            y: rect.top + ((1 - world.y) / 2) * rect.height,
            visible,
          };
        }),
      );
    };
    frame.current = requestAnimationFrame(tick);
    return () => {
      stop = true;
      cancelAnimationFrame(frame.current);
    };
    // re-arm when the visible pin set changes; the loop itself reads live camera
  }, [props.camera, props.canvas, shown.map((p) => p.id + p.resolved).join(","), props.showResolved]);

  if (shown.length === 0) return null;

  return (
    <>
      {projected.map(({ pin, x, y, visible }) => {
        if (!visible) return null;
        const open = openId === pin.id;
        const index = shown.indexOf(pin) + 1;
        return (
          <div
            key={pin.id}
            style={{
              position: "fixed",
              left: x,
              top: y,
              transform: "translate(-50%, -50%)",
              zIndex: open ? 4002 : 4000,
              pointerEvents: "auto",
            }}
          >
            <div
              title={
                pin.text +
                (pin.resolved ? " (resolved)" : pin.sentAt ? " (sent to AI)" : "")
              }
              onClick={() => setOpenId(open ? null : pin.id)}
              onDoubleClick={() => props.onFocusPoint?.(pin.point)}
              style={{
                width: 18,
                height: 18,
                borderRadius: "50% 50% 50% 2px",
                // resolved pins read as hollow + checked, not merely dimmer
                background: pin.resolved ? "transparent" : "#e3b341",
                border: `1px solid ${pin.resolved ? "#8b949e" : "#e3b341"}`,
                color: pin.resolved ? "#8b949e" : "#0d1117",
                font: "10px ui-monospace, monospace",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                cursor: "pointer",
                boxShadow: "0 1px 4px rgba(0,0,0,0.6)",
              }}
            >
              {pin.resolved ? "✓" : pin.sentAt ? "↑" : index}
            </div>
            {open && (
              <PinCard
                pin={pin}
                onUpdate={(patch) => props.onUpdate(pin.id, patch)}
                onDelete={() => {
                  setOpenId(null);
                  props.onDelete(pin.id);
                }}
                onClose={() => setOpenId(null)}
              />
            )}
          </div>
        );
      })}
    </>
  );
}

function PinCard(props: {
  pin: Pin;
  onUpdate: (patch: Partial<Pin>) => void;
  onDelete: () => void;
  onClose: () => void;
}) {
  const [text, setText] = useState(props.pin.text);
  useEffect(() => setText(props.pin.text), [props.pin.text]);

  return (
    <div
      style={{
        position: "absolute",
        left: 22,
        top: -4,
        width: 240,
        background: "rgba(13, 17, 23, 0.97)",
        border: "1px solid #30363d",
        borderRadius: 3,
        padding: 8,
        font: "11px ui-monospace, monospace",
        color: "#c9d1d9",
      }}
    >
      <div style={{ color: "#8b949e", fontSize: 10, marginBottom: 4 }}>
        {props.pin.author} · {props.pin.point.map((v) => v.toFixed(1)).join(", ")}
        {props.pin.entityId ? ` · on ${props.pin.entityId}` : ""}
      </div>
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        onBlur={() => text !== props.pin.text && props.onUpdate({ text })}
        rows={3}
        style={{
          width: "100%",
          boxSizing: "border-box",
          background: "#161b22",
          border: "1px solid #30363d",
          borderRadius: 3,
          color: "#c9d1d9",
          font: "11px ui-monospace, monospace",
          resize: "vertical",
        }}
      />
      {props.pin.reply && (
        <div
          style={{
            marginTop: 6,
            padding: 6,
            background: "#161b22",
            borderLeft: "2px solid #79c0ff",
            fontSize: 10,
          }}
        >
          <div style={{ color: "#8b949e", marginBottom: 2 }}>agent replied</div>
          {props.pin.reply}
        </div>
      )}
      <div style={{ display: "flex", gap: 4, marginTop: 6 }}>
        {!props.pin.resolved && (
          <button
            style={{
              ...buttonStyle,
              flex: 1,
              padding: "2px 6px",
              ...(props.pin.sentAt
                ? {}
                : { borderColor: "#79c0ff", color: "#e6edf3" }),
            }}
            title={
              props.pin.sentAt
                ? `Sent ${new Date(props.pin.sentAt).toLocaleTimeString()} — press again to re-send`
                : "Put this note in the agent inbox now"
            }
            disabled={text.trim().length === 0}
            onClick={() => {
              if (text !== props.pin.text) props.onUpdate({ text, sentAt: new Date().toISOString() });
              else props.onUpdate({ sentAt: new Date().toISOString() });
            }}
          >
            {props.pin.sentAt ? "↑ re-send" : "↑ send to AI"}
          </button>
        )}
        <button
          style={{ ...buttonStyle, flex: 1, padding: "2px 6px" }}
          onClick={() => props.onUpdate({ resolved: !props.pin.resolved })}
        >
          {props.pin.resolved ? "reopen" : "resolve"}
        </button>
        <button style={{ ...buttonStyle, padding: "2px 6px" }} onClick={props.onDelete}>
          delete
        </button>
        <button style={{ ...buttonStyle, padding: "2px 6px" }} onClick={props.onClose}>
          close
        </button>
      </div>
    </div>
  );
}

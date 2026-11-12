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

/** Screen-space size of a marker's click target (the drawn drop is 18 px inside it). */
const HIT_PX = 28;

export function PinOverlay(props: {
  pins: Pins;
  camera: THREE.PerspectiveCamera;
  canvas: HTMLCanvasElement;
  showResolved: boolean;
  /** Notes go to the agent inbox as soon as they are written (card closed), instead of waiting as drafts. */
  autoSend?: boolean;
  onUpdate: (id: string, patch: Partial<Pin>) => void;
  onDelete: (id: string) => void;
  onFocusPoint?: (point: [number, number, number]) => void;
}) {
  const pins = useObservable(props.pins);
  const [openId, setOpenId] = useState<string | null>(null);
  const nodes = useRef(new Map<string, HTMLDivElement>());
  const live = useRef({ shown: [] as Pin[], openId: null as string | null });
  const seen = useRef<Set<string> | null>(null);

  const shown = pins.filter((pin) => props.showResolved || !pin.resolved);
  live.current = { shown, openId };

  // A note just dropped opens its own card and takes the keyboard: the 18 px marker is not something to hunt for.
  useEffect(() => {
    if (seen.current) {
      const fresh = pins.find(
        (p) => !seen.current!.has(p.id) && p.text === "" && p.author === "human" && Date.now() - Date.parse(p.createdAt) < 3000,
      );
      if (fresh) setOpenId(fresh.id);
    }
    seen.current = new Set(pins.map((p) => p.id));
  }, [pins]);

  // Markers are positioned EVERY frame, straight on their DOM nodes (no React render). Through setState at 20 Hz
  // they trailed the camera and swam across the view while flying. An OPEN card never unmounts and never leaves
  // the screen: its anchor is clamped to the viewport when the point goes off-screen or behind the camera, so
  // text being typed is not thrown away by flying on.
  useEffect(() => {
    let raf = 0;
    const world = new THREE.Vector3();
    const tick = () => {
      raf = requestAnimationFrame(tick);
      const rect = props.canvas.getBoundingClientRect();
      // the renderer refreshes these once per drawn frame; do it here too so a marker never uses last frame's camera
      props.camera.updateMatrixWorld();
      props.camera.matrixWorldInverse.copy(props.camera.matrixWorld).invert();
      for (const pin of live.current.shown) {
        const node = nodes.current.get(pin.id);
        if (!node) continue;
        world.set(pin.point[0], pin.point[1], pin.point[2]).project(props.camera);
        // z > 1: behind the near plane — its projection is a mirrored, plausible-looking, wrong position
        const behind = !(world.z < 1);
        const on = !behind && world.x >= -1.05 && world.x <= 1.05 && world.y >= -1.05 && world.y <= 1.05;
        const open = live.current.openId === pin.id;
        if (!on && !open) {
          if (node.style.display !== "none") node.style.display = "none";
          continue;
        }
        let x = rect.left + ((world.x + 1) / 2) * rect.width;
        let y = rect.top + ((1 - world.y) / 2) * rect.height;
        if (behind) {
          x = rect.left + rect.width / 2;
          y = rect.bottom - 40;
        }
        if (open) {
          x = Math.min(rect.right - 290, Math.max(rect.left + 16, x));
          y = Math.min(rect.bottom - 200, Math.max(rect.top + 16, y));
        }
        node.style.display = "block";
        node.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px) translate(-50%, -50%)`;
      }
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [props.camera, props.canvas]);

  if (shown.length === 0) return null;

  const close = (pin: Pin) => {
    setOpenId(null);
    if (props.autoSend && !pin.sentAt && !pin.resolved && pin.text.trim().length > 0) {
      props.onUpdate(pin.id, { sentAt: new Date().toISOString() });
    }
  };

  return (
    <>
      {shown.map((pin, i) => {
        const open = openId === pin.id;
        return (
          <div
            key={pin.id}
            ref={(el) => {
              if (el) nodes.current.set(pin.id, el);
              else nodes.current.delete(pin.id);
            }}
            style={{
              position: "fixed",
              left: 0,
              top: 0,
              display: "none",
              zIndex: open ? 4002 : 4000,
              pointerEvents: "auto",
            }}
          >
            <div
              title={pin.text + (pin.resolved ? " (resolved)" : pin.sentAt ? " (sent to AI)" : " (draft)")}
              onPointerDown={(e) => e.stopPropagation()}
              onClick={() => (open ? close(pin) : setOpenId(pin.id))}
              onDoubleClick={() => props.onFocusPoint?.(pin.point)}
              style={{
                width: HIT_PX,
                height: HIT_PX,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                cursor: "pointer",
              }}
            >
              <div
                style={{
                  width: 18,
                  height: 18,
                  borderRadius: "50% 50% 50% 2px",
                  // resolved = hollow + check, draft = dashed outline + number, sent = solid + arrow: never colour alone
                  background: pin.resolved ? "transparent" : pin.sentAt ? "#e3b341" : "rgba(227, 179, 65, 0.3)",
                  border: `1px ${pin.resolved || pin.sentAt ? "solid" : "dashed"} ${pin.resolved ? "#8b949e" : "#e3b341"}`,
                  color: pin.resolved ? "#8b949e" : pin.sentAt ? "#0d1117" : "#e6edf3",
                  font: "10px ui-monospace, monospace",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  boxShadow: "0 1px 4px rgba(0,0,0,0.6)",
                }}
              >
                {pin.resolved ? "✓" : pin.sentAt ? "↑" : i + 1}
              </div>
            </div>
            {open && (
              <PinCard
                pin={pin}
                onUpdate={(patch) => props.onUpdate(pin.id, patch)}
                onDelete={() => {
                  setOpenId(null);
                  props.onDelete(pin.id);
                }}
                onClose={() => close(pin)}
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
  // The text is saved AS IT IS TYPED (the store debounces the write). It used to be saved on blur only, and a card
  // that unmounted first (its point left the screen) threw the words away.
  const [text, setText] = useState(props.pin.text);
  const typing = useRef(false);
  useEffect(() => {
    if (!typing.current) setText(props.pin.text);
  }, [props.pin.text]);

  return (
    <div
      onPointerDown={(e) => e.stopPropagation()}
      style={{
        position: "absolute",
        left: 30,
        top: 0,
        width: 250,
        background: "rgba(13, 17, 23, 0.97)",
        border: "1px solid #30363d",
        borderRadius: 3,
        padding: 8,
        font: "11px ui-monospace, monospace",
        color: "#c9d1d9",
      }}
    >
      <div style={{ color: "#8b949e", fontSize: 10, marginBottom: 4 }}>
        {props.pin.resolved ? "resolved" : props.pin.sentAt ? "sent to AI" : "draft"} · {props.pin.author}
        {props.pin.entityId ? ` · on ${props.pin.entityId}` : ` · ${props.pin.point.map((v) => v.toFixed(1)).join(", ")}`}
      </div>
      <textarea
        value={text}
        autoFocus={props.pin.text === ""}
        placeholder="what should change here? (saved as you type)"
        onFocus={() => (typing.current = true)}
        onKeyDown={(e) => e.stopPropagation()}
        onChange={(e) => {
          setText(e.target.value);
          props.onUpdate({ text: e.target.value });
        }}
        onBlur={() => {
          typing.current = false;
          if (text !== props.pin.text) props.onUpdate({ text });
        }}
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
              ...(props.pin.sentAt ? {} : { borderColor: "#79c0ff", color: "#e6edf3" }),
            }}
            title={
              props.pin.sentAt
                ? `Sent ${new Date(props.pin.sentAt).toLocaleTimeString()} — press again to re-send`
                : "Put this one note in the agent inbox now. A note you only close stays a draft: send drafts together from the notes badge."
            }
            disabled={text.trim().length === 0}
            onClick={() => props.onUpdate({ text, sentAt: new Date().toISOString() })}
          >
            {props.pin.sentAt ? "↑ re-send" : "↑ send now"}
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

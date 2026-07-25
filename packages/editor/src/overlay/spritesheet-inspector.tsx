import { useRef, useState } from "react";
import {
  gridFrameRect,
  resolveSpriteFrames,
  type AssetLibrary,
  type SpriteFrame,
  type SpritesheetDoc,
} from "@hitreg/core";
import { buttonStyle, clamp } from "./common.js";
import { NumberField, Row, TextField } from "./fields.js";

/**
 * Visual sprite-sheet slicer: shows the sheet's texture at native pixel
 * scale (via percentage-positioned overlay rects, so no zoom/scroll math is
 * needed) with the grid's auto-cells outlined thin, named frames outlined
 * bold + labeled, and drag-to-define — draw a box on the image, name it,
 * get an explicit-rect frame. Grid params are still edited numerically
 * (a cols/rows/frameWidth/frameHeight grid is naturally numeric, not
 * something you'd drag out by hand).
 */
export function SpritesheetInspector(props: {
  id: string;
  data: SpritesheetDoc;
  assets: AssetLibrary;
  onCommit: (patch: Partial<SpritesheetDoc>) => void;
}) {
  const { data, onCommit } = props;
  const texture = props.assets.getTexture(data.texture);
  const imgRef = useRef<HTMLImageElement | null>(null);
  const [natural, setNatural] = useState<{ w: number; h: number } | null>(null);
  const [selectedFrame, setSelectedFrame] = useState<string | null>(null);
  const [drag, setDrag] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null);

  const pixelFromEvent = (e: React.PointerEvent<HTMLDivElement>): { x: number; y: number } | null => {
    const img = imgRef.current;
    if (!img || !natural) return null;
    const rect = img.getBoundingClientRect();
    const px = ((e.clientX - rect.left) / rect.width) * natural.w;
    const py = ((e.clientY - rect.top) / rect.height) * natural.h;
    return { x: Math.round(clamp(px, 0, natural.w)), y: Math.round(clamp(py, 0, natural.h)) };
  };

  const rectStyle = (frame: SpriteFrame, natural_: { w: number; h: number }): React.CSSProperties => ({
    position: "absolute",
    left: `${(frame.x / natural_.w) * 100}%`,
    top: `${(frame.y / natural_.h) * 100}%`,
    width: `${(frame.w / natural_.w) * 100}%`,
    height: `${(frame.h / natural_.h) * 100}%`,
  });

  const namedRects = resolveSpriteFrames(data);
  const gridCellCount = data.grid ? data.grid.cols * data.grid.rows : 0;

  const setFrames = (frames: SpritesheetDoc["frames"]) => onCommit({ frames });

  const renameFrame = (oldName: string, newName: string) => {
    if (!newName || newName === oldName || data.frames[newName]) return;
    const { [oldName]: def, ...rest } = data.frames;
    setFrames({ ...rest, [newName]: def! });
    setSelectedFrame(newName);
  };

  return (
    <div>
      <div style={{ color: "#8b949e", fontSize: 10, marginBottom: 8 }}>
        assets/spritesheets/{props.id}.json — drag on the image to slice a new named frame
      </div>
      <Row label="texture">
        <select
          style={{ ...buttonStyle, width: "100%" }}
          value={data.texture}
          onChange={(e) => {
            setNatural(null);
            onCommit({ texture: e.target.value });
          }}
        >
          {props.assets.textureIds().map((tid) => (
            <option key={tid} value={tid}>
              {tid}
            </option>
          ))}
        </select>
      </Row>
      {!texture ? (
        <div style={{ color: "#f85149", fontSize: 11, margin: "8px 0" }}>
          Missing texture asset "{data.texture}".
        </div>
      ) : (
        <div
          style={{ position: "relative", marginTop: 6, background: "#0b0e14", borderRadius: 3 }}
          onPointerDown={(e) => {
            const p = pixelFromEvent(e);
            if (!p) return;
            (e.target as HTMLElement).setPointerCapture(e.pointerId);
            setDrag({ x0: p.x, y0: p.y, x1: p.x, y1: p.y });
          }}
          onPointerMove={(e) => {
            if (!drag) return;
            const p = pixelFromEvent(e);
            if (p) setDrag({ ...drag, x1: p.x, y1: p.y });
          }}
          onPointerUp={() => {
            if (!drag) return;
            const x = Math.min(drag.x0, drag.x1);
            const y = Math.min(drag.y0, drag.y1);
            const w = Math.abs(drag.x1 - drag.x0);
            const h = Math.abs(drag.y1 - drag.y0);
            setDrag(null);
            if (w < 2 || h < 2) return;
            let n = Object.keys(data.frames).length + 1;
            let suggested = `frame-${n}`;
            while (data.frames[suggested]) suggested = `frame-${++n}`;
            const name = window.prompt("Name this frame:", suggested);
            if (!name) return;
            setFrames({ ...data.frames, [name]: { x, y, w, h } });
            setSelectedFrame(name);
          }}
        >
          <img
            ref={imgRef}
            src={texture.url}
            alt={texture.name}
            draggable={false}
            onLoad={(e) => {
              const el = e.currentTarget;
              setNatural({ w: el.naturalWidth, h: el.naturalHeight });
            }}
            style={{ width: "100%", display: "block", borderRadius: 3, userSelect: "none" }}
          />
          {natural && (
            <>
              {/* grid auto-cells: thin, unlabeled — the frame ids f0..fN they get are implicit */}
              {data.grid &&
                Array.from({ length: gridCellCount }, (_, i) => gridFrameRect(data.grid!, i)).map(
                  (cell, i) =>
                    cell && (
                      <div
                        key={`grid-${i}`}
                        style={{
                          ...rectStyle(cell, natural),
                          border: "1px solid rgba(121, 192, 255, 0.35)",
                          pointerEvents: "none",
                        }}
                      />
                    ),
                )}
              {/* named frames: bold + labeled, selected one highlighted */}
              {Object.entries(data.frames).map(([name]) => {
                const rect = namedRects[name];
                if (!rect) return null;
                const selected = selectedFrame === name;
                return (
                  <div
                    key={name}
                    onClick={(e) => {
                      e.stopPropagation();
                      setSelectedFrame(name);
                    }}
                    style={{
                      ...rectStyle(rect, natural),
                      border: `2px solid ${selected ? "#e3b341" : "#d2a8ff"}`,
                      cursor: "pointer",
                      pointerEvents: "auto",
                    }}
                    title={name}
                  >
                    <span
                      style={{
                        position: "absolute",
                        left: 0,
                        top: -14,
                        fontSize: 9,
                        color: selected ? "#e3b341" : "#d2a8ff",
                        background: "#0b0e14",
                        padding: "0 2px",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {name}
                    </span>
                  </div>
                );
              })}
              {drag && natural && (
                <div
                  style={{
                    ...rectStyle(
                      {
                        x: Math.min(drag.x0, drag.x1),
                        y: Math.min(drag.y0, drag.y1),
                        w: Math.abs(drag.x1 - drag.x0),
                        h: Math.abs(drag.y1 - drag.y0),
                      },
                      natural,
                    ),
                    border: "2px dashed #e6edf3",
                    pointerEvents: "none",
                  }}
                />
              )}
            </>
          )}
        </div>
      )}

      <div style={{ marginTop: 10, fontSize: 11, color: "#8b949e" }}>
        grid (auto-slice into f0..fN cells)
      </div>
      <Row label="enabled">
        <input
          type="checkbox"
          checked={!!data.grid}
          onChange={(e) =>
            onCommit({
              grid: e.target.checked
                ? {
                    cols: 4,
                    rows: 4,
                    frameWidth: natural ? Math.max(1, Math.round(natural.w / 4)) : 32,
                    frameHeight: natural ? Math.max(1, Math.round(natural.h / 4)) : 32,
                    margin: 0,
                    spacing: 0,
                  }
                : undefined,
            })
          }
        />
      </Row>
      {data.grid && (
        <>
          <Row label="cols">
            <NumberField value={data.grid.cols} onCommit={(v) => onCommit({ grid: { ...data.grid!, cols: Math.max(1, Math.round(v)) } })} />
          </Row>
          <Row label="rows">
            <NumberField value={data.grid.rows} onCommit={(v) => onCommit({ grid: { ...data.grid!, rows: Math.max(1, Math.round(v)) } })} />
          </Row>
          <Row label="frame w">
            <NumberField
              value={data.grid.frameWidth}
              onCommit={(v) => onCommit({ grid: { ...data.grid!, frameWidth: Math.max(1, Math.round(v)) } })}
            />
          </Row>
          <Row label="frame h">
            <NumberField
              value={data.grid.frameHeight}
              onCommit={(v) => onCommit({ grid: { ...data.grid!, frameHeight: Math.max(1, Math.round(v)) } })}
            />
          </Row>
          <Row label="margin">
            <NumberField value={data.grid.margin} onCommit={(v) => onCommit({ grid: { ...data.grid!, margin: Math.max(0, Math.round(v)) } })} />
          </Row>
          <Row label="spacing">
            <NumberField
              value={data.grid.spacing}
              onCommit={(v) => onCommit({ grid: { ...data.grid!, spacing: Math.max(0, Math.round(v)) } })}
            />
          </Row>
          <div style={{ color: "#8b949e", fontSize: 10, margin: "4px 0" }}>
            {gridCellCount} cell{gridCellCount === 1 ? "" : "s"} → f0..f{Math.max(0, gridCellCount - 1)}
          </div>
        </>
      )}

      <div style={{ marginTop: 10, fontSize: 11, color: "#8b949e" }}>
        named frames ({Object.keys(data.frames).length})
      </div>
      {Object.entries(data.frames).length === 0 && (
        <div style={{ color: "#8b949e", fontSize: 10 }}>None yet — drag on the image above to slice one.</div>
      )}
      {Object.entries(data.frames).map(([name, def]) => (
        <div
          key={name}
          onClick={() => setSelectedFrame(name)}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 4,
            padding: "3px 4px",
            marginBottom: 2,
            borderRadius: 3,
            cursor: "pointer",
            background: selectedFrame === name ? "#1f3a5f" : "transparent",
          }}
        >
          <span style={{ width: 90, overflow: "hidden", textOverflow: "ellipsis" }}>
            <TextField value={name} onCommit={(v) => renameFrame(name, v)} />
          </span>
          {"index" in def ? (
            <span style={{ fontSize: 10, color: "#8b949e" }}>grid cell {def.index}</span>
          ) : (
            <>
              <NumberField value={def.x} onCommit={(v) => setFrames({ ...data.frames, [name]: { ...def, x: Math.round(v) } })} />
              <NumberField value={def.y} onCommit={(v) => setFrames({ ...data.frames, [name]: { ...def, y: Math.round(v) } })} />
              <NumberField
                value={def.w}
                onCommit={(v) => setFrames({ ...data.frames, [name]: { ...def, w: Math.max(1, Math.round(v)) } })}
              />
              <NumberField
                value={def.h}
                onCommit={(v) => setFrames({ ...data.frames, [name]: { ...def, h: Math.max(1, Math.round(v)) } })}
              />
            </>
          )}
          <button
            title="Delete frame"
            style={{ ...buttonStyle, padding: "1px 6px" }}
            onClick={(e) => {
              e.stopPropagation();
              const { [name]: _removed, ...rest } = data.frames;
              setFrames(rest);
              if (selectedFrame === name) setSelectedFrame(null);
            }}
          >
            ✕
          </button>
        </div>
      ))}
    </div>
  );
}

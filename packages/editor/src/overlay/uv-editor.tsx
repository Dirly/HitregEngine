import { useEffect, useMemo, useRef, useState } from "react";
import {
  boxProjectFaces,
  computeFaceUvs,
  buildTopology,
  copyUvs,
  faceUvSettings,
  fitUvs,
  flipUvs,
  planarProjectFaces,
  resetUvs,
  setAutoUv,
  transformUvs,
  UV_ANCHORS,
  UV_FILLS,
  type AssetLibrary,
  type FaceUv,
  type PolyMesh,
  type SceneStore,
} from "@hitreg/core";
import type { MeshEditState } from "../state.js";
import { apply, buttonStyle, activeButtonStyle, useObservable, useStoreDoc } from "./common.js";
import { BooleanField, NumberField, Row } from "./fields.js";

type Vec2 = [number, number];

interface MeshComponent {
  source: PolyMesh;
  material?: string;
  [k: string]: unknown;
}

const SIZE = 340;

/**
 * The UV editor (ProBuilder's UV window): a 2D view of the edited mesh's
 * UVs with the selected faces highlighted, plus every knob of the per-face
 * auto-unwrap settings and the manual-projection tools.
 *
 * Two regimes, mirrored from the data model: AUTO faces are edited through
 * their settings (tiling/offset/rotation/flip/anchor/fill/group), and every
 * change is a `setAutoUv` op; MANUAL faces (once projected or dragged here)
 * carry explicit coordinates that the canvas moves/rotates/scales. Drag =
 * move, Ctrl+drag = rotate, Shift+drag = scale; wheel zooms, right-drag pans.
 * Every gesture commits one undoable `set-component` on release.
 */
export function UvEditor(props: { store: SceneStore; assets: AssetLibrary; state: MeshEditState; assetsVersion: { get(): number; subscribe(cb: () => void): () => void } }) {
  const open = useObservable(props.state.uvEditorOpen);
  const entityId = useObservable(props.state.entityId);
  const selection = useObservable(props.state.selection);
  const doc = useStoreDoc(props.store);
  useObservable({ get: () => props.assetsVersion.get(), set: () => undefined, subscribe: props.assetsVersion.subscribe });
  const component = entityId ? (doc.entities[entityId]?.components["mesh"] as MeshComponent | undefined) : undefined;
  const mesh = component && component.source?.kind === "poly" ? component.source : null;
  if (!open) return null;
  if (!entityId || !mesh) {
    return (
      <Window title="UV editor" onClose={() => props.state.uvEditorOpen.set(false)}>
        <div style={{ color: "#8b949e", padding: 8 }}>select an editable mesh (face mode) to edit its UVs</div>
      </Window>
    );
  }
  return (
    <Window title="UV editor" onClose={() => props.state.uvEditorOpen.set(false)}>
      <UvBody
        entityId={entityId}
        component={component!}
        mesh={mesh}
        faces={selection.faces}
        store={props.store}
        assets={props.assets}
        onSelectFaces={(faces) => props.state.selection.set({ vertices: [], edges: [], faces })}
      />
    </Window>
  );
}

function Window(props: { title: string; onClose: () => void; children: React.ReactNode }) {
  return (
    <div
      style={{
        pointerEvents: "auto",
        alignSelf: "flex-start",
        margin: 6,
        width: SIZE + 16,
        maxHeight: "calc(100% - 12px)",
        overflowY: "auto",
        background: "rgba(13, 17, 23, 0.94)",
        border: "1px solid #30363d",
        borderRadius: 4,
        color: "#c9d1d9",
        font: "12px ui-monospace, monospace",
        userSelect: "none",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 6, padding: "5px 8px", background: "#161b22" }}>
        <strong style={{ color: "#e6edf3", flex: 1 }}>{props.title}</strong>
        <button style={{ ...buttonStyle, padding: "2px 7px" }} onClick={props.onClose}>
          ✕
        </button>
      </div>
      {props.children}
    </div>
  );
}

function UvBody(props: {
  entityId: string;
  component: MeshComponent;
  mesh: PolyMesh;
  faces: number[];
  store: SceneStore;
  assets: AssetLibrary;
  onSelectFaces: (faces: number[]) => void;
}) {
  const { mesh, faces } = props;
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [view, setView] = useState({ zoom: 1, pan: [0, 0] as Vec2 });
  const [drag, setDrag] = useState<{ kind: "move" | "rotate" | "scale" | "pan"; start: Vec2; last: Vec2; delta: Vec2; angle: number; scale: number } | null>(null);
  const [snap, setSnap] = useState(true);
  const [showAll, setShowAll] = useState(true);
  const [texture, setTexture] = useState<HTMLImageElement | null>(null);

  const uvs = useMemo(() => computeFaceUvs(mesh, buildTopology(mesh)), [mesh]);
  const selected = new Set(faces);

  // frame the selection when it changes (a 20-unit wall's UVs are far
  // outside the 0..1 tile; the editor must show them, not an empty square)
  const selectionKey = faces.join(",");
  useEffect(() => {
    let minU = Infinity, minV = Infinity, maxU = -Infinity, maxV = -Infinity;
    for (const fi of faces) for (const [u, v] of uvs[fi] ?? []) {
      minU = Math.min(minU, u); minV = Math.min(minV, v); maxU = Math.max(maxU, u); maxV = Math.max(maxV, v);
    }
    if (!Number.isFinite(minU)) return;
    const extent = Math.max(maxU - minU, maxV - minV, 1);
    const zoom = Math.min(4, 0.9 / extent);
    const s = SIZE * 0.8 * zoom;
    // center the selection's bbox in the canvas
    const cu = (minU + maxU) / 2;
    const cv = (minV + maxV) / 2;
    setView({ zoom, pan: [SIZE / 2 - (SIZE * 0.1 + cu * s), SIZE / 2 - (SIZE * 0.9 - cv * s)] });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectionKey]);
  const target = faces.length > 0 ? faces : mesh.faces.map((_, i) => i);
  const first = mesh.faces[target[0] ?? 0];
  const settings: FaceUv = first ? faceUvSettings(first) : faceUvSettings({ v: [0, 1, 2], mat: 0, smooth: 0 });
  const allManual = target.length > 0 && target.every((fi) => mesh.faces[fi]?.uv?.mode === "manual");
  const anyManual = target.some((fi) => mesh.faces[fi]?.uv?.mode === "manual");

  // texture of the first selected face's material, as the background
  const textureUrl = useMemo(() => {
    const slot = first?.mat ?? 0;
    const materialId = mesh.materials[slot] || props.component.material;
    if (!materialId) return null;
    const material = props.assets.getDataAsset(materialId)?.data as { map?: string } | undefined;
    return material?.map ? (props.assets.getTexture(material.map)?.url ?? null) : null;
  }, [first?.mat, mesh.materials, props.component.material, props.assets]);
  useEffect(() => {
    if (!textureUrl) {
      setTexture(null);
      return;
    }
    const img = new Image();
    img.onload = () => setTexture(img);
    img.src = textureUrl;
  }, [textureUrl]);

  const commit = (next: PolyMesh): void =>
    apply(props.store, [{ op: "set-component", id: props.entityId, component: "mesh", data: { ...props.component, source: next } }]);

  // uv -> canvas px (v up)
  const toPx = (u: number, v: number): Vec2 => {
    const s = SIZE * 0.8 * view.zoom;
    const ox = SIZE * 0.1 + view.pan[0];
    const oy = SIZE * 0.9 + view.pan[1];
    return [ox + u * s, oy - v * s];
  };
  const toUv = (x: number, y: number): Vec2 => {
    const s = SIZE * 0.8 * view.zoom;
    const ox = SIZE * 0.1 + view.pan[0];
    const oy = SIZE * 0.9 + view.pan[1];
    return [(x - ox) / s, (oy - y) / s];
  };

  /** Selected faces' coords as displayed during a drag (preview transform). */
  const previewCoords = (fi: number): Vec2[] => {
    const coords = uvs[fi] ?? [];
    if (!drag || !selected.has(fi) || drag.kind === "pan") return coords;
    const center = selectionCenter();
    return coords.map(([u, v]) => {
      let x = u - center[0];
      let y = v - center[1];
      if (drag.kind === "scale") {
        x *= drag.scale;
        y *= drag.scale;
      }
      if (drag.kind === "rotate") {
        const c = Math.cos(drag.angle);
        const s = Math.sin(drag.angle);
        const rx = x * c - y * s;
        const ry = x * s + y * c;
        x = rx;
        y = ry;
      }
      const dx = drag.kind === "move" ? drag.delta[0] : 0;
      const dy = drag.kind === "move" ? drag.delta[1] : 0;
      return [x + center[0] + dx, y + center[1] + dy];
    });
  };
  const selectionCenter = (): Vec2 => {
    let minU = Infinity, minV = Infinity, maxU = -Infinity, maxV = -Infinity;
    for (const fi of faces) for (const [u, v] of uvs[fi] ?? []) {
      minU = Math.min(minU, u); minV = Math.min(minV, v); maxU = Math.max(maxU, u); maxV = Math.max(maxV, v);
    }
    return Number.isFinite(minU) ? [(minU + maxU) / 2, (minV + maxV) / 2] : [0, 0];
  };

  // draw
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, SIZE, SIZE);
    ctx.fillStyle = "#0d1117";
    ctx.fillRect(0, 0, SIZE, SIZE);
    // texture / tile background across the visible repeats
    const [u0, v1] = toUv(0, 0);
    const [u1, v0] = toUv(SIZE, SIZE);
    for (let tu = Math.floor(u0); tu <= Math.ceil(u1); tu++) {
      for (let tv = Math.floor(v0); tv <= Math.ceil(v1); tv++) {
        const [x0, y0] = toPx(tu, tv + 1);
        const [x1, y1] = toPx(tu + 1, tv);
        if (texture) {
          ctx.globalAlpha = tu === 0 && tv === 0 ? 0.9 : 0.35;
          ctx.drawImage(texture, x0, y0, x1 - x0, y1 - y0);
          ctx.globalAlpha = 1;
        } else {
          ctx.fillStyle = tu === 0 && tv === 0 ? "#161b22" : "#10151c";
          ctx.fillRect(x0, y0, x1 - x0, y1 - y0);
        }
        ctx.strokeStyle = tu === 0 && tv === 0 ? "#484f58" : "#21262d";
        ctx.strokeRect(x0, y0, x1 - x0, y1 - y0);
      }
    }
    // faces
    mesh.faces.forEach((_, fi) => {
      const isSel = selected.has(fi);
      if (!isSel && !showAll) return;
      const coords = previewCoords(fi);
      if (coords.length < 3) return;
      ctx.beginPath();
      coords.forEach(([u, v], i) => {
        const [x, y] = toPx(u, v);
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      });
      ctx.closePath();
      ctx.fillStyle = isSel ? "rgba(242, 163, 58, 0.28)" : "rgba(121, 192, 255, 0.08)";
      ctx.fill();
      ctx.strokeStyle = isSel ? "#f2a33a" : "#5b8fc4";
      ctx.lineWidth = isSel ? 1.5 : 1;
      ctx.stroke();
      if (isSel) {
        ctx.fillStyle = "#f2a33a";
        for (const [u, v] of coords) {
          const [x, y] = toPx(u, v);
          ctx.fillRect(x - 2, y - 2, 4, 4);
        }
      }
    });
  });

  const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>): void => {
    e.preventDefault(); // no page text selection while dragging UVs
    const rect = e.currentTarget.getBoundingClientRect();
    const p: Vec2 = [e.clientX - rect.left, e.clientY - rect.top];
    e.currentTarget.setPointerCapture(e.pointerId);
    if (e.button === 2 || e.button === 1) {
      setDrag({ kind: "pan", start: p, last: p, delta: [0, 0], angle: 0, scale: 1 });
      return;
    }
    // click on an unselected face selects it (Shift adds)
    const uv = toUv(p[0], p[1]);
    const hit = mesh.faces.findIndex((_, fi) => pointInPolygon(uv, uvs[fi] ?? []));
    if (hit >= 0 && !selected.has(hit)) {
      props.onSelectFaces(e.shiftKey ? [...faces, hit] : [hit]);
      return;
    }
    if (faces.length === 0) return;
    setDrag({ kind: e.ctrlKey ? "rotate" : e.shiftKey ? "scale" : "move", start: p, last: p, delta: [0, 0], angle: 0, scale: 1 });
  };
  const onPointerMove = (e: React.PointerEvent<HTMLCanvasElement>): void => {
    if (!drag) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const p: Vec2 = [e.clientX - rect.left, e.clientY - rect.top];
    if (drag.kind === "pan") {
      setView({ ...view, pan: [view.pan[0] + p[0] - drag.last[0], view.pan[1] + p[1] - drag.last[1]] });
      setDrag({ ...drag, last: p });
      return;
    }
    const a = toUv(drag.start[0], drag.start[1]);
    const b = toUv(p[0], p[1]);
    let delta: Vec2 = [b[0] - a[0], b[1] - a[1]];
    if (snap) delta = [Math.round(delta[0] * 16) / 16, Math.round(delta[1] * 16) / 16];
    const center = selectionCenter();
    const [cx, cy] = toPx(center[0], center[1]);
    const angle = Math.atan2(-(p[1] - cy), p[0] - cx) - Math.atan2(-(drag.start[1] - cy), drag.start[0] - cx);
    const scale = Math.max(0.05, Math.hypot(p[0] - cx, p[1] - cy) / Math.max(1, Math.hypot(drag.start[0] - cx, drag.start[1] - cy)));
    setDrag({ ...drag, last: p, delta, angle: snap ? Math.round((angle * 180) / Math.PI / 5) * ((5 * Math.PI) / 180) : angle, scale });
  };
  const onPointerUp = (): void => {
    if (!drag) return;
    const d = drag;
    setDrag(null);
    if (d.kind === "pan" || faces.length === 0) return;
    if (d.kind === "move" && d.delta[0] === 0 && d.delta[1] === 0) return;
    if (d.kind === "rotate" && d.angle === 0) return;
    if (d.kind === "scale" && d.scale === 1) return;
    commit(
      transformUvs(mesh, faces, {
        translate: d.kind === "move" ? d.delta : undefined,
        rotate: d.kind === "rotate" ? (d.angle * 180) / Math.PI : undefined,
        scale: d.kind === "scale" ? [d.scale, d.scale] : undefined,
        pivot: selectionCenter(),
      }),
    );
  };
  const onWheel = (e: React.WheelEvent<HTMLCanvasElement>): void => {
    const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
    setView({ ...view, zoom: Math.max(0.1, Math.min(20, view.zoom * factor)) });
  };

  const small: React.CSSProperties = { ...buttonStyle, padding: "2px 7px", font: "11px ui-monospace, monospace" };
  const section: React.CSSProperties = { display: "flex", flexWrap: "wrap", gap: 3, padding: "4px 6px", borderTop: "1px solid #21262d" };
  const setAuto = (patch: Partial<Omit<FaceUv, "coords" | "mode">>): void => commit(setAutoUv(mesh, target, patch));

  return (
    <div>
      <canvas
        ref={canvasRef}
        width={SIZE}
        height={SIZE}
        style={{ display: "block", margin: "6px auto", cursor: drag ? "grabbing" : "crosshair", touchAction: "none" }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onWheel={onWheel}
        onContextMenu={(e) => e.preventDefault()}
      />
      <div style={{ ...section, color: "#8b949e", fontSize: 10 }}>
        {faces.length} face(s) · drag move · Ctrl+drag rotate · Shift+drag scale · wheel zoom · right-drag pan · click a face to select
        <label style={{ display: "flex", gap: 3, alignItems: "center" }}>
          <input type="checkbox" checked={snap} onChange={(e) => setSnap(e.target.checked)} /> snap 1/16
        </label>
        <label style={{ display: "flex", gap: 3, alignItems: "center" }}>
          <input type="checkbox" checked={showAll} onChange={(e) => setShowAll(e.target.checked)} /> all faces
        </label>
        <button style={small} onClick={() => setView({ zoom: 1, pan: [0, 0] })}>reset view</button>
      </div>

      <div style={section}>
        <span style={{ width: "100%", color: "#8b949e", fontSize: 10 }}>
          MODE · {allManual ? "manual (explicit coordinates)" : anyManual ? "mixed" : "auto (projected from settings)"}
        </span>
        <button style={!anyManual ? activeButtonStyle : small} title="Back to auto-unwrap with default settings" onClick={() => commit(resetUvs(mesh, target))}>
          auto / reset
        </button>
        <button style={small} title="Planar-project the selection together onto one plane (seamless across the faces)" onClick={() => commit(planarProjectFaces(mesh, target))}>
          planar project
        </button>
        <button style={small} title="Project each face along its dominant axis" onClick={() => commit(boxProjectFaces(mesh, target))}>
          box project
        </button>
        <button style={small} title="Scale the selection into the 0..1 tile, keeping aspect" onClick={() => commit(fitUvs(mesh, target))}>
          fit
        </button>
        <button style={small} title="Stretch the selection to fill 0..1 exactly" onClick={() => commit(fitUvs(mesh, target, true))}>
          stretch
        </button>
        <button style={small} onClick={() => commit(flipUvs(mesh, target, "u"))}>flip U</button>
        <button style={small} onClick={() => commit(flipUvs(mesh, target, "v"))}>flip V</button>
        <button
          style={small}
          title="Copy the first selected face's UV settings/coords onto the others"
          disabled={target.length < 2}
          onClick={() => commit(copyUvs(mesh, target[0]!, target.slice(1)))}
        >
          copy first → rest
        </button>
      </div>

      <div style={{ ...section, display: "block" }}>
        <div style={{ color: "#8b949e", fontSize: 10, marginBottom: 2 }}>AUTO SETTINGS · applied to {target.length} face(s){anyManual ? " (switches them back to auto)" : ""}</div>
        <Row label="tiling">
          <div style={{ display: "flex", gap: 2 }}>
            <NumberField value={settings.scale[0]} onCommit={(v) => setAuto({ scale: [v, settings.scale[1]] })} />
            <NumberField value={settings.scale[1]} onCommit={(v) => setAuto({ scale: [settings.scale[0], v] })} />
          </div>
        </Row>
        <Row label="offset">
          <div style={{ display: "flex", gap: 2 }}>
            <NumberField value={settings.offset[0]} onCommit={(v) => setAuto({ offset: [v, settings.offset[1]] })} />
            <NumberField value={settings.offset[1]} onCommit={(v) => setAuto({ offset: [settings.offset[0], v] })} />
          </div>
        </Row>
        <Row label="rotation">
          <NumberField value={settings.rotation} onCommit={(v) => setAuto({ rotation: v })} />
        </Row>
        <Row label="anchor">
          <select style={{ ...small, width: "100%" }} value={settings.anchor} onChange={(e) => setAuto({ anchor: e.target.value as FaceUv["anchor"] })}>
            {UV_ANCHORS.map((a) => (
              <option key={a} value={a}>{a}</option>
            ))}
          </select>
        </Row>
        <Row label="fill">
          <select style={{ ...small, width: "100%" }} value={settings.fill} onChange={(e) => setAuto({ fill: e.target.value as FaceUv["fill"] })}>
            {UV_FILLS.map((f) => (
              <option key={f} value={f}>{f}</option>
            ))}
          </select>
        </Row>
        <Row label="group">
          <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
            <NumberField value={settings.group} onCommit={(v) => setAuto({ group: Math.max(0, Math.round(v)) })} />
            <button style={small} title="Put the selected faces in a fresh texture group (one seamless projection)" onClick={() => setAuto({ group: nextGroup(mesh) })}>
              group
            </button>
            <button style={small} title="Ungroup" onClick={() => setAuto({ group: 0 })}>
              ungroup
            </button>
          </div>
        </Row>
        <Row label="flip / swap">
          <div style={{ display: "flex", gap: 8 }}>
            <label title="flip U"><BooleanField value={settings.flipU} onCommit={(v) => setAuto({ flipU: v })} /> U</label>
            <label title="flip V"><BooleanField value={settings.flipV} onCommit={(v) => setAuto({ flipV: v })} /> V</label>
            <label title="swap U and V"><BooleanField value={settings.swapUV} onCommit={(v) => setAuto({ swapUV: v })} /> swap</label>
            <label title="project in world space (textures flow across objects)"><BooleanField value={settings.worldSpace} onCommit={(v) => setAuto({ worldSpace: v })} /> world</label>
          </div>
        </Row>
      </div>
    </div>
  );
}

function nextGroup(mesh: PolyMesh): number {
  const used = new Set(mesh.faces.map((f) => f.uv?.group ?? 0));
  let g = 1;
  while (used.has(g)) g++;
  return g;
}

function pointInPolygon(p: Vec2, poly: Vec2[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i]!;
    const b = poly[j]!;
    if (a[1] > p[1] !== b[1] > p[1] && p[0] < ((b[0] - a[0]) * (p[1] - a[1])) / (b[1] - a[1] + 1e-12) + a[0]) inside = !inside;
  }
  return inside;
}

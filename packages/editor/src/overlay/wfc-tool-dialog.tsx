import { useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three/webgpu";
import {
  expandScene,
  type AssetLibrary,
  type ComponentRegistry,
  type EntityDoc,
  type SceneDoc,
  type ToolDefinition,
  type ToolFileValue,
  type ToolResult,
} from "@hitreg/core";
import { buildScene, EngineRenderer, type MaterialData } from "@hitreg/render";
import { buttonStyle } from "./common.js";

type Direction = "px" | "nx" | "py" | "ny" | "pz" | "nz";
type Vec3 = [number, number, number];
type Rotation = 0 | 90 | 180 | 270;

const DIRECTIONS: Array<{ id: Direction; label: string }> = [
  { id: "px", label: "+X right" },
  { id: "nx", label: "−X left" },
  { id: "py", label: "+Y top" },
  { id: "ny", label: "−Y bottom" },
  { id: "pz", label: "+Z front" },
  { id: "nz", label: "−Z back" },
];
const ROTATIONS: Rotation[] = [0, 90, 180, 270];

interface TileDraft {
  id: string;
  prefabId?: string;
  weight: number;
  offset: Vec3;
  rotations: Rotation[];
  sockets: Record<Direction, string>;
  /** Learned tilesets (tools/wfc-3d/kit.mjs): children whose texture counter-rotates; passed through untouched. */
  alignUv?: unknown;
}

interface TilesetDraft {
  version: 1;
  name: string;
  cellSize: Vec3;
  boundary: Partial<Record<Direction, string>>;
  tiles: TileDraft[];
  pins: Array<{ at: Vec3; tile: string; rotation?: Rotation }>;
  /** Learned tilesets: allowed face pairs and the tile beyond the grid. The
   * form does not edit these, but dropping them would silently turn a learned
   * tileset back into exact-socket matching, so they ride along. */
  adjacency?: unknown;
  outside?: unknown;
}

interface PreviewBounds {
  min: Vec3;
  max: Vec3;
  center: Vec3;
  size: Vec3;
}

const inputStyle: React.CSSProperties = {
  width: "100%",
  boxSizing: "border-box",
  background: "#161b22",
  border: "1px solid #30363d",
  borderRadius: 3,
  color: "#c9d1d9",
  font: "11px ui-monospace, monospace",
  padding: "4px 6px",
};

const panelStyle: React.CSSProperties = {
  minHeight: 0,
  overflow: "auto",
  padding: 10,
  borderRight: "1px solid #21262d",
};

function slug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "tile";
}

function uniqueTileId(prefabId: string | undefined, tiles: TileDraft[]): string {
  const base = slug(prefabId?.split("/").pop() ?? "empty");
  let id = base;
  let suffix = 2;
  while (tiles.some((tile) => tile.id === id)) id = `${base}-${suffix++}`;
  return id;
}

function newTile(prefabId: string | undefined, tiles: TileDraft[]): TileDraft {
  return {
    id: uniqueTileId(prefabId, tiles),
    ...(prefabId ? { prefabId } : {}),
    weight: 1,
    offset: [0, 0, 0],
    rotations: [0, 90, 180, 270],
    sockets: { px: "open", nx: "open", py: "stack", ny: "stack", pz: "open", nz: "open" },
  };
}

function toolDefault(tool: ToolDefinition, name: string, fallback: unknown): unknown {
  const input = tool.inputs[name];
  return input && "default" in input ? input.default : fallback;
}

function encodeJson(value: unknown): ToolFileValue {
  const bytes = new TextEncoder().encode(JSON.stringify(value, null, 2));
  let binary = "";
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  }
  return { name: "wfc-tileset.json", mediaType: "application/json", data: btoa(binary) };
}

function normalizeImported(raw: unknown): TilesetDraft {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("tileset root must be an object");
  const value = raw as Record<string, unknown>;
  if (!Array.isArray(value.tiles)) throw new Error("tileset must contain a tiles array");
  const cellSize = (Array.isArray(value.cellSize) && value.cellSize.length === 3
    ? value.cellSize.map(Number) as Vec3
    : [1, 1, 1]) as Vec3;
  const tiles: TileDraft[] = value.tiles.map((rawTile, index) => {
    if (!rawTile || typeof rawTile !== "object" || Array.isArray(rawTile)) {
      throw new Error(`tile ${index} must be an object`);
    }
    const tile = rawTile as Record<string, unknown>;
    const sockets = (tile.sockets ?? {}) as Record<string, unknown>;
    const rotations = (Array.isArray(tile.rotations) ? tile.rotations : [0])
      .map(Number)
      .filter((rotation): rotation is Rotation => ROTATIONS.includes(rotation as Rotation));
    return {
      id: String(tile.id ?? `tile-${index + 1}`),
      ...(typeof tile.prefabId === "string" && tile.prefabId ? { prefabId: tile.prefabId } : {}),
      weight: Number(tile.weight ?? 1),
      offset: (Array.isArray(tile.offset) && tile.offset.length === 3
        ? tile.offset.map(Number)
        : [0, 0, 0]) as Vec3,
      rotations: (rotations.length > 0 ? rotations : [0]) as Rotation[],
      sockets: Object.fromEntries(
        DIRECTIONS.map(({ id }) => [id, typeof sockets[id] === "string" ? sockets[id] : "open"]),
      ) as Record<Direction, string>,
      ...(tile.alignUv !== undefined ? { alignUv: tile.alignUv } : {}),
    };
  });
  const boundaryRaw = value.boundary && typeof value.boundary === "object" && !Array.isArray(value.boundary)
    ? value.boundary as Record<string, unknown>
    : {};
  const boundary = Object.fromEntries(
    DIRECTIONS.flatMap(({ id }) => typeof boundaryRaw[id] === "string" && boundaryRaw[id]
      ? [[id, boundaryRaw[id]]]
      : []),
  ) as Partial<Record<Direction, string>>;
  const pins = Array.isArray(value.pins) ? value.pins as TilesetDraft["pins"] : [];
  return {
    version: 1,
    name: typeof value.name === "string" ? value.name : "Prefab WFC tileset",
    cellSize,
    boundary,
    tiles,
    pins,
    ...(value.adjacency !== undefined ? { adjacency: value.adjacency } : {}),
    ...(typeof value.outside === "string" ? { outside: value.outside } : {}),
  };
}

function rotateOffset(offset: Vec3, degrees: number): Vec3 {
  const radians = (degrees * Math.PI) / 180;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  return [offset[0] * cos + offset[2] * sin, offset[1], -offset[0] * sin + offset[2] * cos];
}

function quatY(degrees: number): [number, number, number, number] {
  const half = (degrees * Math.PI) / 360;
  return [0, Math.sin(half), 0, Math.cos(half)];
}

function vectorRow(label: string, value: Vec3, onChange: (value: Vec3) => void) {
  return (
    <label style={{ display: "grid", gridTemplateColumns: "82px 1fr", gap: 7, alignItems: "center" }}>
      <span style={{ color: "#8b949e" }}>{label}</span>
      <span style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 4 }}>
        {value.map((component, index) => (
          <input
            key={index}
            type="number"
            step="0.1"
            style={inputStyle}
            value={component}
            onChange={(event) => {
              const next = [...value] as Vec3;
              next[index] = Number(event.target.value);
              onChange(next);
            }}
          />
        ))}
      </span>
    </label>
  );
}

function WfcPreview(props: {
  prefabId?: string;
  assets: AssetLibrary;
  registry: ComponentRegistry;
  cellSize: Vec3;
  offset: Vec3;
  rotation: Rotation;
  showGrid: boolean;
  onBounds: (bounds: PreviewBounds | null) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const onBoundsRef = useRef(props.onBounds);
  const [error, setError] = useState("");
  onBoundsRef.current = props.onBounds;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let cancelled = false;
    let frame = 0;
    let engine: EngineRenderer | null = null;
    let observer: ResizeObserver | null = null;
    const orbit = {
      yaw: Math.PI * 0.22,
      pitch: Math.PI * 0.16,
      radius: Math.max(...props.cellSize) * 2.35,
      dragging: false,
      x: 0,
      y: 0,
    };

    const pointerDown = (event: PointerEvent) => {
      orbit.dragging = true;
      orbit.x = event.clientX;
      orbit.y = event.clientY;
      canvas.setPointerCapture(event.pointerId);
    };
    const pointerMove = (event: PointerEvent) => {
      if (!orbit.dragging) return;
      orbit.yaw -= (event.clientX - orbit.x) * 0.008;
      orbit.pitch = Math.max(-1.25, Math.min(1.25, orbit.pitch + (event.clientY - orbit.y) * 0.008));
      orbit.x = event.clientX;
      orbit.y = event.clientY;
    };
    const pointerUp = (event: PointerEvent) => {
      orbit.dragging = false;
      if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
    };
    const wheel = (event: WheelEvent) => {
      event.preventDefault();
      const min = Math.max(...props.cellSize) * 0.65;
      const max = Math.max(...props.cellSize) * 8;
      orbit.radius = Math.max(min, Math.min(max, orbit.radius * Math.exp(event.deltaY * 0.001)));
    };
    canvas.addEventListener("pointerdown", pointerDown);
    canvas.addEventListener("pointermove", pointerMove);
    canvas.addEventListener("pointerup", pointerUp);
    canvas.addEventListener("pointercancel", pointerUp);
    canvas.addEventListener("wheel", wheel, { passive: false });

    void (async () => {
      try {
        engine = new EngineRenderer(canvas);
        await engine.init();
        if (cancelled) return;

        const offset = rotateOffset(props.offset, props.rotation);
        const entities: Record<string, EntityDoc> = props.prefabId
          ? {
              subject: {
                name: "Subject",
                parent: null,
                tags: [],
                components: {
                  transform: { position: offset, rotation: quatY(props.rotation) },
                  prefab: { prefabId: props.prefabId },
                },
              },
            }
          : {};
        const doc: SceneDoc = {
          version: 1 as const,
          name: "wfc-prefab-preview",
          entities,
        };
        const expanded = expandScene(doc, props.assets, props.registry);
        const built = buildScene(expanded, {
          resolveMaterial: (id: string) => props.assets.getDataAsset(id)?.data as MaterialData | undefined,
          resolveModel: (id: string) => props.assets.getModel(id)?.url,
          resolveTexture: (id: string) => props.assets.getTexture(id)?.url,
        });
        built.scene.background = new THREE.Color(0x0b0e14);
        built.scene.add(new THREE.AmbientLight(0xffffff, 1.5));
        const sun = new THREE.DirectionalLight(0xfff1d6, 3);
        sun.position.set(5, 8, 6);
        built.scene.add(sun);

        const [sx, sy, sz] = props.cellSize;
        if (props.showGrid) {
          const span = Math.max(sx, sz) * 5;
          const grid = new THREE.GridHelper(span, 10, 0x3c6e9e, 0x30363d);
          grid.position.y = -0.001;
          built.scene.add(grid);
          const edges = new THREE.LineSegments(
            new THREE.EdgesGeometry(new THREE.BoxGeometry(sx, sy, sz)),
            new THREE.LineBasicMaterial({ color: 0x79c0ff, transparent: true, opacity: 0.92 }),
          );
          edges.position.y = sy / 2;
          built.scene.add(edges);
          const floor = new THREE.Mesh(
            new THREE.PlaneGeometry(sx, sz),
            new THREE.MeshBasicMaterial({ color: 0x1f6feb, transparent: true, opacity: 0.08, side: THREE.DoubleSide }),
          );
          floor.rotation.x = -Math.PI / 2;
          built.scene.add(floor);
          built.scene.add(new THREE.AxesHelper(Math.min(sx, sy, sz) * 0.35));
        }

        const camera = new THREE.PerspectiveCamera(45, 1, 0.01, Math.max(...props.cellSize) * 30);
        const target = new THREE.Vector3(0, sy * 0.45, 0);
        const resize = () => {
          const width = Math.max(1, canvas.clientWidth);
          const height = Math.max(1, canvas.clientHeight);
          engine?.setSize(width, height, Math.min(devicePixelRatio, 2));
          camera.aspect = width / height;
          camera.updateProjectionMatrix();
        };
        observer = new ResizeObserver(resize);
        observer.observe(canvas);
        resize();

        const subject = props.prefabId ? built.objects.get("subject") : undefined;
        let lastBounds = "";
        const render = () => {
          if (cancelled || !engine) return;
          const horizontal = Math.cos(orbit.pitch) * orbit.radius;
          camera.position.set(
            target.x + Math.sin(orbit.yaw) * horizontal,
            target.y + Math.sin(orbit.pitch) * orbit.radius,
            target.z + Math.cos(orbit.yaw) * horizontal,
          );
          camera.lookAt(target);
          if (subject) {
            subject.updateWorldMatrix(true, true);
            const box = new THREE.Box3().setFromObject(subject, true);
            if (!box.isEmpty()) {
              const center = box.getCenter(new THREE.Vector3());
              const size = box.getSize(new THREE.Vector3());
              const signature = [...box.min.toArray(), ...box.max.toArray()].map((n) => n.toFixed(4)).join(":");
              if (signature !== lastBounds) {
                lastBounds = signature;
                onBoundsRef.current({
                  min: box.min.toArray() as Vec3,
                  max: box.max.toArray() as Vec3,
                  center: center.toArray() as Vec3,
                  size: size.toArray() as Vec3,
                });
              }
            }
          } else {
            onBoundsRef.current(null);
          }
          engine.render(built.scene, camera);
          frame = requestAnimationFrame(render);
        };
        render();
      } catch (reason) {
        if (!cancelled) setError(reason instanceof Error ? reason.message : String(reason));
      }
    })();

    return () => {
      cancelled = true;
      cancelAnimationFrame(frame);
      observer?.disconnect();
      canvas.removeEventListener("pointerdown", pointerDown);
      canvas.removeEventListener("pointermove", pointerMove);
      canvas.removeEventListener("pointerup", pointerUp);
      canvas.removeEventListener("pointercancel", pointerUp);
      canvas.removeEventListener("wheel", wheel);
      engine?.dispose();
      onBoundsRef.current(null);
    };
  }, [props.assets, props.registry, props.prefabId, props.rotation, props.offset, props.cellSize, props.showGrid]);

  return (
    <div style={{ position: "relative", height: "100%", minHeight: 310, background: "#0b0e14" }}>
      <canvas
        ref={canvasRef}
        tabIndex={0}
        aria-label="Interactive 3D prefab cell preview"
        title="drag to orbit · wheel to zoom"
        style={{ display: "block", width: "100%", height: "100%", cursor: "grab", touchAction: "none" }}
      />
      <span style={{ position: "absolute", left: 8, bottom: 7, color: "#8b949e", fontSize: 10, pointerEvents: "none" }}>
        drag orbit · wheel zoom · blue box = one WFC cell
      </span>
      {error && (
        <div role="alert" style={{ position: "absolute", inset: 8, padding: 8, color: "#ffb4ab", background: "rgba(39,23,24,.92)", border: "1px solid #7d3a3a" }}>
          preview failed: {error}
        </div>
      )}
    </div>
  );
}

function ResultView({ result }: { result: ToolResult }) {
  return (
    <div style={{ borderTop: "1px solid #21262d", marginTop: 8, paddingTop: 8 }}>
      {result.assets.length > 0 && <div>wrote {result.assets.map((asset) => asset.file).join(", ")}</div>}
      {result.previews.map((preview) => (
        <img
          key={preview.label}
          src={`data:${preview.mediaType};base64,${preview.data}`}
          alt={preview.label}
          style={{ marginTop: 7, maxWidth: "100%", maxHeight: 150, objectFit: "contain", background: "#161b22" }}
        />
      ))}
      {result.warnings.map((warning, index) => (
        <div key={index} style={{ color: "#e3b341", marginTop: 5 }}>warning: {warning}</div>
      ))}
      {result.report !== undefined && (
        <details style={{ marginTop: 6 }}>
          <summary style={{ color: "#8b949e", cursor: "pointer" }}>generation report</summary>
          <pre style={{ padding: 7, overflow: "auto", background: "#161b22", fontSize: 10 }}>
            {JSON.stringify(result.report, null, 2)}
          </pre>
        </details>
      )}
    </div>
  );
}

export function WfcToolDialog(props: {
  tool: ToolDefinition;
  assets: AssetLibrary;
  registry: ComponentRegistry;
  thumbnails?: Record<string, string>;
  onClose: () => void;
  onRun: (id: string, inputs: Record<string, unknown>) => Promise<ToolResult>;
}) {
  const prefabIds = useMemo(() => props.assets.prefabIds().sort(), [props.assets]);
  const [draft, setDraft] = useState<TilesetDraft>(() => ({
    version: 1,
    name: "Prefab WFC tileset",
    cellSize: [4, 4, 4],
    boundary: {},
    tiles: prefabIds[0] ? [newTile(prefabIds[0], [])] : [],
    pins: [],
  }));
  const [selectedId, setSelectedId] = useState(draft.tiles[0]?.id ?? "");
  const [addPrefabId, setAddPrefabId] = useState(prefabIds[0] ?? "");
  const [previewRotation, setPreviewRotation] = useState<Rotation>(0);
  const [showGrid, setShowGrid] = useState(true);
  const [bounds, setBounds] = useState<PreviewBounds | null>(null);
  const [output, setOutput] = useState(String(toolDefault(props.tool, "name", "generated/wfc-layout")));
  const [width, setWidth] = useState(Number(toolDefault(props.tool, "width", 8)));
  const [height, setHeight] = useState(Number(toolDefault(props.tool, "height", 4)));
  const [depth, setDepth] = useState(Number(toolDefault(props.tool, "depth", 8)));
  const [seed, setSeed] = useState(Number(toolDefault(props.tool, "seed", 1)));
  const [attempts, setAttempts] = useState(Number(toolDefault(props.tool, "attempts", 20)));
  const [origin, setOrigin] = useState(String(toolDefault(props.tool, "origin", "center")));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<ToolResult | null>(null);
  const selected = draft.tiles.find((tile) => tile.id === selectedId) ?? null;

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !busy) props.onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [busy, props.onClose]);

  const updateSelected = (patch: Partial<TileDraft>) => {
    if (!selected) return;
    setDraft((current) => ({
      ...current,
      tiles: current.tiles.map((tile) => tile.id === selected.id ? { ...tile, ...patch } : tile),
    }));
    if (patch.id) setSelectedId(patch.id);
  };

  const addTile = (prefabId?: string) => {
    const tile = newTile(prefabId, draft.tiles);
    setDraft((current) => ({ ...current, tiles: [...current.tiles, tile] }));
    setSelectedId(tile.id);
    setPreviewRotation(0);
  };

  const removeSelected = () => {
    if (!selected) return;
    const remaining = draft.tiles.filter((tile) => tile.id !== selected.id);
    setDraft((current) => ({ ...current, tiles: remaining }));
    setSelectedId(remaining[0]?.id ?? "");
  };

  const centerSelected = () => {
    if (!selected || !bounds) return;
    const worldCorrection: Vec3 = [-bounds.center[0], -bounds.min[1], -bounds.center[2]];
    const baseCorrection = rotateOffset(worldCorrection, (360 - previewRotation) % 360);
    updateSelected({
      offset: [
        selected.offset[0] + baseCorrection[0],
        selected.offset[1] + baseCorrection[1],
        selected.offset[2] + baseCorrection[2],
      ],
    });
  };

  const fitsCell = bounds
    ? bounds.min[0] >= -draft.cellSize[0] / 2 - 0.001 &&
      bounds.max[0] <= draft.cellSize[0] / 2 + 0.001 &&
      bounds.min[1] >= -0.001 &&
      bounds.max[1] <= draft.cellSize[1] + 0.001 &&
      bounds.min[2] >= -draft.cellSize[2] / 2 - 0.001 &&
      bounds.max[2] <= draft.cellSize[2] / 2 + 0.001
    : null;

  const run = async () => {
    setBusy(true);
    setError("");
    setResult(null);
    try {
      setResult(await props.onRun(props.tool.id, {
        tileset: encodeJson(draft),
        name: output,
        width,
        height,
        depth,
        seed,
        attempts,
        origin,
      }));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !busy) props.onClose();
      }}
      style={{ position: "fixed", inset: 0, zIndex: 1400, display: "flex", alignItems: "center", justifyContent: "center", background: "rgba(6,8,12,.78)", pointerEvents: "auto" }}
    >
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby="hitreg-wfc-title"
        style={{ width: 1120, maxWidth: "calc(100vw - 24px)", height: 720, maxHeight: "calc(100vh - 24px)", display: "flex", flexDirection: "column", overflow: "hidden", background: "#0d1117", border: "1px solid #30363d", color: "#c9d1d9", font: "11px ui-monospace, monospace" }}
      >
        <header style={{ padding: "8px 10px", borderBottom: "1px solid #21262d", background: "#161b22", display: "flex", alignItems: "center", gap: 8 }}>
          <div style={{ flex: 1 }}>
            <strong id="hitreg-wfc-title" style={{ color: "#e6edf3", fontSize: 12 }}>3D Prefab WFC</strong>
            <span style={{ color: "#8b949e", marginLeft: 8 }}>prefab tiles → centered grid cells → composite prefab</span>
          </div>
          <label style={{ ...buttonStyle, cursor: busy ? "default" : "pointer" }}>
            import tileset
            <input
              type="file"
              accept="application/json,.json"
              disabled={busy}
              style={{ display: "none" }}
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (!file) return;
                void file.text().then((text) => {
                  const imported = normalizeImported(JSON.parse(text));
                  setDraft(imported);
                  setSelectedId(imported.tiles[0]?.id ?? "");
                  setError("");
                }).catch((reason) => setError(reason instanceof Error ? reason.message : String(reason)));
              }}
            />
          </label>
          <button style={buttonStyle} disabled={busy} onClick={props.onClose}>close</button>
        </header>

        <div style={{ minHeight: 0, flex: 1, display: "grid", gridTemplateColumns: "230px minmax(360px, 1fr) 330px" }}>
          <aside style={panelStyle}>
            <strong style={{ color: "#e6edf3" }}>prefab tiles</strong>
            <div style={{ display: "grid", gridTemplateColumns: "1fr auto", gap: 5, marginTop: 8 }}>
              <select style={inputStyle} value={addPrefabId} onChange={(event) => setAddPrefabId(event.target.value)}>
                {prefabIds.map((id) => <option key={id} value={id}>{id}</option>)}
              </select>
              <button style={buttonStyle} disabled={!addPrefabId} onClick={() => addTile(addPrefabId)}>add</button>
            </div>
            <button style={{ ...buttonStyle, width: "100%", marginTop: 5 }} onClick={() => addTile(undefined)}>+ empty tile</button>
            <div style={{ display: "flex", flexDirection: "column", gap: 5, marginTop: 9 }}>
              {draft.tiles.map((tile) => (
                <button
                  key={tile.id}
                  onClick={() => { setSelectedId(tile.id); setPreviewRotation(tile.rotations[0] ?? 0); }}
                  style={{ display: "grid", gridTemplateColumns: "42px 1fr", gap: 7, alignItems: "center", textAlign: "left", padding: 4, border: tile.id === selectedId ? "1px solid #79c0ff" : "1px solid #30363d", background: tile.id === selectedId ? "#1f3a5f" : "#161b22", color: "#c9d1d9", cursor: "pointer" }}
                >
                  {tile.prefabId && props.thumbnails?.[tile.prefabId]
                    ? <img src={props.thumbnails[tile.prefabId]} alt="" style={{ width: 42, height: 42, objectFit: "contain", background: "#0b0e14" }} />
                    : <span style={{ width: 42, height: 42, display: "grid", placeItems: "center", color: "#8b949e", background: "#0b0e14" }}>{tile.prefabId ? "◆" : "∅"}</span>}
                  <span style={{ minWidth: 0 }}>
                    <span style={{ display: "block", overflow: "hidden", textOverflow: "ellipsis" }}>{tile.id}</span>
                    <span style={{ display: "block", color: "#8b949e", fontSize: 10, overflow: "hidden", textOverflow: "ellipsis" }}>{tile.prefabId ?? "empty"}</span>
                  </span>
                </button>
              ))}
            </div>
          </aside>

          <main style={{ minWidth: 0, minHeight: 0, display: "grid", gridTemplateRows: "1fr auto", borderRight: "1px solid #21262d" }}>
            <WfcPreview
              prefabId={selected?.prefabId}
              assets={props.assets}
              registry={props.registry}
              cellSize={draft.cellSize}
              offset={selected?.offset ?? [0, 0, 0]}
              rotation={previewRotation}
              showGrid={showGrid}
              onBounds={setBounds}
            />
            <div style={{ padding: 8, borderTop: "1px solid #21262d", background: "#161b22", display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
              <label style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
                <input type="checkbox" checked={showGrid} onChange={(event) => setShowGrid(event.target.checked)} /> grid + cell
              </label>
              <span style={{ width: 1, height: 18, background: "#30363d" }} />
              {ROTATIONS.map((rotation) => (
                <button key={rotation} style={{ ...buttonStyle, ...(previewRotation === rotation ? { background: "#1f3a5f", borderColor: "#79c0ff" } : {}) }} onClick={() => setPreviewRotation(rotation)}>{rotation}°</button>
              ))}
              <span style={{ flex: 1 }} />
              {fitsCell !== null && <span style={{ color: fitsCell ? "#7ee787" : "#e3b341" }}>{fitsCell ? "fits cell" : "overflows cell"}</span>}
              <button style={buttonStyle} disabled={!selected?.prefabId || !bounds} onClick={centerSelected}>center + ground</button>
            </div>
          </main>

          <aside style={{ ...panelStyle, borderRight: 0 }}>
            {selected ? (
              <>
                <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  <strong style={{ color: "#e6edf3", flex: 1 }}>selected tile</strong>
                  <button style={buttonStyle} onClick={removeSelected}>remove</button>
                </div>
                <div style={{ display: "flex", flexDirection: "column", gap: 7, marginTop: 8 }}>
                  <label>id<input style={{ ...inputStyle, marginTop: 3 }} value={selected.id} onChange={(event) => updateSelected({ id: event.target.value })} /></label>
                  <label>prefab
                    <select style={{ ...inputStyle, marginTop: 3 }} value={selected.prefabId ?? ""} onChange={(event) => updateSelected(event.target.value ? { prefabId: event.target.value } : { prefabId: undefined })}>
                      <option value="">empty / no prefab</option>
                      {prefabIds.map((id) => <option key={id} value={id}>{id}</option>)}
                    </select>
                  </label>
                  <label>weight<input type="number" min={0.001} step={0.1} style={{ ...inputStyle, marginTop: 3 }} value={selected.weight} onChange={(event) => updateSelected({ weight: Number(event.target.value) })} /></label>
                  {vectorRow("offset", selected.offset, (offset) => updateSelected({ offset }))}
                  <div style={{ display: "flex", gap: 5 }}>
                    <button style={buttonStyle} onClick={() => updateSelected({ offset: [0, 0, 0] })}>reset offset</button>
                    {bounds && <span style={{ color: "#8b949e", alignSelf: "center" }}>size {bounds.size.map((n) => n.toFixed(2)).join(" × ")}</span>}
                  </div>
                  <div>
                    <span style={{ color: "#8b949e" }}>allowed rotations</span>
                    <div style={{ display: "flex", gap: 8, marginTop: 4 }}>
                      {ROTATIONS.map((rotation) => (
                        <label key={rotation} style={{ display: "inline-flex", alignItems: "center", gap: 3 }}>
                          <input
                            type="checkbox"
                            checked={selected.rotations.includes(rotation)}
                            onChange={(event) => {
                              const rotations = event.target.checked
                                ? [...selected.rotations, rotation].sort((a, b) => a - b) as Rotation[]
                                : selected.rotations.filter((value) => value !== rotation);
                              updateSelected({ rotations: rotations.length > 0 ? rotations : [rotation] });
                            }}
                          />{rotation}°
                        </label>
                      ))}
                    </div>
                  </div>
                  <div style={{ borderTop: "1px solid #21262d", paddingTop: 7 }}>
                    <span style={{ color: "#8b949e" }}>face sockets · equal labels connect</span>
                    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 5, marginTop: 5 }}>
                      {DIRECTIONS.map(({ id, label }) => (
                        <label key={id} style={{ color: "#8b949e" }}>{label}
                          <input style={{ ...inputStyle, marginTop: 2 }} value={selected.sockets[id]} onChange={(event) => updateSelected({ sockets: { ...selected.sockets, [id]: event.target.value } })} />
                        </label>
                      ))}
                    </div>
                  </div>
                </div>
              </>
            ) : <div style={{ color: "#8b949e" }}>Add a prefab or empty tile to begin.</div>}

            <div style={{ borderTop: "1px solid #30363d", marginTop: 12, paddingTop: 9 }}>
              <strong style={{ color: "#e6edf3" }}>grid + output</strong>
              <div style={{ display: "flex", flexDirection: "column", gap: 7, marginTop: 7 }}>
                <label>tileset name<input style={{ ...inputStyle, marginTop: 3 }} value={draft.name} onChange={(event) => setDraft((current) => ({ ...current, name: event.target.value }))} /></label>
                {vectorRow("cell size", draft.cellSize, (cellSize) => setDraft((current) => ({ ...current, cellSize })))}
                <label>output prefab<input style={{ ...inputStyle, marginTop: 3 }} value={output} onChange={(event) => setOutput(event.target.value)} /></label>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 5 }}>
                  {[["X", width, setWidth], ["Y", height, setHeight], ["Z", depth, setDepth]].map(([label, value, setter]) => (
                    <label key={label as string}>{label as string}<input type="number" min={1} max={48} style={{ ...inputStyle, marginTop: 3 }} value={value as number} onChange={(event) => (setter as (value: number) => void)(Number(event.target.value))} /></label>
                  ))}
                </div>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 5 }}>
                  <label>seed<input type="number" min={0} style={{ ...inputStyle, marginTop: 3 }} value={seed} onChange={(event) => setSeed(Number(event.target.value))} /></label>
                  <label>attempts<input type="number" min={1} max={200} style={{ ...inputStyle, marginTop: 3 }} value={attempts} onChange={(event) => setAttempts(Number(event.target.value))} /></label>
                </div>
                <label>origin<select style={{ ...inputStyle, marginTop: 3 }} value={origin} onChange={(event) => setOrigin(event.target.value)}><option value="center">bottom center</option><option value="min">minimum corner</option></select></label>
                {draft.pins.length > 0 && <span style={{ color: "#8b949e" }}>{draft.pins.length} imported pin(s) preserved</span>}
              </div>
            </div>
            {error && <div role="alert" style={{ marginTop: 8, border: "1px solid #7d3a3a", background: "#271718", color: "#ffb4ab", padding: 7 }}>{error}</div>}
            {result && <ResultView result={result} />}
          </aside>
        </div>

        <footer style={{ display: "flex", alignItems: "center", gap: 7, padding: "7px 10px", borderTop: "1px solid #21262d", background: "#161b22" }}>
          <span style={{ color: "#8b949e", flex: 1 }}>{draft.tiles.length} tile(s) · {width * height * depth} output cells</span>
          <button style={buttonStyle} disabled={busy || draft.tiles.length === 0} onClick={() => void run()}>{busy ? "collapsing…" : result ? "generate again" : "generate prefab"}</button>
        </footer>
      </section>
    </div>
  );
}

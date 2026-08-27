import { useState } from "react";
import type { AssetLibrary, PolyMesh, SceneStore } from "@hitreg/core";
import type {
  ElementMode,
  GizmoMode,
  HandleOrientation,
  MeshEditActions,
  MeshEditParams,
  MeshEditState,
  Observable,
} from "../state.js";
import { activeButtonStyle, buttonStyle, useObservable, useStoreDoc } from "./common.js";
import { NumberField } from "./fields.js";

interface ActionSpec {
  action: string;
  label: string;
  title: string;
  /** Element modes the action makes sense in (empty = all). */
  modes: ElementMode[];
  /** Which numeric param the ⚙ popover edits. */
  param?: keyof MeshEditParams;
  paramLabel?: string;
}

const SELECTION_ACTIONS: ActionSpec[] = [
  { action: "grow", label: "grow", title: "Grow selection (Alt+G)", modes: [] },
  { action: "shrink", label: "shrink", title: "Shrink selection (Alt+Shift+G)", modes: [] },
  { action: "loop", label: "loop", title: "Select edge loop (Alt+L) — also double-click an edge", modes: ["edge", "vertex"] },
  { action: "ring", label: "ring", title: "Select edge ring (Alt+R)", modes: ["edge"] },
  { action: "invert", label: "invert", title: "Invert selection (Ctrl+I)", modes: [] },
  { action: "select-all", label: "all", title: "Select all (Ctrl+A)", modes: [] },
  { action: "select-connected", label: "connected", title: "Select every face connected to the selection", modes: [] },
  { action: "select-coplanar", label: "coplanar", title: "Select the coplanar patch (also double-click a face)", modes: ["face"] },
  { action: "select-material", label: "same mat", title: "Select every face using the selected faces' material", modes: ["face"] },
  { action: "select-hole", label: "holes", title: "Select every open (boundary) edge", modes: [] },
  { action: "select-smoothing", label: "same smooth", title: "Select every face in the selected faces' smoothing groups", modes: ["face"] },
];

const GEOMETRY_ACTIONS: ActionSpec[] = [
  { action: "extrude", label: "extrude", title: "Extrude faces/edges (Alt+E). Shift+drag the gizmo extrudes too.", modes: ["face", "edge"], param: "extrudeDistance", paramLabel: "distance" },
  { action: "inset", label: "inset", title: "Inset faces (Alt+I)", modes: ["face"], param: "insetAmount", paramLabel: "amount" },
  { action: "bevel", label: "bevel", title: "Bevel edges (Alt+B) — in face mode bevels the faces' edges", modes: ["edge", "face"], param: "bevelAmount", paramLabel: "amount" },
  { action: "subdivide", label: "subdivide", title: "Subdivide faces into quads / split edges at their midpoint (Alt+S)", modes: ["face", "edge"] },
  { action: "connect", label: "connect", title: "Connect selected edges (midpoints) or vertices across faces (Alt+C)", modes: ["edge", "vertex"] },
  { action: "insert-loop", label: "insert loop", title: "Insert an edge loop through the selected edge's quad ring (Alt+U)", modes: ["edge"], param: "loopPosition", paramLabel: "position" },
  { action: "bridge", label: "bridge", title: "Bridge two open edges with a quad", modes: ["edge"] },
  { action: "fill", label: "fill hole", title: "Fill the hole touching the selection (Alt+F)", modes: [] },
  { action: "merge", label: "merge", title: "Merge coplanar faces into one n-gon (Alt+M)", modes: ["face"] },
  { action: "triangulate", label: "triangulate", title: "Split quads/n-gons into triangles", modes: ["face"] },
  { action: "flip-edge", label: "flip edge", title: "Rotate the diagonal between two triangles", modes: ["edge"] },
  { action: "duplicate", label: "duplicate", title: "Duplicate faces in place", modes: ["face"] },
  { action: "detach", label: "detach", title: "Detach faces from their neighbors (stays in this mesh)", modes: ["face"] },
  { action: "detach-to-object", label: "→ object", title: "Detach faces into a new entity", modes: ["face"] },
  { action: "collapse", label: "collapse", title: "Collapse vertices to one point", modes: ["vertex", "edge"] },
  { action: "weld", label: "weld", title: "Weld vertices within a distance (Alt+W)", modes: ["vertex"], param: "weldDistance", paramLabel: "distance" },
  { action: "split", label: "split", title: "Split vertices (one per face)", modes: ["vertex"] },
  { action: "snap-to-grid", label: "snap grid", title: "Round the selected vertices to the toolbar's translate snap (all when nothing selected)", modes: [] },
  { action: "delete", label: "delete", title: "Delete elements (Del)", modes: [] },
];

const NORMAL_ACTIONS: ActionSpec[] = [
  { action: "flip", label: "flip normals", title: "Reverse winding of the selected faces (all when nothing selected)", modes: [] },
  { action: "conform", label: "conform", title: "Make winding consistent across the selection", modes: [] },
  { action: "smooth", label: "smooth", title: "Put the selected faces in a new smoothing group (shared shading)", modes: [] },
  { action: "harden", label: "harden", title: "Flat-shade the selected faces (smoothing group 0)", modes: [] },
];

const OBJECT_ACTIONS: ActionSpec[] = [
  { action: "center-pivot", label: "center pivot", title: "Move the pivot to the bounds center", modes: [] },
  { action: "floor-pivot", label: "floor pivot", title: "Move the pivot to the bottom center", modes: [] },
  { action: "pivot-to-selection", label: "pivot → sel", title: "Move the pivot to the selected elements' center", modes: ["vertex", "edge", "face"] },
  { action: "freeze-transform", label: "freeze", title: "Bake the entity transform into the vertices", modes: [] },
  { action: "mirror-x", label: "mirror x", title: "Mirror across the local YZ plane (duplicating)", modes: [] },
  { action: "mirror-y", label: "mirror y", title: "Mirror across the local XZ plane (duplicating)", modes: [] },
  { action: "mirror-z", label: "mirror z", title: "Mirror across the local XY plane (duplicating)", modes: [] },
];

const EMPTY: string[] = [];
const emptyList: Observable<string[]> = { get: () => EMPTY, set: () => undefined, subscribe: () => () => undefined };

/**
 * The ProBuilder element toolbar, docked on the viewport's left edge while
 * mesh-edit mode is on: element mode, gizmo/orientation, then every action
 * that applies to the current mode. Parametric actions expose their number
 * behind a ⚙ so the default (state.params) is one click and a tweak is two.
 */
export function MeshEditPanel(props: {
  state: MeshEditState;
  actions: MeshEditActions | null;
  gizmoMode: Observable<GizmoMode>;
  assets: AssetLibrary;
  assetsVersion: Observable<number>;
  store: SceneStore;
  /** Full entity selection, for the two-object boolean buttons. */
  multiSelection?: Observable<string[]>;
  onOpenUvEditor?: () => void;
}) {
  const doc = useStoreDoc(props.store);
  const multi = useObservable(props.multiSelection ?? emptyList);
  const active = useObservable(props.state.active);
  const mode = useObservable(props.state.mode);
  const orientation = useObservable(props.state.orientation);
  const selectHidden = useObservable(props.state.selectHidden);
  const showSmoothing = useObservable(props.state.showSmoothing);
  const selection = useObservable(props.state.selection);
  const entityId = useObservable(props.state.entityId);
  const params = useObservable(props.state.params);
  const stats = useObservable(props.state.stats);
  const gizmo = useObservable(props.gizmoMode);
  useObservable(props.assetsVersion);
  const [openParam, setOpenParam] = useState<string | null>(null);
  const [color, setColor] = useState("#ff8800");
  const [offset, setOffset] = useState<[number, number, number]>([0, 0, 0]);
  if (!active) return null;

  const setParam = (patch: Partial<MeshEditParams>) => props.state.params.set({ ...params, ...patch });
  const count =
    mode === "vertex" ? selection.vertices.length : mode === "edge" ? selection.edges.length : mode === "face" ? selection.faces.length : 0;
  const materials = props.assets.dataAssetsOfType("material");
  const mesh = entityId ? ((doc.entities[entityId]?.components["mesh"] as { source?: PolyMesh } | undefined)?.source ?? null) : null;
  const soloVertex = mode === "vertex" && selection.vertices.length === 1 && mesh?.kind === "poly" ? selection.vertices[0]! : null;
  const soloPosition = soloVertex !== null ? mesh!.vertices[soloVertex] : undefined;
  const booleanReady = multi.length === 2 && !!entityId;

  const small: React.CSSProperties = { ...buttonStyle, padding: "2px 7px", font: "11px ui-monospace, monospace" };
  const smallActive: React.CSSProperties = { ...activeButtonStyle, padding: "2px 7px", font: "11px ui-monospace, monospace" };
  const section: React.CSSProperties = { display: "flex", flexWrap: "wrap", gap: 3, padding: "4px 6px", borderTop: "1px solid #21262d" };
  const heading: React.CSSProperties = { width: "100%", color: "#8b949e", fontSize: 10, letterSpacing: 0.5 };

  const renderAction = (spec: ActionSpec) => {
    if (spec.modes.length > 0 && mode !== "object" && !spec.modes.includes(mode)) return null;
    const paramValue = spec.param ? (params[spec.param] as number) : undefined;
    return (
      <span key={spec.action} style={{ display: "inline-flex", alignItems: "stretch" }}>
        <button
          style={small}
          title={spec.title}
          disabled={!props.actions || !entityId}
          onClick={() => props.actions?.run(spec.action)}
        >
          {spec.label}
        </button>
        {spec.param && (
          <button
            style={{ ...small, padding: "2px 4px", marginLeft: -1, color: openParam === spec.action ? "#79c0ff" : "#8b949e" }}
            title={`${spec.paramLabel}: ${paramValue}`}
            onClick={() => setOpenParam(openParam === spec.action ? null : spec.action)}
          >
            ⚙
          </button>
        )}
        {spec.param && openParam === spec.action && (
          <span style={{ width: 52, marginLeft: 2 }}>
            <NumberField value={paramValue ?? 0} onCommit={(v) => setParam({ [spec.param!]: v } as Partial<MeshEditParams>)} />
          </span>
        )}
      </span>
    );
  };

  return (
    <div
      style={{
        pointerEvents: "auto",
        alignSelf: "flex-start",
        margin: 6,
        width: 300,
        maxHeight: "calc(100% - 12px)",
        overflowY: "auto",
        background: "rgba(13, 17, 23, 0.94)",
        border: "1px solid #30363d",
        borderRadius: 4,
        color: "#c9d1d9",
        font: "12px ui-monospace, monospace",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 6, padding: "5px 8px", background: "#161b22" }}>
        <strong style={{ color: "#e6edf3", flex: 1 }}>mesh edit</strong>
        <span style={{ color: "#8b949e", fontSize: 10 }}>
          {stats ? `${stats.vertices}v ${stats.edges}e ${stats.faces}f` : "select an editable mesh"}
        </span>
        <button style={small} title="Leave mesh edit mode (Esc twice)" onClick={() => props.state.active.set(false)}>
          ✕
        </button>
      </div>

      <div style={section}>
        {(["object", "vertex", "edge", "face"] as ElementMode[]).map((m, i) => (
          <button
            key={m}
            style={mode === m ? smallActive : small}
            title={`${m} mode (${i + 1})`}
            onClick={() => props.state.mode.set(m)}
          >
            {m}
          </button>
        ))}
        <span style={{ flex: 1 }} />
        <span style={{ color: "#8b949e", fontSize: 10, alignSelf: "center" }}>{count} selected</span>
      </div>

      <div style={section}>
        {(["translate", "rotate", "scale"] as GizmoMode[]).map((g) => (
          <button key={g} style={gizmo === g ? smallActive : small} title={`${g} (W/E/R)`} onClick={() => props.gizmoMode.set(g)}>
            {g === "translate" ? "move" : g}
          </button>
        ))}
        <select
          style={{ ...small, padding: "2px 4px" }}
          title="Gizmo orientation: world axes, entity axes, or the selection's normal"
          value={orientation}
          onChange={(e) => props.state.orientation.set(e.target.value as HandleOrientation)}
        >
          <option value="global">global</option>
          <option value="local">local</option>
          <option value="normal">normal</option>
        </select>
        <label style={{ display: "flex", gap: 3, alignItems: "center", cursor: "pointer", fontSize: 11 }} title="Pick vertices/edges hidden behind the mesh">
          <input type="checkbox" checked={selectHidden} onChange={(e) => props.state.selectHidden.set(e.target.checked)} />
          hidden
        </label>
      </div>

      {mode !== "object" && (
        <>
          <div style={section}>
            <span style={heading}>SELECT</span>
            {SELECTION_ACTIONS.map(renderAction)}
          </div>
          <div style={section}>
            <span style={heading}>GEOMETRY</span>
            {GEOMETRY_ACTIONS.map(renderAction)}
            {mode === "face" && (
              <label style={{ display: "flex", gap: 3, alignItems: "center", fontSize: 10, color: "#8b949e" }} title="How shared corners move when extruding several faces">
                extrude:
                <select
                  style={{ ...small, padding: "1px 3px" }}
                  value={params.extrudeMethod}
                  onChange={(e) => setParam({ extrudeMethod: e.target.value as MeshEditParams["extrudeMethod"] })}
                >
                  <option value="vertex-normal">vertex normal</option>
                  <option value="face-normal">face normal</option>
                  <option value="individual">individual</option>
                </select>
              </label>
            )}
          </div>
          {soloPosition && (
            <div style={section} title="Exact local position of the selected vertex">
              <span style={heading}>VERTEX {soloVertex} POSITION (local)</span>
              {([0, 1, 2] as const).map((axis) => (
                <span key={axis} style={{ width: 62 }}>
                  <NumberField
                    value={soloPosition[axis]}
                    onCommit={(v) => {
                      const next = [...soloPosition] as [number, number, number];
                      next[axis] = v;
                      props.actions?.setVertexPosition(soloVertex!, next);
                    }}
                  />
                </span>
              ))}
            </div>
          )}
          <div style={section} title="Nudge the selected elements by exact local-space amounts">
            <span style={heading}>OFFSET (local units)</span>
            {([0, 1, 2] as const).map((axis) => (
              <span key={axis} style={{ width: 52 }}>
                <NumberField
                  value={offset[axis]}
                  onCommit={(v) => {
                    const next = [...offset] as [number, number, number];
                    next[axis] = v;
                    setOffset(next);
                  }}
                />
              </span>
            ))}
            <button
              style={small}
              disabled={!props.actions || !entityId || count === 0}
              onClick={() => props.actions?.run("offset", { offset })}
            >
              apply
            </button>
          </div>
          <div style={section}>
            <span style={heading}>NORMALS / SHADING</span>
            {NORMAL_ACTIONS.map(renderAction)}
            <label style={{ display: "flex", gap: 3, alignItems: "center", cursor: "pointer", fontSize: 11 }} title="Tint faces by smoothing group (hard faces untinted)">
              <input type="checkbox" checked={showSmoothing} onChange={(e) => props.state.showSmoothing.set(e.target.checked)} />
              show groups
            </label>
          </div>
          <div style={section}>
            <span style={heading}>MATERIAL / COLOR</span>
            <select
              style={{ ...small, padding: "2px 4px", maxWidth: 150 }}
              title="Assign a material to the selected faces (all faces when nothing is selected)"
              value=""
              disabled={!props.actions}
              onChange={(e) => {
                props.actions?.setMaterial(e.target.value);
                e.target.value = "";
              }}
            >
              <option value="">apply material…</option>
              <option value="">(component default)</option>
              {materials.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name.split("/").pop()}
                </option>
              ))}
            </select>
            <input
              type="color"
              value={color}
              onChange={(e) => setColor(e.target.value)}
              title="Face tint color"
              style={{ width: 26, height: 22, padding: 0, border: "1px solid #30363d", borderRadius: 3, background: "none", cursor: "pointer" }}
            />
            <button
              style={small}
              title={mode === "face" ? "Tint the selected faces with the color" : "Paint the selected vertices (per-corner vertex colors)"}
              disabled={!props.actions}
              onClick={() => props.actions?.setColor(color)}
            >
              paint {mode === "face" ? "faces" : "verts"}
            </button>
            <button style={small} title="Clear the tint on the selected faces" disabled={!props.actions} onClick={() => props.actions?.setColor(null)}>
              clear
            </button>
            {props.onOpenUvEditor && (
              <button style={small} title="Open the UV editor for the selected faces" onClick={props.onOpenUvEditor}>
                UV editor
              </button>
            )}
          </div>
        </>
      )}

      <div style={section}>
        <span style={heading}>OBJECT</span>
        {OBJECT_ACTIONS.map(renderAction)}
      </div>

      <div style={section} title="CSG between the two selected entities: the active one (A) takes the result, the other (B) is removed. Undoable.">
        <span style={heading}>BOOLEAN · {booleanReady ? "A = active, B = other selected" : "select exactly 2 entities (Ctrl+click)"}</span>
        {(["union", "subtract", "intersect"] as const).map((op) => (
          <button key={op} style={small} disabled={!props.actions || !booleanReady} onClick={() => props.actions?.boolean(op)}>
            {op === "union" ? "A ∪ B" : op === "subtract" ? "A − B" : "A ∩ B"}
          </button>
        ))}
      </div>

      <div style={{ padding: "4px 8px", color: "#8b949e", fontSize: 10, borderTop: "1px solid #21262d" }}>
        click select · Shift add · Ctrl toggle · Shift/Ctrl+drag marquee · Shift+gizmo extrude · dbl-click coplanar/loop · 1-4 modes · Esc
      </div>
    </div>
  );
}

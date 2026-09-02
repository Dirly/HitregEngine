import { useRef, useState } from "react";
import type {
  AssetLibrary,
  ComponentRegistry,
  SceneStore,
  ToolDefinition,
  ToolResult,
} from "@hitreg/core";
import type {
  EditorSettings,
  ElementMode,
  GizmoMode,
  GrayboxShape,
  MeshEditState,
  Observable,
  PlayMode,
  TerrainBrushSettings,
} from "../state.js";
import { GRAYBOX_SHAPES } from "../state.js";
import type { PathCrossSection } from "../path-tool.js";
import { NumberField } from "./fields.js";
import { Kbd, Tooltip, buttonStyle, useObservable, useStoreDoc } from "./common.js";
import { Icon, type IconName } from "./icons.js";
import { ToolDialog } from "./tool-dialog.js";

const EMPTY_SCENES: string[] = [];
const emptyScenesObservable: Observable<string[]> = {
  get: () => EMPTY_SCENES,
  set: () => undefined,
  subscribe: () => () => undefined,
};
const emptyToolsObservable: Observable<ToolDefinition[]> = {
  get: () => [],
  set: () => undefined,
  subscribe: () => () => undefined,
};
const trueObservable: Observable<boolean> = { get: () => true, set: () => undefined, subscribe: () => () => undefined };
const falseObservable: Observable<boolean> = { get: () => false, set: () => undefined, subscribe: () => () => undefined };
const objectModeObservable: Observable<ElementMode> = { get: () => "object", set: () => undefined, subscribe: () => () => undefined };
const nullObservable: Observable<string | null> = { get: () => null, set: () => undefined, subscribe: () => () => undefined };

// ---------------------------------------------------------------------------
// Building blocks. The bar is a row of *segments* (bordered pill groups of
// buttons that share edges) separated by hairline dividers; each button is an
// icon with an optional text label. Active state = selection fill + inset
// accent ring, and `aria-pressed` for toggles, so it never rides on hue alone.
// Every button's hover tooltip carries its description and keycaps — there is
// no separate cheat-sheet line; the `keyboard` button at the right end holds
// the shortcuts that don't belong to any one button (camera, selection).
// ---------------------------------------------------------------------------

const MUTED = "#8b949e";
const EMPHASIS = "#e6edf3";
const SEG_BORDER = "#30363d";

const segmentStyle: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "stretch",
  border: `1px solid ${SEG_BORDER}`,
  borderRadius: 4,
  overflow: "hidden",
  background: "#21262d",
  flexShrink: 0,
};

const dividerStyle: React.CSSProperties = {
  width: 1,
  height: 18,
  background: "#21262d",
  margin: "0 8px",
  flexShrink: 0,
};

const labelStyle: React.CSSProperties = { color: MUTED, fontSize: 11, whiteSpace: "nowrap" };

/** Compact select that sits flush inside the bar (same chrome as a button). */
const selectStyle: React.CSSProperties = {
  ...buttonStyle,
  padding: "3px 6px",
  height: 24,
  borderRadius: 4,
};

function Divider() {
  return <span aria-hidden="true" style={dividerStyle} />;
}

function Segment(props: { children: React.ReactNode; role?: string; label?: string }) {
  return (
    <span style={segmentStyle} role={props.role} aria-label={props.label}>
      {props.children}
    </span>
  );
}

/** One shortcut line inside a tooltip: keycaps, then what they do. */
function ShortcutRow(props: { keys: string[]; children: React.ReactNode }) {
  return (
    <span style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 4 }}>
      <span style={{ display: "inline-flex", gap: 3, flexShrink: 0 }}>
        {props.keys.map((k) => (
          <Kbd key={k}>{k}</Kbd>
        ))}
      </span>
      <span style={{ color: MUTED }}>{props.children}</span>
    </span>
  );
}

/** Tooltip body: a title, optional detail sentence, and keycap rows. */
function Tip(props: { title: string; detail?: string; shortcuts?: Array<{ keys: string[]; does: string }> }) {
  return (
    <>
      <span style={{ color: EMPHASIS, display: "block" }}>{props.title}</span>
      {props.detail && <span style={{ display: "block", marginTop: 2 }}>{props.detail}</span>}
      {props.shortcuts?.map((s) => (
        <ShortcutRow key={s.keys.join("+")} keys={s.keys}>
          {s.does}
        </ShortcutRow>
      ))}
    </>
  );
}

function ToolButton(props: {
  icon: IconName;
  /** Visible text; omit for icon-only (then `tip` doubles as the accessible name). */
  label?: string;
  /** Tooltip title — also the accessible name for icon-only buttons. */
  tip: string;
  /** Extra sentence under the tooltip title. */
  detail?: string;
  /** The button's own hotkey(s), shown as keycaps and exposed via `aria-keyshortcuts`. */
  keys?: string[];
  /** Additional shortcut rows (things you can do while this tool is active). */
  shortcuts?: Array<{ keys: string[]; does: string }>;
  /** Toggle semantics: rendered pressed + `aria-pressed`. Omit for plain actions. */
  active?: boolean;
  disabled?: boolean;
  onClick: () => void;
}) {
  const pressed = props.active === true;
  const rows = [...(props.keys ? [{ keys: props.keys, does: props.label ?? props.tip }] : []), ...(props.shortcuts ?? [])];
  return (
    <Tooltip width={rows.length > 4 ? 440 : 320} content={<Tip title={props.tip} detail={props.detail} shortcuts={rows} />}>
      <button
        type="button"
        aria-label={props.label ? undefined : props.tip}
        aria-keyshortcuts={props.keys?.join(" ")}
        aria-pressed={props.active === undefined ? undefined : pressed}
        disabled={props.disabled}
        onClick={props.onClick}
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 5,
          height: 24,
          padding: props.label ? "0 8px 0 7px" : "0 6px",
          background: pressed ? "#1f3a5f" : "transparent",
          boxShadow: pressed ? "inset 0 0 0 1px #79c0ff" : "none",
          border: "none",
          borderLeft: `1px solid ${SEG_BORDER}`,
          marginLeft: -1,
          color: props.disabled ? "#484f58" : pressed ? EMPHASIS : "#c9d1d9",
          cursor: props.disabled ? "default" : "pointer",
          font: "12px ui-monospace, monospace",
          whiteSpace: "nowrap",
          opacity: props.disabled ? 0.7 : 1,
        }}
      >
        <Icon name={props.icon} />
        {props.label && <span>{props.label}</span>}
      </button>
    </Tooltip>
  );
}

/** Contextual settings for whichever tool is active — a quiet well attached to the tool segment. */
function OptionsWell(props: { children: React.ReactNode }) {
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        height: 24,
        padding: "0 8px",
        marginLeft: 6,
        background: "#161b22",
        border: "1px solid #21262d",
        borderRadius: 4,
        flexShrink: 0,
      }}
    >
      {props.children}
    </span>
  );
}

function Check(props: { checked: boolean; onChange: (v: boolean) => void; title?: string; label: string }) {
  return (
    <label style={{ display: "flex", gap: 4, alignItems: "center", cursor: "pointer", whiteSpace: "nowrap" }} title={props.title}>
      <input type="checkbox" checked={props.checked} onChange={(e) => props.onChange(e.target.checked)} style={{ margin: 0 }} />
      {props.label}
    </label>
  );
}

/** Shortcuts owned by the viewport rather than any toolbar button. */
const GLOBAL_SHORTCUTS: Array<{ keys: string[]; does: string }> = [
  { keys: ["~"], does: "play · pause (hides the editor while playing)" },
  { keys: ["LMB", "W A S D"], does: "hold to fly the camera · Q/E down/up · Shift boosts" },
  { keys: ["F"], does: "frame the selection" },
  { keys: ["V"], does: "gizmos on/off (collider · light · skeleton overlays)" },
  { keys: ["H"], does: "stats HUD on/off" },
  { keys: ["Del"], does: "delete selection" },
  { keys: ["Ctrl", "D"], does: "duplicate selection" },
  { keys: ["Ctrl"], does: "held while dragging: inverts snap" },
  { keys: ["Alt"], does: "held while scaling: anchor the floor" },
  { keys: ["dbl-click"], does: "prefab instance → open it for editing" },
];

// ---------------------------------------------------------------------------

export function Toolbar(props: {
  store: SceneStore;
  assets: AssetLibrary;
  registry: ComponentRegistry;
  thumbnails: Observable<Record<string, string>>;
  assetsVersion: Observable<number>;
  playMode: Observable<PlayMode>;
  gizmoMode: Observable<GizmoMode>;
  settings: Observable<EditorSettings>;
  grayboxActive: Observable<boolean>;
  grayboxShape: Observable<GrayboxShape>;
  grayboxBevel: Observable<number>;
  grayboxMaterial: Observable<string>;
  /** Drawn shapes commit as editable poly meshes (off = legacy sized primitives). */
  grayboxEditable?: Observable<boolean>;
  /** Mesh-edit mode state (element mode buttons live here too). */
  meshEdit?: MeshEditState;
  terrainActive: Observable<boolean>;
  terrainBrush: Observable<TerrainBrushSettings>;
  pathActive: Observable<boolean>;
  pathCrossSection: Observable<PathCrossSection>;
  pathWidth: Observable<number>;
  pathThickness: Observable<number>;
  pathRadius: Observable<number>;
  scenes?: Observable<string[]>;
  onSwitchScene?: (name: string) => void;
  onNewScene?: (name: string) => void;
  onEnvironment?: () => void;
  /** Open the frame profiler window (host-provided; see profiler-window.ts). */
  onProfiler?: () => void;
  tools?: Observable<ToolDefinition[]>;
  runTool?: (id: string, inputs: Record<string, unknown>) => Promise<ToolResult>;
  /** While isolation-editing a prefab the scene switcher is hidden (switching mid-edit is incoherent). */
  editingPrefab?: string | null;
  /** While isolation-editing a chunk cell the scene switcher is hidden too. */
  editingChunk?: { world: string; cx: number; cz: number } | null;
}) {
  const doc = useStoreDoc(props.store);
  const scenes = useObservable(props.scenes ?? emptyScenesObservable);
  const play = useObservable(props.playMode);
  const mode = useObservable(props.gizmoMode);
  const settings = useObservable(props.settings);
  const grayboxOn = useObservable(props.grayboxActive);
  const shape = useObservable(props.grayboxShape);
  const bevel = useObservable(props.grayboxBevel);
  const grayboxMaterial = useObservable(props.grayboxMaterial);
  const grayboxEditable = useObservable(props.grayboxEditable ?? trueObservable);
  const meshEditActive = useObservable(props.meshEdit?.active ?? falseObservable);
  const meshEditMode = useObservable(props.meshEdit?.mode ?? objectModeObservable);
  const meshEditEntity = useObservable(props.meshEdit?.entityId ?? nullObservable);
  useObservable(props.assetsVersion); // re-render the material list as materials are created
  const materials = props.assets.dataAssetsOfType("material");
  const terrainOn = useObservable(props.terrainActive);
  const terrain = useObservable(props.terrainBrush);
  const pathOn = useObservable(props.pathActive);
  const pathCrossSection = useObservable(props.pathCrossSection);
  const pathWidth = useObservable(props.pathWidth);
  const pathThickness = useObservable(props.pathThickness);
  const pathRadius = useObservable(props.pathRadius);
  const registeredTools = useObservable(props.tools ?? emptyToolsObservable).filter((tool) =>
    tool.surfaces.includes("tools"),
  );
  const [toolMenuOpen, setToolMenuOpen] = useState(false);
  const [toolMenuPosition, setToolMenuPosition] = useState({ left: 0, top: 0 });
  const toolMenuAnchor = useRef<HTMLSpanElement>(null);
  const [activeTool, setActiveTool] = useState<ToolDefinition | null>(null);
  const set = (patch: Partial<EditorSettings>) => props.settings.set({ ...settings, ...patch });

  const gizmos: Array<{ key: GizmoMode; icon: IconName; tip: string; keys: string[]; shortcuts?: Array<{ keys: string[]; does: string }> }> = [
    { key: "translate", icon: "move", tip: "move", keys: ["W"] },
    { key: "rotate", icon: "rotate", tip: "rotate", keys: ["E"] },
    { key: "scale", icon: "scale", tip: "scale", keys: ["R"], shortcuts: [{ keys: ["Alt"], does: "while dragging: anchor the floor" }] },
  ];

  const elementModes: Array<{ key: ElementMode; icon: IconName; label: string }> = [
    { key: "object", icon: "object", label: "obj" },
    { key: "vertex", icon: "vertex", label: "vert" },
    { key: "edge", icon: "edge", label: "edge" },
    { key: "face", icon: "face", label: "face" },
  ];

  return (
    <>
    <div style={{ padding: "6px 10px", display: "flex", alignItems: "center", height: "100%", boxSizing: "border-box" }}>
      <div style={{ display: "flex", alignItems: "center", flexWrap: "nowrap", overflowX: "auto", flex: 1, minHeight: 26 }}>
        {/* ---- scene ---- */}
        <strong style={{ color: EMPHASIS, marginRight: 8, flexShrink: 0 }}>HitReg</strong>
        {props.editingPrefab && (
          <span style={{ color: "#79c0ff", whiteSpace: "nowrap" }} title="Prefab isolation mode — close it from the viewport banner">
            ◆ prefab
          </span>
        )}
        {props.editingChunk && (
          <span style={{ color: "#d29922", whiteSpace: "nowrap" }} title="Chunk-cell isolation mode — close it from the viewport banner">
            ▤ {props.editingChunk.world} {props.editingChunk.cx}_{props.editingChunk.cz}
          </span>
        )}
        {props.scenes && !props.editingPrefab && !props.editingChunk && (
          <span style={{ display: "inline-flex", gap: 4, alignItems: "center" }}>
            <select
              style={{ ...selectStyle, maxWidth: 140 }}
              title="Scene (saved automatically on switch)"
              aria-label="scene"
              value={doc.name}
              onChange={(e) => props.onSwitchScene?.(e.target.value)}
            >
              {[...new Set([doc.name, ...scenes])].map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </select>
            <Segment>
              <ToolButton
                icon="plus"
                tip="new scene"
                onClick={() => {
                  const name = window.prompt("New scene name:");
                  if (name) props.onNewScene?.(name);
                }}
              />
            </Segment>
          </span>
        )}

        <Divider />

        {/* ---- playback ---- */}
        <Segment label="playback">
          <ToolButton
            icon="play"
            tip="play"
            detail="Runs the scene over runtime state; the doc is untouched. The editor hides while playing."
            keys={["~"]}
            active={play === "playing"}
            disabled={play === "playing"}
            onClick={() => props.playMode.set("playing")}
          />
          <ToolButton
            icon="pause"
            tip="pause"
            keys={["~"]}
            active={play === "paused"}
            disabled={play !== "playing"}
            onClick={() => props.playMode.set("paused")}
          />
          <ToolButton icon="stop" tip="stop" detail="Back to edit mode; runtime state is discarded." disabled={play === "edit"} onClick={() => props.playMode.set("edit")} />
        </Segment>

        <Divider />

        {/* ---- transform gizmo ---- */}
        <Segment role="radiogroup" label="gizmo">
          {gizmos.map((g) => (
            <ToolButton key={g.key} icon={g.icon} tip={g.tip} keys={g.keys} shortcuts={g.shortcuts} active={mode === g.key} onClick={() => props.gizmoMode.set(g.key)} />
          ))}
        </Segment>

        <Divider />

        {/* ---- tools: one segment, options for the active one in a well beside it ---- */}
        <Segment label="tools">
          <ToolButton
            icon="terrain"
            label="terrain"
            tip="terrain sculpt"
            detail="Select a heightmap terrain, then drag on it. Brush mode, radius and strength appear beside the tool."
            active={terrainOn}
            onClick={() => props.terrainActive.set(!terrainOn)}
          />
          <ToolButton
            icon="draw"
            label="draw"
            tip="shape draw"
            detail="Drag a footprint, pull the height, click to place. Drag a face of an editable shape to push/pull it."
            keys={["G"]}
            shortcuts={[
              { keys: ["Alt", "drag"], does: "extrude a block from a face" },
              { keys: ["Ctrl"], does: "invert snap while dragging" },
              { keys: ["Enter"], does: "close a poly outline" },
              { keys: ["Esc"], does: "cancel the shape in progress" },
            ]}
            active={grayboxOn}
            onClick={() => props.grayboxActive.set(!grayboxOn)}
          />
          {props.meshEdit && (
            <ToolButton
              icon="mesh"
              label="mesh"
              tip="mesh edit"
              detail={
                meshEditEntity || !meshEditActive
                  ? "Vertex / edge / face editing of the selected editable mesh."
                  : "On, but the selection has no editable mesh — draw one, or use 'make editable mesh' in the inspector."
              }
              shortcuts={[
                { keys: ["1", "2", "3", "4"], does: "object · vertex · edge · face mode" },
                { keys: ["Shift"], does: "click adds to selection · Ctrl toggles" },
                { keys: ["Ctrl", "A"], does: "select all · Ctrl+I invert" },
                { keys: ["Alt", "E"], does: "extrude · Alt+B bevel · Alt+I inset · Alt+S subdivide" },
                { keys: ["Alt", "L"], does: "loop · Alt+R ring · Alt+G grow (Shift shrinks)" },
                { keys: ["Alt", "M"], does: "merge · Alt+W weld · Alt+F fill · Alt+C connect · Alt+U insert loop" },
                { keys: ["Del"], does: "delete elements" },
                { keys: ["Esc"], does: "clear selection, then back to object mode" },
              ]}
              active={meshEditActive}
              onClick={() => {
                const next = !meshEditActive;
                if (next && props.meshEdit!.mode.get() === "object") props.meshEdit!.mode.set("face");
                props.meshEdit!.active.set(next);
              }}
            />
          )}
          <ToolButton
            icon="path"
            label="path"
            tip="path draw"
            detail="Click to drop curve points; they follow the terrain under the cursor."
            keys={["P"]}
            shortcuts={[
              { keys: ["Enter"], does: "finish (or click near the first point)" },
              { keys: ["Esc"], does: "cancel the path in progress" },
            ]}
            active={pathOn}
            onClick={() => props.pathActive.set(!pathOn)}
          />
        </Segment>

        {registeredTools.length > 0 && props.runTool && (
          <span ref={toolMenuAnchor} style={{ position: "relative", display: "inline-flex", marginLeft: 6 }}>
            <Segment label="registered tools">
              <ToolButton
                icon="plus"
                label="more"
                tip="registered tools"
                detail="Tools contributed by the engine and installed plugins."
                onClick={() => {
                  const next = !toolMenuOpen;
                  if (next) {
                    const rect = toolMenuAnchor.current?.getBoundingClientRect();
                    if (rect) {
                      setToolMenuPosition({
                        left: Math.max(4, Math.min(rect.left, window.innerWidth - 244)),
                        top: rect.bottom + 4,
                      });
                    }
                  }
                  setToolMenuOpen(next);
                }}
              />
            </Segment>
            {toolMenuOpen && (
              <div
                role="menu"
                style={{
                  position: "fixed",
                  left: toolMenuPosition.left,
                  top: toolMenuPosition.top,
                  zIndex: 1200,
                  minWidth: 240,
                  padding: 4,
                  background: "#161b22",
                  border: "1px solid #30363d",
                }}
              >
                {registeredTools.map((tool) => (
                  <button
                    key={tool.id}
                    role="menuitem"
                    title={tool.description}
                    style={{
                      width: "100%",
                      padding: "5px 7px",
                      background: "transparent",
                      border: 0,
                      color: "#c9d1d9",
                      textAlign: "left",
                      cursor: "pointer",
                      font: "11px ui-monospace, monospace",
                    }}
                    onClick={() => {
                      setActiveTool(tool);
                      setToolMenuOpen(false);
                    }}
                  >
                    <span style={{ display: "block", color: EMPHASIS }}>{tool.name}</span>
                    <span style={{ display: "block", color: MUTED, fontSize: 10, marginTop: 2 }}>{tool.category}</span>
                  </button>
                ))}
              </div>
            )}
          </span>
        )}

        {terrainOn && (
          <OptionsWell>
            <select
              style={selectStyle}
              aria-label="brush mode"
              value={terrain.mode}
              onChange={(e) => props.terrainBrush.set({ ...terrain, mode: e.target.value as TerrainBrushSettings["mode"] })}
            >
              {(["raise", "lower", "flatten", "smooth"] as const).map((m) => <option key={m}>{m}</option>)}
            </select>
            <span style={labelStyle}>radius</span>
            <span style={{ width: 42 }}>
              <NumberField value={terrain.radius} onCommit={(radius) => radius > 0 && props.terrainBrush.set({ ...terrain, radius })} />
            </span>
            <span style={labelStyle}>strength</span>
            <span style={{ width: 42 }}>
              <NumberField value={terrain.strength} onCommit={(strength) => strength > 0 && props.terrainBrush.set({ ...terrain, strength })} />
            </span>
          </OptionsWell>
        )}

        {grayboxOn && (
          <OptionsWell>
            <select style={selectStyle} aria-label="shape" value={shape} onChange={(e) => props.grayboxShape.set(e.target.value as GrayboxShape)}>
              {GRAYBOX_SHAPES.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
            <select
              style={{ ...selectStyle, maxWidth: 120 }}
              aria-label="material"
              title="Material painted onto newly-drawn shapes (drag a material onto a shape, or use the Assets panel's 'apply to selection', to repaint existing ones)"
              value={materials.some((m) => m.id === grayboxMaterial) ? grayboxMaterial : ""}
              onChange={(e) => props.grayboxMaterial.set(e.target.value)}
            >
              <option value="">default mat</option>
              {materials.map((mat) => (
                <option key={mat.id} value={mat.id}>
                  {mat.name.split("/").pop()}
                </option>
              ))}
            </select>
            {props.grayboxEditable && (
              <Check
                checked={grayboxEditable}
                onChange={(v) => props.grayboxEditable!.set(v)}
                label="editable"
                title="Draw editable poly meshes (vertex/edge/face editing, UVs, per-face materials). Off = legacy sized primitives for box/cylinder/sphere/wedge."
              />
            )}
            {!grayboxEditable && (
              <>
                <span style={labelStyle}>bevel</span>
                <span style={{ width: 44 }} title="0 = off; boxes/polys extrude with rounded edges">
                  <NumberField value={bevel} onCommit={(v) => v >= 0 && props.grayboxBevel.set(v)} />
                </span>
              </>
            )}
          </OptionsWell>
        )}

        {props.meshEdit && meshEditActive && (
          <OptionsWell>
            <Segment role="radiogroup" label="element mode">
              {elementModes.map((m, i) => (
                <ToolButton
                  key={m.key}
                  icon={m.icon}
                  label={m.label}
                  tip={`${m.key} mode`}
                  keys={[String(i + 1)]}
                  active={meshEditMode === m.key}
                  onClick={() => {
                    props.meshEdit!.mode.set(m.key);
                    if (m.key !== "object") props.meshEdit!.active.set(true);
                  }}
                />
              ))}
            </Segment>
          </OptionsWell>
        )}

        {pathOn && (
          <OptionsWell>
            <select
              style={selectStyle}
              aria-label="cross-section"
              value={pathCrossSection}
              onChange={(e) => props.pathCrossSection.set(e.target.value as PathCrossSection)}
            >
              <option value="ribbon">road</option>
              <option value="tube">vine</option>
            </select>
            {pathCrossSection === "ribbon" ? (
              <>
                <span style={labelStyle}>width</span>
                <span style={{ width: 42 }}>
                  <NumberField value={pathWidth} onCommit={(v) => v > 0 && props.pathWidth.set(v)} />
                </span>
                <span style={labelStyle} title="0 = flat sheet; >0 raises a slab this thick on top of the drawn curve">
                  thick
                </span>
                <span style={{ width: 42 }}>
                  <NumberField
                    value={pathThickness}
                    onCommit={(v) => v >= 0 && props.pathThickness.set(v)}
                  />
                </span>
              </>
            ) : (
              <>
                <span style={labelStyle}>radius</span>
                <span style={{ width: 42 }}>
                  <NumberField value={pathRadius} onCommit={(v) => v > 0 && props.pathRadius.set(v)} />
                </span>
              </>
            )}
          </OptionsWell>
        )}

        <Divider />

        {/* ---- view / helpers ---- */}
        <Segment label="view">
          <ToolButton
            icon="snap"
            tip="snap to grid"
            detail="Translate snaps to the step shown beside the toggle."
            shortcuts={[{ keys: ["Ctrl"], does: "held while dragging: inverts snap" }]}
            active={settings.snap}
            onClick={() => set({ snap: !settings.snap })}
          />
          <ToolButton icon="grid" tip="ground grid" active={settings.grid} onClick={() => set({ grid: !settings.grid })} />
          <ToolButton
            icon="settle"
            tip="placement assist"
            detail="Entities with a placement component settle onto the surface they declare (ground / ceiling / wall) after a move, duplicate, or drop — with their authored sink and jitter. Entities without the component never move on their own."
            active={settings.placementAssist}
            onClick={() => set({ placementAssist: !settings.placementAssist })}
          />
          <ToolButton
            icon="gizmos"
            tip="gizmos"
            detail="Master switch for every viewport overlay (physics, skeleton, light gizmos). Off hides them all without losing which ones you had on."
            keys={["V"]}
            active={settings.showGizmos}
            onClick={() => set({ showGizmos: !settings.showGizmos })}
          />
          <ToolButton
            icon="physics"
            tip="physics gizmos"
            detail="Collider wireframes + joint anchors/axes. Green = static, orange = dynamic, blue = kinematic, yellow = trigger."
            active={settings.showPhysics}
            disabled={!settings.showGizmos}
            onClick={() => set({ showPhysics: !settings.showPhysics })}
          />
          <ToolButton
            icon="bones"
            tip="skeletons"
            detail="Bone lines + bone-name labels on skinned models."
            active={settings.showSkeletons}
            disabled={!settings.showGizmos}
            onClick={() => set({ showSkeletons: !settings.showSkeletons })}
          />
          <ToolButton
            icon="lights"
            tip="light gizmos"
            detail="Direction arrows on directional/spot lights."
            active={settings.showLights}
            disabled={!settings.showGizmos}
            onClick={() => set({ showLights: !settings.showLights })}
          />
          <ToolButton
            icon="stats"
            tip="stats HUD"
            detail="Perf/stats readout in the viewport's top-right corner."
            keys={["H"]}
            active={settings.showStats}
            onClick={() => set({ showStats: !settings.showStats })}
          />
        </Segment>
        {settings.snap && (
          <span style={{ display: "inline-flex", alignItems: "center", gap: 4, marginLeft: 6 }} title="translate snap step">
            <span style={{ width: 46 }}>
              <NumberField value={settings.translateSnap} onCommit={(v) => v > 0 && set({ translateSnap: v })} />
            </span>
          </span>
        )}

        {/* ---- right: scene-level + history + help ---- */}
        <span style={{ flex: 1, minWidth: 8 }} />
        <Segment>
          <ToolButton icon="sun" label="env" tip="environment / lighting" detail="Edit the scene's sky, fog, and fill light." onClick={() => props.onEnvironment?.()} />
          {props.onProfiler && (
            <ToolButton
              icon="profiler"
              label="profiler"
              tip="frame profiler"
              detail="Opens in its own window — per-system breakdown, spikes, and what caused them. Works in play mode too."
              keys={["Shift", "P"]}
              onClick={props.onProfiler}
            />
          )}
        </Segment>
        <span style={{ width: 6 }} />
        <Segment label="history">
          <ToolButton icon="undo" tip="undo" keys={["Ctrl", "Z"]} disabled={!props.store.canUndo} onClick={() => props.store.undo()} />
          <ToolButton icon="redo" tip="redo" keys={["Ctrl", "Y"]} disabled={!props.store.canRedo} onClick={() => props.store.redo()} />
        </Segment>
        <span style={{ width: 6 }} />
        <Segment>
          <Tooltip width={440} content={<Tip title="viewport shortcuts" shortcuts={GLOBAL_SHORTCUTS} />}>
            <span
              tabIndex={0}
              aria-label="viewport shortcuts"
              style={{
                display: "inline-flex",
                alignItems: "center",
                height: 24,
                padding: "0 6px",
                color: MUTED,
                cursor: "help",
              }}
            >
              <Icon name="keyboard" />
            </span>
          </Tooltip>
        </Segment>
      </div>
    </div>
    {activeTool && props.runTool && (
      <ToolDialog
        key={activeTool.id}
        tool={activeTool}
        assets={props.assets}
        registry={props.registry}
        thumbnails={props.thumbnails.get()}
        onClose={() => setActiveTool(null)}
        onRun={props.runTool}
      />
    )}
    </>
  );
}

import type { AssetLibrary, SceneStore } from "@hitreg/core";
import type {
  EditorSettings,
  GizmoMode,
  GrayboxShape,
  Observable,
  PlayMode,
  TerrainBrushSettings,
} from "../state.js";
import type { PathCrossSection } from "../path-tool.js";
import { NumberField } from "./fields.js";
import { activeButtonStyle, buttonStyle, useObservable, useStoreDoc } from "./common.js";

const EMPTY_SCENES: string[] = [];
const emptyScenesObservable: Observable<string[]> = {
  get: () => EMPTY_SCENES,
  set: () => undefined,
  subscribe: () => () => undefined,
};

export function Toolbar(props: {
  store: SceneStore;
  assets: AssetLibrary;
  assetsVersion: Observable<number>;
  playMode: Observable<PlayMode>;
  gizmoMode: Observable<GizmoMode>;
  settings: Observable<EditorSettings>;
  grayboxActive: Observable<boolean>;
  grayboxShape: Observable<GrayboxShape>;
  grayboxBevel: Observable<number>;
  grayboxMaterial: Observable<string>;
  terrainActive: Observable<boolean>;
  terrainBrush: Observable<TerrainBrushSettings>;
  pathActive: Observable<boolean>;
  pathCrossSection: Observable<PathCrossSection>;
  pathWidth: Observable<number>;
  pathRadius: Observable<number>;
  scenes?: Observable<string[]>;
  onSwitchScene?: (name: string) => void;
  onNewScene?: (name: string) => void;
  onEnvironment?: () => void;
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
  useObservable(props.assetsVersion); // re-render the material list as materials are created
  const materials = props.assets.dataAssetsOfType("material");
  const terrainOn = useObservable(props.terrainActive);
  const terrain = useObservable(props.terrainBrush);
  const pathOn = useObservable(props.pathActive);
  const pathCrossSection = useObservable(props.pathCrossSection);
  const pathWidth = useObservable(props.pathWidth);
  const pathRadius = useObservable(props.pathRadius);
  const set = (patch: Partial<EditorSettings>) => props.settings.set({ ...settings, ...patch });

  const group: React.CSSProperties = {
    display: "flex",
    gap: 5,
    alignItems: "center",
    paddingRight: 10,
    marginRight: 10,
    borderRight: "1px solid #21262d",
  };

  const modes: Array<{ key: GizmoMode; label: string }> = [
    { key: "translate", label: "move" },
    { key: "rotate", label: "rotate" },
    { key: "scale", label: "scale" },
  ];

  return (
    <div style={{ padding: "6px 10px", display: "flex", flexDirection: "column", gap: 3, height: "100%" }}>
      <div style={{ display: "flex", alignItems: "center", flexWrap: "nowrap", overflowX: "auto" }}>
        <span style={group}>
          <strong style={{ color: "#e6edf3", marginRight: 4 }}>HitReg</strong>
          {props.editingPrefab && (
            <span style={{ color: "#79c0ff" }} title="Prefab isolation mode — close it from the viewport banner">
              ◆ prefab
            </span>
          )}
          {props.editingChunk && (
            <span style={{ color: "#d29922" }} title="Chunk-cell isolation mode — close it from the viewport banner">
              ▤ {props.editingChunk.world} {props.editingChunk.cx}_{props.editingChunk.cz}
            </span>
          )}
          {props.scenes && !props.editingPrefab && !props.editingChunk && (
            <>
              <select
                style={{ ...buttonStyle, padding: "4px 6px", maxWidth: 140 }}
                title="Scene (saved automatically on switch)"
                value={doc.name}
                onChange={(e) => props.onSwitchScene?.(e.target.value)}
              >
                {[...new Set([doc.name, ...scenes])].map((name) => (
                  <option key={name} value={name}>
                    {name}
                  </option>
                ))}
              </select>
              <button
                style={buttonStyle}
                title="Create a new scene"
                onClick={() => {
                  const name = window.prompt("New scene name:");
                  if (name) props.onNewScene?.(name);
                }}
              >
                +
              </button>
            </>
          )}
          <button
            style={play === "playing" ? activeButtonStyle : buttonStyle}
            disabled={play === "playing"}
            onClick={() => props.playMode.set("playing")}
          >
            ▶ play
          </button>
          <button
            style={play === "paused" ? activeButtonStyle : buttonStyle}
            disabled={play !== "playing"}
            onClick={() => props.playMode.set("paused")}
          >
            ⏸
          </button>
          <button style={buttonStyle} disabled={play === "edit"} onClick={() => props.playMode.set("edit")}>
            ⏹
          </button>
        </span>

        <span style={group}>
          <button
            style={terrainOn ? activeButtonStyle : buttonStyle}
            title="Terrain sculpt mode: drag on selected heightmap terrain"
            onClick={() => props.terrainActive.set(!terrainOn)}
          >
            terrain
          </button>
          <select
            style={{ ...buttonStyle, padding: "4px 6px" }}
            value={terrain.mode}
            onChange={(e) => props.terrainBrush.set({ ...terrain, mode: e.target.value as TerrainBrushSettings["mode"] })}
          >
            {(["raise", "lower", "flatten", "smooth"] as const).map((mode) => <option key={mode}>{mode}</option>)}
          </select>
          <span style={{ color: "#8b949e" }}>r</span>
          <span style={{ width: 42 }}><NumberField value={terrain.radius} onCommit={(radius) => radius > 0 && props.terrainBrush.set({ ...terrain, radius })} /></span>
          <span style={{ color: "#8b949e" }}>str</span>
          <span style={{ width: 42 }}><NumberField value={terrain.strength} onCommit={(strength) => strength > 0 && props.terrainBrush.set({ ...terrain, strength })} /></span>
        </span>

        <span style={group}>
          {modes.map((m) => (
            <button
              key={m.key}
              style={mode === m.key ? activeButtonStyle : buttonStyle}
              onClick={() => props.gizmoMode.set(m.key)}
            >
              {m.label}
            </button>
          ))}
        </span>

        <span style={group}>
          <label style={{ display: "flex", gap: 3, alignItems: "center", cursor: "pointer" }}>
            <input type="checkbox" checked={settings.snap} onChange={(e) => set({ snap: e.target.checked })} />
            snap
          </label>
          <span style={{ width: 46 }}>
            <NumberField value={settings.translateSnap} onCommit={(v) => v > 0 && set({ translateSnap: v })} />
          </span>
          <label style={{ display: "flex", gap: 3, alignItems: "center", cursor: "pointer" }}>
            <input type="checkbox" checked={settings.grid} onChange={(e) => set({ grid: e.target.checked })} />
            grid
          </label>
          <label
            style={{ display: "flex", gap: 3, alignItems: "center", cursor: "pointer" }}
            title="Collider wireframes + joint anchors/axes"
          >
            <input
              type="checkbox"
              checked={settings.showPhysics}
              onChange={(e) => set({ showPhysics: e.target.checked })}
            />
            phys
          </label>
          <label
            style={{ display: "flex", gap: 3, alignItems: "center", cursor: "pointer" }}
            title="Skeleton lines + bone-name labels on skinned models"
          >
            <input
              type="checkbox"
              checked={settings.showSkeletons}
              onChange={(e) => set({ showSkeletons: e.target.checked })}
            />
            bones
          </label>
          <label
            style={{ display: "flex", gap: 3, alignItems: "center", cursor: "pointer" }}
            title="Direction arrows on directional/spot lights"
          >
            <input
              type="checkbox"
              checked={settings.showLights}
              onChange={(e) => set({ showLights: e.target.checked })}
            />
            lights
          </label>
          <label
            style={{ display: "flex", gap: 3, alignItems: "center", cursor: "pointer" }}
            title="Perf/stats HUD in the viewport's top-right corner (H toggles it)"
          >
            <input
              type="checkbox"
              checked={settings.showStats}
              onChange={(e) => set({ showStats: e.target.checked })}
            />
            stats
          </label>
        </span>

        <span style={group}>
          <button
            style={grayboxOn ? activeButtonStyle : buttonStyle}
            title="Graybox draw mode — drag footprint, pull height, click to place. Alt+drag box face = extrude. Ctrl inverts snap."
            onClick={() => props.grayboxActive.set(!grayboxOn)}
          >
            ✏ draw (G)
          </button>
          <select
            style={{ ...buttonStyle, padding: "4px 6px" }}
            value={shape}
            onChange={(e) => props.grayboxShape.set(e.target.value as GrayboxShape)}
          >
            {(["box", "cylinder", "sphere", "wedge", "poly"] as GrayboxShape[]).map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
          <span style={{ color: "#8b949e" }}>bevel</span>
          <span style={{ width: 44 }} title="0 = off; boxes/polys extrude with rounded edges">
            <NumberField value={bevel} onCommit={(v) => v >= 0 && props.grayboxBevel.set(v)} />
          </span>
          <select
            style={{ ...buttonStyle, padding: "4px 6px", maxWidth: 120 }}
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
        </span>

        <span style={group}>
          <button
            style={pathOn ? activeButtonStyle : buttonStyle}
            title="Path draw mode: click to drop curve points (follows terrain under the cursor), click near the first point (or Enter) to finish"
            onClick={() => props.pathActive.set(!pathOn)}
          >
            〜 path (P)
          </button>
          <select
            style={{ ...buttonStyle, padding: "4px 6px" }}
            value={pathCrossSection}
            onChange={(e) => props.pathCrossSection.set(e.target.value as PathCrossSection)}
          >
            <option value="ribbon">road</option>
            <option value="tube">vine</option>
          </select>
          {pathCrossSection === "ribbon" ? (
            <>
              <span style={{ color: "#8b949e" }}>width</span>
              <span style={{ width: 42 }}>
                <NumberField value={pathWidth} onCommit={(v) => v > 0 && props.pathWidth.set(v)} />
              </span>
            </>
          ) : (
            <>
              <span style={{ color: "#8b949e" }}>radius</span>
              <span style={{ width: 42 }}>
                <NumberField value={pathRadius} onCommit={(v) => v > 0 && props.pathRadius.set(v)} />
              </span>
            </>
          )}
        </span>

        <span style={{ ...group, borderRight: "none" }}>
          <button
            style={buttonStyle}
            title="Environment / lighting: edit the scene's sky, fog, and fill light"
            onClick={props.onEnvironment}
          >
            ☀ env
          </button>
          <button style={buttonStyle} disabled={!props.store.canUndo} onClick={() => props.store.undo()}>
            ⟲ undo
          </button>
          <button style={buttonStyle} disabled={!props.store.canRedo} onClick={() => props.store.redo()}>
            ⟳ redo
          </button>
        </span>
      </div>
      <div style={{ color: "#8b949e", fontSize: 10 }}>
        ~ close editor · hold LMB+WASD fly (QE up/down, Shift boost) · W/E/R gizmo · F frame · G draw · P path ·
        H stats · Alt+scale anchors floor · Del · Ctrl+D dup · Ctrl+Z/Y · Ctrl inverts snap · dbl-click prefab opens
      </div>
    </div>
  );
}

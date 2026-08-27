/** Tiny observable primitives shared between the React overlay and viewport tools. */

export interface Observable<T> {
  get(): T;
  set(value: T): void;
  subscribe(listener: () => void): () => void;
}

export function observable<T>(initial: T): Observable<T> {
  let current = initial;
  const listeners = new Set<() => void>();
  return {
    get: () => current,
    set(value: T) {
      if (value === current) return;
      current = value;
      for (const listener of listeners) listener();
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

/** The selected SOURCE-doc entity id (prefab instances select as one unit). */
export type Selection = Observable<string | null>;
export const createSelection = (): Selection => observable<string | null>(null);

/**
 * The full multi-selected set (superset of `Selection`, which always holds
 * the "active"/last-clicked member — used as the group transform pivot and
 * as the single-entity view the Inspector shows). Kept as a sibling
 * observable rather than folding `Selection` into an array so every existing
 * single-entity consumer (Inspector, prefab/material "apply to selection",
 * etc.) keeps working unmodified.
 */
export type MultiSelection = Observable<string[]>;
export const createMultiSelection = (): MultiSelection => observable<string[]>([]);

/** Plain click: replace the whole selection with one id, or clear it (null). */
export function selectSingle(
  selection: Selection,
  multi: MultiSelection,
  id: string | null,
): void {
  selection.set(id);
  multi.set(id ? [id] : []);
}

/** Ctrl/Cmd-click: toggle one id in/out of the selection; it becomes active when added. */
export function toggleSelection(selection: Selection, multi: MultiSelection, id: string): void {
  const current = multi.get();
  if (current.includes(id)) {
    const next = current.filter((existing) => existing !== id);
    multi.set(next);
    if (selection.get() === id) selection.set(next[next.length - 1] ?? null);
  } else {
    multi.set([...current, id]);
    selection.set(id);
  }
}

/**
 * Shift-click: extend the selection from the current active id through `id`,
 * inclusive, along `orderedIds` (the visible/rendered order). Falls back to
 * a plain single-select if either endpoint isn't in `orderedIds`.
 */
export function rangeSelectTo(
  selection: Selection,
  multi: MultiSelection,
  orderedIds: string[],
  id: string,
): void {
  const anchor = selection.get();
  const anchorIndex = anchor ? orderedIds.indexOf(anchor) : -1;
  const targetIndex = orderedIds.indexOf(id);
  if (anchorIndex === -1 || targetIndex === -1) {
    selectSingle(selection, multi, id);
    return;
  }
  const [lo, hi] = anchorIndex < targetIndex ? [anchorIndex, targetIndex] : [targetIndex, anchorIndex];
  const range = orderedIds.slice(lo, hi + 1);
  multi.set([...new Set([...multi.get(), ...range])]);
  selection.set(id);
}

export type GizmoMode = "translate" | "rotate" | "scale";

/**
 * Where the cursor is pointing in the world: the entity under it (if any) plus
 * the actual surface hit. The point matters as much as the id — "put a bench
 * *here*" and "what is this?" are different questions about the same gesture,
 * and an agent that only receives an entity id can answer the second but not
 * the first.
 */
export interface FocusHit {
  /** SOURCE-doc entity id under the cursor, or null over empty space/sky. */
  id: string | null;
  /** World-space surface point, rounded for legibility. */
  point: [number, number, number] | null;
  /** World-space surface normal at the hit, if the hit had a face. */
  normal: [number, number, number] | null;
  /** Distance from the camera, in metres. */
  distance: number | null;
}

/**
 * What the cursor is over right now. Sampled at a low rate (see
 * `ViewportTools`), never per-frame — this feeds the AI focus channel and a
 * future highlight, neither of which needs frame-perfect fidelity.
 */
export type Hover = Observable<FocusHit | null>;
export const createHover = (): Hover => observable<FocusHit | null>(null);

/** What the user has hold of right now, while a gizmo drag is in flight. */
export interface Manipulation {
  ids: string[];
  mode: GizmoMode;
}

/**
 * Non-null only between gizmo drag-start and drag-end. This is the strongest
 * possible "the human means THIS one" signal — stronger than selection, which
 * can be stale from ten minutes ago — so it is worth publishing even though it
 * is true for only a second at a time.
 */
export type Manipulating = Observable<Manipulation | null>;
export const createManipulating = (): Manipulating => observable<Manipulation | null>(null);

/**
 * Shapes the draw tool can lay down. The first five are the historic graybox
 * primitives; the rest are ProBuilder-style parametric shapes. All of them
 * commit as EDITABLE poly meshes (`mesh.source.kind: "poly"`) unless the
 * "editable" toggle is off, in which case the first four fall back to the
 * old sized primitives.
 */
export type GrayboxShape =
  | "box"
  | "cylinder"
  | "sphere"
  | "wedge"
  | "poly"
  | "plane"
  | "cone"
  | "stairs"
  | "arch"
  | "torus"
  | "pipe"
  | "door";

export const GRAYBOX_SHAPES: GrayboxShape[] = [
  "box",
  "cylinder",
  "sphere",
  "wedge",
  "poly",
  "plane",
  "cone",
  "stairs",
  "arch",
  "torus",
  "pipe",
  "door",
];

/** Mesh-edit element mode (ProBuilder's object / vertex / edge / face toolbar). */
export type ElementMode = "object" | "vertex" | "edge" | "face";

/** Gizmo axes for element transforms: world axes, the entity's axes, or the selection's average normal. */
export type HandleOrientation = "global" | "local" | "normal";

/** Element-level selection inside the mesh being edited (indices into its PolyMesh). */
export interface ElementSelectionState {
  vertices: number[];
  edges: Array<[number, number]>;
  faces: number[];
}

export const emptyElementSelection = (): ElementSelectionState => ({ vertices: [], edges: [], faces: [] });

/**
 * Mesh-edit tool state, shared by the viewport tool, the element toolbar,
 * the inspector, and the AI context bridge (which publishes the element
 * selection so "bevel these edges" resolves to real indices).
 */
export interface MeshEditState {
  /** Mesh-edit mode on (vertex/edge/face handles visible, element gizmo active). */
  active: Observable<boolean>;
  mode: Observable<ElementMode>;
  orientation: Observable<HandleOrientation>;
  /** Allow picking elements hidden behind the mesh (ProBuilder "select hidden"). */
  selectHidden: Observable<boolean>;
  selection: Observable<ElementSelectionState>;
  /** Entity id whose mesh is being edited (null = none / the selected entity has no poly mesh). */
  entityId: Observable<string | null>;
  /** Default parameters for the parametric actions (extrude distance, bevel amount, ...). */
  params: Observable<MeshEditParams>;
  /** Live element counts of the edited mesh, for the panel readout. */
  stats: Observable<{ vertices: number; edges: number; faces: number } | null>;
  /** The UV editor window is open (edits the selected faces' UVs). */
  uvEditorOpen: Observable<boolean>;
  /** Tint every face by its smoothing group in the viewport (ProBuilder's smoothing preview). */
  showSmoothing: Observable<boolean>;
}

export interface MeshEditParams {
  extrudeDistance: number;
  extrudeMethod: "vertex-normal" | "face-normal" | "individual";
  insetAmount: number;
  bevelAmount: number;
  weldDistance: number;
  loopPosition: number;
  growAngle: number;
  growLimitAngle: boolean;
}

export const defaultMeshEditParams: MeshEditParams = {
  extrudeDistance: 0.5,
  extrudeMethod: "vertex-normal",
  insetAmount: 0.2,
  bevelAmount: 0.1,
  weldDistance: 0.01,
  loopPosition: 0.5,
  growAngle: 45,
  growLimitAngle: false,
};

/** What the element toolbar can ask the viewport tool to do (implemented by MeshEditTool). */
export interface MeshEditActions {
  run(action: string, overrides?: Record<string, unknown>): void;
  setMaterial(materialId: string): void;
  /** Faces in face mode, per-corner vertex paint in vertex/edge mode. */
  setColor(color: string | null): void;
  setVertexPosition(vertex: number, position: [number, number, number]): void;
  /** CSG between the active selection (A) and the other selected entity (B); A takes the result, B is removed. */
  boolean(op: "union" | "subtract" | "intersect"): void;
  /** Convert any entity's rendered geometry (glTF part, path, primitive, polygon) into an editable poly mesh. */
  makeEditable(entityId: string): void;
}

export function createMeshEditState(): MeshEditState {
  return {
    active: observable(false),
    mode: observable<ElementMode>("face"),
    orientation: observable<HandleOrientation>("global"),
    selectHidden: observable(false),
    selection: observable<ElementSelectionState>(emptyElementSelection()),
    entityId: observable<string | null>(null),
    params: observable<MeshEditParams>({ ...defaultMeshEditParams }),
    stats: observable<{ vertices: number; edges: number; faces: number } | null>(null),
    uvEditorOpen: observable(false),
    showSmoothing: observable(false),
  };
}

export type TerrainBrushMode = "raise" | "lower" | "flatten" | "smooth";
export interface TerrainBrushSettings { mode: TerrainBrushMode; radius: number; strength: number; }
export const defaultTerrainBrush: TerrainBrushSettings = { mode: "raise", radius: 5, strength: 0.35 };

/** Docked-layout panel sizes (px). Resizable via splitters, persisted. */
export interface DockSizes {
  top: number;
  left: number;
  right: number;
  bottom: number;
}

/** `top` is the single-row toolbar (6px pad + 24px controls + 6px pad + border); it has no splitter. */
export const defaultDockSizes: DockSizes = { top: 38, left: 300, right: 360, bottom: 240 };

export function createDockSizes(): Observable<DockSizes> {
  let initial = defaultDockSizes;
  try {
    const saved = localStorage.getItem("hitreg-editor-docks");
    // `top` is not user-resizable, so a persisted value is just a stale
    // default from an older toolbar layout — always take the current one.
    if (saved) initial = { ...defaultDockSizes, ...(JSON.parse(saved) as Partial<DockSizes>), top: defaultDockSizes.top };
  } catch {
    /* fresh defaults */
  }
  const sizes = observable(initial);
  sizes.subscribe(() => {
    try {
      localStorage.setItem("hitreg-editor-docks", JSON.stringify(sizes.get()));
    } catch {
      /* non-fatal */
    }
  });
  return sizes;
}

/** edit = authoring; playing/paused = simulation running over runtime state (doc untouched). */
export type PlayMode = "edit" | "playing" | "paused";

export interface EditorSettings {
  snap: boolean;
  translateSnap: number;
  rotateSnapDeg: number;
  scaleSnap: number;
  grid: boolean;
  gridSize: number;
  /** X-ray collider wireframes + joint anchors/axes in the viewport. */
  showPhysics: boolean;
  /** Skeleton lines + bone-name labels on skinned models in the viewport. */
  showSkeletons: boolean;
  /** Direction arrows on directional/spot lights in the viewport. */
  showLights: boolean;
  /** The perf/stats HUD in the viewport's top-right corner (H toggles it). */
  showStats: boolean;
}

/** Selected asset in the Assets panel (mutually exclusive with entity selection). */
export interface AssetSelectionState {
  kind: "material" | "prefab" | "model" | "texture" | "spritesheet";
  id: string;
}
export type AssetSelection = Observable<AssetSelectionState | null>;
export const createAssetSelection = (): AssetSelection =>
  observable<AssetSelectionState | null>(null);

/**
 * Prefab isolation editing (Unity-style): the prefab id whose definition is
 * open as the working doc in the viewport, or null when editing a scene.
 */
export type EditingPrefab = Observable<string | null>;
export const createEditingPrefab = (): EditingPrefab => observable<string | null>(null);

/** One chunk-grid cell, identified by its streamed world + cell coordinates. */
export interface EditingChunkCell {
  world: string;
  cx: number;
  cz: number;
}

/**
 * Chunk-cell isolation editing (same idea as prefab isolation editing): the
 * chunk cell whose content is open as the working doc in the viewport, or
 * null when editing a scene/prefab. Unlike prefab editing, the rest of the
 * streamed world stays visible around it — see chunk-manager.ts's
 * suppressCell and main.ts's editChunkCell.
 */
export type EditingChunk = Observable<EditingChunkCell | null>;
export const createEditingChunk = (): EditingChunk => observable<EditingChunkCell | null>(null);

/**
 * A note a human pinned to a place in the world.
 *
 * The focus channel tells an agent what someone is pointing at *right now*;
 * a pin is the durable version — "this doorway is too narrow" left at the
 * doorway, still there tomorrow, still attached to the spot rather than to a
 * chat message that scrolled away. It is deliberately NOT scene data: it is a
 * conversation about the scene, so it lives beside it (see the dev bridge's
 * pin store) and never ends up in a shipped level.
 */
export interface Pin {
  id: string;
  /** World-space anchor. */
  point: [number, number, number];
  /** Entity the pin was dropped on, if any — survives the entity moving away. */
  entityId: string | null;
  text: string;
  createdAt: string;
  /** Addressed. Kept rather than deleted so the exchange stays readable. */
  resolved: boolean;
  /** "human" | an agent's name — who left it. */
  author: string;
  /**
   * When the human pressed "send to AI", or null while it is a private note.
   *
   * The distinction matters: a scratch note to yourself and a request you are
   * actually making of an agent are different acts, and conflating them means
   * an agent either acts on half-formed thoughts or ignores the channel. Only
   * sent pins reach the agent inbox.
   */
  sentAt: string | null;
  /** An agent's written answer, posted back alongside `resolved`. */
  reply?: string;
}

export type Pins = Observable<Pin[]>;
export const createPins = (): Pins => observable<Pin[]>([]);

/** Open context menu (screen position + target entity), or null. */
export interface ContextMenuState {
  x: number;
  y: number;
  entityId: string | null;
  /** World point under the cursor when the menu opened, for place-based actions. */
  point?: [number, number, number] | null;
}
export type ContextMenu = Observable<ContextMenuState | null>;
export const createContextMenu = (): ContextMenu => observable<ContextMenuState | null>(null);

export const defaultEditorSettings: EditorSettings = {
  snap: true,
  translateSnap: 0.5,
  rotateSnapDeg: 15,
  scaleSnap: 0.1,
  grid: true,
  gridSize: 1,
  showPhysics: true,
  showSkeletons: false,
  showLights: true,
  showStats: true,
};

/**
 * Entity id -> ordered bone names of its loaded skinned model. Populated by
 * the host from onModelLoaded (via @hitreg/render collectBones); the
 * inspector uses it to offer bone-name dropdowns instead of blind typing.
 */
export type ModelBones = Observable<Record<string, string[]>>;
export const createModelBones = (): ModelBones => observable<Record<string, string[]>>({});

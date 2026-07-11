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

export type GizmoMode = "translate" | "rotate" | "scale";

export type GrayboxShape = "box" | "cylinder" | "sphere" | "wedge" | "poly";

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

export const defaultDockSizes: DockSizes = { top: 64, left: 300, right: 360, bottom: 240 };

export function createDockSizes(): Observable<DockSizes> {
  let initial = defaultDockSizes;
  try {
    const saved = localStorage.getItem("hitreg-editor-docks");
    if (saved) initial = { ...defaultDockSizes, ...(JSON.parse(saved) as Partial<DockSizes>) };
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
}

/** Selected asset in the Assets panel (mutually exclusive with entity selection). */
export interface AssetSelectionState {
  kind: "material" | "prefab" | "model" | "texture";
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

/** Open context menu (screen position + target entity), or null. */
export interface ContextMenuState {
  x: number;
  y: number;
  entityId: string | null;
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
};

/**
 * Entity id -> ordered bone names of its loaded skinned model. Populated by
 * the host from onModelLoaded (via @hitreg/render collectBones); the
 * inspector uses it to offer bone-name dropdowns instead of blind typing.
 */
export type ModelBones = Observable<Record<string, string[]>>;
export const createModelBones = (): ModelBones => observable<Record<string, string[]>>({});

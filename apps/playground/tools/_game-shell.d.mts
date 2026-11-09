/** Types for `_game-shell.mjs` (the game shell of a world scene, read from the closure's assets/game-shell.json). */

export interface ShellEntity {
  name: string;
  parent: string | null;
  tags: string[];
  components: Record<string, unknown>;
}

export interface GameShell {
  player: { id: string; name?: string; tags?: string[]; prefab: string; replaces?: string[] };
  camera?: { id?: string; camera: Record<string, unknown> };
  systems?: Record<string, { name?: string; tags?: string[]; components?: Record<string, unknown>; paramsFrom?: Record<string, string> }>;
  pools?: ShellPools;
}

export interface ShellPools {
  parent?: string;
  parkY?: number;
  fps?: number;
  flipbooks?: Array<{ name: string; count: number; frames: number; lifetime?: number; loop?: boolean }>;
  particles?: Array<{ kind: string; count: number; data: Record<string, unknown> }>;
  meshes?: Array<{ id: string; name?: string; count: number; tags?: string[]; mesh: Record<string, unknown> }>;
}

export interface LoadedShell {
  shell: GameShell;
  /** The game-shell.json found. */
  file: string;
  /** The project folder that owns it (paramsFrom paths are relative to it). */
  ownerDir: string;
}

export interface ShellPlan {
  /** One applyOps batch (add-entity / remove-entity / set-component). */
  ops: Array<Record<string, unknown> & { op: string }>;
  added: string[];
  skipped: string[];
  findings: string[];
}

export interface PlanOptions {
  /** The player prefab JSON, for the doubled-marker check. */
  prefabDoc?: { entities?: Record<string, { tags?: string[] }> };
  replacePlayer?: boolean;
  keepCamera?: boolean;
  /** The world's spawn (tools/_world-spawn.mts + a ground probe): the player root and the spawn marker go there. */
  spawn?: { position: [number, number, number]; rotation: [number, number, number, number]; from: string } | null;
}

interface SceneLike { entities: Record<string, any> }

export function loadShell(project: string): LoadedShell | null;
export function poolEntities(pools: ShellPools, parent?: string): Record<string, ShellEntity>;
export function systemEntities(loaded: LoadedShell): Record<string, ShellEntity>;
export function planShell(loaded: LoadedShell, doc: SceneLike, opts?: PlanOptions): ShellPlan;
/** Re-exported from _closure.mjs: the first assets/<rel> across the closure, or null. */
export function findAsset(project: string, rel: string): string | null;
/** Re-exported from _closure.mjs: the projects folder (HITREG_PROJECTS_ROOT overrides it). */
export function projectsRoot(): string;
export function shellGaps(loaded: LoadedShell, doc: SceneLike, opts?: PlanOptions): string[];

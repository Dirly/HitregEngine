import type { ComponentRegistry } from "./components/registry.js";
import { applyOps, type ApplyResult, type Op } from "./ops.js";
import {
  buildSceneIndex,
  updateSceneIndex,
  type SceneIndex,
} from "./scene-index.js";
import type { SceneDoc } from "./scene.js";

/**
 * What a store notification is about. `ops` changes carry the batch's
 * ApplyResult so subscribers can reconcile incrementally (affected sets say
 * exactly which entities/components moved); `replace` means the whole document
 * was swapped and derived state must be rebuilt from scratch.
 */
export type StoreChange =
  | { kind: "ops"; result: ApplyResult }
  | { kind: "replace" };

/**
 * The live scene document: single source of truth shared by every frontend
 * (editor panels, gizmos, AI apply_ops). All mutation flows through apply(),
 * which is atomic and feeds the undo/redo stacks.
 */
export class SceneStore {
  private current: SceneDoc;
  private undoStack: Op[][] = [];
  private redoStack: Op[][] = [];
  private listeners = new Set<(change: StoreChange) => void>();
  /** Lazily built, incrementally maintained. null = stale, rebuild on demand. */
  private cachedIndex: SceneIndex | null = null;

  constructor(
    initial: SceneDoc,
    private readonly registry: ComponentRegistry,
  ) {
    this.current = initial;
  }

  get doc(): SceneDoc {
    return this.current;
  }

  /**
   * Derived lookup index over the current doc (children/tags/components/
   * prefab instances). Built lazily on first access, then kept in sync with
   * every apply/undo/redo — incrementally for non-structural batches, via
   * full rebuild otherwise. Treat it as read-only and disposable.
   */
  get index(): SceneIndex {
    if (this.cachedIndex === null) {
      this.cachedIndex = buildSceneIndex(this.current);
    }
    return this.cachedIndex;
  }

  /** Throws OpError (leaving the doc untouched) if any op in the batch is invalid. */
  apply(ops: Op[]): void {
    const result = applyOps(this.current, ops, this.registry);
    this.commit(result);
    this.undoStack.push(result.inverse);
    this.redoStack = [];
    this.emit({ kind: "ops", result });
  }

  /** Advance the doc and keep the cached index (if any) consistent with it. */
  private commit(result: ApplyResult): void {
    const prev = this.current;
    this.current = result.doc;
    if (this.cachedIndex === null) return; // nobody asked yet; stay lazy
    if (!updateSceneIndex(this.cachedIndex, prev, result.doc, result)) {
      // structural batch (removals/reparents): rebuild — still cheap, and
      // guaranteed to match buildSceneIndex output exactly
      this.cachedIndex = buildSceneIndex(result.doc);
    }
  }

  get canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  get canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  undo(): void {
    const batch = this.undoStack.pop();
    if (!batch) return;
    const result = applyOps(this.current, batch, this.registry);
    this.commit(result);
    this.redoStack.push(result.inverse);
    this.emit({ kind: "ops", result });
  }

  redo(): void {
    const batch = this.redoStack.pop();
    if (!batch) return;
    const result = applyOps(this.current, batch, this.registry);
    this.commit(result);
    this.undoStack.push(result.inverse);
    this.emit({ kind: "ops", result });
  }

  /**
   * Replace the whole document (external source of truth changed, e.g. the
   * scene file was edited on disk). Clears undo/redo — history from another
   * document is meaningless.
   */
  replace(doc: SceneDoc): void {
    this.current = doc;
    this.undoStack = [];
    this.redoStack = [];
    this.cachedIndex = null; // arbitrary new doc: rebuild lazily on demand
    this.emit({ kind: "replace" });
  }

  subscribe(listener: (change: StoreChange) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(change: StoreChange): void {
    for (const listener of this.listeners) listener(change);
  }
}

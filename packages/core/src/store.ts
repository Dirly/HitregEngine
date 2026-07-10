import type { ComponentRegistry } from "./components/registry.js";
import { applyOps, type Op } from "./ops.js";
import type { SceneDoc } from "./scene.js";

/**
 * The live scene document: single source of truth shared by every frontend
 * (editor panels, gizmos, AI apply_ops). All mutation flows through apply(),
 * which is atomic and feeds the undo/redo stacks.
 */
export class SceneStore {
  private current: SceneDoc;
  private undoStack: Op[][] = [];
  private redoStack: Op[][] = [];
  private listeners = new Set<() => void>();

  constructor(
    initial: SceneDoc,
    private readonly registry: ComponentRegistry,
  ) {
    this.current = initial;
  }

  get doc(): SceneDoc {
    return this.current;
  }

  /** Throws OpError (leaving the doc untouched) if any op in the batch is invalid. */
  apply(ops: Op[]): void {
    const { doc, inverse } = applyOps(this.current, ops, this.registry);
    this.current = doc;
    this.undoStack.push(inverse);
    this.redoStack = [];
    this.emit();
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
    const { doc, inverse } = applyOps(this.current, batch, this.registry);
    this.current = doc;
    this.redoStack.push(inverse);
    this.emit();
  }

  redo(): void {
    const batch = this.redoStack.pop();
    if (!batch) return;
    const { doc, inverse } = applyOps(this.current, batch, this.registry);
    this.current = doc;
    this.undoStack.push(inverse);
    this.emit();
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
    this.emit();
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }
}

import * as THREE from "three/webgpu";
import { TransformControls } from "three/addons/controls/TransformControls.js";
import { duplicateSubtree, type SceneStore } from "@hitreg/core";
import type {
  ContextMenu,
  EditorSettings,
  GizmoMode,
  Observable,
  Selection,
} from "./state.js";

export interface ViewportOptions {
  canvas: HTMLCanvasElement;
  camera: THREE.PerspectiveCamera;
  store: SceneStore;
  selection: Selection;
  enabled: Observable<boolean>;
  settings: Observable<EditorSettings>;
  gizmoMode: Observable<GizmoMode>;
  contextMenu?: ContextMenu;
  /** While the graybox tool is active, picking and gizmos stand down. */
  grayboxActive?: Observable<boolean>;
  /** Current (possibly rebuilt) scene + entity object lookup. */
  getScene(): THREE.Scene;
  getObject(id: string): THREE.Object3D | undefined;
  /** Fires while the gizmo drags — use to disable camera controls. */
  onDraggingChanged?(dragging: boolean): void;
}

/**
 * In-viewport editing: click-to-select (raycast), transform gizmos with
 * configurable snapping, editor grid, and keyboard actions (W/E/R modes,
 * Delete, Ctrl+D duplicate, Ctrl+Z/Y). Every commit emits ops — the same
 * channel as inspector and AI.
 */
export class ViewportTools {
  private readonly controls: TransformControls;
  private readonly raycaster = new THREE.Raycaster();
  private grid: THREE.GridHelper | null = null;
  private pointerDown: { x: number; y: number } | null = null;
  private disposers: Array<() => void> = [];

  constructor(private readonly opts: ViewportOptions) {
    this.controls = new TransformControls(opts.camera, opts.canvas);
    this.controls.addEventListener("dragging-changed", (event) => {
      const dragging = Boolean((event as { value: unknown }).value);
      opts.onDraggingChanged?.(dragging);
      if (!dragging) this.commitTransform();
    });

    const onPointerDown = (e: PointerEvent) => {
      this.pointerDown = { x: e.clientX, y: e.clientY };
    };
    const onPointerUp = (e: PointerEvent) => {
      if (this.opts.grayboxActive?.get()) return;
      if (!this.opts.enabled.get() || !this.pointerDown) return;
      const moved =
        Math.abs(e.clientX - this.pointerDown.x) + Math.abs(e.clientY - this.pointerDown.y);
      this.pointerDown = null;
      if (moved < 5 && !this.controls.dragging) this.pick(e);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (!this.opts.enabled.get()) return;
      if (
        e.target instanceof HTMLInputElement ||
        e.target instanceof HTMLTextAreaElement ||
        e.target instanceof HTMLSelectElement
      ) {
        return;
      }
      if (e.code === "KeyW") this.opts.gizmoMode.set("translate");
      if (e.code === "KeyE") this.opts.gizmoMode.set("rotate");
      if (e.code === "KeyR") this.opts.gizmoMode.set("scale");
      if (e.ctrlKey && e.code === "KeyZ") this.opts.store.undo();
      if (e.ctrlKey && e.code === "KeyY") this.opts.store.redo();
      if (e.code === "Delete" || e.code === "Backspace") this.deleteSelection();
      if (e.ctrlKey && e.code === "KeyD") {
        e.preventDefault();
        this.duplicateSelection();
      }
    };

    // right-click (without drag-pan movement) opens the context menu on the
    // picked entity; right-DRAG stays camera pan. Browser menu is suppressed.
    const onContextMenu = (e: MouseEvent) => {
      e.preventDefault();
      if (!this.opts.enabled.get() || !this.opts.contextMenu) return;
      if (this.pointerDown) return; // mid-gesture
      const picked = this.pickAt(e.clientX, e.clientY);
      if (picked) this.opts.selection.set(picked);
      this.opts.contextMenu.set({ x: e.clientX, y: e.clientY, entityId: picked });
    };

    opts.canvas.addEventListener("pointerdown", onPointerDown);
    opts.canvas.addEventListener("pointerup", onPointerUp);
    opts.canvas.addEventListener("contextmenu", onContextMenu);
    window.addEventListener("keydown", onKeyDown);
    this.disposers.push(
      () => opts.canvas.removeEventListener("pointerdown", onPointerDown),
      () => opts.canvas.removeEventListener("pointerup", onPointerUp),
      () => opts.canvas.removeEventListener("contextmenu", onContextMenu),
      () => window.removeEventListener("keydown", onKeyDown),
      opts.selection.subscribe(() => this.syncAttachment()),
      opts.enabled.subscribe(() => {
        this.syncAttachment();
        this.refreshGrid();
      }),
      ...(opts.grayboxActive ? [opts.grayboxActive.subscribe(() => this.syncAttachment())] : []),
      opts.settings.subscribe(() => {
        this.applySnaps();
        this.refreshGrid();
      }),
      opts.gizmoMode.subscribe(() => this.controls.setMode(this.opts.gizmoMode.get())),
    );
    this.applySnaps();
  }

  /** Call after every scene rebuild: re-adds gizmo helper + grid, reattaches selection. */
  onSceneRebuilt(): void {
    this.opts.getScene().add(this.controls.getHelper());
    this.grid = null; // belonged to the old scene
    this.refreshGrid();
    this.syncAttachment();
  }

  private applySnaps(): void {
    const s = this.opts.settings.get();
    this.controls.setTranslationSnap(s.snap ? s.translateSnap : null);
    this.controls.setRotationSnap(s.snap ? THREE.MathUtils.degToRad(s.rotateSnapDeg) : null);
    this.controls.setScaleSnap(s.snap ? s.scaleSnap : null);
  }

  private refreshGrid(): void {
    const s = this.opts.settings.get();
    const scene = this.opts.getScene();
    if (this.grid) {
      this.grid.removeFromParent();
      this.grid = null;
    }
    if (s.grid && this.opts.enabled.get()) {
      const size = 100;
      const divisions = Math.max(1, Math.round(size / s.gridSize));
      this.grid = new THREE.GridHelper(size, divisions, 0x4a5568, 0x21262d);
      this.grid.position.y = 0.01; // avoid z-fighting with ground meshes
      scene.add(this.grid);
    }
  }

  private deleteSelection(): void {
    const id = this.opts.selection.get();
    if (!id) return;
    this.opts.selection.set(null);
    this.opts.store.apply([{ op: "remove-entity", id }]);
  }

  private duplicateSelection(): void {
    const id = this.opts.selection.get();
    if (!id) return;
    const ops = duplicateSubtree(this.opts.store.doc, id);
    if (ops.length === 0) return;
    this.opts.store.apply(ops);
    this.opts.selection.set(ops[0]!.op === "add-entity" ? (ops[0] as { id: string }).id : id);
  }

  private syncAttachment(): void {
    const id = this.opts.selection.get();
    const object =
      id && this.opts.enabled.get() && !this.opts.grayboxActive?.get()
        ? this.opts.getObject(id)
        : undefined;
    if (object) this.controls.attach(object);
    else this.controls.detach();
  }

  private pick(e: PointerEvent): void {
    this.opts.selection.set(this.pickAt(e.clientX, e.clientY));
  }

  /** Raycast a screen point to a SOURCE-doc entity id (prefab instances pick as one unit). */
  pickAt(clientX: number, clientY: number): string | null {
    const rect = this.opts.canvas.getBoundingClientRect();
    const ndc = new THREE.Vector2(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -((clientY - rect.top) / rect.height) * 2 + 1,
    );
    this.raycaster.setFromCamera(ndc, this.opts.camera);
    const hits = this.raycaster.intersectObjects(this.opts.getScene().children, true);
    for (const hit of hits) {
      let node: THREE.Object3D | null = hit.object;
      while (node) {
        const entityId = node.userData["entityId"] as string | undefined;
        if (entityId) return entityId.split(":")[0]!;
        node = node.parent;
      }
    }
    return null;
  }

  private commitTransform(): void {
    const id = this.opts.selection.get();
    const object = this.controls.object;
    if (!id || !object) return;
    this.opts.store.apply([
      {
        op: "set-component",
        id,
        component: "transform",
        data: {
          position: object.position.toArray(),
          rotation: object.quaternion.toArray() as [number, number, number, number],
          scale: object.scale.toArray(),
        },
      },
    ]);
  }

  dispose(): void {
    for (const dispose of this.disposers) dispose();
    this.controls.dispose();
  }
}

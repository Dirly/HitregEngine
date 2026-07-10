import * as THREE from "three/webgpu";
import { TransformControls } from "three/addons/controls/TransformControls.js";
import { duplicateSubtree, newId, type AssetLibrary, type SceneStore } from "@hitreg/core";
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
  /** Needed to resolve names when assets are drag-dropped into the viewport. */
  assets?: AssetLibrary;
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
  private altDown = false;
  private rmbDown = false;
  /** Alt-scale anchor: keep the object's lowest point fixed while scaling. */
  private scaleAnchor: { bottomY: number; k: number } | null = null;

  constructor(private readonly opts: ViewportOptions) {
    this.controls = new TransformControls(opts.camera, opts.canvas);
    this.controls.addEventListener("dragging-changed", (event) => {
      const dragging = Boolean((event as { value: unknown }).value);
      opts.onDraggingChanged?.(dragging);
      if (dragging && this.controls.mode === "scale" && this.controls.object) {
        // capture the lowest point so Alt can anchor scaling to the floor
        const object = this.controls.object;
        const box = new THREE.Box3().setFromObject(object);
        if (Number.isFinite(box.min.y) && object.scale.y !== 0) {
          this.scaleAnchor = {
            bottomY: box.min.y,
            k: (object.position.y - box.min.y) / object.scale.y,
          };
        }
      }
      if (!dragging) {
        this.scaleAnchor = null;
        this.commitTransform();
      }
    });
    this.controls.addEventListener("objectChange", () => {
      const object = this.controls.object;
      if (!object || !this.altDown || this.controls.mode !== "scale" || !this.scaleAnchor) return;
      object.position.y = this.scaleAnchor.bottomY + this.scaleAnchor.k * object.scale.y;
    });

    const onPointerDown = (e: PointerEvent) => {
      if (e.button === 2) this.rmbDown = true;
      this.pointerDown = { x: e.clientX, y: e.clientY };
    };
    const onWindowPointerUp = (e: PointerEvent) => {
      if (e.button === 2) this.rmbDown = false;
    };
    window.addEventListener("pointerup", onWindowPointerUp);
    this.disposers.push(() => window.removeEventListener("pointerup", onWindowPointerUp));
    const onPointerUp = (e: PointerEvent) => {
      if (this.opts.grayboxActive?.get()) return;
      if (!this.opts.enabled.get() || !this.pointerDown) return;
      const moved =
        Math.abs(e.clientX - this.pointerDown.x) + Math.abs(e.clientY - this.pointerDown.y);
      this.pointerDown = null;
      if (moved < 5 && !this.controls.dragging) this.pick(e);
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.key === "Alt") this.altDown = false;
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Alt") {
        this.altDown = true;
        e.preventDefault(); // keep browsers from stealing focus to the menu bar
      }
      if (!this.opts.enabled.get()) return;
      if (
        e.target instanceof HTMLInputElement ||
        e.target instanceof HTMLTextAreaElement ||
        e.target instanceof HTMLSelectElement
      ) {
        return;
      }
      // while flying (RMB held), WASD/QE belong to the camera, not the gizmo
      if (this.rmbDown) return;
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

    // drag & drop from the assets dock: prefabs/models spawn at the drop
    // point; a material dropped onto an object is assigned to its mesh
    const onDragOver = (e: DragEvent) => {
      if (e.dataTransfer?.types.includes("application/x-hitreg-asset")) e.preventDefault();
    };
    const onDrop = (e: DragEvent) => {
      const raw = e.dataTransfer?.getData("application/x-hitreg-asset");
      if (!raw || !this.opts.enabled.get()) return;
      e.preventDefault();
      try {
        this.handleAssetDrop(
          JSON.parse(raw) as { kind: string; id: string },
          e.clientX,
          e.clientY,
          e.ctrlKey,
        );
      } catch (error) {
        console.warn("[editor] asset drop failed:", error);
      }
    };

    opts.canvas.addEventListener("pointerdown", onPointerDown);
    opts.canvas.addEventListener("pointerup", onPointerUp);
    opts.canvas.addEventListener("contextmenu", onContextMenu);
    opts.canvas.addEventListener("dragover", onDragOver);
    opts.canvas.addEventListener("drop", onDrop);
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    this.disposers.push(() => window.removeEventListener("keyup", onKeyUp));
    this.disposers.push(
      () => opts.canvas.removeEventListener("pointerdown", onPointerDown),
      () => opts.canvas.removeEventListener("pointerup", onPointerUp),
      () => opts.canvas.removeEventListener("contextmenu", onContextMenu),
      () => opts.canvas.removeEventListener("dragover", onDragOver),
      () => opts.canvas.removeEventListener("drop", onDrop),
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

  private handleAssetDrop(
    payload: { kind: string; id: string },
    clientX: number,
    clientY: number,
    ctrl: boolean,
  ): void {
    // material dropped onto an object: assign it
    if (payload.kind === "material") {
      const target = this.pickAt(clientX, clientY);
      if (!target) return;
      const entity = this.opts.store.doc.entities[target];
      const mesh = entity?.components["mesh"] as Record<string, unknown> | undefined;
      if (!mesh) return;
      this.opts.store.apply([
        { op: "set-component", id: target, component: "mesh", data: { ...mesh, material: payload.id } },
      ]);
      this.opts.selection.set(target);
      return;
    }

    // prefab/model: spawn at the drop point (surface hit or ground plane)
    const rect = this.opts.canvas.getBoundingClientRect();
    this.raycaster.setFromCamera(
      new THREE.Vector2(
        ((clientX - rect.left) / rect.width) * 2 - 1,
        -((clientY - rect.top) / rect.height) * 2 + 1,
      ),
      this.opts.camera,
    );
    const hit = this.raycaster
      .intersectObjects(this.opts.getScene().children, true)
      .find((h) => !h.object.userData["physicsDebug"]);
    let point = hit?.point ?? null;
    if (!point) {
      const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
      const p = new THREE.Vector3();
      point = this.raycaster.ray.intersectPlane(plane, p) ? p : null;
    }
    if (!point) return;

    const s = this.opts.settings.get();
    const snapping = s.snap !== ctrl;
    const sn = (v: number) => (snapping ? Math.round(v / s.translateSnap) * s.translateSnap : v);
    const position: [number, number, number] = [sn(point.x), Math.max(0, point.y), sn(point.z)];

    const id = newId();
    const name =
      payload.kind === "prefab"
        ? (this.opts.assets?.getPrefab(payload.id)?.name ?? payload.id)
        : (this.opts.assets?.getModel(payload.id)?.name ?? payload.id);
    const components: Record<string, unknown> =
      payload.kind === "prefab"
        ? { transform: { position }, prefab: { prefabId: payload.id } }
        : { transform: { position }, mesh: { source: { kind: "asset", assetId: payload.id } } };
    this.opts.store.apply([
      { op: "add-entity", id, entity: { name, parent: null, tags: [], components } },
    ]);
    this.opts.selection.set(id);
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

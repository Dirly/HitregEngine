import * as THREE from "three/webgpu";
import { TransformControls } from "three/addons/controls/TransformControls.js";
import { newId, type AssetLibrary, type Op, type SceneStore } from "@hitreg/core";
import type {
  ContextMenu,
  EditorSettings,
  FocusHit,
  GizmoMode,
  Hover,
  Manipulating,
  MultiSelection,
  Observable,
  Selection,
} from "./state.js";
import { selectSingle, toggleSelection } from "./state.js";
import { setRayFromScreen } from "./screen-ray.js";
import { applyMaterialToMany, deleteMany, duplicateMany, isLockedCascading } from "./selection-ops.js";

export interface ViewportOptions {
  canvas: HTMLCanvasElement;
  camera: THREE.PerspectiveCamera;
  store: SceneStore;
  selection: Selection;
  /** Full selected set; `selection` is always its active/last-clicked member. */
  multiSelection?: MultiSelection;
  enabled: Observable<boolean>;
  settings: Observable<EditorSettings>;
  gizmoMode: Observable<GizmoMode>;
  contextMenu?: ContextMenu;
  /** While the graybox tool is active, picking and gizmos stand down. */
  grayboxActive?: Observable<boolean>;
  /** While the path tool is active, picking and gizmos stand down. */
  pathActive?: Observable<boolean>;
  /** Published: what the cursor is over (entity + surface point), sampled. */
  hover?: Hover;
  /** Published: what a gizmo drag currently has hold of, while it lasts. */
  manipulating?: Manipulating;
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
  private flyBtnDown = false;
  private flewDuringDrag = false;
  /** Alt-scale anchor: keep the object's lowest point fixed while scaling. */
  private scaleAnchor: { bottomY: number; k: number } | null = null;
  /**
   * Group-transform state (2+ selected): the gizmo attaches to a bare proxy
   * object instead of a real entity so dragging never re-parents anything —
   * each real object's transform is re-derived from the proxy's delta and
   * written back into its OWN parent-local space.
   */
  private groupProxy: THREE.Object3D | null = null;
  private groupIds: string[] | null = null;
  private groupStart: Map<string, THREE.Matrix4> | null = null;
  private proxyStartInverse: THREE.Matrix4 | null = null;
  /**
   * Hover sampling clock. A raycast against the whole scene is far too
   * expensive to run per pointermove in a streamed world, and nothing
   * downstream needs it that often — the context bridge posts at 1Hz. 10Hz is
   * already generous, and it costs nothing when the pointer is still.
   */
  private lastHoverSample = 0;

  constructor(private readonly opts: ViewportOptions) {
    this.controls = new TransformControls(opts.camera, opts.canvas);
    this.controls.addEventListener("dragging-changed", (event) => {
      const dragging = Boolean((event as { value: unknown }).value);
      opts.onDraggingChanged?.(dragging);
      if (dragging && this.groupProxy && this.groupIds) {
        this.snapshotGroupStart();
      } else if (dragging && this.controls.mode === "scale" && this.controls.object) {
        // capture the lowest point so Alt can anchor scaling to the floor
        // (single-object only — the proxy has no geometry to box)
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
        if (this.groupProxy && this.groupStart) this.commitGroupTransform();
        else this.commitTransform();
      }
      opts.manipulating?.set(dragging ? { ids: this.selectedIds(), mode: this.controls.mode } : null);
    });
    this.controls.addEventListener("objectChange", () => {
      if (this.groupProxy) {
        this.applyGroupDelta();
        return;
      }
      const object = this.controls.object;
      if (!object || !this.altDown || this.controls.mode !== "scale" || !this.scaleAnchor) return;
      object.position.y = this.scaleAnchor.bottomY + this.scaleAnchor.k * object.scale.y;
    });

    const onPointerDown = (e: PointerEvent) => {
      if (e.button === 0) {
        this.flyBtnDown = true;
        this.flewDuringDrag = false;
      }
      this.pointerDown = { x: e.clientX, y: e.clientY };
    };
    const onWindowPointerUp = (e: PointerEvent) => {
      if (e.button === 0) this.flyBtnDown = false;
    };
    window.addEventListener("pointerup", onWindowPointerUp);
    this.disposers.push(() => window.removeEventListener("pointerup", onWindowPointerUp));
    const onPointerUp = (e: PointerEvent) => {
      if (this.opts.grayboxActive?.get() || this.opts.pathActive?.get()) return;
      if (!this.opts.enabled.get() || !this.pointerDown) return;
      const moved =
        Math.abs(e.clientX - this.pointerDown.x) + Math.abs(e.clientY - this.pointerDown.y);
      this.pointerDown = null;
      // a keyboard flight with a still mouse is not a selection click
      if (this.flewDuringDrag) return;
      if (moved < 5 && !this.controls.dragging) this.pick(e);
    };
    const onPointerMove = (e: PointerEvent) => {
      if (!opts.hover) return;
      // stand down for exactly the states where a hover reading would be
      // meaningless or wasteful: overlay hidden, another tool owning the
      // cursor, a drag in flight, or play-mode pointer lock
      if (
        !this.opts.enabled.get() ||
        this.opts.grayboxActive?.get() ||
        this.opts.pathActive?.get() ||
        this.controls.dragging ||
        this.pointerDown !== null ||
        document.pointerLockElement === opts.canvas
      ) {
        if (opts.hover.get() !== null) opts.hover.set(null);
        return;
      }
      const now = performance.now();
      if (now - this.lastHoverSample < HOVER_SAMPLE_MS) return;
      this.lastHoverSample = now;
      const hit = this.pickDetailAt(e.clientX, e.clientY);
      const previous = opts.hover.get();
      // only publish real changes — a still cursor should not wake subscribers
      if (previous?.id === hit?.id && sameishPoint(previous?.point, hit?.point)) return;
      opts.hover.set(hit);
    };
    const onPointerLeave = () => opts.hover?.set(null);
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
      // while flying (mouse held + move keys), WASD/QE belong to the camera
      if (this.flyBtnDown) {
        if (/^Key[WASDQE]$/.test(e.code)) this.flewDuringDrag = true;
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
      const hit = this.pickDetailAt(e.clientX, e.clientY);
      const picked = hit?.id ?? null;
      // keep an existing multi-selection intact when right-clicking one of
      // its own members, so "duplicate"/"delete" from the menu act on the
      // whole group; otherwise collapse to just the picked entity
      if (picked && !(this.opts.multiSelection?.get().includes(picked) ?? false)) {
        this.opts.selection.set(picked);
        this.opts.multiSelection?.set([picked]);
      }
      this.opts.contextMenu.set({
        x: e.clientX,
        y: e.clientY,
        entityId: picked,
        point: hit?.point ?? null,
      });
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
    opts.canvas.addEventListener("pointermove", onPointerMove);
    opts.canvas.addEventListener("pointerleave", onPointerLeave);
    opts.canvas.addEventListener("contextmenu", onContextMenu);
    opts.canvas.addEventListener("dragover", onDragOver);
    opts.canvas.addEventListener("drop", onDrop);
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    this.disposers.push(() => window.removeEventListener("keyup", onKeyUp));
    this.disposers.push(
      () => opts.canvas.removeEventListener("pointerdown", onPointerDown),
      () => opts.canvas.removeEventListener("pointerup", onPointerUp),
      () => opts.canvas.removeEventListener("pointermove", onPointerMove),
      () => opts.canvas.removeEventListener("pointerleave", onPointerLeave),
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
      ...(opts.pathActive ? [opts.pathActive.subscribe(() => this.syncAttachment())] : []),
      ...(opts.multiSelection ? [opts.multiSelection.subscribe(() => this.syncAttachment())] : []),
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

  /** Currently selected ids: the full multi-selection if wired, else just the primary. */
  private selectedIds(): string[] {
    const multi = this.opts.multiSelection?.get();
    if (multi && multi.length > 0) return multi;
    const id = this.opts.selection.get();
    return id ? [id] : [];
  }

  private isLocked(id: string): boolean {
    return isLockedCascading(this.opts.store.doc, id);
  }

  private deleteSelection(): void {
    const ids = this.selectedIds();
    if (ids.length === 0) return;
    this.opts.selection.set(null);
    this.opts.multiSelection?.set([]);
    deleteMany(this.opts.store, this.opts.store.doc, ids);
  }

  private duplicateSelection(): void {
    const ids = this.selectedIds();
    if (ids.length === 0) return;
    const newRoots = duplicateMany(this.opts.store, this.opts.store.doc, ids);
    if (newRoots.length === 0) return;
    this.opts.selection.set(newRoots[newRoots.length - 1]!);
    this.opts.multiSelection?.set(newRoots);
  }

  private teardownGroupProxy(): void {
    this.groupProxy?.removeFromParent();
    this.groupProxy = null;
    this.groupIds = null;
    this.groupStart = null;
    this.proxyStartInverse = null;
  }

  private syncAttachment(): void {
    this.teardownGroupProxy();
    const enabled =
      this.opts.enabled.get() && !this.opts.grayboxActive?.get() && !this.opts.pathActive?.get();
    const ids = enabled ? this.selectedIds().filter((id) => !!this.opts.getObject(id) && !this.isLocked(id)) : [];
    if (ids.length === 0) {
      this.controls.detach();
      return;
    }
    if (ids.length === 1) {
      this.controls.attach(this.opts.getObject(ids[0]!)!);
      return;
    }
    // group: pivot on the active selection (falling back to the last id) —
    // a bare proxy so dragging never re-parents the real objects
    const primary = this.opts.selection.get();
    const pivotId = primary && ids.includes(primary) ? primary : ids[ids.length - 1]!;
    const pivotObject = this.opts.getObject(pivotId)!;
    pivotObject.updateWorldMatrix(true, false);
    const proxy = new THREE.Object3D();
    proxy.position.setFromMatrixPosition(pivotObject.matrixWorld);
    proxy.quaternion.setFromRotationMatrix(pivotObject.matrixWorld);
    this.opts.getScene().add(proxy);
    this.groupProxy = proxy;
    this.groupIds = ids;
    this.controls.attach(proxy);
  }

  private snapshotGroupStart(): void {
    if (!this.groupProxy || !this.groupIds) return;
    this.groupProxy.updateMatrixWorld(true);
    this.proxyStartInverse = this.groupProxy.matrixWorld.clone().invert();
    this.groupStart = new Map();
    for (const id of this.groupIds) {
      const object = this.opts.getObject(id);
      if (!object) continue;
      object.updateMatrixWorld(true);
      this.groupStart.set(id, object.matrixWorld.clone());
    }
  }

  private applyGroupDelta(): void {
    if (!this.groupProxy || !this.groupStart || !this.proxyStartInverse) return;
    this.groupProxy.updateMatrixWorld(true);
    const delta = new THREE.Matrix4().multiplyMatrices(this.groupProxy.matrixWorld, this.proxyStartInverse);
    const position = new THREE.Vector3();
    const quaternion = new THREE.Quaternion();
    const scale = new THREE.Vector3();
    for (const [id, startWorld] of this.groupStart) {
      const object = this.opts.getObject(id);
      if (!object || !object.parent) continue;
      const newWorld = new THREE.Matrix4().multiplyMatrices(delta, startWorld);
      object.parent.updateMatrixWorld(true);
      const parentInverse = object.parent.matrixWorld.clone().invert();
      new THREE.Matrix4().multiplyMatrices(parentInverse, newWorld).decompose(position, quaternion, scale);
      object.position.copy(position);
      object.quaternion.copy(quaternion);
      object.scale.copy(scale);
    }
  }

  private commitGroupTransform(): void {
    if (!this.groupIds) return;
    const ops: Op[] = [];
    for (const id of this.groupIds) {
      const object = this.opts.getObject(id);
      if (!object) continue;
      ops.push({
        op: "set-component",
        id,
        component: "transform",
        data: {
          position: object.position.toArray(),
          rotation: object.quaternion.toArray() as [number, number, number, number],
          scale: object.scale.toArray(),
        },
      });
    }
    if (ops.length > 0) this.opts.store.apply(ops);
    this.syncAttachment(); // rebuild the proxy fresh at the new pivot
  }

  private pick(e: PointerEvent): void {
    const id = this.pickAt(e.clientX, e.clientY);
    const multi = this.opts.multiSelection;
    if (!multi) {
      this.opts.selection.set(id);
      return;
    }
    if (e.ctrlKey || e.metaKey) {
      if (id) toggleSelection(this.opts.selection, multi, id);
      return; // ctrl-click on empty space: leave the current selection alone
    }
    if (e.shiftKey) {
      // Shift in a 3D viewport means "add to what I have" — there is no
      // rendered order here for the hierarchy's range-select to walk, and a
      // dead modifier is worse than a simple additive one.
      if (id && !multi.get().includes(id)) toggleSelection(this.opts.selection, multi, id);
      return;
    }
    selectSingle(this.opts.selection, multi, id);
  }

  /** Raycast a screen point to a SOURCE-doc entity id (prefab instances pick as one unit). */
  pickAt(clientX: number, clientY: number): string | null {
    return this.pickDetailAt(clientX, clientY)?.id ?? null;
  }

  /**
   * The same raycast as `pickAt`, keeping what the hit actually carried: the
   * surface point, its normal, and the distance. Callers that only want the
   * id use `pickAt`; the focus channel wants the geometry, because "here" is
   * half of most requests a person makes while pointing at something.
   *
   * Returns null only when the ray hit nothing at all. A hit on unowned
   * geometry returns an entry with `id: null` but a real point — that is a
   * legitimate "empty ground at (x,y,z)", not a miss.
   */
  pickDetailAt(clientX: number, clientY: number): FocusHit | null {
    setRayFromScreen(this.raycaster, this.opts.canvas, this.opts.camera, clientX, clientY);
    const hits = this.raycaster.intersectObjects(this.opts.getScene().children, true);
    // the nearest hit on geometry no entity owns — the answer to "where on the
    // ground is the cursor" when nothing selectable is under it
    let unowned: FocusHit | null = null;
    for (const hit of hits) {
      // the sky dome (procedural gradient, no texture/cubemap configured)
      // fills the whole background — never let it eat a deselect-click
      if (hit.object.userData["skyDome"]) continue;
      if (hit.object.userData["physicsDebug"]) continue;
      let node: THREE.Object3D | null = hit.object;
      while (node) {
        const entityId = node.userData["entityId"] as string | undefined;
        if (entityId) {
          const resolved = entityId.split(":")[0]!;
          if (this.isLocked(resolved)) break; // locked: fall through to whatever's behind it
          return this.hitDetail(hit, resolved);
        }
        node = node.parent;
      }
      unowned ??= this.hitDetail(hit, null);
    }
    return unowned;
  }

  private hitDetail(hit: THREE.Intersection, id: string | null): FocusHit {
    let normal: [number, number, number] | null = null;
    if (hit.face) {
      // face normals are object-local; the focus channel speaks world space
      normalMatrix.getNormalMatrix(hit.object.matrixWorld);
      normal = round3(scratchNormal.copy(hit.face.normal).applyMatrix3(normalMatrix).normalize());
    }
    return { id, point: round3(hit.point), normal, distance: Number(hit.distance.toFixed(2)) };
  }

  private handleAssetDrop(
    payload: { kind: string; id: string },
    clientX: number,
    clientY: number,
    ctrl: boolean,
  ): void {
    // material dropped onto an object: assign it (to the whole multi-selection
    // when the drop target is one of its members, else just that one object)
    if (payload.kind === "material") {
      const target = this.pickAt(clientX, clientY);
      if (!target) return;
      const multi = this.opts.multiSelection?.get() ?? [];
      const ids = multi.length > 1 && multi.includes(target) ? multi : [target];
      applyMaterialToMany(this.opts.store, this.opts.store.doc, ids, payload.id);
      this.opts.selection.set(target);
      this.opts.multiSelection?.set(ids);
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
    this.teardownGroupProxy();
    for (const dispose of this.disposers) dispose();
    this.controls.dispose();
  }
}

/** Hover raycast rate. 10Hz — the context bridge downstream posts at 1Hz. */
const HOVER_SAMPLE_MS = 100;

const normalMatrix = new THREE.Matrix3();
const scratchNormal = new THREE.Vector3();

function round3(v: THREE.Vector3): [number, number, number] {
  return [Number(v.x.toFixed(3)), Number(v.y.toFixed(3)), Number(v.z.toFixed(3))];
}

/** Sub-centimetre cursor drift is not a hover change worth publishing. */
function sameishPoint(
  a: [number, number, number] | null | undefined,
  b: [number, number, number] | null | undefined,
): boolean {
  if (!a || !b) return a === b || (!a && !b);
  return (
    Math.abs(a[0] - b[0]) < 0.01 && Math.abs(a[1] - b[1]) < 0.01 && Math.abs(a[2] - b[2]) < 0.01
  );
}

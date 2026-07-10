import * as THREE from "three/webgpu";
import { newId, type SceneStore } from "@hitreg/core";
import type { EditorSettings, Observable, Selection } from "./state.js";

export interface GrayboxToolOptions {
  canvas: HTMLCanvasElement;
  camera: THREE.PerspectiveCamera;
  store: SceneStore;
  selection: Selection;
  settings: Observable<EditorSettings>;
  /** Editor overlay visible. */
  enabled: Observable<boolean>;
  /** Graybox draw mode toggle (the ✏ button / G key). */
  active: Observable<boolean>;
  getScene(): THREE.Scene;
  onDraggingChanged?(dragging: boolean): void;
}

type Vec3 = [number, number, number];

interface MeshComponentData {
  source: { kind: string; shape?: string; size?: Vec3 };
  [k: string]: unknown;
}

type Phase =
  | { kind: "idle" }
  | { kind: "footprint"; base: THREE.Vector3; corner: THREE.Vector3; preview: THREE.Mesh }
  | { kind: "height"; base: THREE.Vector3; corner: THREE.Vector3; h: number; preview: THREE.Mesh }
  | {
      kind: "face";
      entityId: string;
      group: THREE.Object3D;
      meshChild: THREE.Object3D;
      axis: 0 | 1 | 2;
      lineOrigin: THREE.Vector3;
      lineDir: THREE.Vector3;
      t0: number;
      size: Vec3;
      delta: number;
      groupPos0: THREE.Vector3;
    };

/** Closest param t on line (origin + t*dir) to a ray — face-drag projection. */
function rayLineParam(ray: THREE.Ray, origin: THREE.Vector3, dir: THREE.Vector3): number {
  const w0 = new THREE.Vector3().subVectors(origin, ray.origin);
  const a = dir.dot(dir);
  const b = dir.dot(ray.direction);
  const c = ray.direction.dot(ray.direction);
  const d = dir.dot(w0);
  const e = ray.direction.dot(w0);
  const denom = a * c - b * b;
  if (Math.abs(denom) < 1e-6) return 0;
  return (b * e - c * d) / denom;
}

/**
 * ProBuilder-style grayboxing:
 * - drag on the ground/any top surface: draw a footprint, release, move up
 *   for height, click to commit a static box (mesh + collider, via ops).
 * - drag a face of any primitive-box entity: push/pull that face (commits
 *   size + recentered position as ops — undoable like everything else).
 */
export class GrayboxTool {
  private readonly raycaster = new THREE.Raycaster();
  private phase: Phase = { kind: "idle" };
  private readonly disposers: Array<() => void> = [];
  private readonly dragPlane = new THREE.Plane();

  constructor(private readonly opts: GrayboxToolOptions) {
    const down = (e: PointerEvent) => this.onDown(e);
    const move = (e: PointerEvent) => this.onMove(e);
    const up = () => this.onUp();
    const key = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
      if (e.code === "Escape") this.cancel();
      if (e.code === "KeyG" && this.opts.enabled.get()) {
        this.opts.active.set(!this.opts.active.get());
      }
    };
    opts.canvas.addEventListener("pointerdown", down);
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("keydown", key);
    this.disposers.push(
      () => opts.canvas.removeEventListener("pointerdown", down),
      () => window.removeEventListener("pointermove", move),
      () => window.removeEventListener("pointerup", up),
      () => window.removeEventListener("keydown", key),
      opts.active.subscribe(() => {
        if (!opts.active.get()) this.cancel();
      }),
    );
  }

  private get isOn(): boolean {
    return this.opts.enabled.get() && this.opts.active.get();
  }

  private snap(v: number): number {
    const s = this.opts.settings.get();
    if (!s.snap) return v;
    return Math.round(v / s.translateSnap) * s.translateSnap;
  }

  private ray(e: PointerEvent): THREE.Ray {
    const rect = this.opts.canvas.getBoundingClientRect();
    this.raycaster.setFromCamera(
      new THREE.Vector2(
        ((e.clientX - rect.left) / rect.width) * 2 - 1,
        -((e.clientY - rect.top) / rect.height) * 2 + 1,
      ),
      this.opts.camera,
    );
    return this.raycaster.ray;
  }

  private makePreview(): THREE.Mesh {
    const mesh = new THREE.Mesh(
      new THREE.BoxGeometry(1, 1, 1),
      new THREE.MeshBasicMaterial({ color: 0x79c0ff, transparent: true, opacity: 0.3, depthTest: false }),
    );
    mesh.renderOrder = 998;
    this.opts.getScene().add(mesh);
    return mesh;
  }

  private layoutPreview(preview: THREE.Mesh, base: THREE.Vector3, corner: THREE.Vector3, h: number): void {
    const w = Math.max(0.1, Math.abs(corner.x - base.x));
    const d = Math.max(0.1, Math.abs(corner.z - base.z));
    preview.scale.set(w, Math.max(0.05, h), d);
    preview.position.set(
      (base.x + corner.x) / 2,
      base.y + Math.max(0.05, h) / 2,
      (base.z + corner.z) / 2,
    );
  }

  private onDown(e: PointerEvent): void {
    if (!this.isOn || e.button !== 0) return;

    // height phase commits on click
    if (this.phase.kind === "height") {
      e.stopPropagation();
      this.commitBox();
      return;
    }
    if (this.phase.kind !== "idle") return;

    const ray = this.ray(e);
    const hits = this.raycaster.intersectObjects(this.opts.getScene().children, true);
    const hit = hits.find((h) => {
      if (h.object.userData["physicsDebug"]) return false;
      let node: THREE.Object3D | null = h.object;
      while (node) {
        if (node.userData["entityId"]) return true;
        node = node.parent;
      }
      return false;
    });

    // face push/pull on a primitive box entity (not inside a prefab instance)
    if (hit?.face) {
      const expandedId = this.findEntityId(hit.object);
      if (expandedId && !expandedId.includes(":")) {
        const entity = this.opts.store.doc.entities[expandedId];
        const mesh = entity?.components["mesh"] as MeshComponentData | undefined;
        if (
          mesh?.source.kind === "primitive" &&
          mesh.source.shape === "box" &&
          !("prefab" in (entity?.components ?? {}))
        ) {
          e.stopPropagation();
          this.beginFaceDrag(expandedId, hit, mesh.source.size ?? [1, 1, 1], ray);
          return;
        }
      }
    }

    // draw a new box: on an upward-facing surface, or the y=0 plane
    let base: THREE.Vector3 | null = null;
    if (hit) {
      const worldNormal = hit.face
        ? hit.face.normal.clone().transformDirection(hit.object.matrixWorld)
        : new THREE.Vector3(0, 1, 0);
      if (worldNormal.y > 0.85) base = hit.point.clone();
    } else {
      const point = new THREE.Vector3();
      this.dragPlane.set(new THREE.Vector3(0, 1, 0), 0);
      if (ray.intersectPlane(this.dragPlane, point)) base = point;
    }
    if (!base) return;
    e.stopPropagation();
    base.set(this.snap(base.x), Math.max(0, base.y), this.snap(base.z));
    const preview = this.makePreview();
    this.layoutPreview(preview, base, base, 0.05);
    this.phase = { kind: "footprint", base, corner: base.clone(), preview };
    this.opts.onDraggingChanged?.(true);
  }

  private findEntityId(object: THREE.Object3D): string | null {
    let node: THREE.Object3D | null = object;
    while (node) {
      const id = node.userData["entityId"] as string | undefined;
      if (id) return id;
      node = node.parent;
    }
    return null;
  }

  private beginFaceDrag(
    entityId: string,
    hit: THREE.Intersection,
    size: Vec3,
    _ray: THREE.Ray,
  ): void {
    const group = this.groupOf(hit.object);
    if (!group) return;
    // face normal in the box's local space picks the axis
    const local = hit.face!.normal.clone();
    const ax = Math.abs(local.x) >= Math.abs(local.y) && Math.abs(local.x) >= Math.abs(local.z)
      ? 0
      : Math.abs(local.y) >= Math.abs(local.z)
        ? 1
        : 2;
    const lineDir = new THREE.Vector3()
      .fromArray([ax === 0 ? Math.sign(local.x) : 0, ax === 1 ? Math.sign(local.y) : 0, ax === 2 ? Math.sign(local.z) : 0])
      .applyQuaternion(group.getWorldQuaternion(new THREE.Quaternion()))
      .normalize();
    this.phase = {
      kind: "face",
      entityId,
      group,
      meshChild: hit.object,
      axis: ax as 0 | 1 | 2,
      lineOrigin: hit.point.clone(),
      lineDir,
      t0: 0,
      size: [...size] as Vec3,
      delta: 0,
      groupPos0: group.position.clone(),
    };
    this.opts.onDraggingChanged?.(true);
  }

  private groupOf(object: THREE.Object3D): THREE.Object3D | null {
    let node: THREE.Object3D | null = object;
    while (node) {
      if (node.userData["entityId"]) return node;
      node = node.parent;
    }
    return null;
  }

  private onMove(e: PointerEvent): void {
    if (this.phase.kind === "idle") return;
    const ray = this.ray(e);

    if (this.phase.kind === "footprint") {
      const point = new THREE.Vector3();
      this.dragPlane.set(new THREE.Vector3(0, 1, 0), -this.phase.base.y);
      if (!ray.intersectPlane(this.dragPlane, point)) return;
      this.phase.corner.set(this.snap(point.x), this.phase.base.y, this.snap(point.z));
      this.layoutPreview(this.phase.preview, this.phase.base, this.phase.corner, 0.05);
      return;
    }

    if (this.phase.kind === "height") {
      // vertical plane through the footprint center, facing the camera
      const center = new THREE.Vector3(
        (this.phase.base.x + this.phase.corner.x) / 2,
        this.phase.base.y,
        (this.phase.base.z + this.phase.corner.z) / 2,
      );
      const normal = this.opts.camera.getWorldDirection(new THREE.Vector3());
      normal.y = 0;
      if (normal.lengthSq() < 1e-4) return;
      normal.normalize();
      this.dragPlane.setFromNormalAndCoplanarPoint(normal, center);
      const point = new THREE.Vector3();
      if (!ray.intersectPlane(this.dragPlane, point)) return;
      this.phase.h = Math.max(0.1, this.snap(point.y - this.phase.base.y));
      this.layoutPreview(this.phase.preview, this.phase.base, this.phase.corner, this.phase.h);
      return;
    }

    // face drag
    const t = rayLineParam(ray, this.phase.lineOrigin, this.phase.lineDir);
    const raw = t - this.phase.t0;
    const delta = Math.max(0.1 - this.phase.size[this.phase.axis], this.snap(raw));
    this.phase.delta = delta;
    const factor = (this.phase.size[this.phase.axis] + delta) / this.phase.size[this.phase.axis];
    const scale = [1, 1, 1] as Vec3;
    scale[this.phase.axis] = factor;
    this.phase.meshChild.scale.set(...scale);
    // recenter: the opposite face stays put
    const shift = new THREE.Vector3()
      .copy(this.phase.lineDir)
      .multiplyScalar(delta / 2);
    this.phase.group.position.copy(this.phase.groupPos0).add(shift);
  }

  private onUp(): void {
    if (this.phase.kind === "footprint") {
      // area too small = treat as a cancel-click
      const area =
        Math.abs(this.phase.corner.x - this.phase.base.x) *
        Math.abs(this.phase.corner.z - this.phase.base.z);
      if (area < 0.05) {
        this.cancel();
        return;
      }
      this.phase = { ...this.phase, kind: "height", h: 0.1 };
      return; // camera stays disabled until the commit click
    }
    if (this.phase.kind === "face") {
      this.commitFace();
    }
  }

  private commitBox(): void {
    if (this.phase.kind !== "height") return;
    const { base, corner, h, preview } = this.phase;
    preview.removeFromParent();
    const id = newId();
    const size: Vec3 = [
      Math.max(0.1, Math.abs(corner.x - base.x)),
      h,
      Math.max(0.1, Math.abs(corner.z - base.z)),
    ];
    try {
      this.opts.store.apply([
        {
          op: "add-entity",
          id,
          entity: {
            name: "Box",
            parent: null,
            tags: ["graybox"],
            components: {
              transform: {
                position: [(base.x + corner.x) / 2, base.y + h / 2, (base.z + corner.z) / 2],
              },
              mesh: { source: { kind: "primitive", shape: "box", size } },
              collider: { shape: "box", size },
            },
          },
        },
      ]);
      this.opts.selection.set(id);
    } catch (error) {
      console.warn("[graybox] commit rejected:", error);
    }
    this.phase = { kind: "idle" };
    this.opts.onDraggingChanged?.(false);
  }

  private commitFace(): void {
    if (this.phase.kind !== "face") return;
    const { entityId, axis, delta, size, lineDir, groupPos0, group, meshChild } = this.phase;
    this.phase = { kind: "idle" };
    this.opts.onDraggingChanged?.(false);
    meshChild.scale.set(1, 1, 1);
    group.position.copy(groupPos0);
    if (Math.abs(delta) < 1e-4) return;

    const entity = this.opts.store.doc.entities[entityId];
    if (!entity) return;
    const mesh = structuredClone(entity.components["mesh"]) as MeshComponentData;
    const newSize = [...(mesh.source.size ?? [1, 1, 1])] as Vec3;
    newSize[axis] = Math.max(0.1, newSize[axis] + delta);
    mesh.source.size = newSize;

    const transform = structuredClone(
      (entity.components["transform"] ?? {}) as { position?: Vec3; [k: string]: unknown },
    );
    const p = transform.position ?? [0, 0, 0];
    // lineDir is world-space; convert the recenter shift into parent space
    const parent = group.parent;
    const shiftWorld = new THREE.Vector3().copy(lineDir).multiplyScalar(delta / 2);
    const shiftParent = parent
      ? shiftWorld.applyQuaternion(parent.getWorldQuaternion(new THREE.Quaternion()).invert())
      : shiftWorld;
    transform.position = [p[0] + shiftParent.x, p[1] + shiftParent.y, p[2] + shiftParent.z];

    const ops: Array<
      | { op: "set-component"; id: string; component: string; data: unknown }
    > = [
      { op: "set-component", id: entityId, component: "mesh", data: mesh },
      { op: "set-component", id: entityId, component: "transform", data: transform },
    ];
    // keep a box collider in sync when present and box-shaped
    const collider = entity.components["collider"] as { shape?: string; size?: Vec3 } | undefined;
    if (collider?.shape === "box" || (collider && collider.shape === undefined)) {
      const nextCollider = structuredClone(collider);
      nextCollider.size = newSize;
      ops.push({ op: "set-component", id: entityId, component: "collider", data: nextCollider });
    }
    try {
      this.opts.store.apply(ops);
    } catch (error) {
      console.warn("[graybox] face commit rejected:", error);
    }
  }

  private cancel(): void {
    if (this.phase.kind === "footprint" || this.phase.kind === "height") {
      this.phase.preview.removeFromParent();
    }
    if (this.phase.kind === "face") {
      this.phase.meshChild.scale.set(1, 1, 1);
      this.phase.group.position.copy(this.phase.groupPos0);
    }
    if (this.phase.kind !== "idle") {
      this.phase = { kind: "idle" };
      this.opts.onDraggingChanged?.(false);
    }
  }

  dispose(): void {
    this.cancel();
    for (const dispose of this.disposers) dispose();
  }
}

import * as THREE from "three/webgpu";
import { newId, type SceneStore } from "@hitreg/core";
import type { EditorSettings, Observable, Selection } from "./state.js";

export type PathCrossSection = "ribbon" | "tube";

export interface PathToolOptions {
  canvas: HTMLCanvasElement;
  camera: THREE.PerspectiveCamera;
  store: SceneStore;
  selection: Selection;
  settings: Observable<EditorSettings>;
  /** Editor overlay visible. */
  enabled: Observable<boolean>;
  /** Path draw mode toggle (the toolbar button / P key). */
  active: Observable<boolean>;
  crossSection: Observable<PathCrossSection>;
  width: Observable<number>;
  radius: Observable<number>;
  getScene(): THREE.Scene;
  onDraggingChanged?(dragging: boolean): void;
}

type Phase = { kind: "idle" } | { kind: "points"; points: THREE.Vector3[]; line: THREE.Line };

/**
 * Click-to-place curve authoring — roads/rivers/fences (ribbon) or
 * vines/cables (tube): click to drop control points (snapping to whatever
 * scene geometry is under the cursor, so a road placed over terrain follows
 * its elevation instead of a flat plane), click near the first point (or
 * Enter) to finish. Commits a `mesh.source.kind: "path"` entity — see
 * @hitreg/render's path-mesh.ts for how that renders.
 */
export class PathTool {
  private readonly raycaster = new THREE.Raycaster();
  private phase: Phase = { kind: "idle" };
  private readonly disposers: Array<() => void> = [];
  private readonly dragPlane = new THREE.Plane();
  private ctrl = false;

  constructor(private readonly opts: PathToolOptions) {
    const down = (e: PointerEvent) => this.onDown(e);
    const move = (e: PointerEvent) => this.onMove(e);
    const key = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
      if (e.code === "Escape") this.cancel();
      // Shift+P is the profiler window (see main.ts) — guard the modifier so
      // one keystroke can't both open a tool window and toggle a draw mode.
      if (e.code === "KeyP" && !e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey && this.opts.enabled.get()) {
        this.opts.active.set(!this.opts.active.get());
      }
      if (e.code === "Enter" && this.phase.kind === "points" && this.phase.points.length >= 2) {
        this.commit(false);
      }
    };
    opts.canvas.addEventListener("pointerdown", down);
    window.addEventListener("pointermove", move);
    window.addEventListener("keydown", key);
    this.disposers.push(
      () => opts.canvas.removeEventListener("pointerdown", down),
      () => window.removeEventListener("pointermove", move),
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
    const snapping = s.snap !== this.ctrl;
    if (!snapping) return v;
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

  /** A real scene hit (so a road follows terrain elevation) falling back to the y=0 plane. */
  private surfacePoint(ray: THREE.Ray): THREE.Vector3 | null {
    const hits = this.raycaster.intersectObjects(this.opts.getScene().children, true);
    const hit = hits.find((h) => !h.object.userData["physicsDebug"] && !h.object.userData["pathPreview"]);
    if (hit) return hit.point.clone();
    this.dragPlane.set(new THREE.Vector3(0, 1, 0), 0);
    const point = new THREE.Vector3();
    return ray.intersectPlane(this.dragPlane, point) ? point : null;
  }

  private updateLine(cursor?: THREE.Vector3): void {
    if (this.phase.kind !== "points") return;
    const pts = [...this.phase.points];
    if (cursor) pts.push(cursor);
    this.phase.line.geometry.dispose();
    this.phase.line.geometry = new THREE.BufferGeometry().setFromPoints(pts);
  }

  private onDown(e: PointerEvent): void {
    if (!this.isOn || e.button !== 0) return;
    this.ctrl = e.ctrlKey;
    const ray = this.ray(e);
    const p = this.surfacePoint(ray);
    if (!p) return;
    p.set(this.snap(p.x), p.y, this.snap(p.z));
    e.stopPropagation();

    if (this.phase.kind === "idle") {
      const line = new THREE.Line(
        new THREE.BufferGeometry(),
        new THREE.LineBasicMaterial({ color: 0x79c0ff, depthTest: false }),
      );
      line.userData["pathPreview"] = true;
      line.renderOrder = 998;
      this.opts.getScene().add(line);
      this.phase = { kind: "points", points: [p], line };
      this.updateLine();
      this.opts.onDraggingChanged?.(true);
      return;
    }

    const first = this.phase.points[0]!;
    if (this.phase.points.length >= 2 && p.distanceTo(first) < 0.4) {
      this.commit(true);
      return;
    }
    this.phase.points.push(p);
    this.updateLine();
  }

  private onMove(e: PointerEvent): void {
    if (this.phase.kind !== "points") return;
    this.ctrl = e.ctrlKey;
    const p = this.surfacePoint(this.ray(e));
    if (p) {
      p.set(this.snap(p.x), p.y, this.snap(p.z));
      this.updateLine(p);
    }
  }

  private commit(closed: boolean): void {
    if (this.phase.kind !== "points") return;
    const { points, line } = this.phase;
    line.geometry.dispose();
    line.removeFromParent();
    this.phase = { kind: "idle" };
    this.opts.onDraggingChanged?.(false);
    if (points.length < 2) return;

    const origin = points[0]!;
    const localPoints = points.map((p) => [p.x - origin.x, p.y - origin.y, p.z - origin.z] as [number, number, number]);
    const crossSection = this.opts.crossSection.get();
    const id = newId();
    try {
      this.opts.store.apply([
        {
          op: "add-entity",
          id,
          entity: {
            name: crossSection === "ribbon" ? "Road" : "Vine",
            parent: null,
            tags: [],
            components: {
              transform: { position: [origin.x, origin.y, origin.z] },
              mesh: {
                source: {
                  kind: "path",
                  points: localPoints,
                  closed,
                  crossSection,
                  width: this.opts.width.get(),
                  radius: this.opts.radius.get(),
                  radialSegments: 6,
                  segmentsPerSpan: 8,
                },
                castShadow: true,
                receiveShadow: true,
              },
            },
          },
        },
      ]);
      this.opts.selection.set(id);
    } catch (error) {
      console.warn("[path-tool] commit rejected:", error);
    }
  }

  private cancel(): void {
    if (this.phase.kind === "points") {
      this.phase.line.geometry.dispose();
      this.phase.line.removeFromParent();
      this.phase = { kind: "idle" };
      this.opts.onDraggingChanged?.(false);
    }
  }

  dispose(): void {
    this.cancel();
    for (const dispose of this.disposers) dispose();
  }
}

import * as THREE from "three/webgpu";
import type { Observable, Selection, TerrainBrushSettings } from "./state.js";

export interface TerrainToolOptions {
  canvas: HTMLCanvasElement;
  camera: THREE.PerspectiveCamera;
  selection: Selection;
  active: Observable<boolean>;
  brush: Observable<TerrainBrushSettings>;
  getObject(id: string): THREE.Object3D | undefined;
  onStroke(id: string, localPoint: [number, number, number], brush: TerrainBrushSettings): void;
}

/** Viewport brush frontend; persistence and schema validation stay host-owned. */
export class TerrainTool {
  private raycaster = new THREE.Raycaster();
  private dragging = false;
  private lastAt = 0;
  private disposers: Array<() => void> = [];

  constructor(private opts: TerrainToolOptions) {
    const down = (e: PointerEvent) => { if (e.button === 0 && opts.active.get()) { this.dragging = true; this.stroke(e); } };
    const move = (e: PointerEvent) => { if (this.dragging && opts.active.get()) this.stroke(e); };
    const up = () => { this.dragging = false; };
    opts.canvas.addEventListener("pointerdown", down);
    opts.canvas.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    this.disposers.push(
      () => opts.canvas.removeEventListener("pointerdown", down),
      () => opts.canvas.removeEventListener("pointermove", move),
      () => window.removeEventListener("pointerup", up),
    );
  }

  private stroke(e: PointerEvent): void {
    if (performance.now() - this.lastAt < 45) return;
    const id = this.opts.selection.get();
    const object = id ? this.opts.getObject(id) : undefined;
    if (!id || !object) return;
    const rect = this.opts.canvas.getBoundingClientRect();
    this.raycaster.setFromCamera(new THREE.Vector2(
      ((e.clientX - rect.left) / rect.width) * 2 - 1,
      -((e.clientY - rect.top) / rect.height) * 2 + 1,
    ), this.opts.camera);
    const hit = this.raycaster.intersectObject(object, true)[0];
    if (!hit) return;
    const local = object.worldToLocal(hit.point.clone());
    this.lastAt = performance.now();
    this.opts.onStroke(id, [local.x, local.y, local.z], this.opts.brush.get());
  }

  dispose(): void { for (const dispose of this.disposers) dispose(); }
}

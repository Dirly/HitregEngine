import * as THREE from "three/webgpu";
import { TransformControls } from "three/addons/controls/TransformControls.js";
import { LineSegments2 } from "three/addons/lines/webgpu/LineSegments2.js";
import { LineSegmentsGeometry } from "three/addons/lines/LineSegmentsGeometry.js";
import {
  bevelEdges,
  bridgeEdges,
  buildTopology,
  centerPivot,
  collapseVertices,
  compilePolyMesh,
  conformNormals,
  connectEdges,
  connectVertices,
  coplanarFaces,
  connectedFaces,
  deleteEdges,
  deleteFaces,
  deleteVertices,
  detachFaces,
  duplicateFaces,
  edgeId,
  edgeKey,
  edgeLoop,
  edgeRing,
  edgesFaces,
  ensureMaterialSlot,
  extractFaces,
  extrudeEdges,
  extrudeFaces,
  faceEdges,
  facesEdges,
  fillHoles,
  flipEdge,
  flipFaces,
  growFaces,
  insertEdgeLoop,
  insetFaces,
  bakeTransform,
  mergeFaces,
  mirror,
  newId,
  nextSmoothingGroup,
  polyMeshBounds,
  sanitizeSelection,
  selectionCentroid,
  selectionNormal,
  selectionVertices,
  setPivot,
  setFaceColor,
  setVertexColor,
  setFaceMaterial,
  setSmoothingGroup,
  shrinkFaces,
  splitVertices,
  subdivideEdges,
  subdivideFaces,
  transformVertices,
  translateVertices,
  triangulateFaces,
  weldVertices,
  type EdgeKey,
  type ElementSelection,
  type ExtrudeMethod,
  type Op,
  type PolyMesh,
  type SceneStore,
  type Topology,
} from "@hitreg/core";
import type {
  EditorSettings,
  ElementMode,
  ElementSelectionState,
  GizmoMode,
  MeshEditState,
  MultiSelection,
  Observable,
  Selection,
} from "./state.js";
import { emptyElementSelection } from "./state.js";
import { setRayFromScreen } from "./screen-ray.js";
import { booleanMeshes, polyFromObject, type BooleanOp } from "./csg.js";

export interface MeshEditToolOptions {
  canvas: HTMLCanvasElement;
  camera: THREE.PerspectiveCamera;
  store: SceneStore;
  selection: Selection;
  /** Full selected set — booleans take the active entity as A and the other selected entity as B. */
  multiSelection?: MultiSelection;
  settings: Observable<EditorSettings>;
  /** Editor overlay visible. */
  enabled: Observable<boolean>;
  gizmoMode: Observable<GizmoMode>;
  state: MeshEditState;
  getScene(): THREE.Scene;
  getObject(id: string): THREE.Object3D | undefined;
  onDraggingChanged?(dragging: boolean): void;
}

type Vec3 = [number, number, number];

interface MeshComponent {
  source: PolyMesh;
  material?: string;
  [k: string]: unknown;
}

/** Every element action the panel/keyboard can invoke. Params are read from `state.params` unless given. */
export type MeshAction =
  | "extrude"
  | "inset"
  | "bevel"
  | "subdivide"
  | "connect"
  | "insert-loop"
  | "delete"
  | "collapse"
  | "weld"
  | "split"
  | "detach"
  | "detach-to-object"
  | "duplicate"
  | "flip"
  | "conform"
  | "merge"
  | "triangulate"
  | "bridge"
  | "fill"
  | "flip-edge"
  | "grow"
  | "shrink"
  | "loop"
  | "ring"
  | "select-all"
  | "select-none"
  | "invert"
  | "select-connected"
  | "select-coplanar"
  | "select-material"
  | "select-hole"
  | "smooth"
  | "harden"
  | "center-pivot"
  | "floor-pivot"
  | "pivot-to-selection"
  | "offset"
  | "snap-to-grid"
  | "select-smoothing"
  | "freeze-transform"
  | "mirror-x"
  | "mirror-y"
  | "mirror-z";

const COLORS = {
  vertex: new THREE.Color(0xd0d7de),
  edge: new THREE.Color(0x5b8fc4),
  selected: new THREE.Color(0xf2a33a),
  hover: new THREE.Color(0x79c0ff),
};

/**
 * ProBuilder-style element editing for `mesh.source.kind: "poly"` entities.
 *
 * Handles (vertex dots, wireframe, selected-face fill) are drawn as overlays
 * under the entity's group; picking is screen-space for vertices/edges and a
 * triangle→face raycast for faces. A `TransformControls` gizmo is attached
 * to a proxy at the selection centroid — its world delta is mapped back into
 * mesh-local space and applied to the selected vertices, previewed live on
 * the rendered geometry and committed as ONE `set-component` op on release.
 * Every action (extrude, bevel, ...) is a pure @hitreg/core op followed by
 * the same commit path, so all of it is undoable and file-legible.
 *
 * Gestures: click = select (Shift adds, Ctrl toggles); Shift/Ctrl + drag on
 * empty space = marquee; Shift + gizmo drag = extrude-then-move;
 * double-click a face = select its coplanar patch. Keys: 1/2/3/4 modes,
 * Esc clears then exits, Del deletes, Ctrl+A all, Ctrl+I invert, Alt+E
 * extrude, Alt+B bevel, Alt+I inset, Alt+U insert loop, Alt+C connect,
 * Alt+G / Alt+Shift+G grow/shrink, Alt+L loop, Alt+R ring.
 */
export class MeshEditTool {
  private readonly controls: TransformControls;
  private readonly proxy = new THREE.Object3D();
  private readonly raycaster = new THREE.Raycaster();
  private readonly overlay = new THREE.Group();
  private points: THREE.InstancedMesh | null = null;
  private wire: THREE.LineSegments | null = null;
  private selectedEdges: LineSegments2 | null = null;
  private hoverEdge: LineSegments2 | null = null;
  private faceFill: THREE.Mesh | null = null;
  private hoverFill: THREE.Mesh | null = null;
  private marquee: HTMLDivElement | null = null;
  private readonly disposers: Array<() => void> = [];

  private mesh: PolyMesh | null = null;
  private topo: Topology | null = null;
  private entityId: string | null = null;
  private hover: { kind: ElementMode; index: number; edge?: EdgeKey } | null = null;
  private pointerDown: { x: number; y: number; shift: boolean; ctrl: boolean; alt: boolean } | null = null;
  private marqueeActive = false;
  private lastHoverSample = 0;

  /** Drag in flight: vertex indices + start positions + proxy start (world). */
  private drag: {
    vertices: number[];
    start: Map<number, Vec3>;
    proxyStartInverse: THREE.Matrix4;
    entityMatrix: THREE.Matrix4;
    entityInverse: THREE.Matrix4;
    working: PolyMesh;
  } | null = null;

  constructor(private readonly opts: MeshEditToolOptions) {
    this.overlay.name = "meshEditOverlay";
    this.overlay.userData["editorOverlay"] = true;
    this.overlay.renderOrder = 999;

    this.controls = new TransformControls(opts.camera, opts.canvas);
    this.controls.addEventListener("dragging-changed", (event) => {
      const dragging = Boolean((event as { value: unknown }).value);
      opts.onDraggingChanged?.(dragging);
      if (dragging) this.beginDrag();
      else this.endDrag();
    });
    this.controls.addEventListener("objectChange", () => this.updateDrag());

    const down = (e: PointerEvent) => this.onPointerDown(e);
    const move = (e: PointerEvent) => this.onPointerMove(e);
    const up = (e: PointerEvent) => this.onPointerUp(e);
    const dbl = (e: MouseEvent) => this.onDoubleClick(e);
    const key = (e: KeyboardEvent) => this.onKey(e);
    opts.canvas.addEventListener("pointerdown", down);
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    opts.canvas.addEventListener("dblclick", dbl);
    window.addEventListener("keydown", key);
    this.disposers.push(
      () => opts.canvas.removeEventListener("pointerdown", down),
      () => window.removeEventListener("pointermove", move),
      () => window.removeEventListener("pointerup", up),
      () => opts.canvas.removeEventListener("dblclick", dbl),
      () => window.removeEventListener("keydown", key),
      opts.state.active.subscribe(() => this.sync()),
      opts.state.mode.subscribe(() => {
        this.refreshOverlay();
        this.syncGizmo();
      }),
      opts.state.orientation.subscribe(() => this.syncGizmo()),
      opts.state.showSmoothing.subscribe(() => this.refreshOverlay()),
      opts.state.selection.subscribe(() => {
        this.refreshOverlay();
        this.syncGizmo();
      }),
      opts.selection.subscribe(() => this.sync()),
      opts.enabled.subscribe(() => this.sync()),
      opts.gizmoMode.subscribe(() => this.controls.setMode(this.opts.gizmoMode.get())),
      opts.settings.subscribe(() => this.applySnaps()),
      // the reconcile that follows a store change runs in the SAME notification
      // pass (registered after this tool) and strips our overlay from the
      // entity group — re-sync once it has finished
      opts.store.subscribe(() => queueMicrotask(() => this.sync())),
    );
    this.applySnaps();
  }

  /** Call after every scene rebuild (the gizmo helper + overlay belong to the old scene). */
  onSceneRebuilt(): void {
    this.opts.getScene().add(this.controls.getHelper());
    this.sync();
  }

  get isEditing(): boolean {
    return (
      this.opts.enabled.get() &&
      this.opts.state.active.get() &&
      this.opts.state.mode.get() !== "object" &&
      this.entityId !== null
    );
  }

  // ---------------------------------------------------------------- state sync

  private applySnaps(): void {
    const s = this.opts.settings.get();
    this.controls.setTranslationSnap(s.snap ? s.translateSnap : null);
    this.controls.setRotationSnap(s.snap ? THREE.MathUtils.degToRad(s.rotateSnapDeg) : null);
    this.controls.setScaleSnap(s.snap ? s.scaleSnap : null);
  }

  private polyComponent(id: string | null): MeshComponent | null {
    if (!id) return null;
    const mesh = this.opts.store.doc.entities[id]?.components["mesh"] as MeshComponent | undefined;
    return mesh && mesh.source?.kind === "poly" ? mesh : null;
  }

  /** Re-derive the edited entity + mesh from the doc/selection and redraw. */
  sync(): void {
    if (this.drag) return; // never swap the mesh under a live drag
    const state = this.opts.state;
    const wanted = this.opts.enabled.get() && state.active.get() ? this.opts.selection.get() : null;
    const component = this.polyComponent(wanted);
    const nextId = component ? wanted : null;
    if (nextId !== this.entityId) {
      this.entityId = nextId;
      state.entityId.set(nextId);
      if (nextId) state.selection.set(emptyElementSelection());
    }
    this.mesh = component ? component.source : null;
    this.topo = this.mesh ? buildTopology(this.mesh) : null;
    if (this.mesh) {
      const sel = state.selection.get();
      const clean = sanitizeSelection(this.mesh, sel);
      if (
        clean.vertices.length !== sel.vertices.length ||
        clean.edges.length !== sel.edges.length ||
        clean.faces.length !== sel.faces.length
      ) {
        state.selection.set(clean);
      }
      state.stats.set({ vertices: this.mesh.vertices.length, edges: this.topo!.edges.length, faces: this.mesh.faces.length });
    } else {
      state.stats.set(null);
    }
    this.refreshOverlay();
    this.syncGizmo();
  }

  private polyMeshObject(): THREE.Mesh | null {
    const group = this.entityId ? this.opts.getObject(this.entityId) : undefined;
    if (!group) return null;
    let found: THREE.Mesh | null = null;
    group.traverse((node) => {
      if (!found && (node as THREE.Mesh).isMesh && node.userData["polyMesh"]) found = node as THREE.Mesh;
    });
    return found;
  }

  // ---------------------------------------------------------------- overlays

  private disposeOverlay(): void {
    for (const child of [...this.overlay.children]) {
      const mesh = child as THREE.Mesh;
      mesh.geometry?.dispose();
      const material = mesh.material as THREE.Material | THREE.Material[] | undefined;
      if (Array.isArray(material)) material.forEach((m) => m.dispose());
      else material?.dispose();
      this.overlay.remove(child);
    }
    this.points = null;
    this.wire = null;
    this.selectedEdges = null;
    this.hoverEdge = null;
    this.faceFill = null;
    this.hoverFill = null;
  }

  private refreshOverlay(): void {
    this.disposeOverlay();
    this.overlay.removeFromParent();
    const group = this.entityId ? this.opts.getObject(this.entityId) : undefined;
    if (!this.isEditing || !this.mesh || !this.topo || !group) return;
    group.add(this.overlay);
    const mesh = this.mesh;
    const topo = this.topo;
    const mode = this.opts.state.mode.get();
    // never trust the published selection blindly — an undo/redo or an external
    // file edit can leave it pointing past the end of the current mesh
    const sel = sanitizeSelection(mesh, this.opts.state.selection.get());

    // wireframe (all edges), depth-tested so hidden edges read as hidden
    const wirePositions = new Float32Array(topo.edges.length * 6);
    topo.edges.forEach(([a, b], i) => {
      wirePositions.set(mesh.vertices[a]!, i * 6);
      wirePositions.set(mesh.vertices[b]!, i * 6 + 3);
    });
    const wireGeometry = new THREE.BufferGeometry();
    wireGeometry.setAttribute("position", new THREE.BufferAttribute(wirePositions, 3));
    this.wire = new THREE.LineSegments(
      wireGeometry,
      new THREE.LineBasicMaterial({ color: COLORS.edge, transparent: true, opacity: 0.9, depthTest: true }),
    );
    this.wire.renderOrder = 990;
    this.overlay.add(this.wire);

    // vertex dots (vertex mode only). Not THREE.Points: under the WebGL
    // backend of WebGPURenderer points draw at 1px regardless of size, so the
    // dots are camera-facing quads whose scale is recomputed every frame in
    // onBeforeRender to stay a constant ~9px on screen.
    if (mode === "vertex") {
      const selected = new Set(sel.vertices);
      const dots = new THREE.InstancedMesh(
        new THREE.PlaneGeometry(1, 1),
        new THREE.MeshBasicMaterial({ depthTest: false, transparent: true, side: THREE.DoubleSide }),
        mesh.vertices.length,
      );
      dots.frustumCulled = false;
      const color = new THREE.Color();
      mesh.vertices.forEach((_, i) => {
        const c = selected.has(i) ? COLORS.selected : this.hover?.kind === "vertex" && this.hover.index === i ? COLORS.hover : COLORS.vertex;
        dots.setColorAt(i, color.copy(c));
      });
      if (dots.instanceColor) dots.instanceColor.needsUpdate = true;
      dots.userData["vertexPositions"] = mesh.vertices.map((v) => [...v] as Vec3);
      dots.onBeforeRender = (renderer, _scene, camera) =>
        this.layoutDots(dots, renderer as unknown as THREE.WebGPURenderer, camera as THREE.PerspectiveCamera);
      dots.renderOrder = 1001;
      this.points = dots;
      this.overlay.add(dots);
    }

    // selected edges (fat lines, always visible)
    const edgeList: EdgeKey[] =
      mode === "edge" ? sel.edges : mode === "vertex" ? [] : mode === "face" ? [] : [];
    if (edgeList.length > 0) {
      this.selectedEdges = this.fatLines(mesh, edgeList, COLORS.selected, 3);
      this.overlay.add(this.selectedEdges);
    }
    if (this.hover?.kind === "edge" && this.hover.edge) {
      this.hoverEdge = this.fatLines(mesh, [this.hover.edge], COLORS.hover, 3);
      this.overlay.add(this.hoverEdge);
    }

    // selected / hovered face fill
    const faceList = mode === "face" ? sel.faces : [];
    if (faceList.length > 0) {
      this.faceFill = this.faceMesh(mesh, faceList, COLORS.selected, 0.35);
      this.overlay.add(this.faceFill);
    }
    if (this.hover?.kind === "face") {
      this.hoverFill = this.faceMesh(mesh, [this.hover.index], COLORS.hover, 0.25);
      this.overlay.add(this.hoverFill);
    }
    // in vertex/edge mode, faces implied by the selection get a faint fill too
    if (mode !== "face") {
      const implied = this.facesOfSelection(mesh, sel);
      if (implied.length > 0) {
        const fill = this.faceMesh(mesh, implied, COLORS.selected, 0.12);
        this.overlay.add(fill);
      }
    }
    // smoothing preview: one translucent tint per nonzero group (hard faces stay untinted)
    if (this.opts.state.showSmoothing.get()) {
      const groups = new Map<number, number[]>();
      mesh.faces.forEach((f, i) => {
        const g = f.smooth ?? 0;
        if (g === 0) return;
        const list = groups.get(g);
        if (list) list.push(i);
        else groups.set(g, [i]);
      });
      for (const [g, faces] of groups) {
        const color = new THREE.Color().setHSL(((g * 0.61803) % 1), 0.7, 0.55);
        this.overlay.add(this.faceMesh(mesh, faces, color, 0.3));
      }
    }
  }

  /** Per-frame: face every dot at the camera and size it to DOT_PX pixels. */
  private layoutDots(dots: THREE.InstancedMesh, renderer: THREE.WebGPURenderer, camera: THREE.PerspectiveCamera): void {
    const positions = dots.userData["vertexPositions"] as Vec3[] | undefined;
    if (!positions) return;
    const group = dots.parent?.parent; // overlay -> entity group
    if (!group) return;
    group.updateWorldMatrix(true, false);
    const size = renderer.getSize(scratchSize);
    const worldPerPx = (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2)) / Math.max(1, size.y);
    scratchGroupQuat.setFromRotationMatrix(group.matrixWorld).invert();
    scratchCamQuat.copy(camera.quaternion).premultiply(scratchGroupQuat); // camera facing, in group space
    scratchGroupScale.setFromMatrixScale(group.matrixWorld);
    const invScale = 1 / Math.max(1e-6, (Math.abs(scratchGroupScale.x) + Math.abs(scratchGroupScale.y) + Math.abs(scratchGroupScale.z)) / 3);
    for (let i = 0; i < positions.length; i++) {
      scratchPos.set(...positions[i]!);
      scratchWorld.copy(scratchPos).applyMatrix4(group.matrixWorld);
      const dist = scratchWorld.distanceTo(camera.position);
      const s = DOT_PX * dist * worldPerPx * invScale;
      scratchScale.set(s, s, s);
      scratchMatrix.compose(scratchPos, scratchCamQuat, scratchScale);
      dots.setMatrixAt(i, scratchMatrix);
    }
    dots.instanceMatrix.needsUpdate = true;
  }

  private fatLines(mesh: PolyMesh, edges: EdgeKey[], color: THREE.Color, width: number): LineSegments2 {
    const positions: number[] = [];
    for (const [a, b] of edges) positions.push(...mesh.vertices[a]!, ...mesh.vertices[b]!);
    const geometry = new LineSegmentsGeometry();
    geometry.setPositions(positions);
    const material = new THREE.Line2NodeMaterial({ color, linewidth: width, worldUnits: false, depthTest: false, transparent: true });
    const rect = this.opts.canvas.getBoundingClientRect();
    (material as unknown as { resolution: THREE.Vector2 }).resolution = new THREE.Vector2(rect.width, rect.height);
    const lines = new LineSegments2(geometry, material);
    lines.renderOrder = 1000;
    return lines;
  }

  private faceMesh(mesh: PolyMesh, faces: number[], color: THREE.Color, opacity: number): THREE.Mesh {
    const sub: PolyMesh = { ...mesh, faces: faces.map((fi) => mesh.faces[fi]!).filter(Boolean) };
    const compiled = compilePolyMesh(sub);
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(compiled.positions, 3));
    geometry.setIndex(new THREE.BufferAttribute(compiled.indices, 1));
    const material = new THREE.MeshBasicMaterial({
      color,
      transparent: true,
      opacity,
      depthWrite: false,
      side: THREE.DoubleSide,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
    });
    const out = new THREE.Mesh(geometry, material);
    out.renderOrder = 995;
    return out;
  }

  /** Positions-only refresh during a drag (cheaper than a full rebuild). */
  private refreshOverlayPositions(mesh: PolyMesh): void {
    if (!this.topo) return;
    const wire = this.wire?.geometry.getAttribute("position") as THREE.BufferAttribute | undefined;
    if (wire) {
      this.topo.edges.forEach(([a, b], i) => {
        wire.setXYZ(i * 2, ...mesh.vertices[a]!);
        wire.setXYZ(i * 2 + 1, ...mesh.vertices[b]!);
      });
      wire.needsUpdate = true;
    }
    if (this.points) this.points.userData["vertexPositions"] = mesh.vertices.map((v) => [...v] as Vec3);
    const sel = this.opts.state.selection.get();
    const mode = this.opts.state.mode.get();
    if (this.selectedEdges && mode === "edge") {
      const positions: number[] = [];
      for (const [a, b] of sel.edges) positions.push(...mesh.vertices[a]!, ...mesh.vertices[b]!);
      (this.selectedEdges.geometry as LineSegmentsGeometry).setPositions(positions);
    }
    if (this.faceFill && mode === "face") {
      const sub: PolyMesh = { ...mesh, faces: sel.faces.map((fi) => mesh.faces[fi]!).filter(Boolean) };
      const compiled = compilePolyMesh(sub);
      this.faceFill.geometry.dispose();
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute("position", new THREE.BufferAttribute(compiled.positions, 3));
      geometry.setIndex(new THREE.BufferAttribute(compiled.indices, 1));
      this.faceFill.geometry = geometry;
    }
  }

  // ---------------------------------------------------------------- gizmo

  private syncGizmo(): void {
    if (this.drag) return;
    const group = this.entityId ? this.opts.getObject(this.entityId) : undefined;
    const sel = this.mesh ? sanitizeSelection(this.mesh, this.opts.state.selection.get()) : emptyElementSelection();
    const verts = this.mesh ? selectionVertices(this.mesh, sel) : [];
    if (!this.isEditing || !this.mesh || !group || verts.length === 0) {
      this.controls.detach();
      this.proxy.removeFromParent();
      return;
    }
    group.updateWorldMatrix(true, false);
    const centerLocal = selectionCentroid(this.mesh, sel);
    const world = new THREE.Vector3(...centerLocal).applyMatrix4(group.matrixWorld);
    this.proxy.position.copy(world);
    this.proxy.scale.set(1, 1, 1);
    const orientation = this.opts.state.orientation.get();
    if (orientation === "global") {
      this.proxy.quaternion.identity();
      this.controls.space = "world";
    } else if (orientation === "local") {
      this.proxy.quaternion.copy(group.getWorldQuaternion(new THREE.Quaternion()));
      this.controls.space = "local";
    } else {
      const n = new THREE.Vector3(...selectionNormal(this.mesh, sel, this.topo!)).transformDirection(group.matrixWorld);
      // align the gizmo's Y axis with the selection normal
      this.proxy.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), n.normalize());
      this.controls.space = "local";
    }
    if (!this.proxy.parent) this.opts.getScene().add(this.proxy);
    this.controls.setMode(this.opts.gizmoMode.get());
    this.controls.attach(this.proxy);
  }

  private beginDrag(): void {
    if (!this.mesh || !this.entityId) return;
    const group = this.opts.getObject(this.entityId);
    if (!group) return;
    let mesh = this.mesh;
    let sel = this.opts.state.selection.get();
    const mode = this.opts.state.mode.get();
    // Shift + drag = extrude first, then move the fresh elements (ProBuilder)
    if (this.pointerDown?.shift && mode === "face" && sel.faces.length > 0) {
      const r = extrudeFaces(mesh, sel.faces, 0, this.opts.state.params.get().extrudeMethod);
      mesh = r.mesh;
      sel = { ...emptyElementSelection(), faces: r.selection.faces };
      this.opts.state.selection.set(sel);
    } else if (this.pointerDown?.shift && mode === "edge" && sel.edges.length > 0) {
      const r = extrudeEdges(mesh, sel.edges, 0);
      if (r.selection.edges.length > 0) {
        mesh = r.mesh;
        sel = { ...emptyElementSelection(), edges: r.selection.edges };
        this.opts.state.selection.set(sel);
      }
    }
    const vertices = selectionVertices(mesh, sel);
    const start = new Map<number, Vec3>();
    for (const v of vertices) start.set(v, [...mesh.vertices[v]!] as Vec3);
    group.updateWorldMatrix(true, false);
    this.proxy.updateMatrixWorld(true);
    this.drag = {
      vertices,
      start,
      proxyStartInverse: this.proxy.matrixWorld.clone().invert(),
      entityMatrix: group.matrixWorld.clone(),
      entityInverse: group.matrixWorld.clone().invert(),
      working: mesh,
    };
    if (mesh !== this.mesh) {
      // the extrude changed topology: rebuild handles for the new mesh
      this.mesh = mesh;
      this.topo = buildTopology(mesh);
      this.refreshOverlay();
      this.applyPreview(mesh);
    }
  }

  private updateDrag(): void {
    if (!this.drag || !this.mesh) return;
    this.proxy.updateMatrixWorld(true);
    const deltaWorld = new THREE.Matrix4().multiplyMatrices(this.proxy.matrixWorld, this.drag.proxyStartInverse);
    const deltaLocal = new THREE.Matrix4()
      .multiplyMatrices(this.drag.entityInverse, deltaWorld)
      .multiply(this.drag.entityMatrix);
    const m = deltaLocal.elements;
    const start = this.drag.start;
    const working = transformVertices(this.drag.working, this.drag.vertices, (_p, i) => {
      const s = start.get(i)!;
      const v = new THREE.Vector3(s[0], s[1], s[2]).applyMatrix4(deltaLocal);
      void m;
      return [v.x, v.y, v.z];
    });
    this.drag.working = working;
    this.applyPreview(working);
    this.refreshOverlayPositions(working);
  }

  /** Swap the rendered geometry for a compiled preview of `mesh` (doc untouched). */
  private applyPreview(mesh: PolyMesh): void {
    const object = this.polyMeshObject();
    if (!object) return;
    const compiled = compilePolyMesh(mesh);
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(compiled.positions, 3));
    geometry.setAttribute("normal", new THREE.BufferAttribute(compiled.normals, 3));
    geometry.setAttribute("uv", new THREE.BufferAttribute(compiled.uvs, 2));
    if (compiled.colors) geometry.setAttribute("color", new THREE.BufferAttribute(compiled.colors, 3));
    geometry.setIndex(new THREE.BufferAttribute(compiled.indices, 1));
    for (const g of compiled.groups) geometry.addGroup(g.start, g.count, g.materialIndex);
    geometry.userData["triangleFace"] = compiled.triangleFace;
    geometry.computeBoundingSphere();
    object.geometry.dispose();
    object.geometry = geometry;
  }

  private endDrag(): void {
    if (!this.drag) return;
    const { working, start } = this.drag;
    const moved = this.drag.vertices.some((v) => {
      const a = start.get(v)!;
      const b = working.vertices[v]!;
      return Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]) > 1e-7;
    });
    const originalMesh = this.polyComponent(this.entityId)?.source ?? null;
    const topologyChanged = originalMesh !== null && originalMesh.faces.length !== working.faces.length;
    this.drag = null;
    if (moved || topologyChanged) {
      this.commit(working, this.opts.state.selection.get());
    } else {
      // nothing changed: restore the doc's geometry (an aborted shift-drag)
      this.mesh = originalMesh;
      this.topo = this.mesh ? buildTopology(this.mesh) : null;
      if (this.mesh) this.applyPreview(this.mesh);
      this.sync();
    }
  }

  // ---------------------------------------------------------------- commit

  /** Write `mesh` into the entity's mesh component (one undoable op) and adopt `selection`. */
  commit(mesh: PolyMesh, selection: ElementSelection, extraOps: Op[] = []): void {
    const id = this.entityId;
    const component = this.polyComponent(id);
    if (!id || !component) return;
    const rounded: PolyMesh = { ...mesh, vertices: mesh.vertices.map((v) => [r6(v[0]), r6(v[1]), r6(v[2])] as Vec3) };
    const ops: Op[] = [{ op: "set-component", id, component: "mesh", data: { ...component, source: rounded } }];
    // keep a sized box collider hugging the mesh
    const collider = this.opts.store.doc.entities[id]?.components["collider"] as
      | { shape?: string; size?: Vec3; offset?: Vec3 }
      | undefined;
    if (collider && collider.shape === "box") {
      const b = polyMeshBounds(rounded);
      ops.push({
        op: "set-component",
        id,
        component: "collider",
        data: {
          ...collider,
          size: [Math.max(0.01, b.max[0] - b.min[0]), Math.max(0.01, b.max[1] - b.min[1]), Math.max(0.01, b.max[2] - b.min[2])],
          offset: b.center,
        },
      });
    }
    ops.push(...extraOps);
    try {
      this.opts.store.apply(ops);
    } catch (error) {
      console.warn("[mesh-edit] commit rejected:", error);
      this.sync();
      return;
    }
    // adopt the new mesh BEFORE publishing the selection: the selection
    // subscribers redraw handles/gizmo synchronously, and the new indices only
    // mean anything against the new mesh (the store-change resync is a microtask)
    this.mesh = this.polyComponent(id)?.source ?? rounded;
    this.topo = buildTopology(this.mesh);
    this.opts.state.selection.set(sanitizeSelection(this.mesh, selection));
  }

  // ---------------------------------------------------------------- selection derivation

  /** Faces implied by the current selection in any mode. */
  private facesOfSelection(mesh: PolyMesh, sel: ElementSelection): number[] {
    const mode = this.opts.state.mode.get();
    if (mode === "face") return sel.faces;
    if (mode === "vertex") {
      const set = new Set(sel.vertices);
      if (set.size === 0) return [];
      return mesh.faces.map((f, i) => (f.v.every((v) => set.has(v)) ? i : -1)).filter((i) => i >= 0);
    }
    const ids = new Set(sel.edges.map((e) => edgeId(e[0], e[1])));
    if (ids.size === 0) return [];
    return mesh.faces.map((f, i) => (faceEdges(f).every((e) => ids.has(edgeId(e[0], e[1]))) ? i : -1)).filter((i) => i >= 0);
  }

  /** Edges implied by the current selection. */
  private edgesOfSelection(mesh: PolyMesh, sel: ElementSelection): EdgeKey[] {
    const mode = this.opts.state.mode.get();
    if (mode === "edge") return sel.edges;
    if (mode === "face") return facesEdges(mesh, sel.faces);
    const set = new Set(sel.vertices);
    if (!this.topo) return [];
    return this.topo.edges.filter(([a, b]) => set.has(a) && set.has(b));
  }

  private current(): { mesh: PolyMesh; topo: Topology; sel: ElementSelection; faces: number[]; edges: EdgeKey[]; vertices: number[] } | null {
    if (!this.mesh || !this.topo) return null;
    const sel = sanitizeSelection(this.mesh, this.opts.state.selection.get());
    return {
      mesh: this.mesh,
      topo: this.topo,
      sel,
      faces: this.facesOfSelection(this.mesh, sel),
      edges: this.edgesOfSelection(this.mesh, sel),
      vertices: selectionVertices(this.mesh, sel),
    };
  }

  private setSelection(next: Partial<ElementSelection>): void {
    const mode = this.opts.state.mode.get();
    const sel: ElementSelectionState = { ...emptyElementSelection(), ...next };
    // keep the selection expressed in the CURRENT mode's element type
    if (mode === "vertex" && sel.vertices.length === 0 && this.mesh) sel.vertices = selectionVertices(this.mesh, sel);
    this.opts.state.selection.set(sel);
  }

  // ---------------------------------------------------------------- actions

  /** Run a named element action with the state's default params (or overrides). */
  run(action: MeshAction, overrides: Partial<{ distance: number; amount: number; slot: number; materialId: string; color: string | null; group: number; angle: number; offset: Vec3 }> = {}): void {
    const cur = this.current();
    if (!cur || !this.entityId) return;
    const p = this.opts.state.params.get();
    const { mesh, topo, sel, faces, edges, vertices } = cur;
    const mode = this.opts.state.mode.get();
    const commitFaces = (r: { mesh: PolyMesh; selection: ElementSelection }) => this.commitWithMode(r.mesh, r.selection);

    switch (action) {
      case "extrude": {
        if (mode === "edge" || (faces.length === 0 && edges.length > 0)) {
          commitFaces(extrudeEdges(mesh, edges, overrides.distance ?? p.extrudeDistance));
        } else if (faces.length > 0) {
          commitFaces(extrudeFaces(mesh, faces, overrides.distance ?? p.extrudeDistance, p.extrudeMethod as ExtrudeMethod));
        }
        return;
      }
      case "inset":
        if (faces.length > 0) commitFaces(insetFaces(mesh, faces, overrides.amount ?? p.insetAmount));
        return;
      case "bevel":
        if (edges.length > 0) commitFaces(bevelEdges(mesh, edges, overrides.amount ?? p.bevelAmount));
        return;
      case "subdivide":
        if (faces.length > 0) commitFaces(subdivideFaces(mesh, faces));
        else if (edges.length > 0) commitFaces(subdivideEdges(mesh, edges));
        return;
      case "connect":
        if (mode === "vertex" && vertices.length >= 2) commitFaces(connectVertices(mesh, vertices));
        else if (edges.length >= 2) commitFaces(connectEdges(mesh, edges));
        return;
      case "insert-loop": {
        const edge = sel.edges[0] ?? edges[0];
        if (edge) commitFaces(insertEdgeLoop(mesh, edge, p.loopPosition));
        return;
      }
      case "delete":
        if (mode === "face" && faces.length > 0) commitFaces(deleteFaces(mesh, faces));
        else if (mode === "edge" && edges.length > 0) commitFaces(deleteEdges(mesh, edges));
        else if (mode === "vertex" && vertices.length > 0) commitFaces(deleteVertices(mesh, vertices));
        return;
      case "collapse":
        if (vertices.length >= 2) commitFaces(collapseVertices(mesh, vertices));
        return;
      case "weld":
        commitFaces(weldVertices(mesh, vertices, overrides.amount ?? p.weldDistance));
        return;
      case "split":
        if (vertices.length > 0) commitFaces(splitVertices(mesh, vertices));
        return;
      case "detach":
        if (faces.length > 0) commitFaces(detachFaces(mesh, faces));
        return;
      case "detach-to-object":
        if (faces.length > 0) this.detachToObject(mesh, faces);
        return;
      case "duplicate":
        if (faces.length > 0) commitFaces(duplicateFaces(mesh, faces));
        return;
      case "flip":
        commitFaces(flipFaces(mesh, faces.length > 0 ? faces : mesh.faces.map((_, i) => i)));
        return;
      case "conform":
        commitFaces(conformNormals(mesh, faces));
        return;
      case "merge":
        if (faces.length >= 2) commitFaces(mergeFaces(mesh, faces));
        return;
      case "triangulate":
        commitFaces(triangulateFaces(mesh, faces.length > 0 ? faces : mesh.faces.map((_, i) => i)));
        return;
      case "bridge":
        if (edges.length === 2) commitFaces(bridgeEdges(mesh, edges[0]!, edges[1]!));
        return;
      case "fill":
        commitFaces(fillHoles(mesh, { vertices: vertices }));
        return;
      case "flip-edge":
        if (edges.length === 1) commitFaces(flipEdge(mesh, edges[0]!));
        return;
      case "grow": {
        const angle = p.growLimitAngle ? (overrides.angle ?? p.growAngle) : undefined;
        if (mode === "face") this.setSelection({ faces: growFaces(mesh, topo, faces, angle) });
        else if (mode === "edge") this.setSelection({ edges: facesEdges(mesh, edgesFaces(topo, edges)) });
        else {
          const set = new Set(vertices);
          for (const v of vertices) for (const n of topo.vertexNeighbors[v] ?? []) set.add(n);
          this.setSelection({ vertices: [...set].sort((a, b) => a - b) });
        }
        return;
      }
      case "shrink":
        if (mode === "face") this.setSelection({ faces: shrinkFaces(mesh, topo, faces) });
        else if (mode === "edge") {
          // keep edges whose both faces are fully inside the selection
          const ids = new Set(edges.map((e) => edgeId(e[0], e[1])));
          this.setSelection({
            edges: edges.filter(([a, b]) =>
              (topo.edgeFaces.get(edgeId(a, b)) ?? []).every((f) => faceEdges(mesh.faces[f]!).every((e) => ids.has(edgeId(e[0], e[1])))),
            ),
          });
        } else {
          const set = new Set(vertices);
          this.setSelection({ vertices: vertices.filter((v) => (topo.vertexNeighbors[v] ?? []).every((n) => set.has(n))) });
        }
        return;
      case "loop": {
        const out = new Map<string, EdgeKey>();
        for (const e of edges) for (const l of edgeLoop(mesh, topo, e)) out.set(edgeId(l[0], l[1]), l);
        if (out.size > 0) {
          this.opts.state.mode.set("edge");
          this.setSelection({ edges: [...out.values()] });
        }
        return;
      }
      case "ring": {
        const out = new Map<string, EdgeKey>();
        for (const e of edges) for (const l of edgeRing(mesh, topo, e)) out.set(edgeId(l[0], l[1]), l);
        if (out.size > 0) {
          this.opts.state.mode.set("edge");
          this.setSelection({ edges: [...out.values()] });
        }
        return;
      }
      case "select-all":
        if (mode === "face") this.setSelection({ faces: mesh.faces.map((_, i) => i) });
        else if (mode === "edge") this.setSelection({ edges: [...topo.edges] });
        else this.setSelection({ vertices: mesh.vertices.map((_, i) => i) });
        return;
      case "select-none":
        this.setSelection({});
        return;
      case "invert":
        if (mode === "face") {
          const set = new Set(faces);
          this.setSelection({ faces: mesh.faces.map((_, i) => i).filter((i) => !set.has(i)) });
        } else if (mode === "edge") {
          const set = new Set(edges.map((e) => edgeId(e[0], e[1])));
          this.setSelection({ edges: topo.edges.filter((e) => !set.has(edgeId(e[0], e[1]))) });
        } else {
          const set = new Set(vertices);
          this.setSelection({ vertices: mesh.vertices.map((_, i) => i).filter((i) => !set.has(i)) });
        }
        return;
      case "select-connected":
        this.opts.state.mode.set("face");
        this.setSelection({ faces: connectedFaces(mesh, topo, faces.length > 0 ? faces : edgesFaces(topo, edges)) });
        return;
      case "select-coplanar":
        this.opts.state.mode.set("face");
        this.setSelection({ faces: coplanarFaces(mesh, topo, faces.length > 0 ? faces : edgesFaces(topo, edges), overrides.angle ?? 1) });
        return;
      case "select-material": {
        const slots = new Set(faces.map((f) => mesh.faces[f]!.mat ?? 0));
        if (slots.size === 0) return;
        this.opts.state.mode.set("face");
        this.setSelection({ faces: mesh.faces.map((f, i) => (slots.has(f.mat ?? 0) ? i : -1)).filter((i) => i >= 0) });
        return;
      }
      case "select-hole": {
        const open = topo.edges.filter(([a, b]) => (topo.edgeFaces.get(edgeId(a, b))?.length ?? 0) === 1);
        this.opts.state.mode.set("edge");
        this.setSelection({ edges: open });
        return;
      }
      case "smooth": {
        const target = faces.length > 0 ? faces : mesh.faces.map((_, i) => i);
        const group = overrides.group ?? nextSmoothingGroup(mesh);
        this.commitWithMode(setSmoothingGroup(mesh, target, group), sel);
        return;
      }
      case "harden":
        this.commitWithMode(setSmoothingGroup(mesh, faces.length > 0 ? faces : mesh.faces.map((_, i) => i), 0), sel);
        return;
      case "center-pivot":
      case "floor-pivot":
        this.rePivot(centerPivot(mesh, action === "center-pivot" ? "center" : "bottom"));
        return;
      case "pivot-to-selection":
        if (vertices.length > 0) this.rePivot(setPivot(mesh, selectionCentroid(mesh, sel)));
        return;
      case "offset": {
        // numeric nudge of the selected elements in LOCAL units (the panel's x/y/z fields)
        const d = overrides.offset ?? [0, 0, 0];
        if (vertices.length > 0 && (d[0] !== 0 || d[1] !== 0 || d[2] !== 0)) {
          this.commitWithMode(translateVertices(mesh, vertices, d), sel);
        }
        return;
      }
      case "snap-to-grid": {
        // round the selected (or every) vertex to the editor's translate snap, in local space
        const step = this.opts.settings.get().translateSnap || 0.5;
        const target = vertices.length > 0 ? vertices : mesh.vertices.map((_, i) => i);
        this.commitWithMode(
          transformVertices(mesh, target, (p) => [Math.round(p[0] / step) * step, Math.round(p[1] / step) * step, Math.round(p[2] / step) * step]),
          sel,
        );
        return;
      }
      case "select-smoothing": {
        const groups = new Set(faces.map((f) => mesh.faces[f]!.smooth ?? 0));
        if (groups.size === 0) return;
        this.opts.state.mode.set("face");
        this.setSelection({ faces: mesh.faces.map((f, i) => (groups.has(f.smooth ?? 0) ? i : -1)).filter((i) => i >= 0) });
        return;
      }
      case "freeze-transform":
        this.freezeTransform(mesh);
        return;
      case "mirror-x":
      case "mirror-y":
      case "mirror-z":
        commitFaces(mirror(mesh, action.slice(-1) as "x" | "y" | "z", true));
        return;
    }
  }

  /** Assign a material asset to the selected faces (creating a slot as needed). */
  setMaterial(materialId: string): void {
    const cur = this.current();
    if (!cur) return;
    const target = cur.faces.length > 0 ? cur.faces : cur.mesh.faces.map((_, i) => i);
    let mesh = cur.mesh;
    let slot = 0;
    if (materialId) {
      const r = ensureMaterialSlot(mesh, materialId);
      mesh = r.mesh;
      slot = r.slot;
    }
    this.commitWithMode(setFaceMaterial(mesh, target, slot), cur.sel);
  }

  /** Tint the selection (null clears): faces in face mode, per-corner vertex paint in vertex/edge mode (ProBuilder vertex colors). */
  setColor(color: string | null): void {
    const cur = this.current();
    if (!cur) return;
    const mode = this.opts.state.mode.get();
    if ((mode === "vertex" || mode === "edge") && cur.vertices.length > 0) {
      this.commitWithMode(setVertexColor(cur.mesh, cur.vertices, color), cur.sel);
      return;
    }
    const target = cur.faces.length > 0 ? cur.faces : cur.mesh.faces.map((_, i) => i);
    this.commitWithMode(setFaceColor(cur.mesh, target, color), cur.sel);
  }

  /**
   * CSG between the active selection (A) and the other selected entity (B).
   * A's mesh becomes the result (an editable poly mesh, in A's frame) and B
   * is removed — one undoable batch. Either side may be any mesh kind.
   */
  boolean(op: BooleanOp): void {
    const a = this.opts.selection.get();
    const others = (this.opts.multiSelection?.get() ?? []).filter((id) => id !== a);
    const b = others[others.length - 1];
    if (!a || !b) {
      console.warn("[mesh-edit] boolean needs two selected entities (active = A, the other = B)");
      return;
    }
    const objA = this.opts.getObject(a);
    const objB = this.opts.getObject(b);
    const entityA = this.opts.store.doc.entities[a];
    if (!objA || !objB || !entityA) return;
    const result = booleanMeshes(
      { source: this.polyComponent(a)?.source ?? null, object: objA },
      { source: this.polyComponent(b)?.source ?? null, object: objB },
      op,
    );
    if (!result) {
      console.warn("[mesh-edit] boolean produced no geometry");
      return;
    }
    const component = (entityA.components["mesh"] ?? {}) as Record<string, unknown>;
    const { renderMode: _rm, lod: _lod, ...rest } = component;
    const ops: Op[] = [
      { op: "set-component", id: a, component: "mesh", data: { ...rest, source: result } },
      { op: "remove-entity", id: b },
    ];
    const collider = entityA.components["collider"] as { shape?: string } | undefined;
    if (collider && collider.shape !== "trimesh" && collider.shape !== "convex") {
      ops.push({ op: "set-component", id: a, component: "collider", data: { ...collider, shape: "trimesh" } });
    }
    this.opts.state.selection.set(emptyElementSelection());
    try {
      this.opts.store.apply(ops);
      this.opts.selection.set(a);
      this.opts.multiSelection?.set([a]);
    } catch (error) {
      console.warn("[mesh-edit] boolean rejected:", error);
    }
  }

  /** Convert whatever an entity renders (glTF part, path, primitive, polygon) into an editable poly mesh, in place. */
  makeEditable(entityId: string): void {
    const object = this.opts.getObject(entityId);
    const entity = this.opts.store.doc.entities[entityId];
    if (!object || !entity) return;
    if (this.polyComponent(entityId)) return; // already editable
    const mesh = polyFromObject(object);
    if (!mesh) {
      console.warn("[mesh-edit] nothing to convert on", entityId);
      return;
    }
    const component = (entity.components["mesh"] ?? {}) as Record<string, unknown>;
    const { renderMode: _rm, lod: _lod, source: _s, ...rest } = component;
    const ops: Op[] = [{ op: "set-component", id: entityId, component: "mesh", data: { ...rest, source: mesh } }];
    const collider = entity.components["collider"] as { shape?: string } | undefined;
    if (collider && collider.shape !== "trimesh" && collider.shape !== "convex" && collider.shape !== "box") {
      ops.push({ op: "set-component", id: entityId, component: "collider", data: { ...collider, shape: "trimesh" } });
    }
    try {
      this.opts.store.apply(ops);
      this.opts.selection.set(entityId);
      if (this.opts.state.mode.get() === "object") this.opts.state.mode.set("face");
      this.opts.state.active.set(true);
    } catch (error) {
      console.warn("[mesh-edit] make editable rejected:", error);
    }
  }

  /** Move one vertex to an exact local position (the panel's vertex readout). */
  setVertexPosition(vertex: number, position: Vec3): void {
    const cur = this.current();
    if (!cur || !cur.mesh.vertices[vertex]) return;
    this.commitWithMode(transformVertices(cur.mesh, [vertex], () => position), cur.sel);
  }

  /** Commit a mesh + selection, expressed in the current mode's element type. */
  commitWithMode(mesh: PolyMesh, selection: ElementSelection): void {
    const mode = this.opts.state.mode.get();
    let sel: ElementSelection = selection;
    if (mode === "vertex" && selection.vertices.length === 0) sel = { ...emptyElementSelection(), vertices: selectionVertices(mesh, selection) };
    if (mode === "edge" && selection.edges.length === 0 && selection.faces.length > 0) sel = { ...emptyElementSelection(), edges: facesEdges(mesh, selection.faces) };
    if (mode === "face" && selection.faces.length === 0 && (selection.edges.length > 0 || selection.vertices.length > 0)) {
      sel = { ...emptyElementSelection(), faces: this.facesOfSelection(mesh, selection) };
    }
    this.commit(mesh, sel);
  }

  private rePivot(result: { mesh: PolyMesh; offset: Vec3 }): void {
    const id = this.entityId;
    if (!id) return;
    const group = this.opts.getObject(id);
    const transform = (this.opts.store.doc.entities[id]?.components["transform"] ?? {}) as {
      position?: Vec3;
      rotation?: [number, number, number, number];
      scale?: Vec3;
    };
    const offset = new THREE.Vector3(...result.offset);
    if (group) {
      offset.multiply(group.scale).applyQuaternion(group.quaternion);
    }
    const p = transform.position ?? [0, 0, 0];
    this.commit(result.mesh, this.opts.state.selection.get(), [
      {
        op: "set-component",
        id,
        component: "transform",
        data: { ...transform, position: [p[0] + offset.x, p[1] + offset.y, p[2] + offset.z] },
      },
    ]);
  }

  private freezeTransform(mesh: PolyMesh): void {
    const id = this.entityId;
    if (!id) return;
    const group = this.opts.getObject(id);
    if (!group) return;
    const local = new THREE.Matrix4().compose(group.position, group.quaternion, group.scale);
    const baked = bakeTransform(mesh, local.elements);
    const transform = (this.opts.store.doc.entities[id]?.components["transform"] ?? {}) as Record<string, unknown>;
    this.commit(baked, this.opts.state.selection.get(), [
      {
        op: "set-component",
        id,
        component: "transform",
        data: { ...transform, position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] },
      },
    ]);
  }

  private detachToObject(mesh: PolyMesh, faces: number[]): void {
    const id = this.entityId;
    const entity = id ? this.opts.store.doc.entities[id] : undefined;
    const component = this.polyComponent(id);
    if (!id || !entity || !component) return;
    const { detached, remainder } = extractFaces(mesh, faces);
    if (!detached) return;
    const newId_ = newId();
    const ops: Op[] = [
      {
        op: "add-entity",
        id: newId_,
        entity: {
          name: `${entity.name} part`,
          parent: entity.parent,
          tags: [...entity.tags],
          components: {
            transform: structuredClone(entity.components["transform"] ?? {}),
            mesh: { ...component, source: detached },
            ...(entity.components["collider"] ? { collider: { shape: "trimesh" } } : {}),
          },
        },
      },
    ];
    if (remainder) ops.push({ op: "set-component", id, component: "mesh", data: { ...component, source: remainder } });
    else ops.push({ op: "remove-entity", id });
    this.opts.state.selection.set(emptyElementSelection());
    try {
      this.opts.store.apply(ops);
      this.opts.selection.set(newId_);
    } catch (error) {
      console.warn("[mesh-edit] detach rejected:", error);
    }
  }

  // ---------------------------------------------------------------- picking

  private screenOf(local: Vec3, matrixWorld: THREE.Matrix4, rect: DOMRect): { x: number; y: number; z: number; world: THREE.Vector3 } {
    const world = new THREE.Vector3(...local).applyMatrix4(matrixWorld);
    const ndc = world.clone().project(this.opts.camera);
    return {
      x: rect.left + ((ndc.x + 1) / 2) * rect.width,
      y: rect.top + ((1 - ndc.y) / 2) * rect.height,
      z: ndc.z,
      world,
    };
  }

  /** True when `world` is hidden behind the edited mesh itself (for select-hidden off). */
  private occluded(world: THREE.Vector3, object: THREE.Mesh): boolean {
    const origin = this.opts.camera.position;
    const dir = world.clone().sub(origin);
    const dist = dir.length();
    this.raycaster.set(origin, dir.normalize());
    const hits = this.raycaster.intersectObject(object, false);
    return hits.some((h) => h.distance < dist - 1e-3 && h.distance > 1e-4);
  }

  private pickElement(clientX: number, clientY: number): { kind: ElementMode; index: number; edge?: EdgeKey } | null {
    const mode = this.opts.state.mode.get();
    const object = this.polyMeshObject();
    const group = this.entityId ? this.opts.getObject(this.entityId) : undefined;
    if (!this.mesh || !this.topo || !object || !group) return null;
    const rect = this.opts.canvas.getBoundingClientRect();
    group.updateWorldMatrix(true, false);
    const selectHidden = this.opts.state.selectHidden.get();

    if (mode === "face") {
      setRayFromScreen(this.raycaster, this.opts.canvas, this.opts.camera, clientX, clientY);
      const hit = this.raycaster.intersectObject(object, false)[0];
      if (!hit) return null;
      const map = object.geometry.userData["triangleFace"] as Uint32Array | undefined;
      if (!map || hit.faceIndex === undefined || hit.faceIndex === null) return null;
      const face = map[hit.faceIndex];
      return face === undefined ? null : { kind: "face", index: face };
    }

    if (mode === "vertex") {
      let best: { index: number; d: number } | null = null;
      this.mesh.vertices.forEach((v, i) => {
        const s = this.screenOf(v, group.matrixWorld, rect);
        if (s.z > 1) return; // behind the camera
        const d = Math.hypot(s.x - clientX, s.y - clientY);
        if (d > 10 || (best && d >= best.d)) return;
        if (!selectHidden && this.occluded(s.world, object)) return;
        best = { index: i, d };
      });
      return best ? { kind: "vertex", index: (best as { index: number }).index } : null;
    }

    // edge: nearest screen-space segment
    let bestEdge: { edge: EdgeKey; d: number } | null = null;
    for (const edge of this.topo.edges) {
      const a = this.screenOf(this.mesh.vertices[edge[0]]!, group.matrixWorld, rect);
      const b = this.screenOf(this.mesh.vertices[edge[1]]!, group.matrixWorld, rect);
      if (a.z > 1 || b.z > 1) continue;
      const d = pointSegmentDistance(clientX, clientY, a.x, a.y, b.x, b.y);
      if (d > 8 || (bestEdge && d >= bestEdge.d)) continue;
      if (!selectHidden) {
        const mid = a.world.clone().add(b.world).multiplyScalar(0.5);
        if (this.occluded(mid, object)) continue;
      }
      bestEdge = { edge, d };
    }
    return bestEdge ? { kind: "edge", index: -1, edge: (bestEdge as { edge: EdgeKey }).edge } : null;
  }

  private applyPick(pick: { kind: ElementMode; index: number; edge?: EdgeKey } | null, shift: boolean, ctrl: boolean): void {
    const sel = this.opts.state.selection.get();
    const mode = this.opts.state.mode.get();
    if (!pick) {
      if (!shift && !ctrl) this.setSelection({});
      return;
    }
    if (mode === "vertex") {
      const has = sel.vertices.includes(pick.index);
      const next = ctrl
        ? has ? sel.vertices.filter((v) => v !== pick.index) : [...sel.vertices, pick.index]
        : shift ? (has ? sel.vertices : [...sel.vertices, pick.index]) : [pick.index];
      this.setSelection({ vertices: next });
    } else if (mode === "edge" && pick.edge) {
      const id = edgeId(pick.edge[0], pick.edge[1]);
      const has = sel.edges.some((e) => edgeId(e[0], e[1]) === id);
      const next = ctrl
        ? has ? sel.edges.filter((e) => edgeId(e[0], e[1]) !== id) : [...sel.edges, pick.edge]
        : shift ? (has ? sel.edges : [...sel.edges, pick.edge]) : [pick.edge];
      this.setSelection({ edges: next });
    } else if (mode === "face") {
      const has = sel.faces.includes(pick.index);
      const next = ctrl
        ? has ? sel.faces.filter((f) => f !== pick.index) : [...sel.faces, pick.index]
        : shift ? (has ? sel.faces : [...sel.faces, pick.index]) : [pick.index];
      this.setSelection({ faces: next });
    }
  }

  private marqueeSelect(x0: number, y0: number, x1: number, y1: number, shift: boolean, ctrl: boolean): void {
    const group = this.entityId ? this.opts.getObject(this.entityId) : undefined;
    const object = this.polyMeshObject();
    if (!this.mesh || !this.topo || !group || !object) return;
    const rect = this.opts.canvas.getBoundingClientRect();
    group.updateWorldMatrix(true, false);
    const minX = Math.min(x0, x1);
    const maxX = Math.max(x0, x1);
    const minY = Math.min(y0, y1);
    const maxY = Math.max(y0, y1);
    const selectHidden = this.opts.state.selectHidden.get();
    const inside = new Set<number>();
    this.mesh.vertices.forEach((v, i) => {
      const s = this.screenOf(v, group.matrixWorld, rect);
      if (s.z > 1 || s.x < minX || s.x > maxX || s.y < minY || s.y > maxY) return;
      if (!selectHidden && this.occluded(s.world, object)) return;
      inside.add(i);
    });
    const mode = this.opts.state.mode.get();
    const sel = this.opts.state.selection.get();
    const merge = <T,>(current: T[], picked: T[], key: (t: T) => string): T[] => {
      if (ctrl) {
        const pickedKeys = new Set(picked.map(key));
        return current.filter((c) => !pickedKeys.has(key(c)));
      }
      if (shift) {
        const seen = new Set(current.map(key));
        return [...current, ...picked.filter((p) => !seen.has(key(p)))];
      }
      return picked;
    };
    if (mode === "vertex") {
      this.setSelection({ vertices: merge(sel.vertices, [...inside], String) });
    } else if (mode === "edge") {
      const picked = this.topo.edges.filter(([a, b]) => inside.has(a) && inside.has(b));
      this.setSelection({ edges: merge(sel.edges, picked, (e) => edgeId(e[0], e[1])) });
    } else {
      const picked = this.mesh.faces.map((f, i) => (f.v.every((v) => inside.has(v)) ? i : -1)).filter((i) => i >= 0);
      this.setSelection({ faces: merge(sel.faces, picked, String) });
    }
  }

  // ---------------------------------------------------------------- input

  private onPointerDown(e: PointerEvent): void {
    if (!this.isEditing || e.button !== 0) return;
    this.pointerDown = { x: e.clientX, y: e.clientY, shift: e.shiftKey, ctrl: e.ctrlKey, alt: e.altKey };
    const onGizmo = this.controls.dragging || !!(this.controls as unknown as { axis: string | null }).axis;
    // a modified press off the gizmo is a marquee (or an add/toggle click):
    // the camera controls already grabbed this pointer in their own handler,
    // so stand them down NOW — waiting for the first 4px of movement lets the
    // orbit start and the rectangle never appears
    if (!onGizmo && (e.shiftKey || e.ctrlKey)) this.opts.onDraggingChanged?.(true);
  }

  private onPointerMove(e: PointerEvent): void {
    if (!this.isEditing) return;
    if (this.pointerDown && !this.controls.dragging && (this.pointerDown.shift || this.pointerDown.ctrl)) {
      const moved = Math.abs(e.clientX - this.pointerDown.x) + Math.abs(e.clientY - this.pointerDown.y);
      if (!this.marqueeActive && moved > 4) {
        this.marqueeActive = true;
        this.showMarquee();
      }
      if (this.marqueeActive) this.layoutMarquee(this.pointerDown.x, this.pointerDown.y, e.clientX, e.clientY);
      return;
    }
    if (this.pointerDown || this.controls.dragging) return;
    const now = performance.now();
    if (now - this.lastHoverSample < 30) return;
    this.lastHoverSample = now;
    if ((this.controls as unknown as { axis: string | null }).axis) {
      if (this.hover) {
        this.hover = null;
        this.refreshOverlay();
      }
      return;
    }
    const pick = this.pickElement(e.clientX, e.clientY);
    const same =
      (!pick && !this.hover) ||
      (pick && this.hover && pick.kind === this.hover.kind && pick.index === this.hover.index && (pick.edge ? edgeId(pick.edge[0], pick.edge[1]) === (this.hover.edge ? edgeId(this.hover.edge[0], this.hover.edge[1]) : "") : true));
    if (same) return;
    this.hover = pick;
    this.refreshOverlay();
  }

  private onPointerUp(e: PointerEvent): void {
    if (!this.pointerDown) return;
    const down = this.pointerDown;
    this.pointerDown = null;
    // release the camera we stood down on a modified press (no-op otherwise:
    // the gizmo reports its own dragging-changed)
    if ((down.shift || down.ctrl) && !this.controls.dragging) this.opts.onDraggingChanged?.(false);
    if (this.marqueeActive) {
      this.marqueeActive = false;
      this.hideMarquee();
      this.marqueeSelect(down.x, down.y, e.clientX, e.clientY, down.shift, down.ctrl);
      return;
    }
    if (!this.isEditing || this.controls.dragging) return;
    if (e.button !== 0) return;
    const moved = Math.abs(e.clientX - down.x) + Math.abs(e.clientY - down.y);
    if (moved >= 5) return; // an orbit, not a click
    if ((this.controls as unknown as { axis: string | null }).axis) return;
    const pick = this.pickElement(e.clientX, e.clientY);
    if (!pick && !down.shift && !down.ctrl) {
      // clicked off the mesh: another poly entity under the cursor takes over
      setRayFromScreen(this.raycaster, this.opts.canvas, this.opts.camera, e.clientX, e.clientY);
      const hit = this.raycaster
        .intersectObjects(this.opts.getScene().children, true)
        .find((h) => !h.object.userData["physicsDebug"] && !h.object.userData["skyDome"] && !isOverlay(h.object));
      const otherId = hit ? findEntityId(hit.object) : null;
      if (otherId && otherId !== this.entityId && this.polyComponent(otherId)) {
        this.opts.selection.set(otherId);
        return;
      }
    }
    this.applyPick(pick, down.shift, down.ctrl);
  }

  private onDoubleClick(e: MouseEvent): void {
    if (!this.isEditing || !this.mesh || !this.topo) return;
    const pick = this.pickElement(e.clientX, e.clientY);
    if (!pick) return;
    if (pick.kind === "face") {
      this.setSelection({ faces: coplanarFaces(this.mesh, this.topo, [pick.index], 1) });
    } else if (pick.kind === "edge" && pick.edge) {
      this.setSelection({ edges: edgeLoop(this.mesh, this.topo, pick.edge) });
    }
  }

  private onKey(e: KeyboardEvent): void {
    if (isTypingTarget(e.target)) return;
    if (!this.opts.enabled.get()) return;
    const state = this.opts.state;
    // mode keys work whenever a poly mesh is selected (entering edit mode)
    const hasPoly = this.polyComponent(this.opts.selection.get()) !== null;
    if (hasPoly && !e.ctrlKey && !e.altKey && !e.metaKey) {
      const modes: Record<string, ElementMode> = { Digit1: "object", Digit2: "vertex", Digit3: "edge", Digit4: "face" };
      const mode = modes[e.code];
      if (mode) {
        e.preventDefault();
        state.mode.set(mode);
        if (mode !== "object") state.active.set(true);
        return;
      }
    }
    if (!this.isEditing) return;
    const sel = state.selection.get();
    const hasSelection = sel.vertices.length + sel.edges.length + sel.faces.length > 0;
    if (e.code === "Escape") {
      if (this.drag) return;
      if (hasSelection) this.setSelection({});
      else state.mode.set("object");
      return;
    }
    if (e.code === "Delete" || e.code === "Backspace") {
      e.preventDefault();
      this.run("delete");
      return;
    }
    if (e.ctrlKey && e.code === "KeyA") {
      e.preventDefault();
      this.run("select-all");
      return;
    }
    if (e.ctrlKey && e.code === "KeyI") {
      e.preventDefault();
      this.run("invert");
      return;
    }
    if (e.altKey) {
      const map: Record<string, MeshAction> = {
        KeyE: "extrude",
        KeyB: "bevel",
        KeyI: "inset",
        KeyU: "insert-loop",
        KeyC: "connect",
        KeyL: "loop",
        KeyR: "ring",
        KeyS: "subdivide",
        KeyM: "merge",
        KeyW: "weld",
        KeyF: "fill",
      };
      if (e.code === "KeyG") {
        e.preventDefault();
        this.run(e.shiftKey ? "shrink" : "grow");
        return;
      }
      const action = map[e.code];
      if (action) {
        e.preventDefault();
        this.run(action);
      }
    }
  }

  // ---------------------------------------------------------------- marquee DOM

  private showMarquee(): void {
    if (this.marquee) return;
    const div = document.createElement("div");
    Object.assign(div.style, {
      position: "fixed",
      border: "1px solid #79c0ff",
      background: "rgba(121, 192, 255, 0.12)",
      pointerEvents: "none",
      zIndex: "2000",
    } as Partial<CSSStyleDeclaration>);
    document.body.appendChild(div);
    this.marquee = div;
  }

  private layoutMarquee(x0: number, y0: number, x1: number, y1: number): void {
    if (!this.marquee) return;
    this.marquee.style.left = `${Math.min(x0, x1)}px`;
    this.marquee.style.top = `${Math.min(y0, y1)}px`;
    this.marquee.style.width = `${Math.abs(x1 - x0)}px`;
    this.marquee.style.height = `${Math.abs(y1 - y0)}px`;
  }

  private hideMarquee(): void {
    this.marquee?.remove();
    this.marquee = null;
  }

  dispose(): void {
    this.hideMarquee();
    this.disposeOverlay();
    this.overlay.removeFromParent();
    this.proxy.removeFromParent();
    for (const dispose of this.disposers) dispose();
    this.controls.dispose();
  }
}

/** Vertex handle size on screen. */
const DOT_PX = 9;
const scratchSize = new THREE.Vector2();
const scratchGroupQuat = new THREE.Quaternion();
const scratchCamQuat = new THREE.Quaternion();
const scratchGroupScale = new THREE.Vector3();
const scratchPos = new THREE.Vector3();
const scratchWorld = new THREE.Vector3();
const scratchScale = new THREE.Vector3();
const scratchMatrix = new THREE.Matrix4();

/**
 * Only TEXT entry should swallow shortcuts. A checkbox or button that was
 * just clicked keeps focus, and a user who ticks "show groups" then presses
 * Ctrl+A expects select-all-faces, not the browser selecting the page.
 */
export function isTypingTarget(target: EventTarget | null): boolean {
  if (target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement) return true;
  if (target instanceof HTMLInputElement) {
    const type = (target.type || "text").toLowerCase();
    return !["checkbox", "radio", "button", "submit", "range", "color"].includes(type);
  }
  return target instanceof HTMLElement && target.isContentEditable;
}

function r6(v: number): number {
  return Math.round(v * 1e6) / 1e6;
}

function pointSegmentDistance(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  const t = len2 > 0 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2)) : 0;
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

function isOverlay(object: THREE.Object3D): boolean {
  let node: THREE.Object3D | null = object;
  while (node) {
    if (node.userData["editorOverlay"]) return true;
    node = node.parent;
  }
  return false;
}

function findEntityId(object: THREE.Object3D): string | null {
  let node: THREE.Object3D | null = object;
  while (node) {
    const id = node.userData["entityId"] as string | undefined;
    if (id) return id.split(":")[0]!;
    node = node.parent;
  }
  return null;
}

export { edgeKey as meshEdgeKey };

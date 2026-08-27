import * as THREE from "three/webgpu";
import {
  buildShape,
  buildTopology,
  compilePolyMesh,
  newId,
  polyFromFootprint,
  polyMeshBounds,
  transformVertices,
  type PolyMesh,
  type SceneStore,
  type ShapeParams,
} from "@hitreg/core";
import type { EditorSettings, GrayboxShape, Observable, Selection } from "./state.js";

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
  /** Shape drawn by the draw gesture. */
  shape: Observable<GrayboxShape>;
  /** Bevel size applied to drawn boxes/polys (0 = off). */
  bevel: Observable<number>;
  /** Material asset GUID stamped onto newly-drawn shapes ("" = engine default). */
  material?: Observable<string>;
  /**
   * Commit drawn shapes as EDITABLE poly meshes (vertex/edge/face editing,
   * UVs, per-face materials). Off = the historic sized primitives for
   * box/cylinder/sphere/wedge (cheaper analytic colliders, not editable).
   */
  editable?: Observable<boolean>;
  getScene(): THREE.Scene;
  onDraggingChanged?(dragging: boolean): void;
}

type Vec3 = [number, number, number];

interface MeshComponentData {
  source: { kind: string; shape?: string; size?: Vec3 } | PolyMesh;
  [k: string]: unknown;
}

type Phase =
  | { kind: "idle" }
  | { kind: "footprint"; base: THREE.Vector3; corner: THREE.Vector3; preview: THREE.Mesh }
  | { kind: "height"; base: THREE.Vector3; corner: THREE.Vector3; h: number; preview: THREE.Mesh }
  | { kind: "poly-points"; baseY: number; points: THREE.Vector3[]; line: THREE.Line }
  | { kind: "poly-height"; baseY: number; points: THREE.Vector3[]; h: number; preview: THREE.Mesh }
  | {
      kind: "face";
      entityId: string;
      group: THREE.Object3D;
      meshChild: THREE.Object3D;
      mode: "extent" | "radial";
      axis: 0 | 1 | 2;
      lineOrigin: THREE.Vector3;
      lineDir: THREE.Vector3;
      size: Vec3;
      delta: number;
      groupPos0: THREE.Vector3;
    }
  | {
      /** Push/pull one face of an editable mesh along its normal (Alt = pull a new block out instead). */
      kind: "poly-face";
      entityId: string;
      meshChild: THREE.Mesh;
      mesh: PolyMesh;
      face: number;
      normalLocal: THREE.Vector3;
      lineOrigin: THREE.Vector3;
      lineDir: THREE.Vector3;
      delta: number;
      extrude: boolean;
      preview: THREE.Mesh | null;
    }
  | {
      kind: "extrude";
      axis: 0 | 1 | 2;
      lineOrigin: THREE.Vector3;
      lineDir: THREE.Vector3;
      size: Vec3;
      delta: number;
      center: THREE.Vector3;
      rotation: THREE.Quaternion;
      preview: THREE.Mesh;
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

function previewMaterial(): THREE.MeshBasicMaterial {
  return new THREE.MeshBasicMaterial({
    color: 0x79c0ff,
    transparent: true,
    opacity: 0.3,
    depthTest: false,
  });
}

/** Three geometry for a poly mesh (preview only — the renderer has its own path). */
function polyGeometry(mesh: PolyMesh): THREE.BufferGeometry {
  const compiled = compilePolyMesh(mesh);
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(compiled.positions, 3));
  geometry.setAttribute("normal", new THREE.BufferAttribute(compiled.normals, 3));
  geometry.setAttribute("uv", new THREE.BufferAttribute(compiled.uvs, 2));
  geometry.setIndex(new THREE.BufferAttribute(compiled.indices, 1));
  for (const g of compiled.groups) geometry.addGroup(g.start, g.count, g.materialIndex);
  geometry.userData["triangleFace"] = compiled.triangleFace;
  return geometry;
}

/** Extruded polygon geometry standing up along +Y (matches render's polygon source). */
function extrudedPolyGeometry(
  points: Array<[number, number]>,
  height: number,
  bevel: number,
): THREE.BufferGeometry {
  const shape = new THREE.Shape(points.map(([x, y]) => new THREE.Vector2(x, y)));
  const geometry = new THREE.ExtrudeGeometry(shape, {
    depth: height,
    bevelEnabled: bevel > 0,
    bevelSize: bevel,
    bevelThickness: bevel,
    bevelSegments: 2,
    curveSegments: 8,
  });
  geometry.rotateX(-Math.PI / 2);
  return geometry;
}

/** Shape params derived from a drawn footprint (w × d) and pulled height. */
function shapeParamsFor(shape: GrayboxShape, w: number, d: number, h: number): { name: string; params: ShapeParams } {
  const radius = Math.max(w, d) / 2;
  switch (shape) {
    case "cylinder":
      return { name: "cylinder", params: { radius, height: h, sides: 24 } };
    case "sphere":
      return { name: "sphere", params: { radius, segments: 24, rings: 12 } };
    case "wedge":
      return { name: "prism", params: { width: w, height: h, depth: d } };
    case "plane":
      return { name: "plane", params: { width: w, depth: d, widthSegments: 1, depthSegments: 1 } };
    case "cone":
      return { name: "cone", params: { radius, height: h, sides: 24 } };
    case "stairs":
      return { name: "stairs", params: { width: w, height: h, depth: d, steps: Math.max(2, Math.round(h / 0.25)), sides: true } };
    case "arch":
      return { name: "arch", params: { radius: w / 2, thickness: Math.max(0.1, w * 0.15), depth: d, sides: 12, degrees: 180 } };
    case "torus":
      return { name: "torus", params: { radius: radius * 0.75, tube: radius * 0.25, segments: 32, tubeSegments: 16 } };
    case "pipe":
      return { name: "pipe", params: { radius, height: h, thickness: Math.max(0.05, radius * 0.2), sides: 24, heightSegments: 1 } };
    case "door":
      return { name: "door", params: { width: w, height: h, depth: d, legWidth: Math.max(0.1, w * 0.15), topWidth: Math.max(0.1, h * 0.12) } };
    default:
      return { name: "cube", params: { width: w, height: h, depth: d } };
  }
}

/** Convex shapes get an exact convex hull; everything else a trimesh; boxes a sized box. */
function colliderFor(shapeName: string, mesh: PolyMesh): Record<string, unknown> {
  if (shapeName === "cube") {
    const b = polyMeshBounds(mesh);
    return { shape: "box", size: [b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]], offset: b.center };
  }
  if (["cylinder", "sphere", "prism", "cone", "icosphere"].includes(shapeName)) return { shape: "convex" };
  return { shape: "trimesh" };
}

/** Shapes whose draw gesture has no height step. */
const FLAT_SHAPES = new Set<GrayboxShape>(["sphere", "plane", "torus"]);

/**
 * ProBuilder-style grayboxing:
 * - draw gesture: footprint -> height -> click commits (flat shapes — sphere,
 *   plane, torus — commit on release; wedges face the drag direction).
 * - poly shape: click base points on the ground, close near the first point
 *   (or Enter), pull up, click to commit.
 * - shapes commit as EDITABLE poly meshes (see `editable`): cube, cylinder,
 *   sphere, prism, plane, cone, stairs, arch, torus, pipe, door, footprint.
 * - grab faces: on an editable mesh, drag a face to push/pull it along its
 *   normal; ALT+drag pulls a new block out of it (extrude). On legacy
 *   primitives drag resizes box faces / cylinder caps+sides / sphere radius.
 * - Snapping follows the toolbar setting; holding CTRL inverts it. Esc cancels.
 */
export class GrayboxTool {
  private readonly raycaster = new THREE.Raycaster();
  private phase: Phase = { kind: "idle" };
  private readonly disposers: Array<() => void> = [];
  private readonly dragPlane = new THREE.Plane();
  private ctrl = false;

  constructor(private readonly opts: GrayboxToolOptions) {
    const down = (e: PointerEvent) => this.onDown(e);
    const move = (e: PointerEvent) => this.onMove(e);
    const up = () => this.onUp();
    const key = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
      if (e.code === "Escape") this.cancel();
      if (e.code === "KeyG" && !e.ctrlKey && !e.altKey && this.opts.enabled.get()) {
        this.opts.active.set(!this.opts.active.get());
      }
      if (e.code === "Enter" && this.phase.kind === "poly-points" && this.phase.points.length >= 3) {
        this.toPolyHeight();
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

  private get editable(): boolean {
    return this.opts.editable?.get() ?? true;
  }

  /** Toolbar snap setting, inverted while Ctrl is held. */
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

  private groundPoint(ray: THREE.Ray, y: number): THREE.Vector3 | null {
    this.dragPlane.set(new THREE.Vector3(0, 1, 0), -y);
    const point = new THREE.Vector3();
    return ray.intersectPlane(this.dragPlane, point) ? point : null;
  }

  /** Rebuild the draw preview from the current footprint/height. */
  private layoutPreview(preview: THREE.Mesh, base: THREE.Vector3, corner: THREE.Vector3, h: number): void {
    const shape = this.opts.shape.get();
    const w = Math.max(0.1, Math.abs(corner.x - base.x));
    const d = Math.max(0.1, Math.abs(corner.z - base.z));
    const cx = (base.x + corner.x) / 2;
    const cz = (base.z + corner.z) / 2;
    const height = FLAT_SHAPES.has(shape) ? Math.max(w, d) : Math.max(0.05, h);
    const { name, params } = shapeParamsFor(shape, w, d, height);
    preview.geometry.dispose();
    preview.geometry = polyGeometry(buildShape(name, params));
    preview.position.set(cx, base.y, cz);
    preview.quaternion.identity();
    if (shape === "wedge") preview.quaternion.setFromAxisAngle(new THREE.Vector3(0, 1, 0), this.wedgeYaw(base, corner));
  }

  private wedgeYaw(base: THREE.Vector3, corner: THREE.Vector3): number {
    const dx = corner.x - base.x;
    const dz = corner.z - base.z;
    if (Math.abs(dx) >= Math.abs(dz)) return dx >= 0 ? Math.PI / 2 : -Math.PI / 2;
    return dz >= 0 ? 0 : Math.PI;
  }

  // ---------------------------------------------------------------- input

  private onDown(e: PointerEvent): void {
    if (!this.isOn || e.button !== 0) return;
    this.ctrl = e.ctrlKey;

    if (this.phase.kind === "height") {
      e.stopPropagation();
      this.commitDraw();
      return;
    }
    if (this.phase.kind === "poly-height") {
      e.stopPropagation();
      this.commitPoly();
      return;
    }

    const ray = this.ray(e);

    if (this.phase.kind === "poly-points") {
      e.stopPropagation();
      const p = this.groundPoint(ray, this.phase.baseY);
      if (!p) return;
      p.set(this.snap(p.x), this.phase.baseY, this.snap(p.z));
      const first = this.phase.points[0]!;
      if (this.phase.points.length >= 3 && p.distanceTo(first) < 0.4) {
        this.toPolyHeight();
        return;
      }
      this.phase.points.push(p);
      this.updatePolyLine();
      return;
    }

    if (this.phase.kind !== "idle") return;

    const hits = this.raycaster.intersectObjects(this.opts.getScene().children, true);
    const hit = hits.find((h) => {
      if (h.object.userData["physicsDebug"] || h.object.userData["skyDome"]) return false;
      let node: THREE.Object3D | null = h.object;
      let owned = false;
      while (node) {
        if (node.userData["editorOverlay"]) return false;
        if (node.userData["entityId"]) owned = true;
        node = node.parent;
      }
      return owned;
    });

    // face interactions on shape entities (not inside prefab instances)
    if (hit?.face) {
      const expandedId = this.findEntityId(hit.object);
      if (expandedId && !expandedId.includes(":")) {
        const entity = this.opts.store.doc.entities[expandedId];
        const mesh = entity?.components["mesh"] as MeshComponentData | undefined;
        const source = mesh?.source;
        if (source && !("prefab" in (entity?.components ?? {}))) {
          if (source.kind === "poly" && hit.object.userData["polyMesh"]) {
            e.stopPropagation();
            this.beginPolyFaceDrag(expandedId, hit, source as PolyMesh, e.altKey);
            return;
          }
          const shape = (source as { shape?: string }).shape;
          if (source.kind === "primitive" && (shape === "box" || shape === "cylinder" || shape === "sphere")) {
            e.stopPropagation();
            const size = (source as { size?: Vec3 }).size ?? [1, 1, 1];
            if (e.altKey && shape === "box") this.beginExtrude(hit, size);
            else this.beginFaceDrag(expandedId, hit, shape, size);
            return;
          }
        }
      }
    }

    // start drawing on an upward surface or the y=0 plane
    let base: THREE.Vector3 | null = null;
    if (hit) {
      const worldNormal = hit.face
        ? hit.face.normal.clone().transformDirection(hit.object.matrixWorld)
        : new THREE.Vector3(0, 1, 0);
      if (worldNormal.y > 0.85) base = hit.point.clone();
    } else {
      base = this.groundPoint(ray, 0);
    }
    if (!base) return;
    e.stopPropagation();
    base.set(this.snap(base.x), Math.max(0, base.y), this.snap(base.z));

    if (this.opts.shape.get() === "poly") {
      const line = new THREE.Line(
        new THREE.BufferGeometry(),
        new THREE.LineBasicMaterial({ color: 0x79c0ff, depthTest: false }),
      );
      line.renderOrder = 998;
      line.userData["editorOverlay"] = true;
      this.opts.getScene().add(line);
      this.phase = { kind: "poly-points", baseY: base.y, points: [base], line };
      this.updatePolyLine();
      this.opts.onDraggingChanged?.(true);
      return;
    }

    const preview = new THREE.Mesh(new THREE.BufferGeometry(), previewMaterial());
    preview.renderOrder = 998;
    preview.userData["editorOverlay"] = true;
    this.opts.getScene().add(preview);
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

  private groupOf(object: THREE.Object3D): THREE.Object3D | null {
    let node: THREE.Object3D | null = object;
    while (node) {
      if (node.userData["entityId"]) return node;
      node = node.parent;
    }
    return null;
  }

  // ---------------------------------------------------------------- editable-mesh face push/pull

  private beginPolyFaceDrag(entityId: string, hit: THREE.Intersection, mesh: PolyMesh, extrude: boolean): void {
    const meshChild = hit.object as THREE.Mesh;
    const map = meshChild.geometry.userData["triangleFace"] as Uint32Array | undefined;
    if (!map || hit.faceIndex === undefined || hit.faceIndex === null) return;
    const face = map[hit.faceIndex];
    if (face === undefined) return;
    const topo = buildTopology(mesh);
    const normalLocal = new THREE.Vector3(...topo.faceNormals[face]!);
    const lineDir = normalLocal.clone().transformDirection(meshChild.matrixWorld).normalize();
    let preview: THREE.Mesh | null = null;
    if (extrude) {
      preview = new THREE.Mesh(new THREE.BufferGeometry(), previewMaterial());
      preview.renderOrder = 998;
      preview.userData["editorOverlay"] = true;
      this.opts.getScene().add(preview);
    }
    this.phase = {
      kind: "poly-face",
      entityId,
      meshChild,
      mesh,
      face,
      normalLocal,
      lineOrigin: hit.point.clone(),
      lineDir,
      delta: 0,
      extrude,
      preview,
    };
    this.opts.onDraggingChanged?.(true);
  }

  /** The mesh with the dragged face pushed by `delta` (local units along its normal). */
  private pushedMesh(phase: Extract<Phase, { kind: "poly-face" }>): PolyMesh {
    const { mesh, face, normalLocal, delta } = phase;
    const n: Vec3 = [normalLocal.x * delta, normalLocal.y * delta, normalLocal.z * delta];
    return transformVertices(mesh, mesh.faces[face]!.v, (p) => [p[0] + n[0], p[1] + n[1], p[2] + n[2]]);
  }

  private layoutPolyFace(): void {
    if (this.phase.kind !== "poly-face") return;
    const { meshChild, preview } = this.phase;
    if (this.phase.extrude && preview) {
      // preview block: the face extruded by delta, drawn over the untouched mesh
      const { mesh, face, normalLocal, delta } = this.phase;
      const faceVerts = mesh.faces[face]!.v;
      const lifted: PolyMesh = {
        kind: "poly",
        materials: [],
        vertices: [
          ...faceVerts.map((i) => mesh.vertices[i]!),
          ...faceVerts.map((i) => {
            const p = mesh.vertices[i]!;
            return [p[0] + normalLocal.x * delta, p[1] + normalLocal.y * delta, p[2] + normalLocal.z * delta] as Vec3;
          }),
        ],
        faces: [
          { v: faceVerts.map((_, i) => i), mat: 0, smooth: 0 },
          { v: faceVerts.map((_, i) => i + faceVerts.length), mat: 0, smooth: 0 },
          ...faceVerts.map((_, i) => ({
            v: [i, (i + 1) % faceVerts.length, ((i + 1) % faceVerts.length) + faceVerts.length, i + faceVerts.length],
            mat: 0,
            smooth: 0,
          })),
        ],
      };
      preview.geometry.dispose();
      preview.geometry = polyGeometry(lifted);
      meshChild.updateWorldMatrix(true, false);
      preview.matrixAutoUpdate = false;
      preview.matrix.copy(meshChild.matrixWorld);
      preview.matrixWorld.copy(meshChild.matrixWorld);
      return;
    }
    // push/pull: swap the rendered geometry live
    const pushed = this.pushedMesh(this.phase);
    meshChild.geometry.dispose();
    meshChild.geometry = polyGeometry(pushed);
  }

  private commitPolyFace(): void {
    if (this.phase.kind !== "poly-face") return;
    const phase = this.phase;
    this.phase = { kind: "idle" };
    this.opts.onDraggingChanged?.(false);
    phase.preview?.geometry.dispose();
    phase.preview?.removeFromParent();
    const entity = this.opts.store.doc.entities[phase.entityId];
    const component = entity?.components["mesh"] as MeshComponentData | undefined;
    if (!entity || !component) return;
    if (Math.abs(phase.delta) < 1e-4) {
      // restore the untouched geometry
      phase.meshChild.geometry.dispose();
      phase.meshChild.geometry = polyGeometry(phase.mesh);
      return;
    }
    let next: PolyMesh;
    if (phase.extrude) {
      // a real extrude through the core op (keeps the mesh closed)
      const { extrudeFaces } = extrudeOps;
      next = extrudeFaces(phase.mesh, [phase.face], phase.delta, "vertex-normal").mesh;
    } else {
      next = this.pushedMesh(phase);
      const { generator: _g, ...rest } = next;
      next = rest;
    }
    const ops: Array<{ op: "set-component"; id: string; component: string; data: unknown }> = [
      { op: "set-component", id: phase.entityId, component: "mesh", data: { ...component, source: next } },
    ];
    const collider = entity.components["collider"] as { shape?: string } | undefined;
    if (collider?.shape === "box") {
      const b = polyMeshBounds(next);
      ops.push({
        op: "set-component",
        id: phase.entityId,
        component: "collider",
        data: { ...collider, size: [b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]], offset: b.center },
      });
    }
    try {
      this.opts.store.apply(ops);
      this.opts.selection.set(phase.entityId);
    } catch (error) {
      console.warn("[graybox] face commit rejected:", error);
    }
  }

  // ---------------------------------------------------------------- legacy primitive face drags

  private beginFaceDrag(
    entityId: string,
    hit: THREE.Intersection,
    shape: "box" | "cylinder" | "sphere",
    size: Vec3,
  ): void {
    const group = this.groupOf(hit.object);
    if (!group) return;
    const groupQuat = group.getWorldQuaternion(new THREE.Quaternion());
    const local = hit.face!.normal.clone();

    let mode: "extent" | "radial";
    let axis: 0 | 1 | 2;
    let lineDir: THREE.Vector3;

    if (shape === "sphere") {
      mode = "radial";
      axis = 0;
      lineDir = hit.point.clone().sub(group.getWorldPosition(new THREE.Vector3())).normalize();
    } else if (shape === "cylinder" && Math.abs(local.y) < 0.7) {
      mode = "radial";
      axis = 0;
      lineDir = hit.point.clone().sub(group.getWorldPosition(new THREE.Vector3()));
      lineDir.y = 0;
      lineDir.normalize();
    } else {
      mode = "extent";
      axis =
        Math.abs(local.x) >= Math.abs(local.y) && Math.abs(local.x) >= Math.abs(local.z)
          ? 0
          : Math.abs(local.y) >= Math.abs(local.z)
            ? 1
            : 2;
      if (shape === "cylinder") axis = 1;
      lineDir = new THREE.Vector3()
        .fromArray([
          axis === 0 ? Math.sign(local.x) : 0,
          axis === 1 ? Math.sign(local.y) : 0,
          axis === 2 ? Math.sign(local.z) : 0,
        ])
        .applyQuaternion(groupQuat)
        .normalize();
    }

    this.phase = {
      kind: "face",
      entityId,
      group,
      meshChild: hit.object,
      mode,
      axis,
      lineOrigin: hit.point.clone(),
      lineDir,
      size: [...size] as Vec3,
      delta: 0,
      groupPos0: group.position.clone(),
    };
    this.opts.onDraggingChanged?.(true);
  }

  /** ALT+drag: pull a NEW box out of an existing primitive box face. */
  private beginExtrude(hit: THREE.Intersection, size: Vec3): void {
    const group = this.groupOf(hit.object);
    if (!group) return;
    const rotation = group.getWorldQuaternion(new THREE.Quaternion());
    const local = hit.face!.normal.clone();
    const axis: 0 | 1 | 2 =
      Math.abs(local.x) >= Math.abs(local.y) && Math.abs(local.x) >= Math.abs(local.z)
        ? 0
        : Math.abs(local.y) >= Math.abs(local.z)
          ? 1
          : 2;
    const lineDir = new THREE.Vector3()
      .fromArray([
        axis === 0 ? Math.sign(local.x) : 0,
        axis === 1 ? Math.sign(local.y) : 0,
        axis === 2 ? Math.sign(local.z) : 0,
      ])
      .applyQuaternion(rotation)
      .normalize();

    const preview = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), previewMaterial());
    preview.renderOrder = 998;
    preview.userData["editorOverlay"] = true;
    preview.quaternion.copy(rotation);
    this.opts.getScene().add(preview);

    this.phase = {
      kind: "extrude",
      axis,
      lineOrigin: hit.point.clone(),
      lineDir,
      size: [...size] as Vec3,
      delta: 0.1,
      center: group.getWorldPosition(new THREE.Vector3()),
      rotation,
      preview,
    };
    this.layoutExtrudePreview();
    this.opts.onDraggingChanged?.(true);
  }

  private layoutExtrudePreview(): void {
    if (this.phase.kind !== "extrude") return;
    const { axis, size, delta, center, lineDir, preview } = this.phase;
    const dims: Vec3 = [...size];
    dims[axis] = Math.max(0.1, delta);
    preview.scale.set(...dims);
    preview.position
      .copy(center)
      .addScaledVector(lineDir, size[axis] / 2 + Math.max(0.1, delta) / 2);
  }

  // ---------------------------------------------------------------- poly footprint

  private updatePolyLine(cursor?: THREE.Vector3): void {
    if (this.phase.kind !== "poly-points") return;
    const pts = [...this.phase.points];
    if (cursor) pts.push(cursor);
    if (pts.length > 2) pts.push(this.phase.points[0]!);
    this.phase.line.geometry.dispose();
    this.phase.line.geometry = new THREE.BufferGeometry().setFromPoints(
      pts.map((p) => p.clone().setY(this.phase.kind === "poly-points" ? this.phase.baseY + 0.02 : 0)),
    );
  }

  private toPolyHeight(): void {
    if (this.phase.kind !== "poly-points") return;
    const { baseY, points, line } = this.phase;
    line.geometry.dispose();
    line.removeFromParent();
    const preview = new THREE.Mesh(new THREE.BufferGeometry(), previewMaterial());
    preview.renderOrder = 998;
    preview.userData["editorOverlay"] = true;
    this.opts.getScene().add(preview);
    this.phase = { kind: "poly-height", baseY, points, h: 0.1, preview };
    this.layoutPolyPreview();
  }

  private polyLocal(): { c: THREE.Vector3; pts: Array<[number, number]> } {
    const points = this.phase.kind === "poly-height" || this.phase.kind === "poly-points" ? this.phase.points : [];
    const c = new THREE.Vector3();
    for (const p of points) c.add(p);
    c.divideScalar(Math.max(1, points.length));
    // extrude-space: [x, -z] so the standing geometry matches drawn world z
    const pts = points.map((p) => [p.x - c.x, -(p.z - c.z)] as [number, number]);
    return { c, pts };
  }

  private layoutPolyPreview(): void {
    if (this.phase.kind !== "poly-height") return;
    const { c, pts } = this.polyLocal();
    this.phase.preview.geometry.dispose();
    this.phase.preview.geometry = extrudedPolyGeometry(pts, this.phase.h, this.editable ? 0 : this.opts.bevel.get());
    this.phase.preview.position.set(c.x, this.phase.baseY, c.z);
  }

  // ---------------------------------------------------------------- move / up

  private onMove(e: PointerEvent): void {
    if (this.phase.kind === "idle") return;
    this.ctrl = e.ctrlKey;
    const ray = this.ray(e);

    if (this.phase.kind === "poly-points") {
      const p = this.groundPoint(ray, this.phase.baseY);
      if (p) {
        p.set(this.snap(p.x), this.phase.baseY, this.snap(p.z));
        this.updatePolyLine(p);
      }
      return;
    }

    if (this.phase.kind === "footprint") {
      const point = this.groundPoint(ray, this.phase.base.y);
      if (!point) return;
      this.phase.corner.set(this.snap(point.x), this.phase.base.y, this.snap(point.z));
      this.layoutPreview(this.phase.preview, this.phase.base, this.phase.corner, 0.05);
      return;
    }

    if (this.phase.kind === "height" || this.phase.kind === "poly-height") {
      const center =
        this.phase.kind === "height"
          ? new THREE.Vector3(
              (this.phase.base.x + this.phase.corner.x) / 2,
              this.phase.base.y,
              (this.phase.base.z + this.phase.corner.z) / 2,
            )
          : this.polyLocal().c.clone().setY(this.phase.baseY);
      const normal = this.opts.camera.getWorldDirection(new THREE.Vector3());
      normal.y = 0;
      if (normal.lengthSq() < 1e-4) return;
      normal.normalize();
      this.dragPlane.setFromNormalAndCoplanarPoint(normal, center);
      const point = new THREE.Vector3();
      if (!ray.intersectPlane(this.dragPlane, point)) return;
      const baseY = this.phase.kind === "height" ? this.phase.base.y : this.phase.baseY;
      this.phase.h = Math.max(0.1, this.snap(point.y - baseY));
      if (this.phase.kind === "height") {
        this.layoutPreview(this.phase.preview, this.phase.base, this.phase.corner, this.phase.h);
      } else {
        this.layoutPolyPreview();
      }
      return;
    }

    if (this.phase.kind === "extrude") {
      const t = this.snap(rayLineParam(ray, this.phase.lineOrigin, this.phase.lineDir));
      this.phase.delta = Math.max(0.1, t);
      this.layoutExtrudePreview();
      return;
    }

    if (this.phase.kind === "poly-face") {
      const t = this.snap(rayLineParam(ray, this.phase.lineOrigin, this.phase.lineDir));
      // world drag distance -> local units (uniform scale assumed for the preview)
      const scale = this.phase.meshChild.getWorldScale(new THREE.Vector3());
      const k = (Math.abs(scale.x) + Math.abs(scale.y) + Math.abs(scale.z)) / 3 || 1;
      this.phase.delta = this.phase.extrude ? Math.max(0.05, t / k) : t / k;
      this.layoutPolyFace();
      return;
    }

    // legacy face drag
    const t = this.snap(rayLineParam(ray, this.phase.lineOrigin, this.phase.lineDir));
    if (this.phase.mode === "radial") {
      const minDelta = (0.1 - this.phase.size[0]) / 2;
      this.phase.delta = Math.max(minDelta, t);
      const factor = (this.phase.size[0] + 2 * this.phase.delta) / this.phase.size[0];
      const isSphere =
        this.phase.size[1] === this.phase.size[0] && this.phase.size[2] === this.phase.size[0];
      this.phase.meshChild.scale.set(factor, isSphere ? factor : 1, factor);
      return;
    }
    const delta = Math.max(0.1 - this.phase.size[this.phase.axis], t);
    this.phase.delta = delta;
    const factor = (this.phase.size[this.phase.axis] + delta) / this.phase.size[this.phase.axis];
    const scale: Vec3 = [1, 1, 1];
    scale[this.phase.axis] = factor;
    this.phase.meshChild.scale.set(...scale);
    const shift = new THREE.Vector3().copy(this.phase.lineDir).multiplyScalar(delta / 2);
    this.phase.group.position.copy(this.phase.groupPos0).add(shift);
  }

  private onUp(): void {
    if (this.phase.kind === "footprint") {
      const w = Math.abs(this.phase.corner.x - this.phase.base.x);
      const d = Math.abs(this.phase.corner.z - this.phase.base.z);
      if (w * d < 0.05) {
        this.cancel();
        return;
      }
      if (FLAT_SHAPES.has(this.opts.shape.get())) {
        this.phase = { ...this.phase, kind: "height", h: Math.max(w, d) };
        this.commitDraw();
        return;
      }
      this.phase = { ...this.phase, kind: "height", h: 0.1 };
      return;
    }
    if (this.phase.kind === "face") this.commitFace();
    if (this.phase.kind === "extrude") this.commitExtrude();
    if (this.phase.kind === "poly-face") this.commitPolyFace();
  }

  // ---------------------------------------------------------------- commits

  private addEntity(
    name: string,
    position: Vec3,
    rotation: [number, number, number, number],
    mesh: unknown,
    collider: unknown,
  ): void {
    const id = newId();
    // paint-at-draw: the toolbar's material picker assigns to every new shape
    const material = this.opts.material?.get();
    const meshData =
      material && typeof mesh === "object" && mesh !== null ? { ...mesh, material } : mesh;
    try {
      this.opts.store.apply([
        {
          op: "add-entity",
          id,
          entity: {
            name,
            parent: null,
            tags: ["graybox"],
            components: { transform: { position, rotation }, mesh: meshData, collider },
          },
        },
      ]);
      this.opts.selection.set(id);
    } catch (error) {
      console.warn("[graybox] commit rejected:", error);
    }
  }

  private commitDraw(): void {
    if (this.phase.kind !== "height") return;
    const { base, corner, h, preview } = this.phase;
    preview.geometry.dispose();
    preview.removeFromParent();
    this.phase = { kind: "idle" };
    this.opts.onDraggingChanged?.(false);

    const shape = this.opts.shape.get();
    const bevel = this.opts.bevel.get();
    const w = Math.max(0.1, Math.abs(corner.x - base.x));
    const d = Math.max(0.1, Math.abs(corner.z - base.z));
    const cx = (base.x + corner.x) / 2;
    const cz = (base.z + corner.z) / 2;
    const legacy = !this.editable && (shape === "box" || shape === "cylinder" || shape === "sphere" || shape === "wedge");

    if (!legacy) {
      const height = FLAT_SHAPES.has(shape) ? Math.max(w, d) : h;
      const { name, params } = shapeParamsFor(shape, w, d, height);
      const mesh = buildShape(name, params);
      const yaw = shape === "wedge" ? this.wedgeYaw(base, corner) : 0;
      const label = shape === "box" ? "Box" : shape === "wedge" ? "Ramp" : shape.charAt(0).toUpperCase() + shape.slice(1);
      this.addEntity(
        label,
        [cx, base.y, cz],
        [0, Math.sin(yaw / 2), 0, Math.cos(yaw / 2)],
        { source: mesh },
        colliderFor(name, mesh),
      );
      return;
    }

    if (shape === "sphere") {
      const dia = Math.max(w, d);
      this.addEntity(
        "Sphere",
        [cx, base.y + dia / 2, cz],
        [0, 0, 0, 1],
        { source: { kind: "primitive", shape: "sphere", size: [dia, dia, dia] } },
        { shape: "sphere", size: [dia, dia, dia] },
      );
      return;
    }
    if (shape === "cylinder") {
      const dia = Math.max(w, d);
      this.addEntity(
        "Cylinder",
        [cx, base.y + h / 2, cz],
        [0, 0, 0, 1],
        { source: { kind: "primitive", shape: "cylinder", size: [dia, h, dia] } },
        { shape: "cylinder", size: [dia, h, dia] },
      );
      return;
    }
    if (shape === "wedge") {
      const yaw = this.wedgeYaw(base, corner);
      this.addEntity(
        "Ramp",
        [cx, base.y, cz],
        [0, Math.sin(yaw / 2), 0, Math.cos(yaw / 2)],
        { source: { kind: "primitive", shape: "wedge", size: [w, h, d] } },
        // box approximation until convex cooking lands
        { shape: "box", size: [w, h, d], offset: [0, h / 2, 0] },
      );
      return;
    }
    // box — with bevel it becomes a beveled extrusion
    if (bevel > 0) {
      const points: Array<[number, number]> = [
        [-w / 2, -d / 2],
        [w / 2, -d / 2],
        [w / 2, d / 2],
        [-w / 2, d / 2],
      ];
      this.addEntity(
        "Box",
        [cx, base.y, cz],
        [0, 0, 0, 1],
        { source: { kind: "polygon", points, height: h, bevel: { size: bevel, segments: 2 } } },
        { shape: "box", size: [w + 2 * bevel, h + bevel, d + 2 * bevel], offset: [0, h / 2, 0] },
      );
      return;
    }
    this.addEntity(
      "Box",
      [cx, base.y + h / 2, cz],
      [0, 0, 0, 1],
      { source: { kind: "primitive", shape: "box", size: [w, h, d] } },
      { shape: "box", size: [w, h, d] },
    );
  }

  private commitPoly(): void {
    if (this.phase.kind !== "poly-height") return;
    const { baseY, h, preview } = this.phase;
    const { c, pts } = this.polyLocal();
    preview.geometry.dispose();
    preview.removeFromParent();
    this.phase = { kind: "idle" };
    this.opts.onDraggingChanged?.(false);

    if (this.editable) {
      // footprint points are extrude-space [x, -z]; polyFromFootprint wants [x, z]
      const mesh = polyFromFootprint(pts.map(([x, y]) => [x, -y] as [number, number]), h);
      this.addEntity("Poly", [c.x, baseY, c.z], [0, 0, 0, 1], { source: mesh }, { shape: "trimesh" });
      return;
    }

    const bevel = this.opts.bevel.get();
    // AABB collider approximation of the footprint
    let minX = Infinity,
      maxX = -Infinity,
      minZ = Infinity,
      maxZ = -Infinity;
    for (const [x, y] of pts) {
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
      minZ = Math.min(minZ, -y);
      maxZ = Math.max(maxZ, -y);
    }
    this.addEntity(
      "Poly",
      [c.x, baseY, c.z],
      [0, 0, 0, 1],
      {
        source: {
          kind: "polygon",
          points: pts,
          height: h,
          ...(bevel > 0 ? { bevel: { size: bevel, segments: 2 } } : {}),
        },
      },
      {
        shape: "box",
        size: [maxX - minX, h, maxZ - minZ],
        offset: [(minX + maxX) / 2, h / 2, (minZ + maxZ) / 2],
      },
    );
  }

  private commitExtrude(): void {
    if (this.phase.kind !== "extrude") return;
    const { axis, size, delta, center, lineDir, rotation, preview } = this.phase;
    preview.geometry.dispose();
    preview.removeFromParent();
    this.phase = { kind: "idle" };
    this.opts.onDraggingChanged?.(false);

    const dims: Vec3 = [...size];
    dims[axis] = Math.max(0.1, delta);
    const position = center
      .clone()
      .addScaledVector(lineDir, size[axis] / 2 + dims[axis] / 2);
    this.addEntity(
      "Box",
      [position.x, position.y, position.z],
      rotation.toArray() as [number, number, number, number],
      { source: { kind: "primitive", shape: "box", size: dims } },
      { shape: "box", size: dims },
    );
  }

  private commitFace(): void {
    if (this.phase.kind !== "face") return;
    const { entityId, mode, axis, delta, lineDir, groupPos0, group, meshChild } = this.phase;
    this.phase = { kind: "idle" };
    this.opts.onDraggingChanged?.(false);
    meshChild.scale.set(1, 1, 1);
    group.position.copy(groupPos0);
    if (Math.abs(delta) < 1e-4) return;

    const entity = this.opts.store.doc.entities[entityId];
    if (!entity) return;
    const mesh = structuredClone(entity.components["mesh"]) as { source: { shape?: string; size?: Vec3 } };
    const newSize = [...(mesh.source.size ?? [1, 1, 1])] as Vec3;

    const ops: Array<{ op: "set-component"; id: string; component: string; data: unknown }> = [];

    if (mode === "radial") {
      const dia = Math.max(0.1, newSize[0] + 2 * delta);
      const isSphere = mesh.source.shape === "sphere";
      newSize[0] = dia;
      newSize[2] = dia;
      if (isSphere) newSize[1] = dia;
      mesh.source.size = newSize;
      ops.push({ op: "set-component", id: entityId, component: "mesh", data: mesh });
    } else {
      newSize[axis] = Math.max(0.1, newSize[axis] + delta);
      mesh.source.size = newSize;
      ops.push({ op: "set-component", id: entityId, component: "mesh", data: mesh });

      const transform = structuredClone(
        (entity.components["transform"] ?? {}) as { position?: Vec3; [k: string]: unknown },
      );
      const p = transform.position ?? [0, 0, 0];
      const parent = group.parent;
      const shiftWorld = new THREE.Vector3().copy(lineDir).multiplyScalar(delta / 2);
      const shiftParent = parent
        ? shiftWorld.applyQuaternion(parent.getWorldQuaternion(new THREE.Quaternion()).invert())
        : shiftWorld;
      transform.position = [p[0] + shiftParent.x, p[1] + shiftParent.y, p[2] + shiftParent.z];
      ops.push({ op: "set-component", id: entityId, component: "transform", data: transform });
    }

    const collider = entity.components["collider"] as { shape?: string; size?: Vec3 } | undefined;
    if (collider) {
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
    if (this.phase.kind === "footprint" || this.phase.kind === "height" || this.phase.kind === "poly-height") {
      this.phase.preview.geometry.dispose();
      this.phase.preview.removeFromParent();
    }
    if (this.phase.kind === "poly-points") {
      this.phase.line.geometry.dispose();
      this.phase.line.removeFromParent();
    }
    if (this.phase.kind === "extrude") {
      this.phase.preview.geometry.dispose();
      this.phase.preview.removeFromParent();
    }
    if (this.phase.kind === "face") {
      this.phase.meshChild.scale.set(1, 1, 1);
      this.phase.group.position.copy(this.phase.groupPos0);
    }
    if (this.phase.kind === "poly-face") {
      this.phase.preview?.geometry.dispose();
      this.phase.preview?.removeFromParent();
      this.phase.meshChild.geometry.dispose();
      this.phase.meshChild.geometry = polyGeometry(this.phase.mesh);
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

// late-bound so the file reads top-down; the op is a plain core import
import { extrudeFaces as coreExtrudeFaces } from "@hitreg/core";
const extrudeOps = { extrudeFaces: coreExtrudeFaces };

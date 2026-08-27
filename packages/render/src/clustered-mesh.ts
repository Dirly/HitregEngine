import * as THREE from "three/webgpu";
import {
  buildClusterDag,
  cutTriangleCount,
  selectClusterCut,
  type ClusterDag,
  type ClusterDagOptions,
  type CutView,
} from "./cluster-dag.js";

/**
 * A `THREE.Mesh` that draws the current cut of a cluster DAG (cluster-dag.ts)
 * — continuous, crack-free, per-cluster LOD with per-cluster frustum culling
 * for one mesh, through ONE draw call with the mesh's ordinary material.
 *
 * How the draw works: the geometry shares the source geometry's vertex
 * attributes untouched (every DAG level indexes the same vertices) and owns
 * one dynamic index buffer sized to the worst case (all leaves = the source
 * triangle count). `update()` selects the cut for the camera, concatenates
 * the selected clusters' index lists into that buffer, and sets the draw
 * range. When the cut doesn't change between frames nothing is uploaded.
 * Compared with `BatchedMesh` + per-cluster visibility this needs no
 * multi-draw support, works on the WebGL fallback exactly like WebGPU, and
 * keeps skinning/morph-free materials completely unaware of the LOD.
 */
export class ClusteredMesh extends THREE.Mesh {
  readonly dag: ClusterDag;
  /** Largest projected error (pixels) a drawn cluster may have. */
  thresholdPx = 1;
  /** What the last `update()` drew — for the stats HUD. `culled` = clusters
   * the LOD cut selected that were then skipped as outside the frustum. */
  readonly stats = { clusters: 0, triangles: 0, culled: 0 };

  private readonly cut: Int32Array;
  private readonly previousCut: Int32Array;
  private previousCount = -1;
  private readonly indexAttribute: THREE.BufferAttribute;
  private readonly worldInverse = new THREE.Matrix4();
  private readonly cameraLocal = new THREE.Vector3();
  private readonly projView = new THREE.Matrix4();
  private readonly frustum = new THREE.Frustum();
  private readonly planes = new Float32Array(24);

  constructor(source: THREE.BufferGeometry, material: THREE.Material | THREE.Material[], dag: ClusterDag) {
    const geometry = new THREE.BufferGeometry();
    // own copies of the attributes (not the loader's shared objects) so the
    // normal dispose path of whatever streamed this mesh in can free them
    // without pulling GPU buffers out from under the cached source model
    for (const name of Object.keys(source.attributes)) geometry.setAttribute(name, source.attributes[name]!.clone());
    const indexArray = new Uint32Array(dag.triangleCount * 3);
    // start at full detail (the leaf cut) so a mesh nobody drives still
    // renders as the plain model would, rather than as nothing
    let cursor = 0;
    for (const cluster of dag.clusters) {
      if (cluster.level !== 0) continue;
      indexArray.set(cluster.indices, cursor);
      cursor += cluster.indices.length;
    }
    const index = new THREE.BufferAttribute(indexArray, 1);
    index.setUsage(THREE.DynamicDrawUsage);
    geometry.setIndex(index);
    geometry.setDrawRange(0, cursor);
    // bounds of the whole model — the cut is always a subset of it
    source.computeBoundingBox();
    source.computeBoundingSphere();
    geometry.boundingBox = source.boundingBox!.clone();
    geometry.boundingSphere = source.boundingSphere!.clone();
    super(geometry, material);
    this.dag = dag;
    this.indexAttribute = index;
    this.cut = new Int32Array(dag.clusters.length);
    this.previousCut = new Int32Array(dag.clusters.length);
    this.userData["clusteredMesh"] = true;
  }

  /**
   * Re-select the cut for `camera` (a perspective camera; `viewportHeight`
   * in pixels is what turns world error into screen error). Call once per
   * frame per visible mesh — O(clusters) on the CPU, plus an index upload
   * only when the cut changed.
   */
  update(camera: THREE.PerspectiveCamera, viewportHeight: number, cull = true): void {
    this.updateWorldMatrix(true, false);
    this.worldInverse.copy(this.matrixWorld).invert();
    camera.getWorldPosition(this.cameraLocal).applyMatrix4(this.worldInverse);
    const view: CutView = {
      x: this.cameraLocal.x,
      y: this.cameraLocal.y,
      z: this.cameraLocal.z,
      viewportHeight,
      tanHalfFov: Math.tan((camera.fov * Math.PI) / 360),
      thresholdPx: this.thresholdPx,
      near: camera.near,
    };
    if (cull) {
      // the camera frustum expressed in this mesh's local space
      this.projView.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse).multiply(this.matrixWorld);
      this.frustum.setFromProjectionMatrix(this.projView, camera.coordinateSystem);
      for (let p = 0; p < 6; p++) {
        const plane = this.frustum.planes[p]!;
        this.planes[p * 4] = plane.normal.x;
        this.planes[p * 4 + 1] = plane.normal.y;
        this.planes[p * 4 + 2] = plane.normal.z;
        this.planes[p * 4 + 3] = plane.constant;
      }
      view.planes = this.planes;
    }
    const count = selectClusterCut(this.dag, view, this.cut, this.stats);
    this.stats.clusters = count;
    this.stats.triangles = cutTriangleCount(this.dag, this.cut, count);
    if (count === this.previousCount) {
      let same = true;
      for (let i = 0; i < count; i++) {
        if (this.cut[i] !== this.previousCut[i]) {
          same = false;
          break;
        }
      }
      if (same) return;
    }
    const array = this.indexAttribute.array as Uint32Array;
    let cursor = 0;
    for (let i = 0; i < count; i++) {
      const indices = this.dag.clusters[this.cut[i]!]!.indices;
      array.set(indices, cursor);
      cursor += indices.length;
    }
    this.indexAttribute.clearUpdateRanges();
    this.indexAttribute.addUpdateRange(0, cursor);
    this.indexAttribute.needsUpdate = true;
    this.geometry.setDrawRange(0, cursor);
    this.previousCut.set(this.cut.subarray(0, count));
    this.previousCount = count;
  }
}

/** Plain Float32 copy of an attribute (de-interleaved, de-normalised). */
function attributeFloats(attr: THREE.BufferAttribute | THREE.InterleavedBufferAttribute): Float32Array {
  const out = new Float32Array(attr.count * attr.itemSize);
  for (let i = 0; i < attr.count; i++) {
    for (let c = 0; c < attr.itemSize; c++) out[i * attr.itemSize + c] = attr.getComponent(i, c);
  }
  return out;
}

/**
 * Build a cluster DAG straight from a three geometry (indexed or not; normals
 * and uvs are handed to the simplifier when present). Requires
 * `clusterDagReady()`; returns null for geometry not worth clustering.
 */
export function clusterDagFromGeometry(
  geometry: THREE.BufferGeometry,
  options: ClusterDagOptions = {},
): ClusterDag | null {
  const position = geometry.getAttribute("position") as THREE.BufferAttribute | undefined;
  if (!position || position.itemSize !== 3 || position.count < 3) return null;
  const positions = attributeFloats(position);
  let indices: Uint32Array;
  if (geometry.index) {
    const array = geometry.index.array;
    indices = array instanceof Uint32Array ? array : Uint32Array.from(array as ArrayLike<number>);
  } else {
    indices = new Uint32Array(position.count);
    for (let i = 0; i < position.count; i++) indices[i] = i;
  }
  const normal = geometry.getAttribute("normal");
  const uv = geometry.getAttribute("uv");
  return buildClusterDag(indices, positions, {
    ...options,
    ...(normal && normal.itemSize === 3 && normal.count === position.count ? { normals: attributeFloats(normal) } : {}),
    ...(uv && uv.itemSize === 2 && uv.count === position.count ? { uvs: attributeFloats(uv) } : {}),
  });
}

function inScene(object: THREE.Object3D): boolean {
  let node: THREE.Object3D | null = object;
  while (node) {
    if ((node as THREE.Scene).isScene) return true;
    node = node.parent;
  }
  return false;
}

/**
 * Per-frame driver for every `ClusteredMesh` in the scene — the same shape
 * as FoliageLodSystem: register on build, unregister on dispose, `update()`
 * once per frame with the camera actually rendering.
 */
export class ClusterLodSystem {
  private readonly meshes = new Set<ClusteredMesh>();
  /** Shared pixel threshold; per-mesh `thresholdPx` is overwritten on update. */
  thresholdPx = 1;

  register(mesh: ClusteredMesh): void {
    this.meshes.add(mesh);
  }

  unregister(mesh: ClusteredMesh): void {
    this.meshes.delete(mesh);
  }

  get size(): number {
    return this.meshes.size;
  }

  update(camera: THREE.Camera, viewportHeight: number): void {
    const perspective = camera as THREE.PerspectiveCamera;
    if (!perspective.isPerspectiveCamera) return;
    for (const mesh of this.meshes) {
      // a chunk/subscene unload removes its subtree from the live scene
      // without telling anyone — detect it here rather than threading one
      // more lifecycle hook through every streaming manager
      if (!inScene(mesh)) {
        this.meshes.delete(mesh);
        continue;
      }
      if (!mesh.visible) continue;
      mesh.thresholdPx = this.thresholdPx;
      mesh.update(perspective, viewportHeight);
    }
  }

  /** Summed over registered meshes — for the stats HUD. */
  stats(): { meshes: number; clusters: number; triangles: number; culled: number } {
    const out = { meshes: this.meshes.size, clusters: 0, triangles: 0, culled: 0 };
    for (const mesh of this.meshes) {
      out.clusters += mesh.stats.clusters;
      out.triangles += mesh.stats.triangles;
      out.culled += mesh.stats.culled;
    }
    return out;
  }
}

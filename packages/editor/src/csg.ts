import * as THREE from "three/webgpu";
import { ADDITION, Brush, Evaluator, INTERSECTION, SUBTRACTION } from "three-bvh-csg";
import { compilePolyMesh, polyFromGeometry, type PolyMesh } from "@hitreg/core";

/**
 * CSG booleans (ProBuilder's experimental Boolean window) and the
 * "ProBuilderize anything" conversion. Both end in `polyFromGeometry`, so
 * the result is a welded n-gon poly mesh the element tools can keep editing
 * — never a frozen triangle soup.
 *
 * three-bvh-csg is dev-only (editor package): a boolean is an authoring
 * operation whose OUTPUT is stored in the scene doc as a poly mesh; nothing
 * at runtime depends on the library.
 */

export type BooleanOp = "union" | "subtract" | "intersect";

type Vec3 = [number, number, number];

/** All mesh geometry under `root` (skipping editor overlays/debug), baked into `root`'s local frame. */
export function geometryFromObject(root: THREE.Object3D): { positions: Float32Array; indices: Uint32Array } | null {
  root.updateWorldMatrix(true, true);
  const inverseRoot = new THREE.Matrix4().copy(root.matrixWorld).invert();
  const positions: number[] = [];
  const indices: number[] = [];
  const v = new THREE.Vector3();
  const relative = new THREE.Matrix4();
  root.traverse((node) => {
    const mesh = node as THREE.Mesh;
    if (!mesh.isMesh) return;
    if (isOverlayOrDebug(node)) return;
    const position = mesh.geometry?.getAttribute("position");
    if (!position || position.count === 0) return;
    // a child ENTITY's meshes belong to that entity, not this one
    for (let n: THREE.Object3D | null = node.parent; n && n !== root; n = n.parent) {
      if (n.userData["entityId"]) return;
    }
    relative.multiplyMatrices(inverseRoot, mesh.matrixWorld);
    const base = positions.length / 3;
    for (let i = 0; i < position.count; i++) {
      v.fromBufferAttribute(position, i).applyMatrix4(relative);
      positions.push(v.x, v.y, v.z);
    }
    const index = mesh.geometry.index;
    if (index) for (let i = 0; i < index.count; i++) indices.push(base + index.getX(i));
    else for (let i = 0; i < position.count; i++) indices.push(base + i);
  });
  if (positions.length === 0) return null;
  return { positions: new Float32Array(positions), indices: new Uint32Array(indices) };
}

function isOverlayOrDebug(node: THREE.Object3D): boolean {
  for (let n: THREE.Object3D | null = node; n; n = n.parent) {
    if (n.userData["editorOverlay"] || n.userData["physicsDebug"] || n.userData["skyDome"] || n.userData["isColliderProxy"]) return true;
  }
  return false;
}

/** Editable poly mesh from whatever an entity currently renders. */
export function polyFromObject(root: THREE.Object3D, smoothAngle = 30): PolyMesh | null {
  const geometry = geometryFromObject(root);
  if (!geometry) return null;
  const mesh = polyFromGeometry(geometry.positions, geometry.indices, { smoothAngle });
  return mesh.faces.length > 0 ? mesh : null;
}

function brushFor(source: PolyMesh | null, object: THREE.Object3D): Brush | null {
  let geometry: THREE.BufferGeometry | null = null;
  if (source) {
    const compiled = compilePolyMesh(source);
    geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(compiled.positions, 3));
    geometry.setAttribute("normal", new THREE.BufferAttribute(compiled.normals, 3));
    geometry.setAttribute("uv", new THREE.BufferAttribute(compiled.uvs, 2));
    geometry.setIndex(new THREE.BufferAttribute(compiled.indices, 1));
  } else {
    const data = geometryFromObject(object);
    if (!data) return null;
    geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(data.positions, 3));
    geometry.setIndex(new THREE.BufferAttribute(data.indices, 1));
    geometry.computeVertexNormals();
    const uv = new Float32Array((data.positions.length / 3) * 2);
    geometry.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
  }
  const brush = new Brush(geometry);
  object.updateWorldMatrix(true, false);
  object.matrixWorld.decompose(brush.position, brush.quaternion, brush.scale);
  brush.updateMatrixWorld(true);
  return brush;
}

/**
 * A op B, in A's local frame, as an editable poly mesh. Each side is either
 * its poly source (exact n-gons) or whatever it renders. Returns null when a
 * side has no geometry or the result is empty.
 */
export function booleanMeshes(
  a: { source: PolyMesh | null; object: THREE.Object3D },
  b: { source: PolyMesh | null; object: THREE.Object3D },
  op: BooleanOp,
): PolyMesh | null {
  const brushA = brushFor(a.source, a.object);
  const brushB = brushFor(b.source, b.object);
  if (!brushA || !brushB) return null;
  const evaluator = new Evaluator();
  evaluator.useGroups = false;
  const operation = op === "union" ? ADDITION : op === "subtract" ? SUBTRACTION : INTERSECTION;
  const result = evaluator.evaluate(brushA, brushB, operation) as Brush;
  const geometry = result.geometry;
  const position = geometry.getAttribute("position");
  if (!position || position.count === 0) return null;
  // the evaluator hands back geometry in A's local frame (it copies A's matrixWorld onto the result)
  const positions = position.array as Float32Array;
  const index = geometry.index ? (geometry.index.array as ArrayLike<number>) : null;
  const mesh = polyFromGeometry(positions, index, { smoothAngle: 30 });
  brushA.geometry.dispose();
  brushB.geometry.dispose();
  geometry.dispose();
  return mesh.faces.length > 0 ? mesh : null;
}

export function offsetOf(v: Vec3): Vec3 {
  return v;
}

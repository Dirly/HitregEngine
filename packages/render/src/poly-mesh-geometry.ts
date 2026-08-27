import * as THREE from "three/webgpu";
import { compilePolyMesh, type CompiledMesh, type PolyMeshSource } from "@hitreg/core";

/**
 * PolyMesh source -> Three geometry. All the geometry logic (triangulation,
 * smoothing groups, auto-UV projection, material groups) lives headless in
 * @hitreg/core's compiler; this file only wraps the resulting typed arrays.
 * The compiled `triangleFace` map is kept on `geometry.userData` so the
 * editor can turn a raycast hit (a triangle) back into a face index.
 */
export function polyMeshGeometry(
  source: PolyMeshSource,
  worldMatrix?: THREE.Matrix4,
): { geometry: THREE.BufferGeometry; compiled: CompiledMesh } {
  const compiled = compilePolyMesh(source, worldMatrix ? { worldMatrix: worldMatrix.elements } : {});
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(compiled.positions, 3));
  geometry.setAttribute("normal", new THREE.BufferAttribute(compiled.normals, 3));
  geometry.setAttribute("uv", new THREE.BufferAttribute(compiled.uvs, 2));
  if (compiled.colors) geometry.setAttribute("color", new THREE.BufferAttribute(compiled.colors, 3));
  geometry.setIndex(new THREE.BufferAttribute(compiled.indices, 1));
  for (const group of compiled.groups) geometry.addGroup(group.start, group.count, group.materialIndex);
  geometry.computeBoundingSphere();
  geometry.computeBoundingBox();
  geometry.userData["triangleFace"] = compiled.triangleFace;
  return { geometry, compiled };
}

/** Face index for a raycast hit on a poly-mesh geometry (null when the hit isn't one). */
export function polyFaceForHit(hit: THREE.Intersection): number | null {
  const map = (hit.object as THREE.Mesh).geometry?.userData?.["triangleFace"] as Uint32Array | undefined;
  if (!map || hit.faceIndex === undefined || hit.faceIndex === null) return null;
  const face = map[hit.faceIndex];
  return face === undefined ? null : face;
}

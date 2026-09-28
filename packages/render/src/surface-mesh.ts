import * as THREE from "three/webgpu";

/** `mesh.source.kind: "surface"` — a raw triangle mesh written by a generator (voxel water, chunk.ts). */
export interface SurfaceMeshSource {
  kind: "surface";
  positions: number[];
  indices: number[];
  uvs?: number[];
  /** Optional second uv (a fall curtain's across/down, read by the water material's dissolve). */
  uv1s?: number[];
}

/**
 * Geometry for a `surface` source. The normals are computed from the
 * triangles: straight up on a pool, tilted on a rapid, which is what the
 * water shader bends its waves around.
 */
export function surfaceGeometry(source: SurfaceMeshSource): THREE.BufferGeometry {
  const geometry = new THREE.BufferGeometry();
  const count = source.positions.length / 3;
  geometry.setAttribute("position", new THREE.BufferAttribute(Float32Array.from(source.positions), 3));
  const uvs = source.uvs && source.uvs.length === count * 2 ? Float32Array.from(source.uvs) : new Float32Array(count * 2);
  geometry.setAttribute("uv", new THREE.BufferAttribute(uvs, 2));
  if (source.uv1s && source.uv1s.length === count * 2) geometry.setAttribute("uv1", new THREE.BufferAttribute(Float32Array.from(source.uv1s), 2));
  const IndexArray = count > 65535 ? Uint32Array : Uint16Array;
  geometry.setIndex(new THREE.BufferAttribute(IndexArray.from(source.indices), 1));
  geometry.computeVertexNormals();
  geometry.computeBoundingSphere();
  return geometry;
}

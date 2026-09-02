import * as THREE from "three/webgpu";
import { voxelMesh, type VoxelMesh, type VoxelMeshSource } from "@hitreg/core";
import { SPLAT_ATTRIBUTES } from "./terrain-splat.js";

/**
 * `{ kind: "voxel" }` mesh source -> a `BufferGeometry`.
 *
 * The geometry is thin on purpose: `@hitreg/core`'s `voxelMesh` does all the
 * work and caches the result, so the renderer, the physics cooker and the
 * placement solver each ask for the same cell and get the same arrays back.
 * That shared cache is what makes "what you see is what you collide with"
 * true by construction rather than by convention.
 *
 * Beyond position/normal/index the geometry carries two extra streams the
 * terrain shader reads:
 *
 * - `splatWeight`… (one vec4 per four palette surfaces) — which surfaces this
 *   vertex is, decided by the world recipe's biome rules from temperature,
 *   moisture, altitude and slope.
 * - `color` (vec3) — the biome tint, so two biomes sharing the grass channel
 *   still read as different places.
 *
 * Normals come from the field gradient, NOT from `computeVertexNormals()`.
 * That is the difference between a seamless world and one with a visible
 * lighting crease down every chunk boundary: two neighbouring cells derive
 * identical gradients from the same field, whereas face-averaged normals
 * would each only see their own cell's triangles.
 */
export function voxelGeometry(source: VoxelMeshSource): THREE.BufferGeometry | null {
  const mesh = voxelMesh(source);
  if (mesh.triangleCount === 0) return null;
  return geometryFrom(mesh);
}

/**
 * The same geometry from an ALREADY-MESHED cell — for a `VoxelMesh` that came
 * back from a worker rather than out of core's cache. Same attribute layout by
 * construction, because it is the same function.
 */
export function voxelGeometryFromMesh(mesh: VoxelMesh): THREE.BufferGeometry | null {
  if (mesh.triangleCount === 0) return null;
  return geometryFrom(mesh);
}

/**
 * Split the palette weights across as many vec4 attributes as it needs.
 *
 * A vertex attribute is at most four components, so an eight-surface palette
 * needs two and a sixteen-surface palette four. The count comes from the
 * mesh's own `surfaceCount`, so a small palette pays for a small vertex.
 */
function setSplatAttributes(geometry: THREE.BufferGeometry, mesh: VoxelMesh): void {
  const stride = mesh.surfaceCount;
  if (stride < 1 || mesh.vertexCount === 0) return;
  // ALWAYS emit every vec4 the palette needs, even where the upper ones are
  // entirely zero. Skipping an empty one to save a buffer looked free and was
  // not: HLOD merges many cells into one geometry, and `mergeGeometries`
  // requires every input to declare the SAME attributes. A supercell that
  // happened to span one blighted cell and one ordinary one then failed to
  // merge at all — and it failed loudly in the console but silently on
  // screen, as a missing distant proxy. Palette size is a property of the
  // WORLD, so this count is the same for every cell by construction.
  const vecs = Math.ceil(stride / 4);
  for (let v = 0; v < vecs && v < SPLAT_ATTRIBUTES.length; v++) {
    const data = new Float32Array(mesh.vertexCount * 4);
    for (let i = 0; i < mesh.vertexCount; i++) {
      for (let c = 0; c < 4; c++) {
        const s = v * 4 + c;
        data[i * 4 + c] = s < stride ? mesh.splat[i * stride + s]! : 0;
      }
    }
    geometry.setAttribute(SPLAT_ATTRIBUTES[v]!, new THREE.BufferAttribute(data, 4));
  }
}

function geometryFrom(mesh: VoxelMesh): THREE.BufferGeometry {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(mesh.positions, 3));
  geometry.setAttribute("normal", new THREE.BufferAttribute(mesh.normals, 3));
  geometry.setIndex(new THREE.BufferAttribute(mesh.indices, 1));
  setSplatAttributes(geometry, mesh);
  if (mesh.tint.length === mesh.vertexCount * 3) {
    geometry.setAttribute("color", new THREE.BufferAttribute(mesh.tint, 3));
  }
  // the mesher already knows the bounds; recomputing them walks every vertex
  geometry.boundingBox = new THREE.Box3(
    new THREE.Vector3(...mesh.min),
    new THREE.Vector3(...mesh.max),
  );
  geometry.boundingSphere = geometry.boundingBox.getBoundingSphere(new THREE.Sphere());
  return geometry;
}

/**
 * A coarse copy of the same cell for the camera's dolly-collision raycasts.
 *
 * `refreshCameraColliders()` in the playground raycasts static geometry every
 * frame with no acceleration structure. Doing that against full-resolution
 * voxel terrain — tens of thousands of triangles per cell, several cells in
 * range — is exactly the cost that made the heightmap path grow the same
 * trick (scene-builder's heightmap branch). Same field, a quarter of the
 * lattice: identical SHAPE for "don't push the camera through a hill",
 * a fraction of the triangles.
 */
export function voxelColliderProxyGeometry(source: VoxelMeshSource): THREE.BufferGeometry | null {
  const step = Math.min(4, Math.max(2, (source.lodStep ?? 1) * 2));
  const mesh = voxelMesh({ ...source, lodStep: step });
  if (mesh.triangleCount === 0) return null;
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(mesh.positions, 3));
  geometry.setIndex(new THREE.BufferAttribute(mesh.indices, 1));
  return geometry;
}

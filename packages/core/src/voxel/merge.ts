import type { VoxelMesh } from "./mesh.js";

/**
 * Merge several meshed cells into one, baking each cell's world transform in.
 *
 * This exists so an HLOD supercell's terrain can be assembled OFF the main
 * thread. Profiling a streaming flight put the merge — `prepForMerge`,
 * `applyMatrix4`, `applyNormalMatrix` and `mergeGeometries` between them — at
 * roughly 3.9 seconds of a 30 second flight, which was the largest remaining
 * main-thread cost once cell generation and coarse meshing had moved to the
 * worker. It is plain typed-array arithmetic with no three.js in it, so the
 * worker can do it and transfer the result.
 *
 * Merging voxel cells specifically, rather than arbitrary geometry, is what
 * makes it simple: every cell of a world carries exactly the same attributes
 * (position, normal, `surfaceCount` splat weights, vec3 tint), because the
 * palette is a property of the WORLD. There is no mismatched-attribute case to
 * handle, which is the thing that makes the general merge path expensive.
 *
 * `matrix` is column-major 4x4, matching three's `Matrix4.elements`.
 */
export function mergeVoxelMeshes(
  entries: ReadonlyArray<{ mesh: VoxelMesh; matrix: ArrayLike<number> }>,
): VoxelMesh | null {
  const live = entries.filter((e) => e.mesh.triangleCount > 0);
  if (live.length === 0) return null;
  const surfaceCount = live[0]!.mesh.surfaceCount;

  let vertexCount = 0;
  let indexCount = 0;
  for (const { mesh } of live) {
    vertexCount += mesh.vertexCount;
    indexCount += mesh.indices.length;
  }

  const positions = new Float32Array(vertexCount * 3);
  const normals = new Float32Array(vertexCount * 3);
  const splat = new Float32Array(vertexCount * surfaceCount);
  const tint = new Float32Array(vertexCount * 3);
  // A merged supercell can exceed 65k vertices many times over, so the index
  // width is not negotiable — this is Uint32 for the same reason `VoxelMesh`'s
  // is.
  const indices = new Uint32Array(indexCount);

  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  let vertexBase = 0;
  let indexBase = 0;

  for (const { mesh, matrix } of live) {
    const m = matrix;
    // Normals transform by the inverse-transpose of the upper 3x3. For the
    // rigid, axis-aligned translations a supercell actually uses that reduces
    // to the 3x3 itself, but deriving it properly costs nothing here and keeps
    // the function honest if a proxy is ever scaled.
    const n = normalMatrixFrom(m);
    for (let i = 0; i < mesh.vertexCount; i++) {
      const px = mesh.positions[i * 3]!;
      const py = mesh.positions[i * 3 + 1]!;
      const pz = mesh.positions[i * 3 + 2]!;
      const x = m[0]! * px + m[4]! * py + m[8]! * pz + m[12]!;
      const y = m[1]! * px + m[5]! * py + m[9]! * pz + m[13]!;
      const z = m[2]! * px + m[6]! * py + m[10]! * pz + m[14]!;
      const o = (vertexBase + i) * 3;
      positions[o] = x;
      positions[o + 1] = y;
      positions[o + 2] = z;
      if (x < min[0]) min[0] = x;
      if (y < min[1]) min[1] = y;
      if (z < min[2]) min[2] = z;
      if (x > max[0]) max[0] = x;
      if (y > max[1]) max[1] = y;
      if (z > max[2]) max[2] = z;

      const nx = mesh.normals[i * 3]!;
      const ny = mesh.normals[i * 3 + 1]!;
      const nz = mesh.normals[i * 3 + 2]!;
      let tx = n[0]! * nx + n[3]! * ny + n[6]! * nz;
      let ty = n[1]! * nx + n[4]! * ny + n[7]! * nz;
      let tz = n[2]! * nx + n[5]! * ny + n[8]! * nz;
      const len = Math.hypot(tx, ty, tz) || 1;
      tx /= len;
      ty /= len;
      tz /= len;
      normals[o] = tx;
      normals[o + 1] = ty;
      normals[o + 2] = tz;
    }
    splat.set(mesh.splat.subarray(0, mesh.vertexCount * surfaceCount), vertexBase * surfaceCount);
    if (mesh.tint.length >= mesh.vertexCount * 3) {
      tint.set(mesh.tint.subarray(0, mesh.vertexCount * 3), vertexBase * 3);
    }
    for (let i = 0; i < mesh.indices.length; i++) {
      indices[indexBase + i] = mesh.indices[i]! + vertexBase;
    }
    vertexBase += mesh.vertexCount;
    indexBase += mesh.indices.length;
  }

  return {
    positions,
    normals,
    indices,
    splat,
    surfaceCount,
    tint,
    min,
    max,
    vertexCount,
    triangleCount: indexCount / 3,
  };
}

/** Inverse-transpose of a column-major 4x4's upper 3x3, as a column-major 3x3. */
function normalMatrixFrom(m: ArrayLike<number>): number[] {
  const a = m[0]!, b = m[1]!, c = m[2]!;
  const d = m[4]!, e = m[5]!, f = m[6]!;
  const g = m[8]!, h = m[9]!, i = m[10]!;
  const det = a * (e * i - f * h) - d * (b * i - c * h) + g * (b * f - c * e);
  if (Math.abs(det) < 1e-12) return [a, b, c, d, e, f, g, h, i];
  const inv = 1 / det;
  // adjugate / det, then transposed — written out rather than composed so the
  // transpose cannot be applied twice by accident
  return [
    (e * i - f * h) * inv,
    (g * f - d * i) * inv,
    (d * h - g * e) * inv,
    (h * c - b * i) * inv,
    (a * i - g * c) * inv,
    (g * b - a * h) * inv,
    (b * f - e * c) * inv,
    (d * c - a * f) * inv,
    (a * e - d * b) * inv,
  ];
}

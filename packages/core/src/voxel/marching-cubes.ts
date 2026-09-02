/**
 * Marching cubes over a sampled scalar field.
 *
 * Sign convention: **density < isolevel is SOLID**, like a signed distance
 * field (negative inside). The world field is written as `y - groundHeight`,
 * so "below the ground" is negative and the sign reads the way you'd guess.
 *
 * Three things this does that a textbook implementation usually doesn't, all
 * of them load-bearing for a streamed open world:
 *
 * - **Welded vertices.** Each intersected edge is keyed by its lattice point
 *   + axis, so the (up to) four cubes sharing an edge share one vertex.
 *   Roughly halves the vertex count and, more importantly, lets a single
 *   smooth normal live at each vertex.
 * - **Gradient normals, not face normals.** Normals come from central
 *   differences of the *field* at the lattice points, interpolated along the
 *   edge. Two neighbouring chunks compute the same gradient at their shared
 *   boundary from the same field, so the lighting is seamless across a chunk
 *   seam with no neighbour-geometry exchange at all. This is why the sampler
 *   is asked for a one-voxel padding ring.
 * - **Verified winding.** Each triangle is oriented against the interpolated
 *   gradient at its centroid, so faces point out of the solid no matter what
 *   the case table says. Backface culling and cooked physics both depend on
 *   it and neither fails loudly.
 */

import { CORNER_OFFSETS, EDGE_CORNERS, EDGE_LATTICE, MC_TRIANGLES } from "./tables.js";

/**
 * A sampled block of the field. `values` is row-major
 * `x + y * nx + z * nx * ny`, laid out with ONE PADDING SAMPLE on every side:
 * lattice index 0 and `n-1` exist only to make central differences valid, and
 * cells are emitted for the interior only.
 */
export interface SampledBlock {
  values: Float32Array;
  /** Sample counts per axis, INCLUDING the padding ring (cells = n - 3). */
  nx: number;
  ny: number;
  nz: number;
  /** World position of lattice sample (0,0,0) — i.e. one step outside the block. */
  origin: [number, number, number];
  /** World units between lattice samples. */
  step: number;
}

/** Extra per-vertex data, computed once per welded vertex. */
export interface VertexAttributeSpec {
  /** Floats per vertex (e.g. 4 for a splat weight vec4). */
  size: number;
  /** Fill `out[0..size-1]` for a vertex at this world position with this normal. */
  compute: (
    x: number,
    y: number,
    z: number,
    nx: number,
    ny: number,
    nz: number,
    out: Float32Array,
    offset: number,
  ) => void;
}

export interface MarchOptions {
  isolevel?: number;
  /** Named extra vertex streams, e.g. `{ splat: {...}, tint: {...} }`. */
  attributes?: Record<string, VertexAttributeSpec>;
}

export interface MarchResult {
  positions: Float32Array;
  normals: Float32Array;
  indices: Uint32Array;
  /** Same keys as `MarchOptions.attributes`, each a packed per-vertex stream. */
  attributes: Record<string, Float32Array>;
  vertexCount: number;
  triangleCount: number;
}

const EMPTY: MarchResult = {
  positions: new Float32Array(0),
  normals: new Float32Array(0),
  indices: new Uint32Array(0),
  attributes: {},
  vertexCount: 0,
  triangleCount: 0,
};

/** An empty result, shared — a chunk of pure air or pure rock is the common case. */
export function emptyMarchResult(): MarchResult {
  return EMPTY;
}

/** Polygonize one sampled block. Returns a welded, outward-wound indexed mesh. */
export function marchingCubes(block: SampledBlock, options: MarchOptions = {}): MarchResult {
  const { values, nx, ny, nz, origin, step } = block;
  const iso = options.isolevel ?? 0;
  const cellsX = nx - 3;
  const cellsY = ny - 3;
  const cellsZ = nz - 3;
  if (cellsX < 1 || cellsY < 1 || cellsZ < 1) return EMPTY;

  const strideY = nx;
  const strideZ = nx * ny;
  const at = (i: number, j: number, k: number): number => values[i + j * strideY + k * strideZ]!;

  // Cheap rejection: an all-solid or all-air block has no surface at all, and
  // in a streamed world most blocks are exactly that. Bail before allocating.
  let anyInside = false;
  let anyOutside = false;
  for (let i = 0; i < values.length; i++) {
    if (values[i]! < iso) anyInside = true;
    else anyOutside = true;
    if (anyInside && anyOutside) break;
  }
  if (!anyInside || !anyOutside) return EMPTY;

  const positions: number[] = [];
  const normals: number[] = [];
  const indices: number[] = [];
  const attrSpecs = Object.entries(options.attributes ?? {});
  const attrOut: Record<string, number[]> = {};
  for (const [name] of attrSpecs) attrOut[name] = [];
  const scratch = new Float32Array(16);

  /** Welded vertex index per lattice edge: key = (latticeIndex * 3 + axis). */
  const vertexOf = new Map<number, number>();

  // gradient at a lattice point via central differences (padding makes this safe)
  const gradX = (i: number, j: number, k: number): number => at(i + 1, j, k) - at(i - 1, j, k);
  const gradY = (i: number, j: number, k: number): number => at(i, j + 1, k) - at(i, j - 1, k);
  const gradZ = (i: number, j: number, k: number): number => at(i, j, k + 1) - at(i, j, k - 1);

  const cornerValue = new Float32Array(8);
  const edgeVertex = new Int32Array(12);

  for (let cz = 1; cz <= cellsZ; cz++) {
    for (let cy = 1; cy <= cellsY; cy++) {
      for (let cx = 1; cx <= cellsX; cx++) {
        let mask = 0;
        for (let c = 0; c < 8; c++) {
          const o = CORNER_OFFSETS[c]!;
          const v = at(cx + o[0], cy + o[1], cz + o[2]);
          cornerValue[c] = v;
          if (v < iso) mask |= 1 << c;
        }
        const tris = MC_TRIANGLES[mask]!;
        if (tris.length === 0) continue;

        edgeVertex.fill(-1);
        for (let t = 0; t < tris.length; t++) {
          const edge = tris[t]!;
          if (edgeVertex[edge] !== -1) continue;
          const [dx, dy, dz, axis] = EDGE_LATTICE[edge]!;
          const li = cx + dx;
          const lj = cy + dy;
          const lk = cz + dz;
          const key = (li + lj * strideY + lk * strideZ) * 3 + axis;
          const cached = vertexOf.get(key);
          if (cached !== undefined) {
            edgeVertex[edge] = cached;
            continue;
          }
          // lattice endpoints of this edge (lower point + one step along axis)
          const mi = li + (axis === 0 ? 1 : 0);
          const mj = lj + (axis === 1 ? 1 : 0);
          const mk = lk + (axis === 2 ? 1 : 0);
          const va = at(li, lj, lk);
          const vb = at(mi, mj, mk);
          const denom = vb - va;
          const tt = Math.abs(denom) < 1e-12 ? 0.5 : (iso - va) / denom;
          const t01 = tt < 0 ? 0 : tt > 1 ? 1 : tt;

          const wx = origin[0] + (li + (axis === 0 ? t01 : 0)) * step;
          const wy = origin[1] + (lj + (axis === 1 ? t01 : 0)) * step;
          const wz = origin[2] + (lk + (axis === 2 ? t01 : 0)) * step;

          // gradient points toward INCREASING density = out of the solid
          let gx = gradX(li, lj, lk) * (1 - t01) + gradX(mi, mj, mk) * t01;
          let gy = gradY(li, lj, lk) * (1 - t01) + gradY(mi, mj, mk) * t01;
          let gz = gradZ(li, lj, lk) * (1 - t01) + gradZ(mi, mj, mk) * t01;
          // Math.sqrt, not Math.hypot: hypot is variadic and does overflow-safe
          // scaling, which costs several times a plain sqrt in V8. This runs once
          // per welded vertex — tens of thousands per cell — and the inputs are
          // small finite differences that cannot overflow.
          const len = Math.sqrt(gx * gx + gy * gy + gz * gz);
          if (len < 1e-9) {
            gx = 0;
            gy = 1;
            gz = 0;
          } else {
            gx /= len;
            gy /= len;
            gz /= len;
          }

          const index = positions.length / 3;
          positions.push(wx, wy, wz);
          normals.push(gx, gy, gz);
          for (const [name, spec] of attrSpecs) {
            spec.compute(wx, wy, wz, gx, gy, gz, scratch, 0);
            const sink = attrOut[name]!;
            for (let s = 0; s < spec.size; s++) sink.push(scratch[s]!);
          }
          vertexOf.set(key, index);
          edgeVertex[edge] = index;
        }

        for (let t = 0; t + 2 < tris.length; t += 3) {
          const a = edgeVertex[tris[t]!]!;
          const b = edgeVertex[tris[t + 1]!]!;
          const c = edgeVertex[tris[t + 2]!]!;
          if (a === b || b === c || a === c) continue; // degenerate: two edges welded
          // orient against the surface normal — the table's winding is checked,
          // not trusted, because a flipped face is silent until physics is wrong
          const ax = positions[a * 3]!;
          const ay = positions[a * 3 + 1]!;
          const az = positions[a * 3 + 2]!;
          const e1x = positions[b * 3]! - ax;
          const e1y = positions[b * 3 + 1]! - ay;
          const e1z = positions[b * 3 + 2]! - az;
          const e2x = positions[c * 3]! - ax;
          const e2y = positions[c * 3 + 1]! - ay;
          const e2z = positions[c * 3 + 2]! - az;
          const fx = e1y * e2z - e1z * e2y;
          const fy = e1z * e2x - e1x * e2z;
          const fz = e1x * e2y - e1y * e2x;
          // A zero-area face here is not a bug to filter out. It happens when
          // the isosurface passes exactly through a lattice corner, so two
          // distinct welded vertices land on the same point — and the face is
          // still what makes every edge shared by exactly two triangles. Drop
          // it and the mesh stops being closed, which is precisely the property
          // the cooked collider depends on. It has no meaningful winding, so it
          // falls through to the table's own order below.
          const nx0 = normals[a * 3]! + normals[b * 3]! + normals[c * 3]!;
          const ny0 = normals[a * 3 + 1]! + normals[b * 3 + 1]! + normals[c * 3 + 1]!;
          const nz0 = normals[a * 3 + 2]! + normals[b * 3 + 2]! + normals[c * 3 + 2]!;
          if (fx * nx0 + fy * ny0 + fz * nz0 < 0) indices.push(a, c, b);
          else indices.push(a, b, c);
        }
      }
    }
  }

  if (indices.length === 0) return EMPTY;
  const attributes: Record<string, Float32Array> = {};
  for (const [name] of attrSpecs) attributes[name] = Float32Array.from(attrOut[name]!);
  return {
    positions: Float32Array.from(positions),
    normals: Float32Array.from(normals),
    indices: Uint32Array.from(indices),
    attributes,
    vertexCount: positions.length / 3,
    triangleCount: indices.length / 3,
  };
}

/** Corner-pair lookup, re-exported so tests can reason about the table. */
export { EDGE_CORNERS };

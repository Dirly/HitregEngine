/**
 * Dual contouring over the same sampled scalar field marching cubes uses.
 *
 * **This is an experiment, not the shipping mesher.** It exists so the two can
 * be compared on the SAME world, in the same scene, by flipping one field —
 * see `VoxelMeshSource.mesher`. Read {@link ./marching-cubes.ts} first; the
 * sign convention (density < isolevel is SOLID) and the `SampledBlock` layout
 * are shared, and everything below is stated as a difference from it.
 *
 * MC puts a vertex on every intersected lattice EDGE. DC puts one vertex
 * inside every intersected CELL, positioned to minimise a quadratic error
 * function over the surface planes the cell's edge crossings imply, and joins
 * the four cells around each intersected edge into a quad. Three consequences,
 * all of them the reason to try it:
 *
 * - **Sharp features survive.** Where two planes meet inside a cell, the QEF
 *   minimiser lands on their intersection instead of averaging across it, so a
 *   canyon rim or a scarp keeps an edge that MC rounds off at lattice
 *   resolution. `sharpness: 0` degrades this to the mass point — plain surface
 *   nets — which is the useful third data point in any comparison.
 * - **Quad topology, not fewer vertices.** A uniform DC costs about what MC
 *   costs and measures slightly MORE on a smooth surface: MC already welds one
 *   vertex per intersected edge, and a dual mesh has one FACE per intersected
 *   edge, so Euler puts the two counts within a few percent of each other. The
 *   saving people quote comes from ADAPTIVE dual contouring, which collapses
 *   octree cells whose QEF residual is small — not implemented here. What is
 *   genuinely better is the shape of the output: regular quads with valence
 *   near four instead of a triangle fan, which is what a simplifier or a
 *   cluster builder wants to be handed.
 * - **Seams cost a wider ring.** An MC vertex is a function of its lattice
 *   edge alone, so neighbouring chunks agree with a ONE-sample pad. A DC quad
 *   spans four cells, so a chunk needs its neighbours' boundary cell vertices,
 *   and those must be computed from true central differences or the two
 *   chunks disagree by a fraction of a voxel. Hence `pad = 2` and the
 *   ownership rule below — NOT a wider pad "to be safe".
 *
 * **Face ownership.** A quad on a chunk boundary is reachable from both
 * chunks, so exactly one must emit it or the seam z-fights. The rule is
 * uniform over all three edge axes: emit iff the edge's X, Y and Z lattice
 * indices ALL lie in `[pad, pad + cells)`. For an edge running ALONG that
 * axis the index is the cell it sits in; for an edge perpendicular to it the
 * index is the lattice plane between cells `n-1` and `n`, which assigns the
 * boundary plane to the chunk on its `+` side. Either way the plane tiles
 * exactly once, and the cells it reaches for are exactly the one-cell
 * neighbour ring that `pad = 2` provides.
 *
 * The Y half of that rule is easy to think you do not need. Streamed terrain
 * tiles only in XZ — a cell is a full-height column — so a version that owned
 * X and Z and emitted every vertical plane it could reach passes every test a
 * world can throw at it. A CSG volume tiles in Y as well, and there the same
 * code has vertically adjacent blocks BOTH emitting the faces in their
 * overlap: tens of thousands of duplicated and mismatched faces along every
 * horizontal block plane, invisible in a screenshot and fatal to any claim
 * that the surface is closed.
 *
 * **What this does NOT do**, and what a real swap would owe:
 * - No skirts. `addSkirts` finds boundary edges by testing whether vertices
 *   lie exactly on the cell plane, which is an MC property — DC vertices sit
 *   in cell interiors and never do. Equal-LOD neighbours agree exactly and
 *   need no skirt; an LOD TRANSITION (the HLOD ring) will crack.
 * - No manifold guarantee. One vertex per cell pinches where two surface
 *   sheets share a cell (caves, overhangs, thin walls), which breaks the
 *   "every edge is shared by exactly two triangles" property the cooked
 *   collider leans on. Manifold DC (several vertices per cell, split by
 *   surface component) is the fix and is not implemented here.
 */

import { CORNER_OFFSETS, EDGE_CORNERS } from "./tables.js";
import type { MarchOptions, MarchResult, SampledBlock } from "./marching-cubes.js";

/**
 * Exact field access, for the case where the caller HAS the function rather
 * than only a sampling of it.
 *
 * This is the single biggest quality lever in the whole file, and it is easy
 * to miss. A QEF is only as sharp as the normals fed into it, and a normal
 * taken from central differences of the SAMPLED lattice is smeared across two
 * voxels — so at the one place it matters, a hard edge, the two faces' normals
 * arrive already averaged into mush and the minimiser dutifully solves for a
 * rounded corner. Dual contouring is defined over *Hermite* data (an exact
 * crossing and an exact normal per edge) for exactly this reason.
 *
 * A CSG volume knows its own field analytically, so it supplies this and its
 * corners come out square. A streamed world does not — its field is 20 octaves
 * of noise and evaluating it four extra times per edge is the dominant cost of
 * meshing a cell — so it omits it and takes the smoothed normals, which is the
 * right trade for ground that has no hard edges to lose.
 */
export interface HermiteSource {
  /** The exact field, used to refine where along the edge the surface actually crosses. */
  value(x: number, y: number, z: number): number;
  /** The exact gradient at a point, written to `out[0..2]`. Need not be normalised. */
  gradient(x: number, y: number, z: number, out: Float64Array): void;
}

export interface DualContourOptions extends MarchOptions {
  /**
   * Exact field access. Present: crossings are refined and normals are taken
   * at the crossing itself, and hard edges survive. Absent: both come from the
   * sampled lattice, as marching cubes does.
   */
  hermite?: HermiteSource;
  /**
   * Samples of padding on each side of the block. DC needs 2 — one ring of
   * neighbour CELLS for the boundary quads, plus the sample those cells' own
   * central differences need. Anything less produces a seam.
   */
  pad?: number;
  /**
   * 1 = the QEF minimiser (sharp), 0 = the mass point (surface nets, smooth).
   * Blends between them, so one lever spans both duals.
   */
  sharpness?: number;
  /**
   * Singular values below this fraction of the largest are dropped when
   * inverting the QEF normal matrix. Higher = more willing to treat a corner
   * as a plane, i.e. rounder and more stable. 0.1 is the value from the
   * original paper.
   */
  svdTolerance?: number;
}

const EMPTY: MarchResult = {
  positions: new Float32Array(0),
  normals: new Float32Array(0),
  indices: new Uint32Array(0),
  attributes: {},
  vertexCount: 0,
  triangleCount: 0,
};

/** Perpendicular axes for each edge axis — the plane the 4 surrounding cells vary in. */
const PERP: readonly (readonly [number, number])[] = [
  [1, 2], // x-edge: cells vary in y, z
  [2, 0], // y-edge: cells vary in z, x
  [0, 1], // z-edge: cells vary in x, y
];
/** Corners of that square, in cyclic order, so the quad never comes out a bowtie. */
const RING: readonly (readonly [number, number])[] = [
  [-1, -1],
  [0, -1],
  [0, 0],
  [-1, 0],
];

/**
 * Jacobi eigendecomposition of a symmetric 3x3, then a truncated inverse.
 *
 * The QEF normal matrix is rank-deficient exactly when the cell's crossings
 * are co-planar (a flat patch: the minimiser is a plane, not a point) or
 * co-linear (an edge: a line). Truncating those directions is what keeps the
 * vertex from shooting off along them; the mass point then supplies the
 * answer in the directions the data does not constrain.
 */
function solveQef(
  ata: Float64Array, // [xx, xy, xz, yy, yz, zz]
  atb: Float64Array, // [x, y, z]
  tolerance: number,
  out: Float64Array,
): void {
  const a = [
    [ata[0]!, ata[1]!, ata[2]!],
    [ata[1]!, ata[3]!, ata[4]!],
    [ata[2]!, ata[4]!, ata[5]!],
  ];
  const v = [
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, 1],
  ];
  const pairs: readonly (readonly [number, number])[] = [
    [0, 1],
    [0, 2],
    [1, 2],
  ];
  for (let sweep = 0; sweep < 8; sweep++) {
    const off = Math.abs(a[0]![1]!) + Math.abs(a[0]![2]!) + Math.abs(a[1]![2]!);
    if (off < 1e-14) break;
    for (const pair of pairs) {
      const p = pair[0]!;
      const q = pair[1]!;
      const apq = a[p]![q]!;
      if (Math.abs(apq) < 1e-16) continue;
      const theta = (a[q]![q]! - a[p]![p]!) / (2 * apq);
      const sign = theta < 0 ? -1 : 1;
      const t = sign / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
      const c = 1 / Math.sqrt(t * t + 1);
      const s = t * c;
      for (let k = 0; k < 3; k++) {
        const akp = a[k]![p]!;
        const akq = a[k]![q]!;
        a[k]![p] = c * akp - s * akq;
        a[k]![q] = s * akp + c * akq;
      }
      for (let k = 0; k < 3; k++) {
        const apk = a[p]![k]!;
        const aqk = a[q]![k]!;
        a[p]![k] = c * apk - s * aqk;
        a[q]![k] = s * apk + c * aqk;
        const vkp = v[k]![p]!;
        const vkq = v[k]![q]!;
        v[k]![p] = c * vkp - s * vkq;
        v[k]![q] = s * vkp + c * vkq;
      }
    }
  }

  const eig = [a[0]![0]!, a[1]![1]!, a[2]![2]!];
  let maxEig = 0;
  for (const e of eig) maxEig = Math.max(maxEig, Math.abs(e));
  const cut = maxEig * tolerance;
  out[0] = 0;
  out[1] = 0;
  out[2] = 0;
  for (let k = 0; k < 3; k++) {
    const lambda = eig[k]!;
    if (Math.abs(lambda) <= cut) continue;
    const dot = v[0]![k]! * atb[0]! + v[1]![k]! * atb[1]! + v[2]![k]! * atb[2]!;
    const scale = dot / lambda;
    out[0] = out[0]! + v[0]![k]! * scale;
    out[1] = out[1]! + v[1]![k]! * scale;
    out[2] = out[2]! + v[2]![k]! * scale;
  }
}

/** Internal box-constrained QEF. Active faces/edges/corners retain the plane
 * least-squares objective; independent coordinate clamping does not. The
 * caller supplies a feasible mass point and an unconstrained displacement. */
export function constrainCellQef(ata: Float64Array, atb: Float64Array,
  mass: readonly number[], tolerance: number, out: Float64Array): void {
  if ([0,1,2].every(i => mass[i]! + out[i]! >= 0 && mass[i]! + out[i]! <= 1)) return;
  const a = [[ata[0]!,ata[1]!,ata[2]!],[ata[1]!,ata[3]!,ata[4]!],[ata[2]!,ata[4]!,ata[5]!]];
  const cost = (d: number[]) => d.reduce((s,v,i) => s + v *
    (a[i]!.reduce((t,c,j) => t+c*d[j]!,0)-2*atb[i]!),0);
  let best = [0,1,2].map(i => Math.max(0,Math.min(1,mass[i]!+out[i]!))-mass[i]!);
  let error=cost(best), distance=best.reduce((s,v)=>s+v*v,0);
  const reduced=new Float64Array(6), rhs=new Float64Array(3), solved=new Float64Array(3);
  for(let code=1;code<27;code++) {
    const state=[code%3,Math.floor(code/3)%3,Math.floor(code/9)%3];
    const fixed=state.map((s,i)=>s===0?0:(s===1?0:1)-mass[i]!);
    const entry=(i:number,j:number)=>state[i]===0&&state[j]===0?a[i]![j]!:0;
    reduced.set([entry(0,0),entry(0,1),entry(0,2),entry(1,1),entry(1,2),entry(2,2)]);
    for(let i=0;i<3;i++)rhs[i]=state[i]===0?atb[i]!-a[i]!.reduce((s,v,j)=>s+v*fixed[j]!,0):0;
    solveQef(reduced,rhs,tolerance,solved);
    const d=fixed.map((v,i)=>v+solved[i]!);
    if(d.some((v,i)=>mass[i]!+v < -1e-10 || mass[i]!+v > 1+1e-10))continue;
    const e=cost(d), length=d.reduce((s,v)=>s+v*v,0);
    if(e < error-1e-12 || (Math.abs(e-error)<=1e-12 && length<distance)) {
      best=d;error=e;distance=length;
    }
  }
  out.set(best);
}

/**
 * Contour one sampled block. Returns the same welded, outward-wound indexed
 * mesh shape `marchingCubes` does, so every consumer downstream of
 * `VoxelMesh` is unaffected by which one produced it.
 */
export function dualContour(block: SampledBlock, options: DualContourOptions = {}): MarchResult {
  const { values, nx, ny, nz, origin, step } = block;
  const iso = options.isolevel ?? 0;
  const pad = Math.max(1, Math.floor(options.pad ?? 2));
  const sharpness = options.sharpness ?? 1;
  const tolerance = options.svdTolerance ?? 0.1;

  // owned cells per axis, mirroring marching cubes' `cells = n - 2*pad - 1`
  const cellsX = nx - 2 * pad - 1;
  const cellsY = ny - 2 * pad - 1;
  const cellsZ = nz - 2 * pad - 1;
  if (cellsX < 1 || cellsY < 1 || cellsZ < 1) return EMPTY;

  const strideY = nx;
  const strideZ = nx * ny;
  const at = (i: number, j: number, k: number): number => values[i + j * strideY + k * strideZ]!;

  // Same cheap rejection as marching cubes: in a streamed world most blocks
  // are pure air or pure rock, and bailing before allocating is most of why
  // meshing a distant ring is affordable.
  let anyInside = false;
  let anyOutside = false;
  for (let i = 0; i < values.length; i++) {
    if (values[i]! < iso) anyInside = true;
    else anyOutside = true;
    if (anyInside && anyOutside) break;
  }
  if (!anyInside || !anyOutside) return EMPTY;

  const gradX = (i: number, j: number, k: number): number => at(i + 1, j, k) - at(i - 1, j, k);
  const gradY = (i: number, j: number, k: number): number => at(i, j + 1, k) - at(i, j - 1, k);
  const gradZ = (i: number, j: number, k: number): number => at(i, j, k + 1) - at(i, j, k - 1);

  const positions: number[] = [];
  const normals: number[] = [];
  const indices: number[] = [];
  const attrSpecs = Object.entries(options.attributes ?? {});
  const attrOut: Record<string, number[]> = {};
  for (const [name] of attrSpecs) attrOut[name] = [];
  const scratch = new Float32Array(16);

  // Cells that can be solved at all: every corner needs a valid central
  // difference, which bounds the cell index to [1, n-3]. With pad = 2 that is
  // exactly the owned cells plus the one-cell ring the boundary quads reach
  // into — no slack, by construction.
  const loX = 1;
  const hiX = nx - 3;
  const loY = 1;
  const hiY = ny - 3;
  const loZ = 1;
  const hiZ = nz - 3;

  /** Vertex index per cell, keyed by the cell's minimum lattice corner. -1 = none. */
  const vertexOf = new Int32Array(nx * ny * nz).fill(-1);

  const cornerValue = new Float64Array(8);
  const ata = new Float64Array(6);
  const atb = new Float64Array(3);
  const solved = new Float64Array(3);
  const crossings = new Float64Array(12 * 6); // px,py,pz,nx,ny,nz per crossing

  // An exact crossing costs field evaluations, and every lattice edge is
  // shared by up to four cells — so without this each one would be solved four
  // times. Keyed the way marching cubes keys its welded vertices: lattice
  // point * 3 + axis. Only allocated on the Hermite path, because the sampled
  // path's crossing is three subtractions and caching it would cost more than
  // recomputing it.
  const hermite = options.hermite;
  const edgeCache = hermite ? new Float64Array(values.length * 3 * 4) : null;
  const edgeSeen = hermite ? new Uint8Array(values.length * 3) : null;
  const grad = new Float64Array(3);

  for (let cz = loZ; cz <= hiZ; cz++) {
    for (let cy = loY; cy <= hiY; cy++) {
      for (let cx = loX; cx <= hiX; cx++) {
        let mask = 0;
        for (let c = 0; c < 8; c++) {
          const o = CORNER_OFFSETS[c]!;
          const value = at(cx + o[0]!, cy + o[1]!, cz + o[2]!);
          cornerValue[c] = value;
          if (value < iso) mask |= 1 << c;
        }
        if (mask === 0 || mask === 255) continue;

        let count = 0;
        let mx = 0;
        let my = 0;
        let mz = 0;
        let sumNx = 0;
        let sumNy = 0;
        let sumNz = 0;
        for (let e = 0; e < 12; e++) {
          const ends = EDGE_CORNERS[e]!;
          const ca = ends[0]!;
          const cb = ends[1]!;
          const inA = (mask & (1 << ca)) !== 0;
          const inB = (mask & (1 << cb)) !== 0;
          if (inA === inB) continue;
          const oa = CORNER_OFFSETS[ca]!;
          const ob = CORNER_OFFSETS[cb]!;
          const va = cornerValue[ca]!;
          const vb = cornerValue[cb]!;
          const denom = vb - va;
          const raw = Math.abs(denom) < 1e-12 ? 0.5 : (iso - va) / denom;
          let t = raw < 0 ? 0 : raw > 1 ? 1 : raw;
          const ia = cx + oa[0]!;
          const ja = cy + oa[1]!;
          const ka = cz + oa[2]!;
          const ib = cx + ob[0]!;
          const jb = cy + ob[1]!;
          const kb = cz + ob[2]!;

          let px: number;
          let py: number;
          let pz: number;
          let gx: number;
          let gy: number;
          let gz: number;

          if (hermite && edgeCache && edgeSeen) {
            // key this edge the way MC keys a welded vertex: lower lattice
            // point along the axis it runs, so all four cells sharing it agree
            const axis = oa[0]! !== ob[0]! ? 0 : oa[1]! !== ob[1]! ? 1 : 2;
            const li = Math.min(ia, ib);
            const lj = Math.min(ja, jb);
            const lk = Math.min(ka, kb);
            const key = (li + lj * strideY + lk * strideZ) * 3 + axis;
            if (edgeSeen[key] === 1) {
              const o = key * 4;
              // stored as the parameter along the edge plus the unit normal
              // EDGE_CORNERS may visit a shared edge in either direction.
              // Cache its parameter from the canonical low lattice endpoint,
              // then convert back to this cell's directed corner pair.
              const tt = oa[axis]! < ob[axis]! ? edgeCache[o]! : 1-edgeCache[o]!;
              px = oa[0]! + (ob[0]! - oa[0]!) * tt;
              py = oa[1]! + (ob[1]! - oa[1]!) * tt;
              pz = oa[2]! + (ob[2]! - oa[2]!) * tt;
              gx = edgeCache[o + 1]!;
              gy = edgeCache[o + 2]!;
              gz = edgeCache[o + 3]!;
            } else {
              const ax = origin[0] + ia * step;
              const ay = origin[1] + ja * step;
              const az = origin[2] + ka * step;
              const bx = origin[0] + ib * step;
              const by = origin[1] + jb * step;
              const bz = origin[2] + kb * step;
              // Refine the crossing against the REAL field. The lattice's
              // linear guess is exact only where the field is linear across
              // the edge, which is precisely not true near the feature we are
              // trying to keep.
              // The sampled corner values ARE the exact field at the corners —
              // same function — so the bracket is free and only the interior
              // samples cost anything.
              let lo = 0;
              let hi = 1;
              const loInside = va < iso;
              for (let s = 0; s < 6; s++) {
                const mid = (lo + hi) / 2;
                const f = hermite.value(ax + (bx - ax) * mid, ay + (by - ay) * mid, az + (bz - az) * mid);
                if (f < iso === loInside) lo = mid;
                else hi = mid;
              }
              t = (lo + hi) / 2;
              px = oa[0]! + (ob[0]! - oa[0]!) * t;
              py = oa[1]! + (ob[1]! - oa[1]!) * t;
              pz = oa[2]! + (ob[2]! - oa[2]!) * t;
              hermite.gradient(ax + (bx - ax) * t, ay + (by - ay) * t, az + (bz - az) * t, grad);
              gx = grad[0]!;
              gy = grad[1]!;
              gz = grad[2]!;
              const l = Math.sqrt(gx * gx + gy * gy + gz * gz);
              if (l < 1e-9) {
                gx = 0;
                gy = 1;
                gz = 0;
              } else {
                gx /= l;
                gy /= l;
                gz /= l;
              }
              const o = key * 4;
              edgeCache[o] = oa[axis]! < ob[axis]! ? t : 1-t;
              edgeCache[o + 1] = gx;
              edgeCache[o + 2] = gy;
              edgeCache[o + 3] = gz;
              edgeSeen[key] = 1;
            }
          } else {
            // Crossing in CELL-LOCAL units (0..1). The lattice is cubic, so a
            // gradient in local units has the same DIRECTION as in world units,
            // which is all the QEF needs.
            px = oa[0]! + (ob[0]! - oa[0]!) * t;
            py = oa[1]! + (ob[1]! - oa[1]!) * t;
            pz = oa[2]! + (ob[2]! - oa[2]!) * t;
            gx = gradX(ia, ja, ka) * (1 - t) + gradX(ib, jb, kb) * t;
            gy = gradY(ia, ja, ka) * (1 - t) + gradY(ib, jb, kb) * t;
            gz = gradZ(ia, ja, ka) * (1 - t) + gradZ(ib, jb, kb) * t;
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
          }
          const o = count * 6;
          crossings[o] = px;
          crossings[o + 1] = py;
          crossings[o + 2] = pz;
          crossings[o + 3] = gx;
          crossings[o + 4] = gy;
          crossings[o + 5] = gz;
          mx += px;
          my += py;
          mz += pz;
          sumNx += gx;
          sumNy += gy;
          sumNz += gz;
          count++;
        }
        if (count === 0) continue;

        mx /= count;
        my /= count;
        mz /= count;

        ata.fill(0);
        atb.fill(0);
        for (let c = 0; c < count; c++) {
          const o = c * 6;
          const gx = crossings[o + 3]!;
          const gy = crossings[o + 4]!;
          const gz = crossings[o + 5]!;
          // signed distance of this crossing's plane from the mass point
          const d = gx * (crossings[o]! - mx) + gy * (crossings[o + 1]! - my) + gz * (crossings[o + 2]! - mz);
          ata[0] = ata[0]! + gx * gx;
          ata[1] = ata[1]! + gx * gy;
          ata[2] = ata[2]! + gx * gz;
          ata[3] = ata[3]! + gy * gy;
          ata[4] = ata[4]! + gy * gz;
          ata[5] = ata[5]! + gz * gz;
          atb[0] = atb[0]! + gx * d;
          atb[1] = atb[1]! + gy * d;
          atb[2] = atb[2]! + gz * d;
        }
        solveQef(ata, atb, tolerance, solved);

        // Keep the minimizer inside the cell without pushing a diagonal
        // surface off its planes. Blend only AFTER solving the constrained
        // problem: both endpoints are feasible, so sharpness stays feasible.
        constrainCellQef(ata, atb, [mx,my,mz], tolerance, solved);
        let lx = mx + solved[0]! * sharpness;
        let ly = my + solved[1]! * sharpness;
        let lz = mz + solved[2]! * sharpness;
        lx = lx < 0 ? 0 : lx > 1 ? 1 : lx;
        ly = ly < 0 ? 0 : ly > 1 ? 1 : ly;
        lz = lz < 0 ? 0 : lz > 1 ? 1 : lz;

        const wx = origin[0] + (cx + lx) * step;
        const wy = origin[1] + (cy + ly) * step;
        const wz = origin[2] + (cz + lz) * step;
        const nlen = Math.sqrt(sumNx * sumNx + sumNy * sumNy + sumNz * sumNz);
        const vnx = nlen < 1e-9 ? 0 : sumNx / nlen;
        const vny = nlen < 1e-9 ? 1 : sumNy / nlen;
        const vnz = nlen < 1e-9 ? 0 : sumNz / nlen;

        const index = positions.length / 3;
        positions.push(wx, wy, wz);
        normals.push(vnx, vny, vnz);
        for (const [name, spec] of attrSpecs) {
          spec.compute(wx, wy, wz, vnx, vny, vnz, scratch, 0);
          const sink = attrOut[name]!;
          for (let s = 0; s < spec.size; s++) sink.push(scratch[s]!);
        }
        vertexOf[cx + cy * strideY + cz * strideZ] = index;
      }
    }
  }

  if (positions.length === 0) return EMPTY;

  const quad = new Int32Array(4);
  const cell = new Int32Array(3);
  const ownLo = pad;
  const ownHiX = pad + cellsX;
  const ownHiY = pad + cellsY;
  const ownHiZ = pad + cellsZ;

  for (let axis = 0; axis < 3; axis++) {
    const perp = PERP[axis]!;
    const p = perp[0]!;
    const q = perp[1]!;
    const di = axis === 0 ? 1 : 0;
    const dj = axis === 1 ? 1 : 0;
    const dk = axis === 2 ? 1 : 0;
    // Own the face iff its ANCHOR CELL — the minimum corner of the four cells
    // it joins — is one of ours. Anchoring to a single cell is what makes the
    // rule tile: cells belong to exactly one block, so faces do too.
    //
    // The tempting version, "own it iff all three of the edge's indices are in
    // our owned range", is subtly wrong and was the bug here. Near a block
    // CORNER a face can have its X index owned by one block and its Y index by
    // the next, so neither claims it and the face is never emitted at all.
    // It survives a two-blocks-side-by-side test (both share the other two
    // axes) and shows up only once you tile in more than one direction.
    const loI = axis === 0 ? ownLo : ownLo + 1;
    const hiI = axis === 0 ? ownHiX : ownHiX + 1;
    const loJ = axis === 1 ? ownLo : ownLo + 1;
    const hiJ = axis === 1 ? ownHiY : ownHiY + 1;
    const loK = axis === 2 ? ownLo : ownLo + 1;
    const hiK = axis === 2 ? ownHiZ : ownHiZ + 1;
    for (let k = loK; k < hiK; k++) {
      for (let j = loJ; j < hiJ; j++) {
        for (let i = loI; i < hiI; i++) {
          const inA = at(i, j, k) < iso;
          const inB = at(i + di, j + dj, k + dk) < iso;
          if (inA === inB) continue;

          let ok = true;
          for (let c = 0; c < 4; c++) {
            const ring = RING[c]!;
            cell[0] = i;
            cell[1] = j;
            cell[2] = k;
            cell[p] = cell[p]! + ring[0]!;
            cell[q] = cell[q]! + ring[1]!;
            const cxx = cell[0]!;
            const cyy = cell[1]!;
            const czz = cell[2]!;
            if (cxx < loX || cxx > hiX || cyy < loY || cyy > hiY || czz < loZ || czz > hiZ) {
              ok = false;
              break;
            }
            const vi = vertexOf[cxx + cyy * strideY + czz * strideZ]!;
            if (vi < 0) {
              ok = false;
              break;
            }
            quad[c] = vi;
          }
          if (!ok) continue;

          const a = quad[0]!;
          const b = quad[1]!;
          const c2 = quad[2]!;
          const d = quad[3]!;
          // Split on the SHORTER diagonal: the quad is not planar, and the
          // other split creases a smooth slope into shark's teeth.
          const dAC =
            (positions[a * 3]! - positions[c2 * 3]!) ** 2 +
            (positions[a * 3 + 1]! - positions[c2 * 3 + 1]!) ** 2 +
            (positions[a * 3 + 2]! - positions[c2 * 3 + 2]!) ** 2;
          const dBD =
            (positions[b * 3]! - positions[d * 3]!) ** 2 +
            (positions[b * 3 + 1]! - positions[d * 3 + 1]!) ** 2 +
            (positions[b * 3 + 2]! - positions[d * 3 + 2]!) ** 2;
          const tris = dAC <= dBD ? [a, b, c2, a, c2, d] : [b, c2, d, b, d, a];

          // RING points along +axis. Orient both triangles from the lattice
          // sign transition. Independent normal-based flips break shared-edge
          // winding at sharp/noisy joins and appear as backface-culling slits.
          for (let t = 0; t < 6; t += 3) {
            const i0 = tris[t]!;
            const i1 = tris[t + 1]!;
            const i2 = tris[t + 2]!;
            if (i0 === i1 || i1 === i2 || i0 === i2) continue;
            if (inA) indices.push(i0, i1, i2);
            else indices.push(i0, i2, i1);
          }
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


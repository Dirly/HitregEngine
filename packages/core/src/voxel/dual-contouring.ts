/**
 * Dual contouring over the same sampled scalar field marching cubes uses.
 *
 * **This is an experiment, not the shipping mesher.** It exists so the two can
 * be compared on the SAME world, in the same scene, by flipping one field —
 * see `VoxelMeshSource.mesher`. Read {@link ./marching-cubes.ts} first; the
 * sign convention (density < isolevel is SOLID) and the `SampledBlock` layout
 * are shared, and everything below is stated as a difference from it.
 *
 * MC puts a vertex on every intersected lattice EDGE. DC puts a vertex for
 * each connected surface disk inside an intersected CELL, minimising a quadratic error
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
 * - LOD steps need `clip` (below). With face ownership a dual chunk ends
 *   inside a cell, not on the chunk plane, so no skirt can close an LOD
 *   TRANSITION (the HLOD ring): measured ~850-1000 see-through probes per 3x3
 *   cliff block. Clipped to its column, the border lies on the plane and
 *   `mesh.ts` hangs in-plane skirts from it (13-200 probes, MC's level).
 * - Exact data is per world: a streamed world supplies Hermite access only
 *   where it has an analytic feature to keep (`terrain.planarCliffs`).
 * - No recovery of features invisible to the sample lattice. Separate
 *   boundary disks in one cell have separate QEF vertices, and collapsed
 *   collinear facets are triangulated conformingly without moving vertices.
 *   Thin features still require a lattice that actually samples them.
 */

import { CORNER_OFFSETS, EDGE_CORNERS, EDGE_LATTICE, MC_TRIANGLES } from "./tables.js";
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
  /**
   * Optional gate, in this block's lattice indices: true where the sampled
   * value IS `value` at that lattice point. An edge is refined only when both
   * its ends are active (an ambiguous face only when all four corners are);
   * everything else takes the sampled path. This is what lets a field supply
   * exact data for one feature (a planar cliff band) without having to be
   * exact everywhere (caves, blobs and band cuts stay sampled).
   */
  activeAt?(i: number, j: number, k: number): boolean;
}

export interface DualContourOptions extends MarchOptions {
  /**
   * Shared lattice origin and this block's INTEGER sample offset from it.
   * Supply samples using origin + (offset + index) * step as well. This keeps
   * shared points bit-identical at non-binary steps: separately rounded block
   * origins can otherwise choose different Hermite faces at a sharp join.
   */
  lattice?: { origin: readonly [number, number, number]; offset: readonly [number, number, number] };
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
  /**
   * World-space XZ column this block's surface is CLIPPED to, replacing face
   * ownership on X and Z. Every reachable quad is emitted and cut exactly at
   * the column's planes, so the mesh ends ON the chunk boundary the way a
   * marching-cubes chunk does — which is what lets the MC skirts hang from it
   * and close an LOD step. Neighbours clip the same triangles from opposite
   * sides with the same arithmetic (intersections are computed from the
   * lexicographically lower endpoint), so equal-LOD seams stay bit-exact.
   * Y keeps the ownership rule (streamed terrain is one band per column).
   */
  clip?: { x: readonly [number, number]; z: readonly [number, number] };
  /**
   * Radians. Where a cell's crossing normals spread wider than this, its vertex
   * is split into one copy per normal cluster and each quad takes the copy that
   * holds its own edge's normal, so a rim or a strata ledge SHADES sharp instead
   * of being smoothed across. Cell-local and deterministic, so neighbouring
   * chunks agree. 0 / omitted = one averaged normal per vertex (the old look).
   */
  creaseAngle?: number;
  /**
   * Bisection steps when refining a Hermite crossing (default 6, then the
   * bracket's midpoint). Setting it switches the finish to a SECANT step inside
   * the last bracket, which is exact on a piecewise-planar field, so 3 steps +
   * secant beats 6 steps of bisection at half the field evaluations.
   */
  hermiteSteps?: number;
  /**
   * Cosine. With a Hermite source, an edge whose two ends' SAMPLED gradients agree closer than
   * this takes the cheap sampled crossing instead (smooth there: nothing for the exact path to
   * sharpen). Omit = every active edge is refined.
   */
  hermiteGate?: number;
}

// Scratch buffers kept between dualContour calls (synchronous, never re-entered), grown on demand and
// handed out as exact-length views.
const pools = new Map<string, Int32Array | Uint8Array | Float64Array>();
function pooled<T extends Int32Array | Uint8Array | Float64Array>(name: string, n: number, make: (n: number) => T): T {
  let buf = pools.get(name) as T | undefined;
  if (!buf || buf.length < n) { buf = make(Math.ceil(n * 1.25)); pools.set(name, buf); }
  return buf.subarray(0, n) as T;
}
const scratchI32 = (name: string, n: number): Int32Array => pooled(name, n, (k) => new Int32Array(k));
const scratchU8 = (name: string, n: number): Uint8Array => pooled(name, n, (k) => new Uint8Array(k));
const scratchF64 = (name: string, n: number): Float64Array => pooled(name, n, (k) => new Float64Array(k));

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

// The derived marching-cubes table already makes a consistent connectivity
// decision on every shared face. Dualise each separate surface disk instead
// of pinching all disks in an ambiguous cell into one QEF vertex.
const SURFACE_COMPONENTS = MC_TRIANGLES.map((triangles) => {
  const parent = Array.from({ length: 12 }, (_, i) => i), present = new Set<number>();
  const root = (i: number): number => { while (parent[i] !== i) i = parent[i]!; return i; };
  for (let i = 0; i < triangles.length; i += 3) {
    const a = triangles[i]!, b = triangles[i + 1]!, c = triangles[i + 2]!;
    present.add(a); present.add(b); present.add(c); parent[root(b)] = root(a); parent[root(c)] = root(a);
  }
  const groups = new Map<number, number[]>();
  for (const edge of [...present].sort((a, b) => a - b)) { const key = root(edge), group = groups.get(key) ?? []; group.push(edge); groups.set(key, group); }
  return [...groups.values()];
});
const LOCAL_EDGE = new Int8Array(24).fill(-1);
for (let e = 0; e < EDGE_LATTICE.length; e++) {
  const [x, y, z, axis] = EDGE_LATTICE[e]!;
  LOCAL_EDGE[axis * 8 + x + y * 2 + z * 4] = e;
}
const FACE_PAIRS = MC_TRIANGLES.map((triangles, mask) => {
  const pairs = new Int8Array(72).fill(-1), segments = new Map<string, { a: number; b: number; count: number }>();
  for (let i = 0; i < triangles.length; i += 3) for (let e = 0; e < 3; e++) {
    const a = triangles[i + e]!, b = triangles[i + (e + 1) % 3]!, key = a < b ? `${a}:${b}` : `${b}:${a}`;
    const segment = segments.get(key) ?? { a, b, count: 0 }; segment.count++; segments.set(key, segment);
  }
  for (let axis = 0; axis < 3; axis++) for (let side = 0; side < 2; side++) {
    const edges = EDGE_CORNERS.map((ends, edge) => ({ ends, edge })).filter(({ ends }) => CORNER_OFFSETS[ends[0]]![axis] === side && CORNER_OFFSETS[ends[1]]![axis] === side && ((mask >> ends[0]) & 1) !== ((mask >> ends[1]) & 1)).map(({ edge }) => edge);
    if (edges.length !== 4) continue;
    for (const segment of segments.values()) if (segment.count === 1 && edges.includes(segment.a) && edges.includes(segment.b)) {
      pairs[(axis * 2 + side) * 12 + segment.a] = segment.b; pairs[(axis * 2 + side) * 12 + segment.b] = segment.a;
    }
  }
  return pairs;
});
const AMBIGUOUS_CASE = FACE_PAIRS.map((pairs) => pairs.some((e) => e >= 0));
const CELL_FACES = [
  { corners: [0, 3, 7, 4], edges: [3, 11, 7, 8] },
  { corners: [1, 5, 6, 2], edges: [9, 5, 10, 1] },
  { corners: [0, 1, 2, 3], edges: [0, 1, 2, 3] },
  { corners: [4, 7, 6, 5], edges: [7, 6, 5, 4] },
  { corners: [0, 4, 5, 1], edges: [8, 4, 9, 0] },
  { corners: [3, 2, 6, 7], edges: [2, 10, 6, 11] },
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
  // Scalars, not nested arrays: this runs once per surface component (thousands per cell block), and the
  // three small arrays it used to allocate per call were a visible share of the mesher's garbage.
  let a00 = ata[0]!, a01 = ata[1]!, a02 = ata[2]!, a11 = ata[3]!, a12 = ata[4]!, a22 = ata[5]!;
  let v00 = 1, v01 = 0, v02 = 0, v10 = 0, v11 = 1, v12 = 0, v20 = 0, v21 = 0, v22 = 1;
  for (let sweep = 0; sweep < 8; sweep++) {
    const off = Math.abs(a01) + Math.abs(a02) + Math.abs(a12);
    if (off < 1e-14) break;
    // pair (0, 1)
    if (Math.abs(a01) >= 1e-16) {
      const theta = (a11 - a00) / (2 * a01), t = (theta < 0 ? -1 : 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
      const c = 1 / Math.sqrt(t * t + 1), s = t * c;
      const n00 = c * c * a00 - 2 * s * c * a01 + s * s * a11, n11 = s * s * a00 + 2 * s * c * a01 + c * c * a11;
      const n02 = c * a02 - s * a12, n12 = s * a02 + c * a12;
      a00 = n00; a11 = n11; a01 = 0; a02 = n02; a12 = n12;
      let p = v00, q = v01; v00 = c * p - s * q; v01 = s * p + c * q;
      p = v10; q = v11; v10 = c * p - s * q; v11 = s * p + c * q;
      p = v20; q = v21; v20 = c * p - s * q; v21 = s * p + c * q;
    }
    // pair (0, 2)
    if (Math.abs(a02) >= 1e-16) {
      const theta = (a22 - a00) / (2 * a02), t = (theta < 0 ? -1 : 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
      const c = 1 / Math.sqrt(t * t + 1), s = t * c;
      const n00 = c * c * a00 - 2 * s * c * a02 + s * s * a22, n22 = s * s * a00 + 2 * s * c * a02 + c * c * a22;
      const n01 = c * a01 - s * a12, n12 = s * a01 + c * a12;
      a00 = n00; a22 = n22; a02 = 0; a01 = n01; a12 = n12;
      let p = v00, q = v02; v00 = c * p - s * q; v02 = s * p + c * q;
      p = v10; q = v12; v10 = c * p - s * q; v12 = s * p + c * q;
      p = v20; q = v22; v20 = c * p - s * q; v22 = s * p + c * q;
    }
    // pair (1, 2)
    if (Math.abs(a12) >= 1e-16) {
      const theta = (a22 - a11) / (2 * a12), t = (theta < 0 ? -1 : 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
      const c = 1 / Math.sqrt(t * t + 1), s = t * c;
      const n11 = c * c * a11 - 2 * s * c * a12 + s * s * a22, n22 = s * s * a11 + 2 * s * c * a12 + c * c * a22;
      const n01 = c * a01 - s * a02, n02 = s * a01 + c * a02;
      a11 = n11; a22 = n22; a12 = 0; a01 = n01; a02 = n02;
      let p = v01, q = v02; v01 = c * p - s * q; v02 = s * p + c * q;
      p = v11; q = v12; v11 = c * p - s * q; v12 = s * p + c * q;
      p = v21; q = v22; v21 = c * p - s * q; v22 = s * p + c * q;
    }
  }
  const maxEig = Math.max(Math.abs(a00), Math.abs(a11), Math.abs(a22));
  const cut = maxEig * tolerance;
  const b0 = atb[0]!, b1 = atb[1]!, b2 = atb[2]!;
  let o0 = 0, o1 = 0, o2 = 0;
  if (Math.abs(a00) > cut) { const k = (v00 * b0 + v10 * b1 + v20 * b2) / a00; o0 += v00 * k; o1 += v10 * k; o2 += v20 * k; }
  if (Math.abs(a11) > cut) { const k = (v01 * b0 + v11 * b1 + v21 * b2) / a11; o0 += v01 * k; o1 += v11 * k; o2 += v21 * k; }
  if (Math.abs(a22) > cut) { const k = (v02 * b0 + v12 * b1 + v22 * b2) / a22; o0 += v02 * k; o1 += v12 * k; o2 += v22 * k; }
  out[0] = o0; out[1] = o1; out[2] = o2;
}

/** Internal box-constrained QEF. Active faces/edges/corners retain the plane
 * least-squares objective; independent coordinate clamping does not. The
 * caller supplies a feasible mass point and an unconstrained displacement. */
export function constrainCellQef(ata: Float64Array, atb: Float64Array,
  mass: readonly number[], tolerance: number, out: Float64Array): void {
  { const x = mass[0]! + out[0]!, y = mass[1]! + out[1]!, z = mass[2]! + out[2]!; if (x >= 0 && x <= 1 && y >= 0 && y <= 1 && z >= 0 && z <= 1) return; }
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
  const latticeOrigin = options.lattice?.origin ?? origin, latticeOffset = options.lattice?.offset ?? [0, 0, 0];
  const world = (axis: number, index: number, fraction = 0): number => latticeOrigin[axis]! + (latticeOffset[axis]! + index + fraction) * step;

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
  // Attributes (on terrain: the whole biome stack per vertex) are DEFERRED: each vertex records where its
  // values come from — computed at its own exact position and normal (-1), or copied from vertex n — and only
  // the vertices that survive clipping and compaction are evaluated. A clipped cell builds a ring of vertices
  // outside its column that the clip then throws away; evaluating them eagerly was ~15% of the attribute cost.
  const attrSrc: number[] = [];
  const apos: number[] = [];
  const scratch = new Float32Array(Math.max(16, ...attrSpecs.map(([, spec]) => spec.size)));

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
  const vertexOf = scratchI32("vertexOf", nx * ny * nz).fill(-1);
  const splitVertices = new Map<number, Int32Array>();
  const cellMasks = scratchU8("cellMasks", nx * ny * nz); // read only where a vertex was written
  const ambiguousCrossings = new Map<number, Float64Array>();
  const resolvedFacePairs = new Map<number, Int8Array>();

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
  const clip = options.clip;
  const bisectSteps = Math.max(1, Math.floor(options.hermiteSteps ?? 6));
  const secant = options.hermiteSteps !== undefined;
  // Reused between calls (the mesher is synchronous): a fresh 12-float-per-sample cache was ~7 MB of zeroed
  // memory per cell. Only `edgeSeen` needs clearing; `edgeCache` is read only where it says so.
  const edgeCache = hermite ? scratchF64("edgeCache", values.length * 3 * 4) : null;
  const edgeSeen = hermite ? scratchU8("edgeSeen", values.length * 3).fill(0) : null;
  const grad = new Float64Array(3);
  // Skip the exact path where the sampled field is visibly smooth across an edge: the two
  // ends' lattice gradients agree, so the crossing and normal the samples give are already
  // right and there is no corner for the QEF to find. A pure function of lattice values, so
  // both chunks sharing the edge decide alike.
  const gateCos = options.hermiteGate ?? -2;
  const smoothEdge = (ia: number, ja: number, ka: number, ib: number, jb: number, kb: number): boolean => {
    if (gateCos < -1) return false;
    const ax = gradX(ia, ja, ka), ay = gradY(ia, ja, ka), az = gradZ(ia, ja, ka), bx = gradX(ib, jb, kb), by = gradY(ib, jb, kb), bz = gradZ(ib, jb, kb);
    const la = Math.sqrt(ax * ax + ay * ay + az * az), lb = Math.sqrt(bx * bx + by * by + bz * bz);
    return la > 1e-9 && lb > 1e-9 && (ax * bx + ay * by + az * bz) / (la * lb) > gateCos;
  };
  const crease = (options.creaseAngle ?? 0) > 0;
  const creaseCos = Math.cos(options.creaseAngle ?? 0);
  /** Per crease-split cell: local edge -> the normal-cluster copy of its vertex. Topology still uses the base vertex. */
  const creaseOf = new Map<number, Int32Array>();

  const resolveComponents = (mask: number, cx: number, cy: number, cz: number, key: number): number[][] => {
    if (!AMBIGUOUS_CASE[mask]) return SURFACE_COMPONENTS[mask]!;
    const parent = Array.from({ length: 12 }, (_, i) => i), present = new Set<number>(), pairs = new Int8Array(72).fill(-1);
    const root = (e: number): number => { while (parent[e] !== e) e = parent[e]!; return e; };
    const connect = (a: number, b: number): void => { present.add(a); present.add(b); parent[root(b)] = root(a); };
    for (let f = 0; f < CELL_FACES.length; f++) {
      const face = CELL_FACES[f]!, crossing: number[] = [];
      for (let i = 0; i < 4; i++) if (((mask >> face.corners[i]!) & 1) !== ((mask >> face.corners[(i + 1) % 4]!) & 1)) crossing.push(face.edges[i]!);
      if (crossing.length === 2) connect(crossing[0]!, crossing[1]!);
      else if (crossing.length === 4) {
        const axis = Math.floor(f / 2), side = f % 2;
        const exact = hermite && (!hermite.activeAt || face.corners.every((c) => { const o = CORNER_OFFSETS[c]!; return hermite.activeAt!(cx + o[0]!, cy + o[1]!, cz + o[2]!); }));
        const value = exact ? hermite.value(world(0, cx, axis === 0 ? side : 0.5), world(1, cy, axis === 1 ? side : 0.5), world(2, cz, axis === 2 ? side : 0.5)) : face.corners.reduce((sum, c) => sum + cornerValue[c]!, 0) / 4;
        const centerInside = value < iso;
        // Connect around corners opposite the face centre's sign. A static
        // choice can join two different source planes across a real air gap,
        // making both component QEFs collapse to their false intersection.
        // Both cells ask the same canonical shared face, so this decision
        // cannot create a seam or depend on which block is meshed first.
        for (let i = 0; i < 4; i++) if (((mask >> face.corners[i]!) & 1) !== Number(centerInside)) {
          const a = face.edges[(i + 3) % 4]!, b = face.edges[i]!;
          connect(a, b); pairs[f * 12 + a] = b; pairs[f * 12 + b] = a;
        }
      }
    }
    const groups = new Map<number, number[]>();
    for (const edge of [...present].sort((a, b) => a - b)) { const r = root(edge), group = groups.get(r) ?? []; group.push(edge); groups.set(r, group); }
    resolvedFacePairs.set(key, pairs);
    return [...groups.values()];
  };

  // Per sample column: the lowest and highest row where the sign flips going up. Outside that span a column is
  // one sign (its bottom sample's below, its top's above), so where four columns agree on both, every cell
  // outside the union of their spans is pure rock or pure air: a streamed cell is a tall band with the surface
  // in a few rows of it, and this is most of the lattice skipped without reading a corner.
  const columns = nx * nz;
  const flipLo = new Int32Array(columns).fill(ny), flipHi = new Int32Array(columns).fill(-1);
  const bottomIn = new Uint8Array(columns), topIn = new Uint8Array(columns);
  for (let k = 0; k < nz; k++) for (let i = 0; i < nx; i++) {
    const c = i + k * nx;
    let prev = at(i, 0, k) < iso;
    bottomIn[c] = prev ? 1 : 0;
    for (let j = 1; j < ny; j++) {
      const cur = at(i, j, k) < iso;
      if (cur !== prev) { if (flipLo[c] === ny) flipLo[c] = j - 1; flipHi[c] = j - 1; }
      prev = cur;
    }
    topIn[c] = prev ? 1 : 0;
  }
  /** Rows [lo, hi] a cell column (or an edge between columns) can hold a crossing in, for columns a..d. */
  const span = new Int32Array(2);
  const spanOf = (a: number, b: number, c: number, d: number): Int32Array => {
    if (bottomIn[a] !== bottomIn[b] || bottomIn[a] !== bottomIn[c] || bottomIn[a] !== bottomIn[d] || topIn[a] !== topIn[b] || topIn[a] !== topIn[c] || topIn[a] !== topIn[d]) {
      span[0] = 0; span[1] = ny; return span;
    }
    span[0] = Math.min(flipLo[a]!, flipLo[b]!, flipLo[c]!, flipLo[d]!);
    span[1] = Math.max(flipHi[a]!, flipHi[b]!, flipHi[c]!, flipHi[d]!);
    return span;
  };
  const cellLo = new Int32Array(columns), cellHi = new Int32Array(columns);
  for (let cz = loZ; cz <= hiZ; cz++) for (let cx = loX; cx <= hiX; cx++) {
    const c = cx + cz * nx, s = spanOf(c, c + 1, c + nx, c + nx + 1);
    cellLo[c] = s[0]!; cellHi[c] = s[1]!;
  }

  for (let cz = loZ; cz <= hiZ; cz++) {
    for (let cy = loY; cy <= hiY; cy++) {
      for (let cx = loX; cx <= hiX; cx++) {
        const cc = cx + cz * nx;
        if (cy < cellLo[cc]! || cy > cellHi[cc]!) continue;
        let mask = 0;
        for (let c = 0; c < 8; c++) {
          const o = CORNER_OFFSETS[c]!;
          const value = at(cx + o[0]!, cy + o[1]!, cz + o[2]!);
          cornerValue[c] = value;
          if (value < iso) mask |= 1 << c;
        }
        if (mask === 0 || mask === 255) continue;

        let count = 0;
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

          if (hermite && edgeCache && edgeSeen && (!hermite.activeAt || (hermite.activeAt(ia, ja, ka) && hermite.activeAt(ib, jb, kb))) && !smoothEdge(ia, ja, ka, ib, jb, kb)) {
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
              const ax = world(0, ia);
              const ay = world(1, ja);
              const az = world(2, ka);
              const bx = world(0, ib);
              const by = world(1, jb);
              const bz = world(2, kb);
              // Refine the crossing against the REAL field. The lattice's
              // linear guess is exact only where the field is linear across
              // the edge, which is precisely not true near the feature we are
              // trying to keep.
              // The sampled corner values ARE the exact field at the corners —
              // same function — so the bracket is free and only the interior
              // samples cost anything.
              let lo = 0;
              let hi = 1;
              let flo = va, fhi = vb;
              const loInside = va < iso;
              for (let s = 0; s < bisectSteps; s++) {
                const mid = (lo + hi) / 2;
                const f = hermite.value(ax + (bx - ax) * mid, ay + (by - ay) * mid, az + (bz - az) * mid);
                if (f < iso === loInside) { lo = mid; flo = f; }
                else { hi = mid; fhi = f; }
              }
              // secant finish: exact wherever the field is linear across the
              // remaining bracket — which a planar field is, between its creases
              t = secant && Math.abs(fhi - flo) > 1e-12 ? lo + ((hi - lo) * (iso - flo)) / (fhi - flo) : (lo + hi) / 2;
              if (!(t >= lo && t <= hi)) t = (lo + hi) / 2;
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
          const o = e * 6;
          crossings[o] = px;
          crossings[o + 1] = py;
          crossings[o + 2] = pz;
          crossings[o + 3] = gx;
          crossings[o + 4] = gy;
          crossings[o + 5] = gz;
          count++;
        }
        if (count === 0) continue;
        const cellKey = cx + cy * strideY + cz * strideZ;
        const components = resolveComponents(mask, cx, cy, cz, cellKey);
        cellMasks[cellKey] = mask;
        if (AMBIGUOUS_CASE[mask]) ambiguousCrossings.set(cellKey, crossings.slice());
        const split = components.length > 1 ? new Int32Array(12).fill(-1) : undefined;
        if (split) splitVertices.set(cellKey, split);
        for (const component of components) {
        count = component.length;
        let mx = 0, my = 0, mz = 0, sumNx = 0, sumNy = 0, sumNz = 0;
        for (const edge of component) {
          const o = edge * 6;
          mx += crossings[o]!; my += crossings[o + 1]!; mz += crossings[o + 2]!;
          sumNx += crossings[o + 3]!; sumNy += crossings[o + 4]!; sumNz += crossings[o + 5]!;
        }
        mx /= count;
        my /= count;
        mz /= count;

        ata.fill(0);
        atb.fill(0);
        for (const edge of component) {
          const o = edge * 6;
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

        const wx = world(0, cx, lx);
        const wy = world(1, cy, ly);
        const wz = world(2, cz, lz);
        const nlen = Math.sqrt(sumNx * sumNx + sumNy * sumNy + sumNz * sumNz);
        const vnx = nlen < 1e-9 ? 0 : sumNx / nlen;
        const vny = nlen < 1e-9 ? 1 : sumNy / nlen;
        const vnz = nlen < 1e-9 ? 0 : sumNz / nlen;

        const index = positions.length / 3;
        // Faces are tested in the same Float32 geometry that consumers get.
        // An exact constrained QEF may put adjacent cell vertices at the
        // same corner; the resulting collapsed face has no area to emit.
        positions.push(Math.fround(wx), Math.fround(wy), Math.fround(wz));
        normals.push(vnx, vny, vnz);
        attrSrc.push(-1);
        apos.push(wx, wy, wz);
        vertexOf[cellKey] = index;
        if (split) for (const edge of component) split[edge] = index;
        if (crease && component.length > 1) {
          // Greedy clusters in edge order (deterministic: both chunks see the
          // same crossings for a shared cell, so they split it identically).
          const seeds: number[] = [], sums: number[] = [], members: number[][] = [];
          for (const edge of component) {
            const o = edge * 6, ex = crossings[o + 3]!, ey = crossings[o + 4]!, ez = crossings[o + 5]!;
            let g = 0;
            for (; g < members.length; g++) if (seeds[g * 3]! * ex + seeds[g * 3 + 1]! * ey + seeds[g * 3 + 2]! * ez >= creaseCos) break;
            if (g === members.length) { seeds.push(ex, ey, ez); sums.push(0, 0, 0); members.push([]); }
            sums[g * 3] = sums[g * 3]! + ex; sums[g * 3 + 1] = sums[g * 3 + 1]! + ey; sums[g * 3 + 2] = sums[g * 3 + 2]! + ez;
            members[g]!.push(edge);
          }
          if (members.length > 1) {
            const map = creaseOf.get(cellKey) ?? new Int32Array(12).fill(-1);
            for (let g = 0; g < members.length; g++) {
              const l = Math.hypot(sums[g * 3]!, sums[g * 3 + 1]!, sums[g * 3 + 2]!) || 1;
              const gnx = sums[g * 3]! / l, gny = sums[g * 3 + 1]! / l, gnz = sums[g * 3 + 2]! / l;
              const copy = positions.length / 3;
              positions.push(Math.fround(wx), Math.fround(wy), Math.fround(wz));
              normals.push(gnx, gny, gnz);
              // Attributes are a function of position and normal; a copy whose normal is
              // close to the base one (two facets of one face) reuses the base's rather
              // than paying for another evaluation (on terrain: the whole biome stack).
              const reuse = Math.abs(gny - vny) < 0.06 && Math.abs(gnx - vnx) < 0.25 && Math.abs(gnz - vnz) < 0.25;
              attrSrc.push(reuse ? index : -1);
              apos.push(wx, wy, wz);
              for (const edge of members[g]!) map[edge] = copy;
            }
            creaseOf.set(cellKey, map);
          }
        }
        }
      }
    }
  }

  if (positions.length === 0) return EMPTY;

  const quad = new Int32Array(4);
  const quadCells: Int32Array[] = Array.from({ length: 4 }, () => new Int32Array(5));
  const extra = new Int32Array(4);
  const faceVertices = new Map<string, number>();
  const collinearPoints = new Map<string, number>();
  const pointKey = (i: number): string => `${positions[i * 3]},${positions[i * 3 + 1]},${positions[i * 3 + 2]}`;
  const areaSq = (a: number, b: number, c: number): number => {
    const ux = positions[b * 3]! - positions[a * 3]!, uy = positions[b * 3 + 1]! - positions[a * 3 + 1]!, uz = positions[b * 3 + 2]! - positions[a * 3 + 2]!;
    const vx = positions[c * 3]! - positions[a * 3]!, vy = positions[c * 3 + 1]! - positions[a * 3 + 1]!, vz = positions[c * 3 + 2]! - positions[a * 3 + 2]!;
    return (uy * vz - uz * vy) ** 2 + (uz * vx - ux * vz) ** 2 + (ux * vy - uy * vx) ** 2;
  };
  const emitTriangle = (i0: number, i1: number, i2: number, outward: boolean): void => {
    if (i0 === i1 || i1 === i2 || i0 === i2) return;
    if (areaSq(i0, i1, i2) === 0) {
      const keys = [pointKey(i0), pointKey(i1), pointKey(i2)];
      if (new Set(keys).size === 3) {
        collinearPoints.set(keys[0]!, i0); collinearPoints.set(keys[1]!, i1); collinearPoints.set(keys[2]!, i2);
      }
      return;
    }
    if (outward) indices.push(i0, i1, i2); else indices.push(i0, i2, i1);
  };
  const appendVertex = (position: readonly number[], normal: readonly number[], cell: ArrayLike<number>): number => {
    const wx = world(0, cell[0]!, position[0]!), wy = world(1, cell[1]!, position[1]!), wz = world(2, cell[2]!, position[2]!);
    const length = Math.hypot(...normal), nx = length ? normal[0]! / length : 0, ny = length ? normal[1]! / length : 1, nz = length ? normal[2]! / length : 0;
    const index = positions.length / 3;
    positions.push(Math.fround(wx), Math.fround(wy), Math.fround(wz)); normals.push(nx, ny, nz);
    attrSrc.push(-1);
    apos.push(wx, wy, wz);
    return index;
  };
  const vertexForEdge = (key: number, edge: number): number => splitVertices.get(key)?.[edge] ?? vertexOf[key]!;
  const faceVertex = (c: number, fixedAxis: number, side: number): number => {
    const cellA = quadCells[c]!, cellB = quadCells[(c + 1) % 4]!, keyA = cellA[3]!, keyB = cellB[3]!, edge = cellA[4]!;
    const pairs = resolvedFacePairs.get(keyA) ?? FACE_PAIRS[cellMasks[keyA]!]!, base = (fixedAxis * 2 + side) * 12, paired = pairs[base + edge]!;
    if (paired < 0) return -1;
    let other = -1;
    for (let e = 0; e < 12; e++) if (e !== edge && e !== paired && pairs[base + e]! >= 0) { other = e; break; }
    if (other < 0 || vertexForEdge(keyA, other) !== quad[c]) return -1;
    const lattice = EDGE_LATTICE[other]!;
    const otherB = LOCAL_EDGE[lattice[3] * 8 + cellA[0]! + lattice[0] - cellB[0]! + (cellA[1]! + lattice[1] - cellB[1]!) * 2 + (cellA[2]! + lattice[2] - cellB[2]!) * 4]!;
    if (vertexForEdge(keyB, otherB) !== quad[(c + 1) % 4]) return -1;
    // Two distinct arcs on this face would otherwise become the same indexed
    // edge. Give each arc its own constrained face QEF vertex. Only this
    // parallel-edge case needs the extra vertex; ordinary DC quads stay intact.
    const edgeKey = (e: number): number => { const o = EDGE_LATTICE[e]!; return ((cellA[0]! + o[0]) + (cellA[1]! + o[1]) * strideY + (cellA[2]! + o[2]) * strideZ) * 3 + o[3]; };
    const ka = edgeKey(edge), kb = edgeKey(paired), key = ka < kb ? `${ka}:${kb}` : `${kb}:${ka}`, cached = faceVertices.get(key);
    if (cached !== undefined) return cached;
    const data = ambiguousCrossings.get(keyA)!, mass = [0, 1, 2].map((a) => (data[edge * 6 + a]! + data[paired * 6 + a]!) / 2), normal = [0, 0, 0];
    ata.fill(0); atb.fill(0);
    for (const e of [edge, paired]) {
      const o = e * 6, n = [data[o + 3]!, data[o + 4]!, data[o + 5]!];
      for (let a = 0; a < 3; a++) normal[a] = normal[a]! + n[a]!;
      n[fixedAxis] = 0;
      const d = n[0]! * (data[o]! - mass[0]!) + n[1]! * (data[o + 1]! - mass[1]!) + n[2]! * (data[o + 2]! - mass[2]!);
      ata[0] = ata[0]! + n[0]! ** 2; ata[1] = ata[1]! + n[0]! * n[1]!; ata[2] = ata[2]! + n[0]! * n[2]!;
      ata[3] = ata[3]! + n[1]! ** 2; ata[4] = ata[4]! + n[1]! * n[2]!; ata[5] = ata[5]! + n[2]! ** 2;
      for (let a = 0; a < 3; a++) atb[a] = atb[a]! + n[a]! * d;
    }
    solveQef(ata, atb, tolerance, solved); constrainCellQef(ata, atb, mass, tolerance, solved);
    const point = mass.map((v, a) => Math.min(1, Math.max(0, v + solved[a]! * sharpness))); point[fixedAxis] = side;
    const index = appendVertex(point, normal, cellA); faceVertices.set(key, index); return index;
  };
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
    // Clip mode: X and Z emit everything that can reach the column (one face
    // past the owned range each way) and the clip pass below trims it.
    const loI = clip ? ownLo - 1 : axis === 0 ? ownLo : ownLo + 1;
    const hiI = clip ? ownHiX + 2 : axis === 0 ? ownHiX : ownHiX + 1;
    const loJ = axis === 1 ? ownLo : ownLo + 1;
    const hiJ = axis === 1 ? ownHiY : ownHiY + 1;
    const loK = clip ? ownLo - 1 : axis === 2 ? ownLo : ownLo + 1;
    const hiK = clip ? ownHiZ + 2 : axis === 2 ? ownHiZ : ownHiZ + 1;
    for (let k = loK; k < hiK; k++) {
      for (let i = loI; i < hiI; i++) {
        // only the rows where this edge's two columns can differ (see flipLo/flipHi)
        const ca = i + k * nx, cb = ca + di + dk * nx;
        const agree = bottomIn[ca] === bottomIn[cb] && topIn[ca] === topIn[cb];
        const j0 = agree ? Math.max(loJ, Math.min(flipLo[ca]!, flipLo[cb]!)) : loJ;
        const j1 = agree ? Math.min(hiJ - 1, Math.max(flipHi[ca]!, flipHi[cb]!)) : hiJ - 1;
        for (let j = j0; j <= j1; j++) {
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
            const cellKey = cxx + cyy * strideY + czz * strideZ;
            const split = splitVertices.get(cellKey);
            const localEdge = LOCAL_EDGE[axis * 8 + i - cxx + (j - cyy) * 2 + (k - czz) * 4]!;
            const vi = split ? split[localEdge]! : vertexOf[cellKey]!;
            if (vi < 0) {
              ok = false;
              break;
            }
            quad[c] = vi;
            const qc = quadCells[c]!;
            qc[0] = cxx; qc[1] = cyy; qc[2] = czz; qc[3] = cellKey; qc[4] = localEdge;
          }
          if (!ok) continue;

          extra[0] = faceVertex(0, p, 1); extra[1] = faceVertex(1, q, 1); extra[2] = faceVertex(2, p, 0); extra[3] = faceVertex(3, q, 0);
          if (extra[0]! >= 0 || extra[1]! >= 0 || extra[2]! >= 0 || extra[3]! >= 0) {
            const polygon: number[] = [];
            for (let c = 0; c < 4; c++) { polygon.push(quad[c]!); if (extra[c]! >= 0) polygon.push(extra[c]!); }
            const cell = quadCells[0]!, data = ambiguousCrossings.get(cell[3]!);
            // The lattice-edge crossing is already a Hermite constraint and
            // is interior to the dual face. A fan through it keeps every
            // inserted face arc in both neighbouring polygons' boundaries.
            const dataCell = data ? cell : quadCells.find((c) => ambiguousCrossings.has(c[3]!))!;
            const crossing = ambiguousCrossings.get(dataCell[3]!)!, offset = dataCell[4]! * 6;
            const center = appendVertex(Array.from(crossing.slice(offset, offset + 3)), Array.from(crossing.slice(offset + 3, offset + 6)), dataCell);
            for (let c = 0; c < polygon.length; c++) emitTriangle(polygon[c]!, polygon[(c + 1) % polygon.length]!, center, inA);
            continue;
          }

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
          // Coincident opposite corners make the boundary double back along
          // both remaining edges. The other diagonal would manufacture two
          // identical, oppositely wound triangles from this zero-area quad.
          if (dAC === 0 || dBD === 0) continue;
          const areaAC = Math.min(areaSq(a, b, c2), areaSq(a, c2, d)), areaBD = Math.min(areaSq(b, c2, d), areaSq(b, d, a));
          const useAC = areaAC === 0 && areaBD > 0 ? false : areaBD === 0 && areaAC > 0 ? true : dAC <= dBD;
          let ra = a, rb = b, rc = c2, rd = d;
          if (creaseOf.size) {
            // Same positions, so every decision above stands; only the normal
            // (and the attributes computed from it) changes per quad.
            const copyOf = (c: number): number => { const qc = quadCells[c]!, copy = creaseOf.get(qc[3]!)?.[qc[4]!] ?? -1; return copy >= 0 ? copy : quad[c]!; };
            ra = copyOf(0); rb = copyOf(1); rc = copyOf(2); rd = copyOf(3);
          }

          // RING points along +axis. Orient both triangles from the lattice
          // sign transition. Independent normal-based flips break shared-edge
          // winding at sharp/noisy joins and appear as backface-culling slits.
          if (useAC) { emitTriangle(ra, rb, rc, inA); emitTriangle(ra, rc, rd, inA); }
          else { emitTriangle(rb, rc, rd, inA); emitTriangle(rb, rd, ra, inA); }
        }
      }
    }
  }

  // A collapsed collinear triangle can leave A--C on one real facet and
  // A--B--C on its neighbour. Subdivide the former at the EXISTING point B.
  // This is exact conforming triangulation, not a displaced QEF, smoothing,
  // welding tolerance, or a cap across an actual hole.
  if (collinearPoints.size) {
    const candidates = [...collinearPoints.values()];
    const pointOnEdge = (a: number, b: number): number => {
      if (!collinearPoints.has(pointKey(a)) && !collinearPoints.has(pointKey(b))) return -1;
      const ax = positions[a * 3]!, ay = positions[a * 3 + 1]!, az = positions[a * 3 + 2]!;
      const dx = positions[b * 3]! - ax, dy = positions[b * 3 + 1]! - ay, dz = positions[b * 3 + 2]! - az, lengthSq = dx * dx + dy * dy + dz * dz;
      for (const p of candidates) {
        const px = positions[p * 3]! - ax, py = positions[p * 3 + 1]! - ay, pz = positions[p * 3 + 2]! - az;
        const along = px * dx + py * dy + pz * dz;
        if (along > 0 && along < lengthSq && py * dz - pz * dy === 0 && pz * dx - px * dz === 0 && px * dy - py * dx === 0) return p;
      }
      return -1;
    };
    const conforming: number[] = [];
    for (let i = 0; i < indices.length; i += 3) {
      const pending: number[][] = [[indices[i]!, indices[i + 1]!, indices[i + 2]!]];
      while (pending.length) {
        const triangle = pending.pop()!;
        let split = false;
        for (let e = 0; e < 3; e++) {
          const a = triangle[e]!, b = triangle[(e + 1) % 3]!, c = triangle[(e + 2) % 3]!, p = pointOnEdge(a, b);
          if (p < 0) continue;
          pending.push([a, p, c], [p, b, c]); split = true; break;
        }
        if (!split) conforming.push(...triangle);
      }
    }
    indices.length = 0;
    for (const i of conforming) indices.push(i);
  }

  if (clip) {
    clipToColumn(positions, normals, [], indices, clip);
    // vertices the clip made sit on the column plane: evaluated there, from their own position and normal
    for (let v = attrSrc.length; v < positions.length / 3; v++) { attrSrc.push(-1); apos.push(positions[v * 3]!, positions[v * 3 + 1]!, positions[v * 3 + 2]!); }
  }
  if (indices.length === 0) return EMPTY;
  let order: Int32Array | null = null; // new vertex -> old vertex, when compacted
  if (clip || creaseOf.size) {
    // Clipped-away triangles and crease-split base vertices leave orphans;
    // the one shared mesh carries none (same rule as the skirts).
    const remap = new Int32Array(positions.length / 3).fill(-1);
    let kept = 0;
    for (const i of indices) if (remap[i] === -1) remap[i] = -2;
    for (let v = 0; v < remap.length; v++) if (remap[v] === -2) remap[v] = kept++;
    if (kept < remap.length) {
      const P = new Float32Array(kept * 3), N = new Float32Array(kept * 3);
      order = new Int32Array(kept);
      for (let v = 0; v < remap.length; v++) {
        const to = remap[v]!;
        if (to < 0) continue;
        order[to] = v;
        for (let c = 0; c < 3; c++) { P[to * 3 + c] = positions[v * 3 + c]!; N[to * 3 + c] = normals[v * 3 + c]!; }
      }
      for (let i = 0; i < indices.length; i++) indices[i] = remap[indices[i]!]!;
      const attributes = evaluateAttributes(attrSpecs, attrSrc, apos, normals, order, scratch);
      return { positions: P, normals: N, indices: Uint32Array.from(indices), attributes, vertexCount: kept, triangleCount: indices.length / 3 };
    }
  }
  const attributes = evaluateAttributes(attrSpecs, attrSrc, apos, normals, order, scratch);
  return {
    positions: Float32Array.from(positions),
    normals: Float32Array.from(normals),
    indices: Uint32Array.from(indices),
    attributes,
    vertexCount: positions.length / 3,
    triangleCount: indices.length / 3,
  };
}

/** Evaluate the deferred attributes of the kept vertices (`order[new] = old`; null = all, in order). */
function evaluateAttributes(
  specs: [string, { size: number; compute: (x: number, y: number, z: number, nx: number, ny: number, nz: number, out: Float32Array, offset: number) => void }][],
  src: readonly number[],
  apos: readonly number[],
  normals: readonly number[],
  order: Int32Array | null,
  scratch: Float32Array,
): Record<string, Float32Array> {
  const out: Record<string, Float32Array> = {};
  const n = order ? order.length : src.length;
  for (const [name, spec] of specs) {
    const size = spec.size, data = new Float32Array(n * size);
    /** old vertex -> its row in `data` (kept ones) or in `extra` (a dropped base a copy reads) */
    const row = new Map<number, number>();
    if (order) for (let i = 0; i < n; i++) row.set(order[i]!, i);
    const extra: Float32Array[] = [];
    const valueOf = (v: number): Float32Array | number => {
      const r = row.get(v);
      if (r !== undefined || !order) return r ?? v;
      const tmp = new Float32Array(size);
      spec.compute(apos[v * 3]!, apos[v * 3 + 1]!, apos[v * 3 + 2]!, normals[v * 3]!, normals[v * 3 + 1]!, normals[v * 3 + 2]!, tmp, 0);
      extra.push(tmp);
      return tmp;
    };
    // own evaluations first, then the copies (a copy's base is always an own evaluation)
    for (let i = 0; i < n; i++) {
      const v = order ? order[i]! : i;
      if (src[v] !== -1) continue;
      spec.compute(apos[v * 3]!, apos[v * 3 + 1]!, apos[v * 3 + 2]!, normals[v * 3]!, normals[v * 3 + 1]!, normals[v * 3 + 2]!, scratch, 0);
      data.set(scratch.subarray(0, size), i * size);
    }
    for (let i = 0; i < n; i++) {
      const v = order ? order[i]! : i;
      const from = src[v]!;
      if (from === -1) continue;
      const got = valueOf(from);
      if (typeof got === "number") data.copyWithin(i * size, got * size, got * size + size);
      else data.set(got, i * size);
    }
    out[name] = data;
  }
  return out;
}

/**
 * Cut every triangle to the column [x0,x1] x [z0,z1] (Sutherland-Hodgman, in
 * place). Seam exactness is the whole point, so an intersection is computed
 * from the lexicographically LOWER endpoint of its segment: the chunk on the
 * other side of the plane cuts the same segment with the same arithmetic and
 * gets the same bits. A polygon lying IN a high plane belongs to the next
 * column (half-open), so a facet coinciding with a chunk plane is not emitted twice.
 */
function clipToColumn(
  positions: number[],
  normals: number[],
  attrs: { data: number[]; size: number }[],
  indices: number[],
  clip: { x: readonly [number, number]; z: readonly [number, number] },
): void {
  const planes = [
    { a: 0, v: clip.x[0], ge: true },
    { a: 0, v: clip.x[1], ge: false },
    { a: 2, v: clip.z[0], ge: true },
    { a: 2, v: clip.z[1], ge: false },
  ];
  // nothing near a plane: the common case for an interior triangle, decided without allocating
  const minX = clip.x[0], maxX = clip.x[1], minZ = clip.z[0], maxZ = clip.z[1];
  const cache = new Map<string, number>();
  const lexLess = (i: number, j: number): boolean => {
    for (let c = 0; c < 3; c++) { const d = positions[i * 3 + c]! - positions[j * 3 + c]!; if (d !== 0) return d < 0; }
    return i < j;
  };
  const cut = (i: number, j: number, p: number): number => {
    const key = i < j ? `${p}:${i}:${j}` : `${p}:${j}:${i}`;
    const hit = cache.get(key);
    if (hit !== undefined) return hit;
    const { a, v } = planes[p]!;
    const [A, B] = lexLess(i, j) ? [i, j] : [j, i];
    const pa = positions[A * 3 + a]!, pb = positions[B * 3 + a]!;
    const t = (v - pa) / (pb - pa);
    let index: number;
    if (t <= 0) index = A;
    else if (t >= 1) index = B;
    else {
      index = positions.length / 3;
      for (let c = 0; c < 3; c++) positions.push(c === a ? v : Math.fround(positions[A * 3 + c]! + (positions[B * 3 + c]! - positions[A * 3 + c]!) * t));
      let nx = normals[A * 3]! + (normals[B * 3]! - normals[A * 3]!) * t;
      let ny = normals[A * 3 + 1]! + (normals[B * 3 + 1]! - normals[A * 3 + 1]!) * t;
      let nz = normals[A * 3 + 2]! + (normals[B * 3 + 2]! - normals[A * 3 + 2]!) * t;
      const l = Math.hypot(nx, ny, nz) || 1; nx /= l; ny /= l; nz /= l;
      normals.push(nx, ny, nz);
      for (const at of attrs) for (let c = 0; c < at.size; c++) at.data.push(at.data[A * at.size + c]! + (at.data[B * at.size + c]! - at.data[A * at.size + c]!) * t);
    }
    cache.set(key, index);
    return index;
  };
  const out: number[] = [];
  const areaZero = (a: number, b: number, c: number): boolean => {
    const ux = positions[b * 3]! - positions[a * 3]!, uy = positions[b * 3 + 1]! - positions[a * 3 + 1]!, uz = positions[b * 3 + 2]! - positions[a * 3 + 2]!;
    const vx = positions[c * 3]! - positions[a * 3]!, vy = positions[c * 3 + 1]! - positions[a * 3 + 1]!, vz = positions[c * 3 + 2]! - positions[a * 3 + 2]!;
    return uy * vz - uz * vy === 0 && uz * vx - ux * vz === 0 && ux * vy - uy * vx === 0;
  };
  for (let t = 0; t < indices.length; t += 3) {
    const i0 = indices[t]!, i1 = indices[t + 1]!, i2 = indices[t + 2]!;
    const xs = [positions[i0 * 3]!, positions[i1 * 3]!, positions[i2 * 3]!], zs = [positions[i0 * 3 + 2]!, positions[i1 * 3 + 2]!, positions[i2 * 3 + 2]!];
    const lox = Math.min(...xs), hix = Math.max(...xs), loz = Math.min(...zs), hiz = Math.max(...zs);
    if (hix < minX || lox > maxX || hiz < minZ || loz > maxZ) continue; // wholly outside
    if ((lox === hix && lox === maxX) || (loz === hiz && loz === maxZ)) continue; // lies in a high plane: the neighbour's
    if (lox > minX && hix < maxX && loz > minZ && hiz < maxZ) { out.push(i0, i1, i2); continue; } // wholly inside
    let poly = [i0, i1, i2];
    for (let p = 0; p < planes.length && poly.length >= 3; p++) {
      const { a, v, ge } = planes[p]!;
      const inside = (i: number): boolean => (ge ? positions[i * 3 + a]! >= v : positions[i * 3 + a]! <= v);
      const next: number[] = [];
      for (let e = 0; e < poly.length; e++) {
        const s = poly[e]!, f = poly[(e + 1) % poly.length]!;
        const sIn = inside(s), fIn = inside(f);
        if (fIn) {
          if (!sIn) next.push(cut(s, f, p));
          next.push(f);
        } else if (sIn) next.push(cut(s, f, p));
      }
      poly = next.filter((v2, k) => v2 !== next[(k + 1) % next.length]);
    }
    if (poly.length < 3) continue;
    if (poly.every((i) => positions[i * 3]! === maxX) || poly.every((i) => positions[i * 3 + 2]! === maxZ)) continue;
    for (let k = 1; k + 1 < poly.length; k++) if (!areaZero(poly[0]!, poly[k]!, poly[k + 1]!)) out.push(poly[0]!, poly[k]!, poly[k + 1]!);
  }
  indices.length = 0;
  for (const i of out) indices.push(i);
}


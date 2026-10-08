/**
 * Raster height patches, evaluated so that their EDGES survive the 2 m voxel
 * lattice.
 *
 * The terrain is drawn by sampling the heightfield at the lattice and
 * interpolating between samples. A height change narrower than the lattice
 * spacing cannot be drawn: every lattice column lands either on the top or
 * on the bottom of it, and a diagonal step becomes a row of 2 m teeth (the
 * sawtooth snow ledge, FixJaggies.PNG). Two places made such steps:
 *
 *  - the blend at the patch's own edge: a pad several metres above the
 *    ground with a 1.5 m `blend` is a cliff 1.5 m wide;
 *  - the raster itself: a 1 m raster with a cliff drawn into it.
 *
 * So the edge feather is never narrower than two lattice steps and, by
 * default, wide enough that the blend is no steeper than `edgeSlope` for the
 * height the patch actually differs from the ground at that edge; and the
 * raster is prefiltered with a tent at least as wide as the lattice step
 * (a supersampled, anti-aliased read). Outside the footprint nothing changes:
 * the weight is still exactly 0 with a zero derivative on the boundary.
 */
import type { HeightPatchDoc } from "./recipe.js";

/** Default steepest rise/run of the edge blend (45 degrees). */
export const PATCH_EDGE_SLOPE = 1;
/** Max slope of a smoothstep is 1.5 * rise / width. */
const SMOOTHSTEP_PEAK = 1.5;

export interface PreparedHeightPatch {
  readonly doc: HeightPatchDoc;
  /** Per-edge feather in metres: [west (x0), east (x1), north (z0), south (z1)]. */
  readonly feather: readonly [number, number, number, number];
  /** Filter half-width actually applied to the raster, metres (0 = raw). */
  readonly filter: number;
  /** Blend of this patch over `under` at (x, z); returns `under` outside. */
  apply(x: number, z: number, under: number): number;
  /** The (filtered) raster height at (x, z), clamped to the footprint. */
  raster(x: number, z: number): number;
  /** Blend weight in [0, 1]; 0 outside and on the boundary. */
  weight(x: number, z: number): number;
}

function smoothstep(a: number, b: number, x: number): number {
  if (b <= a) return x >= b ? 1 : 0;
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

/** Separable tent filter of `radius` SAMPLES over a row-major raster; edges renormalise. */
export function tentFilterRaster(heights: ArrayLike<number>, columns: number, rows: number, rx: number, rz: number): Float64Array {
  const src = Float64Array.from(heights as ArrayLike<number>);
  const pass = (data: Float64Array, r: number, alongX: boolean): Float64Array => {
    if (r < 0.5) return data;
    const k = Math.ceil(r);
    const w: number[] = [];
    for (let o = -k; o <= k; o++) w.push(Math.max(0, 1 - Math.abs(o) / (r + 1)));
    const out = new Float64Array(data.length);
    const n = alongX ? columns : rows;
    const m = alongX ? rows : columns;
    for (let j = 0; j < m; j++) {
      for (let i = 0; i < n; i++) {
        let s = 0, ws = 0;
        for (let o = -k; o <= k; o++) {
          const q = i + o;
          if (q < 0 || q >= n) continue;
          const wt = w[o + k]!;
          s += wt * data[alongX ? j * columns + q : q * columns + j]!;
          ws += wt;
        }
        out[alongX ? j * columns + i : i * columns + j] = s / ws;
      }
    }
    return out;
  };
  return pass(pass(src, rx, true), rz, false);
}

/**
 * Fill the foot of every riser steeper than `slope` (rise/run) into a talus:
 * h'(p) = max over q of h(q) - slope * |p - q|, by two chamfer sweeps
 * (8-neighbour, an octagonal cone). Raises only, so every top stays put.
 */
export function slopeLimitRaster(heights: ArrayLike<number>, columns: number, rows: number, cellX: number, cellZ: number, slope: number): Float64Array {
  const h = Float64Array.from(heights as ArrayLike<number>);
  const dx = slope * cellX, dz = slope * cellZ, dd = slope * Math.hypot(cellX, cellZ);
  for (let iter = 0; iter < 2; iter++) {
    for (let j = 0; j < rows; j++) for (let i = 0; i < columns; i++) {
      const k = j * columns + i;
      let v = h[k]!;
      if (i > 0) v = Math.max(v, h[k - 1]! - dx);
      if (j > 0) {
        v = Math.max(v, h[k - columns]! - dz);
        if (i > 0) v = Math.max(v, h[k - columns - 1]! - dd);
        if (i < columns - 1) v = Math.max(v, h[k - columns + 1]! - dd);
      }
      h[k] = v;
    }
    for (let j = rows - 1; j >= 0; j--) for (let i = columns - 1; i >= 0; i--) {
      const k = j * columns + i;
      let v = h[k]!;
      if (i < columns - 1) v = Math.max(v, h[k + 1]! - dx);
      if (j < rows - 1) {
        v = Math.max(v, h[k + columns]! - dz);
        if (i < columns - 1) v = Math.max(v, h[k + columns + 1]! - dd);
        if (i > 0) v = Math.max(v, h[k + columns - 1]! - dd);
      }
      h[k] = v;
    }
  }
  return h;
}

/**
 * Prepare one patch. `under(x, z)` is the ground BEFORE this patch (earlier
 * patches included); it is only read along the boundary, once, to size the
 * automatic feather. `voxelSize` is the lattice step.
 */
export function prepareHeightPatch(doc: HeightPatchDoc, voxelSize: number, under: (x: number, z: number) => number): PreparedHeightPatch {
  const [sx, sz] = doc.size;
  const cols = doc.columns, rows = doc.rows;
  const cellX = sx / (cols - 1), cellZ = sz / (rows - 1);
  const filter = doc.filter ?? voxelSize;
  const limited = doc.maxSlope !== undefined ? slopeLimitRaster(doc.heights, cols, rows, cellX, cellZ, doc.maxSlope) : doc.heights;
  const h = filter > 0 ? tentFilterRaster(limited, cols, rows, filter / cellX, filter / cellZ) : Float64Array.from(limited);

  const raster = (x: number, z: number): number => {
    const dx = Math.min(sx, Math.max(0, x - doc.origin[0]));
    const dz = Math.min(sz, Math.max(0, z - doc.origin[1]));
    const u = (dx / sx) * (cols - 1), v = (dz / sz) * (rows - 1);
    const col = Math.min(cols - 2, Math.floor(u)), row = Math.min(rows - 2, Math.floor(v));
    const fx = u - col, fz = v - row, i = row * cols + col;
    const a = h[i]! + (h[i + 1]! - h[i]!) * fx;
    const b = h[i + cols]! + (h[i + cols + 1]! - h[i + cols]!) * fx;
    return a + (b - a) * fz;
  };

  // Feather per edge. Explicit `feather` wins; otherwise the widest of the
  // authored blend, two lattice steps, and what keeps the blend no steeper
  // than `edgeSlope` for the largest height difference along that edge.
  const minFeather = 2 * voxelSize;
  const edgeSlope = doc.edgeSlope ?? PATCH_EDGE_SLOPE;
  const capX = sx / 2, capZ = sz / 2;
  const mismatch = (edge: 0 | 1 | 2 | 3): number => {
    const alongX = edge >= 2; // north/south edges run along X
    const len = alongX ? sx : sz;
    const n = Math.max(2, Math.ceil(len / Math.max(0.5, voxelSize)) + 1);
    let worst = 0;
    for (let s = 0; s < n; s++) {
      const t = (s / (n - 1)) * len;
      const x = alongX ? doc.origin[0] + t : edge === 0 ? doc.origin[0] : doc.origin[0] + sx;
      const z = alongX ? (edge === 2 ? doc.origin[1] : doc.origin[1] + sz) : doc.origin[1] + t;
      const d = Math.abs(raster(x, z) - under(x, z));
      if (d > worst) worst = d;
    }
    return worst;
  };
  const featherFor = (edge: 0 | 1 | 2 | 3): number => {
    const cap = edge < 2 ? capX : capZ;
    if (doc.feather !== undefined) return Math.min(cap, Math.max(doc.blend, doc.feather));
    const need = (SMOOTHSTEP_PEAK * mismatch(edge)) / Math.max(0.05, edgeSlope);
    return Math.min(cap, Math.max(doc.blend, minFeather, need));
  };
  const feather: [number, number, number, number] = [featherFor(0), featherFor(1), featherFor(2), featherFor(3)];

  const weight = (x: number, z: number): number => {
    const dx = x - doc.origin[0], dz = z - doc.origin[1];
    if (dx <= 0 || dz <= 0 || dx >= sx || dz >= sz) return 0;
    return Math.min(
      smoothstep(0, feather[0], dx),
      smoothstep(0, feather[1], sx - dx),
      smoothstep(0, feather[2], dz),
      smoothstep(0, feather[3], sz - dz),
    );
  };

  return {
    doc,
    feather,
    filter: Math.max(0, filter),
    raster,
    weight,
    apply(x, z, out) {
      const w = weight(x, z);
      return w <= 0 ? out : out + (raster(x, z) - out) * w;
    },
  };
}

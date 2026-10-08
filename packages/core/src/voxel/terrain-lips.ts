/**
 * The LIP / SAWTOOTH gate: does an edit (a height patch, a road cut) make
 * ground the 2 m voxel lattice cannot draw?
 *
 * The terrain mesh is, near enough, the heightfield sampled at the lattice
 * and interpolated between samples. So the drawn ground is the bilinear
 * reconstruction of the lattice samples, and everything the field holds that
 * the reconstruction misses is either thrown away or drawn as teeth:
 *
 *  - ALIAS: the true field at a cell's centre / edge midpoints differs from
 *    the reconstruction by more than `aliasTol` - a step sharper than the
 *    grid; along a diagonal edge these are the sawtooth teeth.
 *  - STEP: two neighbouring lattice samples differ by more than
 *    `maxSlope * step` - a wall cut into the ground by an edit (a deep path
 *    cut with a narrow shoulder, a pad edge with a short blend).
 *  - LIP: a lattice sample standing above (or sunk below) both of its
 *    neighbours along x or z by more than `lipTol` - a raised rim or a slot
 *    one sample wide along an edge.
 *
 * Every measure is taken on the edited field AND on a `reference` field (the
 * same world without the edits under test) and only the EXCESS counts, so a
 * natural cliff is not a fault of the patch beside it. Pure: no DOM, no I/O.
 */
import type { WorldField } from "./field.js";

export interface TerrainLipOptions {
  /** World-space rectangle to measure. */
  x0: number;
  z0: number;
  x1: number;
  z1: number;
  /** Lattice step; default the field's voxel size. */
  step?: number;
  /** Reconstruction error (m) above the reference's that counts as an alias. Default 0.5. */
  aliasTol?: number;
  /** Rise/run between neighbouring lattice samples that counts as a step. Default 1.6 (58 deg). */
  maxSlope?: number;
  /** One-sample rim/slot height (m) above the reference's that counts as a lip. Default 0.75. */
  lipTol?: number;
  /** Where |edited - reference| is below this (m) at all four corners, the cell is untouched. Default 0.15. */
  touched?: number;
  /** Optional mask: only cells whose centre passes are measured (e.g. "near a patch edge"). */
  include?: (x: number, z: number) => boolean;
}

export type TerrainLipKind = "alias" | "step" | "lip";

export interface TerrainLipFault {
  kind: TerrainLipKind;
  x: number;
  z: number;
  /** Size of the fault in metres (excess error, step height, or ridge height). */
  size: number;
}

export interface TerrainLipReport {
  cells: number;
  touchedCells: number;
  faults: TerrainLipFault[];
  counts: Record<TerrainLipKind, number>;
  worst: Record<TerrainLipKind, number>;
  /** Longest run of 8-connected faulty cells: a sawtooth along an edge is a long run. */
  longestRun: number;
}

/** Lattice-reconstructed ("drawn") height from a sampled grid. */
function bilinear(h00: number, h10: number, h01: number, h11: number, fx: number, fz: number): number {
  const a = h00 + (h10 - h00) * fx;
  const b = h01 + (h11 - h01) * fx;
  return a + (b - a) * fz;
}

/**
 * Height of the DRAWN ground at (x, z): the field sampled at the four lattice
 * corners around the point, interpolated. Within the error of the mesher's
 * triangulation, this is what a player stands on and what a slab sits on.
 */
export function latticeHeight(field: Pick<WorldField, "height" | "voxelSize">, x: number, z: number, step = field.voxelSize): number {
  const i = Math.floor(x / step), j = Math.floor(z / step);
  const x0 = i * step, z0 = j * step;
  return bilinear(field.height(x0, z0), field.height(x0 + step, z0), field.height(x0, z0 + step), field.height(x0 + step, z0 + step), (x - x0) / step, (z - z0) / step);
}

export function measureTerrainLips(
  field: Pick<WorldField, "height" | "voxelSize">,
  reference: Pick<WorldField, "height">,
  options: TerrainLipOptions,
): TerrainLipReport {
  const s = options.step ?? field.voxelSize;
  const aliasTol = options.aliasTol ?? 0.5;
  const maxSlope = options.maxSlope ?? 1.6;
  const lipTol = options.lipTol ?? 0.75;
  const touchedTol = options.touched ?? 0.15;
  const i0 = Math.floor(options.x0 / s) - 1, i1 = Math.ceil(options.x1 / s) + 1;
  const j0 = Math.floor(options.z0 / s) - 1, j1 = Math.ceil(options.z1 / s) + 1;
  const nx = i1 - i0 + 1, nz = j1 - j0 + 1;
  // lattice samples, taken lazily: a road's band is a thin strip of its box
  const E = new Float64Array(nx * nz).fill(NaN), R = new Float64Array(nx * nz).fill(NaN);
  const at = (g: Float64Array, i: number, j: number): number => {
    const k = i + j * nx;
    let v = g[k]!;
    if (Number.isNaN(v)) {
      v = (g === E ? field : reference).height((i0 + i) * s, (j0 + j) * s);
      g[k] = v;
    }
    return v;
  };
  const faults: TerrainLipFault[] = [];
  const counts: Record<TerrainLipKind, number> = { alias: 0, step: 0, lip: 0 };
  const worst: Record<TerrainLipKind, number> = { alias: 0, step: 0, lip: 0 };
  const bad = new Uint8Array(nx * nz);
  let cells = 0, touchedCells = 0;
  const add = (kind: TerrainLipKind, i: number, j: number, size: number): void => {
    faults.push({ kind, x: (i0 + i + 0.5) * s, z: (j0 + j + 0.5) * s, size: Math.round(size * 100) / 100 });
    counts[kind]++;
    if (size > worst[kind]) worst[kind] = size;
    bad[i + j * nx] = 1;
  };
  const mids: [number, number][] = [[0.5, 0.5], [0.5, 0], [0, 0.5], [0.25, 0.25], [0.75, 0.75], [0.25, 0.75], [0.75, 0.25]];
  for (let j = 1; j < nz - 2; j++) {
    for (let i = 1; i < nx - 2; i++) {
      const cx = (i0 + i) * s, cz = (j0 + j) * s;
      if (cx + s < options.x0 || cx > options.x1 || cz + s < options.z0 || cz > options.z1) continue;
      if (options.include && !options.include(cx + s / 2, cz + s / 2)) continue;
      cells++;
      let touched = false;
      for (const [a, b] of [[0, 0], [1, 0], [0, 1], [1, 1]] as const) {
        if (Math.abs(at(E, i + a, j + b) - at(R, i + a, j + b)) > touchedTol) touched = true;
      }
      if (!touched) continue;
      touchedCells++;
      // ALIAS: what the lattice cannot draw
      let excess = 0;
      for (const [fx, fz] of mids) {
        const x = cx + fx * s, z = cz + fz * s;
        const e = Math.abs(field.height(x, z) - bilinear(at(E, i, j), at(E, i + 1, j), at(E, i, j + 1), at(E, i + 1, j + 1), fx, fz));
        const r = Math.abs(reference.height(x, z) - bilinear(at(R, i, j), at(R, i + 1, j), at(R, i, j + 1), at(R, i + 1, j + 1), fx, fz));
        excess = Math.max(excess, e - r);
      }
      if (excess > aliasTol) add("alias", i, j, excess);
      // STEP: a wall between neighbouring samples that the reference does not have
      let step = 0;
      for (const [a, b, c, d] of [[0, 0, 1, 0], [0, 0, 0, 1], [1, 0, 1, 1], [0, 1, 1, 1]] as const) {
        const de = Math.abs(at(E, i + a, j + b) - at(E, i + c, j + d));
        const dr = Math.abs(at(R, i + a, j + b) - at(R, i + c, j + d));
        if (de > maxSlope * s && de > dr + 0.5) step = Math.max(step, de);
      }
      if (step > 0) add("step", i, j, step);
      // LIP: a one-sample rim or slot - a sample standing above (or sunk
      // below) BOTH neighbours along x or z. A crease (flat into a slope) is
      // not a lip; only a sign change is.
      const spike = (c: number, p: number, q: number): number => Math.max(0, Math.min(c - p, c - q), Math.min(p - c, q - c));
      const rim = (g: Float64Array, ax: number, az: number): number =>
        Math.max(spike(at(g, ax, az), at(g, ax - 1, az), at(g, ax + 1, az)), spike(at(g, ax, az), at(g, ax, az - 1), at(g, ax, az + 1)));
      const lip = rim(E, i, j) - rim(R, i, j);
      if (lip > lipTol) add("lip", i, j, lip);
    }
  }
  // longest 8-connected run of faulty cells
  let longestRun = 0;
  const seen = new Uint8Array(nx * nz);
  const stack: number[] = [];
  for (let k = 0; k < bad.length; k++) {
    if (!bad[k] || seen[k]) continue;
    let n = 0;
    stack.push(k);
    seen[k] = 1;
    while (stack.length) {
      const q = stack.pop()!;
      n++;
      const qi = q % nx, qj = (q - qi) / nx;
      for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
        const pi = qi + di, pj = qj + dj;
        if (pi < 0 || pj < 0 || pi >= nx || pj >= nz) continue;
        const p = pi + pj * nx;
        if (bad[p] && !seen[p]) { seen[p] = 1; stack.push(p); }
      }
    }
    longestRun = Math.max(longestRun, n);
  }
  for (const k of Object.keys(worst) as TerrainLipKind[]) worst[k] = Math.round(worst[k] * 100) / 100;
  return { cells, touchedCells, faults, counts, worst, longestRun };
}

export interface SeatReport {
  /** Largest gap (m) between the base and the drawn ground below it (base floating). */
  gap: number;
  /** Largest depth (m) the drawn ground rises above the base (terrain clipping through). */
  clip: number;
  samples: number;
}

/**
 * Is a built slab SEATED? Samples the drawn ground (`latticeHeight`) along
 * the perimeter of its footprint (a rotated rectangle, centre + half extents
 * + yaw) and compares it with the slab's base height `baseY`. `gap`: ground
 * below the base (it hangs); `clip`: ground above the base (terrain shows
 * through, or the slab is sunk).
 */
export function seatReport(
  field: Pick<WorldField, "height" | "voxelSize">,
  slab: { x: number; z: number; halfX: number; halfZ: number; yaw?: number; baseY: number },
  spacing = 1,
): SeatReport {
  const c = Math.cos(slab.yaw ?? 0), sn = Math.sin(slab.yaw ?? 0);
  let gap = 0, clip = 0, samples = 0;
  const visit = (lx: number, lz: number): void => {
    const x = slab.x + lx * c + lz * sn, z = slab.z - lx * sn + lz * c;
    const g = latticeHeight(field, x, z);
    samples++;
    gap = Math.max(gap, slab.baseY - g);
    clip = Math.max(clip, g - slab.baseY);
  };
  const nx = Math.max(1, Math.ceil((2 * slab.halfX) / spacing)), nz = Math.max(1, Math.ceil((2 * slab.halfZ) / spacing));
  for (let k = 0; k <= nx; k++) { const lx = -slab.halfX + (2 * slab.halfX * k) / nx; visit(lx, -slab.halfZ); visit(lx, slab.halfZ); }
  for (let k = 1; k < nz; k++) { const lz = -slab.halfZ + (2 * slab.halfZ * k) / nz; visit(-slab.halfX, lz); visit(slab.halfX, lz); }
  return { gap: Math.round(Math.max(0, gap) * 100) / 100, clip: Math.round(Math.max(0, clip) * 100) / 100, samples };
}

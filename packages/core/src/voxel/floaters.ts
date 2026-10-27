/**
 * FLOATERS — solid voxels hanging in open air, cut off from the ground mass (overhang noise on a steep river bank,
 * the sliver a carve leaves behind). The mesher draws each as a small rock bobbing in the air.
 *
 * `findFloaters` labels the solid lattice samples of a box (6-connected by default: marching cubes draws a piece that
 * touches the ground only across an edge or corner as its own floating island — measured on the Weepwater banks, the
 * 26-connected pass left 1 of 14 visible pieces, the 6-connected one 0; `connect: 26` keeps such pieces) and returns every component that is NOT grounded and smaller than `keepVoxels`.
 * Grounded = it reaches the box floor (sampled below the lowest ground) or the lateral MARGIN ring (it continues into
 * the neighbouring chunk, so it is not known to float: kept). A component is reported by the chunk that owns its
 * lowest-index cell, so chunks swept side by side never report one twice.
 *
 * The removal is DATA: `features.floaterClears` (lattice cells forced to air by the field, point query and mesher
 * alike). `floaterClearKey` is the lattice key both sides use.
 */
import type { WorldField } from "./field.js";

export interface FloaterBox {
  x0: number;
  z0: number;
  x1: number;
  z1: number;
}

export interface FloaterComponent {
  /** Lattice cells (gx, gy, gz triples; world = index * voxelSize). */
  cells: number[];
  size: number;
  /** World centre of the component's bounding box. */
  centre: [number, number, number];
}

export interface FloaterScan {
  floaters: FloaterComponent[];
  /** Solid components seen (grounded + floating + too big to clear). */
  components: number;
  /** Floating components kept because they are >= keepVoxels (a deliberate floating mass is a design call). */
  bigFloating: number;
  samples: number;
  ms: number;
}

/** The lattice key of cell (gx, gy, gz) — exact for |g| < 50,000. */
export function floaterClearKey(gx: number, gy: number, gz: number): number {
  return ((gx + 50000) * 100000 + (gy + 50000)) * 100000 + (gz + 50000);
}

/** Every cleared cell of a recipe's `features.floaterClears`, as lattice keys. */
export function floaterClearSet(clears: readonly { cells: readonly number[] }[] | undefined): Set<number> {
  const set = new Set<number>();
  for (const c of clears ?? []) for (let i = 0; i + 2 < c.cells.length; i += 3) set.add(floaterClearKey(c.cells[i]!, c.cells[i + 1]!, c.cells[i + 2]!));
  return set;
}

/**
 * Scan one box. `margin` (voxels) is the ring sampled around it so a piece that crosses the box edge is judged with
 * its neighbour; `yLo`/`yHi` override the vertical band (default: the field's height range, 8 m below, 24 m above).
 */
export function findFloaters(
  field: Pick<WorldField, "sampleBlock" | "heightRange" | "voxelSize">,
  box: FloaterBox,
  options: { keepVoxels?: number; margin?: number; yLo?: number; yHi?: number; connect?: 6 | 26 } = {},
): FloaterScan {
  const t0 = Date.now();
  const v = field.voxelSize;
  const keep = options.keepVoxels ?? 64;
  const m = options.margin ?? 6;
  const face = (options.connect ?? 6) === 6;
  const gx0 = Math.floor(box.x0 / v) - m, gz0 = Math.floor(box.z0 / v) - m;
  const gx1 = Math.ceil(box.x1 / v) + m, gz1 = Math.ceil(box.z1 / v) + m;
  const range = field.heightRange(gx0 * v, gz0 * v, gx1 * v, gz1 * v, Math.max(9, Math.ceil((gx1 - gx0) / 8)));
  const gy0 = Math.floor((options.yLo ?? range.min - 8) / v);
  const gy1 = Math.ceil((options.yHi ?? range.max + 24) / v);
  const nx = gx1 - gx0 + 1, ny = gy1 - gy0 + 1, nz = gz1 - gz0 + 1;
  const values = field.sampleBlock({ origin: [gx0 * v, gy0 * v, gz0 * v], nx, ny, nz, step: v });
  const sz = nx * ny;
  const label = new Int32Array(values.length).fill(-1);
  const floaters: FloaterComponent[] = [];
  let components = 0, bigFloating = 0;
  const stack: number[] = [];
  const members: number[] = [];
  // the inner box (owned cells), in block indices
  const ix0 = m, iz0 = m, ix1 = nx - 1 - m, iz1 = nz - 1 - m;
  for (let start = 0; start < values.length; start++) {
    if (!(values[start]! < 0) || label[start]! >= 0) continue;
    const id = components++;
    label[start] = id;
    stack.length = 0;
    members.length = 0;
    stack.push(start);
    let grounded = false;
    while (stack.length) {
      const p = stack.pop()!;
      members.push(p);
      const k = Math.floor(p / sz), r = p - k * sz, j = Math.floor(r / nx), i = r - j * nx;
      if (j === 0 || i === 0 || k === 0 || i === nx - 1 || k === nz - 1) grounded = true;
      for (let dk = -1; dk <= 1; dk++) {
        const kk = k + dk;
        if (kk < 0 || kk >= nz) continue;
        for (let dj = -1; dj <= 1; dj++) {
          const jj = j + dj;
          if (jj < 0 || jj >= ny) continue;
          for (let di = -1; di <= 1; di++) {
            const ii = i + di;
            if (ii < 0 || ii >= nx) continue;
            if (face && Math.abs(di) + Math.abs(dj) + Math.abs(dk) !== 1) continue;
            const q = ii + jj * nx + kk * sz;
            if (label[q]! >= 0 || !(values[q]! < 0)) continue;
            label[q] = id;
            stack.push(q);
          }
        }
      }
    }
    if (grounded) continue;
    // owned by this box: its first cell (lowest block index = lowest k, then j, then i) lies in the inner box
    const k0 = Math.floor(start / sz), i0 = (start - k0 * sz) % nx;
    if (i0 < ix0 || i0 > ix1 || k0 < iz0 || k0 > iz1) continue;
    if (members.length >= keep) { bigFloating += 1; continue; }
    const cells: number[] = [];
    let lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    for (const p of members) {
      const k = Math.floor(p / sz), r = p - k * sz, j = Math.floor(r / nx), i = r - j * nx;
      const g = [gx0 + i, gy0 + j, gz0 + k];
      cells.push(g[0]!, g[1]!, g[2]!);
      lo = lo.map((x, a) => Math.min(x, g[a]!));
      hi = hi.map((x, a) => Math.max(x, g[a]!));
    }
    floaters.push({ cells, size: members.length, centre: [((lo[0]! + hi[0]!) / 2) * v, ((lo[1]! + hi[1]!) / 2) * v, ((lo[2]! + hi[2]!) / 2) * v] });
  }
  return { floaters, components, bigFloating, samples: values.length, ms: Date.now() - t0 };
}

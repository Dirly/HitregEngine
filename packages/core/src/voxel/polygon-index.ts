/**
 * Signed distance to closed outlines (lakes, filled hollows) at heightfield
 * sampling rates.
 *
 * `height()` runs millions of times per streamed cell, and a lake outline
 * traced by the hydrology has up to 160 vertices. Testing every vertex for
 * every column inside the lake's bounding box — point-in-polygon AND nearest
 * segment, twice (carve and waterY) — was the largest single cost left in
 * meshing a cell near water once rivers had been bucketed.
 *
 * Each outline is rasterised once, at a cell size that gives it roughly a
 * hundred cells across, into three states: far OUTSIDE (the caller skips it),
 * far INSIDE (the caller treats it as fully under the feature), and the BAND
 * along the edge — within `band` metres of the shore — where the exact signed
 * distance matters. Band cells carry the indices of the segments that come
 * within reach of them, so the exact answer is a handful of segment tests,
 * not a hundred and sixty. The sign comes from which side of the nearest
 * segment the point lies (outlines are normalised counter-clockwise); at a
 * vertex, where two segments are equally near, the more perpendicular one
 * decides.
 *
 * Discs (a hand-placed lake without an outline) stay analytic.
 */

export type OutlineSpec =
  | { kind: "polygon"; points: readonly (readonly [number, number])[]; band: number }
  | { kind: "disc"; center: readonly [number, number]; radius: number };

/** Returned for columns well outside an outline: every caller's "beyond the bank" test passes. */
export const FAR_OUTSIDE = 1e6;
/** Returned for columns well inside: every caller's "fully under the feature" branch is taken. */
export const FAR_INSIDE = -1e6;

const OUTSIDE = 0;
const INSIDE = 1;
const BAND = 2;

interface Raster {
  x0: number;
  z0: number;
  cell: number;
  w: number;
  h: number;
  state: Uint8Array;
  /** Cell-centre inside flag from the scanline, kept for band cells whose point turns out to be beyond the band. */
  inside: Uint8Array;
  /** Segment indices per band cell (null elsewhere). */
  segments: (Int32Array | null)[];
  /** Counter-clockwise outline. */
  pts: [number, number][];
  band: number;
}

export class PolygonIndex {
  private readonly rasters: (Raster | null)[] = [];
  private readonly discs: ({ cx: number; cz: number; r: number } | null)[] = [];

  constructor(specs: readonly OutlineSpec[]) {
    for (const spec of specs) {
      if (spec.kind === "disc") {
        this.rasters.push(null);
        this.discs.push({ cx: spec.center[0], cz: spec.center[1], r: spec.radius });
      } else {
        this.rasters.push(buildRaster(spec.points, spec.band));
        this.discs.push(null);
      }
    }
  }

  /** Signed distance from (x, z) to outline `k`: negative inside; ±1e6 far from the band. */
  signedDistance(k: number, x: number, z: number): number {
    const disc = this.discs[k];
    if (disc) return Math.sqrt((x - disc.cx) ** 2 + (z - disc.cz) ** 2) - disc.r;
    const r = this.rasters[k]!;
    const ix = Math.floor((x - r.x0) / r.cell);
    const iz = Math.floor((z - r.z0) / r.cell);
    if (ix < 0 || iz < 0 || ix >= r.w || iz >= r.h) return FAR_OUTSIDE;
    const i = ix + iz * r.w;
    const state = r.state[i]!;
    if (state === OUTSIDE) return FAR_OUTSIDE;
    if (state === INSIDE) return FAR_INSIDE;
    const list = r.segments[i] ?? null;
    const sd = exactSigned(r.pts, list, x, z);
    // a band cell whose point is beyond the band: the listed segments may not
    // include the true nearest, so the sign comes from the cell instead
    if (Math.abs(sd) > r.band) return r.inside[i] ? FAR_INSIDE : FAR_OUTSIDE;
    return sd;
  }
}

function buildRaster(points: readonly (readonly [number, number])[], band: number): Raster {
  // counter-clockwise: positive signed area in (x, z) taken as (x, y)
  let area = 0;
  for (let i = 0; i < points.length; i++) {
    const a = points[i]!;
    const b = points[(i + 1) % points.length]!;
    area += a[0] * b[1] - b[0] * a[1];
  }
  const pts: [number, number][] = points.map((p) => [p[0], p[1]] as [number, number]);
  if (area < 0) pts.reverse();

  let minX = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxZ = -Infinity;
  for (const [x, z] of pts) {
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (z < minZ) minZ = z;
    if (z > maxZ) maxZ = z;
  }
  const extent = Math.max(maxX - minX, maxZ - minZ, 1);
  // about a hundred cells across, never finer than 4 m or coarser than 16
  const cell = Math.min(16, Math.max(4, extent / 100));
  const pad = band + cell * 2;
  const x0 = minX - pad;
  const z0 = minZ - pad;
  const w = Math.ceil((maxX - minX + pad * 2) / cell) + 1;
  const h = Math.ceil((maxZ - minZ + pad * 2) / cell) + 1;
  const state = new Uint8Array(w * h);

  // inside/outside by scanline: crossings of every edge with each row of cell centres
  const n = pts.length;
  const xs: number[] = [];
  for (let iz = 0; iz < h; iz++) {
    const z = z0 + (iz + 0.5) * cell;
    xs.length = 0;
    for (let i = 0, j = n - 1; i < n; j = i++) {
      const a = pts[i]!;
      const b = pts[j]!;
      if (a[1] > z !== b[1] > z) xs.push(((b[0] - a[0]) * (z - a[1])) / (b[1] - a[1]) + a[0]);
    }
    if (xs.length < 2) continue;
    xs.sort((p, q) => p - q);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const from = Math.max(0, Math.ceil((xs[k]! - x0) / cell - 0.5));
      const to = Math.min(w - 1, Math.floor((xs[k + 1]! - x0) / cell - 0.5));
      for (let ix = from; ix <= to; ix++) state[ix + iz * w] = INSIDE;
    }
  }

  const inside = Uint8Array.from(state);
  // the band: every cell whose centre is within band + half a diagonal of a
  // segment, listing every segment within band + a FULL diagonal, so any
  // segment within `band` of any point of the cell is on the list
  const reach = band + cell * 1.42;
  const lists: number[][] = new Array(w * h);
  for (let s = 0; s < n; s++) {
    const a = pts[s]!;
    const b = pts[(s + 1) % n]!;
    const sx0 = Math.max(0, Math.floor((Math.min(a[0], b[0]) - reach - x0) / cell));
    const sx1 = Math.min(w - 1, Math.ceil((Math.max(a[0], b[0]) + reach - x0) / cell));
    const sz0 = Math.max(0, Math.floor((Math.min(a[1], b[1]) - reach - z0) / cell));
    const sz1 = Math.min(h - 1, Math.ceil((Math.max(a[1], b[1]) + reach - z0) / cell));
    const dx = b[0] - a[0];
    const dz = b[1] - a[1];
    const lenSq = dx * dx + dz * dz;
    for (let iz = sz0; iz <= sz1; iz++) {
      const cz = z0 + (iz + 0.5) * cell;
      for (let ix = sx0; ix <= sx1; ix++) {
        const cx = x0 + (ix + 0.5) * cell;
        const t = lenSq < 1e-12 ? 0 : Math.max(0, Math.min(1, ((cx - a[0]) * dx + (cz - a[1]) * dz) / lenSq));
        const px = cx - (a[0] + dx * t);
        const pz = cz - (a[1] + dz * t);
        if (px * px + pz * pz > reach * reach) continue;
        const i = ix + iz * w;
        state[i] = BAND;
        (lists[i] ??= []).push(s);
      }
    }
  }
  const segments: (Int32Array | null)[] = new Array(w * h).fill(null);
  for (let i = 0; i < w * h; i++) if (lists[i]) segments[i] = Int32Array.from(lists[i]!);
  return { x0, z0, cell, w, h, state, inside, segments, pts, band };
}

/** Exact signed distance using the listed segments (or all of them when the list is missing). */
function exactSigned(pts: readonly (readonly [number, number])[], list: Int32Array | null, x: number, z: number): number {
  const n = pts.length;
  const count = list ? list.length : n;
  let bestD = Infinity;
  let bestCross = 0;
  let bestInterior = false;
  let secondD = Infinity;
  let secondCross = 0;
  let secondInterior = false;
  for (let k = 0; k < count; k++) {
    const s = list ? list[k]! : k;
    const a = pts[s]!;
    const b = pts[(s + 1) % n]!;
    const dx = b[0] - a[0];
    const dz = b[1] - a[1];
    const lenSq = dx * dx + dz * dz;
    const raw = lenSq < 1e-12 ? 0 : ((x - a[0]) * dx + (z - a[1]) * dz) / lenSq;
    const t = raw < 0 ? 0 : raw > 1 ? 1 : raw;
    const px = x - (a[0] + dx * t);
    const pz = z - (a[1] + dz * t);
    const d = Math.sqrt(px * px + pz * pz);
    const cross = dx * (z - a[1]) - dz * (x - a[0]);
    const interior = raw > 0 && raw < 1;
    if (d < bestD) {
      secondD = bestD;
      secondCross = bestCross;
      secondInterior = bestInterior;
      bestD = d;
      bestCross = cross;
      bestInterior = interior;
    } else if (d < secondD) {
      secondD = d;
      secondCross = cross;
      secondInterior = interior;
    }
  }
  // counter-clockwise outline: inside is the positive-cross side
  let cross = bestCross;
  if (!bestInterior && secondD - bestD < 1e-6) {
    if (secondInterior) cross = secondCross;
    else if (Math.abs(secondCross) > Math.abs(bestCross)) cross = secondCross;
  }
  return cross > 0 ? -bestD : bestD;
}

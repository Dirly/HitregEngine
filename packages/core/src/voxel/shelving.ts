/**
 * SHELVING CORE — the contour-shelf solver shared by the `terrace` operator (and, later, `ledges`).
 *
 * One area of a slope becomes long shelves that follow the hill's smoothed contours, every shelf reachable:
 *  1. bands: K = round((smoothed ground + wobble - base) / band height), computed over the whole raster and NEVER
 *     clamped to a step count, so every cell cuts or fills about half a band at most and the bands run on out into
 *     the fade instead of ending in one tall cut;
 *  2. a soft, noisy mask: weight 1 inside the area, fading over `blend` past an outline wobbled by `edgeNoise`
 *     (no hard circle);
 *  3. shelves narrower than `minShelf` merge into a neighbour, unless that would stand a riser taller than the
 *     tallest kit wall: there they only merge down to the 6 m rule (FINE_MIN);
 *  4. a shelf graph (connected components, shared border lengths) linked by ramps as a spanning tree (Kruskal), so
 *     two shelves that never touch are linked THROUGH the ones between them; `unlinked` counts the rest (must be 0);
 *  5. optional kit walls on every riser of at least `minDrop` inside the full-weight area (away from ramps), in runs of
 *     2 m retaining-wall modules (`features.kitWalls`), each with a face cut; the lower shelf in front of a wall is held
 *     at the top so the riser bank stands inside the wall body and the cut takes it away.
 * Pure and deterministic.
 */
import type { OperatorFieldReader, OperatorPiece } from "./operator-registry.js";
import { FINE_MIN } from "./operator-registry.js";
import { KIT_WALL_HEIGHTS, KIT_WALL_MAX } from "./kit-walls.js";
import { borePiece, mouthPieces, routeCover, type CoverSource, type V3 } from "./cave-route.js";

export type XZ = [number, number];
export interface ShelfArea { center?: XZ; radius?: number; polygon?: XZ[] }
export interface ShelvingOptions {
  /** Height of one contour band (one riser), metres. */
  bandHeight: number;
  /** Preferred smallest shelf depth, metres (risers that would pass the kit max merge only down to FINE_MIN). */
  minShelf: number;
  /** Ground smoothing width, metres: long bands want ~18, ledges ~8. */
  smooth: number;
  /** Metres the riser lines wander off the smoothed contour. */
  jitter: number;
  /** Metres past the (noisy) outline over which the shelves fade back into the hill. */
  blend: number;
  /** Metres the outline wobbles in and out (value noise, ~40 m wavelength). */
  edgeNoise: number;
  riserSlope: number;
  rampWidth: number;
  rampGrade: number;
  baseY?: number;
  seed: number;
  /** Kit walls on risers, or false for plain banks. */
  walls: false | { style: "common" | "stone"; minDrop: number };
  /** How shelves are linked: ramps only (default), caves first ("cave"), or ramps first and caves where none fits ("auto"). */
  links?: "ramp" | "cave" | "auto";
  /** Unwalled: most bands one riser may span after merging (ledges keep 2, so no 30 m wall of merged bands). */
  maxRiserBands?: number;
  /** Cave links (needed for links "cave" / "auto"): bore radius (>= 3), rock cover over the roof, steepest floor grade. */
  cave?: { radius: number; cover: number; maxGrade: number };
  /** Staggered panels (ledges): panel `size` metres across the face, bands shifted by up to `amount` of a band per panel. */
  stagger?: { size: number; amount: number; /** pinch-out period in panels (>= 3; 0 = none) */ drop?: number };
  /** Outward fall of each shelf from back to lip, as a fraction of the band height (ledges ~0.15). */
  tilt?: number;
  /** Unwalled: tallest band (the growth on steep ground stops here). A landmark's risers are vertical rock, so it keeps
   *  its drops near `bandHeight` and lets narrow shelves merge instead. */
  maxBand?: number;
  /** Worn ramps (ledges): ragged edges, sloping shoulders and a little relief instead of a crisp box ramp. */
  wornRamps?: boolean;
}

export function areaOutline(a: ShelfArea): XZ[] {
  if (a.polygon) return a.polygon.map((q) => [q[0], q[1]] as XZ);
  const n = 48, c = a.center!, r = a.radius!;
  return Array.from({ length: n }, (_, i) => [c[0] + r * Math.cos((i / n) * Math.PI * 2), c[1] + r * Math.sin((i / n) * Math.PI * 2)] as XZ);
}

export function areaBounds(a: ShelfArea) {
  const o = areaOutline(a);
  return {
    x0: Math.min(...o.map((q) => q[0])), x1: Math.max(...o.map((q) => q[0])),
    z0: Math.min(...o.map((q) => q[1])), z1: Math.max(...o.map((q) => q[1])),
  };
}

/** Signed distance to the area: negative inside, metres. */
function areaDistance(a: ShelfArea, poly: XZ[], x: number, z: number): number {
  if (!a.polygon) return Math.hypot(x - a.center![0], z - a.center![1]) - a.radius!;
  let inside = false, best = Infinity;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, zi] = poly[i]!, [xj, zj] = poly[j]!;
    if ((zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
    const dx = xj - xi, dz = zj - zi, L = dx * dx + dz * dz || 1;
    const t = Math.max(0, Math.min(1, ((x - xi) * dx + (z - zi) * dz) / L));
    best = Math.min(best, Math.hypot(x - xi - t * dx, z - zi - t * dz));
  }
  return inside ? -best : best;
}

/** Smooth deterministic value noise in [-1, 1], wavelength `w` metres. */
export function valueNoise(x: number, z: number, w: number, seed: number): number {
  const hash = (i: number, j: number) => {
    let h = Math.imul(i, 374761393) ^ Math.imul(j, 668265263) ^ Math.imul(seed, 2147483647);
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    return ((h ^ (h >>> 16)) >>> 0) / 4294967295 * 2 - 1;
  };
  const fx = x / w, fz = z / w, i = Math.floor(fx), j = Math.floor(fz), u = fx - i, v = fz - j;
  const s = (t: number) => t * t * (3 - 2 * t);
  const a = hash(i, j), b = hash(i + 1, j), c = hash(i, j + 1), d = hash(i + 1, j + 1);
  return (a + (b - a) * s(u)) + ((c + (d - c) * s(u)) - (a + (b - a) * s(u))) * s(v);
}

/** Two-pass chamfer propagation of the NEAREST SOURCE cell (8-neighbour). Per cell: source index (-1 = none), distance in cells. */
function nearestSource(cols: number, rows: number, isSource: (i: number) => boolean): { src: Int32Array; dist: Float64Array } {
  const n = cols * rows, src = new Int32Array(n).fill(-1), dist = new Float64Array(n).fill(Infinity);
  for (let i = 0; i < n; i++) if (isSource(i)) { src[i] = i; dist[i] = 0; }
  const relax = (i: number, j: number) => {
    const s = src[j]!;
    if (s < 0) return;
    const d = Math.hypot((i % cols) - (s % cols), Math.floor(i / cols) - Math.floor(s / cols));
    if (d < dist[i]!) { dist[i] = d; src[i] = s; }
  };
  for (let pass = 0; pass < 2; pass++) {
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
      const i = r * cols + c;
      if (c > 0) relax(i, i - 1);
      if (r > 0) { relax(i, i - cols); if (c > 0) relax(i, i - cols - 1); if (c < cols - 1) relax(i, i - cols + 1); }
    }
    for (let r = rows - 1; r >= 0; r--) for (let c = cols - 1; c >= 0; c--) {
      const i = r * cols + c;
      if (c < cols - 1) relax(i, i + 1);
      if (r < rows - 1) { relax(i, i + cols); if (c < cols - 1) relax(i, i + cols + 1); if (c > 0) relax(i, i + cols - 1); }
    }
  }
  return { src, dist };
}

function boxBlur(src: Float64Array, cols: number, rows: number, r: number): Float64Array {
  const pass = (data: Float64Array, alongX: boolean): Float64Array => {
    const out = new Float64Array(data.length);
    const len = alongX ? cols : rows, lines = alongX ? rows : cols;
    for (let l = 0; l < lines; l++) {
      // running sum over the clamped window
      let sum = 0, cnt = 0;
      const at = (b: number) => data[alongX ? l * cols + b : b * cols + l]!;
      for (let b = 0; b <= Math.min(r, len - 1); b++) { sum += at(b); cnt++; }
      for (let a = 0; a < len; a++) {
        out[alongX ? l * cols + a : a * cols + l] = sum / cnt;
        const add = a + r + 1, drop = a - r;
        if (add < len) { sum += at(add); cnt++; }
        if (drop >= 0) { sum -= at(drop); cnt--; }
      }
    }
    return out;
  };
  return pass(pass(src, true), false);
}

function smoothstep(a: number, b: number, x: number): number {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

const r2 = (v: number) => Math.round(v * 100) / 100;
const r3 = (v: number) => Math.round(v * 1000) / 1000;

function differsFromNeighbour(K: Int32Array, cols: number, rows: number, i: number): boolean {
  const c = i % cols, r = Math.floor(i / cols), k = K[i];
  return c === 0 || r === 0 || c === cols - 1 || r === rows - 1 || K[i - 1] !== k || K[i + 1] !== k || K[i - cols] !== k || K[i + cols] !== k;
}

/** Morphological opening per level: cells of shelves shallower than `need` metres take the nearest kept shelf's level. */
function openShelves(K0: Int32Array, cols: number, rows: number, g: number, need: number, maxJump: number, anchor?: Int32Array): { K: Int32Array; merged: number } {
  const K = Int32Array.from(K0), n = cols * rows, rCells = need / 2 / g;
  let merged = 0;
  for (let round = 0; round < 3; round++) {
    const levels = [...new Set(K)].sort((a, b) => a - b);
    const toOther = nearestSource(cols, rows, (i) => differsFromNeighbour(K, cols, rows, i));
    const keep = new Uint8Array(n);
    for (const k of levels) {
      const near = nearestSource(cols, rows, (i) => K[i] === k && toOther.dist[i]! >= rCells);
      for (let i = 0; i < n; i++) if (K[i] === k && near.dist[i]! <= rCells + 0.75) keep[i] = 1;
    }
    const fill = nearestSource(cols, rows, (i) => keep[i] === 1);
    let changed = 0;
    for (let i = 0; i < n; i++) {
      // only from a kept shelf close by: a stretch with no kept shelf near keeps its bands (never a collapse into one cut)
      if (!keep[i] && fill.src[i]! >= 0 && fill.dist[i]! <= 2 * rCells + 1.5 && K[fill.src[i]!] !== K[i] && Math.abs(K[fill.src[i]!]! - K[i]!) <= maxJump && (!anchor || Math.abs(K[fill.src[i]!]! - anchor[i]!) <= 1)) { K[i] = K[fill.src[i]!]!; changed++; }
    }
    merged += changed;
    if (!changed) break;
  }
  return { K, merged };
}

/** Cells with a 4-neighbour more than `maxBands` levels away (inside `core`). */
function tallCells(K: Int32Array, cols: number, rows: number, maxBands: number, core: (i: number) => boolean): Uint8Array {
  const out = new Uint8Array(K.length);
  for (let i = 0; i < K.length; i++) {
    if (!core(i)) continue;
    const c = i % cols, r = Math.floor(i / cols), k = K[i]!;
    const far = (j: number) => Math.abs(K[j]! - k) > maxBands;
    if ((c > 0 && far(i - 1)) || (c < cols - 1 && far(i + 1)) || (r > 0 && far(i - cols)) || (r < rows - 1 && far(i + cols))) out[i] = 1;
  }
  return out;
}

interface Ramp { ax: number; az: number; t: XZ; dn: XZ; len: number; width: number }

export interface ShelvingResult {
  features: { heightPatches: OperatorPiece[]; kitWalls?: OperatorPiece[]; tunnels?: OperatorPiece[]; blobs?: OperatorPiece[] };
  report: Record<string, unknown>;
  /** The solved lattice (what a landmark build reads): ground H, mask W, level index K, target T, ramp cells, cave floors. */
  grid: ShelvingGrid;
}

export interface ShelvingGrid {
  x0: number; z0: number; g: number; cols: number; rows: number;
  /** Level of band k is base + k * bandHeight. */
  base: number; bandHeight: number;
  H: Float64Array; W: Float64Array; K: Float64Array; T: Float64Array;
  /** 1 where a ramp raised the target. */
  ramp: Uint8Array;
  /** Each ramp's walk line: head (upper shelf, y hi) to foot (lower shelf, y lo), world metres, and its width. */
  rampPaths: { head: [number, number, number]; foot: [number, number, number]; width: number }[];
  /** Shelf component per cell (-1 = none). */
  comp: Int32Array;
  /** Cave link floors (world points, mouth a first) and their bore radius. */
  caves: { floor: [number, number, number][]; radius: number }[];
}

/**
 * The FRINGE rule: a shelf component whose area lies more than half in the fade band (cells under full weight, where the
 * terrace blends back into the natural slope) is HILLSIDE, not a ledge. It gets no reach anchor and never counts as
 * unlinked; the ledge landmark lays no rock on it (the ground there is walked as slope). Returns one flag per component.
 */
export function fringeShelves(comp: Int32Array, W: Float64Array, count: number): boolean[] {
  const size = new Array<number>(count).fill(0), full = new Array<number>(count).fill(0);
  for (let i = 0; i < comp.length; i++) { const k = comp[i]!; if (k < 0 || k >= count) continue; size[k]!++; if (W[i]! >= 0.999) full[k]!++; }
  return size.map((sz, k) => full[k]! * 2 < sz);
}

export function solveShelves(area: ShelfArea, reader: OperatorFieldReader, o: ShelvingOptions, id: string): ShelvingResult {
  const g = reader.voxelSize;
  const poly = areaOutline(area);
  const b = areaBounds(area);
  const margin = o.blend + o.edgeNoise;
  const x0 = Math.floor((b.x0 - margin) / g) * g, z0 = Math.floor((b.z0 - margin) / g) * g;
  const cols = Math.ceil((b.x1 + margin - x0) / g) + 1, rows = Math.ceil((b.z1 + margin - z0) / g) + 1;
  if (cols > 1025 || rows > 1025) throw new Error(`"${id}" is too large (${cols}x${rows} samples; max 1025 a side)`);
  const n = cols * rows;
  const seed = (reader.seed * 7919 + o.seed * 104729) | 0;
  const H = new Float64Array(n), W = new Float64Array(n);
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
    const i = r * cols + c, x = x0 + c * g, z = z0 + r * g;
    H[i] = reader.height(x, z);
    // the noisy soft mask: the outline wobbles by edgeNoise, then fades over blend
    const d = areaDistance(area, poly, x, z) + o.edgeNoise * valueNoise(x, z, 40, seed + 5);
    W[i] = d <= 0 ? 1 : 1 - smoothstep(0, o.blend, d);
  }
  const full = (i: number) => W[i]! >= 0.999;
  const core = (i: number) => W[i]! >= 0.5;

  // 1. contour bands on the smoothed ground (two box passes ~ a gaussian `smooth` metres wide), unclamped
  const br = Math.max(1, Math.round(o.smooth / g / 2));
  const Hs = boxBlur(boxBlur(H, cols, rows, br), cols, rows, br);
  const insideVals: number[] = [];
  for (let i = 0; i < n; i++) if (full(i)) insideVals.push(Hs[i]!);
  if (insideVals.length < 9) throw new Error(`"${id}": the area holds too few lattice samples`);
  insideVals.sort((a, c) => a - c);
  const base = o.baseY ?? r2(insideVals[Math.floor(insideVals.length / 2)]!);
  // band height: at least `bandHeight`, grown on steep ground so the typical shelf keeps `minShelf` (riser = slope x shelf),
  // never past the tallest kit wall when walled
  const slopes: number[] = [];
  for (let i = 0; i < n; i++) {
    if (!full(i)) continue;
    const c = i % cols, r = Math.floor(i / cols);
    if (c === 0 || r === 0 || c === cols - 1 || r === rows - 1) continue;
    slopes.push(Math.hypot(Hs[i + 1]! - Hs[i - 1]!, Hs[i + cols]! - Hs[i - cols]!) / (2 * g));
  }
  slopes.sort((a, c) => a - c);
  const medianSlope = slopes.length ? slopes[Math.floor(slopes.length / 2)]! : 0;
  const hMax = o.walls ? KIT_WALL_MAX - 0.15 : (o.maxBand ?? Infinity);
  const h = r2(Math.min(hMax, Math.max(o.bandHeight, 1.25 * medianSlope * o.minShelf)));
  // the merge depth: minShelf, but never past ~80% of the typical shelf the band height gives (or every band would go)
  const typical = medianSlope > 1e-3 ? h / medianSlope : Infinity;
  const needDepth = Math.max(FINE_MIN, Math.min(o.minShelf, 0.8 * typical));
  const level = (k: number) => r2(base + k * h);
  // shelves narrower than 6 m merge away in step 2, so a staggered (ledges) solve may wander further than a terrace
  const jit = Math.min(o.jitter, Math.max(0, (typical - FINE_MIN) / 2, o.stagger ? 0.45 * typical : 0));
  // stagger: the face splits into panels — strips ACROSS the face (along the mean contour), of uneven width and with
  // ragged seams running down the slope — each shifting its bands by its own fraction of a band. Across a seam a ledge
  // ends, steps down or overlaps the next one instead of one band running the whole width of the face.
  const panelPhase = (() => {
    const st = o.stagger;
    if (!st || (st.amount <= 0 && !(st.drop! > 0))) return null;
    const S = st.size, ph = new Float64Array(n), pid = new Int32Array(n);
    const hcell = (i: number, j: number, q: number) => { let v = Math.imul(i, 73856093) ^ Math.imul(j, 19349663) ^ Math.imul(seed + 977 * q, 83492791); v = Math.imul(v ^ (v >>> 13), 1274126177); return ((v ^ (v >>> 16)) >>> 0) / 4294967295; };
    // the face's mean downhill direction over the full-weight area; panels count along its contour
    let mx = 0, mz = 0;
    for (let i = 0; i < n; i++) {
      if (!full(i)) continue;
      const c = i % cols, r = Math.floor(i / cols);
      mx += Hs[Math.min(i + 1, r * cols + cols - 1)]! - Hs[Math.max(i - 1, r * cols)]!;
      mz += Hs[Math.min(i + cols, n - cols + c)]! - Hs[Math.max(i - cols, c)]!;
    }
    const ml = Math.hypot(mx, mz) || 1, tx = -mz / ml, tz = mx / ml;
    for (let i = 0; i < n; i++) {
      const x = x0 + (i % cols) * g, z = z0 + Math.floor(i / cols) * g;
      // uneven widths (a long-wave warp of the along-face coordinate) and ragged seams (a short one)
      const a = x * tx + z * tz + 0.35 * S * valueNoise(x, z, 2 * S, seed + 21) + 2.5 * valueNoise(x, z, 7, seed + 22);
      const j = Math.floor(a / S);
      pid[i] = j;
      ph[i] = st.amount * hcell(j, 0, 3);
    }
    return { ph, pid, drop: st.drop ?? 0, hcell };
  })();
  const V = new Float64Array(n);
  const K0 = new Int32Array(n);
  for (let i = 0; i < n; i++) {
    const c = i % cols, r = Math.floor(i / cols), x = x0 + c * g, z = z0 + r * g;
    const ddx = (Hs[Math.min(i + 1, r * cols + cols - 1)]! - Hs[Math.max(i - 1, r * cols)]!) / (2 * g);
    const ddz = (Hs[Math.min(i + cols, n - cols + c)]! - Hs[Math.max(i - cols, c)]!) / (2 * g);
    // jitter moves the riser LINE by ~wobble metres: shift the ground by wobble x the local smoothed gradient; a
    // staggered solve adds a short octave so the lips are broken rock, not a drawn curve
    const wobble = o.stagger
      ? jit * (valueNoise(x, z, 26, seed) * 0.55 + valueNoise(x, z, 11, seed + 1) * 0.3 + valueNoise(x, z, 5, seed + 2) * 0.15)
      : jit * (valueNoise(x, z, 34, seed) * 0.7 + valueNoise(x, z, 13, seed + 1) * 0.3);
    V[i] = (Hs[i]! + wobble * Math.hypot(ddx, ddz) - base) / h + (panelPhase ? panelPhase.ph[i]! : 0);
    K0[i] = Math.round(V[i]!);
  }
  // 2. merge shallow shelves: to minShelf where the result stays wallable, else only to the 6 m rule
  const bank = o.walls ? 0 : h / o.riserSlope;
  const maxBands = o.walls ? Math.max(1, Math.floor((KIT_WALL_MAX - 0.15) / h + 1e-9)) : (o.maxRiserBands ?? Infinity);
  const jump = maxBands === Infinity ? 2 : maxBands;
  // a staggered (ledges) solve keeps every cell within one band of its own ground: on a face steeper than the shelf depth
  // allows, merging thin shelves band after band once cut 36 m into the slope and filled 45 m onto it
  const anchor = o.stagger ? K0 : undefined;
  const big = openShelves(K0, cols, rows, g, needDepth + bank, jump, anchor);
  let K = big.K, merged = big.merged;
  if (maxBands !== Infinity) {
    const tall = tallCells(K, cols, rows, maxBands, core);
    if (tall.some((v) => v === 1)) {
      const small = openShelves(K0, cols, rows, g, FINE_MIN + bank, jump, anchor);
      const nearTall = nearestSource(cols, rows, (i) => tall[i] === 1);
      const mix = Int32Array.from(K);
      for (let i = 0; i < n; i++) if (nearTall.dist[i]! * g <= o.minShelf) mix[i] = small.K[i]!;
      const fin = openShelves(mix, cols, rows, g, FINE_MIN + bank, jump, anchor);
      K = fin.K; merged += fin.merged;
    }
  }

  // pinch-outs: in some panels a ledge is left out (its ground joins the band above or below), so it ENDS at the panel
  // seam against a taller riser and picks up again beyond — ledges of different lengths, never one band across the face
  if (panelPhase && panelPhase.drop > 0) {
    const { pid, hcell, drop } = panelPhase, off = Math.floor(hcell(seed, 1, 6) * drop);
    let kLo = Infinity, kHi = -Infinity;
    for (let i = 0; i < n; i++) if (core(i)) { kLo = Math.min(kLo, K[i]!); kHi = Math.max(kHi, K[i]!); }
    for (let i = 0; i < n; i++) {
      const k = K[i]!;
      // every ledge pinches out once in each `drop` panels along the face, the next ledge up two panels on, so no band
      // runs the whole face and no two neighbouring ledges of one panel go (a riser stays at most two bands)
      if (((pid[i]! + 2 * k + off) % drop + drop) % drop !== 0) continue;
      // the top and bottom ledges pinch INTO the range: a top ledge raised a band would stand above the crest as a
      // block, a bottom one dropped a band would dig a pit below the foot
      const up = k >= kHi ? false : k <= kLo ? true : hcell(pid[i]!, k, 5) < 0.5;
      K[i] = k + (up ? 1 : -1);
    }
  }

  // 3. shelves = connected components on the core (weight >= 0.5); tiny ones join the neighbour they share most border with
  const comp = new Int32Array(n).fill(-1);
  const label = () => {
    comp.fill(-1);
    const sizes: number[] = [];
    for (let s = 0; s < n; s++) {
      if (comp[s] !== -1 || !core(s)) continue;
      const id = sizes.length, stack = [s];
      comp[s] = id;
      let size = 0;
      while (stack.length) {
        const i = stack.pop()!;
        size++;
        const c = i % cols, r = Math.floor(i / cols);
        for (const j of [c > 0 ? i - 1 : -1, c < cols - 1 ? i + 1 : -1, r > 0 ? i - cols : -1, r < rows - 1 ? i + cols : -1]) {
          if (j >= 0 && comp[j] === -1 && core(j) && K[j] === K[i]) { comp[j] = id; stack.push(j); }
        }
      }
      sizes.push(size);
    }
    return sizes;
  };
  const borders = (sizes: number[]) => {
    const m = new Map<number, number>();
    for (let i = 0; i < n; i++) {
      const a = comp[i]!;
      if (a < 0) continue;
      const c = i % cols, r = Math.floor(i / cols);
      for (const j of [c < cols - 1 ? i + 1 : -1, r < rows - 1 ? i + cols : -1]) {
        const bb = j >= 0 ? comp[j]! : -1;
        if (bb < 0 || bb === a) continue;
        const key = Math.min(a, bb) * sizes.length + Math.max(a, bb);
        m.set(key, (m.get(key) ?? 0) + 1);
      }
    }
    return m;
  };
  // steps 3-5 run again when a shelf is left unlinked: it joins its neighbour on the linked side (a taller riser
  // there, never a stranded ledge) and the shelves are relabelled and relinked
  const runLinks = () => {
  let sizes = label();
  const minCells = (o.minShelf * o.minShelf) / (g * g);
  for (let pass = 0; pass < 4; pass++) {
    const small = sizes.map((s, c) => ({ s, c })).filter((e) => e.s < minCells).sort((a, c) => a.s - c.s || a.c - c.c);
    if (!small.length) break;
    const bd = borders(sizes);
    const target = new Map<number, number>();
    for (const { c } of small) {
      let best = -1, bestLen = 0;
      for (const [key, len] of bd) {
        const a = Math.floor(key / sizes.length), bb = key % sizes.length;
        const other = a === c ? bb : bb === c ? a : -1;
        if (other < 0 || target.has(other)) continue;
        if (len > bestLen || (len === bestLen && other < best)) { best = other; bestLen = len; }
      }
      if (best >= 0) target.set(c, best);
    }
    if (!target.size) break;
    const levelOf = new Map<number, number>();
    for (let i = 0; i < n; i++) if (comp[i]! >= 0 && !levelOf.has(comp[i]!)) levelOf.set(comp[i]!, K[i]!);
    for (let i = 0; i < n; i++) { const t = target.get(comp[i]!); if (t !== undefined) K[i] = levelOf.get(t)!; }
    sizes = label();
  }
  const compLevel: number[] = new Array(sizes.length).fill(0);
  for (let i = 0; i < n; i++) if (comp[i]! >= 0) compLevel[comp[i]!] = K[i]!;

  // 4. level raster
  const T = new Float64Array(n), rampCells = new Uint8Array(n);
  // an outward tilt: each shelf falls `tilt` x band height from its back (riser foot) to its lip, plus a little relief
  // on unwalled shelves (worn rock, not a poured floor)
  const tilt = o.tilt ?? 0;
  for (let i = 0; i < n; i++) {
    T[i] = level(K[i]!);
    if (tilt > 0) T[i] = T[i]! + tilt * h * Math.max(-0.5, Math.min(0.5, V[i]! - K[i]!));
    if (!o.walls && o.stagger) T[i] = T[i]! + 0.25 * valueNoise(x0 + (i % cols) * g, z0 + Math.floor(i / cols) * g, 5, seed + 9);
  }

  // 5. the shelf graph: Kruskal over shared borders, cheapest climbs first, each link a ramp on the lower shelf
  const bd = borders(sizes);
  const edges = [...bd].map(([key, len]) => {
    const a = Math.floor(key / sizes.length), bb = key % sizes.length;
    const lo = compLevel[a]! <= compLevel[bb]! ? a : bb, hi = lo === a ? bb : a;
    return { lo, hi, len, drop: compLevel[hi]! - compLevel[lo]! };
  }).filter((e) => e.drop > 0).sort((a, c) => a.drop - c.drop || c.len - a.len || a.lo - c.lo || a.hi - c.hi);
  const parent = sizes.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i]!)));
  const cellAt = (x: number, z: number) => {
    const c = Math.round((x - x0) / g), r = Math.round((z - z0) / g);
    return c < 0 || r < 0 || c >= cols || r >= rows ? -1 : r * cols + c;
  };
  const ramps: Ramp[] = [];
  const rampPaths: ShelvingGrid["rampPaths"] = [];
  const rampReport: Record<string, unknown>[] = [];
  // a flat merge of equal levels (never happens after labelling) needs no ramp; components on the same level that
  // touch are one component by construction
  /** Within a cave mouth: the first/last 3 m of every linked bore, padded by its radius + 1 m. */
  const mouthNear = (x: number, z: number) => {
    const pad = (o.cave?.radius ?? 3) + 1;
    return linkFloors.some((fl) => {
      for (const dir of [1, -1]) {
        let run = 0;
        for (let k = dir > 0 ? 0 : fl.length - 1; k >= 0 && k < fl.length && run <= 3; k += dir) {
          const p = fl[k]!, q = fl[k - dir];
          if (q) run += Math.hypot(p[0] - q[0], p[2] - q[2]);
          if (Math.hypot(p[0] - x, p[2] - z) < pad) return true;
        }
      }
      return false;
    });
  };
  const tryRamp = (e: (typeof edges)[number]): boolean => {
    if (e.len * g < o.rampWidth) return false; // a ramp needs a shared border at least its width (a cave does not)
    const rise = level(compLevel[e.hi]!) - level(compLevel[e.lo]!);
    const len = rise / o.rampGrade;
    // the best spot clear of the cave mouths, and the best spot at all (the fallback: a link is never lost to a mouth)
    let best = -Infinity, pick: Ramp | null = null, bestClear = -Infinity, pickClear: Ramp | null = null;
    for (let i = 0; i < n; i++) {
      if (comp[i] !== e.lo) continue;
      const c = i % cols, r = Math.floor(i / cols);
      if (!((c > 0 && comp[i - 1] === e.hi) || (c < cols - 1 && comp[i + 1] === e.hi) || (r > 0 && comp[i - cols] === e.hi) || (r < rows - 1 && comp[i + cols] === e.hi))) continue;
      const gx = Hs[Math.min(i + 1, r * cols + cols - 1)]! - Hs[Math.max(i - 1, r * cols)]!;
      const gz = Hs[Math.min(i + cols, n - cols + c)]! - Hs[Math.max(i - cols, c)]!;
      const gl = Math.hypot(gx, gz);
      if (gl < 1e-6) continue;
      const dn: XZ = [-gx / gl, -gz / gl];
      const sx = x0 + c * g - dn[0] * g * 0.5, sz = z0 + r * g - dn[1] * g * 0.5;
      for (const sign of [1, -1]) {
        const t: XZ = [-dn[1] * sign, dn[0] * sign];
        let on = 0, all = 0, wsum = 0, blocked = false;
        for (let s = 0; s <= len; s += g) for (let w = 0; w <= o.rampWidth; w += g) {
          const px = sx + t[0] * s + dn[0] * w, pz = sz + t[1] * s + dn[1] * w;
          // across a cave mouth (linked first) the bore and its flare cut the ramp's floor apart
          if (!blocked && mouthNear(px, pz)) blocked = true;
          const k = cellAt(px, pz);
          all++;
          if (k >= 0 && comp[k] === e.lo) { on++; wsum += W[k]!; }
        }
        // most on the lower shelf, then deepest inside the area (a ramp in the fade is a ramp nobody finds)
        const score = on / all + 0.05 * (on ? wsum / on : 0);
        if (score > best + 1e-9) { best = score; pick = { ax: sx, az: sz, t, dn, len, width: o.rampWidth }; }
        if (!blocked && score > bestClear + 1e-9) { bestClear = score; pickClear = { ax: sx, az: sz, t, dn, len, width: o.rampWidth }; }
      }
    }
    if (!pick) return false;
    // apply: raise the lower shelf's cells under the ramp, never the shelf above
    const measure = (pick: Ramp) => {
      let cells = 0, onShelf = 0;
      const reach = len + o.rampWidth + 2 * g;
      const c0 = Math.max(0, Math.floor((pick.ax - reach - x0) / g)), c1 = Math.min(cols - 1, Math.ceil((pick.ax + reach - x0) / g));
      const q0 = Math.max(0, Math.floor((pick.az - reach - z0) / g)), q1 = Math.min(rows - 1, Math.ceil((pick.az + reach - z0) / g));
      const raise: [number, number][] = [];
      const shoulder = o.wornRamps ? 4 : 0;
      for (let r = q0; r <= q1; r++) for (let c = c0; c <= c1; c++) {
        const i = r * cols + c, wx = x0 + c * g, wz = z0 + r * g, x = wx - pick.ax, z = wz - pick.az;
        const s = x * pick.t[0] + z * pick.t[1], w = x * pick.dn[0] + z * pick.dn[1];
        if (s < -g || s > len + g || w < -g * 0.5 - shoulder || w > o.rampWidth + shoulder) continue;
        const y = level(compLevel[e.hi]!) - (Math.max(0, Math.min(len, s)) / len) * rise;
        if (w < -g * 0.5 || w > o.rampWidth) {
          // worn: the ramp's outer edge wanders and falls away as a rough rock shoulder (1:1), never a crisp box side
          const edge = 1.2 * valueNoise(wx, wz, 6, seed + 41);
          const out = (w < 0 ? -g * 0.5 - w : w - o.rampWidth) - edge;
          if (comp[i] === e.lo) raise.push([i, y - Math.max(0, out) - 0.2]);
          continue;
        }
        cells++;
        if (comp[i] !== e.lo) continue;
        onShelf++;
        raise.push([i, o.wornRamps ? y - 0.3 * Math.abs(valueNoise(wx, wz, 4, seed + 43)) : y]);
      }
      return { raise, frac: cells ? onShelf / cells : 0 };
    };
    let m = pickClear ? measure(pickClear) : null;
    if (m && m.frac >= 0.75) pick = pickClear!;
    else m = measure(pick);
    const { raise, frac } = m;
    if (frac < 0.75) return false; // no room on this border: Kruskal tries the next one (a longer way round)
    for (const [i, y] of raise) if (y > T[i]!) { T[i] = y; rampCells[i] = 1; }
    ramps.push(pick);
    {
      const mx = pick.ax + pick.dn[0] * o.rampWidth / 2, mz = pick.az + pick.dn[1] * o.rampWidth / 2;
      rampPaths.push({ head: [mx, level(compLevel[e.hi]!), mz], foot: [mx + pick.t[0] * len, level(compLevel[e.lo]!), mz + pick.t[1] * len], width: o.rampWidth });
    }
    parent[find(e.lo)] = find(e.hi);
    rampReport.push({
      from: level(compLevel[e.lo]!), to: level(compLevel[e.hi]!), width: o.rampWidth, length: Math.round(len * 10) / 10, grade: o.rampGrade,
      start: [Math.round(pick.ax), Math.round(pick.az)], end: [Math.round(pick.ax + pick.t[0] * len), Math.round(pick.az + pick.t[1] * len)],
      onShelf: Math.round(frac * 100) / 100,
    });
    return true;
  };
  // a cave link: a short cave that climbs INSIDE the rock from the foot of the riser on the lower shelf and comes out on
  // the upper shelf (two mouths), for a pair no ramp fits between. Cover is measured on the PLANNED surface.
  const caveTunnels: OperatorPiece[] = [], caveBlobs: OperatorPiece[] = [], caveReport: Record<string, unknown>[] = [], linkFloors: V3[][] = [];
  const planned: CoverSource = {
    step: g,
    surface: (x, z) => {
      const fc = (x - x0) / g, fr = (z - z0) / g;
      if (fc < 0 || fr < 0 || fc > cols - 1 || fr > rows - 1) return reader.height(x, z);
      const c = Math.min(cols - 2, Math.floor(fc)), r = Math.min(rows - 2, Math.floor(fr)), u = fc - c, v = fr - r;
      const at = (i: number) => H[i]! + W[i]! * (T[i]! - H[i]!);
      const i = r * cols + c;
      return (at(i) * (1 - u) + at(i + 1) * u) * (1 - v) + (at(i + cols) * (1 - u) + at(i + cols + 1) * u) * v;
    },
  };
  const tryCave = (e: (typeof edges)[number]): boolean => {
    const cv = o.cave;
    if (!cv) return false;
    const yLo = level(compLevel[e.lo]!), yHi = level(compLevel[e.hi]!), R = yHi - yLo;
    const r = cv.radius, mouth = 2 * r + cv.cover, cap = cv.cover + 4;
    const starts: number[] = [], ends: number[] = [];
    for (let i = 0; i < n; i++) {
      if (!full(i)) continue;
      if (comp[i] === e.hi) { const c = i % cols, rr = Math.floor(i / cols); if (c % 3 === 0 && rr % 3 === 0) ends.push(i); continue; }
      if (comp[i] !== e.lo) continue;
      const c = i % cols, rr = Math.floor(i / cols);
      if ((c > 0 && comp[i - 1] === e.hi) || (c < cols - 1 && comp[i + 1] === e.hi) || (rr > 0 && comp[i - cols] === e.hi) || (rr < rows - 1 && comp[i + cols] === e.hi)) starts.push(i);
    }
    if (!starts.length || !ends.length) return false;
    const pickS = starts.filter((_, k) => k % Math.max(1, Math.ceil(starts.length / 8)) === 0);
    let best: { min: number; len: number; floor: V3[]; grade: number } | null = null;
    for (const si of pickS) {
      const sc = si % cols, sr = Math.floor(si / cols);
      // the mouth sits a cell out from the riser foot, on the lower shelf
      // into the riser = toward the upper shelf across THIS border (a staggered seam runs down the face, so the
      // smoothed hill gradient is not the way in there)
      let gx = 0, gz = 0;
      if (sc > 0 && comp[si - 1] === e.hi) gx -= 1;
      if (sc < cols - 1 && comp[si + 1] === e.hi) gx += 1;
      if (sr > 0 && comp[si - cols] === e.hi) gz -= 1;
      if (sr < rows - 1 && comp[si + cols] === e.hi) gz += 1;
      const gl = Math.hypot(gx, gz);
      if (gl < 1e-6) continue;
      const u: XZ = [gx / gl, gz / gl];
      const S: XZ = [x0 + sc * g - u[0] * g, z0 + sr * g - u[1] * g];
      // the mouth must stand on the lower shelf itself
      const sCell = cellAt(S[0], S[1]);
      if (sCell < 0 || comp[sCell] !== e.lo) continue;
      const yS = planned.surface(S[0], S[1]);
      for (const xi of ends.filter((_, k) => k % Math.max(1, Math.ceil(ends.length / 24)) === 0)) {
        const X: XZ = [x0 + (xi % cols) * g, z0 + Math.floor(xi / cols) * g];
        const yX = planned.surface(X[0], X[1]), RR = yX - yS;
        if (RR <= 0) continue;
        const d = Math.hypot(X[0] - S[0], X[1] - S[1]);
        if (d < 4 || d > 90) continue;
        // the bend point: into the rock behind the middle of the climb, or behind either mouth (a J, not a hairpin,
        // when the upper mouth lies along the face)
        for (const [depth, at] of [[0, 0.5] as const, ...[10, 20, 32, 46].flatMap((d) => [[d, 0.5], [d, 0.2], [d, 0.8]] as const)]) {
          const V: XZ = [S[0] + (X[0] - S[0]) * at + u[0] * depth, S[1] + (X[1] - S[1]) * at + u[1] * depth];
          // quadratic bezier S -> V -> X, ~3 m chords, floor rising evenly with arc length
          const pts: XZ[] = [];
          const NS = Math.max(16, Math.ceil((Math.hypot(V[0] - S[0], V[1] - S[1]) + Math.hypot(X[0] - V[0], X[1] - V[1])) / 2.5));
          for (let k = 0; k <= NS; k++) {
            const t = k / NS, a = (1 - t) * (1 - t), b = 2 * t * (1 - t), c = t * t;
            pts.push([a * S[0] + b * V[0] + c * X[0], a * S[1] + b * V[1] + c * X[1]]);
          }
          let len = 0;
          const acc = [0];
          for (let k = 1; k < pts.length; k++) { len += Math.hypot(pts[k]![0] - pts[k - 1]![0], pts[k]![1] - pts[k - 1]![1]); acc.push(len); }
          if (len < 2 * mouth + 6) continue;
          // the climb runs between where the route goes under the rock (ground over a metre above the lower mouth) and
          // where it last is (over a metre above the upper one): level in the open, so no step up onto a floor in the air
          let sIn = 0, sOut = len;
          for (let k = 0; k < pts.length; k++) if (planned.surface(pts[k]![0], pts[k]![1]) > yS + 1) { sIn = acc[Math.max(0, k - 1)]!; break; }
          for (let k = pts.length - 1; k >= 0; k--) if (planned.surface(pts[k]![0], pts[k]![1]) > yX + 1) { sOut = acc[Math.min(pts.length - 1, k + 1)]!; break; }
          const climb = sOut - sIn;
          if (climb <= 0 || RR / climb > cv.maxGrade) continue;
          // the floor runs from the ground the mouths really stand on (a tilted, worn shelf), so no sill or step at either mouth
          // and never stands above open ground: where the climb line is still out over the shelf it follows the shelf
          // (else a walker steps off the shelf up onto a floor in the air at the riser foot)
          const floor: V3[] = pts.map((p, k) => [p[0], Math.min(yS + RR * Math.max(0, Math.min(1, (acc[k]! - sIn) / climb)), planned.surface(p[0], p[1])), p[1]]);
          // never a hairpin whose legs touch: two floor points stay as far apart as the bore between them, up to a bore
          // and a metre of rock (else the upper leg's floor drops into the lower leg)
          if (floor.some((p, a) => floor.some((q, b) => b > a && Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]) < 0.85 * Math.min(acc[b]! - acc[a]!, 2 * r + 1)))) continue;
          const cover = routeCover(planned, floor, r, cap, mouth, mouth);
          if (cover.interior < 2 || cover.min < cv.cover) continue;
          // never through (or a thin floor over) another link cave
          if (linkFloors.some((o2) => o2.some((q) => floor.some((p) => Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]) < 2 * r + cv.cover)))) continue;
          if (!best || cover.min > best.min + 1e-9 || (Math.abs(cover.min - best.min) < 1e-9 && len < best.len)) best = { min: cover.min, len, floor, grade: RR / climb };
        }
      }
    }
    if (!best) return false;
    const k = caveReport.length, tag = `link-${k}`;
    // bore points every ~2.5 m (the floor follows the open shelf to the rock, then climbs)
    const fl = best.floor;
    caveTunnels.push(borePiece(tag, fl, r));
    linkFloors.push(best.floor);
    const A = fl[0]!, A1 = fl[1]!, B = fl[fl.length - 1]!, B1 = fl[fl.length - 2]!;
    const unit = (dx: number, dz: number): [number, number] => { const l = Math.hypot(dx, dz) || 1; return [dx / l, dz / l]; };
    const ma = mouthPieces(`${tag}-a`, A, unit(A[0] - A1[0], A[2] - A1[2]), r, seed + 31 * k + 1, Math.max(A[1] - 1, planned.surface(A[0] + (A[0] - A1[0]) * 0.5, A[2] + (A[2] - A1[2]) * 0.5)), best.floor);
    const mb = mouthPieces(`${tag}-b`, B, unit(B[0] - B1[0], B[2] - B1[2]), r, seed + 31 * k + 2, Math.max(B[1] - 1, planned.surface(B[0] + (B[0] - B1[0]) * 0.5, B[2] + (B[2] - B1[2]) * 0.5)), [...best.floor].reverse());
    caveTunnels.push(...ma.tunnels, ...mb.tunnels);
    caveBlobs.push(...ma.blobs, ...mb.blobs);
    parent[find(e.lo)] = find(e.hi);
    const q = (p: V3) => p.map((v) => Math.round(v * 10) / 10);
    caveReport.push({ from: yLo, to: yHi, a: q(A), b: q(B), length: Math.round(best.len), grade: Math.round(best.grade * 100) / 100, minCover: Math.round(best.min * 10) / 10 });
    return true;
  };
  // link passes: ramps (and, for ledges, short climbing caves) in Kruskal order; "auto" = ramps first, caves where none fits
  const passes: ("ramp" | "cave")[] = o.links === "cave" ? ["cave", "ramp"] : o.links === "auto" ? ["ramp", "cave"] : ["ramp"];
  for (const pass of passes) for (const e of edges) {
    if (find(e.lo) === find(e.hi)) continue;
    if (pass === "ramp") tryRamp(e); else tryCave(e);
  }
  const roots = new Set(sizes.map((_, i) => find(i)));
  // shelves cut off from the largest group
  let mainRoot = -1, mainSize = -1;
  const groupSize = new Map<number, number>();
  sizes.forEach((s, i) => groupSize.set(find(i), (groupSize.get(find(i)) ?? 0) + s));
  for (const [rt, s] of groupSize) if (s > mainSize) { mainSize = s; mainRoot = rt; }
  // a shelf is one the player stands on when most of it is full-weight ground; the rest is fringe in the fade, where the
  // terrace blends back into the natural slope (reported apart: it is walked as hillside, not as a shelf)
  const fringe = fringeShelves(comp, W, sizes.length);
  const cut0 = sizes.map((s, i) => ({ i, s, shelf: !fringe[i] })).filter((e) => find(e.i) !== mainRoot);
  const unlinked = cut0.filter((e) => e.shelf).map((e) => ({ level: level(compLevel[e.i]!), area: e.s * g * g }));
  const unlinkedFringe = cut0.filter((e) => !e.shelf).length;

  // a stranded ledge (no ramp, no cave fits) pinches out into its neighbour like a staggered one; a terrace folds only a
  // SMALL stranded shelf (a big one stays reported: a refusal to cut half the slope away)
  const unlinkedIds = cut0.filter((e) => e.shelf && ((o.cave && o.links !== "ramp") || e.s * g * g <= 4 * o.minShelf * o.minShelf)).map((e) => e.i);
  return { sizes, compLevel, T, rampCells, rampPaths, linkFloors, ramps, rampReport, caveTunnels, caveBlobs, caveReport, roots, find, unlinked, unlinkedFringe, fringe, mainRoot, unlinkedIds, cellAt };
  };
  let run = runLinks();
  // a fold is a pinch-out: the stranded ground moves at most ONE band from where the first solve put it, summed over the
  // retries (folding band by band down a whole slope once filled a 30 m-deep bowl level with the shelf above it)
  const Kfirst = Int32Array.from(K);
  for (let attempt = 0; attempt < 3 && run.unlinkedIds.length; attempt++) {
    const bd = borders(run.sizes), N = run.sizes.length;
    const into = new Map<number, number>();
    for (const u of run.unlinkedIds) {
      let best = -1, bestScore = -1;
      for (const [key, len] of bd) {
        const a = Math.floor(key / N), bb = key % N, v = a === u ? bb : bb === u ? a : -1;
        if (v < 0) continue;
        const score = len + (run.find(v) === run.mainRoot ? 1e6 : 0);
        if (score > bestScore) { bestScore = score; best = v; }
      }
      if (best >= 0) into.set(u, run.compLevel[best]!);
    }
    for (let i = 0; i < n; i++) { const lv = comp[i]! >= 0 ? into.get(comp[i]!) : undefined; if (lv !== undefined && Math.abs(lv - Kfirst[i]!) > 1) into.delete(comp[i]!); }
    if (!into.size) break;
    for (let i = 0; i < n; i++) { const lv = comp[i]! >= 0 ? into.get(comp[i]!) : undefined; if (lv !== undefined) K[i] = lv; }
    run = runLinks();
  }
  const { sizes, compLevel, T, rampCells, rampPaths, linkFloors, ramps, rampReport, caveTunnels, caveBlobs, caveReport, roots, unlinked, unlinkedFringe, fringe, cellAt } = run;

  // 6. kit walls on the risers
  const nearRamp = (x: number, z: number, pad: number) => ramps.some((rp) => {
    const dx = x - rp.ax, dz = z - rp.az;
    const s = dx * rp.t[0] + dz * rp.t[1], w = dx * rp.dn[0] + dz * rp.dn[1];
    return s >= -pad && s <= rp.len + pad && w >= -pad && w <= rp.width + pad;
  });
  const kitWalls: OperatorPiece[] = [];
  let tallRiser = 0, wallModules = 0, maxWall = 0;
  {
    // risers taller than the kit allows (left as banks; the report says so)
    const tall = tallCells(K, cols, rows, maxBands === Infinity ? 1e9 : maxBands, full);
    for (let i = 0; i < n; i++) tallRiser += tall[i]!;
  }
  if (o.walls) {
    const style = o.walls.style, minDrop = o.walls.minDrop;
    const present = [...new Set(K)].sort((a, c) => a - c);
    const taken: XZ[] = [];
    const holds: { at: XZ; u: XZ; top: number }[] = [];
    let runId = 0;
    for (const t of present.slice(1)) {
      const F0 = new Float64Array(n);
      for (let i = 0; i < n; i++) F0[i] = K[i]! >= t ? 1 : 0;
      const F = boxBlur(F0, cols, rows, 1);
      for (const line of contourLines(F, cols, rows, x0, z0, g)) {
        // orient: the low side (F < 0.5) on the right, (-uz, ux)
        const m = Math.floor(line.length / 2), A = line[Math.max(0, m - 1)]!, B = line[Math.min(line.length - 1, m + 1)]!;
        const ux = B[0] - A[0], uz = B[1] - A[1], ul = Math.hypot(ux, uz) || 1;
        const k = cellAt((A[0] + B[0]) / 2 - (uz / ul) * 2, (A[1] + B[1]) / 2 + (ux / ul) * 2);
        if (k >= 0 && F[k]! >= 0.5) line.reverse();
        const cum = [0];
        for (let q = 1; q < line.length; q++) cum.push(cum[q - 1]! + Math.hypot(line[q]![0] - line[q - 1]![0], line[q]![1] - line[q - 1]![1]));
        const total = cum[cum.length - 1]!;
        const pointAt = (d: number): XZ => {
          let q = 0;
          while (q < line.length - 2 && cum[q + 1]! < d) q++;
          const u = (d - cum[q]!) / (cum[q + 1]! - cum[q]! || 1);
          return [line[q]![0] + (line[q + 1]![0] - line[q]![0]) * u, line[q]![1] + (line[q + 1]![1] - line[q]![1]) * u];
        };
        let run: { at: XZ; u: XZ; top: number; foot: number }[] = [];
        const flush = () => {
          if (run.length * 2 >= FINE_MIN) {
            const pieces: Record<string, unknown>[] = [], cuts: Record<string, unknown>[] = [];
            for (const md of run) {
              const drop = md.top - md.foot;
              const hk = KIT_WALL_HEIGHTS.find((v) => v >= drop + 0.15)!;
              const baseY = md.top - hk;
              const yaw = r2((Math.atan2(-md.u[1], md.u[0]) * 180) / Math.PI);
              const cm = Math.round(hk * 100);
              pieces.push({ prefab: `retaining-wall/${style}-h${cm}-straight-2`, role: "straight-2", position: [r3(md.at[0]), r3(baseY), r3(md.at[1])], yaw, run: 2 });
              pieces.push({ prefab: `retaining-wall/${style}-cap-2`, role: "cap", position: [r3(md.at[0]), r3(md.top), r3(md.at[1])], yaw });
              cuts.push({ kind: "face", origin: [r3(md.at[0]), r3(md.at[1])], dir: [r3(md.u[0]), r3(md.u[1])], s: [0, 2], n: [0, r2(2.2 + drop / o.riserSlope + 1)], y: [r3(Math.max(baseY, md.foot - 0.05)), r3(md.top + 2)] });
              holds.push({ at: md.at, u: md.u, top: md.top });
              maxWall = Math.max(maxWall, hk);
              wallModules++;
            }
            kitWalls.push({ id: `wall-${runId++}`, style, pieces, cuts });
          }
          run = [];
        };
        const modules = Math.floor(total / 2);
        for (let mi = 0; mi < modules; mi++) {
          const at = pointAt(2 * mi), end = pointAt(2 * mi + 2);
          const dx = end[0] - at[0], dz = end[1] - at[1], len = Math.hypot(dx, dz);
          if (len < 1) { flush(); continue; }
          const u: XZ = [dx / len, dz / len], nr: XZ = [-u[1], u[0]];
          const mid: XZ = [(at[0] + end[0]) / 2, (at[1] + end[1]) / 2];
          const hiC = cellAt(mid[0] - nr[0] * 1.5, mid[1] - nr[1] * 1.5), loC = cellAt(mid[0] + nr[0] * 2.5, mid[1] + nr[1] * 2.5);
          const ok = hiC >= 0 && loC >= 0 && full(hiC) && full(loC) && comp[hiC]! >= 0 && comp[loC]! >= 0;
          const top = ok ? level(K[hiC]!) : 0, foot = ok ? level(K[loC]!) : 0, drop = top - foot;
          const dup = taken.some((p) => Math.hypot(p[0] - mid[0], p[1] - mid[1]) < 1);
          if (!ok || dup || drop < minDrop || drop + 0.15 > KIT_WALL_MAX || nearRamp(at[0], at[1], 3) || nearRamp(end[0], end[1], 3)) { flush(); continue; }
          taken.push(mid);
          run.push({ at, u, top, foot });
        }
        flush();
      }
    }
    // the lower shelf in front of each wall is held at its top: the riser bank stands inside the wall body (the cut takes it)
    for (const hd of holds) {
      const nr: XZ = [-hd.u[1], hd.u[0]];
      const c0 = Math.max(0, Math.floor((hd.at[0] - 5 - x0) / g)), c1 = Math.min(cols - 1, Math.ceil((hd.at[0] + 5 - x0) / g));
      const q0 = Math.max(0, Math.floor((hd.at[1] - 5 - z0) / g)), q1 = Math.min(rows - 1, Math.ceil((hd.at[1] + 5 - z0) / g));
      for (let r = q0; r <= q1; r++) for (let c = c0; c <= c1; c++) {
        const i = r * cols + c, x = x0 + c * g - hd.at[0], z = z0 + r * g - hd.at[1];
        const s = x * hd.u[0] + z * hd.u[1], w = x * nr[0] + z * nr[1];
        if (s >= 0 && s <= 2 && w >= 0 && w <= 2.2 && T[i]! < hd.top) T[i] = hd.top;
      }
    }
  }

  // 7. the one masked height patch
  const weights: number[] = new Array(n), heights: number[] = new Array(n);
  let cut = 0, fill = 0, cutFillSum = 0, coreCells = 0;
  for (let i = 0; i < n; i++) {
    weights[i] = Math.round(W[i]! * 1000) / 1000;
    heights[i] = r2(T[i]!);
    if (full(i)) {
      cut = Math.max(cut, H[i]! - T[i]!); fill = Math.max(fill, T[i]! - H[i]!);
      cutFillSum += Math.abs(H[i]! - T[i]!); coreCells++;
    }
  }
  const shelves = sizes.map((s, i) => ({ level: level(compLevel[i]!), area: s * g * g })).sort((a, c) => a.level - c.level || c.area - a.area);
  const features: ShelvingResult["features"] = {
    heightPatches: [{ id: "ground", origin: [x0, z0], size: [(cols - 1) * g, (rows - 1) * g], columns: cols, rows, heights, weights, blend: 2 * g, maxSlope: o.riserSlope }],
  };
  if (kitWalls.length) features.kitWalls = kitWalls;
  if (caveTunnels.length) { features.tunnels = caveTunnels; features.blobs = caveBlobs; }
  // one standing point per shelf (its cell nearest the shelf centroid): what a reachability walk starts from and must reach
  const cx = new Float64Array(sizes.length), cz = new Float64Array(sizes.length), cn = new Float64Array(sizes.length);
  for (let i = 0; i < n; i++) { const k = comp[i]!; if (k < 0 || !full(i)) continue; cx[k] = cx[k]! + (i % cols); cz[k] = cz[k]! + Math.floor(i / cols); cn[k] = cn[k]! + 1; }
  const anchorBest = new Float64Array(sizes.length).fill(Infinity), anchors: number[][] = sizes.map(() => []);
  for (let i = 0; i < n; i++) {
    const k = comp[i]!;
    if (k < 0 || !full(i) || fringe[k]) continue;
    const d = Math.hypot(i % cols - cx[k]! / cn[k]!, Math.floor(i / cols) - cz[k]! / cn[k]!);
    if (d < anchorBest[k]!) { anchorBest[k] = d; anchors[k] = [x0 + (i % cols) * g, z0 + Math.floor(i / cols) * g, level(compLevel[k]!)]; }
  }
  const fx = new Float64Array(sizes.length), fz = new Float64Array(sizes.length);
  for (let i = 0; i < n; i++) { const k = comp[i]!; if (k >= 0 && fringe[k]) { fx[k] = fx[k]! + (i % cols); fz[k] = fz[k]! + Math.floor(i / cols); } }
  return {
    features,
    grid: {
      x0, z0, g, cols, rows, base, bandHeight: h, H, W, K: Float64Array.from(K), T, ramp: rampCells, rampPaths, comp: Int32Array.from(comp),
      caves: linkFloors.map((floor) => ({ floor: floor.map((p) => [p[0], p[1], p[2]] as [number, number, number]), radius: o.cave?.radius ?? 3 })),
    },
    report: {
      base, bandHeight: h, medianSlope: r2(medianSlope), levels: [...new Set(shelves.map((s) => s.level))].sort((a, c) => a - c), shelves, mergedCells: merged,
      ramps: rampReport, caveLinks: caveReport, unlinked, unlinkedFringe, groups: roots.size, reachable: unlinked.length === 0,
      shelfAnchors: anchors.filter((a) => a.length),
      // FRINGE shelves (`fringeShelves`): hillside in the fade, no anchor, not a reach target
      fringe: sizes.flatMap((sz, k) => fringe[k] ? [{ level: level(compLevel[k]!), area: sz * g * g, at: [r2(x0 + (fx[k]! / sz) * g), r2(z0 + (fz[k]! / sz) * g)] }] : []),
      walls: { runs: kitWalls.length, modules: wallModules, maxHeight: maxWall, kitMax: KIT_WALL_MAX },
      tallRiserCells: tallRiser,
      maxCut: Math.round(cut * 10) / 10, maxFill: Math.round(fill * 10) / 10, meanCutFill: coreCells ? Math.round((cutFillSum / coreCells) * 100) / 100 : 0,
    },
  };
}

/**
 * Marching squares at 0.5 over a raster: chained polylines in world XZ (open chains first, then closed loops),
 * lightly smoothed so 2 m modules chord a calm line rather than the lattice stair.
 */
export function contourLines(F: Float64Array, cols: number, rows: number, x0: number, z0: number, g: number): XZ[][] {
  const iso = 0.5;
  const hId = (c: number, r: number) => 2 * (r * cols + c), vId = (c: number, r: number) => 2 * (r * cols + c) + 1;
  const pos = new Map<number, XZ>();
  const edgePoint = (e: number): XZ => {
    let p = pos.get(e);
    if (p) return p;
    const cell = e >> 1, c = cell % cols, r = Math.floor(cell / cols);
    const a = F[cell]!, b = e & 1 ? F[cell + cols]! : F[cell + 1]!;
    const t = Math.abs(b - a) < 1e-12 ? 0.5 : (iso - a) / (b - a);
    p = e & 1 ? [x0 + c * g, z0 + (r + t) * g] : [x0 + (c + t) * g, z0 + r * g];
    pos.set(e, p);
    return p;
  };
  const TABLE: number[][][] = [[], [[3, 0]], [[0, 1]], [[3, 1]], [[1, 2]], [[3, 0], [1, 2]], [[0, 2]], [[3, 2]], [[2, 3]], [[0, 2]], [[0, 1], [2, 3]], [[1, 2]], [[1, 3]], [[0, 1]], [[0, 3]], []];
  const segs: [number, number][] = [];
  for (let r = 0; r < rows - 1; r++) for (let c = 0; c < cols - 1; c++) {
    const i = r * cols + c;
    const idx = (F[i]! >= iso ? 1 : 0) | (F[i + 1]! >= iso ? 2 : 0) | (F[i + cols + 1]! >= iso ? 4 : 0) | (F[i + cols]! >= iso ? 8 : 0);
    const ids = [hId(c, r), vId(c + 1, r), hId(c, r + 1), vId(c, r)];
    for (const pr of TABLE[idx]!) segs.push([ids[pr[0]!]!, ids[pr[1]!]!]);
  }
  const at = new Map<number, number[]>();
  segs.forEach(([a, b2], s) => { for (const e of [a, b2]) { const l = at.get(e); if (l) l.push(s); else at.set(e, [s]); } });
  const used = new Uint8Array(segs.length);
  const lines: XZ[][] = [];
  const walk = (s0: number, from: number) => {
    const edgesOut: number[] = [from];
    let s = s0, cur = from;
    while (s >= 0 && !used[s]) {
      used[s] = 1;
      const [a, b2] = segs[s]!;
      cur = a === cur ? b2 : a;
      edgesOut.push(cur);
      s = (at.get(cur) ?? []).find((q) => !used[q]) ?? -1;
    }
    return edgesOut;
  };
  const order = [...segs.keys()];
  // open chains start at an edge used by one segment
  for (const s of order) {
    if (used[s]) continue;
    const [a, b2] = segs[s]!;
    if ((at.get(a)?.length ?? 0) === 1) lines.push(walk(s, a).map(edgePoint));
    else if ((at.get(b2)?.length ?? 0) === 1) lines.push(walk(s, b2).map(edgePoint));
  }
  for (const s of order) if (!used[s]) lines.push(walk(s, segs[s]![0]).map(edgePoint));
  return lines.map((l) => {
    let p = l.map((q) => [q[0], q[1]] as XZ);
    for (let it = 0; it < 3; it++) p = p.map((q, k) => (k === 0 || k === p.length - 1 ? q : [(p[k - 1]![0] + 2 * q[0] + p[k + 1]![0]) / 4, (p[k - 1]![1] + 2 * q[1] + p[k + 1]![1]) / 4] as XZ));
    return p;
  }).filter((l) => l.length >= 3);
}

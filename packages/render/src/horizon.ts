import type * as THREE from "three/webgpu";

/**
 * Terrain horizon occlusion.
 *
 * In a valley most of the streamed world is behind the ridge you are looking
 * at, and every one of those cells, POIs and props is still drawn: frustum
 * culling only knows what is off to the side. This is the cheap, exact-enough
 * answer for terrain, which is the occluder that matters in an open world:
 *
 * 1. **An occluder map** (`HorizonOccluderMap`) — a grid of the LOWEST terrain
 *    height in each 16 m square, stamped from the terrain meshes actually
 *    drawn (near cells at full resolution, HLOD blocks at their coarse
 *    resolution — what is on screen is what may hide things). The ground in a
 *    square is never below its value, so a ray passing under it is blocked.
 * 2. **A horizon** (`HorizonCuller`) — per world azimuth bin, marching out from
 *    the eye, the running maximum of "how steeply up would you have to look to
 *    clear the ground so far". A box whose top stays under that line, in every
 *    bin it spans, at every distance nearer than itself, is hidden.
 *
 * Everything is conservative in one direction only: a missing square, a
 * skipped step, an unstamped cell all make LESS hidden, never more. What is
 * given up is exactness — a notch narrower than a square does not see through.
 *
 * Deliberately CPU and immediate: GPU occlusion queries answer a frame late,
 * which is a visible pop every time something comes over a ridge.
 */

/**
 * The layer a renderable moves to while it is hidden behind terrain. The main
 * camera sees only layer 0, so it drops out of the main pass; shadow cameras
 * see both (SHADOW_CAMERA_LAYERS), so a tree just behind a crest keeps
 * throwing its shadow over it. three syncs a shadow camera's layers to the
 * main camera's only while the shadow camera has no layer beyond 0, which is
 * why the mask is set explicitly on every shadow camera.
 */
export const OCCLUDED_LAYER = 29;
export const SHADOW_CAMERA_LAYERS = 1 | (1 << OCCLUDED_LAYER);

/** Occluder squares per page axis — a page is a 64 x 64 block of squares. */
const PAGE = 64;
const PAGE_SHIFT = 6;
const UNKNOWN = -Infinity;

function pageKey(px: number, pz: number): number {
  return (px + 32768) * 65536 + (pz + 32768);
}

/**
 * The lowest drawn terrain height per square. Squares no mesh has covered are
 * UNKNOWN and occlude nothing. Paged and sparse, so an unbounded chunk world
 * costs only what is stamped.
 */
export class HorizonOccluderMap {
  private readonly raw = new Map<number, Float32Array>();
  /** 3x3-min of `raw`: what the horizon samples (see HorizonCuller.profile). */
  private readonly dilated = new Map<number, Float32Array>();
  private readonly dirty = new Set<number>();
  /** Bumped on every change, so a cached horizon knows to recompute. */
  version = 0;
  private lastKey = NaN;
  private lastPage: Float32Array | undefined;

  constructor(
    /** Metres per square. Keep it a divisor of the chunk cell size. */
    readonly square = 16,
  ) {}

  private rawPage(px: number, pz: number, create: boolean): Float32Array | undefined {
    const key = pageKey(px, pz);
    let page = this.raw.get(key);
    if (!page && create) {
      page = new Float32Array(PAGE * PAGE).fill(UNKNOWN);
      this.raw.set(key, page);
    }
    return page;
  }

  private rawAt(sx: number, sz: number): number {
    const page = this.raw.get(pageKey(sx >> PAGE_SHIFT, sz >> PAGE_SHIFT));
    return page ? page[(sz & (PAGE - 1)) * PAGE + (sx & (PAGE - 1))]! : UNKNOWN;
  }

  private touch(px: number, pz: number): void {
    for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) this.dirty.add(pageKey(px + dx, pz + dz));
    this.lastKey = NaN;
    this.version++;
  }

  /** Forget every square whose area lies inside the rect (world metres): it occludes nothing until stamped again. */
  clearRect(minX: number, minZ: number, maxX: number, maxZ: number): void {
    const s = this.square;
    const sx0 = Math.ceil(minX / s - 1e-6);
    const sz0 = Math.ceil(minZ / s - 1e-6);
    const sx1 = Math.floor(maxX / s + 1e-6) - 1;
    const sz1 = Math.floor(maxZ / s + 1e-6) - 1;
    for (let sz = sz0; sz <= sz1; sz++) {
      for (let sx = sx0; sx <= sx1; sx++) {
        const page = this.rawPage(sx >> PAGE_SHIFT, sz >> PAGE_SHIFT, false);
        if (page) page[(sz & (PAGE - 1)) * PAGE + (sx & (PAGE - 1))] = UNKNOWN;
      }
    }
    this.touchRange(sx0, sz0, sx1, sz1);
  }

  private touchRange(sx0: number, sz0: number, sx1: number, sz1: number): void {
    if (sx1 < sx0 || sz1 < sz0) return;
    for (let pz = sz0 >> PAGE_SHIFT; pz <= sz1 >> PAGE_SHIFT; pz++) {
      for (let px = sx0 >> PAGE_SHIFT; px <= sx1 >> PAGE_SHIFT; px++) this.touch(px, pz);
    }
  }

  /**
   * Lower the squares under every triangle of `geometry` (placed by `matrix`)
   * to that triangle's lowest vertex — but only squares wholly inside the rect,
   * which must be ground the mesh covers completely (its own cell). A triangle
   * spilling over a cell edge says nothing about the rest of the square it
   * spills into, so it must not stamp there.
   *
   * Call `clearRect` over the same rect first when the drawn terrain there
   * changed: stamping only ever lowers.
   */
  stampGeometry(
    geometry: THREE.BufferGeometry,
    matrix: THREE.Matrix4,
    rect: { minX: number; minZ: number; maxX: number; maxZ: number },
    /** Further restricts which squares (by square index) inside the rect may be stamped — a merged mesh over an irregular set of cells. */
    allow?: (sx: number, sz: number) => boolean,
  ): void {
    const position = geometry.getAttribute("position");
    if (!position) return;
    const s = this.square;
    const clipX0 = Math.ceil(rect.minX / s - 1e-6);
    const clipZ0 = Math.ceil(rect.minZ / s - 1e-6);
    const clipX1 = Math.floor(rect.maxX / s + 1e-6) - 1;
    const clipZ1 = Math.floor(rect.maxZ / s + 1e-6) - 1;
    if (clipX1 < clipX0 || clipZ1 < clipZ0) return;
    const e = matrix.elements;
    const index = geometry.index;
    const triangles = index ? index.count / 3 : position.count / 3;
    const array = position.array as ArrayLike<number>;
    const stride =
      (position as THREE.BufferAttribute & { data?: { stride: number } }).data?.stride ?? position.itemSize;
    const offset = (position as THREE.BufferAttribute & { offset?: number }).offset ?? 0;
    const idx = index ? (index.array as ArrayLike<number>) : null;
    const wx = [0, 0, 0];
    const wy = [0, 0, 0];
    const wz = [0, 0, 0];
    for (let t = 0; t < triangles; t++) {
      for (let k = 0; k < 3; k++) {
        const v = idx ? idx[t * 3 + k]! : t * 3 + k;
        const o = v * stride + offset;
        const x = array[o]!;
        const y = array[o + 1]!;
        const z = array[o + 2]!;
        wx[k] = e[0]! * x + e[4]! * y + e[8]! * z + e[12]!;
        wy[k] = e[1]! * x + e[5]! * y + e[9]! * z + e[13]!;
        wz[k] = e[2]! * x + e[6]! * y + e[10]! * z + e[14]!;
      }
      const low = Math.min(wy[0]!, wy[1]!, wy[2]!);
      const sx0 = Math.max(clipX0, Math.floor(Math.min(wx[0]!, wx[1]!, wx[2]!) / s));
      // a triangle only TOUCHING a square's far edge is not over it
      const sx1 = Math.min(clipX1, Math.max(sx0, Math.ceil(Math.max(wx[0]!, wx[1]!, wx[2]!) / s) - 1));
      const sz0 = Math.max(clipZ0, Math.floor(Math.min(wz[0]!, wz[1]!, wz[2]!) / s));
      const sz1 = Math.min(clipZ1, Math.max(sz0, Math.ceil(Math.max(wz[0]!, wz[1]!, wz[2]!) / s) - 1));
      for (let sz = sz0; sz <= sz1; sz++) {
        for (let sx = sx0; sx <= sx1; sx++) {
          if (allow && !allow(sx, sz)) continue;
          const page = this.rawPage(sx >> PAGE_SHIFT, sz >> PAGE_SHIFT, true)!;
          const i = (sz & (PAGE - 1)) * PAGE + (sx & (PAGE - 1));
          const current = page[i]!;
          if (current === UNKNOWN || low < current) page[i] = low;
        }
      }
    }
    this.touchRange(clipX0, clipZ0, clipX1, clipZ1);
  }

  /** Raw lowest height of the square containing (x, z), or -Infinity if unknown. */
  lowestAt(x: number, z: number): number {
    return this.rawAt(Math.floor(x / this.square), Math.floor(z / this.square));
  }

  /**
   * Lowest height over the 3x3 squares around the one containing (x, z) —
   * guaranteed to be under the ground everywhere within one square of the
   * point, in every direction. -Infinity if any of the nine is unknown.
   */
  lowestAround(x: number, z: number): number {
    const sx = Math.floor(x / this.square);
    const sz = Math.floor(z / this.square);
    const px = sx >> PAGE_SHIFT;
    const pz = sz >> PAGE_SHIFT;
    const key = pageKey(px, pz);
    let page: Float32Array | undefined;
    if (key === this.lastKey) page = this.lastPage;
    else {
      page = this.dilatedPage(px, pz, key);
      this.lastKey = key;
      this.lastPage = page;
    }
    return page ? page[(sz & (PAGE - 1)) * PAGE + (sx & (PAGE - 1))]! : UNKNOWN;
  }

  private dilatedPage(px: number, pz: number, key: number): Float32Array | undefined {
    if (!this.raw.has(key)) return undefined;
    let page = this.dilated.get(key);
    if (page && !this.dirty.has(key)) return page;
    page ??= new Float32Array(PAGE * PAGE);
    const bx = px << PAGE_SHIFT;
    const bz = pz << PAGE_SHIFT;
    for (let z = 0; z < PAGE; z++) {
      for (let x = 0; x < PAGE; x++) {
        let low = Infinity;
        for (let dz = -1; dz <= 1 && low !== UNKNOWN; dz++) {
          for (let dx = -1; dx <= 1; dx++) {
            const v = this.rawAt(bx + x + dx, bz + z + dz);
            if (v < low) low = v;
            if (low === UNKNOWN) break;
          }
        }
        page[z * PAGE + x] = low;
      }
    }
    this.dilated.set(key, page);
    this.dirty.delete(key);
    return page;
  }

  /** Squares known, for diagnostics. */
  stats(): { pages: number } {
    return { pages: this.raw.size };
  }

  clear(): void {
    this.raw.clear();
    this.dilated.clear();
    this.dirty.clear();
    this.lastKey = NaN;
    this.lastPage = undefined;
    this.version++;
  }
}

export interface HorizonOptions {
  /** Azimuth bins around the full circle. */
  bins?: number;
  /** Farthest occluder sample, metres: past it nothing occludes. */
  maxDistance?: number;
  /** Metres the occluder heights are lowered by, as slack for the stamps. */
  heightMargin?: number;
}

/**
 * The horizon from one eye. Bins are WORLD azimuths, so turning the camera
 * changes nothing; each bin's profile is computed lazily, only as far out as
 * a test asks, and only once per eye position.
 */
export class HorizonCuller {
  readonly bins: number;
  private readonly binAngle: number;
  /** Sample distances along every bin, ascending. */
  readonly steps: Float32Array;
  /** Running max of the occluder slope, per (bin, step). */
  private readonly profile: Float32Array;
  /** Last step computed per bin this eye, -1 = none. */
  private readonly computed: Int32Array;
  private readonly dirX: Float32Array;
  private readonly dirZ: Float32Array;
  private readonly heightMargin: number;
  private ex = NaN;
  private ey = NaN;
  private ez = NaN;
  private mapVersion = -1;
  /** Samples evaluated since the last `setEye` — the cost counter. */
  samples = 0;

  constructor(
    private readonly map: HorizonOccluderMap,
    options: HorizonOptions = {},
  ) {
    this.bins = options.bins ?? 1024;
    this.binAngle = (Math.PI * 2) / this.bins;
    this.heightMargin = options.heightMargin ?? 0.5;
    const maxDistance = options.maxDistance ?? 2400;
    // The profile claims a sample's lowest ground for rays within `REACH`
    // radially and laterally of it. Lateral: half a bin wide, so the bins
    // must be narrow enough at `maxDistance` — past it, stop.
    const reach = map.square / 2;
    const lateralLimit = reach / Math.tan(this.binAngle / 2);
    const limit = Math.min(maxDistance, lateralLimit);
    const steps: number[] = [];
    // start where the 3x3 block around a sample can no longer contain the eye
    for (let d = map.square * 1.5 + reach; d <= limit; d += Math.max(reach, d * 0.02)) steps.push(d);
    this.steps = Float32Array.from(steps);
    this.profile = new Float32Array(this.bins * this.steps.length);
    this.computed = new Int32Array(this.bins).fill(-1);
    this.dirX = new Float32Array(this.bins);
    this.dirZ = new Float32Array(this.bins);
    for (let b = 0; b < this.bins; b++) {
      const a = (b + 0.5) * this.binAngle;
      this.dirX[b] = Math.cos(a);
      this.dirZ[b] = Math.sin(a);
    }
  }

  /** Move the eye. Free when neither it nor the map changed. */
  setEye(x: number, y: number, z: number): void {
    if (x === this.ex && y === this.ey && z === this.ez && this.map.version === this.mapVersion) return;
    this.ex = x;
    this.ey = y;
    this.ez = z;
    this.mapVersion = this.map.version;
    this.computed.fill(-1);
    this.samples = 0;
  }

  /** Extend bin `b`'s profile out to step `k`. */
  private extend(b: number, k: number): void {
    let from = this.computed[b]!;
    if (from >= k) return;
    const reach = this.map.square / 2;
    const base = b * this.steps.length;
    let best = from >= 0 ? this.profile[base + from]! : -Infinity;
    const dx = this.dirX[b]!;
    const dz = this.dirZ[b]!;
    for (let s = from + 1; s <= k; s++) {
      const d = this.steps[s]!;
      const ground = this.map.lowestAround(this.ex + dx * d, this.ez + dz * d);
      if (ground !== -Infinity) {
        const rise = ground - this.heightMargin - this.ey;
        // Every ray of this bin passes over ground at least this high for
        // horizontal distances d ± reach; the steepest it can be blocked at
        // is at the NEAR end when the ground is above the eye, the far end
        // when below.
        const slope = rise / (rise > 0 ? d - reach : d + reach);
        if (slope > best) best = slope;
      }
      this.profile[base + s] = best;
    }
    this.samples += k - from;
    this.computed[b] = k;
  }

  /**
   * Whether an axis-aligned box is hidden behind the terrain. `margin` is a
   * slope (rise over run) the box must clear the horizon by to count as
   * hidden: positive hides later, negative (for "stay hidden") hides sooner.
   */
  isOccluded(
    minX: number,
    minZ: number,
    maxX: number,
    maxY: number,
    maxZ: number,
    margin = 0,
  ): boolean {
    const ex = this.ex;
    const ez = this.ez;
    // nearest and farthest horizontal distance from the eye to the footprint
    const nx = ex < minX ? minX - ex : ex > maxX ? ex - maxX : 0;
    const nz = ez < minZ ? minZ - ez : ez > maxZ ? ez - maxZ : 0;
    const near = Math.hypot(nx, nz);
    const reach = this.map.square / 2;
    // occluders must lie wholly nearer than the box; with none, it is seen
    const steps = this.steps;
    if (steps.length === 0 || near <= steps[0]! + reach) return false;
    let lo = 0;
    let hi = steps.length - 1;
    if (steps[hi]! + reach < near) lo = hi;
    else {
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (steps[mid]! + reach < near) lo = mid;
        else hi = mid - 1;
      }
    }
    const k = lo;
    const fx = Math.max(Math.abs(minX - ex), Math.abs(maxX - ex));
    const fz = Math.max(Math.abs(minZ - ez), Math.abs(maxZ - ez));
    const far = Math.hypot(fx, fz);
    const rise = maxY - this.ey;
    const slope = rise / (rise > 0 ? near : far);
    // azimuth span of the footprint's corners around its centre direction
    const centre = Math.atan2((minZ + maxZ) / 2 - ez, (minX + maxX) / 2 - ex);
    let span = 0;
    for (let c = 0; c < 4; c++) {
      const x = (c & 1 ? maxX : minX) - ex;
      const z = (c & 2 ? maxZ : minZ) - ez;
      let delta = Math.atan2(z, x) - centre;
      if (delta > Math.PI) delta -= Math.PI * 2;
      else if (delta < -Math.PI) delta += Math.PI * 2;
      span = Math.max(span, Math.abs(delta));
    }
    if (span >= Math.PI / 2) return false;
    const first = Math.floor((centre - span) / this.binAngle);
    const last = Math.floor((centre + span) / this.binAngle);
    const bins = this.bins;
    const stride = steps.length;
    for (let raw = first; raw <= last; raw++) {
      const b = ((raw % bins) + bins) % bins;
      this.extend(b, k);
      if (!(slope + margin < this.profile[b * stride + k]!)) return false;
    }
    return true;
  }

  /** Convenience over a THREE.Box3. */
  isBoxOccluded(box: THREE.Box3, margin = 0): boolean {
    return this.isOccluded(box.min.x, box.min.z, box.max.x, box.max.y, box.max.z, margin);
  }
}

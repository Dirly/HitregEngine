/**
 * Hydrology for the worldgen CLI: where water goes on a heightfield.
 *
 * The old river stage walked downhill from the highest points and gave up in
 * the first basin, which produced five-point rivers plunging from a summit
 * straight to the sea. Real drainage is a property of the WHOLE surface:
 * every drop of rain has exactly one way down, basins fill until they spill,
 * and a river is simply where enough of those paths coincide. That is what
 * this computes, the standard way:
 *
 *   1. **Priority-flood depression filling** (Barnes et al. 2014). Starting
 *      from the sea, cells are visited in order of height and raised to at
 *      least their downstream neighbour, so the filled surface drains to the
 *      sea everywhere. Where it was raised is a depression — and a depression
 *      big enough is a LAKE at exactly the level it spills.
 *   2. **D8 flow directions** on the filled surface, and **flow accumulation**
 *      weighted by local rainfall (a desert cell contributes little; a swamp
 *      cell a lot), so rivers are rarer in dry country.
 *   3. **Channel extraction**: cells above a catchment threshold are river,
 *      traced from each outlet UP its largest tributary for the main stem and
 *      then recursively for the branches, so a network comes out as a trunk
 *      plus tributaries that end where they join rather than as overlapping
 *      polylines fighting over one valley.
 *
 * Pure functions over typed arrays; nothing here knows about recipes.
 */

export interface HydroGrid {
  n: number;
  step: number;
  extent: number;
  /** Ground height per cell (whatever features the caller sampled). */
  height: Float32Array;
  /** 0..1 rainfall weight per cell. */
  rain: Float32Array;
  seaLevel: number;
}

export interface HydroResult {
  /** Depression-filled surface: drains to the sea from every land cell. */
  filled: Float32Array;
  /** Downstream neighbour index per cell, or -1 for a sink (sea, or the grid edge). */
  downstream: Int32Array;
  /** Rain-weighted upstream area, in cells. */
  accumulation: Float32Array;
  /** 1 where the cell is below sea level. */
  sea: Uint8Array;
}

const DX = [1, -1, 0, 0, 1, 1, -1, -1];
const DZ = [0, 0, 1, -1, 1, -1, 1, -1];
const DIST = [1, 1, 1, 1, Math.SQRT2, Math.SQRT2, Math.SQRT2, Math.SQRT2];

/** Minimal binary heap of (key, index). */
class MinHeap {
  private keys: number[] = [];
  private values: number[] = [];
  get size(): number {
    return this.keys.length;
  }
  push(key: number, value: number): void {
    const keys = this.keys;
    const values = this.values;
    keys.push(key);
    values.push(value);
    let i = keys.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (keys[parent]! <= keys[i]!) break;
      [keys[parent], keys[i]] = [keys[i]!, keys[parent]!];
      [values[parent], values[i]] = [values[i]!, values[parent]!];
      i = parent;
    }
  }
  pop(): [number, number] {
    const keys = this.keys;
    const values = this.values;
    const top: [number, number] = [keys[0]!, values[0]!];
    const lastKey = keys.pop()!;
    const lastValue = values.pop()!;
    if (keys.length > 0) {
      keys[0] = lastKey;
      values[0] = lastValue;
      let i = 0;
      for (;;) {
        const l = i * 2 + 1;
        const r = l + 1;
        let smallest = i;
        if (l < keys.length && keys[l]! < keys[smallest]!) smallest = l;
        if (r < keys.length && keys[r]! < keys[smallest]!) smallest = r;
        if (smallest === i) break;
        [keys[smallest], keys[i]] = [keys[i]!, keys[smallest]!];
        [values[smallest], values[i]] = [values[i]!, values[smallest]!];
        i = smallest;
      }
    }
    return top;
  }
}

/**
 * Fill depressions, derive flow directions and accumulate rain.
 *
 * `epsilon` is the tiny gradient imposed across a filled basin so every cell
 * still has a strictly-lower neighbour to flow to; a flat lake floor would
 * otherwise leave the tracer with nowhere to go.
 */
export function computeHydrology(grid: HydroGrid, epsilon = 0.005): HydroResult {
  const { n, height, seaLevel } = grid;
  const total = n * n;
  const filled = new Float32Array(total);
  const visited = new Uint8Array(total);
  const sea = new Uint8Array(total);
  const heap = new MinHeap();

  // seeds: the sea, and the grid edge (water leaving the map is fine)
  for (let i = 0; i < total; i++) {
    const ix = i % n;
    const iz = (i / n) | 0;
    const isSea = height[i]! < seaLevel;
    if (isSea) sea[i] = 1;
    if (isSea || ix === 0 || iz === 0 || ix === n - 1 || iz === n - 1) {
      filled[i] = height[i]!;
      visited[i] = 1;
      heap.push(height[i]!, i);
    }
  }

  while (heap.size > 0) {
    const [level, i] = heap.pop();
    const ix = i % n;
    const iz = (i / n) | 0;
    for (let k = 0; k < 8; k++) {
      const nx = ix + DX[k]!;
      const nz = iz + DZ[k]!;
      if (nx < 0 || nz < 0 || nx >= n || nz >= n) continue;
      const ni = nx + nz * n;
      if (visited[ni]) continue;
      visited[ni] = 1;
      const h = height[ni]!;
      // a cell below its outlet is raised to just above it: that is the fill
      filled[ni] = h > level + epsilon ? h : level + epsilon;
      heap.push(filled[ni]!, ni);
    }
  }

  // D8 on the filled surface: steepest descent always exists off a non-seed cell
  const downstream = new Int32Array(total).fill(-1);
  for (let i = 0; i < total; i++) {
    if (sea[i]) continue;
    const ix = i % n;
    const iz = (i / n) | 0;
    const here = filled[i]!;
    let best = -1;
    let bestDrop = 0;
    for (let k = 0; k < 8; k++) {
      const nx = ix + DX[k]!;
      const nz = iz + DZ[k]!;
      if (nx < 0 || nz < 0 || nx >= n || nz >= n) continue;
      const ni = nx + nz * n;
      const drop = (here - filled[ni]!) / DIST[k]!;
      if (drop > bestDrop) {
        bestDrop = drop;
        best = ni;
      }
    }
    downstream[i] = best;
  }

  // accumulate from the top down
  const order = new Int32Array(total);
  for (let i = 0; i < total; i++) order[i] = i;
  const sorted = Array.from(order).sort((a, b) => filled[b]! - filled[a]!);
  const accumulation = new Float32Array(total);
  for (let i = 0; i < total; i++) accumulation[i] = sea[i] ? 0 : grid.rain[i]!;
  for (const i of sorted) {
    const d = downstream[i]!;
    if (d >= 0) accumulation[d] = accumulation[d]! + accumulation[i]!;
  }

  return { filled, downstream, accumulation, sea };
}

export interface Channel {
  /** Grid cell indices from source to mouth. The last cell is the sea, a lake, or the cell it joins. */
  cells: number[];
  /** Accumulation at the mouth: the channel's size. */
  size: number;
  /** Index of the channel this one flows into, or -1 for one reaching the sea. */
  joins: number;
}

/**
 * Extract the channel network above `threshold` cells of accumulation.
 *
 * Main stems first: from every outlet (a river cell whose downstream is sea
 * or off-grid), walk UP the largest contributor until the accumulation drops
 * below threshold. Then every river cell not yet claimed that flows into a
 * claimed cell heads a tributary, traced the same way. Each channel therefore
 * owns its cells exclusively and ends exactly where it meets its parent.
 */
export function extractChannels(grid: HydroGrid, hydro: HydroResult, threshold: number, minLength = 8): Channel[] {
  const { n } = grid;
  const total = n * n;
  const { downstream, accumulation, sea } = hydro;
  const isRiver = (i: number): boolean => !sea[i] && accumulation[i]! >= threshold;

  // upstream adjacency: for each cell, its river contributors
  const contributors: number[][] = new Array(total);
  for (let i = 0; i < total; i++) {
    if (!isRiver(i)) continue;
    const d = downstream[i]!;
    if (d < 0) continue;
    (contributors[d] ??= []).push(i);
  }

  const owner = new Int32Array(total).fill(-1);
  const channels: Channel[] = [];

  const traceUp = (start: number, joins: number): void => {
    const cells: number[] = [];
    let cur = start;
    while (cur >= 0 && isRiver(cur) && owner[cur]! < 0) {
      cells.push(cur);
      const ups = contributors[cur];
      if (!ups || ups.length === 0) break;
      let best = -1;
      let bestAcc = -1;
      for (const u of ups) {
        if (owner[u]! >= 0) continue;
        if (accumulation[u]! > bestAcc) {
          bestAcc = accumulation[u]!;
          best = u;
        }
      }
      cur = best;
    }
    if (cells.length < minLength) return;
    const index = channels.length;
    for (const c of cells) owner[c] = index;
    cells.reverse(); // source first
    // append the cell it flows into (sea, or the parent's cell) so the carve
    // and the water reach it
    const mouth = downstream[cells[cells.length - 1]!]!;
    if (mouth >= 0) cells.push(mouth);
    channels.push({ cells, size: accumulation[cells[cells.length - (mouth >= 0 ? 2 : 1)]!]!, joins });
  };

  // outlets, biggest first
  const outlets: number[] = [];
  for (let i = 0; i < total; i++) {
    if (!isRiver(i)) continue;
    const d = downstream[i]!;
    if (d < 0 || sea[d]) outlets.push(i);
  }
  outlets.sort((a, b) => accumulation[b]! - accumulation[a]!);
  for (const o of outlets) traceUp(o, -1);

  // tributaries: any unclaimed river cell whose downstream is claimed
  let progress = true;
  while (progress) {
    progress = false;
    const heads: number[] = [];
    for (let i = 0; i < total; i++) {
      if (!isRiver(i) || owner[i]! >= 0) continue;
      const d = downstream[i]!;
      if (d >= 0 && owner[d]! >= 0) heads.push(i);
    }
    heads.sort((a, b) => accumulation[b]! - accumulation[a]!);
    for (const h of heads) {
      if (owner[h]! >= 0) continue;
      const before = channels.length;
      traceUp(h, owner[downstream[h]!]!);
      if (channels.length > before) progress = true;
      else {
        // too short to be a channel: claim it for its parent so it is not retried forever
        owner[h] = owner[downstream[h]!]!;
        progress = true;
      }
    }
  }
  return channels;
}

/**
 * A channel that runs through a lake (`wet(cell)` true somewhere on it; an authored channel always counts) but JOINS
 * one that does not — the rivers stage drops that one ("does not start at a lake") — would end in the field where its
 * parent used to be: a dangling reach (2026-10-29, redstrand dogfood 2231 river-4: 616 m from any water). It ADOPTS the
 * dropped parent's cells from its join down to that parent's own mouth, and joins whatever the parent joined, until it
 * reaches a channel that is kept or the sea. A second channel joining the same dropped parent stops at the first cell
 * already adopted and joins the adopter. Mutates `channels` (cells, joins); returns how many channels were extended.
 */
export function adoptDroppedParents(channels: (Channel & { authored?: unknown })[], wet: (cell: number) => boolean): number {
  const kept = channels.map((ch) => !!ch.authored || ch.cells.some(wet));
  /** cell -> the channel that adopted it */
  const claimed = new Map<number, number>();
  const order = channels
    .map((_, i) => i)
    .filter((i) => kept[i] && channels[i]!.joins >= 0 && !kept[channels[i]!.joins]!)
    .sort((a, b) => channels[b]!.size - channels[a]!.size);
  let extended = 0;
  for (const i of order) {
    const ch = channels[i]!;
    let guard = 0;
    let grew = false;
    while (ch.joins >= 0 && !kept[ch.joins]! && guard++ < channels.length) {
      const mouth = ch.cells[ch.cells.length - 1]!;
      const owner = claimed.get(mouth);
      if (owner !== undefined && owner !== i) {
        ch.joins = owner;
        break;
      }
      const parent = channels[ch.joins]!;
      const at = parent.cells.lastIndexOf(mouth);
      if (at < 0) break;
      let stopped = false;
      for (let k = at + 1; k < parent.cells.length; k++) {
        const c = parent.cells[k]!;
        ch.cells.push(c);
        const other = claimed.get(c);
        if (other !== undefined && other !== i) {
          ch.joins = other;
          stopped = true;
          break;
        }
        // the parent's last cell is its mouth: the sea, or a cell of the channel IT joins (not adopted)
        if (k < parent.cells.length - 1) claimed.set(c, i);
      }
      grew = true;
      if (stopped) break;
      ch.joins = parent.joins;
    }
    if (grew) extended++;
  }
  return extended;
}

export interface Basin {
  /** Cell indices of the standing water, shallows included. */
  cells: number[];
  /** How many of them hold at least `minDepth` of water — the basin's size for any "is it big" test. */
  deep: number;
  /** Spill level: the water surface. */
  level: number;
  /** Deepest fill below the surface. */
  depth: number;
  /** Lowest natural ground in the basin. */
  floor: number;
  /** The cell water leaves through: the first downstream cell outside the basin. */
  outlet: number;
  /** Outline in grid coordinates (cell-corner space), simplified. */
  outline: [number, number][];
  centroid: [number, number];
}

/**
 * Lakes: connected runs of cells the fill raised by at least `minDepth`, with
 * at least `minCells` of them and a spill level above the sea. The surface
 * is the MINIMUM filled height in the component — every cell in a filled
 * basin sits within epsilon of the spill level, so this is the spill level.
 */
export function extractBasins(grid: HydroGrid, hydro: HydroResult, minDepth = 1.2, minCells = 8): Basin[] {
  const { n, height, seaLevel } = grid;
  const total = n * n;
  const { filled, sea } = hydro;
  const inLake = new Uint8Array(total);
  for (let i = 0; i < total; i++) if (!sea[i] && filled[i]! - height[i]! >= minDepth) inLake[i] = 1;
  const seen = new Uint8Array(total);
  const basins: Basin[] = [];
  for (let start = 0; start < total; start++) {
    if (!inLake[start] || seen[start]) continue;
    const cells: number[] = [];
    const stack = [start];
    seen[start] = 1;
    let level = Infinity;
    let depth = 0;
    let floor = Infinity;
    while (stack.length > 0) {
      const i = stack.pop()!;
      cells.push(i);
      level = Math.min(level, filled[i]!);
      depth = Math.max(depth, filled[i]! - height[i]!);
      floor = Math.min(floor, height[i]!);
      const ix = i % n;
      const iz = (i / n) | 0;
      for (let k = 0; k < 4; k++) {
        const nx = ix + DX[k]!;
        const nz = iz + DZ[k]!;
        if (nx < 0 || nz < 0 || nx >= n || nz >= n) continue;
        const ni = nx + nz * n;
        if (seen[ni]) continue;
        // ONE SHEET IS ONE BASIN (2026-10-28): the walk crosses any standing water at this sheet's fill level, deep or
        // not. Seeded from deep cells only, a bowl whose underwater saddle sat less than minDepth under the surface came
        // out as two or three "basins" at the same spill level; the big one drained and the small ones kept the spill
        // level, so their sheets hung 5 m over the drained bowl and their outlets started in the air (every dogfood seed
        // failed water-logic on it). The parts of one bowl fill to levels a few decimetres apart on the lattice (55.69 /
        // 55.78 / 55.83 on seed 1337), so the tolerance is the shallows rule (1 m), not a hair.
        const sameSheet = !sea[ni] && filled[ni]! - height[ni]! >= 0.2 && Math.abs(filled[ni]! - filled[start]!) <= 1;
        if (!inLake[ni] && !sameSheet) continue;
        seen[ni] = 1;
        stack.push(ni);
      }
    }
    const deepCount = cells.reduce((k, c) => k + (inLake[c] ? 1 : 0), 0);
    if (deepCount < minCells || level <= seaLevel + 0.5) continue;
    const member = new Uint8Array(total);
    for (const c of cells) member[c] = 1;
    // The shallows. `minDepth` decides whether this is a lake at all, but a
    // lake's SHORE is where the water is 0 m deep, not 1.2 m: on a gentle
    // shelf the deep cells stop tens of metres short of the waterline, and
    // the sheet drawn from them ended in mid-air over a dry strip of bed. Grow
    // the member set through every neighbouring cell the same surface still
    // covers, however thinly, before tracing the outline.
    const deep = deepCount;
    const shallow = [...cells];
    for (let head = 0; head < shallow.length; head++) {
      const i = shallow[head]!;
      const ix = i % n;
      const iz = (i / n) | 0;
      for (let k = 0; k < 4; k++) {
        const nx = ix + DX[k]!;
        const nz = iz + DZ[k]!;
        if (nx < 0 || nz < 0 || nx >= n || nz >= n) continue;
        const ni = nx + nz * n;
        // true shallows only: a deep cell belongs to its own basin. A small
        // basin spilling into a big drained one shares its surface level, and
        // walking into the big one's deep cells re-flooded the whole bowl the
        // drain had emptied — at the spill level, nine metres over a town.
        if (member[ni] || sea[ni] || inLake[ni]) continue;
        if (filled[ni]! - height[ni]! < 0.2 || Math.abs(filled[ni]! - level) > 1) continue;
        member[ni] = 1;
        shallow.push(ni);
      }
    }
    cells.length = 0;
    for (const c of shallow) cells.push(c);
    // the outlet: follow any member cell downstream until it leaves the basin
    let outlet = -1;
    for (const c of cells) {
      let cur = hydro.downstream[c]!;
      let guard = 0;
      while (cur >= 0 && member[cur] && guard++ < total) cur = hydro.downstream[cur]!;
      if (cur >= 0) {
        outlet = cur;
        break;
      }
    }
    const outline = traceOutline(n, member);
    let cx = 0;
    let cz = 0;
    for (const c of cells) {
      cx += c % n;
      cz += (c / n) | 0;
    }
    basins.push({ cells, deep, level, depth, floor, outlet, outline, centroid: [cx / cells.length, cz / cells.length] });
  }
  basins.sort((a, b) => b.deep - a.deep);
  return basins;
}

/**
 * The part of a basin that is still under water when its surface is lowered
 * to `waterY` — the connected run of cells below it containing the lowest
 * point. Draining a big basin is how an inland sea becomes a lake with a
 * gorge leaving it: the outlet river is cut down through the sill, and only
 * the deep part stays wet.
 */
export function basinFootprint(
  grid: HydroGrid,
  basin: Basin,
  waterY: number,
  seed = -1,
): { cells: number[]; outline: [number, number][]; centroid: [number, number] } | null {
  const { n, height } = grid;
  const total = n * n;
  const member = new Uint8Array(total);
  const inBasin = new Uint8Array(total);
  for (const c of basin.cells) inBasin[c] = 1;
  // Grown from `seed` when given — the lowest cell the river crossing the
  // basin actually runs through — so a drained lake sits ON its river; the
  // basin's own lowest point may be a side bowl the channel never visits.
  let lowest = seed >= 0 && inBasin[seed] && height[seed]! < waterY - 0.1 ? seed : -1;
  // to the waterline, not a third of a metre under it (see the shallows in extractBasins)
  if (lowest < 0) for (const c of basin.cells) if (height[c]! < waterY - 0.1 && (lowest < 0 || height[c]! < height[lowest]!)) lowest = c;
  if (lowest < 0) return null;
  const cells: number[] = [];
  const stack = [lowest];
  member[lowest] = 1;
  while (stack.length > 0) {
    const i = stack.pop()!;
    cells.push(i);
    const ix = i % n;
    const iz = (i / n) | 0;
    for (let k = 0; k < 4; k++) {
      const nx = ix + DX[k]!;
      const nz = iz + DZ[k]!;
      if (nx < 0 || nz < 0 || nx >= n || nz >= n) continue;
      const ni = nx + nz * n;
      if (member[ni] || !inBasin[ni] || height[ni]! >= waterY - 0.1) continue;
      member[ni] = 1;
      stack.push(ni);
    }
  }
  let cx = 0;
  let cz = 0;
  for (const c of cells) {
    cx += c % n;
    cz += (c / n) | 0;
  }
  return { cells, outline: traceOutline(n, member), centroid: [cx / cells.length, cz / cells.length] };
}

/** Simplify a closed outline until it has at most `maxPoints` points, loosening the tolerance as needed. */
export function simplifyLoop(points: [number, number][], tolerance: number, maxPoints: number): [number, number][] {
  let out = simplifyClosed(points, tolerance);
  let t = tolerance;
  while (out.length > maxPoints && t < 64) {
    t *= 1.5;
    out = simplifyClosed(points, t);
  }
  return out;
}

/**
 * Outline of a cell mask as a polygon in cell-corner coordinates: collect the
 * boundary edges between member and non-member cells, chain them into loops,
 * keep the longest loop. Corner (ix, iz) is the top-left corner of cell (ix, iz).
 */
export function traceOutline(n: number, member: Uint8Array): [number, number][] {
  const edges = new Map<string, [number, number][]>(); // from-corner -> to-corners
  const add = (ax: number, az: number, bx: number, bz: number): void => {
    const key = `${ax},${az}`;
    const list = edges.get(key);
    if (list) list.push([bx, bz]);
    else edges.set(key, [[bx, bz]]);
  };
  for (let iz = 0; iz < n; iz++) {
    for (let ix = 0; ix < n; ix++) {
      const i = ix + iz * n;
      if (!member[i]) continue;
      // directed edges keep the interior on the left, so loops chain consistently
      if (iz === 0 || !member[i - n]) add(ix, iz, ix + 1, iz); // top
      if (ix === n - 1 || !member[i + 1]) add(ix + 1, iz, ix + 1, iz + 1); // right
      if (iz === n - 1 || !member[i + n]) add(ix + 1, iz + 1, ix, iz + 1); // bottom
      if (ix === 0 || !member[i - 1]) add(ix, iz + 1, ix, iz); // left
    }
  }
  let best: [number, number][] = [];
  const used = new Set<string>();
  for (const [startKey] of edges) {
    if (used.has(startKey)) continue;
    const loop: [number, number][] = [];
    let key = startKey;
    for (let guard = 0; guard < edges.size + 2; guard++) {
      const next = edges.get(key);
      if (!next || next.length === 0) break;
      const [x, z] = key.split(",").map(Number) as [number, number];
      loop.push([x, z]);
      used.add(key);
      const to = next.shift()!;
      key = `${to[0]},${to[1]}`;
      if (key === startKey) break;
    }
    if (loop.length > best.length) best = loop;
  }
  return simplifyClosed(best, 0.75);
}

/** Ramer-Douglas-Peucker for a closed loop (split at the two farthest points). */
function simplifyClosed(points: [number, number][], tolerance: number): [number, number][] {
  if (points.length < 8) return points;
  let a = 0;
  let b = 0;
  let far = -1;
  for (let i = 0; i < points.length; i += Math.max(1, Math.floor(points.length / 64))) {
    for (let j = i + 1; j < points.length; j += Math.max(1, Math.floor(points.length / 64))) {
      const d = (points[i]![0] - points[j]![0]) ** 2 + (points[i]![1] - points[j]![1]) ** 2;
      if (d > far) {
        far = d;
        a = i;
        b = j;
      }
    }
  }
  const first = points.slice(a, b + 1);
  const second = [...points.slice(b), ...points.slice(0, a + 1)];
  const s1 = simplifyOpen(first, tolerance);
  const s2 = simplifyOpen(second, tolerance);
  return [...s1.slice(0, -1), ...s2.slice(0, -1)];
}

export function simplifyOpen(points: [number, number][], tolerance: number): [number, number][] {
  if (points.length < 3) return points;
  const keep = new Uint8Array(points.length);
  keep[0] = 1;
  keep[points.length - 1] = 1;
  const stack: [number, number][] = [[0, points.length - 1]];
  while (stack.length > 0) {
    const [first, last] = stack.pop()!;
    let worst = 0;
    let worstIndex = -1;
    const a = points[first]!;
    const b = points[last]!;
    for (let i = first + 1; i < last; i++) {
      const d = pointSegment(points[i]!, a, b);
      if (d > worst) {
        worst = d;
        worstIndex = i;
      }
    }
    if (worstIndex >= 0 && worst > tolerance) {
      keep[worstIndex] = 1;
      stack.push([first, worstIndex], [worstIndex, last]);
    }
  }
  return points.filter((_, i) => keep[i] === 1);
}

function pointSegment(p: [number, number], a: [number, number], b: [number, number]): number {
  const dx = b[0] - a[0];
  const dz = b[1] - a[1];
  const lenSq = dx * dx + dz * dz;
  const t = lenSq < 1e-12 ? 0 : Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dz) / lenSq));
  return Math.hypot(p[0] - (a[0] + dx * t), p[1] - (a[1] + dz * t));
}

/**
 * The grade a river's water needs (`runGrade` before the margin and the cap): what its profile must lose outside its
 * ONE fall (the sharpest drop within `fallWindow` metres), per metre. The whole length's average was the old rule; it
 * under-reads a river whose lake holds its head up over a steep run below — the field cut that run down at the average
 * grade from the mouth up, and the cut reached the lake: a 7 m step at the outlet and the sheet hanging over it
 * (2026-10-29, redstrand dogfood 2029 lake-3: 4.5 % average, 7.7 % needed below the lake). So every ANCHOR (the head and
 * each lake point, `anchor[j]`) is also measured to every point at least `minRun` metres below it, with the fall
 * credited only when its window lies between them. `level` and `along` are per point, head to mouth.
 */
export function runGradeNeed(level: readonly number[], along: readonly number[], anchor: readonly boolean[], fallWindow = 60, minRun = 60): number {
  const n = level.length;
  if (n < 2) return 0;
  const length = along[n - 1]! - along[0]!;
  let fall = 0;
  let fallA = 0;
  let fallB = 0;
  for (let a = 0, b = 0; a < n; a++) {
    if (b < a) b = a;
    while (b + 1 < n && along[b + 1]! - along[a]! <= fallWindow) b++;
    if (level[a]! - level[b]! > fall) {
      fall = level[a]! - level[b]!;
      fallA = a;
      fallB = b;
    }
  }
  let need = length > 0 ? (level[0]! - level[n - 1]! - fall) / length : 0;
  for (let a = 0; a < n; a++) {
    if (!(a === 0 || anchor[a])) continue;
    // an anchor inside a run of anchors (a lake reach) is measured from its last point only
    if (a + 1 < n && anchor[a + 1]) continue;
    for (let b = a + 1; b < n; b++) {
      const run = along[b]! - along[a]!;
      if (run < minRun) continue;
      const credit = fallA >= a && fallB <= b ? fall : 0;
      need = Math.max(need, (level[a]! - level[b]! - credit) / run);
    }
  }
  return need;
}

/**
 * How many of a lake's banks a split-fall branch keeps between itself and the lake (2026-10-29 w3-hydro, redstrand
 * dogfood 2029: a fall 30 m below its lake's outlet split, the branch left the river at the shore and ran 1.9 m under
 * the sheet beside it — the lake's edge hung over the branch's water). Two banks = the reach of the lake's flood.
 */
export const SPLIT_LAKE_BANKS = 2;

/**
 * Does a split-fall branch keep clear of every lake: no point (its mouth excepted — it rejoins its river below the
 * fall) inside a lake's outline or within SPLIT_LAKE_BANKS banks of it?
 */
export function splitClearOfLakes(
  points: readonly (readonly [number, number])[],
  lakes: readonly { polygon?: readonly (readonly [number, number])[]; center: readonly [number, number]; radius: number; bank: number }[],
): boolean {
  for (let k = 0; k + 1 < points.length; k++) {
    const [x, z] = points[k]!;
    for (const lake of lakes) {
      const reach = lake.bank * SPLIT_LAKE_BANKS;
      if (!lake.polygon || lake.polygon.length < 3) {
        if (Math.hypot(x - lake.center[0], z - lake.center[1]) <= lake.radius + reach) return false;
        continue;
      }
      let inside = false;
      let best = Infinity;
      const poly = lake.polygon;
      for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
        const [xi, zi] = poly[i]!;
        const [xj, zj] = poly[j]!;
        if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
        const dx = xi - xj;
        const dz = zi - zj;
        const l = dx * dx + dz * dz;
        const t = l < 1e-9 ? 0 : Math.max(0, Math.min(1, ((x - xj) * dx + (z - zj) * dz) / l));
        best = Math.min(best, Math.hypot(x - xj - dx * t, z - zj - dz * t));
      }
      if (inside || best <= reach) return false;
    }
  }
  return true;
}

/**
 * A kept channel (it runs through a lake) that joins a KEPT parent ABOVE the parent's first lake ends where nothing is
 * written: the rivers stage starts the parent at that lake's shore and the parent's head above it is land (2026-10-29
 * w3-hydro, redstrand dogfood 2534: river-6 out of lake-4 ended 253 m from river-3, which starts at lake-6 below the
 * join — a dangling reach). The tributary carries on down the parent's head cells to the parent's first lake and ends
 * in it. Run after adoptDroppedParents. Mutates `channels` (cells); returns how many were extended.
 */
export function joinParentHeadLake(channels: (Channel & { authored?: unknown })[], wet: (cell: number) => boolean): number {
  let extended = 0;
  for (const ch of channels) {
    if (ch.joins < 0 || ch.authored || !ch.cells.some(wet)) continue;
    const parent = channels[ch.joins]!;
    if (parent.authored) continue;
    const firstWet = parent.cells.findIndex(wet);
    if (firstWet < 0) continue;
    const at = parent.cells.lastIndexOf(ch.cells[ch.cells.length - 1]!);
    if (at < 0 || at >= firstWet) continue;
    for (let k = at + 1; k <= firstWet; k++) ch.cells.push(parent.cells[k]!);
    extended++;
  }
  return extended;
}

/**
 * Does a river that starts at a lake end back in that same lake (its water, its one-cell ring or its dry bowl)? Such a
 * reach is an arm of the lake round a headland, never a river: written, it ended a hair outside the lake's outline and
 * the audit read a dangling reach (2026-10-29 w3-hydro, redstrand dogfood 3241 river-5: 450 m out of lake-1 and back,
 * 0.5 m off its shore). `wetOf` / `bowlOf`: the basin index a cell is under (or rings) / lies in, -1 for none.
 */
export function loopsBackToLake(cells: readonly number[], wetOf: (cell: number) => number, bowlOf: (cell: number) => number): boolean {
  if (cells.length < 2) return false;
  const head = wetOf(cells[0]!);
  if (head < 0) return false;
  const mouth = cells[cells.length - 1]!;
  return wetOf(mouth) === head || bowlOf(mouth) === head;
}

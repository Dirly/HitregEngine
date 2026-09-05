/**
 * Routing for the worldgen CLI: roads and trails that follow the ground.
 *
 * Two things went wrong with the first roads, and both are fixed here rather
 * than in the field:
 *
 * - **Mounds.** A road's height was sampled at a handful of simplified
 *   control points and grade-clamped, so between two points it was one
 *   straight ramp — above the ground for most of its length, and the field
 *   dutifully FILLED up to it. A causeway. The profile is now solved on the
 *   dense route (every grid step), and it is CUT-BIASED: fill is capped at a
 *   metre or so, cuts are allowed several metres, and the grade clamp is
 *   re-applied until both hold. A road that follows the terrain and digs
 *   into the uphill side is what a real road looks like.
 * - **Straight lines up hills.** The route cost now punishes grade hard
 *   enough that the search switchbacks up a slope instead of climbing it
 *   head-on, treats water as a wall, and charges a toll for crossing a river
 *   so crossings are few and deliberate.
 *
 * And a third, once the switchbacks existed:
 *
 * - **Hairpins inside one cell.** A cell-only search can reverse direction
 *   between two adjacent 16 m cells for free, so a steep climb came out as a
 *   stack of hairpins that read as a 360° loop from above. `turnWeight`
 *   makes the search carry a HEADING per cell and bend by at most 45° per
 *   step, which gives a road a turning radius (~20 m on a 16 m grid) and
 *   charges each bend, so a hairpin is taken only where the grade would cost
 *   more than four of them.
 */

export interface RouteGrid {
  n: number;
  step: number;
  /** Height per cell, with every feature except roads applied. */
  height: Float32Array;
  /** Per-cell traversal multiplier (1 = normal; swamp 2.5, water = Infinity). */
  cost: Float32Array;
  /** River width in metres on river cells (0 elsewhere): crossing is allowed but tolled by width. */
  river: Float32Array;
  /** Cells exempt from any hard grade cap (town pads and their ramps). */
  exempt?: Uint8Array;
  /**
   * Ground gradient per cell (rise per metre along +x / +z), the larger of
   * the two one-sided differences so a cliff inside one cell is not halved
   * by a central difference. What the CROSS-slope of a step is read from.
   */
  gradX?: Float32Array;
  gradZ?: Float32Array;
}

const DX = [1, -1, 0, 0, 1, 1, -1, -1];
const DZ = [0, 0, 1, -1, 1, -1, 1, -1];

export interface RouteOptions {
  /** Grade above which cost climbs steeply. */
  maxGrade: number;
  /** Cost per metre added per unit of grade (12 = a 10% grade costs 2.2x). */
  gradeWeight: number;
  /** Flat cost of stepping onto a river cell. */
  riverToll: number;
  /** Stop expanding past this many cells (a runaway search on a huge grid). */
  maxExpansions?: number;
  /**
   * Metres of road each 45° of heading change is worth. With this set the
   * search carries a heading per cell and can only bend by `maxTurn` steps of
   * 45° per grid cell — which is what gives a road a turning radius at all.
   * 0 or absent is the old free-turning search.
   */
  turnWeight?: number;
  /** Most the heading may change in ONE grid step, in 45° increments. 1 = a road; 2 lets a footpath corner. */
  maxTurn?: number;
  /**
   * Grade a single step may NEVER exceed — a wall, not a cost. The soft
   * penalty above `maxGrade` still lets a route take a steep step wherever
   * the detour would cost more, and the profile solve then cuts a trench
   * through the spur it climbed: the "cut-throughs". With a hard cap the
   * search has no such step to take and must contour — around the hill, or
   * up it in a spiral — which is what a real road does. Absent = uncapped.
   */
  hardGrade?: number;
  /**
   * Cells where `hardGrade` does not apply (1 = exempt), one per grid cell:
   * a town pad's ramp, the last few cells up to a summit. Without this the
   * cap fails on the ENDS of nearly every route — a pad edge is a 17 %
   * step on a 16 m grid, a peak's final cone is steeper than any trail —
   * and the whole road falls back to uncapped, which is no cap at all.
   */
  hardGradeExempt?: Uint8Array;
  /**
   * Cross-slope a step may never take: the ground's gradient ACROSS the
   * direction of travel at the cell stepped onto, as rise per metre. The
   * grade cap only looks along the path, so a trail was free to traverse a
   * 65° face at a comfortable 20 % — and the bench cut into that face was a
   * 17 m wall the voxel mesh drew as a staircase. 1.0 is a 45° hillside,
   * exactly the 1:1 cut bank the corridor can hold. Exempt cells allow twice this.
   */
  maxCross?: number;
  /** Cost multiplier per unit of cross-slope below the cap (3 = a 0.5 cross-slope costs 2.5×). */
  crossWeight?: number;
  /**
   * The cap that DOES apply in exempt cells — a scramble, not a cliff. Left
   * absent, an exempt cell takes any step at all, and a trail's last four
   * cells went straight up the summit cone at 300-500 %: the exemption was
   * meant to let a footpath steepen for the last leg, not to switch the cap
   * off. 3-4× the design grade (66-88 % for a 22 % trail) is a hands-on scramble.
   */
  exemptGrade?: number;
  /**
   * When the goal cannot be reached under the caps, return the route to the
   * best expanded cell instead of null: a trail that ends on the highest
   * walkable point below an unclimbable summit, rather than one that drops
   * every cap to reach the top. "Best" is the cell with the least height
   * still to climb, with plan distance as a light tie-breaker (`partialScore`),
   * so a shoulder just below the peak beats a cell at its foot that happens
   * to be closer on the map.
   */
  partial?: boolean;
  /**
   * With `partial`: radius in CELLS of a disc round the goal that is flooded
   * completely before the best cell is chosen. An A* that cannot reach its
   * goal spends its expansion budget on cheap ground far away (a steep step
   * costs as much as kilometres of flat), so the cells just under a summit
   * are the last it would look at; the disc is small enough to exhaust.
   */
  partialRadius?: number;
}

/** How far a cell is from being the goal, for a partial route: metres of height still to climb plus a quarter of the plan distance. */
function partialScore(grid: RouteGrid, cell: number, goal: number, planDistance: number): number {
  return Math.max(0, grid.height[goal]! - grid.height[cell]!) + planDistance * 0.25;
}

/** Binary min-heap of (key, value) pairs. */
class Heap {
  private readonly keys: number[] = [];
  private readonly vals: number[] = [];
  get size(): number {
    return this.keys.length;
  }
  push(key: number, value: number): void {
    const keys = this.keys;
    const vals = this.vals;
    keys.push(key);
    vals.push(value);
    let i = keys.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (keys[p]! <= keys[i]!) break;
      [keys[p], keys[i]] = [keys[i]!, keys[p]!];
      [vals[p], vals[i]] = [vals[i]!, vals[p]!];
      i = p;
    }
  }
  pop(): number {
    const keys = this.keys;
    const vals = this.vals;
    const top = vals[0]!;
    const lk = keys.pop()!;
    const lv = vals.pop()!;
    if (keys.length > 0) {
      keys[0] = lk;
      vals[0] = lv;
      let i = 0;
      for (;;) {
        const l = i * 2 + 1;
        const r = l + 1;
        let s = i;
        if (l < keys.length && keys[l]! < keys[s]!) s = l;
        if (r < keys.length && keys[r]! < keys[s]!) s = r;
        if (s === i) break;
        [keys[s], keys[i]] = [keys[i]!, keys[s]!];
        [vals[s], vals[i]] = [vals[i]!, vals[s]!];
        i = s;
      }
    }
    return top;
  }
}

/** Cost of stepping from a cell at height `h0` onto cell `to` over `run` metres in direction (dx, dz), or Infinity for water. */
function stepCost(grid: RouteGrid, h0: number, to: number, run: number, dx: number, dz: number, options: RouteOptions): number {
  const mult = grid.cost[to]!;
  if (!Number.isFinite(mult)) return Infinity; // water: a wall
  const grade = Math.abs(grid.height[to]! - h0) / run;
  if (options.hardGrade !== undefined && grade > options.hardGrade) {
    if (!options.hardGradeExempt?.[to]) return Infinity;
    if (options.exemptGrade !== undefined && grade > options.exemptGrade) return Infinity;
  }
  let c = run * mult * (1 + grade * options.gradeWeight);
  if (grid.gradX && grid.gradZ && (options.maxCross !== undefined || options.crossWeight)) {
    // the gradient's component perpendicular to the step: |g × d| / |d|
    const cross = Math.abs(grid.gradX[to]! * dz - grid.gradZ[to]! * dx) / Math.hypot(dx, dz);
    if (options.maxCross !== undefined && cross > (options.hardGradeExempt?.[to] ? options.maxCross * 2 : options.maxCross)) return Infinity;
    if (options.crossWeight) c *= 1 + cross * options.crossWeight;
  }
  if (grade > options.maxGrade) c += run * 30 * (grade - options.maxGrade) * 10;
  if (grade > options.maxGrade * 3) c += run * 200;
  // a toll that grows with the width: a brook is crossed anywhere, a broad
  // river only where it is worth a bridge — and a route that RUNS along a
  // river pays it every step, which is why roads leave the valley floor
  if (grid.river[to]! > 0) c += options.riverToll * (0.5 + grid.river[to]! / 8);
  return c;
}

/** A* over the grid from `start` to `goal` (cell indices). Returns cell indices, start first. */
export function routeBetween(grid: RouteGrid, start: number, goal: number, options: RouteOptions): number[] | null {
  if ((options.turnWeight ?? 0) > 0) return routeWithHeading(grid, start, goal, options);
  const { n, step, height } = grid;
  const total = n * n;
  const gScore = new Float64Array(total).fill(Infinity);
  const cameFrom = new Int32Array(total).fill(-1);
  const closed = new Uint8Array(total);
  gScore[start] = 0;
  const gx = goal % n;
  const gz = (goal / n) | 0;
  const heuristic = (i: number): number => Math.hypot((i % n) - gx, ((i / n) | 0) - gz) * step;

  const heap = new Heap();
  heap.push(heuristic(start), start);
  let expansions = 0;
  const maxExpansions = options.maxExpansions ?? total;
  let nearest = start;
  let nearestH = partialScore(grid, start, goal, heuristic(start));
  let reached = false;
  while (heap.size > 0) {
    const current = heap.pop();
    if (closed[current]) continue;
    if (current === goal) {
      reached = true;
      break;
    }
    closed[current] = 1;
    const score = partialScore(grid, current, goal, heuristic(current));
    if (score < nearestH) {
      nearestH = score;
      nearest = current;
    }
    if (++expansions > maxExpansions) break;
    const ix = current % n;
    const iz = (current / n) | 0;
    const h0 = height[current]!;
    for (let k = 0; k < 8; k++) {
      const nx = ix + DX[k]!;
      const nz = iz + DZ[k]!;
      if (nx < 0 || nz < 0 || nx >= n || nz >= n) continue;
      const ni = nx + nz * n;
      if (closed[ni]) continue;
      const run = (k < 4 ? 1 : Math.SQRT2) * step;
      const c = stepCost(grid, h0, ni, run, DX[k]!, DZ[k]!, options);
      if (!Number.isFinite(c)) continue;
      const tentative = gScore[current]! + c;
      if (tentative >= gScore[ni]!) continue;
      gScore[ni] = tentative;
      cameFrom[ni] = current;
      heap.push(tentative + heuristic(ni), ni);
    }
  }
  if (!reached && goal !== start) {
    if (!options.partial || nearest === start) return null;
    goal = nearest;
  }
  const out: number[] = [];
  let node = goal;
  for (let guard = 0; guard < total; guard++) {
    out.push(node);
    if (node === start) break;
    node = cameFrom[node]!;
    if (node < 0) return null;
  }
  return out.reverse();
}

// The eight headings in ANGULAR order, so a turn is a difference of indices.
const HX = [1, 1, 0, -1, -1, -1, 0, 1];
const HZ = [0, 1, 1, 1, 0, -1, -1, -1];

/** Scratch for the heading search — nine bytes per state, so it is kept between roads rather than reallocated. */
let headingScratch: { total: number; g: Float32Array; from: Int32Array; closed: Uint8Array } | null = null;

/**
 * A* over (cell, heading) states. A state's successors are the cells in
 * headings within `maxTurn` × 45° of its own, each charged `turnWeight` per
 * 45° of bend on top of the ground cost. The minimum turning radius that
 * falls out is about `step / (maxTurn × π/4)` — 20 m on a 16 m grid — and a
 * hairpin costs four bends, so the search takes one only where the grade
 * would cost more.
 *
 * The heuristic is straight-line distance, which never over-estimates
 * because every step costs at least its run — so the route is optimal for
 * this cost, not merely a smoothed version of the free-turning one. That
 * matters: smoothing a route that already loops does not un-loop it.
 */
function routeWithHeading(grid: RouteGrid, start: number, goal: number, options: RouteOptions): number[] | null {
  const { n, step, height } = grid;
  const total = n * n * 8;
  if (!headingScratch || headingScratch.total !== total) {
    headingScratch = { total, g: new Float32Array(total), from: new Int32Array(total), closed: new Uint8Array(total) };
  }
  const { g, from, closed } = headingScratch;
  g.fill(Infinity);
  from.fill(-1);
  closed.fill(0);
  const turnWeight = options.turnWeight ?? 0;
  const maxTurn = Math.max(1, Math.min(4, Math.round(options.maxTurn ?? 1)));
  const gx = goal % n;
  const gz = (goal / n) | 0;
  const heuristic = (cell: number): number => Math.hypot((cell % n) - gx, ((cell / n) | 0) - gz) * step;

  /** Relax every successor of `current`; `discOnly` keeps the successors inside the partial disc (Dijkstra, no heuristic). */
  const relax = (current: number, cell: number, into: Heap, discOnly: boolean): void => {
    const heading = current - cell * 8;
    const ix = cell % n;
    const iz = (cell / n) | 0;
    const h0 = height[cell]!;
    for (let turn = -maxTurn; turn <= maxTurn; turn++) {
      const nh = (heading + turn + 8) % 8;
      const nx = ix + HX[nh]!;
      const nz = iz + HZ[nh]!;
      if (nx < 0 || nz < 0 || nx >= n || nz >= n) continue;
      if (discOnly && (nx - gx) ** 2 + (nz - gz) ** 2 > discR2) continue;
      const ni = nx + nz * n;
      const ns = ni * 8 + nh;
      if (closed[ns]) continue;
      const run = (nh & 1 ? Math.SQRT2 : 1) * step;
      const c = stepCost(grid, h0, ni, run, HX[nh]!, HZ[nh]!, options);
      if (!Number.isFinite(c)) continue;
      const tentative = g[current]! + c + Math.abs(turn) * turnWeight;
      if (tentative >= g[ns]!) continue;
      g[ns] = tentative;
      from[ns] = current;
      into.push(discOnly ? tentative : tentative + heuristic(ni), ns);
    }
  };
  let discR2 = 0;
  /**
   * The partial fallback's second pass: exhaust the disc round the goal from
   * whatever frontier the A* left inside it, then return the best state
   * (least height still to climb) in the disc, or -1 when the A* never
   * reached the disc at all.
   */
  const floodDisc = (radius: number): number => {
    discR2 = radius * radius;
    const disc = new Heap();
    const cells: number[] = [];
    for (let dz = -radius; dz <= radius; dz++) {
      for (let dx = -radius; dx <= radius; dx++) {
        if (dx * dx + dz * dz > discR2) continue;
        const x = gx + dx;
        const z = gz + dz;
        if (x < 0 || z < 0 || x >= n || z >= n) continue;
        const cell = x + z * n;
        cells.push(cell);
        for (let h = 0; h < 8; h++) {
          const state = cell * 8 + h;
          if (!closed[state] && Number.isFinite(g[state]!)) disc.push(g[state]!, state);
        }
      }
    }
    while (disc.size > 0) {
      const current = disc.pop();
      if (closed[current]) continue;
      closed[current] = 1;
      relax(current, (current / 8) | 0, disc, true);
    }
    let best = -1;
    let bestScore = Infinity;
    for (const cell of cells) {
      if (cell === start) continue;
      for (let h = 0; h < 8; h++) {
        const state = cell * 8 + h;
        if (!closed[state]) continue;
        const score = partialScore(grid, cell, goal, heuristic(cell));
        if (score < bestScore) {
          bestScore = score;
          best = state;
        }
      }
    }
    return best;
  };

  const heap = new Heap();
  // any heading out of the start
  for (let h = 0; h < 8; h++) {
    g[start * 8 + h] = 0;
    heap.push(heuristic(start), start * 8 + h);
  }
  let expansions = 0;
  const maxExpansions = (options.maxExpansions ?? n * n) * 8;
  let found = -1;
  let nearest = -1;
  let nearestH = Infinity;
  while (heap.size > 0) {
    const current = heap.pop();
    if (closed[current]) continue;
    const cell = (current / 8) | 0;
    if (cell === goal) {
      found = current;
      break;
    }
    closed[current] = 1;
    const score = partialScore(grid, cell, goal, heuristic(cell));
    if (score < nearestH && cell !== start) {
      nearestH = score;
      nearest = current;
    }
    if (++expansions > maxExpansions) break;
    relax(current, cell, heap, false);
  }
  if (found < 0) {
    if (goal === start) return [start];
    if (!options.partial) return null;
    if (options.partialRadius) {
      const inDisc = floodDisc(options.partialRadius);
      if (inDisc >= 0) nearest = inDisc;
    }
    if (nearest < 0) return null;
    found = nearest;
  }
  const out: number[] = [];
  let state = found;
  for (let guard = 0; guard < total; guard++) {
    const cell = (state / 8) | 0;
    if (out.length === 0 || out[out.length - 1] !== cell) out.push(cell);
    if (cell === start) break;
    state = from[state]!;
    if (state < 0) return null;
  }
  return out.reverse();
}

export interface ProfileOptions {
  maxGrade: number;
  /** Most the road may stand above natural ground. Keep it small: this is what stops causeways. */
  maxFill: number;
  /** Most the road may be dug below natural ground. */
  maxCut: number;
  iterations?: number;
  /**
   * Which constraint wins where both cannot hold. `grade` (default, roads):
   * the last pass is the grade clamp, so the road is drivable even if that
   * means a deeper cut. `cut`: the last pass is the cut/fill clamp, so the
   * surface never leaves the ground by more than the caps and the path
   * simply steepens — a footpath scrambling up a summit cone, not a trench
   * a hundred metres deep dug into the peak so the last leg stays at 22 %.
   */
  finalClamp?: "grade" | "cut";
}

/**
 * Solve a road's surface heights over a dense route.
 *
 * Alternating projections: clamp the grade in both directions, then clamp
 * fill and cut against the natural profile, repeat. Each projection is
 * cheap and the pair converges in a few dozen passes on any route the
 * search produced (which already avoids steep ground). The final pass is a
 * grade clamp, so drivability is guaranteed even where a fill/cut cap could
 * not quite be honoured at the same time.
 *
 * `pinned.at[i]` fixes any interior point (a ford held just under the water
 * surface, so the road neither dams the river nor sinks into its bed);
 * `pinned.start`/`end` are the town pads.
 */
export function solveProfile(
  natural: readonly number[],
  spans: readonly number[],
  options: ProfileOptions,
  pinned: { start?: number; end?: number; at?: readonly (number | undefined)[] } = {},
): number[] {
  const p = [...natural];
  const last = p.length - 1;
  const applyPins = (): void => {
    if (pinned.at) {
      for (let i = 0; i <= last; i++) {
        const y = pinned.at[i];
        if (y !== undefined) p[i] = y;
      }
    }
    if (pinned.start !== undefined) p[0] = pinned.start;
    if (pinned.end !== undefined) p[last] = pinned.end;
  };
  applyPins();
  const clampGrade = (): void => {
    for (let i = 1; i <= last; i++) {
      const limit = spans[i]! * options.maxGrade;
      p[i] = Math.max(p[i - 1]! - limit, Math.min(p[i - 1]! + limit, p[i]!));
    }
    for (let i = last - 1; i >= 0; i--) {
      const limit = spans[i + 1]! * options.maxGrade;
      p[i] = Math.max(p[i + 1]! - limit, Math.min(p[i + 1]! + limit, p[i]!));
    }
    applyPins();
  };
  const clampCutFill = (): void => {
    for (let i = 0; i <= last; i++) {
      const hi = natural[i]! + options.maxFill;
      const lo = natural[i]! - options.maxCut;
      if (p[i]! > hi) p[i] = hi;
      if (p[i]! < lo) p[i] = lo;
    }
    applyPins();
  };
  const iterations = options.iterations ?? 40;
  for (let it = 0; it < iterations; it++) {
    clampGrade();
    clampCutFill();
  }
  const finish = options.finalClamp === "cut" ? clampCutFill : clampGrade;
  finish();
  // one light smoothing pass takes the corner off each grid step; the clamp
  // above is what keeps the road drivable, not this
  for (let i = 1; i < last; i++) p[i] = (p[i - 1]! + p[i]! * 2 + p[i + 1]!) / 4;
  finish();
  return p;
}

/**
 * Round the corners of a dense route in plan: `passes` of a [1 2 1]/4 kernel
 * over the interior points, each point kept where it was if the rounded
 * position would land on ground the search treats as a wall. A heading-
 * limited search produces straight legs joined by 45° corners; this turns
 * each corner into a curve a few cells long, which is what a road looks like
 * in plan, and it does so BEFORE the profile is solved so the heights are
 * taken where the road actually runs.
 */
export function smoothRoute(
  points: [number, number][],
  passes: number,
  passable: (x: number, z: number) => boolean,
): [number, number][] {
  let cur = points.map((p) => [p[0], p[1]] as [number, number]);
  for (let pass = 0; pass < passes; pass++) {
    const next = cur.map((p) => [p[0], p[1]] as [number, number]);
    for (let i = 1; i + 1 < cur.length; i++) {
      const x = (cur[i - 1]![0] + cur[i]![0] * 2 + cur[i + 1]![0]) / 4;
      const z = (cur[i - 1]![1] + cur[i]![1] * 2 + cur[i + 1]![1]) / 4;
      if (passable(x, z)) next[i] = [x, z];
    }
    cur = next;
  }
  return cur;
}

/**
 * Nearest cell on any of the given routes (or the exact cell if one has it).
 * Used to attach a trail to the existing road network.
 */
export function nearestRouteCell(n: number, routes: readonly (readonly number[])[], from: number): number {
  const fx = from % n;
  const fz = (from / n) | 0;
  let best = -1;
  let bestD = Infinity;
  for (const route of routes) {
    for (const c of route) {
      const d = ((c % n) - fx) ** 2 + (((c / n) | 0) - fz) ** 2;
      if (d < bestD) {
        bestD = d;
        best = c;
      }
    }
  }
  return best;
}

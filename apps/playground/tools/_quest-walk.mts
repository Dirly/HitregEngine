/**
 * The ground planner and walker quest-play uses for `--walk`, lifted from town-walk.mts (same grid, same rules):
 *
 *   plan   A* on a 1 m grid sampled from the PHYSICS world the body walks (a downward ray finds the floor a foot
 *          lands on, an upward ray what a head hits); dry, <= 40° on terrain, <= ~56° on built stairs, a metre of
 *          shoulder, edges cost more. Long trips are planned in legs of LEG metres along the straight line, each
 *          leg's end snapped to the nearest open cell — so a trip is cut off where no leg can be planned.
 *   walk   the server's own PlayerDriver, steered by input commands (the same intents a client sends) at a point
 *          3 m ahead of the route cursor; < 0.6 m of progress in 1.5 s is stuck: sidestep left, right, then three
 *          jumps, then it is stuck for good and the point is reported.
 */
import type { HeadlessWorld, TerrainStreamer } from "../../../packages/server/src/index.ts";

export type P2 = [number, number];
export type P3 = [number, number, number];

interface FieldLike {
  height(x: number, z: number): number;
  surfaceCast(x: number, z: number, y0: number, y1: number): number | null;
  waterY(x: number, z: number): number | null;
  recipe: { cellSize: number; seaLevel: number };
}

export interface WalkDeps {
  world: HeadlessWorld;
  terrain: TerrainStreamer;
  field: FieldLike;
  bodyId: string;
  runSpeed: number;
  /** Send one movement intent and advance one server tick. */
  stepWith(v: [number, number], jump: boolean): void;
  /** Advance one server tick with no input. */
  tick(): void;
}

export interface Stuck { at: P3; along: number; ground: number; jumped: boolean; touching: string[] }
export interface WalkResult {
  from: P3; to: P2; metres: number; finished: boolean; reached: number; stuck: Stuck[]; seconds: number;
  /** Walk-out: what known-walkable network the body joined ("road:<id>", "town:<id>", "gate:<town>/<gate>"). */
  joined?: string;
  /** Walk-out: the first descent a player could not climb back up (airborne fall or slide steeper than the climb limit). */
  oneWay?: { at: P3; drop: number; kind: "fall" | "slope" };
  /** Walk-out: the route walked, sampled about every metre, start to join (what the forward proof replays). */
  trail?: P2[];
  /** Set when no route could be planned: where the planner gave up. */
  unplanned?: { at: P2; why: string };
}

const CLIMB_TAN = Math.tan((40 * Math.PI) / 180);
const LEG = 140;
const dist = (a: P2, b: P2): number => Math.hypot(a[0] - b[0], a[1] - b[1]);

export function densify(points: P2[], step: number): P2[] {
  const out: P2[] = [points[0]!];
  for (let k = 1; k < points.length; k++) {
    const [ax, az] = points[k - 1]!;
    const [bx, bz] = points[k]!;
    const steps = Math.max(1, Math.ceil(dist(points[k - 1]!, points[k]!) / step));
    for (let s = 1; s <= steps; s++) out.push([ax + ((bx - ax) * s) / steps, az + ((bz - az) * s) / steps]);
  }
  return out;
}

/** One A* leg (town-walk's planner). `snapGoal` m: an unwalkable goal moves to the nearest open cell within it. */
function planLeg(d: WalkDeps, from: P2, to: P2, pad: number, snapGoal: number): P2[] | null {
  const { world, terrain, field } = d;
  const recipe = field.recipe;
  const x0 = Math.floor(Math.min(from[0], to[0]) - pad);
  const z0 = Math.floor(Math.min(from[1], to[1]) - pad);
  const w = Math.ceil(Math.max(from[0], to[0]) + pad) - x0;
  const h = Math.ceil(Math.max(from[1], to[1]) + pad) - z0;
  const H = new Float32Array(w * h);
  const ok = new Uint8Array(w * h);
  const built = new Uint8Array(w * h);
  const cells = new Set<string>();
  for (let cz = Math.floor(z0 / recipe.cellSize); cz <= Math.floor((z0 + h) / recipe.cellSize); cz++)
    for (let cx = Math.floor(x0 / recipe.cellSize); cx <= Math.floor((x0 + w) / recipe.cellSize); cx++)
      if (!cells.has(`${cx},${cz}`)) { cells.add(`${cx},${cz}`); terrain.ensureAround((cx + 0.5) * recipe.cellSize, (cz + 0.5) * recipe.cellSize, 0); }
  d.tick(); // colliders of freshly ensured cells join the query world
  for (let j = 0; j < h; j++)
    for (let i = 0; i < w; i++) {
      const x = x0 + i;
      const z = z0 + j;
      const g = field.height(x, z);
      const top = field.surfaceCast(x, z, g + 40, g - 40) ?? g;
      const down = world.sim.raycast([x, top + 3, z], [0, -1, 0], 8, { solid: true, exclude: [d.bodyId] });
      const foot = down ? down.point[1] : top;
      if (down && !down.entityId.includes("/terrain")) built[i + j * w] = 1;
      const head = world.sim.raycast([x, foot + 0.3, z], [0, 1, 0], 1.5, { solid: true, exclude: [d.bodyId] });
      H[i + j * w] = foot;
      const water = field.waterY(x, z);
      ok[i + j * w] = foot >= recipe.seaLevel + 0.2 && !(water !== null && water > foot + 0.3) && !head ? 1 : 0;
    }
  const open0 = ok.slice();
  for (let j = 1; j < h - 1; j++)
    for (let i = 1; i < w - 1; i++) {
      const k = i + j * w;
      if (!open0[k]) continue;
      for (let dj = -1; dj <= 1 && ok[k]; dj++) for (let di = -1; di <= 1; di++) if (!open0[k + di + dj * w]) { ok[k] = 0; break; }
    }
  const edge = new Float32Array(w * h);
  for (let j = 1; j < h - 1; j++)
    for (let i = 1; i < w - 1; i++) {
      const k = i + j * w;
      let m = 0;
      for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) m = Math.max(m, Math.abs(H[k + di + dj * w]! - H[k]!));
      edge[k] = m > 0.5 ? 4 : 0;
    }
  const idx = (p: P2): number => Math.round(p[0] - x0) + Math.round(p[1] - z0) * w;
  const start = idx(from);
  let goal = idx(to);
  for (const k0 of [start, goal]) for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) { const k = k0 + di + dj * w; if (k >= 0 && k < w * h && open0[k]) ok[k] = 1; }
  if (!ok[goal] && snapGoal > 0) {
    // nearest open cell to an unwalkable leg end (a waypoint in a pond, an NPC's own collider)
    const gi = goal % w;
    const gj = Math.floor(goal / w);
    let best = -1;
    let bestD = Infinity;
    const r = Math.ceil(snapGoal);
    for (let dj = -r; dj <= r; dj++)
      for (let di = -r; di <= r; di++) {
        const ii = gi + di;
        const jj = gj + dj;
        if (ii < 0 || jj < 0 || ii >= w || jj >= h) continue;
        const dd = Math.hypot(di, dj);
        if (dd <= snapGoal && dd < bestD && ok[ii + jj * w]) { bestD = dd; best = ii + jj * w; }
      }
    if (best >= 0) goal = best;
  }
  const g = new Float64Array(w * h).fill(Infinity);
  const came = new Int32Array(w * h).fill(-1);
  const open: number[] = [start];
  const f = new Float64Array(w * h).fill(Infinity);
  g[start] = 0;
  const hx = (k: number): number => Math.hypot((k % w) - (goal % w), Math.floor(k / w) - Math.floor(goal / w));
  f[start] = hx(start);
  const closed = new Uint8Array(w * h);
  while (open.length) {
    let bi = 0;
    for (let k = 1; k < open.length; k++) if (f[open[k]!]! < f[open[bi]!]!) bi = k;
    const c = open[bi]!;
    open[bi] = open[open.length - 1]!;
    open.pop();
    if (c === goal) break;
    if (closed[c]) continue;
    closed[c] = 1;
    const ci = c % w;
    const cj = (c - ci) / w;
    for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]] as const) {
      const ii = ci + di;
      const jj = cj + dj;
      if (ii < 0 || jj < 0 || ii >= w || jj >= h) continue;
      const k = ii + jj * w;
      if (!ok[k] || closed[k]) continue;
      const run = di && dj ? Math.SQRT2 : 1;
      const grade = Math.abs(H[k]! - H[c]!) / run;
      if (grade > (built[k] && built[c] ? 1.5 : CLIMB_TAN)) continue;
      const cost = g[c]! + run * (1 + 4 * grade * grade + edge[k]!);
      if (cost < g[k]!) { g[k] = cost; came[k] = c; f[k] = cost + hx(k); open.push(k); }
    }
  }
  if (came[goal] === -1 && goal !== start) return null;
  const out: P2[] = [];
  for (let k = goal; k !== -1; k = came[k]!) out.push([x0 + (k % w), z0 + Math.floor(k / w)]);
  return out.reverse();
}

/** Plan from -> to in legs; null + where it stopped when a leg cannot be planned even with a wide pad. */
export function plan(d: WalkDeps, from: P2, to: P2): { points: P2[] } | { at: P2; why: string } {
  const out: P2[] = [from];
  let here = from;
  for (let guard = 0; guard < 200; guard++) {
    const left = dist(here, to);
    const last = left <= LEG;
    const end: P2 = last ? to : [here[0] + ((to[0] - here[0]) * LEG) / left, here[1] + ((to[1] - here[1]) * LEG) / left];
    const leg = planLeg(d, here, end, 40, last ? 3 : 25) ?? planLeg(d, here, end, 110, last ? 3 : 40);
    if (!leg || leg.length < 2) {
      if (last && dist(here, to) < 3) return { points: out };
      return { at: [Math.round(here[0]), Math.round(here[1])], why: `no walkable ground found toward [${Math.round(end[0])}, ${Math.round(end[1])}]` };
    }
    out.push(...leg.slice(1));
    here = leg.at(-1)!;
    if (last) return { points: out };
  }
  return { at: here, why: "planner gave up (too many legs)" };
}

/** Walk the body along `points` with input intents. town-walk's walker, for a body that is already in the world. */
export function walkPoints(d: WalkDeps, points: P2[], to: P2, stop?: (p: P3) => string | null, watch?: (p: P3) => boolean): WalkResult {
  const { world, field, bodyId } = d;
  const p0 = world.positionOf(bodyId)!;
  const from: P3 = [+p0[0].toFixed(1), +p0[1].toFixed(1), +p0[2].toFixed(1)];
  const pts = densify(points, 1);
  const along: number[] = [0];
  for (let k = 1; k < pts.length; k++) along.push(along[k - 1]! + dist(pts[k - 1]!, pts[k]!));
  const total = along.at(-1)!;
  let best = 0;
  let bestAt = 0;
  const stuck: Stuck[] = [];
  let pendingStuck: Stuck | null = null;
  let jumps = 0;
  let jumpedHere = false;
  let side = 0;
  let sideUntil = 0;
  let sidesTried = 0;
  const dt = world.fixedDt;
  const maxSeconds = (total / d.runSpeed) * 3 + 20;
  let t = 0;
  let joined: string | undefined;
  for (; t < maxSeconds; t += dt) {
    const p = world.positionOf(bodyId);
    if (!p) break;
    if (watch && !watch(p)) break; // the watcher saw something irreversible
    const j = stop?.(p);
    if (j) { joined = j; break; }
    for (let k = best; k < Math.min(pts.length, best + 12); k++) {
      if (dist([p[0], p[2]], pts[k]!) < 1.6 && k > best) { if (k > best + 2) { sidesTried = 0; pendingStuck = null; } best = k; bestAt = t; jumps = 0; jumpedHere = false; }
    }
    if (best >= pts.length - 2) break;
    // streaming: keep the ground ahead loaded (the server's own residency pass runs every 10 ticks)
    if (Math.round(t / dt) % 30 === 0) { const a = pts[Math.min(pts.length - 1, best + 20)]!; d.terrain.ensureAround(a[0], a[1], 1); }
    const aim = pts[Math.min(pts.length - 1, best + 3)]!;
    let dx = aim[0] - p[0];
    let dz = aim[1] - p[2];
    const l = Math.hypot(dx, dz) || 1;
    dx = (dx / l) * d.runSpeed;
    dz = (dz / l) * d.runSpeed;
    let jump = false;
    if (side !== 0 && t < sideUntil) {
      const sx = -dz * side;
      const sz = dx * side;
      dx = sx * 0.9 + dx * 0.3;
      dz = sz * 0.9 + dz * 0.3;
    } else side = 0;
    if (t - bestAt > 1.5 && side === 0 && sidesTried < 2) {
      const here: P3 = [+p[0].toFixed(1), +p[1].toFixed(1), +p[2].toFixed(1)];
      if (sidesTried === 0) {
        const near = world.sim.overlapSphere([p[0], p[1], p[2]], 1.2).filter((id) => !id.startsWith(bodyId));
        const touching = near.map((id) => { const e = world.entities.get(id); return e ? `${id} (${e.name}${e.prefab ? `, ${e.prefab}` : ""})` : id; });
        pendingStuck = { at: here, along: Math.round(along[best]!), ground: +field.height(p[0], p[2]).toFixed(1), jumped: false, touching };
      }
      side = sidesTried === 0 ? 1 : -1;
      sideUntil = t + 1.2;
      sidesTried++;
      bestAt = t;
    }
    if (t - bestAt > 1.5 && side === 0 && sidesTried >= 2) {
      if (jumps === 0 && pendingStuck) { stuck.push(pendingStuck); pendingStuck = null; }
      if (jumps < 3) { jump = true; jumps++; jumpedHere = true; bestAt = t - 0.3; }
      else break;
    }
    if (jumpedHere && stuck.length && best > 0 && t - bestAt < dt * 2) stuck.at(-1)!.jumped = true;
    d.stepWith([dx, dz], jump);
  }
  for (let i = 0; i < 10; i++) d.stepWith([0, 0], false); // stop
  const finished = joined !== undefined || best >= pts.length - 2;
  for (const s of stuck) s.jumped = s.jumped || finished || along[best]! > s.along + 3;
  return { from, to, metres: Math.round(total), finished, reached: Math.round(along[best]!), stuck, seconds: +t.toFixed(1), ...(joined ? { joined } : {}) };
}

/**
 * Walk OUT from where the body stands (a quest site) toward `toward` (the giver), leg by leg, and stop the moment
 * `joined` names the known-walkable network the body is on (a road, a town) — roads and streets are the town-walk
 * gate's to prove, so reaching one proves the site connects. `reached` is the metres walked.
 */
export interface ClimbLimits {
  /** Highest ledge the body gets back up: max(jump apex, step-up). */
  reach: number;
  /** Steepest ground it walks UP (radians). */
  maxClimb: number;
}
/**
 * One-way descent detector for a walk-out: an airborne stretch (the ground ray reads more than rest + 0.4 m) or a
 * stretch on ground steeper than the climb limit, whose height lost exceeds the climb reach. Also records the trail.
 */
function dropWatch(d: WalkDeps, lim: ClimbLimits): { watch: (p: P3) => boolean; found: () => WalkResult["oneWay"]; trail: P2[] } {
  const cosClimb = Math.cos(lim.maxClimb);
  let rest: number | null = null;
  let seg: { kind: "fall" | "slope"; y0: number } | null = null;
  let found: WalkResult["oneWay"];
  const trail: P2[] = [];
  const watch = (p: P3): boolean => {
    const last = trail.at(-1);
    if (!last || Math.hypot(p[0] - last[0], p[2] - last[1]) >= 1) trail.push([p[0], p[2]]);
    const hit = d.world.sim.raycast([p[0], p[1], p[2]], [0, -1, 0], 30, { solid: true, exclude: [d.bodyId] });
    const dist = hit ? hit.distance : 30;
    if (rest === null) rest = Math.min(dist, 1.5);
    const airborne = dist > rest + 0.4;
    const steep = !airborne && !!hit && hit.normal[1] < cosClimb;
    const kind: "fall" | "slope" | null = airborne ? "fall" : steep ? "slope" : null;
    if (kind) {
      if (!seg) seg = { kind, y0: p[1] };
      else if (kind === "fall") seg.kind = "fall";
      return true;
    }
    if (seg) {
      const drop = seg.y0 - p[1];
      const k = seg.kind;
      seg = null;
      if (drop > lim.reach) { found = { at: [+p[0].toFixed(1), +p[1].toFixed(1), +p[2].toFixed(1)], drop: +drop.toFixed(1), kind: k }; return false; }
    }
    return true;
  };
  return { watch, found: () => found, trail };
}

export function walkOut(d: WalkDeps, toward: P2, joined: (p: P3) => string | null, lim?: ClimbLimits): WalkResult {
  const dw = lim ? dropWatch(d, lim) : null;
  const p0 = d.world.positionOf(d.bodyId)!;
  const from: P3 = [+p0[0].toFixed(1), +p0[1].toFixed(1), +p0[2].toFixed(1)];
  const total: WalkResult = { from, to: toward, metres: 0, finished: false, reached: 0, stuck: [], seconds: 0 };
  const at0 = joined(p0);
  if (at0) return { ...total, finished: true, joined: at0, trail: [[p0[0], p0[2]]] };
  for (let guard = 0; guard < 60; guard++) {
    const p = d.world.positionOf(d.bodyId)!;
    const here: P2 = [p[0], p[2]];
    const left = dist(here, toward);
    const last = left <= LEG;
    const end: P2 = last ? toward : [here[0] + ((toward[0] - here[0]) * LEG) / left, here[1] + ((toward[1] - here[1]) * LEG) / left];
    const leg = planLeg(d, here, end, 40, last ? 3 : 25) ?? planLeg(d, here, end, 110, last ? 3 : 40);
    if (!leg || leg.length < 2) return { ...total, unplanned: { at: [Math.round(here[0]), Math.round(here[1])], why: `no walkable ground found toward [${Math.round(end[0])}, ${Math.round(end[1])}]` } };
    const r = walkPoints(d, leg, end, joined, dw?.watch);
    if (dw?.found()) return { ...total, metres: total.metres + r.metres, reached: total.reached + r.reached, oneWay: dw.found()!, trail: dw.trail };
    total.metres += r.metres;
    total.reached += r.reached;
    total.seconds = +(total.seconds + r.seconds).toFixed(1);
    total.stuck.push(...r.stuck.map((s) => ({ ...s, along: s.along + total.reached - r.reached })));
    if (r.joined) {
      const e = d.world.positionOf(d.bodyId)!;
      return { ...total, finished: true, joined: r.joined, ...(dw ? { trail: [...dw.trail, [e[0], e[2]] as P2] } : {}) };
    }
    if (!r.finished) return total;
    if (last) return { ...total, unplanned: { at: [Math.round(end[0]), Math.round(end[1])], why: "reached the giver without crossing any road or town" } };
  }
  return { ...total, unplanned: { at: [Math.round(p0[0]), Math.round(p0[2])], why: "walk-out gave up (too many legs)" } };
}

/** Plan and walk from where the body stands to `to`. */
export function walkTo(d: WalkDeps, to: P2): WalkResult {
  const p = d.world.positionOf(d.bodyId)!;
  const from: P2 = [p[0], p[2]];
  const planned = plan(d, from, to);
  if (!("points" in planned)) {
    return { from: [+p[0].toFixed(1), +p[1].toFixed(1), +p[2].toFixed(1)], to, metres: Math.round(dist(from, to)), finished: false, reached: 0, stuck: [], seconds: 0, unplanned: planned };
  }
  return walkPoints(d, planned.points, to);
}

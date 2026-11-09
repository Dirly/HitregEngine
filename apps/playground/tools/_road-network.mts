/**
 * The road NETWORK as a graph, and the faults a map reader sees in it (Derek 2026-10-31: "a lot of criss-crossing and
 * overlapping"). Pure: takes road polylines and destinations, returns the graph and its faults. `worldgen road-net`
 * prints and draws it; the `roads` status row fails on it; `worldgen paths` / `trails` build so it stays clean.
 *
 * Faults:
 * - crossing   two roads cross with no junction (neither ends within JOIN_M of the crossing point);
 * - overlap    two different roads within PARALLEL_M of each other for more than PARALLEL_RUN_M (two tracks side by
 *              side out of one gate, a link that runs beside a road instead of joining it);
 * - redundant  a link whose ends are also joined by the rest of the network at < REDUNDANT_RATIO x its length (a loop
 *              nobody needs: two routes between the same two places);
 * - stub       a dead-end piece shorter than STUB_M that reaches no place;
 * - spur       a dead end that reaches no place (a path that stops in a field).
 *
 * Town streets (role "paving", `<town>-street-*`, ramps and stairs) are the town's own plan, not the network: left out.
 */

export type XZ = readonly [number, number];

export interface NetRoad {
  id: string;
  points: readonly (readonly number[])[];
  /** solved tread height per point (RoadDoc.surfaceY): a crossing is a crossroads only where the two treads agree. */
  surfaceY?: readonly number[];
  /** ground at the outer edge of the smooth band, left / right (RoadDoc.leftY / rightY): a fold's junction takes them. */
  leftY?: readonly number[];
  rightY?: readonly number[];
  width?: number;
  role?: string;
}

export interface NetPlace {
  id: string;
  x: number;
  z: number;
  /** how close a road end must come to count as arriving (disc radius + reach). */
  reach: number;
}

export const JOIN_M = 14;
export const PARALLEL_M = 15;
export const PARALLEL_RUN_M = 40;
export const REDUNDANT_RATIO = 1.3;
export const STUB_M = 40;
/** a crossing is a crossroads (a junction the player reads) at this angle or more, with the treads within CROSS_DY_M. */
export const CROSS_MIN_DEG = 35;
export const CROSS_DY_M = 0.5;
/** a free road end this close to another road is snapped onto it (a junction, not a near miss). */
export const SNAP_M = 25;
/** the most two pieces of one route may stand apart and still be one road (a bridge, a scrambled stretch). */
export const PIECE_GAP_M = 90;
const SAMPLE_M = 5;

/** A road piece's base id: `path-a-b.s2` -> `path-a-b` (pieces of one route are one road). */
export function baseRoadId(id: string): string {
  return id.replace(/(\.[sj]?\d+)+$/, "");
}

/** Is this a road of the network (not a town's own street plan)? */
export function isNetworkRoad(road: NetRoad, townIds: readonly string[]): boolean {
  if (road.role === "paving") return false;
  return !townIds.some((t) => road.id.startsWith(`${t}-street-`) || road.id.startsWith(`${t}-ramp-`) || road.id.startsWith(`${t}-stair-`));
}

function xz(p: readonly number[]): [number, number] {
  return [p[0]!, p[1]!];
}

export function polylineLength(pts: readonly (readonly number[])[]): number {
  let L = 0;
  for (let i = 1; i < pts.length; i++) L += Math.hypot(pts[i]![0]! - pts[i - 1]![0]!, pts[i]![1]! - pts[i - 1]![1]!);
  return L;
}

function segDist(p: XZ, a: XZ, b: XZ): { d: number; t: number } {
  const dx = b[0] - a[0], dz = b[1] - a[1];
  const l2 = dx * dx + dz * dz;
  const t = l2 > 0 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dz) / l2)) : 0;
  return { d: Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dz)), t };
}

/** Nearest point on a polyline: distance and arc length along it. */
export function nearestOn(pts: readonly (readonly number[])[], p: XZ): { d: number; s: number; at: [number, number]; seg: number; t: number } {
  if (pts.length === 1) return { d: Math.hypot(pts[0]![0]! - p[0], pts[0]![1]! - p[1]), s: 0, at: xz(pts[0]!), seg: 0, t: 0 };
  let best = { d: Infinity, s: 0, at: [0, 0] as [number, number], seg: 0, t: 0 };
  let s0 = 0;
  for (let i = 1; i < pts.length; i++) {
    const a = xz(pts[i - 1]!), b = xz(pts[i]!);
    const seg = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const { d, t } = segDist(p, a, b);
    if (d < best.d) best = { d, s: s0 + t * seg, at: [a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])], seg: i - 1, t };
    s0 += seg;
  }
  return best;
}

/** The tread height of a road where it passes nearest `p` (null without a solved profile). */
export function treadAt(road: NetRoad, p: XZ): number | null {
  if (!road.surfaceY || road.surfaceY.length !== road.points.length) return null;
  const near = nearestOn(road.points, p);
  const y0 = road.surfaceY[near.seg]!, y1 = road.surfaceY[Math.min(near.seg + 1, road.surfaceY.length - 1)]!;
  return y0 + (y1 - y0) * near.t;
}

/**
 * The banks a road leaving `host` at `at` in direction `dir` has at the junction (2026-10-31 redstrand s3: the
 * junction copied the folded piece's own banks, 4 m over the host's tread, and raised the host's shoulder 2 m).
 * Its band edges lie along the host where it leaves square (banks = the host tread) and across the host's band where
 * it leaves parallel (the host's own banks, side matched by direction); between, weighted by |cos|. Null when the
 * host carries no banks.
 */
export function junctionBanks(host: NetRoad, at: XZ, dir: XZ, y: number): { leftY: number; rightY: number } | null {
  if (!host.leftY || !host.rightY || host.leftY.length !== host.points.length || host.rightY.length !== host.points.length) return null;
  const q = nearestOn(host.points, at);
  const lerp = (a: readonly number[]) => a[q.seg]! + (a[Math.min(q.seg + 1, a.length - 1)]! - a[q.seg]!) * q.t;
  const hy = treadAt(host, at) ?? y;
  const a = host.points[q.seg]!, b = host.points[Math.min(q.seg + 1, host.points.length - 1)]!;
  const hl = Math.hypot(b[0]! - a[0]!, b[1]! - a[1]!), dl = Math.hypot(dir[0], dir[1]);
  if (!hl || !dl) return { leftY: y, rightY: y };
  const cos = ((b[0]! - a[0]!) * dir[0] + (b[1]! - a[1]!) * dir[1]) / (hl * dl);
  const L = lerp(host.leftY) - hy, R = lerp(host.rightY) - hy;
  const w = Math.abs(cos);
  const [l, r] = cos >= 0 ? [L, R] : [R, L];
  return { leftY: Math.round((y + w * l) * 100) / 100, rightY: Math.round((y + w * r) * 100) / 100 };
}

/** Points every `step` m along a polyline, with their arc length. */
export function resample(pts: readonly (readonly number[])[], step: number): { p: [number, number]; s: number }[] {
  const out: { p: [number, number]; s: number }[] = [];
  if (pts.length === 0) return out;
  out.push({ p: xz(pts[0]!), s: 0 });
  let s0 = 0, next = step;
  for (let i = 1; i < pts.length; i++) {
    const a = xz(pts[i - 1]!), b = xz(pts[i]!);
    const seg = Math.hypot(b[0] - a[0], b[1] - a[1]);
    while (next <= s0 + seg) {
      const t = seg > 0 ? (next - s0) / seg : 0;
      out.push({ p: [a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])], s: next });
      next += step;
    }
    s0 += seg;
  }
  const last = xz(pts[pts.length - 1]!);
  if (out.length === 0 || Math.hypot(out[out.length - 1]!.p[0] - last[0], out[out.length - 1]!.p[1] - last[1]) > 1e-6) out.push({ p: last, s: s0 });
  return out;
}

function segIntersect(a: XZ, b: XZ, c: XZ, d: XZ): [number, number] | null {
  const r = [b[0] - a[0], b[1] - a[1]], s = [d[0] - c[0], d[1] - c[1]];
  const den = r[0]! * s[1]! - r[1]! * s[0]!;
  if (Math.abs(den) < 1e-9) return null;
  const t = ((c[0] - a[0]) * s[1]! - (c[1] - a[1]) * s[0]!) / den;
  const u = ((c[0] - a[0]) * r[1]! - (c[1] - a[1]) * r[0]!) / den;
  if (t < 0 || t > 1 || u < 0 || u > 1) return null;
  return [a[0] + t * r[0]!, a[1] + t * r[1]!];
}

export interface Crossing { a: string; b: string; at: [number, number]; angle: number; dy: number | null }
export interface Overlap { a: string; b: string; from: [number, number]; to: [number, number]; length: number }
export interface Redundant { road: string; length: number; alternative: number; ends: [[number, number], [number, number]] }
export interface DeadEnd { road: string; at: [number, number]; length: number; kind: "stub" | "spur" }

export interface NetNode { id: number; at: [number, number]; degree: number; place?: string }
export interface NetEdge { id: number; road: string; a: number; b: number; length: number; points: [number, number][] }

export interface NetworkReport {
  roads: number;
  metres: number;
  nodes: NetNode[];
  edges: NetEdge[];
  /** crossings that fail: shallower than CROSS_MIN_DEG or with the treads more than CROSS_DY_M apart. */
  crossings: Crossing[];
  /** crossings that read as a crossroads (steep enough, treads level with each other). */
  crossroads: Crossing[];
  overlaps: Overlap[];
  redundant: Redundant[];
  deadEnds: DeadEnd[];
  /** connected pieces of the network (1 = one network). */
  components: number;
}

/**
 * Join the pieces of one route (`.s2`, `.s3`: split at a bridge or a scramble) end to end where they meet, so a
 * bridge gap is not a dead end. Returns one polyline per base id piece-chain.
 */
function chains(roads: readonly NetRoad[]): (NetRoad & { points: [number, number][] })[] {
  const byBase = new Map<string, NetRoad[]>();
  for (const r of roads) {
    const b = baseRoadId(r.id);
    const list = byBase.get(b);
    if (list) list.push(r);
    else byBase.set(b, [r]);
  }
  const out: (NetRoad & { points: [number, number][] })[] = [];
  for (const [, pieces] of byBase) {
    for (const p of pieces) if (p.points.length >= 2) out.push({ ...p, points: p.points.map(xz) });
  }
  return out;
}

/** The network graph: nodes at road ends and at T-junctions (an end within JOIN_M of another road), edges between. */
export function measureNetwork(allRoads: readonly NetRoad[], places: readonly NetPlace[], townIds: readonly string[] = []): NetworkReport {
  const roads = chains(allRoads.filter((r) => isNetworkRoad(r, townIds)));
  // ---- nodes: every road end, merged within JOIN_M
  const nodes: NetNode[] = [];
  const nodeAt = (p: [number, number]): number => {
    for (const n of nodes) if (Math.hypot(n.at[0] - p[0], n.at[1] - p[1]) <= JOIN_M) return n.id;
    nodes.push({ id: nodes.length, at: p, degree: 0 });
    return nodes.length - 1;
  };
  for (const r of roads) { nodeAt(r.points[0]!); nodeAt(r.points[r.points.length - 1]!); }
  // pieces of ONE route (`x`, `x.s2`, `x.s3`) left apart by a bridge or a scramble (tread left as natural ground) are
  // one road: their facing ends are joined by a gap edge, so the gap is neither a dead end nor a missing link
  const gapEdges: [number, number, number][] = [];
  for (let i = 0; i < roads.length; i++) {
    for (let j = 0; j < roads.length; j++) {
      if (i === j || baseRoadId(roads[i]!.id) !== baseRoadId(roads[j]!.id)) continue;
      const end = roads[i]!.points[roads[i]!.points.length - 1]!, start = roads[j]!.points[0]!;
      const d = Math.hypot(end[0] - start[0], end[1] - start[1]);
      if (d > JOIN_M && d <= PIECE_GAP_M) gapEdges.push([nodeAt(end), nodeAt(start), d]);
    }
  }
  // ---- split points: a node within JOIN_M of a road's interior splits it there (a T-junction)
  const edges: NetEdge[] = [];
  for (const r of roads) {
    const L = polylineLength(r.points);
    const cuts: { s: number; node: number }[] = [{ s: 0, node: nodeAt(r.points[0]!) }, { s: L, node: nodeAt(r.points[r.points.length - 1]!) }];
    for (const n of nodes) {
      const near = nearestOn(r.points, n.at);
      if (near.d <= JOIN_M && near.s > JOIN_M && near.s < L - JOIN_M) cuts.push({ s: near.s, node: n.id });
    }
    cuts.sort((p, q) => p.s - q.s);
    const samples = resample(r.points, SAMPLE_M);
    for (let i = 1; i < cuts.length; i++) {
      const c0 = cuts[i - 1]!, c1 = cuts[i]!;
      if (c0.node === c1.node && c1.s - c0.s < JOIN_M * 2) continue;
      const pts = samples.filter((q) => q.s >= c0.s && q.s <= c1.s).map((q) => q.p);
      edges.push({ id: edges.length, road: r.id, a: c0.node, b: c1.node, length: c1.s - c0.s, points: pts });
    }
  }
  for (const [a, b, d] of gapEdges) {
    if (a === b) continue;
    edges.push({ id: edges.length, road: `(gap) ${roads.find((r) => nearestOn(r.points, nodes[a]!.at).d < 1)?.id ?? "piece"}`, a, b, length: d, points: [nodes[a]!.at, nodes[b]!.at] });
  }
  for (const e of edges) { nodes[e.a]!.degree++; nodes[e.b]!.degree++; }
  for (const n of nodes) {
    const p = places.find((pl) => Math.hypot(pl.x - n.at[0], pl.z - n.at[1]) <= pl.reach);
    if (p) n.place = p.id;
  }

  // ---- crossings: proper intersections of two roads away from every node
  const crossings: Crossing[] = [];
  const crossroads: Crossing[] = [];
  for (let i = 0; i < roads.length; i++) {
    for (let j = i + 1; j < roads.length; j++) {
      const A = roads[i]!, B = roads[j]!;
      if (baseRoadId(A.id) === baseRoadId(B.id)) continue;
      for (let a = 1; a < A.points.length; a++) {
        for (let b = 1; b < B.points.length; b++) {
          const hit = segIntersect(A.points[a - 1]!, A.points[a]!, B.points[b - 1]!, B.points[b]!);
          if (!hit) continue;
          if (nodes.some((n) => Math.hypot(n.at[0] - hit[0], n.at[1] - hit[1]) <= JOIN_M)) continue;
          if ([...crossings, ...crossroads].some((c) => Math.hypot(c.at[0] - hit[0], c.at[1] - hit[1]) <= JOIN_M)) continue;
          const ua = [A.points[a]![0] - A.points[a - 1]![0], A.points[a]![1] - A.points[a - 1]![1]] as const;
          const ub = [B.points[b]![0] - B.points[b - 1]![0], B.points[b]![1] - B.points[b - 1]![1]] as const;
          const cos = Math.abs(ua[0] * ub[0] + ua[1] * ub[1]) / (Math.hypot(ua[0], ua[1]) * Math.hypot(ub[0], ub[1]) || 1);
          const angle = Math.round((Math.acos(Math.min(1, cos)) * 180) / Math.PI);
          const ya = treadAt(A, hit), yb = treadAt(B, hit);
          const dy = ya !== null && yb !== null ? Math.round(Math.abs(ya - yb) * 100) / 100 : null;
          const c: Crossing = { a: A.id, b: B.id, at: [Math.round(hit[0]), Math.round(hit[1])], angle, dy };
          if (angle >= CROSS_MIN_DEG && (dy === null || dy <= CROSS_DY_M)) crossroads.push(c);
          else crossings.push(c);
        }
      }
    }
  }

  // two roads that cross each other more than once are a braid, not crossroads: every one of those crossings fails
  for (let k = crossroads.length - 1; k >= 0; k--) {
    const c = crossroads[k]!;
    const again = [...crossroads, ...crossings].filter((o) => (o.a === c.a && o.b === c.b) || (o.a === c.b && o.b === c.a)).length;
    if (again > 1) { crossings.push(c); crossroads.splice(k, 1); }
  }

  // ---- overlaps: runs of A within PARALLEL_M of B (different routes) longer than PARALLEL_RUN_M
  const overlaps: Overlap[] = [];
  for (let i = 0; i < roads.length; i++) {
    for (let j = 0; j < roads.length; j++) {
      if (i === j) continue;
      const A = roads[i]!, B = roads[j]!;
      if (baseRoadId(A.id) === baseRoadId(B.id)) continue;
      // report each pair once, measured along the longer one
      const LA = polylineLength(A.points), LB = polylineLength(B.points);
      if (LA < LB || (LA === LB && i > j)) continue;
      let run: { from: [number, number]; s0: number; to: [number, number]; s1: number } | null = null;
      const flush = (): void => {
        if (run && run.s1 - run.s0 > PARALLEL_RUN_M) overlaps.push({ a: A.id, b: B.id, from: [Math.round(run.from[0]), Math.round(run.from[1])], to: [Math.round(run.to[0]), Math.round(run.to[1])], length: Math.round(run.s1 - run.s0) });
        run = null;
      };
      for (const q of resample(A.points, SAMPLE_M)) {
        const near = nearestOn(B.points, q.p).d <= PARALLEL_M;
        if (near) {
          if (!run) run = { from: q.p, s0: q.s, to: q.p, s1: q.s };
          else { run.to = q.p; run.s1 = q.s; }
        } else flush();
      }
      flush();
    }
  }

  // ---- redundant loops: an edge whose ends the rest of the network joins at < REDUNDANT_RATIO x its length
  const redundant: Redundant[] = [];
  const shortest = (from: number, to: number, skip: number): number => {
    const dist = new Map<number, number>([[from, 0]]);
    const done = new Set<number>();
    for (;;) {
      let u = -1, du = Infinity;
      for (const [k, v] of dist) if (!done.has(k) && v < du) { u = k; du = v; }
      if (u < 0) return Infinity;
      if (u === to) return du;
      done.add(u);
      for (const e of edges) {
        if (e.id === skip) continue;
        const v = e.a === u ? e.b : e.b === u ? e.a : -1;
        if (v < 0 || done.has(v)) continue;
        const nd = du + e.length;
        if (nd < (dist.get(v) ?? Infinity)) dist.set(v, nd);
      }
    }
  };
  for (const e of edges) {
    // a link shorter than a stub is a junction's own knot (two ends merged a few metres apart), not a second route
    if (e.a === e.b || e.length < STUB_M) continue;
    const alt = shortest(e.a, e.b, e.id);
    if (alt < e.length * REDUNDANT_RATIO) {
      redundant.push({ road: e.road, length: Math.round(e.length), alternative: Math.round(alt), ends: [nodes[e.a]!.at.map(Math.round) as [number, number], nodes[e.b]!.at.map(Math.round) as [number, number]] });
    }
  }

  // ---- dead ends
  const deadEnds: DeadEnd[] = [];
  for (const e of edges) {
    for (const end of [e.a, e.b]) {
      const n = nodes[end]!;
      if (n.degree !== 1 || n.place) continue;
      const other = nodes[end === e.a ? e.b : e.a]!;
      const kind = e.length < STUB_M && other.degree > 1 ? "stub" : "spur";
      deadEnds.push({ road: e.road, at: [Math.round(n.at[0]), Math.round(n.at[1])], length: Math.round(e.length), kind });
    }
  }

  // ---- components
  const parent = nodes.map((n) => n.id);
  const find = (k: number): number => (parent[k] === k ? k : (parent[k] = find(parent[k]!)));
  for (const e of edges) parent[find(e.a)] = find(e.b);
  const components = new Set(nodes.filter((n) => n.degree > 0).map((n) => find(n.id))).size;

  return {
    roads: roads.length,
    metres: Math.round(roads.reduce((m, r) => m + polylineLength(r.points), 0)),
    nodes,
    edges,
    crossings,
    crossroads,
    overlaps,
    redundant,
    deadEnds,
    components,
  };
}

/**
 * A documented network exception (authoring/terrain/<world>.road-net-exceptions.json): a crossing or side-by-side run
 * between two routes (base ids, either order) that a dated ruling keeps, with the owner and step that removes it
 * (2026-10-31 redstrand: road-moon leaves the Sun door beside road-weeping-sun, a stacked descent until the Moon is
 * installed and road-moon re-routes).
 */
export interface NetException { kind: "crossing" | "overlap"; roads: [string, string]; ruling: string; owner?: string; until?: string }
/** The report without the excepted faults, and one line per excepted fault. Pure. */
export function exceptNetwork(rep: NetworkReport, ex: readonly NetException[]): { rep: NetworkReport; excepted: string[] } {
  const hit = (kind: NetException["kind"], a: string, b: string) => ex.find((e) => e.kind === kind && ((baseRoadId(e.roads[0]) === baseRoadId(a) && baseRoadId(e.roads[1]) === baseRoadId(b)) || (baseRoadId(e.roads[0]) === baseRoadId(b) && baseRoadId(e.roads[1]) === baseRoadId(a))));
  const excepted: string[] = [];
  const crossings = rep.crossings.filter((c) => { const e = hit("crossing", c.a, c.b); if (e) excepted.push(`crossing ${c.a} x ${c.b} (${e.ruling})`); return !e; });
  const overlaps = rep.overlaps.filter((v) => { const e = hit("overlap", v.a, v.b); if (e) excepted.push(`side by side ${v.a} | ${v.b} (${e.ruling})`); return !e; });
  return { rep: { ...rep, crossings, overlaps }, excepted };
}

/** One line per fault class for a status row; null when clean. Stubs/spurs are reported, not failed (see `roadsRow`). */
export function networkFaults(rep: NetworkReport): string | null {
  const parts: string[] = [];
  if (rep.crossings.length) parts.push(`${rep.crossings.length} crossing(s) that are no crossroads (< ${CROSS_MIN_DEG} deg or treads > ${CROSS_DY_M} m apart: ${rep.crossings.slice(0, 3).map((c) => `${c.a} x ${c.b} at [${c.at.join(",")}] ${c.angle} deg${c.dy !== null ? ` dy ${c.dy}` : ""}`).join("; ")})`);
  if (rep.overlaps.length) parts.push(`${rep.overlaps.length} side-by-side run(s) > ${PARALLEL_RUN_M} m within ${PARALLEL_M} m (${rep.overlaps.slice(0, 3).map((o) => `${o.a} | ${o.b} ${o.length} m from [${o.from.join(",")}]`).join("; ")})`);
  if (rep.redundant.length) parts.push(`${rep.redundant.length} redundant link(s) (another route < ${REDUNDANT_RATIO}x: ${rep.redundant.slice(0, 3).map((r) => `${r.road} ${r.length} m vs ${r.alternative} m`).join("; ")})`);
  const stubs = rep.deadEnds.filter((d) => d.kind === "stub");
  if (stubs.length) parts.push(`${stubs.length} stub(s) < ${STUB_M} m reaching no place (${stubs.slice(0, 3).map((d) => `${d.road} at [${d.at.join(",")}]`).join("; ")})`);
  return parts.length ? parts.join("; ") : null;
}

// ---------------------------------------------------------------- building a network that stays clean

/** Where a merged piece meets the network: the road it joins, the point on it, and that road's tread height there. */
export interface MergeJoin { road: string; at: [number, number]; y: number | null; d: number }
/** A stretch of a new line that the network does not already carry: indices into the line (inclusive) and its joins. */
export interface MergedPiece { from: number; to: number; start?: MergeJoin; end?: MergeJoin; length: number }

/**
 * Fold a NEW line into an existing network (Derek 2026-10-31, "a lot of criss-crossing and overlapping"): every stretch
 * that runs within `parallel` m of an existing road for more than `run` m is the network's already and is dropped; the
 * line is cut there into the pieces the network lacks, each ending ON the road it meets (a junction: `start`/`end`
 * carry the point and the tread height there, for the grader to splice and pin). A free end of the line within `snap`
 * m of a road is snapped onto it too. A piece shorter than `minPiece` m between two joins is dropped (the network
 * already joins its ends). Used by `worldgen paths`, `worldgen trails`, `worldgen road` (and so place-build tracks).
 */
export function mergeIntoNetwork(
  line: readonly XZ[],
  network: readonly NetRoad[],
  o: { parallel?: number; run?: number; snap?: number; minPiece?: number; keep?: (p: XZ) => boolean; meet?: number } = {},
): { pieces: MergedPiece[]; absorbed: number } {
  const parallel = o.parallel ?? PARALLEL_M, run = o.run ?? PARALLEL_RUN_M, snap = o.snap ?? SNAP_M, minPiece = o.minPiece ?? STUB_M;
  const n = line.length;
  if (n < 2) return { pieces: [], absorbed: 0 };
  const near = line.map((p) => {
    let best: { road: NetRoad; d: number; at: [number, number] } | null = null;
    for (const r of network) {
      if (r.points.length < 1) continue;
      const q = nearestOn(r.points, p);
      if (!best || q.d < best.d) best = { road: r, d: q.d, at: q.at };
    }
    return best;
  });
  const arc: number[] = [0];
  for (let i = 1; i < n; i++) arc.push(arc[i - 1]! + Math.hypot(line[i]![0] - line[i - 1]![0], line[i]![1] - line[i - 1]![1]));
  // `keep`: a sample the caller pins (a fold that would uncover a lip there) is never the network's
  const kept = line.map((p) => !!o.keep?.(p));
  const close = near.map((q, i) => q !== null && q.d <= parallel && !kept[i]);
  // runs of `close` longer than `run` m are the network's
  const owned = new Array<boolean>(n).fill(false);
  let absorbed = 0;
  for (let i = 0; i < n; ) {
    if (!close[i]) { i++; continue; }
    let j = i;
    while (j + 1 < n && close[j + 1]) j++;
    if (arc[j]! - arc[i]! > run) { for (let k = i; k <= j; k++) owned[k] = true; absorbed += arc[j]! - arc[i]!; }
    i = j + 1;
  }
  const join = (k: number): MergeJoin => {
    const q = near[k]!;
    return { road: q.road.id, at: [q.at[0], q.at[1]], y: treadAt(q.road, q.at), d: q.d };
  };
  const pieces: MergedPiece[] = [];
  for (let i = 0; i < n; ) {
    if (owned[i]) { i++; continue; }
    let j = i;
    while (j + 1 < n && !owned[j + 1]) j++;
    // the piece runs from the last owned point before it (inside the band) to the first owned after: it touches the road
    let from = i > 0 ? i - 1 : 0, to = j < n - 1 ? j + 1 : n - 1;
    // `meet` (a fold): the cut walks on into the doubled run until the line is within `meet` m of the road it doubles,
    // so the piece meets it along its own line, never by a short leg across the other road's shoulder (2026-10-31 s3 /
    // road-weeping-sun: a cut 10 m off the host left a lip and sawtooth where the leg crossed the host's bank). Only when
    // the line does come that close before the middle of the run; a line that stays apart keeps the plain cut.
    if (o.meet !== undefined) {
      if (i > 0) { let s0 = i - 1; while (s0 > 0 && owned[s0 - 1]) s0--; const mid = Math.ceil((s0 + i - 1) / 2); for (let k = i - 1; k >= mid; k--) if (near[k]!.d <= o.meet) { from = k; break; } }
      if (j < n - 1) { let e0 = j + 1; while (e0 < n - 1 && owned[e0 + 1]) e0++; const mid = Math.floor((e0 + j + 1) / 2); for (let k = j + 1; k <= mid; k++) if (near[k]!.d <= o.meet) { to = k; break; } }
    }
    const piece: MergedPiece = { from, to, length: arc[to]! - arc[from]! };
    if (i > 0) piece.start = join(from);
    else if (near[0] && near[0].d > 1 && near[0].d <= snap) piece.start = join(0);
    if (j < n - 1) piece.end = join(to);
    else if (near[n - 1] && near[n - 1]!.d > 1 && near[n - 1]!.d <= snap) piece.end = join(n - 1);
    // L (i-moon 2026-11-02, the Moon's lookout footpath): BOTH free ends snapped onto the same spot of one road closed the
    // line into a loop back to its start (a 26 m painted diagonal across the plaza); only the nearer end joins
    if (i === 0 && j === n - 1 && piece.start && piece.end && piece.start.road === piece.end.road && Math.hypot(piece.start.at[0] - piece.end.at[0], piece.start.at[1] - piece.end.at[1]) < snap) {
      if (piece.start.d <= piece.end.d) delete piece.end; else delete piece.start;
    }
    let pinned = false;
    for (let k = i; k <= j && !pinned; k++) pinned = kept[k]!;
    if (pinned || !(piece.start && piece.end && i > 0 && j < n - 1 && piece.length < minPiece)) pieces.push(piece);
    i = j + 1;
  }
  return { pieces, absorbed: Math.round(absorbed) };
}

/** Grid cells (index = ix + iz * n) a polyline passes over, sampled every half cell. */
export function cellsAlong(points: readonly (readonly number[])[], nearest: (x: number, z: number) => number, step: number): Set<number> {
  const out = new Set<number>();
  for (const q of resample(points, Math.max(1, step / 2))) out.add(nearest(q.p[0], q.p[1]));
  return out;
}

/**
 * The route grid priced for a network (`worldgen paths` / `trails`): a cell an existing road already runs over costs
 * REUSE_COST x its ground (follow the road you have), and a cell beside one — within one cell, not on it — costs
 * BESIDE_COST x (never a second track alongside the first; a crossing pays it for one step). Returns a new cost array.
 */
export const REUSE_COST = 0.35, BESIDE_COST = 2.2;
export function networkCost(cost: Float32Array, n: number, onRoad: ReadonlySet<number>): Float32Array {
  const out = Float32Array.from(cost);
  const beside = new Set<number>();
  for (const c of onRoad) {
    const cx = c % n, cz = (c / n) | 0;
    for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) {
      const x = cx + dx, z = cz + dz;
      if (x < 0 || z < 0 || x >= n || z >= n) continue;
      const k = x + z * n;
      if (!onRoad.has(k)) beside.add(k);
    }
  }
  for (const c of onRoad) if (Number.isFinite(out[c]!)) out[c] = out[c]! * REUSE_COST;
  for (const c of beside) if (Number.isFinite(out[c]!)) out[c] = out[c]! * BESIDE_COST;
  return out;
}

/** A loop link is worth cutting only where the network's way round is LOOP_DETOUR x the straight line or more,
 *  and the new link (its routed length) saves at least REDUNDANT_RATIO x on the network's way. */
export const LOOP_DETOUR = 2.5;
export function loopWanted(networkDistance: number, straight: number, routed?: number): boolean {
  if (!(networkDistance >= straight * LOOP_DETOUR)) return false;
  return routed === undefined || networkDistance >= routed * REDUNDANT_RATIO;
}

/** Shortest distance between two nodes of a weighted undirected graph (links: [a, b, length]). */
export function graphDistance(links: readonly (readonly [number, number, number])[], from: number, to: number): number {
  const dist = new Map<number, number>([[from, 0]]);
  const done = new Set<number>();
  for (;;) {
    let u = -1, du = Infinity;
    for (const [k, v] of dist) if (!done.has(k) && v < du) { u = k; du = v; }
    if (u < 0) return Infinity;
    if (u === to) return du;
    done.add(u);
    for (const [a, b, l] of links) {
      const v = a === u ? b : b === u ? a : -1;
      if (v < 0 || done.has(v)) continue;
      if (du + l < (dist.get(v) ?? Infinity)) dist.set(v, du + l);
    }
  }
}

/**
 * Metres between two grid cells walking ONLY over road cells (8-neighbour, cells of `step` m): how far the network
 * already makes a traveller go. Each end is first taken to its nearest road cell (that distance is added). Infinity when
 * the network does not join them.
 */
export function cellNetworkDistance(onRoad: ReadonlySet<number>, n: number, step: number, from: number, to: number): number {
  if (onRoad.size === 0) return Infinity;
  const snap = (c: number): [number, number] => {
    let best = -1, bd = Infinity;
    const cx = c % n, cz = (c / n) | 0;
    for (const k of onRoad) { const d = Math.hypot((k % n) - cx, ((k / n) | 0) - cz); if (d < bd) { bd = d; best = k; } }
    return [best, bd * step];
  };
  const [s, ds] = snap(from), [g, dg] = snap(to);
  const dist = new Map<number, number>([[s, 0]]);
  const done = new Set<number>();
  const heap: [number, number][] = [[0, s]];
  while (heap.length) {
    let bi = 0;
    for (let i = 1; i < heap.length; i++) if (heap[i]![0] < heap[bi]![0]) bi = i;
    const [d, u] = heap[bi]!;
    heap[bi] = heap[heap.length - 1]!;
    heap.pop();
    if (done.has(u)) continue;
    if (u === g) return d + ds + dg;
    done.add(u);
    const ux = u % n, uz = (u / n) | 0;
    for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) {
      if (!dx && !dz) continue;
      const x = ux + dx, z = uz + dz;
      if (x < 0 || z < 0 || x >= n || z >= n) continue;
      const v = x + z * n;
      if (!onRoad.has(v) || done.has(v)) continue;
      const nd = d + step * (dx && dz ? Math.SQRT2 : 1);
      if (nd < (dist.get(v) ?? Infinity)) { dist.set(v, nd); heap.push([nd, v]); }
    }
  }
  return Infinity;
}

/**
 * Prim order for a network grown from a hub: of the destinations not yet joined, the one nearest the network (its
 * roads, or the joined destinations when no road exists yet) goes next. WHERE it joins trades the new path's length
 * against the trip back to the hub (a Prim-Dijkstra blend): the join point minimises
 * `distance + HUB_WEIGHT x hubDistance(point)`, so a place joins the trunk toward the town rather than the far end of a
 * side branch it happens to be nearest (redstrand: the Red Dial hung off the north site's spur, 1.7x the way to town).
 * Without `hubDistance` it is plain Prim. Pure.
 */
export const HUB_WEIGHT = 0.4;
export function nextToJoin(
  pending: readonly { id: string; x: number; z: number }[],
  joined: readonly { id: string; x: number; z: number }[],
  roads: readonly NetRoad[],
  hubDistance?: (p: XZ) => number,
): { index: number; at: [number, number]; road: NetRoad | null; town: string | null; d: number } | null {
  type Pick = { index: number; at: [number, number]; road: NetRoad | null; town: string | null; d: number; score: number };
  const hub = (p: XZ): number => (hubDistance ? HUB_WEIGHT * hubDistance(p) : 0);
  // which goes next: plain nearest (a joined destination counts at 1/0.8 of its distance: roads are where paths join)
  let next = -1, nd = Infinity;
  pending.forEach((p, index) => {
    for (const r of roads) if (r.points.length >= 2) { const d = nearestOn(r.points, [p.x, p.z]).d; if (d < nd) { nd = d; next = index; } }
    for (const j of joined) { const d = Math.hypot(j.x - p.x, j.z - p.z) / 0.8; if (d < nd) { nd = d; next = index; } }
  });
  if (next < 0) return null;
  const p = pending[next]!;
  let mine: Pick | null = null;
  for (const r of roads) {
    if (r.points.length < 2) continue;
    for (const q of resample(r.points, 8)) {
      const d = Math.hypot(q.p[0] - p.x, q.p[1] - p.z), score = d + hub(q.p);
      if (!mine || score < mine.score) mine = { index: next, at: q.p, road: r, town: null, d, score };
    }
  }
  for (const j of joined) {
    const d = Math.hypot(j.x - p.x, j.z - p.z), score = d / 0.8 + hub([j.x, j.z]);
    if (!mine || score < mine.score) mine = { index: next, at: [j.x, j.z], road: null, town: j.id, d, score };
  }
  if (!mine) return null;
  return { index: mine.index, at: mine.at, road: mine.road, town: mine.town, d: mine.d };
}

/**
 * The roads joined to a seed set: every road with a point within `reach` of a seed disc, then (repeatedly) every road
 * one of whose ends lies within JOIN_M of a road already in (or whose line passes within JOIN_M of its end). A
 * destination joins the network where it is CONNECTED to the hub, never a stray fragment (a place's own track out in
 * the field). Pure.
 */
export function connectedRoads(roads: readonly NetRoad[], seeds: readonly { x: number; z: number; reach: number }[]): NetRoad[] {
  const inSet = new Set<number>();
  roads.forEach((r, i) => {
    if (r.points.some((p) => seeds.some((s) => Math.hypot(p[0]! - s.x, p[1]! - s.z) <= s.reach))) inSet.add(i);
  });
  const ends = (r: NetRoad): XZ[] => (r.points.length ? [xz(r.points[0]!), xz(r.points[r.points.length - 1]!)] : []);
  for (let grew = true; grew; ) {
    grew = false;
    roads.forEach((r, i) => {
      if (inSet.has(i) || r.points.length < 2) return;
      for (const j of inSet) {
        const o = roads[j]!;
        if (ends(r).some((e) => nearestOn(o.points, e).d <= JOIN_M) || ends(o).some((e) => nearestOn(r.points, e).d <= JOIN_M)) {
          inSet.add(i);
          grew = true;
          return;
        }
      }
    });
  }
  return roads.filter((_, i) => inSet.has(i));
}

/** Metres from `source` to every road cell walking only over road cells (8-neighbour; Dijkstra). */
export function networkDistancesFrom(onRoad: ReadonlySet<number>, n: number, step: number, source: number): Map<number, number> {
  const dist = new Map<number, number>([[source, 0]]);
  const done = new Set<number>();
  const heap: [number, number][] = [[0, source]];
  const push = (e: [number, number]) => { heap.push(e); let i = heap.length - 1; while (i > 0) { const p = (i - 1) >> 1; if (heap[p]![0] <= heap[i]![0]) break; [heap[p], heap[i]] = [heap[i]!, heap[p]!]; i = p; } };
  const pop = (): [number, number] => { const top = heap[0]!, end = heap.pop()!; if (heap.length) { heap[0] = end; let i = 0; for (;;) { const l = 2 * i + 1, r = l + 1; let m = i; if (l < heap.length && heap[l]![0] < heap[m]![0]) m = l; if (r < heap.length && heap[r]![0] < heap[m]![0]) m = r; if (m === i) break; [heap[m], heap[i]] = [heap[i]!, heap[m]!]; i = m; } } return top; };
  while (heap.length) {
    const [d, u] = pop();
    if (done.has(u)) continue;
    done.add(u);
    const ux = u % n, uz = (u / n) | 0;
    for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) {
      if (!dx && !dz) continue;
      const x = ux + dx, z = uz + dz;
      if (x < 0 || z < 0 || x >= n || z >= n) continue;
      const v = x + z * n;
      if (!onRoad.has(v) || done.has(v)) continue;
      const nd = d + step * (dx && dz ? Math.SQRT2 : 1);
      if (nd < (dist.get(v) ?? Infinity)) { dist.set(v, nd); push([nd, v]); }
    }
  }
  return dist;
}

/** The per-point arrays a road doc carries alongside `points` (RoadDoc). */
const PER_POINT = ["surfaceY", "leftY", "rightY"] as const;
type FoldableRoad = NetRoad & { surfaceY?: number[]; leftY?: number[]; rightY?: number[] };

/**
 * FOLD an existing road into the rest of the network without re-grading it: mergeIntoNetwork on its own points, then
 * each kept stretch is the doc SLICED (points, surfaceY, leftY, rightY exactly as solved, so the ground under the kept
 * part does not move), with the junction point spliced on where it meets another road (its tread there, the banks
 * of the neighbouring point). Pieces: the first keeps the id, the rest `<id>.j2`, ... Empty when the network already
 * carries all of it. `worldgen road-net --fold`. Pure.
 */
export function foldRoadDoc<T extends FoldableRoad>(doc: T, others: readonly NetRoad[], o: { parallel?: number; run?: number; snap?: number; minPiece?: number; keep?: (p: XZ) => boolean; meet?: number } = {}): { pieces: T[]; absorbed: number; changed: boolean } {
  // decided on the line every FOLD_STEP m (a graded doc keeps a vertex only where it bends or its profile moves: 40 m
  // apart on a straight), cut where the decision falls; only the two cut points are new, interpolated on their segment
  type Dense = { p: [number, number]; seg: number; t: number };
  const dense: Dense[] = [];
  for (let i = 0; i + 1 < doc.points.length; i++) {
    const a = doc.points[i]!, b = doc.points[i + 1]!;
    const k = Math.max(1, Math.ceil(Math.hypot(b[0]! - a[0]!, b[1]! - a[1]!) / FOLD_STEP));
    for (let j = 0; j < k; j++) dense.push({ p: [a[0]! + ((b[0]! - a[0]!) * j) / k, a[1]! + ((b[1]! - a[1]!) * j) / k], seg: i, t: j / k });
  }
  const last = doc.points[doc.points.length - 1]!;
  dense.push({ p: [last[0]!, last[1]!], seg: Math.max(0, doc.points.length - 2), t: doc.points.length > 1 ? 1 : 0 });
  const merged = mergeIntoNetwork(dense.map((d) => d.p), others, { meet: FOLD_MEET_M, ...o });
  const whole = merged.pieces.length === 1 && merged.pieces[0]!.from === 0 && merged.pieces[0]!.to === dense.length - 1 && !merged.pieces[0]!.start && !merged.pieces[0]!.end;
  if (whole) return { pieces: [doc], absorbed: 0, changed: false };
  const r2 = (v: number) => Math.round(v * 100) / 100;
  const lerpAt = (key: (typeof PER_POINT)[number], d: Dense): number | undefined => {
    const a = doc[key];
    if (!a || a.length !== doc.points.length) return undefined;
    const y0 = a[d.seg]!, y1 = a[Math.min(d.seg + 1, a.length - 1)]!;
    return r2(y0 + (y1 - y0) * d.t);
  };
  const pieces = merged.pieces.map((p, k) => {
    const piece = { ...doc, id: k === 0 ? doc.id : `${doc.id}.j${k + 1}` } as T;
    const a = dense[p.from]!, b = dense[p.to]!;
    // the original vertices strictly between the two cut points, plus the cut points themselves
    const first = a.t === 0 ? a.seg : a.seg + 1;
    const lastV = b.t === 1 ? b.seg + 1 : b.seg;
    const pts: number[][] = [];
    const arrays: Partial<Record<(typeof PER_POINT)[number], number[]>> = {};
    for (const key of PER_POINT) if (doc[key] && doc[key]!.length === doc.points.length) arrays[key] = [];
    const add = (pt: readonly number[], vals: Partial<Record<(typeof PER_POINT)[number], number | undefined>>, front = false): void => {
      if (front) pts.unshift([...pt]); else pts.push([...pt]);
      for (const key of PER_POINT) { const arr = arrays[key]; if (!arr) continue; const v = vals[key]!; if (front) arr.unshift(v); else arr.push(v); }
    };
    if (!(a.t === 0)) add([r2(a.p[0]), r2(a.p[1])], { surfaceY: lerpAt("surfaceY", a), leftY: lerpAt("leftY", a), rightY: lerpAt("rightY", a) });
    for (let i = first; i <= lastV; i++) add(doc.points[i]!, { surfaceY: doc.surfaceY?.[i], leftY: doc.leftY?.[i], rightY: doc.rightY?.[i] });
    if (!(b.t === 1) && !(b.t === 0 && b.seg === lastV)) add([r2(b.p[0]), r2(b.p[1])], { surfaceY: lerpAt("surfaceY", b), leftY: lerpAt("leftY", b), rightY: lerpAt("rightY", b) });
    const splice = (j: MergeJoin, atStart: boolean): void => {
      const near = (key: (typeof PER_POINT)[number]) => { const arr = arrays[key]; return arr ? (atStart ? arr[0] : arr[arr.length - 1]) : undefined; };
      const ys = arrays.surfaceY;
      // two roads that ran side by side were often at different heights: the kept tread is eased onto the junction's over
      // FOLD_RAMP_M (a straight blend by distance from the junction), never a step at the splice (redstrand s3 / road-
      // weeping-sun: a 1 m lip where the folded end met the other tread)
      // The banks (leftY / rightY) move WITH the tread: a tread eased onto the junction under banks left where they were
      // stands proud of them or sinks in a slot (the splice step, 2026-10-31).
      let dyJ = 0;
      if (ys && ys.length && j.y !== null) {
        const dy = j.y - (atStart ? ys[0]! : ys[ys.length - 1]!);
        dyJ = dy;
        let run = Math.hypot(pts[atStart ? 0 : pts.length - 1]![0]! - j.at[0], pts[atStart ? 0 : pts.length - 1]![1]! - j.at[1]);
        for (let k = 0; k < ys.length; k++) {
          const i = atStart ? k : ys.length - 1 - k;
          if (k > 0) { const a = pts[atStart ? i - 1 : i + 1]!, b = pts[i]!; run += Math.hypot(b[0]! - a[0]!, b[1]! - a[1]!); }
          if (run >= FOLD_RAMP_M) break;
          const w = dy * (1 - run / FOLD_RAMP_M);
          ys[i] = r2(ys[i]! + w);
          for (const bank of ["leftY", "rightY"] as const) { const arr = arrays[bank]; if (arr) arr[i] = r2(arr[i]! + w); }
        }
        dyJ = j.y - (atStart ? ys[0]! : ys[ys.length - 1]!);
      }
      // the junction's banks are the HOST's (junctionBanks); a host without banks: the neighbour's, moved with the tread
      const end = pts[atStart ? 0 : pts.length - 1]!;
      const dir: XZ = atStart ? [end[0]! - j.at[0], end[1]! - j.at[1]] : [j.at[0] - end[0]!, j.at[1] - end[1]!];
      const host = others.find((r) => r.id === j.road);
      const hb = host && j.y !== null ? junctionBanks(host, j.at, dir, j.y) : null;
      const bankAt = (key: "leftY" | "rightY") => { if (hb) return hb[key]; const v = near(key); return v === undefined ? undefined : r2(v + dyJ); };
      add([r2(j.at[0]), r2(j.at[1])], { surfaceY: j.y !== null ? r2(j.y) : near("surfaceY"), leftY: bankAt("leftY"), rightY: bankAt("rightY") }, atStart);
    };
    if (p.start) splice(p.start, true);
    if (p.end) splice(p.end, false);
    (piece as { points: unknown }).points = pts;
    for (const key of PER_POINT) if (arrays[key]) (piece as Record<string, unknown>)[key] = arrays[key];
    return piece;
  }).filter((piece) => piece.points.length >= 2);
  return { pieces, absorbed: merged.absorbed, changed: true };
}
/** metres between the samples foldRoadDoc decides on; metres over which a folded end is eased onto the junction tread. */
export const FOLD_STEP = 4, FOLD_RAMP_M = 30;
/** metres from the road it doubles at which a folded piece's cut is made (it meets that road along its own line). */
export const FOLD_MEET_M = 3;

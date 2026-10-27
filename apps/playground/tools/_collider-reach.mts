/**
 * Reach over a landmark's COLLIDER (the baked trimesh) plus the terrain where the rock does not cover it — the truth a
 * body walks on, not the solve's estimate. Shared by tools/ledge-landmark.mts (`--fix-reach`) and the reach scripts.
 *
 * Multi-level flood on a 0.5 m grid with the REAL body's limits (DEFAULT_CHARACTER): a node is a walkable surface (a
 * rock face under the body's climb angle, never one buried under the terrain, or the terrain outside the rock) with
 * >= 1.8 m clear above it; a neighbour is reached by a step <= the body's autostep (0.4 m), or up a continuous slope
 * under the climb angle (a half-way probe must split the rise into two such steps). A target counts within 0.5 m. The flood starts on
 * the hillside (every node on the grid's border) and walks through the caves as the real geometry they are. "Without
 * caves" drops every node roofed within 6 m that lies inside a cave bore's corridor.
 *
 * `closeReach` is the loop: bake, walk, add a repair ramp for each unreached core shelf (<= 0.5 grade, from the nearest
 * reached ground), re-bake — at most `maxRounds` times; whatever is still unreached comes back as `faults`.
 */

import { DEFAULT_CHARACTER } from "@hitreg/physics";

export type Vec3 = [number, number, number];
export interface ColliderMesh {
  positions: ArrayLike<number>;
  indices: ArrayLike<number>;
  /** Added to every position (a landmark GLB is local to its origin). */
  offset?: Vec3;
}
export interface ReachSite {
  center: [number, number];
  /** The operator's radius: the walk covers radius + 26 m (out onto the plain hillside). */
  radius: number;
  /** Installed terrain height. */
  ground: (x: number, z: number) => number;
  /** Core shelf anchors [x, z, y] (the solve's `shelfAnchors`). */
  anchors: Vec3[];
  /** Cave floor polylines [x, y, z]. */
  caves: Vec3[][];
  /** Per anchor: EXACT (an opening): reached only on its own cell, at its own height, with clear headroom there. */
  exact?: boolean[];
}
export interface ReachRepair { from: Vec3; to: Vec3 }
export interface ColliderReach {
  withCaves: boolean[];
  withoutCaves: boolean[];
  /** Anchors reached only through a cave. */
  caveOnly: number[];
  /** A repair ramp for anchor k: head on a flat spot of its cut-off shelf, foot on reached ground, grade <= `grade`. */
  repairFor(k: number, band: number, grade?: number): ReachRepair | null;
  /** Level map of a box (1 m step): letter = level (a = 40 m, +5 m each), UPPER = reached, * = anchor. */
  map(xa: number, xb: number, za: number, zb: number): string[];
  stats: { triangles: number; grid: number; cells: number };
}

/** The REAL body (packages/physics DEFAULT_CHARACTER, what PlayerDriver walks with): its climb limit and autostep. A walk
 *  that allows more (it once took 0.75 m per 0.5 m node, twice the body's step) passes risers the body is stopped by. */
const WALK_RAD = DEFAULT_CHARACTER.maxSlopeClimbAngle, STEP = DEFAULT_CHARACTER.autostep.maxHeight, CLEAR = 1.8, G = 0.5;
/** A rock floor this far under the installed terrain is buried (the terrain fills it). */
const BURIED = 0.1;
/** A target counts when a reached node within REACH_R m (XZ) stands within REACH_DY m of the surface there. */
const REACH_R = Number(process.env.REACH_R ?? 0.5), REACH_DY = Number(process.env.REACH_DY ?? 0.5);
const r2 = (v: number) => Math.round(v * 100) / 100;

export function colliderReach(mesh: ColliderMesh, site: ReachSite): ColliderReach {
  const [ox, oy, oz] = mesh.offset ?? [0, 0, 0];
  const P = mesh.positions, I = mesh.indices;
  const px = (v: number) => P[v * 3]! + ox, py = (v: number) => P[v * 3 + 1]! + oy, pz = (v: number) => P[v * 3 + 2]! + oz;
  const R = site.radius + 26, [cx, cz] = site.center, n = Math.ceil((2 * R) / G) + 1, x0 = cx - R, z0 = cz - R;
  // bin triangles on the grid (each into every cell whose G square its bounds overlap, so a ray anywhere in the
  // square, the half-step probe included, finds it), then cast a vertical ray: every crossing (y, up-facing, walkable)
  const bins: number[][] = Array.from({ length: n * n }, () => []);
  for (let t = 0; t < I.length; t += 3) {
    const a = I[t]!, b = I[t + 1]!, c = I[t + 2]!;
    const c0 = Math.max(0, Math.ceil((Math.min(px(a), px(b), px(c)) - x0) / G - 0.5)), c1 = Math.min(n - 1, Math.floor((Math.max(px(a), px(b), px(c)) - x0) / G + 0.5));
    const r0 = Math.max(0, Math.ceil((Math.min(pz(a), pz(b), pz(c)) - z0) / G - 0.5)), r1 = Math.min(n - 1, Math.floor((Math.max(pz(a), pz(b), pz(c)) - z0) / G + 0.5));
    for (let r = r0; r <= r1; r++) for (let q = c0; q <= c1; q++) bins[r * n + q]!.push(t);
  }
  const cosWalk = Math.cos(WALK_RAD);
  type Node = { y: number; roof: number };
  /** The surfaces a body could stand on at (x, z) through the triangles of bin `bin`, with >= CLEAR headroom. */
  const surfacesAt = (x: number, z: number, bin: number): Node[] => {
    const hits: { y: number; up: boolean; walk: boolean }[] = [];
    for (const t of bins[bin] ?? []) {
      const a = I[t]!, b = I[t + 1]!, c = I[t + 2]!;
      const ax = px(a), az = pz(a), bx = px(b), bz = pz(b), qx = px(c), qz = pz(c);
      const d = (bz - qz) * (ax - qx) + (qx - bx) * (az - qz);
      if (Math.abs(d) < 1e-12) continue;
      const l1 = ((bz - qz) * (x - qx) + (qx - bx) * (z - qz)) / d, l2 = ((qz - az) * (x - qx) + (ax - qx) * (z - qz)) / d, l3 = 1 - l1 - l2;
      if (l1 < 0 || l2 < 0 || l3 < 0) continue;
      const y = l1 * py(a) + l2 * py(b) + l3 * py(c);
      const ux = bx - ax, uy = py(b) - py(a), uz = bz - az, vx = qx - ax, vy = py(c) - py(a), vz = qz - az;
      const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx, nl = Math.hypot(nx, ny, nz) || 1;
      hits.push({ y, up: ny > 0, walk: ny / nl > cosWalk });
    }
    hits.sort((p, s) => p.y - s.y);
    const out: Node[] = [];
    const th = site.ground(x, z);
    const above = hits.filter((h) => h.y > th + 0.05);
    // the terrain counts where it is not inside the rock (an even number of crossings above it)
    if (above.length % 2 === 0) out.push({ y: th, roof: above.length ? above[0]!.y - th : Infinity });
    // a rock floor BURIED under the terrain is not a floor (the terrain fills it: a recess the ground blend filled)
    hits.forEach((h, k) => { if (h.up && h.walk && h.y >= th - BURIED) { const nx = hits[k + 1]; out.push({ y: h.y, roof: nx ? nx.y - h.y : Infinity }); } });
    return out.filter((o) => o.roof >= CLEAR);
  };
  const nodes: Node[][] = new Array(n * n);
  for (let r = 0; r < n; r++) for (let q = 0; q < n; q++) nodes[r * n + q] = surfacesAt(x0 + q * G, z0 + r * G, r * n + q);
  // a neighbour is reached by a STEP the real body climbs (autostep) or, for more, up a continuous SLOPE under its climb
  // limit: then the half-way probe must find a walkable surface splitting the rise into two steps of <= STEP each
  // (a 1.6 m riser has no surface half way up it; a 45 deg ramp does)
  const SLOPE_RISE = G * Math.tan(WALK_RAD);
  const linked = (i: number, y: number, j: number, yj: number): boolean => {
    const dy = Math.abs(yj - y);
    if (dy <= STEP) return true;
    if (dy > SLOPE_RISE + 0.02) return false;
    const mx = x0 + ((i % n) + (j % n)) * G / 2, mz = z0 + (Math.floor(i / n) + Math.floor(j / n)) * G / 2;
    return surfacesAt(mx, mz, i).some((m) => Math.abs(m.y - y) <= STEP && Math.abs(yj - m.y) <= STEP && Math.min(y, yj) - 0.02 <= m.y && m.y <= Math.max(y, yj) + 0.02);
  };
  const cellOf = (x: number, z: number) => { const q = Math.round((x - x0) / G), r = Math.round((z - z0) / G); return q < 0 || r < 0 || q >= n || r >= n ? -1 : r * n + q; };
  const segD = (x: number, z: number, p: Vec3, s: Vec3) => { const dx = s[0] - p[0], dz = s[2] - p[2], ll = dx * dx + dz * dz || 1, t = Math.max(0, Math.min(1, ((x - p[0]) * dx + (z - p[2]) * dz) / ll)); return Math.hypot(x - p[0] - dx * t, z - p[2] - dz * t); };
  const inCave = (x: number, z: number) => site.caves.some((fl) => fl.some((p, k) => k < fl.length - 1 && segD(x, z, p, fl[k + 1]!) < 4));
  type Seen = Map<number, Set<number>>;
  const flood = (seeds: [number, number][], ok: (i: number, k: number) => boolean): Seen => {
    const seen: Seen = new Map();
    const mark = (i: number, k: number) => { let s = seen.get(i); if (!s) seen.set(i, (s = new Set())); if (s.has(k)) return false; s.add(k); return true; };
    const st: [number, number][] = [];
    for (const [i, k] of seeds) if (ok(i, k) && mark(i, k)) st.push([i, k]);
    while (st.length) {
      const [i, k] = st.pop()!, y = nodes[i]![k]!.y, q = i % n, r = Math.floor(i / n);
      for (const j of [q > 0 ? i - 1 : -1, q < n - 1 ? i + 1 : -1, r > 0 ? i - n : -1, r < n - 1 ? i + n : -1]) {
        if (j < 0) continue;
        nodes[j]!.forEach((nd, m) => { if (ok(j, m) && linked(i, y, j, nd.y) && mark(j, m)) st.push([j, m]); });
      }
    }
    return seen;
  };
  // the hillside: every open-sky node on the grid's border
  const hill: [number, number][] = [];
  for (let e = 0; e < n; e++) for (const i of [e, (n - 1) * n + e, e * n, e * n + n - 1]) nodes[i]!.forEach((nd, k) => { if (nd.roof === Infinity) hill.push([i, k]); });
  const all = () => true;
  const caveless = (i: number, k: number) => !(nodes[i]![k]!.roof < 6 && inCave(x0 + (i % n) * G, z0 + Math.floor(i / n) * G));
  if (process.env.REACH_FROM) { const a = site.anchors[Number(process.env.REACH_FROM)]!, i = cellOf(a[0], a[1]); hill.length = 0; nodes[i]!.forEach((nd, k) => { if (Math.abs(nd.y - a[2]) < 2) hill.push([i, k]); }); }
  const seenC = flood(hill, all), seenN = flood(hill, caveless);
  // the shelf top under a ROOFED anchor (a gate's terrace under a rock lintel, a portal in a hall) is the highest walkable
  // surface a body standing there could be on: at most CLEAR over the anchor, never the roof's own top far above it
  const topAt = (i: number, ay: number) => { const ys = (nodes[i] ?? []).map((o) => o.y).filter((y) => y <= ay + CLEAR); return ys.length ? Math.max(...ys) : ay; };
  // an anchor counts when a reached node within REACH_R m of it stands within REACH_DY m of the shelf TOP there (its own
  // cell's highest walkable surface: a lower ledge beside a raised block does not count as standing on it)
  // the anchor's cell: its own, or the nearest within 0.5 m that has a walkable surface (a steep facet can sit on the
  // exact spot); an EXACT anchor (an opening: it must be cut) only its own cell
  const anchorCell = (a: Vec3, exact = false) => {
    const i0 = cellOf(a[0], a[1]);
    if (i0 < 0) return -1;
    if (exact) return nodes[i0]!.length ? i0 : -1;
    let best = -1, bd = Infinity;
    for (let dr = -1; dr <= 1; dr++) for (let dq = -1; dq <= 1; dq++) { const j = i0 + dr * n + dq, d = dr * dr + dq * dq; if (j >= 0 && j < n * n && d < bd && nodes[j]!.length) { bd = d; best = j; } }
    return best;
  };
  const reached = (seen: Seen) => site.anchors.map((a, k) => {
    const exact = !!site.exact?.[k];
    const i = anchorCell(a, exact);
    if (i < 0) return false;
    const yA = topAt(i, a[2]);
    if (exact && Math.abs(yA - a[2]) > REACH_DY) return false; // no floor with headroom AT the opening: it is not cut
    const rr = exact ? 0 : Math.round(REACH_R / G);
    for (let dr = -rr; dr <= rr; dr++) for (let dq = -rr; dq <= rr; dq++) { const s = seen.get(i + dr * n + dq); if (!s) continue; for (const m of s) if (Math.abs(nodes[i + dr * n + dq]!.at(m)!.y - yA) < REACH_DY) return true; }
    return false;
  });
  const withCaves = reached(seenC), withoutCaves = reached(seenN);
  const flatAt = (i: number, y: number) => {
    const q = i % n, r = Math.floor(i / n);
    for (let dr = -2; dr <= 2; dr++) for (let dq = -2; dq <= 2; dq++) {
      if (dr * dr + dq * dq > 4) continue;
      const qq = q + dq, rr = r + dr;
      if (qq < 0 || rr < 0 || qq >= n || rr >= n || !nodes[rr * n + qq]!.some((o) => Math.abs(o.y - y) < 0.4 && o.roof >= 6)) return false;
    }
    return true;
  };
  const repairFor = (k: number, band: number, grade = 0.5): ReachRepair | null => {
    const a = site.anchors[k]!, i = anchorCell(a);
    if (i < 0) return null;
    const yA = topAt(i, a[2]), kA = nodes[i]!.findIndex((o) => o.y === yA);
    const mine = flood([[i, kA]], all);
    const ai = i % n, aj = Math.floor(i / n), S: [number, number][] = [], T: [number, number][] = [];
    const RS = Math.round(10 / G), RT = Math.round(30 / G);
    for (let dr = -RT; dr <= RT; dr += 2) for (let dq = -RT; dq <= RT; dq += 2) {
      const q = ai + dq, r = aj + dr;
      if (q < 3 || r < 3 || q >= n - 3 || r >= n - 3 || dq * dq + dr * dr > RT * RT) continue;
      const c = r * n + q;
      if (Math.abs(dq) <= RS && Math.abs(dr) <= RS) for (const m of mine.get(c) ?? []) { const nd = nodes[c]![m]!; if (nd.roof >= 6 && Math.abs(nd.y - yA) < 1) S.push([c, nd.y]); }
      for (const m of seenC.get(c) ?? []) { const nd = nodes[c]![m]!; if (nd.roof >= 6 && nd.y <= yA + 0.3 && nd.y >= yA - 2 * band && flatAt(c, nd.y)) T.push([c, nd.y]); }
    }
    if (process.env.REACH_DEBUG) console.log(`repairFor ${k}: top ${yA.toFixed(1)} nodes ${JSON.stringify(nodes[i]!.map((o) => [+o.y.toFixed(1), +Math.min(99, o.roof).toFixed(1)]))} piece ${[...mine.values()].reduce((a, v) => a + v.size, 0)} S ${S.length} T ${T.length}`);
    let best: ReachRepair | null = null, bd = Infinity;
    for (const [sc, sy] of S) for (const [tc, ty] of T) {
      const d = Math.hypot(((sc % n) - (tc % n)) * G, (Math.floor(sc / n) - Math.floor(tc / n)) * G);
      if (d >= bd || d < Math.max(4, (sy - ty) / grade + 2)) continue;
      bd = d;
      best = { from: [r2(x0 + (sc % n) * G), r2(sy), r2(z0 + Math.floor(sc / n) * G)], to: [r2(x0 + (tc % n) * G), r2(ty), r2(z0 + Math.floor(tc / n) * G)] };
    }
    return best;
  };
  const map = (xa: number, xb: number, za: number, zb: number) => {
    const lines: string[] = [];
    for (let z = za; z <= zb; z += 1) {
      let l = "";
      for (let x = xa; x <= xb; x += 1) {
        if (site.anchors.some((a) => Math.abs(a[0] - x) < 0.5 && Math.abs(a[1] - z) < 0.5)) { l += "*"; continue; }
        const i = cellOf(x, z), nd = i < 0 ? [] : nodes[i]!;
        if (!nd.length) { l += " "; continue; }
        const sn = seenC.get(i), k = sn && sn.size ? Math.max(...sn) : nd.length - 1, v = Math.max(0, Math.min(25, Math.round((nd[k]!.y - 40) / 5)));
        l += String.fromCharCode((sn && sn.size ? 65 : 97) + v);
      }
      lines.push(String(z).padStart(6) + " " + l);
    }
    return lines;
  };
  return {
    withCaves, withoutCaves,
    caveOnly: withCaves.map((v, k) => (v && !withoutCaves[k] ? k : -1)).filter((k) => k >= 0),
    repairFor, map,
    stats: { triangles: I.length / 3, grid: G, cells: n * n },
  };
}

/** Bake, walk the collider, repair what it cannot reach, re-bake; at most `maxRounds` repair rounds. */
export function closeReach<B extends { mesh: ColliderMesh; site: ReachSite }>(o: {
  initial: ReachRepair[];
  bake: (repairs: ReachRepair[]) => B;
  band: number;
  maxRounds?: number;
  log?: (line: string) => void;
}): { last: B; reach: ColliderReach; repairs: ReachRepair[]; added: ReachRepair[]; rounds: number; faults: number[] } {
  const maxRounds = o.maxRounds ?? 3, log = o.log ?? (() => {});
  let repairs = [...o.initial], last = o.bake(repairs), reach = colliderReach(last.mesh, last.site), rounds = 0;
  const added: ReachRepair[] = [];
  const say = () => {
    log(`reach (collider): ${reach.withCaves.filter(Boolean).length}/${reach.withCaves.length} with caves, ${reach.withoutCaves.filter(Boolean).length}/${reach.withoutCaves.length} without`);
    if (process.env.REACH_MAP) { const [xa, xb, za, zb] = process.env.REACH_MAP.split(',').map(Number); for (const l of reach.map(xa!, xb!, za!, zb!)) log(l); }
  };
  say();
  while (rounds < maxRounds) {
    const cut = reach.withCaves.map((v, k) => (v ? -1 : k)).filter((k) => k >= 0);
    if (!cut.length) break;
    const fresh = cut.map((k) => reach.repairFor(k, o.band)).filter((r): r is ReachRepair => !!r);
    if (!fresh.length) { log(`round ${rounds + 1}: no walkable repair found for ${cut.length} shelf/shelves`); break; }
    rounds++;
    for (const r of fresh) log(`round ${rounds}: repair ramp ${JSON.stringify(r.to)} -> ${JSON.stringify(r.from)} (grade ${((r.from[1] - r.to[1]) / Math.hypot(r.from[0] - r.to[0], r.from[2] - r.to[2])).toFixed(2)})`);
    repairs = [...repairs, ...fresh];
    added.push(...fresh);
    last = o.bake(repairs);
    reach = colliderReach(last.mesh, last.site);
    say();
  }
  const faults = reach.withCaves.map((v, k) => (v ? -1 : k)).filter((k) => k >= 0);
  return { last, reach, repairs, added, rounds, faults };
}

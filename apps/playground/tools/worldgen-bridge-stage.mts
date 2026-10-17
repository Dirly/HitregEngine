/**
 * The landing-stage half of `worldgen bridge-place` (`--seat-a|b stage`): where a rope bridge lands on a steep lip
 * or a cliff face that nothing can level (a sea-cliff stretch takes no height patch), solve a timber landing stage
 * for the world-kit bridge kit (authoring/bridges/stage.mts) and the walkway / switchback stair to walkable ground.
 *
 *   1. the platform: slid out over the face from the given end until its whole footprint is clear of the rock under
 *      its deck (it is cantilevered: the rope's own landing, posts and deadman sit on / under it);
 *   2. the walkable ground: the nearest patch whose relief over 2.5 m is under 0.7 m, scored by distance and climb;
 *   3. the walkway: from the platform's back edge to that ground, station by station (1 m), each station slid sideways
 *      (perpendicular to its heading) to the nearest spot where the rock stays under the deck across its width: on a
 *      steep slope it hugs the face like a cliff walk. A climb steeper than 1 in 2.2 becomes switchback legs along
 *      the face (8 m each, 4 m apart in height, stacked);
 *   4. the timbers: a post to the ground under each walkway edge every other station and under the platform's edges
 *      where the ground is within 7 m, otherwise a strut raked at 45 deg toward the face until it bites the rock.
 * Everything is returned in the stage frame (origin = the rope deck end on the platform, +X out over the gap).
 */
import type { WorldField } from "@hitreg/core";

type V2 = [number, number];
type V3 = [number, number, number];
const r3 = (v: number) => Math.round(v * 1000) / 1000;
const smooth = (e0: number, e1: number, x: number) => { const t = Math.max(0, Math.min(1, (x - e0) / (e1 - e0))); return t * t * (3 - 2 * t); };

export interface StagePlan {
  /** The rope's deck end, slid onto the platform's front edge (world xz). */
  endAt: V2;
  deckY: number;
  /** Stage frame: yaw (deg) of +X (out over the gap), origin = [endAt, deckY]. */
  yaw: number;
  spec: { width: number; platform: { x0: number; x1: number; halfW: number; y: number }; path: V3[]; supports: { at: V3; foot: V3 }[]; openSides: number[]; railSides: [boolean, boolean][] };
  /** World copies for the solved doc and the gates. */
  pathWorld: V3[];
  feet: V3[];
  ground: V3;
  notes: string[];
}

export const STAGE = { x0: -5.8, x1: 0.3, width: 1.4, maxPostDepth: 7, legLength: 8, legGrade: 0.5, maxGrade: 0.45 };

export function planStage(
  field: WorldField,
  opts: { end: V2; inward: V2; deckY: number; ropeWidth: number; search?: number },
  ground: (x: number, z: number, from: number) => number,
): StagePlan {
  const notes: string[] = [];
  const out: V2 = [-opts.inward[0], -opts.inward[1]]; // +X of the stage frame, over the gap
  const side: V2 = [-out[1], out[0]];
  const halfW = Math.max(1.9, opts.ropeWidth / 2 + 0.9);
  const yDeck = opts.deckY - 0.1; // platform top: the rope's landing planks lie on it
  const high = opts.deckY + 60;
  const g = (x: number, z: number) => ground(x, z, high);
  const P2 = (o: V2, a: number, b: number): V2 => [o[0] + out[0] * a + side[0] * b, o[1] + out[1] * a + side[1] * b];

  // 1. the platform: slide out over the face until nothing stands within 0.35 m under its deck
  let end: V2 | null = null;
  for (let t = 0; t <= 16; t += 0.25) {
    const e: V2 = [opts.end[0] + out[0] * t, opts.end[1] + out[1] * t];
    let clear = true;
    for (let a = STAGE.x0; a <= STAGE.x1 + 1e-6 && clear; a += 0.5) for (let b = -halfW; b <= halfW + 1e-6; b += 0.5) {
      const p = P2(e, a, b);
      if (g(p[0], p[1]) > yDeck - 0.45) { clear = false; break; }
    }
    if (clear) { end = e; if (t > 0) notes.push(`platform slid ${t} m out over the face to clear the rock`); break; }
  }
  if (!end) throw new Error("stage: no spot within 16 m of the end where a platform clears the rock (the lip is not steep enough for a stage: seat a pad or rock)");
  const back = P2(end, STAGE.x0, 0);

  // 2. the walkway, in two phases. First, when the platform is set down the face (the rock just landward of its back
  // edge stands over its deck), switchback legs along the face climb to the lip; then a walkway hugging the slope
  // runs from there to the walkable ground (chosen as the nearest one the walkway can reach without crossing rock).
  const W = STAGE.width;
  const clearAt = (p: V2, y: number, dir: V2, need: number) => {
    const n: V2 = [-dir[1], dir[0]];
    for (const q of [-W / 2 - 0.1, -W / 4, 0, W / 4, W / 2 + 0.1]) for (const s of [-0.4, 0, 0.4]) {
      if (g(p[0] + n[0] * q + dir[0] * s, p[1] + n[1] * q + dir[1] * s) > y - need) return false;
    }
    // and headroom: no rock at the body (centre +-0.35 m, 0.6 .. 1.9 m over the deck)
    for (const q of [-0.35, 0, 0.35]) for (const h of [0.6, 1.2, 1.9]) if (field.density(p[0] + n[0] * q, y + h, p[1] + n[1] * q) < 0) return false;
    return true;
  };
  const path: V3[] = [[back[0], yDeck, back[1]]];
  let qPrev = 0;
  const march = (from: V3, to: V3, endsOnGround: boolean) => {
    const dist = Math.hypot(to[0] - from[0], to[2] - from[2]);
    const n = Math.max(1, Math.ceil(dist / 1));
    const dir: V2 = [(to[0] - from[0]) / dist, (to[2] - from[2]) / dist];
    const perp: V2 = [-dir[1], dir[0]];
    for (let k = 1; k <= n; k++) {
      const u = k / n;
      const base: V2 = [from[0] + (to[0] - from[0]) * u, from[2] + (to[2] - from[2]) * u];
      const y = from[1] + (to[1] - from[1]) * u;
      // the last metres meet the ground: the clearance under the deck fades out
      const need = endsOnGround ? 0.3 * (1 - smooth(Math.max(0, 1 - 3 / dist), 1, u)) + 0.02 : 0.3;
      let found: number | null = null;
      for (let dq = 0; dq <= 8 && found === null; dq += 0.25) for (const sg of dq === 0 ? [1] : [1, -1]) {
        const q = qPrev + sg * dq;
        if (Math.abs(q) > 9) continue;
        if (clearAt([base[0] + perp[0] * q, base[1] + perp[1] * q], y, dir, need)) { found = q; break; }
      }
      if (found === null) throw new Error(`stage: the walkway finds no clear line ${k} m out from (${r3(from[0])}, ${r3(from[2])}) (rock above the deck on both sides)`);
      // never let a station jump sideways faster than 0.8 m per metre (a walkway, not a zig-zag)
      const q = Math.max(qPrev - 0.8, Math.min(qPrev + 0.8, found));
      qPrev = endsOnGround && k === n ? 0 : q;
      path.push([r3(base[0] + perp[0] * qPrev), r3(y), r3(base[1] + perp[1] * qPrev)]);
    }
    qPrev = 0;
  };
  // phase 1: up (or down) the face to the lip
  let lipTop = -Infinity;
  for (let a = 0.5; a <= 2.5; a += 0.5) for (const b of [-0.6, 0, 0.6]) { const q = P2(back, -a, b); lipTop = Math.max(lipTop, g(q[0], q[1])); }
  const climbToLip = lipTop + 0.3 - yDeck;
  if (climbToLip > 0.5) {
    const perLeg = STAGE.legLength * STAGE.legGrade;
    const legs = Math.max(1, Math.ceil(climbToLip / perLeg));
    let lastErr: Error | null = null, done = false;
    for (const first of [1, -1]) {
      try {
        path.length = 1;
        let cur = path[0]!;
        for (let k = 0; k < legs; k++) {
          const sg = (k % 2 === 0 ? 1 : -1) * first;
          if (k > 0) {
            // the turn: a level stub on past the leg's end (the landing's width must not overhang a leg still
            // climbing to it: that would be a step), then a landing across to the other lane (legs side by side)
            const prev = -sg;
            const stub: V3 = [cur[0] + side[0] * prev * (W / 2 + 0.25), cur[1], cur[2] + side[1] * prev * (W / 2 + 0.25)];
            march(cur, stub, false);
            cur = path[path.length - 1]!;
            const lane = k % 2 === 1 ? 1 : -1;
            const across: V3 = [cur[0] + out[0] * lane * (W + 0.5), cur[1], cur[2] + out[1] * lane * (W + 0.5)];
            march(cur, across, false);
            cur = path[path.length - 1]!;
          }
          const next: V3 = [cur[0] + side[0] * sg * STAGE.legLength, Math.min(lipTop + 0.3, cur[1] + perLeg), cur[2] + side[1] * sg * STAGE.legLength];
          march(cur, next, false);
          cur = path[path.length - 1]!;
        }
        done = true; break;
      } catch (e) { lastErr = e as Error; }
    }
    if (!done) throw lastErr!;
    notes.push(`${legs} switchback leg(s) of ${STAGE.legLength} m up the face to the lip (${r3(climbToLip)} m)`);
  }
  const top = path[path.length - 1]!;
  // phase 2: the walkable ground the walkway reaches from the top of the stair
  const R = opts.search ?? 70;
  const reachable = (c: V3) => {
    const d = Math.hypot(c[0] - top[0], c[2] - top[2]);
    if (d < 1) return 0;
    const dir: V2 = [(c[0] - top[0]) / d, (c[2] - top[2]) / d], n: V2 = [-dir[1], dir[0]];
    let worst = 0;
    for (let s = 1; s < d - 2; s += 1) {
      const y = top[1] + ((c[1] + 0.12) - top[1]) * (s / d);
      let bestQ = Infinity;
      for (let q = -4; q <= 4; q += 1) {
        let m = -Infinity;
        for (const w of [-W / 2, 0, W / 2]) m = Math.max(m, g(top[0] + dir[0] * s + n[0] * (q + w), top[2] + dir[1] * s + n[1] * (q + w)));
        bestQ = Math.min(bestQ, m - (y - 0.3));
      }
      worst = Math.max(worst, bestQ);
    }
    return worst;
  };
  let best: { p: V3; score: number } | null = null;
  for (let a = -R; a <= R; a += 1) for (let b = -R; b <= R; b += 1) {
    const x = top[0] + a, z = top[2] + b;
    const d = Math.hypot(a, b);
    if (d > R || d < 2) continue;
    if ((x - back[0]) * opts.inward[0] + (z - back[1]) * opts.inward[1] < 0.5) continue; // the land side only
    const y = g(x, z);
    if (Math.abs(y - top[1]) > STAGE.maxGrade * d + 1) continue;
    let lo = Infinity, hi = -Infinity;
    for (const [u, v] of [[-1.25, -1.25], [1.25, -1.25], [1.25, 1.25], [-1.25, 1.25], [0, 0]]) { const h = g(x + u!, z + v!); lo = Math.min(lo, h); hi = Math.max(hi, h); }
    if (hi - lo > 1.25) continue; // ~27 deg: walkable ground
    const score = d + 2.2 * Math.abs(y - top[1]);
    if (best && score >= best.score) continue;
    if (reachable([x, y, z]) > 0) continue;
    best = { p: [x, y, z], score };
  }
  if (!best) throw new Error(`stage: no walkable ground (relief < 1.25 m over 2.5 m) the walkway can reach within ${R} m of the top of the stair`);
  const T = best.p;
  march(top, [T[0], T[1] + 0.12, T[2]], true);

  // 3. smooth the walkway: drop a station when the straight line past it stays clear (no wiggles for rails to pinch)
  for (let i = 1; i < path.length - 1; ) {
    const a = path[i - 1]!, c = path[i + 1]!;
    const d = Math.hypot(c[0] - a[0], c[2] - a[2]);
    const turn = (() => { const u = [path[i]![0] - a[0], path[i]![2] - a[2]], v = [c[0] - path[i]![0], c[2] - path[i]![2]]; const lu = Math.hypot(u[0]!, u[1]!) || 1, lv = Math.hypot(v[0]!, v[1]!) || 1; return (u[0]! * v[0]! + u[1]! * v[1]!) / (lu * lv); })();
    let ok = d < 2.6 && turn > 0.3; // never smooth a switchback turn away
    if (ok) {
      const dir: V2 = [(c[0] - a[0]) / d, (c[2] - a[2]) / d];
      for (let s = 0.5; s < d && ok; s += 0.5) { const u = s / d; if (!clearAt([a[0] + (c[0] - a[0]) * u, a[2] + (c[2] - a[2]) * u], a[1] + (c[1] - a[1]) * u, dir, i >= path.length - 3 ? 0.02 : 0.25)) ok = false; }
    }
    if (ok) path.splice(i, 1); else i++;
  }

  // 4. the timbers
  const feet: V3[] = [];
  const supports: { at: V3; foot: V3 }[] = [];
  const support = (at: V3, toward: V2) => {
    const gy = g(at[0], at[2]);
    if (at[1] - gy <= STAGE.maxPostDepth) {
      // a post: bury its foot 0.6 m; at a crumbling edge (no rock just under the surface) step it toward the face
      let foot: V3 = [at[0], gy - 0.6, at[2]];
      for (let s = 0; s <= 1.5 && field.density(foot[0], foot[1], foot[2]) >= 0; s += 0.25) {
        const x = at[0] + toward[0] * s, z = at[2] + toward[1] * s;
        foot = [x, g(x, z) - 0.6, z];
      }
      supports.push({ at, foot }); feet.push(foot);
      return;
    }
    for (let t = 0.5; t <= 12; t += 0.25) {
      const p: V3 = [at[0] + toward[0] * t, at[1] - t, at[2] + toward[1] * t];
      if (field.density(p[0], p[1], p[2]) < 0) {
        // bite 0.3 m on into the rock (whichever of these stays in it)
        const foot = ([[p[0] + toward[0] * 0.3, p[1] - 0.3, p[2] + toward[1] * 0.3], [p[0], p[1] - 0.4, p[2]], [p[0] + toward[0] * 0.4, p[1], p[2] + toward[1] * 0.4], p] as V3[]).find((q) => field.density(q[0], q[1], q[2]) < 0) ?? p;
        supports.push({ at, foot }); feet.push(foot);
        return;
      }
    }
    // nothing within reach: a long post to whatever is below (the footing gate reports it)
    const foot: V3 = [at[0], gy - 0.5, at[2]];
    supports.push({ at, foot }); feet.push(foot);
  };
  const intoFace = (p: V2): V2 => {
    // the way the rock rises: probe the ground 2 m around and lean toward the highest
    let bx = opts.inward[0], bz = opts.inward[1], bh = -Infinity;
    for (let k = 0; k < 8; k++) { const a = (k * Math.PI) / 4, d: V2 = [Math.cos(a), Math.sin(a)]; const h = g(p[0] + d[0] * 2, p[1] + d[1] * 2); if (h > bh) { bh = h; bx = d[0]; bz = d[1]; } }
    return [bx, bz];
  };
  for (const a of [STAGE.x0 + 0.2, (STAGE.x0 + STAGE.x1) / 2, STAGE.x1 - 0.1]) for (const b of [-halfW + 0.15, halfW - 0.15]) {
    const p = P2(end, a, b);
    support([p[0], yDeck - 0.35, p[1]], intoFace(p));
  }
  for (let i = 2; i < path.length - 1; i += 2) {
    const p = path[i]!, q = path[Math.min(path.length - 1, i + 1)]!, o = path[i - 1]!;
    const d = [q[0] - o[0], q[2] - o[2]], L = Math.hypot(d[0]!, d[1]!) || 1;
    const n: V2 = [-d[1]! / L, d[0]! / L];
    for (const sg of [-1, 1]) {
      const e: V2 = [p[0] + n[0] * sg * (W / 2 - 0.08), p[2] + n[1] * sg * (W / 2 - 0.08)];
      if (p[1] - g(e[0], e[1]) < 0.5) continue; // the deck is on the ground here
      support([e[0], p[1] - 0.3, e[1]], intoFace(e));
    }
  }

  // to the stage frame
  const O: V3 = [end[0], opts.deckY, end[1]];
  const ex = out, ez: V2 = [-out[1], out[0]];
  // three's yaw about +Y maps local +X to (cos, -sin) and local +Z to (sin, cos)
  const yaw = (Math.atan2(-out[1], out[0]) * 180) / Math.PI;
  const zAxis: V2 = [Math.sin((yaw * Math.PI) / 180), Math.cos((yaw * Math.PI) / 180)];
  void ez;
  const local = (p: V3): V3 => [r3((p[0] - O[0]) * ex[0] + (p[2] - O[2]) * ex[1]), r3(p[1] - O[1]), r3((p[0] - O[0]) * zAxis[0] + (p[2] - O[2]) * zAxis[1])];
  // rail colliders: where a side drops away, but never within a turn (a switchback landing, a bend) or at either end
  const railSides: [boolean, boolean][] = path.slice(0, -1).map((a, i) => {
    const b = path[i + 1]!, d = Math.hypot(b[0] - a[0], b[2] - a[2]) || 1, n: V2 = [-(b[2] - a[2]) / d, (b[0] - a[0]) / d];
    const m: V3 = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2];
    const onPlatform = (x: number, z: number) => { const rx = x - end[0], rz = z - end[1]; const lx = rx * out[0] + rz * out[1], lz = rx * side[0] + rz * side[1]; return lx > STAGE.x0 - 0.6 && lx < STAGE.x1 + 0.3 && Math.abs(lz) < halfW + 0.6 && Math.abs(m[1] - yDeck) < 1.5; };
    return [-1, 1].map((sg) => { const x = m[0] + n[0] * sg * (W / 2 + 1), z = m[2] + n[1] * sg * (W / 2 + 1); return !onPlatform(x, z) && m[1] - g(x, z) > 1; }) as [boolean, boolean];
  });
  const headingAt = (i: number): V2 => { const a = path[i]!, b = path[i + 1]!; const d = Math.hypot(b[0] - a[0], b[2] - a[2]) || 1; return [(b[0] - a[0]) / d, (b[2] - a[2]) / d]; };
  for (let i = 1; i < path.length - 1; i++) {
    const u = headingAt(i - 1), v = headingAt(i);
    if (u[0] * v[0] + u[1] * v[1] < Math.cos(Math.PI / 6)) { railSides[i - 1] = [false, false]; railSides[i] = [false, false]; }
  }
  for (const i of [0, 1, railSides.length - 2, railSides.length - 1]) if (railSides[i]) railSides[i] = [false, false];
  const spec = {
    width: W,
    platform: { x0: STAGE.x0, x1: STAGE.x1, halfW: r3(halfW), y: -0.1 },
    path: path.map(local),
    supports: supports.map((s) => ({ at: local(s.at), foot: local(s.foot) })),
    railSides,
    // segments that stand on the ground (the deck within 0.7 m of it at both ends) and the last two: no rail colliders
    openSides: path.slice(0, -1).map((p, i) => i).filter((i) => i >= path.length - 3 || (path[i]![1] - g(path[i]![0], path[i]![2]) < 0.7 && path[i + 1]![1] - g(path[i + 1]![0], path[i + 1]![2]) < 0.7)),
  };
  return { endAt: [r3(end[0]), r3(end[1])], deckY: opts.deckY, yaw: r3(yaw), spec, pathWorld: path, feet: feet.map((f) => f.map(r3) as V3), ground: T.map(r3) as V3, notes };
}

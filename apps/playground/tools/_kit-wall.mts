/**
 * Kit walls (k-town2, brief item 4, 2026-10-30): a town curtain laid from a kit's WALL PIECES along any line -- a ring,
 * a curve, a polyline -- so the pieces join with no gap and no overlap. The town-wall tool (`town-wall-line.mts kit`)
 * calls it; the pieces are the kit's site parts (MMO/WFC wfc/requests/<kit>-site.json):
 *   run       the 24 m straight curtain (square, whole ends)
 *   infill    straight curtain pieces of 12.8, 6.4, 3.2, 1.6, 0.8, 0.4, 0.2, 0.1, 0.05 m: any leg length is filled to
 *             under 5 cm (binary lengths, square ends)
 *   kink      a joint where the line turns: two 0.6 m stubs mitred at the turn, square ends; `in` turns toward the town
 *             (a convex ring), `out` toward the field; 2 deg steps up to 30 deg
 *   corner    the 90 deg corner (arms `cornerArm` m each way, square ends)
 *   tower     the square tower: the line passes STRAIGHT through it, its faces take the run ends flush
 *   gate      the gatehouse (o-town2, 2026-10-30): CENTRED on its vertex, which must be straight through (no turn); its
 *             side faces take the run ends flush (body `gate` m along the wall, `gateDepth` across; the upper storey
 *             overhangs above the curtain's top only)
 * Frame (engine XZ, metres): a piece's local +x runs along the wall, local +z is the OUTSIDE (the parapet face); a
 * placement's yaw turns it about +Y (three.js: world x = x cos + z sin, world z = -x sin + z cos). The ring is walked so
 * that its outside lies on the left-hand normal (-uz, ux) of each leg.
 *
 * Laying (no error accumulates): the line's leg directions are rounded to the kink step ABSOLUTELY (every leg within 1 deg
 * of its true bearing), then the leg lengths are corrected by least squares so a closed ring closes exactly; each corner
 * takes a kink (or the 90 deg corner, or nothing), a tower vertex its tower after the kink, and each leg between them is
 * filled greedily with runs and infills (the remainder, < 5 cm, is the only gap).
 */
export type V2 = [number, number];
export type KitWallDims = { thick: number; run: number; infills: number[]; kinkStub: number; kinkStep: number; kinkMax: number; tower: number; cornerArm: number; cornerPivot: V2; prefix: string; gate?: number; gateDepth?: number; gatePrefab?: string };
export const STRAND_WALL: KitWallDims = {
  thick: 2.4, run: 24, infills: [12.8, 6.4, 3.2, 1.6, 0.8, 0.4, 0.2, 0.1, 0.05], kinkStub: 0.6, kinkStep: 2, kinkMax: 30, tower: 5.2, cornerArm: 10, cornerPivot: [4.4, 4.4],
  prefix: "strand-town/strand-wall", gate: 9.6, gateDepth: 7, gatePrefab: "strand-town/strand-gatehouse",
};
/** at: the piece's centre (run, infill, tower) or pivot (kink, corner: the mitre point on the centreline); origin: where its
 *  PREFAB origin goes (the corner part is centred on its bounds); yaw in degrees */
export type WallPiece = { prefab: string; kind: "run" | "infill" | "kink" | "corner" | "tower" | "gate"; at: V2; origin: V2; yaw: number; len?: number; turn?: number; leg: number };
export type WallLay = { pieces: WallPiece[]; corners: V2[]; notes: string[] };

const DEG = Math.PI / 180;
const add = (a: V2, b: V2, s = 1): V2 => [a[0] + b[0] * s, a[1] + b[1] * s];
const dir = (ang: number): V2 => [Math.cos(ang), Math.sin(ang)];
/** yaw (deg) that turns local +x onto u = (ux, uz) */
const yawOf = (u: V2) => Math.atan2(-u[1], u[0]) / DEG;
/** the infill / run name for a length */
export function infillName(d: KitWallDims, L: number): string {
  return L === d.run ? `${d.prefix}-run` : `${d.prefix}-infill-${String(Math.round(L * 100)).padStart(4, "0")}`;
}
/** a kink's prefab: + turn = toward the field (the outside, "out"), - = toward the town ("in") */
export function kinkName(d: KitWallDims, turnDeg: number): string {
  return `${d.prefix}-kink-${turnDeg > 0 ? "out" : "in"}-${String(Math.abs(Math.round(turnDeg))).padStart(2, "0")}`;
}

/** signed area (x, z): > 0 when the ring runs counter-clockwise seen from +Y looking down... (x right, z toward viewer) */
function area(p: V2[]) { let a = 0; for (let i = 0; i < p.length; i++) { const q = p[i]!, r = p[(i + 1) % p.length]!; a += q[0] * r[1] - r[0] * q[1]; } return a / 2; }

/**
 * Lay the kit along `line`. closed: a ring (first vertex not repeated). towers: vertex indices that get a tower.
 */
export function layKitWall(line: V2[], opts: { closed: boolean; towers?: number[]; gates?: number[]; dims?: KitWallDims }): WallLay {
  const d = opts.dims ?? STRAND_WALL, notes: string[] = [];
  let pts = line.map((p) => [p[0], p[1]] as V2);
  let towers = new Set(opts.towers ?? []), gates = new Set(opts.gates ?? []);
  // the outside must be the left-hand normal (-uz, ux): for a ring that is the CLOCKWISE walk in (x, z) with this area sign
  if (opts.closed && area(pts) > 0) { pts = [pts[0]!, ...pts.slice(1).reverse()]; const flip = (i: number) => (i === 0 ? 0 : pts.length - i); towers = new Set([...towers].map(flip)); gates = new Set([...gates].map(flip)); }
  const n = pts.length, legs = opts.closed ? n : n - 1;
  const ang: number[] = [], Lt: number[] = [];
  for (let i = 0; i < legs; i++) { const a = pts[i]!, b = pts[(i + 1) % n]!; ang.push(Math.atan2(b[1] - a[1], b[0] - a[0])); Lt.push(Math.hypot(b[0] - a[0], b[1] - a[1])); }
  // absolute rounding of every leg bearing to the kink step, measured from leg 0 (unwrapped)
  const st = d.kinkStep * DEG, q: number[] = [ang[0]!];
  let acc = ang[0]!;
  for (let i = 1; i < legs; i++) {
    let dt = ang[i]! - ang[i - 1]!; while (dt > Math.PI) dt -= 2 * Math.PI; while (dt < -Math.PI) dt += 2 * Math.PI;
    acc += dt; q.push(ang[0]! + Math.round((acc - ang[0]!) / st) * st);
  }
  const U = q.map(dir);
  // least-squares leg lengths: sum L_i u_i = 0 (closed), L near the true lengths
  const L = Lt.slice();
  if (opts.closed) {
    let sx = 0, sz = 0, a11 = 0, a12 = 0, a22 = 0;
    for (let i = 0; i < legs; i++) { sx += Lt[i]! * U[i]![0]; sz += Lt[i]! * U[i]![1]; a11 += U[i]![0] ** 2; a12 += U[i]![0] * U[i]![1]; a22 += U[i]![1] ** 2; }
    const det = a11 * a22 - a12 * a12, l1 = (a22 * sx - a12 * sz) / det, l2 = (-a12 * sx + a11 * sz) / det;
    for (let i = 0; i < legs; i++) L[i] = Lt[i]! - (U[i]![0] * l1 + U[i]![1] * l2);
  }
  const C: V2[] = [pts[0]!];
  for (let i = 0; i < legs; i++) C.push(add(C[i]!, U[i]!, L[i]!));
  const pieces: WallPiece[] = [];
  // the joint at each corner: what it occupies before (along the incoming leg) and after (along the outgoing leg)
  type Joint = { before: number; after: number };
  const joints: Joint[] = [];
  for (let i = 0; i < n; i++) {
    const hasIn = opts.closed || i > 0, hasOut = opts.closed || i < n - 1;
    const uin = hasIn ? U[(i - 1 + legs) % legs]! : null, uout = hasOut ? U[i % legs]! : null;
    const c = C[i]!;
    let before = 0, after = 0;
    if (uin && uout) {
      let tr = (Math.atan2(uout[1], uout[0]) - Math.atan2(uin[1], uin[0])) / DEG; while (tr > 180) tr -= 360; while (tr < -180) tr += 360;
      tr = Math.round(tr / d.kinkStep) * d.kinkStep;
      // turning toward the outside normal (-uz, ux) is a turn to the LEFT in this frame: + = toward the field
      const towardOut = tr > 0;      // + = toward the outside normal: a turn toward the field
      if (Math.abs(tr) < 1e-9) { /* straight through */ }
      else if (Math.abs(Math.abs(tr) - 90) < 1e-9 && !towardOut) {
        const yw = yawOf(uin), cy = Math.cos(yw * DEG), sy = Math.sin(yw * DEG), pv = d.cornerPivot;
        pieces.push({ prefab: `${d.prefix}-corner`, kind: "corner", at: c, origin: [c[0] - (pv[0] * cy + pv[1] * sy), c[1] - (-pv[0] * sy + pv[1] * cy)], yaw: yw, turn: tr, leg: i });
        before = d.cornerArm; after = d.cornerArm;
      } else if (Math.abs(tr) <= d.kinkMax) {
        pieces.push({ prefab: kinkName(d, tr), kind: "kink", at: c, origin: c, yaw: yawOf(uin), turn: tr, leg: i });
        before = d.kinkStub; after = d.kinkStub;
      } else notes.push(`corner ${i}: a ${Math.abs(tr)} deg turn ${towardOut ? "toward the field" : "toward the town"} has no piece (kinks to ${d.kinkMax} deg, the 90 deg corner turning inward): subdivide the line`);
    }
    if (gates.has(i)) {
      const gw = d.gate ?? 0;
      if (!gw || !d.gatePrefab) notes.push(`corner ${i}: the kit has no gatehouse piece`);
      else if (!uin || !uout || Math.abs(before) > 1e-9 || Math.abs(after) > 1e-9 || pieces.some((p) => p.leg === i && (p.kind === "kink" || p.kind === "corner") && p.at === c)) notes.push(`corner ${i}: a gatehouse needs a straight-through vertex (no turn, not a line end)`);
      else { pieces.push({ prefab: d.gatePrefab, kind: "gate", at: c, origin: c, yaw: yawOf(uout), leg: i }); before = gw / 2; after = gw / 2; }
    } else if (towers.has(i) && uout) {
      const at = add(c, uout, after + d.tower / 2);
      pieces.push({ prefab: `${d.prefix}-tower`, kind: "tower", at, origin: at, yaw: yawOf(uout), leg: i });
      after += d.tower;
    } else if (towers.has(i) && uin) {
      const at = add(c, uin, -(before + d.tower / 2));
      pieces.push({ prefab: `${d.prefix}-tower`, kind: "tower", at, origin: at, yaw: yawOf(uin), leg: i - 1 });
      before += d.tower;
    }
    joints.push({ before, after });
  }
  for (let i = 0; i < legs; i++) {
    const u = U[i]!, s0 = joints[i]!.after, s1 = L[i]! - joints[(i + 1) % n]!.before;
    let rem = s1 - s0, s = s0;
    if (rem < -1e-6) { notes.push(`leg ${i}: ${(-rem).toFixed(2)} m too short for its joints and towers`); continue; }
    const lens: number[] = [];
    while (rem >= d.run - 1e-9) { lens.push(d.run); rem -= d.run; }
    for (const f of d.infills) if (rem >= f - 1e-9) { lens.push(f); rem -= f; }
    for (const len of lens) {
      const at = add(C[i]!, u, s + len / 2);
      pieces.push({ prefab: infillName(d, len), kind: len === d.run ? "run" : "infill", at, origin: at, yaw: yawOf(u), len, leg: i });
      s += len;
    }
  }
  return { pieces, corners: C.slice(0, n), notes };
}

// ---------------------------------------------------------------- the join check (plan footprints)

/** a piece's plan footprint in its local frame (x along the wall, z outside, the pivot / centre at the origin) */
export function localFootprint(p: WallPiece, d: KitWallDims = STRAND_WALL): V2[][] {
  const h = d.thick / 2;
  if (p.kind === "run" || p.kind === "infill") { const a = p.len! / 2; return [[[-a, -h], [a, -h], [a, h], [-a, h]]]; }
  if (p.kind === "tower") { const a = d.tower / 2; return [[[-a, -a], [a, -a], [a, a], [-a, a]]]; }
  if (p.kind === "gate") { const a = (d.gate ?? 0) / 2, b = (d.gateDepth ?? d.thick) / 2; return [[[-a, -b], [a, -b], [a, b], [-a, b]]]; }
  // a kink / corner: two stubs meeting in a mitre at the pivot; incoming along +x, outgoing turned by `turn` (+ = toward
  // the outside, the left-hand normal +z)
  const k = p.kind === "kink" ? d.kinkStub : d.cornerArm, t = (p.turn ?? 0) * DEG;
  const uo: V2 = [Math.cos(t), Math.sin(t)], nrm = (u: V2): V2 => [-u[1], u[0]];
  const ni = nrm([1, 0]), no = nrm(uo), m0: V2 = [ni[0] + no[0], ni[1] + no[1]], ml = Math.hypot(m0[0], m0[1]);
  const m: V2 = [m0[0] / ml, m0[1] / ml], sc = h / (m[0] * ni[0] + m[1] * ni[1]);
  const L: V2 = [m[0] * sc, m[1] * sc], Rm: V2 = [-L[0], -L[1]];
  return [[[-k, -h], Rm, L, [-k, h]], [Rm, [uo[0] * k - no[0] * h, uo[1] * k - no[1] * h], [uo[0] * k + no[0] * h, uo[1] * k + no[1] * h], L]];
}

/** world footprint polygons of a placed piece */
export function worldFootprint(p: WallPiece, d: KitWallDims = STRAND_WALL): V2[][] {
  const c = Math.cos(p.yaw * DEG), s = Math.sin(p.yaw * DEG);
  return localFootprint(p, d).map((poly) => poly.map(([x, z]) => [p.at[0] + x * c + z * s, p.at[1] - x * s + z * c] as V2));
}

function clipPoly(subject: V2[], clip: V2[]): V2[] {
  // Sutherland-Hodgman, convex clip polygon (either winding)
  const sgn = area(clip) > 0 ? 1 : -1;
  let out = subject;
  for (let i = 0; i < clip.length && out.length; i++) {
    const a = clip[i]!, b = clip[(i + 1) % clip.length]!;
    const inside = (p: V2) => sgn * ((b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0])) >= -1e-9;
    const inp = out; out = [];
    for (let j = 0; j < inp.length; j++) {
      const p = inp[j]!, q = inp[(j + 1) % inp.length]!;
      const ip = inside(p), iq = inside(q);
      if (ip) out.push(p);
      if (ip !== iq) {
        const dx = q[0] - p[0], dz = q[1] - p[1], ex = b[0] - a[0], ez = b[1] - a[1];
        const den = dx * ez - dz * ex; if (Math.abs(den) < 1e-12) continue;
        const t = ((a[0] - p[0]) * ez - (a[1] - p[1]) * ex) / den; out.push([p[0] + t * dx, p[1] + t * dz]);
      }
    }
  }
  return out;
}

/**
 * Findings for a laid wall (empty = joined): `overlap` any two pieces' footprints sharing more than 0.01 m2; `gap` along
 * each leg, the end face of one piece and the start face of the next more than `gapMax` apart at either wall face; plus
 * the layer's own notes (a turn with no piece, a leg too short).
 */
export function kitWallFindings(lay: WallLay, opts: { closed: boolean; gapMax?: number; dims?: KitWallDims }): string[] {
  const d = opts.dims ?? STRAND_WALL, gapMax = opts.gapMax ?? 0.05, f = [...lay.notes];
  const fp = lay.pieces.map((p) => worldFootprint(p, d));
  for (let i = 0; i < fp.length; i++) for (let j = i + 1; j < fp.length; j++) {
    let a = 0;
    for (const P of fp[i]!) for (const Q of fp[j]!) { const r = clipPoly(P, Q); if (r.length >= 3) a += Math.abs(area(r)); }
    if (a > 0.01) f.push(`overlap: ${lay.pieces[i]!.prefab} and ${lay.pieces[j]!.prefab} share ${a.toFixed(2)} m2`);
  }
  // gaps: walk the faces. Every piece has a start edge and an end edge (in walk order); consecutive pieces meet there.
  const ends = lay.pieces.map((p) => {
    const polys = fp[lay.pieces.indexOf(p)]!;
    if (p.kind === "kink" || p.kind === "corner") { const a = polys[0]!, b = polys[1]!; return { start: [a[0]!, a[3]!] as V2[], end: [b[1]!, b[2]!] as V2[] }; }
    const q = polys[0]!; return { start: [q[0]!, q[3]!] as V2[], end: [q[1]!, q[2]!] as V2[] };
  });
  // order along the wall: by leg, then by distance from the leg's corner
  const along = lay.pieces.map((p, i) => ({ i, leg: p.leg, s: Math.hypot(p.at[0] - lay.corners[p.leg]![0], p.at[1] - lay.corners[p.leg]![1]) * (p.kind === "kink" || p.kind === "corner" ? -1 : 1) }));
  along.sort((a, b) => a.leg - b.leg || a.s - b.s);
  const seq = along.map((a) => a.i);
  const m = opts.closed ? seq.length : seq.length - 1;
  for (let k = 0; k < m; k++) {
    const ia = seq[k]!, ib = seq[(k + 1) % seq.length]!, A = ends[ia]!, B = ends[ib]!;
    // A's end edge [right face corner, left face corner] meets B's start edge [right, left]; a TOWER face takes the wall
    // end anywhere on it: the wall's corners must lie on the face segment (distance to the segment)
    const segD = (p: V2, a: V2, b: V2) => { const dx = b[0] - a[0], dz = b[1] - a[1], L2 = dx * dx + dz * dz || 1; const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dz) / L2)); return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dz); };
    let g: number;
    if ((lay.pieces[ib]!.kind === "tower" || lay.pieces[ib]!.kind === "gate") && lay.pieces[ia]!.kind !== "tower" && lay.pieces[ia]!.kind !== "gate") g = Math.max(segD(A.end[0]!, B.start[0]!, B.start[1]!), segD(A.end[1]!, B.start[0]!, B.start[1]!));
    else if ((lay.pieces[ia]!.kind === "tower" || lay.pieces[ia]!.kind === "gate") && lay.pieces[ib]!.kind !== "tower" && lay.pieces[ib]!.kind !== "gate") g = Math.max(segD(B.start[0]!, A.end[0]!, A.end[1]!), segD(B.start[1]!, A.end[0]!, A.end[1]!));
    else g = Math.max(Math.hypot(A.end[0]![0] - B.start[0]![0], A.end[0]![1] - B.start[0]![1]), Math.hypot(A.end[1]![0] - B.start[1]![0], A.end[1]![1] - B.start[1]![1]));
    if (g > gapMax) f.push(`gap: ${(g * 100).toFixed(1)} cm between ${lay.pieces[seq[k]!]!.prefab} and ${lay.pieces[seq[(k + 1) % seq.length]!]!.prefab} (leg ${lay.pieces[seq[k]!]!.leg})`);
  }
  return f;
}

/** a ring of `n` vertices on a circle (x, z), towers on every `every`-th vertex */
export function circleLine(r: number, n: number, c: V2 = [0, 0]): V2[] {
  return Array.from({ length: n }, (_, i) => [c[0] + r * Math.cos((2 * Math.PI * i) / n), c[1] + r * Math.sin((2 * Math.PI * i) / n)] as V2);
}

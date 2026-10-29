/**
 * Town-wall rules (Derek's walk, Saltharrow 2026-10-29: "why is the wall that is hand made cliff rock? these walls are
 * also below the cliffs the village resides in ... those walls wouldn't be built to protect anyone that way").
 *
 *  1. MATERIAL: a wall the town owns (town wall, gatehouse, quay) is built in the town's MASONRY, never the zone's cliff
 *     skin. A `wall` op with no `materials.face` (or `zone` / `zone-stone` / `zone-splat` / `surface:<rock>`) bakes in
 *     the stone sampled round its foot (tools/landmark.mts) — on a coast that is the cliff. `townWallMaterialFault`
 *     names the fault; landmark.mts refuses the bake, town-wall-line.mts check fails the row.
 *  2. DEFENSIBLE LINE: a wall is not OVERLOOKED — no ground outside it within `OVERLOOK_RULE.band` m stands above the
 *     wall top (+ parapet) there AND sees a person in the town over it (terrain and the wall's own screen occlude);
 *     and no run at the WATERLINE whose top is below the shelves it fronts (it guards nothing).
 * Pure: callers pass a height function. Test: test/town-wall-rules.test.ts.
 */
type V2 = [number, number];
type V3 = [number, number, number];

/** The numbers of the overlook gate (the brief's 60 m; a viewer's eye and a townsman's head). */
export const OVERLOOK_RULE = {
  /** ground sampled outside the wall up to this far from its line, m */
  band: 60,
  /** viewer grid, m */
  grid: 4,
  /** viewer eye over the ground, m */
  eye: 1.7,
  /** the target: a person standing in the town, head over the ground, m */
  head: 1.6,
  /** ray sample step, m */
  step: 1.5,
  /** a waterline run: wall-face ground within this of the sea level ... */
  waterline: 2,
  /** ... whose screen top is below the highest shelf within this distance (m) of it */
  shelfReach: 30,
} as const;

/** Town masonry by the town's wall style (tools/worldgen-terrace-walls.mts townWallStyle): the retaining-wall kit's own
 *  materials (world-kit, painted at the town texel standard: 128 px tiles = 3.2 m at 40 tx/m), so a town wall, its
 *  gatehouse and its quay read as the same masons' work as its terrace risers. Civic defences take the dressed ashlar. */
export const TOWN_MASONRY = { ashlar: "retaining-wall/ashlar", rubble: "retaining-wall/rubble" } as const;

/** A material value that is a terrain/cliff skin rather than a built material. */
export function isTerrainSkin(m: string | undefined): boolean {
  return m === undefined || m === "zone" || m === "zone-stone" || m === "zone-splat" || m.startsWith("surface:") || m.startsWith("auto:");
}

/** The fault of a town-owned wall doc's materials (face + every role that falls back to it), or null. */
export function townWallMaterialFault(doc: { id?: unknown; materials?: Record<string, string | string[]> | null }): string | null {
  const mats = doc.materials ?? {};
  const face = mats.face;
  const faces = Array.isArray(face) ? face : [face];
  const bad = faces.filter((m) => isTerrainSkin(m));
  if (bad.length) return `${String(doc.id)}: materials.face ${bad[0] === undefined ? "unset (bakes in the zone's cliff stone)" : `"${bad[0]}" is a terrain skin`} — a town-owned wall takes the town masonry (${TOWN_MASONRY.ashlar} / ${TOWN_MASONRY.rubble})`;
  for (const [role, m] of Object.entries(mats)) for (const v of Array.isArray(m) ? m : [m]) if (isTerrainSkin(v)) return `${String(doc.id)}: materials.${role} "${v}" is a terrain skin — town masonry only`;
  return null;
}

/**
 * What every town wall `town-wall-line draw` writes carries (Derek 2026-10-29, "walls dont feel hand made"): the wall
 * operator's HAND-MADE top (`handmade: {}` = the top steps a course in short seeded runs, a few coping stones dropped)
 * and a rubble footing under the ashlar face (never one tile). `--machine-top` is the only opt-out (handmade: null).
 */
export function townWallFinish(opts: { machineTop?: boolean } = {}): { handmade: Record<string, never> | null; materials: { face: string; footing: string } } {
  return { handmade: opts.machineTop ? null : {}, materials: { face: TOWN_MASONRY.ashlar, footing: TOWN_MASONRY.rubble } };
}

/** The fault of a town-owned wall doc with a MACHINE top (no `handmade`, not step mode), or null (handmade-check's rule). */
export function townWallHandmadeFault(doc: { id?: unknown; op?: unknown; variant?: unknown; handmade?: unknown; heightMode?: unknown }): string | null {
  if (doc.op !== "wall" || doc.variant === "ramp" || doc.variant === "quay" || doc.variant === "retaining") return null;
  if ((doc.handmade === undefined || doc.handmade === null) && doc.heightMode !== "step") return `${String(doc.id)}: a machine top (no \`handmade\`): redraw with town-wall-line draw (hand-made by default) or add handmade: {} to the op, then worldgen op --apply + tools/landmark.mts`;
  return null;
}

/**
 * Is this wall op the town's? Its id is named for the town (`<town>-...`, the town doc name or the recipe id), or its
 * line runs inside the town's radius (+ 20 m). Ramps (road causeways) are not walls of the town.
 */
export function townOwnerOf(doc: { id?: unknown; op?: unknown; variant?: unknown; points?: unknown }, towns: { id: string; name?: string; center: number[]; radius: number }[]): string | null {
  if (doc.op !== "wall" || doc.variant === "ramp") return null;
  const id = String(doc.id ?? "");
  for (const t of towns) if (id.startsWith(`${t.id}-`) || (t.name && id.startsWith(`${t.name}-`))) return t.id;
  const pts = Array.isArray(doc.points) ? (doc.points as V2[]) : [];
  for (const t of towns) if (pts.some((p) => Math.hypot(p[0] - t.center[0]!, p[1] - t.center[1]!) <= t.radius + 20)) return t.id;
  return null;
}

export const dist2 = (a: V2, b: V2): number => Math.hypot(a[0] - b[0], a[1] - b[1]);
export function segDist(p: V2, a: V2, b: V2): { d: number; t: number; q: V2 } {
  const dx = b[0] - a[0], dz = b[1] - a[1], l2 = dx * dx + dz * dz || 1;
  const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dz) / l2));
  const q: V2 = [a[0] + dx * t, a[1] + dz * t];
  return { d: dist2(p, q), t, q };
}
export function polyDist(p: V2, line: V2[]): number {
  let best = Infinity;
  for (let i = 0; i + 1 < line.length; i++) best = Math.min(best, segDist(p, line[i]!, line[i + 1]!).d);
  return best;
}
export function inPolygon(p: V2, poly: V2[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i]!, b = poly[j]!;
    if (a[1] > p[1] !== b[1] > p[1] && p[0] < ((b[0] - a[0]) * (p[1] - a[1])) / (b[1] - a[1] || 1e-12) + a[0]) inside = !inside;
  }
  return inside;
}
/** 2D segment crossing: the parameter along p0->p1 and along a->b, or null. */
function crossing(p0: V2, p1: V2, a: V2, b: V2): { t: number; u: number } | null {
  const rx = p1[0] - p0[0], rz = p1[1] - p0[1], sx = b[0] - a[0], sz = b[1] - a[1];
  const den = rx * sz - rz * sx;
  if (Math.abs(den) < 1e-9) return null;
  const qx = a[0] - p0[0], qz = a[1] - p0[1];
  const t = (qx * sz - qz * sx) / den, u = (qx * rz - qz * rx) / den;
  return t >= 0 && t <= 1 && u >= 0 && u <= 1 ? { t, u } : null;
}

/** A wall's screen: its line every few metres with the top it puts up (coping + parapet + merlons), world. */
export interface Screen { id: string; profile: V3[] }
/** `cross`: where the sight line passes over the wall (the stretch too low there), null = through a gap / round an end. */
export interface OverlookFinding { at: V3; over: number; wall: string; sees: string; target: V3; cross: V2 | null }
export interface OverlookResult { viewers: number; above: number; overlooking: number; worst: OverlookFinding | null; findings: OverlookFinding[] }

/** The screen top nearest a point (and the distance to that screen). */
export function nearestTop(p: V2, screens: Screen[]): { top: number; d: number; id: string } {
  let best = { top: -Infinity, d: Infinity, id: "" };
  // the profile is [x, z, top]
  for (const s of screens) for (let i = 0; i + 1 < s.profile.length; i++) {
    const a = s.profile[i]!, b = s.profile[i + 1]!, r = segDist(p, [a[0], a[1]], [b[0], b[1]]);
    if (r.d < best.d) best = { top: a[2] + (b[2] - a[2]) * r.t, d: r.d, id: s.id };
  }
  return best;
}

/**
 * THE OVERLOOK GATE. Viewers on a grid within `band` m of the screens, OUTSIDE the enclosure, whose eye stands above
 * the screen top nearest them; one OVERLOOKS when its sight line to any target (a townsman's head on a street or at a
 * door) clears the ground and every screen it crosses.
 */
export function overlook(opts: { height: (x: number, z: number) => number; screens: Screen[]; enclosure: V2[]; targets: { name: string; at: V2 }[]; sea: number; rule?: typeof OVERLOOK_RULE }): OverlookResult {
  const R = opts.rule ?? OVERLOOK_RULE, H = opts.height;
  const pts = opts.screens.flatMap((s) => s.profile);
  if (!pts.length) return { viewers: 0, above: 0, overlooking: 0, worst: null, findings: [] };
  const x0 = Math.min(...pts.map((p) => p[0])) - R.band, x1 = Math.max(...pts.map((p) => p[0])) + R.band;
  const z0 = Math.min(...pts.map((p) => p[1])) - R.band, z1 = Math.max(...pts.map((p) => p[1])) + R.band;
  const targets = opts.targets.map((t) => ({ name: t.name, at: [t.at[0], t.at[1], H(t.at[0], t.at[1]) + R.head] as V3 }));
  const segs = opts.screens.flatMap((s) => s.profile.slice(1).map((b, i) => ({ id: s.id, a: s.profile[i]!, b })));
  const sees = (v: V3, t: V3): { cross: V2 | null } | null => {
    const L = Math.hypot(t[0] - v[0], t[1] - v[1]);
    const n = Math.max(2, Math.ceil(L / R.step));
    for (let k = 1; k < n; k++) {
      const f = k / n, x = v[0] + (t[0] - v[0]) * f, z = v[1] + (t[1] - v[1]) * f, y = v[2] + (t[2] - v[2]) * f;
      if (H(x, z) > y) return null;
    }
    let cross: V2 | null = null, least = Infinity;
    for (const s of segs) {
      const c = crossing([v[0], v[1]], [t[0], t[1]], [s.a[0], s.a[1]], [s.b[0], s.b[1]]);
      if (!c) continue;
      const top = s.a[2] + (s.b[2] - s.a[2]) * c.u, y = v[2] + (t[2] - v[2]) * c.t;
      if (top >= y) return null;
      if (y - top < least) { least = y - top; cross = [v[0] + (t[0] - v[0]) * c.t, v[1] + (t[1] - v[1]) * c.t]; }
    }
    return { cross };
  };
  let viewers = 0, above = 0;
  const findings: OverlookFinding[] = [];
  for (let x = Math.floor(x0 / R.grid) * R.grid; x <= x1; x += R.grid) for (let z = Math.floor(z0 / R.grid) * R.grid; z <= z1; z += R.grid) {
    const p: V2 = [x, z];
    const nt = nearestTop(p, opts.screens);
    if (nt.d > R.band || nt.d < 1.5 || inPolygon(p, opts.enclosure)) continue;
    const g = H(x, z);
    if (g <= opts.sea) continue;
    viewers++;
    const eye = g + R.eye;
    if (eye <= nt.top) continue;
    above++;
    const v: V3 = [x, z, eye];
    for (const t of targets) {
      const s = sees(v, t.at);
      if (!s) continue;
      findings.push({ at: [x, z, Math.round(g * 100) / 100], over: Math.round((eye - nt.top) * 100) / 100, wall: nt.id, sees: t.name, target: t.at, cross: s.cross });
      break;
    }
  }
  findings.sort((a, b) => b.over - a.over);
  return { viewers, above, overlooking: findings.length, worst: findings[0] ?? null, findings };
}

/** WATERLINE: screen stretches whose ground is at the sea and whose top is below the highest shelf near them. */
export function waterlineRuns(opts: { height: (x: number, z: number) => number; screens: Screen[]; shelves: { groundY: number; points: V2[] }[]; sea: number; rule?: typeof OVERLOOK_RULE }): { wall: string; at: V2; ground: number; top: number; shelf: number }[] {
  const R = opts.rule ?? OVERLOOK_RULE, out: { wall: string; at: V2; ground: number; top: number; shelf: number }[] = [];
  for (const s of opts.screens) for (const p of s.profile) {
    const g = opts.height(p[0], p[1]);
    if (g > opts.sea + R.waterline) continue;
    const near = opts.shelves.filter((sh) => polyDist([p[0], p[1]], sh.points) <= R.shelfReach).map((sh) => sh.groundY);
    const shelf = near.length ? Math.max(...near) : -Infinity;
    if (p[2] < shelf) out.push({ wall: s.id, at: [p[0], p[1]], ground: Math.round(g * 100) / 100, top: p[2], shelf });
  }
  return out;
}

/** Convex hull (monotone chain), counter-clockwise. */
export function hull(points: V2[]): V2[] {
  const p = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (p.length < 3) return p;
  const cross = (o: V2, a: V2, b: V2) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lo: V2[] = [], hi: V2[] = [];
  for (const q of p) { while (lo.length >= 2 && cross(lo[lo.length - 2]!, lo[lo.length - 1]!, q) <= 0) lo.pop(); lo.push(q); }
  for (const q of [...p].reverse()) { while (hi.length >= 2 && cross(hi[hi.length - 2]!, hi[hi.length - 1]!, q) <= 0) hi.pop(); hi.push(q); }
  return [...lo.slice(0, -1), ...hi.slice(0, -1)];
}

/** A convex polygon (CCW) grown by `d` m: each edge moved out, corners rounded with points every <= 30 deg. */
export function grow(poly: V2[], d: number): V2[] {
  const out: V2[] = [], n = poly.length;
  for (let i = 0; i < n; i++) {
    const prev = poly[(i + n - 1) % n]!, p = poly[i]!, next = poly[(i + 1) % n]!;
    const nrm = (a: V2, b: V2): V2 => { const dx = b[0] - a[0], dz = b[1] - a[1], l = Math.hypot(dx, dz) || 1; return [dz / l, -dx / l]; }; // CCW: outward = right of travel
    const n0 = nrm(prev, p), n1 = nrm(p, next);
    let a0 = Math.atan2(n0[1], n0[0]), a1 = Math.atan2(n1[1], n1[0]);
    while (a1 < a0) a1 += 2 * Math.PI;
    if (a1 - a0 > Math.PI) a1 -= 2 * Math.PI; // the short way round
    const k = Math.max(1, Math.ceil(Math.abs(a1 - a0) / (Math.PI / 6)));
    for (let j = 0; j <= k; j++) { const a = a0 + ((a1 - a0) * j) / k; out.push([p[0] + Math.cos(a) * d, p[1] + Math.sin(a) * d]); }
  }
  return out;
}

/** A polyline resampled so no leg is longer than `step` m. */
export function densify(line: V2[], step: number): V2[] {
  const out: V2[] = [line[0]!];
  for (let i = 1; i < line.length; i++) {
    const a = line[i - 1]!, b = line[i]!, n = Math.max(1, Math.ceil(dist2(a, b) / step));
    for (let k = 1; k <= n; k++) out.push([a[0] + ((b[0] - a[0]) * k) / n, a[1] + ((b[1] - a[1]) * k) / n]);
  }
  return out;
}

/** Douglas-Peucker: straight legs (a town wall is legs and mitred corners, not a saw). */
export function simplify(line: V2[], tol: number): V2[] {
  if (line.length <= 2) return line;
  let worst = 0, at = 0;
  for (let i = 1; i < line.length - 1; i++) { const d = segDist(line[i]!, line[0]!, line[line.length - 1]!).d; if (d > worst) { worst = d; at = i; } }
  if (worst <= tol) return [line[0]!, line[line.length - 1]!];
  return [...simplify(line.slice(0, at + 1), tol).slice(0, -1), ...simplify(line.slice(at), tol)];
}

/** The road keep-off: a town wall stands at least this far (m) from every road's centreline except at its gatehouse,
 *  where the road passes through it (a curtain hugging a road is a 2 m cart lane between a cliff of stone and the
 *  ditch, and the road's own cut/fill eats the wall's footing). */
export const ROAD_KEEP = 6;

/** Where a wall line comes nearer than `keep` to a road outside the `exempt` discs (the gatehouses), sampled each
 *  metre: the worst sample per wall, or nothing. */
export function roadCrowding(walls: { id: string; points: V2[] }[], roads: { id: string; points: V2[] }[], exempt: { at: V2; r: number }[], keep = ROAD_KEEP): { wall: string; road: string; at: V2; d: number }[] {
  const out: { wall: string; road: string; at: V2; d: number }[] = [];
  for (const w of walls) {
    let worst: { wall: string; road: string; at: V2; d: number } | null = null;
    for (const p of densify(w.points, 1)) {
      if (exempt.some((e) => dist2(p, e.at) <= e.r)) continue;
      for (const r of roads) { const d = polyDist(p, r.points); if (d < keep && (!worst || d < worst.d)) worst = { wall: w.id, road: r.id, at: [Math.round(p[0] * 100) / 100, Math.round(p[1] * 100) / 100], d: Math.round(d * 100) / 100 }; }
    }
    if (worst) out.push(worst);
  }
  return out;
}

/** Push each vertex of a wall line (ends and `held` indices stay) to the TOWN side of every road (the side `side`, the
 *  town's centroid, lies on) and `keep` + 0.5 m off it: a road outside the town runs outside its wall, never through
 *  it (a vertex up to 3 x keep beyond the road is pulled back across). Vertices in an exempt disc stay. */
export function keepOffRoads(line: V2[], roads: V2[][], exempt: { at: V2; r: number }[], held: Set<number>, side: V2, keep = ROAD_KEEP): V2[] {
  const out = line.map((q) => [q[0], q[1]] as V2);
  for (let pass = 0; pass < 4; pass++) {
    let movedAny = false;
    out.forEach((q, i) => {
      if (i === 0 || i === out.length - 1 || held.has(i) || exempt.some((e) => dist2(q, e.at) <= e.r)) return;
      for (const r of roads) {
        let best: { d: number; q: V2; k: number } | null = null;
        for (let k = 0; k + 1 < r.length; k++) { const s = segDist(q, r[k]!, r[k + 1]!); if (!best || s.d < best.d) best = { d: s.d, q: s.q, k }; }
        if (!best || best.d >= 3 * keep) continue;
        const a = r[best.k]!, b = r[best.k + 1]!, l = dist2(a, b) || 1, nn: V2 = [-(b[1] - a[1]) / l, (b[0] - a[0]) / l];
        const town = Math.sign(nn[0] * (side[0] - best.q[0]) + nn[1] * (side[1] - best.q[1])) || 1;
        const mine = Math.sign(nn[0] * (q[0] - best.q[0]) + nn[1] * (q[1] - best.q[1]));
        if (mine === town && best.d >= keep) continue;
        // off the road's end (the nearest point is an end vertex): away from that end, on the town side
        q[0] = best.q[0] + nn[0] * town * (keep + 0.5); q[1] = best.q[1] + nn[1] * town * (keep + 0.5); movedAny = true;
      }
    });
    if (!movedAny) break;
  }
  return out;
}

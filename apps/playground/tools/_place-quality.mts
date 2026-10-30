/**
 * PLACE QUALITY — the measured floors a place-build place must clear (Hagsheer 2026-10-21: the 28 installed places were
 * small 16-30 m patches, a handful of props on open grass, walls in the terrain cliff tile and nothing that read from
 * 300 m). Pure (no fs): place-build `plan` applies the floors, the `place` check gates the read, `quality` grades the
 * installed places of a zone on four lines (core footprint, prop density, built surface, the 300 m read).
 */
type V2 = [number, number];
const dist = (a: V2, b: V2) => Math.hypot(a[0] - b[0], a[1] - b[1]);
export type Tier = "pinpoint" | "small" | "medium" | "large";

/** The evidence frame (light-shots): 1280 x 720, the play camera's vertical field of view 60 deg. */
export const SHOT_H = 720, SHOT_VFOV_DEG = 60;
/** Pixels per metre of height at 1 m (the frame's focal length in pixels). */
export const FOCAL_PX = SHOT_H / 2 / Math.tan((SHOT_VFOV_DEG / 2) * (Math.PI / 180));
/** L (read, Hagsheer 2026-10-21): the landmark (or smoke column) shows at least this many pixels tall over the ground
 *  in the read shot from the far end of the tier's read window (medium 300 m: 7.7 m visible; small 150 m: 3.9 m). */
export const READ_PX_MIN = 16;
export const pxOf = (visibleM: number, d: number) => (d > 0 ? (visibleM / d) * FOCAL_PX : 0);
/** Metres of landmark that must show at `d` for READ_PX_MIN pixels. */
export const heightForPx = (d: number, px = READ_PX_MIN) => (px * d) / FOCAL_PX;

/** L (size, Hagsheer 2026-10-21: a medium place was a 20 m clutter patch): the radius the place's core and every other
 *  pocket covers on the ground, per built tier (metres). The archetype's own radius stays the ground-fit / pad radius;
 *  the layout (structures, walls, dressing area) is spread to this. site-standards: small ~40 m, medium ~100 m across.
 *  Owner ruling 2026-10-21 23:25 ("larger and more silhouetted POIs"): medium core 24 -> 30 m, the rest in step. */
export const POCKET_FLOOR_M: Record<Tier, { core: number; other: number }> = {
  pinpoint: { core: 7, other: 5 }, small: { core: 20, other: 11 }, medium: { core: 30, other: 15 }, large: { core: 44, other: 20 },
};
/** site-standards' footprint per size class (first guess, metres across). */
export const CLASS_FOOTPRINT_M: Record<Tier, number> = { pinpoint: 15, small: 40, medium: 100, large: 300 };
/** L (dressing, Hagsheer 2026-10-21: a handful of props on open grass): loose props per 100 m2 of a dressing area, by
 *  role (site-dressing: density scales with area). An archetype's `dressing.density` overrides. */
export const DENSITY_FLOOR: Record<string, number> = { camp: 1.2, yard: 1.0, ruin: 1.0, shore: 0.6, path: 0.4, "cave-mouth": 0.8 };
/** The most items a first plan asks of one area (the socket map drops what has no room). */
export const DENSITY_MAX_ITEMS = 40;
export function densityNeed(role: string, radius: number, override?: number): number {
  const per = override ?? DENSITY_FLOOR[role] ?? 1;
  return Math.min(DENSITY_MAX_ITEMS, Math.ceil((per * Math.PI * radius * radius) / 100));
}

/** A wall operator's materials resolve to the terrain cliff tile when no face is given or it is `zone` / a
 *  `surface:` paint (the landmark material fallback): L (art, Hagsheer 2026-10-21: kirk-knowe's kirkyard wore the zone
 *  cliff slate as a blue checker). Built walls take the zone's BUILT stone (place-build zone defaults `builtStone`). */
export function wearsCliffTile(materials: Record<string, string | string[]> | undefined): boolean {
  const face = materials?.face;
  const list = face === undefined ? [] : ([] as string[]).concat(face);
  return !list.length || list.some((m) => m === "zone" || m.startsWith("surface:"));
}

/** The visible height (m) and pixels of a target seen from `eye` (x,y,z): the part above both its foot and the line
 *  over the highest ground between (`g.height` every 4 m, 0.5 m clearance, the last 6 m ignored), zero beyond fogReach. */
export function readPixels(g: { height(x: number, z: number): number }, eye: [number, number, number], target: { at: V2; foot: number; top: number; fogReach?: number }) {
  const p: V2 = [eye[0], eye[2]], d = dist(p, target.at), n = Math.max(2, Math.floor(d / 4));
  let occ = -Infinity;
  for (let k = 1; k < n; k++) { const t = k / n; if (d * (1 - t) <= 6) continue;
    const h = g.height(p[0] + (target.at[0] - p[0]) * t, p[1] + (target.at[1] - p[1]) * t) + 0.5; occ = Math.max(occ, eye[1] + (h - eye[1]) / t); }
  const visible = Math.max(0, target.top - Math.max(target.foot, occ));
  const fog = target.fogReach !== undefined && d > target.fogReach;
  return { distance: Math.round(d), visible: Math.round(visible * 10) / 10, px: fog ? 0 : Math.round(pxOf(visible, d) * 10) / 10, fog };
}

/** Largest distance between any two points (the built footprint's diameter). */
export function spanOf(points: V2[]): number {
  let m = 0; for (let i = 0; i < points.length; i++) for (let j = i + 1; j < points.length; j++) m = Math.max(m, dist(points[i]!, points[j]!));
  return Math.round(m);
}

export interface QualityRow {
  id: string; tier: Tier; archetype: string;
  core: { diameter: number; floor: number; ok: boolean };
  density: { props: number; areaM2: number; per100: number; floor: number; ok: boolean; /** share of the core area whose ground cover the place clears (a bare flat tile to the horizon) */ coverCleared: number };
  built: { walls: number; cliff: number; materials: string[]; bigRocks: number; ok: boolean };
  read: { view: string | null; distance: number | null; px: number | null; floor: number; ok: boolean; target: string | null };
  /** ribbon operators the place still declares (approach or footpaths): ribbons were removed 2026-10-30, any entry is a fault */
  ribbons: string[];
  score: number;
}
/** Share (0..1) of a disc whose ground cover the clearings remove (circles and polygons with `cover` not false). */
export function coverClearedShare(c: V2, r: number, clearings: { center?: V2; radius?: number; polygon?: V2[]; cover?: boolean }[], step = 2): number {
  const cov = clearings.filter((k) => k.cover !== false);
  const inPoly = (q: V2, poly: V2[]) => { let a = false; for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) { const [xi, zi] = poly[i]!, [xj, zj] = poly[j]!; if (zi > q[1] !== zj > q[1] && q[0] < ((xj - xi) * (q[1] - zi)) / (zj - zi) + xi) a = !a; } return a; };
  let n = 0, hit = 0;
  for (let x = -r; x <= r; x += step) for (let z = -r; z <= r; z += step) { if (x * x + z * z > r * r) continue; const q: V2 = [c[0] + x, c[1] + z]; n++;
    if (cov.some((k) => (k.center && k.radius ? dist(q, k.center) <= k.radius : k.polygon ? inPoly(q, k.polygon) : false))) hit++; }
  return n ? Math.round((hit / n) * 100) / 100 : 0;
}
/** One grade 0..4 (higher = better): each line contributes its ratio to its floor, capped at 1 (built: 0 or 1). */
export function gradeScore(r: Omit<QualityRow, "score" | "ribbons">): number {
  const c = Math.min(1, r.core.diameter / r.core.floor), d = Math.min(1, r.density.per100 / r.density.floor), rd = Math.min(1, (r.read.px ?? 0) / r.read.floor);
  return Math.round((c + d + rd + (r.built.ok ? 1 : 0)) * 100) / 100;
}

// ---------------------------------------------------------------------------------------------------------------------
// SEATING (signal-tower 2026-10-21, owner: "the ruins are floating"): a structure set at its pocket's median ground on a
// slope stood clear of the ground on its low side; float passed it because ONE contact was within 0.05 m. A structure's
// seat is judged on its BASE OUTLINE (the mesh's lowest surface, cell by cell): the most daylight anywhere along it.

/** Largest daylight gap (m) allowed anywhere under a structure's base outline. */
export const SEAT_GAP_M = 0.05;
/** Metres the skirt's footing runs below the lowest ground on the outline (T-WALL: the wall builder's footing). */
export const SKIRT_BURY_M = 0.6;
/** Under this extent (m, either axis of the base) a piece is sunk to its lowest ground instead of skirted (a post). */
export const SKIRT_MIN_EXTENT_M = 1.5;
/** A base covering less of its bounds than this stands on legs, posts or wheels: sunk to its lowest ground, never skirted. */
export const SKIRT_MIN_FILL = 0.3;
type Tri3 = { a: number[]; b: number[]; c: number[]; material?: string };
const upHit = (tris: Tri3[], x: number, y0: number, z: number): number => {
  let best = Infinity;
  for (const t of tris) {
    const { a, b, c } = t;
    if (x < Math.min(a[0]!, b[0]!, c[0]!) || x > Math.max(a[0]!, b[0]!, c[0]!) || z < Math.min(a[2]!, b[2]!, c[2]!) || z > Math.max(a[2]!, b[2]!, c[2]!)) continue;
    const d = (b[2]! - c[2]!) * (a[0]! - c[0]!) + (c[0]! - b[0]!) * (a[2]! - c[2]!); if (Math.abs(d) < 1e-12) continue;
    const l1 = ((b[2]! - c[2]!) * (x - c[0]!) + (c[0]! - b[0]!) * (z - c[2]!)) / d, l2 = ((c[2]! - a[2]!) * (x - c[0]!) + (a[0]! - c[0]!) * (z - c[2]!)) / d, l3 = 1 - l1 - l2;
    if (l1 < -1e-6 || l2 < -1e-6 || l3 < -1e-6) continue;
    const hy = l1 * a[1]! + l2 * b[1]! + l3 * c[1]!; if (hy > y0 && hy < best) best = hy;
  }
  return best;
};
/** A base outline at uniform scale `k` (a structure placed larger than its catalogue size: place-build `scale`). */
export const scaleBase = (b: BaseOutline, k: number): BaseOutline => (k === 1 ? b : { ...b, cells: b.cells.map(([x, z, y]) => [x * k, z * k, y * k]), perimeter: b.perimeter.map(([x, z, y]) => [x * k, z * k, y * k]), extent: [b.extent[0] * k, b.extent[1] * k] });
export interface BaseOutline { cells: [number, number, number][]; perimeter: [number, number, number][]; extent: [number, number]; /** base cells' share of the bounds (legs, posts, wheels: low) */ fill: number; material?: string }
/** The base of a prefab (its triangles in the root frame): 0.5 m cells whose lowest surface is within `band` m of the
 *  mesh's bottom (or of 0.3 m under the origin when the mesh reaches further down: a foundation stub buried by design,
 *  old-watch/ruined-tower 3.9 m), [x, z, bottom y]; `perimeter` = the cells with an open side; `material` = the most used material of
 *  the triangles in the lowest metre (the skirt's own stone). Null when the mesh has no base. */
export function baseOutline(tris: Tri3[], cell = 0.5, band = 0.35): BaseOutline | null {
  if (!tris.length) return null;
  const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
  for (const t of tris) for (const p of [t.a, t.b, t.c]) for (let k = 0; k < 3; k++) { mn[k] = Math.min(mn[k]!, p[k]!); mx[k] = Math.max(mx[k]!, p[k]!); }
  const ref = Math.max(mn[1]!, -0.3), y0 = ref > mn[1]! ? ref : mn[1]! - 1;
  const nx = Math.max(1, Math.ceil((mx[0]! - mn[0]!) / cell)), nz = Math.max(1, Math.ceil((mx[2]! - mn[2]!) / cell));
  const low = tris.filter((t) => Math.min(t.a[1]!, t.b[1]!, t.c[1]!) <= ref + band + 0.01 && Math.max(t.a[1]!, t.b[1]!, t.c[1]!) > y0);
  const grid = new Map<number, number>();
  for (let i = 0; i < nx; i++) for (let j = 0; j < nz; j++) { const x = mn[0]! + (i + 0.5) * cell, z = mn[2]! + (j + 0.5) * cell, h = upHit(low, x, y0, z); if (h <= ref + band) grid.set(i * 100000 + j, h); }
  if (!grid.size) return null;
  const cells: [number, number, number][] = [], perimeter: [number, number, number][] = [];
  for (const [k, h] of grid) { const i = Math.floor(k / 100000), j = k % 100000, q: [number, number, number] = [mn[0]! + (i + 0.5) * cell, mn[2]! + (j + 0.5) * cell, h];
    cells.push(q); if ([[1, 0], [-1, 0], [0, 1], [0, -1]].some(([di, dj]) => !grid.has((i + di!) * 100000 + j + dj!))) perimeter.push(q); }
  const area = new Map<string, number>();
  for (const t of tris) { if (!t.material || Math.min(t.a[1]!, t.b[1]!, t.c[1]!) > ref + 1 || Math.max(t.a[1]!, t.b[1]!, t.c[1]!) < y0) continue; const ux = [t.b[0]! - t.a[0]!, t.b[1]! - t.a[1]!, t.b[2]! - t.a[2]!], vx = [t.c[0]! - t.a[0]!, t.c[1]! - t.a[1]!, t.c[2]! - t.a[2]!];
    const ar = Math.hypot(ux[1]! * vx[2]! - ux[2]! * vx[1]!, ux[2]! * vx[0]! - ux[0]! * vx[2]!, ux[0]! * vx[1]! - ux[1]! * vx[0]!) / 2; area.set(t.material, (area.get(t.material) ?? 0) + ar); }
  const material = [...area].sort((x, y) => y[1] - x[1])[0]?.[0];
  return { cells, perimeter, extent: [Math.round((mx[0]! - mn[0]!) * 100) / 100, Math.round((mx[2]! - mn[2]!) * 100) / 100], fill: Math.round(Math.min(1, (cells.length * cell * cell) / Math.max(1e-6, (mx[0]! - mn[0]!) * (mx[2]! - mn[2]!))) * 100) / 100, ...(material ? { material } : {}) };
}
/** A unit quaternion [x, y, z, w] (three.js order). */
export type Quat = [number, number, number, number];
export const qMul = (a: Quat, b: Quat): Quat => [a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1], a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0], a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3], a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2]];
export const qRotate = (q: Quat, v: [number, number, number]): [number, number, number] => { const [x, y, z, w] = q, ix = w * v[0] + y * v[2] - z * v[1], iy = w * v[1] + z * v[0] - x * v[2], iz = w * v[2] + x * v[1] - y * v[0], iw = -x * v[0] - y * v[1] - z * v[2];
  return [ix * w + iw * -x + iy * -z - iz * -y, iy * w + iw * -y + iz * -x - ix * -z, iz * w + iw * -z + ix * -y - iy * -x]; };
/** LEAN (KNUCKLECROWN 2026-10-29: nine finger-pillars stood upright because a layout gave yaw only): the rotation of a piece
 *  turned `yaw` radians about +Y, then tipped `leanDeg` so its +Y leans toward the world XZ direction `dir` (radians,
 *  atan2(dx, dz): 0 = +Z). Pure yaw when leanDeg is 0. */
export function leanQuat(yaw: number, leanDeg: number, dir: number): Quat {
  const qy: Quat = [0, Math.sin(yaw / 2), 0, Math.cos(yaw / 2)]; if (!leanDeg) return qy;
  const ux = Math.sin(dir), uz = Math.cos(dir), h = (leanDeg * Math.PI) / 360, s = Math.sin(h); // axis (uz, 0, -ux) tips +Y toward u
  return qMul([uz * s, 0, -ux * s, Math.cos(h)], qy);
}
/** A base outline turned by a full rotation into world axes (yaw 0): each cell [x, z, y] rotated in 3D, so a LEANED piece's
 *  raised uphill edge and sunk downhill edge are what the seat and the seated gate measure. */
export function orientBase(b: BaseOutline, q: Quat): BaseOutline {
  const t = (c: [number, number, number]): [number, number, number] => { const v = qRotate(q, [c[0], c[2], c[1]]); return [v[0], v[2], v[1]]; };
  const cells = b.cells.map(t), xs = cells.map((c) => c[0]), zs = cells.map((c) => c[1]);
  return { ...b, cells, perimeter: b.perimeter.map(t), extent: [Math.round((Math.max(...xs) - Math.min(...xs)) * 100) / 100, Math.round((Math.max(...zs) - Math.min(...zs)) * 100) / 100] };
}
/** True when a rotation is more than a yaw (a leaned piece): its x or z component is not ~0. */
export const isLeaned = (q: number[]) => Math.abs(q[0] ?? 0) > 1e-4 || Math.abs(q[2] ?? 0) > 1e-4;
/** Local (x, z) of the root frame -> world, for a structure at `at` turned `yaw` radians about +Y (three.js rotation). */
export const toWorldYaw = (at: V2, yaw: number, x: number, z: number): V2 => [at[0] + x * Math.cos(yaw) + z * Math.sin(yaw), at[1] - x * Math.sin(yaw) + z * Math.cos(yaw)];
/** Ground fall (m) under a base above which a stone skirt runs round it too (below it the raised ground alone seats it). */
export const SKIRT_RELIEF_M = 1;
/** Ground fall (m) under which a piece that is not a dwelling is sunk to its lowest ground instead of raised. */
export const SINK_MAX_M = 0.6;
/** The longest side (m) from which an open or legged piece on a fall is seated on levelled ground (smaller ones: a table, a cart, are sunk). */
export const LEVEL_MIN_EXTENT_M = 6;
/** Raised foundations: metres the raised ground stands over the base's top cell, and its level plateau past the base. */
export const RAISE_OVER_M = 0.1, RAISE_PAST_M = 1.5;
export interface Seat { y: number; relief: number; lowest: number; skirt: V2[] | null; sunk: boolean;
  /** The ground raised under the base (raised foundations): a level, raise-only patch at `y` (the base's top cell level
   *  - 0.02) over `radius` round the structure. Null when the ground already holds it within SEAT_GAP_M. */
  raise: { y: number; radius: number } | null;
  /** The ground under the base is LEVELLED to `raise.y` (cut and fill, not raise-only): an open-court ruin on a fall. */
  level?: boolean;
  /** The levelled ground's rectangle in the piece's own frame (centre, half sizes; turned with it): `level` only. */
  rect?: { centre: [number, number]; half: [number, number] } }
/** Where a structure's root goes (y) on `ground`, and whether it needs a skirt: a built piece sits on the HIGHEST ground
 *  under its base (nothing buries its floor) and, when its outline then stands more than SEAT_GAP_M clear anywhere, a
 *  the ground under it is raised to its base (`raise`) and, past SKIRT_RELIEF_M of fall, a skirt also runs round its outline (the convex hull of the perimeter cells, world XZ, closed) down into the ground. A rock or
 *  a piece under SKIRT_MIN_EXTENT_M or on legs (fill < SKIRT_MIN_FILL) is SUNK instead to its outline's lowest ground (rocks a further 0.2 m). */
export function seatStructure(base: BaseOutline, at: V2, yaw: number, ground: (x: number, z: number) => number, opts: { rock?: boolean; sinkMax?: number } = {}): Seat {
  const r2_ = (n: number) => Math.round(n * 100) / 100;
  const per = base.perimeter.map(([x, z, yb]) => { const w = toWorldYaw(at, yaw, x, z); return { w, need: ground(w[0], w[1]) - yb }; });
  const all = base.cells.map(([x, z, yb]) => { const w = toWorldYaw(at, yaw, x, z); return ground(w[0], w[1]) - yb; });
  const hi = Math.max(...all), lo = Math.min(...per.map((p) => p.need)), relief = r2_(hi - lo);
  // L (Red Dial 2026-10-30: open-court ruins (fill < SKIRT_MIN_FILL) on 1.5-4.4 m of fall were sunk to their lowest ground,
  // their uphill walls buried to the coping, then raised by the build's backfill and standing 0.4-3.5 m clear): a wide piece
  // on legs or an open court past `sinkMax` of fall stands at the middle of its fall on LEVELLED ground (cut + fill, `level`)
  if (!opts.rock && Math.max(...base.extent) >= LEVEL_MIN_EXTENT_M && Math.min(...base.extent) >= SKIRT_MIN_EXTENT_M && base.fill < SKIRT_MIN_FILL && relief > (opts.sinkMax ?? 0)) {
    const y = r2_((hi + lo) / 2);
    // the levelled ground stands 3 cm under the base's highest OUTLINE cell (the seated gate's measure; a declared footing
    // below it goes into the ground; a floor slab on ground at its top cell z-fought it, arcade-court)
    // over the base's own turned rectangle (a disc round a 24 m wall cut under the plinth beside it), RAISE_PAST_M past it:
    // L (o-small2 dropped-hour 2026-10-30: at +0.5 m the filtered 2 m patch lattice sagged, the hide lodge stood 0.062 m clear)
    const xs = base.cells.map((c) => c[0]), zs = base.cells.map((c) => c[1]);
    return { y, relief, lowest: r2_(lo), skirt: null, sunk: false, level: true, raise: { y: r2_(y + Math.max(...base.perimeter.map((c) => c[2])) - 0.03), radius: r2_(Math.max(...base.cells.map(([x, z]) => Math.hypot(x, z))) + RAISE_PAST_M) },
      rect: { centre: [r2_((Math.max(...xs) + Math.min(...xs)) / 2), r2_((Math.max(...zs) + Math.min(...zs)) / 2)], half: [r2_((Math.max(...xs) - Math.min(...xs)) / 2 + RAISE_PAST_M), r2_((Math.max(...zs) - Math.min(...zs)) / 2 + RAISE_PAST_M)] } };
  }
  if (opts.rock || Math.min(...base.extent) < SKIRT_MIN_EXTENT_M || base.fill < SKIRT_MIN_FILL) return { y: r2_(lo - (opts.rock ? 0.2 : 0)), relief, lowest: r2_(lo), skirt: null, sunk: true, raise: null };
  if (relief <= SEAT_GAP_M) return { y: r2_(hi), relief, lowest: r2_(lo), skirt: null, sunk: false, raise: null };
  // L (art, signal-tower 2026-10-21: the raised patch round a ruin took the cliff paint and failed the ground texel rule):
  // a piece nobody walks into (not a dwelling) on a small fall is SUNK to its outline's lowest ground: its uphill side
  // stands up to `sinkMax` m in the ground, rooted, with no terrain edit
  if (relief <= (opts.sinkMax ?? 0)) return { y: r2_(lo), relief, lowest: r2_(lo), skirt: null, sunk: true, raise: null };
  // L (seated, signal-tower: the hollow tower's INNER outline stood 0.28 m clear even inside a skirt): the ground under the
  // whole base is raised to it (raised foundations), so no face of it, inside or out, shows daylight
  // L (zfight, signal-tower: ground raised to 2 cm under the floor z-fought it, 1.5 m2; the 2 m patch lattice is filtered, so
  // a plateau only 0.5 m past the base sagged 7 cm at its edge): the ground comes up RAISE_OVER_M over the base's top cell
  // (the base stands rooted in it) on a plateau RAISE_PAST_M past the base
  const raise = { y: r2_(hi + Math.max(...base.cells.map((c) => c[2])) + RAISE_OVER_M), radius: r2_(Math.max(...base.cells.map(([x, z]) => Math.hypot(x, z))) + RAISE_PAST_M) };
  if (relief <= SKIRT_RELIEF_M) return { y: r2_(hi), relief, lowest: r2_(lo), skirt: null, sunk: false, raise };
  const h = hullXZ(per.map((p) => p.w)), out: V2[] = [];
  for (const q of h) if (!out.length || Math.hypot(q[0] - out[out.length - 1]![0], q[1] - out[out.length - 1]![1]) >= 0.8) out.push([r2_(q[0]), r2_(q[1])]);
  if (out.length >= 3) out.push(out[0]!);
  return { y: r2_(hi), relief, lowest: r2_(lo), skirt: out.length >= 4 ? out : null, sunk: false, raise };
}
function hullXZ(points: V2[]): V2[] {
  const p = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1]), cr = (o: V2, a: V2, b: V2) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lo: V2[] = [], up: V2[] = [];
  for (const q of p) { while (lo.length >= 2 && cr(lo[lo.length - 2]!, lo[lo.length - 1]!, q) <= 0) lo.pop(); lo.push(q); }
  for (const q of p.reverse()) { while (up.length >= 2 && cr(up[up.length - 2]!, up[up.length - 1]!, q) <= 0) up.pop(); up.push(q); }
  return [...lo.slice(0, -1), ...up.slice(0, -1)];
}
/** The SEATED gate's measure: the most daylight (m) between a placed structure's base outline and the ground, along the
 *  outline; a stretch along a skirt (within `reach` of its line, its top at `top`) counts from the skirt's top. */
export function seatGap(base: BaseOutline, at: V2, y: number, yaw: number, ground: (x: number, z: number) => number, skirt?: { hull: V2[]; top: number; reach: number } | null) {
  let worst = -Infinity, where: V2 = at;
  const near = (q: V2) => { if (!skirt) return false; for (let i = 0; i + 1 < skirt.hull.length; i++) { const a = skirt.hull[i]!, b = skirt.hull[i + 1]!, dx = b[0] - a[0], dz = b[1] - a[1], L = dx * dx + dz * dz || 1, t = Math.max(0, Math.min(1, ((q[0] - a[0]) * dx + (q[1] - a[1]) * dz) / L)); if (Math.hypot(q[0] - a[0] - t * dx, q[1] - a[1] - t * dz) <= skirt.reach) return true; } return false; };
  for (const [x, z, yb] of base.perimeter) { const w = toWorldYaw(at, yaw, x, z), under = near(w) ? Math.max(ground(w[0], w[1]), skirt!.top) : ground(w[0], w[1]), gap = y + yb - under; if (gap > worst) { worst = gap; where = w; } }
  return { gap: Math.round(worst * 1000) / 1000, at: [Math.round(where[0] * 10) / 10, Math.round(where[1] * 10) / 10] as V2 };
}

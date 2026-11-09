/**
 * PLACE QUALITY — the measured floors a place-build place must clear (Hagsheer 2026-10-21: the 28 installed places were
 * small 16-30 m patches, a handful of props on open grass, walls in the terrain cliff tile and nothing that read from
 * 300 m). Pure (no fs): place-build `plan` applies the floors, the `place` check gates the read, `quality` grades the
 * installed places of a zone on four lines (core footprint, prop density, built surface, the 300 m read).
 */
import { walkGroundOf } from "./_ground.mts";
type V2 = [number, number];
const dist =(a: V2, b: V2) => Math.hypot(a[0] - b[0], a[1] - b[1]);
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
/** L (Derek 2026-10-31, Rustblood hive: "floating pillars" over the burrow mouths): the heightfield runs straight over a
 *  carved cave mouth, so a piece standing on the lip measured seated. The walked ground sees the HOLE: it is the ONE
 *  ground source of every placer and gate (tools/_ground.mts walkGroundOf, t-ground 2026-10-31). */
export const holeAwareHeight = walkGroundOf;
/** NO SILENT SKIPS (t-ground 2026-10-31; Red Dial: 90 of 123 pieces passed seated unmeasured): why the seated gate hands
 *  a placed piece to the float gate instead of measuring its base, or null when seated measures it. Every piece is a row
 *  either way; a piece seated cannot measure is a FAULT, never an exclusion. */
export function seatedExclusion(tags: readonly string[], hung: string | null = null): string | null {
  const slot = tags.find((t) => t.startsWith("slot:"))?.slice(5), on = tags.find((t) => t.startsWith("on:"));
  if (on) return `stands on ${on.slice(3)} (float judges it on its support)`;
  if (slot === "fire" || slot === "boat" || slot === "ring") return `slot ${slot} (float judges it)`;
  if (hung) return `${hung}-mounted: not seated on the ground (float judges its hold)`;
  return null;
}
/** The seated report's count line: every row is judged or excluded; a fault is a row with `fault` or ok === false. */
export function seatedCounts(rows: readonly { excluded?: string; fault?: string; ok?: boolean }[]) {
  const excluded = rows.filter((r) => r.excluded).length, faults = rows.filter((r) => r.fault || r.ok === false).length;
  return { pieces: rows.length, judged: rows.length - excluded, excluded, faults };
}
export function baseOutline(tris: Tri3[], cell = 0.5, band = 0.35): BaseOutline | null {
  // L (o-gates 2026-10-30, "floating ruins"): a solid with a BURIED footing (its bottom 0.6 m under the origin) has no face
  // in the -0.3 m band, so the outline came back empty and the seated gate let it through as "no base outline": then the
  // outline is cut at the mesh's own bottom
  return outlineAt(tris, cell, band, false) ?? outlineAt(tris, cell, band, true) ?? feetOutline(tris, cell, band);
}
/** L (o-smalls 2026-10-31, Redcup's weapon rack and lean-to): a piece standing on thin legs or poles slips between the 0.5 m
 *  upward rays, so neither cut finds a face and the seated gate charged "no base outline". Its FEET are then the outline:
 *  the vertices within `band` of the mesh's bottom, one point per cell (the lowest), every point on the perimeter. */
function feetOutline(tris: Tri3[], cell: number, band: number): BaseOutline | null {
  if (!tris.length) return null;
  let lo = Infinity; const mn = [Infinity, Infinity], mx = [-Infinity, -Infinity];
  for (const t of tris) for (const p of [t.a, t.b, t.c]) { lo = Math.min(lo, p[1]!); mn[0] = Math.min(mn[0]!, p[0]!); mx[0] = Math.max(mx[0]!, p[0]!); mn[1] = Math.min(mn[1]!, p[2]!); mx[1] = Math.max(mx[1]!, p[2]!); }
  const feet = new Map<string, [number, number, number]>(), area = new Map<string, number>();
  for (const t of tris) for (const p of [t.a, t.b, t.c]) {
    if (p[1]! > lo + band) continue;
    const k = `${Math.floor(p[0]! / cell)},${Math.floor(p[2]! / cell)}`, q = feet.get(k);
    if (!q || p[1]! < q[2]) feet.set(k, [p[0]!, p[2]!, p[1]!]);
    if (t.material) area.set(t.material, (area.get(t.material) ?? 0) + 1);
  }
  if (!feet.size) return null;
  const cells = [...feet.values()], material = [...area].sort((x, y) => y[1] - x[1])[0]?.[0];
  return { cells, perimeter: cells, extent: [Math.round((mx[0]! - mn[0]!) * 100) / 100, Math.round((mx[1]! - mn[1]!) * 100) / 100], fill: 0, ...(material ? { material } : {}) } as BaseOutline;
}
function outlineAt(tris: Tri3[], cell: number, band: number, deep: boolean): BaseOutline | null {
  if (!tris.length) return null;
  const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
  for (const t of tris) for (const p of [t.a, t.b, t.c]) for (let k = 0; k < 3; k++) { mn[k] = Math.min(mn[k]!, p[k]!); mx[k] = Math.max(mx[k]!, p[k]!); }
  const ref = deep || mn[1]! >= -0.3 ? mn[1]! : -0.3, y0 = ref > mn[1]! ? ref : mn[1]! - 1;
  const nx = Math.max(1, Math.ceil((mx[0]! - mn[0]!) / cell)), nz = Math.max(1, Math.ceil((mx[2]! - mn[2]!) / cell));
  const low = tris.filter((t) => Math.min(t.a[1]!, t.b[1]!, t.c[1]!) <= ref + band + 0.01 && Math.max(t.a[1]!, t.b[1]!, t.c[1]!) > y0);
  // L (o-wild3 2026-11-02: a bone heap, a bone pile, a gut trough, a hide roll and a curled corpse sat 0.23-0.41 m UNDER flat
  // ground and both seated and float passed them): a cell's bottom was the upward ray's hit at the cell CENTRE only. An open
  // skin (a heap with no bottom face, a rounded roll) is hit there 0.1-0.35 m up its slope while the mesh meets the ground
  // at its rim inside the same cell, so the re-seat sank the piece by that much to "close" daylight nobody can see. A cell's
  // bottom is the lowest of the centre hit and the lowest vertex of the low triangles inside the cell
  const rim = new Map<number, number>();
  for (const t of low) for (const p of [t.a, t.b, t.c]) {
    if (p[1]! <= y0) continue;
    const i = Math.min(nx - 1, Math.max(0, Math.floor((p[0]! - mn[0]!) / cell))), j = Math.min(nz - 1, Math.max(0, Math.floor((p[2]! - mn[2]!) / cell))), k = i * 100000 + j;
    if (!(rim.get(k)! <= p[1]!)) rim.set(k, p[1]!);
  }
  const grid = new Map<number, number>();
  for (let i = 0; i < nx; i++) for (let j = 0; j < nz; j++) { const x = mn[0]! + (i + 0.5) * cell, z = mn[2]! + (j + 0.5) * cell, k = i * 100000 + j, hit = upHit(low, x, y0, z), h = Math.min(hit, rim.get(k) ?? Infinity); if (Number.isFinite(hit) && h <= ref + band) grid.set(k, h); }
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
/** L (r1 2026-10-31, Drinking Stone: a cage floor, bedrolls, a trough and log seats lying exactly on flat ground z-fought it; a
 *  layout `lift` only moved the coplanar face): the lab re-seat holds every ground-seated piece at least this far under the
 *  LOWEST ground of its box, so a flat bottom hides under the ground (zfight judges faces within 0.02 m; float reads burial only from 0.3 m up). */
export const FLUSH_SINK_M = 0.07;
/** A piece at most this tall (m, scaled) is THIN: the lab re-seat never buries it past half its height at its high side. */
export const THIN_PIECE_M = 0.45;
/** L (r1b 2026-10-31, Drinking Stone: a bedroll is layered, up faces at ~0.045 and ~0.105 m; held level on ground that
 *  varies 2-7 cm under it, one layer always crossed the ground and z-fought it at every sink depth): a THIN GROUND PROP is
 *  TILTED to the plane fitted to the ground under its footprint and seated so the ground runs clear of every up-facing
 *  layer (thinTiltSeat). Thin = at most THIN_TILT_M tall, or at most THIN_PIECE_M tall with up-facing layers under
 *  THIN_TILT_M covering THIN_LAYER_SHARE of its footprint (a bedroll with its rolled pillow, a rug, a mat, a hide, a pallet). */
export const THIN_TILT_M = 0.15, THIN_LAYER_SHARE = 0.6, THIN_TILT_MAX_DEG = 20;
/** The zfight gate's gap (thresholds.json zfight.maxGap 0.02) plus a margin: the ground and an up-facing layer stay this far apart. */
export const THIN_CLEAR_M = 0.025;
export interface UpFace { h: number; area: number }
/** A prefab's up-facing layers (root frame): area per 5 mm of height, faces within ~18 deg of +Y, at least `minArea` m2. */
export function upFaces(tris: Tri3[], minArea = 0.005): UpFace[] {
  const by = new Map<number, number>();
  for (const t of tris) {
    const u = [t.b[0]! - t.a[0]!, t.b[1]! - t.a[1]!, t.b[2]! - t.a[2]!], v = [t.c[0]! - t.a[0]!, t.c[1]! - t.a[1]!, t.c[2]! - t.a[2]!];
    const n = [u[1]! * v[2]! - u[2]! * v[1]!, u[2]! * v[0]! - u[0]! * v[2]!, u[0]! * v[1]! - u[1]! * v[0]!], L = Math.hypot(n[0]!, n[1]!, n[2]!);
    if (!(L > 0) || n[1]! / L < 0.95) continue;
    const k = Math.round(((t.a[1]! + t.b[1]! + t.c[1]!) / 3) * 200);
    by.set(k, (by.get(k) ?? 0) + L / 2);
  }
  return [...by].filter(([, a]) => a >= minArea).map(([k, a]) => ({ h: k / 200, area: Math.round(a * 1e4) / 1e4 })).sort((x, y) => x.h - y.h);
}
/** True for a THIN GROUND PROP (see THIN_TILT_M): `hgt` and `faces` scaled, `footprint` = its plan area in m2. */
export function isThinGroundProp(hgt: number, faces: UpFace[], footprint: number): boolean {
  if (hgt <= THIN_TILT_M) return true;
  if (hgt > THIN_PIECE_M || !(footprint > 0)) return false;
  return faces.filter((f) => f.h <= THIN_TILT_M).reduce((t, f) => t + f.area, 0) >= THIN_LAYER_SHARE * footprint;
}
/** L (r1b 2026-10-31, Drinking Stone: a trough's floor at 0.275 m, a cage's floor plate at 0.075 m and a rack's base board
 *  at 0.08 m z-fought the ground: a level piece on a fall has the ground crossing every low layer somewhere): a piece with a
 *  broad up-facing layer (>= PLATE_MIN_AREA_M2, the zfight gate's fail area) within PLATE_BAND_M of its bottom is seated
 *  like a thin prop too, its tilt capped at PLATE_TILT_MAX_DEG (a cage or a rack leans with the ground, never past that). */
export const PLATE_BAND_M = 0.3, PLATE_MIN_AREA_M2 = 0.05, PLATE_TILT_MAX_DEG = 8;
/** A piece taller than this is never plate-seated: a tower or a house with a low step would lean with the ground (o-fix2
 *  2026-11-03: the 16 m sun-lamp-tower leaned 1.3 deg at Tide Chapel on its door step); it keeps the level sink and its foundation. */
export const PLATE_MAX_HEIGHT_M = 4;
/** How a ground-seated piece is seated by its plane (thinTiltSeat): "thin" (THIN_TILT_MAX_DEG), "plate" (PLATE_TILT_MAX_DEG), or null (the level sink).
 *  Only a piece that stands on a FLAT bottom at its mesh's foot (base outline cells within FLAT_BASE_M of each other and of
 *  0): a round log, a heap or a piece whose outline is its raised body (legs between the rays) keeps the level sink, which
 *  reads its outline cell by cell (base = the base outline's cell bottoms, scaled; none = not plane-seated). */
export const FLAT_BASE_M = 0.05;
export function planeSeatKind(hgt: number, faces: UpFace[], footprint: number, base?: number[]): "thin" | "plate" | null {
  if (!base?.length || Math.max(...base) > FLAT_BASE_M || Math.max(...base) - Math.min(...base) > FLAT_BASE_M) return null;
  if (isThinGroundProp(hgt, faces, footprint)) return "thin";
  if (hgt > PLATE_MAX_HEIGHT_M) return null;
  return faces.some((f) => f.h <= PLATE_BAND_M && f.area >= PLATE_MIN_AREA_M2) ? "plate" : null;
}
/** The tilt that turns +Y onto the normal of a ground plane of gradient (gx, gz) = (dh/dx, dh/dz), capped at `maxDeg`. */
export function slopeQuat(gx: number, gz: number, maxDeg = THIN_TILT_MAX_DEG): Quat {
  const s = Math.hypot(gx, gz); if (!(s > 1e-6)) return [0, 0, 0, 1];
  const ang = Math.min(Math.atan(s), (maxDeg * Math.PI) / 180), ax = -gz / s, az = gx / s, h = Math.sin(ang / 2); // axis (nz, 0, -nx) for n ~ (-gx, 1, -gz)
  return [ax * h, 0, az * h, Math.cos(ang / 2)];
}
/** Where the ground runs in a thin piece's own frame (m above its bottom): the level G whose ground band [G + a, G + b]
 *  (a <= 0 <= b: the ground's spread about the fitted plane) stays furthest from every up-facing layer (clearance saturating
 *  at THIN_CLEAR_M + 0.01, ties going deeper, never past FLUSH_SINK_M), with no daylight at its low point (G >= -a) and
 *  never buried past half its height (G + b <= hgt / 2). Bumpier than that: G = -a. */
export function thinGroundLevel(faces: UpFace[], hgt: number, a: number, b: number): { level: number; clear: number } {
  const clearAt = (G: number) => faces.reduce((m, f) => Math.min(m, f.h < G + a ? G + a - f.h : f.h > G + b ? f.h - G - b : 0), Infinity);
  const lo = -a, hi = Math.min(Math.max(lo, hgt / 2 - b), Math.max(lo, FLUSH_SINK_M)), cap = THIN_CLEAR_M + 0.01;
  let best = lo, bestS = -1;
  for (let G = lo; G <= hi + 1e-9; G += 0.0025) { const s = Math.min(clearAt(G), cap); if (s > bestS + 1e-9 || (Math.abs(s - bestS) <= 1e-9 && s >= cap - 1e-9)) { best = G; bestS = s; } }
  return { level: Math.round(best * 1e4) / 1e4, clear: Math.round(clearAt(best) * 1e4) / 1e4 };
}
/** THE THIN-PROP SEAT: a thin ground prop at `at` (its foot), turned `yaw`, footprint half-extents `half`, height `hgt`,
 *  up-facing layers `faces` (all scaled), on `ground` (the DRAWN ground: the faces it could fight). Fits a plane to the
 *  ground under its footprint (samples <= `step` m apart), tilts it to that plane (rotation = tilt * yaw) and puts its
 *  origin so the ground runs at thinGroundLevel in its frame. */
export function thinTiltSeat(ground: (x: number, z: number) => number, at: V2, yaw: number, half: V2, hgt: number, faces: UpFace[], step = 0.25, maxDeg = THIN_TILT_MAX_DEG): { rotation: Quat; y: number; level: number; clear: number; slopeDeg: number; spread: number } {
  const nx = Math.max(2, Math.ceil((2 * half[0]) / step) + 1), nz = Math.max(2, Math.ceil((2 * half[1]) / step) + 1), pts: [number, number, number][] = [];
  for (let i = 0; i < nx; i++) for (let j = 0; j < nz; j++) { const w = toWorldYaw(at, yaw, -half[0] + (2 * half[0] * i) / (nx - 1), -half[1] + (2 * half[1] * j) / (nz - 1)); pts.push([w[0] - at[0], w[1] - at[1], ground(w[0], w[1])]); }
  // least squares h = c + gx dx + gz dz (normal equations, centred on the foot)
  let sx = 0, sz = 0, sxx = 0, szz = 0, sxz = 0, sh = 0, sxh = 0, szh = 0; const n = pts.length;
  for (const [x, z, h] of pts) { sx += x; sz += z; sxx += x * x; szz += z * z; sxz += x * z; sh += h; sxh += x * h; szh += z * h; }
  const mx = sx / n, mz = sz / n, mh = sh / n, cxx = sxx / n - mx * mx, czz = szz / n - mz * mz, cxz = sxz / n - mx * mz, cxh = sxh / n - mx * mh, czh = szh / n - mz * mh, det = cxx * czz - cxz * cxz;
  let gx = Math.abs(det) > 1e-12 ? (cxh * czz - czh * cxz) / det : 0, gz = Math.abs(det) > 1e-12 ? (czh * cxx - cxh * cxz) / det : 0;
  const s = Math.hypot(gx, gz), smax = Math.tan((maxDeg * Math.PI) / 180); if (s > smax) { gx *= smax / s; gz *= smax / s; }
  const c = mh - gx * mx - gz * mz, r = pts.map(([x, z, h]) => h - (c + gx * x + gz * z)).sort((p, q) => p - q), med = r[Math.floor(r.length / 2)]!;
  const lv = thinGroundLevel(faces, hgt, r[0]! - med, r[r.length - 1]! - med);
  const rotation = qMul(slopeQuat(gx, gz, maxDeg), [0, Math.sin(yaw / 2), 0, Math.cos(yaw / 2)]).map((v) => Math.round(v * 1e6) / 1e6) as Quat;
  return { rotation, y: Math.round((c + med - lv.level) * 1000) / 1000, level: lv.level, clear: lv.clear, slopeDeg: Math.round((Math.atan(Math.hypot(gx, gz)) * 1800) / Math.PI) / 10, spread: Math.round((r[r.length - 1]! - r[0]!) * 1000) / 1000 };
}
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
/**
 * The SOLVER's raise output (coordinator 2026-10-30): a solver-founded base the legacy seat would raise the ground to (a
 * closed base over a fall: houses, yards, slabs, towers: their doors, area goals and routes meet it) gets a level,
 * raise-only, feathered pad at the SOLVER's height, so the walker steps onto it instead of meeting a foundation wall; the
 * feather (3 x the fall, at least 4 m) is the ramp. Its level:
 *   - a piece with a floor (grade > 0): 5 cm under its floor slab (the slab, never the pad, is the floor face; the kit's
 *     entry steps climb the rest);
 *   - an open piece: the legacy offset over its base (its top base cell + RAISE_OVER_M) at the solver's height;
 * kept 3 cm off every flat face of its own (sunk in 6 cm steps). Null: no raise (the legacy seat would not raise either).
 */
export function solverRaise(legacySeat: Seat | null, sy: number, grade: number, flats: number[] = []): { y: number; radius: number; feather: number } | null {
  if (!legacySeat?.raise) return null;
  let y = grade > 0 ? sy - grade - 0.05 : sy + (legacySeat.raise.y - legacySeat.y);
  for (let k = 0; k < 3 && flats.some((f) => Math.abs(sy + f - y) < 0.03); k++) y -= 0.06;
  return { y: Math.round(y * 1000) / 1000, radius: legacySeat.raise.radius, feather: Math.max(4, 3 * legacySeat.relief) };
}

/** How far below its base OUTLINE the seated gate measures a piece (its declared footing meets the ground there): a SOLVER
 *  piece and a legacy-seated piece with a declared foundation (tag `found`, with or without its held box: r-found 2026-10-31,
 *  three floored houses read 0.28-0.41 m "clear" at their floor outline while their 3.2 m footing storey stood in the ground).
 *  `footing` scaled metres; `outlineMin` the outline's lowest cell (scaled, <= 0; null = none): an outline already cut at
 *  the mesh's own bottom measures the footing itself, never taken off twice (a wall run passed 0.6 m too low). Others: 0. Pure. */
export function measuredFooting(tags: readonly string[], footing: number, outlineMin: number | null): number {
  if (!tags.includes("solver") && !tags.includes("found")) return 0;
  const cut = outlineMin !== null ? Math.max(0.3, -outlineMin) : 0.3;
  return Math.max(0, footing - cut);
}

/** The LEGACY raise pad's level under a FLOORED piece (placeRule grade > 0: a WFC house; r-found 2026-10-31): 0.1 m under its
 *  footing band's top, i.e. `grade` - 0.1 under the floor slab at `sy` (the layout `lift` included), kept 3 cm off its own
 *  flats. The plain raise (top base cell + 0.1) left a lifted house's door sills 0.48 m over the pad: door steps, which then
 *  z-fought the shells. Pure. */
export function floorPadY(sy: number, grade: number, flats: number[] = []): number {
  let y = sy - grade + 0.1;
  for (let k = 0; k < 3 && flats.some((f) => Math.abs(sy + f - y) < 0.03); k++) y -= 0.06;
  return Math.round(y * 1000) / 1000;
}

/** Whether the placement solver seats a piece (`--solver`): only where the legacy seat would need a skirt or a raised
 *  pad (a closed base over a real fall). Never a base it LEVELS (a wide open court: cut + fill) or SINKS to its lowest
 *  ground (an open yard or slab, a rock, a small fall): walk goals stand on those at the route's height, and a solver
 *  foundation would stand them up on the high side behind a wall the walker cannot climb (coordinator 2026-10-30, Red
 *  Dial walk MISS 1.38 m / STUCK at the tower-compound yards). */
export function solverSeats(legacySeat: { level?: boolean; sunk?: boolean } | null): boolean { return !legacySeat?.level && !legacySeat?.sunk; }

/** FOUNDATION SKIRTS ON THE LEGACY SEAT (r-found 2026-10-30, Derek: "a lot of the ruins are still hovering ... a
 *  foundational box, even a box down into the ground textured like the brick"): on the default (legacy) seat, a piece
 *  whose catalogue `placeRule` declares a `foundation` is seated by the placement solver at its layout spot (no move, no
 *  turn) and gets the solver's foundation skirt down to its lowest ground + `depth`, with NO raise pad (the raise pads are
 *  what regressed walk under `--solver`). Where the legacy seat would raise or skirt it, and where it would SINK a closed
 *  piece (a wall run, a pillar: thin, so legacy buried its uphill end metres deep). Never where the legacy seat LEVELS an
 *  open court (cut + fill: walk goals stand on it) or sinks an open / legged base (fill < SKIRT_MIN_FILL), never a bedded
 *  piece (sunk on purpose), and never on ground the legacy seat already holds within SEAT_GAP_M.
 *  L (r-found 2026-10-31): a FLOORED building (placeRule grade > 0: a WFC house whose doors open at its floor) keeps the
 *  legacy raised ground its doors open onto: founded, its low-side doors stood 2.3-4.3 m up (walk FALL at 8 doors) and the
 *  3.4 m door flight on a 2 m fall did not bake (reach FAULT). The houses were never among the hovering pieces. A
 *  levelled HOUSE STUMP (a ruin dwelling with no floor: nobody walks through it) is founded instead of levelled (the
 *  levelling pad under a 4.8 m fall failed the art ground texel), `dwelling`. Pure. */
export function legacyFounds(legacySeat: Seat | null, base: BaseOutline | null, rule: { foundation?: unknown; grade?: number; openings?: { kind: string }[] } | null | undefined, bedded = false, dwelling = false): boolean {
  if (!rule?.foundation || !legacySeat || !base || bedded) return false;
  if ((rule.grade ?? 0) > 0) return false;
  // a GATE (placeRule opening kind gate) is walked through: its passage keeps the legacy seat (r-found 2026-10-31: west-street STUCK)
  if ((rule.openings ?? []).some((o) => o.kind === "gate")) return false;
  if ((legacySeat.level && !dwelling) || legacySeat.relief <= SEAT_GAP_M) return false;
  if (legacySeat.sunk && base.fill < SKIRT_MIN_FILL) return false;
  return true;
}

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
export function seatGap(base: BaseOutline, at: V2, y: number, yaw: number, ground: (x: number, z: number) => number, skirt?: { hull: V2[]; top: number; reach: number; solid?: boolean } | null) {
  let worst = -Infinity, where: V2 = at;
  // a SOLID skirt (the placement solver's foundation: a filled box, its hull closed) covers every point inside it too
  const inside = (q: V2) => { const h = skirt!.hull; let c = false; for (let i = 0, j = h.length - 1; i < h.length; j = i++) { const a = h[i]!, b = h[j]!; if ((a[1] > q[1]) !== (b[1] > q[1]) && q[0] < ((b[0] - a[0]) * (q[1] - a[1])) / (b[1] - a[1]) + a[0]) c = !c; } return c; };
  const near = (q: V2) => { if (!skirt) return false; if (skirt.solid && inside(q)) return true; for (let i = 0; i + 1 < skirt.hull.length; i++) { const a = skirt.hull[i]!, b = skirt.hull[i + 1]!, dx = b[0] - a[0], dz = b[1] - a[1], L = dx * dx + dz * dz || 1, t = Math.max(0, Math.min(1, ((q[0] - a[0]) * dx + (q[1] - a[1]) * dz) / L)); if (Math.hypot(q[0] - a[0] - t * dx, q[1] - a[1] - t * dz) <= skirt.reach) return true; } return false; };
  for (const [x, z, yb] of base.perimeter) { const w = toWorldYaw(at, yaw, x, z), under = near(w) ? Math.max(ground(w[0], w[1]), skirt!.top) : ground(w[0], w[1]), gap = y + yb - under; if (gap > worst) { worst = gap; where = w; } }
  return { gap: Math.round(worst * 1000) / 1000, at: [Math.round(where[0] * 10) / 10, Math.round(where[1] * 10) / 10] as V2 };
}

/** Metres of daylight allowed between two pieces a layout says ABUT (layout piece `abuts`): a gate block and its pylons. */
export const ABUT_GAP_M = 0.05;
/**
 * ABUT (Derek 2026-10-30, the Moon: "the wall for the actual doorway doesn't connect with the 2 tower pillars"): two
 * pieces in WORLD triangles (y up) that must meet flush. The pair is sliced every `step` m over the heights both reach;
 * in each slice A's far face (along the horizontal line from A's centre to B's) and B's near face are taken over the
 * depth both share there, and the daylight between them is B's near minus A's far. A battered pylon beside a plumb wall
 * opens with height, so every slice is measured. Returns the worst gap (m; <= 0 = touching or overlapping) and its height.
 */
export function abutGap(A: Tri3[], B: Tri3[], step = 0.25): { gap: number; at: number; slices: number } {
  const centre = (T: Tri3[]) => { let x = 0, z = 0, n = 0; for (const t of T) for (const v of [t.a, t.b, t.c]) { x += v[0]!; z += v[2]!; n++; } return [x / Math.max(1, n), z / Math.max(1, n)]; };
  const ca = centre(A), cb = centre(B); let dx = cb[0]! - ca[0]!, dz = cb[1]! - ca[1]!; const L = Math.hypot(dx, dz) || 1; dx /= L; dz /= L;
  const yr = (T: Tri3[]) => { let lo = Infinity, hi = -Infinity; for (const t of T) for (const v of [t.a, t.b, t.c]) { lo = Math.min(lo, v[1]!); hi = Math.max(hi, v[1]!); } return [lo, hi]; };
  const [a0, a1] = yr(A), [b0, b1] = yr(B), y0 = Math.max(a0!, b0!) + 0.05, y1 = Math.min(a1!, b1!) - 0.05;
  // one slice's segments, as [d, p] pairs (d along A->B, p across it)
  const slice = (T: Tri3[], h: number) => { const segs: number[][][] = [];
    for (const t of T) { const vs = [t.a, t.b, t.c], pts: number[][] = [];
      for (let i = 0; i < 3; i++) { const u = vs[i]!, w = vs[(i + 1) % 3]!; if ((u[1]! - h) * (w[1]! - h) > 0 || u[1] === w[1]) continue; const s = (h - u[1]!) / (w[1]! - u[1]!); const x = u[0]! + s * (w[0]! - u[0]!), z = u[2]! + s * (w[2]! - u[2]!); pts.push([x * dx + z * dz, -x * dz + z * dx]); }
      if (pts.length >= 2) segs.push([pts[0]!, pts[1]!]); }
    return segs; };
  const range = (segs: number[][][]) => { let lo = Infinity, hi = -Infinity; for (const s of segs) for (const q of s) { lo = Math.min(lo, q[1]!); hi = Math.max(hi, q[1]!); } return [lo, hi]; };
  // the extreme d of the segments clipped to p in [p0, p1]
  const extreme = (segs: number[][][], p0: number, p1: number, far: boolean) => { let best = far ? -Infinity : Infinity;
    for (const [u, w] of segs) { const pa = Math.max(p0, Math.min(u![1]!, w![1]!)), pb = Math.min(p1, Math.max(u![1]!, w![1]!)); if (pa > pb) continue;
      for (const p of [pa, pb]) { const s = w![1] === u![1] ? 0 : (p - u![1]!) / (w![1]! - u![1]!); const d = u![0]! + Math.max(0, Math.min(1, s)) * (w![0]! - u![0]!); best = far ? Math.max(best, d) : Math.min(best, d); } }
    return best; };
  let gap = -Infinity, at = y0, slices = 0;
  for (let h = y0; h <= y1; h += step) {
    const sa = slice(A, h), sb = slice(B, h); if (!sa.length || !sb.length) continue;
    const [pa0, pa1] = range(sa), [pb0, pb1] = range(sb), p0 = Math.max(pa0!, pb0!), p1 = Math.min(pa1!, pb1!); if (p0 > p1) continue;
    const g = extreme(sb, p0, p1, false) - extreme(sa, p0, p1, true); slices++;
    if (Number.isFinite(g) && g > gap) { gap = g; at = h; }
  }
  return { gap: slices ? gap : Infinity, at, slices };
}

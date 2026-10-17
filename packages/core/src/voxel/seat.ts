/**
 * SEAT — the one rule for "does this object rest on something real, and where should it be".
 *
 * Every placer used to set an object's height from a number computed earlier (the drawn heightfield, a measured
 * socket map, a recipe y). None of them looked at the solid actually under the object's footprint when it put it
 * there, so a rock on a monument edge, a brazier on a stair cut and a basket on a dungeon floor that moved all
 * passed their gates while hanging in the air. Here the footprint is probed against a `SolidProbe` — the voxel
 * field's density (terrain edits, carves, cuts, planar treads, formations folded into the field) and/or placed
 * triangles (colliders, DC dungeon meshes, built decks and stairs) — and the object's CONTACT KIND says what
 * touching means:
 *
 *  - `base`  a flat base sits on the surface, sunk `sink` (3 cm) into it; the highest ground under the footprint
 *            carries it, and the centre may not hang over a drop (a crate on a cliff edge is `unsupported`).
 *  - `legs`  each foot touches: the highest foot carries it, the others may not hang more than `legSpread`.
 *  - `embed` a rock sinks `embed` x its height below the LOWEST ground under its footprint, so no side shows its
 *            underside; a footprint whose ground falls away by more than the rock is tall (a monument edge, a
 *            cliff lip) is `unsupported`: drop it.
 *  - `hang`  its top touches the underside of something above (a beam, a ceiling), or failing that a wall beside it.
 *  - `wall`  its back touches a wall.
 *  - `seated` a sitting figure (a statue on a throne or bench, a seated body): it rests wherever its OWN underside
 *            touches the solid — the hips on the seat, the feet on a step — and its legs may overhang the seat's
 *            edge, so there is no centre-over-a-drop test. The contact error is the smallest gap between the
 *            figure's underside (`SeatFootprint.underside`, else its flat base) and the solid under it.
 *
 * Headless, deterministic, no allocation per probe beyond the sample list. The gate (`worldgen float`, the scene
 * variant) and every placer call this; a placer applies `y`, a gate reports `gap`.
 */

export const SEAT_CONTACTS = ["base", "legs", "embed", "hang", "wall", "seated"] as const;
export type SeatContact = (typeof SEAT_CONTACTS)[number];

/** What is solid. Every method answers in world metres. */
export interface SolidProbe {
  /** The highest solid top surface (air above, solid below) in the column at (x, z) with `lo <= y <= hi`; `hi` when the column is solid at `hi` (buried); null when there is none. */
  floor(x: number, z: number, hi: number, lo: number): number | null;
  /** The lowest underside of solid above (air below it) in the column with `lo <= y <= hi`; null when there is none. */
  ceiling?(x: number, z: number, lo: number, hi: number): number | null;
  /** Distance from (x, y, z) along the horizontal unit direction (dx, dz) to solid, within `reach`; 0 when inside solid; null when none. */
  wall?(x: number, y: number, z: number, dx: number, dz: number, reach: number): number | null;
}

export interface SeatFootprint {
  /** Centre of the base in plan. */
  x: number;
  z: number;
  /** Current base height (the bottom of the object). */
  y: number;
  /** Half extents of the base in the object's own frame (metres). */
  halfX: number;
  halfZ: number;
  /** Yaw (radians, about +Y). */
  yaw?: number;
  /** Object height (metres): how deep `embed` sinks, where `hang` meets its ceiling. */
  height: number;
  /** `embed`: share (0..1) of the ground's slope the base follows (a scatter rule's `alignToNormal`); 0 = level base. */
  align?: number;
  /** `legs`: foot points in the object's own frame; the four corners at 85% when absent. */
  feet?: readonly (readonly [number, number])[];
  /**
   * `seated`: the object's own lowest point in the world column at (x, z), null where none of it is there. A seated
   * figure's underside steps (hips high on the seat, feet low on the step); absent = a flat underside at `y`.
   */
  underside?: (x: number, z: number) => number | null;
}

export interface SeatOptions {
  /** A contact off by more than this is a fault (m). */
  tol?: number;
  /** How far a `base`/`legs` object is pressed into its surface (m). */
  sink?: number;
  /** `embed`: fraction of the height sunk below the lowest ground. */
  embed?: number;
  /** How far below the base the ground is looked for (m). */
  reachDown?: number;
  /**
   * How far ABOVE the base a sunk object looks for its own surface (m): default 0.6 (an embed: its height). "height"
   * lifts a prop sunk anywhere up to its full height out of the floor (the editor's Drop to surface).
   */
  reachUp?: number | "height";
  /** Share of footprint samples that must find ground at all. */
  minSupport?: number;
  /** `legs`: how far the lowest foot may hang below the highest (m). */
  legSpread?: number;
  /** `hang` / `wall`: how far the surface is looked for (m). */
  reach?: number;
}

export type SeatStatus = "ok" | "off" | "unsupported";

export interface SeatResult {
  contact: SeatContact;
  /** `ok`: within `tol`; `off`: correctable (apply `y`, or `x`/`z` for a wall piece); `unsupported`: nothing to rest on — drop or flag. */
  status: SeatStatus;
  /** Corrected base height; null when unsupported. */
  y: number | null;
  /** Corrected plan position (only `wall` moves in plan). */
  x?: number;
  z?: number;
  /** Signed contact error (m): positive = floating / not embedded / not touching; negative = sunk deeper than asked. Infinity when no surface. */
  gap: number;
  /** Share of footprint samples that found ground (0..1). */
  support: number;
  /** Highest minus lowest ground under the footprint (m). */
  spread: number;
  /** Why it is off or unsupported, in a few words. */
  reason?: string;
}

/** A footprint sample that hit a neighbour standing in the footprint rather than ground. */
const OBSTRUCTED = Number.NEGATIVE_INFINITY;
const D = { tol: 0.05, sink: 0.03, embed: 0.2, reachDown: 4, minSupport: 0.6, legSpread: 0.15, reach: 3 };
const round = (v: number): number => (Number.isFinite(v) ? Math.round(v * 1000) / 1000 : v);

/** Footprint sample points in world plan: centre first, then the rim at 85%, then an inner ring at 45%. */
export function seatSamples(fp: SeatFootprint): [number, number][] {
  const c = Math.cos(fp.yaw ?? 0), s = Math.sin(fp.yaw ?? 0);
  const w = (lx: number, lz: number): [number, number] => [fp.x + lx * c + lz * s, fp.z - lx * s + lz * c];
  const out: [number, number][] = [[fp.x, fp.z]];
  for (const k of [0.85, 0.45]) {
    const hx = fp.halfX * k, hz = fp.halfZ * k;
    if (hx < 0.02 && hz < 0.02) break;
    out.push(w(-hx, -hz), w(hx, -hz), w(hx, hz), w(-hx, hz));
    if (k === 0.85) out.push(w(0, -hz), w(hx, 0), w(0, hz), w(-hx, 0));
  }
  return out;
}

/**
 * Seat one object. `probe` is the real solid; `fp` the footprint at its current place; `contact` what touching
 * means for it. Returns the corrected base height (or plan position) and the contact error before correction.
 */
export function seatObject(probe: SolidProbe, fp: SeatFootprint, contact: SeatContact, options: SeatOptions = {}): SeatResult {
  const o = { ...D, ...options };
  if (contact === "hang") return seatHang(probe, fp, o);
  if (contact === "wall") return seatWall(probe, fp, o);
  if (contact === "seated") return seatSeated(probe, fp, o);
  const c = Math.cos(fp.yaw ?? 0), s = Math.sin(fp.yaw ?? 0);
  const pts: [number, number][] =
    contact === "legs"
      ? (fp.feet && fp.feet.length > 0 ? fp.feet : [[-fp.halfX * 0.85, -fp.halfZ * 0.85], [fp.halfX * 0.85, -fp.halfZ * 0.85], [fp.halfX * 0.85, fp.halfZ * 0.85], [-fp.halfX * 0.85, fp.halfZ * 0.85]]).map(
          ([lx, lz]) => [fp.x + lx * c + lz * s, fp.z - lx * s + lz * c] as [number, number],
        )
      : seatSamples(fp);
  // a buried base must still find its own surface: look above it by its embed depth (rocks) or 0.6 m
  const up = o.reachUp === "height" ? Math.max(0.6, fp.height) : typeof o.reachUp === "number" ? o.reachUp : contact === "embed" ? Math.max(0.6, fp.height) : 0.6;
  const hi = fp.y + up, lo = fp.y - o.reachDown;
  const g: (number | null)[] = pts.map(([x, z]) => probe.floor(x, z, hi, lo));
  if (contact !== "embed") {
    // a neighbour standing inside the footprint (vases in a row, a table edge, a wall's foot) is an obstruction, not
    // support: a rim sample well above both the base and the centre's ground is left out. The centre always counts.
    const c0 = g[0] ?? null;
    for (let i = 1; i < g.length; i++) {
      const v = g[i];
      if (v !== null && v !== undefined && v > fp.y + 0.25 && (c0 === null || v > c0 + 0.25)) g[i] = OBSTRUCTED;
    }
  }
  const found = g.filter((v): v is number => v !== null && v !== OBSTRUCTED);
  const support = found.length / Math.max(1, g.filter((v) => v !== OBSTRUCTED).length);
  if (found.length === 0) return { contact, status: "unsupported", y: null, gap: Infinity, support: 0, spread: 0, reason: "no ground under the footprint" };
  const top = Math.max(...found), bottom = Math.min(...found), spread = top - bottom;
  const res = (status: SeatStatus, y: number | null, gap: number, reason?: string): SeatResult => ({
    contact, status, y, gap: round(gap), support: round(support), spread: round(spread), ...(reason ? { reason } : {}),
  });

  if (contact === "embed") {
    if (support < o.minSupport) return res("unsupported", null, fp.y - bottom, `ground under ${Math.round(support * 100)}% of the footprint`);
    // the underside follows `align` of the ground's slope (a scatter rock tilted to the normal): compare each sample
    // with that tilted base plane, so a rock bedded on a smooth slope is not mistaken for one over an edge
    const tilt = baseTilt(pts, g, fp, Math.max(0, Math.min(1, fp.align ?? 0)));
    let gap = -Infinity, rise = -Infinity;
    pts.forEach((_, i) => {
      const v = g[i];
      if (v === null || v === undefined) return;
      gap = Math.max(gap, fp.y + tilt[i]! - v); // underside above the ground here
      rise = Math.max(rise, v - (fp.y + tilt[i]!)); // ground above the underside here
    });
    const need = Math.max(0, o.embed) * fp.height;
    if (gap <= o.tol) return res("ok", fp.y, gap);
    const target = fp.y - gap - need;
    // sunk until the lowest side is bedded, the high side would swallow it: a step or an edge taller than the rock
    if (fp.height > 0 && rise + gap + need > fp.height * 1.05) return res("unsupported", null, gap, `straddles a ${(rise + gap).toFixed(1)} m step (rock ${fp.height.toFixed(1)} m)`);
    return res("off", target, gap, "underside shows");
  }
  if (contact === "legs") {
    const gap = fp.y - top;
    if (support < 1 && support < o.minSupport) return res("unsupported", null, gap, "a foot over nothing");
    const target = top - o.sink;
    if (spread > o.legSpread) return res("off", target, Math.max(gap, spread - o.sink), `uneven: a foot hangs ${spread.toFixed(2)} m`);
    if (o.reachUp !== undefined && gap < -(o.sink + o.tol)) return res("off", target, gap, "sunk into its surface");
    return gap > o.tol ? res("off", target, gap, "floating") : res("ok", fp.y, gap);
  }
  // base
  const gap = fp.y - top;
  if (support < o.minSupport) return res("unsupported", null, gap, `ground under ${Math.round(support * 100)}% of the footprint`);
  const centre = g[0];
  const perch = Math.max(0.35, 0.7 * Math.min(fp.halfX, fp.halfZ));
  if (centre === null || centre === undefined || top - centre > perch) return res("unsupported", null, gap, "centre over a drop (perched on an edge)");
  // asked to lift (reachUp): a base sunk below its surface comes up onto it; the float gate keeps calling a sunk base ok
  if (o.reachUp !== undefined && gap < -(o.sink + o.tol)) return res("off", top - o.sink, gap, "sunk into its surface");
  return gap > o.tol ? res("off", top - o.sink, gap, "floating") : res("ok", fp.y, gap);
}

/**
 * A seated figure rests where its own underside touches: under each footprint sample the solid below its underside
 * there is found; the gap is the SMALLEST of those (the hips on the seat, the feet on a step), so legs hanging over
 * the seat's edge are fine. Solid reaching well above the underside (a throne back, the wall of a niche) is an
 * obstruction, not support. Unsupported when nothing under it is found at all.
 */
function seatSeated(probe: SolidProbe, fp: SeatFootprint, o: typeof D & SeatOptions): SeatResult {
  const reachUp = o.reachUp === "height" ? Math.max(0.6, fp.height) : typeof o.reachUp === "number" ? o.reachUp : 0.6;
  let gap = Infinity, n = 0, hit = 0;
  for (const [x, z] of seatSamples(fp)) {
    const under = fp.underside ? fp.underside(x, z) : fp.y;
    if (under === null || under === undefined) continue;
    n++;
    const g = probe.floor(x, z, under + reachUp, under - o.reachDown);
    if (g === null || g > under + 0.25) continue; // nothing below, or a back / niche wall standing in the footprint
    hit++;
    gap = Math.min(gap, under - g);
  }
  const support = n > 0 ? hit / n : 0;
  const res = (status: SeatStatus, y: number | null, reason?: string): SeatResult => ({
    contact: "seated", status, y, gap: round(gap), support: round(support), spread: 0, ...(reason ? { reason } : {}),
  });
  if (hit === 0) return res("unsupported", null, "nothing under the figure");
  if (o.reachUp !== undefined && gap < -(o.sink + o.tol)) return res("off", fp.y - gap - o.sink, "sunk into its seat");
  return gap > o.tol ? res("off", fp.y - gap - o.sink, "floating over its seat") : res("ok", fp.y, undefined);
}

/** Height of a base tilted by `align` of the least-squares ground plane, at each sample, relative to the centre. */
function baseTilt(pts: readonly [number, number][], g: readonly (number | null)[], fp: SeatFootprint, align: number): number[] {
  if (align <= 0) return pts.map(() => 0);
  // fit v = a + b dx + c dz over the samples that found ground
  let n = 0, sx = 0, sz = 0, sv = 0, sxx = 0, szz = 0, sxz = 0, sxv = 0, szv = 0;
  pts.forEach(([x, z], i) => {
    const v = g[i];
    if (v === null || v === undefined) return;
    const dx = x - fp.x, dz = z - fp.z;
    n++; sx += dx; sz += dz; sv += v; sxx += dx * dx; szz += dz * dz; sxz += dx * dz; sxv += dx * v; szv += dz * v;
  });
  if (n < 3) return pts.map(() => 0);
  // normal equations, centred
  const mx = sx / n, mz = sz / n, mv = sv / n;
  const cxx = sxx - n * mx * mx, czz = szz - n * mz * mz, cxz = sxz - n * mx * mz, cxv = sxv - n * mx * mv, czv = szv - n * mz * mv;
  const det = cxx * czz - cxz * cxz;
  if (Math.abs(det) < 1e-9) return pts.map(() => 0);
  let b = (cxv * czz - czv * cxz) / det, c = (czv * cxx - cxv * cxz) / det;
  // an edge under the footprint fits as a cliff-steep plane; a base tilts no further than a 50° bank
  const m = Math.hypot(b, c);
  if (m > 1.2) { b *= 1.2 / m; c *= 1.2 / m; }
  return pts.map(([x, z]) => align * (b * (x - fp.x) + c * (z - fp.z)));
}

function seatHang(probe: SolidProbe, fp: SeatFootprint, o: typeof D): SeatResult {
  const topY = fp.y + fp.height;
  const base = { contact: "hang" as const, support: 1, spread: 0 };
  if (probe.ceiling) {
    const ceil = probe.ceiling(fp.x, fp.z, topY - 0.3, topY + o.reach);
    if (ceil !== null) {
      const gap = round(ceil - topY);
      return gap > o.tol || gap < -0.3 ? { ...base, status: "off", y: round(ceil - fp.height), gap, reason: "not touching what it hangs from" } : { ...base, status: "ok", y: fp.y, gap };
    }
  }
  // a bracket lantern hangs off a wall beside it
  const w = nearestWall(probe, fp, fp.y + fp.height * 0.8, o.reach);
  if (w && w.gap <= o.tol) return { ...base, status: "ok", y: fp.y, gap: round(w.gap) };
  return { ...base, status: "unsupported", y: null, gap: w ? round(w.gap) : Infinity, support: 0, reason: "nothing above or beside to hang from" };
}

function nearestWall(probe: SolidProbe, fp: SeatFootprint, y: number, reach: number): { gap: number; dx: number; dz: number } | null {
  if (!probe.wall) return null;
  const c = Math.cos(fp.yaw ?? 0), s = Math.sin(fp.yaw ?? 0);
  // local -Z (the back, the house convention), then the other three sides
  const dirs: [number, number, number][] = [[0, -1, fp.halfZ], [0, 1, fp.halfZ], [-1, 0, fp.halfX], [1, 0, fp.halfX]];
  let best: { gap: number; dx: number; dz: number } | null = null;
  for (const [lx, lz, half] of dirs) {
    const dx = lx * c + lz * s, dz = -lx * s + lz * c;
    const d = probe.wall(fp.x, y, fp.z, dx, dz, half + reach);
    if (d === null) continue;
    const gap = d - half;
    if (!best || gap < best.gap) best = { gap, dx, dz };
    if (lz === -1 && gap <= 0.05) break; // the back touches: that is the answer
  }
  return best;
}

function seatWall(probe: SolidProbe, fp: SeatFootprint, o: typeof D): SeatResult {
  const w = nearestWall(probe, fp, fp.y + fp.height * 0.5, o.reach);
  // a wall piece standing on a sill, a ledge or a niche floor is held up by that: its base contact is enough
  if (!w || w.gap > o.tol) {
    const sill = seatObject(probe, fp, "base", { ...o, reachDown: 0.5 });
    if (sill.status === "ok") return { ...sill, contact: "wall", reason: "stands on a sill" };
  }
  const base = { contact: "wall" as const, support: w ? 1 : 0, spread: 0 };
  if (!w) return { ...base, status: "unsupported", y: null, gap: Infinity, reason: "no wall within reach" };
  const gap = round(w.gap);
  if (gap <= o.tol) return { ...base, status: "ok", y: fp.y, gap };
  const move = w.gap - o.sink;
  return { ...base, status: "off", y: fp.y, x: round(fp.x + w.dx * move), z: round(fp.z + w.dz * move), gap, reason: "off the wall" };
}

/** Seat a batch (one probe, one option set): the gate's and the installers' entry point. */
export function seatMany<T extends { footprint: SeatFootprint; contact: SeatContact }>(
  probe: SolidProbe,
  items: readonly T[],
  options: SeatOptions = {},
): (SeatResult & { item: T })[] {
  return items.map((item) => ({ ...seatObject(probe, item.footprint, item.contact, options), item }));
}

// ------------------------------------------------------------------ probes

/** The part of a WorldField a probe needs (kept structural so tests can fake it). */
export interface SeatField {
  density(x: number, y: number, z: number): number;
  height(x: number, z: number): number;
  readonly voxelSize: number;
  planarNear?(x: number, z: number): boolean;
  carveSpan?(x0: number, z0: number, x1: number, z1: number): { min: number; max: number } | null;
  readonly recipe?: { terrain?: { overhang?: { strength: number } } };
}

/**
 * The voxel field as a solid: density < 0 is rock — terrain edits, height patches, passages, tunnels, blobs,
 * planar treads, buttes, everything the field folds in (NOT the drawn heightfield, which misses cuts). A column
 * with no carve, no planar cliff and no overhang near it, whose height() is a density crossing, answers from
 * height() directly (cheap and exact); everything else is marched at `step` and bisected to ~1 cm.
 */
export function fieldSolidProbe(field: SeatField, step = 0.25): SolidProbe {
  const overhang = (field.recipe?.terrain?.overhang?.strength ?? 0) > 0;
  const solid = (x: number, y: number, z: number): boolean => field.density(x, y, z) < 0;
  const plain = (x: number, z: number): boolean =>
    !overhang && !field.planarNear?.(x, z) && !field.carveSpan?.(x - 0.5, z - 0.5, x + 0.5, z + 0.5);
  const bisect = (x: number, z: number, a: number, b: number): number => {
    // a: solid, b: air (either order in y)
    for (let i = 0; i < 6; i++) {
      const m = (a + b) / 2;
      if (solid(x, m, z)) a = m; else b = m;
    }
    return (a + b) / 2;
  };
  return {
    floor(x, z, hi, lo) {
      if (plain(x, z)) {
        const h = field.height(x, z);
        if (!solid(x, h + 0.04, z) && solid(x, h - 0.04, z)) {
          if (h > hi) return solid(x, hi, z) ? hi : null;
          return h >= lo ? h : null;
        }
      }
      if (solid(x, hi, z)) return hi;
      let prev = hi;
      for (let y = hi - step; y >= lo - 1e-9; y -= step) {
        if (solid(x, y, z)) return bisect(x, z, y, prev);
        prev = y;
      }
      return null;
    },
    ceiling(x, z, lo, hi) {
      if (solid(x, lo, z)) return lo;
      let prev = lo;
      for (let y = lo + step; y <= hi + 1e-9; y += step) {
        if (solid(x, y, z)) return bisect(x, z, y, prev);
        prev = y;
      }
      return null;
    },
    wall(x, y, z, dx, dz, reach) {
      if (solid(x, y, z)) return 0;
      let prev = 0;
      for (let t = step; t <= reach + 1e-9; t += step) {
        if (solid(x + dx * t, y, z + dz * t)) {
          let a = t, b = prev;
          for (let i = 0; i < 6; i++) {
            const m = (a + b) / 2;
            if (solid(x + dx * m, y, z + dz * m)) a = m; else b = m;
          }
          return (a + b) / 2;
        }
        prev = t;
      }
      return null;
    },
  };
}

/**
 * Placed triangles as a solid surface: colliders, DC dungeon floors, decks, stairs. `tris` is a flat soup, nine
 * numbers per triangle, in world space. Bucketed on a `cell`-metre plan grid, so a column query reads one bucket.
 * `owners` (one id per triangle) lets `excluding(id)` leave an object's own triangles out when seating it.
 */
export function triangleSolidProbe(tris: ArrayLike<number>, cell = 1, owners?: ArrayLike<number>): SolidProbe & { excluding(owner: number): SolidProbe } {
  const n = Math.floor(tris.length / 9);
  const buckets = new Map<string, number[]>();
  const key = (i: number, k: number): string => `${i},${k}`;
  // a triangle wider than 64 cells (a sea plane, a ground card) is tested from every column instead of bucketed
  const huge: number[] = [];
  for (let t = 0; t < n; t++) {
    const o = t * 9;
    const x0 = Math.min(tris[o]!, tris[o + 3]!, tris[o + 6]!), x1 = Math.max(tris[o]!, tris[o + 3]!, tris[o + 6]!);
    const z0 = Math.min(tris[o + 2]!, tris[o + 5]!, tris[o + 8]!), z1 = Math.max(tris[o + 2]!, tris[o + 5]!, tris[o + 8]!);
    if ((x1 - x0) / cell > 64 || (z1 - z0) / cell > 64) { huge.push(t); continue; }
    for (let i = Math.floor(x0 / cell); i <= Math.floor(x1 / cell); i++)
      for (let k = Math.floor(z0 / cell); k <= Math.floor(z1 / cell); k++) {
        const b = buckets.get(key(i, k));
        if (b) b.push(t); else buckets.set(key(i, k), [t]);
      }
  }
  /** Heights where the vertical line at (x, z) crosses a triangle. */
  const column = (x: number, z: number, skip: number): number[] => {
    const out: number[] = [];
    const bucket = buckets.get(key(Math.floor(x / cell), Math.floor(z / cell))) ?? [];
    for (const t of huge.length ? bucket.concat(huge) : bucket) {
      if (owners && owners[t] === skip) continue;
      const o = t * 9;
      const ax = tris[o]!, az = tris[o + 2]!, bx = tris[o + 3]!, bz = tris[o + 5]!, cx = tris[o + 6]!, cz = tris[o + 8]!;
      const d = (bz - cz) * (ax - cx) + (cx - bx) * (az - cz);
      if (Math.abs(d) < 1e-12) continue;
      const u = ((bz - cz) * (x - cx) + (cx - bx) * (z - cz)) / d;
      const v = ((cz - az) * (x - cx) + (ax - cx) * (z - cz)) / d;
      const w = 1 - u - v;
      if (u < -1e-7 || v < -1e-7 || w < -1e-7) continue;
      out.push(u * tris[o + 1]! + v * tris[o + 4]! + w * tris[o + 7]!);
    }
    return out;
  };
  const make = (skip: number): SolidProbe => ({
    floor(x, z, hi, lo) {
      let best: number | null = null;
      for (const h of column(x, z, skip)) if (h <= hi && h >= lo && (best === null || h > best)) best = h;
      return best;
    },
    ceiling(x, z, lo, hi) {
      let best: number | null = null;
      for (const h of column(x, z, skip)) if (h >= lo && h <= hi && (best === null || h < best)) best = h;
      return best;
    },
    wall(x, y, z, dx, dz, reach) {
      // march the plan line through the buckets it crosses; Möller–Trumbore on each candidate
      const seen = new Set<number>();
      let best: number | null = null;
      const steps = Math.max(1, Math.ceil(reach / (cell * 0.5)));
      for (let k = 0; k <= steps; k++) {
        const t = (reach * k) / steps;
        for (const tri of buckets.get(key(Math.floor((x + dx * t) / cell), Math.floor((z + dz * t) / cell))) ?? []) {
          if (seen.has(tri) || (owners && owners[tri] === skip)) continue;
          seen.add(tri);
          const hit = rayTri(tris, tri * 9, x, y, z, dx, 0, dz);
          if (hit !== null && hit >= 0 && hit <= reach && (best === null || hit < best)) best = hit;
        }
      }
      return best;
    },
  });
  /** A probe that ignores one owner's triangles: an object never holds itself up. */
  return { ...make(-1), excluding: (owner: number) => make(owner) };
}

function rayTri(tris: ArrayLike<number>, o: number, ox: number, oy: number, oz: number, dx: number, dy: number, dz: number): number | null {
  const ax = tris[o]!, ay = tris[o + 1]!, az = tris[o + 2]!;
  const e1x = tris[o + 3]! - ax, e1y = tris[o + 4]! - ay, e1z = tris[o + 5]! - az;
  const e2x = tris[o + 6]! - ax, e2y = tris[o + 7]! - ay, e2z = tris[o + 8]! - az;
  const px = dy * e2z - dz * e2y, py = dz * e2x - dx * e2z, pz = dx * e2y - dy * e2x;
  const det = e1x * px + e1y * py + e1z * pz;
  if (Math.abs(det) < 1e-12) return null;
  const inv = 1 / det;
  const tx = ox - ax, ty = oy - ay, tz = oz - az;
  const u = (tx * px + ty * py + tz * pz) * inv;
  if (u < 0 || u > 1) return null;
  const qx = ty * e1z - tz * e1y, qy = tz * e1x - tx * e1z, qz = tx * e1y - ty * e1x;
  const v = (dx * qx + dy * qy + dz * qz) * inv;
  if (v < 0 || u + v > 1) return null;
  return (e2x * qx + e2y * qy + e2z * qz) * inv;
}

/** Several solids as one: the highest floor, the lowest ceiling, the nearest wall. */
export function unionSolidProbe(...probes: readonly SolidProbe[]): SolidProbe {
  const pick = (vals: (number | null)[], better: (a: number, b: number) => boolean): number | null => {
    let best: number | null = null;
    for (const v of vals) if (v !== null && (best === null || better(v, best))) best = v;
    return best;
  };
  return {
    floor: (x, z, hi, lo) => pick(probes.map((p) => p.floor(x, z, hi, lo)), (a, b) => a > b),
    ceiling: (x, z, lo, hi) => pick(probes.map((p) => p.ceiling?.(x, z, lo, hi) ?? null), (a, b) => a < b),
    wall: (x, y, z, dx, dz, reach) => pick(probes.map((p) => p.wall?.(x, y, z, dx, dz, reach) ?? null), (a, b) => a < b),
  };
}

// ------------------------------------------------------------------ contact defaults

/**
 * The contact a catalogued prop takes when its entry does not say: rocks embed, wall-mounted things are `wall`,
 * ceiling-mounted things `hang`, furniture with legs `legs`, the rest a flat `base`. Read from the dressing
 * entry's `mount` and `category` and the prop id; an explicit `contact` on the entry always wins.
 */
export function defaultSeatContact(entry: { contact?: SeatContact; mount?: string; category?: string } | undefined, propId = ""): SeatContact {
  if (entry?.contact) return entry.contact;
  const id = propId.toLowerCase();
  const cat = (entry?.category ?? "").toLowerCase();
  if (entry?.mount === "wall") return "wall";
  if (entry?.mount === "ceiling") return "hang";
  if (/(^|[/-])(rock|boulder|scree|outcrop|stone-?pile|rubble|pebble|crag|menhir|monolith|hoodoo)/.test(id) || /rock|stone|rubble/.test(cat)) return "embed";
  if (/(^|[/-])(hanging|chandelier)/.test(id)) return "hang";
  if (/(^|[/-])(sconce|wall-?torch|banner-wall|plaque|shield-wall)/.test(id)) return "wall";
  if (/(^|[/-])(table|chair|stool|bench|trestle|desk|bed|cot|shelf|rack|easel|frame)/.test(id)) return "legs";
  return "base";
}

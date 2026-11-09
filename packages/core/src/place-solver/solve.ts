/**
 * THE PLACEMENT SOLVER — placement that corrects itself (t-place 2026-10-30).
 *
 * Derek: "The agent says 'this ruin tower goes right here', puts it a bit too high, and an algorithm grounds it. It
 * shouldn't be an agent tweaking code until it's grounded." Every placer (place-build layout pieces and dressing,
 * `dress apply`, settle, the town builder, statue placement) hands this solver the agent's INTENT — what, roughly where,
 * facing — and writes the transform it returns, or drops the piece with the reason it returns. Nobody hand-tunes y or
 * nudges xz. The gates (float, seated, support, zfight, door) stay as backstops: a gate that catches a placement fault
 * means a rule is missing HERE.
 *
 * Rules, in the order they run for one candidate spot:
 *  1. support snap — a piece `on` a host goes to the host's marker or its pedestal top's centre and must fit inside the
 *     top face (support.ts); it takes the host's top, never the ground.
 *  2. keep-outs — a door / gate / stair / hearth / lane box (keep-outs.ts, from the structures' own grid data) the
 *     footprint enters pushes the piece out (least-penetration axis), else the spot is refused.
 *  3. no intersecting — the footprint against every placed structure's base (an OBB, or its base cells for an open
 *     court) in the same height band: pushed out the least-penetration way, else refused. `bedded` pieces skip it.
 *  4. seat — the ground is sampled under the real footprint (catalogue size x scale, turned by yaw: corners, edge
 *     midpoints every <= 2 m, centre; or the piece's own base cells) and y is set by the seat rule; a remaining gap is
 *     covered by the declared foundation skirt (foundation.ts), else the spot is refused; ground steeper than the
 *     tolerance is refused.
 * Spots are tried nearest first: the given one, then rings out to `tolerance.move` metres, each with turns up to
 * ±`tolerance.yaw` degrees. The first spot every rule accepts wins; none = the piece is dropped with the given spot's
 * reason. Deterministic and headless: the same request and context always give the same answer.
 */
import { ROCK_EMBED, ROCK_EMBED_SLOPE } from "../voxel/seat.js";
import type { PlaceRule, PlaceSeat } from "../components/place-rule.js";
import { placeRuleSchema } from "../components/place-rule.js";
import type { FoundationSpec } from "./foundation.js";
import type { KeepOut } from "./keep-outs.js";
import { localToWorld, obbOverlap, type Obb, type V2 } from "./obb.js";
import { snapToHost, supportOf, type HostShape } from "./support.js";

/** How far a flush base is pressed into the ground (m): the voxel seat's `sink`. */
export const SEAT_SINK_M = 0.03;
/** Longest plan step between footprint samples along an edge (m). */
export const SAMPLE_STEP_M = 2;
/** Plan overlap (m) two footprints may share before they intersect (touching walls, a crate against a wall). */
export const TOUCH_TOL_M = 0.05;

export interface PlaceRequest {
  /** The piece (entity / layout / plan item id): drop reasons and foundations name it. */
  id: string;
  prefab?: string;
  /** The agent's spot, world plan. */
  at: V2;
  /** The agent's height (only `float-ok` keeps it; every other rule grounds the piece). */
  y?: number;
  /** Radians about +Y (three.js). */
  yaw: number;
  /** Uniform scale (default 1). */
  scale?: number;
  /** Footprint half extents, metres, ALREADY scaled (catalogue dressing.size x scale / 2). */
  half: V2;
  /** Height of the piece, metres, scaled (embed depth, the collision height band). */
  height: number;
  /** Metres of the mesh below its base that are footing meant to be buried (catalogue dressing.footing x scale). */
  footing?: number;
  /** The prefab's `placeRule` (raw or parsed); defaults apply. */
  rule?: Partial<PlaceRule> | null;
  /** Override the seat rule for this one request. */
  seat?: PlaceSeat;
  /** Placed ON another piece (support snap): the host and an optional marker of it. */
  on?: { host: HostShape; marker?: string; sink?: number; bottom?: (x: number, z: number) => number | null };
  /** The piece's own base sample points (local, scaled metres): an open court seats on its walls, not its yard. */
  base?: V2[];
  /** The piece's own SOLID plan cells (local, scaled metres; cell size `cell`): an open court collides only by its walls,
   *  so a fire basin in its yard is no intersection. Absent: the footprint box is solid. */
  cells?: V2[];
  cell?: number;
  /** Heights (local, scaled m) of the piece's own horizontal faces near its base (step treads, slabs): the seat keeps each
   *  off the ground under it (a tread at the ground's height z-fights it), sinking the piece a few cm. */
  flats?: number[];
  /** Ids of obstacles this piece may overlap (a tarp over a crate; layout `over`). */
  over?: string[];
  /** HOLD this height (world y of the origin): the seat only measures the daylight under the footprint and covers it with
   *  the declared foundation (no sink, no lift, no slope refusal). A piece another rule already seated (a legacy-levelled
   *  open court, a raised slab) gets its skirt without moving (r-found 2026-10-30). */
  holdY?: number;
  /** May the solver move it at all? false = judge at the given spot only (exact or dropped). */
  movable?: boolean;
}

/** A placed structure the solver keeps pieces out of (its collider's plan footprint in a height band). */
export interface PlaceObstacle {
  id: string;
  /** Plan box (the base OBB). */
  box: Obb;
  /** World height band [lo, hi]. */
  band?: [number, number];
  /** Open structures: the occupied base cells (world plan centres) and their size; the box is then only a broad test. */
  cells?: V2[];
  cell?: number;
}

export interface PlaceContext {
  /** The ground the client renders (the voxel field's height), world metres. */
  ground: (x: number, z: number) => number | null;
  obstacles?: PlaceObstacle[];
  keepOuts?: KeepOut[];
}

export type PlaceStatus = "ok" | "moved" | "dropped";

export interface PlaceResult {
  id: string;
  status: PlaceStatus;
  /** Corrected transform (world). Present unless dropped. */
  x?: number;
  y?: number;
  z?: number;
  yaw?: number;
  /** Why it was dropped (the given spot's fault), or what changed. */
  reason?: string;
  notes: string[];
  /** Plan metres moved and degrees turned from the agent's spot. */
  moved?: number;
  turned?: number;
  /** Ground under the footprint at the chosen spot. */
  ground?: { hi: number; lo: number; relief: number; slope: number };
  /** Daylight under the footprint after the seat (m; covered by a foundation when one is emitted). */
  gap?: number;
  foundation?: FoundationSpec;
  /** Support rows for a piece on a host (the `support` gate's measure). */
  support?: { on: string; how: string; overhang?: number; clip?: number; ok: boolean };
}

const r3 = (n: number) => Math.round(n * 1000) / 1000;

/** Footprint sample points, local scaled metres: centre, corners, then along every edge at most SAMPLE_STEP_M apart. */
export function footprintSamples(half: V2): V2[] {
  const out: V2[] = [[0, 0]];
  const nx = Math.max(1, Math.ceil((2 * half[0]) / SAMPLE_STEP_M)), nz = Math.max(1, Math.ceil((2 * half[1]) / SAMPLE_STEP_M));
  for (let i = 0; i <= nx; i++) { const x = -half[0] + (2 * half[0] * i) / nx; out.push([x, -half[1]], [x, half[1]]); }
  for (let j = 1; j < nz; j++) { const z = -half[1] + (2 * half[1] * j) / nz; out.push([-half[0], z], [half[0], z]); }
  // a broad base also sits on its middle: an interior lattice every 2 x SAMPLE_STEP_M
  if (half[0] > 2 * SAMPLE_STEP_M && half[1] > 2 * SAMPLE_STEP_M) {
    const mx = Math.ceil((2 * half[0]) / (2 * SAMPLE_STEP_M)), mz = Math.ceil((2 * half[1]) / (2 * SAMPLE_STEP_M));
    for (let i = 1; i < mx; i++) for (let j = 1; j < mz; j++) out.push([-half[0] + (2 * half[0] * i) / mx, -half[1] + (2 * half[1] * j) / mz]);
  }
  return out;
}

/** The candidate spots, nearest first: [dx, dz, dyaw (rad)]. */
export function candidateSpots(move: number, yawDeg: number): [number, number, number][] {
  const turns = [0];
  for (const t of [yawDeg / 2, yawDeg]) if (t > 0) turns.push(t, -t);
  const rings = [0];
  for (const d of [0.25, 0.5, 0.75, 1, 1.5, 2, 3, 4]) if (d <= move + 1e-9) rings.push(d);
  const out: [number, number, number][] = [];
  for (const d of rings) {
    const n = d === 0 ? 1 : d <= 1 ? 8 : 16;
    for (const t of turns) for (let k = 0; k < n; k++) {
      const a = (k * 2 * Math.PI) / n;
      out.push([r3(d * Math.sin(a)), r3(d * Math.cos(a)), (t * Math.PI) / 180]);
    }
  }
  return out;
}

interface Seated { y: number; hi: number; lo: number; relief: number; slope: number; gap: number; founded: boolean; fault?: string }

/** Seat one footprint on the ground by its rule. */
function seatOn(req: PlaceRequest, rule: PlaceRule, at: V2, yaw: number, ground: PlaceContext["ground"]): Seated {
  const seat = req.seat ?? rule.seat;
  const local = req.base && req.base.length ? req.base : footprintSamples(req.half);
  const pts = local.map((l) => localToWorld(at, yaw, l)), hs: (number | null)[] = pts.map((p) => ground(p[0], p[1]));
  const ok = hs.map((h, i) => [h, i] as const).filter((x): x is readonly [number, number] => x[0] !== null && Number.isFinite(x[0]));
  if (ok.length < Math.max(1, Math.ceil(0.6 * hs.length))) return { y: NaN, hi: NaN, lo: NaN, relief: 0, slope: 0, gap: Infinity, founded: false, fault: "no ground under the footprint" };
  let hi = -Infinity, lo = Infinity, slope = 0;
  for (const [h] of ok) { hi = Math.max(hi, h); lo = Math.min(lo, h); }
  const minD = Math.max(0.5, 0.5 * Math.min(req.half[0], req.half[1]));
  for (let a = 0; a < ok.length; a++) for (let b = a + 1; b < ok.length; b++) {
    const pa = pts[ok[a]![1]]!, pb = pts[ok[b]![1]]!, d = Math.hypot(pa[0] - pb[0], pa[1] - pb[1]);
    if (d >= minD) slope = Math.max(slope, Math.abs(ok[a]![0] - ok[b]![0]) / d);
  }
  const relief = hi - lo, footing = Math.max(0, req.footing ?? 0), base = { hi: r3(hi), lo: r3(lo), relief: r3(relief), slope: Math.round(slope * 100) / 100 };
  if (req.holdY !== undefined && Number.isFinite(req.holdY)) {
    const fbH = Math.max(0, footing - rule.grade), gap = req.holdY - rule.grade - fbH - lo, okH = rule.foundation ? rule.tolerance.gap / 2 : rule.tolerance.gap;
    return { y: r3(req.holdY), ...base, gap: r3(Math.max(0, gap)), founded: gap > okH && !!rule.foundation };
  }
  if (seat === "float-ok") {
    const centre = ground(at[0], at[1]) ?? hi;
    const y = req.y ?? centre;
    return { y: r3(y), ...base, gap: 0, founded: false };
  }
  if (seat === "set-in") {
    // a front cut into a slope / cliff: the base on its LOWEST ground, the high side runs into the rock (nothing floats)
    return { y: r3(lo - SEAT_SINK_M), ...base, gap: 0, founded: false };
  }
  if (seat === "embed") {
    // a rock sits IN its lowest ground: ROCK_EMBED of its height, more on a slope (the voxel seat's rule)
    const y = lo - req.height * (ROCK_EMBED + ROCK_EMBED_SLOPE * Math.min(1, slope));
    return { y: r3(y), ...base, gap: 0, founded: false, ...(relief > req.height ? { fault: `ground falls ${r3(relief)} m under a ${r3(req.height)} m rock (a lip or an edge)` } : {}) };
  }
  if (slope > rule.tolerance.slope) return { y: NaN, ...base, gap: r3(relief), founded: false, fault: `ground too steep (${base.slope} > ${rule.tolerance.slope})` };
  // the seat works on the piece's GRADE plane (`grade` m under its origin: a raised floor); `fb` = footing below grade
  const g = rule.grade, fb = Math.max(0, footing - g), flush = hi - SEAT_SINK_M;
  // a piece that HAS a foundation takes it from half the tolerance: the samples are 2 m apart and the seated gate walks the
  // whole base outline, so a gap just inside the tolerance at the samples is just outside it somewhere between them
  const okGap = rule.foundation ? rule.tolerance.gap / 2 : rule.tolerance.gap;
  if (seat === "plinth") {
    const gap = flush - fb - lo;
    if (gap <= okGap) return { y: r3(flush + g), ...base, gap: r3(Math.max(0, gap)), founded: false };
    if (!rule.foundation) return { y: r3(flush + g), ...base, gap: r3(gap), founded: false, fault: `a plinth piece with no foundation declared stands ${r3(gap)} m clear` };
    return { y: r3(flush + g), ...base, gap: r3(gap), founded: true };
  }
  // foot: flush on the highest ground; sink toward the lowest by at most the footing (the cap), never below it. A piece
  // with a FLOOR (grade > 0: a raised slab) never sinks: terrain never comes through a floor (towns' terrain-through-floor
  // rule), its footing and its foundation cover the fall instead
  const sinkCap = g > 0 ? SEAT_SINK_M : Math.max(SEAT_SINK_M, fb);
  const yg = Math.min(flush, Math.max(lo + fb, hi - sinkCap));
  const gap = yg - fb - lo;
  if (gap <= okGap) return { y: r3(yg + g), ...base, gap: r3(Math.max(0, gap)), founded: false };
  if (rule.foundation) return { y: r3(yg + g), ...base, gap: r3(gap), founded: true };
  return { y: r3(yg + g), ...base, gap: r3(gap), founded: false, fault: `${r3(gap)} m of daylight under its low side (ground falls ${base.relief} m, footing ${r3(fb)} m, no foundation declared)` };
}

/** Where a skirt's top goes for a piece whose base is `y` and whose mesh runs `footing` m below it: inside the piece's
 *  own footing (0.1 m up it) when it has one, else 0.04 m up into its base (the inset skirt is hidden in the piece; no
 *  face of it within the zfight gate's 2 cm of the piece's planes). */
/** A foundation's top cap keeps this far (m) from any ground height under it (the zfight gate's plane tolerance is 2 cm). */
export const FOUNDATION_CAP_CLEAR_M = 0.03;
/** How far the voxel mesh may stand off the sampled field height (marching-cubes interpolation on a 2 m grid). */
export const GROUND_MESH_TOL_M = 0.1;
/** How far a piece is sunk when one of its own flat faces lies in the ground's plane. */
export const FLAT_CLEAR_STEP_M = 0.04;
export const foundationTop = (y: number, footing: number): number => y - footing + (footing > 0.15 ? 0.1 : 0.04);

/** Least-penetration push out of every overlapping box (summed), or the id that cannot be pushed out of. */
function pushOut(fp: Obb, band: [number, number], boxes: { id: string; box: Obb; band?: [number, number]; cells?: V2[]; cell?: number }[], skip: Set<string>, own?: { cells: V2[]; half: number }): { push: V2; hits: string[]; depth: number } {
  let px = 0, pz = 0, depth = 0;
  const hits: string[] = [];
  for (const b of boxes) {
    if (skip.has(b.id)) continue;
    if (b.band && (band[1] <= b.band[0] || band[0] >= b.band[1])) continue;
    const o = obbOverlap(fp, b.box, TOUCH_TOL_M);
    if (!o) continue;
    if ((b.cells && b.cells.length) || own) {
      // open structures: only wall cells are solid, on either side (the piece's own cells against the obstacle's)
      const half = (b.cell ?? 0.5) / 2;
      const theirs: Obb[] = b.cells && b.cells.length ? b.cells.map((c) => ({ c, half: [half, half] as V2, yaw: b.box.yaw })) : [b.box];
      const mine: Obb[] = own ? own.cells.map((c) => ({ c, half: [own.half, own.half] as V2, yaw: fp.yaw })) : [fp];
      let best: { push: V2; depth: number } | null = null;
      for (const m of mine) {
        if (!obbOverlap(m, b.box, TOUCH_TOL_M)) continue;
        for (const t of theirs) {
          const oc = obbOverlap(m, t, TOUCH_TOL_M);
          if (oc && (!best || oc.depth > best.depth)) best = oc;
        }
      }
      if (!best) continue;
      px += best.push[0]; pz += best.push[1]; depth = Math.max(depth, best.depth); hits.push(b.id);
      continue;
    }
    px += o.push[0]; pz += o.push[1]; depth = Math.max(depth, o.depth); hits.push(b.id);
  }
  return { push: [px, pz], hits, depth };
}

/** Normalise a rule (raw component data or partial) with the schema's defaults. */
export function placeRuleOf(rule: Partial<PlaceRule> | null | undefined): PlaceRule {
  return placeRuleSchema.parse(rule ?? {});
}

/**
 * Solve one placement. Returns the corrected transform, or `dropped` with the reason the agent's own spot failed.
 */
export function solvePlacement(req: PlaceRequest, ctx: PlaceContext): PlaceResult {
  const rule = placeRuleOf(req.rule);
  const notes: string[] = [];
  // 1. SUPPORT: on a host, the host's top is the ground; snapped, then measured
  if (req.on) {
    const snap = snapToHost(req.at, req.half, req.on.host, { ...(req.on.marker ? { marker: req.on.marker } : {}), ...(req.on.sink ? { sink: req.on.sink } : {}) });
    if (snap.fault || snap.y == null) return { id: req.id, status: "dropped", reason: snap.fault ?? `no top of ${req.on.host.prefab} under it`, notes };
    let support: PlaceResult["support"] = { on: req.on.host.prefab, how: snap.how, ok: true };
    if (req.on.bottom && !req.on.sink) {
      const k = req.scale ?? 1, bottom = req.on.bottom, host = req.on.host;
      const s = supportOf({ prefab: req.prefab ?? req.id, w: snap.w, ang: req.yaw, y: snap.y, k, half: req.half }, host, (_p, x, z) => host.top(x, z), (_p, x, z) => bottom(x, z));
      support = { on: host.prefab, how: snap.how, overhang: s.overhang, clip: s.clip, ok: s.ok };
      if (!s.ok) return { id: req.id, status: "dropped", reason: `does not fit on ${host.prefab}'s top: overhang ${s.overhang}, clip ${s.clip} m`, notes, support };
    }
    if (snap.moved > 0.05) notes.push(`snapped ${snap.moved} m to the ${snap.how === "marker" ? `marker ${req.on.marker}` : "centre of its host's top face"}`);
    return { id: req.id, status: snap.moved > 0.05 ? "moved" : "ok", x: r3(snap.w[0]), y: r3(snap.y), z: r3(snap.w[1]), yaw: req.yaw, notes, moved: snap.moved, turned: 0, support };
  }
  const skip = new Set([req.id, ...(req.over ?? [])]);
  const held = req.holdY !== undefined; // a held piece is judged where it stands: no push, no refusal by its neighbours
  const keepOuts = held ? [] : ctx.keepOuts ?? [], obstacles = rule.bedded || held ? [] : ctx.obstacles ?? [];
  const spots = req.movable === false ? [[0, 0, 0] as [number, number, number]] : candidateSpots(rule.tolerance.move, rule.tolerance.yaw);
  let first: string | null = null;
  for (const [dx, dz, dyaw] of spots) {
    let at: V2 = [req.at[0] + dx, req.at[1] + dz];
    const yaw = req.yaw + dyaw;
    let why: string | null = null, seated: Seated | null = null;
    // two passes: a push out of a keep-out / a structure is re-checked once at the pushed spot
    for (let pass = 0; pass < 3; pass++) {
      const fp: Obb = { c: at, half: req.half, yaw };
      seated = seatOn(req, rule, at, yaw, ctx.ground);
      if (seated.fault && !Number.isFinite(seated.y)) { why = seated.fault; break; }
      const band: [number, number] = [seated.y + 0.05, seated.y + Math.max(0.1, req.height)];
      const ko = pushOut(fp, band, keepOuts.map((k) => ({ id: k.id, box: k.box, ...(k.band ? { band: k.band } : {}) })), skip);
      const own = req.cells?.length ? { cells: req.cells.map((c) => localToWorld(at, yaw, c)), half: (req.cell ?? 0.5) / 2 } : undefined;
      const ob = pushOut(fp, band, obstacles, skip, own);
      if (!ko.hits.length && !ob.hits.length) { why = seated.fault ?? null; break; }
      const push: V2 = [ko.push[0] + ob.push[0], ko.push[1] + ob.push[1]], len = Math.hypot(push[0], push[1]);
      const name = ko.hits.length ? keepOuts.find((k) => k.id === ko.hits[0])?.why ?? ko.hits[0] : `structure ${ob.hits[0]}`;
      const movedSoFar = Math.hypot(at[0] + push[0] - req.at[0], at[1] + push[1] - req.at[1]);
      if (req.movable === false || pass === 2 || len < 1e-6 || movedSoFar > rule.tolerance.move + 1e-9) { why = `${ko.hits.length ? "in the clear zone of" : "intersects"} ${name}`; break; }
      at = [at[0] + push[0] * 1.02, at[1] + push[1] * 1.02];
    }
    if (why) { first ??= why; continue; }
    const s = seated!;
    // no own flat face IN a flat of the ground: sunk FLAT_CLEAR_STEP_M at a time (at most 3), never raised (a raise floats)
    if (req.flats?.length && Number.isFinite(s.y) && (req.seat ?? rule.seat) !== "float-ok" && !held) {
      const gs = footprintSamples(req.half).map((q) => ctx.ground(...localToWorld(at, yaw, q))).filter((h): h is number => h != null);
      const clash = (y: number) => req.flats!.some((f) => gs.some((h) => Math.abs(h - (y + f)) < FOUNDATION_CAP_CLEAR_M));
      for (let k = 0; k < 3 && clash(s.y); k++) s.y = r3(s.y - FLAT_CLEAR_STEP_M);
    }
    const moved = Math.hypot(at[0] - req.at[0], at[1] - req.at[1]), turned = (dyaw * 180) / Math.PI;
    if (first && (moved > 0.01 || Math.abs(turned) > 0.01)) notes.push(`moved ${r3(moved)} m${Math.abs(turned) > 0.01 ? `, turned ${Math.round(turned)} deg` : ""}: at its given spot ${first}`);
    const res: PlaceResult = {
      id: req.id, status: moved > 0.01 || Math.abs(turned) > 0.01 ? "moved" : "ok", x: r3(at[0]), y: s.y, z: r3(at[1]), yaw, notes,
      moved: r3(moved), turned: Math.round(turned * 10) / 10, ground: { hi: s.hi, lo: s.lo, relief: s.relief, slope: s.slope }, gap: s.gap,
    };
    if (s.founded && rule.foundation) {
      const f = rule.foundation, k = req.scale ?? 1, inset = f.inset;
      const half: V2 = f.size ? [(f.size[0] * k) / 2 - inset, (f.size[1] * k) / 2 - inset] : [req.half[0] - inset, req.half[1] - inset];
      const c = localToWorld(at, yaw, [f.offset[0] * k, f.offset[1] * k]);
      let top = foundationTop(s.y, Math.max(0, req.footing ?? 0));
      // the skirt's top cap never lies in a FLAT of the ground (a terrace tread at its height would z-fight it): moved UP,
      // further into the piece's own base / footing (never past 0.1 m over its base plane), else down under the ground
      // sampled on a 1 m lattice over the whole box: a sloped ground crosses any cap level between its low and high points
      const hx = Math.max(0.05, half[0]), hz = Math.max(0.05, half[1]), nx = Math.max(1, Math.ceil(2 * hx)), nz = Math.max(1, Math.ceil(2 * hz)), gs: number[] = [];
      for (let i = 0; i <= nx; i++) for (let j = 0; j <= nz; j++) { const h = ctx.ground(...localToWorld(c, yaw, [-hx + (2 * hx * i) / nx, -hz + (2 * hz * j) / nz])); if (h != null) gs.push(h); }
      // ... nor in one of the piece's own flat faces (its floor, a tread)
      const own = (req.flats ?? []).map((f2) => s.y + f2);
      const clash = (y: number) => gs.some((h) => Math.abs(h - y) < FOUNDATION_CAP_CLEAR_M) || own.some((h) => Math.abs(h - y) < FOUNDATION_CAP_CLEAR_M);
      // a piece with a FLOOR (grade > 0) covers its skirt itself: no cap at all (nothing to flicker with the ground or the slab)
      let cap = rule.grade <= 0 && f.cap !== false;
      // where the ground under the box reaches the cap's level, the cap goes over ALL of it (inside the piece's base, never
      // more than 0.1 m over its base plane): a cap the ground crosses meets it in a line of flicker
      // (by GROUND_MESH_TOL_M over the sampled ground: the voxel mesh stands a few cm off the field it is meshed from)
      const over = Math.max(...gs) + GROUND_MESH_TOL_M;
      // ... and never as a platform over the piece's declared base (0.15 m at most): where it cannot clear the ground there,
      // the skirt has no top (its walls carry the base; nothing lies in the ground's plane)
      if (cap && gs.some((h) => h > top - GROUND_MESH_TOL_M)) { if (over <= s.y + 0.15 && !clash(over)) top = over; else cap = false; }
      if (cap && clash(top)) {
        const up = [1, 2].map((n) => top + n * 2 * FOUNDATION_CAP_CLEAR_M).find((y) => y <= s.y + 0.1 + 1e-9 && !clash(y));
        top = up ?? [1, 2, 3, 4].map((n) => top - n * 2 * FOUNDATION_CAP_CLEAR_M).find((y) => !clash(y)) ?? top;
      }
      res.foundation = { of: req.id, box: { c: [r3(c[0]), r3(c[1])], half: [r3(Math.max(0.05, half[0])), r3(Math.max(0.05, half[1]))], yaw }, top: r3(top), bottom: r3(s.lo - f.depth), material: f.material, tile: f.tile, ...(cap ? {} : { cap: false }) };
      notes.push(`foundation skirt ${r3(top - (s.lo - f.depth))} m deep (${s.gap} m of daylight under its low side covered)`);
    }
    return res;
  }
  return { id: req.id, status: "dropped", reason: first ?? "no spot", notes };
}

/**
 * Solve a batch in order. Each placed piece becomes an obstacle for the ones after it (unless `mutual` is false or the
 * piece is bedded / on a host), so a batch never stacks two pieces in one spot.
 */
export function solvePlacements(reqs: PlaceRequest[], ctx: PlaceContext, o: { mutual?: boolean } = {}): PlaceResult[] {
  const obstacles = [...(ctx.obstacles ?? [])], out: PlaceResult[] = [];
  for (const req of reqs) {
    const r = solvePlacement(req, { ...ctx, obstacles });
    out.push(r);
    if ((o.mutual ?? true) && r.status !== "dropped" && !req.on && !placeRuleOf(req.rule).bedded && r.x !== undefined)
      obstacles.push({ id: req.id, box: { c: [r.x, r.z!], half: req.half, yaw: r.yaw! }, band: [r.y!, r.y! + req.height] });
  }
  return out;
}


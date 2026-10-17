import type { Quat, Vec3 } from "../math.js";
import { quatMultiply } from "../math.js";
import { hashUnit } from "./noise.js";
import type { WorldField, SurfaceSample } from "./field.js";
import type { ScatterDoc, ScatterFormationDoc } from "./recipe.js";

/**
 * FORMATIONS and WATER placement for scatter rules (recipe `formation`, `water`).
 *
 * Both are pure functions of the field and the anchor's lattice coordinate (`gx`, `gz`, the rule seed), like
 * every other scatter decision, so two cells solving the same anchor agree and only the owner emits it: no
 * doubles at a seam. Members are ordinary instances of the rule's models — they join the same instanced
 * batches — each seated on the ground under it (sunk by the rule's `yOffset`), all sharing the anchor's cap.
 */

export interface FormationMember {
  x: number;
  z: number;
  /** Ground height under the member (before the rule's yOffset). */
  ground: number;
  scale: number;
  rotation: Quat;
  /** Index into the member model list (memberVariants, else modelVariants), or undefined for the rule's model. */
  pick: number;
  /** A small member: no collider, culled with the full-render ring. */
  filler: boolean;
  /** True for the anchor itself (member 0). */
  anchor: boolean;
}

const UP: Vec3 = [0, 1, 0];

function quatYaw(angle: number): Quat {
  const h = angle / 2;
  return [0, Math.sin(h), 0, Math.cos(h)];
}

/** Rotation of `angle` about the horizontal axis (cos a, 0, sin a). */
function quatTilt(axisAngle: number, angle: number): Quat {
  const h = angle / 2;
  const s = Math.sin(h);
  return [Math.cos(axisAngle) * s, 0, Math.sin(axisAngle) * s, Math.cos(h)];
}

function quatFromTo(from: Vec3, to: Vec3): Quat {
  const dot = from[0] * to[0] + from[1] * to[1] + from[2] * to[2];
  if (dot > 0.999999) return [0, 0, 0, 1];
  if (dot < -0.999999) return [1, 0, 0, 0];
  const q: Quat = [from[1] * to[2] - from[2] * to[1], from[2] * to[0] - from[0] * to[2], from[0] * to[1] - from[1] * to[0], 1 + dot];
  const len = Math.hypot(q[0], q[1], q[2], q[3]);
  return [q[0] / len, q[1] / len, q[2] / len, q[3] / len];
}

function quatScaled(q: Quat, amount: number): Quat {
  const out: Quat = [q[0] * amount, q[1] * amount, q[2] * amount, q[3] * amount + (1 - amount)];
  const len = Math.hypot(out[0], out[1], out[2], out[3]) || 1;
  return [out[0] / len, out[1] / len, out[2] / len, out[3] / len];
}

function normalAt(field: WorldField, x: number, z: number): Vec3 {
  const e = Math.max(field.voxelSize, 0.5);
  const dx = (field.height(x + e, z) - field.height(x - e, z)) / (2 * e);
  const dz = (field.height(x, z + e) - field.height(x, z - e)) / (2 * e);
  const len = Math.hypot(-dx, 1, -dz);
  return [-dx / len, 1 / len, -dz / len];
}

const weighted = <T extends { weight: number }>(list: readonly T[], pick: number): number => {
  let remaining = pick * list.reduce((sum, v) => sum + v.weight, 0);
  for (let i = 0; i < list.length; i++) {
    remaining -= list[i]!.weight;
    if (remaining < 0) return i;
  }
  return list.length - 1;
};

/** Ground footprint radius (world m) of an instance of `rule` at `scale` (the same rule scatter's spacing uses). */
export function footprintRadius(rule: ScatterDoc, scale: number): number {
  return (rule.footprint > 0 ? rule.footprint : rule.colliderSize[0] * 0.5) * scale;
}

/** Farthest a formation's member can stand from its anchor, at the rule's largest scale (for the scatter margin). */
export function formationReach(rule: ScatterDoc, maxScale: number): number {
  const f = rule.formation;
  if (!f) return 0;
  const r = footprintRadius(rule, maxScale);
  const n = Math.max(f.members[0], f.members[1]);
  return Math.max(r * 2 * n * 0.6 + f.gap[1] * n, r * 3.5 + 1.5, f.kinds.some((k) => k.kind === "spill") ? r + f.spill : 0);
}

/**
 * The members of one formation anchored at (x, z). Member 0 is the anchor. `place(x, z)` returns the
 * seated ground height there, or null when a member may not stand there (water, too steep): that member is
 * dropped, the rest of the shape stays.
 */
export function formationMembers(
  field: WorldField,
  rule: ScatterDoc,
  f: ScatterFormationDoc,
  x: number,
  z: number,
  ground: number,
  scale: number,
  yaw: number,
  gx: number,
  gz: number,
  seed: number,
  place: (x: number, z: number, scale: number) => number | null,
  /** The water's current at the anchor (a river rule): `steps` run across it. */
  current?: readonly [number, number] | null,
): FormationMember[] {
  const h = (c: number) => hashUnit(gx, gz, 300 + c, seed);
  const kind = f.kinds[weighted(f.kinds, h(0))]!.kind;
  const ra = footprintRadius(rule, scale);
  const memberList = f.memberVariants ?? rule.modelVariants;
  const pick = (c: number) => (memberList ? weighted(memberList, h(c)) : -1);
  const n0 = normalAt(field, x, z);
  const flat = Math.hypot(n0[0], n0[2]);
  // strike: along the contour (perpendicular to downhill) or hashed
  const downhill: [number, number] = flat > 0.05 ? [n0[0] / flat, n0[2] / flat] : [Math.cos(h(1) * 6.283), Math.sin(h(1) * 6.283)];
  const strikeAngle = f.contour && flat > 0.05 ? Math.atan2(downhill[0], -downhill[1]) : h(2) * Math.PI * 2;
  const strike: [number, number] = [Math.cos(strikeAngle), Math.sin(strikeAngle)];
  const across: [number, number] = [-strike[1], strike[0]];
  const gap = (c: number) => f.gap[0] + (f.gap[1] - f.gap[0]) * h(c);
  const [lo, hi] = f.members;
  const count = (c: number, cap = Infinity) => Math.min(cap, Math.min(lo, hi) + Math.floor(h(c) * (Math.abs(hi - lo) + 1)));

  const out: FormationMember[] = [];
  const lay = rule.alignToNormal > 0 ? quatScaled(quatFromTo(UP, n0), rule.alignToNormal) : ([0, 0, 0, 1] as Quat);
  const seat = (px: number, pz: number, s: number, rot: Quat, p: number, isAnchor: boolean, groundY?: number) => {
    const g = groundY ?? place(px, pz, s);
    if (g === null) return;
    let rotation = rot;
    // one ground normal per formation (the anchor's): the members stand within a few metres of it
    if (rule.alignToNormal > 0) rotation = quatMultiply(lay, rotation);
    out.push({ x: px, z: pz, ground: g, scale: s, rotation, pick: p, filler: !isAnchor && s < scale * f.fillers, anchor: isAnchor });
  };
  const free = (c: number) => quatYaw(h(c) * Math.PI * 2);
  // shared strike orientation of a row: the model's X along the strike, then the band's lean about it
  const rowLean = (h(3) - 0.5) * 2 * f.lean;
  const strikeRot = (c: number) => quatMultiply(quatTilt(strikeAngle, rowLean), quatYaw(-strikeAngle + (h(c) - 0.5) * 0.3));

  switch (kind) {
    case "single":
      seat(x, z, scale, quatYaw(yaw), pick(10), true, ground);
      break;
    case "row": {
      const n = count(11);
      const mid = (n - 1) / 2;
      const sizes = Array.from({ length: n }, (_, i) => scale * (1 - f.taper * (mid > 0 ? Math.abs(i - mid) / mid : 0)) * (0.85 + 0.3 * h(20 + i)));
      const centre = Math.round(mid);
      sizes[centre] = scale; // the anchor is the biggest, mid-row
      const bend = (h(4) - 0.5) * 0.08;
      const at: number[] = new Array(n).fill(0);
      for (let i = centre + 1; i < n; i++) at[i] = at[i - 1]! + footprintRadius(rule, sizes[i - 1]!) + footprintRadius(rule, sizes[i]!) + gap(40 + i);
      for (let i = centre - 1; i >= 0; i--) at[i] = at[i + 1]! - footprintRadius(rule, sizes[i + 1]!) - footprintRadius(rule, sizes[i]!) - gap(40 + i);
      for (let i = 0; i < n; i++) {
        const d = at[i]!;
        const off = bend * d * d;
        seat(x + strike[0] * d + across[0] * off, z + strike[1] * d + across[1] * off, sizes[i]!, strikeRot(60 + i), pick(80 + i), i === centre, i === centre ? ground : undefined);
      }
      break;
    }
    case "cluster":
    case "spill": {
      seat(x, z, scale, quatYaw(yaw), pick(10), true, ground);
      const m = count(12, 5);
      const base = h(5) * Math.PI * 2;
      for (let i = 0; i < m; i++) {
        const s = scale * (1 - f.taper) * (0.75 + 0.6 * h(20 + i));
        const a = base + (i / m) * Math.PI * 2 + (h(30 + i) - 0.5) * 0.9;
        // tucked against the anchor's base, overlapping it
        const d = ra * (0.7 + 0.25 * h(40 + i)) + footprintRadius(rule, s) * 0.3;
        seat(x + Math.cos(a) * d, z + Math.sin(a) * d, s, free(60 + i), pick(80 + i), false);
      }
      if (kind === "spill") {
        const trail = 3 + Math.floor(h(13) * 4);
        for (let j = 0; j < trail; j++) {
          const t = (j + 1) / trail;
          const s = scale * (0.45 - 0.25 * t) * (0.8 + 0.4 * h(100 + j));
          const d = ra + t * f.spill;
          const side = (h(110 + j) - 0.5) * 2 * (0.4 + t) * ra;
          seat(x + downhill[0] * d + across[0] * side, z + downhill[1] * d + across[1] * side, s, free(120 + j), pick(130 + j), false);
        }
      }
      break;
    }
    case "stack": {
      seat(x, z, scale, quatYaw(yaw), pick(10), true, ground);
      const leaners = h(14) < 0.45 ? 2 : 1; // two = a tent
      for (let i = 0; i < leaners; i++) {
        const a = strikeAngle + Math.PI / 2 + i * Math.PI + (h(30 + i) - 0.5) * 0.4;
        const s = scale * (0.6 + 0.25 * h(20 + i));
        const d = ra * 0.85 + footprintRadius(rule, s) * 0.2;
        // tipped TOWARD the anchor: about the horizontal axis perpendicular to the direction to it
        const tilt = quatTilt(a + Math.PI / 2, -(0.45 + f.lean));
        seat(x + Math.cos(a) * d, z + Math.sin(a) * d, s, quatMultiply(tilt, quatYaw(-a)), pick(80 + i), false);
      }
      break;
    }
    case "steps": {
      // stepping stones: even sizes and gaps, across the current (else along the contour), from the anchor out to
      // both sides; a stone the gate refuses (deep water, a bank too high) leaves a gap, the run carries on
      const cl = current ? Math.hypot(current[0], current[1]) : 0;
      const dir: [number, number] = cl > 1e-3 ? [-current![1] / cl, current![0] / cl] : strike;
      const n = count(16);
      const yawAcross = -Math.atan2(dir[1], dir[0]);
      seat(x, z, scale, quatYaw(yawAcross + (h(17) - 0.5) * 0.8), pick(10), true, ground);
      for (const side of [1, -1]) {
        let d = 0, prev = scale;
        for (let i = 1; i <= Math.floor((n - 1 + (side > 0 ? 1 : 0)) / 2); i++) {
          const s = scale * (0.8 + 0.3 * h(20 + i * 2 + (side > 0 ? 0 : 1)));
          d += footprintRadius(rule, prev) + footprintRadius(rule, s) + gap(40 + i * 2 + (side > 0 ? 0 : 1));
          prev = s;
          // a step wanders a hand off the line, never a stride
          const off = (h(60 + i * 2 + (side > 0 ? 0 : 1)) - 0.5) * 0.6;
          seat(x + dir[0] * d * side - dir[1] * off, z + dir[1] * d * side + dir[0] * off, s, quatYaw(yawAcross + (h(70 + i) - 0.5) * 0.8), pick(80 + i * 2 + (side > 0 ? 0 : 1)), false);
        }
      }
      break;
    }
    case "arc": {
      const n = count(15) + 2;
      const radius = ra * 2.2 + 1.5;
      const start = h(6) * Math.PI * 2;
      const broken = Math.floor(h(7) * n);
      // the anchor is ON the ring, the ring's centre beside it
      const cx = x - Math.cos(start + Math.PI / 2) * radius, cz = z - Math.sin(start + Math.PI / 2) * radius;
      for (let i = 0; i < n; i++) {
        if (i === broken && i !== Math.floor(n / 2)) continue;
        const a = start + (i / Math.max(1, n - 1)) * Math.PI;
        const isAnchor = i === Math.floor(n / 2);
        const s = isAnchor ? scale : scale * (1 - f.taper * h(20 + i));
        const px = isAnchor ? x : cx + Math.cos(a) * radius, pz = isAnchor ? z : cz + Math.sin(a) * radius;
        seat(px, pz, s, quatYaw(-a + (h(60 + i) - 0.5) * 0.5), pick(80 + i), isAnchor, isAnchor ? ground : undefined);
      }
      break;
    }
  }
  // a formation always has its anchor: if a later member displaced it (row/arc reordering), keep one
  if (!out.some((m) => m.anchor) && out.length) out[0]!.anchor = true;
  return out;
}

const waterScratch: SurfaceSample = { y: 0, flowX: 0, flowZ: 0, kind: "lake", floor: 0 };

/** Lake/sea water level at (x, z), or null (no water, or a river's): what a shore rock's reach probes ask. */
export type LakeProbe = (x: number, z: number) => number | null;

/**
 * The unmemoised probe (a scatter cell passes a memoised one, `lakeProbeMemo`): a lake's level (`lakeY`, no ground
 * read), else the sea where the ground there is under it. `coast` false skips the sea test (and its height read):
 * the caller knows the coast is out of reach.
 */
export function lakeProbe(field: WorldField, coast = true): LakeProbe {
  const sea = field.recipe.seaLevel;
  return (x, z) => {
    const lake = field.lakeY(x, z);
    if (lake !== null) return lake;
    return coast && field.height(x, z) < sea ? sea : null;
  };
}

/**
 * The probe on a 2 m world lattice, memoised for one scatter cell: a shore formation's anchor and every member ask
 * the same eight-bearing ring, so neighbouring rings share most of their reads. Snapping to WORLD multiples keeps it
 * a pure function of position (two cells solving the same candidate agree).
 */
export function lakeProbeMemo(field: WorldField, coast = true): LakeProbe {
  const raw = lakeProbe(field, coast);
  const memo = new Map<number, number | null>();
  return (x, z) => {
    const qx = Math.round(x / 2), qz = Math.round(z / 2);
    const key = (qx & 0xffff) * 65536 + (qz & 0xffff);
    const hit = memo.get(key);
    if (hit !== undefined) return hit;
    const v = raw(qx * 2, qz * 2);
    memo.set(key, v);
    return v;
  };
}

/** The lake/sea level a SHORE rock at (x, z) belongs to: the water here, else the first of eight probes at `reach`. */
export function shoreLevel(field: WorldField, x: number, z: number, reach: number, probe: LakeProbe): number | null {
  const here = field.waterY(x, z);
  if (here !== null) return here;
  for (let k = 0; k < 8; k++) {
    const a = (k / 8) * Math.PI * 2;
    const level = probe(x + Math.cos(a) * reach, z + Math.sin(a) * reach);
    if (level !== null) return level;
  }
  return null;
}

/**
 * The water gate for a rule with `water`: null to drop the candidate, else the (possibly re-fitted) scale.
 * `height` is the model's height in model units (the rule's collider Y over 0.92: the kit's colliders are
 * 92 % of the bounds). A rock in the water must break the surface by `top`, never drown or float.
 */
export function waterPlacement(
  field: WorldField,
  rule: ScatterDoc,
  x: number,
  z: number,
  ground: number,
  scale: number,
  keep: number,
  probe: LakeProbe = lakeProbe(field),
  /** shore + snap: the waterline this candidate was moved onto (scatter's per-cell grid), instead of the probes. */
  shore?: ShorePoint | null,
): number | null {
  const w = rule.water!;
  // the outer bank of a river bend: bigger and more often (0..1 of a full bend)
  const bendAt = (bx: number, bz: number): number => (w.bend ? Math.min(1, outerBend(field, bx, bz) / w.bend.turn) : 0);
  const height = Math.max(0.1, rule.colliderSize[1] / 0.92);
  const fit = (surface: number, s0: number, maxDepth: number): number | null => {
    const depth = surface - ground;
    if (depth < 0.05 || depth > maxDepth) return null;
    const lo = rule.scale[0], hi = rule.scale[1] * (s0 > rule.scale[1] ? s0 / rule.scale[1] : 1);
    const topAt = (s: number) => ground + rule.yOffset * s + height * s - surface;
    let s = s0;
    if (topAt(s) < w.top[0]) s = (w.top[0] + depth - 0) / Math.max(0.05, height + rule.yOffset);
    if (topAt(s) > w.top[1]) s = (w.top[1] + depth) / Math.max(0.05, height + rule.yOffset);
    if (s < lo * 0.8 || s > hi * 1.25) return null;
    const top = topAt(s);
    return top >= w.top[0] - 1e-3 && top <= w.top[1] + 1e-3 ? s : null;
  };
  switch (w.mode) {
    case "shore": {
      if (shore) {
        // a waterline from the cell grid: lake, sea or river bank
        if (shore.level - ground > 0.6 || ground > shore.level + 0.9) return null;
        let odds = 0.2 + w.steepness * field.slope(x, z) + w.headland * Math.max(0, (shore.wet - 0.5) * 2);
        let s = scale;
        if (shore.kind === 2 && w.bend) {
          const b = bendAt(x, z);
          odds *= 1 + (w.bend.boost - 1) * b;
          s *= 1 + (w.bend.scale - 1) * b;
        }
        return keep < Math.min(1, odds * w.keep) ? s : null;
      }
      // not IN the water (that is "in") and not a river bank (that is "river"): a lake/sea edge within reach
      const level = shoreLevel(field, x, z, w.reach, probe);
      if (level !== null && level - ground > 0.6) return null;
      if (level === null || ground > level + 0.9) return null;
      // steep banks and headlands dense, gentle beaches sparse
      const odds = Math.min(1, 0.2 + w.steepness * field.slope(x, z));
      return keep < odds ? scale : null;
    }
    case "in": {
      const y = field.waterY(x, z);
      if (y === null) return null;
      const surface = field.waterSurface(x, z, waterScratch) ? waterScratch.kind : null;
      // the sea (no surface) and lakes count as "lake"; a river's channel only when the rule asks for rivers
      const kind = surface === "river" ? "river" : surface === "marsh" ? null : "lake";
      if (kind === null || (w.waters !== "both" && w.waters !== kind)) return null;
      if (keep >= w.keep) return null;
      return fit(y, scale, w.maxDepth);
    }
    case "river": {
      if (!field.waterSurface(x, z, waterScratch)) return null;
      const surface = waterScratch.y;
      let s = scale, maxDepth = w.maxDepth, pool = false;
      for (const fall of field.falls) {
        // a plunge pool may be solved as a level pool (lake kind): it counts as the river here
        if (Math.hypot(fall.x - x, fall.z - z) < w.fall.radius && surface < fall.top && (waterScratch.kind === "river" || waterScratch.kind === "lake")) {
          s *= w.fall.scale;
          maxDepth = w.fall.maxDepth;
          pool = true;
          break;
        }
      }
      if (w.fall.only && !pool) return null;
      if (!pool && waterScratch.kind !== "river") return null;
      let odds = w.keep;
      if (!pool && w.bend) {
        const b = bendAt(x, z);
        odds *= 1 + (w.bend.boost - 1) * b;
        s *= 1 + (w.bend.scale - 1) * b;
      }
      if (keep >= Math.min(1, odds)) return null;
      return fit(surface, s, maxDepth);
    }
    case "marsh": {
      const table = field.marshTable(x, z);
      if (table === null) return null;
      return fit(table, scale, w.maxDepth);
    }
  }
}

// ---------------------------------------------------------------------------------------------------------------
// SHORELINES, precomputed per scatter cell (water `snap`): one water read per point of a world-aligned grid over
// the cell and its margin, instead of eight reach probes per candidate. A shore candidate then moves onto the
// nearest waterline crossing of that grid (a lake's, the sea's or a river's bank), so every survivor stands AT the
// edge, its rows strike along it, and the grid also says how far the water wraps round the spot (a headland).
// The grid is world-aligned and every crossing is a pure function of its two grid points, so two cells solving the
// same candidate agree.

/** 0 dry (or no water reaches), 1 lake/sea, 2 river. */
export type ShoreKind = 0 | 1 | 2;

export interface ShoreGrid {
  step: number;
  /** World lattice index of the first column/row. */
  i0: number;
  j0: number;
  nx: number;
  nz: number;
  /** Water depth (surface minus ground) per point; <= 0 is dry ground, -1 also where no water reaches at all. */
  depth: Float32Array;
  level: Float32Array;
  kind: Uint8Array;
  /** Any wet point at all (a dry grid answers every query with null at once). */
  any: boolean;
}

const gridScratch: SurfaceSample = { y: 0, flowX: 0, flowZ: 0, kind: "lake", floor: 0 };

/** The grid over [x0, x1] x [z0, z1] at `step` m. `coast` false skips the sea test (no ground read off the water). */
export function buildShoreGrid(field: WorldField, x0: number, z0: number, x1: number, z1: number, step: number, coast: boolean): ShoreGrid {
  const i0 = Math.floor(x0 / step), j0 = Math.floor(z0 / step);
  const nx = Math.ceil(x1 / step) - i0 + 1, nz = Math.ceil(z1 / step) - j0 + 1;
  const depth = new Float32Array(nx * nz).fill(-1);
  const level = new Float32Array(nx * nz);
  const kind = new Uint8Array(nx * nz);
  const sea = field.recipe.seaLevel;
  let any = false;
  for (let j = 0; j < nz; j++) {
    for (let i = 0; i < nx; i++) {
      const x = (i0 + i) * step, z = (j0 + j) * step;
      const k = j * nx + i;
      let y: number | null = null;
      let river = false;
      if (field.waterSurface(x, z, gridScratch) && gridScratch.kind !== "marsh" && gridScratch.y > sea + 0.05) {
        y = gridScratch.y;
        river = gridScratch.kind === "river";
      }
      if (y === null && !coast) continue;
      const g = field.height(x, z);
      if (y === null) {
        if (g >= sea) continue;
        y = sea;
      }
      depth[k] = y - g;
      level[k] = y;
      if (y - g > 0) {
        kind[k] = river ? 2 : 1;
        any = true;
      }
    }
  }
  return { step, i0, j0, nx, nz, depth, level, kind, any };
}

export interface ShorePoint {
  x: number;
  z: number;
  level: number;
  kind: ShoreKind;
  /** Unit direction from the bank into the water. */
  inX: number;
  inZ: number;
  /** Share of the grid points within `ring` m that are water: over 0.5 the water wraps round (a headland, a spit). */
  wet: number;
  /** Depth gained per metre into the water along the crossing's grid edge (for `refineShore`). */
  grade: number;
}

/**
 * The waterline crossing of `grid` nearest (x, z) within `reach`, of a kind `waters` allows (bit 1 lakes/sea, bit 2
 * rivers), or null. A crossing is where the depth changes sign along a grid edge, placed by linear interpolation.
 */
export function nearestShore(grid: ShoreGrid, x: number, z: number, reach: number, waters: number, ring: number): ShorePoint | null {
  if (!grid.any) return null;
  const { step, i0, j0, nx, nz, depth, kind } = grid;
  const ia = Math.max(0, Math.floor((x - reach) / step) - i0), ib = Math.min(nx - 1, Math.ceil((x + reach) / step) - i0);
  const ja = Math.max(0, Math.floor((z - reach) / step) - j0), jb = Math.min(nz - 1, Math.ceil((z + reach) / step) - j0);
  let best = reach * reach, bx = 0, bz = 0, bk = 0, bw = -1, inDX = 0, inDZ = 0, grade = 0;
  const edge = (a: number, b: number, ax: number, az: number, dx: number, dz: number) => {
    const da = depth[a]!, db = depth[b]!;
    if ((da > 0) === (db > 0)) return;
    const w = da > 0 ? a : b;
    const kw = kind[w]!;
    if (!(kw & waters)) return;
    const t = da / (da - db);
    const cx = ax + dx * t, cz = az + dz * t;
    const d2 = (cx - x) * (cx - x) + (cz - z) * (cz - z);
    if (d2 >= best) return;
    best = d2; bx = cx; bz = cz; bk = kw; bw = w; grade = Math.abs(da - db) / step;
    // into the water: toward the wet end of the edge
    const s = w === a ? -1 : 1;
    inDX = dx * s; inDZ = dz * s;
  };
  for (let j = ja; j <= jb; j++) {
    for (let i = ia; i <= ib; i++) {
      const k = j * nx + i;
      const ax = (i0 + i) * step, az = (j0 + j) * step;
      if (i < ib) edge(k, k + 1, ax, az, step, 0);
      if (j < jb) edge(k, k + nx, ax, az, 0, step);
    }
  }
  if (bw < 0) return null;
  // how far the water wraps round: the wet share of the grid points within `ring`
  let wetN = 0, all = 0;
  const r = Math.max(step, ring);
  const ra = Math.max(0, Math.floor((bx - r) / step) - i0), rb = Math.min(nx - 1, Math.ceil((bx + r) / step) - i0);
  const sa = Math.max(0, Math.floor((bz - r) / step) - j0), sb = Math.min(nz - 1, Math.ceil((bz + r) / step) - j0);
  for (let j = sa; j <= sb; j++) {
    for (let i = ra; i <= rb; i++) {
      const px = (i0 + i) * step - bx, pz = (j0 + j) * step - bz;
      if (px * px + pz * pz > r * r) continue;
      all++;
      if (depth[j * nx + i]! > 0) wetN++;
    }
  }
  const len = Math.hypot(inDX, inDZ) || 1;
  return { x: bx, z: bz, level: grid.level[bw]!, kind: bk as ShoreKind, inX: inDX / len, inZ: inDZ / len, wet: all ? wetN / all : 0.5, grade };
}

/**
 * Walk a grid crossing onto the real waterline: the grid interpolates the depth linearly over a whole step, which
 * on a river's V bank can miss the edge by metres. Two secant steps along the crossing's edge direction, one
 * height read each, moving at most half a grid step each time. Mutates and returns `p`.
 */
export function refineShore(field: WorldField, p: ShorePoint, step: number): ShorePoint {
  let grade = Math.max(0.02, p.grade);
  let prevD = NaN, prevT = 0, t = 0;
  for (let k = 0; k < 2; k++) {
    const d = p.level - field.height(p.x + p.inX * t, p.z + p.inZ * t);
    if (Math.abs(d) < 0.08) break;
    if (k > 0 && Number.isFinite(prevD) && Math.abs(d - prevD) > 1e-3 && t !== prevT) grade = Math.max(0.02, Math.abs((d - prevD) / (t - prevT)));
    prevD = d; prevT = t;
    // wet here (d > 0): the edge is back toward the land, against the in-direction
    t += Math.max(-step * 0.5, Math.min(step * 0.5, -d / grade));
  }
  p.x += p.inX * t;
  p.z += p.inZ * t;
  return p;
}

// ---------------------------------------------------------------------------------------------------------------
// RIVER BENDS (water `bend`): every solved river's centreline, each point carrying how far the channel turns over
// the 25 m either side of it (signed: + is a left turn), bucketed once per field. A rock on the OUTER bank of a
// bend (where the current drives into the bank) is drawn bigger and kept more often.

interface BendPoint {
  x: number;
  z: number;
  /** Signed turn, radians, over the 50 m round the point. */
  turn: number;
  /** Unit tangent, downstream. */
  tx: number;
  tz: number;
  /** Half the channel width plus its bank: how far from the line a point still belongs to this river. */
  half: number;
}

const BEND_BUCKET = 32;
const bendIndexes = new WeakMap<WorldField, Map<number, BendPoint[]>>();

function bendIndex(field: WorldField): Map<number, BendPoint[]> {
  let index = bendIndexes.get(field);
  if (index) return index;
  index = new Map();
  for (const river of field.rivers) {
    const p = river.points as readonly (readonly [number, number])[];
    if (p.length < 3) continue;
    const L: number[] = [0];
    for (let i = 1; i < p.length; i++) L.push(L[i - 1]! + Math.hypot(p[i]![0] - p[i - 1]![0], p[i]![1] - p[i - 1]![1]));
    const total = L[p.length - 1]!;
    const at = (d: number): [number, number] => {
      let k = 1;
      while (k < p.length - 1 && L[k]! < d) k++;
      const t = (d - L[k - 1]!) / Math.max(1e-6, L[k]! - L[k - 1]!);
      return [p[k - 1]![0] + (p[k]![0] - p[k - 1]![0]) * t, p[k - 1]![1] + (p[k]![1] - p[k - 1]![1]) * t];
    };
    const widths = (river as { widths?: readonly number[] }).widths;
    for (let i = 0; i < p.length; i++) {
      const d = L[i]!;
      const a = at(Math.max(0, d - 25)), c = at(Math.min(total, d + 25));
      const b = p[i]!;
      const ux = b[0] - a[0], uz = b[1] - a[1], vx = c[0] - b[0], vz = c[1] - b[1];
      const turn = Math.hypot(ux, uz) > 1 && Math.hypot(vx, vz) > 1 ? Math.atan2(ux * vz - uz * vx, ux * vx + uz * vz) : 0;
      const tl = Math.hypot(c[0] - a[0], c[1] - a[1]) || 1;
      const half = (widths?.[i] ?? river.width ?? 8) * 0.5 + 6;
      const point: BendPoint = { x: b[0], z: b[1], turn, tx: (c[0] - a[0]) / tl, tz: (c[1] - a[1]) / tl, half };
      const key = ((Math.floor(b[0] / BEND_BUCKET) & 0xffff) << 16) | (Math.floor(b[1] / BEND_BUCKET) & 0xffff);
      const list = index.get(key);
      if (list) list.push(point);
      else index.set(key, [point]);
    }
  }
  bendIndexes.set(field, index);
  return index;
}

/**
 * How much of a bend (x, z) stands on the OUTER bank of: the river's turn (radians over 50 m) at the nearest
 * centreline point when (x, z) is on its outer side, else 0 (inner bank, a straight reach, or no river near).
 */
export function outerBend(field: WorldField, x: number, z: number): number {
  const index = bendIndex(field);
  const bx = Math.floor(x / BEND_BUCKET), bz = Math.floor(z / BEND_BUCKET);
  let best = Infinity;
  let hit: BendPoint | null = null;
  for (let dz = -1; dz <= 1; dz++) {
    for (let dx = -1; dx <= 1; dx++) {
      const list = index.get((((bx + dx) & 0xffff) << 16) | ((bz + dz) & 0xffff));
      if (!list) continue;
      for (const p of list) {
        const d2 = (p.x - x) * (p.x - x) + (p.z - z) * (p.z - z);
        if (d2 < best && d2 < p.half * p.half) {
          best = d2;
          hit = p;
        }
      }
    }
  }
  if (!hit) return 0;
  // left of the downstream line is +: the outer bank of a left turn is its right side
  const side = hit.tx * (z - hit.z) - hit.tz * (x - hit.x);
  return side * hit.turn < 0 ? Math.abs(hit.turn) : 0;
}

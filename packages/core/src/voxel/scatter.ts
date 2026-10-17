/**
 * World scatter: trees, rocks, bushes on the voxel surface.
 *
 * The hard requirement is **chunk-independence**. A tree must land in exactly
 * the same spot whether you walked into its cell from the north or the south,
 * whether its cell loaded first or twelfth, and whether the CLI or the browser
 * asked. So there is no per-chunk RNG stream: every candidate is a point on a
 * GLOBAL lattice, and everything about it — jitter, species, scale, yaw — is a
 * pure hash of its lattice coordinate. A cell simply enumerates the lattice
 * points that belong to it. Two neighbouring cells therefore cannot disagree,
 * and there is no seam of doubled or missing trees along a chunk edge.
 *
 * Ownership rule: a candidate belongs to the cell containing its UNJITTERED
 * lattice point, so jitter may push an instance slightly past the cell border.
 * That is intentional — the alternative (clamping to the cell) puts a visible
 * grid of tree-free gutters along every chunk boundary. A cliff column walks
 * further out than jitter does (it marches downhill to find the face), which is
 * why `cliff.search` is capped by advice at a fraction of a cell: the further a
 * prop lands from its owning lattice point, the more it pops when that cell
 * unloads while the one it visually belongs to stays resident.
 */

import type { Quat, Vec3 } from "../math.js";
import { quatMultiply } from "../math.js";
import { hashUnit, clamp, fbm2, smoothstep, type FbmSpec } from "./noise.js";
import type { SurfaceSample, WorldField } from "./field.js";
import type { ScatterDoc } from "./recipe.js";
import type { RockCap, VegetationTint } from "../components/core.js";
import { rockCapResolver, rockSkinProbe } from "./rock-cap.js";
import { buildShoreGrid, formationMembers, formationReach, lakeProbeMemo, nearestShore, refineShore, shoreLevel, waterPlacement, type LakeProbe, type ShoreGrid, type ShorePoint } from "./formations.js";
import { vegetationIndex, type VegetationPlan } from "./vegetation.js";
import { seatObject, type SolidProbe } from "./seat.js";

export interface VoxelScatterInstance {
  /** Rule that produced it — the scatter rule's `id`. */
  rule: string;
  ruleIndex: number;
  /** Stable, collision-proof id derived from the lattice coordinate. */
  id: string;
  /** Position LOCAL to the cell origin (matching how chunk docs store transforms). */
  position: Vec3;
  rotation: Quat;
  scale: number;
  /** Biome the ground under it resolved to — useful for later filtering/debug. */
  biome: string;
  vegetationTint?: VegetationTint;
  /** Index into the rule's `modelVariants` (a separate stable hash; absent = the rule's `model`). */
  variant?: number;
  /** The rock's cap and body base (rock-cap.ts), for rules with `cap` or `rockBase`. */
  rockCap?: RockCap;
  /** A formation member's own model (from `formation.memberVariants`), overriding the rule's. */
  model?: string;
  colliderSize?: [number, number, number];
  /** A small formation member: no collider, `hlod: false`. */
  filler?: boolean;
}

export interface ScatterCellOptions {
  /** Skip the (expensive) overhang-aware surface raymarch; use the heightfield. */
  fastGround?: boolean;
  /** false: skip seating rocks on their footprint (seat.ts) — only for measuring what the old placement did. */
  seat?: boolean;
  /** Hard cap per cell, as a runaway guard against a mis-typed density. */
  maxInstances?: number;
}

const UP: Vec3 = [0, 1, 0];
const riverScratch: SurfaceSample = { y: 0, flowX: 0, flowZ: 0, kind: "lake", floor: 0 };

function colorVariant(rule: ScatterDoc, pick: number): VegetationTint | undefined {
  const variants = rule.colorVariants;
  if (!variants) return undefined;
  let remaining = pick * variants.reduce((sum, v) => sum + v.weight, 0);
  for (const v of variants) {
    remaining -= v.weight;
    if (remaining < 0) return v.tint;
  }
  return variants[variants.length - 1]!.tint;
}

/** Which of the rule's `modelVariants` a pick in [0, 1) lands on (weighted). */
export function modelVariantIndex(rule: ScatterDoc, pick: number): number | undefined {
  const variants = rule.modelVariants;
  if (!variants || variants.length === 0) return undefined;
  let remaining = pick * variants.reduce((sum, v) => sum + v.weight, 0);
  for (let i = 0; i < variants.length; i++) {
    remaining -= variants[i]!.weight;
    if (remaining < 0) return i;
  }
  return variants.length - 1;
}

function scaleMultiplier(rule: ScatterDoc, pick: number): number {
  const variants = rule.scaleVariants;
  if (!variants) return 1;
  let remaining = pick * variants.reduce((sum, variant) => sum + variant.weight, 0);
  for (const variant of variants) {
    remaining -= variant.weight;
    if (remaining < 0) return variant.multiplier;
  }
  return variants[variants.length - 1]!.multiplier;
}

function maxScale(rule: ScatterDoc): number {
  if (!rule.scaleVariants) return rule.scale[1];
  return Math.max(...rule.scale) * Math.max(...rule.scaleVariants.map((variant) => variant.multiplier));
}

/**
 * Radius of the ground an instance actually STANDS on, in world units: the
 * trunk of a tree (its cylinder/capsule collider), the narrow side of a rock's
 * box, half the footprint disc of a collider-less bush. Smaller than the
 * spacing footprint, which is the canopy's claim on its neighbours, not what
 * holds it up. `scatter-float` and the footing test share it.
 */
export function scatterFooting(rule: ScatterDoc, scale: number): number {
  if (rule.collider === "box") return Math.min(rule.colliderSize[0], rule.colliderSize[2]) * 0.5 * scale;
  if (rule.collider !== "none") return rule.colliderSize[0] * 0.5 * scale;
  return (rule.footprint > 0 ? rule.footprint : rule.colliderSize[0] * 0.5) * 0.5 * scale;
}

/** How a rule's instances are seated (`ScatterDoc.contact`): rocks embed, plants and cliff stacks stand by their centre. */
export function scatterContact(rule: ScatterDoc): "embed" | "none" {
  if (rule.contact) return rule.contact;
  if (rule.cliff) return "none";
  return /rock|boulder|outcrop|scree|hoodoo|stone|crag|talus/i.test(`${rule.id} ${rule.model}`) ? "embed" : "none";
}

/**
 * The cheap solid scatter seats by: the real top through carves (`editedGround`), else the planar-aware ground.
 * The gate (`worldgen float`) re-measures with the field's density (`fieldSolidProbe`), so the two are checked
 * against each other.
 */
export function scatterGroundProbe(field: WorldField): SolidProbe {
  return {
    floor(x, z, hi, lo) {
      const e = editedGround(field, x, z, 0);
      const g = e === undefined ? field.ground(x, z) : e;
      if (g === null) return null;
      if (g > hi) return hi;
      return g >= lo ? g : null;
    },
  };
}

/** Footprint half extents and height of a rule's instance (its collider, scaled). */
export function scatterSeatSize(rule: ScatterDoc, scale: number, colliderSize?: readonly [number, number, number]): { halfX: number; halfZ: number; height: number } {
  const s = colliderSize ?? rule.colliderSize;
  if (rule.collider === "box") return { halfX: s[0] * 0.5 * scale, halfZ: s[2] * 0.5 * scale, height: s[1] * scale };
  const r = (rule.collider === "none" && rule.footprint > 0 ? rule.footprint * 0.5 : s[0] * 0.5) * scale;
  return { halfX: r, halfZ: r, height: s[1] * scale };
}

/**
 * Seat one rock instance (`contact: embed`) on the ground under its footprint: the corrected base y, or null to
 * drop it (it straddles an edge or has too little ground). `base` is where the rule put it (centre ground + yOffset).
 */
function seatRock(probe: SolidProbe, rule: ScatterDoc, x: number, z: number, base: number, yaw: number, scale: number, colliderSize?: readonly [number, number, number]): number | null {
  const size = scatterSeatSize(rule, scale, colliderSize);
  const r = seatObject(probe, { x, z, y: base, yaw, ...size, align: rule.alignToNormal }, "embed", { embed: Math.max(0.05, -rule.yOffset * 0.5), reachDown: Math.max(4, size.height * 2) });
  return r.status === "unsupported" ? null : (r.y ?? base);
}

/** Yaw (radians) of a quaternion about +Y, enough to orient a footprint. */
function quatYawOf(q: Quat): number {
  return Math.atan2(2 * (q[3] * q[1] + q[0] * q[2]), 1 - 2 * (q[1] * q[1] + q[2] * q[2]));
}

/** How far a footing ring may fall away below the base beyond what its slope explains, in metres. */
export const FOOTING_OPEN = 1.0;
/** Drop allowed per metre of footing radius for ordinary slope (a 50° bank), before OPEN applies. */
const FOOTING_SLOPE = 1.2;
/** Solid rock a plant must have under its base where a carve is near: a lintel over a cave mouth is not ground. */
const FOOTING_DEPTH = 1.5;

/**
 * The ground a plant at (x, z) stands on where a 3D terrain edit is near.
 *
 * `height()` is a heightfield: it never sees a passage, a tunnel or a
 * subtracting blob, and the overhang-aware `surfaceCast` only searches a few
 * metres either side of it. So a cave mouth, a cutting or a hollowed lip
 * leaves the heightfield standing in mid-air, and anything placed by it
 * floats there. Here the column is cast through the carve's whole vertical
 * span, and the footing is checked:
 *
 *  - `undefined`: no carve reaches the footing — the caller's own answer is
 *    the truth, untouched (this is what keeps every unedited world identical);
 *  - `null`: the footing was removed or opened — nothing solid in the column,
 *    less than FOOTING_DEPTH of rock under the base (a lintel, a thin roof),
 *    or a point of the footing ring at `radius` drops away by more than its
 *    slope explains (the lip of a cutting, the rim of a mouth) — so DROP it;
 *  - a number: the real top surface, which is where it stands.
 *
 * Shared by scatter (props, with the trunk/collider radius) and the
 * ground-cover sampler (per 2 m probe), so both read one rule.
 */
export function editedGround(field: WorldField, x: number, z: number, radius: number): number | null | undefined {
  const span = carveNear(field, x, z, radius);
  if (!span) return undefined;
  const y = castThrough(field, x, z, span);
  if (y === null || !footingHolds(field, x, z, y, radius, span)) return null;
  return y;
}

type Span = { min: number; max: number };

/**
 * The carve span reaching a footing of `radius` at (x, z), or null where no
 * carve can touch the surface: none in plan, or one wholly buried deeper than
 * the cast window plus the footing depth (a tunnel under a hill), or wholly
 * in the air above it. Null means the plain answer is exact — the ordinary
 * cast searches the same band and meets the same rock first.
 */
function carveNear(field: WorldField, x: number, z: number, radius: number): Span | null {
  const reach = radius + 1;
  const span = field.carveSpan(x - reach, z - reach, x + reach, z + reach);
  if (!span) return null;
  const window = field.recipe.terrain.overhang.strength * 1.5 + 2;
  const h = field.height(x, z);
  // the ring may stand on lower (or higher) ground than the centre: allow a
  // steep bank's worth across the radius on top of the cast window
  const band = window + FOOTING_DEPTH + 2 * radius + 2;
  if (span.max < h - band || span.min > h + band) return null;
  return span;
}

/** Topmost solid surface at (x, z), searched through the whole carve span as well as the overhang band. */
function castThrough(field: WorldField, x: number, z: number, span: Span): number | null {
  const window = field.recipe.terrain.overhang.strength * 1.5 + 2;
  const h = field.height(x, z);
  return field.surfaceCast(x, z, Math.max(h + window, span.max + 1), Math.min(h - window, span.min - 2));
}

/** Rock under the base, and no point of the footing ring falling away (see `editedGround`). */
function footingHolds(field: WorldField, x: number, z: number, y: number, radius: number, span: Span): boolean {
  if (field.density(x, y - FOOTING_DEPTH * 0.5, z) >= 0 || field.density(x, y - FOOTING_DEPTH, z) >= 0) return false;
  if (radius <= 0) return true;
  const allowed = FOOTING_OPEN + FOOTING_SLOPE * radius;
  for (let k = 0; k < 8; k++) {
    const a = (k / 8) * Math.PI * 2;
    const g = castThrough(field, x + Math.cos(a) * radius, z + Math.sin(a) * radius, span);
    if (g === null || y - g > allowed) return false;
  }
  return true;
}

/**
 * Planar ground a prop may stand on: rock a voxel deep under eight points a voxel out. The treads, lips and
 * ledges of planar cliffs are exact planes in the field, but the mesh is built on that voxel lattice, so a lip
 * or ledge narrower than a voxel is not in the mesh at all (measured: props stood 5-11 m over the mesh on
 * them) — and a prop a voxel from a tread's edge stands on the mesh's rounded rim. Both are refused here.
 */
function planarFootingHolds(field: WorldField, x: number, y: number, z: number): boolean {
  return field.planarFooting(x, y, z, field.voxelSize);
}

/**
 * A cluster member's cap (a column, a crest/foot cluster, an edge run): the first piece's, so the cluster reads as one
 * — unless THIS piece stands on stone or on a climate band (snow, a river's gravel), where the cap follows the ground
 * it stands on (a talus piece rolled into a plunge pool wore its anchor's moss on the pool's gravel). The shared cap
 * is kept for the pieces after it.
 */
function memberCap(shared: { rockCap?: RockCap }, field: WorldField, rule: ScatterDoc, x: number, y: number, z: number): { rockCap?: RockCap } {
  if (!rule.cap || !shared.rockCap?.amount) return shared;
  const band = rockSkinProbe(field).groundBand(x, y, z).band;
  return band === "bare" || band === "climate" ? withRockCap(field, rule, x, y, z) : shared;
}

/** The `rockCap` field of an emitted instance, or nothing for a rule that never caps. */
function withRockCap(field: WorldField, rule: ScatterDoc, x: number, y: number, z: number): { rockCap?: RockCap } {
  if (!rule.cap && rule.rockBase === undefined && !rule.rockBaseByCliff) return {};
  const cap = rockCapResolver(field)(rule, x, y, z);
  return cap ? { rockCap: cap } : {};
}

/**
 * A water rule's rock with its WATERLINE (cap `wet`): the surface over its foot as a fraction of its height, so the
 * rock-cap shader darkens the stone below it and a hand above. One water read per rock; dry rocks unchanged.
 */
function withWet(
  field: WorldField,
  rule: ScatterDoc,
  cap: { rockCap?: RockCap },
  x: number,
  z: number,
  footY: number,
  scale: number,
  colliderSize: readonly number[] | undefined,
): { rockCap?: RockCap } {
  const surface = rule.water!.mode === "marsh" ? field.marshTable(x, z) : field.waterY(x, z);
  if (surface === null) return cap;
  const size = colliderSize ?? rule.colliderSize;
  const wet = (surface - footY) / Math.max(0.05, (size[1]! / 0.92) * scale);
  if (wet <= 0.02) return cap;
  const base = cap.rockCap ?? { layer: 0, amount: 0, base: rule.rockBase ?? 0 };
  return { rockCap: { ...base, wet: Math.round(Math.min(1, wet) * 200) / 200 } };
}

/** Rotation whose Y axis is `y` and whose X axis is `x` made orthogonal to it (both unit-ish). */
function quatFromBasisYX(y: Vec3, x: Vec3): Quat {
  const d = x[0] * y[0] + x[1] * y[1] + x[2] * y[2];
  let ax: Vec3 = [x[0] - y[0] * d, x[1] - y[1] * d, x[2] - y[2] * d];
  const l = Math.hypot(ax[0], ax[1], ax[2]);
  if (l < 1e-6) return quatFromTo(UP, y);
  ax = [ax[0] / l, ax[1] / l, ax[2] / l];
  const az: Vec3 = [ax[1] * y[2] - ax[2] * y[1], ax[2] * y[0] - ax[0] * y[2], ax[0] * y[1] - ax[1] * y[0]];
  // rotation matrix columns ax, y, az -> quaternion
  const m00 = ax[0], m11 = y[1], m22 = az[2];
  const tr = m00 + m11 + m22;
  let q: Quat;
  if (tr > 0) {
    const s = Math.sqrt(tr + 1) * 2;
    q = [(y[2] - az[1]) / s, (az[0] - ax[2]) / s, (ax[1] - y[0]) / s, 0.25 * s];
  } else if (m00 > m11 && m00 > m22) {
    const s = Math.sqrt(1 + m00 - m11 - m22) * 2;
    q = [0.25 * s, (y[0] + ax[1]) / s, (az[0] + ax[2]) / s, (y[2] - az[1]) / s];
  } else if (m11 > m22) {
    const s = Math.sqrt(1 + m11 - m00 - m22) * 2;
    q = [(y[0] + ax[1]) / s, 0.25 * s, (az[1] + y[2]) / s, (az[0] - ax[2]) / s];
  } else {
    const s = Math.sqrt(1 + m22 - m00 - m11) * 2;
    q = [(az[0] + ax[2]) / s, (az[1] + y[2]) / s, 0.25 * s, (ax[1] - y[0]) / s];
  }
  const n = Math.hypot(q[0], q[1], q[2], q[3]) || 1;
  return [q[0] / n, q[1] / n, q[2] / n, q[3] / n];
}

/** Quaternion rotating `from` onto `to`, both unit vectors. */
function quatFromTo(from: Vec3, to: Vec3): Quat {
  const dot = from[0] * to[0] + from[1] * to[1] + from[2] * to[2];
  if (dot > 0.999999) return [0, 0, 0, 1];
  if (dot < -0.999999) return [1, 0, 0, 0]; // 180 degrees about any perpendicular axis
  const cx = from[1] * to[2] - from[2] * to[1];
  const cy = from[2] * to[0] - from[0] * to[2];
  const cz = from[0] * to[1] - from[1] * to[0];
  const q: Quat = [cx, cy, cz, 1 + dot];
  const len = Math.hypot(q[0], q[1], q[2], q[3]);
  return [q[0] / len, q[1] / len, q[2] / len, q[3] / len];
}

function quatYaw(angle: number): Quat {
  const h = angle / 2;
  return [0, Math.sin(h), 0, Math.cos(h)];
}

/** Rotation of `angle` about a horizontal axis at `axisAngle` — the cliff rocks' random tumble. */
function quatTilt(axisAngle: number, angle: number): Quat {
  const h = angle / 2;
  const s = Math.sin(h);
  return [Math.cos(axisAngle) * s, 0, Math.sin(axisAngle) * s, Math.cos(h)];
}

/** Blend a rotation toward identity — cheap nlerp, adequate for prop tilt. */
function quatScaled(q: Quat, amount: number): Quat {
  const out: Quat = [q[0] * amount, q[1] * amount, q[2] * amount, q[3] * amount + (1 - amount)];
  const len = Math.hypot(out[0], out[1], out[2], out[3]) || 1;
  return [out[0] / len, out[1] / len, out[2] / len, out[3] / len];
}

/**
 * Where the face crosses height `y`, marching outward from a clifftop point.
 *
 * The surface at (x, z) is above `y` — we are standing on the rim — so walking
 * downhill must eventually reach ground at or below it. The first crossing is
 * the face; one bisection pass refines it to well under a voxel. Returns null
 * when the march runs out of reach, which is the honest signal that the cliff
 * has bottomed out and the stack should stop rather than march off into a
 * meadow.
 *
 * This reads the HEIGHTFIELD, not the density field: it is several times
 * cheaper, it is the same surface `slope()` and the rest of scatter reason
 * about, and the metre or so an overhang would move the answer is absorbed by
 * `embed` — which is pushing the prop into the rock anyway.
 */
function faceAtHeight(
  field: WorldField,
  x: number,
  z: number,
  dx: number,
  dz: number,
  y: number,
  reach: number,
): { x: number; z: number } | null {
  const step = Math.max(field.voxelSize, 1);
  let prev = 0;
  for (let t = step; t <= reach; t += step) {
    if (airAt(field, x + dx * t, z + dz * t, y)) {
      let lo = prev;
      let hi = t;
      for (let i = 0; i < 6; i++) {
        const mid = (lo + hi) / 2;
        if (airAt(field, x + dx * mid, z + dz * mid, y)) hi = mid;
        else lo = mid;
      }
      return { x: x + dx * hi, z: z + dz * hi };
    }
    prev = t;
  }
  return null;
}

/**
 * Is (x, y, z) out in front of the ground? The heightfield's answer, except where planar cliffs rebuild it: a
 * wall can stand metres off the heightfield's riser (a jog, a chimney, a ledge), so there the density decides.
 */
function airAt(field: WorldField, x: number, z: number, y: number): boolean {
  return field.planarNear(x, z) ? field.density(x, y, z) > 0 : field.height(x, z) <= y;
}

/** Surface normal from the heightfield derivative — good enough for prop tilt. */
function groundNormal(field: WorldField, x: number, z: number): Vec3 {
  // planar cliffs: the treads and walls are not the heightfield — take the real surface's own normal
  if (field.planarNear(x, z)) return field.surfaceNormal(x, field.ground(x, z), z);
  const e = Math.max(field.voxelSize, 0.5);
  const dx = (field.ground(x + e, z) - field.ground(x - e, z)) / (2 * e);
  const dz = (field.ground(x, z + e) - field.ground(x, z - e)) / (2 * e);
  const len = Math.hypot(-dx, 1, -dz);
  return [-dx / len, 1 / len, -dz / len];
}

/**
 * One lattice point's worth of cliff-face props: a column bedded into the face.
 *
 * Deliberately outside the XZ occupancy map that the flat rules share. That map
 * is a plan-view spacing test, and a stack is by construction several props at
 * nearly the same (x, z) — it would reject its own second rock. Cliff rules
 * live on ground steeper than anything else scatters on, so there is nothing
 * there to space against anyway.
 */
function emitCliffColumn(
  field: WorldField,
  rule: ScatterDoc,
  ruleIndex: number,
  gx: number,
  gz: number,
  ruleSeed: number,
  wx: number,
  wz: number,
  x0: number,
  z0: number,
  out: VoxelScatterInstance[],
): void {
  const cliff = rule.cliff!;
  const topY = field.ground(wx, wz);

  // downhill is the horizontal part of the surface normal — the direction the
  // face presents to the world, and the direction a prop's front should look
  const rim = groundNormal(field, wx, wz);
  const flat = Math.hypot(rim[0], rim[2]);
  if (flat < 1e-4) return; // dead level: no face to hang anything on
  const dx = rim[0] / flat;
  const dz = rim[2] / flat;
  if (cliff.fit) {
    emitCliffMass(field, rule, ruleIndex, gx, gz, ruleSeed, wx, wz, topY, dx, dz, x0, z0, out);
    return;
  }

  // does this face actually fall far enough to be worth dressing? (edge modes: up AND down the fall line, two reads,
  // before they walk to the crest and the foot)
  if (cliff.mode === "face") {
    if (topY - field.ground(wx + dx * cliff.search, wz + dz * cliff.search) < cliff.minDrop) return;
  } else if (field.ground(wx - dx * cliff.search, wz - dz * cliff.search) - field.ground(wx + dx * cliff.search, wz + dz * cliff.search) < cliff.minDrop * 0.5) {
    return;
  }

  const [stackLo, stackHi] = cliff.stack;
  const pick = hashUnit(gx, gz, 11, ruleSeed);
  const count = Math.min(stackLo, stackHi) + Math.floor(pick * (Math.abs(stackHi - stackLo) + 1));
  if (cliff.mode === "crest" || cliff.mode === "foot") {
    emitCliffEdge(field, rule, ruleIndex, gx, gz, ruleSeed, wx, wz, dx, dz, count, x0, z0, out);
    return;
  }

  let y = topY;
  let lastBand = Infinity;
  let columnCap: { rockCap?: RockCap } | undefined;
  for (let k = 0; k < count; k++) {
    const c = 20 + k * 8;
    const h1 = hashUnit(gx, gz, c + 1, ruleSeed);
    const h2 = hashUnit(gx, gz, c + 2, ruleSeed);
    const h3 = hashUnit(gx, gz, c + 3, ruleSeed);
    const h4 = hashUnit(gx, gz, c + 4, ruleSeed);
    const h5 = hashUnit(gx, gz, c + 5, ruleSeed);
    const h6 = hashUnit(gx, gz, c + 6, ruleSeed);
    const h7 = hashUnit(gx, gz, c + 7, ruleSeed);

    y -= cliff.spacing * (1 + (h1 - 0.5) * 2 * cliff.spacingJitter);
    // strata: snap to a world level so every column of the face lines its rocks up at the same heights
    const at = cliff.band > 0 ? Math.round(y / cliff.band) * cliff.band + (h7 - 0.5) * cliff.band * 0.12 : y;
    if (cliff.band > 0) {
      if (Math.abs(at - lastBand) < cliff.band * 0.5) continue;
      lastBand = at;
    }
    const face = faceAtHeight(field, wx, wz, dx, dz, at, cliff.search);
    if (!face) return; // the face ran out below us — the cliff has bottomed out

    // the face turns as it descends; take its own normal, not the rim's
    const normal = groundNormal(field, face.x, face.z);
    const nFlat = Math.hypot(normal[0], normal[2]);
    const ox = nFlat > 1e-4 ? normal[0] / nFlat : dx;
    const oz = nFlat > 1e-4 ? normal[2] / nFlat : dz;

    const scale = (rule.scale[0] + (rule.scale[1] - rule.scale[0]) * h4)
      * scaleMultiplier(rule, rule.scaleVariants ? hashUnit(gx, gz, c + 8, ruleSeed) : 0);
    // embed is a depth INTO THE MODEL, so it scales with the instance the way
    // yOffset does: resizing a rock must not leave it hanging off the face
    const embed = (cliff.embed + (h2 - 0.5) * 2 * cliff.embedJitter) * scale;
    const slide = (h3 - 0.5) * 2 * cliff.lateral;
    // "normal": sunk along the face's own 3D normal; "lean": pushed in horizontally
    const deep = cliff.orient === "normal";
    const px = face.x - (deep ? normal[0] : ox) * embed - oz * slide;
    const pz = face.z - (deep ? normal[2] : oz) * embed + ox * slide;
    const py = deep ? at - normal[1] * embed : at;

    // biome only when the rule filters by it (an unfiltered cliff rule skips the evaluation)
    if (rule.height && (at < rule.height[0] || at > rule.height[1])) continue;
    const sample = rule.biomes.length > 0 ? field.biome(px, pz, at, field.slope(px, pz)) : { id: "" };
    if (rule.biomes.length > 0 && !rule.biomes.includes(sample.id)) continue;

    // +Z out of the face, softened by faceOut and wobbled by yawSpread; a model
    // whose front is not +Z is corrected once, on the rule, with yawOffset
    const outYaw = Math.atan2(ox, oz);
    const free = (h5 - 0.5) * 2 * Math.PI;
    const yaw = outYaw + free * (1 - cliff.faceOut) + (h6 - 0.5) * 2 * cliff.yawSpread + rule.yawOffset;
    let rotation = quatYaw(yaw);
    if (deep) {
      // the model's up on the face normal, spun freely about it (a facet, not a menhir)
      // the model's up on the face normal and its long (X) axis along the face's horizontal run, give or take
      // `yawSpread`: the facets lie as ledges that line up with their neighbours in the band (strata)
      rotation = quatMultiply(quatFromBasisYX(normal, [-oz, 0, ox]), quatYaw((h6 - 0.5) * 2 * cliff.yawSpread * 0.3 + rule.yawOffset));
    } else if (cliff.tilt > 0) {
      rotation = quatMultiply(quatTilt(h7 * Math.PI * 2, (h4 - 0.5) * 2 * cliff.tilt), rotation);
    }
    // tip back into the face: about the horizontal axis perpendicular to the
    // outward direction, which carries the prop's up axis toward -outward
    const lean = deep ? 0 : cliff.lean + (h5 - 0.5) * 2 * cliff.leanJitter;
    if (lean !== 0) rotation = quatMultiply(quatTilt(Math.atan2(ox, -oz), lean), rotation);
    if (!deep && rule.alignToNormal > 0) {
      rotation = quatMultiply(quatScaled(quatFromTo(UP, normal), rule.alignToNormal), rotation);
    }

    out.push({
      rule: rule.id,
      ruleIndex,
      id: `${rule.id}_${gx}_${gz}_${k}`,
      position: [px - x0, py + rule.yOffset * scale, pz - z0],
      rotation,
      scale,
      biome: sample.id,
      ...(rule.colorVariants ? { vegetationTint: colorVariant(rule, hashUnit(gx, gz, 10000 + k, ruleSeed)) } : {}),
      ...(rule.modelVariants ? { variant: modelVariantIndex(rule, hashUnit(gx, gz, 20000 + k, ruleSeed)) } : {}),
      // one cap per column, resolved at its first prop: the band shares it
      ...memberCap((columnCap ??= withRockCap(field, rule, px, py, pz)), field, rule, px, py, pz),
    });
  }
}

/** sin(angle) of a rise over a run: the units `slope()` reports. */
const sinOf = (rise: number, run: number): number => {
  const g = Math.abs(rise) / run;
  return g / Math.sqrt(1 + g * g);
};

/**
 * Where the ground stops falling, walking downhill from (x, z): the cliff's foot, or null within `reach`.
 * ONE height read per 2 m step (the steepness is the fall between consecutive reads along the walk, which is
 * the fall line's own slope): four times cheaper than asking `slope()` at every step.
 */
function cliffFoot(field: WorldField, x: number, z: number, dx: number, dz: number, reach: number, startSteep = false, step = 2): { x: number; z: number; y: number } | null {
  let steep = startSteep;
  let prev = field.ground(x, z);
  for (let t = step; t <= reach; t += step) {
    const px = x + dx * t, pz = z + dz * t;
    const h = field.ground(px, pz);
    const s = sinOf(prev - h, step);
    if (s > 0.6) steep = true;
    else if (steep && s < 0.35) return { x: px, z: pz, y: h };
    prev = h;
  }
  return null;
}

/** The cliff's top edge: walking UPHILL from (x, z) until the ground levels out (one height read per step, as cliffFoot). */
function cliffCrest(field: WorldField, x: number, z: number, dx: number, dz: number, reach: number, step = 1.5): { x: number; z: number; y: number } | null {
  let prev = field.ground(x, z);
  for (let t = step; t <= reach; t += step) {
    const px = x - dx * t, pz = z - dz * t;
    const h = field.ground(px, pz);
    if (sinOf(h - prev, step) < 0.45) return { x: px + dx * step, z: pz + dz * step, y: prev };
    prev = h;
  }
  return null;
}

/** Where the face crosses height `y` along the fall line through (x, z): downhill if the ground here is above `y`, else uphill. */
function faceAt(field: WorldField, x: number, z: number, dx: number, dz: number, y: number, reach: number): { x: number; z: number } | null {
  const here = field.ground(x, z);
  if (Math.abs(here - y) < 1e-3) return { x, z };
  const sign = here > y ? 1 : -1;
  const step = Math.max(field.voxelSize, 1);
  let prev = 0;
  for (let t = step; t <= reach; t += step) {
    if ((field.ground(x + sign * dx * t, z + sign * dz * t) - y) * sign <= 0) {
      let lo = prev, hi = t;
      for (let i = 0; i < 5; i++) {
        const mid = (lo + hi) / 2;
        if ((field.ground(x + sign * dx * mid, z + sign * dz * mid) - y) * sign <= 0) hi = mid;
        else lo = mid;
      }
      return { x: x + sign * dx * hi, z: z + sign * dz * hi };
    }
    prev = t;
  }
  return null;
}

/**
 * The variant and scale that make a piece `target` metres along `axis` (cliff `fit`): among the rule's variants
 * whose own size needs a scale inside `fit.scale`, a weighted pick by `pick`; past the largest, the largest clamped
 * down; under the smallest (by more than the scale range allows), null: the drop is too small for this rule.
 */
function fitVariant(rule: ScatterDoc, target: number, pick: number): { variant?: number; scale: number; size: Vec3 } | null {
  const fit = rule.cliff!.fit!;
  const along = fit.axis === "length" ? 0 : 1;
  const sizeOf = (c: readonly number[]): Vec3 => [c[0]! / 0.92, c[1]! / 0.92, c[2]! / 0.92];
  const list = rule.modelVariants;
  const [lo, hi] = fit.scale;
  if (!list || list.length === 0) {
    const size = sizeOf(rule.colliderSize);
    const s = target / size[along]!;
    return s < lo * 0.8 ? null : { scale: clamp(s, lo, hi), size };
  }
  let total = 0;
  let smallest = Infinity, largest = -1, largestAt = 0;
  const sizes = list.map((v, i) => {
    const size = sizeOf(v.colliderSize ?? rule.colliderSize);
    const s = target / size[along]!;
    if (s >= lo && s <= hi) total += v.weight;
    smallest = Math.min(smallest, size[along]!);
    if (size[along]! > largest) {
      largest = size[along]!;
      largestAt = i;
    }
    return size;
  });
  if (total > 0) {
    let remaining = pick * total;
    for (let i = 0; i < list.length; i++) {
      const s = target / sizes[i]![along]!;
      if (s < lo || s > hi) continue;
      remaining -= list[i]!.weight;
      if (remaining < 0) return { variant: i, scale: s, size: sizes[i]! };
    }
  }
  if (target / smallest < lo * 0.8) return null;
  if (target / largest > hi) return { variant: largestAt, scale: hi, size: sizes[largestAt]! };
  // between two variants' ranges: the nearest in log-scale, clamped
  let best = 0, bestErr = Infinity;
  sizes.forEach((size, i) => {
    const s = target / size[along]!;
    const err = Math.abs(Math.log(clamp(s, lo, hi) / s));
    if (err < bestErr) {
      bestErr = err;
      best = i;
    }
  });
  return { variant: best, scale: clamp(target / sizes[best]![along]!, lo, hi), size: sizes[best]! };
}

/**
 * CLIFF-SCALE MASSES (cliff `fit`): one lattice point on a cliff becomes one to `stack` big pieces sized from the
 * local drop. Face mode puts the first AT the lattice point's own spot on the face (a ledge band snaps to the
 * nearest `band` level first) and the rest below it down the fall line, overlapping into a rib; crest mode
 * stands them on the lip. Pure function of the field and the lattice hash, owned by the lattice point's cell.
 */
function emitCliffMass(
  field: WorldField,
  rule: ScatterDoc,
  ruleIndex: number,
  gx: number,
  gz: number,
  ruleSeed: number,
  wx: number,
  wz: number,
  hereY: number,
  dx: number,
  dz: number,
  x0: number,
  z0: number,
  out: VoxelScatterInstance[],
): void {
  const cliff = rule.cliff!;
  const fit = cliff.fit!;
  // the cheap test first: does the fall line drop at least half of minDrop across +-search? (two reads)
  if (field.ground(wx - dx * cliff.search, wz - dz * cliff.search) - field.ground(wx + dx * cliff.search, wz + dz * cliff.search) < cliff.minDrop * 0.5) return;
  // a mass needs the drop to a few metres only: 3 m steps (a 45 m walk is 15 reads)
  const crest = cliffCrest(field, wx, wz, dx, dz, fit.reach, 3);
  const foot = crest && cliffFoot(field, wx, wz, dx, dz, fit.reach, true, 3);
  if (!crest || !foot) return;
  const drop = crest.y - foot.y;
  if (drop < cliff.minDrop) return;
  // crest pieces stand on a real CLIFF TOP only: the ground behind the lip stays near its height (not a break of
  // slope on a long hillside, where a tooth reads as a tombstone) and it falls away hard just past the lip
  if (cliff.mode === "crest") {
    if (field.ground(crest.x - dx * 12, crest.z - dz * 12) - crest.y > 4) return;
    if (crest.y - field.ground(crest.x + dx * 8, crest.z + dz * 8) < Math.min(6, cliff.minDrop * 0.4)) return;
  }
  const [stackLo, stackHi] = cliff.stack;
  const count = Math.min(stackLo, stackHi) + Math.floor(hashUnit(gx, gz, 11, ruleSeed) * (Math.abs(stackHi - stackLo) + 1));
  // crest clusters run ALONG the lip with uneven gaps (a missing tooth now and then), never an even spine
  let along = (hashUnit(gx, gz, 12, ruleSeed) - 0.5) * 2 * cliff.lateral;
  const outYaw = Math.atan2(dx, dz);
  let cap: { rockCap?: RockCap } | undefined;
  // face mode: the first piece's foot at a hashed height on the drop (fit.at), found on the fall line through the
  // lattice point; a near-vertical wall has almost no plan area of its own, so its candidates come from the rounded
  // ground above and below it (slopeMin well under the wall's) and are carried onto the wall here
  let at = fit.at ? foot.y + drop * (fit.at[0] + (fit.at[1] - fit.at[0]) * hashUnit(gx, gz, 89, ruleSeed)) : hereY;
  for (let k = 0; k < count; k++) {
    const c = 90 + k * 9;
    const h1 = hashUnit(gx, gz, c + 1, ruleSeed);
    const h2 = hashUnit(gx, gz, c + 2, ruleSeed);
    const h3 = hashUnit(gx, gz, c + 3, ruleSeed);
    const h4 = hashUnit(gx, gz, c + 4, ruleSeed);
    const h5 = hashUnit(gx, gz, c + 5, ruleSeed);
    const h6 = hashUnit(gx, gz, c + 6, ruleSeed);
    const target = drop * (fit.fraction[0] + (fit.fraction[1] - fit.fraction[0]) * h4);
    const fitted = fitVariant(rule, target, hashUnit(gx, gz, c + 7, ruleSeed));
    if (!fitted) return;
    const { scale, size } = fitted;
    const slide = (h3 - 0.5) * 2 * cliff.lateral;
    let rotation: Quat;
    let px: number, py: number, pz: number;
    if (cliff.mode === "crest") {
      // on the lip, pushed back over it by `embed` (model units), leaning out over the drop
      const back = (cliff.embed + (h2 - 0.5) * 2 * cliff.embedJitter) * scale;
      if (k > 0) along += size[0] * scale * (0.55 + 1.1 * h3) * (hashUnit(gx, gz, c + 8, ruleSeed) < 0.5 ? 1 : -1.6);
      if (k > 0 && hashUnit(gx, gz, c + 9, ruleSeed) < 0.22) continue;
      px = crest.x - dx * back - dz * along;
      pz = crest.z - dz * back + dx * along;
      py = field.ground(px, pz);
      rotation = quatYaw(outYaw + (h6 - 0.5) * 2 * cliff.yawSpread + rule.yawOffset);
      if (cliff.tilt > 0) rotation = quatMultiply(quatTilt(Math.atan2(dz, dx), (h1 - 0.5) * 2 * cliff.tilt), rotation);
      const lean = cliff.lean + (h5 - 0.5) * 2 * cliff.leanJitter;
      if (lean !== 0) rotation = quatMultiply(quatTilt(Math.atan2(dx, -dz), -lean), rotation);
    } else {
      // face: the first piece at the lattice point (or its band level), the next ones down the fall line
      const pieceH = size[1] * scale;
      // (banded pieces, the ledges, step down whole bands: one or two strata lower)
      if (k > 0) at -= cliff.band > 0 ? cliff.band * (1 + Math.floor(h1 * 2)) : pieceH * fit.overlap * (0.85 + 0.3 * h1);
      let y = at;
      if (cliff.band > 0) y = Math.round(at / cliff.band) * cliff.band + (h1 - 0.5) * cliff.band * 0.12;
      // the piece stays ON the face: its foot above the cliff's foot, its top under the crest plus a little
      y = Math.min(y, crest.y - pieceH * (cliff.orient === "slope" ? 0.55 : 0.25));
      if (y < foot.y - pieceH * 0.15) return;
      const face = k === 0 && Math.abs(y - hereY) < 1e-3 ? { x: wx, z: wz } : faceAt(field, wx, wz, dx, dz, y, fit.reach * 2);
      if (!face) return;
      const normal = groundNormal(field, face.x, face.z);
      const nFlat = Math.hypot(normal[0], normal[2]);
      const ox = nFlat > 1e-4 ? normal[0] / nFlat : dx;
      const oz = nFlat > 1e-4 ? normal[2] / nFlat : dz;
      const embed = (cliff.embed + (h2 - 0.5) * 2 * cliff.embedJitter) * scale;
      if (cliff.orient === "slope") {
        // Y up the fall line, Z out along the normal, X along the face (X = Y x Z); sunk along the normal
        const t: Vec3 = [-ox * normal[1], nFlat, -oz * normal[1]];
        const tl = Math.hypot(t[0], t[1], t[2]) || 1;
        const tu: Vec3 = [t[0] / tl, t[1] / tl, t[2] / tl];
        const xa: Vec3 = [tu[1] * normal[2] - tu[2] * normal[1], tu[2] * normal[0] - tu[0] * normal[2], tu[0] * normal[1] - tu[1] * normal[0]];
        rotation = quatMultiply(quatFromBasisYX(tu, xa), quatYaw((h6 - 0.5) * 2 * cliff.yawSpread * 0.3 + rule.yawOffset));
        px = face.x - normal[0] * embed - oz * slide;
        pz = face.z - normal[2] * embed + ox * slide;
        py = y - normal[1] * embed;
      } else {
        rotation = quatYaw(Math.atan2(ox, oz) + (h6 - 0.5) * 2 * cliff.yawSpread + rule.yawOffset);
        if (cliff.tilt > 0) rotation = quatMultiply(quatTilt(h1 * Math.PI * 2, (h4 - 0.5) * 2 * cliff.tilt), rotation);
        const lean = cliff.lean + (h5 - 0.5) * 2 * cliff.leanJitter;
        if (lean !== 0) rotation = quatMultiply(quatTilt(Math.atan2(ox, -oz), lean), rotation);
        px = face.x - ox * embed - oz * slide;
        pz = face.z - oz * embed + ox * slide;
        py = y;
      }
    }
    const water = field.waterY(px, pz);
    if (water !== null && py < water) continue;
    if (rule.height && (py < rule.height[0] || py > rule.height[1])) continue;
    const sample = rule.biomes.length > 0 ? field.biome(px, pz, py, field.slope(px, pz)) : { id: "" };
    if (rule.biomes.length > 0 && !rule.biomes.includes(sample.id)) continue;
    out.push({
      rule: rule.id,
      ruleIndex,
      id: `${rule.id}_${gx}_${gz}_m${k}`,
      position: [px - x0, py + rule.yOffset * scale, pz - z0],
      rotation,
      scale,
      biome: sample.id,
      ...(fitted.variant !== undefined ? { variant: fitted.variant } : {}),
      ...memberCap((cap ??= withRockCap(field, rule, px, py, pz)), field, rule, px, py, pz),
    });
  }
}

/**
 * Crest and foot props of one cliff lattice point (see `cliff.mode`). Every position is a pure function of
 * the field and the lattice hash, owned by the lattice point's cell like the face columns, so two cells
 * never disagree. Ground-standing: the rule's `yOffset` sinks them, colliders follow the usual contract.
 */
function emitCliffEdge(
  field: WorldField,
  rule: ScatterDoc,
  ruleIndex: number,
  gx: number,
  gz: number,
  ruleSeed: number,
  wx: number,
  wz: number,
  dx: number,
  dz: number,
  count: number,
  x0: number,
  z0: number,
  out: VoxelScatterInstance[],
): void {
  const cliff = rule.cliff!;
  // a 60 m cliff at 55 degrees runs 40 m: walk far enough for the big ones (3 m steps, one height read each)
  const reach = Math.max(cliff.search * 3, 45);
  const crest = cliff.mode === "crest" ? cliffCrest(field, wx, wz, dx, dz, reach, 3) : { x: wx, z: wz, y: field.ground(wx, wz) };
  const foot = crest && cliffFoot(field, wx, wz, dx, dz, reach, false, 3);
  if (!crest || !foot) return;
  const height = crest.y - foot.y;
  if (height < cliff.minDrop) return;
  const outYaw = Math.atan2(dx, dz);
  let edgeCap: { rockCap?: RockCap } | undefined;
  for (let k = 0; k < count; k++) {
    const c = 60 + k * 8;
    const h1 = hashUnit(gx, gz, c + 1, ruleSeed);
    const h2 = hashUnit(gx, gz, c + 2, ruleSeed);
    const h3 = hashUnit(gx, gz, c + 3, ruleSeed);
    const h4 = hashUnit(gx, gz, c + 4, ruleSeed);
    const h5 = hashUnit(gx, gz, c + 5, ruleSeed);
    const h6 = hashUnit(gx, gz, c + 6, ruleSeed);
    let scale = (rule.scale[0] + (rule.scale[1] - rule.scale[0]) * h4)
      * scaleMultiplier(rule, rule.scaleVariants ? hashUnit(gx, gz, c + 7, ruleSeed) : 0);
    const slide = (h3 - 0.5) * 2 * cliff.lateral;
    let px: number, pz: number;
    let rotation: Quat;
    if (cliff.mode === "crest") {
      // on the lip, pushed back over it by `embed` (model units) so the base is on the top, not in the air
      const back = (cliff.embed + (h2 - 0.5) * 2 * cliff.embedJitter) * scale;
      px = crest.x - dx * back - dz * slide;
      pz = crest.z - dz * back + dx * slide;
      const yaw = outYaw + (h6 - 0.5) * 2 * cliff.yawSpread + rule.yawOffset;
      rotation = quatYaw(yaw);
      // a sideways roll only (about the outward axis), so it can never cancel the lean out
      if (cliff.tilt > 0) rotation = quatMultiply(quatTilt(Math.atan2(dz, dx), (h1 - 0.5) * 2 * cliff.tilt), rotation);
      // lean OUT over the drop: the negative of the face columns' tip-back
      const lean = cliff.lean + (h5 - 0.5) * 2 * cliff.leanJitter;
      if (lean !== 0) rotation = quatMultiply(quatTilt(Math.atan2(dx, -dz), -lean), rotation);
    } else {
      // talus: out from the foot, bigger blocks further out (they rolled further)
      const reach = Math.max(2, height * cliff.apron);
      const t = Math.pow(h2, 0.8);
      const d = 0.5 + t * reach;
      px = foot.x + dx * d - dz * slide * (0.5 + t);
      pz = foot.z + dz * d + dx * slide * (0.5 + t);
      scale *= 0.7 + 0.7 * t;
      rotation = quatYaw(h6 * Math.PI * 2);
      if (cliff.tilt > 0) rotation = quatMultiply(quatTilt(h1 * Math.PI * 2, (h5 - 0.5) * 2 * cliff.tilt), rotation);
    }
    if (field.waterY(px, pz) !== null) continue;
    const ground = field.ground(px, pz);
    if (rule.height && (ground < rule.height[0] || ground > rule.height[1])) continue;
    const sample = rule.biomes.length > 0 ? field.biome(px, pz, ground, field.slope(px, pz)) : { id: "" };
    if (rule.biomes.length > 0 && !rule.biomes.includes(sample.id)) continue;
    if (rule.alignToNormal > 0) rotation = quatMultiply(quatScaled(quatFromTo(UP, groundNormal(field, px, pz)), rule.alignToNormal), rotation);
    out.push({
      rule: rule.id,
      ruleIndex,
      id: `${rule.id}_${gx}_${gz}_${cliff.mode}${k}`,
      position: [px - x0, ground + rule.yOffset * scale, pz - z0],
      rotation,
      scale,
      biome: sample.id,
      ...(rule.colorVariants ? { vegetationTint: colorVariant(rule, hashUnit(gx, gz, 10000 + c, ruleSeed)) } : {}),
      ...(rule.modelVariants ? { variant: modelVariantIndex(rule, hashUnit(gx, gz, 20000 + c, ruleSeed)) } : {}),
      ...memberCap((edgeCap ??= withRockCap(field, rule, px, ground, pz)), field, rule, px, ground, pz),
    });
  }
}

/**
 * Every scattered instance belonging to cell (cx, cz).
 *
 * Spacing is SIZE-AWARE: each instance claims a disc of its own footprint
 * (`footprint` x scale, or half the collider width), and two instances may
 * come no closer than the sum of their footprints plus `spacing`. Rules are
 * solved largest-footprint first, so a tree claims its ground before the
 * shrubs fill in around it — array order only breaks ties.
 *
 * Density is UNIFORM per rule by construction, which is what makes a
 * generated forest read as an orchard. Two fields grade it without breaking
 * any of the above, because both are pure functions of the lattice point and
 * the world position: `clump` (an fBm mask — groves with clearings between)
 * and `biomeDensity` (per-biome thinning). Both only ever THIN: `density`
 * fixes the lattice before either is evaluated, so it is the peak.
 *
 * Candidates from a MARGIN around the cell are solved too (and then dropped),
 * so a prop just over the border in the next cell claims its ground here as
 * well. Every candidate is a pure hash of its lattice point, so both cells
 * evaluate the same neighbours in the same global order and agree; a chain of
 * dependencies longer than the margin can still, rarely, cost a prop at a
 * seam — it never doubles one.
 */
export function scatterCell(
  field: WorldField,
  cx: number,
  cz: number,
  options: ScatterCellOptions = {},
): VoxelScatterInstance[] {
  const recipe = field.recipe;
  const rules = recipe.scatter;
  if (rules.length === 0) return [];

  const cellSize = recipe.cellSize;
  const x0 = cx * cellSize;
  const z0 = cz * cellSize;
  const x1 = x0 + cellSize;
  const z1 = z0 + cellSize;
  const maxInstances = options.maxInstances ?? 4000;
  const overhangs = recipe.terrain.overhang.strength > 0;
  // rocks are seated on the ground under their whole footprint (seat.ts): sunk where the ground falls below their
  // underside, dropped where they straddle a step taller than themselves. A preview (fastGround) skips it.
  const seatProbe = options.fastGround || options.seat === false ? null : scatterGroundProbe(field);
  // shaped sea stacks (terrain.seaCliffs[].stacks.shape): nothing grows on a boulder apron round a stack's foot
  const seaBare = field.seaCliffs?.()?.shaped ? field.seaCliffs()! : null;
  const limit = field.worldLimit;
  // nothing exists past the world's edge; skip the whole solve for cells out there
  if (limit !== Infinity && Math.hypot(Math.max(Math.abs(x0), Math.abs(x1)), Math.max(Math.abs(z0), Math.abs(z1))) > limit) return [];

  /** Footprint radius in world units for a rule at scale 1. */
  const baseFootprint = (rule: ScatterDoc): number =>
    rule.footprint > 0 ? rule.footprint : rule.colliderSize[0] * 0.5;
  // largest first, stable by array index
  const order = rules
    .map((rule, index) => ({ index, size: baseFootprint(rule) * maxScale(rule) }))
    .sort((a, b) => b.size - a.size || a.index - b.index)
    .map((o) => o.index);
  let reachMax = 0;
  // formations widen the solved margin (their members reach further than one footprint), NOT the spacing
  // test's search radius below, which every candidate of every rule pays for
  let formationMax = 0;
  for (const rule of rules) {
    reachMax = Math.max(reachMax, baseFootprint(rule) * maxScale(rule) + rule.spacing);
    formationMax = Math.max(formationMax, formationReach(rule, maxScale(rule)));
  }
  const margin = Math.min(10, Math.max(reachMax * 2, formationMax));

  // region vegetation and clearings (vegetation.ts): one flag test per
  // candidate when the recipe has neither, so such a world is untouched
  const veg = vegetationIndex(recipe);

  // CELL-LEVEL gates for the rules that only fire on rare ground, so ordinary cells never pay per candidate:
  // a coarse slope survey for cliff rules (does anything here reach their slopeMin?) and the water index for
  // water rules. Both are pure functions of the cell rectangle, so every host agrees.
  // the relief survey: the largest height step between neighbours of a 6x6 grid over the cell and its margin
  let relief: number | undefined;
  const SURVEY = 5;
  const survey: number[] = [];
  const cellRelief = (): number => {
    if (relief !== undefined) return relief;
    const n = SURVEY;
    const h = survey;
    for (let j = 0; j <= n; j++) for (let i = 0; i <= n; i++) h.push(field.height(x0 - margin + ((x1 - x0 + 2 * margin) * i) / n, z0 - margin + ((z1 - z0 + 2 * margin) * j) / n));
    relief = 0;
    for (let j = 0; j <= n; j++) for (let i = 0; i <= n; i++) {
      const v = h[j * (n + 1) + i]!;
      if (i < n) relief = Math.max(relief, Math.abs(v - h[j * (n + 1) + i + 1]!));
      if (j < n) relief = Math.max(relief, Math.abs(v - h[(j + 1) * (n + 1) + i]!));
    }
    return relief;
  };
  // the CLIFF candidates' early-out, free: the relief survey above (already read for the cell gate) around the
  // candidate's survey square. Where none of those survey steps reaches `minDrop * 0.3` there is no cliff of that
  // drop through the candidate: no slope, no march. Cliff candidates are OWNED only, so the one cell that solves
  // one always uses the same survey.
  const localRelief = (x: number, z: number): number => {
    const n = SURVEY;
    const fx = ((x - (x0 - margin)) / (x1 - x0 + 2 * margin)) * n, fz = ((z - (z0 - margin)) / (z1 - z0 + 2 * margin)) * n;
    const si = Math.min(n - 1, Math.max(0, Math.floor(fx))), sj = Math.min(n - 1, Math.max(0, Math.floor(fz)));
    let best = 0;
    for (let j = Math.max(0, sj - 1); j <= Math.min(n, sj + 2); j++) {
      for (let i = Math.max(0, si - 1); i <= Math.min(n, si + 2); i++) {
        const v = survey[j * (n + 1) + i]!;
        if (i < n && i <= si + 1) best = Math.max(best, Math.abs(v - survey[j * (n + 1) + i + 1]!));
        if (j < n && j <= sj + 1) best = Math.max(best, Math.abs(v - survey[(j + 1) * (n + 1) + i]!));
      }
    }
    return best;
  };
  // shore rules' reach probes, memoised on a 2 m world lattice for this cell (formations.ts lakeProbeMemo)
  let probeMemo: LakeProbe | undefined;
  // (the sea part of a probe reads the ground: only where the coast is within reach of this cell)
  const shoreProbe = (): LakeProbe => (probeMemo ??= lakeProbeMemo(field, coastal()));
  let coast: boolean | undefined;
  // is the sea within reach of this cell? (a world without bounds cannot say: assume it may be)
  const coastal = (): boolean => {
    if (coast === undefined) {
      const d = field.shoreDistance((x0 + x1) / 2, (z0 + z1) / 2);
      coast = !Number.isFinite(d) || Math.abs(d) < cellSize + margin + 16;
    }
    return coast;
  };
  // shore + snap rules: the waterline grid, one per grid step, over the cell, its margin and the farthest snap reach
  // (formations.ts buildShoreGrid): every snapped candidate and its headland ring read it instead of probing
  const shoreGrids = new Map<number, ShoreGrid>();
  let snapPad = 0;
  for (const rule of rules) if (rule.water?.mode === "shore" && rule.water.snap) snapPad = Math.max(snapPad, rule.water.reach * 2 + rule.water.snapStep);
  const shoreGrid = (step: number): ShoreGrid => {
    let grid = shoreGrids.get(step);
    if (!grid) {
      const pad = margin + snapPad;
      grid = buildShoreGrid(field, x0 - pad, z0 - pad, x1 + pad, z1 + pad, step, coastal());
      shoreGrids.set(step, grid);
    }
    return grid;
  };
  let wet: boolean | undefined;
  const cellWet = (): boolean => (wet ??= field.waterNear(x0 - margin - 8, z0 - margin - 8, x1 + margin + 8, z1 + margin + 8));
  const vegOn = !veg.empty;

  const out: VoxelScatterInstance[] = [];
  /** Occupancy for the spacing test, bucketed at 4m. */
  const occupied = new Map<number, { x: number; z: number; r: number; gap: number }[]>();
  const OCC = 4;
  const occKey = (bx: number, bz: number): number => ((bx & 0xffff) << 16) | (bz & 0xffff);
  const blocked = (x: number, z: number, radius: number, gap: number): boolean => {
    const reach = radius + reachMax + gap;
    const bx0 = Math.floor((x - reach) / OCC);
    const bz0 = Math.floor((z - reach) / OCC);
    const bx1 = Math.floor((x + reach) / OCC);
    const bz1 = Math.floor((z + reach) / OCC);
    for (let bz = bz0; bz <= bz1; bz++) {
      for (let bx = bx0; bx <= bx1; bx++) {
        const list = occupied.get(occKey(bx, bz));
        if (!list) continue;
        for (const item of list) {
          const minDist = radius + item.r + Math.max(gap, item.gap);
          const dx = item.x - x;
          const dz = item.z - z;
          if (dx * dx + dz * dz < minDist * minDist) return true;
        }
      }
    }
    return false;
  };
  const occupy = (x: number, z: number, r: number, gap: number): void => {
    const key = occKey(Math.floor(x / OCC), Math.floor(z / OCC));
    const list = occupied.get(key);
    if (list) list.push({ x, z, r, gap });
    else occupied.set(key, [{ x, z, r, gap }]);
  };

  /*PROF*/ const __prof = (globalThis as any).__scatterProf as Map<string, number> | undefined; let __t = __prof ? performance.now() : 0; let __last = -1;
  for (const ruleIndex of order) {
    /*PROF*/ if (__prof) { const now = performance.now(); if (__last >= 0) __prof.set(rules[__last]!.id, (__prof.get(rules[__last]!.id) ?? 0) + now - __t); __t = now; __last = ruleIndex; }
    const rule: ScatterDoc = rules[ruleIndex]!;
    if (rule.density <= 0) continue;
    if (!rule.prefab && !rule.model) continue;
    const spacing = 1 / Math.sqrt(rule.density);
    if (!Number.isFinite(spacing) || spacing <= 0) continue;
    // a density so high the lattice would exceed the per-cell cap is a typo,
    // not an intent — clamp the lattice instead of hanging the chunk load
    // a cliff column multiplies what one lattice point can emit, so the runaway
    // guard has to know about it or a dense cliff rule walks straight past it
    const perPoint = rule.cliff ? Math.max(rule.cliff.stack[0], rule.cliff.stack[1]) : 1;
    const latticePerCell = (cellSize / spacing) ** 2 * perPoint;
    if (latticePerCell > maxInstances) continue;

    const ruleSeed = (recipe.seed + ruleIndex * 7919) | 0;
    // cliff rules need a cliff in the cell (a drop of half their minDrop between survey points), water rules water
    if (rule.cliff && cellRelief() < rule.cliff.minDrop * 0.5) continue;
    if (rule.water && rule.water.mode !== "shore" && !cellWet()) continue;
    // plunge-pool-only rules: a fall must be within reach of this cell
    if (rule.water?.fall.only) {
      const r = rule.water.fall.radius + margin;
      if (!field.falls.some((f) => f.x > x0 - r && f.x < x1 + r && f.z > z0 - r && f.z < z1 + r)) continue;
    }
    // shore: inland water near, or the sea coast within reach of the cell
    if (rule.water?.mode === "shore" && !cellWet() && Math.abs(field.shoreDistance((x0 + x1) / 2, (z0 + z1) / 2)) > cellSize + margin) continue;
    // fBm spec for the clump mask, built once per rule rather than per candidate
    const clump = rule.clump;
    const clumpSpec: FbmSpec | null = clump
      ? {
          frequency: clump.frequency,
          amplitude: 1,
          octaves: clump.octaves,
          lacunarity: 2,
          gain: 0.5,
          ridged: false,
          seed: clump.seed,
        }
      : null;
    const clumpBlend = clump ? Math.max(1e-4, clump.blend) : 0;
    // absent/empty means every allowed biome runs at full density; the lookup
    // is skipped entirely in that case, which is the common one
    const biomeDensity = rule.biomeDensity as Record<string, number | undefined>;
    const graded = Object.keys(biomeDensity).length > 0;
    // a clearing keeps a prop's whole canopy off it, not just its trunk
    const clearPad = baseFootprint(rule) * maxScale(rule);
    // the margin ring is solved for occupancy and discarded; a prop is OWNED
    // by the cell holding its unjittered lattice point
    const gx0 = Math.ceil((x0 - margin) / spacing);
    const gx1 = Math.floor((x1 + margin - 1e-6) / spacing);
    const gz0 = Math.ceil((z0 - margin) / spacing);
    const gz1 = Math.floor((z1 + margin - 1e-6) / spacing);
    const ownedX0 = Math.ceil(x0 / spacing);
    const ownedX1 = Math.floor((x1 - 1e-6) / spacing);
    const ownedZ0 = Math.ceil(z0 / spacing);
    const ownedZ1 = Math.floor((z1 - 1e-6) / spacing);

    for (let gz = gz0; gz <= gz1; gz++) {
      for (let gx = gx0; gx <= gx1; gx++) {
        if (out.length >= maxInstances) return out;
        const owned = gx >= ownedX0 && gx <= ownedX1 && gz >= ownedZ0 && gz <= ownedZ1;

        const r1 = hashUnit(gx, gz, 1, ruleSeed);
        const r2 = hashUnit(gx, gz, 2, ruleSeed);
        const r3 = hashUnit(gx, gz, 3, ruleSeed);
        const r4 = hashUnit(gx, gz, 4, ruleSeed);
        const r5 = hashUnit(gx, gz, 5, ruleSeed);

        const jitter = rule.jitter * spacing * 0.5;
        // (let: a shore + snap candidate moves onto the waterline below)
        let wx = gx * spacing + (r1 - 0.5) * 2 * jitter;
        let wz = gz * spacing + (r2 - 0.5) * 2 * jitter;
        if (limit !== Infinity && wx * wx + wz * wz > limit * limit) continue;

        // REGION VEGETATION + CLEARINGS, before anything that reads the
        // height field: a bucket lookup and a raster read each, pure functions
        // of position and the lattice hash, so every cell (and the server's
        // collider worker) agrees. k > 1 fills back clump/biome thinning below.
        let k = 1;
        let emitIndex = ruleIndex;
        let plan: VegetationPlan | null = null;
        if (vegOn) {
          const clear = veg.clearingKeep(wx, wz, 0, clearPad);
          if (clear <= 0 || (clear < 1 && hashUnit(gx, gz, 13, ruleSeed) >= clear)) continue;
          plan = veg.planAt(wx, wz);
          if (plan) {
            k = plan.ruleKeep[ruleIndex]!;
            if (k <= 0 || (k < 1 && hashUnit(gx, gz, 12, ruleSeed) >= k)) continue;
            if (!rule.cliff) emitIndex = plan.replace[ruleIndex]!;
          }
        }
        // the rule this candidate is EMITTED as (a region's species swap):
        // the source rule's gates decide whether it grows, the emitted rule
        // decides what stands there
        const emit: ScatterDoc = emitIndex === ruleIndex ? rule : rules[emitIndex]!;

        // CLUMPING FIRST, before `slope` — which is four height evaluations
        // and by far the most expensive thing a candidate can be asked. A
        // clumped rule authors a HIGHER peak density (the lattice is what the
        // mask thins), so testing the mask after the slope query would make
        // every rejected candidate cost more than the prop it did not place:
        // measured 10.6 -> 19.9 ms per cell that way round, and back to 11.4
        // this way. One fBm lookup and one lattice hash, both pure functions
        // of world position, so two cells solving the same margin candidate
        // still always agree.
        if (clumpSpec && clump) {
          const mask = smoothstep(clump.threshold, clump.threshold + clumpBlend, fbm2(clumpSpec, wx, wz, recipe.seed));
          let keep = clump.floor + (1 - clump.floor) * mask;
          if (k > 1) keep = Math.min(1, keep * k);
          if (keep < 1 && hashUnit(gx, gz, 6, ruleSeed) >= keep) continue;
        }

        // shore rules: no lake/sea within reach, no candidate (before the slope and the surface cast)
        let shorePt: ShorePoint | null = null;
        if (rule.water?.mode === "shore") {
          const w = rule.water;
          if (w.snap) {
            // onto the nearest waterline of the cell grid, standing `wade` of a footprint across it
            shorePt = nearestShore(shoreGrid(w.snapStep), wx, wz, w.reach, w.waters === "both" ? 3 : w.waters === "river" ? 2 : 1, w.reach);
            if (!shorePt) continue;
            refineShore(field, shorePt, w.snapStep);
            const across = (w.wade[0] + (w.wade[1] - w.wade[0]) * hashUnit(gx, gz, 17, ruleSeed)) * baseFootprint(rule) * (rule.scale[0] + rule.scale[1]) * 0.5;
            wx = shorePt.x + shorePt.inX * across;
            wz = shorePt.z + shorePt.inZ * across;
            if (vegOn && veg.clearingKeep(wx, wz, 0, clearPad) <= 0) continue;
          } else if (shoreLevel(field, wx, wz, w.reach, shoreProbe()) === null) continue;
        }
        // in/river/marsh rules: no water here, no candidate (before the four-height slope)
        // (the cheapest read that can say no: a river's own surface for river rules, the lake index for lake rules away
        // from the coast; waterY reads the ground for the sea test and was most of a water rule's cost)
        if (rule.water && rule.water.mode !== "shore") {
          const mode = rule.water.mode;
          let level: number | null;
          if (mode === "marsh") level = field.marshTable(wx, wz);
          else if (mode === "river") {
            if (!field.waterSurface(wx, wz, riverScratch) || (riverScratch.kind !== "river" && !rule.water.fall.only)) continue;
            level = field.waterY(wx, wz);
          } else level = coastal() ? field.waterY(wx, wz) : field.lakeY(wx, wz);
          if (level === null) continue;
          // dry, or deeper than any rock of this rule can break the surface from: one height read, before the slope's
          // four and the surface cast (the fit in waterPlacement still decides, on the cast ground)
          const depth = level - field.height(wx, wz);
          if (depth < -0.5 || depth > Math.max(rule.water.maxDepth, rule.water.fall.maxDepth) + 0.5) continue;
        }
        // cliff stacks sit outside the spacing map: a margin candidate of a cliff rule claims nothing, so it is
        // dropped BEFORE its slope (half the lattice of a cliff rule is margin)
        if (rule.cliff && !owned) continue;
        if (rule.cliff && localRelief(wx, wz) < rule.cliff.minDrop * 0.3) continue;
        // planar cliffs (terrain.planarCliffs) rebuild steep ground as treads and walls: there the heightfield is
        // neither the ground (a prop on it floats a riser high or is buried in the wall) nor its slope (a tread is
        // flat where the heightfield under it is steep), so both come from the real surface. Elsewhere: unchanged.
        const planarGround = !rule.cliff && field.planarNear(wx, wz) ? field.ground(wx, wz) : undefined;
        const steep = planarGround !== undefined ? field.surfaceSlope(wx, planarGround, wz) : field.slope(wx, wz);
        if (steep > rule.slopeMax || steep < rule.slopeMin) continue;

        if (rule.cliff) {
          if (rule.clearance > 0 && field.featureClearance(wx, wz) < rule.clearance) continue;
          const first = out.length;
          emitCliffColumn(field, rule, ruleIndex, gx, gz, ruleSeed, wx, wz, x0, z0, out);
          // a cliff piece moves off its lattice point (up to the crest, down to the foot, along the lip): the
          // clearings test it again where it actually stands (a bridge landing's clearing keeps crest rocks off it)
          if (vegOn && out.length > first) {
            let w = first;
            for (let r = first; r < out.length; r++) {
              const inst = out[r]!;
              const keep = veg.clearingKeep(inst.position[0] + x0, inst.position[2] + z0, 0, clearPad);
              if (keep <= 0 || (keep < 1 && hashUnit(gx, gz, 14 + r - first, ruleSeed) >= keep)) continue;
              out[w++] = inst;
            }
            out.length = w;
          }
          if (out.length >= maxInstances) return out;
          continue;
        }

        // where a passage, tunnel or subtracting blob reaches this footing the
        // heightfield is not the ground: stand on the carved surface, or drop
        // the plant if its footing was cut away. Everywhere else (a map miss)
        // the original answer stands, bit for bit. The radius is the largest
        // this rule can be: the scale is not drawn until after the gates.
        // The footing ring is tested later, just before spacing, so a candidate
        // the cheap gates reject never pays for eight casts.
        const carve = options.fastGround ? null : carveNear(field, wx, wz, scatterFooting(emit, maxScale(emit)));
        const carved = carve ? castThrough(field, wx, wz, carve) : undefined;
        if (carved === null) continue;
        const groundY =
          carved !== undefined
            ? carved
            : planarGround !== undefined
              ? planarGround
              : options.fastGround || !overhangs
              ? field.height(wx, wz)
              : (field.surfaceCast(wx, wz) ?? field.height(wx, wz));

        if (rule.height && (groundY < rule.height[0] || groundY > rule.height[1])) continue;
        if (rule.clearance > 0 && field.featureClearance(wx, wz) < rule.clearance) continue;
        // nothing grows under water, whatever height the water happens to be
        // at — nor right AT the waterline, where a bush with its base a hand's
        // breadth under the surface reads as brush standing in the lake
        // (a rule with `water` is placed IN or AT water instead: formations.ts waterPlacement, below)
        if (!emit.water) {
          const water = field.waterY(wx, wz);
          if (water !== null && groundY < water + 0.35) continue;
        }
        if (seaBare && seaBare.apron(wx, wz)) continue;

        const sample = field.biome(wx, wz, groundY, steep);
        if (rule.biomes.length > 0 && !rule.biomes.includes(sample.id)) continue;
        // per-biome thinning: one rule that is a forest in the forest and a
        // copse in the meadow, rather than two rules kept in step by hand
        if (graded) {
          let weight = biomeDensity[sample.id];
          if (weight !== undefined && k > 1) weight = Math.min(1, weight * k);
          if (weight !== undefined && weight < 1 && hashUnit(gx, gz, 7, ruleSeed) >= weight) continue;
        }

        let scale = (emit.scale[0] + (emit.scale[1] - emit.scale[0]) * r3)
          * scaleMultiplier(emit, emit.scaleVariants ? hashUnit(gx, gz, 9, ruleSeed) : 0);
        if (emit.water) {
          const fitted = waterPlacement(field, emit, wx, wz, groundY, scale, hashUnit(gx, gz, 16, ruleSeed), shoreProbe(), shorePt);
          if (fitted === null) continue;
          scale = fitted;
        }
        const radius = baseFootprint(emit) * scale;
        if (blocked(wx, wz, radius, emit.spacing)) continue;
        // after `blocked` (a candidate that loses on spacing never pays for the
        // ring) and before `occupy` (a dropped plant claims no ground)
        if (carve && !footingHolds(field, wx, wz, groundY, scatterFooting(emit, scale), carve)) continue;
        if (planarGround !== undefined && carved === undefined && !planarFootingHolds(field, wx, planarGround, wz)) continue;
        // a FORMATION (owner only): its members are placed BEFORE the anchor claims its ground, or every member
        // tucked against the anchor would be refused by the anchor itself; other rules' props still refuse them
        if (emit.formation && owned) {
          const members = formationMembers(field, emit, emit.formation, wx, wz, groundY, scale, r4 * Math.PI * 2, gx, gz, ruleSeed, (mx, mz, ms) => {
            const g = field.ground(mx, mz);
            if (field.planarNear(mx, mz) && !planarFootingHolds(field, mx, g, mz)) return null;
            if (emit.water) {
              // a snapped shore formation's members stand on the anchor's waterline (no probes): wading, never drowned
              if (shorePt) {
                if (shorePt.level - g > 0.6 || g > shorePt.level + 0.9) return null;
              } else if (waterPlacement(field, emit, mx, mz, g, ms, 0, shoreProbe()) === null) return null;
            } else {
              const wy = field.waterY(mx, mz);
              if (wy !== null && g < wy + 0.35) return null;
            }
            const mr = baseFootprint(emit) * ms;
            // members overlap each other by design, but not another rule's props
            if (blocked(mx, mz, mr * 0.5, 0)) return null;
            return g;
          }, emit.water?.mode === "river" ? [riverScratch.flowX, riverScratch.flowZ] : null);
          occupy(wx, wz, radius, emit.spacing);
          for (const m of members) if (!m.anchor) occupy(m.x, m.z, baseFootprint(emit) * m.scale * 0.5, 0);
          const cap = withRockCap(field, emit, wx, groundY, wz);
          const list = emit.formation.memberVariants;
          const seats = seatProbe && scatterContact(emit) === "embed";
          members.forEach((m, i) => {
            const own = !m.anchor && list ? list[m.pick] : undefined;
            const memberSize = own ? own.colliderSize : emit.modelVariants && m.pick >= 0 ? emit.modelVariants[m.pick]?.colliderSize : undefined;
            const my = seats ? seatRock(seatProbe!, emit, m.x, m.z, m.ground + emit.yOffset * m.scale, quatYawOf(m.rotation), m.scale, own?.colliderSize) : m.ground + emit.yOffset * m.scale;
            if (my === null) return;
            out.push({
              rule: emit.id,
              ruleIndex: emitIndex,
              id: m.anchor ? `${rule.id}_${gx}_${gz}` : `${rule.id}_${gx}_${gz}_f${i}`,
              position: [m.x - x0, my, m.z - z0],
              rotation: m.rotation,
              scale: m.scale,
              biome: sample.id,
              ...(own ? { model: own.model, ...(own.colliderSize ? { colliderSize: own.colliderSize } : {}) } : emit.modelVariants && m.pick >= 0 ? { variant: m.pick } : {}),
              ...(m.filler ? { filler: true } : {}),
              ...(emit.water ? withWet(field, emit, cap, m.x, m.z, my, m.scale, memberSize) : cap),
            });
          });
          continue;
        }
        occupy(wx, wz, radius, emit.spacing);
        if (!owned) continue;

        let rotation = quatYaw(r4 * Math.PI * 2);
        if (emit.alignToNormal > 0) {
          const tilt = quatScaled(quatFromTo(UP, groundNormal(field, wx, wz)), emit.alignToNormal);
          rotation = quatMultiply(tilt, rotation);
        }
        // a region's wind-bent stand: the tops lean together (vegetation.ts)
        const lean = plan?.lean;
        if (lean && lean.rules[emitIndex]) {
          const angle = lean.radians + (hashUnit(gx, gz, 14, ruleSeed) - 0.5) * 2 * lean.jitter;
          rotation = quatMultiply(quatTilt(lean.axisAngle, angle), rotation);
        }

        let baseY = groundY + emit.yOffset * scale;
        if (seatProbe && scatterContact(emit) === "embed") {
          // the rule's collider, not a variant's: adding variants or caps never moves a rock (rock-cap.test)
          const seated = seatRock(seatProbe, emit, wx, wz, baseY, r4 * Math.PI * 2, scale);
          if (seated === null) continue;
          baseY = seated;
        }
        out.push({
          rule: emit.id,
          ruleIndex: emitIndex,
          // the SOURCE rule's id keeps it unique against the target rule's own lattice
          id: `${rule.id}_${gx}_${gz}`,
          position: [wx - x0, baseY, wz - z0],
          rotation,
          scale,
          biome: sample.id,
          ...(emit.colorVariants ? { vegetationTint: colorVariant(emit, hashUnit(gx, gz, 10, ruleSeed)) } : {}),
          ...(emit.modelVariants ? { variant: modelVariantIndex(emit, hashUnit(gx, gz, 15, ruleSeed)) } : {}),
          ...(emit.water ? withWet(field, emit, withRockCap(field, emit, wx, groundY, wz), wx, wz, baseY, scale, emit.modelVariants ? emit.modelVariants[modelVariantIndex(emit, hashUnit(gx, gz, 15, ruleSeed)) ?? 0]?.colliderSize : undefined) : withRockCap(field, emit, wx, groundY, wz)),
        });
        // r5 is reserved for per-instance variation the prefab may read later
        void r5;
      }
    }
  }
  /*PROF*/ if (__prof && __last >= 0) __prof.set(rules[__last]!.id, (__prof.get(rules[__last]!.id) ?? 0) + performance.now() - __t);
  return out;
}

/** Deterministic per-instance unit value, for a prop's own variation (tilt, tint, variant). */
export function scatterVariation(instanceId: string, channel: number, seed: number): number {
  let h = seed | 0;
  for (let i = 0; i < instanceId.length; i++) h = (Math.imul(h, 31) + instanceId.charCodeAt(i)) | 0;
  return clamp(hashUnit(h, channel, 0, seed), 0, 1);
}

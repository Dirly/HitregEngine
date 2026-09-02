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
import { hashUnit, clamp } from "./noise.js";
import type { WorldField } from "./field.js";
import type { ScatterDoc } from "./recipe.js";

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
}

export interface ScatterCellOptions {
  /** Skip the (expensive) overhang-aware surface raymarch; use the heightfield. */
  fastGround?: boolean;
  /** Hard cap per cell, as a runaway guard against a mis-typed density. */
  maxInstances?: number;
}

const UP: Vec3 = [0, 1, 0];

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
    if (field.height(x + dx * t, z + dz * t) <= y) {
      let lo = prev;
      let hi = t;
      for (let i = 0; i < 6; i++) {
        const mid = (lo + hi) / 2;
        if (field.height(x + dx * mid, z + dz * mid) <= y) hi = mid;
        else lo = mid;
      }
      return { x: x + dx * hi, z: z + dz * hi };
    }
    prev = t;
  }
  return null;
}

/** Surface normal from the heightfield derivative — good enough for prop tilt. */
function groundNormal(field: WorldField, x: number, z: number): Vec3 {
  const e = Math.max(field.voxelSize, 0.5);
  const dx = (field.height(x + e, z) - field.height(x - e, z)) / (2 * e);
  const dz = (field.height(x, z + e) - field.height(x, z - e)) / (2 * e);
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
  const topY = field.height(wx, wz);

  // downhill is the horizontal part of the surface normal — the direction the
  // face presents to the world, and the direction a prop's front should look
  const rim = groundNormal(field, wx, wz);
  const flat = Math.hypot(rim[0], rim[2]);
  if (flat < 1e-4) return; // dead level: no face to hang anything on
  const dx = rim[0] / flat;
  const dz = rim[2] / flat;

  // does this face actually fall far enough to be worth dressing?
  if (topY - field.height(wx + dx * cliff.search, wz + dz * cliff.search) < cliff.minDrop) return;

  const [stackLo, stackHi] = cliff.stack;
  const pick = hashUnit(gx, gz, 11, ruleSeed);
  const count = Math.min(stackLo, stackHi) + Math.floor(pick * (Math.abs(stackHi - stackLo) + 1));

  let y = topY;
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
    const face = faceAtHeight(field, wx, wz, dx, dz, y, cliff.search);
    if (!face) return; // the face ran out below us — the cliff has bottomed out

    // the face turns as it descends; take its own normal, not the rim's
    const normal = groundNormal(field, face.x, face.z);
    const nFlat = Math.hypot(normal[0], normal[2]);
    const ox = nFlat > 1e-4 ? normal[0] / nFlat : dx;
    const oz = nFlat > 1e-4 ? normal[2] / nFlat : dz;

    const scale = rule.scale[0] + (rule.scale[1] - rule.scale[0]) * h4;
    // embed is a depth INTO THE MODEL, so it scales with the instance the way
    // yOffset does: resizing a rock must not leave it hanging off the face
    const embed = (cliff.embed + (h2 - 0.5) * 2 * cliff.embedJitter) * scale;
    const slide = (h3 - 0.5) * 2 * cliff.lateral;
    const px = face.x - ox * embed - oz * slide;
    const pz = face.z - oz * embed + ox * slide;

    const faceSteep = field.slope(px, pz);
    if (rule.height && (y < rule.height[0] || y > rule.height[1])) continue;
    const sample = field.biome(px, pz, y, faceSteep);
    if (rule.biomes.length > 0 && !rule.biomes.includes(sample.id)) continue;

    // +Z out of the face, softened by faceOut and wobbled by yawSpread; a model
    // whose front is not +Z is corrected once, on the rule, with yawOffset
    const outYaw = Math.atan2(ox, oz);
    const free = (h5 - 0.5) * 2 * Math.PI;
    const yaw = outYaw + free * (1 - cliff.faceOut) + (h6 - 0.5) * 2 * cliff.yawSpread + rule.yawOffset;
    let rotation = quatYaw(yaw);
    if (cliff.tilt > 0) {
      rotation = quatMultiply(quatTilt(h7 * Math.PI * 2, (h4 - 0.5) * 2 * cliff.tilt), rotation);
    }
    // tip back into the face: about the horizontal axis perpendicular to the
    // outward direction, which carries the prop's up axis toward -outward
    const lean = cliff.lean + (h5 - 0.5) * 2 * cliff.leanJitter;
    if (lean !== 0) rotation = quatMultiply(quatTilt(Math.atan2(ox, -oz), lean), rotation);
    if (rule.alignToNormal > 0) {
      rotation = quatMultiply(quatScaled(quatFromTo(UP, normal), rule.alignToNormal), rotation);
    }

    out.push({
      rule: rule.id,
      ruleIndex,
      id: `${rule.id}_${gx}_${gz}_${k}`,
      position: [px - x0, y + rule.yOffset * scale, pz - z0],
      rotation,
      scale,
      biome: sample.id,
    });
  }
}

/**
 * Every scattered instance belonging to cell (cx, cz).
 *
 * Rules are evaluated in array order and later rules yield to earlier ones
 * within `clearance`, so the array order is a priority: put the big trees
 * first and the undergrowth after, or the undergrowth wins the good spots.
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

  const out: VoxelScatterInstance[] = [];
  /** Occupancy for the inter-rule spacing test, bucketed at 4m. */
  const occupied = new Map<number, { x: number; z: number; r: number }[]>();
  const OCC = 4;
  const occKey = (bx: number, bz: number): number => ((bx & 0xffff) << 16) | (bz & 0xffff);
  const blocked = (x: number, z: number, radius: number): boolean => {
    if (radius <= 0) return false;
    const bx0 = Math.floor((x - radius) / OCC);
    const bz0 = Math.floor((z - radius) / OCC);
    const bx1 = Math.floor((x + radius) / OCC);
    const bz1 = Math.floor((z + radius) / OCC);
    for (let bz = bz0; bz <= bz1; bz++) {
      for (let bx = bx0; bx <= bx1; bx++) {
        const list = occupied.get(occKey(bx, bz));
        if (!list) continue;
        for (const item of list) {
          const reach = Math.max(radius, item.r);
          if (Math.hypot(item.x - x, item.z - z) < reach) return true;
        }
      }
    }
    return false;
  };
  const occupy = (x: number, z: number, r: number): void => {
    const key = occKey(Math.floor(x / OCC), Math.floor(z / OCC));
    const list = occupied.get(key);
    if (list) list.push({ x, z, r });
    else occupied.set(key, [{ x, z, r }]);
  };

  for (let ruleIndex = 0; ruleIndex < rules.length; ruleIndex++) {
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
    const gx0 = Math.ceil(x0 / spacing);
    const gx1 = Math.floor((x1 - 1e-6) / spacing);
    const gz0 = Math.ceil(z0 / spacing);
    const gz1 = Math.floor((z1 - 1e-6) / spacing);

    for (let gz = gz0; gz <= gz1; gz++) {
      for (let gx = gx0; gx <= gx1; gx++) {
        if (out.length >= maxInstances) return out;

        const r1 = hashUnit(gx, gz, 1, ruleSeed);
        const r2 = hashUnit(gx, gz, 2, ruleSeed);
        const r3 = hashUnit(gx, gz, 3, ruleSeed);
        const r4 = hashUnit(gx, gz, 4, ruleSeed);
        const r5 = hashUnit(gx, gz, 5, ruleSeed);

        const jitter = rule.jitter * spacing * 0.5;
        const wx = gx * spacing + (r1 - 0.5) * 2 * jitter;
        const wz = gz * spacing + (r2 - 0.5) * 2 * jitter;

        const steep = field.slope(wx, wz);
        if (steep > rule.slopeMax || steep < rule.slopeMin) continue;

        if (rule.cliff) {
          if (rule.clearance > 0 && field.featureClearance(wx, wz) < rule.clearance) continue;
          emitCliffColumn(field, rule, ruleIndex, gx, gz, ruleSeed, wx, wz, x0, z0, out);
          if (out.length >= maxInstances) return out;
          continue;
        }

        const groundY =
          options.fastGround || !overhangs
            ? field.height(wx, wz)
            : (field.surfaceCast(wx, wz) ?? field.height(wx, wz));

        if (rule.height && (groundY < rule.height[0] || groundY > rule.height[1])) continue;
        if (rule.clearance > 0 && field.featureClearance(wx, wz) < rule.clearance) continue;

        const sample = field.biome(wx, wz, groundY, steep);
        if (rule.biomes.length > 0 && !rule.biomes.includes(sample.id)) continue;

        const scale = rule.scale[0] + (rule.scale[1] - rule.scale[0]) * r3;
        const footprint = Math.max(rule.clearance, rule.colliderSize[0] * scale * 0.5);
        if (blocked(wx, wz, footprint)) continue;
        occupy(wx, wz, footprint);

        let rotation = quatYaw(r4 * Math.PI * 2);
        if (rule.alignToNormal > 0) {
          const tilt = quatScaled(quatFromTo(UP, groundNormal(field, wx, wz)), rule.alignToNormal);
          rotation = quatMultiply(tilt, rotation);
        }

        out.push({
          rule: rule.id,
          ruleIndex,
          id: `${rule.id}_${gx}_${gz}`,
          position: [wx - x0, groundY + rule.yOffset * scale, wz - z0],
          rotation,
          scale,
          biome: sample.id,
        });
        // r5 is reserved for per-instance variation the prefab may read later
        void r5;
      }
    }
  }
  return out;
}

/** Deterministic per-instance unit value, for a prop's own variation (tilt, tint, variant). */
export function scatterVariation(instanceId: string, channel: number, seed: number): number {
  let h = seed | 0;
  for (let i = 0; i < instanceId.length; i++) h = (Math.imul(h, 31) + instanceId.charCodeAt(i)) | 0;
  return clamp(hashUnit(h, channel, 0, seed), 0, 1);
}
